import * as vscode from 'vscode';
import { ContextProxy } from '../../core/config/ContextProxy';
import { buildApiHandler } from '../../api';
import { getNonce } from '../../core/webview/getNonce';
// Assuming registerCommands is where openNewChatViewPanel is defined and exported,
// or it's part of the map returned by getCommandsMap.
// For this test, we'll need to access the command's callback function.
// Let's say the actual command registration happens in `activate/index.ts` which calls `registerCommands`.
// We'll need to simulate that.

// Mock 'vscode' module
jest.mock('vscode', () => {
  const actualVscode = jest.requireActual('../../../src/__mocks__/vscode.js'); // Use the existing base mock
  return {
    ...actualVscode,
    window: {
      ...actualVscode.window,
      createWebviewPanel: jest.fn(),
      showInformationMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      activeTextEditor: undefined,
    },
    commands: {
      ...actualVscode.commands,
      registerCommand: jest.fn(),
      executeCommand: jest.fn(),
    },
    Uri: {
      ...actualVscode.Uri,
      joinPath: jest.fn((base, ...paths) => ({ ...base, fsPath: `${base.fsPath}/${paths.join('/')}`, path: `${base.path}/${paths.join('/')}` })),
    },
    ViewColumn: {
      One: 1,
      Beside: 2,
      Active: -1,
    }
  };
});

// Mock other dependencies
jest.mock('../../core/config/ContextProxy');
jest.mock('../../api'); // Keep this if buildApiHandler is still used for Task's internal api
jest.mock('../../core/webview/getNonce');
jest.mock('../../core/task/Task'); // Mock the Task class
jest.mock('../../services/telemetry/TelemetryService', () => ({
  telemetryService: {
    captureException: jest.fn(),
    captureCommandUsed: jest.fn(),
    // Add any other methods used by the functions under test
  },
}));


