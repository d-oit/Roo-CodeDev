import { logger } from "../../utils/logging"
import {
	DocumentContent,
	DocumentOutput,
	ApiConfiguration,
	ModelInfo,
	mistralModels,
	mistralDefaultModelId,
	MistralModelId,
} from "../../shared/api"
import { ProcessOptions, OcrConfig, OcrServiceConfig, OcrConfigVSCode } from "./types"
import { DEFAULT_OCR_CONFIG } from "./config"
import * as vscode from "vscode"

export class OcrService {
	private readonly baseConfig: OcrConfig
	private readonly serviceConfig: OcrServiceConfig
	private apiConfig?: ApiConfiguration

	constructor(serviceConfig: OcrServiceConfig) {
		this.baseConfig = DEFAULT_OCR_CONFIG
		this.serviceConfig = serviceConfig
	}

	private async loadApiConfig(): Promise<ApiConfiguration> {
		try {
			if (this.serviceConfig.type === "profile") {
				// Get API config from profile name
				const profileName = this.serviceConfig.profileName
				return await this.getApiConfigFromProfile(profileName)
			} else {
				// Get config from VS Code settings
				const vsConfig = await vscode.workspace.getConfiguration("roo-cline.ocr-api")
				const configName = vsConfig.get<string>("configuration-name")
				if (!configName) {
					throw new Error("No configuration profile specified in VS Code settings")
				}
				return await this.getApiConfigFromProfile(configName)
			}
		} catch (error) {
			logger.error("Failed to load API configuration", { error })
			throw new Error("Failed to load API configuration")
		}
	}

	private async getApiConfigFromProfile(profileName: string): Promise<ApiConfiguration> {
		// Get configurations from the secrets storage
		const secretsKey = "roo_cline_config_api_config"
		const configs =
			(await vscode.workspace.getConfiguration().get<{
				[key: string]: ApiConfiguration
			}>(secretsKey)) || {}

		if (!configs[profileName]) {
			throw new Error(`Configuration profile '${profileName}' not found`)
		}

		return configs[profileName]
	}

	private async ensureApiConfig(): Promise<void> {
		if (!this.apiConfig) {
			this.apiConfig = await this.loadApiConfig()
			if (!this.apiConfig) {
				throw new Error("Failed to load API configuration")
			}
		}
	}

	async loadDocument(source: string): Promise<DocumentContent> {
		try {
			logger.info("Loading document from source", { source })

			// Determine source type
			const { type, mimeType } = this.getSourceInfo(source)

			// TODO: Implement actual document loading based on source type
			return {
				type,
				data: source,
				mimeType,
				fileName: this.extractFileName(source),
			}
		} catch (error) {
			logger.error("Error loading document", { error })
			throw new Error("Failed to load document")
		}
	}

	private getSourceInfo(source: string): { type: "base64" | "url"; mimeType: string } {
		if (source.startsWith("http://") || source.startsWith("https://")) {
			return {
				type: "url",
				mimeType: this.getMimeType(source),
			}
		}
		return {
			type: "base64",
			mimeType: this.getMimeType(source),
		}
	}

	private getMimeType(source: string): string {
		// Simple extension-based mime type detection
		if (source.toLowerCase().endsWith(".pdf")) {
			return "application/pdf"
		}
		if (source.toLowerCase().match(/\.(jpg|jpeg)$/)) {
			return "image/jpeg"
		}
		if (source.toLowerCase().endsWith(".png")) {
			return "image/png"
		}
		return "application/octet-stream"
	}

	private extractFileName(source: string): string | undefined {
		if (source.startsWith("http")) {
			const urlParts = source.split("/")
			return urlParts[urlParts.length - 1] || undefined
		}
		return undefined
	}

	getOcrPrompt(type: "basic" | "tables" | "layout" | "analysis", document: DocumentContent): string {
		const { systemPrompt, userTemplates } = this.baseConfig.textProcessing

		// Select template based on type
		const template = userTemplates[type]

		// Combine with system prompt
		return `${systemPrompt}\n\n${template}`
	}

