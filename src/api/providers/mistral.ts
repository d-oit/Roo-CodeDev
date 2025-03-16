import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStreamChunk } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"
import { logger } from "../../utils/logging"

// Create a custom debug logger that integrates with our existing logging system
const createDebugLogger = (outputChannel?: vscode.OutputChannel, enableDebug?: boolean) => ({
	debug: (...args: any[]) => {
		if (enableDebug && outputChannel) {
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code Debug] ${message}`)
		}
	},
	info: (...args: any[]) => {
		if (enableDebug && outputChannel) {
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code Info] ${message}`)
		}
	},
	warn: (...args: any[]) => {
		if (enableDebug && outputChannel) {
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code Warning] ${message}`)
		}
	},
	error: (...args: any[]) => {
		if (outputChannel) {
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code Error] ${message}`)
		}
	},
	// Add missing methods required by Mistral SDK Logger interface
	log: (...args: any[]) => {
		if (enableDebug && outputChannel) {
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code Log] ${message}`)
		}
	},
	group: (...args: any[]) => {
		if (enableDebug && outputChannel) {
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code Group] ${message}`)
		}
	},
	groupEnd: () => {
		if (enableDebug && outputChannel) {
			outputChannel.appendLine(`[Roo Code GroupEnd]`)
		}
	},
	logts: (...args: any[]) => {
		if (enableDebug && outputChannel) {
			const timestamp = new Date().toISOString()
			const message = args
				.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
				.join(" ")
			outputChannel.appendLine(`[Roo Code ${timestamp}] ${message}`)
		}
	},
})

const MISTRAL_DEFAULT_TEMPERATURE = 0
const MAX_RETRIES = 3 // Maximum number of retries for failed requests
const INITIAL_RETRY_DELAY = 1000 // Initial retry delay in milliseconds
const MAX_RETRY_DELAY = 32000 // Maximum retry delay in milliseconds
const JITTER_FACTOR = 0.2 // Jitter factor for randomization (20%)

// Define default headers
export const defaultHeaders = {
	"HTTP-Referer": "https://github.com/RooVetGit/Roo-Cline",
	"X-Title": "Roo Code",
}

interface TextContent {
	type: "text"
	text: string
}

interface ImageURLContent {
	type: "image_url"
	url: string
}

type MistralContent = string | (TextContent | ImageURLContent)[]

interface MistralUsage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
}

