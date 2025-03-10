import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import LRU from "lru-cache"

import { SingleCompletionHandler } from "../"
import { ApiStream } from "../transform/stream"
import { convertToVsCodeLmMessages } from "../transform/vscode-lm-format"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { BaseProvider } from "./base-provider"

/**
 * Handles interaction with VS Code's Language Model API for chat-based operations.
 * This handler extends BaseProvider to provide VS Code LM specific functionality.
 *
 * @extends {BaseProvider}
 *
 * @remarks
 * The handler manages a VS Code language model chat client and provides methods to:
 * - Create and manage chat client instances
 * - Stream messages using VS Code's Language Model API
 * - Retrieve model information
 */
export class VsCodeLmHandler extends BaseProvider implements SingleCompletionHandler {
	private static readonly MAX_RETRIES = 3
	private static readonly RETRY_DELAY = 1000 // ms
	private static readonly MAX_CONSECUTIVE_PROMPTS = 5
	private static readonly PROMPT_TIMEOUT = 60000 // 60 seconds
	private requestCount: number = 0
	private lastResetTime: number = Date.now()
	private lastPrompts: Array<{ prompt: string; timestamp: number }> = []
	private modelCache: LRU<string, vscode.LanguageModelChat>
	private tokenCache: LRU<string, number>
	private static outputChannel: vscode.OutputChannel | undefined = undefined
	protected options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposable: vscode.Disposable | null
	private currentRequestCancellation: vscode.CancellationTokenSource | null
	private clientInitPromise: Promise<vscode.LanguageModelChat> | null = null

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		this.modelCache = new LRU<string, vscode.LanguageModelChat>({
			max: 10,
			ttl: 1000 * 60 * 5, // 5 minutes
		})

		this.tokenCache = new LRU<string, number>({
			max: 1000,
			ttl: 1000 * 60 * 60, // 1 hour
		})

