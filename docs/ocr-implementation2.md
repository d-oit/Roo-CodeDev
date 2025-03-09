# OCR Implementation Details

This document describes the technical implementation of OCR features in Roo Code using the document understanding capabilities of OCR-capable models.

## Architecture Overview

### 1. Command Interface

The OCR functionality is accessible through the `/process` command in chat (only visible when OCR API is configured):

```
/process <file> [options]
```

Supported input types:

- Local files (PDF, PNG, JPEG)
- URLs (HTTP/HTTPS)
- Direct uploads/streams

### 2. Configuration

#### OCR API Configuration

```typescript
interface OcrApiConfig {
	provider: string
	model: string // Model with document processing support (default: mistral-small-latest)
	temperature: number // Applied to text understanding phase
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

1. **API Configuration Check**

    ```typescript
    async function checkOcrApiConfig(): Promise<boolean> {
    	const config = await getOcrApiConfig()
    	return config !== undefined
    }
    ```

2. **Document Loading**

    ```typescript
    async function loadDocument(source: string): Promise<DocumentContent> {
    	// Determine source type (file/url/stream)
    	// Load and encode document
    	// Return standardized document content
    }
    ```

3. **Model Selection**

    ```typescript
    interface ApiModel {
    	id: string
    	name: string
    	documentProcessing?: {
    		supported: boolean
    		capabilities: {
    			textExtraction: boolean
    			tableDetection: boolean
    			layoutAnalysis: boolean
    			visualization: boolean
    		}
    	}
    }

    function hasDocumentProcessing(model: ApiModel): boolean {
    	return model.documentProcessing?.supported === true
    }

    // Default model (mistral-small-latest) supports document processing
    const defaultModel = "mistral-small-latest"
    ```

4. **Process Execution**

    ```typescript
    async function processDocument(document: DocumentContent, options: ProcessOptions): Promise<DocumentOutput> {
    	const config = await getOcrApiConfig()
    	if (!config) {
    		throw new Error("OCR API not configured")
    	}

    	// Process document and extract content using the configured model
    	const result = await processWithModel(document, config.model, config.temperature)

    	// Format and structure the content
    	return formatOutput(result, options)

    	// Note: The same model handles both document processing and text understanding
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

    - Command visibility check
    - Progress updates
    - Interactive options
    - Error handling

2. **File System**

    - File reading
    - Result saving
    - Visualization export

3. **API Integration**

    - Document processing configuration
    - Model capability validation
    - Error handling and recovery

    Example API integration:

    ```typescript
    interface ApiIntegration {
      // Check if model supports document processing
      async checkDocumentProcessingSupport(model: ApiModel): Promise<boolean>;

      // Process document and understand content using the same model
      async processAndAnalyzeDocument(
        content: Buffer,
        options: DocumentProcessingOptions
      ): Promise<DocumentResult>;

      // The same model handles both document processing and text understanding
      // No separate OCR model needed
    }

    interface DocumentProcessingOptions {
      temperature: number;  // Affects text understanding phase
      extractTables?: boolean;
      analyzeLayout?: boolean;
      generateVisuals?: boolean;
    }

    interface DocumentResult {
      text: string;
      markdown: string;
      structure?: DocumentStructure;
      visualizations?: DocumentVisualizations;
    }
    ```

4. **API Configuration UI**

    - Document processing capability indicator in model list
    - Single model configuration for all features
    - Example:

    ```typescript
    interface ModelSelectionUI extends ApiOptionsPanel {
    	// Extends existing API options panel

    	// Document processing indicator
    	documentProcessing?: {
    		supported: boolean
    		capabilities: {
    			textExtraction: boolean
    			tableDetection: boolean
    			layoutAnalysis: boolean
    			visualization: boolean
    		}
    	}

    	// Standard temperature control affects both phases
    	temperature: {
    		label: string
    		value: number
    		min: 0
    		max: 1
    		description: "Controls creativity in text understanding"
    	}
    }
    ```

### 6. Error Handling

```typescript
class DocumentProcessingError extends Error {
	constructor(
		message: string,
		public readonly code: ErrorCode,
		public readonly context: ErrorContext,
	) {
		super(message)
		this.name = "DocumentProcessingError"
	}
}

interface ErrorContext {
	model: string // The model being used (default: mistral-small-latest)
	phase: "document_processing" | "text_understanding" // Which phase failed
	documentType: string // Type of document being processed
	errorDetails?: any // Additional error information
}

enum ErrorCode {
	API_NOT_CONFIGURED = "API_NOT_CONFIGURED",
	DOCUMENT_PROCESSING_NOT_SUPPORTED = "DOCUMENT_PROCESSING_NOT_SUPPORTED",
	INVALID_DOCUMENT = "INVALID_DOCUMENT",
	PROCESSING_FAILED = "PROCESSING_FAILED",
	TEXT_UNDERSTANDING_FAILED = "TEXT_UNDERSTANDING_FAILED",
}
```
