export interface ModelInfo {
	maxTokens: number
	contextWindow: number
	supportsImages: boolean
	supportsComputerUse: boolean
	supportsPromptCache: boolean
	description: string
	inputPrice?: number
	outputPrice?: number
}

export type BraintrustModelId = string

export const braintrustDefaultModelId = "gpt-4o"

export interface BraintrustConfig {
	defaultModelId: string
	models: Record<string, ModelInfo>
}
