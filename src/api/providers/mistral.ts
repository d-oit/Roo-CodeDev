import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral, MistralClient, ClientConfig } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStreamChunk, ApiStreamTextChunk, ApiStreamUsageChunk } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"

const MISTRAL_DEFAULT_TEMPERATURE = 0
const NO_CONTENT_TIMEOUT = 60000 // 60 seconds with no new content
const MAX_RETRIES = 3 // Maximum number of retries for failed requests
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
	private client: MistralClient
	private readonly enableDebugOutput: boolean
	private readonly outputChannel?: vscode.OutputChannel
	private cachedModel: { id: MistralModelId; info: ModelInfo; forModelId: string | undefined } | null = null
	private lastWarningTime = 0
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

		// Initialize client with default headers
		const clientConfig: ClientConfig = {
			apiKey: this.options.mistralApiKey,
			endpoint: baseUrl,
			defaultHeaders: defaultHeaders,
		}

		this.client = new Mistral(clientConfig)
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

	private checkRateLimits(headers: Record<string, any> = {}): void {
		this.logDebug("Full response headers:", headers)

		const headerEntries = {
			remainingMinute: parseInt(headers["ratelimit-remaining"] || "0", 10),
			limitMinute: parseInt(headers["ratelimit-limit"] || "0", 10),
			remainingDay: headers["x-ratelimit-remaining-day"] || "unknown",
			limitDay: headers["x-ratelimit-limit-day"] || "unknown",
		}

		this.logDebug("Rate limit headers:", headerEntries)
		this.logDebug(`Rate limits - Minute: ${headerEntries.remainingMinute}/${headerEntries.limitMinute}`)
		this.logDebug(`Rate limits - Daily: ${headerEntries.remainingDay}/${headerEntries.limitDay}`)

		if (headerEntries.limitMinute > 0) {
			const remainingPercentage = (headerEntries.remainingMinute / headerEntries.limitMinute) * 100
			const currentTime = Date.now()

			if (
				remainingPercentage <= RATE_LIMIT_PERCENTAGE_THRESHOLD &&
				headerEntries.remainingMinute <= RATE_LIMIT_ABSOLUTE_THRESHOLD &&
				currentTime - this.lastWarningTime >= WARNING_COOLDOWN
			) {
				this.logDebug(`WARNING: Approaching rate limit (${remainingPercentage.toFixed(1)}% remaining)`)
				try {
					vscode.window.showWarningMessage(
						`Approaching Mistral API rate limit: ${headerEntries.remainingMinute} requests remaining out of ${headerEntries.limitMinute} per minute`,
					)
					this.lastWarningTime = currentTime
				} catch {}
			}
		} else {
			this.logDebug("No valid rate limit values found in headers")
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
			const response = await this.client.chat.stream(streamParams)
			this.logDebug("Stream connection established")

			if (response.headers) {
				this.checkRateLimits(response.headers)
			}

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
				messages: [{ role: "user" as const, content: prompt }],
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
			})

			if (!response?.choices?.[0]?.message?.content) {
				throw new Error("Invalid response format")
			}

			return this.extractText(response.choices[0].message.content as MistralContent)
		} catch (error) {
			this.handleError(error)
		}
	}
}
