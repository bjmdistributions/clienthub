---
plan: R-165 / R-166 / R-167 / R-168 — mobile parity round
date: 2026-08-19
repos: clienthub-api (server + www); desktop untouched
---

# Mobile parity — deal flow, financials booking, clients

Read from the code 2026-08-19: `src/components/DealFlowView.tsx` (2,092 lines),
`www/app.js:5604-6530`, `src/routes/deal_flows.rs`, `src/routes/bank.rs`.
Everything below is a measured gap, not a guess.

---

## R-165 — Deal Flow: what mobile cannot do that desktop can

Desktop runs a **five-section stepper on every card** — Supplier & cost ·
Money movement · Link financials · Profit · Review & complete — with progress
dots that fill from the deal's real state. Mobile has four stage dots and shows
a section only at the stage that "owns" it. That single difference is most of
what "not even close" means: on mobile you cannot open step 1 of a deal that is
sitting at stage 3.

| # | Gap | Desktop source | Server work |
|---|---|---|---|
| 1 | **No section switcher.** Supplier lines show only at `payment_received`, P&L only at `complete`. Desktop opens any of the five steps at any stage. | `SECTIONS`, `SectionNav` | none |
| 2 | **Cost lines editable at one stage only,** and cannot be deleted at all. Desktop adds/removes supplier + freight/wire/other lines at every stage, and after completion behind an Edit toggle. | `SectionSupplier` | none (DELETE route exists) |
| 3 | **No "Didn't pay — keep it" toggle.** `kept` excludes that bill from cost. The field is on the server model but **no route flips it**, so on the phone the flag is invisible and unsettable. | `toggleKept` | `POST /supplier-payments/:pid/kept` |
| 4 | **No schedule editor.** Mobile shows the R-154 chip and enforces the completion gate but cannot set pickup / expected delivery / ships-direct — the columns exist on the server and are **read-only**. The phone enforces a question it cannot answer. | `ShippingStrip` | `PUT /deal-flows/:id/shipping` |
| 5 | **No waiting lane.** Desktop pins "Waiting on pickup or delivery", soonest first, with an overdue count, a next-7-days event line, and a count of deals with no date and no ships-direct answer. | `lane`, `nextDate` | none (after 4) |
| 6 | **No bank linking** — the entire Link-financials step: pair buyer payment / supplier payment / fee / refund to real transactions. | `ReconciliationPanel` | allocate + unallocate (shared with R-166) |
| 7 | **No "no bank record for this leg" markers.** Without them a cash deal is flagged unreconciled forever. | `setDealLinkNa` | `PUT /deal-flows/:id/link-na` |
| 8 | **No deal notes.** The route exists (`PUT /:id/notes`); mobile never calls it. | `DealNotes` | none |
| 9 | **No profit-from-financials panel** — actual (from bank) vs expected (entered), the variance, and the per-leg breakdown. | `SectionProfit` | `GET /deal-flows/:id/reconciliation` |
| 10 | **No reconciliation badges.** Desktop marks a completed deal "Missing buyer payment" / "Missing supplier payment" / "Reconciled" and counts "n need review" on the drawer. | `reconciliationStatusAll` | `GET /deal-flows/reconciliation-status` |
| 11 | **Refunds are a read-only list.** No mark-fully-done / reopen, no show-done, no edit or delete of a recorded refund, no refund workspace. Desktop also re-checks the done flag against the numbers and un-hides a refund when money is owed again. | `RefundWorkspace`, `isRefundDone` | refund done flag + refund edit/delete |
| 12 | **No projected profit on the collapsed card.** Desktop shows revenue with `proj` under it, and recorded profit + margin once complete. Mobile shows the invoice total alone. | card header | none |
| 13 | **No invoice status pill** (Draft / Sent / Paid / Overdue) on the card. | `invoiceStatusPill` | none |
| 14 | **No "Sync from bank"** on the completed drawer and **no "Recalculate from bank"** on a completed deal. | `syncCompleted`, `recalcDealFromBank` | 2 routes |
| 15 | **No linked-transaction snapshot** on a completed deal, and **no gate-override history** ("completed early, by whom, why"). Both already sit in `deal_flows.metadata` — mobile just never reads them. | `PanelComplete` | none |
| 16 | **No auto-create / self-heal.** Desktop creates a missing deal flow for every live invoice on load and cleans up ghost duplicates. Mobile shows whatever happens to exist. | `load`, `cleanupGhostDealFlows` | none (POST exists) |
| 17 | **No CSV export.** Deliberately skipped on a phone. | `handleExportDealFlows` | — |

