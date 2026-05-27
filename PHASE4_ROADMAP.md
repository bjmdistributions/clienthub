# Phase 4 — Prioritized Implementation Roadmap

Ordering criteria:
1. **Bugs first** (visible breakage)
2. **Revenue-unlocking before nice-to-have**
3. **Respect dependencies** (a feature comes after anything it builds on)
4. **Estimates in agent-hours** (assumes a focused implementation session by an agent who has read Phase 1-3)

Agent-hour scale used: 1 h = a single 1-tool-call test/verify cycle. Includes implementation, smoke test, and verification per Phase 3's verification list. Does NOT include human review or full QA. Multiply by 2-3× for human-engineer hours.

---

## REVISED — Phase 5 Q&A applied (2026-05-27)

**Strategy confirmed**: build Features 1-7 + 9-15 on the current Tauri/Syncthing arch first, then pivot to SaaS per [PHASE6_SAAS_PIVOT.md](PHASE6_SAAS_PIVOT.md).

**Deferred**: Feature 8 (Enterprise shared portal) → its goals are absorbed by the SaaS pivot's org system.

**New items added below**: ARCHITECTURE.md rewrite, version sync fixes, hardcoded version string fix, customer_health command implementation, manifest trait codification, invoices FK RESTRICT migration.

**Stripe scoping clarification**: the webhook handler is built but inactive until SaaS server is live. Bare-bones Stripe (DB schema, UI, manual reconciliation) ships in this batch.

Total revised estimate: ~104 agent-hours through the current-arch features (slightly up from 98 due to new items). The SaaS pivot adds ~190 agent-hours on top, planned in PHASE6.

---

## Priority 1 — Bug 2: PIN resets on Pi rebuild
**Estimated: 1.5 agent-hours** (revised — also moves DB path)
**Dependency:** none
**Reason:** Breaks the mobile UI entirely on every release. Must be fixed before anything else ships to the Pi.

Includes:
- Reorder main.rs:27 vs lines 30-36
- Per Q4: move DB to `/home/jack/clienthub-data/clienthub.db`, delete the symlink-creation block entirely
- Update default path in `db.rs:10` to match
- Replace the systemd unit with a properly-quoted version
- Add empty-DB sanity check (panic if `COUNT(*) FROM clients = 0` and DB just-created)
- Retest with a real Pi cycle

---

## Priority 2 — Bug 4: Portal URL placeholder
**Estimated: 1.5 agent-hours**
**Dependency:** none
**Reason:** Already-shipped portal feature is unusable for sharing externally — adds a `portal_base_url` setting, returns full URL from `generate_portal_link`, updates UI and PortalLink type.

---

## Priority 3 — Bug 1: Invite-code prompt for existing users
**Estimated: 1.5 agent-hours**
**Dependency:** none
**Reason:** Existing-user trust issue. Fix is small (drop company_info requirement from auto-detect, make OwnerUser creation unconditional in wizard, add `users` to ALLOWED_TABLES).

---

## Priority 4 — Bug 3: Globe empty-state messaging
**Estimated: 1.5 agent-hours** (revised — adds file logging)
**Dependency:** none
**Reason:** The geocode logic is correct — only the empty-state UX needs to surface "N clients have no address" with a deep-link to the Clients view with `missing=address` filter. Low risk, high clarity gain.

Includes per Q5: write a `<app_data_dir>/logs/geocode.log` file with one line per run so the operator can `Get-Content` the log without needing a Tauri dev console.

---

## Priority 4.5 — Bundled small fixes
**Estimated: 4 agent-hours**
**Dependency:** none (run alongside the bug batch)
**Reason:** Cluster of small chores from the Q&A. Better as a single batch than scattered across releases.

