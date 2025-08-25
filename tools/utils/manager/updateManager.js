'use strict';

const fs = require('fs');
const path = require('path');
const { findActiveProcessingFile, deactivateProcessingFile, getProcessingFiles } = require('./files/pendingManager');
const inputManager = require('./files/inputManager');
const outputManager = require('./files/outputManager');

// Module-scoped update context
let __ctx = {
    enabled: false,
    vendor: null,
    updateKey: null,
    updateFields: null,
    baseline: null // Map<key, snapshot>
};

function getContext() { return __ctx; }

function getIdentityKey(item, explicitKey = null) {
    const key = explicitKey && item[explicitKey] ? item[explicitKey] : (item.product_id || item.sku || item.product_url || item.source_url || item.url);
    return key || null;
}

function isNewerByTimestamp(a, b) {
    if (!a && b) return false; if (a && !b) return true; if (!a && !b) return false; return new Date(a).getTime() > new Date(b).getTime();
}

function loadVendorUpdateConfig(vendor) {
    try {
        const vendorDir = outputManager.ensureVendorDirectoryExists(vendor);
        const p = path.join(vendorDir, 'update.json');
        if (!fs.existsSync(p)) return {};
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch { return {}; }
}

function buildBaselineForVendor(vendor, updateKey) {
    const vendorDir = outputManager.ensureVendorDirectoryExists(vendor);
    const files = fs.readdirSync(vendorDir)
        .filter(f => f.endsWith('.json') && f !== 'update.json' && !/\.update(_\d+)?\.json$/.test(f));
    const map = new Map();
    for (const file of files) {
        try {
            const filePath = path.join(vendorDir, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!data || !Array.isArray(data.items)) continue;
            for (const item of data.items) {
                const key = getIdentityKey(item, updateKey);
                if (!key) continue;
                const prev = map.get(key);
                const prevTs = prev ? (prev.updated_at || prev.last_checked_at || prev.created_at) : null;
                const curTs = item.updated_at || item.last_checked_at || data.updated_at || data.created_at;
                if (!prev || isNewerByTimestamp(curTs, prevTs)) {
                    map.set(key, { ...item });
                }
            }
        } catch { }
    }
    return map;
}

function toProcessingItemFromBaseline(vendor, snapshot) {
    const url = snapshot.product_url || snapshot.source_url || snapshot.url || '';
    const sku = snapshot.product_id || snapshot.sku || null;
    const image_url = snapshot.main_image || null;
    return { url, vendor, image_url, sku };
}

function applyFieldUpdates(original, fresh, updateFields) {
    const updated = { ...original };
    const fields = Array.isArray(updateFields) && updateFields.length > 0 ? updateFields : Object.keys(fresh || {});
    for (const f of fields) {
        if (f === 'vendor' || f === 'product_id') continue;
        if (fresh && fresh[f] !== undefined) {
            if (Array.isArray(fresh[f])) {
                updated[f] = [...fresh[f]];
            } else {
                updated[f] = fresh[f];
            }
        }
    }
    const nowIso = new Date().toISOString();
    const beforePrice = original ? original.price : undefined;
    const beforeStock = original ? original.stock_status : undefined;
    if (beforePrice !== updated.price) {
        updated.price_history = Array.isArray(original?.price_history) ? [...original.price_history] : [];
        updated.price_history.push({ old: beforePrice, new: updated.price, changed_at: nowIso });
    } else if (Array.isArray(original?.price_history)) {
        updated.price_history = [...original.price_history];
    }
    if (beforeStock !== updated.stock_status) {
        updated.stock_history = Array.isArray(original?.stock_history) ? [...original.stock_history] : [];
        updated.stock_history.push({ old: beforeStock, new: updated.stock_status, changed_at: nowIso });
    } else if (Array.isArray(original?.stock_history)) {
        updated.stock_history = [...original.stock_history];
    }
    updated.last_checked_at = nowIso;
    return updated;
}

function mergeSnapshots(freshItems, updateKey, updateFields, baseline) {
    const merged = [];
    const base = baseline || (__ctx && __ctx.baseline);
    for (const fresh of freshItems || []) {
        const key = getIdentityKey(fresh, updateKey || (__ctx && __ctx.updateKey));
        const original = base ? base.get(key) : null;
        const origCopy = original ? { ...original } : {};
        merged.push(applyFieldUpdates(origCopy, fresh, updateFields || (__ctx && __ctx.updateFields)));
    }
    return merged;
}

function findActiveUpdateProcessingForVendor(vendor) {
    try {
        const files = getProcessingFiles();
        for (const f of files) {
            if (!f.active) continue;
            if ((f.vendor || '').toLowerCase() !== String(vendor || '').toLowerCase()) continue;
            // read file to check mode
            const data = JSON.parse(fs.readFileSync(f.path, 'utf8'));
            if (data && data.mode === 'update' && data.vendor === vendor) {
                return { meta: f, data };
            }
        }
    } catch { }
    return null;
}

async function prepareUpdateModeIfNeeded(cli) {
    if (!cli || !cli.update) return null;

    const vendor = (cli.vendors && cli.vendors[0]) || null;
    if (!vendor) {
        console.log('[UPDATE] --vendor is required for update mode');
        return null;
    }

    // Resume: if there is an active update-mode processing file for this vendor, use it
    const existing = findActiveUpdateProcessingForVendor(vendor);
    if (existing && existing.data && Array.isArray(existing.data.items) && existing.data.items.length > 0) {
        const updKey = existing.data.update_key || cli.updateKey || 'sku';
        const updFields = Array.isArray(existing.data.update_fields) ? existing.data.update_fields : (Array.isArray(cli.updateFields) ? cli.updateFields : []);
        console.log(`[UPDATE] Resuming existing update job: ${path.basename(existing.meta.path)} (${existing.data.items.length} remaining)`);
        // Build/refresh baseline for merging
        const baseline = buildBaselineForVendor(vendor, updKey);
        __ctx.enabled = true;
        __ctx.vendor = vendor;
        __ctx.updateKey = updKey;
        __ctx.updateFields = updFields;
        __ctx.baseline = baseline;
        return { processingFilePath: existing.meta.path, vendor, itemsCount: existing.data.items.length, baselineSize: baseline.size, resumed: true };
    }

    // No resume file; deactivate any active processing and create a fresh update job
    const active = findActiveProcessingFile();
    if (active?.path) { try { deactivateProcessingFile(active.path); } catch { } }

    const cfg = loadVendorUpdateConfig(vendor);
    const updateKey = cli.updateKey || cfg.update_key || null;
    const updateFields = Array.isArray(cli.updateFields) && cli.updateFields.length > 0 ? cli.updateFields : (Array.isArray(cfg.update_fields) ? cfg.update_fields : null);
    const staleDays = (typeof cli.staleDays === 'number' ? cli.staleDays : (typeof cfg.stale_days === 'number' ? cfg.stale_days : null));
    const staleBefore = (staleDays !== null && staleDays >= 0) ? new Date(Date.now() - staleDays * 86400000).toISOString() : undefined;

    console.log(`[UPDATE] Building baseline for vendor ${vendor}...`);
    const baseline = buildBaselineForVendor(vendor, updateKey);
    console.log(`[UPDATE] Baseline size: ${baseline.size}`);

    // Build processing items (apply staleness filter if requested)
    const items = [];
    const sourceFiles = fs.readdirSync(outputManager.ensureVendorDirectoryExists(vendor))
        .filter(f => f.endsWith('.json') && f !== 'update.json' && !/\.update(_\d+)?\.json$/.test(f));

    for (const [, snapshot] of baseline) {
        const ts = snapshot.last_checked_at || snapshot.updated_at || snapshot.created_at;
        if (staleBefore && ts && new Date(ts).getTime() >= new Date(staleBefore).getTime()) {
            continue; // not stale
        }
        items.push(toProcessingItemFromBaseline(vendor, snapshot));
    }

    const extraMeta = { mode: 'update', update_key: updateKey || 'sku', update_fields: updateFields || [], ...(staleBefore ? { stale_before: staleBefore } : {}) };
    const processingFilePath = inputManager.createProcessingFromItems(vendor, items, extraMeta, sourceFiles);
    console.log(`[UPDATE] Created update processing file: ${path.basename(processingFilePath)} (items: ${items.length})`);

    // Set shared update context for merging
    __ctx.enabled = true;
    __ctx.vendor = vendor;
    __ctx.updateKey = updateKey || 'sku';
    __ctx.updateFields = updateFields || [];
    __ctx.baseline = baseline;

    return { processingFilePath, vendor, itemsCount: items.length, baselineSize: baseline.size, resumed: false };
}

module.exports = {
    getContext,
    getIdentityKey,
    isNewerByTimestamp,
    loadVendorUpdateConfig,
    buildBaselineForVendor,
    toProcessingItemFromBaseline,
    applyFieldUpdates,
    mergeSnapshots,
    prepareUpdateModeIfNeeded
};
