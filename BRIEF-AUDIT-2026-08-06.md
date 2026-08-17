# Brief section audit — why the money, deals and profit read wrong

Investigation only. No files were changed. Every claim below carries a `file:line` or a number measured against a read-only copy of the live desktop DB.

---

## 1. What Jack is actually seeing

The Brief he opens today is a full page of zeros next to a $35,000 card, under headings that say "this week" over a month of data — and the one number he could use to sanity-check it (the month-by-month history) is labelled a month early on every row.

Four causes compound, in order of how much they distort the numbers:

**First — $47,920 of August money is filed in July, and nothing will ever move it.** v0.15.128 changed the deal close date from the supplier's bank date to the buyer's (`commands.rs:4502`). `completed_at` is only re-derived when `resync_completed_deal` fires, and its complete trigger set is six call sites (`commands.rs:3734`, `4563`, `10836`, `10856`, `10889`, `10908`) — no migration, no startup backfill. His last bulk resync ran 2026-08-05T03:48:38Z; the buyer-date commit (227013b) is dated 2026-08-05 15:50Z, twelve hours *later*. Every one of the 32 completed deals was re-derived by the old binary and stamped with the supplier's wire date. 16 of them carry a close date their own linked buyer payment contradicts. The doc comment at `commands.rs:10894-10897` still describes the supplier rule, so nobody reading the code would notice.

**Second — the Dashboard and the Brief disagree about August by $83,270.** `dashboard_stats` computes revenue as `SUM(invoices.total) WHERE status='paid'` bucketed by `paid_at` (`commands.rs:9121`); the Brief computes `SUM(deal_flows.gross_revenue)` bucketed by `completed_at` (`commands.rs:9909`). Three different definitions of money on two different date axes. The Dashboard hero binds both to the same toggle (`DashboardView.tsx:183-184`), so it renders **Revenue $83,270.00 next to Profit $0.00** on one row of one screen.

**Third — the labels lie about the window.** His cadence is 30 days, so the backend snaps to a calendar month (`commands.rs:9876`), and the page correctly reads "Monthly brief / 2026-08-01 — 2026-08-31" — then four headings underneath hardcode the word *week* (`BriefView.tsx:173`, `296`, `357`, `392`). Anyone comparing "This week at a glance" against their sense of the week's trading is off by roughly 4x. This is the single most likely literal trigger for the phrase "tracking money weirdly."

**Fourth — the zeros are correct but every signal around them is wrong.** `MAX(completed_at)` is 2026-07-29, so an August window genuinely holds nothing. That $0 is true. What is false is everything sitting beside it: three simultaneous ▼100% chips comparing 6 elapsed days against a complete 31-day month; a green "No overdue invoices" while $345,435.10 is past due; a lone "Biggest invoice $35,000.00" highlight card for a deal that closed in July and lost $2,480; "Win rate 0%"; and the entire month-to-date payout row silently missing.

---

## 2. The numbers, side by side

| Figure | Brief shows | Actually true | Gap |
|---|---|---|---|
| Overdue receivables | "No overdue invoices" — 0 / $0.00 | 4 invoices / **$345,435.10** | $345,435.10 |
| August revenue | $0.00 | $47,920.00 (buyer-date truth) | $47,920.00 |
| August net profit | $0.00 | $11,570.00 | $11,570.00 |
| August deals closed | 0 | 3 | 3 |
| July revenue | $418,893.00 | $330,149.00 | overstated $88,744.00 |
| July net profit | $47,101.55 | $34,050.55 | overstated $13,051.00 |
| June revenue | $38,903.00 | $79,727.00 | understated $40,824.00 |
| Dashboard vs Brief, August revenue | $83,270.00 vs $0.00 | — | $83,270.00 apart |
| June loss card | "1 deal lost money: -$1,880.00" | 2 deals / -$22,880.00 | $21,000.00 hidden |
| Refund banner, current period | absent | $26,500.00 refunded 2026-08-04 | $26,500.00 |
| Monthly history, top row | "Jun 2026 · $418,893.00" | Jul 2026 | label off by one month, all rows |
| Month-to-date payout row | hidden entirely | $47,101.55 across 4 recipients (July) | whole row |
| "Follow-ups 22 due today" | 22 | 0 (all 22 have an empty date string) | 22 |
| Activity, May brief | 131 clients / 229 interactions | 77 / 45 | +70% / 5.1x |
| Activity, week of 11 May | 84 clients / 228 interactions | 20 / 4 | 4.2x / 57x |
| Win rate, all-time reachable | 88.6% | Dashboard says 77.5%; correct population 83.8% | 3 answers |
| Biggest invoice (current) | INV-0183 $35,000.00 | deal gross $26,600.00, net -$2,480.00, closed in July | $8,400.00 + wrong period |
| Per-deal payout, INV-0166 | $9,450.00 split | net profit $8,919.55 | $530.45 that does not exist |
| Mobile "Profit earned", June | -$19,112.00 | before-losses $1,888.00; net -$20,992.00 | neither quantity |
| Desktop vs mobile "last period" | $418,893.00 / 17 deals | phone: $274,520.00 / 5 deals | $144,373.00 apart |

---

## 3. Findings

### Critical

---

**C1 — Every completed deal still carries the old supplier-payment close date**

`commands.rs:10899` (`resync_all_completed_deals`), rule at `commands.rs:4502`, persisted at `4534`/`4548-4550`.

*Mechanism.* `buyer_bank_paid_date` is the only bank-derived writer of `completed_at`, and the `.or_else` fallback at `4502-4506` only substitutes when `completed_at` is **empty** — so an already-stamped row is never corrected. The six triggers (`3734`, `4563`, `10836`, `10856`, `10889`, `10908`) all require a human action on a specific deal. `grep` across the crate confirms no migration and no startup backfill; `db.rs` references `completed_at` only at 574/587 (column + index).

*What Jack sees.* August reads "Revenue $0.00, 0 deals completed, Win rate 0%" on both surfaces while three deals whose buyer money landed in August sit in July's column. July is inflated with money that was not earned in July.

*Measured.* All 32 completed rows share `updated_at = 2026-08-05T03:48:38.0*Z` — one bulk pass, twelve hours before commit 227013b. 16 rows contradict their own linked buyer payment; 13 sit exactly on their supplier wire date. August truth: 3 deals / $47,920.00 / $11,570.00 (INV-0177 buyer posted 2026-08-03 $20,650; INV-0181 2026-08-03 $20,000; INV-0185 2026-08-05 $7,270). July: 12 deals / $330,149.00 / $34,050.55 against the displayed 17 / $418,893.00 / $47,101.55. June: 6 / $79,727.00 / -$19,511.00 against the displayed 4 / $38,903.00 / -$20,992.00. Week of 2026-07-27: 2 / $226,600.00 / $15,895.00 against the displayed 5 / $274,520.00 / $27,465.00.

*Fix.* Run `resync_all_completed_deals` once on the current binary (already exposed as "Sync completed from bank"), then add a one-shot migration recomputing `completed_at` for every `stage='complete'` row so a future close-date rule change cannot silently leave the book on the old rule. Correct the stale doc comment at `commands.rs:10894-10897`.

---

**C2 — Overdue receivables card reads only `status='sent'`, and has no voided/archived guard**

`commands.rs:10043` and `commands.rs:10046`.

*Mechanism.* Both queries are `WHERE status='sent' AND due_date < date('now')`, bound to nothing. But `mark_overdue_invoices` (`commands.rs:2715-2740`) flips a past-due invoice to `status='overdue'` — so the moment an invoice actually goes late it leaves the Brief's filter. His status counts: draft 7, overdue 11, paid 33, sent 1. The two queries are also the only invoice queries in `generate_weekly_brief` with **no** voided/archived guard (`live` at 9905, `deals_lost` at 10036, `biggest_invoice` at 10075 all carry one). Third defect on the same lines: `date('now')` is UTC (verified: `SELECT date('now'), datetime('now')` → `2026-08-06 19:02:19` while local was 14:02) and ignores the brief's anchor entirely, so a back-dated brief renders today's overdue set under another period's heading.

*What Jack sees.* The green "No overdue invoices" (`BriefView.tsx:338`) — and mobile renders the same green fallback at `app.js:6251`, so both surfaces actively assert zero.

*Measured.* Brief query → (0, $0.00). Guarded truth (`status IN ('sent','overdue')`, not voided, not archived, past due) → **4 / $345,435.10**: INV-0186 $158,348.10 (due 08-05), INV-0175 $126,675.00 (07-23), INV-0184 $38,412.00 (08-04), INV-0180 $22,000.00 (07-30). None has any recorded payment — checked against the `payments` table.

