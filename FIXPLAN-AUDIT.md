# FIXPLAN — Data accuracy, analytics, financials, notes (2026-07-15 audit)

Source: 6-agent grounded audit of the live codebase + live DB checks. Every claim below was
verified against code with file:line evidence; the full findings are in the appendix at the
bottom of this file. Follow CLAUDE.md: surgical changes, simplicity first, verify each step.

**Ground rules for every fix in this plan (the "bulletproof data" contract):**
1. A stat NEVER counts archived deal_flows (`COALESCE(df.archived,0)=0`).
2. A stat NEVER counts fell-through deals (invoice `voided=1`) or archived invoices —
   join invoices and exclude, mirroring `list_deal_flows` (commands.rs:3801).
3. A stat NEVER double-counts duplicate deal_flow rows — one survivor row per invoice_id
   (highest stage, newest tie-break; same rank rule as `reattach_orphaned_deal_allocations`).
4. Refunds REDUCE profit (locked P&L rule). The one correct counting formula is
   `refund_status_all`'s: non-bank-linked `refunds` rows + ALL `bank_allocation role='refund_out'`
   (bank-linked refunds live in both tables; count them once via the allocation side).
5. "Invoices sent" is ALWAYS tracked: sent = status IN ('sent','overdue','paid'); a voided
   invoice keeps its history visible (bucketed as `void`), never silently vanishes.
6. Every synced mutation: `sync::record_upsert`/`record_delete` + `netsync::push_now()`.
7. Server schema first: any new column must be added to the droplet backfill list
   (`/home/ecliptr/clienthub-api/src/sync.rs`, `for stmt in [...]` ~line 457) AND committed to
   the clienthub-api repo (`employees.rs` idempotent ALTERs + `schema.sql`) BEFORE the desktop
   ships events carrying it — the server apply is NOT drift-tolerant.

---

## DONE in this session (v0.15.72 work, executed by Claude)

- Brief: deals closed / win % re-sourced from deal_flows + voided invoices (was: dead `deals`
  CRM table → permanently 0). Migration 68 `invoices.voided_at`, stamped by `set_invoice_void`;
  droplet already has the column.
- Brief: all deal_flow stats exclude archived + fell-through (voided-invoice) deals; profit is
  refund-aware everywhere (hero, payout boxes, MTD); rep-scoped closed/lost.
- Ghost cleanup: one-time synced repair archiving duplicate non-survivor deal_flow rows and
  orphan flows (invoice deleted) — the root cause behind "56 open deals" vs the true 7.
- dashboard_stats: `open_deals` deduped + inner-join; invoice count/status made consistent
  (voided invoices bucketed as `void`, always visible).
- get_analytics_range: archived/voided filters, per-invoice dedup, refund-aware profit,
  parameterized dates, weighted margin.
- Analytics page rebuilt as a full dashboard (see AnalyticsView.tsx) on the corrected numbers.
- Financials: rule-with-blank-category mass-wipe fixed (frontend validate + backend guard);
  refund_liability double-subtract of bank-linked refunds fixed.

## HANDOFF — remaining work, in priority order

### Phase 1 — Client tier stats correctness (owner-reported) — DONE v0.15.73
Shipped: extracted one shared `tier_for()` + `refunded_by_client()` + `CLIENT_REFUNDED_SQL`
(no more duplicated thresholds). buyer_tiers + build_client_tier_map net refunds out of
`actual_paid`/`net_paid`, count invoices_sent as sent/overdue/paid, and gate the margin query
(archived/voided/archived-invoice excluded). tier_rank fixed to codes (tier_drop + tier_history
now fire). list_clients/get_client total_revenue = MAX(0, paid − refunds). ClientDetailView
outstanding/paid exclude voided, revenue trusts total_revenue, profit deduped by invoice,
"Invoices sent" = real sent count. TiersView colSpan 9. Verified on live DB: Kameron S→A
(refund-netted), Tyler Cobb no phantom revenue, overdue counts as sent.
Original per-item detail (kept for reference):

1.1 **Refund-aware tiers (CRITICAL)** — `buyer_tiers()` (~8692) and `build_client_tier_map`
    (~1646) compute `actual_paid` from paid invoices with zero refund awareness; a fully
    refunded client keeps Diamond. Build a per-client refunded map (rule 4 formula, joined
    refunds→deal_flows→invoices→client) and subtract from `actual_paid` BEFORE tier thresholds.
    Same subtraction for `Client.total_revenue` subqueries (list_clients ~154/158, get_client
    ~225/229). Verify: a client with one fully-refunded paid invoice shows ~$0 revenue and
    drops tiers.

1.2 **Sent-invoice tracking (MAJOR)** — invoices_sent in both tier paths counts only
    ('sent','paid'); add 'overdue' (commands.rs:8698-8699, 1650). ClientDetailView "Invoices
    sent"/"Orders" tiles render `invoice_count` which is PAID-only (get_client ~225) — add a
    real sent-count field (status IN sent/overdue/paid) and use it. Product decision to
    surface to Jack: whether voided invoices should still count in a separate "sent history"
    number (rule 5 suggests yes, as a distinct counter).

1.3 **Stat gating (MAJOR)** — commission_map in buyer_tiers (~8732) lacks archived/voided/dedup
    filters (rules 1-3). ClientDetailView: Paid/Outstanding/Revenue-fallback include voided
    invoices (list_invoices_for_client ~1967 filters archived only — filter voided in the tile
    math); Profit tile double-counts duplicate flows (dedupe by invoice like DealFlowView, or
    move to a backend query). NOTE: the ghost cleanup shipped in v0.15.72 makes dedup
    belt-and-suspenders, but keep the filters so future duplicates can't regress it.

1.4 **tier_drop automation dead (MAJOR)** — tier_rank matches labels 'Diamond'/'Gold'… but
    tiers are stored as codes 'S'/'A'/'B'/'C' (commands.rs:7704 vs 1690). Change tier_rank to
    match codes. This also un-deadens tier_history. Verify: force a tier drop, row appears.

1.5 Minor: TiersView empty-state colSpan 8→9 (TiersView.tsx:178).

### Phase 2 — Financials engine hardening (Free Cash to the cent) — CORE DONE v0.15.74
Shipped: 2.1 frozen bank balance now refreshed each plaid_sync via /accounts/get (Free Cash
tracks reality, not link day); 2.2 reserves + supplier_payables exclude archived/fell-through +
refund-net the reserve bases; 2.3 deal_reconciliation refund = refund_out + non-bank-linked
refunds (was max(), undercounted); 2.5 plaid_exchange dedups on item_id (relink no longer
doubles balance); 2.4 plaid_sync no longer advances the cursor past a failed row (no more
permanent txn loss); 2.6 archived-deal allocations excluded from unallocated pickers +
allocated_actuals (lossless-restore preserved — allocations not deleted); 2.7 deal_flow_payout
refund-aware (rule_4). Minors: AI-categorize only pulls uncategorized rows (no 25-call loops);
clear_bank_txns push_now; refreshAll re-fetches deals. Verified on live DB: refund_liability
$12,890 (real owed-back), reserve/payable/actuals guards confirmed.
STILL OPEN (deferred): 2.8 loans UX (toasts, reopen, received_at, mark-paid confirm),
free-cash Adjust manual-vs-live, bank_txn_summary transfer/card double-count, rule busy state,
new-deal-from-txn direction guard, bulk-allocate ghost dedup + failure reasons, Plaid
env-switch/prepare-banner/poll-tolerance; 2.9 half-built (runway/business_expense,
refund_in/adjustment roles, cash_purchase/reserve_entry, loan.bank_txn_id, Plaid remove-vs-secret).
Original per-item detail (kept for reference):
2.1 **Free Cash bank balance frozen at link time (CRITICAL)** — plaid_items.accounts_json is
    written once and never refreshed; plaid.rs has no balance call. Implement
    `/accounts/balance/get` in plaid.rs, refresh in plaid_sync + plaid_refresh_sync, UPDATE
    accounts_json. Until then the headline diverges daily. Verify: move money at the bank,
    Sync now, Free cash moves.

2.2 **Reserves/payables gating (MAJOR)** — financials_overview: tax/refund reserves (~10600)
    and supplier_payables (~10569) and the refund-deals alert (~10624) violate rules 1-4.
    Build one shared survivor-CTE (live, deduped, non-voided deal set) and run all three
    aggregates against it; subtract refunds from reserve profit.

2.3 **deal_reconciliation refund undercount (MAJOR)** — replace `max(refund_out, refunds)`
    (~10002) with the rule-4 split-sum so it agrees with refund_status_all.

2.4 **plaid_sync cursor loss (MAJOR)** — on any per-row persist failure it still advances the
    cursor (~10437) → permanent txn loss. On failure: status='error', break BEFORE cursor
    persist; INSERT OR IGNORE makes the retry safe.

