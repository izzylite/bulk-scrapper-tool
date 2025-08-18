'use strict';

const fs = require('fs');
const path = require('path');

function isValidHttpUrl(value) {
    try {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        if (!trimmed) return false;
        if (/^(data:|blob:|javascript:|#)/i.test(trimmed)) return false;
        const u = new URL(trimmed);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function dedupe(arr) {
    return Array.from(new Set(arr));
}

function normalizeImages(item) {
    const images = Array.isArray(item.images) ? item.images : [];
    let validImages = images.filter(isValidHttpUrl);
    let main = isValidHttpUrl(item.main_image) ? item.main_image : '';
    if (!main && validImages.length > 0) main = validImages[0];
    if (main) validImages.unshift(main);
    validImages = dedupe(validImages.filter(isValidHttpUrl));
    item.main_image = main || null;
    item.images = validImages;
}

function processFile(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
        console.error(`[ERROR] File not found: ${abs}`);
        process.exit(1);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        console.error(`[ERROR] Failed to parse JSON: ${e.message}`);
        process.exit(1);
    }

    const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : null);
    if (!items) {
        console.error('[ERROR] No items array found in JSON');
        process.exit(1);
    }

    let changed = 0;
    for (const item of items) {
        const beforeMain = item?.main_image || null;
        const beforeImagesLen = Array.isArray(item?.images) ? item.images.length : 0;
        normalizeImages(item);
        if (item.main_image !== beforeMain || (Array.isArray(item.images) && item.images.length !== beforeImagesLen)) {
            changed++;
        }
    }

    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, abs);
    console.log(`[CLEAN] ${changed} item(s) updated in ${abs}`);
}

if (require.main === module) {
    const target = process.argv[2] || 'vendors/superdrugs/extracted-output/combined-urls.output.json';
    processFile(target);
}

module.exports = { processFile };



