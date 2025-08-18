'use strict';

const fs = require('fs');
const path = require('path');
const {
	createExclusionFilter,
	detectFirstUrlFromData,
	getHostnameFromUrl,
	resolveExclusionsForHostname,
} = require('./exclusion');

function inferVendorFromUrl(u) {
    try {
        const host = new URL(u).hostname.toLowerCase();
        const h = host.replace(/^www\./, '');
        const parts = h.split('.');
        if (parts.length >= 3) {
            const last = parts[parts.length - 1];
            const second = parts[parts.length - 2];
            if (last.length === 2 && (second === 'co' || second === 'com' || second === 'org' || second === 'net' || second === 'gov' || second === 'edu')) {
                return parts[parts.length - 3];
            }
        }
        if (parts.length >= 2) return parts[parts.length - 2];
        return parts[0] || 'vendor';
    } catch {
        return 'vendor';
    }
}

// Extract SKU/product ID from URL patterns
function extractSkuFromUrl(url) {
	try {
		// Pattern: https://www.superdrug.com/.../p/mp-00296692
		// Extract the last segment after "/p/"
		const match = url.match(/\/p\/([^\/\?#]+)/);
		if (match && match[1]) {
			return match[1]; // Returns "mp-00296692"
		}
		
		// Fallback: get the last segment of the path
		const urlObj = new URL(url);
		const pathSegments = urlObj.pathname.split('/').filter(Boolean);
		if (pathSegments.length > 0) {
			const lastSegment = pathSegments[pathSegments.length - 1];
			// Only use if it looks like a product ID (contains letters/numbers/hyphens)
			if (/^[a-zA-Z0-9\-_]+$/.test(lastSegment)) {
				return lastSegment;
			}
		}
	} catch (error) {
		// Silently fail if URL parsing fails
	}
	return null;
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
			
			if (!Array.isArray(data?.objects)) {
				console.warn(`[WARNING] Processing file format not recognized, expected { objects: [...] }`);
				return;
			}
			
			// Update objects that have errors
			let updatedCount = 0;
			data.objects = data.objects.map(obj => {
				if (obj && obj.url && errorMap.has(obj.url)) {
					const errorInfo = errorMap.get(obj.url);
					updatedCount++;
					return {
						...obj,
						...errorInfo
					};
				}
				return obj;
			});
			
			if (updatedCount > 0) {
				fs.writeFileSync(processingFilePath, JSON.stringify(data, null, 2), 'utf8');
				console.log(`[ERROR-UPDATE] Updated ${updatedCount} objects with error information in processing file`);
			}
		} catch (err) {
			console.warn(`[WARNING] Failed to update errors in processing file:`, err.message);
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
			
			if (!Array.isArray(data?.objects)) {
				console.warn(`[WARNING] Processing file format not recognized, expected { objects: [...] }`);
				return;
			}
			
			const originalLength = data.objects.length;
			const objects = data.objects.filter(obj => !toRemove.has(obj.url));
			const removedCount = originalLength - objects.length;
			
			if (objects.length === 0) {
				fs.unlinkSync(processingFilePath);
				console.log(`[COMPLETE] Processing file deleted - all URLs processed`);
				return;
			}
			
			if (removedCount > 0) {
				// Update processed_count by incrementing it with successfully removed count
				const newProcessedCount = (data.processed_count || 0) + removedCount;
				const updatedData = { 
					...data, 
					processed_count: newProcessedCount,
					objects 
				};
				fs.writeFileSync(processingFilePath, JSON.stringify(updatedData, null, 2), 'utf8');
				
				// Show simple progress (note: only successful items are removed and counted)
				if (typeof data.total_count === 'number') {
					const progressPercent = ((newProcessedCount / data.total_count) * 100).toFixed(1);
					console.log(`[PROGRESS] ${objects.length} URLs remaining (${newProcessedCount}/${data.total_count} processed, ${progressPercent}%) - batch removed ${removedCount}`);
				} else {
					console.log(`[PROGRESS] ${objects.length} URLs remaining in processing file (batch removed ${removedCount})`);
				}
			}
		} catch (err) {
			console.warn(`[WARNING] Failed to batch-remove URLs from processing file:`, err.message);
		}
	});
}

function determineProcessingPaths(absDir, inputFileName) {
	const processingFileName = `${path.basename(inputFileName, path.extname(inputFileName))}.processing.json`;
	const processingFilePath = path.join(absDir, processingFileName);
	return { processingFileName, processingFilePath };
}



