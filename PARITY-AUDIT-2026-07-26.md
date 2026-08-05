# MOBILE PARITY AUDIT — 2026-07-26

4-agent sweep (coverage/actions, re-derivation/stale-cache, layout/info, synthesis) over desktop 57 views / mobile app.js 6.7k lines / server routes.
Complements PARITY-PLAN.md (2026-07-18, 102 findings) — deduplicated against it and against items fixed on 2026-07-25/26.
89 findings: 11 P0, 48 P1, 24 P2, 6 desktop-side, 12 missing screens, 7 decisions, 6 structural class-killers.

> ROUND 0 IS URGENT: five P0s are ACTIVE DATA DESTRUCTION on ordinary mobile use (narrow mobile forms -> absent JSON keys -> server writes NULL over columns mobile never showed -> record_upsert propagates the loss to every desktop). Server-only fix.

---

# SYNTHESIZED PLAN

# MOBILE ↔ DESKTOP PARITY — SINGLE PRIORITIZED FIX PLAN

Synthesized from Audit A (coverage/actions), B (re-derivation/stale cache), C (layout/info). Deduplicated against PARITY-PLAN.md, the 7 already-fixed items, and the 5 in-flight items. Paths: desktop `C:/Users/Jack/Desktop/BUSINESS APP/`, server+mobile `C:/Users/Jack/Desktop/clienthub-api/`.

Verified live during synthesis (so the plan is not built on stale audit text):
- `Invoice.client_name` **is** now on the server (`src/models.rs:136-140`, `src/routes/invoices.rs:198` col 28) — the known root cause is fixed server-side; mobile has **not** switched over.
- `Deal` has **no** `client_name` (`src/models.rs:143-164`) — same pattern, still broken.
- `SupplierPayment` has **no** `kept` (`src/models.rs:167-183`); `write_sp` sums unfiltered (`src/routes/deal_flows.rs:185-187`, 6 call sites at `:670,729,773,806,852,903`).
- `update_supplier` unconditionally overwrites all 10 columns (`src/routes/suppliers.rs:133-157`).
- `save_company` stores the raw request body verbatim (`src/routes/settings.rs:358-378`).
- `buyer_tiers` returns **labels** and omits `overdue` from `invoices_sent` and does not net refunds (`src/routes/clients.rs:925-928`, `:1030-1043`).
- `list_inventory` selects 18 columns, **no** `details_json`, **no** `updated_at` (`src/routes/inventory.rs:212-244`).
- Mobile `tierCode` already accepts codes *and* labels (`www/app.js:1596-1598`), and mobile brief already assumes **codes** (`app.js:5880-5881`) — so flipping the server to codes is safe and self-consistent.

---

## STRUCTURAL FIXES — each kills a whole class

**S1. Make every mobile-facing write endpoint merge-on-write instead of full-column overwrite.**
Root of 4 of the 11 P0s. Mobile forms are narrower than desktop forms, so absent JSON keys deserialize to `None` and the server writes NULL into columns mobile never showed the user — then `record_upsert` propagates the loss to every desktop.
Instances: `src/routes/suppliers.rs:133-157` (address/payment_method/payment_details/payment_terms/typical_lead_time), `src/routes/settings.rs:358-378` (company phone/tax_id/logo_path), `src/routes/inventory.rs:373-402` (price_type/asking_price), `src/routes/clients.rs:272-275` (accepts `Some("")` for lead_status).
Fix: for each, read the stored row first and only write keys present in the body (`Option<Option<T>>` with `#[serde(default, deserialize_with = double_option)]`, or `COALESCE(?n, col)` in the UPDATE plus the same merge before `record_upsert`). `update_client` already does this for metadata (`clients.rs:276-295`) — generalize that helper. **Do this first; it is the only bucket that is actively destroying data on every mobile save.**

**S2. Make every server JSON-blob struct lossless against its desktop twin.**
`SupplierPayment` (`src/models.rs:167-183`) is missing `kept` (desktop `src-tauri/src/commands.rs:3552-3557`), so every mobile deal-flow action strips it. Fix: add the field **and** add `#[serde(flatten)] pub extra: serde_json::Map<String, Value>` to `SupplierPayment` and every other blob struct that round-trips desktop JSON, so any future desktop-only field survives a mobile write forever. Then audit `src/models.rs` blob structs field-for-field against `src-tauri/src/commands.rs`.

**S3. Have REST list endpoints return the same joined/derived fields the desktop commands return, so mobile stops re-deriving.**
Mobile currently recomputes profit, margin, tiers, names, refund state and payout splits in JS from partial payloads — every one of those re-derivations is a divergence bug. Add to the payloads: `Deal.client_name`; inventory `details_json` + `updated_at`; per-invoice `flow_supplier_cost` + `flow_stage_is_complete` + `refund_total`/`refund_remaining`; per-deal-flow `needs_review` + `completed_at` ordering + `actual_profit`/`refund_total`/`rep_cut`/`payout_shares`. This single change closes B-4, B-7, B-11, C-8, C-9, C-12, C-13, C-27, C-36 at once.

**S4. Stop treating boot-cached globals as truth.**
`_clients`, `_suppliers`, `_clientTiers` are loaded at boot (`app.js:497-503,603`) and only refreshed by `syncNow` (`:528`). They drive newsletter recipient id lists (`:6351`), name lookups (`:3136,3989,4002,4209,2407`), the Clients count (`:3336`), pickers (`:4138,5357,5508`) and the rep home (`:2981`). Fix: refetch on screen entry for anything that *sends* or *counts*, and move newsletter audience resolution server-side (`mode:'filter'` with the tier/exclusion state) instead of POSTing a client-side id list.

