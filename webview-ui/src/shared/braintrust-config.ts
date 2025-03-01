import { ModelInfo, braintrustDefaultModelId, braintrustModels } from "./api-types"

interface BraintrustConfig {
	defaultModelId: string
	models: Record<string, ModelInfo>
}

export function getBraintrustConfig(): BraintrustConfig {
	return {
		defaultModelId: braintrustDefaultModelId,
		models: braintrustModels,
	}
}
