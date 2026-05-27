# Phase 2 — Bug Diagnosis

For each bug: root cause from source, exact file:line, minimal fix. No code in this document.

---

## Bug 1: Invite-code prompt for existing users

**Symptom**: After Task 5 (multi-user) shipped, existing users (with clients, invoices, etc.) sometimes see the UserPicker (App.tsx:332) with an invite-code box on launch.

**Root cause** — *combination of two paths that bypass auto-detection*:

1. **`get_onboarding_status`** at [src-tauri/src/commands.rs:2997-3012](src-tauri/src/commands.rs:2997) only auto-marks onboarding complete when **BOTH** `COUNT(clients) > 0` **AND** the `company_info` settings key exists. If a user has clients (e.g. CSV-imported) but never filled in `company_info` (or it was lost on a restore), this returns `false` → OnboardingWizard re-runs.

2. **`get_current_user`** at [commands.rs:3263-3309](src-tauri/src/commands.rs:3263):
   - Line 3270: queries `users WHERE is_active=1`. If exactly one active user exists, picks them.
   - Lines 3282-3296: if **no** users and **has clients** and **company_info JSON parses successfully**, auto-creates an Owner user.
   - **Falls through to `return Ok(None)`** if: users is empty + no clients **OR** users is empty + no company_info **OR** company_info JSON is unparseable **OR** `users.len() > 1` and no `current_user_id` setting.
   - When None is returned, `App.tsx:171` renders UserPicker, which shows the invite-code box.

3. **`OnboardingWizard.finish()`** at [OnboardingWizard.tsx:104](src/components/OnboardingWizard.tsx:104) only calls `createOwnerUser` if `biz.user.trim()` is non-empty — but the wizard's Next button (line 278) only validates `biz.company.trim()`. A user who left "Your name" blank but filled "Business name" completes onboarding **without ever creating a user record** → UserPicker fires.

4. Additionally: `invite_user` writes `users` rows that are pushed through `sync::record_upsert("users", ...)` ([commands.rs:3197](src-tauri/src/commands.rs:3197)), but the `users` table is **not in `ALLOWED_TABLES`** at [sync.rs:362](src-tauri/src/sync.rs:362). So invited users from device A never propagate to device B. On a fresh secondary device, `users` is empty → either auto-create-owner fires (correct) or UserPicker fires (with no users to pick).

**Location of the prompt itself**: [src/App.tsx:171, 332-378](src/App.tsx:171) (UserPicker component, conditional render).

**Minimal fix**:
1. In `get_current_user` ([commands.rs:3282-3296](src-tauri/src/commands.rs:3282)), drop the `company_info` requirement from the auto-owner-create branch. If `users` is empty and `clients > 0`, create an Owner with name "Owner" and email "" rather than skipping. Make the `company_info` parse a best-effort lookup for the name.
2. In `get_onboarding_status` ([commands.rs:2997](src-tauri/src/commands.rs:2997)), drop the company_info requirement from the auto-complete branch. Existing users with any clients should never see the wizard, regardless of whether they ever entered company info.
3. In `OnboardingWizard.finish()` ([OnboardingWizard.tsx:104](src/components/OnboardingWizard.tsx:104)), make Owner-user creation unconditional. If `biz.user` is blank, fall back to the business name or "Owner".
4. Add `users` to `ALLOWED_TABLES` in [sync.rs:362](src-tauri/src/sync.rs:362) so invites propagate (separate concern but addresses the multi-device half of the bug).

---

## Bug 2: PIN resets on every Pi `cargo build --release`

**Symptom**: After `cargo build --release` on the Pi and a service restart, the bcrypt PIN hash in `settings.mobile_api_pin_hash` is gone; the mobile UI prompts for setup again.

**Root cause** — *startup order in `clienthub-api/src/main.rs`*:

[clienthub-api/src/main.rs:27](../clienthub-api/src/main.rs:27) calls `db::open_db()` **before** the spaces-path symlink-creation block at lines 30-36:

