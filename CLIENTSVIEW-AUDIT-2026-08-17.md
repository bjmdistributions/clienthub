# ClientsView audit — 2026-08-17

Decision input for **MASTER-PLAN-2026-08-17 §W5 / D-4**: is `ClientsView` (the list) in scope for the R-153 redesign, or is the detail screen enough?

Read-only audit. Nothing was changed. Evidence is `file:line` against `src/components/ClientsView.tsx` (938 lines, read in full) and `src-tauri/src/commands.rs` (grepped, never read whole). Live figures came from a read-only (`mode=ro`) open of the desktop database; no client names or dollar amounts are reproduced here because this repo is public.

**Live shape, 2026-08-17:** 141 clients · 21 with any paid revenue · 2 with `approval_status='rejected'` · 4 with at least one refund.

---

## Answers to the six questions

### 1. Default sort — alphabetical. The biggest accounts are invisible.

`const [sortKey, setSortKey] = useState<string>("name")` with `sortDir` `1` (`:59-60`), applied at `:178-183` and defaulting to `(c.name || "").toLowerCase()` (`:175`). The backend agrees: `list_clients` ends `ORDER BY c.name` (`commands.rs:165`).

**The R-116 trap is present, and it is worse here than a hunch.** Measured against the live database, alphabetical row position of the ten largest clients by paid revenue:

| Rank by money | Alphabetical row (of 141) |
|---|---|
| #1 | 5 |
| #2 | **141 — dead last** |
| #3 | 107 |
| #4 | 68 |
| #5 | 124 |
| #6 | 39 |
| #7 | 56 |
| #8 | 98 |
| #9 | 129 |
| #10 | 91 |

**One** of the ten biggest accounts appears in the first fifteen rows. The second-biggest client in the business is the last row on the screen.

Clicking the Revenue header does sort by money (`:174` → `c.total_revenue`), but `toggleSort` sets `sortDir = 1` on a *new* key (`:186`) — so the first click sorts **ascending**, putting the smallest clients on top. Two clicks to see the biggest account.

### 2. Clicking a client opens the profile, not the edit form.

`onClick={() => setDetailId(c.id)}` (`:726`) → `ClientDetailView` (`:319-328`). Edit is a separate pencil in the action pill (`:793`), correctly `stopPropagation`-ed (`:784`). **The half of the R-116 trap that sank the supplier grid does not apply here.** The list already separates reading from editing.

Two notes: the detail view *replaces* the list (`:319` returns early), so back is a full refetch (`:323`); and `selectedIds` is not cleared on the way in or out.

### 3. Filters and sorts — money is present in one control, and that control is dead.

Present: search (`:506`), category (`:522`), rep (`:532`), tier multi-select (`:541`), "No contact yet" (`:564`), advanced state/tag/status/staleness/missing-info (`:591-642`), and a sort dropdown with exactly two options — Name A-Z and **Revenue Highest** (`:583-587`). Column headers sort by name, company, tier, email, phone, last activity, revenue (`:711`).

There is **no profit sort or filter anywhere**, and:

> **"Revenue Highest" never works.** `applyFilter`'s `hasFilter` test (`:81`) omits `sort_by`. Selecting it with nothing else active takes the `else` branch → `api.listClients()` → `ORDER BY c.name`. Nothing happens. And when another filter *is* active, `list_clients_filtered` appends `ORDER BY total_revenue DESC` (`commands.rs:1735`) against a select list whose revenue column has **no alias** (`commands.rs:1626`) and a `clients` table with no such column (`db.rs:273-283`, plus seven `ALTER TABLE clients` migrations — none adds one). SQLite refuses to prepare it. Reproduced against the exact query shape: `OperationalError: no such column: total_revenue`. The command returns `Err`, the promise rejects, nothing catches it (`:82`, `:158`, `:135`), so the list silently keeps its previous contents with no error shown.

The same `hasFilter` omission kills the **Status** filter: `lead_status` is missing from the list at `:81` and `:163`, so choosing a status on its own also falls through to the unfiltered `api.listClients()` — while a chip appears at `:204` announcing a filter that was never applied.

### 4. Money on the row — one column, and it is the wrong one.

Columns: checkbox · Name (+ badges) · Company · Tier · Email · Phone · Last activity · Revenue · actions (`:711`). Revenue at `:781-783` is the only money.

