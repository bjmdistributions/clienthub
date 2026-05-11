# Agent Task Instructions — IMPROVEMENTS.md Implementation

Read this entire file before doing anything. Then wait for the human to assign a specific task.

---

## Protocol (same as always)

1. Read `AGENT-PROTOCOL.md` and `ARCHITECTURE.md` before touching any file
2. Read `PDF-API-CONTRACT.md` before touching `invoice.rs`
3. Plan first — list every file you will change and why. Wait for approval.
4. Execute only what was approved
5. Do not start the next task until told to
6. `cargo check` verification is done by the human — flag when you need it

---

## Architecture invariants that apply to every task below

- **Invariant 1:** All writes to synced tables go through `sync::record_upsert` / `sync::record_delete` THEN a direct SQL mirror. Never direct SQL only.
- **Invariant 2:** SQLite connections are not Send. Never hold a `conn` across an `.await` boundary. Scope all DB work in inner `{ }` blocks, drop before await.
- **Invariant 4:** Migrations are append-only. Never edit migrations 1–5. New migrations start at v6.
- **Synced tables:** `clients`, `interactions`, `invoices`, `settings`, `payment_methods`
- **Local-only tables:** `email_drafts`, `signup_rules`, `web_sessions`, `sync_meta`, `device_state` (new), `line_item_templates` (new)

---

## PHASE 1 — Critical Bugs (do these first, in order)

---

### TASK-P1A: Fix `send_invoice` sync bypass (BUG-04)

**File:** `src-tauri/src/invoice.rs`, function `send_invoice`
**What:** After emailing an invoice, the code runs `UPDATE invoices SET status='sent', sent_at=?1` directly without calling `sync::record_upsert`. Other devices never see the status change — the invoice stays "draft" on every other device forever.
**Fix:** Before the direct SQL UPDATE, call:
```rust
let mut cols = serde_json::Map::new();
cols.insert("status".into(), serde_json::Value::String("sent".into()));
cols.insert("sent_at".into(), serde_json::Value::String(now_str.clone()));
sync::record_upsert("invoices", invoice_id, cols).map_err(|e| anyhow::anyhow!(e))?;
```
Then keep the existing direct SQL as the local apply.
**Acceptance:** After marking sent on PC, Mac shows "sent" status after Replay All Events.
**Verification:** `cargo check`

---

### TASK-P1B: Fix `email.rs` interactions sync bypass (BUG-06)

**File:** `src-tauri/src/email.rs`, function `process_new_emails`
**What:** When an inbound email is matched to a known client, an `email_in` interaction is inserted via direct `conn.execute` only. The `interactions` table is synced — other devices never see email interactions logged on this device.
**Fix:** Before the direct INSERT, call `sync::record_upsert("interactions", &interaction_id, cols)` with the same fields being inserted (client_id, kind, subject, body, created_at). Keep the direct INSERT as the local apply.
**Constraint:** The conn must be dropped before any `.await`. Use inner `{ }` blocks.
**Acceptance:** Email interaction logged on PC appears on Mac after Replay All Events.
**Verification:** `cargo check`

---

### TASK-P1C: Fix `signup_rules.rs` interactions sync bypass (BUG-07)

**File:** `src-tauri/src/signup_rules.rs`, function `log_signup_interaction`
**What:** Same pattern as P1B. Signup interactions inserted directly without `sync::record_upsert`. The new client is synced (already uses record_upsert) but their first interaction is invisible on other devices.
**Fix:** Same pattern as P1B — call `sync::record_upsert("interactions", ...)` before the direct INSERT.
**Acceptance:** Signup interaction visible on all devices after Replay.
**Verification:** `cargo check`

---

### TASK-P1D: Fix `last_seen_uid` and `node_id` stored in synced settings (BUG-08 + BUG-09)

