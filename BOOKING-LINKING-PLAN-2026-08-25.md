# Booking & smart-linking optimization plan (R-204) — 2026-08-25

Jack: *"right now it sucks at showing payments to suggest when i am linking it to a deal and i need it to be more visually appealing to use when doing so. the active deals dont stand out enough and mix with completed deals when suggestioning."*

Measured before planning: the full server engine (`clienthub-api/src/routes/bank_suggest.rs`, 1,198 lines) and the full desktop flow (`FinancialsView.tsx`, 5,170 lines). Extends R-150; nothing here weakens the money invariants — every booking still flows through `allocate_bank_txn` with its existing guards.

---

## Why it feels bad — the measured causes

Jack's two complaints trace to specific code, not vibes:

**"Active deals don't stand out and mix with completed":**
- The server loads `stage` into every candidate row and **never reads it** (`bank_suggest.rs:231/:268` — grep confirms zero scoring uses). A completed deal scores identically to an active one.
- The desktop picker (`filteredDeals`, `FinancialsView.tsx:2129-2152`) never filters or groups on stage. The only signal is a 10px right-aligned "Completed"/"Open" word (`DealRowContent:323-325`).
- Worse, the picker's recency tiebreak is `completed_at || created_at` (`:2146`) — **a deal completed yesterday outranks a deal invoiced last week that is actually awaiting its payment.** The sort actively favours dead deals.
- `survivorDeals` (`:505-513`) keeps the highest-stage duplicate per invoice, so where duplicate rows exist the completed one is the one shown.

**"Sucks at showing payments to suggest":**
- **Fully-paid check is bank-only.** Outstanding = `invoice_total − bank-linked buyer payments` (`bank_suggest.rs:294-305/:366`). `payment_received_amount`, `deposit_amount` and `invoices.paid_at` are invisible — a cash-settled or manually-marked-paid deal is re-suggested forever at full value.
- **Long wire memos can't match a deal at all.** The token-coverage/alias/company matching built for exactly this (`covers`, `alias_keys`, `clients.company`) exists only in the *person* path (`:445-611`). The deal path uses a raw Dice coefficient — a 40-token wire memo vs a 2-token client name scores ~0.095, below the 0.3 gate. The same wire that names a counterparty perfectly produces **zero deal candidates**.
- **The strongest filter is discarded**: a txn already tagged to a client/supplier (`counterparty_id`) is still scored against the entire deal pool by fuzzy name instead of being narrowed to that party's deals.
- **All-or-nothing chip gating**: when the top two candidates are within 20 points, the desktop shows *nothing* (`serverMatchFor:297-299`) — the most common real case ("it's one of these two") gets zero help.
- **The server's reasoning never reaches the picker.** The +250 boost silently reorders the list, but `reason`, `tier`, `score`, `leg_amount` are all dropped — a server-nominated deal sits at #1 with no badge and no explanation (`:2143` vs `:4857`).
- **False "certain"**: `id_score` is unanchored substring matching — invoice `10412` matches inside a wire trace `TRN: 3104125ES` (`:189-199`) and gets the highest-confidence label the UI can render.

**Flow cost:** the normal path is 5 clicks + a 560px 8-section drawer per link; even the 1-click "Tie to…" chip needs a second redundant Book click because nothing sets `reviewed` on allocate. The picker dropdown has no click-outside/Escape dismiss and caps at ~5 visible rows; no open-balance is shown anywhere — the one number that says whether a payment fits.

Full weakness inventories (28 server, 20 desktop) are in the session transcript; the ones above are the load-bearing subset.

---

## Design principles (locked to existing rules)

- Suggest + one-tap confirm stays; no auto-allocation (R-150 decision 1).
- Server engine stays read-only over the mirror; desktop stays the only writer.
- **Never hide completed deals** — late buyer payments, supplier settlements and refunds legitimately link to them, and for `refund_*` roles completed deals are the *expected* target. Group and demote, don't remove.
- Design system: sentence case, no uppercase kickers, tokens only (no theme-inverting literals), Satoshi, 130ms motion. The existing `PersonPicker.tsx` is the in-house reference — it already has the grouped-sections + reason-hints design the deal picker lacks.

---

## Phase 1 — server ranking correctness (`bank_suggest.rs` only + deploy)

The engine changes are additive to the response contract, so fielded desktops keep working.

