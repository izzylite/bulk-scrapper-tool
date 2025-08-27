#!/usr/bin/env node
'use strict';

// Simple product extraction test focused on breadcrumbs and common fields

try { require('dotenv').config(); } catch { }

const { extractGeneric } = require('./tools/strategies/generic');
const SessionManager = require('./tools/utils/manager/sessionManager');

// Load Stagehand ctor for both ESM and CJS builds
async function loadStagehandCtor() {
	const mod = await import('@browserbasehq/stagehand');
	return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

function deriveSkuFromUrl(url) {
	const m = url.match(/mp-[0-9]+/i);
	return m ? m[0] : undefined;
}

async function testExtractionWithUrl(testUrl) {
	console.log('🧪 Testing Product Extraction (Breadcrumbs Focus)');
	console.log(`🎯 URL: ${testUrl}`);

	const StagehandCtor = await loadStagehandCtor();
	let sessionManager = null;
	let workerSessionManager = null;

	try {
		console.log('\n🤖 Initializing SessionManager...');
		sessionManager = new SessionManager();
		sessionManager.initialize(StagehandCtor, (type, data) => {
			// Minimal structured logging
			if (process.env.DEBUG) console.log(`[LOG] ${type}:`, JSON.stringify(data, null, 2));
		});

		console.log('🔄 Creating managed Stagehand session...');
		const initialStagehand = await sessionManager.createStagehandInstanceWithFallback(true); // Enable proxy

		// No-op batch appender for testing
		const mockAppendBatch = async (outputPath, metadata, items) => {
			if (process.env.DEBUG) console.log(`[BUFFER] Would save ${items.length} items to ${outputPath}`);
		};

		workerSessionManager = sessionManager.createWorkerSessionManager(
			initialStagehand,
			'test-breadcrumbs-worker',
			mockAppendBatch
		);

		// Prepare urlObj for generic extractor
		const urlObj = {
			url: testUrl,
			vendor: 'superdrug',
			sku: deriveSkuFromUrl(testUrl)
		};

		console.log('\n🔄 Navigating to page...');
		const page = await sessionManager.getSafePage(workerSessionManager, {
			blockImages: false,
			blockStyles: false,
			blockScripts: false
		});

		await page.goto(testUrl, {
			waitUntil: 'domcontentloaded',
			timeout: 45000,
			referer: 'https://www.google.com/'
		});
		console.log('✅ Page loaded');

		// Small random delay for dynamic content
		const randomDelay = Math.floor(Math.random() * 3000) + 1500;
		await page.waitForTimeout(randomDelay);

		console.log('\n🔍 Starting extraction...');
		const start = Date.now();
		const extracted = await extractGeneric(page, urlObj);
		const elapsed = Date.now() - start;
		console.log(`✅ Extraction completed in ${elapsed}ms`);

		// Print summary
		console.log('\n📊 RESULTS');
		console.log('='.repeat(50));
		console.log(`🏷️  Name: ${extracted.name || 'N/A'}`);
		console.log(`💰 Price: ${extracted.price || 'N/A'}`);
		console.log(`📦 Stock: ${extracted.stock_status || 'N/A'}`);
		console.log(`🔗 URL: ${extracted.url || urlObj.url}`);

		// Breadcrumbs
		console.log('\n🧭 Breadcrumbs:');
		if (Array.isArray(extracted.breadcrumbs) && extracted.breadcrumbs.length > 0) {
			extracted.breadcrumbs.forEach((label, i) => {
				console.log(`  ${i + 1}. ${label}`);
			});
		} else {
			console.log('  (none)');
		}

		// Optional fields commonly used
		const optionalFields = ['features', 'product_specification', 'warnings_or_restrictions', 'tips_and_advice', 'category', 'description'];
		console.log('\n🧩 Optional Fields__:');
		optionalFields.forEach(f => {
			if (extracted[f] !== undefined && extracted[f] !== null && extracted[f] !== '') {
				console.log(`  ${f}:`, typeof extracted[f] === 'object' ? JSON.stringify(extracted[f]).slice(0, 600) : `${String(extracted[f]).slice(0, 200)}`);
			}
		});

		if (process.env.DEBUG) {
			console.log('\n🐛 Full object:');
			console.log(JSON.stringify(extracted, null, 2));
		}

		console.log('\n✨ Done');
	} catch (err) {
		console.error('\n❌ Test failed:', err?.message || err);
		if (err?.stack) console.error(err.stack);
		process.exit(1);
	} finally {
		if (workerSessionManager) {
			try {
				await workerSessionManager.flushBuffer();
				await workerSessionManager.close();
				console.log('✅ Session closed');
			} catch (e) {
				console.error('Error closing session:', e?.message || e);
			}
		}
	}
}

// Arg parsing / help
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(`\nTest Product Extraction (Breadcrumbs)\n\nUsage: node test_breadcrumbs_extraction.js [url]\n\nEnvironment:\n  BROWSERBASE_API_KEY       Required\n  BROWSERBASE_PROJECT_ID    Required\n  DEBUG=1                   Optional, verbose output\n`);
	process.exit(0);
}

if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
	console.error('❌ Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID');
	console.error('Set env vars or add a .env file.');
	process.exit(1);
}

const defaultUrl = 'https://www.superdrug.com/accessories-and-lifestyle/tights/fashion-patterned-tights/ladies-40-denier-novelty-colourful-neon-tights-one-size/p/mp-00006610#ins_sr=eyJwcm9kdWN0SWQiOiJtcC0wMDAwNjYxMCJ9';
const url = args[0] || defaultUrl;

if (require.main === module) {
	testExtractionWithUrl(url).catch(err => {
		console.error('Unhandled error:', err);
		process.exit(1);
	});
}

module.exports = { testExtractionWithUrl };


