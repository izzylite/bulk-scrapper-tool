## Update Mode Design and Runbook

### Objectives
- **Enable update mode** driven by CLI flags and a per-vendor `update.json` config.
- **Build a new processing job** from existing vendor outputs when updating.
- **Write full updated snapshots** to a separate `.update` output under `updates/` without mutating historical outputs.
- **Remain backward-compatible** with current create/append flow.

### CLI
- `--update`: enable update mode.
- `--vendor=<vendorA[,vendorB,...]>`: comma-separated vendors to update.
- Optional (future-proof):
  - `--update-fields=price,stock_status,images` (overrides update.json)
  - `--update-key=product_id|sku|url` (stable identity field)
  - `--stale-days=1` (skip items updated recently)

### update.json (per vendor)
Location: `scrapper/output/<vendor>/update.json`

Purpose: declare what to update and how. If missing, defaults apply (update all fields).

Example schema:
```json
{
  "vendor": "superdrug",
  "update_key": "sku",
  "update_fields": ["price", "stock_status", "images"],
  "stale_days": 1,
  "merge_strategy": {
    "images": "append_unique"
  }
}
```
- **vendor**: must match the folder and `--vendor` flag (validated).
- **update_key**: record identity key. Recommended fallback: `product_id` → `sku` → `product_url|source_url` → `url`.
- **update_fields**: which fields to refresh; omit/empty = update all.
- **stale_days**: optional, only re-scrape if last check is older.
- **merge_strategy**: optional per-field rules for arrays; default `overwrite`, allow `append_unique`.

Note: variant-specific keys like `variant_sku`, `variant_url`, `include_variants` are not used in current codebase.

### Processing file in update mode
When `--update` is set, for each vendor:
1) Deactivate any active processing job.
2) Scan `scrapper/output/<vendor>/*.json` and build a baseline index of products.
   - Stream files to avoid creating one giant merged JSON.
   - Build `{ key → baselineSnapshot }` in memory, or a lightweight `{ key → {file, offset} }` index if memory-constrained.
3) Create a new processing file in `scrapper/processing/` with fields:
   - `active: true`
   - `vendor`
   - `mode: "update"`
   - `update_key` (from `update.json` or CLI/default)
   - `update_fields` (from `update.json` or CLI/empty)
   - `stale_before` (derived from `stale_days`, optional)
   - `source_files`: vendor output filenames
   - `items`: deduped list of work items `{ url, vendor, image_url?, sku? }` filtered by staleness if provided

These additions are optional and ignored by normal mode.

### Output artifact in update mode
- Create a separate update file under `scrapper/output/<vendor>/updates/` with base name `<baseName>.update.json`.
- Use rotation once reaching 10k items: `<baseName>.update_1.json`, etc., inside the same `updates/` subdirectory.
- Each record is a full snapshot of the product after updates (not a delta): original fields plus refreshed ones.
- Append change metadata:
  - `last_checked_at`: ISO timestamp
  - `price_history`: `{ old, new, changed_at }[]` when price changes
  - `stock_history`: `{ old, new, changed_at }[]` when stock changes

### High-level workflow (update mode)
1) Parse CLI. If `--update`:
   - Deactivate active processing file(s).
   - For each vendor:
     - Load `update.json` if present; apply defaults otherwise.
     - Build baseline index across outputs, staleness-filter if requested.
     - Create a processing file with `mode: "update"` and metadata.
     - Create an empty `<baseName>.update.json` under `updates/` for appends.
2) Extraction runs as today.
3) Append path:
   - Normal mode: unchanged; append to `.output.json` with rotation.
   - Update mode: produce a full updated snapshot (baseline + updates applied) and append to `.update.json` (in `updates/`) with rotation.
4) Processing maintenance: remove successful URLs, record errors, archive on completion (existing behavior).

### Matching and merging rules
- **Identity**: use `update_key` to match fresh result to baseline.
- **Fields**:
  - If `update_fields` exists: update only those; otherwise update all fields from the fresh extraction.
  - Arrays follow `merge_strategy` (default `overwrite`; `append_unique` if specified).
- **Change tracking**:
  - If `price` changed, append to `price_history`.
  - If `stock_status` changed, append to `stock_history`.
- **No-change optimization**:
  - Optionally still emit a snapshot with updated `last_checked_at` for auditability.

### Error handling and retries
- Failed items are captured in the processing file with `error`, `retry_count`, and `error_timestamp` (existing logic).
- Successful URLs are batch-removed; file deactivates and auto-archives when empty (existing logic).

### Baseline and In‑Memory Items
- **Baseline purpose**: provide a fast lookup of the current canonical products for a vendor, built from `scrapper/output/<vendor>/*.json` (excluding `updates/`). It powers: target selection (e.g., staleness) and full-snapshot merging during updates.
- **Identity key**: derive per item using `update_key` (fallback order: `product_id` → `sku` → `product_url|source_url` → `url`).

