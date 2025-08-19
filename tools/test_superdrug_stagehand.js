#!/usr/bin/env node
'use strict';

/**
 * Test script to verify Superdrug selectors using Stagehand
 * Run this on a Superdrug product page to test the extraction
 */

// Load Stagehand in a way that works for both ESM and CJS builds
async function loadStagehandCtor() {
    const mod = await import('@browserbasehq/stagehand');
    return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

async function testSuperdrugSelectors(url) {
    console.log('🧪 Testing Superdrug selectors on:', url);
    
    let stagehand;
    try {
        const StagehandCtor = await loadStagehandCtor();
        
        // Initialize Stagehand
        stagehand = new StagehandCtor({
            apiKey: process.env.BROWSERBASE_API_KEY,
            headless: false
        });
        
        console.log('📱 Initializing Stagehand...');
        await stagehand.init();
        
        // Navigate to the product page
        console.log('🌐 Navigating to page...');
        await stagehand.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for key elements
        console.log('⏳ Waiting for product elements...');
        await stagehand.page.waitForSelector('e2-product-details-title', { timeout: 10000 });
        
        // Test the selectors
        console.log('🔍 Testing selectors...');
        const results = await stagehand.page.evaluate(() => {
            const results = {};
            
            // Test title selector
            const titleElement = document.querySelector('e2-product-details-title');
            results.title = {
                found: !!titleElement,
                text: titleElement ? titleElement.textContent?.trim() : null,
                selector: 'e2-product-details-title'
            };
            
            // Test brand selector
            const brandElement = document.querySelector('e2-product-details-brand-link');
            results.brand = {
                found: !!brandElement,
                text: brandElement ? brandElement.textContent?.trim() : null,
                selector: 'e2-product-details-brand-link'
            };
            
            // Test price selectors
            const priceSelectors = [
                '.mp-product-add-to-cart__price .price__current',
                '.product-add-to-cart__price .price__current',
                '.mp-product-add-to-cart__price .price',
                '.product-add-to-cart__price .price'
            ];
            
            results.price = { found: false, text: null, selector: null };
            for (const selector of priceSelectors) {
                const priceElement = document.querySelector(selector);
                if (priceElement) {
                    results.price = {
                        found: true,
                        text: priceElement.textContent?.trim(),
                        selector: selector
                    };
                    break;
                }
            }
            
            // Test image selector
            const imageElement = document.querySelector('e2core-media[format="zoom"] img');
            results.mainImage = {
                found: !!imageElement,
                src: imageElement ? imageElement.src : null,
                selector: 'e2core-media[format="zoom"] img'
            };
            
            // Test all images
            const allImages = document.querySelectorAll('e2core-media[format="zoom"] img');
            results.allImages = {
                count: allImages.length,
                sources: Array.from(allImages).map(img => img.src).filter(Boolean)
            };
            
            return results;
        });
        
        // Display results
        console.log('\n📊 Selector Test Results:');
        console.log('========================');
        
        console.log('\n🏷️  Product Title:');
        console.log(`   Found: ${results.title.found ? '✅' : '❌'}`);
        console.log(`   Text: "${results.title.text || 'N/A'}"`);
        console.log(`   Selector: ${results.title.selector}`);
        
        console.log('\n🏭 Brand:');
        console.log(`   Found: ${results.brand.found ? '✅' : '❌'}`);
        console.log(`   Text: "${results.brand.text || 'N/A'}"`);
        console.log(`   Selector: ${results.brand.selector}`);
        
        console.log('\n💰 Price:');
        console.log(`   Found: ${results.price.found ? '✅' : '❌'}`);
        console.log(`   Text: "${results.price.text || 'N/A'}"`);
        console.log(`   Selector: ${results.price.selector || 'N/A'}`);
        
        console.log('\n🖼️  Main Image:');
        console.log(`   Found: ${results.mainImage.found ? '✅' : '❌'}`);
        console.log(`   Src: ${results.mainImage.src || 'N/A'}`);
        console.log(`   Selector: ${results.mainImage.selector}`);
        
        console.log('\n🖼️  All Images:');
        console.log(`   Count: ${results.allImages.count}`);
        if (results.allImages.sources.length > 0) {
            console.log('   Sources:');
            results.allImages.sources.forEach((src, index) => {
                console.log(`     ${index + 1}. ${src}`);
            });
        }
        
        // Test the actual extraction function
        console.log('\n🧪 Testing Superdrug extraction function...');
        const { extractSuperdrugProduct } = require('./strategies/superdrug');
        const extractedData = await extractSuperdrugProduct(stagehand.page, { url });
        
        console.log('\n📦 Extracted Data:');
        console.log('==================');
        console.log(`Name: "${extractedData.name || 'N/A'}"`);
        console.log(`Brand: "${extractedData.brand || 'N/A'}"`);
        console.log(`Price: "${extractedData.price || 'N/A'}"`);
        console.log(`Main Image: ${extractedData.main_image || 'N/A'}`);
        console.log(`Images Count: ${extractedData.images ? extractedData.images.length : 0}`);
        console.log(`SKU: "${extractedData.sku || 'N/A'}"`);
        console.log(`Completed: ${extractedData.metadata?.completed ? '✅' : '❌'}`);
        console.log(`Method: ${extractedData.metadata?.extraction_method || 'N/A'}`);
        
        // Wait a bit to see the results
        console.log('\n⏰ Waiting 15 seconds before closing...');
        await new Promise(resolve => setTimeout(resolve, 15000));
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        if (stagehand) {
            try {
                await stagehand.close();
                console.log('🔒 Stagehand closed');
            } catch (closeError) {
                console.error('Error closing Stagehand:', closeError.message);
            }
        }
    }
}

// Main execution
if (require.main === module) {
    const url = process.argv[2];
    if (!url) {
        console.error('❌ Please provide a Superdrug product URL');
        console.log('Usage: node test_superdrug_stagehand.js <product_url>');
        process.exit(1);
    }
    
    // Check if BROWSERBASE_API_KEY is set
    if (!process.env.BROWSERBASE_API_KEY) {
        console.error('❌ BROWSERBASE_API_KEY environment variable is required');
        console.log('Please set your Browserbase API key and try again');
        process.exit(1);
    }
    
    testSuperdrugSelectors(url).catch(console.error);
}

module.exports = { testSuperdrugSelectors };
