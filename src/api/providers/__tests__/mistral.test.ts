import { MistralHandler } from "../mistral"
import { ApiHandlerOptions, mistralDefaultModelId } from "../../../shared/api"
import { Anthropic } from "@anthropic-ai/sdk"
import { ApiStreamTextChunk } from "../../transform/stream"

// Mock Mistral client
const mockStream = jest.fn()
jest.mock("@mistralai/mistralai", () => ({
	Mistral: jest.fn().mockImplementation(() => ({
		chat: {
			stream: mockStream.mockImplementation(async () => {
				const response = {
					headers: {},
					status: 200,
					statusText: "OK",
				}

				const streamResponse = {
					response,
					headers: response.headers,
					status: response.status,
					statusText: response.statusText,
					[Symbol.asyncIterator]: async function* () {
						yield {
							data: {
								choices: [
									{
										delta: { content: "Test response" },
										index: 0,
									},
								],
								usage: {
									promptTokens: 10,
									completionTokens: 5,
									totalTokens: 15,
								},
							},
						}
					},
				}

				return streamResponse
			}),
			complete: jest.fn().mockResolvedValue({
				choices: [
					{
						message: {
							content: "Test response",
							role: "assistant",
						},
						index: 0,
					},
				],
				usage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
				},
			}),
		},
	})),
}))

describe("MistralHandler", () => {
	let handler: MistralHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "codestral-latest",
			mistralApiKey: "test-api-key",
			includeMaxTokens: true,
			modelTemperature: 0,
		}
		handler = new MistralHandler(mockOptions)
		mockStream.mockClear()
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

		it("should use custom base URL if provided", () => {
			const customBaseUrl = "https://custom.mistral.ai/v1"
			const handlerWithCustomUrl = new MistralHandler({
				...mockOptions,
				mistralCodestralUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(MistralHandler)
		})
	})

	describe("getModel", () => {
		it("should return correct model info", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.apiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.supportsPromptCache).toBe(false)
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

		it("should create message successfully", async () => {
			const iterator = handler.createMessage(systemPrompt, messages)
			const result = await iterator.next()

			expect(mockStream).toHaveBeenCalledWith({
				model: mockOptions.apiModelId,
				messages: expect.any(Array),
				maxTokens: expect.any(Number),
				temperature: 0,
			})

			expect(result.value).toBeDefined()
			expect(result.done).toBe(false)
			expect(result.value).toEqual({ type: "text", text: "Test response" })
		})

		it("should handle streaming response correctly", async () => {
			const iterator = handler.createMessage(systemPrompt, messages)
			const results: ApiStreamTextChunk[] = []

			for await (const chunk of iterator) {
				if ("text" in chunk) {
					results.push(chunk as ApiStreamTextChunk)
				}
			}

			expect(results.length).toBeGreaterThan(0)
			expect(results[0].text).toBe("Test response")
		})

		it("should handle errors gracefully", async () => {
			mockStream.mockRejectedValueOnce(new Error("API Error"))

			const iterator = handler.createMessage(systemPrompt, messages)
			await expect(iterator.next()).rejects.toThrow("API Error")
		})

		it("should handle stream errors", async () => {
			mockStream.mockImplementationOnce(async () => ({
				headers: {},
				status: 200,
				statusText: "OK",
				[Symbol.asyncIterator]: async function* () {
					throw new Error("Stream Error")
				},
			}))

			const iterator = handler.createMessage(systemPrompt, messages)
			await expect(iterator.next()).rejects.toThrow("Stream Error")
		})
	})
})
