import { OcrService } from "../OcrService"
import { DocumentContent, mistralModels } from "../../../shared/api"
import * as vscode from "vscode"
import { ProcessOptions } from "../types"

jest.mock("vscode")
jest.mock("../../../utils/logging")

describe("OcrService", () => {
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

	describe("Document Loading", () => {
		test("loads PDF document correctly", async () => {
			const pdfSource = "sample.pdf"
			const result = await service.loadDocument(pdfSource)

			expect(result).toEqual({
				type: "base64",
				data: pdfSource,
				mimeType: "application/pdf",
				fileName: undefined,
			})
		})

		test("loads image document correctly", async () => {
			const imageSource = "sample.jpg"
			const result = await service.loadDocument(imageSource)

			expect(result).toEqual({
				type: "base64",
				data: imageSource,
				mimeType: "image/jpeg",
				fileName: undefined,
			})
		})

		test("handles URLs correctly", async () => {
			const urlSource = "https://example.com/doc.pdf"
			const result = await service.loadDocument(urlSource)

			expect(result).toEqual({
				type: "url",
				data: urlSource,
				mimeType: "application/pdf",
				fileName: "doc.pdf",
			})
		})
	})

	describe("Document Processing", () => {
		const mockDocument: DocumentContent = {
			type: "base64",
			data: "test-data",
			mimeType: "application/pdf",
			fileName: "test.pdf",
		}

		test("processes PDF document with basic options", async () => {
			const options: ProcessOptions = {}
			const result = await service.processDocument(mockDocument, options)

			expect(result).toEqual({
				markdown: "",
				structure: undefined,
				visualizations: undefined,
			})
		})

		test("processes document with layout analysis", async () => {
			const options: ProcessOptions = {
				analyzeLayout: true,
				generateVisuals: true,
			}

			const result = await service.processDocument(mockDocument, options)

			expect(result.structure).toBeDefined()
			expect(result.visualizations?.layout).toBeDefined()
		})

		test("processes document with table extraction", async () => {
			const options: ProcessOptions = {
				extractTables: true,
				generateVisuals: true,
			}

			const result = await service.processDocument(mockDocument, options)

			expect(result.visualizations?.tables).toBeDefined()
		})

		test("handles unsupported file types", async () => {
			const invalidDocument: DocumentContent = {
				type: "base64",
				data: "test-data",
				mimeType: "text/plain",
				fileName: "test.txt",
			}

			await expect(service.processDocument(invalidDocument)).rejects.toThrow(
				"Unsupported document type: text/plain",
			)
		})
	})

	describe("Text Model Handling", () => {
		test("validates OCR-capable models", async () => {
			const modelId = "mistral-ocr-latest"
			const mockModelInfo = {
				...mistralModels[modelId],
				documentProcessing: {
					supported: true as const,
					capabilities: {
						textExtraction: true as const,
						layoutAnalysis: true as const,
						tableDetection: true as const,
						visualization: true as const,
					},
				},
			}

			// Mock the model info
			jest.spyOn(mistralModels, modelId, "get").mockReturnValue(mockModelInfo)

			const result = await service.processDocument({
				type: "base64",
				data: "test-data",
				mimeType: "application/pdf",
				fileName: "test.pdf",
			})

			expect(result).toBeDefined()
		})

		test("rejects non-OCR models", async () => {
			const serviceWithInvalidModel = new OcrService({
				type: "profile",
				profileName: "test-profile",
			})

			// Mock configuration to use a non-OCR model
			;(vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
				get: jest.fn().mockReturnValue({
					"test-profile": {
						...mockApiConfig,
						apiModelId: "mistral-tiny",
					},
				}),
			}))

			const document: DocumentContent = {
				type: "base64",
				data: "test-data",
				mimeType: "application/pdf",
				fileName: "test.pdf",
			}

			await expect(serviceWithInvalidModel.processDocument(document)).rejects.toThrow(
				/does not support document processing/,
			)
		})
	})

	describe("OCR Prompts", () => {
		test("generates correct prompts for different processing types", () => {
			const document: DocumentContent = {
				type: "base64",
				data: "test-data",
				mimeType: "application/pdf",
				fileName: "test.pdf",
			}

			const basicPrompt = service.getOcrPrompt("basic", document)
			expect(basicPrompt).toContain("system")

			const tablesPrompt = service.getOcrPrompt("tables", document)
			expect(tablesPrompt).toContain("system")

			const layoutPrompt = service.getOcrPrompt("layout", document)
			expect(layoutPrompt).toContain("system")

			const analysisPrompt = service.getOcrPrompt("analysis", document)
			expect(analysisPrompt).toContain("system")
		})
	})

	describe("Error Handling", () => {
		test("handles API configuration errors", async () => {
			// Mock missing API key
			const serviceWithoutKey = new OcrService({
				type: "profile",
				profileName: "missing-key",
			})

			;(vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
				get: jest.fn().mockReturnValue({
					"missing-key": {
						apiProvider: "mistral",
						apiModelId: "mistral-ocr-latest",
					},
				}),
			}))

			await expect(
				serviceWithoutKey.processDocument({
					type: "base64",
					data: "test-data",
					mimeType: "application/pdf",
					fileName: "test.pdf",
				}),
			).rejects.toThrow("Mistral API key not configured")
		})
	})
})
