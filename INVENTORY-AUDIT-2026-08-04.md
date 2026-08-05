# Inventory / storefront audit — 2026-08-04

**Status (2026-08-05): the INV-1 fix is written and compiles but is NOT committed** — see §7.
Everything else below is still diagnosis only. The INV-2 backfill (8 lots live on the store that
Jack marked sold) has not been done.

Trigger: Jack — *"when i mark stuff as sold, its still showing up in the live store. The whole
inventory system seems flawed and i need a diagnosis of the whole operation from ecliptr to the
store front on ecliptr which also goes to website."*

Ledger row: `requests/00-REQUESTS.md` → **R-014**.

This file is a handoff. Another agent is auditing the rest of the inventory system and should
**append** to it rather than rewrite it. Conventions for that are at the bottom.

---

## 1. The chain, end to end

```
desktop (Tauri, src-tauri)  ─┐
mobile PWA (www/app.js) ─────┼─→ oplog / REST ─→ server mirror DB (droplet)
                             │                        │
                             │                        ├─→ GET /api/public/storefront/:token
                             │                        │      WHERE status='available'
                             │                        │        │
                             │                        │        ├─→ /i/:token  (shop.html, Ecliptr's own store)
                             │                        │        └─→ bjmdistributions.com/deals (5-min ISR)
                             └────────────────────────┘
```

A lot leaves the store when, and only when, `inventory.status` stops being `'available'`.
There is no other gate — no per-lot "listed" flag, no quantity threshold, no expiry.

**Everything downstream of `inventory.status` is healthy.** The bug is entirely in the
writers: the things that *should* set `status='sold'` mostly don't.

---

## 2. Findings

Severity: **P1** = live commercial impact today · **P2** = real defect, no active harm ·
**P3** = papercut.

| id | Severity | Finding | Status |
|---|---|---|---|
| INV-1 | **P1** | Desktop "Mark sold" on a stale storefront listing is a no-op on the lot | **Fixed, written 2026-08-05 — uncommitted** |
| INV-2 | **P1** | 8 lots Jack marked sold are still live on the store and the website right now | Confirmed, unfixed |
| INV-3 | **P1** | Nothing links a sale to a lot — the auto-mark-sold path is unreachable | Confirmed, unfixed |
| INV-4 | P2 | Mobile does the right thing but calls it "Reject" and renders a client form | Confirmed, unfixed |
| INV-5 | P2 | Quantity is never decremented — no partial-sale concept anywhere | Confirmed, unfixed |
| INV-6 | P2 | Storefront is "every available lot" — no list/unlist control | Confirmed, by design |
| INV-7 | P3 | "Stale" means two different things on server vs desktop; "Renew" renews nothing | Confirmed, unfixed |
| INV-8 | P3 | A no-op edit save emits an `updated_at` sync event and resets the staleness clock | Confirmed, unfixed |

---

### INV-1 — Desktop "Mark sold" does nothing to the lot · **P1**

`src-tauri/src/commands.rs:772` `resolve_approval_request(id, approve)` matches only
`("client_add", true)`, `("client_add", false)`, `("client_delete", true)`. Everything else —
including `listing_stale` — falls through `_ => {}` at `commands.rs:817`. The function then
marks the approval row `rejected` and returns.

The button that reaches it is labelled **"Mark sold"**:
`src/components/ApprovalsView.tsx:182` → `quick(a.id, false)` → `resolveApprovalRequest(id, false)`.

So the notification disappears, and the lot stays `available` — on the storefront, and on the
website.

It also loops. `clienthub-api/src/scheduler.rs:49` `flag_stale_listings()` re-flags any
`available` lot older than 2 days, deduped only on the last approval's `resolved_at`. Two days
after being "marked sold", the same lot comes back. Marking it sold again does nothing again.

**Evidence** (live server DB, 2026-08-04T17:49Z):

| | |
|---|---|
| `listing_stale` approvals **rejected** ("Mark sold") | **37** |
| lots actually in `status='sold'` | **2** |

Both of those two were set by the manual status button in July (sync events seq 63229/63230 and
157014), not by this path. **The "Mark sold" button has never once worked.**

Fix: add a `("listing_stale", false)` arm calling the same write the server already does — set
`status='sold'`, bump `updated_at`, `sync::record_upsert("inventory", …)`. Mirror
`clienthub-api/src/routes/approvals.rs:209` `set_lot_sold` exactly so the two surfaces agree.

