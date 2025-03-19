import { Anthropic } from "@anthropic-ai/sdk"
import { AssistantMessage } from "@mistralai/mistralai/models/components/assistantmessage"
import { SystemMessage } from "@mistralai/mistralai/models/components/systemmessage"
import { ToolMessage } from "@mistralai/mistralai/models/components/toolmessage"
import { UserMessage } from "@mistralai/mistralai/models/components/usermessage"

export type MistralMessage =
	| (SystemMessage & { role: "system" })
	| (UserMessage & { role: "user" })
	| (AssistantMessage & { role: "assistant" })
	| (ToolMessage & { role: "tool" })

export function convertToMistralMessages(anthropicMessages: Anthropic.Messages.MessageParam[]): MistralMessage[] {
	const mistralMessages: MistralMessage[] = []

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			mistralMessages.push({
				role: anthropicMessage.role,
				content: anthropicMessage.content,
			})
		} else {
			if (anthropicMessage.role === "user") {
				// Handle user messages with potential tool results
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolResultBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_result") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						}
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// First add any tool results
				for (const toolMsg of toolMessages) {
					const content =
						typeof toolMsg.content === "string"
							? toolMsg.content
							: toolMsg.content?.map((c) => (c.type === "text" ? c.text : "")).join("\n")

					if (content) {
						mistralMessages.push({
							role: "tool",
							content: JSON.stringify({
								tool_use_id: toolMsg.tool_use_id,
								content,
							}),
						})
					}
				}

				// Then add the user message if there are non-tool messages
				if (nonToolMessages.length > 0) {
					mistralMessages.push({
						role: "user",
						content: nonToolMessages.map((part) => {
							if (part.type === "image") {
								return {
									type: "image_url",
									imageUrl: {
										url: `data:${part.source.media_type};base64,${part.source.data}`,
									},
								}
							}
							return { type: "text", text: part.text }
						}),
					})
				}
			} else if (anthropicMessage.role === "assistant") {
				// Handle assistant messages with potential tool uses
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolUseBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_use") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						}
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Convert text content
				let textContent = nonToolMessages
					.map((part) => {
						if (part.type === "image") return ""
						return part.text
					})
					.filter(Boolean)
					.join("\n")

				// Add tool uses as structured content
				if (toolMessages.length > 0) {
					// If there's text content, add it first
					if (textContent) {
						mistralMessages.push({
							role: "assistant",
							content: textContent,
						})
					}

					// Add each tool use as a separate message
					for (const toolMsg of toolMessages) {
						mistralMessages.push({
							role: "assistant",
							content: JSON.stringify({
								type: "function",
								name: toolMsg.name,
								id: toolMsg.id,
								input: toolMsg.input,
							}),
						})
					}
				} else if (textContent) {
					// If no tools but we have text, add it
					mistralMessages.push({
						role: "assistant",
						content: textContent,
					})
				}
			}
		}
	}

	return mistralMessages
}
