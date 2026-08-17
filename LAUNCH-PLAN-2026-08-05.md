# Launch plan — App Store mobile + store-grade desktop + infrastructure

Written 2026-08-05 (R-122). Apple Developer account purchased today, approval pending.
Companion documents: `NATIVE-APP-SPEC.md` (the full 1,723-line executable spec for the iOS/Android shell — this plan sequences it, it does not repeat it), `FINANCIALS-AUDIT-2026-08-04.md`, `INVENTORY-AUDIT-2026-08-04.md`, `PARITY-AUDIT-2026-07-26.md`.

---

## Part 1 — Verification: the last 2 days of agent work

Checked against git (both repos), the droplet (checksums over ssh), and the request ledger. Ground truth as of 2026-08-05 ~19:00 UTC.

| Work | Status | Evidence |
|---|---|---|
| Deal closed date = buyer payment date (R-117) | **Shipped** | v0.15.128 + deploy-34 |
| Refunds drawer + refund_done re-check (R-118) | **Shipped** | v0.15.128 |
| Link-financials full-screen picker + overpay confirm (R-115/116) | **Shipped** | v0.15.128 |
| Mobile hub search covers sections/settings (R-119) | **Shipped** | deploy-34 |
| Pending-churn vanish fix + $48,650 recovery | **Shipped** | v0.15.126; money verified recovered |
| Financials round 3 (4 money bugs) + ledger-vs-bank mismatch alarm | **Committed, unreleased** | commits `7c1030e`…`602fc49`, awaiting v0.15.129 |
| Sync durability round (dead-letter surfacing, settings restore, manual balance) | **Committed, unreleased** | `ff5dd30`…`d601cfd`, awaiting v0.15.129 |
| Manifest analyzer drag-drop + xlsx/pdf + AI fallback (R-120) | **Committed, unreleased** | `3afbb6f`, pushed |
| FOB locations + storefront US map + light storefront (R-121) | **Desktop shipped in v0.15.129; server committed + pushed, NOT deployed** | Desktop `200adbb`; server `b3cd8e7` (`storefront.rs`, `www/shop.html`, `www/app.js`, `www/sw.js`). Tree is clean in both repos. **The map is not on the live store**: droplet `www/shop.html` is still Jul 21 and `src/routes/storefront.rs` still Jul 25 (probed 2026-08-05 ~18:50), and droplet `www/app.js` is Aug 5 15:53, so the mobile FOB control isn't live either. Needs one narrow `storefront.rs` + `www/` deploy. |
| Server deadlock fixes (11 sites, `f130257`) | **DEPLOYED — verified today** | all five fixed files md5-match the droplet; binary rebuilt 2026-08-05 16:22 UTC. (Earlier notes saying "not deployed" were stale.) |
| WhatsApp auto-pull (R-012) | **Paused deliberately** by Jack — needs planning session. Server half live, desktop screen not built. Not a loose end; a decision. |
| Sold lots still on storefront (R-014 / INV-2) | **Outstanding** — 8 lots Jack marked sold are still live on the store/website; needs a one-off backfill. The button itself was fixed in v0.15.128. |
| BJM marketing website | Built, **not deployed** to Vercel. Separate track. |

**Verdict: nothing from the last 2 days was dropped.** One thing is open by design (R-012, paused by Jack).

**The tie-off release is cut.** `v0.15.129` was tagged and pushed 2026-08-05 ~18:40 UTC (`c8abca3`), and CI is building the installers. It carries **nine** commits beyond `v0.15.128`, not just the two its title names — financials round 3 (`7c1030e`…`602fc49`), the sync-durability round (`ff5dd30`…`d601cfd`), the manifest analyzer (`3afbb6f`), and FOB locations (`200adbb`). Worth stating plainly because **money and sync fixes are auto-updating to every install under a release titled about locations and manifests.** Verified before tagging: 39 desktop tests, 34 server tests, clean `npm run build`, no stubs left in any of it.