*The two defects mask each other.* Widening the status filter alone — the natural one-line fix — imports **$159,329.35** of dead paper: INV-0159 $99,190.25, INV-0170 $37,053.00, INV-0182 $20,500.00, INV-2026-0043 $1,335.00, INV-0172 $1,250.00, INV-0178 $0.10 (all voided) and INV-0173 $1.00 (archived), taking the card to 11 / $504,764.45. Fix both halves in one change: `status IN ('sent','overdue') AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 AND due_date < ?anchor`. The server half (`dashboard.rs:675-682`) already has the guard, so a status-only widen is safe there.

*Also.* INV-0187 ($189,750.00, due today) will flip this card to "1 overdue" at 19:00 local tonight when UTC rolls over — five hours before it is actually late, and `mark_overdue_invoices` only runs at app startup (`main.rs:394`), never on a timer.

---

**C3 — Dashboard and Brief report different revenue for the same month**

`commands.rs:9121` (`REV_MONTH_SQL`) vs `commands.rs:9909`.

*Mechanism.* `REV_MONTH_SQL` is `SUM(invoices.total) WHERE status='paid' AND strftime('%Y-%m', COALESCE(NULLIF(paid_at,''), issue_date)) = ?1` — invoice face value, bucketed by when it was flagged paid. `PROFIT_MONTH_SQL` (`commands.rs:9134`) uses `deal_flows.net_profit` on `completed_at`. The Brief uses `deal_flows.gross_revenue` on `completed_at`. Three definitions, two date axes, on two screens.

*What Jack sees.* The Dashboard hero binds `heroRevenue` and `heroProfit` to the same [This month | All time] toggle (`DashboardView.tsx:183-184`), so August renders **Revenue $83,270.00 next to Profit $0.00** — self-contradictory on one row, before the Brief is even opened.

*Measured.* August Dashboard $83,270.00 (INV-0177 $20,500, INV-0181 $20,500, INV-0183 $35,000, INV-0185 $7,270, all `paid_at` 2026-08-04) vs Brief $0.00. July: $408,169.00 vs $418,893.00, $10,724.00 apart. After C1 is fixed the Brief reads $47,920.00 for August and the residual **definitional** gap is $35,350.00 — INV-0183's $35,000 face value vs its $26,600 deal gross (which stays in July), plus INV-0181 +$500 and INV-0177 -$150. Across all 31 completed live deals, 6 have `invoice.total != gross_revenue` for a net $12,010.00.

*Note.* The comment at `commands.rs:9131-9133` claims the dashboard uses "the same accuracy rules as the brief, so the two surfaces can never disagree by construction." That is true of profit only, and it sits directly above the revenue constant it does not cover.

*Fix.* Pick one definition of period revenue for the whole app — bank-truth `gross_revenue` on `completed_at` is what every other money figure already uses — or relabel the Dashboard tile "invoiced and marked paid this month."

---

### High

---

**H1 — The loss card is computed on raw pre-refund `net_profit`**

`commands.rs:9962` (server twin at `dashboard.rs:577-580` and `581-584`).

*Mechanism.* Inside the same `SELECT` that computes `COALESCE(SUM({np}),0)` — refund-aware — the loss branches read the raw column: `COUNT(CASE WHEN net_profit < 0 THEN 1 END)` and `SUM(CASE WHEN net_profit < 0 THEN net_profit ELSE 0 END)`. Stored `net_profit` is deliberately pre-refund (`deal_bank_actuals`, `commands.rs:4390-4432`, never reads `role='refund_out'`), so a deal that only goes negative after its refund never trips the test. These are the only expressions in that SELECT that bypass `{np}`.

*What Jack sees.* On the June brief: "Net profit -$20,992.00" and two rows below (`BriefView.tsx:292-298`) "1 deal lost money this week: -$1,880.00."

*Measured.* Refund-aware truth for June is **2 deals, -$22,880.00**. The missing one is deal c6ac3cda (INV-0153, completed 2026-06-30): gross $26,500.00, stored net +$5,500.00, refund $26,500.00 → true **-$21,000.00**. It is the only sign-flip in the whole DB. $21,000 of a $20,992 negative month is hidden by the one card meant to explain it. July and August: $0 error.

*Fix.* Use `{np}` in both branches at `commands.rs:9962` and `dashboard.rs:577/581`.

*Downstream.* This is also the root of the mobile "Profit earned" divergence (see H8) — fix here and mobile is right in every window but one.

---

**H2 — The refunded-deals card is keyed on the deal's `completed_at`, not the refund date**

`commands.rs:10093`.

*Mechanism.* `... FROM refunds rf JOIN deal_flows df ON df.id=rf.deal_flow_id WHERE COALESCE(df.archived,0)=0 AND df.completed_at >= ?1 AND df.completed_at < ?2`. A refund is attributed to the period the **deal closed**, not the period the money went back — which is backwards for the normal case where the refund lands after the close. It also omits the `live` guard and `df.stage='complete'` entirely.

*What Jack sees.* Today's brief shows **no refund banner** even though the business's only refund on a completed deal — $26,500.00 on INV-0153, recorded 2026-08-04, two days ago — is sitting there. Page back to June and it appears in a two-month-old brief instead. A refund entered today silently rewrites a closed period's profit and adds a banner to it.

*Measured.* refunds row 10e62934: deal c6ac3cda, $26,500.00, `bank_txn_id=''`, `refunded_at` 2026-08-04T17:15:19Z; deal `completed_at` 2026-06-30. Card for `[2026-08-01,2026-09-01)` → (0, $0.00); for June → (1, $26,500.00). Of $152,220.00 total refunds, this card can ever surface $26,500.00 (17.4%) — the other **$125,720.00** sits on deals 1792c577 (INV-0160, `stage='invoiced'`) and 4cf120bf (INV-0163, `stage='payment_received'`), both `completed_at` NULL, so they match no window ever. Those are five real bank-linked `refund_out` wires ($63,000 + $22,720 + $20,000 + $10,000 + $10,000).

*Fix.* Filter on `rf.refunded_at` (falling back to the linked `bank_txn.posted_at`), and add the `live` guard. The `bank_allocation role='refund_out'` union is worth adding for correctness but is currently zero-impact — all 5 such rows have a mirroring `refunds` row.

*Also.* Mobile has no refund card at all — the server response (`dashboard.rs:795-843`) omits both keys, so the phone shows June's negative with nothing explaining it.

---

**H3 — "Profit" and "Net profit" are the identical number with two contradictory trend chips**

`commands.rs:10143` vs `commands.rs:10160`; rendered at `BriefView.tsx:177` and `201-206`.

*Mechanism.* `profit_this_week` (`commands.rs:9917`) and the `net_profit` column of `df_this_week` (`commands.rs:9962`) are byte-identical SQL — same `{np}`, `{live}`, window, rep filter — so they can never differ. The server proves it: `dashboard.rs:820` is literally `"net_profit_this_week": profit_this_week`. The percentages then diverge by formula: `10143` guards on `profit_last_week > 0.0` and falls through to a hardcoded `0.0`; `10160` guards on `!= 0.0` and divides by `.abs()`. `changePct` (`BriefView.tsx:80-83`) maps `0` to a grey Minus and the literal text "0%" — the app's own symbol for "unchanged."

*What Jack sees.* On the July brief: hero cell "Profit $47,101.55 − 0%" and, directly below, "Net profit $47,101.55 ▲ 324.4%." Two cards labelled "Profit" and "Net profit" also imply something is deducted between them. Nothing is.

*Measured.* July np = $47,101.55 both ways; June baseline -$20,992.00 → `profit_change_pct` 0.0, `net_profit_change_pct` +324.38%. Weekly windows are worse: 2026-06-29 shows -$18,511.00 as both "− 0%" and "▼ 1961.4%"; 2026-07-06 shows $2,953.00 as "− 0%" and "▲ 116.0%".

*Extension.* `revenue_change_pct` (`commands.rs:10141`) carries the same `> 0.0` guard, so the Revenue hero shows a false "0%" under the same conditions.

*Fix.* Use the abs-denominator formula for all three, and drop one of the duplicate pair.

---

**H4 — "Biggest invoice" runs on a different date axis and a different definition of money**

`commands.rs:10075` (`i.issue_date` window, reports `i.total`).

*Mechanism.* Every money figure in the brief filters `df.completed_at` and uses `df.gross_revenue`; this card filters `i.issue_date` and reports invoice face value. It also carries no `{rep_filter}` (unlike `margin_deal` three lines above at `10062`) and does not require a completed deal at all. Because `best_margin_deal` and `worst_margin_deal` come from completed deal_flows, they are None in an empty period while this card survives — and the section gate at `BriefView.tsx:355` is an OR, so the whole Highlights section renders for it alone.

*What Jack sees.* On today's $0 page, the largest number on screen is a single card: **"Biggest invoice / INV-0183 / Ronnie / $35,000.00."** That deal completed 2026-07-29 (it is inside July's $418,893), its bank revenue is $26,600.00, and it is the deal that **lost** $2,480.00.

