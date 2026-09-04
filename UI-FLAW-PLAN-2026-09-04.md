# UI flaw audit + plan — R-241 / R-242

Measured 2026-09-04. 105 agents, 75 raw findings, **36 confirmed** after two adversarial
verify lenses, 9 disputed, 3 refuted, 27 low-severity carried unverified, plus 8 more the
completeness critic found in files nobody had opened.

Confirmed, by rule broken: **11 x veto A** (uppercase micro-labels) · **7 x veto D** (dot
before a label — his strongest veto) · **3 x veto G** (theme-inverting colour literals) ·
**3 x veto C** (emoji) · **1 x veto H** · **3 responsive** · **8 plain defects**.

---

## 0. The thing he demonstrated — measured, not read

Rendered in a real browser with real Tailwind inside a `[216px aside][flex-1 min-w-0 pane]`
shell, using the actual `ClientsView` table markup (10 columns, `table-layout: auto`,
`min-w-full` inside `overflow-x-auto`).

| Window | Name column | 2-badge row | 4-badge row | Badge wrapping own text |
|---|---|---|---|---|
| 900px (the app minimum) | **118px** | **105px** | **185px** | yes — "No contact yet" at 46px vs 26px |
| 1024px | 118px | 105px | 185px | yes |
| 1280px | 170px | 75px | 135px | no |

**Two mechanisms feeding each other.** No chip carries `whitespace-nowrap`, so a chip wraps
its own label. Because chips *can* wrap, the table's auto layout reads the Name column's
min-content as tiny and crushes it to 118px — which makes them wrap more. `flex-wrap` then
stacks the boxes vertically, with nothing capping the count.

Five candidate fixes were rendered and measured at all three widths:

| Variant | Row height @900 | Name col | Clipping | Extra table scroll |
|---|---|---|---|---|
| today | 105 / 185 | 118px | — | — |
| `whitespace-nowrap` only | 105 / 165 | 127px | none | +9px |
| single-line strip, no cap | 75 / 75 | 240px | **70px clipped** | +58px |
| single-line strip, cap 3 | 75 / 75 | 208px | **18px clipped** | — |
| **single-line strip, cap 2 + `+N`** | **75 / 75** | 177px | **none** | **+61px** |

**`whitespace-nowrap` alone does not fix it** — it stops the internal text wrap but the boxes
still stack, which is what the screenshot shows. Cap 3 and uncapped both clip against the
cell's `max-w-[240px]`. **Cap 2 is the only variant that holds one row height at every width
with zero clipping.**

### Note on the two verifier agents that refuted this

Both refuted the internal-text-wrap half after reproducing the chips in a **standalone 424px
container** rather than inside the table. Outside `table-layout: auto` the Name column never
gets crushed to 118px, so the wrap never fires and they measured a clean result. The rendered
table measurement above is the authority, and it matches his screenshot exactly. This is the
same failure the vault records for `v0.14.95`: **read, or partially rendered, is not
rendered.**

---

## Lane 1 — the demonstrated defect and its shape elsewhere (R-241)

1. **`ClientsView.tsx:862-880`** — badge strip becomes `flex items-center gap-1 mt-1
   flex-nowrap overflow-hidden`; each chip gains `whitespace-nowrap flex-shrink-0`; render at
   most 2, then a `+N` chip whose `title` lists the rest. Drop `uppercase tracking-wide` and
   bump 9px/8px to 10px (veto A, same edit).
2. **Free-text chips that can be arbitrarily long** — worse than the fixed labels because the
   user types them: `InventoryView.tsx:2254` (lot categories), `SettingsView.tsx:1372`
   (client-summary categories), `PendingReviewModal.tsx:167` (pending tags). Same treatment.
3. **`ArchiveView.tsx:154`** — the only badge in its row without `flex-shrink-0`, and its
   label ("Fell through") is multi-word.
4. **Not doing:** `SuppliersView` `min-w-[1040px]`, `TiersView` `min-w-[1000px]`,
   `PlatformView` `min-w-[820px]`. All three sit inside `overflow-x-auto` and scroll
   independently — verified they do not push the pane. The vault already records this.

## Lane 2 — veto A, the systemic one (11 confirmed + 6 the critic found)

