import { OcrService } from "../OcrService"
import * as vscode from "vscode"

jest.mock("vscode")
jest.mock("../../../utils/logging")

describe("OCR Layout Analysis", () => {
	let service: OcrService
	const mockApiConfig = {
		apiProvider: "mistral",
		mistralApiKey: "test-key",
		apiModelId: "mistral-ocr-latest",
	}

	beforeEach(() => {
		jest.clearAllMocks()

		// Mock VS Code configuration
		;(vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
			get: jest.fn().mockReturnValue({ "test-profile": mockApiConfig }),
		}))

		service = new OcrService({ type: "profile", profileName: "test-profile" })
	})

	test("analyzes document layout with visualizations", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "complex-layout.pdf",
		}

		const options = {
			analyzeLayout: true,
			generateVisuals: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.structure).toBeDefined()
		expect(result.structure?.sections).toEqual([])
		expect(result.visualizations?.layout).toBeDefined()
	})

	test("handles image documents for layout analysis", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "image/jpeg",
			fileName: "document-scan.jpg",
		}

		const options = {
			analyzeLayout: true,
			generateVisuals: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.structure).toBeDefined()
		expect(result.visualizations?.layout).toBeDefined()
	})

	test("generates layout analysis prompt", () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "test.pdf",
		}

		const prompt = service.getOcrPrompt("layout", document)
		expect(prompt).toContain("system")
	})

	test("performs detailed analysis with all features", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "full-analysis.pdf",
		}

		const options = {
			analyzeLayout: true,
			generateVisuals: true,
			extractTables: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.structure).toBeDefined()
		expect(result.visualizations?.layout).toBeDefined()
		expect(result.visualizations?.sections).toBeDefined()
		expect(result.visualizations?.tables).toBeDefined()
	})

	test("handles documents with simple layouts", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "simple-layout.pdf",
		}

		const options = {
			analyzeLayout: true,
			generateVisuals: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.structure).toBeDefined()
		expect(result.structure?.sections).toEqual([])
		expect(result.visualizations?.layout).toBeDefined()
	})

	test("generates analysis prompt with context", () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "test.pdf",
		}

		const prompt = service.getOcrPrompt("analysis", document)
		expect(prompt).toContain("system")
	})
})