*Measured.* $8,400.00 of face-value inflation on a losing deal from the previous period. On the June brief the card reads "INV-0151 / SouthJerzAuctions / $37,947.00" on a month whose entire revenue is $38,903.00 — implying one deal was 97.5% of June, when that deal's flow completed 2026-07-02 and contributed $0.00. June's actual biggest completed deal is INV-0153 at $26,500.00 (subsequently refunded in full). Across all 31 completed live deals, 6 have `invoice.total != gross_revenue`: INV-0183 +$8,400.00, INV-0145 +$1,880.00, INV-0158 +$830.00, INV-0166 +$550.00, INV-0181 +$500.00, INV-0177 -$150.00.

*Fix.* Join `deal_flows`, filter `df.completed_at` in-window, report `df.gross_revenue`, add `{rep_filter}`; or gate the Highlights section on there being completed deals.

---

**H5 — Win rate: three surfaces, three answers, and a lost side that cannot see history**

`commands.rs:10036` (Brief) vs `commands.rs:9201` (Dashboard) vs `commands.rs:9547` (Analytics).

*Mechanism.* The Brief's lost side requires `i.voided_at >= ?1 AND i.voided_at < ?2`. Five of the nine voided non-archived invoices have `voided_at` NULL, so both comparisons evaluate NULL and those rows drop from every window that will ever be generated. The Dashboard counts every voided non-archived invoice with no stamp requirement; Analytics explicitly allows `voided_at IS NULL` on the upper bound. The won side is `COUNT(DISTINCT df.invoice_id)` = 31 on all three.

*What Jack sees.* Win rate reads **100% on May, June and July** (0 lost in each) and **0% on August** (0 closed, 4 lost). It is only ever 100% or 0%.

*Measured.* All four `voided_at` stamps in the DB are from 2026-08-03..08-06 — the column was introduced recently, so the Brief cannot ever show a lost deal in a historical month. Summed over every window that can exist, the Brief tops out at 31/(31+4) = **88.6%**; the Dashboard on identical data says 31/(31+9) = **77.5%**. 11.1 points apart.

*Precondition on the fix.* Backfilling `voided_at` — the obvious repair — makes the Dashboard's number worse, because `deals_lost` has no status filter and does not require a deal_flow. Two of the nine voided invoices are **drafts that were never sent**: INV-0161 $117,250.20 and INV-0162 $62,700.50 ($179,950.70), plus INV-0178 ($0.10, `status='overdue'`, zero deal_flows rows). `set_invoice_void` (`commands.rs:3208-3221`) stamps `voided_at` unconditionally on whatever it is handed, drafts included. Correct-population win rate is 31/(31+6) = **83.8%**, so the Dashboard's 77.5% is already a 6.3-point live error.

*Fix, in order.* First restrict the lost population on all three surfaces — `AND i.status <> 'draft' AND EXISTS (SELECT 1 FROM deal_flows df WHERE df.invoice_id=i.id AND COALESCE(df.archived,0)=0)`. Only then backfill `voided_at`. Then pick one lost definition and share it.

---

**H6 — "This month" figures are pinned to the wall clock, and the month-to-date payout row is hidden on every brief**

`commands.rs:9937` and `BriefView.tsx:236`.

*Mechanism.* `let month_start = format!("{}-01", now.format("%Y-%m"))` uses `now = Utc::now()` (`commands.rs:9849`), never `anchor` (`9856-9859`). All four consumers — `avg_margin_this_month` (9940), `revenue_this_month` (9942), `df_mtd` (9977), `split_month` (10002) — bind it with `>= ?1` and no upper bound. The front-end month name is stuck too: `BriefView.tsx:240` computes it from `new Date().toLocaleString(...)` in the browser, so it will not follow a server-side fix. Then `BriefView.tsx:236` gates the **entire** MTD row on `net_profit_this_month !== 0` — using a zero as a sentinel for "no data" — and `:246` is the only render site for `PayoutTotal.this_month`.

*What Jack sees.* `MAX(completed_at)` is 2026-07-29, so `net_profit_this_month` is $0.00 and the row is hidden on **every** brief he can open — current, July, June and May all verified. He cannot see Business MTD, Jack MTD, Ben MTD or Investment MTD anywhere in the app right now. What survives is `avg_margin_this_month`, rendered unconditionally at `BriefView.tsx:270` with the bare label "This month," so the July brief shows "Margin · This period 11.2% · This month 0.0% · All-time 6.9%" — three margins on one card, one belonging to a month with zero deals.

*Measured.* The suppressed July MTD row is $47,101.55: Business $11,775.39 / Jack $9,420.31 / Ben $9,420.31 / Investment $16,485.54 (split 25/20/20/35, all July net is `payout_included`). June -$20,992.00 and May $15,039.85 are likewise invisible.

*Fix.* Derive `month_start` from `anchor` with a matching exclusive upper bound at `9940`/`9942`/`9977`/`10002` and `dashboard.rs:503`; replace the `!== 0` gate with a check on whether `payout_totals` exists; label the margin cell with the month it covers.

*Latent half.* The missing upper bound is currently zero-impact — `MAX(completed_at)` = 2026-07-29 and `month_start` = 2026-08-01, so nothing is future-dated. Fix it anyway while you are in there.

---

**H7 — Monthly history labels are one month early on every row**

`BriefView.tsx:280`, mobile twin at `www/app.js:6079-6080` (used at `6192`).

*Mechanism.* `new Date(m.month + "-01").toLocaleString("en-US", { month: "short", year: "numeric" })`. `m.month` is a bare `YYYY-MM` from `strftime` (`commands.rs:9954`). A date-only ISO string parses as **UTC midnight**; `toLocaleString` then formats in the viewer's **local** zone. Jack's machine is America/Chicago (verified: `Get-TimeZone` → Central Standard Time, `-05:00` in August), so 2026-07-01T00:00:00Z renders as 2026-06-30 19:00 local → "Jun 2026." The same file already knows the hazard: `addDays` at `BriefView.tsx:11-15` appends `T12:00:00Z` for exactly this reason. Mobile builds `Date.UTC(...)` then formats locally — same result. Note `www/app.js:120` uses the correct local-constructor form, so the right pattern exists in the same file.

*What Jack sees.* "Every month you've closed deals" reads, top to bottom: "Jun 2026 · 17 deals · $418,893.00 · $47,101.55 · 11.2%" / "May 2026 · 4 · $38,903.00 · -$20,992.00 · -54.0%" / "Apr 2026 · 10 · $140,328.85 · $15,039.85 · 10.7%." Those are July, June and May. He has no April data. There is **no July row anywhere**, and the phone agrees with the laptop — which makes it harder, not easier, to catch.

*Measured.* 3 of 3 rows wrong; 100% of the only month-by-month history on the Brief; $598,124.85 of lifetime revenue misattributed by one month. The underlying figures are correct and reconcile exactly to `revenue_all_time`. Reproduced in node under `TZ=America/Chicago` for both expressions; both render correctly under `TZ=UTC`.

*Fix.* `new Date(m.month + "-01T12:00:00")` (no Z, local) or format from the string directly; on mobile use `new Date(+y, (+mo||1)-1, 1)`.

---

**H8 — Four section headings say "week" over a month of data**

`BriefView.tsx:173`, `296`, `357`, `392`.

*Mechanism.* The page title correctly interpolates `periodLabel` (`:164`) and the payout caption names the date range (`:218`), but four headings hardcode the word. `periodLabel` is already in scope at `:76`. `brief_frequency_days` is `30`, so `commands.rs:9876` routes to the calendar month.

*What Jack sees.* "Monthly brief / 2026-08-01 — 2026-08-31" and immediately below it "This week at a glance." The June brief's loss/refund card contains both "1 deal lost money **this week**: -$1,880.00" and, two lines down, "1 deal refunded **this period** — happened but fell through: $26,500.00 returned" — the same window described two ways inside one bordered card.

*Impact.* No computed figure is wrong, but this invites a ~4x mismatch against his own sense of the week. Of everything here it is the most likely literal source of the phrase "tracking money weirdly."

*Fix.* Use `periodLabel` (or "this period", matching `:307`) in all four.

---

**H9 — INV-0183's buyer payment is unlinked because Plaid re-issued the transaction id**

`commands.rs:4502`.

*Mechanism.* The deal's `metadata.bank_snapshot` names buyer txn `btpl_5ZD3Kz…` ($26,600, posted 2026-08-04). That id no longer exists in `bank_txn`; the same credit is now `btpl_L3gJVo…` (identical amount, date, and description "REF: 2000 UNITS OF NFL LULULEMON"), allocated to nothing. `cleanup_orphan_allocations` (`commands.rs:10868-10891`) already deleted the dead link. Nothing re-points an allocation at a re-issued transaction, so `buyer_bank_paid_date` returns None forever and the `.or_else` at `4502-4506` only fires on an empty `completed_at` — the deal is frozen at the supplier date 2026-07-29 permanently.

