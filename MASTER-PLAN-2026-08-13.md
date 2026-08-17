# MASTER PLAN — burn down everything never tackled (R-151, 2026-08-13)

Written for an agentic workflow. Every workstream (WS) is a self-contained brief: goal, exact items, files, schema impact, order, guards, verification, and what to read first. An orchestrator should run WS in the stated order, one WS = one or more agents, one release per WS chunk. **This plan plans; it does not decide anything that is Jack's call — those are collected in §DECISIONS and each dependent step is marked GATED.**

Sources of truth, in precedence order: `00-RULES.md` (binding) → `gotchas.md` → `architecture/*` → the per-item `revisit/*` note or audit doc named in each step. When this plan and a vault note disagree, the vault note wins and the discrepancy gets reported, not silently resolved.

---

## §0 GROUND RULES — paste into every agent's brief

1. **Read first, always:** vault `00-RULES.md`, `gotchas.md` (all sections), and the specific note/audit named in your step. Never read `commands.rs` (~17k lines) or `app.js` (~7k) whole — grep, then read narrow ranges.
2. **Never-erase:** no destructive SQL against live DBs, no vault row deletion, no git reset/force-push. Backup before any data mutation; review-and-confirm before any bulk data change — NEVER a silent UPDATE over money.
3. **Concurrent sessions are real.** Before committing: `git diff` every touched file against last tag; stage hunk-by-hunk if foreign hunks are present (byte-safe: pipe patches as bytes, cp1252 mangles em-dashes on Windows). Verify staged diff contains none of the other session's signatures. Request-ledger ids collide — re-grep your R-row after any save.
4. **Money invariants** (architecture/financials.md §Invariants, 19 of them) are law. The recurring killers: every SUM over `bank_allocation` needs `EXISTS(bank_txn)`; refunds counted ONCE (non-bank-linked `refunds` rows + all `refund_out` allocations, never both, never max); `net_profit` is pre-refund; deletes go through `sync::record_delete` then local DELETE then `push_now()`; every write through `record_upsert`; send only changed columns (per-column LWW — naming an unchanged column re-stamps its clock).
5. **Sync table changes:** a new synced column lands in 3 places (desktop `db.rs` migration, server `schema.sql`, server `sync.rs` ALTER list at ~:487). A new synced table lands in 5 lists (desktop `sync.rs` ALLOWED_TABLES, desktop `netsync.rs` SNAPSHOT_TABLES, server ALLOWED_TABLES + PUSHABLE + SNAPSHOT_TABLES) + server `ensure_schema`. **Server deploys BEFORE the desktop that emits the new table/column** — `push_event` drops-and-acks unknown tables (event lost forever).
6. **Deploy per runbooks/deploy.md:** checksum sweep first (known baseline: `auth.rs`, `main.rs`, `routes/mod.rs`, `shopify.rs` differ by design); NEVER scp `plaid.rs`/`routes/plaid.rs`/`main.rs`/`routes/mod.rs` (hand-patch the latter two in place); backup binary + `VACUUM INTO` DB snapshot; build as `ecliptr`; verify `is-active`, `NRestarts=0`, `api/health` 200, plaid count still 0; add a deploy-log row; commit source same session. Bump `sw.js` CACHE + `?v=` on ANY www change. www changes also flow into the `ecliptr-mobile` iOS bundle — coordinate with the R-122 session.
7. **Release pipeline:** bump version in `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`, `cargo check` refreshes the lock, commit, tag `vX.Y.Z`, push tag. Releases build as DRAFT and publish only if all platforms succeed. Verify `releases/latest` is not draft and `latest.json` serves the new version. A change is NOT delivered until tag published / deploy verified / vercel prod (three surfaces, three last steps, all silent).
8. **Verification floor per change:** `cargo test --bin clienthub` (NEVER `--lib` — false green) + `npx tsc --noEmit`; UI changes rendered in the mockIPC browser harness (create `fin-harness.html` + `src/fin-harness.tsx` with `@tauri-apps/api/mocks`, exercise, then delete); money changes measured against the live DB read-only BEFORE and AFTER (python sqlite3, `mode=ro`, no sqlite3 CLI exists; force UTF-8).
9. **Design rules:** sentence case everywhere, no uppercase kickers, no emoji, Satoshi, warm-paper tokens, 130ms motion. Booking basics (category/deal/book) live ON the row, always visible. Never call `.focus()` from a ref callback. 216px sidebar → shift grid breakpoints up one step, `min-w-0` everywhere.
10. **Update the vault same session:** matching architecture/feature note bumped, request row status updated, deploy log row added, anything ugly → `revisit/` + backlog row. Never delete a request row.

