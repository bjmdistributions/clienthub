# Lot branches, combined lots and per-level spreadsheets — implementation map

Requests: **R-218** (combine into branches, children stay live, sold cascades) and
**R-219** (the auto-generated master spreadsheet, per level). Both captured in the vault at
`Ecliptr/requests/00-REQUESTS.md`. Companion: **R-220** (the bottom bar) is already built.

Produced 2026-08-31 by six read-only agents, one per surface, plus a synthesis pass.
81 traps found; the 12 blocker-class ones are listed at the end verbatim.
Two claims were re-verified by hand before this file was written — see "Verified by hand".

Jack's words, which are the spec:

> "i also want the feature and ability to make side lots inside the lots i built out by
> combing. so for example i made a bunch of 1000 unit lots. allow me to select a few to
> combine inside of that, that way all locations can stay together"
>
> "option 2. i need the small unique ones to still stay alilve and show theyre connected in
> the tree but lets say i mark the big combined lot as sold, the other 3 need to be removed."
>
> "I want to create a spreadsheet out of this that uses a master spreadsheet design like the
> following i attatched. have the system be able to auto create this. when i mark a lot in
> there as sold, remove it from the spreadsheet."
>
> "the small lots should always still exist because they will be their own spreadsheet. then
> when i create a branch of combining bigger lots, that specific section will be its own
> spreadsheet"
>
> "just flag it, dont dissolve the parent"

## Verified by hand, not taken from an agent

1. **Migration 85 is already taken.** `git show lot-engine-mapping:src-tauri/src/db.rs`
   defines 85 (R-216, pushed, unmerged). `main` tops out at 84. So this work takes **86**,
   and that branch's 85 must be renumbered to 87 before it merges — `run_migrations` only
   runs `version > current`, so an 85 arriving after 86 has been applied is skipped forever
   on that device. Concurrent sessions make this a live hazard, not a theoretical one.
2. **The un-sell bug is real and latent.** `save_lot_build`'s `ON CONFLICT DO UPDATE` list
   omits `status`, but its emit map sends `("status", "saved")` unconditionally. So
   re-saving a lot resets its status **on every peer** while leaving it correct locally.
   Latent only because no caller supplies `buildId` — `api.ts:3238` sends
   `buildId: p.buildId ?? null` and no call site sets it. It goes live the moment `sold`
   exists. Fix it in the same pass, in both repos.

---

# IMPLEMENTATION MAP — combined lots, branches, per-level spreadsheets, sold cascade

