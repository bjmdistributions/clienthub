# FINANCIALS RE-ARCHITECTURE PLAN — 2026-08-03

Plan only. No code written. Approve or push back before any work starts.

---

# Financials: duplicate-proof ledger, real-time on every device, and a split flow that works

Numbers in this plan were re-measured against your live database today. The brief I was given said 1,891 transactions and 548 duplicates. That is stale — the aggressive cleanup you shipped in v0.15.122 already ran and propagated. **Actual: 1,248 transactions, 1,215 distinct ones, 33 excess duplicates in 19 groups, 50 allocations, and zero transactions have ever been split.** I'll use the real numbers throughout.

---

## 1. What's actually wrong

A transaction's identity in your system is a receipt number Plaid hands out, and that number belongs to the *connection*, not to the transaction — so re-link a bank, or link the same card twice, and the same real payment arrives under a different name and lands as a second row. There are three separate naming schemes for the same money (Plaid feed, PDF statement import, manual cash) and none of them can recognise a row created by another, which means importing a statement for a month the feed already covered creates a complete parallel ledger. Every defence built so far runs *after* the row is already in the database — the import fingerprint guard and the cleanup tool compare fields and make a judgement call, so they are probabilistic by construction and always will be. That judgement is dangerous in both directions: too loose and duplicates survive, too tight and it destroys real money — you genuinely have four rows of "$25 online domestic wire fee" on one day where **two of them are real fees**, and a naive content match would delete two real charges. The root reason it can never be zero today is that nothing in the database itself asserts "these two rows are the same transaction" — that fact only exists inside a query someone has to run and trust.

---

## 2. The fix, in plain English

**Stop naming transactions after how they arrived. Name them after what they are.**

Here is the finding this whole plan rests on. Your bank already stamps a globally unique reference into the memo of every serious transaction, and not one line of your code uses it:

```
ORIG CO NAME:Pirate Ship  TRACE#:021214899149033  ...  PLAID TRN: 1599149033TC
ONLINE DOMESTIC WIRE VIA WELLS FARGO ...  IMAD: 0709MMQFMP2M023169  TRN: 3422486190ES
Zelle payment to Epilson Wholesale  JPM99cjnk2kx
Online Transfer from MMA ...8278  transaction#: 30181777112
```

I extracted those references across all 1,248 rows:

- **531 rows (43%) carry one — but that's 91% of your dollars**, and over 90% of every transaction above $10,000.
- **Zero collisions in 14 months**, once you separate money-in from money-out. (There are exactly four global collisions and all four are the two legs of an internal transfer sharing one reference — separating by direction resolves all of them.)

These references live in the bank's own descriptor. They survive a Plaid re-link, an item change, a card mask change, and a PDF statement re-import. That is a real name for the transaction, not a heuristic.

**The rule:** a transaction's row id becomes a fingerprint of `direction + reference`, computed in one function that every single writer calls — Plaid sync, statement import, the server, mobile. The second time that transaction arrives, from any source, on any device, after any re-link, it computes *the same id*, hits the existing row, and updates it instead of inserting.

**Why that's "impossible" and not "detected":** the id is the primary key. There is no code path in this system that can create a second row with an id that already exists — the sync engine already treats an id collision as "same row, merge the fields", which is exactly what we want and requires nothing new to be built. It isn't a check that has to remember to run. It's the shape of the table.

### The residual gap — stated exactly

**717 rows (57% of rows, 9% of dollars) carry no reference and never will.** These are card spend (Uber, Apple Pay, restaurants, airlines) and — the one that matters — **teller cash: `WITHDRAWAL 05/14 $25,000`, `WITHDRAWAL 05/13 $15,000`, `ATM CASH DEPOSIT $7,300`.** The bank does not issue a reference for an ATM withdrawal and it never will.

I had a clever scheme for this tail (content fingerprint plus an "occurrence number" to tell twins apart). **I'm cutting it.** Adversarial review broke it in a way I can't defend: two devices can assign the same occurrence number to two *different* real charges, and the result is not a duplicate — it's a silent **merge**, where one real charge disappears from your books with no error anywhere. That is strictly worse than the problem. Every one of your 33 current duplicates lives in this tail, so I want to be blunt: the identity guarantee is airtight over the 91% of money that has never actually duplicated, and it does not, by itself, fix the 9% that has.

**What closes the tail instead: nothing gets in silently.** A reference-less row that exactly matches an existing row goes into a **hold list** rather than the ledger. One line, one tap: *"Two identical $25.00 wire fees on 31 Jul — both real, or a duplicate?"* Both real → both admitted. Duplicate → discarded permanently. Realistically that's a handful of prompts a year, and it is the only correct answer, because software cannot know whether the bank charged you one fee or two.

Two more honest limits:
- **Check numbers and teller deposit IDs look like references but are counters that recycle** (your checkbook already shows two series, 21xx and 25xx). I'm deliberately excluding them — treating them as identity would merge check #2136 for $2,000 with a future check #2136 for $18,000 and destroy money.
- **Cash you type in manually and the bank's own row for the same cash** cannot be linked by any identity trick. The answer there is a prompt: "you recorded a $7,300 cash deposit on this date — is this the same one?"

**The headline, honestly: zero duplicates, structurally impossible, for every wire, ACH and Zelle you book against a deal — 91% of your money. For the remaining 9%, zero *silent* duplicates: anything ambiguous stops and asks you once. That is the ceiling, and anyone promising literal 100% on ATM cash is guessing.**

---

## 3. Where transactions come from

Today four things can write a bank transaction: your PC's Plaid sync, your other desktop's Plaid sync (the access token is copied between admin machines automatically — you may not have known that), the PDF statement importer, and manual cash. A fifth exists in the server code and has deliberately never been deployed.

**The plan: one writer per source.**

| Source | Owner | Why |
|---|---|---|
| Plaid feed | Server, webhook-driven (phase 4) | The only source that has ever duplicated. One writer, one cursor, one id. Also means the feed works when your desktop is asleep. |
| PDF statement | Desktop | Needs the file off your disk. Already never duplicates. |
| Manual cash | Whatever device you're on | It's a deliberate human act. |

I am **not** doing the Plaid move in the same release as the identity change. Two large changes to the same table at once is how you get a repeat of the v0.15.44 outage. It gets its own phase.

### What you have to do once

1. **Unlink the duplicate Amex connection.** One physical card is linked twice, showing as `Blue Business Cash(TM) ··1004` and `··2002`, with 189 identical transactions in both. Settings → Banks → remove one. This is the single largest source of your historical mess and no amount of code removes the need to do it once.
2. **Confirm the account merge once** — "··1004 and ··2002 are the same card" — so history lines up behind one account.
3. **From then on, use "Reconnect this bank", never "Connect a bank".** New button, uses Plaid's update mode to re-authorise the *existing* connection in place. This is the smallest change in the whole plan and it's the one that stops the problem recurring — the current mess exists because "reconnect" has always meant "link it again".
4. **If we do phase 4:** you set three Plaid credentials in the droplet's environment yourself. I won't enter credentials on your behalf.

---

## 4. Real time on every device

**Today:** a transaction reaches your second desktop in up to 20 minutes. It reaches your phone **never** — there is no financials screen in the mobile app at all. Zero of the 23 mobile screens touch bank transactions.

**After:**

```
bank posts  →  Plaid tells us  →  imported  →  desktop ≤20s
                                            →  phone   ≤15s
```

- Desktop: no change needed. It already syncs every 20 seconds.
- Phone: new Financials screen, a delta endpoint that returns only what changed, refreshed on screen open, on pull-to-refresh, and every 15 seconds while the screen is actually in front of you. Plus a card at the top of the mobile dashboard — `6 transactions to book · $312,400 waiting on a deal` — so you see it without going looking.

**Not building:** live push/websockets. iOS kills the connection the moment the app backgrounds, so you need the polling fallback anyway — it's more code for worse reliability at your scale.

**Honest limit:** Plaid decides when it tells us, and that's minutes to hours after the bank posts. Nothing we build changes that floor. And until phase 4, if your desktop is asleep, nothing new arrives anywhere — that is the real argument for moving ingestion to the server, not duplicate prevention.

---

## 5. Splitting one payment across deals

### The model

A transaction is a pot of money. You cut it into **legs**. Each leg says "this many dollars of this went here". A deal is one kind of destination among several:

```
buyer payment → a deal      supplier payment → a deal      fee → a deal
refund → a deal             owner draw → not a deal        business expense → not a deal
```

Right now only the deal-linked ones exist. That is why a $50,000 receipt that's $30,000 for a deal and $20,000 an owner draw is **permanently stuck** in your to-do queue: the remaining $20,000 is literally unrepresentable. That is the confusing case you described, and the fix is adding the two non-deal destinations, not new machinery.

Two rules, enforced everywhere: **legs can never sum to more than the transaction**, and **a transaction is done when the remainder hits zero**. Today there are three different definitions of "needs attention" in the code and they disagree with each other — that's why the tab count and the "needs a deal" figure never match. All three get replaced by one.

### Desktop flow — your $62,000 wire

Click the row. A panel docks on the right:

```
┌──────────────────────────────────────────┐
│  +$62,000.00                          ✕  │
│  Hernandez Liquidation                   │
│  3 Aug 2026 · Chase ··4021 · wire        │
│                                          │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  $62,000.00 left to allocate             │
├──────────────────────────────────────────┤
│  Where it goes                           │
│                                          │
│  Choose a deal…                          │
│  Buyer payment ▾              [        ] │
│         Rest $62,000 · Balance $30,000   │
│                                          │
│  + Add another deal                      │
│  Not a deal? Owner draw · Expense · Loan │
├──────────────────────────────────────────┤
│  $62,000 left            [  Allocate  ]  │
└──────────────────────────────────────────┘
```

Pick deal A. The `Balance $30,000` link fills that deal's exact outstanding invoice amount — you don't type it. Add another, pick deal B, tap `Balance $20,000`. Add a third, pick deal C, tap `Rest $11,975`. Add a leg for the $25 wire fee. The bar fills as you go:

```
  ████████████████░░░░░░░░░░░░░░░░░░░░░░  $32,000 left
  ██████████████████████████░░░░░░░░░░░░  $11,975 left
  ██████████████████████████████████████  Fully allocated
```

Button changes to **Allocate and book**. One click commits all four legs together. The row leaves the queue.

Two things that are broken today and get fixed here: the amount check and the insert aren't wrapped together, so two windows or two devices can both over-allocate the same wire — and the automatic "healer" then deletes whichever leg was created *last*, which is as likely to be the correct one as the duplicate. All legs will commit in a single transaction, and over-allocation will be shown as a conflict for you to resolve, never silently trimmed.

### Phone flow

Same thing, six taps, no digits typed:

```
┌──────────────────────────────────┐
│  +$62,000.00                     │  ← pinned, never scrolls
│  Hernandez Liquidation           │
│  ████████░░░░░░░░░░░░░░░░░░░░░   │
│  $32,000 left                    │
├──────────────────────────────────┤
│  INV-2026-0041 · Costco     ✕    │
│  Buyer payment      $30,000.00   │
│  ────────────────────────────    │
│  ＋ Add a deal                    │
│  Not a deal? Owner draw · Expense│
├──────────────────────────────────┤
│  $32,000 left    [   Allocate  ] │
└──────────────────────────────────┘
```

The amount and the bar stay pinned — that's the one rule that makes a split survivable on a phone. Picking a deal slides to a full-height search list rather than a dropdown (a dropdown inside a sheet gets eaten by the keyboard). Under each amount field: `Rest $32,000` and `Balance $20,000` as tap targets.

**Overpayment:** the field goes amber inline — *"That's $2,000 more than this deal is owed"* — with three choices: book it and show the deal as over, put the excess on the client as a credit, or book it as an adjustment. Never a toast, never silently accepted.

**Underpayment:** the deal reads *"Collected $30,000 of $50,000 — short $20,000"*, and when the balance arrives the short deal is visibly the one to pick.

---

## 6. The new UI

### The problem in one sentence

On the Transactions screen there are roughly 850 lines of setup, import and cleanup controls **above** the actual list — including a permanently mounted panel with your Plaid secret in a password field. Connecting a bank is a once-ever act. Booking a wire is a daily act. The once-ever act owns the top of the screen.

### Four surfaces instead of one crowded tab

| Surface | What's on it |
|---|---|
| **To book** (opens here) | Only unbooked transactions. Nothing else. |
| **Ledger** | Everything ever — search, filters, history, per-deal drill-down |
| **Cash** | Free cash + loans (unchanged, it's the best screen you have) |
| **Setup** | Bank connections, keys, statement import, cleanup tools, auto-tag rules |

Every setup, import and cleanup control moves to Setup. "Clean up duplicates" is currently the most visually prominent button on your financials screen — it's a workaround for a bug, and it goes in the drawer.

### To book

```
┌ sidebar ┬──────────────────────────────────────────────┬─ panel ─┐
│         │ Financials                          Setup    │         │
│         │ 18 to book · $312,400 waiting on a deal      │         │
│         │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │         │
│         │ To book  Needs a deal  All accounts ▾ Aug ▾ ⌕│         │
│         │ ──────────────────────────────────────────── │         │
│         │ Today                                        │         │
│         │ ▍ Delta Wholesale LLC            +$47,000.00 │         │
│         │   Needs a deal · Chase ··4021                │         │
│         │   ┌ Looks like INV-2026-0041 · Costco pallets│         │
│         │   └ exact amount match       [ Tie it ]      │         │
│         │ ──────────────────────────────────────────── │         │
│         │ ▍ Amazon                          −$1,204.11 │         │
│         │   Needs a category · Amex ··1004             │         │
│         │ ──────────────────────────────────────────── │         │
│         │ Yesterday                                    │         │
│         │ ▎ Hernandez Liquidation          +$62,000.00 │         │
│         │   $27,000 of $62,000 tied to 2 deals         │         │
└─────────┴──────────────────────────────────────────────┴─────────┘
```

Three deliberate changes to the row:

- **The subline says what the row *needs*, not what it is.** `Needs a deal` / `Needs a category` / `$27,000 of $62,000 tied to 2 deals`.
- **The left rail carries state** — solid when it needs a deal, faded when partly allocated, nothing when done. That's what colour is for now.
- **The match chip is the biggest single win available.** Your code already scores deals against each transaction (+100 for a payer-name hit, +60 for an exact amount match) and then displays the result as a five-letter grey word, "match". Given a body and a button, an obvious wire goes from **8 clicks to 1**.

Dropped from the row: the account column (it's near-constant and it's why the table needs horizontal scrolling), the date column (replaced by Today / Yesterday dividers), the inline category dropdown, and the hover-only pencil that opens a browser `prompt()` box.

### States that are currently wrong

- **Empty, first run:** currently says "No transactions yet" and offers *Import statement* — the wrong door for a bank-feed account. Becomes "Connect your bank".
- **Queue empty:** "You're all caught up. $312,400 tied to deals this month across 24 transactions." This is the state you should hit daily and it should read like an achievement.
- **Filtered to nothing:** an inline `Clear filters` that actually works, instead of a grey line with no exit.
- **Loading:** skeleton rows at the exact row height, so the page stops jumping on every refresh.
- **Errors:** inline and retryable. No more raw Rust error strings in a toast.

Two live violations of your own design rules get deleted on the way past: `WILL REMOVE (SAMPLE)` and `NEEDS YOUR REVIEW — NOT REMOVED` are uppercase kickers in the dedupe dialog.

### Mobile

Net-new. Financials list, filters, transaction sheet, deal picker, split, pull-to-refresh, plus the dashboard card. This is the largest single piece of work in the plan — the mobile app is 7,000 lines with literally zero bank code — and it's realistically 600–800 lines. It ships as its own phase so the interaction is settled on desktop before it's written twice.

---

## 7. Migration

**Nothing is deleted, no ids are rewritten, no allocations are repointed.**

| What | What happens |
|---|---|
| **1,248 transactions** (not 1,891) | Keep their existing ids forever. Each gets its computed identity stored alongside, read-only. No tombstones written, no rows moved. |
| **33 duplicates** (not 548 — your cleanup already ran) | Resolved once, *before* the migration, using the reference matcher — which can actually prove that the four $25 wire fees are two real and two copies. Today's fingerprint tool cannot tell the difference. |
| **50 allocations** (not 48) | Untouched. None of them are splits — you have never split a transaction — so there are no split invariants at risk. |

**Is it reversible? Yes.** The only irreversible acts in financial software are rewriting ids and deleting rows, and neither is in this plan. Rolling back is a code revert; the added identity column becomes inert data. That matters more than usual here because of the next item.

**Backup and rollback:**
1. Full DB copy (with the `-wal` and `-shm` files — copying without them gives a stale snapshot, which has already caused one false diagnosis) before each phase.
2. The Google Sheet bank backup you already have gets run first.
3. **`bank_txn_deleted_backup` is currently empty — 0 rows — despite 3,357 delete records.** Anything already deleted has no local recovery copy. It gets populated from now on, and the duplicate resolution in phase 1 writes there before removing anything.

### A live problem you should know about, unrelated to any of the above

**Restore from server currently recovers 11% of your bank ledger.** 1,109 of your 1,248 live transactions carry a stale delete record that was never cleared when the row legitimately came back. The restore path skips any row with a delete record. So if your desktop database were damaged today and you hit "Restore from server", you'd get 139 transactions back and lose 1,109 — and 35 of your 50 allocations, covering $690,167, would go with them.

This is the recovery path that every other safety net in the system points at. It's about six lines to fix and it goes in phase 0, ahead of everything else.

---

## 8. What I cut, and why

Per your rules — minimum code that solves the problem, nothing speculative:

1. **Occurrence numbers for reference-less transactions.** The clever part of the identity scheme. Its failure mode is two devices merging two real charges into one, i.e. money silently vanishing. Replaced by the hold-and-ask list, which cannot lose money.
2. **A unique-index constraint on the transactions table.** Sounds like exactly what "zero duplicates" needs. It isn't: when the sync engine hits a constraint violation it silently drops the row *on that device only*, with no error and no retry. That converts a visible duplicate into an invisible missing transaction. The primary key already does the job.
3. **Four new synced tables and columns** (`dedup_key`, `bank_account`, `bank_txn_conflict`, `bank_txn_suppressed`). Every new synced table is permanently discarded by any device running an older build, and those events are never replayed. That's the exact resurrection bug they were meant to prevent, with extra steps.
4. **Deterministic allocation ids.** Would collapse two genuinely separate $6,000 supplier payments on one wire into one, losing $6,000. You have 50 allocations and zero duplicates among them. Replaced by a one-line confirm: "you already booked $X to this deal from this transaction — add another?"
5. **A separate "unassigned / park it" leg type.** With owner draw, expense, fee and adjustment available, every dollar is representable, so nothing needs a parking space. It only exists to let a row leave the queue while still being undecided — which is what the old "reviewed" flag did badly.
6. **Drag-the-bar-to-split.** It demos beautifully and is useless when every allocation has to match an invoice to the cent.
7. **Renaming Financials to "Money".** Churn across nav, docs and your muscle memory for zero capability.
8. **A "Half" chip and a chip strip glued above the phone keyboard.** Nobody asked to split down the middle, and keyboard-attached UI in an iOS web app is the flakiest thing in the plan. Plain inline links under the amount field, same tap count.
9. **Rewriting how a deal's revenue is derived when an invoice is only partly paid.** This is a real bug — one partial payment currently overwrites a completed deal's recorded revenue with the partial amount and recomputes payouts from it. But it moves live P&L on existing deals and it is not what you asked for. Own release, with a before/after table of every affected deal shown to you first.

---

## 9. Phases

### Phase 0 — stop the bleeding (very small, no UI)
Fix the restore path so it recovers all 1,248 rows. Clear stale delete records when a row legitimately returns. Gate every import against deletion so a re-pull can't resurrect what you removed. Populate the deleted-rows backup table. Skip pending transactions (they're the ones that mutate under you). Handle Plaid's "this transaction changed" messages, which are currently thrown away by both desktop and server.
> **Verify:** run Restore from server on a copy. Expect 1,248 rows and 50 allocations back, not 139 and 15.

