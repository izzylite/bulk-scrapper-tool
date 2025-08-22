'use strict';

const fs = require('fs');
const path = require('path');
const { logError, logWarning } = require('../../logUtil');
const { assignVariants } = require('./variantManager');

const INPUT_DIR = path.resolve(process.cwd(), 'scrapper/input');
const PROCESSING_DIR = path.resolve(process.cwd(), 'scrapper/processing');

/**
 * Ensures that required directories exist
 */
function ensureDirectoriesExist() {
    const dirs = [INPUT_DIR, PROCESSING_DIR];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[INPUT-MANAGER] Created directory: ${dir}`);
        }
    });
}

/**
 * Gets all JSON files from the input directory
 * @returns {Array} Array of file paths
 */
function getInputFiles() {
    ensureDirectoriesExist();
    
    if (!fs.existsSync(INPUT_DIR)) {
        return [];
    }
    
    const files = fs.readdirSync(INPUT_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => path.join(INPUT_DIR, file));
    
    return files;
}

/**
 * Validates input file structure
 * Expected structure: {exclude:[], total_count:0, vendor:"", items: [{ url, sku_id, image_url }]}
 * @param {Object} data - Parsed JSON data
 * @returns {boolean} True if valid
 */
function validateInputStructure(data) {
    if (!data || typeof data !== 'object') return false;
    
    // Check required fields
    if (!Array.isArray(data.exclude)) return false;
    if (typeof data.total_count !== 'number') return false;
    if (typeof data.vendor !== 'string' || !data.vendor.trim()) return false;
    if (!Array.isArray(data.items)) return false;
    
    // Validate items structure
    for (const item of data.items) {
        if (!item || typeof item !== 'object') return false;
        if (!item.url || typeof item.url !== 'string') return false;
        // sku_id and image_url are optional but should be strings if present
        if (item.sku_id && typeof item.sku_id !== 'string') return false;
        if (item.image_url && typeof item.image_url !== 'string') return false;
    }
    
    return true;
}

/**
 * Reads and parses an input file
 * @param {string} filePath - Path to the input file
 * @returns {Object|null} Parsed data or null if invalid
 */
function readInputFile(filePath) {
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(rawData);
        
        if (!validateInputStructure(data)) {
            console.warn(`[INPUT-MANAGER] Invalid structure in file: ${filePath}`);
            logWarning('input_file_invalid_structure', { filePath });
            return null;
        }
        
        return data;
    } catch (err) {
        console.error(`[INPUT-MANAGER] Failed to read file ${filePath}:`, err.message);
        logError('input_file_read_failed', { filePath, error: err.message });
        return null;
    }
}

/**
 * Removes duplicate items based on URL
 * @param {Array} items - Array of items
 * @returns {Array} Deduplicated items
 */
function removeDuplicates(items) {
    const seen = new Set();
    const unique = [];
    
    for (const item of items) {
        if (item && item.url && !seen.has(item.url)) {
            seen.add(item.url);
            unique.push(item);
        }
    }
    
    return unique;
}

/**
 * Applies all exclusions to items by checking URL paths
 * @param {Array} items - Array of items to filter
 * @param {Set} allExclusions - Set of all exclusion patterns
 * @param {string} vendor - Vendor name for logging
 * @returns {Array} Filtered items with exclusions applied
 */
function applyAllExclusions(items, allExclusions, vendor) {
    if (!Array.isArray(items) || items.length === 0) {
        return items;
    }
    
    if (!allExclusions || allExclusions.size === 0) {
        console.log(`[INPUT-MANAGER] No exclusions to apply for vendor: ${vendor}`);
        return items;
    }
    
    const exclusionArray = Array.from(allExclusions);
    console.log(`[INPUT-MANAGER] Applying exclusions for ${vendor}: [${exclusionArray.map(e => `"${e}"`).join(', ')}]`);
    
    const beforeCount = items.length;
    const filteredItems = items.filter(item => {
        if (!item.url) return true;
        
        // Check if URL path contains any exclusion pattern
        for (const exclusion of exclusionArray) {
            if (item.url.toLowerCase().includes(`/${exclusion.toLowerCase()}/`)) {
                return false; // Exclude this URL
            }
        }
        return true; // Keep this URL
    });
    
    const filteredCount = beforeCount - filteredItems.length;
    if (filteredCount > 0) {
        console.log(`[INPUT-MANAGER] Filtered out ${filteredCount} URLs using exclusions (${filteredItems.length} remaining)`);
    }
    
    return filteredItems;
}



/**
 * Merges multiple input files into a single dataset
 * @param {Array} inputFiles - Array of file paths
 * @returns {Object|null} Merged data or null if no valid files
 */
function mergeInputFiles(inputFiles) {
    if (!inputFiles || inputFiles.length === 0) {
        return null;
    }
    
    let mergedData = {
        total_count: 0,
        exclude: [],
        vendor: '',
        items: []
    };
    
    let validFileCount = 0;
    const allExclusions = new Set();
    
    for (const filePath of inputFiles) {
        const data = readInputFile(filePath);
        if (!data) continue;
        
        validFileCount++;
        
        // Set vendor from first valid file to ensure consistency
        if (!mergedData.vendor) {
            mergedData.vendor = data.vendor;
        } else if (mergedData.vendor !== data.vendor) {
            console.warn(`[INPUT-MANAGER] Vendor mismatch detected: ${mergedData.vendor} vs ${data.vendor}. Using first vendor.`);
            logWarning('input_vendor_mismatch', { firstVendor: mergedData.vendor, currentVendor: data.vendor });
            return null;
        }
        
        // Merge exclusions
        if (Array.isArray(data.exclude)) {
            data.exclude.forEach(exclusion => allExclusions.add(exclusion));
        }
        
        // Merge items
        if (Array.isArray(data.items)) {
            mergedData.items.push(...data.items);
        }
        
        console.log(`[INPUT-MANAGER] Processed file: ${path.basename(filePath)} (${data.items?.length || 0} items)`);
    }
    
    if (validFileCount === 0) {
        console.error('[INPUT-MANAGER] No valid input files found');
        logError('input_no_valid_files', { validFileCount });
        return null;
    }
    
    // Remove duplicates and apply exclusions
    mergedData.items = removeDuplicates(mergedData.items);
    mergedData.items = applyAllExclusions(mergedData.items, allExclusions, mergedData.vendor);
    // Assign variants and get deduplicated main items 
    mergedData.items = assignVariants(mergedData.items, mergedData.vendor);
    mergedData.total_count = mergedData.items.length;
    mergedData.exclude = Array.from(allExclusions);
    
    console.log(`[INPUT-MANAGER] Merged ${validFileCount} files: ${mergedData.items.length} unique products, vendor: ${mergedData.vendor}`);
    
    return mergedData;
}

/**
 * Converts merged input data to processing format
 * Processing format: {active:true/false, vendor:"", total_count:0, processed_count:0, source_files:[], items:[{url, vendor, image_url, sku}]}
 * @param {Object} inputData - Merged input data
 * @param {Array} originalInputFiles - Array of original input filenames
 * @returns {Object} Processing format data
 */
function convertToProcessingFormat(inputData, originalInputFiles = []) {
    if (!inputData) return null;
    
    const processingItems = inputData.items.map(item => ({
        url: item.url,
        vendor: inputData.vendor,
        image_url: item.image_url || null,
        sku: item.sku_id || null,
        variants: Array.isArray(item.variants) ? item.variants : []
    }));
    
    return {
        active: true,
        vendor: inputData.vendor,
        total_count: inputData.total_count,
        processed_count: 0,
        exclude: inputData.exclude || [],
        source_files: originalInputFiles,
        items: processingItems
    };
}

/**
 * Saves processing data to the processing directory
 * @param {Object} processingData - Data in processing format
 * @returns {string} Path to the created processing file
 */
function saveToProcessingDirectory(processingData) {
    ensureDirectoriesExist();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${processingData.vendor}_${timestamp}.json`;
    const filePath = path.join(PROCESSING_DIR, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(processingData, null, 2), 'utf8');
        console.log(`[INPUT-MANAGER] Created processing file: ${fileName}`);
        return filePath;
    } catch (err) {
        console.error(`[INPUT-MANAGER] Failed to save processing file:`, err.message);
        logError('input_processing_file_save_failed', { filePath, error: err.message });
        throw err;
    }
}

