# FINANCIALS PAGE — FULL BUG AUDIT — 2026-08-04

Requested by Jack (R-013 in the vault ledger): find every bug making Financials not work
properly, note UI improvements, and document it for later work. His three named complaints:

1. Data should automatically refresh every time the page is opened.
2. Everything should sync to all platforms and all users in the organization.
3. Once Plaid is connected once, it should light up green as connected for everyone.

This document records **what is true in the code today** (verified with file:line evidence,
three independent exploration passes). It does not change any code. The design answer for
most of it already exists in `FINANCIALS-PLAN.md` (2026-08-03) — this audit cross-references
that plan instead of duplicating it, and corrects it where the code has moved since.

State as of this audit: desktop v0.15.123, server deploy-33. Since the plan was written,
only two financials changes shipped (commit `8ded3e6`, released in `430e188`):
`clear_bank_txns` now writes recovery copies to `bank_txn_deleted_backup`, and the
bank-reference extractor (`bank_txn_reference` / `canonical_bank_txn_id`,
`commands.rs:11485/11528`) landed **dormant — zero callers**. Everything else in the plan
is still open.

---

## RELEASED — v0.15.126, 2026-08-04 evening

Everything in the two STATUS blocks below, plus the pending-settle churn fix, shipped in
**v0.15.126** (commit `6d569c6`, releasing `baff6ed`; tag pushed, CI builds and signs for
Windows + macOS). The server mirror of the churn fix is `clienthub-api` `5303fce` — committed,
still **never deployed** by design.

Verified before tagging: `tsc --noEmit`, `vite build`, `cargo check` (both repos) and a
release-profile `cargo build` all clean. **Not verified signed-in** — open the app after it
updates and check the three Financials tabs.

Standing warning that outlives this release: **do not run "every exact match" dedupe.** Jack
confirmed the 2× $100k Tytan (Jul 28) and 2× $20k wires (Aug 3) are real repeats.
Same-connection identical pairs are real money by design now.

---

## STATUS — round 1 fixed, 2026-08-04 (shipped in v0.15.126)

Verified: `tsc --noEmit` clean, `cargo check` clean (pre-existing warnings only), app boots
with no console errors. Not verified end-to-end in the running app — that needs Jack signed
in on the desktop build.

**Fixed in this round** (findings below are annotated `[FIXED r1]`):

| Finding | What changed |
|---|---|
| OV-8 | `plaid_balances` only counts a Plaid item as a live balance source once a usable account is parsed out of it — a failed/empty item can no longer report $0 and publish it over everyone's good balance |
| OV-3 | Adjust dialog refuses to save unless the stored figures were actually read back; inputs validated (no negatives, no >100%, strips `$ , %`); percentage float noise rounded |
| OV-6 | `fetch_published_bank_balance` uses a 4s timeout instead of the shared 30s client — Overview no longer hangs half a minute when the server is unreachable |
| OV-7 (part) | `plaid_sync` publishes the refreshed balance in the background, so the "synced · as of" figure other devices see no longer depends on someone opening a screen here |
| B3, B4 | `add_cash_transaction` and `set_bank_txn_review` now `push_now()` |
| LN-19 | All six loan writes now `push_now()` |
| C4 | `plaid_env` added to `SHARABLE_SETTINGS_KEYS` (was defaulting to production and failing every sandbox call) |
| A2 | `netsync-applied` listener calls through a ref, so an **open allocation panel** refreshes instead of holding stale numbers; unlisten leak closed |
| A3 | Load failure renders a real error state with a retry, not the "No transactions yet" empty state |
| A4 | Screen-level Refresh on the Financials header, ungated by Plaid |
| A7 | `healOverallocatedTxns` no longer fires on mount — opening the screen can't silently delete an allocation |
| C0 | Badge reads "Bank connected · N banks" or "API keys saved · no bank linked yet" instead of a green "Connected" that only meant keys were stored |
| OV-1, LN-1 | Overview and Loans both listen to `netsync-applied`; Loans gained a Refresh button and a loading state |
| OV-2, LN-2 | Overview and Loans distinguish a failed load from empty, with retry |
| LN-5 | A loan marked paid reports `outstanding = 0`, so the card stops contradicting Free Cash |
| LN-8 | `delete_loan` untags its transactions first (returns them to the review queue, never deletes them) and reports the count; the confirm says so up front |
| A1 (part) | "Auto-syncing" relabelled "Bank feed checked every 20 min" — the truth |

### Round 2 — same day (shipped in v0.15.126)

Verified: `tsc --noEmit` clean, `vite build` clean, `cargo check` clean on **both** the
desktop and the server. Not verified signed-in.

