'use strict';

/**
 * Superdrug-specific product extraction strategy
 * Based on direct HTML structure analysis from page_structure.html
 */

async function extractSuperdrugProduct(page, urlObj) {
    try {
        // Wait for image elements to load
        await page.waitForSelector('e2core-media[format="zoom"] img', { 
            timeout: 15000,
            state: 'attached' // Don't wait for visibility, just for element to exist
        });
        
        // Extract ONLY image information using direct selectors
        const imageData = await page.evaluate((urlObj) => {
            // Main product image - using e2core-media with zoom format
            let mainImage = null;
            const imageElement = document.querySelector('e2core-media[format="zoom"] img');
            if (imageElement) {
                mainImage = imageElement.src || imageElement.getAttribute('src');
            }
            
            // Additional images - collect all zoom format images
            const additionalImages = [];
            const allImageElements = document.querySelectorAll('e2core-media[format="zoom"] img');
            allImageElements.forEach((img, index) => {
                const imgSrc = img.src || img.getAttribute('src');
                if (imgSrc && imgSrc !== mainImage) {
                    additionalImages.push(imgSrc);
                }
            });
            
            // Ensure list includes mainImage and contains only valid, unique URLs
            const allImages = [];
            if (mainImage) allImages.push(mainImage);
            allImages.push(...additionalImages);
            const uniqueImages = Array.from(new Set(allImages.filter(Boolean)));
            
            return {
                main_image: mainImage,
                images: uniqueImages,
                metadata: {
                    extraction_method: 'direct_selectors_images_only',
                    selectors_used: {
                        images: 'e2core-media[format="zoom"] img'
                    },
                    images_found: uniqueImages.length
                }
            };
        }, urlObj);
        
        return imageData;
        
    } catch (error) {
        console.error('[SUPERDRUG] Image extraction error:', error.message);
        return null; // Return null so LLM handles everything
    }
}

module.exports = {
    extractSuperdrugProduct
};
