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
/process mydocument.pdf --extractTables
/process scan.jpg --generateVisuals
/process report.pdf --analyzeLayout
/process document.pdf --extractTables --analyzeLayout --generateVisuals
```

Note: The output is always in markdown format for optimal rendering in VS Code.

Options available in chat:

- `--extractTables`: Enable table detection and extraction
- `--analyzeLayout`: Enable document layout analysis
- `--generateVisuals`: Generate visual representations of document structure
- `--save`: Save output as markdown file

### Via Command Palette

Alternatively, use the Command Palette (available when OCR API is configured):

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
2. Type "Roo Code: Process Document with OCR"
3. Select your document when prompted
4. Choose processing options from the Quick Pick menu:
    - Basic Text Extraction (text only)
    - Document Analysis with Tables (text and table extraction)
    - Full Document Analysis (layout analysis with visualizations)

### File Context Menu

Right-click on any supported file in the Explorer and select "Process Document with OCR" (visible when OCR API is configured).

## Supported File Types

- PDF documents (\*.pdf)
- Images (_.png, _.jpg, \*.jpeg)

## Processing Options

### 1. Basic Text Extraction

- Extracts text content from documents
- Preserves basic document structure
- Outputs formatted markdown
- Best for simple documents without complex layouts

### 2. Document Analysis with Tables

- Identifies and extracts tables from documents
- Maintains table structure and formatting
- Converts tables to markdown format
- Suitable for documents with data tables

### 3. Full Document Analysis

- Complete document layout analysis
- Visual representation of document structure
- Table detection and extraction
- Section and heading identification
- Includes all available processing features
- Best for complex documents requiring detailed analysis

Note: All processing uses Mistral's document understanding capabilities. Feature availability may depend on your API access level and model availability.

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

2. **Model Selection and Configuration**

    - Currently, OCR capabilities require specific Mistral API access
    - Contact Mistral support to verify OCR model availability for your account
    - Check your API configuration to ensure you have access to document processing features
    - Monitor the Mistral documentation for updates on OCR model availability
    - Test your configuration with a simple document before processing important files

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

### Model Availability Issues

If you encounter "Invalid model" errors:

1. Check if you have access to Mistral's OCR capabilities
2. Verify your API key has the correct permissions
3. Contact Mistral support to confirm OCR model availability
4. Check the extension's Output panel ("OCR Tasks") for detailed error information

### Processing Issues

If you encounter processing problems:

1. Check your document format (only PDF, JPEG, and PNG are supported)
2. Verify document quality and size
3. Review the OCR Tasks output channel for detailed error messages
4. Ensure your API configuration is correct

### Configuration Troubleshooting

If OCR features aren't working:

1. Open VS Code's Output panel and select "OCR Tasks"
2. Check for any configuration or API-related errors
3. Verify your Mistral API key is correctly configured
4. Try processing a small test document to validate your setup

## Keyboard Shortcuts

- `Ctrl+Shift+P` then type "Process Document" - Open OCR command
- Use VS Code's keyboard shortcuts settings to assign custom shortcuts

## Advanced Configuration

Required configuration in VS Code settings:

```json
{
	"roo-cline.ocr-api": {
		"configuration-name": "your-profile-name" // Name of API profile to use for OCR
	}
}
```

Important Notes:

1. Make sure the referenced API profile has a valid Mistral API key
2. The profile must have access to Mistral's document processing features
3. Use the "OCR Tasks" output channel to monitor processing status and errors
4. All document processing features are handled by Mistral's built-in capabilities
5. No additional configuration is needed beyond the API profile setup
