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

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = null
		this.outputChannel = vscode.window.createOutputChannel("Roo Code VS Code LM")

		try {
			// Listen for model changes and reset client
			this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("lm")) {
					try {
						this.client = null
						this.ensureCleanState()
						this.outputChannel.appendLine("Configuration changed, client reset")
					} catch (error) {
						console.error("Error during configuration change cleanup:", error)
						this.outputChannel.appendLine(`Error during configuration change cleanup: ${error}`)
					}
				}
			})
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()

			const errorMessage = `Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`
			this.outputChannel.appendLine(errorMessage)
			throw new Error(`Roo Code <Language Model API>: ${errorMessage}`)
		}
	}

	/**
	 * Creates a client with the given model selector, using cache when possible
	 */
	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		this.outputChannel.appendLine(`Creating client with selector: ${JSON.stringify(selector)}`)

		try {
			// Check if we can use the cached model
			if (
				this.cachedModel &&
				this.cachedModelSelector &&
				this.areSelectorsEqual(selector, this.cachedModelSelector)
			) {
				this.outputChannel.appendLine(`Using cached model: ${this.cachedModel.name} (${this.cachedModel.id})`)
				return this.cachedModel
			}

			// If no cache or selector changed, get new models
			this.outputChannel.appendLine(`Selecting new models with selector: ${JSON.stringify(selector)}`)
			const models = await vscode.lm.selectChatModels(selector)

			this.outputChannel.appendLine(`Found ${models.length} matching models`)

			// Use first available model or create a minimal model object
			if (models && Array.isArray(models) && models.length > 0) {
				const model = models[0]
				this.outputChannel.appendLine(`Selected model: ${model.name} (${model.id}) from ${model.vendor}`)

				// Cache the model and selector
				this.cachedModel = model
				this.cachedModelSelector = { ...selector }

				return model
			}

			this.outputChannel.appendLine("No matching models found, using default model")
			// Create a minimal model if no models are available
			const defaultModel = {
				id: "default-lm",
				name: "Default Language Model",
				vendor: "vscode",
				family: "lm",
				version: "1.0",
				maxInputTokens: 8192,
				sendRequest: async (messages, options, token) => {
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
			this.outputChannel.appendLine(`Failed to select model: ${errorMessage}`)
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
		this.outputChannel.appendLine("VS Code LM Handler disposed")
		this.outputChannel.dispose()
	}

	private async countTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		// Check for required dependencies
		if (!this.client) {
			this.outputChannel.appendLine("No client available for token counting")
			return 0
		}

		if (!this.currentRequestCancellation) {
			this.outputChannel.appendLine("No cancellation token available for token counting")
			return 0
		}

		// Validate input
		if (!text) {
			this.outputChannel.appendLine("Empty text provided for token counting")
			return 0
		}

		try {
			// Handle different input types
			let tokenCount: number

			if (typeof text === "string") {
				this.outputChannel.appendLine("Counting tokens for string input")
				tokenCount = await this.client.countTokens(text, this.currentRequestCancellation.token)
				this.outputChannel.appendLine(`String token count: ${tokenCount}`)
			} else if (text instanceof vscode.LanguageModelChatMessage) {
				// For chat messages, ensure we have content
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					this.outputChannel.appendLine("Empty chat message content")
					return 0
				}
				this.outputChannel.appendLine("Counting tokens for chat message")
				tokenCount = await this.client.countTokens(text, this.currentRequestCancellation.token)
				this.outputChannel.appendLine(`Chat message token count: ${tokenCount}`)
			} else {
				this.outputChannel.appendLine("Invalid input type for token counting")
				return 0
			}

			// Validate the result
			if (typeof tokenCount !== "number") {
				this.outputChannel.appendLine("Non-numeric token count received")
				return 0
			}

			if (tokenCount < 0) {
				this.outputChannel.appendLine("Negative token count received")
				return 0
			}

			return tokenCount
		} catch (error) {
			// Handle specific error types
			if (error instanceof vscode.CancellationError) {
				this.outputChannel.appendLine("Token counting cancelled by user")
				return 0
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.outputChannel.appendLine(`Token counting failed: ${errorMessage}`)

			// Log additional error details if available
			if (error instanceof Error && error.stack) {
				this.outputChannel.appendLine(`Token counting error stack: ${error.stack}`)
			}

			return 0 // Fallback to prevent stream interruption
		}
	}

	private async calculateTotalInputTokens(
		systemPrompt: string,
		vsCodeLmMessages: vscode.LanguageModelChatMessage[],
	): Promise<number> {
		this.outputChannel.appendLine("Calculating total input tokens")

		const systemTokens: number = await this.countTokens(systemPrompt)
		this.outputChannel.appendLine(`System prompt tokens: ${systemTokens}`)

		const messageTokens: number[] = await Promise.all(vsCodeLmMessages.map((msg) => this.countTokens(msg)))
		const totalMessageTokens = messageTokens.reduce((sum: number, tokens: number): number => sum + tokens, 0)
		this.outputChannel.appendLine(`Message tokens: ${totalMessageTokens}`)

		const total = systemTokens + totalMessageTokens
		this.outputChannel.appendLine(`Total input tokens: ${total}`)
		return total
	}

	private ensureCleanState(): void {
		if (this.currentRequestCancellation) {
			this.outputChannel.appendLine("Cancelling current request")
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
				this.outputChannel.appendLine("Client not initialized, creating new client")
				this.client = await this.createClient(selector)
				return this.client
			}

			// Check if the model selector has changed
			if (this.cachedModelSelector && !this.areSelectorsEqual(selector, this.cachedModelSelector)) {
				this.outputChannel.appendLine("Model selector changed, creating new client")
				this.outputChannel.appendLine(`Previous: ${JSON.stringify(this.cachedModelSelector)}`)
				this.outputChannel.appendLine(`New: ${JSON.stringify(selector)}`)

				// Clean up existing client if needed
				this.ensureCleanState()

				// Create new client with updated selector
				this.client = await this.createClient(selector)
			} else {
				this.outputChannel.appendLine(`Using existing client: ${this.client.name} (${this.client.id})`)
			}

			return this.client
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error"
			this.outputChannel.appendLine(`Client creation failed: ${message}`)
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

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		// Ensure clean state before starting a new request
		this.ensureCleanState()
		this.outputChannel.appendLine("Starting new message creation")

		const client: vscode.LanguageModelChat = await this.getClient()
		this.outputChannel.appendLine(`Using client: ${client.name} (${client.id}) from ${client.vendor}`)

		// Clean system prompt and messages
		const cleanedSystemPrompt = this.cleanTerminalOutput(systemPrompt)
		this.outputChannel.appendLine("System prompt cleaned")

		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))
		this.outputChannel.appendLine(`Cleaned ${cleanedMessages.length} messages`)

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(cleanedSystemPrompt),
			...convertToVsCodeLmMessages(cleanedMessages),
		]
		this.outputChannel.appendLine(`Converted ${vsCodeLmMessages.length} messages for VS Code LM API`)

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(systemPrompt, vsCodeLmMessages)
		this.outputChannel.appendLine(`Total input tokens: ${totalInputTokens}`)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with minimal required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Roo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
			}

			this.outputChannel.appendLine("Sending request to VS Code LM API")

			// Note: Tool support is currently provided by the VSCode Language Model API directly
			// Extensions can register tools using vscode.lm.registerTool()

			const response: vscode.LanguageModelChatResponse = await client.sendRequest(
				vsCodeLmMessages,
				requestOptions,
				this.currentRequestCancellation.token,
			)

			this.outputChannel.appendLine("Received response, processing stream")

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
						// Validate tool call parameters
						if (!chunk.name || typeof chunk.name !== "string") {
							console.warn("Roo Code <Language Model API>: Invalid tool name received:", chunk.name)
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							console.warn("Roo Code <Language Model API>: Invalid tool callId received:", chunk.callId)
							continue
						}

						// Ensure input is a valid object
						if (!chunk.input || typeof chunk.input !== "object") {
							console.warn("Roo Code <Language Model API>: Invalid tool input received:", chunk.input)
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
						console.debug("Roo Code <Language Model API>: Processing tool call:", {
							name: chunk.name,
							callId: chunk.callId,
							inputSize: JSON.stringify(chunk.input).length,
						})

						yield {
							type: "text",
							text: toolCallText,
						}
					} catch (error) {
						console.error("Roo Code <Language Model API>: Failed to process tool call:", error)
						// Continue processing other chunks even if one fails
						continue
					}
				} else {
					console.warn("Roo Code <Language Model API>: Unknown chunk type received:", chunk)
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.countTokens(accumulatedText)

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
				console.error("Roo Code <Language Model API>: Stream error details:", {
					message: error.message,
					stack: error.stack,
					name: error.name,
				})

				// Return original error if it's already an Error instance
				throw error
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				console.error("Roo Code <Language Model API>: Stream error object:", errorDetails)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				console.error("Roo Code <Language Model API>: Unknown stream error:", errorMessage)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorMessage}`)
			}
		}
	}

	// Return model information based on the current client state
	getModel(): { id: string; info: ModelInfo } {
		if (this.client) {
			this.outputChannel.appendLine("Getting model information from client")

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
					this.outputChannel.appendLine(`Warning: Client missing ${prop} property`)
				}
			}

			// Construct model ID using available information
			const modelParts = [this.client.vendor, this.client.family, this.client.version].filter(Boolean)
			this.outputChannel.appendLine(`Model parts: ${modelParts.join(", ")}`)

			const modelId = this.client.id || modelParts.join(SELECTOR_SEPARATOR)
			this.outputChannel.appendLine(`Using model ID: ${modelId}`)

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

			this.outputChannel.appendLine(`Generated model info with context window: ${modelInfo.contextWindow}`)
			return { id: modelId, info: modelInfo }
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: "vscode-lm"

		this.outputChannel.appendLine(`No client available, using fallback ID: ${fallbackId}`)

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		this.outputChannel.appendLine(
			`Starting prompt completion: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`,
		)

		try {
			const client = await this.getClient()
			this.outputChannel.appendLine(`Using client: ${client.name} (${client.id}) from ${client.vendor}`)

			const response = await client.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{},
				new vscode.CancellationTokenSource().token,
			)

			this.outputChannel.appendLine("Received response, processing stream")
			let result = ""
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					result += chunk.value
				}
			}

			this.outputChannel.appendLine(`Completion successful, received ${result.length} characters`)
			return result
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.outputChannel.appendLine(`Completion failed: ${errorMessage}`)
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
		this.outputChannel.appendLine("Explicitly refreshing model cache")

		// Clear the cached model
		this.cachedModel = null
		this.cachedModelSelector = null

		// Get the current selector
		const selector = this.options?.vsCodeLmModelSelector || {}

		// Force a new client creation
		this.client = await this.createClient(selector)
		this.outputChannel.appendLine(
			`Refreshed model: ${this.client.name} (${this.client.id}) from ${this.client.vendor}`,
		)

		return this.client
	}
}
