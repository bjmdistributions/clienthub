# ClientHub — Client/Server Migration & Employee Portal Plan

**Status:** Architecture + migration plan (approved direction)
**Author:** planning pass, 2026-06-05
**Owner:** Jack

---

## 1. The decision (what we're building)

Pivot ClientHub from **local-first + Syncthing** to a **hosted client/server** model,
self-hosted on Jack's PC (static IP), so the company runs on a real multi-user
system with admin-controlled employee access — the kind of operational backbone
that makes the business a credible, buyable asset.

**Confirmed shape:**

- **One server** (grown from the existing Pi `clienthub-api` axum service) is the
  **single source of truth**. **Syncthing and the HLC event log are retired.**
- **Desktop app stays the primary client for everyone.** It stops using a local
  SQLite mirror and instead reads/writes the server over HTTPS. Every desktop user
  logs into their own account → **permissions apply on desktop too.**
- **Web portal** = lighter employee access. Admin issues an **invite link**; the
  employee self-registers; they see only what their **role** permits.
- **Admin manages roles/permissions from both** desktop and web.
- **WhatsApp** remains a **per-machine, per-login desktop-native integration**
  (each worker's own machine + own WhatsApp). Never shared. No change.

### Honest tradeoffs (decide with eyes open)
1. **Offline goes away.** Desktop needs the server reachable. Right call for RBAC;
   real change from today. (A small local read cache can be added later if needed.)
2. **Jack's PC becomes critical infrastructure.** If it's off, nobody works →
   uptime + backups are now mandatory. (A $5 VPS later removes this; setup identical.)
3. **Security is now real.** Internet-exposed server ⇒ hashed passwords, TLS,
   authz on every endpoint, rate limiting, and the standing rule: **never log,
   message, or panic with credentials.**

---

## 2. Why this is a port, not a rewrite

| Asset today | Reused how |
| --- | --- |
| React UI in `src/` | Same screens serve the desktop **and** the web portal. |
| Rust business logic in `src-tauri/src/` (DB, PDF via `printpdf`, manifest parsing, email) | Extracted into a shared core crate that **both** desktop and server use — not rewritten. |
| `src/lib/api.ts` `invoke()` wrappers | Swapped to `fetch()` against the server; call sites barely change. |
| Pi `clienthub-api` (axum + SQLite + serves `www/`) | **Becomes the server.** Already proves the stack. |
| `manifest-platform/infra/Caddyfile` | Reused for TLS + routing on the host PC. |

**Server database stays SQLite** (the Pi already runs rusqlite). A small team does
not need Postgres; this keeps the migration small. Revisit only if concurrency
demands it.

---

## 3. Target architecture

```
                       ┌──────────────────────────────────────┐
                       │  Jack's PC (static IP + domain + TLS) │
                       │                                       │
  Desktop app  ──────▶ │  Caddy ──▶ ClientHub Server (axum)    │
  (Tauri, primary)     │             ├─ Auth (sessions/JWT)    │
                       │             ├─ REST API (RBAC-gated)   │
  Employee browser ──▶ │             ├─ clienthub-core (shared │
  (web portal)         │             │   Rust: DB/PDF/manifest) │
                       │             ├─ SQLite (source of truth)│
                       │             ├─ /media (files)          │
                       │             ├─ Email send + scheduler  │
                       │             └─ serves web portal (SPA) │
                       └──────────────────────────────────────┘

  Native-only, stays in the desktop Tauri layer (per machine/user):
   • WhatsApp embedded webview + drag-to-attach
   • The user's own email credentials (OS keyring)
   • OS file dialogs, "open folder", printing, auto-update
```

### Recommended repo structure (Cargo workspace)
```
clienthub-core/     // NEW shared crate: models, SQLite access, PDF, manifest, email logic
clienthub-server/   // axum server (was clienthub-api) — depends on core
src-tauri/          // desktop shell — depends on core for native bits, calls server for data
src/                // React UI — shared by desktop + web portal build
```
Extracting `clienthub-core` is the key move that prevents logic duplication between
the desktop and the server.

---

## 4. Auth & identity

- **Organization** — single row for now, but every table carries `org_id` from day
  one (cheap insurance for any future multi-company/SaaS optionality and clean
  data isolation for due diligence).
- **Users (employees)** — `id, org_id, email, password_hash (argon2), display_name,
  role_id, status (active/suspended), created_at`. Admin (Jack) is a seeded user.
- **Invite tokens** — `token, org_id, role_id, email?, expires_at, used_at`. Admin
  generates a link `https://<domain>/signup?invite=<token>`; employee sets a
  password; account is created with the pre-assigned role.
- **Sessions** — JWT (access + refresh) or server-side session cookies. JWT is
  simplest for both desktop (store token in keyring) and web (httpOnly cookie).
- **Password reset** — admin-triggered reset link (email send already exists).

**Security musts:** argon2 password hashing; TLS only (Caddy auto-cert); rate-limit
auth endpoints; lockout on repeated failures; never put secrets in logs/errors.

---

## 5. Roles & permissions (RBAC)

A **role** is a named set of **permissions**. A permission is `module : action`.

```
Modules:  clients · inventory · deal_flow · quotes · email · manifests ·
          analytics · settings · admin
Actions:  view · edit · delete · export
```

- Seed roles: **Admin** (all), **Manager** (all except admin/settings),
  **Sales** (clients/inventory/quotes/email view+edit, no delete/export),
  **Viewer** (view-only). Roles are editable; custom roles allowed.
- **Enforcement is server-side** on every endpoint (the only place it's real).
  The desktop and web UIs also *hide* what a user can't do (UX), but the server is
  the gate.
- Admin screen (desktop **and** web): list employees, assign role, toggle
  per-module permissions, suspend, resend invite.
- Every mutating request is written to an **audit log** (`who, when, action,
  entity`) — both an operational safety net and a due-diligence asset.

---

## 6. API surface — port the Tauri commands to REST

Mechanical mapping. Each `#[tauri::command]` that touches data becomes an axum
route in `clienthub-server`, calling the same `clienthub-core` logic, wrapped in a
permission check.

| Today (`api.ts` → `invoke`) | Server route | Perm |
| --- | --- | --- |
| `list_clients_filtered` | `GET /api/clients?…` | clients:view |
| `create_client` / `update_client` | `POST/PUT /api/clients/:id` | clients:edit |
| `update_client_status` (Dormant) | `PATCH /api/clients/:id/status` | clients:edit |
| `list_inventory` / lot CRUD | `…/api/inventory…` | inventory:* |
| quotes + PDF | `…/api/quotes…`, `POST /api/quotes/:id/pdf` | quotes:* |
| manifests parse/breakdown/export | `…/api/lots/:id/manifest…` | manifests:* |
| newsletters / scheduled sends | `…/api/email…` | email:* |
| deal flow | `…/api/deals…` | deal_flow:* |

`api.ts` gets a tiny `http()` helper (adds `Authorization`, base URL, error
handling); each wrapper swaps `invoke("x", a)` → `http("/api/x", a)`. The React
components don't change.

---

## 7. Migration sequencing (incremental — app keeps working throughout)

> Rule: never a big-bang cutover. Dual-run, port module by module behind a flag,
> flip when verified.

### Phase 0 — Server foundation (non-breaking)
- Promote `clienthub-api` → `clienthub-server`; create the `clienthub-core` crate
  and move shared models/DB/PDF/manifest logic into it.
- Add auth tables, RBAC tables, audit log, `org_id` columns.
- Stand up Caddy + domain + TLS on the PC; port-forward 443; verify HTTPS.
- **Nothing in the desktop/Syncthing flow changes yet.**

### Phase 1 — Auth + portal skeleton
- Login, invite-link signup, JWT sessions, password reset.
- Minimal web portal: login → role-gated dashboard → **read-only Clients list**.
- Admin screen (web + desktop) for employees/roles.

### Phase 2 — Port read/write endpoints, module by module
- Order: **Clients → Inventory → Quotes → Deal Flow → Manifests → Email**.
- For each: server endpoints + permission checks + audit; wire the web portal;
  add desktop "use server" path behind a feature flag.

### Phase 3 — Cut the desktop over & retire Syncthing  *(the big one)*
- One-time **data migration**: export current local SQLite → import into the
  server DB (script + dry-run + verification counts).
- Flip desktop `api.ts` from `invoke`(local) to `http`(server), module by module.
- Keep native Tauri commands **only** for: WhatsApp embed, user email creds
  (keyring), OS dialogs/printing, auto-update.
- **Decommission Syncthing + the HLC event log.**

### Phase 4 — Server-owned email + media
- Move scheduled newsletter sends to a **server scheduler** so they run with the
  desktop closed (host PC up).
- Media (photos/manifests) stored on the server; desktop uploads via API; served
  from `/media` (already the Pi pattern, with no-cache headers).

### Phase 5 — Harden for the team / due diligence
- Audit-log viewer, full data export, automated daily DB backup (+ offsite copy),
  rate limiting, suspended-user enforcement, basic uptime check.

---

## 8. Feature parity checklist (target: everything works)

| Feature | Where it runs | Status in target |
| --- | --- | --- |
| Clients / CRM / filters / **Dormant** | server | ✅ |
| Inventory / lots / photos | server + `/media` | ✅ |
| Deal flow, dashboard, globe, CSV import, geocoding | server | ✅ |
| Quotes + PDF, Manifest reformatter/breakdown + PDF | server (`clienthub-core`) | ✅ |
| Newsletters + **scheduled sends** | server scheduler | ✅ improved (runs w/ desktop closed) |
| Gmail/Outlook OAuth | server, HTTPS redirect URIs | ✅ (reconfig redirects) |
| Employee accounts + **RBAC** | server | ✅ the whole point |
| **WhatsApp embed + drag-to-attach** | desktop-native, per machine/login | ✅ unchanged (not web) |
| Auto-updater | desktop | ✅ (web is always current) |
| Offline use | — | ⚠️ dropped with Syncthing (online required) |

---

## 9. Hosting from Jack's PC — concrete setup

1. **Domain** (~$12/yr, e.g. Porkbun/Cloudflare) → A-record → static IP.
2. **Caddy** (reuse `manifest-platform/infra/Caddyfile`) → auto Let's Encrypt TLS,
   routes `/api/*` → server, everything else → web portal SPA.
3. **Router:** forward TCP 443 (and 80 for cert issuance) to the PC.
4. **Run** the server (native binary or Docker) with restart-on-boot.
5. **Backups:** scheduled task → nightly SQLite backup → second drive + offsite
   (e.g. a cloud folder). Verify restore once.
6. **OAuth:** add `https://<domain>/…/callback` to Google/Microsoft consoles.
7. PC stays on during working hours; consider a UPS.

> No recurring cost beyond the domain. Moving to a $5 VPS later is the same config.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Big-bang cutover breaks everything | Strict module-by-module, dual-run, feature-flagged (Phase 2–3). |
| Data loss during migration | Dry-run import + row-count verification + keep the old SQLite untouched as backup. |
| PC downtime blocks the team | Backups + restart-on-boot + UPS; VPS as the escape hatch. |
| Security exposure | argon2, TLS-only, authz on every route, rate limits, no creds in logs. |
| Offline expectation | Set expectations now; optional read cache later. |
| Logic drift desktop vs server | Single source: `clienthub-core` shared crate. |

---

## 11. First concrete step (Phase 0, ready to start)

1. Create the Cargo workspace + **`clienthub-core`** crate; move the shared models
   and one slice of logic (start with **Clients**) into it.
2. In `clienthub-server` (from `clienthub-api`): add `users`, `roles`,
   `permissions`, `invites`, `audit_log` tables + `org_id` columns (idempotent
   `CREATE/ALTER`, mirroring the existing `ensure_meta_tables` pattern).
3. Implement **login + invite signup + JWT**; seed an Admin user (Jack).
4. Stand up Caddy + domain + TLS; verify `https://<domain>/health`.

That delivers a secure, hosted foundation **without touching** the live
desktop/Syncthing flow — proving the path before we migrate real data.

---

## 12. Reconciling the existing desktop team feature (Phase 3 detail)

The desktop **already has a synced team feature** that overlaps with the new
server employee system. They must converge on one source of truth.

**Desktop today** (`users` table, synced desktop↔Pi): `name, email, role`
(`owner`/`sales_rep`/`viewer`), `invite_code`, `is_active`; commands
`list_users` / `create_owner_user` / `invite_user` / `remove_user` /
`update_user_role` / `get_current_user`; a Settings→Team UI; a hardcoded
`permissions.ts` role→feature matrix; `current_user_id` in settings; interactions
tagged with `user_name`. **No passwords/login** (local-first trust model).

**Server now** (`staff_accounts`, server-only): email+password (JWT), data-driven
`module:action` permissions, invite links, web portal, server-enforced.

> Note: the server table was renamed `users → staff_accounts` specifically to
> avoid colliding with this pre-existing desktop `users` table. They coexist
> safely until reconciled.

**Target:** the **server owns identity**; the desktop authenticates against it.

Role mapping: `owner → Admin`, `sales_rep → Sales`, `viewer → Viewer`
(+ Manager as a new option).

Steps (part of Phase 3):
1. Desktop gains a **login** → authenticates to the server → stores the Bearer
   token (already supported server-side).
2. The logged-in server user replaces the `current_user_id` selector; interaction
   tagging uses that identity.
3. Replace the hardcoded `permissions.ts` matrix with the server's permissions
   (desktop fetches `/me`; gate nav/edit by `module:action`). Keep `permissions.ts`
   as a thin mapper during transition.
4. **Migrate** each existing desktop `users` row → a `staff_accounts` row (same
   name/email/role); password set on first login via invite/reset.
5. Unify invites on the server link flow; retire the desktop invite-code path and
   **freeze** the old synced `users` table (no longer the source of truth).

Until Phase 3, nothing changes — the desktop team feature keeps working and the
two tables coexist.

---

### TL;DR
Grow the Pi's axum API into the **ClientHub Server** on your PC (SQLite stays,
Syncthing goes). Extract shared Rust into `clienthub-core` so the desktop and
server never diverge. Desktop stays primary but talks to the server and is now
permission-gated; employees get an invite-link **web portal**; admin controls roles
from both. WhatsApp stays a per-machine desktop integration. Everything works
except offline — migrate **module by module, dual-running**, so the app never
goes dark. Phase 0 (auth + hosting foundation) is safe to start today.
