# TASK-CLIENTS-V2: Client Filtering, Missing Info, Enhanced Form, Newsletter

Read this entire file before planning anything. These are four related features that share data model changes. Do them in order. Plan-first, wait for approval, execute, verify with `npm run build` and `cargo check`.

---

## Overview

Four features, executed in this order:

1. **Enhanced client form** — add all fields so new clients can have complete info
2. **Advanced client filtering** — filter by any field, not just lead status
3. **Missing information panel** — surface clients with incomplete data
4. **Newsletter / bulk email** — send personalized individual emails to selected clients with AI assist

---

## FEATURE 1: Enhanced Client Form

### What's missing

When creating a client, the form only captures basic fields. Existing clients have rich metadata (address, category, notes, etc.) that new clients can't get during creation.

### DB changes

No new migrations needed — the `metadata` JSON column on `clients` already stores arbitrary fields. We just need to expose more fields in the UI and commands.

### Backend changes

**File: `src-tauri/src/commands.rs`**

Update `ClientInput` struct to include all fields:

```rust
pub struct ClientInput {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub company: Option<String>,
    pub lead_status: Option<String>,
    pub category: Option<String>,        // NEW: e.g. "wholesale", "retail", "distributor"
    pub tags: Option<String>,            // NEW: comma-separated tags
    pub street_address: Option<String>,  // NEW
    pub city: Option<String>,            // NEW
    pub state: Option<String>,           // NEW
    pub zip_code: Option<String>,        // NEW
    pub notes: Option<String>,           // NEW: internal notes about this client
    pub next_follow_up_date: Option<String>, // NEW: expose this directly
}
```

In `create_client` and `update_client`, pack the address/notes/category/tags/next_follow_up_date fields into the `metadata` JSON column alongside existing metadata fields. Read them back out when loading clients.

Update the `Client` struct to include:
```rust
pub category: Option<String>,
pub tags: Option<String>,
pub street_address: Option<String>,
pub city: Option<String>,
pub state: Option<String>,
pub zip_code: Option<String>,
pub notes: Option<String>,
pub next_follow_up_date: Option<String>,
```

These should be extracted from `metadata` JSON when querying clients, same pattern as existing metadata extraction.

### Frontend changes

**File: `src/lib/api.ts`**

Add all new fields to `Client` and `ClientInput` types.

**File: `src/components/ClientsView.tsx`** — update `ClientForm` component

Organize the form into logical sections with clear visual grouping:

**Section 1 — Basic Info** (always visible)
- Name (required)
- Email
- Phone
- Company

**Section 2 — Classification**
- Category (text input with datalist suggestions: "Wholesale", "Retail", "Distributor", "Manufacturer", "Other")
- Lead Status (existing dropdown: Prospect / Hot Lead / Warm / Active Customer / Inactive)
- Tags (text input, comma-separated, placeholder "e.g. vip, new-york, apparel")

**Section 3 — Address**
- Street Address
- City
- State (text input)
- ZIP Code

**Section 4 — Notes & Follow-up**
- Internal Notes (textarea, 3 rows, placeholder "Private notes about this client — not visible to client")
- Next Follow-up Date (date input)

All sections visible by default. No collapsing needed.

### Acceptance criteria
- New client form shows all sections
- Saving a new client with address/category/notes persists correctly
- Editing an existing client pre-fills all fields correctly
- `cargo check` and `npm run build` pass

---

## FEATURE 2: Advanced Client Filtering

### What it does

A filter bar above the client list letting the user filter by any combination of: category, lead status, tags, state, last contact window, missing info type. Replaces the current simple lead status tab buttons.

### Backend changes

**File: `src-tauri/src/commands.rs`**

Add `list_clients_filtered` command:

```rust
pub struct ClientFilter {
    pub category: Option<String>,
    pub lead_status: Option<String>,
    pub tag: Option<String>,           // matches if tag appears in tags field
    pub state: Option<String>,
    pub stale_days: Option<u32>,       // last contact older than N days
    pub missing: Option<String>,       // "email" | "phone" | "address" | "category"
    pub search: Option<String>,        // text search across name/company/email
}

pub async fn list_clients_filtered(filter: ClientFilter) -> Result<Vec<Client>, String>
```

