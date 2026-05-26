# TASK-ROADMAP: ClientHub Commercial Feature Roadmap

## Behavioral Guidelines (CLAUDE.md Integration)

Before planning or executing ANY task in this document:

1. **Think before coding** — State assumptions explicitly. If multiple interpretations exist, present them. If something is unclear, stop and ask. Do not assume.
2. **Simplicity first** — Minimum code that solves the problem. No speculative features. No abstractions for single-use code. If you write 200 lines and it could be 50, rewrite it.
3. **Surgical changes** — Touch only what you must. Do not "improve" adjacent code. Match existing style. Every changed line must trace directly to the request.
4. **Goal-driven execution** — Define success criteria before starting. For every task, state: what changes, how to verify it works, what done looks like.

**Protocol:** Plan first, wait for approval, then execute. Never write code without an approved plan. Push after every task with `git add -A && git commit -m "..." && git push`. Show push output to confirm.

---

## Task 1: Auto-Updater

### Goal
When a new version of ClientHub is released, every installed copy automatically detects and installs the update without the user doing anything manually. Uses Tauri's built-in updater system.

### Success criteria
- [ ] New build published → user opens app → sees update notification → clicks install → app restarts on new version
- [ ] If no update available → app opens normally with no notification
- [ ] Update check happens silently in background — does not block app launch

### Implementation plan (agent must confirm before executing)

