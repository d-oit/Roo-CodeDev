import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStreamChunk, ApiStreamTextChunk, ApiStreamUsageChunk } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"

interface RateLimitInfo {
	remaining: number
	limit: number
	reset: number
	resetDate?: Date
}

const MISTRAL_DEFAULT_TEMPERATURE = 0
const NO_CONTENT_TIMEOUT = 60000 // 60 seconds with no new content
const MAX_RETRIES = 3 // Maximum number of retries for failed requests
const INITIAL_RETRY_DELAY = 1000 // Initial retry delay in milliseconds
const MAX_RETRY_DELAY = 32000 // Maximum retry delay in milliseconds
const JITTER_FACTOR = 0.2 // Jitter factor for randomization (20%)
const RATE_LIMIT_PERCENTAGE_THRESHOLD = 20 // Show warning when less than 20% remaining
const RATE_LIMIT_ABSOLUTE_THRESHOLD = 5 // And less than 5 requests remaining
const WARNING_COOLDOWN = 60000 // Only show warning once per minute
const MAX_STREAM_ITERATIONS = 1000 // Prevent endless processing

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
	private lastWarningTime = 0
	private static readonly outputChannelName = "Roo Code Mistral"
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private noContentInterval?: NodeJS.Timeout
	private rateLimitInfo?: RateLimitInfo

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

	private async handleRateLimit(error: Error): Promise<void> {
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

				await this.handleRateLimit(error)
				const backoffDelay = this.exponentialBackoff(retryCount)
				this.logDebug(`Retrying operation after ${backoffDelay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`)
				await new Promise((resolve) => setTimeout(resolve, backoffDelay))
				retryCount++
			}
		}
	}

	private cleanup(): void {
		if (this.noContentInterval) {
			clearInterval(this.noContentInterval)
			this.noContentInterval = undefined
		}
	}

	private handleError(error: Error | unknown): never {
		if (error instanceof Error) {
			this.logDebug("Error:", error.message)
			this.logDebug("Stack:", error.stack || "No stack trace")
			throw error
		}
		this.logDebug("Unknown error:", String(error))
		throw new Error("Unknown error occurred")
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

			const model = this.getModel()
			const streamParams = {
				model: model.id,
				messages: [{ role: "system" as const, content: systemPrompt }, ...convertToMistralMessages(messages)],
				maxTokens: this.options.includeMaxTokens ? model.info.maxTokens : undefined,
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
			}

			this.logDebug("Streaming with params:", streamParams)

			// Use retryWithBackoff for the stream request
			const response = await this.retryWithBackoff(async () => {
				return await this.client.chat.stream(streamParams)
			})
			this.logDebug("Stream connection established")

			let lastContentTime = Date.now()
			let hasTimedOut = false
			let iterationCount = 0
			let hasYieldedUsage = false

			this.cleanup()
			this.noContentInterval = setInterval(() => {
				if (Date.now() - lastContentTime > NO_CONTENT_TIMEOUT) {
					this.logDebug("No content timeout reached")
					hasTimedOut = true
				}
			}, 1000)

			try {
				for await (const chunk of response) {
					if (hasTimedOut || iterationCount >= MAX_STREAM_ITERATIONS) {
						this.logDebug(
							hasTimedOut
								? "Stream timed out, breaking loop"
								: "Max iterations reached, breaking loop to prevent endless processing",
						)
						break
					}

					iterationCount++
					this.logDebug(`Processing chunk #${iterationCount}`)

					const delta = chunk.data.choices[0]?.delta
					if (!delta) {
						this.logDebug(`Chunk #${iterationCount} has no delta`)
						continue
					}

					if (delta.content) {
						lastContentTime = Date.now()
						const textContent = this.extractText(delta.content as MistralContent)
						this.logDebug(
							`Received content in chunk #${iterationCount}: "${textContent.substring(0, 50)}${
								textContent.length > 50 ? "..." : ""
							}"`,
						)

						const textChunk: ApiStreamTextChunk = { type: "text", text: textContent }
						yield textChunk
					} else {
						this.logDebug(`Chunk #${iterationCount} has delta but no content`)
					}

					if (chunk.data.usage && !hasYieldedUsage) {
						hasYieldedUsage = true
						this.logDebug(
							`Usage - Input tokens: ${chunk.data.usage.promptTokens}, Output tokens: ${chunk.data.usage.completionTokens}`,
						)
						const usageChunk: ApiStreamUsageChunk = {
							type: "usage",
							inputTokens: chunk.data.usage.promptTokens || 0,
							outputTokens: chunk.data.usage.completionTokens || 0,
						}
						yield usageChunk
					}

					if (chunk.data.choices[0]?.finishReason) {
						break
					}
				}

				if (!hasYieldedUsage) {
					const usageChunk: ApiStreamUsageChunk = {
						type: "usage",
						inputTokens: 0,
						outputTokens: 0,
					}
					yield usageChunk
				}

				this.cleanup()
				this.logDebug("Stream processing completed successfully")
			} catch (error) {
				this.cleanup()
				this.handleError(error)
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
