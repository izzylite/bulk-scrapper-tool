'use strict';

const fs = require('fs');
const path = require('path');
const { logError, logWarning } = require('../../logUtil');

const OUTPUT_DIR = path.resolve(process.cwd(), 'scrapper/output');

// Per-file write lock to safely append/update JSON from concurrent workers
const __fileLocks = new Map();
function withFileLock(filePath, fn) {
    const prev = __fileLocks.get(filePath) || Promise.resolve();
    const next = prev.then(fn, fn);
    __fileLocks.set(filePath, next.catch(() => {}));
    return next;
}

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
 * @param {number} index - Optional index for file rotation (default: no index)
 * @returns {string} Generated output filename
 */
function generateOutputFileName(inputFileName, index = null) {
    if (!inputFileName) {
        throw new Error('[OUTPUT-MANAGER] Input filename is required');
    }
    
    const baseName = path.basename(inputFileName, path.extname(inputFileName));
    
    if (index !== null && index >= 0) {
        return `${baseName}.output_${index}.json`;
    }
    
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
        logWarning('output_file_read_failed', { filePath, error: err.message });
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
        filtered_invalid_count: 0,
        items: []
    };
}

/**
 * Finds the current output file with highest index for a given input filename
 * @param {string} vendorDir - Vendor directory path
 * @param {string} inputFileName - Original input file name
 * @returns {Object|null} Object with filePath, index, and itemCount or null if no files found
 */
function findCurrentOutputFile(vendorDir, inputFileName) {
    try {
        const baseName = path.basename(inputFileName, path.extname(inputFileName));
        const files = fs.readdirSync(vendorDir);
        
        // Look for files matching the pattern: baseName.output.json or baseName.output_N.json
        const outputFiles = files
            .filter(file => {
                return file === `${baseName}.output.json` || 
                       /^.*\.output_\d+\.json$/.test(file) && file.startsWith(baseName);
            })
            .map(file => {
                const filePath = path.join(vendorDir, file);
                let index = null;
                
                // Extract index from filename
                const indexMatch = file.match(/\.output_(\d+)\.json$/);
                if (indexMatch) {
                    index = parseInt(indexMatch[1], 10);
                } else if (file.endsWith('.output.json')) {
                    index = 0; // Base file has implicit index 0
                }
                
                // Get item count from file
                let itemCount = 0;
                try {
                    if (fs.existsSync(filePath)) {
                        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        itemCount = data.total_items || 0;
                    }
                } catch {
                    // If file is corrupted or unreadable, treat as empty
                    itemCount = 0;
                }
                
                return { filePath, index, itemCount, fileName: file };
            })
            .sort((a, b) => b.index - a.index); // Sort by index descending
        
        return outputFiles.length > 0 ? outputFiles[0] : null;
    } catch (err) {
        console.warn(`[OUTPUT-MANAGER] Failed to find current output file:`, err.message);
        logWarning('output_file_find_failed', { error: err.message });
        return null;
    }
}

/**
 * Gets the next available index for a new output file
 * @param {string} vendorDir - Vendor directory path
 * @param {string} inputFileName - Original input file name
 * @returns {number} Next available index
 */
function getNextOutputFileIndex(vendorDir, inputFileName) {
    const currentFile = findCurrentOutputFile(vendorDir, inputFileName);
    return currentFile ? currentFile.index + 1 : 0;
}
 
 

/**
 * Validates if an item should be kept (not filtered out)
 * Filters out items that have empty price AND "In stock" status
 * @param {Object} item - Item to validate
 * @returns {boolean} True if item should be kept, false if it should be filtered out
 */
function isValidProduct(item) {
    if (!item || typeof item !== 'object') {
        return false;
    }
    
    const price = item.price;
    const stockStatus = item.stock_status;
    
    // Filter out items that have empty price AND are "In stock"
    // These items are dead urls or products that are no longer available
    const hasEmptyPrice = price === '' || price === null || price === undefined;
    const isInStock = stockStatus === 'In stock';
    
    // Return false (filter out) if both conditions are met
    if (hasEmptyPrice && isInStock) {
        return false;
    }
    
    // Keep all other items (including items with empty price but different stock status)
    return true;
}

/**
 * Converts string prices to numbers for valid products
 * @param {Array} products - Array of products to process
 * @returns {Array} Products with numeric price fields
 */
