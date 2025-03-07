# Document Processing with Mistral OCR

This guide explains how to use the document processing capabilities in Roo Code to analyze and extract content from documents and images.

## Requirements

- The document processing feature requires the `mistral-ocr-latest` model
- Supported document types: PDF, PNG, JPEG, and other common image formats
- Valid Mistral API key with access to OCR features

## Basic Usage

### Processing a PDF Document

```typescript
// Initialize handler with OCR-capable model
const handler = new MistralHandler({
	mistralApiKey: "your-api-key",
	apiModelId: "mistral-ocr-latest",
})

// Process a PDF document
const result = await handler.processDocument({
	type: "base64",
	data: base64EncodedPdf,
	mimeType: "application/pdf",
	fileName: "document.pdf",
})

// Access the markdown content
console.log(result.markdown)

// Access document structure
console.log(result.structure?.sections)
```

### Processing an Image from URL

```typescript
const result = await handler.processDocument({
	type: "url",
	data: "https://example.com/image.jpg",
	mimeType: "image/jpeg",
})
```

## Advanced Features

### Document Structure Analysis

The OCR processor automatically extracts document structure including headings and sections:

```typescript
const result = await handler.processDocument(document)

// Access document sections
for (const section of result.structure?.sections ?? []) {
	console.log(`Heading: ${section.heading}`)
	console.log(`Content: ${section.content}`)
}
```

### Visual Analysis

Enable visual analysis to get layout and section visualizations:

```typescript
const result = await handler.processDocument(document, {
	generateVisuals: true,
	analyzeLayout: true,
})

if (result.visualizations) {
	// Base64-encoded visualization images
	const layoutImage = result.visualizations.layout
	const sectionsImage = result.visualizations.sections
}
```

### Table Detection

Enable table detection to preserve table structures in the markdown output:

```typescript
const result = await handler.processDocument(document, {
	extractTables: true,
})
```

## Configuration Options

```typescript
interface ProcessingOptions {
	extractTables?: boolean // Extract and preserve table structures
	analyzeLayout?: boolean // Analyze document layout
	generateVisuals?: boolean // Generate visual representations
}
```

## Error Handling

```typescript
try {
	const result = await handler.processDocument(document)
} catch (error) {
	if (error instanceof DocumentProcessingError) {
		// Handle processing errors
		console.error("Processing failed:", error.message)
	} else if (error instanceof UnsupportedDocumentTypeError) {
		// Handle unsupported file types
		console.error("Unsupported document type:", error.message)
	}
}
```

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

1. **Check Model Support**

    ```typescript
    const model = handler.getModel()
    if (!model.info.documentProcessing?.supported) {
    	console.error("Current model doesn't support document processing")
    }
    ```

2. **Handle Large Documents**

    - For large documents, consider processing them in sections
    - Monitor memory usage when processing large files

3. **File Type Handling**

    - Always specify the correct MIME type
    - Verify file size before processing
    - Use appropriate file format for your use case (e.g., PNG for screenshots)

4. **Error Recovery**
    - Implement retry logic for temporary failures
    - Cache results when appropriate
    - Have fallback strategies for unsupported features

## Limitations

- Maximum file size depends on your Mistral API plan
- Some complex layouts might not be perfectly preserved
- Table detection works best with clear, well-formatted tables
- Visualization quality depends on the input document quality

## Performance Tips

1. **Optimize Input Files**

    - Compress images appropriately
    - Use appropriate resolution for your needs
    - Convert multi-page documents to single files when possible

2. **Batch Processing**

    - Process multiple documents in parallel when possible
    - Cache results for frequently accessed documents

3. **Resource Management**
    - Clean up temporary files
    - Monitor memory usage
    - Implement timeouts for large documents
