---
plan: R-176 — catch-up programme, measured build list
date: 2026-08-19
baseline: HEAD = 5c28331 (v0.16.0, committed + pushed, UNTAGGED); server = deploy-43 live
method: 12 read-only audit agents re-measured every request the ledger called never-built, against code, not notes
---

# Catch-up plan (R-176)

Produced by measurement, not recall. **Section 1 is the most valuable part: it lists what NOT to build.**
Roughly a third of the never-built list is already shipped, and several vault rows and one memory note are wrong in ways that were actively misrouting agents.

Sidelined by Jack 2026-08-19: R-012 (WhatsApp), R-123 (storefront) — except its two settings-level fixes, which are noted below.
Out of scope: everything iOS / App Store (R-005, R-122 phases, R-133 whose trigger is the iOS push).

## 1. STALE ROWS

**R-152-c / R153-5 — interactions author column.** Ledger (00-REQUESTS.md:53, R-153 row, R-152 detail note:41) says "interactions (db.rs:285) has no author column." FALSE since migration 25: `ALTER TABLE interactions ADD COLUMN user_name TEXT` at db.rs:691, written by add_interaction (commands.rs:2077-2093), mirrored server-side (schema.sql:28). Only the READ path is missing (commands.rs:2035-2051 struct+SELECT, routes/interactions.rs:25) and the server's own writer omits it (routes/interactions.rs:70-73). Repeated in three vault places — correct all three.

**R-152-portal-half / R-156-W1-desktop — person picker + ledger counterparty filter.** Ledger 00-REQUESTS.md:49 and 00-INDEX.md:82 say payments "cannot" be tied to a client/supplier and there is no ledger filter. Both shipped v0.16.0: PersonPicker.tsx:24, FinancialsView.tsx:519/1668/3493 (personFilter), PersonPayments.tsx:206, tag/untag/counterparty_payments at commands.rs:14536/14572/14653/14792, registered main.rs:980-984, server person_candidates at bank_suggest.rs:445-570.

**R-154-a — pickup date / waiting lane / gate.** Ledger 00-REQUESTS.md:51 says status `captured`, "Nothing built"; the R-154 note:243 says mobile can't set dates and there's no server write route; MOBILE-PARITY-PLAN:29 says the same. All false. Migration 77 (db.rs:1616), set_deal_flow_shipping (commands.rs:4891, main.rs:704), shipping_gate + override (commands.rs:4865/4396/4471), desktop ShippingStrip (DealFlowView.tsx:1008) and waiting lane (:377), server route `PUT /api/deal-flows/:id/shipping` (deal_flows.rs:73, handler :1479), mobile editor (www/app.js:6777), mobile lane (:6279), mobile gate (:7906). Tagged v0.16.0 + deploy-43.

**R-157-W2-desktop — wire detection / method facet.** Ledger 00-REQUESTS.md:48 status `captured`. Shipped: methodFilter (FinancialsView.tsx:516), readMethod three-state (:366), unclassified count (:3561-3580), set_bank_txn_review + BANK_METHODS (commands.rs:11241/11216), wireDetail (:381-400), migration 78 confirmed_method (db.rs:1651), server mirror (sync.rs:568, schema.sql:652).

**R-175 phase 2 "missing migration 80 → runtime failure."** 00-REQUESTS.md:31 and the v0.16.0 commit message both claim anything reading `bank_allocation.supplier_id` fails at runtime. FALSE — no such reader exists. Every column reference added in 5c28331 was enumerated and all exist; repo-wide grep for `a.supplier_id`/`bank_allocation.*supplier_id` returns nothing; the supplier leg reads `deal_flows.supplier_payments_json` (commands.rs:14653). This sentence will otherwise drive a panic hotfix.

**CVA-2 — "Revenue Highest" sort dead.** Audit finding #2 (both branches broken). Desktop half FIXED in v0.16.0: `AS total_revenue` alias (commands.rs:1658), sort_by added to hasFilter/hasAnyFilter (ClientsView.tsx:82/169), ORDER BY prepares (:1768). Server/mobile still cannot request it.

**CVA-4 — status filter silently ignored.** FIXED: lead_status now in hasFilter and applied at commands.rs:1744-1750. New symptom to record: it now returns an empty list because no live row holds the filtered string (CVA-3).

**CVA-7 — revenue column meaning differs when filtered.** FIXED: filtered select now `MAX(0, ...paid... - refunded) AS total_revenue` (commands.rs:1658), identical to unfiltered (:171) and server CLIENT_BASE (clients.rs:42).

**CVA-6 / CVA-10 — no loading/error state.** Half fixed: loadError + try/catch + retry row shipped (ClientsView.tsx:64/83-89/110/810-820). Still missing: no `loading` flag (clients starts `[]` at :40 so "No clients yet" flashes on every mount for 141 clients), empty state still keyed on `clients.length` not `displayed.length` (:821), `listCategories()` at :105 has no catch.

**R153-6 — rep field falls back to company.** Ledger says "Nothing built." FIXED in 353eb86 / v0.16.0: ClientDetailView.tsx:252-253 `repDisplay = rep || "Unassigned"`, comment cites R-153 finding 6 by name; mobile already matches (www/app.js:4852).

**R-010 — reopen a completed deal from mobile.** 00-REQUESTS.md:76 says `captured`, "Completed drawer is read-only." Shipped at deploy-31 (afe8fbd): Reopen button www/app.js:6715, handler :6738-6744 → POST /api/deal-flows/:id/uncomplete (deal_flows.rs:55/1231), drawer renders full cards (:6435-6442).

**R-009 — "record a payment impossible on the phone."** 00-REQUESTS.md:75 stale in part: mobile has marked invoices paid since the original web rewrite (www/app.js:5963-6001 → invoices.rs:31), records refunds (:7345), toggles supplier paid/kept (:7437-7460), and since v0.16.0 allocates existing bank txns (:3071/:7147). Only hand-entered cash (manual_cash) is genuinely missing, and it has no server route at all.

**R-006 — "server endpoint exists and is never called."** 00-REQUESTS.md:72 half wrong: desktop calls it on every photo import and backfill (netsync.rs:1764-1789 driven by commands.rs:7862/7893). Accurate statement: MOBILE never calls it. Endpoint is inventory.rs:34/46-92.

