# Calendar-blocks audit — R-159 — 2026-08-18

**Jack's requirement:** every week/month filter and bucket, on every surface, must be a strict calendar block — weeks Monday 00:00 → Sunday 23:59:59, months 1st → last day, in his local time (America/Chicago).

**Method:** 19-agent sweep over desktop (`src/` + `src-tauri/`), server (`clienthub-api/src/`), mobile PWA (`clienthub-api/www/app.js`), plus a coverage critic. 149 sites catalogued and adversarially verified against the code (145 confirmed, 4 corrected), 15 more found by the critic. BJM website checked: zero week/month filters, out of scope.

**Verdict: NOT strict everywhere.** The window *shape* is mostly right — every week boundary in the codebase that computes a week start uses Monday (zero Sunday-start weeks found anywhere), and month buckets are true 1st-to-last blocks. The violations are five recurring patterns, not fifty random bugs.

---

## Pattern A — "This week" stats that are actually rolling last-7-days

The only places a "week" is not Monday–Sunday at all. `date('now','-7 days')` (also UTC).

| Site | Serves |
|---|---|
| `src-tauri/src/commands.rs:9227` `revenue_this_week` | desktop dashboard_stats (currently unrendered on desktop) |
| `src-tauri/src/commands.rs:9235` `clients_this_week` | same |
| `src-tauri/src/commands.rs:9243` `interactions_this_week` | same |
| `clienthub-api/src/routes/dashboard.rs:134-136` same three fields | **mobile dashboard renders these as "this week" cards** |

Fix: Monday-00:00-local → now (week-to-date), matching the brief's window math. Note the brief already computes these correctly, so today mobile's dashboard and mobile's brief disagree about "this week."

## Pattern B — calendar blocks anchored on the UTC clock

The window math is calendar-correct, but "today" comes from UTC (`Utc::now()`, `toISOString().slice(...)`, SQLite `'now'` without `localtime`). Every evening 6/7 PM–midnight Central, "today" is tomorrow: on Sunday evenings "this week" flips to the next (empty) week; on the last evening of every month, every "this month" figure flips to the next (empty) month, ~5–6 hours early.

| Site | What flips |
|---|---|
| `src-tauri/src/commands.rs:10190` | Brief anchor — the whole desktop brief (week AND month views) |
| `src-tauri/src/commands.rs:10269` | Brief month stats (MTD profit, margin, payouts) — also ignores the browsed anchor |
| `src-tauri/src/commands.rs:9408` (+9402, 9417, 9431, 9339) | Desktop dashboard hero "This month" revenue/profit, prev-month delta, "Completed this month" |
| `src-tauri/src/commands.rs:9101` | Profit forecast `actual_profit_mtd` |
| `src/components/AnalyticsView.tsx:104` | "This month" preset pill (also lines 98-100: computed once at bundle load — stale after midnight until reload) |
| `src/components/BriefView.tsx:63` (+71) | Brief prev/next navigation anchor |
| `src/components/DashboardView.tsx:93` | Cumulative chart's initial month key |
| `clienthub-api/src/routes/dashboard.rs:91/93/127/225` | Mobile dashboard hero month stats |
| `clienthub-api/src/routes/dashboard.rs:456/471-483` | Mobile brief anchor (PWA sends no `?date` on the default view — verified app.js:6844) |
| `clienthub-api/src/routes/dashboard.rs:503` | Mobile brief month stats — ignores `?date` entirely |
| `www/app.js:6829` | Mobile brief "today" anchor |
| `www/app.js:4187` (+4241) | Mobile dashboard chart initial month key + next-arrow clamp |
| `www/app.js:4071/4082/2167` | Mobile hero + analytics "this month" (server-driven, same root) |

Fix: anchor on local/Central date — Rust `Local::now().date_naive()` (or explicit America/Chicago on the server), JS local `getFullYear()/getMonth()/getDate()`, SQLite `'now','localtime'`. **Decision D-1 below for the server.**

