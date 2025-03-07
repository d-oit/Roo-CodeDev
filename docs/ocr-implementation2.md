# OCR Implementation Details

This document describes the technical implementation of OCR features in Roo Code using Mistral's document understanding capabilities.

## Architecture Overview

### 1. Command Interface

The OCR functionality is accessible through the `/process` command in chat:

```
/process <file> [options]
```

Supported input types:

- Local files (PDF, PNG, JPEG)
- URLs (HTTP/HTTPS)
- Direct uploads/streams

### 2. Configuration

#### Model Configuration

```typescript
interface OcrModelConfig {
	temperature: number // Fixed at optimal setting for OCR
	systemPrompt: string // Base prompt for OCR processing
	userPromptTemplates: {
		// Task-specific prompts
		basic: string // Basic text extraction
		tables: string // Table extraction
		layout: string // Layout analysis
		analysis: string // Full document analysis
	}
}
```

#### Text OCR Configuration

```typescript
interface OcrConfig {
	textProcessing: {
		systemPrompt: string
		userTemplates: {
			basic: string
			tables: string
			layout: string
			analysis: string
		}
	}
}
```

#### API Handler Options

```typescript
interface ApiHandlerOptions {
	// ... existing options ...
	ocrConfig?: OcrConfig
}
```

#### Process Options

```typescript
interface ProcessOptions {
	save?: boolean // Save output to file
	format?: "markdown" | "text"
	visualize?: boolean // Generate visualizations
	vizType?: "layout" | "sections" | "tables"
	analyze?: boolean // Detailed analysis
	chunks?: boolean // Process large docs in chunks
}
```

### 3. Processing Pipeline

1. **Document Loading**

    ```typescript
    async loadDocument(source: string): Promise<DocumentContent> {
      // Determine source type (file/url/stream)
      // Load and encode document
      // Return standardized document content
    }
    ```

2. **Prompt Generation**

    ```typescript
    getOcrPrompt(type: 'basic' | 'tables' | 'layout' | 'analysis',
                 document: DocumentContent): string {
      // Select appropriate template
      // Combine with system prompt
      // Return formatted prompt
    }
    ```

3. **Process Execution**
    ```typescript
    async processDocument(document: DocumentContent,
                         options: ProcessOptions): Promise<DocumentOutput> {
      // Prepare document and prompt
      // Execute OCR process
      // Format and return results
    }
    ```

### 4. Output Handling

Output types supported:

- Markdown text
- Structured tables
- Layout analysis
- Visualizations
- Document metadata

### 5. Integration Points

1. **Chat Interface**

    - Command parsing
    - Progress updates
    - Interactive options
    - Error handling

2. **File System**

    - File reading
    - Result saving
    - Visualization export

3. **Model API**

    - Document submission
    - Stream handling
    - Error recovery
    - Model configuration:
        ```typescript
        // Default model configurations
        const DEFAULT_MODELS = {
        	text_model: "mistral-small-latest", // For text processing
        	ocr_model: "mistral-ocr-latest", // For document OCR
        }
        ```

4. **API Configuration UI**
    - Model selection panel
        - OCR model dropdown (default: "mistral-ocr-latest")
        - Text OCR model dropdown (default: "mistral-small-latest")
    - Configuration options
        - Temperature controls
        - System prompt editor
        - Template customization
    - Example:
        ```typescript
        interface ModelSelectionUi {
        	ocrModel: {
        		id: string
        		name: string
        		options: string[]
        		default: string
        	}
        	textOcrModel: {
        		id: string
        		name: string
        		options: string[]
        		default: string
        	}
        }
        ```