**R-014 INV-1 / INV-2 — sold lots on the live store.** 00-START-HERE.md:64 still lists this as "Live P1, unfixed." Fixed in v0.15.128 and verified in production 2026-08-19: catalog is `status='available'` (storefront.rs:227), and the 22 live lot ids are exactly the 22 local available ids; zero of the 9 sold lots appear. INV-2's "8 lots need a backfill" is obsolete — 1 is now sold, and the other 7 were each written AFTER the fix (Renew = `updateLot(id, {})`, InventoryView.tsx:267-270, which bumps updated_at and leaves status alone).

**R-131-C2 — overdue card in three variants.** The memory note (modified yesterday) says desktop/server understate $164,018 and mobile shows $354,128 of voided paper. FULLY FIXED and DEPLOYED on all three: commands.rs:10496-10506 (status IN ('sent','overdue') + voided/archived guards + Central anchor), dashboard.rs:695-705, www/app.js:138-145 `isInvoicePastDue` used at :4350/:5329. Droplet verified live (binary rebuilt Aug 20 01:12, app.js?v=110). Strike both dollar figures.

**R-131-C2b — mark_overdue_invoices lacks voided guard.** Guard now present on both: commands.rs:2787, invoices.rs:639. Residual: both still bind UTC `date('now')`.

**R-131-4 — month history labelled a month early.** Fixed in 26da183 (desktop) + e49832f (server/mobile).

**R-134a — no CI, no linter, no formatter, tag-only builds.** R-134 note (verified 2026-08-10) and 00-REQUESTS.md:63 both false at HEAD. check.yml on both repos (typecheck/lint/cargo check/cargo test), eslint.config.js (flat, ratcheted), rustfmt.toml (deliberately unwired), shipped in 7f62bf9 → v0.15.144, v0.16.0. Rust tests 6 → 69 desktop, 63 server. Also: the three version sources are now aligned at 0.16.0 (d0cb64a).

**R-134c — one 3.5 MB chunk, no React.lazy.** Half fixed: App.tsx:83-85 lazies Globe/Analytics/Settings; entry chunk 3,573,711 → 1,524,345 bytes. recharts still static via DashboardView (App.tsx:45).

**R-019-A — running-balance reconciliation "would have to be built."** Shipped 602fc49 (2026-08-05, tag v0.15.129), one day after the R-019 row was written: reconcile_accounts (commands.rs:17319), ReconAccount (:17286), UI FreeCashView.tsx:125/232-264.

**R-019-C — no silent skips.** Partly shipped: sync_dead_letters (18 live rows) + StrandedWrite (commands.rs:17390), settle/retraction warnings surfaced from all four sync entry points (FinancialsView.tsx:870-895/918/957/1035/1065 — the R-141 background-timer gap is closed), bank_txn_deleted_backup (16 rows). Still silent: the duplicate `continue` (commands.rs:13557), empty-tid drop (:13417), failed-oplog `continue` (:13575), 60-page cap (:13400).

**R-011-A / R-011-C — wiped supplier details, reset lots, blanked lead_status.** Cause fixed (suppliers.rs:162-209 COALESCE merge + re-read-then-sync). Damage largely absent: 19 of 21 supplier rows were never updated after creation, so no UPDATE can have blanked them; the 2026-08-04 backup diff shows zero changed rows. Inventory: 0 of 73 rows match "per_unit + $0". Clients: 0 of 141 blank lead_status. R-011-C is obsolete outright.

**R-011-D — company_info missing phone/tax_id/logo.** phone = '8155932031' and logo_path are both present today; only tax_id is empty, and "never entered" is indistinguishable from "overwritten."

**revisit/server-refund-list-is-table-only.md** — false end to end: server list has the UNION arm with bank_txn_id and origin, deal-scoped org filtering (staff_api.rs:831-887), desktop stamps org (commands.rs:4976), mobile has the refund_done filter (www/app.js:6210-6215).

**revisit/00-BACKLOG.md item 7d** — `save_invoice_shipping` NULLing omitted columns is fixed (invoices.rs:590 COALESCE).

**Line-number drift, everywhere.** Every file:line in the R-132 ledger row is wrong (SECTIONS :481→:636, SectionMoney :1105→:1409, mark_invoice_paid :3104→:3138, write_sp :3704→:3827, deal_bank_actuals :4390→:4555, resync_completed_deal :4497→:4654). Same for the dormant-canonical-txn-id note (~1,120 lines: 11461→12582), the R-155 note (db.rs:605→611), the R-163 note (mobile refs off by ~1,100), and the R-153 note frontmatter (3-9 lines). commands.rs is 18,605 lines, not ~15,700.

---

## 2. THE REAL BUILD LIST

### WAVE 0 — Vault correction (no code, blocks nothing, unblocks everything)
Rewrite the stale rows above before anyone plans from them. Highest priority: 00-START-HERE.md:64 (routes every incoming agent to a fixed bug), 00-REQUESTS.md:31 (fake runtime-failure warning), :48, :49, :51, :53, :76, :81, :63, 00-INDEX.md:82, and the R-131 memory note's two dollar figures. Also file the newly-discovered "empty list is correct behaviour, not a v0.16.0 regression" note for CVA-4.

### WAVE 1 — Live bugs and unblocked one-liners (no dependencies, no schema)

