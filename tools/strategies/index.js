'use strict';

function getHostname(url) {
	try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

async function extractProductWithStrategy(page, urlObj) {
	const url = urlObj.url;
	// const hostname = getHostname(url);
	// if (/(?:^|\.)hamleys\.com$/.test(hostname)) {
	// 	const { extractHamleys } = require('./hamleys');
	// 	return await extractHamleys(page, url, urlObj);
	// }
	const { extractGeneric } = require('./generic');
	return await extractGeneric(page, urlObj);
}

module.exports = {
	extractProductWithStrategy,
};
