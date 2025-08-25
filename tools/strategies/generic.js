'use strict';

const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const cacheManager = require('../utils/cache/cacheManager');
const selectorLearning = require('../utils/selectorLearning');
const { parsePrice, cleanText, applyDynamicMarkup } = require('../utils/mark_up_price');

// Per-file write lock to safely update vendor-selectors.json from concurrent workers
const __fileLocks = new Map();
function withFileLock(filePath, fn) {
    const prev = __fileLocks.get(filePath) || Promise.resolve();
    const next = prev.then(fn, fn);
    __fileLocks.set(filePath, next.catch(() => {}));
    return next;
}

// Import vendor-specific strategies and their custom fields
const vendorStrategies = {
	superdrug: require('./superdrug')  // Match the vendor key used in index.js
};

// Import core functions from selector learning module
const { getVendorCustomFields, loadVendorSelectors, saveVendorSelectors } = require('../utils/selectorLearningCore');



// Helper function to apply text cleaning and price markup
function processProductData(productData) {
	const processed = { ...productData };
	
	// Apply cleanText to string fields
	const textFields = ['name', 'description', 'category', 'weight', 'stock_status'];
	for (const field of textFields) {
		if (processed[field] && typeof processed[field] === 'string') {
			processed[field] = cleanText(processed[field]);
		}
	}
	
	// Apply dynamic markup to price
	if (processed.price && typeof processed.price === 'string') {
		const numericPrice = parsePrice(processed.price);
		if (numericPrice && numericPrice > 0) {
			const markedUpPrice = applyDynamicMarkup(numericPrice);
			// Keep the original currency format but update the price
			const currencyMatch = processed.price.match(/[£$€¥₹]/);
			const currency = currencyMatch ? currencyMatch[0] : '';
			processed.price = `${currency}${markedUpPrice.toFixed(2)}`;
			
			// Store original price for reference
			processed.original_price = numericPrice.toFixed(2);
		}
	}
	
	return processed;
}





// Helper function to check if a vendor already has learned selectors for a field
function hasLearnedSelectors(vendor, field) {
	try {
		const vendorData = loadVendorSelectors()[vendor];
		if (!vendorData || !vendorData.selectors) {
			return false;
		}
		
		const fieldSelectors = vendorData.selectors[field];
		return fieldSelectors && Array.isArray(fieldSelectors) && fieldSelectors.length > 0;
	} catch (error) {
		return false;
	}
}

// Helper function to fallback to sitemap image if extraction didn't find one
function applyImageFallback(item, urlObj) {
	// If extracted image is null/undefined but we have image_url from sitemap, use it
	if ((!item.main_image || item.main_image === null) && urlObj.image_url) {
		const cleanedUrl = cleanAndValidateUrl(urlObj.image_url);
		if (cleanedUrl) {
			item = { ...item, main_image: cleanedUrl };
		}
	}
	if ((!item.images || item.images.length == 0) && urlObj.image_url) {
		const cleanedUrl = cleanAndValidateUrl(urlObj.image_url);
		if (cleanedUrl) {
			item = { ...item, images: [cleanedUrl] };
		}
	}
	return item;
}

function cleanAndValidateUrl(value) {
	if (typeof value !== 'string') return null;

	// Check cache first for performance
	const cached = cacheManager.get('imageValidation', value);
	if (cached !== undefined) {
		return cached;
	}

	let result = null;
	try {
		let cleaned = value.trim();
		if (!cleaned) {
			cacheManager.set('imageValidation', value, null);
			return null;
		}

		// Remove @ prefixes that can get added during extraction
		if (cleaned.startsWith('@')) {
			cleaned = cleaned.substring(1);
		}

		// Remove other common prefixes that might get mixed in
		cleaned = cleaned.replace(/^[^\w]*([a-zA-Z]*:\/\/)/, '$1');

		// Exclude non-URL protocols
		if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(cleaned)) {
			cacheManager.set('imageValidation', value, null);
			return null;
		}

		// Try to parse as URL
		const u = new URL(cleaned);
		if (u.protocol === 'http:' || u.protocol === 'https:') {
			result = cleaned;
		}

		cacheManager.set('imageValidation', value, result);
		return result;
	} catch {
		cacheManager.set('imageValidation', value, null);
		return null;
	}
}

