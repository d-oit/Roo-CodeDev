import { MistralHandler } from "../mistral"
import { DocumentContent } from "../../../shared/api"

describe("MistralHandler Document Processing", () => {
	const mockApiKey = "test-api-key"
	let handler: MistralHandler

	beforeEach(() => {
		handler = new MistralHandler({
			mistralApiKey: mockApiKey,
			apiModelId: "mistral-ocr-latest",
		})
	})

	it("should detect document processing support", () => {
		const model = handler.getModel()
		expect(model.info.documentProcessing?.supported).toBe(true)
		expect(model.info.documentProcessing?.capabilities.textExtraction).toBe(true)
	})

	it("should process document and return markdown", async () => {
		const mockDocument: DocumentContent = {
			type: "base64",
			data: "test-data",
			mimeType: "application/pdf",
		}

		const mockContent = "# Document Title\n\nTest content"
		const mockComplete = jest.fn().mockImplementation(() => ({
			choices: [{ message: { content: mockContent } }],
		}))

		// @ts-ignore - Mock implementation
		handler["client"].chat.complete = mockComplete

		const result = await handler.processDocument(mockDocument)
		expect(result.markdown).toBe(mockContent)
		expect(mockComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "mistral-ocr-latest",
			}),
		)
	})

	it("should throw error for unsupported model", async () => {
		handler = new MistralHandler({
			mistralApiKey: mockApiKey,
			apiModelId: "mistral-large-latest",
		})

		const mockDocument: DocumentContent = {
			type: "base64",
			data: "test-data",
			mimeType: "application/pdf",
		}

		await expect(handler.processDocument(mockDocument)).rejects.toThrow(
			"Current model does not support document processing",
		)
	})

	it("should generate visualizations when supported", async () => {
		const mockDocument: DocumentContent = {
			type: "base64",
			data: "test-data",
			mimeType: "application/pdf",
		}

		let callCount = 0
		const mockComplete = jest.fn().mockImplementation(() => {
			callCount++
			return {
				choices: [
					{
						message: {
							content:
								callCount === 1
									? "data:image/png;base64,layout-data"
									: "data:image/png;base64,sections-data",
						},
					},
				],
			}
		})

		// @ts-ignore - Mock implementation
		handler["client"].chat.complete = mockComplete

		const result = await handler.processDocument(mockDocument, {
			generateVisuals: true,
			analyzeLayout: true,
		})

		expect(result.visualizations).toBeDefined()
		expect(result.visualizations?.layout).toBe("layout-data")
		expect(result.visualizations?.sections).toBe("sections-data")
		expect(mockComplete).toHaveBeenCalledTimes(2)
	})

	it("should extract document structure", async () => {
		const mockDocument: DocumentContent = {
			type: "base64",
			data: "test-data",
			mimeType: "application/pdf",
		}

		const mockMarkdown = `# Main Title
    
First section content.

## Subsection
Second section content.`

		const mockComplete = jest.fn().mockImplementation(() => ({
			choices: [{ message: { content: mockMarkdown } }],
		}))

		// @ts-ignore - Mock implementation
		handler["client"].chat.complete = mockComplete

		const result = await handler.processDocument(mockDocument)

		expect(result.structure).toBeDefined()
		expect(result.structure?.sections).toHaveLength(2)
		expect(result.structure?.sections?.[0].heading).toBe("Main Title")
		expect(result.structure?.sections?.[1].heading).toBe("Subsection")
	})
})