### DO NOT TOUCH (owned elsewhere or explicitly deferred)
- **R-122 / iOS**: build 3, TestFlight, App Store — the Mac session owns it. Only coordinate www propagation.
- **R-142 / R-150 / R-143(dup "link button")**: Financials UI redesign + smart linking — the other financials session owns them; it has uncommitted work in `commands.rs` / `FinancialsView.tsx` / `api.ts` and an untagged v0.15.142 pending. Any WS touching those files must check its state first (memory note `r150-review-fixes-pending-tag`).
- **R-012 WhatsApp**: paused by Jack, needs planning with Fable. Do not resume.
- **R-133 Globe**: trigger is the iOS push to Apple (R-122 N6/N11). Do not start early.
- **Backlog #22 (`bt1_` wiring), #24 (DB pool), #25 (`apply_upsert` OR IGNORE), #26 (commands.rs split)**: the fix is more dangerous than the defect. Only WS6 phase C touches #22, alone, gated. #24/#25/#26 stay out of this plan's execution entirely — entry criteria listed in §WS12.

---

## §WS1 — SAFETY INTERLOCKS (backlog #1–#4 + #14). First. One afternoon. Server-side.

Read: `revisit/ci-deploy-would-ship-plaid`, `server-plaid-deploy-footgun`, `db-path-default-silent-empty`, `systemd-env-secrets`, `stale-server-deploy-docs`, runbooks/deploy.

1. **#1+#2 Plaid guard (one guard closes both).** In `clienthub-api`: delete or disarm `.github/workflows/deploy.yml` permanently (replace with a workflow that only runs `cargo check` — see WS11); add a startup assertion to the SERVER that refuses to boot if `routes/plaid.rs` is compiled in AND env `ECLIPTR_ALLOW_PLAID` unset — belt for the careless-scp brace. Deliver via hand-patch of droplet `main.rs` (never scp it), keep `/root/main.rs.prev-*`.
2. **#3 DB-path fail-loud.** `src/db.rs` `open_db()`: if `CLIENTHUB_DB_PATH` unset → hard error naming the var, unless `ECLIPTR_ALLOW_FRESH_DB=1` (protects genuine first boots). Kill the dead `/home/jack/...` default. Same deliberate `main.rs`/`db.rs` deploy as step 1 — pair them.
3. **#4 Secrets out of the unit.** Move SMTP password, backup passphrase, `CLIENTHUB_SECRET_KEY` into an `EnvironmentFile=/home/ecliptr/.ecliptr-env` (root:ecliptr 0640). **Leave the AEAD key VALUE unchanged** — rotate SMTP + backup passphrase only (GATED: Jack supplies new values or approves reuse). Update runbooks/deploy DB-path lookup instructions.
4. **#14 Stale docs.** Fix `clienthub-api.service` file + `DEPLOY.md` in-repo to match live reality (unit `ecliptr`, path, no CI deploy).

Verify: service restarts clean; `systemctl show ecliptr -p Environment` no longer prints secrets; a deliberate boot without env file fails loudly; plaid count still 0. Deploy-log row.

## §WS2 — SILENT-CORRECTNESS SWEEP (backlog #5–#9, #7c + refund leftovers). Desktop+server matched sets.

Read each `revisit/*` note first. These fail with no error today.

