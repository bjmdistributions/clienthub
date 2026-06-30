# Ecliptr — Fix Plan & Checkdown

Process (agreed 2026-06-30): (1) keep ONE checkdown, restated every turn; (2) for each item,
read the real code and write the root cause + exact fix here; (3) a final check step before
"done"; (4) **every fix applied to BOTH desktop (BUSINESS APP) and web/mobile (clienthub-api/www)** —
parity is mandatory; (5) verify with measurement/preview, not assertion.

Legend: [ ] todo · [~] in progress · [x] done+verified · [?] needs your input

---

## CHECKDOWN (restate every turn)

### A. Design / readability (top priority — the bugs you keep hitting)
- [ ] A1. Matte/dark **low-contrast gray text** (faint/muted) — measured, root cause found (see below)
- [ ] A2. **Theme-blind hardcoded colors** — 130 found across 30 desktop components; triage + fix the genuine ones
- [ ] A3. Confirm the matte **accent-active** fix (v0.14.57) is actually on your installed build
- [ ] A4. Parity pass: same contrast audit on **web/mobile** (clienthub-api/www/style.css + app.js)

### B. Mobile parity (remaining features)
- [~] B1. **Payout config editor** — built this turn (server `/api/staff/payout-config` + mobile 3-section UI); needs your on-device test
- [ ] B2. Rep's **own earnings** on the mobile Weekly Brief
- [ ] B3. **Intake / web-forms config** on mobile

### C. Verification gaps (built but unconfirmed — your eyes/device)
- [ ] C1. Desktop v0.14.55–57 visual confirm (after auto-update installs)
- [ ] C2. Mobile refunds/credits, pending-review, payouts, payout-config on device
- [ ] C3. WhatsApp/OG: re-scrape via FB Sharing Debugger (or share ecliptr.app/?x=1)
- [ ] C4. Waitlist email → bjm.distributions@gmail.com (check inbox for the test)

### D. Decisions / ops (need your call)
- [?] D1. Delete the 8 test workspaces (needs your explicit "confirm delete")
- [?] D2. Eclipse-as-default theme + neutral retune
- [?] D3. Legal pages (Terms/Privacy real content)
- [?] D4. Retire Syncthing once server netsync confirmed
- [?] D5. Stripe billing (you said: last)

---

## DETAILED FIXES (from code)

### A1. Matte/dark low-contrast gray text  — ROOT CAUSE CONFIRMED (measured)
**Evidence** (computed contrast on the matte near-black bg, via the live dev app):
| token | value | contrast | verdict |
|---|---|---|---|
| `text-faint` (`--c-faint`) | #56565E | **2.89** | ❌ fails WCAG AA (4.5) — icons/placeholders barely visible |
| `text-muted` (`--c-muted`) | #7C7C84 | 5.07 | ⚠️ marginal |
| `text-ink-2` | #B6B6BE | 10.4 | ✓ |
| `bg-accent text-on-accent` (buttons) | #E8E8EC / #111 | ~16 | ✓ (accent buttons are actually fine) |

**Root cause:** `src/index.css` defines `--c-faint: 86 86 94` (#56565E) and `--c-muted: 124 124 132`
(#7C7C84) in the `html.dark` block (~line 143). The `html.matte` block (~line 168) overrides bg +
accent but NOT these text tokens, so on matte's pure-black bg they're too dark. (Accent *buttons*
were a red herring — they pair with `text-on-accent` correctly.)

**Fix:** raise `--c-faint` (and slightly `--c-muted`) so they clear AA on near-black. In `html.dark`
(covers dark AND matte): `--c-faint: 138 138 146` (#8A8A92 ≈ 5.0) — or 150/150/158 for comfort;
`--c-muted: 150 150 158` (#96969E ≈ 7). Optionally bump a touch more inside `html.matte` since its bg
is darker. Keep semantic success/warning/danger unchanged.

**Parity:** web/mobile `clienthub-api/www/style.css` dark theme `--c-text3` / `--c-text2` carry the
same risk — measure + bump there too.

**Verify:** re-run the contrast eval (target ≥4.5 for faint, ≥7 for muted) + render the Invoices view.

### A2. Theme-blind hardcoded colors (130 hits / 30 components)
**Scan (desktop):** top offenders — InventoryView (24), SettingsView (15), ClientsView (14),
CheckupView (10), DealFlowView (8), AuthView (7), InvoicesView (7), DealsView/EmailView/OnboardingWizard (4).
**Triage rule:**
- KEEP: semantic status colors (`*-amber-*`, `*-emerald-*`, `*-red-*`, `*-green-*`) used for
  warning/success/danger meaning — those are intentional and fine.
- FIX: theme-blind neutrals — `bg-gray-*`/`text-gray-*`/`border-gray-*`, `bg-white`/`bg-black`,
  and `text-white` used on non-accent surfaces. Replace with tokens: `bg-surface`/`bg-surface-2`/`bg-surface-3`,
  `text-ink`/`text-ink-2`/`text-muted`, `border-line`. (Same pattern already used to fix earlier toasts.)
**Approach:** one component per pass, highest-count first; measure/preview after each.

### B1. Payout config editor (built this turn)
Server: `GET/POST /api/staff/payout-config` (staff_api.rs) — mirrors desktop `save_payout_split`
(writes `profit_split_json` + back-fills legacy jack/ben/business; per-rep pay_type/commission_pct/hide;
`rep_payouts_enabled`). Mobile: More → Payouts → "Configure payout rules" → 3-section editor
(enable, per-rep pay, owner split auto-100%, live preview). Endpoints verified mounted/guarded (401/422).
**Open:** authenticated save couldn't be curl-tested (needs login) — verify on device; it's reversible.

(Remaining items B2/B3/C*/D* — to be detailed as we reach them.)