**Assumptions to confirm:**
- Where will update artifacts be hosted? Options: GitHub Releases (free, recommended), your own server, S3. Plan assumes GitHub Releases.
- Signing key: Tauri updater requires a signing keypair. Agent must generate this and document where keys are stored securely.

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/tauri.conf.json` | Enable updater plugin, set endpoints, pubkey |
| `src-tauri/Cargo.toml` | Add tauri updater feature flag |
| `src-tauri/src/main.rs` | Call updater check on startup |
| `src/components/UpdateNotification.tsx` | New — update available banner |
| `src/App.tsx` | Mount UpdateNotification component |

**Behavior:**
- On app launch, check GitHub Releases for a newer version (compare semver)
- If update available: show a non-blocking banner at top of app: "Version X.X is available — [Install Now] [Later]"
- "Install Now" downloads and installs, app restarts automatically
- "Later" dismisses banner until next app launch
- Update check is async — never delays app startup

**Verify:**
1. Build v10.1, publish to GitHub Releases with correct JSON signature file
2. Install v10.0, open app → banner appears
3. Click Install → app restarts on v10.1
4. Open app again → no banner

**Plan required:** Show exact `tauri.conf.json` updater config, how signing keys are generated and stored, and the GitHub Release artifact structure required.

---

## Task 2: Onboarding Wizard

### Goal
First-time users see a guided setup flow instead of an empty app. Collects essential business info and walks through initial configuration. Shows once, never again after completion.

### Success criteria
- [ ] Fresh install → wizard appears automatically on first launch
- [ ] Completing wizard → normal app loads, wizard never shows again
- [ ] Skipping wizard → normal app loads, wizard never shows again
- [ ] All data entered in wizard is saved correctly to settings table

### Steps in the wizard (5 screens)

**Screen 1 — Welcome**
"Welcome to ClientHub. Let's get you set up in 2 minutes."
Single "Get Started" button. No data entry.

**Screen 2 — Business Info**
Fields:
- Business name (required)
- Your name (required)
- Business email
- Phone number
- Address (street, city, state, zip)
- Logo upload (optional — PNG/JPG, stored locally)

**Screen 3 — Email Setup**
Fields:
- SMTP host (with preset buttons: Gmail / Outlook / Custom)
- SMTP port (auto-fills based on preset: 587)
- Username / email
- Password (App Password for Gmail)
- From name
- [Test Connection] button — must pass before proceeding

"Using Gmail? You need an App Password, not your regular password. [Learn how →]" info link.

**Screen 4 — Import Clients (optional)**
"Have an existing client list? Import it now."
- [Upload CSV] button
- Column mapping UI (drag columns to match: Name, Company, Email, Phone, City, State)
- Preview table showing first 5 rows
- [Import X clients] button
- [Skip for now] link

**Screen 5 — Done**
"You're all set. ClientHub is ready."
- Summary: "X clients imported, email configured"
- [Open ClientHub] button

### Implementation notes
- Wizard state stored in `settings` table as `onboarding_completed: "true"`
- Check this on app startup — if missing or false, show wizard
- Wizard is a full-screen overlay component, not a separate route
- Logo stored as base64 in settings table under `company_logo`

**Files changing:**
| File | Change |
|------|--------|
| `src/components/OnboardingWizard.tsx` | New — full wizard component |
| `src/App.tsx` | Check onboarding_completed on mount, render wizard |
| `src-tauri/src/commands.rs` | `complete_onboarding`, `get_onboarding_status` commands |
| `src/lib/api.ts` | New API methods |

**Plan required:** Show exact wizard screen flow, how CSV import integrates with existing import code (if any), and how logo is stored/displayed.

---

## Task 3: CSV Client Import

### Goal
User uploads a CSV file of existing clients. Maps columns to ClientHub fields. Previews before importing. Imports cleanly with duplicate detection.

### Success criteria
- [ ] Upload CSV → see column mapping UI → preview 5 rows → click import → clients appear in ClientHub
- [ ] Duplicate detection: if client with same name+email already exists, skip and report
- [ ] Import summary shown: "87 imported, 3 skipped (duplicates), 2 failed (missing name)"
- [ ] Import creates HLC sync events so imported clients sync to all devices

### Fields supported in import
Required: Name
Optional: Company, Email, Phone, Street Address, City, State, Zip, Notes, Category, Lead Status

### Duplicate detection
Match on: email address (exact) OR name + company (fuzzy, 90% similarity threshold)
On duplicate: skip and count — do not overwrite existing data

### UI location
Settings → Data → Import Clients
Also accessible from Onboarding Wizard Screen 4

**Files changing:**
| File | Change |
|------|--------|
| `src/components/CsvImport.tsx` | New — full import flow component |
| `src/components/SettingsView.tsx` | Add "Import Clients" button in Data section |
| `src-tauri/src/commands.rs` | `import_clients_csv(rows)` command |
| `src/lib/api.ts` | New API method |

**Plan required:** Show column mapping UI design, duplicate detection logic, and how `import_clients_csv` calls `record_upsert` for each client.

---

## Task 4: Auto-Backup

### Goal
Daily automatic backup of the ClientHub database to a location the user controls. Runs silently. User can restore from backup if something goes wrong.

### Success criteria
- [ ] Backup runs automatically once per day when app is open
- [ ] Backup saved to user-configured folder (default: Documents/ClientHub Backups/)
- [ ] Last 30 backups kept, older ones auto-deleted
- [ ] Settings page shows: last backup time, backup location, [Backup Now] button, [Restore] button
- [ ] Restore flow: pick a backup file → confirm → restore → app restarts

### Backup format
Simple SQLite file copy: `clienthub-backup-2026-05-18.db`
No compression needed — SQLite files are already compact.

### Backup timing
- Check on app startup: if no backup today, run backup
- Also runs when app has been open 24 hours continuously

### Restore flow
1. User clicks [Restore from Backup]
2. File picker opens — filter to `.db` files
3. Warning dialog: "This will replace all current data. Are you sure?"
4. On confirm: copy backup file over current database, restart app

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | `backup_database`, `restore_database`, `list_backups` commands |
| `src-tauri/src/main.rs` | Check and run backup on startup |
| `src/components/SettingsView.tsx` | Backup section in Settings |
| `src/lib/api.ts` | New API methods |

**Plan required:** Show how backup timing is tracked (settings table), how file picker works in Tauri, and the exact restore sequence.

---

## Task 5: Multi-User with Roles

### Goal
Multiple people can use ClientHub on the same account with different permission levels. Owner sees and does everything. Sales Rep can manage clients and deals but not financials. Viewer can only read data.

### Success criteria
- [ ] Owner can invite team members by email
- [ ] Invited user receives a code to enter on their own machine
- [ ] Each user's actions are attributed to them (interactions show "logged by Ben")
- [ ] Role permissions enforced — Sales Rep cannot access Analytics or Settings
- [ ] Removing a user immediately revokes their access on next app launch

### Roles

**Owner**
- Full access to everything
- Can invite/remove users
- Can change anyone's role
- Access to billing (future)

**Sales Rep**
- Clients: full access
- Interactions: full access
- Invoices: create and view, cannot delete
- Deals: full access
- Deal Flows: view only
- Analytics: no access
- Settings: no access
- Newsletter: no access

**Viewer**
- All lists: view only
- No create/edit/delete
- No Analytics
- No Settings
- No Newsletter

### Implementation approach
- Users stored in a `users` table (id, name, email, role, invite_code, created_at)
- Current user stored in app state, loaded on launch
- On first launch with no users: create Owner account (just name + email, no password yet)
- Invite flow: Owner generates a 6-digit invite code → sends to team member → they enter code in their app on first launch
- Permissions checked in frontend: hide/disable UI elements based on role
- Permissions also checked in backend commands: return error if role insufficient

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/src/db.rs` | Migration: users table |
| `src-tauri/src/commands.rs` | User management commands |
| `src/components/UserContext.tsx` | New — current user context provider |
| `src/components/SettingsView.tsx` | Team management section |
| `src/App.tsx` | Wrap app in UserContext |
| `src/lib/api.ts` | User API methods |
| `src/lib/permissions.ts` | New — permission check helpers |

