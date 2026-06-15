# Manifest Tools — Integration Plan for ClientHub

**Status:** Proposal / design doc
**Author:** planning pass, 2026-06-05
**Scope owner:** Jack
**Target system:** ClientHub desktop (Tauri 2 · Rust `src-tauri` + React `src`), with light follow-on for the Pi API + mobile.

---

## 1. Goal & scope

Bring the useful half of the old `manifest-platform` project into ClientHub as a
**built-in, fully-offline manifest reformatter, cleaner, and breakdown/PDF
exporter**. When a user attaches a liquidation manifest (B-Stock CSV/XLSX) to an
inventory lot — or just drops one into a standalone tool — ClientHub should:

1. **Reformat / clean** it — auto-detect the columns, normalize UPCs, strip
   liquidation junk from titles, parse prices, and produce a tidy, standardized
   table.
2. **Break it down** — totals (units, extended retail), and grouped breakdowns by
   category, brand, and condition, plus the top items by value.
3. **Export** — a clean CSV/XLSX (reformatted manifest) and a polished **PDF
   breakdown** suitable for sharing with buyers.

### Explicit non-goals (per request — "do not worry about paid APIs or plans")

- ❌ No paid APIs (SerpAPI, Go-UPC, etc.).
- ❌ No in-app B-Stock scraping/harvesting (that stays a separate, manual dev tool).
- ❌ No subscriptions, accounts, billing, quotas, or "Pro tiers."
- ❌ No live UPC enrichment over the network.

Everything here runs **locally** on data the user already has, with **zero
recurring cost**.

---

## 2. What we're reusing (assets that already exist)

### From `manifest-platform` (the old project)

| Asset | Location | What it gives us |
| --- | --- | --- |
| **Cleaning engine** | `bstock-harvester/refinery.py` | Battle-tested logic: column auto-mapping (`FIELD_ALIASES`), `clean_upc()`, `parse_price()`, `clean_title()`, "best value" dedup. **Port this to Rust.** |
| **Offline catalog** | `bstock-harvester/master_catalog.csv` | 30,802 cleaned `UPC → title/brand/category/typical-MSRP` rows harvested from 174 manifests. A free, offline enrichment lookup. |
| **Test fixtures** | `bstock-harvester/manifests/*.csv` (174 files) | Real-world B-Stock manifests with messy headers — perfect regression corpus. |
| **Category taxonomy** | `manifest-platform/backend/categories.md` | Canonical Category → Subcategory tree for normalizing/grouping. |
| **UX reference** | `Manifest Lab/ManifestHub.html`, `design-canvas.jsx` | Wireframes for the breakdown layout. |

### From ClientHub (already in place)

| Asset | Location | Note |
| --- | --- | --- |
| Manifest attach/remove | `src-tauri/src/commands.rs` → `attach_lot_manifest`, `remove_lot_manifest` | Stores `media/inventory/<lot_id>/manifest.<ext>`, records `inventory.manifest_path`. |
| Inventory model | `inventory.manifest_path`, `price_type` | Already syncs desktop ↔ Pi ↔ mobile. |
| **PDF export** | `printpdf` (already a dependency) | Reuse for the PDF breakdown — no new dep. |
| **XLSX export** | `rust_xlsxwriter` (already a dependency) | Reuse for cleaned-manifest export. |
| **CSV** | `csv` crate (already a dependency) | Reuse for read + cleaned-CSV export. |
| Lot media dir helper | `lot_media_dir()` in `commands.rs` | Where parsed output + exports live. |
| Manifest UI section | `InventoryView.tsx` LotDetail "Manifest" section | Natural home for the breakdown + export buttons. |

**Net new heavy dependencies required: effectively zero.** The only candidate
additions are `calamine` (read `.xlsx`/`.xls`, since `rust_xlsxwriter` only
writes) and optionally `strsim` (fuzzy header matching). Both are small, pure-Rust.

---

## 3. Key architectural decision — port to Rust, don't bundle Python

The refinery is Python (Polars + rapidfuzz). We have two options:

