import { BraintrustConfig } from "./api-types"

// Default configuration matching package.json
export const defaultBraintrustConfig: BraintrustConfig = {
	defaultModelId: "claude-3-7-sonnet-20250219",
	models: {}, // Models will be populated from VS Code configuration
}

export function getBraintrustConfig(): BraintrustConfig {
	return defaultBraintrustConfig
}
