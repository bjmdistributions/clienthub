# MASTER PLAN — people, deals, and a mobile that isn't half-built
**Written 2026-08-17. Source: the 2026-08-17 session with Jack. Requests R-152 … R-157.**

Everything here is **plan only**. No code has been written under it.

## §SCOPE — and how this relates to the other master plan

`MASTER-PLAN-2026-08-13.md` (R-151) is the **burn-down** plan: 12 workstreams over ~230 documented-but-never-fixed findings. It stands. Do not merge these two documents.

**This plan is different in kind.** It is the **product** plan that came out of Jack running the business alone while his brother was out of action, and it exists because that week exposed a class of problem the burn-down plan does not cover: *the software models the money and almost nothing about the people, the agreement, or the week ahead.*

Where the two overlap, this plan says so and defers.

## §0 GROUND RULES

**Read `MASTER-PLAN-2026-08-13.md` §0 and follow it — never-erase, money invariants, sync three-places/five-lists, server-deploys-first, hunk staging, release proof.** Not restated here. Five rules are specific to this plan:

1. **A counterparty tag is identity, not accounting.** Tagging a payment to a person must not move deal profit, cost, Free Cash, or any reconciliation figure. The tag says *who*; the allocation says *what it paid for*. Any change that makes a tag arithmetic is wrong.
2. **Never net a party's two sides.** Money paid to someone as a supplier is cost; money from them as a buyer is revenue. Show two figures. If a single number is wanted it is called **position**, never profit. (This is the R-115 error that once reported −$85,720 for a real client.)
3. **Suggest, never auto-apply**, for every matcher in this plan — person tags, party links, deal candidates. R-150's locked decision. A wrong auto-tag is a data error that looks like a fact.
4. **Build the profile shape once.** The client profile, the supplier profile and the both-roles view are one component with three configurations. Building it client-first and generalising later means building it twice — and W6 becomes expensive instead of nearly free.
5. **Mobile is not a follow-up phase.** Jack: *"desktop probably first but mobile will be just as important."* Every workstream below names its mobile half. A workstream is not done when desktop ships.

### The blocker to clear before any desktop work starts

**A concurrent session is holding the files.** As of 2026-08-17 the working tree has uncommitted edits to `commands.rs`, `main.rs`, `App.tsx`, `api.ts`, `ClientDetailView.tsx`, `SuppliersView.tsx`, `FinancialsView.tsx`, deletions of `DealsView.tsx` and `HealthView.tsx`, and new `eslint.config.js` / `rustfmt.toml` / `.github/workflows/check.yml` — that is the R-134 toolchain work.

**Those are exactly the files every desktop workstream here touches.** Land, commit or stash that session before starting W1–W6 on the desktop. Diff every file against `v0.15.143` before committing anything — concurrent sessions edit the same files in this repo, and that has already cost a shipped regression once (v0.15.124).

**The server and mobile lanes are in a different repo and are not blocked.** That is what makes them today's work.

---

## §W1 — PAYMENTS UNDER A NAME (R-156). The unblock.

**Why first:** Jack went looking for this, could not find it, and concluded he was *"all screwed up"*. He was not — the feature is half-built. `tagBankTxnCounterparty` has exactly two call sites (`FinancialsView.tsx:1122`, `:1155`) and **both are inside deal-allocation flows**, so a payment gets a person only as a side effect of being tied to a deal. The profile ships an untag button for a tag it cannot create. Correct this before building anything on top of it.

| Step | What | Where |
|---|---|---|
| W1-a | **Person picker on a transaction, independent of any deal.** In the booking sheet and on the ledger row. Writes `counterparty_type` / `counterparty_id`, which already exist and already have readers. | `FinancialsView.tsx`, `commands.rs` |
| W1-b | **Suggest the person.** `bank_suggest.rs` (deploy-39) already does token-fuzzy matching against `clients.name` / `suppliers.name` with the ≥8-char containment rule. Today its candidates only ever name a **deal**. Return the person too. Suggest + one-tap confirm. | server `bank_suggest.rs`, then desktop |
| W1-c | **Bulk apply** — "every unlinked payment from this payee is X" — reusing the R-018 `txn_rule` engine pointed at a person instead of a category. Synced, per-rule opt-in, same as auto-book. | `commands.rs`, `FinancialsView.tsx` |
| W1-d | **Both views on the profile**, as Jack asked: *money booked to deals with them* and *everything tagged to them*, **with a visible divider**. Never silently merged — the first already counts in the P&L and the second does not. Show a count and a total per group. | `ClientDetailView.tsx`, `SuppliersView.tsx` |
| W1-e | **Remove the 12-row dead end.** `payments.slice(0, 12)` with no count and no click-through becomes a full list plus **"See all in Financials"**, which requires W2-f (the person filter on the ledger) to have somewhere to land. | both profiles |
| W1-f | **The same method facet on the profile list** (W2-a), so "show me every wire from this buyer" is one tap on their page — not only on the ledger. Jack asked for wires **under a person's name**, which is this step, not W2. | both profiles |