| Option | Verdict |
| --- | --- |
| **A. Ship Python as a Tauri sidecar** (PyInstaller binary) | ❌ Bloats the installer by ~40–60 MB, complicates the auto-updater, platform-specific build pain, slow cold start. |
| **B. Port the cleaning logic to Rust** (`src-tauri/src/manifest/`) | ✅ Single binary, instant, no new runtime, reuses `printpdf`/`rust_xlsxwriter`/`csv`. The logic is pure string/number munging — a direct, low-risk port. |

**Decision: Option B.** The Python `refinery.py` stays in the `manifest-platform`
repo as the **offline catalog builder** (run occasionally on the dev machine to
regenerate `master_catalog.csv`); ClientHub never executes it at runtime.

---

## 4. Target UX

### 4a. Primary — per-lot manifest breakdown (inside Inventory)

In a lot's detail view, the existing **Manifest** section gains, once a manifest
is attached and parsed:

```
┌ Manifest ───────────────────────────────────────────────┐
│  gaming-pallet.csv         [Re-parse] [Replace] [Remove]  │
│                                                           │
│  557 units · 412 lines · $20,989 ext. retail · avg $37    │
│  ███████ Apparel 38%  █████ Electronics 31%  ███ Toys 18% │
│                                                           │
│  ▸ By category   ▸ By brand   ▸ By condition   ▸ Top items │
│                                                           │
│  [ Export PDF breakdown ]   [ Export cleaned CSV / XLSX ] │
└───────────────────────────────────────────────────────────┘
```

- KPI strip: total units, line count, total extended retail, average unit retail,
  distinct UPCs, % of lines missing UPC/price.
- Collapsible breakdown tables (category / brand / condition), each with units,
  extended retail, and % of retail.
- "Top items by retail value" table (top 15–25).
- Two export buttons.

This ties directly into the resale workflow: a lot's manifest breakdown becomes
the thing you attach/share when sending the lot to WhatsApp.

### 4b. Secondary — standalone "Manifest Lab" (ad-hoc, not tied to a lot)

A nav entry (or a button on the Inventory page) that opens a drop zone:
"Drop a manifest to clean & break it down." Same parse → breakdown → export, but
without creating a lot. Useful for **evaluating** a pallet *before* you buy it.
(Phase 3 — nice-to-have; the per-lot flow is the priority.)

---

## 5. Data model

### 5a. Rust types (`src-tauri/src/manifest/model.rs`)

```rust
pub struct ManifestLineItem {
    pub sku: Option<String>,          // Item # / line id
    pub upc: Option<String>,          // normalized GTIN (8..14 digits) or None
    pub title: Option<String>,        // cleaned description
    pub brand: Option<String>,
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub condition: Option<String>,    // NEW / USED_GOOD / SALVAGE / ...
    pub qty: i64,                     // default 1 when absent
    pub unit_retail: Option<f64>,
    pub ext_retail: Option<f64>,      // qty * unit_retail when missing
}

pub struct GroupStat {              // one row of a breakdown table
    pub key: String,                  // category / brand / condition value
    pub lines: i64,
    pub units: i64,
    pub ext_retail: f64,
    pub pct_of_retail: f64,
}

pub struct ManifestSummary {
    pub total_lines: i64,
    pub total_units: i64,
    pub total_ext_retail: f64,
    pub avg_unit_retail: f64,
    pub distinct_upcs: i64,
    pub lines_missing_upc: i64,
    pub lines_missing_price: i64,
    pub by_category: Vec<GroupStat>,
    pub by_brand: Vec<GroupStat>,
    pub by_condition: Vec<GroupStat>,
    pub top_items: Vec<ManifestLineItem>, // sorted by ext_retail desc
}

pub struct ParsedManifest {
    pub source_file: String,
    pub detected_columns: Vec<(String, String)>, // canonical -> actual header
    pub items: Vec<ManifestLineItem>,
    pub summary: ManifestSummary,
    pub parsed_at: String,            // RFC3339
    pub warnings: Vec<String>,        // e.g. "No UPC column found"
}
```

### 5b. Storage (no DB schema churn)