Build the SQL dynamically based on which filter fields are non-null. Use parameterized queries (never string interpolation). For `tag`, use `LIKE '%' || ?1 || '%'` on the tags field. For `missing`, check for NULL or empty string on the relevant column. For `stale_days`, LEFT JOIN interactions and apply date filter.

Register in `main.rs`.

**File: `src/lib/api.ts`**

Add `ClientFilter` type and `listClientsFiltered(filter: ClientFilter): Promise<Client[]>`.

### Frontend changes

**File: `src/components/ClientsView.tsx`**

Replace the current lead status tab buttons with a filter bar containing:

**Row 1 — Search + quick filters:**
- Search input (text, searches name/company/email, debounced 300ms)
- Category dropdown (All Categories + unique categories from loaded clients)
- Lead Status dropdown (All Statuses + the 5 status values)
- "More filters" toggle button that reveals Row 2

**Row 2 — Advanced filters (hidden by default, shown when "More filters" clicked):**
- State input (text)
- Tag input (text, filters clients whose tags contain this word)
- Last Contact dropdown (Any time / 30+ days / 60+ days / 90+ days / Never)
- Missing Info dropdown (Any / Missing email / Missing phone / Missing address / Missing category)
- Clear all filters button

**Active filter chips:** When any filter is active, show a row of removable chips below the filter bar showing what's active (e.g. "Category: Wholesale ×", "60+ days ×"). Clicking × removes that filter.

When any filter changes, call `api.listClientsFiltered(filter)` and update the list. When all filters are cleared, call `api.listClients()`.

Show result count: "Showing 12 of 47 clients" when filters are active.

### Acceptance criteria
- Search filters by name, company, email in real time
- Category and status dropdowns populate from actual data
- Multiple filters combine (AND logic — must match all active filters)
- Active filters shown as removable chips
- Clear all resets to full list
- `npm run build` passes

---

## FEATURE 3: Missing Information Panel

### What it does

A collapsible panel above the client list (or accessible via a tab) that shows clients with incomplete data, grouped by what's missing. Helps the user prioritize data cleanup.

### Backend changes

**File: `src-tauri/src/commands.rs`**

Add `clients_missing_info() -> Result<MissingInfoReport, String>` command:

```rust
pub struct MissingInfoReport {
    pub missing_email: Vec<Client>,
    pub missing_phone: Vec<Client>,
    pub missing_address: Vec<Client>,
    pub missing_category: Vec<Client>,
    pub never_contacted: Vec<Client>,
    pub total_incomplete: u32,
}
```

Query each category:
- `missing_email`: clients WHERE email IS NULL OR email = ''
- `missing_phone`: clients WHERE phone IS NULL OR phone = '' (from metadata)
- `missing_address`: clients WHERE json_extract(metadata, '$.street_address') IS NULL
- `missing_category`: clients WHERE json_extract(metadata, '$.category') IS NULL
- `never_contacted`: clients with no interactions (LEFT JOIN interactions, WHERE interaction id IS NULL)

A client can appear in multiple categories.

Register in `main.rs`. Add to `api.ts`.

### Frontend changes

**File: `src/components/ClientsView.tsx`**

Add a "Data Health" panel above the filter bar. Collapsed by default, expandable with a chevron toggle.

**Collapsed state:** Shows a single line — "⚠ 8 clients have incomplete data" (or nothing if 0). Clicking expands.

**Expanded state:** Shows 5 rows, each with:
- Icon + label ("Missing email", "Missing phone", etc.)
- Count badge
- "View" button that applies the corresponding filter to the client list and scrolls to it

Layout:
```
┌─ Data Health ──────────────────────────── ▼ ─┐
│ ⚠ Missing email          12 clients  [View]  │
│ ⚠ Missing phone           8 clients  [View]  │
│ ⚠ Missing address        15 clients  [View]  │
│ ⚠ Missing category        6 clients  [View]  │
│ ○ Never contacted          3 clients  [View]  │
└───────────────────────────────────────────────┘
```

Clicking "View" sets the missing filter in the filter bar and calls `listClientsFiltered`.

Load `clientsMissingInfo()` on mount alongside `listClients()`. Refresh after any client save.

### Acceptance criteria
- Panel collapsed by default, shows total incomplete count
- Expanding shows all 5 categories with counts
- "View" filters the list to that category
- Count updates after editing a client (fill in missing email → count decreases)
- Zero incomplete = panel shows green "All client data complete ✓" and stays collapsed
- `npm run build` passes