**Scale of the problem, measured 2026-08-17:** of **1,342** transactions in the live ledger, **`counterparty_type` is empty on every single one** — zero are attributed to any person. The tagging path has never once fired, which is exactly what R-156 predicted from the code. So the profile payment lists are running entirely on deal allocations today, and W1 is not a refinement of a working feature — it is the feature.

**This also sets W1-c's priority.** Attributing 1,342 rows one at a time is not going to happen; the suggestion engine (W1-b) and bulk-apply (W1-c) are what make the backlog tractable, not nice-to-haves.

**Trap:** the inline payee rename (`FinancialsView.tsx:1064`) writes a **free-text string** on the transaction. It looks like naming the person and links nothing. After W1-a, renaming a payee should offer "also link this to <person>?" — or the two will keep being confused.

**Mobile:** blocked until W7 gives mobile a bank surface at all. Ships in W7-c.

## §W2 — WIRE DETECTION AND REAL PAYMENT FILTERS (R-157).

**MEASURED against the live ledger 2026-08-17 (read-only, `clienthub.db`, 1,342 transactions) — and the first draft of this section was wrong.** It claimed the wire metadata was already captured and only needed surfacing. It is not.

| Measurement | Result |
|---|---|
| Transactions total | **1,342** |
| Carrying any `raw_json` | 369 |
| Carrying the `pm` block (Plaid `payment_meta`) | **0** |
| Carrying `pm.payment_method` | **0** |
| Memo contains WIRE / ZELLE / ACH | **146 / 85 / 25** |

`rawj_for` **is** running — rows imported since v0.15.140 carry the new `dt`/`pa`/`tid`/`merchant` shape, 30 of them. But **`payment_meta` is absent from every single row**, because Plaid is not returning it for his institution. This is not a capture bug to fix; it is upstream data that does not exist.

**Consequence: a field-based method filter would match zero transactions.** Detection must be built on the memo text plus Jack's own corrections. That is a different design, and it is the one that has to be built.

| Step | What |
|---|---|
| W2-a | **A payment-method facet** — Wire / ACH / Zelle / check / card / transfer — derived from a **memo classifier** (`FEDWIRE`, `WIRE TYPE`, `WIRE TRANSFER`, `ZELLE`, `ACH`, `CHECK #`), with `pm.payment_method` used **when present** so the design survives a future institution that supplies it. Do not build it field-first: the field is empty today. |
| W2-b | **Three states, never two: certain · likely · unclassified.** A memo hit is *likely*, a confirmed row is *certain*, everything else is *unclassified*. The filter must **always show the unclassified count** — "showing 146 wires · 61 unclassified" — because a heuristic filter that silently hides what it could not read is a filter that lies, and money filters that lie are how this codebase has hurt him before. |
| W2-c | **Set the method by hand, and have it stick.** One control on the row and in the booking sheet. This is what makes "only wires, and nothing but wires" actually reachable: the classifier proposes, Jack corrects, the correction is permanent. Without it the list is forever approximate. |
| W2-d | **Remember it by payee**, reusing the R-018 `txn_rule` engine pointed at method instead of category — "everything from this payee is a wire". Only **confirmed** rows teach, never the classifier's own guesses; that is the exact rule R-018 already enforces for categories, and it exists so machine guesses are not laundered into advice. |
| W2-e | **The wire detail on the row** — `by_order_of` / `payer` / `reference_number` when a bank ever supplies them, and the memo's own reference line when it does not. Answers "who sent me this". |
| W2-f | **A person filter on the ledger** — the click-through target W1-e needs. |
| W2-g | **Saved views.** Direction, date range, category, account and status filters already exist (`dirFilter`, `catFilter`, `acctFilter`, `statusFilter`, `fromDate`/`toDate`); what is missing is keeping a combination. "All wires in, this quarter" as one click is the *"filter all payments in and out at any time"* ask. |

