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
	model: string // Selected model must have ocr: true
	temperature: number
	ocrTextModel?: {
		id: string
		temperature: number
	}
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
    	ocr?: boolean
    }

    function isOcrCapable(model: ApiModel): boolean {
    	return model.ocr === true
    }
    ```

4. **Process Execution**

    ```typescript
    async function processDocument(document: DocumentContent, options: ProcessOptions): Promise<DocumentOutput> {
    	const config = await getOcrApiConfig()
    	if (!config) {
    		throw new Error("OCR API not configured")
    	}

    	// Process with OCR model
    	const rawContent = await processWithOcr(document, config.model)

    	// Process with text model
    	const result = await processWithTextModel(rawContent, config.ocrTextModel)

    	return formatOutput(result, options)
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

    - OCR API configuration
    - Model capability checking
    - Error recovery

    Example API integration:

    ```typescript
    interface ApiIntegration {
      async checkOcrSupport(model: ApiModel): Promise<boolean>;
      async processDocument(content: Buffer): Promise<string>;
      async analyzeText(
        text: string,
        options: TextAnalysisOptions
      ): Promise<AnalysisResult>;
    }
    ```

4. **API Configuration UI**
    - OCR capability indicators in model list
    - Text model selection when OCR model active
    - Example:
    ```typescript
    interface ModelSelectionUI extends ApiOptionsPanel {
    	// Extends existing API options panel

    	// Additional UI elements for text model when OCR model selected
    	ocrTextModelSection?: {
    		visible: boolean
    		modelSelect: {
    			label: string
    			value: string
    			options: ApiModel[]
    		}
    		temperature: {
    			label: string
    			value: number
    			min: 0
    			max: 1
    		}
    	}
    }
    ```

### 6. Error Handling

```typescript
class OcrError extends Error {
	constructor(
		message: string,
		public readonly code: OcrErrorCode,
		public readonly details?: any,
	) {
		super(message)
	}
}

enum OcrErrorCode {
	API_NOT_CONFIGURED = "OCR_API_NOT_CONFIGURED",
	MODEL_NOT_OCR_CAPABLE = "MODEL_NOT_OCR_CAPABLE",
	INVALID_DOCUMENT = "INVALID_DOCUMENT",
	PROCESSING_FAILED = "PROCESSING_FAILED",
}
```