Includes:
1. **Version sync** (Q29): bump `src-tauri/Cargo.toml` 0.7.2 → 0.11.0. Add a `build.rs` panic on package.json/Cargo.toml mismatch.
2. **Hardcoded version** (Q30): replace `"clienthub-api v0.1.0"` at [clienthub-api/src/main.rs:83](../clienthub-api/src/main.rs:83) with `concat!("clienthub-api v", env!("CARGO_PKG_VERSION"))`.
3. **Unregistered commands** (Q28): implement `customer_health_scores` and `get_customer_health` in commands.rs, wire into `invoke_handler!`. Port the scoring formula from the Pi's [routes/clients.rs:385-432](../clienthub-api/src/routes/clients.rs:385).
4. **Invoices FK RESTRICT** (Q15): rebuild the `invoices` table with `ON DELETE RESTRICT` on the `client_id` FK. New migration (29, before Feature 1 — bump Feature 1 to migration 30).
5. **Manifest parser trait** (Q31): codify `ManifestParser` trait in [manifest.rs](src-tauri/src/manifest.rs). CSV default impl, `unimplemented!()` stub for PDF.
6. **ARCHITECTURE.md rewrite** (Q27): replace stale doc using PHASE1_CODEBASE_SUMMARY as the source. Add a forward pointer to PHASE6_SAAS_PIVOT.

---

## Priority 5 — Feature 14: Custom Invoice Numbering
**Estimated: 3 agent-hours**
**Dependency:** none
**Reason:** Frequently-requested before launching the business publicly; trivially scoped (3 settings keys, modify one command). Several customers refuse new tools that don't let them keep their existing invoice numbering scheme.

---

## Priority 6 — Feature 9: Auto-Backup Audit + Integrity Check
**Estimated: 2 agent-hours**
**Dependency:** none
**Reason:** Found an active bug while auditing — `name.len() == 33` should be `== 30`, meaning the 30-day cleanup currently never runs. Restore-blocker if backup file is corrupted is critical for trust.

---

## Priority 7 — Feature 1: Stripe Payment Infrastructure (bare bones)
**Estimated: 6 agent-hours**
**Dependency:** none
**Reason:** Revenue path. Per Q9/Q10: single business Stripe account, Stripe-hosted Checkout (not Elements). Per Q&A, the webhook handler stays stubbed in this batch — full activation lives in [PHASE6 §8](PHASE6_SAAS_PIVOT.md). Even without the live webhook, having the DB schema, sync replication, UI hooks, and clearly-marked TODO sites means flipping the switch later is a tiny additional task.

---

## Priority 8 — Feature 6: Email Template Variables
**Estimated: 4 agent-hours**
**Dependency:** none (independent — but feeds Features 10 and 15)
**Reason:** Unblocks better follow-up automation and recurring invoices. The shared `substitute_variables` function is the central piece — implementing once and using everywhere is the right shape.

---

## Priority 9 — Feature 3: Invoice PDF Polish
**Estimated: 6 agent-hours**
**Dependency:** none
**Reason:** Customers see invoices. The current PDF is functional but visually unpolished. PAID/OVERDUE watermarks reduce billing disputes; right-aligned numbers look professional.

---

## Priority 10 — Feature 4: Bulk Client Actions
**Estimated: 4 agent-hours**
**Dependency:** none (prepares the `export_clients_csv` prototype for Feature 13)
**Reason:** Big time-saver as the client list grows. Bulk Send Email is the high-value action — pairs with newsletter feature already in place.

---

## Priority 11 — Feature 13: Export CSV / Excel for all views
**Estimated: 4 agent-hours**
**Dependency:** Feature 4 (reuses `export_clients_csv` pattern)
**Reason:** Standard "I want my data" capability. The Excel analytics export is the differentiator for users who want to share reports.

---

## Priority 12 — Feature 7: Inventory Photos Display
**Estimated: 4 agent-hours**
**Dependency:** none
**Reason:** The data is already in the schema (`photos_json`), just no UI. Quick visual win. Helps the manifest analyzer feel less abstract.

---

## Priority 13 — Feature 15: Recurring Invoice Templates
**Estimated: 5 agent-hours**
**Dependency:** Feature 6 (variables in template line item descriptions are useful)
**Reason:** Existing partial implementation needs to be lifted to a proper UI. Customers who order on a regular cycle save time.

---

## Priority 14 — Feature 12: Keyboard Shortcuts + Global Search
**Estimated: 5 agent-hours**
**Dependency:** none
**Reason:** Power-user feature. Cmd+K palette is a known UX delighter — once the user count grows past 5 the time savings compound.

---

## Priority 15 — Feature 10: Follow-Up Rule Enhancements
**Estimated: 6 agent-hours**
**Dependency:** Feature 6 (variables in email_body)
**Reason:** Tier_drop and birthday triggers + Automation Log + unsubscribe handling. Builds on the existing follow-up rules infrastructure. Higher complexity than the simpler features.

---