**Answering "make sure nothing besides wires in and out show" honestly:** with 0 rows of bank-supplied method data, exactness cannot come from detection alone. It comes from W2-c + W2-d — the classifier gets it roughly right on day one across the ~146 memo hits, Jack corrects what it misses, the corrections stick per payee, and the unclassified count tells him how much is still unreviewed. That converges on exact within a few sessions of normal use. Any design that promises purity from the memo text alone is overpromising.

**Mobile:** part of W7-b.

## §W3 — PICKUP DATE, THE WAITING LANE, THE GATE (R-154).

Jack's own design, and it replaces the ten-field logistics block that was proposed. **Do not re-add the other nine fields.**

All four pipeline stages are about money, so there is no state meaning *"agreed, paid for, truck hasn't come yet"* — which is most of the life of a deal and exactly where information goes missing.

**DECIDED by Jack 2026-08-17 — two dates, not one:** *"as long as changing deal flow to include shipping expected delivery date and pickup date, we are ready to deploy agents to begin working."* This is the condition he set on starting work, so it is settled: `deal_flows` gets **`pickup_date`** (when it leaves) and **`expected_delivery_date`** (when it lands). Supersedes D-1's "buyer collecting vs us collecting" framing — he wants the shipping lifecycle, not the two-parties distinction.

**Consequent ruling on the gate, stated rather than asked** (the plan cannot start without it, and the override makes it safe to be wrong): completion gates on **`expected_delivery_date` when it is set, otherwise `pickup_date`**. A deal is not finished when the truck leaves; it is finished when the goods land. The recorded override in W3-c covers every case where reality disagrees.

| Step | What |
|---|---|
| W3-a | **Two real columns** on `deal_flows` — `pickup_date` and `expected_delivery_date`. **Not** `metadata` (`db.rs:638`) — that is a JSON blob under per-column LWW, so two devices editing different keys clobber each other, and a field that gates completion is load-bearing. Migration + the sync three-places/five-lists drill, **server first**. |
| W3-b | **The waiting lane** — agreed-but-not-collected deals pinned in Deal Flow with everything they already carry. |
| W3-c | **The completion gate**, with a **recorded override** (who, when, why). No escape hatch means fake dates get typed, which destroys the data the gate existed to protect. |
| W3-d | **"No pickup / ships direct" as an explicit choice**, so an empty field is a real unanswered question the card can flag — otherwise nobody fills it in and the feature dies in a month. |
| W3-e | **Keep the previous date on a reschedule.** Pickups slip constantly here; without it the card quietly claims it was always Thursday. |
| W3-f | **A this-week view** on the Brief and the mobile home. This is the piece that would have answered "what is live" when the salesman was out — the reason the whole conversation started. |

**Open:** whose pickup (buyer collecting vs us) — one date or two; whether a "freight booked by us / them" toggle rides alongside; where it is entered; block vs warn. See §DECISIONS.

## §W4 — ATTRIBUTION (R-152 option C). One column, everything reads better.

`interactions` (`db.rs:285`) has **no author**, and `clients` / `invoices` / `deal_flows` have no `created_by`. On a two-person team the timeline cannot tell Ben's call from Jack's. **Ben has his own account** (confirmed 2026-08-17), so this is a column, not an RBAC project.

Add the actor to `interactions` and to the W3 pickup fields. Synced, server first. Every timeline row then reads *"Ben · Tue 14:20 · call"*.

Smallest item in the plan and the backbone under W5. Do it early.

## §W5 — THE PROFILE REBUILD (R-153). Built generically.

Jack: *"its too blocky and honestly is designed like shit… at anytime i need to be able to glance and see any information."*

**Verified defects, not opinions:** `load()` calls `listDealFlows()` (`ClientDetailView.tsx:170`) and uses it **only to sum one profit tile** — the client's live pipeline is fetched and discarded. Invoices are rendered **three times** in near-identical inline JSX (`:660`, `:722`, `:762`). Four tabs render two datasets. The portal-link generator and credit-limit input sit **above** the relationship history. `next_follow_up_date` is a bare date input buried in a metadata card (`:533`), never surfaced or compared to today. And `rep` falls back to `client.company` (`:233`), so a client with no rep set displays **their own company name** labeled "Rep:".

