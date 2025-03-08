import * as vscode from "vscode"
import { OCRTaskTerminal } from "../tasks/OCRTaskTerminal"
import { logger } from "../../../utils/logging"
import { defaultOcrTasks } from "./default-tasks"

export interface OCRTaskDefinition extends vscode.TaskDefinition {
	source: string // Source of images (directory, URL, etc.)
	label: string // Display name of the task
	options: {
		extractTables?: boolean // Detect and extract tables
		analyzeLayout?: boolean // Analyze document layout
		generateVisuals?: boolean // Generate visual representations
	}
}

export class OCRTaskProvider implements vscode.TaskProvider {
	static OCR_TYPE = "ocr"
	private tasks: vscode.Task[] = []

	constructor() {
		this.loadTaskDefinitions()
	}

	public async provideTasks(): Promise<vscode.Task[]> {
		return this.tasks
	}

	public resolveTask(task: vscode.Task): vscode.Task | undefined {
		const definition = task.definition as OCRTaskDefinition

		if (definition.type === OCRTaskProvider.OCR_TYPE) {
			const execution = new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
				return new OCRTaskTerminal(definition)
			})

			return new vscode.Task(
				definition,
				task.scope ?? vscode.TaskScope.Workspace,
				definition.label,
				OCRTaskProvider.OCR_TYPE,
				execution,
			)
		}

		return undefined
	}

	private async loadTaskDefinitions(): Promise<void> {
		try {
			// Load tasks from workspace tasks.json
			const workspaceTasks = vscode.workspace.getConfiguration("tasks")
			const customTasks = workspaceTasks.get<OCRTaskDefinition[]>("ocr") ?? []

			// Combine custom tasks with defaults, replacing workspace path variable
			const workspaceFolders = vscode.workspace.workspaceFolders
			const workspacePath = workspaceFolders?.[0]?.uri.fsPath ?? ""

			const allTasks = [...customTasks]

			// Only add default tasks if no custom tasks are defined
			if (customTasks.length === 0) {
				allTasks.push(
					...defaultOcrTasks.map((task) => ({
						...task,
						source: task.source.replace("${workspaceFolder}", workspacePath),
					})),
				)
			}

			this.tasks = allTasks.map((definition) => {
				const execution = new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
					return new OCRTaskTerminal(definition)
				})

				return new vscode.Task(
					definition,
					vscode.TaskScope.Workspace,
					definition.label,
					OCRTaskProvider.OCR_TYPE,
					execution,
				)
			})

			logger.info("Loaded OCR task definitions", {
				customCount: customTasks.length,
				defaultCount: this.tasks.length - customTasks.length,
			})
		} catch (error) {
			logger.error("Failed to load OCR task definitions", { error })
		}
	}
}
