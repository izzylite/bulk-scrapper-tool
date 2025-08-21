'use strict';

const fs = require('fs');
const path = require('path');
const cacheManager = require('./cache/cacheManager');
const { logError, logErrorWithDetails, extractErrorDetails } = require('./logUtil');

// Import vendor-specific strategies for custom fields
const vendorStrategies = {
    superdrug: require('../strategies/superdrug')
};

// Extract custom fields from vendor strategies
function getVendorCustomFields(vendor) {
    const strategy = vendorStrategies[vendor];
    return strategy && strategy.customFields ? strategy.customFields : {};
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
    } catch (error) { 
        // Log selector file load failure
        console.log(`[SELECTOR_LEARNING] Failed to load vendor selectors: ${error.message}`);
        logErrorWithDetails('selector_load_failed', error);
        
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
        
        // Handle backward compatibility with old format (single selectors as strings)
        if (!prev.selectors && Object.keys(prev).some(key => key !== 'last_llm_extraction')) {
            // Convert old format to new format
            const converted = { selectors: {} };
            const now = new Date().toISOString();
            
            for (const [field, selector] of Object.entries(prev)) {
                if (field !== 'last_llm_extraction' && typeof selector === 'string') {
                    converted.selectors[field] = [{
                        selector,
                        learned_at: now,
                        success_count: 1,
                        last_success: now
                    }];
                }
            }
            
            // Preserve last_llm_extraction if it exists
            if (prev.last_llm_extraction) {
                converted.last_llm_extraction = prev.last_llm_extraction;
            }
            
            all[vendor] = converted;
        }
        
        const current = all[vendor] || {};
        
        // Normalize existing success_count values that exceed the maximum (cap at 10)
        if (current.selectors) {
            for (const [field, selectorArray] of Object.entries(current.selectors)) {
                if (Array.isArray(selectorArray)) {
                    for (const selectorObj of selectorArray) {
                        if (selectorObj.success_count > 10) {
                            selectorObj.success_count = 10;
                        }
                    }
                }
            }
        }
        
        if (!current.selectors) {
            current.selectors = {};
        }
        
        // Add new selectors to the history
        const now = new Date().toISOString();
        for (const [field, selector] of Object.entries(partial)) {
            if (field === 'last_llm_extraction') {
                // Handle LLM extraction metadata separately
                current[field] = selector;
                continue;
            }
            
            if (typeof selector === 'string' && selector.trim()) {
                if (!current.selectors[field]) {
                    current.selectors[field] = [];
                }
                
                // Check if this selector already exists in the history
                const existingIndex = current.selectors[field].findIndex(s => s.selector === selector);
                
                if (existingIndex >= 0) {
                    // Update existing selector's success count and last success (cap at 10 to prevent overhead)
                    const currentSelector = current.selectors[field][existingIndex];
                    if (currentSelector.success_count < 10) {
                        currentSelector.success_count += 1;
                        currentSelector.last_success = now;
                        
                        // Move successful selector to the front for priority
                        current.selectors[field].splice(existingIndex, 1);
                        current.selectors[field].unshift(currentSelector);
                    }
                    // If success_count is already 10, don't increment or move (avoid unnecessary I/O)
                } else {
                    // Add new selector to the beginning of the array (highest priority)
                    current.selectors[field].unshift({
                        selector,
                        learned_at: now,
                        success_count: 1,
                        last_success: now
                    });
                    
                    // Keep only the most recent 5 selectors per field to prevent unlimited growth
                    if (current.selectors[field].length > 5) {
                        current.selectors[field] = current.selectors[field].slice(0, 5);
                    }
                }
            }
        }
        
        all[vendor] = current;
        fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
        
        // Update cache since file changed
        cacheManager.set('vendorSelectors', null, all);
        cacheManager.set('vendorSelectorsLastModified', null, Date.now());
    } catch (error) {
        // Log selector save failure
        console.log(`[SELECTOR_LEARNING] Failed to save selectors for ${vendor}: ${error.message}`);
        logErrorWithDetails('selector_save_failed', error, { 
            vendor, 
            selectorFields: Object.keys(partial)
        });
    }
}

