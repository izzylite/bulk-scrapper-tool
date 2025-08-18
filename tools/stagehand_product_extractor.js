#!/usr/bin/env node
'use strict';

// Increase max listeners to handle multiple browser sessions
process.setMaxListeners(50);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractProductWithStrategy } = require('./strategies');
try { require('dotenv').config(); } catch { }
const { z } = require('zod');
const { withFileLock, removeUrlsFromProcessingFile, updateErrorsInProcessingFile, prepareProcessing, cleanupProcessingFile } = require('./utils/resume');
const SessionManager = require('./utils/sessionManager');
// Load Stagehand in a way that works for both ESM and CJS builds
async function loadStagehandCtor() {
    const mod = await import('@browserbasehq/stagehand');
    return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

// Logging utilities
const LOG_DIR = path.resolve(process.cwd(), 'logs');
function logError(event, details) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
        const entry = { ts: new Date().toISOString(), level: 'error', event, ...(details || {}) };
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch { }
}

// Initialize SessionManager instance
const sessionManager = new SessionManager();

 
 

function parseArgs(argv) {
    const args = { dir: '', batch: 20, batches: 1, limit: 100 };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (a === '--dir' || a === '-d') {
            args.dir = argv[i + 1] || '';
            i++;
            continue;
        }
        if (a.startsWith('--dir=')) {
            args.dir = a.slice('--dir='.length);
            continue;
        }
        if (a === '--batch' || a === '-b') {
            const n = parseInt(argv[i + 1], 10);
            if (!Number.isNaN(n) && n > 0) args.batch = n;
            i++;
            continue;
        }
        if (a.startsWith('--batch=')) {
            const n = parseInt(a.slice('--batch='.length), 10);
            if (!Number.isNaN(n) && n > 0) args.batch = n;
            continue;
        }
        if (a === '--batches' || a === '-c') {
            const n = parseInt(argv[i + 1], 10);
            if (!Number.isNaN(n) && n > 0) args.batches = n;
            i++;
            continue;
        }
        if (a.startsWith('--batches=')) {
            const n = parseInt(a.slice('--batches='.length), 10);
            if (!Number.isNaN(n) && n > 0) args.batches = n;
            continue;
        }
        if (a === '--limit' || a === '-l') {
            const n = parseInt(argv[i + 1], 10);
            if (!Number.isNaN(n) && n > 0) args.limit = n;
            i++;
            continue;
        }
        if (a.startsWith('--limit=')) {
            const n = parseInt(a.slice('--limit='.length), 10);
            if (!Number.isNaN(n) && n > 0) args.limit = n;
            continue;
        }
        if (!args.dir && !a.startsWith('-')) {
            // Support positional directory argument
            args.dir = a;
            continue;
        }
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
    // Check if current session is blocked BEFORE attempting navigation (only if workerSessionManager is provided)
    
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`[SESSION ${workerId}] Navigating to page (attempt ${attempt}/${maxAttempts})`);
            const start = Date.now(); 
            
            // Set longer timeout and options for navigation
            await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded', // Don't wait for all resources, just DOM
                timeout: 30000 // 30 second timeout
            });
            
            const end = Date.now();
            console.log(`[SESSION ${workerId}] Navigated to page in ${end - start}ms`);
            return;
        } catch (err) {
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            lastError = err;
            const message = String(err && err.message ? err.message : err || 'unknown error');
            
            // Check if this is a session termination error that needs session rotation
            const isTerminationError = /terminated|session.*closed|browser.*closed|connection.*closed|target.*closed/i.test(message);
            
            if (isTerminationError) {
                console.log(`[NAVIGATE] Session terminated during navigation: ${message}`);
                // Mark this as a termination error so calling code can handle it
                const terminationError = new Error(`Session terminated: ${message}`);
                terminationError.isTermination = true;
                terminationError.originalError = err;
                throw terminationError;
            }
            
            console.log(`[NAVIGATE] Attempt ${attempt}/${maxAttempts} failed: ${attempt >= maxAttempts ? message : 'Error, retrying...'}`);
            
            if (attempt < maxAttempts) { 
                // Add a small delay before retrying
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
        }
    }
    // After exhausting attempts, throw the last error
    throw lastError;
}

