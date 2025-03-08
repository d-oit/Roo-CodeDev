# Document Processing with Mistral AI

This guide explains how to use the document processing capabilities in Roo Code, which combines OCR and text model understanding to extract and format content from documents and images.

## Requirements

- The document processing feature requires two models:
    - `mistral-ocr-latest` for OCR processing
    - A text model (e.g., `mistral-small-latest`) for content understanding
- Supported document types:
    - Documents: PDF files
    - Images: PNG, JPEG, and other common formats
- Valid Mistral API key with access to both OCR and chat features

## Processing Flow

1. **OCR Processing**: First, the document is processed using the OCR model to extract text and structure
2. **Text Understanding**: Then, the extracted content is analyzed by a text model to:
    - Format content as markdown
    - Preserve document structure
    - Handle tables and layout

## Basic Usage

### Handler Initialization

```typescript
// Initialize handler with OCR and text models
const handler = new MistralHandler({
	mistralApiKey: "your-api-key",
	// OCR model for document processing
	apiModelId: "mistral-ocr-latest",
	// Optional text model settings
	modelTemperature: 0, // Lower temperature for more precise formatting
})
```

### Processing a PDF Document

```typescript
// Process a PDF document
const result = await handler.processDocument({
	type: "base64", // or "url" for remote documents
	data: base64EncodedPdf,
	mimeType: "application/pdf",
	fileName: "document.pdf", // Optional but recommended
})

// Access the processed content
console.log(result.markdown) // Formatted markdown content
console.log(result.structure?.sections) // Document structure
```

### Processing an Image

```typescript
// Process an image from URL
const result = await handler.processDocument({
	type: "url",
	data: "https://example.com/image.jpg",
	mimeType: "image/jpeg",
})

// Or process a local image
const result = await handler.processDocument({
	type: "base64",
	data: base64EncodedImage,
	mimeType: "image/png",
	fileName: "screenshot.png",
})
```

## Advanced Features

### Two-Step Processing

The document processing combines OCR and text model capabilities:

```typescript
// 1. OCR extracts raw text and structure
// 2. Text model formats and enhances the content
const result = await handler.processDocument(document, {
	extractTables: true, // Enable table detection
	analyzeLayout: true, // Preserve document layout
	generateVisuals: true, // Include visual analysis
})

// Access the processed content
console.log(result.markdown) // Formatted content with tables
console.log(result.structure) // Document structure with sections
```

### Document Structure Analysis

The processing pipeline handles document structure in two phases:

1. OCR identifies document elements and layout
2. Text model enhances and formats the structure

```typescript
const result = await handler.processDocument(document)

// Access structured content
for (const section of result.structure?.sections ?? []) {
	// Sections are organized with proper hierarchy
	console.log(`Section: ${section.heading || "Untitled"}`)
	console.log(`Content: ${section.content.trim()}`)
}
```

### Visual Analysis

Generate visual representations of the document's structure:

```typescript
const result = await handler.processDocument(document, {
	generateVisuals: true,
	analyzeLayout: true,
})

if (result.visualizations) {
	// Base64-encoded visualization images
	const layout = result.visualizations.layout // Document layout analysis
	const sections = result.visualizations.sections // Section relationships
	const tables = result.visualizations.tables // Table structure views
}
```

### Enhanced Table Processing

Tables are processed in two steps for better accuracy:

```typescript
const result = await handler.processDocument(document, {
	extractTables: true,
})

// The markdown output includes properly formatted tables:
// - Tables are detected by OCR
// - Structure is preserved by the text model
// - Formatting follows markdown conventions
```

## Configuration Options

```typescript
interface ProcessingOptions {
	// OCR Options
	extractTables?: boolean // Enable table detection and extraction
	analyzeLayout?: boolean // Enable document layout analysis
	generateVisuals?: boolean // Generate visual representations
}

// Handler initialization options affecting text processing
interface HandlerOptions {
	apiModelId: string // OCR model selection
	modelTemperature?: number // Text model temperature (0-1)
}
```

## Error Handling