**Plan required:** Show full users table schema, invite code flow step by step, and how permissions are enforced in both frontend and backend.

---

## Task 6: Inventory / Available Lots Board

### Goal
A dedicated board showing what stock/lots you currently have available, what's been sold, and what's reserved. Linked to the deal flow system.

### Success criteria
- [ ] Can add a lot with: name, description, quantity, total cost, asking price, category, photos (optional)
- [ ] Lot has status: Available / Reserved / Sold / Archived
- [ ] When a deal converts to invoice, can link to a lot (marks it Reserved)
- [ ] When deal flow completes, lot auto-marks as Sold
- [ ] Board view shows Available lots prominently, Sold in a collapsed section
- [ ] Margin % shown on each lot card: (asking - cost) / cost

### Lot card layout
```
┌─────────────────────────────────┐
│ [Category badge]    [Status]    │
│ Lot Name                        │
│ 200 units · Electronics         │
│                                 │
│ Cost: $2,400  Ask: $3,800       │
│ Margin: 58%  ████████░░         │
│                                 │
│ [Link to Deal] [Edit] [Archive] │
└─────────────────────────────────┘
```

### Database
New `inventory` table:
- id, name, description, category, quantity, total_cost, asking_price, status, linked_deal_id, photos_json, created_at, updated_at

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/src/db.rs` | Migration: inventory table |
| `src-tauri/src/commands.rs` | Inventory CRUD commands |
| `src/components/InventoryView.tsx` | New — full inventory board |
| `src/App.tsx` | Add Inventory tab to sidebar |
| `src/lib/api.ts` | Inventory API methods |

**Plan required:** Show full inventory table schema, how lot links to a deal, and the board layout for Available vs Sold sections.

---

## Task 7: Automated Follow-Up Sequences

### Goal
Set up automatic follow-up rules that trigger emails or reminders based on client behavior. "If a client hasn't ordered in 30 days, send a check-in email automatically."

### Success criteria
- [ ] Can create a follow-up rule with: trigger condition, delay, action (send email or create reminder)
- [ ] Rules run silently in background when app is open
- [ ] Activity log shows all automated actions taken
- [ ] Can pause/delete rules
- [ ] Never sends duplicate follow-ups (tracks last action per client per rule)

### Rule types

**Trigger conditions:**
- Client hasn't placed an order in X days
- Client hasn't been contacted in X days
- Invoice is X days overdue
- Deal has been in same stage for X days
- Client tier drops (e.g. A → B)

**Actions:**
- Send email (uses SMTP, uses template)
- Create a follow-up task (appears in dashboard follow-ups list)
- Both

### Example rules
- "If no order in 30 days → send 'Just checking in' email"
- "If invoice overdue 7 days → create follow-up reminder"
- "If deal stuck in Negotiation for 14 days → create reminder"

### Database
New `followup_rules` table:
- id, name, trigger_type, trigger_value (days), action_type, email_template_id, is_active, created_at

New `followup_log` table:
- id, rule_id, client_id, triggered_at, action_taken, status

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/src/db.rs` | Migration: followup_rules + followup_log tables |
| `src-tauri/src/commands.rs` | Rule CRUD + `process_followup_rules` command |
| `src-tauri/src/main.rs` | Run rules check on startup + periodic (every 6 hours) |
| `src/components/FollowUpRules.tsx` | New — rules management UI |
| `src/components/SettingsView.tsx` | Add Automation section linking to rules |
| `src/lib/api.ts` | New API methods |

