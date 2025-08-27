// Local helpers to avoid circular dependencies
function cleanAndValidateUrl(value) {
	if (typeof value !== 'string') return null;
	let result = null;
	try {
		let cleaned = value.trim();
		if (!cleaned) { 
			return null;
		}
		if (cleaned.startsWith('@')) {
			cleaned = cleaned.substring(1);
		}
		cleaned = cleaned.replace(/^[^\w]*([a-zA-Z]*:\/\/)/, '$1');
		if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(cleaned)) { 
			return null;
		}
		const u = new URL(cleaned);
		if (u.protocol === 'http:' || u.protocol === 'https:') {
			result = cleaned;
		} 
		return result;
	} catch { 
		return null;
	}
}

module.exports = {
    cleanAndValidateUrl
}