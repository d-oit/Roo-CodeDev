import * as vscode from "vscode"
import { EventEmitter } from "events"
import { OCRTaskDefinition } from "./OCRTaskProvider"
import { OcrService } from "../OcrService"
import { logger } from "../../../utils/logging"

export class OCRTaskTerminal implements vscode.Pseudoterminal {
	private writeEmitter = new vscode.EventEmitter<string>()
	private closeEmitter = new vscode.EventEmitter<number>()
	private ocrService: OcrService
	private outputChannel: vscode.OutputChannel
	private static readonly OUTPUT_CHANNEL_NAME = "OCR Tasks"

	onDidWrite: vscode.Event<string> = this.writeEmitter.event
	onDidClose: vscode.Event<number> = this.closeEmitter.event

	constructor(private readonly taskDefinition: OCRTaskDefinition) {
		this.ocrService = new OcrService({
			type: "vscode",
			vsCodeConfig: { configurationName: "" }, // Will be loaded from settings
		})

		// Get or create shared output channel
		this.outputChannel = this.getOutputChannel()
	}

	private static sharedOutputChannel: vscode.OutputChannel | undefined

	private getOutputChannel(): vscode.OutputChannel {
		if (!OCRTaskTerminal.sharedOutputChannel) {
			OCRTaskTerminal.sharedOutputChannel = vscode.window.createOutputChannel(OCRTaskTerminal.OUTPUT_CHANNEL_NAME)
		}
		return OCRTaskTerminal.sharedOutputChannel
	}

	private log(message: string, details?: any) {
		const timestamp = new Date().toISOString()
		const logMessage = `[${timestamp}] ${message}`
		this.outputChannel.appendLine(logMessage)
		if (details) {
			this.outputChannel.appendLine(JSON.stringify(details, null, 2))
		}
		this.writeEmitter.fire(`${message}\r\n`)
	}

	private logError(error: Error | string, errorContext?: any) {
		const message = error instanceof Error ? error.message : error
		const timestamp = new Date().toISOString()
		this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`)

		if (error instanceof Error && error.stack) {
			this.outputChannel.appendLine(`Stack trace:\n${error.stack}`)
		}

		if (errorContext) {
			this.outputChannel.appendLine(`Error context:\n${JSON.stringify(errorContext, null, 2)}`)
		}

		// Show error in the output channel and focus it
		this.outputChannel.show(true)
		this.writeEmitter.fire(`ERROR: ${message}\r\n`)
	}

	async open(): Promise<void> {
		try {
			this.log(`Starting OCR processing for: ${this.taskDefinition.source}`, {
				options: this.taskDefinition.options,
			})

			// Load document
			this.log("Loading document...")
			const document = await this.ocrService.loadDocument(this.taskDefinition.source)
			this.log("Document loaded successfully", {
				type: document.type,
				mimeType: document.mimeType,
				fileName: document.fileName,
			})

			// Map task options to document processing options
			const processOptions = {
				extractTables: this.taskDefinition.options.extractTables ?? false,
				analyzeLayout: this.taskDefinition.options.analyzeLayout ?? false,
				generateVisuals: this.taskDefinition.options.generateVisuals ?? false,
			}

			// Process document
			this.log("Processing document with options:", processOptions)
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

				this.log("Results displayed in new editor")
			} else {
				this.log("Warning: No markdown content in result")
			}

			if (result.visualizations) {
				this.log("Visualizations generated", {
					types: Object.keys(result.visualizations),
				})
			}

			this.log("OCR processing completed successfully")
			this.closeEmitter.fire(0) // Success
		} catch (error) {
			this.logError(error, {
				source: this.taskDefinition.source,
				options: this.taskDefinition.options,
			})

			// Show user-friendly error notification
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			vscode.window.showErrorMessage(`OCR processing failed: ${errorMessage}`, {
				modal: true,
				detail: "Check the 'OCR Tasks' output channel for detailed error information.",
			})

			// Ensure output channel is visible
			this.outputChannel.show(true)
			this.closeEmitter.fire(1) // Error
		}
	}

	close(): void {
		// Nothing to clean up
	}
}