1. **Stage-aware scoring.** Active deals (`invoiced`, `payment_received`, unpaid) get a rank boost for `buyer_payment`/`supplier_payment` roles; completed-and-fully-paid deals are demoted (still eligible, never excluded — see principles). Emit `stage` and a computed `active: bool` per candidate so the UI can group without re-deriving.
2. **True outstanding.** Fold `payment_received_amount`/`deposit_amount`/`paid_at` into the buyer paid-check alongside bank allocations (take the max of the two views, never sum — the same payment can be both recorded and bank-linked). A fully-settled deal drops out of buyer suggestions.
3. **Port the person-matcher to deals.** `covers()`, `alias_keys()`, and `clients.company` into the deal name score — the single largest recall fix; the machinery already exists and is tested in the same file.
4. **Respect the tag.** A txn with `counterparty_type/id` set narrows the pool to that party's deals first (fall back to the full pool only if the party has none eligible).
5. **Anchor `id_score`.** Word/digit-boundary match, and demote to `strong` when the only signal is a reference hit inside a longer token run — kills the false "certain".
6. **Deterministic ties + honesty.** Tie-break by active-first then date proximity; add `truncated`/`checked` to `/bulk` (reconciliation-missing already has it); unify `leg_amount` semantics (always "what's still owed on this leg") and document it in the response.
7. **Tenancy fix in passing:** `load_buyer_paid`/`load_allocated_roles` get the org scope every sibling query has (`:294-320`).

Verify: extend the existing test suite (10 tests today) with fixtures for each — a wire memo that names a client with a company-only match, a cash-settled deal that must not resurface, a completed vs active tie, the trace-number false-certain. Deploy per runbook (matched set: `bank_suggest.rs` is already in the deployable list; re-check the runbook at build time).

## Phase 2 — the deal picker redesign (`FinancialsView.tsx`, extract `DealPicker.tsx`)

Model it on `PersonPicker.tsx`, which already got this right:

1. **Three sections, visually distinct:**
   - **Suggested** — server candidates with their reason line ("INV-0041 · exact amount · 3 days after due") and a tier accent. Reason/tier/score finally reach the UI.
   - **Active deals** — open balance shown per row ("$12,500 of $47,000 open"), sorted by fit (amount proximity, then the *right* recency: last activity, not `completed_at || created_at`).
   - **Completed** — collapsed group ("Completed — 84"), dimmed rows, expands on click; auto-expanded when the chosen role is a refund.
2. **Row anatomy:** client/deal name + invoice number, stage pill (accent for active, muted for completed), open balance right-aligned where `invoice_total` sits today. An amount that fits the txn exactly gets the match micro-label the local matcher already renders.
3. **Mechanics:** click-outside + Escape closes the dropdown (Escape currently kills the whole drawer); "showing 20 of N" with a load-more instead of the silent `.slice(0,20)`; amount pre-fill rounded to cents (no float tails); search also matches amounts ("47000" finds the $47,000 deal).
4. **One component, both callers:** `BulkAllocateModal` (today: unscored, recency-only, slices at 40) uses the same `DealPicker`, so bulk stops being *more* likely to hit a dead deal than single.

## Phase 3 — suggestion surfaces and click cost

1. **"Tie & book" one click.** When the tie fully allocates the txn, the chip books it too (`reviewed: 1` in the same action). Partial allocation keeps it in the queue with the "partly tied" rail it already has.
2. **Two-way chips.** When the top two candidates are within 20 points, render both as compact choices ("#0041 · Tytan" / "#0038 · Tytan") instead of hiding everything. Three or more → open the picker pre-filtered to the candidates.
3. **Keep the suggestion visible in the drawer.** Today the chip disappears the moment the drawer opens (`:2346/:3997`) — the drawer's picker should instead open with the Suggested section populated.
4. **Partial-remainder suggestions.** Drop the `allocated > 0.0001` suppression (`:255/:294`) — score the *remainder* instead, which is where help is most needed on split wires.
5. **Missing-links gets a count badge** on the To-book header button so unlinked completed deals are discoverable without ritual clicking; candidate rows gain date + direction + tier.
6. **Supplier-aware local fallback** — the offline matcher compares money-out against supplier legs, not only `client_name` (`:261`).

## Phase 4 — later, listed so they aren't lost

- Rejection memory (dismissed suggestion isn't re-offered) — likely a small synced table or `raw_json` stamp; design when reached.
- Split proposals (one wire covering 2–3 invoices of the same client whose totals sum to the amount).
- Mobile parity: phases 1's server changes are shared automatically; the mobile To-book row (R-166) adopts the grouped picker + suggestion chips as its own pass under [[mobile-parity-rule]] once desktop is proven.
- Fuzzy token matching (typo tolerance) — measure first; the phase-1 recall fixes may make it unnecessary.

---

## Decisions for Jack (blocking build start)

1. **Completed deals: collapsed group (recommended) or a toggle-filter?** Recommendation: collapsed group, auto-expanded for refund roles — hiding them behind a toggle re-creates the "where did my deal go" failure.
2. **"Tie & book" as one click** — confirm you want allocate+book fused when the payment fully covers; today's two-click stays available in the drawer.
3. **Scope of phase 1 vs 2** — server first (suggestion quality), UI second (visuals)? They're independent; both can land in one release, but the server half needs a droplet deploy.

## Non-goals

- No auto-allocation, no relaxation of `allocate_bank_txn` guards, no change to the money invariants or the counted-once refund rules.
- No Ledger-tab inline linking in this pass (its Deal column stays read-only; the drawer remains its path) — widening that surface is a separate ask.
- The no-authz-on-read pattern on the suggestion endpoints matches every sibling bank read endpoint; flagged, not changed here.