**Files:** `src-tauri/src/email.rs`, `src-tauri/src/sync.rs`, `src-tauri/src/db.rs`
**What:** Two device-local values are stored in the synced `settings` table:
1. `last_seen_uid` in `email.rs` — the IMAP cursor. Syncing it causes devices to fight over scan position, skipping or re-scanning emails.
2. `node_id` in `sync.rs` — the HLC node identifier. If synced, two devices can end up with the same node_id, breaking HLC ordering.

**Fix:** Add migration v6 to `db.rs`:
```sql
CREATE TABLE IF NOT EXISTS device_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```
This table is **local-only** — never add it to `ALLOWED_TABLES` in `sync.rs`.

Then update:
- `email.rs`: replace `settings` reads/writes for `last_seen_uid` with `device_state` reads/writes
- `sync.rs`: replace `settings` reads/writes for `node_id` with `device_state` reads/writes

**Acceptance:**
- `device_state` table exists after migration
- `last_seen_uid` no longer appears in `settings` table
- `node_id` no longer appears in `settings` table
- Two devices maintain independent IMAP cursors and node IDs

**Verification:** `cargo check`

---

### TASK-P1E: Fix `mark_invoice_paid` not writing `paid_at` to SQL (BUG-03)

**File:** `src-tauri/src/commands.rs`, function `mark_invoice_paid`
**What:** The sync event correctly includes `paid_at`, but the SQL is `UPDATE invoices SET status='paid' WHERE id=?1` — `paid_at` is never written to the local database. It stays NULL on the device that marked it paid.
**Fix:** Change the SQL to:
```sql
UPDATE invoices SET status='paid', paid_at=?1 WHERE id=?2
```
Bind `Utc::now().to_rfc3339()` as the first parameter.
**Acceptance:** After marking paid, `paid_at` is non-NULL when querying the invoices table locally.
**Verification:** `cargo check`

---

### TASK-P1F: Fix tax rate lost on invoice edit (BUG-11)

**File:** `src/components/InvoicesView.tsx`, `InvoiceForm` component
**What:** `const [taxRate, setTaxRate] = useState(0)` always initializes to zero, even when editing an existing invoice. Every edit session silently recalculates totals at 0% tax.
**Fix:** Initialize as:
```typescript
const [taxRate, setTaxRate] = useState<number>(
  initial && initial.subtotal > 0
    ? Math.round((initial.tax / initial.subtotal) * 10000) / 100
    : 0
);
```
**Acceptance:** Opening an existing invoice with tax shows the correct tax rate pre-filled. Totals remain unchanged.
**Verification:** Visual check in `cargo tauri dev`

---

## PHASE 2 — Sales Workflow Features

---

### TASK-P2A: Stale clients filter — "Last contacted N days ago" (FEAT-01 + QW-11)

**What:** A filter in ClientsView showing clients whose most recent interaction is older than N days (30/60/90) or never. Also adds "Last Contact" column to the clients table.

**Files to change:**
- `src-tauri/src/commands.rs`:
  - Add `last_contact_at: Option<String>` to the `Client` struct
  - Update `list_clients` query to include `MAX(i.created_at) as last_contact_at` via LEFT JOIN on interactions
  - Add new command `list_stale_clients(days: u32) -> Result<Vec<Client>, String>`:
    ```sql
    SELECT c.*, MAX(i.created_at) as last_contact_at
    FROM clients c
    LEFT JOIN interactions i ON i.client_id = c.id
    GROUP BY c.id
    HAVING last_contact_at IS NULL OR last_contact_at < datetime('now', printf('-%d days', ?1))
    ORDER BY last_contact_at ASC NULLS FIRST
    ```
- `src-tauri/src/main.rs`: register `list_stale_clients`
- `src/lib/api.ts`: add `last_contact_at?: string` to `Client` type; add `listStaleClients(days: number): Promise<Client[]>`
- `src/components/ClientsView.tsx`:
  - Add "Last Contact" column showing relative time ("3 days ago", "Never")
  - Add filter buttons above the table: "All" | "30 days" | "60 days" | "90 days"
  - When a filter is active, call `listStaleClients(days)` instead of `listClients()`
  - Show count badge on the active filter button

