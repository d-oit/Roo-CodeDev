import React from "react"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { ModelPicker } from "./ModelPicker"

const BraintrustModelPicker: React.FC = () => {
	const extensionState = useExtensionState()

	// Get model ID from configuration sources in order of priority
	const modelId =
		extensionState.apiConfiguration?.braintrustModelId ||
		(extensionState.apiConfiguration?.apiProvider === "braintrust"
			? extensionState.apiConfiguration?.apiModelId
			: undefined) ||
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
			recommendedModel="claude-3-7-sonnet-20250219"
			allowCustomModel={false}
		/>
	)
}

export default BraintrustModelPicker