```
27   db::open_db();                                          ← opens DB FIRST
...
30   #[cfg(target_family = "unix")] {
31       let symlink_path = "/home/jack/clienthub.db";
32       let real_path = "/home/jack/Client Hub DB/clienthub.db";
33       if std::path::Path::new(real_path).exists() && !std::path::Path::new(symlink_path).exists() {
34           let _ = std::os::unix::fs::symlink(real_path, symlink_path);  ← symlink created AFTER
35       }
36   }
```

`db::open_db` ([db.rs:9](../clienthub-api/src/db.rs:9)) reads `CLIENTHUB_DB_PATH` env var, defaults to `/home/jack/clienthub.db` (the symlink path). SQLite's `Connection::open` will **create an empty database file** if none exists at that path — silently. So on any boot where the symlink target file `/home/jack/clienthub.db` is absent (e.g. systemd just restarted and the symlink hasn't yet been created by this binary), a brand-new empty DB is opened, the symlink-creation code then sees that symlink_path DOES exist (because SQLite just made it as a regular file) and skips the `symlink()` call. From that point on the real DB at `/home/jack/Client Hub DB/clienthub.db` is orphaned, and PIN-less SQLite is what auth.rs queries against → "no PIN set".

A secondary contributor: the systemd unit file in the repo ([clienthub-api/clienthub-api.service:10](../clienthub-api/clienthub-api.service:10)) sets `CLIENTHUB_DB_PATH=/home/jack/clienthub.db` (the symlink path, no spaces) — but the user's report says the deployed unit uses `CLIENTHUB_DB_PATH=/home/jack/Client Hub DB/clienthub.db` (with spaces). systemd's `Environment=KEY=VALUE` syntax requires the entire `KEY=VALUE` pair to be inside double quotes when the value contains spaces, e.g. `Environment="CLIENTHUB_DB_PATH=/home/jack/Client Hub DB/clienthub.db"`. Without those outer quotes, systemd splits on whitespace and the env var becomes `CLIENTHUB_DB_PATH=/home/jack/Client`, which SQLite will then open as a fresh empty DB at `/home/jack/Client`.

**Minimal fix**:
1. Move the symlink-creation block to run **before** `db::open_db()` (swap lines 27 and 30-36 in clienthub-api/src/main.rs).
2. Add a sanity check after `db::open_db()`: if `SELECT COUNT(*) FROM clients` returns 0 *and* `/home/jack/Client Hub DB/clienthub.db` exists with non-zero size, abort the process (`panic!`) with a clear error rather than running on an empty DB.
3. Replace the systemd file with one that explicitly quotes the env var: `Environment="CLIENTHUB_DB_PATH=/home/jack/Client Hub DB/clienthub.db"` — and add a comment warning future-self about quoting.
4. (Optional but recommended) Change the default in `db::open_db` ([db.rs:10](../clienthub-api/src/db.rs:10)) from the bare symlink path to the real spaces-path. Then drop the env var entirely.

---

## Bug 3: Globe shows "No client locations found"

**Symptom**: `GlobeView` renders the "No client locations found / Geocoding in progress…" overlay despite the user having clients.

**Root cause** — *data, not code*: the geocode logic at [commands.rs:5887-6024](src-tauri/src/commands.rs:5887) reads `metadata.city` and `metadata.state` from each client's metadata JSON (lines 5906-5907, 5968-5969). Plotting in [GlobeView.tsx:377-391](src/components/GlobeView.tsx:377) reads `metadata.lat` and `metadata.lng`. The write paths into metadata are:

- Manual create/update via `create_client` / `update_client` ([commands.rs:175-178, 234-237](src-tauri/src/commands.rs:175)) — writes `meta.city`, `meta.state`.
- CSV import ([csv_import.rs:161-162](src-tauri/src/csv_import.rs:161)) — same keys.
- Sheet sync ([commands.rs:5769-5770, 5792-5793](src-tauri/src/commands.rs:5769)) — same keys.

So the schema is consistent. The failure modes that produce "no dots":

1. **Most clients were created before address fields were ever filled in.** Older client records have empty `meta.city`/`meta.state` → `geocode_all_clients` skips them ([commands.rs:5971-5978](src-tauri/src/commands.rs:5971)) and increments `skipped`. The result-string `geocode: matched 0/N, skipped N, not found 0` is logged but never surfaced — UI shows the generic message.

