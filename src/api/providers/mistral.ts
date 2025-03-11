import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStreamChunk } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"

const MISTRAL_DEFAULT_TEMPERATURE = 0
const STREAM_TIMEOUT = 30000 // 30 seconds timeout
const NO_CONTENT_TIMEOUT = 10000 // 10 seconds with no new content
const MAX_RETRIES = 3 // Maximum number of retries for failed requests
const RATE_LIMIT_PERCENTAGE_THRESHOLD = 20 // Show warning when less than 20% remaining
const RATE_LIMIT_ABSOLUTE_THRESHOLD = 5 // And less than 5 requests remaining
const WARNING_COOLDOWN = 60000 // Only show warning once per minute

// Mistral API rate limit header names
const HEADERS = {
	REMAINING_MINUTE: "x-mistral-ratelimit-remaining",
	LIMIT_MINUTE: "x-mistral-ratelimit-limit",
	REMAINING_DAY: "x-mistral-ratelimit-reset",
	LIMIT_DAY: "x-mistral-ratelimit-reset",
} as const

interface TextContent {
	type: "text"
	text: string
}

interface ImageURLContent {
	type: "image_url"
	url: string
}

type MistralContent = string | (TextContent | ImageURLContent)[]

type MistralMessage = {
	role: "system" | "user" | "assistant" | "tool"
	content: string
}

export class MistralHandler extends BaseProvider implements SingleCompletionHandler {
	private client: Mistral
	protected options: ApiHandlerOptions
	private readonly enableDebugOutput: boolean
	private readonly outputChannel?: vscode.OutputChannel
	private cachedModel: { id: MistralModelId; info: ModelInfo; forModelId: string | undefined } | null = null
	private lastWarningTime = 0
	private static readonly outputChannelName = "Roo Code Mistral"
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private lastSystemPrompt: string | undefined
	private lastMessages: string | undefined
	private accumulatedInputTokens = 0
	private accumulatedOutputTokens = 0

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

