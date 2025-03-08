import { OcrService } from "./OcrService"
import { ProcessCommand } from "./ProcessCommand"
import * as vscode from "vscode"
import { logger } from "../../utils/logging"

export { OcrService } from "./OcrService"
export { ProcessCommand } from "./ProcessCommand"
export * from "./types"

export async function activateOcrFeatures(context: vscode.ExtensionContext): Promise<void> {
	try {
		logger.info("Activating OCR features")

		// Create process command for VS Code
		const processCommand = await ProcessCommand.createForVSCode()

		// Remove the duplicate registration here since it's handled in registerCommands.ts
		// await processCommand.registerCommand(context)

		// Register configuration change handler
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("roo-cline.ocr-api")) {
					logger.info("OCR API configuration changed")
					// Recreate process command with new configuration
					ProcessCommand.createForVSCode()
						.then((newCommand) => {
							// Remove duplicate registration here as well
							// newCommand.registerCommand(context)
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
