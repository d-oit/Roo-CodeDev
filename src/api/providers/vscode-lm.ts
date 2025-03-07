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
 */
export class VsCodeLmHandler extends BaseProvider implements SingleCompletionHandler {
	private static readonly MAX_RETRIES = 3
	private static readonly RETRY_DELAY = 1000 // ms
	private requestCount: number = 0
	private lastResetTime: number = Date.now()
	private static readonly MAX_CONSECUTIVE_PROMPTS = 5
	private static readonly PROMPT_TIMEOUT = 60000 // 60 seconds
	private lastPrompts: Array<{ prompt: string; timestamp: number }> = []

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
			this.log("RATE_LIMIT", `Rate limit reached. Waiting ${delaySeconds} seconds`, {
				requestCount: this.requestCount,
				delaySeconds: delaySeconds,
			})

			await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))
			this.requestCount = 0
			this.lastResetTime = Date.now()
		}

		this.requestCount++
	}

	private modelCache: LRU<string, vscode.LanguageModelChat>
	private tokenCache: LRU<string, number>
	private static outputChannel: vscode.OutputChannel | undefined = undefined
	protected options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposable: vscode.Disposable | null
	private currentRequestCancellation: vscode.CancellationTokenSource | null

	private ensureOutputChannel() {
		if (!VsCodeLmHandler.outputChannel) {
			VsCodeLmHandler.outputChannel = vscode.window.createOutputChannel("Roo Code LM API")
		}
		return VsCodeLmHandler.outputChannel
	}

	private logError(error: unknown, context: string) {
		const channel = this.ensureOutputChannel()
		const errorMessage = error instanceof Error ? error.message : String(error)
		const errorDetails = {
			message: errorMessage,
			stack: error instanceof Error ? error.stack : undefined,
			context,
			timestamp: new Date().toISOString(),
		}

		// Always log errors, regardless of debug setting
		channel.appendLine(`[ERROR] [${context}] ${JSON.stringify(errorDetails, null, 2)}`)

		// Also log through regular logging system
		this.log("ERROR", `Error in ${context}`, errorDetails)
	}

	private log(category: string, message: string, data?: any) {
		// Explicitly check configuration
		const config = vscode.workspace.getConfiguration("roo-cline")
		const debugEnabled = config.get<boolean>("enableDebugOutput") ?? false

		if (debugEnabled) {
			if (!VsCodeLmHandler.outputChannel) {
				VsCodeLmHandler.outputChannel = vscode.window.createOutputChannel("Roo Code LM API")
			}
			const timestamp = new Date().toISOString()
			let logMessage = `[${timestamp}] [${category}] ${message}`

			if (data !== undefined) {
				if (typeof data === "object") {
					// Format object data with consistent indentation
					logMessage += "\n  " + JSON.stringify(data, null, 2).replace(/\n/g, "\n  ")
				} else {
					logMessage += "\n  " + data
				}
			}
			VsCodeLmHandler.outputChannel.appendLine(logMessage)
		}
	}

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Initial setup log
		this.log("INIT", "Starting VS Code LM Handler initialization")

		// Options log
		this.log("CONFIG", "Handler options", {
			apiModelId: options.apiModelId,
			modelMaxTokens: options.modelMaxTokens,
			modelTemperature: options.modelTemperature,
			vsCodeLmModelSelector: options.vsCodeLmModelSelector,
		})

		// Cache initialization
		this.modelCache = new LRU({
			max: 10,
			ttl: 1000 * 60 * 5,
		})
		this.tokenCache = new LRU({
			max: 1000,
			ttl: 1000 * 60 * 60,
		})
		this.log("CACHE", "Cache initialization completed", {
			modelCache: {
				maxSize: 10,
				ttlMinutes: 5,
			},
			tokenCache: {
				maxSize: 1000,
				ttlHours: 1,
			},
		})

		try {
			this.setupConfigurationListener()
			this.log("CONFIG", "Configuration listener setup completed")

			this.logConfiguration()
			this.log("CONFIG", "Configuration logged successfully")

			// Initialize client
			this.getClient()
				.then((client) => {
					this.log("CLIENT", "Client initialization successful", {
						id: client.id,
						vendor: client.vendor,
						family: client.family,
						maxInputTokens: client.maxInputTokens,
					})
				})
				.catch((error) => {
					this.log("ERROR", "Client initialization failed", {
						error: error.message,
						stack: error.stack,
					})
				})

			this.log("INIT", "VS Code LM Handler initialization completed", {
				timestamp: new Date().toISOString(),
				status: "ready",
			})
		} catch (error) {
			if (error instanceof vscode.LanguageModelError) {
				this.log("VS_CODE_LM_ERROR", "Language Model API Error", {
					message: error.message,
					code: error.code,
					cause: error.cause,
					stack: error.stack,
				})

				// Use the existing handleFatalError with detailed VS Code LM error info
				return this.handleFatalError(
					`VS Code Language Model Error: ${error.message} (Code: ${error.code})${error.cause ? `. Cause: ${error.cause}` : ""}`,
				)
			}

			return this.handleFatalError(error)
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

		this.log("CONFIG", "Current configuration settings", cleanConfig)
	}

	private setupConfigurationListener(): void {
		this.disposable = vscode.workspace.onDidChangeConfiguration(this.handleConfigChange.bind(this))
	}

	private handleConfigChange(event: vscode.ConfigurationChangeEvent): void {
		if (event.affectsConfiguration("lm")) {
			this.log("CONFIG", "Configuration change detected for LM settings")
			try {
				this.log("STATE", "Clearing client and cache")
				this.client = null
				this.modelCache.clear()
				this.ensureCleanState()
				this.log("CONFIG", "Configuration change handled successfully")
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				this.log("ERROR", "Error during configuration change", {
					error: errorMessage,
					stack: error instanceof Error ? error.stack : undefined,
				})
			}
		}
	}

	private handleFatalError(error: unknown): never {
		this.dispose()
		const errorMessage = error instanceof Error ? error.message : "Unknown error"
		this.log("FATAL", "Fatal error in VS Code LM Handler", {
			error: errorMessage,
			stack: error instanceof Error ? error.stack : undefined,
		})
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
		this.log("CLIENT", "Creating client for selector: " + selectorKey, selector)

		// Check cache first
		const cachedModel = this.modelCache.get(selectorKey)
		if (cachedModel) {
			this.log("CLIENT", "Using cached model", {
				selector: selectorKey,
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
					"CLIENT",
					"Available VS Code LM models",
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
				this.log("CLIENT", "No models available", { selector: selectorKey })
			}

			if (models && models.length > 0) {
				const selectedModel = models[0]
				this.log("CLIENT", "Selected VS Code LM model", {
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
			this.log("ERROR", `Error creating client for selector: ${selectorKey}`, {
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
		this.log("CLIENT", `Retry attempt ${attempt}/${VsCodeLmHandler.MAX_RETRIES}`, {
			selector: selectorStr,
			maxRetries: VsCodeLmHandler.MAX_RETRIES,
		})

		try {
			const models = await vscode.lm.selectChatModels(selector)
			this.log("CLIENT", `Available models for selector ${selectorStr}`, {
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
				this.log("CLIENT", `Selected model for ${selectorStr}`, {
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
			this.log("ERROR", `Client creation failed (attempt ${attempt})`, {
				error: errorMessage,
				selector: selectorStr,
				stack: error instanceof Error ? error.stack : undefined,
			})

			if (attempt >= VsCodeLmHandler.MAX_RETRIES) {
				this.log("ERROR", `Max retries (${VsCodeLmHandler.MAX_RETRIES}) reached for selector: ${selectorStr}`, {
					error: errorMessage,
				})
				throw error
			}

			const delayMs = VsCodeLmHandler.RETRY_DELAY * attempt
			this.log("CLIENT", `Scheduling retry for selector: ${selectorStr}`, {
				nextAttempt: attempt + 1,
				delayMs: delayMs,
			})

			await new Promise((resolve) => setTimeout(resolve, delayMs))
			return this.createClientWithRetry(selector, attempt + 1)
		}
	}

	private createFallbackModel(): vscode.LanguageModelChat {
		this.log("CLIENT", "Creating fallback model")
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
		this.log("DISPOSE", "Disposing VS Code LM Handler")
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
		await this.checkRateLimit()

		const cacheKey = JSON.stringify(content)

		try {
			// Check cache first
			const cachedCount = this.tokenCache.get(cacheKey)
			if (cachedCount !== undefined) {
				this.log("TOKENS", "Using cached token count", { cacheKey })
				return cachedCount
			}

			// Calculate tokens
			const textContent = this.convertContentToText(content)
			const count = await this.internalCountTokens(textContent)

			// Cache the result
			this.tokenCache.set(cacheKey, count)
			return count
		} catch (error) {
			this.log("TOKENS", "Token counting failed", {
				error: error instanceof Error ? error.message : String(error),
			})
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
			this.log("TOKENS", "No client available for token counting")
			return 0
		}

		const cancellation = this.ensureCancellationToken()

		if (!text) {
			this.log("TOKENS", "Empty text provided for token counting")
			return 0
		}

		try {
			let tokenCount: number

			if (typeof text === "string") {
				tokenCount = await this.client.countTokens(text, cancellation.token)
			} else if (text instanceof vscode.LanguageModelChatMessage) {
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					this.log("TOKENS", "Empty chat message content")
					return 0
				}
				tokenCount = await this.client.countTokens(text, cancellation.token)
			} else {
				this.log("TOKENS", "Invalid input type for token counting")
				return 0
			}

			if (typeof tokenCount !== "number") {
				this.log("TOKENS", `Non-numeric token count received: ${String(tokenCount)}`)
				return 0
			}

			if (tokenCount < 0) {
				this.log("TOKENS", `Negative token count received: ${tokenCount}`)
				return 0
			}

			return tokenCount
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				this.log("TOKENS", "Token counting cancelled by user")
				return 0
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.log("TOKENS", "Token counting failed", {
				error: errorMessage,
				stack: error instanceof Error ? error.stack : undefined,
			})

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
		this.log("CLIENT", "Getting client status", {
			hasExistingPromise: !!this.clientInitPromise,
			hasExistingClient: !!this.client,
		})

		if (this.clientInitPromise) {
			this.log("CLIENT", "Returning existing client initialization promise")
			return this.clientInitPromise
		}

		this.clientInitPromise = (async () => {
			if (this.client) {
				this.log("CLIENT", "Using existing client", {
					id: this.client.id,
					vendor: this.client.vendor,
					family: this.client.family,
				})
				return this.client
			}

			this.log("CLIENT", "Initializing new client")

			const selector = this.options.vsCodeLmModelSelector ?? {
				vendor: "copilot",
				family: "claude-3.5-sonnet",
			}

			this.log("CLIENT", "Client selector configuration", {
				selector: stringifyVsCodeLmModelSelector(selector),
				selectorDetails: selector,
			})

			try {
				this.client = await this.createClient(selector)
				this.log("CLIENT", "Client initialization successful", {
					id: this.client.id,
					vendor: this.client.vendor,
					family: this.client.family,
					maxInputTokens: this.client.maxInputTokens,
				})
				return this.client
			} catch (error) {
				this.log("CLIENT", "Client initialization failed", {
					error: error instanceof Error ? error.message : String(error),
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

	override async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		await this.checkRateLimit()

		const startTime = Date.now()
		this.log("STREAM", "Starting message creation", {
			systemPromptLength: systemPrompt.length,
			messagesCount: messages.length,
			timestamp: new Date(startTime).toISOString(),
		})

		// Ensure clean state before starting a new request
		this.ensureCleanState()
		const client: vscode.LanguageModelChat = await this.getClient()

		// Clean system prompt and messages
		const cleanedSystemPrompt = this.cleanTerminalOutput(systemPrompt)
		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))

		this.log("STREAM", "Messages cleaned and prepared", {
			cleanedSystemPromptLength: cleanedSystemPrompt.length,
			cleanedMessagesCount: cleanedMessages.length,
		})

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(cleanedSystemPrompt),
			...convertToVsCodeLmMessages(cleanedMessages),
		]

		// Log the actual messages being sent to VS Code LM
		this.log("REQUEST_DETAILS", "Processed messages for VS Code LM", {
			messages: vsCodeLmMessages.map((msg) => ({
				role: msg.role,
				content: msg.content,
				name: msg.name,
			})),
			requestOptions: {
				justification: `Roo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			},
		})

		this.log("STREAM", "Messages converted to VS Code LM format", {
			totalMessages: vsCodeLmMessages.length,
		})

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(systemPrompt, vsCodeLmMessages)

		this.log("STREAM", "Token calculation completed", {
			totalInputTokens,
		})

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with minimal required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Roo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}

			this.log("STREAM", "Sending request to language model", {
				clientName: client.name,
				clientVendor: client.vendor,
				clientFamily: client.family,
			})

			const response: vscode.LanguageModelChatResponse = await client.sendRequest(
				vsCodeLmMessages,
				requestOptions,
				this.currentRequestCancellation.token,
			)

			const sendTime = Date.now()
			this.log("STREAM", "Request sent and stream started", {
				setupTimeMs: sendTime - startTime,
				clientInfo: {
					name: client.name,
					vendor: client.vendor,
					family: client.family,
				},
			})

			// Initialize metrics
			let textChunkCount = 0
			let toolCallCount = 0
			let totalTextLength = 0

			// Consume the stream and handle both text and tool call chunks
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					if (typeof chunk.value === "string") {
						// Log potential Copilot quota messages
						if (
							chunk.value.includes("quota") ||
							chunk.value.includes("rate limit") ||
							chunk.value.includes("You've reached your GitHub Copilot")
						) {
							this.log("COPILOT_QUOTA", "Copilot quota message detected", {
								message: chunk.value,
								clientInfo: {
									name: client.name,
									vendor: client.vendor,
									family: client.family,
								},
							})
						}
						textChunkCount++
						totalTextLength += chunk.value.length
						accumulatedText += chunk.value
						yield { type: "text", text: chunk.value }
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					this.log("TOOL_CALL", "Received tool call", {
						name: chunk.name,
						callId: chunk.callId,
						inputType: typeof chunk.input,
					})
					toolCallCount++
					try {
						// Validate tool call parameters
						if (!chunk.name || typeof chunk.name !== "string") {
							this.log("VALIDATION", "Invalid tool name received", {
								receivedName: chunk.name,
							})
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							this.log("VALIDATION", "Invalid tool callId received", {
								receivedCallId: chunk.callId,
							})
							continue
						}

						if (!chunk.input || typeof chunk.input !== "object") {
							this.log("VALIDATION", "Invalid tool input received", {
								receivedInput: chunk.input,
							})
							continue
						}

						// Convert tool calls to text format
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
						this.log("ERROR", "Error processing tool call", {
							error: error instanceof Error ? error.message : String(error),
							toolName: chunk.name,
							callId: chunk.callId,
						})
						// Continue processing other chunks even if one fails
						continue
					}
				}
			}

			const endTime = Date.now()

			// Count tokens in the accumulated text
			const totalOutputTokens: number = await this.internalCountTokens(accumulatedText)

			// Log metrics including token counts
			this.log("METRICS", "Stream processing completed", {
				metrics: {
					totalTimeMs: endTime - startTime,
					streamTimeMs: endTime - sendTime,
					textChunks: textChunkCount,
					toolCalls: toolCallCount,
					totalLength: totalTextLength,
					averageChunkSize: Math.round(totalTextLength / textChunkCount),
					chunksPerSecond: Math.round((textChunkCount + toolCallCount) / ((endTime - sendTime) / 1000)),
					inputTokens: totalInputTokens,
					outputTokens: totalOutputTokens,
				},
			})

			// Yield usage information
			yield {
				type: "usage",
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			}
		} catch (error) {
			this.ensureCleanState()

			if (error instanceof vscode.CancellationError) {
				this.client = null // Dispose client
				throw new Error("Roo Code <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				this.log("ERROR", "Stream error details", {
					message: error.message,
					stack: error.stack,
					name: error.name,
				})

				this.client = null // Dispose client
				// Yield an error message before throwing
				if (error.message.toLowerCase().includes("rate limit")) {
					yield { type: "text", text: "Rate limit exceeded. Please try again in a few moments." }
					throw new Error("Rate limit exceeded. Please try again in a few moments.")
				}
				yield { type: "text", text: `Error: ${error.message}` }
				throw new Error(`Roo Code <Language Model API>: ${error.message}`)
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				this.log("ERROR", "Stream error object", {
					error: errorDetails,
				})
				this.client = null // Dispose client
				yield { type: "text", text: `Error: ${errorDetails}` }
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				this.log("ERROR", "Unknown stream error", {
					error: errorMessage,
				})
				this.client = null // Dispose client
				yield { type: "text", text: `Error: ${errorMessage}` }
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
					this.log("VALIDATION", `Missing required property: ${prop}`)
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

		this.log("MODEL", "No client available, using fallback model info")

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
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
				this.log("ERROR", "VSCode LM completion error", {
					error: error.message,
					stack: error.stack,
				})
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
		console.error("Error fetching VS Code LM models:", error instanceof Error ? error.message : String(error))
		return []
	}
}
