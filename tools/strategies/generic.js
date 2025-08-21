'use strict';

const { z } = require('zod');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cacheManager = require('../utils/cache/cacheManager');
const selectorLearning = require('../utils/selectorLearning');

// Import vendor-specific strategies and their custom fields
const vendorStrategies = {
    superdrug: require('./superdrug')  // Match the vendor key used in index.js
};

// Import core functions from selector learning module
const { getVendorCustomFields, loadVendorSelectors, saveVendorSelectors } = require('../utils/selectorLearningCore');





// Helper function to fallback to sitemap image if extraction didn't find one
function applyImageFallback(item, urlObj) {
    // If extracted image is null/undefined but we have image_url from sitemap, use it
    if ((!item.main_image || item.main_image === null) && urlObj.image_url) {
        const cleanedUrl = cleanAndValidateUrl(urlObj.image_url);
        if (cleanedUrl) {
            item = { ...item, main_image: cleanedUrl };
        }
    }
	if((!item.images || item.images.length == 0) && urlObj.image_url){
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
 
 

function updateExtractionSnapshot(vendor, attemptedFields, extractedData) {
    try {
        const p = path.resolve(process.cwd(), 'tools/utils/cache/vendor-selectors.json');
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
        fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
    } catch {}
}

// learnAndCacheSelectors is now handled by the selectorLearning module

// Helper function to try multiple selectors for a field
async function trySelectorsForField(page, field, selectors, timeout = 10000) {
    if (!Array.isArray(selectors) || selectors.length === 0) {
        return { field, value: null, successfulSelector: null };
    }
    
    // Try selectors in order (most successful first)
    for (const selectorObj of selectors) {
        const selector = selectorObj.selector;
        if (!selector) continue;
        
        try {
            let value = null;
            
            if (field === 'main_image') {
                const src = await page.locator(selector).first().getAttribute('src', { timeout });
                value = src ? cleanAndValidateUrl(src.trim()) : null;
            } else if (field === 'stock_status') {
                const isVisible = await page.locator(selector).first().isVisible({ timeout });
                if (isVisible) {
                    const text = await page.locator(selector).first().innerText({ timeout: 5000 });
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
                    const element = await page.locator(selector).first();
                    if (selector.includes('input') && selector.includes('hidden')) {
                        // For hidden input fields, get the value attribute
                        const inputValue = await element.getAttribute('value', { timeout });
                        value = inputValue === 'true' || inputValue === true;
                    } else {
                        // For other elements, check visibility/existence
                        const isVisible = await element.isVisible({ timeout });
                        value = isVisible;
                    }
                } else {
                    // For text fields (name, price, weight, description, category, discount, custom string fields)
                    const text = await page.locator(selector).first().innerText({ timeout });
                    value = text ? text.trim() : null;
                }
            }
            
            if (value !== null && value !== '' && value !== undefined) {
                return { field, value, successfulSelector: selector };
            }
        } catch (error) {
            // Selector failed, try next one
            continue;
        }
    }
    
    return { field, value: null, successfulSelector: null };
}

async function tryExtractWithVendorSelectors(page, vendor, url) {
    try {
        const all = loadVendorSelectors();
        const vendorData = all[vendor];
        if (!vendorData) return null;
        
        // Handle backward compatibility with old format
        let selectors = vendorData.selectors;
        if (!selectors && Object.keys(vendorData).some(key => key !== 'last_llm_extraction')) {
            // Convert old format on the fly (don't modify the original data)
            selectors = {};
            for (const [field, selector] of Object.entries(vendorData)) {
                if (field !== 'last_llm_extraction' && typeof selector === 'string') {
                    selectors[field] = [{ selector, success_count: 1 }];
                }
            }
        }
        
        if (!selectors || Object.keys(selectors).length === 0) return null;
        
        const result = { product_url: url };
        
        // Extract all fields in parallel for much better performance
        const extractionPromises = [];
        const baseFieldsToExtract = ['name', 'price', 'weight', 'description', 'category', 'discount', 'main_image', 'stock_status'];
        
        // Add custom vendor fields that can be extracted via selectors
        const customFieldNames = Object.keys(getVendorCustomFields(vendor));
        const customFieldsToExtract = customFieldNames.filter(field => {
            // Only extract string/boolean fields via selectors, not arrays or complex types
            const fieldDef = getVendorCustomFields(vendor)[field];
            return fieldDef && fieldDef._def && (
                fieldDef._def.typeName === 'ZodString' || 
                fieldDef._def.typeName === 'ZodBoolean'
            );
        });
        
        const fieldsToExtract = [...baseFieldsToExtract, ...customFieldsToExtract];
        
        for (const field of fieldsToExtract) {
            if (selectors[field] && Array.isArray(selectors[field])) {
                extractionPromises.push(trySelectorsForField(page, field, selectors[field]));
            }
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
                // Extract all vendor-specific data in one call
                extractionPromises.push(
                    extractFunction(page, { url, vendor })
                        .then(vendorResult => {
                            const results = [];
                            
                            if (vendorResult) {
                                // Handle images
                                if (vendorResult.images) {
                                    results.push({ field: 'images', value: vendorResult.images, successfulSelector: null });
                                }
                                
                                // Handle main_image if not already covered by selectors
                                if (vendorResult.main_image && (!selectors.main_image || !Array.isArray(selectors.main_image) || selectors.main_image.length === 0)) {
                                    results.push({ field: 'main_image', value: vendorResult.main_image, successfulSelector: null });
                                }
                                
                                // Handle custom vendor fields
                                const customFieldNames = Object.keys(getVendorCustomFields(vendor));
                                for (const fieldName of customFieldNames) {
                                    if (vendorResult[fieldName] !== undefined && vendorResult[fieldName] !== null && vendorResult[fieldName] !== '') {
                                        results.push({ field: fieldName, value: vendorResult[fieldName], successfulSelector: null });
                                    }
                                }
                            }
                            
                            return results;
                        })
                        .catch(() => [])
                );
            }
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
            const vendorData = loadVendorSelectors()[vendor];
            const needsUpdate = Object.entries(successfulSelectors).some(([field, selector]) => {
                if (!vendorData || !vendorData.selectors || !Array.isArray(vendorData.selectors[field])) {
                    return true; // New selector, needs update
                }
                const existing = vendorData.selectors[field].find(s => s.selector === selector);
                return !existing || existing.success_count < 10;
            });
            
            if (needsUpdate) {
                saveVendorSelectors(vendor, successfulSelectors);
            }
        }
        
        return Object.keys(result).length > 1 ? result : null; // Return null if only product_url is set
    } catch { 
        return null;
    }
}
 

async function extractGeneric(page, urlObj) {
	const url = urlObj.url;
	const vendor = urlObj.vendor || 'vendor'; // Use vendor from urlObj, fallback to 'vendor'
 
	// Generate metadata for this extraction
	const hash = crypto.createHash('sha1').update(`${vendor}|${url}`).digest('hex');
	const uuid = `${vendor}_${hash}`;
	const metadata = { uuid, vendor, source_url: url, extracted_at: new Date().toISOString() };
	
	// Check URL result cache first (skip for dynamic fields that change frequently)
	const cacheKey = `${vendor}:${url}`;
	const cachedResult = cacheManager.get('urlResults', cacheKey);
	if (cachedResult && !process.env.DISABLE_URL_CACHE) {
		const age = Date.now() - new Date(cachedResult.extracted_at).getTime();
		const maxAge = Number(process.env.URL_CACHE_MAX_AGE_HOURS || 24) * 60 * 60 * 1000; // Default 24 hours
		
		if (age < maxAge) {
			console.log(`[URL_CACHE] Using cached result for ${url} (age: ${Math.floor(age / 60000)}min)`);
			// Update dynamic fields that may have changed
			return {
				...cachedResult,
				extracted_at: new Date().toISOString(), // Update timestamp
				stock_status: '', // Clear dynamic field - will be re-extracted if needed
			};
		}
	}

	// First try direct selector extraction (no LLM) if available
	const direct =  await tryExtractWithVendorSelectors(page, vendor, url);
	
	// Build dynamic schema for only the fields we need from LLM
	// Start with base field definitions
	const baseFieldDefinitions = {
		name: z.string().describe('The exact product name shown on the page'),
		main_image: z.string().url().describe('Direct URL to the primary/hero product image starting with http:// or https:// (return empty string if no valid image URL found)'),
		images: z.array(z.string()).describe(`Gallery of product images. Array of ALL product image URLs starting with http:// or https://. (return empty string if no valid image URL found)`),
		price: z.string().describe('Displayed price text, including currency symbol if shown'),
		stock_status: z.string().describe('Stock availability status: "In stock" or "Out of stock"'),
		weight: z.string().describe('Pack size/weight/volume text if available, e.g., 500g or 2x100ml'),
		description: z.string().describe('Primary product description or details shown on the page'),
		category: z.string().describe('Primary product category or breadcrumb category text shown on the page'),
		discount: z.string().describe('Displayed discount or promotion text (e.g., 10% off or £5 off) if available'),
	};
	
	// Merge with vendor-specific custom fields
	const vendorCustomFields = getVendorCustomFields(vendor);
	const fieldDefinitions = { ...baseFieldDefinitions, ...vendorCustomFields };

	// Derive all fields from fieldDefinitions to eliminate maintenance errors
	const allFields = Object.keys(fieldDefinitions);
    
	// Define dynamic fields that should always use LLM (never learn selectors)
	// Note: 'images' is now handled by vendor-specific strategies when available
	const dynamicFields = [];
	
	// Check if we have core fields and if there are any missing fields
	const hasCore = hasValidCoreData(direct);
	const missingFields = [];
	
	if (hasCore) {
		const vendorData = loadVendorSelectors()[vendor] || {};
		const lastSnapshot = vendorData.last_llm_extraction;
		const now = new Date();
		const isSnapshotFresh = lastSnapshot && 
			(now - new Date(lastSnapshot.timestamp)) < (process.env.SMART_CACHE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000); // 7 days freshness
		
		// Log what direct extraction found
		const directFieldsFound = Object.keys(direct || {}).filter(key => direct[key] !== undefined && direct[key] !== null && direct[key] !== '');
		console.log(`[DIRECT_EXTRACTION] Direct extraction found fields: ${directFieldsFound.join(', ')}`);
		
		// Check which fields are missing or empty from direct extraction
		for (const field of allFields) {
             
			const value = direct[field];
			const isMissingFromDirect = !value || (typeof value === 'string' && value.trim() === '');
			const isDynamicField = dynamicFields.includes(field);
			
			
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
						console.log(`[SMART_CACHE] Skipping ${field} - recently confirmed as unavailable (${lastSnapshot.timestamp})`);
					}
				}
			}
		}
		
		// If all important fields are present or recently confirmed unavailable, use direct result
		if (missingFields.length === 0) {
			const result = { ...metadata, ...applyImageFallback(direct, urlObj) };
			return result;
		}
		
		console.log(`[LEARNING] Extracting ${missingFields.join(', ')} missing fields via LLM out of ${allFields.length} fields`);
	}


	// Determine which fields to extract via LLM
	let fieldsForLLM = Object.keys(fieldDefinitions);
	
	// Build dynamic instruction including custom vendor fields
	const baseInstruction = "Extract the product's name, primary image URL, displayed price, all product image URLs, stock status, pack size/weight, category, any discount information, and a concise description";
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
	
	if (hasCore && missingFields.length > 0) {
		// Only extract missing fields via LLM
		fieldsForLLM = missingFields.filter(field => fieldDefinitions[field]);
		const fieldNames = fieldsForLLM.map(field => {
			// First check base field mappings
			switch(field) {
				case 'main_image': return 'primary image URL';
				case 'images': return 'all product image URLs';
				case 'stock_status': return 'stock status';
				case 'weight': return 'pack size/weight';
				case 'description': return 'description';
				case 'category': return 'category';
				case 'discount': return 'discount information';
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

	// Build dynamic schema with only needed fields
	const schemaFields = {};
	for (const field of fieldsForLLM) {
		if (fieldDefinitions[field]) {
			schemaFields[field] = fieldDefinitions[field];
		}
	}
	const schema = z.object(schemaFields);


    const extractedData = await page.extract({
		instruction,
        schema,
        domSettleTimeoutMs: 10000,
	});

	// Create defaults based on field definitions to maintain consistency
	const extractedDefaults = {};
	for (const field of allFields) {
		const fieldDef = fieldDefinitions[field];
		if (fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodArray') {
			extractedDefaults[field] = [];
		} else {
			extractedDefaults[field] = '';
		}
	}
	
	// Merge extracted data with defaults
	const normalizedData = { ...extractedDefaults, ...extractedData };
	
	// Extract base fields (backward compatibility)
	const { name, main_image, price, stock_status, weight, description, category, discount } = normalizedData;
	
	// Extract all custom fields dynamically
	const customFieldData = {};
	const extractedCustomFieldNames = Object.keys(getVendorCustomFields(vendor));
	for (const fieldName of extractedCustomFieldNames) {
		if (normalizedData[fieldName] !== undefined) {
			customFieldData[fieldName] = normalizedData[fieldName];
		}
	}

    // temp fix for now - override images with empty array
    let images = []

	// Normalize and validate image URLs
	// Handle case where LLM returns element IDs instead of URLs for images array
	let imagesList = [];
	if (Array.isArray(images)) {
		// Filter out element IDs and non-URL strings, then clean/validate URLs
		imagesList = images
			.filter(img => typeof img === 'string' && img.trim() !== '')
			.filter(img => {
				// Remove common element ID patterns and non-URL strings
				if (/^[0-9]+$/.test(img)) return false; // Pure numbers like "16740"
				if (/^[0-9]+-[0-9]+$/.test(img)) return false; // Pattern like "0-78", "17188-17188"
				if (img.length < 10) return false; // Too short to be a valid URL
				return true;
			})
			.map(cleanAndValidateUrl) // Clean and validate URLs (handles @ prefixes)
			.filter(Boolean); // Keep only valid URLs
	}
	
	let mainImage = cleanAndValidateUrl(main_image) || '';
	if (!mainImage && imagesList.length > 0) {
		mainImage = imagesList[0];
	}
	// Ensure list includes mainImage and contains only valid, unique URLs
	if (mainImage) imagesList.unshift(mainImage);
	imagesList = Array.from(new Set(imagesList.filter(Boolean)));

	// Create LLM extracted product data (including custom fields)
	const llmProduct = {
		product_id: urlObj.sku, 
		name, 
		main_image: mainImage, 
		images: imagesList, 
		price, 
		stock_status, 
		weight, 
		description, 
		category, 
		discount, 
		product_url: url,
		...customFieldData  // Include any custom vendor fields
	};
	
	// Merge direct extraction results with LLM results (prioritize direct when available)
	let finalProduct = llmProduct;
	if (hasCore && direct) {
		finalProduct = {
			...llmProduct, // Start with LLM results as base
			...direct,     // Overlay direct results (they take priority when present)
			// Use direct result for main_image if available, otherwise use LLM result
			main_image: direct.main_image || mainImage,
			images: imagesList, // Always use LLM results for images array as it's better processed
			product_url: url // Ensure URL is always set
		};
		 
	}
	
	const result = { ...metadata, ...finalProduct };
	
	// Apply image fallback if urlObj is provided (from sitemap data)
	const finalResult = applyImageFallback(result, urlObj);
	
	// Update extraction snapshot (track what LLM attempted and found)
	if (fieldsForLLM.length > 0) {
		updateExtractionSnapshot(vendor, fieldsForLLM, llmProduct);
	}
	
	// Report fields that need selector learning (adaptive learning)
	if (hasCore && missingFields.length > 0) {
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
			console.log(`[LEARNING] Reporting fields needing learning: ${fieldsToReport.join(', ')}`);
			console.log(`[LEARNING] These fields were missing from direct extraction and found by LLM`);
			selectorLearning.reportFieldsNeedingLearning(vendor, fieldsToReport);
		}
	} else {
		// Full extraction - report all non-dynamic fields for learning
		const nonDynamicFields = Object.keys(finalResult).filter(field => !dynamicFields.includes(field));
		const fieldsWithValues = nonDynamicFields.filter(field => {
			const value = finalResult[field];
			return value && (typeof value !== 'string' || value.trim() !== '');
		});
		
		if (fieldsWithValues.length > 0) {
			console.log(`[LEARNING] Reporting all non-dynamic fields for learning: ${fieldsWithValues.join(', ')}`);
			selectorLearning.reportFieldsNeedingLearning(vendor, fieldsWithValues);
		}
	}
	
	// Cache the result for future use (avoid caching if extraction failed or has errors)
	if (hasValidCoreData(finalResult) && !process.env.DISABLE_URL_CACHE) {
		cacheManager.set('urlResults', cacheKey, finalResult);
		console.log(`[URL_CACHE] Cached extraction result for ${urlObj.sku || "url"}`);
	}
	
	return finalResult;
}

module.exports = { extractGeneric };