### Phase 1 — identity (small–medium, desktop + server, non-destructive)
Reference extractor. One function every writer calls. Resolve the 33 duplicates with it, backing them up first. Reconnect-in-place button. You unlink the duplicate Amex.
> **Verify:** run "Re-pull all from Plaid" against the real accounts. Expect **0 new rows, 0 duplicate groups**. Then re-import a PDF statement for a month the feed already covers. Expect **0 new rows** (today this creates a full parallel month).

### Phase 2 — the desktop screen (medium)
Four surfaces. New row with state rail and match chip. Allocation panel out of the table. Non-deal destinations. One definition of "unbooked". Atomic multi-leg commit. Real empty/loading/error states.
> **Verify:** an obvious wire is tied in **1 click**. A $62,000 wire splits three ways plus a fee in **one commit**. Zero setup controls render on the To-book screen. No horizontal scrolling at 1280px with the sidebar and panel open. The queue count, the summary figure and the free-cash "stale" figure all return the same number.

### Phase 3 — mobile (large — the biggest item here)
Financials list, filters, transaction sheet, deal picker, split, pull-to-refresh, dashboard card, 15-second foreground refresh.
> **Verify:** on the phone, an unbooked receipt goes to the right deal in **3 taps**; a three-way split in **6 taps with no digits typed**; both visible on the desktop within 20 seconds.

### Phase 4 — server-owned bank feed (large, own release, optional)
Plaid ingestion moves to the droplet, webhook-driven. Desktop stops writing. Tokens stop being copied to every admin machine in plain text.
> **Verify:** put your desktop to sleep. A new transaction still reaches your phone. Link a test account; it appears on both desktops within 20 seconds without waiting for the 20-minute timer.

### Phase 5 — partial-payment revenue (small code, wide blast radius, own release)
> **Verify:** a before/after table of every affected deal, reviewed by you before it ships.

**Do not combine phases 1 and 4.** Two rewrites of the same table in one release, with old builds still in the field, is the shape of the outage you had before.

---

## 10. Decisions I need from you

**1. Accept "zero for 91% of dollars, hold-and-ask for the rest" as the definition of done?**
*Recommendation: yes.* *Consequence:* every wire, ACH and Zelle you book against a deal becomes structurally impossible to duplicate. Card spend and ATM cash get a rare one-tap prompt instead of a guarantee. Saying yes here is what lets me cut the machinery in item 1 of section 8, which is the riskiest thing in the plan. If you insist on literal 100% including ATM cash, I'd have to build that machinery, and its failure mode is money quietly disappearing.

**2. Do the Plaid move to the server (phase 4) — yes, no, or later?**
*Recommendation: later, as its own release, after mobile.* *Consequence of yes-now:* biggest infra change in the plan, requires deploying a file we've deliberately never deployed, and creates a window where old desktop builds are still writing. *Consequence of no/later:* until it ships, if your desktop is asleep, no new transactions appear on any device. Everything already synced still loads on the phone instantly.

**3. Amounts in black instead of green and red on the To-book screen?**
*Recommendation: yes, but easy to reverse.* *Consequence:* with 1,248 rows, every row is currently coloured, so colour tells you nothing and can't be used to say "this one needs you". The sign (+/−) carries direction. If you hate it, green and red stay in the Ledger and it's a one-line revert.

**4. Two identical legs on the same transaction to the same deal — block or confirm?**
*Recommendation: confirm, don't block.* *Consequence:* blocking is one line but would silently swallow two genuinely separate $6,000 supplier payments on one wire. The confirm costs you one extra tap in a rare case and cannot lose money.

**5. Over-allocation across two devices — show you the conflict, or auto-trim?**
*Recommendation: show it.* *Consequence:* today the healer silently deletes whichever leg was created last, which may well be the correct one, and there is no backup for deleted allocations. Showing it means you occasionally see "these two bookings exceed the transaction — which is right?" instead of a number quietly changing.

**6. Loan drawdowns and deal allocations — make them mutually exclusive?**
*Recommendation: yes.* *Consequence:* today a $15,000 loan drawdown still shows at full value in the deal payment picker and can be booked as revenue on top of being a liability. Fixing it is a guard in two places. Not fixing it leaves a live route to double-counted revenue.

**7. Phase 5 (partial-payment revenue) — schedule it, or leave it?**
*Recommendation: schedule it separately, after everything above.* *Consequence:* it is a real bug that currently rewrites completed deals' revenue and recomputes payouts from a partial payment. But shipping it inside this work means any number that moves gets blamed on the redesign.

---

# APPENDIX — IDENTITY / ZERO-DUPLICATE

## Corrections to the brief's "verified live facts" (these change the plan)

I re-measured both sides. The desktop DB (`C:\Users\Jack\AppData\Roaming\com.bjmdistributions.clienthub\clienthub.db`, copied with `-wal`/`-shm`) and the live droplet DB now **agree exactly**:

| | brief says | actually is (both sides) |
|---|---|---|
| bank_txn rows | 1891 | **1248** |
| distinct content fingerprints | 1341 | **1215** |
| excess duplicates | 548 | **33**, in 19 buckets |
| bank_txn tombstones | 2620 | **3357** |
| bank_allocation | 48 | **50** (0 orphans, **0 splits** — no txn has >1 allocation) |

The aggressive cleanup ran and propagated. Also: `bank_txn_deleted_backup` is **empty (0 rows)** on this desktop despite 3357 tombstones — there is no local recovery copy of anything already deleted. Only **2 distinct HLC node ids** have ever written `bank_txn`, so migration mid-flight risk is small and controllable.

## Two findings that decide the design

**1. Genuine same-day identical twins are real and routine in Jack's data, not hypothetical.** The seven 4-row buckets are all `$25.00 ONLINE DOMESTIC WIRE FEE` and each is **2 real fees + 2 duplicates** (two rows from one `imported_at` run, two from a later run). Two `$25` wire fees on 2026-07-31 share one Plaid `pa` and one sync run — the bank is asserting two wires that day. Same for two `$550.39` United charges on 2026-07-27. A naive content-addressed key collapses 4→1 and **silently destroys real money**. Requirement (b) is load-bearing.

**2. The bank already stamps a globally unique reference into the memo, and nothing in the codebase uses it.** Real memos:

```
ORIG CO NAME:Pirate Ship ... TRACE#:021214899149033 EED:260608 ... PLAID TRN: 1599149033TC
ONLINE DOMESTIC WIRE TRANSFER VIA: WELLS FARGO NA/121000248 ... IMAD: 0709MMQFMP2M023169 TRN: 3422486190ES
Zelle payment to Epilson Wholesale JPM99cjnk2kx
Online Transfer from MMA ...8278 transaction#: 30181777112
```

Extracting `IMAD` / `TRACE#` / `TRN` / Zelle id / `transaction#:` / `DEPOSIT ID NUMBER` / `CHECK #`:

- **576 / 1248 rows (46.2%) carry a reference — but 91.9% of the dollars, and 90%+ of rows over $10k.**
- **Zero collisions**, once scoped by account + direction, over 14 months.
- Globally there are exactly **4** collisions, and all four are the two legs of an internal transfer sharing one `transaction#:` — proof that the ref must be namespaced by `(account, direction)` or the scheme merges a $6,000 out with a $6,000 in and loses a leg.

These references live in the bank descriptor, so they survive a Plaid re-link, an item change, a mask change, and a PDF statement re-import. That is a **true natural key**, not a heuristic.

## Chosen scheme: three-tier deterministic id, computed at one choke point, used as the PRIMARY KEY

```
tier 1 (referenced, authoritative)
  key = account_key | direction | ref_kind | ref_value
  id  = "bt1_" + base32(fnv1a128(key))
  NOTE: date and amount are deliberately NOT in the key, so a
        pending→posted date/amount change cannot re-key the row.

tier 2 (reference-less, deterministic fallback)
  key = account_key | posted_date | direction | amount_cents | memo_norm | ordinal
  id  = "bt2_" + base32(fnv1a128(key))

tier 3 (user-authored: manual cash)
  id  = "btc_" + uuid   (unchanged — no external ledger to converge on)

account_key = plaid persistent_account_id when present,
              else a local bank_account row id resolved by
              (institution, subtype, mask) seeded with the existing alias map.
memo_norm   = lowercase, whitespace-collapsed raw bank `name` (not merchant_name).
ordinal     = lowest integer not occupied by a live row and not in the bucket's
              retired (tombstoned) ordinal set, assigned only after matching
              incoming rows to existing rows.
```

`account_key` matters concretely: Chase depository accounts **do** carry `persistent_account_id` (`81fb134f16…`, `1c703490cd…` — verified in `plaid_items.accounts_json`), but **neither credit card does**, and the Amex mask actually drifted `··1004` → `··2002`. So the card path must resolve through an explicit account row, never the display label.

### Why it satisfies (a), (b), (c)

- **(a) same id everywhere** — the id is a pure function of data every path already has. Plaid sync, statement import, the server importer, and any future mobile write all call the same function and mint the same string, so a second insert is a PK collision. Under this engine a PK collision is *already* the merge path: `apply_upsert` does an exists-check and routes to UPDATE with per-column LWW (`src-tauri/src/sync.rs:620-628`, `clienthub-api/src/sync.rs:1146-1153`). Nothing new has to be built to make convergence work. This also unifies the three id schemes for the first time — today a PDF statement import of an already-synced month produces a **complete parallel ledger** under `bt_` ids alongside the `btpl_` ones (`bank_import.rs:432-444` keys on FITID + label, disjoint from `plaid_txn_id`).
- **(b) twins both survive** — tier 1 gives each twin its own reference where the bank supplies one. Tier 2 gives them distinct ordinals. The 4-row buckets resolve to exactly 2 rows, which is correct; a memo-free key would have collapsed 11 distinct Pirate Ship ACH debits of $19.89 on 2026-06-08 into one bucket (measured), which is why `memo_norm` stays in tier 2.
- **(c) survives re-link / label drift** — tier 1 keys on the bank's reference and a stable account identity, both of which a re-link preserves; Plaid's `transaction_id` is the only thing that changes and it is no longer identity-bearing.

### Does content-addressing + occurrence ordinal actually work? Partly — which is why it is tier 2, not the whole scheme

It **does** hold for the cases the brief asks about:
- *A later sync reveals an additional twin*: incoming rows are matched to existing rows first, so existing twins keep their ordinals and only the new one allocates. Bucket goes 1→2, no churn.
- *Out-of-order arrival*: buckets are day-scoped, so a backfill of an older date is a different bucket entirely. Order only matters among rows that are identical by construction, where it is irrelevant.
- *A full re-pull on a second device*: it replays 0,1,2… over the same bucket and lands on the same ids — collisions, not new rows.

It **breaks** in three specific ways, all of which I'd rather name than paper over:

1. **Ordinal reuse after deletion.** Delete ordinal 0, re-pull, the survivor re-derives ordinal 0, hits the tombstone (`sync.rs:526-531`: tombstone with `hlc >= event.hlc` → skip), and a *real* row vanishes on that device. Fixed by retiring tombstoned ordinals so allocation is monotonic per bucket — at the cost of a narrow window where two devices disagree about the retired set.
2. **Concurrent allocation of the same free ordinal to two different real transactions.** The result is a *merge* — money lost — which is strictly worse than a duplicate. Bounded by making one Plaid item authoritative per account so both devices read the same ordered stream, and eliminated for manual entry by keeping tier 3 opaque.
3. **Any drift in date, amount, or memo re-buckets the row** and mints a second one.