*What Jack sees.* Deal Flow shows a supplier wire and no buyer transaction, yet reports $26,600 revenue with no bank line behind it, booked in July, immovable by any number of resyncs. Meanwhile a $26,600 credit dated 2026-08-04 sits unmatched in the bank feed (one of only three unallocated incoming August transactions).

*Live secondary bug found here.* `recalc_deal_from_bank` (`commands.rs:4562-4570`) calls `resync_completed_deal` (which uses the **stored** gross/cost as fallback, line 4497) and then recomputes what it **returns** with a different fallback pair — `deal_bank_actuals(&conn, &id, df.payment_received_amount, df.total_supplier_cost)` at `4567`. For INV-0183 that returns **+$5,920.00**, and `DealFlowView.tsx:1688` renders "Recalculated from bank — profit $5,920.00" while the row it just persisted says **-$2,480.00**. The button reports a number $8,400.00 away from the one it saved.

*Fix.* Re-link `btpl_L3gJVo…` to INV-0183 as a `buyer_payment` — that alone fires resync and moves the deal to 2026-08-04. Structurally: fingerprint-match orphan allocations onto surviving transactions (amount + posted_at + description) before `cleanup_orphan_allocations` deletes them. Separately, make `recalc_deal_from_bank` return the figure it persisted.

---

### Medium

---

**M1 — Activity counters have no upper window bound**

`commands.rs:10085` and `10089` (`WHERE created_at >= ?1`, bound `[&week_start]` only); server `dashboard.rs:690`/`694`. The only two window aggregates in the function with a single bind, rendered under "Activity this week" (`BriefView.tsx:392`) beside correctly-bounded figures.

Measured, Brief vs bounded truth: **May 131 / 229 vs 77 / 45; June 54 / 184 vs 20 / 87; July 34 / 97 vs 29 / 97**. Week of 11 May: 84 / 228 vs 20 / 4 — a 4.2x and 57x overstatement. Today's August window (5 / 0) is correct only because the newest interaction is 2026-07-30. These are wrong **right now** on any back-paged brief. All 131 `clients.created_at` and 229 `interactions.created_at` are ISO-8601 with `+00:00`, so a prefix `< ?2` bound compares correctly. One-line fix: add `AND created_at < ?2` binding `end_excl` in all four places.

Also on the same cards: no `approval_status` filter, so July's 29 real new clients include 2 rejected test leads ("SyncFix Verify", "JEOEOE Mildice", both 2026-07-23). That is a decision, not a bug — see §6.

---

**M2 — "22 follow-ups due today" is 22 clients with no follow-up date at all**

`commands.rs:1556` (predicate), called at `commands.rs:10049`.

`json_extract(c.metadata,'$.next_follow_up_date') <= date('now')` with `IS NOT NULL`. Measured: `GROUP BY` that expression over the counted set returns **`[('', 22)]`** — every one of the 22 is an **empty string**. `IS NOT NULL` passes an empty string, and `'' <= date('now')` is true in SQLite. Zero real follow-ups are due. The number is wrong on every date, not merely attached to the wrong window (it also ignores the anchor entirely, and `due_followups()` takes no rep argument). Fix: require a non-empty, well-formed date, and pass the brief's anchor down.

---

**M3 — The period anchor is UTC, so the brief flips period at 7pm local**

`commands.rs:9856-9859` (`_ => Utc::now().date_naive()`, malformed-input fallback at `9857`), `now = Utc::now()` at `9849`; server `dashboard.rs:456`, `471-473`.

The money axis and the boundary axis are different calendars: `completed_at` for a completed deal is `MAX(bank_txn.posted_at)` — a US bank date (verified: all 1,276 `bank_txn.posted_at` values are length 10, date-only) — while the window boundary is a UTC day. From 19:00 local the UTC date is already tomorrow.

Simulated: anchor 2026-07-31 → `[2026-07-01,2026-08-01)` = 17 deals / $418,893.00 / $47,101.55; anchor 2026-08-01 → $0 / $0 / 0. So on 31 July at 19:00 local, five hours before his month ends, the monthly brief drops the whole month. Weekly: Sunday 2026-08-02 → $274,520.00 / $27,465.00 / 5 deals; Monday → zeros. The exposure is already visible in his stamps — 3 of the 4 populated `invoices.voided_at` values sit on a different local day (INV-0170 and INV-0172 at `2026-08-06T00:22Z` = 2026-08-05 19:22 local; INV-0182 at `2026-08-05T03:45Z` = 2026-08-04 22:45 local), as do 61 of 131 `clients.created_at` and 16 of 229 `interactions.created_at`. None currently crosses a Mon-Sun or month boundary, so today's misattribution is zero — but the 5-hour transient recurs at every boundary. Fix: anchor on `Local::now().date_naive()` (or a configured org timezone) and stamp `voided_at`/`created_at` consistently.

Related, `BriefView.tsx:240` labels the MTD row with the **local** month name over a UTC-bucketed figure — currently invisible because the whole row is gated off by H6.

---

**M4 — Current period-to-date is compared against a complete prior period**

`commands.rs:9887`/`9879` (upper bound is always the end of the calendar period, never clamped to the anchor); ratios at `10140`, `10143`, `10160`; server `dashboard.rs:800/802/821`.

The current window always runs to the period end, so on any day but the last it holds only the elapsed part; the previous window is always complete. No elapsed-fraction correction. Desktop's `changePct` renders a bare arrow with no "vs last period" qualifier at all (mobile at least prints one, `app.js:6074`).

*What Jack sees today:* three red down-arrows at once — Revenue $0.00 ▼100.0%, Profit $0.00 ▼100.0%, Net profit $0.00 ▼100.0% — on day 6 of 31, under a header reading "2026-08-01 — 2026-08-31," 25 days of which are in the future. The honest baseline (first 6 days of July) is $43,918.00 / $1,583.00 / 3 deals, not the $418,893.00 / $47,101.55 / 17 the card divides by.

This is what he sees on open, today, with no navigation — it is the second most likely trigger for the report after the "this week" headings. Fix: clamp the current window to anchor+1 day and truncate the baseline to the same elapsed days, or state "vs full last period" on the chip.

---

**M5 — "Up from zero" and "unchanged" render identically**

`BriefView.tsx:79-83`. `changePct` has three branches; `0` falls into the same grey Minus + literal "0%" as a genuine no-change. The backend emits a literal `0.0` for "no baseline" at `commands.rs:10140`, `10143`, `10160`. The four fields that would disambiguate — `revenue_last_week`, `profit_last_week`, `net_profit_last_week`, `completed_deals_last_week` — are all in the payload (`api.ts:965`, `968`, `983`, `985`) and rendered nowhere (grep: 0 hits).

Measured: 8 of 17 weekly windows render at least one flat "0%" that means "no prior period." His first trading month renders three at once — "Revenue $140,328.85 − 0%", "Profit $15,039.85 − 0%", "Net profit $15,039.85 − 0%" against an April baseline of $0.00. Fix: return null and render an em-dash. This is the same `> 0.0` guard as H3 seen from the other side.

---

**M6 — Win rate 0% on a period with no deals**

`commands.rs:10040` (`else { 0.0 }`), rendered unconditionally at `BriefView.tsx:180` and `app.js:6097`. "No cohort" and "lost everything" are the same cell. 7 of 17 weekly windows in his DB are completely empty (0 closed, 0 lost) and every one reads "Win rate 0%" — weeks starting 2026-04-20, 04-27, 05-25, 06-01, 06-08, 06-15, 08-10. Fix: return `Option<f64>`, render an em-dash.

Today's org-wide "Deals closed 0 / 4 lost / Win rate 0%" is arithmetically correct for the window — but note those 4 voids ($157,993.25) had due dates spanning 2026-07-10 to 2026-08-03 and are all charged to August purely because that is when Jack clicked void.

---

**M7 — Desktop and mobile use different brief periods**

`commands.rs:9864` vs `www/app.js:6059`.

Desktop reads the synced setting `brief_frequency_days` = `'30'` → calendar month. Mobile never reads it — it sends `days=` from device-local `localStorage.ec_brief_days`, defaulting to `7`, and the server honours whatever it is sent (`dashboard.rs:481`). Nothing reconciles them.

Same org, same day, same DB: laptop reads "Monthly brief / 2026-08-01 – 2026-08-31" with last period $418,893.00 / 17 deals; phone reads 2026-08-03 – 2026-08-09 with last period $274,520.00 / 5 deals. **$144,373 apart on the comparison bar, 17 vs 5 on the deal count.** Fix: make one authoritative — seed `ec_brief_days` from the org setting on load, or have desktop send its period explicitly.

---

**M8 — `completed_at` per-deal payout metadata goes stale after resync**

