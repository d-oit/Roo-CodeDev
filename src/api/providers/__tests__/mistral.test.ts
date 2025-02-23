import { MistralHandler } from "../mistral"
import { ApiHandlerOptions, mistralDefaultModelId } from "../../../shared/api"
import { Anthropic } from "@anthropic-ai/sdk"
import { ApiStreamTextChunk } from "../../transform/stream"

// Mock Mistral client
const mockCreate = jest.fn()
jest.mock("@mistralai/mistralai", () => {
	return {
		MistralClient: jest.fn().mockImplementation(() => ({
			chat: {
				stream: mockCreate.mockImplementation(async (options) => {
					const stream = {
						[Symbol.asyncIterator]: async function* () {
							yield {
								choices: [
									{
										delta: { content: "Test response" },
										index: 0,
									},
								],
							}
						},
					}
					return stream
				}),
			},
		})),
	}
})

describe("MistralHandler", () => {
	let handler: MistralHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "codestral-latest",
			mistralApiKey: "test-api-key",
			includeMaxTokens: true,
			modelTemperature: 0,
			mistralModelStreamingEnabled: true,
			stopToken: undefined,
			mistralCodestralUrl: undefined,
		}
		handler = new MistralHandler(mockOptions)
		mockCreate.mockClear()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(MistralHandler)
			expect(handler.getModel().id).toBe(mockOptions.apiModelId)
		})

		it("should throw error if API key is missing", () => {
			expect(() => {
				new MistralHandler({
					...mockOptions,
					mistralApiKey: undefined,
				})
			}).toThrow("Mistral API key is required")
		})
	})

	describe("stopToken handling", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello!" }],
			},
		]

		it("should not include stop parameter when stopToken is undefined", async () => {
			const handlerWithoutStop = new MistralHandler({
				...mockOptions,
				stopToken: undefined,
			})
			await handlerWithoutStop.createMessage(systemPrompt, messages)

			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stop")
		})

		it("should not include stop parameter when stopToken is empty string", async () => {
			const handlerWithEmptyStop = new MistralHandler({
				...mockOptions,
				stopToken: "",
			})
			await handlerWithEmptyStop.createMessage(systemPrompt, messages)

			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stop")
		})

		it("should not include stop parameter when stopToken contains only whitespace", async () => {
			const handlerWithWhitespaceStop = new MistralHandler({
				...mockOptions,
				stopToken: "   ",
			})
			await handlerWithWhitespaceStop.createMessage(systemPrompt, messages)

			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stop")
		})

		it("should not include stop parameter when stopToken contains only commas", async () => {
			const handlerWithCommasStop = new MistralHandler({
				...mockOptions,
				stopToken: ",,,",
			})
			await handlerWithCommasStop.createMessage(systemPrompt, messages)

			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stop")
		})

		it("should include stop parameter with single token", async () => {
			const handlerWithStop = new MistralHandler({
				...mockOptions,
				stopToken: "\\n\\n",
			})
			await handlerWithStop.createMessage(systemPrompt, messages)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					stop: ["\\n\\n"],
				}),
			)
		})

		it("should handle multiple stop tokens and filter empty ones", async () => {
			const handlerWithMultiStop = new MistralHandler({
				...mockOptions,
				stopToken: "\\n\\n,,DONE, ,END,",
			})
			await handlerWithMultiStop.createMessage(systemPrompt, messages)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					stop: ["\\n\\n", "DONE", "END"],
				}),
			)
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello!" }],
			},
		]

		it("should create message with streaming enabled", async () => {
			const stream = await handler.createMessage(systemPrompt, messages)
			expect(stream).toBeDefined()
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: systemPrompt,
						}),
					]),
					stream: true,
				}),
			)
		})

		it("should handle temperature settings", async () => {
			const handlerWithTemp = new MistralHandler({
				...mockOptions,
				modelTemperature: 0.7,
			})
			await handlerWithTemp.createMessage(systemPrompt, messages)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 0.7,
				}),
			)
		})

		it("should transform messages correctly", async () => {
			const complexMessages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "Hello!" },
						{ type: "text", text: "How are you?" },
					],
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "I'm doing well!" }],
				},
			]
			await handler.createMessage(systemPrompt, complexMessages)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: systemPrompt,
						}),
						expect.objectContaining({
							role: "user",
							content: "Hello! How are you?",
						}),
						expect.objectContaining({
							role: "assistant",
							content: "I'm doing well!",
						}),
					]),
				}),
			)
		})
	})
})
