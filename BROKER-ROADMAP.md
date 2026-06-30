# Ecliptr — Brokerage Build Order (grounded in the real schema)

Honest ranking of what makes a real wholesale broker *run their business* on this, mapped to what
your `deal_flows` / `invoices` / `clients` tables already support vs. what's missing. Effort: S/M/L.
**Parity rule applies to every item: desktop + web/mobile + server.** Net-profit recompute must stay
refund-aware (existing `keep_rep_cut` logic).

The wedge (why anyone switches off a spreadsheet): **true per-deal margin + cash-float visibility +
fast quoting/documents — for the middleman specifically.** The four items below are that wedge, in
dependency order. 1 and 2 are the ones that actually decide adoption; 3 and 4 build on them.

---

## 1. Make `net_profit` unimpeachable (refine — do NOT rebuild)  · effort S–M · do first
**Already there:** `CostItem {label, amount}`, `total_cost = Σ amounts`, `net_profit = gross − total_cost`
(commands.rs:2476/2482), `shipping_charged` (charged to customer), `supplier_payments_json` +
`total_supplier_cost` on the deal. The spine is correct.

**The gap:** costs are *free-form and manual*. There's no structure, so (a) you can't see *where*
margin leaks, and (b) the two costs brokers always forget — **payment-processing fees** and **FX
spread** — are never auto-captured, so `net_profit` reads optimistic. A broker catches that once and
stops trusting every number.

**Build:**
- Add `category` to `CostItem` (`product | freight_in | freight_out | duty | payment_fee | fx |
  storage | other`). Keeps free-form, but now categorized. *(schema: none — it's inside
  `cost_items_json`; just extend the struct + UI.)*
- Settings: a **payment-fee %** rule → auto-add a `payment_fee` cost item when the deal's payment
  method is card. Optional **FX rate** field on the deal for cross-border.
- **Margin-waterfall** on the deal/invoice detail: Revenue → product → freight → fees → **Net**, with
  the margin % — so the number is *explainable*, not a black box.

**Why first:** it's the number every other feature (payouts, briefs, analytics) already depends on.
Fixing it once corrects everything downstream and is the cheapest high-trust win.

---

## 2. AR / AP + cash-float view (the biggest real gap)  · effort M–L · do second
**Already there:** invoices have `due_date`, `status`, `paid_at`; `mark_overdue_invoices` auto-flags
overdue (commands.rs:2122); deal has `payment_received_amount`; `outstanding = Σ total WHERE status IN
('sent','overdue')` (948). `supplier_payments_json` + the "Supplier Paid" stage track payables.

**The gap:** there is **no dedicated AR/AP/cash component** (confirmed — none in `src/components`).
`outstanding` ignores partial payments (uses full `total`, not minus `payment_received_amount`). No
**aging buckets**, no **per-client AR rollup**, no **supplier-payable due date/aging**, and no single
**float/exposure** view — which is the #1 thing that keeps a broker solvent.

**Build:**
- **AR aging** endpoint + **Receivables view**: open invoices bucketed by days past `due_date`
  (0–30 / 31–60 / 61–90 / 90+), per client and total, **netting `payment_received_amount`**.
- **AP**: add `supplier_due_date` to the deal (or per supplier-payment entry); a **Payables** list of
  deals not yet "Supplier Paid" with amount + aging.
- **Float card** (dashboard) + **Cash view**: `owed to me (AR) − owed to suppliers (AP) = net
  exposure`, plus a "due/at-risk this week" list.

**Why second:** this is what turns Ecliptr from a *pipeline tracker* into a *cash-flow tool* — the
thing brokers would actually pay for. Items 3 and 4 reuse this data.

---

## 3. Documents that look like a real business — PO + statement  · effort M · do third
**Already there:** branded **invoice + quote PDFs** via `invoice::build_pdf_bytes` (invoice.rs:180) —
the templating engine exists and is good.

**The gap:** no **Purchase Order** to the supplier, no **customer statement** (their open invoices +
aging). A broker who still drops into Word for a PO treats you as a side tool.

**Build (reuse `build_pdf_bytes`):**
- **Supplier PO PDF** from the deal's supplier line (independent of #2).
- **Customer statement PDF** = open invoices + aging — *pairs directly with #2's AR data.*

**Why third:** the statement reuses #2's aging; the PO is independent but lower urgency than seeing the
cash. Low risk because the PDF engine already exists.

---

## 4. Buyer credit limits + exposure guardrail  · effort M · do fourth
**Already there:** nothing — `clients` has tier/blacklist/metadata but **no `credit_limit`** (confirmed;
`payment_terms` exists only on quotes/deals, not the client).

**The gap:** no way to stop the catastrophic deal — shipping $50k to a buyer already over-exposed and
40 days late. This is the single feature that prevents the loss that sinks small brokers.

**Build:**
- Migration: `clients.credit_limit REAL`, `clients.payment_terms TEXT` (+ sync mirror).
- Live **exposure per client** = open AR (from #2) + undelivered orders; show on client detail; **warn
  on invoice/deal create** when exposure + new amount > limit (soft block, admin override).

**Why last of the four:** exposure can't be computed without #2's AR rollup — it's the guardrail that
sits on top of the cash engine.

---

## Sequencing
`1 (trust the number) → 2 (see the cash) → 3 (statement reuses 2; PO independent) → 4 (limit needs 2's
exposure)`. Ship 1 first for the fast trust win; 2 is the strategic core; 3 and 4 are cheap once 2 exists.

## Deliberately NOT yet (name them, don't scope-creep)
Bigger bets for *after* the money engine is trustworthy, roughly in order of leverage:
- **Accounting sync (QuickBooks/Xero)** — stops double data-entry; the thing that makes you the system
  of record. Large.
- **Payments (Stripe/ACH + deposits)** — "get paid faster"; you've parked it, but it's higher leverage
  than its current ranking.
- **WhatsApp deal-thread capture** — the dispute-winning audit trail for this exact segment.
- **Product/cost catalog → instant quote** — speed wins deals; needs supplier-cost history (you have
  `supplier_price_history`).
- **Multi-currency done properly** (not just an FX field).

## Polish that does NOT move adoption (be honest)
Themes, chart gradients, landing animations, High-Value-vs-no-bulk semantics, donut colors. Retention
gloss on top of the wedge — not the reason anyone shows up. Keep it minimal until 1–4 are real.
