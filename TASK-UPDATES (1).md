# TASK-UPDATES: ClientHub Next Feature Updates

This document contains the next batch of updates for the ClientHub desktop app.
All tasks follow strict protocol: **plan first, wait for approval, then execute**.
Never write code without an approved plan. Push after every task with `git add -A && git commit -m "..." && git push`.

---

## Group 1: Dashboard Display Fixes

### 1A — Responsive number formatting in revenue breakdown

**Problem:** On MacBook, large revenue numbers in the dashboard breakdown cards wrap onto two lines, overlapping and looking broken.

**Fix:**
- Format all currency numbers using compact notation: `$108,432` → `$108k`, `$1,240,000` → `$1.2M`
- Apply this formatting to every dollar amount displayed in the dashboard stat cards and revenue breakdown section
- On hover (desktop) or tap (mobile), show a tooltip with the full unformatted number (e.g. `$108,432.50`)
- Thresholds: under $1,000 show full amount, $1,000–$999,999 show `$Xk`, $1M+ show `$X.XM`
- Never truncate in a way that loses meaning — always round to 1 decimal place for M, nearest whole number for k

**Files likely affected:** `src/components/DashboardView.tsx` (or equivalent dashboard component), any shared currency formatting utility

**Plan required:** List every place currency amounts are displayed in the dashboard and how each will be reformatted.

---

## Group 2: Client Tier System

### 2A — Replace "Prospect" status labels with tier badges

**Problem:** The clients section shows "Prospect" as the status everywhere, even for active paying customers. This is the lead status field, not the tier. The tier-based system (S/A/B/C/Prospect based on annual spend) already exists but isn't being displayed in place of the raw lead status label in client rows and cards.

**Fix:**
- In the clients list view, replace the lead status badge (that shows "Prospect") with the buyer tier badge (S / A / B / C / Prospect)
- The tier is already computed by the `buyer_tiers` command — use that
- Keep the lead status field accessible in the client detail/edit view (it still has value internally)
- Tier badge colors: S = gold, A = silver/blue, B = green, C = orange, Prospect = gray
- If no tier is computed yet (new client, no invoices), show "New" badge in gray

**Plan required:** Show exactly which components display the lead status label, and how the tier data will be fetched and injected.

### 2B — Auto-promote client to Bronze/Prospect tier on email received

**Problem:** Currently tier is based purely on invoice spend. We want to automatically move a client from no-tier to "Prospect" tier when we receive an email from them, indicating they have engaged with us.

**Fix:**
- When the inbox scanner (`scan_inbox` command) finds a new email from a client, check their current tier
- If the client has no tier (never purchased, no spend), automatically set their `lead_status` to `prospect` and log a sync event
- This should happen as part of the existing inbox scan flow — not a separate manual action
- Do NOT change the tier of clients who already have a spend-based tier (B, A, S) — only promote from null/unknown to prospect

**Plan required:** Show the current `scan_inbox` flow and exactly where the tier check and update will be inserted.

---

## Group 3: Newsletter & Email Section

### 3A — Rename "AI Email" to "Newsletter" in sidebar

**Problem:** The left sidebar navigation item currently says "AI Email" which is confusing. It should say "Newsletter" since that's the primary use of that section.

**Fix:**
- Change the sidebar nav label from "AI Email" to "Newsletter"
- Change the corresponding page title/header from "AI Email" to "Newsletter"
- Do not change any functionality — label change only

**Files likely affected:** sidebar nav component, page header in the email/newsletter view

**Plan required:** List every place the string "AI Email" appears in the codebase (labels, titles, aria labels, comments) and confirm all will be updated.

### 3B — Make Newsletter the default/first tab in the section

**Problem:** When opening the Newsletter section, it defaults to a tab other than the newsletter composer. The newsletter should be the first thing you see.

**Fix:**
- Reorder the tabs so Newsletter (compose/send) is the first/default tab
- All other tabs (templates, drafts, inbox, etc.) follow after
- The active tab on section load should be Newsletter

**Plan required:** Show current tab order and the new order after the change.

### 3C — Allow deletion of saved email templates

**Problem:** There is currently no way to delete saved email templates. Once saved, a template is permanent.

**Fix:**
- Add a delete button to each saved template row (trash icon, shown on hover on desktop, always visible on mobile)
- Clicking delete shows a confirmation dialog: "Delete template '[name]'? This cannot be undone."
- On confirm, call the existing `delete_line_item_template` or equivalent template delete command
- Remove the template from the list immediately (optimistic UI update)
- If the delete fails, show an error toast and restore the template in the list

**Plan required:** Identify the exact Tauri command for deleting email templates and confirm it exists. If it doesn't exist, it needs to be created first.

### 3D — Error tracking and user feedback when newsletter fails to send

**Problem:** When a newsletter fails to send (e.g. MP4 attachment too large, SMTP auth failure, recipient error), the app shows "sending" then silently fails with no feedback. The user has no way to know if emails went out or not.

**Fix:**
- Track send success/failure per recipient in the `newsletter_sends` table — add a `status` column (`sent`, `failed`, `skipped`) and `error_message` column if not already present
- After a send attempt, show a summary modal: "Sent: 87 / Failed: 3 / Skipped: 2" with a breakdown
- Failed recipients should show the error reason (e.g. "Invalid email address", "SMTP timeout", "Attachment too large")
- If the entire send fails before starting (e.g. SMTP auth error, attachment too large), show an immediate error toast with the specific reason — not just a silent spinner
- Log all send attempts to the `newsletter_sends` table regardless of outcome

**Plan required:** Show current newsletter send flow, identify where errors are swallowed, and list all database schema changes needed.

### 3E — Scheduled send for newsletters

**Problem:** Sending a newsletter to 100+ clients all at once triggers spam filters because emails arrive in a burst. Need the ability to schedule sends spread over time.

**Fix:**
- Add a "Schedule Send" option alongside the existing "Send Now" button
- Options: Send Now / Send over 1 hour / Send over 2 hours / Send over 4 hours / Custom (pick date/time)
- When scheduled, store the send job in a new `scheduled_sends` table with: `newsletter_id`, `scheduled_at`, `interval_seconds`, `total_recipients`, `sent_count`, `status`
- A background task in the Tauri app checks for pending scheduled sends on a timer (every 60 seconds)
- Sends emails in batches: for "Send over 1 hour" with 100 recipients, sends ~2 emails per minute
- Show a progress indicator in the newsletter section while a scheduled send is running: "Sending: 42/100 — Est. finish in 29 min"
- Allow canceling a scheduled send in progress

**Plan required:** This is a significant feature. Plan must include:
1. Database schema for `scheduled_sends` table
2. Background task architecture (Tauri async command or interval timer)
3. UI changes to the send flow
4. How progress is tracked and displayed
5. Cancel flow

---

## Protocol Reminder

- **Plan first, wait for approval, then execute** — no exceptions
- After every task: `git add -A && git commit -m "descriptive message" && git push`
- Show push output to confirm it went through
- Do not start the next task until the current one is verified working
- For database schema changes: always use `ALTER TABLE IF NOT EXISTS` or migrations to avoid breaking existing installs
- For UI changes: test on both MacBook (smaller screen) and the standard window size

---

## Start Instructions

Read this entire file before doing anything.

Generate a Phase 1 plan for **Group 1 (1A — Dashboard number formatting) only**.

List:
- Every file that will be changed
- Every place currency amounts are currently displayed in the dashboard
- The exact formatting function you will write
- How the hover tooltip will be implemented

Wait for approval before writing any code.