`commands.rs:4514`.

`resync_completed_deal` reads the existing metadata (`4511-4512`) and inserts only `bank_snapshot` (`4514`) before rewriting `gross_revenue` / `total_cost` / `net_profit`. `metadata.payout_recipients` — written at completion with the amounts as they stood then — is carried forward untouched, and the UI renders those stored amounts verbatim (`api.ts:787-793` returns `dealPayoutRecipients(flow)` unmodified; consumed at `DealFlowView.tsx:1531`, `CloseoutView.tsx:232`, `CostProfitPanel.tsx:26`, mobile `www/app.js:677-686`). The server's recalc **does** rebuild it (`deal_flows.rs:319-331`), so the two surfaces drift apart.

Measured: 15 completed deals carry a stored breakdown; **5 no longer sum to net_profit**. INV-0166 shows $9,450.00 of split (Business $2,362.50 / Jack $1,890.00 / Ben $1,890.00 / Investment $3,307.50) on $8,919.55 of net — **$530.45 of partner money that does not exist**. INV-0177 and INV-0181 have **swapped** splits ($650.00 each way): INV-0177 (net $6,110.00) displays $5,460.00, INV-0181 (net $5,460.00) displays $6,110.00. Also INV-0157 +$25.00 and INV-0164 +$89.00. Summed across the 31 live completed deals the screens display $68,293.85 against $67,649.40 of actual net — **$644.45 of pure staleness**. Fix: rebuild the breakdown against the new net before writing metadata, reusing the shares captured at completion (three lines the server already runs).

---

**M9 — The rep filter matches the client's own company name**

`commands.rs:9853`.

`rep_filter` compares the signed-in rep's `display_name` against `json_extract(c.metadata,'$.lead_representative')`. But both writers of that key deliberately default it to the customer's company when the intake form leaves the rep blank — `form_parser.rs:188-189` (`if c.sales_rep.trim().is_empty() && !c.company.trim().is_empty() { c.sales_rep = c.company.trim().to_string(); }`) and `signup_rules.rs:360-367`, which writes it into both `sales_rep` and `lead_representative`. All 7 populated values on his DB equal that client's own `company` column: Santa365, Curves & Confidence, Rudysportvault, Sunny Rose Boutique, Fefe_ave, Tk's Clothing, Roadrunner Distributions LLC. `JOIN staff_accounts s ON s.display_name = json_extract(...)` returns **0 rows**. The brief has no existence check — any string produces a valid query, matches nothing, and every aggregate returns 0 through `.unwrap_or(0.0)`. `deal_flow_payout` proves the intended semantics: it looks the same value up in `staff_accounts` and raises `rep_unmatched` when it is not an employee (`commands.rs:5013-5024`).

When it fires, a rep-scoped brief returns Revenue $0.00, Profit $0.00, margin 0.0%, all-time $0.00, empty `monthly_breakdown` (the whole history table disappears) and four $0.00 payout boxes — on a business with $598,124.85 of lifetime revenue. No error, no empty state. (Confirmed the filter keys off companies: `rep='Tk's Clothing'` returns 1 deal, $655.00 / $115.00 — INV-0171, client Tyrell Waiters.)

**Currently unreachable, and that is the only reason it is medium.** The Brief tab requires `analytics:view` (`permissions.ts:43` → `App.tsx:459`; mobile `app.js:775`), and `role_sales` does not carry it; all 5 staff accounts are `role_admin` except "Jack Sales" (`role_sales`), which is `status='suspended'`. The exposed population is a `role_manager` or `role_viewer` non-admin — a role that exists with zero members. **The first manager or viewer account Jack creates gets a $0 brief.**

---

**M10 — Five figures on a rep's brief ignore the rep scope entirely**

`commands.rs:10042`/`10045` (overdue), `10049` (`due_followups()` takes no rep argument at all, `commands.rs:1546`), `10073-10081` (biggest invoice), `10085`, `10089`. None interpolates `{rep_filter}`; they land in the same payload as twelve figures that are scoped. Server mirrors at `dashboard.rs:675`, `679`, `684`, `689`, `693`.

With `rep='Ben'` on the July window, `biggest_invoice` returns `('Ali Rehman','INV-0176',200000.0)` — byte-identical to the org-wide result — plus 34 new clients, 97 interactions, 22 follow-ups, while every rep-scoped figure in the same run is 0. That is a confidentiality leak: another client's invoice number, name and amount, plus the org's whole follow-up backlog. Latent for the same reachability reason as M9. Fix: give the five a rep predicate, or hide Highlights and Activity when `rep_name.is_some()`.

---

**M11 — The server dates a mobile-completed deal "now"**

`clienthub-api/src/routes/deal_flows.rs:971-974`: `match input.completed_date { Some(d) if !d.is_empty() => format!("{}T00:00:00Z", d), _ => chrono::Utc::now().to_rfc3339() }` — no `buyer_bank_paid_date`, not even the `payment_received_at` fallback the desktop has (`commands.rs:4282`). There is no server port of `resync_completed_deal`: `recalc_completed_deal_flow` (`deal_flows.rs:283-357`) rewrites gross/cost/net/metadata but never `completed_at`, and the only other writes are `clear_completion` (247, 264) and the manual `update_deal_completed_at` (1120-1132). The `_ =>` branch is live — `www/app.js:5228` posts to `/complete` with an empty body.

Zero measurable impact today (all 32 completed rows carry desktop-shaped dates), and partially self-healing: any later add/remove of a bank allocation on desktop fires resync. The permanent-damage case is a mobile-completed deal that never has an allocation touched on desktop. Fix: port `buyer_bank_paid_date` and the close-date rule.

---

**M12 — Mobile shows a Pipeline snapshot fed by a table with zero rows**

`www/app.js:6205-6228` renders `deals_by_stage`, `pipeline_value` and `stuck_deals`, all sourced from the standalone `deals` CRM table (`dashboard.rs:643-656`, `729-739`) — the table the server's own comment at `dashboard.rs:658-659` identifies as never written by the invoice→deal-flow workflow. `SELECT COUNT(*) FROM deals` → **0**, while `deal_flows` has 61 rows at `stage='invoiced'`. The phone always reads "Pipeline total: $0.00"; the laptop has no such section, so the two surfaces disagree on whether the metric exists. Fix: source it from non-complete deal_flows or hide the section.

---

**M13 — Margin numerator and denominator are on different refund bases**

`commands.rs:9927-9929`: `SUM({np}) / NULLIF(SUM(gross_revenue),0) * 100`. `{np}` subtracts refunds; `gross_revenue` never does. Propagates to `monthly_breakdown` (`9948-9958`), best/worst margin (`10056-10059`) and the Revenue hero (`BriefView.tsx:176`).

"Net margin over gross revenue" is a defensible standard definition, so the percentage is internally consistent — I am not calling it wrong. What genuinely survives is narrower and does matter: **the Revenue hero reports a fully-reversed sale as revenue.** June shows Revenue $38,903.00 of which $26,500.00 (68%) was returned in full. On a refund-netted denominator June's margin is -169.25% rather than -53.96%; all-time 7.20% rather than 6.88%. Decide the base explicitly and state it on the card.

---

### Low (real, but $0 impact today — listed so they are not re-found)