function isValidHttpUrl(value) {
	return cleanAndValidateUrl(value) !== null;
}

// Check if we have valid core product data (name AND either price OR out of stock status)
function hasValidCoreData(data) {
	return data && data.name &&
		(data.price || (data.stock_status && data.stock_status.toLowerCase().includes('out of stock')));
}



async function updateExtractionSnapshot(vendor, attemptedFields, extractedData) {
	const p = path.resolve(process.cwd(), 'tools/utils/cache/vendor-selectors.json');
	
	await withFileLock(p, async () => {
		try {
			const all = loadVendorSelectors();
			if (!all[vendor]) all[vendor] = {};

			// Get existing snapshot to preserve previous results
			const existingSnapshot = all[vendor].last_llm_extraction || { results: {} };
			const mergedResults = { ...existingSnapshot.results }; // Preserve existing results
			const allAttemptedFields = new Set([
				...(existingSnapshot.attempted_fields || []),
				...attemptedFields
			]);

			// Add/update results for fields attempted in this extraction
			for (const field of attemptedFields) {
				const value = extractedData[field];
				mergedResults[field] = {
					found: !!(value && (typeof value !== 'string' || value.trim() !== '')),
					value_type: Array.isArray(value) ? 'array' : typeof value
				};
			}

			// Create updated snapshot with merged results
			const snapshot = {
				timestamp: new Date().toISOString(),
				attempted_fields: Array.from(allAttemptedFields),
				results: mergedResults
			};

			all[vendor].last_llm_extraction = snapshot;
			
			// Write file inside the lock (prevents corruption during concurrent access)
			fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
		} catch { }
	});
}

// learnAndCacheSelectors is now handled by the selectorLearning module

// Helper function to check if page/context is still valid
async function isPageValid(page) {
	try {
		if (!page || page.isClosed()) {
			return false;
		}
		// Try a simple operation to check if context is still valid
		await page.evaluate(() => true, { timeout: 1000 });
		return true;
	} catch (error) {
		// If any error occurs (including context closed), consider page invalid
		return false;
	}
}

// Helper function to try multiple selectors for a field
async function trySelectorsForField(page, field, selectors, vendor, timeout = 15000) {
	if (!Array.isArray(selectors) || selectors.length === 0) {
		return { field, value: null, successfulSelector: null };
	}
	
	// Check if page is still valid before proceeding
	if (!(await isPageValid(page))) {
		console.log(`[SELECTOR_ERROR] Page/context is closed, skipping selector extraction for ${field}`);
		return { field, value: null, successfulSelector: null };
	}
	
	// Try selectors in order (most successful first)
	for (const selectorObj of selectors) {
		const selector = selectorObj.selector;
		if (!selector) continue;
		
		// Handle comma-separated fallback selectors
		const selectorOptions = selector.includes(',') ? 
			selector.split(',').map(s => s.trim()).filter(Boolean) : 
			[selector];
		
		for (const selectorOption of selectorOptions) {
			try {
				let value = null;
				
				if (field === 'main_image') {
					const src = await page.locator(selectorOption).first().getAttribute('src', { timeout: Math.min(timeout, 5000) });
					value = src ? cleanAndValidateUrl(src.trim()) : null;
				} else if (field === 'stock_status') {
					const isVisible = await page.locator(selectorOption).first().isVisible({ timeout: Math.min(timeout, 5000) });
					if (isVisible) {
						const text = await page.locator(selectorOption).first().innerText({ timeout: 3000 });
						const isOutOfStock = /out of stock|sold out|unavailable|not available/i.test(text);
						value = isOutOfStock ? 'Out of stock' : 'In stock';
					} else {
						value = 'In stock';
					}
				} else {
					// Check if this is a custom boolean field
					const customFields = getVendorCustomFields(vendor);
					const fieldDef = customFields[field];
					if (fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodBoolean') {
						// Handle boolean custom fields with different selector types
						const element = await page.locator(selectorOption).first();
						if (selectorOption.includes('input') && selectorOption.includes('hidden')) {
							// For hidden input fields, get the value attribute
							const inputValue = await element.getAttribute('value', { timeout: Math.min(timeout, 5000) });
							value = inputValue === 'true' || inputValue === true;
						} else {
							// For other elements, check visibility/existence
							const isVisible = await element.isVisible({ timeout: Math.min(timeout, 5000) });
							value = isVisible;
						}
					} else {
						// For text fields (name, price, weight, description, category, custom string fields)
						const text = await page.locator(selectorOption).first().innerText({ timeout: Math.min(timeout, 5000) });
						value = text ? text.trim() : null;
					}
				}
				
				if (value !== null && value !== '' && value !== undefined) {
					return { field, value, successfulSelector: selectorOption };
				}
			} catch (error) {
				// Check if it's a closed page/context error
				if (error.message && error.message.includes('Target page, context or browser has been closed')) {
					console.log(`[SELECTOR_ERROR] Page/context closed during ${field} extraction with selector: ${selectorOption}`);
					return { field, value: null, successfulSelector: null };
				}
				// This selector option failed, try the next one
				continue;
			}
		}
	}
	
	return { field, value: null, successfulSelector: null };
}

