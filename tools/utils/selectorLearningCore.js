'use strict';

const fs = require('fs');
const path = require('path');
const cacheManager = require('./cache/cacheManager');
const { logError, logErrorWithDetails, extractErrorDetails } = require('./logUtil');

// Per-file write lock to safely update vendor-selectors.json from concurrent workers
const __fileLocks = new Map();
function withFileLock(filePath, fn) {
    const prev = __fileLocks.get(filePath) || Promise.resolve();
    const next = prev.then(fn, fn);
    __fileLocks.set(filePath, next.catch(() => {}));
    return next;
}

// Import vendor-specific strategies for custom fields
const vendorStrategies = {
    superdrug: require('../strategies/superdrug')
};

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

async function saveVendorSelectors(vendor, partial) {
    const p = path.resolve(process.cwd(), 'tools/utils/cache/vendor-selectors.json');
    
    await withFileLock(p, async () => {
        try {
            const all = loadVendorSelectors();
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
                
                // If we have enough selectors, remove one to make room for the new one
                const maxSelectors = Number(process.env.MAX_SELECTORS_PER_FIELD) || 10;
                if (current.selectors[field].length >= maxSelectors) {
                    // Remove the oldest selector (last in array) to make room
                    const removed = current.selectors[field].pop();
                    console.log(`[SELECTOR_LEARNING] Removed oldest selector for ${field} to make room for new one: ${removed.selector.substring(0, 50)}...`);
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
                }
            }
        }
        
            all[vendor] = current;
            
            // Write file inside the lock (prevents corruption during concurrent access)
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
    });
}

