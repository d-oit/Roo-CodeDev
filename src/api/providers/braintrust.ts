import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { initLogger, wrapOpenAI, wrapTraced } from "braintrust"
import { ApiHandler, SingleCompletionHandler } from "../"
import { ApiHandlerOptions, braintrustDefaultModelId, ModelInfo } from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream, ApiStreamTextChunk, ApiStreamUsageChunk } from "../transform/stream"
import { logger } from "../../utils/logging"

const BRAINTRUST_DEFAULT_TEMPERATURE = 0
const MODEL_CHECK_INTERVAL = 60000 // 1 minute
const BRAINTRUST_BASE_URL = "https://api.braintrust.dev/v1"

export class BraintrustHandler implements ApiHandler, SingleCompletionHandler {
	private options: ApiHandlerOptions
	private client: OpenAI
	private braintrustLogger: ReturnType<typeof initLogger>
	private wrappedClient: OpenAI
	private cachedModel: { id: string; info: ModelInfo } | null = null
	private cachedModelId: string | null = null
	private modelCheckInterval?: NodeJS.Timeout
	private handlerLogger = logger.child({ ctx: "BraintrustHandler" })
	private outputChannel!: vscode.OutputChannel
	private static sharedOutputChannel: vscode.OutputChannel | undefined
	private enableDebugOutput: boolean = false
	private logConversations: boolean = false
	private logQueue: string[] = []
	private logTimeout: NodeJS.Timeout | null = null
	private readonly LOG_BATCH_SIZE = 10
	private readonly LOG_DEBOUNCE_MS = 100