Write parse output **next to the manifest file** in the lot media dir:

```
media/inventory/<lot_id>/
  manifest.csv                 ← raw upload (already exists)
  manifest.parsed.json         ← ParsedManifest (cache; regenerated on re-parse)
  manifest.breakdown.pdf       ← last exported PDF (optional, on demand)
  manifest.clean.csv / .xlsx   ← last exported cleaned file (on demand)
```

- `manifest.parsed.json` syncs via Syncthing like other media, so the Pi/mobile
  can read the same breakdown without re-parsing.
- **Optional** tiny cache column for the inventory card: add
  `manifest_summary_json TEXT` to `inventory` (one nullable column, mirror it on
  the Pi exactly like we did for `price_type`/`manifest_path`) so the card can
  show "557 units · $20,989" without opening the file. *Defer unless the card
  needs it — the parsed JSON file is enough for the detail view.*

---

## 6. The cleaning pipeline (Rust port of `refinery.py`)

Module layout under `src-tauri/src/manifest/`:

```
manifest/
  mod.rs        // public entry: parse_manifest(path) -> ParsedManifest
  read.rs       // CSV/TSV/XLSX/XLS readers -> Vec<row maps>
  columns.rs    // FIELD_ALIASES + header normalization + match_columns()
  clean.rs      // clean_upc, parse_price, clean_title, clean_text, clean_condition
  summary.rs    // build ManifestSummary (the breakdowns)
  catalog.rs    // OPTIONAL offline UPC enrichment from bundled master_catalog
  export_pdf.rs // printpdf breakdown
  export_table.rs // cleaned CSV + XLSX
  model.rs      // structs above
```

### 6a. Column auto-mapping (`columns.rs`)

Port `FIELD_ALIASES` and **extend it** for breakdown fields the refinery ignored
(it only cared about catalog fields). Observed B-Stock headers:
`Item #, Seller Category, Item Description, Qty, Unit Retail, Ext. Retail, Brand,
UPC, TCIN, Category, Condition, Product Class, Department, Subcategory, Pallet ID,
Lot ID`.

```
sku         ← item #, item number, line, lpn, item id
upc         ← upc, ean, gtin, barcode, product id, upc code      (from refinery)
title       ← item description, description, title, product name (from refinery)
brand       ← brand, manufacturer, mfg                            (from refinery)
category    ← category, seller category, department, product class, class
subcategory ← subcategory, sub category
condition   ← condition, optoro condition, item condition         (NEW)
qty         ← qty, quantity, units, count, pieces, pairs          (NEW)
unit_retail ← unit retail, unit price, msrp, retail, list price   (extend refinery)
ext_retail  ← ext. retail, ext retail, extended retail, total retail (NEW)
```

