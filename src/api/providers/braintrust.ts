import * as vscode from "vscode"
import OpenAI from "openai"
import { Anthropic } from "@anthropic-ai/sdk"
import { Braintrust } from "@braintrust/api"
import { ApiHandler, SingleCompletionHandler } from "../"
import { ApiHandlerOptions, ModelInfo } from "../../shared/api"
import { BraintrustConfig } from "../../shared/api-types"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { logger } from "../../utils/logging"

const MODEL_CHECK_INTERVAL = 60000 // 1 minute
const DEFAULT_TEMPERATURE = 0
const DEFAULT_BASE_URL = "https://api.braintrustdata.com"

export class BraintrustHandler implements ApiHandler, SingleCompletionHandler {
	private readonly client: OpenAI
	private readonly braintrustClient: Braintrust
	private readonly options: ApiHandlerOptions
	private cachedModel: { id: string; info: ModelInfo } | null = null
	private modelCheckInterval?: NodeJS.Timeout
	private static sharedOutputChannel?: vscode.OutputChannel
	private outputChannel?: vscode.OutputChannel
	private readonly enableDebugOutput: boolean
	private readonly logConversations: boolean
	private readonly LOG_BATCH_SIZE = 10
	private readonly LOG_DEBOUNCE_MS = 1000
	private logQueue: string[] = []
	private logTimeout?: NodeJS.Timeout

	constructor(options: ApiHandlerOptions) {
		this.options = options

		// Get debug settings from workspace configuration
		const debugConfig = vscode.workspace.getConfiguration("roo-cline.debug")
		this.enableDebugOutput = debugConfig.get("braintrust") ?? false
		this.logConversations = debugConfig.get("braintrust-conversation") ?? false

		if (!options.braintrustApiKey) {
			throw new Error("Braintrust API key is required")
		}

		if (!options.braintrustProjectId) {
			throw new Error("Braintrust Project ID is required")
		}

		// Initialize OpenAI client for API compatibility
		this.client = new OpenAI({
			apiKey: options.braintrustApiKey,
			baseURL: `${options.braintrustBaseUrl || DEFAULT_BASE_URL}/v1`,
		})

		// Initialize Braintrust client for experiment logging
		this.braintrustClient = new Braintrust({
			apiKey: options.braintrustApiKey,
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

		try {
			// Convert messages to OpenAI format
			const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
				{ role: "system", content: systemPrompt } as OpenAI.Chat.ChatCompletionSystemMessageParam,
				...convertToOpenAiMessages(messages),
			]
			// Create experiment and span for tracking
			const experiment = await this.braintrustClient.experiments.create({
				name: "Chat Completion",
				project_id: this.options.braintrustProjectId!,
				metadata: {
					model: model.id,
					messages: allMessages,
					temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
					type: "streaming",
				},
			})

			// Create completion stream
			const streamResponse = await this.client.chat.completions.create({
				model: model.id,
				messages: allMessages,
				temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
				stream: true,
			})

			let fullResponse = ""

			// Stream the response
			for await (const chunk of streamResponse) {
				const content = chunk.choices[0]?.delta?.content || ""
				if (content) {
					fullResponse += content
					yield { type: "text", text: content }
				}
			}

			// Log experiment results
			await this.braintrustClient.experiments.create({
				name: "Chat Completion Results",
				project_id: this.options.braintrustProjectId!,
				metadata: {
					completion: fullResponse,
					completion_tokens: Math.ceil(fullResponse.length / 4),
					parent_experiment: experiment.name,
				},
			})

			// Log LLM metrics as a separate experiment
			await this.braintrustClient.experiments.create({
				name: "LLM Call Metrics",
				project_id: this.options.braintrustProjectId!,
				metadata: {
					type: "llm_call",
					model: model.id,
					input_messages: allMessages,
					output_completion: fullResponse,
					completion_tokens: Math.ceil(fullResponse.length / 4),
					temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
					parent_experiment: experiment.name,
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
			const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: prompt }]

			// Create experiment for tracking
			const experiment = await this.braintrustClient.experiments.create({
				name: "Prompt Completion",
				project_id: this.options.braintrustProjectId!,
				metadata: {
					model: model.id,
					messages,
					temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
				},
			})

			const response = await this.client.chat.completions.create({
				model: model.id,
				messages,
				temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
				stream: false,
			})

			const output = response.choices[0]?.message?.content || ""

			// Log another experiment with the results
			await this.braintrustClient.experiments.create({
				name: "Prompt Completion Results",
				project_id: this.options.braintrustProjectId!,
				metadata: {
					completion: output,
					completion_tokens: Math.ceil(output.length / 4),
					total_tokens: response.usage?.total_tokens,
					parent_experiment: experiment.name,
				},
			})

			// Log LLM metrics as a separate experiment
			await this.braintrustClient.experiments.create({
				name: "LLM Call Metrics",
				project_id: this.options.braintrustProjectId!,
				metadata: {
					type: "llm_call",
					model: model.id,
					input_messages: messages,
					output_completion: output,
					completion_tokens: Math.ceil(output.length / 4),
					total_tokens: response.usage?.total_tokens,
					temperature: this.options.modelTemperature ?? DEFAULT_TEMPERATURE,
					parent_experiment: experiment.name,
				},
			})

			return output
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
		// Get model configuration directly from VS Code settings
		const braintrustConfig = config.get<BraintrustConfig>("braintrustConfig")

		// Use settings-managed models
		if (!braintrustConfig?.models) {
			throw new Error("No Braintrust models configured in VS Code settings")
		}

		const modelId = this.options.apiModelId || braintrustConfig.defaultModelId
		if (!modelId) {
			throw new Error("No model ID specified in settings")
		}

		const modelInfo = braintrustConfig.models[modelId]
		if (!modelInfo) {
			throw new Error(`Model ${modelId} not found in VS Code settings configuration`)
		}

		this.cachedModel = { id: modelId, info: modelInfo }
		return this.cachedModel
	}

	getBraintrustModels(): Record<string, ModelInfo> {
		const config = vscode.workspace.getConfiguration("roo-cline")
		const braintrustConfig = config.get<BraintrustConfig>("braintrustConfig")
		return braintrustConfig?.models || {}
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
