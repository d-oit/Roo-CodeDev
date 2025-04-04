import { Cline } from "../Cline"
import { ClineProvider } from "../webview/ClineProvider"
import { TemperatureOverrideService } from "../services/TemperatureOverrideService"
import * as vscode from "vscode"

// Mock dependencies
jest.mock("../webview/ClineProvider")
jest.mock("../services/TemperatureOverrideService")
jest.mock("../ignore/RooIgnoreController")

// Mock storagePathManager to avoid file system errors
jest.mock("../../shared/storagePathManager", () => ({
	getStorageBasePath: jest.fn().mockReturnValue("/mock/storage/path"),
	getTaskDirectoryPath: jest.fn().mockReturnValue("/mock/task/path"),
	ensureDirectoryExists: jest.fn().mockResolvedValue(true),
}))

// More complete vscode mock
jest.mock("vscode", () => ({
	workspace: {
		getConfiguration: jest.fn().mockReturnValue({
			get: jest.fn().mockReturnValue(true),
		}),
		createFileSystemWatcher: jest.fn().mockReturnValue({
			onDidChange: jest.fn(),
			onDidCreate: jest.fn(),
			onDidDelete: jest.fn(),
			dispose: jest.fn(),
		}),
	},
	window: {
		createTextEditorDecorationType: jest.fn().mockReturnValue({
			dispose: jest.fn(),
		}),
		showErrorMessage: jest.fn(),
		tabGroups: {
			all: [],
		},
	},
	env: {
		language: "en",
	},
	RelativePattern: jest.fn().mockImplementation(() => ({})),
}))

describe("Temperature Override Integration", () => {
	let cline: Cline
	let mockProvider: jest.Mocked<ClineProvider>
	let mockGetConfig: jest.Mock
	let mockTempOverrideService: jest.Mocked<TemperatureOverrideService>
	let mockApi: any
	const defaultTemp = 0
	beforeEach(() => {
		// Reset mocks
		jest.clearAllMocks()

		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			postStateToWebview: jest.fn(),
			postMessageToWebview: jest.fn(),
			log: jest.fn(),
			getState: jest.fn().mockReturnValue({
				terminalOutputLineLimit: 100,
				maxWorkspaceFiles: 50,
			}),
		} as any

		mockGetConfig = jest.fn().mockReturnValue(true)
		;(vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
			get: mockGetConfig,
		}))

		// Mock the TemperatureOverrideService
		mockTempOverrideService = {
			parseAndApplyOverride: jest.fn().mockImplementation((input, currentTemp) => {
				// Check configuration like the real service does
				const config = vscode.workspace.getConfiguration("roo-cline")
				if (!config.get<boolean>("enableTemperatureOverride", true)) {
					return null
				}

				if (input.startsWith("@customTemperature:")) {
					const match = input.match(/^@customTemperature:([^ ]*)/)
					if (match && match[1] === "0.9") {
						// Preserve leading whitespace after command like real service
						return {
							temperature: 0.9,
							originalTemp: currentTemp,
							cleanedInput: input.substring(match[0].length),
						}
					}
				}
				return null
			}),
		} as any

		// Set up the mock behavior for the disabled test
		;(TemperatureOverrideService as jest.Mock).mockImplementation(() => mockTempOverrideService)

		// Mock console.error to reduce test noise
		jest.spyOn(console, "error").mockImplementation(() => {})

		// Create mock API with options property and required methods
		mockApi = {
			options: {
				modelTemperature: defaultTemp,
			},
			getModel: jest.fn().mockReturnValue("test-model"),
			setTemperature: jest.fn(),
		}

		cline = new Cline({
			provider: mockProvider,
			apiConfiguration: {
				modelTemperature: defaultTemp,
			},
			task: "test task",
		})

		// Mock the API handler
		Object.defineProperty(cline, "api", {
			get: () => mockApi,
		})

		// Mock providerRef.deref() to return our mockProvider with getState
		Object.defineProperty(cline, "providerRef", {
			get: () => ({
				deref: () => mockProvider,
			}),
		})
	})

	afterEach(() => {
		jest.restoreAllMocks()
	})

	describe("initiateTaskLoop", () => {
		it("should not process temperature override when disabled", async () => {
			// Setup the mock to return null for this specific test
			jest.spyOn(mockTempOverrideService, "parseAndApplyOverride").mockReturnValue(null)

			const userContent = [
				{
					type: "text" as const,
					text: "@customTemperature:0.9 Do something",
				},
			]

			// @ts-ignore - accessing private method for testing
			await cline.initiateTaskLoop(userContent)

			expect(cline.apiConfiguration.modelTemperature).toBe(defaultTemp)
			expect(userContent[0].text).toBe("@customTemperature:0.9 Do something")
			expect(mockApi.getModel).toHaveBeenCalled()
			expect(mockApi.setTemperature).not.toHaveBeenCalled()
		})

		it("should apply temperature override when enabled", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "@customTemperature:0.9 Do something",
				},
			]

			// @ts-ignore - accessing private method for testing
			await cline.initiateTaskLoop(userContent)

			expect(cline.apiConfiguration.modelTemperature).toBe(0.9) // Should be set to the override value
			expect(userContent[0].text).toBe(" Do something") // Should preserve leading space like real service
			expect(mockGetConfig).toHaveBeenCalledWith("enableTemperatureOverride", true)
			expect(mockApi.getModel).toHaveBeenCalled()
			expect(mockApi.setTemperature).toHaveBeenCalledWith(0.9)
		})

		it("should handle invalid temperature override gracefully", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "@customTemperature:3.0 Do something",
				},
			]

			// @ts-ignore - accessing private method for testing
			await cline.initiateTaskLoop(userContent)

			// Should not modify temperature when invalid
			expect(cline.apiConfiguration.modelTemperature).toBe(defaultTemp)
			expect(userContent[0].text).toBe("@customTemperature:3.0 Do something")
		})

		it("should handle image blocks without error", async () => {
			const userContent = [
				{
					type: "image" as const,
					source: "data:image/png;base64,...",
				},
			]

			// @ts-ignore - accessing private method for testing
			await cline.initiateTaskLoop(userContent)

			expect(cline.apiConfiguration.modelTemperature).toBe(defaultTemp)
		})

		// Additional test for provider with direct options access
		it("should update and restore provider options for handlers with direct access", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "@customTemperature:0.9 Do something",
				},
			]

			// @ts-ignore - accessing private method for testing
			await cline.initiateTaskLoop(userContent)

			// Check both apiConfiguration and provider options are updated
			expect(cline.apiConfiguration.modelTemperature).toBe(0.9)
			expect(mockApi.options.modelTemperature).toBe(0.9)

			// @ts-ignore - accessing private property for testing
			expect(cline.originalTemp).toBe(defaultTemp)

			// Call abortTask which restores temperature
			await cline.abortTask()

			// Check both are restored
			expect(cline.apiConfiguration.modelTemperature).toBe(defaultTemp)
			expect(mockApi.options.modelTemperature).toBe(defaultTemp)
			// @ts-ignore - accessing private property for testing
			expect(cline.originalTemp).toBeUndefined()
		})
	})
})