| Step | What |
|---|---|
| W5-a | **Fix the rep fallback.** One line, actively misleading now that account ownership is the live question. Can ship in any release. |
| W5-b | **One screen, not four tabs.** Left: identity, money, **open deals with stage and pickup date**, next action. Right: one activity stream — calls, invoices, deals, payments, offers — with filter chips. The Timeline tab is already three-quarters of this; promote it and delete the other three. |
| W5-c | **Everything Jack named as glanceable, above the fold:** address, current deals, past deals, linked payments. Three of the four are absent today. |
| W5-d | **A next-action line in the header** — follow-up due, overdue invoice, pickup this week — instead of a date input nine cards down. |
| W5-e | **Read first, edit behind a flip**; admin controls (portal link, credit limit, custom fields, flags) collapse into one disclosure. Same split the supplier profile got in v0.15.135. |
| W5-f | **Build it as one component with a role configuration** — see §0 rule 4. This is what makes W6 cheap. |

**Known limit of "one interconnected web":** client ↔ deal ↔ invoice ↔ payment ↔ supplier all connect, but **deal ↔ lot does not exist in the data** — zero lots carry a deal id (R-014). Do not design a hop that cannot be built.

**Also unaudited:** `ClientsView.tsx` (938 lines) has not been checked for the R-116 trap that sank the supplier grid — a list sorted alphabetically so the biggest account is invisible. Audit before deciding whether the list is in scope.

## §W6 — ONE PARTY, TWO ROLES (R-155).

`clients` and `suppliers` are separate tables with **no link column of any kind** (verified `db.rs:605`). Someone who both buys and sells is two unrelated records and their tier is computed from half their history.

**Link, do not merge** — Jack asked to keep separate tabs, and a merge would touch tiers, deal flow, financials, three sync surfaces and the server mirror for no visible gain.

W6-a additive link column or `party_link` table · W6-b **suggested** matches from same email / normalized phone / fuzzy name, reusing the W1-b matcher, confirmed never auto-applied · W6-c Buyer/Supplier toggle in the profile header, shown only when both records exist · W6-d a combined strip — total bought, total sold, **position** · W6-e a marker on linked rows in both existing lists.

Tiers stay **buyer-side only** or the ladder silently changes meaning.

## §W7 — MOBILE FINANCIALS (R-001). The largest missing surface in the product.

Mobile has **zero** bank screens and the server exposes **no bank endpoints**. This is the single biggest desktop/mobile divergence and it blocks the mobile half of W1 and W2.

| Step | What |
|---|---|
| W7-a | **Server bank endpoints** over the mirror DB, org-scoped, read-first. `plaid.rs` stays undeployed — the server must never become a second `bank_txn` writer. |
| W7-b | **A mobile financials screen designed for a phone, not a port.** The desktop screen is a dense table; the phone version leads with the daily to-book queue as cards, direction and method facets (W2) as pills, and one transaction per screen when opened. Follow the mobile visual system in `features/mobile-screens.md` — it is a hard spec, not a suggestion. |
| W7-c | **Booking and tagging from the phone** — category, deal, person (W1). This is where R-009 ("record a payment on mobile") lands too. |
| W7-d | **Bank payments on the mobile profiles**, matching W1-d. |

Sequenced after W1/W2 on desktop so the mobile screen implements a settled model rather than chasing one.

## §W8 — MOBILE DEAL FLOW, FINISHED (R-146).

Jack: *"mobile has been a huge help but is still so limiting when it comes to viewing the ui of deal flows and keeping track of anything. it seems half built."*

**It is more built than it feels** — the Deals screen has the stage rail, expansion, supplier payments, freight/wire/other cost lines, refunds and a completed drawer. What it genuinely cannot do (`features/mobile-screens.md`): **no bank-transaction linking, no reconciliation panel, no refund workspace, no closeout, no release letters.** Plus, structurally, **no browser-history integration in 7,057 lines**, so Android back quits the app (R-007) — which is a large part of why it feels half-built rather than any single missing feature.

W8-a the deal drill-in Jack asked for in R-146 · W8-b add suppliers from mobile · W8-c link financials from mobile (needs W7-a) · W8-d **history/back** (R-007) — structural, and the single biggest perceived-quality win on the phone · W8-e the W3 pickup date and waiting lane on mobile.

**Before re-auditing anything here, read `PARITY-AUDIT-2026-07-26.md` (89 findings) and `PARITY-PLAN.md` (102).** Do not produce a third audit — see R-134's finding that documentation is outpacing fixing.

## §W9 — APP STORE (R-122). It is the same work as W7 and W8.

**These are not competing priorities.** Jack set full mobile parity as his own gate before submission (R-146), and builds 1 and 2 are **not submittable anyway** — both predate the fetch-rewrite fix, so login does nothing on device. A build 3 is required regardless.

