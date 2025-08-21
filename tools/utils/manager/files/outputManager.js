'use strict';

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.resolve(process.cwd(), 'scrapper/output');

/**
 * Ensures that the output directory and vendor subdirectory exist
 * @param {string} vendor - Vendor name
 * @returns {string} Path to vendor directory
 */
function ensureVendorDirectoryExists(vendor) {
    if (!vendor || typeof vendor !== 'string') {
        throw new Error('[OUTPUT-MANAGER] Vendor name is required');
    }
    
    // Sanitize vendor name for filesystem
    const sanitizedVendor = vendor.replace(/[^a-zA-Z0-9\-_]/g, '_').toLowerCase();
    
    const vendorDir = path.join(OUTPUT_DIR, sanitizedVendor);
    
    if (!fs.existsSync(vendorDir)) {
        fs.mkdirSync(vendorDir, { recursive: true });
        console.log(`[OUTPUT-MANAGER] Created vendor directory: ${vendorDir}`);
    }
    
    return vendorDir;
}

/**
 * Generates output filename based on input filename with .output suffix
 * @param {string} inputFileName - Original input file name
 * @returns {string} Generated output filename
 */
function generateOutputFileName(inputFileName) {
    if (!inputFileName) {
        throw new Error('[OUTPUT-MANAGER] Input filename is required');
    }
    
    const baseName = path.basename(inputFileName, path.extname(inputFileName));
    return `${baseName}.output.json`;
}

/**
 * Reads existing output file if it exists
 * @param {string} filePath - Path to output file
 * @returns {Object|null} Existing data or null if file doesn't exist
 */
function readExistingOutputFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        
        const rawData = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(rawData);
    } catch (err) {
        console.warn(`[OUTPUT-MANAGER] Failed to read existing output file ${filePath}:`, err.message);
        return null;
    }
}

/**
 * Creates the base output file structure
 * @param {string} vendor - Vendor name
 * @param {string} sourceFile - Source processing file name
 * @returns {Object} Base output structure
 */
function createBaseOutputStructure(vendor, sourceFile) {
    return {
        vendor: vendor,
        source_file: sourceFile,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        total_items: 0,
        items: []
    };
}
 
 

/**
 * Appends items to an output file (only successful items)
 * @param {string} outputFilePath - Path to output file
 * @param {Array} items - Items to append
 * @param {Object} metadata - Metadata about the source
 * @returns {Object} Updated file statistics
 */
function appendItemsToOutputFile(outputFilePath, successfulItems, metadata = {}) {
    if (!Array.isArray(successfulItems) || successfulItems.length === 0) {
        console.log('[OUTPUT-MANAGER] No items to append');
        return { appended: 0, total: 0 };
    }
    
    // Read existing file or create new structure   
    let outputData = readExistingOutputFile(outputFilePath);
    if (!outputData) {
        outputData = createBaseOutputStructure(
            metadata.vendor || 'unknown',
            metadata.sourceFile || 'unknown'
        );
    }
    
    // Append successful items
    if (!Array.isArray(outputData.items)) {
        outputData.items = [];
    }
    outputData.items.push(...successfulItems);
    
    // Update counters
    outputData.total_items = outputData.items.length;
    outputData.updated_at = new Date().toISOString();
    
    // Write main output file
    try {
        fs.writeFileSync(outputFilePath, JSON.stringify(outputData, null, 2), 'utf8');
        console.log(`[OUTPUT-MANAGER] Appended ${successfulItems.length} successful items to ${path.basename(outputFilePath)} (${outputData.total_items} total)`);
        
        return {
            appended: successfulItems.length,
            total: outputData.total_items
        };
    } catch (err) {
        console.error(`[OUTPUT-MANAGER] Failed to write output file:`, err.message);
        throw err;
    }
}

/**
 * Creates or returns existing output file for a vendor based on input filename
 * @param {string} vendor - Vendor name
 * @param {string} sourceFile - Source processing file name
 * @param {string} inputFileName - Original input file name
 * @returns {string} Path to output file (existing or newly created)
 */
function createOutputFile(vendor, sourceFile, inputFileName) {
    const vendorDir = ensureVendorDirectoryExists(vendor);
    const fileName = generateOutputFileName(inputFileName);
    const outputFilePath = path.join(vendorDir, fileName);
    
    // Check if output file already exists
    if (fs.existsSync(outputFilePath)) {
        console.log(`[OUTPUT-MANAGER] Using existing output file: ${fileName} in vendor directory: ${vendor}`);
        return outputFilePath;
    }
    
    // Create new output file
    const initialData = createBaseOutputStructure(vendor, sourceFile);
    
    try {
        fs.writeFileSync(outputFilePath, JSON.stringify(initialData, null, 2), 'utf8');
        console.log(`[OUTPUT-MANAGER] Created output file: ${fileName} in vendor directory: ${vendor}`);
        return outputFilePath;
    } catch (err) {
        console.error(`[OUTPUT-MANAGER] Failed to create output file:`, err.message);
        throw err;
    }
}

/**
 * Gets the most recent output file for a vendor
 * @param {string} vendor - Vendor name
 * @returns {string|null} Path to most recent output file or null if none found
 */
function getLatestOutputFile(vendor) {
    const vendorDir = ensureVendorDirectoryExists(vendor);
    
    try {
        const files = fs.readdirSync(vendorDir)
            .filter(file => file.endsWith('.json'))
            .map(file => ({
                name: file,
                path: path.join(vendorDir, file),
                stats: fs.statSync(path.join(vendorDir, file))
            }))
            .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());
        
        return files.length > 0 ? files[0].path : null;
    } catch (err) {
        console.warn(`[OUTPUT-MANAGER] Failed to get latest output file for vendor ${vendor}:`, err.message);
        return null;
    }
}

/**
 * Gets summary statistics for a vendor's output
 * @param {string} vendor - Vendor name
 * @returns {Object} Summary statistics
 */
function getVendorSummary(vendor) {
    const vendorDir = ensureVendorDirectoryExists(vendor);
    
    try {
        const files = fs.readdirSync(vendorDir)
            .filter(file => file.endsWith('.json'));
        
        let totalItems = 0;
        let totalFiles = 0;
        
        for (const file of files) {
            const filePath = path.join(vendorDir, file);
            const data = readExistingOutputFile(filePath);
            
            if (data) {
                totalItems += data.total_items || 0;
                totalFiles++;
            }
        }
        
        return {
            vendor,
            totalFiles,
            totalItems,
            directory: vendorDir
        };
    } catch (err) {
        console.warn(`[OUTPUT-MANAGER] Failed to get vendor summary for ${vendor}:`, err.message);
        return {
            vendor,
            totalFiles: 0,
            totalItems: 0,
            directory: vendorDir,
            error: err.message
        };
    }
}

module.exports = {
    ensureVendorDirectoryExists,
    createOutputFile,
    appendItemsToOutputFile,
    getLatestOutputFile,
    getVendorSummary,
    generateOutputFileName,
    OUTPUT_DIR
};