**S5. One canonical enum vocabulary per field, asserted in both codebases.**
Divergent today: `lead_status` (desktop db comment `src-tauri/src/db.rs:383` = `prospect|hot_lead|warm|active_customer|inactive`; desktop's own New-Client form writes `"hot lead"`/`"active customer"` with spaces at `ClientsView.tsx:869-875`; mobile writes `active` at `app.js:3794`), `price_type` (`custom` missing from `app.js:3650`), tiers (codes vs labels), approval `kind` labels (`app.js:2721`). Fix: a single shared list, and a one-off audit of **every `<select>` in app.js** against its desktop option list — the audit's own cross-cutting note.

**S6. Delete the dead `loadDealFlows` block; it holds the only implementation of three real actions.**
`app.js:4840-4924` renders into `#df-list`, a container `renderDealFlows` (`:4580-4593`) never creates. Reopen (`:4877,4911-4913`) and delete (`:4878,4915-4919`) live only there. The refund UI (`:4988,5006-5010,5043-5047`) is gated on `df.stage === 'complete'` inside `toggleDfExpand`, which is bound only to **active** cards (`:4788`) — completed deals render through `renderDfDrawer` (`:4688,4700-4732`) which never calls it. Fix: delete the dead path and re-wire refunds/reopen/delete into the live renderers.

---

## P0 — wrong money, misleading numbers, or blocks real work (11)

### Pure SERVER Rust — cheapest, deploys instantly to every phone (5)

**P0-1 · Mobile supplier-payment actions erase every `kept` flag and re-add kept money as cost.**
Desktop: `src-tauri/src/commands.rs:3552-3557` (field), `:3676-3679` (`total = payments.iter().filter(|p| !p.kept).sum()`).
Server: `src/models.rs:167-183` has no `kept`; `src/routes/deal_flows.rs:185-187` sums unfiltered; 6 call sites `deal_flows.rs:670,729,773,806,852,903`.
Fix: add `kept: bool` (+ S2 flatten) to `SupplierPayment` and change `write_sp`'s total to `.filter(|p| !p.kept)`. Recorded profit on every affected deal drops by the kept amount on all devices until this ships.

**P0-2 · Mobile supplier edit permanently NULLs address + all 4 payment fields org-wide.**
Server: `src/routes/suppliers.rs:133-157` (+`record_upsert` `:144`); mobile form has 5 of 10 fields (`www/app.js:2229-2237`, PUT `:2264-2270`).
Fix: S1 merge-on-write. (Mobile-side field additions are MP1-14.)

**P0-3 · Mobile "Save Company" strips company phone, tax ID and logo_path from every future PDF.**
Server: `src/routes/settings.rs:358-378` writes the raw body. Mobile sends 3 keys (`app.js:6239-6243`) vs desktop's 6 (`src/components/SettingsView.tsx:1481`, model `src/models.rs:334-341`).
Fix: read stored `company_info`, merge the posted keys over it, then write. (Logo half is in PARITY-PLAN; the phone/tax_id loss is not.)

**P0-4 · Opening + saving an "Active Customer" on mobile blanks their pipeline status everywhere.**
`app.js:3821` assigns `'active_customer'` into a `<select>` with no such option → `selectedIndex = -1`, `.value === ''`; `:3841` PUTs `lead_status: ''`; `src/routes/clients.rs:272-275` accepts `Some("")` verbatim. The approval editor demotes to Prospect instead (`app.js:2888`).
Fix (server, immediate): reject/ignore empty-string `lead_status` and normalize `"active"`/`"hot lead"`/`"active customer"` → canonical, reusing `src-tauri/src/csv_import.rs:182`'s mapping. Mobile option list = MP1-1. **Vocabulary choice needs a decision — see D-3.**

**P0-5 · Editing a "make an offer" lot on mobile destroys its pricing and publishes $0 to the public storefront.**
Mobile `<select id="f-ptype">` has no `custom` (`app.js:3650`) → edit PUTs `price_type:'per_unit', asking_price:0`; server applies it (`src/routes/inventory.rs:373-378`) and `record_upsert`s to desktop + storefront (`:402`). Desktop guards `custom` in every money helper (`src/components/InventoryView.tsx:368-372,1666`).
Fix (server, immediate): S1 merge-on-write on inventory so an absent `price_type`/`asking_price` can never overwrite, and add `details_json` + `updated_at` to `list_inventory` (`inventory.rs:212-244`). Mobile `custom` handling = MP0-4.

### Mobile www/app.js (6)

**P0-6 · Completed-deal P&L and Profit Split ignore bank reconciliation, refunds and the rep cut.**
Desktop: bank actuals win — `src/components/CompletedBreakdown.tsx:24-29`, `actual_profit` at `src-tauri/src/commands.rs:11156`; payout splits `remaining = eff_net − rep_cut` (`commands.rs:4974-4991`) and re-derive from stored **percentages** (`shares_from_breakdown`).
Mobile: `app.js:4988-5004` uses raw `df.gross_revenue/total_cost/net_profit`; `dealPayoutSplit` (`:569-578`) replays frozen **dollar** amounts or splits raw `net_profit`; same at `:4675,4710-4719`.
Fix: server returns `actual_profit`/`refund_total`/`rep_cut`/`payout_shares` per completed flow (S3); mobile renders them instead of re-deriving. Today owners see themselves splitting money desktop has already deducted.

**P0-7 · There is no path on mobile to record or even see a refund.**
Desktop mounts `RefundWorkspace` in three places (`DealFlowView.tsx:382,660`, `CompletedBreakdown.tsx:305`, `InvoicesView.tsx:1012`). Mobile's refund UI is orphaned per S6.
Fix: render the refunds list + `Record refund` inside `renderDfDrawer`'s completed expander (`app.js:4700-4732`) and in the invoice detail. PARITY-PLAN's "mobile can record refunds" line is **stale**.

**P0-8 · A PAID invoice cannot be marked "fell through" on mobile.**
Desktop offers void for any non-voided invoice (`InvoicesView.tsx:419-423`, `:1053-1056`). Mobile emits `btn-void-inv` only in the `sent`/`overdue` branch (`app.js:4272-4277`); the `paid` branch is View PDF + Archive (`:4278-4281`).
Fix: add void to the paid branch. This is the INV-2026-0038 class — mobile keeps counting revenue desktop can zero. (Audit C scored this P2; reclassified P0 because it is unrecoverable revenue overstatement.)

**P0-9 · "Mark all suppliers paid" turns a kept cut into a real payable.**
Desktop `hasSuppliers ? payments.every(p => p.paid || p.kept)` (`DealFlowView.tsx:473`, `:1071`). Mobile `const hasUnpaid = payments.some(p => !p.paid)` (`app.js:4747`) drives the button at `:4776`.
Fix: `p.paid || p.kept`, plus a `kept` badge on the payment row. (Pair with P0-1 or the flag won't exist to read.)

**P0-10 · Stale-listing approvals are mislabeled — tapping "Reject" silently marks the lot SOLD.**
Desktop gives `listing_stale` its own section with explicit **Renew** / **Mark sold** (`ApprovalsView.tsx:118,166-188`). Mobile's `kindLabel` handles only `client_add`/`client_delete` and falls through to the raw kind (`app.js:2721`) with generic Approve/Reject (`:2731-2732`). Server: reject → `set_lot_sold` (`src/routes/approvals.rs:257-260`).
Fix: per-kind labels and per-kind button captions in `renderApprovals`. (Audit A scored P1; reclassified P0 — an unlabeled destructive action on live storefront inventory.)

**P0-11 · Mobile writes `lead_status:'active'`, a value nothing else in the system understands.**
Counts/filters at `app.js:2982,3338,3365` test `=== 'active'`; desktop counts `active_customer` (`ClientsView.tsx:94,313`). Result: mobile's "Active" tile and pill are permanently **0/empty**, and mobile-created clients show an unlabeled badge on desktop (`ClientsView.tsx:205`, `ClientDetailView.tsx:61`).
Fix: mobile option values → canonical set; add the missing badge CSS (MP2-4). Needs D-3 first.

---

## P1 — missing feature / field / wrong display

### Pure SERVER Rust — query or payload only, no new UI thinking (9)

| # | Problem | Change |
|---|---|---|
**SP1-1** | `/api/deals` returns no `client_name`, so mobile prints a raw id fragment as the client **and** as the deal title | `src/models.rs:143-164` + the deals SELECT: add the same `COALESCE((SELECT name FROM clients …),'')` join used at `src/routes/invoices.rs:198`. Mobile `app.js:2407-2431` then reads it (desktop shows "Unknown", `DealsView.tsx:222`)
**SP1-2** | `buyer_tiers` returns **labels** while desktop and mobile's own brief use **codes** → tier newsletters resolve to 0 recipients and every tier badge renders Prospect-gray | `src/routes/clients.rs:1030-1043` → emit `"P"/"S"/"A"/"B"/"C"/"Prospect"` like `src-tauri/src/commands.rs:1750-1758`. Verified safe: `tierCode` (`app.js:1596-1598`) already accepts codes, `TIER_META`/`tierBadgeHTML` are code-keyed, brief already assumes codes (`app.js:5880`). Fixes B-5, B-15/C-15 for free
**SP1-3** | Same query doesn't net refunds (`clients.rs:923` raw `SUM(paid)` vs desktop `net_paid` `commands.rs:1845,1765-1775`) → mobile over-tiers refunded clients | Subtract `refunded_by_client`. **Needs D-1 (desktop is internally inconsistent too)**
**SP1-4** | Same query omits `overdue` from `invoices_sent` (`clients.rs:924` vs `commands.rs:1814`, with desktop's explicit comment at `:9441-9443` that dropping it "could demote a client a full tier") | add `'overdue'` to the `IN (…)` list
**SP1-5** | `/api/inventory` omits `details_json` and `updated_at` → condition, variants, extra categories, `price_text`, `prev_price` and the 2-day stale flow are all impossible on mobile | `src/routes/inventory.rs:212-244`: select both. Desktop reads them at `src/lib/api.ts:1176-1196`, `InventoryView.tsx:25,796,1380,2083`
**SP1-6** | Invoice list carries no deal-flow cost → mobile can't show desktop's projected profit | add `flow_supplier_cost` + `flow_stage` to `INVOICE_COLS` (`invoices.rs:198`) so mobile can mirror `InvoicesView.tsx:343-358`
**SP1-7** | Invoice list carries no refund state → refunded invoices look like clean paid sales and can't be excluded from the active tab | add `refund_total`/`refund_remaining`; desktop uses `refundMap` (`InvoicesView.tsx:170-175,384-389`)
**SP1-8** | Deal-flow list has no `needs_review` and is ordered `updated_at DESC` (`deal_flows.rs:1126`) instead of close date | add `needs_review`, and expose `completed_at` ordering to match `DealFlowView.tsx:144-165`
**SP1-9** | `/api/dashboard/stats` already returns `top_suppliers` and `top_clients_by_profit` (`src/routes/dashboard.rs:288,304`) — nothing consumes them | no server work; listed here so it isn't mistaken for a payload gap. See MP1-24

### New server routes required before any mobile UI can exist (9)

| Action | Desktop call | Route to add |
|---|---|---|
Supplier "didn't pay — kept it" toggle | `api.setSupplierPaymentKept` (`DealFlowView.tsx:1108-1113`, `src/lib/api.ts:1919`) | none in `src/routes/deal_flows.rs:18-60` — **P1 money**
Set `payout_included` on an already-completed deal | `api.setDealPayoutIncluded` (`CompletedBreakdown.tsx:88-99`) | none — **P1 money**; and reopen (below) blocks the workaround
Recalculate deal from bank | `api.recalcDealFromBank` (`DealFlowView.tsx:1647`) | none — **P1**
Resubscribe a client | `api.resubscribeClient` (`ClientDetailView.tsx:344`) | none (only the sync-apply side, `src/sync.rs:1226-1251`) — **P1**, an accidental unsubscribe is permanent from a phone
Portal link generate/revoke | `src-tauri/src/commands.rs:8536,8563` | none, **and** `client_portal_tokens` is in neither sync allowlist — **P1**, see D-2
Storefront offers admin read + accept/decline | `api.listOffers`/`setOfferStatus`/`deleteOffer` (`InventoryView.tsx:157,2139-2141`) | only public `POST` (`src/routes/storefront.rs:306,323`) — **P1**, a live inbound buyer lead is invisible on mobile
Recurring invoice templates CRUD | `RecurringView.tsx:19-70` | none — **P1**
Hosted lead-form CRUD | `FormsPanel.tsx:34-53` | only `/f/:id` + submit (`src/routes/forms.rs:18-19`) — **P2**
Quote threaded send | `api.sendQuote(id, threaded)` (`QuotesView.tsx:80-91`) | `src/routes/quotes.rs` has no threading; mobile posts an empty body (`app.js:2350`) — **P2**

**Already live, mobile just never calls them (free wins):** `PUT /api/deal-flows/:id/completed-at` (`deal_flows.rs:56-59`), `DELETE /api/deal-flows/:id` (`:22-25`), `POST /api/deal-flows/:id/uncomplete`, `PATCH /api/staff/deals/:id/lead-rep` (`src/staff_api.rs:500-502,1431`), `PUT /api/deal-flows/:id/notes` and `/name` (`:27-28`).

### Mobile www/app.js — P1 (30)

**Money / correctness**
- **MP1-1** Newsletter tier audience compares codes against labels → "No recipients" for every tier preset (`app.js:6360-6363` vs `RANKED_TIERS` `:6325`, `TIER_PRESETS` `:6326`). Route through `tierCode()` even after SP1-2, defensively. Blocks tier-targeted sends entirely.
- **MP1-2** Newsletter recipient ids built from boot-cached `_clients` (`app.js:6351`, `mode:'ids'` at `:6626-6630`) → clients added since page load are silently dropped and the confirm count is wrong. Desktop refetches (`EmailView.tsx:648`). Prefer server-side filter (S4).
- **MP1-3** "Outstanding" has three definitions: mobile `sent||overdue` (`app.js:3925`), desktop all-non-paid-non-void (`InvoicesView.tsx:192`), server committed-AR (`src/routes/dashboard.rs:132`). Pick one — **D-4**.
- **MP1-4** Invoice row profit omits the projected-from-deal-flow branch and the `proj` chip (`app.js:3997` vs `InvoicesView.tsx:343-358,370-378`) → mid-flight deals read as booked 100%-margin profit.
- **MP1-5** Analytics MoM delta includes the in-progress month, which desktop deliberately excludes with a comment (`AnalyticsView.tsx:208-214` vs `app.js:1777-1783`) → a fake "▼ x% vs last month" next to a `profit_mtd` hero; worse when `monthly_profit` has month gaps (`dashboard.rs:146-150`).
- **MP1-6** Active deal list doesn't exclude refund deals (`app.js:4632` vs `DealFlowView.tsx:144-147` "ANY deal with refund activity … never shows in the active list"); same omission on Invoices (`app.js:3982` vs `InvoicesView.tsx:169-175`).
- **MP1-7** Completed drawer hides the `⚠ N need review` count and "Sync from bank" (`app.js:4666-4672` vs `DealFlowView.tsx:274-289`).
- **MP1-8** No refund indicator on invoice rows (`app.js:3993-4013` vs `InvoicesView.tsx:384-389`).
- **MP1-9** Invoice list drops the **Due date** column and the **Total profit** stat (`app.js:3929-3999` vs `InvoicesView.tsx:267-274,331-337`) — due date is the core AR-chase read.

**Workflow unblocks using routes that already exist**
- **MP1-10** Reopen a completed deal — only in dead code (`app.js:4877,4911-4913`; desktop `CloseoutView.tsx:253`, `InvoicesView.tsx:412-417`).
- **MP1-11** Delete/archive a deal flow — only in dead code (`app.js:4878,4915-4919`; desktop `CloseoutView.tsx:261`, `DealFlowView.tsx:745`).
- **MP1-12** Correct a completed deal's `completed_at` — zero references in app.js; desktop `CloseoutView.tsx:245`. A wrong date lands profit in the wrong month permanently.
- **MP1-13** Assign the lead rep — zero calls (mobile only *reads* `metadata.lead_representative` at `app.js:3431`); desktop `RefundPanel.tsx:63-65`. Mobile is the **only** surface with the rep payout statement (`app.js:1191-1227`) yet can't assign the rep that feeds it — everything sits under "Unassigned" (`:1217`).
- **MP1-14** Supplier-payment edit/remove/unmark-paid are gated to `stage === 'payment_received'` (`app.js:5163-5168`); desktop allows them at any stage and re-runs `recalcDealFromBank` when complete (`DealFlowView.tsx:878-882,1103-1106`).
- **MP1-15** Receivables: no **Record payment** (desktop `ReceivablesView.tsx:274,321` + modal `:110-153`); `due_soon` "lands in 7 days" is hidden because `_arCommittedOnly` defaults `true` (`app.js:1845,1928`, desktop renders it unconditionally `:254-257`); no last-contact line (`app.js:1971` vs `ReceivablesView.tsx:203,317`).
- **MP1-16** Payables: no **Mark supplier cost paid** (`app.js:2045-2063` vs `PayablesView.tsx:105-112`). AR and AP are the two screens a broker works from on the road and neither can clear anything.
- **MP1-17** AR/AP drill-down into a **completed** deal silently no-ops: `openDealFlowById` looks for `.df-card[data-id]` (`app.js:4644-4656`) but completed rows are `.df-done-row[data-dfid]` (`:4677`).
- **MP1-18** Pull-to-refresh / Sync throws you out of Approvals, Checkup, My account, Payout setup, Feedback, Waitlist — `syncNow` ends with `await render(currentTab)` (`app.js:521-541`, wired at `:340,2703`) but the router (`:721-744`) and `MORE_TABS` (`:700`) have no case for them, so `currentTab` still points at the previous screen and in-progress checkup notes are discarded (blur-save with swallowed catch, `:1415`). **Regression introduced by the new refresh button.**
- **MP1-19** Supplier edit form: add address, payment_method, payment_terms, payment_details, typical_lead_time (`app.js:2229-2237` vs `SuppliersView.tsx:269-305`).
- **MP1-20** Settings → Company: add phone, tax_id, logo (`app.js:6176-6179` vs `SettingsView.tsx:1481`).
- **MP1-21** Client form: add Country and the `needs_review` checkbox (`app.js:3787-3805,3836-3849` vs `ClientsView.tsx:892-899`).

**Information / layout parity**
- **MP1-22** Client detail is missing the whole Financials block (Outstanding/Paid/Invoices sent, `ClientDetailView.tsx:394-399`), the portal link (`:413-432`), `client.notes` (`:434-440`) and all three metadata cards + custom fields (`:442-505`) — no address, lead source, buyer type, follow-up date or internal notes on a phone (`app.js:3445-3505`).
- **MP1-23** Clients list has no Hot Leads stat, no `needs_review` flag, no missing-info icons, no Data-Health panel (`app.js:3336-3396` vs `ClientsView.tsx:383-393,408-440,735-755`).
- **MP1-24** Analytics never renders `top_suppliers` or `top_clients_by_profit` although both are already on the wire (`dashboard.rs:288,304`; `grep` in app.js → 0 hits; mobile shows only `top_spenders` `:1817-1826`). Desktop: `AnalyticsView.tsx:656,764-790`. **Cheapest P1 in the whole plan.**
- **MP1-25** Analytics has no date range, no Total cost, no Open closeouts (`app.js:1779-1835` vs `AnalyticsView.tsx:241-283,702-709`) — "how did last quarter do?" is unanswerable on mobile.
- **MP1-26** Inventory has no search, status filter, category filter, sort, or stale/renew surface (`app.js:2487-2519` vs `InventoryView.tsx:537-600`), and its Lots/Units/Value stats silently include sold + archived lots (`:2489-2492`).
- **MP1-27** Suppliers has no search, no archived access (hard-filtered at `app.js:2201`), no per-supplier stats — `avg_deal_amount`/`last_deal_date` are **already in the payload** (`src/routes/suppliers.rs:44-45,79-80`) — no deals list, no price history (desktop `SuppliersView.tsx:128-152,243-266,317-340`). Archived suppliers are unreachable **and unrestorable** from mobile.
- **MP1-28** Quotes has no status pills/counts and no search (`app.js:2292-2307` vs `QuotesView.tsx:131-152`); quote line items drop Qty and Rate (`app.js:2328` vs `QuotesView.tsx:326-334`) so "what did I quote per unit?" needs a desktop.
- **MP1-29** Deals is a flat list of lead+won+lost with no stage columns/counts, no margin %, no expected close date, no lost reason (`app.js:2404-2419` vs the kanban `DealsView.tsx:191-245`).
- **MP1-30** Invoice form has no over-credit-limit warning, no line-item templates, no inline new-client, no PDF preview (`app.js:4026-4068` vs `InvoicesView.tsx:520,622-630,703-713,745-763`) — a rep can invoice past a buyer's credit limit from a phone with no signal, even though mobile already reads credit status at `app.js:3559`.
- **MP1-31 (CSS)** Six tiers in a five-column grid: `TIER_ORDER` has 6 entries (`app.js:1600`) against `.tier-cards { grid-template-columns: repeat(5,1fr) }` (`www/style.css:564-566`); desktop uses `grid-cols-3 xl:grid-cols-6` (`TiersView.tsx:67`). Prospect orphans onto a second row at 1/5 width and "Platinum" badges overflow 64px cards at 375px. **Visibly broken since v0.15.119.**
- **MP1-32** Newsletter composer has no saved templates, no attachments, and cannot schedule a one-off send (`app.js:6604-6680` vs `EmailView.tsx:563,688,707,729,762,913,924`).
- **MP1-33** Checkup: no category on a new session and no way to delete one (`app.js:1347-1361,1326-1424` vs `CheckupView.tsx:22,27,134`).
- **MP1-34** Notes: no pin, no `setNoteEditing` collaborative lock, no layout persistence (`app.js:935-953` vs `NotesView.tsx:177,186,237-265`) — two people editing the same note clobber each other.

---

## P2 — cosmetic / convenience (24)

**Mobile app.js (13)**
1. Four surfaces still use the `clientName()` boot-cache instead of the now-joined `inv.client_name` — dashboard recents `app.js:3136`, invoice **search filter** `:3989` (searching a name silently matches nothing on a cache miss), row `:4002`, detail hero `:4209`. Mechanical.
2. Tapping a supplier opens the edit form, not the deal history (`app.js:2221` vs `SuppliersView.tsx:378` → `SupplierDealsModal.tsx:140`).
3. Analytics monthly margin divides refund-netted `m.profit` by un-netted `m.revenue` (`app.js:1801`; `dashboard.rs:147-149`) — understates every month with refunds, and has no desktop counterpart to agree with.
4. Invoice-form client picker filters name only and throws on a null name (`app.js:4138`, no `||''` guard unlike `:3366`).
5. Deal-flow supplier pickers offer archived suppliers (`app.js:5357,5508` vs `renderSuppliers`' filter `:2200`).
6. Dashboard client count is server-live (`app.js:3030`, `dashboard.rs:114`) while Clients uses the boot cache (`:3336`) — the two tabs disagree until Sync.
7. Rep home labels the org-wide client list "Your clients" (`app.js:2981-2988`; `list_clients` scopes by org only, `src/routes/clients.rs:631-727`).
8. Dashboard collapses pending approvals to one aggregate row (`app.js:3084`) vs desktop's 4 named clients with inline Approve/Reject (`DashboardView.tsx:300-333`).
9. Dashboard hero numbers lose their definitions ("paid invoices this month" / "completed deals this month", `DashboardView.tsx:236-252` vs `app.js:3047-3053`) — exactly where the definitions get questioned.
10. Brief has no Print, no Email, no "Generated at" (`app.js:5663` vs `BriefView.tsx:137-149,167-169`).
11. Quote detail has no "Converted to an invoice" indicator; mobile only hides the button (`app.js:2338-2344` vs `QuotesView.tsx:187-189`).
12. Client detail omits the Unsubscribed badge (`app.js:3457` vs `ClientDetailView.tsx:361-366`) though the list row shows it (`:3384`); per-client invoice rows print `issue_date` where desktop prints "Due" (`app.js:3487` vs `ClientDetailView.tsx:617`).
13. Invoice flow dots ignore `is_complete` (`app.js:4007,4216` vs `InvoicesView.tsx:383` "a completed invoice always shows all stages filled").

**Mobile style.css (5)**
14. No `.badge-active_customer` / `.badge-hot_lead` / `.badge-warm` — `statusBadgeHTML` builds `'badge-'+status` (`app.js:382-387`) so desktop-set clients render an unstyled pill reading "active customer" (`style.css:531-544`).
15. `.news-status-g` / `.news-status-r` have no `html.dark` override (`style.css:1445-1446`; dark block covers only `-p` `:1632` and `-a` `:1638`) → light-mode chips glaring in dark mode.
16. Client-row badges are injected inside `.list-name { white-space:nowrap; overflow:hidden }` (`style.css:523`, `app.js:3387`) → Blacklisted / No-bulk / Unsubscribed **send-safety flags are ellipsised out of existence** at 375px. Desktop wraps them onto their own flex line (`ClientsView.tsx:736-755`).
17. `.df-done-stats` (three 13px money stats, `flex-shrink:0`, `style.css:1137-1150`) squeezes `.df-done-name` (no ellipsis, `:1127-1131`) to a sliver → "Client → Supplier" wraps to 3-4 lines at 375px.
18. `.line-item-row { grid-template-columns: 2fr 48px 72px 72px 28px }` inside a 343px modal (`style.css:601-608,721-731`) leaves ~107px (~6 chars) for Description on the primary invoice-creation form; desktop gives it 6/12 columns (`InvoicesView.tsx:672-673`).
19. `.filter-pill` is ~30px tall with no `min-height` (`style.css:1166-1175`) while every other control in the file is explicitly 44px (`:460,630,671,1561`) — the primary filter on Clients/Invoices/Tiers is the hardest thing to hit.

**Mobile — desktop features with no mobile surface (6)**
20. Paid-invoice edit (`InvoicesView.tsx:394-397` + the dedicated paid-edit mode `:645-648`).
21. No CSV/XLSX export anywhere (`exportInvoicesCsv`/`exportDealFlowsCsv`/`exportClientsCsv`/`exportInventoryCsv`/`exportAnalyticsXlsx`).
22. Client-list hygiene: duplicate detection + per-duplicate delete, `cleanupClients`, bulk delete/category/lead-status, `clientsMissingInfo` (`ClientsView.tsx:69,102,252-298,483`). Mobile's only "clean up duplicates" is for *categories* (`app.js:6014,6051`).
23. Lot workflow: link lot → deal, Facebook Page post, "Renew — freshness reset", bulk status/delete/field, selected-lots → newsletter, media-sync warnings, stale-server-lot cleanup (`InventoryView.tsx:158-175,257,287-330,758,1846`) vs mobile's status/Edit/Delete (`app.js:2553-2578`).
24. Archive: no "recover deleted from backups" (`ArchiveView.tsx:66`); AI: five distinct desktop AI actions have no mobile call site (`aiDraftReply`, `aiExtractData`, `aiSummarizeHistory`, `parseLoads`, `aiCategorizeBankTxns`) — PARITY covers *why* (device-local key) but not that the actions are gone.

---

## DESKTOP-SIDE FIXES (6)

- **D-A · P1 (real broken feature, not parity).** `generate_portal_link` INSERTs into `client_portal_tokens` with **no** `record_upsert` (`src-tauri/src/commands.rs:8549-8559`), and the table is in neither sync allowlist (0 hits in `clienthub-api/src/sync.rs` and `src-tauri/src/sync.rs`). The server resolves tokens from its own copy (`src/routes/portal.rs:12`). So a desktop-generated portal link points at the configured base URL (`commands.rs:8509-8516`) but the token exists only on that PC → **the customer's link 404s**. Fix: `record_upsert` + add the table to both allowlists.
- **D-B · P1.** Desktop's own New-Client form writes space-separated `"hot lead"`/`"active customer"` (`ClientsView.tsx:869-875`) while desktop counts and filters on `hot_lead`/`active_customer` (`:94,313,605-612`) — desktop miscounts its own writes. Fix with S5.
- **D-C · P1.** Desktop is internally inconsistent on tier revenue: `build_client_tier_map` uses refund-netted `net_paid` (`commands.rs:1845`) while `buyer_tiers` uses `actual_paid` (`:9528`). Resolve before SP1-3 — see D-1.
- **D-D · P2 (reverse parity).** Desktop has **no** rep payout screen; mobile is the only surface answering "what do I owe each rep" (`app.js:1191-1227,1231`; `grep listPayouts src/` → only `lib/api.ts`). Combined with MP1-13 the two halves live on different devices.
- **D-E · P2 (reverse parity).** No desktop Referrals screen (`grep -rln referral src/components/` → none) vs `app.js:1138`. And mobile Brief **exceeds** desktop: pipeline snapshot, stuck deals, at-risk customers, monthly history render on mobile and nowhere on desktop (`grep at_risk_customers|stuck_deals|deals_by_stage BriefView.tsx` → 0).
- **D-F · P2.** `HealthView.tsx` is imported (`App.tsx:52`) and never rendered — pre-existing dead file.

---

## MOBILE SCREENS THAT DO NOT EXIST AT ALL (12) — scope decision, not a batch fix

Newly identified: **Manifest analyzer** (mobile has only a manifest link badge, `app.js:2508,2550`), **Recurring invoice templates** (mobile's "Recurring" tab is *newsletter* schedules, `app.js:6466`), **Desktop inbox + drafts + AI reply/extract** (`EmailView.tsx:26,39,174-192,301-336`; "every email to and from a client is logged" is the product's stated first step in mobile's own onboarding copy at `app.js:205`), **DataSafetyView**, **PlatformView** superadmin console (mobile has only waitlist `:1566` + feedback `:1535`), **hosted lead-form builder** (mobile's webforms creates *intake sources*, a different object, `app.js:2091-2103`).
Already known: SheetCopy, ReleaseLetter, Financials/FreeCash/Loans, Reconciliation panel, Globe, Settings 24 sections → 7.

---

## DO NOT BATCH — needs a decision from Jack first (7)

1. **D-1 · Tier revenue basis.** Refund-netted `net_paid` or raw `actual_paid`? Desktop contradicts itself (D-C). Changing it **re-tiers real clients**, which changes who is Platinum and who receives tier-targeted newsletters.
2. **D-2 · Portal token distribution.** Syncing `client_portal_tokens` puts customer-facing access tokens into the oplog and onto every device. Confirm that's acceptable vs. server-only issuance.
3. **D-3 · Canonical `lead_status` vocabulary.** Is `warm` real? Is mobile's `active` = `active_customer`? And what happens to rows already written as `'active'`, `''`, `'hot lead'`, `'active customer'` — needs a migration decision, not just a code fix.
4. **D-4 · One definition of "Outstanding".** All-unpaid-non-void (desktop Invoices), `sent||overdue` (mobile Invoices), or committed-AR (dashboard + Receivables). Whichever wins changes a number Jack reads daily.
5. **D-5 · Brief headline.** Mobile shows `net_profit_this_week + |loss_total_this_week|` as "Profit earned" (`app.js:5782-5786`); desktop shows plain `net_profit_this_week` (`BriefView.tsx:201-206`). Which is the headline?
6. **D-6 · `listing_stale` reject semantics.** Server's reject = `set_lot_sold` (`approvals.rs:257-260`). Confirm that's intended before relabeling mobile's button "Mark sold".
7. **D-7 · Repair of already-corrupted data.** The P0 fixes stop the bleeding; they do not restore what mobile saves have already destroyed — wiped supplier `payment_details`/`address`, missing `company_info` phone/tax_id/logo, stripped `kept` flags, custom lots reset to `per_unit`/$0, blanked `lead_status`. Recovery would come from the oplog / nightly backups and is itself a write. Needs an explicit go/no-go.

---

## RECOMMENDED EXECUTION ORDER

**Round 0 — "stop the bleeding" (server only, one pattern, ~4 files).** P0-1 … P0-5: apply S1 merge-on-write to `suppliers.rs`, `settings.rs`, `inventory.rs`, `clients.rs`, and S2 (`kept` + serde flatten) to `models.rs`/`deal_flows.rs`. Do this before anything else because every day it isn't shipped, ordinary mobile use permanently deletes supplier payment details, company invoice headers, kept-cut flags and offer pricing — on **all** devices. No mobile release needed; deploys instantly.

**Round 1 — server read enrichment (S3 + SP1-1…SP1-8).** Still server-only, still instant. Kills or de-risks ~10 mobile findings before a single line of app.js changes: tier codes+math, `Deal.client_name`, inventory `details_json`/`updated_at`, invoice refund + flow cost, deal-flow `needs_review`/`completed_at`. Gate SP1-3 on D-1.

**Round 2 — mobile money correctness.** P0-6 … P0-11 plus MP1-1, MP1-3…MP1-9. Everything here either shows a wrong number or lets a wrong number stand. S6 (delete `loadDealFlows`) lands here since P0-7/MP1-10/MP1-11 all depend on it.

**Round 3 — mobile workflow unblocks that need no new routes.** MP1-10…MP1-21 + MP1-18 (the refresh regression — it's a side effect of the fix you just shipped, so it should go out fast). Highest work-unblocked per line of code: four live endpoints mobile simply never calls.

**Round 4 — the 9 new routes + their mobile UI.** Kept toggle, `payout_included`, recalc-from-bank, resubscribe, offers admin, portal, recurring invoices, forms CRUD, quote threading. Batch the Rust, then the UI.

**Round 5 — information & layout parity.** MP1-22…MP1-30, MP1-32…MP1-34. Start with MP1-24 (top suppliers / top clients-by-profit) — the data is already on the wire, so it's pure render.

**Round 6 — CSS + cosmetics.** MP1-31 (tier grid, visibly broken) first, then the P2 style.css set. Items 16 (send-safety flags ellipsised) and 18 (100px description field) are the two P2s with real functional bite — consider promoting them into Round 3.

**Round 7 — desktop-side (D-A…D-F) and the 12 missing screens,** after D-7 and the scope decision.

## COUNTS

| Bucket | Count | Where the fix lands |
|---|---|---|
P0 | **11** | 5 pure server Rust, 6 mobile app.js |
P1 | **48** | 9 pure server queries/payloads, 9 new server routes, 30 mobile (1 of which is CSS) |
P2 | **24** | 13 mobile app.js, 5 style.css, 6 missing mobile surfaces |
Desktop-side | **6** | 3 P1 (one a genuinely broken customer-facing link), 3 P2/reverse-parity |
Missing screens | **12** | 6 newly identified, 6 previously known |
Blocked on a decision | **7** | — |
Structural class-killers | **6** | S1 alone accounts for 4 of the 11 P0s; S3 closes ~9 findings |

**Cheapest high-leverage set:** Round 0 + Round 1 = server-only, no app release, no PWA cache bump, and it resolves 5 P0s and ~10 P1s. **Deploy hygiene reminder:** `clienthub-api` ships by scp, not git — grep the droplet before copying, deploy matched sets, and never include `plaid.rs`.

---

# AUDIT A — COVERAGE & ACTIONS

## PART 1 — SCREEN COVERAGE MATRIX

Desktop screens = routed views in `src/App.tsx:518-539` (paneContent) + `NAV`/`UTILITY` at `src/App.tsx:409-444`. Mobile tabs = `render(tab)` switch at `www/app.js:721-744` + `MORE_TABS` at `app.js:700` + non-router screens reached from `renderMore()` (`app.js:1044-1136`) and the header bell (`app.js:2698`).

| # | Desktop screen (file) | Mobile equivalent | Status |
|---|---|---|---|
| 1 | DashboardView | `case 'dashboard'` app.js:722 | ✔ |
| 2 | ClientsView / ClientDetailView | `'clients'` :723 / showClientDetail :3401 | partial |
| 3 | CheckupView | renderCheckups :1326 (More only — **not a router tab**) | partial |
| 4 | TiersView (`health`) | `'tiers'` :731 | ✔ |
| 5 | ApprovalsView | renderApprovals :2716 (bell only — **not a router tab**) | partial |
| 6 | SuppliersView | `'suppliers'` :736 | partial |
| 7 | InventoryView | `'inventory'` :739 | partial |
| 8 | SheetCopyView | — | **none** [known] |
| 9 | **ManifestView** (manifest analyzer) | — (only a manifest *link* badge, app.js:2508,2550) | **none — NEW** |
| 10 | DealFlowView | `'deal-flows'` :725 | partial |
| 11 | InvoicesView | `'invoices'` :724 | partial |
| 11a | **RecurringView** (recurring *invoice* templates, mounted InvoicesView.tsx:241) | — mobile "Recurring" tab is newsletter schedules (app.js:6466) | **none — NEW** |
| 11b | RefundWorkspace / RefundPanel | code exists but **unreachable** (see F1) | **none — NEW** |
| 11c | ReconciliationPanel | — | none [known] |
| 11d | CreditPanel | credit limit + adjust app.js:3571-3592 | ✔ |
| 12 | CloseoutView (`deals` = Completed) | completed drawer app.js:4659-4733 (read-only) | partial |
| 13 | ReceivablesView | `'receivables'` :734 | partial (read-only) |
| 14 | PayablesView | `'payables'` :735 | partial (read-only) |
| 15 | QuotesView | `'quotes'` :737 | partial |
| 16 | ReleaseLetterView | — | none [known] |
| 17 | FinancialsView + FreeCashView + LoansView | — | none [known] |
| 18 | EmailView (inbox **+** newsletter) | `'news'` :727 = newsletter only | partial — **inbox half is NEW** |
| 19 | BriefView | `'brief'` :726 | ✔ |
| 20 | AnalyticsView | `'analytics'` :732 | partial |
| 21 | AutomationLogView | summary only | partial [known] |
| 22 | GlobeView | — | none [known] |
| 23 | NotesView | `'notes'` :741 | partial |
| 24 | ArchiveView | `'archive'` :742 | partial |
| 25 | **PlatformView** (superadmin console) | renderWaitlist :1566 + renderFeedbackInbox :1535 only | partial — **NEW** |
| 26 | **DataSafetyView** | — | **none — NEW** |
| 27 | SettingsView (24 sections, SettingsView.tsx:183-221) | renderSettings :6100 (**7 sections**) | partial [known] |
| 28 | FormsPanel (hosted lead-form builder, Settings→Lead Forms) | mobile webforms creates *intake sources*, not forms (app.js:2091-2103) | **none — NEW** |
| — | *(no desktop screen)* | `'payouts'` :740 + renderPayoutConfig :1231 | **mobile-only** |
| — | *(no desktop screen)* | `'referrals'` :743 | **mobile-only** |

Note: `HealthView.tsx` is imported (`App.tsx:52`) but never rendered — pre-existing dead file, unrelated to parity.

---

## PART 2 — DESKTOP ACTIONS A USER CANNOT PERFORM ON MOBILE

### Deal Flow / money

**F1. Refunds cannot be recorded or even seen on mobile — the code is orphaned | P0**
Desktop: `RefundWorkspace` mounted on active flows (`DealFlowView.tsx:382`), completed flows (`DealFlowView.tsx:660`, `CompletedBreakdown.tsx:305`) and in the invoice detail (`InvoicesView.tsx:1012`).
Mobile: the refunds list + `+ Record refund` button only render inside `toggleDfExpand`'s `if (df.stage === 'complete')` branch (`app.js:4988`, buttons `5006-5010`, handler `5043-5047`). But `toggleDfExpand` is bound only to **active** cards (`app.js:4788`) and to the dead `loadDealFlows` (`app.js:4885`), and `renderDfLists` filters active to `f.stage !== 'complete'` (`app.js:4632`). Completed deals are rendered by `renderDfDrawer` into a *different*, purely read-only container `#df-done-exp-${id}` (`app.js:4688,4700-4732`) that never calls `toggleDfExpand`.
Consequence: there is **no path on mobile** to record a refund, see recorded refunds, or see `refund_owed` on a completed deal. PARITY-PLAN's "Mobile can list/record refunds inside one deal's drawer" is stale — the completed-drawer rewrite orphaned it. Money that was refunded is invisible on the phone.

**F2. "Reopen" (uncomplete) a completed deal exists only in dead code | P1**
Desktop: `CloseoutView.tsx:253` (`api.uncompleteDealFlow`), plus invoice row menu "Reopen deal" `InvoicesView.tsx:412-417`.
Mobile: the only `uncomplete` call is `app.js:4877` / `4911-4913`, inside `loadDealFlows` (`app.js:4840-4924`) which renders into `#df-list` — a container `renderDealFlows` never creates (`app.js:4580-4593`). The live action row (`app.js:4773-4782`) has no Reopen.
Consequence: a deal completed by mistake from the field can never be reopened on mobile.

**F3. Deal flow archive/delete exists only in dead code | P1**
Desktop: `CloseoutView.tsx:261`, `DealFlowView.tsx:745` (`api.deleteDealFlow` → "Moved to Archive").
Mobile: `app.js:4878` + `4915-4919`, inside the same dead `loadDealFlows`. Server route exists (`routes/deal_flows.rs:22-25` `delete(delete_deal_flow)`).
Consequence: a duplicate/junk deal flow cannot be removed from mobile even though the endpoint is live.

**F4. Cannot correct a completed deal's completed date | P1**
Desktop: `CloseoutView.tsx:245` `api.updateDealCompletedAt`. Server route already exists: `routes/deal_flows.rs:56-59` `PUT /api/deal-flows/:id/completed-at`.
Mobile: zero references (`grep completed-at www/app.js` → none). Date can only be set at completion time (`app.js:5582`).
Consequence: a deal completed on the wrong day lands in the wrong month's profit and the phone can't fix it, even though the endpoint is deployed.

**F5. Cannot flip payout routing on an already-completed deal | P1 (money)**
Desktop: `CompletedBreakdown.tsx:88-99` — `api.setDealPayoutIncluded` explicitly exists so "deals completed under the old silent default (excluded → 100% business) can adopt the configured split without uncomplete→recomplete".
Mobile: `payout_included` is only settable in the completion modal checkbox (`app.js:5583,5613`). No server route exists (`routes/deal_flows.rs:18-60`).
Consequence: partner cuts recorded wrong on a mobile-completed deal are unfixable from mobile, and F2 blocks the uncomplete→recomplete workaround too.

**F6. "Didn't pay — kept it" supplier toggle is desktop-only and has no endpoint | P1 (money)**
Desktop: `DealFlowView.tsx:1108-1113` `toggleKept` → `api.setSupplierPaymentKept` ("drop this supplier's amount from the deal's cost").
Mobile: none. Server: `routes/deal_flows.rs:18-60` has no `kept` route; `grep kept src/routes/deal_flows.rs` → 0 hits.
Consequence: the deal's cost/profit cannot be corrected from mobile when a supplier bill was never actually paid. Not in PARITY-PLAN (`grep -i kept PARITY-PLAN.md` → no match).

**F7. Supplier-payment edit / remove / unmark-paid are locked to one stage on mobile | P1**
Mobile: those three buttons render only `if (stage === 'payment_received')` (`app.js:5163-5168`); at `supplier_paid` and `complete` the action row is empty.
Desktop: `removePayment` (`DealFlowView.tsx:878-882`) and edit run at any stage and explicitly re-run `api.recalcDealFromBank` when `flow.stage === "complete"` (`:881`); `unmarkAllPaid` at `:1103-1106`.
Consequence: a wrong supplier amount on a supplier-paid or completed deal cannot be corrected on mobile — the phone user must find a desktop.

**F8. Lead-rep assignment is desktop-only, yet the rep payout statement is mobile-only | P1 (money)**
Desktop: `RefundPanel.tsx:63-65` rep dropdown → `api.setDealLeadRep` (`lib/api.ts:2002`).
Server: route is live — `PATCH /api/staff/deals/:id/lead-rep` (`staff_api.rs:500-502`, mounted `staff_api.rs:1431`).
Mobile: zero calls (`grep lead-rep www/app.js` → none); it only *reads* `metadata.lead_representative` for display (`app.js:3431`).
Consequence: mobile is the only surface with the "amount owed per rep" screen (`app.js:1191-1227`) but cannot assign the rep that drives it — every unassigned deal shows under "Unassigned" (`app.js:1217`) with no fix available on the phone.

**F9. Recalculate-from-bank has no mobile or REST surface | P1**
Desktop: `DealFlowView.tsx:1647` `api.recalcDealFromBank`.
Mobile/server: no route in `routes/deal_flows.rs:18-60`; no `bank` UI in app.js.
Consequence: after desktop-side bank imports change the truth, a mobile user cannot re-derive the deal's profit. (Adjacent to PARITY's bank-truth items, but the *missing endpoint* for the explicit user-facing action is not listed.)

**F10. AR/AP drill-down into a completed deal silently does nothing | P2**
Mobile: `openDealFlowById` (`app.js:4573-4577`) sets `_dfFocusId`; the reveal block (`app.js:4644-4656`) opens the completed drawer then does `document.querySelector('.df-card[data-id="…"]')` — but completed rows are `.df-done-row[data-dfid]` (`app.js:4677`), so `if (!card) return;` fires.
Desktop: AR/AP rows open the real flow panel (`ReceivablesView.tsx`/`PayablesView.tsx` → DealFlowView).
Consequence: tapping a receivable/payable that belongs to a completed deal appears to do nothing.

### Invoices

**F11. A PAID invoice cannot be marked "fell through" on mobile | P0**
Desktop: void is offered for every non-voided invoice regardless of status — row menu `InvoicesView.tsx:419-423`, detail footer `InvoicesView.tsx:1053-1056`.
Mobile: `btn-void-inv` is only emitted in the `sent`/`overdue` branch (`app.js:4272-4277`). The `paid` branch is `View PDF` + `Archive` only (`app.js:4278-4281`).
Consequence: the exact INV-2026-0038 class (a *paid, completed* deal that later falls through) cannot be voided from the phone; mobile keeps counting that revenue/profit while desktop can zero it. Archiving instead is a different operation with different guards.

**F12. A paid invoice cannot be edited on mobile | P2**
Desktop: Edit is always present (`InvoicesView.tsx:394-397`) and the form has a dedicated paid/sent edit mode ("Editing a paid invoice — amounts and dates can be adjusted", `InvoicesView.tsx:645-648`).
Mobile: no `btn-edit-inv` in the paid branch (`app.js:4278-4281`).

**F13. Recurring invoice templates have no mobile screen and no server route | P1**
Desktop: `RecurringView.tsx:19-70` — list, create, edit, pause/resume (`:54-57`), delete; mounted at `InvoicesView.tsx:241`.
Server: no route (`grep -rn recurring src/routes/*.rs` hits only the `invoices.recurring` column at `invoices.rs:328-370`).
Mobile: the "Recurring" tab under Newsletters is *newsletter* schedules (`app.js:6433,6466`); the invoice form only sets the per-invoice `recurring` string (`app.js:4060-4067`).
Consequence: recurring billing templates can be neither seen nor paused from mobile — a paused-on-desktop template is invisible, and nothing on mobile explains why invoices keep generating.

**F14. Invoice creation on mobile is missing 4 desktop affordances | P2**
Desktop: create-client-inline from the picker (`InvoicesView.tsx:613-617,622-630`), line-item template chips (`InvoicesView.tsx:702-712`), over-credit-limit warning computed from `api.getClientCreditStatus` (`InvoicesView.tsx:520,745-751`), "Preview PDF" (`InvoicesView.tsx:556,754`).
Mobile: `showInvoiceForm` (`app.js:4020-4070`) has none of these — a new buyer must be created in Clients first, and no credit warning appears.

**F15. No CSV/XLSX export anywhere on mobile | P2**
Desktop: `api.exportInvoicesCsv` (`InvoicesView.tsx:204,219`), `exportDealFlowsCsv` (`DealFlowView.tsx:212`), `exportClientsCsv` (`ClientsView.tsx:286`), `exportInventoryCsv` (`InventoryView.tsx:419`), `exportAnalyticsXlsx` (`AnalyticsView.tsx:227`).
Mobile: `grep -in "export\|csv" www/app.js` → only role-matrix permission labels (`app.js:847,851`).

### Receivables / Payables

**F16. Mobile AR is read-only — no "Mark paid" | P2**
Desktop: `ReceivablesView.tsx:106-112` — mark paid with date, payment method and reference, straight from the aging list.
Mobile: `renderReceivables` rows are display-only (`app.js:1957-1978`); the only action is the drill-down at `app.js:1987`.

**F17. Mobile AP is read-only — no "Mark supplier cost paid" | P2**
Desktop: `PayablesView.tsx:105-112` (`api.markSupplierPaymentPaid` matched from the aging row).
Mobile: `app.js:2045-2063` display-only.
Consequence: the two chase lists — the screens a broker actually works from on the road — cannot clear anything.

### Quotes

**F18. Quote send from mobile can't reply into the customer's existing thread | P2**
Desktop: `QuotesView.tsx:80-91` → `api.sendQuote(quote.id, threaded)` with a per-send confirmation ("Quote sent into the email thread").
Mobile: `POST /api/quotes/:id/email` with an empty body (`app.js:2350`); server `routes/quotes.rs` has no threading (`grep thread\|in_reply\|references routes/quotes.rs` → 0 hits).
Consequence: a mobile-sent quote starts a new thread; the v0.15.97 threading behaviour is desktop-only.

### Clients

**F19. An unsubscribed client cannot be resubscribed from mobile | P1**
Desktop: `ClientDetailView.tsx:344` `api.resubscribeClient`.
Server: no route (`grep -rn resubscribe clienthub-api/src` → only `sync.rs:1226-1251`, the *apply* side that clears `email_suppression` when the desktop's flag arrives).
Mobile: renders the "Unsub" state (`app.js:3377`, `_isUnsub`) with no control to clear it.
Consequence: a client who unsubscribed by accident stays permanently suppressed unless someone opens a desktop.

**F20. Client portal links: no mobile surface, and desktop-generated links can't work server-side | P1**
Desktop: generate/revoke/base-URL in `ClientDetailView.tsx:421-429`; `generate_portal_link` INSERTs into `client_portal_tokens` with **no** `record_upsert` (`src-tauri/src/commands.rs:8549-8559`), and the table is in neither sync allowlist (`grep client_portal_tokens` → 0 hits in `clienthub-api/src/sync.rs` and in `src-tauri/src/sync.rs`).
Server: the portal resolves tokens from its own copy — `routes/portal.rs:12` `SELECT … FROM client_portal_tokens WHERE t.token = ?1`.
Mobile: zero `portal` references in app.js.
Consequence: two bugs at once — (a) a portal link generated on desktop points at the configured base URL (`commands.rs:8509-8516`) but the token only exists in that PC's DB, so the customer's link fails server-side; (b) mobile cannot issue or revoke a portal link at all.

**F21. Client-list hygiene tools absent on mobile | P2**
Desktop: duplicate detection + per-duplicate delete (`ClientsView.tsx:102,483`), `api.cleanupClients` (`:298`), bulk delete / bulk category / bulk lead-status (`:252,261,269`), `clientsMissingInfo` needs-attention list (`:69`).
Mobile: none of these (the only "clean up duplicates" on mobile is for *categories*, `app.js:6014,6051`).

**F22. AI client-history summary and custom fields absent | P2**
Desktop: `api.aiSummarizeHistory` (`ClientDetailView.tsx:188`); custom fields loaded and edited (`ClientDetailView.tsx:183`, Settings section `customfields` `SettingsView.tsx:190`).
Mobile: no `/api/ai` calls anywhere; client form (`app.js:3781`) has no `cf:*` fields.

### Inventory

**F23. Storefront offers are invisible on mobile — no admin read or accept/decline | P1**
Desktop: `api.listOffers` (`InventoryView.tsx:157`), accept / decline / delete per offer (`InventoryView.tsx:2139-2141`).
Server: only the public write path exists — `INSERT INTO offers …` + `record_upsert("offers", …)` (`routes/storefront.rs:306,323`); no admin GET/PATCH route.
Mobile: `grep -in offer www/app.js` → 1 unrelated code comment (`app.js:4749`).
Consequence: a buyer's offer submitted through the public storefront is a live inbound lead that a phone user can never see or answer. Not in PARITY-PLAN.

**F24. Lot workflow actions missing on mobile | P2**
Desktop: link lot → deal (`InventoryView.tsx:758`), Facebook Page post (`:1846`), "Renew — freshness reset" (`:257`), bulk select → bulk status / bulk delete / bulk field (`:287-301`), selected-lots → newsletter (`:330,1129-1130`), media-sync issue warnings (`:158`), stale-server-lot cleanup (`:165-175`).
Mobile: lot detail offers exactly status / Edit / Delete (`app.js:2553-2578`).

### Approvals

**F25. Stale-listing approvals are mislabeled on mobile — "Reject" silently marks the lot SOLD | P1**
Desktop: `ApprovalsView.tsx:118,166-188` gives `listing_stale` its own section with explicit **Renew** / **Mark sold** buttons and the explanation "On your storefront 2+ days".
Mobile: `kindLabel` maps only `client_add`/`client_delete`, else returns the raw kind (`app.js:2721`), and every row gets generic **Approve** / **Reject** (`app.js:2731-2732`).
Server: `approvals.rs:257-260` — reject on `listing_stale` calls `set_lot_sold(eid, &org)`; the summary text is `"Renew or mark sold: {name}"` (`scheduler.rs:71-72`).
Consequence: a mobile admin sees a row labeled `listing_stale` with Approve/Reject and, by tapping Reject, marks a live lot **sold** without being told.

### Checkup

**F26. No category scoping on a new session, and no way to delete a session | P2**
Desktop: `api.createCheckup(name, category)` (`CheckupView.tsx:27`, category picker `:22`), `api.deleteCheckup` (`:134`).
Mobile: `newCheckupSession` posts `{ name }` only (`app.js:1347-1361`); no delete control anywhere in `renderCheckups`/`renderCheckupBoard` (`app.js:1326-1424`).

### Email

**F27. The entire desktop inbox module has no mobile counterpart | P1**
Desktop `EmailView.tsx`: `api.scanInbox` (`:39`), inbox message list + reading, `api.listDrafts` (`:26,301`), `api.aiDraftReply` (`:174`), `api.aiExtractData` (`:183`), `api.updateDraft`/`sendDraft`/`discardDraft` (`:317,327,336`), one-off `api.sendEmail` (`:192,441`).
Mobile: `grep -in inbox www/app.js` → only the onboarding copy (`app.js:205`) and the *feedback* inbox (`:1113,1535`); no drafts, no conversation view.
Consequence: "every email to and from a client is logged" is the product's stated first step (`app.js:205`), yet none of that conversation surface — or the AI reply/extract workflow — exists on the phone. PARITY-PLAN lists inbox *config* as missing from mobile Settings but never the inbox screen itself.

**F28. No AI features at all on mobile | P2**
Desktop: `aiDraftNewsletter` (`EmailView.tsx:680`), `aiDraftReply`/`aiExtractData` (`EmailView.tsx:174,183`), `aiSummarizeHistory` (`ClientDetailView.tsx:188`), `parseLoads` paste-to-load (`InventoryView.tsx:981`), `aiCategorizeBankTxns` (`FinancialsView.tsx:973`).
Mobile: no AI call sites. (PARITY covers *why* — device-local `anthropic_api_key` — but not that five distinct user actions are gone.)

**F29. Newsletter composer lacks saved templates, attachments, and scheduling-for-later | P2**
Desktop: template library list/save/delete (`EmailView.tsx:563,688,707`), `api.scheduleNewsletterSend` with a send time (`:762`), attachment path (`:729`), include-ranked and unsubscribe-footer toggles (`:913,924`).
Mobile: `newsletterCompose` (`app.js:6604-6640`) is subject + body + audience + **Send now** only; scheduled sends can be listed and cancelled (`app.js:6641-6680`) but never created; recurring schedules can be created (`app.js:6468`).
Consequence: a one-off send cannot be scheduled from mobile, and a mobile user cannot reuse the org's approved newsletter templates.

### Notes / Archive / Suppliers / Analytics

**F30. Notes: no pin, no edit-lock, no layout | P2**
Desktop: pin (`NotesView.tsx:265`), `api.setNoteEditing` collaborative lock (`:237,242,251`), position/size persistence (`:177,186`).
Mobile: `renderNotes` (`app.js:935-953`) supports body, color, delete only — grid layout, no pin, and no lock, so two people editing the same note clobber each other.

**F31. Archive: no "recover deleted from backups" | P2**
Desktop: `api.recoverDeletedFromBackups` (`ArchiveView.tsx:66`).
Mobile: `renderArchive` (`app.js:963-1042`) offers Restore only.

**F32. Suppliers: no price history, no per-supplier deals, no access to archived suppliers | P2**
Desktop: `api.getSupplierPriceHistory` + `api.getDealsForSupplier` (`SuppliersView.tsx:56-57`), archive (`:353`) *and* hard delete (`:361`).
Mobile: `renderSuppliers` filters archived out with no toggle (`app.js:2200`); `showSupplierForm` (`app.js:2224-2281`) has Archive only — an archived supplier is unreachable and unrestorable from mobile.

**F33. Analytics: no date range, no export, no money overview | P2**
Desktop: `api.getAnalyticsRange(start, end)` custom window (`AnalyticsView.tsx:136,161`), `api.financialsOverview` (`:168`), XLSX export (`:227`).
Mobile: `renderAnalytics` reads `/api/dashboard/stats` + `/api/clients/tiers` only (`app.js:1760-1763`) — fixed windows, no range, no export.

### Forms

**F34. Hosted lead-form builder is desktop-only and has no CRUD endpoint | P2**
Desktop: `FormsPanel.tsx:34-53` — `listForms` / `saveForm` (with intake field mapping, `:36`) / `deleteForm`, shareable link.
Server: `routes/forms.rs:18-19` exposes only `GET /f/:id` (render) and `POST /api/forms/:id/submit`.
Mobile: `renderWebForms` creates *intake sources* (`POST /api/staff/intake-sources`, `app.js:2091-2103`) — a different object; `grep "/api/forms" www/app.js` → 0.

### Navigation (blocks work)

**F35. Refreshing on Approvals / Checkup / My account / Payout setup silently throws you out of the screen | P1**
Mobile: `syncNow` ends with `await render(currentTab)` (`app.js:521-541`, esp. `:532`); it is wired to the header Sync button (`app.js:2703-2704`) **and** to pull-to-refresh (`app.js:340`). But `render(tab)`'s switch (`app.js:721-744`) has no `approvals` or `checkup` case and `MORE_TABS` (`app.js:700`) omits them, so those screens (plus `renderMyAccount` :1443, `renderPayoutConfig` :1231, `renderFeedbackInbox` :1535, `renderWaitlist` :1566) leave `currentTab` pointing at the previous tab.
Desktop: every destination is a real `tab` value (`App.tsx:518-539`) and `handleSync` (`App.tsx:389-399`) never re-renders a different view.
Consequence: pull-to-refresh while reviewing an approval or typing checkup notes jumps to Dashboard/Clients and discards the in-progress edit (checkup notes save on blur with a swallowed catch, `app.js:1415`). This is a side effect of the newly added refresh, so it is not covered by the "already fixed" item.

---

## PART 3 — MOBILE-ONLY ACTIONS (desktop gap)

- **Rep payout statement + payout rule editor.** Mobile: `renderPayouts` (`app.js:1191-1227`, `GET /api/staff/payouts`, "Total owed", per-rep owed, refund-aware) and `renderPayoutConfig` (`app.js:1231`, `POST /api/staff/payout-config`). Desktop has **no** equivalent screen — only the brief's `payout_totals` boxes (`BriefView.tsx:212-261`) and the per-deal split display (`CloseoutView.tsx:326`, `CostProfitPanel.tsx:53`); `grep -rn "listPayouts" src/` hits only `lib/api.ts`. Consequence: "what do I owe each rep" is answerable only on the phone, while the rep assignment that feeds it is settable only on desktop (F8).
- **Referrals screen** (`app.js:1138` `renderReferrals`) — no desktop component (`grep -rln referral src/components/` → none).
- **Intake-source creation** (`app.js:2091-2103`) exists on both, but mobile is the only place a *source* can be created without going through Settings.

---

## PART 4 — GAPS THAT NEED A NEW SERVER ROUTE (mobile UI alone can't close them)

| Action | Desktop call | Missing endpoint |
|---|---|---|
| Supplier "kept it" toggle (F6) | `api.setSupplierPaymentKept` | none in `routes/deal_flows.rs:18-60` |
| Set payout_included on completed deal (F5) | `api.setDealPayoutIncluded` | none |
| Recalculate deal from bank (F9) | `api.recalcDealFromBank` | none |
| Resubscribe client (F19) | `api.resubscribeClient` | none (only the sync-apply side, `sync.rs:1226-1251`) |
| Portal link generate/revoke (F20) | `commands.rs:8536,8563` | none; and `client_portal_tokens` is unsynced |
| Storefront offers admin read + accept/decline (F23) | `api.listOffers`, `api.setOfferStatus`, `api.deleteOffer` | only public `POST` (`routes/storefront.rs:306`) |
| Recurring invoice templates (F13) | `api.listRecurringInvoices` etc. | none |
| Hosted form CRUD (F34) | `api.saveForm`/`deleteForm` | only `/f/:id` + submit (`routes/forms.rs:18-19`) |
| Quote threaded send (F18) | `api.sendQuote(id, threaded)` | `routes/quotes.rs` has no threading |

Already-live endpoints mobile simply never calls: `PUT /api/deal-flows/:id/completed-at` (F4), `DELETE /api/deal-flows/:id` (F3), `POST /api/deal-flows/:id/uncomplete` (F2), `PATCH /api/staff/deals/:id/lead-rep` (F8), `PUT /api/deal-flows/:id/notes` and `/name` (`routes/deal_flows.rs:27-28`, known Deal-Flow-v2 item).

---

# AUDIT B — RE-DERIVATION & STALE CACHE

## TASK B findings — client-side re-derivation + stale-cache class (mobile `app.js`)

All paths absolute: desktop `C:/Users/Jack/Desktop/BUSINESS APP/`, server+mobile `C:/Users/Jack/Desktop/clienthub-api/`.

---

# P0

### 1. `kept` supplier payments — mobile writes ERASE the flag on every desktop, and the server counts kept money as cost
**Desktop:** `src-tauri/src/commands.rs:3552-3557` defines the field —
```rust
/// "Didn't pay — kept it": you're keeping this supplier's cut rather than paying
/// it, so it is NOT a real cost. Excluded from total_supplier_cost ...
#[serde(default)] pub kept: bool,
```
and `commands.rs:3676-3679`:
```rust
fn write_sp(deal_flow_id: &str, payments: &[SupplierPayment], invoice_id: &str) -> ... {
    // "kept" payments (you didn't pay — you're keeping the cut) are NOT a real cost.
    let total: f64 = payments.iter().filter(|p| !p.kept).map(|p| p.amount).sum();
```
**Server/mobile:** `src/models.rs:167-183` — `SupplierPayment` has **no `kept` field** (ends at `pub category: Option<String>` line 182). `src/routes/deal_flows.rs:108-111` deserializes `supplier_payments_json` into that struct, and `deal_flows.rs:185-187` re-serializes it:
```rust
fn write_sp(deal_flow_id: &str, payments: &[SupplierPayment]) -> anyhow::Result<()> {
    let sp_json = serde_json::to_string(payments)?;
    let total: f64 = payments.iter().map(|p| p.amount).sum();   // no !p.kept filter
```
Called from **6 sites** (`deal_flows.rs:670, 729, 773, 806, 852, 903` = unmark-payment-received, add / update / remove supplier payment, mark-paid, unmark-paid).
**Consequence:** any mobile supplier-payment action on a deal permanently strips every `kept:true` flag from `supplier_payments_json` and `record_upsert`s the loss to every desktop. The kept cut then re-enters `total_supplier_cost`, so recorded profit drops by the kept amount everywhere. Two independent money bugs in one function (drop + un-filtered `total`).
**Severity: P0.**

### 2. Mobile writes `lead_status:'active'` — a value the rest of the system doesn't use — and silently wipes `active_customer` on edit
**Desktop:** canonical vocabulary is `src-tauri/src/db.rs:383` — `-- Client pipeline: prospect, hot_lead, warm, active_customer, inactive`; `src-tauri/src/csv_import.rs:182` normalizes `"active"` → `"active_customer"`; `src/components/ClientsView.tsx:94,313` count `all.filter((c) => c.lead_status === "active_customer").length`.
**Mobile:** `www/app.js:3794` offers `<option value="active">Active</option>`; `app.js:2803` `const leadOpts = ['prospect','active','inactive','hot_lead','warm']`; counts/filters at `app.js:2982`, `3338`, `3365` all test `(c.lead_status||'') === 'active'`.
**Consequences (three):**
- Mobile's "Active" tile and "Active" filter pill are **permanently 0 / empty** for any org whose clients were set on desktop.
- Saving "Active" from mobile writes `lead_status='active'`, which desktop's `statusLabels` (`ClientsView.tsx:205`) and `statusColor` (`ClientDetailView.tsx:61`) don't recognize → unlabeled badge on desktop, excluded from desktop's Active count.
- **Data loss:** `app.js:3821` `$('#f-lead', overlay).value = c.lead_status||'prospect'` — assigning `'active_customer'` matches no `<option>`, so `selectedIndex` becomes −1 and `.value` reads `''`. `app.js:3841` then PUTs `lead_status: ''`, and `src/routes/clients.rs:272-275` (`input.lead_status.clone().unwrap_or_else(...)`) accepts `Some("")` verbatim. **Opening + saving any Active Customer on mobile blanks their pipeline status on every device.** The approval editor (`app.js:2888` `g('#ap-lead') || 'prospect'`) demotes them to Prospect instead.
**Severity: P0.**

### 3. Mobile inventory form has no `custom` price_type — editing a "send offer" lot destroys its pricing and publishes $0 to the public storefront
**Desktop:** `src/components/InventoryView.tsx:1666` offers `(["per_unit", "total", "custom"] as const)`, and **every** money helper guards it — `:368` `unitAsk = lot.price_type === "custom" ? 0 : …`, `:369` `margin = … "custom" ? "—"`, `:371` `totalProfit = … "custom" ? 0`, `:372` `totalAsk = … "custom" ? 0`, `:54` `hasPrice = … price_type === "custom" && !!details.price_text`.
**Mobile:** `app.js:3650` `<select id="f-ptype">${opt('per_unit',…)}${opt('total',…)}</select>` — **no `custom` option**; `app.js:2477-2482` has zero `custom` branches:
```js
const loadPrice = l => l.price_type === 'per_unit' ? Number(l.asking_price||0)*Number(l.quantity||0) : Number(l.asking_price||0);
const profitOf  = l => l.price_type === 'total' ? (…) : (Number(l.asking_price||0)-Number(l.total_cost||0))*Number(l.quantity||0);
const costTotal = l => l.price_type === 'per_unit' ? Number(l.total_cost||0)*Number(l.quantity||0) : Number(l.total_cost||0);
const marginOf  = l => { const c = costTotal(l); return c > 0 ? (profitOf(l)/c)*100 : null; };
```
**Consequences:** (a) a custom lot renders headline **"$0.00"**, profit `(0 − cost) × quantity` (a huge negative), and margin `(−cost·qty)/cost·100` = **−qty·100 %** (500 units → "−50000%"); `price_text` ("Best offer") is never shown. (b) Opening the mobile edit form on that lot selects the first option, so `app.js:3671-3673` PUTs `price_type:'per_unit', asking_price: 0`. `src/routes/inventory.rs:373-378` applies it and `sync::record_upsert("inventory", …)` (`:402`) propagates the destruction to every desktop **and to the public storefront listing**.
**Severity: P0.**

### 4. Completed-deal P&L and Profit Split on mobile ignore bank reconciliation, refunds, and the rep cut that desktop deducts
**Desktop** `src/components/CompletedBreakdown.tsx:24-29` — bank actuals win:
```tsx
const paired = recon ? recon.pieces.buyer_paired + recon.pieces.supplier_paired + recon.pieces.fee_paired : 0;
const fromPayments = paired > 0.005;
const revenue = fromPayments ? recon!.pieces.buyer_paired : flow.gross_revenue;
const costs   = fromPayments ? recon!.pieces.supplier_paired + recon!.pieces.fee_paired + recon!.pieces.refund_total - recon!.pieces.refund_in : flow.total_cost;
const profit  = fromPayments ? recon!.actual_profit : flow.net_profit;
```
(`actual_profit = buyer_paired − supplier_paired − fee_paired − refund_total + refund_in`, `src-tauri/src/commands.rs:11156`), and `CompletedBreakdown.tsx:299` renders `<RefundPanel dealFlowId={flow.id} />`, which reads the authoritative `deal_flow_payout` (`RefundPanel.tsx:18`). That command (`commands.rs:4974-4990`) computes `eff_net = net − refunded`, `cut = rep_cut_after_refund(...)`, **`remaining = eff_net − cut`**, and splits `remaining`.
**Mobile** `app.js:4988-5004` reads the stored row only and re-derives margin locally:
```js
const _cmgn = df.gross_revenue > 0 ? (df.net_profit/df.gross_revenue)*100 : 0;
const _dfAlloc = dealPayoutSplit(df);
… <div class="pl-value">${fmt(df.gross_revenue)}</div> … ${fmt(df.total_cost)} … ${fmt(df.net_profit)} …
${_dfAlloc.length ? `… ${payoutRowsHTML(_dfAlloc, df.net_profit)}` : ''}
```
and `dealPayoutSplit` (`app.js:569-578`) either replays the amounts frozen at completion or `allocatePayout(f.net_profit, meta.payout_included, _payoutRecipients)` — **raw `net_profit`, no refund subtraction, no rep-cut subtraction**. Same at `app.js:4711,4719` (completed drawer) and `4675,4710,4717`.
**Consequence:** for any bank-reconciled or refunded completed deal, mobile shows a different Revenue / Cost / Profit / Margin than desktop, the rep's cut is invisible on mobile, and owners see themselves splitting money the desktop has already deducted a rep cut and refunds from. After a refund is recorded, mobile keeps rendering the pre-refund owner amounts (desktop re-splits `eff_net − cut`; `commands.rs:4986-4991` re-reads the stored breakdown as **percentages** via `shares_from_breakdown`, mobile replays the stored **dollar amounts** verbatim, `app.js:572-575`).
**Severity: P0.**

---

# P1

### 5. Newsletter audience: tier presets compare CODES against LABELS → every tier audience resolves to 0 recipients
`app.js:3312` / `6333` store the raw API value: `_clientTiers[r.client_id] = r.tier`. `src/routes/clients.rs:1030-1043` returns **display labels**: `"Platinum" / "Diamond" / "Gold" / "Silver" / "Bronze" / "Prospect"`. `computeAudience` (`app.js:6360-6363`) compares against codes and does **not** call the existing `tierCode()` normalizer:
```js
const tier = _clientTiers[c.id] || '';
if (state.tier === 'ranked') { if (!RANKED_TIERS.includes(tier)) continue; }   // RANKED_TIERS = ['P','S','A','B','C','D']  (app.js:6325)
else if (Array.isArray(state.tier)) { if (!state.tier.includes(tier)) continue; }  // TIER_PRESETS codes (app.js:6326)
```
**Desktop** `src/components/EmailView.tsx:604-617` runs the identical comparison but its `api.getBuyerTiers()` returns codes (`src-tauri/src/commands.rs:1750-1758` `tier_for` → `"P"/"S"/"A"/"B"/"C"/"Prospect"`, used at `commands.rs:9528`), so it works.
**Consequence:** tapping "Ranked buyers" or any of Platinum/Diamond/Gold/Silver/Bronze on mobile makes the button read **"No recipients"** and disables it (`app.js:6616`, `6624`). Tier-targeted newsletters cannot be sent from mobile at all. (Analytics was already fixed via `tierCode` at `app.js:1773`; this call site was missed.)
**Severity: P1** (blocks work; would be P0 if it sent the wrong list instead of none).

### 6. Newsletter recipient list is computed from the boot-cached `_clients`, so clients added since page load are silently dropped
`app.js:6351` `for (const c of _clients)`. `_clients` is populated only by `loadClients()` (`app.js:497-499`), called at boot (`:603`) and by `syncNow` (`:528`). The default audience state is `{ tier:'all', exDormant:true, … }` (`app.js:6419`), so `app.js:6626-6630` takes the **`mode:'ids'`** branch, not `mode:'all'` — an explicit id list built from the stale array is POSTed to `/api/email/blast`.
**Desktop** `src/components/EmailView.tsx` re-fetches `api.listClients()` on mount and after every add (`:648`).
**Consequence:** a "Send newsletter to everyone (excluding dormant)" from a long-open PWA omits every client created on desktop since the tab loaded, with the confirm dialog reporting the wrong count.
**Severity: P1.**

### 7. Invoice-list row profit: mobile omits the projected-from-deal-flow branch and the "proj" marker
**Desktop** `src/components/InvoicesView.tsx:343-358` (with `flowMap` built at `:102-104` from `api.listDealFlows()`):
```tsx
if (inv.is_complete && inv.profit != null) profit = inv.profit;
else if (df && df.stage !== "complete") { profit = inv.total - df.cost; projected = true; }  // df.cost = total_supplier_cost
else if (inv.profit != null) profit = inv.profit;
else if (inv.total_cost != null) profit = inv.total - inv.total_cost;
```
plus a `proj` badge with `title="Projected profit — revenue minus costs entered so far"` (`:370-372`).
**Mobile** `app.js:3997`:
```js
const profit = inv.profit != null ? inv.profit : (inv.total_cost != null ? inv.total - inv.total_cost : null);
```
**Consequence:** for an in-progress deal, desktop shows `total − supplier costs entered so far` (marked projected) while mobile shows the stale invoice-level `profit` stamped at creation — typically the full total, i.e. 100 % margin — with no indication it is a projection.
**Severity: P1.**

### 8. Invoices screen "Outstanding" excludes drafts on mobile, includes them on desktop
Desktop `src/components/InvoicesView.tsx:192`: `invoices.filter((i) => i.status !== "paid" && !isVoided(i)).reduce((s, i) => s + i.total, 0)`.
Mobile `app.js:3925`: `live.filter(i => i.status==='sent'||i.status==='overdue').reduce((s,i)=>s+(i.total||0),0)`.
Neither matches the server's committed-AR `outstanding` (`src/routes/dashboard.rs:132`, which also requires `deal_flow_stage IN ('none','supplier_paid','payment_received','complete')`) that the Dashboard hero and Receivables screen use.
**Consequence:** three different "outstanding" figures across the same product; mobile's Invoices tile is lower than desktop's by the sum of all draft invoices. Mobile also shows `Total = live.length` (voided excluded) vs desktop `invoices.length` (voided included), and mobile drops desktop's Completed / Paid / Sent / **Total profit** tiles entirely (`InvoicesView.tsx:268-274`, `:199`).
**Severity: P1.**

### 9. Analytics month-over-month delta compares the in-progress month — desktop deliberately excludes it
**Desktop** `src/components/AnalyticsView.tsx:208-214`:
```tsx
// The in-progress current month is skipped: comparing a
// half-finished month against a complete one always reads as a fake drop.
const curMonth = new Date().toISOString().slice(0, 7);
const momSource = monthlySource.filter((m: any) => m.month !== curMonth);
const momLast = momSource.length > 1 ? momSource[momSource.length - 1] : null;
```
**Mobile** `app.js:1777-1778, 1783`:
```js
const mLast = monthly[monthly.length - 1] || {};
const mPrev = monthly[monthly.length - 2] || {};
… ${deltaVs(mLast.profit || 0, mPrev.profit, 'vs last month')}
```
**Consequence:** early in a month mobile Analytics shows a large fake "▼ x% vs last month" next to a hero reading `s.profit_mtd`; desktop shows the opposite sign or nothing. And because `monthly_profit` is `GROUP BY strftime('%Y-%m', completed_at)` (`src/routes/dashboard.rs:146-150`), months with no completed deals are absent — so in a month with no closes yet, `mLast`/`mPrev` are two *older* months and the chip compares data unrelated to the headline.
**Severity: P1.**

### 10. `/api/deals` returns no `client_name` — the deals screen renders a raw id fragment (same pattern as the invoice bug, different route)
`src/models.rs:143-164` `pub struct Deal` has `client_id` but **no `client_name`** (contrast `Invoice.client_name` at `models.rs:140`, `DealFlow.client_name` via `deal_flows.rs:105`, quotes via `quotes.rs:362`).
Mobile `app.js:2407, 2409, 2411, 2412, 2431`:
```js
const cn = clientName(d.client_id);
… <div class="list-avatar">${initials(cn)}</div>
… <div class="list-name">${esc(d.title||cn||'Deal')}</div>
… <div class="list-sub">${esc(cn||'—')}…
```
with `clientName` (`app.js:394-397`) falling back to `id.substring(0,8)`.
**Desktop** `src/components/DealsView.tsx:222`: `{clients.find((c) => c.id === deal.client_id)?.name || "Unknown"}`.
**Consequence:** any pipeline deal whose client isn't in the boot-cached `_clients` shows `a3f2b1c8` as the client name, `"A"` as the avatar initial (`initials()` on a hex string), and — when `title` is empty — as the deal's own title. Desktop shows "Unknown".
**Severity: P1.**

### 11. Deal-flow active list doesn't exclude refund deals; completed drawer isn't ordered by close date; no needs-review flag
**Desktop** `src/components/DealFlowView.tsx:144-165`:
```tsx
// ANY deal with refund activity is a refund, not an active pipeline deal — it lives
// in the Refunds section … and never shows in the active list.
const active = flows.filter((f) => f.stage !== "complete" && !refundMap[f.id] && isInvoiceActive(f) && matchFl(f));
const completedFiltered = completed.filter(matchFl).sort((a, b) => { … tb - ta; });   // by completed_at DESC
const needsWorkCount = completed.filter((f) => recon[f.id]?.needs_review).length;
```
**Mobile** `app.js:4632-4633`:
```js
const active = _dfFlows.filter(f => f.stage !== 'complete' && isInvoiceActive(f) && matchFl(f));
const completed = _dfFlows.filter(f => f.stage === 'complete' && matchFl(f));
```
**Consequence:** refunded deals sit in mobile's active pipeline (and its `${active.length} active` count, `app.js:4637`) where desktop has moved them out; mobile's completed drawer is ordered by `df.updated_at DESC` (server default, `deal_flows.rs:1126`) instead of close date, so the two lists read in different orders; mobile never surfaces the "needs review" recon count. Same omission on the Invoices screen — desktop hides `inRefund` invoices from the Active tab (`InvoicesView.tsx:169-175`), mobile's default filter is only `!i.voided` (`app.js:3982`).
**Severity: P1.**

### 12. `hasUnpaid` ignores `kept`, so mobile blocks/mis-drives the supplier-paid gate
Desktop `src/components/DealFlowView.tsx:473` (and `:1071`): `const suppliersPaid = hasSuppliers ? payments.every((p) => p.paid || p.kept) : true;`
Mobile `app.js:4747`: `const hasUnpaid = payments.some(p => !p.paid);` → drives `app.js:4776` (`Mark all suppliers paid`, disabled only when `!hasUnpaid`).
**Consequence:** on a deal whose only outstanding supplier is `kept`, desktop reads "Both legs done" and offers Complete; mobile still shows "Mark all suppliers paid" enabled, and pressing it marks the kept payment `paid` — converting a kept cut into a real payable. Mobile also renders no `kept` badge and offers no kept toggle (`set_supplier_payment_kept`, `src/lib/api.ts:1919`, has no REST route).
**Severity: P1.**

### 13. Server `buyer_tiers` diverges from desktop `tier_for` on three axes (the root of every mobile tier bug)
| | Desktop | Server (mobile) |
|---|---|---|
| tier value | codes `"P"/"S"/"A"/"B"/"C"/"Prospect"` — `commands.rs:1750-1758` | labels `"Platinum"/"Diamond"/…` — `clients.rs:1030-1043` |
| revenue basis | `net_paid = (actual_paid − refunded).max(0)` — `commands.rs:1845`, `refunded_by_client` `:1765-1775` | raw `SUM(CASE WHEN status='paid' …)` — `clients.rs:923`, no refund subtraction |
| `invoices_sent` | `COUNT(CASE WHEN status IN ('sent','overdue','paid') …)` — `commands.rs:1814`, with the comment at `:9441-9443` *"'Sent' always includes overdue — an invoice going overdue can't erase the fact it was sent, and dropping it here could demote a client a full tier"* | `COUNT(CASE WHEN status IN ('sent','paid') …)` — `clients.rs:924`, **omits `overdue`** |

**Consequence:** the same client can hold a higher tier on mobile than desktop (refunds not netted out), or a lower one (an overdue-only client reads Prospect on mobile, Bronze on desktop), and the label-vs-code mismatch cascades into findings 5 and 15. (Note: desktop is internally inconsistent too — `build_client_tier_map` uses `net_paid` (`:1845`) while `buyer_tiers` uses `actual_paid` (`:9528`).)
**Severity: P1.**

### 14. Receivables: mobile hides "lands in 7 days" in its default view, drops last-contact, and has no record-payment action
- **due_soon:** desktop `src/components/ReceivablesView.tsx:205` — `const dueSoon = data.summary.due_soon; // "lands in 7 days" is committed already` — rendered unconditionally at `:254-257`. Mobile `app.js:1928` only renders it when `!_arCommittedOnly`, and `_arCommittedOnly` **defaults to `true`** (`app.js:1845`). So the "$X lands within 7 days" line is never visible in normal use.
- **last contact:** desktop `ReceivablesView.tsx:203,317` — `lastContactWords(lastContact(it.client_id))` on every chase row. Mobile's row sub is `${it.invoice_number} · due ${it.due_date}` only (`app.js:1971`).
- **action:** desktop `ReceivablesView.tsx:274,321` gives each row `onRecord` → `RecordPaymentModal` → `api.markInvoicePaid`. Mobile rows only drill to the deal flow (`app.js:1987`).
(The committed-only re-summing itself is at parity: `app.js:1850-1877` `sumBuckets`/`regroup` mirrors `ReceivablesView.tsx:76-93` `deriveFromItems`.)
**Severity: P1** (workflow), P2 for the missing info lines.

---

# P2

### 15. Tier badges on Clients list + Client detail render every tier in Prospect gray
`app.js:62-67` `tierBadgeHTML` keys on codes (`{P:…,S:…,A:…,B:…,C:…,Prospect:…}`) with `const m = map[tier] || ['tier-prospect', tier]`. It is called with the raw **label** at `app.js:3392` (`tierBadgeHTML(tier)`, `tier = _clientTiers[c.id]`), `3456`, and `3458`. `map['Platinum']` is undefined → the badge shows the right text with the **`tier-prospect`** class. Only the Tiers screen (`app.js:1723-1724` via `tierCode`) and Analytics (`:1814`) get correct colors. Desktop colors every tier correctly.
**Severity: P2.**

### 16. `clientName()` still used on four surfaces even though the server now joins `client_name`
`src/models.rs:136-140` added `Invoice.client_name` (`INVOICE_COLS` index 28, `invoices.rs:198`), but `app.js` still calls the boot-cache lookup at `:3136` (dashboard "Recent invoices"), `:3989` (invoice **search** filter — searching a client name silently matches nothing on a cache miss), `:4002` (invoice list row), `:4209` (invoice detail hero). Each falls back to `id.substring(0,8)`. Mechanical fix: read `inv.client_name`.
**Severity: P2** (server side already fixed; mobile side not switched over).

### 17. Tapping a supplier on mobile opens the edit form, not the deal history
`app.js:2221`: `$$('.supplier-item').forEach(b => … showSupplierForm(b.dataset.id))`. Desktop `src/components/SuppliersView.tsx:378` opens `<SupplierDealsModal>` → per-supplier completed-deal list rendered through `CompletedBreakdown` (`SupplierDealsModal.tsx:140`). Mobile has no way to see which deals a supplier was on.
**Severity: P2** (workflow parity).

### 18. Missing status-badge CSS for the real lead-status vocabulary
`www/style.css:531-544` defines `badge-active`, `badge-inactive`, `badge-prospect`, `badge-draft/sent/paid/overdue/void/invoiced/payment_received/supplier_paid/complete/completed` — but **no** `badge-active_customer`, `badge-hot_lead`, or `badge-warm`. `app.js:382-387` builds `'badge-' + status`, so desktop-set `active_customer` and mobile's own `hot_lead`/`warm` clients render an unstyled badge reading "active customer" / "hot lead". (`badge-active` exists but only mobile-created clients ever carry `'active'` — see finding 2.)
**Severity: P2.**

### 19. Analytics monthly table mixes refund-netted profit with gross revenue in a JS margin
`app.js:1801`: `const mg = m.revenue>0?(m.profit/m.revenue*100):0`. `m.profit` is `net_profit − SUM(refunds)` while `m.revenue` is un-netted `SUM(gross_revenue)` (`src/routes/dashboard.rs:147-149`). The margin column therefore understates on any month with refunds, and there is no desktop counterpart (desktop plots charts, not a margin table) to agree with.
**Severity: P2.**

### 20. Invoice-form client picker filters name only
`app.js:4138`: `_clients.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))` — no company / email / phone match, and it will throw on a client with a null `name` (no `||''` guard, unlike every other filter in the file, e.g. `app.js:3366`).
**Severity: P2.**

### 21. Deal-flow supplier picker offers archived suppliers
`loadSuppliers()` (`app.js:501-503`) caches the raw `/api/suppliers` list; `renderSuppliers` filters `!s.archived` (`app.js:2200`) but the two pickers do not (`app.js:5357`, `5508`: `_suppliers.filter(s => (s.name||'')…)`), so archived suppliers remain selectable when adding a cost to a deal.
**Severity: P2.**

### 22. Dashboard client count has two different sources on two screens
`app.js:3030`: `const clientsN = s.clients != null ? s.clients : (_clients ? _clients.length : 0)` — server `COUNT(*) FROM clients WHERE org_id` (`src/routes/dashboard.rs:114`, live) vs the Clients screen's `cTot = _clients.length` (`app.js:3336`, boot-cached). Any client added since page load makes the two tabs disagree until Sync now is pressed.
**Severity: P2.**

### 23. Rep home labels the whole org's client list as "yours"
`app.js:2981-2982, 2987-2988`: `myClients = _clients.length` / `activeClients = _clients.filter(… 'active')` rendered as **"Your clients" / "Active clients"**. `list_clients` (`src/routes/clients.rs:631-727`) scopes by `org_id` only — there is no rep filter — so a sales rep sees the org-wide count under a possessive label (and the Active tile is always 0, per finding 2).
**Severity: P2.**

---

**Cross-cutting note for the fix pass:** four of these (1, 2, 3, and the `kept` half of 12) are the same failure mode — *mobile round-trips a record through a narrower schema than the desktop's and writes the truncation back through `record_upsert`*. Any mobile form that renders a `<select>` from a value set narrower than the canonical one, or any server struct that omits a desktop column inside a JSON blob, will silently destroy data on save. Worth a one-off audit of every `<select>` in `app.js` against its desktop option list, and of `src/models.rs` blob structs against their `src-tauri/src/commands.rs` twins.

---

# AUDIT C — LAYOUT & INFORMATION PARITY

TASK C — LAYOUT & INFORMATION PARITY (desktop vs mobile PWA), screen by screen. New findings only; the 102 PARITY-PLAN items and the 5 in-flight fixes are excluded.

## P0

**1. SUPPLIERS — mobile supplier edit silently NULLs address + all payment fields and syncs the wipe to every desktop**
Desktop form writes 10 columns: name, contact_name, email, phone, `address`, `payment_method`, `payment_terms`, `payment_details`, `typical_lead_time`, notes (`BUSINESS APP/src/components/SuppliersView.tsx:269-305`). Mobile form has only 5 inputs (`clienthub-api/www/app.js:2229-2237`) and its PUT body sends only those 5 (`app.js:2264-2270`). Server `update_supplier` is an unconditional full-column write — `SupplierInput` fields are `Option<String>` so absent keys deserialize to `None`:
```rust
// clienthub-api/src/routes/suppliers.rs:137-141
cols.insert("address".into(), json!(input.address));
cols.insert("payment_method".into(), json!(input.payment_method));
cols.insert("payment_details".into(), json!(input.payment_details));
cols.insert("payment_terms".into(), json!(input.payment_terms));
cols.insert("typical_lead_time".into(), json!(input.typical_lead_time));
```
then `record_upsert("suppliers", …)` (`suppliers.rs:144`) + `UPDATE … address=?5,payment_method=?6,payment_details=?7,payment_terms=?8,typical_lead_time=?9 …` (`suppliers.rs:150-157`). `SupplierInput` = `clienthub-api/src/models.rs:455-466`.
Consequence: fixing a supplier's phone number from a phone permanently erases their wire/bank payment details, payment terms, address and lead time on the server and on every desktop. Note `update_client` was already hardened against exactly this (it merges from stored metadata, `routes/clients.rs:276-295`) — suppliers is the surviving instance.
Severity: **P0**

**2. SETTINGS → Company info — mobile save destroys company phone, tax ID (and logo) org-wide**
Desktop CompanyInfo edits name, address, email, **phone**, **tax_id** (+ logo) (`SettingsView.tsx:1481`; model `clienthub-api/src/models.rs:334-341`). Mobile renders only 3 inputs (`app.js:6176-6179`) and PUTs only 3 keys (`app.js:6239-6243`). Server stores the raw body verbatim: `let json_str = serde_json::to_string(&body)` → `record_upsert("settings", company_info)` (`clienthub-api/src/routes/settings.rs:363-378`).
Consequence: one tap of "Save Company" on mobile strips phone + tax_id (and `logo_path`) from `company_info`, so every subsequent invoice/quote/release-letter PDF from any surface loses them. (The logo half of this is already in PARITY-PLAN; the phone/tax_id loss caused by the missing form fields is not.)
Severity: **P0**

## P1

**3. CLIENTS — `lead_status` vocabulary is three-way divergent; the mobile "Active" pill and stat can never match desktop data**
Desktop counts/filters on `active_customer` / `hot_lead` (`ClientsView.tsx:94`, `:313`, `:605-612`, `:684-688`) but its own New-Client form writes **space-separated** values `"hot lead"` / `"active customer"` (`ClientsView.tsx:869-875`). Mobile writes `"active"` and offers `warm` (`app.js:3794`), and filters/counts on `'active'` (`app.js:3338`, `:3365`, `:2982`).
Consequence: desktop-created active customers never appear under mobile's "Active" pill and never count in mobile's "Active" stat (reads 0); mobile-created ones are unreachable from desktop's Status filter, which has no `active` option. Also `statusBadgeHTML` builds class `badge-active_customer`/`badge-hot_lead`/`badge-warm` (`app.js:383`) and none exist in `style.css` (only `.badge-prospect/.badge-active/.badge-inactive`, `style.css:540-542`) → those clients render an unstyled, background-less badge in both themes.
Severity: **P1**

**4. CLIENT DETAIL — mobile drops the entire Financials block, the portal link, client notes, and all metadata cards**
Desktop shows: Financials tiles Outstanding / Paid / Invoices sent (`ClientDetailView.tsx:394-399`), credit limit + exposure + available + "Over limit" pill (`:400-411`), Client-portal generate/copy/revoke (`:413-432`), `client.notes` (`:434-440`), and three metadata cards — Contact Info (job_title, street_address, city/state/zip, country), Business Info (category, website, tax_id, primary_buy_category, other_buy_categories, estimated_annual_spend, purchase_frequency), Lead Info (lead_source, interest_level, buyer_type, lead_id, rep, date_added, last_contact_date, editable next_follow_up_date) + Custom Fields (`:442-505`), plus "Send our details" (`:303-309`), AI Summary (`:527-549`) and an Emails tab (`:632-660`).
Mobile detail shows only: name, company, rep, 4 stat tiles, email/phone, 3 flag switches, credit sections, last 10 invoices, last 15 interactions (`app.js:3445-3505`).
Consequence: on a phone you cannot see a client's address, lead source, buyer type, follow-up date, custom fields, outstanding-vs-paid split, or their internal notes — and can't hand out a portal link.
Severity: **P1**

**5. CLIENTS LIST — mobile shows no Hot-Leads stat and no data-health/needs-review signals**
Desktop stats bar: Total Clients, **Active Customers**, **Hot Leads**, Total Revenue (`ClientsView.tsx:383-393`); rows carry a `needs_review` AlertCircle plus missing-info icons for email/phone/address/category (`ClientsView.tsx:735-736`, `:748-755`), and a Data-Health panel breaking down missing email/phone/address/category/never-contacted/needs-review (`ClientsView.tsx:408-440`). Mobile stats: Clients, Revenue, Active only (`app.js:3336-3342`); rows carry no needs_review and no missing-field icons (`app.js:3376-3396`).
Consequence: the "which clients are incomplete / need review" workflow has no mobile surface, and Hot Leads (the pipeline signal) is invisible.
Severity: **P1**

**6. CLIENT FORM — mobile omits Country and "Needs review"**
Desktop form has Country and a `needs_review` checkbox (`ClientsView.tsx:892-899`). Mobile form has neither (`app.js:3787-3805`); its save body omits both (`app.js:3836-3849`).
Consequence: a lead flagged for review on desktop can't be cleared from mobile, and country can never be set from the client form. (Distinct from the known P3 about the *approval* editor's country being dropped server-side.)
Severity: **P1**

**7. INVOICES LIST — mobile drops the Due-date column and the Total-profit stat**
Desktop columns: Number, Client, **Issue**, **Due**, Total, **Profit**, Status (`InvoicesView.tsx:331-337`, rows `:363-393`). Desktop stats: Total, Completed, Paid, Sent, Overdue, **Total profit** (`InvoicesView.tsx:267-274`) and a header line "N total · $X outstanding" where outstanding = all non-paid non-void (`:192`, `:214`).
Mobile row shows number + client + **issue_date** only, no due date (`app.js:3993-3999`); stats are Total / Outstanding / Overdue (`app.js:3929-3932`) with outstanding narrowed to `status==='sent'||'overdue'` (`app.js:3925`), and no profit total anywhere.
Consequence: you cannot see when an invoice is due from the mobile list (the core AR-chase read), and the screen's headline profit number is absent; the two surfaces' "outstanding" also differ by every draft invoice.
Severity: **P1**

**8. INVOICES LIST — no refund indicator on mobile rows**
Desktop stamps each row with `Refund · $remaining` / `Refunded` from `refundMap` (`InvoicesView.tsx:384-389`) and its default "active" tab hides invoices currently in a refund (`InvoicesView.tsx:170-175`). Mobile has no refund read on the list at all (`app.js:3993-4013`).
Consequence: a refunded/partially-refunded invoice looks like a clean paid sale on mobile.
Severity: **P1**

**9. INVOICES LIST — mobile shows projected profit as if it were final**
Desktop computes profit three ways and tags in-progress deals: `profit = inv.total - df.cost` with a `proj` chip and tooltip when the flow isn't complete (`InvoicesView.tsx:344-358`, `:371-378`). Mobile: `const profit = inv.profit != null ? inv.profit : (inv.total_cost != null ? inv.total - inv.total_cost : null)` (`app.js:3997`) — no deal-flow read, no projected marker.
Consequence: mid-flight deals show either no profit or an unlabelled number the user reads as booked profit.
Severity: **P1**

**10. SUPPLIERS — mobile has no search, no archived access, and no supplier stats**
Desktop: search box + all/active/archived filter (`SuppliersView.tsx:128-152`), per-supplier stats Total paid / Deals / **Avg deal** / **Last deal** (`:243-248`), "View completed deals (N)" modal (`:259-266`), and **price history** list (`:317-340`). Mobile hard-filters `!s.archived` with no search and no filter (`app.js:2201`), and the edit sheet shows zero stats (`app.js:2227-2243`).
Consequence: archived suppliers are unreachable on mobile; you cannot see a supplier's average deal size, when you last dealt with them, their deals, or their price history — and with more than ~15 suppliers the list is unusable without search. `avg_deal_amount` / `last_deal_date` are already in the payload (`clienthub-api/src/routes/suppliers.rs:44-45`, `:79-80`), so this is pure app.js.
Severity: **P1**

**11. INVENTORY — mobile has no search, status filter, category filter, sort, or stale/renew surface**
Desktop toolbar: search over name/supplier/category/location/notes, status segmented control with per-status counts, "N need renewing" (stale >2 days), category filter, send-status filter (email/whatsapp/**facebook**/none), sort by newest/profit/margin/value/stale-first (`InventoryView.tsx:537-600`), plus a new-offers banner (`:520-534`) and a needs-attention count (`:391`).
Mobile renders every lot flat in server order with no controls at all (`app.js:2487-2519`).
Consequence: sold and archived lots are mixed into the working list with no way to filter, the 2-day renew flow doesn't exist on the device where it matters, and mobile's Lots/Units/Value stats (`app.js:2489-2492`) silently include sold + archived lots.
Severity: **P1**

**12. INVENTORY — custom-priced ("make an offer") lots show $0 and a fake loss on mobile**
Desktop zeroes all price math for `price_type === "custom"` and renders `details_json.price_text` verbatim instead (`InventoryView.tsx:368-372`, `:789-790`, `:857-861`). Mobile has zero handling for `'custom'` — `loadPrice`/`profitOf`/`marginOf` (`app.js:2479-2483`) fall through to the total branch, and `grep 'custom'` over app.js returns nothing.
Consequence: an offer-priced lot shows `$0` as its load price and, whenever a cost is recorded, a negative "profit" of `−cost` on both the row and the detail hero (`app.js:2513-2515`, `:2533-2538`); the Value stat under-counts these lots. The root enabler is server-side: `/api/inventory` never returns `details_json` (`clienthub-api/src/routes/inventory.rs:212-244`).
Severity: **P1**

**13. INVENTORY — the whole `details_json` layer is missing from the mobile payload and UI**
`LotDetails` carries pallets, msrp, avg_msrp, moq, size_run, price_text, open_to_offers, options, **variants**, extra **categories**, **condition**, **prev_price** (`BUSINESS APP/src/lib/api.ts:1176-1196`); desktop renders the variant breakdown (`InventoryView.tsx:2083-2092`), condition (`:1380`, `:1533`), and a "Reduced" price-drop badge (`:796-797`, `:864-866`). `/api/inventory` selects none of it and also omits `updated_at` (`routes/inventory.rs:212-218`), which is what `isStale` needs (`InventoryView.tsx:25`).
Consequence: condition (a v0.15.111 field buyers ask about), the units-per-brand/size split, multi-category tags, and price drops are invisible on mobile; the stale-listing flow is impossible.
Severity: **P1**

**14. QUOTES — mobile has no status filters and no search**
Desktop: 6 status pills with counts (all/draft/sent/accepted/declined/expired) + search by customer or quote # (`QuotesView.tsx:131-152`, counts `:65`). Mobile dumps every quote in one list, no pills, no search (`app.js:2292-2307`).
Consequence: with a real quote book you cannot find a quote or see "what's still out there vs expired" on a phone.
Severity: **P1**

**15. QUOTES DETAIL — line items lose Qty and Rate on mobile**
Desktop line-item table: Description / Qty / Rate / Amount (`QuotesView.tsx:326-334`). Mobile collapses to `description ×qty  amount` and drops the Rate entirely (`app.js:2328`).
Consequence: the per-unit price you quoted is not visible on mobile — you can't answer "what did I quote per unit?" without a desktop.
Severity: **P1**

**16. DEALS (pipeline) — mobile has no pipeline at all, just a flat list**
Desktop is a kanban: one column per stage with a count badge, drag-to-move, per-card margin % chip, expected close date, and a show/hide-lost toggle (`DealsView.tsx:191-245`). Mobile renders one undifferentiated list of every deal — lead, won and lost together — with no stage counts, no margin %, no expected close date, no lost reason (`app.js:2404-2419`).
Consequence: the pipeline read (how much is at which stage, what's closing when) has no mobile equivalent; lost deals pad the list.
Severity: **P1**

**17. ANALYTICS — mobile never renders Top suppliers or Most-profitable clients, though the payload carries both**
Desktop cards: "Most profitable" clients (`AnalyticsView.tsx:656`) and "Top suppliers" with bars (`:764-790`). `/api/dashboard/stats` already returns `top_clients_by_profit` and `top_suppliers` (`clienthub-api/src/routes/dashboard.rs:288`, `:304`). `grep 'top_suppliers|top_clients_by_profit' www/app.js` → zero hits; mobile renders only `top_spenders` (`app.js:1817-1826`).
Consequence: "where the cost of goods goes" and "who actually makes me money (vs who just spends)" are desktop-only despite the data already being on the wire.
Severity: **P1**

**18. ANALYTICS — no date range, no Total cost, no Open closeouts**
Desktop has preset pills + custom start/end range + Export driving every figure (`AnalyticsView.tsx:241-283`) and a Financial-snapshot card with Revenue / **Total cost** / Net profit / Margin / Outstanding / **Open closeouts** (`AnalyticsView.tsx:702-709`). Mobile Analytics is fixed to whatever `/api/dashboard/stats` returns, with no range control, no total cost and no closeout count (`app.js:1779-1835`).
Consequence: you cannot ask "how did last quarter do?" on mobile, and the revenue − cost = profit identity isn't shown.
Severity: **P1**

**19. RECEIVABLES — mobile chase list has no "Record payment" action and no last-contact read**
Desktop AR row: client, speculative tag, due/overdue chip, invoice #, due date, **"…last contacted N days ago"**, amount, **Record payment** button (opens date/method/reference modal) and View deal (`ReceivablesView.tsx:303-333`, modal `:110-153`). Mobile AR row has amount + age and drills into the deal only — no mark-paid, no last-contact (`app.js:1961-1980`).
Consequence: the single most common AR action (customer just paid → mark it) requires leaving AR and hunting the invoice; and you can't see whether you've already chased them.
Severity: **P1**

**20. INVOICE FORM — mobile has no over-credit-limit warning and no line-item templates**
Desktop warns before creating: "Over credit limit. This invoice ($X) puts this buyer's open exposure at $Y, above their $Z limit." (`InvoicesView.tsx:748-754`), offers reusable line-item template chips (`:703-713`), an inline new-client path (`:622-630`), and a "View actual PDF" preview (`:759-763`). Mobile's form has none of these (`app.js:4026-4068`).
Consequence: a rep can invoice a buyer straight past their credit limit from a phone with no signal, even though mobile already reads credit status on the client screen (`app.js:3559`).
Severity: **P1**

**21. NEWSLETTERS / EMAIL — no inbox and no drafts/saved templates on mobile**
Desktop EmailView has five modes: newsletter, recurring, **inbox**, **drafts**, compose (`EmailView.tsx:14`, `:58`), including a "Saved templates (N)" drawer and a draft picker (`:1044-1070`) and a sent-history list (`:1351-1362`). Mobile has Send newsletter / Compose / Test + 3 subtabs Scheduled / Recurring / History (`app.js:6421-6453`); `grep 'inbox'` in app.js finds only onboarding copy and the feedback inbox.
Consequence: received customer email cannot be read on mobile at all, and a newsletter drafted on desktop cannot be opened, reused or sent from a phone.
Severity: **P1**

**22. TIERS — six tiers rendered in a five-column grid**
`TIER_ORDER = ['P','S','A','B','C','Prospect']` (6 entries, `app.js:1600`) feeds `.tier-cards { grid-template-columns: repeat(5, 1fr) }` (`clienthub-api/www/style.css:564-566`). Desktop uses `grid-cols-3 xl:grid-cols-6` for the same six (`TiersView.tsx:67`).
Consequence: the Prospect card orphans onto a second row at 1/5 width; at 375px each of the five cards is ~64px wide against a `.list-badge` reading "Platinum" (~58px incl. padding), so the badges hit/overflow the card edge. The Platinum rollout updated the JS but not this grid.
Severity: **P1** (visibly broken since v0.15.119)

## P2

**23. DASHBOARD — pending approvals collapse to a bare count on mobile**
Desktop lists up to 4 named pending clients with initials, email, and inline Review / Approve / Reject, plus "N more waiting" (`DashboardView.tsx:300-333`). Mobile renders one aggregate row "N pending clients" that just navigates (`app.js:3084`).
Consequence: approving a lead from the phone is 3 taps deeper and you can't see who is waiting from the dashboard.
Severity: **P2**

**24. DASHBOARD — hero figures lose their definitions**
Desktop labels each hero number: "paid invoices this month" / "completed deals this month" (`DashboardView.tsx:236-238`, `:250-252`). Mobile's hero cells have label + value only (`app.js:3047-3053`).
Consequence: Revenue and Profit are unexplained on mobile, which is exactly where the two surfaces' definitions get questioned.
Severity: **P2**

**25. BRIEF — the "Profit from deal flows" headline is a different number on each surface**
Desktop shows `net_profit_this_week` (`BriefView.tsx:201-206`). Mobile shows `net_profit_this_week + |loss_total_this_week|` labelled "Profit earned", with net demoted to a sub-line (`app.js:5782-5786`).
Consequence: in any period containing a loss-making deal the same brief card reports a bigger number on the phone than on the desktop — reads as a sync bug.
Severity: **P2** (numbers are reconcilable, but the headline differs)

**26. BRIEF — no Print, no Email, no "Generated at"**
Desktop toolbar has Print and Email buttons (`BriefView.tsx:137-149`) and stamps `Generated {timestamp}` (`BriefView.tsx:167-169`). Mobile has Refresh only (`app.js:5663`) and no generated-at line.
Severity: **P2**

**27. DEAL FLOW — completed drawer hides the "needs review" count on mobile**
Desktop drawer header carries `⚠ N need review` next to the count plus "Sync from bank" (`DealFlowView.tsx:274-289`). Mobile drawer header shows the count only (`app.js:4666-4672`).
Consequence: unreconciled completed deals are invisible from the phone.
Severity: **P2**

**28. INVOICE DETAIL — a paid invoice can't be marked fell-through on mobile**
Desktop's drawer footer offers "Mark deal fell through" for any non-voided invoice, paid included (`InvoicesView.tsx:1051-1055`). Mobile's `status === 'paid'` branch renders only View PDF + Archive (`app.js:4275-4277`).
Consequence: the INV-2026-0038 case (a completed deal that later collapses) can only be voided from a desktop.
Severity: **P2**

**29. QUOTE DETAIL — no "converted" indicator**
Desktop shows a green check "Converted to an invoice" (`QuotesView.tsx:187-189`). Mobile only hides the Convert button (`app.js:2338-2344`); nothing tells you the quote already became an invoice.
Severity: **P2**

**30. CLIENT DETAIL — Unsubscribed badge missing; invoice rows show issue date instead of due date**
Desktop detail chips include the Unsubscribed badge with its opt-out date (`ClientDetailView.tsx:361-366`); mobile's chip row has status + tier + "No contact yet" only (`app.js:3457`) even though the list row does render it (`app.js:3384`). Desktop's per-client invoice rows read "Due {date}" (`ClientDetailView.tsx:617`); mobile prints `issue_date` (`app.js:3487`).
Severity: **P2**

**31. style.css — badge classes with no dark-mode override render light-mode pills in dark**
`.news-status-g { background:#D1FAE5; color:#065F46 }` and `.news-status-r { background:rgba(255,101,32,.12); color:#C24509 }` (`style.css:1445-1446`) have no `html.dark` rule — the dark block covers only `news-status-p` (`:1632`) and `news-status-a` (`:1638`).
Consequence: "completed" and "running" newsletter pills glare as light chips in dark mode. (Same root cause as finding 3's missing `.badge-active_customer` / `.badge-hot_lead` / `.badge-warm`.)
Severity: **P2**

**32. style.css — client-row badges get clipped away by `nowrap` truncation**
`.list-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }` (`style.css:523`), and the clients row injects up to five inline badges (Blacklisted / High-value / No bulk / Unsubscribed / No contact yet) *inside* `.list-name` (`app.js:3387`). Desktop wraps them onto their own flex-wrap line below the name (`ClientsView.tsx:736-755`).
Consequence: for any client whose name fills the column, the Blacklisted / No-bulk / Unsubscribed flags are ellipsised out of existence at 375px — send-safety flags silently disappear.
Severity: **P2**

**33. style.css — completed-deal rows squeeze the client name to a sliver**
`.df-done-stats { display:flex; gap:16px; flex-shrink:0 }` with three money stats at 13px (`style.css:1137-1150`) sits beside a `flex:1;min-width:0` name column, and `.df-done-name` has no ellipsis (`style.css:1127-1131`). At 375px the row's usable width is ~315px; three six-figure values plus labels consume ~250px.
Consequence: "Client → Supplier" wraps to three or four lines of a few characters each on the Deal Flow completed drawer (`app.js:4677-4680`).
Severity: **P2**

**34. style.css — line-item Description input is ~100px wide in the invoice/quote form**
`.line-item-row { grid-template-columns: 2fr 48px 72px 72px 28px; gap:4px }` with `input { font-size:16px }` (`style.css:721-731`) inside `.modal { width:100%; padding:20px 16px }` (`style.css:601-608`). At 375px: 343px content − 220px fixed − 16px gaps = ~107px for Description, ~6 visible characters. Desktop gives Description 6/12 columns (`InvoicesView.tsx:672-673`).
Consequence: typing or reviewing a line-item description on a phone is effectively blind — the primary invoice-creation form.
Severity: **P2**

**35. style.css — filter pills are ~30px tall (below tap-target minimum)**
`.filter-pill { padding:6px 14px; font-size:13px }` with no `min-height` (`style.css:1166-1175`) → ≈30px. Every other interactive mobile control in the file is explicitly 44px (`.btn-sm` `:630`, `.chk-tab` `:671`, `.cat-add .btn` `:1561`, `.qi` `:460`).
Consequence: the primary filter control on Clients, Invoices and Tiers is the hardest thing on the screen to hit.
Severity: **P2**

**36. INVOICE ROW — flow dots ignore `is_complete` on mobile**
Desktop: `<FlowDots stage={inv.is_complete ? "complete" : inv.deal_flow_stage} />` with the comment "a completed invoice always shows all stages filled" (`InvoicesView.tsx:383`). Mobile: `flowDotsHTML(inv.deal_flow_stage)` (`app.js:4007`, detail `:4216`).
Consequence: a completed invoice whose `deal_flow_stage` lags shows a partially-filled stepper on mobile and a full one on desktop.
Severity: **P2**

## Near-parity (checked, no finding)
Tiers list rows (`app.js:1712-1750` vs `TiersView.tsx:124-174`) match on every column including reliability and avg-margin. Brief actually exceeds desktop on mobile (pipeline snapshot, stuck deals, at-risk customers, monthly history — desktop renders none of those: `grep at_risk_customers|stuck_deals|deals_by_stage BriefView.tsx` → no hits). Receivables/Payables aging bars, bucket chips, committed/speculative toggle and grouped views are a faithful port.