async function extractWithStagehand(workerSessionManager, urlObj, pageOverride) {
    const url = urlObj.url;
    
    let page = pageOverride || await sessionManager.getSafePage(workerSessionManager);
    const workerId = workerSessionManager.getWorkerId();
   
    try {
        await navigateWithRetry(page, url, workerId, workerSessionManager);
    } catch (err) {
        // Handle session termination during navigation
        if (err.isTermination) {
            console.log(`[SESSION ${workerId}] Session terminated during navigation, rotating...`);
            try { logError('navigation_termination', { source_url: url, error: err.message }); } catch { }
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            await workerSessionManager.rotate('navigation_terminated');
            
            page = await sessionManager.getSafePage(workerSessionManager);
            await navigateWithRetry(page, url, workerId, workerSessionManager);
        } else {
            throw err;
        }
    }
   
    if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
    
    
    // Wait for likely product UI anchors rather than sleeping

 
    try {
        console.log(`[SESSION ${workerId}] Extracting product...`);
        const start = Date.now();
        const item = await extractProductWithStrategy(page, urlObj);
        const end = Date.now();
        console.log(`[SESSION ${workerId}] Extracted product in ${end - start}ms`); 
        const blocked = await isBlocked(page, item);
        if (blocked) {
            try { logError('blocked_detected_after_extract', { product_id: item.product_id, vendor: item.vendor }); } catch { }
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            await workerSessionManager.rotate('blocked_after_extract');
            
            page = await sessionManager.getSafePage(workerSessionManager); // Use default page instead of creating new one
            await navigateWithRetry(page, url, workerId, workerSessionManager);
            const product2 = await extractProductWithStrategy(page, urlObj);
            try { logError('blocked_retry_success', { product_id: product2.product_id, vendor: product2.vendor }); } catch { }
            return { ...product2, retried: true };
        }
        // Validate required fields; if missing and CSS is currently blocked, retry once with CSS allowed
        const hasCore = item && item.name && item.price;
        const cssBlocked = (sessionManager.pagePerfConfig.get(page)?.blockStyles === true);
        if (!hasCore && cssBlocked && !item?.retried_css) {
            console.log('[RETRY] Missing core fields; retrying with CSS enabled...');
            await sessionManager.configurePagePerformance(workerSessionManager, { blockStyles: false});
            await navigateWithRetry(page, url, workerId, workerSessionManager);
            const itemCss = await extractProductWithStrategy(page, urlObj);
            return { ...itemCss, retried_css: true };
        }
        return item;
    } catch (err) {
        if (err && typeof err === 'object') { try { err.meta = { source_url: url }; } catch { } }
        const msg = String(err && err.message ? err.message : err || '');
        if (/uninitialized|createTarget|closed|Target\.createTarget|terminated|session.*closed|browser.*closed|connection.*closed/i.test(msg)) {
            try { logError('session_restart_after_error', { source_url: url, error: msg }); } catch { }
            if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
            await workerSessionManager.rotate('extract_error');
            page = await sessionManager.getSafePage(workerSessionManager); // Use default page instead of creating new one
            await navigateWithRetry(page, url, workerId, workerSessionManager);
            const product3 = await extractProductWithStrategy(page, urlObj);
            return { ...product3, retried: true };
        }
        throw err;
    }
}

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

