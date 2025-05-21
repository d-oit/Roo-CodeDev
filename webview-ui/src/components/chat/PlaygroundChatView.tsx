import React, { useState, useEffect, useRef } from 'react';
import { vscode } from '../../utils/vscode';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
// Select components are removed
import { Slider } from '../ui/slider';
import { Textarea } from '../ui/textarea';
import { VSCodeProgressRing } from '@vscode/webview-ui-toolkit/react';
import { ContextWindowProgress } from './ContextWindowProgress'; // Import ContextWindowProgress

interface Message {
  id: number;
  sender: 'user' | 'system' | 'assistant';
  text: string;
  isLoading?: boolean;
  taskId?: string; // Added taskId
  datetime?: string; // Added datetime
}

const PlaygroundChatView: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInputText, setCurrentInputText] = useState('');
  // const [role, setRole] = useState('User'); // Role state removed
  const [systemPromptText, setSystemPromptText] = useState(''); 
  const [temperature, setTemperature] = useState(0.7);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // State for ContextWindowProgress
  const [sessionInputTokens, setSessionInputTokens] = useState(0);
  const [sessionOutputTokens, setSessionOutputTokens] = useState(0);
  const [modelContextWindowSize, setModelContextWindowSize] = useState<number | undefined>(undefined);
  const [modelMaxOutputTokens, setModelMaxOutputTokens] = useState<number | undefined>(undefined);
  const [modelIdForProgress, setModelIdForProgress] = useState<string | undefined>(undefined);
  const [currentSessionTaskId, setCurrentSessionTaskId] = useState<string | undefined>(undefined);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data; // The JSON data our extension sent
      const payload = message.payload;

      switch (message.type) {
        case 'playgroundChatUserMessage': // Handle echoed user message
          setMessages(prevMessages => [
            ...prevMessages,
            {
              id: Date.now(), // Or use an ID from payload if provided
              sender: 'user',
              text: payload.content,
              taskId: payload.taskId,
              datetime: payload.datetime,
            },
          ]);
          break;
        case 'playgroundChatResponse':
          setMessages(prevMessages =>
            prevMessages.map(m =>
              m.isLoading && m.sender === 'assistant'
                ? { ...m, text: payload.content, isLoading: false, taskId: payload.taskId, datetime: payload.datetime }
                : m
            )
          );
          break;
        case 'playgroundChatError':
          setMessages(prevMessages => [
            ...prevMessages.filter(m => !(m.isLoading && m.sender === 'assistant')),
            {
              id: Date.now(),
              sender: 'system',
              text: `Error: ${payload.error}`,
              taskId: payload.taskId,
              datetime: payload.datetime,
            },
          ]);
          break;
        case 'playgroundTurnDetails':
          {
            const {
              taskId,
              inputTokensThisTurn,
              outputTokensThisTurn,
              contextWindowSize,
              maxOutputTokens,
              modelId,
            } = payload;

            if (taskId !== currentSessionTaskId) {
              setSessionInputTokens(inputTokensThisTurn);
              setSessionOutputTokens(outputTokensThisTurn);
              setCurrentSessionTaskId(taskId);
            } else {
              setSessionInputTokens(prev => prev + inputTokensThisTurn);
              setSessionOutputTokens(prev => prev + outputTokensThisTurn);
            }
            setModelContextWindowSize(contextWindowSize);
            setModelMaxOutputTokens(maxOutputTokens);
            setModelIdForProgress(modelId);
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSend = () => {
    if (!currentInputText.trim()) return;

    // User message is no longer added directly. It will be echoed back by the extension.
    // Still add the "Thinking..." message for the assistant.
    const assistantLoadingMessage: Message = {
      id: Date.now() + 1, // Ensure unique ID for the placeholder
      sender: 'assistant',
      text: 'Thinking...',
      isLoading: true,
      // taskId and datetime will be filled when the actual response arrives
    };

    setMessages(prevMessages => [...prevMessages, assistantLoadingMessage]);
    // setCurrentInputText(''); // Clear input after sending the message to extension

    vscode.postMessage({
      type: 'playgroundProcessMessage', // Updated message type
      payload: {
        systemPrompt: systemPromptText, // Added systemPrompt
        userMessage: currentInputText,  // Renamed from 'content' for clarity
        temperature: temperature,       // Kept temperature
        // 'role' field is removed from payload
      },
    });
  };

  const handleSystemPromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSystemPromptText(e.target.value);
    // Placeholder: Actual state management and debouncing will be handled later.
  };
  
  // Overall container style
  const viewStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 20px)', // Adjust based on where it's rendered, assuming some padding from parent
    fontFamily: 'var(--vscode-font-family)',
    color: 'var(--vscode-editor-foreground)',
    background: 'var(--vscode-editor-background)', // Use VS Code's editor background
  };

  const chatContainerStyle: React.CSSProperties = {
    flexGrow: 1,
    overflowY: 'auto',
    padding: '20px',
    borderBottom: '1px solid var(--vscode-sideBar-border, #e0e0e0)', // Use VSCode var or fallback
    display: 'flex',
    flexDirection: 'column',
    gap: '12px', // Spacing between messages
  };

  const messageStyle = (sender: Message['sender']): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      padding: '10px 15px',
      borderRadius: '18px',
      maxWidth: '75%',
      wordBreak: 'break-word',
      boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
      lineHeight: '1.5',
      position: 'relative', // For potential absolute positioning of metadata if needed
    };
    if (sender === 'user') {
      return {
        ...baseStyle,
        alignSelf: 'flex-end',
        backgroundColor: 'var(--vscode-button-background, #007AFF)',
        color: 'var(--vscode-button-foreground, white)',
      };
    } else if (sender === 'assistant') {
      return {
        ...baseStyle,
        alignSelf: 'flex-start',
        backgroundColor: 'var(--vscode-input-background, #f0f0f0)',
        color: 'var(--vscode-input-foreground, black)',
      };
    } else { // System messages (e.g., errors)
      return {
        ...baseStyle,
        alignSelf: 'center', // Center system messages/errors
        backgroundColor: 'var(--vscode-editorWarning-background, #fff3cd)',
        color: 'var(--vscode-editorWarning-foreground, #856404)',
        border: `1px solid var(--vscode-editorWarning-border, #ffeeba)`,
        fontStyle: 'italic',
        textAlign: 'center',
        maxWidth: '85%',
      };
    }
  };

  const inputAreaStyle: React.CSSProperties = {
    padding: '15px 20px',
    borderTop: '1px solid var(--vscode-sideBar-border, #e0e0e0)',
    background: 'var(--vscode-sideBar-background, #f5f5f5)',
  };
  
  const systemPromptDetailsStyle: React.CSSProperties = {
    marginBottom: '15px',
  };

  const systemPromptSummaryStyle: React.CSSProperties = {
    cursor: 'pointer',
    fontWeight: 'bold',
    color: 'var(--vscode-settings-headerForeground)',
    fontSize: '0.9em',
    paddingBottom: '5px', // Add some space below the summary
  };
  
  const systemPromptTextareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '80px',
    marginTop: '8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px', // Consistent with other inputs if possible
  };

  const inputRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '15px',
  };

  const controlsRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    // justifyContent: 'space-between', // Role selector removed, adjust as needed
    justifyContent: 'center', // Center the remaining temperature slider
    gap: '15px',
  };
  
  const controlItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px', // Space between label and control
  };
  
  const labelStyle: React.CSSProperties = {
    fontSize: '0.9em',
    color: 'var(--vscode-settings-headerForeground)',
  };
  
  const contextProgressContainerStyle: React.CSSProperties = {
    padding: '5px 20px 10px 20px', // Reduced top padding, more bottom padding before system prompt
    borderBottom: '1px solid var(--vscode-divider-background, #e0e0e0)', // Separator line
    // background: 'var(--vscode-editorWidget-background, #252526)', // Optional: Slightly different background
  };

  const metadataStyle: React.CSSProperties = {
    fontSize: '0.75em',
    color: 'var(--vscode-descriptionForeground)', // A less prominent color
    marginTop: '8px',
    paddingTop: '5px',
    borderTop: '1px solid var(--vscode-editorWidget-border, #ccc)', // Subtle separator
    display: 'flex',
    flexDirection: 'column', // Stack metadata items
    gap: '2px', // Space between metadata items
  };
  
  const metadataItemStyle: React.CSSProperties = {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  return (
    <div style={viewStyle}>
      <div ref={chatContainerRef} style={chatContainerStyle}>
        {/* Context Window Progress Bar - Placed above messages */}
        {modelContextWindowSize !== undefined && modelIdForProgress && (
          <div style={contextProgressContainerStyle} title={`Model: ${modelIdForProgress}`}>
            <ContextWindowProgress
              contextWindow={modelContextWindowSize}
              contextTokens={sessionInputTokens + sessionOutputTokens}
              maxTokens={modelMaxOutputTokens}
            />
          </div>
        )}
        {messages.length === 0 && (!modelContextWindowSize || !modelIdForProgress) ? ( // Adjust placeholder condition
          <p style={{ textAlign: 'center', color: 'var(--vscode-descriptionForeground)', marginTop: '20px' }}>
            Start a conversation by typing below.
          </p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} style={messageStyle(msg.sender)}>
              <div> {/* Wrapper for sender and text */}
                <strong style={{ display: 'block', marginBottom: '3px', fontSize: '0.9em' }}>
                  {msg.sender.charAt(0).toUpperCase() + msg.sender.slice(1)}
                </strong>
                {msg.isLoading && msg.sender === 'assistant' ? (
                  <VSCodeProgressRing style={{width: '20px', height: '20px', display: 'inline-block', verticalAlign: 'middle', marginRight: '8px'}} />
                ) : null}
                {msg.text}
              </div>
              {(msg.taskId || msg.datetime) && !msg.isLoading && (
                <div style={metadataStyle}>
                  {msg.taskId && <span style={metadataItemStyle}>Task: {msg.taskId}</span>}
                  {msg.datetime && <span style={metadataItemStyle}>Time: {new Date(msg.datetime).toLocaleString()}</span>}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div style={inputAreaStyle}>
        <details style={systemPromptDetailsStyle}>
          <summary style={systemPromptSummaryStyle}>System Prompt</summary>
          <Textarea
            value={systemPromptText}
            onChange={handleSystemPromptChange}
            placeholder="Enter system prompt here (e.g., You are a helpful assistant specializing in TypeScript development)..."
            style={systemPromptTextareaStyle}
            rows={3} // Initial rows
          />
        </details>

        <div style={inputRowStyle}>
          <Input
            type="text"
            value={currentInputText}
            onChange={(e) => setCurrentInputText(e.target.value)}
            placeholder="Type your message..."
            style={{ flexGrow: 1, marginRight: '10px' }}
            onKeyPress={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }}}
            disabled={messages.some(m => m.isLoading)} 
          />
          <Button onClick={handleSend} disabled={messages.some(m => m.isLoading) || !currentInputText.trim()}>Send</Button>
        </div>

        <div style={controlsRowStyle}>
          {/* Role Selector Removed */}
          <div style={{...controlItemStyle, flexGrow: 1 /* Allow slider to take more space */ }}> 
            <label htmlFor="temp-slider" style={labelStyle}>Temp:</label>
            <Slider
              id="temp-slider"
              min={0}
              max={1}
              step={0.1}
              value={[temperature]}
              onValueChange={([newTemp]) => setTemperature(newTemp)}
              style={{ flexGrow: 1 }}
            />
            <span style={{ minWidth: '30px', textAlign: 'right', fontSize: '0.9em' }}>{temperature.toFixed(1)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlaygroundChatView;
