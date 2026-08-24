# Lot engine — build plan (R-200)

**Date:** 2026-08-24 · **Request:** R-200 · **Spec:** `docs/LOT-ENGINE-SPEC-rev2.html` · **Vault note:** `requests/R-200-lot-engine.md`
**Measured against:** BUSINESS APP @ `0a9ed67`, clienthub-api @ deploy-43, by nine read-only agents on 2026-08-24.

> Every `file:line` below was verified on 2026-08-24. They drift — locate by symbol.

---

## 1. What we are building

A warehouse hands over a manifest. The engine cleans it into **stacks** (one product in one slot), then you build lots by **ranking and taking whole warehouse locations** — never by allocating SKUs. The headline is Jack's: *"finding lots that have a high percentage of a specific brand or category"*, and *"location specific lots like this need to be able to be quickly sorted to make lots."*

Two rules from the spec bind the whole design:

1. **A location is all-or-nothing.** Filters rank and qualify slots; they never select items.
2. **Two rows typed differently are two products.** Titles are never merged or rewritten.

Plus five things Jack added on 2026-08-24: the dashboard must be **designed**, not merely functional; **mobile must be able to upload a sheet**, not just browse one; exports must be **downloadable and emailable**; built lots are **saved**; and lotted slots leave the pool automatically, while **removal from the master list is an explicit button**.

---

## 2. What already exists (so we don't rebuild it)

| Thing | Where | Verdict |
|---|---|---|
| Spreadsheet ingestion — xlsx/xlsm/xlsb/xls/ods/csv/tsv/pdf → one `Grid` | `src-tauri/src/manifest.rs:221` (`grid_from_excel`, calamine 0.26), `:146` (delimited), `:254` (pdf) | **Reuse.** Drop the spec's hand-rolled ZIP/EOCD walker entirely — it would be a second untested parser competing with one behind 16 unit tests (`manifest.rs:925-1163`). |
| Header + column detection | `manifest.rs:321` `find_header_row`, `:353` `find_col`, `:617-661` candidate lists, `:479` `infer_columns` | **Extend.** `Title→description`, `Remaining→quantity`, `MSRP→price` already map. Add candidate lists for `upc` / `location` / `box`. Note the inversion: `infer_columns` currently detects UPC-sized numbers (`>=1e8`) only to *exclude* them — that same heuristic becomes how we *find* the UPC column. |
| Money cell parsing | `manifest.rs:88` `parse_money` | **Reuse.** Handles `$`, thousands separators, nbsp, parenthesised negatives, and is strict enough that a SKU doesn't parse as a number. |
| Per-keystroke ranking over a big table | `src-tauri/src/geocode.rs:195` `suggest` — 37,480 rows re-ranked per keystroke, behind a 140 ms debounce with a stale-response guard (`LocationField.tsx:153-165`) | **Reuse the pattern.** 7,680 slots is 5× smaller than what already ships imperceptibly. The spec's performance anxiety is already answered by this repo. |
| The existing lot | `inventory` table (`db.rs:702-719` + 9 ALTERs), `InventoryLot` (`commands.rs:8080`), `LotForm` (`InventoryView.tsx:1443-2047`) | **Leave alone (D1).** There is no `lots` table — an Ecliptr lot is one `inventory` row, and the engine does not create one. Named here so nobody confuses the two objects: an engine lot is a `lot_build`. |
| Analysis → prefilled lot form | `ManifestView.tsx:73-81` dispatches `inventory-prefill-lot` → `InventoryView.tsx:237-255` | **Not used (D1).** Kept in mind as the seam if an engine lot should ever become a listable inventory lot — that would be a separate request. |
| Durable large-file movement | `lot_media_dir` (`commands.rs:8224`), `attach_lot_manifest` (`:8591`), `netsync_media_outbound` (`netsync.rs:72-86`), `media_enqueue`/`push_media_pending` (`:1908-1985`), server `/media` ServeDir (`clienthub-api/src/main.rs:186`) | **Reuse.** This is how 96,834 stacks move between machines without touching the oplog. |
| Server-owned staging table that deliberately does **not** sync | `inbound_load` (`clienthub-api/src/schema.sql:755`) + `routes/loads_inbox.rs` | **Copy the shape** for the server's stack table. |
| Authed file upload | `POST /api/inventory/:id/manifest/:name` (`clienthub-api/src/routes/inventory.rs:95-144`) — org-scoped, path-sanitised, 25 MB in-handler cap | **Extend by one line.** See §7 landmine 3. |
| Export dependencies | `rust_xlsxwriter 0.77`, `csv 1.3`, `printpdf 0.7` already in `src-tauri/Cargo.toml`; `invoice.rs::build_pdf_bytes` and `release_letter.rs` as document-command precedents | **Reuse.** No new crate on desktop. |
| Email send path | existing invoice/quote mail (`src-tauri/src/email.rs`, server `/api/invoices/:id/email`) | **Reuse.** No new mail plumbing. |

