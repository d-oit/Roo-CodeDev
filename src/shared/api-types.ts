import { ModelInfo } from "./api"

export interface BraintrustConfig {
	defaultModelId?: string
	models?: Record<string, ModelInfo>
}
