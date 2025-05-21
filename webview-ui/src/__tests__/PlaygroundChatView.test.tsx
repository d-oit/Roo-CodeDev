import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import PlaygroundChatView from '../components/chat/PlaygroundChatView'; // Updated import

// Mock acquireVsCodeApi
const mockVscode = {
  postMessage: jest.fn(),
  getState: jest.fn(),
  setState: jest.fn(),
};
(global as any).acquireVsCodeApi = () => mockVscode;

// Mock for vscode-webview-ui-toolkit components if not fully handled by jest.config.cjs
// jest.mock('@vscode/webview-ui-toolkit/react', () => ({
//   VSCodeProgressRing: () => <div data-testid="vscode-progress-ring">Loading...</div>,
// }));

// Mock ContextWindowProgress
jest.mock('../components/chat/ContextWindowProgress', () => ({ // Adjusted path
    ContextWindowProgress: jest.fn((props) => (
        <div data-testid="mock-context-progress">
            <span>ContextTokens: {props.contextTokens}</span>
            <span>ContextWindow: {props.contextWindow}</span>
            <span>MaxTokens: {props.maxTokens}</span>
            <span>ModelId: {props.modelIdForProgress}</span> {/* Added for easier verification if needed */}
        </div>
    ))
}));

describe('PlaygroundChatView Component', () => {
  beforeEach(() => {
    mockVscode.postMessage.mockClear();
    mockVscode.getState.mockClear();
    mockVscode.setState.mockClear();
  });

  test('renders initial state correctly', () => {
    render(<PlaygroundChatView />);

    // Check for system prompt textarea
    expect(screen.getByPlaceholderText(/Enter system prompt here/i)).toBeInTheDocument();

    // Check for user message input field
    expect(screen.getByPlaceholderText('Type your message...')).toBeInTheDocument();
    
    // Verify role selector is removed (example: query by its previous label or a more specific query if available)
    expect(screen.queryByText('Role:')).not.toBeInTheDocument(); // Assuming 'Role:' was a label
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); // General check if only one combobox was role


    // Check for temperature slider and its default value display
    expect(screen.getByRole('slider')).toHaveValue('0.7'); // Slider's value is string
    expect(screen.getByText('0.7')).toBeInTheDocument();

    // Check for initial placeholder message in chat area
    expect(screen.getByText('Start a conversation by typing below.')).toBeInTheDocument();

    // Check for Send button
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();

    // ContextWindowProgress should not be rendered initially
    expect(screen.queryByTestId('mock-context-progress')).not.toBeInTheDocument();
  });

  test('handles message input change', () => {
    render(<PlaygroundChatView />); // Updated component
    const input = screen.getByPlaceholderText('Type your message...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hello, world!' } });
    expect(input.value).toBe('Hello, world!');
  });

  test('handles system prompt input change', () => {
    render(<PlaygroundChatView />);
    const systemPromptTextarea = screen.getByPlaceholderText(/Enter system prompt here/i) as HTMLTextAreaElement;
    fireEvent.change(systemPromptTextarea, { target: { value: 'You are a helpful bot.' } });
    expect(systemPromptTextarea.value).toBe('You are a helpful bot.');
  });

  // test('handles role change', () => { // This test is removed as role selector is gone
  //   render(<PlaygroundChatView />); 
  //   const roleSelect = screen.getByRole('combobox'); 
  //   fireEvent.change(roleSelect, { target: { value: 'System' } });
  //   expect(roleSelect).toHaveValue('System');
  // });

  test('handles temperature change', () => {
    render(<PlaygroundChatView />);
    const tempSlider = screen.getByRole('slider');
    // Slider from ui/slider might need a different way to simulate change if it's not a native input[type=range]
    // For a native input[type=range] or a component that behaves like one:
    fireEvent.change(tempSlider, { target: { value: '0.3' } }); 
    expect(tempSlider).toHaveValue('0.3');
    expect(screen.getByText('0.3')).toBeInTheDocument();
  });

  describe('Sending Messages and Interacting with VS Code API', () => {
    test('sends message, displays user echo with metadata, then assistant response with metadata', async () => {
      render(<PlaygroundChatView />);
      
      const systemPromptTextarea = screen.getByPlaceholderText(/Enter system prompt here/i);
      const userMessageInput = screen.getByPlaceholderText('Type your message...');
      const tempSlider = screen.getByRole('slider');
      const sendButton = screen.getByRole('button', { name: 'Send' });
      const testDate = new Date('2023-10-26T10:00:00.000Z');

      // Simulate inputs
      fireEvent.change(systemPromptTextarea, { target: { value: 'Be a helpful bot.' } });
      fireEvent.change(userMessageInput, { target: { value: 'Hello bot!' } });
      fireEvent.change(tempSlider, { target: { value: '0.3' } });
      
      fireEvent.click(sendButton);

      // 1. Verify postMessage call to extension
      expect(mockVscode.postMessage).toHaveBeenCalledWith({
        type: 'playgroundProcessMessage',
        payload: {
          systemPrompt: 'Be a helpful bot.',
          userMessage: 'Hello bot!',
          temperature: 0.3,
        },
      });
      
      // 2. Verify "Thinking..." message for assistant appears immediately
      expect(screen.getByText('Thinking...')).toBeInTheDocument();
      expect(userMessageInput).toHaveValue(''); // Input cleared after sending message to extension

      // 3. Simulate extension echoing back the user message
      act(() => {
        const userEchoEvent = new MessageEvent('message', {
          data: {
            type: 'playgroundChatUserMessage',
            payload: { 
              content: 'Hello bot!', 
              taskId: 'user-task-123', 
              datetime: testDate.toISOString() 
            },
          },
        });
        window.dispatchEvent(userEchoEvent);
      });

      // 4. Verify user message is in the DOM with metadata
      expect(screen.getByText('Hello bot!')).toBeInTheDocument();
      expect(screen.getByText(/Task: user-task-123/i)).toBeInTheDocument();
      expect(screen.getByText(`Time: ${testDate.toLocaleString()}`)).toBeInTheDocument();
      const userSenderDisplay = screen.getAllByText('User').find(el => el.tagName === 'STRONG');
      expect(userSenderDisplay).toBeInTheDocument();

      // 5. Simulate extension sending assistant response
      act(() => {
        const assistantResponseEvent = new MessageEvent('message', {
          data: {
            type: 'playgroundChatResponse',
            payload: { 
              content: 'Assistant response here.', 
              taskId: 'assist-task-456', 
              datetime: new Date('2023-10-26T10:00:05.000Z').toISOString() 
            },
          },
        });
        window.dispatchEvent(assistantResponseEvent);
      });
      
      // 6. Verify "Thinking..." is gone, and assistant message with metadata is shown
      expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
      expect(screen.getByText('Assistant response here.')).toBeInTheDocument();
      expect(screen.getByText(/Task: assist-task-456/i)).toBeInTheDocument();
      expect(screen.getByText(`Time: ${new Date('2023-10-26T10:00:05.000Z').toLocaleString()}`)).toBeInTheDocument();
      const assistantSenderDisplay = screen.getAllByText('Assistant').find(el => el.tagName === 'STRONG');
      expect(assistantSenderDisplay).toBeInTheDocument();
    });

    // Test for ContextWindowProgress updates
    describe('ContextWindowProgress Handling', () => {
      test('updates token progress on playgroundTurnDetails message and resets for new taskId', () => {
        render(<PlaygroundChatView />);

        // Initial: ContextWindowProgress should not be visible or have default/no values
        expect(screen.queryByTestId('mock-context-progress')).not.toBeInTheDocument();

        // Simulate first turn details for task1
        const turnDetails1 = {
          taskId: 'task1',
          datetime: new Date().toISOString(),
          inputTokensThisTurn: 100,
          outputTokensThisTurn: 50,
          contextWindowSize: 8000,
          maxOutputTokens: 2000,
          modelId: 'claude-3-sonnet'
        };
        act(() => {
          fireEvent(
            window,
            new MessageEvent('message', {
              data: { type: 'playgroundTurnDetails', payload: turnDetails1 },
            })
          );
        });
        
        let progressMock = screen.getByTestId('mock-context-progress');
        expect(progressMock).toBeInTheDocument();
        expect(screen.getByText('ContextTokens: 150')).toBeInTheDocument(); // 100 + 50
        expect(screen.getByText('ContextWindow: 8000')).toBeInTheDocument();
        expect(screen.getByText('MaxTokens: 2000')).toBeInTheDocument();

        // Simulate second turn details for task1 (accumulation)
        const turnDetails2 = {
          taskId: 'task1', // Same taskId
          datetime: new Date().toISOString(),
          inputTokensThisTurn: 70,
          outputTokensThisTurn: 30,
          contextWindowSize: 8000, 
          maxOutputTokens: 2000,   
          modelId: 'claude-3-sonnet'
        };
        act(() => {
          fireEvent(
            window,
            new MessageEvent('message', {
              data: { type: 'playgroundTurnDetails', payload: turnDetails2 },
            })
          );
        });
        expect(screen.getByText('ContextTokens: 250')).toBeInTheDocument(); // 150 + 70 + 30
        expect(screen.getByText('ContextWindow: 8000')).toBeInTheDocument();

        // Simulate turn details for a new task (task2 - should reset)
        const turnDetails3 = {
          taskId: 'task2', // Different taskId
          datetime: new Date().toISOString(),
          inputTokensThisTurn: 20,
          outputTokensThisTurn: 10,
          contextWindowSize: 4000,
          maxOutputTokens: 1000,
          modelId: 'claude-3-opus'
        };
        act(() => {
          fireEvent(
            window,
            new MessageEvent('message', {
              data: { type: 'playgroundTurnDetails', payload: turnDetails3 },
            })
          );
        });
        expect(screen.getByText('ContextTokens: 30')).toBeInTheDocument(); // 20 + 10 (reset)
        expect(screen.getByText('ContextWindow: 4000')).toBeInTheDocument();
        expect(screen.getByText('MaxTokens: 1000')).toBeInTheDocument();
      });
    });


    test('receives and displays an assistant response (direct, without user echo simulation for this test)', async () => {
      render(<PlaygroundChatView />);
      const testDate = new Date('2023-10-26T11:00:00.000Z');
      
      // Assume a "Thinking..." message is already present
      fireEvent.change(screen.getByPlaceholderText('Type your message...'), { target: { value: 'Query' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(screen.getByText('Thinking...')).toBeInTheDocument();


      act(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'playgroundChatResponse',
            payload: { 
              content: 'Hello from assistant!', 
              taskId: 'assist-task-789', 
              datetime: testDate.toISOString() 
            },
          },
        });
        window.dispatchEvent(event);
      });

      expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
      expect(screen.getByText('Hello from assistant!')).toBeInTheDocument();
      expect(screen.getByText(/Task: assist-task-789/i)).toBeInTheDocument();
      expect(screen.getByText(`Time: ${testDate.toLocaleString()}`)).toBeInTheDocument();
    });

    test('receives and displays an error message with metadata', async () => {
      render(<PlaygroundChatView />);
      const testDate = new Date('2023-10-26T12:00:00.000Z');

      act(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'playgroundChatError',
            payload: { 
              error: 'API failed spectacularly', 
              taskId: 'error-task-000', 
              datetime: testDate.toISOString() 
            },
          },
        });
        window.dispatchEvent(event);
      });
      
      expect(screen.getByText('Error: API failed spectacularly')).toBeInTheDocument();
      expect(screen.getByText(/Task: error-task-000/i)).toBeInTheDocument();
      expect(screen.getByText(`Time: ${testDate.toLocaleString()}`)).toBeInTheDocument();
    });
    
    test('disables input and send button during loading, enables after response', () => {
      render(<PlaygroundChatView />);
      const input = screen.getByPlaceholderText('Type your message...') as HTMLInputElement;
      const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;

      // Send a message
      fireEvent.change(input, { target: { value: 'Test message' } });
      fireEvent.click(sendButton);

      // Check if input and button are disabled
      expect(input).toBeDisabled();
      expect(sendButton).toBeDisabled();
      expect(screen.getByText('Thinking...')).toBeInTheDocument();


      // Simulate receiving a response
      act(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'playgroundChatResponse', // Updated type
            payload: { content: 'Response received' },
          },
        });
        window.dispatchEvent(event);
      });

      // Check if input and button are enabled again
      expect(input).not.toBeDisabled();
      expect(sendButton).not.toBeDisabled();
      expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
      expect(screen.getByText('Response received')).toBeInTheDocument();
    });

     test('disables input and send button during loading, enables after error', () => {
      render(<PlaygroundChatView />); // Updated component
      const input = screen.getByPlaceholderText('Type your message...') as HTMLInputElement;
      const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;

      // Send a message
      fireEvent.change(input, { target: { value: 'Test message for error' } });
      fireEvent.click(sendButton);

      // Check if input and button are disabled
      expect(input).toBeDisabled();
      expect(sendButton).toBeDisabled();

      // Simulate receiving an error
      act(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'playgroundChatError', // Updated type
            payload: { error: 'Failed response' },
          },
        });
        window.dispatchEvent(event);
      });
      
      // Check if input and button are enabled again
      expect(input).not.toBeDisabled();
      expect(sendButton).not.toBeDisabled();
      expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
      expect(screen.getByText('Error: Failed response')).toBeInTheDocument();
    });
  });
});
