'use strict';

function getHostname(url) {
	try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

async function extractProductWithStrategy(page, urlObj) {
	const url = urlObj.url;
	const hostname = getHostname(url);
	
	// Set vendor based on hostname if not already set
	if (!urlObj.vendor) {
		if (/(?:^|\.)superdrug\.com$/.test(hostname)) {
			urlObj.vendor = 'superdrug';
		} else if (/(?:^|\.)harrods\.com$/.test(hostname)) {
			urlObj.vendor = 'harrods';
		}
	}
	
	// Use generic strategy for all vendors (it will use vendor-specific strategies when available)
	const { extractGeneric } = require('./generic');
	return await extractGeneric(page, urlObj);
}

module.exports = {
	extractProductWithStrategy,
};