function convertPricesToNumbers(products) {
    if (!Array.isArray(products)) {
        return products;
    }
    
    products.forEach(product => {
        if (product.price && typeof product.price === 'string') {
            const numericPrice = parseFloat(product.price);
            if (!isNaN(numericPrice)) {
                product.price = numericPrice;
            }
        }
        if (product.original_price && typeof product.original_price === 'string') {
            const numericOriginalPrice = parseFloat(product.original_price);
            if (!isNaN(numericOriginalPrice)) {
                product.original_price = numericOriginalPrice;
            }
        }
    });
    
    return products;
}

/**
 * Appends items to an output file (only successful items with valid prices) with automatic file rotation
 * @param {string} outputFilePath - Path to output file
 * @param {Array} items - Items to append
 * @param {Object} metadata - Metadata about the source
 * @returns {Promise<Object>} Updated file statistics with actual file path used
 */
async function appendItemsToOutputFile(outputFilePath, successfulItems, metadata = {}) {
    if (!Array.isArray(successfulItems) || successfulItems.length === 0) {
        console.log('[OUTPUT-MANAGER] No items to append');
        return { appended: 0, total: 0, filePath: outputFilePath, filtered: 0, totalFiltered: 0 };
    }
    
    // Filter items to only include those with valid prices
    const originalCount = successfulItems.length;
    let validProducts = successfulItems.filter(isValidProduct);
    const filteredCount = originalCount - validProducts.length;
    
    // Convert price fields to numbers for valid products
    validProducts = convertPricesToNumbers(validProducts);
    
    if (filteredCount > 0) {
        console.log(`[OUTPUT-MANAGER] Filtered out ${filteredCount} items without valid prices (${validProducts.length}/${originalCount} items remain)`);
    }
    
   
    
    const MAX_ITEMS_PER_FILE = 10000;
    
    // Extract vendor directory from existing outputFilePath (don't create new directories)
    const vendorDir = path.dirname(outputFilePath);
    
    // Extract input filename from metadata, fallback to deriving from outputFilePath
    let inputFileName = metadata.inputFileName;
    if (!inputFileName) {
        const outputFileName = path.basename(outputFilePath);
        // Remove .output.json or .output_N.json suffix to get base name
        const match = outputFileName.match(/^(.+)\.output(?:_\d+)?\.json$/);
        inputFileName = match ? `${match[1]}.json` : outputFileName;
    }
    
    return withFileLock(outputFilePath, () => {
        // Find current output file with highest index
        let currentFile = findCurrentOutputFile(vendorDir, inputFileName);
        let targetFilePath = outputFilePath;
        let targetIndex = null;
        
        if (currentFile) {
            // Check if adding new items would exceed the limit
            const wouldExceedLimit = (currentFile.itemCount + validProducts.length) > MAX_ITEMS_PER_FILE;
            
            if (wouldExceedLimit) {
                // Create new indexed file
                const nextIndex = getNextOutputFileIndex(vendorDir, inputFileName);
                const newFileName = generateOutputFileName(inputFileName, nextIndex);
                targetFilePath = path.join(vendorDir, newFileName);
                targetIndex = nextIndex;
                
                console.log(`[OUTPUT-MANAGER] File rotation: ${currentFile.fileName} (${currentFile.itemCount} items) → ${newFileName} (new file)`);
            } else {
                // Use existing file
                targetFilePath = currentFile.filePath;
                targetIndex = currentFile.index;
            }
        }
        
        // Read existing file or create new structure   
        let outputData = readExistingOutputFile(targetFilePath);
        if (!outputData) {
            outputData = createBaseOutputStructure(
                metadata.vendor || path.basename(vendorDir),
                metadata.sourceFile || 'unknown'
            );
        }
        
        // Ensure backward compatibility for existing files
        if (typeof outputData.filtered_invalid_count === 'undefined') {
            outputData.filtered_invalid_count = 0;
        }
        
        // Append items with valid prices
        if (!Array.isArray(outputData.items)) {
            outputData.items = [];
        }
        outputData.items.push(...validProducts);
        
        // Update counters
        outputData.total_items = outputData.items.length;
        outputData.filtered_invalid_count += filteredCount;
        outputData.updated_at = new Date().toISOString();
        
        // Write output file
        try {
            fs.writeFileSync(targetFilePath, JSON.stringify(outputData, null, 2), 'utf8');
            
            const indexSuffix = targetIndex !== null && targetIndex > 0 ? `_${targetIndex}` : '';
            console.log(`[OUTPUT-MANAGER] Appended ${validProducts.length} items with valid prices to ${path.basename(targetFilePath)} (${outputData.total_items} total)${filteredCount > 0 ? ` [${filteredCount} items filtered out, ${outputData.filtered_invalid_count} total filtered out]` : ''}`);
            
            return {
                appended: validProducts.length,
                total: outputData.total_items,
                filePath: targetFilePath,
                index: targetIndex,
                rotated: targetFilePath !== outputFilePath,
                filtered: filteredCount,
                totalFiltered: outputData.filtered_invalid_count
            };
        } catch (err) {
            console.error(`[OUTPUT-MANAGER] Failed to write output file:`, err.message);
            logError('output_file_write_failed', { filePath: targetFilePath, error: err.message });
            throw err;
        }
    });
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
    
    // Check for existing output files (including indexed ones)
    const currentFile = findCurrentOutputFile(vendorDir, inputFileName);
    
    if (currentFile && fs.existsSync(currentFile.filePath)) {
        console.log(`[OUTPUT-MANAGER] Using existing output file: ${currentFile.fileName} in vendor directory: ${vendor} (${currentFile.itemCount} items)`);
        return currentFile.filePath;
    }
    
    // Create new output file (start with base name, no index)
    const fileName = generateOutputFileName(inputFileName);
    const outputFilePath = path.join(vendorDir, fileName);
    const initialData = createBaseOutputStructure(vendor, sourceFile);
    
    try {
        fs.writeFileSync(outputFilePath, JSON.stringify(initialData, null, 2), 'utf8');
        console.log(`[OUTPUT-MANAGER] Created output file: ${fileName} in vendor directory: ${vendor}`);
        return outputFilePath;
    } catch (err) {
        console.error(`[OUTPUT-MANAGER] Failed to create output file:`, err.message);
        logError('output_file_create_failed', { outputFilePath, error: err.message });
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
        logWarning('output_latest_file_get_failed', { vendor, error: err.message });
        return null;
    }
}

