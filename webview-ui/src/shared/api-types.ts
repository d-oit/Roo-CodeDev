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

// Remove the hardcoded default model ID since it comes from package.json config
export interface BraintrustConfig {
	defaultModelId: string
	models: Record<string, ModelInfo>
}
