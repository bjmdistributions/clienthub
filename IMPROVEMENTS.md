# ClientHub — Improvements Audit

> Audit date: 2026-05-11 | Auditor: senior software engineer read-only pass | Source: every `.rs`, `.tsx`, `.ts` file read in full.

---

## Summary Table

| Category | Count |
|---|---|
| Bugs found | 12 |
| Performance issues | 8 |
| Missing features (sales workflow) | 14 |
| Code quality issues | 13 |
| Sync / data integrity issues | 7 |
| Quick wins | 12 |

---

## Section 1: Bugs Found

### BUG-01 — `create_invoice` duplicate (known — NOT present in current code)

**File:** `src-tauri/src/commands.rs`  
**What the bug is:** The known bug list reports a second `create_invoice` at ~line 381. In the current source, line 379 begins `fn generate_invoice_number()` — a private helper, not a duplicate command. This bug appears to have already been fixed or was never present.  
**Correct behavior:** N/A — current code is correct.  
**Severity:** N/A

---

### BUG-02 — Invoice number generates duplicates under multi-device sync

**File:** `src-tauri/src/commands.rs:379–398`  
**What the bug is:** `generate_invoice_number()` reads `invoice_seq_{year}` from the `settings` table, increments it, and writes it back. Because `settings` is a **synced** table with Last-Write-Wins semantics, two devices can independently read counter = 0 at startup, both generate `INV-2026-0001`, and create two invoices with the same number. The UNIQUE constraint only enforces uniqueness within each device's local SQLite — cross-device collisions are silent.  
**Correct behavior:** Invoice numbers must be unique across all devices. Replace the shared counter with a per-node prefix: `INV-{year}-{node_short}-{seq}` (e.g. `INV-2026-A3-0001`), where `node_short` is the first 2 hex chars of `node_id`. Alternatively, append a short UUID suffix to guarantee global uniqueness.  
**Severity:** High — duplicate invoice numbers corrupt accounting and confuse clients.  
**Files to change:** `src-tauri/src/commands.rs` (`generate_invoice_number`).

---

### BUG-03 — `mark_invoice_paid` updates sync event with `paid_at` but SQL omits it

**File:** `src-tauri/src/commands.rs:505–518`  
**Line:** 513  
**What the bug is:** The sync event at line 509 includes both `"status"` and `"paid_at"`, but the SQL at line 513 reads `"UPDATE invoices SET status='paid' WHERE id=?1"` — `paid_at` is never written to the local database. After marking an invoice paid, `paid_at` stays NULL on the device that performed the action. On other devices it arrives via sync correctly.  
**Correct behavior:** SQL should be `UPDATE invoices SET status='paid', paid_at=?1 WHERE id=?2` with `now` bound as the first parameter.  
**Severity:** High — `paid_at` is `NULL` locally, breaking any future "paid on date" reporting.  
**Files to change:** `src-tauri/src/commands.rs` line 513.

---

### BUG-04 — `send_invoice` updates `status` and `sent_at` directly without sync (Invariant 1 violation)

**File:** `src-tauri/src/invoice.rs:567–573`  
**What the bug is:** After emailing an invoice, the code runs `UPDATE invoices SET status='sent', sent_at=?1 WHERE id=?2` directly without calling `sync::record_upsert`. This violates ARCHITECTURE.md Invariant 1. Other devices never learn the invoice was sent, so it appears perpetually as "draft" on Mac/PC that didn't send it.  
**Correct behavior:** Before the direct SQL, call `sync::record_upsert("invoices", invoice_id, {status: "sent", sent_at: now})`.  
**Severity:** Critical — invoice status desync across devices corrupts state.  
**Files to change:** `src-tauri/src/invoice.rs`, function `send_invoice`.

---

### BUG-05 — `generate_pdf` updates `pdf_path` directly without sync

**File:** `src-tauri/src/invoice.rs:524–531`  
**What the bug is:** After generating the PDF, `pdf_path` is written directly to SQLite without `sync::record_upsert`. ARCHITECTURE.md explicitly states: "PDF path stored in `invoices.pdf_path` so peers see it after sync (paths are local but the column existence flags 'PDF generated')". Other devices can't tell whether the PDF exists.  
**Correct behavior:** Add `sync::record_upsert("invoices", invoice_id, {"pdf_path": pdf_path_str})` before the direct SQL update.  
**Severity:** Medium — peers cannot distinguish "PDF generated" from "PDF not yet generated".  
**Files to change:** `src-tauri/src/invoice.rs`, function `generate_pdf`.

---

### BUG-06 — `process_new_emails` logs interactions directly without sync (Invariant 1 violation)

**File:** `src-tauri/src/email.rs:380–394`  
**What the bug is:** When an inbound email is matched to a known client, an `email_in` interaction is inserted via direct `conn.execute(...)` without calling `sync::record_upsert`. The `interactions` table is a synced table (ARCHITECTURE.md). Email interactions logged on one device never appear on the others.  
**Correct behavior:** Build a cols map and call `sync::record_upsert("interactions", &interaction_id, cols)`, then the direct INSERT as the local apply.  
**Severity:** Critical — interactions are the primary sales history; losing them on peer devices defeats the purpose of sync.  
**Files to change:** `src-tauri/src/email.rs`, function `process_new_emails`.

---

### BUG-07 — `log_signup_interaction` in `signup_rules.rs` bypasses sync (Invariant 1 violation)

**File:** `src-tauri/src/signup_rules.rs:233–243`  
**What the bug is:** Same pattern as BUG-06. The signup interaction is inserted with a bare `conn.execute` without `sync::record_upsert`. Auto-created clients are synced (line 220 calls `sync::record_upsert`), but their first interaction is not.  
**Correct behavior:** Replace the direct INSERT with a `sync::record_upsert` call followed by the direct INSERT.  
**Severity:** High — first interaction on auto-created clients is invisible on other devices.  
**Files to change:** `src-tauri/src/signup_rules.rs`, function `log_signup_interaction`.

---

### BUG-08 — `last_seen_uid` written to synced `settings` table directly

