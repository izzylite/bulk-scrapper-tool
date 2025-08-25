#!/usr/bin/env node
'use strict';

// Increase max listeners to handle multiple browser sessions
process.setMaxListeners(50);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
try { require('dotenv').config(); } catch { }
const { z } = require('zod');
const { withFileLock, removeUrlsFromProcessingFile, updateErrorsInProcessingFile, findActiveProcessingFile, cleanupProcessingFile, validateProcessingFileStructure } = require('./tools/utils/manager/files/pendingManager');
const inputManager = require('./tools/utils/manager/files/inputManager');
const outputManager = require('./tools/utils/manager/files/outputManager');
const updateManager = require('./tools/utils/manager/updateManager');
const SessionManager = require('./tools/utils/manager/sessionManager');
const cacheManager = require('./tools/utils/cache/cacheManager');
const { extractGeneric } = require('./tools/strategies/generic');
const selectorLearning = require('./tools/utils/selectorLearning');
const { logError, logErrorWithDetails, getLogStats } = require('./tools/utils/logUtil');
// Load Stagehand in a way that works for both ESM and CJS builds
async function loadStagehandCtor() {
    const mod = await import('@browserbasehq/stagehand');
    return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

// Logging utilities are now imported from logUtil.js

// Initialize SessionManager instance
const sessionManager = new SessionManager();

function parseArgs(argv) {
    const args = { batch: 20, batches: 1, limit: 100, update: false, vendors: [], updateFields: null, updateKey: null, staleDays: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (a === '--batch' || a === '-b') { const n = parseInt(argv[i + 1], 10); if (!Number.isNaN(n) && n > 0) args.batch = n; i++; continue; }
        if (a.startsWith('--batch=')) { const n = parseInt(a.slice('--batch='.length), 10); if (!Number.isNaN(n) && n > 0) args.batch = n; continue; }
        if (a === '--batches' || a === '-c') { const n = parseInt(argv[i + 1], 10); if (!Number.isNaN(n) && n > 0) args.batches = n; i++; continue; }
        if (a.startsWith('--batches=')) { const n = parseInt(a.slice('--batches='.length), 10); if (!Number.isNaN(n) && n > 0) args.batches = n; continue; }
        if (a === '--limit' || a === '-l') { const n = parseInt(argv[i + 1], 10); if (!Number.isNaN(n) && n > 0) args.limit = n; i++; continue; }
        if (a.startsWith('--limit=')) { const n = parseInt(a.slice('--limit='.length), 10); if (!Number.isNaN(n) && n > 0) args.limit = n; continue; }
        if (a === '--update') { args.update = true; continue; }
        if (a.startsWith('--vendor=')) { const v = a.slice('--vendor='.length); args.vendors = v.split(',').map(s => s.trim()).filter(Boolean); continue; }
        if (a === '--vendor') { const v = argv[i + 1]; if (v) { args.vendors = v.split(',').map(s => s.trim()).filter(Boolean); } i++; continue; }
        if (a.startsWith('--update-fields=')) { const f = a.slice('--update-fields='.length); args.updateFields = f.split(',').map(s => s.trim()).filter(Boolean); continue; }
        if (a === '--update-fields') { const f = argv[i + 1]; if (f) { args.updateFields = f.split(',').map(s => s.trim()).filter(Boolean); } i++; continue; }
        if (a.startsWith('--update-key=')) { args.updateKey = a.slice('--update-key='.length).trim(); continue; }
        if (a === '--update-key') { const k = argv[i + 1]; if (k) { args.updateKey = k.trim(); } i++; continue; }
        if (a.startsWith('--stale-days=')) { const d = parseInt(a.slice('--stale-days='.length), 10); if (!Number.isNaN(d) && d >= 0) args.staleDays = d; continue; }
        if (a === '--stale-days') { const d = parseInt(argv[i + 1], 10); if (!Number.isNaN(d) && d >= 0) args.staleDays = d; i++; continue; }
    }
    return args;
}

// Enhanced blocking check that considers extraction results and incomplete data
async function isBlocked(page, result) {
    try {
        const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
        const urlNow = page.url?.() || '';
        const blockedRx = /(access denied|forbidden|verify you are a human|unusual traffic|captcha|blocked|attention required)/i;

        // Direct blocking indicators
        if (blockedRx.test(text) || /captcha/i.test(urlNow)) return true;

        // Check for incomplete/suspicious extraction patterns
        const allEmpty = !result?.name && !result?.main_image && !result?.price && !result?.product_url;
        const incompleteExtraction = result?.metadata?.completed === false;
        const noImages = !result?.main_image && (!result?.images || result.images.length === 0);

        // Consider blocked if extraction is incomplete AND page has suspicious indicators
        if ((allEmpty || incompleteExtraction || noImages) && blockedRx.test(text)) {
            return true;
        }

        // Also check for severely incomplete extraction even without explicit blocking text
        if (incompleteExtraction && noImages && !result?.name && !result?.price) {
            console.log('[BLOCKING] Detected severely incomplete extraction, likely blocked');
            return true;
        }

        return false;
    } catch { return false; }
}

async function navigateWithRetry(page, targetUrl, workerId, workerSessionManager = null, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`[SESSION ${workerId}] Navigating to page (attempt ${attempt}/${maxAttempts})`);
            const start = Date.now();
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const end = Date.now();
            console.log(`[SESSION ${workerId}] Navigated to page in ${end - start}ms`);
            return;
        } catch (err) {
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            lastError = err;
            const message = String(err && err.message ? err.message : err || 'unknown error');
            const isTerminationError = /terminated|session.*closed|browser.*closed|connection.*closed|target.*closed/i.test(message);
            if (isTerminationError) {
                console.log(`[NAVIGATE] Session terminated during navigation: ${message}`);
                const terminationError = new Error(`Session terminated: ${message}`);
                terminationError.isTermination = true;
                terminationError.originalError = err;
                throw terminationError;
            }
            console.log(`[NAVIGATE] Attempt ${attempt}/${maxAttempts} failed: ${attempt >= maxAttempts ? message : 'Error, retrying...'}`);
            if (attempt < maxAttempts) { await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
        }
    }
    throw lastError;
}