async function learnAndCacheSelectors(page, vendor, item) {
    // Only attempt when we have some values to learn from
    if (!item || typeof item !== 'object') return;
    const vendorData = loadVendorSelectors()[vendor];
     
    
    const learned = {};
    // Learn selectors for static fields, main_image, and stock_status (which often has consistent patterns)
    // Truly dynamic fields (images array) will always use LLM
    const baseFieldsToLearn = ['name', 'price', 'main_image', 'weight', 'description', 'category', 'discount', 'stock_status'];
    
    // Add custom vendor fields that are suitable for selector learning (non-dynamic fields)
    const customFieldNames = Object.keys(getVendorCustomFields(vendor));
    const customFieldsToLearn = customFieldNames.filter(field => {
        // Only learn selectors for string/boolean fields, not arrays or complex types
        const fieldDef = getVendorCustomFields(vendor)[field];
        return fieldDef && fieldDef._def && (
            fieldDef._def.typeName === 'ZodString' || 
            fieldDef._def.typeName === 'ZodBoolean'
        );
    });
    
   
    
    const fieldsToLearn = [...baseFieldsToLearn, ...customFieldsToLearn];
    
    // Prepare fields that need learning
    const fieldsToProcess = fieldsToLearn.filter(field => {
        // Check if we already have selectors for this field (new array format)
        if (vendorData && vendorData.selectors && Array.isArray(vendorData.selectors[field]) && vendorData.selectors[field].length > 0) {
            return false; // Skip if already have selectors in new format
        }
        
        // Backward compatibility: check old format
        if (vendorData && vendorData[field] && typeof vendorData[field] === 'string') {
            return false; // Skip if already have selector in old format
        }
        
        const value = String(item[field] || '').trim();
        if (!value) {
            return false;
        }
        return true; // Only include fields with values
    });
    
    
    
    if (fieldsToProcess.length === 0) { 
        return;
    }
    console.log(`[SELECTOR_LEARNING] Fields to learn selectors for: ${fieldsToProcess.join(', ')}`);
    // Process fields synchronously one by one instead of in parallel
    const observeResults = [];
    
    for (const field of fieldsToProcess) {
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
                    observeResults.push({ field, selector: null, method: 'observe' });
                    continue;
                }
            } else {
                // Check if this is a custom boolean field
                const customFields = getVendorCustomFields(vendor);
                const fieldDef = customFields[field];
                if (fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodBoolean') {
                    if (value === 'true' || value === true) {
                        const fieldDescription = fieldDef._def.description || field.replace(/_/g, ' ');
                        observePrompt = `Find the element on this page that indicates "${fieldDescription}". Look for relevant text, badges, or indicators.`; 
                    } else {
                        // Skip learning for false boolean values
                        observeResults.push({ field, selector: null, method: 'observe' });
                        continue;
                    }
                } else {
                    observePrompt = `Find the specific element on this page that contains the text "${value}". I need to locate this element for data extraction.`;
                }
            }
             
            const observation = await page.observe(observePrompt, { timeout: 10000 }); // Increased timeout
             
            
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
                                    observeResults.push({ field, selector, method: 'observe' });
                                    continue;
                                }
                            }
                        } else if (field === 'stock_status') {
                            // For stock_status, check if the element exists and contains out-of-stock indicators
                            const testText = await page.locator(selector).first().innerText({ timeout: 5000 });
                            const isOutOfStock = /out of stock|sold out|unavailable|not available/i.test(testText);
                            if (isOutOfStock) { 
                                observeResults.push({ field, selector, method: 'observe' });
                                continue;
                            }
                        } else {
                            // Check if this is a custom boolean field
                            const customFields = getVendorCustomFields(vendor);
                            const fieldDef = customFields[field];
                            if (fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodBoolean') {
                                // For boolean custom fields, validate based on selector type
                                if (selector.includes('input') && selector.includes('hidden')) {
                                    const inputValue = await page.locator(selector).first().getAttribute('value', { timeout: 5000 }); 
                                    if (inputValue === 'true' && (value === 'true' || value === true)) { 
                                        observeResults.push({ field, selector, method: 'observe' });
                                        continue;
                                    }
                                } else {
                                    const isVisible = await page.locator(selector).first().isVisible({ timeout: 5000 });
                                    if (isVisible && (value === 'true' || value === true)) {
                                        observeResults.push({ field, selector, method: 'observe' });
                                        continue;
                                    }
                                }
                            } else {
                                // For text fields, validate by checking inner text
                                const testText = await page.locator(selector).first().innerText({ timeout: 5000 }); 
                                if (testText && (testText.includes(value) || value.includes(testText))) { 
                                    observeResults.push({ field, selector, method: 'observe' });
                                    continue;
                                }
                            }
                        }
                    } catch (validationError) {
                        console.log(`[SELECTOR_LEARNING] Validation error for ${field}: ${validationError.message}`);
                        // Log selector validation failure
                        logErrorWithDetails('selector_validation_failed', validationError, { 
                            vendor, 
                            field, 
                            selector, 
                            value: value.substring(0, 100) // Truncate long values
                        });
                    }
                }
            }
        } catch (observeError) {
            console.log(`[SELECTOR_LEARNING] Observe error for ${field}: ${observeError.message}`);
            // Log page.observe failure
            logErrorWithDetails('selector_observe_failed', observeError, { 
                vendor, 
                field, 
                value: value.substring(0, 100), // Truncate long values
                observePrompt: observePrompt?.substring(0, 200)
            });
        }
        
        console.log(`[SELECTOR_LEARNING] Failed to learn selector for ${field}`);
        observeResults.push({ field, selector: null, method: 'observe' });
    }
    
    // Apply successful observations 
    for (const result of observeResults) {
        if (result.selector) { 
            learned[result.field] = result.selector;
        }  
    }
    
    console.log(`[SELECTOR_LEARNING] Total selectors learned: ${Object.keys(learned).length}`);
    if (Object.keys(learned).length > 0) {
        console.log(`[SELECTOR_LEARNING] Saving selectors for fields: ${Object.keys(learned).join(', ')}`);
        saveVendorSelectors(vendor, learned);
    } else {
        console.log(`[SELECTOR_LEARNING] No selectors to save`);
        // Log when no selectors were successfully learned
        logError('selector_learning_no_success', { 
            vendor, 
            fieldsAttempted: fieldsToProcess,
            itemFields: Object.keys(item),
            totalObserveResults: observeResults.length,
            failedFields: observeResults.filter(r => !r.selector).map(r => r.field)
        });
    }
}

module.exports = {
    learnAndCacheSelectors,
    getVendorCustomFields,
    loadVendorSelectors,
    saveVendorSelectors
};