**Acceptance:**
- "Last Contact" column visible in client list with relative time
- "60 days" filter shows only clients with no contact in 60+ days
- Clients never contacted appear at the top with "Never"
- Filter count badge updates correctly

**Verification:** `cargo check`

---

### TASK-P2B: Client lead status / pipeline (FEAT-02)

**What:** A `lead_status` field on clients with values: Prospect, Hot Lead, Warm, Active Customer, Inactive. Visible as a colored badge in the list. Filterable.

**Files to change:**
- `src-tauri/src/db.rs`: migration v7 (or next available): `ALTER TABLE clients ADD COLUMN lead_status TEXT NOT NULL DEFAULT 'prospect'`
- `src-tauri/src/commands.rs`:
  - Add `lead_status: String` to `Client` struct and `ClientInput`
  - Include in all client queries (`SELECT ... lead_status ...`)
  - Include in `update_client` sync cols map and SQL
  - Add `update_client_status(id: String, status: String) -> Result<(), String>` command that calls `sync::record_upsert` then direct SQL
- `src-tauri/src/main.rs`: register `update_client_status`
- `src/lib/api.ts`: add `lead_status: string` to `Client` and `ClientInput`; add `updateClientStatus(id, status)`
- `src/components/ClientsView.tsx`:
  - Add status badge column (color coded: Hot Lead=red, Warm=orange, Active=green, Inactive=gray, Prospect=blue)
  - Add filter tabs: All | Hot Lead | Warm | Active | Inactive
  - In the client row, clicking the badge opens a small inline dropdown to change status (no modal)
- `src/components/ClientDetailView.tsx`: show status badge in the header with a click-to-change dropdown

**Acceptance:**
- Every client has a visible colored status badge
- Status can be changed with 2 clicks from the list (click badge → pick new status)
- Filter tabs correctly filter the list
- Status change syncs to other devices

**Verification:** `cargo check`

---

### TASK-P2C: Overdue invoice auto-detection (FEAT-06)

**What:** Invoices with status `sent` and `due_date` in the past should automatically become `overdue`. Currently no invoice ever reaches the `overdue` status.

**Files to change:**
- `src-tauri/src/commands.rs`:
  - Add `mark_overdue_invoices() -> Result<u32, String>` command
  - Query: `SELECT id FROM invoices WHERE status='sent' AND due_date < date('now')`
  - For each result, call `sync::record_upsert("invoices", id, {status: "overdue"})` then direct SQL update
  - Return count of invoices marked overdue
- `src-tauri/src/main.rs`:
  - Register `mark_overdue_invoices`
  - Call it on startup after `replay_all` completes (fire-and-forget with `tauri::async_runtime::spawn`)
- `src/components/InvoicesView.tsx`: ensure `overdue` status shows a red badge (check existing status color mapping, add if missing)

**Constraint:** Must use `sync::record_upsert` per invoice — not a bulk UPDATE. Each invoice needs its own sync event.

**Acceptance:**
- On app launch, past-due sent invoices automatically show as "overdue"
- Overdue status syncs to other devices
- Dashboard outstanding total includes overdue invoices (it already should once status is set)

**Verification:** `cargo check`

---

### TASK-P2D: Follow-up reminders (FEAT-05)

**What:** Surface the existing `next_follow_up_date` field in client metadata as actionable items: a dashboard widget and a launch notification.

**Files to change:**
- `src-tauri/src/commands.rs`:
  - Add `due_followups() -> Result<Vec<Client>, String>` command:
    ```sql
    SELECT * FROM clients
    WHERE json_extract(metadata, '$.next_follow_up_date') IS NOT NULL
    AND json_extract(metadata, '$.next_follow_up_date') <= date('now')
    ORDER BY json_extract(metadata, '$.next_follow_up_date') ASC
    ```
- `src-tauri/src/main.rs`:
  - Register `due_followups`
  - On startup, call `due_followups()`, and if count > 0, fire a `tauri_plugin_notification` with body "You have N follow-up(s) due today"