---

### INV-2 — Eight lots are live on the store that Jack marked sold · **P1**

At **2026-08-04T02:22:43–47Z** Jack marked ~15 stale listings sold in one sitting. Every one
stayed `available`. He then hand-archived them one at a time starting 17:18Z — the workaround.

Still `available` as of 17:49Z, i.e. still on `/i/:token` and on `bjmdistributions.com/deals`:

| lot id | name | marked sold at |
|---|---|---|
| `9a2ad6b4-12a7-4945-bf83-a745689639d7` | Adidas and TaylorMade Hats | 02:22:47.865Z |
| `002e3e0d-da9e-4f32-857c-6b1bfe120e1d` | HOLLISTER CLOTHING SWEATERS & SWEATPANTS | 02:22:46.573Z |
| `bf7c140d-3dcd-4a72-88f9-5a04c0a18360` | ADIDAS PREDATOR LEAGUE … SOCCER CLEATS | 02:22:45.516Z |
| `ba17981a-12df-4451-bbb9-b3743b56d339` | Hype Balance SLIDES | 02:22:44.365Z |
| `73c3287d-2780-497c-9a58-91780064b0f3` | Pajar Backpacks | 02:22:44.219Z |
| `7e64684b-fc61-405b-8802-6fe94dc5f086` | Bulls ProPlayer Kids Jackets | 02:22:44.073Z |
| `b934ef11-3a96-4559-9560-5e2c667ff6fa` | Chicago Cubs Gear — Jackets, Hoodies, Tees | 02:22:43.927Z |
| `daf528ad-539c-4cca-a64d-2b2532ade740` | HOME DEPOT TOOLS & HARDWARE | 02:22:43.644Z |

Re-run to get the current list:

```bash
ssh root@161.35.106.143 "sqlite3 -separator '|' /home/ecliptr/clienthub-data/brokr.db \"SELECT i.id, i.name, p.resolved_at FROM pending_approvals p JOIN inventory i ON i.id=p.entity_id WHERE p.kind='listing_stale' AND p.status='rejected' AND i.status='available';\""
```

**This backfill is separate from the code fix and must not be skipped** — fixing INV-1 does not
retroactively sell these. Note Jack is actively hand-archiving, so the set shrinks as he works;
re-query before acting rather than trusting the table above. Ask him first whether these should
become `sold` or `archived` — they are different things in the tier/analytics maths.

---

### INV-3 — Nothing connects a sale to a lot · **P1** — the structural one

There is code meant to mark a lot sold when its deal completes, at `commands.rs:4326-4346`:

```sql
UPDATE inventory SET status='sold'
WHERE linked_deal_id = (SELECT d.id FROM deals d WHERE d.converted_invoice_id = ?1)
  AND status='reserved'
```

It requires `inventory.linked_deal_id` set **and** `status='reserved'`. The only writer of both
is `link_lot_to_deal` (`commands.rs:7275`), which first requires a row in `deals`.

State of Jack's org (`org_default`) on the live server, 2026-08-04T17:49Z:

| | count |
|---|---|
| rows in `deals` for `org_default` | **0** (the 11 rows in the table are demo-org seed data) |
| lots with `linked_deal_id` | **0** |
| lots in `status='reserved'` | **0** |
| completed deal flows | **31** |
| invoices | 49 |

Invoice line items are free text with no lot reference:

```json
[{"description": "Edikted", "qty": 3201.0, "rate": 12.0, "amount": 38412.0}]
```

So across 31 completed deals, **zero** lots were ever auto-marked. The pipeline
quote → invoice → deal flow → complete has no idea inventory exists. Inventory status is a
detached manual flag that only two controls in the entire product can set.

This is the finding behind *"the whole inventory system seems flawed"* — INV-1 is the immediate
bug, this is the reason the workflow never worked in the first place.

Fix is a schema + UI change, not a patch. Sketch, to be planned properly:

1. Optional `lot_id` on invoice/quote line items (`line_items_json` entries already carry
   free-form keys, so this may not need a migration — verify).
2. A lot picker in the invoice/quote line-item editor that writes it.
3. On deal-flow completion, mark every referenced lot sold (and decrement quantity — see INV-5)
   instead of the current `linked_deal_id`/`reserved` path.
4. Decide the fate of `link_lot_to_deal` + `deals`: either revive or formally retire.