		try {
			this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("lm")) {
					try {
						this.client = null
						this.ensureCleanState()
					} catch (error) {
						console.error("Error during configuration change cleanup:", error)
					}
				}
			})
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()
			throw new Error(
				`Roo Code <Language Model API>: Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	private async checkRateLimit(): Promise<void> {
		const config = vscode.workspace.getConfiguration("roo-cline.vsCodeLm.rateLimit")
		const requestLimit = config.get<number>("requestLimit") ?? 50
		const delaySeconds = config.get<number>("delaySeconds") ?? 71

		// Reset counter if it's been more than the delay period
		const now = Date.now()
		if (now - this.lastResetTime > delaySeconds * 1000) {
			this.requestCount = 0
			this.lastResetTime = now
		}

		// If we've hit the limit, enforce the delay
		if (this.requestCount >= requestLimit) {
			await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))
			this.requestCount = 0
			this.lastResetTime = Date.now()
		}

		this.requestCount++
	}

	private isPromptLoop(prompt: string): boolean {
		const now = Date.now()

		// Remove old prompts (older than PROMPT_TIMEOUT)
		this.lastPrompts = this.lastPrompts.filter((p) => now - p.timestamp < VsCodeLmHandler.PROMPT_TIMEOUT)

		// Check for repeated prompts
		const similarPrompts = this.lastPrompts.filter((p) => p.prompt === prompt).length

		// Add current prompt
		this.lastPrompts.push({ prompt, timestamp: now })

		return similarPrompts >= VsCodeLmHandler.MAX_CONSECUTIVE_PROMPTS
	}

	private cleanTerminalOutput(text: string): string {
		if (!text) return ""

		return text
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			.replace(/(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
			.replace(/[0-?]*[ -/]*[@-~]/g, "")
			.replace(/\][0-9;]*(?:|\\)/g, "")
			.replace(/[---]/g, "")
			.replace(/[PD].*?\\/g, "")
			.replace(/_.*?\\/g, "")
			.replace(/\^.*?\\/g, "")
			.replace(/\[[\d;]*[HfABCDEFGJKST]/g, "")
			.replace(/^(?:PS )?[A-Z]:\\[^\n]*$/gm, "")
			.replace(/^;?Cwd=.*$/gm, "")
			.replace(/\\x[0-9a-fA-F]{2}/g, "")
			.replace(/\\u[0-9a-fA-F]{4}/g, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	}

	private cleanMessageContent(content: any): any {
		if (!content) return content

		if (typeof content === "string") {
			return this.cleanTerminalOutput(content)
		}

		if (Array.isArray(content)) {
			return content.map((item) => this.cleanMessageContent(item))
		}

		if (typeof content === "object") {
			const cleaned: any = {}
			for (const [key, value] of Object.entries(content)) {
				cleaned[key] = this.cleanMessageContent(value)
			}
			return cleaned
		}

		return content
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		await this.checkRateLimit()

		const cacheKey = JSON.stringify(content)

		try {
			// Check cache first
			const cachedCount = this.tokenCache.get(cacheKey)
			if (cachedCount !== undefined) {
				return cachedCount
			}

			// Calculate tokens using convertContentToText
			const textContent = this.convertContentToText(content)
			const count = await this.internalCountTokens(textContent)

			// Cache the result
			this.tokenCache.set(cacheKey, count)
			return count
		} catch (error) {
			console.warn("Token counting error:", error)
			return 0
		}
	}

	private convertContentToText(content: Array<Anthropic.Messages.ContentBlockParam>): string {
		return content
			.map((block) => {
				if (block.type === "text") return block.text || ""
				if (block.type === "image") return "[IMAGE]"
				return ""
			})
			.join("")
	}

	private async internalCountTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		const client = await this.getClient()
		const token = this.ensureCancellationToken().token

		if (!client || !text) return 0

		try {
			if (typeof text === "string") {
				return await client.countTokens(text, token)
			}

			if (text instanceof vscode.LanguageModelChatMessage) {
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					return 0
				}
				return await client.countTokens(text, token)
			}

			return 0
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				console.debug("Roo Code <Language Model API>: Token counting cancelled by user")
				return 0
			}

			console.warn("Token counting error:", error)
			return 0
		}
	}

	private ensureCancellationToken(): vscode.CancellationTokenSource {
		if (!this.currentRequestCancellation || this.currentRequestCancellation.token.isCancellationRequested) {
			this.currentRequestCancellation?.dispose()
			this.currentRequestCancellation = new vscode.CancellationTokenSource()
		}
		return this.currentRequestCancellation
	}

	private async calculateTotalInputTokens(
		systemPrompt: string,
		vsCodeLmMessages: vscode.LanguageModelChatMessage[],
	): Promise<number> {
		const systemTokens: number = await this.internalCountTokens(systemPrompt)
		const messageTokens: number[] = await Promise.all(vsCodeLmMessages.map((msg) => this.internalCountTokens(msg)))
		return systemTokens + messageTokens.reduce((sum: number, tokens: number): number => sum + tokens, 0)
	}

	private ensureCleanState(): void {
		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
			this.currentRequestCancellation = null
		}
	}

	private async getClient(): Promise<vscode.LanguageModelChat> {
		if (this.clientInitPromise) {
			return this.clientInitPromise
		}

		this.clientInitPromise = (async () => {
			if (this.client) {
				return this.client
			}

			const selector = this.options.vsCodeLmModelSelector ?? {}

			try {
				this.client = await this.createClient(selector)
				return this.client
			} catch (error) {
				this.clientInitPromise = null
				throw error
			}
		})()

		return this.clientInitPromise
	}

	private resetClient(): void {
		this.client = null
		if (this.disposable) {
			this.disposable.dispose()
			this.disposable = null
		}

		// Reset model cache
		if (this.modelCache && typeof this.modelCache.clear === "function") {
			this.modelCache.clear()
		} else {
			// Reinitialize the cache if it's invalid
			this.modelCache = new LRU<string, vscode.LanguageModelChat>({
				max: 10,
				ttl: 1000 * 60 * 5, // 5 minutes
			})
		}

		// Reset token cache
		if (this.tokenCache && typeof this.tokenCache.clear === "function") {
			this.tokenCache.clear()
		} else {
			// Reinitialize the token cache if it's invalid
			this.tokenCache = new LRU<string, number>({
				max: 1000,
				ttl: 1000 * 60 * 60, // 1 hour
			})
		}

		this.clientInitPromise = null
		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.dispose()
			this.currentRequestCancellation = null
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		if (this.isPromptLoop(prompt)) {
			throw new Error("Detected potential prompt loop. Request blocked for safety.")
		}

		try {
			const client = await this.getClient()
			const response = await client.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{},
				new vscode.CancellationTokenSource().token,
			)
			let result = ""
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					result += chunk.value
				}
			}
			return result
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`VSCode LM completion error: ${error.message}`)
			}
			throw error
		}
	}

	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		try {
			const models = await vscode.lm.selectChatModels(selector)

			if (models && models.length > 0) {
				return models[0]
			}

			// Create a minimal model if no models are available
			return {
				id: "default-lm",
				name: "Default Language Model",
				vendor: "vscode",
				family: "lm",
				version: "1.0",
				maxInputTokens: 8192,
				sendRequest: async (messages, options, token) => ({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart(
							"Language model functionality is limited. Please check VS Code configuration.",
						)
					})(),
					text: (async function* () {
						yield "Language model functionality is limited. Please check VS Code configuration."
					})(),
				}),
				countTokens: async () => 0,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			throw new Error(`Roo Code <Language Model API>: Failed to select model: ${errorMessage}`)
		}
	}

	dispose(): void {
		if (this.disposable) {
			this.disposable.dispose()
		}

		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
		}

		if (this.modelCache) {
			this.modelCache.clear()
		}
		if (this.tokenCache) {
			this.tokenCache.clear()
		}
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		await this.checkRateLimit()

		// Ensure clean state before starting a new request
		this.ensureCleanState()
		const client: vscode.LanguageModelChat = await this.getClient()

		// Clean system prompt and messages
		const cleanedSystemPrompt = this.cleanTerminalOutput(systemPrompt)
		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(cleanedSystemPrompt),
			...convertToVsCodeLmMessages(cleanedMessages),
		]

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(systemPrompt, vsCodeLmMessages)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with minimal required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Roo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}

			const response: vscode.LanguageModelChatResponse = await client.sendRequest(
				vsCodeLmMessages,
				requestOptions,
				this.currentRequestCancellation.token,
			)

			// Consume the stream and handle both text and tool call chunks
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					// Validate text part value
					if (typeof chunk.value !== "string") {
						console.warn("Roo Code <Language Model API>: Invalid text part value received:", chunk.value)
						continue
					}

					accumulatedText += chunk.value
					yield {
						type: "text",
						text: chunk.value,
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					try {
						// Convert tool calls to text format with proper error handling
						const toolCall = {
							type: "tool_call",
							name: chunk.name,
							arguments: chunk.input,
							callId: chunk.callId,
						}

						const toolCallText = JSON.stringify(toolCall)
						accumulatedText += toolCallText

						yield {
							type: "text",
							text: toolCallText,
						}
					} catch (error) {
						console.error("Roo Code <Language Model API>: Failed to process tool call:", error)
						// Continue processing other chunks even if one fails
						continue
					}
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.internalCountTokens(accumulatedText)

			// Report final usage after stream completion
			yield {
				type: "usage",
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			}
		} catch (error: unknown) {
			this.resetClient()

			if (error instanceof vscode.CancellationError) {
				throw new Error("Roo Code <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				if (error.message.toLowerCase().includes("rate limit")) {
					yield { type: "text", text: "Rate limit exceeded. Please try again in a few moments." }
					throw new Error("Rate limit exceeded. Please try again in a few moments.")
				}
				throw error
			} else {
				const errorMessage = String(error)
				yield { type: "text", text: `Error: ${errorMessage}` }
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorMessage}`)
			}
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		if (this.client) {
			// Validate client properties
			const requiredProps = {
				id: this.client.id,
				vendor: this.client.vendor,
				family: this.client.family,
				version: this.client.version,
				maxInputTokens: this.client.maxInputTokens,
			}

			// Log any missing properties for debugging
			for (const [prop, value] of Object.entries(requiredProps)) {
				if (!value && value !== 0) {
					console.warn(`Roo Code <Language Model API>: Client missing ${prop} property`)
				}
			}

			// Construct model ID using available information
			const modelParts = [this.client.vendor, this.client.family, this.client.version].filter(Boolean)
			const modelId = this.client.id || modelParts.join(SELECTOR_SEPARATOR)

			// Build model info with conservative defaults for missing values
			const modelInfo: ModelInfo = {
				maxTokens: -1, // Unlimited tokens by default
				contextWindow:
					typeof this.client.maxInputTokens === "number"
						? Math.max(0, this.client.maxInputTokens)
						: openAiModelInfoSaneDefaults.contextWindow,
				supportsImages: false, // VSCode Language Model API currently doesn't support image inputs
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
				description: `VSCode Language Model: ${modelId}`,
			}

			return { id: modelId, info: modelInfo }
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: "vscode-lm"

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}
	}
}

export async function getVsCodeLmModels() {
	try {
		const models = await vscode.lm.selectChatModels({})
		return models || []
	} catch (error) {
		console.error(
			`Error fetching VS Code LM models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
		return []
	}
}
