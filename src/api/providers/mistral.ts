import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStreamChunk } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"

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

export class MistralHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: Mistral
	private readonly enableDebugOutput: boolean
	private readonly outputChannel?: vscode.OutputChannel
	private cachedModel: { id: MistralModelId; info: ModelInfo; forModelId: string | undefined } | null = null
	private static readonly outputChannelName = "Roo Code Mistral"
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private noContentInterval?: NodeJS.Timeout

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
		} catch {
			this.enableDebugOutput = false
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

		const baseUrl = this.getBaseUrl()
		this.logDebug(`MistralHandler using baseUrl: ${baseUrl}`)

		// Initialize with API key and base URL
		this.client = new Mistral({
			apiKey: this.options.mistralApiKey,
			serverURL: baseUrl,
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
		if (error.message.includes("rate limit")) {
			const retryAfter = 60000 // Default to 1 minute if no specific time provided
			this.logDebug(`Rate limit hit. Waiting ${retryAfter}ms before retry`)
			await new Promise((resolve) => setTimeout(resolve, retryAfter))
		}
	}

	private async retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
		let retryCount = 0

		while (true) {
			try {
				return await operation()
			} catch (error) {
				if (retryCount >= MAX_RETRIES || !(error instanceof Error)) {
					throw error
				}

				await this.handleRateLimitError(error)
				const backoffDelay = this.exponentialBackoff(retryCount)
				this.logDebug(`Retrying operation after ${backoffDelay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`)
				await new Promise((resolve) => setTimeout(resolve, backoffDelay))
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

		if (error instanceof Error && error.message.includes("rate limit")) {
			this.handleRateLimitError(error)
		} else if (error instanceof Error) {
			throw new Error(`Mistral API error: ${error.message}`)
		}
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
				maxTokens: this.options.includeMaxTokens ? safeMaxTokens : undefined,
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
				stream: this.options.mistralModelStreamingEnabled,
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

			try {
				for await (const chunk of response) {
					// Check for abortion at start of each iteration
					if (signal.aborted) {
						this.logDebug("Stream aborted during processing")
						return
					}

					// Check finish reason first
					if (chunk.data?.choices[0]?.finishReason) {
						this.logDebug(`Stream finished with reason: ${chunk.data.choices[0].finishReason}`)
						break
					}

					if (!chunk.data) {
						this.logDebug("Received empty chunk")
						continue
					}

					const delta = chunk.data.choices[0]?.delta
					if (delta?.content) {
						const textContent = this.extractText(delta.content as MistralContent)
						this.logDebug(
							`Received content: "${textContent.substring(0, 50)}${textContent.length > 50 ? "..." : ""}"`,
						)
						yield { type: "text", text: textContent }
					}

					// Handle usage metrics if present
					if (chunk.data.usage && !hasYieldedUsage) {
						hasYieldedUsage = true
						this.logDebug(
							`Usage - Input tokens: ${chunk.data.usage.promptTokens}, Output tokens: ${chunk.data.usage.completionTokens}`,
						)
						yield {
							type: "usage",
							inputTokens: chunk.data.usage.promptTokens || 0,
							outputTokens: chunk.data.usage.completionTokens || 0,
						}
					}
				}

				// Yield final usage if not done yet
				if (!hasYieldedUsage && !signal.aborted) {
					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: 0,
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
}