/**
 * Gets summary statistics for a vendor's output (includes all indexed files)
 * @param {string} vendor - Vendor name
 * @returns {Object} Summary statistics
 */
function getVendorSummary(vendor) {
    const vendorDir = ensureVendorDirectoryExists(vendor);
    
    try {
        const files = fs.readdirSync(vendorDir)
            .filter(file => file.endsWith('.json') && 
                   (file.includes('.output.json') || file.includes('.output_')));
        
        let totalItems = 0;
        let totalFiles = 0;
        const fileDetails = [];
        
        for (const file of files) {
            const filePath = path.join(vendorDir, file);
            const data = readExistingOutputFile(filePath);
            
            if (data) {
                const itemCount = data.total_items || 0;
                totalItems += itemCount;
                totalFiles++;
                
                fileDetails.push({
                    fileName: file,
                    itemCount,
                    createdAt: data.created_at,
                    updatedAt: data.updated_at
                });
            }
        }
        
        // Sort files by creation time or by index
        fileDetails.sort((a, b) => {
            const aMatch = a.fileName.match(/\.output_(\d+)\.json$/);
            const bMatch = b.fileName.match(/\.output_(\d+)\.json$/);
            
            if (aMatch && bMatch) {
                return parseInt(aMatch[1]) - parseInt(bMatch[1]);
            } else if (aMatch) {
                return 1; // b is base file, a is indexed
            } else if (bMatch) {
                return -1; // a is base file, b is indexed
            }
            return 0;
        });
        
        return {
            vendor,
            totalFiles,
            totalItems,
            directory: vendorDir,
            files: fileDetails
        };
    } catch (err) {
        console.warn(`[OUTPUT-MANAGER] Failed to get vendor summary for ${vendor}:`, err.message);
        logWarning('output_vendor_summary_failed', { vendor, error: err.message });
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
    findCurrentOutputFile,
    getNextOutputFileIndex,
    hasValidPrice: isValidProduct,
    convertPricesToNumbers,
    OUTPUT_DIR
};
