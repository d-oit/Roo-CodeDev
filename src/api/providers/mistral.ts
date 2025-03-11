import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { SingleCompletionHandler } from "../"
import { ApiHandlerOptions, mistralDefaultModelId, MistralModelId, mistralModels, ModelInfo } from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStream } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import * as vscode from "vscode"

const MISTRAL_DEFAULT_TEMPERATURE = 0

export class MistralHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: Mistral
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

		// Clear cached model if options change
		this.cachedModel = null

		// Set default model ID if not provided
		this.options = {
			...options,
			apiModelId: options.apiModelId || mistralDefaultModelId,
		}

		const config = vscode.workspace.getConfiguration("roo-cline")
		this.enableDebugOutput = config.get<boolean>("debug.mistral", false)

		if (this.enableDebugOutput) {
			if (!MistralHandler.sharedOutputChannel) {
				MistralHandler.sharedOutputChannel = vscode.window.createOutputChannel(MistralHandler.outputChannelName)
			}
			this.outputChannel = MistralHandler.sharedOutputChannel
		}

		const baseUrl = this.getBaseUrl()
		this.logDebug(`MistralHandler using baseUrl: ${baseUrl}`)

		const logger = {
			group: (message: string) => this.logDebug(`Group: ${message}`),
			groupEnd: () => this.logDebug("GroupEnd"),
			log: (...args: any[]) => {
				const formattedArgs = args
					.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : arg))
					.join(" ")
				this.logDebug(formattedArgs)
			},
		}

		this.client = new Mistral({
			serverURL: baseUrl,
			apiKey: this.options.mistralApiKey,
			debugLogger: this.enableDebugOutput ? logger : undefined,
		})
	}

	private logDebug(message: string | object) {
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

	override async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		this.logDebug(`Creating message with system prompt: ${systemPrompt}`)

		const response = await this.client.chat.stream({
			model: this.options.apiModelId || mistralDefaultModelId,
			messages: [{ role: "system", content: systemPrompt }, ...convertToMistralMessages(messages)],
			maxTokens: this.options.includeMaxTokens ? this.getModel().info.maxTokens : undefined,
			temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
			stream: this.options.mistralModelStreamingEnabled !== false,
			...(this.options.stopToken?.trim() && { stop: [this.options.stopToken] }),
		})

		let completeContent = ""
		let isComplete = false

		let hasYieldedUsage = false

		for await (const chunk of response) {
			const delta = chunk.data.choices[0]?.delta

			if (delta?.content) {
				let content: string = ""
				if (typeof delta.content === "string") {
					content = delta.content
				} else if (Array.isArray(delta.content)) {
					content = delta.content.map((c) => (c.type === "text" ? c.text : "")).join("")
				}
				completeContent += content
				yield {
					type: "text",
					text: content,
				}
			}

			if (chunk.data.usage) {
				hasYieldedUsage = true
				this.logDebug(`Complete content: ${completeContent}`)
				this.logDebug(
					`Usage - Input tokens: ${chunk.data.usage.promptTokens}, Output tokens: ${chunk.data.usage.completionTokens}`,
				)
				yield {
					type: "usage",
					inputTokens: chunk.data.usage.promptTokens || 0,
					outputTokens: chunk.data.usage.completionTokens || 0,
				}
			}

			// Check for completion at the end of each chunk
			if (chunk.data.choices[0]?.finishReason) {
				isComplete = true
				break
			}
		}

		// Always yield a final empty chunk when stream is complete
		if (isComplete) {
			// Yield usage if we haven't already
			if (completeContent && !hasYieldedUsage) {
				this.logDebug(`Final content: ${completeContent}`)
				yield {
					type: "usage",
					inputTokens: 0,
					outputTokens: 0,
				}
			}

			// Yield completion signal
			yield {
				type: "text",
				text: "",
			}
		}
	}

	override getModel(): { id: MistralModelId; info: ModelInfo } {
		// Check if cache exists and is for the current model
		if (this.cachedModel && this.cachedModel.forModelId === this.options.apiModelId) {
			return {
				id: this.cachedModel.id,
				info: this.cachedModel.info,
			}
		}

		const modelId = this.options.apiModelId
		if (modelId && modelId in mistralModels) {
			const id = modelId as MistralModelId
			this.logDebug(`Using model: ${id}`)
			this.cachedModel = {
				id,
				info: mistralModels[id],
				forModelId: modelId,
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

	async completePrompt(prompt: string): Promise<string> {
		try {
			this.logDebug(`Completing prompt: ${prompt}`)
			const response = await this.client.chat.complete({
				model: this.options.apiModelId || mistralDefaultModelId,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
			})

			const content = response.choices?.[0]?.message.content
			if (Array.isArray(content)) {
				const result = content.map((c) => (c.type === "text" ? c.text : "")).join("")
				this.logDebug(`Completion result: ${result}`)
				return result
			}
			this.logDebug(`Completion result: ${content}`)
			return content || ""
		} catch (error) {
			if (error instanceof Error) {
				this.logDebug(`Completion error: ${error.message}`)
				throw new Error(`Mistral completion error: ${error.message}`, { cause: error })
			}
			throw error
		}
	}
}