Matching strategy (dependency-light): normalize each header (lowercase, strip
punctuation, collapse spaces — same as refinery's `normalize_header`), then for
each canonical field take the **first exact alias match**, falling back to a
**substring/contains** match. Optionally add `strsim::jaro_winkler` ≥ 0.9 as a
third pass to replicate rapidfuzz behavior. Record the chosen mapping in
`ParsedManifest.detected_columns` so the UI can show "we read column X as Y".

### 6b. Per-field cleaners (`clean.rs`) — direct ports

- **`clean_upc`** — port verbatim: handle Excel scientific notation (`1.23E+11`),
  strip leading apostrophe, remove spaces/hyphens, repad 10/11-digit values with
  leading zeros, validate `^\d{8,14}$`. Return `None` if not a barcode.
- **`parse_price`** — strip currency/commas, reject `n/a`/`null`, non-negative.
- **`clean_title`** — strip liquidation prefixes (`TGT-`, `WMT-`, `LULU-`, …) and
  junk tokens (`AS-IS`, `BULK`, `PALLET`, `LOT-####`, `SKU-####`, `DPCI-####`),
  collapse whitespace/hyphens, smart title-case preserving acronyms (`USB`,`LED`)
  and model numbers.
- **`clean_condition`** (new, small) — uppercase + canonicalize to a small set:
  `NEW`, `LIKE_NEW`, `USED_GOOD`, `USED_FAIR`, `SALVAGE`, `UNKNOWN`. Maps B-Stock's
  `Optoro Condition` letters/labels and free text onto these buckets.
- **`qty`** — parse int, default `1` if missing/invalid (so unit totals stay sane).
- **`ext_retail`** — use the column if present and valid; otherwise compute
  `qty * unit_retail`.

### 6c. Reading files (`read.rs`)

- `.csv` / `.txt` / `.tsv` → `csv` crate (already a dep), flexible/ragged-line
  tolerant, header row = first non-empty row.
- `.xlsx` / `.xlsm` / `.xls` → **`calamine`** (new small dep) — read first sheet
  (or the sheet with the most rows) into the same row-map shape.
- Robustness: skip fully-empty rows; tolerate trailing junk rows; cap at e.g.
  500k rows with a warning.

---

## 7. Breakdowns (`summary.rs`)

From the cleaned `Vec<ManifestLineItem>` compute `ManifestSummary`:

- **Totals:** `total_lines`, `total_units = Σ qty`, `total_ext_retail = Σ ext_retail`,
  `avg_unit_retail = total_ext_retail / total_units`, `distinct_upcs`,
  `lines_missing_upc`, `lines_missing_price`.
- **Grouped tables** (`by_category`, `by_brand`, `by_condition`): group items by the
  key, sum `lines`/`units`/`ext_retail`, compute `pct_of_retail`, sort by
  `ext_retail` desc. Bucket blanks as `"Uncategorized"` / `"Unbranded"` /
  `"UNKNOWN"`. Cap brand table to top N (e.g. 25) + an "Other" roll-up.
- **Top items:** items sorted by `ext_retail` desc, take 25.

These power both the on-screen panel and the PDF.

---

## 8. Exports

### 8a. Cleaned manifest — CSV + XLSX (`export_table.rs`)

Write the normalized items with a **fixed, standardized column order**:

```
SKU | UPC | Title | Brand | Category | Subcategory | Condition | Qty | Unit Retail | Ext Retail
```

- CSV via the `csv` crate.
- XLSX via `rust_xlsxwriter`: bold header row, frozen top row, currency format on
  the two retail columns, autofit-ish widths, and a second **"Summary"** sheet with
  the totals + breakdown tables.

This is the "reformat manifest" deliverable: messy 20-column B-Stock export →
clean 10-column standardized file.

### 8b. PDF breakdown (`export_pdf.rs`, via `printpdf`)

A shareable buyer-facing PDF:

1. **Header** — lot name (or file name), date, ClientHub mark.
2. **Summary band** — total units, total ext. retail, line count, avg unit retail.
3. **Category breakdown table** — Category | Units | Ext Retail | % (with simple
   bar glyphs or shaded cells).
4. **Brand breakdown table** — top brands + Other.
5. **Condition breakdown** — NEW vs used vs salvage split (buyers care a lot).
6. **Top items** — top 20 by ext. retail.
7. Footer — "Generated by ClientHub · figures from manifest, not guaranteed."

Mirror the structure of the existing invoice/quote PDF code so styling is
consistent with the rest of the app.

---

## 9. New Tauri commands (`commands.rs` + `main.rs` handler)

```rust
// Parse (or re-parse) a lot's attached manifest; writes manifest.parsed.json,
// returns the ParsedManifest for the UI.
parse_lot_manifest(lot_id: String) -> Result<ParsedManifest, String>

// Read the cached parse without re-parsing (fast path for opening a lot).
get_lot_manifest_breakdown(lot_id: String) -> Result<Option<ParsedManifest>, String>

// Ad-hoc parse of any file path (Manifest Lab, no lot involved).
parse_manifest_file(path: String) -> Result<ParsedManifest, String>

// Exports — write into the lot media dir (or a user-chosen path) and return the path.
export_manifest_pdf(lot_id: String, dest: Option<String>) -> Result<String, String>
export_manifest_clean(lot_id: String, format: String /* "csv"|"xlsx" */, dest: Option<String>) -> Result<String, String>
```

- Hook `parse_lot_manifest` into the **existing `attach_lot_manifest`** so a manifest
  is parsed automatically right after it's attached (best UX — breakdown appears
  immediately). Keep a manual **Re-parse** button for when a file is replaced.