| id | surfaces | size | files | depends on |
|---|---|---|---|---|
| **R-171-picker** — PersonPicker cannot create a party, so Jack's "two-tap re-file" of the four $90k wires is unreachable | desktop | S | `src/components/PersonPicker.tsx:40-49` | Jack's answer (D-9) |
| **R-163-6** — three profit queries subtract refunds uncapped and by a third counting rule | desktop, server | M | `src-tauri/src/commands.rs:9392, :9546, :9553, :9625, :5482, :5499` (extract capped fragment from :6071-6079 next to CLIENT_REFUNDED_SQL :1864); `clienthub-api/src/staff_api.rs:1048` | none (tell Jack the numbers will move) |
| **R-132-b** — desktop stage predicate ignores `kept`; server's is paid-or-kept | desktop | S | `src-tauri/src/commands.rs:4346, :4381-4389`; `src/components/DealFlowView.tsx:1441` | none |
| **R-132-c** — kept toggle on a completed deal doesn't move recorded cost (`resync_completed_deal` passes `total_cost`, not `total_supplier_cost`) | desktop | S | `src-tauri/src/commands.rs:4664` (verify against :3871) | Jack on backfill |
| **R-131-3** — loss card uses raw pre-refund net_profit | desktop, server, mobile | M | `src-tauri/src/commands.rs:10416`; `clienthub-api/src/routes/dashboard.rs:597-604, :289`; `www/app.js:8128` | Jack confirms rule applies to loss count |
| **R-131-C2c** — client-health `has_overdue` still on the pre-fix predicate | server | S | `clienthub-api/src/routes/dashboard.rs:342-345`; `routes/clients.rs:783-791` | none |
| **R-131-C2d** — AR aging days_overdue computed off UTC | desktop, server, mobile | S | `commands.rs:9771`; `staff_api.rs:1327`; `www/app.js:2329-2332` | none |
| **R-131-C2b residual** — overdue sweeps bind UTC `date('now')` | desktop, server | S | `commands.rs:2787`; `invoices.rs:639` | none |
| **CVA-5** — select-all hits hidden rows; bulk Delete is a silent hard delete swallowing FK rejections | desktop | S | `src/components/ClientsView.tsx:241-246, :249-262, :715, :325-333`; `commands.rs:1134-1147` | none (NEVER-ERASE: verified backup first) |
| **CVA-6/10 remainder** — loading flag, empty state keyed on `displayed`, catch on listCategories | desktop | S | `ClientsView.tsx:40, :105, :821` | none |
| **CVA-9/13** — two disagreeing client counts; full refetch per keystroke | desktop | S | `ClientsView.tsx:96-103, :125-127, :319` | none |
| **CVA-11** — pending banner + Unsubscribed row computed off the filtered array | desktop | S | `ClientsView.tsx:339, :436`; `src/lib/api.ts` MissingInfoReport + its Rust producer | none |
| **CVA-14** — dead `healthScores`, phantom `D` tier | desktop | S | `ClientsView.tsx:53, :172` | none |
| **R153-7** — `email_in` missing from the interaction filter chips (one word) | desktop | S | `ClientDetailView.tsx:623` | none |
| **R-014-INV-4** — mobile sells a lot under a red "Reject" button labelled `listing_stale` | mobile | S | `www/app.js:3996, :4004-4007, :4044-4047, :4361` | none |
| **R-014-INV-2B** — a sold lot's direct product link renders as fully for sale, with a working offer form | server | S | `clienthub-api/src/routes/storefront.rs:63-66, :92-163`; `www/shop.html:735-826, :930-946` | Jack on copy |
| **R-010-stage** — desktop reopen sets stage `invoiced`, server sets `supplier_paid` | desktop, server | S | `commands.rs:4745/4752/4755`; `deal_flows.rs:1241/1252/1258` | Jack picks one |
| **R-134d** — `/api/health` returns only `{ok:true}`; no way to prove what's on the droplet | server | S | `clienthub-api/src/main.rs:355-357` + build.rs (hand-patch main.rs on the droplet, never scp it) | none |
| **R-134f** — 3 untracked root plans, 5 stale agent branches | desktop | S | repo root | Jack on prune-vs-keep |

### WAVE 2 — Server-first schema and endpoint foundations
Everything here must be deployed before its desktop half exists, or `apply_upsert` logs SCHEMA DRIFT and silently drops the column from every event.

| id | surfaces | size | files | depends on |
|---|---|---|---|---|
| **MIG-80-CLAIM** — four separate items all want migration 80 (R-175 phase 2, R-155-a party link, R-152-a deal facts, R-163-2 shortage columns). Highest at HEAD is 79 (db.rs:1655). Assign numbers before anyone writes one. | data | S | `src-tauri/src/db.rs:1655` | Jack's ordering |
| **R-156-server** — no per-person payments read endpoint, no person/method filter on the ledger | server | M | `clienthub-api/src/routes/bank.rs:55-73, :120, :404-410` + new `GET /api/bank/counterparty/:ctype/:id` porting `counterparty_payments_sql` (commands.rs:14653) verbatim | none |
| **R-132-a** — server `mark_invoice_paid` never advances deal_flows | server | S | `clienthub-api/src/routes/invoices.rs:465-493` (reuse the helper at deal_flows.rs:625-660) | none; must land BEFORE R-132's fold |
| **R-152-c server write** — server add_interaction omits user_name, so mobile-authored history is anonymous forever (no backfill can recover it) | server | S | `clienthub-api/src/routes/interactions.rs:57-73` (use `session_actor`), `:25` SELECT, `models.rs:97` | none |
| **R-163-2** — `shortage_units` + `supplier_refund_owed` columns | server, desktop, data | M | `clienthub-api/src/sync.rs:529-556` ALTER backfill + `schema.sql` + `models.rs:241` + `routes/deal_flows.rs:175`, THEN `src-tauri/src/db.rs` migration + `commands.rs:3755-3766` | MIG-80-CLAIM |
| **R-009 server** — no route creates a bank_txn; `manual_cash` has zero server hits | server | M | new POST in `clienthub-api/src/routes/bank_write.rs`, porting guards from `commands.rs:11875-11890` + role→direction from `:11920-11930`; register in `routes/mod.rs` | Jack's reading A-vs-B |
| **R-155-a** — the party link (or party entity). Foundation for R-155-b, R-155-c, R-152-d, R-152-e. | server, desktop, mobile, data | L | `clienthub-api/src/schema.sql:217` + `sync.rs:167`, THEN `db.rs` migration + link/unlink commands next to `commands.rs:14536` + reader structs in `commands.rs` and `models.rs` | Jack D-6/D-7; MIG-80-CLAIM |
| **R-163-7** — server refund write cannot link a bank txn | server, mobile | M | `clienthub-api/src/staff_api.rs:737-746, :781-786` (mirror commands.rs:4961-4964) | none |
| **R-011-E step 1** — read-only `sync_events` archaeology script (the log is append-only and has NEVER been pruned — this is the only recovery source, and D-7 is currently being decided blind) | server, data | L | scratchpad script over droplet `/home/ecliptr/clienthub-data/brokr.db` — copy WITH `-wal`/`-shm` | Jack authorises the read |

### WAVE 3 — Desktop halves of Wave 2, plus unblocked desktop work