async function extractWithStagehand(workerSessionManager, urlObj, pageOverride, updateCtx = null) {
    const url = urlObj.url;
    let page = pageOverride || await sessionManager.getSafePage(workerSessionManager);
    const workerId = workerSessionManager.getWorkerId();
    try { await navigateWithRetry(page, url, workerId, workerSessionManager); }
    catch (err) {
        if (err.isTermination) {
            console.log(`[SESSION ${workerId}] Session terminated during navigation, rotating...`);
            logError('navigation_termination', { source_url: url, error: err.message });
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            await workerSessionManager.rotate('navigation_terminated');
            page = await sessionManager.getSafePage(workerSessionManager);
            await navigateWithRetry(page, url, workerId, workerSessionManager);
        } else { throw err; }
    }
    if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');

    try {
        console.log(`[SESSION ${workerId}] Extracting product...`);
        const start = Date.now();
        const item = await extractGeneric(page, urlObj, updateCtx);
        const end = Date.now();
        console.log(`[SESSION ${workerId}] Extracted product in ${end - start}ms`);
        const blocked = await isBlocked(page, item);
        if (blocked) {
            logError('blocked_detected_after_extract', { product_id: item.product_id, vendor: item.vendor });
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            await workerSessionManager.rotate('blocked_after_extract');
            page = await sessionManager.getSafePage(workerSessionManager);
            await navigateWithRetry(page, url, workerId, workerSessionManager);
            const product2 = await extractGeneric(page, urlObj, updateCtx);
            logError('blocked_retry_success', { product_id: product2.product_id, vendor: product2.vendor });
            return { ...product2, retried: true };
        }
        const hasCore = item && item.name && item.price;
        const cssBlocked = (sessionManager.pagePerfConfig.get(page)?.blockStyles === true);
        if (!hasCore && cssBlocked && !item?.retried_css) {
            console.log('[RETRY] Missing core fields; retrying with CSS enabled...');
            await sessionManager.configurePagePerformance(workerSessionManager, { blockStyles: false });
            await navigateWithRetry(page, url, workerId, workerSessionManager);
            const itemCss = await extractGeneric(page, urlObj, updateCtx);
            return { ...itemCss, retried_css: true };
        }
        return item;
    } catch (err) {
        if (err && typeof err === 'object') { try { err.meta = { source_url: url }; } catch { } }
        const msg = String(err && err.message ? err.message : err || '');
        if (/uninitialized|createTarget|closed|Target\.createTarget|terminated|session.*closed|browser.*closed|connection.*closed/i.test(msg)) {
            logError('session_restart_after_error', { source_url: url, error: msg });
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            await workerSessionManager.rotate('extract_error');
            page = await sessionManager.getSafePage(workerSessionManager);
            await navigateWithRetry(page, url, workerId, workerSessionManager);
            const product3 = await extractGeneric(page, urlObj, updateCtx);
            return { ...product3, retried: true };
        }
        throw err;
    }
}