- **Duplicate deal_flows exposure.** The Brief is the only money screen that neither collapses duplicates in SQL nor triggers the cleanup. Free Cash's `year_profit` (`commands.rs:13113-13122`) carries a survivor sub-select; Analytics (`9525-9528`) inner-joins and counts DISTINCT; `DealFlowView.tsx:117` and `FinancialsView.tsx:397` both auto-run `cleanupGhostDealFlows()` on mount. `BriefView.tsx` does neither. Impact today: **$0.00** — Free Cash's collapsed query and the Brief's plain SUM both return $41,149.40 over 31 rows.
- **`COUNT(*)` next to `COUNT(DISTINCT invoice_id)`.** `completed_deals_this_week` (`commands.rs:9962`) vs `deals_closed_this_week` (`10029-10033`) over a byte-identical WHERE, rendered four rows apart (`BriefView.tsx:194` and `179`). The comment at `10026-10028` explains why the DISTINCT exists. Also, `df_last_week_count` (`9967-9970`) is DISTINCT while its this-period twin is `COUNT(*)`, so the pair is mismatched by construction. Agree in every window today (Jul 17/17, Jun 4/4, May 10/10).
- **Server `deal_bank_actuals` is missing the `has_supplier_link` guard.** `deal_flows.rs:391` is the pre-fix desktop body; a lone wire fee can replace an entire supplier cost. The header comment at `378-382` still claims it is "ported verbatim from the desktop." Desktop fixed this at `commands.rs:4414`/`4425-4430`. Impact today $0 — the one fee allocation ($25.00 on INV-0157) sits alongside a supplier link; I ran both implementations across all 32 completed deals and found zero differences.
- **Payout boxes render negative "cuts."** `allocate_payout` (`commands.rs:4894-4912`) has no floor; `BriefView.tsx:216-233` renders the result under "Each recipient's cut this period." June reads Business -$5,248.00 / Jack -$4,198.40 / Ben -$4,198.40 / Investment -$7,347.20 (summing exactly to -$20,992.00). Before the 2026-08-04 refund those boxes read +$1,377.00 / +$1,101.60 / +$1,101.60 / +$1,927.80 — a closed period restated two days later. Not a miscalculation; a labelling problem plus retroactive restatement, driven by H2.
- **Brief splits before the rep cut.** Brief goes straight from period net to `allocate_payout` (`9994-10012`); `deal_flow_payout` computes the rep cut first (`commands.rs:5041-5042`: `let remaining = eff_net - cut`). $0.00 divergence today — `deal_reps` has 0 rows, every active `staff_account` has `commission_pct = 0.00`, and the only 40% account is suspended — but `rep_payouts_enabled` is already `'1'`.
- **"Your earnings" uses a third rep definition.** `commands.rs:10113-10114` inner-joins `deal_reps` (0 rows) while every other rep figure uses client metadata and `list_rep_payouts` (`commands.rs:5157-5176`) uses the documented order. Structurally $0.00 forever; `BriefView.tsx:314` hides the card on zero rather than showing $0.00, so a rep cannot tell "earned nothing" from "broken." Its WHERE also lacks the `live` fragment, so it would pay on the voided INV-2026-0038 ($545.00 net).
- **`staff_accounts` lookup is not org-scoped.** `commands.rs:10104` — no `org_id`, no `ORDER BY`, arbitrary under `LIMIT 1`; the server's twin scopes it (`dashboard.rs:762-763`). Table is genuinely multi-org (org_default 3, plus 2 others). No display_name collides today.
- **Empty rep name accepted on desktop, rejected on the server.** `commands.rs:9852` uses `.map(|_| …)` — the closure discards the value, so `Some("")` switches the joins on. Server does `Some(r) if !r.trim().is_empty()` (`dashboard.rs:459-461`). Desktop fails closed ($0 everywhere), mobile fails open (org-wide). Zero blank display_names exist.
- **Server's lost count is not rep-scoped while its closed count is.** `dashboard.rs:667-670` carries only `{org_and}`; `663-666` carries `{rep_and}`. Same for `margin_sql` (`699-707`). Scoping only the numerator of `closed/(closed+lost)` is a cohort error.
- **Margin/biggest-invoice cards inner-join even org-wide.** `commands.rs:10055-10072` and `10073-10077` join `invoices` and `clients` unconditionally while the totals above them join nothing. The `live` guard's `NOT EXISTS` passes an orphan through as live, so a non-archived orphaned completed flow would count in Revenue and be invisible to the cards. All 30 orphaned deal_flows are archived and non-complete today.
- **A completed-then-voided deal is counted neither won nor lost.** `live` (`commands.rs:9905-9906`) is evaluated at read time; `deals_lost` (`10036`) needs a `voided_at` this row lacks. INV-2026-0038 (deal 95968871, `completed_at` 2026-07-02, gross $6,515.00, net $545.00) is double-excluded, and any already-read month silently rewrites itself when an old invoice is voided.
- **A $0-revenue completed deal is a data gap, not a formula bug.** INV-0145 (deal 03073195) is `status='paid'`, invoice total $1,880.00, not voided — yet `gross_revenue` 0.00 and `payment_received_amount` 0.00 against $1,880.00 of supplier payments. All-time revenue and profit are each understated $1,880.00; all-time margin reads 6.88% where 7.17% is true. It *can* surface as "Lowest margin" (`commands.rs:10058` scores gross<=0 as 0.0%), rendering a total loss as "0.0%".
- **`json_extract` on malformed metadata would abort a whole query, not a row.** Reproduced on sqlite 3.49.1: one empty-string `metadata` makes the statement raise "malformed JSON" and abort; `COALESCE(json_extract(...),0)` at `commands.rs:9993-9994` does not help, because the error precedes COALESCE. Every consumer swallows it with `.unwrap_or(...)`. This is the exact shape of the v0.15.116 incident. Currently 0 invalid rows in `clients` (131) and `deal_flows` (98, 62 NULL which is safe).
- **A failed payout-split read renders as "you have no payout split."** `read_profit_split_shares_raw` (`commands.rs:4831-4844`) returns an empty Vec on every failure path; `BriefView.tsx:212` treats empty as unconfigured and shows the setup prompt (`253-266`), hiding an all-time allocation of $41,149.40. `generate_weekly_brief` holds one pooled connection (taken at 9848) while this opens a second (pool `max_size(8)`, no `connection_timeout`, `db.rs:159-160`).
- **Inconsistent failure policy.** Four sites are fatal (`9848`, `10049`, `10078`, `10115`/`10118`); ~25 render as a confident $0.00. Identical DB trouble either blanks the Brief ("Could not generate brief", `BriefView.tsx:86`) or prints Revenue $0.00 as fact. Related: `due_followups` ends in `filter_map(|r| r.ok())` (`commands.rs:1586`) over a mapper whose `name`, `billing_status`, `lead_status`, `created_at`, `updated_at` are non-Option `String` — the "never chain filter_map(ok) over a row mapper" rule.
- **No sync listener.** `BriefView.tsx` has one `useEffect` (`:50`, empty deps) and no `listen("netsync-applied", …)`, while `FinancialsView.tsx:433`, `FreeCashView.tsx:135`, `InventoryView.tsx:231`, `LoansView.tsx:71` and `NotesView.tsx:99` all subscribe. Mitigated: the component is conditionally mounted (`App.tsx:535`) so leaving and returning reloads it, and there is a manual Refresh (`:128`). The real case is booting straight into a stale Brief (`clienthub_last_tab`, `App.tsx:83-84`).
- **A failed page-back leaves the previous period's numbers under the previous period's label.** `load` (`BriefView.tsx:41-49`) never clears `brief` on error, and `:65` moves the anchor before `:66` loads. The "Could not generate" state requires `!brief`, so it can only ever fire on first load.
- **Monthly arrows repeat and skip.** `addDays(anchor, ±freq)` (`BriefView.tsx:64`, `70`) steps raw days while the backend snaps to the calendar month (`commands.rs:9876-9883`). Swept all 365 start days of 2026: **67 (18%) produce a repeated month, 24 (7%) make a month unreachable** — 2026-03-01 and 03-02 both jump March→January, so February can never be viewed. All cluster in the last week of a month. From 2026-08-06 the chain is clean for 40+ presses.
- **`period_days` silently truncated.** `(period_days / 7).max(1)` (`commands.rs:9884`) and the `>= 28` branch (`9876`) mean 8–13 → 7, 22–27 → 21, and 28/60/90/365 all → one calendar month, with no signal to the caller. The desktop "Daily" preset (`BriefView.tsx:18`) renders a full Mon-Sun week under a "Daily brief" heading; mobile offers only 7/14/30 (`app.js:6017`), so Daily has no phone equivalent. His setting is 30, which maps correctly.
- **The "equal-length" comment is false in the month branch.** `commands.rs:9873-9874` says "'Last period' is the equal-length window immediately before." Only the week branch delivers that. February vs January is -9.7% on day count alone. His July-vs-June comparison already carries ~3.3% of pure calendar, buried inside a real +324% swing.
- **Loss total printed with its own sign.** `BriefView.tsx:297` and `app.js:6176` render `loss_total_this_week` raw ("1 deal lost money this week: -$2,480.00") while `app.js:6140`/`6142` wrap the same field in `Math.abs()` — the two renderings disagree on sign inside one card.
- **Cadence label decoupled from cadence data.** `freq` is local state (`BriefView.tsx:39`) from a separate round trip while the window comes from an independent settings read (`commands.rs:9864-9869`). The failure the code invites is unreachable (`get_brief_frequency` at `commands.rs:6200-6203` returns `Ok` unconditionally), but `changeFreq` (`:56-60`) sets `freq` optimistically **before** awaiting the write, so a failed write leaves the label, dropdown and arrow step on the new cadence against a backend still on the old one.

---

## 4. Cross-surface disagreements

