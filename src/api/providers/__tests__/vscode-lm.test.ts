import * as vscode from "vscode"
import { VsCodeLmHandler } from "../vscode-lm"
import { ApiHandlerOptions } from "../../../shared/api"
import { Anthropic } from "@anthropic-ai/sdk"
import { ApiStreamTextChunk } from "../../transform/stream"

// Mock classes moved to a separate object for better organization
const mockClasses = {
	MockLanguageModelTextPart: class {
		type = "text"
		constructor(public value: string) {}
	},
	MockLanguageModelToolCallPart: class {
		type = "tool_call"
		constructor(
			public callId: string,
			public name: string,
			public input: any,
		) {}
	},
}

// Centralized mock setup
const setupVsCodeMock = () => ({
	workspace: {
		onDidChangeConfiguration: jest.fn((callback) => ({
			dispose: jest.fn(),
		})),
	},
	CancellationTokenSource: jest.fn(() => ({
		token: {
			isCancellationRequested: false,
			onCancellationRequested: jest.fn(),
		},
		cancel: jest.fn(),
		dispose: jest.fn(),
	})),
	CancellationError: class extends Error {
		constructor() {
			super("Operation cancelled")
			this.name = "CancellationError"
		}
	},
	LanguageModelChatMessage: {
		Assistant: jest.fn((content) => ({
			role: "assistant",
			content: Array.isArray(content) ? content : [new mockClasses.MockLanguageModelTextPart(content)],
		})),
		User: jest.fn((content) => ({
			role: "user",
			content: Array.isArray(content) ? content : [new mockClasses.MockLanguageModelTextPart(content)],
		})),
	},
	LanguageModelTextPart: mockClasses.MockLanguageModelTextPart,
	LanguageModelToolCallPart: mockClasses.MockLanguageModelToolCallPart,
	lm: {
		selectChatModels: jest.fn(),
	},
})

// Mock vscode namespace
jest.mock("vscode", () => setupVsCodeMock())

// Test model configuration
const mockLanguageModelChat = {
	id: "test-model",
	name: "Test Model",
	vendor: "test-vendor",
	family: "test-family",
	version: "1.0",
	maxInputTokens: 4096,
	sendRequest: jest.fn(),
	countTokens: jest.fn(),
}

describe("VsCodeLmHandler", () => {
	let handler: VsCodeLmHandler
	const defaultOptions: ApiHandlerOptions = {
		vsCodeLmModelSelector: {
			vendor: "test-vendor",
			family: "test-family",
		},
	}

	// Helper function to create stream response
	const createStreamResponse = (content: any) => ({
		stream: (async function* () {
			yield content
			return
		})(),
		text: (async function* () {
			yield typeof content === "string" ? content : JSON.stringify(content)
			return
		})(),
	})

	beforeEach(() => {
		jest.clearAllMocks()
		handler = new VsCodeLmHandler(defaultOptions)
		mockLanguageModelChat.countTokens.mockResolvedValue(10)
	})

	afterEach(() => {
		handler.dispose()
	})

	describe("initialization and configuration", () => {
		it("initializes with provided options and handles config changes", () => {
			expect(handler).toBeDefined()
			expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled()

			const callback = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.calls[0][0]
			callback({ affectsConfiguration: () => true })
			expect(handler["client"]).toBeNull()
		})
	})

	describe("client management", () => {
		it("creates client with selector and handles no available models", async () => {
			// Test successful client creation
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as jest.Mock).mockResolvedValueOnce([mockModel])

			const client = await handler["createClient"]({
				vendor: "test-vendor",
				family: "test-family",
			})
			expect(client).toEqual(mockModel)

			// Test fallback behavior
			;(vscode.lm.selectChatModels as jest.Mock).mockResolvedValueOnce([])
			const fallbackClient = await handler["createClient"]({})
			expect(fallbackClient.id).toBe("default-lm")
		})
	})

	describe("message handling", () => {
		beforeEach(() => {
			;(vscode.lm.selectChatModels as jest.Mock).mockResolvedValueOnce([{ ...mockLanguageModelChat }])
		})

		it("streams text responses with usage information", async () => {
			const response = "Hello! How can I help you?"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce(
				createStreamResponse(new mockClasses.MockLanguageModelTextPart(response)),
			)

			const chunks = []
			for await (const chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2)
			expect(chunks[0]).toEqual({ type: "text", text: response })
			expect(chunks[1]).toMatchObject({
				type: "usage",
				inputTokens: expect.any(Number),
				outputTokens: expect.any(Number),
			})
		})

		it("handles tool calls correctly", async () => {
			const toolCallData = {
				callId: "call-1",
				name: "calculator",
				input: { operation: "add", numbers: [2, 2] },
			}

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce(
				createStreamResponse(
					new mockClasses.MockLanguageModelToolCallPart(
						toolCallData.callId,
						toolCallData.name,
						toolCallData.input,
					),
				),
			)

			const chunks = []
			for await (const chunk of handler.createMessage("system prompt", [
				{ role: "user", content: "Calculate" },
			])) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2)
			const textChunk = chunks[0] as ApiStreamTextChunk
			expect(textChunk.type).toBe("text")
			expect(JSON.parse(textChunk.text)).toMatchObject({ type: "tool_call", ...toolCallData })
		})

		it("handles errors in message creation", async () => {
			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("API Error"))

			await expect(async () => {
				const stream = handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])
				for await (const _ of stream) {
					/* consume stream */
				}
			}).rejects.toThrow("API Error")
		})
	})

	describe("prompt completion", () => {
		beforeEach(() => {
			;(vscode.lm.selectChatModels as jest.Mock).mockResolvedValueOnce([{ ...mockLanguageModelChat }])
		})

		it("completes prompts successfully", async () => {
			const response = "Completed text"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce(
				createStreamResponse(new mockClasses.MockLanguageModelTextPart(response)),
			)

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe(response)
		})

		it("handles completion errors", async () => {
			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("VSCode LM completion error: API Error")
		})
	})

	describe("model information", () => {
		it("provides model information with and without client", async () => {
			// With client
			;(vscode.lm.selectChatModels as jest.Mock).mockResolvedValueOnce([{ ...mockLanguageModelChat }])
			await handler["getClient"]()
			const modelWithClient = handler.getModel()
			expect(modelWithClient.id).toBe("test-model")
			expect(modelWithClient.info.contextWindow).toBe(4096)

			// Without client
			handler["client"] = null
			const modelWithoutClient = handler.getModel()
			expect(modelWithoutClient.id).toBe("test-vendor/test-family")
			expect(modelWithoutClient.info).toBeDefined()
		})
	})
})