function chunkArray(array, size) { const chunks = []; for (let i = 0; i < array.length; i += size) { chunks.push(array.slice(i, i + size)); } return chunks; }

// Register signal handlers
process.on('SIGINT', () => { sessionManager.setShuttingDown(true); sessionManager.gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { sessionManager.setShuttingDown(true); sessionManager.gracefulShutdown('SIGTERM'); });

 
async function appendBatchToOutput(outputPath, meta, batchItems, processingFilePath) {
    const successfulItems = (batchItems || []).filter(item => item && !item.error);
    const errorItems = (batchItems || []).filter(item => item && item.error);

    // Enrich meta from processing file (mode, vendor, update fields)
    let processingData = null;
    try { if (processingFilePath && fs.existsSync(processingFilePath)) { processingData = JSON.parse(fs.readFileSync(processingFilePath, 'utf8')); } } catch { }
    const mode = (processingData && processingData.mode) || meta.mode;
    const vendor = (processingData && processingData.vendor) || meta.vendor;
    const updateKey = (processingData && processingData.update_key) || meta.update_key || updateManager.getContext().updateKey;
    const updateFields = (processingData && processingData.update_fields) || meta.update_fields || updateManager.getContext().updateFields;
    const inputFileName = (processingData && Array.isArray(processingData.source_files) && processingData.source_files[0]) || meta.inputFileName;

    console.log(`[APPEND] Appending ${successfulItems.length} ${mode === 'update' ? 'updated snapshots' : 'successful items'} to output`);

    let result;
    if (mode === 'update') {
        const mergedSnapshots = updateManager.mergeSnapshots(successfulItems, updateKey, updateFields);
        result = outputManager.appendItemsToUpdateFile(outputPath, mergedSnapshots, { vendor, sourceFile: meta.source_file, inputFileName });
    } else {
        result = outputManager.appendItemsToOutputFile(outputPath, successfulItems, { vendor, sourceFile: meta.source_file, inputFileName });
    }

    const operations = [];
    if (processingFilePath && fs.existsSync(processingFilePath)) {
        if (successfulItems.length > 0) {
            const successUrls = successfulItems.map(item => item.source_url);
            operations.push(removeUrlsFromProcessingFile(processingFilePath, successUrls).then(() => console.log(`[APPENDED] (+${successUrls.length} items successfully processed and recorded)`)));
        }
        if (errorItems.length > 0) { operations.push(updateErrorsInProcessingFile(processingFilePath, errorItems).then(() => console.log(`[ERRORS] ${errorItems.length} URLs failed extraction (errors recorded in processing file)`))); }
    }
    if (operations.length > 0) { await Promise.all(operations); }
    return result;
}

async function processScrapperWorkflow(stagehandCtor, batchSize, maxConcurrentBatches = 1, totalLimit = Infinity, cli = {}) {
    sessionManager.initialize(stagehandCtor, logError);

    try {
        // Prepare update-mode if requested
        if (cli.update) { await updateManager.prepareUpdateModeIfNeeded(cli); }

        // Step 1: Check for active processing file
        console.log('[WORKFLOW] Checking for active processing files...');
        let activeProcessingFile = findActiveProcessingFile();

        if (!activeProcessingFile) {
            console.log('[WORKFLOW] No active processing file found, checking input directory...');
            try {
                const processingFilePath = inputManager.processInputDirectory();
                console.log(`[WORKFLOW] Created processing file: ${path.basename(processingFilePath)}`);
                activeProcessingFile = findActiveProcessingFile();
                if (!activeProcessingFile) { throw new Error('Failed to find newly created processing file'); }
            } catch (err) {
                if (err.message.includes('No input files found')) {
                    console.log('[WORKFLOW] No input files found in scrapper/input directory');
                    console.log('[WORKFLOW] Please add JSON files to scrapper/input directory to begin processing');
                    return;
                }
                throw err;
            }
        }

        console.log(`[WORKFLOW] Processing active file: ${activeProcessingFile.name} (vendor: ${activeProcessingFile.vendor})`);

        let processingData;
        try {
            const rawData = fs.readFileSync(activeProcessingFile.path, 'utf8');
            processingData = JSON.parse(rawData);
            if (!validateProcessingFileStructure(processingData)) { throw new Error('Invalid processing file structure'); }
        } catch (err) {
            console.error(`[ERROR] Failed to read/validate processing file: ${err.message}`);
            return;
        }

        const inputFileName = (processingData.source_files && processingData.source_files.length > 0) ? processingData.source_files[0] : activeProcessingFile.name;
        let outputPath;
        if (processingData.mode === 'update') {
            outputPath = outputManager.createUpdateOutputFile(processingData.vendor, activeProcessingFile.name, inputFileName);
        } else {
            // Step 4: Set up output file using outputManager
            // Use the first original input filename, or fallback to processing filename
            outputPath = outputManager.createOutputFile(processingData.vendor, activeProcessingFile.name, inputFileName);
        }
        console.log(`[WORKFLOW] Output will be saved to: ${outputPath}`);

        const itemsToProcess = processingData.items || [];
        const limitedItems = Number.isFinite(totalLimit) ? itemsToProcess.slice(0, Math.max(0, totalLimit)) : itemsToProcess;
        const totalBatches = chunkArray(limitedItems, batchSize);
        console.log(`[START] Processing ${limitedItems.length} items in ${totalBatches.length} batches of up to ${batchSize}`);
        console.log(`[PROGRESS] ${processingData.processed_count || 0}/${processingData.total_count || 0} items already processed`);

        let nextBatch = 0;
        const sessionManagers = await sessionManager.createMultipleSessionManagers(maxConcurrentBatches, appendBatchToOutput);

        const workers = sessionManagers.map(async (workerSessionManager) => {
            const workerId = workerSessionManager.getWorkerId();
            try {
                while (nextBatch < totalBatches.length) {
                    const idx = nextBatch++;
                    const batchItems = totalBatches[idx];
                    console.log(`[SESSION ${workerId}] Processing ${batchItems.length} urls in batch ${idx + 1}/${totalBatches.length}`);
                    if (sessionManager.getShuttingDown()) break;
                    workerSessionManager.registerBuffer(outputPath, activeProcessingFile.name, activeProcessingFile.path);
                    const processed = await processBucket(workerSessionManager, batchItems);
                    try { await workerSessionManager.flushBuffer(); } catch { }
                    if (sessionManager.getShuttingDown()) break;
                    console.log(`[SESSION ${workerId}] Successfully processed batch ${idx + 1}/${totalBatches.length} (items: ${processed})`);
                }
            } catch (workerError) {
                console.log(`[SESSION ${workerId}] Worker error:`, workerError.message);
                throw workerError;
            } finally {
                try { await workerSessionManager.flushBuffer(); } catch { }
                console.log(`[SESSION ${workerId}] Closing session...`);
                try { await workerSessionManager.close(); } catch (e) { console.log(`[SESSION ${workerId}] Error closing session:`, e.message); }
            }
        });

        await Promise.all(workers);

        console.log(`[CLEANUP] Processing file cleanup`);
        cleanupProcessingFile(activeProcessingFile.path, activeProcessingFile.name);
        console.log(`[DONE] Completed processing for vendor: ${processingData.vendor}`);
        const summary = outputManager.getVendorSummary(processingData.vendor);
        console.log(`[SUMMARY] Vendor: ${summary.vendor}, Files: ${summary.totalFiles}, Successful Items: ${summary.totalItems}`);

    } finally { }
}

async function processBucket(workerSessionManager, objectsSubset) {
    let processedCount = 0;
    let variantAttempts = 0;
    let page = await sessionManager.getSafePage(workerSessionManager);
    const updateCtx = (updateManager.getContext && updateManager.getContext()) || null;
    for (let i = 0; i < objectsSubset.length; i++) {
        const urlObj = objectsSubset[i];
        const workerId = workerSessionManager.getWorkerId();

        if (sessionManager.getShuttingDown()) break;
        try {
            // Wait for any active learning task to complete before proceeding
            if (selectorLearning.isLearningActive()) {
                await selectorLearning.waitForLearningCompletion();
            }
            let item = null;
            // Check if this URL has variants
            if (Array.isArray(urlObj.variants) && urlObj.variants.length > 0) {

                console.log(`[SESSION ${workerId}] Found ${urlObj.variants.length} variants, extracting main + variants...`);

                // Create sub-iteration including main object + variants
                const allUrls = [
                    { ...urlObj, isMainProduct: true }, // Main product
                    ...urlObj.variants.map(variant => ({
                        url: variant.url,
                        vendor: urlObj.vendor,
                        image_url: variant.image_url,
                        sku: variant.sku_id,
                        isVariant: true,
                        variantOf: urlObj.url
                    }))
                ];

                const variantExtractions = [];
                let mainProduct = null;

                // Extract all URLs (main + variants)
                for (let j = 0; j < allUrls.length; j++) {
                    if (sessionManager.getShuttingDown()) break; // Add shutdown check inside variant loop
                    const currentUrl = allUrls[j];
                    console.log(`[SESSION ${workerId}] Extracting ${currentUrl.isMainProduct ? 'main product' : `variant ${j}/${urlObj.variants.length}`}`);

                    const extractedItem = await extractWithStagehand(workerSessionManager, currentUrl, page, updateCtx);

                    if (currentUrl.isMainProduct) {
                        mainProduct = extractedItem;
                    } else {
                        variantExtractions.push({
                            ...extractedItem,
                        });
                    }
                }

                // Update main product with variant data
                if (mainProduct) {
                    item = {
                        ...mainProduct,
                        variants: variantExtractions,
                        variant_count: variantExtractions.length
                    };

                    workerSessionManager.addItemToBuffer(item);
                    console.log(`[SESSION ${workerId}] Successfully extracted main product with ${variantExtractions.length} variants`);
                } else {
                    throw new Error('Main product extraction failed');
                }
            } else {
                // No variants, process normally
                item = await extractWithStagehand(workerSessionManager, urlObj, page, updateCtx);
                workerSessionManager.addItemToBuffer(item);
                console.log(`[SESSION ${workerId}] Successfully extracted product (no variants)`);
            }

            processedCount++;
            console.log(`[SESSION ${workerId}] Successfully processed item. currentBatchCount ${processedCount}`);

            // Process any pending selector learning for this vendor (async, non-blocking)
            try { await selectorLearning.processPendingSelectorLearning(page, urlObj.vendor, item); }
            catch (learningError) { console.log(`[SESSION ${workerId}] Selector learning failed: ${learningError.message}`); }

        } catch (err) {

            function handleExtractionError(urlObj, errMsg, err, workerSessionManager, processedCount, isVariant = false) {
                console.error('[Extractor] Error for ', isVariant ? 'variant' : 'main product', ' URL:', urlObj.url, '-', errMsg);
                console.log(`[RETRY] URL remains in processing file for future retry: ${urlObj.url}`);
                logError('extract_error', { url: urlObj.url, error: errMsg, ...(err && err.meta ? err.meta : {}) });
                const meta = (err && err.meta) || { product_id: undefined, vendor: undefined, source_url: urlObj.url, extracted_at: new Date().toISOString() };
                const errorItem = { ...meta, error: errMsg };
                workerSessionManager.addItemToBuffer(errorItem);
                processedCount++;
                variantAttempts = 0;
            }


            const errMsg = String(err && err.message ? err.message : err || '');
            // Attempt a one-time session re-init if the stagehand/page appears uninitialized/closed/terminated
            if (/uninitialized|createTarget|closed|Target\.createTarget|Failed to parse server response|terminated|session.*closed|browser.*closed|connection.*closed/i.test(errMsg)) {

                console.log(`[SESSION ${workerId}] Detected session error (${errMsg}), rotating...`);
                try {
                    if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
                    await workerSessionManager.rotate('session_error');
                    page = await sessionManager.getSafePage(workerSessionManager); // Use default page after rotation
                    let item = null;
                    // Retry the entire process (including variants if present) after rotation
                    if (Array.isArray(urlObj.variants) && urlObj.variants.length > 0) {
                        console.log(`[SESSION ${workerId}] Retrying main product with ${urlObj.variants.length} variants after rotation...`);
                        if (variantAttempts > 3) {
                            handleExtractionError(urlObj, errMsg, err, workerSessionManager, processedCount, true);
                            continue;
                        }
                        else {
                            variantAttempts++;
                            // This will re-run the variant logic above
                            i--; // Retry this item
                            continue;
                        }
                    } else {
                        item = await extractWithStagehand(workerSessionManager, urlObj, page, updateCtx);
                        workerSessionManager.addItemToBuffer({ ...item, retried: true });
                    }

                    processedCount++;
                    console.log(`[SESSION ${workerId}] Successfully recovered after session rotation`);
                    console.log(`[SESSION ${workerId}] Successfully extracted product after rotation. currentBatchCount ${processedCount}`);

                    // Process any pending selector learning for this vendor (async, non-blocking)
                    try {
                        await selectorLearning.processPendingSelectorLearning(page, urlObj.vendor, item);
                    } catch (learningError) {
                        console.log(`[SESSION ${workerId}] Selector learning failed after rotation: ${learningError.message}`);
                        // Don't fail the extraction if learning fails
                    }
                    continue;
                } catch (rotateError) {
                    console.log(`[SESSION ${workerId}] Session rotation failed:`, rotateError.message);
                    // Continue with original error handling
                }
            }
            handleExtractionError(urlObj, errMsg, err, workerSessionManager, processedCount);
        }
    }
    return processedCount;
}

async function main() {
    const args = parseArgs(process.argv);
    const { batch, batches, limit } = args;
    const startTs = Date.now();

    console.log('🤖 AI Scrapper - Stagehand Product Extractor');
    console.log('📁 Using scrapper directory structure: input → processing → output');

    const StagehandCtor = await loadStagehandCtor();
    try {
        const concurrentBatches = Math.min(process.env.MAX_BATCH || 5, Number(process.env.MAX_CONCURRENT_BATCHES) || Number(batches) || 1);
        const totalLimit = Number.isFinite(Number(process.env.TOTAL_LIMIT || limit)) ? Number(process.env.TOTAL_LIMIT || limit) : Infinity;

        console.log(`⚙️  Configuration: batch=${batch || 20}, concurrent=${concurrentBatches}, limit=${totalLimit === Infinity ? 'unlimited' : totalLimit}${args.update ? ', mode=update' : ''}${Array.isArray(args.vendors) && args.vendors.length ? `, vendors=${args.vendors.join(',')}` : ''}`);

        await processScrapperWorkflow(StagehandCtor, batch || 20, concurrentBatches, totalLimit, args);
    } catch (err) {
        console.error('❌ [Scrapper] Error:', err && err.message ? err.message : err);
        logError('scrapper_error', { error: String(err && err.message ? err.message : err) });
        process.exitCode = 1;
    } finally {
        const ms = Date.now() - startTs;
        if (ms >= 60000) {
            const minutes = Math.floor(ms / 60000);
            const secondsRemainder = ((ms % 60000) / 1000).toFixed(2);
            console.log(`⏱️  Total duration: ${minutes}m ${secondsRemainder}s`);
        } else {
            const seconds = (ms / 1000).toFixed(2);
            console.log(`⏱️  Total duration: ${seconds}s`);
        }

        const cacheStats = cacheManager.getStats();
        console.log('\n📊 Cache Performance Summary:');
        Object.entries(cacheStats).forEach(([cacheName, stats]) => {
            if (stats.size !== undefined) {
                const hitRatePercent = (stats.hitRate * 100).toFixed(1);
                console.log(`  ${cacheName}: ${stats.size}/${stats.maxSize} entries (~${hitRatePercent}% est. hit rate)`);
            } else {
                console.log(`  ${cacheName}: ${stats.cached ? 'cached' : 'not cached'} (${stats.type})`);
            }
        });

        const learningStats = selectorLearning.getLearningStats();
        console.log('\n🧠 Selector Learning Summary:');
        console.log(`  Active learning task: ${learningStats.isActive ? 'Yes' : 'No'}`);
        console.log(`  Vendors with pending fields: ${learningStats.pendingVendors}`);
        console.log(`  Total pending fields: ${learningStats.totalPendingFields}`);

        const logStats = getLogStats();
        console.log('\n📄 Logging Summary:');
        console.log(`  Log file exists: ${logStats.exists ? 'Yes' : 'No'}`);
        if (logStats.exists) {
            console.log(`  Log entries: ${logStats.entries}`);
            console.log(`  Log file size: ${(logStats.size / 1024).toFixed(2)} KB`);
        }
    }
}

if (require.main === module) { main(); }



