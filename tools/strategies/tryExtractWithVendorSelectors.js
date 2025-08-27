'use strict';

const cacheManager = require('../utils/cache/cacheManager');
const { toNumber } = require('../utils/mark_up_price');
const { getVendorCustomFields, loadVendorSelectors, saveVendorSelectors } = require("../utils/selectorLearningCore");
const { cleanAndValidateUrl } = require('../utils/utls');
 
const vendorStrategies = {
	superdrug: require('./superdrug')
};
 
 
// Factory to create tryExtractWithVendorSelectors with explicit dependencies to avoid circular imports
async function tryExtractWithVendorSelectors(page, vendor, urlObj, allowedFields = null, 
   fieldsExtraction = ['name', 'price', 'weight', 'description', 'category', 'main_image', 'stock_status', 'breadcrumbs']) {
    try {
        const all = loadVendorSelectors();
        const vendorData = all[vendor];

        // Initialize result object
        const result = {};

        // Handle learned selectors (if any exist) - used as fallback after vendor strategy
        let selectors = null;
        if (vendorData && vendorData.selectors) {
            selectors = vendorData.selectors;
        }
        let vendorProvidedFields = new Set();

        // Extract vendor-specific fields using vendor strategy if available (PRIMARY)
        if (vendorStrategies[vendor]) {
            const strategy = vendorStrategies[vendor];
            let extractFunction = null;
            if (vendor === 'superdrug' && strategy.extractSuperdrugProduct) {
                extractFunction = strategy.extractSuperdrugProduct;
            }

            if (extractFunction) {
                const getProductNameForVendor = async () => {
                    if (selectors && selectors.name && Array.isArray(selectors.name)) {
                        const nameResult = await trySelectorsForField(page, 'name', selectors.name, vendor, 5000);
                        if (nameResult && nameResult.value) {
                            return nameResult.value;
                        }
                    }
                    return null;
                };

                try {
                    const productName = await getProductNameForVendor();
                    const vendorResult = await extractFunction(page, urlObj, productName, { allowedFields: allowedFields ? Array.from(allowedFields) : null });
                    if (vendorResult) {
                        if (vendorResult.images && (!allowedFields || allowedFields.has('images'))) {
                            result.images = vendorResult.images;
                            vendorProvidedFields.add('images');
                        }
                        if (vendorResult.main_image && (!allowedFields || allowedFields.has('main_image'))) {
                            result.main_image = vendorResult.main_image;
                            vendorProvidedFields.add('main_image');
                        }
                        if (vendorResult.name && (!allowedFields || allowedFields.has('name'))) {
                            result.name = vendorResult.name;
                            vendorProvidedFields.add('name');
                        }
                        if (vendorResult.price && (!allowedFields || allowedFields.has('price'))) {
                            result.price = vendorResult.price;
                            vendorProvidedFields.add('price');
                        }
                        if (vendorResult.description && (!allowedFields || allowedFields.has('description'))) {
                            result.description = vendorResult.description;
                            vendorProvidedFields.add('description');
                        }
                        if (vendorResult.stock_status && (!allowedFields || allowedFields.has('stock_status'))) {
                            result.stock_status = vendorResult.stock_status;
                            vendorProvidedFields.add('stock_status');
                        }
                        if (Array.isArray(vendorResult.breadcrumbs) && (!allowedFields || allowedFields.has('breadcrumbs'))) {
                            result.breadcrumbs = vendorResult.breadcrumbs;
                            vendorProvidedFields.add('breadcrumbs');
                        }
                        const customFieldNames = Object.keys(getVendorCustomFields(vendor));
                        const filteredCustomFieldNames = allowedFields ? customFieldNames.filter(n => allowedFields.has(n)) : customFieldNames;
                        for (const fieldName of filteredCustomFieldNames) {
                            if (vendorResult[fieldName] !== undefined && vendorResult[fieldName] !== null && vendorResult[fieldName] !== '') {
                                result[fieldName] = vendorResult[fieldName];
                                vendorProvidedFields.add(fieldName);
                            }
                        }
                    } else {
                        console.log(`[VENDOR_STRATEGY] Vendor strategy returned null/empty result`);
                    }
                } catch (error) {
                    console.error(`[VENDOR_STRATEGY] Vendor strategy error:`, error);
                }
            } else {
                console.log(`[VENDOR_STRATEGY] No extraction function found for ${vendor}`);
            }
        } else {
            console.log(`[VENDOR_STRATEGY] No vendor strategy found for ${vendor}`);
        }

        // After vendor strategy, use learned selectors as FALLBACK for missing fields
        const successfulSelectors = {};
        let selectorPromises = [];
        if (selectors && Object.keys(selectors).length > 0) {
            
            let baseFieldsToExtract = fieldsExtraction;
            if (allowedFields) {
                baseFieldsToExtract = baseFieldsToExtract.filter(f => allowedFields.has(f));
            }
            const customFieldNames = Object.keys(getVendorCustomFields(vendor));
            let customFieldsToExtract = customFieldNames.filter(field => {
                const fieldDef = getVendorCustomFields(vendor)[field];
                return fieldDef && fieldDef._def && (
                    fieldDef._def.typeName === 'ZodString' ||
                    fieldDef._def.typeName === 'ZodBoolean'
                );
            });
            if (allowedFields) {
                customFieldsToExtract = customFieldsToExtract.filter(f => allowedFields.has(f));
            }
            const fieldsToExtract = [...baseFieldsToExtract, ...customFieldsToExtract].filter(field => {
                // Skip extraction entirely if vendor strategy already provided this field
                if (vendorProvidedFields.has(field)) return false;
                const currentValue = result[field];
                const customFields = getVendorCustomFields(vendor);
                const fieldDef = customFields[field];
                const isBooleanField = fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodBoolean';
                if (isBooleanField) {
                    return currentValue === undefined; // false is a valid value; only fetch if undefined
                }
                return !(currentValue !== null && currentValue !== '' && currentValue !== undefined);
            });

             
            for (const field of fieldsToExtract) {
                if (selectors[field] && Array.isArray(selectors[field])) {
                    selectorPromises.push(trySelectorsForField(page, field, selectors[field], vendor));
                }
            }
            // Extract data using learned selectors
            const selectorResults = await Promise.all(selectorPromises);
            for (const { field, value, successfulSelector } of selectorResults) {
                if (value !== null && value !== '' && value !== undefined) {
                    if (allowedFields && !allowedFields.has(field)) continue;
                    const customFields = getVendorCustomFields(vendor);
                    const fieldDef = customFields[field];
                    const isBooleanField = fieldDef && fieldDef._def && fieldDef._def.typeName === 'ZodBoolean';
                    if (isBooleanField || value !== '') {
                        result[field] = value;
                        if (successfulSelector) {
                            successfulSelectors[field] = successfulSelector;
                        }
                    }
                }
            }

            // Update success tracking for working selectors (only if needed to reduce I/O)
            if (Object.keys(successfulSelectors).length > 0) {
                const vendorData2 = loadVendorSelectors()[vendor];
                const needsUpdate = Object.entries(successfulSelectors).some(([field, selector]) => {
                    if (!vendorData2 || !vendorData2.selectors || !Array.isArray(vendorData2.selectors[field])) {
                        return true;
                    }
                    const existing = vendorData2.selectors[field].find(s => s.selector === selector);
                    return !existing || existing.success_count < 10;
                });
                if (needsUpdate) {
                    await saveVendorSelectors(vendor, successfulSelectors);
                }
            }

        } else {
            console.log(`[VENDOR_STRATEGY] No learned selectors found for ${vendor}`);
        }


        return Object.keys(result).length > 0 ? result : null; // Return null if no fields are set

    } catch (error) {
        console.error(`[VENDOR_STRATEGY] Error in tryExtractWithVendorSelectors:`, error);
        return null;
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
					let src = null;
					try {
						src = await page.locator(selectorOption).first().getAttribute('src', { timeout: Math.min(timeout, 5000) });
					} catch {
						// Shadow DOM fallback
						try { src = await page.locator(`pierce=${selectorOption}`).first().getAttribute('src', { timeout: Math.min(timeout, 5000) }); } catch { }
					}
					value = src ? cleanAndValidateUrl(src.trim()) : null;
				} else if (field === 'price') {
					// Special handling for price to avoid getting unit labels like "each"
					let text = null;
					try { text = await page.locator(selectorOption).first().innerText({ timeout: Math.min(timeout, 5000) }); }
					catch { try { text = await page.locator(`pierce=${selectorOption}`).first().innerText({ timeout: Math.min(timeout, 5000) }); } catch { } }

					if (text) {
						text = text.trim();
						// For price field, try to extract numeric value
						const numericPrice = toNumber(text);
						if (!isNaN(numericPrice) && numericPrice > 0) {
							value = numericPrice.toString();
						} else {
							value = null; // Skip this selector, couldn't extract valid price
						}
					}
				} else if (field === 'stock_status') {
					let isVisible = false;
					try {
						isVisible = await page.locator(selectorOption).first().isVisible({ timeout: Math.min(timeout, 5000) });
					} catch {
						try { isVisible = await page.locator(`pierce=${selectorOption}`).first().isVisible({ timeout: Math.min(timeout, 5000) }); } catch { }
					}
					if (isVisible) {
						let text = '';
						try { text = await page.locator(selectorOption).first().innerText({ timeout: 3000 }); }
						catch { try { text = await page.locator(`pierce=${selectorOption}`).first().innerText({ timeout: 3000 }); } catch { } }
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
							let inputValue = null;
							try { inputValue = await element.getAttribute('value', { timeout: Math.min(timeout, 5000) }); }
							catch { try { inputValue = await page.locator(`pierce=${selectorOption}`).first().getAttribute('value', { timeout: Math.min(timeout, 5000) }); } catch { } }
							value = inputValue === 'true' || inputValue === true;
						} else {
							// For other elements, check visibility/existence
							let isVisible = false;
							try { isVisible = await element.isVisible({ timeout: Math.min(timeout, 5000) }); }
							catch { try { isVisible = await page.locator(`pierce=${selectorOption}`).first().isVisible({ timeout: Math.min(timeout, 5000) }); } catch { } }
							value = isVisible;
						}
					} else {
						// For text fields (name, price, weight, description, category, custom string fields)
						let text = null;
						try { text = await page.locator(selectorOption).first().innerText({ timeout: Math.min(timeout, 5000) }); }
						catch { try { text = await page.locator(`pierce=${selectorOption}`).first().innerText({ timeout: Math.min(timeout, 5000) }); } catch { } }
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

 

module.exports = {
     tryExtractWithVendorSelectors,
     trySelectorsForField, 
};