```typescript
try {
	const result = await handler.processDocument(document)
} catch (error) {
	if (error instanceof DocumentProcessingError) {
		if (error.message.includes("OCR")) {
			// Handle OCR-specific failures
			console.error("OCR processing failed:", error.message)
		} else {
			// Handle text processing errors
			console.error("Text processing failed:", error.message)
		}
	} else if (error instanceof UnsupportedDocumentTypeError) {
		// Handle unsupported formats
		console.error("Unsupported document type:", error.message)
	}
}
```

### Common Error Scenarios

1. OCR Processing:

    - Invalid document format
    - File size limits
    - Poor image quality
    - Unsupported languages

2. Text Processing:
    - Content formatting issues
    - Structure preservation failures
    - Table formatting errors
    - Context length exceeded

## Common Use Cases

### Converting Scanned Documents to Markdown

```typescript
// Process a scanned document
const result = await handler.processDocument({
	type: "base64",
	data: scannedDocumentBase64,
	mimeType: "image/png",
})

// Save as markdown file
await vscode.workspace.fs.writeFile(vscode.Uri.file("scanned-document.md"), Buffer.from(result.markdown))
```

### Analyzing Document Layout

```typescript
const result = await handler.processDocument(document, {
	analyzeLayout: true,
	generateVisuals: true,
})

if (result.visualizations?.layout) {
	// Save layout visualization
	await vscode.workspace.fs.writeFile(
		vscode.Uri.file("document-layout.png"),
		Buffer.from(result.visualizations.layout, "base64"),
	)
}
```

### Converting Tables from Images

```typescript
const result = await handler.processDocument(document, {
	extractTables: true,
})

// The markdown output will include properly formatted tables
console.log(result.markdown)
```

## Best Practices

1. **Model Configuration**

    ```typescript
    // Initialize with both OCR and text processing capabilities
    const handler = new MistralHandler({
    	mistralApiKey: "your-api-key",
    	apiModelId: "mistral-ocr-latest",
    	modelTemperature: 0, // Low temperature for accurate formatting
    })

    // Always verify OCR support
    const model = handler.getModel()
    if (!model.info.documentProcessing?.supported) {
    	throw new Error("Model does not support document processing")
    }
    ```

2. **Document Preparation**

    - Ensure correct MIME type specification
    - Optimize image quality for OCR
    - Split large documents into manageable parts
    - Clean and preprocess scanned content

3. **Process Optimization**

    - Cache OCR results when possible
    - Process documents concurrently when appropriate
    - Monitor memory usage for both processing steps
    - Set appropriate timeouts for each phase

4. **Error Management**
    - Handle OCR and text processing errors separately
    - Implement retries with exponential backoff
    - Cache intermediate OCR results
    - Have text formatting fallback options

## Limitations

1. **OCR Limitations**

    - File size constraints based on API plan
    - OCR accuracy depends on image quality
    - Complex layouts may be simplified
    - Font recognition limitations

2. **Text Processing Limitations**

    - Token limits for large documents
    - Some formatting may be simplified
    - Complex tables might be restructured
    - Special characters handling limitations

3. **System Considerations**
    - Two-phase processing increases latency
    - Higher API usage (OCR + text model)
    - Increased memory requirements
    - Storage needed for intermediate results

## Performance Tips

1. **Document Preparation**

    - Optimize image resolution for OCR accuracy (300-600 DPI)
    - Use lossless compression for documents
    - Convert multi-page documents to optimized formats
    - Clean scanned documents for better OCR results
    - Ensure consistent font rendering

2. **Processing Optimization**

    - Cache OCR results for repeat processing
    - Process multiple documents in parallel
    - Split large documents into manageable chunks
    - Use streaming for large file handling
    - Monitor API rate limits for both services

3. **Memory Management**

    - Clean up intermediate OCR results
    - Monitor memory for both processing steps
    - Implement timeouts for each phase
    - Use efficient storage for large documents
    - Release resources promptly after processing

4. **System Optimization**
    - Use connection pooling for API requests
    - Implement request retries with backoff
    - Cache processed results when appropriate
    - Monitor system resource usage
    - Balance concurrent processing load