`uppercase tracking-wide` on a status pill, in ~44 spans across ~20 files, on both surfaces.
There is no shared badge component — `TierBadge`/`ReliabilityBadge` exist and are correct,
but every status/aging/source pill is hand-rolled inline, which is why the pattern keeps
reappearing.

Desktop: `ClientsView:865` · `QuotesView:174` · `DashboardView:486` · `InvoicesView:435` ·
`ReceivablesView:309` + Payables · `DealFlowView:1387` + InvoiceCostSection ·
`ArchiveView:15` · `EmailView:123` · `SettingsView:475` · `PendingReviewModal:105` ·
`AutomationLogView:149` · `ApprovalsView:153` · `TiersView:118` · `GlobeView:462` ·
`PayablesView:278` · `App.tsx:1484` · `InventoryView:821` · `InvoicePreview:105`.

Mobile/web: `style.css` 1466 / 1918 / 1939 / 2437 / 676 · `app.js` 5591 / 9435 / 1240 ·
`sync-health.html:21` · `terms.html:26` (**whole legal paragraphs in letter-spaced caps**).

**Recommendation: extract one `StatusPill` and route every site through it**, rather than 44
individual deletions that will drift again. `InvoicePreview:105` is the one deliberate
exception — a printed document, not app chrome.

## Lane 3 — veto D, the dot before a label (7 confirmed)

His strongest veto, live in seven places:

- **`App.tsx:1210-1220` and `1266-1277`** — the sidebar's Ollama status: a green dot with
  `animation: pulse-expand 2s ease-out infinite` (`index.css:456-466`), directly before the
  word "Ollama". **Veto D and veto B in one element**, running continuously whenever the app
  is open. Removing both call sites orphans `.pulse-ring` and `@keyframes pulse-expand`.
- `InventoryView.tsx:943` and `:2251` — lot status pill. The code comment defends it as
  "static leading dot"; the veto bans dot-led pills regardless of animation.
- `SettingsView.tsx:963` (inbox row) and `:853` (`ConnectedPill` off state — literally a pill
  wrapping a dot; its *on* state already uses a lucide `Check`, so the compliant pattern is
  in the same component).
- `CheckupView.tsx:97` (column header) · `www/app.js:1964` (checkup tabs) ·
  `sync-health.html:85` (workspace name).
- `AnalyticsView.tsx:494` — invoice-status rows use `rounded-full`; the chart `Legend` 330
  lines later in the same file uses `rounded-sm`. The compliant convention already exists in
  the file.

## Lane 4 — veto G, invisible in mono-dark (8 sites, closed set)

Toggle knobs hardcoding `bg-white` on a `bg-accent` track: `ClientDetailView.tsx:275`,
`ReceivablesView.tsx:233`, and 6 more in `SettingsView` — **including the switch that turns
Mono theme on**, i.e. the control you use to enter the theme where it disappears.
`SettingsView`'s own `ClauseSwitch` already uses the correct `bg-on-accent`/`bg-faint` pair;
the fix never propagated. Plus `www/style.css:571` — `.badge-sent`/`.badge-invoiced`/
`.inline-badge.blue` hardcode the accent orange and never go grayscale in either mono theme.

## Lane 5 — veto C, emoji (3 confirmed)

`CommandPalette.tsx:26` — five emoji as result-type icons plus a magnifying-glass emoji as
the search icon. `SettingsView.tsx:1679` — emoji in the WhatsApp footer placeholder.
`www/app.js:5592` — a star glyph as a badge icon. Also `staff.html:501` (public page) and
`GoogleCloudGuide.tsx:79`, both low severity.

## Lane 6 — three responsive bugs the sweep found

`AnalyticsView.tsx:302` and `:387`, `BriefView.tsx:179`: `divide-x` with **no breakpoint** on
a grid that wraps from 2-up to 4-up, so a stray vertical rule is drawn mid-wrap; and the
manual `border-t-0` compensation fires at `lg:` while the grid changes at `xl:`. Exactly the
"span moved without its grid" failure the responsive rule names. `BriefView` has no
compensating border at all.

---

## Lane 7 — mobile analytics (R-242)

### What is actually there

`renderAnalytics`, `www/app.js:2499-2579`. **It is not a tab** — it lives inside the Search
tab's directory, two taps in (`index.html:156`), which is most of why it reads as forgotten.
One hero number (profit, this month), a monthly trend chart, a monthly breakdown table,
invoice status, client tiers, top spenders, category breakdown.

