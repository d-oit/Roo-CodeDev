import * as vscode from "vscode"
import { EventEmitter } from "events"
import { OCRTaskDefinition } from "./OCRTaskProvider"
import { OcrService } from "../OcrService"
import { logger } from "../../../utils/logging"

export class OCRTaskTerminal implements vscode.Pseudoterminal {
	private writeEmitter = new vscode.EventEmitter<string>()
	private closeEmitter = new vscode.EventEmitter<number>()
	private ocrService: OcrService

	onDidWrite: vscode.Event<string> = this.writeEmitter.event
	onDidClose: vscode.Event<number> = this.closeEmitter.event

	constructor(private readonly taskDefinition: OCRTaskDefinition) {
		this.ocrService = new OcrService({
			type: "vscode",
			vsCodeConfig: { configurationName: "" }, // Will be loaded from settings
		})
	}

	async open(): Promise<void> {
		try {
			this.writeEmitter.fire(`Starting OCR processing for ${this.taskDefinition.source}\r\n`)

			// Load document
			this.writeEmitter.fire("Loading document...\r\n")
			const document = await this.ocrService.loadDocument(this.taskDefinition.source)

			// Map task options to document processing options
			const processOptions = {
				extractTables: this.taskDefinition.options.extractTables ?? false,
				analyzeLayout: this.taskDefinition.options.analyzeLayout ?? false,
				generateVisuals: this.taskDefinition.options.generateVisuals ?? false,
			}

			// Process document
			this.writeEmitter.fire("Processing document...\r\n")
			const result = await this.ocrService.processDocument(document, processOptions)

			// Display results
			if (result.markdown) {
				const resultDocument = await vscode.workspace.openTextDocument({
					content: result.markdown,
					language: "markdown",
				})

				await vscode.window.showTextDocument(resultDocument, {
					preview: true,
					viewColumn: vscode.ViewColumn.Beside,
				})
			}

			this.writeEmitter.fire("OCR processing completed successfully\r\n")
			this.closeEmitter.fire(0) // Success
		} catch (error) {
			logger.error("Error in OCR task execution", { error })
			this.writeEmitter.fire(`Error: ${error instanceof Error ? error.message : "Unknown error"}\r\n`)
			this.closeEmitter.fire(1) // Error
		}
	}

	close(): void {
		// Nothing to clean up
	}
}
