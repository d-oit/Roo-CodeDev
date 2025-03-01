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

export const braintrustDefaultModelId = "braintrust-default"

export const braintrustModels: Record<string, ModelInfo> = {
	"braintrust-default": {
		maxTokens: 8192,
		contextWindow: 32768,
		supportsImages: false,
		supportsComputerUse: false,
		supportsPromptCache: false,
		description: "Braintrust Default Model",
		inputPrice: 0,
		outputPrice: 0,
	},
}
