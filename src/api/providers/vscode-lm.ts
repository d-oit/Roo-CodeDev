import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import { ApiHandler, SingleCompletionHandler } from "../"
import { ApiStream } from "../transform/stream"
import { convertToVsCodeLmMessages } from "../transform/vscode-lm-format"
import { SELECTOR_SEPARATOR } from "../../shared/vsCodeSelectorUtils"
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
	private outputChannel!: vscode.OutputChannel
	private cachedModelSelector: vscode.LanguageModelChatSelector | null = null
	private cachedModel: vscode.LanguageModelChat | null = null
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private enableDebugOutput: boolean = false
	private modelCheckInterval: NodeJS.Timeout | undefined
	private logConversations: boolean = false

	/**
	 * Optimized logging with debouncing
	 */
	private logQueue: string[] = []
	private logTimeout: NodeJS.Timeout | null = null
	private readonly LOG_DEBOUNCE_MS = 100
	private readonly LOG_BATCH_SIZE = 10

	/**
	 * Cache for token counting
	 */
	private tokenCountCache = new Map<string, number>()
	private readonly TOKEN_CACHE_MAX_SIZE = 100
	private tokenCacheAccessTimes = new Map<string, number>()

	/**
	 * Cache for model information
	 */
	private modelInfoCache: Map<string, { id: string; info: ModelInfo }> = new Map()
	private modelInfoCacheAccessTimes: Map<string, number> = new Map()
	private readonly MODEL_CACHE_MAX_SIZE = 20 // Reasonable limit for model cache

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = null

		// Get debug configuration
		const config = vscode.workspace.getConfiguration("roo-cline")
		this.enableDebugOutput = config.get<boolean>("debug.vscode-lm", false)
		this.logConversations = config.get<boolean>("debug.vscode-lm-conversation", false)

		// Only create and use the output channel if debugging or conversation logging is enabled
		if (this.enableDebugOutput || this.logConversations) {
			// Use shared output channel if it exists, otherwise create a new one
			if (!VsCodeLmHandler.sharedOutputChannel) {
				VsCodeLmHandler.sharedOutputChannel = vscode.window.createOutputChannel("Roo Code VS Code LM")
			}
			this.outputChannel = VsCodeLmHandler.sharedOutputChannel

			this.logInfo("VS Code LM Handler initialized")
			this.logInfo(`Debug output ${this.enableDebugOutput ? "enabled" : "disabled"}`)
			this.logInfo(`Conversation logging ${this.logConversations ? "enabled" : "disabled"}`)

			// Add this verification log
			if (this.logConversations) {
				this.logInfo("Conversation logging is active - messages will be logged to output channel")
			}
		}

		try {
			// Listen for model changes and reset client
			this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("lm")) {
					try {
						this.client = null
						this.ensureCleanState()
						if (this.enableDebugOutput || this.logConversations) {
							this.logInfo("Configuration changed, client reset")
						}
					} catch (error) {
						console.error("Error during configuration change cleanup:", error)
						if (this.enableDebugOutput || this.logConversations) {
							this.logError(`Error during configuration change cleanup: ${error}`)
						}
					}
				}

				// Update debug settings if they change
				if (
					event.affectsConfiguration("roo-cline.debug.vscode-lm") ||
					event.affectsConfiguration("roo-cline.debug.vscode-lm-conversation")
				) {
					const config = vscode.workspace.getConfiguration("roo-cline")
					const previousDebugEnabled = this.enableDebugOutput
					const previousConversationLoggingEnabled = this.logConversations

					this.enableDebugOutput = config.get<boolean>("debug.vscode-lm", false)
					this.logConversations = config.get<boolean>("debug.vscode-lm-conversation", false)

					// Create output channel if it doesn't exist and either debug option is now enabled
					if (
						(this.enableDebugOutput || this.logConversations) &&
						!previousDebugEnabled &&
						!previousConversationLoggingEnabled
					) {
						if (!VsCodeLmHandler.sharedOutputChannel) {
							VsCodeLmHandler.sharedOutputChannel =
								vscode.window.createOutputChannel("Roo Code VS Code LM")
						}
						this.outputChannel = VsCodeLmHandler.sharedOutputChannel
					}

					if (this.enableDebugOutput || this.logConversations) {
						this.logInfo(`Debug output ${this.enableDebugOutput ? "enabled" : "disabled"}`)
						this.logInfo(`Conversation logging ${this.logConversations ? "enabled" : "disabled"}`)
					}
				}
			})
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()

			const errorMessage = `Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`
			if (this.enableDebugOutput || this.logConversations) {
				this.logError(errorMessage)
			}
			throw new Error(`Roo Code <Language Model API>: ${errorMessage}`)
		}
	}

	/**
	 * Log a message to the output channel with debouncing
	 */
	private log(message: string): void {
		if (!this.enableDebugOutput || !this.outputChannel) return

		this.logQueue.push(message)

		// If we've reached the batch size, flush immediately
		if (this.logQueue.length >= this.LOG_BATCH_SIZE) {
			this.flushLogs()
			return
		}

		// Otherwise, set up a debounced flush
		if (!this.logTimeout) {
			this.logTimeout = setTimeout(() => {
				this.flushLogs()
			}, this.LOG_DEBOUNCE_MS)
		}
	}

	/**
	 * Flush queued logs to the output channel
	 */
	private flushLogs(): void {
		if (this.logQueue.length === 0 || !this.outputChannel) {
			return
		}

		// Join all queued messages with newlines and append to output channel
		const message = this.logQueue.join("\n")
		this.outputChannel.appendLine(message)

		// Clear the queue and timeout
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
		if (!this.outputChannel) return

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
		if (!this.outputChannel) return

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
		// Skip logging if debug output is disabled or output channel doesn't exist
		if (!this.enableDebugOutput || !this.outputChannel) {
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
		if (!this.outputChannel) return

		// Add timestamp to message
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] WARNING: ${message}`

		// Log directly to output channel
		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Log a detailed message with request/response information
	 */
	private logRequestDetails(stage: "start" | "progress" | "complete" | "error", details: Record<string, any>): void {
		// Skip if debug output is disabled or output channel doesn't exist
		if (!this.enableDebugOutput || !this.outputChannel) {
			return
		}

		// Add timestamp to message
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] REQUEST ${stage.toUpperCase()}: ${JSON.stringify(details, null, 2)}`

		// Log directly to output channel
		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Log performance metrics to the output channel
	 */
	private logPerformance(operation: string, startTime: number): void {
		if (!this.outputChannel) return

		const endTime = Date.now()
		const duration = endTime - startTime

		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		const formattedMessage = `[${timestamp}] PERFORMANCE: ${operation} completed in ${duration}ms`

		this.outputChannel.appendLine(formattedMessage)
	}

	/**
	 * Log model selection information
	 */
	private logModelSelection(selectedModel: any, availableModels: any[]): void {
		if (!this.outputChannel) return

		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)

		// Log the selected model
		this.outputChannel.appendLine(
			`[${timestamp}] MODEL SELECTION: Selected ${selectedModel.name || selectedModel.id}`,
		)

		// Log available models summary
		const modelsSummary = availableModels.map((m) => `${m.name || m.id} (${m.vendor})`).join(", ")
		this.outputChannel.appendLine(`[${timestamp}] AVAILABLE MODELS: ${modelsSummary}`)
	}

	/**
	 * Creates a new VS Code Language Model client with the specified selector
	 */
	private async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		try {
			// Get all available models
			const availableModels = await this.getAvailableModels()
			this.logInfo(`Found ${availableModels.length} available models`)

			// Log detailed information about all available models
			this.logInfo("=== Available Models Information ===")
			for (const model of availableModels) {
				this.logInfo(`Model: ${model.name} (${model.id})`)
				this.logInfo(`  Vendor: ${model.vendor}`)
				this.logInfo(`  Family: ${model.family}`)
			}

			// Find the best matching model
			const bestMatch = await this.findBestMatchingModel(selector, availableModels)

			// If a matching model is found, use it
			if (bestMatch) {
				// Get the actual model instance from VS Code API
				const models = await vscode.lm.selectChatModels({
					vendor: bestMatch.vendor,
					family: bestMatch.family,
					version: bestMatch.version,
					id: bestMatch.id,
				})

				if (models && Array.isArray(models) && models.length > 0) {
					const model = models[0]
					this.logInfo(`Selected model: ${model.name} (${model.id}) from ${model.vendor}`)

					// Log the maxInputTokens for the selected model
					try {
						const capabilities = await this.getModelCapabilities(model)
						this.logInfo(`Selected model max input tokens: ${capabilities.maxInputTokens || "Unknown"}`)
						this.logInfo(`Selected model max output tokens: ${capabilities.maxOutputTokens || "Unknown"}`)
					} catch (error) {
						this.logInfo(
							`Failed to get selected model capabilities: ${error instanceof Error ? error.message : "Unknown error"}`,
						)
					}

					// Cache the model and selector
					this.cachedModel = model
					this.cachedModelSelector = { ...selector }

					return model
				}
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

		// Clear all caches
		this.tokenCountCache.clear()
		this.tokenCacheAccessTimes.clear()
		this.modelInfoCache.clear()
		this.modelInfoCacheAccessTimes.clear()

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
	private async countTokens(text: string): Promise<number> {
		// For very short texts, use a simple estimation to avoid API calls
		if (!text || text.length === 0) {
			return 0
		}

		if (text.length < 4) {
			return 1
		}

		// Check cache first
		const cacheKey = this.generateCacheKey(text)
		if (this.tokenCountCache.has(cacheKey)) {
			// Update access time for this key (for better LRU implementation)
			this.tokenCacheAccessTimes.set(cacheKey, Date.now())
			this.log(`Using cached token count for text of length ${text.length}`)
			return this.tokenCountCache.get(cacheKey) || 0
		}

		try {
			const client = await this.getClient()
			const count = await client.countTokens(text)

			// Cache the result
			this.maintainCacheSize()
			this.tokenCountCache.set(cacheKey, count)
			this.tokenCacheAccessTimes.set(cacheKey, Date.now())

			return count
		} catch (error) {
			this.log(`Token counting failed: ${error instanceof Error ? error.message : "Unknown error"}`)
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
	 * Maintain the token cache size using a true LRU approach
	 */
	private maintainCacheSize(): void {
		if (this.tokenCountCache.size >= this.TOKEN_CACHE_MAX_SIZE) {
			// Find the least recently used entries
			const entries = Array.from(this.tokenCacheAccessTimes.entries()).sort((a, b) => a[1] - b[1]) // Sort by timestamp (oldest first)

			// Remove oldest 20% of entries
			const entriesToRemove = Math.ceil(this.TOKEN_CACHE_MAX_SIZE * 0.2)
			const keysToRemove = entries.slice(0, entriesToRemove).map((entry) => entry[0])

			keysToRemove.forEach((key) => {
				this.tokenCountCache.delete(key)
				this.tokenCacheAccessTimes.delete(key)
			})

			this.log(`Removed ${keysToRemove.length} oldest entries from token cache`)
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

	/**
	 * Gets or creates a VS Code Language Model client
	 */
	private async getClient(): Promise<vscode.LanguageModelChat> {
		try {
			// If we have a cached client and it exactly matches the current selector, use it
			if (
				this.cachedModel &&
				this.cachedModelSelector &&
				this.options.vsCodeLmModelSelector &&
				this.areSelectorsEqual(this.cachedModelSelector, this.options.vsCodeLmModelSelector)
			) {
				this.logInfo("Using cached client (exact selector match)")
				return this.cachedModel
			}

			// If we have a cached client and it partially matches the current selector, use it
			if (
				this.cachedModel &&
				this.cachedModelSelector &&
				this.options.vsCodeLmModelSelector &&
				this.areSelectorsPartialMatch(this.cachedModelSelector, this.options.vsCodeLmModelSelector)
			) {
				this.logInfo("Using cached client (partial selector match)")
				return this.cachedModel
			}

			// Get the model selector from options
			const selector = this.options.vsCodeLmModelSelector || {}
			this.logInfo(`Getting client with selector: ${JSON.stringify(selector)}`)

			// Cache the selector for future comparisons
			this.cachedModelSelector = { ...selector }

			// Create a new client
			this.client = await this.createClient(selector)

			// Log the maxInputTokens for the new client
			try {
				const capabilities = await this.getModelCapabilities(this.client)
				this.logInfo(`New client created with max input tokens: ${capabilities.maxInputTokens || "Unknown"}`)
			} catch (error) {
				this.logInfo(
					`Failed to get new client capabilities: ${error instanceof Error ? error.message : "Unknown error"}`,
				)
			}

			return this.client
		} catch (error) {
			throw this.handleError(error, "Get client")
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

		// Log system prompt if conversation logging is enabled
		if (this.logConversations) {
			this.logConversationMessage("system", systemPrompt)
		}

		const startTime = Date.now()

		// Log request details
		this.logRequestDetails("start", {
			systemPromptLength: systemPrompt.length,
			messagesCount: messages.length,
			messageTypes: messages.map((m) => m.role),
		})

		const client: vscode.LanguageModelChat = await this.getClient()
		this.logInfo(`Using client: ${client.name} (${client.id}) from ${client.vendor}`)

		// Clean system prompt
		const cleanedSystemPrompt = this.cleanTerminalOutput(systemPrompt)
		this.log("System prompt cleaned")

		// Create a cancellation token source for this request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		try {
			// Create a system message
			const systemMessage: Anthropic.Messages.MessageParam = {
				role: "user",
				content: cleanedSystemPrompt,
			}

			// Combine system message with conversation messages
			const allMessages = [systemMessage, ...messages]

			// Convert all messages to VS Code LM format using the dedicated function
			const vsCodeMessages = convertToVsCodeLmMessages(allMessages)

			// Log the complete messages to the output channel
			this.logInfo("=== COMPLETE CONVERSATION ===")
			for (const msg of vsCodeMessages) {
				// Convert the role enum to a string representation
				const roleString = vscode.LanguageModelChatMessageRole[msg.role] || String(msg.role)
				this.logInfo(`--- ${roleString.toUpperCase()} MESSAGE ---`)

				if (typeof msg.content === "string") {
					this.logInfo(msg.content)
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part instanceof vscode.LanguageModelTextPart) {
							this.logInfo(`[TEXT]: ${part.value}`)
						} else if (part instanceof vscode.LanguageModelToolCallPart) {
							this.logInfo(`[TOOL CALL]: ${part.name} (ID: ${part.callId})`)
							this.logInfo(`Input: ${JSON.stringify(part.input, null, 2)}`)
						} else if (part instanceof vscode.LanguageModelToolResultPart) {
							// Use safe property access with optional chaining
							const id = (part as any).toolCallId || (part as any).toolUseId || "unknown"
							this.logInfo(`[TOOL RESULT]: (ID: ${id})`)

							try {
								// Log the complete part for debugging
								this.logInfo(`Tool result part structure: ${JSON.stringify(Object.keys(part))}`)

								// Try different property access patterns
								if (typeof part.content === "string") {
									this.logInfo(`  Result content: ${part.content}`)
								} else if (Array.isArray(part.content)) {
									for (const contentPart of part.content) {
										if (contentPart instanceof vscode.LanguageModelTextPart) {
											this.logInfo(`  Result text: ${contentPart.value}`)
										} else {
											this.logInfo(`  Unknown content part: ${JSON.stringify(contentPart)}`)
										}
									}
								} else {
									this.logInfo(`  Result: ${JSON.stringify(part)}`)
								}
							} catch (error) {
								this.logInfo(`Error accessing tool result properties: ${error}`)
								this.logInfo(`Full tool result part: ${JSON.stringify(part)}`)
							}
						} else {
							this.logInfo(`[UNKNOWN PART]: ${JSON.stringify(part)}`)
						}
					}
				}
			}
			this.logInfo("=== END CONVERSATION ===")

			// Estimate token counts for logging
			const estimatedTokens = await this.calculateTotalInputTokens(cleanedSystemPrompt, vsCodeMessages)
			this.log(`Calculated input tokens: ${estimatedTokens}`)

			// Log progress
			this.logRequestDetails("progress", {
				estimatedInputTokens: estimatedTokens,
				messagesConverted: true,
				startingStream: true,
			})

			// Start the response stream
			const responseStream = await client.sendRequest(
				vsCodeMessages,
				{}, // Empty options object
				this.currentRequestCancellation.token, // Pass token as third parameter
			)

			// Process the response stream
			let fullResponse = ""
			const chunks: string[] = []

			for await (const part of responseStream.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					const content = part.value
					chunks.push(content)
					fullResponse += content

					// Yield the text chunk
					yield {
						type: "text",
						text: content,
					}
				}
			}

			// Log the complete response
			this.logInfo("=== COMPLETE RESPONSE ===")
			this.logInfo(fullResponse)
			this.logInfo("=== END RESPONSE ===")

			// Count output tokens
			const outputTokens = await this.countTokens(fullResponse)
			this.log(`Final output tokens: ${outputTokens}`)

			// Log completion details
			this.logRequestDetails("complete", {
				totalChunks: chunks.length,
				outputTokens: outputTokens,
				inputTokens: estimatedTokens,
				responseLength: fullResponse.length,
				durationMs: Date.now() - startTime,
			})

			// Log performance metrics
			this.logPerformance("Message creation", startTime)

			// Yield the final token usage
			yield {
				type: "usage",
				inputTokens: estimatedTokens,
				outputTokens: outputTokens,
			}

			// Clear the request state
			this.currentRequestCancellation = null
		} catch (error) {
			this.logError(`Error in createMessage: ${error instanceof Error ? error.message : "Unknown error"}`)

			// Log detailed error information
			this.logRequestDetails("error", {
				error: error instanceof Error ? error.message : "Unknown error",
				stack: error instanceof Error ? error.stack : undefined,
				durationMs: Date.now() - startTime,
			})

			this.ensureCleanState()
			throw error
		} finally {
			// Ensure logs are flushed
			this.flushLogs()
		}
	}

	/**
	 * Get model information with caching and cache management
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
				// Update access timestamp for LRU tracking
				this.modelInfoCacheAccessTimes.set(cacheKey, Date.now())
				return this.modelInfoCache.get(cacheKey)!
			}

			// Log client properties for debugging
			const clientProps: Record<string, any> = {}
			for (const prop of ["id", "name", "vendor", "family", "version", "maxInputTokens"]) {
				const value = (this.client as any)[prop]
				clientProps[prop] = value
				if (!value && value !== 0) {
					this.log(`Warning: Client missing ${prop} property`)
				}
			}

			// Log detailed client information
			this.logRequestDetails("progress", {
				operation: "getModel",
				clientProperties: clientProps,
			})

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

			// Log detailed model information
			this.outputChannel.appendLine(
				JSON.stringify(
					{
						modelId,
						modelInfo,
						cacheKey,
					},
					null,
					2,
				),
			)

			// Manage cache size before adding new entry
			this.maintainModelCacheSize()

			// Cache the model info
			const result = { id: modelId, info: modelInfo }
			this.modelInfoCache.set(cacheKey, result)
			this.modelInfoCacheAccessTimes.set(cacheKey, Date.now())

			return result
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? this.stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: "vscode-lm"

		this.log(`No client available, using fallback ID: ${fallbackId}`)

		// Log fallback information
		this.logRequestDetails("progress", {
			operation: "getModel",
			status: "fallback",
			fallbackId,
			reason: "No client available",
		})

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
			throw this.handleError(error, "Completion")
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
		const startTime = Date.now()

		// Clear the cached model
		this.cachedModel = null
		this.cachedModelSelector = null

		// Get the current selector
		const selector = this.options?.vsCodeLmModelSelector || {}

		// Log refresh start
		this.logRequestDetails("start", {
			operation: "refreshModelCache",
			selector: JSON.stringify(selector),
		})

		try {
			// Get all available models
			const availableModels = await this.getAvailableModels()

			// Log available models
			this.logRequestDetails("progress", {
				operation: "refreshModelCache",
				availableModelsCount: availableModels.length,
				availableModels: availableModels.map((m) => ({
					id: m.id,
					name: m.name,
					vendor: m.vendor,
					family: m.family,
					version: m.version,
				})),
			})

			// Find the best matching model for the current selector
			const bestMatch = await this.findBestMatchingModel(selector, availableModels)

			if (bestMatch) {
				// Log the selected model
				this.logModelSelection(bestMatch, availableModels)

				// Create a client with the best matching model
				this.client = await this.createClient({
					vendor: bestMatch.vendor,
					family: bestMatch.family,
					version: bestMatch.version,
					id: bestMatch.id,
				})

				this.logInfo(`Using model: ${this.client.name} (${this.client.id}) from ${this.client.vendor}`)

				// Log success
				this.logRequestDetails("complete", {
					operation: "refreshModelCache",
					status: "success",
					selectedModel: {
						id: this.client.id,
						name: this.client.name,
						vendor: this.client.vendor,
						family: this.client.family,
						version: this.client.version,
					},
					durationMs: Date.now() - startTime,
				})

				// Log performance
				this.logPerformance("Model cache refresh", startTime)

				return this.client
			}

			// If no matching model found, try to find any available model as fallback
			if (availableModels.length > 0) {
				this.logInfo(`No model matching selector ${JSON.stringify(selector)}, using alternative model`)

				// Use the first available model
				const fallbackModel = availableModels[0]
				this.logInfo(`Found alternative model: ${fallbackModel.name}`)

				// Update the selector to use the first available model
				const fallbackSelector = {
					vendor: fallbackModel.vendor,
					family: fallbackModel.family,
					version: fallbackModel.version,
					id: fallbackModel.id,
				}

				// Log fallback selection
				this.logRequestDetails("progress", {
					operation: "refreshModelCache",
					status: "fallback",
					reason: "No matching model",
					fallbackModel: {
						id: fallbackModel.id,
						name: fallbackModel.name,
						vendor: fallbackModel.vendor,
					},
				})

				// Create new client with fallback selector
				this.client = await this.createClient(fallbackSelector)
				this.logInfo(`Using fallback model: ${this.client.name} (${this.client.id}) from ${this.client.vendor}`)

				// Log performance
				this.logPerformance("Model cache refresh (fallback)", startTime)

				return this.client
			}

			// Force a new client creation with the original selector if no alternatives found
			this.client = await this.createClient(selector)
			return this.client
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.logError(`Failed to refresh model cache: ${errorMessage}`)

			// Try to create a client with empty selector as last resort
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
			// Get all available models first
			const availableModels = await this.getAvailableModels()

			// If no selector is provided, return true if any models are available
			if (!selector || Object.keys(selector).length === 0) {
				return availableModels.length > 0
			}

			// Check if any model matches the selector criteria
			return availableModels.some((model) => {
				// Create a selector from the model
				const modelSelector = {
					vendor: model.vendor,
					family: model.family,
					version: model.version,
					id: model.id,
				}

				// Use areSelectorsEqual for partial matching
				// This would need modification since we want partial matching here
				return this.areSelectorsPartialMatch(selector, modelSelector)
			})
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

	/**
	 * Finds the best matching model based on the selector
	 * @param selector The model selector criteria
	 * @param availableModels Optional list of available models (to avoid redundant API calls)
	 * @returns The best matching model or null if no match found
	 */
	private async findBestMatchingModel(
		selector: vscode.LanguageModelChatSelector,
		availableModels?: Array<{
			id: string
			name: string
			vendor: string
			family: string
			version?: string
		}>,
	): Promise<{
		id: string
		name: string
		vendor: string
		family: string
		version?: string
	} | null> {
		try {
			// Get available models if not provided
			const models = availableModels || (await this.getAvailableModels())

			if (models.length === 0) {
				this.logInfo("No models available")
				return null
			}

			// If no selector is provided, return the first available model
			if (!selector || Object.keys(selector).length === 0) {
				this.logInfo(`No selector provided, using first available model: ${models[0].name}`)
				return models[0]
			}

			// Filter models based on selector criteria
			const matchingModels = models.filter((model) => {
				const vendorMatch = !selector.vendor || model.vendor === selector.vendor
				const familyMatch = !selector.family || model.family === selector.family
				const versionMatch = !selector.version || model.version === selector.version
				const idMatch = !selector.id || model.id === selector.id

				return vendorMatch && familyMatch && versionMatch && idMatch
			})

			if (matchingModels.length === 0) {
				this.logInfo(`No models match selector: ${JSON.stringify(selector)}`)
				return null
			}

			// Return the first matching model
			this.logInfo(`Found ${matchingModels.length} matching models, using: ${matchingModels[0].name}`)
			return matchingModels[0]
		} catch (error) {
			this.logError(
				`Error finding best matching model: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return null
		}
	}

	/**
	 * Suggests alternative models when the requested model is not available
	 * @param selector The original model selector
	 * @returns Array of suggested alternative models
	 */
	async suggestAlternativeModels(selector: vscode.LanguageModelChatSelector): Promise<
		Array<{
			id: string
			name: string
			vendor: string
			family: string
			version?: string
			score: number // Higher score means better match
		}>
	> {
		try {
			const availableModels = await this.getAvailableModels()

			if (availableModels.length === 0) {
				return []
			}

			// Score each model based on how well it matches the selector
			return (
				availableModels
					.map((model) => {
						let score = 0

						// Award points for matching properties
						if (selector.vendor && model.vendor === selector.vendor) score += 3
						if (selector.family && model.family === selector.family) score += 2
						if (selector.version && model.version === selector.version) score += 1
						if (selector.id && model.id === selector.id) score += 4

						return {
							...model,
							score,
						}
					})
					// Sort by score (descending)
					.sort((a, b) => b.score - a.score)
					// Take top 3 suggestions
					.slice(0, 3)
			)
		} catch (error) {
			this.logError(
				`Error suggesting alternative models: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return []
		}
	}

	/**
	 * Check if the response contains a stop token
	 * @param text The text to check for stop tokens
	 * @returns True if a stop token is found
	 */
	private hasStopToken(text: string): boolean {
		// Common stop tokens
		const stopTokens = ["<|end|>", "<|im_end|>", "<|endoftext|>"]
		return stopTokens.some((token) => text.includes(token))
	}

	/**
	 * Process streaming response and check for completion
	 * @param stream The response stream
	 * @param onChunk Callback for each chunk
	 */
	private async processStream(
		stream: AsyncIterableIterator<vscode.LanguageModelChatMessage>,
		onChunk: (chunk: string) => void,
	): Promise<void> {
		try {
			for await (const message of stream) {
				for (const part of message.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						// Use the correct property to access the text content
						// In newer VS Code API, it might be 'value' instead of 'text'
						const content = part.value

						// Log the chunk for debugging
						this.log(`Received chunk: ${content.substring(0, 50)}${content.length > 50 ? "..." : ""}`)

						// Check for stop tokens
						if (this.hasStopToken(content)) {
							this.log("Stop token detected, ending stream")
							// Remove the stop token from the content
							const stopTokens = ["<|end|>", "<|im_end|>", "<|endoftext|>"]
							const cleanedContent = stopTokens.reduce(
								(text: string, token: string) => text.replace(token, ""),
								content,
							)
							onChunk(cleanedContent)
							break
						}

						onChunk(content)
					}
				}
			}
		} catch (error) {
			this.logError(`Stream processing error: ${error instanceof Error ? error.message : "Unknown error"}`)
			throw error
		} finally {
			this.log("Stream processing completed")
		}
	}

	/**
	 * Get model capabilities including maxInputTokens
	 * @param model The language model to check
	 * @returns Object containing model capabilities
	 */
	private async getModelCapabilities(model: vscode.LanguageModelChat): Promise<{
		maxInputTokens?: number
		maxOutputTokens?: number
		supportsImages?: boolean
		supportsTools?: boolean
	}> {
		try {
			return {
				maxInputTokens: model.maxInputTokens,
				maxOutputTokens: undefined, // VS Code API doesn't expose this directly
				supportsImages: false, // Default value, could be determined based on model properties
				supportsTools: false, // Default value, could be determined based on model properties
			}
		} catch (error) {
			this.logError(
				`Failed to get model capabilities: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return {}
		}
	}

	/**
	 * Check if selector2 matches all non-empty criteria in selector1
	 * This is useful for partial matching where selector1 contains only the criteria we care about
	 */
	private areSelectorsPartialMatch(
		selector1: vscode.LanguageModelChatSelector,
		selector2: vscode.LanguageModelChatSelector,
	): boolean {
		// Match based on provided selector properties
		const vendorMatch = !selector1.vendor || selector1.vendor === selector2.vendor
		const familyMatch = !selector1.family || selector1.family === selector2.family
		const versionMatch = !selector1.version || selector1.version === selector2.version
		const idMatch = !selector1.id || selector1.id === selector2.id

		return vendorMatch && familyMatch && versionMatch && idMatch
	}

	/**
	 * Stringify a VS Code LM model selector for use as a cache key
	 */
	private stringifyVsCodeLmModelSelector(selector: vscode.LanguageModelChatSelector): string {
		const parts: string[] = []

		if (selector.vendor) parts.push(`vendor:${selector.vendor}`)
		if (selector.family) parts.push(`family:${selector.family}`)
		if (selector.version) parts.push(`version:${selector.version}`)
		if (selector.id) parts.push(`id:${selector.id}`)

		return parts.length > 0 ? parts.join(SELECTOR_SEPARATOR) : "vscode-lm-default"
	}

	/**
	 * Maintain the model info cache size using LRU approach
	 */
	private maintainModelCacheSize(): void {
		if (this.modelInfoCache.size >= this.MODEL_CACHE_MAX_SIZE) {
			// Find the least recently used entries
			const entries = Array.from(this.modelInfoCacheAccessTimes.entries()).sort((a, b) => a[1] - b[1]) // Sort by timestamp (oldest first)

			// Remove oldest 20% of entries
			const entriesToRemove = Math.ceil(this.MODEL_CACHE_MAX_SIZE * 0.2)
			const keysToRemove = entries.slice(0, entriesToRemove).map((entry) => entry[0])

			keysToRemove.forEach((key) => {
				this.modelInfoCache.delete(key)
				this.modelInfoCacheAccessTimes.delete(key)
			})

			this.log(`Removed ${keysToRemove.length} oldest entries from model info cache`)
		}
	}

	/**
	 * Add a dedicated method for conversation logging
	 */
	private logConversationMessage(role: string, content: string): void {
		if (!this.logConversations || !this.outputChannel) return

		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		this.outputChannel.appendLine(`[${timestamp}] CONVERSATION [${role}]: ${content}`)
	}
}