**Open question for Jack, blocking the design:** when he sells 1,000 units out of a 3,000-unit
lot, should the lot go `sold`, or drop to 2,000 and stay listed? The answer determines whether
this is a status change or a quantity ledger.

---

### INV-4 — Mobile works but is mislabelled · P2

Correcting an earlier claim in the chat: the server-side path **is** reachable from mobile.

`www/app.js:2880` renders every pending approval generically with **Approve** / **Reject**, and
Reject posts to `/api/approvals/:id/reject` → `approvals.rs:257` → `set_lot_sold`. So on the
phone, rejecting a stale listing *does* correctly mark the lot sold and drop it from the store.

Two problems remain:

- The button says **"Reject"**, not "Mark sold". Nothing tells Jack that rejecting a storefront
  notification sells the lot.
- Tapping the row opens `showApprovalDetail`, which is built for `client_add` — it renders a
  client review form (street, city, ZIP, tags) for what is actually an inventory lot.

This is a parity inversion: mobile has the correct behaviour and the wrong labels; desktop has
the correct labels and no behaviour. Fix both toward the desktop's wording.

---

### INV-5 — Quantity is never decremented · P2

Verified: **no code anywhere in either repo decrements `inventory.quantity`.** Greps for
`SET quantity`, `quantity = quantity`, `quantity -` across `src-tauri/src` and
`clienthub-api/src` return nothing outside create/edit forms.

A lot is binary — fully listed or gone. Sell part of a load and the storefront keeps advertising
the original count. Ties directly to the open question in INV-3.

---

### INV-6 — No list/unlist control · P2, by design

`clienthub-api/src/routes/storefront.rs:202`:

```sql
SELECT … FROM inventory WHERE org_id=?1 AND status='available' ORDER BY created_at DESC
```

The storefront is *defined* as every available lot. There is no way to keep a lot in inventory
without publishing it — the only way to hold one back is to archive it, which also removes it
from working views. Worth raising with Jack as a product decision, not a bug.

Single-lot links behave differently and correctly: `storefront.rs:234` resolves any
non-archived lot, so an already-shared link to a sold lot still opens (by design, `status!='archived'`).

---

### INV-7 — Two definitions of "stale"; "Renew" renews nothing · P3

- Server: `scheduler.rs:55` flags on `datetime(i.created_at) <= datetime('now','-2 days')`.
- Desktop: `InventoryView.tsx:25` `isStale` uses `daysSince(lot.updated_at) > 2`.

Same word, different column. A lot edited yesterday is fresh to the desktop and stale to the
server.

"Renew" (`approve=true`) touches neither `created_at` nor `updated_at`. It only writes
`resolved_at`, which the scheduler's dedup reads — so renewing suppresses the reminder for two
days and nothing more. The listing is never actually renewed.

---

### INV-8 — No-op saves emit sync events and reset staleness · P3

`update_lot` (`commands.rs:7229`) takes all-`Option` fields and always pushes `updated_at`.
Opening a lot's edit form and saving without changing anything writes a row, burns an HLC, and
emits an oplog event carrying only `updated_at`. Observed live: sync event seq 160905,
2026-08-04T17:22:12Z, lot `9a2ad6b4`.

Harmless to data, but it resets the desktop's `isStale` clock (INV-7), so a lot can be kept
"fresh" forever by opening and closing it.

---

## 3. Ruled out — do not re-audit these

Each was checked against live code or live data on 2026-08-04. They are **not** the cause.

| Suspect | Verdict | How it was checked |
|---|---|---|
| Storefront query wrong | Healthy | `storefront.rs:202` filters `status='available'` correctly |
| Service worker caching the catalog | Healthy | `www/sw.js:31` — `if (req.url.includes('/api/')) return;` never caches API |
| Website serving stale data | Healthy | `lib/storefront.ts:61` 5-min ISR; live feed returned 16 lots, `bjmdistributions.com/deals` rendered exactly 16 |
| Website static pages outliving a sale | Healthy | `app/deals/[slug]/page.tsx:9` `revalidate = 300`; `getLotBySlug` → `notFound()` |
| Sync broken / events stuck | Healthy | desktop `netsync_outbound` empty; 18 `sync_dead_letters`, all July, none inventory |
| Desktop status buttons broken | Healthy | `set_lot_status` (`commands.rs:8056`) writes the column *and* `record_upsert` |
| Mobile status buttons broken | Healthy | `app.js:2691` four-button row → `PUT /api/inventory/:id/status` → `inventory.rs:443`, writes + upserts |
| Bulk "Sold" broken | Healthy | `InventoryView.tsx:296` loops `setLotStatus` |
| Full-row upserts clobbering `status` | Healthy | inspected seq 157309 — a 21-column re-push that correctly carried `status: "sold"` |
| Desktop/server inventory divergence | Not a bug | the Windows desktop here is **offline and ~5h stale**; Jack's live desktop is a different node. Do not diagnose from `C:/Users/Jack/AppData/Roaming/com.bjmdistributions.clienthub/clienthub.db` |

