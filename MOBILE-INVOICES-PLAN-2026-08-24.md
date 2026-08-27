# Mobile invoices, nav, return policy — plan (2026-08-24)

Covers R-196, R-197, R-198, R-199. Nothing here is built yet.

---

## R-198 — "invoices aren't sending on mobile" — SOLVED, and it isn't what it looked like

**They sent. All three were delivered.** Resend's own log, read from the droplet:

| Invoice | Sent (UTC) | To | From | Result |
|---|---|---|---|---|
| INV-0209 | 15:36:51 | lashdealz@gmail.com | BJM DISTRIBUTIONS \<no-reply@ecliptr.app\> | delivered |
| INV-0210 | 15:39:12 | mainvsb@gmail.com | BJM DISTRIBUTIONS \<no-reply@ecliptr.app\> | delivered |
| INV-0211 | 15:42:18 | jackjohnm7@gmail.com | BJM DISTRIBUTIONS \<no-reply@ecliptr.app\> | delivered |

### Why it looked dead

DigitalOcean blocks outbound SMTP (25/465/587) on the droplet, so every server-side send goes
over Resend's HTTPS API. Resend only has `ecliptr.app` verified, so mail leaves as
`no-reply@ecliptr.app` with `ben@bjmdistributions.com` demoted to Reply-To
(`clienthub-api/src/email.rs:219` `resend_target`; decision note
`decisions/server-mail-leaves-from-the-verified-platform-sender`).

Consequences you actually felt:

1. **No copy in your Sent folder.** It never touched your Gmail, so there is no outgoing record
   anywhere you look.
2. **No thread.** The customer's reply starts a new conversation instead of continuing yours.
3. **Spam risk.** An unfamiliar sending domain on an invoice is exactly what filters bury.
   INV-0211 was delivered to your own gmail — check Spam/Promotions to see it.
4. **Desktop behaves differently**, because desktop sends through your own Gmail with keyring
   credentials. That asymmetry is the whole illusion.

Side effect worth knowing: **INV-0209 and INV-0210 went out twice** — phone at 15:36/15:39,
desktop at 15:48. Those two buyers hold duplicate invoices.

### The fix, in three parts

**1. BCC the sender (code, ~30 lines).**
`resend_body` has no `bcc` field at all (`email.rs:244`). Add one, and have `resend_target`
populate it with the org's own `from_email`. Every server-sent invoice then drops a copy in your
mailbox — that is your Sent-folder substitute and your proof of send.

**2. Stop the UI implying it came from you (mobile).**
Today the toast says "Invoice emailed with PDF attached" and stops. It becomes explicit about
recipient and sender, and the invoice detail panel grows a permanent line:

> Sent 24 Aug, 11:42am to lashdealz@gmail.com · from no-reply@ecliptr.app

**3. Log the send server-side.**
`email_invoice` (`routes/invoices.rs:76`) currently logs nothing on success *or* failure — a
failed send is invisible in `journalctl`. Add `info!` on success and `warn!` on failure with the
invoice number and recipient. This is why the diagnosis needed Resend's API instead of our logs.

### Your part (I cannot do this — it is DNS)

Verify **bjmdistributions.com** in Resend. Add the DKIM/SPF records they give you to the domain's
DNS. Once verified, invoices leave as `ben@bjmdistributions.com` for real: right From, right
threading, no spam penalty. Until then the platform sender is the only thing that works — pointing
From at an unverified domain makes Resend 403 **every** server send, including signup verification.

Deploy: `email.rs` + `routes/invoices.rs` + `www/` (deploy-45 shape).

---

## R-196 — Invoices takes Inventory's slot in the mobile tab bar

Bottom bar today is Home / Clients / **Inventory** / Deals / Search
(`clienthub-api/www/index.html:139-160`).

- `index.html:148` — swap the Inventory button for Invoices (label + a document icon).
- `app.js:900` `MORE_TABS` — remove `'invoices'`, add `'inventory'`, so the Search tab stays
  highlighted while you're in Inventory and Invoices lights its own tab.
