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
	__fileLocks.set(filePath, next.catch(() => { }));
	return next;
}

// Import vendor-specific strategies and their custom fields
const vendorStrategies = {
	superdrug: require('./superdrug')  // Match the vendor key used in index.js
};

// Import core functions from selector learning module
const { getVendorCustomFields, loadVendorSelectors, saveVendorSelectors } = require('../utils/selectorLearningCore');
const { tryExtractWithVendorSelectors } = require('./tryExtractWithVendorSelectors');
const { cleanAndValidateUrl } = require('../utils/utls');



// Helper function to apply text cleaning and price markup
function processProductData(productData) {
	const processed = { ...productData };

	// Ensure numeric price output with dynamic markup applied
	if (processed.price !== undefined && processed.price !== null) {
		let numericPrice = null;
		if (typeof processed.price === 'number' && Number.isFinite(processed.price)) {
			numericPrice = processed.price;
		} else if (typeof processed.price === 'string') {
			numericPrice = parsePrice(processed.price);
		}
		if (numericPrice && numericPrice > 0) {
			const markedUpPrice = applyDynamicMarkup(numericPrice);
			processed.price = Math.round(markedUpPrice * 100) / 100;
			processed.original_price = Math.round(numericPrice * 100) / 100;
		}
	}

	return processed;
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
	const direct = await tryExtractWithVendorSelectors(page, vendor, urlObj, allowedFields,
		 ['name', 'price', 'weight', 'description', 'category', 'main_image', 'stock_status', 'breadcrumbs']);

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
		breadcrumbs: z.array(z.string()).describe('Breadcrumb trail as an ordered array of breadcrumb label strings from root to current page'),

	};

	// console.log(`[LEARNING] direct result:`, JSON.stringify(direct, null, 2));

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
					console.log(`[SMART_CACHE] Skipping ${field}: ${value}- recently confirmed as unavailable`);
				}
			}
		}
	}

	// If all fields are present or recently confirmed unavailable, use direct result
	if (missingFields.length === 0 && direct && Object.keys(direct).length > 0) {
		const directFiltered = filterObjectKeys(applyImageFallback(direct, urlObj));
		const result = { ...metadata, ...directFiltered };
		console.log(`[LEARNING] All fields available from direct extraction, using learned selectors only`);
		return processProductData(result);
	}

	// Log what we're extracting
	if (direct && Object.keys(direct).length > 0) {
		const directFieldsFound = Object.keys(direct).filter(key => direct[key] !== undefined && direct[key] !== null && direct[key] !== '');
		console.log(`[LEARNING] Direct extraction found: ${directFieldsFound.join(', ')}`);
		console.log(`[LEARNING] Extracting ${missingFields.join(', ')} missing fields via LLM out of ${allFields.length} fields`);
	} else {
		console.log(`[LEARNING] No direct extraction found, extracting all fields via LLM`);
	}


	const extractedData = await extractFieldsViaLLM({
		page,
		fieldDefinitions,
		allowedFields,
		missingFields, 
		vendor
	});
	let fieldsForLLM = Object.keys(extractedData);
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

	// Normalize breadcrumbs: ensure array of cleaned label strings
	let breadcrumbsList = [];
	if (!allowedFields || allowedFields.has('breadcrumbs')) {
		if (Array.isArray(breadcrumbs)) {
			const labels = breadcrumbs.map(b => {
				if (typeof b === 'string') return cleanText(b);
				if (b && typeof b === 'object' && typeof b.name === 'string') return cleanText(b.name);
				return '';
			}).filter(s => s && s !== 'home');
			// Deduplicate while preserving order
			const seen = new Set();
			for (const label of labels) { if (!seen.has(label)) { seen.add(label); breadcrumbsList.push(label); } }
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
	// Apply text cleaning and price markup
	let finalResult = processProductData(applyImageFallback(result, urlObj));

	
	// Update extraction snapshot (track what LLM attempted and found)
	if (fieldsForLLM.length > 0) {
		await updateExtractionSnapshot(vendor, fieldsForLLM, llmProduct);
	}

	// Report fields that need selector learning (adaptive learning)
	if (missingFields.length > 0) {
		// Only report selectors for non-dynamic fields that were missing from direct extraction 
		selectorLearning.reportFieldsNeedingLearning(vendor, 
			missingFields.filter(field => !dynamicFields.includes(field)).filter(field => { 
			const value = finalResult[field];
			return value && (typeof value !== 'string' || value.trim() !== '');
		}))
	} else {
		// Full extraction - report fields defined in fieldDefinitions that have values 
		selectorLearning.reportFieldsNeedingLearning(vendor, 
			Object.keys(finalResult).filter(field => !dynamicFields.includes(field)).filter(field => { 
			const value = finalResult[field];
			return value && (typeof value !== 'string' || value.trim() !== '');
		}))
	}

	// Cache the result for future use (avoid caching if extraction failed or has errors)
	if (hasValidCoreData(finalResult) && !process.env.DISABLE_URL_CACHE) {
		cacheManager.set('urlResults', cacheKey, finalResult);
		console.log(`[URL_CACHE] Cached extraction result`);
	}
	// console.log(`[LEARNING] Final result:`, finalResult);
	return finalResult;
}


/**
	 * Determines which fields to extract via LLM, builds the extraction instruction and schema, and performs extraction.
	 * @param {Object} params
	 * @param {Object} params.page - Puppeteer page or compatible object with .extract method
	 * @param {Object} params.fieldDefinitions - Map of field names to Zod schemas
	 * @param {Set<string>|undefined} params.allowedFields - Set of allowed field names (optional)
	 * @param {Array<string>} params.missingFields - List of missing field names
	 * @param {string} params.vendor - Vendor identifier 
	 * @returns {Promise<Object>} - Extracted data from LLM
	 */
async function extractFieldsViaLLM({
	page,
	fieldDefinitions,
	allowedFields,
	missingFields, 
	vendor
}) {
 
	// Determine which fields to extract via LLM
	let fieldsForLLM = Object.keys(fieldDefinitions);
	if (allowedFields) fieldsForLLM = fieldsForLLM.filter(f => allowedFields.has(f));

	let instruction = "Extract the product's name, primary image URL, displayed price, all product image URLs, stock status, pack size/weight, category, and a concise description";
	if (missingFields.length > 0) {
		// Only extract missing fields via LLM
		fieldsForLLM = missingFields.filter(field => fieldDefinitions[field]); 
	}
	 

	const fieldNames = fieldsForLLM.map(field => {
		// First check base field mappings
		switch (field) {
			case 'name': return 'main product name from the product page';
			case 'price': return 'numeric price only (digits with optional decimal, no currency symbol or words)';
			case 'main_image': return 'primary image URL';
			case 'images': return 'all product image URLs or empty array if no images found';
			case 'stock_status': return 'stock status from the product page';
			case 'weight': return 'pack size/weight from the product page';
			case 'description': return 'concise description that does not repeat the product name; return empty string if none is present';
			case 'category': return 'category from the product page';
			case 'breadcrumbs': return 'breadcrumbs (array of breadcrumb labels as strings, in order)';
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
	instruction = `Extract only the following product information from the product page: ${fieldNames.join(', ')}.`;

	// Build dynamic instruction including custom vendor fields
	const vendorCustomFieldNames = Object.keys(getVendorCustomFields(vendor));
	if (vendorCustomFieldNames.length > 0) {
		const customDescriptions = vendorCustomFieldNames.map(field => {
			const fieldDef = fieldDefinitions[field];
			if (fieldDef && fieldDef._def && fieldDef._def.description) {
				return fieldDef._def.description.toLowerCase();
			}
			return field.replace(/_/g, ' ');
		});
		instruction = `${instruction}, and the following vendor-specific information: ${customDescriptions.join(', ')}.`;
	} 

	// Strengthen breadcrumbs guidance when requested
	if (fieldsForLLM.includes('breadcrumbs')) {
		instruction += ' Return breadcrumbs as an ordered array of strings (labels only). Prefer the page breadcrumb nav or JSON-LD BreadcrumbList. Exclude duplicates or generic entries like Home.';
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
	return extractedData;
}

module.exports = {
	 extractGeneric
	};
