'use strict';

const { z } = require('zod');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cacheManager = require('../utils/cacheManager');

// Import vendor-specific strategies
const vendorStrategies = {
    superdrug: require('./superdrug')  // Match the vendor key used in index.js
};





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

function loadVendorSelectors() {
    try {
        const p = path.resolve(process.cwd(), 'vendor-selectors.json');
        const stats = fs.statSync(p);
        const lastModified = stats.mtime.getTime();
        
        // Use cached version if file hasn't changed
        const cachedSelectors = cacheManager.get('vendorSelectors');
        const cachedModifiedTime = cacheManager.get('vendorSelectorsLastModified');
        
        if (cachedSelectors && cachedModifiedTime === lastModified) {
            return cachedSelectors;
        }
        
        // Read and cache the file
        const data = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
        cacheManager.set('vendorSelectors', null, data);
        cacheManager.set('vendorSelectorsLastModified', null, lastModified);
        return data;
    } catch { 
        // Cache empty result to avoid repeated file system calls
        const cachedSelectors = cacheManager.get('vendorSelectors');
        if (!cachedSelectors) {
            cacheManager.set('vendorSelectors', null, {});
            cacheManager.set('vendorSelectorsLastModified', null, 0);
        }
        return {}; 
    }
}

function saveVendorSelectors(vendor, partial) {
    try {
        const p = path.resolve(process.cwd(), 'vendor-selectors.json');
        const all = loadVendorSelectors();
        const prev = all[vendor] || {};
        const next = { ...prev, ...partial };
        all[vendor] = next;
        fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
        
        // Update cache since file changed
        cacheManager.set('vendorSelectors', null, all);
        cacheManager.set('vendorSelectorsLastModified', null, Date.now());
    } catch {}
}