- `src/lib/api.ts`: add `dueFollowups(): Promise<Client[]>`
- `src/components/DashboardView.tsx`:
  - Add "Follow-ups Due" card showing count
  - If count > 0, show list of client names with their due dates
  - Clicking a client name navigates to their detail view
- `src/components/ClientDetailView.tsx`:
  - Make `next_follow_up_date` editable inline (currently read-only)
  - Add a date input that calls `updateClient` with the new date in metadata

**Acceptance:**
- Dashboard shows follow-ups due today with client names
- Clicking a name navigates to that client
- On launch, system notification fires if any are overdue
- Follow-up date editable from client detail without opening full edit form

**Verification:** `cargo check`

---

### TASK-P2E: Global quick-log modal (FEAT-04)

**What:** A modal accessible from any tab (keyboard shortcut `L` or a floating button) to log a call/meeting/note without navigating away.

**Files to change:**
- `src/App.tsx`:
  - Add `quickLogOpen: boolean` state
  - Add `useEffect` listening for `keydown` — `L` key (when no input is focused) opens the modal
  - Render `<QuickLogModal>` at the App level (not inside any view)
- `src/components/QuickLogModal.tsx` (new file):
  - Fields: client name autocomplete (calls `api.searchClients(q)` as user types), kind dropdown (call / meeting / note / email_out), text body textarea
  - Submit calls `api.addInteraction(...)` using the selected client's ID
  - On success, closes modal and shows a brief toast "Logged"
  - `Escape` closes without saving
- `src/lib/api.ts`: `searchClients` already exists — confirm it's exposed, add if missing

**Constraint:** `addInteraction` already calls `sync::record_upsert` — no backend changes needed if it does.

**Acceptance:**
- Pressing `L` from any tab opens the modal
- Client autocomplete shows results after 1 character
- Log saves in under 3 keypresses (Tab between fields, Enter to submit)
- Modal closes and current tab is preserved

**Verification:** `cargo check` + visual test

---

### TASK-P2F: Mark invoice paid with payment details (FEAT-09, also fixes BUG-03)

**What:** Replace the direct "Mark as paid" button with a small modal: payment date (default today), payment method (from payment_methods table), reference number.

**Files to change:**
- `src-tauri/src/db.rs`: migration (next available number):
  ```sql
  ALTER TABLE invoices ADD COLUMN payment_method_label TEXT;
  ALTER TABLE invoices ADD COLUMN payment_reference TEXT;
  ```
- `src-tauri/src/commands.rs`:
  - Update `mark_invoice_paid` signature: add `paid_date: String, payment_method_label: Option<String>, payment_reference: Option<String>`
  - Include all new fields in `sync::record_upsert` cols map
  - Fix the SQL to: `UPDATE invoices SET status='paid', paid_at=?1, payment_method_label=?2, payment_reference=?3 WHERE id=?4` (this also fixes BUG-03)
- `src/lib/api.ts`: update `markInvoicePaid(id, paidDate, methodLabel?, reference?)`
- `src/components/InvoicesView.tsx`:
  - Replace the direct `handleMarkPaid` call with a modal
  - Modal fields: date picker (default today), method dropdown (load from `api.listPaymentMethods()`), reference text input (optional)
  - On confirm, call updated `api.markInvoicePaid(...)`

**Acceptance:**
- Clicking "Mark as paid" opens a 3-field modal
- Payment date defaults to today
- Method dropdown shows active payment methods
- Reference is optional
- `paid_at` correctly written to local DB (BUG-03 fixed)
- Payment details visible in invoice list/detail

**Verification:** `cargo check`

---

## PHASE 3 — Quick Wins (do these as a batch — they're all small)

### TASK-P3A: Quick wins batch

Do all of the following in a single task. Plan all changes at once. Execute together. One `cargo check`.

