import React from "react"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { ModelPicker } from "./ModelPicker"
import { vscode } from "../../utils/vscode"
import { defaultBraintrustConfig } from "../../shared/braintrust-config"

const BraintrustModelPicker: React.FC = () => {
	const extensionState = useExtensionState()

	// Load models from VS Code settings
	React.useEffect(() => {
		vscode.postMessage({
			type: "getVSCodeSetting" as const,
			value: "roo-cline.braintrustConfig",
		})
	}, [])

	// Get model ID from configuration sources in order of priority
	const modelId =
		extensionState.apiConfiguration?.braintrustModelId ||
		(extensionState.apiConfiguration?.apiProvider === "braintrust"
			? extensionState.apiConfiguration?.apiModelId
			: undefined) ||
		defaultBraintrustConfig.defaultModelId // Fall back to default model ID

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
