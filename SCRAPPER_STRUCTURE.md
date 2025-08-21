# AI Scrapper - Refactored Directory Structure

## Overview

The AI Scrapper has been refactored to use a simplified directory structure that automatically manages the workflow from input to processing to output.

## Directory Structure

```
scrapper/
├── input/          # Input JSON files
├── processing/     # Active processing files
└── output/         # Output organized by vendor
    └── {vendor}/   # Vendor-specific output files
```

## Input Directory (`scrapper/input/`)

Place your JSON files here with the following structure:

```json
{
  "exclude": ["fashion", "health"],
  "total_count": 100,
  "vendor": "vendor-name",
  "items": [
    {
      "url": "https://example.com/product/1",
      "sku_id": "SKU-001",
      "image_url": "https://example.com/image1.jpg"
    }
  ]
}
```

### Key Points:
- Multiple files will be automatically merged
- Duplicates are removed based on URL
- **Exclusions** filter URLs containing specified category paths (e.g., `"skin"` excludes URLs like `/skin/face-care/`)
- Files are archived to `input/processed/` after processing

## Processing Directory (`scrapper/processing/`)

Active processing files are stored here with the following structure:

```json
{
  "active": true,
  "vendor": "vendor-name",
  "total_count": 100,
  "processed_count": 25,
  "exclude": ["pattern1", "pattern2"],
  "items": [
    {
      "url": "https://example.com/product/1",
      "vendor": "vendor-name",
      "image_url": "https://example.com/image1.jpg",
      "sku": "SKU-001"
    }
  ]
}
```

### Key Points:
- Only one file can be active (`active: true`) at a time
- Completed files are deactivated (`active: false`)
- Progress is tracked with `processed_count`

## Output Directory (`scrapper/output/`)

Output files are organized by vendor in subdirectories and **only contain successful extractions**. Files are named based on the original input filename with `.output` suffix:

```
output/
├── vendor1/
│   ├── products.output.json      # From input: products.json
│   └── inventory.output.json     # From input: inventory.json
└── vendor2/
    └── catalog.output.json       # From input: catalog.json
```

### Key Points:
- **Output filename** = `{input-filename}.output.json`
- **Only successful items** are saved to output files
- **Failed items** are tracked in processing files by `pendingManager.js`
- **If output file exists**, it will be reused (appended to)
- No separate `_failed.json` files are created

## Usage

### Basic Usage

Simply run the script - it will automatically handle the workflow:

```bash
node tools/stagehand_product_extractor.js
```

### Command Line Options

- `--batch=N` or `-b N`: Batch size (default: 20)
- `--batches=N` or `-c N`: Concurrent batches (default: 1)
- `--limit=N` or `-l N`: Total limit of items to process (default: unlimited)

### Examples

```bash
# Process with larger batches
node tools/stagehand_product_extractor.js --batch=50

# Use multiple concurrent sessions
node tools/stagehand_product_extractor.js --batches=3

# Limit total items processed
node tools/stagehand_product_extractor.js --limit=100
```

### File Naming Examples

- Input: `products.json` → Output: `products.output.json`
- Input: `inventory-2025.json` → Output: `inventory-2025.output.json`
- Input: `catalog_spring.json` → Output: `catalog_spring.output.json`

## Workflow

1. **Check Processing Directory**: Looks for active processing files
2. **Check Input Directory**: If no active processing files, processes input directory
3. **Merge & Process**: Merges input files, removes duplicates, creates processing file
4. **Extract Products**: Processes items using Stagehand browser automation
5. **Organize Output**: Saves results to vendor-specific output directories
6. **Cleanup**: Deactivates completed processing files

## Error Handling

- **Failed extractions** are tracked in processing files by `pendingManager.js` (not in output files)
- Processing files track retry counts and error timestamps for failed items
- **Successful extractions** are removed from processing files and saved to output files
- Incomplete processing files can be resumed by running the script again

## Processing File Format

The system uses a standardized processing file format with the `items` field and `active` flag. Processing files must follow this structure:

```json
{
  "active": true,
  "vendor": "vendor-name",
  "total_count": 100,
  "processed_count": 25,
  "exclude": ["fashion", "health"],
  "source_files": ["input.json"],
  "items": [
    {
      "url": "https://example.com/product/1",
      "vendor": "vendor-name",
      "image_url": "https://example.com/image1.jpg",
      "sku": "SKU-001"
    }
  ]
}
```