function extractObjectsFromData(data) {
	// Determine domain-specific exclusions from config; fallback to inline for backward compatibility
	const firstUrl = detectFirstUrlFromData(data);
	const hostname = getHostnameFromUrl(firstUrl);
	const vendor = inferVendorFromUrl(firstUrl);
	console.log(`[VENDOR] Detected vendor: ${vendor} from URL: ${firstUrl}`);
	
	let exclusions = resolveExclusionsForHostname(hostname);
	if (exclusions) {
		console.log(`[EXCLUSION] Using domain exclusions for ${hostname}: [${exclusions.map(e => `"${e}"`).join(', ')}]`);
	} else if (Array.isArray(data?.exclusion) || Array.isArray(data?.exclusions)) {
		// Backward compatibility with inline exclusions
		exclusions = data?.exclusion || data?.exclusions;
	}
	const exclusionFilter = createExclusionFilter(exclusions);
	
	if (exclusionFilter && exclusions) {
		console.log(`[EXCLUSION] Applying exclusion filters: [${exclusions.map(e => `"${e}"`).join(', ')}]`);
	}
	
	let objects = [];
	let originalCount = 0;

	function processItemsArray(items) {
		console.log(`[FORMAT] Detected 'items' array format with url/image_url (${items.length} items)`);
		const validItems = items.filter(item => item && item.url);
		originalCount = validItems.length;
		return validItems
			.filter(item => !exclusionFilter || exclusionFilter(item.url))
			.map(item => {
				const result = { url: item.url, vendor };
				if (item.image_url) {
					result.image_url = item.image_url;
				}
				// Extract SKU from URL for this item
				const sku = extractSkuFromUrl(item.url);
				if (sku) {
					result.sku = sku;
				}
				return result;
			});
	}
	
	// Extract objects based on input format with exclusion filtering applied during creation
	if (Array.isArray(data?.urls)) {
		console.log(`[FORMAT] Detected 'urls' array format (${data.urls.length} items)`);
		const validUrls = data.urls.filter(Boolean);
		originalCount = validUrls.length;
		objects = validUrls
			.filter(url => !exclusionFilter || exclusionFilter(url))
			.map(url => {
				const result = { url, vendor };
				// Extract SKU from URL for this item
				const sku = extractSkuFromUrl(url);
				if (sku) {
					result.sku = sku;
				}
				return result;
			});
	} else if (Array.isArray(data?.items)) {
		objects = processItemsArray(data.items);
	}
	else if (Array.isArray(data?.objects)) {
		objects = processItemsArray(data.objects);
	}	
	else if (Array.isArray(data)) {
		console.log(`[FORMAT] Detected direct array format (${data.length} items)`);
		const validUrls = data.filter(Boolean);
		originalCount = validUrls.length;
		objects = validUrls
			.filter(url => !exclusionFilter || exclusionFilter(url))
			.map(url => {
				const result = { url, vendor };
				// Extract SKU from URL for this item
				const sku = extractSkuFromUrl(url);
				if (sku) {
					result.sku = sku;
				}
				return result;
			});
	} else {
		console.log(`[FORMAT] No recognized format found`);
		return [];
	}
	
	// Log exclusion results if filtering was applied
	if (exclusionFilter && originalCount > 0) {
		const filteredCount = originalCount - objects.length;
		if (filteredCount > 0) {
			console.log(`[EXCLUSION] Filtered out ${filteredCount} URLs (${objects.length} remaining)`);
		} else {
			console.log(`[EXCLUSION] No URLs matched exclusion patterns`);
		}
	}
	
	return objects;
}

// Safeguard: filter out URLs that already exist in an output file when processing file is missing
function filterObjectsUsingExistingOutput(absDir, inputFileName, objects) {
	try {
		const outputUnifiedName = `${path.basename(inputFileName, path.extname(inputFileName))}.output.json`;
		const outputDir = path.join(absDir, 'extracted-output');
		const outputUnifiedPath = path.join(outputDir, outputUnifiedName);
		if (!fs.existsSync(outputUnifiedPath) || !Array.isArray(objects)) return { objects, removed: 0, totalBefore: Array.isArray(objects) ? objects.length : 0 };
		const outRaw = fs.readFileSync(outputUnifiedPath, 'utf8');
		const outData = JSON.parse(outRaw);
		const existingUrls = new Set(
			Array.isArray(outData?.items)
				? outData.items
					.map(it => (it && (it.source_url || it.product_url)) || null)
					.filter(Boolean)
				: []
		);
		if (existingUrls.size === 0) return { objects, removed: 0, totalBefore: objects.length };
		const before = objects.length;
		const filtered = objects.filter(o => o && !existingUrls.has(o.url));
		const removed = before - filtered.length;
		if (removed > 0) {
			console.log(`[RESUME-GUARD] ${inputFileName}: Filtered ${removed} URLs already present in output (${outputUnifiedName})`);
		}
		return { objects: filtered, removed, totalBefore: before };
	} catch (guardErr) {
		console.warn(`[RESUME-GUARD] ${inputFileName}: Failed to apply output-based filtering:`, guardErr.message);
		return { objects, removed: 0, totalBefore: Array.isArray(objects) ? objects.length : 0 };
	}
}

