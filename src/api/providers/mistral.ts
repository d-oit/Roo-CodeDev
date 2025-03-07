import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import { ApiHandler } from "../"
import {
	ApiHandlerOptions,
	mistralDefaultModelId,
	MistralModelId,
	mistralModels,
	ModelInfo,
	DocumentContent,
	DocumentOutput,
} from "../../shared/api"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStream } from "../transform/stream"
import * as vscode from "vscode"

const MISTRAL_DEFAULT_TEMPERATURE = 0

class DocumentProcessingError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DocumentProcessingError"
	}
}

class UnsupportedDocumentTypeError extends Error {
	constructor(mimeType: string) {
		super(`Unsupported document type: ${mimeType}`)
		this.name = "UnsupportedDocumentTypeError"
	}
}

export class MistralHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: Mistral
	private readonly enableDebugOutput: boolean
	private readonly outputChannel?: vscode.OutputChannel
	private cachedModel: { id: MistralModelId; info: ModelInfo; forModelId: string | undefined } | null = null

	private static readonly outputChannelName = "Roo Code Mistral"
	private static sharedOutputChannel: vscode.OutputChannel | undefined

	constructor(options: ApiHandlerOptions) {
		if (!options.mistralApiKey) {
			throw new Error("Mistral API key is required")
		}

		// Clear cached model if options change
		this.cachedModel = null

		// Destructure only the options we need
		const {
			apiModelId,
			mistralApiKey,
			mistralCodestralUrl,
			mistralModelStreamingEnabled,
			modelTemperature,
			stopToken,
			includeMaxTokens,
		} = options

		this.options = {
			apiModelId: apiModelId || mistralDefaultModelId,
			mistralApiKey,
			mistralCodestralUrl,
			mistralModelStreamingEnabled,
			modelTemperature,
			stopToken,
			includeMaxTokens,
		}

		const config = vscode.workspace.getConfiguration("roo-cline")
		this.enableDebugOutput = config.get<boolean>("debug.mistral", false)

		if (this.enableDebugOutput) {
			if (!MistralHandler.sharedOutputChannel) {
				MistralHandler.sharedOutputChannel = vscode.window.createOutputChannel(MistralHandler.outputChannelName)
			}
			this.outputChannel = MistralHandler.sharedOutputChannel
		}

		this.logDebug(`Initializing MistralHandler with options: ${JSON.stringify(this.options, null, 2)}`)
		const baseUrl = this.getBaseUrl()
		this.logDebug(`MistralHandler using baseUrl: ${baseUrl}`)

		const logger = {
			group: (message: string) => {
				if (this.enableDebugOutput && this.outputChannel) {
					this.outputChannel.appendLine(`[Mistral SDK] Group: ${message}`)
				}
			},
			groupEnd: () => {
				if (this.enableDebugOutput && this.outputChannel) {
					this.outputChannel.appendLine(`[Mistral SDK] GroupEnd`)
				}
			},
			log: (...args: any[]) => {
				if (this.enableDebugOutput && this.outputChannel) {
					const formattedArgs = args
						.map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : arg))
						.join(" ")
					this.outputChannel.appendLine(`[Mistral SDK] ${formattedArgs}`)
				}
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

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		this.logDebug(`Creating message with system prompt: ${systemPrompt}`)

		const response = await this.client.chat.stream({
			model: this.options?.apiModelId || mistralDefaultModelId,
			maxTokens: this.options?.includeMaxTokens ? this.getModel().info.maxTokens : undefined,
			messages: [{ role: "system", content: systemPrompt }, ...convertToMistralMessages(messages)],
			temperature: this.options?.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE,
			...(this.options?.mistralModelStreamingEnabled === true && { stream: true }),
			...(this.options?.stopToken?.trim() && { stop: [this.options.stopToken] }),
		})

		let completeContent = ""

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
		}
	}

	getModel(): { id: MistralModelId; info: ModelInfo } {
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

	/**
	 * Process a document using Mistral's document understanding capabilities.
	 * This method requires a model that supports document processing (e.g., mistral-ocr-latest).
	 *
	 * @param document - The document to process (PDF or image)
	 * @param options - Processing options
	 * @param options.extractTables - Whether to detect and extract tables
	 * @param options.analyzeLayout - Whether to analyze document layout
	 * @param options.generateVisuals - Whether to generate visual representations
	 * @returns Processed document with markdown content and optional visualizations
	 * @throws {DocumentProcessingError} When processing fails
	 * @throws {UnsupportedDocumentTypeError} When document type is not supported
	 */
	async processDocument(
		document: DocumentContent,
		options?: {
			extractTables?: boolean
			analyzeLayout?: boolean
			generateVisuals?: boolean
		},
	): Promise<DocumentOutput> {
		const model = this.getModel()
		if (!model.info.documentProcessing?.supported) {
			throw new Error("Current model does not support document processing")
		}

		this.logDebug(`Processing document with options: ${JSON.stringify(options)}`)

		try {
			const systemPrompt = this.getDocumentProcessingPrompt(options)
			const base64Data =
				document.type === "base64" ? document.data : await this.fetchAndEncodeImage(document.data)

			const response = await this.client.chat.complete({
				model: model.id,
				messages: [
					{ role: "system", content: this.getDocumentProcessingPrompt(options) },
					{
						role: "user",
						content: `[Document to process: data:${document.mimeType};base64,${base64Data}]

Please analyze this document and provide a well-formatted markdown representation.`,
					},
				],
				temperature: 0,
			})

			const content = response.choices?.[0]?.message?.content
			const markdown = typeof content === "string" ? content : ""

			return {
				markdown,
				structure: this.extractStructure(markdown),
				...(options?.generateVisuals && model.info.documentProcessing.capabilities.visualization
					? { visualizations: await this.generateVisualizations(document) }
					: {}),
			}
		} catch (error) {
			this.logDebug(`Document processing error: ${error instanceof Error ? error.message : String(error)}`)
			throw new DocumentProcessingError(
				`Failed to process document: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private getDocumentProcessingPrompt(options?: { extractTables?: boolean; analyzeLayout?: boolean }): string {
		return `You are a document processing assistant. Your task is to:
1. Extract and format all text content
2. ${options?.extractTables ? "Detect and preserve table structures" : ""}
3. ${options?.analyzeLayout ? "Preserve document layout and structure" : ""}
4. Generate well-formatted markdown output
Please maintain the document's original structure and formatting as much as possible.`
	}

	private async fetchAndEncodeImage(url: string): Promise<string> {
		try {
			const response = await fetch(url)
			const arrayBuffer = await response.arrayBuffer()
			return Buffer.from(arrayBuffer).toString("base64")
		} catch (error) {
			throw new DocumentProcessingError(
				`Failed to fetch image from URL: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private extractStructure(markdown: string): DocumentOutput["structure"] {
		const lines = markdown.split("\n")
		const structure: DocumentOutput["structure"] = { sections: [] }
		let currentSection: { heading?: string; content: string } = { content: "" }

		for (const line of lines) {
			if (line.startsWith("#")) {
				// If we have content in the current section, save it
				if (currentSection.content.trim()) {
					structure.sections?.push({ ...currentSection })
				}
				// Start new section
				currentSection = {
					heading: line.replace(/^#+\s*/, ""),
					content: "",
				}
			} else {
				currentSection.content += line + "\n"
			}
		}

		// Add the last section
		if (currentSection.content.trim()) {
			structure.sections?.push(currentSection)
		}

		return structure
	}

	/**
	 * Generate visual representations of the document structure.
	 * This includes layout analysis and section relationships.
	 *
	 * @param document - The document to visualize
	 * @returns Object containing base64-encoded visualizations, or undefined if visualization is not supported
	 * @private
	 */
	private async generateVisualizations(document: DocumentContent): Promise<DocumentOutput["visualizations"]> {
		const model = this.getModel()
		if (!model.info.documentProcessing?.capabilities.visualization) {
			return undefined
		}

		try {
			const base64Data =
				document.type === "base64" ? document.data : await this.fetchAndEncodeImage(document.data)

			// Generate layout visualization
			const layoutResponse = await this.client.chat.complete({
				model: model.id,
				messages: [
					{
						role: "system",
						content:
							"Analyze the document layout and return a visualization that highlights the document structure.",
					},
					{
						role: "user",
						content: `[Document to analyze: data:${document.mimeType};base64,${base64Data}]`,
					},
				],
				temperature: 0,
			})

			// Generate sections visualization
			const sectionsResponse = await this.client.chat.complete({
				model: model.id,
				messages: [
					{
						role: "system",
						content: "Create a visual representation of the document's sections and their relationships.",
					},
					{
						role: "user",
						content: `[Document to analyze: data:${document.mimeType};base64,${base64Data}]`,
					},
				],
				temperature: 0,
			})

			// Extract visualizations from responses
			const layout = this.extractVisualizationFromResponse(layoutResponse)
			const sections = this.extractVisualizationFromResponse(sectionsResponse)

			return {
				layout,
				sections,
				// Tables visualization will be added when supported by Mistral
				tables: [],
			}
		} catch (error) {
			this.logDebug(`Visualization generation error: ${error instanceof Error ? error.message : String(error)}`)
			return undefined
		}
	}

	private extractVisualizationFromResponse(response: any): string | undefined {
		try {
			const content = response.choices?.[0]?.message?.content
			if (typeof content === "string") {
				// Extract base64 image data from content
				const match = content.match(/data:image\/[^;]+;base64,([^"'\s]+)/)
				return match?.[1]
			}
			return undefined
		} catch {
			return undefined
		}
	}
}
