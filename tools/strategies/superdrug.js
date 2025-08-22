'use strict';

const { z } = require('zod');

/**
 * Superdrug-specific product extraction strategy
 * Based on direct HTML structure analysis from page_structure.html
 */

// Define Superdrug-specific custom fields
const SUPERDRUG_CUSTOM_FIELDS = {
    marketplace: z.boolean().describe('Marketplace information where the product is sold (e.g., "Sold and shipped by a Marketplace seller")'),
};



/**
 * Extract main product image using Superdrug-specific selectors
 */
function extractMainImage() {
    const imageElement = document.querySelector('e2core-media[format="zoom"] img');
    return imageElement ? (imageElement.src || imageElement.getAttribute('src')) : null;
}
 
 
/**
 * Extract marketplace information using Superdrug-specific selectors
 * Based on SKU pattern and actual DOM structure
 * @param {Object} urlObj - The URL object containing url and sku information
 */
function extractMarketplaceInfo(urlObj) {
    // Method 1: Check SKU directly (most reliable indicator)
    // Marketplace products always have "mp-" prefix in their SKU
    if (urlObj && urlObj.sku && urlObj.sku.startsWith('mp-')) {
        return true;
    }
    
    // Fallback: Check SKU in URL if sku not provided in urlObj
    if (urlObj && urlObj.url) {
        const skuMatch = urlObj.url.match(/\/p\/(mp-[^\/\?]+)/);
        if (skuMatch && skuMatch[1]) {
            const sku = skuMatch[1];
            if (sku.startsWith('mp-')) {
                return true;
            }
        }
    }
    
    // Method 2: Check the hidden input field (secondary verification)
    const marketplaceInput = document.querySelector('input#marketplaceProduct[type="hidden"]');
    if (marketplaceInput) {
        const value = marketplaceInput.value;
        return value === 'true' || value === true;
    }
    
    // Method 3: Check for marketplace text indicators
    const marketplaceTextSelectors = [
        '.mp-product-add-to-cart__header-mp-icon',  // "Sold and shipped by a Marketplace seller"
        'mp-insider-wrapper',                        // Marketplace wrapper element
        '[class*="mp-product"]',                     // Any element with mp-product class
        '[class*="marketplace"]'                     // Generic marketplace classes
    ];
    
    for (const selector of marketplaceTextSelectors) {
        const element = document.querySelector(selector);
        if (element) {
            const text = element.textContent?.toLowerCase() || '';
            // Check for marketplace-related text
            if (text.includes('marketplace seller') || 
                text.includes('sold and shipped by') ||
                text.includes('marketplace')) {
                return true;
            }
        }
    }
    
    // Method 4: Check mp-insider-wrapper existence (marketplace component)
    const mpWrapper = document.querySelector('mp-insider-wrapper');
    if (mpWrapper) {
        return true;
    }
    
    // Default to false (direct Superdrug) if no marketplace indicator found
    return false;
}

/**
 * Extract all Superdrug-specific custom fields
 * @param {Object} urlObj - The URL object containing url and sku information
 */
function extractCustomFields(urlObj) {
    return {
        marketplace: extractMarketplaceInfo(urlObj)
    };
}

