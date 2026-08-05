# Mobile redesign, native feel, and the App Store — plan for approval

No code has been changed. This is the document to argue with before any work starts.

---

## 1. The honest situation

The mobile app today is a well-built web page: 6,759 lines of vanilla JavaScript that renders 21 screens, four of which get a tab and seventeen of which are buried behind a "More" list that is just a directory of section names with nothing actionable on it. It has real polish in places — pull-to-refresh, skeletons, an offline banner, a proper edge-swipe on detail panels — but the polish sits on top of an architecture that contradicts it. **The single biggest reason it doesn't feel like a real app: there is no navigation history at all** — zero uses of the browser's back mechanism anywhere in the codebase — so on Android the hardware back button *quits the app* from any screen, the iPhone edge-swipe does nothing on most screens, scroll position is thrown away on every tap, and opening an invoice from inside a client destroys the client screen underneath it. Everything else that feels "webby" (490 KB of uncompressed JavaScript on every cold start, 23 native `ecliptr.app says…` browser alerts, whole-screen rebuilds after every button press, list rows that give no press feedback on iPhone) is fixable in days; the history problem is the one that is structural. Separately and more urgently: the two most valuable things a phone can do in this business — **photograph a lot in a warehouse** and **record that a buyer paid** — are not possible on mobile at all today, while four of the five tab slots are spent on lists you browse.

---

## 2. The App Store answer

### Can it go on the App Store?

Not as it stands. Two hard blockers, one soft one, and one piece of unexpectedly good news.

**Blocker 1 — Guideline 4.2, "minimum functionality."** Apple rejects apps that are a website in a wrapper. Right now the mobile app touches almost nothing the phone can do: copy-to-clipboard, `tel:`/`mailto:` links, and one file picker for your profile photo. No camera, no notifications, no offline, no biometrics. There is currently **nothing to defend** if a reviewer asks "why is this an app and not a website?" The fix is not cosmetic — it's building the native capabilities, which are the same ones that make it genuinely better in the field.

**Blocker 2 — Guideline 2.5.2.** The app must ship its screens inside the download, not load them from your server at runtime. This is a packaging change, not a rewrite.