- Register all new commands in `main.rs` `generate_handler!`.

---

## 10. Frontend changes (`src/`)

- **`src/lib/api.ts`** — add typed wrappers + a `ParsedManifest`/`ManifestSummary`
  TypeScript interface mirroring the Rust structs.
- **`src/components/InventoryView.tsx`** — in the LotDetail Manifest section, after
  attach, call `getLotManifestBreakdown`; render KPI strip, the collapsible
  breakdown tables, and the two export buttons. Restrained styling per the
  standing design directive (neutral tables, one accent for the retail bars).
- **`src/components/ManifestLab.tsx`** *(Phase 3)* — standalone drop-zone view that
  calls `parseManifestFile` and reuses the same breakdown sub-components.
- Factor the breakdown UI into a shared `ManifestBreakdown.tsx` so the lot view and
  the Lab both use it.

---

## 11. Optional offline enrichment (free, no API) — `catalog.rs`

The harvested `master_catalog.csv` (30,802 UPCs) can clean up *user* manifests
with **zero network calls**:

- Bundle a compact form of it as an app resource (Parquet is overkill in Rust;
  ship a **sorted CSV** or a small bundled **SQLite** read-only file via
  `tauri.conf.json` → `bundle.resources`, ~1–3 MB).
- During parse, for any line whose title is junk/empty but whose UPC matches the
  catalog, substitute the catalog's cleaned title/brand/category and flag the line
  `enriched: true`.
- Strictly additive and offline. **Phase 4 / optional** — the core reformat +
  breakdown + PDF works without it.

> Note: only ship *derived* UPC→title data (as the harvester README already
> stresses), never raw sourced manifests.

---

## 12. Sync, Pi, and mobile

- `manifest.parsed.json` lives in the lot media dir → Syncthing replicates it to
  the Pi automatically; no API change needed for storage.
- **Mobile (Phase 5, optional):** add a Pi route `/api/inventory/:id/manifest` that
  returns the parsed JSON (or just serve the `.parsed.json` over the existing
  `/media` mount) and render a read-only breakdown in `clienthub-api/www/app.js`'s
  inventory detail. Low priority; desktop is where manifests get processed.
- If we add the `manifest_summary_json` cache column, mirror it in
  `clienthub-api/src/sync.rs` and surface it in `/api/inventory` exactly like the
  `price_type`/`manifest_path` change — otherwise upserts that set it would fail.

---

## 13. Phased delivery

| Phase | Deliverable | Effort |
| --- | --- | --- |
| **0. Scaffold** | `manifest/` module, structs, wire `parse_manifest_file` command + a throwaway test that parses one sample file and prints the summary. | ~0.5 day |
| **1. Cleaning core** | Port `columns.rs` + `clean.rs`; CSV reader; run against all 174 fixtures, assert no panics + sane totals. | ~1 day |
| **2. Breakdown + per-lot UI** | `summary.rs`, `parse_lot_manifest` (auto-run on attach), `ManifestBreakdown.tsx`, KPI + tables in LotDetail. | ~1.5 days |
| **3. Exports** | `export_table.rs` (CSV/XLSX) + `export_pdf.rs`; export buttons. | ~1.5 days |
| **4. XLSX input + Manifest Lab** | `calamine` reader; standalone `ManifestLab.tsx`. | ~1 day |
| **5. Optional enrichment + mobile** | Bundled catalog lookup; Pi/mobile read-only breakdown. | ~1–2 days |

Phases 1–3 deliver the entire requested feature (reformat + clean + breakdown +
PDF). 4–5 are polish.

---

## 14. File-by-file change list (Phases 0–3)

**ClientHub `src-tauri/`**
- `Cargo.toml` — add `calamine` (Phase 4) and optionally `strsim`.
- `src/manifest/` — new module (`mod, read, columns, clean, summary, model,
  export_pdf, export_table`).