`total_revenue` is **paid invoices only**, net of refunds (`commands.rs:158`, `:1832-1838`). A client sitting on a quarter-million of sent-but-unpaid invoices reads `$0`. There is no profit, no open AR, no last-order size, no deal count.

**The profit is already in memory and thrown away.** `api.buyerTiers()` is fetched on mount (`:101`) and used only for the tier pill and reliability badge (`:759-760`); the same rows carry `actual_paid`, `total_profit`, `deals_landed`, `last_invoice_date` and `avg_commission_pct` (`api.ts:827-844`). This is the identical pattern R-153 found in the detail view — the screen fetches the answer and discards it.

Also absent, from Jack's own must-be-glanceable list: **address** (never rendered — `MapPin` appears only as a *missing-address* warning icon at `:749`), **current deals**, **past deals**, **linked bank payments**. `ClientsView` never calls `listDealFlows`. Four of four are missing from the list.

### 5. Empty, loading and error states.

- **No loading state exists.** There is no `loading` flag in the component (`:40-66`). `clients` starts `[]` (`:40`), so on every mount — before `api.listClients()` resolves (`:90`) — the table renders the full empty state: **"No clients yet — Add your first client to get started"** with an Add Client button (`:812-822`). A user with 141 clients is told they have none, every single load.
- **No error state exists.** `api.listClients()` (`:90`, `:122`) and `api.listCategories()` (`:99`) have no `.catch`; `applyFilter` (`:80-85`) has no `try`. Any backend failure — including the revenue-sort failure above — leaves a stale or empty list and says nothing.
- **The empty state is keyed on the wrong array.** `clients.length === 0` (`:806`) but the rows render `displayed` (`:721`, `:191`). Turn on "No contact yet", then narrow the search until no contacted client remains: `fcCount` hits 0, the toggle button disappears (`:564`) but `fcOnly` stays `true` (only `clearAll` resets it, `:161`) — the table renders a header and nothing else, with no empty state and no explanation.
- The filtered empty copy ("No clients match the current filters") is gated on `hasAnyFilter` (`:809`), which — per finding 3 — is blind to status and sort.

### 6. Correctness bugs.

**a. Two of the four headline stat tiles read zero, permanently.** `summaryStats` counts `lead_status === "active_customer"` and `=== "hot_lead"` (`:94-95`). The live database contains exactly three values: `prospect` (133), `Active Buyer` (6), `active` (2). Neither string exists. **"Active Customers" and "Hot Leads" both display 0** and always have. The Status filter offers the same non-existent values (`:609-611`), and the "Active (not dormant)" option maps to `!= 'inactive'` (`commands.rs:1713`), which is every client in the database.

**b. Four vocabularies for one column.** The edit form writes `"hot lead"` / `"active customer"` **with spaces** (`:872-875`); the bulk toolbar writes `hot_lead` / `active_customer` **with underscores** (`:684-690`); the stats and filters read underscores; production holds `Active Buyer` from an import. `create_client`/`update_client` store the string verbatim — no normalisation (`commands.rs:302`, `:392`, `:432`). So editing a client through this screen's own form makes it invisible to this screen's own stats and filters.

**c. The Revenue column means two different things.** `list_clients` nets refunds out (`commands.rs:158`: `MAX(0, SUM(paid) - refunded)`); `list_clients_filtered` does not (`commands.rs:1626`: bare `SUM(total)`). Four live clients have refunds, so for those four the same column shows a **higher** number as soon as any filter is applied. The refund netting is deliberate (`commands.rs:1830-1831`); the filtered path was never updated.

**d. Select-all can select rows you cannot see, and Delete is a hard delete.** `toggleSelectAll` (`:235-241`) and the header checkbox (`:709`) both operate on `clients`, while the table renders `displayed` (`:721`). With "No contact yet" active, "select all" selects every client including the hidden ones — then Delete (`:697`) hard-deletes them: `DELETE FROM clients` (`commands.rs:1127`), no soft flag. Over 10 rows it asks you to type DELETE (`:246`); it never tells you *which* rows.

**e. Bulk delete reports nothing and silently no-ops on any client with invoices.** `bulk_delete_clients` skips FK-blocked rows without recording them (`commands.rs:1127`) and returns a count; `ClientsView` discards it (`:252`). Select 20 clients with invoices, confirm the destructive prompt, and the screen refetches with all 20 still present and no message.