---

## 4. Not yet checked — open surface for the next agent

Scope boundary. I traced *marked sold → still listed* and stopped there. Untouched:

- Lot **create** and **edit** forms on both surfaces (the narrow-form/merge-on-write data-loss
  class from `PARITY-AUDIT-2026-07-26.md` has not been re-checked for inventory specifically).
- Photos / media sync, manifests, the storefront gallery.
- Categories, condition, variants, `details_json` shape drift.
- `offers` — the "Make an offer" flow and whether an accepted offer does anything to the lot.
- The `pending_approvals` `listing_stale` **approve** arm on desktop (also `_ => {}` — verify
  whether that matters).
- Facebook / WhatsApp / newsletter send flags and whether a sold lot can still be blasted out.
- Archive semantics: `archive_lot` vs `set_lot_status('archived')` are two separate writers;
  they were not compared.
- Whether `sold` vs `archived` are treated consistently by tier maths, analytics, and the
  dashboard.

---

## 5. Recommended sequence

1. **INV-1** — three lines in `commands.rs`. Ships in a desktop release. No server deploy.
2. **INV-2** — backfill the still-live lots. Ask Jack `sold` vs `archived` first.
3. **INV-4** — relabel mobile, and stop routing `listing_stale` into the client-review panel.
4. **INV-7 / INV-8** — align the two staleness definitions; make "Renew" actually renew.
5. **INV-3 / INV-5** — plan properly, do not patch. Blocked on Jack's partial-sale answer.
6. **INV-6** — product decision for Jack, not an engineering task.

Deploy notes: 1–2 are desktop-only. 3 is a `www/app.js` PWA change (no restart needed, bump the
`sw.js` `CACHE` constant — currently `ecliptr-v95`). Nothing here requires touching `plaid.rs`.
Re-read `runbooks/deploy` in the vault before any droplet work.

---

## 6. How to reproduce and verify

```bash
ssh root@161.35.106.143 "sqlite3 -separator '|' /home/ecliptr/clienthub-data/brokr.db \"SELECT status, COUNT(*) FROM inventory WHERE org_id='org_default' GROUP BY status;\""
```

```bash
curl -s "https://ecliptr.app/api/public/storefront/b449ea8d32f14802" | python -c "import sys,json;d=json.load(sys.stdin);print(d['count']);[print(' -',l['name']) for l in d['lots']]"
```

Live-repro of INV-1: open Notifications on desktop, press **Mark sold** on a storefront listing,
then re-run the first query. The count of `available` will not change.

Do **not** diagnose from the local Windows `clienthub.db` — see the last row of §3.

---

## 7. Changelog

| when | who | what |
|---|---|---|
| 2026-08-05 | Claude (session 1) | Wrote the INV-1 fix: a `("listing_stale", false)` arm in `resolve_approval_request` mirroring the server's `set_lot_sold` (writes `status='sold'` + `updated_at` and records the oplog upsert). Compiles clean. **NOT committed** — `commands.rs` was mid-edit by a concurrent session, and sweeping another session's in-flight work into a release is exactly what caused the paste-a-load regression. Commit it the moment that file is free. INV-2 backfill still outstanding: 8 lots. |
| 2026-08-04 | Claude (session 1) | Traced desktop → server → storefront → website. Found INV-1…INV-8. Ruled out §3. **No code changed, nothing deployed.** Logged R-014 in `requests/00-REQUESTS.md`. |

**If you are the next agent:** append your findings as `INV-9`+ with the same
severity/status/evidence shape, add a row to §7, move anything you clear out of §4, and
**leave §3 alone unless you have evidence that overturns it**. If you fix something, change its
Status cell to `Fixed, vX.Y.Z` rather than deleting the row. Update the vault
(`architecture/`, `features/desktop-screens`, `features/mobile-screens`) in the same session as
any behaviour change, per `CONVENTIONS.md`.