async function tryExtractWithVendorSelectors(page, vendor, urlObj, allowedFields = null) {
	try {
		const all = loadVendorSelectors();
		const vendorData = all[vendor];

		// Initialize result object
		const result = {};

		// Handle learned selectors (if any exist)
		let selectors = null;
		if (vendorData && vendorData.selectors) {
			selectors = vendorData.selectors;
		}

		// Extract all fields in parallel for much better performance
		const extractionPromises = [];

		// Only try learned selectors if they exist
		if (selectors && Object.keys(selectors).length > 0) {
			console.log(`[VENDOR_STRATEGY] Found ${Object.keys(selectors).length} learned selectors`);

			let baseFieldsToExtract = ['name', 'price', 'weight', 'description', 'category', 'main_image', 'stock_status'];
			if (allowedFields) {
				baseFieldsToExtract = baseFieldsToExtract.filter(f => allowedFields.has(f));
			}

			// Add custom vendor fields that can be extracted via selectors
			const customFieldNames = Object.keys(getVendorCustomFields(vendor));
			let customFieldsToExtract = customFieldNames.filter(field => {
				// Only extract string/boolean fields via selectors, not arrays or complex types
				const fieldDef = getVendorCustomFields(vendor)[field];
				return fieldDef && fieldDef._def && (
					fieldDef._def.typeName === 'ZodString' ||
					fieldDef._def.typeName === 'ZodBoolean'
				);
			});
			if (allowedFields) {
				customFieldsToExtract = customFieldsToExtract.filter(f => allowedFields.has(f));
			}

			const fieldsToExtract = [...baseFieldsToExtract, ...customFieldsToExtract];

			for (const field of fieldsToExtract) {
				if (selectors[field] && Array.isArray(selectors[field])) {
					extractionPromises.push(trySelectorsForField(page, field, selectors[field], vendor));
				}
			}
		} else {
			console.log(`[VENDOR_STRATEGY] No learned selectors found for ${vendor}, trying vendor strategy only`);
		}

		// Extract vendor-specific fields using vendor strategy if available
		if (vendorStrategies[vendor]) {
			const strategy = vendorStrategies[vendor];
			// Use the appropriate extraction function based on vendor
			let extractFunction = null;
			if (vendor === 'superdrug' && strategy.extractSuperdrugProduct) {
				extractFunction = strategy.extractSuperdrugProduct;
			}
			// Add more vendor-specific extraction functions here as needed

			if (extractFunction) {
				// First try to get product name from learned selectors or extract it directly
				const getProductNameForVendor = async () => {
					// Try to get name from learned selectors first
					if (selectors && selectors.name && Array.isArray(selectors.name)) {
						const nameResult = await trySelectorsForField(page, 'name', selectors.name, vendor, 5000);
						if (nameResult && nameResult.value) {
							return nameResult.value;
						}
					} 
					return null;
				};

				// Extract all vendor-specific data in one call
				extractionPromises.push(
					getProductNameForVendor().then(productName =>
						extractFunction(page, urlObj, productName)
							.then(vendorResult => {
								// console.log(`[VENDOR_STRATEGY] Vendor result:`, vendorResult);
								const results = [];

								if (vendorResult) {
									// Handle name if extracted by vendor strategy
									if (vendorResult.name && (!allowedFields || allowedFields.has('name'))) {
										results.push({ field: 'name', value: vendorResult.name, successfulSelector: null });
									}

									// Handle images
									if (vendorResult.images && (!allowedFields || allowedFields.has('images'))) {
										results.push({ field: 'images', value: vendorResult.images, successfulSelector: null });
									}

									// Handle main_image if not already covered by selectors
									if (
										vendorResult.main_image &&
										(!selectors || !selectors.main_image || !Array.isArray(selectors.main_image) || selectors.main_image.length === 0) &&
										(!allowedFields || allowedFields.has('main_image'))
									) {
										results.push({ field: 'main_image', value: vendorResult.main_image, successfulSelector: null });
									}

									// Handle custom vendor fields
									const customFieldNames = Object.keys(getVendorCustomFields(vendor));
									const filteredCustomFieldNames = allowedFields ? customFieldNames.filter(n => allowedFields.has(n)) : customFieldNames;
									for (const fieldName of filteredCustomFieldNames) {
										if (vendorResult[fieldName] !== undefined && vendorResult[fieldName] !== null && vendorResult[fieldName] !== '') {
											results.push({ field: fieldName, value: vendorResult[fieldName], successfulSelector: null });
										}
									}
								} else {
									console.log(`[VENDOR_STRATEGY] Vendor strategy returned null/empty result`);
								}

								return results;
							})
							.catch(error => {
								console.error(`[VENDOR_STRATEGY] Vendor strategy error:`, error);
								return [];
							})
					)
				);
			} else {
				console.log(`[VENDOR_STRATEGY] No extraction function found for ${vendor}`);
			}
		} else {
			console.log(`[VENDOR_STRATEGY] No vendor strategy found for ${vendor}`);
		}

		// Wait for all extractions to complete in parallel
		const results = await Promise.all(extractionPromises);

		// Track successful selectors for priority updates
		const successfulSelectors = {};

		// Flatten results array since vendor extraction can return arrays
		const flatResults = [];
		for (const resultItem of results) {
			if (Array.isArray(resultItem)) {
				flatResults.push(...resultItem);
			} else {
				flatResults.push(resultItem);
			}
		}

		// Apply results to the result object and track successful selectors
		for (const { field, value, successfulSelector } of flatResults) {
			if (value !== null && value !== '' && value !== undefined) {
				// Respect allowedFields filtering if provided
				if (allowedFields && !allowedFields.has(field)) {
					continue;
				}
				// For boolean fields, accept false as a valid value
				const customFields = getVendorCustomFields(vendor);
				const fieldDef = customFields[field];
				const isBooleanField = fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodBoolean';

				if (isBooleanField || value !== '') {
					result[field] = value;

					// Track which selector worked for this field
					if (successfulSelector) {
						successfulSelectors[field] = successfulSelector;
					}
				}
			}
		}

		// Update success tracking for working selectors (only if needed to reduce I/O)
		if (Object.keys(successfulSelectors).length > 0) {
			// Check if any of the successful selectors actually need updates (not already at max count)
			const vendorData2 = loadVendorSelectors()[vendor];
			const needsUpdate = Object.entries(successfulSelectors).some(([field, selector]) => {
				if (!vendorData2 || !vendorData2.selectors || !Array.isArray(vendorData2.selectors[field])) {
					return true; // New selector, needs update
				}
				const existing = vendorData2.selectors[field].find(s => s.selector === selector);
				return !existing || existing.success_count < 10;
			});

			if (needsUpdate) {
				await saveVendorSelectors(vendor, successfulSelectors);
			}
		}

		return Object.keys(result).length > 0 ? result : null; // Return null if no fields are set

	} catch (error) {
		console.error(`[VENDOR_STRATEGY] Error in tryExtractWithVendorSelectors:`, error);
		return null;
	}
}


