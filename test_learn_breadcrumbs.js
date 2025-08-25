#!/usr/bin/env node
'use strict';

try { require('dotenv').config(); } catch { }

const { extractGeneric } = require('./tools/strategies/generic');
const { learnAndCacheSelectors, loadVendorSelectors } = require('./tools/utils/selectorLearningCore');
const SessionManager = require('./tools/utils/manager/sessionManager');

async function loadStagehandCtor() {
	const mod = await import('@browserbasehq/stagehand');
	return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

async function testLearnBreadcrumbs(url) {
	console.log('🧪 Learn Breadcrumbs Selector Test');
	console.log(`🎯 URL: ${url}`);

	const StagehandCtor = await loadStagehandCtor();
	const sessionManager = new SessionManager();
	sessionManager.initialize(StagehandCtor, () => {});
	const initialStagehand = await sessionManager.createStagehandInstanceWithFallback(true);
	const mockAppendBatch = async () => {};
	const worker = sessionManager.createWorkerSessionManager(initialStagehand, 'learn-breadcrumbs-worker', mockAppendBatch);

	try {
		const page = await sessionManager.getSafePage(worker, { blockImages: false, blockStyles: false, blockScripts: false });
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://www.google.com/' });
		await page.waitForTimeout(2000);

		const urlObj = { url, vendor: 'superdrug', sku: 'test-sku' };
		const product = await extractGeneric(page, urlObj);
		console.log('🧭 Extracted breadcrumbs length:', Array.isArray(product.breadcrumbs) ? product.breadcrumbs.length : 0);

		await learnAndCacheSelectors(page, 'superdrug', product);

		const selectors = loadVendorSelectors();
		console.log('🔎 Learned selectors for breadcrumbs:', (selectors.superdrug && selectors.superdrug.selectors && selectors.superdrug.selectors.breadcrumbs) ? selectors.superdrug.selectors.breadcrumbs : []);
	} finally {
		try { await worker.flushBuffer(); await worker.close(); } catch {}
	}
}

const args = process.argv.slice(2);
const testUrl = args[0] || 'https://www.superdrug.com/accessories-and-lifestyle/tights/fashion-patterned-tights/ladies-40-denier-novelty-colourful-neon-tights-one-size/p/mp-00006610';

if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
	console.error('❌ Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID');
	process.exit(1);
}

if (require.main === module) {
	testLearnBreadcrumbs(testUrl).catch(err => {
		console.error('❌ Test failed:', err?.message || err);
		process.exit(1);
	});
}

module.exports = { testLearnBreadcrumbs };