2.5 **plaid_exchange item dedup (MAJOR)** — mirrors plaid_connect_poll's `SELECT 1 FROM
    plaid_items WHERE item_id=?` guard; without it relinking doubles the balance.

2.6 **Archived deals strand allocations (MAJOR)** — delete_deal_flow leaves bank_allocation
    rows: txns blocked from every picker + still counted in allocated_actuals. In
    delete_deal_flow, record_delete each allocation (frees the txns); add a heal for existing
    strands.

2.7 **deal_flow_payout refund blindness (MINOR)** — rule-4 formula instead of refunds-table-only
    (~4714), so rep cuts/owner splits respect Financials-paired refunds.

2.8 Minors, all small: bank_txn_summary excludes internal_transfer/card_payment from sum_in/out;
    clear_bank_txns push_now; delete_loan cleans rules+tags; LoansView error toasts everywhere
    (LoansView.tsx:93+); loan reopen button + confirm on Mark paid; loan received_at editable;
    deal picker refresh in refreshAll; AI-categorize candidate query adds
    `AND COALESCE(category,'')=''` (commands.rs:~10749) so the loop can't burn 25 calls on the
    same 40 rows; "New deal from this transaction" gated to money-in + reuse existing client by
    name + cleanup on failure; bulk allocate modal uses the survivor dedup helper; bulk failures
    report reasons; Plaid preparing-banner exhaustion clears; poll tolerates transient errors;
    free-cash Adjust modal disables manual balance fields when Plaid connected (expose
    has_plaid in financials_overview).

2.9 Half-built to finish or delete (decide with Jack): runway/business_expense (no writer —
    derive opex from categorized money-out or drop the light); refund_in/adjustment roles
    (include refund_in as supplier-cost offset in reconciliation or remove from picker);
    cash_purchase/reserve_entry dead tables; txn_rule.role unused; loan.bank_txn_id auto-tag
    on create; Plaid remove-item vs org-secret resurrect (delete server secret on removal);
    free-cash aging alerts → deep-link to the filtered Transactions view; rules are
    device-local — say so in UI or move txn_rule into the synced schema.

### Phase 3 — Notes section upgrades (owner asks 1-4) — 3a DONE v0.15.75; edit-lock (3.3) REMAINS
Shipped 3a: 3.1 font scales with note size (√area, clamped); 3.2 near-live via new pull_now
command (NotesView polls every 5s + on focus); 3.4 bug fixes — deleted notes no longer
resurrect (pendingCreates set gates the merge re-add), debounced body edit flushed on unmount +
cancelled on delete, updated_at bumped on color/pin/move/resize so a concurrent pull can't
revert them, LWW compares epoch ms not raw strings. STILL TODO: 3.3 edit-lock (needs migration
69 editing_by/editing_at + droplet backfill + clienthub-api repo commit of w/h AND the lock
columns + server routes + lock UI) and 3.4e commit the server w/h schema to the clienthub-api
repo (droplet is hand-patched only). 3.5 polish (bring-to-front, cap resize at board width,
styled confirm) optional.
Original per-item detail (kept for reference):
3.1 **Font scales with size (ask 1)** — frontend-only: per-note
    `scale = min(1.8, sqrt((w*h)/(226*190)))`, apply `fontSize: 13.5*scale` (+ line-height) to
    the textarea (NotesView.tsx ~228). Live during resize for free; peers derive the same size
    from synced w/h.

3.2 **Live to all systems (ask 2)** — permissions already open to all org users (verified).
    Liveness: sender pushes instantly but peers pull on a 20s tick. Add `pull_now()` beside
    push_now (netsync.rs:318) exposed as a tauri command; NotesView calls it every ~5s while
    mounted + on window focus. Mobile PWA (clienthub-api/www/app.js:879-922): re-fetch on
    visibilitychange/interval; add pin control; add w/h to /api/notes (routes/notes.rs:37-55
    SELECT + NoteInput) once the server schema carries them.

3.3 **Edit lock (ask 3)** — two synced columns (migration 69): `notes.editing_by`,
    `notes.editing_at` (+ droplet backfill + clienthub-api employees.rs/schema.sql per rule 7).
    Acquire on textarea focus (update_note + push_now), renew throttled ~30s on the body
    debounce, release on blur/unmount/delete. Peers: if inc.editing_by is someone else and
    now-editing_at < ~75s TTL → textarea readOnly + "<name> is editing" chip, incoming copy
    wins merges. Advisory lock; pair with 3.2's pull_now to shrink the race to ~5s. Use
    account id + display name, not display name alone. Do NOT use the settings table (server
    push whitelist excludes it — proven dead end).

3.4 **Bugs (fix with the above)** — (a) remotely deleted notes resurrect until remount:
    track a pendingCreates set; only re-add prev notes in that set (NotesView.tsx:82).
    (b) pending 600ms body edit lost on tab switch + delete doesn't cancel pending save:
    unmount cleanup flushes timers; remove() clears its timer first (NotesView.tsx:158,171).
    (c) color/pin/move/resize saves don't bump local updated_at → sync merge can visually
    revert them; stamp updated_at in those handlers (NotesView.tsx:79 area).
    (d) LWW compare mixes 'Z' vs '+00:00' formats — compare epoch ms.
    (e) COMMIT the server w/h schema to the clienthub-api repo (employees.rs ALTERs +
    schema.sql) — today resize sync survives only via the hand-patched droplet; a repo
    redeploy would silently eat resize events. Longer-term: port the desktop's
    existing_columns drift filter into server apply_upsert.

3.5 Polish: bring-to-front on touch (lastTouched zIndex), cap resize at board width, styled
    confirm instead of native confirm(), optional cleanup of abandoned empty notes.

### Phase 4 — Analytics leftovers
4.1 Excel export: voided filter on Top Clients sheet, group revenue by paid_at, replace dead
    deals-table Pipeline sheet with deal_flows stage counts (commands.rs ~1281,1258,1303).
4.2 Brief highlights (best/worst margin) still read dead deals.won_at (~9068,9080) — re-source
    from completed deal_flows in window or drop the cards.
4.3 Decide: port pipeline_analytics funnel to deal_flows+quotes and render it, or delete the
    dead command + deals-table stats (pipeline_value/count) + orphaned DealsView import.
4.4 Historical brief periods: several queries lower-bound only (>= week_start with no upper) —
    audit lists them; add `< end_excl`.

### Phase 5 — Sync invariants (bulletproofing, lower urgency)
5.1 Allocation invariants are local-only; concurrent devices can exceed a txn's amount or
    double-link. Add a post-sync heal (find SUM(allocations)>amount+ε or multi-deal links
    without split) — pattern already exists in reattach_orphaned_deal_allocations.
5.2 Desktop SNAPSHOT_TABLES still omits financial tables → Repair sync can't heal them
    (known deferred item; needs server+desktop matched deploy).

---

## Verification protocol (apply to every phase)
- `npm run build` + `cargo check --release` clean before any commit.
- For stat fixes: write the expected number by hand from the DB first (python sqlite3
  read-only), then confirm the UI matches. The live DB is at
  `%APPDATA%/com.bjmdistributions.clienthub/clienthub.db` (open read-only!).
- For sync-visible changes: verify the droplet schema BEFORE shipping the desktop tag
  (rule 7), then journalctl for apply/replay errors after restart.
- Ship via tauri.conf.json bump + tag push (see brokr-release-pipeline memory).


---

# APPENDIX — full audit findings (verbatim, file:line evidence)

## Brief (BriefView.tsx + generate_weekly_brief command)

**How it works today:** The Brief is a periodic report: BriefView.tsx calls generate_weekly_brief (commands.rs:8898), which computes a rolling N-day window and fills a WeeklyBrief struct from local SQLite. Money stats (Revenue/Profit/completed/payouts) come from deal_flows stage='complete', but "Deals closed", "X lost", and "Win rate" in the committed build come from the SEPARATE deals CRM table (lead/quoted/negotiating/won/lost) via won_at/lost_at — and nothing in the shipped app ever writes those: the only writer is update_deal_stage (commands.rs:3198), whose only frontend caller is DealsView.tsx, a kanban that is imported in App.tsx:43 but never rendered (the "deals" tab renders CloseoutView at App.tsx:512). The real workflow (invoice -> deal_flow invoiced->payment_received->supplier_paid->complete; "lost" = invoice voided via set_deal_flow_fell_through, commands.rs:5121) never touches deals.stage, so the owner-reported symptom is exact: Deals closed = 0, 0 lost, Win rate = 0% forever. IMPORTANT: the working tree already contains an UNCOMMITTED in-flight fix (another session, mid-edit while I audited): db.rs migration 68 adds invoices.voided_at, set_invoice_void stamps it, deals_closed/deals_lost are re-sourced to completed deal_flows (COUNT DISTINCT invoice_id, archived-filtered, window-bounded) and voided invoices, and all brief deal_flows aggregates gained an archived filter ({live}, commands.rs:8934) plus refund-aware net profit ({np}, commands.rs:8935). That fix resolves the root cause but leaves real gaps I list below: closed/lost ignore the sales-rep filter, fell-through (voided) completed deals count as both closed AND lost and stay in Revenue, non-hero aggregates are still not deduped against the 28 known ghost deal_flow rows, and the Best/Lowest-margin highlight cards still read the dead deals.won_at so they never render. Overall health: money numbers are now largely right in the working tree; the closed/lost/win-rate cell goes from "always zero" to "mostly right with edge-case double counting", and several payload fields (deals_by_stage, pipeline_value, stuck_deals, at_risk_customers) are computed from the dead deals table and never rendered by BriefView at all.

**Data flow:** BriefView.tsx:41-49 load() -> api.generateWeeklyBrief (src/lib/api.ts:1915) -> Tauri invoke("generate_weekly_brief") -> commands.rs:8898. Window: rolling period_days (settings key brief_frequency_days, commands.rs:8915-8920) ending on anchor date; week_start/end_excl at 8922-8924; rep scoping via rep_join/rep_filter (8903-8904) when BriefView.tsx:44 passes repName for sales reps. Sources: Revenue/Profit hero = SUM(gross_revenue)/SUM(refund-aware net) over deal_flows stage='complete' by completed_at (8937-8948); "N deals completed" badge + payout boxes = same table (8961-8965, 8995-9019); Deals closed = (working tree) COUNT(DISTINCT invoice_id) of completed non-archived flows (9040-9044), previously COUNT(*) FROM deals WHERE won_at >= week_start; Deals lost = (working tree) invoices voided in window via new voided_at (9045-9048, db.rs migration 68), previously deals.lost_at; Win rate = closed/(closed+lost)*100 (9049), rendered with toFixed(0) at BriefView.tsx:180. Highlights: best/worst margin still from deals.won_at (9068, 9080 — dead), biggest invoice from invoices status='paid' (9091). Activity: clients/interactions created_at >= week_start only (9110, 9114). Refund warning box: refunds JOIN deal_flows by completed_at window (9118-9121). Frontend does no math beyond percent formatting (BriefView.tsx:79-83, 176-181).

### [CRITICAL] Deals closed / Win rate read deals.won_at-lost_at which the shipped app never writes (root cause: always 0 / 0%)
- Where: src-tauri/src/commands.rs:9040
- Root cause: Committed build: deals_closed = SELECT COUNT(*) FROM deals WHERE won_at >= week_start; deals_lost same on lost_at; win_rate = closed/(closed+lost)*100 else 0 (now commands.rs:9049). The ONLY writer of won_at/lost_at is update_deal_stage (commands.rs:3198; won_at insert at 3210), whose only frontend caller is DealsView.tsx:61/66/73 — and DealsView is imported (App.tsx:43) but never rendered: the "deals" tab renders CloseoutView (App.tsx:512, nav label "Completed" at App.tsx:415). The real pipeline is deal_flows (invoiced->payment_received->supplier_paid->complete via complete_deal_flow commands.rs:4170); quotes create invoices directly (QuotesView.tsx:79). So won_at/lost_at are NULL for every deal in normal use -> hero cell renders "0" closed, "0 lost", "0%" (BriefView.tsx:179-180). AN UNCOMMITTED WORKING-TREE FIX (concurrent session) already re-sources closed=completed deal_flows COUNT(DISTINCT invoice_id) (commands.rs:9040-9044) and lost=invoices voided in window via new voided_at (9045-9048, db.rs migration 68, set_invoice_void stamps it).
- Fix: Land the in-flight working-tree fix (commands.rs deals_closed/deals_lost rewrite + db.rs migration 68 + set_invoice_void voided_at stamp) after closing the gaps below; do NOT revert to the deals table. Alternatively delete the orphaned DealsView import (App.tsx:43) and the dead won/lost concept entirely.

### [MAJOR] New deals_closed/deals_lost ignore the sales-rep filter — a rep's brief shows org-wide closed/lost/win% beside rep-scoped revenue/profit
- Where: src-tauri/src/commands.rs:9040
- Root cause: BriefView.tsx:44 passes repName when currentUser.role==='sales_rep', and every money query applies {rep_join}/{rep_filter} (commands.rs:8938, 8946). But the rewritten deals_closed (commands.rs:9040-9044) and deals_lost (9045-9048) have no rep_join/rep_filter — they count ALL completed flows and ALL voided invoices. A rep viewing their brief sees company-wide "Deals closed" and "Win rate" next to their personal Revenue/Profit.
- Fix: Add {rep_join}{rep_filter} to deals_closed (join invoices i ON i.id=df.invoice_id JOIN clients c ...), and scope deals_lost by joining clients through the voided invoice (JOIN clients c ON c.id=invoices.client_id) with the same rep_filter.

### [MAJOR] Fell-through (voided) completed deals count as BOTH closed and lost, and their revenue/profit still count as won
- Where: src-tauri/src/commands.rs:9040
- Root cause: set_deal_flow_fell_through (commands.rs:5121-5129) only voids the invoice — the deal_flow keeps stage='complete' and completed_at. None of the brief's deal_flows queries check the invoice: deals_closed (9040-9044), revenue (8937-8940), profit (8945-8948), completed badge (8961-8965), payout splits (8997-9008) filter only df.archived, never invoices.voided/archived. Contrast list_deal_flows which explicitly excludes them (commands.rs:3801, 3813: COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0). Failure: complete a deal, then mark it fell-through in the same period -> it counts in deals_closed AND (with the new voided_at) in deals_lost, win% is double-counted, and its full gross_revenue stays in the Revenue hero even though the deal died. A fully refunded deal similarly keeps its gross_revenue in Revenue (only profit is refund-adjusted via {np} at 8935).
- Fix: Append AND NOT EXISTS (SELECT 1 FROM invoices iv WHERE iv.id=df.invoice_id AND (COALESCE(iv.voided,0)=1 OR COALESCE(iv.archived,0)=1)) to deals_closed and to every stage='complete' aggregate in generate_weekly_brief (revenue, profit, badge, splits, avg margin), matching list_deal_flows semantics.

### [MAJOR] Ghost duplicate deal_flow rows still inflate the completed badge and all SUM aggregates (only the hero count was deduped)
- Where: src-tauri/src/commands.rs:8961
- Root cause: Known issue: 15 invoices carry 28 duplicate non-archived deal_flow rows; DealFlowView dedupes in the UI but the brief does not. The in-flight fix deduped only deals_closed via COUNT(DISTINCT df.invoice_id) (commands.rs:9041). completed_deals_this_week still uses COUNT(*) (commands.rs:8961-8962), df_last_week_count COUNT(*) (8967-8970), and revenue/profit/loss/payout SUMs (8937-8965, 8995-9008) sum every row. If any ghost row is (or gets healed to) stage='complete' with completed_at set, money doubles and the "N deals completed" badge (BriefView.tsx:194) disagrees with the "Deals closed" hero on the same screen.
- Fix: Either clean the 28 ghost rows once (delete/archive duplicates keeping the highest-stage row per invoice_id), or make every brief aggregate read from a deduped subquery, e.g. FROM (SELECT * FROM deal_flows df1 WHERE df1.id = (SELECT df2.id FROM deal_flows df2 WHERE df2.invoice_id=df1.invoice_id AND COALESCE(df2.archived,0)=0 ORDER BY CASE df2.stage WHEN 'complete' THEN 3 ... END DESC LIMIT 1)) df.

### [MINOR] Best/Lowest margin highlight cards never render — still query the dead deals.won_at
- Where: src-tauri/src/commands.rs:9068
- Root cause: best_margin_deal (commands.rs:9064-9068) and worst_margin_deal (9076-9080) still filter WHERE d.won_at >= ?1 on the deals table, whose won_at is never populated (see critical bug). So the "This week's highlights" section (BriefView.tsx:330-363) can only ever show "Biggest invoice" — the two margin cards are permanently absent. Bonus: no upper bound (>= only), so even if won_at existed, historical periods would pick deals from the future of that period.
- Fix: Recompute both highlights from completed deal_flows in the window: SELECT df.id, c.name, COALESCE(df.name, i.number), df.gross_revenue, CASE WHEN df.gross_revenue>0 THEN df.net_profit/df.gross_revenue*100 ELSE 0 END FROM deal_flows df JOIN invoices i ... WHERE df.stage='complete' AND df.completed_at >= ?1 AND df.completed_at < ?2 ORDER BY margin DESC/ASC LIMIT 1.

### [MINOR] Historical brief periods over-count: several queries have a lower date bound only
- Where: src-tauri/src/commands.rs:9110
- Root cause: When the user pages back (BriefView.tsx:62-67 goToPrevWeek passes a past anchor), these queries still use only >= week_start with no < end_excl: new_clients_this_week (commands.rs:9110), interactions_this_week (9114), biggest_invoice (9091: i.issue_date >= ?1), best/worst margin (9068/9080). A brief for three periods ago counts every client/interaction/invoice from then until today, so historical briefs show inflated Activity and wrong highlights.
- Fix: Add AND created_at < ?2 (resp. issue_date < ?2) with end_excl to each of these queries, matching the deal_flows queries.

### [MINOR] Residual refund/anchor inconsistencies in the reworked brief math
- Where: src-tauri/src/commands.rs:8953
- Root cause: (a) deals_lost reads 0 for every period before migration 68 because pre-existing voids have voided_at NULL (db.rs migration 68 comment acknowledges) — past-period Win rate will read 100% whenever closed>0, which the owner may report as still-broken history. (b) avg_margin_this_week (commands.rs:8953-8954) and loss_count/loss_total (8962) use raw net_profit while the Profit hero uses refund-aware {np} (8935) — a deal pushed negative by refunds shows in Profit but not in the "lost money" warning, and the margin sub-label can contradict the Profit figure beside it. (c) month_start uses the real current month (8958: now.format("%Y-%m")), not the anchor month, so the "Month so far" line under payouts is wrong when paging back to a prior month (BriefView.tsx:236-251 also renders the current month name).
- Fix: (a) one-time backfill: UPDATE invoices SET voided_at=COALESCE(voided_at, updated_at-or-issue_date) WHERE COALESCE(voided,0)=1, or accept and document. (b) use {np} in avg_margin and the loss CASE expressions. (c) derive month_start from now_date (the anchor) instead of now.

### [HALF-BUILT] In-flight uncommitted fix for this exact bug (closed/lost/win% re-sourced to deal_flows + voided_at)
- Where: src-tauri/src/commands.rs
- Current state: Working tree only (git diff: commands.rs +19/-3, db.rs +8, migration 68 invoices.voided_at, set_invoice_void stamps voided_at, deals_closed/deals_lost rewritten, {live} archived filter and {np} refund-aware profit added to brief aggregates). Edits were landing WHILE this audit ran — line numbers cited are the working tree as last read.
- To finish: Close the gaps: rep-scope deals_closed/deals_lost, exclude voided/archived invoices from completed aggregates, dedupe the COUNT(*)/SUM aggregates against ghost rows, fix the two highlight queries; then cargo build, verify in-app, commit + version bump.

### [HALF-BUILT] DealsView kanban CRM (lead/quoted/negotiating/won/lost pipeline)
- Where: src/components/DealsView.tsx
- Current state: Fully implemented component and backend (update_deal_stage commands.rs:3198, convert_deal_to_invoice commands.rs:3383 requiring stage='won') but orphaned: imported at App.tsx:43, never rendered — the "deals" tab id maps to CloseoutView (App.tsx:512). The deals table is therefore vestigial, yet the brief still computes deals_by_stage, pipeline_value (commands.rs:9021-9032), stuck_deals and at_risk_customers into the WeeklyBrief payload, none of which BriefView renders.
- To finish: Decide: delete DealsView + the dead WeeklyBrief fields (and stop computing them), or re-expose the kanban in nav and wire deal->invoice->deal_flow so won/lost stays consistent with the deal_flows pipeline.

### [HALF-BUILT] Email brief button
- Where: src/components/BriefView.tsx
- Current state: Stub: clicking Email shows toast "Emailing briefs isn't set up yet — connect email in Settings → Email" (BriefView.tsx:139-141); no send path exists.
- To finish: Render the brief to HTML/PDF and send through the org-shared inbox SMTP config, or remove the button until built.

## Client tier stats (TiersView, TierBadge, ClientsView, ClientDetailView, buyer_tiers/build_client_tier_map backend)

**How it works today:** Tier assignment is computed twice in near-identical form: buyer_tiers() (src-tauri/src/commands.rs:8692-8796, feeds TiersView/ClientsView badges/ClientDetailView chip) and build_client_tier_map (commands.rs:1646-1693, feeds the clients tier filter and the tier_drop automation). Both rank a client S/A/B/C/Prospect from actual_paid (SUM of paid, non-voided, non-archived invoice totals), invoices_sent (COUNT of status IN ('sent','paid')), quotes, and metadata-estimated annual spend. Archived and fell-through (voided) invoices are correctly excluded from actual_paid and tier assignment, and archived deal_flows are excluded from the deal-flow list backing the client Profit tile — that part of the owner's requirement is largely met. The rest is unhealthy: refunds are never subtracted anywhere in the tier/client-revenue layer (a fully refunded deal still counts its full invoice total toward tier and revenue); the avg-margin stat aggregates deal_flows with no archived/voided/dedupe filters at all; ClientDetailView's Paid/Outstanding tiles include fell-through invoices because list_invoices_for_client never filters voided; the client Profit tile double-counts the known duplicate deal_flow ghost rows; "invoices sent" is undercounted in two independent ways (overdue status excluded, and the client-detail tile counts only PAID invoices); and the tier-drop automation is dead code due to a label/code mismatch. Every owner complaint reproduces in the code.

**Data flow:** Tier + per-client stats originate in two Rust paths and three SQL subqueries. (1) buyer_tiers() commands.rs:8692-8796: actual_paid = SUM(invoices.total WHERE status='paid'), invoices_sent = COUNT(status IN ('sent','paid')), last_invoice_date = MAX(issue_date over sent/paid), all filtered COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 (8697-8700); quotes from quotes table (8712-8716); avg_commission_pct = AVG(net_profit/gross_revenue) over deal_flows JOIN invoices WHERE stage='complete' with NO other filters (8732-8744); tier thresholds at 8769-8774 (S: effective_annual>100k or paid>50k; A: eff>50k or paid>20k or paid>5k+sent>=3; B: eff>10k or paid>5k or paid>1k+sent>=1; C: any engagement incl. 1 quote; else Prospect); effective_annual = frequency multiplier x metadata.estimated_annual_spend (8750-8756). Exposed via api.buyerTiers/getBuyerTier to TiersView.tsx (table rows 139-174, summary cards 67-86), ClientsView.tsx (badge 755, sort 174), ClientDetailView.tsx (tier chip 226-282). (2) build_client_tier_map commands.rs:1646-1693 duplicates the thresholds (1685-1689) for the clients tier filter (1636-1640) and tier_drop automation (7703-7731). (3) Client.total_revenue / invoice_count: subqueries in list_clients (commands.rs:154,158) and get_client (225,229) counting/summing only status='paid' non-voided non-archived invoices; rendered as ClientsView Revenue column (778) and ClientDetailView Revenue tile (206, 339) and Orders/"Invoices sent" tiles (341, 366). (4) ClientDetailView frontend math: paid/outstanding reduced client-side from api.listInvoicesForClient (163, 200-205; backend list_invoices_for_client 1967-1989 filters archived only); Profit tile = sum of net_profit over api.listDealFlows() filtered stage='complete' client-side (166-171; backend list_deal_flows 3780-3803 filters df.archived + i.voided + i.archived at 3801 but not duplicates). Refund data (refunds table via create_refund 4366-4403, bank_allocation role='refund_out', deal_flows.refund_owed) is consumed only by the payout/financials layer (e.g. eff_net = net - refunded at 4715-4717) — none of it flows into any tier or client stat.

### [CRITICAL] Refunds never subtract from tier revenue, tier assignment, or client revenue
- Where: src-tauri/src/commands.rs:8697
- Root cause: buyer_tiers() computes actual_paid as SUM(invoices.total WHERE status='paid') (commands.rs:8697-8700) and tier from it (8769-8774); build_client_tier_map does the same (1649-1651, 1685-1689); Client.total_revenue is the same paid-invoice sum (list_clients 158, get_client 229). Refunds are written only to the refunds table / bank_allocation role='refund_out' / deal_flows.refund_owed (create_refund 4366-4403) and never touch the invoice row, and no tier/client query references refunds. So a fully refunded deal whose invoice stays status='paid', voided=0 keeps its full total in TiersView 'Actually paid' (TiersView.tsx:152-154), in tier qualification (can hold a client at Diamond/Gold), in ClientsView Revenue (ClientsView.tsx:778), and in ClientDetailView Revenue (ClientDetailView.tsx:206, 339). The Profit tile (ClientDetailView.tsx:166-171) likewise sums raw deal_flows.net_profit, while the payout engine correctly uses net - refunded (commands.rs:4715-4717) — the tier layer has no refund awareness at all. This is the owner-reported refund bug.
- Fix: Subtract per-client refund totals in both tier computations and the total_revenue subqueries: join refunds r ON r.deal_flow_id=df.id, deal_flows df ON df.invoice_id=i.id grouped by i.client_id, using the double-count rule already established in refund_status_all (non-bank-linked refunds rows + all refund_out bank allocations, commands.rs:10073-10084); reduce actual_paid and total_revenue by that amount before tier thresholds. For the client Profit tile, subtract per-flow refunded from net_profit (mirror eff_net at 4717). Alternatively (simpler policy): void the invoice when a deal is fully refunded, but partial refunds still require the subtraction.

### [MAJOR] Avg margin (commission_map) includes archived deal flows, fell-through/archived invoices, and duplicate ghost rows
- Where: src-tauri/src/commands.rs:8738
- Root cause: The commission_map query in buyer_tiers() (commands.rs:8732-8744) is 'SELECT i.client_id, AVG(net_profit/gross_revenue) FROM deal_flows df JOIN invoices i ... WHERE df.stage = ''complete'' GROUP BY i.client_id' with no COALESCE(df.archived,0)=0, no COALESCE(i.voided,0)=0, no COALESCE(i.archived,0)=0, and no dedupe by invoice_id — contrast the canonical pipeline filter in list_deal_flows (commands.rs:3801). Consequences: a soft-deleted (archived) deal flow, a fell-through deal (voided invoice), or an archived invoice permanently skews the client's 'Avg margin' shown in TiersView (TiersView.tsx:160-171) and the '% margin' chip in ClientDetailView (ClientDetailView.tsx:277-281); each of the 28 known duplicate non-archived deal_flow ghost rows that reached stage='complete' contributes an extra data point to the AVG, shifting it whenever the client has other deals with different margins.
- Fix: Add the standard filters and dedupe to the query: WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0, and dedupe one row per invoice (e.g. GROUP BY df.invoice_id inner select picking MAX(rowid) or highest-stage row) before AVG.

### [MAJOR] ClientDetailView Paid/Outstanding/Revenue-fallback include fell-through (voided) invoices
- Where: src/components/ClientDetailView.tsx:200
- Root cause: list_invoices_for_client (commands.rs:1967-1989) filters only COALESCE(archived,0)=0 — not voided (compare get_client_credit_status at commands.rs:467 which correctly excludes voided). set_invoice_void deliberately leaves status untouched (commands.rs:3013-3030), and set_deal_flow_fell_through routes through it (5121-5129). So in ClientDetailView.tsx a fell-through invoice still counts: outstanding sums status sent/overdue (200-202) — a fell-through sent invoice inflates the 'Outstanding' tile (364) and the Orders 'open' hint (341) forever; paid sums status='paid' (203-205) — a voided paid invoice inflates the 'Paid' tile (365); and revenue = client.total_revenue || paid (206) falls back to the voided-inclusive paid figure whenever total_revenue is 0 (0 is falsy), so a client whose only paid invoice fell through shows its full amount as Revenue (339).
- Fix: Either add AND COALESCE(voided,0)=0 to list_invoices_for_client (if the detail view should not list fell-through invoices), or keep returning them for display but filter in the tile math: invoices.filter(i => !i.voided) before computing outstanding/paid, and change line 206 to use client.total_revenue ?? with an explicitly voided-excluded paid sum.

### [MAJOR] ClientDetailView Profit tile double-counts duplicate deal_flow rows (known 15-invoice ghost issue)
- Where: src/components/ClientDetailView.tsx:166
- Root cause: ClientDetailView.tsx:166-171 computes client profit as flows.filter(f => f.client_id === clientId && f.stage === 'complete').reduce(sum of net_profit) over api.listDealFlows(). The backend (commands.rs:3780-3803) excludes archived flows and voided/archived invoices but returns duplicate non-archived rows per invoice — the known issue (15 invoices, 28 ghosts). DealFlowView dedupes by invoice_id keeping the most-progressed stage (src/components/DealFlowView.tsx:78-109), but ClientDetailView has no dedupe, so any client whose invoice has two stage='complete' rows shows doubled profit in the Profit tile (line 340).
- Fix: Dedupe before reducing, same as DealFlowView: keep one flow per invoice_id (highest stage), then filter stage='complete' and sum net_profit. Better: move this to a backend per-client profit query with GROUP BY invoice_id dedupe so mobile/web inherit the fix.

### [MAJOR] Invoices sent undercounted: 'overdue' status excluded from tier invoices_sent, and the client-detail 'Invoices sent' tile counts only PAID invoices
- Where: src-tauri/src/commands.rs:8698
- Root cause: Two independent violations of 'invoices sent should always be tracked'. (a) 'overdue' is a real invoice status (set at commands.rs:2541-2547) but buyer_tiers counts invoices_sent as COUNT(status IN ('sent','paid')) (8698) and last_invoice_date the same way (8699); build_client_tier_map matches (1650). An invoice that goes overdue — indisputably sent — vanishes from the TiersView Invoices column (TiersView.tsx:155) and from tier qualification: A requires paid>5k AND invoices_sent>=3, B's third branch requires invoices_sent>=1 (commands.rs:8770-8771, 1686-1687), so one invoice flipping to overdue can demote a client a full tier. (b) ClientDetailView's 'Invoices sent' tile (ClientDetailView.tsx:366) and 'Orders' tile (341) render client.invoice_count, which get_client computes as COUNT(*) WHERE status='paid' (commands.rs:225; list_clients 154) — sent-but-unpaid and overdue invoices are not tracked there at all, and the label is simply wrong. Related tension to surface to the owner: voided (fell-through) invoices are also removed from invoices_sent entirely (8700), so the historical fact that an invoice was sent is dropped on fell-through — consistent with 'fell-through shouldn't count toward stats' but inconsistent with 'sent is always tracked'; needs a product decision (e.g. separate sent-history counter).
- Fix: Change both tier queries to COUNT(CASE WHEN status IN ('sent','overdue','paid') THEN 1 END) and the same for MAX(issue_date) (commands.rs:8698-8699 and 1650). For the detail view, either add a real sent-count subquery (status IN ('sent','overdue','paid')) to get_client/list_clients as a new field, or compute the tile from the already-loaded invoices array; at minimum relabel the paid-only tile.

### [MAJOR] tier_drop automation never fires: rank function matches tier labels but tiers are stored/compared as codes
- Where: src-tauri/src/commands.rs:7704
- Root cause: In the automation trigger handler, tier_rank matches 'Diamond'/'Gold'/'Silver'/'Bronze' (commands.rs:7704), but build_client_tier_map returns codes 'S'/'A'/'B'/'C'/'Prospect' (1690) and the stored metadata buyer_tier is written with those same codes (7727-7729, the only writer). Therefore tier_rank(current) and tier_rank(stored) both evaluate to the wildcard 0 for every client, 'stored_rank > current_rank' (7716) is never true, no tier-drop email candidates are ever produced, and tier_history rows (7719-7722) are never inserted from this path — the feature is silently dead.
- Fix: Change tier_rank to match the codes actually stored: match t { "S"=>4, "A"=>3, "B"=>2, "C"=>1, _=>0 } (or normalize both sides through tier_label before ranking).

### [MINOR] TiersView empty-state colSpan is 8 but the table has 9 columns
- Where: src/components/TiersView.tsx:178
- Root cause: The header row defines 9 columns (Client, Tier, Spend/Freq, Actually paid, Invoices, Quotes, Reliability, Avg margin, Frequency — src/components/TiersView.tsx:127-135) but the no-results cell uses colSpan={8} (TiersView.tsx:178), leaving the empty-state cell one column short.
- Fix: Change colSpan={8} to colSpan={9}.

### [HALF-BUILT] tier_history table / tier-change tracking
- Where: src-tauri/src/commands.rs
- Current state: Table exists and is in the synced-tables list (commands.rs:9310) but its only writer is the dead tier_drop path (commands.rs:7719-7722), which never executes due to the label/code rank mismatch — so tier history is empty and nothing reads it.
- To finish: Fix the tier_rank code mismatch (bug above) so history rows are written on drops; consider also recording upgrades, and surface tier history in ClientDetailView if the owner wants it.

### [HALF-BUILT] Refund-aware stats layer
- Where: src-tauri/src/commands.rs
- Current state: Refund math exists and is correct in the payout/financials layer (deal_pay_summary eff_net = net - refunded, commands.rs:4715-4720; refund_status_all dedupe of bank vs cash refunds, 10069-10090) but was never wired into the tier/client layer — buyer_tiers, build_client_tier_map, total_revenue, and the ClientDetailView Profit tile are all refund-blind.
- To finish: Reuse the refund_status_all counting rule (non-bank-linked refunds rows + refund_out allocations) as a per-client refunded-total map and subtract it in buyer_tiers (actual_paid), build_client_tier_map, the total_revenue subqueries (commands.rs:158/229), and the client profit stat.

## Analytics page (desktop) — AnalyticsView.tsx + dashboard_stats / get_analytics_range / buyer_tiers backend, with DashboardView overlap

**How it works today:** The Analytics tab is a single 705-line React view (AnalyticsView.tsx) fed by three Tauri commands: dashboard_stats (all-time, mostly invoice-based), get_analytics_range (date-filtered, deal_flow-based), and buyer_tiers. It renders: a preset/custom date-range header; a 4-stat hero (Revenue/Net profit/Avg margin/Outstanding); a monthly revenue-vs-profit bar chart; a profit-trend area chart; a client-mix donut by tier; invoice-status bars; top spenders; client-tier distribution; category breakdown; most-profitable clients; a 6-stat "Financial snapshot"; and an xlsx export. Health is poor for a money page: the two data sources disagree by construction (deal_flow gross = $279,805 all-time vs paid-invoice revenue = $340,950 on the same screen), only half the page respects the selected date range, refunds ($125,720 recorded, $138,610 still owed — 5x the $25.5k all-time net profit) are invisible and never reduce any revenue/profit figure, a fell-through (voided-invoice) completed deal still contributes $6,515/$545 to every range stat, and the known ghost deal_flow rows plus 30 orphaned flows inflate the dashboard "Open deals" hero to 56 when the deduped truth is 7. Rich data the app already has — Financials/bank (free cash, balances, allocations), refund liability, supplier payables/top suppliers, rep payout costs, inventory, AR/AP aging, quote win rates, and a fully built but never-rendered pipeline_analytics command — is absent from the page, so a ground-up redesign has plenty of real data to draw on but must dedupe deal_flows per invoice, join invoices to exclude voided/missing ones, and net out refunds everywhere. App.tsx nests two subtabs under Analytics: Automation (AutomationLogView) and Globe (GlobeView).

**Data flow:** Frontend: AnalyticsView.tsx loads via Promise.all at src/components/AnalyticsView.tsx:156-160 → api.dashboardStats (src/lib/api.ts:2065 → invoke "dashboard_stats"), api.buyerTiers (api.ts:1913 → "buyer_tiers"), api.getAnalyticsRange (api.ts:2069 → "get_analytics_range"); presets/custom range re-call getAnalyticsRange (AnalyticsView.tsx:131-150); export via api.exportAnalyticsXlsx (api.ts:1663 → "export_analytics_xlsx"). Backend (C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs): dashboard_stats at 8035-8350 — invoice-based totals (outstanding 8047-8058 committed-stage sent/overdue; paid_ytd 8059-8066; total_cost/profit/avg_margin 8093-8113 from invoices is_complete=1; invoice_status_breakdown 8200-8210; top_spenders 8212-8231; category_breakdown 8184-8198 from client metadata.category + paid invoices) and deal_flow-based series (monthly_profit 8115-8129 SUM gross_revenue/total_cost/net_profit of stage='complete' non-archived; open_deals 8165-8171; completed_this_month 8172-8176; top_suppliers 8270-8295 from supplier_payments_json). get_analytics_range at 8584-8659 — pure deal_flows stage='complete' filtered by completed_at with string-interpolated dates (8590-8595), totals 8597-8616, monthly 8619-8629, top clients 8632-8651. buyer_tiers at 8688+ (paid invoice totals per client 8692-8697, quotes 8707-8717, margin from completed deal_flows 8728-8734). Frontend math: hero prefers rangeData over stats (AnalyticsView.tsx:124-129); MoM chips computed client-side from last two monthly buckets (204-205, 676-687); tier donut counts client-side (207-210). DashboardView.tsx overlap: same dashboard_stats (110) for hero clients/open_deals/completed_this_month (178-184) + revenue_mtd/all (paid invoices) vs profit_mtd/all (deal_flows), plus getReceivablesAging/getPayablesAging (113-114 → commands.rs:8409/8491) and getMonthlyProfit daily cumulative chart (118-141 → commands.rs:8391-8403). Analytics subtabs in App.tsx:422-425 (children: automation, globe) render AutomationLogView (App.tsx:515) and GlobeView (App.tsx:494); AnalyticsView itself at App.tsx:513.

### [CRITICAL] Dashboard 'Open deals' hero shows 56 when the true deduped count is 7 (ghost + orphan deal_flow rows)
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:8165
- Root cause: commands.rs open_deals counts every non-complete non-archived deal_flow row: 'SELECT COUNT(*) FROM deal_flows df LEFT JOIN invoices i ON i.id=df.invoice_id WHERE df.stage != "complete" AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0'. Verified against a copy of the live DB: the query returns 56; broken down as 30 ORPHAN flows whose invoice_id matches no invoices row at all (LEFT JOIN makes i.voided NULL so COALESCE(...,0)=0 passes them), 19 ghost duplicate rows on invoices whose real flow is already stage='complete' (the known 15-invoice/28-ghost issue — all 28 ghosts sit at non-complete stages, so every one of them that has a live invoice lands in this count), and only 7 genuinely open deals (one-per-invoice, best stage < complete). DealFlowView dedupes for display (src/components/DealFlowView.tsx:78-109) so the user sees ~7 in Deal Flow but 56 on the Dashboard hero (DashboardView.tsx:179), which is shown to every user including reps.
- Fix: Change LEFT JOIN to INNER JOIN invoices (drops the 30 orphans) and dedupe per invoice, counting an invoice as open only if its BEST flow is non-complete: SELECT COUNT(*) FROM (SELECT df.invoice_id, MAX(CASE df.stage WHEN 'complete' THEN 4 WHEN 'supplier_paid' THEN 3 WHEN 'payment_received' THEN 2 ELSE 1 END) best FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id WHERE COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 GROUP BY df.invoice_id) WHERE best < 4. Separately, clean the 28 ghost rows + 30 orphan rows in the DB (archive them) so every other aggregate is safe too.

### [CRITICAL] Refunds never reduce any analytics revenue/profit figure — $125,720 refunded / $138,610 owed-back is invisible
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:8597
- Root cause: All profit/revenue aggregates SUM stored deal_flows.net_profit/gross_revenue or invoices.total: dashboard_stats profit_all_time (commands.rs:8260-8263), monthly_profit (8117), revenue_all_time from paid invoices (8251-8254), and every get_analytics_range total (8597-8616). net_profit is written once at complete_deal_flow (commands.rs:4207 and UPDATE at 4218) as gross - supplier_cost and is never adjusted when refunds are recorded; the refund-aware 'effective net' exists only per-deal at display time in deal_flow_payout (eff_net = net - refunded, commands.rs:4713). Live DB: refunds table holds 5 refunds totaling $125,720 and two active deals carry refund_owed of $52,890 (refunded $40,000, stage payment_received) and $85,720 (fully refunded, stage invoiced). Neither deal is complete yet so today's completed-deal sums don't include them — but the moment either completes, complete_deal_flow's net = payment_received_amount - total_supplier_cost (4182-4184) and analytics will book fully-refunded money as won revenue/profit with nothing subtracting it. A fully refunded paid invoice likewise stays in paid_ytd/revenue_all_time. Against $25,500 all-time net profit, an unmodeled $138,610 refund liability makes the page's profit story unusable.
- Fix: In the new analytics backend, join refunds per deal_flow and report effective figures: eff_gross = gross_revenue - refunded, eff_net = net_profit - refunded (matching deal_flow_payout at 4713-4714), e.g. LEFT JOIN (SELECT deal_flow_id, SUM(amount) refunded FROM refunds GROUP BY deal_flow_id). Surface refund_owed remaining (refund_owed - refunded, clamped at 0, per the 10577-10621 liability query) as its own analytics stat, and exclude or flag deals whose refunded >= gross as not-won revenue.

### [MAJOR] get_analytics_range ignores archived flows AND voided (fell-through) invoices — provably off by $6,515 revenue / $545 profit today
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:8590
- Root cause: Every WHERE clause in get_analytics_range is just stage='complete' plus the date bounds (commands.rs:8590-8595 for totals, 8632-8637 for top clients) — no COALESCE(archived,0)=0 and no join to invoices to exclude voided. Live DB check: 1 non-archived stage='complete' deal_flow has a voided/archived invoice (fell through after completion via set_deal_flow_fell_through, commands.rs:5117-5125, which only voids the invoice and leaves the flow row untouched) worth gross $6,515 / net $545 — it is counted in the Analytics hero, monthly chart, and Most profitable for every preset. dashboard_stats monthly_profit (8117-8118) and profit_all_time (8260-8263) filter archived but also skip the invoice join, so they include the same fell-through deal; meanwhile archived complete flows (currently 0) would count in Analytics but not the Dashboard, making the two heroes diverge by construction. Also: no per-invoice dedup, so any future duplicate 'complete' row double-counts (15 invoices already have non-archived duplicates at lower stages).
- Fix: Add to every deal_flows query in get_analytics_range: COALESCE(df.archived,0)=0 plus JOIN invoices i ON i.id=df.invoice_id with COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 (mirroring open_deals' intent at 8167-8169), and dedupe one row per invoice_id (e.g. GROUP BY invoice_id taking MAX(completed_at) row, or fix the DB ghosts first). Apply the same invoice join to dashboard_stats monthly_profit (8117), profit_mtd/all_time (8255-8263), all_time_revenue/profit (8307-8314), and get_monthly_profit (8391-8397, which currently has NO archived filter at all).

### [MAJOR] 'Invoice status' card header counts voided invoices the breakdown hides — '32 total invoices' vs statuses summing to 28; $187,800.70 of voided invoices vanish from all tracking
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:8041
- Root cause: stats.invoices comes from 'SELECT COUNT(*) FROM invoices WHERE COALESCE(archived,0)=0' (commands.rs:8040-8042 — no voided filter) and AnalyticsView renders it as the card subtitle '{stats.invoices} total invoices' (AnalyticsView.tsx:423), while invoice_status_breakdown (commands.rs:8200-8210) adds COALESCE(voided,0)=0. Live DB: 32 non-archived invoices, but the breakdown returns draft 3 + overdue 1 + paid 24 = 28; the 4 voided invoices (totaling $187,800.70, statuses draft/overdue/paid — voiding sets the voided column, not a 'void' status) appear in the headline number yet in no status row. This both looks broken (bars never sum to the header) and violates the owner requirement that sent invoices are always tracked — a voided invoice disappears rather than showing as void/fell-through.
- Fix: Make the two consistent and keep voided visible: in invoice_status_breakdown, bucket voided rows explicitly, e.g. SELECT CASE WHEN COALESCE(voided,0)=1 THEN 'void' ELSE status END st, COUNT(*), COALESCE(SUM(total),0) FROM invoices WHERE COALESCE(archived,0)=0 GROUP BY st — then the header count (8041) matches, and add 'void' to the STATUS color map in AnalyticsView.tsx:59.

### [MAJOR] 'Financial snapshot' labels YTD paid-invoice revenue as 'Total revenue' next to all-time cost/profit, and ignores the page's selected date range
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/AnalyticsView.tsx:647
- Root cause: AnalyticsView.tsx:647 renders {label: 'Total revenue', value: fmtAmount(stats.paid_ytd)} — paid_ytd is paid invoices with issue_date >= Jan 1 of the current year only (commands.rs:8059-8066) — beside 'Total cost' (stats.total_cost, all-time invoices is_complete=1, commands.rs:8093-8099) and 'Net profit' (stats.total_profit, all-time, 8100-8106). So the card implies profit = revenue - cost but mixes a YTD number with all-time numbers from a different base (invoice.profit vs the hero's deal_flow net_profit). The whole card also uses raw stats, never rangeData, so changing the date preset changes the hero above but not this card. Same-page contradiction verified: hero all-time revenue (deal_flows gross, get_analytics_range) = $279,804.85 while all-time paid-invoice revenue = $340,949.85 and this card shows a third, YTD-only figure.
- Fix: Either label it honestly ('Paid this year') or, in the redesign, source the snapshot from the same range-filtered deal_flow aggregates as the hero (get_analytics_range already returns total_revenue/total_cost/total_profit/avg_margin) so revenue - cost = profit holds within one card.

### [MINOR] Hero month-over-month chips compare the partial current month to the last full month, and the hero mixes range-filtered and all-time stats in one row
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/AnalyticsView.tsx:204
- Root cause: momLast/momPrev are the last two buckets of the monthly series (AnalyticsView.tsx:204-205) fed to MomChip (296, 307; computed at 676-687). The final bucket is almost always the in-progress current month, so mid-month the chip reliably shows a large 'down' percentage against a complete prior month — misleading trend signal. Additionally the hero row mixes windows: Revenue/Net profit/Avg margin re-compute per selected preset (displayStats = rangeData, line 124), but 'Outstanding' (line 128 uses stats.outstanding, and line 423's invoice counts) are always all-time dashboard_stats, with no visual cue that one cell obeys the range and its neighbor does not.
- Fix: Compare like-for-like: either compare month-to-date vs same-day-count of the prior month (dashboard_stats already returns revenue_mtd/revenue_prev_month at commands.rs:8249-8250 — extend with a prorated prev), or drop the current partial month from the MoM comparison (use buckets n-2 vs n-3 when the last bucket is the current month). In the redesign, make every hero stat range-aware or clearly badge 'all time'.

### [MINOR] get_analytics_range builds SQL by string-interpolating the user-supplied date strings
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:8591
- Root cause: start_date/end_date arrive from the frontend date inputs and are inserted with format! directly into four WHERE clauses (commands.rs:8591-8594) and again for top clients (8633-8636): e.g. format!("stage='complete' AND date(completed_at)>='{start_date}'"). A quote character in the string breaks the statement (all five queries error and the UI silently keeps stale data because AnalyticsView catches and ignores at line 136); as a local single-user app it is low security risk, but it is the only unparameterized user input in this command surface.
- Fix: Use rusqlite parameters: WHERE stage='complete' AND (?1='' OR date(completed_at)>=?1) AND (?2='' OR date(completed_at)<=?2) with params![start_date, end_date] — one static SQL string, no interpolation.

### [MINOR] 'Avg margin' is an unweighted per-row average and has two different definitions on the same page
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:8109
- Root cause: dashboard_stats avg_margin = AVG of per-invoice profit/total across completed invoices (commands.rs:8107-8113); get_analytics_range avg_margin = AVG of per-deal net_profit/gross_revenue (8609-8612). Both are unweighted, so a $100 deal at 90% margin offsets a $100,000 deal at 5%. The hero shows the range version while the Financial snapshot shows the invoice version (AnalyticsView.tsx:127 vs 651), so the same label can display two different numbers simultaneously.
- Fix: Standardize on the volume-weighted blended margin: SUM(net_profit)/SUM(gross_revenue)*100 over the deduped, refund-netted completed deal set, and use one source for every margin display on the page.

### [MINOR] Excel export uses stale, unfiltered queries: Top Clients includes voided invoices and the Deal Pipeline sheet is always empty
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:1281
- Root cause: export_analytics_xlsx Sheet 3 query (commands.rs:1281-1284) is 'FROM clients c JOIN invoices i ... WHERE i.status="paid"' with no voided/archived filter — the live DB has a voided-but-status-paid invoice (the fell-through-after-complete deal), so exported client spend disagrees with the on-screen Top spenders (which filters both at 8219). Sheet 2 groups paid revenue by issue_date rather than paid date (1258-1260), diverging from the dashboard's paid_at-based hero (8245-8248). Sheet 4 reads the deals table (1303), which has 0 active rows in the live DB — the legacy pre-deal_flow pipeline — so the sheet is permanently blank, as are dashboard_stats pipeline_value/pipeline_count (8150-8159).
- Fix: Add COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 to the Top Clients query; group Sheet 2 by COALESCE(NULLIF(paid_at,''), issue_date); replace the Deal Pipeline sheet with deal_flows stage counts (deduped per invoice) since the deals table is dead.

### [HALF-BUILT] Deal-funnel analytics (pipeline_analytics) — built backend, never rendered
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs
- Current state: Full command exists computing funnel counts/values, stage conversion rates, avg days-in-stage, overall + 30-day win rate (commands.rs:3258-3330+), and it is wired into the frontend API (src/lib/api.ts:1916 pipelineAnalytics), but no component ever calls it — grep finds zero usages in src/components. It also reads the legacy 'deals' table (lead/quoted/negotiating/won/lost), which has 0 active rows in the live DB, so even if rendered it would show nothing.
- To finish: Decide the funnel source of truth for the redesign: either port the funnel math to deal_flows stages (invoiced -> payment_received -> supplier_paid -> complete, deduped per invoice) + quotes (sent/accepted from the quotes table, already aggregated per client in buyer_tiers at commands.rs:8707-8717), then add a funnel section to the new analytics; or delete the dead command + deals-table stats (pipeline_value/count at 8150-8159, xlsx Sheet 4 at 1298-1310).

### [HALF-BUILT] Top suppliers stat — computed on every dashboard_stats call, displayed nowhere
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs
- Current state: dashboard_stats computes top_suppliers (top 6 by total paid from supplier_payments_json of completed flows, commands.rs:8270-8295) and it is typed in the frontend (src/lib/api.ts:1107), but neither AnalyticsView nor DashboardView renders it — wasted query on every dashboard load.
- To finish: Surface it in the new analytics as a supplier-cost section (pairs naturally with get_payables_aging at commands.rs:8491 for what is still owed to suppliers), or drop the computation.

### [HALF-BUILT] Ghost/orphan deal_flow rows — display-level dedup only, DB never cleaned
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/DealFlowView.tsx
- Current state: DealFlowView dedupes per invoice_id keeping the highest stage (src/components/DealFlowView.tsx:78-109) and self-heals stranded payments (line 120+), but the 28 ghost rows across 15 invoices plus 30 orphan flows (invoice_id matching no invoices row) remain live in the DB, so every raw SQL aggregate (open_deals proven inflated 56 vs 7; any future COUNT/SUM over deal_flows) stays exposed.
- To finish: One-time migration/repair command: archive (archived=1) every non-best duplicate flow per invoice_id and every flow whose invoice_id resolves to no invoice row, synced via record_upsert so all devices heal; then the display dedup becomes belt-and-suspenders instead of load-bearing.

### [HALF-BUILT] Date-range filtering — half the analytics page ignores the selected range
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/AnalyticsView.tsx
- Current state: The preset/custom range re-fetches get_analytics_range and updates hero revenue/profit/margin, both monthly charts, and Most profitable (AnalyticsView.tsx:124-137, 196, 606), but Outstanding, Invoice status, Top spenders, Client tiers/mix, Category breakdown, and the entire Financial snapshot always show all-time dashboard_stats/buyer_tiers data (lines 128, 421-458, 460-502, 508-557, 559-595, 640-667) with no indication which cards obey the range.
- To finish: In the redesign, make one range state drive every card (extend the range command to also return status/spender/category slices for the window), or visibly badge non-range cards as 'All time'.

### [HALF-BUILT] Analytics does not surface most of the app's data (redesign inventory)
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/lib/api.ts
- Current state: Data that exists with working backends but no analytics presence: (1) Financials/bank — bank_txn, bank_allocation (role='refund_out'), deal_receipts tables and financials_overview with bank_balance, free_cash, refund_liability, tax/refund reserves, runway_months, allocated actuals buyer_in/supplier_paid/refunds_out (src/lib/api.ts:1466-1481; rendered only in the Financials tab's FreeCashView); (2) refunds — refund_status_all (commands.rs:10086) and the refund-liability aggregation (~10577-10621), $138,610 outstanding today; (3) rep payouts — deal_flow_payout per-deal breakdown (commands.rs:4679-4747) with rep cuts and N-way owner splits, no aggregate rep-cost or per-rep performance stat anywhere; (4) inventory — 9 lots (8 unsold) with statuses, no turnover/aging/stale-listing analytics; (5) AR/AP aging — get_receivables_aging (commands.rs:8409) / get_payables_aging (8491) full bucket data shown on Dashboard/Receivables/Payables but absent from Analytics (which only shows a single Outstanding number); (6) quotes — per-client quotes_sent/quotes_won already computed in buyer_tiers (8707-8717), no win-rate chart; (7) loans (Loan/LoanLedger types, api.ts:1482-1505).
- To finish: The new full-dashboard analytics can be assembled almost entirely from existing commands: financials_overview + refund_status_all + get_receivables_aging + get_payables_aging + a refund-aware, deduped, void-excluding rewrite of get_analytics_range, plus new small aggregates for rep-cost totals, inventory aging, and quote win rate.

## Financials page UI (desktop): Transactions tab (imports, Plaid feed, review queue, allocation, split mode, rules, bulk actions), Overview tab (Free cash), Loans tab

**How it works today:** The Financials page is a three-tab surface (Transactions / Overview / Loans) that is functionally rich but uneven. The Transactions tab is the most mature: import (file/AI/Plaid), review queue, per-row and bulk allocation, split mode, and auto-tag rules all work end-to-end, with good error toasts. However it carries several sharp edges: a rule created with the default blank category mass-wipes categories on every matching un-booked row; "New deal from this transaction" creates orphan client/invoice/deal rows when clicked on a money-out transaction because the follow-up allocation is hard-coded to buyer_payment and rejected by the backend direction guard; the AI auto-categorize loop can burn up to 25 model calls re-processing the same 40 rows without ever reaching the actual uncategorized backlog; and the bulk "Tag all to a deal" modal skips the ghost-deal dedup that the single-row picker carefully applies, re-creating the known duplicate-deal_flow allocation problem. The Overview (Free cash) tab's backend aggregates for tax/refund reserves ignore archived/voided/duplicate deal_flows, and its Adjust modal silently ignores the manual bank/card balances whenever Plaid is connected. The Loans tab swallows every error (no catch, no toast anywhere), offers no way to reopen a paid loan or fix a wrong received date. Overall health: core flows solid, aggregates and edge paths need a hardening pass before the numbers can be trusted to the cent.

**Data flow:** Transactions tab: rows from list_bank_txns (src-tauri/src/commands.rs:9633) which computes allocated/unallocated per txn by summing bank_allocation; deals for the picker from list_deal_flows (commands.rs:3776 — excludes archived deal_flows and voided/archived invoices but KEEPS duplicate non-archived rows per invoice); loans from list_loans (commands.rs:10662, outstanding = principal − set_aside); rules from list_txn_rules (commands.rs:10927, device-local table). The figures strip (Transactions/Reviewed/Money in/out/Uncategorized/Needs a deal) is computed CLIENT-SIDE in rangeSummary (src/components/FinancialsView.tsx:900-913) over the loaded txns filtered by date; the server-side bank_txn_summary (commands.rs:9669) is fetched into `summary` state (FinancialsView.tsx:157) but never rendered. Allocations write through allocate_bank_txn (commands.rs:9720, direction/role guard 9751-9756, split invariant 9758-9763) into bank_allocation with sync record_upsert + netsync push_now. Overview tab: financials_overview (commands.rs:10555) — bank/card balance from Plaid live balances when connected else manual settings keys (10558-10562); supplier_payables from deal_flows.supplier_payments_json netted against role='supplier_payment' allocations (10569-10579); refund_liability from deal_flows.refund_owed minus refunds table minus role='refund_out' allocations (10584-10593); tax/refund reserves = current-year SUM(net_profit)/SUM(gross_revenue) of stage='complete' deal_flows (10600-10607); loans outstanding 10610-10612; frontend just renders the JSON (src/components/FreeCashView.tsx:132-146). Loans tab: list_loans + loan_ledger (commands.rs:10846) which sums bank_txn rows tagged counterparty_type='loan' by direction; apply_loan_repayments_to_set_aside (commands.rs:10874) copies feed repaid total into loan.set_aside.

### [CRITICAL] Adding a rule with the default 'Uncategorized' category mass-clears categories on all matching un-booked transactions
- Where: src/components/FinancialsView.tsx:2423
- Root cause: RulesCard's add() only validates the counterparty (src/components/FinancialsView.tsx:2423-2427); the category select defaults to '' ('Uncategorized', state init at 2420, blank option rendered via CategoryOptions at 2500-2506). createRule immediately runs applyTxnRules (FinancialsView.tsx:693-694). Backend apply_txn_rules_impl(true) matches ALL reviewed=0 rows regardless of existing category (commands.rs:10982-10986) and writes the rule's category verbatim: 'UPDATE bank_txn SET category=?1' with category='' (commands.rs:11014, 11032-11035). One click on 'Add rule' with the untouched default therefore wipes categories (including manually-set and AI-set ones) from every un-booked transaction whose payee/description matches — and the change is synced to all devices.
- Fix: In RulesCard.add() reject empty cat ('Pick a category'); render CategoryOptions with includeUncat={false} and a disabled 'Set category…' placeholder like the bulk bar does. Defense in depth: in apply_txn_rules_impl skip rules whose category is empty unless target_type=='loan' (commands.rs:11004).

### [MAJOR] 'New deal from this transaction' on a money-out transaction creates orphan client + invoice + deal, then errors
- Where: src/components/FinancialsView.tsx:809
- Root cause: createDealFromTxn hard-codes role 'buyer_payment' (src/components/FinancialsView.tsx:809) but the backend rejects buyer_payment on direction='out' (commands.rs:9751-9756: money-out only allows supplier_payment/refund_out/fee/adjustment). The 'New deal from this transaction' button is shown in the Deal target panel for BOTH directions (FinancialsView.tsx:2296-2301). Sequence for an out-txn: createClient (line 798) succeeds, createInvoice (800) succeeds, createDealFlow (808) succeeds, allocateBankTxn (809) throws → catch shows the toast and returns false (814), leaving a stranded client, a backfilled invoice, and an unlinked deal in the pipeline with no cleanup and no link to the transaction.
- Fix: Either hide the button when txn.direction==='out' (it is a backfill for RECEIPTS per the copy at 2393), or pick the role by direction (out → 'supplier_payment'); and wrap the chain so a failed allocation archives/voids the just-created invoice+deal (or reorder: validate role feasibility before creating anything).

### [MAJOR] Auto-categorize with AI can loop 25 rounds re-processing the same 40 rows and never reach the uncategorized backlog
- Where: src/components/FinancialsView.tsx:778
- Root cause: The frontend loops until remaining<=0 or updated===0 (src/components/FinancialsView.tsx:778-782). But the backend batch selects 'reviewed=0 ORDER BY posted_at DESC LIMIT 40' with NO category filter (commands.rs:10748-10750), while 'remaining' counts reviewed=0 AND category='' (commands.rs:10786-10788). When the 40 newest un-booked rows already have categories (normal after a Plaid sync, which auto-applies rules) and the uncategorized rows are older, every round re-sends the exact same 40 rows to the model (updated stays ~40 > 0, remaining never decreases) — up to 25 paid AI calls that never touch the actual backlog the button exists for.
- Fix: Add AND COALESCE(category,'')='' to the candidate query in ai_categorize_bank_txns (commands.rs:10749) so the batch and the 'remaining' counter measure the same population; then updated===0 ⇔ remaining stops moving and the UI loop terminates correctly.

### [MAJOR] Free-cash tax and refund reserves count archived, fell-through, and duplicate (ghost) deal_flows
- Where: src-tauri/src/commands.rs:10600
- Root cause: financials_overview computes year_profit and year_revenue as SUM over "deal_flows WHERE stage='complete' AND completed_at >= start of year" with NO COALESCE(archived,0)=0 filter, NO join to invoices to exclude voided/archived (fell-through) invoices, and NO per-invoice dedup (commands.rs:10600-10605). This is exactly the class the known 28-ghost-rows issue inflates: if both duplicate rows for an invoice are stage='complete' (the DealFlowView dedup breaks stage TIES by recency, so complete/complete pairs exist), profit and revenue are double-counted; archived (soft-deleted) completed deals also still count. Result: tax_reserve and refund_reserve are inflated → free_cash understated (commands.rs:10606-10614). Contrast with list_deal_flows which carefully applies all three filters (commands.rs:3796-3797).
- Fix: Rewrite both queries to select one survivor row per invoice_id (highest stage rank, newest tie-break — same rule as reattach_orphaned_deal_allocations at commands.rs:9867-9869) and add COALESCE(df.archived,0)=0 plus a LEFT JOIN invoices i ... AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0.

### [MAJOR] Supplier payables, refund liability and the refund-deals alert also skip ghost dedup and voided-invoice exclusion
- Where: src-tauri/src/commands.rs:10569
- Root cause: supplier_payables (commands.rs:10569-10579) and refund_liability (commands.rs:10584-10593) filter archived=0 but never join invoices (fell-through deals with voided invoices still deduct from free cash even though Deal Flow hides them) and never dedup duplicate non-archived rows per invoice — a duplicated deal in stage payment_received/supplier_paid contributes its supplier_payments_json twice. The refund_deals alert (commands.rs:10624-10625) has the same two gaps, so it can report 'N deals with a refund you owe' where some are invisible in the Deal Flow view, with no way for the user to find them.
- Fix: Apply the same survivor-per-invoice dedup + invoice voided/archived exclusion to all three queries (share a CTE, e.g. WITH live_df AS (SELECT ... survivor rows ...) and run the three aggregates against it).

### [MAJOR] Bulk 'Tag all to a deal' modal lists ghost duplicate deals the single-row picker deliberately hides
- Where: src/components/FinancialsView.tsx:1921
- Root cause: filteredDeals for the inline allocation panel collapses duplicate deal_flow rows per invoice to the highest-stage survivor precisely so 'an allocation can never land on a ghost duplicate' (src/components/FinancialsView.tsx:920-931). BulkAllocateModal's dealList does NOT: it filters/sorts the raw deals array (FinancialsView.tsx:1921-1928). For the 15 known invoices with duplicate non-archived rows the modal shows two visually identical entries, and picking the ghost books every selected transaction's remaining amount (bulkAllocate, FinancialsView.tsx:761-766) onto a row the Deal Flow view never displays — the deal then shows 'no linked payment' until reattach_orphaned_deal_allocations heals it on the NEXT Financials mount (FinancialsView.tsx:268).
- Fix: Extract the survivorByInv dedup from filteredDeals (rankOf + invoice_id keying, FinancialsView.tsx:923-930) into a shared helper and apply it inside BulkAllocateModal's dealList memo before filtering/sorting.

### [MAJOR] Entire Loans tab swallows every backend failure — no catch, no toast anywhere
- Where: src/components/LoansView.tsx:93
- Root cause: LoansView never imports toast. saveForm wraps updateLoan/createLoan in try/finally with no catch (src/components/LoansView.tsx:93-112) — a failure is an unhandled promise rejection and the form silently stays open; saveAside (LoansView.tsx:120-125), markPaid (127-130), removeLoan (132-136) have no try at all, so a failed 'Mark paid off' or delete shows nothing and the UI looks like it worked until the reload doesn't change; applyToSetAside (58-66) is try/finally only. Initial load errors go to console.error only (49).
- Fix: Import toast from ./Toast and add catch (e) { toast(String(e), 'error') } to saveForm, saveAside, markPaid, removeLoan, applyToSetAside and load(), matching the pattern used throughout FinancialsView.

### [MINOR] summary state is fetched on every category change but never rendered — dead data plus a wasted round-trip per click
- Where: src/components/FinancialsView.tsx:157
- Root cause: const [summary, setSummary] (src/components/FinancialsView.tsx:157) is populated at mount (265), in refreshAll (302-303), and saveReview re-fetches api.bankTxnSummary() after EVERY per-row category select / Book click (643-644) — yet a grep shows `summary` is never read in any JSX; the visible figures strip uses the client-computed rangeSummary instead (900-913, rendered 1598-1605). Every category dropdown change costs an extra backend query for nothing.
- Fix: Delete the summary state, the BankTxnSummary import usage, and the three bankTxnSummary() calls (or, if the server-side numbers are wanted, render them and drop rangeSummary — pick one source).

### [MINOR] 'Needs a deal' counter counts every categorized operating expense forever, contradicting the Expense/income panel
- Where: src/components/FinancialsView.tsx:910
- Root cause: rangeSummary.needsDeal counts any txn with unallocated>0 that isn't loan-tagged or internal_transfer (src/components/FinancialsView.tsx:910); the status filter options 'Needs a deal (in/out)' use the same rule (833-834). But the allocation panel's Expense/income target explicitly tells the user such rows are 'Tracked by category only … not tied to a deal or loan' (2354-2356) — booking a meal/rent/software expense that way still leaves it counted in 'Needs a deal' (strip at 1604) permanently, so the counter can never reach zero for a real ledger and stops meaning anything.
- Fix: Exclude rows whose category is a pure expense/income/transfer group (anything not receipt/payment/merchandise/refund-related), or simplest: only count reviewed=0 rows so booking as an expense clears the flag; apply the same rule to the two status-filter options.

### [MINOR] Free-cash Adjust modal silently ignores the bank/credit-card fields whenever Plaid is connected
- Where: src/components/FreeCashView.tsx:297
- Root cause: financials_overview prefers live Plaid balances and only falls back to the manual settings when no bank is linked (commands.rs:10558-10562). The Adjust modal still presents 'Current bank balance' ('this figure is maintained by you') and 'Credit card balance owed' as authoritative inputs (src/components/FreeCashView.tsx:297-310). With a bank connected, the user edits the number, hits Save, gets a 'Saved' toast, and the headline Free cash doesn't move — no hint that the value is overridden by the feed.
- Fix: Return has_plaid (and the live figures' source) in the financials_overview payload; when true, disable the two NumFields and change the hint to 'Live from your connected bank — managed automatically', keeping them editable only as fallback.

### [MINOR] Loan tag/untag permanently destroys the transaction's original payee name
- Where: src-tauri/src/commands.rs:10812
- Root cause: tag_bank_txn_to_loan overwrites counterparty_name with the loan name (commands.rs:10812, 10817-10818); untag_bank_txn_loan then resets counterparty_name to '' (commands.rs:10829-10832, 10837). The Plaid/statement payee is unrecoverable after a tag+untag cycle, breaking the payee display, smart grouping (which keys on counterparty_name, FinancialsView.tsx:878-880) and future rule matching for that row.
- Fix: Don't overwrite counterparty_name on tag (the loan link already lives in counterparty_type/counterparty_id; the UI derives the label from those at FinancialsView.tsx:1062-1063), or stash the original in a column/metadata and restore it on untag.

### [MINOR] 'Mark paid off' is one click, unconfirmed, and irreversible in the UI
- Where: src/components/LoansView.tsx:127
- Root cause: markPaid immediately writes status='paid' (src/components/LoansView.tsx:127-130) with no confirm dialog. Once paid, the action row hides Set aside / Mark paid (384-409) and openEdit→saveForm preserves l.status (102), so there is no control anywhere to reopen a loan mis-marked as paid — even though the backend fully supports it (update_loan takes status and clears paid_at when != 'paid', commands.rs:10713-10715). A paid loan also drops out of loan_outstanding on the Free cash tab (commands.rs:10610-10611), so a misclick silently inflates free cash.
- Fix: Add a confirm() before markPaid, and render a 'Reopen' button on paid cards that calls updateLoan(..., 'open', ...).

### [MINOR] Loan 'Date received' can never be corrected after creation
- Where: src/components/LoansView.tsx:213
- Root cause: The Date received field is hidden in edit mode ({!editingId && ...} src/components/LoansView.tsx:213-222), saveForm's edit branch doesn't pass it (102), and the backend update_loan has no received_at parameter at all (commands.rs:10713). A typo'd date is permanent short of delete-and-recreate, which loses set_aside/status/feed history context.
- Fix: Show the date field when editing, add received_at to update_loan's signature + UPDATE statement + sync cols, and pass fReceived in the edit branch.

### [MINOR] Deal picker goes stale: deals are never re-fetched by refreshAll or the netsync live-refresh
- Where: src/components/FinancialsView.tsx:302
- Root cause: refreshAll reloads txns/summary/loans only (src/components/FinancialsView.tsx:300-310), and the netsync-applied listener calls refreshAll (286-290). deals is loaded once at mount (262-265) and refreshed only inside createDealFromTxn (811). A deal created on another device (the exact scenario the netsync listener exists for) or added elsewhere in the app never appears in the inline allocate picker or the bulk modal until the whole view remounts; likewise a loan added in the Loans sub-tab doesn't reach the Transactions-tab loan picker until some unrelated action happens to call refreshAll.
- Fix: Include api.listDealFlows() in refreshAll's Promise.all and setDeals with the result (it's the same cheap query the mount already runs).

### [MINOR] 'Plaid is preparing your transactions' banner can persist forever after silent retries exhaust
- Where: src/components/FinancialsView.tsx:347
- Root cause: schedulePrepRetries counts down 6 background re-syncs (~2 min) but when left reaches 0 it just returns (src/components/FinancialsView.tsx:346-348) — plaidPreparing is never set back to false in the exhaustion path (and the catch at 361 also only reschedules), so if Plaid takes longer than ~2 minutes the 'this can take a minute' banner (1445-1453) sits there indefinitely until the user happens to click Sync now.
- Fix: When left<=0, setPlaidPreparing(false) and toast a one-line 'Still preparing — use Sync now in a few minutes' so the state resolves visibly.

### [MINOR] Suggested-group 'Tag all N' dismisses the suggestion before the rule call can fail
- Where: src/components/FinancialsView.tsx:1734
- Root cause: The click handler calls dismissGroup(g.key) and THEN awaits createRule (src/components/FinancialsView.tsx:1731-1736). If create_txn_rule/apply_txn_rules errors, the toast fires but the group is already gone from the session (dismissedGroups, 895) with all its rows still untagged — the user has to find them by hand.
- Fix: Await createRule first and only dismissGroup on success (createRule already toasts on failure; have it return a boolean or move the dismiss into the try).

### [MINOR] Bulk action failures report a bare count with no reason
- Where: src/components/FinancialsView.tsx:744
- Root cause: runBulk swallows each per-row error (catch { failed += 1 }, src/components/FinancialsView.tsx:744) and ends with 'N of M could not be updated' (752). The most common bulk-allocate failure is the exclusive-link guard ('already linked to another deal', commands.rs:9746-9748) — invisible here, so the user can't tell which rows failed or why, and 'done' even counts the failures in its progress figure (745-746).
- Fix: Collect the first distinct error message(s) in runBulk and append one to the failure toast (e.g. '3 of 12 failed — already linked to another deal'), and track which ids failed so they stay selected for retry.

### [MINOR] Plaid environment can't be switched without re-entering both keys, and the env dropdown looks live but isn't
- Where: src/components/FinancialsView.tsx:1310
- Root cause: The Environment select only writes local state (src/components/FinancialsView.tsx:1310-1317); nothing persists until Save keys, and savePlaidKeys refuses unless BOTH client ID and secret are typed (312-314). A user with saved production keys who flips the dropdown to Sandbox sees the label change (header shows plaidEnv, 1295) but every sync still runs against the stored env — and to actually switch they must dig out both credentials again even though the client ID is unchanged.
- Fix: Add a plaid_set_env command (keys per env are already stored server-side per plaid_config), call it onChange when plaidReady, and after savePlaidKeys/plaidConfig re-read, drive the header label from the persisted cfg.env only.

### [MINOR] Single-file statement preview has no busy indicator
- Where: src/components/FinancialsView.tsx:524
- Root cause: pickAndPreview sets previewPath then awaits api.bankPreview (src/components/FinancialsView.tsx:524-529); the preview card renders only once preview is non-null (1483). For a large/scanned PDF the parse can take seconds — the button isn't disabled (only bulkBusy disables it, 1231) and no spinner appears, so users double-click or think the pick failed. The AI path handles this correctly with aiExtracting (585-590, 1238).
- Fix: Add a previewing state mirroring aiExtracting: set true around the bankPreview await, disable the Import statement button and show the Loader2 while set.

### [MINOR] One transient poll error permanently aborts the bank-connect wait
- Where: src/components/FinancialsView.tsx:408
- Root cause: In connectBank's tick, any single plaidConnectPoll rejection (momentary network blip, laptop sleep) goes to the catch which stopPolling()s and drops plaidConnecting (src/components/FinancialsView.tsx:408-412) — while the user is mid-login in the browser. The link session is still valid server-side, but the app has stopped watching; the connection then appears to have failed even when the user completed it.
- Fix: Tolerate a few consecutive poll errors (e.g. retry up to 5 before giving up) instead of aborting on the first, reusing the existing attempts counter.

### [HALF-BUILT] Free-cash aging alerts (refund owed / stale unallocated receipts)
- Where: src/components/FreeCashView.tsx
- Current state: Display-only red text rows; not clickable, no way to see WHICH deals or transactions they refer to (src/components/FreeCashView.tsx:249-268). The stale-unallocated alert corresponds exactly to the Transactions tab's 'Needs a deal (in)' filter but nothing connects them.
- To finish: Make each alert a link: lift tab state up (or use a callback prop from FinancialsView) so clicking switches to the Transactions tab with statusFilter='unallocated_in' preset; for refund deals, deep-link to the Deal Flow refunds section. Also fix the underlying queries' voided/ghost gaps (see bugs) so the counts are findable.

### [HALF-BUILT] Server-side summary strip (bank_txn_summary)
- Where: src/components/FinancialsView.tsx
- Current state: Backend command fully built (commands.rs:9669-9695) and fetched into state on mount, on refreshAll, and after every saveReview — but zero JSX reads it; the UI shows the client-side rangeSummary instead (src/components/FinancialsView.tsx:157, 643-644, 900-913).
- To finish: Decide on one source: either delete the summary state + bankTxnSummary calls (and optionally the backend command if nothing else uses it), or replace rangeSummary with the server numbers plus a date-range parameter.

### [HALF-BUILT] Free-cash manual vs live balance duality
- Where: src/components/FreeCashView.tsx
- Current state: Backend already prefers live Plaid balances (commands.rs:10558-10562) but the Adjust modal still presents manual bank/card fields as the source of truth with hints saying 'maintained by you' (src/components/FreeCashView.tsx:297-310); the overview page never indicates which source produced the headline number.
- To finish: Expose has_plaid/source in financials_overview's response; show a 'live from bank feed' badge next to Bank balance, disable (or clearly demote to fallback) the two manual fields when connected.

### [HALF-BUILT] Loans lifecycle management
- Where: src/components/LoansView.tsx
- Current state: Create/edit/set-aside/mark-paid/delete exist, but: paid loans can't be reopened from the UI, received date is immutable, every error is swallowed silently, and create_loan's bank_txn_id parameter is plumbed through the API (src/lib/api.ts:2132-2133) yet the only caller always passes '' (src/components/LoansView.tsx:105) — there is no 'create loan from this bank transaction' flow even though the allocation panel's loan target would be the natural home for it.
- To finish: Add Reopen button + confirm on Mark paid; make received_at editable end-to-end (UI + update_loan); add toasts (see bugs); either add a 'New loan from this transaction' affordance in the AllocationPanel loan target (pre-filling principal/date/bank_txn_id) or drop the dead bank_txn_id parameter.

### [HALF-BUILT] Auto-tag rules management (RulesCard)
- Where: src/components/FinancialsView.tsx
- Current state: Create/delete/apply work, but rules are device-local (explicitly not synced, commands.rs:10893-10897) with no UI mention — a second admin device silently has none of them; there is no edit (the code comments 'edit = delete then re-add', src/components/FinancialsView.tsx:2482); 'Apply rules now' has no busy/disabled state (2440-2445) so it can be double-fired; and the blank-category footgun (see critical bug) has no guard.
- To finish: Validate category on add; add a busy state to Apply rules now; note 'rules live on this device' in the help copy (or move txn_rule into the synced schema like everything else on this page); optionally an inline edit that reuses create_txn_rule's replace-on-same-counterparty behavior (commands.rs:10911-10916).

### [HALF-BUILT] Split mode (divide one payment across multiple deals)
- Where: src/components/FinancialsView.tsx
- Current state: Single-row split works end-to-end (checkbox at src/components/FinancialsView.tsx:2277-2288, allowSplit passed at 666, backend guard lift at commands.rs:9742-9748, running-remaining hint at 2066-2067/2281-2288). But the bulk path never passes allowSplit (bulkAllocate, FinancialsView.tsx:761-766), so any selected txn already partially allocated to a different deal fails with only an anonymous count; and the split hint's remaining figure only updates after refreshAll round-trips.
- To finish: Surface per-row failure reasons in runBulk (see bugs); decide whether bulk should ever split (probably not — but then pre-filter already-linked rows out of the selection with a message instead of failing them one by one).

### [HALF-BUILT] Plaid 'preparing' lifecycle
- Where: src/components/FinancialsView.tsx
- Current state: Connect → hosted-link poll → sync → background prep retries all built, but the retry chain dead-ends after ~2 minutes leaving the banner up forever (src/components/FinancialsView.tsx:346-363), and one transient poll error aborts the whole connect wait (408-412).
- To finish: Clear plaidPreparing on retry exhaustion with a toast; tolerate several consecutive poll errors before giving up.

### [HALF-BUILT] Backfill deal from bank receipt ('New deal from this transaction')
- Where: src/components/FinancialsView.tsx
- Current state: Creates client → invoice → deal → allocation in sequence (src/components/FinancialsView.tsx:793-816) but has no direction guard (orphans on money-out, see bugs), always creates a brand-new client even when one with the same name exists (798), and no rollback on partial failure.
- To finish: Gate to money-in transactions; match an existing client by name (offer a picker or reuse exact-match) before creating; wrap in a cleanup path (void/archive invoice + deal) if allocation fails.

## Financials backend (bank_txn / bank_allocation / free cash / loans / txn rules / Plaid / reconciliation) in src-tauri/src/commands.rs

**How it works today:** The financial engine is a coherent design: an immutable bank_txn ledger (statement imports in bank_import.rs, Plaid feed in plaid_sync), bank_allocation rows tying txns to deal_flows by role, and financials_overview computing Free Cash = bank balance minus invisible liabilities (supplier payables, refund liability, tax/refund reserves, cash floor, loans). Write paths are consistently synced (record_upsert/record_delete, push_now on the hot paths) and allocate_bank_txn enforces direction/role matching, exclusive links, and SUM(allocations) <= txn.amount locally. However, the headline Free Cash number is not bulletproof: the Plaid bank balance is frozen at link time (accounts_json is never refreshed), refund liability double-subtracts every bank-linked refund, tax/refund reserves sum deal_flows with no archived/voided/duplicate-invoice filtering, and supplier payables count fell-through deals forever. Three different commands compute "refunded" three different ways (refund_status_all is correct; deal_reconciliation and financials_overview disagree with it). The runway/status light is decorative because business_expense has no writer, and several roles/tables (refund_in, adjustment, cash_purchase, reserve_entry, txn_rule.role) are half-built. Reconciliation badge logic (reconciliation_status_all, refund_status_all) is comparatively healthy, and the ghost deal_flow problem is mitigated for allocations by reattach_orphaned_deal_allocations, but the ghost rows themselves still poison the deal_flows aggregates used by the reserves and payables.

**Data flow:** Free Cash headline: FreeCashView.tsx -> api.financialsOverview (src/lib/api.ts:2129) -> financials_overview (commands.rs:10551). Its formula (10610): free_cash = bank_balance - credit_card_balance - supplier_payables - refund_liability - tax_reserve - refund_reserve - cash_floor - loan_outstanding, where bank/card come from plaid_balances(link-time accounts_json snapshot, 10500-10523) or manual settings (money_* keys via read_setting_f64, 10492); supplier_payables from deal_flows.supplier_payments_json netted against role='supplier_payment' allocations (10565-10575); refund_liability from deal_flows.refund_owed minus refunds + refund_out allocations (10580-10589); reserves from SUM(net_profit)/SUM(gross_revenue) of stage='complete' deal_flows this year x settings pcts (10594-10603); loan_outstanding from loan.principal-set_aside (10606-10608); runway from business_expense (10613-10614, table has no writer so always 0). Ledger screen: FinancialsView.tsx -> list_bank_txns (commands.rs:9629, per-txn allocated/unallocated computed in SQL) + bank_txn_summary (9665) + a client-side rangeSummary recomputed from the txn list (FinancialsView.tsx:900-913). Pairing: unallocated_bank_txns (9922) -> allocate_bank_txn (9720, enforces direction/role, exclusivity, sum<=amount) -> bank_allocation; deal panel reads deal_allocations (9827) and deal_reconciliation (9965: actual_profit = buyer_payment - supplier_payment - fee - max(refund_out, refunds)). Badges: reconciliation_status_all (10031, complete non-archived flows, amount-based 50-cent tolerance) and refund_status_all (10065, non-bank-linked refunds + refund_out allocations). Ingest: bank_import/bank_import_ai -> bank_import.rs persist_rows (stable FNV id, INSERT OR IGNORE, record_upsert) and plaid_sync (commands.rs:10298, cursor-based, btpl_ ids) -> apply_txn_rules_impl pre-tagging (10961). All money mutations go through sync::record_upsert/record_delete (sync.rs ALLOWED_TABLES:422) to the droplet and other devices.

### [CRITICAL] Refund liability double-subtracts bank-linked refunds, overstating Free Cash
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10583
- Root cause: create_refund with a bank_txn_id writes BOTH a refunds row (commands.rs:4393-4396, keeping bank_txn_id at 4389) AND a bank_allocation role='refund_out' (4370-4373). financials_overview's refund_liability (commands.rs:10580-10589) computes per deal: refund_owed - SUM(all refunds rows) - SUM(refund_out allocations), with no bank_txn_id filter on the refunds side. A single $100 bank-linked refund is therefore subtracted twice ($200). Example: owed $200, one bank-linked refund of $100 paid -> remaining liability should be $100 but computes MAX(0, 200-100-100)=0, so free_cash (10610) is overstated by $100. refund_status_all (10073-10075) proves the intended pattern: it explicitly excludes bank-linked refunds rows (COALESCE(r.bank_txn_id,'')='') and counts the allocation side, 'to avoid double-counting'. The two commands disagree on the same deal today.
- Fix: In the refund_liability query, change the refunds subquery to match refund_status_all: (SELECT COALESCE(SUM(amount),0) FROM refunds r WHERE r.deal_flow_id=df.id AND COALESCE(r.bank_txn_id,'')='') so bank-linked refunds are only counted once via the refund_out allocation.

### [CRITICAL] Free Cash bank balance is frozen at Plaid link time — never refreshed
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10557
- Root cause: plaid_balances (commands.rs:10500-10523) reads balances.current out of plaid_items.accounts_json, which is written exactly once at link time (INSERT at 10228-10232 in plaid_connect_poll, 10254-10258 in plaid_exchange, netsync.rs:1125-1129 on materialize) and never UPDATEd anywhere — plaid_sync pulls transactions but never re-fetches balances, and plaid.rs has no /accounts/balance/get call at all (grep for 'balance' in plaid.rs returns nothing). financials_overview (10556-10558) then PREFERS this stale snapshot over the manually-set money_bank_balance whenever any plaid_items row exists ('Makes Free Cash real automatically' — it does the opposite). Every dollar that moved since link day is invisible to the headline free_cash (10610); the number silently diverges further every day and the manual config knob is dead once a bank is linked.
- Fix: Add a balances refresh: implement accounts_get/balances_get in plaid.rs, call it in plaid_sync (and plaid_refresh_sync) for each item, and UPDATE plaid_items SET accounts_json=?1. Alternatively derive the live balance from the last synced txn's running balance. Until then, at minimum stop preferring Plaid figures over the manual config, or surface the snapshot date in the UI.

### [MAJOR] Tax/refund reserves sum deal_flows with no archived, voided, refund, or duplicate-invoice handling
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10596
- Root cause: year_profit and year_revenue (commands.rs:10596-10601) are SELECT SUM(net_profit)/SUM(gross_revenue) FROM deal_flows WHERE stage='complete' AND completed_at >= start-of-year — with (a) no COALESCE(archived,0)=0 filter, so soft-deleted completed deals (delete_deal_flow, 5101-5114) keep inflating the reserves; (b) no dedup by invoice_id, so any of the KNOWN 28 non-archived ghost duplicate rows that reached stage='complete' double-counts — the codebase itself proves the required pattern at 9040-9044 ('COUNT(DISTINCT df.invoice_id) ... so duplicate flow rows can't inflate it'); (c) no join to invoices.voided, so a completed deal later marked fell-through still counts; (d) refunds are never subtracted even though the app's own P&L rule (deal_flow_payout, 4714-4718, eff_net = net - refunded) says refunds reduce profit. All four errors inflate tax_reserve (10602) and refund_reserve (10603), understating free_cash (10610).
- Fix: Rewrite both sums over the deduped survivor set: join a per-invoice highest-stage survivor subquery (same rank CASE as reattach_orphaned_deal_allocations, 9867-9870), add COALESCE(df.archived,0)=0 and a LEFT JOIN invoices to exclude COALESCE(i.voided,0)=1, and subtract per-deal refunds (non-bank-linked refunds + refund_out allocations, the refund_status_all formula) from both profit and revenue.

### [MAJOR] Supplier payables count fell-through deals and duplicate ghost rows forever
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10574
- Root cause: supplier_payables (commands.rs:10565-10575) sums unpaid supplier_payments_json entries for deals WHERE COALESCE(df.archived,0)=0 AND df.stage IN ('payment_received','supplier_paid'). Fell-through deals are NOT archived — set_deal_flow_fell_through (5121-5129) only voids the invoice and 'the deal_flow ... [is] untouched' — and this query never joins invoices.voided. A collapsed deal stuck at payment_received with unpaid supplier lines depresses free_cash permanently for money that will never be paid. Additionally there is no dedup by invoice_id: any non-archived ghost duplicate row (the KNOWN ISSUE: 15 invoices / 28 ghosts) sitting at payment_received/supplier_paid contributes its full unpaid supplier JSON a second time, and the netting subtraction (10570-10571) doesn't help because reattach_orphaned_deal_allocations (9863-9912) moved all allocations onto the survivor row.
- Fix: Add LEFT JOIN invoices i ON i.id=df.invoice_id with AND COALESCE(i.voided,0)=0, and restrict rows to the per-invoice survivor (df.id = highest-stage/newest non-archived row for its invoice_id, same subquery as 9877-9880) so ghost duplicates can't double the payable.

### [MAJOR] deal_reconciliation undercounts refunds vs refund_status_all (max() instead of split-sum)
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10002
- Root cause: deal_reconciliation computes refund_total = refund_out.max(refunds) (commands.rs:10002), where refunds sums ALL refunds rows (9983-9985, bank-linked included) and refund_out sums allocations (9980). When a deal has BOTH a cash refund (refunds row only, e.g. $100) AND a separate refund_out allocation paired directly in Financials with no refunds row (e.g. $50), true refunded = $150 but max(50,100)=100 — actual_profit (10003) is overstated by $50. refund_status_all computes the same quantity correctly as non-bank-linked refunds + all refund_out allocations (10073-10075), so the deal panel's reconciliation number and the refund pill on the same deal can disagree.
- Fix: Replace the max() with the refund_status_all formula: refund_total = SUM(refunds WHERE COALESCE(bank_txn_id,'')='') + SUM(bank_allocation role='refund_out'). Bank-linked refunds are then counted exactly once and the two commands agree.

### [MAJOR] plaid_sync advances the cursor past failed rows — permanent transaction loss in the ledger
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10437
- Root cause: Inside the added-txns loop: a sync::record_upsert failure does `continue` (commands.rs:10413) silently skipping that txn's local INSERT too, and a local INSERT failure sets status='error' and `break`s out of the added loop (10418-10424) skipping the REST of the page. In both cases execution falls through to cursor = next_cursor_now and UPDATE plaid_items SET cursor (10437-10438), so Plaid never re-serves those transactions — they are permanently missing from bank_txn, silently corrupting sum_in/sum_out and leaving real deposits unpairable. This is the same cursor-skip class as the v0.14.38 sync-replay bug and the launch-readiness 'sync cursor-skip' major.
- Fix: On any per-row persistence failure, stop WITHOUT persisting that page's cursor: set status='error' and break out of the page loop before the `cursor = next_cursor_now; UPDATE plaid_items` lines, so the next sync retries the same page (dedup via INSERT OR IGNORE and the id check at 10382 makes replays safe).

### [MAJOR] plaid_exchange has no item_id dedup — relinking a bank doubles the Plaid balance in Free Cash
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10254
- Root cause: plaid_connect_poll dedupes on item_id before inserting (commands.rs:10225-10233: 'SELECT 1 FROM plaid_items WHERE item_id=?1'), and materialize_plaid_item does too (netsync.rs:1114-1115), but plaid_exchange (10245-10263) INSERTs a new plaid_items row unconditionally. Linking the same institution again through the classic Link path creates two rows for the same item; plaid_balances (10510-10522) iterates every plaid_items row and sums balances, so the bank balance — and free_cash — doubles. Transactions don't duplicate (plaid_txn_id is stable + INSERT OR IGNORE at 10414-10417), which makes the doubled balance hard to notice.
- Fix: Mirror plaid_connect_poll: query 'SELECT 1 FROM plaid_items WHERE item_id=?1' after exchange() and skip the INSERT when it exists (optionally updating access_token/accounts_json on the existing row).

### [MAJOR] Archiving a deal flow strands its bank allocations: txns blocked from all pickers and still counted as actuals
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:5112
- Root cause: delete_deal_flow only sets archived=1 (commands.rs:5101-5114); its bank_allocation rows survive untouched. Consequences: (1) unallocated_bank_txns excludes any txn with an allocation to a different deal regardless of that deal's archived state (NOT EXISTS at 9932-9933), so a payment paired to a now-deleted deal never reappears in any picker — and since the archived deal is hidden from the pipeline, there is no UI path to remove the allocation; (2) financials_overview's allocated_actuals sums bank_allocation by role with no join to deal_flows (10631-10633), so archived-deal allocations still inflate buyer_in/supplier_paid/refunds_out; (3) with no FK constraints on bank_allocation (db.rs:1300-1311) nothing ever heals these rows — reattach_orphaned_deal_allocations only re-points ghosts among NON-archived rows (9876-9880).
- Fix: In delete_deal_flow, enumerate bank_allocation rows for the flow and remove them via sync::record_delete + local DELETE (freeing the txns), or exclude allocations whose deal is archived in unallocated_bank_txns' NOT EXISTS and in alloc_role_sum, plus a heal that drops allocations pointing at archived flows.

### [MINOR] Allocation invariants (sum <= txn amount, exclusivity) are only enforced locally — multi-device sync can break them silently
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:9758
- Root cause: allocate_bank_txn checks remaining amount (commands.rs:9758-9762) and exclusive-link (9735-9747) against the LOCAL db, but inbound sync applies bank_allocation rows through the generic per-column LWW apply_upsert (sync.rs:487-566) with no invariant re-validation. Two devices allocating the same txn concurrently both pass their local checks; after merge SUM(allocations) > bt.amount and/or the txn is linked to two deals. Nothing detects or heals this: list_bank_txns then reports a negative 'unallocated' (9657), deal_reconciliation double-books the money on both deals, and financials_overview netting subtracts more than was received.
- Fix: Add a post-sync heal (like reattach_orphaned_deal_allocations): after netsync apply, find bank_txns where SUM(allocations) > amount + 0.01 or with allocations to multiple deals without the split flag, and trim/flag the newer allocation; or enforce the invariant server-side on push.

### [MINOR] deal_flow_payout ignores refund_out allocations paired directly in Financials — rep cut and owner splits overstated
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:4714
- Root cause: deal_flow_payout sums refunded from the refunds table only (commands.rs:4714-4716) and computes eff_net = net - refunded (4717). A refund paired straight in Financials via allocate_bank_txn role='refund_out' creates no refunds row, so it is invisible here — refund_status_all's own comment (10068-10072) acknowledges this path exists and counts it. Result: for such deals the rep cut (4720) and split amounts (4730) are computed on an eff_net that ignores the refund, overpaying the rep/owners relative to the app's refund-aware P&L; the same deal's refund pill (refund_status_all) shows the refund but the payout breakdown doesn't.
- Fix: Compute refunded with the refund_status_all formula: SUM(refunds WHERE COALESCE(bank_txn_id,'')='') + SUM(bank_allocation WHERE deal_flow_id=? AND role='refund_out').

### [MINOR] bank_txn_summary money-in/out totals double-count internal transfers and credit-card spend; 'unallocated' counts can never reach zero
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:9670
- Root cause: sum_in/sum_out (commands.rs:9670-9671) sum every bank_txn by direction with no category exclusion: an internal transfer between own accounts adds to BOTH totals, and with a credit card connected via Plaid the same spend counts twice (the purchase 'out' on the card account + the card payment 'out' from checking — the 'card_payment' category from plaid_category at 10148 exists precisely to identify this but isn't excluded). unallocated_in/unallocated_out (9674-9682) exclude only internal_transfer, so loan proceeds (loan_received — tagging a txn to a loan creates no allocation, 10797-10820) and every ordinary business expense (meals, utilities...) count forever as 'not yet tied to a deal'; the backlog number can never reach zero once a live feed is connected. The frontend's own client-side rangeSummary repeats the sum_in/sum_out flaw (FinancialsView.tsx:908) though its needsDeal at least excludes loans (line 910).
- Fix: Exclude category IN ('internal_transfer','card_payment') from sum_in/sum_out; exclude loan_received/loan_repayment (or counterparty_type='loan') and expense-only categories from the unallocated_in/out counts, and mirror the same rules in FinancialsView.tsx's rangeSummary. Same fix applies to the stale_unallocated alert at 10622-10626.

### [MINOR] clear_bank_txns performs a bulk synced delete without push_now
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10133
- Root cause: clear_bank_txns (commands.rs:10102-10133) record_delete's every bank_txn and bank_allocation but never calls crate::netsync::push_now(), unlike every other allocation mutation (9781, 9791, 4397, 4456). Until the next poll interval, other devices (and the droplet) still hold the full ledger; a re-import or plaid_sync on another device in that window can interleave with the deletes and resurrect rows or leave allocation deltas half-applied.
- Fix: Add crate::netsync::push_now(); before Ok(json!(...)) when deleted+alloc_removed > 0.

### [MINOR] delete_loan leaves tagged txns and memorized rules pointing at the dead loan
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:10731
- Root cause: delete_loan (commands.rs:10731-10736) removes the loan row only. Bank txns tagged via tag_bank_txn_to_loan keep counterparty_type='loan'/counterparty_id=<deleted> (loan_ledger for that id silently still works but nothing links to it), and txn_rule rows with target_id=<deleted loan> keep matching: apply_txn_rules_impl looks up the loan name with unwrap_or_default (11010), so new feed txns get auto-tagged category='loan_received'/'loan_repayment' with an EMPTY counterparty_name pointing at a nonexistent loan — and those money-in rows are then excluded from the 'needs a deal' review flow by the loan checks.
- Fix: In delete_loan: DELETE FROM txn_rule WHERE target_type='loan' AND target_id=?1, and untag matching bank_txns (reuse untag_bank_txn_loan's column reset via record_upsert per txn) before deleting the loan.

### [HALF-BUILT] Runway / green-yellow-red status in financials_overview
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs
- Current state: trailing_opex reads business_expense (commands.rs:10613-10614) but NO command, view, or import path writes that table anywhere in the repo (only db.rs:1333 schema + sync allowlist). trailing_opex is always 0, runway is always infinity (returned as -1.0 at 10647), and status is 'green' whenever free_cash > 0 — the traffic light carries no information.
- To finish: Either build an expense writer (e.g. derive business_expense rows from reviewed money-out bank_txns in expense categories, or a manual expense command) or compute trailing opex directly from bank_txn money-out excluding transfers/supplier payments/card payments, then delete the dead table.

### [HALF-BUILT] refund_in and adjustment allocation roles
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs
- Current state: allocate_bank_txn accepts them (commands.rs:9752-9753) and FinancialsView offers 'Refund in' (FinancialsView.tsx:89,150), but NO computation reads them: deal_reconciliation sums only buyer_payment/supplier_payment/fee/refund_out (9977-9980), and financials_overview's allocated_actuals covers only three roles (10649-10653). A supplier refund paired as refund_in silently disappears from actual profit; 'adjustment' does nothing anywhere.
- To finish: Include refund_in as a supplier-cost offset (actual_profit += refund_in) in deal_reconciliation and expose it in allocated_actuals; define adjustment semantics (sign by txn direction) or remove both roles from the picker.

### [HALF-BUILT] cash_purchase and reserve_entry tables
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/db.rs
- Current state: Created in db.rs (1315-1331, 1347-1358) and sync-allowlisted (sync.rs:422) per the financial-engine plan, but zero readers or writers in backend or frontend — pure dead schema.
- To finish: Wire them per the original spec (cash purchases as supplier-cost actuals per deal; reserve_entry as the tax/refund sweep ledger replacing the pct-estimate reserves in financials_overview) or drop them from the allowlist to shrink the sync surface.

### [HALF-BUILT] txn_rule.role column
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs
- Current state: create_txn_rule stores role (commands.rs:10918-10920) and list_txn_rules returns it (10940), but apply_txn_rules_impl never selects or uses it (10966: only match_counterparty, category, target_type, target_id, direction) — a memorized rule can never auto-suggest an allocation role.
- To finish: Either use role in the apply pass (e.g. surface a suggested pairing role on matched txns) or stop storing it.

### [HALF-BUILT] loan.bank_txn_id link
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs
- Current state: create_loan captures the originating bank txn id (commands.rs:10684-10705) but nothing reads it — loan_ledger derives everything from counterparty tags (10846-10867), and creating a loan from a txn does NOT tag that txn, so a freshly created loan shows an empty ledger and received_total=0 until the user separately runs tag_bank_txn_to_loan on the same txn.
- To finish: In create_loan, when bank_txn_id is non-empty, call the tag logic (set counterparty_type='loan', counterparty_id, category='loan_received') so the ledger reflects the disbursement immediately.

### [HALF-BUILT] Plaid item removal vs org-shared secrets
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/netsync.rs
- Current state: plaid_remove_item (commands.rs:10284-10293) revokes at Plaid and deletes locally, but the item was also pushed to the server as an org secret (push_plaid_item_to_server, netsync.rs:1135) and materialize_all_secrets_from_server re-inserts any missing item_id (netsync.rs:1096-1097, 1112-1130) — a removed bank resurrects on the next secret materialize with a dead token, making plaid_sync report a per-item error forever.
- To finish: On plaid_remove_item, also DELETE the plaid_item_{item_id} org secret on the server (add an endpoint or push a tombstone), and have plaid_sync auto-remove items whose access token Plaid reports as revoked.

## Sticky Notes feature (desktop NotesView + notes sync + server /api/notes + mobile PWA notes tab) — upgrade-plan audit

**How it works today:** Notes are a shared org board: desktop CRUD lives in C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/commands.rs:12974-13069 (list/create/update/delete_note, per-column sync events + push_now on every write), the board UI in src/components/NotesView.tsx (drag, resize just shipped v0.15.71 via w/h from migration 67 at src-tauri/src/db.rs:1463-1471, live merge on the netsync-applied event), and CSS at src/index.css:948-974. The v0.15.71 resize is complete and correct on the desktop side (update_note accepts w/h at commands.rs:13045-13052, NOTE_COLS coalesces defaults at 12972, active-resize protected during merge at NotesView.tsx:72-81) — but the server repo HEAD has NO w/h columns or API support, so resize sync depends entirely on an uncommitted manual droplet backfill. Of the owner's four asks: (1) font scaling on resize does not exist at all (.sn-body is fixed 13.5px, index.css:966); (2) any-user edit/move/recolor/delete already works — the Notes tab needs no permission (src/lib/permissions.ts:26-27) and neither desktop commands nor server routes check authorship — but "live to all systems" is really "within 20 seconds" (POLL_SECS=20, netsync.rs:26; push is instant via push_now but peers only pull on their poll tick, and there is no pull_now), and the mobile PWA notes tab (clienthub-api/www/app.js:879-922) is fetch-once with no pin/move/resize; (3) no edit-lock exists — best fit is two new synced columns editing_by/editing_at on notes with a TTL, because the settings-table alternative is dead on arrival (settings is deliberately excluded from the server push whitelist, clienthub-api/src/sync.rs:1296-1306); (4) several real bugs found, the worst being that remotely-deleted notes resurrect on screen until the view remounts. Overall health: solid single-desktop feature with a well-built LWW sync spine, but the cross-system story (server schema, mobile parity, delete propagation to open views) has holes.

**Data flow:** Desktop write path: NotesView calls api.listNotes/createNote/updateNote/deleteNote (C:/Users/Jack/Desktop/BUSINESS APP/src/lib/api.ts:2058-2062) → tauri commands (src-tauri/src/commands.rs:12974-13069) → local SQLite notes table (schema: db.rs:966-989 + w/h migration 67 db.rs:1463-1471) + sync::record_upsert/record_delete (src-tauri/src/sync.rs:205-240, per-column HLC clocks) → netsync_outbound queue (netsync.rs:108-118) → push_now (netsync.rs:318-327, fired at commands.rs:13014/13056/13067) → server POST /api/sync/push (clienthub-api/src/routes/netsync.rs:27-37) → sync::push_events org-stamps, materializes into the server notes table, and appends accepted events to the per-org sync_events pull log (clienthub-api/src/sync.rs:1326-1383). Peer desktops pull every 20s (POLL_SECS netsync.rs:26, loop netsync.rs:289-312) → apply_upsert per-column LWW with tombstone guard (BUSINESS APP sync.rs:432-637) → emits "netsync-applied" → NotesView listener re-runs listNotes and merges into state, keeping the locally-active/focused/newer note (NotesView.tsx:67-88). Mobile/web PWA path: clienthub-api/www/app.js:890-922 renders GET /api/notes and writes via POST/PUT/DELETE /api/notes (clienthub-api/src/routes/notes.rs:16-160), which writes the server table AND sync::record_* so changes flow into every desktop's pull; the mobile list response carries only body/color/pinned/author/x/y — no w/h (routes/notes.rs:37-55).

### [MAJOR] Remotely deleted notes resurrect on the open board until remount
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx:82
- Root cause: The netsync-applied merge re-adds every previous note missing from the fresh listNotes result: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx:82 `for (const p of prev) if (!incIds.has(p.id)) merged.push(p)` — intended to protect a just-created local note the server hasn't echoed, but a note deleted on another device is also absent from `incoming` (apply_delete removed the row, sync.rs:611-637) and so gets pushed straight back into state. The delete only takes visual effect after leaving and re-entering the Notes tab (matches the known 'delete needs remount' symptom). Editing the ghost then emits an upsert event newer than the tombstone, which peers/server discard only because the stub insert violates created_at NOT NULL (BUSINESS APP sync.rs:566-583).
- Fix: Distinguish pending-creates from deletions: track ids created locally this session (a Set filled in addNote, cleared when the id appears in an incoming listNotes) and only re-add prev notes whose id is in that set; alternatively re-add only notes whose created_at is within ~30s. One-line concept: replace `if (!incIds.has(p.id))` with `if (!incIds.has(p.id) && pendingCreates.current.has(p.id))`.

### [MAJOR] Resize (w/h) sync depends on uncommitted droplet schema — server repo would silently drop resize events on redeploy
- Where: C:/Users/Jack/Desktop/clienthub-api/src/employees.rs:245
- Root cause: clienthub-api HEAD has no notes.w/h anywhere: schema.sql:466-475 ends at `x REAL, y REAL`, the idempotent ALTER list only adds x/y (src/employees.rs:245-246), and grep for 'ADD COLUMN w' finds nothing. Server apply_upsert has NO schema-drift tolerance (clienthub-api/src/sync.rs:981-1099 — unlike the desktop's existing_columns filter at BUSINESS APP sync.rs:524-536), so an event containing w/h against a notes table without those columns errors with 'no such column'. push_events then logs a warn and does NOT append the event to the org pull log (clienthub-api/src/sync.rs:1362-1377, only Ok(true) inserts into sync_events), while the desktop deletes the event from netsync_outbound on any HTTP-200 (BUSINESS APP netsync.rs:157-162) — the resize is permanently lost for every other device. Live sync presumably works today only because the droplet was ALTERed by hand ('droplet backfill', per v0.15.71 notes) — per the known scp-deploy divergence, that fix exists nowhere in the repo.
- Fix: Commit the schema: add `ALTER TABLE notes ADD COLUMN w REAL NOT NULL DEFAULT 226` / `... h REAL NOT NULL DEFAULT 190` to the idempotent ALTER list in employees.rs (next to the x/y ones at 245-246) and to schema.sql; also add w/h to NoteInput and the list SELECT in routes/notes.rs. Verify the droplet's actual notes schema before the next scp deploy. Longer-term: port the desktop's existing_columns drift filter into the server's apply_upsert so a lagged schema can never silently eat events again.

### [MAJOR] Pending body edit (600ms debounce) is lost on tab switch, and delete does not cancel the pending save
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx:158
- Root cause: editBody debounces the save 600ms (NotesView.tsx:158-162, timers in saveTimers ref at line 46). NotesView unmounts whenever the tab changes (App.tsx:495 renders it only for t==='notes'), and no cleanup effect flushes or fires the pending timers — type, switch tabs within 600ms, and the last keystrokes never reach api.updateNote (state is also discarded). Separately remove() (NotesView.tsx:171-175) deletes without clearTimeout(saveTimers.current[id]), so a pending body save can fire AFTER deleteNote, emitting a post-tombstone upsert event (harmless today only because the stub insert trips created_at NOT NULL on peers, BUSINESS APP sync.rs:566-583, clienthub-api sync.rs:1064-1070).
- Fix: Add a useEffect cleanup that on unmount iterates saveTimers.current, clearTimeout each, and synchronously fires api.updateNote(id,{body}) for any pending id (keep last-pending body in a ref alongside the timer). In remove(), clearTimeout(saveTimers.current[id]) and delete the entry before calling api.deleteNote.

### [MINOR] Color/pin/move/resize saves can be visually reverted by a concurrent sync merge (no updated_at bump)
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx:79
- Root cause: The merge keeps the local copy only if the note is actively dragged/resized/focused OR local.updated_at > inc.updated_at (NotesView.tsx:79). Only editBody bumps local updated_at (line 159); setColor (163-166), togglePin (167-170), and the drag/resize saves (112-124, which run after drag.current/resize.current are already nulled) leave local updated_at unchanged. If a netsync-applied fires between the optimistic state change and the DB write landing (listNotes snapshot reads the pre-save row), the incoming stale copy wins the merge and the note visibly snaps back (old color / old position) until the next event. Narrow race but real during simultaneous two-user activity — exactly the scenario the owner is building for.
- Fix: Bump updated_at: new Date().toISOString() in setColor/togglePin and in the pointerup save path (set it on the note in state when calling api.updateNote), mirroring editBody line 159 — the existing local.updated_at > inc.updated_at guard then protects all local mutations equally.

### [MINOR] LWW UI comparison mixes two timestamp formats (JS 'Z' vs Rust '+00:00')
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx:79
- Root cause: NotesView.tsx:79 string-compares updated_at values. Local edits stamp JS toISOString() format '...789Z' (NotesView.tsx:159) while DB/incoming rows carry chrono to_rfc3339 '...789123+00:00' (commands.rs:13020). Lexicographic comparison across the two formats is only chronologically correct down to the shared millisecond prefix; within the same millisecond 'Z' (0x5A) beats any digit, so ties break toward the JS-stamped copy. Cosmetic-scale today, but it will matter for edit-lock TTL math if editing_at reuses the same comparison.
- Fix: Compare epoch numbers: `new Date(local.updated_at).getTime() > new Date(inc.updated_at).getTime()` (Date parses both formats), or normalize local stamps to the Rust format.

### [MINOR] Server /api/notes neither returns nor accepts w/h — mobile can never see or set sizes
- Where: C:/Users/Jack/Desktop/clienthub-api/src/routes/notes.rs:37
- Root cause: The list SELECT returns only id/body/color/pinned/author/created_at/updated_at/x/y (clienthub-api/src/routes/notes.rs:37-55) and NoteInput has only body/color/pinned/x/y (lines 64-71), so even after the server table gains w/h, the REST surface used by the mobile PWA drops them. Not desktop-breaking (desktop syncs via the oplog, and mobile PUTs only the fields it sends), but it blocks 'every system' parity for sizing.
- Fix: Add COALESCE(w,226)/COALESCE(h,190) to the list SELECT and w/h Option<f64> fields to NoteInput with matching UPDATE branches and sync cols (mirror the x/y handling at lines 131-138). Deploy as a matched set with the schema ALTER per the scp-divergence rule.

### [HALF-BUILT] Ask 1 — font size scales with note size
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx
- Current state: Not started. .sn-body is a fixed 13.5px (C:/Users/Jack/Desktop/BUSINESS APP/src/index.css:966); the note div gets width/height from w/h (NotesView.tsx:219) but nothing derives typography from them.
- To finish: Pure frontend: compute a scale per note, e.g. const scale = Math.min(1.8, Math.sqrt((wOf(n)*hOf(n))/(226*190))), and set style={{ fontSize: `${13.5*scale}px`, lineHeight: 1.5 }} on the textarea at NotesView.tsx:228-229 (optionally scale .sn-time too). Live-updates during resize for free because resize writes w/h into state each pointermove (line 98). No backend change; nothing to sync since peers derive the same size from w/h.

### [HALF-BUILT] Ask 2 — everyone edits + live sync to all systems
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/netsync.rs
- Current state: Permissions: DONE — Notes tab requires no permission (src/lib/permissions.ts:26-27), desktop commands have zero author/role checks (commands.rs:12974-13069), server routes only org-check (clienthub-api/src/routes/notes.rs:22-31). Desktop-to-desktop liveness: sender pushes instantly (push_now, commands.rs:13014/13056/13067) but receivers see it only on their 20s poll (POLL_SECS netsync.rs:26; no pull_now exists — only the loop at netsync.rs:289-312 calls pull_apply). Mobile PWA: notes tab exists (clienthub-api/www/app.js:890-922) but is fetch-once (no refresh), grid-only (no board/x/y/w/h), and noteCard has no pin control (app.js:879-888).
- To finish: For near-live: add a pub fn pull_now() beside push_now (netsync.rs:318) exposed as a tauri command, and have NotesView poll it every ~5s while mounted (and on window focus) — keeps the global 20s loop untouched while making the board feel live. For mobile: re-fetch on visibilitychange/interval, add the pin button, and (optional) size display once /api/notes carries w/h.

### [HALF-BUILT] Ask 3 — temporary edit-lock
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src-tauri/src/db.rs
- Current state: Nothing exists. Design constraints proven from code: settings-table locks CANNOT work — the server push whitelist deliberately excludes settings (clienthub-api/src/sync.rs:1296-1306), so a desktop-written lock row would never leave the device; the notes sync path is per-column LWW with HLC clocks (BUSINESS APP sync.rs:508-533), which merges independent columns cleanly.
- To finish: Recommended: two synced columns on notes — migration 68 `ALTER TABLE notes ADD COLUMN editing_by TEXT NOT NULL DEFAULT ''` + `editing_at TEXT NOT NULL DEFAULT ''` (desktop db.rs migrations list, matching server ALTERs in clienthub-api employees.rs + schema.sql + droplet backfill). Acquire on textarea focus via update_note(editing_by=me, editing_at=now)+push_now; renew piggybacked on the body debounce save but throttled to ~1/30s; release on blur/unmount/delete (columns die with the row). Peers: in the netsync-applied merge, if inc.editing_by is another user AND now-editing_at < TTL (~75s, i.e. >3 poll ticks), render that textarea readOnly with a small '<name> is editing' chip and let the incoming copy win the merge. Simultaneous acquires resolve by column LWW; the loser sees the winner's lock within one pull and yields — advisory, not airtight, because peers lag up to 20s (pair with the pull_now item above to shrink the window to ~5s). Use account id + display name (author is currently only a display-name string, commands.rs:12989) so name collisions can't steal locks. Rejected alternatives: settings table (unsyncable via push, see above, plus the known unscoped-settings gap) and an ephemeral server lock endpoint (zero oplog noise and true real-time, but new server surface + separate HTTP polling outside netsync + useless offline — only worth it if sub-5s locking becomes a hard requirement).

### [HALF-BUILT] Resize v0.15.71 verification
- Where: C:/Users/Jack/Desktop/clienthub-api/src/schema.sql
- Current state: Desktop side VERIFIED complete: migration 67 (db.rs:1463-1471), NOTE_COLS coalesce (commands.rs:12972), update_note w/h branches (commands.rs:13045-13052), resize handle + pointer logic (NotesView.tsx:139-145, 92-119), merge protects active resize (NotesView.tsx:72-81), push_now on save (commands.rs:13056). Server side NOT in repo — works only via manual droplet state (see major bug).
- To finish: Commit server w/h migration + routes exposure + drift-tolerant apply (bug #2 fix); then resize is genuinely done end-to-end.

### [HALF-BUILT] Ask 4 — general polish candidates observed in code
- Where: C:/Users/Jack/Desktop/BUSINESS APP/src/components/NotesView.tsx
- Current state: No bring-to-front: zIndex is fixed pinned?5:1 (NotesView.tsx:219), so a dragged note can stay buried under overlapping notes. No resize upper bound and resize ignores board width (only drag clamps x, NotesView.tsx:107). Delete uses blocking native confirm() (NotesView.tsx:172). Empty notes are created immediately on 'New note' (commands.rs:12985 inserts body='') and never cleaned if abandoned. The one-time zero-position layout writes N updateNote calls in a loop (NotesView.tsx:51-56).
- To finish: Bring-to-front: keep a lastTouched ref and give the active note a higher zIndex (pure state, nothing to sync). Cap resize at board width. Replace confirm() with the app's styled confirm. Optionally delete a note whose body is empty on blur after ~30s. All frontend-only.
