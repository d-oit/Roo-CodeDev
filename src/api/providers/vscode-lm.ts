import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import LRU from "lru-cache"
import { SingleCompletionHandler } from "../"
import { calculateApiCost } from "../../utils/cost"
import { ApiStream } from "../transform/stream"
import { convertToVsCodeLmMessages } from "../transform/vscode-lm-format"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { BaseProvider } from "./base-provider"

/**
 * Handles interaction with VS Code's Language Model API for chat-based operations.
 * This handler extends BaseProvider to provide VS Code LM specific functionality.
 */
export class VsCodeLmHandler extends BaseProvider implements SingleCompletionHandler {
	private static readonly MAX_RETRIES = 3
	private static readonly RETRY_DELAY = 1000 // ms
	private modelCache: LRU<string, vscode.LanguageModelChat>
	private tokenCache: LRU<string, number>
	private static outputChannel: vscode.OutputChannel | undefined = undefined
	protected options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposable: vscode.Disposable | null
	private currentRequestCancellation: vscode.CancellationTokenSource | null

	private log(message: string, data?: any) {
		const config = vscode.workspace.getConfiguration("roo-cline")
		if (config.get("enableDebugOutput")) {
			if (!VsCodeLmHandler.outputChannel) {
				VsCodeLmHandler.outputChannel = vscode.window.createOutputChannel("Roo Code LM API")
			}
			const timestamp = new Date().toISOString()
			let logMessage = `[${timestamp}] ${message}`
			if (data !== undefined) {
				if (typeof data === "object") {
					// Pretty print objects with 2-space indentation
					logMessage += "\n" + JSON.stringify(data, null, 2)
				} else {
					logMessage += "\n" + data
				}
			}
			VsCodeLmHandler.outputChannel.appendLine(logMessage)
			VsCodeLmHandler.outputChannel.show(true)
		}
	}

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		this.log("Initializing VS Code LM Handler", {
			options: {
				apiModelId: options.apiModelId,
				modelMaxTokens: options.modelMaxTokens,
				modelTemperature: options.modelTemperature,
				vsCodeLmModelSelector: options.vsCodeLmModelSelector,
			},
		})

		// Initialize caches
		this.modelCache = new LRU({
			max: 10,
			ttl: 1000 * 60 * 5,
		})
		this.tokenCache = new LRU({
			max: 1000,
			ttl: 1000 * 60 * 60,
		})
		this.log("Cache initialized", {
			modelCache: { max: 10, ttl: "5 minutes" },
			tokenCache: { max: 1000, ttl: "1 hour" },
		})

