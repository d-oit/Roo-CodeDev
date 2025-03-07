import * as vscode from "vscode"
import { OcrService } from "./OcrService"
import { ProcessOptions } from "./types"
import { logger } from "../../utils/logging"

export class ProcessCommand {
	constructor(private readonly ocrService: OcrService) {}

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
				// TODO: Implement visualization display
				logger.info("Document visualizations available", {
					types: Object.keys(result.visualizations),
				})
			}
		} catch (error) {
			logger.error("Error executing process command", { error })
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
					value: { analyze: false, visualize: false },
				},
				{
					label: "$(table) Table Detection",
					description: "Extract text and detect tables",
					value: { analyze: true, visualize: true, vizType: "tables" as const },
				},
				{
					label: "$(layout) Layout Analysis",
					description: "Full document layout analysis",
					value: { analyze: true, visualize: true, vizType: "layout" as const },
				},
				{
					label: "$(symbol-structure) Document Structure",
					description: "Analyze document structure and sections",
					value: { analyze: true, visualize: true, vizType: "sections" as const },
				},
			],
			{
				placeHolder: "Select processing options",
			},
		)

		return option?.value
	}
}
