import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStreamChunk } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"

const MISTRAL_DEFAULT_TEMPERATURE = 0
const NO_CONTENT_TIMEOUT = 10000 // 10 seconds with no new content
const MAX_RETRIES = 3 // Maximum number of retries for failed requests

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

	private static readonly outputChannelName = "Roo Code Mistral"
	private static sharedOutputChannel: vscode.OutputChannel | undefined

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

	private logDebug(message: string | object): void {
		if (this.enableDebugOutput && this.outputChannel) {
			const formattedMessage = typeof message === "object" ? JSON.stringify(message, null, 2) : message
			this.outputChannel.appendLine(`[Roo Code] ${formattedMessage}`)
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

				this.logDebug("Streaming with params: " + JSON.stringify(streamParams, null, 2))

				const response = await this.client.chat.stream(streamParams)

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
						}

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
							inputTokens: 0,
							outputTokens: completeContent.length,
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
					`Stream error (attempt ${retryCount}): ${error instanceof Error ? error.message : "Unknown error"}`,
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
