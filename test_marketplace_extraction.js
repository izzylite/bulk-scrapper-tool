#!/usr/bin/env node
'use strict';

/**
 * Test script for marketplace custom field extraction
 * Tests the custom vendor field implementation on a real Superdrug marketplace URL
 */

try { require('dotenv').config(); } catch { }

const { extractGeneric } = require('./tools/strategies/generic');
const SessionManager = require('./tools/utils/manager/sessionManager');

// Load Stagehand in a way that works for both ESM and CJS builds
async function loadStagehandCtor() {
    const mod = await import('@browserbasehq/stagehand');
    return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

async function testMarketplaceExtraction() {
    console.log('🧪 Testing Marketplace Custom Field Extraction with SessionManager\n');
    
    // Test URL - default Superdrug marketplace product; can be overridden via --url
    const argUrl = process.argv.slice(2).find(a => a.startsWith('--url='))?.slice('--url='.length)
        || process.argv.slice(2).find(a => /^https?:\/\//i.test(a));
    const testUrl = argUrl || 'https://www.superdrug.com/skin/face-skin-care/face-serums/shiseido-vital-perfection-liftdefine-radiance-serum-80ml/p/mp-00108744';
    
    console.log(`🎯 Target URL: ${testUrl}`);
    const skuFromUrl = (testUrl.match(/\/p\/(mp-[^\/?#]+)/i) || [])[1] || 'mp-unknown';
    console.log(`📋 Expected: Marketplace product (${skuFromUrl} indicates marketplace)`);
    
    const StagehandCtor = await loadStagehandCtor();
    let sessionManager = null;
    let workerSessionManager = null;
    
    try {
        // Initialize SessionManager with logging function
        console.log('\n🤖 Initializing SessionManager with proxy rotation and stealth features...');
        
        const logError = (type, data) => {
            console.log(`[LOG] ${type}:`, JSON.stringify(data, null, 2));
        };
        
        sessionManager = new SessionManager();
        sessionManager.initialize(StagehandCtor, logError);
        
        // Create initial Stagehand instance through SessionManager
        console.log('🔄 Creating managed Stagehand session...');
        const initialStagehand = await sessionManager.createStagehandInstanceWithFallback(true); // Enable proxy
        
        // Create worker session manager for this test
        const mockAppendBatch = async (outputPath, metadata, items, processingPath) => {
            console.log(`[BUFFER] Would save ${items.length} items to ${outputPath}`);
        };
        
        workerSessionManager = sessionManager.createWorkerSessionManager(
            initialStagehand, 
            'test-worker-1', 
            mockAppendBatch
        );
        
        console.log('✅ SessionManager initialized successfully');
        
        // Create URL object for extraction
        const urlObj = {
            url: testUrl,
            vendor: 'superdrug',
            sku: skuFromUrl  // Extract SKU from URL for identification
        };
        
        console.log('\n🔄 Navigating to product page with SessionManager...');
        
        // Get configured page through SessionManager (includes performance optimizations)
        const page = await sessionManager.getSafePage(workerSessionManager, {
            blockImages: false, // Allow images for this test to see all content
            blockStyles: false,  // Allow styles for proper rendering
            blockScripts: false  // Allow scripts for dynamic content
        });
        
        console.log('✅ Managed page configured with performance optimizations');
        
        // Navigate with realistic options
        await page.goto(testUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 45000,
            referer: 'https://www.google.com/'
        });
        console.log('✅ Page loaded successfully');
        
        // Wait with random delay to appear more human-like
        const randomDelay = Math.floor(Math.random() * 3000) + 2000; // 2-5 seconds
        console.log(`⏳ Waiting ${randomDelay}ms for content to settle...`);
        await page.waitForTimeout(randomDelay);
        
        // Check if we hit an access denied page
        const pageTitle = await page.title();
        const pageContent = await page.textContent('body').catch(() => '');
        
        if (pageTitle.includes('Access Denied') || pageContent.includes('Access Denied') || pageContent.includes('Reference #')) {
            console.log('⚠️  Detected access denied page - but continuing with extraction to test marketplace detection...');
        }
        
        console.log('\n🔍 Starting product extraction...');
        const startTime = Date.now();
        
        // Run extraction using our custom field system
        const extractedProduct = await extractGeneric(page, urlObj);
        
        const endTime = Date.now();
        console.log(`✅ Extraction completed in ${endTime - startTime}ms\n`);
        
        // Display results
        console.log('📊 EXTRACTION RESULTS:');
        console.log('=' .repeat(50));
        
        // Basic product info
        console.log(`🏷️  Product Name: ${extractedProduct.name || 'N/A'}`);
        console.log(`💰 Price: ${extractedProduct.price || 'N/A'}`);
        console.log(`📦 Stock Status: ${extractedProduct.stock_status || 'N/A'}`);
        console.log(`🔗 Product URL: ${extractedProduct.product_url || 'N/A'}`);
        
        // Sections extracted
        console.log('\n📄 SECTIONS:');
        console.log('-'.repeat(30));
        console.log(`🧩 Features:\n${extractedProduct.features || 'N/A'}`);
        console.log(`\n📑 Product Specification:\n${extractedProduct.product_specification || 'N/A'}`);

        // Custom vendor fields focus
        console.log('\n🎯 CUSTOM VENDOR FIELDS:');
        console.log('-'.repeat(30));
        
        // Check for marketplace field specifically
        if (extractedProduct.marketplace !== undefined) {
            const marketplaceStatus = extractedProduct.marketplace ? '✅ TRUE' : '❌ FALSE';
            console.log(`🏪 Marketplace: ${marketplaceStatus}`);
            
            if (extractedProduct.marketplace) {
                console.log('   → This product is sold via Superdrug Marketplace');
            } else {
                console.log('   → This product is sold directly by Superdrug');
            }
        } else {
            console.log('❓ Marketplace: NOT DETECTED/EXTRACTED');
        }
        
        // Show any other custom fields
        const customFields = ['brand', 'ingredients', 'skin_type', 'product_code', 'features', 'product_specification'];
        customFields.forEach(field => {
            if (extractedProduct[field] !== undefined && extractedProduct[field] !== null && extractedProduct[field] !== '') {
                console.log(`📋 ${field}: ${extractedProduct[field]}`);
            }
        });
        
        // Full extraction summary
        console.log('\n📈 EXTRACTION SUMMARY:');
        console.log('-'.repeat(30));
        console.log(`🔢 Total fields extracted: ${Object.keys(extractedProduct).length}`);
        console.log(`📋 Vendor: ${extractedProduct.vendor || 'N/A'}`);
        console.log(`🆔 UUID: ${extractedProduct.uuid || 'N/A'}`);
        console.log(`⏰ Extracted at: ${extractedProduct.extracted_at || 'N/A'}`);
        
        // Validate marketplace detection
        console.log('\n🧪 MARKETPLACE DETECTION VALIDATION:');
        console.log('-'.repeat(40));
        
        const urlContainsMP = testUrl.includes('mp-');
        const marketplaceDetected = extractedProduct.marketplace === true;
        
        console.log(`🔍 URL contains 'mp-': ${urlContainsMP ? '✅ YES' : '❌ NO'}`);
        console.log(`🤖 AI detected marketplace: ${marketplaceDetected ? '✅ YES' : '❌ NO'}`);
        
        if (urlContainsMP && marketplaceDetected) {
            console.log('🎉 SUCCESS: Marketplace detection working correctly!');
        } else if (urlContainsMP && !marketplaceDetected) {
            console.log('⚠️  WARNING: Marketplace product not detected by AI');
        } else if (!urlContainsMP && marketplaceDetected) {
            console.log('⚠️  WARNING: Non-marketplace product detected as marketplace');
        } else {
            console.log('✅ CONSISTENT: Both URL and AI indicate non-marketplace');
        }
        
        // Raw data for debugging
        if (process.env.DEBUG) {
            console.log('\n🐛 RAW EXTRACTION DATA:');
            console.log(JSON.stringify(extractedProduct, null, 2));
        } else {
            console.log('\n💡 Run with DEBUG=1 to see full raw extraction data');
        }
        
        console.log('\n✨ Test completed successfully!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    } finally {
        if (workerSessionManager) {
            try {
                console.log('🔄 Flushing session buffer...');
                await workerSessionManager.flushBuffer();
                
                console.log('🔒 Closing managed session...');
                await workerSessionManager.close();
                console.log('✅ SessionManager cleanup completed');
            } catch (closeError) {
                console.error('Error during SessionManager cleanup:', closeError.message);
            }
        }
        
        if (sessionManager) {
            try {
                const stats = sessionManager.getSessionPoolStats();
                console.log('📊 Session pool stats:', stats);
            } catch (error) {
                console.error('Error getting session stats:', error.message);
            }
        }
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
    console.log(`
🧪 Marketplace Custom Field Extraction Test

Usage: node test_marketplace_extraction.js [options]

Options:
  --help, -h     Show this help message
  
Environment Variables:
  DEBUG=1        Show raw extraction data
  BROWSERBASE_API_KEY     Your Browserbase API key
  BROWSERBASE_PROJECT_ID  Your Browserbase project ID
  
Example:
  node test_marketplace_extraction.js
  DEBUG=1 node test_marketplace_extraction.js
    `);
    process.exit(0);
}

// Check required environment variables
if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    console.error('❌ Error: Missing required environment variables');
    console.error('Please set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID');
    console.error('');
    console.error('Create a .env file with:');
    console.error('BROWSERBASE_API_KEY=your_api_key_here');
    console.error('BROWSERBASE_PROJECT_ID=your_project_id_here');
    process.exit(1);
}

// Run the test
if (require.main === module) {
    testMarketplaceExtraction().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}

module.exports = { testMarketplaceExtraction };
