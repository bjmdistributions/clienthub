# Phase 6 — SaaS Pivot Plan

The commercial product is a hosted SaaS replacing the current Tauri/Syncthing model. This doc is the canonical reference for that pivot. It is **deferred** behind Features 1-7 + 9-15 (current arch). When those land, this is what happens next.

Status: planning only. No implementation in this phase.

---

## 1. Target architecture

```
                 ┌──────────────────────────────┐
                 │   Landing page (marketing)    │
                 │   yourdomain.com              │
                 │   — Signup / Login            │
                 │   — Pricing tiers             │
                 │   — Marketing copy            │
                 └──────────────┬───────────────┘
                                │
                                ▼
                 ┌──────────────────────────────┐
                 │   ClientHub web app (SPA)     │
                 │   app.yourdomain.com          │
                 │   — Same React UI as desktop  │
                 │     (rebuilt for browser)     │
                 └──────────────┬───────────────┘
                                │  HTTPS REST
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Physical server in Lockport, Illinois                       │
│           Static IP, Nginx, TLS via Let's Encrypt                     │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │  Nginx (TLS terminator, static asset serving, reverse proxy)    │ │
│ └──────────────────────────────┬──────────────────────────────────┘ │
│                                ▼                                      │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │   clienthub-server (Rust axum on port 8080, behind Nginx)       │ │
│ │   — Account management (signup/login/sessions)                   │ │
│ │   — Organization management (orgs, members, invites)             │ │
│ │   — Per-request scoping to the caller's org's SQLite             │ │
│ │   — All existing routes from clienthub-api, namespaced by org    │ │
│ │   — Stripe webhook handler                                       │ │
│ │   — Sheets OAuth callback                                        │ │
│ │   — Email sending (SMTP via per-org configured profiles)        │ │
│ │   — Background scheduler (newsletters, follow-ups, recurring)    │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  Per-org SQLite databases on local disk:                             │
│    /var/lib/clienthub/orgs/{org_id}/clienthub.db                     │
│    /var/lib/clienthub/orgs/{org_id}/photos/                          │
│    /var/lib/clienthub/orgs/{org_id}/invoices/                        │
│    /var/lib/clienthub/orgs/{org_id}/backups/                         │
│                                                                       │
│  Global accounts DB (multi-tenant):                                  │
│    /var/lib/clienthub/accounts.db                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Decisions baked in (from Phase 5 Q&A answers)
- **One SQLite DB per organization** (Q3). Total isolation, easy per-customer backups, no cross-tenant query bugs.
- **Single physical server** at Lockport, IL static IP — not a cloud VPS.
- **Stripe webhook activates here** (Q4) — webhook URL: `https://<domain>/api/stripe/webhook`.
- **Syncthing/HLC P2P sync is deprecated** for SaaS customers. The HLC engine in `src-tauri/src/sync.rs` and `clienthub-api/src/sync.rs` is dead code on the server. Each org's DB is the single source of truth.
- **Tauri desktop app is retired** for SaaS customers. Same React UI re-targeted as a browser SPA against the server's REST API.

---

## 2. Account & organization data model

New global DB at `/var/lib/clienthub/accounts.db` (schema in migrations 1-N of a new `clienthub-server` repo):