function updateExtractionSnapshot(vendor, attemptedFields, extractedData) {
    try {
        const p = path.resolve(process.cwd(), 'vendor-selectors.json');
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

async function learnAndCacheSelectors(page, vendor, item) {
    // Only attempt when we have some values to learn from
    if (!item || typeof item !== 'object') return;
    const existing = loadVendorSelectors()[vendor];
    
    const learned = {};
    // Learn selectors for static fields, main_image, and stock_status (which often has consistent patterns)
    // Truly dynamic fields (images array) will always use LLM
    const fieldsToLearn = ['name', 'price', 'main_image', 'weight', 'description', 'category', 'discount', 'stock_status'];
    
     
    
    // Prepare fields that need learning
    const fieldsToProcess = fieldsToLearn.filter(field => {
        if (existing && existing[field]) return false; // Skip if already have selector
        const value = String(item[field] || '').trim();
        return !!value; // Only include fields with values
    });
    
    if (fieldsToProcess.length === 0) return;
    
    // First, try page.observe() for all fields in parallel
    const observePromises = fieldsToProcess.map(async (field) => {
        const value = String(item[field] || '').trim();
        
        try {
            let observePrompt;
            if (field === 'main_image') {
                observePrompt = `Find the main product image element on this page. I need to locate the primary product image for data extraction.`;
            } else if (field === 'stock_status') {
                if (value && value.toLowerCase().includes('out of stock')) {
                    observePrompt = `Find the "out of stock" button, text, or element on this page that indicates the product is unavailable. Look for elements with text like "out of stock", "sold out", "unavailable", or disabled purchase buttons.`;
                } else {
                    // Skip learning for "in stock" since it's usually indicated by absence of out-of-stock element
                    return { field, selector: null, method: 'observe' };
                }
            } else {
                observePrompt = `Find the specific element on this page that contains the text "${value}". I need to locate this element for data extraction.`;
            }
            
            const observation = await page.observe(observePrompt, { timeout: 5000 });
            
            if (observation && Array.isArray(observation) && observation.length > 0) {
                const element = observation[0];
                let selector = null;
                
                // Extract selector from observation
                if (element.selector) {
                    // Check if it's an XPath or CSS selector
                    if (element.selector.startsWith('xpath=')) {
                        // Use XPath directly (Playwright supports XPath)
                        selector = element.selector;
                    } else {
                        // Use as CSS selector
                        selector = element.selector;
                    }
                } else if (element.arguments && element.arguments.length > 0) {
                    // Try to extract CSS selector from arguments
                    const arg = element.arguments[0];
                    if (typeof arg === 'string' && !arg.startsWith('xpath=')) {
                        selector = arg;
                    }
                }
                
                if (selector) {
                    // Validate the observed selector
                    try {
                        if (field === 'main_image') {
                            // For main_image, validate by checking src attribute
                            const testSrc = await page.locator(selector).first().getAttribute('src', { timeout: 5000 });
                            if (testSrc) {
                                // Be more lenient with image URL matching - extract filename/path components
                                const valueFileName = value.split('/').pop()?.split('?')[0] || '';
                                const testFileName = testSrc.split('/').pop()?.split('?')[0] || '';
                                if (valueFileName && testFileName && 
                                    (testSrc.includes(valueFileName) || value.includes(testFileName) || 
                                     valueFileName === testFileName)) {
                                    return { field, selector, method: 'observe' };
                                }
                            }
                        } else if (field === 'stock_status') {
                            // For stock_status, check if the element exists and contains out-of-stock indicators
                            const testText = await page.locator(selector).first().innerText({ timeout: 5000 });
                            const isOutOfStock = /out of stock|sold out|unavailable|not available/i.test(testText);
                            if (isOutOfStock) {
                                return { field, selector, method: 'observe' };
                            }
                        } else {
                            // For text fields, validate by checking inner text
                            const testText = await page.locator(selector).first().innerText({ timeout: 5000 });
                            if (testText && (testText.includes(value) || value.includes(testText))) {
                                return { field, selector, method: 'observe' };
                            }
                        }
                    } catch (validationError) {
                        // Observation failed validation
                    }
                }
            }
        } catch (observeError) {
            // page.observe failed
        }
        
        return { field, selector: null, method: 'observe' };
    });
    
    // Wait for all observations to complete in parallel
    const observeResults = await Promise.all(observePromises);
    
    // Apply successful observations
    for (const result of observeResults) {
        if (result.selector) {
            learned[result.field] = result.selector;
        }
    }
    
    if (Object.keys(learned).length > 0) {
        saveVendorSelectors(vendor, learned);
    }
}

async function tryExtractWithVendorSelectors(page, vendor, url) {
	 
    try {
        const all = loadVendorSelectors();
        const sel = all[vendor];
        if (!sel) return null;
        
        const result = { product_url: url };
        
        // Extract all fields in parallel for much better performance
        const extractionPromises = [];
        
        if (sel.name) {
            extractionPromises.push(
                page.locator(sel.name).first().innerText({ timeout: 10000 })
                    .then(val => ({ field: 'name', value: val.trim() }))
                    .catch(() => ({ field: 'name', value: null }))
            );
        }
        
        if (sel.price) {
            extractionPromises.push(
                page.locator(sel.price).first().innerText({ timeout: 10000 })
                    .then(val => ({ field: 'price', value: val.trim() }))
                    .catch(() => ({ field: 'price', value: null }))
            );
        }
        
       
        
        if (sel.weight) {
            extractionPromises.push(
                page.locator(sel.weight).first().innerText({ timeout: 10000 })
                    .then(val => ({ field: 'weight', value: val.trim() }))
                    .catch(() => ({ field: 'weight', value: null }))
            );
        }
        
        if (sel.description) {
            extractionPromises.push(
                page.locator(sel.description).first().innerText({ timeout: 10000 })
                    .then(val => ({ field: 'description', value: val.trim() }))
                    .catch(() => ({ field: 'description', value: null }))
            );
        }
        
        if (sel.category) {
            extractionPromises.push(
                page.locator(sel.category).first().innerText({ timeout: 10000 })
                    .then(val => ({ field: 'category', value: val.trim() }))
                    .catch(() => ({ field: 'category', value: null }))
            );
        }
        
        if (sel.discount) {
            extractionPromises.push(
                page.locator(sel.discount).first().innerText({ timeout: 10000 })
                    .then(val => ({ field: 'discount', value: val.trim() }))
                    .catch(() => ({ field: 'discount', value: null }))
            );
        }
        
        if (sel.main_image) {
            extractionPromises.push(
                page.locator(sel.main_image).first().getAttribute('src', { timeout: 10000 })
                    .then(val => {
                        const cleanedUrl = val ? cleanAndValidateUrl(val.trim()) : null;
                        return { field: 'main_image', value: cleanedUrl };
                    })
                    .catch(() => ({ field: 'main_image', value: null }))
            );
        }
        
        if (sel.stock_status) {
            extractionPromises.push(
                page.locator(sel.stock_status).first().isVisible({ timeout: 10000 })
                    .then(isVisible => {
                        if (isVisible) {
                            // Element is visible, check if it indicates out of stock
                            return page.locator(sel.stock_status).first().innerText({ timeout: 5000 })
                                .then(text => {
                                    const isOutOfStock = /out of stock|sold out|unavailable|not available/i.test(text);
                                    return { field: 'stock_status', value: isOutOfStock ? 'Out of stock' : 'In stock' };
                                })
                                .catch(() => ({ field: 'stock_status', value: 'Out of stock' })); // Assume out of stock if element exists but can't read text
                        } else {
                            // Element not visible = in stock
                            return { field: 'stock_status', value: 'In stock' };
                        }
                    })
                    .catch(() => {
                        // Element doesn't exist = in stock
                        return { field: 'stock_status', value: 'In stock' };
                    })
            );
        }
        
        // Extract images using vendor-specific strategy if available
        if (vendorStrategies[vendor]) {
            const strategy = vendorStrategies[vendor];
            // Use the appropriate extraction function based on vendor
            let extractFunction = null;
            if (vendor === 'superdrug' && strategy.extractSuperdrugProduct) {
                extractFunction = strategy.extractSuperdrugProduct;
            }
            // Add more vendor-specific extraction functions here as needed
            
            if (extractFunction) {
                extractionPromises.push(
                    extractFunction(page, { url, vendor })
                        .then(vendorResult => {
                            if (vendorResult && vendorResult.images) {
                                return { field: 'images', value: vendorResult.images };
                            }
                            return { field: 'images', value: [] };
                        })
                        .catch(() => ({ field: 'images', value: [] }))
                );
                
                // Also extract main_image from vendor strategy if not already extracted by selectors
                if (!sel.main_image) {
                    extractionPromises.push(
                        extractFunction(page, { url, vendor })
                            .then(vendorResult => {
                                if (vendorResult && vendorResult.main_image) {
                                    return { field: 'main_image', value: vendorResult.main_image };
                                }
                                return { field: 'main_image', value: null };
                            })
                            .catch(() => ({ field: 'main_image', value: null }))
                    );
                }
            }
        }
      
        // Wait for all extractions to complete in parallel
        const results = await Promise.all(extractionPromises);
        
        // Apply results to the result object
        for (const { field, value } of results) {
            if (value !== null) {
                result[field] = value;
            }
        }
        
        return result;
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
	const fieldDefinitions = {
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

	// Derive all fields from fieldDefinitions to eliminate maintenance errors
	const allFields = Object.keys(fieldDefinitions);
    
	// Define dynamic fields that should always use LLM (never learn selectors)
	// Note: 'images' is now handled by vendor-specific strategies when available
	const dynamicFields = [];
	
	// Check if we have core fields and if there are any missing fields
	const hasCore = direct && direct.name && direct.price;
	const missingFields = [];
	
	if (hasCore) {
		const vendorData = loadVendorSelectors()[vendor] || {};
		const lastSnapshot = vendorData.last_llm_extraction;
		const now = new Date();
		const isSnapshotFresh = lastSnapshot && 
			(now - new Date(lastSnapshot.timestamp)) < (process.env.SMART_CACHE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000); // 7 days freshness
		
		
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
	let instruction = "Extract the product's name, primary image URL, displayed price, all product image URLs, stock status, pack size/weight, category, any discount information, and a concise description.";
	
	if (hasCore && missingFields.length > 0) {
		// Only extract missing fields via LLM
		fieldsForLLM = missingFields.filter(field => fieldDefinitions[field]);
		const fieldNames = fieldsForLLM.map(field => {
			switch(field) {
				case 'main_image': return 'primary image URL';
				case 'images': return 'all product image URLs';
				case 'stock_status': return 'stock status';
				case 'weight': return 'pack size/weight';
				case 'description': return 'description';
				case 'category': return 'category';
				case 'discount': return 'discount information';
				default: return field;
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
		extractedDefaults[field] = field === 'images' ? [] : '';
	}
	
	// Merge extracted data with defaults
	const normalizedData = { ...extractedDefaults, ...extractedData };
	const { name, main_image, images, price, stock_status, weight, description, category, discount } = normalizedData;


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

	// Create LLM extracted product data
	const llmProduct = {product_id: urlObj.sku, name, main_image: mainImage, images: imagesList, price, stock_status, weight, description, category, discount, product_url: url };
	
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
	
	// Learn selectors for newly extracted fields (adaptive learning)
	if (hasCore && missingFields.length > 0) {
		// Only learn selectors for non-dynamic fields that were missing from direct extraction
		const fieldsToLearn = {};
		for (const field of missingFields) {
			// Skip dynamic fields - they should always use LLM
			if (dynamicFields.includes(field)) {
				continue;
			}
			
			const value = finalResult[field];
			if (value && (typeof value !== 'string' || value.trim() !== '')) {
				fieldsToLearn[field] = value;
			}
		}
		
		if (Object.keys(fieldsToLearn).length > 0) {
			console.log(`[LEARNING] Learning selectors for newly extracted fields: ${Object.keys(fieldsToLearn).join(', ')}`);
			try { 
				await learnAndCacheSelectors(page, vendor, fieldsToLearn); 
			} catch (error) {
				console.log(`[LEARNING] Selector learning failed: ${error.message}`);
			}
		}
	} else {
		// Full extraction - learn selectors for non-dynamic fields only
		const nonDynamicResult = { ...finalResult };
		dynamicFields.forEach(field => delete nonDynamicResult[field]);
		try { 
			await learnAndCacheSelectors(page, vendor, nonDynamicResult); 
		} catch (error) {
			console.log(`[LEARNING] Full selector learning failed: ${error.message}`);
		}
	}
	
	// Cache the result for future use (avoid caching if extraction failed or has errors)
	if (finalResult && finalResult.name && finalResult.price && !process.env.DISABLE_URL_CACHE) {
		cacheManager.set('urlResults', cacheKey, finalResult);
		console.log(`[URL_CACHE] Cached extraction result for ${url}`);
	}
	
	return finalResult;
}

module.exports = { extractGeneric };
