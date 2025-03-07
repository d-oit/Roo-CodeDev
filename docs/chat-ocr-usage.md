# Using OCR Features in Roo Code Chat

This guide explains how to use document processing and OCR features through the Roo Code chat interface.

## Prerequisites

- Roo Code extension installed and configured
- Valid Mistral API key configured
- Access to the `mistral-ocr-latest` model

## Basic Commands

### Processing a Document

```
/process mydocument.pdf --save
```

This will:

1. Process the document using OCR
2. Convert content to markdown
3. Save the result as a markdown file

### Options

- `--save`: Save the output as a markdown file
- `--path`: Specify custom save path
- `--format`: Choose output format (markdown/text)
- `--visualize`: Generate visual representations
- `--viz-type`: Type of visualization (layout/sections/tables)
- `--viz-style`: Visualization style (default/dark/light)

## Example Usage

### Basic Document Processing

```
User: /process scan.jpg
Assistant: Processing scan.jpg...
Extracted content:
# Document Title

This is the extracted content from your scanned document...
```

### Save to Markdown File

```
User: /process report.pdf --save --path ./docs/processed
Assistant: Processing report.pdf...
Generated markdown saved to: ./docs/processed/report.md
```

### Generate Visualizations

```
User: /process diagram.png --visualize --viz-type layout
Assistant: Processing diagram.png...
Generated layout visualization:
[Layout visualization displayed]

Would you like me to save the visualization as an image file?
```

### Extract Tables

```
User: /process spreadsheet.pdf --format markdown
Assistant: Processing spreadsheet.pdf...
Extracted tables:

| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |
```

## Advanced Features

### Model Selection

If needed, you can switch to the OCR-capable model:

```
User: /model mistral-ocr-latest
Assistant: Switched to mistral-ocr-latest model.
```

### Batch Processing

Process multiple documents in sequence:

```
User: /process doc1.pdf doc2.pdf doc3.pdf --save
Assistant: Processing multiple documents...
1. doc1.pdf → doc1.md
2. doc2.pdf → doc2.md
3. doc3.pdf → doc3.md
All documents processed successfully.
```

### Document Analysis

Get detailed analysis of a document:

```
User: /process document.pdf --analyze
Assistant: Document Analysis:
- Structure: 5 sections detected
- Tables: 2 tables found
- Images: 3 images detected
- Layout: 2-column format

Would you like me to extract any specific component?
```

## Tips and Tricks

1. **Better Results with Images**

    ```
    User: /process scan.jpg --preprocess enhance
    ```

    This applies image enhancement before OCR.

2. **Custom Output Location**

    ```
    User: /process document.pdf --save --path ./project/docs/processed/
    ```

    Specify where to save the processed files.

3. **Multiple Visualizations**
    ```
    User: /process doc.pdf --visualize --viz-type layout,sections
    ```
    Generate multiple types of visualizations.

## Common Issues and Solutions

### Model Not Available

```
User: /process document.pdf
Assistant: Error: Current model doesn't support OCR.
Would you like to switch to mistral-ocr-latest? [Y/n]
```

Solution: Type 'Y' to switch to the OCR-capable model.

### Unsupported File Type

```
User: /process document.txt
Assistant: Error: Unsupported document type: text/plain
Please provide a PDF or image file.
```

Solution: Convert the document to a supported format first.

### Processing Large Documents

```
User: /process large.pdf --chunks
Assistant: Processing large document in chunks...
Progress: [===>    ] 35%
```

Use the `--chunks` option for large documents.

## Best Practices

1. **File Preparation**

    - Ensure good image quality for scans
    - Use appropriate file formats
    - Optimize file size when possible

2. **Command Usage**

    - Start with basic processing
    - Add options as needed
    - Use `--save` for important documents

3. **Model Selection**
    - Use `mistral-ocr-latest` for best results
    - Check model availability before processing
    - Switch models when needed

## Interactive Features

The chat interface provides interactive features:

1. **Document Preview**

    ```
    Assistant: Document processed. Would you like to:
    1. Preview in markdown
    2. Save to file
    3. Copy to clipboard
    4. Generate visualizations
    ```

2. **Visualization Options**

    ```
    Assistant: Layout analysis complete. Display options:
    1. Show layout structure
    2. Show section boundaries
    3. Show table locations
    4. Save all visualizations
    ```

3. **Error Recovery**
    ```
    Assistant: Processing failed. Would you like to:
    1. Retry with different settings
    2. Try another model
    3. See error details
    4. Get troubleshooting help
    ```

## Advanced Configuration

You can customize OCR behavior in settings:

```json
{
	"roo-cline.ocr": {
		"defaultModel": "mistral-ocr-latest",
		"autoSave": true,
		"outputPath": "./docs/processed",
		"defaultVisualization": "layout",
		"enhancement": {
			"enabled": true,
			"quality": "high"
		}
	}
}
```

## Keyboard Shortcuts

- `Ctrl+Shift+P` then type `Roo Code: Process Document` - Open file picker for OCR
- `Ctrl+Alt+P` - Process currently open document
- `Ctrl+Alt+V` - Generate visualizations for last processed document