### Why he cannot view by month

There is **no period control anywhere on the screen**. Every section below the hero is an
unbounded all-time aggregate — the server's `monthly` query (`dashboard.rs:304-323`) has no
date bound and no `LIMIT`, so it returns the entire history every time.

**The app already owns the fix and it is on the wrong screen.** The Home tab has a working
prev/next month stepper — `_dashMonth` / `shiftMonth` / `loadDashChart` (`app.js:5308-5312`)
against `GET /api/dashboard/monthly-profit?month=YYYY-MM`, with a profit/revenue toggle.

### Measured against the live DB, so this is not guessed

**4 months of completed history: 2026-05 (10 deals, $140k), 06 (6, $80k), 07 (14, $437k),
08 (19, $373k).** Consequences: the "all-time dump" is 4 points, so a month **selector** is
the right shape rather than pagination; and the year-label collision at `app.js:135`
(`monLabel` drops the year, so two "Mar"s collide) is **latent, not live** — it first fires in
2027-05. Worth fixing in the same pass, not worth a separate release.

### The decision that changes the design

Desktop has **three** different period-selector patterns and mobile must pick one:

1. `AnalyticsView` — 3 preset pills + custom date range + Apply (`get_analytics_range`).
2. `DashboardView` — single-month prev/next stepper (`get_monthly_profit`). **Already on
   mobile's Home tab.**
3. `BriefView` — cadence dropdown + period stepper.

Reusing #2 is cheap and consistent but makes Analytics feel redundant with Home. Building #1
is the richer answer and matches desktop Analytics, but needs new mobile UI **and** an
additive server change.

### Review-in-flight constraint

`www/`-only is invisible to App Review and is the safe shape. Any server change must be an
**optional** query param that defaults to today's behaviour — never a changed signature or a
new gate, because the bundled iOS build calls these routes and cannot be updated.

---

## Lane 8 — real defects found in passing, not design

1. **`quotes.rs:327` — root cause of every emailed quote rendering `1 x $0.00`, confirmed.**
   `email_quote()` reads `it.get("quantity")` and `it.get("price")` from a loose
   `serde_json::Value`; the stored schema uses **`qty`** and **`rate`**. Both lookups miss and
   fall back to defaults. Customer-facing, and already on the backlog as a symptom without a
   cause. Fix by deserializing into `crate::models::LineItem` so a rename cannot do this again.
2. **`dashboard.rs:514` and `:892`** — two `date('now')` UTC comparisons against local
   follow-up dates. The R-159 fix for exactly this bug sits in the same file, and `:892` is
   **two lines below the comment describing it**. From ~6pm Central the droplet is already on
   tomorrow, so follow-ups appear a day early.
3. **`commands.rs:10338`** — `dashboard_stats` runs the identical all-time-profit query twice
   under two keys, and ships two *different* all-time-revenue formulas in one payload.
4. **`AnalyticsView.tsx:481`** — five cards silently ignore the page's own date-range picker
   while sibling cards on the same page explicitly disclose the same limitation.
5. **`www/style.css:667`** — the tier grid is `repeat(5, 1fr)` but 6 tier cards are always
   rendered into it (Platinum was added above Diamond and the grid was never widened).

## Lane 9 — flag, do not fix without asking

**`www/space.js:18-30`** — a permanently looping pulsing-glow backdrop with a spinning glint
ring (`animation: es-glow-drift 42s infinite alternate`, `box-shadow: 0 0 16px 7px
rgba(255,222,185,.8)`), live on **7 public pages** (`landing`, `download`, `register`,
`staff`, `forgot`, `reset`, `verify`). It is the most literal veto-B instance in either repo.
It is also clearly deliberate branding, so it gets asked about, not deleted. No finder saw it
because everyone read the HTML and nobody followed the `<script src>`.

---

## Sequencing

Lanes 1, 3, 4, 5, 6 are desktop-only and invisible to App Review — safe to ship now as one
release. Lane 2 is best done as a single shared `StatusPill` rather than 44 edits. Lane 7
needs his answer on the selector pattern first. Lane 8 items 1 and 2 are server-side and
customer-facing; they ship as their own deploy with the review-facing surfaces asserted before
and after, per `00-RULES` rule 5.

Every lane is verified by **rendering at 900 / 1024 / 1280**, never by reading classes.