**Plan required:** Show rule evaluation logic, how "last action" is tracked to prevent duplicates, and how email sending integrates with existing SMTP setup.

---

## Task 8: Client Portal (Read-Only Web View)

### Goal
A shareable web link you send to a specific client so they can view their own invoices and pay outstanding balances. No login required — link contains a secure token.

### Success criteria
- [ ] Generate a unique portal link per client from their profile
- [ ] Client opens link in browser — sees their invoices, invoice details, payment status
- [ ] Outstanding invoices show "Pay Now" button (placeholder for future Stripe — for now shows bank transfer instructions)
- [ ] Link expires after 30 days (regenerate from ClientHub)
- [ ] Portal is hosted on your server — not the Pi (future infrastructure task)

### Portal page shows
- Your business name and logo
- Client's name
- List of invoices: number, date, amount, status (paid/unpaid/overdue)
- Click invoice → see line items, notes, payment instructions
- "Questions? Contact us at [your email]"

### Token system
- Generate a random 32-character token per client
- Store in `client_portal_tokens` table: client_id, token, expires_at, created_at
- Portal URL format: `https://yourdomain.com/portal/[token]`
- Token lookup serves the correct client's data

### Note on hosting
This feature requires a publicly accessible server (not the Pi on Tailscale). Mark as "infrastructure dependent" — build the feature now, enable when hosting is set up. For now, tokens are generated and stored but the portal URL is a placeholder.

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/src/db.rs` | Migration: client_portal_tokens table |
| `src-tauri/src/commands.rs` | `generate_portal_link`, `revoke_portal_link` commands |
| `src/components/ClientDetail.tsx` | Add "Share Portal Link" button |
| `src/lib/api.ts` | New API methods |
| `clienthub-api/src/routes/portal.rs` | New — public portal routes (no auth) |
| `clienthub-api/www/portal.html` | New — client-facing portal page |

**Plan required:** Show token generation, expiry logic, and portal page design. Confirm portal routes are added to clienthub-api with no auth middleware.

---

## Task 9: WhatsApp / SMS Interaction Logging

### Goal
Log WhatsApp messages and SMS texts as interactions on client records. Manual logging (copy-paste message + log it) for now — no API integration yet.

### Success criteria
- [ ] "Log Interaction" form has new kinds: WhatsApp / SMS (alongside existing Call, Email, Meeting, Note)
- [ ] WhatsApp and SMS interactions show distinct icons in the interaction timeline
- [ ] Can paste message content into the notes field
- [ ] Filter interactions by kind (show only WhatsApp, only calls, etc.)

### This is a small UI-only change
No new backend needed. The existing interactions system already handles arbitrary `kind` values. Just add WhatsApp and SMS as options in the frontend.

**Files changing:**
| File | Change |
|------|--------|
| `src/components/LogInteractionModal.tsx` | Add WhatsApp + SMS to kind dropdown |
| `src/components/InteractionTimeline.tsx` | Add icons for WhatsApp + SMS kinds |
| `src/components/ClientDetail.tsx` | Add kind filter to interactions list |

**Plan required:** Show exact kind values being added, icons to use, and filter UI placement.

---

## Task 10: Lot / Manifest Analyzer

### Goal
Upload a manifest PDF or CSV. The app extracts item categories, quantities, and estimated values. Calculates a suggested bid price based on your historical margins. Most valuable differentiator feature.

### Success criteria
- [ ] Upload a manifest file (PDF or CSV)
- [ ] App parses the file and shows a category breakdown table
- [ ] Each category shows: estimated quantity, estimated retail value, your historical margin for that category
- [ ] Suggested bid price calculated: sum of (retail value × your avg margin) per category
- [ ] Can save the analysis and link it to a deal

### Implementation approach

**CSV manifests:**
Parse directly in Rust. Common columns: Item Description, Quantity, Retail Price. Map to categories using keyword matching against your existing category list.

**PDF manifests:**
Extract text using `pdf-extract` crate. Then same keyword matching.

**Category matching:**
Build a keyword → category map. Example:
- "shoes", "sneakers", "boots" → Shoes
- "tv", "monitor", "laptop" → Electronics
- "shirt", "pants", "jacket" → Clothing

Use your existing categories from the settings table as the category list.

**Margin calculation:**
Query your historical deal flows: for each category, calculate avg (revenue - cost) / cost. Use this as the expected margin for that category.

**Suggested bid:**
```
For each category in manifest:
  suggested_value = quantity × avg_retail × your_historical_margin
