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
 * Extract product image gallery using Superdrug-specific selectors
 * @param {string} mainImage - The main image URL to exclude from additional images
 */
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

async function extractSuperdrugProduct(page, urlObj) {
    try {
        // Wait for image elements to load
        await page.waitForSelector('e2core-media[format="zoom"] img', { 
            timeout: 15000,
            state: 'attached' // Don't wait for visibility, just for element to exist
        });
        
        // Extract image information and custom Superdrug fields using direct selectors
        const extractedData = await page.evaluate((urlObj) => {
            // Define extraction functions inside the browser context
            function extractMainImage() {
                const imageElement = document.querySelector('e2core-media[format="zoom"] img');
                return imageElement ? (imageElement.src || imageElement.getAttribute('src')) : null;
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
            const uniqueImages = extractImageGallery(mainImage);
            const customFields = extractCustomFields(urlObj);
            
            return {
                main_image: mainImage,
                images: uniqueImages,
                ...customFields,
                metadata: {
                    extraction_method: 'direct_selectors_with_custom_fields',
                    selectors_used: {
                        images: 'e2core-media[format="zoom"] img',
                        custom_fields: 'sku_based_and_dom_selectors'
                    },
                    images_found: uniqueImages.length,
                    custom_fields_found: Object.keys(customFields).filter(key => customFields[key] !== undefined && customFields[key] !== null).length
                }
            };
        }, urlObj);
        
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
    extractImageGallery,
    extractMarketplaceInfo,
    extractCustomFields
};
