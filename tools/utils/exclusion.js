'use strict';

// No filesystem reads; exclusions are defined as constants in this module

// ------------------------------
// Domain exclusions (constant)
// ------------------------------
// Shape: { "domain.com": ["pattern", ...], ... }
const DOMAIN_EXCLUSIONS = {
	"harrods.com": [],
	"superdrug.com": ["fashion","health"],
	
};

function getHostnameFromUrl(url) {
	try {
		return new URL(url).hostname;
	} catch (_) {
		return null;
	}
}

function detectFirstUrlFromData(data) {
	if (Array.isArray(data?.urls)) {
		return data.urls.find(Boolean) || null;
	}
	if (Array.isArray(data?.items)) {
		const hit = data.items.find(it => it && it.url);
		return hit?.url || null;
	}
	if (Array.isArray(data?.objects)) {
		const hit = data.objects.find(it => it && it.url);
		return hit?.url || null;
	}
	if (Array.isArray(data)) {
		// direct array of URLs
		return data.find(Boolean) || null;
	}
	return null;
}

function resolveExclusionsForHostname(hostname) {
	if (!hostname) return null;
	const domainMap = DOMAIN_EXCLUSIONS || {};
	// Exact match first
	if (Array.isArray(domainMap[hostname])) return domainMap[hostname];
	// Otherwise, allow suffix match against apex domains in config
	for (const key of Object.keys(domainMap)) {
		if (!Array.isArray(domainMap[key])) continue;
		if (hostname === key || hostname.endsWith(`.${key}`)) return domainMap[key];
	}
	return null;
}

function createExclusionFilter(exclusions) {
	if (!Array.isArray(exclusions) || exclusions.length === 0) {
		return null; // No filtering needed
	}
	
	// Create regex patterns for each exclusion term (case-insensitive)
	const exclusionPatterns = exclusions.map(term => 
		new RegExp(`/${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i')
	);
	
	return function(url) {
		// Check if URL matches any exclusion pattern
		for (const pattern of exclusionPatterns) {
			if (pattern.test(url)) {
				return false; // Exclude this URL
			}
		}
		return true; // Keep this URL
	};
}

module.exports = {
	DOMAIN_EXCLUSIONS,
	getHostnameFromUrl,
	detectFirstUrlFromData,
	resolveExclusionsForHostname,
	createExclusionFilter,
};