---

## FEATURE 4: Newsletter / Bulk Email

### What it does

A "Newsletter" tab in the Email view. Select clients (individually or by filter/category), compose a message with AI assist, preview how it will look for each recipient, then send — each client gets an individual personalized email (not CC/BCC visible to others). Their first name is inserted automatically.

### DB changes

**File: `src-tauri/src/db.rs`** — append new migration:

```sql
CREATE TABLE IF NOT EXISTS newsletters (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    recipient_count INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    sent_at TEXT
);

CREATE TABLE IF NOT EXISTS newsletter_sends (
    id TEXT PRIMARY KEY,
    newsletter_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at TEXT,
    error TEXT,
    FOREIGN KEY (newsletter_id) REFERENCES newsletters(id)
);
```

`newsletters` is **local-only** — do NOT add to `ALLOWED_TABLES`. Newsletter sends are device-specific.

### Backend changes

**File: `src-tauri/src/commands.rs`**

Add these commands:

```rust
// List saved newsletter drafts
pub async fn list_newsletters() -> Result<Vec<Newsletter>, String>

// Create or update a newsletter draft
pub async fn save_newsletter(id: Option<String>, subject: String, body: String) -> Result<Newsletter, String>

// Delete a newsletter draft
pub async fn delete_newsletter(id: String) -> Result<(), String>

// Send newsletter to selected clients
// body_template uses {{first_name}} as the only placeholder
// Each client gets their own individual email — no CC/BCC exposure
// subject_template can also use {{first_name}}
pub async fn send_newsletter(
    newsletter_id: String,
    client_ids: Vec<String>,
    subject_template: String,
    body_template: String,
) -> Result<NewsletterSendResult, String>

pub struct NewsletterSendResult {
    pub sent: u32,
    pub failed: u32,
    pub errors: Vec<String>,
}

// AI assist: generate newsletter draft given a topic/prompt
pub async fn ai_draft_newsletter(prompt: String, tone: String) -> Result<String, String>
```

**`send_newsletter` implementation details:**

For each `client_id` in `client_ids`:
1. Fetch client name and email from DB
2. If client has no email, record as failed, continue
3. Replace `{{first_name}}` in body_template with `client.name.split_whitespace().next().unwrap_or(&client.name)`
4. Replace `{{first_name}}` in subject_template the same way
5. Call `email::send(&client_email, &personalized_subject, &personalized_body, None).await`
6. Record result in `newsletter_sends` table
7. Update `newsletters.sent_count` and `newsletters.sent_at`

**Critical:** each email is sent individually. No CC. No BCC. Each recipient sees only their own email in the To field. This is handled naturally by calling `email::send` once per client.

**`ai_draft_newsletter` implementation:**

Call Ollama with a system prompt:
```
You are a professional business email writer for a wholesale distribution company.
Write a newsletter email in {tone} tone.
The email will be personalized — use {{first_name}} as a placeholder where the recipient's name should appear (usually in the greeting).
Write only the email body, no subject line. Keep it concise (150-250 words).
Do not include any explanation or metadata.
```

User prompt: the `prompt` parameter (e.g. "new manifest arrived, featuring 500 units of...")

Return the raw body text with `{{first_name}}` placeholder included.

Register all commands in `main.rs`.

**File: `src-tauri/capabilities/default.json`** — no changes needed (covered by existing permissions).

**File: `src/lib/api.ts`** — add:
```typescript
export interface Newsletter {
  id: string;
  subject: string;
  body: string;
  status: string;
  recipient_count: number;
  sent_count: number;
  created_at: string;
  sent_at?: string;
}

export interface NewsletterSendResult {
  sent: number;
  failed: number;
  errors: string[];
}
```

Add all 5 API methods.

### Frontend changes

**File: `src/components/EmailView.tsx`**

Add a "Newsletter" tab to the existing tab bar (alongside Inbox, Drafts, etc.).

**Newsletter tab layout — three panels:**

---

**Panel A: Recipients (left, 280px)**

Header: "Recipients" + count badge

Three ways to add recipients:

1. **By category** — dropdown showing all unique categories from clients. Selecting one adds all clients in that category.
2. **Search and add** — type a client name, autocomplete shows matches, click to add individually.
3. **Select all** button — adds every client with a valid email address.

