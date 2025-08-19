#!/usr/bin/env node
'use strict';

/**
 * Test script to verify Superdrug selectors
 * Run this on a Superdrug product page to test the extraction
 */

const puppeteer = require('puppeteer');

async function testSuperdrugSelectors(url) {
    console.log('🧪 Testing Superdrug selectors on:', url);
    
    const browser = await puppeteer.launch({ 
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport({ width: 1280, height: 720 });
        
        // Navigate to the product page
        console.log('📱 Navigating to page...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for key elements
        console.log('⏳ Waiting for product elements...');
        await page.waitForSelector('e2-product-details-title', { timeout: 10000 });
        
        // Test the selectors
        console.log('🔍 Testing selectors...');
        const results = await page.evaluate(() => {
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
        
        // Wait a bit to see the results
        console.log('\n⏰ Waiting 10 seconds before closing...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        await browser.close();
    }
}

// Main execution
if (require.main === module) {
    const url = process.argv[2];
    if (!url) {
        console.error('❌ Please provide a Superdrug product URL');
        console.log('Usage: node test_superdrug_selectors.js <product_url>');
        process.exit(1);
    }
    
    testSuperdrugSelectors(url).catch(console.error);
}

module.exports = { testSuperdrugSelectors };
