import { OcrService } from "./OcrService"
import { ProcessCommand } from "./ProcessCommand"
import { DEFAULT_OCR_CONFIG, DEFAULT_MODEL_CONFIG } from "./config"
import * as vscode from "vscode"
import { logger } from "../../utils/logging"

export { OcrService } from "./OcrService"
export { ProcessCommand } from "./ProcessCommand"
export * from "./types"
export * from "./config"

export async function activateOcrFeatures(context: vscode.ExtensionContext): Promise<void> {
	try {
		logger.info("Activating OCR features")

		// Initialize OCR service with default configuration
		const ocrService = new OcrService(DEFAULT_OCR_CONFIG)

		// Initialize and register the process command
		const processCommand = new ProcessCommand(ocrService)
		await processCommand.registerCommand(context)

		// Register configuration change handlers
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("roo.ocr")) {
					logger.info("OCR configuration changed")
					// TODO: Handle configuration updates
				}
			}),
		)

		logger.info("OCR features activated successfully", {
			model: DEFAULT_MODEL_CONFIG.modelId,
		})
	} catch (error) {
		logger.error("Failed to activate OCR features", { error })
		throw error
	}
}