**Not a gap** (shipped in R-158 / W8): completed drawer, refund badges, stage
rail, supplier and freight cost entry, the complete-deal dialog with the R-154
override, fell-through, archive, reopen, invoice drill-in, line items at every
stage.

## R-166 — Book financials on mobile, and refresh

**Booking.** `src/routes/bank.rs` is deliberately read-only ("it never writes").
That rule exists to stop the server becoming a second *importer* of `bank_txn`
rows — the mechanism behind the duplicate epidemic. Booking is not an import: it
edits rows that already exist. `bank_txn` and `bank_allocation` are already in
`PUSHABLE`, `SNAPSHOT_TABLES` and the record list, so a server write through
`sync::record_upsert` reaches every desktop exactly like a client edit does.
**`plaid.rs` stays unmounted and undeployed** — it is not in `routes::router()`
today and does not move.

New write routes, mirroring the desktop commands:

- `PUT /api/bank/txns/:id` — category, counterparty, confirmed_method, reviewed.
  **Patch semantics, never a full row**: the desktop's own comment records that
  sending a field you did not change re-stamps it and can clobber another
  device's newer edit (a category change used to un-book a reviewed txn that
  way). Merge-on-write, per parity rule 2.
- `POST /api/bank/txns/:id/allocations` — tie money to a deal (amount, role, note).
- `DELETE /api/bank/allocations/:id` — untie it.
- `POST /api/bank/txns/:id/counterparty` and `DELETE` — tag a person (R-156).

On the phone the booking controls go **on the row, always visible** — category,
deal, book. Never hover-only, never drawer-only. That is the standing rule from
the financials audit; shipping a "To book" queue with no controls on the rows is
the exact mistake v0.15.136 made.

**Refresh — and its honest limit.** A Refresh control on Financials re-queries
`/api/bank/summary` and page 1 and resets paging, so the newest rows appear and
the 50-row page starts over. It **cannot pull from the bank**: Plaid runs on the
desktop only and must stay there. So the screen also carries a quiet line saying
when the ledger last changed, rather than implying the button reaches the bank.

## R-167 — Filter clients by category on mobile

`clients.category` is already on the server's `Client` model and on the wire, and
mobile already reads `/api/settings/categories` for its Categories screen. So: a
category select beside the search box on Clients — options from that endpoint,
plus "No category" — filtering the same list the pills filter. No server work.

## R-168 — Phone numbers and the client UI

- **Tap to copy** on phone and email in the client detail, with a visible copy
  affordance and a toast, keeping the existing `tel:` / `mailto:` action. Same on
  the list row's phone subline.
- **Client detail visual pass.** Today the contact row is a bare `<span>`, the
  stat row shuffles cells depending on permission, and category, tags and address
  are not shown at all. Tighten to the mobile visual system: sentence case, no
  eyebrows, no emoji, warm-paper tokens, 130 ms motion, 16 px inputs.

---

## Sequence

1. Server — deal-flow write routes (3, 4, 7, 11, 14) and reconciliation reads (9, 10).
2. Server — bank write routes (R-166).
3. Mobile — R-167 and R-168. Small, self-contained, no server dependency.
4. Mobile — the section switcher and everything it unlocks (1, 2, 5, 8, 12, 13, 15, 16).
5. Mobile — linking, profit, refunds workspace (6, 9, 10, 11).
6. Mobile — financials booking and refresh (R-166).

**Deploy order: server before mobile.** `push_event` drops-and-acks unknown
tables, so a client shipping first has its events silently destroyed (the R-018
lesson). `www/` changes ship to **both** the PWA and the iOS bundle — bump
`app.js?v=`.