| Metric | Desktop | Mobile / server | Consequence |
|---|---|---|---|
| Period length | `brief_frequency_days`='30' → calendar month (`commands.rs:9864`) | `localStorage.ec_brief_days` default 7 (`app.js:6059`) | Every figure computed over a different span. Last period $418,893 / 17 vs $274,520 / 5 |
| "Profit from deal flows" headline | `net_profit_this_week` raw (`BriefView.tsx:204`) | `net + abs(loss_total)` (`app.js:6140`) | Different big number under the same heading. June: phone prints -$19,112.00 which is neither the net (-$20,992.00) nor before-losses ($1,888.00) |
| Overdue guards | no voided/archived guard (`commands.rs:10042-10047`) | guard present (`dashboard.rs:675-682`) | A status-only widen is safe on the server, imports $159,329.35 on desktop |
| `deals_lost` rep scope | `{rep_filter}` applied (`commands.rs:10035-10039`) | `{org_and}` only (`dashboard.rs:667-670`) | Rep's win rate diluted by voids they never touched; laptop "0 lost" vs phone "4 lost" |
| Best/worst margin rep scope | `{rep_filter}` (`commands.rs:10062`) | none (`dashboard.rs:699-707`) | Phone's highlight cards can name another rep's deal and client |
| Refund banner | present (`BriefView.tsx:303-311`) | keys absent from the response (`dashboard.rs:795-843`) | Phone shows June's negative with no explanation |
| Pipeline snapshot | no such section | rendered from an empty table (`app.js:6205`) | Phone asserts "$0.00 pipeline" on 61 invoiced deals |
| Per-deal payout metadata | never refreshed by resync (`commands.rs:4514`) | refreshed (`deal_flows.rs:319-331`) | Two surfaces drift; $644.45 of phantom partner money on desktop |
| `has_supplier_link` guard | present (`commands.rs:4414`, `4425-4430`) | absent (`deal_flows.rs:391`) | A fee-only link would write a phantom profit from mobile |
| Close date on completion | `buyer_bank_paid_date` → `payment_received_at` → now (`commands.rs:4276-4285`) | `now` (`deal_flows.rs:971-974`) | A phone-completed deal books to the button-press date, permanently |
| Empty rep name | treated as a filter → $0 (`commands.rs:9852`) | treated as no filter → org-wide (`dashboard.rs:459-461`) | Same user, two briefs |
| `completed_deals` count | `COUNT(*)` this period, `DISTINCT` last (`9962`, `9967`) | `COUNT(*)` both (`dashboard.rs:561`, `586`) | Latent divergence once a duplicate completed row appears |

---

## 5. Cleared — investigated and found correct

Do not re-investigate these.

**Data integrity**
- **Duplicate `deal_flows` rows inflate nothing.** 15 invoices carry 2–4 rows, but every group has at most one `stage='complete'`. `GROUP BY invoice_id HAVING COUNT(*)>1` over non-archived rows returns **zero**; all 32 completed rows are `archived=0` and map to 32 distinct invoice_ids. COUNT(*) and COUNT(DISTINCT) agree in every window.
- **Stored `net_profit` matches bank truth on all 32 completed deals — total gap $0.00.** I re-implemented `deal_bank_actuals`' exact bank-precedence logic (role sums gated on `EXISTS(bank_txn)`, the three `has_*_link` fallbacks, cost clamped at 0, r2 rounding) and compared row by row, including the fee-only case and the `gross_revenue=0` case. Every row matches to the cent. `net = gross - cost` holds on all 32; no negative gross anywhere.
- **No orphaned or double-counted allocations.** Zero `bank_allocation` rows point at a missing `bank_txn`. No txn is allocated twice to the same deal+role. No txn is over-allocated. Every role sits on a txn of the correct direction (buyer_payment 32/32 in, supplier_payment 28/28 out, fee 1/1 out, refund_out 5/5 out). **INV-0176's two $100,000 buyer payments are two distinct Tytan Market wires** (`btpl_PANbVo…`, `btpl_1ad1qE…`, both 2026-07-28) — real repeats, correctly counted twice.
- **Refunds are counted exactly once.** The Brief's `(net_profit - SUM(all refunds))` and the canonical `non-bank-linked + all refund_out` rule produce identical numbers here: $152,220.00 both ways, and per deal (1792c577 $85,720; 4cf120bf $40,000; c6ac3cda $26,500). Double subtraction is impossible — `deal_bank_actuals` never reads `refund_out`. Every one of the 5 `refund_out` wires has an exact-amount, same-`bank_txn_id` refunds row. No refund is attached to an archived sibling row.
- **`invoices.profit` / `total_cost` are in sync with `deal_flows` on all 32 completed deals** — zero mismatches; the writeback at `commands.rs:4536-4543` is working.
- **`completed_at` format mixing is safe.** 21 rows `YYYY-MM-DD`, 11 rows `YYYY-MM-DDT00:00:00Z`; both compare correctly against date-only bounds by prefix, and `strftime('%Y-%m', …)` parses both. Zero NULL or empty. Same for `voided_at` (`+00:00` RFC3339) and the 6 `issue_date` values stored as full timestamps.
- **`monthly_breakdown` values are all correct** — three buckets, no nulls, no future months, each row's margin equals its own net/revenue, and they sum exactly to `revenue_all_time` $598,124.85 and all-time net $41,149.40. Only the labels are wrong (H7).
- **`avg_margin_all_time` = 6.879% = $41,149.40 / $598,124.85** — internally consistent.
- **Financials, Analytics and `get_monthly_profit` agree with the Brief.** Free Cash's `year_profit` returns $41,149.40, identical to the Brief's all-time; the tax/refund reserves derived from it ($12,344.82 at 30%) are consistent. Only `dashboard_stats`' revenue tile disagrees (C3).
- **The `live` guard is working.** INV-2026-0038 (voided, live completed flow, $6,515 / $545) is correctly dropped: July shows 17 deals / $418,893, not 18 / $425,408.
- **August's $0 is true data.** `MAX(completed_at)` = 2026-07-29 — every deal is fully entered and bank-linked, nothing is waiting on Jack. The window arithmetic is correct for the anchor it is given.

**Payouts**
- **`payout_totals` ties to `net_profit` exactly, in every window, including the negative month.** May $3,759.96 + $3,007.97 + $3,007.97 + $5,263.95 = $15,039.85; June -$5,248.00 + -$4,198.40 + -$4,198.40 + -$7,347.20 = -$20,992.00; July $11,775.39 + $9,420.31 + $9,420.31 + $16,485.54 = $47,101.55. Independent per-recipient rounding introduces no cent-level drift. All 31 live completed deals are `payout_included=1`, so `net_excl` is 0 and the business-share branch is never exercised.
- **`allocate_payout` is line-for-line identical desktop vs server**, and both read the same settings row (`scoped_setting_key` returns the bare key for `org_default`).
- **The legacy `profit_jack` / `profit_ben` / `profit_business` columns are wrong but reach no screen.** All-time they sum to $43,972.11 = exactly 65% of raw net — the 35% "Investment" recipient has no column, and they are pre-refund. Root cause is `resync_completed_deal` (`commands.rs:4510-4521`) writing from the legacy 3-way `read_profit_split()`. But grep of `BriefView.tsx` and `www/app.js` returns zero render sites; both surfaces render `payout_totals` only. Dead payload, not a wrong number on screen.
- **`completed_deals_last_week` is dead payload.** Its missing rep filter (`commands.rs:9967-9970`) is a genuine code defect — it returns the org-wide 17 for July even when a rep is set — but grep finds no render site in either surface, so it has no user-visible symptom. The visible mismatch is `COUNT(*)` at 9962 next to `COUNT(DISTINCT)` at 10030 in the *same* period.

**Windows and dates**
- **The exclusive upper bound is correct; nothing falls off the last day.** `week_end` (`commands.rs:9893`) is display-only (`BriefView.tsx:165`, `218`; `app.js:6067`, `6086`) and is never bound into a query. The 2026-06-30 deal ($26,500) is correctly inside June and outside July.
- **The dead `last_week_end` variable is harmless** (`commands.rs:9895-9896`); every desktop last-period query binds `[&last_week_start, &week_start]` directly, and the server's version holds the identical value.
- **The week branch's previous period is genuinely equal length** at every setting (7/7, 14/14, 21/21). Only the month branch breaks the promise.
- **Timezone skew has not yet moved any row across a boundary.** 61 of 131 clients, 16 of 229 interactions and 6 timestamped `issue_date` values fall on a different local day — I checked every one against both the Monday and month boundaries the Brief uses; **zero cross either.**
- **No future-dated rows anywhere**, so the open-ended month queries happen to equal the month right now: `MAX(deal_flows.completed_at)` 2026-07-29, `MAX(bank_txn.posted_at)` 2026-08-06, `MAX(clients.created_at)` 2026-08-05, `MAX(interactions.created_at)` 2026-07-30.
- **The 30-day arrow chain works from today.** Forty consecutive back-presses from 2026-08-06 land on exactly one month earlier each time.
- **`brief_frequency_days` is unambiguous on desktop** — the unscoped `SELECT` has exactly one matching row (`'30'`, `org_default`).
- **`interactions_this_week = 0` is factually correct today** despite the missing bound (newest interaction 2026-07-30).