Two strategies:
- **BaselineMap (simple, memory-heavy)**
  - Build `Map<key, { snapshot, sourceFile, updated_at }>` by streaming vendor outputs.
  - On duplicate keys, keep the newest by `updated_at` (fallback `created_at`).
  - Pros: O(1) merge per item. Cons: high memory for very large catalogs.
- **BaselineIndex (lean, on-demand fetch)**
  - Build `Map<key, { filePath, itemIndex, updated_at }>` only; discard item payloads.
  - When writing an updated snapshot, fetch the original on demand by `{filePath, itemIndex}`.
  - Pros: low memory. Cons: extra I/O per merge.

Creating processing items (used to build the update processing file):
- For each baseline entry, create a minimal work item: `{ url, vendor, image_url?, sku? }` where
  - `url` comes from `product_url` → `source_url` → `url`.
  - `sku` comes from `product_id` → `sku`.
- Apply staleness filter if `stale_days` is provided: remove items whose `last_checked_at` or `updated_at` ≥ `stale_before`.
- Save processing file with `mode: "update"`, `update_key`, `update_fields`, `stale_before`, `source_files`.

Merging to produce updated full snapshots:
- On each successful extraction:
  - Compute `key` from the fresh item; lookup original via BaselineMap/Index.
  - Start from original snapshot; update only `update_fields` (or all fields if unspecified).
  - Set `last_checked_at` now; append `price_history`/`stock_history` entries on changes.
  - If no baseline match, treat as insert and write the fresh item as a full snapshot.
- Write to `scrapper/output/<vendor>/updates/<base>.update[_N].json` with rotation.

Concurrency and caching:
- Keep the baseline map/index in a module-level singleton shared by workers to avoid repeated scans.
- Optionally persist a sidecar index (e.g., `updates/baseline.index.json`) to skip rebuilds on restart.

Pseudocode (BaselineMap):
```js
const baseline = new Map();
for (const file of vendorOutputFiles) {
  for (const item of streamItems(file)) {
    const key = getKey(item);
    if (!key) continue;
    const prev = baseline.get(key);
    if (!prev || isNewer(item, prev.updated_at)) {
      baseline.set(key, { snapshot: item, sourceFile: file, updated_at: item.updated_at });
    }
  }
}
```

Pseudocode (BaselineIndex):
```js
const index = new Map();
for (const file of vendorOutputFiles) {
  let i = 0;
  for (const item of streamItems(file)) {
    const key = getKey(item);
    if (!key) { i++; continue; }
    const prev = index.get(key);
    if (!prev || isNewer(item, prev.updated_at)) {
      index.set(key, { filePath: file, itemIndex: i, updated_at: item.updated_at });
    }
    i++;
  }
}
// Later, when merging: const original = readItemAt(index.get(key));
```

### Performance considerations
- Avoid physically merging all outputs. Stream-scan and index instead.
- Cache baseline index in memory for the run; share across workers via a module-level singleton.
- Keep 10k-per-file rotation for update files in `updates/` to manage file sizes.

### Backward compatibility
- Normal (create) mode is unchanged.
- Additional processing fields are optional.
- Update outputs live alongside existing outputs in `updates/`; no mutation of historical files.

### File-by-file plan
- `stagehand_product_extractor.js`:
  - Parse `--update` and `--vendor` (and optional overrides).
  - On update: deactivate active job; load `update.json`; build baseline; create processing file (with `mode`, `update_key`, `update_fields`, `stale_before`); create empty `.update.json` in `updates/`.
  - Ensure per-batch append passes `{ mode, vendor, sourceFile, update_key, update_fields }` to the output writer.
- `tools/utils/manager/files/inputManager.js`:
  - Add helper to create a processing file from in-memory items + metadata, used by update mode.
- `tools/utils/manager/files/pendingManager.js`:
  - Update validation to allow `mode`, `update_key`, `update_fields`, `stale_before` as optional.
- `tools/utils/manager/files/outputManager.js`:
  - Add branch for update mode to generate and append full snapshots to files under `updates/` with rotation & counters.

### Runbook
1) (Optional) Prepare `scrapper/output/<vendor>/update.json`:
```json
{
  "vendor": "superdrug",
  "update_key": "sku",
  "update_fields": ["price", "stock_status", "images"],
  "stale_days": 1
}
```
2) Run:
```bash
node stagehand_product_extractor.js --update --vendor=superdrug
```
3) Inspect results:
- `scrapper/output/<vendor>/updates/*.update*.json` for updated snapshots
- `scrapper/processing/archived` for the archived update processing file

### Notes
- The current codebase does not use variant-specific keys; updates operate at product level using `update_key`.
- A future optional "apply updates" task can upsert `.update.json` back into canonical `.output*.json` if needed.