```sql
-- Accounts: individual people who sign up.
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,                      -- UUID
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,              -- bcrypt cost 12
    name TEXT NOT NULL,
    email_verified_at TEXT,
    email_verification_token TEXT,
    password_reset_token TEXT,
    password_reset_expires_at TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    -- Stripe billing
    stripe_customer_id TEXT,
    plan TEXT NOT NULL DEFAULT 'free'
        CHECK(plan IN ('free','solo','business')),
    plan_status TEXT NOT NULL DEFAULT 'active'
        CHECK(plan_status IN ('active','past_due','canceled','trialing')),
    trial_ends_at TEXT,
    -- Soft delete
    deleted_at TEXT
);
CREATE UNIQUE INDEX idx_accounts_email ON accounts(LOWER(email));

-- Sessions: server-side, HttpOnly cookie tokens.
CREATE TABLE sessions (
    token TEXT PRIMARY KEY,                   -- 256-bit random
    account_id TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Organizations: a billing/data-isolation unit. Solo plan = exactly 1 org with 1 member (the owner).
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,                -- URL-safe slug, e.g. "bjm-distributions"
    owner_account_id TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'solo'
        CHECK(plan IN ('solo','business')),
    seat_limit INTEGER NOT NULL DEFAULT 1,    -- solo=1, business=user-defined
    db_path TEXT NOT NULL,                    -- /var/lib/clienthub/orgs/{id}/clienthub.db
    storage_root TEXT NOT NULL,               -- /var/lib/clienthub/orgs/{id}/
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (owner_account_id) REFERENCES accounts(id)
);

-- Org members: who has access to the org's data.
CREATE TABLE organization_members (
    organization_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK(role IN ('owner','sales_rep','viewer')) DEFAULT 'viewer',
    joined_at TEXT NOT NULL,
    last_active_at TEXT,
    PRIMARY KEY (organization_id, account_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_org_members_account ON organization_members(account_id);

-- Invites: outstanding invitations to join an org.
CREATE TABLE organization_invites (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','sales_rep','viewer')),
    code TEXT UNIQUE NOT NULL,                -- 8-char alphanumeric
    invited_by_account_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by_account_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX idx_invites_code ON organization_invites(code) WHERE accepted_at IS NULL;
CREATE INDEX idx_invites_email ON organization_invites(LOWER(email)) WHERE accepted_at IS NULL;

-- Audit log (org-level): track significant actions for compliance.
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    account_id TEXT,
    action TEXT NOT NULL,                     -- 'member_invited','role_changed','member_removed','login',...
    target_type TEXT,
    target_id TEXT,
    details_json TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_org_date ON audit_log(organization_id, created_at);
```

### Plan rules

- **Solo plan**: one account, one organization, owner is the only member. `seat_limit=1`. No invite UI.
- **Business plan**: one account creates an org. Owner invites members (subject to `seat_limit`). Members get their own login. Members see only data in orgs they belong to.
- A single account can belong to multiple organizations (e.g., a sales rep working for two businesses). The web UI shows an org-picker after login if the account has >1 active org.

### Per-org SQLite

Each org's `/var/lib/clienthub/orgs/{org_id}/clienthub.db` uses the existing migrations 1-28 of the desktop app, **minus the sync internals** (no `sync_meta`, `row_clocks`, `tombstones`, `schema_migrations` still keeps version tracking). Plus new migrations specific to server-only features:

- **org_members_mirror** — a read-replica of `organization_members` cached locally per-org for fast permission checks during request handling. Updated whenever the global accounts.db changes (handled by the server, not via sync).
- **smtp_profiles** — see §4.
- **payments**, **custom_fields**, **recurring_invoices**, **tier_history** — these come from Phase 3 Features.

---

## 3. Permissions model

Three roles, applied at the HTTP route layer (middleware checks before forwarding to handler):

| Capability | Owner | Sales Rep | Viewer |
|---|---|---|---|
| Read clients / invoices / deals / suppliers / inventory | ✓ | ✓ | ✓ |
| Create / edit clients / interactions / deals / deal_flows | ✓ | ✓ | — |
| Create / edit invoices | ✓ | ✓ | — |
| Send invoices, send emails, send newsletters | ✓ | ✓ | — |
| Edit company info, payment methods, profit split | ✓ | — | — |
| Manage SMTP profiles (add/edit/delete) | ✓ | own profiles only | — |
| Invite / remove members, change roles | ✓ | — | — |
| Connect Google Sheets / Contacts | ✓ | own only | — |
| Manage Stripe keys | ✓ | — | — |
| View audit log | ✓ | own actions only | own actions only |
| Delete the organization | ✓ | — | — |

Existing [src/lib/permissions.ts](src/lib/permissions.ts) (`canView(role, tab)`) covers view-level gating. New helper `canDo(role, action)` extends it to action gating. Server-side enforcement is authoritative; client-side gating is UX-only.

---

## 4. Multiple SMTP profiles per account

Today: one `email_settings` JSON in `settings`, one keychain entry for the password.