**Still to do:** one narrow server deploy (`storefront.rs` + `www/`) to put the storefront map live, and INV-2's backfill of the 8 sold-but-listed lots.

---

## Part 2 — Where each platform stands today

- **Desktop (Windows + Mac)** — Tauri 2.11.1, universal-mac + Windows builds from `release.yml` on every `v*` tag, working auto-updater (minisign, GitHub Releases `latest.json`). **macOS is ad-hoc signed, not notarized** — users bypass Gatekeeper by hand (documented in DEPLOY.md). **Windows is unsigned** — SmartScreen warns. This is the gap the new Apple account closes.
- **Mobile** — a PWA served from the droplet (`www/app.js`). No store presence. The complete plan to wrap it natively is `NATIVE-APP-SPEC.md`: Capacitor shell in a sibling repo `ecliptr-mobile/`, bundled (never remote-loaded) web code, Bearer-auth conversion, camera + biometric + offline cache as the Guideline 4.2 answer.
- **Server** — one DigitalOcean droplet (161.35.106.143): 1 vCPU, 1 GB RAM (470 MB available), 24 GB disk at 55%, DB 170 MB, data dir 3.2 GB, load ~0.1, service healthy, 41 days uptime. Deployed by manual matched-set scp; the CI auto-deploy workflow exists but stays off (correctly — it would rsync `plaid.rs`). Nightly encrypted off-site backup is live.

---

## Part 3 — Workstream A: land what's built (this week, no Apple dependency)

1. ~~Let the R-121 session finish~~ **DONE 2026-08-05 ~18:40** — both repos clean and pushed. Two product decisions it flagged remain yours: storefront accent is `#ffffff` (invisible on the new light storefront — pick a colour or accept the orange fallback), and storefront title is "AVAILABLE LOTS" in caps (against the sentence-case rule).
2. ~~Cut v0.15.129~~ **DONE — tagged `c8abca3`, CI building installers.** Verified before tagging: 39 desktop + 34 server tests, clean build, diffed against v0.15.128.
3. **Deploy the server side of R-121** (matched set: `www/` + `storefront.rs`; never `plaid.rs`, never `main.rs`/`routes/mod.rs`). Awaiting your go — deploys are confirmation-gated. Until then the FOB map and mobile location control are not live.
4. **INV-2 backfill** — take the 8 already-marked-sold lots off the live store (review-and-confirm, backup first).
5. **Housekeeping for the release pipeline** (15 min, prevents future confusion): align `Cargo.toml` (0.14.0) and `package.json` (0.14.1) versions with `tauri.conf.json`; delete or replace the stale `tauri.key.pub` in the repo root — it is a *different keypair* than the live updater pubkey in `tauri.conf.json` (`ED79…`), and the day someone "fixes" the config to match it, auto-update bricks for every install.
6. **Disarm `clienthub-api/.github/workflows/deploy.yml`.** It triggers on any push touching `src/**` or `www/**` and rsyncs the **entire repo** to the droplet — including `plaid.rs` — then rebuilds and restarts. It is currently inert (verified: a `storefront.rs` push today did not fire it), but it is one settings/secret change away from silently activating the third `bank_txn` writer. Delete the file (it stays in git history) or gate it to `workflow_dispatch` only.
7. **Give the BJM website repo a remote.** 55 paths are committed locally (`3b54b9b` — sell funnel, marketplace, admin, Prisma migrations) with **no git remote**: the site exists on one disk only. Create the GitHub repo, push, then decide the Vercel deploy.
8. Noted for later, not this week: white-on-orange button text is **2.94:1 contrast, below WCAG AA**, and it's brand-wide (`--c-on-accent`), not storefront-specific. Worth one deliberate token pass before the public App Store listing — accessibility complaints are review-adjacent.

---

## Part 4 — Workstream B: store-grade desktop (starts the day Apple approval lands)