export class MistralHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: Mistral
	private readonly enableDebugOutput: boolean
	private readonly outputChannel?: vscode.OutputChannel
	private readonly enableVerboseDebug: boolean
	private readonly verboseOutputChannel?: vscode.OutputChannel
	private readonly enableSdkDebug: boolean
	private cachedModel: { id: MistralModelId; info: ModelInfo; forModelId: string | undefined } | null = null
	private static readonly outputChannelName = "Roo Code Mistral"
	private static readonly verboseOutputChannelName = "Roo Code Mistral Verbose"
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private static sharedVerboseOutputChannel: vscode.OutputChannel | undefined
	private noContentInterval?: NodeJS.Timeout
	private lastYieldedContent: string = ""
	private loopDetectionCount: number = 0
	private MAX_LOOP_ITERATIONS: number = 5
	private patternDetectionBuffer: string = "" // Add this to track patterns
	private repetitivePatternBuffer = ""
	private repetitivePatternThreshold = 3 // How many repetitions before we consider it a problem
	private maxPatternLength = 20 // Maximum pattern length to check

	constructor(options: ApiHandlerOptions) {
		super()
		if (!options.mistralApiKey) {
			throw new Error("Mistral API key is required")
		}

		this.cachedModel = null
		this.options = {
			...options,
			apiModelId: options.apiModelId || mistralDefaultModelId,
		}

		try {
			const config = vscode.workspace.getConfiguration("roo-cline")
			this.enableDebugOutput = config?.get<boolean>("debug.mistral") || false
			this.enableVerboseDebug = config?.get<boolean>("debug.mistralVerbose") || false
			this.enableSdkDebug = config?.get<boolean>("debug.mistralSdk") || false
		} catch {
			this.enableDebugOutput = false
			this.enableVerboseDebug = false
			this.enableSdkDebug = false
		}

		if (this.enableDebugOutput) {
			try {
				if (!MistralHandler.sharedOutputChannel) {
					MistralHandler.sharedOutputChannel = vscode.window.createOutputChannel(
						MistralHandler.outputChannelName,
					)
				}
				this.outputChannel = MistralHandler.sharedOutputChannel
			} catch {
				// Ignore output channel creation errors in tests
			}
		}

		if (this.enableVerboseDebug) {
			try {
				if (!MistralHandler.sharedVerboseOutputChannel) {
					MistralHandler.sharedVerboseOutputChannel = vscode.window.createOutputChannel(
						MistralHandler.verboseOutputChannelName,
					)
				}
				this.verboseOutputChannel = MistralHandler.sharedVerboseOutputChannel
			} catch {
				// Ignore output channel creation errors in tests
			}
		}

		const baseUrl = this.getBaseUrl()
		this.logDebug(`MistralHandler using baseUrl: ${baseUrl}`)

		// Create custom debug logger that integrates with our logging system
		// Only use debug logger if SDK debug is enabled
		const debugLogger = this.enableSdkDebug
			? createDebugLogger(this.enableVerboseDebug ? this.verboseOutputChannel : this.outputChannel, true)
			: undefined

		// Initialize with API key, base URL and debug logger
		this.client = new Mistral({
			apiKey: this.options.mistralApiKey,
			serverURL: baseUrl,
			debugLogger: debugLogger,
		})
	}

	private logDebug(...messages: (string | object)[]): void {
		if (this.enableDebugOutput && this.outputChannel) {
			const formattedMessages = messages
				.map((msg) => (typeof msg === "object" ? JSON.stringify(msg, null, 2) : msg))
				.join(" ")
			this.outputChannel.appendLine(`[Roo Code] ${formattedMessages}`)
		}
	}

	private logVerbose(...messages: (string | object)[]): void {
		if (this.enableVerboseDebug && this.verboseOutputChannel) {
			const formattedMessages = messages
				.map((msg) => (typeof msg === "object" ? JSON.stringify(msg, null, 2) : msg))
				.join(" ")
			this.verboseOutputChannel.appendLine(`[Roo Code] ${new Date().toISOString()} ${formattedMessages}`)
		}
	}

	private getBaseUrl(): string {
		const modelId = this.options.apiModelId ?? mistralDefaultModelId
		this.logDebug(`MistralHandler using modelId: ${modelId}`)
		if (modelId?.startsWith("codestral-")) {
			return this.options.mistralCodestralUrl || "https://codestral.mistral.ai"
		}
		return "https://api.mistral.ai"
	}

	private exponentialBackoff(retryCount: number): number {
		const delay = Math.min(
			INITIAL_RETRY_DELAY * Math.pow(2, retryCount) * (1 + JITTER_FACTOR * Math.random()),
			MAX_RETRY_DELAY,
		)
		this.logDebug(`Calculated backoff delay: ${delay}ms for retry ${retryCount}`)
		return delay
	}

	private async handleRateLimitError(error: Error): Promise<void> {
		const retryAfterMatch = error.message.match(/retry after (\d+)/i)
		const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) * 1000 : 60000 // Convert to ms or default to 1 minute

		logger.warn("Mistral rate limit hit", {
			ctx: "mistral",
			retryAfterMs: retryAfter,
			errorMessage: error.message,
		})

		this.logDebug(`Rate limit hit. Waiting ${retryAfter}ms before retry`)
		await new Promise((resolve) => setTimeout(resolve, retryAfter))
	}

	private async retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
		let retryCount = 0

		while (true) {
			try {
				return await operation()
			} catch (error) {
				if (retryCount >= MAX_RETRIES || !(error instanceof Error)) {
					this.logVerbose(`Max retries (${MAX_RETRIES}) reached or non-Error thrown:`, error)
					logger.error("Mistral retry failed", {
						ctx: "mistral",
						retryCount,
						error: error instanceof Error ? error.message : String(error),
					})
					throw error
				}

				const isRateLimit = error instanceof Error && error.message.includes("rate limit")

				if (isRateLimit) {
					await this.handleRateLimitError(error)
				} else {
					const backoffDelay = this.exponentialBackoff(retryCount)
					this.logDebug(
						`Retrying operation after ${backoffDelay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`,
					)
					this.logVerbose(`Retry reason:`, error)
					logger.warn("Mistral API retry", {
						ctx: "mistral",
						retryCount: retryCount + 1,
						backoffDelay,
						error: error instanceof Error ? error.message : String(error),
					})
					await new Promise((resolve) => setTimeout(resolve, backoffDelay))
				}

				retryCount++
			}
		}
	}

	private abortController?: AbortController

	private cleanup(): void {
		if (this.noContentInterval) {
			clearInterval(this.noContentInterval)
			this.noContentInterval = undefined
		}
		if (this.abortController) {
			this.abortController.abort()
			this.abortController = undefined
		}
	}

	private handleError(error: unknown): never {
		// Convert error to a string or object before logging
		const errorForLogging = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)

		this.logDebug("Mistral API error:", errorForLogging)

		if (error instanceof Error) {
			// Check for specific Mistral API error types
			if (error.message.includes("rate limit")) {
				this.handleRateLimitError(error)
			} else if (error.message.includes("authentication")) {
				logger.error("Mistral authentication error", { ctx: "mistral", error: errorForLogging })
				throw new Error(`Mistral API authentication error: ${error.message}`)
			} else if (error.message.includes("invalid model")) {
				logger.error("Mistral invalid model error", { ctx: "mistral", error: errorForLogging })
				throw new Error(`Mistral API model error: ${error.message}`)
			} else if (error.message.includes("context length")) {
				logger.error("Mistral context length error", { ctx: "mistral", error: errorForLogging })
				throw new Error(`Mistral API context length error: ${error.message}`)
			} else if (error.message.includes("timeout")) {
				logger.error("Mistral timeout error", { ctx: "mistral", error: errorForLogging })
				throw new Error(`Mistral API timeout: ${error.message}`)
			} else {
				logger.error("Mistral general error", { ctx: "mistral", error: errorForLogging })
				throw new Error(`Mistral API error: ${error.message}`)
			}
		}

		logger.error("Mistral unknown error", { ctx: "mistral", error: String(error) })
		throw new Error(`Mistral API error: ${String(error)}`)
	}

	override getModel(): { id: MistralModelId; info: ModelInfo } {
		if (this.cachedModel && this.cachedModel.forModelId === this.options.apiModelId) {
			this.logDebug(`Using cached model: ${this.cachedModel.id}`)
			return {
				id: this.cachedModel.id,
				info: this.cachedModel.info,
			}
		}

		if (this.options.apiModelId && this.options.apiModelId in mistralModels) {
			const id = this.options.apiModelId as MistralModelId
			this.logDebug(`Using model: ${id}`)
			this.cachedModel = {
				id,
				info: mistralModels[id],
				forModelId: this.options.apiModelId,
			}
			return {
				id: this.cachedModel.id,
				info: this.cachedModel.info,
			}
		}

		this.logDebug(`Using default model: ${mistralDefaultModelId}`)
		this.cachedModel = {
			id: mistralDefaultModelId,
			info: mistralModels[mistralDefaultModelId],
			forModelId: undefined,
		}
		return {
			id: this.cachedModel.id,
			info: this.cachedModel.info,
		}
	}

	private extractText(content: MistralContent): string {
		if (typeof content === "string") {
			return content
		}
		return content
			.filter((chunk): chunk is TextContent => chunk.type === "text")
			.map((chunk) => chunk.text)
			.join("")
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
	): AsyncGenerator<ApiStreamChunk> {
		try {
			this.logDebug(`Creating message with system prompt: ${systemPrompt}`)

			// Create new abort controller
			this.cleanup() // Clean up any existing controller
			this.abortController = new AbortController()
			const signal = this.abortController.signal

			// Get the model first
			const model = this.getModel()

			// Calculate a reasonable maxTokens value based on context window and input size
			const inputMessages = [{ role: "system", content: systemPrompt }, ...convertToMistralMessages(messages)]

			// Estimate input tokens using a simple heuristic
			let estimatedInputTokens = 0
			try {
				// Convert messages to a string and use a character-based estimation
				const messageText = inputMessages
					.map((msg) => {
						if (typeof msg.content === "string") {
							return msg.content
						} else if (Array.isArray(msg.content)) {
							return msg.content
								.map((c) => (typeof c === "string" ? c : c.type === "text" ? c.text : ""))
								.join("")
						}
						return ""
					})
					.join(" ")

				// Rough estimate: 1 token ≈ 4 characters for English text
				estimatedInputTokens = Math.ceil(messageText.length / 4)
				this.logDebug(`Estimated input tokens (character-based): ${estimatedInputTokens}`)
			} catch (error) {
				this.logDebug("Error estimating token count:", error)
				// Default to a conservative estimate if calculation fails
				estimatedInputTokens = Math.floor(model.info.contextWindow * 0.5)
			}

			// Reserve 20% of context window for output by default, or use a configured value
			const contextWindow = model.info.contextWindow
			const reservedForOutput = this.options.modelMaxTokens || Math.floor(contextWindow * 0.2)

			// Ensure we don't exceed the model's capabilities
			const safeMaxTokens = Math.min(
				reservedForOutput,
				model.info.maxTokens || reservedForOutput,
				Math.max(100, contextWindow - estimatedInputTokens), // Ensure at least 100 tokens for output
			)

			const streamParams = {
				model: model.id,
				messages: [{ role: "system" as const, content: systemPrompt }, ...convertToMistralMessages(messages)],
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
				stream: this.options.mistralModelStreamingEnabled,
				maxTokens: safeMaxTokens,
				signal, // Add abort signal
			}

			this.logDebug("Streaming with params:", streamParams)

			const response = await this.retryWithBackoff(async () => {
				if (signal.aborted) {
					throw new Error("Stream aborted before start")
				}
				return await this.client.chat.stream(streamParams)
			})

			this.logDebug("Stream connection established")
			let hasYieldedUsage = false
			let accumulatedText = "" // Variable to accumulate response text
			const startTime = Date.now()
			const MAX_STREAM_DURATION_MS = 60000 // 1 minute max

			try {
				for await (const chunk of response) {
					// Check for abortion at start of each iteration
					if (signal.aborted) {
						this.logDebug("Stream aborted during processing")
						return
					}

					// Enhanced debugging - log the entire chunk structure
					this.logDebug(`Chunk received: ${JSON.stringify(chunk, null, 2)}`)
					this.logDebug(`Chunk keys: ${Object.keys(chunk || {}).join(", ")}`)

					// If chunk has data property, log its structure too
					if (chunk.data) {
						this.logDebug(`Chunk.data keys: ${Object.keys(chunk.data || {}).join(", ")}`)
						this.logDebug(`Chunk.data structure: ${JSON.stringify(chunk.data, null, 2)}`)
					}

					// Handle usage metrics if present at the top level
					if (!hasYieldedUsage && chunk && "usage" in chunk && chunk.usage) {
						// Type assertion to access the properties safely
						const usage = chunk.usage as MistralUsage

						hasYieldedUsage = true
						this.logDebug(
							`Usage found - Input tokens: ${usage.prompt_tokens}, Output tokens: ${usage.completion_tokens}`,
						)

						yield {
							type: "usage",
							inputTokens: usage.prompt_tokens || 0,
							outputTokens: usage.completion_tokens || 0,
						}
					}

					// Continue with the existing delta content handling
					if (chunk.data) {
						// Check for usage information in chunk.data
						if (!hasYieldedUsage && chunk.data.usage) {
							hasYieldedUsage = true
							this.logDebug(
								`Usage found - Input tokens: ${chunk.data.usage.promptTokens}, Output tokens: ${chunk.data.usage.completionTokens}`,
							)

							yield {
								type: "usage",
								inputTokens: chunk.data.usage.promptTokens || 0,
								outputTokens: chunk.data.usage.completionTokens || 0,
							}
						}

						// Check finish reason first
						if (chunk.data?.choices[0]?.finishReason) {
							this.logDebug(`Stream finished with reason: ${chunk.data.choices[0].finishReason}`)
							break
						}

						const delta = chunk.data.choices[0]?.delta
						if (delta?.content) {
							const textContent = this.extractText(delta.content as MistralContent)

							// Check if we've been streaming too long
							if (Date.now() - startTime > MAX_STREAM_DURATION_MS) {
								this.logDebug(
									`Stream exceeded maximum duration of ${MAX_STREAM_DURATION_MS}ms, breaking`,
								)
								break
							}

							// Add to our pattern detection buffer
							this.repetitivePatternBuffer += textContent

							// Keep buffer at a reasonable size
							if (this.repetitivePatternBuffer.length > 500) {
								this.repetitivePatternBuffer = this.repetitivePatternBuffer.slice(-500)
							}

							// Check for repetitive patterns
							const isRepetitive = false // not working this.detectRepetitivePattern(this.repetitivePatternBuffer)
							if (isRepetitive) {
								this.loopDetectionCount += 2
								this.logDebug(`Detected repetitive pattern, count: ${this.loopDetectionCount}`)

								if (this.loopDetectionCount > this.MAX_LOOP_ITERATIONS / 2) {
									this.logDebug(`Breaking due to excessive repetitive patterns`)
									break
								}
							} else {
								// Reset counter if no repetition detected
								this.loopDetectionCount = Math.max(0, this.loopDetectionCount - 1)
							}

							// Check if this is a repetition of the last content
							if (textContent === this.lastYieldedContent) {
								this.logDebug(`Skipping repeated content: "${textContent}"`)
								this.loopDetectionCount++
								if (this.loopDetectionCount > this.MAX_LOOP_ITERATIONS) {
									this.logDebug(
										`Detected infinite loop after ${this.loopDetectionCount} iterations, breaking`,
									)
									break
								}
								continue
							}

							// Reset loop counter if content is different
							this.loopDetectionCount = 0

							// Add more robust pattern detection
							this.patternDetectionBuffer += textContent
							if (this.patternDetectionBuffer.length > 100) {
								// Check for repeating patterns in last 100 chars
								const lastChunk = this.patternDetectionBuffer.slice(-100)
								for (let i = 1; i <= 20; i++) {
									// Check patterns up to 20 chars
									const pattern = lastChunk.slice(-i)
									if (pattern && lastChunk.slice(-2 * i, -i) === pattern && pattern.length > 2) {
										this.logDebug(`Detected repeating pattern: "${pattern}"`)
										this.loopDetectionCount += 2
										if (this.loopDetectionCount > this.MAX_LOOP_ITERATIONS) {
											this.logDebug(`Breaking due to repeating pattern detection`)
											break
										}
									}
								}
								// Trim buffer to prevent memory issues
								this.patternDetectionBuffer = this.patternDetectionBuffer.slice(-200)
							}

							this.logDebug(
								`Received content: "${textContent.substring(0, 50)}${textContent.length > 50 ? "..." : ""}"`,
							)

							this.lastYieldedContent = textContent
							accumulatedText += textContent // Accumulate the text
							yield { type: "text", text: textContent }
						}
					}
				}

				// After the streaming loop completes
				// Yield final usage if not done yet
				if (!hasYieldedUsage && !signal.aborted) {
					// Log that we're using fallback token counting
					this.logDebug("No usage information received from Mistral API, using fallback estimation")

					// Use our estimated input tokens and the accumulated text for output tokens
					const outputTextLength = accumulatedText.length

					// Estimate output tokens (roughly 4 chars per token)
					const estimatedOutputTokens = Math.ceil(outputTextLength / 4)

					this.logDebug(
						`Using fallback estimation - Input: ${estimatedInputTokens}, Output: ${estimatedOutputTokens}`,
					)

					yield {
						type: "usage",
						inputTokens: estimatedInputTokens,
						outputTokens: estimatedOutputTokens,
					}
				}

				this.cleanup()
				this.logDebug("Stream completed successfully")
			} catch (error) {
				this.cleanup()
				if (signal.aborted) {
					this.logDebug("Stream aborted due to error:", error)
					return
				}
				this.logDebug("Stream error occurred:", error)
				throw error
			}
		} catch (error) {
			this.cleanup()
			this.handleError(error)
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const response = await this.client.chat.complete({
				model: this.options.apiModelId || mistralDefaultModelId,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
			})

			const content = response.choices?.[0]?.message.content
			if (Array.isArray(content)) {
				return content.map((c) => (c.type === "text" ? c.text : "")).join("")
			}
			return content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Mistral completion error: ${error.message}`)
			}
			throw error
		}
	}

	/**
	 * Handle rate limit errors by extracting details from the HTTP header and notifying the user.
	 *
	 * @param response The HTTP response object
	 */
	protected async handleRateLimit(response: Response): Promise<void> {
		const rateLimitRemaining = response.headers.get("x-rate-limit-remaining")
		const rateLimitReset = response.headers.get("x-rate-limit-reset")

		if (rateLimitRemaining !== null && rateLimitReset !== null) {
			const remaining = parseInt(rateLimitRemaining, 10)
			const resetTime = new Date(parseInt(rateLimitReset, 10) * 1000)

			if (remaining <= 0) {
				const message = `Rate limit exceeded. Retry after ${resetTime.toLocaleString()}`
				vscode.window.showErrorMessage(message)
			} else {
				const message = `Rate limit almost reached. ${remaining} requests remaining.`
				vscode.window.showWarningMessage(message)
			}
		} else {
			const message = "Rate limit details not found in the response headers."
			vscode.window.showErrorMessage(message)
		}
	}

	/**
	 * Detects repetitive patterns in the given text
	 * @param text The text to check for repetitive patterns
	 * @returns True if a repetitive pattern is detected
	 */
	private detectRepetitivePattern(text: string): boolean {
		// Don't bother checking if text is too short
		if (text.length < 10) return false

		// Check for exact repetitions of varying lengths
		for (let patternLength = 2; patternLength <= this.maxPatternLength; patternLength++) {
			// Get the most recent pattern of this length
			const pattern = text.slice(-patternLength)

			// Count how many times this pattern appears consecutively
			let repetitionCount = 0
			let position = text.length - patternLength

			while (position >= 0) {
				const segment = text.slice(position, position + patternLength)
				if (segment === pattern) {
					repetitionCount++
					position -= patternLength
				} else {
					break
				}
			}

			// If we found enough repetitions, report it
			if (repetitionCount >= this.repetitivePatternThreshold) {
				this.logDebug(`Detected pattern "${pattern}" repeated ${repetitionCount} times`)
				return true
			}
		}

		// Check for line-based repetitions (common in code/file listings)
		const lines = text.split("\n").filter((line) => line.trim().length > 0)
		if (lines.length >= this.repetitivePatternThreshold) {
			const lastLine = lines[lines.length - 1]
			let lineRepetitions = 1

			for (let i = lines.length - 2; i >= 0; i--) {
				if (lines[i] === lastLine) {
					lineRepetitions++
				} else {
					break
				}
			}

			if (lineRepetitions >= this.repetitivePatternThreshold) {
				this.logDebug(`Detected line "${lastLine}" repeated ${lineRepetitions} times`)
				return true
			}
		}

		return false
	}
}
