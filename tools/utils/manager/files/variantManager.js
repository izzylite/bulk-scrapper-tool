'use strict';

/**
 * Normalizes a slug string for stable comparisons
 * @param {string} slug
 * @returns {string}
 */
function normalizeSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';
    try {
        return decodeURIComponent(slug)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    } catch (_) {
        return slug.toLowerCase();
    }
}

/**
 * Extracts variant grouping key for Superdrug URLs.
 * Uses the slug segment immediately before /p/mp-xxxxx as group key.
 * @param {string} rawUrl
 * @returns {string|null} group key or null if not a superdrug product URL
 */
function getSuperdrugGroupKey(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (!u.host.toLowerCase().includes('superdrug.com')) return null;
        const m = u.pathname.match(/\/([^/]+)\/p\/mp-\d+/i);
        if (!m || !m[1]) return null;
        const slug = normalizeSlug(m[1]);
        return `${u.host.toLowerCase()}/${slug}`;
    } catch (_) {
        return null;
    }
}

/**
 * Fallback: builds a similarity signature from URL path segments (excluding last)
 * and computes Jaccard similarity between segment sets.
 */
function getPathSegmentsForSimilarity(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        // remove last segment which commonly carries the SKU/id
        const core = segments.length > 1 ? segments.slice(0, -1) : segments;
        return core.map(s => s.toLowerCase());
    } catch (_) {
        return [];
    }
}

function jaccardSimilarity(a, b) {
    if (!a.length && !b.length) return 1;
    const A = new Set(a);
    const B = new Set(b);
    let inter = 0;
    for (const v of A) if (B.has(v)) inter++;
    const union = new Set([...A, ...B]).size || 1;
    return inter / union;
}

/**
 * Groups items into variants for Superdrug using deterministic slug grouping
 * @param {Array<{url:string, sku_id?:string, image_url?:string}>} items
 * @returns {Map<string, Array<Object>>}
 */
function groupSuperdrugVariants(items) {
    const buckets = new Map();
    for (const item of items) {
        if (!item || !item.url) continue;
        const key = getSuperdrugGroupKey(item.url);
        if (!key) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
    }
    return buckets;
}

/**
 * Fallback grouping using high-threshold similarity of URL path segments
 * @param {Array<{url:string, sku_id?:string, image_url?:string}>} items
 * @param {number} threshold - similarity threshold (default 0.9)
 * @returns {Array<Array<Object>>} Array of groups
 */
function groupByPathSimilarity(items, threshold = 0.9) {
    const groups = [];
    const signatures = new Map(); // item -> segments
    for (const item of items) {
        if (!item || !item.url) continue;
        signatures.set(item, getPathSegmentsForSimilarity(item.url));
    }
    for (const item of items) {
        if (!item || !item.url) continue;
        const segs = signatures.get(item) || [];
        let placed = false;
        for (const group of groups) {
            // compare against first item in group as representative
            const rep = group[0];
            const repSegs = signatures.get(rep) || [];
            const sim = jaccardSimilarity(segs, repSegs);
            if (sim >= threshold) {
                group.push(item);
                placed = true;
                break;
            }
        }
        if (!placed) groups.push([item]);
    }
    // keep only groups with at least two items (variants)
    return groups.filter(g => g.length > 1);
}

/**
 * Groups items into variant groups and returns a deduplicated list of main items with variants.
 * Strategy: if vendor is specified, use deterministic grouping. Otherwise fallback to similarity.
 * @param {Array} items - Original items array
 * @param {string} vendor - Vendor name
 * @returns {Array} Array of main items, each containing a variants array
 */
function assignVariants(items, vendor) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const vendorLc = (vendor || '').toLowerCase();

    let groups = [];
    if (vendorLc.includes('superdrug')) {
        const map = groupSuperdrugVariants(items);
        groups = Array.from(map.values()).filter(g => g.length > 1);
    }

    // Fallback if no groups found via superdrug logic or if not superdrug vendor
    if (groups.length === 0) {
        groups = groupByPathSimilarity(items, 0.9);
    }

    // Create a set to track which items are part of variant groups
    const groupedUrls = new Set();
    const mainItems = [];

    // Process variant groups - use first item as main item with variants
    for (const group of groups) {
        if (group.length > 1) {
            const mainItem = { ...group[0] }; // Clone the first item as main
            const variants = group.slice(1).map(g => ({ 
                url: g.url, 
                sku_id: g.sku_id || null, 
                image_url: g.image_url || null 
            }));
            mainItem.variants = variants;
            mainItems.push(mainItem);
            
            // Mark all URLs in this group as processed
            for (const item of group) {
                groupedUrls.add(item.url);
            }
        }
    }

    // Add remaining items that weren't part of any variant group
    for (const item of items) {
        if (!groupedUrls.has(item.url)) {
            const singleItem = { ...item };
            singleItem.variants = [];
            mainItems.push(singleItem);
        }
    }

    return mainItems;
}

module.exports = {
    assignVariants,
    groupSuperdrugVariants,
    groupByPathSimilarity,
    normalizeSlug,
    getSuperdrugGroupKey
};