**Blocker 3 (soft, but this is the one you can't skip thinking about) — Guideline 3.1.1, in-app purchase.** Ecliptr sells Pro at $39/mo and Business at $99/mo, and those plans unlock features *inside* the app. Apple's rule: if a subscription unlocks features inside your iOS app, it must be sold through Apple, and **Apple takes 15% under the Small Business Program** (30% if you ever exceed $1M/yr). There is a standard, legal way around it, used by Slack, Notion, Linear, Basecamp: **the iOS app has no purchase surface at all.** No pricing page, no "upgrade" button, no link to /pricing, no upsell copy anywhere in the app. People upgrade on the web; the app just reflects what they're entitled to. Since your server already enforces plan limits, this costs you nothing in engineering — it's a scrub of the mobile UI.

**Two things worth knowing about 3.1.1 specifically:**

- Your *actual* business — the 1% fee on invoice payments — is completely safe from Apple. Physical goods and services consumed outside the app are explicitly excluded from IAP, and Apple is actually *prohibited* from taking a cut of that. This is important and often misunderstood.
- **Everything is free during your beta.** An app submitted today is genuinely a free app with nothing purchasable in it. That is the cleanest possible position with Apple, and it evaporates the day you turn paid plans on. If you ever want to add real in-app purchase later, budget 3–4 weeks: Apple's payment framework, receipt validation, and reconciling "I paid Apple on my iPhone" with "I expect it on my desktop." That is not v1 work.

**The good news, which is better than I expected:** four things that usually sink this kind of project are already done. Your server already accepts token-based login (the thing that normally breaks first inside an app wrapper). Account deletion — which Apple *requires* — already exists as a real endpoint with a full data purge. Your build system already runs on Mac machines, so no Mac purchase is strictly required to produce builds. And you already run a demo workspace, which is exactly what Apple asks you to hand a reviewer.

### What it actually takes

Wrap the existing mobile app with **Capacitor** — a standard tool that puts your existing files inside a real iOS app and gives JavaScript access to the camera, notifications, Face ID, and offline storage. No rewrite, no framework migration, and the same code keeps serving the browser PWA. First boot on a real iPhone is roughly a day of work. The months are in the native capabilities and the correctness work, not the wrapper.

I considered and reject two alternatives:
- **Tauri Mobile with the desktop app.** Tempting ("one codebase, full parity") and wrong. It would put a second database and a second sync engine on phones — exactly the divergence the parity audit exists to kill — and the desktop UI is built for a 1280px window, so it's a full redesign of 57 screens wearing a costume.
- **A native rewrite from scratch.** Six months minimum, and it throws away every parity fix in the current mobile code. Capacitor doesn't block this later — you can replace individual screens with native ones over time.

### Timeline, honestly

Nothing ships in days.

- **TestFlight (your team and buyers install a real app on their phones): about 4–5 weeks.**
- **Public App Store v1.0: about 10–14 weeks, budgeting 2–3 review rounds.**

Two lead times start the clock and cost nothing to begin today: **Apple Developer Program enrollment** ($99/yr; as an individual it's often same-day, as *BJM Distributions LLC* it needs a D-U-N-S number and takes 1–3 weeks of pure waiting), and registering the app's permanent identifier.

**One workflow change you should hear now:** today you ship the mobile app several times a day by copying a file to the server. Inside an App Store app, a change waits 24–48 hours for Apple review. There is a legitimate mechanism (live JavaScript updates, explicitly permitted as long as you don't change what the app is for) and it must be set up *before* the first submission, or the store version falls behind the web version within a week.

### The decision you must make

**How much does "on the App Store" mean "discoverable in App Store search" versus "a polished native app my people can install"?**

If it's the second, **TestFlight is a fully viable permanent channel** — up to 10,000 people, one light review, installs in weeks not months, and dramatically less pressure from Guideline 4.2. Apple also runs a private distribution channel for business tools where a narrow audience is expected rather than penalized. If it's the first, we do the full public path, and the 4.2 work is non-negotiable.

My recommendation: **build toward the public listing but ship to TestFlight at week 5 and live on it.** You get the app on phones a month from now and the public submission stops being a deadline.

---

## 3. The new navigation

Your complaint — "I hate when I click more it's just a list of different sections" — is correct and it's a structural problem, not a styling one. Seventeen of twenty-one screens are only reachable through that list. Every row on it is bare text: no icon, no count, no state. There is nothing on that screen telling you *whether you need to go there*, so you re-read it every single time.

### The principle

**A tab is a place you return to, not a task you complete.** Everything else is reached by searching for it, by acting on a record, or from an actionable card on Home — never by reading a directory.

### Before

```
┌─────────────────────────────────────────┐
│  Home  │ Clients │ Invoices │ Flows │ More │
└─────────────────────────────────────────┘
                                        │
                            ┌───────────▼────────────┐
                            │ Checkup                │
                            │ CLIENTS                │
                            │   Client tiers         │
                            │   Web forms            │
                            │   Team                 │
                            │ SOURCING               │
                            │   Suppliers            │
                            │   Inventory            │
                            │ SALES                  │
                            │   Quotes               │
                            │   Deals                │
                            │ MONEY                  │
                            │   Receivables          │
                            │   Payables             │
                            │   Payouts              │
                            │ COMMS                  │
                            │   Newsletters          │
                            │   Weekly brief         │
                            │ INSIGHTS               │
                            │   Analytics            │
                            │ UTILITY                │
                            │   Notes                │
                            │   Archive              │
                            │   Refer & earn         │
                            │   Settings         ←── last row,
                            │ YOU                     after 1.7
                            │   My account            screens of
                            │ HELP                    scrolling
                            │   Setup guides         │
                            │   Send feedback        │
                            │   Sign out             │
                            └────────────────────────┘
```

### After

```
┌──────────────────────────────────────────────────┐
│  Home  │ Clients │ Inventory │ Deals │ Search     │
└──────────────────────────────────────────────────┘
   │         │          │          │         │
   │         │          │          │         └─ type a name  → the client / lot /
   │         │          │          │            invoice itself, one tap
   │         │          │          │            type nothing → Pinned · Recent ·
   │         │          │          │            All sections (each with a live
   │         │          │          │            count or dollar figure)
   │         │          │          │
   │         │          │          └─ [ Pipeline · Invoices · Money · Done ]
   │         │          │             one money spine, remembers where you were
   │         │          │
   │         │          └─ lots, photos, prices. Camera is a first-class action.
   │         │
   │         └─ [ All · Hot · Tiers · Checkup ]   (kills 2 More rows)
   │
   └─ Needs you (counts with money attached, each taps into the fix)
      Quick actions: Photograph a lot · Log a call · New invoice
      Recently viewed · chart · notes

Top-left of the header, on every screen:  ⌾ your avatar → Settings & account
```

### Why each choice, in terms of your day

**Inventory gets promoted to a tab.** It's the product you sell, it's the answer to the question buyers ask most on the phone ("what's your price on that lot?"), and it's the one screen a laptop *physically cannot replace* because it needs a camera. Today it costs two taps and a scroll past two headings.

**Flows + Invoices + Receivables + Payables + Completed merge into one "Deals" tab** with a segmented strip across the top. They are the same object at four stages of its life, and splitting them across one tab and four More rows is why you currently have a "Flows" tab and a separate "Deals" screen that are different things. It remembers the last segment you used, so after the first session Invoices is effectively still one tap.

*The one tradeoff I want to name:* Invoices goes from one tap to two on the very first open of a session. It buys back a tap and a scroll on Inventory, Quotes, Suppliers and Receivables — all more urgent in the field. If you'd rather not move Invoices, the alternative is `Home · Clients · Inventory · Invoices · Search` with the pipeline folded in as an Invoices segment. Same structure, opposite default. Tell me which.

**"More" is replaced by Search.** Empty state shows: 4–6 tiles you pin yourself, the last 8 records you touched, and then all remaining sections as tiles that **each carry a live number** — "Receivables · 14 · $82,400", "Approvals · 3", "Quotes · 6 open". A count is a reason to tap. A bare label isn't. That difference is the whole fix. Start typing and it becomes one mixed result list — clients, invoices, lots, deals, suppliers, quotes together. Later, typing a verb ("new invoice", "mark paid") runs the command directly, which is the desktop's command palette on a phone. *This needs one new thing on the server: a single search endpoint. The desktop already has the exact query; nothing equivalent exists server-side today.*

**Home becomes a hub, not a link grid.** "Needs you" moves above the chart, and every row is a count with money attached that taps straight to the record with the action already primed — overdue invoices and their total, approvals waiting, follow-ups due, invoices missing shipping, stuck deals, at-risk customers. Most of that is already computed on the server for the weekly brief and simply ignored by Home. The three quick-action chips change from "New client · New invoice · Compose" to **"Photograph a lot · Log a call · New invoice"** — "Compose" is a desk job occupying the most valuable row on the phone.

**Settings moves to the avatar in the top-left corner, reachable from anywhere in one tap** — instead of More, scroll to the last row, tap.

**Actions hang off records, not off sections.** Most "desktop features" are things you do *to* a record. On a client: new invoice, new quote, record payment, log call, view their AR. On a lot: add photo, share to WhatsApp, create a quote from it, post to storefront. On a deal card: mark supplier paid, record buyer payment, refund, reopen. This is what collapses the deep paths, and it's also the honest mechanism for parity.

### What this does to real tasks

| Task | Today | After |
|---|---|---|
| Photograph a lot | impossible | 2 taps |
| Record that a buyer paid | impossible | 3 taps (2 via search) |
| Price a lot on a call | 3 + scroll | 2 |
| Log a call after hanging up | 4 | 2 |
| What am I owed | 2 + scroll (and read-only) | 1 from Home |
| Any settings screen | 2 + two long scrolls | 2, from anywhere |
| Any tail section | 2 + scroll 21 rows | 2, or 1 if pinned |
| Go back to the previous screen | impossible | back gesture |

---

## 4. The new Settings

Desktop has 24 settings sections. Mobile has 7, plus two more (My account, Team) living outside Settings entirely. Of the 24: **13 must be on mobile, 6 are splits** (configure on desktop, use or check status on mobile), **6 are genuinely desktop-only** — and saying so plainly in a one-line row is better than an empty screen.

Settings stops being one long scroll of cards and becomes **a list of rows with a search box pinned at the top**. Every row shows its current value on the right, so you can read the whole list without opening anything: "Company · BJM Distributions", "Email · jack@…", "Team · 3 people", "Banks · 2 connected, synced 4m ago". Each row opens a full screen, and each of those screens is a real destination the app knows about — which matters, because today a sync or a pull-to-refresh on certain screens silently throws you back to where you were before.

**The groups:**

1. **You** — Name & photo · Appearance · Notifications · Your plan
2. **Your business** — Company details & logo · Payment methods · Invoices & quotes (numbering, which payment methods print) · Storefront link
3. **Sending** — Email account · Signature & sign-off · Newsletter template · WhatsApp message · Saved line items
4. **People & money** — Team, roles & invites · Approvals · Profit split · Rep payouts
5. **Connections** — Banks · Google Sheets · Web forms · Lead forms · Shopify · Facebook · Stripe. Each row carries a small state pill: Connected / Not set up / Set up on desktop.
6. **Data & safety** — Sync status & event log · Backups · Export · Sign out · Delete account

Groups 1–3 are the daily surface. Group 6 is last and holds everything destructive behind one confirmation — nothing destructive ever sits inline next to a field. Inside any screen: five fields visible maximum, everything else behind one "Advanced" toggle (the app already has that pattern; it just needs generalizing).

**How search works.** The index is a flat list of about 40 rows, each with hidden keywords. Type "sig" → one result: "Signature & sign-off", subtitle "Sending". Type "bank" → "Banks", under Connections. The keywords mean "footer", "sign off", "my name at the bottom" all find the same row even though none of those words is its title.

**Three specific notes:**

- **WhatsApp's message template is a desktop-only setting today.** WhatsApp is used *from the phone*. That's the most embarrassing gap in the list.
- **There is no email signature field anywhere in the product**, on either platform. The nearest things are the SMTP "from name" and the newsletter template's closing paragraph. Adding a real signature and appending it to quote, invoice and newsletter sends is small and highly visible.
- **"Connect a bank" should stay desktop-only, deliberately.** Bank connection needs Apple's own browser handoff to work at all, and a second connection path would create a third source of bank transactions — which is precisely the bug that produced 548 duplicate rows in your database. The Banks screen on mobile shows what's linked, when it last synced, and how many transactions are waiting for review, then says adding a bank happens on desktop. What mobile *should* own is reviewing and allocating those transactions, which is genuine between-stops work, and that belongs in the money spine, not in Settings.

---

## 5. Feature parity

The two audits together contain 191 findings. They don't need re-listing; here is what they actually are, by theme, and how they fold into this plan.

**Theme 1 — mobile writes destroy desktop data (the P0 class).** Narrow mobile forms plus full-column server writes meant mobile saved empty values over fields it never showed, and that synced to every desktop. Supplier payment details, company tax ID and logo, the "kept" cut flag, custom-priced lots reset to $0. **Round 0 shipped and stopped the bleeding.** What remains is a go/no-go on repairing data already damaged (see decision 8 below). *This class is a hard release blocker for the App Store — once you're behind a 48-hour review queue you can no longer hot-patch a bug that is silently deleting data.*

**Theme 2 — the same number, computed differently in two places.** Outstanding, profit, tier thresholds, the brief headline, month-over-month deltas. Six of the seven open decisions are in this theme. Every one of them changes a figure you read daily, which is why they're decisions and not fixes.

**Theme 3 — the server sends mobile less than desktop gets.** Missing client names, missing timestamps, missing refund figures. Server-only, deploys instantly to every phone with no app release, and kills roughly ten mobile findings before a line of mobile code changes. Round 1 shipped.

**Theme 4 — endpoints that exist and mobile simply never calls.** The highest work-unblocked per line of code in the whole audit. The photo upload is the flagship: `POST /api/inventory/:id/photo/:name` has been live and open to any team member for months, and the mobile lot form has ten fields and no photo input.

**Theme 5 — actions that exist on desktop and have no path on mobile.** Record a buyer payment, mark an invoice paid from Receivables, refunds, reopen a deal, share to WhatsApp, send a quote from a lot. Most of these don't need new screens — they need to hang off the record, which section 3 handles.

**Theme 6 — nine gaps that need a new server route before any mobile screen can exist.** These get batched together rather than trickled.

**Theme 7 — layout and cosmetics.** Two have real bite: the client tier grid has been visibly broken since the Platinum release, and the send-safety flags (blacklisted, no-bulk, unsubscribed) are being cut off inside the client name and effectively invisible.

### The refund fix, specifically — this is your live complaint

Desktop deliberately pulls **any deal with refund activity out of the active pipeline entirely** and puts it in its own Refunds section, sorted by most-owed-first, where it stays even when fully refunded until you mark it closed out (`src/components/DealFlowView.tsx:143–167`).

Mobile does not do this. Its filter is `stage !== 'complete' && invoice is active` (`www/app.js:4651`) — with no refund exclusion — so refunded and partly-refunded deals sit inline in your active pipeline wearing a small badge, inflating the list and the counts. There is **no Refunds section on mobile at all**. Worse: the refund UI that does exist (record a refund, see the refund list) is wired only to *active* cards, and completed deals render through a different function — so a refund on a completed deal can be neither recorded nor viewed anywhere on the phone.

**The fix** is three parts, and it is re-wiring rather than building: mirror desktop's exclusion in the mobile filter; add a Refunds section under the pipeline with the same most-owed-first sort and the same "show done" toggle; and bind the existing refund panel to the completed-deal renderer as well as the active one. The server already sends refund totals. Small, and it goes in the first mobile-visible phase.

### The 12 missing screens, classified

**Must-have on mobile:**
- **Release letter** — this is the most phone-native screen in the entire product and it's the one that's missing. It gets signed at a warehouse with a finger. The signature pad already exists on desktop; touch beats a mouse.
- **Bank transaction review** — reshaped as a queue, one transaction per card with a suggested match and Accept / Change / Skip. Not a ledger table.
- **Free cash** — read-only, one number. "Can I afford this pallet?" is asked standing in front of the pallet.
- **Reconciliation** — same queue treatment.
- **Client email thread** — inside the client screen. "Every email to and from a client is logged" is your own onboarding promise; mobile doesn't show it.
- **Lead form share link + submission count** — you hand a form link out at a trade show, from a phone. Building the form is desk work. *Blocked: the server routes for this don't exist yet.*

**Nice-to-have:** recurring invoice templates (view/pause/resume only — and fix the naming collision first, mobile's "Recurring" tab is currently newsletter schedules); Data safety as a read-only health panel; the superadmin console as a compact read-only panel, which is worth it precisely because the owner is the one in the field.

**Desktop-only, deliberately:** manifest analyzer (it ingests 1000-row spreadsheets — mobile should show its *output* on the lot card, not the tool); sheet copy; the globe; CSV import; the full mailbox with drafts and AI replies; invoice/quote PDF branding studio; AI model settings (the model runs on that specific machine); Stripe keys (never type a secret key on a phone); backup.

**Ranked above all of these: refunds**, because the code exists and is orphaned.

---

## 6. Making it feel high-end

Ordered by felt improvement per unit of work. The first group is days, not weeks, and needs no architectural change.

**Turn on compression.** Your server sends 490 KB of uncompressed JavaScript and CSS on every cold start, and every data response raw on top of that — the invoice list currently ships the full line-item detail of every invoice with no limit. Turning on compression is effectively a one-line change and cuts it by roughly 4–5×. **This is the highest-leverage single item in the entire document.** It improves every screen on every device forever.

**Fix the offline cache so the warehouse stops white-screening.** Right now the cached copy of the app is only used when the network *fails outright*. One bar of signal doesn't fail — it stalls, for thirty seconds, showing nothing. Serve the app instantly from the phone and check for updates in the background. About 25 lines.

**Replace all 23 browser alert boxes.** Right now confirming "mark this deal as fallen through" pops a system alert that says **"ecliptr.app says…"** — the domain name, in an unstyled box, ignoring dark mode. Nothing screams "this is a website" louder. A correct, well-designed bottom sheet already exists in your code and is used in exactly one place. This is mechanical, low-risk, and the biggest "this is a real app" delta per line changed.

**Make every row press.** Eight list rows — including Clients, Invoices, and Tiers, your three highest-traffic lists — are built as plain containers rather than buttons, which on iPhone means tapping them produces *no visual feedback whatsoever* before the panel appears half a second later. That specific sensation is the sensation of a web page.

**Never leave a tap unanswered.** Tapping Settings on cellular currently does nothing visible for about a second — four data requests run one after another before anything is drawn. Rule: the first line of every screen draws a skeleton. Then collapse the sequential requests into one round trip.

**Stop rendering failures as zeros.** When a request times out, the dashboard currently renders **$0 revenue and $0 profit as though that were the truth.** For a money tool that's worse than an error message. It should show the last known figures with "as of 14:32", or a retry.

**One motion system.** There are currently 18 different animation durations in the stylesheet; the declared house rule of 130ms is used 7 times out of 2,097 lines. Three tokens, applied everywhere, plus an exit animation on the toast (it currently just vanishes) and a slide on the tab indicator (it currently teleports).

**Then the structural one: a navigation stack with real history.** About 120 lines, and it is the difference between a website and an app. One change delivers all of: Android's back button working, the iPhone edge-swipe working on every screen, back buttons on the five dead-end screens that currently have no way out, scroll position remembered, deep links from a notification or an emailed invoice, and opening an invoice from a client returning you to *that client* instead of the client list. It is also the single biggest item Apple's reviewer will notice — a wrapped app where the back gesture exits reads as a website, which is exactly the 4.2 objection.

**Then: stop rebuilding the world after every tap.** Marking a supplier paid currently refetches the entire deal pipeline *and* the entire invoice list, rebuilds both screens, and drops you at the top of the page to hunt for your card again. Native apps update the one row and animate it. Your code already contains one correct example of this pattern, used once. Generalizing it to the fourteen mutation points — starting with deal flow, which is the core loop — is where "stage advance" stops feeling like a page reload and starts feeling like something happened because you did it.

**Then, for the field: offline.** Keep a local copy of clients, inventory, invoices and deals so screens paint instantly from the phone and reconcile in the background — with money figures visibly timestamped, never presented as live. Then a queue so a supplier payment recorded in a dead zone lands when you're back in the truck. *This is the highest-risk item in the document and it must come after the data-integrity work, because a write queue multiplies any save-corruption bug by every queued write.*

**Honest limits.** The current code — one large file of string templates — can reach everything above. What it genuinely cannot do without changing how screens are drawn is *interruptible shared-element transitions* (a list row expanding into the detail view, iOS-style), because that requires keeping the old screen alive and moving it. There's a newer browser feature that gets most of the way there and degrades gracefully; worth prototyping, not worth a rewrite. **I do not recommend rewriting in a framework now** — it would freeze the parity backlog while data-integrity issues are still open. The right sequence is: do the cheap wins, then extract a small shared "shell" module while doing the navigation stack, and revisit the framework question *after* — at which point the shell is the migration boundary and moving screen-by-screen becomes incremental instead of a big bang.

---

## 7. The phased roadmap

Effort is relative size (S / M / L / XL), not day counts. Every phase ends with something visible on your phone.

**Phase 1 — "It stops feeling like a website."** *(M)*
Compression, offline cache fix, all 23 alert boxes replaced with real sheets, press feedback on every row, skeleton-first on every screen, parallel data loading, failures stop rendering as $0, one motion system, fix the scroll stutter.
**You'll see:** the app opens roughly four times faster, taps respond instantly, and every confirmation looks like your product instead of Safari.

**Phase 2 — "It navigates like an app."** *(M–L)*
Navigation stack and history: back gesture everywhere, Android back button, scroll position remembered, back buttons on the dead-end screens, client → invoice → back returns to the client. Every orphan screen becomes a real destination. Last tab remembered.
**You'll see:** you can swipe back. Everywhere. Nothing loses your place.

**Phase 3 — "The new shape."** *(L)*
New tab bar. Deals becomes one money spine with segments. Inventory promoted. Search tab replaces More, with counts on every tile and one new search endpoint on the server. Home reordered around "needs you". Avatar opens Settings. New Settings list with search. **Camera capture on lots** — the server route already exists. **The refund fix.** Record-payment on Receivables and on the client screen.
**You'll see:** the More list is gone, you can photograph a pallet, and you can take a payment from your phone.

**Phase 4 — "Native shell."** *(L)*
Capacitor wrapper, secure token login, Face ID lock, push notifications end to end (client plus a sender on your server), native camera, share-sheet so you can open a manifest from Mail straight into Ecliptr, deep links, offline read cache, the account-deletion fix Apple requires, privacy manifest, app icon and launch screen, seeded demo workspace, purchase-surface scrub.
**You'll see:** the real app, on your home screen, from TestFlight. Push notifications waking your phone when an invoice is paid.

**Phase 5 — "Parity and correctness."** *(L–XL)*
The remaining audit rounds: money correctness, workflow unblocks, the nine new server routes and their screens, layout parity, the tier grid, the send-safety flags. Plus the must-have missing screens: release letter with finger signature, bank transaction review queue, free cash, reconciliation, client email thread. Offline write queue. Optimistic updates with real motion on stage advance.
**You'll see:** every desktop workflow works on the phone, and getting a release letter signed at a dock stops needing a laptop.

**Phase 6 — "Submission."** *(M)*
Screenshots from the redesigned screens with real-looking data, store copy, privacy labels, export compliance, demo credentials in the review notes, submit. Budget 2–3 review rounds. Android comes almost free here if you want it — the same wrapper produces a real Android app with camera, push and offline, which is strictly better than the quick-wrap alternative.

Phases 1 and 2 can start immediately and in parallel with the Apple enrollment waiting period. Phase 3 and Phase 4 overlap deliberately — shipping the current "More = a list of sections" navigation into an App Store submission would both waste the launch and hand a reviewer ammunition.

---

## 8. Decisions I need from you

**The seven already open from the audit:**

1. **Client tier revenue basis — refund-netted, or raw amount paid?** Desktop currently contradicts itself. *Recommendation: refund-netted.* Consequence: real clients get re-tiered — someone who is Platinum today may not be, and tier-targeted newsletters will go to a different list. Raw keeps everyone where they are but rewards revenue you gave back.

2. **Customer portal tokens — sync them to every device, or issue them server-side only?** *Recommendation: server-side only.* Consequence: sync is simpler and safer but portal links can only be generated while online. Syncing puts customer-facing access tokens onto every device and into the change log.

3. **Client status vocabulary — what is the canonical list?** Is "warm" real? Does mobile's "active" mean "active customer"? Rows already exist saying `active`, `hot lead`, `active customer`, and blank. *Recommendation: pick a short fixed list and run a one-time cleanup.* Consequence: without this, filters and counts stay quietly wrong on both platforms forever.

4. **One definition of "Outstanding."** Three exist: all unpaid non-void (desktop invoices), sent-or-overdue (mobile invoices), committed receivables (dashboard). *Recommendation: all unpaid non-void, everywhere.* Consequence: whichever wins changes a number you read every day, so it should change once, deliberately, and be announced to yourself.

5. **Weekly brief headline — profit, or profit plus losses added back?** Mobile and desktop currently disagree. *Recommendation: plain net profit.* Consequence: mobile's headline number will go down; it will be the true one.

6. **Rejecting a stale listing currently marks the lot sold.** *Recommendation: confirm that's intended, then relabel the mobile button "Mark sold" so it says what it does.* Consequence: if it wasn't intended, this is a behavior fix, not a label fix.

7. **Repairing data already damaged by the old mobile saves** — wiped supplier payment details and addresses, missing company phone/tax ID/logo, stripped kept-cut flags, custom lots reset to $0, blanked client statuses. Recovery would come from the change log and nightly backups, and recovery is itself a write. *Recommendation: yes, but as a preview-first, one-entity-at-a-time repair you approve, never a bulk automated restore.* Consequence: leaving it means those fields stay empty until someone re-enters them by hand.

**New decisions from this plan:**

8. **App Store, or TestFlight as the destination?** *Recommendation: build for the public listing, ship to TestFlight at week 5 and live there.* Consequence: public listing means discoverability and 2–3 review rounds; TestFlight means your people have it in a month with far less risk, and 90-day build refreshes.

9. **Submit before or after paid plans switch on?** *Recommendation: before.* Consequence: during the free beta there is genuinely nothing purchasable, which is the cleanest possible position with Apple. After billing goes live, a compliant app must have zero purchase surface in it, and adding real in-app purchase later is 3–4 weeks of work.

10. **Apple seller name — you personally, or BJM Distributions LLC?** *Recommendation: the LLC.* Consequence: the LLC looks right on the listing and avoids a trap on Android where a personal account forces a 14-day, 12-tester closed test before you can go live — but it needs a D-U-N-S number and takes 1–3 weeks. Start it today either way.

11. **Which tab bar?** *Recommendation: `Home · Clients · Inventory · Deals · Search`.* Consequence: Invoices costs one extra tap on the first open of a session. The alternative keeps Invoices as a tab and folds the pipeline inside it — same structure, opposite default.

12. **Android — yes or no?** *Recommendation: not separately; take it as a byproduct of the same wrapper in Phase 6.* Consequence: only worth doing at all if your team or your buyers are actually on Android. If everyone's on iPhone it's a vanity listing.

13. **Does Payouts / Refer & earn exist on desktop too, or stay mobile-only?** These are the two screens mobile has and desktop doesn't. *Recommendation: bring Payouts to desktop, leave Refer & earn mobile-only.* Consequence: leaving Payouts mobile-only means the profit-split numbers live in exactly one place, which is fragile.

14. **Live JavaScript updates — set up before first submission?** *Recommendation: yes, before.* Consequence: without it, every mobile change waits 24–48 hours for Apple and the store version falls behind the web version within a week of launch.

---

## 9. What I recommend we do first

Start two things today, in parallel, because one of them is pure waiting: **begin Apple Developer Program enrollment as BJM Distributions LLC** (it costs $99, it costs nothing to start, and the 1–3 week verification wait is the longest lead time in this entire plan), and **do Phase 1** — compression, the offline cache fix, the 23 alert boxes, press feedback, skeleton-first, and no more rendering timeouts as $0. Phase 1 is days of work, carries essentially zero structural risk, needs none of the fourteen decisions above, makes the app roughly four times faster to open on every screen, and is the fastest way for you to feel whether this plan is going in the right direction before you commit to the bigger phases. Meanwhile answer decisions 1, 4, 5 and 11 — those four unblock the most downstream work, and 11 in particular determines the shape of everything in Phase 3.

---

# APPENDIX A — NAVIGATION & IA RESEARCH

## TASK 1 — NAVIGATION & INFORMATION ARCHITECTURE

Sources read: `C:/Users/Jack/Desktop/clienthub-api/www/index.html` (tab bar, lines 131–152), `C:/Users/Jack/Desktop/clienthub-api/www/app.js` (`MORE_TABS` :719, `navigateTo` :721, `render` :733, `renderMore` :1063, `renderDashboard` :2976, every `render*` entry point), `C:/Users/Jack/Desktop/clienthub-api/www/style.css`, `C:/Users/Jack/Desktop/BUSINESS APP/src/App.tsx` (`NAV` :409, `UTILITY` :438), `SettingsView.tsx` :175–221, `CommandPalette.tsx`, plus both audits as known input.

---

# (a) CURRENT MOBILE IA — exact

## The shell

`#app-header` (index.html:118–129): logo · page title · sync · bell (admins) · context "+" .
`#tab-bar` (index.html:131–152): **5 slots — Home, Clients, Invoices, Flows, More.**
`#app-content` is wholly replaced by `setContent()` (app.js:240). There is no router, no URL, no history.

## Every destination

**Router destinations** — the `render(tab)` switch, app.js:740–763. 22 cases = 21 real screens + the `more` index.

| # | Destination | Tab id | How reached | Taps from cold open | Notes |
|---|---|---|---|---|---|
| 1 | Home / dashboard | `dashboard` | Tab bar | 1 (launch default, app.js:78) | Last tab is **not** persisted; desktop persists (App.tsx:84) |
| 2 | Clients | `clients` | Tab bar | 1 | Has a search box (:3364) |
| 3 | Invoices | `invoices` | Tab bar | 1 | Has a search box (:3954) |
| 4 | Deal flows | `deal-flows` | Tab bar | 1 | Has a search box (:4608) |
| 5 | More (index) | `more` | Tab bar | 1 | A 21-row scrolling link list |
| 6 | Client tiers | `tiers` | More › Clients | 2 + scroll | |
| 7 | Web forms | `webforms` | More › Clients | 2 + scroll | Miscategorised — an org/admin object, not a client one |
| 8 | Team | `team` | More › Clients | 2 + scroll | Same miscategorisation; has 3 internal sub-tabs |
| 9 | Suppliers | `suppliers` | More › Sourcing | 2 + scroll | |
| 10 | Inventory | `inventory` | More › Sourcing | 2 + scroll | The most field-native screen in the product, 2 taps deep |
| 11 | Quotes | `quotes` | More › Sales | 2 + scroll | |
| 12 | Deals (legacy `/api/deals` pipeline) | `deals` | More › Sales | 2 + scroll | Name collides with the "Flows" tab; different object (:2411) |
| 13 | Receivables | `receivables` | More › Money | 2 + scroll | Read-only — no record-payment action (audit MP1-14) |
| 14 | Payables | `payables` | More › Money | 2 + scroll | Read-only |
| 15 | Payouts | `payouts` | More › Money | 2 + scroll | Mobile-only screen (no desktop twin) |
| 16 | Newsletters | `news` | More › Comms | 2 + scroll | 3 internal sub-tabs (scheduled/recurring/history) |
| 17 | Weekly brief | `brief` | More › Comms | 2 + scroll | |
| 18 | Analytics | `analytics` | More › Insights | 2 + scroll | |
| 19 | Notes | `notes` | More › Utility, or Home peek | 2 | **Missing from `MORE_TABS` (:719)** → no tab highlights; user is "nowhere" |
| 20 | Archive | `archive` | More › Utility | 2 + scroll | |
| 21 | Refer & earn | `referrals` | More › Utility | 2 + scroll | Mobile-only |
| 22 | Settings | `settings` | More › Utility (last row of the list) | 2 + full scroll | 7 stacked sections vs desktop's 24 |

**Orphan screens** — rendered with `setContent()` but never assigned a tab, so `currentTab` still points elsewhere. Any sync, pull-to-refresh (:340 → `syncNow` → `render(currentTab)` :551) or `[data-retry]` (:370) silently ejects the user back to the previous tab.

| Screen | Entry | Depth | app.js |
|---|---|---|---|
| Approvals | Header bell only (+ Home "Today" row) | 1 | :2735 |
| Checkup (list) | More › first row | 2 | :1345 |
| Checkup session / board | Checkup › session | 3 | :1383, :1393 |
| My account | More › You | 2 + scroll | :1462 |
| Send feedback | More › Help | 2 + scroll | modal |
| Feedback inbox | More (default-org superadmin) | 2 + scroll | :1554 |
| Early-access list | More (default-org superadmin) | 2 + scroll | :1585 |
| Payout config | Payouts › set up | 3 | :1250 |
| Team member profile | Team › person | 3 | :834 |
| Categories manager | Settings › categories | 3 | :5981 |

Detail panels (client :3420, invoice :4222, lot, quote, supplier) are `#active-detail` overlays (:429–477) appended to `<body>`, dismissed by a ← button or a left-edge swipe (:446–475). They are the only place iOS-style back exists.

## The problem, quantified

1. **17 of 21 router destinations (81%) are only reachable through "More."** The 4 promoted tabs are Home, Clients, Invoices, Flows.
2. **The More screen is 21 rows under 10 headings** (23 rows for the default-org superadmin): Checkup + 17 section rows across 7 groups + My account + Setup guides + Send feedback + Sign out. On a 6.1" phone that is ~1.7 screens of scrolling before Settings, which is the last row.
3. **Every More row is pure text.** No icon, no count, no state. There is nothing on that screen that tells you *whether you need to go there* — so it is a directory you re-read every time, which is exactly the complaint.
4. **Zero back-navigation.** `pushState`/`popstate`/`hashchange`: **0 occurrences** in 6,759 lines. Android's hardware back exits the PWA from any depth. iOS swipe-back works only inside `.detail-panel`, never on More → section.
5. **No global search.** 3 per-screen filter boxes (clients :3364, invoices :3954, flows :4608) + 3 in-form pickers. Nothing searches across entities. Desktop has ⌘K (`CommandPalette.tsx` → `global_search`, `src-tauri/src/commands.rs:1451`). The server has **no** `/api/search` route — `clients.rs:647` and `suppliers.rs:224` are the only search SQL.
6. **The active-tab highlight is a hand-maintained array** (`MORE_TABS` :719) that has already drifted — `notes` is missing from it.
7. **The camera is unused.** `showInventoryForm` (:3654–3699) has 10 fields and **no file input**; the only `accept="image/*"` in the whole app is the account avatar (:1473). Meanwhile `POST /api/inventory/:id/photo/:name` **already exists** on the server (`src/routes/inventory.rs:34`, open to any org member) and mobile never calls it.

## Tap depth for real tasks (today)

| Task | Path | Taps | Verdict |
|---|---|---|---|
| Look a buyer up mid-call | Clients → search field → type → row | 3 + typing | acceptable |
| New invoice | Invoices → + | 2 | good |
| Review a pending sign-up | bell | 1 | good, but orphaned screen |
| Quote a lot a buyer just asked about | More → scroll → Inventory → lot | 3 + scroll | too deep |
| Mark a supplier paid | Flows → expand card → mark paid | 3 | acceptable |
| See what I'm owed | More → scroll past 4 headings → Receivables | 2 + scroll | too deep, and read-only |
| **Record that a buyer paid** | — | **impossible** | worst money gap |
| **Photograph a lot in the warehouse** | — | **impossible** | worst field gap; server route exists |
| Send a quote from the truck | More → Quotes → + → fill → save | 4+ | too deep |
| Log a call after hanging up | Clients → search → row → log | 4 | too deep for the highest-frequency write |
| Change any setting | More → scroll to last row → Settings → scroll | 2 + 2 long scrolls | worst |

---

# (b) DESKTOP IA — for comparison

`src/App.tsx:409–444`. A permanently visible 216px sidebar: **12 workflow mains, 9 children, 5 utility = 26 destinations**, every one 1 click (2 if its group is collapsed; the active group auto-opens, :470).

| Main | Children |
|---|---|
| Dashboard | — |
| Clients | Checkup · Tiers · Approvals |
| Suppliers | — |
| Inventory | Sheet copy |
| Manifest analyzer | — |
| Deal Flow | — |
| Invoice | Completed · Receivables · Payables |
| Quote | Release letter |
| Financials | — |
| Newsletter | — |
| Brief | — |
| Analytics | Automation · Globe |
| *Utility zone* | Notes · Archive · Platform · Data safety · Settings |

Plus non-sidebar affordances mobile has no equivalent for: ⌘K command palette, `L` quick log, `/` shortcuts, split view (two tabs side by side), bell, feedback, per-tab persistence (:84), and Settings as **24 sections in 4 groups** (`SettingsView.tsx:175–221`) vs mobile's 7.

**Structural differences that matter more than the count**
- Desktop nav is *ambient* — always on screen, so switching context is free and grouping is a reading aid. Mobile copied the **grouping** into `renderMore()` but not the **ambience**: on mobile the same grouping becomes a modal detour you must enter, scan, and exit.
- Desktop groups AR/AP/Completed **under Invoice** (the money spine). Mobile splits them into a "Money" group alongside Payouts, and puts Deal Flow in a tab — so the same lifecycle is scattered across a tab and three More rows.
- Desktop's `email` = inbox **and** newsletter; mobile's `news` = newsletter only.
- Mobile-only destinations with no desktop twin: **Payouts, Referrals** (audit D-D, D-E).
- Missing entirely on mobile: Manifest analyzer, Sheet copy, Release letter, Financials/FreeCash/Loans, Globe, Data safety, Platform (partial), Recurring *invoices*, inbox/drafts, Forms builder, Reconciliation (audit: 12 screens).

---

# (c) THE JOBS — field vs desk

A liquidation broker's day: sourcing calls, warehouse walk-throughs, buyer calls from a car, wires and supplier payments, and then a block of desk time for documents and analysis. Sorting the feature set by *where the job physically happens*:

### Field-first — the phone is the better tool, or the only tool
| Job | Why it's field | Frequency | Urgency | Today |
|---|---|---|---|---|
| **Photograph a lot / manifest at the dock** | A laptop cannot do this at all | Every intake | Perishable — you're standing there once | **Impossible** |
| **Look a buyer up mid-call** (tier, credit limit, blacklist, last order, what they owe) | Answer must land inside 10 seconds of conversation | Many/day | Seconds | 3 taps, OK |
| **Answer "what's your price on that lot?"** | Buyer asks on the phone; needs load price + per-unit + qty | Many/day | Seconds | 3 taps + scroll |
| **Share a lot to WhatsApp buyers** | WhatsApp lives on the phone; desktop has `WhatsAppSharePanel`, mobile has nothing | Daily | Minutes | Missing |
| **Record a buyer payment / mark supplier paid** | Happens at the bank, on the call, in the truck | Daily | Minutes — it gates the next action | Supplier: 3 taps. Buyer: **impossible** |
| **Log a call/note right after hanging up** | If it isn't logged in 30 seconds it never gets logged | Many/day | Seconds | 4 taps |
| **Send a quote to a buyer who just said yes** | Closing window is the call itself | Daily | Minutes | 4+ taps |
| **Approve a pending sign-up** | Notification-driven, any location | Daily | Minutes | 1 tap (good) |
| **"Am I making money this month?" / follow-ups due** | Read between meetings | Daily | Low | Home, good |
| **Check what I'm owed before a collections call** | Read | Daily | Minutes | 2 taps + scroll, read-only |

### Desk-only — small screens make these worse, not just harder
Manifest analysis (spreadsheet, per-SKU); newsletter/blast design and template editing; invoice & quote branding studio, logo, PDF preview; Financials/treasury — bank import, reconciliation, free cash, loans, allocations; Sheet copy and Google Sheets column mapping; CSV/contacts import; team roles permission matrix; SMTP/IMAP setup; integrations (Shopify, Facebook, Stripe, Plaid); Data safety; Platform superadmin; Globe. **These should not get mobile parity screens. They should get a one-line "set up on desktop" pointer**, which mobile Settings already does correctly once (`app.js:6159`).

### Both — mobile needs a *read* plus exactly one *write*
Receivables/Payables (read the aged list, write "record payment" / "mark paid"). Brief (read). Tiers (read, mid-call). Analytics (read a 3-number summary; the deep dive is desk). Payouts (read anywhere, pay at desk). Archive/restore (rare, desk-leaning). Release letter (produced at a desk, sometimes needed at a dock → deliver as a link/PDF, don't build the editor).

**The conclusion that drives the redesign:** the two highest-value mobile jobs — *photograph a lot* and *record a payment* — do not exist on mobile at all, while four of five tab slots are spent on record lists. The IA is optimised for browsing when the field job is capture-and-act.

---

# (d) PROPOSED IA

## Principle
A tab is a **place you return to**, not a task you complete. Everything else is reached by **searching for it**, by **acting on a record**, or from an **actionable home card** — never by reading a directory.

## 1. Bottom tab bar — 5 slots

| Slot | Tab | Why it earns a permanent slot |
|---|---|---|
| 1 | **Home** | The only screen that tells you what needs doing. Opened first, every session. |
| 2 | **Clients** | The mid-call surface, many times per day, urgency measured in seconds. Already a tab; keep. |
| 3 | **Inventory** | **Promote from More.** It is the product a broker sells, the answer to the most-asked phone question, and the one screen a laptop physically cannot replace (camera). Currently 2 taps + a scroll past 2 group headings. |
| 4 | **Deals** | **Merge** Flows + Invoices + Receivables/Payables + Completed into one money spine with a segmented control: `Pipeline · Invoices · Money · Done`. They are the same object at four stages; splitting them across 1 tab and 4 More rows is why "Flows" and "Deals" collide today. Persist the last segment (as desktop persists the last tab, App.tsx:84) so a returning user lands where they left — which makes Invoices effectively 1 tap after first use. |
| 5 | **Search** | **Replaces "More."** See below. |

Displaced from the bar: Invoices (→ Deals segment 2), Flows (→ Deals segment 1, default).

**The one tradeoff to name explicitly:** Invoices drops from 1 tap to 2 on the very first open of a session. It's recovered by segment persistence, and it buys −1 tap and −1 scroll on Inventory, Quotes, Suppliers, and AR — all of which are more field-urgent. If you'd rather not move Invoices at all, the alternative is `Home · Clients · Inventory · Invoices · Search` with Pipeline folded in as an Invoices segment — same structure, opposite default. Recommendation is the first, because `renderDealFlows` (:4598–5670, ~1,100 lines: supplier payments, stages, refunds) is where money *actions* happen, while `renderInvoices` (~300 lines) is mostly a list — and desktop's own sidebar already orders Deal Flow above Invoice.

## 2. Home — a hub, not a link grid

Reorder around "what do I open the app to do":

1. **Compact money line** — Revenue · Profit with the existing `This month / All time` toggle, collapsed to one row (today it's hero + delta + counts = three stacked blocks before anything actionable).
2. **"Needs you"** — promoted above the chart. Each row is a *count with money attached* and taps straight to the record with the action primed, not to the section. Sources already on the wire: pending approvals (`/api/approvals/count`), overdue invoices + total, invoices missing shipping (`s.incomplete_shipping`), follow-ups due today, loss deals, plus two the server already computes for Brief but Home ignores — **stuck deals** and **at-risk customers**. Add media/sync warnings once photos exist (desktop `list_media_sync_issues`).
3. **Quick actions — field-first.** Replace today's `New client · New invoice · Compose` with **`Photograph a lot · Log a call · New invoice`**. "Compose" is a desk job sitting in the most valuable three-chip row in the app.
4. **Chart** (keep, below the fold).
5. **Recently viewed** — mixed clients, lots, deals, invoices. Replaces "Recent invoices". Recents alone remove roughly half of all navigation for a working broker.
6. **Notes peek** (keep).

## 3. What replaces "More": a Search tab with three states

This is the direct answer to *"i hate when i click more its just list of different sections."* A section list gives you nothing to act on. A search tab gives you the record you actually wanted, and keeps the sections as a fallback that is *ranked and counted*.

**State A — empty (the "Jump to" screen)**
- **Pinned** — 4–6 user-chosen tiles, reorderable. Every broker's tail is different; let him pin Payouts or Suppliers and never scroll again.
- **Recent** — last 8 records touched, mixed types, one tap each.
- **All sections** — 2-column iconed tiles, grouped, **each carrying a live count or amount**: `Receivables · 14 · $82,400`, `Approvals · 3`, `Quotes · 6 open`, `Suppliers · 22`, `Payables · $19,300`, `Archive`, `Team`, `Notes`. A count is the reason to tap; a bare label is not — that is the entire difference between this and today's More.

**State B — typing a name** → one mixed result list grouped by type: clients, invoices, lots, deals, suppliers, quotes. Requires **one new server route, `GET /api/search?q=`**, mirroring `global_search` (`src-tauri/src/commands.rs:1451`) — the desktop already proves the query shape; nothing equivalent exists server-side today.

**State C — typing a verb** (phase 2) → commands: "new invoice", "add lot", "mark paid", "log call". This is desktop's ⌘K palette on a phone, and it collapses the deepest create-flows to 2 taps + typing.

## 4. Where each displaced destination lands, and why

| Destination | New home | Rationale |
|---|---|---|
| Invoices, Receivables, Payables, Completed | Deals segments | Same lifecycle, one spine |
| Tiers | **Clients** segment/filter (`All · Hot · Tiers`) | It's a view of the same list — kills a destination outright |
| Checkup | **Clients** segment | It *is* a client workflow; also promotes it out of orphan status |
| Approvals | Keep the bell (1 tap) **+** a Home "Needs you" row **+** a real route id | Notification-driven work should never require navigation |
| Quotes | Jump-to tile **+** "New quote" action on client detail and lot detail | Browsing quotes is rare; *creating* one from a call is frequent — it needs an entry point, not a tab |
| Suppliers | Jump-to tile **+** contextual from a lot and from a deal's supplier-payment row | Reached from work, not browsed |
| Brief, Analytics, Newsletters, Payouts, Team, Web forms, Archive, Referrals, Notes | Jump-to tiles with counts | Low frequency, non-urgent |
| **Settings + My account** | **Avatar in the top-left of the header**, on every screen | Universal pattern; 1 tap from anywhere instead of "More → scroll to the last row". Also empties the "You"/"Help" groups out of the section list |
| Setup guides, Send feedback, Sign out | Inside the account sheet | Belongs with identity, not with workflow |
| Manifest, Sheet copy, Financials, Data safety, Platform, Globe, Release letter, Forms builder | Not built. A single "Set up on desktop" line where the user would look for them | Desk jobs; mobile screens for them would be worse than none — mobile Settings already does this correctly at app.js:6159 |

## 5. Contextual entry points — the real parity mechanism

Most "desktop features" are *actions on records*, not sections. On mobile they must hang off the record, which is also how the deep tap-counts collapse:

- **Client detail** → New invoice · New quote · **Record payment** · Log call · Send to newsletter · View their AR
- **Lot detail** → **Add photo** · Share to WhatsApp · Create quote from this lot · Post to storefront · Attach manifest
- **Deal (pipeline) card** → Mark supplier paid · **Record buyer payment** · Attach shipping · Reopen · Refund *(audit S6: reopen/delete/refund exist only in dead code at app.js:4840–4924 and must be re-wired into the live renderers)*
- **Home queue row** → the action inline (Approvals already does this correctly)

## 6. Structural fixes the new IA requires (not chrome — these are the IA)

1. **Give every screen a route id and `history.pushState` it.** 0 occurrences today. This makes Android's hardware back work, extends iOS swipe-back beyond detail panels, and makes refresh/sync return you to where you were. It is also the single biggest App-Store-readiness item in the navigation layer — a wrapped PWA where the OS back gesture exits the app reads as a website, which is the usual 4.2 minimum-functionality objection.
2. **Convert all 10 orphan screens into real routes** (approvals, checkup, checkup session, my account, payout config, feedback inbox, waitlist, team member, categories, and the news sub-tabs), so `syncNow` → `render(currentTab)` (:551) and pull-to-refresh stop ejecting the user.
3. **Persist last tab and last segment** (desktop: App.tsx:84).
4. **Derive the tab-highlight set from the route table instead of the hand-maintained `MORE_TABS` array** (:719) — it has already drifted (`notes` missing).
5. **Add `GET /api/search?q=`** — prerequisite for the Search tab.
6. **Wire the camera:** file input with `capture` in the lot form, POSTing to the existing `POST /api/inventory/:id/photo/:name` (`src/routes/inventory.rs:34`). Zero new server work; unlocks the single most mobile-native job in the product.

## 7. Depth, before and after

| Task | Now | Proposed |
|---|---|---|
| Photograph a lot | impossible | Home quick action → capture = **2** |
| Record a buyer payment | impossible | Deals → Money → row → record = **3** (or Search "acme" → **2**) |
| Price a lot on a call | 3 + scroll | Inventory tab → lot = **2** |
| Send a quote | 4+ | Client detail → New quote = **3** |
| Log a call | 4 | Home quick action = **2** |
| What am I owed | 2 + scroll | Deals → Money = **2**, or Home "Needs you" = **1** |
| Any settings screen | 2 + two long scrolls | avatar → section = **2**, from anywhere |
| Any tail section (Team, Archive, Payouts…) | 2 + scroll through 21 rows | Search → tile (counted) = **2**, or pinned = **1** |
| Reach the previous screen | impossible | back gesture / hardware back = **0** |

## 8. Design-rule compliance

Headings are sentence case and descriptive ("Needs you", "Jump to", "Recently viewed") — no eyebrows, no uppercase kickers. Uppercase stays confined to the existing tiny status pills (`.news-status` style.css:1449, `.ar-spec-tag` :1882) — verified, the mobile CSS has no uppercase heading violations today. No emojis anywhere (note: the **desktop** `CommandPalette.tsx:26–29` uses emoji icons for result types — a pre-existing violation to fix when that pattern is ported, not to copy). Satoshi only, no mono figures (`.mono-num` stays `font-variant-numeric: tabular-nums` on the same font — compliant). Existing tokens carry over unchanged: `--c-bg #FAFAF9` warm paper, `--c-text #14161D`, `--c-border #E9E7E2`, `--c-primary-solid #FF6520`, `--ease` at 130ms.

---

# APPENDIX B — SETTINGS & PARITY SHAPE

## (a) Settings mapping — desktop 24 sections vs mobile 7 blocks

**Desktop** (`src/components/SettingsView.tsx:170-224`, `SETTINGS_GROUPS`): 24 nav items in 4 groups — Workspace (account, appearance, company, invoice, quote, storefront, categories, customfields), Communication (email, whatsapp, templates, automation, forms), Integrations (ai, sheets, import, billing, shopify, facebook, webforms), Data & Team (sync, splits, backup, team). A 25th, `payments`, was merged into `invoice` (`:238-241`) and renders as `<PaymentsTab/>` inside it (`:344`).

**Mobile** (`www/app.js:6121-6335`, `renderSettings`): 7 blocks — Your plan, Appearance, Company info, Sending email (+ a "set this up on desktop" card for Inbox & capture), Categories, Payout split (a link out to `payouts`), Payment methods (read-only). Two more desktop sections exist on mobile but *outside* Settings: My account (`renderMyAccount` `:1462`, reached via More → You) and Team (its own More tab).

| # | Desktop section | What it really is | On mobile today | Should be | Verdict |
|---|---|---|---|---|---|
| 1 | My Account | name, title, phone, avatar, role, plan, replay tour | Yes, but in More → You; plan duplicated inside Settings | Yes — folded into Settings, one home | **Must**, mobile-native |
| 2 | Appearance | theme / accent / mono, per-device | Yes — genuine parity | Yes | **Must**, mobile-native |
| 3 | Company | name, address, email, **phone, tax_id, logo** | 3 of 6 fields (P0-3 data loss) | Yes, all 6; logo from camera roll | **Must** |
| 4 | Invoice — branding + numbering + preview | logo placement, colors, prefix/next number, live PDF preview | None | Numbering + "show these payment methods" yes; PDF preview no | **Split**: config mobile, preview desk |
| 4b | Payments (merged into Invoice) | payment-method CRUD (ACH/Wire/Zelle/…) | Read-only list, no add/edit/delete | Full CRUD — ACH details change and get typed on a phone | **Must** |
| 5 | Quote branding | same shape as Invoice | None | Same split as Invoice | **Split** |
| 6 | Storefront | public link + page content + inquire button + theme colors | None | The **link** (copy/share) + on-off + inquire email; colors no | **Split** — link is the field-critical part |
| 7 | Categories | client/deal categories + subcategories | Yes, full manager | Yes | **Must**, already fine |
| 8 | Custom Fields | *authoring* extra client fields | None (and mobile doesn't render the values either — MP1-22) | Render values: must. Author them: rare | **Nice-to-have** to author, **must** to display |
| 9 | Email | SendingCard (SMTP/OAuth, org-vs-personal, transfer), newsletter template, IMAP inboxes, capture | SMTP subset + a desk-only note | Sending identity + newsletter template yes; add-an-inbox yes; Google OAuth via system browser | **Must** (sending), **nice** (inbox) |
| 10 | WhatsApp | inventory share message template | None | **Yes** — WhatsApp is used *from the phone*; the template lives only where he can't reach it | **Must**, embarrassing gap |
| 11 | Templates | reusable invoice line items | None; invoice form has no template picker (MP1-30) | Picker in the invoice form = must; CRUD = nice | **Split** |
| 12 | Automation | signup-detection rules (sender/subject regex) + follow-ups | None | On/off toggles + rule list yes; writing regex no | **Split** |
| 13 | Lead Forms (FormsPanel) | hosted form builder; **no server routes exist** | None | Share link + submission count yes; builder no | **Split**, blocked on routes |
| 14 | AI | Ollama model pick, needs localhost | None | No | **Desk-only** — the model runs on that machine |
| 15 | Google Sheets | OAuth, sheet id, column map, write-back | None | Status + "sync now" only | **Nice-to-have**, read-only |
| 16 | Import | CSV column mapping + Google Contacts | None | No — column mapping is a 12-column grid | **Desk-only** |
| 17 | Billing | Stripe pk/sk/webhook secret | None | No — never type secret keys on a phone | **Desk-only**, deliberately |
| 18 | Shopify | store domain + HMAC secret | None | Connected/not status only | **Desk-only** to configure |
| 19 | Facebook | Page token + posting config | None | Status only (the *post* action belongs in Inventory) | **Desk-only** to configure |
| 20 | Web forms (intake sources) | custom sites/forms → pending leads | **Yes**, but as a top-level More tab, not Settings | Yes — move under Settings → Connections | **Must**, relocate |
| 21 | Sync | event log, encryption passphrase, netsync connect, updates | None (only a header sync button) | Last synced / pending / failed / retry: yes. Passphrase: no (keyring secret) | **Split** |
| 22 | Splits | N-way profit-split partners | Yes, as a link out to `payouts` | Yes, as a real sheet not a link | **Must**, reshape |
| 23 | Backup | local SQLite backups + restore | None | Local backups are meaningless on mobile; show server backup health instead | **Desk-only**, replaced by Data safety |
| 24 | Team | people / roles / approvals / invites / payouts | Yes, separate More tab | Yes — inside Settings | **Must**, relocate |

Net: of 25, **13 must be on mobile**, **6 are splits** (config-on-desktop, use-or-status-on-mobile), **6 are genuinely desk-only** (AI, Import, Billing, Shopify, Facebook config, Backup) — plus Sheets as read-only status.

---

## (b) Proposed mobile Settings IA

**Shape.** Settings stops being one long scroll of cards and becomes a *routable list of rows* with a search field pinned at the top (reuse `.search-bar`, `style.css:590`). Each row pushes a **full-screen sheet** — not an accordion, not a modal — and every sheet is a real route (`settings/sending`, `settings/company`…). That last part is not cosmetic: `syncNow` ends with `render(currentTab)` (`app.js:521-541`) and any screen the router doesn't know gets thrown away on pull-to-refresh (MP1-18). Routable sheets kill that whole class.

**Every row carries its current value on the right.** "Company · BJM Distributions", "Email · jack@…", "Banks · 2 connected, synced 4m ago", "Team · 3 people". A settings list you can read without opening anything is the difference between high-end and a wall.

**Groups** (sentence case, thin labels, no uppercase kickers):

1. **You** — Name & photo · Appearance (theme, accent, mono) · Notifications · Your plan
2. **Your business** — Company details & logo · Payment methods · Invoices & quotes (numbering, which methods print) · Storefront link
3. **Sending** — Email account · Signature & sign-off · Newsletter template · WhatsApp message · Saved line items
4. **People & money** — Team, roles & invites · Approvals · Profit split · Rep payouts
5. **Connections** — Banks · Google Sheets · Web forms · Lead forms · Shopify · Facebook · Stripe *(each row shows a state pill: Connected / Not set up / Set up on desktop)*
6. **Data & safety** — Sync status & event log · Backups · Export · Sign out · Delete account

Groups 1-3 are the daily surface. Group 6 is last, uncolored, and holds every destructive thing behind a single confirm — nothing destructive is ever inline next to a field. Group 5 is deliberately honest: a "Set up on desktop" pill is better than an empty sheet, and it's one row not a dead end (it says *what* it does and *what it needs*).

**Progressive disclosure inside sheets:** max 5 fields visible, everything else behind one "Advanced" disclosure. Mobile already has the pattern (`.sc-adv-toggle`, `app.js:6143`) — generalize it.

**How a phone user finds "change my email signature":** they type `sig` into the search field at the top of Settings. The list collapses to one row — "Signature & sign-off", with "Sending" as its subtitle. Two keystrokes, one tap. This works because the search index is a flat array of ~40 rows with a `keywords` list, so "signature", "sign off", "footer", "my name at the bottom" all resolve to the same row even though none of those words is the row's title. Second path, no search: More → Settings → Sending → Signature (3 taps, all above the fold). Third path: the email/newsletter composer gets an overflow item "Edit signature" that deep-links to `settings/sending#signature` — you fix it where you noticed it was wrong.
*Finding worth flagging: there is no signature field in the product at all today, on either surface. The nearest things are the SMTP "From name" (`SettingsView.tsx:894`) and the newsletter template's outro (`:1392`), which is the de-facto sign-off. Adding a real `email_signature` to the org settings blob and appending it to quote/invoice/newsletter sends is a small, high-visibility win.*

**How a phone user finds "connect a bank":** they type `bank` → "Banks" under Connections. The sheet lists linked banks, last sync time, the count of transactions waiting to be reviewed, and a "Sync now" button — then states plainly that **adding a new bank happens in the desktop app**. That is the correct answer, not a limitation to paper over: Plaid Link needs its SDK, and a second link path would create a third `bank_txn` source (this is exactly the duplicate-transaction bug that produced 548 excess rows). What mobile *should* own is the part that's actually field work — reviewing and allocating transactions — and that lives in Money, not Settings; the Banks row deep-links to it.

**One nav note** (belongs to the flow redesign, stated once here because Settings depends on it): Settings must be one tap from anywhere — put the avatar in the header and let it open Settings — not More → scroll → Settings.

---

## (c) The 12 missing screens, classified

| Screen | Verdict | Why |
|---|---|---|
| **Release letter** | **Must-have** | It gets signed at a warehouse with a finger. The signature canvas already exists (`ReleaseLetterView.tsx:85`); touch beats a mouse. The single most phone-native screen in the product, and it's the one that's missing. |
| **Financials → transactions** | **Must-have** (as a review queue) | Categorizing and allocating a bank transaction is a between-stops task. Reshape required — see (d). |
| **Free cash** | **Must-have** (read-only) | "Can I afford this pallet?" is asked standing in front of the pallet. One number, one screen. |
| **Reconciliation panel** | **Must-have** (as a queue) | Same argument; it's the highest-value unattended work and it's card-shaped already. |
| **Desktop inbox — client-scoped half** | **Must-have** | "Every email to and from a client is logged" is the product's own onboarding promise (`app.js:205`). Show the thread inside the client detail. |
| **Hosted lead-form builder — share half** | **Must-have** (share link + submissions) | You hand out the form link at a trade show, from a phone. Building it is desk work. Blocked on CRUD routes. |
| **Recurring invoice templates** | **Nice-to-have** | View / pause / resume on mobile; creating a schedule is rare and form-heavy. Fix the naming collision first — mobile's "Recurring" tab is *newsletter* schedules (`app.js:6466`). |
| **Data safety** | **Nice-to-have** (read-only) | Last backup, sync health, dead-lettered pushes. Reassurance, not work. |
| **Platform (superadmin)** | **Nice-to-have** (read-only) | Mobile already has waitlist + feedback. A compact signups/feedback/errors panel is worth it *because* the owner is the one in the field. |
| **Desktop inbox — full mailbox, drafts, AI reply/extract** | **Desk-only** | A 3-pane mail client on a phone is a worse mail client than the one already on the phone; AI actions need the device-local Ollama. |
| **Manifest analyzer** | **Desk-only** | It ingests 1000-row spreadsheets and maps columns. Mobile should show its *output* (unit count, retail value, top brands) on the lot card — not the tool. |
| **Sheet copy** | **Desk-only** | One-time admin operation on a Google file. |
| **Globe** | **Desk-only** | Decorative; zero field utility. |
| **Settings 24 → 7** | Covered in (a)/(b) | — |

**Ranked above all of these: refunds.** The audit lists it separately (P0-7 / F1) because the code exists and is orphaned — `toggleDfExpand`'s refund UI (`app.js:4988-5047`) is bound only to active cards while completed deals render through `renderDfDrawer`. So there is no path on a phone to record *or see* a refund. You are right that a broker needs refunds; it's also the cheapest of the lot, because it's re-wiring, not building.

---

## (d) Screens to reshape, not port

| Desktop screen | What breaks on a phone | Mobile pattern |
|---|---|---|
| **Invoices** (6-stat grid + wide table + row menu) | 6 stat tiles and 8 columns | One horizontal money strip (3 numbers: outstanding, overdue, this month) → filter pills → **card list**: client, amount, "due in 4 days", status pill, flow dots. Row menu becomes a detail sheet with actions stacked. Never a table. |
| **Clients** (table + bulk select + data-health panel) | Thousands of rows, ellipsised badges | **Card list** with sticky search and an A-Z scrubber rail; tier badge and the send-safety flags (blacklisted / no-bulk / unsubscribed) on their **own line** — today they're ellipsised out of existence inside `.list-name`. Bulk → a "Select" mode in the header. Data health → one dismissible banner that opens a filtered list. |
| **Deals** (kanban) | Horizontal columns are unusable | **Segmented control of stages with counts** (Lead · Quoted · Won · Lost), one stage at a time as a card list. Drag becomes "Move to" inside the card sheet. |
| **Deal flow** (multi-panel, suppliers + refunds + money) | Everything at once | **Stage stepper** at the top of the deal sheet, then collapsible blocks: Money · Suppliers · Refunds · Notes. Actions in a sticky bottom bar, not scattered through the scroll. |
| **Financials** (bank-txn table + rules + Plaid) | 7-column ledger | **Review queue**: one transaction per card — big amount, suggested match, Accept / Change / Skip. The ledger table stays desktop; rules stay desktop. |
| **Receivables / Payables** (5-bucket aged tables) | Bucket columns | Aging bar + card list grouped by bucket; **one primary action per card** (Record payment / Mark paid) plus call and text, thumb-reachable. These are the two screens worked from the road and today both are read-only. |
| **Analytics** (multi-chart + date range) | Multi-series legends | Vertical stack of single-metric cards each with a sparkline; date range as a segmented control (This month / Last / Quarter / Year); top-suppliers and top-clients as compact rows (already on the wire — `dashboard.rs:288,304`). |
| **Email** (3-pane inbox + newsletter in one view) | Two products in one screen | Split into two destinations. Newsletter = composer. Inbox = client-scoped thread inside the client detail + a single "Unread from clients" list. No folder tree. |
| **Inventory** (grid + bulk + media + manifest) | Dense grid, no search on mobile | Card list with photo thumb, search + status/category pills, lot sheet with a photo carousel. "Select" mode for bulk. **Camera capture as a first-class add** — the one place mobile should beat desktop. |
| **Completed breakdown / Closeout** (dense P&L) | Two-column table of money | **Receipt layout**: revenue, itemized cost rows, refunds, rep cut, rule, "your share". One column, right-aligned figures. |
| **Notes** (free canvas with x/y positions) | A canvas has no phone analogue | Ordered list with pin-to-top; store mobile ordering separately so mobile never writes desktop's layout coordinates. |
| **Client tiers** | 6 tiers in a 5-column CSS grid — visibly broken since v0.15.119 | 2-column grid, or a horizontal snap row of 6 tier cards with the client list beneath. |
| **Manifest analyzer · Sheet copy · Globe · CSV import** | — | Do not port. Surface their *outputs* where relevant (manifest stats on the lot card) and say "on desktop" where not. |

---

# APPENDIX C — APP STORE PATH

# TASK 3 — APP STORE REALITY CHECK

## Verdict, stated plainly

**The PWA cannot go on the App Store as-is.** Two hard blockers and one soft one:

1. **Guideline 4.2 / 4.2.2 (Minimum Functionality).** A WKWebView pointed at `https://ecliptr.app/app` is the textbook "repackaged website" rejection. I checked what the PWA actually touches natively: `navigator.clipboard` (3 sites), `mailto:`/`tel:` links, and one `<input type="file" accept="image/*">` (`www/app.js:1473`). Nothing else. No camera, no geolocation, no share, no offline data, no notifications. There is currently **zero** native surface to defend under 4.2.
2. **Guideline 2.5.2 (self-contained bundle).** Loading the entire app from a remote URL at runtime is the pattern reviewers flag. Assets must ship inside the `.ipa`; the API stays remote.
3. **Soft blocker — Guideline 3.1.1 (IAP).** Ecliptr sells $39/mo Pro and $99/mo Business (`www/landing.html:689-720`) that unlock in-app features. Detail below — this one has a legitimate, free workaround **right now**, and a much worse cost later. Timing matters.

The good news is much better than I expected going in. Four things that usually sink this kind of project are already done:

- **Bearer-token auth already exists server-side** — `src/employees.rs:955-964` accepts `Authorization: Bearer` as an alternative to the cookie, and login already returns the token (`:1794`, comment says "can store it and send it as `Authorization: Bearer`"). This removes the single nastiest Capacitor blocker (see §c).
- **Account deletion already exists** — `DELETE /api/account` (`src/employees.rs:2268`) and `POST /api/account/delete-workspace` (`:2326`), with a real cascade purge (`purge_org_data`, 26 org tables + PII token tables). The mobile PWA already has a "Delete my account" button (`www/app.js:1485,1509`). 5.1.1(v) is 80% satisfied, not 0%.
- **CI already has macOS runners** (`.github/workflows/release.yml:14` `macos-latest`) — iOS archive + TestFlight upload can run there. No Mac purchase is strictly required.
- **Everything is free during the beta** (`landing.html:668`: "Every plan is free during the open beta"). This is a genuine, expiring strategic asset for the 3.1.1 problem.

---

## (a) What is actually required to ship an iOS app from this codebase

### The three wrapper options, judged against *this* code

**Option 1 — Capacitor 7 wrapping `www/` (RECOMMENDED).**

Capacitor puts the existing `index.html` / `app.js` / `style.css` into the app bundle, serves them from `capacitor://localhost` inside WKWebView, and exposes native APIs as JS calls. The 6.7k-line single-IIFE `app.js` is *ideal* for this — no build step, no bundler, no framework migration. You add native capability incrementally, function by function, without rewriting a screen.

Concretely: `npm i @capacitor/core @capacitor/cli && npx cap init && npx cap add ios`, set `webDir` to a copy of `www/`, and the app boots. Realistic first-boot: **one day.** Then the real work (§b, §c) begins.

Fit notes specific to this repo:
- `sw.js` becomes dead weight inside the wrapper (service workers don't run on `capacitor://`). Its logic (`sw.js:32` `if (req.url.includes('/api/')) return;`) is replaced by native HTTP + a real cache. Keep `sw.js` for the browser PWA; branch on `window.Capacitor` at runtime.
- The `#update-banner` / `SKIP_WAITING` flow in `index.html` must be replaced by either App Store updates or Capacitor Live Updates.
- One codebase can serve both the browser PWA and the iOS app, which preserves the mobile-parity work in `PARITY-AUDIT-2026-07-26.md` rather than forking it.

**Option 2 — Tauri v2 Mobile with the desktop React app. Do not do this for v1.**

It's the seductive option ("one codebase, full desktop parity, we already use Tauri 2 — `src-tauri/Cargo.toml:16` `tauri = "2.0"`"). It's a trap here:

- The desktop is local-first: `rusqlite` + `r2d2` + ~57 React views + a `commands.rs` surface. Compiling for `aarch64-apple-ios` is feasible (rusqlite bundled cross-compiles), but you'd be shipping a *second* SQLite database and a *second* sync client to phones — exactly the class of divergence the parity audit exists to kill.
- Desktop-only features can't cross: the embedded WhatsApp Web webview (needs Tauri's `unstable` multi-webview, `Cargo.toml:16`), `tauri-plugin-drag`, `assetProtocol` scope `"**"` (`tauri.conf.json:26` — an iOS sandbox non-starter), `printpdf` PDF rendering, device-local Plaid.
- The UI is built for 1280x800 minimum (`tauri.conf.json` `minWidth: 900`). That is a full mobile redesign of 57 views, which is a rewrite wearing a costume.
- Tauri iOS tooling for App Store submission, push, and camera is immature relative to Capacitor's plugin ecosystem.

Revisit in 2027 if Tauri Mobile matures. Not now.

**Option 3 — Native SwiftUI or React Native rewrite. Right answer eventually, wrong answer for "soon."**

You would discard `app.js` and every parity fix in it, and rebuild against REST endpoints that the audit says still return partial payloads (S3 in the audit: `Deal` has no `client_name`, `list_inventory` omits `details_json`/`updated_at`). Six months minimum with one developer. The Capacitor route does not preclude this — Capacitor lets you replace individual screens with native view controllers later, so you can migrate the 3-4 screens that most need native feel (camera capture, lot list) without a big-bang rewrite.

### Non-negotiable prerequisites regardless of option

- **Apple Developer Program, $99/yr.** Individual enrollment: often same day, up to ~2 days. Organization (BJM Distributions LLC as seller): requires a **D-U-N-S number** and legal-entity verification, realistically **1-3 weeks**. Start this today; it costs nothing to have it done early and it is the longest lead time in the whole project.
- **Xcode on macOS** for the generated iOS project (signing, capabilities, Info.plist, privacy manifest). CI can build, but you will debug on a Mac.
- **A physical iPhone** for testing. Simulator won't test push, camera, or biometrics.

---

## (b) Apple review risks

### Guideline 4.2 / 4.2.2 — Minimum Functionality (the one that decides this project)

The text that matters: *"Your app should include features, content, and UI that elevate it beyond a repackaged website"* and *"If your app is not particularly useful, unique, or 'app-like,' it doesn't belong on the App Store."*

Reviewers apply this to wrappers aggressively. What defends it is **capability a browser cannot have**, visible on first launch. For a liquidation broker working warehouses and driving, these are the ones that are both defensible *and* genuinely useful — do not add native features as review theater, add the ones Jack will actually use:

| Native integration | Why it defends 4.2 | Real field value |
|---|---|---|
| **Camera capture for lot photos** (`@capacitor/camera`) | Direct hardware access, not a file picker | Photographing pallets in a warehouse is the #1 mobile job. Today it's `<input type="file">` at `app.js:1473` |
| **Barcode / label scan** (ML Kit or VisionKit) | Vision framework, impossible in browser | Scan a pallet label or UPC to jump straight to the lot |
| **Push notifications via APNs** | Genuinely impossible inside a wrapper webview | New lead, invoice paid, approval waiting, overdue invoice |
| **True offline read + write queue** | Native SQLite/filesystem persistence | Warehouses have no signal. Today `sw.js:32` explicitly never caches `/api/`, so offline = a blank app |
| **Face ID / Touch ID app lock** | LocalAuthentication framework | A phone with client financials and bank data on it |
| **Share-sheet + Files import** (`UTType` for xlsx/csv) | Registers as a system document handler | "Open manifest in Ecliptr" from Mail — this is exactly the manifest-analyzer workflow |
| **Home-screen widget** (WidgetKit) | Cannot exist from a webview at all | Today's cash / overdue total / approvals waiting |
| **Haptics + native transitions** | Feel, not features | The "high-end app" ask from Task 1/2 |

Ship at minimum: **camera, push, offline, Face ID lock, share-sheet import.** That combination has never in my experience read as a repackaged website. The widget and the scanner are the two that make a reviewer stop questioning it entirely.

Also relevant: **4.2.6** (apps from commercialized templates/app-generation services get rejected) — a hand-built Capacitor project is fine; PWABuilder's iOS output is closer to the line. Build the Capacitor project properly.

### Guideline 5.1.1(v) — Account Deletion (mandatory, and you are nearly there)

The rule: any app that supports account creation must offer an in-app path to **initiate account deletion**, and the deletion must actually delete the account and data (not just deactivate), with no "email support to delete" dead ends.

What you have: `DELETE /api/account` (`employees.rs:2268`) plus a mobile button (`app.js:1485`). What will get you rejected:

- **The sole-admin dead end.** `employees.rs:2288-2296` returns *"You're the only admin. Delete the whole workspace, or make someone else an admin first."* A solo broker — your most common user — hits that wall and has **no in-app way out**, because I grepped `www/app.js` and there is **no call to `/api/account/delete-workspace` anywhere in the mobile app.** That is a textbook 5.1.1(v) rejection. Fix: when the user is the only admin, the same flow must offer "Delete workspace and all data" with the password confirmation the server already requires (`DeleteWorkspaceRequest`, `employees.rs:2312`).
- Add a **web deletion URL** too (`ecliptr.app/account/delete`) — Apple doesn't require it but Google Play does (§d), and it's the same endpoint.
- **Data export before deletion.** `ORG_TABLES` (`employees.rs:2318`) already backs an export path. Offering it in the delete flow is good practice and reads well to a reviewer.

### Privacy: nutrition labels + privacy manifest

**App Privacy "nutrition labels"** (App Store Connect questionnaire). Ecliptr must honestly declare, at minimum:

- **Contact Info** — client names, emails, phones (`clients` table). Linked to identity. Used for App Functionality.
- **Financial Info** — invoices, payments, bank transactions. Note: even though Plaid is desktop-only today (I found **no** Plaid references in `www/app.js`), the app *displays* bank transaction data, and the Financials screens are in the parity backlog for mobile. Declare it.
- **User Content** — photos, notes, manifests.
- **Identifiers** — user ID, device token once push ships.
- **Diagnostics/Usage** — only if you add analytics. Currently none, which is the easiest possible answer here. Keep it that way for v1.

Critically: **do not check "Data Used to Track You."** You aren't, so no App Tracking Transparency prompt is needed. Mislabeling here is one of the fastest ways to get pulled post-launch.

**Privacy manifest (`PrivacyInfo.xcprivacy`)** — required since May 2024. You must declare "required reason" API usage (`NSPrivacyAccessedAPICategoryUserDefaults` — the app uses `localStorage` heavily, `app.js:99,105,121,2926,3182,5690`, which maps to UserDefaults in a wrapper; plus file timestamp and disk space APIs if the offline cache touches them). Capacitor ships manifests for its own plugins; the app-level one is yours to write. Missing it = automated rejection at upload, not even human review.

Also required in App Store Connect: **Privacy Policy URL** (you have `/privacy`), **Support URL**, **age rating** (17+ is not needed; this is a business tool), and **export compliance** — set `ITSAppUsesNonExemptEncryption = false` in Info.plist (HTTPS-only usage is exempt), otherwise every single build waits on a compliance question.

One thing you can skip: **Guideline 4.8 (Login Services)** does *not* apply. It's triggered by third-party/social login for account setup; Ecliptr is email + password (`index.html` login form, bcrypt server-side). No Sign in with Apple obligation. Don't let anyone tell you otherwise — it's a commonly misapplied rule.

### Guideline 3.1.1 — In-App Purchase. Read this section twice.

**The exposure is real.** Pro ($39/mo) and Business ($99/mo) unlock *features inside the app* — "Manifest cleaner", "Advanced analytics", "Client tiers", "Custom branding" (`landing.html:700-722`), enforced server-side by `plan_rank` / `plan_inventory_limit` (`src/employees.rs:734-800`). Under 3.1.1, *"if you want to unlock features or functionality within your app, you must use in-app purchase"* — at **30% (year one) / 15% (year two+ on subscriptions)**, or 15% flat under the Small Business Program (under $1M/yr, which is you).

Which escape hatches actually apply:

- **3.1.3(e) Goods and Services Outside of the App** — applies to *your customers' invoice payments* (a buyer paying BJM for a pallet). Physical goods consumed outside the app: **IAP is prohibited** there. So the "1% invoice fee via ACH" model in your commercial plan is **safe from Apple entirely.** That is the actual business, and Apple has no claim on it. Important and often missed.
- **3.1.3(c) Enterprise Services** — allows access to previously-purchased subscriptions if the app is *"only sold directly by you to organizations or groups for their employees."* Ecliptr has self-serve single-user signup at `/register` with a Free tier. Apple's own text says *"Consumer, single user, or family sales must use in-app purchase."* **This exemption will not hold** for Ecliptr as currently sold. Don't build a strategy on it.
- **3.1.3(b) Multiplatform Services** — allows users to *access* in the app what they bought on the web. This is the workable one, and it's how Slack, Notion, Basecamp, Linear, and essentially every B2B SaaS ships on iOS.

**The pattern that works, and it costs you nothing:**

The iOS app is **sign-in only**. No pricing, no plan comparison, no "Upgrade" button, no link to `/pricing`, no upsell copy anywhere in the binary. Users who need to upgrade do it on the web; the app reflects entitlement. Since `plan_rank` is enforced server-side already, this requires **no billing changes** — only a scrub of the mobile UI for any purchase-adjacent surface.

**And the timing gift:** during the free beta, every plan is $0 and there is nothing to sell. An app submitted today is *genuinely* a free app with no purchasable content. That's the cleanest possible 3.1.1 posture, and it disappears the day you switch paid plans on. **This is a strong argument to submit before billing goes live, not after.**

**One further development worth knowing:** following the April 2025 ruling in *Epic v. Apple*, apps on the **US storefront** may include external purchase links and buttons without Apple commission and without an entitlement. Several large apps now do. Two caveats before you rely on it: it is US-storefront only (your international users would still see the restricted build), and it is litigation-dependent. Treat it as an option to revisit at billing-launch time, not as v1.0 architecture.

**Rule for v1.0: zero purchase surface in the binary.** Revisit when paid plans switch on — and budget real engineering for it then, because "add IAP later" means StoreKit 2, server-side receipt validation against App Store Server API, entitlement reconciliation between Apple subscriptions and your `orgs.plan` column, and handling the case where a user pays Apple on iPhone and expects it on desktop. That's 3-4 weeks of work, and it is *not* v1.0 work.

### Other review items specific to this app

- **2.1 App Completeness** — you must supply working **demo account credentials** in App Review notes. You already run a demo workspace (`scheduler::DEMO_ORG_ID`, `employees.rs:766`) capped at 10 inventory items. Seed it with realistic data; a reviewer who logs into an empty app rejects it as incomplete. This is a genuine advantage over most B2B submissions.
- **2.5.2** — ship assets in the bundle. The relevant carve-out (JavaScript executed in a WKWebView may be updated as long as it doesn't change the app's primary purpose) is what makes Capacitor Live Updates legitimate — see §c on release cadence.
- **Google OAuth**, if Sheets integration ever comes to mobile: Google **blocks OAuth in embedded webviews** (`disallowed_useragent`). It must go through `ASWebAuthenticationSession`. Not a v1 issue (mobile has no Google OAuth today) but it will bite when `bank_backup.rs`-style features reach the phone.
- **Plaid**, likewise: bank OAuth flows fail in a plain WKWebView. If Financials comes to mobile, use the Plaid Link iOS SDK or `ASWebAuthenticationSession` with universal-link redirects.

---

## (c) Engineering checklist

**Identity and signing**
- Bundle ID: register a **new** one, e.g. `app.ecliptr.mobile`. Do not reuse `com.bjmdistributions.clienthub` (`tauri.conf.json:6`) — that's the desktop's, and post-rebrand it's the wrong name to be locked into forever. Bundle IDs are permanent.
- App ID with capabilities: Push Notifications, Associated Domains (deep links), Keychain Sharing.
- Distribution certificate + provisioning profile. Use **Xcode Cloud** or `fastlane match` on the existing `macos-latest` runner. Manual profile juggling will waste days.
- App Store Connect app record, SKU, primary category **Business**, secondary **Productivity** (matches `manifest.json` `categories`).

**Auth and networking — the specific gotcha, and why it's cheap for you**
- Bundled assets load from `capacitor://localhost`, so every call to `https://ecliptr.app` becomes cross-origin. The current auth cookie is `HttpOnly; SameSite=Strict` (`employees.rs:509`) and **will not be sent**. Every `credentials: 'include'` call in `app.js` (`:143,150,160,169,177,645,6520`) would 401.
- **Fix, already half-built:** switch the mobile `api` object to `Authorization: Bearer` — the server accepts it at `employees.rs:955-964` and login already returns the token (`:1794`). Store it in the **iOS Keychain** via `@capacitor/preferences` with `keychain` backing (never `localStorage`). This is roughly a 40-line change in `app.js` plus a keychain read at boot.
- There is currently **no `CorsLayer` anywhere in the server** (I grepped `src/` — zero hits). Either add one allowing `capacitor://localhost` and `https://localhost`, or enable `CapacitorHttp` so requests go through native `URLSession` and skip CORS entirely. The native-HTTP route is preferable: it also gives you proper timeouts and background behaviour.
- JWT is 7 days (`JWT_EXPIRY_SECS`, `employees.rs:36`) with a 37-day effective window. For an app on a phone that's short — silent re-auth or a longer refresh window, or field users get logged out mid-warehouse. Memory notes JWT-expiry pain already.

**Push notifications (APNs) — the PWA approach does not merely need porting; there is nothing to port**
I searched `www/app.js` for `Notification`, `pushManager`, `showNotification`, `VAPID`, `serviceWorker` — **zero matches.** There is no web-push implementation at all. And even if there were, Web Push does not function inside a WKWebView wrapper. So:
- APNs key (`.p8`, team ID + key ID) — token-based auth, not certificates.
- `@capacitor/push-notifications`, register on launch, POST the device token to a new `device_tokens` table (org-scoped, one row per device, tombstoned on sign-out).
- **Server sender in Rust:** HTTP/2 POST to `api.push.apple.com` with an ES256 JWT. Both dependencies are already in `Cargo.toml` — `reqwest` with rustls (`Cargo.toml:28`) does HTTP/2, and `jsonwebtoken = "9"` (`:15`) supports ES256. Maybe 150 lines. The existing scheduler is the natural trigger point.
- Prompt for permission **contextually** (after the first approval or invoice, not on launch), and the app must work fully if denied.
- Worth sending: approval pending, invoice paid, invoice overdue, new lead from the web form, sync failure. Not: newsletters.

**Offline behaviour — biggest real-world gap, and a 4.2 asset**
Today the SW explicitly refuses to cache API responses (`sw.js:32`). In a warehouse dead zone the app opens to an empty shell and an offline banner (`app.js:358-364`). For v1: persist last-known clients / inventory / invoices / deal flows to native storage, render them with a clear "as of 14:20" staleness marker, and queue writes (photos especially) for replay on reconnect. Note the audit's S4 finding — boot-cached globals `_clients`/`_suppliers`/`_clientTiers` are *already* a stale-data source; the offline layer must be built on top of that fix, not instead of it.

**Deep links**
Associated Domains + `apple-app-site-association` served from `ecliptr.app`. Targets: storefront `/i/:token`, client portal, invoice links, password reset (`/reset`), invite links (`app.js:894`). Without this, an emailed invoice link opens Safari and the user is signed out.

**Assets**
1024x1024 App Store icon (no alpha, no rounded corners — the existing `icon-512.png` needs a clean 1024 regeneration; `gen_icons.py` exists). Native launch storyboard, not an image. Screenshots: 6.9" and 6.5" iPhone required — take them from the redesigned screens, with real-looking demo data, never a lorem-ipsum shell.

**Versioning and release cadence — a workflow change worth naming out loud**
`CFBundleShortVersionString` should track your existing scheme (desktop is at 0.15.122 — start iOS at **1.0.0**, since "0.15" reads as beta to a reviewer). `CFBundleVersion` increments per upload.

The real cost: **you currently ship several times a day by scp'ing `app.js` and bumping `CACHE` in `sw.js`.** Inside a wrapper, that becomes a 24-48h App Review cycle. Mitigation: **Capacitor Live Updates** (or a self-hosted equivalent) — permitted under the 2.5.2 JavaScript carve-out as long as updates don't change the app's primary purpose. Set this up *before* the first submission, or the App Store version will fall behind the web version within a week.

**TestFlight**
Internal testers: up to 100 App Store Connect users, no review, builds live in minutes. External: up to 10,000, requires a lightweight Beta App Review on the first build (typically ~24h). Builds expire after 90 days. **TestFlight is the honest answer to "soon"** — Jack and his team can be running the real native app weeks before public launch.

---

## (d) Android / Play as a comparison

**A TWA is dramatically easier.** Bubblewrap or PWABuilder wraps the existing PWA in a Chrome Custom Tab-backed activity: no code changes, no `app.js` fork. Requirements: `/.well-known/assetlinks.json` on `ecliptr.app`, a $25 one-time Play Console fee, target API 35, a signed AAB. **Two days of work, most of it paperwork.**

But be honest about the value:

- **Google Play requires the same account-deletion path** (in-app *and* a public web URL) — same fix as §b, so that work is shared.
- **Data safety form** — same content as Apple's nutrition labels. Shared.
- **The trap:** if the Play developer account is a *personal* account created recently, Google requires **closed testing with 12 testers for 14 continuous days** before you can apply for production. Registering BJM Distributions as an **organization** account avoids this. Decide that before you register, not after.
- **A TWA is still a browser.** It inherits every offline and notification limitation. It is not "the mobile app done," it's the PWA in a different envelope.

**My honest read:** the cheaper first win on Play is only a *business* win if Jack's team and buyers are on Android. If everyone in the field is on iPhone, a Play listing is a vanity artifact. Its real value is as a **rehearsal**: it forces you to produce the icon set, screenshots, store copy, privacy policy, data-safety answers, and the account-deletion flow — all directly reusable for Apple, at a fraction of the risk. And once you're on Capacitor, `npx cap add android` gives you a *real* Android app (camera, push, offline) for nearly free, which is strictly better than a TWA.

**Recommendation: skip the standalone TWA. Do Capacitor, and take Android as a byproduct in Phase 3.**

### The path most people miss — and it may be your actual answer to "soon"

If the near-term goal is *"my team and my buyers have this on their phones,"* the public App Store is not the only door:

- **TestFlight** — up to 10,000 external testers, 90-day build expiry, one lightweight review. For a company tool with a handful of users this is a **fully viable indefinite distribution channel**, available in weeks, with 4.2 pressure dramatically lower.
- **Apple Business Manager Custom Apps** — distribute privately to specified organizations. Still reviewed, but "narrow business audience" is the *expected* profile rather than a liability, and 4.2/3.1.1 scrutiny is far lighter. Apple's own guidance under 4.2 points limited-audience business apps here.
- **Unlisted App Store distribution** — a real store listing with a direct link, not searchable or discoverable.

If "on the App Store" means *"a polished native app my people can install"* rather than *"discoverable in App Store search,"* TestFlight gets you there in about a month and the rest is optional.

---

## (e) A realistic answer to "soon"

**Nothing ships in days. TestFlight is achievable in 3-5 weeks. A credible public v1.0 is 10-14 weeks.** Anyone promising the App Store in two weeks is describing the 4.2 rejection, not the launch.

**Phase 0 — this week (mostly waiting, so start now)**
Enroll in the Apple Developer Program (org enrollment with D-U-N-S: 1-3 weeks of pure latency — this is the critical path and it costs nothing to start). Register the bundle ID. Decide Individual vs Organization seller name. Regenerate a clean 1024 icon.

**Phase 1 — weeks 1-2: shell + auth (parallel with Phase 0's waiting)**
Capacitor project, `www/` bundled, `Authorization: Bearer` + Keychain, CORS or CapacitorHttp, native HTTP layer, safe-area insets, deep links, launch storyboard, first `.ipa` on a real device. **Exit criterion: Jack signs in on his own iPhone from a locally-built app.**

**Phase 2 — weeks 2-5: the 4.2 work + compliance (the real work)**
Camera capture, push end-to-end (client + Rust APNs sender), offline read cache + write queue, Face ID lock, share-sheet/Files manifest import, sole-admin account-deletion fix, `PrivacyInfo.xcprivacy`, seeded demo workspace, purchase-surface scrub. **Exit criterion: internal TestFlight build, no `/api/` call fails offline, a push notification wakes the phone.**

This phase must land **concurrently with the Task 1/2 redesign**, not after it. Shipping the current "More = a list of sections" navigation to the App Store would waste the launch — and a reviewer scrolling a flat list of section names is *also* being handed 4.2 ammunition.

**Phase 3 — weeks 5-8: parity + polish**
The P0s from `PARITY-AUDIT-2026-07-26.md` (S1 merge-on-write especially — you cannot ship an App Store app that NULLs supplier payment fields), the redesigned navigation and Settings, widget, haptics, transitions, external TestFlight with real users. `npx cap add android` here if wanted.

**Phase 4 — weeks 8-12: submission**
Screenshots, store copy, privacy labels, export compliance, demo credentials in review notes, submit. **Budget 2-3 review cycles.** First submissions of wrapper apps get 4.2 questions even when they shouldn't; a prepared reply enumerating camera / push / offline / biometrics / Files-handler / widget usually resolves it in one round.

### Minimum credible v1.0 scope

Cut aggressively. v1.0 does **not** need every desktop feature — it needs the field workflows to be *excellent* and everything present to be *correct*:

**In:** dashboard/today queue · clients (view, edit, call, log) · invoices (view, send, mark paid) · deal flows · inventory + lot photos via camera · approvals · notes · redesigned Settings · offline read + queued writes · push · Face ID lock · account deletion.

**Out of v1.0:** Plaid/bank connection (webview OAuth problem, desktop-only today) · newsletter composition (send from desktop; review on mobile) · Google Sheets sync (OAuth-in-webview problem) · manifest analyzer authoring (import + view only) · superadmin console · invoice PDF authoring.

**The bar for shipping, and it is not negotiable:** every feature in v1.0 must be *correct*, because App Store users cannot be hot-patched the way `scp app.js` patches them today. The parity audit's P0 list is a **release blocker**, not a backlog. A mobile save that silently NULLs a supplier's payment details is survivable when you can push a fix in ten minutes. It is not survivable behind a 48-hour review queue.

**One-line summary for the roadmap:** Enroll with Apple today; Capacitor over `www/`; native camera + push + offline + biometrics to clear 4.2; zero purchase surface in the binary to sidestep 3.1.1 while the beta is free; fix the sole-admin account-deletion dead end for 5.1.1(v); TestFlight in about a month; public v1.0 in about three.

---

# APPENDIX D — NATIVE FEEL AUDIT

Read the two audits' framing, then audited `app.js` (6,759 lines), `style.css` (2,097), `index.html`, `sw.js`, plus the Axum static/JSON serving path. Findings below are all file:line verified.

---

# TASK 4 — WHY THE MOBILE APP READS AS A WEB PAGE

**Verdict up front:** the app already has a "native feel layer" (`app.js:291-372` — pull-to-refresh, scroll-to-top, offline banner, skeletons) and it is genuinely good work. The problem is that the layer sits on top of an architecture that contradicts it: **no history, no navigation stack, no scroll memory, no client-side data cache, no compression, and a service worker that hangs on a weak signal.** The polish is visible; the substrate is not native. Below, ordered by how loudly each one says "browser".

Paths: mobile = `C:/Users/Jack/Desktop/clienthub-api/www/`, server = `C:/Users/Jack/Desktop/clienthub-api/src/`.

---

## (a) NAVIGATION FEEL

**A1 · There is no history integration at all. Zero.**
`grep pushState|replaceState|popstate|hashchange` across `app.js`, `index.html`, `sw.js` returns **nothing**. Consequences on a real device:
- **Android, installed PWA: the hardware/gesture back button closes the app.** Not "goes back a screen" — quits. From any screen, at any depth. This is the single most jarring non-native behaviour in the product.
- iOS installed PWA: the system edge-swipe does nothing (there is a hand-rolled substitute, A3).
- No deep links. `manifest.json` `start_url: "/"` always boots to Dashboard; a push notification or a shared link can never open an invoice.

**A2 · Every screen change is a full `innerHTML` wipe.**
`setContent(html) { $('#app-content').innerHTML = html; }` — `app.js:240`, called **60 times**; `innerHTML =` appears **91 times** total. `navigateTo` (`app.js:721-731`) sets the title then calls `render(tab)` (`:733-764`), a 23-case switch that each replaces the entire content pane. There is no old view, so there is nothing to transition *from*. The only motion is `#app-content > * { animation: pageIn 0.22s ease }` (`style.css:249`) — a fade-up applied independently to every direct child, which on the More screen means ~28 rows all fading in at once rather than a page moving.

**A3 · Detail views are stacked `position:fixed` overlays with no stack.**
`openDetailPanel` (`app.js:429-477`) appends `<div class="detail-panel" id="active-detail">` to `document.body` (`style.css:801-810`, `inset:0; z-index:90`). Two hard problems:
- **The id is hardcoded.** Both close buttons call `document.getElementById('active-detail').remove()` (`app.js:436, 439`). If two panels ever coexist, `getElementById` returns the *first*, so closing the top panel removes the one underneath.
- **The code works around this by destroying the parent.** Drilling client → invoice does `panel.remove(); showInvoiceDetail(...)` (`app.js:3574`). Same at `:3526` (Edit), `:3542` (Add note), `:4312`, `:4324`. **Closing the invoice therefore returns you to the client *list*, not the client.** A native app pushes and pops; this one bulldozes.

**A4 · Dead-end screens with no way back.**
`renderMyAccount()` (`app.js:1462`), `renderCheckups()` (`:1345`), `renderCheckupSession()` (`:1383`), `renderFeedbackInbox()` (`:1554`), `renderWaitlist()` (`:1585`) all `setContent()` in place from a More-tab tap (`app.js:1146-1150`) and render **no back control**. They are not tabs, so `currentTab` still says `more`; the only escape is tapping a bottom tab. `.back-btn` exists in `style.css:1197-1204` and is used nowhere in `app.js`.

**A5 · Scroll position is never preserved.**
The only `scrollTop` reads in the file are the pull-to-refresh guard (`app.js:313, 320`) and the scroll-to-top threshold (`:354`). Replacing `#app-content.innerHTML` collapses height to 0 and the browser clamps `scrollTop` to 0. So: scroll 40 invoices down → open one → close → **back at the top**. Every filter-pill tap does the same (`app.js:3975`).

**A6 · The one good gesture is panel-local.**
`wireSwipeBack` (`app.js:446-475`) is a genuinely nice iOS-style left-edge dismiss — but it is bound *inside* `openDetailPanel`, so it exists only on detail overlays. Tab screens and the dead-end screens in A4 have no gesture at all.

---

## (b) PERCEIVED PERFORMANCE

**B1 · Nothing is compressed. Anywhere.**
`Cargo.toml:14`: `tower-http = { version = "0.5", features = ["cors", "fs", "set-header", "catch-panic"] }` — **no `compression-gzip`/`compression-br` feature, and no `CompressionLayer` in `src/main.rs`**. `main.rs:190` is `.fallback_service(ServeDir::new("www"))` raw.
- `app.js` = **406,495 bytes**, `style.css` = **94,903 bytes** → ~**490 KB of uncompressed text** for the shell.
- Every JSON response is also raw. `/api/invoices` returns `INVOICE_COLS` (`src/routes/invoices.rs:198-203`) which includes the **full `line_items_json` and `cost_items_json` blobs for every invoice**, with **no `LIMIT` anywhere** in `clients.rs`/`invoices.rs`/`inventory.rs`. For a broker with a few hundred invoices this is a multi-megabyte payload, parsed on the phone's main thread.

This is the highest-leverage single line in the whole audit.

**B2 · Boot is 13 requests in 5 sequential waves.**
`checkAuth` (`app.js:611-629`): `/api/auth/employee/me` → `pollApprovals()` → `await loadClients()` → `await loadSuppliers()` (**sequential, not `Promise.all`** — `:622-623`) → `loadPayoutRecipients()` → `navigateTo()`. Then `renderDashboard` (`:2976`) does `await buildOnboarding()` — itself 3 parallel calls (`:2933-2937`) — **and only then** the 5-call `Promise.all` at `:3025-3031`, which re-requests `/api/approvals/count` that `pollApprovals` already fetched.
Worse: `buildOnboarding` fires those 3 calls on **every** dashboard render forever, and returns `''` when all four steps are done (`:2945`). An established account pays 3 wasted round trips every time they tap Home.

**B3 · Settings taps into a void.**
`renderSettings` (`app.js:6121-6145`) is the worst offender: **four sequential `await`s** (`:6126-6129` — company, payment-methods, smtp, org) and the first `setContent` is at `:6163`, *after* all of them. There is **no skeleton, no spinner, no state change**. Tap "Settings" in More on LTE and for roughly a second the phone shows you the More list, unchanged, as if the tap missed. Same pattern: `renderApprovals` (`:2735-2741`), `renderFeedbackInbox` (`:1554-1561`), `renderCheckupSession` (`:1383-1388`), `renderRecurring` (`:6487`), `renderScheduled` (`:6662`), `renderHistory` (`:6703`).

**B4 · Detail panels have no loading state at all.**
`showClientDetail` (`app.js:3420-3444`) makes **four sequential round trips** before painting anything: client → invoices → interactions → **`/api/deal-flows` (the entire pipeline, unpaginated)** just to sum one client's profit (`:3439-3442`). `showInvoiceDetail` (`:4223`) awaits before painting too. Tapping a row does nothing visible until all of it lands.

**B5 · The 15s timeout renders wrong numbers instead of an error.**
`FETCH_TIMEOUT = 15000` (`app.js:133`), `AbortController` at `:135-139`. On abort `api.get` throws — and the call sites swallow it: `api.get('/api/dashboard/stats').catch(()=>({}))` (`:3026`). `s = {}` → `s.revenue_mtd || 0` → **the dashboard renders $0 revenue and $0 profit as though that were the truth.** Same shape at `:2994-2995`, `:3027-3031`, `:4619-4622`. For a money tool used in the field this is worse than a spinner.

And three critical awaits have **no `.catch` at all** — `renderInvoices` `:3937`, `showClientDetail` `:3421`, `showInvoiceDetail` `:4223`. `render(tab)` is invoked un-awaited and un-caught at `:730` and `:370`, so these become unhandled rejections: **the invoice skeleton stays on screen forever**, and tapping a client on a bad connection does literally nothing.

**B6 · Layout shift.** Inventory thumbnails (`app.js:2520`) and the lot hero (`:2550`) carry no `width`/`height`/`aspect-ratio`, no `loading="lazy"`, no `decoding="async"` — the whole list's photos load eagerly and reflow as they arrive. The count-up animation (`animateCounts`, `:271-288`) also re-widths the hero figures for 600 ms, though `font-variant-numeric: tabular-nums` (`style.css:2062`) limits the damage.

**B7 · Search rebuilds everything, per keystroke.** `loadClientList` (`app.js:3379-3418`) is debounced 250 ms (`:3370`) and then rebuilds the **entire** client list innerHTML and re-binds **one click listener per row** (`:3415-3417`). No windowing, no `DocumentFragment`, no delegation. Same in `renderInvoiceList`.

---

## (c) TOUCH & INPUT

**C1 · The biggest lists give zero press feedback on iOS.** `-webkit-tap-highlight-color: transparent` is global (`style.css:40`), which correctly kills the grey flash — but then `:active` has to do the work, and on iOS Safari `:active` **does not fire on a non-interactive element** unless it has a touch handler or `cursor:pointer`. A `click` listener does not qualify. There are **8 `<div class="list-item">`** vs 15 `<button class="list-item">`, and the divs are the three highest-traffic lists in the app: **Clients `app.js:3402`, Invoices `:4018`, Tiers `:1754`** (plus client-detail invoices `:3505`, timeline `:3515`, archive `:1009`, settings `:6220`). Tap a client row on an iPhone and you get *nothing* — no highlight, no ripple — then a panel appears half a second later. That is the exact sensation of a web page.

**C2 · Sub-44px targets, clustered.** `#header-action`, `#header-sync`, `#header-bell` are all **36×36** and adjacent (`style.css:179, 187, 197`). `.filter-pill` is `padding: 6px 14px; font-size:13px` ≈ **32px tall** (`:1165ff`). `.note-dot` is **13×13** (`:452`). `.onboard-dismiss` **24×24** (`:221`). `.line-item-row button` is `padding:4px` ≈ 24px (`:762`). The rest of the app *does* honour 44px (`.btn-sm`, `.chk-tab`, `.cat-add .btn`), so this is inconsistency, not ignorance.

**C3 · The only "create" affordance is top-right, 36px.** `#header-action` (`index.html:128`) — the far corner of a 6.7" phone, one-handed, in a warehouse. A FAB or a bottom-anchored primary action is the native answer.

**C4 · Non-passive `touchmove` on the scroll container.** `app.js:317-326` registers `content.addEventListener('touchmove', …, { passive: false })` on `#app-content` — the app's *only* scroller. Even though the handler early-returns when not pulling, its mere presence forces the browser off the compositor fast path: every touchmove must round-trip to the main thread before the page can scroll. With a 500-row DOM list and a busy main thread this is a real, measurable source of scroll stutter. The pull-to-refresh is worth keeping — the non-passive listener should only be attached once a downward pull at `scrollTop === 0` has actually begun.

**C5 · 23 native browser dialogs.** `confirm()` × 22 and `prompt()` × 1 — `app.js:829, 912, 1510, 1606, 2275, 2395, 2474, 2591, 3594(prompt), 4197, 4392, 4404, 4822, 4829, 4848, 4937, 5212, 5302, 5437, 5562, 5632, 6112, 6652`. On an installed iOS PWA these render as **"ecliptr.app says…"** — the domain name, in a system alert, blocking the main thread, undismissable by gesture, unstyled, ignoring dark mode. Several are on the most consequential actions in the product ("Mark this deal as fallen through", "Submit $0 as the supplier cost", the credit-limit `prompt`). Meanwhile a correct, well-designed bottom-sheet confirm **already exists** (`confirmDeleteClient`, `app.js:481-514`, `.modal-card` at `style.css:640`). The good component is written and 23 sites don't use it.

**C6 · No haptics.** `navigator.vibrate` appears zero times. Android would take it today; iOS Safari ignores it entirely (real iOS haptics require a native wrapper — see the App Store note).

**C7 · No keyboard handling.** No `visualViewport` listener anywhere. When the soft keyboard opens over a bottom-sheet form (`.modal { max-height: 85vh }`, `style.css:611`), nothing scrolls the focused field into view and the sticky footer buttons can end up under the keyboard.

**C8 · Good news, for the record:** inputs are all `font-size:16px` so iOS never zoom-jumps on focus (`style.css:73, 128, 460, 659, 737, 762, 1080…`); safe-area insets are handled properly at the header (`:171, 818`), tab bar (`:257`), sheets (`:614, 643`), and floating chrome (`:2007, 2024, 2038`); and there is **not a single `:hover` rule in the entire stylesheet** — which is exactly right for touch and rarer than it should be.

**C9 · `user-scalable=no`** in `index.html:5`. iOS ignores it, Android doesn't — it blocks pinch-zoom, which is an accessibility failure and a likely flag in an App Store accessibility pass.

---

## (d) MOTION

**What animates today:** `pageIn` fade-up on content children (220 ms, `style.css:249`); `slideUp` for sheets (250 ms, `:622`); `slideRight` for detail panels (250 ms, `:810`); `:active` scale on buttons/tabs/chips (120-130 ms); the PTR disc; the sync-button spin; `loginRise`; `bannerIn`; `fadeIn` on toast; skeleton shimmer; `animateCounts` count-up.

**D1 · There is no motion system — there are 18 durations.** Counting every `transition`/`animation` value in `style.css`: `0.12s`×8, **`130ms`×7**, `0.2s`×7, `0.25s`×4, `0.15s`×3, `0.22s`×2, `0.18s`×2, `0.13s`, `0.24s`, `0.28s`, `0.3s`, `0.5s`… The declared house rule (`--ease` with its "130ms ease-out" comment, `style.css:31`) is used **7 times in 2,097 lines**. Everything else is ad hoc, and the two most-seen transitions in the app — page-in at 220 ms and sheet/panel at 250 ms — are both off-system.

**D2 · Nothing animates that carries meaning.** The four things a broker actually watches are unanimated:
- **Stage advance.** Marking payment received (`app.js:5310`) calls `loadDealFlowsData()` → both lists rebuilt from scratch → the card vanishes and reappears elsewhere, scroll at top. The `.flow-dots` (`style.css:706-717`) just re-render in a new colour. There is no dot filling, no card sliding between sections, no sense that *something happened because you did it*.
- **List insertion/removal.** Adding a client or archiving an invoice → whole-list rebuild. No enter/exit.
- **Toast.** `fadeIn 0.3s` in (`style.css:1205`) then `t.remove()` at 4000 ms (`app.js:250`) — it **vanishes instantly**, no exit animation.
- **Tab bar.** `.tab.active::before` (`style.css:265-268`) is a pseudo-element indicator with no transition — it teleports between tabs.

**D3 · No `prefers-reduced-motion` block in CSS.** One JS check exists (`app.js:273`, for the count-up); the 12 keyframe animations are unguarded.

---

## (e) OFFLINE / RESILIENCE — the warehouse problem

**E1 · The service worker is network-first with no timeout. On a weak signal the app shows a white screen.**
`sw.js:31-41`:
```js
e.respondWith(
  fetch(req)
    .then(res => { …cache.put…; return res; })
    .catch(() => caches.match(req).then(r => r || caches.match('/')))
);
```
The cached shell is only consulted when `fetch` **rejects**. One bar of signal in a warehouse doesn't reject — it *stalls*. iOS will sit on that socket for tens of seconds. So the failure mode isn't "app opens offline", it's "**app opens to nothing, for 30+ seconds, then works**". Combined with 490 KB of uncompressed shell (B1) and `Cache-Control: no-cache` forcing revalidation on every asset (`main.rs:192-195`), cold start on bad signal is the single worst experience in the product.

**E2 · `/api/` is deliberately excluded from the SW** (`sw.js:30`, `if (req.url.includes('/api/')) return;` with the comment "never cache API — always live data"). Correct instinct — a broker must never see stale money — but the implementation means **there is no offline read path whatsoever**. There is no IndexedDB, no localStorage data cache (`localStorage` is used only for theme/accent/dashboard-range/brief-days — `app.js:99,105,121,130,213,217,2926-2927,3182,3215,5690-5724`). Walk into a metal-roofed warehouse and the app is a shell with a "You're offline" pill and zero data — no client list, no phone numbers, no lot details. Those are precisely the things a broker needs *in* the warehouse.

**E3 · No write queue.** Every mutation is a bare `api.post/put` that fails with a toast. Offline, the work is simply lost.

**What it *should* do for a field tool:** cache-first-then-revalidate for the shell (opens instantly, always); a local mirror of the read-heavy entities so screens paint from disk in <50 ms and reconcile in the background; explicit staleness on money figures ("as of 14:32") rather than silent zeros; and an outbox so a supplier payment recorded in a dead zone lands when you get back to the truck.

---

## (f) STATE

**F1 · Boot-cached globals as truth.** `_clients`, `_suppliers`, `_payoutRecipients` are loaded once in `checkAuth` (`app.js:516-531, 622-624`) and refreshed only by `syncNow` (`:540-560`). This is already logged as **S4** in `PARITY-AUDIT-2026-07-26.md` as a *correctness* problem (newsletter audiences, counts, name lookups). It is also a *feel* problem: the app can't tell you it's showing you something from an hour ago.

**F2 · Zero optimistic updates; every mutation triggers a full refetch of everything.**
`loadDealFlowsData()` (`app.js:4618-4633`) refetches **`/api/deal-flows` AND the entire `/api/invoices` dump**, then rebuilds both pipeline lists. It is called from **8 mutation sites** — `:4827, 4835, 4842, 4845, 4853, 5259, 5310` plus refresh `:4613`. Same pattern with `renderInvoices()` after every invoice action (`:4336, 4363, 4397, 4411, 4423, 4575`) and `renderClients()` after archive (`:3537, 3883`). So: tap "Mark paid" → button says "Saving…" → 2 full table dumps → whole screen rebuilt → scroll at top → find your card again. Native apps mutate the one row and animate it.

**F3 · One counter-example proves the team already knows better.** `wireFlag` (`app.js:3548-3569`) toggles the client flags **in place** from the server's authoritative bool, mirrors it into every in-memory cache, and explicitly comments "no jarring re-render". That is exactly the right pattern. It exists once.

---

# WORKPLAN — ordered by perceived quality per unit of effort

## Tier 0 — hours each, no architectural change, disproportionate payoff

**0.1 · Turn on compression.** `Cargo.toml:14` add `"compression-gzip", "compression-br"`; `src/main.rs` add `.layer(CompressionLayer::new())`. ~490 KB shell → ~110 KB; JSON payloads drop 5-10×. **One line of real work; it improves every screen, every device, forever.** Do this first.

**0.2 · Fix the service worker: cache-first shell + timeout race for everything else.** ~25 lines in `sw.js`. Shell (`/`, `/app.js`, `/style.css`, fonts) served from cache immediately and revalidated in the background; other GETs race `fetch` against a 3s timer and fall back to cache. Kills the warehouse white screen.

**0.3 · Replace all 23 `confirm()`/`prompt()` with the existing bottom sheet.** Wrap `modalOverlay` + `.modal-card` in a promise-returning `confirmSheet({title, body, confirmLabel, danger})` and mechanically swap the 23 sites listed in C5. Biggest single "this is a real app" delta per line changed. Mechanical, low-risk, reviewable.

**0.4 · Make every row press.** Convert the 8 `<div class="list-item">` (C1) to `<button>` — they already carry click handlers — and unify `:active` to one scale token. Restores instant tactile feedback on the three most-used lists.

**0.5 · Skeleton-first contract.** Rule: *the first statement of every `render*` is `setContent(…)`.* Fix `renderSettings` (`:6121`), `renderApprovals` (`:2735`), `renderFeedbackInbox` (`:1554`), `renderCheckupSession` (`:1383`), `renderRecurring`/`renderScheduled`/`renderHistory` (`:6487/6662/6703`), and add a skeleton body to `openDetailPanel` so panels appear on tap and fill in.

**0.6 · Collapse sequential awaits into one wave.** `renderSettings` 4→1 (`:6126-6129`); `showClientDetail` 4→1 (`:3421-3443`); boot `loadClients`/`loadSuppliers` (`:622-623`); drop the duplicate `/api/approvals/count`; and gate `buildOnboarding()` on a localStorage "completed" flag so it stops costing 3 calls per Home visit (`:2931-2945`).

**0.7 · Stop rendering failures as zeros.** Replace `.catch(()=>({}))` on money screens with a state that renders `retryBlock` (already written, `app.js:258`) plus a "showing data from HH:MM" line. Add `.catch` to the three uncaught awaits (`:3937, 3421, 4223`) and a `.catch` to `render(tab)` at `:730`.

**0.8 · Motion tokens.** Three variables — `--dur-tap: 130ms`, `--dur-sheet: 200ms`, `--dur-push: 260ms` — and replace all 18 values. Add a `prefers-reduced-motion` block. Add a 130ms exit to the toast, a slide to the tab indicator, and drop `pageIn` from 220 ms to 130 ms.

**0.9 · Fix the non-passive scroll listener** (C4): attach the non-passive `touchmove` only after a downward pull starts at `scrollTop === 0`, detach on `touchend`. Pure win, no behaviour change.

## Tier 1 — days, still vanilla JS, needs a small shared "shell" module

**1.1 · A navigation stack + real history.** ~120 lines. One array of `{screen, params, scrollTop}`; `navigateTo`/`openDetailPanel` push, `popstate` pops. This single change delivers: Android hardware back, iOS edge-swipe on every screen, back buttons on the A4 dead-end screens, deep-linkable URLs, and the prerequisite for 1.2/1.3.

**1.2 · Stop destroying parent panels.** Give each panel a unique id, stack by z-index, and let the stack pop. Fixes client→invoice→back (A3). Depends on 1.1.

**1.3 · Scroll restoration.** `Map<screenKey, scrollTop>`, saved on push, restored on pop (`requestAnimationFrame` after paint). Depends on 1.1.

**1.4 · Surgical mutation updates.** Generalise the `wireFlag` pattern (F3): after a mutation, patch the affected card from the server's response and animate the change; refetch in the background. Apply to the 8 `loadDealFlowsData()` sites and the 6 `renderInvoices()` sites first — that's the deal-flow experience, which is the app's core loop.

**1.5 · Paginate the list endpoints.** Add `LIMIT`/`offset` (or cursor) to `/api/clients` and `/api/invoices`; return first 50 and load more via `IntersectionObserver`. Also strip `line_items_json`/`cost_items_json` from the *list* payload (`invoices.rs:198`) — nothing in the list view reads them. Note this dovetails with audit finding **S3**, which is already adding derived fields to these payloads: do both in one pass.

**1.6 · One shared list renderer** with `DocumentFragment` + delegated click handling, replacing per-row `addEventListener` (`:3415, 3573`, and 48 other `forEach(addEventListener)` sites).

**1.7 · Meaningful motion on stage change** — dots filling left-to-right, the card animating from active list into the completed drawer. This is the moment the user will judge the app on. Needs 1.4 first.

**1.8 · Haptics** — `navigator.vibrate(8)` on primary confirms. Free on Android; be honest that iOS gets nothing until a native wrapper.

## Tier 2 — the field-tool and App Store work

**2.1 · IndexedDB read mirror.** Every successful GET writes to an object store; every screen entry paints from IndexedDB *immediately*, then revalidates and patches. This is what turns "opens to nothing in the warehouse" into "opens instantly, always". It requires the E2 concern to be answered honestly in the UI: cached money figures must be visibly timestamped, never presented as live.

**2.2 · Offline write outbox.** Queue mutations, replay on reconnect, with server-side idempotency keys (the pattern already exists for newsletter sends). Highest-value, highest-risk item — do it after 2.1 and after the P0 data-integrity findings in `PARITY-AUDIT-2026-07-26.md` are closed, because an outbox multiplies any merge-on-write bug (**S1**) by every queued write.

**2.3 · App Store.** Capacitor is the only credible near-term path — it wraps the existing `www/` in a WKWebView with a native bridge, **no rewrite**. Two caveats, stated plainly:
- Guideline **4.2 (Minimum Functionality)** rejects apps that are a repackaged website. What clears it is native capability + native feel: camera capture for lot photos, push notifications, share sheet, biometric unlock, and real offline. Tier 0/1/2.1 are not "polish before submitting" — they are the substance of the 4.2 argument.
- Capacitor inherits every performance problem verbatim. **Tier 0 must land before any wrapper**, or you ship the current cold-start into a store listing with public reviews.
- Also fix `user-scalable=no` (`index.html:5`) before an accessibility pass.

---

## Can a 6,759-line single IIFE get there? Honest answer.

**Yes for Tier 0 and Tier 1 — none of that needs a framework.** History, a nav stack, scroll restoration, skeleton-first, parallel fetches, compression, a proper SW, motion tokens, press states, sheet confirms, delegated events, optimistic patches: every one is additive and independent of how HTML gets produced. The realistic shape is a ~300-line "shell" at the top of the file (nav stack, screen registry, data cache, one `mutate()` helper) that the existing 40+ `render*` functions plug into one at a time. The file is well-commented, the naming is consistent, and there is already a correct instance of nearly every pattern needed (`wireFlag` for optimistic updates, `confirmDeleteClient` for sheets, `wireSwipeBack` for gestures, `skelList`/`retryBlock` for loading states). **The problem is not the architecture's ceiling — it's that the good patterns are each used once.**

**What it genuinely cannot reach without changing the rendering model:**
- **Interruptible, shared-element transitions** (list row expanding into detail, iOS-style). These require the outgoing view to stay alive and be *moved*, which string-template + `innerHTML` structurally cannot do. Nearest vanilla approach: the View Transitions API — available in Chrome/Android today, in Safari 18+, and it degrades to a plain cut elsewhere. Worth prototyping in Tier 1; it is the one thing that gets you most of the way without a framework.
- **Fine-grained reactivity.** Patching one node out of a mutation currently means hand-writing the patch. Fine for the 14 sites in 1.4; unsustainable at 100.
- **Virtualised lists** at thousands of rows — hand-rollable but genuinely fiddly.
- **Safety at scale.** 91 `innerHTML` sites, no types, no component boundaries, and XSS safety resting entirely on remembering `esc()` (`app.js:4`) at every interpolation. That's the real long-term cost.

**Recommended sequencing, and the case against rewriting now:** a rewrite freezes the parity backlog — 89 findings with rounds R2+ still open, including active data-loss P0s. That trade is not worth making while mobile writes can still NULL out desktop columns. Do Tier 0 immediately (days, enormous felt gain, zero structural risk), then Tier 1 while extracting the shell module. Revisit the framework question only once the shell exists — at that point the shell *is* the migration boundary, and moving screen-by-screen to a real component layer becomes incremental rather than a rewrite.

**If you only do three things:** compression (0.1), the service worker (0.2), and the navigation stack with history (1.1). Those three account for most of the gap between "a web page in a phone" and "an app".