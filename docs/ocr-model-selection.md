# OCR Model Selection Architecture

This document describes how OCR functionality can be accessed through two distinct configuration approaches.

## VS Code Command Configuration

For VS Code commands (Command Palette and context menu), OCR features are enabled through the "roo-cline.ocr-api" configuration:

```json
{
	"roo-cline.ocr-api": {
		"configuration-name": "name-of-api-profile"
	}
}
```

This configuration references an existing API configuration profile name that will be used when executing OCR commands through VS Code's command system.

## Chat Interface Configuration

For the chat interface, OCR features are available based on the currently selected API configuration profile:

1. If the selected profile uses a model with OCR capability (`ocr: true`), OCR features become available automatically
2. No additional configuration is needed beyond selecting a profile with an OCR-capable model

Model types in the API configuration:

```typescript
interface ApiModel {
	id: string
	name: string
	ocr?: boolean // Indicates if model supports OCR
	// ... other model properties
}
```

## Model Selection Flow

### Model Configuration

The system uses a single text model (default: mistral-small-latest) for both document processing and text understanding:

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
	// ... other model properties
}
```

Key points:

- The text model handles both OCR and content processing
- Default model (mistral-small-latest) supports document processing
- Temperature setting applies to text understanding phase
- Model selection uses standard API Options UI
- No separate OCR model needed

## User Interface Integration

### API Options Panel

1. Model Selection

    - Shows provider's model list
    - Document processing capability indicated for supported models
    - Default model (mistral-small-latest) has document processing enabled

2. Model Configuration
    - Temperature control (0.0 - 1.0) affects text understanding
    - Standard model configuration options
    - No additional configuration needed for document processing

### Feature Visibility

Commands and UI elements are available when using a model with document processing support:

1. Chat Commands:

    - `/process` command
    - OCR-related options

2. Command Palette:

    - "Process Document with OCR" command
    - Related OCR commands

3. Context Menu:
    - OCR options in file context menu

### Configuration Flow

```
┌─────────────────┐
│   Check OCR     │
│     Config      │──┐
└─────────────────┘  │
                     ▼
┌─────────────────┐  NO    ┌─────────────────┐
│  OCR API Config ├──────► │  Hide OCR       │
│    Exists?      │        │  Features       │
└────────┬────────┘        └─────────────────┘
         │ YES
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Select Model   │ YES │  Configure Text  │
│  OCR = true?    ├────►│  Model Settings │
└────────┬────────┘     └─────────────────┘
         │ NO
         ▼
┌─────────────────┐
│    Standard     │
│  Configuration  │
└─────────────────┘
```

## Handler Implementation

The OCR handler uses both configured models:

1. OCR Model:

    - Handles document processing
    - Extracts raw text and structure
    - Identifies document elements

2. Text Model:
    - Processes extracted content
    - Performs semantic analysis
    - Generates formatted output
    - Uses configured temperature

Example handler flow:

```typescript
async function handleOcrRequest(document: Document) {
	const config = await getOcrApiConfig()
	if (!config) {
		throw new Error("OCR API not configured")
	}

	// Verify OCR capability
	if (!config.model.ocr) {
		throw new Error("Selected model does not support OCR")
	}

	// Process document with OCR model
	const rawExtraction = await processWithOcr(document, config.model)

	// Process text with configured text model
	const textModel = config.ocrTextModel
	const processedContent = await processWithTextModel(rawExtraction, textModel.id, textModel.temperature)

	return processedContent
}
```

## Best Practices

1. Model Selection:

    - Choose OCR-capable model for document processing
    - Select appropriate text model for content analysis
    - Adjust text model temperature based on needed creativity/accuracy

2. Configuration:

    - Store settings with OCR API provider config
    - Load and validate both models before processing
    - Handle model switching gracefully

3. Error Handling:
    - Verify OCR API configuration exists
    - Verify OCR capability before processing
    - Validate text model configuration
    - Provide clear error messages for configuration issues

## Future Considerations

1. Model Capabilities:

    - Additional model metadata for OCR features
    - Performance metrics and recommendations
    - Automatic model suggestion based on document type

2. UI Enhancements:
    - Preview of model capabilities
    - Quick selection of common configurations
    - Performance feedback
