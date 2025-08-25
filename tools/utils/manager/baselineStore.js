'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const outputManager = require('./files/outputManager');

/**
 * SQLite index-backed baseline for vendor snapshots (no payload storage)
 * DB path: scrapper/output/<vendor>/updates/baseline.index.sqlite
 * Schema:
 *   items(key TEXT PRIMARY KEY, file TEXT NOT NULL, item_index INTEGER, updated_at TEXT, created_at TEXT)
 *   meta(name TEXT PRIMARY KEY, value TEXT)
 */
class BaselineIndexSqlite {
    constructor(vendor, updateKey) {
        if (!vendor) throw new Error('[BaselineIndexSqlite] vendor is required');
        this.vendor = vendor;
        this.updateKey = updateKey || null;
        this.vendorDir = outputManager.ensureVendorDirectoryExists(vendor);
        this.updatesDir = outputManager.ensureVendorUpdatesDirectoryExists(vendor);
        this.dbPath = path.join(this.updatesDir, 'baseline.index.sqlite');
        this.db = new Database(this.dbPath);
        try { this.db.pragma('journal_mode = WAL'); } catch { }
        try { this.db.pragma('synchronous = NORMAL'); } catch { }
        this._ensureSchema();
        this._size = null;
    }

    _ensureSchema() {
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS items (
                key TEXT PRIMARY KEY,
                file TEXT NOT NULL,
                item_index INTEGER,
                updated_at TEXT,
                created_at TEXT
            )
        `).run();
        this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at)`).run();
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS meta (
                name TEXT PRIMARY KEY,
                value TEXT
            )
        `).run();
    }

    _getIdentityKey(item) {
        if (!item || typeof item !== 'object') return null;
        const k = this.updateKey;
        const key = (k && item[k]) || item.product_id || item.sku || item.product_url || item.source_url || item.url;
        return key || null;
    }

    _getLatestVendorOutputsMtime() {
        try {
            const files = fs.readdirSync(this.vendorDir)
                .filter(f => f.endsWith('.json') && f !== 'update.json' && !/\.update(_\d+)?\.json$/.test(f));
            let latest = 0;
            for (const f of files) {
                const st = fs.statSync(path.join(this.vendorDir, f));
                if (st.mtimeMs > latest) latest = st.mtimeMs;
            }
            return latest;
        } catch { return 0; }
    }

    _getMeta(name) {
        try {
            const row = this.db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
            return row ? row.value : null;
        } catch { return null; }
    }
    _setMeta(name, value) {
        try {
            this.db.prepare('INSERT INTO meta(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, String(value));
        } catch { }
    }

    /** Build/refresh the SQLite index by scanning vendor output files with reuse check */
    buildFromVendorFiles() {
        const latestMtime = this._getLatestVendorOutputsMtime();
        const lastScan = Number(this._getMeta('last_scan_mtime') || '0');
        if (lastScan && latestMtime && lastScan >= latestMtime) {
            // Reuse existing index
            return this;
        }

        const files = fs.readdirSync(this.vendorDir)
            .filter(f => f.endsWith('.json') && f !== 'update.json' && !/\.update(_\d+)?\.json$/.test(f));

        const upsert = this.db.prepare(`
            INSERT INTO items(key, file, item_index, updated_at, created_at)
            VALUES (@key, @file, @item_index, @updated_at, @created_at)
            ON CONFLICT(key) DO UPDATE SET
                file = CASE WHEN excluded.updated_at > items.updated_at OR items.updated_at IS NULL THEN excluded.file ELSE items.file END,
                item_index = CASE WHEN excluded.updated_at > items.updated_at OR items.updated_at IS NULL THEN excluded.item_index ELSE items.item_index END,
                updated_at = CASE WHEN excluded.updated_at > items.updated_at OR items.updated_at IS NULL THEN excluded.updated_at ELSE items.updated_at END,
                created_at = CASE WHEN excluded.updated_at > items.updated_at OR items.updated_at IS NULL THEN excluded.created_at ELSE items.created_at END
        `);
        const upsertMany = this.db.transaction((rows) => { for (const r of rows) upsert.run(r); });

        for (const file of files) {
            try {
                const filePath = path.join(this.vendorDir, file);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (!data || !Array.isArray(data.items)) continue;
                const fileTs = data.updated_at || data.created_at || null;
                const batch = [];
                for (let idx = 0; idx < data.items.length; idx++) {
                    const item = data.items[idx];
                    const key = this._getIdentityKey(item);
                    if (!key) continue;
                    const curTs = item.updated_at || item.last_checked_at || fileTs;
                    batch.push({ key, file: filePath, item_index: idx, updated_at: curTs || null, created_at: data.created_at || null });
                }
                if (batch.length > 0) upsertMany(batch);
            } catch { }
        }

        this._setMeta('last_scan_mtime', latestMtime);
        this._setMeta('version', '1');

        try {
            const row = this.db.prepare('SELECT COUNT(1) as c FROM items').get();
            this._size = row ? row.c : 0;
        } catch { this._size = null; }
        return this;
    }

    /** Lazy fetch snapshot by key using file + item_index */
    get(key) {
        if (!key) return null;
        try {
            const row = this.db.prepare('SELECT file, item_index FROM items WHERE key = ?').get(key);
            if (!row) return null;
            if (!row.file || typeof row.item_index !== 'number') return null;
            if (!fs.existsSync(row.file)) return null;
            const data = JSON.parse(fs.readFileSync(row.file, 'utf8'));
            const items = Array.isArray(data?.items) ? data.items : [];
            return items[row.item_index] || null;
        } catch { return null; }
    }

    get size() {
        if (typeof this._size === 'number') return this._size;
        try {
            const row = this.db.prepare('SELECT COUNT(1) as c FROM items').get();
            this._size = row ? row.c : 0;
            return this._size;
        } catch { return 0; }
    }

    /** Iterate [key, snapshot] by loading from source files lazily */
    [Symbol.iterator]() {
        // Order rows by file so we can cache per-file contents while iterating
        const stmt = this.db.prepare('SELECT key, file, item_index FROM items ORDER BY file, item_index');
        const iterator = stmt.iterate();
        const gen = (function* () {
            let cachedPath = null;
            let cachedData = null;
            for (const row of iterator) {
                try {
                    const filePath = row.file;
                    if (!filePath) continue;
                    if (filePath !== cachedPath) {
                        // Load and cache the file contents once until file changes
                        if (!fs.existsSync(filePath)) { cachedPath = filePath; cachedData = null; continue; }
                        const raw = fs.readFileSync(filePath, 'utf8');
                        cachedData = JSON.parse(raw);
                        cachedPath = filePath;
                    }
                    const items = Array.isArray(cachedData?.items) ? cachedData.items : [];
                    const snap = items[row.item_index];
                    if (snap) yield [row.key, snap];
                } catch { }
            }
        })();
        return gen;
    }

    close() {
        try { this.db.close(); } catch { }
    }
}

function buildBaselineForVendorSqlite(vendor, updateKey) {
    return new BaselineIndexSqlite(vendor, updateKey).buildFromVendorFiles();
}

module.exports = {
    BaselineIndexSqlite,
    buildBaselineForVendorSqlite
};