- `src/commands.rs` — new commands (§9); call `parse_lot_manifest` from
  `attach_lot_manifest`.
- `src/main.rs` — register new commands.
- *(optional)* `src/sync.rs`-equivalent / DB init — add `manifest_summary_json`.

**ClientHub `src/`**
- `src/lib/api.ts` — wrappers + TS types.
- `src/components/ManifestBreakdown.tsx` — new shared component.
- `src/components/InventoryView.tsx` — render breakdown + export buttons in LotDetail.
- *(Phase 4)* `src/components/ManifestLab.tsx` + nav entry.

**Pi `clienthub-api/` (Phase 5, optional)**
- `src/routes/inventory.rs` — serve parsed breakdown.
- `src/sync.rs` — mirror `manifest_summary_json` if added.
- `www/app.js` — read-only mobile breakdown.

---

## 15. Edge cases & risks

- **No UPC column** — common; the breakdown still works off qty/retail/category.
  Only the optional catalog enrichment needs UPC. Emit a warning, don't fail.
- **No price column** — totals show units only; mark retail as "n/a"; don't divide
  by zero for `avg_unit_retail`.
- **Missing Ext Retail** — derive `qty * unit_retail`; if both missing, treat as 0
  and count the line in `lines_missing_price`.
- **Multi-sheet / metadata-row XLSX** — pick the sheet with the most data rows;
  detect the header row by the row with the most non-empty cells.
- **Huge truckload manifests** (the samples go to 4,500+ lines) — parse is O(n),
  fine; cap + warn beyond ~500k rows.
- **Encoding / BOM / ragged rows** — the `csv` crate + flexible mode handles most;
  fall back to lossy UTF-8.
- **Duplicate UPCs within one manifest** — *do not* dedup for a per-manifest
  breakdown (every line is real inventory); dedup is only a catalog concern.
- **Currency symbols / thousands separators** — handled by `parse_price`.

---

## 16. Testing

- **Fixtures:** copy a dozen representative files from
  `manifest-platform/bstock-harvester/manifests/` into
  `src-tauri/tests/fixtures/manifests/` (varied: gaming, footwear, FBA home
  improvement, truckloads, the malformed ones).
- **Unit tests:** `clean_upc`/`parse_price`/`clean_title`/`clean_condition` table
  tests ported from the refinery's known cases (sci-notation, prefixes, etc.).
- **Integration test:** parse every fixture → assert no panic, `total_units > 0`,
  `total_ext_retail >= 0`, and that detected columns include `qty` + a retail field.
- **Golden test:** snapshot the `ManifestSummary` for 2–3 fixtures so refactors
  don't silently change the math.
- **Manual:** attach a manifest to a lot, confirm the breakdown renders, export PDF
  + XLSX, eyeball against the source file's stated "Ext. Retail $X" in its filename.

---

## 17. Open questions for Jack

1. **Home for the feature** — is the per-lot Manifest section enough for v1, or do
   you also want the standalone "Manifest Lab" drop-zone in the first cut?
2. **PDF audience** — internal record, or buyer-facing (affects whether we show
   cost/margin or *only* retail + condition split)?
3. **Auto-parse on attach** — parse immediately when a manifest is attached
   (recommended), or only when the user clicks "Break down"?
4. **Offline catalog enrichment** — worth bundling the 30k-UPC lookup in v1, or
   defer until the core ships?
5. **Condition buckets** — is the `NEW / LIKE_NEW / USED_GOOD / USED_FAIR /
   SALVAGE` set right for how you talk to buyers, or do you want different labels?

---

### TL;DR

Port `refinery.py`'s proven cleaning logic to a Rust `manifest/` module in
ClientHub, compute category/brand/condition breakdowns, and export a clean
CSV/XLSX + a PDF — all offline, reusing `printpdf`/`rust_xlsxwriter`/`csv` that are
already in the app. Wire it into the existing per-lot Manifest section (auto-parse
on attach). No Python runtime, no APIs, no plans. Phases 1–3 (~4 days) deliver the
full ask; the rest is polish.
