import { BraintrustConfig, braintrustDefaultModelId } from "./api-types"

// This will now just provide a default empty configuration
// The actual models will come from the extension's configuration
export function getBraintrustConfig(): BraintrustConfig {
	return {
		defaultModelId: braintrustDefaultModelId,
		models: {}, // Models will be populated from VS Code configuration
	}
}
