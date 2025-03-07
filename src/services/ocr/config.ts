import { OcrConfig } from "./types"

export const DEFAULT_OCR_CONFIG: OcrConfig = {
	textProcessing: {
		systemPrompt: `You are an expert document processor specializing in OCR, layout analysis, and document understanding. 
Process the provided document based on the specified requirements.
Provide output in clean, well-formatted markdown.`,
		userTemplates: {
			basic: "Extract all text content from this document while preserving its structure.",
			tables: "Identify and extract all tables from this document. Convert them to markdown format.",
			layout: "Analyze the document layout and provide a detailed breakdown of its structure, including headings, paragraphs, lists, tables, and any other visual elements.",
			analysis:
				"Perform a comprehensive analysis of this document, including its structure, content organization, and key information elements.",
		},
	},
}

// Mistral OCR model is the default for document processing
export const DEFAULT_MODEL_CONFIG = {
	modelId: "mistral-ocr-latest",
	temperature: 0.3, // Lower temperature for more consistent OCR results
}