**Safety and structure**
- **SQL injection via `rep_filter` is not exploitable.** `r.replace('\'', "''")` is the correct SQLite escape; there is no backslash escape inside SQLite literals. Ran `a\'; --`, `O'Brien` and `""` — all 29 interpolated statements executed cleanly with no early termination. A U+2019 apostrophe is an ordinary character (`Tk's Clothing` matched its one real deal).
- **No interpolation site produces a broken query.** Reconstructed and executed all 29 statements with and without rep scoping: no duplicated alias, no ambiguous column (`gross_revenue`, `net_profit`, `profit_*` exist only in `deal_flows`), no `{rep_filter}` injected into a query lacking a `c` alias.
- **The joins drop nothing today and cannot fan out.** Zero completed+live flows lack an invoice; zero invoices lack a client; both joins are strictly 1:1 (`GROUP BY id HAVING COUNT(*)>1` → 0 on each).
- **The Brief cannot deadlock on either surface.** The server's global-mutex hazard was already fixed in exactly this handler — `dashboard.rs:440-443` carries the explanatory comment and `rep_payouts_enabled` is read at 454, one line before `db::conn()` at 455. I scanned the whole handler (445-860) for any further `db::conn()`/`org_setting*` call while the guard is held: none. The desktop uses an r2d2 pool, reads only, and would time out rather than deadlock.
- **No NULL column is silently dropping a row.** Zero completed deals with NULL `net_profit`/`gross_revenue`/`profit_*`; zero NULL month buckets; zero refunds with NULL amount; zero of the 131 clients (including all 22 follow-up rows) has a NULL in any non-Option column.
- **The payout `json_extract` landmine is not armed** — zero invalid and zero empty-string `metadata` rows in `deal_flows` (62 NULL, which is safe) and `clients`.
- **`currentUser` cannot race the Brief.** `App.tsx:548` returns `null` for the whole app while `me === undefined`, so the []-deps effect is not a rep-scoping hazard.
- **Switching tabs does refetch** — `App.tsx:535` mounts conditionally; no query-cache layer, no module-level cache.
- **The header date range is correct and timezone-immune** — `BriefView.tsx:165` prints the raw ISO strings with no `Date` round trip. It is the only thing on screen that reliably names the period.
- **The Profit hero's "X% margin" sub-label really is the two numbers beside it** — `margin_q` shares the exact WHERE clause of `revenue_this_week` and `profit_this_week`, so 11.2% is $47,101.55 / $418,893.00 by construction. The one theoretical break (revenue 0, profit non-zero) does not occur in any real window.
- **`best_margin_deal` / `worst_margin_deal` and `monthly_breakdown` are computed identically desktop vs server** (same expression, guard, window, ORDER BY; both reverse for display), differing only in rep scoping.
- **The loading state is honest** — `BriefView.tsx:151-158` shows skeletons and does not display stale figures during a refetch.
- **Single org.** clients 131, invoices 52, deal_flows 98, interactions 229, refunds 6 — all `org_default`. The Brief's unscoped queries cannot pull another tenant's rows. Only `staff_accounts` is genuinely multi-org.

**Correction to an earlier claim:** "$187,800.80 of fall-throughs is invisible" is an overstatement. Of the five NULL-`voided_at` voids, two are never-sent drafts ($179,950.70, 96% of that figure) and one has no deal_flow ($0.10). The genuinely invisible fell-through business is INV-2026-0038 ($6,515.00) and INV-2026-0043 ($1,335.00) — **$7,850.00**.

---

## 6. Recommended fix order

**Step 0 — before any code, run the resync.**
"Sync completed from bank" on the current binary. This is a button that already exists and it moves $47,920 of August money out of July. **Everything below is measured against a book that is still on the old close-date rule, so do this first or you will be verifying fixes against wrong dates.** Note INV-0183 will not move — it needs H9's re-link first, so do that in the same sitting (re-link `btpl_L3gJVo…` as a `buyer_payment`, then resync).

**Step 1 — the two changes that fix a wrong dollar figure Jack can see today.**
1. **Overdue card (C2)** — `commands.rs:10043` and `10046` in one edit: `status IN ('sent','overdue') AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 AND due_date < ?anchor`. Both halves together. Fixing status alone imports $159,329.35 of voided paper. Worth $345,435.10 of visibility.
2. **Loss card (H1)** — swap `net_profit` for `{np}` in both CASE branches at `commands.rs:9962` and `dashboard.rs:577`/`581`. Two-expression change; exposes the hidden $21,000 and fixes mobile's headline as a side effect.

**Step 2 — one-line changes, no dependencies, do them together.**
- `AND created_at < ?2` on `commands.rs:10085`/`10089` and `dashboard.rs:690`/`694` (M1).
- `periodLabel` in the four headings at `BriefView.tsx:173`, `296`, `357`, `392` (H8).
- Month label at `BriefView.tsx:280` → `"-01T12:00:00"`; `www/app.js:6079` → local constructor (H7).
- `Math.abs()` at `BriefView.tsx:297` and `app.js:6176`.
- Append `{live}` to the rep-earnings WHERE (`commands.rs:10114`, `dashboard.rs:775`).
- Port `has_supplier_link` from `commands.rs:4414`/`4425-4430` into `deal_flows.rs:391`, and correct the false "ported verbatim" comment at `378-382`.
- Correct the stale doc comments at `commands.rs:10894-10897` and `9873-9874`.

**Step 3 — must follow step 0, because they change how dates are computed.**
- **Anchor on local time (M3)** — `commands.rs:9857`/`9859` and `dashboard.rs:471-473`. Do this before the month-bucket fix, since that derives from `anchor`.
- **Month bucket from `anchor` with an upper bound (H6)** — `commands.rs:9937` plus the four consumers at `9940`/`9942`/`9977`/`10002`, `dashboard.rs:503` and its seven month queries, and the client-side month name at `BriefView.tsx:240`. Then replace the `!== 0` gate at `:236` with a `payout_totals` check so the MTD row stops vanishing.
- **Refund date axis (H2)** — filter on `rf.refunded_at`, add the `live` guard and `stage='complete'`, union in unmirrored `refund_out` rows.

**Step 4 — must follow the win-rate population decision (see below).**
- Restrict `deals_lost` to invoices that were actually in play (`commands.rs:10036`, `9201`, `9547`), **then** backfill `voided_at`, **then** unify the definition across the three surfaces (H5).

**Step 5 — parity and consistency.**
- Mobile period from the org setting (M7). Mobile headline → `net_profit_this_week` (H8/mobile). Refund keys added to the server response. Rep predicate on `dashboard.rs:667-670` and `699-707`. Rebuild `payout_recipients` in `resync_completed_deal` (M8) — recovers the $644.45 of phantom partner money. Port `buyer_bank_paid_date` to the server (M11).
- Trend chips: one formula (abs denominator) for all three, null-on-no-baseline, and an em-dash for win rate with no cohort (H3, M5, M6).

**Step 6 — before the first non-admin account exists.**
- Fix the rep resolution (M9) and give the five leaked queries a rep predicate (M10). These are latent only because no account can currently reach rep mode. The first `role_manager` or `role_viewer` Jack creates gets a $0 brief with another rep's $200,000 invoice on it.

---

### Decisions that need Jack, stated plainly

1. **Which revenue is "revenue"?** Bank-truth `gross_revenue` on the deal's close date, or invoice face value on the date it was marked paid? Today the Brief says one and the Dashboard says the other, $83,270 apart for August. Pick one for the whole app, or accept two and label them differently.
2. **Should "Revenue" count a sale that was fully refunded?** June shows $38,903 of which $26,500 came straight back. Net it out of revenue, or keep revenue gross and state that margin is on gross?
3. **What counts as a "lost deal"?** Any voided invoice (Dashboard's 77.5%), only ones that were actually sent and had a deal behind them (83.8%), or only ones with a void date stamp (Brief's 88.6%)? This decides the `voided_at` backfill.
4. **Should a period-to-date figure be compared against a full prior period, or against the same elapsed days?** Today day 6 of 31 is measured against a complete month and reads ▼100%.
5. **Can a payout box be negative?** June currently shows each recipient owing money back. Clamp at zero and show the shortfall separately, or relabel the row as "share of period P&L"?
6. **Should the Brief's payout boxes be before or after rep commission?** The deal screens split net minus the rep's cut; the Brief splits the whole net. $0 divergence today, but `rep_payouts_enabled` is already on.
7. **Do rejected leads count as "new clients"?** July's true 29 includes 2 rejected test leads.
8. **Should a refund entered today change a closed month's profit?** It does now — the 2026-08-04 refund rewrote June's number and flipped every June payout box negative.
9. **Keep the "Daily" preset?** The engine cannot express a sub-week window; it renders a full week under a "Daily brief" heading, and mobile has no equivalent.
10. **Should `lead_representative` keep defaulting to the client's company name** when the intake form leaves the rep blank (`form_parser.rs:188`, `signup_rules.rs:360`)? That default is what makes every rep-scoped brief read $0.