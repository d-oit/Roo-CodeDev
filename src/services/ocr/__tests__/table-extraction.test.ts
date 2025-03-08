import { OcrService } from "../OcrService"
import * as vscode from "vscode"

jest.mock("vscode")
jest.mock("../../../utils/logging")

describe("OCR Table Extraction", () => {
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

	test("extracts tables from PDF document", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "test-tables.pdf",
		}

		const options = {
			extractTables: true,
			generateVisuals: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.visualizations).toBeDefined()
		expect(Array.isArray(result.visualizations?.tables)).toBe(true)
	})

	test("handles documents without tables", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "no-tables.pdf",
		}

		const options = {
			extractTables: true,
			generateVisuals: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.visualizations?.tables).toEqual([])
	})

	test("table extraction with layout analysis", async () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "complex-tables.pdf",
		}

		const options = {
			extractTables: true,
			analyzeLayout: true,
			generateVisuals: true,
		}

		const result = await service.processDocument(document, options)

		expect(result.structure).toBeDefined()
		expect(result.visualizations?.tables).toBeDefined()
		expect(result.visualizations?.layout).toBeDefined()
	})

	test("table prompt generation", () => {
		const document = {
			type: "base64" as const,
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "test.pdf",
		}

		const prompt = service.getOcrPrompt("tables", document)
		expect(prompt).toContain("system")
	})
})