**Confirmed absent — this is the real build:** no per-row struct anywhere (`ManifestAnalysis` returns aggregates only and `analyze_rows` discards every row's identity), no UPC retention, no brand dictionary (`ai.rs` prompt explicitly forbids inferring one), no size or segment parsing, no warehouse-slot grammar, no ranking engine, no staged/removed state, no conflicts screen, no quality report beyond a bare `skipped_rows` integer.

---

## 3. Three decisions the recon forces

### 3.1 One engine, in Rust, compiled into both binaries

The spec warns hard about maintaining two copies of the classification dictionaries. Ecliptr risks **three** (Rust, React/TS, vanilla JS). The answer is to put *everything numeric* — the location grammar, the classifier, the seven pipeline stages, the ranking maths, the export builders — in **one Rust module, `lot_engine/`, that exists byte-identically in both repos**, with:

- a `SHA256` fixture test in both CI runs asserting the module tree hash matches a committed constant, so drift fails the build rather than shipping;
- the spec's own parity test: a checked-in fixture workbook cleaned by both binaries, asserting **field-by-field equality across every row**, not just totals. That test is what caught four real bugs in the original build.

**The UIs never re-implement the maths.** React calls a Tauri command; the PWA calls a REST endpoint; both hit the same function. This is a strict improvement on the spec, which accepted a Python cleaner and a JS cleaner and then had to diff them.

### 3.2 Stacks never touch the oplog

96,834 stacks through `record_upsert` would write 96,834 JSON event files (`sync.rs:386`), 96,834 `netsync_outbound` rows, and ~1.16 M `row_clocks` rows — against a stated design assumption of **~1k events on a heavy day** (`netsync.rs:293-300`), with no pruning, compaction or retention anywhere in either engine. It would also wedge the push queue permanently: on a non-2xx, `netsync.rs:401` bails *before* the `MAX_PUSH_RETRIES` bookkeeping, so an oversized batch re-sends every 20 s forever and blocks every later write in the org behind it.

So:

| Data | Volume | Transport | Storage |
|---|---|---|---|
| Cleaned stacks | ~97k rows/sheet | **`stacks.jsonl` artifact** through the existing durable media queue, both directions | Local unsynced table on each side (`lot_stack`), rebuilt from the artifact |
| Quality report, location audit map | small files | same artifact path | files under `media/lotsheets/<sheet_id>/` |
| Sheet summary | 1 row/sheet | oplog | `lot_sheet` (new synced table) |
| Slot state (staged/removed) | only slots actually touched | oplog | `lot_slot_state` (new synced table) |
| The built lot | 1 row | oplog | `lot_build` (new synced table — an engine artifact, not an `inventory` row; see D1) |

`lot_slot_state` is bounded by what you touch, not by 7,680 × sheets. This is strictly better than the spec, whose staged/removed state lives in browser `localStorage` with no second copy — the spec itself has to ship an export/import to compensate. Ours syncs and is backed up.

### 3.3 Mobile uploads for real, and ranking is server-side

Jack: *"have this work identically on mobile if i upload a list on there."* The PWA today has **no** `FileReader`, `ArrayBuffer`, `DecompressionStream`, `FormData`, Worker, WASM or IndexedDB anywhere in 9,638 lines — and the server has no spreadsheet crate at all. So:

- Add `calamine` to the server and the shared `lot_engine` module. The phone uploads raw bytes to a new endpoint; the **server** cleans it with the same code the desktop uses.
- Ranking on mobile is a `POST .../rank` behind a 250 ms debounce with a stale-response guard, matching the PWA's existing debounce convention (`app.js:1402, 3539, 4983`). Identical maths, one network hop.
- Desktop ranks through Tauri IPC against its local table, exactly as `geocode.rs::suggest` already does.

Parity is honoured in behaviour and results; only the transport differs, which is already true of every other screen.

---

## 4. Data model

### New synced tables (both engines, server deployed **first** — `db.rs` migration 81's own comment, gotchas §6)

```sql
-- migration 82
CREATE TABLE lot_sheet (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
  source_filename TEXT, imported_at TEXT NOT NULL, imported_by TEXT,
  rows_in INTEGER, stacks INTEGER, products INTEGER, units INTEGER,
  locations INTEGER, msrp_total REAL,
  artifact_path TEXT,          -- media/lotsheets/<id>/stacks.jsonl
  report_path TEXT, audit_map_path TEXT,
  quality_json TEXT,           -- drops by reason, repairs, title_risk histogram
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT
);

-- migration 83
CREATE TABLE lot_slot_state (
  id TEXT PRIMARY KEY,               -- sheet_id || '' || location_code
  sheet_id TEXT NOT NULL, location_code TEXT NOT NULL, org_id TEXT NOT NULL,
  state TEXT NOT NULL,               -- 'staged' | 'removed'   (absent row = available)
  lot_id TEXT, note TEXT,
  changed_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_lot_slot_state_sheet ON lot_slot_state(sheet_id, state);
```

`id` is a composite joined with `` — a character that cannot occur in the data. The spec's own trap list names the empty-separator collision; the vault's does too.

```sql
-- migration 84 — the saved lot. An engine artifact (D1): no inventory row, no storefront.
CREATE TABLE lot_build (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, sheet_id TEXT NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',  -- draft | saved | sent
  price_pct REAL,                  -- global % of MSRP, set by Jack (D2)
  price_pct_json TEXT,             -- per-category overrides {"Footwear":0.26}
  locations INTEGER, units INTEGER, styles INTEGER,
  msrp_total REAL, ask_total REAL, -- ask_total = SUM(round(msrp*pct,2) * units)
  brands_json TEXT, categories_json TEXT, title_risk_json TEXT,
  notes TEXT, archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT, updated_at TEXT
);
```

`lot_slot_state.lot_id` points at `lot_build.id`. All three new tables are small and safe to sync.

### Pricing (D2)

Price is a **property of the line, not of the lot**. One pure function, in the shared Rust module, used by the UI, the totals and all three exports:

```
pct(category)   = overrides[category] ?? global_pct
unit_price(row) = round2(row.msrp * pct(row.category))
extended(row)   = unit_price(row) * row.units
ask_total(lot)  = SUM(extended)
```

So a $75-retail shoe at 26% is $19.50 a shoe — the figure Jack checks in the category summary. `msrp = 0` yields `unit_price = 0`, surfaced in the quality report rather than silently priced at nothing.

### Local unsynced table (both sides, identical DDL)

```sql
CREATE TABLE lot_stack (
  sheet_id TEXT NOT NULL, location TEXT NOT NULL, box TEXT NOT NULL DEFAULT '',
  upc TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  units INTEGER NOT NULL, msrp REAL NOT NULL DEFAULT 0,
  brand TEXT, category TEXT, segment TEXT, size_us REAL,
  desc_known INTEGER NOT NULL DEFAULT 1,
  title_risk INTEGER NOT NULL DEFAULT 0,
  upc_ambiguous INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sheet_id, location, box, upc, title)
);
CREATE INDEX idx_lot_stack_loc ON lot_stack(sheet_id, location);
```

Rows are **sorted by location on insert**, so the per-slot index is a contiguous range — the single choice the spec credits for making re-ranking imperceptible.

### On the built lot

`inventory.quantity` = the lot's unit total (already the column's semantic). `details_json` gains one key, needing no migration and no server schema change:

```json
"lot_engine": { "sheet_id": "...", "locations": 41, "units": 3003,
                "msrp_total": 284119.00, "brands": [{"name":"Nike","units":2140}],
                "title_risk": {"0":2967,"1":32,"2":4,"3":0} }
```

---

## 5. The dashboard

Jack: *"the whole dashboard for using it to be super well designed and responsive."*

### Desktop — `LotEngineView.tsx`, a child under **Inventory** in the sidebar (`App.tsx:488-529`)

```
┌ Sheet ▾  Master list · 179,672 units · $17.07M · 7,680 slots        Quality ● 3% to verify ┐
├──────────────┬────────────────────────────────────────────────┬──────────────────────────┤
│ WANT         │  43-127-04A                          96% of it │  Lot being built         │
│  Brand ▾     │  48 units · 10 styles · $4,690 · 46 you want    │  41 slots · 3,003 units  │
│  Size range  │  Nike        ████████████████████  46          │  $284,119 MSRP           │
│  MSRP range  │  New Balance █                      2          │                          │
│              │  Comes with 2 other units: New Balance 2       │  Nike 71% · NB 14% · …   │
│ ALLOW        │                          [ Add whole location ]│  2.5 units of something  │
│  Categories  │ ────────────────────────────────────────────── │  else per unit you want  │
│  Segment     │  43-127-05A                          94% of it │                          │
│  Described   │  …                                             │  ▸ staged slots (41)     │
│  Brand-lock  │                                                │                          │
│              │                                                │  [Save lot] [Export ▾]   │
│ Slack ──●──  │                                                │  [Email…]                │
│ Sort: ◉ Conc │                                                │                          │
│       ○ Vol  │                                                │                          │
│ Min size __  │                                                │                          │
└──────────────┴────────────────────────────────────────────────┴──────────────────────────┘
```