**File:** `src-tauri/src/email.rs:195–203`  
**What the bug is:** The IMAP cursor (`last_seen_uid`) is stored directly in the `settings` table (a synced table) via `conn.execute`. Because `settings` uses LWW sync, the PC and Mac fight over this value. If the Mac's HLC wins, the PC's cursor resets to the Mac's position and re-scans emails the PC already processed — or worse, skips emails the Mac already saw.  
**Correct behavior:** `last_seen_uid` is device-local and must not be synced. Store it in a local-only table (new migration: `CREATE TABLE device_state (key TEXT PRIMARY KEY, value TEXT)`), or write directly to SQLite only and never pass it to `sync::record_upsert`.  
**Severity:** High — causes duplicate or skipped email processing across devices.  
**Files to change:** `src-tauri/src/email.rs`, `src-tauri/src/db.rs` (new migration).

---

### BUG-09 — `node_id` written to synced `settings` table directly

**File:** `src-tauri/src/sync.rs:75–79`  
**What the bug is:** The device's HLC node identifier is stored via direct `conn.execute` INSERT into `settings` (a synced table). If Device A's event arrives on Device B, the LWW merge could overwrite Device B's `node_id` with Device A's, making both devices share the same node identifier. HLC tie-breaking would then be meaningless and event ordering could be wrong.  
**Correct behavior:** `node_id` is device-local. Store it in a local-only table (same `device_state` table from BUG-08 fix), bypassing the sync engine.  
**Severity:** High — two devices with the same `node_id` breaks HLC ordering guarantees.  
**Files to change:** `src-tauri/src/sync.rs` (`node_id` function), `src-tauri/src/db.rs` (migration).

---

### BUG-10 — `ai_summarize_history` SQL silently drops NULL subject/body interactions

**File:** `src-tauri/src/commands.rs:580–587`  
**Line:** 580  
**What the bug is:** The query `SELECT subject || ': ' || body FROM interactions` uses SQLite's `||` concatenation. If either `subject` or `body` is NULL, the entire expression evaluates to NULL and the row is dropped from results. Interactions that have no subject (e.g., quick call logs) or no body are silently excluded from the AI summary.  
**Correct behavior:** Use `COALESCE(subject, '') || ': ' || COALESCE(body, '')` and add a WHERE clause to exclude rows where both are NULL.  
**Severity:** Medium — AI summaries miss data.  
**Files to change:** `src-tauri/src/commands.rs`, function `ai_summarize_history`.

---

### BUG-11 — Tax rate is lost when editing an existing invoice

**File:** `src/components/InvoicesView.tsx:153`  
**What the bug is:** `const [taxRate, setTaxRate] = useState(0)` always initialises to zero, even when editing an existing invoice (`initial` is non-null). The Invoice struct has `subtotal` and `tax` fields from which the rate can be reconstructed (`tax / subtotal * 100`), but this calculation is never performed. Every edit session starts with 0% tax, silently recalculating totals incorrectly.  
**Correct behavior:** Initialise `taxRate` as: `initial && initial.subtotal > 0 ? Math.round(initial.tax / initial.subtotal * 10000) / 100 : 0`.  
**Severity:** High — editing any invoice silently changes its total to a lower (tax-free) amount.  
**Files to change:** `src/components/InvoicesView.tsx`, `InvoiceForm` component.

---

### BUG-12 — OAuth CSRF token generated but never verified

**File:** `src-tauri/src/oauth_flow.rs:39–44`  
**What the bug is:** `let (auth_url, _csrf) = client.authorize_url(...)` — the CSRF token is discarded (`_csrf`). The callback handler in `parse_code` extracts only the `code` parameter and never checks the `state` parameter against the generated CSRF token. A malicious redirect could inject a foreign authorization code.  
**Correct behavior:** Store `_csrf` in an `Arc<Mutex<>>` accessible to the callback handler, then verify `params["state"] == csrf.secret()` before exchanging the code.  
**Severity:** Medium — limited exploitability (localhost callback), but violates OAuth2 security best practice.  
**Files to change:** `src-tauri/src/oauth_flow.rs`.

---

## Section 2: Performance Issues

### PERF-01 — N+1 subquery in `list_clients` / `get_client` / `search_clients`

**File:** `src-tauri/src/commands.rs:34–38, 63–66, 207–211`  
**What the issue is:** All three client queries include a correlated subquery `(SELECT COUNT(*) FROM invoices WHERE client_id=clients.id AND status IN ('sent','paid'))`. With 500 clients, `list_clients` executes 501 queries. On spinning-disk Windows machines this is noticeable.  
**Fix:** Replace with a LEFT JOIN + GROUP BY:
```sql
SELECT c.*, COUNT(i.id) as invoice_count
FROM clients c
LEFT JOIN invoices i ON i.client_id=c.id AND i.status IN ('sent','paid')
GROUP BY c.id ORDER BY c.name
```
**Files to change:** `src-tauri/src/commands.rs` (all three client queries).

---

### PERF-02 — `ClientDetailView` fetches all invoices and filters client-side

**File:** `src/components/ClientDetailView.tsx:41–42`  
**What the issue is:** `const all = await api.listInvoices(); setInvoices(all.filter((inv) => inv.client_id === clientId));` — transfers the entire invoices table over the Tauri FFI bridge to filter in JavaScript. With hundreds of invoices this is wasteful.  
**Fix:** Add a `list_invoices_for_client(client_id: String)` command that runs `SELECT ... FROM invoices WHERE client_id=?1 ORDER BY issue_date DESC`. Register it in `main.rs` and expose it in `api.ts`.  
**Files to change:** `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/lib/api.ts`, `src/components/ClientDetailView.tsx`.

---

### PERF-03 — IMAP fetches full RFC822 message bodies when only headers are needed for the inbox list

**File:** `src-tauri/src/email.rs:239–243`  
**What the issue is:** `session.uid_fetch(&fetch_set, "RFC822")` downloads complete message bodies (HTML, attachments, everything) for every new email on every 5-minute scan. For a busy inbox this can be many megabytes per scan cycle.  
**Fix:** Use `"(UID RFC822.HEADER BODY.PEEK[TEXT]<0.4096>)"` to get headers plus a truncated body preview. Only fetch the full RFC822 body when the user explicitly clicks an email in the UI (add a `fetch_email_body(uid)` command).  
**Files to change:** `src-tauri/src/email.rs`.

