'use strict';

const { z } = require('zod');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');





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
    try {
        if (typeof value !== 'string') return null;
        let cleaned = value.trim();
        if (!cleaned) return null;
        
        // Remove @ prefixes that can get added during extraction
        if (cleaned.startsWith('@')) {
            cleaned = cleaned.substring(1);
        }
        
        // Remove other common prefixes that might get mixed in
        cleaned = cleaned.replace(/^[^\w]*([a-zA-Z]*:\/\/)/, '$1');
        
        // Exclude non-URL protocols
        if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(cleaned)) return null;
        
        // Try to parse as URL
        const u = new URL(cleaned);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            return cleaned;
        }
        return null;
    } catch {
        return null;
    }
}

function isValidHttpUrl(value) {
    return cleanAndValidateUrl(value) !== null;
}

function loadVendorSelectors() {
    try {
        const p = path.resolve(process.cwd(), 'vendor-selectors.json');
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch { return {}; }
}

function saveVendorSelectors(vendor, partial) {
    try {
        const p = path.resolve(process.cwd(), 'vendor-selectors.json');
        const all = loadVendorSelectors();
        const prev = all[vendor] || {};
        const next = { ...prev, ...partial };
        all[vendor] = next;
        fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
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
    // Only learn selectors for stable, static fields
    // Dynamic fields (images, main_image, stock_status) will always use LLM
    const fieldsToLearn = ['name', 'price', 'weight', 'description', 'category', 'discount'];
    
     
    
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
            const observePrompt = `Find the specific element on this page that contains the text "${value}". I need to locate this element for data extraction.`;
            
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
                        const testText = await page.locator(selector).first().innerText({ timeout: 5000 });
                        if (testText && (testText.includes(value) || value.includes(testText))) {
                            return { field, selector, method: 'observe' };
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

	// First try vendor selector shortcuts (no LLM) if configured
	const direct = await tryExtractWithVendorSelectors(page, vendor, url);
	
	// Build dynamic schema for only the fields we need from LLM
	const fieldDefinitions = {
		name: z.string().describe('The exact product name shown on the page'),
		main_image: z.string().url().describe('Direct URL to the primary/hero product image'),
		images: z.array(z.string().url()).describe('All product image URLs'),
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
	const dynamicFields = ['images', 'main_image', 'stock_status'];
	
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
		
		console.log(`[LEARNING] Extracting ${missingFields.length} missing fields via LLM out of ${allFields.length} fields`);
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
		// Filter out element IDs (pattern: "0-78", "17188-17188") and clean/validate URLs
		imagesList = images
			.filter(img => typeof img === 'string' && img.trim() !== '')
			.filter(img => !(/^[0-9]+-[0-9]+$/.test(img))) // Remove element IDs
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
			// Always use LLM results for images as they're better processed
			main_image: mainImage,
			images: imagesList,
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
	
	return finalResult;
}

module.exports = { extractGeneric };