Repos: **A** = `C:/Users/Jack/Desktop/BUSINESS APP` (desktop). **B** = `C:/Users/Jack/Desktop/clienthub-api` (server + `www/` PWA, which is also the iOS bundle's web content).

Verified this session where the lenses disagreed or flagged a blocker; conflicts resolved inline and marked **[verified]**.

---

## 1. DATA MODEL

### Decision: no new tables. Three new columns on `lot_build` + one index. `status` gains a third value.

```
parent_id  TEXT              -- the node this row sits inside. NULL at the top.
kind       TEXT NOT NULL DEFAULT 'lot'   -- 'lot' | 'combined' | 'branch'
sold_at    TEXT              -- RFC3339 stamp; NULL unless status='sold'
CREATE INDEX IF NOT EXISTS idx_lot_build_parent ON lot_build(parent_id);
```

`status` gains `'sold'`. **No schema change is required for that** — there is no CHECK constraint on `lot_build.status` in either repo (`A/src-tauri/src/db.rs:1812`, `B/src/schema.sql:827`; contrast `inventory` at `B/src/schema.sql:283` which does have one).

### The tree

Every node is a `lot_build` row. `parent_id` is the only edge. `kind` is the level tag and the cycle guard:

| kind | parent | owns slots | is | spreadsheet |
|---|---|---|---|---|
| `branch` | always NULL | no (`slots_json='[]'`) | the named section | lists its `combined` children |
| `combined` | must be a `branch` | no (`slots_json='[]'`) | "a few 1000-unit lots combined" | lists its `lot` children |
| `lot` | a `combined`, or NULL | yes (as today) | his 21 B-nnn base lots | — |

Level-0 spreadsheet (his 21 lots) is not a node — it is the query `WHERE sheet_id=? AND kind='lot' AND archived=0 AND status='saved'`. A base lot that has joined a combined lot **still appears there** until it is sold; that is exactly his sentence *"the small lots should always still exist because they will be their own spreadsheet"*, and the sold cascade is what takes it off.

### Why columns and not a new table — defended

A new table costs, per lens 1 and lens 3, both **verified**:

- desktop: migration + `sync::ALLOWED_TABLES` (`A/src-tauri/src/sync.rs:610`) + `netsync::SNAPSHOT_TABLES` (`A/src-tauri/src/netsync.rs:54`) + the guard test at `A/src-tauri/src/netsync.rs:2495` + **both** resync commands, which iterate hard-coded three-element arrays (`lot_store.rs` ~1508 and ~1712) — meaning a new table has **no escape hatch** when a push is rejected-as-acked;
- server: `schema.sql` + `ALLOWED_TABLES` (`B/src/sync.rs:1083`) + `PUSHABLE` (`B/src/sync.rs:1575`) + `SNAPSHOT_TABLES` (`B/src/sync.rs:1753`) + the test at `B/src/sync.rs:1904` + an `org_id` column + an `id` PK. Getting `PUSHABLE` wrong in one direction loses every event **permanently and silently** (`apply_pushed_event` → `Ok(None)` → `rejected` → the desktop dequeues); getting it wrong the other way retries forever.

Columns cost: one desktop migration, one line in the server's ALTER array, and appended reads. Snapshots pick new columns up automatically (`snapshot_table` uses `PRAGMA table_info`). **Both** resync commands cover them automatically because `row_columns` is `SELECT *`. `apply_upsert` on an old peer drops unknown columns *without recording clocks*, so a later re-pull fills them in after the migration lands.

Membership is one-parent-per-child, so a join table buys nothing. A separate `lot_branch` table buys a name and a created_at — which a `lot_build` row already has, along with rename, archive, listing, export and replication that all work today. **Uniform tree on one table wins on every axis.**

### Exact migrations

**Desktop — `A/src-tauri/src/db.rs`, MIGRATIONS array, new entry `(86, r#"..."#)` appended after 84 (`db.rs:1852`).**

```
ALTER TABLE lot_build ADD COLUMN parent_id TEXT;
ALTER TABLE lot_build ADD COLUMN kind TEXT NOT NULL DEFAULT 'lot';
ALTER TABLE lot_build ADD COLUMN sold_at TEXT;
CREATE INDEX IF NOT EXISTS idx_lot_build_parent ON lot_build(parent_id);
```

**86, not 85. [verified]** `main` tops out at 84 (`db.rs:1852`). The pushed-but-unmerged branch `lot-engine-mapping` already defines 85 (`git show lot-engine-mapping:src-tauri/src/db.rs` line 1871 — the R-216 hand-corrected column mapping). See risk R4: whichever number you take, the other branch must be renumbered, because `run_migrations` only runs `version > current` (`db.rs:220`) so a 85 arriving after 86 has been applied is skipped forever.

**Never put a `;` in the migration comment** — the runner splits naively on `;` (`db.rs:229-234`, with the migration-21 post-mortem written above it).

**Server — two files, and only one of them reaches production:**

1. `B/src/schema.sql`, inside `CREATE TABLE IF NOT EXISTS lot_build` (`:823-850`): add the three columns, and add `CREATE INDEX IF NOT EXISTS idx_lot_build_parent ON lot_build(parent_id);` after `:851`. **The CREATE TABLE edit does nothing to the live droplet** — `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table and `schema.sql` contains zero DDL `ALTER` (`grep -c ALTER` = 1, and that hit is a comment at `:846`). The `CREATE INDEX IF NOT EXISTS` **does** apply to the live DB, so the index belongs there.
2. `B/src/sync.rs`, the ALTER array inside `ensure_meta_tables` — **verified**, append after `:609`:

```rust
"ALTER TABLE lot_build ADD COLUMN parent_id TEXT",
"ALTER TABLE lot_build ADD COLUMN kind TEXT NOT NULL DEFAULT 'lot'",
"ALTER TABLE lot_build ADD COLUMN sold_at TEXT",
```

This is **the only path that adds a column to the live droplet database.** The existing precedent for this exact table is at `B/src/sync.rs:602-603` (`cost_pct`, `cost_pct_json`). Skipping it does not error: `apply_upsert` partitions incoming columns against `PRAGMA table_info`, drops the ones the server lacks, logs `SCHEMA DRIFT` at warn level, and **still marks the event applied**, so the pushing desktop dequeues it and the value is gone forever.

---

## 2. EVERY FILE THAT MUST CHANGE

### 2a. SHARED MODULE — `lot_engine/` — one addition, deliberately

Present in both repos byte-identically; guarded by `tests::module_tree_hash_is_pinned`, `PINNED_TREE_HASH = 0x4a797e4690891c3c` **[verified identical in both copies]**.

I considered keeping it untouched, and it *is* technically possible: `Doc`/`Section`/`to_csv`/`to_xlsx` are already generic (`export.rs:26-44`, `:440`, `:484`) and `report.rs::audit_map_csv` (`:179`) proves a `Doc` need not come from stacks — so each repo could hand-build its own four-column `Section`. **I am rejecting that**, for two concrete reasons:

- The header text is load-bearing and easy to get subtly different: his attachment's second column is `"Unit count "` **with a trailing space**, and `Section::col` matches with `eq_ignore_ascii_case` and **no trim** (`export.rs:47-50`).
- Money formatting already differs *inside the engine's own repo*: `export.rs:73` `money()` emits `1234.56` (no `$`, no commas) while `report.rs:29` `money()` emits `$1,234`. His sample wants `$68,700.53`. Two hand-written copies of that will drift, and the drift is a document a buyer holds.

So: **exactly one function and one struct go into the shared module. The tree walk, the SQL, and the status filter stay app-side** (they must — `mod.rs:12-13` forbids `use crate::...`, and `lot_build` is not an engine type).

- `lot_engine/model.rs` — add `pub struct LotLine { pub reference: String, pub units: i64, pub retail: f64, pub sale: f64 }`, deriving `Debug, Clone, Serialize, Deserialize`.
- `lot_engine/export.rs` — add `pub fn lot_roster(lines: &[LotLine], title: &str) -> Doc`: one `Section` with `title: title.into()`, headers `["Ref #", "Unit count", "Retail Value", "Sale Price"]`, one row per line `[reference, units.to_string(), money_usd(retail), money_usd(sale)]`. Add a private `fn money_usd(v: f64) -> String` → `$68,700.53` (thousands-separated, 2dp). Do **not** add a totals row (his sample has none). Do **not** touch `manifest` / `brand_counts` / `pull_sheet` / `reconcile` — appending a roster section to the manifest `Doc` would move the line items off `sections.last()` and break `reconcile` (`export.rs:40-43`, `:293-295`).
- `lot_engine/mod.rs` — add `lot_roster` and `LotLine` to the `pub use` list at `:45`. (Note `to_xlsx` is *not* in that list; callers use `export::to_xlsx`.)
- `lot_engine/tests.rs` — add a golden test asserting the exact CSV of a two-row roster; then **re-pin**: run the test, read the printed actual hash, set `PINNED_TREE_HASH` in **both** copies.

**Re-pin procedure, in one session:** edit in A → `cp -r A/src-tauri/src/lot_engine/* B/src/lot_engine/` → run `cargo test module_tree_hash_is_pinned` in A, take the number from the failure → set it in both `tests.rs` → re-run in **both** repos green. The hash is FNV-1a over an *explicit* `include_str!` list (`tests.rs:245-257`) — **a new `.rs` file would not be hashed at all**, which is why the roster goes into the existing `export.rs`/`model.rs` rather than a new file.

Headers deviate from the attachment in one character: no trailing space on `"Unit count"`. If he wants byte-fidelity to his file, that is a one-string change, but `Section::col("Unit count")` then stops finding it.

### 2b. REPO B (server) — `clienthub-api`

| File | Symbol | Change |
|---|---|---|
| `src/sync.rs` | ALTER array in `ensure_meta_tables` (after `:609`) | the three ALTERs above. **This is the deploy-critical one.** |
| `src/schema.sql` | `CREATE TABLE lot_build` (`:823-850`), index block (`:851`) | three columns for fresh DBs + `idx_lot_build_parent` (this one *does* apply live) |
| `src/routes/lot_engine.rs` | `LOT_COLS` (`:273-275`) | **append** `, b.parent_id, b.kind, b.sold_at` → new indices **18, 19, 20** [verified: currently 0..17] |
| " | `lot_row` (`:277`) | read them with `unwrap_or` exactly as `cost_pct` does at `:288`; add `"parent_id"`, `"kind"`, `"sold_at"` to the emitted JSON |
| " | `save_lot` (`:1086`) | leave the INSERT/ON CONFLICT alone; **fix the emit map at `:1163-1183`** — replace `c.insert("status", json!("saved"))` with the status read back from the row, and add the two missing `cost_pct`/`cost_pct_json` entries [verified absent — a real live bug] |
| " | **new** `create_branch` | `POST /api/lot-engine/branches` `{sheet_id, name}` |
| " | **new** `combine_lots` | `POST /api/lot-engine/combined` `{branch_id, name, child_ids[], price_pct, price_overrides, cost_pct, cost_overrides}` |
| " | **new** `uncombine_lot` | `POST /api/lot-engine/lots/:id/uncombine` |
| " | **new** `set_sold` | `POST /api/lot-engine/lots/:id/sold` `{value: bool}` |
| " | **new** `reprice_lot` | `POST /api/lot-engine/lots/:id/reprice` — closes an existing parity gap (the server has **no** reprice route today; desktop has `reprice_lot_build`) |
| " | **new** `export_roster` | `GET /api/lot-engine/roster/export?sheet_id=&node_id=&format=csv|xlsx` |
| " | `router()` (`:50-82`) | register the six routes. **No `main.rs` change is needed** — `lot_engine::router()` is merged inside `routes::router()`, which is what `main.rs:107-109` wraps. This matters: `main.rs` is never scp'd, it is hand-patched on the droplet (`main.rs:360-362`). |
| " | `list_lots` (`:1038`) | must return the new columns (via `LOT_COLS`); optionally honour `include_archived` (today hardcoded `archived=0` at `:1046`/`:1050`) |
| " | `remove_from_master` (`:1319`), `archive_lot` (`:1268`) | add a guard: refuse when `kind != 'lot'` unless the caller means the parent-level action; **do not** extend their `let _ = conn.execute(...)` pattern into new code |
| `src/auth.rs` | the arm at `:376` | see risk R9 — the whole `/api/lot-engine` prefix resolves to flat `inventory:view`, so the new **write** routes inherit read-level permission |
| `www/app.js` | `leLots()` (`:11129-11225`) | tree render; top level filters `!b.parent_id`; children nested; three-state status pill; new buttons |
| " | breakdown wiring (`:11169`) | **must change**: `el.closest('.le-acts').nextElementSibling` breaks the moment a child card is nested. Address the box as `el.closest('.le-card').querySelector('[data-lebdbox]')` |
| " | `leExport` (`:11030`), label map (`:11031`) | add a `roster` arm — an unknown kind currently falls through to the "Manifest" label |
| " | `leFileName` (`:11070`) | fallback hardcodes `.csv`; take the format |
| " | remove confirm (`:11200`) | quotes `data-lecount` = the row's **own** locations; for a cascade it must name the descendants |
| " | pool stats (`:10238-10245`) | the sentence *"no two lots can ever contain the same shoes"* stays true only while invariant I2 holds |
| `www/style.css` | after `.le-card` (`:2536`) | add `.le-card.is-sub` indent + guide glyph, copying `.cat-node.is-sub` / `.cat-guide` (`app.js:9106`) |
| `www/index.html` | `:169`, `:48` | bump `app.js?v=124` → **125** and `style.css?v=29` → **30** [verified current values]. The sw cache name derives from the app.js number. |

### 2c. REPO A (desktop) — `BUSINESS APP`

| File | Symbol | Change |
|---|---|---|
| `src-tauri/src/db.rs` | `MIGRATIONS` | migration **86** (above) |
| `src-tauri/src/lot_store.rs` | `struct LotBuild` (`:904`) | add `parent_id: Option<String>`, `kind: String`, `sold_at: Option<String>` |
| " | `BUILD_SELECT` (`:960`) | **append** `, b.parent_id, b.kind, b.sold_at` → new indices **19, 20, 21** [verified: currently 0..18, with `s.name` at 16 and cost at 17/18] |
| " | `row_to_build` (`:931`) | read 19/20/21 with `unwrap_or`, matching the comment at `:953` |
| " | `build_stacks` (`:1142`) | **make tree-aware**: if `build.slots` is non-empty, as today; otherwise resolve the union of descendant `kind='lot'` slots (recursive CTE, same `sheet_id`) and filter. This single change makes `lot_build_detail`, `export_lot_build`, `lot_build_location_codes` and `reprice_lot_build` all work on a parent. |
| " | `save_lot_build` (`:999`) | two surgical edits only: (a) reject a `build_id` whose stored `kind != 'lot'`; (b) emit the row's **actual** status instead of the literal `"saved"` at `:1081` (see R5) |
| " | `remove_lot_from_master_list` (`:1252`), `archive_lot_build` (`:1181`) | guard `kind='lot'` for the slot half; a parent's archive must clear its children's `parent_id` rather than touching slots |
| " | **new** `create_lot_branch(sheet_id, name)` | INSERT `kind='branch'`, `parent_id=NULL`, `slots_json='[]'`, zero totals, `status='saved'` |
| " | **new** `combine_lot_builds(branch_id, name, child_ids, price_pct, price_overrides, cost_pct, cost_overrides)` | validate (same sheet, all `kind='lot'`, none archived/sold/sent, none already parented elsewhere, no cycle); INSERT the `combined` row with `slots_json='[]'`; `UPDATE lot_build SET parent_id=? WHERE id IN (...)`; recompute totals from the union of children's stacks with the combined lot's own `Pricing`; emit parent + each child |
| " | **new** `uncombine_lot_build(combined_id)` | clear children's `parent_id`, archive the combined row, emit all |
| " | **new** `set_lot_build_sold(build_id, sold) -> usize` | the cascade — see §4/I6 |
| " | **new** `export_lot_roster(sheet_id, node_id: Option<String>, format, dest_path)` | query the roster rows, map to `LotLine`, `export::lot_roster`, then `export::to_csv` / `export::to_xlsx`, write to `dest_path` (same shape as `export_lot_build:1362-1380`) |
| " | `resync_lot_engine` (`:1478`), `resync_lot_sheet` (`:1685`) | **no change needed** — both go through `row_columns` (`SELECT *`), which picks the new columns up for free. Confirmed, and it is the recovery path for R1. |
| `src-tauri/src/main.rs` | the `invoke_handler` block (`:924-953`) | register the five new commands |
| `src/lib/api.ts` | `interface LotBuild` (`:3624`) | add `parent_id: string \| null; kind: string; sold_at: string \| null;` |
| " | Lot-engine section (`:3170+`) | add `createLotBranch`, `combineLotBuilds`, `uncombineLotBuild`, `setLotBuildSold`, `exportLotRoster` |
| `src/components/LotEngineView.tsx` | `SavedLotsTab` (`1644-2023`) | tree render; select mode + `Set<string>` selection copying `InventoryView.tsx:325-343` / `:553-575` / `:879-920`; "Combine selected" bulk action; branch/roster download buttons |
| " | `open` (`:1648`), `busy` (`:1646`) | both must become `Set<string>` — a single-string accordion collapses a parent when a child opens, and `busy === b.id` blanks unrelated rows during a cascade |
| " | `detail` cache (`:1655`, cleared only in `load()` at `:1659`) | must be invalidated after combine / uncombine / sold, or the breakdown shows stale units with no cue |
| " | `exportOne` (`:1688-1702`) | **critical**: the save-dialog rename strips only `-(manifest\|brands\|pull)$`. A roster saved as `Branch-roster.csv` would **rename the lot** to `Branch-roster`. Exclude the roster path from the rename entirely. |
| " | status pill (`:1869`, `:1872`) and buttons (`:1937`, `:1950`) | four `=== "sent" ? a : b` ternaries → explicit three-way (`saved` / `sent` / `sold`); note `'draft'` currently renders as "in a lot" by fallthrough |
| " | empty-state early return (`:1783-1789`) | returns **before** the tab chrome at `:1792`, so a "New branch" button would be invisible on a sheet with no lots (same bug that already hides `ManifestSettings`) |
| `src/__lot-harness.tsx` | fixtures at `:82`, `:152-158`, the `switch (cmd)` at `:104-194` | add the three fields and fixtures for the new commands — this is the cheapest way to render the tree UI before the Rust half exists |

---

## 3. ORDERING OF WORK

**The claim in the brief is correct, and it is stronger than stated.** [verified] For a *new table*, the server must have it in `ALLOWED_TABLES` + `PUSHABLE` + `SNAPSHOT_TABLES` before a desktop pushes, or the event is either retried forever or **filed under `rejected` and dequeued by the desktop — permanent, silent loss** (`B/src/sync.rs:1618-1620`, contract at `:1666-1670`). We are adding columns, not tables, so the binding rule is the column one: `apply_upsert` drops columns the server lacks, logs `SCHEMA DRIFT` at warn, and **still marks the event applied** — the desktop dequeues and the value is gone (`B/src/sync.rs:1243-1250`, restated at `:551`, `:563-568`, `:580-582`).

The reverse direction is safe: the desktop's `apply_upsert` also retains only locally-present columns and deliberately records no clocks for what it dropped (`A/src-tauri/src/sync.rs:746-751`), so a later re-pull fills them in after migration 86 runs.

```
0. Shared engine, BOTH repos in one session.
   model.rs LotLine + export.rs lot_roster + mod.rs re-export + tests.rs golden test.
   Copy directory A → B. Re-pin PINNED_TREE_HASH in both. `cargo test` green in BOTH.
   VERIFY: diff -r on lot_engine/ is empty; both test suites pass.

1. SERVER schema + routes, one build, one deploy.
   sync.rs ALTERs, schema.sql, LOT_COLS/lot_row, save_lot emit fix, the six handlers,
   router() registration.
   Build, scp the binary, restart.
   VERIFY ON THE DROPLET, before anything else moves:
     sqlite3 /home/ecliptr/clienthub-data/brokr.db "PRAGMA table_info(lot_build);"
     -> parent_id, kind, sold_at all present.
     curl the new routes; confirm {error} envelopes, not 404.
   NOTHING BELOW MAY BE INSTALLED ON ANY DEVICE UNTIL THIS LINE PASSES.

2. DESKTOP Rust.
   db.rs migration 86, lot_store.rs columns + tree-aware build_stacks + five commands
   + the two save_lot_build fixes, main.rs registration.
   VERIFY: cargo test; launch; create a branch, combine three lots, check
   `SELECT id,kind,parent_id,status FROM lot_build` and that no lot_slot_state row moved.

3. DESKTOP UI.
   api.ts types + bindings, LotEngineView.tsx tree/select/sold/roster, harness fixtures.
   VERIFY: render in __lot-harness.tsx first; then against real Rust. Check all five
   theme combos and the 216px-sidebar breakpoints.

4. MOBILE.
   www/app.js leLots tree + breakdown-box fix + leExport/leFileName + sold, style.css
   .le-card.is-sub, index.html v=125 / v=30.
   scp www/ to the droplet.
   VERIFY: hard-reload the PWA, confirm the sw picked up v125.

5. Ship: tag + release (desktop), deploy verified (server), PWA served.
   Then vault: architecture/lot-engine.md, decisions/ (the tree + sold-is-not-sent
   decision), requests R-218/R-219 rows, and bump verified dates.
```

Within a single deploy, phases 1's ALTERs run at boot (`sync::init` from `main.rs:83`) **before** the router serves, so schema and routes may ship in one binary. They may not ship in one binary *with* the desktop.

---

## 4. INVARIANTS THE CASCADE MUST HOLD

**I1 — The kind ladder is the cycle guard.** `lot`.parent ∈ {`combined`, NULL}; `combined`.parent must be a `branch`; `branch`.parent is always NULL. Enforced in `combine_lot_builds` / `combine_lots` before any write, plus an explicit ancestor walk.
*Breaks:* a `parent_id` cycle makes the recursive CTE never terminate. On the server that hangs a request **while holding the `db::conn()` guard**, which is the process-wide mutex — the whole API deadlocks (the known 12-site failure mode).

**I2 — Only `kind='lot'` rows own slots. `combined` and `branch` carry `slots_json='[]'` and never call `set_lot_slot_state`.**
*Breaks:* `lot_slot_state.lot_id` is a single scalar overwritten unconditionally (`A/lot_store.rs:858-862`, `B/routes/lot_engine.rs:1154-1157`), so a parent staging its children's slots **steals** them; afterwards archiving a child frees nothing (`WHERE lot_id=<child>` matches no row, `A/lot_store.rs:1223`, `B/:1282`) and archiving the parent frees every child's slots at once. Independently, `staged_slots`/`removed_slots` count rows, not lots (`A/lot_store.rs:372-374`, `B/:248-249`), so the desktop PoolBar (`LotEngineView.tsx:344-347`) and the mobile stat strip (`app.js:10238-10245`) would double-count and could exceed the sheet's total location count.

**I3 — A base lot has at most one parent, and joining or leaving a combined lot never touches its `lot_slot_state` rows.**
*Breaks:* the same stock is sold in two lots.

**I4 — Every descendant of a node shares its `sheet_id`; the parent's `sheet_id` is that sheet.**
*Breaks:* `lot_build.sheet_id` is `NOT NULL` in both repos; `lot_build_detail` fetches exactly one artifact (`A/lot_store.rs:1127`); `stacks_of` and `unavailable()` are per-sheet; the stack cache is per-sheet, unbounded and never evicted (`A/lot_store.rs:82-85`, ~97k stacks each); mobile fetches `?sheet_id=` only (`app.js:11132`). A cross-sheet parent renders as a partial tree with silently missing children.

**I5 — Sold is a status cascade and nothing else. It never writes `lot_slot_state`, never sets `'sent'`, never sets `'removed'`.**
*Breaks:* the vault rule (`architecture/lot-engine.md:100`, mirrored at `B/src/schema.sql:779-782` and `A/lot_store.rs:836-840`) — *"absent means shipped, not undone"*. A slot flipped to `removed` at sale time can never honestly come back, and un-archive would resurrect it into `staged` (`A/lot_store.rs:1233-1240` overwrites state unconditionally).

**I6 — The cascade is ONE SQL statement, and the affected id set is read before it.**
```sql
-- 1. read the set (for the emits)
WITH RECURSIVE tree(id) AS (
  SELECT ?1 UNION ALL SELECT b.id FROM lot_build b JOIN tree t ON b.parent_id = t.id
) SELECT id FROM tree;
-- 2. one UPDATE, atomic by itself
UPDATE lot_build SET status=?2, sold_at=?3, updated_at=?3
 WHERE id IN (WITH RECURSIVE tree(id) AS (
   SELECT ?1 UNION ALL SELECT b.id FROM lot_build b JOIN tree t ON b.parent_id = t.id
 ) SELECT id FROM tree);
-- 3. only then, emit() per id
```
*Breaks:* **there is not a single SQLite transaction anywhere in the desktop Rust tree, and none in `B/src/routes/lot_engine.rs`** [verified by the lens's exhaustive greps]. Desktop takes a *fresh pooled connection per block* (`archive_lot_build` takes four in one call). A cascade written as a loop of UPDATEs half-applies, leaves no record, and has no repair path. The single-statement form is the only atomicity available without introducing transactions to a codebase that has none.

**I7 — A parent's stored `locations/units/styles/msrp_total/ask_total` are recomputed from the union of its descendant leaves on every membership change** (combine, uncombine, a child archived out).
*Breaks:* the roster's Unit count / Retail Value / Sale Price disagree with the same lot's own manifest, and there is **no `reconcile` for a roster** — `reconcile` is hard-typed to the three stack docs (`export.rs:420`) and returns `Ok(())` trivially on an empty lot (0==0==0==0), so it cannot catch this.

**I8 — One roster predicate, spelled identically in both repos.**
Root: `WHERE sheet_id=? AND kind='lot' AND archived=0 AND status='saved' ORDER BY name`.
Node: `WHERE parent_id=? AND archived=0 AND status='saved' ORDER BY name`.
*Breaks:* the two surfaces hand out different spreadsheets for the same branch.

**I9 — Every new column appears in every hand-written emit map that writes it.**
*Breaks:* proven live — the server's `save_lot` writes `cost_pct`/`cost_pct_json` to its own row but omits both from the emit map at `B/routes/lot_engine.rs:1163-1183` [verified this session], so a cost entered on the phone has never reached the desktop except via resync.

**I10 — New columns are APPENDED to `BUILD_SELECT` (desktop, next index 19) and `LOT_COLS` (server, next index 18), read with `unwrap_or`.**
*Breaks:* both row mappers are positional `r.get(N)`; an inserted column makes a lot's name be read out of the status column.

**I11 — Only `status='saved'` may be marked sold; only `status='sold'` may be un-sold; un-selling restores `'saved'`, never `'sent'`.**
*Breaks:* a shipped lot silently becomes for-sale again, or a sold lot is un-sold into a state that says it left the building.

---

## 5. OPEN DECISIONS — HIS, NOT OURS

1. **Does "sold" also take the stock off the master list, or is shipping still a separate press?** Recommend separate (a lot can be sold before it ships; `removed` is irreversible in meaning). Materially: it decides whether the cascade writes zero `lot_slot_state` rows (I6's one atomic statement) or ~3,000 in an untransacted loop.
2. **Must every combined lot live inside a named branch, or can a combined lot sit at the top level beside the base lots?** Materially: decides whether `kind='branch'` exists at all, i.e. a two-level or three-level tree, and whether a combined lot's spreadsheet has a home and a name.
3. **May a branch combine lots from two different warehouse sheets?** Recommend no. Materially: decides `sheet_id` nullability, whether the artifact fetch and the per-sheet stack cache must loop N sheets (N × ~97k stacks resident, never evicted), and whether mobile's `?sheet_id=` list can see the tree at all.
4. **A combined lot's Sale Price: its own quoted percentage of the union's retail, or the sum of its children's ask?** Recommend its own percentage (that is what combining is *for*). Materially: decides whether repricing a parent is legal, and whether repricing a child must roll up into the parent and the branch spreadsheet.

---

## 6. RISKS, MOST SEVERE FIRST

**R1 — Desktop ships migration 86 before the droplet has the ALTERs.** Every `lot_build` event silently loses `parent_id`/`kind`/`sold_at`; the event is marked applied; the desktop dequeues. Permanent. *Mitigation:* the phase gate in §3 with the `PRAGMA table_info` check; recovery is `resync_lot_engine` (`SELECT *` re-emit), which works **only because we added columns and not a table** — the resync commands iterate a hard-coded three-table array.

**R2 — A `parent_id` cycle hangs the recursive CTE.** On the server that deadlocks the whole API (guard held across the hang). *Mitigation:* I1's kind ladder makes cycles structurally impossible; add an explicit ancestor walk in both combine writers and reject with 400.

**R3 — A parent that owns slot rows** — steals children's ownership, corrupts archive in both directions, double-counts the pool bar on three surfaces. *Mitigation:* I2, enforced by a hard check in the combine command (`slots_json` must be exactly `'[]'` for non-`lot` kinds) and by never calling `set_lot_slot_state` from any new command.

**R4 — Migration number collision.** `lot-engine-mapping` (pushed, unmerged, matched with an undeployed server half) already defines **85** [verified]. Taking 85 on main breaks the branch; taking 86 means the branch's 85 is skipped forever on any device that installed 86 first (`run_migrations` runs only `version > current`). *Mitigation:* take 86 **and** renumber the branch's 85 → 87 before it merges — or land that branch first and take 87 here. Decide before writing line one.

**R5 — Re-saving a sold lot un-sells it on every peer.** `save_lot_build`'s `ON CONFLICT` list omits `status` while its emit map sends `status:"saved"` unconditionally (`A/lot_store.rs:1043-1051` vs `:1081`; server `B/:1128-1136` vs `:1167`). **Conflict between lenses, resolved [verified]:** the desktop-storage lens said "the frontend does pass buildId on edit" — it does not. `api.ts:3238` passes `buildId: p.buildId ?? null`, and neither call site (`LotEngineView.tsx:505`, `:2484`) nor mobile (`app.js:10465`, `:10826`) supplies one. The bug is **latent today and becomes live the moment `sold` exists**. *Mitigation:* read the row's real status back after the upsert and emit that, in both repos; and keep the new UI from ever passing `buildId`.

**R6 — The roster download silently renames the lot.** `exportOne` strips only `-(manifest|brands|pull)$` from the typed filename and renames the build to whatever is left (`LotEngineView.tsx:1688-1702`), and the lot's name is what every other export filename is built from. *Mitigation:* exclude the roster path from the rename side-effect entirely.

**R7 — A cascade that reports success for a no-op.** `remove_from_master` discards every write with `let _ = conn.execute(...)` and returns `200 {"ok":true}` unconditionally (`B/:1341-1352`); same pattern in `save_lot`'s staging loop and `archive_lot`'s release. *Mitigation:* new handlers bind the `Result` and answer 500 through `err()`; do not copy the surrounding style.

**R8 — Mobile breakdown lands in the wrong element.** `el.closest('.le-acts').nextElementSibling` (`app.js:11169`) is exactly where a nested child tree would go. *Mitigation:* `[data-lebdbox]` lookup scoped to `.le-card`.

**R9 — New write routes are gated at read level.** The whole `/api/lot-engine` prefix maps to flat `inventory:view` (`B/src/auth.rs:376`), deliberately, because rank and preview are reads that happen to be POSTs. A combine, an uncombine and a sold-cascade would inherit it. *Mitigation:* add an explicit arm for the four write paths, or accept it knowingly and record the decision.

**R10 — Shared-module lockstep.** Editing `lot_engine/` in one repo turns the other repo's build red until the directory is copied and both `PINNED_TREE_HASH` constants match. *Mitigation:* the phase-0 procedure — copy, re-pin both, `cargo test` green in both, before either commit.

**R11 — Stale figures on screen.** The `detail` cache (`LotEngineView.tsx:1655`) is cleared only by `load()`; the Rust stack cache (`lot_store.rs:82`) is dropped only by `set_lot_retail` (`:182`) and never when a peer's price correction arrives over sync. *Mitigation:* call `load()` after every combine/uncombine/sold; do not add new cache entry points.

**R12 — `'sold'` renders as "in a lot".** Six sites are two-branch ternaries on `=== 'sent'` (`LotEngineView.tsx:1869/1872/1937/1950`, `app.js:11149/11160`); `'draft'` already falls through them silently. *Mitigation:* convert all six to explicit three-way switches with a visible default.

**R13 — Chrome hidden on an empty sheet.** `SavedLotsTab` returns before its own chrome when `rows.length === 0` (`LotEngineView.tsx:1783-1789`) — a "New branch" button would be invisible exactly when it is first needed.

**R14 — An xlsx roster saved as `.csv`.** `leFileName`'s fallback hardcodes the extension (`app.js:11070-11073`).

**R15 — Filename collisions.** Desktop default export paths are `sheet_dir/lots/{safe}-{kind}.{ext}` with every non-alphanumeric mapped to `-` (`lot_store.rs:1354-1369`); a branch and a lot with similar names overwrite each other's spreadsheet without warning. Rosters at several tree levels will hit this. *Mitigation:* always go through the save dialog for rosters; never use the default path.

**R16 — The header trailing space.** Emitting `"Unit count "` verbatim would be faithful to his attachment but makes `Section::col("Unit count")` return `None` (no trim, `export.rs:47-50`). We emit it without the space; say so when handing him the first file.

---

## Blocker-class traps, verbatim from the survey

**B1 — "Mark sold" on a lot that owns no slots is a silent no-op that returns success. remove_lot_from_master_list passes build.slots to set_lot_slot_state, which iterates `for loc in &locations` — zero iterations, n=0, no slot rows touched, no events emitted, no error. It then flips status to 'sent' and returns 0. Any bundle parent marked sold leaves every child staged and sellable.**

> lot_store.rs:1262-1273 `let n = set_lot_slot_state(build.sheet_id.clone(), build.slots.clone(), state.into(), Some(build_id.clone()), ...).await?;` and lot_store.rs:854 `for loc in &locations {` ... lot_store.rs:1275 `let status = if removed { "sent" } else { "saved" };`

**B2 — save_lot_build's ON CONFLICT update list is narrower than its emit, so editing an existing lot diverges four columns between this device and every peer. Locally status/archived/created_at/sheet_id are untouched; the emit sends status='saved', archived=0, created_at=now unconditionally. Re-saving a lot that was already marked 'sent' leaves it 'sent' here and flips it back to 'saved' everywhere else — a shipped lot reappears as for-sale on the phone and the server. Same mechanism un-archives an archived lot on peers and bumps created_at on every edit.**

> lot_store.rs:1044-1050 `ON CONFLICT(id) DO UPDATE SET name=excluded.name, ... slots_json=excluded.slots_json, notes=excluded.notes, updated_at=excluded.updated_at, cost_pct=excluded.cost_pct, cost_pct_json=excluded.cost_pct_json` (no status, no archived, no created_at, no sheet_id) versus lot_store.rs:1081/1094/1095 `("status", serde_json::json!("saved")), ... ("archived", serde_json::json!(0)), ("created_at", serde_json::json!(now)),`. The frontend does pass buildId on edit: src/lib/api.ts:3238 `buildId: p.buildId ?? null`.

**B3 — Slot ownership is a single scalar lot_id overwritten without any check on the previous owner, so a parent staging its children's slots silently steals them from the children — after which archiving a child frees nothing and archiving the parent frees every child's slots at once. The model cannot express a slot owned by a child that is inside a parent.**

> lot_store.rs:858-862 `ON CONFLICT(id) DO UPDATE SET state=excluded.state, lot_id=excluded.lot_id, note=COALESCE(excluded.note, lot_slot_state.note), updated_at=excluded.updated_at` against db.rs:1801 `lot_id TEXT,` (scalar, nullable), and the free clause at lot_store.rs:1223-1225 `UPDATE lot_slot_state SET state = 'available', lot_id = NULL, updated_at = ?2 WHERE lot_id = ?1 AND state = 'staged'`

**B4 — Membership has two sources of truth and un-archiving reads the wrong one. archive_lot_build frees by lot_id (the DB's view) but re-stages from slots_json (the row's view), with no guard on the current owner or state — so un-archiving steals slots another lot has since staged AND resurrects slots that were 'removed' (shipped) back into 'staged'.**

> lot_store.rs:1210-1213 `SELECT sheet_id, location_code FROM lot_slot_state WHERE lot_id = ?1 AND state = 'staged'` versus lot_store.rs:1233-1240 `set_lot_slot_state(build.sheet_id.clone(), build.slots.clone(), "staged".into(), Some(build_id), None)` where build.slots comes from slots_json at lot_store.rs:946-949

**B5 — A lot build has no "sold" state to cascade from. `LotBuild.status` is only ever "saved" or "sent", and the UI's only cascade-ish action is "Remove from master list". Any "mark the parent sold" work invents a new status that ~5 render sites and the sync oplog must all learn; the `Lot` type that DOES have "sold" (api.ts:1360) is the unrelated inventory table.**

> src/lib/api.ts:3629 `status: string;` in `LotBuild`; src-tauri/src/lot_store.rs:1081 `("status", serde_json::json!("saved"))` and lot_store.rs:1275 `let status = if removed { "sent" } else { "saved" };`; src/components/LotEngineView.tsx:1873-1876 `{b.status === "sent" ? "off the list" : "in a lot"}` — the pill has exactly two branches and an unknown third status falls into the "in a lot" default silently.

**B6 — Adding a column to the `CREATE TABLE IF NOT EXISTS lot_build (...)` block in schema.sql does NOTHING to the live droplet database. schema.sql contains zero DDL ALTER statements (the one `grep ALTER` hit is inside a comment), and CREATE TABLE IF NOT EXISTS is a no-op against an existing table — SQLite does not diff definitions. The ONLY server-side path that adds a column to an existing lot table is the ALTER array inside `ensure_meta_tables` in sync.rs. Ship a column via schema.sql alone and production silently never gets it.**

> src/schema.sql:846 — the sole 'ALTER' occurrence in the file is a comment: `-- NOT free. A database created before this gets the columns from the ALTER`. src/db.rs:57-66 applies it: `pub fn ensure_core_schema() { let conn = conn(); if let Err(e) = conn.execute_batch(include_str!("schema.sql")) { tracing::error!("ensure_core_schema failed: {}", e); } }`, called at src/main.rs:46. The real ALTER path is src/sync.rs:509-611 inside `fn ensure_meta_tables` (src/sync.rs:167), called from `sync::init` (src/sync.rs:145-152) at src/main.rs:83. Existing lot precedent: src/sync.rs:602-603 `"ALTER TABLE lot_build ADD COLUMN cost_pct REAL NOT NULL DEFAULT 0", "ALTER TABLE lot_build ADD COLUMN cost_pct_json TEXT",`

**B7 — Skipping the ALTER does not error — it silently drops the column out of every sync event forever. apply_upsert partitions incoming columns against PRAGMA table_info and discards the ones the server lacks, still marks the event applied, so the pushing desktop dequeues it. The value is gone with only a warn-level log line as evidence.**

> src/sync.rs:1243-1250: `tracing::warn!("apply_upsert: SCHEMA DRIFT — {} lacks column(s) {:?}; applied the rest of {}/{} and dropped them (add the ALTER to ensure_meta_tables)", table, dropped.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), table, row_id);` — preceded by the partition at the `let (winning, dropped): (Vec<_>, Vec<_>) = winning.into_iter().partition(|(c, _)| present.contains(c));` line, where `present` comes from `existing_columns` (PRAGMA table_info). The ordering requirement is restated at src/sync.rs:551, 563-568 and 580-582: the ALTER must be live on the droplet BEFORE a desktop ships the migration.

**B8 — The saved-lots list is a flat `rows.map` with no parent/child filter. The moment the server returns children in the same array, every child renders as its own top-level card AND the header count double-counts parent+children.**

> app.js:11132 `const rows = await leGet('/api/lot-engine/lots?sheet_id=' + encodeURIComponent(_le.sheetId));` then app.js:11139 `${fmtN(rows.length)} ${rows.length === 1 ? 'lot' : 'lots'} built from this sheet.` and app.js:11145 `} + rows.map(b => ` — the map runs over the whole array with no `b.parent_id` filter and no nesting.

**B9 — The pool stat bar and the reconciliation sentence add `staged_slots + removed_slots` as if every staged slot belongs to exactly one lot. A parent that stages the same slots its children stage would double-count them and can push the arithmetic past the sheet's total location count.**

> app.js:10238-10239 `<div class="le-stat-half"><span>${sh ? fmtN(sh.staged_slots) : '—'}</span>claimed by a lot</div>` / `...removed_slots...shipped — gone`, and app.js:10241-10245 `${sh && (sh.staged_slots + sh.removed_slots) > 0 ? ... + fmtN(sh.staged_slots + sh.removed_slots) + ' of this sheet\'s ' + fmtN(sh.locations) + ' locations are off the master list — ...'` — plus the closing claim `'so no two lots can ever contain the same shoes.'`, which a bundle makes literally false.

**B10 — There is not a single SQLite transaction in the entire desktop Rust tree, and none in the server's lot-engine routes. Every multi-row lot write is issued statement-by-statement, and on desktop each block takes a FRESH pooled connection. A cascade written in the existing style will half-apply with no record that it did.**

> Exhaustive greps this session over C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/ (recursive, --include=*.rs): `grep -rniE "\b(begin|commit|rollback|savepoint)\b"` → zero matches outside comments; `grep -rn "\.transaction\|Transaction::"` → zero matches. Same greps on C:/Users/Jack/Desktop/clienthub-api/src/routes/lot_engine.rs → zero. Contrast clienthub-api/src/sync.rs:1107 which DOES have it: `conn.execute("BEGIN", [])?;` … `conn.execute("COMMIT", [])?;`. Desktop pool, src-tauri/src/db.rs:13-18: `pub type DbPool = Pool<SqliteConnectionManager>; pub fn pool() -> &'static DbPool { POOL.get().expect("DB pool not initialized") }`. archive_lot_build (lot_store.rs:1181) calls pool().get() four separate times: :1183, :1187, :1208, :1219.

**B11 — `set_lot_slot_state` writes one `conn.execute` PER SLOT in a bare `for` loop with no transaction. A cascade over a parent's ~3,000 slots that fails partway leaves some slots `removed`, some `staged`, and the `lot_build.status` UPDATE (which runs AFTER the loop) never executed. Nothing detects or repairs this.**

> src-tauri/src/lot_store.rs:855-867: `let mut n = 0usize; for loc in &locations { let id = format!("{sheet_id}\u{1}{loc}"); conn.execute("INSERT INTO lot_slot_state (...) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(id) DO UPDATE SET state=excluded.state, ...", rusqlite::params![id, sheet_id, loc, state, lot_id, note, now]).map_err(|e| e.to_string())?; n += 1; }` — the `?` aborts mid-loop. Its caller lot_store.rs:1262 `let n = set_lot_slot_state(...).await?;` propagates, so the `UPDATE lot_build SET status = ?2` at lot_store.rs:1279 is never reached.

**B12 — The server's `remove_from_master` discards EVERY write error and still answers 200 OK. A cascade routed through it can silently do nothing and report success.**

> src/routes/lot_engine.rs:1341-1352: `let _ = conn.execute("INSERT INTO lot_slot_state (...) ON CONFLICT(id) DO UPDATE SET state=excluded.state, ...", ...);` inside the per-slot loop, and `let _ = conn.execute("UPDATE lot_build SET status=?2, updated_at=?3 WHERE id=?1", rusqlite::params![id, status, now]);` — both bind to `_`. The handler then unconditionally returns `(StatusCode::OK, Json(json!({"ok": true, "slots": slots.len()})))` at :1362.


## Where the rest live

All 81 traps (12 blocker, 24 high, 28 medium, 17 low) are in the run's journal at
`.claude/projects/.../subagents/workflows/wf_c268b6f2-3db/journal.jsonl`, one JSON line per
agent with its full report. The six lenses were: desktop Rust, desktop React, server,
mobile, the shared export machinery, and sold-semantics across both repos.