---

### PERF-04 — `replay_all` reads and parses every sync event file on every call

**File:** `src-tauri/src/sync.rs:528–554`  
**What the issue is:** `replay_all` scans the entire sync directory, reads every `.json` file, and then checks `already_applied` per event. With 10,000+ events (normal after a year of operation on 3 devices) this is expensive: disk I/O + JSON parse for events that were applied months ago.  
**Fix:** Track the filename of the last-applied event in `sync_meta` (a `last_replay_cursor TEXT` column). On startup, skip all files whose names sort lexicographically ≤ the cursor, since filenames are prefixed with `{physical_ms}-{logical}` and are already sorted chronologically.  
**Files to change:** `src-tauri/src/sync.rs`, `src-tauri/src/db.rs` (migration to add cursor column).

---

### PERF-05 — Regex compiled fresh for every email in `signup_rules::matches_any`

**File:** `src-tauri/src/signup_rules.rs:119–136`  
**What the issue is:** `matches_any` re-fetches all rules from the database AND calls `Regex::new(p)` inside the inner loop for every email–rule pair. If there are 5 rules and 50 inbound emails in a scan, that's 250 regex compilations plus 50 DB queries.  
**Fix:** Cache compiled regexes in a `OnceLock<Mutex<HashMap<rule_id, (Regex, Regex)>>>` keyed by rule ID, invalidated on `create_rule` or `toggle_rule`. Or at minimum, compile outside the per-email loop.  
**Files to change:** `src-tauri/src/signup_rules.rs`.

---

### PERF-06 — Missing composite index on `invoices(issue_date)` used by `dashboard_stats`

**File:** `src-tauri/src/db.rs` migration 1  
**What the issue is:** `dashboard_stats` runs `WHERE status='paid' AND issue_date >= ?1`. There is an index on `status` but not on `issue_date` or `(status, issue_date)`. For large invoice tables, this requires a full status-index scan + date filter.  
**Fix:** Add migration 6 with `CREATE INDEX IF NOT EXISTS idx_invoices_paid_date ON invoices(status, issue_date)`.  
**Files to change:** `src-tauri/src/db.rs`.

---

### PERF-07 — Ollama `generate` and `chat` calls are fully blocking from the frontend perspective

**File:** `src-tauri/src/commands.rs:553–598`, `src-tauri/src/ai.rs:111–175`  
**What the issue is:** AI commands (`ai_draft_reply`, `ai_extract_data`, etc.) are `async` Tauri commands that call Ollama and wait up to 120 seconds. During this time the UI is unresponsive to other Tauri commands because there's only one response channel per invoke call. For long model runs (qwen2.5:14b), the "generating…" spinner blocks the entire view.  
**Fix:** For draft generation specifically, add server-sent streaming: use Ollama's `stream: true` mode and emit Tauri events (`emit`) to the frontend as tokens arrive. The frontend can display progressive text rather than a long wait.  
**Files to change:** `src-tauri/src/ai.rs`, `src-tauri/src/commands.rs`, `src/components/EmailView.tsx`.

---

### PERF-08 — `AppStore.clients` and `loadClients` are populated but never read

**File:** `src/lib/store.ts:21–29`  
**What the issue is:** The Zustand store fetches a full client list into memory with `loadClients`, and individual components (`ClientsView`, `ClientDetailView`) each make their own independent `api.listClients()` calls on mount. The store's clients array is never consumed. This means on every view-switch to Clients, a redundant full client load occurs alongside whatever the store fetched.  
**Fix:** Either remove `clients` / `loadClients` / `selectedClientId` from the store (dead code) and let components manage local state; or wire components to read from the store and eliminate duplicate fetches.  
**Files to change:** `src/lib/store.ts`, `src/components/ClientsView.tsx`.

---

## Section 3: Missing Features — Sales Workflow

### FEAT-01 — "Last contacted" staleness view (30 / 60 / 90 days)

**What it does:** A filter in `ClientsView` (segmented control or dropdown) that shows only clients whose most-recent interaction is older than N days, or who have never been contacted. The sales brother can open the app on Monday morning, tap "60 days", and immediately have a call list.  
**Files to change:**
- `src-tauri/src/commands.rs` — add `list_stale_clients(days: u32)` command
- `src-tauri/src/main.rs` — register command
- `src/lib/api.ts` — expose `listStaleClients(days)`
- `src/components/ClientsView.tsx` — add staleness filter UI above table

**DB changes:** None — uses existing `interactions.created_at` and a LEFT JOIN:
```sql
SELECT c.*, MAX(i.created_at) as last_contact
FROM clients c
LEFT JOIN interactions i ON i.client_id = c.id
GROUP BY c.id
HAVING last_contact IS NULL OR last_contact < datetime('now', ?1)
ORDER BY last_contact ASC NULLS FIRST
```
**Synced table:** No new table — reads only.  
**Acceptance criteria:**
- "Stale clients" filter shows clients with no interaction in the selected window
- Clients with no interactions ever appear at the top
- Count badge shows how many are stale
**Complexity:** Small

---

### FEAT-02 — Client pipeline / lead status field

**What it does:** A `lead_status` field (dropdown: Prospect → Hot Lead → Warm → Active Customer → Inactive) displayed prominently on client cards and filterable in the list. The sales brother can see at a glance who is a hot lead vs. who is already a paying customer.  
**Files to change:**
- `src-tauri/src/db.rs` — migration 6: `ALTER TABLE clients ADD COLUMN lead_status TEXT DEFAULT 'prospect'`
- `src-tauri/src/commands.rs` — add `lead_status` to `Client` struct, `ClientInput`, all queries; add `update_client_status(id, status)` command
- `src-tauri/src/main.rs` — register new command
- `src/lib/api.ts` — add field + `updateClientStatus`
- `src/components/ClientsView.tsx` — add status badge + column; add filter tabs (All / Hot Lead / Active / Inactive)
- `src/components/ClientDetailView.tsx` — add status badge + quick-change control in header