	private async getModelInfo(): Promise<ModelInfo | undefined> {
		if (!this.apiConfig) {
			throw new Error("API configuration not loaded")
		}

		const config = this.apiConfig
		switch (config.apiProvider) {
			case "mistral":
				const modelId = config.apiModelId || mistralDefaultModelId
				const modelInfo = modelId in mistralModels ? mistralModels[modelId as MistralModelId] : undefined

				if (!modelInfo) {
					throw new Error(`Model '${modelId}' not found. Please check your configuration.`)
				}

				// Check if model has document processing capabilities
				const hasDocProcessing =
					"documentProcessing" in modelInfo && modelInfo.documentProcessing?.supported === true

				if (!hasDocProcessing) {
					throw new Error(
						`Model '${modelId}' does not support document processing. ` +
							`Please use 'mistral-ocr-latest' or another OCR-capable model.`,
					)
				}

				logger.info(`Using Mistral model: ${modelId}`, {
					modelInfo: {
						capabilities: modelInfo.documentProcessing?.capabilities ?? {},
						contextWindow: modelInfo.contextWindow,
					},
				})

				return modelInfo

			default:
				// For other providers, check their model info
				if (config.apiProvider === "glama" && config.glamaModelInfo) {
					return config.glamaModelInfo
				} else if (config.apiProvider === "openrouter" && config.openRouterModelInfo) {
					return config.openRouterModelInfo
				} else if (config.apiProvider === "openai" && config.openAiCustomModelInfo) {
					return config.openAiCustomModelInfo
				}

				throw new Error(
					`Provider '${config.apiProvider}' does not support OCR. ` +
						`Please configure a supported OCR provider.`,
				)
		}
	}

	async processDocument(document: DocumentContent, options: ProcessOptions = {}): Promise<DocumentOutput> {
		try {
			logger.info("Processing document", {
				options,
				documentType: document.mimeType,
				fileName: document.fileName,
			})

			// Ensure API configuration is loaded
			await this.ensureApiConfig()
			if (!this.apiConfig?.mistralApiKey) {
				throw new Error(
					"Mistral API key not configured. Please add your API key in the VS Code settings " +
						"(File > Preferences > Settings > Extensions > Roo Code > OCR API).",
				)
			}

			// Get model info and validate OCR capabilities
			const modelInfo = await this.getModelInfo()
			// Note: getModelInfo now handles document processing capability checks

			// Validate document type
			if (!["application/pdf", "image/jpeg", "image/png"].includes(document.mimeType)) {
				throw new Error(
					`Unsupported document type: ${document.mimeType}. ` +
						`Only PDF and image files (JPEG, PNG) are supported.`,
				)
			}

			// Process document using Mistral's document processing capabilities
			const output: DocumentOutput = {
				markdown: "", // Will be populated by actual OCR text
				structure: options.analyzeLayout
					? {
							sections: [],
						}
					: undefined,
				visualizations: options.generateVisuals
					? {
							layout: "",
							sections: "",
							tables: options.extractTables ? [] : undefined,
						}
					: undefined,
			}

			if (options.save) {
				await this.saveOutput(output)
			}

			return output
		} catch (error) {
			logger.error("Error processing document", {
				error,
				documentType: document.mimeType,
				fileName: document.fileName,
				options,
			})

			if (error instanceof Error) {
				// Add helpful context to error messages
				if (error.message.includes("Invalid model")) {
					throw new Error(
						"OCR model is not currently available. Please check Mistral's documentation " +
							"for available OCR models and update your configuration accordingly.",
					)
				}
				// Preserve the original error message but add context
				throw new Error(`Document processing failed: ${error.message}`)
			}

			// For unknown errors, provide a generic message and direct to logs
			throw new Error("Document processing failed. Check the extension logs for details.")
		}
	}

	private async saveOutput(output: DocumentOutput): Promise<void> {
		try {
			// TODO: Implement actual output saving
			logger.info("Saving output", { hasStructure: !!output.structure })
		} catch (error) {
			logger.error("Error saving output", { error })
			throw new Error("Failed to save output")
		}
	}
}