**QW-02 — Remember last tab (5 min):**
In `src/App.tsx`:
- On tab change: `localStorage.setItem('clienthub_last_tab', tab)`
- Initial state: `useState<Tab>((localStorage.getItem('clienthub_last_tab') as Tab) || 'dashboard')`

**QW-01 — Keyboard shortcuts (20 min):**
In `src/App.tsx`, add `useEffect` for `keydown`:
- `n` → if on clients tab, trigger new client form; if on invoices tab, trigger new invoice form
- `l` → open quick-log modal (same as TASK-P2E — coordinate so they share state)
- `Escape` → close any open modal

**QW-05 — Better delete confirmation (5 min):**
In `src/components/ClientsView.tsx`, change confirm message to:
```typescript
confirm(`Delete ${client.name}? This will also delete all their interactions. This cannot be undone.`)
```

**QW-10 — Mark paid confirmation (5 min):**
In `src/components/InvoicesView.tsx`:
```typescript
if (!confirm('Mark this invoice as paid? This cannot be undone.')) return;
```
Note: if TASK-P2F is done first, this is handled by the modal — skip this one.

**QW-06 — Copy email button (10 min):**
In `src/components/ClientDetailView.tsx`, next to the email field:
```tsx
<button onClick={() => navigator.clipboard.writeText(client.email)}>Copy</button>
```
Brief "Copied!" tooltip using a `useState` timer.

**QW-07 — Empty states with action buttons (20 min):**
In `ClientsView.tsx` and `InvoicesView.tsx`, replace plain "No X yet." text with:
```tsx
<div className="text-center py-16 text-gray-400">
  <p className="text-lg mb-2">No clients yet</p>
  <p className="text-sm mb-4">Add your first client to get started</p>
  <button onClick={() => setShowForm(true)} className="...">Add Client</button>
</div>
```

**QW-12 — Fix invoice_count (10 min):**
In all three client queries in `commands.rs`, change:
```sql
status IN ('sent','paid')
```
to just `COUNT(*)` with no status filter.

**QW-09 — PDF success feedback (10 min):**
In `InvoicesView.tsx`, replace `alert(\`PDF saved:\n${p}\`)` with a brief inline toast: "PDF opened in your PDF viewer" (no path shown).

**QW-04 — Draft count in nav (15 min):**
Move `draftCount` up to `App.tsx` state, pass down to `EmailView` for the tab badge AND display a small badge on the "Email" nav button in the sidebar when `draftCount > 0`.

**Acceptance for all:** Visual check in `cargo tauri dev`. No compile errors.

---

## PHASE 4 — Performance (do after Phase 3)

### TASK-P4A: Fix N+1 client queries + add invoice filter (PERF-01 + PERF-02)

**PERF-01:** In `commands.rs`, replace the correlated subquery in `list_clients`, `get_client`, and `search_clients` with a LEFT JOIN:
```sql
SELECT c.*, COALESCE(inv.cnt, 0) as invoice_count,
       MAX(i.created_at) as last_contact_at
FROM clients c
LEFT JOIN (SELECT client_id, COUNT(*) as cnt FROM invoices GROUP BY client_id) inv
  ON inv.client_id = c.id
LEFT JOIN interactions i ON i.client_id = c.id
GROUP BY c.id
ORDER BY c.name
```

**PERF-02:** Add `list_invoices_for_client(client_id: String) -> Result<Vec<Invoice>, String>` command:
```sql
SELECT * FROM invoices WHERE client_id=?1 ORDER BY issue_date DESC
```
Register in `main.rs`, expose in `api.ts`. Update `ClientDetailView.tsx` to call `api.listInvoicesForClient(clientId)` instead of filtering all invoices client-side.

**Verification:** `cargo check`

---

### TASK-P4B: Add missing DB index (PERF-06)

In `db.rs`, append migration (next number):
```sql
CREATE INDEX IF NOT EXISTS idx_invoices_status_date ON invoices(status, issue_date);
CREATE INDEX IF NOT EXISTS idx_interactions_client_date ON interactions(client_id, created_at);
```