**DB changes:** Migration 6 — `ALTER TABLE clients ADD COLUMN lead_status TEXT DEFAULT 'prospect'`. **Synced** (goes through `sync::record_upsert`).  
**Acceptance criteria:**
- Each client has a visible status badge in the list and detail views
- Status can be changed with one click from the list row (no modal required)
- Clients can be filtered by status
**Complexity:** Small

---

### FEAT-03 — Revenue per client in client list + sortable

**What it does:** A "Revenue (paid)" column in the clients table showing the sum of paid invoices per client. Sortable descending so the sales brother can see top customers immediately.  
**Files to change:**
- `src-tauri/src/commands.rs` — add `revenue_paid: f64` to `Client` struct; add to all client queries as a subquery or JOIN
- `src/lib/api.ts` — add `revenue_paid` field
- `src/components/ClientsView.tsx` — add Revenue column + sort header click

**DB changes:** None — derived from existing `invoices`.  
**Synced table:** No.  
**Acceptance criteria:**
- Revenue column visible in client list, formatted as `$X,XXX.XX`
- Clicking column header sorts ascending / descending
- Client detail header shows lifetime revenue (already shows paid total, this wires it to the list)
**Complexity:** Small

---

### FEAT-04 — Global quick-log (call / note) without navigating to client

**What it does:** A floating action button or keyboard shortcut (`L`) that opens a modal: type a client name (autocomplete), select kind (call / meeting / note), enter text, save. Visible from any tab. The sales brother can hang up a call and log it in 10 seconds without losing context.  
**Files to change:**
- `src/App.tsx` — add modal state + global keyboard listener
- `src/components/QuickLogModal.tsx` — new component (inline in App.tsx per architecture)
- `src/lib/api.ts` — already has `addInteraction`; add `searchClients` for autocomplete (already exists)

**DB changes:** None — writes to existing `interactions` table via `sync::record_upsert`.  
**Synced table:** Yes (interactions).  
**Acceptance criteria:**
- `L` key or FAB opens modal from any tab
- Client name autocomplete shows after 1 character typed
- Saves in under 3 clicks / keypresses
- Modal closes and returns to current tab
**Complexity:** Small

---

### FEAT-05 — Follow-up reminders / due-today dashboard widget

**What it does:** The `metadata.next_follow_up_date` field already exists and is displayed in ClientDetailView, but nothing surfaces it. This feature: (1) a Dashboard widget "Follow-ups due today" listing clients whose `next_follow_up_date` = today or is past-due; (2) a Tauri notification (the `tauri-plugin-notification` is already registered in `main.rs`) fired on app launch if any follow-ups are overdue.  
**Files to change:**
- `src-tauri/src/commands.rs` — add `due_followups()` command: `SELECT id,name,metadata FROM clients WHERE json_extract(metadata,'$.next_follow_up_date') <= date('now')`
- `src-tauri/src/main.rs` — register command; emit notification on startup if count > 0
- `src/lib/api.ts` — expose `dueFollowups()`
- `src/components/DashboardView.tsx` — add "Follow-ups due" card with list
- `src/components/ClientDetailView.tsx` — make "Follow Up" date editable inline (currently read-only display)

**DB changes:** None — uses existing `metadata` JSON column.  
**Synced table:** Metadata updates go through existing `update_client` sync path.  
**Acceptance criteria:**
- Dashboard shows count + list of follow-ups due today or overdue
- Clicking a follow-up navigates to the client detail view
- On app launch, if ≥1 follow-up is overdue, a system notification appears
- Follow-up date editable from client detail without opening the full edit form
**Complexity:** Medium

---

### FEAT-06 — Overdue invoice auto-detection

**What it does:** There is no mechanism that moves invoice status from `sent` to `overdue` when `due_date` passes. `dashboard_stats` already includes `overdue` in the outstanding calculation, but no invoice ever reaches that status.  
**Files to change:**
- `src-tauri/src/commands.rs` — add `mark_overdue_invoices()` command that runs `UPDATE invoices SET status='overdue' WHERE status='sent' AND due_date < date('now')` via `sync::record_upsert` per affected row
- `src-tauri/src/main.rs` — call this command on startup (after `replay_all`) and in the existing periodic task

**DB changes:** None.  
**Synced table:** Yes — must use `sync::record_upsert` per invoice.  
**Acceptance criteria:**
- On app launch, invoices past due date are marked overdue automatically
- Overdue invoices show with red badge in the invoice list
- Dashboard outstanding total correctly reflects overdue invoices (it already does once status is set)
**Complexity:** Small

---

### FEAT-07 — Invoice "deposit required" status

**What it does:** A new invoice status `deposit_pending` between "draft" and "sent". Represents "proposal sent, awaiting deposit before work begins". The sales brother can see which proposals are stuck waiting for deposit.  
**Files to change:**
- `src-tauri/src/commands.rs` — add `request_deposit(invoice_id)` command that sets `status='deposit_pending'` via sync; update `delete_invoice` to also allow deletion of `deposit_pending` invoices; update `dashboard_stats` to count deposit_pending in outstanding
- `src/components/InvoicesView.tsx` — add "Request Deposit" action button (shown when status=draft); add status color for `deposit_pending`
- `src/lib/api.ts` — expose `requestDeposit(invoiceId)`

**DB changes:** No schema change — status is a free-text field. Add migration if a CHECK constraint is desired.  
**Synced table:** Yes.  
**Acceptance criteria:**
- "Request Deposit" button visible on draft invoices
- Status shows as "deposit pending" badge in amber
- Deposit-pending invoices counted in outstanding total
**Complexity:** Small

---

### FEAT-08 — Line item templates

**What it does:** A way to save a set of line items as a named template ("Standard Wholesale Order") and load it into the invoice form. Eliminates re-typing the same items for recurring order types.  
**Files to change:**
- `src-tauri/src/db.rs` — migration 6 (or 7): `CREATE TABLE line_item_templates (id TEXT PK, name TEXT NOT NULL, items_json TEXT NOT NULL, created_at TEXT NOT NULL)` — **local-only**
- `src-tauri/src/commands.rs` — add `list_line_item_templates`, `create_line_item_template(name, items)`, `delete_line_item_template(id)`
- `src-tauri/src/main.rs` — register commands
- `src/lib/api.ts` — expose template API
- `src/components/InvoicesView.tsx` — add "Load template" dropdown above line items; "Save as template" button when items are filled in

