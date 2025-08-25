const priceMarkupRules = [
    {"lower": 500, "upper": 9000000000, "markup": 100},  // Testing Strategy
    {"lower": 500, "upper": 9000000000, "markup": 20},
    {"lower": 300, "upper": 499.99, "markup": 30},
    {"lower": 200, "upper": 299.99, "markup": 35},
    {"lower": 100, "upper": 199.99, "markup": 40},
    {"lower": 30, "upper": 99.99, "markup": 55},  // Updated markup
    {"lower": 20, "upper": 29.99, "markup": 60},
    {"lower": 10, "upper": 19.99, "markup": 70},
    {"lower": 1, "upper": 9.99, "markup": 75},
    {"lower": 0.99, "upper": 0.99, "markup": 90},
];

function applyDynamicMarkup(costPrice) {
    /**
     * Determine selling price based on markup rules.
     * @param {number} costPrice - The original cost price
     * @returns {number} The marked up price
     */
    for (const rule of priceMarkupRules) {
        if (rule.lower <= costPrice && costPrice <= rule.upper) {
            const markupPercent = rule.markup;
            return Math.round((costPrice * (1 + markupPercent / 100)) * 100) / 100;
        }
    }
    return costPrice;  // Return cost price if no rule matches
}

function cleanText(text) {
    /**
     * Helper function to clean text by removing special characters and extra spaces.
     * @param {string} text - The text to clean
     * @returns {string} The cleaned text
     */
    return text.replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase();
}

// Helper function to extract numeric price from price text
function parsePrice(priceText) {
	if (!priceText || typeof priceText !== 'string') return null;
	
	// Remove currency symbols and extra whitespace
	const cleanedPrice = priceText.replace(/[£$€¥₹]/g, '').replace(/[^\d.,]/g, '').trim();
	
	// Handle different decimal separators
	let numericPrice = cleanedPrice.replace(/,/g, '.');
	
	// Parse as float
	const parsed = parseFloat(numericPrice);
	return isNaN(parsed) ? null : parsed;
}

module.exports = {
    priceMarkupRules,
    applyDynamicMarkup,
    cleanText,
    parsePrice
};