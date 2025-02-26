import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import { ApiHandler, SingleCompletionHandler } from "../"
import { calculateApiCost } from "../../utils/cost"
import { ApiStream } from "../transform/stream"
import { convertToVsCodeLmMessages } from "../transform/vscode-lm-format"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"

/**
 * Handles interaction with VS Code's Language Model API for chat-based operations.
 * This handler implements the ApiHandler interface to provide VS Code LM specific functionality.
 *
 * @implements {ApiHandler}
 *
 * @remarks
 * The handler manages a VS Code language model chat client and provides methods to:
 * - Create and manage chat client instances
 * - Stream messages using VS Code's Language Model API
 * - Retrieve model information
 *
 * @example
 * ```typescript
 * const options = {
 *   vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4" }
 * };
 * const handler = new VsCodeLmHandler(options);
 *
 * // Stream a conversation
 * const systemPrompt = "You are a helpful assistant";
 * const messages = [{ role: "user", content: "Hello!" }];
 * for await (const chunk of handler.createMessage(systemPrompt, messages)) {
 *   console.log(chunk);
 * }
 * ```
 */
export class VsCodeLmHandler implements ApiHandler, SingleCompletionHandler {
	private options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposable: vscode.Disposable | null
	private currentRequestCancellation: vscode.CancellationTokenSource | null
	private outputChannel: vscode.OutputChannel
	private cachedModelSelector: vscode.LanguageModelChatSelector | null = null
	private cachedModel: vscode.LanguageModelChat | null = null
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private enableDebugOutput: boolean = false
	private modelCheckInterval: NodeJS.Timeout | undefined

	/**
	 * Optimized logging with debouncing
	 */
	private logQueue: string[] = []
	private logTimeout: NodeJS.Timeout | null = null
	private readonly LOG_DEBOUNCE_MS = 100
	private readonly LOG_BATCH_SIZE = 10

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = null

		// Get debug configuration
		const config = vscode.workspace.getConfiguration("roo-cline")
		this.enableDebugOutput = config.get<boolean>("debug.vscode-lm", false)

		// Use shared output channel if it exists, otherwise create a new one
		if (!VsCodeLmHandler.sharedOutputChannel) {
			VsCodeLmHandler.sharedOutputChannel = vscode.window.createOutputChannel("Roo Code VS Code LM")
		}
		this.outputChannel = VsCodeLmHandler.sharedOutputChannel

		this.logInfo("VS Code LM Handler initialized")
		this.logInfo(`Debug output ${this.enableDebugOutput ? "enabled" : "disabled"}`)

		try {
			// Listen for model changes and reset client
			this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("lm")) {
					try {
						this.client = null
						this.ensureCleanState()
						this.logInfo("Configuration changed, client reset")
					} catch (error) {
						console.error("Error during configuration change cleanup:", error)
						this.logError(`Error during configuration change cleanup: ${error}`)
					}
				}

