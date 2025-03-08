import { DocumentContent, DocumentOutput } from "../../shared/api"

export interface OcrModelConfig {
	temperature: number
	systemPrompt: string
	userPromptTemplates: {
		basic: string
		tables: string
		layout: string
		analysis: string
	}
}

export interface OcrConfigVSCode {
	configurationName: string // Name of API profile to use
}

export interface OcrConfig {
	textProcessing: {
		systemPrompt: string
		userTemplates: {
			basic: string
			tables: string
			layout: string
			analysis: string
		}
	}
}

export type OcrServiceConfig =
	| {
			type: "profile" // Using API profile (for chat)
			profileName: string
	  }
	| {
			type: "vscode" // Using VS Code configuration
			vsCodeConfig: OcrConfigVSCode
	  }

export interface ProcessOptions {
	save?: boolean
	extractTables?: boolean
	analyzeLayout?: boolean
	generateVisuals?: boolean
}

export interface ModelSelectionUi {
	ocrModel: {
		id: string
		name: string
		options: string[]
		default: string
	}
	textOcrModel: {
		id: string
		name: string
		options: string[]
		default: string
	}
}