So: W7 and W8 *are* the App Store path. Ship them, cut build 3, submit.

**Two things to remember when it happens:** any change to `clienthub-api/www/` ships to **both** the PWA and the iOS bundle (`architecture/ecliptr-mobile-bundle-pipeline`), and **R-133 (the globe upgrade) triggers the moment the app is pushed to Apple** — Jack asked to be told at phase N6 or N11, not at public approval. Surface it in the same message that reports the push.

---

## §TODAY — what can actually be started right now, agentically

**The desktop lane is blocked** until the concurrent R-134 session lands (see §0). Everything below runs in the server or mobile repo, or in files that session is not holding.

| # | Task | Repo / files | Why it is safe today |
|---|---|---|---|
| 1 | **W1-b** — extend `bank_suggest.rs` to return a **person** candidate, not only a deal. Read-only, additive, tested. | `clienthub-api/src/routes/bank_suggest.rs` | Different repo. The matcher and its 5 tests already exist. |
| 2 | **W7-a** — design and build the read-only server bank endpoints. | `clienthub-api` | Different repo. Unblocks all of W7 and W8-c. |
| 3 | **W3-a spec + migration draft** — the pickup-date column, the sync list entries in all five places, server first. | `db.rs`, `sync.rs` | Neither file is held by the other session. |
| 4 | **W8-d** — mobile history/back. Structural, self-contained, biggest perceived-quality win. | `clienthub-api/www/app.js` | Different repo. |
| 5 | **W5 audit of `ClientsView.tsx`** — check for the R-116 alphabetical-sort trap. Read-only. | read-only | Produces a decision input, changes nothing. |
| 6 | **A rendered mockup of the new profile** (W5-b/c/f), both roles, real data shapes. | scratch | Design decisions before code. Cheapest way to find out the hierarchy is wrong. |

**Do not start today:** anything in `FinancialsView.tsx`, `ClientDetailView.tsx`, `SuppliersView.tsx`, `commands.rs`, `api.ts` or `App.tsx`.

## §DECISIONS — ten things only Jack can answer

Each blocks only the step named. Collect in one sitting.

| # | Question | Blocks |
|---|---|---|
| D-1 | Pickup date: one date, or two (buyer collecting vs us collecting)? | W3-a |
| D-2 | Does the gate **block** completion or only warn loudly? (Recommend: block, with a recorded override.) | W3-c |
| D-3 | Keep a "freight booked by us / them" toggle beside the date, or is the pinned card enough? | W3-a |
| D-4 | Is `ClientsView` (the list) in scope, or only the profile? | W5 |
| D-5 | Does the activity stream absorb deals and payments, or stay contact-only? | W5-b |
| D-6 | Party link: record-level link, or a real party entity both records hang off? (Recommend: link — cheap and reversible.) | W6-a |
| D-7 | Can one party have two supplier records (two trading names)? | W6-a |
| D-8 | **Superseded by measurement** — there is nothing to backfill, Plaid supplies no `payment_meta` at all (0 of 1,342). Replacement question: is a memo classifier plus your own corrections (W2-c/d) acceptable as the route to "only wires", accepting it is approximate on day one and exact after a few sessions of correcting it? | W2-a |
| D-9 | Is R-146 parity still the App Store gate, or ship build 3 sooner with parity following? | W9 |
| D-10 | Does this plan outrank `MASTER-PLAN-2026-08-13.md` for the next few releases, or interleave? | sequencing |

## §SEQUENCE

```
Today        server lane (W1-b, W7-a) ‖ mobile lane (W8-d) ‖ specs + mockup (W3-a, W5, ClientsView audit)
Then         land the R-134 session → W5-a (one line) + W4 (one column)
Release 1    W1 (payments under a name) + W2 (wire detection, filters, saved views)
Release 2    W3 (pickup date, waiting lane, gate) — desktop + mobile together
Release 3    W5 (profile rebuild, built generically) → W6 (party linking) rides on it
Release 4    W7 (mobile financials) + W8 (mobile deal flow) → W9 build 3 → submit
```

**One release tagged at a time** — two CI builds in flight let the older publish last and auto-update everyone backwards. **Server deploys before desktop** on anything touching a synced table: `push_event` drops-and-acks unknown tables, so a desktop shipping first has its events silently destroyed (the R-018 lesson).

## §NOT IN THIS PLAN

The offer ledger (nothing records who a load was shown to) and inbound supplier invoices (no bill/PO table exists) were **found, not requested** — written up under R-152. Do not build either without asking Jack first.