	constructor(options: ApiHandlerOptions) {
		if (!options.braintrustApiKey) {
			throw new Error("Braintrust API key is required")
		}

		this.options = options
		const baseURL = options.braintrustBaseUrl || BRAINTRUST_BASE_URL

		// Initialize debug configuration
		const debugConfig = vscode.workspace.getConfiguration("roo")
		this.enableDebugOutput = debugConfig.get<boolean>("braintrust-debug", false)
		this.logConversations = debugConfig.get<boolean>("braintrust-conversation", false)

		// Only create and use the output channel if debugging or conversation logging is enabled
		if (this.enableDebugOutput || this.logConversations) {
			if (!BraintrustHandler.sharedOutputChannel) {
				BraintrustHandler.sharedOutputChannel = vscode.window.createOutputChannel("Roo Code Braintrust")
			}
			this.outputChannel = BraintrustHandler.sharedOutputChannel

			this.logInfo("Braintrust Handler initialized")
			this.logInfo(`Debug output ${this.enableDebugOutput ? "enabled" : "disabled"}`)
			this.logInfo(`Conversation logging ${this.logConversations ? "enabled" : "disabled"}`)
		}

		this.handlerLogger.info("Initializing Braintrust handler", {
			baseURL,
			projectId: options.braintrustProjectId,
		})

		this.braintrustLogger = initLogger({
			apiKey: options.braintrustApiKey,
			projectId: options.braintrustProjectId || undefined,
		})

		this.client = new OpenAI({
			apiKey: options.braintrustApiKey,
			baseURL,
			defaultHeaders: {
				"X-Project-Id": options.braintrustProjectId || "",
			},
		})

		// Wrap the OpenAI client for Braintrust logging
		this.wrappedClient = wrapOpenAI(this.client)

		// Start model availability checking
		this.startModelAvailabilityCheck()

		// Listen for configuration changes
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("roo")) {
				const debugConfig = vscode.workspace.getConfiguration("roo")
				const previousDebugEnabled = this.enableDebugOutput
				const previousConversationLoggingEnabled = this.logConversations

				this.enableDebugOutput = debugConfig.get<boolean>("braintrust-debug", false)
				this.logConversations = debugConfig.get<boolean>("braintrust-conversation", false)

				if (
					(this.enableDebugOutput || this.logConversations) &&
					!previousDebugEnabled &&
					!previousConversationLoggingEnabled
				) {
					if (!BraintrustHandler.sharedOutputChannel) {
						BraintrustHandler.sharedOutputChannel = vscode.window.createOutputChannel("Roo Code Braintrust")
					}
					this.outputChannel = BraintrustHandler.sharedOutputChannel
				}

				if (this.enableDebugOutput || this.logConversations) {
					this.logInfo(`Debug output ${this.enableDebugOutput ? "enabled" : "disabled"}`)
					this.logInfo(`Conversation logging ${this.logConversations ? "enabled" : "disabled"}`)
				}
			}
		})

		// Add configuration change listener
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("roo-cline.braintrustConfig")) {
				this.refreshModelCache()
				// Notify UI of model changes
				vscode.commands.executeCommand("roo.refreshBraintrustModels")
			}
		})
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
		if (this.logQueue.length === 0 || !this.outputChannel) {
			return
		}

		const message = this.logQueue.join("\n")
		this.outputChannel.appendLine(message)

		this.logQueue = []
		if (this.logTimeout) {
			clearTimeout(this.logTimeout)
			this.logTimeout = null
		}
	}

	private logInfo(message: string): void {
		if (!this.logConversations || !this.outputChannel) return
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		this.log(`[${timestamp}] INFO: ${message}`)
	}

	private logError(message: string): void {
		if (!this.outputChannel) return
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		this.log(`[${timestamp}] ERROR: ${message}`)
	}

	private logDebug(message: string): void {
		if (!this.enableDebugOutput || !this.outputChannel) return
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		this.log(`[${timestamp}] DEBUG: ${message}`)
	}

	private logWarning(message: string): void {
		if (!this.outputChannel) return
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
		this.log(`[${timestamp}] WARNING: ${message}`)
	}

	private async isModelAvailable(modelId: string): Promise<boolean> {
		const models = this.getBraintrustModels()
		const available = modelId in models
		this.logDebug(`Checking model availability: modelId=${modelId}, available=${available}`)
		return available
	}

	startModelAvailabilityCheck(intervalMs: number = MODEL_CHECK_INTERVAL): void {
		// Clear any existing interval
		this.stopModelAvailabilityCheck()

		this.logDebug(`Starting model availability check with interval ${intervalMs}ms`)

		// Set up new interval
		this.modelCheckInterval = setInterval(async () => {
			if (!this.cachedModel || !this.cachedModelId) return

			try {
				const isAvailable = await this.isModelAvailable(this.cachedModelId)
				if (!isAvailable) {
					this.logWarning(`Model no longer available, refreshing cache: modelId=${this.cachedModelId}`)
					await this.refreshModelCache()
				}
			} catch (error) {
				this.logError(
					`Error in model availability check: error=${error instanceof Error ? error.message : "Unknown error"}, modelId=${this.cachedModelId}`,
				)
			}
		}, intervalMs)
	}

	stopModelAvailabilityCheck(): void {
		if (this.modelCheckInterval) {
			this.logDebug("Stopping model availability check")
			clearInterval(this.modelCheckInterval)
			this.modelCheckInterval = undefined
		}
	}

	private async refreshModelCache(): Promise<void> {
		this.logDebug("Refreshing model cache")
		// Clear the cached model
		this.cachedModel = null
		this.cachedModelId = null

		// Force a new model fetch
		await this.getModel()
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const model = this.getModel()
		this.logDebug(`Creating message stream with model ${model.id}`)

		if (this.logConversations) {
			this.logInfo("=== COMPLETE CONVERSATION ===")
			this.logInfo(`System prompt: ${systemPrompt}`)
			messages.forEach((msg, i) => {
				this.logInfo(`Message ${i + 1} (${msg.role}): ${msg.content}`)
			})
		}

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		try {
			// Use wrapped client for automatic logging
			const stream = await this.wrappedClient.chat.completions.create({
				model: model.id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? BRAINTRUST_DEFAULT_TEMPERATURE,
				stream: true,
			})

			for await (const chunk of stream) {
				const content = chunk.choices[0]?.delta?.content
				if (content) {
					yield { type: "text", text: content } as ApiStreamTextChunk
				}

				if (chunk.usage) {
					this.logDebug(
						`Stream usage stats: inputTokens=${chunk.usage.prompt_tokens}, outputTokens=${chunk.usage.completion_tokens}`,
					)
					this.handlerLogger.debug("Stream usage stats", {
						inputTokens: chunk.usage.prompt_tokens,
						outputTokens: chunk.usage.completion_tokens,
					})

					yield {
						type: "usage",
						inputTokens: chunk.usage.prompt_tokens,
						outputTokens: chunk.usage.completion_tokens,
					} as ApiStreamUsageChunk
				}
			}
		} catch (error) {
			this.logError(
				`Error creating message stream: error=${error instanceof Error ? error.message : "Unknown error"}, modelId=${model.id}`,
			)
			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const model = this.getModel()
		this.logDebug(`Completing prompt with model ${model.id}`)

		try {
			// Wrap the completion call with Braintrust logging
			const completion = wrapTraced(
				async () => {
					const response = await this.wrappedClient.chat.completions.create({
						model: model.id,
						messages: [{ role: "user", content: prompt }],
						temperature: this.options.modelTemperature ?? BRAINTRUST_DEFAULT_TEMPERATURE,
						stream: false,
					})
					return response.choices[0]?.message?.content || ""
				},
				{
					name: "completePrompt",
				},
			)

			return await completion()
		} catch (error) {
			this.logError(
				`Error completing prompt: error=${error instanceof Error ? error.message : "Unknown error"}, modelId=${model.id}`,
			)
			throw error
		}
	}

	public getBraintrustModels(): Record<string, ModelInfo> {
		const config = vscode.workspace.getConfiguration("roo-cline")
		const braintrustConfig = (config.get("braintrustConfig") as {
			defaultModelId?: string
			models?: Record<string, ModelInfo>
		}) || { models: {} }

		return braintrustConfig.models || {}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.apiModelId ?? braintrustDefaultModelId
		const models = this.getBraintrustModels()

		if (this.cachedModel && this.cachedModelId === modelId) {
			return this.cachedModel
		}

		const modelInfo = models[modelId]
		if (!modelInfo) {
			const error = `Model ${modelId} not found in Braintrust configuration`
			this.logError(error)
			throw new Error(error)
		}

		this.cachedModel = { id: modelId, info: modelInfo }
		this.cachedModelId = modelId

		return this.cachedModel
	}

	dispose(): void {
		this.logDebug("Disposing handler")
		this.flushLogs()
		this.stopModelAvailabilityCheck()
	}
}