Total suggested bid = sum of all category values × 0.85 (15% safety buffer)
```

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add pdf-extract crate |
| `src-tauri/src/commands.rs` | `analyze_manifest(file_path)` command |
| `src-tauri/src/manifest.rs` | New — manifest parsing + analysis logic |
| `src/components/ManifestAnalyzer.tsx` | New — full analyzer UI |
| `src/App.tsx` | Add Manifest tab to sidebar (or inside Inventory) |
| `src/lib/api.ts` | New API method |

**Plan required:** Show keyword→category mapping approach, how historical margins are queried, and the suggested bid formula. Confirm PDF parsing works on Windows with the chosen crate.

---

## Task 11: Profit Forecasting Dashboard

### Goal
Based on open deals in the pipeline, forecast expected profit for the current month. Shows projected vs actual with a visual breakdown.

### Success criteria
- [ ] Dashboard shows a "Forecast" card alongside existing stats
- [ ] Forecast = sum of (deal asking price × historical win rate for that stage) for all open deals
- [ ] Chart shows: actual profit to date (bar) + projected additional profit (lighter bar) = total forecast
- [ ] Historical win rate calculated from closed/lost deals over last 90 days
- [ ] Forecast updates in real time as deals are added/changed

### Forecast formula
```
For each open deal:
  stage_win_rate = (deals won from this stage) / (deals won + lost from this stage) [last 90 days]
  weighted_value = deal.asking_price × stage_win_rate × deal.margin_pct

Monthly forecast = actual_profit_mtd + sum(weighted_value for all open deals)
```

**Files changing:**
| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | `get_profit_forecast` command |
| `src/components/DashboardView.tsx` | Add Forecast card + chart |
| `src/lib/api.ts` | New API method |

**Plan required:** Show exact SQL queries for win rate calculation and how the forecast card integrates into the existing dashboard layout without breaking current stats.

---

## Execution Order

Complete in this sequence. Do not start the next task until the current one is verified and pushed.

```
1. Auto-Updater          — enables safe delivery of all future updates
2. Onboarding Wizard     — needed before showing to any new user
3. CSV Client Import     — needed inside onboarding wizard
4. Auto-Backup           — data safety before sharing with others
5. Multi-User Roles      — enables team use
6. Inventory Board       — core wholesale workflow feature
7. Automated Follow-Ups  — high value, builds on existing email
8. Client Portal         — requires server infrastructure
9. WhatsApp/SMS Logging  — small, high impact for wholesale niche
10. Manifest Analyzer    — flagship differentiator feature
11. Profit Forecasting   — rounds out the analytics suite
```

---

## Start Instructions

Read this entire document and the CLAUDE.md guidelines before doing anything.

Generate a plan for **Task 1 (Auto-Updater) only.**

The plan must include:
- Assumptions about where update artifacts will be hosted (confirm GitHub Releases)
- How signing keys are generated, where they are stored, what to never commit to git
- Exact changes to `tauri.conf.json`
- The update notification UI design
- Step-by-step verification that the updater works end to end

State your assumptions explicitly before planning. If anything is unclear, ask before proceeding.

Wait for approval before writing any code.