| Finding | What changed |
|---|---|
| **B11** | **The restore hole is closed.** `record_upsert` and the remote-apply path now retire a delete record the moment a row legitimately comes back, and a one-time sweep in `sync::init` drops delete records for rows that are demonstrably alive (measured ~1,109 of 1,248 live transactions carried one). "Restore from server" skipped every such row, so the recovery path all the other safety nets point at was returning about a ninth of the ledger. Genuinely deleted rows match nothing and keep their tombstones — deletes still stay deleted. The sweep lives in `sync.rs`, not a db migration, because `db::init` runs first and `tombstones` wouldn't exist yet (the migration would be silently marked applied without running). |
| **B1** | **Plaid's `modified` array is handled** on desktop for the first time — a pending row settling at a different amount, a corrected date or a rewritten descriptor now updates in place instead of being dropped, so the ledger no longer holds the first-seen version forever. Only bank-authored facts are refreshed; a **reviewed** row keeps the category and counterparty the user set. If an amendment shrinks a transaction below what's already booked against it, that is **surfaced, never auto-trimmed** (which allocation gives way is Jack's call). Sync results now carry `amended` + `over_allocated`, and the toast reports both. |
| **OV-10 / LN-6** | Loan outstanding is measured against the **greater of** the manual set-aside and what the feed shows repaid — in both `financials_overview` and `list_loans`, so they cannot disagree. The repayment had already left the bank balance while the full principal was still deducted, so free cash read low by every unapplied repayment until someone clicked Apply. No manual click is needed now; `list_loans` also returns `repaid_from_feed`. |
| **OV-12 + G2** | The **three disagreeing definitions of "needs a deal" are now one.** `financials_overview.stale_unallocated`, `bank_txn_summary.unallocated_in/out` and the frontend `needsDeal` all exclude internal transfers *and* loan-tagged money. A loan drawdown never gets an allocation, so it tripped the Overview alert permanently — a red flag that could not be cleared — and made the tab count and the summary figure disagree by construction. |
| **OV-24 / B5** | Manual bank/card balances now reach other devices, via `/api/bank-balance` (already deployed, carries an as-of stamp) rather than the shared-settings allowlist. Deliberate: those keys are last-writer-wins, and a **Plaid-linked device holds an unused, often zero manual figure that would have overwritten someone's real balance**. Publishing is gated to devices with no Plaid link and a non-zero figure, and any live balance re-asserts on the next sync. Needs **no server deploy**. |
| OV-25 | `set_money_config` pushes shared settings immediately instead of waiting for the poll tick. |

**Deliberately NOT done in this round** (unchanged, still open below): OV-9 reserves (needs
Jack's decision — see Open questions), B2 recovery-copy sync, C1-C3/C7 the
green-dot-for-everyone endpoint (blocked on the droplet env vars — Jack's hands), the
**server's** copy of the `modified` fix (deliberately untouched: `routes/plaid.rs` must
never be deployed until the desktop writer is removed), the `pending` filter (see below),
all of section D beyond the items above, and every plan phase.

**One judgement call worth flagging: pending transactions are still imported.** The plan
recommended skipping them (~3 lines) to kill most of the date/amount churn. I did not,
because it directly contradicts R-017 — "never skipped" — and would make real charges
invisible for days. Handling `modified` addresses the same churn without hiding anything,
which is the better trade. Say the word if you'd rather have the filter.

**Open questions for Jack** (blocking, not code):
1. **Reserves (OV-9).** Tax sweep and refund reserve currently subtract 60% of YTD profit
   from free cash forever and never draw down. Options: (a) wire `reserve_entry` so real
   transfers reduce them, (b) show them as a *target* alongside free cash rather than a
   deduction, (c) leave as-is. This changes the headline number on your Overview, so I
   won't pick for you.
2. **Confidentiality (B9).** Every org member's device holds the full bank ledger on disk;
   only the tab is hidden. Fine for you and your brother — a decision before any non-admin
   staff account exists.

---

## STATUS — B1-vanish PROVEN and fixed, 2026-08-04 evening (uncommitted)

Jack reported financials missing from the booking section. Root cause found and
**proven against live data** — a sharper form of B1 than this audit described:

**The pending→posted churn ERASES transactions.** When a pending txn settles, Plaid
sends `removed[pending_id]` + `added[posted_id]` (new id). `plaid_sync` processes
`added` first, and the v0.15.113 content-dedup fingerprint matches the posted twin
against the still-present pending row → posted twin skipped as a "duplicate" → then
`removed` deletes the pending row (synced org-wide) → the transaction is gone from
every device, and the advanced cursor means Plaid never re-serves it. Only txns whose
pending and posted fingerprints are identical are hit — i.e. book transfers and Zelle,
the largest money. Card charges survive because tips/splits change the amount.

Confirmed vanished (server-oplog cross-check of 93 deletes over 9 days; 52 had
surviving twins, 11 flagged, 3 confirmed gone at any amount ±8 days):
$20,650 Dylan Taylor + $20,000 Tytan Market (both posted 08-03, deleted 08-04) +
$3,000 Last Stock LLC (posted 07-22, deleted 07-30) = **$43,650 of incoming money**.
(The $1,358.26 United charge was NOT lost — it settled as split ticket charges
summing exactly.)

**Fix (commands.rs, in the `added` dedup):** a content match is not a duplicate when
(a) the matched row is in this page's `removed` set — it's the retracted pending twin —
or (b) the matched row carries the same Plaid `pa` (one connection never re-serves a
txn under a new id except churn; the fingerprint dedup exists for re-links, which mint
a new `pa`). Unstamped rows keep the old conservative skip. `cargo check` clean.

**Recovery:** local DB backed up (`%APPDATA%/com.bjmdistributions.clienthub/backups/
clienthub.db.pre-repull-2026-08-04`), both cursors reset, full re-pull run through the
fixed code. NOTE: the OTHER Plaid-linked desktop still runs the released (buggy) code
— the vanish continues from that machine until this ships in a release.

Also seen live during verification: two identical $100,000 TYTAN book-transfer rows
dated 07-28 — the duplicate problem is still active in the opposite direction.

---

## ROUND 3 — adversarial hunt, 2026-08-05 (committed `7c1030e`, awaiting a release)

A six-lens adversarial hunt over all financials code (34 findings, 8 verified, each
critical re-checked by hand against the code). **Every fix below was measured against the
live book first: none of them changes a number Jack currently sees.** They are latent, and
two are one bank re-link away from firing.

| # | Fix | Live impact today |
|---|---|---|
| 1 | **A single `fee` allocation replaced a deal's ENTIRE supplier cost** (`deal_bank_actuals`). Tying a $25 wire fee to a deal made its cost $25 instead of the real supplier figure, and that inflated profit is persisted into partner payouts, rep cuts, the 30% tax reserve and free cash. The supplier leg now falls back to the entered cost when only a fee is linked; a fee **adds** to cost, never replaces it. | 45 active deal flows; exactly **1** has a fee allocation and it also has a supplier payment linked → **no recorded profit moves** |
| 2 | **Opening Deal Flow deleted allocations.** `cleanupOrphanAllocations` ran on every mount, deleting rows org-wide with no recovery copy, then rewriting the deal's profit. Its targets point at a transaction missing *right now*, which is often temporary (re-import mid-flight, sync not landed). Removed — same reasoning as the over-allocation healer in v0.15.126. | prevents silent loss; no data change |
| 3 | **Bank balance double-counted across Plaid connections.** `plaid_balances` summed every `plaid_items` row, but one physical account appears under several items after a re-link. Now counted once per real account (`persistent_account_id`, else name+mask+subtype; never the per-connection `account_id`, which is re-minted on every link). | 2 items, 4 distinct accounts → **$0.00 double-counted today** |
| 4 | **The bank's own retractions could delete referenced money with no backup.** The `removed` path is the only *unattended* deleter and the only one writing no recovery copy. It now backs the row up with its allocations inline (so deal linkage survives) before deleting, and uses the broad `bank_txn_is_referenced` gate. That helper was itself missing **loan repayments** — tagged via `counterparty_type`, with `reviewed` deliberately untouched — so any automated delete could remove one and silently inflate loan outstanding, which now feeds free cash directly. | protective; no data change |

### Round 3b — the silent-divergence hole (verified 2026-08-05)

**A money write the server accepts but never applies was abandoned after ~3 minutes.**
Confirmed: `MAX_PUSH_RETRIES = 10` at a 20s poll = **200 seconds** — shorter than a server
deploy or a restart. After that the event is dead-lettered: the row stays correct on the
originating device but **never reaches the server or any other device**, and the only trace
is a log line plus a `sync_dead_letters` row. Verified that **nothing surfaces it**: there
is no Tauri command exposing dead letters, no `api.ts` binding, and the Data safety console
only calls `scanDataIntegrity` / `convergeIntegrityItem`. So the ledger can diverge between
devices permanently with no visible signal.

Raised to **90 attempts (~30 minutes)** — long enough to ride out a deploy or restart, still
bounded so a genuinely poison event cannot wedge the queue head forever (the reason the cap
exists). This reduces the window; it does not close the hole.

**The hole itself is still open and is the top R-019 item:** dead letters must be *surfaced*.
Minimum viable: a command that counts/lists `sync_dead_letters` with their payloads, shown in
the Data safety console and as a banner on Financials when the count is non-zero for a money
table. Nothing may be dropped without Jack being able to see that it was.

**Still open from the hunt** (verified but deliberately not bundled):
- **`resync_completed_deal` revenue ratchet** — a partial buyer payment permanently drags a
  completed deal's recorded revenue down and it never recovers. Real, HIGH, but it *moves
  live P&L on existing deals*, so per `FINANCIALS-PLAN.md` it gets its own release with a
  before/after table shown to Jack first.
- **Content-dedup `LIMIT 1`** picks one arbitrary match, so the churn exemptions can miss
  when the ledger holds more than one matching row (needs two connections to bite).
- **Aggressive "every exact match" dedupe** would destroy real same-day repeats — the
  standing "never press it" warning is the current mitigation.
- **26 unverified leads**, 3 rated critical: a money write the server 200s-but-never-applies
  being dropped from the outbound queue; `restore_snapshot` overwriting local `settings`
  (including `profit_split_json`) with no LWW; and a no-Plaid device republishing a stale
  manual balance as the org's.

### Server: 12 process-wide deadlocks (`clienthub-api` `f130257`, NOT deployed)

`db::conn()` hands out a guard over ONE global non-reentrant `std::sync::Mutex`, and
`sync::record_upsert`/`record_delete`/`sync_category_upsert` take that same lock internally.
Any handler emitting a sync event while holding its own guard deadlocks the thread **while
holding the global DB lock** — every later request touching the DB, for every org, blocks
forever. No error, no log line: sync silently stops until the service is restarted. This is
the most likely mechanism behind any "sync just stopped" report.

11 fixed and committed; the 12th (`main.rs` public signup) is fixed in the working tree but
uncommitted because that file also carries another session's in-flight loads_inbox merge.
**The live droplet still runs the deadlocking build.** Reachable today: create a deal flow,
un-complete a deal, change a deal stage, send a staff message, any category/payment-method
admin action, the public signup form.

*Detection note: scan with brace-depth tracking. A naive "is there a `drop(conn)`" scan
reports 114 sites, nearly all false positives — the real count was 12.*

---

## ROUND 5 — the section-D UI work, 2026-08-05 (committed, unreleased)

Deferred through four rounds of money fixes; Jack called it out. Four independent design
passes + a conflict pass over their edit sets, applied in the prescribed order with a
type-check after each. 24 edits, no rewrite.

| D# | Fixed |
|---|---|
| D1 | **Setup no longer owns the top of the screen.** API-key form (password field included), backup card, import controls, AI categorizer and cleanup tools now sit behind one "Setup and tools" disclosure, closed by default once a bank is connected or any transaction exists. Record cash stays always-visible — it is a daily action. Nothing became unreachable. |
| D10 | **The match chip: an obvious wire is now 1 click, not 8.** The +100 payer / +60 amount scoring already existed and was rendered as the muted word "match". A confident single match now names the deal, says why it matched, and carries a "Tie it" button that allocates the remaining amount with the role inferred from direction. Suppressed on expanded rows, on anything already allocated, and whenever the match is not confident. |
| D3 | **Payee rename is inline**, not `window.prompt()` behind a hover-only pencil that did not exist on touch. Enter/blur commits, Escape cancels; blank or unchanged is a no-op. |
| D6 | **Table stopped scrolling sideways.** Account column dropped (near-constant, and the reason 860px was forced) and moved into the allocation panel header; `min-w` now 560px. Column set verified consistent — expanded panel and chip row both span 8. |
| D11 | **Allocation panel state no longer bleeds between rows.** Opening a different transaction used to inherit the previous row's amount, deal, role and split flag — the most dangerous carry-over on a money screen. |
| D9 | Uppercase kickers removed (absolute design-rule violation, live in the dedupe dialog). |
| D4 | `errText()` applied to all 30 toast sites — no more raw Rust strings, and never an empty toast. |
| D3b | Two confirms now state their consequence (disconnecting stops the live feed; a bulk delete cannot be undone from the app). |

**Still open in section D:** the true four-surface rebuild (To book / Ledger / Cash / Setup)
— the disclosure achieves the daily-use effect, but the full split is a rewrite of the screen
and deserves its own deliberate piece of work. Also: modals still lack Escape/focus-trap and
are not portals (D13); the four near-identical sync buttons are unconsolidated (D5); three
dead Plaid API bindings remain in `api.ts` (D12, pre-existing dead code — flagged, not
deleted).

---

## TL;DR — why each complaint happens

| Complaint | Verdict | Root cause |
|---|---|---|
| "Doesn't refresh on open" | **Opening the screen DOES refetch everything** — but four bugs make it *look* stale: Plaid ingestion is a 20-min timer on one device only, the sync listener has a stale-closure bug, a failed load renders as an empty ledger, and there is no refresh button unless a bank is linked on *this* device. | A1–A7 |
| "Doesn't sync to all platforms/users" | Transaction *data* syncs org-wide within ~20s. What doesn't: cash entries (delayed), review flags (delayed), manual balances (never), auto-tag rules (never), deletion recovery copies (never), bank amendments from Plaid (discarded), and **mobile has zero financials surface at all**. | B1–B10 |
| "Plaid should be green for everyone" | Connection state has **no automatic replication path whatsoever**. The bank link is a deliberately device-local table; the keys never sync; the one bridge that exists is manual, admin-only, login-only, missing `plaid_env`, and returns 500 on the live droplet because its env var was never set. Also: the green check currently means "API keys saved", not "bank linked". | C1–C9 |

---

## A. Refresh-on-open (desktop)

**A0 — What already works.** Every visit to the Financials tab fully remounts the view and
refetches everything. `App.tsx:509-543` renders views conditionally (non-active views are
unmounted), and `setTab` bumps `pageKey` (`App.tsx:86-91`) which keys the pane (`:787`), so
even re-selecting the same tab forces a remount. The mount effect
(`FinancialsView.tsx:320-345`) runs `Promise.all([listBankTxns, bankTxnSummary,
listDealFlows, listLoans, listTxnRules])` plus `plaidConfig` + `plaidListItems`. Nothing is
cached across visits. A `netsync-applied` listener (`FinancialsView.tsx:350-354`) refreshes
the list whenever the 20-second sync loop applies rows (`netsync.rs:26` POLL_SECS=20,
emit at `netsync.rs:691`). **The complaint is real, but the cause is not "no refetch on
open" — it's the items below.**

**A1 — Plaid ingestion is slow and single-device, so "fresh" data is up to 20 minutes old
before sync even starts.** The linking desktop auto-pulls from Plaid 30s after launch and
then every 1200s (`main.rs:489-507`). That's the only automatic ingestion in the whole
system: if that desktop is asleep or closed, **no new bank data appears anywhere, for
anyone**. Other desktops then get the rows via netsync (+≤20s). The phone never gets them
(B10). The "Auto-syncing" label (`FinancialsView.tsx:1368`) is technically true but
describes a 20-minute cadence on one machine. Fix direction: plan Phase 4 (server-owned
webhook feed) is the real answer; a cheap interim is a shorter interval + a visible
"last pulled from bank at HH:MM" stamp instead of the vague label.

**A2 — Stale-closure bug in the live-refresh listener.** The `netsync-applied` effect has
`[]` deps and captures the first render's `refreshAll` (`FinancialsView.tsx:350-376`), in
which `openId` is always `null`. So when sync applies rows while an allocation panel is
open, the table refreshes but the open row's allocations/amount field are left stale —
exactly the state that produces double-allocation mistakes. Same effect: if the component
unmounts before `listen()` resolves, the listener is never removed (leak). Fix: keep
`refreshAll` in a ref, or re-subscribe on `openId` change; return a cleanup that awaits the
promise.

**A3 — A failed load is indistinguishable from an empty ledger.** The mount `Promise.all`'s
catch only toasts the raw error (`:333`) and flips `loading` off — the user then sees the
"No transactions yet / Import a statement" empty state with no error message and no retry
control. Every sub-fetch failure (`:329, :332, :342-343, :352, :632`) is swallowed
entirely. Fix: distinct error state with inline retry.

**A4 — No way to manually refresh unless this device has a linked bank.** All refresh
controls live inside the Bank feed card and are gated on `plaidReady === true` (`:1764`)
and `plaidItems.length > 0` (`:1774`). A second admin's machine (no local Plaid link — see
section C) has **no refresh button at all**; the only way to re-read the ledger is to leave
the tab and come back. Fix: one screen-level refresh, always present.

**A5 — Silent refreshes shift rows under the cursor.** `refreshAll` (`:364`) sets no busy
flag; loading is a bare centered spinner (`:2251-2254`) so page height collapses and jumps.
Plan §6 already specifies skeleton rows at exact row height.

**A6 — The heal path doesn't notify the UI.** `netsync-applied` fires only when a pull
applies oplog events (`netsync.rs:688-691`). `restore_snapshot` (the Repair/heal path)
writes raw rows without oplog events, so a healed ledger doesn't refresh an open Financials
screen until remount.

**A7 — Two write-capable "heals" run as a side effect of opening the page.**
`cleanupGhostDealFlows()` (`:329`) and `healOverallocatedTxns()` (`:332`) fire on every
mount. The over-allocation healer **deletes whichever allocation was created last**
(`commands.rs:10965`, plan G7) — a destructive judgement call triggered by merely looking
at the screen, with no confirmation and no backup of deleted allocations. Fix: move healing
behind an explicit control (or make over-allocation a surfaced conflict, per plan decision
#5).

---

## B. Cross-device / cross-user sync of financial data

**B0 — What already works.** All the core money tables replicate org-wide in both
directions and both snapshot paths: `bank_txn`, `bank_allocation`, `refunds`, `loan`,
`cash_purchase`, `business_expense`, `reserve_entry`, `deal_receipts`, `offers` (desktop
`sync.rs:483`, `netsync.rs:38-49`; server `sync.rs:1454-1462`, `:1601-1610`). Most
financial writers call `push_now()` so peers see changes in ~20s.

**B1 — Plaid's `modified` array is discarded on both sides.** Desktop `plaid_sync` reads
only `added` (`commands.rs:12262`) and `removed` (`:12349`); server `routes/plaid.rs:347-376`
same. Any bank-side amendment — pending→posted amount change, date correction, description
rewrite — **never lands on any device**. The ledger permanently holds the first-seen
version. Also no `pending` filter anywhere: unsettled transactions are imported, then
churned via `removed` (which silently unlinks allocations, warn-logged only,
`commands.rs:12423`). Plan Phase 0 items; still unshipped.

**B2 — Recovery copies don't travel, but the deletes they protect do.**
`bank_txn_deleted_backup` is deliberately unsynced (`db.rs:1553-1567`) while
`clear_bank_txns` / `delete_bank_txns` / `dedupe_bank_txns` all emit synced deletes. Delete
on device A → the row disappears org-wide, but the only recovery copy sits on A. Lose or
reinstall A and recovery is gone for the whole org. The 8ded3e6 fix closed this hole for
one device only.

**B3 — `add_cash_transaction` has no `push_now`** (`commands.rs:11066`, ends `:11123`
without one). Manually recorded cash — the one class with no Plaid re-pull backstop — waits
for the next 20s tick, and if the app closes first, sits in the outbound queue until next
launch. Every other financial mutator pushes immediately. One-line fix.

**B4 — `set_bank_txn_review` has no `push_now`** (`commands.rs:10568-10582`). Two admins
working the queue simultaneously each see rows as unbooked for up to a poll interval —
inviting exactly the double-booking the reconciliation engine exists to prevent. One-line
fix.

**B5 — Manual balances sync through no channel at all.** `money_bank_balance` /
`money_credit_card_balance` (written `commands.rs:12515-12516`) are in neither
`SHARED_SETTINGS_WHITELIST` (`routes/settings.rs:244-261`) nor server `PUSHABLE`. The
`/api/bank-balance` publish channel only fires from a Plaid-linked device with Financials
open (`commands.rs:12540`). An org with no Plaid link shows a different Free Cash figure on
every device, forever.

**B6 — Auto-tag rules (`txn_rule`) are device-local** (`db.rs:1413-1418`). The same
incoming transaction is auto-categorized on one device and raw on another; the resulting
`bank_txn` edits then fight by HLC last-writer-wins.

**B7 — `settings` is one-way.** Desktop `write_setting` emits oplog events
(`commands.rs:6121-6132`) that the server always rejects (`sync.rs:1489-1491`, `settings`
absent from PUSHABLE). Only the ~40 allowlisted keys escape via `push_shared_settings`.
Known standing gap (vault: settings-scoping); it bites Financials via B5 and C4.

**B8 — Auto-heal skips `refunds` and `offers`.** One-shot heal-on-connect
(`netsync.rs:1285-1331`) checks `key_tables` (`:1307-1311`) that omit both. A device that
drifts on those tables after generation 3 never self-heals; only the manual Restore button
covers them.

**B9 — Sync has no role filtering — the full ledger reaches every org member's disk.**
`pull_events` / snapshots filter on `org_id` only (`clienthub-api/src/sync.rs:1560-1566`,
`routes/netsync.rs:52-118`). The Financials tab is hidden client-side
(`App.tsx:454`, `financials:view`), but every member's local SQLite holds every bank
transaction. Freshness: great. Confidentiality: a decision Jack should make consciously,
especially before inviting non-admin staff.

**B10 — Mobile: zero financials surface.** No `plaid`/`bank_txn` reads anywhere in
`www/app.js` (only incidental strings, e.g. `:4938` "Financial details are restricted for
your role"), no `/api/bank-balance` consumer, no bank data on the server dashboard either
(`routes/dashboard.rs`: zero matches). "Sync to all platforms" is structurally impossible
until plan Phase 3 (mobile Financials screen + delta endpoint) is built. Tracked as R-001.

**B11 — Restore-from-server exposure from the plan is still open.** The restore path is
tombstone-aware (`netsync.rs:1096-1109` skips rows with local delete records — correct for
keeping deletes deleted), but the plan's Phase 0 counterpart — **clearing stale delete
records on the ~1,109 live rows that carry them** — has not shipped. Until it does,
"Restore from server" on a damaged DB still recovers only the untombstoned slice (~11% at
plan-time measurement). Re-verify the counts before relying on restore. Highest-stakes
open item in this document.

---

## C. Plaid "connected, green, for everyone"

**C0 — What the green check actually means today.** The ✅ "Connected · Production" badge
(`FinancialsView.tsx:1681-1688`) is driven by `plaid_config` → `has_keys()`
(`plaid.rs:35-43`) — it means **"API keys are saved on this machine"**, not "a bank is
linked". The bank list and "· N connected" chip come from a plain SELECT on the local
`plaid_items` table (`commands.rs:12145-12162`). Two different truths, one visual.

**C1 — The connection object has no replication channel.** `plaid_items` is device-local by
design (`db.rs:1385-1401`: "DEVICE-LOCAL ONLY (never synced)") and appears in none of the
four sync allowlists (desktop `sync.rs:483`, `netsync.rs:38-49`; server `sync.rs:937+`,
`:1454-1462`, `:1601-1610`). The keys are written with a plain execute, deliberately not
`record_upsert` (`plaid.rs:45-58`), and `plaid_secret` would be stripped from snapshots by
`is_secret_key` anyway (`clienthub-api/src/sync.rs:661-667`).

**C2 — The only bridge is manual, admin-only, and login-only.** The org-secrets bridge
(`netsync.rs:1531-1596` push, `:1606-1661` materialize) carries `plaid_client_id`,
`plaid_secret`, and each `plaid_items` row as `plaid_item_{item_id}`. But:
- Push fires **only** when someone clicks Settings → "Share my connections with my team"
  (`commands.rs:13995-14004`). Nothing triggers it on link.
- Materialize runs **only** inside `netsync::connect()` (`netsync.rs:832`) — i.e. at server
  sign-in. A device already signed in never re-checks. No timer, no exposed command.
- Both endpoints require `admin:manage` (`routes/org_secrets.rs:21-26`). **A non-admin org
  member can never receive Plaid state, by design.**

**C3 — The bridge is dead on the live droplet anyway.** `clienthub-api.service` sets only
`CLIENTHUB_DB_PATH` — no `CLIENTHUB_SECRET_KEY`, no `PLAID_TOKEN_KEY`. So
`store_available()` is false and both org-secrets routes return
`500 "secret store not configured"` (`routes/org_secrets.rs:39-45`), and the automatic
per-link handoff `push_plaid_item_to_server` (`netsync.rs:1664-1689` →
`POST /api/plaid/items`) returns `500 "token store not configured"`
(`routes/plaid.rs:92-101`). **Even the happy path silently fails in production today.**

**C4 — `plaid_env` is in no allowlist** (`netsync.rs:1500` — only client_id, secret,
shopify webhook secret). `get_env()` falls back to `"production"` (`plaid.rs:14-21`). A
sandbox-linked item materialized on device B would fail every call. One-line fix.

**C5 — Even a successful materialize doesn't light up the UI.** It runs during sign-in;
FinancialsView fetches Plaid state once on mount (`:336-343`). No event, no invalidation —
the user must restart or remount before the row appears.

**C6 — Disconnect doesn't propagate either.** `plaid_remove_item` deletes locally but the
`plaid_item_*` org secret survives (documented in `FIXPLAN-AUDIT.md:696-699`), so the next
materialize resurrects a dead connection.

**C7 — No server endpoint can answer "is this org's bank connected?".** There is no GET for
`/api/plaid/items` and no status route. The closest thing is `GET /api/bank-balance`
returning `{"connected": bool}` (`routes/settings.rs:113-119`), which really means "a
balance was once published".

**C8 — Exact causal chain for "device B shows disconnected":** device A links → row in A's
local `plaid_items` only → keys never leave A → the automatic server handoff 500s (C3) →
the manual bridge was never clicked, and B only materializes at sign-in anyway (C2) → B's
`plaidReady` is false, so B renders the **raw API-key entry form** (with a password field)
instead of a connected badge, and the entire sync toolbar never renders (`:1679-1799`).
Meanwhile the *transactions* A pulled DO sync to B — producing the confusing observed
state: **"I have bank transactions but no bank connected."**

**C9 — The fix path that doesn't move any secret** (recommended order):
1. **Server-side status, not secret-sharing, lights the green dot.** The server already has
   an org-scoped `plaid_items` table with institution/accounts_json/env/needs_reauth
   (`clienthub-api/src/sync.rs:466-482`) populated by `POST /api/plaid/items`. Add a
   read-only, org-scoped, non-admin GET returning institution, account count, env,
   needs_reauth, last_synced — **never** `access_token_enc`. Caveat: it must live in a
   deployable module (e.g. `routes/settings.rs`), because the deploy guard hard-blocks
   shipping `routes/plaid.rs`/`plaid.rs` (no-erase.sh:63-66) and that rule stands until
   Phase 4 is deliberately done.
2. Desktop + (future) mobile render "Connected — Chase, 2 accounts (linked on Jack's PC),
   last pull 12:40" from that endpoint. Green for every user, every platform, no secrets
   moved, works even for non-admins.
3. Make `POST /api/plaid/items` actually succeed: Jack sets `CLIENTHUB_SECRET_KEY` /
   `PLAID_TOKEN_KEY` in the systemd unit himself (credentials are his to enter, not the
   agent's).
4. Split the UI truths: keys-saved ≠ bank-linked ≠ feed-healthy. Three distinct states.
5. Small hardening regardless: add `plaid_env` to the sharable keys (C4); auto-call the
   secrets push after a successful link *if* Jack wants key-sharing at all; delete the
   `plaid_item_*` secret in `plaid_remove_item` (C6); re-materialize on a cadence, not
   only at sign-in (C5).
6. The full "any admin device can pull the feed" story is plan Phase 4 (server-owned
   webhook ingestion) — deliberately its own release. Do not deploy server `plaid.rs` as a
   side effect of the status work.

---

## D. UI improvements (desktop)

`FINANCIALS-PLAN.md` §6 + UI appendix Part 1 is the full design spec; it remains accurate.
Audit-verified highlights, ranked:

1. **~850 lines of JSX above the transaction list, ~390 of it setup/admin chrome**
   (`FinancialsView.tsx:1397-1908`): Plaid API-key form **including a password field**,
   Google-Sheet backup card, import previews, and five destructive/repair buttons — all
   above the daily work. Plan's four-surface split (To book / Ledger / Cash / Setup) is the
   answer.
2. **The green check mislabel** (C0) — smallest possible change with the biggest trust
   impact: rename to "API keys saved" until real status exists.
3. **Six native browser dialogs**: `confirm()` at `:569, :577, :651, :782, :946` and
   `window.prompt()` for payee rename at `:1243` — a hover-only pencil that doesn't exist
   on touch.
4. **Raw Rust errors surfaced verbatim** via `toast(String(e))` at 27 call sites.
5. **Four near-identical sync buttons** (Refresh from bank / Sync now / Re-pull all / Clear
   all & re-pull, `:1777-1807`) distinguished only by tooltips, plus a duplicate Refresh at
   `:1651`. Destructive "Clear all & re-pull" sits in the same row as routine actions.
6. **9-column table forced to `min-w-[860px]`** (`:1169-1170`), rendered **twice** in split
   view (`:2269-2296`) → horizontal scrolling in both panes at normal widths. The
   allocation panel mounts inside a `<td colSpan={9}>` and can be scrolled away from its
   own transaction.
7. **Counters disagree by construction**: queue tabs count `reviewed` while "Needs a deal"
   counts unallocated (plan G2's three definitions). The user can't tell which backlog is
   real.
8. **Empty state points at the wrong door** ("Import a statement" for a bank-feed account,
   `:2255-2265`); filtered-empty has no clear-filters affordance (`:1348-1350`).
9. **Uppercase kickers** — standing design-rule violations: `:1532`, `:1555`, plus the
   uppercased file-format at `:1915`.
10. **The match-scoring work is thrown away**: deals are scored (+100 payer hit, +60 exact
    amount) and rendered as the lowercase word "match" (`:1153-1160`). Plan's match-chip
    ("Looks like INV-2026-0041 — [Tie it]") turns 8 clicks into 1.
11. **Allocation panel state bleeds between rows** (`:307-318` parent-owned state: open row
    A, type, close, open row B → form pre-loaded with A's context). Combined with A2 this
    is the most error-prone surface on the page.
12. **Dead code**: `plaidHasKeys` / `plaidLinkToken` / `plaidExchange`
    (`src/lib/api.ts:2250-2257`) have zero call sites.
13. Modals are inline `fixed inset-0` divs — no Escape, no focus trap, no portal
    (`:1460, :1590`). Sub-tab state resets on every visit (`tab` default `:187`).
14. `FreeCashView` remains the reference for how the rest should look (plan §1.13).

---

## E. Recommended work order

Weeks-long items live in the plan's phases; this is the audit's ordering of the **small,
high-leverage fixes** that can ship independently and address the complaints directly:

| # | Fix | Size | Addresses |
|---|---|---|---|
| 1 | `push_now` in `add_cash_transaction` + `set_bank_txn_review` | 2 lines | B3, B4 |
| 2 | Add `plaid_env` to `SHARABLE_SETTINGS_KEYS` | 1 line | C4 |
| 3 | Fix the `netsync-applied` stale closure + unlisten leak | small | A2 |
| 4 | Screen-level refresh button, ungated | small | A4 |
| 5 | Error state ≠ empty state, with retry | small | A3 |
| 6 | Rename the green check to "API keys saved"; separate keys/linked/feed states | small | C0 |
| 7 | Jack sets `CLIENTHUB_SECRET_KEY`/`PLAID_TOKEN_KEY` on the droplet (his hands, not the agent's) | config | C3 |
| 8 | Read-only org-scoped Plaid status endpoint in a deployable module + UI consumes it | medium | C7→green-for-everyone |
| 9 | Stop auto-running destructive heals on mount | small | A7 |
| 10 | Phase 0 leftovers: stale-tombstone clearing (restore exposure), `modified` handling, `pending` filter | medium | B11, B1 |
| 11 | Manual-balance sync (add to shared-settings allowlist or bank-balance channel) | small | B5 |
| 12 | Plan Phase 2 (UI four-surface rebuild), Phase 3 (mobile), Phase 4 (server feed) | large | D, B10, A1 |

Items 1–6 and 9 are safe, local, and could ship as one small release. Items 7–8 make the
green dot real for every user on every platform without moving a single secret. Item 10 is
the highest-stakes data-safety item in the file. Confidentiality decision B9 needs Jack's
call, not code.

---

## F. Overview tab (Free cash — `FreeCashView.tsx`)

Added same day, after Jack asked whether Overview and Loans were covered. The plan calls
Free cash the best-*designed* screen in the app; the design holds, but the **numbers on it
are the least trustworthy in Financials**. Findings keep the agent's OV-n numbering.

**Money-correctness (the serious ones):**

- **OV-8 — A failed/empty Plaid item reports a live $0 balance and publishes it
  org-wide.** `has_plaid` is set per `plaid_items` row *before* the accounts JSON is
  parsed (`commands.rs:12659-12661`); an item whose accounts fetch failed (stored as
  `"[]"`, written at `:12262/:12290`) yields `(0.0, 0.0, true)` → `balance_source="live"`,
  bank balance $0, manual fields locked read-only (`FreeCashView.tsx:303-305`), **and $0/$0
  published over the good balance for every other device** (`:12715`). Severity: high.
- **OV-9 — Tax and refund reserves are phantom deductions that never draw down.** Both are
  `year_profit × pct` with defaults 0.30 + 0.30 (`commands.rs:12774-12791`, `:12681-12682`)
  — 60% of YTD net profit permanently subtracted from free cash. Nothing subtracts taxes
  actually paid; the `reserve_entry` table exists and syncs (`db.rs:1347-1358`) but has
  **no reader or writer anywhere**. Severity: high.
- **OV-10 — Loan repayments from the bank feed don't reduce loan outstanding until a human
  clicks Apply per-loan on the Loans tab** (`commands.rs:12794-12796` vs `:13098-13114`).
  The repayment has already reduced the bank balance, so free cash is understated by every
  unapplied repayment, indefinitely — a double-count. Severity: high. (Frontend half: LN-6.)
- **OV-24 — Manual bank/card balances never sync, but every deduction does.**
  `money_bank_balance`/`money_credit_card_balance` are in no sync channel
  (`netsync.rs:1924-1940` whitelist omits them; settings not pushable). A second device
  with no Plaid link and nothing published computes free cash as synced liabilities minus a
  **zero** balance → a large, confident, false negative number. Severity: high. (= B5,
  now with the exact blast radius.)
- **OV-3 — Save can zero the whole money config org-wide.** `loadConfig()` swallows errors
  (`FreeCashView.tsx:88-100`), the Adjust modal opens without waiting for it (`:169`), and
  `save()` coerces empty buffers with `Number(x) || 0` and writes all six keys
  (`:111-118`). A failed config load + Save zeroes cash floor, both reserve percentages and
  war chest — and those keys DO sync. Severity: high (silent data loss).
- **OV-6 — Overview blocks up to 30s on a network GET** on any non-Plaid device:
  `financials_overview` awaits `fetch_published_bank_balance()` with a 30s-timeout client
  (`commands.rs:12717`, `netsync.rs:193-197`) — on mount, on every Refresh, after every
  Save. Severity: high (feels like the page is broken).
- **OV-7 — A read command performs a network write on every render** — `financials_overview`
  spawns `publish_bank_balance` (`commands.rs:12715`) on every mount/refresh/Analytics
  load; and it's the *only* publisher, so if nobody opens Overview on the Plaid device, the
  "synced · as of" figure other devices trust goes arbitrarily stale. Severity: medium-high.
- **OV-12 — The "unallocated over 7 days" alert fires forever on loan money** (and any
  legit non-deal inflow): loan tagging creates no allocation (`commands.rs:13017-13043`),
  and the alert counts every short-allocated inflow except `internal_transfer`
  (`:12818-12822`). Same definition drives the Transactions summary, so both tabs are wrong
  identically. Fixed properly by the plan's non-deal destinations (owner draw / expense).
- **OV-13 — Analytics' free-cash breakdown omits `cash_floor`** so it doesn't reconcile to
  the total it prints (`AnalyticsView.tsx:737-748` vs `commands.rs:12798`).
- OV-11 — `cash_floor` unclamped (negative floor inflates free cash; `"30%"` silently
  becomes 0). OV-14 — "reconciled" sums inflows+outflows into one meaningless figure.
  OV-15 — Adjust modal displays the live number but Save re-persists the stale manual one.
  OV-16 — percent round-trip float noise (`7.000000000000001`). OV-17 — dead
  `status`/`runway_months` computed from a table with no writer.

**Lifecycle/UI:** OV-1 — no `netsync-applied` listener; remote changes update Transactions
but leave Free cash stale while open. OV-2 — failed load = skeleton forever. OV-4 — raw
error strings. OV-18/19/20 — nested double page-header, off-axis 720px column, three
different h2 sizes across the three sibling tabs. OV-21 — negative money renders as
`$-1,234.50`. OV-22 — locked fields are readOnly-but-focusable, not disabled.
OV-5/23 (positive) — has a real refresh control; no kickers, no native dialogs, honest
empty states.

---

## G. Loans tab (`LoansView.tsx`)

- **LN-5 — A "Paid off" loan still shows its full Outstanding, in success green**
  (`markPaid` flips status only, `commands.rs:12920-12943`; card renders
  `principal − set_aside` untouched, `LoansView.tsx:306-317`). Overview correctly drops it,
  so the two tabs disagree about the same loan. Severity: medium-high.
- **LN-6 — Feed repayments need a manual per-loan Apply click**, which only ever increases
  `set_aside` (`commands.rs:13098-13114`; guard `LoansView.tsx:282`) — untag a repayment
  later and the figure stays inflated with the button gone. Backend half is OV-10.
- **LN-7 — No interest/fees in the model** — repaying with interest produces
  `set_aside > principal` unclamped: "Principal $10,000 / Set aside $11,000 /
  Outstanding $0.00".
- **LN-8 — `delete_loan` orphans every tagged transaction** (`commands.rs:12947-12952`
  clears nothing on `bank_txn`; the confirm() doesn't mention them). They keep
  `category='loan_repayment'` and render as a loan row with no name.
- **LN-9 — Loans created here never set `bank_txn_id`** (`LoansView.tsx:107` passes `""`),
  which defeats the dedupe-sweep guard `bank_txn_is_referenced` (`commands.rs:11581`) for
  the disbursement transaction.
- **LN-19 — No loan write calls `push_now`** (create/update/delete/apply/tag/untag all stop
  at `record_upsert`) — up to 20s lag org-wide. Same one-line fix class as B3/B4.
- **LN-1/2/3 — Mount-only load, no sync listener, no refresh control at all; a failed load
  is pixel-identical to "no loans"; raw `String(e)` toasts at 7 sites.**
- LN-10 — no validation (negative principal accepted, set-aside > principal silent).
  LN-11 — two native `confirm()` dialogs (app-wide pattern: ~66 call sites in src).
  LN-12 — icon-only delete with no label. LN-13/14 — nested horizontal scroll + truncation
  inside cards. LN-15 — "$0.00 across 0 open loans" tile above the empty state. LN-16 — no
  filter/sort; paid loans accumulate forever. LN-17 — edit form opens at page top, far from
  the card. LN-20 (positive) — loan data does replicate and heal.

---

## E2. Additions to the work order (from the Overview/Loans pass)

These slot into the section-E list; the first three belong near the top:

| # | Fix | Size | Addresses |
|---|---|---|---|
| E2-1 | Parse accounts JSON before setting `has_plaid`; never publish $0 from a failed item | small | OV-8 |
| E2-2 | Don't await the published-balance GET in `financials_overview` (short timeout / cache / background) | small | OV-6 |
| E2-3 | Guard `save()`: never write config keys whose load failed or whose buffer is empty | small | OV-3 |
| E2-4 | Auto-apply feed repayments to loan set-aside (or compute outstanding from the ledger) + `markPaid` zeroes outstanding | medium | OV-10, LN-5, LN-6 |
| E2-5 | Reserves: either wire `reserve_entry` (real draw-downs) or present reserves as a *target*, not a deduction | medium + Jack decision | OV-9 |
| E2-6 | `push_now` on loan writes; `netsync-applied` listener + refresh control on both tabs | small | LN-19, OV-1, LN-1 |
| E2-7 | `delete_loan`: untag or block when tagged transactions exist | small | LN-8 |
| E2-8 | Publish the balance after Plaid sync (background), not only on screen view | small | OV-7 |

---

*Evidence gathered 2026-08-04 by three independent read-only code exploration passes over
`BUSINESS APP` (desktop) and `clienthub-api` (server + PWA), reconciled against
`FINANCIALS-PLAN.md` and the live git history, extended same day with a fourth pass over
the Overview and Loans tabs (sections F/G/E2). One agent claim was corrected during
reconciliation: a 20-minute Plaid auto-sync timer DOES exist (`main.rs:489-507`); and the
"tombstone-restore fixed" claim was narrowed — the restore path is tombstone-aware, but the
stale-tombstone clearing that plan Phase 0 calls for has not shipped (B11).*