**f. Two disagreeing sources for one number.** The header reads `summaryStats.total` (`:364`), computed **once** on mount (`:92-97`) and refreshed only by `runCleanup` (`:311-314`) — not after create, edit, delete or bulk delete. The "Showing X of Y" line reads `totalClients` (`:660`), refetched by a dedicated effect on every `clients` change (`:121-123`). After a delete the two disagree until remount.

**g. That refetch effect is expensive.** `:121-123` runs the full `list_clients` query — per-client correlated subqueries including `CLIENT_REFUNDED_SQL` (`commands.rs:1832-1838`) — purely to read `.length`, on every filter change, every debounced keystroke, and every blacklist toggle (`:788`).

**h. Rejected clients leak into the list and the count.** `list_clients` has no `approval_status` filter (`commands.rs:164`). Two live clients are `rejected` and appear as ordinary rows inside "141 total". (Voided/archived invoices are correctly excluded from revenue and invoice counts on both paths — `commands.rs:154`, `:158`, `:1622`.)

**i. Two banners are computed off the filtered array while presenting as global.** `pending` (`:330`) — so applying a filter can hide or shrink the "N new customers are awaiting your approval" banner. And the "Unsubscribed" row in Data Health counts `clients.filter(...)` (`:430`) while its six sibling rows come from the global `missingInfo` report (`:424-429`) — one number in that panel shrinks with the filter and six do not.

**j. Minor.** `healthScores` / `setHealthScores` is declared (`:53`) and never used — dead state. `TIER_RANK` carries a `D` tier (`:166`) that `tier_for` can never emit (`commands.rs:1779-1787`, codes are P/S/A/B/C/Prospect) — a second instance of the phantom `D` recorded as conflict #5 in `00-INDEX`; `tierLabels` (`:194`) has no `D`, so a `D` would render as a raw letter. The blacklist toggle mutates a state object in place before copying the array (`:788`).

---

## Ranked findings

| # | Finding | Impact | Evidence |
|---|---|---|---|
| 1 | Default sort is alphabetical; 9 of the 10 biggest accounts sit below the fold, #2 is the last row | The R-116 trap, confirmed with numbers | `:59-60`, `:175`, `commands.rs:165` |
| 2 | "Revenue Highest" is dead in both branches — ignored without another filter, SQL error with one | The only money sort in the UI does nothing, silently | `:81`, `:583-587`, `commands.rs:1735` |
| 3 | "Active Customers" and "Hot Leads" tiles read 0 on all real data; four vocabularies for `lead_status` | Two of four headline numbers are permanently wrong | `:94-95`, `:872-875`, `:684-690`, live data |
| 4 | The Status filter is silently ignored while its chip claims it applied | A filter that lies about being on | `:81`, `:163`, `:204` |
| 5 | Select-all selects hidden rows; bulk Delete is a hard delete that reports nothing and skips FK-blocked rows in silence | Destructive, and adjacent to NEVER-ERASE | `:235-241`, `:252`, `commands.rs:1127` |
| 6 | No loading state — every mount shows "No clients yet" to an account with 141 clients | Alarming on every single load | `:806-822` |
| 7 | Revenue column means paid-net-of-refunds unfiltered, paid-gross filtered | Same client, two numbers, 4 live clients affected | `commands.rs:158` vs `:1626` |
| 8 | Row shows no profit, no open AR, no deals, no address — while `buyerTiers` already holds profit in memory | Fails "glance and see everything" | `:711`, `:101`, `api.ts:827-844` |
| 9 | Two disagreeing client counts; `summaryStats` never refreshes after a mutation | Stale headline number | `:92-97`, `:364`, `:660` |
| 10 | No error handling anywhere on the load path | Failures present as empty or frozen lists | `:90`, `:99`, `:80-85` |
| 11 | Pending-approval banner and the Unsubscribed health row are computed off the filtered array | Banners that vanish when you filter | `:330`, `:430` |
| 12 | Rejected clients counted and listed as ordinary rows | 2 live rows | `commands.rs:164` |
| 13 | Full `list_clients` refetched on every `clients` change just to read `.length` | Wasted correlated-subquery scan per keystroke | `:121-123` |
| 14 | Dead `healthScores` state; phantom `D` tier | Cosmetic | `:53`, `:166` |

---

