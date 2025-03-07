import { logger } from "../../utils/logging"
import { DocumentContent, DocumentOutput, ApiConfiguration } from "../../shared/api"
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
		if (this.serviceConfig.type === "profile") {
			// Get API config from profile name
			// TODO: Implement getting API config from profile name
			return {} as ApiConfiguration
		} else {
			const vsConfig = await vscode.workspace.getConfiguration("roo-cline.ocr-api")
			const configName = vsConfig.get<string>("configuration-name")
			if (!configName) {
				throw new Error("No configuration profile specified in VS Code settings")
			}
			// TODO: Implement getting API config from configuration name
			return {} as ApiConfiguration
		}
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
		const { systemPrompt, userTemplates } = this.config.textProcessing

		// Select template based on type
		const template = userTemplates[type]

		// Combine with system prompt
		return `${systemPrompt}\n\n${template}`
	}

	async processDocument(document: DocumentContent, options: ProcessOptions = {}): Promise<DocumentOutput> {
		try {
			logger.info("Processing document", { options })

			const { analyze = false, visualize = false, vizType = "layout" } = options

			// TODO: Implement actual document processing
			const output: DocumentOutput = {
				markdown: "", // Placeholder for actual OCR text
				structure: analyze
					? {
							sections: [],
						}
					: undefined,
				visualizations: visualize
					? {
							[vizType]: vizType === "tables" ? [] : "",
						}
					: undefined,
			}

			if (options.save) {
				await this.saveOutput(output)
			}

			return output
		} catch (error) {
			logger.error("Error processing document", { error })
			throw new Error("Failed to process document")
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