Target: each org has 0..N **named SMTP profiles**. When sending, the sender picks which profile to use.

### New migration (in per-org DB)

```sql
CREATE TABLE smtp_profiles (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,                      -- 'Invoicing', 'Sales', 'Marketing'
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL DEFAULT 587,
    imap_host TEXT,                           -- nullable: send-only profiles allowed
    imap_port INTEGER,
    auth_method TEXT NOT NULL CHECK(auth_method IN ('password','oauth2')) DEFAULT 'password',
    smtp_username TEXT NOT NULL,
    from_name TEXT NOT NULL,                  -- 'BJM Distributions — Invoicing'
    from_email TEXT NOT NULL,                 -- 'invoice@bjmdistributions.com'
    is_default INTEGER NOT NULL DEFAULT 0,    -- one default per org
    is_active INTEGER NOT NULL DEFAULT 1,
    owner_account_id TEXT,                    -- nullable: org-shared profile if NULL; private to that member if set
    last_tested_at TEXT,
    last_test_result TEXT,                    -- 'ok' | 'failed: <error>'
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_smtp_default ON smtp_profiles(is_default) WHERE is_default=1;

-- Credentials live in a server-side secrets store (encrypted at rest, see §6),
-- keyed by smtp_profile.id. NOT in this table.
```

### UI

In the redesigned Settings page (§5), a "Mailboxes" section:

```
┌─ Mailboxes ──────────────────────────────────────────────────┐
│                                                                │
│  ┌─────────────────────────────────────┐  [+ Add Mailbox]      │
│  │ 📧 Invoicing                  ⭐    │                       │
│  │    invoice@bjmdistributions.com     │                       │
│  │    smtp.gmail.com:587  ✓ verified   │  [Test] [Edit] [⋯]    │
│  └─────────────────────────────────────┘                       │
│  ┌─────────────────────────────────────┐                       │
│  │ 📧 Sales                            │                       │
│  │    sales@bjmdistributions.com       │                       │
│  │    smtp.gmail.com:587  ✓ verified   │  [Test] [Edit] [⋯]    │
│  └─────────────────────────────────────┘                       │
│  ┌─────────────────────────────────────┐                       │
│  │ 📧 Marketing                        │                       │
│  │    hello@bjmdistributions.com       │                       │
│  │    smtp.gmail.com:587  ⚠ untested   │  [Test] [Edit] [⋯]    │
│  └─────────────────────────────────────┘                       │
└────────────────────────────────────────────────────────────────┘
```

⭐ = default mailbox. Used when the user doesn't explicitly pick one.

### Sender picker

Every place that sends email (newsletter compose, invoice send, follow-up rule, manual reply) gains a "From:" dropdown listing the org's active mailboxes. Defaults to the ⭐ profile.

Newsletter compose: dropdown above subject line. Persisted on save so re-running a scheduled newsletter uses the same mailbox.

Follow-up rule editor: dropdown next to the email body. Each rule remembers which mailbox it sends from.

### Reply matching (IMAP)

The IMAP scanner ([email.rs:320](src-tauri/src/email.rs:320)) needs to be updated to scan all profiles that have IMAP configured, not just the single one. Each profile gets its own `last_seen_uid` stored in `smtp_profiles.metadata_json`. Incoming emails matched to clients still produce one `interactions` row (no "which inbox it arrived in" field is needed for v1, but worth flagging for v2).

---

## 5. Settings page redesign (commercial-grade)

Current Settings is a long single-page tab list. The redesign is a left-rail navigation with sections:

```
┌──────────────────┬──────────────────────────────────────────────┐
│  Account         │                                               │
│  ▸ Profile       │   <selected section content>                  │
│  ▸ Password      │                                               │
│  ▸ Two-factor    │                                               │
│  ▸ Sessions      │                                               │
│                  │                                               │
│  Organization    │                                               │
│  ▸ Details       │                                               │
│  ▸ Members       │                                               │
│  ▸ Roles         │                                               │
│  ▸ Audit log     │                                               │
│  ▸ Billing       │                                               │
│  ▸ Danger zone   │                                               │
│                  │                                               │
│  Mailboxes       │                                               │
│  ▸ All           │                                               │
│  ▸ Invoicing     │                                               │
│  ▸ Sales         │                                               │
│  ▸ Marketing     │                                               │
│                  │                                               │
│  Integrations    │                                               │
│  ▸ Google Sheets │                                               │
│  ▸ Google        │                                               │
│    Contacts      │                                               │
│  ▸ Stripe        │                                               │
│  ▸ Ollama        │                                               │
│                  │                                               │
│  Sales tools     │                                               │
│  ▸ Categories    │                                               │
│  ▸ Lead status   │                                               │
│  ▸ Custom fields │                                               │
│  ▸ Payment       │                                               │
│    methods       │                                               │
│  ▸ Invoice       │                                               │
│    numbering     │                                               │
│  ▸ Profit split  │                                               │
│  ▸ Follow-up     │                                               │
│    rules         │                                               │
│  ▸ Signup rules  │                                               │
│                  │                                               │
│  Data            │                                               │
│  ▸ Import        │                                               │
│  ▸ Export        │                                               │
│  ▸ Backups       │                                               │
│                  │                                               │
│  Privacy         │                                               │
│  ▸ Encryption    │                                               │
└──────────────────┴──────────────────────────────────────────────┘
```

### Layout primitives

- Left rail: 240 px, sticky, scrollable. Section headers in 11 pt uppercase tracking-wide. Sub-items in 13 pt, indented 16 px. Active item has a 3 px left-edge accent in the brand indigo and a subtle background tint.
- Main panel: max-width 720 px, 32 px padding. Each section page has:
  - Title (24 pt, semibold)
  - Subtitle (13 pt, muted) describing what this section controls
  - Content area: form rows, tables, action buttons
  - Save bar: sticky at bottom of viewport, shows "You have unsaved changes" + Save / Cancel buttons when the form is dirty.

### Specific section designs

**Account → Profile**: name, email (verify-on-change flow), avatar upload (deferred), preferred timezone.

**Account → Password**: current password, new password, confirm. Strong-password meter.

**Account → Two-factor** (deferred but reserve the slot): TOTP setup, recovery codes.

**Account → Sessions**: list of active sessions (browser, IP, last activity, "this device" badge). Revoke buttons.

**Organization → Details**: org name, slug, logo (used in invoices, fed into `company_info` setting).

**Organization → Members**: table of org_members + outstanding invites:
```
Name              Email                Role         Last active      Actions
Jack (you)        jack@…               Owner        Now              —
Sarah Smith       sarah@…              Sales Rep    2 hours ago      [Change role ▾] [Remove]
ben@…             (invited)            Viewer       Pending invite   [Resend] [Revoke]
[+ Invite member]
```

**Organization → Billing**: current plan, next invoice date, payment method (managed via Stripe Customer Portal hosted iframe), seat count vs limit, upgrade/downgrade buttons.

**Organization → Danger zone**: "Delete organization" — type the org name to confirm. Schedules deletion 7 days out; cancelable. Owner-only.

**Mailboxes → All**: as in §4. Plus a default-mailbox picker. Sub-pages per mailbox for detail edit.

**Integrations → Google Sheets**: §7.

**Integrations → Google Contacts**: same OAuth flow Feature 5 describes, separate scope from Sheets.

**Integrations → Stripe**: §8.

**Integrations → Ollama**: model picker (already exists), host URL (default `http://localhost:11434`). For SaaS, this may run server-side or per-user-via-browser — see §9.

**Sales tools → ...**: each of these is an existing config screen, reshaped to fit the new layout.

**Data → Import**: tabs "From CSV", "From Google Contacts" (Feature 5).

**Data → Export**: see Feature 13. Trigger exports of any list, including org-wide analytics.

**Data → Backups**: see Feature 9. On SaaS, "Backup Now" still works but writes to the org's `/var/lib/clienthub/orgs/{id}/backups/` directory. "Restore" requires owner role.

**Privacy → Encryption**: covers `sync_set_passphrase` (legacy desktop). For SaaS this section is repurposed to "Data at rest" info — "Your data is stored encrypted at rest using AES-256 by Linux dm-crypt on the server."

---

## 6. Server-side secrets

