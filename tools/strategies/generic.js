'use strict';

const { z } = require('zod');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cacheManager = require('../utils/cache/cacheManager');

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
        const p = path.resolve(process.cwd(), 'tools/utils/cache/vendor-selectors.json');
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
        const p = path.resolve(process.cwd(), 'tools/utils/cache/vendor-selectors.json');
        const all = loadVendorSelectors();
        const prev = all[vendor] || {};
        
        // Handle both old format (direct fields) and new format (selectors array)
        if (partial.selectors) {
            // New format: append to selector arrays instead of overriding
            if (!prev.selectors) prev.selectors = {};
            
            for (const [field, newSelector] of Object.entries(partial.selectors)) {
                // Initialize field array if it doesn't exist
                if (!prev.selectors[field]) {
                    prev.selectors[field] = [];
                } else if (!Array.isArray(prev.selectors[field])) {
                    // Convert non-array to array format
                    console.log(`[SELECTOR-SAVE] Converting ${vendor}.${field} from string to array format`);
                    const oldSelector = prev.selectors[field];
                    prev.selectors[field] = [{
                        selector: typeof oldSelector === 'string' ? oldSelector : oldSelector.selector || oldSelector,
                        type: (typeof oldSelector === 'string' ? oldSelector : oldSelector.selector || oldSelector).startsWith('xpath=') ? 'xpath' : 'css',
                        learned_at: new Date().toISOString(),
                        success_count: 0,
                        failure_count: 0,
                        last_success: null,
                        last_failure: null,
                        confidence_score: 1.0
                    }];
                }
                
                // Check if this selector already exists
                const selectorString = typeof newSelector === 'string' ? newSelector : newSelector.selector;
                const existingIndex = prev.selectors[field].findIndex(s => 
                    (s.selector || s) === selectorString
                );
                
                if (existingIndex >= 0) {
                    // Update existing selector
                    if (typeof newSelector === 'object') {
                        prev.selectors[field][existingIndex] = { ...prev.selectors[field][existingIndex], ...newSelector };
                    }
                } else {
                    // Add new selector
                    const selectorObj = typeof newSelector === 'string' ? {
                        selector: newSelector,
                        type: newSelector.startsWith('xpath=') ? 'xpath' : 'css',
                        learned_at: new Date().toISOString(),
                        success_count: 0,
                        failure_count: 0,
                        last_success: null,
                        last_failure: null,
                        confidence_score: 1.0
                    } : newSelector;
                    
                    prev.selectors[field].push(selectorObj);
                    console.log(`[SELECTOR-HISTORY] Added new ${field} selector for ${vendor}: ${selectorString}`);
                }
            }
            
            all[vendor] = { ...prev, ...partial };
        } else {
            // Old format: convert to new format
            const selectorsToAdd = {};
            for (const [field, selector] of Object.entries(partial)) {
                if (field !== 'last_llm_extraction') {
                    selectorsToAdd[field] = selector;
                }
            }
            
            if (Object.keys(selectorsToAdd).length > 0) {
                saveVendorSelectors(vendor, { selectors: selectorsToAdd });
                return;
            }
            
            all[vendor] = { ...prev, ...partial };
        }
        
        fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
        
        // Update cache since file changed
        cacheManager.set('vendorSelectors', null, all);
        cacheManager.set('vendorSelectorsLastModified', null, Date.now());
    } catch (error) {
        console.log(`[SELECTOR-SAVE] Failed to save vendor selectors: ${error.message}`);
    }
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
        const vendorData = all[vendor];
        if (!vendorData) return null;
        
        // Support both old format (direct selectors) and new format (selector arrays)
        const selectors = vendorData.selectors || vendorData; // New format has 'selectors' key
        if (!selectors) return null;
        
        const result = { product_url: url };
        
        // Extract all fields in parallel for much better performance
        const extractionPromises = [];
        
        // Helper function to try multiple selectors for a field
        const tryFieldSelectors = async (field, selectorList) => {
            if (!selectorList) return { field, value: null, successfulSelector: null };
            
            // Handle both old format (string) and new format (array)
            const selectors = Array.isArray(selectorList) ? selectorList : [{ selector: selectorList, confidence_score: 1.0 }];
            
            // Sort by confidence score (highest first)
            const sortedSelectors = selectors.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0));
            
            for (const selectorObj of sortedSelectors) {
                const selectorString = selectorObj.selector || selectorObj;
                try {
                    let value;
                    if (field === 'main_image') {
                        value = await page.locator(selectorString).first().getAttribute('src', { timeout: 10000 });
                        value = value ? cleanAndValidateUrl(value.trim()) : null;
                    } else if (field === 'stock_status') {
                        const isVisible = await page.locator(selectorString).first().isVisible({ timeout: 10000 });
                        if (isVisible) {
                            const text = await page.locator(selectorString).first().innerText({ timeout: 5000 });
                            const isOutOfStock = /out of stock|sold out|unavailable|not available/i.test(text);
                            value = isOutOfStock ? 'Out of stock' : 'In stock';
                        } else {
                            value = 'In stock';
                        }
                    } else {
                        value = await page.locator(selectorString).first().innerText({ timeout: 10000 });
                        value = value ? value.trim() : null;
                    }
                    
                    if (value) {
                        // Success! Update statistics and return
                        await updateSelectorStatistics(vendor, field, selectorObj, true);
                        return { field, value, successfulSelector: selectorObj };
                    }
                } catch (error) {
                    // This selector failed, try the next one
                    await updateSelectorStatistics(vendor, field, selectorObj, false);
                    continue;
                }
            }
            
            return { field, value: null, successfulSelector: null };
        };
        
        // Extract all standard fields using the new multi-selector approach
        const fieldNames = ['name', 'price', 'weight', 'description', 'category', 'discount', 'main_image', 'stock_status'];
        
        for (const field of fieldNames) {
            const selectorList = selectors[field];
            if (selectorList) {
                extractionPromises.push(tryFieldSelectors(field, selectorList));
            }
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
                if (!selectors.main_image) {
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
        for (const result of results) {
            if (result && result.field && result.value !== null) {
                result[result.field] = result.value;
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
		console.log(`[URL_CACHE] Cached extraction result for ${urlObj.sku || "url"}`);
	}
	
	return finalResult;
}

// Update selector statistics and confidence scores
async function updateSelectorStatistics(vendor, field, selectorObj, success) {
    try {
        const all = loadVendorSelectors();
        if (!all[vendor]) return;
        
        // Handle both old format (direct selectors) and new format (selector arrays)
        let selectors;
        if (all[vendor].selectors && all[vendor].selectors[field]) {
            // New format: array of selector objects
            selectors = all[vendor].selectors[field];
            if (!Array.isArray(selectors)) {
                console.log(`[SELECTOR-STATS] Warning: ${vendor}.${field} selectors is not an array, converting...`);
                // Convert single selector to array format
                const singleSelector = typeof selectors === 'string' ? selectors : selectors.selector;
                selectors = [{
                    selector: singleSelector,
                    type: singleSelector.startsWith('xpath=') ? 'xpath' : 'css',
                    learned_at: new Date().toISOString(),
                    success_count: 0,
                    failure_count: 0,
                    last_success: null,
                    last_failure: null,
                    confidence_score: 1.0
                }];
                all[vendor].selectors[field] = selectors;
            }
        } else if (all[vendor][field]) {
            // Old format: direct field with selector string
            console.log(`[SELECTOR-STATS] Converting old format ${vendor}.${field} to new format`);
            const oldSelector = all[vendor][field];
            selectors = [{
                selector: oldSelector,
                type: oldSelector.startsWith('xpath=') ? 'xpath' : 'css',
                learned_at: new Date().toISOString(),
                success_count: 0,
                failure_count: 0,
                last_success: null,
                last_failure: null,
                confidence_score: 1.0
            }];
            
            // Migrate to new format
            if (!all[vendor].selectors) all[vendor].selectors = {};
            all[vendor].selectors[field] = selectors;
            delete all[vendor][field]; // Remove old format field
        } else {
            // No selectors found for this field
            return;
        }
        
        const selectorString = selectorObj.selector || selectorObj;
        const selectorIndex = selectors.findIndex(s => s.selector === selectorString);
        
        if (selectorIndex >= 0) {
            const selector = selectors[selectorIndex];
            const now = new Date().toISOString();
            
            if (success) {
                selector.success_count = (selector.success_count || 0) + 1;
                selector.last_success = now;
                console.log(`[SELECTOR-STATS] ${vendor}.${field} selector success (${selector.success_count} total)`);
            } else {
                selector.failure_count = (selector.failure_count || 0) + 1;
                selector.last_failure = now;
                console.log(`[SELECTOR-STATS] ${vendor}.${field} selector failed (${selector.failure_count} total failures)`);
            }
            
            // Calculate confidence score (success rate with recency bias)
            const totalAttempts = selector.success_count + selector.failure_count;
            const baseConfidence = totalAttempts > 0 ? selector.success_count / totalAttempts : 0.5;
            
            // Add recency bias - recent successes get higher confidence
            const daysSinceLastSuccess = selector.last_success ? 
                (new Date() - new Date(selector.last_success)) / (1000 * 60 * 60 * 24) : 365;
            const recencyBonus = Math.max(0, 0.2 - (daysSinceLastSuccess * 0.01)); // Bonus decreases over time
            
            selector.confidence_score = Math.min(1.0, baseConfidence + recencyBonus);
            
            // Save the updated statistics
            const p = path.resolve(process.cwd(), 'tools/utils/cache/vendor-selectors.json');
            fs.writeFileSync(p, JSON.stringify(all, null, 2));
            
            // Update cache
            cacheManager.set('vendorSelectors', null, all);
            cacheManager.set('vendorSelectorsLastModified', null, Date.now());
        } else {
            console.log(`[SELECTOR-STATS] Warning: Selector not found in ${vendor}.${field} array: ${selectorString}`);
        }
    } catch (error) {
        console.log(`[SELECTOR-STATS] Failed to update statistics: ${error.message}`);
    }
}

module.exports = { extractGeneric };
