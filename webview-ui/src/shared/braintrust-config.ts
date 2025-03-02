import { BraintrustConfig } from "./api-types"

export const defaultBraintrustConfig: BraintrustConfig = {
	defaultModelId: "",
	models: {},
}

export function getBraintrustConfig(): BraintrustConfig {
	return defaultBraintrustConfig
}
