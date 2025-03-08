# OCR Task Configuration Guide

This guide explains how to configure and use OCR tasks in VS Code.

## Task Configuration

OCR tasks can be configured in your workspace's `.vscode/tasks.json` file. Here's an example configuration:

```json
{
	"version": "2.0.0",
	"tasks": [
		{
			"type": "ocr",
			"label": "Process Documents",
			"source": "${workspaceFolder}/documents",
			"options": {
				"extractTables": true,
				"analyzeLayout": true,
				"generateVisuals": true
			}
		}
	]
}
```

### Configuration Options

- `type`: Must be "ocr" (required)
- `label`: Display name for the task (required)
- `source`: Path to documents or directory to process (required)
    - Supports workspace variables like `${workspaceFolder}`
    - Can be a single file path or directory
- `options`: Processing options
    - `extractTables`: Enable table detection and extraction (optional, default: false)
    - `analyzeLayout`: Enable document layout analysis (optional, default: false)
    - `generateVisuals`: Generate visual representations of document structure (optional, default: false)

Note: This implementation uses Mistral's document processing capabilities, which automatically handles:

- Text extraction and formatting
- Table detection (when enabled)
- Layout analysis (when enabled)
- Visual representation generation (when enabled)

## Using OCR Tasks

1. Open the Command Palette (Ctrl+Shift+P)
2. Type "Tasks: Run Task"
3. Select your OCR task from the list
4. View the results in the terminal and output panels

## Default Tasks

If no custom tasks are configured, the following default tasks are available:

1. Basic OCR

    - Simple text extraction
    - No table detection
    - No layout analysis

2. Layout Analysis OCR
    - Full document layout analysis
    - Table detection
    - Visual representations
    - Document structure analysis

## Examples

### Document Analysis with Tables

```json
{
	"type": "ocr",
	"label": "Process Invoice",
	"source": "${workspaceFolder}/invoices/latest.pdf",
	"options": {
		"extractTables": true,
		"analyzeLayout": false,
		"generateVisuals": false
	}
}
```

### Full Document Analysis

```json
{
	"type": "ocr",
	"label": "Process Documents",
	"source": "${workspaceFolder}/documents",
	"options": {
		"extractTables": true,
		"analyzeLayout": true,
		"generateVisuals": true
	}
}
```

### Basic Text Extraction

```json
{
	"type": "ocr",
	"label": "Extract Text",
	"source": "${workspaceFolder}/documents",
	"options": {
		"extractTables": false,
		"analyzeLayout": false,
		"generateVisuals": false
	}
}
```