/**
 * Moves processed input files to a backup location
 * @param {Array} inputFiles - Array of file paths to move
 */
function archiveInputFiles(inputFiles) {
    const backupDir = path.join(INPUT_DIR, 'archived');
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().slice(0, 10);
    
    for (const filePath of inputFiles) {
        try {
            const fileName = path.basename(filePath);
            const backupFileName = `${timestamp}_${fileName}`;
            const backupPath = path.join(backupDir, backupFileName);
            
            fs.renameSync(filePath, backupPath);
            console.log(`[INPUT-MANAGER] Archived: ${fileName} -> archived/${backupFileName}`);
        } catch (err) {
            console.warn(`[INPUT-MANAGER] Failed to archive ${filePath}:`, err.message);
            logWarning('input_file_archive_failed', { filePath, error: err.message });
        }
    }
}

/**
 * Main function to process input directory
 * @returns {string|null} Path to created processing file or null if no work to do
 */
function processInputDirectory() {
    const inputFiles = getInputFiles();
    
    if (inputFiles.length === 0) {
        throw new Error('[INPUT-MANAGER] No input files found in scrapper/input directory');
    }
    
    console.log(`[INPUT-MANAGER] Found ${inputFiles.length} input file(s)`);
    
    // Merge all input files
    const mergedData = mergeInputFiles(inputFiles);
    if (!mergedData) {
        throw new Error('[INPUT-MANAGER] Failed to merge input files - no valid data found or vendor mismatch');
    }
    
    // Convert to processing format
    const originalInputFiles = inputFiles.map(file => path.basename(file));
    const processingData = convertToProcessingFormat(mergedData, originalInputFiles);
    if (!processingData) {
        throw new Error('[INPUT-MANAGER] Failed to convert to processing format');
    }
    
    // Save to processing directory
    const processingFilePath = saveToProcessingDirectory(processingData);
    
    // Archive input files
    archiveInputFiles(inputFiles);
    
    return processingFilePath;
}

module.exports = {
    processInputDirectory,
    getInputFiles,
    ensureDirectoriesExist,
    INPUT_DIR,
    PROCESSING_DIR
};
