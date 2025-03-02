export interface BraintrustConfig {
	defaultModelId: string
	baseUrl?: string
	contextWindow?: number
	maxTokens?: number
	supportsImages?: boolean
	supportsPromptCache?: boolean
}

const defaultBraintrustConfig: BraintrustConfig = {
	defaultModelId: "",
}

export default defaultBraintrustConfig