- **WANT** ranks and excludes nothing; **ALLOW** decides what qualifies. Two panels, visually distinct, each labelled with what it does — collapsing them is wrong in both directions (spec §06: 4,477 slots vs 179 vs the correct 2,449).
- **Slack** is one slider, 0 % strict. The sort toggle **states its cost inline**: *"Concentration puts small slots first — top 100 ≈ 1,100 units. Volume gets 1,940 from the same 100."*
- Brand bars are `bg-accent` on `bg-surface-3` with `ring-1`. **No `bg-white`, no `#fff`** — mono-light and mono-dark invert the accent (`index.css:561-572`).
- Sentence case throughout. No uppercase kickers, no mono tabular numerals, no emoji — the spec's own stylesheet violates all three of our hard rules and is **not** to be ported.
- Rendering is capped (top N cards) while ranking runs over the full set — the pattern already used at `app.js:1355-1401`. No virtualisation library is installed and none is needed.

**Responsive**, per the 216 px-sidebar rule (`App.tsx:120-127` — breakpoints shift up a step): at `xl` the right rail collapses to a sticky bottom summary bar; at `lg` the left rail becomes a "Filters (3)" drawer. Every column gets `min-w-0`.

### Mobile — `renderLotEngine()` in `www/app.js`

Single column. Sticky header with sheet + live pool totals. A **Filters** button opening an `openDetailPanel` sheet carrying the identical WANT/ALLOW/slack/sort controls with an active-count badge. Cards render the same four lines and the same "Comes with". The lot under construction is a bottom sheet with a count badge. Upload is a plain `<input type="file">` posting raw bytes — the first binary upload path in the PWA.

---

## 6. Build order

Each phase is useful alone and depends only on those above it. The spec's own warning applies: *"Steps 1–3 are where the value is. A perfect interface over unnormalised locations and merged products will confidently sell stock that isn't there."*

| # | Phase | Ships | Done when |
|---|---|---|---|
| **0** | `lot_engine` core in Rust — slot grammar + repair ladder, classifier dictionaries, stages 1–7, quality report, ranking, exports. Unit test per spec trap. | nothing user-visible | Fixture sheet reconciles: `sum(stack.units) == sum(input.Remaining) − reported drops`, every drop carrying a reason and a count |
| **1** | Desktop import + quality report. New screen, drop a sheet, clean it, show the funnel, the drops, the `title_risk` histogram, the raw→canonical audit map. | You can tell whether a sheet is trustworthy | Spelling count collapses, audit map looks right, no row unaccounted for |
| **2** | **Desktop lot builder** — location index, WANT/ALLOW, slack, both sorts, cards with brand bars and "comes with", live pool totals. | **The headline.** Fast concentration sorting. | The spec's three-row table reproduces: Nike+footwear gives 4,477 / 179 / **2,449** |
| **3** | Saved lots + slot state. `lot_sheet`, `lot_slot_state`, staging leaves the pool, "Build lot" opens the prefilled full lot form, explicit **Remove from master list**. | Lots persist; nothing gets sold twice | Staged slots vanish from results and totals; removal survives a re-import of a refreshed export |
| **4** | Exports + email. Buyer manifest, brand counts, pull sheet in walk order; copy-all location codes in one action; send via the existing mail path. | The three artifacts | `sum(manifest.qty) == sum(pull_sheet.units) == sum(brand_counts.units) == lot.units` |
| **5** | Server + mobile. `calamine` + `lot_engine` on the server, body-limit fix, upload/rank/stage/save/export endpoints, PWA screens. | Full parity including upload | Field-by-field parity test passes between the two binaries on the same fixture |
| **6** | Conflicts screen. Barcodes carrying two or more names, graded split/stray/sameBrand/other, searchable, CSV export. | The counterweight to rule two | A user can see what any barcode means |

---

## 7. Landmines (each already fired once here)