async function extractGeneric(page, urlObj, updateCtx = null) {
	const url = urlObj.url;
	const vendor = urlObj.vendor || 'vendor'; // Use vendor from urlObj, fallback to 'vendor'
	
	// Generate metadata for this extraction
 
	const metadata = { vendor, url, product_id: urlObj.sku, timestamp: new Date().toISOString() };
	// Update-mode field filtering context (passed in by caller)
	const isUpdateMode = !!(updateCtx && updateCtx.enabled);
	const allowedFields = (isUpdateMode && Array.isArray(updateCtx.updateFields) && updateCtx.updateFields.length > 0) ? new Set(updateCtx.updateFields) : null;
	const filterFieldsList = (list) => allowedFields ? list.filter(f => allowedFields.has(f)) : list;
	const filterObjectKeys = (obj) => {
		if (!allowedFields || !obj || typeof obj !== 'object') return obj;
		const out = {};
		for (const k of Object.keys(obj)) { if (allowedFields.has(k)) out[k] = obj[k]; }
		return out;
	};

	// Check URL result cache first (skip for dynamic fields that change frequently)
	const cacheKey = `${vendor}:${url}`;
	const cachedResult = cacheManager.get('urlResults', cacheKey);
	if (cachedResult && !process.env.DISABLE_URL_CACHE) {
		console.log(`[URL_CACHE] Using cached result for ${url}`);
		return processProductData({ ...cachedResult });
	}

	// First try direct selector extraction (no LLM) if available
	const direct = await tryExtractWithVendorSelectors(page, vendor, urlObj, allowedFields);

	// Build dynamic schema for only the fields we need from LLM
	// Start with base field definitions
	const baseFieldDefinitions = {
		name: z.string().describe('The exact product name shown on the page'),
		main_image: z.string().describe('Direct URL to the primary/hero product image starting with http:// or https:// (return empty string if no valid image URL found)'),
		images: z.array(z.string()).describe(`Gallery of product images. Array of ALL product image URLs starting with http:// or https://. (return empty string if no valid image URL found)`),
		price: z.string().describe('Displayed price text, including currency symbol if shown'),
		stock_status: z.string().describe('Stock availability status: "In stock" or "Out of stock"'),
		weight: z.string().describe('Pack size/weight/volume text if available, e.g., 500g or 2x100ml'),
		description: z.string().describe('Primary product description or details shown on the page'),
		category: z.string().describe('Primary product category or breadcrumb category text shown on the page'),
		breadcrumbs: z.array(z.object({
			name: z.string().describe('Breadcrumb label text'),
			url: z.string().describe('Breadcrumb URL for this level (http/https)')
		})).describe('Breadcrumb trail as an array of {name, url} objects in order from root to current page'),
	
	};

	// Merge with vendor-specific custom fields
	const vendorCustomFields = getVendorCustomFields(vendor);
	let fieldDefinitions = { ...baseFieldDefinitions, ...vendorCustomFields };

	// Derive all fields from fieldDefinitions to eliminate maintenance errors
	let allFields = Object.keys(fieldDefinitions);
	// Restrict to update fields in update mode
	if (allowedFields) allFields = allFields.filter(f => allowedFields.has(f));

	// Define dynamic fields that should always use LLM (never learn selectors)
	// Note: 'images' is now handled by vendor-specific strategies when available
	const dynamicFields = [];

	// Always check for missing fields and use smart extraction logic
	const missingFields = [];
	
	// Load vendor data for smart caching
	const vendorData = loadVendorSelectors()[vendor] || {};
	const lastSnapshot = vendorData.last_llm_extraction;
	const now = new Date();
	const isSnapshotFresh = lastSnapshot &&
		(now - new Date(lastSnapshot.timestamp)) < (30 * 60 * 1000); // 30 minutes freshness

	// Check which fields are missing or empty from direct extraction
	for (const field of allFields) {
		const value = direct && direct[field];
		const isMissingFromDirect = !value || (typeof value === 'string' && value.trim() === '');
		const isDynamicField = dynamicFields.length > 0 && dynamicFields.includes(field);

		if (isMissingFromDirect || isDynamicField) {
			// Always include dynamic fields for LLM extraction
			if (isDynamicField) {
				missingFields.push(field);
			} else {
				// For non-dynamic fields, check smart cache
				const wasRecentlyAttempted = (
					isSnapshotFresh &&
					Array.isArray(lastSnapshot.attempted_fields) &&
					lastSnapshot.attempted_fields.includes(field) &&
					lastSnapshot.results &&
					lastSnapshot.results[field] &&
					lastSnapshot.results[field].found === false
				);

				if (!wasRecentlyAttempted) {
					missingFields.push(field);
				} else {
					console.log(`[SMART_CACHE] Skipping ${field} - recently confirmed as unavailable`);
				}
			}
		}
	}

	// If all fields are present or recently confirmed unavailable, use direct result
	if (missingFields.length === 0 && direct && Object.keys(direct).length > 1) {
		const directFiltered = filterObjectKeys(applyImageFallback(direct, urlObj));
		const result = { ...metadata, ...directFiltered };
		console.log(`[LEARNING] All fields available from direct extraction, using learned selectors only`);
		return processProductData(result);
	}

	// Log what we're extracting
	if (direct && Object.keys(direct).length > 1) {
		const directFieldsFound = Object.keys(direct).filter(key => direct[key] !== undefined && direct[key] !== null && direct[key] !== '');
		console.log(`[LEARNING] Direct extraction found: ${directFieldsFound.join(', ')}`);
		console.log(`[LEARNING] Extracting ${missingFields.join(', ')} missing fields via LLM out of ${allFields.length} fields`);
	} else {
		console.log(`[LEARNING] No direct extraction found, extracting all fields via LLM`);
	}


	// Determine which fields to extract via LLM
	let fieldsForLLM = Object.keys(fieldDefinitions);
	if (allowedFields) fieldsForLLM = fieldsForLLM.filter(f => allowedFields.has(f));

	// Build dynamic instruction including custom vendor fields
	const baseInstruction = "Extract the product's name, primary image URL, displayed price, all product image URLs, stock status, pack size/weight, category, and a concise description";
	const vendorCustomFieldNames = Object.keys(getVendorCustomFields(vendor));
	let instruction = baseInstruction;
	
	if (vendorCustomFieldNames.length > 0) {
		const customDescriptions = vendorCustomFieldNames.map(field => {
			const fieldDef = fieldDefinitions[field];
			if (fieldDef && fieldDef._def && fieldDef._def.description) {
				return fieldDef._def.description.toLowerCase();
			}
			return field.replace(/_/g, ' ');
		});
		instruction = `${baseInstruction}, and the following vendor-specific information: ${customDescriptions.join(', ')}.`;
	} else {
		instruction = `${baseInstruction}.`;
	}

	if (missingFields.length > 0) {
		// Only extract missing fields via LLM
		fieldsForLLM = missingFields.filter(field => fieldDefinitions[field]);
		const fieldNames = fieldsForLLM.map(field => {
			// First check base field mappings
			switch (field) {
				case 'name': return 'product name';
				case 'price': return 'displayed price';
				case 'main_image': return 'primary image URL';
				case 'images': return 'all product image URLs or empty array if no images found';
				case 'stock_status': return 'stock status';
				case 'weight': return 'pack size/weight';
				case 'description': return 'description';
				case 'category': return 'category';
				case 'breadcrumbs': return 'breadcrumbs (array of objects with name and url)';
				default:
					// For custom vendor fields, try to extract description from Zod schema
					const fieldDef = fieldDefinitions[field];
					if (fieldDef && fieldDef._def && fieldDef._def.description) {
						// Use the Zod description for custom fields
						return fieldDef._def.description.toLowerCase();
					}
					// Fallback to field name with better formatting
					return field.replace(/_/g, ' ');
			}
		});
		instruction = `Extract only the following product information: ${fieldNames.join(', ')}.`;
	}

	// Strengthen breadcrumbs guidance when requested
	if (fieldsForLLM.includes('breadcrumbs')) {
		instruction += ' Return breadcrumbs as an ordered array of objects with fields name and url. Prefer the page breadcrumb nav or JSON-LD of type BreadcrumbList. Ensure url is absolute (http/https) and exclude duplicates like Home.';
	}
 
	// Build dynamic schema with only needed fields
	const schemaFields = {};
	for (const field of fieldsForLLM) {
		if (fieldDefinitions[field]) {
			schemaFields[field] = fieldDefinitions[field];
		}
	}
	const schema = z.object(schemaFields);


	const settleMs = fieldsForLLM.includes('breadcrumbs') ? 25000 : 10000;
	const extractedData = await page.extract({
		instruction,
		schema,
		domSettleTimeoutMs: settleMs,
	});

	// Create defaults based on field definitions to maintain consistency
	const extractedDefaults = {};
	for (const field of Object.keys(fieldDefinitions)) {
		if (allowedFields && !allowedFields.has(field)) continue;
		const fieldDef = fieldDefinitions[field];
		if (fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodArray') {
			extractedDefaults[field] = [];
		} else {
			extractedDefaults[field] = '';
		}
	}

	// Merge extracted data with defaults
	const normalizedData = { ...extractedDefaults, ...extractedData };

	// Extract base fields (respect allowedFields subset)
	const { name, main_image, images, price, stock_status, weight, description, category, breadcrumbs } = normalizedData;

	// Extract all custom fields dynamically
	const customFieldData = {};
	const extractedCustomFieldNames = Object.keys(getVendorCustomFields(vendor));
	for (const fieldName of extractedCustomFieldNames) {
		if (allowedFields && !allowedFields.has(fieldName)) continue;
		if (normalizedData[fieldName] !== undefined) {
			customFieldData[fieldName] = normalizedData[fieldName];
		}
	}


	// Normalize and validate image URLs
	// Handle case where LLM returns element IDs instead of URLs for images array
	let imagesList = [];
	if (!allowedFields || allowedFields.has('images')) {
		if (Array.isArray(images)) {
			// Filter out element IDs and non-URL strings, then clean/validate URLs
			imagesList = images
				.filter(img => typeof img === 'string' && img.trim() !== '')
				.map(cleanAndValidateUrl) // Clean and validate URLs (handles @ prefixes)
				.filter(Boolean); // Keep only valid URLs
		}
	}

	let mainImage = (!allowedFields || allowedFields.has('main_image')) ? (cleanAndValidateUrl(main_image) || '') : '';
	if (!mainImage && imagesList.length > 0) {
		mainImage = imagesList[0];
	}
	// Ensure list includes mainImage and contains only valid, unique URLs
	if (mainImage && (!allowedFields || allowedFields.has('images'))) imagesList.unshift(mainImage);
	imagesList = Array.from(new Set(imagesList.filter(Boolean)));

	// Normalize breadcrumbs: ensure array of { name, url } with valid URLs
	let breadcrumbsList = [];
	if (!allowedFields || allowedFields.has('breadcrumbs')) {
		if (Array.isArray(breadcrumbs)) {
			breadcrumbsList = breadcrumbs
				.map(b => {
					if (!b || typeof b !== 'object') return null;
					const nameVal = typeof b.name === 'string' ? cleanText(b.name) : '';
					const urlVal = typeof b.url === 'string' ? cleanAndValidateUrl(b.url) : null;
					if (!nameVal || !urlVal) return null;
					return { name: nameVal, url: urlVal };
				})
				.filter(Boolean);
		}
	}

	// Create LLM extracted product data (including custom fields)
	let llmProduct = { 
		...(allowedFields && !allowedFields.has('name') ? {} : { name }),
		...(allowedFields && !allowedFields.has('main_image') ? {} : { main_image: mainImage }),
		...(allowedFields && !allowedFields.has('images') ? {} : { images: imagesList }),
		...(allowedFields && !allowedFields.has('price') ? {} : { price }),
		...(allowedFields && !allowedFields.has('stock_status') ? {} : { stock_status }),
		...(allowedFields && !allowedFields.has('weight') ? {} : { weight }),
		...(allowedFields && !allowedFields.has('description') ? {} : { description }),
		...(allowedFields && !allowedFields.has('category') ? {} : { category }),
		...(allowedFields && !allowedFields.has('breadcrumbs') ? {} : { breadcrumbs: breadcrumbsList }),
		...customFieldData  // Include any custom vendor fields
	};
	if (allowedFields) llmProduct = filterObjectKeys(llmProduct);

	// Merge direct extraction results with LLM results (prioritize direct when available)
	let finalProduct = llmProduct;
	if (direct) {
		finalProduct = {
			...llmProduct, // Start with LLM results as base
			...filterObjectKeys(direct),     // Overlay direct results (filtered to allowed fields)
			// Use direct result for main_image if available, otherwise use LLM result
			...(allowedFields && !allowedFields.has('main_image') ? {} : { main_image: (direct.main_image || mainImage) }),
			// Use direct result for images if available and not empty, otherwise use LLM result
			...(allowedFields && !allowedFields.has('images') ? {} : { images: (direct.images && Array.isArray(direct.images) && direct.images.length > 0) ? direct.images : imagesList }),
			 
		};

	}

	const result = { ...metadata, ...finalProduct };
	// Apply image fallback if urlObj is provided (from sitemap data)
	let finalResult = applyImageFallback(result, urlObj);
	
	// Apply text cleaning and price markup
	finalResult = processProductData(finalResult);

	// Update extraction snapshot (track what LLM attempted and found)
	if (fieldsForLLM.length > 0) {
		await updateExtractionSnapshot(vendor, fieldsForLLM, llmProduct);
	}

	// Report fields that need selector learning (adaptive learning)
	if (missingFields.length > 0) {
		// Only report selectors for non-dynamic fields that were missing from direct extraction
		const fieldsToReport = [];
		for (const field of missingFields) {
			// Skip dynamic fields - they should always use LLM
			if (dynamicFields.includes(field)) {
				continue;
			}

			const value = finalResult[field];
			if (value && (typeof value !== 'string' || value.trim() !== '')) {
				fieldsToReport.push(field);
			}
		}

		if (fieldsToReport.length > 0) {
			if (selectorLearning.reportFieldsNeedingLearning(vendor, fieldsToReport)) {
				console.log(`[LEARNING] Reporting fields needing learning: ${fieldsToReport.join(', ')}`);
				console.log(`[LEARNING] These fields were missing from direct extraction and found by LLM`);
			}
		}
	} else {
		// Full extraction - report fields defined in fieldDefinitions that have values
		const extractableFields = Object.keys(fieldDefinitions).filter(field => !dynamicFields.includes(field));
		const fieldsWithValues = extractableFields.filter(field => {
			if (allowedFields && !allowedFields.has(field)) return false;
			const value = finalResult[field];
			return value && (typeof value !== 'string' || value.trim() !== '');
		});

		// Only report fields that don't already have learned selectors
		const fieldsNeedingSelectors = fieldsWithValues.filter(field => !hasLearnedSelectors(vendor, field));

		if (fieldsNeedingSelectors.length > 0) {
			if (selectorLearning.reportFieldsNeedingLearning(vendor, fieldsNeedingSelectors)) {
				console.log(`[LEARNING] Reporting new fields needing learning: ${fieldsNeedingSelectors.join(', ')}`);
			}
		} else if (fieldsWithValues.length > 0) {
			console.log(`[LEARNING] All extractable fields already have learned selectors: ${fieldsWithValues.join(', ')}`);
		}
	}

	// Cache the result for future use (avoid caching if extraction failed or has errors)
	if (hasValidCoreData(finalResult) && !process.env.DISABLE_URL_CACHE) {
		cacheManager.set('urlResults', cacheKey, finalResult);
		console.log(`[URL_CACHE] Cached extraction result`);
	}
	// console.log(`[LEARNING] Final result:`, finalResult);
	return finalResult;
}

module.exports = { extractGeneric };
