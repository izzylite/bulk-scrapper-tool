'use strict';

const fs = require('fs');
const path = require('path');

function readJson(absPath) {
	if (!fs.existsSync(absPath)) {
		throw new Error(`File not found: ${absPath}`);
	}
	const raw = fs.readFileSync(absPath, 'utf8');
	try {
		return JSON.parse(raw);
	} catch (e) {
		throw new Error(`Failed to parse JSON for ${absPath}: ${e.message}`);
	}
}

function writeJsonAtomic(absPath, data) {
	const tmp = absPath + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
	fs.renameSync(tmp, absPath);
}

function extractSourceUrls(filteredData) {
	const products = Array.isArray(filteredData?.products) ? filteredData.products : [];
	const urls = [];
	for (const p of products) {
		if (typeof p?.source_url === 'string' && p.source_url.trim()) {
			urls.push(p.source_url.trim());
		}
	}
	return urls;
}

function getFirstPathSegment(urlString) {
	try {
		const u = new URL(urlString);
		const segments = u.pathname.split('/').filter(Boolean);
		return segments[0] || '';
	} catch {
		return '';
	}
}

function recomputeCategoryCounts(items, categories) {
	const counts = {};
	for (const c of categories) counts[c] = 0;
	for (const item of items) {
		const seg = getFirstPathSegment(item?.url);
		if (seg && Object.prototype.hasOwnProperty.call(counts, seg)) {
			counts[seg]++;
		}
	}
	return counts;
}

function main() {
	const [,, filteredPathAArg, filteredPathBArg, combinedPathArg, outputExtractedArg] = process.argv;

	const filteredPathA = filteredPathAArg || path.resolve('vendors/superdrugs/back-up/filtered/filtered_2025-08-19T13-53-57-535Z.json');
	const filteredPathB = filteredPathBArg || path.resolve('vendors/superdrugs/back-up/filtered/filtered_2025-08-19T13-57-50-049Z.json');
	const combinedPath = combinedPathArg || path.resolve('vendors/superdrugs/output/superdrugs_combined-urls.output.json');
	const extractedOutPath = outputExtractedArg || path.resolve('vendors/superdrugs/output/extracted-filtered-source-urls.json');

	console.log(`[LOAD] Filtered A: ${filteredPathA}`);
	console.log(`[LOAD] Filtered B: ${filteredPathB}`);
	console.log(`[LOAD] Combined : ${combinedPath}`);

	const filteredA = readJson(filteredPathA);
	const filteredB = readJson(filteredPathB);

	const urlsA = extractSourceUrls(filteredA);
	const urlsB = extractSourceUrls(filteredB);
	const combinedUrls = Array.from(new Set([...urlsA, ...urlsB]));

	console.log(`[INFO] Extracted ${combinedUrls.length} unique source_url(s) from filtered files`);

	// Persist extracted URLs for auditing
	try {
		writeJsonAtomic(extractedOutPath, { count: combinedUrls.length, urls: combinedUrls });
		console.log(`[WRITE] Saved extracted URLs -> ${extractedOutPath}`);
	} catch (e) {
		console.warn(`[WARN] Failed to write extracted URL list: ${e.message}`);
	}

	const combined = readJson(combinedPath);
	const items = Array.isArray(combined?.items) ? combined.items : [];
	if (!Array.isArray(items) || items.length === 0) {
		console.log('[INFO] No items to filter or items array missing. Exiting.');
		return;
	}

	const pruneSet = new Set(combinedUrls);
	const beforeCount = items.length;
	const kept = items.filter(item => !pruneSet.has(item?.url));
	const removed = beforeCount - kept.length;

	combined.items = kept;
	combined.total_count = kept.length;

	// Update category counts if categories are known
	if (Array.isArray(combined?.categories)) {
		combined.category_counts = recomputeCategoryCounts(kept, combined.categories);
	}

	writeJsonAtomic(combinedPath, combined);
	console.log(`[PRUNE] Removed ${removed} item(s). New total_count=${combined.total_count}.`);
}

if (require.main === module) {
	try {
		main();
	} catch (e) {
		console.error(`[ERROR] ${e.message}`);
		process.exit(1);
	}
}

module.exports = { extractSourceUrls, recomputeCategoryCounts };