1. **Never-erase.** Re-importing a refreshed export must **keep** `lot_slot_state` rows whose location is absent from the new sheet — *absent means shipped, not undone*. A re-import is a merge, never a delete. (`00-RULES` rule 2, spec §08.)
2. **Tombstones are permanent and one-way.** `record_delete` writes a tombstone kept forever and `apply_upsert` skips any event whose tombstone is `>=` its HLC (`sync.rs:550-607`). Slot state changes are **UPDATEs on a stable key**, never delete-then-insert, or a staged→available→staged cycle makes the slot permanently unrecreatable.
3. **Axum's 2 MB default body limit** rejects a 4.4 MB workbook with 413 *before* the handler runs — the existing 25 MB check at `routes/inventory.rs:95-144` is currently unreachable. Add `.layer(DefaultBodyLimit::max(...))` exactly as `settings.rs:29` does. Same limit applies to `POST /api/sync/push`.
4. **`json_extract` raises on an empty string** rather than returning NULL (gotchas §1) — this blanked every financial screen in v0.15.116. Every read of the new `details_json.lot_engine` key goes through `CASE WHEN json_valid(col) THEN …`.
5. **Never chain `filter_map(|r| r.ok())` over a row mapper** (gotchas §2). An importer whose column list drifts from its mapper silently yields *zero* stacks, and an empty lot reads as a legal answer. The mapper and its column list come from one shared constant; the first row error aborts with a reason.
6. **Storefront column list is positional.** `PUBLIC_LOT_COLUMNS` (`storefront.rs:62-66`) is index-synced with `row_to_public_lot`, and the BJM website hydrates from the same feed. Any new public field is **appended**, never inserted.
7. **Server deploys before desktop** for any new synced table, or `apply_upsert` logs SCHEMA DRIFT and silently drops the columns out of every event (gotchas §6). Five hard-coded lists to update: desktop `sync.rs:610` + `netsync.rs:38`; server `sync.rs:1013`, `:1536`, `:1697` — and `ALLOWED_TABLES` before `PUSHABLE`.
8. **Bump `?v=` in `www/index.html:169`** (currently `116`) in the same commit as any `app.js` change, or the feature is live on the server and invisible on the phone (gotchas §5). `sw.js:34-49` caches every ok same-origin non-`/api/` GET — the stacks artifact must not be fetched from `/media` on mobile, or the service worker caches 4.4 MB of it.
9. **Desktop memory and IPC.** `grid_from_excel` materialises *every* sheet as `Vec<Vec<String>>` before scoring (`manifest.rs:236-243`), and returning 96,834 stacks over IPC as JSON would be a multi-hundred-MB serialize. The command returns the summary plus the 7,680-row location index only; stacks go to disk and to the local table. A row cap with an honest warning goes in at the same time — `manifest.rs` has none today.
10. **Replacing `keyword_map` is a behaviour change to shipped code.** It is applied as first-match-wins over an **unordered** `HashMap` (`manifest.rs:372-399`, used at `:704-718`), so a description matching two keywords classifies differently between runs. That is a latent bug regardless, but swapping it changes the existing Manifest analyzer's output for the same file — deliberate, noted, not slipped in.
11. **Warehouse slot codes are a different namespace from `inventory.location`.** That column is the canonical FOB `City, ST` driving the storefront state map and the BJM site, duplicated across four runtimes. `43-127-04A` must never be written there.
12. **Diff every file against the last tag before committing** — concurrent sessions edit these same files, and 10 files are already modified in this working tree.

---

## 8. Decisions — answered 2026-08-24

**D1 — a saved lot is an engine artifact, not an Ecliptr inventory lot.** It does not create an `inventory` row, does not reach the storefront, and is not sellable or invoiceable from the engine. The storefront, `offers` and deal-linking are entirely out of scope. This roughly halves phase 3.

**D2 — pricing is per line, derived from MSRP.** Customer unit price = `MSRP x pct`, evaluated per line. The percentage is **set by Jack**, with a global default and **per-category overrides** — *"price per unit per shoe on categories"*. The lot's total ask is the sum of line extendeds and moves live as slots are staged. A suggestion from the existing average-completed-margin query may sit beside the field; it is never applied on its own.

**D3 — the buyer manifest carries** description/title, MSRP, customer unit price, qty and line extended per line; a **category summary above the lines** showing units and the per-unit price for that category; and the description-check column, rendered only when there are flagged lines. **Warehouse slot codes stay off the buyer manifest** by default — they belong on the pull sheet — with a toggle for when the buyer collects.

**Decided without asking:** Lot engine is a child under **Inventory** in the sidebar, alongside the existing Manifest analyzer rather than replacing it; ships to every org rather than behind the Pro `manifest` flag; multiple named sheets, with re-import merging into the same sheet and preserving slot state.
