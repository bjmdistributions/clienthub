# Phase 5 — Questions & Clarifications

Things I am uncertain about, with the exact file:line that triggered the question. Resolve these before implementation starts so the plans don't get rewritten mid-flight.

---

## Things I could not verify in source (reading budget limits)

The following sections of [src-tauri/src/commands.rs](src-tauri/src/commands.rs) (6035 lines) I did NOT read in full. The Phase 3 plans for any feature touching these are based on reading their **signatures** in [main.rs:178-380](src-tauri/src/main.rs:178), the corresponding [src/lib/api.ts](src/lib/api.ts) entry, and the matching Pi-side route. Implementation may surface details I missed:

- `generate_recurring_invoices` (called from [main.rs:103](src-tauri/src/main.rs:103)) — Feature 15's plan assumes the column-based recurring scheme works similarly to the Pi's `routes/invoices.rs:74-91` numbering. **Need to read commands.rs implementation before final SQL migration.**
- `create_invoice` / `update_invoice` on desktop — Feature 14's numbering plan reads only the Pi's `generate_invoice_number` ([clienthub-api/src/routes/invoices.rs:74-91](../clienthub-api/src/routes/invoices.rs:74)). The desktop's create_invoice likely diverges. **Need to confirm** the desktop scheme before swapping it.
- `convert_deal_to_invoice` — referenced by Feature 14 indirectly (if it composes a number, the new prefix/padding logic must run there too).
- `send_newsletter` and `schedule_newsletter_send` — Feature 6's plan assumes single-brace `{var}` substitution lands inside both. Need to confirm where they currently call out to email::send.
- `process_followup_rules` — Feature 10's plan extends this. Need to read existing implementation before extending.
- `sync_from_sheet` — Feature 2's enhanced mapping plan assumes it uses the legacy column-name fields. Need to confirm row read/write paths.
- `inventory` commands — Feature 7's plan assumes `update_lot` already accepts a `photos` field per [api.ts:1044](src/lib/api.ts:1044). Need to verify what shape it accepts.

**Question 0:** Should I read these specific sections of commands.rs before any implementation starts, or are the plans confidence-of-shape sufficient and details will be confirmed at edit time?

---

## Bug 1 — Onboarding

**Question 1:** On a device joining a multi-device install where the *original* owner exists on device A but not yet synced to device B, what should happen on first launch?
- A) Auto-create a *new* Owner on device B and let HLC merge later (risks duplicate Owner rows).
- B) Block startup with "Waiting for sync from primary device…" until first sync replay completes.
- C) The current behavior — show UserPicker so the user can enter the invite code (but invites currently don't sync because `users` is not in ALLOWED_TABLES; see Phase 1 issue #3).

The Phase 2 fix assumes A. If you want B, the wizard flow needs an extra "Connect to existing install" branch.

**Question 2:** Should `users` be added to `ALLOWED_TABLES` at [src-tauri/src/sync.rs:362](src-tauri/src/sync.rs:362) and [clienthub-api/src/sync.rs:424](../clienthub-api/src/sync.rs:424)? My Phase 2 fix recommends yes. But user roles being synced has implications: an "owner" demoted on device A would be demoted on device B too, mid-session. Is that desired, or is role assignment intentionally device-local?

---

## Bug 2 — Pi systemd

**Question 3:** What is the *exact* current `/etc/systemd/system/clienthub-api.service` content on the production Pi? The version in the repo ([clienthub-api/clienthub-api.service:10](../clienthub-api/clienthub-api.service:10)) doesn't have spaces in the path. The user's bug description says the deployed unit does. We need the actual deployed content to write the correct fix. Can you `cat` the deployed file and paste it here?

**Question 4:** Why is the DB at `/home/jack/Client Hub DB/clienthub.db` (with spaces) and not just `/home/jack/clienthub-data/clienthub.db`? If there's no reason for the spaces, the simplest fix is to move the DB to a spaces-free path and delete the symlink hack entirely from [clienthub-api/src/main.rs:30-36](../clienthub-api/src/main.rs:30).

---

## Bug 3 — Globe

**Question 5:** What does `geocode_all_clients` output to the log on your Pi/desktop right now? Specifically the `tracing::info!` at [commands.rs:6018-6022](src-tauri/src/commands.rs:6018) — the matched/skipped/not_found counts will tell us whether (a) clients lack addresses, (b) state codes don't match the CSV, or (c) the CSV failed to load. Please share one run's log line.

**Question 6:** The Globe view fetches earth textures from `https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg` ([GlobeView.tsx:154](src/components/GlobeView.tsx:154)). Is offline-capable globe rendering a requirement? If yes, bundle the textures into `src-tauri/icons/` or `public/` and reference them via tauri's asset protocol.

---

## Bug 4 — Portal URL

**Question 7:** When the portal is reached over the internet, what is the public URL? Is the Pi reachable via a fixed public IP, dyndns name, or behind a reverse proxy on a domain like `portal.bjmdistributions.com`?

**Question 8:** Should the `portal_base_url` setting **sync** across devices (so all 3 devices generate the same URL), or be **device-local** (so each device might generate links pointing to a different host)? My Phase 2 plan implicitly makes it synced (lives in `settings`). Confirm.

---

## Feature 1 — Stripe

**Question 9:** What Stripe account model do you want?
- A) Single Stripe account on the business owner's name (simplest).
- B) Stripe Connect with sub-accounts per partner (relevant if `profit_split_jack` / `profit_split_ben` should pay out automatically via Stripe Connect).