The second index is not in IMPROVEMENTS.md but will be needed by FEAT-01 and P2A queries. Proactively add it.

**Verification:** `cargo check`

---

### TASK-P4C: Sync replay cursor (PERF-04)

**File:** `src-tauri/src/sync.rs`, `src-tauri/src/db.rs`
**What:** `replay_all` reads and JSON-parses every sync event file on every call. With 10,000+ events this becomes slow.
**Fix:**
- Add migration: `ALTER TABLE sync_meta ADD COLUMN last_replay_cursor TEXT` (or add to `device_state` if sync_meta doesn't exist)
- In `replay_all`, after reading the sync dir file list (already sorted lexicographically by filename), skip files whose name ≤ `last_replay_cursor`
- After successfully applying events, update the cursor to the last processed filename

**Constraint:** File names are already formatted as `{timestamp}-{counter}-...` so lexicographic sort = chronological sort. This is safe.

**Verification:** `cargo check`

---

## PHASE 5 — Code Quality

### TASK-P5A: Code quality cleanup batch

Do all of the following together:

**QC-01 — Remove dead `done` field:**
In `src-tauri/src/ai.rs`, remove the `done: bool` field from `GenResp`. It is deserialized but never read.

**QC-04 — Add error handling to `handleMarkPaid`:**
In `InvoicesView.tsx`, add `catch (e: any) { alert(\`Error: ${e}\`); }` to the `handleMarkPaid` try block.

**QC-05 — Add error logging to `refreshDraftCount`:**
In `EmailView.tsx`, change empty `catch {}` to `catch (e) { console.error('draft count failed:', e); }`.

**QC-06 — Remove production console.log for credentials:**
In `SettingsView.tsx`, remove or wrap in `if (import.meta.env.DEV)`:
```typescript
console.log("smtp_pass saved to keychain, length:", smtpPass.length);
console.warn("smtp_pass was empty — not saved");
```

**QC-07 — Remove `imap_host` from keychain:**
In `SettingsView.tsx`, remove `await api.saveCredential("imap_host", settings.imap_host)`. The hostname is not a secret and is already stored in EmailSettings JSON.

**QC-08 — Add email validation:**
In `ClientsView.tsx` and `EmailView.tsx`, add `type="email"` to all email inputs.

**QC-09 — Remove duplicate `TextField` in InvoicesView:**
In `InvoicesView.tsx`, remove the `TextField` component definition (identical to `Field`) and replace all `TextField` usages with `Field`.

**BUG-10 — Fix NULL concatenation in AI history query:**
In `commands.rs`, function `ai_summarize_history`, change:
```sql
SELECT subject || ': ' || body FROM interactions
```
to:
```sql
SELECT COALESCE(subject, '') || ': ' || COALESCE(body, '') FROM interactions
WHERE subject IS NOT NULL OR body IS NOT NULL
```

**QC-13 — Update ARCHITECTURE.md:**
Add `payment_methods` to the synced tables list in `ARCHITECTURE.md`.

**Verification:** `cargo check`

---

## PHASE 6 — Larger Features (after everything above is stable)

Work these one at a time, plan-first as always:

- **FEAT-07** — Invoice deposit-pending status
- **FEAT-08** — Line item templates (local-only table)
- **FEAT-10** — AI draft tone selector (Formal / Neutral / Casual)
- **FEAT-03** — Revenue per client column (sortable)
- **FEAT-11** — Dashboard: contacts this week + revenue chart
- **FEAT-12** — Client email thread tab
- **FEAT-13** — Recurring invoices
- **FEAT-14** — Unified client timeline

---

## How to assign tasks

The human will say something like:

> "Start TASK-P1A. Phase 1 plan only. Wait for approval."

You generate the plan listing every specific change. Wait. Human says "approved." You execute. Human runs `cargo check`. You get the result. Task is closed. Next task is assigned.

Do not self-assign. Do not bundle tasks across phases unless explicitly told. Do not start Phase 2 until all Phase 1 tasks are verified.