function resolveDirectoryJsonFiles(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const inputJsons = entries
        .filter(d => d.isFile() && /\.json$/i.test(d.name) &&
            !/^output-index-\d+\.json$/i.test(d.name) &&
            !d.name.includes('.processing.json') &&
            !d.name.includes('.output.json'))
        .map(d => ({
            path: path.join(dirPath, d.name),
            name: d.name
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return inputJsons;
}



function readJsonIfExists(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const txt = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(txt);
    } catch { return null; }
}

// Register signal handlers
process.on('SIGINT', () => { sessionManager.setShuttingDown(true); sessionManager.gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { sessionManager.setShuttingDown(true); sessionManager.gracefulShutdown('SIGTERM'); });

const providers = {
    packetstream: { type: 'external', server: "http://proxy.packetstream.io:31112", username: process.env.PS_USER, password: process.env.PS_PASS },
    // oxylabs: { server: "http://pr.oxylabs.io:7777", user: process.env.OXY_USER, pass: process.env.OXY_PASS },
  };





async function appendBatchToOutput(outputPath, meta, batchItems, processingFilePath) {
    console.log(`[APPEND] Appending ${batchItems.length} items to output file: ${outputPath}`);
    // Separate successful items from errors
    const successfulItems = (batchItems || []).filter(item => item && !item.error);
    const errorItems = (batchItems || []).filter(item => item && item.error);

    // Run file operations in parallel for better performance
    const operations = [];

    // 1) Append only successful results to output file (locked per file)
    if (successfulItems.length > 0) {
        operations.push(
            withFileLock(outputPath, async () => {
                const dir = path.dirname(outputPath);
                try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { }
                let data = readJsonIfExists(outputPath) || {
                    source_file: meta.source_file,
                    created_at: new Date().toISOString(),
                    saved_at: new Date().toISOString(),
                    total_items: 0,
                    items: [],
                };
                if (!Array.isArray(data.items)) data.items = [];
                data.items.push(...successfulItems);
                data.total_items = data.items.length;
                data.saved_at = new Date().toISOString();
                const tmp = outputPath + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
                fs.renameSync(tmp, outputPath);
            })
        );
    }

    // 2) Handle processing file updates in parallel
    if (processingFilePath && fs.existsSync(processingFilePath)) {
        // Remove successful URLs and update errors in parallel
        const successUrls = successfulItems.map(item => item.source_url);
        
        if (successUrls.length > 0) {
            operations.push(
                removeUrlsFromProcessingFile(processingFilePath, successUrls)
                    .then(() => console.log(`[APPENDED] (+${successUrls.length} items successfully extracted and appended to output)`))
            );
        }

        if (errorItems.length > 0) {
            operations.push(
                updateErrorsInProcessingFile(processingFilePath, errorItems)
                    .then(() => console.log(`[ERRORS] ${errorItems.length} URLs failed extraction (errors recorded in processing file)`))
            );
        }
    }

    // Wait for all operations to complete in parallel
    if (operations.length > 0) {
        await Promise.all(operations);
    }
}

async function processDirectoryBatches(stagehandCtor, dirPath, batchSize, maxConcurrentBatches = 1, totalLimit = Infinity) {
    const absDir = path.resolve(dirPath);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`Directory does not exist: ${absDir}`);
    }

    const inputFiles = resolveDirectoryJsonFiles(absDir);
    if (inputFiles.length === 0) {
        throw new Error(`No input .json files found in directory: ${absDir}`);
    }

    // Initialize SessionManager with constructor and logging
    sessionManager.initialize(stagehandCtor, logError);

    try {
        for (const file of inputFiles) {
            let data;
            try {
                const raw = fs.readFileSync(file.path, 'utf8');
                data = JSON.parse(raw);
            } catch (err) {
                console.error(`[SKIP] Failed to read/parse ${file.name}:`, err && err.message ? err.message : err);
                try { logError('read_parse_input_failed', { file: file.name, error: String(err && err.message ? err.message : err) }); } catch { }
                continue;
            }

            // Unified output goes to subdirectory 'output' next to inputs
            const outputUnifiedName = `${path.basename(file.name, path.extname(file.name))}.output.json`;
            const outputDir = path.join(absDir, 'extracted-output');
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const outputUnifiedPath = path.join(outputDir, outputUnifiedName);

            // Improved resume implementation using processing util
            const { processingFileName, processingFilePath, objectsToProcess } = prepareProcessing(absDir, file, data);

            const limitedObjects = Number.isFinite(totalLimit) ? objectsToProcess.slice(0, Math.max(0, totalLimit)) : objectsToProcess;
            const totalBatches = chunkArray(limitedObjects, batchSize);
            console.log(`[START] ${file.name} -> ${totalBatches.length} batches of up to ${batchSize}`);

            // Concurrency limiter for batches
            let nextBatch = 0;

            // Example with 5 workers, 13 batches
            // Start: workers take 0,1,2,3,4 → 5 batches in flight.
            // First to finish takes 5; next to finish takes 6; and so on…
            // Final assignment order might be: [0,1,2,3,4] then [7,5,6,8] then [9,10,11,12] depending on which finished first.


            // Create multiple session managers using SessionManager class
            const sessionManagers = await sessionManager.createMultipleSessionManagers(
                maxConcurrentBatches, 
                appendBatchToOutput
            );

            // Now run the actual workers
            const workers = sessionManagers.map(async (workerSessionManager) => {
                const workerId = workerSessionManager.getWorkerId();
                try {
                    while (nextBatch < totalBatches.length) {
                        const idx = nextBatch++;
                        
                        const batchObjects = totalBatches[idx];
                        console.log(`[SESSION ${workerId}] Processing ${batchObjects.length} urls in batch ${idx + 1}/${totalBatches.length}`);
                        // Register per-worker buffer before processing this batch
                        if (sessionManager.getShuttingDown()) break;
                        workerSessionManager.registerBuffer(outputUnifiedPath, file.name, processingFilePath);
                        // Process all objects sequentially in this single tab
                        const processed = await processBucket(workerSessionManager, batchObjects);
                        // Persist items for this batch via the session buffer
                        try { await workerSessionManager.flushBuffer(); } catch {}
                        if (sessionManager.getShuttingDown()) break;
                        console.log(`[SESSION ${workerId}] Successfully processed batch ${idx + 1}/${totalBatches.length} (items: ${processed})`); 
                   
                    }
                } catch (workerError) {
                    console.log(`[SESSION ${workerId}] Worker error:`, workerError.message);
                    throw workerError;
                } finally {
                    // Attempt to flush any remaining, not yet appended items
                    try { await workerSessionManager.flushBuffer(); } catch {}
                    console.log(`[SESSION ${workerId}] Closing session...`);
                    try { await workerSessionManager.close(); } catch (e) {
                        console.log(`[SESSION ${workerId}] Error closing session:`, e.message);
                    }
                }
            });

            await Promise.all(workers);
            console.log(`[CLEANUP] Processing file cleaned up`);
            // Check if processing file still exists and clean up if empty
            cleanupProcessingFile(processingFilePath, processingFileName);

            console.log(`[DONE] ${file.name} -> ${outputUnifiedName}`);
        }
    } finally {
        // no-op: each worker manages its own session
    }
}

 



async function processBucket(workerSessionManager, objectsSubset) {
    let processedCount = 0;
    let page = await sessionManager.getSafePage(workerSessionManager);
    for (let i = 0; i < objectsSubset.length; i++) {
        const urlObj = objectsSubset[i];
        const workerId = workerSessionManager.getWorkerId();
        try {

            const item = await extractWithStagehand(workerSessionManager, urlObj, page);
            workerSessionManager.addItemToBuffer(item);  
            processedCount++;
            console.log(`[SESSION ${workerId}] Successfully extracted product. currentBatchCount ${processedCount}`);
        } catch (err) {
            const errMsg = String(err && err.message ? err.message : err || '');
            // Attempt a one-time session re-init if the stagehand/page appears uninitialized/closed/terminated
            if (/uninitialized|createTarget|closed|Target\.createTarget|Failed to parse server response|terminated|session.*closed|browser.*closed|connection.*closed/i.test(errMsg)) {

                console.log(`[SESSION ${workerId}] Detected session error (${errMsg}), rotating...`);
                try {
                    if (sessionManager.getShuttingDown()) throw new Error('Shutdown in progress');
                    await workerSessionManager.rotate('session_error');
                    page = await sessionManager.getSafePage(workerSessionManager); // Use default page after rotation
                    const item = await extractWithStagehand(workerSessionManager, urlObj, page);
                    workerSessionManager.addItemToBuffer({ ...item, retried: true }); 
                    processedCount++;
                    console.log(`[SESSION ${workerId}] Successfully recovered after session rotation`);
                    console.log(`[SESSION ${workerId}] Successfully extracted product after rotation. currentBatchCount ${processedCount}`);
                    continue;
                } catch (rotateError) {
                    console.log(`[SESSION ${workerId}] Session rotation failed:`, rotateError.message);
                    // Continue with original error handling
                }
            }
            console.error('[Extractor] Error for URL:', urlObj.url, '-', errMsg);
            console.log(`[RETRY] URL remains in processing file for future retry: ${urlObj.url}`);
            try { logError('extract_error', { url: urlObj.url, error: errMsg, ...(err && err.meta ? err.meta : {}) }); } catch { }
            const meta = (err && err.meta) || { product_id: undefined, vendor: undefined, source_url: urlObj.url, extracted_at: new Date().toISOString() };
            const errorItem = { ...meta, error: errMsg };
            workerSessionManager.addItemToBuffer(errorItem);
            processedCount++;
        }
    }
    return processedCount;
}

async function main() {
    const { dir, batch, batches, limit } = parseArgs(process.argv);
    const startTs = Date.now();

    if (!dir) {
        console.error('Directory path is required. Use --dir or -d to specify the directory containing JSON files.');
        process.exit(1);
    }

    const StagehandCtor = await loadStagehandCtor();
    try {
        const concurrentBatches = Math.min(process.env.MAX_BATCH || 5, Number(process.env.MAX_CONCURRENT_BATCHES) || Number(batches) || 1);
        const totalLimit = Number.isFinite(Number(process.env.TOTAL_LIMIT || limit)) ? Number(process.env.TOTAL_LIMIT || limit) : Infinity;
        await processDirectoryBatches(StagehandCtor, dir, batch || 20, concurrentBatches, totalLimit);
    } catch (err) {
        console.error('[Batch Extractor] Error:', err && err.message ? err.message : err);
        try { logError('batch_extractor_error', { error: String(err && err.message ? err.message : err) }); } catch { }
        process.exitCode = 1;
    } finally {
        const ms = Date.now() - startTs;
        if (ms >= 60000) {
            const minutes = Math.floor(ms / 60000);
            const secondsRemainder = ((ms % 60000) / 1000).toFixed(2);
            console.log(`Total duration: ${minutes}m ${secondsRemainder}s`);
        } else {
            const seconds = (ms / 1000).toFixed(2);
            console.log(`Total duration: ${seconds}s`);
        }
    }
}


if (require.main === module) {
    main();
}