The Phase 3 plan assumes A. Option B doubles the schema (connected_accounts table, webhook for connected_account.updated, etc.).

**Question 10:** Where does the Stripe Checkout page get hosted? Options:
- A) Send the customer a Stripe-hosted Checkout link (no UI work; client clicks → pays at checkout.stripe.com).
- B) Embed Stripe Elements on the Pi's portal page (more work, lives at the same URL as the existing portal).

A is far simpler. Phase 3 plan implies A but does not commit.

---

## Feature 2 — Sheets sync

**Question 11:** What is "the existing Google Sheets HTTP path used by `sync_from_sheet`"? I did not read this command in full. Is it (a) public-published CSV URL pattern, (b) Google Sheets API v4 with OAuth, or (c) GViz JSON query? The plan for `get_sheet_headers` (Feature 2) needs to use the same auth/transport.

**Question 12:** "Bidirectional sync: ClientHub wins on conflict" — does this mean ClientHub never reads what the sheet currently has for a field that ClientHub also stores, or that on a conflict (both sides changed since last sync) ClientHub overwrites? They are different semantics:
- "Always overwrite" → simple, but loses *all* sheet edits.
- "LWW with ClientHub bias on tie" → more thoughtful but needs tracking last-pushed-at per row.

---

## Feature 3 — Invoice PDF

**Question 13:** PAID/OVERDUE watermark color — green/red is straightforward, but printpdf 0.7 has limited transparency support (verified at [invoice.rs](src-tauri/src/invoice.rs)). The Phase 3 plan suggests rendering text with a light tint and saturated fill. Is that acceptable, or do you need the watermark to be a true PDF graphic state with 18% alpha? If true alpha, we'd need to switch to a newer PDF crate (e.g. `lopdf` + manual graphics state) which is a chunkier rewrite.

**Question 14:** Multi-page invoice support: for invoices with 60+ line items, where does the totals block go? Phase 3 says "last page only". Confirm — or do you want a "Subtotal so far / continued on next page" pattern?

---

## Feature 4 — Bulk actions

**Question 15:** Bulk-delete for clients with associated invoices: should this cascade-delete invoices too, or block deletion if invoices exist? The current single `delete_client` ([commands.rs:271-276](src-tauri/src/commands.rs:271)) just runs `DELETE FROM clients`, relying on the migration-1 schema's `ON DELETE CASCADE` for interactions but **NOT for invoices** — invoices have a FK without ON DELETE clause ([db.rs:158](src-tauri/src/db.rs:158)). That means deleting a client right now fails silently or leaves orphan invoices. This is a latent bug; please confirm the desired behavior.

---

## Feature 5 — Google Contacts

**Question 16:** Should the Google Contacts OAuth be a **separate** consent (with its own refresh token) or **combined** with the existing Gmail OAuth (single token with both scopes)? Phase 3 says separate. Combined is fewer prompts but reuses the same token — if the user disconnects Gmail, contacts also disconnect.

---

## Feature 8 — Enterprise shared portal

**Question 17:** This is the largest feature by far. Are you committed to building it, or is the plan deliverable enough on its own for now? My Phase 4 priority list pushes it to last (priority 19). If shared portal is the actual urgent feature, the priority order shifts significantly.

**Question 18:** Cloud hosting — what VPS/region? Cloud server cost will be ~$5-20/mo, which changes the cost model in [DEPLOY.md](DEPLOY.md) (currently advertised as $6/mo total).

**Question 19:** Photos for shared inventory — where do they live? Phase 3 says "blob storage". Options: S3, R2, the cloud VPS local disk. The choice affects egress costs and backup strategy.

---

## Feature 10 — Follow-up enhancements

