# Plan — permissions, settings access, categories, tab bugs (2026-07)

Plan-first per CLAUDE.md. Root causes below are from the real code; nothing built yet — awaiting approval.

## 1. Role change stuck on "Saving…" (the active blocker)
**What the code shows**
- Desktop role change: `setRole → api.updateStaff → update_staff` (employees.rs:352). It's a fast local
  write; **no per-row status or error handling** in `setRole` (SettingsView:3098) — a failure is silent.
- Web role change: `PATCH /api/admin/users/:id → handle_update_user` (employees.rs:1372) — exists.
- The **"Saving…" pill** is the *global settings auto-save* (`useAutosave`, SettingsView:92-108). If any
  auto-saved section's `save()` **never resolves**, the pill is stuck on "saving" forever (only `catch`
  handles rejection; a hang has no timeout).
**Most likely cause:** a settings section's `save()` (a server/sync round-trip in SaaS mode) hangs and
pins the pill; the role change itself may be succeeding or silently failing separately.
**Fix**
- (a) Make the role change **explicit**: per-row `Saving → Saved / Failed(reason)` state, so it can never
  look ambiguous and any error is shown.
- (b) Harden `useAutosave`: add a **timeout** so a hung `save()` flips to "error + Retry" instead of
  sticking; surface *which* section failed.
- (c) Reproduce with instrumentation to find the specific hanging `save()` (candidate: an SMTP/company
  push in SaaS mode) and fix it.
- (d) Verify role-change **propagation in SaaS mode** desktop→server→other device (the sales account
  must actually receive the new role).
**Success:** changing a member's role shows Saved within ~1s (or a clear error), the target account's
permissions change on their device after sync, and the global pill never sticks.

## 2. Viewer/Sales can open Settings (limited) + appearance for everyone
**What the code shows**
- The whole **Settings tab is gated by `admin:manage`** (permissions.ts `tabPerm`), so non-admins can't
  even open it to reach Appearance.
- Theme/appearance is a per-device setting (not org data) — safe for anyone to change their own.
**Fix — make Settings a tab everyone can open, gate each SECTION by permission**
- Ungate the Settings **tab** (available to any signed-in user).
- Add **section-level permission checks** inside SettingsView; render each section only if allowed.
- Proposed default access matrix (confirm below):
  | Section | Viewer | Sales | Admin |
  |---|---|---|---|
  | Appearance / Theme (per-device) | ✅ | ✅ | ✅ |
  | My Profile (own name/avatar/password) | ✅ | ✅ | ✅ |
  | Company info, Email/SMTP, Categories, Integrations, Billing/Plan, Team & Roles, Payout config, Danger zone | ❌ | ❌ | ✅ |
- **Server-side enforcement (defense in depth):** the sensitive save endpoints/commands must re-check
  admin server-side (UI hiding is not enough).

## 3. Bulletproof, production-ready roles/permissions
- **Canonical permission catalog** (module:action) documented in one place, shared by desktop/web/mobile
  (single source = the account's `permissions` array). Add granular settings perms
  (`settings:appearance` is implicit-all; `settings:manage_org` = admin).
- **Role presets:** Owner/Admin (`*`), Sales (clients/deal_flow/quotes/inventory view+edit, own payouts,
  no org settings), Viewer (all `:view`, no edit, no settings). Presets seeded + editable in Team → Roles.
- **Guardrails:** can't demote/remove the last admin; can't demote yourself into lockout; role edits sync;
  a new role's permissions default to a safe minimum.
- **Consistency pass:** every tab/endpoint checks the same permission names on all three surfaces.

## 4. Categories: import from spreadsheet, subcategories, A–Z/Z–A sort
**What the code shows:** `categories` table (`id, label, sort_order`) + `list/create/update/delete_category`
(commands.rs:8620+). Simple flat list, manual add.
**Fix**
- **Detect from spreadsheet:** in the category manager, an "Import from sheet" that reads the distinct
  values of a chosen column (reuse the existing xlsx import plumbing) → proposes new categories → bulk-add.
- **Subcategories:** add `parent_id` to `categories` (nullable). UI shows a two-level tree; a subcategory
  belongs to a parent. Client/inventory category can then be "Parent / Child".
- **Sort A–Z / Z–A:** a toggle that reorders the list (persists to `sort_order`).
- Parity: desktop + web/mobile category managers.

## 5. Tab indicator lands on the wrong tab (MacBook)
**What the code shows:** the sliding indicator's `top` is set in a `useEffect` keyed **only on `[tab]`**
(App.tsx:258-269) that measures `buttonRefs.current[tab]` vs the nav rect. It never recomputes on layout
changes (window resize, nav content/height change, fonts settling) and can read a stale/mismapped ref →
the bar stays at the previously-measured position (e.g., Globe) while the label highlights Settings.
**Fix**
- Use **`useLayoutEffect`** (measure after layout, before paint).
- Recompute on **window resize** and when the **visible tab list changes** (a `ResizeObserver` on the nav +
  dependency on the filtered tabs), and on first mount after refs are attached.
- Guard against stale refs (only measure the currently-rendered button).

## Build order (after approval)
1. **Tab indicator** (small, isolated, safe) → visible win, low risk.
2. **Settings section-gating + appearance-for-all** + server-side enforcement.
3. **Role-change hardening** (explicit status/errors + autosave timeout) + diagnose the hang.
4. **Roles/permissions catalog + presets + guardrails**.
5. **Categories** (parent_id migration, import, sort) — desktop + mobile.
Each shipped + verified (build clean, endpoints guarded) before the next.