		const logger = this.enableDebugOutput
			? {
					group: (message: string) => this.logDebug(`Group: ${message}`),
					groupEnd: () => this.logDebug("GroupEnd"),
					log: (...args: any[]) => {
						const formattedArgs = args
							.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : arg))
							.join(" ")
						this.logDebug(formattedArgs)
					},
				}
			: undefined

		this.client = new Mistral({
			serverURL: baseUrl,
			apiKey: this.options.mistralApiKey,
			debugLogger: logger,
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

	private checkRateLimits(response: any): void {
		// Log the full response headers for debugging
		this.logDebug("Full response headers:", response.headers || {})

		const headers = response.headers || {}

		const headerEntries = {
			remainingMinute: parseInt(
				headers[HEADERS.REMAINING_MINUTE] ??
					headers["remaining"] ??
					headers["x-ratelimit-remaining-minute"] ??
					"0",
				10,
			),
			limitMinute: parseInt(
				headers[HEADERS.LIMIT_MINUTE] ?? headers["limit"] ?? headers["x-ratelimit-limit-minute"] ?? "0",
				10,
			),
			remainingDay: headers[HEADERS.REMAINING_DAY] ?? headers["x-ratelimit-remaining-day"] ?? "unknown",
			limitDay: headers[HEADERS.LIMIT_DAY] ?? headers["x-ratelimit-limit-day"] ?? "unknown",
		}

		// Log rate limit information
		this.logDebug("Rate limit headers:", headerEntries)
		this.logDebug(`Rate limits - Minute: ${headerEntries.remainingMinute}/${headerEntries.limitMinute}`)
		this.logDebug(`Rate limits - Daily: ${headerEntries.remainingDay}/${headerEntries.limitDay}`)

		// Only check rate limits if we have valid values
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

	public override getModel(): { id: MistralModelId; info: ModelInfo } {
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

	private convertMessageToContentBlocks(
		message: Anthropic.Messages.MessageParam,
	): Anthropic.Messages.ContentBlockParam[] {
		if (typeof message.content === "string") {
			return [{ type: "text", text: message.content }]
		}
		return message.content
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
		this.logDebug(`Creating message with system prompt: ${systemPrompt}`)

		const messagesKey = JSON.stringify(messages)
		if (systemPrompt === this.lastSystemPrompt && messagesKey === this.lastMessages) {
			this.logDebug("Duplicate prompt detected, using cached response")
			return
		}

		this.lastSystemPrompt = systemPrompt
		this.lastMessages = messagesKey

		const inputContentBlocks: Anthropic.Messages.ContentBlockParam[] = [
			{ type: "text", text: systemPrompt },
			...messages.flatMap((msg) => this.convertMessageToContentBlocks(msg)),
		]

		this.accumulatedInputTokens = await this.countTokens(inputContentBlocks)
		this.logDebug(`Input tokens: ${this.accumulatedInputTokens}`)

		let retryCount = 0
		while (retryCount < MAX_RETRIES) {
			try {
				const model = this.getModel()
				const mistralMessages = [
					{ role: "system" as const, content: systemPrompt },
					...convertToMistralMessages(messages),
				]

				const streamParams = {
					model: model.id,
					messages: mistralMessages,
					maxTokens: model.info.maxTokens,
					temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
					stream: this.options.mistralModelStreamingEnabled !== false,
					...(this.options.stopToken?.trim() && { stop: [this.options.stopToken] }),
				}

				this.logDebug("Streaming with params:", streamParams)

				const response = await this.client.chat.stream(streamParams)

				// Check rate limits after successful response
				this.checkRateLimits(response)

				let completeContent = ""
				let hasYieldedUsage = false
				let lastContentTime = Date.now()
				let hasTimedOut = false

				const noContentInterval = setInterval(() => {
					if (Date.now() - lastContentTime > NO_CONTENT_TIMEOUT) {
						this.logDebug("No content timeout reached")
						hasTimedOut = true
					}
				}, 1000)

				try {
					for await (const chunk of response) {
						if (hasTimedOut) break

						const delta = chunk.data.choices[0]?.delta
						if (delta?.content) {
							lastContentTime = Date.now()
							const textContent = this.extractText(delta.content as MistralContent)
							completeContent += textContent
							yield { type: "text", text: textContent }

							const outputTokenCount = await this.countTokens([{ type: "text", text: textContent }])
							this.accumulatedOutputTokens += outputTokenCount
						}

						if (chunk.data.usage && !hasYieldedUsage) {
							hasYieldedUsage = true
							this.logDebug(
								`Usage - Input tokens: ${chunk.data.usage.promptTokens}, Output tokens: ${chunk.data.usage.completionTokens}`,
							)
							yield {
								type: "usage",
								inputTokens: chunk.data.usage.promptTokens || this.accumulatedInputTokens,
								outputTokens: chunk.data.usage.completionTokens || this.accumulatedOutputTokens,
							}
						}

						if (chunk.data.choices[0]?.finishReason) {
							break
						}
					}

					if (completeContent.length === 0) {
						yield { type: "text", text: "No response generated." }
					}

					if (!hasYieldedUsage) {
						yield {
							type: "usage",
							inputTokens: this.accumulatedInputTokens,
							outputTokens: this.accumulatedOutputTokens,
						}
					}

					clearInterval(noContentInterval)
					return
				} catch (streamError) {
					clearInterval(noContentInterval)
					throw streamError
				}
			} catch (error) {
				retryCount++
				this.logDebug(
					`Stream error (attempt ${retryCount}):`,
					error instanceof Error ? error.message : "Unknown error",
				)

				if (retryCount === MAX_RETRIES) {
					throw new Error("API Error: Failed to create message after multiple attempts")
				}

				await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount))
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const response = await this.client.chat.complete({
				model: this.options.apiModelId || mistralDefaultModelId,
				messages: [{ role: "user" as const, content: prompt }],
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
				stream: false,
			})

			// Check rate limits after successful response
			this.checkRateLimits(response)

			if (!response?.choices?.[0]?.message?.content) {
				throw new Error("Invalid response format")
			}

			return this.extractText(response.choices[0].message.content as MistralContent)
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Mistral completion error: ${error.message}`)
			}
			throw new Error("Unknown error occurred during Mistral completion")
		}
	}
}