async function extractSuperdrugProduct(page, urlObj, productName = null) {
    try {
        // Wait for image elements to load
        await page.waitForSelector('e2core-media[format="zoom"] img', { 
            timeout: 15000,
            state: 'attached' // Don't wait for visibility, just for element to exist
        });
        
        // Extract image information and custom Superdrug fields using direct selectors
        const extractedData = await page.evaluate((payload) => {
            const {urlObj, productName} = payload;
            // Define extraction functions inside the browser context
            // Note: productName is passed from generic.js
            
            function extractMainImage() {
                const imageElement = document.querySelector('e2core-media[format="zoom"] img');
                return imageElement ? (imageElement.src || imageElement.getAttribute('src')) : null;
            }
            
            function extractImagesByAlt(productName) {
                if (!productName || typeof productName !== 'string') {
                    return [];
                }
                
                const images = [];
                const cleanProductName = productName.trim().toLowerCase();
                
                // Find all img elements on the page
                const allImages = document.querySelectorAll('img[alt]');
                
                allImages.forEach((img) => {
                    const altText = (img.alt || '').trim().toLowerCase();
                    const imgSrc = img.src || img.getAttribute('src');
                    
                    // Check if alt text equals the product name 
                    if (altText && imgSrc && altText.toLowerCase() === cleanProductName) {
                        images.push(imgSrc);
                    }
                });
                
                return Array.from(new Set(images.filter(Boolean)));
            }
            
            function extractImageGallery(mainImage) {
                const additionalImages = [];
                const allImageElements = document.querySelectorAll('e2core-media[format="zoom"] img');
                
                allImageElements.forEach((img) => {
                    const imgSrc = img.src || img.getAttribute('src');
                    if (imgSrc && imgSrc !== mainImage) {
                        additionalImages.push(imgSrc);
                    }
                });
                
                // Ensure list includes mainImage and contains only valid, unique URLs
                const allImages = [];
                if (mainImage) allImages.push(mainImage);
                allImages.push(...additionalImages);
                
                return Array.from(new Set(allImages.filter(Boolean)));
            }
            
            function extractComprehensiveImageGallery(mainImage, productName) {
                // Approach 1: Use existing selector-based method
                const selectorImages = extractImageGallery(mainImage);
                
                // Initialize with selector-based images
                const allImages = [];
               
                
                // Add images from selector-based approach
                selectorImages.forEach(img => {
                    if (img && img !== mainImage) {
                        allImages.push(img);
                    }
                });
                
                // Approach 2: Use alt attribute matching only if selector approach found less than 2 images
                if (selectorImages.length == 0) {
                    const altImages = extractImagesByAlt(productName);
                    altImages.forEach(img => {
                        if (img && !allImages.includes(img)) {
                            allImages.push(img);
                        }
                    });
                }
                
                return Array.from(new Set(allImages.filter(Boolean)));
            }
            
            function extractMarketplaceInfo(urlObj) {
                // Method 1: Check SKU directly (most reliable indicator)
                if (urlObj && urlObj.sku && urlObj.sku.startsWith('mp-')) {
                    return true;
                }
                
                // Fallback: Check SKU in URL if sku not provided in urlObj
                if (urlObj && urlObj.url) {
                    const skuMatch = urlObj.url.match(/\/p\/(mp-[^\/\?]+)/);
                    if (skuMatch && skuMatch[1]) {
                        const sku = skuMatch[1];
                        if (sku.startsWith('mp-')) {
                            return true;
                        }
                    }
                }
                
                // Method 2: Check the hidden input field (secondary verification)
                const marketplaceInput = document.querySelector('input#marketplaceProduct[type="hidden"]');
                if (marketplaceInput) {
                    const value = marketplaceInput.value;
                    return value === 'true' || value === true;
                }
                
                // Method 3: Check for marketplace text indicators
                const marketplaceTextSelectors = [
                    '.mp-product-add-to-cart__header-mp-icon',
                    'mp-insider-wrapper',
                    '[class*="mp-product"]',
                    '[class*="marketplace"]'
                ];
                
                for (const selector of marketplaceTextSelectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        const text = element.textContent?.toLowerCase() || '';
                        if (text.includes('marketplace seller') || 
                            text.includes('sold and shipped by') ||
                            text.includes('marketplace')) {
                            return true;
                        }
                    }
                }
                
                // Method 4: Check mp-insider-wrapper existence (marketplace component)
                const mpWrapper = document.querySelector('mp-insider-wrapper');
                if (mpWrapper) {
                    return true;
                }
                
                return false;
            }
            
            function extractCustomFields(urlObj) {
                return {
                    marketplace: extractMarketplaceInfo(urlObj)
                };
            }
            
            // Execute extraction
            const mainImage = extractMainImage();
            const uniqueImages = extractComprehensiveImageGallery(mainImage, productName);
            const customFields = extractCustomFields(urlObj);
            
            const result = {
                main_image: mainImage,
                images: uniqueImages,
                ...customFields,
                metadata: {
                    extraction_method: 'direct_selectors_with_custom_fields_and_alt_matching',
                    selectors_used: {
                        name: 'passed_from_generic_js',
                        images: 'e2core-media[format="zoom"] img + alt attribute matching',
                        custom_fields: 'sku_based_and_dom_selectors'
                    },
                    images_found: uniqueImages.length,
                    alt_based_images: productName ? extractImagesByAlt(productName).length : 0,
                    selector_based_images: extractImageGallery(mainImage).length,
                    custom_fields_found: Object.keys(customFields).filter(key => customFields[key] !== undefined && customFields[key] !== null).length,
                    product_name_provided: !!productName
                }
            };
            
            // Include name if provided
            if (productName) {
                result.name = productName;
            }
            
            return result;
        }, {urlObj, productName});
        
        return extractedData;
        
    } catch (error) {
        console.error('[SUPERDRUG] Extraction error:', error.message);
        return null; // Return null so LLM handles everything
    }
}

module.exports = {
    extractSuperdrugProduct,
    customFields: SUPERDRUG_CUSTOM_FIELDS,
    // Export extraction functions for testing/reuse
    extractMainImage, 
    extractMarketplaceInfo,
    extractCustomFields
};