1. **#7 refund `EXISTS(bank_txn)` guards** — six unguarded counted-once readers incl. `refund_status_all` (decides refund mode) and client tier revenue. Fix ALL six in one pass (partial = worse), desktop `commands.rs` + server (`clients.rs`, `invoices.rs`, `suppliers.rs`, `deal_flows.rs`) as a matched set. Measure live before/after: expect zero numeric change (0 orphans today) — any change is a bug in the fix.
2. **Refund leftover A** (`revisit/remove-allocation-orphans-its-refund-row`): `remove_bank_allocation` on a `refund_out` allocation must CLEAR the paired `refunds` row's `bank_txn_id` (prefer clear over delete — keeps reason + keeps money counted), through `record_upsert`. Test: create refund via workspace, remove allocation from Financials, total unchanged.
3. **Refund leftover B** (`revisit/server-refund-list-is-table-only`): mirror desktop's `list_refunds` UNION into `staff_api.rs` GET refunds (+ `bank_txn_id`, `origin` in response); stamp `org_id` at author in desktop `create_refund`. Can ship with WS8 phase A instead if that lands first.
4. **#5 payments oplog**: `routes/payments.rs` INSERT gains `record_upsert` + pull-log append (copy any of the 97 call sites); sweep `grep -n "INSERT INTO" src/routes/` for other synced-table writes missing events.
5. **#6 `newsletter_sends`**: remove from server `PUSHABLE` (it's not in ALLOWED_TABLES; push→apply hard-errors and dead-letters). Delete the stale desktop comment.
6. **#9 `existing_row_org`**: consolidate a pk-map (`settings`→`key`, `deal_reps`→`deal_flow_id`, else `id`) shared by the four inline matches; unknown table → **deny**, not allow.
7. **#7c template tier**: both `template.rs` files gain the `voided`/`archived` filter + `'overdue'` in the sent count, matching `buyer_tiers`. Two clients will move tier — report names, don't hide it.
8. **#8 AR/AP drill-in**: `ReceivablesView.tsx` + `PayablesView.tsx` navigate to `dealflow` not `deals`; clear the stale `dealflow_invoice_filter` key on read. Check mobile for the same helper.

One desktop release + one server deploy (matched). Every reader change re-measured live.

## §WS3 — BRIEF ACCURACY (R-131 audit). Money on screen is wrong TODAY.

Read FIRST: `BRIEF-AUDIT-2026-08-06.md` (57 findings, fix order in §E; §6 = ten decisions) + vault row R-131 + memory `brief-audit-2026-08-06`.

Order inside this WS (from the audit, verified against current code before each step — the audit is a week old):
0. **Prereq**: INV-0183's orphaned $26,600 buyer credit re-linked (review-and-confirm UI list, Jack clicks) or that deal stays stuck in July.
1. **`completed_at` re-derivation** — the $47,920 August-sits-in-July fix. All 32 completed deals re-derived from `MAX(bt.posted_at)` over `buyer_payment` legs via the EXISTING "Sync completed from bank" button path (`resync_all_completed_deals`), presented as review-and-confirm (old date → new date per deal), never a silent migration. Also normalise the two `completed_at` formats (21 bare dates, 11 with T00:00:00Z) in the same confirmed pass. NOTE: v0.15.137 wired `resync_completed_deal` into settles — re-verify how many deals still carry stale dates before quoting $47,920.
2. **Overdue card**: read `status IN ('sent','overdue')` everywhere the card queries (desktop + mobile twin + server dashboard).
3. **Month labels one-early**: every `new Date("YYYY-MM-01")` in Brief/dashboard paths → local-parse helper (`parseDay` precedent from R-116). Desktop + mobile twin.
4. **Loss card refund-aware**: use the same refund-netted net as the adjacent figure.
5. Remaining B/C/D findings per audit §E order, each verified-still-present first.
GATED: the "which figure is revenue" decision (invoice face by `paid_at` vs deal gross by `completed_at`, $83k apart) — surface to Jack with the audit's recommendation; steps 1–4 do not depend on it.

## §WS4 — FINANCIALS REMAINDER (R-013 leftovers). 