## Pattern C — month/day labels rendered one month/day early (UTC parse + Central render)

The shipped R-131 bug class, still live. `new Date("YYYY-MM-01")` parses UTC midnight; local render shows the previous evening — so the label is wrong **on every render, all day, for every row**, not just evenings.

| Site | Effect |
|---|---|
| `src/components/AnalyticsView.tsx:204` | **Both monthly charts label every bucket one month early** ("2026-08" renders "Jul 26") |
| `src/components/BriefView.tsx:280` | Brief month-history rows all one month early |
| `www/app.js:6878` | Mobile brief monthly history — same |
| `src/components/CloseoutView.tsx:170` | Completed date shows one day early — on the screen whose job is verifying which month a deal buckets into |
| `src/components/SupplierDealsModal.tsx:108` | Same one-day-early render |
| `src/components/RefundWorkspace.tsx:23`, `ReconciliationPanel.tsx:21` | Bank txn dates render one day early (display-only) |

Fix: parse with local constructor `new Date(y, m-1, d)`. The safe helper already exists in-repo three times (`SuppliersView.tsx:62`, `LoansView.tsx:14`, `app.js:120 monLabel`) — reuse it.

## Pattern D — UTC "today" defaults on date inputs that WRITE data

After 6/7 PM Central the default date is tomorrow; on a month's last evening it's the next month. These persist into `completed_at` / `paid_at` / `posted_at` / `issue_date` — the exact fields all month bucketing runs on (the "$47,920 of August sat in July" family).

| Site | Field written |
|---|---|
| `src/components/FinancialsView.tsx:1575` | **invoice issue/due date backfill — no UI, silently persisted** |
| `src/components/ReceivablesView.tsx:97` | payment "Date received" default |
| `src/components/InvoicesView.tsx:83` (+129) and `:491-492` | mark-paid date, new-invoice issue/due defaults |
| `src/components/CloseoutView.tsx:237`, `CompletedBreakdown.tsx:49` | completed-date editor defaults |
| `src/components/DealFlowView.tsx:1760` | complete-deal date default |
| `src/components/FinancialsView.tsx:2618` (+815) | record-cash date default |
| `src/components/ReconciliationPanel.tsx:505` | manual cash line date default |
| `src/components/LoansView.tsx:8` | loan received date default |
| `www/app.js:5340` | mobile paid stamp `new Date().toISOString()` |
| `src/components/QuotesView.tsx:382` | quote valid-until default (minor) |
| Rust write paths: `commands.rs:4380` (completed_at fallback), `:4286` (paid_at), `:2204` (issue_date default) | UTC RFC3339 entry stamps that bucket by UTC day |

Fix: one shared `localDay()` helper (exists at `FinancialsView.tsx:1840`) used by every default; decide stamp policy for the Rust fallbacks (D-2).

## Pattern E — "Monthly" recurrence that advances +30 days

Configured as "Monthly," drifts backwards through the calendar (12 cycles = 360 days).

| Site | Feature |
|---|---|
| `src-tauri/src/commands.rs:2951` (+2962) | recurring invoices |
| `src-tauri/src/commands.rs:15556` | desktop newsletter schedule |
| `clienthub-api/src/scheduler.rs:96` | server newsletter/scheduled sends |

Fix: add one calendar month, clamp the day (Jan 31 → Feb 28). Weekly (+7d) is correct as-is.

## Smaller confirmed defects (fix alongside)