- `TAB_PERM` already has `invoices: 'deal_flow:view'` (`app.js:858`) — no permission work.
- Bump `app.js?v=115` → `116` (`index.html:169`). That moves the service-worker cache name and is
  what makes the deploy actually appear on your phone.

Inventory stays reachable — it is already listed twice in the Search hub (pinned six at
`app.js:1416`, Sourcing group at `:1443`).

---

## R-197 — the return-policy switches

### Desktop — already written, never shipped

A fix for exactly this is sitting **uncommitted** in your working tree:

- `ClauseSwitch` lifted to module scope. Declared inside `PolicyClauseCard` it was a new component
  type on every render, so React tore the button down and rebuilt it on each keystroke — the knob
  snapped instead of sliding and the control flickered while typing.
- The knob's hardcoded `bg-white` replaced with `on-accent` / `faint` plus a ring. A white knob is
  invisible on mono-dark's near-white accent, and invisible again when OFF, where it sits on a
  near-white track (1.05:1).
- Same treatment applied to the per-invoice toggle in `InvoicesView.tsx:757`.
- A new `OffWithText` warning: wording saved with the switch off renders nowhere, and nothing said
  so — both clauses sat filled-in and switched off while every invoice went out without them.

**It is written, not shipped.** You are running v0.16.6, which has none of it.

**Complication:** those hunks share `SettingsView.tsx` and `api.ts` with the unshipped R-195
Google-OAuth email build (~942 lines uncommitted across 10 files). Shipping the switches means
either releasing R-195 with them, or splitting the file. See the decision below.

### Mobile — the switch is worse, and the standing one doesn't exist

- The per-invoice control is a bare `<input type="checkbox">` (`app.js:5885`) while the app has its
  own `.switch` component used elsewhere. → convert it, and hide the wording box when off.
- `.switch-knob { background: #fff }` (`style.css:1509`) is the same hardcoded-white bug as
  desktop: in mono-dark the ON track (`--c-primary-solid`) is near-white, so the knob disappears.
  → token + ring.
- **There is no standing-clause editor on mobile at all.** `/api/settings/policy-clauses` is
  GET-only and deliberately so (`routes/settings.rs:387`) — clauses are edited on desktop and
  pushed via `/api/settings/shared`. So "activating the return policy" is literally impossible
  from your phone. Fixing that needs a PUT route + a Settings card on mobile.

---

## R-199 — mobile invoices screen redesign

Keeps every function. Changes how it reads and how the actions are reached.

**List (`renderInvoices` / `renderInvoiceList`, `app.js:5724-5843`)**
- The right-hand column currently stacks four things — amount, status badge, flow dots, profit —
  into a narrow rail. Amount becomes dominant; status becomes one chip; flow dots and profit move
  to a quiet second line so a row scans in one glance.
- Outstanding becomes the hero tile rather than one of three equals.
- Search + filter pills stay exactly as they are; they work.

**Detail panel (`showInvoiceDetail`, `app.js:6050-6215`)**
- The footer crams up to five equal buttons in one flex row — a `sent` invoice shows Mark Paid /
  View PDF / Resend / Fell through / Edit at roughly 60px each. This is the "function" complaint.
  → one full-width primary action, a secondary row, and the rest behind an overflow.
- Add the send-confirmation line from R-198.
- **"Send invoice" and "Mark sent" sit side by side and do completely different things** — one
  emails, one only stamps a date. Give "Mark sent" a hint line so it can't be mistaken for sending.
- Hero, line-items table, totals, Cost & Profit, Shipping, notes, return policy: unchanged.

---

## Order of work

1. R-198 code + R-196 nav + R-197 mobile + R-199 redesign — all `clienthub-api`, one deploy.
2. R-197 desktop — separate, needs a tagged release, blocked on the commit-split decision.
3. You: verify bjmdistributions.com in Resend.