**DB changes:** New `line_item_templates` table — **local-only** (not synced, per the pattern of local automation features).  
**Acceptance criteria:**
- "Save as template" button saves current line items under a user-chosen name
- Template dropdown loads saved items into the form
- Templates can be deleted
**Complexity:** Small

---

### FEAT-09 — Mark invoice paid with payment date + method

**What it does:** When clicking "Mark as paid", show a small modal: payment date (default today), payment method (dropdown from `payment_methods`), optional reference/check number. Store `paid_at`, `payment_method`, `payment_reference` on the invoice.  
**Files to change:**
- `src-tauri/src/db.rs` — migration: `ALTER TABLE invoices ADD COLUMN payment_method TEXT; ALTER TABLE invoices ADD COLUMN payment_reference TEXT`
- `src-tauri/src/commands.rs` — update `mark_invoice_paid` to accept `paid_date`, `payment_method`, `payment_reference` and include them in the sync event and SQL
- `src/components/InvoicesView.tsx` — replace direct "Mark as paid" action with a small modal

**DB changes:** Migration 6 — two `ALTER TABLE invoices ADD COLUMN` statements. **Synced**.  
**Acceptance criteria:**
- Clicking "Mark as paid" opens a 3-field modal (date, method, reference)
- Saved data visible in invoice list and client detail view
- `paid_at` correctly written to local DB (fixes BUG-03)
**Complexity:** Small

---

### FEAT-10 — AI draft tone selector

**What it does:** Before clicking "Draft Reply", a tone selector (Formal / Neutral / Casual) that adjusts the system prompt. The sales brother can write warmer notes to long-term customers and more formal ones to new leads.  
**Files to change:**
- `src-tauri/src/ai.rs` — add `tone: Option<&str>` parameter to `draft_reply`; prepend tone instruction to system prompt
- `src-tauri/src/commands.rs` — thread `tone` through `ai_draft_reply`
- `src/lib/api.ts` — add optional `tone` to `aiDraftReply`
- `src/components/EmailView.tsx` — add 3-button tone selector before "Draft Reply"

**DB changes:** None.  
**Synced table:** No.  
**Acceptance criteria:**
- Three tone buttons visible when an email is selected
- Selected tone persists until changed within the same session
- Draft content noticeably different in formality between Formal and Casual selections
**Complexity:** Small

---

### FEAT-11 — Dashboard: leads contacted this week / follow-ups due / revenue chart

**What it does:** Expand `dashboard_stats` to return: leads contacted this week (distinct clients with interaction in past 7 days), follow-ups due today (count), and monthly revenue data for a sparkline chart (last 6 months: invoiced total vs paid total per month).  
**Files to change:**
- `src-tauri/src/commands.rs` — extend `dashboard_stats` to include `contacted_this_week`, `followups_due`, `monthly_revenue: Vec<{month, invoiced, paid}>`
- `src/components/DashboardView.tsx` — add two new stat cards + a simple bar chart (can use inline SVG without adding a chart library)
- `src/lib/api.ts` — update `DashboardStats` type

**DB changes:** None — computed from existing data.  
**Synced table:** No.  
**Acceptance criteria:**
- Dashboard shows 6 stat cards (was 4)
- 6-month revenue chart visible below the cards, bars show invoiced vs paid per month
- All stats load in a single `dashboard_stats` call
**Complexity:** Medium

---

### FEAT-12 — Client email thread view

**What it does:** In `ClientDetailView`, a dedicated "Emails" tab showing all `email_in` / `email_out` interactions in thread format with full body text. Currently interactions show in the generic interaction list but email bodies are truncated. The sales brother can read the full conversation without leaving the app.  
**Files to change:**
- `src/components/ClientDetailView.tsx` — split interaction list into tabs: "All" / "Emails" / "Calls & Meetings"; in Emails tab, render full `body` in an expanded card

**DB changes:** None — uses existing `interactions` data.  
**Acceptance criteria:**
- Email tab shows only email_in and email_out interactions
- Body text shown in full (no truncation) with scroll if long
- From address shown for email_in interactions
**Complexity:** Small

---

### FEAT-13 — Recurring invoice support

**What it does:** A way to mark an invoice as a template for monthly recurrence. On the first of each month, a draft invoice is auto-created from the template. The operator reviews and sends it.  
**Files to change:**
- `src-tauri/src/db.rs` — migration: `ALTER TABLE invoices ADD COLUMN recur_interval TEXT` (null = not recurring; "monthly" = recurring)
- `src-tauri/src/commands.rs` — add `generate_recurring_invoices()` command that creates draft invoices for all templates where this month's invoice doesn't yet exist
- `src-tauri/src/main.rs` — call on startup
- `src/components/InvoicesView.tsx` — add "Make recurring" checkbox when creating invoice; show recurring badge on template invoices

**DB changes:** Migration — `ALTER TABLE invoices ADD COLUMN recur_interval TEXT`. **Synced**.  
**Acceptance criteria:**
- Recurring invoices generate a draft on the 1st of each month
- Draft pre-fills all line items + tax from the template
- Operator can edit before sending
- Recurring invoices show a "recurring" badge in the list
**Complexity:** Medium

---

### FEAT-14 — Unified client history (emails + interactions + invoices) timeline

**What it does:** In `ClientDetailView`, a single chronological timeline combining interactions, email drafts sent to this client, and invoices — replacing the current two-panel grid. The sales brother gets a single scroll of "what happened with this client" without switching between panels.  
**Files to change:**
- `src-tauri/src/commands.rs` — add `client_timeline(client_id)` command that UNIONs interactions and invoices (with a `kind` discriminator) ordered by date
- `src/components/ClientDetailView.tsx` — replace the two-column grid with a single timeline feed

**DB changes:** None.  
**Acceptance criteria:**
- Timeline shows all events in reverse-chronological order
- Invoices appear as timeline entries with status badges
- Email interactions show body preview (expandable)
**Complexity:** Medium

