import React from "react"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { ModelPicker } from "./ModelPicker"
import { braintrustDefaultModelId } from "../../../../src/shared/api"

const BraintrustModelPicker: React.FC = () => {
	const { apiConfiguration } = useExtensionState()

	// Get model ID from either braintrustModelId or apiModelId (when provider is braintrust)
	const modelId =
		apiConfiguration?.braintrustModelId ||
		(apiConfiguration?.apiProvider === "braintrust" ? apiConfiguration?.apiModelId : undefined) ||
		braintrustDefaultModelId

	return (
		<ModelPicker
			defaultModelId={modelId}
			modelsKey="braintrustModels"
			configKey="braintrustModelId"
			infoKey="braintrustModelInfo"
			refreshMessageType="refreshBraintrustModels"
			refreshValues={{
				apiKey: apiConfiguration?.braintrustApiKey,
			}}
			serviceName="Braintrust"
			serviceUrl="https://braintrust.dev/"
			recommendedModel="claude-3-5-sonnet-latest"
			allowCustomModel={false}
		/>
	)
}

export default BraintrustModelPicker
