import { useMemo } from "react"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { formatPrice } from "@/utils/formatPrice"
import { cn } from "@/lib/utils"

import { ModelInfo, geminiModels, ApiConfiguration } from "../../../../src/shared/api" // Added ApiConfiguration import

import { ModelDescriptionMarkdown } from "./ModelDescriptionMarkdown"

type ModelInfoViewProps = {
	selectedModelId: string
	modelInfo: ModelInfo
	isDescriptionExpanded: boolean
	setIsDescriptionExpanded: (isExpanded: boolean) => void
	apiConfiguration?: ApiConfiguration // Added optional apiConfiguration prop
}

export const ModelInfoView = ({
	selectedModelId,
	modelInfo,
	isDescriptionExpanded,
	setIsDescriptionExpanded,
	apiConfiguration, // Destructure the new prop
}: ModelInfoViewProps) => {
	const { t } = useAppTranslation()
	const isGemini = useMemo(() => Object.keys(geminiModels).includes(selectedModelId), [selectedModelId])
	// Determine if Gemini free tier is active
	const isGeminiFreeTier = apiConfiguration?.apiProvider === "gemini" && apiConfiguration?.geminiFreeTier === true

	const infoItems = [
		<ModelInfoSupportsItem
			isSupported={modelInfo.supportsImages ?? false}
			supportsLabel={t("settings:modelInfo.supportsImages")}
			doesNotSupportLabel={t("settings:modelInfo.noImages")}
		/>,
		<ModelInfoSupportsItem
			isSupported={modelInfo.supportsComputerUse ?? false}
			supportsLabel={t("settings:modelInfo.supportsComputerUse")}
			doesNotSupportLabel={t("settings:modelInfo.noComputerUse")}
		/>,
		!isGemini && (
			<ModelInfoSupportsItem
				isSupported={modelInfo.supportsPromptCache}
				supportsLabel={t("settings:modelInfo.supportsPromptCache")}
				doesNotSupportLabel={t("settings:modelInfo.noPromptCache")}
			/>
		),
		typeof modelInfo.maxTokens === "number" && modelInfo.maxTokens > 0 && (
			<>
				<span className="font-medium">{t("settings:modelInfo.maxOutput")}:</span>{" "}
				{modelInfo.maxTokens?.toLocaleString()} tokens
			</>
		),
		// Display input price (show $0 if free tier is active)
		modelInfo.inputPrice !== undefined && (
			<>
				<span className="font-medium">{t("settings:modelInfo.inputPrice")}:</span>{" "}
				{formatPrice(isGeminiFreeTier ? 0 : modelInfo.inputPrice)} / 1M tokens
			</>
		),
		// Display output price (show $0 if free tier is active)
		modelInfo.outputPrice !== undefined && (
			<>
				<span className="font-medium">{t("settings:modelInfo.outputPrice")}:</span>{" "}
				{formatPrice(isGeminiFreeTier ? 0 : modelInfo.outputPrice)} / 1M tokens
			</>
		),
		modelInfo.supportsPromptCache && modelInfo.cacheReadsPrice && (
			<>
				<span className="font-medium">{t("settings:modelInfo.cacheReadsPrice")}:</span>{" "}
				{formatPrice(modelInfo.cacheReadsPrice || 0)} / 1M tokens
			</>
		),
		modelInfo.supportsPromptCache && modelInfo.cacheWritesPrice && (
			<>
				<span className="font-medium">{t("settings:modelInfo.cacheWritesPrice")}:</span>{" "}
				{formatPrice(modelInfo.cacheWritesPrice || 0)} / 1M tokens
			</>
		),
		isGemini && (
			<span className="italic">
				{selectedModelId === "gemini-2.5-pro-preview-03-25"
					? t("settings:modelInfo.gemini.billingEstimate")
					: t("settings:modelInfo.gemini.freeRequests", {
							count: selectedModelId && selectedModelId.includes("flash") ? 15 : 2,
						})}{" "}
				<VSCodeLink href="https://ai.google.dev/pricing" className="text-sm">
					{t("settings:modelInfo.gemini.pricingDetails")}
				</VSCodeLink>
			</span>
		),
	].filter(Boolean)

	return (
		<>
			{modelInfo.description && (
				<ModelDescriptionMarkdown
					key="description"
					markdown={modelInfo.description}
					isExpanded={isDescriptionExpanded}
					setIsExpanded={setIsDescriptionExpanded}
				/>
			)}
			<div className="text-sm text-vscode-descriptionForeground">
				{infoItems.map((item, index) => (
					<div key={index}>{item}</div>
				))}
			</div>
		</>
	)
}

const ModelInfoSupportsItem = ({
	isSupported,
	supportsLabel,
	doesNotSupportLabel,
}: {
	isSupported: boolean
	supportsLabel: string
	doesNotSupportLabel: string
}) => (
	<div
		className={cn(
			"flex items-center gap-1 font-medium",
			isSupported ? "text-vscode-charts-green" : "text-vscode-errorForeground",
		)}>
		<span className={cn("codicon", isSupported ? "codicon-check" : "codicon-x")} />
		{isSupported ? supportsLabel : doesNotSupportLabel}
	</div>
)
