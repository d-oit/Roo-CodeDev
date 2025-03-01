import React from "react"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { ModelPicker } from "./ModelPicker"
import { getBraintrustConfig } from "../../../../src/shared/api"

const BraintrustModelPicker: React.FC = () => {
	const extensionState = useExtensionState()
	const braintrustConfig = getBraintrustConfig(extensionState)

	// Get model ID from configuration sources in order of priority
	const modelId =
		extensionState.apiConfiguration?.braintrustModelId ||
		(extensionState.apiConfiguration?.apiProvider === "braintrust"
			? extensionState.apiConfiguration?.apiModelId
			: undefined) ||
		braintrustConfig.defaultModelId ||
		"" // Fallback to empty string if no model ID is found

	return (
		<ModelPicker
			defaultModelId={modelId}
			modelsKey="braintrustModels"
			configKey="braintrustModelId"
			infoKey="braintrustModelInfo"
			refreshMessageType="refreshBraintrustModels"
			refreshValues={{
				apiKey: extensionState.apiConfiguration?.braintrustApiKey,
			}}
			serviceName="Braintrust"
			serviceUrl="https://braintrust.dev/"
			recommendedModel="claude-3-5-sonnet-latest"
			allowCustomModel={false}
		/>
	)
}

export default BraintrustModelPicker