Today: secrets in OS keychain via [keyring crate](https://crates.io/crates/keyring).

Server: cannot use a desktop keychain. Options:

**Chosen approach** — encrypted secrets table:
- New table in accounts.db: `secrets(id PK, account_id, scope, key_name, ciphertext, nonce, created_at)`.
- Server has a master key in `/etc/clienthub/master.key` (file mode 600, owned by the clienthub user).
- Each secret encrypted with ChaCha20-Poly1305 (same primitive as the desktop's [sync_crypto.rs](src-tauri/src/sync_crypto.rs)) using the master key + a per-secret random nonce.
- Master key generated once at install, rotated by re-encrypting all secrets.

Secrets stored this way: SMTP passwords, OAuth refresh tokens (Google Sheets / Contacts), Stripe keys (publishable can be in plaintext; secret + webhook secret encrypted).

Backup: master key is backed up to a YubiKey (or paper copy) by the operator. Never copied off the server in plaintext.

---

## 7. Google Sheets API v4 + OAuth (replaces URL hack)

Per Q11 answer: drop the URL-based approach for new users. Pull via Sheets API v4 with the user's OAuth.

### Flow

1. User clicks "Connect Google Sheets" in Settings → Integrations → Google Sheets.
2. OAuth consent screen requesting scopes:
   - `https://www.googleapis.com/auth/spreadsheets.readonly` (read)
   - `https://www.googleapis.com/auth/spreadsheets` (write, requested only if "Push changes back" toggle is enabled)
3. Server stores the refresh token in encrypted secrets (§6).
4. User pastes a sheet URL or picks from "Your sheets" list (`drive.metadata.readonly` scope, optional).
5. Sheet headers fetched via `GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/Sheet1!1:1`.
6. Visual column-mapper renders (Feature 2's design).
7. On sync, server pulls all rows via `Sheet1!A2:Z` and runs the same dedupe + upsert logic.

### Where the code lives

- A new module `clienthub-server/src/integrations/google_sheets.rs` (mirroring [csv_import.rs](src-tauri/src/csv_import.rs) but reading from JSON rows instead of CSV records).
- The existing desktop sync_from_sheet code path stays during the transition for current Tauri users — deprecated but not deleted.

### Existing customers migration

Customers currently using the URL hack are migrated when they sign up for SaaS:
1. Server's first-time migration imports their CSV/URL config.
2. Email prompt: "Reconnect via OAuth for better reliability."
3. After OAuth, the URL config is cleared.

---

## 8. Stripe activation

Per Q&A Stripe-related answers (Q9, Q10, Q4):
- Single business Stripe account, no Stripe Connect.
- Stripe-hosted Checkout Session (not embedded Elements).
- Webhook auto-marks invoice paid on receipt of `checkout.session.completed`.

### Request-payment flow (full SaaS version)

1. Owner clicks "Request Payment" on an invoice.
2. Server calls `POST /v1/checkout/sessions` with:
   - `mode=payment`
   - `success_url=https://<domain>/invoice/<id>?paid=1`
   - `cancel_url=https://<domain>/invoice/<id>?cancelled=1`
   - `line_items=[{ price_data: { currency:'usd', product_data:{name:'Invoice <number>'}, unit_amount:total_in_cents}, quantity:1 }]`
   - `metadata={invoice_id, org_id}`
3. Stripe returns a `url` and `id`. Save both in the `payments` row (Feature 1) with `stripe_payment_intent_id=<id>` and status=pending.
4. Owner sends the URL to the client (via the existing portal page, which now displays a big green "Pay Now" button instead of "Mark as paid").
5. Client clicks → pays on Stripe's page.
6. Stripe sends `checkout.session.completed` to `https://<domain>/api/stripe/webhook`. Server verifies signature (HMAC-SHA256 of body with the org's `stripe_webhook_secret`), looks up the payment by `metadata.invoice_id`, sets `status='paid'`, sets `invoices.status='paid'`, sets `invoices.paid_at=now`, sets `payments.stripe_charge_id=...`.
7. Sync this state change so all org members see it.

### Webhook endpoint

`POST /api/stripe/webhook` — public (no auth header), Nginx forwards directly. Validates Stripe signature, dispatches to the org by `metadata.org_id`. Handlers:
- `checkout.session.completed` → mark payment + invoice paid.
- `checkout.session.expired` → mark payment failed.
- `charge.refunded` → mark payment refunded, invoice back to sent.
- `invoice.payment_failed` (subscriptions only — out of scope for v1).

### Refund flow

Owner clicks "Refund" on a paid invoice. Server calls `POST /v1/refunds {charge: <id>}`. Webhook `charge.refunded` confirms. Refund stored in `payments` row.

### Connect Stripe keys

Settings → Integrations → Stripe:
- Publishable key (plaintext, in settings table)
- Secret key (encrypted secret, §6)
- Webhook signing secret (encrypted secret)
- Test mode toggle (uses `sk_test_…` vs `sk_live_…`)

---

## 9. Ollama on the server

Two valid approaches:

**Option A — Per-customer browser Ollama**: each customer runs Ollama locally on their machine. The web SPA calls `http://localhost:11434` directly from the browser. Same as today. Requires CORS handling — Ollama already supports `OLLAMA_ORIGINS`.

**Option B — Server-hosted Ollama**: one Ollama instance on the Lockport server, shared across all customers. Cheaper for the user (no local model download), more expensive for the operator (GPU/CPU spend grows with usage), introduces multi-tenant rate limiting.

Recommend **Option A** for v1 (preserves the "zero recurring AI cost" promise from DEPLOY.md). Option B is a v2 upgrade path that doesn't require schema changes.

---

## 10. Data migration: current Tauri install → SaaS

When current users (yourself, family/friends with personal installs) move to SaaS:

1. Sign up for a SaaS account, create an org.
2. Tauri desktop adds a "Migrate to ClientHub Cloud" button in Settings → Account.
3. Click → wizard:
   - Step 1: enter SaaS credentials.
   - Step 2: confirm org name.
   - Step 3: upload local DB file via a multipart POST to `/api/org/{org_id}/migrate`. Server validates the schema, runs any "pre-flight" migrations needed (e.g., strip sync internals tables), copies the rows into the new org's DB.
   - Step 4: confirm — local data preserved; SaaS data is the new authority.

The Tauri app post-migration becomes a thin client (or is retired). Suggestion: retire it.

---

## 11. Deployment / Ops

### Server build (Lockport, IL)

- Linux (Debian 12 or Ubuntu 24.04 LTS).
- Static IP (already arranged).
- ZFS or ext4 with daily snapshots to a separate disk.
- Nginx with Let's Encrypt cert auto-renewal.
- systemd unit for `clienthub-server` (similar to the existing `clienthub-api.service` but with the path/env-var bugs fixed).
- Automated nightly off-site backup (encrypted) to a second location.

### Domain + DNS

- Marketing site at `clienthub.com` (or your chosen TLD).
- App at `app.clienthub.com`.
- API at `app.clienthub.com/api`.
- Portal at `app.clienthub.com/portal/<token>`.
- All under a single TLS cert via Let's Encrypt with SAN.

### Monitoring

- Server log shipped to a separate log host (basic syslog or rsyslog).
- `/api/health` endpoint pinged every 60 s by an external uptime monitor (UptimeRobot free tier).
- Per-org SQLite size alerts at 500 MB / 2 GB / 5 GB thresholds.

### Cost model (revised from DEPLOY.md)

| Item | Monthly |
|---|---|
| Server power + internet | ~$50-100 |
| Domain registration | ~$15/year ≈ $1.25/mo |
| Stripe fees | 2.9% + 30¢ per transaction |
| Google Workspace (for ops mailbox) | $6 |
| TLS cert | $0 (Let's Encrypt) |
| Off-site backup (encrypted) | $5-10 (Backblaze B2 or similar) |
| **Total fixed overhead** | **~$70/mo** |
| Per-customer marginal cost | ~$0 (disk + bandwidth negligible at small scale) |

Break-even at ~3 paying customers @ $25/mo.

---

## 12. Migration order (server build → features → cutover)

Sequence, assuming Features 1-7 + 9-15 ship on current arch first:

1. **Server stand-up** (~40 agent-hours)
   - Hardware online, Linux installed, Nginx + TLS configured.
   - `clienthub-server` repo created — fork of `clienthub-api` with auth/orgs added.
   - Accounts.db schema + signup/login routes + sessions.
2. **Org system + per-org DB scoping** (~30 agent-hours)
   - Org creation, invites, member management.
   - Middleware that resolves request → account → org → DB connection.
   - Permission helper.
3. **Migrate existing routes to org-scoped handlers** (~20 agent-hours)
   - All clienthub-api routes rewritten to accept org_id from middleware.
   - Sync code paths stripped or no-op'd.
4. **Web SPA bring-up** (~30 agent-hours)
   - Vite build of the existing React app targeted to the browser (no Tauri APIs — replace `invoke()` with `fetch()`).
   - Login screen, account/org pickers.
5. **SMTP profiles** (~15 agent-hours)
   - Per §4.
6. **Settings redesign** (~25 agent-hours)
   - Per §5.
7. **Google Sheets v4 OAuth** (~12 agent-hours)
   - Per §7. Replaces the current sheets sync code.
8. **Stripe webhook activation** (~6 agent-hours)
   - Wire up the Stripe stub from Feature 1 to real Stripe Checkout sessions + webhook handler.
9. **Migration tooling** (~10 agent-hours)
   - The "upload local DB" wizard. Server-side importer.
10. **Cutover** — friends/family move to SaaS. Desktop app retired.

Total: ~190 agent-hours for the pivot, plus the prior ~95 hours for the current-arch features. Realistic 6-12 month timeline depending on parallelization.

---

## 13. What gets carried over vs. rebuilt

| Component | SaaS treatment |
|---|---|
| `src-tauri/src/db.rs` | Migrations 1-28 → reused as the per-org DB schema. Add server-only migrations on top. |
| `src-tauri/src/sync.rs` | **Deleted** for SaaS. Server has no peers. |
| `src-tauri/src/sync_crypto.rs` | **Deleted** for SaaS. Replaced by server master-key scheme (§6). |
| `src-tauri/src/email.rs` | Refactored to support multiple profiles (§4). Same SMTP send / IMAP scan loop, parameterized by profile. |
| `src-tauri/src/ai.rs` | Reused (per Q9 answer, Option A: browser Ollama). |
| `src-tauri/src/invoice.rs` | Reused — runs server-side, generates PDF on demand and streams to client. |
| `src-tauri/src/geocode.rs` | Reused — runs server-side, embedded CSV. |
| `src-tauri/src/csv_import.rs` | Reused. |
| `src-tauri/src/oauth_flow.rs` | **Rewritten** for server (no localhost callback; uses public redirect URI). |
| `src-tauri/src/signup_rules.rs` | Reused. |
| `src-tauri/src/manifest.rs` | Reused. Codify the `parse_manifest` trait per Q31. |
| `src-tauri/src/commands.rs` | Each handler becomes an axum route handler. Same logic, different I/O wrapper. |
| `src/` React | Reused. `invoke()` → `fetch()`. Routing already exists. |
| `clienthub-api/` | Forked into `clienthub-server/`. Auth/PIN replaced by accounts/sessions. |

---

## 14. Open questions for the SaaS pivot

These are NOT in Phase 5 — they're new questions surfaced by this plan:

- **TLD / domain**: what's the marketing domain? Affects portal URL format and Stripe success URLs.
- **Pricing**: solo plan $X/mo, business plan $Y/mo per seat, free trial duration? Affects the billing UI copy and Stripe products config.
- **Email verification**: required before login (block until verified) or recommended (badge + nag banner)?
- **Password requirements**: minimum length, complexity rules?
- **GDPR / data residency**: customers outside the US — any constraints? Lockport, IL → US-only might rule out EU customers under strict GDPR readings.
- **Terms of Service / Privacy Policy**: who drafts these? Lawyer-reviewed before launch.
- **Marketing site**: separate codebase or Astro/Next page in the same repo?
- **Support channel**: email-only at launch? Intercom / Crisp later?
- **Webhook security for Stripe** during dev — use Stripe CLI's `stripe listen` for local testing.
