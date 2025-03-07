# Using OCR Features in Roo Code

This guide explains how to use document processing and OCR features in Roo Code through both the chat interface and command palette.

## Prerequisites

For VS Code Commands:

- Roo Code extension installed and configured
- API configuration profile set up with an OCR-capable model
- "roo-cline.ocr-api" configured to reference your API profile

For Chat Interface:

- Roo Code extension installed and configured
- At least one API configuration profile using an OCR-capable model
- No additional configuration needed beyond profile selection

## Configuration Options

There are two ways to use OCR features in Roo Code:

### 1. VS Code Commands Configuration

To use OCR through VS Code commands (Command Palette and context menu):

1. Open VS Code Settings (File > Preferences > Settings)
2. Search for "Roo Code OCR API"
3. Configure which API profile to use:
    ```json
    {
    	"roo-cline.ocr-api": {
    		"configuration-name": "your-profile-name"
    	}
    }
    ```
    This references an existing API configuration profile that will be used for OCR commands.

### 2. Chat Interface Configuration

To use OCR through the chat interface:

1. Click the gear icon in the chat view to open Settings
2. Navigate to "API Options"
3. Select a configuration profile that uses an OCR-capable model
    - OCR features become automatically available when using a profile with an OCR-enabled model
    - No additional configuration needed beyond selecting the appropriate profile

When a profile using an OCR-capable model is selected, OCR features like the `/process` command will be automatically available in the chat interface.

## Using OCR Features

### Via Chat Interface

The chat interface provides a natural way to process documents. The `/process` command becomes available when a valid OCR API configuration exists ("roo-cline.ocr-api" is configured):

1. Open the Roo Code chat panel
2. Use the `/process` command:
    ```
    /process <file> [options]
    ```

Example commands:

```
/process mydocument.pdf --save
/process scan.jpg --visualize
/process report.pdf --format markdown
```

Options available in chat:

- `--save`: Save output as markdown
- `--format`: Choose output format (markdown/text)
- `--visualize`: Generate visualizations
- `--analyze`: Perform detailed analysis
- `--chunks`: Process large documents in chunks

### Via Command Palette

Alternatively, use the Command Palette (available when OCR API is configured):

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
2. Type "Roo Code: Process Document with OCR"
3. Select your document when prompted
4. Choose processing options from the Quick Pick menu:
    - Basic Text Extraction
    - Table Detection
    - Layout Analysis
    - Document Structure

### File Context Menu

Right-click on any supported file in the Explorer and select "Process Document with OCR" (visible when OCR API is configured).

## Supported File Types

- PDF documents (\*.pdf)
- Images (_.png, _.jpg, \*.jpeg)

## Processing Options

### 1. Basic Text Extraction

- Extracts text content while preserving structure
- Outputs clean, formatted markdown

### 2. Table Detection

- Identifies and extracts tables
- Converts tables to markdown format
- Preserves table structure and alignment

### 3. Layout Analysis

- Analyzes document layout
- Identifies headings, paragraphs, and sections
- Generates layout visualization
- Preserves document structure

### 4. Document Structure

- Full document analysis
- Identifies sections and their relationships
- Creates table of contents
- Includes metadata analysis

## Output Handling

Results can be handled in multiple ways:

1. **Chat Interface**

    - Results appear directly in the chat
    - Interactive options for saving/copying
    - Visualization previews
    - Quick actions for further processing

2. **Command Palette**
    - Results open in a new editor tab
    - Use VS Code's built-in Markdown preview
    - Save using standard VS Code functions

## Best Practices

1. **Configuration Management**

    - For VS Code commands: Create dedicated API profiles for OCR tasks
    - For chat interface: Organize profiles by use case (e.g., "OCR-General", "OCR-Code", etc.)
    - Keep OCR-capable profiles separate from general chat profiles

2. **Model Selection**

    - Choose models with appropriate OCR capabilities for your needs
    - Consider using specialized OCR models (e.g., mistral-ocr-latest) for better results
    - Check model capabilities before processing (text extraction, table detection, etc.)

3. **Document Preparation**

    - Use clear, high-quality scans
    - Ensure proper orientation
    - Use supported formats (PDF, PNG, JPEG)
    - Remove unnecessary elements that might confuse OCR

4. **Processing Tips**
    - Start with Basic Text Extraction for simple documents
    - Use Table Detection for data-heavy documents
    - Use Layout Analysis for complex layouts
    - Use Document Structure for comprehensive analysis
    - Test processing with sample documents before batch processing

## Common Issues and Solutions

### OCR Features Not Available

For VS Code Commands:

1. Check if "roo-cline.ocr-api" is configured with a valid profile name
2. Verify that the referenced API profile exists
3. Make sure the profile uses an OCR-capable model

For Chat Interface:

1. Check if your current API profile uses a model with OCR capability
2. Try selecting a different profile that has an OCR-enabled model
3. If needed, create a new profile with an OCR-capable model in the API Options UI

### Processing Issues

If you encounter processing problems:

1. Check both OCR and text model configurations
2. Verify document format and quality
3. Try adjusting the text model temperature

### Processing Large Documents

For large documents:

1. Use the `--chunks` option in chat interface
2. Be patient during processing
3. Watch the progress indicators
4. Check the Output panel for detailed progress

## Keyboard Shortcuts

- `Ctrl+Shift+P` then type "Process Document" - Open OCR command
- Use VS Code's keyboard shortcuts settings to assign custom shortcuts

## Advanced Configuration

Configuration options in VS Code settings:

```json
{
	// For VS Code commands:
	"roo-cline.ocr-api": {
		"configuration-name": "your-profile-name" // Name of API profile to use for OCR
	},
	// Additional OCR settings:
	"roo-cline.ocr": {
		"markdown": {
			"enabled": true,
			"includeMetadata": true
		},
		"visualization": {
			"enabled": true,
			"defaultType": "layout"
		},
		"processing": {
			"autoSave": false,
			"outputPath": "./processed"
		}
	}
}

// Note: For chat interface OCR features, simply select a profile

// that uses an OCR-capable model in the API Options UI
```