Alternatives rejected: per-item `transaction_id` only (today's scheme — provably fails on re-link); pure content hash with no ordinal (destroys 7 real $25 fees and 3 real airline charges in the current data); post-hoc fuzzy dedupe (what exists now — probabilistic by construction, and Jack has already said it cannot guarantee zero); a UNIQUE index (see below).

## Can a UNIQUE constraint be used? No — and the danger is on push, not pull

**No new UNIQUE index on any synced table.** Concretely:

- Desktop `apply_upsert` inserts with `INSERT OR IGNORE` (`src-tauri/src/sync.rs:635`). A UNIQUE violation returns `Ok(0)`, which hits the branch at `:646-666`: warn, **deliberately skip recording clocks, return `Ok(())`**. The row is silently absent on that device with no error anywhere. Server is identical (`clienthub-api/src/sync.rs:1162`, `:1188`). **A UNIQUE constraint converts a duplicate into an invisible per-device missing row — worse than the duplicate, because a duplicate is visible and fixable.**
- The UPDATE branch is *not* `OR IGNORE` on either side and propagates `Err`. The brief says this "would retry forever and stall the pull cursor" — that is **no longer true on desktop pull**: `netsync.rs:601-646` rewinds to the earliest failing page and dead-letters by event id after `MAX_STUCK_RETRIES = 5`. So it doesn't stall; it *drops*. Dead-lettering a `bank_txn` event is silent per-device data loss.
- The real stall is on the **server push path**, and it is undocumented in the brief: `push_events` (`clienthub-api/src/sync.rs:1551`) only `warn!`s on `Err` and puts the id in neither `applied` nor `rejected`. Per its own contract at `:1522-1525` ("Anything not named in `applied` or `rejected` failed transiently and the pusher must keep it queued"), a *permanent* constraint failure wedges the desktop's push queue head forever.

The one constraint that is safe is the **PRIMARY KEY**, precisely because `apply_upsert`'s exists-check already treats a PK collision as a merge. That is the entire reason this design puts identity in the id rather than in an index.

## Migration: do not rewrite the 1248 existing ids

Rewriting ids would emit ~1248 tombstones + 1248 inserts + 55 reference repoints (50 allocations + 5 `refunds.bank_txn_id`), and a stale second device pushing any edit under an old id with a newer HLC would resurrect it — recreating the exact failure being engineered away. Not worth it for 33 excess rows.

Instead:

1. **Server first**: add `natural_key TEXT NOT NULL DEFAULT ''` to `bank_txn` in `ensure_meta_tables`. Hard ordering requirement — desktop `apply_upsert` drops unknown columns and the server logs `SCHEMA DRIFT` (`clienthub-api/src/sync.rs:1131-1143`) if a device pushes it first. Deliberately **no new synced table**, which sidesteps the `ALLOWED_TABLES` dead-letter trap entirely (`src-tauri/src/sync.rs:483`, `:511` — an unknown table is dead-lettered by every device that hasn't shipped it yet).
2. **Backfill** `natural_key` on all 1248 rows using the same choke-point function, reading only existing columns. No id changes, no rows deleted, no allocations repointed, no tombstones written. Ordinals assigned in a fixed order (`posted_at`, `imported_at`, `id`) so both writing nodes compute identically without coordinating.
3. **New writes**: every path calls one function that computes the key, looks it up, and either merges into the existing row (legacy `btpl_` id included) or inserts under the new deterministic id.
4. **Leave the 33 excess rows alone** until this is live, then resolve them once with the reference matcher — which can *prove* the 2-real / 2-duplicate split that today's content fingerprint provably cannot.

**Is it one-way? No, and it doesn't need to be.** Nothing is destroyed. Rollback is a code revert; `natural_key` becomes inert dead data. The only irreversible acts would be id rewriting and duplicate deletion, and neither is in this plan. Given that `bank_txn_deleted_backup` is empty, keeping the migration non-destructive is not optional.

## Three gaps in the current code that this depends on

- **Plaid's `modified` array is dropped on the floor** by both desktop (`commands.rs:12135` handles `added`, `:12226` handles `removed`, nothing else) and server (`plaid.rs:349`, `:356`). Under the current id scheme a modified transaction never updates; under any content-derived scheme it silently forks into a second row.
- **`pending: true` transactions are not filtered.** Storing pending rows is what generates the `removed` churn that the code already has a long comment about unlinking allocations for. Skipping pending is ~3 lines and removes most of the date/amount mutation class outright — and booking unsettled money is how phantom profit appears in the first place.
- **`pending_transaction_id` and `persistent_account_id` are both fetched and both unused.**

## Residual gap — stated honestly

**Structurally impossible (100%, not probabilistic)** for any row carrying an extractable bank reference, re-observed any number of times, through any feed, on any device, across a re-link, a mask change, or a statement re-import: **46.2% of rows, 91.9% of dollars.**

**Not 100% for:**

1. **Reference-less rows — 53.8% of rows, 8.1% of dollars.** Mostly card spend (Apple Pay, Uber, restaurants, airlines). These fall to tier 2, where the guarantee degrades to "no duplicate unless date, amount, or memo drifts". **The one materially large item in this tier is teller cash: `WITHDRAWAL 05/14 $25,000`, `WITHDRAWAL 05/13 $15,000`, `ATM CASH DEPOSIT $7,300` — the bank supplies no reference for these and never will.** Jack should hear that by name.
2. **Tier-2 rows whose date or amount changes after first sight** without a `removed`/`modified` event. Shrinkable to near zero by skipping pending and handling `modified`; not closable.
3. **Two Plaid items simultaneously bound to one real account** — prevented by the single-binding rule, not by hashing. If binding isn't enforced, tier 1 still dedupes 91.9% of the dollars and tier 2 handles the rest probabilistically.
4. **Manual cash entered on two devices** — tier 3, opaque ids by design. The answer is a "you already entered a $500 cash-in today" confirmation, not an identity trick.
5. **The tier-2 concurrency window** where two devices allocate the same free ordinal to two *different* real transactions. Failure mode is a merge (money lost), not a duplicate — the more dangerous direction, and the reason single-item binding is a requirement rather than an optimisation.

The headline for Jack: **zero duplicates is achievable and structural for 92% of the money and for every wire, ACH and Zelle he books against a deal. For the remaining 8% — coffee, gas, and teller cash — it degrades to "duplicates only if the bank changes the transaction after we saw it", which is far better than today but is not literally zero.** The only way to get literally 100% on that tail is to require a bank reference, which the bank cannot supply for an ATM withdrawal.

Analysis scripts: `C:\Users\Jack\AppData\Local\Temp\claude\C--Users-Jack-Desktop-BUSINESS-APP\54cb738f-c52b-4f17-a520-842ba0c667f9\scratchpad\a1.py` … `a9.py`

---

# APPENDIX — INGESTION & REAL-TIME

## Three corrections to the brief (verified in code, they change the diagnosis)

**1. `plaid_items` is effectively shared already.** The brief says Plaid credentials are per-device. They aren't. `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\netsync.rs:1531` (`push_all_secrets_to_server`) serializes every `plaid_items` row — including the plaintext `access_token` — as `plaid_item_{item_id}` into `/api/org-secrets`, and `materialize_plaid_item` (netsync.rs:1641) INSERTs it into a second desktop's `plaid_items` with `cursor=''`. So a second desktop already re-pulls two years of history for the same item on its own 20-minute timer. Same item ⇒ same `transaction_id` ⇒ same `btpl_` id ⇒ the id check holds, so this is **not** a duplicate source — but it means "the desktop owns Plaid" is already N desktops racing on the same insert, and every admin's machine holds the token in plaintext.

**2. The webhook is already wired and has been 404-ing for months.** `src-tauri/src/plaid.rs:106-108` and `:129-131` set `body["webhook"] = {server}/api/plaid/webhook` on every link. `routes::plaid::router()` is merged at `C:\Users\Jack\Desktop\clienthub-api\src\main.rs:169` in local source but was deliberately never deployed. Every webhook Plaid has fired at the droplet got a 404. Plaid backs off and eventually stops calling a persistently-failing endpoint, so after deploy the existing items will likely need `/item/webhook/update` to re-arm.

**3. Mobile has no financials at all.** `bank_txn` appears nowhere in `www/app.js` (7067 lines); `TAB_PERM` (app.js:700) has no financials tab; `syncNow` (app.js:561) refreshes clients/suppliers/payout-recipients/hub only. Current mobile latency for a bank transaction is not "slow", it's infinite. Most of "real-time on every device" is building the screen, not the transport.

---

## Recommended ownership model: (c) hybrid — Plaid is server-owned, human entry stays local

Not (a) pure server-only, not (b) canonical-id-on-desktop.

**Why not (b).** To make two Plaid items mint one id you must hash content instead of `transaction_id`. Two genuinely-identical same-day charges then collapse into one row — silent data *loss*, which is worse than a duplicate. And the account identity it would hash on is broken at the source: the confirmed live case is one Amex reporting as `··1004` and `··2002`, so neither the label nor Plaid's per-item `account_id` gives a stable key. (b) cannot reach zero. It is strictly weaker than (a)/(c) and I'd push back on it.

**Why not pure (a).** Statement import (`src-tauri/src/bank_import.rs`) reads a PDF off Jack's disk and is keyed on FITID (`stable_id`, bank_import.rs:432) — it is already idempotent and has never produced a duplicate. Uploading statements to the droplet to import them adds a file-transfer path, a parser deploy, and a failure mode, to fix a problem that doesn't exist. Manual cash (`add_cash_transaction`, commands.rs:11042) is a human assertion; a random uuid is the correct id for it.

**The split:**

| Source | Owner after migration | Why |
|---|---|---|
| Plaid | **Server only.** Webhook-driven. Desktop `plaid_sync` stops inserting. | Only source that has ever duplicated; all 1891 live rows are `source_format='plaid'`. One writer, one cursor, one id-minter. |
| Statement import | Desktop | Needs the local file; FITID-idempotent already. |
| Manual cash | Whichever device the human is on | Deliberate act. Add an idempotency key so a mobile double-tap can't create two. |

Server-only for Plaid removes the *two-device* cause. It does **not** remove the *re-link* cause — Plaid re-issues `transaction_id`s when Jack links again. So single-writer alone still isn't zero.

---

## The one thing that actually delivers zero: a database constraint, not a query

Every current guard is code that has to remember to run. Replace them with something SQLite enforces:

- Add `bank_txn.dedup_key TEXT NOT NULL DEFAULT ''`, plus
  `CREATE UNIQUE INDEX ux_bank_txn_dedup ON bank_txn(org_id, dedup_key) WHERE dedup_key != ''`.
- `dedup_key` = `{canonical_account}|{posted_at}|{signed_amount}|{normalized_memo}|{seq}`, where `seq` is `0` for every normal row.
- `canonical_account` comes from a new tiny `bank_account` table mapping each Plaid `account_id` → one canonical account Jack names once. He merges `··1004` and `··2002` onto one row in the UI, once, and the ··mask problem is dead permanently — not probabilistically.
- On a UNIQUE violation, do **not** silently skip (that's how you lose a real second charge). Write the rejected payload to `bank_txn_conflict` and surface one prompt: *"Two identical $47.30 charges on 12 Jun — are both real?"* Yes ⇒ re-insert with `seq=1`. No ⇒ discard.

This is where I'm spending the complexity budget, and it's the only place. It's the difference between Jack's current "i cannot even guarantee there is a zero chance" and an actual guarantee: after this, a duplicate is *impossible to store*, regardless of how many writers, re-links, or old desktop builds exist in the field.

**Cheaper fallback if you want to skip it:** single-writer only, keep the fingerprint guards. Honest residual risk: re-links still produce duplicates whenever the memo or date shifts by one character or day, which is what produced the current 548.

---

## Real-time delivery

**Desktop: change nothing.** `netsync.rs:26` already polls every 20 s and `plaid_sync` already fires `push_now()`. Once the server is the writer, a webhook-imported row is on both desktops within ≤20 s. Adding SSE here would buy ~10 s and cost a transport.

**Mobile: poll, don't stream.** Add `GET /api/bank/txns?since={updated_at}` returning only changed rows, called on screen open, on the existing `#header-sync`/pull-to-refresh, and on a 15 s `setInterval` gated to *"Financials tab is the current tab AND `document.visibilityState === 'visible'`"*. That's ~4 requests/minute from one phone, delta-only, on a droplet that already serves the entire PWA.

I'd argue against SSE explicitly: it needs an axum SSE handler, a per-org broadcast channel, fanout, and reconnect logic — and iOS Safari kills the connection the moment the PWA backgrounds, so you need the polling fallback anyway. For one operator plus a couple of teammates it is strictly more code for strictly worse reliability.

**End-to-end after the change:** bank posts → Plaid fires `SYNC_UPDATES_AVAILABLE` (seconds to a few minutes, Plaid's own cadence — this is the floor and nothing we build changes it) → server imports → desktop ≤20 s, phone ≤15 s. Versus today's ~20.5 minutes to a second desktop and never to a phone.

Optional later, only if the 15 s poll ever costs something: bump an `org_activity.bank_rev` counter on import and piggyback `rev` onto the existing 60 s `pollApprovals` so the phone only fetches when something changed. Not worth building in round 1.

---

## Two devices reviewing the same transaction

**Per-column LWW suffices for `reviewed` — it's already correct.** `review_cols` (`commands.rs:10515`) names only the columns actually supplied, specifically so a category save doesn't re-assert `reviewed` and let a stale device un-book someone else's work. The comment there documents exactly that bug. Two devices both booking converge on `reviewed=1`; one booking and one un-booking is a real human disagreement and last-writer-wins is a defensible answer. No change needed.

**LWW does not help with allocations, and this is your actual split-a-wire problem.** `allocate_bank_txn` (`commands.rs:10564`) reads `SUM(allocations)`, checks it against `txn.amount`, then INSERTs. Two devices splitting the same $50k wire simultaneously both read `allocated=0`, both pass the check, both insert — $60k allocated against $50k. These are two *different rows*, so there is no column to resolve; LWW is structurally the wrong tool. `heal_overallocated` (`commands.rs:10934`) exists, which is evidence this has already happened.

Fix: make **allocate** the one write that is server-authoritative. `POST /api/bank/allocate` does the SUM check and the INSERT in a single server transaction; desktop and mobile both call it and apply the returned row. Everything else stays local-first. Cheaper alternative if you want less change: keep local inserts but reject over-allocation in `apply_pushed_event` (`clienthub-api/src/sync.rs:1484`) and surface the rejection — the loser just finds out ~20 s later. I'd take the server-authoritative version for allocate only, since splitting is the case you named as confusing.

---

## Deleted must never resurrect

There is a **guaranteed** resurrection hole today, not a theoretical one. `sync::is_tombstoned` (`src-tauri/src/sync.rs:477`) is called from exactly one place in the entire desktop: `netsync.rs:1109`, inside `restore_snapshot`. No ingestion path checks it. So the moment Jack runs the "every exact match" cleanup and anything triggers a re-pull — `plaid_resync_all`, a re-link, or a second desktop materializing the item with `cursor=''` — the id check misses (row deleted), the fingerprint check misses (row deleted), and the row re-inserts with a fresh HLC that beats its own tombstone. All 548 come back.

Three changes:

1. **Gate every ingestion insert on `is_tombstoned("bank_txn", &id)`.** One line per writer, using a function that already exists.
2. **Tombstone the `dedup_key`, not just the id.** A re-link mints a *new* id for the same real transaction, so an id-keyed tombstone can't stop it. On delete, also write `(org_id, dedup_key)` into a synced `bank_txn_suppressed` table; the importer skips any incoming txn whose key is suppressed. This is what turns "usually stays deleted" into "cannot come back".
3. **Add `bank_txn_suppressed` to `SNAPSHOT_TABLES`** on both sides (`netsync.rs:38`, `clienthub-api/src/sync.rs:1601`), or a fresh install's first Repair sync inherits the rows without the suppressions and resurrects everything.

---

## Migration path

**Phase 0 — clean first.** Run the existing v0.15.122 "every exact match" cleanup and take a DB backup. Migrate a clean ledger; don't backfill dedup keys over 548 known duplicates.

**Phase 1 — constraint-backed ledger (desktop + server, same migration).** Add `dedup_key` + partial UNIQUE index + `bank_account` canonical mapping (seeded from distinct `account_id` labels, with a merge UI) + `bank_txn_conflict` + `bank_txn_suppressed` + tombstone gates.
*Verify:* run `plaid_resync_all` on the desktop against the real Plaid items. Success = **0 rows imported** and 0 conflicts. That is a hard, checkable criterion, and it proves duplicates are impossible before any server change lands.

**Phase 2 — move Plaid ingestion to the server.** Jack sets `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_TOKEN_KEY` in the droplet's systemd environment himself (I'm not entering credentials). Then deploy `clienthub-api/src/plaid.rs` + `src/routes/plaid.rs` — the previously-forbidden deploy becomes the correct one *because* the next step removes the other writer. Desktop pushes each existing item's token once via the now-live `/api/plaid/items` (`netsync.rs:1664`, has been 404-ing). Call `/item/webhook/update` on every existing item to re-arm webhooks Plaid gave up on. Set `plaid_items.server_owned=1`; desktop skips server-owned items and `plaid_sync` becomes status-reporting only. Remove `plaid_item_*` from the org-secrets bridge so tokens stop cloning to every admin's desktop.
*Ordering is load-bearing:* Phase 1 must land first, because Phase 2 has a window where old desktop builds in the field are still writers — the UNIQUE index is what makes that window safe.
*Verify:* link a test account; row appears on a second desktop within ~20 s without the 20-minute timer firing.

**Phase 3 — mobile.** Financials screen, `?since=` delta endpoint, 15 s foreground poll, server-authoritative `POST /api/bank/allocate`, split flow.

---

## What Jack sees differently

- A transaction shows up on the desktop and the phone within seconds of the bank posting it. He does nothing.
- His phone has a Financials screen at all — a transaction list he can book from, and split a $50k wire across deals from, standing in a warehouse.
- Instead of 548 mystery duplicates, at most a handful of times a year: *"Two identical $47.30 charges on 12 Jun — are both real?"* One tap. Never a silent duplicate, never a silent loss.
- Deleting a transaction sticks — after a re-link, after a Repair sync, after a fresh install.
- Settings → Banks reads "Ecliptr is watching this account", not "Last synced 14 minutes ago".
- **One "Reconnect this bank" button that re-auths the existing item in place** (Plaid update mode) instead of minting a second one. This is the smallest UI change on the list and the one that prevents the entire class of bug from recurring — the current mess exists because "reconnect" meant "link again".

---

## Residual risks, stated plainly

- **The droplet becomes the single ingestion point.** If it's down a day, nothing new appears anywhere. Nothing is *lost* — Plaid's cursor replays on restart — but Jack is blind until it's back. Keep a desktop "Pull from Plaid now" button that calls the *server* endpoint, so there's a manual kick without a second writer.
- **Tokens move to the droplet**, encrypted at rest via `PLAID_TOKEN_KEY` (`crypto::seal`). Net posture is *better* than today, where they sit in plaintext in `plaid_items.access_token` on every admin desktop **and** in org_secrets on the same droplet.
- **Decision for Jack:** removing `plaid_item_*` from the secrets bridge means a teammate's desktop can no longer see Plaid balances locally. Balances would need a server endpoint. Small, but it's a behaviour change he should agree to rather than discover.

---

# APPENDIX — ALLOCATION MODEL

## What the code actually does today

**Schema** (`db.rs:1300-1313`, mirrored at `clienthub-api/src/schema.sql:647`): `bank_allocation(id, org_id, bank_txn_id, deal_flow_id, amount, role, note, created_by, created_at, updated_at)`. Two indexes. No FKs, no uniqueness beyond `id`.

**Write path** — `allocate_bank_txn` (`commands.rs:10562-10641`): reads `(amount, SUM(allocations), direction)`, rejects if the txn is linked to a different deal unless `allow_split`, checks `role` against `direction`, checks `amt <= remaining`, inserts with a uuid id, then `resync_completed_deal` + `push_now`.

**Read paths** — `deal_bank_actuals` (`commands.rs:4360-4390`) and `deal_reconciliation` (`commands.rs:11102+`) both sum by role with `EXISTS(bank_txn)` guards. `free_cash` (`commands.rs:12420-12540`) nets payables/refunds against allocations and INNER-JOINs `deal_flows` so archived deals drop out.

**Other txn links** — `refunds.bank_txn_id` (routes *through* `allocate_bank_txn`, `commands.rs:4621` — correct), `loan.bank_txn_id` + a whole-txn tag on `bank_txn.counterparty_type='loan'` (`commands.rs:12718`), `cash_purchase.withdrawal_txn_id`, `business_expense.bank_txn_id`.

---

## Gaps I verified (these, not the table, are the problem)

**G1 — `business_expense.bank_txn_id` is never written.** It is only *read*, in `bank_txn_is_referenced` (`commands.rs:11362`). No command in the codebase inserts it. So "part of this payment was an expense" has **no representation at all**. Same for `cash_purchase.withdrawal_txn_id` from the Financials side.

**G2 — three different definitions of "needs attention".**
- backend `bank_txn_summary` (`commands.rs:10486-10493`): `direction + category != internal_transfer + SUM < amount - 0.01`. Ignores `reviewed`, ignores loan tags.
- desktop `needsDeal` (`FinancialsView.tsx:1117`): `!reviewed && counterparty_type != 'loan' && category != 'internal_transfer' && unallocated > 0.0001`.
- `stale_unallocated` in free-cash (`commands.rs:12519`): money-in, >7 days old, `SUM < amount - 0.01`.

A $50k receipt split $30k to a deal and $20k owner draw is **permanently stuck** in two of those three counters. That is literally Jack's "confusing" case.

**G3 — `allocate_bank_txn` never validates `deal_flow_id` exists.** `tag_bank_txn_to_loan` validates the loan (`commands.rs:12722`); the allocator does not. `cleanup_orphan_allocations` only cleans allocations whose *bank_txn* is gone (`commands.rs:10672`), never whose *deal* is gone.

**G4 — loan tags don't consume allocation capacity.** `unallocated_bank_txns` filters only on `category != 'internal_transfer'` (`commands.rs:11000`), and a loan tag sets `category='loan_received'`. So a $15k loan drawdown appears at **full value** in the deal-side buyer-payment picker (`ReconciliationPanel.tsx:73`) and can be booked as revenue on top of being a liability.

**G5 — roles `fee` and `adjustment` are unreachable from Financials.** `rolesFor` (`FinancialsView.tsx:156-158`) offers only 2 of the 5. But `deal_bank_actuals` counts `fee` into cost and `ReconciliationPanel` has a whole `fee` leg. Wire fees can only be booked from the deal side.

**G6 — underpayment silently rewrites a completed deal's revenue.** `deal_bank_actuals:4386`: `let rev = if has_rev_link { buyer } else { manual_gross }`. One partial payment linked → `has_rev_link` is true → gross_revenue is overwritten with the *partial*, and `net_profit`/payouts recomputed from it. The shortfall machinery exists (`deal_reconciliation` returns `invoice_total`, `fully_reconciled`) but the function that *writes the books* doesn't use it. This is the single most damaging finding in Task 3.

**G7 — concurrent double-book is healed destructively.** No transaction around read-then-insert; two devices each pass their own check, sync merges both, `heal_overallocated_txns` (`commands.rs:10940`) trims by `ORDER BY created_at DESC` — it deletes whichever leg was created last, which may be the correct one and not the duplicate.

**G8 — the mobile PWA has no financials UI whatsoever.** `grep -i bank www/app.js` → one hit, a placeholder string. Zero of the 23 screens is Financials. "Any device able to book in real time" is currently 0% built.

---

## Data-model delta

**`bank_allocation` already suffices. Recommend zero schema change.** Three behavioural changes to the same table:

**D1 — allow `deal_flow_id = ''` and widen the `role` vocabulary.** A leg becomes "this many dollars of this transaction were *this kind of thing*", where a deal is one kind among several. New roles, all with empty `deal_flow_id`: `owner_draw`, `expense`, `unassigned`. Plus expose the existing `fee` and `adjustment` in the Financials UI.

I audited every consumer: `deal_bank_actuals`, `deal_reconciliation`, `bank_snapshot_value`, `supplier_payables`, `refund_liability`, `refund_status_all` all filter `WHERE a.deal_flow_id = ?1` — empty never matches. `alloc_role_sum` (free-cash) and `reattach_orphaned_deal_allocations` use `JOIN deal_flows` — INNER, empty excluded. `heal_overallocated_txns` keys on `bank_txn_id` only, so non-deal legs correctly count toward the SUM ceiling. **Nothing needs editing.** Only `list_bank_allocations_for_txn` (LEFT JOIN, `commands.rs:10760`) needs a label for the blank-deal case.

**D2 — deterministic allocation id.** Replace `format!("alloc_{}", Uuid::new_v4())` with `alloc_{fnv1a(bank_txn_id | deal_flow_id | role | amount_cents)}`. Same leg booked twice — double-tap, retry, two devices — becomes the same id, so the oplog upserts instead of duplicating. This is the allocation-side answer to "zero chance of duplicates" and it is one function. Tradeoff below.

**D3 — one derived state, computed identically everywhere.** `remaining(T) = T.amount − SUM(allocations)`. `remaining > 0.01` = unbooked; else booked. Delete the other two definitions (G2). `reviewed` stays as-is (stale devices read it) but stops driving any counter.

**Explicitly rejected as speculative:** a `status` column on `bank_allocation` (state is derivable), a `parked_until` column (an `unassigned` leg parks money *with an amount*, which a flag can't), a separate non-deal-allocation table (single-use abstraction).

---

## Invariants

| # | Invariant | Today |
|---|---|---|
| I1 | `SUM(alloc WHERE bank_txn_id=T) <= T.amount + 0.01` | local only; broken cross-device, healed destructively (G7) |
| I2 | `alloc.amount > 0` | held |
| I3 | Every allocation references a live `bank_txn` | held (EXISTS guards + oplog cascade in `clear_bank_txns`) |
| I4 | `deal_flow_id != ''` ⇒ that `deal_flows` row exists | **not enforced** (G3) |
| I5 | `role` ∈ set valid for the txn's direction | enforced at write, **not re-checked on sync apply** |
| I6 | A txn is loan-tagged XOR allocated, never both | **not enforced** (G4) |
| I7 | Deleting a txn deletes its allocations *through the oplog* | held |
| I8 | Deal actuals count only allocations with a live txn and a non-archived deal | held |
| I9 | One definition of "unbooked", used by desktop, backend summary, free-cash, mobile | **broken** (G2) |
| I10 | Every heal/cleanup is idempotent and can never lower a completed deal's recorded profit | held (`resync_completed_deal`'s fail-proof fallback) |
| I11 | Booking the same leg twice yields one allocation | **not held** — D2 fixes it |
| I12 | A deal's revenue is bank-derived only when collected ≥ expected − tolerance | **not held** (G6) |

I1 needs the fix to be non-destructive: when the merged SUM exceeds the amount, don't delete — mark the txn *contested* and show both legs with who booked each (`created_by` is already populated). A human resolves it. Silently deleting someone's booking is worse than showing a conflict.

---

## The workflow

**One screen, one primitive: the money bar.** A transaction is a bar the width of its amount. Each allocation is a labelled segment. The unfilled tail is `remaining`, with the number on it. Tapping the tail opens a new leg **pre-filled with the exact remaining amount**. You never type the whole figure — you type the deal's slice, and the bar shows you what's left. That is the entire answer to "a huge transaction where I allocate a certain amount to the deal".

**Queue.** Default view = `remaining > 0.01`, sorted money-in first, then amount desc, then oldest. Money-in unbooked is the risky bucket; it leads. Booked rows collapse into a "Booked" tab. Counter = the count of that same query — nothing else.

**Adding a leg (phone, 3 taps).** Row → sheet. Amount field pre-filled with remaining, numeric keypad. Destination picker ranked: exact-amount match → payer-name match (`dealMatchesTxn` at `FinancialsView.tsx:115` already does this) → open deals awaiting payment → recency. Then the non-deal chips: *Owner draw · Expense · Fee · Refund · Not sure yet*. When there are zero legs, one big **"All of it → {top-ranked deal}"** button books the whole thing in a single tap.

**Correcting.** Legs are delete + re-add, never edit-in-place — that keeps `remove_bank_allocation`'s `resync_completed_deal` and D2's deterministic id both correct. Long-press a segment → change amount / change deal / remove. 10-second undo toast.

### Scenarios

**One payment → multiple deals.** Open $50k receipt. Tail is $50k. Leg 1: $30k → deal A. Tail is $20k. Leg 2: $20k → deal B. Bar full, row leaves the queue. *Change from today:* the `allow_split` checkbox (`FinancialsView.tsx:2718`) disappears — splitting is what the bar does, so there's no mode to remember to turn on first.

**One deal ← multiple payments.** Already works (the exclusivity guard is per-txn, not per-deal). What's missing is the readout: the deal shows **"Collected $30,000 of $50,000 — short $20,000"**. `deal_reconciliation` already returns `invoice_total` and `fully_reconciled`; surface it on the transaction side and in the deal-picker rows, so when the balance payment arrives the right deal is visibly the one that's short.

**Part deal, part something else.** $50k receipt: $30k → deal A, $15k → owner draw, $5k → fee. Three legs, bar full, row leaves the queue. Today the last $20k is unrepresentable and the row is stuck forever (G1 + G2).

**Overpayment.** Leg amount exceeds the deal's outstanding → inline warning "$2,000 more than this deal is owed", with three choices: book it anyway and show the deal as *over by $2,000*; put the excess on the client as a credit (`client_credits` already exists and syncs); or book the excess as `adjustment`. Never silently accept.

**Underpayment.** Deal shows *short*. And per **I12**: `deal_bank_actuals` keeps the recorded revenue and flags the shortfall rather than overwriting gross_revenue with the partial. This is a behaviour change to a load-bearing function — flagged as a decision below.

**Purpose unknown.** Two honest states, and the difference matters. Leave it alone → stays in the queue, correct, because you genuinely haven't decided. Or add an `unassigned` leg for the amount → the row leaves the queue and the money appears in an **"Unassigned money — $X across N transactions"** list with its own total. That is the real "park it": the dollars are accounted for as *deliberately undecided* rather than hiding behind a `reviewed` flag.

### Mobile

Server needs `GET /api/bank/txns` (with `remaining`), `GET /api/bank/txns/:id/allocations`, `POST /api/bank/allocations`, `DELETE /api/bank/allocations/:id`. **Hard constraint:** these must write through the oplog path, not raw INSERT — the standing parity finding is that mobile REST writes bypass the oplog, and an allocation that doesn't reach the oplog is money that exists on one device only. `push_now()` on write plus the existing netsync poll and the `#header-sync syncNow` control is sufficient for "real time" here; no websockets.

---

## Decisions I need from Jack

1. **D2 deterministic ids** collapse two *genuinely distinct* legs with identical (txn, deal, role, amount) into one. On the same transaction and deal that is almost certainly a double-entry — but confirm. Escape hatch if not: keep uuids and add a "you already booked $X to this deal from this transaction — add another?" confirm.
2. **I12 / G6** changes how a completed deal's `gross_revenue` is derived when only part of the invoice has been collected. It is the correct behaviour, but it is a live change to the numbers on existing partially-paid deals.
3. **G4**: make loan tag and allocation mutually exclusive (surgical, guard both directions), or convert loan legs into allocations with `deal_flow_id=''` (cleaner, but `loan_ledger` reads `bank_txn` tags and would have to move — not surgical).
4. **I1 contested state** instead of destructive healing — do you want to be shown conflicts, or keep the silent trim?

---

## Success criteria

1. `SELECT bt.id FROM bank_txn bt JOIN bank_allocation a ON a.bank_txn_id=bt.id GROUP BY bt.id HAVING SUM(a.amount) > bt.amount + 0.01` → 0 rows after a two-device concurrent-booking test.
2. `SELECT COUNT(*) FROM bank_allocation WHERE deal_flow_id != '' AND NOT EXISTS (SELECT 1 FROM deal_flows d WHERE d.id = deal_flow_id)` → 0.
3. Book the same leg from desktop and phone within one sync window → exactly one `bank_allocation` row.
4. Backend `unallocated_in + unallocated_out`, desktop `needsDeal`, and the mobile badge return the identical number for the same filter.
5. $50k split $30k/$15k/$5k across deal + owner draw + fee → row disappears from the queue, `stale_unallocated` drops by 1, deal A's `gross_revenue` = $30,000 and it reads "short $20,000" against a $50k invoice.
6. Delete that transaction → all three allocations gone via the oplog on every device, both deals resynced, `cleanup_orphan_allocations` returns 0.
7. Phone: unbooked receipt → correct deal, fully booked, in 3 taps; visible on desktop inside one sync interval.

**Files:** `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\commands.rs` (allocator 10562-10641, `deal_bank_actuals` 4360-4390, `bank_txn_summary` 10473-10500, `heal_overallocated_txns` 10940-10975, `unallocated_bank_txns` 10985-11035, `deal_reconciliation` 11102+, free-cash 12420-12540, loan tag 12718-12766) · `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\db.rs` (1300-1313) · `C:\Users\Jack\Desktop\BUSINESS APP\src\components\FinancialsView.tsx` (roles 85-91, `rolesFor` 156, `needsDeal` 1117, alloc panel 2560-2790) · `C:\Users\Jack\Desktop\BUSINESS APP\src\components\ReconciliationPanel.tsx` · `C:\Users\Jack\Desktop\clienthub-api\src\routes\deal_flows.rs` (361-400) · `C:\Users\Jack\Desktop\clienthub-api\www\app.js` (no financials screen).

---

# APPENDIX — UI REDESIGN

# Financials UI — design spec (desktop + mobile)

Files read: `C:\Users\Jack\Desktop\BUSINESS APP\src\components\FinancialsView.tsx` (2965 lines), `FreeCashView.tsx`, `LoansView.tsx`, `C:\Users\Jack\Desktop\clienthub-api\www\app.js`, `www\index.html`, `www\style.css`, `src\lib\api.ts` (BankTxn/BankAllocation shapes).

---

## PART 1 — Why it reads badly (concrete)

### 1.1 The daily job is at the bottom of the page

On the Transactions tab, everything above the actual list is setup, import, or cleanup. Order as rendered:

```
FinancialsView.tsx:1394  tab === "transactions" opens
  1397–1457  toolbar: Clean up duplicates | Remove statement imports | Auto-categorize
             with AI | Account [text input] | Import statement | Smart import (AI) | Record cash
  1635–1639  paragraph explaining per-card account naming
  1643–1908  Bank feed (Plaid) card: environment select, Client ID, Secret (password),
             Save keys, Test connection, Connect a bank, item list
  1911–1965  statement import preview card
  1968–2022  AI import preview card
  2025–2034  six-figure summary strip
  2037–2131  To-do/Booked + search + in/out + split + account + category + status + date-from + date-to
  2134–2183  up to 3 grouping suggestion rows
  2186–2248  bulk action bar
  2250       ← the transactions finally start here
```

That is ~850 lines of chrome above the work. Connecting a bank is a once-ever act; booking a wire is a daily act. The once-ever act owns the top of the screen and a permanently-mounted card with a password field in it.

### 1.2 "Account" means two opposite things, 650 lines apart

`1429–1436` is a free-text `Account` input that sets the *destination* for the next import. `2085–2096` is an `All accounts` select that *filters* the list. Same word, one is a write, one is a read, and the write one sits inside the row of buttons where a filter would live.

### 1.3 The row spends its width on constants and whispers the variable

`renderTxnTable` (`1168–1352`): a `min-w-[860px]` table with 9 columns — checkbox, direction arrow, date, payee, category `<select>`, account, amount, deal, book. Problems:

- **Account is on every row** (`1281`) as a display label like `Blue Business Cash(TM) ··1004`. It's near-constant down the column and it is a large part of why the table needs 860px and horizontal scroll inside a 216px-sidebar layout.
- **The deal cell is the whole point of the screen and it is the quietest thing on the row.** `dealCell` (`1153–1160`) renders `Linked` / `Link a deal` / `$12,000 of $47,000` in `text-muted` at 12px. The one genuinely actionable state, `match`, is lowercase (`1158`) where the rest of the app is sentence case — it reads as a typo, not an affordance.
- **The ranking work is already done and thrown away.** `filteredDeals` (`1127–1141`) scores deals +100 for a payer-name hit and +60 for an exact amount match. That result — "this wire is almost certainly INV-2026-0041" — surfaces in the list as the five-letter word `match`.

### 1.4 Colour is spent on direction, so nothing is left for state

Direction is encoded three times: arrow glyph (`1228–1232`), signed amount coloured `text-success-ink`/`text-danger-ink` (`1282–1284`), and the in/out filter. With 1891 rows, *every* row is green or red. Colour therefore carries no information and cannot be used to say "this one needs you".

### 1.5 Five hit targets per row, one of them invisible on touch

Per row: row `onClick` (`1214`), checkbox (`1220`), category `<select>` (`1264`), book button (`1287`), and a rename pencil at `opacity-0` until hover (`1240–1255`). Three of them need `stopPropagation`. The pencil doesn't exist on a phone, and it opens `window.prompt()` (`1243`) with a two-sentence message — a browser dialog in an otherwise designed app, for a fix (Plaid mislabelling payees) that happens constantly.

### 1.6 Allocation is a 12-column form inside a `<td colSpan={9}>`

`1301–1342` expands a `<tr>` and mounts `AllocationPanel` inside it. Consequences:

- The panel inherits the table's `min-w-[860px]` inside `overflow-x-auto` — **you can horizontally scroll the allocation form away from the transaction it belongs to.**
- Expanding shoves every row below it down, so whatever you were comparing against moves.
- Panel state lives in the parent (`307–318`: `dealQuery`, `amountStr`, `role`, `selectedDeal`, `allowSplit`). Open row A, type an amount, close it, open row B — the form is pre-loaded with row A's context.

### 1.7 The split — the thing Jack called out — is a checkbox and a sentence

`2717–2728`:

```
[ ] Split this payment across multiple deals
    ↳ when checked, reveals: "Enter a partial amount, pick a deal + role,
      Allocate — repeat for each deal."          (11.5px muted)
      Unallocated $35,000.00 of $47,000.00       (11.5px muted, end of the same line)
```

The hardest and most error-prone task in the product — one $47,000 wire covering three deals — is instructions for a manual loop. There is no running ledger of the cuts you just made, no "allocate the rest", no arithmetic (nothing computes 47,000 − 12,000 − 20,000), no sight of the deals' invoice totals while you type amounts against them, and no completion event. And the amount field itself (`2690–2697`) is a bare `<input type="number" placeholder="Amount">` at `col-span-2` — the most consequential number in the flow is the smallest, unlabelled field on the line, with browser spinner arrows.

### 1.8 Progress isn't progress

`2025–2034` is six figures in one 12px muted line with no hierarchy: Transactions, Reviewed n/m, Money in, Money out, Uncategorized, Needs a deal. Only two of those are progress. Worse, the queue tabs (`2039–2050`) count `reviewed`, while `needsDeal` (`1117`) counts unallocated — so the tab count and the "Needs a deal" figure disagree by construction, and the user has no way to know which is the real backlog.

### 1.9 Empty, loading and error states

- Empty (`2255–2265`): icon-in-a-circle, "No transactions yet", primary action **Import statement** — but this account runs on a bank feed. It points at the wrong door.
- Filtered-empty (`1348–1350`): a 12px muted line inside the table with no way to clear the filters that caused it.
- Loading (`2251–2254`): a centred spinner, so the page height collapses and jumps on every refresh.
- Errors: `toast(String(e))` (e.g. `1012`) — a raw Rust error string in a toast, with the form left in its old state and nothing inline to anchor the failure to.

### 1.10 Maintenance is the loudest control on the screen

"Clean up duplicates" (`1401–1408`) is `mr-auto` + accent border + accent fill + semibold — visually the most prominent control on the transactions screen is a workaround for a data bug. Next to it, "Remove statement imports" is a destructive action one pixel-class away from it.

### 1.11 Two live violations of the standing design rules

```
FinancialsView.tsx:1532   uppercase tracking-wide   "Will remove (sample)"
FinancialsView.tsx:1555   uppercase tracking-wide   "Needs your review — not removed"
```

Both are uppercase kickers inside the dedupe modal. They go, regardless of the rest of this redesign.

### 1.12 Mobile has no financials surface at all

`www/app.js` `render()` (`758–787`) has no `financials`/`bank`/`transactions` case. `renderMore()`'s **Money** group (`1174–1179`) contains only receivables, payables, payouts. So "any device able to load transactions in real time so he can book them" is currently 0% built on the device he is most likely holding when a wire lands.

### 1.13 The one part that already works

`FreeCashView.tsx` (`183–248`) is the best financial surface in the codebase: one 34px number with no card around it, a hairline breakdown table, a 1.5px progress rule, alerts only when present. **The Transactions screen should be rebuilt to look like Free cash — not the reverse.** Everything below inherits its discipline: hairlines instead of cards, one number that matters, no shadows.

---

## PART 2 — The new design

### 2.0 The job, stated once

> Money arrived. What is it, and which deal does it belong to?

Everything that does not directly answer that leaves the working screen.

### 2.1 Screen hierarchy — four surfaces, not one tab with everything in it

Rename the nav item **Financials → Money**. Four sub-surfaces, underline tabs, same style as today (`1373–1389`):

| Surface | Contains | Nature |
|---|---|---|
| **To book** (default) | Only unbooked transactions. Nothing else. | A pile that empties |
| **Ledger** | Everything ever, searchable, filterable, booked history, per-deal drill | A reference |
| **Cash** | Existing `FreeCashView` + `LoansView` below it | A dashboard |
| **Setup** | Bank connections, keys, import statement, smart import, record cash, auto-tag rules, duplicate cleanup, Google Sheet backup, remove statement imports | A drawer you visit twice a year |

Every control catalogued in §1.1 that isn't a filter moves to **Setup**. The only thing the To-book header may carry is a text link — `Setup` — at 12px muted, right-aligned, no border, no icon.

Rationale: the current single tab makes Jack re-scroll past a Plaid secret field every time a wire lands. Four surfaces means the daily one starts at pixel row zero.

### 2.2 The To-book screen — desktop

```
┌ 216px sidebar ┬────────────────────────────────────────────────┬─ 420px ─┐
│               │ Money                              Setup       │         │
│               │ 18 to book · $312,400 waiting on a deal        │         │
│               │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │  detail │
│               │                                                │  panel  │
│               │ To book  Needs a deal  All accounts ▾  Aug ▾  ⌕│  (docked│
│               │ ─────────────────────────────────────────────  │   only  │
│               │ Today                                          │   when  │
│               │ ▍ Delta Wholesale LLC              +$47,000.00 │    a    │
│               │   Needs a deal · Chase ··4021                  │   row   │
│               │   ┌ Looks like INV-2026-0041 · Costco pallets ┐│   is    │
│               │   └ exact amount match          [ Tie it ]    ┘│  open)  │
│               │ ─────────────────────────────────────────────  │         │
│               │ ▍ Amazon                            −$1,204.11 │         │
│               │   Needs a category · Amex ··1004               │         │
│               │ ─────────────────────────────────────────────  │         │
│               │ Yesterday                                      │         │
│               │ ▎ Hernandez Liquidation             +$62,000.00│         │
│               │   $27,000 of $62,000 tied to 2 deals           │         │
│               │ ─────────────────────────────────────────────  │         │
└───────────────┴────────────────────────────────────────────────┴─────────┘
```

**Header.** `Money` at 19/600, −0.01em, ink. The subtitle line at `1365` ("Import statements, classify money…") is deleted — it describes plumbing. In its place, one honest progress line at 13/400 muted: `18 to book · $312,400 waiting on a deal`. Under it a 2px full-width rule, `bg-surface-3`, with a `bg-ink-2` fill at `booked / total` for the current month, 130ms transition. That rule is the only progress indicator on the screen; the six-figure strip at `2025–2034` is deleted (its contents live in **Ledger**).

**Filters — exactly what Jack named, as text toggles, no `<select>`s in the working row:**

```
To book   Needs a deal   All accounts ▾   August 2026 ▾           ⌕ search
 (on)      (off)          (popover)        (month stepper)
```

- `To book` / `Needs a deal` are the two real backlogs, and stating both explicitly ends the tab-count-vs-figure contradiction of §1.8. Active = ink/600, inactive = muted/400. No pills, no borders.
- `All accounts` is a popover listing the distinct `account_id` values with a count each — not a native select, so the display labels (`Blue Business Cash(TM) ··1004`) can wrap and be truncated sensibly.
- Month is a stepper `‹ August 2026 ›` with `All time` at the end of the popover. This replaces the two raw `<input type="date">` controls (`2115–2129`).
- Deleted: category select, status select, in/out toggle, Split in/out mode. Direction becomes a two-item option inside the search field's own scope chip, because filtering by direction is a Ledger job, not a booking job. Split in/out moves to Ledger as a view mode.

**The row.** One tap target for the whole row (opens the panel), plus at most one inline button. 56px min height, 12px vertical padding, 16px horizontal gutter, `border-b border-line-2`, hover `bg-surface-2` at 130ms.

```
▍  Delta Wholesale LLC                                  +$47,000.00
   Needs a deal · Chase ··4021
```

- **State rail**, 2px, full row height, no radius, left edge: `accent` = needs a deal; `accent/40` = partly allocated; transparent = tied but not yet booked. This is where colour goes now.
- **Payee**, 14/600, −0.005em, ink. Falls back to `description`. If the payee was renamed it shows the renamed value with the raw memo on the subline.
- **Subline**, 12/400 muted, 3px gap. It states *what this row needs*, not what it is: `Needs a deal` / `Needs a category` / `$27,000 of $62,000 tied to 2 deals` / `Tied to INV-2026-0041`. Then ` · ` account label ` · ` time when `posted_dt` exists.
- **Amount**, right-aligned, 15/600, tabular, −0.018em, **ink — not green, not red.** Sign carries direction: `+$47,000.00` / `−$1,204.11`. This is the same numeric spec as `www/style.css:2224` `.list-amount`, so the two platforms share one number system.
- **Day dividers** replace the date column: `Today` / `Yesterday` / `Mon 28 Jul` at 11.5/500 muted, 20px above, 8px below.
- Removed from the row: account column, category `<select>`, date column, permanent checkbox column, separate book button, hover-only pencil.

**Selection** is a mode, not a column. `Select` text button at the right of the filter row → checkboxes slide in at 130ms and the bulk bar (`2186–2248`, keep as-is, it's fine) appears. ⌘/shift-click also works without entering the mode.

**The match chip — the single biggest win available.** When `dealMatchesTxn` fires, the row grows a second line:

```
   ┌────────────────────────────────────────────────────────┐
   │ Looks like INV-2026-0041 · Costco pallets              │
   │ exact amount match, same buyer            [ Tie it ]   │
   └────────────────────────────────────────────────────────┘
```

Inset 1px `border-line-2`, `bg-surface-2/40`, radius 8, 8px inset from the row's text column. Deal name 12.5/600 ink, reason 11/400 muted. `Tie it` is a 28px-high text-weight accent button. One click: allocate the full amount, mark reviewed, row leaves the queue. The scoring at `1127–1141` already exists; this just gives its output a body.

**Rename payee** moves from `window.prompt` into the detail panel as a proper labelled field, plus a keyboard shortcut (`R`) on the focused row.

### 2.3 The allocation panel — desktop

Docked right, 420px, `border-l border-line`, its own scroll, sticky head and sticky foot. It does **not** expand a table row and it does not push the list — the list narrows to 644px at 1280px viewport (1280 − 216 sidebar − 420 panel), which the 3-zone row fits without horizontal scroll. Per the desktop responsive rule, verify by rendering at 1280 and 1440.

```
┌──────────────────────────────────────────┐  sticky
│  +$47,000.00                          ✕  │
│  Delta Wholesale LLC                     │
│  3 Aug 2026 · Chase ··4021 · wire        │
│                                          │
│  ███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  $35,000.00 left to allocate             │
├──────────────────────────────────────────┤  scroll
│  Where it goes                           │
│                                          │
│  INV-2026-0041 · Costco pallets       ✕  │
│  Buyer payment                $12,000.00 │
│  ──────────────────────────────────────  │
│  Choose a deal…                          │
│  Buyer payment ▾              [        ] │
│         Rest $35,000 · Balance $20,000   │
│                                          │
│  + Add another deal                      │
│                                          │
│  Note (optional)          [            ] │
│  New deal from this transaction          │
├──────────────────────────────────────────┤  sticky
│  $35,000 left            [  Allocate  ]  │
└──────────────────────────────────────────┘
```

**The bar is the centrepiece.** 6px tall, radius 3, `bg-surface-3` track. Each committed or drafted allocation is a segment in `ink-2`, separated by 2px of track, filling left to right; the remainder is unfilled. It animates 130ms as you type. Under it, one line, 13/500: `$35,000.00 left to allocate`, going to `Fully allocated` in `success-ink` at zero.

**Explicitly rejected: dragging the bar to split.** It demos beautifully and is unusable for exact amounts — every allocation here has to match an invoice to the cent. The bar is display-only; the numbers are typed or chipped. This is the "outside the box" idea that should not be built.

**Allocation lines are a list you assemble, then commit once.** Each line: deal picker, role select, amount. Beneath the focused amount field, two text affordances at 11.5/400:

- `Rest $35,000` — fills the remainder.
- `Balance $20,000` — fills the chosen deal's outstanding invoice balance, shown only when the deal has one.

The **last line auto-fills with the remainder** the moment you pick a deal, so the common two-way split needs zero typing. Picking a deal whose open balance equals the remainder shows `matches the open balance on INV-2026-0041` in `success-ink` at 11.5/400.

**Over-allocation is stopped at the field**, never in a toast: the field border goes `warning`, the bar's overflow segment renders as a hatched `warning` cap, and the line reads `That's $2,000 more than the transaction`. `Allocate` disables.

**One commit.** All lines post together. The footer button reads `Allocate` while a remainder exists, and `Allocate and book` when it is zero — a full allocation and marking-reviewed are one act, which removes the current final step and stops the queue filling with fully-tied-but-unbooked rows.

**Deal picker** keeps the ranked list from `1127–1141` but each option earns its row: deal name 12.5/600, then `client · INV-… · $invoice_total · $outstanding open` at 11/400 muted, with matches carrying a hairline `accent` left rail rather than the current accent text.

**Loans and expenses** stay, demoted: a single line under the allocation list — `Not a deal? Tag to a loan · Mark as expense`. Loan tagging opens the same picker shape. The three-way `Deal / Loan / Expense / income` button group at `2646–2658` is deleted; deal is the case 95% of the time and the other two shouldn't cost a click before it.

### 2.4 The To-book screen — mobile

Net-new surface in `www/app.js`. Reuse the existing primitives: `.list-item` geometry, `segToggleHTML`, `.modal` bottom sheet with the `::before` grabber, `retryBlock`.

**Entry points — two, no nav churn.** (a) `More → Money → To book`, placed first in that group (`app.js:1174`). (b) A dashboard card at the top of `renderDashboard()` whenever the count is non-zero:

```
┌──────────────────────────────────────────┐
│  6 transactions to book                ›│
│  $312,400 waiting on a deal              │
└──────────────────────────────────────────┘
```

That card is the real-time entry point Jack asked for and it costs no change to the 5-tab bar.

**Screen:**

```
┌──────────────────────────────────┐
│  Money                        ⟳  │   header
│  6 to book · $312,400            │
│  ▔▔▔▔▔▔▔▔▔▔▔▔░░░░░░░░░░░░░░░░░░  │
├──────────────────────────────────┤
│ [ To book ][ Needs a deal ][ All ]   ar-seg
│  All accounts ▾   August ▾        │
├──────────────────────────────────┤
│ Today                             │
│▍Delta Wholesale LLC   +$47,000.00 │
│ Needs a deal · Chase ··4021       │
│ ┌──────────────────────────────┐  │
│ │ INV-2026-0041 · Costco       │  │
│ │ exact match        [Tie it]  │  │
│ └──────────────────────────────┘  │
│──────────────────────────────────│
│▍Amazon                −$1,204.11 │
│ Needs a category · Amex ··1004    │
└──────────────────────────────────┘
```

Same row anatomy, same rail, same sign-carries-direction rule. `.list-name` 14.5/640, `.list-sub` 12, `.list-amount` 15/680 tabular — all already in `style.css`.

**Pull-to-refresh** on this screen calls the existing `syncNow`, so "load transactions in real time" is a gesture, not a hunt for the header sync button.

### 2.5 The split on a phone — precise spec

This is the interaction to get right. Tapping a row opens a sheet at 92vh with the standard grabber.

```
┌──────────────────────────────────┐
│              ▁▁▁▁                │  grabber
│  +$47,000.00                     │  sticky head — never scrolls
│  Delta Wholesale LLC             │
│  3 Aug · Chase ··4021            │
│  ███████████░░░░░░░░░░░░░░░░░░   │
│  $35,000 left                    │
├──────────────────────────────────┤
│  Where it goes                   │  scrolls
│                                  │
│  INV-2026-0041 · Costco     ✕    │
│  Buyer payment      $12,000.00   │
│  ────────────────────────────    │
│                                  │
│  ＋ Add a deal                    │
│                                  │
│  Not a deal? Loan · Expense      │
├──────────────────────────────────┤
│  $35,000 left    [   Allocate  ] │  sticky foot, above safe-bottom
└──────────────────────────────────┘
```

**Head never scrolls.** The amount and the bar are what you are cutting; they stay pinned. This is the single rule that makes a phone split survivable.

**Deal picking is a push, not a dropdown.** A dropdown inside a bottom sheet is the classic phone failure — the list gets 120px and the keyboard eats it. Instead, `＋ Add a deal` slides the sheet's *content* left at 130ms to a full-height search list with a back chevron:

```
│  ‹  Choose a deal                │
│  ⌕ search                        │
│  ─────────────────────────────   │
│ ▍INV-2026-0041 · Costco pallets  │  ← matches carry the rail
│  Delta Wholesale · $47,000 · open│
│  ─────────────────────────────   │
│  INV-2026-0038 · Mixed apparel   │
│  Hernandez · $20,000 · $20,000 open│
```

Picking one slides back and adds the line with the **remainder pre-filled**.

**Amount entry — chips above the keyboard, so the common case is typed zero times.** Tapping an amount field raises `inputmode="decimal"` and pins a one-row chip strip directly above the keyboard:

```
┌──────────────────────────────────┐
│ [ Rest $35,000 ][ Balance $20,000 ][ Half ] │
├──────────────────────────────────┤
│            keyboard              │
```

`Rest` is always present. `Balance` appears only when the chosen deal has an outstanding invoice amount. `Half` is there for the genuinely-split-down-the-middle case. Three-way split of a wire = pick deal, tap `Balance`, `＋ Add a deal`, pick, tap `Balance`, `＋`, pick, tap `Rest`, `Allocate` — **six taps and one commit, no digits typed.**

**Footer button** mirrors desktop: `Allocate` → `Allocate and book` at zero remainder. Disabled with the reason inline, never a toast: `Pick a deal for the last line`.

**Over-allocation:** field border `--c-error`, bar cap hatched, line reads `That's $2,000 more than the transaction`, button disabled.

### 2.6 Progress and completion feedback

- **During:** the bar is the feedback. No spinners inside the sheet; the commit button shows its own inline spinner and the sheet stays put.
- **On commit:** the sheet closes at 130ms, the row collapses out of the list at 130ms, and a single-line strip replaces it for 6 seconds — `Tied $47,000 to 3 deals · Undo` — at 12.5/400 with a `line-2` hairline. One strip, in place, that replaces itself. Not stacking toasts.
- **Header count decrements immediately** and the rule advances. That decrement is the reward; it must be instant and optimistic, reconciled on the next sync.
- **Streak line, once per session,** when the queue empties: see below.

### 2.7 Empty, first-run, loading, error

**First run (no bank connected, no rows):** centred block, max 380px, no icon-in-a-circle.

```
Connect your bank
Transactions land here automatically, ready to tie to deals.

[ Connect a bank ]
or import a statement
```

Heading 17/600 ink, body 13/400 muted, primary accent button, secondary as a plain text link. The current empty state (`2255–2265`) points at the statement importer, which is the wrong door for a Plaid account.

**Queue empty (the reward state):**

```
You're all caught up.
Nothing left to book. $312,400 tied to deals this month
across 24 transactions.

See the ledger
```

First line 17/600 ink, second 13/400 muted, link 12.5/500 accent. This is the state Jack should reach daily and it should read as an achievement, not a void.

**Filtered-empty:** inline where the list would be — `Nothing matches these filters.` + `Clear filters` as a working text button that actually resets them. Never a bare muted line with no exit.

**Loading:** three skeleton rows at exact row geometry (56px, rail, two text bars, right-aligned amount bar), `animate-pulse`. Never a centred spinner — the current one collapses the page height and makes it jump on every refresh.

**Error:** a strip at the top of the list area, `border-l-2 border-warning`, 12.5/400: `Couldn't load transactions. Retry.` Load failures are never toasts. Action failures (allocate, book) render inline at the field or under the footer button, in plain English, with the raw error available behind a `Details` disclosure rather than dumped as `String(e)`.

### 2.8 What moves where — full disposition

| Control today | Destination |
|---|---|
| Clean up duplicates (`1401`) | Setup → Data health |
| Remove statement imports (`1409`) | Setup → Data health, under a disclosure |
| Auto-categorize with AI (`1422`) | Ledger toolbar (it acts on the whole ledger) |
| `Account` import target input (`1429`) | Setup → Import, inside the import flow where it applies |
| Import statement / Smart import (`1437`,`1444`) | Setup → Import |
| Record cash (`1451`) | To book → header `＋`, since a cash receipt is an entry into the queue |
| Bank feed panel + keys (`1643–1908`) | Setup → Connections |
| Import preview cards (`1911`,`1968`) | Setup → Import, in place |
| Six-figure strip (`2025`) | Ledger header |
| To-do / Booked tabs (`2039`) | Become the To book / Ledger surfaces |
| Category / status selects (`2097`,`2105`) | Ledger filters only |
| Split in/out (`2078`) | Ledger view mode |
| Date-from/date-to (`2115`) | Month stepper on To book; full range in Ledger |
| Grouping suggestions (`2134`) | Keep, but only on To book, max 2 at a time, above the day dividers |
| Bulk bar (`2186`) | Keep as-is; appears only in selection mode |
| Rules card (`2329`) | Setup → Auto-tag rules |
| `uppercase tracking-wide` (`1532`,`1555`) | Deleted — sentence case, 11.5/500 muted |

### 2.9 Type, colour and motion — the whole system in one place

- **Type:** Satoshi only. 19/600 screen title · 17/600 empty-state heading · 15/600 amount (tabular, −0.018em) · 14/600 payee (−0.005em) · 13/400 body and progress line · 12.5/600 deal names in chips and pickers · 12/400 sublines · 11.5/500 day dividers and section labels · 11/400 reasons and hints. Sentence case everywhere. No uppercase, no letter-spaced kickers, no emoji.
- **Colour:** ink for all amounts. `accent` reserved for state that needs the user (rail on needs-a-deal, match chips, primary buttons). `success-ink` only for confirmations of completion (`Fully allocated`, `matches the open balance`). `warning`/`danger` only for over-allocation and destructive confirms. Green/red amounts are gone from To book — with 1891 rows, colouring every one carries zero information. *Tradeoff below.*
- **Surface:** hairlines, not cards. `border-line` for structural edges, `border-line-2` between rows. No shadows anywhere except the docked panel's left border, which is a border, not a shadow. Radius 8 on chips and inputs, 3 on the bar, 0 on rows. Warm-paper `bg-surface`, `bg-surface-2` for hover and inset blocks.
- **Motion:** 130ms `var(--ease)` on everything — hover, rail colour, bar fill, row collapse-out, sheet slide, panel content push. Nothing longer, nothing spring.
- **Spacing:** 16px gutter, 12px row padding, 20/8 around day dividers, 24px between screen sections, panel 20px inset.

---

## PART 3 — Tradeoffs and pushback

1. **Killing green/red amounts is the most contentious call here.** Justification: it is precisely because colour is on every row today that nothing on the screen can say "look at me". If Jack rejects it, the fallback is to keep the muted success/danger tint **in the Ledger only**, where scanning direction genuinely is the job, and keep To book monochrome-with-state-rails. I'd ship it monochrome and let him veto.

2. **One-commit splits need a backend that accepts N allocations atomically.** `api.allocateBankTxn` is one-at-a-time today. The UI can batch client-side, but a mid-loop failure leaves a partially split transaction — which, given the documented `apply_upsert` hazards, is exactly the shape of state that leaks badly across devices. **This is the one backend change the design asks for**, and I'd treat it as a prerequisite rather than a nice-to-have.

3. **The docked panel costs 420px, and that's what forces the row simplification.** At 1280 with the 216px sidebar the list gets 644px. The current 9-column, `min-w-[860px]` table cannot live there. So the row rewrite isn't a stylistic preference layered on top — it is what pays for the panel. If the row stays as-is, the panel has to go back to being an expanding row, and the split stays cramped.

4. **Mobile financials is net-new surface, not a port.** Realistically ~600 lines of `app.js` plus CSS: list, filters, sheet, deal-picker push, chip strip, commit. It's the largest single item in this spec and I'd sequence it *after* the desktop row + panel, so the interaction model is settled before it's written twice.

5. **Don't build the draggable split bar.** "Think outside the box" points straight at drag-to-cut, and it would be worse than what exists — every allocation here has to land on an invoice to the cent. The bar displays; the chips and keyboard commit. The genuinely novel piece is the **remainder chip strip above the phone keyboard**, which is what makes a three-way split six taps.

6. **Four surfaces instead of three tabs is more navigation, and that's the point.** The alternative — keeping one Transactions tab and merely collapsing the setup panels — was tried already (`bankFeedOpen`, `1229`/`1672`) and the screen still opens with seven buttons and a paragraph above the work.

---

## PART 4 — Verifiable success criteria

1. An obvious wire is tied in **one click** from the queue (today: row → wait for allocs → pick target type → search deal → click deal → type amount → pick role → Allocate → Book = 8 interactions).
2. A three-way split is **one commit**, ≤6 interactions on a phone, with no remainder digit typed by hand.
3. **Zero** setup, import or cleanup controls render on the To book screen.
4. To book reaches empty and says so with a real sentence.
5. Every load failure renders inline and retryable; no `String(e)` reaches a toast.
6. No horizontal scroll at 1280px with the 216px sidebar and the panel open — verified by rendering, per the desktop responsive rule.
7. Grep for `uppercase` in the financial components returns only `preview.format` (`1915`), which is a format code, not a label.
8. Mobile To book renders, refreshes on pull, and can complete a split — parity rule satisfied on the same release, not a follow-up.

---

# ADVERSARIAL REVIEW — DUPLICATE-ESCAPE

I traced every path against the live code and data. The scheme has verified strengths, but it breaks in six ways — and it breaks hardest in exactly the population where all of Jack's actual duplicates live.

---

# Adversarial review — lens: duplicate-escape

## The framing error that produces most of the findings

I re-ran the reference extraction against the live desktop DB (copied with `-wal`/`-shm`; 1248 rows). Design 1's headline numbers roughly replicate: **531/1248 rows (42.5%) carry an extractable reference, covering 91.1% of dollars**, and tier‑1 keys (`account|direction|kind|value`) have **zero collisions** across 14 months. That part is real.

But then I bucketed the 33 excess duplicates by tier:

```
ALL content-duplicate groups: 19,  excess rows: 33
TIER-2 (reference-less) buckets with n>1: 19
```

**Those two sets are identical. Every single duplicate in the live database is a reference-less, tier-2 row.** Tier 1 — the 91.1% of dollars the design calls "structurally impossible to duplicate" — has produced zero duplicates in 14 months *under the current, admittedly broken, id scheme*. The design's guarantee is being deployed precisely where the problem is absent, and its explicitly-probabilistic tier is being deployed precisely where 100% of the problem lives.

That is not a rounding error in the pitch. It means the honest residual-risk statement — "zero duplicates for 92% of the money" — describes a guarantee that would have prevented **none** of the 33 duplicates it is being built to prevent.

---

## P0-1 — Tier 2 is logically contradictory. It cannot both admit genuine twins and suppress a re-pull.

**Attacking:**
> *"(b) twins both survive — … Tier 2 gives them distinct ordinals. The 4-row buckets resolve to exactly 2 rows, which is correct"*
> *"A full re-pull on a second device: it replays 0,1,2… over the same bucket and lands on the same ids — collisions, not new rows."*

**Scenario.** The live data:

```
n=4  BUS COMPLETE CHK ··3655  2026-07-08  out  $25.00 :: online domestic wire fee
     imported_at runs: {'2026-07-14T02:39:06': 2, '2026-07-22T17:58:13': 2}
```

Seven buckets like this. Two rows arrived in one run, two more in a later run, all identical in every field tier 2 keys on.

The ordinal allocator faces two incoming rows against two existing rows, identical in account, date, direction, amount and memo. It must choose:

- **Match them** (replay 0,1 → collide → merge). The seven 4-row buckets collapse to 2. Correct here. But then a *genuinely new third* $25 wire fee on 2026‑07‑08, arriving in a later run as one incoming row against two existing, also replays from 0 — and **merges into an existing row. A real $25 fee is destroyed.**
- **Append after the existing max** (→ ordinals 2,3). The new third fee is admitted correctly. And the re-pull re-creates exactly the 4-row bucket that exists today.

**There is no third option, because the only information that distinguishes "Plaid re-serving history" from "the bank posted another identical fee" — `transaction_id` and the `imported_at` run — is deliberately excluded from the tier-2 key.** The design asserts both outcomes on the same page without naming a mechanism for either.

**Status: REAL, and unmitigated.** The design's claim that the 4-row buckets "resolve to exactly 2 rows" has no stated mechanism behind it. The current code's `imported_at < now` guard (`commands.rs:12184`) is the *existing* answer to this and it is what produced these rows.

**Minimal fix.** Do not remove the run boundary from the identity decision — make it explicit. Keep a per-bucket `observed_count` that only increases when a row arrives with a `transaction_id` never seen for that bucket (persist `plaid_txn_id → bank_txn.id` — see P1-2). Ordinal allocation then keys on genuinely-new provenance rather than on arrival order. Absent that, tier 2 should not claim to satisfy (b) at all.

---

## P0-2 — `account_key` for the credit cards is built on the one field that demonstrably drifts.

**Attacking:**
> *"account_key = plaid persistent_account_id when present, else a local bank_account row id resolved by (institution, subtype, mask)"*
> *"the Amex mask actually drifted ··1004 → ··2002. So the card path must resolve through an explicit account row, never the display label."*

**Verified live** from `plaid_items.accounts_json`:

```
American Express  account_id=VLX6Nyxm...  persistent_account_id=None  mask=2002  subtype='credit card'
Chase             account_id=nej1kE5k...  persistent_account_id=None  mask=2623  subtype='credit card'
Chase             account_id=QVXEZDyZ...  persistent_account_id='81fb134f...'  mask=3655  subtype=checking
Chase             account_id=pe83vQov...  persistent_account_id='1c703490...'  mask=8278  subtype=savings
```

**Both credit cards return `persistent_account_id: None`.** So both fall to the mask-based fallback. And the mask is the field that changed (1004 → 2002) on the very re-link this design exists to survive.

The design diagnoses this correctly one sentence before contradicting itself: it says the card must resolve through an explicit account row *rather than the mask-bearing display label*, then defines that row's resolution key as `(institution, subtype, mask)`. Same input, one layer of indirection. On the next Amex re-link the mask changes, the fallback resolves to a **different** account row, every tier-2 card row re-keys, and the card gets a complete parallel ledger.

This is not a tail case. The 717 reference-less rows are overwhelmingly card spend — the cards *are* the tier-2 population.

**Status: REAL.** Also note there is no `bank_account` table in the schema at all (`sqlite_master` returns only `bank_txn`, `bank_allocation`, `bank_txn_deleted_backup`), so this table, its seeding, and its merge UI are net-new and entirely unspecified.

**Minimal fix.** `account_key` must be a locally-assigned opaque id bound at link time by explicit human confirmation ("is this the same card as Blue Business Cash ··1004?"), never derived from any Plaid-supplied field. Derivation is what fails; binding is what survives.

---

## P0-3 — The alias map that seeds `account_key` provably cannot reach a second device.

**Attacking:**
> *"seeded with the existing alias map"*

The alias map is `settings.bank_account_aliases` (`commands.rs:11371-11403`). It is broadcast via `sync::record_upsert("settings", "bank_account_aliases", …)`.

The server's push allowlist (`clienthub-api/src/sync.rs:1454`):

```rust
const PUSHABLE: &[&str] = &[
    "clients", "interactions", "invoices", … "bank_txn", "bank_allocation", …
];
// "(RBAC, settings, orgs and the join tables are intentionally excluded from the push path.)"
```

**`settings` is not pushable.** `apply_pushed_event` returns `Ok(None)` → the event lands in `rejected` → per the contract at `sync.rs:1522-1531` the desktop **dequeues it permanently**. The alias merge is device-local, forever.

So: Jack merges ··1004 → ··2002 on the PC. The MacBook never learns. The two devices compute different `account_key`s for the same card, therefore different tier-1 *and* tier-2 ids for the same transactions, and both push. The server accepts both. Each device pulls the other's. **A duplicate ledger, minted by the identity function itself, with no constraint anywhere that can catch it** — the ids genuinely differ, so there is no PK collision to merge on.

**Status: REAL, mitigation absent.** The design names the alias map as a seed without checking that it replicates.

**Minimal fix.** Whatever carries account identity must live in a pushable, `org_id`-scoped table (the design's own `bank_account`, added to `PUSHABLE`, `ALLOWED_TABLES` and `SNAPSHOT_TABLES` on both sides), never in `settings`.

---

## P0-4 — Deterministic ids make deleted rows *re-derivable*, and no ingestion path checks tombstones.

**Attacking:**
> *"Ordinal reuse after deletion … Fixed by retiring tombstoned ordinals so allocation is monotonic per bucket"*

That fix is scoped to tier 2 only. **Tier 1 has no ordinal to retire.** And the real hole is one layer lower.

`is_tombstoned` has exactly one caller in the entire desktop:

```
netsync.rs:1109:   if sync::is_tombstoned(table, id) {
sync.rs:477:       pub fn is_tombstoned(...)
```

That one call site is `restore_snapshot`. **All four ingestion paths — `bank_import.rs:508`, manual cash `commands.rs:11088`, `plaid_sync` `commands.rs:12213`, server `routes/plaid.rs:471` — check only `SELECT 1 FROM bank_txn WHERE id=?`.** A deleted row is absent from `bank_txn`, so the check passes, the row inserts, and `record_upsert` stamps a **fresh HLC**. At `sync.rs:527` the tombstone guard is `if ts >= event.hlc { skip }` — a fresh HLC beats a months-old tombstone, so the resurrection propagates to every device. `apply_delete`'s reciprocal guard (`sync.rs:698-713`) then treats the *original* delete as stale and keeps the row.

Under today's ids this is survivable because a re-link mints new `btpl_` ids that don't match the tombstones. **The deterministic scheme removes that accidental protection**: the re-derived id matches the tombstone exactly, and the ingest path walks straight past it. There are **3357 `bank_txn` tombstones** and `plaid_resync_all` (`commands.rs:12310`) sets `cursor=''` on every item — a one-button full re-pull.

Concretely: clean up the 33 excess, hit "Re-pull all", get them back. Permanently, on every device.

`bank_txn_deleted_backup` has **0 rows**, so there is no local record of anything already removed.

**Status: REAL.** This is the single cheapest fix on the list and the design omits it entirely.

**Minimal fix.** One line at each of the four ingestion sites: `if sync::is_tombstoned("bank_txn", &id) { continue; }`. Using a function that already exists.

---

## P0-5 — The migration is itself the duplicate factory, because it moves identity off the primary key.

**Attacking:**
> *"The one constraint that is safe is the PRIMARY KEY, precisely because `apply_upsert`'s exists-check already treats a PK collision as a merge. That is the entire reason this design puts identity in the id rather than in an index."*
> *"Instead: … **Leave the 1248 existing ids alone.** … New writes: every path calls one function that computes the key, looks it up, and either merges into the existing row (legacy `btpl_` id included) or inserts under the new deterministic id."*

These two paragraphs contradict each other. For all 1248 existing rows, identity is **not** in the id — it is in a `natural_key` column that must be found by a local `SELECT`. The PK-collision-as-merge property, which the design calls "the entire reason" for the approach, does not apply to a single row currently in the database.

That lookup fails in a way the code guarantees. `apply_upsert` (`src-tauri/src/sync.rs:612-616`) silently drops columns the local schema lacks:

```rust
let present = existing_columns(&conn, table);
winning.retain(|(c, _)| present.contains(c));
if winning.is_empty() { return Ok(()); }
```

The server does the same and logs `SCHEMA DRIFT` (`clienthub-api/src/sync.rs:1130-1143`). So any device that has not yet run the migration **discards every `natural_key` value**, records no clock for it, and — because events are delivered once, gated by `sync_meta` and the server pull cursor — **never receives them again without an explicit Repair sync**. The design's reassurance that "a later re-pull fills the rest" is true only of a manual Restore, not of normal operation.

Result: that device's `natural_key` lookup misses on all 1248 rows. Every Plaid re-pull mints a fresh `bt1_`/`bt2_` row beside the legacy `btpl_` row. Different PKs, no collision, no constraint. A full duplicate ledger, and both devices are behaving exactly as designed.

**Status: REAL.** Deliberately keeping legacy ids is defensible; keeping them *while claiming PK-based identity* is not.

**Minimal fix.** Gate the new id path on a migration-complete sentinel: no path may mint a `bt1_`/`bt2_` id until this device has verified `COUNT(*) FROM bank_txn WHERE natural_key=''` is zero. Until then, fall through to the existing `btpl_` behaviour. Slower rollout, no duplicate window.

---

## P0-6 — Two of the seven "references" are counters, not identifiers, and the key omits date and amount, so recycling MERGES two real payments.

**Attacking:**
> *"NOTE: date and amount are deliberately NOT in the key, so a pending→posted date/amount change cannot re-key the row."*
> *"Zero collisions, once scoped by account + direction, over 14 months."*

The extraction set includes `CHECK #` and `DEPOSIT ID NUMBER`. Live rows:

```
check=2136   2025-09-19 out $2,000.00 :: CHECK # 2136
check=2533   2025-08-11 out $2,000.00 :: CHECK # 2533
check=2135   2025-07-02 out $1,667.00 :: CHECK # 2135
depid=796741 2026-01-09 in  $15,000.00 :: DEPOSIT ID NUMBER 796741
depid=793920 2025-05-20 in  $119.32   :: DEPOSIT ID NUMBER 793920
```

A check number is unique per *checkbook*, not per account for all time — two series are already visible (21xx and 25xx), and a new checkbook restarts. A teller `DEPOSIT ID NUMBER` is a branch counter (793920 → 796741 in eight months) that wraps.

When one recycles, the tier-1 key is identical, `apply_upsert` routes to the UPDATE branch (`sync.rs:664-681`), and per-column LWW keeps **one** amount and **one** date. Check #2136 for $2,000 and a future check #2136 for $18,000 become a single row. **Money silently destroyed** — which the design itself identifies as strictly worse than a duplicate ("The result is a *merge* — money lost — which is strictly worse than a duplicate").

"Zero collisions over 14 months" rests on **3 check rows and 3 deposit-id rows**. That is not evidence of a natural key.

**Status: REAL.** Note the design's *direction* scoping does correctly defuse the related case it found — the four global collisions were internal-transfer legs sharing one `transaction#:`, and scoping by direction genuinely separates them. Credit where due. But direction does not separate two same-direction checks.

**Minimal fix.** Drop `check` and `depid` from tier 1 — demote them to tier 2. Or, if they are kept, add `amount_cents` to the tier-1 key for *counter-class* refs only (`imad`/`trace`/`trn`/`zelle` stay amount-free so a pending→posted amount change cannot re-key them; those four are genuinely globally unique by construction).

---

## P1 findings

**P1-1 — Statement import cannot compute `account_key`.** `bank_import.rs:432` keys on the `account_id` argument, which is a **free-text field typed in the toolbar** (`FinancialsView.tsx:1429`), not a resolved account. A PDF supplies no institution/subtype/mask handshake. Typing `Chase 3655` one month and `BUS COMPLETE CHK ··3655` the next yields two account keys and two ids for the same transaction. The design's claim that statement import "call[s] the same function and mint[s] the same string" has no path to the inputs that function needs. There are already **550 `bt_` tombstones**, so this import path has been exercised and cleaned up before. Minimal fix: the import flow must select a bound account row, not accept free text.

**P1-2 — `modified` cannot be applied under a content-derived id.** The design correctly flags that Plaid's `modified` array is dropped by both sides and recommends handling it. But a `modified` payload is keyed by `transaction_id`, and the new scheme removes `transaction_id` from identity entirely. To apply one you must map `transaction_id → bank_txn.id`. The only candidate is `raw_json.tid` — present on **81 of 1248 rows (6.5%)**, unindexed. So the design's own recommended mitigation for its largest residual risk is not implementable as specified. Minimal fix: a `plaid_txn_ref(txn_id, bank_txn_id)` mapping table, which also supplies the provenance P0-1 needs.

**P1-3 — Manual cash double-entry is wider than stated.** The design frames tier 3's residual as "manual cash entered on two devices". The larger case is one device plus the feed: Jack records a $7,300 cash deposit; the bank reports `ATM CASH DEPOSIT $7,300`. Two rows, one real event, `btc_` and `bt2_`, structurally unlinkable. Given the design names teller cash as its most material tier-2 item, this deserves naming.

**P1-4 — Page-boundary and retry churn in ordinal allocation.** `commands.rs:12262-12266` deliberately does not advance the cursor on a failed row, so **Plaid re-serves the same page**. Any run-scoped "ordinals I consumed this pass" state that lives in memory is discarded on retry and re-allocates differently. Ordinal consumption must be durable and idempotent across a re-served page, and buckets can straddle Plaid's page boundaries.

---

## Where the scheme genuinely holds

- **Out-of-order sync arrival.** Holds. Buckets are day-scoped, so a backfill of an older date is a different bucket. `already_applied` (`sync.rs:495`), per-column LWW, and `replayed_files`-by-name (`sync.rs:196-198`, which retired the high-water-mark cursor) make apply order non-load-bearing.
- **Partially-applied event.** Holds for identity. `apply_upsert` records clocks only for columns it actually wrote (`sync.rs:683-687`) and skips clock recording entirely on a 0-row `INSERT OR IGNORE` (`sync.rs:646-663`), so a partial cannot poison a later create.
- **Outbound dead-letter (`netsync.rs:478`).** The deterministic id is a genuine improvement here. If device A's push is dead-lettered and the server never gets the row, device B re-mints the *same* id from its own feed and pushes successfully — the two converge instead of forking. Under today's per-item `btpl_` ids they would not.
- **Restore-from-snapshot.** Holds on its own terms — `netsync.rs:1109` gates on `is_tombstoned` before the raw upsert. (It is undone by P0-4, but the snapshot path itself is correct.)
- **Clock skew alone.** Does not create duplicates. `now_hlc` is monotonic within a process and `observe_remote` (`sync.rs:108-129`) pulls a lagging device forward on every received event. Skew only matters as the mechanism by which P0-4's fresh-HLC resurrection beats an old tombstone.
- **The no-UNIQUE-index argument.** Correct, and well-evidenced. `INSERT OR IGNORE` at `sync.rs:635` / `clienthub-api/src/sync.rs:1162` turns a constraint violation into a silent per-device missing row with no clock recorded. A UNIQUE index would be worse than the duplicates. I could not break this reasoning.
- **Direction-scoping of tier 1.** Correctly prevents the internal-transfer two-leg merge.
- **Non-destructive migration.** Correct call, especially with `bank_txn_deleted_backup` at 0 rows.

---

## Verdict

The scheme does not hold under this lens. Six duplicate-escape paths are real and code-verified, and the two most consequential are structural rather than incidental:

1. **Tier 2 cannot deliver requirement (b)** — admitting genuine twins and suppressing re-pulls are mutually exclusive given the information the key retains. This is where 100% of the live duplicates are.
2. **`account_key` has no stable input for the credit cards** and its stated seed (`settings.bank_account_aliases`) is on the server's non-pushable list, so two devices cannot be relied on to compute the same id at all.

The tier-1 mechanism is sound and worth building — it is a real natural key, direction-scoping is the right call, and the anti-UNIQUE-index reasoning is correct. But it should be described as what it is: **a strong guarantee over the 91% of dollars that has never duplicated, which does not address the 8% that has.** Fixing the four cheap items first — the ingestion tombstone gate (P0-4, four lines), dropping counter-class refs from tier 1 (P0-6), a pushable account-identity table (P0-3), and persisting `transaction_id` provenance (P1-2) — would remove more duplicate risk than the tiered id scheme does, and P1-2 is a prerequisite for tier 2 ever working.

**Files:** `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\sync.rs` (tombstone guard 527, `is_tombstoned` 477, `apply_upsert` 567-689, `apply_delete` 691-717) · `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\commands.rs` (plaid_sync dedup 12171-12224, retry 12262-12266, `plaid_resync_all` 12310, manual cash 11042-11094, alias map 11371-11403) · `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\bank_import.rs` (`stable_id` 432-444) · `C:\Users\Jack\Desktop\BUSINESS APP\src-tauri\src\netsync.rs` (snapshot gate 1109, outbound dead-letter 478) · `C:\Users\Jack\Desktop\clienthub-api\src\sync.rs` (`PUSHABLE` 1454-1462, schema drift 1130-1143, `push_events` 1539-1559) · `C:\Users\Jack\Desktop\clienthub-api\src\routes\plaid.rs` (436-483). Analysis scripts: `…\scratchpad\adv1.py`, `adv2.py`; DB copy at `…\scratchpad\dbfresh\`.

---

# ADVERSARIAL REVIEW — DATA-LOSS

## VERDICT

Design 1's identity scheme survives my lens with two migration defects. **Design 2's UNIQUE index is a data-loss engine and its tombstone gate would immediately brick 89% of the live ledger.** Design 3's D2 deterministic allocation ids introduce a new silent-deletion vector. Design 4's one-commit split is unsafe on the current non-transactional allocator.

But the largest finding is not in any of the four designs — it is already live and every design leans on it as its recovery path.

---

## Numbers all four designs are reasoning from (re-measured, desktop DB)

Design 1's corrections are right and the brief is stale. I add the one nobody measured:

| | value |
|---|---|
| bank_txn live | 1248 |
| bank_txn tombstones | 3357 |
| **live rows that ALSO carry a tombstone for their own id** | **1109 (88.9%)** |
| bank_allocation | 50 · **0 txns have >1 allocation** |
| allocations whose txn id is tombstoned | 35 of 50, **$690,167 of $976,441** |
| `bank_txn_deleted_backup` | **0 rows** |
| distinct HLC nodes writing bank_txn | 2 |
| duplicate content buckets | 19 buckets, 33 excess |

**Zero transactions have ever been split.** Every split invariant in Designs 3 and 4 is unexercised code.

---

## F1 — Restore from server currently recovers 11% of the bank ledger. REAL, mitigation ABSENT.

`record_delete` (sync.rs:259) writes a tombstone and **nothing ever removes it**. When Plaid re-imports the same `btpl_` id, the row comes back via the upsert path — the tombstone stays. That is how 1109 live rows accumulated tombstones.

`restore_snapshot` (netsync.rs:1108-1112) skips any row with *any* tombstone, ignoring HLC:

```rust
if let Some(ref id) = pk_val {
    if sync::is_tombstoned(table, id) { continue; }
}
```

**Failing sequence:** desktop DB is damaged / reinstalled / a device is stranded. Jack runs Restore from server. **139 of 1248 transactions come back.** The other 1109 are silently skipped — `count` never increments, the warn path isn't even hit. Then `deal_bank_actuals` (commands.rs:4381) sees `has_rev_link = false` for 35 allocations, and `bank_snapshot_value` (4401, `JOIN bank_txn`) empties. $690,167 of booked allocations become invisible.

This matters because **every drop path in this codebase points at Restore as the cure** — sync.rs:507 ("recoverable after upgrading via Restore from server"), netsync.rs:489 ("run Repair/Restore if the server is missing this write"). The cure is 89% broken for exactly the table under redesign. All four designs inherit this and none mention it.

**Minimal fix (highest value item in this review, ~6 lines):** in `apply_event`, when an upsert legitimately beats a tombstone, delete the tombstone row. And change `restore_snapshot`'s guard from `is_tombstoned` to "tombstone HLC ≥ the row's max column clock". Do this **before** any of the four designs ship.

---

## F2 — `INSERT OR IGNORE` drops are permanent, not retried. REAL.

The designs describe this as "silently skips". It is worse. `apply_upsert` returns `Ok(())` on the 0-row branch (sync.rs:662), and `apply_event` then unconditionally runs `mark_applied(&event.id)?` at line 539. `already_applied` (line 495) short-circuits every future replay of that event id.

So the row is missing on that device **forever**, with no error, no dead-letter entry, and no `sync_dead_letters` row. The comment's promise that "a later re-pull fills the rest" is only true if a *different* event later carries the row. Recovery is Restore-only — see F1.

**This is the mechanism that makes Design 2's UNIQUE index catastrophic**, and Design 1's argument against UNIQUE is correct but understates it.

---

## F3 — Design 2's conflict capture cannot be implemented where it claims. REAL.

> "On a UNIQUE violation, do **not** silently skip (that's how you lose a real second charge). Write the rejected payload to `bank_txn_conflict`"

`INSERT OR IGNORE` returns `Ok(0)` for a UNIQUE violation and `Ok(0)` for the NOT-NULL partial-upsert case. They are indistinguishable. The existing code (server sync.rs:1186-1192, desktop 646-663) treats `Ok(0)` as the partial-upsert case and *must*, per its own comment:

```
skipping clock record so a later create still applies
... Poisoning here would propagate the missing row to EVERY device that pulls.
```

Route `Ok(0)` to `bank_txn_conflict` and every out-of-order partial upsert becomes a false "are both real?" prompt. Drop `OR IGNORE` to get a distinguishable `Err` and the partial-upsert path becomes a hard error — which on the server hits `push_events` line 1551:

```rust
Err(e) => tracing::warn!("push apply failed for {}: {}", ev.id, e),
```

Named in neither `applied` nor `rejected`, contradicting its own contract at 1522-1525. The desktop keeps it queued (netsync.rs:428), bumps attempts, and at `MAX_PUSH_RETRIES = 10` **dead-letters it** (netsync.rs:477-492). The write never reaches the server or any other device.

**Minimal fix:** don't add the UNIQUE index. Put identity in the PRIMARY KEY, as Design 1 does — a PK collision routes to the exists-check UPDATE branch, which is already the merge path.

---

## F4 — Design 2's tombstone gate bricks 1109 currently-live rows on contact. REAL, severe.

> "**Gate every ingestion insert on `is_tombstoned("bank_txn", &id)`.** One line per writer, using a function that already exists."

`is_tombstoned` returns true for *any* tombstone at *any* HLC. 1109 of the 1248 live rows qualify **today**.

**Failing sequence:** ship the gate. Jack re-links a bank, or runs `plaid_resync_all`, or a second desktop materializes the item with `cursor=''` (netsync.rs:1641). Plaid replays history. Every one of those 1109 ids is refused at ingestion. Any of them that had been cleared by `clear_bank_txns` in the interim can never return — not by re-pull (gated), not by Restore (F1). Design 2's item 2, suppressing by `dedup_key`, generalizes the block from one id to the whole content class.

Design 2 proposes this as the fix for resurrection, and it is aimed at a real hole. But applied to this database as it exists, it converts "duplicates sometimes come back" into "89% of the ledger can never come back".

**Minimal fix:** F1 first (prune tombstones on legitimate re-create), then make the gate HLC-comparing rather than existence-comparing. The gate is only safe *after* the tombstone table stops lying.

---

## F5 — Design 1's ordinal determinism claim is false under its own sequencing. REAL.

> "Ordinals assigned in a fixed order (`posted_at`, `imported_at`, `id`) so both writing nodes compute identically without coordinating."
> …
> "**Leave the 33 excess rows alone** until this is live"

Ordinal is "lowest integer not occupied by a live row" — a function of *bucket membership*. The design explicitly defers duplicate cleanup past the backfill, so the backfill runs over buckets that contain the 33 duplicates. Two nodes only agree if their bucket membership is byte-identical at their respective backfill instants, and the two nodes are 20 minutes apart on the netsync poll with Plaid still importing.

**Failing sequence:** node A backfills; bucket for `$25 WIRE FEE 2026-07-31` has 4 rows → ordinals 0,1,2,3. Node B pulls a delete for one duplicate first, then backfills the same bucket with 3 rows → ordinals 0,1,2. The same row id now has two different `natural_key` values in flight. Per-column LWW picks by HLC, so the surviving key is a coin flip on push timing. A subsequent Plaid re-observation computes a key that matches on one node (merge) and misses on the other (**new deterministic id minted → duplicate row**) — the exact outcome the design exists to prevent.

**Minimal fix:** invert the order — run the reference-matcher cleanup on the 33 first, then backfill; and derive tier-2 ordinals from a stable per-row value (`imported_at`, `id`) rather than from live bucket occupancy, so the key is a pure function of the row and not of its neighbours.

---

## F6 — Design 1's server-first ordering does not protect the desktop side. REAL.

> "Hard ordering requirement — desktop `apply_upsert` drops unknown columns"

Correct for the server. On the desktop, `apply_upsert` drops the unknown column (line 613) *and* `apply_event` still calls `mark_applied` (line 539). Per F2 the event never replays.

**Failing sequence:** desktop A ships the migration, desktop B has not updated. A writes bank_txn rows carrying `natural_key`. B applies them, silently drops `natural_key`, marks applied. B updates a week later — the column now exists, but those events are in `sync_meta` and never re-run. Every row A wrote during that window sits on B with `natural_key = ''` permanently. B's choke-point lookup misses on all of them and **mints a second row under a new deterministic id for every one**.

The in-code comment ("a later re-pull fills the rest once a migration adds them") is only true for the *server*, whose events are re-served by seq; a desktop's `already_applied` gate makes it false there.

**Minimal fix:** after the desktop migration adds the column, run a one-shot local recompute of `natural_key` from existing columns (the design already specifies a backfill that reads only existing columns — run it on *every* device post-upgrade, not just at migration origin). Do not rely on re-pull.

---

## F7 — Design 1's backfill, written to this codebase's own template, dead-letters on every peer. REAL.

The obvious template for "re-record every row" here is `resync_inventory` (commands.rs:8190-8209), which does `c.insert("id".into(), …)`.

Server `apply_upsert` skips the pk: `if col == pk { continue; }` (sync.rs:1099-1101). **Desktop `apply_upsert` does not** — its winning loop (sync.rs:590-599) has no pk skip. On a peer that lacks the row, line 630 builds `cols = [pk] ++ winning`, producing:

```sql
INSERT OR IGNORE INTO bank_txn (id,id,account_id,…) VALUES (?1,?2,…)
```

SQLite rejects a duplicate column in the insert list → `Err` at line 645 → the whole event fails → pull loop rewinds, retries, and dead-letters at `MAX_STUCK_RETRIES = 5` (netsync.rs:617-634). The row never lands on that peer. Only bites when the peer is *missing* the row — precisely the case a resync exists to repair.

**Minimal fix:** add `if col == pk { continue; }` to desktop `apply_upsert` to match the server, and omit `id` from the backfill's column map. (This is a live latent bug in `resync_inventory` today, independent of the redesign.)

---

## F8 — Design 3's D2 deterministic allocation ids delete money under clock skew. REAL, new vector.

> "Replace `format!("alloc_{}", Uuid::new_v4())` with `alloc_{fnv1a(bank_txn_id | deal_flow_id | role | amount_cents)}`"

Design 3 names the twin-leg collapse risk. It misses the delete/re-add race, which random uuids make structurally impossible and deterministic ids enable.

**Failing sequence:** Jack removes a $12,000 `buyer_payment` leg on the desktop → `record_delete` writes tombstone T1 (sync.rs:259). Before that reaches the phone, he re-adds the identical leg on the phone → same deterministic id, upsert at T2. The phone has not observed A's delete, so its HLC was never advanced by it; if the desktop's wall clock leads the phone's, **T1 > T2**.

- Phone pulls the delete: `apply_delete` computes `max_row_clock` = T2, `T1 > T2` → row deleted.
- Desktop pulls the phone's upsert: `apply_event` line 527, tombstone `T1 >= T2` → skipped, `mark_applied`.

The leg is gone on both devices, no error, no dead-letter, no `bank_txn_deleted_backup` equivalent for allocations. `resync_completed_deal` then re-derives the deal downward.

**Minimal fix:** keep uuid allocation ids and take Design 3's own stated escape hatch ("you already booked $X to this deal from this transaction — add another?"). Idempotency for double-taps belongs in a client-supplied idempotency key on the write, not in the row identity.

---

## F9 — the allocator's SUM check is not transactional, on one device. REAL.

`allocate_bank_txn` reads `(amount, SUM(allocations), direction)` on one pooled connection (commands.rs:10568-10575), releases it, does the `linked_elsewhere` check on a *second* connection (10580), then inserts on a *third* (10625-10630). Nothing holds a transaction across the check and the insert.

Design 3 blames cross-device merge; it is also single-device. Two windows, or Design 4's batched one-commit split fired concurrently, both pass `amt <= remaining` and both insert.

Then `heal_overallocated_txns` (10958) resolves it with `ORDER BY created_at DESC` — deleting the **newest** leg, which is as likely to be the correct one as the duplicate. That delete is `record_delete`'d and synced (10967-10969), and unlike `delete_bank_txns` there is **no backup table for allocations**. The booking is unrecoverable.

**Failing sequence for Design 4's batch:** $50k wire, three legs committed as a batch. Leg 2 fails mid-loop. Client believes the split committed; the txn is left at $30k of $50k allocated and leaves the "to book" queue in some views and not others (Design 3's G2: three disagreeing definitions of "needs attention").

**Minimal fix:** wrap read-check-insert in one `conn.transaction()` — a single connection, `BEGIN IMMEDIATE`. For Design 4's batch, insert all legs in that one transaction. And change `heal_overallocated_txns` to Design 3's contested state (it already has `created_by` populated) rather than deleting, or at minimum write to a backup table first, mirroring `delete_bank_txns` at 11861.

---

## F10 — Design 3's "Nothing needs editing" audit missed the write guard. REAL (correctness, not loss).

> "I audited every consumer… **Nothing needs editing.**"

The audit covers readers (`deal_bank_actuals`, `alloc_role_sum`, `bank_snapshot_value`, …), all of which filter `WHERE a.deal_flow_id = ?1` and correctly exclude `''`. It does not cover the **writer** at commands.rs:10582:

```sql
SELECT 1 FROM bank_allocation WHERE bank_txn_id=?1 AND deal_flow_id != ?2 LIMIT 1
```

An `owner_draw` leg with `deal_flow_id = ''` satisfies `'' != 'df_123'`, so `linked_elsewhere` is true. Adding a non-deal leg first blocks every subsequent deal allocation on that transaction with *"This transaction is already linked to another deal."* — which is Design 3's headline scenario ($50k = $30k deal + $15k owner draw + $5k fee) failing if the legs are entered in the wrong order.

**Minimal fix:** `AND deal_flow_id != '' AND deal_flow_id != ?2`.

---

## What holds

- **`resync_completed_deal`'s fallback is genuinely fail-proof.** `deal_bank_actuals` line 4386-4387 falls back to `df.gross_revenue` / `df.total_cost` — the last *recorded* figure, not the originally-entered one (4436). Losing every bank link leaves a completed deal's profit untouched. F1's $690k exposure degrades the audit trail and `bank_snapshot`, not the recorded profit. This is the single best-built thing in the financial engine and no design should weaken it.
- **`apply_delete`'s stale-tombstone guard is correct** on both sides (desktop 698-713, server 1309-1315) — monotonic tombstone, and a delete older than the newest column write keeps the row.
- **`cleanup_orphan_allocations` is safe** — it only removes allocations whose `bank_txn` is genuinely absent, and re-syncs affected deals.
- **`bank_txn_is_referenced` fails safe** (`.unwrap_or(1)`, commands.rs:11365) — a query error blocks the delete rather than authorizing it.
- **Design 1 is right that PRIMARY KEY is the only safe constraint**, for exactly the reason it gives: the exists-check at 620-628 / 1148-1154 already routes a PK collision to the merge path.

---

## Ranked minimal fixes

1. **Prune tombstones on legitimate re-create + HLC-compare in `restore_snapshot`** (F1). Blocks nothing else; unblocks F4 and restores the recovery path all four designs assume. Ship before any redesign.
2. **Add the pk skip to desktop `apply_upsert`** (F7). Two lines, fixes a live latent bug.
3. **Wrap `allocate_bank_txn` in one transaction; stop `heal_overallocated_txns` deleting without a backup** (F9). Prerequisite for any split UI.
4. **Drop Design 2's UNIQUE index and its `is_tombstoned` ingestion gate** (F3, F4). Keep its single-writer and re-link-in-place ideas, which are sound.
5. **Reorder Design 1's migration: clean the 33 first, backfill second, recompute locally on every device post-upgrade** (F5, F6).
6. **Keep uuid allocation ids; use an idempotency key instead** (F8).
7. **`deal_flow_id != ''` in the `linked_elsewhere` guard** (F10).

Verification queries that should return 0 after: live `bank_txn` rows unrestorable by snapshot (currently **1109**); allocations whose txn id is tombstoned (currently **35**, $690,167).

---

# ADVERSARIAL REVIEW — COMPLEXITY

## Verdict

The four designs, taken together, propose: a three-tier deterministic id scheme with an ordinal state machine, a `natural_key` column, a `dedup_key` column, a partial UNIQUE index, a `bank_account` canonical table with a merge UI, a `bank_txn_conflict` table, a `bank_txn_suppressed` table with key-level tombstones and `SNAPSHOT_TABLES` edits on both sides, a Plaid ingestion ownership migration (deploying the file memory says never to deploy), a server-authoritative allocate endpoint, an atomic batch-allocate endpoint, deterministic allocation ids, three new allocation roles, a four-surface UI restructure, a 420px docked panel that forces a full rewrite of the 9-column table, and a net-new mobile financials surface.

The measured problem this is aimed at is **33 excess duplicate rows in 19 buckets**, on a system with **1248 transactions and 50 allocations, zero of which are splits**, operated by one person plus a couple of teammates — and Jack already shipped a manual delete button for those 33 rows in v0.15.122.

Most of the identity engineering fails CLAUDE.md §2 outright. The UI restructure is mostly justified. Mobile is the only genuinely large item that is also genuinely necessary. Below, ordered by how much I want it cut.

---

## F1 — Tier 2 ordinals: new machinery whose own failure mode is worse than the bug. CUT.

**Quote (Design 1):** "*Concurrent allocation of the same free ordinal to two different real transactions. The result is a merge — money lost — which is strictly worse than a duplicate.*" And: "*Ordinal reuse after deletion… a real row vanishes on that device.*"

**Scenario:** Two devices pull the same day's card spend. Both compute bucket `(account|2026-08-03|out|1204|amazon)`, both allocate ordinal 0 to *different* real $12.04 Amazon charges, both mint `bt2_<same hash>`. `apply_upsert` sees a PK hit and routes to per-column LWW — the two charges merge into one row. $12.04 disappears from the ledger and nothing logs it.

**REAL.** The stated mitigation is "*Bounded by making one Plaid item authoritative per account so both devices read the same ordered stream*" — that is not a mitigation of the ordinal scheme, it is a prerequisite that, if actually enforced, removes most of the duplication the scheme exists to prevent. The design is circular: the ordinal machinery is only safe under single-writer, and under single-writer you don't need it.

**Minimal fix:** Ship **tier 1 only, and not as a primary key.** The reference extractor (`IMAD` / `TRACE#` / `TRN` / Zelle id / `transaction#:` / `CHECK #`) is the one genuinely new, genuinely verified finding in this entire plan — zero collisions over 14 months, 92% of dollars. Use it as an additional match key inside the *existing* import-time fingerprint guard and the *existing* `dedupe_bank_txns` (already 391 lines, `commands.rs:11440`, already has an account-alias pre-pass to hang it off). That is a regex table plus one extra comparison in two functions. No new column that must ship server-first, no id rewriting, no ordinal allocation, no migration, no rollback story needed. Reference-less rows keep today's behaviour, which for card spend is the 8% tail nobody is booking against deals anyway.

---

## F2 — The UNIQUE index. CUT, and Design 1 already proved why.

**Quote (Design 2):** "*`CREATE UNIQUE INDEX ux_bank_txn_dedup … On a UNIQUE violation, do not silently skip … Write the rejected payload to `bank_txn_conflict` and surface one prompt.*"

**Quote (Design 1), the rebuttal:** "*A UNIQUE constraint converts a duplicate into an invisible per-device missing row — worse than the duplicate.*"

I verified the code. `clienthub-api/src/sync.rs:1162` is `INSERT OR IGNORE`; `:1188` logs and *deliberately skips recording clocks*. Desktop is identical.

**Scenario:** Row arrives via the *sync* path (not the importer) and violates the index. `apply_upsert` swallows it, skips the clock, returns Ok. Row silently absent on that device forever.

**REAL, and the mitigation is ABSENT for the dangerous path.** Design 2's conflict-table prompt lives in the Plaid importer. It says nothing about `apply_upsert`, which is where a constraint violation on a synced table actually lands. There is no version of "prompt the user" available inside `apply_upsert` — it runs on a poll timer with no UI.

**Minimal fix:** No new UNIQUE index on any synced table. Ever. If you want the constraint feeling, the PK is already it, and F1 gets you there without a schema object.

---

## F3 — Four new synced schema objects across two codebases, for a two-desktop deployment. CUT to zero.

`natural_key` (D1) + `dedup_key` (D2) + `bank_account` (D2) + `bank_txn_conflict` (D2) + `bank_txn_suppressed` (D2). Both designs document the trap themselves: an unknown table is dead-lettered by every device that hasn't shipped it yet, and D2 requires `SNAPSHOT_TABLES` edits on both sides "*or a fresh install's first Repair sync inherits the rows without the suppressions and resurrects everything.*"

**Scenario:** Jack's second desktop is a version behind (normal — auto-update is not instant). It dead-letters every `bank_txn_suppressed` event it sees. Those events are not replayed after upgrade. That device now has the suppressions permanently missing and resurrects on its next Repair sync — the exact failure the table was added to prevent, now with extra steps.

**REAL.** No mitigation offered beyond "ship server first", which does not address field devices.

**Minimal fix:** zero new tables, zero new columns in round 1. `bank_account` canonical mapping in particular is a table plus a merge UI plus a seeding migration to solve the ··1004/··2002 case that `dedupe_bank_txns`' alias pre-pass **already solved and shipped**, with five documented safety conditions validated against that exact Amex.

---

## F4 — Server-owned Plaid ingestion: the largest infra change in the plan, justified by a cause its own author disclaims.

**Quote (Design 2), the justification:** "*Server-only for Plaid removes the two-device cause.*"

**Quote (Design 2), three paragraphs earlier:** "*Same item ⇒ same `transaction_id` ⇒ same `btpl_` id ⇒ the id check holds, so this is **not** a duplicate source.*"

**REAL contradiction.** The duplicate justification is void. What survives is a **latency** argument, and it is real but narrower than presented: the phone's ceiling today is the desktop's `plaid_sync` interval, and if Jack's desktop is asleep the phone sees nothing at all. That is a legitimate reason to eventually move ingestion. It is not a reason to do it in the same pass as an id migration.

Cost as scoped: deploy `plaid.rs` (memory: *"NEVER deploy plaid.rs (would activate a 3rd bank_txn source)"*), migrate tokens, re-arm webhooks Plaid has stopped calling, add `server_owned`, teach desktop to skip, remove the org-secrets bridge, and then — spawned scope nobody asked for — **build a new server balances endpoint because teammates lose local balances.** Plus, in D2's own words, "*a window where old desktop builds in the field are still writers*", made safe by the UNIQUE index that F2 just cut.

**Minimal fix:** Defer entirely. If phone latency is the actual pain, the cheap 90% is a "Pull now" control that triggers the desktop's existing `plaid_sync` — or simply shortening the sync interval. Revisit server ingestion as a standalone release, after mobile exists, with the desktop-writer removal as its *first* step rather than a race window.

---

## F5 — Deterministic allocation ids (D2 in Design 3). CUT.

**Quote:** "*Replace `format!("alloc_{}", Uuid::new_v4())` with `alloc_{fnv1a(bank_txn_id | deal_flow_id | role | amount_cents)}`*" — and, from the same document: "*collapse two genuinely distinct legs with identical (txn, deal, role, amount) into one… Decisions I need from Jack.*"

**Scenario:** Two $6,000 supplier payments on one $12,000 wire to the same supplier for the same deal, same role. Legitimate. They become one allocation and $6,000 vanishes from the deal's cost.

**REAL.** Mitigation is "*confirm with Jack*", i.e. absent.

There are **50 allocations and zero splits** in the live data. There is no evidence of duplicate allocations. This is speculative machinery with a silent-loss failure mode, for a problem that has not occurred. Its own escape hatch — the "you already booked $X to this deal from this transaction — add another?" confirm — is 10 lines, has no loss mode, and is strictly better. Ship the confirm, not the hash.

---

## F6 — The docked 420px panel forces a table rewrite it doesn't need to.

**Quote (Design 4), admitting the chain:** "*the row rewrite isn't a stylistic preference layered on top — it is what pays for the panel.*"

The two stated defects of today's inline panel are both real and both cheap:
1. "*you can horizontally scroll the allocation form away from the transaction it belongs to*" (it inherits `min-w-[860px]` inside `overflow-x-auto`).
2. "*Open row A, type an amount, close it, open row B — the form is pre-loaded with row A's context*" (state at `FinancialsView.tsx:307-318`).

**Minimal fix that gets ~90%:** move `AllocationPanel` out of the `<td colSpan={9}>` into a modal/sheet, and key its state by txn id (reset on open). Two defects gone, ~30 lines, the 9-column table survives, and the desktop panel now shares a shape with the mobile sheet you have to build anyway — one interaction model instead of two. The row simplification (drop account column, day dividers, state rail, match chip) then stands or falls on its own merits rather than being conscripted to pay for a layout decision.

Keep the **match chip with "Tie it"** regardless — it turns 8 interactions into 1 using scoring that already exists at `1127-1141`. That is the single best item in all four documents.

---

## F7 — Taste changes with veto risk, bundled into a functional release.

- "*Killing green/red amounts is the most contentious call here*" — Design 4's own words, with a fallback already written. Memory: mono numbers VETOED, 3D/amber/eyebrow VETOED. This buys nothing functional and costs a review round.
- Rename **Financials → Money**: churn across nav, memory, docs and Jack's muscle memory, for zero capability.
- "*Half*" chip in the mobile amount strip: nobody asked to split down the middle; zero splits exist in the data.
- The keyboard-attached chip strip ("*pins a one-row chip strip directly above the keyboard*") is the flakiest CSS in the plan — iOS Safari PWA, `visualViewport`, keyboard-accessory positioning. **Minimal fix:** two inline text affordances under the amount field (`Rest $35,000` / `Balance $20,000`), which Design 4 already specifies for desktop. Same tap count, no keyboard geometry.

---

## F8 — `unassigned` role: a third way to say "I haven't decided".

**Quote (Design 3):** "*Leave it alone → stays in the queue, correct… Or add an `unassigned` leg for the amount → the row leaves the queue.*"

With `owner_draw`, `expense`, `fee` and `adjustment` available, the remainder is always representable, so the row can always leave the queue honestly. `unassigned` exists only to let a row leave the queue while still being undecided — which is what `reviewed` did, and which Design 3 elsewhere argues against. Cut it; add it if Jack asks for it by name.

---

## F9 — De-bundle I12/G6. Not a cut; a separate release.

**Quote:** "`deal_bank_actuals:4386`: `let rev = if has_rev_link { buyer } else { manual_gross }` … *gross_revenue is overwritten with the partial, and net_profit/payouts recomputed from it.*"

This is the most serious correctness finding in the four documents and I believe it. It is also (a) outside what Jack asked for, and (b) "*a live change to the numbers on existing partially-paid deals*", including payouts. Memory already records one incident of exactly this shape ("mobile vs desktop profit (voided)"). Shipping it inside a UI/dedupe release means any number that moves gets blamed on the redesign.

**Minimal fix:** own release, with a before/after table of every affected deal shown to Jack first.

---

## Where the plan holds

Stated explicitly, because these are cheap and directly answer the brief:

- **Moving setup out of the working screen.** ~850 lines of chrome above the daily job, including a permanently mounted Plaid *secret* field. This is pure JSX relocation, no logic, and it is most of "better flow".
- **One definition of unbooked**, `remaining > 0.01`, replacing three contradictory ones (`bank_txn_summary:10486`, `needsDeal:1117`, `stale_unallocated:12519`). I verified all three; they genuinely disagree, and the $50k-part-deal-part-draw row is genuinely stuck forever. This is the "confusing case" Jack named, and the fix is deleting two definitions.
- **Non-deal allocation roles with `deal_flow_id = ''`**, with the consumer audit showing nothing needs editing (every consumer filters `deal_flow_id = ?1` or INNER JOINs `deal_flows`). Small, verified, unblocks the stuck rows.
- **Gating ingestion on `is_tombstoned`.** One line per writer, using a function that already exists and is currently called from exactly one place. Closes a guaranteed resurrection hole.
- **Skipping `pending: true` and handling Plaid's `modified` array** — both currently dropped on the floor, both a few lines, both remove real churn.
- **"Reconnect this bank" using Plaid update mode.** Smallest change in all four documents, prevents the entire re-link class from recurring.
- **The reference extractor as a matching key** (F1). Novel, verified, and cheap once separated from the id scheme.

---

## Effort, honestly

| Item | Size | Risk |
|---|---|---|
| Setup drawer + one unbooked definition + match chip + panel-to-modal | small | low |
| Non-deal roles + reference-key matching + tombstone gate + pending/modified + update-mode reconnect | small–medium | low |
| Mobile financials (list, sheet, deal picker, allocate, delta poll, server read + oplog-writing allocate endpoint, TAB_PERM, sw bump) | **genuinely large** — `app.js` is 7067 lines with zero bank code; "~600 lines" is optimistic | medium |
| Desktop row/table rewrite + docked panel | medium | medium (responsive re-verification at 216px sidebar) |
| Three-tier ids + backfill on 1248 rows across two nodes | large | **high — silent money loss** |
| New synced tables + UNIQUE index | medium | **high — silent per-device data loss** |
| Plaid ownership migration + plaid.rs deploy | large | **high — field-device write race, contradicts a standing NEVER rule** |
| I12 revenue derivation | small code, large blast radius | **high — moves live P&L and payouts** |

**Should not be attempted in one pass:** any two of {id migration, new synced tables/index, Plaid ownership move}. D2 itself says "*Ordering is load-bearing*" and then relies on the UNIQUE index — cut in F2 — to make its own race window safe. That combination is a v0.15.44-class outage waiting to happen, and `bank_txn_deleted_backup` is empty, so there is no local undo.

---

## The round-1 I would actually ship

1. Press the existing v0.15.122 delete button on the 33 rows. Zero code.
2. Setup drawer; one `remaining > 0.01` definition; match chip with "Tie it"; allocation panel out of the `<td>` into a modal keyed by txn id.
3. Non-deal roles (`owner_draw`, `expense`) + expose `fee`/`adjustment`; allocation bar with `Rest` / `Balance` affordances; duplicate-leg confirm instead of hashed ids.
4. Reference extractor folded into the existing import guard and `dedupe_bank_txns`; `is_tombstoned` gate on every ingestion insert; skip pending; handle `modified`; reconnect-in-place.

No new tables, no new columns, no id changes, no index, no server deploy, nothing irreversible. Round 2 is mobile, alone. Round 3 is server ingestion, alone. Round 4 is I12, alone, with numbers shown first.

**On Jack's "zero chance":** be straight with him. Round 1 does not deliver literal zero and neither does any of the four designs — Design 1 concedes the tail is "*coffee, gas, and teller cash*" at 8% of dollars, and Design 2 concedes manual cash on two devices is unsolvable by identity. What round 1 delivers is: every wire, ACH and Zelle he books against a deal gets a hard bank-supplied key, deletes stop resurrecting, and anything that slips through is one button away. That is the honest ceiling, and it is reachable without betting the ledger on an ordinal allocator.