## What the vault says, and what the code says

`features/desktop-screens.md` §`ClientsView.tsx` (lines 57-63). Nothing in it is **false** — every specific claim checks out:

- Typed last activity with per-kind icon/label/colour (`ACTIVITY_META`) — true, `:13-23`, and it is genuinely good.
- Tier pills from `TierBadge`, reliability from `ReliabilityBadge` — true, `:759-760`.
- Blacklisted and needs-review visible in the list — true, `:734`, `:739`.
- The listed actions and filters all exist.

What is wrong is what it **omits**, and the omissions are exactly the ones this audit was commissioned to find:

1. The note never states the **default sort**, so the R-116 trap was undetectable from the vault. Add it.
2. The filter list is incomplete — it omits search, rep, unsubscribed, lead_status, the sort dropdown and the client-side "No contact yet" toggle.
3. It says nothing about money on the row, which is the whole R-153/R-116 axis.
4. It does not record that the Status filter and the Revenue sort are non-functional. A reader would reasonably assume both work.

**Recommended vault edit** (not made — this session is read-only): add to the Rules block under `ClientsView.tsx`:

> - **Sorted A-Z by name by default** (`:59`), and clicking Revenue sorts *ascending* first. The largest accounts are not visible without two deliberate clicks — measured 2026-08-17: 1 of the top 10 by revenue appears in the first 15 rows.
> - **Two controls are inert:** the Status filter and "Sort: Revenue Highest" are both missing from `applyFilter`'s `hasFilter` test (`:81`), so alone they fall through to the unfiltered query; `revenue_desc` additionally fails to prepare in SQL (`commands.rs:1735`, no such column).
> - **`lead_status` has no canonical vocabulary.** The edit form writes spaces, the bulk toolbar writes underscores, production also holds `Active Buyer`. The "Active Customers" and "Hot Leads" tiles read 0 as a result.
> - The row's only money is `total_revenue` = **paid** invoices net refunds; the filtered query is not refund-netted (`commands.rs:1626`).

---

## D-4 recommendation: the list is in scope, but as a fix, not a rebuild

**Yes — include `ClientsView`. No — do not rebuild it.**

The reasoning, and why it differs from R-116:

- **The trap that sank the supplier grid is half-present.** Alphabetical sort: confirmed, and measurably worse than expected. Click-opens-the-edit-form: **absent** — the row already opens the profile (`:726`). So the structural sin R-116 had to fix does not exist here.
- **The table is the right form for this screen.** 141 rows, seven sortable columns, typed last-activity, tier and reliability badges, missing-field indicators. A card grid would carry less information per screen. Do not convert it; the R-116 supplier redesign is not a template to copy verbatim.
- **Almost everything wrong is cheap.** Default `sortKey` to `revenue` descending is one line. Adding `sort_by` and `lead_status` to `hasFilter` is one line. Aliasing the revenue column `AS total_revenue` in `list_clients_filtered` is one word. A profit column is a lookup into `buyerTiers`, already fetched. A loading flag is three lines. None of this needs the W5-f generic component.
- **Two items are decisions, not code.** The `lead_status` vocabulary needs one canonical set before any of the four writers is touched (and a backfill of the six `Active Buyer` rows) — that is a data decision for Jack, and it is the reason two headline tiles read zero. Whether the list should lead with profit or with paid revenue is the second.

**Proposed shape** — a new plan row rather than folding it into W5-b:

- **W5-g (small, ships with W5-a):** default sort to money descending; revenue-header first click descends; fix `hasFilter` to include `sort_by` and `lead_status`; alias the SQL column; net refunds on the filtered path; add a loading flag and a `.catch` on the load path; key the empty state and select-all on `displayed`.
- **W5-h (needs D-6, a new decision):** canonicalise `lead_status` across the form, the bulk toolbar, the filters and the stat tiles, and backfill existing rows. Until then the two zero tiles should be considered a known-wrong number, not a redesign target.
- **Deliberately out of scope:** deals, payments and the "interconnected web" belong on the profile. The list's job is to rank 141 accounts by how much they matter and get you into the right one — it needs money, not more entities.

One consequence worth flagging for **W6**: if the profile is built generically with a role configuration (§0 rule 4), the client list and the supplier list will still be two unrelated components with two different sort defaults. Worth deciding whether the list is also role-configured before W5-g hardcodes a second one.
