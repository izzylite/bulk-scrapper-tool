'use strict';

const { z } = require('zod');
const { cleanText } = require('../utils/mark_up_price');

/**
 * Superdrug-specific product extraction strategy
 * Based on direct HTML structure analysis from page_structure.html
 */

// Define Superdrug-specific custom fields
const SUPERDRUG_CUSTOM_FIELDS = {
    marketplace: z.boolean().describe('Marketplace information where the product is sold (e.g., "Sold and shipped by a Marketplace seller")'),
    features: z.string().describe('Text content from the "Features" section. Preserve bullet points as newline-separated plain text. Return empty string if the section is not present.'),
    product_specification: z.string().describe('Text content from the "Product Specification" section. Combine key-value lines as newline-separated plain text. Return empty string if the section is not present.'),
    warnings_or_restrictions: z.string().describe('Text content from the "Warning or Restrictions" section. Preserve bullet points as newline-separated plain text. Return empty string if the section is not present.'),
    tips_and_advice: z.string().describe('Text content from the "Tips and Advice" section. Preserve bullet points as newline-separated plain text. Return empty string if the section is not present.'),
};


 

async function extractSuperdrugProduct(page, urlObj, productName = null, options = {}) {
    try {
        const allowedFields = Array.isArray(options?.allowedFields) ? new Set(options.allowedFields) : null;
        // Only wait for images if they are requested
        if (!allowedFields || allowedFields.has('images') || allowedFields.has('main_image')) {
            await page.waitForSelector('e2core-media[format="zoom"] img', { 
                timeout: 15000,
                state: 'attached' // Don't wait for visibility, just for element to exist
            });
        }
        
        // Extract image information and custom Superdrug fields using direct selectors
        const extractedData = await page.evaluate((payload) => {
            const {urlObj, productName, allowedFieldsArray} = payload;
            const allowedFields = Array.isArray(allowedFieldsArray) ? new Set(allowedFieldsArray) : null;
            // Define extraction functions inside the browser context
            // Note: productName is passed from generic.js
            
            function extractName() {
                // Primary selector per provided structure
                const h1 = document.querySelector('h1.product-details-title__text');
                if (h1) {
                    const t = (h1.textContent || '').replace(/\s+/g, ' ').trim();
                    if (t) return t;
                }
                // Fallback: any heading inside the title container
                const container = document.querySelector('.product-details-title__container');
                if (container) {
                    const any = container.querySelector('h1, h2');
                    if (any) {
                        const t = (any.textContent || '').replace(/\s+/g, ' ').trim();
                        if (t) return t;
                    }
                }
                return '';
            }

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
            
            function getClosestByHeading(headingText) {
                const target = (headingText || '').trim().toLowerCase();
                if (!target) return null;

                // Candidate heading selectors commonly used for accordions/sections
                const candidates = Array.from(document.querySelectorAll([
                    'h1','h2','h3','h4','h5','summary','button','[role="button"]',
                    '[class*="accordion"] [class*="title"]',
                    '[data-test*="accordion"]',
                    '[class*="section-title"]',
                    '[class*="expander"] [class*="title"]'
                ].join(',')));

                // Prefer exact text match, then includes
                const byExact = candidates.find(el => (el.textContent || '').trim().toLowerCase() === target);
                if (byExact) return byExact;
                return candidates.find(el => (el.textContent || '').trim().toLowerCase().includes(target)) || null;
            }

            function extractSectionTextByHeading(headingText) {
                const headingEl = getClosestByHeading(headingText);
                if (!headingEl) return '';

                // If heading controls a region via aria-controls, use that region
                const controlsId = headingEl.getAttribute('aria-controls');
                if (controlsId) {
                    const region = document.getElementById(controlsId);
                    if (region) return sanitizeBlockText(region);
                }

                // Try next siblings up to a few nodes to find the content block
                let node = headingEl.nextElementSibling;
                for (let i = 0; i < 4 && node; i++) {
                    // Skip if this is another heading-like node
                    const text = (node.textContent || '').trim();
                    if (text && text.length > 0) {
                        return sanitizeBlockText(node);
                    }
                    node = node.nextElementSibling;
                }

                // Fallback: search upward for a container, then use its text excluding the heading
                const container = headingEl.closest('[class*="accordion"], section, article, div');
                if (container) {
                    const clone = container.cloneNode(true);
                    // Remove the heading itself from clone
                    const headingClone = clone.querySelector('*');
                    if (headingClone && (headingClone.textContent || '').trim().toLowerCase().includes((headingText || '').trim().toLowerCase())) {
                        headingClone.remove();
                    }
                    return sanitizeBlockText(clone);
                }

                return '';
            }

            function sanitizeBlockText(rootEl) {
                if (!rootEl) return '';
                // Prefer list items as separate lines when present
                const listItems = Array.from(rootEl.querySelectorAll('li'))
                    .map(li => (li.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                if (listItems.length > 0) {
                    return Array.from(new Set(listItems)).join('\n');
                }
                // Otherwise, use paragraph blocks
                const blocks = Array.from(rootEl.querySelectorAll('p, div'))
                    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                if (blocks.length > 0) {
                    return Array.from(new Set(blocks)).join('\n');
                }
                return (rootEl.textContent || '').replace(/\s+/g, ' ').trim();
            }

            function extractFeatures() {
                const root = document.querySelector('e2-accordion.product-general-information__section-item--features, .product-general-information__section-item--features');
                const body = root ? (root.querySelector('.e2-accordion__body [body]') || root.querySelector('.e2-accordion__body') || root) : null;
                if (body) {
                    // Preserve <br> as newlines
                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = body.innerHTML.replace(/<br\s*\/?>(\s*)/gi, '\n');
                    const text = (wrapper.textContent || '').replace(/\r?\n\s*\n+/g, '\n').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
                    if (text) return text;
                }
                return extractSectionTextByHeading('Features');
            }

            function extractProductSpecification() {
                const root = document.querySelector('e2-accordion.product-general-information__section-item--specifications, .product-general-information__section-item--specifications');
                const body = root ? (root.querySelector('.e2-accordion__body [body]') || root.querySelector('.e2-accordion__body') || root) : null;
                if (body) {
                    const items = Array.from(body.querySelectorAll('.product-general-information__section-item-description'))
                        .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
                        .filter(Boolean);
                    const text = Array.from(new Set(items)).join('\n');
                    if (text) return text;
                }
                return extractSectionTextByHeading('Product Specification');
            }

            function extractWarningsOrRestrictions() {
                // Target the specific warnings accordion
                const root = document.querySelector('e2-accordion.product-general-information__section-item--warnings');
                if (root) {
                    const body = root.querySelector('.e2-accordion__body [body]');
                    if (body) {
                        const items = Array.from(body.querySelectorAll('.product-general-information__section-item-description'))
                            .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
                            .filter(Boolean);
                        const text = Array.from(new Set(items)).join('\n');
                        if (text) return text;
                    }
                }
                
                // Fallback to generic heading search
                return extractSectionTextByHeading('Warning or Restrictions');
            }

            function extractTipsAndAdvice() {
                // Target the specific tips accordion
                const root = document.querySelector('e2-accordion.product-general-information__section-item--tips');
                if (root) {
                    const body = root.querySelector('.e2-accordion__body [body]');
                    if (body) {
                        const items = Array.from(body.querySelectorAll('.product-general-information__section-item-description'))
                            .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
                            .filter(Boolean);
                        const text = Array.from(new Set(items)).join('\n');
                        if (text) return text;
                    }
                }
                
                // Fallback to generic heading search
                return extractSectionTextByHeading('Tips and Advice');
            }

            function extractStockStatus() {
                try {
                    // If an Add to Basket progress button exists, consider it In stock
                    const btn = document.querySelector('button.progress-button.progress-button--has-completed-label[aria-label][type="submit"]');
                    if (btn) {
                        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                        const txt = (btn.textContent || '').toLowerCase();
                        if (aria.includes('add to basket') || txt.includes('add to basket')) {
                            return 'In stock';
                        }
                    }
                } catch {}
                return 'Out of stock';
            }

            function extractDescription() {
                // Target the specific Product Information accordion
                const root = document.querySelector('e2-accordion.product-general-information__section-item--information, .product-general-information__section-item--information');
                if (root) {
                    const body = root.querySelector('.e2-accordion__body [body]') || root.querySelector('.e2-accordion__body') || root;
                    if (body) {
                        // Prefer specific description blocks if present
                        const items = Array.from(body.querySelectorAll('.product-general-information__section-item-description'))
                            .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
                            .filter(Boolean);
                        const text = Array.from(new Set(items)).join('\n');
                        if (text) return text;

                        // Otherwise, sanitize the whole body content
                        const wrapper = document.createElement('div');
                        wrapper.innerHTML = body.innerHTML.replace(/<br\s*\/?>(\s*)/gi, '\n');
                        const sanitized = (wrapper.textContent || '').replace(/\r?\n\s*\n+/g, '\n')
                            .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
                        if (sanitized) return sanitized;
                    }
                }
                // Fallback to generic heading search
                return extractSectionTextByHeading('Product Information');
            }

            function extractPrice() {
                try {
                    const priceEl = document.querySelector('.price__default-value');
                    if (priceEl) {
                        const text = (priceEl.textContent || '').replace(/\s+/g, ' ').trim();
                        if (text) return text;
                    }
                } catch {}
                return '';
            }

            function extractCustomFields(urlObj, allowedFields) {
                const out = {};
                if (!allowedFields || allowedFields.has('marketplace')) {
                    out.marketplace = extractMarketplaceInfo(urlObj);
                }
                if (!allowedFields || allowedFields.has('features')) {
                    out.features = extractFeatures();
                }
                if (!allowedFields || allowedFields.has('product_specification')) {
                    out.product_specification = extractProductSpecification();
                }
                if (!allowedFields || allowedFields.has('warnings_or_restrictions')) {
                    out.warnings_or_restrictions = extractWarningsOrRestrictions();
                }
                if (!allowedFields || allowedFields.has('tips_and_advice')) {
                    out.tips_and_advice = extractTipsAndAdvice();
                }
                return out;
            }

            function extractBreadcrumbs() {
                try {
                    const container = document.querySelector('.breadcrumb-container');
                    if (!container) return [];

                    // Only include breadcrumb items that have a clickable link (exclude current product)
                    const anchors = container.querySelectorAll('.breadcrumb-item a');
                    const labels = Array.from(anchors)
                        .map(a => {
                            const el = a.querySelector('.breadcrumb-item__text') || a;
                            return (el.textContent || '').replace(/\s+/g, ' ').trim();
                        })
                        .filter(Boolean)
                        .filter(text => text.toLowerCase() !== 'home');

                    // Deduplicate while preserving order
                    const seen = new Set();
                    const out = [];
                    for (const label of labels) {
                        if (!seen.has(label)) { seen.add(label); out.push(label); }
                    }
                    return out;
                } catch {
                    return [];
                }
            }
            
            // Execute extraction
            const name = (allowedFields && allowedFields.has('name')) ? extractName() : productName;
            const mainImage = (allowedFields && !allowedFields.has('main_image')) ? null : extractMainImage();
            const uniqueImages = (allowedFields && !allowedFields.has('images')) ? [] : extractComprehensiveImageGallery(mainImage, productName);
            const breadcrumbs = (!allowedFields || allowedFields.has('breadcrumbs')) ? extractBreadcrumbs() : [];
            const description = (!allowedFields || allowedFields.has('description')) ? extractDescription() : '';
            const stockStatus = (!allowedFields || allowedFields.has('stock_status')) ? extractStockStatus() : '';
            const price = (!allowedFields || allowedFields.has('price')) ? extractPrice() : '';
            const customFields = extractCustomFields(urlObj, allowedFields);
            const result = {
                ...(name && name.trim() ? { name } : {}),
                ...((allowedFields && !allowedFields.has('main_image') && !allowedFields.has('images')) ? {} : { main_image: mainImage, images: uniqueImages }),
                ...customFields,
                ...(description && description.trim() ? { description } : {}),
                ...(stockStatus && stockStatus.trim() ? { stock_status: stockStatus } : {}),
                ...(price && price.trim() ? { price } : {}),
                ...(breadcrumbs && breadcrumbs.length > 0 ? { breadcrumbs } : {}),
                metadata: {
                    extraction_method: 'direct_selectors_with_custom_fields_and_alt_matching',
                    selectors_used: {
                        name: 'h1.product-details-title__text | container heading fallback | passed_from_generic_js',
                        images: 'e2core-media[format="zoom"] img + alt attribute matching',
                        price: '.price__default-value',
                        stock_status: 'progress-button Add to Basket presence',
                        description: 'Product Information accordion/title',
                        custom_fields: 'sku_based_and_dom_selectors + product-general-information sections'
                    },
                    images_found: uniqueImages.length,
                    alt_based_images: productName ? extractImagesByAlt(productName).length : 0,
                    selector_based_images: extractImageGallery(mainImage).length,
                    custom_fields_found: Object.keys(customFields).filter(key => customFields[key] !== undefined && customFields[key] !== null).length,
                    product_name_provided: !!productName
                }
            };
            
          
            
            return result;
        }, {urlObj, productName, allowedFieldsArray: allowedFields ? Array.from(allowedFields) : null});
        
        return extractedData;
        
    } catch (error) {
        console.error('[SUPERDRUG] Extraction error:', error.message);
        return null; // Return null so LLM handles everything
    }
}

module.exports = {
    extractSuperdrugProduct,
    customFields: SUPERDRUG_CUSTOM_FIELDS,
    /**
     * Vendor-level output transformation for Superdrug
     * - Merge `features` and `product_specification` into `description`
     * - Remove source fields from final payload
     */
    transformOutput(product) {
        try {
            if (!product || typeof product !== 'object') return product;
            const next = { ...product };
            const desc = (next.description || '').toString();
            const features = (next.features || '').toString();
            const spec = (next.product_specification || '').toString();
            const warnings = (next.warnings_or_restrictions || '').toString();
            const tips = (next.tips_and_advice || '').toString();

            // Extract EAN code from product specification if available
            if (spec && spec.trim()) {
                const eanMatch = spec.match(/EAN:\s*(\d+)/i);
                if (eanMatch && eanMatch[1]) {
                    next.ean_code = eanMatch[1];
                }
            }

            const makeSection = (title, content) => {
                if (!content || !content.trim()) return null; 
                return `${title}\n${content.trim()}`;
            };

            const sections = [];
            const s1 = makeSection('Product Information', desc);
            if (s1) sections.push(s1);
            const s2 = makeSection('Features', features);
            if (s2) sections.push(s2);
            const s3 = makeSection('Product Specification', spec);
            if (s3) sections.push(s3);
            const s4 = makeSection('Warning or Restrictions', warnings);
            if (s4) sections.push(s4);
            const s5 = makeSection('Tips and Advice', tips);
            if (s5) sections.push(s5);

            if (sections.length > 0) {
                next.description = sections.join('\n\n');
            }
            if (Array.isArray(next.breadcrumbs) && next.breadcrumbs.length > 0) {
                next.category = next.breadcrumbs[next.breadcrumbs.length - 1].toLowerCase();
            }

            delete next.features;
            delete next.product_specification;
            delete next.warnings_or_restrictions;
            delete next.tips_and_advice;
            return next;
        } catch {
            return product;
        }
    }
};
