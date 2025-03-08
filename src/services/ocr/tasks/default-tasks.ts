import { OCRTaskDefinition } from "./OCRTaskProvider"

export const defaultOcrTasks: OCRTaskDefinition[] = [
	{
		type: "ocr",
		source: "${workspaceFolder}/documents",
		label: "Basic OCR",
		options: {
			extractTables: false,
			analyzeLayout: false,
			generateVisuals: false,
		},
	},
	{
		type: "ocr",
		source: "${workspaceFolder}/documents",
		label: "Layout Analysis OCR",
		options: {
			extractTables: true,
			analyzeLayout: true,
			generateVisuals: true,
		},
	},
]

export const getDefaultOcrTask = (source: string): OCRTaskDefinition => ({
	type: "ocr",
	source,
	label: "Process Document",
	options: {
		extractTables: true,
		analyzeLayout: true,
		generateVisuals: false,
	},
})