async function learnAndCacheSelectors(page, vendor, item) {
    // Only attempt when we have some values to learn from
    if (!item || typeof item !== 'object') return;
    
    // Check if page is still valid before proceeding
    if (!(await isPageValid(page))) {
        console.log(`[SELECTOR_LEARNING] Page/context is closed, skipping selector learning for ${vendor}`);
        return;
    }
     
     
    
    const learned = {};
    // Learn selectors for static fields, main_image, stock_status, and breadcrumbs container
    // Truly dynamic fields (like full images array) will always use LLM
    const baseFieldsToLearn = ['name', 'price', 'main_image', 'weight', 'description', 'category', 'stock_status', 'breadcrumbs'];
    
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
    
    // Prepare fields that need learning and prepare for selector removal/replacement
    const fieldsToProcess = fieldsToLearn.filter(field => {
        if (field === 'breadcrumbs') {
            return Array.isArray(item.breadcrumbs) && item.breadcrumbs.length > 0;
        }
        const value = String(item[field] || '').trim();
        if (!value) {
            return false;
        }
        return true; // Always learn new selectors for fields with values
    });
    
    
    
    if (fieldsToProcess.length === 0) { 
        return;
    }
    console.log(`[SELECTOR_LEARNING] Fields to learn selectors for: ${fieldsToProcess.join(', ')}`);
    // Process fields synchronously one by one instead of in parallel
    const observeResults = [];
    
    for (const field of fieldsToProcess) {
        const value = String(item[field] || '').trim();
        
        // Track the last observe prompt used for better failure diagnostics
        let observePrompt = null;
        try {
           
            
            if (field === 'breadcrumbs') {
                observePrompt = `Find the breadcrumb navigation container on this page (e.g., nav with aria-label="breadcrumb", or a list of links representing the category path).`;
            } else if (field === 'main_image') {
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
             
            let observation = null;
            try {
                observation = await page.observe(observePrompt, { timeout: 10000 }); // Increased timeout
            } catch (observeErr) {
                // Shadow DOM often breaks naive observation follow-ups; keep going, validation will try pierce selectors
                observation = null;
            }
             
            
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
                        // Check if page is still valid before validation
                        if (!(await isPageValid(page))) {
                            console.log(`[SELECTOR_LEARNING] Page/context closed during validation for ${field}`);
                            observeResults.push({ field, selector: null, method: 'observe' });
                            continue;
                        }
                        
                        if (field === 'breadcrumbs') {
                            // Validate breadcrumb container: must be visible and contain links
                            let isVisible = false;
                            try { isVisible = await page.locator(selector).first().isVisible({ timeout: 5000 }); }
                            catch { try { isVisible = await page.locator(`pierce=${selector}`).first().isVisible({ timeout: 5000 }); } catch {} }
                            if (isVisible) {
                                try {
                                    let linkCount = 0;
                                    try { linkCount = await page.locator(selector).first().locator('a').count({ timeout: 2000 }); }
                                    catch { linkCount = await page.locator(`pierce=${selector}`).first().locator('a').count({ timeout: 2000 }); }
                                    if (linkCount > 0) {
                                        observeResults.push({ field, selector, method: 'observe' });
                                        continue;
                                    }
                                } catch {}
                                // As a fallback, accept visible container
                                observeResults.push({ field, selector, method: 'observe' });
                                continue;
                            }
                        } else if (field === 'main_image') {
                            // For main_image, validate by checking src attribute
                            let testSrc = null;
                            try { testSrc = await page.locator(selector).first().getAttribute('src', { timeout: 5000 }); }
                            catch { try { testSrc = await page.locator(`pierce=${selector}`).first().getAttribute('src', { timeout: 5000 }); } catch {} }
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
                            let testText = '';
                            try { testText = await page.locator(selector).first().innerText({ timeout: 5000 }); }
                            catch { try { testText = await page.locator(`pierce=${selector}`).first().innerText({ timeout: 5000 }); } catch {} }
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
                                    let inputValue = null;
                                    try { inputValue = await page.locator(selector).first().getAttribute('value', { timeout: 5000 }); }
                                    catch { try { inputValue = await page.locator(`pierce=${selector}`).first().getAttribute('value', { timeout: 5000 }); } catch {} }
                                    if (inputValue === 'true' && (value === 'true' || value === true)) { 
                                        observeResults.push({ field, selector, method: 'observe' });
                                        continue;
                                    }
                                } else {
                                    let isVisible = false;
                                    try { isVisible = await page.locator(selector).first().isVisible({ timeout: 5000 }); }
                                    catch { try { isVisible = await page.locator(`pierce=${selector}`).first().isVisible({ timeout: 5000 }); } catch {} }
                                    if (isVisible && (value === 'true' || value === true)) {
                                        observeResults.push({ field, selector, method: 'observe' });
                                        continue;
                                    }
                                }
                            } else {
                                // For text fields, validate by checking inner text with normalization
                                const normalize = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
                                let testText = '';
                                try { testText = await page.locator(selector).first().innerText({ timeout: 5000 }); }
                                catch { try { testText = await page.locator(`pierce=${selector}`).first().innerText({ timeout: 5000 }); } catch {} }
                                const normTest = normalize(testText);
                                const normValue = normalize(value);
                                if (normTest && normValue && (normTest.includes(normValue) || normValue.includes(normTest))) { 
                                    observeResults.push({ field, selector, method: 'observe' });
                                    continue;
                                }
                            }
                        }
                    } catch (validationError) {
                        // Check if it's a closed page/context error
                        if (validationError.message && validationError.message.includes('Target page, context or browser has been closed')) {
                            console.log(`[SELECTOR_LEARNING] Page/context closed during validation for ${field} with selector: ${selector}`);
                            observeResults.push({ field, selector: null, method: 'observe' });
                            continue;
                        }
                        
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
            // Check if it's a closed page/context error
            if (observeError.message && observeError.message.includes('Target page, context or browser has been closed')) {
                console.log(`[SELECTOR_LEARNING] Page/context closed during observe for ${field}`);
                observeResults.push({ field, selector: null, method: 'observe' });
                continue;
            }
            
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
        // Structured failure log for downstream analysis
        try {
            logError('selector_learning_failed_for_field', {
                vendor,
                field,
                value: value.substring(0, 100),
                itemKeys: Object.keys(item || {}),
                observePrompt: observePrompt ? observePrompt.substring(0, 200) : null
            });
        } catch {}
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
        await saveVendorSelectors(vendor, learned);
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

module.exports = {
    learnAndCacheSelectors,
    getVendorCustomFields,
    loadVendorSelectors,
    saveVendorSelectors
};