Selected recipients list:
- Each row: client name + email + remove button (×)
- If client has no email: shown in red with "No email" badge, automatically excluded from send
- Scroll if more than 10 recipients

Footer: "X recipients selected (Y have no email — will be skipped)"

---

**Panel B: Compose (center, flexible)**

**Subject line input** — full width, placeholder "Subject (use {{first_name}} for personalization)"

**Body textarea** — tall, monospace font, placeholder:
```
Hi {{first_name}},

Write your message here...

Best regards,
[Your name]
```

**AI Assist bar** below the textarea:
- Prompt input: "Describe what this newsletter is about..."
- Tone selector: Formal | Neutral | Casual (3-button toggle)
- "Generate Draft" button → calls `api.aiDraftNewsletter(prompt, tone)` → inserts result into body textarea
- While generating: spinner + "Writing your newsletter..."
- After generating: body textarea updates, user can edit freely

**Toolbar above textarea:**
- "Insert {{first_name}}" button — inserts at cursor position
- Character count
- Word count

**Template management:**
- "Save as template" button → saves current subject+body as a newsletter draft via `api.saveNewsletter()`
- "Load template" dropdown → shows saved newsletter drafts, selecting one loads subject+body

---

**Panel C: Preview & Send (right, 320px)**

**Preview section:**
- "Preview as:" dropdown showing selected recipients (or "Sample recipient" if none selected)
- Shows rendered preview of the email with `{{first_name}}` replaced by the selected client's actual first name
- Updates live as body changes
- Scrollable if email is long

**Send section:**
- Large "Send Newsletter" button (`bg-indigo-600 text-white`, full width, 44px height)
- Disabled if: no recipients, no subject, no body, or email not configured
- Shows warning if any recipients have no email: "3 recipients will be skipped (no email)"
- On click: confirmation dialog — "Send to X recipients? Each will receive an individual email. This cannot be undone."
- On confirm: calls `api.sendNewsletter(...)` 
- During send: button shows "Sending... (X/Y)" with progress
- On complete: shows result toast — "Sent to X clients. Y failed." with error details expandable

**Send history** (below send button, collapsed):
- Shows last 5 newsletters sent: subject, date, recipient count
- Click to expand and see per-client status

---

### Acceptance criteria

- Recipients panel: add by category adds all clients in that category; search adds individually; clients without email shown but excluded
- `{{first_name}}` in subject and body gets replaced with actual first name for each recipient
- Each client receives their own individual email (verified by checking email headers — no BCC list)
- AI generates a coherent newsletter draft in the selected tone
- Preview shows personalized content for the selected preview recipient
- Send confirmation dialog shows correct count
- Progress updates during send (not just a spinner)
- After send, sent count shows in newsletter history
- Saving a draft persists subject + body
- Loading a draft restores subject + body
- `npm run build` and `cargo check` pass

---

## Implementation order

Do these in order. Each must pass `npm run build` and `cargo check` before the next begins.

**Step 1:** FEATURE 1 (enhanced client form) — backend struct changes + frontend form sections
**Step 2:** FEATURE 2 (advanced filtering) — new command + filter bar UI
**Step 3:** FEATURE 3 (missing info panel) — new command + collapsible panel
**Step 4:** FEATURE 4 (newsletter) — DB migration + all commands + full newsletter tab

---

## Constraints (apply to all four features)

- `invoice.rs` image/PDF code: do NOT touch. See `PDF-API-CONTRACT.md`.
- All writes to synced tables go through `sync::record_upsert`. `newsletters` and `newsletter_sends` are local-only — direct SQL only, no sync.
- No SQLite connection may cross an `.await` boundary. Use inner `{ }` blocks.
- No new npm packages. Use existing Tailwind classes and React patterns already in the codebase.
- Horizontal scrolling issue in ClientsView: fix by adding `overflow-x-auto` to the table wrapper `<div>` and ensuring the table uses `min-w-full` instead of `w-full`. Do this as part of Step 1 or 2.
- After each step: `cargo check` (human runs it) + `npm run build` (human runs it). Do not proceed to the next step until both pass.

---

## Start instructions

Generate Phase 1 plan for **FEATURE 1 only** (enhanced client form). List every file you will change and every specific change. Wait for approval before executing.