**Question 20:** Tier-drop triggers — how do you want to handle a brand-new device that has just synced in all the clients? The first tier computation per-client will not see a previous tier, so every client looks like a "new" tier (no drop). Do you want to suppress tier_drop triggers for the first N hours after sync, or only fire when `tier_history` already has at least one prior entry for that client?

**Question 21:** Unsubscribe detection — what if a customer writes "please don't unsubscribe me from the newsletter" (literally containing the word)? The Phase 3 regex `\bunsubscribe\b` is naive. Options:
- A) Accept false-positives (current plan).
- B) Require the body to start with the word or include only that word.
- C) Use AI extraction to detect intent (cost: an Ollama call per email; already in the email pipeline anyway at [email.rs:455](src-tauri/src/email.rs:455)).

---

## Feature 12 — Keyboard shortcuts

**Question 22:** Cmd+K conflicts with browser/OS shortcuts in some webviews. Tauri 2 should let us claim it inside the app's webview, but on macOS Cmd+K is "Clear Display" in Terminal. Tauri webviews don't inherit Terminal shortcuts. Confirm we're free to take it.

**Question 23:** `?` shortcut for help: does this conflict with QuickLogModal's `L` shortcut or any existing letter shortcut? My read of [App.tsx:116-129](src/App.tsx:116) only sees `L` and `N` claimed today. `?` should be safe.

---

## Feature 14 — Custom invoice numbering

**Question 24:** What happens when you switch numbering schemes mid-stream? E.g., old invoice is "INV-2026-0042" (year-padded), new scheme is "ACME-1000" (no year). They sort differently. Is that OK, or do you want a one-time "normalize all existing invoice numbers" tool?

**Question 25:** If two devices try to create an invoice simultaneously, both read `invoice_next_number = 42` and both create "INV-0042". Then both increment to 43. Sync collision: both rows survive (different invoice ids), but the same number is used twice. Acceptable, or should we move number generation to a Pi-coordinated central counter?

---

## Feature 15 — Recurring invoices

**Question 26:** Migrating existing recurring invoices (`recurring`, `next_recurring_date` columns on `invoices`) into the new `recurring_invoices` table — my Phase 3 migration includes the `INSERT INTO recurring_invoices SELECT … FROM invoices WHERE recurring IS NOT NULL`. After this, the existing data path that reads from invoices' columns is unused. Should we drop those columns immediately or in a follow-up release? Dropping columns in SQLite means table rebuild — small but real downtime risk.

---

## Architecture-wide

**Question 27:** ARCHITECTURE.md is severely out of date. Should I:
- A) Rewrite it as part of this batch (1-2 agent-hours).
- B) Leave it; rely on Phase 1's summary as the new canonical reference.
- C) Delete it entirely.

**Question 28:** The two unregistered Tauri commands `customer_health_scores` and `get_customer_health` ([api.ts:886-887](src/lib/api.ts:886)) — does HealthView.tsx actually compile or does it fail at runtime? Should we implement them or remove the api.ts entries?

**Question 29:** Version sync between `package.json` and `Cargo.toml` is broken (0.11.0 vs 0.7.2). Is there a CI check that should enforce this? Should it be part of the bug-fix batch?

**Question 30:** The `clienthub-api` Cargo.toml version is 0.11.0 (matches desktop). The Pi binary advertises `clienthub-api v0.1.0` in its log message at [clienthub-api/src/main.rs:83](../clienthub-api/src/main.rs:83). That `0.1.0` is a hardcoded string. Should it match Cargo.toml's version?

---

## Manifest analyzer PDF integration point

**Question 31:** Per the brief, an "external technology" will integrate later for PDF manifest parsing. The current manifest analyzer ([manifest.rs](src-tauri/src/manifest.rs)) takes a CSV path. Plan for the integration point:
- Add a `parse_manifest(path) -> Result<Vec<ParsedRow>, anyhow::Error>` trait.
- Have CSV impl be the default.
- External tech implements the same trait and is invoked when `path.ends_with(".pdf")`.

Should I codify this trait now (1 hour) or wait for the external technology to land?

---

## Stop-points / scope confirmations

**Question 32:** Are any of the 15 features explicitly NOT wanted? E.g., enterprise shared portal (Feature 8) is huge and may not be desired in current quarter. Confirm the active set.

**Question 33:** "Dark mode is already implemented" — confirmed via [App.tsx:55-63](src/App.tsx:55). The Globe view forces a dark theme regardless ([App.tsx:300](src/App.tsx:300)). Is that intentional, or should the globe respect the dark-mode toggle? (Currently it ignores it.)