		try {
			this.setupConfigurationListener()
			this.logConfiguration()
			this.getClient().catch((error) => {
				this.log("Failed to initialize client", {
					error: error.message,
					stack: error.stack,
				})
			})
			this.log("VS Code LM Handler initialization completed", {
				timestamp: new Date().toISOString(),
				status: "ready",
			})
		} catch (error) {
			this.log("Fatal error during initialization", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			})
			this.handleFatalError(error)
		}
	}

	private logConfiguration(): void {
		// Ensure we only log non-undefined values
		const configToLog = {
			apiModelId: this.options.apiModelId,
			modelMaxTokens: this.options.modelMaxTokens,
			modelTemperature: this.options.modelTemperature,
			includeMaxTokens: this.options.includeMaxTokens,
			vsCodeLmModelSelector: this.options.vsCodeLmModelSelector,
		}

		// Filter out undefined values
		const cleanConfig = Object.fromEntries(Object.entries(configToLog).filter(([_, v]) => v !== undefined))

		this.log("VS Code LM Handler Configuration", cleanConfig)
	}

	private setupConfigurationListener(): void {
		this.disposable = vscode.workspace.onDidChangeConfiguration(this.handleConfigChange.bind(this))
	}

	private handleConfigChange(event: vscode.ConfigurationChangeEvent): void {
		if (event.affectsConfiguration("lm")) {
			this.log("Configuration change detected for LM settings")
			try {
				this.log("Clearing client and cache")
				this.client = null
				this.modelCache.clear()
				this.ensureCleanState()
				this.log("Configuration change handled successfully")
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				this.log("Error during configuration change", {
					error: errorMessage,
					stack: error instanceof Error ? error.stack : undefined,
				})
			}
		}
	}

	private handleFatalError(error: unknown): never {
		this.dispose()
		const errorMessage = error instanceof Error ? error.message : "Unknown error"
		this.log("Fatal error in VS Code LM Handler", { error: errorMessage })
		throw new Error(`Roo Code <Language Model API>: Fatal error: ${errorMessage}`)
	}

	/**
	 * Creates a language model chat client based on the provided selector.
	 *
	 * @param selector - Selector criteria to filter language model chat instances
	 * @returns Promise resolving to the first matching language model chat instance
	 * @throws Error when no matching models are found with the given selector
	 *
	 * @example
	 * const selector = { vendor: "copilot", family: "gpt-4o" };
	 * const chatClient = await createClient(selector);
	 */
	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		const selectorKey = stringifyVsCodeLmModelSelector(selector)
		this.log(`Creating client for selector: ${selectorKey}`, selector)

		// Check cache first
		const cachedModel = this.modelCache.get(selectorKey)
		if (cachedModel) {
			this.log(`Using cached model for selector: ${selectorKey}`, {
				id: cachedModel.id,
				vendor: cachedModel.vendor,
				family: cachedModel.family,
			})
			return cachedModel
		}

		try {
			const models = await vscode.lm.selectChatModels(selector)

			if (models?.length) {
				this.log(
					"Available VS Code LM models:",
					models.map((m) => ({
						id: m.id,
						name: m.name,
						vendor: m.vendor,
						family: m.family,
						version: m.version,
						maxInputTokens: m.maxInputTokens,
					})),
				)
			} else {
				this.log("No models available for selector", { selector: selectorKey })
			}

			if (models && models.length > 0) {
				const selectedModel = models[0]
				this.log("Selected VS Code LM model:", {
					id: selectedModel.id,
					name: selectedModel.name,
					vendor: selectedModel.vendor,
					family: selectedModel.family,
					version: selectedModel.version,
					maxInputTokens: selectedModel.maxInputTokens,
					selector: selectorKey,
				})

				this.modelCache.set(selectorKey, selectedModel)
				return selectedModel
			}

			return await this.createClientWithRetry(selector)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.log(`Error creating client for selector: ${selectorKey}`, {
				error: errorMessage,
				stack: error instanceof Error ? error.stack : undefined,
			})
			return this.createFallbackModel()
		}
	}

	private async createClientWithRetry(
		selector: vscode.LanguageModelChatSelector,
		attempt = 1,
	): Promise<vscode.LanguageModelChat> {
		const selectorStr = stringifyVsCodeLmModelSelector(selector)
		this.log(`Attempting to create client (attempt ${attempt}/${VsCodeLmHandler.MAX_RETRIES})`, {
			selector: selectorStr,
			maxRetries: VsCodeLmHandler.MAX_RETRIES,
		})

		try {
			const models = await vscode.lm.selectChatModels(selector)
			this.log(`Available models for selector ${selectorStr}:`, {
				modelCount: models?.length ?? 0,
				models: models?.map((m) => ({
					id: m.id,
					name: m.name,
					vendor: m.vendor,
					family: m.family,
				})),
			})

			if (models?.length > 0) {
				const selectedModel = models[0]
				this.log(`Selected model for ${selectorStr}:`, {
					id: selectedModel.id,
					name: selectedModel.name,
					vendor: selectedModel.vendor,
					family: selectedModel.family,
					maxInputTokens: selectedModel.maxInputTokens,
				})
				return selectedModel
			}

			throw new Error(`No models available for selector: ${selectorStr}`)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.log(`Client creation failed (attempt ${attempt})`, {
				error: errorMessage,
				selector: selectorStr,
				stack: error instanceof Error ? error.stack : undefined,
			})

			if (attempt >= VsCodeLmHandler.MAX_RETRIES) {
				this.log(`Max retries (${VsCodeLmHandler.MAX_RETRIES}) reached for selector: ${selectorStr}`, {
					error: errorMessage,
				})
				throw error
			}

			const delayMs = VsCodeLmHandler.RETRY_DELAY * attempt
			this.log(`Scheduling retry for selector: ${selectorStr}`, {
				nextAttempt: attempt + 1,
				delayMs: delayMs,
			})

			await new Promise((resolve) => setTimeout(resolve, delayMs))
			return this.createClientWithRetry(selector, attempt + 1)
		}
	}

	private createFallbackModel(): vscode.LanguageModelChat {
		this.log("Creating fallback model")
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
	}

	/**
	 * Creates and streams a message using the VS Code Language Model API.
	 *
	 * @param systemPrompt - The system prompt to initialize the conversation context
	 * @param messages - An array of message parameters following the Anthropic message format
	 *
	 * @yields {ApiStream} An async generator that yields either text chunks or tool calls from the model response
	 *
	 * @throws {Error} When vsCodeLmModelSelector option is not provided
	 * @throws {Error} When the response stream encounters an error
	 *
	 * @remarks
	 * This method handles the initialization of the VS Code LM client if not already created,
	 * converts the messages to VS Code LM format, and streams the response chunks.
	 * Tool calls handling is currently a work in progress.
	 */
	dispose(): void {
		this.log("Disposing VS Code LM Handler")
		this.modelCache.clear()
		this.tokenCache.clear()

		if (this.disposable) {
			this.disposable.dispose()
		}

		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
		}

		if (VsCodeLmHandler.outputChannel) {
			VsCodeLmHandler.outputChannel.dispose()
		}
	}

	/**
	 * Implements the ApiHandler countTokens interface method
	 * Provides token counting for Anthropic content blocks
	 *
	 * @param content The content blocks to count tokens for
	 * @returns A promise resolving to the token count
	 */
	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		const cacheKey = JSON.stringify(content)

		try {
			// Check cache first
			const cachedCount = this.tokenCache.get(cacheKey)
			if (cachedCount !== undefined) {
				this.log("Using cached token count", { cacheKey })
				return cachedCount
			}

			// Calculate tokens
			const textContent = this.convertContentToText(content)
			const count = await this.internalCountTokens(textContent)

			// Cache the result
			this.tokenCache.set(cacheKey, count)
			return count
		} catch (error) {
			this.log("Token counting failed", { error })
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

	/**
	 * Private implementation of token counting used internally by VsCodeLmHandler
	 */
	private ensureCancellationToken(): vscode.CancellationTokenSource {
		if (!this.currentRequestCancellation || this.currentRequestCancellation.token.isCancellationRequested) {
			this.currentRequestCancellation?.dispose()
			this.currentRequestCancellation = new vscode.CancellationTokenSource()
		}
		return this.currentRequestCancellation
	}

	private async internalCountTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		if (!this.client) {
			this.log("No client available for token counting")
			return 0
		}

		const cancellation = this.ensureCancellationToken()

		if (!text) {
			this.log("Empty text provided for token counting")
			return 0
		}

		try {
			let tokenCount: number

			if (typeof text === "string") {
				tokenCount = await this.client.countTokens(text, cancellation.token)
			} else if (text instanceof vscode.LanguageModelChatMessage) {
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					this.log("Empty chat message content")
					return 0
				}
				tokenCount = await this.client.countTokens(text, cancellation.token)
			} else {
				this.log("Invalid input type for token counting")
				return 0
			}

			if (typeof tokenCount !== "number") {
				this.log("Non-numeric token count received:", tokenCount)
				return 0
			}

			if (tokenCount < 0) {
				this.log("Negative token count received:", tokenCount)
				return 0
			}

			return tokenCount
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				this.log("Token counting cancelled by user")
				return 0
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.log("Token counting failed:", errorMessage)

			if (error instanceof Error && error.stack) {
				this.log("Token counting error stack:", error.stack)
			}

			return 0
		}
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

	private clientInitPromise: Promise<vscode.LanguageModelChat> | null = null

	private async getClient(): Promise<vscode.LanguageModelChat> {
		if (this.clientInitPromise) {
			return this.clientInitPromise
		}

		this.clientInitPromise =
			this.clientInitPromise ||
			(async () => {
				if (this.client) {
					this.log("Using existing client", {
						id: this.client.id,
						vendor: this.client.vendor,
						family: this.client.family,
					})
					return this.client
				}

				this.log("Initializing new client")

				const selector = this.options.vsCodeLmModelSelector ?? {
					vendor: "copilot",
					family: "claude-3.5-sonnet",
				}

				this.log("Initializing client with selector:", {
					selector: stringifyVsCodeLmModelSelector(selector),
					selectorDetails: selector,
				})

				try {
					this.client = await this.createClient(selector)
					this.log("Client initialized successfully", {
						id: this.client.id,
						vendor: this.client.vendor,
						family: this.client.family,
						maxInputTokens: this.client.maxInputTokens,
					})
					return this.client
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					this.log("Client initialization failed", {
						error: errorMessage,
						selector: stringifyVsCodeLmModelSelector(selector),
						stack: error instanceof Error ? error.stack : undefined,
					})
					this.clientInitPromise = null
					throw error
				}
			})()

		return this.clientInitPromise
	}

	private cleanTerminalOutput(text: string): string {
		if (!text) {
			return ""
		}

		return (
			text
				// Нормализуем переносы строк
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "\n")

				// Удаляем ANSI escape sequences
				.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "") // Полный набор ANSI sequences
				.replace(/\x9B[0-?]*[ -/]*[@-~]/g, "") // CSI sequences

				// Удаляем последовательности установки заголовка терминала и прочие OSC sequences
				.replace(/\x1B\][0-9;]*(?:\x07|\x1B\\)/g, "")

				// Удаляем управляющие символы
				.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, "")

				// Удаляем escape-последовательности VS Code
				.replace(/\x1B[PD].*?\x1B\\/g, "") // DCS sequences
				.replace(/\x1B_.*?\x1B\\/g, "") // APC sequences
				.replace(/\x1B\^.*?\x1B\\/g, "") // PM sequences
				.replace(/\x1B\[[\d;]*[HfABCDEFGJKST]/g, "") // Cursor movement and clear screen

				// Удаляем пути Windows и служебную информацию
				.replace(/^(?:PS )?[A-Z]:\\[^\n]*$/gm, "")
				.replace(/^;?Cwd=.*$/gm, "")

				// Очищаем экранированные последовательности
				.replace(/\\x[0-9a-fA-F]{2}/g, "")
				.replace(/\\u[0-9a-fA-F]{4}/g, "")

				// Финальная очистка
				.replace(/\n{3,}/g, "\n\n") // Убираем множественные пустые строки
				.trim()
		)
	}

	private cleanMessageContent(content: any): any {
		if (!content) {
			return content
		}

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

	override async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
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

			// Note: Tool support is currently provided by the VSCode Language Model API directly
			// Extensions can register tools using vscode.lm.registerTool()

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
						this.log("Invalid text part value received:", chunk.value)
						continue
					}

					accumulatedText += chunk.value
					yield {
						type: "text",
						text: chunk.value,
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					try {
						// Validate tool call parameters
						if (!chunk.name || typeof chunk.name !== "string") {
							this.log("Invalid tool name received:", chunk.name)
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							this.log("Invalid tool callId received:", chunk.callId)
							continue
						}

						// Ensure input is a valid object
						if (!chunk.input || typeof chunk.input !== "object") {
							this.log("Invalid tool input received:", chunk.input)
							continue
						}

						// Convert tool calls to text format with proper error handling
						const toolCall = {
							type: "tool_call",
							name: chunk.name,
							arguments: chunk.input,
							callId: chunk.callId,
						}

						const toolCallText = JSON.stringify(toolCall)
						accumulatedText += toolCallText

						// Log tool call for debugging
						this.log("Processing tool call:", {
							name: chunk.name,
							callId: chunk.callId,
							inputSize: JSON.stringify(chunk.input).length,
						})

						yield {
							type: "text",
							text: toolCallText,
						}
					} catch (error) {
						this.log("Failed to process tool call:", error)
						// Continue processing other chunks even if one fails
						continue
					}
				} else {
					this.log("Unknown chunk type received:", chunk)
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.internalCountTokens(accumulatedText)

			// Report final usage after stream completion
			yield {
				type: "usage",
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				totalCost: calculateApiCost(this.getModel().info, totalInputTokens, totalOutputTokens),
			}
		} catch (error: unknown) {
			this.ensureCleanState()

			if (error instanceof vscode.CancellationError) {
				throw new Error("Roo Code <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				this.log("Stream error details:", {
					message: error.message,
					stack: error.stack,
					name: error.name,
				})

				// Return original error if it's already an Error instance
				throw error
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				this.log("Stream error object:", errorDetails)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				this.log("Unknown stream error:", errorMessage)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorMessage}`)
			}
		}
	}

	// Return model information based on the current client state
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
					this.log(`Client missing ${prop} property`)
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

		this.log("No client available, using fallback model info")

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}
	}

	async completePrompt(prompt: string): Promise<string> {
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
}

export async function getVsCodeLmModels(): Promise<vscode.LanguageModelChat[]> {
	try {
		const models = await vscode.lm.selectChatModels({})

		// Log available models for debugging
		if (models?.length) {
			console.debug(
				"Available VS Code LM models:\n" +
					JSON.stringify(
						models.map((m) => ({
							id: m.id,
							name: m.name,
							vendor: m.vendor,
							family: m.family,
							version: m.version,
							maxInputTokens: m.maxInputTokens,
						})),
						null,
						2,
					),
			)
		}

		return models || []
	} catch (error) {
		console.error("Error fetching VS Code LM models:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
		return []
	}
}