				// Update debug setting if it changes
				if (event.affectsConfiguration("roo-cline.debug.vscode-lm")) {
					const config = vscode.workspace.getConfiguration("roo-cline")
					this.enableDebugOutput = config.get<boolean>("debug.vscode-lm", false)
					this.logInfo(`Debug output ${this.enableDebugOutput ? "enabled" : "disabled"}`)
				}
			})
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()

			const errorMessage = `Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`
			this.logError(errorMessage)
			throw new Error(`Roo Code <Language Model API>: ${errorMessage}`)
		}
	}

	/**
	 * Log a message to the output channel with debouncing
	 */
	private log(message: string): void {
		// Skip logging if debug output is disabled
		if (!this.enableDebugOutput) {
			return
		}

		// Add to queue
		this.logQueue.push(message)

		// Process immediately if queue is getting large
		if (this.logQueue.length >= this.LOG_BATCH_SIZE) {
			this.flushLogs()
			return
		}

		// Otherwise debounce
		if (this.logTimeout) {
			clearTimeout(this.logTimeout)
		}

		this.logTimeout = setTimeout(() => {
			this.flushLogs()
		}, this.LOG_DEBOUNCE_MS)
	}

	/**
	 * Flush logs to the output channel
	 */
	private flushLogs(): void {
		if (this.logQueue.length === 0) return

		// Process each message through logDebug
		for (const message of this.logQueue) {
			this.logDebug(message)
		}

		// Clear queue
		this.logQueue = []

		if (this.logTimeout) {
			clearTimeout(this.logTimeout)
			this.logTimeout = null
		}
	}

	/**
	 * Log an informational message to the output channel (always logged)
	 */
	private logInfo(message: string): void {
		// Add timestamp to message
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] INFO: ${message}`

		// Log directly to output channel
		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Log an error message to the output channel (always logged)
	 */
	private logError(message: string): void {
		// Add timestamp to message
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] ERROR: ${message}`

		// Log directly to output channel
		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Log a debug message to the output channel (only when debug is enabled)
	 */
	private logDebug(message: string): void {
		// Skip logging if debug output is disabled
		if (!this.enableDebugOutput) {
			return
		}

		// Add timestamp to message
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] DEBUG: ${message}`

		// Log directly to output channel
		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Log a warning message to the output channel (always logged)
	 */
	private logWarning(message: string): void {
		// Add timestamp to message
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] WARNING: ${message}`

		// Log directly to output channel
		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Creates a client with the given model selector, using cache when possible
	 */
	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		this.logInfo(`Creating client with selector: ${JSON.stringify(selector)}`)

		try {
			// Check if we can use the cached model
			if (
				this.cachedModel &&
				this.cachedModelSelector &&
				this.areSelectorsEqual(selector, this.cachedModelSelector)
			) {
				// Verify the cached model is still available
				const availableModels = await vscode.lm.selectChatModels({})
				const modelStillAvailable = availableModels.some(
					(model) =>
						model.id === this.cachedModel?.id &&
						model.vendor === this.cachedModel?.vendor &&
						model.family === this.cachedModel?.family,
				)

				if (modelStillAvailable) {
					this.logInfo(`Using cached model: ${this.cachedModel.name} (${this.cachedModel.id})`)
					return this.cachedModel
				} else {
					this.logInfo(`Cached model ${this.cachedModel.id} is no longer available, selecting new model`)
					// Clear cache since model is no longer available
					this.cachedModel = null
					this.cachedModelSelector = null
				}
			}

			// If no cache or selector changed, get new models
			this.logInfo(`Selecting new models with selector: ${JSON.stringify(selector)}`)
			const models = await vscode.lm.selectChatModels(selector)

			this.logInfo(`Found ${models.length} matching models`)

			// Use first available model or create a minimal model object
			if (models && Array.isArray(models) && models.length > 0) {
				const model = models[0]
				this.logInfo(`Selected model: ${model.name} (${model.id}) from ${model.vendor}`)

				// Cache the model and selector
				this.cachedModel = model
				this.cachedModelSelector = { ...selector }

				return model
			}

			this.logInfo("No matching models found, using default model")
			// Create a minimal model if no models are available
			const defaultModel = {
				id: "default-lm",
				name: "Default Language Model",
				vendor: "vscode",
				family: "lm",
				version: "1.0",
				maxInputTokens: 8192,
				sendRequest: async (
					messages: vscode.LanguageModelChatMessage[],
					options: vscode.LanguageModelChatRequestOptions,
					token: vscode.CancellationToken,
				) => {
					// Provide a minimal implementation
					return {
						stream: (async function* () {
							yield new vscode.LanguageModelTextPart(
								"Language model functionality is limited. Please check VS Code configuration.",
							)
						})(),
						text: (async function* () {
							yield "Language model functionality is limited. Please check VS Code configuration."
						})(),
					}
				},
				countTokens: async () => 0,
			}

			// Cache the default model
			this.cachedModel = defaultModel
			this.cachedModelSelector = { ...selector }

			return defaultModel
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.logError(`Failed to select model: ${errorMessage}`)
			throw new Error(`Roo Code <Language Model API>: Failed to select model: ${errorMessage}`)
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
		this.ensureCleanState()

		if (this.disposable) {
			this.disposable.dispose()
			this.disposable = null
		}

		// Clear cached model and selector
		this.cachedModel = null
		this.cachedModelSelector = null

		this.client = null
		this.logInfo("VS Code LM Handler disposed")

		// Flush any remaining logs
		this.flushLogs()
	}

	/**
	 * Optimized token counting with caching
	 * @param text The text to count tokens for
	 * @returns The number of tokens
	 */
	private tokenCountCache = new Map<string, number>()
	private readonly TOKEN_CACHE_MAX_SIZE = 100

	private async countTokens(text: string): Promise<number> {
		// For very short texts, use a simple estimation to avoid API calls
		if (text.length < 4) {
			return text.length > 0 ? 1 : 0
		}

		// Check cache first
		const cacheKey = this.generateCacheKey(text)
		if (this.tokenCountCache.has(cacheKey)) {
			this.outputChannel.appendLine(`Using cached token count for text of length ${text.length}`)
			return this.tokenCountCache.get(cacheKey) || 0
		}

		try {
			const client = await this.getClient()
			const count = await client.countTokens(text)

			// Cache the result
			this.maintainCacheSize()
			this.tokenCountCache.set(cacheKey, count)

			return count
		} catch (error) {
			this.outputChannel.appendLine(
				`Token counting failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			// Fallback to a simple estimation
			return Math.ceil(text.length / 4)
		}
	}

	/**
	 * Generate a cache key for token counting
	 * For longer texts, we use a hash of the first and last parts
	 */
	private generateCacheKey(text: string): string {
		if (text.length <= 100) {
			return text
		}

		// For longer texts, use first 50 and last 50 chars plus length as key
		const prefix = text.substring(0, 50)
		const suffix = text.substring(text.length - 50)
		return `${prefix}|${text.length}|${suffix}`
	}

	/**
	 * Maintain the token cache size
	 */
	private maintainCacheSize(): void {
		if (this.tokenCountCache.size >= this.TOKEN_CACHE_MAX_SIZE) {
			// Remove oldest entries (first 20% of entries)
			const entriesToRemove = Math.ceil(this.TOKEN_CACHE_MAX_SIZE * 0.2)
			const keys = Array.from(this.tokenCountCache.keys()).slice(0, entriesToRemove)
			keys.forEach((key) => this.tokenCountCache.delete(key))
		}
	}

	/**
	 * Calculate total input tokens with optimized batching
	 */
	private async calculateTotalInputTokens(
		systemPrompt: string,
		messages: vscode.LanguageModelChatMessage[],
	): Promise<number> {
		this.outputChannel.appendLine("Calculating input tokens")

		// Combine messages into batches to reduce API calls
		const batchSize = 5 // Process messages in batches of 5
		let totalTokens = 0

		try {
			// Count system prompt tokens
			totalTokens += await this.countTokens(systemPrompt)

			// Process messages in batches
			for (let i = 0; i < messages.length; i += batchSize) {
				const batch = messages.slice(i, i + batchSize)

				// Combine batch into a single string for token counting
				const batchText = batch
					.map((msg) => {
						if (typeof msg.content === "string") {
							return `${msg.role}: ${msg.content}`
						} else {
							return `${msg.role}: [Complex content]`
						}
					})
					.join("\n\n")

				// Count tokens for the batch
				const batchTokens = await this.countTokens(batchText)
				totalTokens += batchTokens

				this.outputChannel.appendLine(`Batch ${i / batchSize + 1} tokens: ${batchTokens}`)
			}

			this.outputChannel.appendLine(`Total input tokens: ${totalTokens}`)
			return totalTokens
		} catch (error) {
			this.outputChannel.appendLine(
				`Token calculation error: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			// Fallback to a simple estimation
			const totalText =
				systemPrompt +
				messages.map((m) => (typeof m.content === "string" ? m.content : "[Complex content]")).join(" ")
			return Math.ceil(totalText.length / 4)
		}
	}

	private ensureCleanState(): void {
		if (this.currentRequestCancellation) {
			this.log("Cancelling current request")
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
			this.currentRequestCancellation = null
		}
	}

	private async getClient(): Promise<vscode.LanguageModelChat> {
		// Get the selector from options
		const selector = this.options?.vsCodeLmModelSelector || {}

		try {
			// Check if we need to create a new client
			if (!this.client) {
				this.log("Client not initialized, creating new client")
				this.client = await this.createClient(selector)
				return this.client
			}

			// Check if the model selector has changed
			if (this.cachedModelSelector && !this.areSelectorsEqual(selector, this.cachedModelSelector)) {
				this.log("Model selector changed, creating new client")
				this.log(`Previous: ${JSON.stringify(this.cachedModelSelector)}`)
				this.log(`New: ${JSON.stringify(selector)}`)

				// Clean up existing client if needed
				this.ensureCleanState()

				// Create new client with updated selector
				this.client = await this.createClient(selector)
			} else {
				this.log(`Using existing client: ${this.client.name} (${this.client.id})`)
			}

			return this.client
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error"
			this.log(`Client creation failed: ${message}`)
			throw new Error(`Roo Code <Language Model API>: Failed to create client: ${message}`)
		}
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

	/**
	 * Memoized message content cleaning
	 */
	private cleanContentCache = new Map<string, any>()
	private readonly CLEAN_CACHE_MAX_SIZE = 50

	private cleanMessageContent(content: any): any {
		// Handle primitive types directly
		if (content === null || content === undefined || typeof content !== "object") {
			if (typeof content === "string") {
				return this.cleanTerminalOutput(content)
			}
			return content
		}

		// For objects and arrays, try to use cache
		const contentKey = this.getContentCacheKey(content)
		if (contentKey && this.cleanContentCache.has(contentKey)) {
			return this.cleanContentCache.get(contentKey)
		}

		let result: any

		if (Array.isArray(content)) {
			result = content.map((item) => this.cleanMessageContent(item))
		} else if (typeof content === "object") {
			result = {}
			for (const [key, value] of Object.entries(content)) {
				result[key] = this.cleanMessageContent(value)
			}
		} else {
			result = content
		}

		// Cache the result for complex objects
		if (contentKey) {
			this.maintainCleanCacheSize()
			this.cleanContentCache.set(contentKey, result)
		}

		return result
	}

	/**
	 * Generate a cache key for content cleaning
	 */
	private getContentCacheKey(content: any): string | null {
		try {
			// Only cache objects and arrays
			if (typeof content !== "object" || content === null) {
				return null
			}

			// For small objects, use full JSON
			const json = JSON.stringify(content)
			if (json.length < 200) {
				return json
			}

			// For larger objects, use a hash of the structure
			// This is a simple hash that considers object keys and array lengths
			if (Array.isArray(content)) {
				return `array:${content.length}:${Object.keys(content).length}`
			} else {
				const keys = Object.keys(content).sort().join(",")
				return `object:${keys}:${JSON.stringify(content).length}`
			}
		} catch (error) {
			// If we can't generate a key, don't cache
			return null
		}
	}

	/**
	 * Maintain the clean content cache size
	 */
	private maintainCleanCacheSize(): void {
		if (this.cleanContentCache.size >= this.CLEAN_CACHE_MAX_SIZE) {
			// Remove oldest entries
			const entriesToRemove = Math.ceil(this.CLEAN_CACHE_MAX_SIZE * 0.2)
			const keys = Array.from(this.cleanContentCache.keys()).slice(0, entriesToRemove)
			keys.forEach((key) => this.cleanContentCache.delete(key))
		}
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		// Ensure clean state before starting a new request
		this.ensureCleanState()
		this.logInfo("Starting new message creation")
		this.log("System prompt length: " + systemPrompt.length)

		const client: vscode.LanguageModelChat = await this.getClient()
		this.logInfo(`Using client: ${client.name} (${client.id}) from ${client.vendor}`)

		// Clean system prompt and messages
		const cleanedSystemPrompt = this.cleanTerminalOutput(systemPrompt)
		this.log("System prompt cleaned")

		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))
		this.log(`Cleaned ${cleanedMessages.length} messages`)

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(cleanedSystemPrompt),
			...convertToVsCodeLmMessages(cleanedMessages),
		]
		this.log(`Converted ${vsCodeLmMessages.length} messages for VS Code LM API`)

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(systemPrompt, vsCodeLmMessages)
		this.logInfo(`Total input tokens: ${totalInputTokens}`)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with minimal required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Roo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}

			this.logInfo("Sending request to VS Code LM API")

			// Note: Tool support is currently provided by the VSCode Language Model API directly
			// Extensions can register tools using vscode.lm.registerTool()

			const response: vscode.LanguageModelChatResponse = await client.sendRequest(
				vsCodeLmMessages,
				requestOptions,
				this.currentRequestCancellation.token,
			)

			this.logInfo("Received response, processing stream")

			// Consume the stream and handle both text and tool call chunks
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					// Validate text part value
					if (typeof chunk.value !== "string") {
						this.logError("Invalid text part value received: " + JSON.stringify(chunk.value))
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
							this.logError("Invalid tool name received: " + JSON.stringify(chunk.name))
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							this.logError("Invalid tool callId received: " + JSON.stringify(chunk.callId))
							continue
						}

						// Ensure input is a valid object
						if (!chunk.input || typeof chunk.input !== "object") {
							this.logError("Invalid tool input received: " + JSON.stringify(chunk.input))
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
						this.log("Processing tool call: " + chunk.name)

						yield {
							type: "text",
							text: toolCallText,
						}
					} catch (error) {
						this.logError("Failed to process tool call: " + error)
						// Continue processing other chunks even if one fails
						continue
					}
				} else {
					this.logError("Unknown chunk type received: " + JSON.stringify(chunk))
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.countTokens(accumulatedText)
			this.logInfo(`Response complete. Output tokens: ${totalOutputTokens}`)

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
				this.logInfo("Request cancelled by user")
				throw new Error("Roo Code <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				this.logError(`Stream error: ${error.message}`)
				this.log(`Error stack: ${error.stack}`)

				// Return original error if it's already an Error instance
				throw error
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				this.logError(`Stream error object: ${errorDetails}`)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				this.logError(`Unknown stream error: ${errorMessage}`)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorMessage}`)
			}
		}
	}

	/**
	 * Cache for model information
	 */
	private modelInfoCache: Map<string, { id: string; info: ModelInfo }> = new Map()

	/**
	 * Get model information with caching
	 */
	getModel(): { id: string; info: ModelInfo } {
		this.log("Getting model information")

		// If we have a client, try to get model info
		if (this.client) {
			// Generate a cache key based on client properties
			const cacheKey =
				this.client.id ||
				[this.client.vendor, this.client.family, this.client.version].filter(Boolean).join(SELECTOR_SEPARATOR)

			// Check if we have cached info for this model
			if (this.modelInfoCache.has(cacheKey)) {
				this.log(`Using cached model info for ${cacheKey}`)
				return this.modelInfoCache.get(cacheKey)!
			}

			// Log client properties for debugging
			for (const prop of ["id", "name", "vendor", "family", "version", "maxInputTokens"]) {
				const value = (this.client as any)[prop]
				if (!value && value !== 0) {
					this.log(`Warning: Client missing ${prop} property`)
				}
			}

			// Construct model ID using available information
			const modelParts = [this.client.vendor, this.client.family, this.client.version].filter(Boolean)
			this.log(`Model parts: ${modelParts.join(", ")}`)

			const modelId = this.client.id || modelParts.join(SELECTOR_SEPARATOR)
			this.log(`Using model ID: ${modelId}`)

			// Build model info with conservative defaults for missing values
			const modelInfo: ModelInfo = {
				maxTokens: -1, // Unlimited tokens by default
				contextWindow:
					typeof this.client.maxInputTokens === "number"
						? Math.max(0, this.client.maxInputTokens)
						: openAiModelInfoSaneDefaults.contextWindow,
				supportsImages: false,
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
				description: `VSCode Language Model: ${modelId}`,
			}

			this.log(`Generated model info with context window: ${modelInfo.contextWindow}`)

			// Cache the model info
			const result = { id: modelId, info: modelInfo }
			this.modelInfoCache.set(cacheKey, result)

			return result
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: "vscode-lm"

		this.log(`No client available, using fallback ID: ${fallbackId}`)

		const fallbackResult = {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}

		return fallbackResult
	}

	async completePrompt(prompt: string): Promise<string> {
		this.log(`Starting prompt completion: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`)

		try {
			const client = await this.getClient()
			this.log(`Using client: ${client.name} (${client.id}) from ${client.vendor}`)

			const response = await client.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{},
				new vscode.CancellationTokenSource().token,
			)

			this.log("Received response, processing stream")
			let result = ""
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					result += chunk.value
				}
			}

			this.log(`Completion successful, received ${result.length} characters`)
			return result
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.log(`Completion failed: ${errorMessage}`)
			throw new Error(`VSCode LM completion error: ${errorMessage}`)
		}
	}

	/**
	 * Compare two model selectors to determine if they're equivalent
	 */
	private areSelectorsEqual(
		selector1: vscode.LanguageModelChatSelector,
		selector2: vscode.LanguageModelChatSelector,
	): boolean {
		// Compare the stringified versions for deep equality
		return JSON.stringify(selector1) === JSON.stringify(selector2)
	}

	/**
	 * Forces a refresh of the model cache, useful when VS Code's available models might have changed
	 */
	async refreshModelCache(): Promise<vscode.LanguageModelChat> {
		this.log("Explicitly refreshing model cache")

		// Clear the cached model
		this.cachedModel = null
		this.cachedModelSelector = null

		// Get the current selector
		const selector = this.options?.vsCodeLmModelSelector || {}

		try {
			// Check if the requested model is available
			const isModelAvailable = await this.isModelAvailable(selector)

			if (!isModelAvailable) {
				this.logWarning(`Requested model with selector ${JSON.stringify(selector)} is not available`)

				// Try to find any available model as fallback
				const anyAvailableModels = await vscode.lm.selectChatModels({})

				if (anyAvailableModels && anyAvailableModels.length > 0) {
					this.logInfo(`Found alternative model: ${anyAvailableModels[0].name}`)

					// Update the selector to use the first available model
					const fallbackSelector = {
						vendor: anyAvailableModels[0].vendor,
						family: anyAvailableModels[0].family,
					}

					// Create new client with fallback selector
					this.client = await this.createClient(fallbackSelector)
					this.logInfo(
						`Using fallback model: ${this.client.name} (${this.client.id}) from ${this.client.vendor}`,
					)
					return this.client
				}
			}

			// Force a new client creation with the original selector
			this.client = await this.createClient(selector)
			this.logInfo(`Refreshed model: ${this.client.name} (${this.client.id}) from ${this.client.vendor}`)

			return this.client
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.logError(`Failed to refresh model cache: ${errorMessage}`)

			// Create a default client as fallback
			this.client = await this.createClient({})
			return this.client
		}
	}

	/**
	 * Standardized error handling
	 */
	private handleError(error: unknown, context: string): Error {
		// Clean up state
		this.ensureCleanState()

		// Format error message
		let errorMessage: string
		let errorDetails: string = ""

		if (error instanceof vscode.CancellationError) {
			errorMessage = "Request cancelled by user"
		} else if (error instanceof Error) {
			errorMessage = error.message
			errorDetails = `\nStack: ${error.stack || "No stack trace"}\nName: ${error.name}`
		} else if (typeof error === "object" && error !== null) {
			try {
				errorMessage = JSON.stringify(error)
			} catch {
				errorMessage = "Unknown object error"
			}
		} else if (typeof error === "string") {
			errorMessage = error
		} else {
			errorMessage = "Unknown error"
		}

		// Log the error
		this.log(`Error in ${context}: ${errorMessage}${errorDetails}`)

		// Return a standardized error
		return new Error(`Roo Code <Language Model API>: ${context} - ${errorMessage}`)
	}

	/**
	 * Checks if a model matching the given selector is available
	 * @returns True if at least one matching model is available
	 */
	async isModelAvailable(selector: vscode.LanguageModelChatSelector): Promise<boolean> {
		try {
			const models = await vscode.lm.selectChatModels(selector)
			return models && Array.isArray(models) && models.length > 0
		} catch (error) {
			this.logError(
				`Error checking model availability: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return false
		}
	}

	/**
	 * Gets all available VS Code language models
	 * @returns Array of available language models with their metadata
	 */
	async getAvailableModels(): Promise<
		Array<{
			id: string
			name: string
			vendor: string
			family: string
			version?: string
		}>
	> {
		try {
			const models = await vscode.lm.selectChatModels({})

			// Map to a simpler format with just the essential properties
			return models.map((model) => ({
				id: model.id,
				name: model.name,
				vendor: model.vendor,
				family: model.family,
				version: model.version,
			}))
		} catch (error) {
			this.logError(`Failed to get available models: ${error instanceof Error ? error.message : "Unknown error"}`)
			return []
		}
	}

	/**
	 * Start periodic checking of model availability
	 */
	startModelAvailabilityCheck(intervalMs: number = 60000): void {
		// Clear any existing interval
		this.stopModelAvailabilityCheck()

		// Set up new interval
		this.modelCheckInterval = setInterval(async () => {
			if (!this.client || !this.cachedModelSelector) return

			try {
				const isAvailable = await this.isModelAvailable(this.cachedModelSelector)
				if (!isAvailable) {
					this.logWarning(`Model ${this.client.id} is no longer available, refreshing`)
					await this.refreshModelCache()
				}
			} catch (error) {
				this.logError(
					`Error in model availability check: ${error instanceof Error ? error.message : "Unknown error"}`,
				)
			}
		}, intervalMs)
	}

	/**
	 * Stop periodic checking of model availability
	 */
	stopModelAvailabilityCheck(): void {
		if (this.modelCheckInterval) {
			clearInterval(this.modelCheckInterval)
			this.modelCheckInterval = undefined
		}
	}
}