- **Brief "Monthly" prev/next steps ±30 days** instead of a calendar month: desktop `BriefView.tsx:64`, mobile `app.js:6831`. From a day-31 anchor the prev arrow re-shows the same month (looks dead); from Mar 1 it skips February entirely. Use the `shiftMonth` pattern (`app.js:4210`).
- **Brief "Activity this week" counts have no upper bound**: desktop `commands.rs:10417` (via BriefView:401/412), server `dashboard.rs:690/694` (via app.js:7092). Current week is fine; any browsed past week shows Monday-to-*now* counts.
- **Mobile loss-deals alert card is dead**: `app.js:4121` reads `s.loss_deals` but the API serializes `loss_deals_this_month` — can never render.
- **Brief "Daily" cadence actually shows the full week** (`commands.rs:10216` `.max(1)`, BriefView:18) — mislabeled bucket.
- **"This week at a glance" headings stay "week" under Biweekly/Monthly cadence** (BriefView:173 + 3 more strings) — should say "this period" like the neighboring strings.
- **Mobile analytics "vs last month" chip** (`app.js:2167`) compares the last two months *with data*, which may not be the labeled pair.
- Stale comments that contradict the now-correct code: `commands.rs:10194-10195`, `BriefView.tsx:214-216` — delete so nobody "fixes" the calendar logic back to rolling.

## What is already correct (leave alone)

- Week construction is Monday-start everywhere it exists: `commands.rs:10217`, server `dashboard.rs:483-497`. **No Sunday-start week exists in the platform.**
- Month bucketing by stored date (`GROUP BY strftime('%Y-%m', …)`): desktop 9273/9622/9856, server 147/550 — true calendar months.
- DashboardView month navigation/label (152/158/121), mobile `shiftMonth` (4210) and daily bucketing (4245), `monLabel` (120).
- Financials "this month" chip (`FinancialsView.tsx:1832`) and tax-year ranges (526/1948) — local and strict.
- Settings rep-payout default range (SettingsView:4691) — strict current month, end-exclusive.
- Honest rolling windows labeled in days (aging buckets 1–30/31–60/…, "Last 7/30/90 days" automation-log filter, supplier "Used in 30/90 days", client "30+/60+/90+ days", "Next 7 days" shipping, due-soon 7-day chips, retention pruning) — not lying; see D-3.

## Decisions needed (before building)

- **D-1 Server timezone**: the droplet serves the PWA; "this month" there needs a timezone. Options: hardcode America/Chicago (simple, right for BJM; wrong for future multi-tenant), or have the PWA always send its local date (right long-term; touches every call site). Recommendation: hardcode Central now via one shared helper, noted for SaaS revisit.
- **D-2 Historical data**: rows whose `completed_at`/`paid_at` were UTC-evening-stamped sit in the wrong month today (R-131's $47,920 case). Fixing the filters does not move them. Backfill/re-derive is a separate, data-touching job — propose auditing counts first.
  **[CORRECTED 2026-08-19, measured against the live DB]:** mostly moot — all 36 completed deals with a buyer bank leg already have `completed_at` == the leg's bank date (repaired by a 2026-08-12 "Sync from bank" pass; the $47,920 case is FIXED — do not re-quote it). Only residue: `posted_at` rows UTC-stamped within hours of a month boundary, a handful at most. No book-wide migration.
- **D-3 Rolling filters labeled in days**: "Last 7 days" etc. are honest. Keep them rolling (recommended — aging/staleness is inherently rolling), or convert to calendar blocks too?
- **D-4 Monthly recurrence day**: calendar-month advance clamps Jan 31 → Feb 28. OK?

## Proposed build order

1. **Labels lying every render** (Pattern C) — small, zero-risk, biggest visible wrongness. Desktop + mobile.
2. **Rolling "this week" → Monday week-to-date** (Pattern A) — desktop commands.rs + server dashboard.rs (server deploy per runbook).
3. **UTC anchors → Central** (Pattern B) — one shared date-anchor helper per runtime; needs D-1.
4. **Write-path defaults → localDay()** (Pattern D) — stops new data landing in wrong months; Rust stamp policy per D-2.
5. **Monthly recurrence + small defects** (Pattern E + list above) — needs D-4.
6. **Data backfill audit** (D-2) — count affected rows, then decide.

Full per-site detail (149 verified sites + 15 critic finds, with code quotes): `CALENDAR-AUDIT-2026-08-18-details.txt` alongside this file.