---

## Section 4: Code Quality Issues

### QC-01 — `done: bool` field in `GenResp` is deserialized but never used

**File:** `src-tauri/src/ai.rs:67`  
**What:** `done: bool` is declared on `GenResp` and annotated `#[serde(default)]`. It is never read after deserialization. Remove the field.  
**Files to change:** `src-tauri/src/ai.rs`.

---

### QC-02 — `store.ts` has dead state: `clients`, `selectedClientId`, `loadClients`

**File:** `src/lib/store.ts:6–9, 20–29`  
**What:** `clients: Client[]`, `selectedClientId`, and `loadClients` are declared and implemented in the Zustand store but are never consumed by any component. `App.tsx` only destructures `aiOnline` and `checkAi`. The dead state wastes memory and misleads future developers.  
**Files to change:** `src/lib/store.ts`.

---

### QC-03 — `any` types in `api.ts` and `EmailView.tsx`

**Files:**
- `src/lib/api.ts:222` — `invoke<any>("ai_extract_data"...)`
- `src/components/EmailView.tsx:164` — `useState<any>(null)`

**What:** The structured extraction result has a defined JSON schema (in the prompt in `ai.rs:211–225`). Define an `ExtractedEmailData` interface in `api.ts` and use it throughout.  
**Files to change:** `src/lib/api.ts`, `src/components/EmailView.tsx`.

---

### QC-04 — `handleMarkPaid` silently swallows errors

**File:** `src/components/InvoicesView.tsx:39–43`  
**What:** The `finally` block runs `setBusy(null)` but there is no `catch`. If `markInvoicePaid` fails (e.g., network or DB error), the user sees no feedback — the spinner just stops.  
**Fix:** Add `catch (e: any) { alert(\`Error marking paid: ${e}\`); }`.  
**Files to change:** `src/components/InvoicesView.tsx`.

---

### QC-05 — `refreshDraftCount` silently discards errors

**File:** `src/components/EmailView.tsx:24–29`  
**What:** Empty `catch {}` with no logging. If the drafts call fails the badge count silently stays at its previous value. Add `catch (e) { console.error("draft count failed:", e); }`.  
**Files to change:** `src/components/EmailView.tsx`.

---

### QC-06 — `console.log` / `console.warn` with password context in production code

**File:** `src/components/SettingsView.tsx:115–116`  
**What:**
```ts
console.log("smtp_pass saved to keychain, length:", smtpPass.length);
console.warn("smtp_pass was empty — not saved");
```
While not logging the password itself, these lines will appear in Tauri's dev tools console on any machine. Remove or guard with a `if (import.meta.env.DEV)` check.  
**Files to change:** `src/components/SettingsView.tsx`.

---

### QC-07 — `imap_host` stored as a keychain credential (not a secret)