The goal for desktop is **not** the Mac App Store. It is Developer ID signing + notarization, keeping your existing GitHub-Releases + auto-updater channel.

**Why not the Mac App Store:** MAS requires the App Sandbox, which fights this app's embedded WhatsApp-Web webview, local SQLite in app-data, and keyring usage — weeks of entitlement work for zero distribution gain (your users are your own team + invited orgs, and MAS review would re-litigate the finance content every update). Notarized Developer ID gives the same "no scary warnings" install experience without any of that. Revisit MAS only if Ecliptr goes mass-market self-serve.

Steps (≈1 day of work once the account is approved):

1. In the developer portal: create a **Developer ID Application** certificate. Export as `.p12`.
2. Add GitHub secrets to the desktop repo: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`. Tauri v2 / tauri-action natively picks these up: imports the cert into a temp keychain, signs, submits to notarytool, staples.
3. Edit `release.yml`: **remove the ad-hoc step** (`APPLE_SIGNING_IDENTITY=-` would override the real cert) and pass the new env vars into the tauri-action step.
4. Add a minimal hardened-runtime entitlements file only if the first notarized build demands one (none exists today; Tauri defaults usually suffice — WKWebView and network client are fine unentitled).
5. Windows signing — decide separately (see Decisions). Options: Azure Trusted Signing (~$10/mo, cheapest if eligible), an OV cert (~$200–400/yr), or stay unsigned for now (SmartScreen warning remains; acceptable while every Windows user is you/your team, not acceptable for public downloads).
6. **Verify the update path across the signing change**: install the current ad-hoc build on the Mac, release the notarized build, confirm auto-update applies and launches. The Tauri updater verifies its own minisign signature (unchanged), so this should be seamless; the one expected side effect is macOS keychain re-prompt(s) because the app's code signature changed — approve once, do not rename the keyring service (standing rule).

Also in this workstream: `DEPLOY.md`'s "bypass Gatekeeper" instructions become obsolete — rewrite that section when the first notarized build ships.

---

## Part 5 — Workstream C: the App Store mobile app

`NATIVE-APP-SPEC.md` is the build guide — verified against the code two days ago, with exact file/line edits. Sequence and adjustments:

### What changed since the spec was written (research 2026-08-05)
- **Capacitor 8 is current** (spec says 7). Use 8: new-project defaults are SPM on iOS (CocoaPods still fine) and it pairs with `@capgo/capacitor-updater` v8 for OTA. The spec's plugin choices all remain valid; re-check `minSdkVersion` guidance against Capacitor 8 defaults during N2.
- Review guidelines: no 2026 changes to 4.2 / 2.5.2 / 5.1.1(v). Privacy manifests still enforced at upload. One 2026 addition worth noting in the privacy answers: disclose any data sent to third-party AI providers — the manifest-analyzer AI fallback is **desktop-only**, so the mobile app sends nothing to AI; say so if asked.
- Apple individual enrolment: typically 1–3 days, but 2026 has widespread reports of enrolments stuck "processing" for weeks. If yours passes ~1 week, contact Apple developer support rather than waiting.

### Phase order (spec §9, annotated with what gates what)

**Now, while waiting for Apple — no Mac, no account needed (1–2 weeks of work):**
- **N0 — server unblock**: the CORS layer in `main.rs` (spec §3.1) + three server strings. Deploy caveat resolved: deploys are manual matched-set scp, CI stays off — so the CORS change ships like any other server change.
- **N1 — dual-mode auth in `app.js`**: `IS_NATIVE` / `API_BASE` / Bearer + refresh, the six bypass call-sites, `mediaUrl` hoist, service-worker gate. The regression that matters is the browser PWA staying byte-identical in behaviour — it's 100% of current users.
- **N2 — the shell exists**: create `ecliptr-mobile/` sibling repo, sync + compliance-gate scripts, `cap add android`, and prove first boot on a real Android phone against the live API. **This milestone validates all the risky plumbing from Windows.**
- **N3 — camera** (the 4.2 flagship; server endpoint already exists), **N4 — compliance** (purchase-surface gating, account deletion incl. sole-admin branch, privacy/terms routes), **N5 — biometric lock + Keychain token** (+ lengthen session in the same release).

**Once Apple approval lands (needs a Mac with Xcode):**
- **N6 — iOS platform**: `cap add ios`, icons/splash (1024 icon must have no alpha), `Info.plist` purpose strings, `PrivacyInfo.xcprivacy`, first archive to App Store Connect. Register App ID `app.ecliptr.mobile` (or your chosen bundle ID — permanent, decide once) with Push + Associated Domains capabilities even though push ships later.
- **N7 — offline read cache** (after the boot-cached-globals fix), **N8 — navigation stack** (Android back + prerequisite for push/deep links), **N9 — OTA channel wired before first submission** (retrofitting later costs a review cycle; also changes your shipping runbook — every mobile change = push to main *and* cut an OTA bundle).
- **N11 — TestFlight**: internal testing immediately; external TestFlight needs one light review. **Recommendation: treat TestFlight as the launch channel for the first 4–6 weeks** — up to 10,000 users, dramatically less Guideline-4.2 pressure, updates in hours — then submit to the public App Store once camera/biometric/offline are polished and screenshots are real.
- **N10 — deep links, then push** (post-launch: push needs the `reqwest` http2 rebuild server-side and the mobile offers surface; do not start push before the navigation stack).

**Android/Play:** build the Android shell first regardless (it's the Windows-verifiable platform), but **defer the Play listing** unless you want it — a personal Play account still requires 12 testers × 14 continuous days of closed testing before production (confirmed still in force 2026). If Play matters, start that clock early with your team as testers.

### The demo account and review assets
Before first submission you need (spec §10): a support URL, a privacy-policy URL and Play delete-account URL (two static routes on the server), the demo org decision, App Store screenshots (take them after N3 so camera shows), category **Business**, and the review-notes paragraph (spec §6.9) explaining Ecliptr is a B2B tool where users manage their *own* business's data — this also pre-empts any finance-app question about the Plaid-sourced transaction display.

### Timeline (realistic, part-time agent-driven)
- Week 1–2: N0–N5 complete, Android debug build in daily use. Apple approval lands in parallel.
- Week 3: N6 first archive + TestFlight internal. N7–N9.
- Week 4–5: TestFlight external + real-world hardening, screenshots, store copy.
- Week 6: public App Store submission. Budget 2–3 review rounds (1–2 weeks).

---

## Part 6 — Workstream D: parity across all systems

"Full parity" splits into two honest layers:

1. **Store-app v1 = the PWA's current capability + native capabilities.** The shell bundles the same `app.js` the phone browser gets, so mobile-web and mobile-app never diverge (one OTA bundle = one web push). This level of parity is *automatic* by architecture.
2. **Mobile ≠ desktop parity is a known, catalogued gap** and is *not* a launch blocker — but it is the post-launch roadmap, in this order (from the ledger):
   - R-001 mobile financials (largest gap — zero bank screens on the phone; also unlocks recording payments, R-009)
   - R-010 reopen completed deals from mobile
   - Mobile offers surface (prereq for the best push trigger)
   - R-121 mobile parity for the location field (city/state picker is specced for both surfaces — verify it landed on mobile)
   - Manifest analyzer on mobile (explicitly deferred in R-120)
   - The remaining PARITY-AUDIT items (mobile REST writes bypassing the oplog is the structural root — any new mobile write surface must respect it)

Post-launch, OTA makes parity shipping cheap: web + store app update together in hours.

---

## Part 7 — Workstream E: infrastructure decision

**Recommendation: one droplet resize + turn on provider snapshots. Nothing else changes.**

Reasoning from today's measurements (1 vCPU / 1 GB / 24 GB, load ~0.1, 470 MB RAM available, DB 170 MB):

- **CPU/RAM are fine for serving** — the API is Rust + SQLite serving a handful of orgs; the App Store launch does not change traffic materially (TestFlight ≤ your team + invited users).
- **But 1 GB is already the constraint for everything you want next**: on-droplet `cargo build --release` (every deploy) is slow and swap-bound at 1 GB; the push-notification senders (APNs/FCM + the `h2` rebuild), the paused WhatsApp/Baileys client (R-012 explicitly noted only ~490 MB free), and OTA bundle serving all add resident memory.
- **Resize to 2 GB RAM / 2 vCPU (~$18/mo, or 2 GB/1 vCPU at $12/mo)** — a CPU+RAM-only resize on DO is reversible and takes ~1 minute of downtime; do it in the same window as the next server deploy. This also picks up 41 days of pending kernel patches via the reboot.
- **Turn on DigitalOcean weekly snapshots/backups** (+20% of droplet cost, ~$2–4/mo) as the disaster-recovery layer *under* the existing nightly encrypted off-site DB backup — snapshots cover the machine config (nginx, systemd, certs), which the DB backup does not.
- **Keep SQLite.** 170 MB, single-writer workload, WAL — a managed Postgres would add cost, latency, and a migration risk for zero benefit at this scale. Revisit only at multi-hundred-org SaaS scale.
- **No CDN, no load balancer, no second region.** Storefront images and OTA bundles at this traffic level are trivially served by nginx.
- Optional, later: a $6 staging droplet once external users depend on the API enough that testing on production deploys feels scary. Not now.

Total infra delta: **≈ $8–16/month.** Everything else (domain, TLS, GitHub, backups) already works.

---

## Part 8 — Costs

| Item | Cost |
|---|---|
| Apple Developer Program | $99/yr (paid) |
| Google Play (if/when) | $25 once |
| Droplet resize 1 GB → 2 GB | +$6–12/mo |
| DO snapshots | +$2–4/mo |
| Capgo OTA (or self-host the updater endpoint) | $0–15/mo |
| Windows code signing (optional, decide later) | $0 / ~$10 mo (Azure) / ~$200–400 yr (OV cert) |
| Mac for iOS builds | needed for N6+ — the existing Mac + Xcode, or a one-time used Mac mini |

---

## Part 9 — Decisions Jack needs to make (everything blocked on you, in one list)

1. **Bundle ID** — confirm `app.ecliptr.mobile` (permanent after first submission).
2. **TestFlight-first launch** (recommended above) vs straight to public App Store.
3. **Android/Play now or later** — the shell gets built either way; this is only about the listing and the 12×14 testing clock.
4. **Storefront accent + title** (from R-121: `#ffffff` accent invisible on light; "AVAILABLE LOTS" caps vs sentence-case rule).
5. **Demo account for Apple review** — a second admin in your real demo org, or a disposable reviewer org per submission.
6. **Approve the auth tradeoff** — the native shell moves from HttpOnly cookie to a Keychain-stored Bearer token (unavoidable; spec §3.2 states it fully), plus the longer session shipped together with the biometric lock.
7. **Windows signing** — Azure Trusted Signing / OV cert / stay unsigned for now.
8. **Droplet resize** — approve the ~$8–16/mo and I'll schedule it with the next deploy.
9. **Support URL** — `ecliptr.app/support` doesn't exist; a one-page route is enough.
10. **Mac access** — confirm which Mac does the N6 archive (your Mac with Xcode, or wire the existing mac CI runner to do it).
11. **Go/no-go on the narrow storefront deploy** (`storefront.rs` + `www/` — puts the FOB map live).
12. **Delete or keep the armed auto-deploy workflow** (Part 3 item 6 — recommendation: delete).
13. **BJM website** — approve creating its GitHub remote (it's currently unbacked-up on one disk) and whether to proceed to the Vercel deploy.

Everything in N0–N5 + Workstream A needs **no decision and no Apple approval** — that work can start immediately.
