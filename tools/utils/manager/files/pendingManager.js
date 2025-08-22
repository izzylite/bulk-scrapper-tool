'use strict';

const fs = require('fs');
const path = require('path');
const { logError, logWarning } = require('../../logUtil');

const PROCESSING_DIR = path.resolve(process.cwd(), 'scrapper/processing');
const ARCHIVED_DIR = path.join(PROCESSING_DIR, 'archived');

/**
 * Ensures that the processing directory exists
 */
function ensureProcessingDirectoryExists() {
    if (!fs.existsSync(PROCESSING_DIR)) {
        fs.mkdirSync(PROCESSING_DIR, { recursive: true });
        console.log(`[PENDING] Created processing directory: ${PROCESSING_DIR}`);
    }
}

/**
 * Gets all processing files from the processing directory
 * @returns {Array} Array of processing file objects with metadata
 */
function getProcessingFiles() {
    ensureProcessingDirectoryExists();
    
    try {
        const files = fs.readdirSync(PROCESSING_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const filePath = path.join(PROCESSING_DIR, file);
                try {
                    const stats = fs.statSync(filePath);
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return {
                        name: file,
                        path: filePath,
                        active: data.active === true,
                        vendor: data.vendor || 'unknown',
                        total_count: data.total_count || 0,
                        processed_count: data.processed_count || 0,
                        remaining_count: (data.items || []).length,
                        modified: stats.mtime
                    };
                } catch (err) {
                    console.warn(`[PENDING] Failed to read processing file ${file}:`, err.message);
                    logWarning('pending_file_read_failed', { file, error: err.message });
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());
        
        return files;
    } catch (err) {
        console.warn('[PENDING] Failed to read processing directory:', err.message);
        logWarning('pending_directory_read_failed', { error: err.message });
        return [];
    }
}

/**
 * Finds the active processing file (active: true)
 * @returns {Object|null} Active processing file metadata or null if none found
 */
function findActiveProcessingFile() {
    const files = getProcessingFiles();
    const activeFiles = files.filter(file => file.active);
    
    if (activeFiles.length === 0) {
        return null;
    }
    
    if (activeFiles.length > 1) {
        console.warn(`[PENDING] Multiple active processing files found (${activeFiles.length}), using most recent`);
        logWarning('pending_multiple_active_files', { count: activeFiles.length });
        activeFiles.forEach((file, index) => {
            if (index > 0) {
                console.log(`[PENDING] Deactivating older file: ${file.name}`);
                deactivateProcessingFile(file.path);
            }
        });
    }
    
    return activeFiles[0];
}

/**
 * Deactivates a processing file by setting active: false
 * @param {string} filePath - Path to processing file
 */
function deactivateProcessingFile(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.active = false;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[PENDING] Deactivated processing file: ${path.basename(filePath)}`);
    } catch (err) {
        console.warn(`[PENDING] Failed to deactivate processing file ${filePath}:`, err.message);
        logWarning('pending_deactivate_failed', { filePath, error: err.message });
    }
}

/**
 * Validates processing file structure
 * Expected: {active:true/false, vendor:"", total_count:0, processed_count:0, exclude:[] (optional), source_files:[] (optional), items:[{url, vendor, image_url, sku, variants}]}
 * @param {Object} data - Processing file data
 * @returns {boolean} True if valid
 */
function validateProcessingFileStructure(data) {
    if (!data || typeof data !== 'object') return false;
    
    // Check required fields
    if (typeof data.active !== 'boolean') return false;
    if (typeof data.vendor !== 'string') return false;
    if (typeof data.total_count !== 'number') return false;
    if (typeof data.processed_count !== 'number') return false;
    if (!Array.isArray(data.items)) return false;
    
    // Check optional fields
    if (data.exclude !== undefined && !Array.isArray(data.exclude)) return false;
    if (data.source_files !== undefined && !Array.isArray(data.source_files)) return false;
    
    // Validate items structure
    for (const item of data.items) {
        if (!item || typeof item !== 'object') return false;
        if (!item.url || typeof item.url !== 'string') return false;
        if (!item.vendor || typeof item.vendor !== 'string') return false;
        // image_url, sku, and variants are optional
        if (item.variants !== undefined && !Array.isArray(item.variants)) return false;
        
        // Validate variants structure if present
        if (Array.isArray(item.variants)) {
            for (const variant of item.variants) {
                if (!variant || typeof variant !== 'object') return false;
                if (!variant.url || typeof variant.url !== 'string') return false;
                // sku_id and image_url are optional in variants
            }
        }
    }
    
    return true;
}

// Per-file write lock to safely append/update JSON from concurrent workers
const __fileLocks = new Map();
function withFileLock(filePath, fn) {
	const prev = __fileLocks.get(filePath) || Promise.resolve();
	const next = prev.then(fn, fn);
	__fileLocks.set(filePath, next.catch(() => {}));
	return next;
}

// Update error information for specific URLs in the processing file
async function updateErrorsInProcessingFile(processingFilePath, errorItems) {
	if (!processingFilePath || !fs.existsSync(processingFilePath)) return;
	if (!Array.isArray(errorItems) || errorItems.length === 0) return;
	
	// Create a map of URL -> error info for quick lookup
	const errorMap = new Map();
	errorItems.forEach(item => {
		if (item && item.source_url && item.error) {
			errorMap.set(item.source_url, {
				error: item.error,
				error_timestamp: new Date().toISOString(),
				retry_count: (item.retry_count || 0) + 1
			});
		}
	});
	
	await withFileLock(processingFilePath, async () => {
		try {
			const data = JSON.parse(fs.readFileSync(processingFilePath, 'utf8'));
			
			if (!Array.isArray(data?.items)) {
				console.warn(`[WARNING] Processing file format not recognized, expected { items: [...] }`);
				logWarning('processing_file_format_unrecognized_update_errors', { expectedFormat: '{ items: [...] }' });
				return;
			}
			
			// Update items that have errors
			let updatedCount = 0;
			data.items = data.items.map(item => {
				if (item && item.url && errorMap.has(item.url)) {
					const errorInfo = errorMap.get(item.url);
					updatedCount++;
					return {
						...item,
						...errorInfo
					};
				}
				return item;
			});
			
			if (updatedCount > 0) {
				fs.writeFileSync(processingFilePath, JSON.stringify(data, null, 2), 'utf8');
				console.log(`[ERROR-UPDATE] Updated ${updatedCount} items with error information in processing file`);
			}
		} catch (err) {
			console.warn(`[WARNING] Failed to update errors in processing file:`, err.message);
			logWarning('processing_file_error_update_failed', { error: err.message });
		}
	});
}

// Batch remove a list/set of URLs from the processing file in a single locked write
async function removeUrlsFromProcessingFile(processingFilePath, urlsToRemove) {
	if (!processingFilePath || !fs.existsSync(processingFilePath)) return;
	const toRemove = Array.isArray(urlsToRemove) ? new Set(urlsToRemove) : new Set(urlsToRemove || []);
	if (toRemove.size === 0) return;
	await withFileLock(processingFilePath, async () => {
		try {
			const data = JSON.parse(fs.readFileSync(processingFilePath, 'utf8'));
			
			if (!Array.isArray(data?.items)) {
				console.warn(`[WARNING] Processing file format not recognized, expected { items: [...] }`);
				logWarning('processing_file_format_unrecognized_remove_urls', { expectedFormat: '{ items: [...] }' });
				return;
			}
			
			const originalLength = data.items.length;
			const filteredItems = data.items.filter(item => !toRemove.has(item.url));
			const removedCount = originalLength - filteredItems.length;
			
			if (filteredItems.length === 0) {
				// Mark as inactive and clear items
				data.active = false;
				data.items = [];
				data.processed_count = data.total_count || 0;
				fs.writeFileSync(processingFilePath, JSON.stringify(data, null, 2), 'utf8');
				console.log(`[COMPLETE] Processing file completed and deactivated - all URLs processed`);
				
				// Archive the completed processing file (outside the lock)
				setImmediate(() => archiveProcessingFile(processingFilePath));
				return;
			}
			
			if (removedCount > 0) {
				// Update processed_count by incrementing it with successfully removed count
				const newProcessedCount = (data.processed_count || 0) + removedCount;
				
				// Update the data structure
				data.items = filteredItems;
				data.processed_count = newProcessedCount;
				
				fs.writeFileSync(processingFilePath, JSON.stringify(data, null, 2), 'utf8');
				
				// Show simple progress (note: only successful items are removed and counted)
				if (typeof data.total_count === 'number') {
					const progressPercent = ((newProcessedCount / data.total_count) * 100).toFixed(1);
					console.log(`[PROGRESS] ${filteredItems.length} URLs remaining (${newProcessedCount}/${data.total_count} processed, ${progressPercent}%) - batch removed ${removedCount}`);
				} else {
					console.log(`[PROGRESS] ${filteredItems.length} URLs remaining in processing file (batch removed ${removedCount})`);
				}
			}
		} catch (err) {
			console.warn(`[WARNING] Failed to batch-remove URLs from processing file:`, err.message);
			logWarning('processing_file_batch_remove_failed', { error: err.message });
		}
	});
}

/**
 * Archives a completed processing file to the archived subdirectory
 * @param {string} processingFilePath - Path to the completed processing file
 */
function archiveProcessingFile(processingFilePath) {
	try {
		if (!fs.existsSync(processingFilePath)) {
			console.warn(`[ARCHIVE] Processing file not found for archiving: ${processingFilePath}`);
			return;
		}
		
		// Ensure archived directory exists
		if (!fs.existsSync(ARCHIVED_DIR)) {
			fs.mkdirSync(ARCHIVED_DIR, { recursive: true });
			console.log(`[ARCHIVE] Created archived directory: ${ARCHIVED_DIR}`);
		}
		
		const fileName = path.basename(processingFilePath);
		const timestamp = new Date().toISOString().slice(0, 10);
		const archivedFileName = `${timestamp}_${fileName}`;
		const archivedPath = path.join(ARCHIVED_DIR, archivedFileName);
		
		// Move the file to archived directory
		fs.renameSync(processingFilePath, archivedPath);
		console.log(`[ARCHIVE] Archived completed processing file: ${fileName} -> archived/${archivedFileName}`);
		
	} catch (err) {
		console.warn(`[ARCHIVE] Failed to archive processing file ${processingFilePath}:`, err.message);
		logWarning('processing_file_archive_failed', { filePath: processingFilePath, error: err.message });
	}
}

function cleanupProcessingFile(processingFilePath, processingFileName) {
	try {
		if (fs.existsSync(processingFilePath)) {
			const remainingData = JSON.parse(fs.readFileSync(processingFilePath, 'utf8'));
			
			if (!Array.isArray(remainingData?.items)) {
				console.warn(`[WARNING] Processing file format not recognized during cleanup`);
				logWarning('processing_file_format_unrecognized_cleanup', { message: 'Processing file format not recognized during cleanup' });
				return;
			}
			
			const remainingCount = remainingData.items.length;
			
			if (remainingCount === 0) {
				// Deactivate completed processing file
				remainingData.active = false;
				fs.writeFileSync(processingFilePath, JSON.stringify(remainingData, null, 2), 'utf8');
				console.log(`[CLEANUP] Processing file completed and deactivated`);
				
				// Archive the completed processing file
				archiveProcessingFile(processingFilePath);
			} else {
				if (typeof remainingData.total_count === 'number' && typeof remainingData.processed_count === 'number') {
					const progressPercent = ((remainingData.processed_count / remainingData.total_count) * 100).toFixed(1);
					console.log(`[INCOMPLETE] ${remainingCount} items remain (${remainingData.processed_count}/${remainingData.total_count} processed, ${progressPercent}%)`);
				} else {
					console.log(`[INCOMPLETE] ${remainingCount} items remain in processing file for retry`);
				}
				console.log(`[RESUME] To retry failed URLs, run the extractor again - it will resume from ${processingFileName || path.basename(processingFilePath)}`);
			}
		}
	} catch (cleanupError) {
		console.warn(`[WARNING] Could not check processing file status:`, cleanupError.message);
		logWarning('processing_file_cleanup_status_check_failed', { error: cleanupError.message });
	}
}

module.exports = {
	withFileLock, 
	removeUrlsFromProcessingFile,
	updateErrorsInProcessingFile,
	cleanupProcessingFile,
	archiveProcessingFile,
	// New processing directory functions
	ensureProcessingDirectoryExists,
	getProcessingFiles,
	findActiveProcessingFile,
	deactivateProcessingFile,
	validateProcessingFileStructure,
	PROCESSING_DIR,
	ARCHIVED_DIR
};