function prepareProcessing(absDir, inputFile, inputData) {
	const { processingFileName, processingFilePath } = determineProcessingPaths(absDir, inputFile.name);
	let objectsToProcess;
	let isResuming = false;
	
	if (fs.existsSync(processingFilePath)) {
		// Resume from processing file
		console.log(`[RESUME] ${inputFile.name}: Found processing file, resuming from ${processingFileName}`);
		try {
			const processingData = JSON.parse(fs.readFileSync(processingFilePath, 'utf8'));
			
			if (Array.isArray(processingData?.objects)) {
				objectsToProcess = processingData.objects.filter(Boolean);
				isResuming = true;
				
				// Show simple progress
				if (typeof processingData.total_count === 'number' && typeof processingData.processed_count === 'number') {
					const progressPercent = ((processingData.processed_count / processingData.total_count) * 100).toFixed(1);
					console.log(`[RESUME] ${inputFile.name}: ${objectsToProcess.length} objects remaining (${processingData.processed_count}/${processingData.total_count} processed, ${progressPercent}%)`);
				} else {
					console.log(`[RESUME] ${inputFile.name}: ${objectsToProcess.length} objects remaining to process`);
				}
			} else {
				console.warn(`[RESUME] Processing file format not recognized, starting fresh`);
				objectsToProcess = extractObjectsFromData(processingData);
			}
		} catch (err) {
			console.warn(`[RESUME] Failed to read processing file ${processingFileName}, starting fresh:`, err.message);
			objectsToProcess = extractObjectsFromData(inputData);
		}
	} else {
		// Create processing file for new job
		console.log(`[NEW] ${inputFile.name}: Creating processing file ${processingFileName}`);
		objectsToProcess = extractObjectsFromData(inputData);
		const guard = filterObjectsUsingExistingOutput(absDir, inputFile.name, objectsToProcess);
		objectsToProcess = guard.objects;
		try {
			
			const processedCountFromOutput = (guard && typeof guard.removed === 'number') ? guard.removed : 0;
			const processingData = { 
				total_count: (guard && typeof guard.totalBefore === 'number') ? guard.totalBefore : objectsToProcess.length,
				processed_count: processedCountFromOutput,
				objects: objectsToProcess 
			};
			fs.writeFileSync(processingFilePath, JSON.stringify(processingData, null, 2), 'utf8');
			console.log(`[NEW] ${inputFile.name}: Processing file created with ${objectsToProcess.length} objects (processed_count preset to ${processedCountFromOutput})`);
		} catch (err) {
			console.error(`[ERROR] Failed to create processing file ${processingFileName}:`, err.message);
			// Continue without processing file as fallback
		}
	}

	return { processingFileName, processingFilePath, objectsToProcess, isResuming };
}

function cleanupProcessingFile(processingFilePath, processingFileName) {
	try {
		if (fs.existsSync(processingFilePath)) {
			const remainingData = JSON.parse(fs.readFileSync(processingFilePath, 'utf8'));
			
			if (!Array.isArray(remainingData?.objects)) {
				console.warn(`[WARNING] Processing file format not recognized during cleanup`);
				return;
			}
			
			const remainingCount = remainingData.objects.length;
			
			if (remainingCount === 0) {
				fs.unlinkSync(processingFilePath);
				console.log(`[CLEANUP] Empty processing file deleted`);
			} else {
				 
				if (typeof remainingData.total_count === 'number' && typeof remainingData.processed_count === 'number') {
					const progressPercent = ((remainingData.processed_count / remainingData.total_count) * 100).toFixed(1);
					console.log(`[INCOMPLETE] ${remainingCount} items remain (${remainingData.processed_count}/${remainingData.total_count} processed, ${progressPercent}%)`);
				} else {
					console.log(`[INCOMPLETE] ${remainingCount} items remain in processing file for retry`);
				}
				console.log(`[RESUME] To retry failed URLs, run the extractor again - it will resume from ${processingFileName}`);
			}
		}
	} catch (cleanupError) {
		console.warn(`[WARNING] Could not check processing file status:`, cleanupError.message);
	}
}

module.exports = {
	withFileLock, 
	removeUrlsFromProcessingFile,
	updateErrorsInProcessingFile,
	prepareProcessing,
	cleanupProcessingFile,
	extractObjectsFromData,
	createExclusionFilter,
};