| id | surfaces | size | files | depends on |
|---|---|---|---|---|
| **R-152-c read path** — cheapest high-value item in its cluster, 80% done | desktop, mobile | S | `commands.rs:2035, :2050`; `src/lib/api.ts:343`; `ClientDetailView.tsx:603/633-645`; `www/app.js:4894-4900` | Wave 2 server write |
| **R-152-a** — the deal facts, above all "who books the freight". REAL COLUMNS, not the metadata blob (migration 77's comment at db.rs:1596 records why) | desktop, server, mobile, data | L | `db.rs` migration; `clienthub-api/schema.sql` + `sync.rs:167`; `commands.rs:2125/2146`; `models.rs:248-260`; `routes/deal_flows.rs:181`; `src/lib/api.ts:828`; `DealFlowView.tsx:970`; `www/app.js` | Jack Q on WHICH facts; MIG-80-CLAIM. Follow the R-154 pickup_date pattern end to end |
| **R-163-1** — the units→dollars shortage calculator (the core ask). All input data already exists on both sides. | desktop, server, mobile | L | `RefundWorkspace.tsx:291-307`; new `set_deal_shortage` beside `commands.rs:5048`; `staff_api.rs:896`; `www/app.js:7328` | R-163-2, R-163-6, Jack's link-driven-vs-immediate answer |
| **R-163-3** — the supplier recovery side, and the `source='supplier'` dropdown that silently books supplier money as buyer money | desktop, server, mobile | M | `RefundWorkspace.tsx:361-364` + `www/app.js:7335`; `commands.rs:5347-5378`; `staff_api.rs:382-465` | Jack: delete the option or exclude it from every buyer SUM |
| **R-132** — fold Money movement into Link + Supplier (not delete: `bank_allocation` has no supplier_payment_id, so per-line paid is underivable) | desktop, mobile | M | `DealFlowView.tsx:636-642, :678, :684-689, :924, :1409-1590`; `www/app.js:6089-6095, :6899-6975` | R-132-a; Jack on fold-vs-auto-advance |
| **R-155-b** — the supplier profile, built ONCE as a role-configured component (MASTER-PLAN:127, W5-f) | desktop, mobile, server | L | `SuppliersView.tsx:534-600`; `ClientDetailView.tsx` (1,096 lines); new `showSupplierDetail()` next to `www/app.js:4801`, row handler `:3496` | R-155-a; Jack's D-4/D-5. Doing R-153 first without this builds it twice |
| **R153-1/2/3/4** — deals on the client profile, four tabs → one stream, chrome below substance, next-action line | desktop, mobile | L | `ClientDetailView.tsx:175-182, :403, :559, :575, :659, :682, :714, :722, :744, :754, :465-480, :525-535, :545` | Jack D-5; R-155-b if role-generic |
| **CVA-1 / CVA-8** — client list still `ORDER BY c.name`; profit sits unused in memory | desktop, server, mobile | M | `ClientsView.tsx:59-60, :190-193, :717, :174-183, :788`; `clienthub-api/src/routes/models.rs:400-409` + `clients.rs:727`; `www/app.js:4684-4741` | Jack: revenue-first or profit-first |
| **CVA-3** — FIVE `lead_status` vocabularies (the audit found four; mobile adds a fifth, `'active'`/`'warm'` at www/app.js:4605-4618) | desktop, server, mobile, data | M | `ClientsView.tsx:100, :609-615, :691-694, :889-892`; `commands.rs:315, :405`; `clients.rs:166, :272`; `www/app.js:4605-4611` | Jack picks the canonical set + rules on the 6 'Active Buyer' rows (NEVER-ERASE) |
| **CVA-12** — 2 rejected clients counted inside the 141 | desktop, server | S | `commands.rs:163-178, :1649`; `clients.rs:631-727` — grep every caller before adding a WHERE | Jack: hide or badge |
| **R-143** — designate a real Plaid account as the reserve | desktop, server, mobile, data | L | `commands.rs:13917-13968` (reuse the identity key at :13947-13958), `:14094-14111`, `:14198-14206`; `FreeCashView.tsx:337-364, :483`; `settings.rs:258-263` | Jack: which account, and whether free cash should visibly drop |
| **R-134b** — Vitest + `npm test`; first targets `src/lib/newsletter.ts` and `src/lib/permissions.ts` | desktop, server, mobile | M | new `vitest.config.ts`, `package.json`, `.github/workflows/check.yml:46`; extracting pure helpers out of `www/app.js` (no build step — a botched extraction ships broken to the PWA *and* the iOS bundle) | none |
| **R-134c** — recharts still in the entry chunk | desktop | S | `vite.config.ts` manualChunks | none |
| **R-134e** — no CI guard on raw hex (live violations at App.tsx:91/93, InvoicePreview.tsx:167) | desktop | S | `.github/workflows/check.yml` | Jack: fix-vs-allowlist |
| **R-019-C** — surface the four silent skip paths | desktop | M | `commands.rs:13290, :13400, :13417, :13557, :13575, :13859-13871`; `src/lib/api.ts:1753`; `FinancialsView.tsx:870` | none. Do NOT change the skip decisions while adding the reporting |
| **R-019-E** — provenance backfill (973 of 1,349 rows have empty raw_json, so 15 of 25 dup groups can't be classified) + reference as a second dedupe key | desktop, data | M | `commands.rs:13548-13554, :12766, :12582` | none for detection; Jack per-group before any removal |
| **R-008 items 1-3** — greeting/sign-off/footer as settings; `{sender_name}` token; honour the unsubscribe toggle server-side | desktop, server, mobile | M | `commands.rs:8416-8433, :15419-15425, :15462-15517`; `settings.rs:256-257, :353-361`; `template.rs:101-160` both repos; `EmailView.tsx:542-543`; `www/app.js:9046-9047, :8462-8478`; `scheduler.rs:521-528` | Jack on scope (1-3 vs 4) and per-sender-vs-org |

### WAVE 4 — Mobile parity block (the worst surface by a wide margin)
Mobile has: no supplier profile (a tap opens the edit form, www/app.js:3496), no suppliers in search (:1316-1332), no person payments/picker/filter, no free-cash or reserve screen at all, no Plaid surface, no storefront config, no photo upload, no client sort control (while mobile *suppliers* have four, `_supSort` at :3466-3471).

| id | surfaces | size | files | depends on |
|---|---|---|---|---|
| **R-006** — camera capture for lot photos (also the Guideline 4.2 answer for Apple) | mobile | M | `www/app.js:5037-5093`, `:1808-1822` (generalise resize to ~1600 + `toBlob`), `:254-293` (new `postBytes`), `:3804`; filename MUST be `photo_<32-hex>.jpg` (reusing photo_001 is the cached-image bug) | NSCameraUsageDescription lives in the Mac-only `ecliptr-mobile` repo |
| **R-152-d** — suppliers absent from mobile search | mobile | M | `www/app.js:1316-1332, :1460` (hoist `_suppliers` from renderSuppliers :3389) | R-155-b for somewhere to land |
| **R-156/R-157 mobile** — tagging, person payments, method + person filters | mobile, server | L | `www/app.js:3147, :2726, :4801`, new supplier detail; port the three-group split from `PersonPayments.tsx:283-292` | R-156-server |
| **R-154-b (W3-f)** — the this-week pickup/delivery view on the Brief and mobile home. **The only unbuilt step of R-154, and the piece Jack's original complaint was actually about** — what's live when the salesman is out. | desktop, server, mobile | M | `clienthub-api/src/routes/dashboard.rs:462, :825-850` (reuse the window at :494 — R-159 made these Mon–Sun Central); `www/app.js:7987, :4232` (reuse `dfShipChipHTML` :6044); `commands.rs:10301`; `BriefView.tsx:35` (lift `gateBasis`/`nextDate` from DealFlowView.tsx:72-103 to a shared module) | none |
| **R-163-5** — mobile cannot set `refund_owed` though the endpoint exists (staff_api.rs:896/1489) | mobile | S | `www/app.js:7261-7263` | subsumed by R-163-1 if that ships first |
| **R-163-4** — desktop has no "partially refunded" state; mobile already has a three-state badge | desktop | S | port `www/app.js:542-552` into `DealFlowView.tsx:832` | wording only |
| **R-123-MOBILE** — no storefront config on mobile at all | mobile | M | `www/app.js` new section → existing `/api/settings/storefront` (storefront.rs:25) | sequence after R-123's re-ask |
| **R-154-c** — mobile invoice form writes `invoices.pickup_date`, a different column from the one the gate and lane read; the date silently does nothing | mobile | S | `www/app.js:5931, :7963` | Jack: kill the invoice dates or keep them for deal-less invoices |
| **R-175-PARITY** — `counterparty_payments` has no server endpoint at all (zero hits across clienthub-api), so R-170/R-172/R-175's "(+ mobile parity)" is a three-row ledger overstatement | server, mobile | L | as R-156-server | R-156-server |

### WAVE 5 — Gated / owner-authorised only
- **R-004 (server-owned Plaid feed).** The complete server implementation already exists in the repo, fenced behind a boot panic (`routes/plaid.rs:34-51`, `ECLIPTR_ALLOW_PLAID=1`) and a hard scp deny (`.claude/hooks/no-erase.sh:66`). Requires Jack to lift the deny, enter three secrets into the systemd unit himself, AND disarm the desktop importer in the same release (`main.rs:495-513`, `commands.rs:13274`). The server importer is strictly weaker — no allocation carry-forward, no deleted-row backup, no `bank_txn_is_referenced` gate — so a webhook `removed` would delete booked rows with no recovery copy. **Do not propose this as part of R-003.**
- **R-003 (link once, green everywhere).** Real first step is NOT the status GET — the server's `plaid_items` table is empty in production because `POST /api/plaid/items` isn't deployed and both desktop call sites discard the failure (`commands.rs:13200`, `:13237` are `let _ =`). Needs a minimal token-free registration endpoint in a *deployable* module (settings.rs, never routes/plaid.rs) first. Then C5 (`FinancialsView.tsx:793-804` never re-reads Plaid), C6 (`plaid_remove_item` at :13259-13269 leaves the org secret, so the next materialize resurrects a dead connection), and the double-link guard reusing the identity key at `:13947-13958`.
- **R-019-D (bt1_ identity).** Unrecorded hazard: because existing ids stay frozen, a new `bt1_` row for a transaction already held as `btpl_` will NOT collide — it inserts a duplicate. Wiring it without either a reference index over the 563 eligible rows or keeping fingerprint dedup alive makes duplicates *worse*.
- **R-123 (storefront redesign).** Gated on a re-ask. Two of the things making it look shouty are Jack's own settings, not the design: title is `AVAILABLE LOTS` in caps (used as tab title, H1 *and* brand fallback) and accent is `#ff6a00`, a shade off the brand `#FF6520`.
- **R-152-e (carrier/warehouse record type).** Not startable as scoped — the two-kind assumption is baked into `commands.rs:14538`, `bank_write.rs:474`, `PersonPicker.tsx:18`, `load_party_pool`, and `counterparty_payments_sql`'s `is_supplier` bool. Tell Jack a text field is dramatically cheaper before he decides.
- **R-152-fgh (recap / buyer confirmation / handoff mode).** All downstream of R-152-a — none can send or confirm a fact that isn't stored. F and G mail counterparties on both sides of a brokered deal; nothing should be built until the exposure question is answered.
- **R-019-B (statement tie-out).** 1,348 of 1,349 rows are Plaid and exactly 1 is manual cash — zero came from a statement import. May be worth nothing to him; ask first.
- **R-011-A/B/D repair.** Read-only step 1 first (Wave 2). Repairs write to profit-bearing rows and must go through the merge-on-write handlers, from ONE device, after a verified backup.

**Nothing useful returned for:** R-152-b (completeness badge) — the pattern is built and proven, but there is genuinely nothing to build until R-152-a's fields exist.

---

## 3. FILE CONTENTION MAP

**`src-tauri/src/commands.rs` (18,605 lines) — by far the worst.** Split by line region, one agent per region:
- :163-1866 (client list/revenue) — CVA-1, CVA-8, CVA-12, CVA-3
- :1134-1147 (bulk delete) — CVA-5
- :2035-2093 (interactions) — R-152-c
- :2787 (overdue sweep) — R-131-C2b
- :3827-3866, :4332-4394, :4654-4700 (supplier payments / completed resync) — R-132-b, R-132-c, R-132
- :4042-4209 (payment received) — R-132
- :4745-4755 (uncomplete) — R-010-stage
- :4953-5089, :5313-5378 (refunds/payout) — R-163-1, R-163-3, R-163-6
- :9392-9633 (analytics profit) — R-163-6, R-131-3
- :9763-9790 (AR aging) — R-131-C2d
- :10301-10523 (weekly brief) — R-131-3, R-154-b, R-131-C2 (done)
- :11875-11935 (manual cash) — R-009 source
- :13189-13968 (Plaid) — R-003, R-004, R-019-C, R-019-E, R-143
- :14536-14792 (counterparty) — R-155-a, R-156-server source, R-175-phase2
- :15419-15517 (newsletter) — R-008
- :17286-17390 (recon/stranded) — R-019-A

**`clienthub-api/www/app.js` (558 KB, no build step, ships to PWA *and* iOS bundle).** Touched by: R-006, R-152-d, R-156-mobile, R-154-b, R-154-c, R-163-4/5, R-014-INV-4, R-123-MOBILE, R-131-3, R-131-C2d, R-008, CVA-1, CVA-3, R-155-b, R-175-PARITY. **This is the single highest-contention file in the programme** — it needs a strict one-agent-at-a-time rule, or a helper extraction (R-134b) to create module boundaries first.

**`src/components/ClientsView.tsx` (955 lines)** — CVA-1, 3, 5, 6, 8, 9, 10, 11, 12, 13, 14. Ten items in one file: do them as ONE session, not ten.

**`src/components/ClientDetailView.tsx` (1,096 lines)** — R153-1, R153-2, R153-3, R153-4, R153-7, R-152-c, R-155-b. Same rule.

**`src/components/DealFlowView.tsx`** — R-132, R-132-b, R-152-a, R-152-b, R-163-4, R-154-b (helper extraction).

**`src/components/FinancialsView.tsx`** — R-156-W1c, R-157-W2d, R-157-W2g, R-019-C, R-003 (C5), R-009.

**`src-tauri/src/db.rs` MIGRATIONS array :1655** — R-155-a, R-152-a, R-163-2, R-175-phase2, R-011 (none). **Four items want number 80.** Assign explicitly.

**`clienthub-api/src/routes/dashboard.rs`** — R-131-3 (:289, :597-604), R-131-C2c (:342-345), R-154-b (:462, :825-850), R-131-P1 (:501).

**`clienthub-api/src/routes/deal_flows.rs`** — R-010-stage (:1241-1258), R-132-a (helper source), R-163-2 (:175), R-152-a (:181, :1467-1545).

**`clienthub-api/src/staff_api.rs`** — R-163-6 (:1048), R-163-7 (:737-786), R-131-C2d (:1327), R-163-3 (:382-465).

**`clienthub-api/src/routes/bank.rs` / `bank_write.rs`** — R-156-server, R-009-server, R-175-PARITY.

**`clienthub-api/src/sync.rs` ensure_meta_tables :167/:529-556** — R-155-a, R-152-a, R-163-2, R-157-W2d. Every synced-column item passes through here.

**`clienthub-api/src/routes/storefront.rs` + `www/shop.html`** — R-014-INV-2B, R-123. `PUBLIC_LOT_COLUMNS` (:63) is positional and index-synced with `row_to_public_lot` (:92-163) — a mid-list insert silently publishes wrong data.

**`src/components/PersonPicker.tsx` / `PersonPayments.tsx`** — R-171-picker, R-155-c, R-156-mobile (port source).

---

## 4. DECISIONS FOR JACK

**D-1 — Party model: a link column, or a real party entity both records hang off?** Also: can one party have two supplier records (two trading names)? *Blocks:* R-155-a, and through it R-155-b/c, R-152-d, R-152-e. *Recommended default:* a nullable `link_id` column on both tables, no new entity — cheapest, and reversible while there is almost no data. Cannot be reversed cheaply once data exists.

**D-2 — Build the profile ONCE as a role-configured component, or ship a supplier profile now and rebuild later?** *Blocks:* R-155-b, R153-1/2/3, D4-SCOPE. *Recommended default:* build once (MASTER-PLAN:127, W5-f). Doing R-153's client rebuild without it means paying for the supplier profile twice.

**D-3 — Is the client *list* in scope, or only the profile? And does the activity stream absorb deals and payments, or stay contact-only?** *Blocks:* R153-1, R153-2, CVA-1, CVA-8. *Recommended default:* list in scope but as a fix not a rebuild (roughly a third of the proposed W5-g already shipped incidentally in v0.16.0); stream absorbs deals.

**D-4 — Client list leads with revenue or with profit?** *Blocks:* CVA-1, CVA-8. *Recommended default:* profit-descending, matching what suppliers were deliberately moved to in R-116/v0.15.135. `total_profit` is already fetched and in memory (`buyerTiers`) — no backend work.

**D-5 — Which deal facts actually go missing?** When offered a nine-field logistics block he replaced it with ONE field (the pickup date, now shipped). *Blocks:* R-152-a, and downstream R-152-b, R-152-fgh. *Recommended default:* exactly one new field, "who books the freight" — his own words. Do not re-add the other eight.

**D-6 — Canonical `lead_status` vocabulary, and what the 6 imported "Active Buyer" rows become.** There are FIVE vocabularies live; the same org shows a non-zero "Active" on the phone and 0 on the desktop. *Blocks:* CVA-3, and CVA-4's empty-list symptom. *Recommended default:* the underscore set the stats/filters already read; backfill "Active Buyer" → `active_customer`. This is a write over production rows — NEVER-ERASE applies.

**D-7 — Does entering a shortage move profit immediately, or only once the two bank legs are linked?** *Blocks:* R-163-1. *Recommended default:* link-driven, matching his own wording and how `deal_bank_actuals` already works.

**D-8 — The "Supplier reversal" dropdown: delete it, or keep it and exclude `source='supplier'` from every buyer SUM?** Today it books supplier money as buyer money — cutting profit, paying down `refund_owed`, shrinking the rep's cut and netting out client revenue. *Blocks:* R-163-3. *Recommended default:* delete the option; supplier recovery is a `refund_in` allocation, which already exists and works. Note: keep-and-exclude changes stored profit on existing rows the moment it ships.

**D-9 — The four $90,000 wires: did you buy from Let Us Liquidate, or did Ronnie direct payment there?** There is no supplier record matching that name, and PersonPicker can only filter an existing list — so the "two-tap fix" the ledger promises is unreachable. *Blocks:* R-171, R-171-picker. *Recommended default:* create the supplier record, then tag (identity only, moves no money). Re-splitting INV-0175's `supplier_payments_json` DOES move money — never do it as a side effect.

**D-10 — Money movement: fold, or delete-and-derive with auto-advance from the bank?** Derivation cannot cover it — `bank_allocation` has no `supplier_payment_id`. *Blocks:* R-132. *Recommended default:* fold, plus consume the `payment_received_paired`/`supplier_paid_paired` booleans that `deal_reconciliation` already computes (commands.rs:12028-12048) as a one-click confirm rather than a silent auto-advance.

**D-11 — Does the deposit field survive?** It is write-only: `set_deposit` is its only writer and `get_receivables_aging` (commands.rs:9755-9790) never subtracts it, so a deal taken on a deposit still shows the full invoice outstanding everywhere. *Blocks:* R-132. *Recommended default:* wire it into AR, or drop it. It is not a feature being lost; it was never finished.

**D-12 — Does the `kept` toggle survive, and were kept flags ever set?** `kept=true` appears zero times across all 83 legs today *and* in the 2026-08-04 backup. *Blocks:* R-132, R-011-B. *Recommended default:* if never used, R-011-B closes with nothing to repair.

**D-13 — Authorise the read-only `sync_events` archaeology?** The log is append-only and has never been pruned — it is the only recovery source, and D-7/damage decisions are currently being made blind. *Blocks:* R-011-E, R-011-B. *Recommended default:* yes to step 1 (read-only measurement), separately from any repair go/no-go.

**D-14 — Which Plaid account is the reserve, and do you accept free cash visibly dropping by its balance?** *Blocks:* R-143. *Recommended default:* designate one account, keep the headline as free cash, show "parked $X of $Y target". Also decide `reserve_entry`: wire it or drop it (it has had no reader and no writer since it was created).

**D-15 — Do Plaid access tokens replicate at all?** Two incompatible designs are half-present: the org-secrets bridge (tokens land in plaintext on every admin desktop, admin-only) vs C9's status-only green dot (no secret moves, non-admins see green). *Blocks:* R-003. *Recommended default:* status-only.

**D-16 — R-004 authorisation.** Lifting the never-deploy-plaid.rs rule, entering three secrets into the production systemd unit yourself, and disarming the desktop importer in the same release. *Blocks:* R-004. *Recommended default:* not yet.

**D-17 — Storefront re-ask (R-123).** With the page in front of you: what still reads as not-sharp? And two of the shouty things are your own settings, not the design — want the caps title and the off-brand accent fixed first? *Blocks:* R-123, R-123-MOBILE.

**D-18 — Newsletter scope: settings-backed greeting/signature/footer (plain text), or the HTML/colour pipeline too?** Every newsletter is plain text today; colours means a whole new email pipeline. *Blocks:* R-008. *Recommended default:* items 1-3 only. Note two live bugs regardless: the shipped server default outro mails the literal `{sender_name}` to customers (settings.rs:361, no resolver anywhere), and `newsletter_unsubscribe_enabled` is ignored server-side (scheduler.rs:524-528 appends unconditionally).

**D-19 — Reopened deal lands in `invoiced` or `supplier_paid`?** *Blocks:* R-010-stage. *Recommended default:* `supplier_paid` (the server's, which mobile already uses).

**D-20 — Past due = invoice face value, or unpaid balance?** An invoice with a partial payment recorded but status still `sent` is currently reported at 100% of face on all four AR surfaces. *Blocks:* R-131-DEC1. *Recommended default:* face value (status quo) until the broader "which figure is revenue" question is answered — answering them separately risks two more surfaces disagreeing.

**D-21 — Backfill historical rows, or fix forward only?** Applies to R-132-c (completed-deal cost), R-131-1r (`completed_at`), CVA-3 (`lead_status`), R-163-3 (existing `source='supplier'` rows). *Recommended default:* fix forward; any backfill is a sync writer that re-broadcasts every affected row and needs a verified backup first.

**D-22 — Root-doc prune, and which MASTER-PLAN outranks the other (08-13 vs 08-17)?** *Blocks:* R-134f. *Recommended default:* move to `docs/`, delete nothing (00-RULES rule 2); 08-17 outranks.

---

## 5. RISK REGISTER

**MONEY**

- **Netting a dual-role party's two sides into one figure.** Money to them is cost, money from them is revenue. `PersonPayments.tsx:24` already refuses to net and cites R-155 by name; the combined strip is the one screen where a naive subtraction reads as profit. Label it total bought / total sold / POSITION, never "profit". *Threatened by:* R-155-c, R-155-a.
- **Refunds are revenue, never profit; net per deal capped at that deal's profit.** Three analytics queries (`commands.rs:9392, :9546, :9553, :9625`) subtract refunds uncapped AND by a third counting rule that misses allocation-only refunds — while the *same response* reports `refunded_total` by the correct rule. Fixing it will move the month and all-time profit figures. *Threatened by:* R-163-6, R-163-1, R-131-3.
- **`source='supplier'` refunds are counted as buyer refunds** — no SUM anywhere filters on `source`. Supplier money entered there cuts profit, pays down `refund_owed`, shrinks the rep's cut and reduces client revenue. *Threatened by:* R-163-3.
- **An allocation with no backing `bank_txn` is invisible to some SUMs and double-counted by others.** Any server-side cash route must create the txn first, in the same request. *Threatened by:* R-009-server.
- **Never dedupe identical same-connection pairs** — the 2×$100k Tytan and 2×$20k wires are real repeats. *Threatened by:* R-019-E, R-009-server.
- **`resync_completed_deal` passes `total_cost` where `write_sp` just wrote `total_supplier_cost`** — toggling `kept` on a completed deal silently fails to move recorded profit, partner splits, rep cuts, tax reserve and free cash. *Threatened by:* R-132-c, R-132, D-12.
- **`mark_payment_received` is the ONLY path that both advances the flow and flips the invoice to paid+paid_at** (commands.rs:4083-4088); `unmark_payment_received` (:4169-4209) is the only cascade that unwinds a completed deal. Relocating either without preserving both halves desynchronises `invoices.status` from `deal_flows.stage` and poisons AR and every dashboard. *Threatened by:* R-132.
- **`bulk_delete_clients` runs a bare `DELETE FROM clients`** (commands.rs:1140) with no soft-delete, broadcasts `record_delete` to every device, and swallows FK rejections inside `.is_ok()`. Select-all reads the *unfiltered* array. NEVER-ERASE surface. *Threatened by:* CVA-5.
- **Excluding the reserve account from `plaid_balances()`** touches bank_balance → free_cash → runway on desktop AND the org-wide published balance. Get it wrong and free cash understates on every device at once. Also: don't re-subtract the target once the real balance is excluded. *Threatened by:* R-143.
- **Restoring a `kept` flag RAISES recorded profit** and can auto-advance the deal stage (`set_supplier_payment_kept` clears `paid` and advances at deal_flows.rs:1592/1603). *Threatened by:* R-011-B.
- **Re-splitting INV-0175's `supplier_payments_json`** moves `total_supplier_cost`, `supplier_payables` and per-supplier spend. Tagging is identity-only and safe; re-splitting is not. *Threatened by:* R-171.
- **Backfilling `supplier_id` from `supplier_payments_json`** would bake today's wrong INV-0175 answer into a column instead of leaving it a visible inference. *Threatened by:* R-175-phase2.

**SYNC**

- **A new column on a synced table must be server-deployed FIRST** or `apply_upsert` logs SCHEMA DRIFT and silently drops it from every event. Applies to every migration-80 candidate. *Threatened by:* R-155-a, R-152-a, R-163-2, R-157-W2d, R-175-phase2.
- **Four items claim migration 80.** Highest at HEAD is 79 (db.rs:1655). Two sessions writing 80 in parallel is a guaranteed collision. *Threatened by:* MIG-80-CLAIM.
- **New columns must be nullable, no NOT NULL, no CHECK.** Migration 77's comment (db.rs:1608-1613) records that a partial upsert violating one is swallowed by `INSERT OR IGNORE` on the insert branch, or errors and REWINDS THE PULL CURSOR on the update branch. *Threatened by:* R-152-a, R-163-2, R-155-a.
- **A column written and synced but never SELECTed back is invisible forever** — exactly what happened to `interactions.user_name`. Add new columns to the reader structs in the same change. *Threatened by:* R-155-a, R-152-a, R-152-c.
- **Never chain `filter_map(|r| r.ok())` over a row mapper.** `list_bank_txns` (commands.rs:11137) still does; `counterparty_payments` (:14750) goes out of its way to avoid it with a comment explaining why. *Threatened by:* R-156-server, R-175-PARITY.
- **Merge-on-write everywhere.** Narrow mobile forms + full-column server writes = NULL over unshown fields, synced everywhere. Storefront settings and counterparty writes must patch, not replace. *Threatened by:* R-123-MOBILE, R-156-mobile, R-006.
- **A second server route writing `deal_flows` without `sync::record_upsert`** leaves the oplog behind and the change never reaches desktop. *Threatened by:* R-132-a.
- **Two writers of `bank_txn` into one mirror** is the mechanism behind the ~548 excess duplicates and the pending/posted churn that destroyed bookings. The server importer has no allocation carry-forward, no deleted-row backup and no `bank_txn_is_referenced` gate. *Threatened by:* R-004.
- **A new `bt1_` row will NOT collide with the same transaction's frozen `btpl_` id** — it inserts a duplicate. Unwritten anywhere until now. *Threatened by:* R-019-D.
- **Never scp `main.rs` or `plaid.rs`** — hand-patch main.rs; plaid.rs is hard-denied. `routes/mod.rs` and `main.rs` are permanently divergent from git on the droplet. *Threatened by:* R-134d, R-003, R-004.
- **A startup backfill is a sync writer** that re-broadcasts every affected row on every launch. *Threatened by:* R-131-1r.

**PARITY**

- **A method/tier/status list enumerated in N places fails silently when one is missed.** The method read has a fixed precedence duplicated in THREE runtimes (`FinancialsView.tsx:366`, `PersonPayments.tsx:145`, `www/app.js:2709`); client tiers in ~17 places; `lead_status` in five. *Threatened by:* R-157-W2, CVA-3.
- **"Which date is next" is about to have four implementations.** Share `gateBasis`/`basisWord`/`nextDate` (DealFlowView.tsx:72-103) rather than copying, or the lane and the brief will disagree. *Threatened by:* R-154-b.
- **`www/` ships to BOTH the PWA and the ecliptr-mobile iOS bundle.** Any change needs the `?v=` bump, the sw.js CACHE bump, and a matched scp deploy; a syntax error breaks an App Store build. *Threatened by:* every Wave 4 item.
- **`PUBLIC_LOT_COLUMNS` is positional and index-synced with `row_to_public_lot`.** Appending is safe; a mid-list insert silently publishes supplier/cost/notes-shifted data on the public store. *Threatened by:* R-014-INV-2B, R-123.
- **The BJM website hydrates from the same feed** — a payload-shape change breaks bjmdistributions.com silently. *Threatened by:* R-014-INV-2B, R-123.
- **A gate with no recorded override gets defeated by fake dates.** Any new gate must inherit the `gate_overrides` append-never-overwrite behaviour (commands.rs:4471, tested at :18543). *Threatened by:* R-152-b.
- **A counterparty tag is IDENTITY, NEVER ACCOUNTING.** Any mobile port must inherit the three-group split; merging "booked to their deal" with "booked to someone else's deal" is what once put $279,500 of four other clients' money on one profile. *Threatened by:* R-156-mobile, R-175-PARITY.
- **Mobile writes a pickup date to a different column than the gate reads** — the feature silently does nothing, which is how a gate dies in a month. *Threatened by:* R-154-c.
- **On mobile, "Reject" is the button that sells a lot.** Inverting the two while relabelling would mark live stock sold from a phone. *Threatened by:* R-014-INV-4.
- **Reusing a photo filename serves stale cached bytes to the public storefront.** Must be `photo_<uuid>.jpg`. *Threatened by:* R-006.
- **The unsubscribe footer is the legal opt-out.** Making its text a setting means an empty value must fall back to the current literal, never to nothing. And the recipient-suppression SQL (is_blacklisted + `exclusive` column + metadata.$.exclusive + metadata.$.unsubscribed) is duplicated at commands.rs:15477-15484/:15496-15503 and scheduler.rs:140/157/481 — a dropped clause mass-emails a blacklisted client. *Threatened by:* R-008.
- **`cargo fmt` across the tree would rewrite 1,496 hunks** and destroy the diff-against-last-tag discipline that keeps concurrent sessions from clobbering each other. Do not wire it. *Threatened by:* R-134a.
- **Extracting helpers out of `www/app.js`** — no build step, ships straight to production. *Threatened by:* R-134b.