describe('PlaygroundChatViewPanel Tests', () => {
  let mockContext: vscode.ExtensionContext;
  let mockOutputChannel: vscode.OutputChannel;
  let mockWebviewPanel: any;
  // let mockApiHandler: any; // Will be part of mockTaskInstance.api now
  let mockProviderSettings: any;
  let mockTaskInstance: any;
  let TaskMock: jest.MockedClass<typeof import('../../core/task/Task').Task>;
  let storedShimInstance: any; // To store the shim instance for inspection

  beforeEach(() => {
    jest.clearAllMocks();
    storedShimInstance = null; // Reset stored shim

    mockContext = {
      extensionUri: { scheme: 'file', fsPath: '/mock/extension', path: '/mock/extension', authority: '', query: '', fragment: '', with: jest.fn(), toJSON: jest.fn() },
      subscriptions: [],
      globalState: { get: jest.fn(), update: jest.fn() } as any,
      secrets: { get: jest.fn(), store: jest.fn(), onDidChange: jest.fn() } as any,
      workspaceState: { get: jest.fn(), update: jest.fn() } as any,
      extensionPath: '/mock/extension',
      storageUri: { scheme: 'file', fsPath: '/mock/storage', path: '/mock/storage' } as any,
      globalStorageUri: { scheme: 'file', fsPath: '/mock/globalStorage', path: '/mock/globalStorage' } as any,
      logUri: { scheme: 'file', fsPath: '/mock/log', path: '/mock/log' } as any,
      extensionMode: vscode.ExtensionMode.Test,
      environmentVariableCollection: {} as any,
    } as vscode.ExtensionContext;

    mockOutputChannel = {
      appendLine: jest.fn(), append: jest.fn(), clear: jest.fn(), dispose: jest.fn(),
      hide: jest.fn(), name: 'mockOutputChannel', replace: jest.fn(), show: jest.fn(),
    };

    mockWebviewPanel = {
      webview: {
        html: '', onDidReceiveMessage: jest.fn(), postMessage: jest.fn(),
        asWebviewUri: jest.fn(uri => ({ ...uri, scheme: 'vscode-webview-resource' })),
        cspSource: 'mock-csp-source',
      },
      onDidDispose: jest.fn(), reveal: jest.fn(), onDidChangeViewState: jest.fn(),
      dispose: jest.fn(), options: {}, viewColumn: vscode.ViewColumn.One, title: '',
      visible: true, active: true, viewType: '', iconPath: undefined,
    };
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockWebviewPanel);
    
    // Setup mock for Task
    TaskMock = require('../../core/task/Task').Task as jest.MockedClass<typeof import('../../core/task/Task').Task>;
    
    // Resetable mock for each Task instance
    const createMockTaskInstance = (taskIdSuffix: string = 'default') => ({
      taskId: `mock-task-id-${taskIdSuffix}-${Math.random().toString(36).substring(2, 7)}`,
      instanceId: `mock-instance-id-${taskIdSuffix}-${Math.random().toString(36).substring(2,7)}`,
      attemptApiRequest: jest.fn().mockReturnValue(async function* () {}()),
      abortTask: jest.fn(),
      on: jest.fn().mockReturnValue({ dispose: jest.fn() }), 
      removeAllListeners: jest.fn(), 
      apiConfiguration: { modelTemperature: 0.5 },
      apiConversationHistory: [],
      api: {
        getModel: jest.fn().mockReturnValue({ 
          id: 'mock-model-id-default', 
          info: { 
            contextWindow: 10000, 
            maxTokens: 1000,
            supportsImages: false,
            supportsComputerUse: false,
            supportsPromptCache: false,
          } 
        }),
      },
      startTask: jest.fn(), 
      getSystemPrompt: jest.fn().mockResolvedValue("Default Mock System Prompt"),
    });

    mockTaskInstance = createMockTaskInstance(); // Initial instance for setup

    TaskMock.mockImplementation((options: any) => {
      storedShimInstance = options.provider;
      const newTaskInstance = createMockTaskInstance(options.taskId || 'impl'); // Use provided taskId or default for uniqueness
      newTaskInstance.apiConfiguration = { ...options.apiConfiguration };
      // This global mockTaskInstance will point to the *last* task created.
      // Tests needing specific instances should use lastCreatedTaskInstance pattern.
      // However, since many tests already use 'lastCreatedTaskInstance', we'll stick to that
      // pattern where applicable, and ensure 'mockTaskInstance' is updated if needed globally.
      // For simplicity in this specific test, we'll assume `lastCreatedTaskInstance` is used.
      return newTaskInstance; 
    });


    (getNonce as jest.Mock).mockReturnValue('mock-nonce');
    
    mockProviderSettings = { apiProvider: 'anthropic', modelTemperature: 0.7, otherSetting: 'value' };
    (ContextProxy.getInstance as jest.Mock).mockResolvedValue({
      getProviderSettings: jest.fn().mockReturnValue(mockProviderSettings),
      getValues: jest.fn().mockReturnValue({ someGlobalSetting: true }), // For minimalProviderShim's getState
      getValue: jest.fn(), // For minimalProviderShim's getGlobalState
    });

    // Mock buildApiHandler if it's still called directly by Task or shim
    // For this refactor, Task itself calls buildApiHandler internally, so this mock might be for Task's internal use
     const actualBuildApiHandler = jest.requireActual('../../api').buildApiHandler;
    (buildApiHandler as jest.Mock).mockImplementation((config) => {
        // Return a basic mock or a more functional one if Task relies on it heavily
        return {
            ...actualBuildApiHandler(config), // Call actual to get a base object
            createMessage: mockTaskInstance.attemptApiRequest, // Ensure Task's internal api.createMessage points to our mock stream
            getModel: jest.fn().mockReturnValue({ id: config.openAiModelId || 'mock-dynamic-model', info: {} }),
        };
    });
  });

  // Helper to get the command callback
  const getCommandCallback = (commandName: string) => {
    // Dynamically import registerCommands to test the actual command registration
    // This is a bit tricky as registerCommands populates a map.
    // We might need to refactor registerCommands slightly or test it more indirectly.
    // For now, let's assume we can get a direct handle to openNewChatViewPanel
    // or its equivalent from the module if it were exported.
    
    // Let's assume openNewChatViewPanel is part of what's returned by getCommandsMap
    // and registerCommands uses that. We'd need to actually call registerCommands.
    
    // For a more direct test of openPlaygroundChatViewPanel, we'd import it.
    // If it's not exported, we test it via the command registration.
    // The provided code for `registerCommands.ts` defines `openPlaygroundChatViewPanel` as a static function
    // and adds it to a map. We'll need to simulate the registration and then extract the callback.

    // Simplified approach: We'll call the function that would be registered.
    // This requires `openPlaygroundChatViewPanel` to be accessible or the command map to be queryable.
    // The current structure of `registerCommands.ts` makes this a bit indirect.
    // We will test the `openPlaygroundChatViewPanel` function (or its equivalent logic)
    // as if it were called by the command dispatcher.

    // The actual `openPlaygroundChatViewPanel` is not exported. It's called via a map.
    // We will extract it from the `getCommandsMap` call within `registerCommands`.
    // This is a bit of an integration test for `getCommandsMap` itself.
    
    // To do this properly, we need to import `registerCommands` and `getCommandsMap`
    // from `../registerCommands`. The provided code shows `getCommandsMap` and
    // `openPlaygroundChatViewPanel` inside `registerCommands.ts`.
    // Let's dynamically require it and get the map.
    const { getCommandsMap: actualGetCommandsMap } = jest.requireActual<typeof import('../registerCommands')>('../registerCommands');
    const commandsMap = actualGetCommandsMap({ context: mockContext, outputChannel: mockOutputChannel, provider: {} as any });
    return commandsMap[commandName];
  };


  test('Roo.playgroundChat command creates a webview panel', async () => { // Renamed test and command ID
    const playgroundChatCommandCallback = getCommandCallback('playgroundChat'); // Renamed command ID
    await playgroundChatCommandCallback();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'Roo.PlaygroundChatViewPanel', // Renamed Panel ID
      'Playground Chat', // Updated Panel Title
      expect.anything(), // ViewColumn can vary
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mockContext.extensionUri],
      }
    );
    expect(mockWebviewPanel.webview.html).toContain('id="root"'); // Basic check for HTML content
    expect(mockWebviewPanel.webview.onDidReceiveMessage).toHaveBeenCalled();
    expect(mockWebviewPanel.onDidDispose).toHaveBeenCalled();
  });

  describe('Message Handling in PlaygroundChatViewPanel with Task System', () => { // Updated describe
    let onWebviewMessageCallback: (message: any) => Promise<void>;
    let onPanelDisposeCallback: () => void;
    let onTaskMessageCallback: (event: { message: any }) => void;

    beforeEach(async () => {
      const playgroundChatCommandCallback = getCommandCallback('playgroundChat');
      await playgroundChatCommandCallback();
      
      onWebviewMessageCallback = (mockWebviewPanel.webview.onDidReceiveMessage as jest.Mock).mock.calls[0][0];
      onPanelDisposeCallback = (mockWebviewPanel.onDidDispose as jest.Mock).mock.calls[0][0];
      
      const messageEventCall = mockTaskInstance.on.mock.calls.find((call: any) => call[0] === 'message');
      if (messageEventCall) {
        onTaskMessageCallback = messageEventCall[1];
      } else {
        console.warn("Task 'message' event listener not found in mock. Tests for task-emitted messages might not run correctly.");
        onTaskMessageCallback = () => {};
      }
    });

    test('sends messages and playgroundTurnDetails on successful API call', async () => {
      const userMessagePayload = { systemPrompt: 'SP1', userMessage: 'Query1', temperature: 0.7 };
      mockWebviewPanel.webview.postMessage.mockClear(); 

      const mockModelId = 'test-model-id';
      const mockContextWindow = 16000;
      const mockMaxTokens = 4000;

      const mockStreamData = [
        { type: 'text', text: 'Response1 part1' },
        { type: 'usage', inputTokens: 50, outputTokens: 10, totalCost: 0.01 },
        { type: 'text', text: ' part2' },
        { type: 'usage', inputTokens: 0, outputTokens: 15, totalCost: 0.02 },
      ];
      
      const currentTaskAttemptApiRequest = jest.fn().mockReturnValue(async function* () {
        for (const item of mockStreamData) { yield item; }
      }());

      // This TaskMock.mockImplementationOnce will apply to the Task created for this specific message
      TaskMock.mockImplementationOnce((options: any) => {
        storedShimInstance = options.provider;
        lastCreatedTaskInstance = {
          taskId: `task-for-details-test`,
          instanceId: `instance-for-details-test`,
          attemptApiRequest: currentTaskAttemptApiRequest,
          abortTask: jest.fn(),
          on: jest.fn().mockReturnValue({ dispose: jest.fn() }),
          removeAllListeners: jest.fn(),
          apiConfiguration: { ...options.apiConfiguration },
          apiConversationHistory: [], // Will be set by prod code
          api: { 
            getModel: jest.fn().mockReturnValue({ 
              id: mockModelId, 
              info: { contextWindow: mockContextWindow, maxTokens: mockMaxTokens } 
            }) 
          },
          startTask: jest.fn(),
          getSystemPrompt: jest.fn().mockResolvedValue(options.provider.currentSystemPrompt || "Default Mock System Prompt"),
        };
        return lastCreatedTaskInstance;
      });

      await onWebviewMessageCallback({ type: 'playgroundProcessMessage', payload: userMessagePayload });

      // ... (existing assertions for user echo, task creation, config, history, attemptApiRequest call)
      // Ensure this part is still valid or adjust as necessary
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'playgroundChatUserMessage' })
      );
      expect(TaskMock).toHaveBeenCalledTimes(2); // Initial in panel setup + 1 for this message
      expect(lastCreatedTaskInstance.apiConfiguration.modelTemperature).toBe(0.7);
      expect(storedShimInstance.currentSystemPrompt).toBe('SP1');
      expect(lastCreatedTaskInstance.apiConversationHistory).toEqual([{ role: 'user', content: 'Query1' }]);
      expect(lastCreatedTaskInstance.attemptApiRequest).toHaveBeenCalled();


      // Assert playgroundChatResponse
      const responseCall = mockWebviewPanel.webview.postMessage.mock.calls.find(call => call[0].type === 'playgroundChatResponse');
      expect(responseCall).toBeDefined();
      expect(responseCall[0].payload.content).toBe('Response1 part1 part2');
      expect(responseCall[0].payload.taskId).toBe(lastCreatedTaskInstance.taskId);
      expect(responseCall[0].payload.datetime).toEqual(expect.any(String));
      
      // Assert playgroundTurnDetails
      const detailsCall = mockWebviewPanel.webview.postMessage.mock.calls.find(call => call[0].type === 'playgroundTurnDetails');
      expect(detailsCall).toBeDefined();
      expect(detailsCall[0].payload).toEqual({
        taskId: lastCreatedTaskInstance.taskId,
        datetime: responseCall[0].payload.datetime, // Should match response datetime
        inputTokensThisTurn: 50, // 50 + 0
        outputTokensThisTurn: 25, // 10 + 15
        contextWindowSize: mockContextWindow,
        maxOutputTokens: mockMaxTokens,
        modelId: mockModelId,
      });
      
      // Verify assistant response added to task's history
      expect(lastCreatedTaskInstance.apiConversationHistory).toContainEqual(
        { role: 'assistant', content: 'Response1 part1 part2' }
      );
    });

    test('aborts previous task and resets history if system prompt changes', async () => {
      // Initial Task setup (captured as lastCreatedTaskInstance by the beforeEach mock)
      const initialTaskInstance = lastCreatedTaskInstance; 
      initialTaskInstance.api.getModel.mockReturnValue({ id: 'initial-model', info: { contextWindow: 8000, maxTokens: 2000 } });
      initialTaskInstance.attemptApiRequest.mockReturnValue(async function* () { yield { type: 'text', text: 'Response1' }; }());
      
      await onWebviewMessageCallback({
        type: 'playgroundProcessMessage',
        payload: { systemPrompt: 'SP1', userMessage: 'Query1', temperature: 0.7 }
      });
      expect(storedShimInstance.currentSystemPrompt).toBe('SP1');

      const oldTaskFromQuery1 = lastCreatedTaskInstance; // This is the task instance for Query1

      // Mock for the task that will be created for Query2
      const query2Stream = jest.fn().mockReturnValue(async function* () { yield { type: 'text', text: 'Response2' }; }());
      TaskMock.mockImplementationOnce((options: any) => {
        storedShimInstance = options.provider;
        lastCreatedTaskInstance = {
            taskId: `task-for-query2`,
            instanceId: `instance-for-query2`,
            attemptApiRequest: query2Stream,
            abortTask: jest.fn(),
            on: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            removeAllListeners: jest.fn(),
            apiConfiguration: { ...options.apiConfiguration },
            apiConversationHistory: [], // Will be set by prod code
            api: { getModel: jest.fn().mockReturnValue({ id: 'model-for-query2', info: {} }) },
            startTask: jest.fn(),
            getSystemPrompt: jest.fn().mockResolvedValue(options.provider.currentSystemPrompt),
        };
        return lastCreatedTaskInstance;
      });
      
      await onWebviewMessageCallback({
        type: 'playgroundProcessMessage',
        payload: { systemPrompt: 'SP2', userMessage: 'Query2', temperature: 0.8 }
      });

      expect(oldTaskFromQuery1.abortTask).toHaveBeenCalledWith(true);
      expect(storedShimInstance.currentSystemPrompt).toBe('SP2');
      // lastCreatedTaskInstance is now the one for Query2
      expect(lastCreatedTaskInstance.apiConversationHistory).toEqual([
          {role: 'user', content: 'Query2'},
          {role: 'assistant', content: 'Response2'}
      ]);
      expect(lastCreatedTaskInstance.apiConfiguration.modelTemperature).toBe(0.8);
    });
    
    test('handles error from task.attemptApiRequest', async () => {
      TaskMock.mockImplementationOnce((options: any) => {
        storedShimInstance = options.provider;
        lastCreatedTaskInstance = {
            taskId: `task-for-error-test`,
            attemptApiRequest: jest.fn().mockImplementation(async function* () { throw new Error('Task API Error'); }()),
            abortTask: jest.fn(),
            on: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            apiConfiguration: { ...options.apiConfiguration },
            apiConversationHistory: [],
            api: { getModel: jest.fn().mockReturnValue({ id: 'model-for-error', info: {} }) },
        };
        return lastCreatedTaskInstance;
      });

      await onWebviewMessageCallback({
        type: 'playgroundProcessMessage',
        payload: { systemPrompt: 'SP', userMessage: 'Query that fails', temperature: 0.5 }
      });
      expect(lastCreatedTaskInstance.attemptApiRequest).toHaveBeenCalled();
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'playgroundChatError',
        payload: expect.objectContaining({ error: 'Task API Error', taskId: lastCreatedTaskInstance.taskId })
      }));
    });

    test('handles error message emitted by Task via "message" event', () => {
      expect(onTaskMessageCallback).toBeDefined(); 
      const taskErrorMessage = { type: 'say', say: 'error', text: 'Error from Task say' };
      onTaskMessageCallback({ message: taskErrorMessage });

      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith({
        type: 'playgroundChatError',
        payload: { error: 'Error from Task say' },
      });
    });
    
    test('handles error message emitted by Task via "message" event (ask: api_req_failed)', () => {
      expect(onTaskMessageCallback).toBeDefined();
      const taskApiFailedMessage = { type: 'ask', ask: 'api_req_failed', text: 'Task API request failed details' };
      onTaskMessageCallback({ message: taskApiFailedMessage });

      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith({
        type: 'playgroundChatError',
        payload: { error: 'API Request Failed: Task API request failed details' },
      });
    });

    test('handles panel disposal by aborting task and removing listeners', () => {
      onPanelDisposeCallback();
      expect(mockTaskInstance.abortTask).toHaveBeenCalledWith(true);
      const mockSubscription = mockTaskInstance.on.mock.results[0]?.value;
      expect(mockSubscription?.removeAllListeners).toHaveBeenCalled();
    });
  });
});
