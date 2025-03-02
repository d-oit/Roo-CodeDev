import * as vscode from "vscode"
import OpenAI from "openai"
import { Anthropic } from "@anthropic-ai/sdk"
import { Braintrust } from "@braintrustdata/braintrust-api-js"
import { ApiHandler, SingleCompletionHandler } from "../"
import { ApiHandlerOptions, ModelInfo } from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream, ApiStreamTextChunk, ApiStreamUsageChunk } from "../transform/stream"
import { logger } from "../../utils/logging"

const MODEL_CHECK_INTERVAL = 60000 // 1 minute
const DEFAULT_TEMPERATURE = 0

export class BraintrustHandler implements ApiHandler, SingleCompletionHandler {
	private options: ApiHandlerOptions
	private client!: OpenAI
	private braintrustClient!: Braintrust
	private cachedModel: { id: string; info: ModelInfo } | null = null
	private cachedModelId: string | null = null
	private modelCheckInterval?: NodeJS.Timeout
	private static sharedOutputChannel?: vscode.OutputChannel
	private outputChannel?: vscode.OutputChannel
	private enableDebugOutput: boolean
	private logConversations: boolean
	private readonly LOG_BATCH_SIZE = 10
	private readonly LOG_DEBOUNCE_MS = 1000
	private logQueue: string[] = []
	private logTimeout?: NodeJS.Timeout

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.enableDebugOutput = options.enableDebugOutput ?? false
		this.logConversations = options.logConversations ?? false

		if (!options.braintrustApiKey) {
			throw new Error("Braintrust API key is required")
		}

		if (!options.braintrustProjectId) {
			throw new Error("Braintrust Project ID is required")
		}

		const baseURL = options.braintrustBaseUrl || "https://api.braintrustdata.com"

		// Initialize Braintrust client
		this.braintrustClient = new Braintrust({
			apiKey: options.braintrustApiKey,
			projectId: options.braintrustProjectId,
		})

		// Initialize OpenAI client for API compatibility
		this.client = new OpenAI({
			apiKey: options.braintrustApiKey,
			baseURL: `${baseURL}/v1`,
			defaultHeaders: {
				"X-Project-Id": options.braintrustProjectId,
			},
		})

		this.startModelAvailabilityCheck()
	}

	private logDebug(message: string): void {
		if (!this.enableDebugOutput) return
		this.log(`[DEBUG] ${message}`)
	}

	private logInfo(message: string): void {
		this.log(`[INFO] ${message}`)
	}

	private logError(message: string): void {
		this.log(`[ERROR] ${message}`)
	}

	private log(message: string): void {
		if ((!this.enableDebugOutput && !this.logConversations) || !this.outputChannel) return
		this.logQueue.push(message)

		if (this.logQueue.length >= this.LOG_BATCH_SIZE) {
			this.flushLogs()
			return
		}

		if (this.logTimeout) {
			clearTimeout(this.logTimeout)
		}

		this.logTimeout = setTimeout(() => {
			this.flushLogs()
		}, this.LOG_DEBOUNCE_MS)
	}

	private flushLogs(): void {
		if (!this.outputChannel || this.logQueue.length === 0) return

		const logs = this.logQueue.join("\n")
		this.outputChannel.appendLine(logs)
		this.logQueue = []
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const model = await this.getModel()
		this.logDebug(`Creating message stream with model ${model.id}`)

		if (this.logConversations) {
			this.logInfo("=== COMPLETE CONVERSATION ===")
			this.logInfo(`System prompt: ${systemPrompt}`)
			messages.forEach((msg, i) => {
				this.logInfo(`Message ${i + 1} (${msg.role}): ${msg.content}`)
			})
		}

		const openAiMessages = [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)]

		try {
			const stream = await this.client.chat.completions.create({
				model: model.id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
				stream: true,
			})

			// Start Braintrust logging
			const experiment = await this.braintrustClient.startExperiment({
				model: model.id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
			})

			for await (const chunk of stream) {
				const content = chunk.choices[0]?.delta?.content || ""
				if (content) {
					yield new ApiStreamTextChunk(content)
				}
			}

			// Log completion to Braintrust
			await experiment.log({
				output: stream.choices[0]?.message?.content || "",
				metrics: {
					tokens: stream.usage?.total_tokens || 0,
				},
			})
		} catch (error) {
			this.logError(`Error creating message: ${error instanceof Error ? error.message : "Unknown error"}`)
			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const model = await this.getModel()
		this.logDebug(`Completing prompt with model ${model.id}`)

		try {
			const response = await this.client.chat.completions.create({
				model: model.id,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
				stream: false,
			})

			// Log to Braintrust
			const experiment = await this.braintrustClient.startExperiment({
				model: model.id,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
			})

			await experiment.log({
				output: response.choices[0]?.message?.content || "",
				metrics: {
					tokens: response.usage?.total_tokens || 0,
				},
			})

			return response.choices[0]?.message?.content || ""
		} catch (error) {
			this.logError(`Error completing prompt: ${error instanceof Error ? error.message : "Unknown error"}`)
			throw error
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		if (this.cachedModel) {
			return this.cachedModel
		}

		const config = vscode.workspace.getConfiguration("roo-cline")
		const braintrustConfig = config.get<{
			models: Record<string, ModelInfo>
		}>("braintrustConfig")

		if (!braintrustConfig?.models) {
			throw new Error("No Braintrust models configured")
		}

		const modelId = this.options.apiModelId || Object.keys(braintrustConfig.models)[0]
		if (!modelId) {
			throw new Error("No model ID specified")
		}

		const modelInfo = braintrustConfig.models[modelId]
		if (!modelInfo) {
			throw new Error(`Model ${modelId} not found in configuration`)
		}

		this.cachedModel = { id: modelId, info: modelInfo }
		return this.cachedModel
	}

	private startModelAvailabilityCheck(): void {
		this.modelCheckInterval = setInterval(() => {
			this.checkModelAvailability()
		}, MODEL_CHECK_INTERVAL)
	}

	private async checkModelAvailability(): Promise<void> {
		try {
			const model = this.getModel()
			this.logDebug(`Checking availability of model ${model.id}`)
			// Implement model availability check if needed
		} catch (error) {
			this.logError(
				`Error checking model availability: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	dispose(): void {
		this.logDebug("Disposing handler")
		this.flushLogs()
		if (this.modelCheckInterval) {
			clearInterval(this.modelCheckInterval)
		}
	}
}