**File:** `src/components/SettingsView.tsx:120`  
**What:** `await api.saveCredential("imap_host", settings.imap_host)` — the IMAP hostname is not a secret (it's `imap.gmail.com`). Storing it in the OS keychain wastes credential slots and is inconsistent with how it's also stored in `email_settings` JSON. Remove the credential save; the hostname is already present in `EmailSettings`.  
**Files to change:** `src/components/SettingsView.tsx`.

---

### QC-08 — No email address validation on client creation or compose form

**Files:** `src/components/ClientsView.tsx:191–195`, `src/components/EmailView.tsx:463–469`  
**What:** Email fields have no `type="email"` attribute and no pattern validation. A typo in a client's email silently succeeds and later causes invoice send failures with a cryptic SMTP error.  
**Fix:** Add `type="email"` on all email inputs. In the backend `send_email` command, validate the `to` address with a basic regex before attempting SMTP connection.  
**Files to change:** `src/components/ClientsView.tsx`, `src/components/EmailView.tsx`, optionally `src-tauri/src/commands.rs`.

---

### QC-09 — `Field` component duplicated in three files

**Files:** `src/components/ClientsView.tsx:232–247`, `src/components/InvoicesView.tsx:365–368` (`Field`) and `371–374` (`TextField` — identical), `src/components/SettingsView.tsx:1264–1280`  
**What:** Three separate implementations of the same `Field({label, children})` helper. ARCHITECTURE.md says "Don't cross-import between view files," so extraction to a shared utility would require a new `src/components/ui.tsx` (allowed, since it's not a view). Or accept the duplication since the components are trivial. At minimum, remove the duplicate `TextField` in `InvoicesView.tsx` (identical to `Field`).  
**Files to change:** `src/components/InvoicesView.tsx` (remove `TextField`, use `Field`).

---

### QC-10 — `React.Children` deprecated API in `ClientDetailView.tsx`

**File:** `src/components/ClientDetailView.tsx:1, 344`  
**What:** `import { ..., Children } from "react"` and `Children.toArray(children).length > 0` — `Children` utilities are deprecated as of React 18. Replace with `React.Children.count(children) > 0` or convert the children check to use an explicit `hasContent` prop passed from the parent.  
**Files to change:** `src/components/ClientDetailView.tsx`.

---

### QC-11 — SQL column names from sync events used directly in dynamic SQL (injection risk)

**File:** `src-tauri/src/sync.rs:449–463`  
**What:** In `apply_upsert`, winning column names are interpolated directly into the UPDATE SQL string: `format!("{}=?{}", c, i + 1)`. If a malicious actor writes a crafted `.json` sync event file (possible when encryption is disabled) with a column name like `a=1,status='admin'--`, the resulting SQL is malformed or injected. The table name is validated against `ALLOWED_TABLES`, but column names are not validated against a schema allowlist.  
**Fix:** Add a per-table column allowlist in `sync.rs` (e.g., `ALLOWED_COLUMNS: HashMap<&str, &[&str]>`) and reject any column not in the allowlist before building the SQL string. This also prevents sync events from touching internal columns like `rowid`.  
**Files to change:** `src-tauri/src/sync.rs`.

---

### QC-12 — `update_client` does not sync or expose `billing_status`

**File:** `src-tauri/src/commands.rs:166–191`  
**What:** `ClientInput` has no `billing_status` field, so `update_client` never changes it. The field is set to `"active"` at creation and is forever immutable via the API. The field exists in the schema, is displayed to the user, but cannot be changed. Either expose it via `ClientInput` or remove the field from the schema.  
**Files to change:** `src-tauri/src/commands.rs`, `src/lib/api.ts`, `src/components/ClientsView.tsx`.

---

### QC-13 — `ARCHITECTURE.md` does not list `payment_methods` as a synced table

**File:** `ARCHITECTURE.md` (database schema section)  
**What:** `payment_methods` was added in migration 4, is synced via `sync::record_upsert`, and is in `ALLOWED_TABLES`. But `ARCHITECTURE.md` only lists `clients`, `interactions`, `invoices`, `settings` as synced tables. The document is stale and will mislead future developers.  
**Fix:** Update the architecture doc to include `payment_methods` in both the synced table list and the database schema section.  
**Files to change:** `ARCHITECTURE.md`.

---

## Section 5: Sync + Data Integrity

### SYNC-01 — `interactions` written directly in `email.rs` (Invariant 1 violation)

Already reported as BUG-06. See above.

---

### SYNC-02 — `interactions` written directly in `signup_rules.rs` (Invariant 1 violation)

Already reported as BUG-07. See above.

---

### SYNC-03 — `send_invoice` status update bypasses sync (Invariant 1 violation)

Already reported as BUG-04. See above.

---

### SYNC-04 — `generate_pdf` `pdf_path` update bypasses sync (Invariant 1 violation)

Already reported as BUG-05. See above.

---

### SYNC-05 — `last_seen_uid` stored in synced `settings` without sync routing

Already reported as BUG-08. See above.

---

### SYNC-06 — `node_id` stored in synced `settings` without sync routing

Already reported as BUG-09. See above.

---

### SYNC-07 — Clock skew could cause stale HLCs and silent data loss

**File:** `src-tauri/src/sync.rs:83–106`  
**What:** `now_hlc()` uses `Utc::now().timestamp_millis()`. If a device's system clock jumps backward (e.g., NTP correction, user change), the physical component reverts to an earlier value. The implementation correctly handles this by bumping the logical counter: `s.last_logical += 1`. However, if the clock skew is large (>1 hour) and the logical counter overflows `u32::MAX` before the clock catches up, HLC values would wrap and violate monotonicity. Additionally, `observe_remote` is only called inside `apply_event`, which is not called during `record_upsert` (local events). If a peer's HLC is far ahead (device B had its clock set forward then corrected), Device A's local events could be ordered before Device B's even though Device B's were logically later, causing silent LWW overwrites.  
**Fix:** In `now_hlc()`, cap the logical counter at a safe maximum (e.g., 65535) and log a warning if it approaches the cap. Add a sanity check in `observe_remote` that rejects remote HLCs with a physical timestamp more than 30 minutes in the future (possible sign of clock error).  
**Files to change:** `src-tauri/src/sync.rs`.

---

### SYNC-08 — `payment_methods` table missing from ARCHITECTURE.md synced tables list

Already reported as QC-13. The table is correctly in `ALLOWED_TABLES` in code, but the architecture document is wrong. Not a data integrity issue in practice, but a documentation hazard.

---

## Section 6: Quick Wins

### QW-01 — Keyboard shortcuts for primary actions

**What:** Add `useEffect` in `App.tsx` listening for `keydown` events: `N` → new client (if on clients tab), `I` → new invoice (if on invoices tab), `L` → quick-log modal (global), `Escape` → close any open modal/form.  
**Why:** Sales workflow requires minimal friction. Keyboard-first logging is 5× faster than mouse navigation.  
**Files to change:** `src/App.tsx`, `src/components/ClientsView.tsx`, `src/components/InvoicesView.tsx`.  
**Estimated time:** 20 minutes

---

### QW-02 — Preserve last-selected tab across app restarts

**What:** Save `tab` state to `localStorage` on every change: `localStorage.setItem('lastTab', tab)`. On mount, read it back: `useState<Tab>((localStorage.getItem('lastTab') as Tab) || 'dashboard')`.  
**Why:** After quitting and reopening the app, the user always lands on Dashboard even if they were mid-task on Invoices.  
**Files to change:** `src/App.tsx`.  
**Estimated time:** 5 minutes

---

### QW-03 — Client count badge on Clients nav item

**What:** Read `stats.clients` from `dashboard_stats` (already fetched in Dashboard on mount; add to `AppStore`) and display a small badge next to "Clients" in the sidebar. Update on client creation/deletion.  
**Why:** Instant at-a-glance count without navigating.  
**Files to change:** `src/App.tsx`, `src/lib/store.ts`.  
**Estimated time:** 15 minutes

---

### QW-04 — Draft count badge on AI Email nav item

**What:** Move `draftCount` state up to `App.tsx` / `AppStore` so it's visible in the sidebar nav next to "AI Email". Currently the red badge only appears on the Drafts tab button inside the email view.  
**Why:** The sales brother needs to know drafts are waiting without opening the email view.  
**Files to change:** `src/App.tsx`, `src/lib/store.ts`.  
**Estimated time:** 15 minutes

---

### QW-05 — Confirmation dialog before deleting a client

**What:** The client delete in `ClientsView.tsx:32–36` uses the browser's `confirm()` dialog — fine — but the message is generic. Improve to include the client's name: `confirm(\`Delete ${client.name}? This will also delete all their interactions. This cannot be undone.\`)`.  
**Why:** Prevents accidental deletion of a client with extensive history.  
**Files to change:** `src/components/ClientsView.tsx`.  
**Estimated time:** 5 minutes

---

### QW-06 — "Copy email address" button on client detail

**What:** Add a clipboard icon next to the email address in `ClientDetailView`. On click, `navigator.clipboard.writeText(client.email)` and briefly show "Copied".  
**Why:** The sales brother frequently needs to paste client emails into other apps. Currently requires selecting and copying text manually.  
**Files to change:** `src/components/ClientDetailView.tsx`.  
**Estimated time:** 10 minutes

---

### QW-07 — Empty state improvements with action buttons

**What:** The empty state rows (`No clients yet.`, `No invoices yet.`) show plain text. Replace with centered cards containing an icon, a short description, and a primary CTA button (e.g., "Add your first client" that opens the form directly).  
**Why:** Blank screens are disorienting on first launch. Action-oriented empty states reduce friction.  
**Files to change:** `src/components/ClientsView.tsx`, `src/components/InvoicesView.tsx`.  
**Estimated time:** 20 minutes

---

### QW-08 — Phone number formatting in client form

**What:** In `ClientForm`, add an `onChange` handler that formats the phone field as `(XXX) XXX-XXXX` as the user types, stripping non-numeric characters.  
**Why:** Consistent phone formatting makes the client list more readable and copy-pasteable.  
**Files to change:** `src/components/ClientsView.tsx`.  
**Estimated time:** 15 minutes

---

### QW-09 — "Send to PDF viewer" success feedback improvement

**What:** `handlePdf` in `InvoicesView.tsx` shows `alert(\`PDF saved:\n${p}\`)` — a raw file path alert. Replace with a toast or inline success banner: "PDF opened in your PDF viewer" without exposing the path.  
**Why:** Raw OS paths in alerts look like error messages and aren't useful to the user.  
**Files to change:** `src/components/InvoicesView.tsx`.  
**Estimated time:** 10 minutes

---

### QW-10 — "Mark as paid" confirmation prompt

**What:** `handleMarkPaid` marks an invoice paid immediately on click with no confirmation. Add a `confirm("Mark invoice as paid? This cannot be undone.")` before the API call.  
**Why:** The action is irreversible from the UI (no "unpaid" command exists).  
**Files to change:** `src/components/InvoicesView.tsx`.  
**Estimated time:** 5 minutes

---

### QW-11 — Show client's last contact date in the clients table

**What:** Add a "Last Contact" column to the clients list table, populated by a MAX(interactions.created_at) subquery (or the new FEAT-01 query). Format as "3 days ago" / "2 weeks ago" using a simple relative-time helper.  
**Why:** The sales brother's most urgent need is knowing who hasn't been contacted recently. This gives instant visibility without any filter.  
**Files to change:** `src-tauri/src/commands.rs` (add `last_contact_at: Option<String>` to `Client`), `src/lib/api.ts`, `src/components/ClientsView.tsx`.  
**Estimated time:** 25 minutes

---

### QW-12 — Fix `invoice_count` to count all invoice statuses, not just sent/paid

**What:** The `invoice_count` subquery in `list_clients` is `status IN ('sent','paid')` — draft and overdue invoices are excluded. The badge on the client row says "1 invoice" but there are actually 3 (2 drafts + 1 sent). Change to `COUNT(*)` without status filter. The detailed per-status breakdown is visible on the client detail view anyway.  
**Why:** Misleading count confuses the user about how many invoices exist for a client.  
**Files to change:** `src-tauri/src/commands.rs` (all three client queries).  
**Estimated time:** 10 minutes

---

## Suggested Implementation Order

### Phase 1 — Critical bugs (fix before next use on 3 devices)

1. **BUG-04** — `send_invoice` bypass sync → invoice status never propagates  
2. **BUG-06** — `email.rs` interactions bypass sync → sales history invisible on other devices  
3. **BUG-07** — `signup_rules.rs` interactions bypass sync  
4. **BUG-08** — `last_seen_uid` in synced settings → email re-scanning / skipping  
5. **BUG-09** — `node_id` in synced settings → HLC node collision  
6. **BUG-03** — `mark_invoice_paid` `paid_at` not written to SQL  
7. **BUG-11** — Tax rate lost on invoice edit → wrong totals  

### Phase 2 — Sales workflow (unblocks the sales brother's daily loop)

8. **FEAT-01** — Last contacted / stale clients filter  
9. **FEAT-02** — Client lead status / pipeline  
10. **FEAT-06** — Overdue invoice auto-detection  
11. **FEAT-05** — Follow-up due-today dashboard + notification  
12. **QW-11** — Last contact date column in client list  
13. **FEAT-04** — Global quick-log modal (L key)  
14. **FEAT-09** — Mark paid with payment date + method (also fixes BUG-03 properly)  

### Phase 3 — Quick wins (high value / low effort)

15. **QW-02** — Remember last tab  
16. **QW-01** — Keyboard shortcuts  
17. **QW-05** — Confirmation on client delete  
18. **QW-10** — Confirmation on mark paid  
19. **QW-04** — Draft count badge in nav  
20. **QW-07** — Empty states with action buttons  
21. **QW-12** — Fix invoice_count to include all statuses  
22. **QW-06** — Copy email button  

### Phase 4 — Performance

23. **PERF-01** — Replace N+1 subquery with JOIN in all client queries  
24. **PERF-02** — Add `list_invoices_for_client` command  
25. **PERF-03** — IMAP headers-only fetch  
26. **PERF-04** — Sync replay cursor  
27. **PERF-06** — Add `idx_invoices_paid_date` index  

### Phase 5 — Code quality and security

28. **BUG-12** — Verify OAuth CSRF token  
29. **QC-11** — Column allowlist in sync `apply_upsert`  
30. **QC-03** — Replace `any` types with proper interfaces  
31. **QC-04 / QC-05** — Add error handling to silent catch blocks  
32. **QC-07** — Remove `imap_host` from keychain  
33. **QC-06** — Remove production `console.log` for password operations  
34. **BUG-10** — Fix NULL concatenation in `ai_summarize_history`  
35. **BUG-05** — Sync `pdf_path` update  
36. **BUG-02** — Node-prefixed invoice numbers  
37. **SYNC-07** — HLC clock skew safeguard  

### Phase 6 — Larger features (after core is stable)

38. **FEAT-07** — Deposit-required invoice status  
39. **FEAT-08** — Line item templates  
40. **FEAT-10** — AI draft tone selector  
41. **FEAT-03** — Revenue per client column  
42. **FEAT-11** — Dashboard revenue chart + weekly stats  
43. **FEAT-12** — Client email thread tab  
44. **FEAT-13** — Recurring invoices  
45. **FEAT-14** — Unified client timeline  
46. **PERF-07** — Streaming AI responses  
