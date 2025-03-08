import * as vscode from "vscode"
import { OcrService } from "./OcrService"
import { ProcessOptions, OcrServiceConfig } from "./types"
import { logger } from "../../utils/logging"

export class ProcessCommand {
	private ocrService: OcrService

	constructor(config: OcrServiceConfig) {
		this.ocrService = new OcrService(config)
	}

	static async createForVSCode(): Promise<ProcessCommand> {
		return new ProcessCommand({
			type: "vscode",
			vsCodeConfig: { configurationName: "" }, // Will be loaded from settings
		})
	}

	static async createForChat(profileName: string): Promise<ProcessCommand> {
		return new ProcessCommand({
			type: "profile",
			profileName,
		})
	}

	async execute(uri: vscode.Uri, options: ProcessOptions = {}): Promise<void> {
		try {
			logger.info("Processing document with OCR", {
				file: uri.fsPath,
				options,
			})

			// Load the document
			const document = await this.ocrService.loadDocument(uri.fsPath)

			// Process the document
			const result = await this.ocrService.processDocument(document, options)

			// Display results in a new editor
			const resultDocument = await vscode.workspace.openTextDocument({
				content: result.markdown,
				language: "markdown",
			})

			await vscode.window.showTextDocument(resultDocument, {
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			})

			if (result.visualizations) {
				logger.info("Document visualizations available", {
					types: Object.keys(result.visualizations),
				})
			}
		} catch (error) {
			logger.error("Error executing process command", { error })

			let errorMessage = "Failed to process document"

			if (error instanceof Error) {
				if (error.message.includes("No configuration profile specified")) {
					errorMessage =
						"OCR configuration not found. Please configure an OCR-capable API profile in VS Code settings (File > Preferences > Settings > Roo Code OCR API)."
				} else if (error.message.includes("does not support OCR")) {
					errorMessage =
						"The selected model does not support OCR. Please ensure you're using the 'mistral-ocr-latest' model in your API configuration."
				} else if (error.message.includes("Failed to load API configuration")) {
					errorMessage = "Failed to load API configuration. Please check your API key and profile settings."
				} else {
					errorMessage = `Processing failed: ${error.message}`
				}
			}

			// Show error message to user
			await vscode.window.showErrorMessage(errorMessage, {
				modal: true,
				detail: "For help, see the OCR setup guide in the documentation.",
			})

			throw error
		}
	}

	async registerCommand(context: vscode.ExtensionContext): Promise<void> {
		const disposable = vscode.commands.registerCommand("roo-cline.process", async (uri: vscode.Uri) => {
			if (!uri) {
				// If no URI provided, show file picker
				const files = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					filters: {
						"Supported Files": ["pdf", "png", "jpg", "jpeg"],
					},
				})

				if (!files || files.length === 0) {
					return
				}

				uri = files[0]
			}

			// Show options quick pick
			const options = await this.showOptionsQuickPick()

			if (options) {
				await this.execute(uri, options)
			}
		})

		context.subscriptions.push(disposable)
	}

	private async showOptionsQuickPick(): Promise<ProcessOptions | undefined> {
		const option = await vscode.window.showQuickPick(
			[
				{
					label: "$(file-text) Basic Text Extraction",
					description: "Extract text content only",
					value: {
						extractTables: false,
						analyzeLayout: false,
						generateVisuals: false,
					},
				},
				{
					label: "$(table) Table Detection",
					description: "Extract text and detect tables",
					value: {
						extractTables: true,
						analyzeLayout: false,
						generateVisuals: false,
					},
				},
				{
					label: "$(layout) Full Document Analysis",
					description: "Layout analysis with visual representations",
					value: {
						extractTables: true,
						analyzeLayout: true,
						generateVisuals: true,
					},
				},
			],
			{
				placeHolder: "Select processing options",
			},
		)

		return option?.value
	}
}