Read FIRST: `FINANCIALS-AUDIT-2026-08-04.md` STATUS block (rounds 1–6 landed a lot — trust the STATUS block, then re-verify in code; do NOT redo fixed items). Known-open highlights:
1. **C1–C9 Plaid-green-for-everyone**: server GET status endpoint (org-scoped, reads `plaid_items` the desktop already POSTs) in a NEW deployable module — never `routes/plaid.rs`; desktop + mobile render "Bank connected · N" from it. GATED: `CLIENTHUB_SECRET_KEY`/`PLAID_TOKEN_KEY` in the droplet unit (Jack approves the values; WS1 §3's env file is where they go — pair the deploys).
2. **B2**: `bank_txn_deleted_backup` recovery copies stay device-local by design — decide (GATED, recommend keep-local) or document as decision.
3. **Reserves draw-down** (`reserve_entry` no reader/writer; free cash stopped subtracting reserves in v0.15.136): implement Jack's chosen model — R-143(dup) says he wants a real Plaid reserve *account* designated by `persistent_account_id` (NEVER per-connection account_id), excluded from both `bank_balance` AND free cash. Coordinate with the R-142 session which captured it.
4. **Server `modified` array**: desktop handles amendments; server mirror doesn't — mirror it in the undeployed `plaid.rs` only (keeps the Phase-4 landmine defused; still never deploy).
5. **`with_pending_ref` canary**: confirm >0 on Jack's live feed post-v0.15.139; if 0, escalate — the settle carry is inert for his institutions.

## §WS5 — INVENTORY (R-014, decided and deprioritised — now due).

Read: `INVENTORY-AUDIT-2026-08-04.md` (INV-1..8) + request row. INV-1 shipped v0.15.128. Jack's decision stands: any sale marks the WHOLE lot sold and pulls it from storefront + website; partials do not keep it listed.
1. **INV-2 backfill**: the 8 lots he marked sold that are still live — review-and-confirm list → set `status='sold'` via oplog. Verify storefront JSON + BJM site no longer serve them.
2. **Auto-mark-sold on deal completion**: deal→lot link is the gap (0 `linked_deal_id` live). Minimal: a lot picker on the complete-deal step (optional, skippable) that marks sold. No quantity decrement engine — explicitly out per his rule.
3. Remaining INV findings per audit, each re-verified.
Surfaces: desktop + server + storefront (`www/shop.html`) + BJM website (separate repo, no remote, `npx vercel --prod`).

## §WS6 — TRANSACTION INTEGRITY (R-019 then R-002). Phased; C is the dangerous one.

Read FIRST: `FINANCIALS-PLAN.md` (phases + hold-and-ask design + the 43%/91% reference measurements), `revisit/dormant-canonical-txn-id`, architecture/financials §id schemes.
- **A (R-019 detect)**: running-balance tie-out per account using the existing `reconcile_accounts` `implied_opening` (shipped 602fc49) — surface drift on Overview as a per-account "ledger ties to balance ±$X" line; monthly statement tie-out screen (statement total vs ledger total per account+month). No silent skips: every dedupe/skip/dead-letter decision lands in a reviewable list (extend the existing dedupe review surface), never only a log line.
- **B (R-019 alert)**: nightly (on-open) check that yesterday's balance delta equals ledger net per account; toast + Brief line on mismatch.
- **C (R-002 identity, GATED on Jack + solo)**: wire `canonical_bank_txn_id` for NEW writes only across all writers (desktop plaid/import/cash; server mirror), alias-map old ids, hold-and-ask queue for the 57%-of-rows/9%-of-dollars referenceless tail. **NEVER rewrite the ~1,300 existing ids.** Own release, nothing else in it, live-DB measured before/after, rollback = the alias map is additive.

## §WS7 — CHEAP HONESTY CLEANUPS (backlog #10–#13, #15 + Mac leftover). Batchable into any release.

1. **#10** one version constant for mobile: sw CACHE, `?v=`, `BUILD` string derived together (a tiny stamp script the deploy step runs — there is no build step).
2. **#11** delete dead `loadDealFlows` renderer in `app.js` (one IIFE — do not overrun the closing brace).
3. **#12** remove `HealthView` import + both dead desktop views (`HealthView.tsx`, `DealsView.tsx`); do not touch the `health` tab id (Tiers owns it).
4. **#13** replace `.expect()` in `list_client_invoices` (+ grep for siblings) with error returns; check the mobile call site's response-shape assumptions first.
5. **#15** deploy-script greps: assert on code shapes that fail when logic is deleted; keep + copy forward the `test -f src/routes/plaid.rs` negative assertion.
6. **`secret_store.rs` stopgap** (Mac note): Developer ID shipped, the on-disk-key justification is gone — restore keyring path (fallback intact at `email.rs:23-26`) or rewrite the rationale. GATED (small): Jack picks restore vs document; recommend restore.

## §WS8 — MOBILE (R-001 + R-009 + R-010 + R-006 + backlog #16 #17 #23; then R-003/R-004).

Read FIRST: `parity-model`, `architecture/mobile`, `PARITY-PLAN.md`, `MOBILE-REDESIGN-PLAN.md`, R-146 row (another session may have claimed parity — check `list_sessions` before starting). Rules that bind every step: merge-on-write (COALESCE per column, sync the merged row read back), REST writes must emit oplog events, mobile forms never write columns they don't render.
- **A — Mobile financials read-only** (R-001 phase 1): server endpoints for `bank_txn` list + summary + per-deal allocations (org-scoped, guarded SUMs, `json_valid()` on raw_json); PWA "Money" screen: To book list + ledger, day groups, needs-line — mirroring desktop's booking-row rule. Includes WS2 §3 refund list fix. No writes yet.
- **B — Mobile booking** (R-001 phase 2): set category/reviewed + allocate/split via endpoints that re-enforce `allocate_bank_txn`'s three guards server-side (sum ≤ txn, exclusivity, role×direction) — the desktop Rust guards do NOT protect REST paths. Booking memory suggestions ride along (rules are synced now).
- **C — R-009 record payment** + **R-010 reopen completed deal** (drawer action, refund-less deals only) + fix the server `mark_invoice_paid` gap (doesn't advance `deal_flows` like desktop — R-132 finding).
- **D — R-006 camera capture**: the server endpoint exists unused; wire `<input type="file" capture>` → existing media upload → lot photos. Also the Apple 4.2 answer.
- **E — #16 rename the two "Deals"** (GATED: Jack picks names; must match desktop sidebar) and **#17 extract `openLotDetail()`** (closure over pricing helpers must move intact).
- **F — #23 history/back** (tier 3, solo agent): tab-level `history.pushState` first (back = previous tab, exit only from root), panels pushed as one state each; ~40 `panel.remove()` sites must pop exactly once — audit each. Per-record URLs are a later phase. Get this wrong and back is worse than quitting; verify on Android.
- **G — R-003/R-004 server-owned feed** (FINANCIALS-PLAN phase 4; GATED, last, huge): server Plaid becomes THE importer in the same release that removes the desktop writer; migration of `plaid_items` custody; webhook + polling; desktop/mobile become readers. Requires WS6-C done (identity) + WS1 interlocks + Jack's go. Never as an addition to the desktop writer.

## §WS9 — SMALL FEATURES
1. **R-008 newsletter defaults**: org-synced defaults (greeting, signature, footer, colours) applied to ALL newsletter composition paths (desktop + mobile + scheduler); per-send override wins; `No-bulk`/unsubscribed filters untouched (both column AND metadata — gotcha).
2. **R-011 damaged-data repair** (GATED on D-7): only if Jack says go — oplog/backup archaeology for stripped `kept` flags + wiped supplier metadata; findings as review-and-confirm, never silent writes.
3. **R-132 fold Money movement** (GATED: Jack approves the recommendation): SECTIONS 5→4, surviving controls into "Link financials" reading amounts from linked txns; fix `write_sp` vs `resync` column mismatch (`total_supplier_cost` vs `total_cost`) noted in the investigation; server `mark_invoice_paid` gap goes with WS8-C.

## §WS10 — STOREFRONT (R-123, GATED on Jack's re-ask)
He judged the pre-deploy page; the light rebuild is live since deploy-35. First action: screenshot the live storefront, ask what still reads as not-sharp. Keep "Powered by Ecliptr" visible. His two settings to fix himself: `storefront_title` caps, accent colour. No code before his answer.

## §WS11 — TOOLCHAIN (R-134). Run EARLY in parallel with WS1 — it protects everything after.
Read: `requests/R-134-setup-and-toolchain`. In order of leverage:
1. **CI on push** (both repos): `tsc --noEmit` + `cargo check` + `cargo test --bin clienthub` on every push to main. NOT deploy — check only (WS1 killed the deploy landmine).
2. **Bundle**: `React.lazy` GlobeView (+ recharts screens) — the 3.5 MB chunk parses at every launch today; add `build.rollupOptions` manualChunks.
3. **Lint/format**: eslint + prettier + rustfmt configs, CI-enforced warn-only first pass.
4. **Design tokens**: CI grep failing on raw hex in `src/components/`.
5. **Deploy provenance**: `/health` returns `{version, built_at, git_sha}`; deploy script stamps it — kills the "did it land" class.
6. **Repo hygiene** (GATED prune list): move stale root .md files to `docs/archive/` (never delete), reconcile the two version sources, prune the 4 agent-leftover branches (list to Jack first).
7. **The cadence rule** (this is the actual ask): every release carries ≥1 tier-1 backlog item; no new audit until the previous is burned down. Encode it in `CLAUDE.md`.

## §WS12 — EXPLICITLY NOT IN THIS PLAN (entry criteria only)
- **#24 DB pool**: only when a second real tenant exists. Entry: paying tenant #2.
- **#25 `apply_upsert` OR-IGNORE semantics**: only as a solo, both-engines matched design with divergence accounting. Entry: next constraint-stall incident, or the sync engine gets a dedicated hardening week.
- **#26 commands.rs split**: mechanical per-domain moves, counting registered handlers before/after. Entry: after WS2+WS4 land (fewer in-flight edits), one domain per release.
- **R-005 native apps**: R-122 session owns.

---

## §DECISIONS — collect for Jack in ONE sitting (each blocks only its marked step)
1. Brief revenue basis: invoice-by-`paid_at` vs deal-gross-by-`completed_at` (WS3; $83k apart). Audit recommends deal-gross for the Brief; dashboards state their basis either way.
2. Droplet env secrets: approve moving + rotating SMTP/backup passphrase; supply Plaid token key for C1-C9 (WS1/WS4).
3. Reserves: confirm the Plaid-reserve-account model (WS4 §3, coordinate with R-142 session).
4. D-7 damaged-data repair: go/no-go (WS9 §2).
5. Mobile "Deals" naming (WS8-E).
6. R-132 fold: approve recommendation (WS9 §3).
7. Storefront re-ask (WS10) + his own two settings.
8. Root-docs prune list + branch deletions (WS11 §6).
9. Older parity decisions (decisions/README "Still open"): tier revenue basis (subsumed by #1), portal token sync, lead_status vocabulary, one "Outstanding" definition, Brief headline, stale-listing-reject-marks-sold.
10. WS6-C identity wiring go (after A+B prove detection clean).

## §SEQUENCE + CONCURRENCY
- Order: **WS1 + WS11(1,2,5) first** → WS2 → WS3 → WS4/WS5/WS7 (parallelizable — different surfaces/files) → WS6-A/B → WS8-A..F (mobile is `app.js`+server routes; parallel-safe with desktop WS) → WS9 → WS6-C (solo) → WS8-G (solo, last).
- Hot files — one owner at a time: `commands.rs`, `FinancialsView.tsx`, `api.ts`, both `sync.rs`, `app.js`, `main.rs` (both). Orchestrator assigns file locks per WS.
- One release per WS chunk, released before the next chunk starts (the "work that never shipped" failure is the #1 recurring loss — a chunk is DONE when the tag is published / deploy-log row exists / vercel prod verified).
- Each money-touching agent ends with: live-DB before/after measurement, expected-zero-drift asserted, and the vault note bumped.

## §WORKFLOW SHAPE (for the orchestrator)
Per WS: (1) a scout agent re-verifies every claim in this plan against current code — line numbers rot within days here, and concurrent sessions land fixes continuously; anything already fixed gets skipped and reported, not redone; (2) implementation agents with file locks; (3) an adversarial verify agent per money change (try to refute: double-count, clock-stamp, org-scope, guard-missing); (4) a release/deploy agent that runs §0.6–0.7 and refuses to report done without published-tag/deploy-log proof.