2. **Geocode init fails silently**: [main.rs:40-43](src-tauri/src/main.rs:40) warns but does not abort if `geocode::init()` fails. If `assets/uscities.csv` is missing at compile time the binary won't compile (`include_str!`), so it's bundled; but if the CSV is corrupted/empty, `init()` succeeds with 0 entries and all lookups return None → "not found" for every client.

3. **`geocode_all_clients` startup spawn has a 5-second sleep** before running ([main.rs:128](src-tauri/src/main.rs:128)). If `GlobeView` is the user's first-opened tab, they may see the empty state for those 5 s. The view's own auto-trigger ([GlobeView.tsx:136](src/components/GlobeView.tsx:136)) compensates for this.

4. **The state lookup is case-insensitive (lowercased in [geocode.rs:54-55, 87-88](src-tauri/src/geocode.rs:54)) and accepts both state IDs ("IN") and full names ("Indiana")** — so "in" vs "IN" is not the issue.

**Location**:
- Geocode reader: [commands.rs:5906-5907, 5968-5969](src-tauri/src/commands.rs:5906)
- Geocode init in startup: [main.rs:40](src-tauri/src/main.rs:40), [main.rs:127-133](src-tauri/src/main.rs:127)
- Globe plotter: [GlobeView.tsx:377-391](src/components/GlobeView.tsx:377) (`toPoints`)
- Empty-state overlay: [GlobeView.tsx:269-283](src/components/GlobeView.tsx:269)

**Minimal fix**:
1. **Surface the geocode result message**: have `geocode_all_clients` return a structured result `{ total, matched, skipped, not_found }` instead of a string, and have GlobeView render the breakdown ("47 clients have no city/state — fill in addresses to plot them"). The empty-state currently misleads — the geocode is *working*, but most data is unaddressable.
2. **Add a "missing address" filter shortcut from the Globe view**: button that navigates to ClientsView with `missing=address` filter pre-set, so the user can fill in the addresses for un-plotted clients.
3. **Don't auto-trigger geocode if 0 clients have city/state** — query first, only run if any rows have addressable metadata.
4. **Log a sample on startup**: keep the existing `tracing::info!("geocode sample: …")` at [commands.rs:5973-5975, 5981](src-tauri/src/commands.rs:5973) so the operator can see what was extracted.

(No code change actually fixes the data — but the misleading "in progress" message goes away, which is the user-visible bug.)

---

## Bug 4: Portal URL placeholder

**Symptom**: `generate_portal_link` produces a URL with hardcoded `http://pi:8080` host, which only resolves on the local network with mDNS — not usable for sharing with a client.

**Root cause**: [src/components/ClientDetailView.tsx:200](src/components/ClientDetailView.tsx:200), :201, :205 build the URL inline:
```
`http://pi:8080/portal/${portalLink}`
```
No `portal_base_url` setting exists. The Tauri command `generate_portal_link` ([commands.rs:3633-3655](src-tauri/src/commands.rs:3633)) only returns the token — the full URL is assembled client-side.

**Minimal fix**:
1. Add `portal_base_url` to the settings table — default empty. Settings → Portal section in `SettingsView.tsx` to set it (e.g. `https://portal.bjmdistributions.com` or `http://192.168.1.50:8080`).
2. Change `generate_portal_link` to **return the full URL** ([commands.rs:3633](src-tauri/src/commands.rs:3633)) by joining the base URL with `/portal/{token}`. Add `portal_url: String` to `PortalLink` struct. (If `portal_base_url` is empty, surface a clearly-labeled placeholder `<set portal base URL in Settings>` rather than `http://pi:8080`.)
3. Update `ClientDetailView.tsx:200-205` to render `portalLink.portal_url` instead of concatenating.
4. Update PortalLink TypeScript type in [api.ts:686-694](src/lib/api.ts:686) to include the new field.

Note: the Pi's `GET /portal/:token` endpoint already serves the page correctly regardless of host — only the URL handed to the customer needs to be a real public address.