## Priority 16 — Feature 5: Client Import from Google Contacts
**Estimated: 5 agent-hours**
**Dependency:** none — reuses existing OAuth infrastructure with a different scope
**Reason:** Onboarding helper. Many small businesses' clients live in Google Contacts. Same OAuth flow that already exists for Gmail — incremental.

---

## Priority 17 — Feature 2: Google Sheets Sync Enhanced
**Estimated: 12 agent-hours** (revised — scope grew with OAuth migration)
**Dependency:** none
**Reason:** Existing sheets-sync only handles fixed columns. Per Q11: also migrate from URL-hack to Google Sheets API v4 + OAuth in this batch (don't carry the URL hack forward). Custom field mapping unlocks customer-specific data shapes. Bidirectional push uses ClientHub-wins LWW per Q12.

---

## Priority 18 — Feature 11: WhatsApp architecture document (NOT implementation)
**Estimated: 1 agent-hour**
**Dependency:** none
**Reason:** Pure planning artifact. The whatsapp_messages migration text + plan can sit in the doc and migrate to migration 33+ when API access is granted. Worth doing now so the schema decision is locked.

---

## Priority 19 — Feature 8: Shared Business Portal — DEFERRED
**Estimated: deferred**
**Dependency:** SaaS pivot
**Reason:** Per Q17 and Q32, Feature 8 is not implemented in this batch. The org/shared-data model it would have built is now absorbed by [PHASE6_SAAS_PIVOT.md §2-3](PHASE6_SAAS_PIVOT.md) (orgs, members, shared clients/inventory inside the same org). Keep the original Feature 8 plan in PHASE3 as historical reference; it is superseded.

---

## Priority 20 — SaaS Pivot
**Estimated: ~190 agent-hours** (see [PHASE6_SAAS_PIVOT.md §12](PHASE6_SAAS_PIVOT.md))
**Dependency:** all of P1-P18 above
**Reason:** The commercial product. Hosted server in Lockport IL, account system, org model with Owner/Sales Rep/Viewer roles, multiple SMTP profiles per user, settings redesign, Google Sheets API v4 OAuth, Stripe webhook activation, migration tooling from current desktop installs.

---

## Cumulative timeline (sequential, revised)

| Stage | Items | Cumulative hours |
|---|---|---|
| Bugs | P1-P4 | 5.5 |
| Bundled small fixes | P4.5 | 9.5 |
| Quick wins (revenue + polish) | P5-P9 | 30 |
| Productivity batch | P10-P14 | 52 |
| Automation & integration | P15-P17 | 75 (Sheets bumped to 12 h) |
| Planning artifacts | P18 | 76 |
| **Current-arch total** | **P1-P18** | **~76 h** |
| **SaaS pivot** | P20 | **~266 h total** |

If parallelization is possible: P1-P4.5 must be serial (different bug surface areas but small enough that one agent does all). P5-P14 can be parallelized in pairs since they touch different files (e.g. P9 invoice PDF + P10 bulk actions touch disjoint code). The SaaS pivot's sub-phases (PHASE6 §12) can be parallelized once the server stand-up is complete.

---

## Items NOT in this list

These were considered and explicitly de-prioritized or are external to ClientHub:

- **PowerShell→Bash migration for Pi tooling**: out of scope, the Pi is already Linux.
- **`users` table sync bug**: bundled into Bug 1 fix (Priority 3).
- **Version mismatch (Cargo.toml 0.7.2 vs package.json 0.11.0)**: a one-line fix bundled with the next release.
- **ARCHITECTURE.md update**: bundled with the next release after this batch ships. The doc needs a full rewrite to reflect 28 migrations, not 7.
- **Removing unregistered Tauri commands `customer_health_scores`/`get_customer_health`**: either implement them or remove from api.ts. Bundle with Bug fixes (P1-P4).
- **Globe view's CDN dependency on unpkg.com**: cache the texture assets to disk on first load. Nice-to-have, not blocking.
- **Multi-page invoice PDF support**: rolled into Feature 3 (Priority 9).
- **Mobile app, route optimization**: explicitly out of scope per the user.
- **Manifest analyzer PDF support**: external tech to be integrated; the integration point (a `parse_manifest_pdf(path) -> ParsedRows` trait the manifest module would call) needs to be designed but not implemented today. ~1 agent-hour of planning, parked.
