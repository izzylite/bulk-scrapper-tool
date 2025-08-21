#!/usr/bin/env node
'use strict';

/**
 * Test script to verify the new selector learning coordination
 * This simulates what happens in the actual stagehand_product_extractor.js
 */

try { require('dotenv').config(); } catch { }

const { extractGeneric } = require('./tools/strategies/generic');
const SessionManager = require('./tools/utils/manager/sessionManager');
const selectorLearning = require('./tools/utils/selectorLearning');

// Load Stagehand in a way that works for both ESM and CJS builds
async function loadStagehandCtor() {
    const mod = await import('@browserbasehq/stagehand');
    return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

async function testLearningCoordination() {
    console.log('🧪 Testing Selector Learning Coordination\n');
    
    // Test URL - Superdrug marketplace product
    const testUrl = 'https://www.superdrug.com/skin/face-skin-care/face-serums/shiseido-vital-perfection-liftdefine-radiance-serum-80ml/p/mp-00108744';
    
    console.log(`🎯 Target URL: ${testUrl}`);
    console.log(`📋 Testing learning coordination between extraction and learning modules`);
    
    const StagehandCtor = await loadStagehandCtor();
    let sessionManager = null;
    let workerSessionManager = null;
    
    try {
        // Initialize SessionManager
        console.log('\n🤖 Initializing SessionManager...');
        
        const logError = (type, data) => {
            console.log(`[LOG] ${type}:`, JSON.stringify(data, null, 2));
        };
        
        sessionManager = new SessionManager();
        sessionManager.initialize(StagehandCtor, logError);
        
        // Create initial Stagehand instance
        console.log('🔄 Creating managed Stagehand session...');
        const initialStagehand = await sessionManager.createStagehandInstanceWithFallback(true);
        
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
            sku: 'mp-00108744'
        };
        
        console.log('\n🔄 Starting extraction and learning coordination test...');
        
        // Get configured page
        const page = await sessionManager.getSafePage(workerSessionManager, {
            blockImages: false,
            blockStyles: false,
            blockScripts: false
        });
        
        // Navigate to page
        await page.goto(testUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 45000,
            referer: 'https://www.google.com/'
        });
        console.log('✅ Page loaded successfully');
        
        // Wait briefly
        await page.waitForTimeout(2000);
        
        // Step 1: Check if learning is active (should be false initially)
        console.log('\n📊 Pre-extraction learning status:');
        const preStats = selectorLearning.getLearningStats();
        console.log(`  Active learning task: ${preStats.isActive ? 'Yes' : 'No'}`);
        console.log(`  Pending vendors: ${preStats.pendingVendors}`);
        console.log(`  Total pending fields: ${preStats.totalPendingFields}`);
        
        // Step 2: Run extraction (this will report fields for learning)
        console.log('\n🔍 Running extraction (will report fields)...');
        const extractedProduct = await extractGeneric(page, urlObj);
        
        // Step 3: Check learning status after extraction
        console.log('\n📊 Post-extraction learning status:');
        const postStats = selectorLearning.getLearningStats();
        console.log(`  Active learning task: ${postStats.isActive ? 'Yes' : 'No'}`);
        console.log(`  Pending vendors: ${postStats.pendingVendors}`);
        console.log(`  Total pending fields: ${postStats.totalPendingFields}`);
        
        // Step 4: Simulate what happens in processBucket - check and wait for learning
        if (selectorLearning.isLearningActive()) {
            console.log('\n⏳ Learning is active, waiting for completion...');
            await selectorLearning.waitForLearningCompletion();
            console.log('✅ Learning task completed');
        }
        
        // Step 5: Process pending learning (this simulates the call in processBucket)
        console.log('\n🧠 Processing pending selector learning...');
        try {
            const learningPromise = selectorLearning.processPendingSelectorLearning(page, urlObj.vendor, extractedProduct);
            
            // Check if learning is now active
            console.log('\n📊 During learning status:');
            const duringStats = selectorLearning.getLearningStats();
            console.log(`  Active learning task: ${duringStats.isActive ? 'Yes' : 'No'}`);
            console.log(`  Pending vendors: ${duringStats.pendingVendors}`);
            console.log(`  Total pending fields: ${duringStats.totalPendingFields}`);
            
            // Wait for learning to complete
            await learningPromise;
            console.log('✅ Selector learning completed');
            
        } catch (learningError) {
            console.log(`❌ Selector learning failed: ${learningError.message}`);
        }
        
        // Step 6: Check final learning status
        console.log('\n📊 Final learning status:');
        const finalStats = selectorLearning.getLearningStats();
        console.log(`  Active learning task: ${finalStats.isActive ? 'Yes' : 'No'}`);
        console.log(`  Pending vendors: ${finalStats.pendingVendors}`);
        console.log(`  Total pending fields: ${finalStats.totalPendingFields}`);
        
        // Step 7: Verify extraction results
        console.log('\n📊 EXTRACTION VERIFICATION:');
        console.log(`🏷️  Product Name: ${extractedProduct.name || 'N/A'}`);
        console.log(`💰 Price: ${extractedProduct.price || 'N/A'}`);
        console.log(`🏪 Marketplace: ${extractedProduct.marketplace ? '✅ TRUE' : '❌ FALSE'}`);
        
        console.log('\n✨ Learning coordination test completed successfully!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    } finally {
        if (workerSessionManager) {
            try {
                console.log('\n🔄 Cleaning up...');
                await workerSessionManager.close();
                console.log('✅ Cleanup completed');
            } catch (closeError) {
                console.error('Error during cleanup:', closeError.message);
            }
        }
    }
}

// Check required environment variables
if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    console.error('❌ Error: Missing required environment variables');
    console.error('Please set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID');
    process.exit(1);
}

// Run the test
if (require.main === module) {
    testLearningCoordination().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}

module.exports = { testLearningCoordination };
