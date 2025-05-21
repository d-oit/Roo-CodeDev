import * as vscode from "vscode"
import delay from "delay"

import { CommandId, Package } from "../schemas"
import { getCommand } from "../utils/commands"
import { ClineProvider, ClineProviderEvents } from "../core/webview/ClineProvider" // Added ClineProviderEvents
import { ContextProxy } from "../core/config/ContextProxy"
import { telemetryService } from "../services/telemetry/TelemetryService"
import { getNonce } from "../core/webview/getNonce"
import { getUri } from "../core/webview/getUri"
import { buildApiHandler, ApiHandler } from "../api" // Added ApiHandler
import { Anthropic } from "@anthropic-ai/sdk"
import { Task, TaskOptions } from "../core/task/Task" // Added Task and TaskOptions
import { getWorkspacePath } from "../utils/path" // For cwd
import { ProviderSettings } from "../shared/api" // For ProviderSettings type
import { ExtensionMessage, ClineMessage } from "../shared/ExtensionMessage"; // Added ClineMessage

import { registerHumanRelayCallback, unregisterHumanRelayCallback, handleHumanRelayResponse } from "./humanRelay"
import { handleNewTask } from "./handleTask"

/**
 * Helper to get the visible ClineProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ClineProvider | undefined {
	const visibleProvider = ClineProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Roo Code instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
		tabPanel = undefined
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
		sidebarPanel = undefined
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ClineProvider
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context } = options

	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

const getCommandsMap = ({ context, outputChannel, provider }: RegisterCommandOptions): Record<CommandId, any> => ({
	activationCompleted: () => {},
	playgroundChat: async () => { // Renamed command ID
		// Implementation for the new "Roo.playgroundChat" command
		return openPlaygroundChatViewPanel({ context, outputChannel }); // Renamed function
	},
	plusButtonClicked: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		telemetryService.captureTitleButtonClicked("plus")

		await visibleProvider.removeClineFromStack()
		await visibleProvider.postStateToWebview()
		await visibleProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	},
	mcpButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		telemetryService.captureTitleButtonClicked("mcp")

		visibleProvider.postMessageToWebview({ type: "action", action: "mcpButtonClicked" })
	},
	promptsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		telemetryService.captureTitleButtonClicked("prompts")

		visibleProvider.postMessageToWebview({ type: "action", action: "promptsButtonClicked" })
	},
	popoutButtonClicked: () => {
		telemetryService.captureTitleButtonClicked("popout")

		return openClineInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openClineInNewTab({ context, outputChannel }),
	settingsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		telemetryService.captureTitleButtonClicked("settings")

		visibleProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
		// Also explicitly post the visibility message to trigger scroll reliably
		visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	historyButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		telemetryService.captureTitleButtonClicked("history")

		visibleProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
	},
	showHumanRelayDialog: (params: { requestId: string; promptText: string }) => {
		const panel = getPanel()

		if (panel) {
			panel?.webview.postMessage({
				type: "showHumanRelayDialog",
				requestId: params.requestId,
				promptText: params.promptText,
			})
		}
	},
	registerHumanRelayCallback: registerHumanRelayCallback,
	unregisterHumanRelayCallback: unregisterHumanRelayCallback,
	handleHumanRelayResponse: handleHumanRelayResponse,
	newTask: handleNewTask,
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	focusInput: async () => {
		try {
			const panel = getPanel()

			if (!panel) {
				await vscode.commands.executeCommand(`workbench.view.extension.${Package.name}-ActivityBar`)
			} else if (panel === tabPanel) {
				panel.reveal(vscode.ViewColumn.Active, false)
			} else if (panel === sidebarPanel) {
				await vscode.commands.executeCommand(`${ClineProvider.sideBarId}.focus`)
				provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "acceptInput" })
	},
})

export const openClineInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	// (This example uses webviewProvider activation event which is necessary to
	// deserialize cached webview, but since we use retainContextWhenHidden, we
	// don't need to use that event).
	// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	const contextProxy = await ContextProxy.getInstance(context)
	const tabProvider = new ClineProvider(context, outputChannel, "editor", contextProxy)
	const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

	// Check if there are any visible text editors, otherwise open a new group
	// to the right.
	const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

	if (!hasVisibleEditors) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

	const newPanel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Roo Code", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	// Save as tab type panel.
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
	}

	await tabProvider.resolveWebviewView(newPanel)

	// Add listener for visibility changes to notify webview
	newPanel.onDidChangeViewState(
		(e) => {
			const panel = e.webviewPanel
			if (panel.visible) {
				panel.webview.postMessage({ type: "action", action: "didBecomeVisible" }) // Use the same message type as in SettingsView.tsx
			}
		},
		null, // First null is for `thisArgs`
		context.subscriptions, // Register listener for disposal
	)

	// Handle panel closing events.
	newPanel.onDidDispose(
		() => {
			setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}

// Minimal provider shim for Task
interface MinimalProviderForTask extends Pick<ClineProvider, 'context' | 'outputChannel' | 'log' | 'postMessageToWebview' | 'updateTaskHistory' | 'getState' | 'getGlobalState' | 'cwd' | 'customModesManager' | 'providerSettingsManager' | 'mcpHub'> {
	contextProxy: ContextProxy; // Explicitly add contextProxy
    // EventEmitter methods if Task directly subscribes/emits on provider (unlikely for core functionality)
    // Task extends EventEmitter, provider does not need to be one for Task's core logic.
    // on: (event: keyof ClineProviderEvents, listener: (...args: any[]) => void) => this;
    // off: (event: keyof ClineProviderEvents, listener: (...args: any[]) => void) => this;
    // emit: (event: keyof ClineProviderEvents, ...args: any[]) => boolean;
    currentSystemPrompt: string; 
    // Add other methods/properties if Task complains
}


// Function to create and manage the PlaygroundChatView panel
const openPlaygroundChatViewPanel = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => { // Note: provider from RegisterCommandOptions is the main ClineProvider, not used here.
	const panelId = "Roo.PlaygroundChatViewPanel";
	const panelTitle = "Playground Chat";
	const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;

	const newPanel = vscode.window.createWebviewPanel(
		panelId,
		panelTitle,
		column || vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true, // Keep content alive when tab is not visible
			localResourceRoots: [context.extensionUri], // Allow loading resources from extension's URI
		}
	);

	const contextProxy = await ContextProxy.getInstance(context);
	const contextProxy = await ContextProxy.getInstance(context);
	
	let currentPlaygroundTask: Task | undefined = undefined;
	let currentPlaygroundTaskMessages: Anthropic.MessageParam[] = [];
	let currentSystemPrompt: string = ""; // To be updated by messages from webview
	let currentTemperature: number = 0.7; // Default, to be updated
    let taskMessageListenerDisposable: { dispose: () => void } | undefined = undefined;


    const scopedPlaygroundProvider: MinimalProviderForTask = {
        context,
        outputChannel,
        contextProxy,
        currentSystemPrompt: "", // This will be dynamically updated by the provider itself
        log: (msg: string) => outputChannel.appendLine(`PlaygroundProvider: ${msg}`),
        postStateToWebview: async () => { 
            // For playground, main state is messages. Task's own messages are handled by 'message' event.
            // This could be used if other parts of UI need to be updated based on Task state.
            // outputChannel.appendLine("PlaygroundProvider: postStateToWebview (no-op for now)");
        },
        updateTaskHistory: async (item: HistoryItem) => { 
            outputChannel.appendLine(`PlaygroundProvider: Task history update (no-op): ${item.id}`);
        },
        postMessageToWebview: async (extensionMessage: ExtensionMessage) => {
            // This is called by Task.say, Task.ask etc.
            // We need to transform ClineMessage into the format PlaygroundChatView expects.
            if (extensionMessage.type === "message" && extensionMessage.message) {
                const taskMessage = extensionMessage.message; // This is a ClineMessage
                const taskId = currentPlaygroundTask?.taskId || "unknown-task";
                const datetime = new Date(taskMessage.ts || Date.now()).toISOString();

                if (taskMessage.type === 'say') {
                    if (taskMessage.say === 'text' && taskMessage.text) {
                        newPanel.webview.postMessage({ 
                            type: 'playgroundChatResponse', 
                            payload: { content: taskMessage.text, taskId, datetime } 
                        });
                    } else if (taskMessage.say === 'error' && taskMessage.text) {
                        newPanel.webview.postMessage({ 
                            type: 'playgroundChatError', 
                            payload: { error: taskMessage.text, taskId, datetime } 
                        });
                    }
                } else if (taskMessage.type === 'ask' && taskMessage.ask === 'api_req_failed' && taskMessage.text) {
                    newPanel.webview.postMessage({ 
                        type: 'playgroundChatError', 
                        payload: { error: `API Request Failed: ${taskMessage.text}`, taskId, datetime } 
                    });
                }
            } else {
                 // Forward other message types if any, or log them
                 outputChannel.appendLine(`PlaygroundProvider: Forwarding unhandled ExtensionMessage type: ${extensionMessage.type}`);
                 newPanel.webview.postMessage(extensionMessage);
            }
        },
        getState: async () => {
            const globalStateValues = await contextProxy.getValues();
            const baseApiConfig = contextProxy.getProviderSettings(); // Get current base API settings
            return {
                ...globalStateValues,
                customInstructions: scopedPlaygroundProvider.currentSystemPrompt, // Use the provider's currentSystemPrompt
                apiConfiguration: { // Ensure apiConfiguration is part of the returned state
                    ...baseApiConfig,
                    // Temperature will be overridden per request, but good to have a base
                    modelTemperature: currentTemperature 
                },
                mode: defaultModeSlug, // Example default mode
                cwd: getWorkspacePath(),
                experiments: globalStateValues.experiments, // Pass along experiments
            };
        },
        getGlobalState: (key) => contextProxy.getValue(key as any),
        cwd: getWorkspacePath(),
        customModesManager: { getCustomModes: async () => [] } as any,
        providerSettingsManager: { getModeConfigId: async () => undefined } as any,
        mcpHub: undefined,
        // No on/off/emit needed if Task doesn't call provider.emit or similar.
    };

	newPanel.webview.html = getPlaygroundChatViewHtmlContent(newPanel.webview, context.extensionUri);

	const webviewMessageDisposable = newPanel.webview.onDidReceiveMessage(
		async message => {
			switch (message.type) {
				case 'playgroundProcessMessage':
					try {
						const { systemPrompt: newSystemPrompt, userMessage, temperature: newTemperature } = message.payload;
						outputChannel.appendLine(`Playground: Received playgroundProcessMessage: Temp: ${newTemperature}, SystemPrompt: "${newSystemPrompt}", UserMessage: "${userMessage}"`);

                        const systemPromptChanged = scopedPlaygroundProvider.currentSystemPrompt !== newSystemPrompt;
                        scopedPlaygroundProvider.currentSystemPrompt = newSystemPrompt;
                        currentTemperature = newTemperature; // Update panel-scoped temperature

                        // Echo user message to UI immediately
                        newPanel.webview.postMessage({
                            type: 'playgroundChatUserMessage', // Dedicated type for UI to just show user message
                            payload: { content: userMessage, taskId: currentPlaygroundTask?.taskId || 'new-session', datetime: new Date().toISOString() }
                        });
                        
                        if (systemPromptChanged || !currentPlaygroundTask) {
                            if (currentPlaygroundTask) {
                                await currentPlaygroundTask.abortTask(true);
                                if (taskMessageListenerDisposable) {
                                    taskMessageListenerDisposable.dispose(); // Clean up old listener
                                }
                            }
                            currentPlaygroundTaskMessages = []; // Reset history on system prompt change
                            outputChannel.appendLine(`Playground: System prompt changed or first message. Resetting history.`);
                        }
                        
                        currentPlaygroundTaskMessages.push({ role: 'user', content: userMessage });

                        const baseProviderSettings = await contextProxy.getProviderSettings();
                        if (!baseProviderSettings) {
                            outputChannel.appendLine("Error: Provider settings unavailable.");
                            newPanel.webview.postMessage({ type: 'playgroundChatError', payload: { error: "Provider settings unavailable." } });
                            return;
                        }
                        const taskApiConfig = { ...baseProviderSettings, modelTemperature: currentTemperature };

                        currentPlaygroundTask = new Task({
                            provider: scopedPlaygroundProvider as any,
                            apiConfiguration: taskApiConfig,
                            startTask: false, // We will manually drive it
                        });
                        
                        // Setup listener for messages from this new Task instance
                        const currentTaskInstanceId = currentPlaygroundTask.instanceId; // For safety in async listener
                        taskMessageListenerDisposable = currentPlaygroundTask.on('message', ({ message: taskMsg }: { message: ClineMessage }) => {
                            if (currentPlaygroundTask && currentPlaygroundTask.instanceId === currentTaskInstanceId) {
                                scopedPlaygroundProvider.postMessageToWebview({type: "message", message: taskMsg});
                            }
                        });

                        currentPlaygroundTask.apiConversationHistory = [...currentPlaygroundTaskMessages];

						outputChannel.appendLine(`Playground: Calling Task.attemptApiRequest with model: ${currentPlaygroundTask.api.getModel().id}, temp: ${currentTemperature}`);
						
						let fullResponse = "";
                        let inputTokensThisTurn = 0;
                        let outputTokensThisTurn = 0;
						const stream = currentPlaygroundTask.attemptApiRequest();

						for await (const chunk of stream) {
							if (chunk.type === "text" && chunk.text) {
								fullResponse += chunk.text;
							} else if (chunk.type === "usage" && chunk.inputTokens !== undefined && chunk.outputTokens !== undefined) {
                                inputTokensThisTurn += chunk.inputTokens;
                                outputTokensThisTurn += chunk.outputTokens;
								outputChannel.appendLine(`Playground API Usage: In: ${chunk.inputTokens}, Out: ${chunk.outputTokens}, Cost: ${chunk.totalCost}`);
							} else if (chunk.type === "reasoning" && chunk.text) {
                                // Reasoning chunks are handled by Task's 'message' event if Task.say is used by the model for reasoning.
                            }
						}
                        
                        const responseDatetime = new Date().toISOString();

                        if (currentPlaygroundTask) { // Check if task wasn't aborted mid-stream
                            currentPlaygroundTaskMessages.push({ role: 'assistant', content: fullResponse });
                            
                             if (!currentPlaygroundTask.abort) { 
                                newPanel.webview.postMessage({ 
                                    type: 'playgroundChatResponse', 
                                    payload: { content: fullResponse, taskId: currentPlaygroundTask.taskId, datetime: responseDatetime }
                                });

                                // Send turn details
                                const modelDetails = currentPlaygroundTask.api.getModel();
                                const modelId = modelDetails.id;
                                const modelInfo = modelDetails.info;

                                newPanel.webview.postMessage({
                                    type: 'playgroundTurnDetails',
                                    payload: {
                                        taskId: currentPlaygroundTask.taskId,
                                        datetime: responseDatetime,
                                        inputTokensThisTurn,
                                        outputTokensThisTurn,
                                        contextWindowSize: modelInfo.contextWindow,
                                        maxOutputTokens: modelInfo.maxTokens, 
                                        modelId,
                                    }
                                });
                            }
                        }
						outputChannel.appendLine(`Playground API Full Response: "${fullResponse}"`);

					} catch (error: any) {
						outputChannel.appendLine(`Playground: Error processing playgroundProcessMessage: ${error.message}`);
						if (currentPlaygroundTask && !currentPlaygroundTask.abort) {
                            newPanel.webview.postMessage({ 
                                type: 'playgroundChatError', 
                                payload: { error: error.message || "Unknown API error", taskId: currentPlaygroundTask.taskId, datetime: new Date().toISOString() } 
                            });
                        }
					}
					return;
			}
		},
		undefined,
		context.subscriptions
	);

	newPanel.onDidDispose(
		() => {
			outputChannel.appendLine('Playground Chat panel disposed');
			webviewMessageDisposable.dispose();
            if (taskMessageListenerDisposable) {
                taskMessageListenerDisposable.dispose();
            }
			if (currentPlaygroundTask) {
				currentPlaygroundTask.abortTask(true);
			}
		},
		null,
		context.subscriptions
	);

	newPanel.reveal(column);
	return newPanel; // Or some identifier if needed elsewhere
};

// Function to generate HTML content for the PlaygroundChatView webview
// Adapted from ClineProvider's getHtmlContent
const getPlaygroundChatViewHtmlContent = (webview: vscode.Webview, extensionUri: vscode.Uri): string => { // Renamed HTML content function
	const stylesUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "index.css"]);
	const scriptUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "index.js"]);
	const codiconsUri = getUri(webview, extensionUri, ["node_modules", "@vscode", "codicons", "dist", "codicon.css"]);
	const materialIconsUri = getUri(webview, extensionUri, ["node_modules", "vscode-material-icons", "generated", "icons"]);
	const imagesUri = getUri(webview, extensionUri, ["assets", "images"]);
	const audioUri = getUri(webview, extensionUri, ["webview-ui", "audio"]);
	const nonce = getNonce();

	// CSP similar to ClineProvider, adjust if necessary for NewChatView's specific needs
	const csp = [
		"default-src 'none'",
		`font-src ${webview.cspSource}`,
		`style-src ${webview.cspSource} 'unsafe-inline'`, // 'unsafe-inline' for styles if needed by toolkit/libs
		`img-src ${webview.cspSource} data:`,
		`media-src ${webview.cspSource}`,
		`script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' https://us-assets.i.posthog.com 'strict-dynamic'`, // Added PostHog for consistency, can be removed if not used
		`connect-src https://openrouter.ai https://api.requesty.ai https://us.i.posthog.com https://us-assets.i.posthog.com` // Copied from ClineProvider, adjust as needed
	];


	return /*html*/ `
		<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
				<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
				<link rel="stylesheet" type="text/css" href="${stylesUri}">
				<link href="${codiconsUri}" rel="stylesheet" />
				<script nonce="${nonce}">
					window.IMAGES_BASE_URI = "${imagesUri}";
					window.AUDIO_BASE_URI = "${audioUri}";
					window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}";
					// Indicator that this webview is for the PlaygroundChatView, if the React app needs to know
					// window.ROO_WEBVIEW_CONTEXT = "playgroundChat"; 
				</script>
				<title>Playground Chat</title> {/* Updated HTML Title */}
			</head>
			<body>
				<noscript>You need to enable JavaScript to run this app.</noscript>
				<div id="root"></div>
				<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
			</body>
		</html>
	`;
};
