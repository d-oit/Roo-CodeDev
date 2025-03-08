import { OcrService } from "./OcrService"
import { ProcessCommand } from "./ProcessCommand"
import { OCRTaskProvider } from "./tasks/OCRTaskProvider"
import * as vscode from "vscode"
import { logger } from "../../utils/logging"

export { OcrService } from "./OcrService"
export { ProcessCommand } from "./ProcessCommand"
export * from "./types"
export { OCRTaskProvider } from "./tasks/OCRTaskProvider"

export async function activateOcrFeatures(context: vscode.ExtensionContext): Promise<void> {
	try {
		logger.info("Activating OCR features")

		// Create process command for VS Code
		const processCommand = await ProcessCommand.createForVSCode()

		// Register OCR task provider
		const taskProvider = new OCRTaskProvider()
		context.subscriptions.push(vscode.tasks.registerTaskProvider(OCRTaskProvider.OCR_TYPE, taskProvider))

		logger.info("Registered OCR task provider")

		// Register configuration change handler
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("roo-cline.ocr-api")) {
					logger.info("OCR API configuration changed")
					// Recreate process command with new configuration
					ProcessCommand.createForVSCode()
						.then((newCommand) => {
							// Configuration updated
							logger.info("OCR process command updated")
						})
						.catch((error) => {
							logger.error("Failed to recreate process command", { error })
						})
				}
			}),
		)
	} catch (error) {
		logger.error("Failed to activate OCR features", { error })
		throw error
	}
}
