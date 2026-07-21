# PARITY-PLAN.md — Cross-platform sync + mobile parity master plan

2026-07-18 audit (6-lens multi-agent sweep over desktop 57 views / server 30 routes / mobile app.js 6.6k lines,
102 deduped findings; 5 adversarially verified + 4 P0s hand-verified; remainder evidence-cited, re-verify at fix time).
Goal: every desktop workflow works identically on mobile; nothing ever diverges.

ALREADY HANDLED (do not redo):
- Server dashboard money NOT_VOIDED guards (deploy #4, live 2026-07-18 00:03).
- Resend email path live on droplet w/ platform key + no-reply@ecliptr.app (needs ONE test send from mobile).
- CLIENTHUB_SECRET_KEY set on droplet -> org-secrets credential bridge fully live.
- Separate session in flight: desktop false-ack dequeue, apply_upsert tombstone resurrection, intake oplog-bypass minting.

## Rounds

R1 — MONEY TELLS ONE TRUTH (server-only deploy, mobile picks up instantly)
  1. weekly_brief: port desktop's live+refund-aware guards to EVERY deal_flows SUM (voided/archived/refunds).
  2. Server complete_deal_flow: port deal_bank_actuals + write bank_snapshot (mobile completion = bank truth).
  3. Block stepper-math overwrites of completed deals (deal_flows.rs:150,242,318 zero/overwrite net_profit).
  4. /api/invoices: expose voided; exclude voided/archived from mobile lists, overdue, portal, followups, biggest_invoice, top_suppliers, monthly-profit refund-awareness, open_deals dedup.
  5. Brief pipeline stats read dead `deals` CRM table -> compute win/lost from deal_flows + voided_at; stamp voided_at on mobile fell-through.
  6. Desktop daily-profit chart guards (ships later with v0.15.92, small).

R2 — EVERY WRITE REPLICATES (server routes emit sync; matched-set deploy)
  1. payments.rs INSERT -> record_upsert (0 sync calls today).
  2. deal_reps assign/unassign (staff_api.rs:541,549) + staff-delete cascades (employees.rs:2120,2292,2334) -> events/tombstones.
  3. Password reset -> emit_staff (employees.rs:~1683).
  4. emit_staff: add pay_type (and audit full column list vs desktop schema).
  5. email_suppression -> propagate to desktop send path (unsubscribed contacts, CAN-SPAM) + desktop send honors it + footer.
  6. newsletter_sends split-brain -> merge histories both directions ("first contact" audiences re-email people today).
  7. messages read_at, checkup delete tombstones, intake_sources.sample_json, workspace purge tombstones, smtp_password oplog guard, deal_stage_history (sync it or stop writing it).
  8. Mobile session: use /api/auth/employee/refresh (stop the hard 7-day logout).
  9. Mobile quick bugs: loss-alert key mismatch, rep KPI stage literal, quote 'declined' badge, dead loadDealFlows, SW shell-fallback, BUILD const.

R3 — CONFIG TRAVELS WITH THE ORG (kill device-local config that gates org data)
  1. Settings scoping fix: desktop reads org-scoped keys (payout split, branding, email cfg for non-default orgs).
  2. Invoice studio branding + company_info + numbering -> server (media upload for logo; fixes device-absolute logo_path clobber + release-letter/invoice logo).
  3. Server PDF renderer uses studio branding (invoice + quote PDFs identical from any surface; mobile quote sends get the PDF).
  4. sheet_sync_config org-synced; sheet write-back runs server-side on approval (mobile approvals update the Sheet).
  5. signup_rules synced; WhatsApp templates org-scoped; brief period one source; central toggles (sheet_sync_enabled etc.).
  6. Secrets via bridge: upload Mac IMAP secret, anthropic_api_key org-shared (AI intake works everywhere).
  7. Newsletter attachments on scheduled sends (scheduler silently drops them today); unified sender identity.

R4 — MOBILE WORKFLOW BUILD-OUT (full parity for daily ops)
  1. Deal Flow v2 on mobile: create flow, 5-section stepper, bank-link reconciliation, refund attach, uncomplete guard.
  2. Refund workspace + supplier refunds; deal receipts (REST route + UI).
  3. Financials on mobile: Free Cash + allocation status read-first, then Chase/OFX import + allocate.
  4. Release letter (sign on phone), storefront/platform management, inventory variants/manifest/photos, phone search, pipeline deals create/edit.
  5. Mobile Settings: payment methods, Shopify/Sheets, numbering, inbox config.

R5 — POLISH / LATENT
  Globe, Sheet copy, automation log, portal cleanup, referral/orgs sync emissions, Plaid-refresh not bound to one PC,
  tier variable consistency, invoice-number race, analytics payload gaps (refund story, won/lost fields).

Ship pattern per round: verify claim at fix time -> fix -> WAL-aware PC-vs-server diff + cross-surface number check.
Server deploys: matched sets w/ backup+rollback scripts (Jack runs). Desktop: v0.15.92+ tags. Mobile: www deploy + SW bump.

---

# Appendix — all 102 findings (severity/class, evidence-cited)

### P0 — sync-bug

- **Mobile lead-rep assignment (deal_reps) never replicates to desktops**
  staff_api.rs set_lead_rep INSERTs/DELETEs deal_reps rows with plain SQL and no sync::record_upsert/record_delete. deal_reps IS in ALLOWED_TABLES (server sync.rs:950) and the desktop reads it for payout math: the per-deal rep override (commands.rs:4811-4817), the payout brief (commands.rs:4964-4973), and the rep's refund-aware cut (commands.rs:9298-9311). A rep assigned or cleared from mobile exist
  Impact: Assigning a lead rep from mobile silently produces different payout numbers on desktop vs mobile: desktop payout brief and rep cuts omit (or keep a stale) rep for that deal.
  Fix: In staff_api.rs set_lead_rep, mirror the desktop: after the upsert call sync::record_upsert("deal_reps", &deal_flow_id, cols{lead_rep_id,assigned_by,assigned_at,org?}) and on the clear branch sync::record_delete("deal_reps", &deal_flow_id, &org). Note deal_reps has no org_id column — pass the sessio
  Evidence: clienthub-api/src/staff_api.rs:540-549 (INSERT ... ON CONFLICT and DELETE FROM deal_reps, no record_* call anywhere in the handler, which ends at 553); clienthub-api/src/sync.rs:950 (deal_reps in ALLOWED_TABLES); BUSINESS APP/src-tauri/src/commands.rs:4811-4817, 4964-4973, 9298-9311 (desktop payout logic reads deal_reps)

- **Mobile supplier-payment edit on a completed deal overwrites bank-truth net_profit with stepper math and syncs it everywhere**
  Server recalc_completed_deal_flow computes net = payment_received_amount - SUM(supplier_payments) and persists it to deal_flows.net_profit via record_upsert (which propagates to every desktop). It never consults bank_allocation/bank_txn, even though those tables are synced and present on the server. On desktop, a completed deal's numbers are bank-precedence (deal_bank_actuals: buyer/supplier/fee/r
  Impact: Editing or marking-paid a supplier payment on mobile for any bank-reconciled completed deal silently rewrites the deal's recorded profit on every device; the bank-truth number is lost until someone runs Recalculate-from-bank on desktop.
  Fix: Port deal_bank_actuals into the server (bank_txn/bank_allocation are already in the server DB): in recalc_completed_deal_flow, prefer bank-linked leg totals with the EXISTS(bank_txn) guard and fall back to the last recorded figures, mirroring resync_completed_deal. Also update gross_revenue consiste
  Evidence: clienthub-api/src/routes/deal_flows.rs:261-322 (recalc ignores bank tables, writes net_profit + record_upsert); clienthub-api/src/routes/deal_flows.rs:694-702 (update_supplier_payment calls recalc when stage='complete'); BUSINESS APP/src-tauri/src/commands.rs:4232-4260 (deal_bank_actuals bank-precedence + EXISTS(bank_txn) guard)

- **Payment rows created from mobile never replicate (payments.rs has zero sync calls)**
  routes/payments.rs create_payment_request INSERTs into payments (a synced table, server sync.rs:941; also in the desktop's ALLOWED_TABLES) with no record_upsert. The file contains no sync:: reference at all. Desktop lists payments per invoice (commands.rs:2434-2451), so a mobile-created 'pending' payment row is invisible on every desktop, and archive/delete flows that check payments FKs will disag
  Impact: A payment request created on mobile/web shows on mobile but never appears in the desktop invoice's payment history; if the Stripe webhook is ever implemented on this path the divergence becomes money-visible.
  Fix: In create_payment_request, build a cols map (invoice_id, amount, currency, status, created_at, updated_at, org_id) and call sync::record_upsert("payments", &id, cols) after the INSERT; also stop discarding the INSERT error.
  Evidence: clienthub-api/src/routes/payments.rs:55-58 (INSERT INTO payments, error ignored with let _, no record_upsert; whole file read — no sync usage); clienthub-api/src/sync.rs:941 (payments in ALLOWED_TABLES); BUSINESS APP/src-tauri/src/commands.rs:2434-2451 (desktop reads payments)

- **Server emit_staff drops pay_type from the synced staff_accounts row**
  clienthub-api employees.rs emit_staff() builds the sync upsert from a SELECT that includes commission_pct, hide_pay_cuts, avatar, title, phone but NOT pay_type (employees.rs:358-371). The admin update_user route accepts pay_type and writes it to the server DB (employees.rs:2076-2082) then calls emit_staff (2092), so the oplog event carries every column EXCEPT the one just changed. Desktop computes
  Impact: Changing a rep's pay type from the mobile Team editor silently never reaches desktops; desktop and mobile then show different rep payout amounts for the same completed deals.
  Fix: Add pay_type to the SELECT and cols map in emit_staff (employees.rs:358-371). One-line schema addition to the query + one cols.insert.
  Evidence: clienthub-api/src/employees.rs:358-371 (emit_staff SELECT/cols, no pay_type); clienthub-api/src/employees.rs:2076-2092 (update_user writes pay_type, emits without it); clienthub-api/src/staff_api.rs:341-355 (payout-config path syncs pay_type correctly)

- **Settings never round-trip for non-default orgs: netsync push rejects the settings table, and server-authored settings arrive under '{org}::' keys the desktop never reads**
  Server PUSHABLE (sync.rs:1412-1420) deliberately excludes 'settings', and rejected events are permanently dequeued (sync.rs:1486-1489) — so EVERY desktop settings change (checkup_visibility commands.rs:835, approval policy :848, profit_split_json :4783, shopify :5040, storefront :5979/:5996, org inbox config email.rs:1051/1056) is silently dropped at the server for any org reached via netsync. In 
  Impact: For any non-default org: payout splits, approval policy, checkup visibility, storefront config, rep payout schedule and shared-inbox config set on desktop never appear on mobile; the same settings saved from mobile never affect the desktop. Payout/br
  Fix: Make the desktop org-aware for settings: when the active store org != org_default, read AND write '{org}::key' rows (one helper mirroring scoped_setting_key). Then either add 'settings' to server PUSHABLE with server-side key re-scoping + the is_secret_key filter, or route desktop settings saves thr
  Evidence: clienthub-api/src/sync.rs:1409-1424; clienthub-api/src/sync.rs:1480-1490; clienthub-api/src/employees.rs:897-907

- **deal_reps written with no sync event — lead-rep assignments never reach desktops**
  staff_api.rs set_lead_rep INSERTs/DELETEs the deal_reps row via bare conn.execute with .ok() and never calls sync::record_upsert / record_delete, yet deal_reps is in ALLOWED_TABLES (sync.rs:949) i.e. a synced table desktops replicate. Any lead-rep set or cleared through the staff/web surface exists only in the server DB; no pull_log entry is appended, so desktops never apply it. Clearing also writ
  Impact: A rep assigned from the web/staff console shows on mobile (mobile reads the server live) but desktop deal views, rep-attribution and rep payout displays computed from the desktop's local deal_reps copy silently omit it — rep pay numbers differ betwee
  Fix: In set_lead_rep, replace the bare executes with sync::record_upsert("deal_reps", &id, cols) for assignment (cols: deal_flow_id, lead_rep_id, assigned_by, assigned_at, org_id) and sync::record_delete("deal_reps", &id, &org) for the clear branch, keeping the local execute alongside as every other rout
  Evidence: clienthub-api/src/staff_api.rs:539-549 (conn.execute INSERT/DELETE deal_reps, no record_upsert/record_delete); clienthub-api/src/sync.rs:949 (deal_reps in ALLOWED_TABLES); clienthub-api/src/sync.rs:662-706 (record_upsert/record_delete are the pull_log appenders)


### P1 — infra-blocker

- **Connection-sharing bridge (/api/org-secrets) is code-complete and mounted, but blocked on droplet deploy + CLIENTHUB_SECRET_KEY env — Mac inbox, Plaid and Stripe secrets stay marooned in one PC's keyring**
  Desktop's share_connections_with_team → push_all_secrets_to_server PUTs smtp/imap passwords, per-inbox IMAP secrets, Stripe keys, Google refresh tokens, Shopify webhook secret, Plaid client_id/secret and every plaid_item to /api/org-secrets (netsync.rs:1310-1367), and materialize_all_secrets_from_server GETs /api/org-secrets/materialize (:1385-1394). Server side: routes exist (routes/org_secrets.r
  Impact: Mobile email sending stays broken (server SMTP secret is junk until the working password is bridged), the MacBook's shared inbox can't authenticate, and bank-linked (Plaid) data can only ever refresh from the single PC that linked it.
  Fix: Deploy a matched set to the droplet (routes/org_secrets.rs + routes/mod.rs + auth.rs + org_secrets.rs + crypto), set CLIENTHUB_SECRET_KEY (base64 32 bytes) in the service env, restart, then run 'Share connections with team' from Jack's PC and 'materialize' on the MacBook. Grep the droplet copies bef
  Evidence: BUSINESS APP/src-tauri/src/netsync.rs:1173-1272,1300-1425; clienthub-api/src/routes/org_secrets.rs:15-16; clienthub-api/src/routes/mod.rs:21,107

- **Mobile email delivery hinges on Resend env + droplet deploy that repo state cannot confirm; without it every mobile send times out or is silently skipped**
  All server-side email (mobile invoice email, quote email, /api/email/send, blasts, recurring newsletters, backup) routes through send_email/send_email_with_attachment, which only uses Resend HTTPS when env CLIENTHUB_PLATFORM_SMTP_PASSWORD starts with 're_' AND CLIENTHUB_PLATFORM_FROM_EMAIL is set (resend_target). Otherwise it falls to lettre SMTP — and the droplet's outbound SMTP ports (25/465/587
  Impact: If the Resend build/env is not live, a rep on mobile cannot email any invoice or quote (request hangs ~30-60s then fails), newsletter blasts queue forever with zero feedback, and the nightly backup email dies — mobile has no outbound email at all.
  Fix: SSH the droplet: confirm binary mtime/commit, add the two Resend env vars to the systemd drop-in if absent, restart, then run POST /api/email/test. Commit the working-tree changes and scp a matched set. Add a Resend section to DEPLOY.md.
  Evidence: clienthub-api/src/email.rs:176-195 (resend_api_key 're_' prefix detection, platform_from_email); clienthub-api/src/email.rs:297-322,328-366 (send_email/_with_attachment Resend-or-SMTP routing); clienthub-api/src/routes/invoices.rs:103-151 (email_invoice: config gate, PDF attach, text fallback)

- **Mobile invoice/quote email send depends on undeployed/rotten SMTP+Resend config on droplet**
  email_invoice loads the org's SMTP settings (invoices.rs:103-109) and email.rs falls back to Resend only when droplet env CLIENTHUB_PLATFORM_SMTP_PASSWORD starts with 're_' AND CLIENTHUB_PLATFORM_FROM_EMAIL is set (email.rs:181-195,215-235). Memory records the droplet platform SMTP password as literally '123' (so resend_api_key() returns None) and that the Resend code path may never have been scp'
  Impact: Tapping Send invoice / Send quote / newsletter Test on mobile fails (or silently sends via a junk account) until the droplet is verified. Mobile CAN save org SMTP itself via Settings (PUT /api/settings/smtp exists and mobile renders the form), which 
  Fix: On the droplet: confirm email.rs matches local HEAD (grep for send_via_resend), set CLIENTHUB_PLATFORM_SMTP_PASSWORD to the real re_ key and CLIENTHUB_PLATFORM_FROM_EMAIL, and rotate the org SMTP secret away from '123'. Then test POST /api/email/test from mobile Settings.
  Evidence: clienthub-api/src/routes/invoices.rs:103-136 (SMTP config load + PDF attach + send); clienthub-api/src/email.rs:181-235 (resend_api_key 're_' gate, platform_from_email gate); clienthub-api/www/app.js:4283-4308 (mobile Send invoice with 90s timeout)

- **Mobile invoice/quote/newsletter email hinges on the Resend fallback actually being deployed to the droplet**
  The local server tree HAS the full fix: email.rs routes sends through Resend's HTTPS API when SMTP is unreachable (email.rs:176-337, resend_target/send via api.resend.com incl. base64 PDF attachments), and email_invoice attaches the branded PDF (invoices.rs:76-165). But clienthub-api deploys by scp (not git) and the droplet is known to lag local HEAD, and the known-bad org SMTP secret ('123') mean
  Impact: Mobile users may be unable to email invoices/quotes at all (the single most transactional mobile action) while desktop sends fine via its own SMTP.
  Fix: SSH the droplet, grep the running binary/source for 'api.resend.com'; if absent, rebuild+scp the matched set (email.rs + invoices.rs + invoice_pdf.rs) and set the Resend key env. Also rotate the junk org SMTP password.
  Evidence: clienthub-api/src/email.rs:176-337 (Resend path present locally); clienthub-api/src/routes/invoices.rs:76-165 (email_invoice + PDF attach); clienthub-api/www/app.js:4290-4295 (mobile send + 'older server' fallback wording)


### P1 — money-divergence

- **/api/invoices never exposes voided, so mobile invoice list and overdue totals include voided (fell-through) invoices**
  INVOICE_COLS omits voided/voided_at/archived flags and list_invoices filters archived only. Mobile's dead filter `i.status !== 'void'` can never match because voiding deliberately leaves status untouched (desktop comment: 'The original status is untouched'). Result: the mobile Invoices tab shows fell-through invoices as live sent/overdue/paid rows, and the dashboard Today-queue overdue total sums 
  Impact: Mobile shows past-due money that desktop says is not owed (the invoice fell through); a user could chase a customer for a voided bill.
  Fix: Add voided (and archived) to INVOICE_COLS/Invoice model, exclude voided from list_invoices by default or return the flag, and fix app.js filters to use it (also un-deadening the 'void' badge logic).
  Evidence: clienthub-api/src/routes/invoices.rs:204 (INVOICE_COLS lacks voided); clienthub-api/src/routes/invoices.rs:644 (list filters archived only); clienthub-api/www/app.js:2975,3036-3048 (status!=='void' dead filter; overdueTotal from this list)

- **Client portal lists voided AND archived (deleted) invoices as real bills**
  The public portal invoice query has no voided or archived filter at all — a customer opening their portal link sees soft-deleted invoices and fell-through invoices with due dates and totals, as if owed. Every internal surface (desktop AR, staff receivables) excludes both flags.
  Impact: Customer-facing: clients see bills the business considers void/deleted — wrong outstanding balances shown externally.
  Fix: Add AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 to the portal invoice query.
  Evidence: clienthub-api/src/routes/portal.rs:59-77 (SELECT ... FROM invoices WHERE client_id/org only); clienthub-api/src/staff_api.rs:1243-1246 (staff receivables excludes voided+archived — the intended contract)

- **Completing a deal on mobile ignores linked bank transactions; same deal completed on desktop stores different profit**
  Server complete_deal_flow sets gross = payment_received_amount, cost = total_supplier_cost, net = gross - cost. Desktop complete_deal_flow first calls deal_bank_actuals so bank-linked legs win, and snapshots the linked bank txns into metadata.bank_snapshot. A deal with bank allocations completed from mobile books stepper figures (and no bank_snapshot), while the identical deal completed on desktop
  Impact: A broker who closes a deal from the phone records profit that can differ by the full amount of any wire fee / partial payment / supplier refund captured in the bank feed; the FAIL-PROOF bank snapshot is also missing for that deal.
  Fix: In server complete_deal_flow, compute (gross, cost, net) via a ported deal_bank_actuals and write the same bank_snapshot metadata key the desktop writes.
  Evidence: clienthub-api/src/routes/deal_flows.rs:867-885 (net = payment_received_amount - total_supplier_cost, no bank read); clienthub-api/src/routes/deal_flows.rs:897 (metadata built without bank_snapshot); BUSINESS APP/src-tauri/src/commands.rs:4128-4135 (desktop completion uses deal_bank_actuals)

- **Desktop daily-profit chart command has NO guards at all — disagrees with the server endpoint AND with desktop's own hero**
  Desktop get_monthly_profit (feeds DashboardView's cumulative month chart) sums net_profit/gross_revenue over stage='complete' with no archived, no voided-invoice, and no refund guard. The server's /api/dashboard/monthly-profit (mobile's same chart) applies archived + NOT_VOIDED (but no refunds). So the desktop chart includes voided/archived deals the mobile chart excludes, and both disagree with t
  Impact: The 'cumulative profit this month' line differs between desktop and mobile whenever a completed deal in the month is voided/archived, and neither matches the hero Profit figure exactly.
  Fix: Give commands.rs get_monthly_profit the same JOIN-invoices + archived/voided + refund-aware expression as PROFIT_MONTH_SQL, and add the refund subtraction to the server endpoint, so chart == hero on both surfaces.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:8593-8605 (no guards); BUSINESS APP/src/components/DashboardView.tsx:119 (chart consumes getMonthlyProfit); clienthub-api/src/routes/dashboard.rs:45-66 (server version: archived + NOT_VOIDED)

- **Mobile dashboard all-time profit/margin not refund-aware (invoices.profit vs desktop deal_flows minus refunds)**
  Server dashboard_stats computes total_profit and avg_margin from SUM(invoices.profit) WHERE is_complete=1 (dashboard.rs:111-113) and monthly_profit sums deal_flows.net_profit with no refund subtraction (dashboard.rs:53-56). Desktop's equivalents subtract refunds per deal: NP = df.net_profit - SUM(refunds) (commands.rs:8798-8806, 8259, 8413-8420). invoices.profit is stamped from net_profit (command
  Impact: Mobile dashboard profit and margin overstate by the total refunded amount; desktop and mobile disagree on the headline number Jack checks daily.
  Fix: In dashboard_stats and monthly_profit, source profit from deal_flows with the refund-subtracting NP expression (as desktop does), or subtract a refunds subquery from the invoices-based sums.
  Evidence: clienthub-api/src/routes/dashboard.rs:53-56,111-113; BUSINESS APP/src-tauri/src/commands.rs:8798-8806,8259,8413-8420; clienthub-api/www/app.js:2968,3191 (mobile uses /api/dashboard/stats and /monthly-profit)

- **Mobile weekly brief counts voided/archived deals and ignores refunds — diverges from desktop brief**
  Server weekly_brief (dashboard.rs:408-587, served to mobile at app.js:5659 /api/weekly-brief) sums deal_flows gross_revenue/net_profit/profit_* with NO archived filter, NO voided-invoice guard, and NO refund subtraction (dashboard.rs:457-545). Desktop's brief uses a `live` fragment excluding archived rows and voided invoices (commands.rs:9131) and a refund-aware net `np = net_profit - SUM(refunds)
  Impact: Mobile Brief revenue/profit/margin/payout figures are inflated vs desktop whenever a deal was voided, archived, or refunded — exactly the INV-2026-0038 class of bug, still live in the brief.
  Fix: Append the archived + NOT_VOIDED fragments and subtract per-deal refunds SUM in every deal_flows aggregate inside weekly_brief; add COALESCE(archived,0)=0 to the deals pipeline queries. Mirror commands.rs:9131-9133 fragments.
  Evidence: clienthub-api/src/routes/dashboard.rs:457-545,558-587 (no voided/archived/refund guards); clienthub-api/src/routes/dashboard.rs:29 (NOT_VOIDED defined but unused here); BUSINESS APP/src-tauri/src/commands.rs:9131-9163 (desktop live+refund-aware brief)

- **Payout split config read unscoped on desktop but org-scoped on server — non-default orgs compute different splits per surface (verified known gap)**
  Desktop reads settings key 'profit_split_json' (and legacy profit_split_* keys) with no org scoping; the server reads scoped_setting_key(org, ...) AND org_id. For any non-default org, a split configured via mobile/server is stored under the scoped key and the desktop's unscoped read misses it (and vice versa), so deal completion and brief payout_totals allocate different amounts per surface. Confi
  Impact: For non-default orgs, completing the same deal on mobile vs desktop persists different payout_recipients/profit_jack/ben/business figures, and brief payout totals disagree.
  Fix: Make the desktop settings reads org-aware (store/lookup the scoped key for the logged-in org), or have the server also mirror the value to the unscoped key on write for the org the desktop is bound to.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:4641-4651 (unscoped profit_split_json read); BUSINESS APP/src-tauri/src/commands.rs:5932-5939 (unscoped legacy split keys, 40/30/30 defaults); clienthub-api/src/routes/dashboard.rs:366-374 (server scoped read)

- **Rep payout statements and staff Deals table include archived and fell-through deals**
  list_payouts (drives the mobile Payouts tab: 'amount owed per rep') filters only stage='complete' + period; list_deals (staff deals table with per-deal net_profit and the admin waterfall) filters only org. Neither excludes COALESCE(df.archived,0)=0 nor voided/archived invoices. So a completed deal that later fell through (invoice voided) or was archived still accrues rep commission owed on mobile/
  Impact: Payout statements over-state what reps are owed whenever a completed deal is archived or falls through; risk of actually over-paying reps.
  Fix: Add the archived + voided/archived-invoice guard (join or NOT EXISTS) to both list_payouts and list_deals; same guard belongs on weekly_brief's rep_earnings query (dashboard.rs:679-686) and desktop's twin (commands.rs:9307-9312), which share the omission.
  Evidence: clienthub-api/src/staff_api.rs:979-987 (list_payouts: no archived/voided guard); clienthub-api/src/staff_api.rs:374-388 (list_deals: WHERE df.org_id only); clienthub-api/www/app.js:1159-1165 (mobile Payouts consumes /api/staff/payouts)

- **Server /api/weekly-brief has NO voided/archived/refund guards on any deal_flows money SUM — mobile brief inflated vs desktop brief**
  Every deal_flows aggregate in server weekly_brief (revenue_this_week, profit_this/last_week, avg_margin, df_count, profit_jack/ben/business, loss stats, mtd_*, payout split_week/month/all) filters only stage='complete' + org. The desktop brief appends `live` (COALESCE(df.archived,0)=0 AND NOT EXISTS voided/archived invoice) and uses refund-aware `np` (net_profit - SUM(refunds)) on every one of tho
  Impact: Mobile Brief shows higher revenue/profit than desktop whenever any deal was archived, fell through after completion, or was refunded; payout_totals on mobile tells partners they are owed more than the desktop brief says.
  Fix: In weekly_brief, append the archived guard + NOT_VOIDED to every deal_flows SUM and subtract per-deal refunds exactly like the desktop `np` expression (a shared SQL fragment mirroring commands.rs:9131-9133).
  Evidence: clienthub-api/src/routes/dashboard.rs:457-545 (all brief SUMs: only stage+org filters); clienthub-api/src/routes/dashboard.rs:29 (NOT_VOIDED exists but is not used in weekly_brief); BUSINESS APP/src-tauri/src/commands.rs:9131-9133 (desktop `live` + refund-aware `np` guards)

- **Server brief pipeline stats read the dead `deals` CRM table — mobile brief win rate, deals closed/lost, best/worst margin permanently wrong**
  Server weekly_brief computes deals_closed/deals_lost/win_rate from deals.won_at/lost_at, and best_margin/worst_margin/biggest components from the deals table — but the invoice→deal-flow workflow never sets won_at/lost_at (the desktop code says these were 'permanently at zero'). Desktop was rewritten to derive closed = completed deal_flows and lost = invoices voided in the window (voided_at), refun
  Impact: Mobile Brief's 'closed · lost · win rate' row and margin highlight cards show zeros/nonsense while desktop shows real numbers.
  Fix: Port the desktop's deal_flows-based closed/lost/win-rate and margin-highlight queries (including voided_at window for losses) into weekly_brief, replacing the deals-table reads.
  Evidence: clienthub-api/src/routes/dashboard.rs:573-581 (deals_closed/lost from deals.won_at/lost_at); clienthub-api/src/routes/dashboard.rs:605-627 (best/worst margin from deals.asking_price); BUSINESS APP/src-tauri/src/commands.rs:9219-9238 (desktop: real pipeline, comment documenting deals-table stats were permanently zero)

- **Server dashboard top_suppliers includes fell-through deals; desktop excludes them**
  The server's top_suppliers aggregate over supplier_payments_json filters df.archived only — no voided/archived-invoice guard — while the desktop version JOINs invoices and excludes i.voided/i.archived (and the /api/suppliers stats query is also correctly guarded). Mobile dashboard 'top suppliers' totals count supplier payments on voided deals.
  Impact: Mobile dashboard supplier 'total paid' figures exceed desktop's for any supplier involved in a fell-through deal.
  Fix: Add JOIN invoices i ON i.id=df.invoice_id with voided/archived guards to the dashboard top_suppliers query, copying suppliers.rs:56-57.
  Evidence: clienthub-api/src/routes/dashboard.rs:214-232 (no invoice guard); BUSINESS APP/src-tauri/src/commands.rs:8433-8449 (desktop guarded); clienthub-api/src/routes/suppliers.rs:47-59 (suppliers route guarded — internal inconsistency on the server itself)

- **Server dashboard/monthly profit is not refund-aware and misses the archived-invoice exclusion — mobile dashboard/analytics profit differs from desktop**
  Server profit_mtd/profit_prev/profit_all_time, the monthly series, all_time_revenue/profit, and /api/dashboard/monthly-profit use SUM(net_profit) with archived+NOT_VOIDED but never subtract refunds and never exclude flows whose invoice is archived (NOT_VOIDED checks voided only, and the subquery form also lets orphan flows with a deleted invoice through). Desktop computes profit as SUM(net_profit 
  Impact: Mobile dashboard hero Profit, prev-month delta, Analytics monthly table, and all-time profit exceed desktop by the total refunded amount plus any archived-invoice deals.
  Fix: Change every deal_flows profit SUM in dashboard.rs (stats + monthly_profit) to JOIN invoices with voided+archived guards and subtract the per-deal refunds subquery, mirroring commands.rs PROFIT_MONTH_SQL.
  Evidence: clienthub-api/src/routes/dashboard.rs:205-211 (profit_mtd/all_time: no refund subtraction, no i.archived); clienthub-api/src/routes/dashboard.rs:53-56,118-119,236-237 (monthly series + all-time: same gaps); BUSINESS APP/src-tauri/src/commands.rs:8412-8424 (desktop PROFIT_MONTH_SQL refund-aware + i.voided/i.archived)

- **Server open_deals hero counts duplicate flows and orphans; desktop counts distinct invoices at best stage**
  Server open_deals is COUNT(*) over deal_flows LEFT JOIN invoices — duplicate flow rows per invoice each count, and a flow whose invoice row is missing passes the COALESCE(i.voided,0)=0 checks via NULL. Desktop groups by invoice_id, takes the best (survivor) stage, requires an INNER JOIN to invoices, and counts invoices whose best stage < complete. With the known duplicate deal_flow rows still in t
  Impact: Mobile dashboard 'open deals' count disagrees with desktop whenever a duplicate or orphan flow exists.
  Fix: Replace the server query with the desktop's grouped best-stage subselect (INNER JOIN invoices, GROUP BY invoice_id, best < 4).
  Evidence: clienthub-api/src/routes/dashboard.rs:100 (COUNT(*) LEFT JOIN); BUSINESS APP/src-tauri/src/commands.rs:8305-8321 (distinct-invoice best-stage count, comment on ghost/orphan inflation)

- **weekly_brief counts voided and archived deals — mobile Brief money diverges from dashboard/desktop**
  dashboard_stats/monthly_profit got the NOT_VOIDED guard (dashboard.rs:29,48,72) but every deal_flows money query inside weekly_brief (revenue_this_week, profit_this_week, avg_margin, df_count, loss totals, split_week/month/all feeding payout_totals) filters only stage='complete' + dates — no NOT_VOIDED and no COALESCE(archived,0)=0. A voided completed deal (the INV-2026-0038 class) or an archived 
  Impact: Mobile Weekly Brief profit/revenue/margin/win-rate and the per-recipient payout boxes disagree with the mobile dashboard hero (which uses the guarded stats) and with desktop — reps and owners see wrong weekly earnings.
  Fix: Append the same NOT_VOIDED fragment plus AND COALESCE(archived,0)=0 to every deal_flows aggregate in weekly_brief (they all share the stage='complete' WHERE prefix, so it is a mechanical edit), then deploy dashboard.rs to the droplet as a matched set.
  Evidence: clienthub-api/src/routes/dashboard.rs:457-505 (weekly_brief SUM queries with no voided/archived guard); clienthub-api/src/routes/dashboard.rs:29 (NOT_VOIDED const, used only up to line 237); clienthub-api/www/app.js:5679-5748 (mobile Brief renders these fields incl. payout_totals)


### P1 — parity-missing

- **Mobile cannot create a deal flow — mobile-authored invoices never enter the pipeline until a desktop opens Deal Flow**
  Server create_invoice (invoices.rs:368) creates no deal_flow row and app.js never POSTs to the deal-flow create route (grep for POST /api/deal-flows create: no matches; all mobile calls are per-id stage actions, app.js:4756-5581). The flow only appears when desktop DealFlowView auto-heals missing flows on load (DealFlowView.tsx:84-90 createDealFlow for invoices without one). A mobile-only org (or 
  Impact: Invoices created and sent from mobile do not show up in the mobile Deal Flows tab; payment/supplier tracking on that deal is impossible until some desktop happens to open its Deal Flow view.
  Fix: Replicate the desktop heal: on the server's list_deal_flows (or invoice send / mark-sent), auto-create a deal_flow for any non-voided, non-archived invoice lacking one — the create route logic already exists in deal_flows.rs:86-190.
  Evidence: clienthub-api/src/routes/invoices.rs:368 (create_invoice, no flow); BUSINESS APP/src/components/DealFlowView.tsx:84-90 (desktop auto-create heal); clienthub-api/www/app.js:4756-5581 (no create call, only per-id actions)


### P1 — parity-partial

- **Invoice studio branding (invoice_template/quote_template) and numbering config never leave the authoring desktop — mobile/server PDFs render with default branding and possibly different numbering**
  Desktop saves invoice_template/quote_template as raw local settings writes with no record_upsert (invoice.rs:168-172, 205-209), and numbering config likewise (commands.rs:2195-2200). The server's invoice_pdf.rs reads its OWN scoped invoice_template/quote_template/company_info rows (invoice_pdf.rs:150, 187, 219) — which nothing ever populates from the desktop (settings aren't netsync-pushable, and 
  Impact: An invoice created/sent from mobile goes to the customer with default styling, no custom title/footer/accent, and potentially a different number prefix/padding than desktop invoices from the same org — visibly inconsistent customer-facing documents.
  Fix: On desktop save_invoice_template/save_quote_template/save_invoice_numbering_config, also sync::record_upsert the settings keys (they're non-secret), and rely on finding 1's scoping fix so they land for every org; alternatively PUT them to a small /api/settings route the server already reads scoped.
  Evidence: BUSINESS APP/src-tauri/src/invoice.rs:133-145,168-172,181-209; BUSINESS APP/src-tauri/src/commands.rs:2125-2200; clienthub-api/src/invoice_pdf.rs:13-29,150,187,219

- **Mobile can complete a deal with manual figures — bypasses desktop bank-truth and has zero reconciliation UI**
  Mobile completes deals via POST /api/deal-flows/:id/complete (app.js:4860,5581). The server's complete_deal_flow/recalc_completed_deal_flow compute gross from payment_received_amount and cost from supplier_payments rows (deal_flows.rs:261-320, 853-937) — the pre-v0.15.91 manual model. Desktop's bank-truth path stamps net_profit from bank-linked txns (commands.rs:4164-4175, recalc_deal_from_bank at
  Impact: A deal completed from a phone records profit from hand-entered amounts, not bank reality; desktop then shows it as an unreconciled/possibly-wrong snapshot the phone user can neither see nor repair.
  Fix: Short term: surface the recon status (from_bank flag + bank-linked totals) in the mobile deal drawer and warn on manual completion. Longer: port the bank-txn link/allocation picker to app.js against the synced bank_txn/bank_allocation tables (server routes needed — none exist today for allocation CR
  Evidence: clienthub-api/src/routes/deal_flows.rs:261-320,853-937; clienthub-api/www/app.js:4860,5581,5426 (complete calls; only a bank-ref note field); BUSINESS APP/src-tauri/src/commands.rs:4164-4175,4338-4372 (bank-truth completion/recalc)

- **Scheduled/blast newsletter attachments are silently dropped — server scheduler (the only processor) never attaches anything**
  Desktop schedule_newsletter_send stores attachment_path (a desktop-local file path) into scheduled_sends and syncs it to the server. But scheduled_sends are delivered exclusively by the SERVER scheduler (desktop code comment: 'Scheduled Sends (processed by Pi scheduler)'; no desktop delivery loop exists), and process_pending_sends reads job.attachment_path into the ScheduledJob struct and then NEV
  Impact: Any newsletter scheduled from desktop (or blasted from mobile) that was supposed to carry a file (price list PDF, manifest) arrives to clients with no attachment and nobody is told; mobile users cannot attach files to any outbound email at all.
  Fix: On desktop schedule, upload the attachment bytes to a new server route (like the logo upload) and store the SERVER path in scheduled_sends.attachment_path; in process_pending_sends, when attachment_path is set read the file and use send_email_with_attachment (Resend already carries base64 attachment
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:12154-12204 (schedule_newsletter_send stores + syncs attachment_path), 12122-12123 ('processed by Pi scheduler'), 12027-12031 (immediate path validates attachment), 12070 (immediate path attaches); clienthub-api/src/scheduler.rs:631-646 (ScheduledJob.attachment_path read), 518-553 (delivery uses send_email — no attachment argument anywhere); clienthub-api/src

- **Server-rendered invoice/quote PDFs never receive Invoice-studio branding — invoice_template/quote_template have NO path to the server, and company_info is forked desktop-local vs server**
  invoice_pdf.rs's header comment asserts 'invoice_template, company_info ... are per-org synced rows on the server' — that is false. Desktop save_template/save_quote_template do a raw local INSERT into settings with no record_upsert and no REST push (invoice.rs:166-175, 203-212); desktop save_company_info likewise saves company_info locally only (it pushes only the LOGO bytes via POST /api/settings
  Impact: Invoices/quotes emailed or downloaded from mobile carry default branding (wrong accent color, default title/footer, possibly no logo and placeholder company info) — clients see a different-looking document than the desktop-sent one.
  Fix: Add PUT/GET /api/settings/invoice-template (+quote-template) org-scoped routes and call them from desktop save_template/save_quote_template (mirror the existing /api/settings/smtp pattern); make desktop save_company_info also PUT /api/settings/company. One-time: re-save company info on desktop so th
  Evidence: clienthub-api/src/invoice_pdf.rs:8-13 (wrong 'synced rows' assumption), 88-103 (defaults), 145-176 (load_template scoped read), 438-459 (logo fallback); BUSINESS APP/src-tauri/src/invoice.rs:166-175,203-212 (save_template/save_quote_template: local INSERT only, no sync); BUSINESS APP/src-tauri/src/commands.rs:6608-6651 (save_company_info local-only + logo-bytes push)


### P1 — sync-bug

- **Deleting a staff account deletes their deal_reps rows without tombstones**
  Admin user-delete (employees.rs:2120) and self account-delete (employees.rs:2292) run DELETE FROM deal_reps WHERE lead_rep_id=... and only record_delete the staff_accounts row (2123/2299). purge_org_data does the same at 2334. Desktops never receive the deal_reps deletes, so deals stay assigned to a rep whose account no longer exists; the desktop payout brief keeps attributing cuts to the deleted 
  Impact: After removing a team member on web/mobile, desktops keep showing that person as lead rep on their deals and keep computing their payout cut.
  Fix: Before the DELETE, SELECT the deal_flow_ids for the rep, then call sync::record_delete("deal_reps", &deal_flow_id, &org) for each (deal_reps keys on deal_flow_id).
  Evidence: clienthub-api/src/employees.rs:2119-2123 (DELETE deal_reps + DELETE staff_accounts; only staff_accounts recorded); clienthub-api/src/employees.rs:2292-2299 (same pattern on self-delete); clienthub-api/src/employees.rs:2333-2336 (purge_org_data deal_reps delete, no record)

- **Google Sheet write-back only fires when the approval is clicked on the one desktop holding the Google token + sheet mapping — mobile approvals silently never update the sheet**
  Sheet write-back is invoked only inside the DESKTOP approve paths (commands.rs:572, 739) and is explicitly best-effort/silent-skip when the sheet config or Google OAuth token is absent on THAT device (sheet_writeback.rs:13-18, 440-455 — token via crate::email::oauth2_access_token from the local keyring; mapping from the local-only sheet_sync_config table). The server approve handler does nothing s
  Impact: Approving a lead from mobile (a fully supported, synced workflow) silently skips the Google Sheet upsert — the sheet the org treats as a source of truth is permanently missing those rows, with no error anywhere.
  Fix: Make write-back state synced instead of event-local: stamp approved clients with a 'sheet_writeback_pending' marker (or a small synced queue table) at approve time on ANY surface, and have the configured desktop drain pending markers on its scan loop; longer term, move write-back server-side using t
  Evidence: BUSINESS APP/src-tauri/src/sheet_writeback.rs:1-18,87-100,440-455; BUSINESS APP/src-tauri/src/commands.rs:568-576,735-743; clienthub-api/src/routes/approvals.rs:223-240

- **Message read receipts (read_at) never replicate — unread badges diverge forever**
  routes/messages.rs marks messages read in two places — the bulk mark-read inside list (line 31-34) and the single PATCH read handler (line 104) — with raw UPDATEs and no record_upsert. messages is a synced table (server sync.rs:945) and the send path DOES record (messages.rs:92). Read-state set on one surface never reaches any desktop, so desktop unread counts/read indicators stay wrong permanentl
  Impact: Reading a message on mobile leaves it flagged unread on desktop (and vice versa via any web surface) forever; unread counters across devices never converge.
  Fix: After each read_at UPDATE, emit record_upsert("messages", &id, {read_at, org_id}) per affected row (the bulk path needs a SELECT id first, or a per-thread loop).
  Evidence: clienthub-api/src/routes/messages.rs:31-34 (UPDATE messages SET read_at ... no record); clienthub-api/src/routes/messages.rs:104-106 (PATCH read handler, same gap); clienthub-api/src/routes/messages.rs:82-92 (send path records — the asymmetry)

- **Mobile fell-through never stamps voided_at, so desktop 'deals lost' and win rate never count mobile-voided deals**
  Server set_fell_through writes only voided=flag (both to the row and the sync event); desktop set_invoice_void writes voided + voided_at. Desktop brief counts deals_lost by voided_at within the window (i.voided_at >= ?1). A deal marked fell-through from mobile therefore has voided_at NULL forever and is invisible to desktop's loss count and win rate (and to any voided_at-based period stat), while 
  Impact: Marking a deal fell-through on mobile silently under-reports losses (and inflates win rate) on every desktop brief.
  Fix: In set_fell_through, also set voided_at = now (and NULL on un-void) in both the local UPDATE and the record_upsert cols, matching commands.rs set_invoice_void.
  Evidence: clienthub-api/src/routes/deal_flows.rs:83-93 (only voided written, no voided_at); BUSINESS APP/src-tauri/src/commands.rs:3086-3098 (desktop writes voided + voided_at); BUSINESS APP/src-tauri/src/commands.rs:9233-9237 (desktop deals_lost counts voided_at in window)

- **Password reset never syncs the new hash — old password keeps working on desktop**
  employees.rs handle_reset_password UPDATEs staff_accounts.password_hash without calling emit_staff (every other staff_accounts mutation in the file does: 1171, 1587, 1758, 1855, 2092). Desktop login verifies bcrypt LOCALLY against the synced staff_accounts.password_hash (desktop employees.rs:361-367). After a web password reset, every desktop keeps the OLD hash until some unrelated profile edit re
  Impact: User resets password on web/mobile, then cannot sign in on desktop with the new password; the old (possibly compromised) password remains valid on all desktops.
  Fix: Call emit_staff(&staff_id) after the successful UPDATE in handle_reset_password (employees.rs ~1683), exactly like handle_verify_email does at 1587.
  Evidence: clienthub-api/src/employees.rs:1672-1687 (UPDATE staff_accounts SET password_hash ... then audit + return; no emit_staff); clienthub-api/src/employees.rs:1585-1587 (contrast: email-verification update DOES emit_staff); BUSINESS APP/src-tauri/src/employees.rs:361-367 (desktop verifies bcrypt against local staff_accounts row)

- **Settings scoping gap confirmed: desktop reads settings keys unscoped, server stores org-scoped for non-default orgs**
  Verified, not stale: desktop queries settings by bare key with no org prefix (commands.rs:543, 813, 2134-2140, 2187-2189, 2386-2388) while the server prefixes keys per-org for any org other than org_default (settings.rs sk() usage; email.rs:57-80 load_smtp_config_for shows the sk() pattern). Any setting saved from mobile Settings (company info, SMTP, invoice numbering, templates) for a non-default
  Impact: For any non-default org, settings configured on mobile (email sending, company info, invoice numbering) never take effect in the desktop app, and vice versa.
  Fix: Make the desktop settings read/write helpers org-aware: resolve the logged-in org id and use the same sk()-style prefixed key (falling back to the bare key for org_default), in one shared helper rather than per-call-site edits.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:543,813,2134-2140,2187-2189,2386-2388 (unscoped reads); clienthub-api/src/email.rs:57-80 (org-prefixed setting keys on server); clienthub-api/www/app.js:6172-6196 (mobile saves SMTP via /api/settings/smtp)

- **Unsubscribes (email_suppression) never reach the desktop send path — desktop keeps emailing opted-out contacts**
  Unsubscribe writes email_suppression (unsubscribe.rs:76-82), a table not in ALLOWED_TABLES and absent from the desktop schema entirely (grep for email_suppression/suppress in src-tauri returns nothing). The server scheduler honors it (scheduler.rs:493 is_suppressed) and appends an unsubscribe footer (scheduler.rs:522-526), but the desktop's direct send_newsletter path (commands.rs:12016+) sends vi
  Impact: A contact who unsubscribes via the link in a server-sent newsletter continues to receive newsletters whenever they are sent from the desktop app — a compliance risk invisible to the user.
  Fix: Either sync suppression down (add an email_suppression mirror + ALLOWED_TABLES entry, or fold it into clients.exclusive via record_upsert when suppress() fires — the simplest: unsubscribe.rs also sets the matching client's exclusive=1 through record_upsert), or route ALL desktop bulk sends through t
  Evidence: clienthub-api/src/routes/unsubscribe.rs:66-82 (is_suppressed + suppress, server-local table); clienthub-api/src/scheduler.rs:493-499, 522-526 (server path honors suppression + footer); BUSINESS APP/src-tauri/src/commands.rs:12045-12097 (desktop send loop: blacklist/exclusive only, no suppression, body sent as-is)

- **company_info is a one-way clobber and logo_path syncs a device-absolute path — desktop invoices/release letters silently lose the logo, desktop company edits never propagate and get reverted**
  Desktop save_company_info writes the settings row locally with NO record_upsert (commands.rs:6630-6637) — desktop edits to company name/address/email never reach the server or mobile. The server DOES record_upsert company_info: save_company (routes/settings.rs:250-274) and set_company_logo_path (:301-335, called by upload_logo :374). upload_logo stores logo_path='/home/jack/ClientHub/media/logos/<
  Impact: Company info edited on desktop never shows on mobile (stale name/address on mobile-generated invoices); conversely a mobile company-info save or logo upload strips the logo from every desktop-generated PDF until the desktop user re-saves it.
  Fix: Sync desktop save_company_info via record_upsert, but stop syncing logo_path as an absolute path: store a device-independent marker (e.g. logo present + hash) in company_info, have each renderer resolve its own local file (<app_data>/company_logo.png or logos/<org>.png), and add a netsync download t
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:6608-6651; clienthub-api/src/routes/settings.rs:250-274,294-335,341-376; BUSINESS APP/src-tauri/src/invoice.rs:464-472

- **newsletter_sends is split-brain: server-side and desktop-side send records never merge**
  The server scheduler (which delivers all scheduled + mobile 'send blast' newsletters) INSERTs per-recipient newsletter_sends rows only on the droplet (scheduler.rs:497, 510, 532, 545, 559); the desktop 'send now' path INSERTs them only locally (commands.rs:12074, 12083, 12093). The table is not synced — the desktop apply-side explicitly rejects it (commands.rs:9557-9561 comment). But the desktop U
  Impact: Client activity/'not yet contacted' indicators are wrong on desktop for anything sent via mobile or the scheduler; mobile cannot see delivery results of desktop-sent newsletters; cross-surface re-sends can double-email clients.
  Fix: Add newsletter_sends to both ALLOWED_TABLES lists (schema already mirrored on both sides) and emit record_upsert at each of the 8 insert sites (5 in scheduler.rs, 3 in desktop commands.rs); rows are append-only so LWW conflicts are moot.
  Evidence: clienthub-api/src/scheduler.rs:497-559 (server-only inserts), 420-433 (dedupe reads server copy); BUSINESS APP/src-tauri/src/commands.rs:12074-12094 (desktop-only inserts); BUSINESS APP/src-tauri/src/commands.rs:72, 134 (desktop displays derived from newsletter_sends)

- **sheet_sync_config (import column mapping + writeback toggle) is device-local while its output is the org-shared client book — per-device mapping drift corrupts synced data on manual Sync-now**
  The whole sheet_sync_config row is explicitly 'local-only, not synced' (db.rs:463-472 migration comment; writeback_enabled likewise :1226-1234). The code's own freeze comment (commands.rs:13390-13398) documents the consequence: 'a drifted per-device column mapping wrote wrong names into the org-shared client book' while wiping metadata (lat/lng, high_value, exclusive, tags, cf:*). The periodic imp
  Impact: Client names/categories/metadata that mobile users see (and the globe) can be silently rewritten or wiped by any desktop running Sync-now with a stale per-device mapping; mobile has no view of, or control over, which mapping is in force.
  Fix: Promote the mapping to a single org-shared source of truth: store sheet_sync_config as an org-scoped settings JSON (synced via the fixed settings path from finding 1) or a server-side config, and make the importer merge into client metadata instead of rebuilding it; keep Sync-now gated on the shared
  Evidence: BUSINESS APP/src-tauri/src/db.rs:460-493,824-833,1225-1234; BUSINESS APP/src-tauri/src/commands.rs:13390-13419; BUSINESS APP/src-tauri/src/main.rs:976-982


### P2 — money-divergence

- **Mobile client-detail profit is not deduped by invoice — duplicate flow rows double-count**
  Desktop ClientDetailView sums completed flows deduped by invoice_id ('belt-and-suspenders' against the known duplicate deal_flow rows). Mobile showClientDetail sums every completed flow for the client with no dedupe. With the 15 known invoices having duplicate flow rows, the mobile per-client profit stat can be up to double the desktop's.
  Impact: Client detail 'profit from this client' can be inflated on mobile for clients touched by duplicate flows.
  Fix: Add the same seen-invoice_id Set dedupe in app.js showClientDetail before reducing.
  Evidence: clienthub-api/www/app.js:3370-3378 (no dedupe); BUSINESS APP/src/components/ClientDetailView.tsx:165-175 (dedupe by invoice_id)

- **Server brief biggest_invoice includes voided/archived invoices**
  Server weekly_brief biggest_invoice picks the largest paid invoice in the window with no voided/archived guard; the desktop twin excludes both. A large fell-through invoice becomes mobile's 'biggest invoice' highlight while desktop shows a different one.
  Impact: Brief highlight card can name a voided deal's invoice and amount on mobile.
  Fix: Add COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 to the server query.
  Evidence: clienthub-api/src/routes/dashboard.rs:629-637 (no guard); BUSINESS APP/src-tauri/src/commands.rs:9271-9280 (guarded)


### P2 — parity-missing

- **Deal receipts (deal_receipts) have no mobile surface**
  deal_receipts is a synced table (sync.rs:968) with a desktop attach/view flow, but app.js has zero 'receipt' occurrences. Snapping a photo of a receipt is the canonical phone action and it's the one place it doesn't exist.
  Impact: Cannot attach or view receipts on a deal from mobile.
  Fix: Add an upload endpoint storing the blob server-side (desktop receipts referencing local file paths won't render on mobile — same caveat as the invoice logo) and a thumbnail strip in the mobile deal drawer.
  Evidence: clienthub-api/src/sync.rs:968; clienthub-api/www/app.js (grep 'receipt': no matches)

- **Financials module (Chase import, allocation, Free Cash, loans) has zero mobile surface**
  bank_txn, bank_allocation, cash_purchase, business_expense, reserve_entry, loan, deal_receipts are all synced tables (sync.rs:961-967) with desktop UI, but www/app.js has no view, route call, or read-only screen for any of them; the More menu has no Financials entry.
  Impact: Standing mobile-parity rule violated: Jack cannot see Free Cash, unallocated bank txns, or loan balances from his phone at all.
  Fix: Add a read-only Financials screen first (Free Cash header + unallocated txn count + recent bank txns) backed by new lightweight GET routes or the existing synced rows via a small server endpoint; defer import/allocation editing to desktop.
  Evidence: clienthub-api/src/sync.rs:961-967; clienthub-api/www/app.js:1014-1103 (renderMore groups — no Financials)

- **Financials module (Chase/OFX import, bank allocation, Free Cash, Loans) entirely missing on mobile**
  Desktop has FinancialsView, FreeCashView, LoansView plus bank import/allocation commands. app.js has no financials/free-cash/loans/bank view at all — the only 'financ' hits are role-gating comments (app.js:2921-2928) and the render(tab) switch (app.js:684-713) has no financials case. The underlying tables (bank_txn, bank_allocation, cash_purchase, business_expense, reserve_entry, loan) ARE synced 
  Impact: No way to see Free Cash, bank transactions, allocations, loans, or run any treasury workflow away from the desktop.
  Fix: Phase it: read-only Free Cash + bank txn list first (server routes over the already-synced tables), then allocation actions. Plaid webhook ingestion already writes bank_txn server-side (plaid.rs:329-395).
  Evidence: clienthub-api/www/app.js:684-713 (no financials tab), 2921-2928; clienthub-api/src/sync.rs:962-967 (tables synced); BUSINESS APP/src/components/FinancialsView.tsx, FreeCashView.tsx, LoansView.tsx (exist)

- **Financials suite (bank import, allocation, Free Cash, recalc-from-bank, orphan cleanup) has zero mobile surface**
  bank_txn/bank_allocation and the ledger tables are fully synced (server sync.rs ALLOWED_TABLES) and the server even mutates bank_txn via Plaid, but the mobile PWA has no Financials/Free Cash/bank-reconciliation UI at all (no bank-related rendering in app.js), and no server route exposes deal_bank_actuals or recalc. All bank-truth corrections must happen on desktop; a mobile-first user cannot see o
  Impact: No mobile access to Chase/Plaid transactions, allocations, Free Cash, loans, or the Recalculate-from-bank action; standing mobile-parity rule violated for the entire money-truth layer.
  Fix: Phase 1: read-only mobile Financials (list bank_txn, per-deal reconciliation status) + a server /api/deal-flows/:id/recalc-from-bank endpoint reusing the ported deal_bank_actuals; full allocation UI later.
  Evidence: clienthub-api/src/sync.rs:962-963,1418 (bank tables synced); clienthub-api/src/routes/plaid.rs:327-448 (server writes bank_txn); clienthub-api/www/app.js:2921,4682 (only 'financial' mentions; no bank UI)

- **Inventory photos/manifest upload and storefront management missing on mobile**
  Server accepts POST /api/inventory/:id/photo/:name and /manifest/:name (inventory.rs:34-35, handlers at 46,97) and has storefront config GET/POST /api/settings/storefront (storefront.rs:23), but the mobile lot form (app.js:3589-3642) has no file inputs and there is no storefront screen — the public storefront (BJM-enabled) can only be curated from desktop. Phones are where lot photos are taken.
  Impact: Cannot photograph a lot and attach it from the warehouse floor; cannot renew/mark-sold storefront listings (the 2-day stale-listing flow) from mobile.
  Fix: Add an <input type=file accept=image/*> in the lot form posting to the existing photo route (reuse resizePhotoMobile), and a minimal storefront toggle screen reading/saving /api/settings/storefront.
  Evidence: clienthub-api/src/routes/inventory.rs:28-35,46-97; clienthub-api/src/routes/storefront.rs:18-23; clienthub-api/www/app.js:3589-3642 (showInventoryForm — no photo upload)

- **Mobile cannot record or see deal receipts (off-bank money received) — no REST route and no app.js UI for deal_receipts**
  deal_receipts (bank-truth v2: money received on a deal that isn't in the bank feed) is fully wired on desktop (add/list/delete commands with oplog sync) and is a synced table on the server (ALLOWED_TABLES, PUSHABLE, snapshot, mirror table), but the server exposes ZERO REST routes for it — grep of clienthub-api/src finds it only in sync.rs — and www/app.js has no reference to receipts at all. Since
  Impact: A rep who collects a cash/wire payment in the field cannot log it against the deal from mobile; the deal shows unreconciled/short on money until a desktop user records the receipt.
  Fix: Add /api/deal-flows/:id/receipts GET/POST/DELETE in routes/deal_flows.rs that mutate deal_receipts AND call sync::record_upsert/record_delete (the established mobile-write pattern), plus a small receipts list in the mobile deal drawer.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:4604-4626 (add/list/delete deal receipts, synced), 10293 (recon counts deal_receipts); clienthub-api/src/sync.rs:442-452,968,1419,1567 (table synced/mirrored — the ONLY server references); clienthub-api/www/app.js (zero matches for 'receipt')

- **Release letter (signature PDF) missing on mobile**
  Desktop ReleaseLetterView.tsx generates release letters (nav child of Quote, App.tsx:414). No release/letter/signature surface exists in app.js or in server routes (grep across clienthub-api/src: release hits are unrelated). PDF generation is desktop-local (release_letter.rs in src-tauri), so mobile cannot produce one at all.
  Impact: Cannot issue a release letter when closing a pickup from a phone — has to wait for a desktop.
  Fix: Port release_letter.rs PDF generation into the server (same printpdf stack as invoice_pdf.rs) and expose GET /api/release-letter; add a button on the mobile deal/invoice panel.
  Evidence: BUSINESS APP/src/App.tsx:413-415 (nav entry); clienthub-api/www/app.js (no matches for release/letter); clienthub-api/src/routes/mod.rs (no release route)

- **Release letter (signed merchandise release/closeout PDF) is desktop-only — mobile cannot generate or sign it**
  release_letter.rs builds the one-page letterhead PDF with a drawn-signature block entirely inside the Tauri app (signature arrives as a canvas data-URL PNG, output written to a local path). There is no server counterpart (zero 'release' matches in clienthub-api/src routes) and zero references in www/app.js. Deal closeouts frequently happen at a warehouse/pickup — exactly when only the phone is ava
  Impact: A release/closeout letter cannot be produced or signed at the point of hand-off; the workflow requires going back to a desktop.
  Fix: Port release_letter.rs to the server next to invoice_pdf.rs (it already imports the same branding loaders), expose POST /api/release-letter returning the PDF bytes, and add a mobile screen with a signature canvas (same data-URL contract).
  Evidence: BUSINESS APP/src-tauri/src/release_letter.rs:1-50 (desktop-only input incl. signature_png data-URL and local output_path); clienthub-api/src (no release-letter module or route); clienthub-api/www/app.js (zero matches for 'release')

- **Storefront/Platform management missing on mobile (listings lifecycle, WhatsApp share, blast, paste-to-load)**
  Desktop PlatformView + WhatsAppSharePanel manage the public storefront: publish/renew/sold flow, share text to WhatsApp, blast-to-buyers-by-category, paste-to-load intake. Mobile inventory shows read-only 'WhatsApp sent'/'Manifest' badges and generic status buttons (app.js:2473-2522) but has no storefront view, no share/blast action, no /i/:token management (no 'storefront', 'wa.me', 'blast' listi
  Impact: The 2-day stale-listing renew/sold flow and WhatsApp sharing — inherently on-the-go actions — can only be done at the desk.
  Fix: Mobile is the natural home for this: add a Storefront section reusing the inventory detail panel with renew/sold/share buttons; WhatsApp share is just a wa.me URL with the same message template.
  Evidence: clienthub-api/www/app.js:2473-2522 (badges + status only); clienthub-api/src/routes/storefront.rs (server routes exist, mut=0 — read-only public page); BUSINESS APP/src/components/PlatformView.tsx, WhatsAppSharePanel.tsx

- **WhatsApp blast templates (message/lot format/footer/phone) are raw device-local settings — blast text differs per desktop, nothing on mobile**
  whatsapp_message_template, whatsapp_lot_format, whatsapp_footer, whatsapp_phone are read and written as plain local settings with raw conn.execute and no record_upsert (reads commands.rs:7365-7368, 7418-7423; writes :7429-7437), so the org's outbound WhatsApp blast wording is whatever the sending desktop happens to have configured. Mobile has no WhatsApp settings or blast surface (storefront blast
  Impact: A teammate composing a WhatsApp blast from a second desktop sends different template/footer text than Jack's PC would; mobile users cannot send or configure blasts at all.
  Fix: Sync the four whatsapp_* keys via record_upsert on save (non-secret), riding the finding-1 scoping fix for non-default orgs.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:7360-7368,7418-7437,7608

- **anthropic_api_key is device-local and excluded from the secrets bridge — AI lead extraction and paste-to-load work only on the device where the key was pasted**
  The key is stored as a deliberately-unsynced local settings row (ai.rs:344-351 'device-local, never synced'; save/delete at commands.rs:6377-6382), but unlike the other credentials it is NOT in the connection-sharing bridge's key lists (netsync.rs push_all_secrets_to_server keyring list :1315-1316 and SHARABLE_SETTINGS_KEYS :1279 both omit it). Consequence: AI-dependent flows — signup-rule auto_cr
  Impact: Leads arriving as unstructured emails are only AI-extracted (and thus reach the mobile Approvals queue with parsed fields) when the one key-holding PC does the scan; scans from other desktops produce weaker or no captures.
  Fix: Add 'anthropic_api_key' to SHARABLE_SETTINGS_KEYS in netsync.rs (it is stored in settings, not the keyring) so share_connections_with_team/materialize carry it once the org-secrets route is deployed.
  Evidence: BUSINESS APP/src-tauri/src/ai.rs:344-351; BUSINESS APP/src-tauri/src/commands.rs:6374-6382; BUSINESS APP/src-tauri/src/netsync.rs:1276-1316

- **signup_rules (email → auto-client capture rules) are per-device, never synced, no mobile surface — lead capture depends on one PC being on**
  signup_rules is a plain local table (signup_rules.rs:35-52) with no record_upsert anywhere and it is absent from both sync whitelists (desktop sync.rs:453; server sync.rs:934/PUSHABLE:1412). The org-shared inbox config now syncs to sibling admin desktops (email.rs:1051-1056), and each device scans with its own UID cursor (email.rs:781-787) — but a device without the rules rows scans the same inbox
  Impact: Leads that would auto-appear in the mobile Approvals queue simply don't arrive whenever the rule-holding PC is off; mobile users can't see or manage capture rules at all.
  Fix: Sync the rules: either add signup_rules to both ALLOWED_TABLES/PUSHABLE lists (it needs an org_id column) or serialize the rule set into one org-scoped settings key like email_inboxes already is; add a read-only rules list to mobile Settings later.
  Evidence: BUSINESS APP/src-tauri/src/signup_rules.rs:1-53; BUSINESS APP/src-tauri/src/email.rs:769-793,812-824,1125-1135; BUSINESS APP/src-tauri/src/sync.rs:453


### P2 — parity-partial

- **Approving a lead on mobile never writes it back to the Google Sheet — sheet write-back runs only inside desktop approve commands**
  sheet_writeback::upsert_approved_client (update-the-existing-row write-back, just fixed in commit 44982707/fb2f914c) is invoked from exactly two places, both desktop Tauri approve handlers (commands.rs:572 and :739). The server's approvals routes have zero sheet involvement, and desktop has no reconciler that notices a pending_approvals row resolved remotely (mobile resolves it via REST + sync) an
  Impact: Leads approved from a phone exist in Ecliptr but never appear/update in the shared Google Sheet the rest of the operation reads, until someone runs a manual full reconcile on desktop.
  Fix: On desktop, when netsync applies a pending_approvals upsert whose status transitioned to approved (kind=client_add), fire upsert_approved_client for the entity — the same hook pattern used for the v0.14.99 amber-banner fix; or run the existing bulk reconcile on a timer while write-back is enabled.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:572,739 (only call sites — both desktop approve paths); BUSINESS APP/src-tauri/src/sheet_writeback.rs:433-437 (upsert_approved_client), 549+ (bulk reconcile exists but is manual); clienthub-api/src/routes/approvals.rs (zero matches for sheet/writeback)

- **Dashboard loss-deals alert dead on mobile — response key mismatch**
  Mobile renders the red 'Loss deals this month' alert from s.loss_deals / s.loss_total (app.js:3069), but dashboard_stats returns those values only as loss_deals_this_month / loss_total_this_month (dashboard.rs:267-268). s.loss_deals is always undefined, so the alert can never render.
  Impact: Owners never see the loss-deal warning on mobile even when the org lost money this month; desktop shows it.
  Fix: In app.js:3069 read s.loss_deals_this_month and s.loss_total_this_month (or additionally emit the short keys server-side).
  Evidence: clienthub-api/www/app.js:3069; clienthub-api/src/routes/dashboard.rs:267-268 ("loss_deals_this_month"/"loss_total_this_month" keys)

- **Deal Flow v2 (bank reconciliation, refund-to-bank, deal notes/rename) absent on mobile**
  Mobile still renders the v1 4-dot flow. Desktop v0.15.84–91 rebuilt Deal Flow as a 5-section stepper with bank-linked transactions as profit truth, recon status on completed deals, refund drawer with supplier-refund bank attachment, and per-deal notes/rename. The server already exposes PUT /api/deal-flows/:id/notes and /:id/name (deal_flows.rs:27-28) and PUT /:id/completed-at (deal_flows.rs:57-60)
  Impact: A user completing or refunding a deal on mobile can't reconcile it against bank truth, can't see recon status, can't read/write deal notes made on desktop; completed-deal profit shown on mobile is the ledger figure, which desktop may later recalc fro
  Fix: Port the v2 sections incrementally: (1) render df notes + PUT notes, (2) show recon status fields already present on the deal_flows row, (3) add bank-txn picker to the refund modal mirroring desktop's attach-refund flow.
  Evidence: clienthub-api/www/app.js:4687-4790 (v1 active-flow card actions); clienthub-api/src/routes/deal_flows.rs:27-28,57-60,847-897; clienthub-api/www/app.js:5019-5046 (refund modal — no bank_txn attach)

- **Every non-default org gets default branding and broken email config on server renders: server reads '{org}::'-scoped settings keys that no desktop ever writes, and bare-key settings rows collide across orgs**
  Server loaders are org-scoped two ways at once: scoped_setting_key(org,k) → '{org}::k' for any org except org_default, AND 'AND org_id=?'. Desktop writes/syncs only PLAIN keys ('invoice_template', 'smtp_host', ...), and the sync apply keys settings rows on bare `key` (pk='key', exists-check and UPDATE have no org predicate), so (a) a non-default org's plain-key row can never satisfy the server's '
  Impact: Any tenant org other than BJM: mobile invoice/quote emails fail with a misleading 'set up on desktop' error until they find the mobile SMTP form, and their documents render unbranded; worst case two tenants' settings rows overwrite each other.
  Fix: Make the settings apply path org-aware (composite key or rewrite plain keys to '{org}::' on apply, matching the pushing session's org), update the two error strings to point at mobile Settings, and add the scoped-key migration for existing plain rows.
  Evidence: clienthub-api/src/employees.rs:901-907 (scoped_setting_key); clienthub-api/src/email.rs:57-80 (load_smtp_config_for scoped reads, hard error when absent); clienthub-api/src/invoice_pdf.rs:145-155,214-222 (scoped template/company reads)

- **Mobile Settings is a subset: payment methods read-only, no Shopify/Sheets/invoice-numbering/inbox config**
  renderSettings (app.js:6002-6216) covers plan, appearance, company info, send-SMTP, categories, payout link — and renders payment methods as a read-only list (6099-6105) with no add/edit/delete/reorder although the server routes exist (settings.rs:758-834). Missing entirely: Shopify integration config, Google Sheets connect/write-back toggle, invoice/quote numbering, invoice studio, and inbox/capt
  Impact: An admin cannot finish onboarding or adjust integrations from mobile; payment methods shown on invoices cannot be managed.
  Fix: Wire payment-method CRUD to the existing routes first (pure app.js work). Shopify/Sheets/numbering are server-backed settings and can reuse the same PUT /api/settings pattern already used for SMTP.
  Evidence: clienthub-api/www/app.js:6002-6216,6099-6105,6040-6042,2151; clienthub-api/src/routes/settings.rs:758-834 (payment-method CRUD routes exist unused by mobile)

- **Mobile loss-deals alert reads wrong JSON keys and can never render**
  Server dashboard stats returns loss_deals_this_month / loss_total_this_month; app.js renders the red loss card from s.loss_deals / s.loss_total, which do not exist in the payload — the condition (s.loss_deals||0)>0 is always false. Desktop shows the equivalent loss stats.
  Impact: Loss-making deals this month are never surfaced on mobile; desktop shows them.
  Fix: Change app.js line 3069 to read s.loss_deals_this_month / s.loss_total_this_month (or alias both keys server-side).
  Evidence: clienthub-api/src/routes/dashboard.rs:268-269 (keys: loss_deals_this_month/loss_total_this_month); clienthub-api/www/app.js:3069 (reads s.loss_deals / s.loss_total)

- **Mobile never uses /api/auth/employee/refresh — hard logout every 7 days, cookie dies before grace window**
  The server ships a full refresh design: 7-day JWT (employees.rs:36), 30-day refresh grace past exp (employees.rs:648), 90-day anchor cap, handle_refresh at /api/auth/employee/refresh (employees.rs:1801-1816). app.js contains zero calls to it (grep count 0). Worse, the session cookie is set with Max-Age = JWT_EXPIRY_SECS (employees.rs:1793,500-508), so at day 7 the browser deletes the cookie and th
  Impact: Every installed phone silently logs out weekly; a 401 mid-form throws through the swallowing catch blocks so in-progress edits (notes, checkup notes, flag toggles) are lost without any error. This is the same 7-day-JWT class as the desktop Repair-syn
  Fix: In checkAuth (and on visibilitychange), fire-and-forget POST /api/auth/employee/refresh before /me to slide the window; also set the cookie Max-Age to JWT_EXPIRY_SECS + REFRESH_GRACE_SECS server-side so an expired-but-refreshable token still reaches handle_refresh.
  Evidence: clienthub-api/src/employees.rs:36,500-508,648,1793,1801-1816; clienthub-api/www/app.js:141-181 (api wrapper: 401 → showLogin, no refresh attempt); clienthub-api/www/app.js:563-580 (checkAuth: /me only)

- **Mobile quote sends are plain-text while desktop attaches a branded quote PDF; the server's quote-PDF machinery is dead code and there is no quote PDF view on mobile**
  Desktop send_quote generates/attaches the branded quote PDF. Mobile's /api/quotes/:id/email builds a plain-text bullet list — no PDF attach, no PDF fallback. The server ALREADY contains everything needed (invoice_pdf::build_pdf_bytes accepts kind="quote"; load_quote_template exists) but nothing ever calls it with "quote" and quotes.rs has no /pdf route (invoices got both /email-with-PDF and /pdf; 
  Impact: A quote sent from mobile arrives as a bare text email (possibly with zeroed line prices) instead of the branded PDF the desktop sends, and the client is later mis-targeted as a first-contact prospect.
  Fix: Add generate_quote_pdf_bytes(org, id) to invoice_pdf.rs (mirror of the invoice one, kind="quote"), wire GET /api/quotes/:id/pdf and attach it in email_quote with the same catch_unwind/text fallback as invoices; set sent_at in the success branch; verify the line_items_json key names against a real de
  Evidence: BUSINESS APP/src-tauri/src/invoice.rs:1104-1143 (desktop send_quote attaches PDF, sets sent_at); clienthub-api/src/routes/quotes.rs:26-33 (router: no /pdf route), 291-351 (text-only email, status-only update, 'quantity'/'price' field reads); clienthub-api/src/invoice_pdf.rs:182-208 (load_quote_template — never called), 351-376 (build_pdf_bytes kind="quote" supported, only ever called with "invoice

- **Pipeline Deals screen is view+convert only — no create, no stage change, no edit**
  Server exposes POST /api/deals, PUT /api/deals/:id, PUT /api/deals/:id/stage (deals.rs:23-28) and desktop uses them; mobile renderDeals (app.js:2359-2431) offers only Convert to invoice. No + button, no stage move, no edit of costs/notes.
  Impact: A broker fielding a lead on the phone cannot log it as a pipeline deal or advance/lose a deal; pipeline analytics and briefs then under-count mobile-originated activity.
  Fix: Add a New-deal modal (client picker + title + asking price + stage) posting /api/deals, and a stage pill row PUTting /api/deals/:id/stage in the detail panel.
  Evidence: clienthub-api/www/app.js:2359-2431; clienthub-api/src/routes/deals.rs:22-31

- **Refund handling on mobile is per-deal only — no refund workspace, no supplier-refund attach**
  Mobile can list/record refunds inside one deal's drawer (app.js:5002-5042: amount + 'rep already paid' flag only). Desktop has RefundWorkspace.tsx (org-wide refund summary/owed-back) plus the v0.15.91 flow attaching a supplier refund to a deal; the mobile form has no source/supplier field and there is no aggregate refunds view (no other 'refund' UI in app.js beyond 4959-5042).
  Impact: Cannot see total refunds owed/received across deals or record a supplier-sourced refund correctly from mobile.
  Fix: Add a refunds summary screen under More (server can aggregate the synced refunds table) and extend showAddRefund with the source/supplier fields the desktop panel writes.
  Evidence: clienthub-api/www/app.js:4959-5042 (entire mobile refund surface); BUSINESS APP/src/components/RefundWorkspace.tsx, RefundPanel.tsx (desktop workspace exists)

- **Rep home 'Active deals' KPI counts completed deals — wrong stage literal**
  The non-money rep dashboard computes activeDeals with d.stage !== 'completed' && d.stage !== 'lost' (app.js:2941), but deal_flows stages are invoiced/payment_received/supplier_paid/complete (FLOW_STAGES, app.js:69) — 'completed' and 'lost' never match, so every deal flow (including complete ones) counts as active.
  Impact: Reps without deal_flow:view_numbers see an inflated Active deals number equal to all deals ever.
  Fix: Filter d.stage !== 'complete' (and drop the meaningless 'lost' check, or also exclude flows whose invoice is voided as renderDfLists does via is_complete).
  Evidence: clienthub-api/www/app.js:2941; clienthub-api/www/app.js:69 (FLOW_STAGES values)

- **Server stats payload lacks the refund story and won/lost fields the desktop analytics shows**
  Desktop dashboard_stats returns refunded_total, refund_owed_remaining (both with the EXISTS-style orphan-safe bank_allocation arithmetic), deals_won_all, deals_lost_all. The server dashboard_stats JSON has none of these keys, so mobile Analytics cannot show total refunded / owed-back / all-time won-lost, and any future mobile render reading them silently gets undefined.
  Impact: The refund summary (total refunded, still owed back) and all-time won/lost visible on desktop analytics have no mobile equivalent.
  Fix: Add the four aggregates to server dashboard_stats (copying the desktop SQL, including the bank_txn-existence-safe refund sums) and render them in app.js renderAnalytics.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:8497-8512,8545-8551 (desktop fields incl. refund aggregates); clienthub-api/src/routes/dashboard.rs:239-272 (server payload without them)

- **Unsubscribe suppression and the CAN-SPAM footer exist only on the server send path — desktop immediate newsletters ignore both**
  The server scheduler checks unsubscribe::is_suppressed(org, addr) per recipient and appends a one-click unsubscribe footer to every marketing send. Desktop's immediate send_newsletter applies only the blacklist/exclusive (No-bulk) filter — it never consults the server suppression list and appends no unsubscribe footer (the desktop's only unsubscribe handling is a regex that logs an interaction whe
  Impact: A client who unsubscribes from a mobile-sent campaign keeps getting desktop-sent newsletters — the org's unsubscribe promise is broken depending on which surface sent the mail.
  Fix: Have desktop send_newsletter fetch the org's suppression list from the server (new GET /api/unsubscribe/suppressed or a per-address check) before sending, and append the same unsubscribe_url footer. Simplest robust fix: route desktop immediate sends through enqueue_immediate_send too.
  Evidence: clienthub-api/src/scheduler.rs:491-503 (is_suppressed skip), 520-526 (unsubscribe footer); BUSINESS APP/src-tauri/src/commands.rs:12045-12105 (desktop loop: blacklist/exclusive only, no suppression, no footer); BUSINESS APP/src-tauri/src/email.rs:1196-1208 (reply-detection logs an interaction only, does not block)


### P2 — sync-bug

- **Checkup session delete leaves untombstoned checkup_items on every desktop**
  delete_session bulk-DELETEs checkup_items by session_id and only records the checkup_sessions delete. checkup_items is a synced table (server sync.rs:957); desktops apply the session tombstone but keep every item row forever. The orphans are invisible in the UI today (items render under their session) but persist in client-merge child handling (checkup_items is in CLIENT_CHILD_TABLES, desktop comm
  Impact: Deleting a checkup session on mobile leaves its item rows on all desktops; over time desktops accumulate ghost checkup data that merge/repair operations keep propagating.
  Fix: SELECT the item ids before the bulk delete and record_delete("checkup_items", id, &org) for each.
  Evidence: clienthub-api/src/routes/checkups.rs:267-272 (DELETE FROM checkup_items ... then only record_delete("checkup_sessions")); clienthub-api/src/sync.rs:957 (checkup_items in ALLOWED_TABLES); BUSINESS APP/src-tauri/src/commands.rs:9497 (desktop merge reassigns checkup_items rows, keeping orphans alive)

- **Deleting a checkup session on mobile leaves orphan checkup_items on every desktop (no per-item tombstones)**
  delete_session removes items and the session locally but emits only record_delete for checkup_sessions — the DELETE FROM checkup_items (checkups.rs:269) has no record_delete per item, and checkup_items is a synced table (sync.rs:957). Desktops keep the item rows forever; they're invisible today (UI lists by session) but any future count/aggregate over checkup_items diverges, and the rows resurrect
  Impact: No visible symptom yet — latent orphan rows on desktops after mobile-side checkup deletion.
  Fix: In delete_session, select the item ids first and record_delete('checkup_items', id) for each before deleting (mirror the promote-children pattern used in delete_category, settings.rs:543-575).
  Evidence: clienthub-api/src/routes/checkups.rs:258-274; clienthub-api/src/sync.rs:957

- **Mobile uncomplete zeroes a deal's recorded revenue/profit and syncs the zeros, breaking the desktop FAIL-PROOF fallback**
  Server uncomplete_deal_flow sets gross_revenue=0, net_profit=0, total_cost=0 (row + sync event). Desktop uncomplete_deal_flow deliberately preserves the recorded figures (only stage/completed_at change) because resync_completed_deal's FAIL-PROOF rule uses the last recorded figure as the fallback for money legs without a live bank link. An uncomplete from mobile wipes those recorded figures on ever
  Impact: Un-completing a deal from mobile can permanently erase its recorded money if bank links are later unavailable, something desktop was specifically hardened against.
  Fix: Make server uncomplete match desktop: clear stage/completed_at (and invoice profit fields) but leave gross_revenue/net_profit/total_cost untouched.
  Evidence: clienthub-api/src/routes/deal_flows.rs:228-243 (zeroes gross/net/total_cost); BUSINESS APP/src-tauri/src/commands.rs:4384-4417 (desktop preserves figures); BUSINESS APP/src-tauri/src/commands.rs:4290-4307 (FAIL-PROOF fallback = last recorded figure)

- **Per-recipient newsletter send history never syncs in either direction — mobile and desktop each see only half the outbound-email history, and 'first contact' audiences can re-email already-contacted clients**
  newsletter_sends (per-recipient sent/failed/skipped rows) is in the server's PUSHABLE list but NOT in ALLOWED_TABLES, not in the desktop SNAPSHOT_TABLES, and neither side ever emits sync events for it: desktop send_newsletter does raw local INSERTs, and the server scheduler does raw INSERTs (emit_counts syncs only the scheduled_sends counters). Consequences: (a) mobile's scheduled-send detail (/ap
  Impact: Mobile shows an incomplete outbound-email history (desktop-sent newsletters missing entirely), and a mobile-triggered 'first contact' campaign can spam clients the business already emailed from desktop.
  Fix: Add newsletter_sends to server ALLOWED_TABLES + desktop SNAPSHOT_TABLES, and emit record_upsert alongside both raw INSERT sites (desktop send loop and server scheduler). Alternatively drop it from PUSHABLE and accept server-authoritative history, but then desktop immediate sends must also POST their
  Evidence: clienthub-api/src/sync.rs:930-969 (ALLOWED_TABLES — no newsletter_sends), 1412-1420 (PUSHABLE — includes newsletter_sends); BUSINESS APP/src-tauri/src/netsync.rs:38-49 (SNAPSHOT_TABLES — no newsletter_sends); BUSINESS APP/src-tauri/src/commands.rs:12074-12094 (desktop raw INSERTs, no record_upsert)

- **Plaintext smtp_password enters the sync oplog via the legacy Pi-push path — desktop record_upsert has no is_secret_key guard**
  save_smtp_settings_for_pi and push_desktop_smtp_to_pi call sync::record_upsert("settings", "smtp_password", …) with the plaintext password (commands.rs:12442-12457, 12489-12498). The desktop record_upsert (desktop sync.rs:214-240) has no secret filter — the server's is_secret_key discipline (server sync.rs:654-660) is only enforced in the server's own write_setting (routes/settings.rs:167-174) and
  Impact: No direct mobile-visible symptom, but the org's real SMTP password ends up in plaintext in every synced desktop DB and the server pull log — a leak path for the credential mobile email depends on.
  Fix: Add an is_secret_key check to desktop record_upsert for the settings table (skip oplog, keep local write), or delete the two Pi-era commands outright since push_email_login_to_server + the /api/settings/smtp reveal bridge replace them.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:12440-12517; BUSINESS APP/src-tauri/src/sync.rs:214-240; clienthub-api/src/sync.rs:654-660,991-997,1669-1671

- **create_payment_request inserts a payments row without a sync event**
  payments.rs create_payment_request INSERTs into payments (a synced table, sync.rs:941) via bare conn.execute with no sync::record_upsert. Rows minted here (portal pay-request flow) never propagate to desktops. Impact currently bounded because the Stripe webhook is a 501 stub so the flow is dormant, but it becomes a P0 the day payments go live.
  Impact: Portal-initiated payment records will exist server-side/mobile-side but never appear in desktop books.
  Fix: Build the cols map and call sync::record_upsert("payments", &id, cols) before the INSERT, matching the pattern in notes.rs/quotes.rs.
  Evidence: clienthub-api/src/routes/payments.rs:45-61; clienthub-api/src/routes/payments.rs:63-65 (webhook stub); clienthub-api/src/sync.rs:941 (payments in ALLOWED_TABLES)

- **deal_stage_history is written on both sides but synced on neither — pipeline analytics differ per platform**
  Server set_deal_stage INSERTs deal_stage_history (deals.rs:232-237) and the server pipeline-analytics endpoint computes stage-velocity from it (deals.rs:480). The desktop writes its own local copy (commands.rs:3302). The table is in neither ALLOWED_TABLES list, so mobile analytics only reflect stage changes made via mobile/web, and desktop-side history only reflects desktop changes. Stage-duration
  Impact: Mobile pipeline analytics (avg time-in-stage, conversion velocity) undercount every stage transition performed on desktop, and vice versa — the two surfaces report different numbers for the same pipeline.
  Fix: Add deal_stage_history to both ALLOWED_TABLES lists and record_upsert on both insert sites (append-only rows, id-keyed, trivial to sync).
  Evidence: clienthub-api/src/routes/deals.rs:232-237 (server insert), 480 (server analytics reads h1 JOIN h2); BUSINESS APP/src-tauri/src/commands.rs:3302 (desktop insert); clienthub-api/src/sync.rs:930-969 (absent from ALLOWED_TABLES)


### P3 — infra-blocker

- **Stale deploy markers: BUILD const stuck at m20 while index.html is at v31 / SW at v84**
  app.js BUILD = 'm20 · 2026-07-05' (app.js:76) exists precisely to verify a new mobile build loaded, but it has not been bumped across the deploys that took index.html to app.js?v=31 (index.html:152) and sw.js CACHE to ecliptr-v84 (sw.js:4). The cache-bust discipline exists in the other two files; the human-readable check is dead.
  Impact: Settings shows 'Mobile build m20 · 2026-07-05' regardless of what shipped — cache problems can no longer be diagnosed from the phone.
  Fix: Bump BUILD in the same edit that bumps index.html ?v= and sw CACHE (a 3-line deploy checklist or a small build script that stamps all three).
  Evidence: clienthub-api/www/app.js:76; clienthub-api/www/index.html:152; clienthub-api/www/sw.js:4


### P3 — money-divergence

- **Followups endpoint returns unguarded lifetime invoice totals, inconsistent with every other client total**
  dashboard.rs followups selects COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id),0) with no status/voided/archived guard, while CLIENT_BASE (the normal client list mobile uses) sums only paid, non-void, non-archived invoices. The same client shows different 'total' money depending on which mobile screen fetched it.
  Impact: Follow-up cards can display a client spend figure that includes drafts, voided and deleted invoices.
  Fix: Reuse CLIENT_BASE (or copy its guarded SUM expression) in the followups query.
  Evidence: clienthub-api/src/routes/dashboard.rs:306-308 (unguarded SUM); clienthub-api/src/routes/clients.rs:42 (guarded CLIENT_BASE sum)

- **Invoice/quote number counters bump server-side without sync (mitigated by max-scan, residual duplicate-number race)**
  next_document_number on the server (invoices.rs:301-305, used for invoices at 355, deals-conversion at deals.rs:337, quotes at quotes.rs:176/253) bumps the settings counter (invoice_next_number / quote_next_number) with a raw INSERT..ON CONFLICT and no record_upsert, so the counter never reaches desktops. Both sides deliberately assign max(counter, highest-synced-number+1) (desktop commands.rs:211
  Impact: Rare: an invoice created on mobile while a desktop was offline can collide numbers and fail to materialize on that desktop; day-to-day the counter shown in Settings drifts between surfaces.
  Fix: Emit record_upsert("settings", scoped_key, {value, org_id}) when the server bumps the counter (cheap, keeps the Settings preview in step); for the collision, make the number non-UNIQUE or dedupe-suffix on apply.
  Evidence: clienthub-api/src/routes/invoices.rs:280-309 (server counter bump, no record_upsert on the settings write); clienthub-api/src/routes/quotes.rs:176, 253 (same helper for quotes); BUSINESS APP/src-tauri/src/commands.rs:2115-2168 (desktop max-scan design + comment acknowledging counter drift)

- **Newsletter {tier} variable computes tier from unguarded invoice sums, disagreeing with the Tiers screen**
  template.rs compute_tier sums paid invoices with no voided/archived/org guard, while /api/clients/tiers (mobile Tiers screen) and the desktop guard both flags. A client with voided/archived paid invoices can be emailed a higher tier label than any UI shows. (The unscoped client_id-only query also crosses org boundaries only if client ids collide — ids are UUIDs, so just the flag gap is real.)
  Impact: Tier shown in sent newsletters can disagree with the tier the app shows for the same client.
  Fix: Add COALESCE(archived,0)=0 AND COALESCE(voided,0)=0 to compute_tier's invoice aggregate.
  Evidence: clienthub-api/src/template.rs:31-38 (unguarded); clienthub-api/src/routes/clients.rs:911-917 (guarded tier aggregation)

- **Rep pay_type edits via mobile Team screen and pipeline_analytics archived-deals leak (latent server queries)**
  pipeline_analytics (deals.rs:438-536) filters only org (oa, line 440) — no COALESCE(archived,0)=0 on any funnel/win-rate/avg query (454, 464, 505-529), while desktop deals queries filter archived (commands.rs:1235-1236, 3172). Currently LATENT for mobile: renderAnalytics deliberately reads /api/dashboard/stats instead because the deals pipeline table is empty for BJM (app.js:1729-1731). Flag so th
  Impact: None today; wrong funnel/win-rate numbers the day mobile (or staff app) starts using /api/deals/analytics.
  Fix: Add ' AND COALESCE(archived,0)=0' to the oa fragment in pipeline_analytics.
  Evidence: clienthub-api/src/routes/deals.rs:438-536; BUSINESS APP/src-tauri/src/commands.rs:1235-1236,3172; clienthub-api/www/app.js:1729-1731


### P3 — parity-missing

- **Globe view missing on mobile**
  Desktop GlobeView (nav child of Analytics, App.tsx:427) has no mobile counterpart — no globe/map rendering in app.js (all 'map' hits are Array.map).
  Impact: No client-geography visual on mobile.
  Fix: Low priority; a 2D map (static tiles + dots from client lat/lng metadata) fits mobile better than the WebGL globe.
  Evidence: BUSINESS APP/src/App.tsx:425-427; clienthub-api/www/app.js (grep globe/map: only Array.map)

- **Sheet copy tool desktop-only**
  SheetCopyView (App.tsx:411) rebuilds a view-only supplier sheet into the user's Drive; documented as a desktop tool, but the standing mobile-parity rule applies. No sheet-copy surface in app.js.
  Impact: Cannot re-price a locked supplier sheet from mobile — where the WhatsApp link usually arrives.
  Fix: The heavy lifting is Google API calls; move them server-side behind a route (org's granted spreadsheets scope) and the mobile UI is just a URL paste box.
  Evidence: BUSINESS APP/src/App.tsx:410-412; clienthub-api/www/app.js (no sheet-copy references)


### P3 — parity-partial

- **Approval editor Country field is silently discarded by the server**
  showApprovalDetail sends country in the PUT /api/clients/:id body (app.js:2852), but ClientInput has no country field (models.rs:346-362) and build_metadata never reads it — serde drops it, the edit vanishes with a success toast.
  Impact: Reviewing a web-form lead and fixing its country on mobile does nothing.
  Fix: Add country: Option<String> to ClientInput and persist it into metadata in build_metadata (mirroring street_address), or drop the field from the mobile form.
  Evidence: clienthub-api/www/app.js:2807,2852; clienthub-api/src/models.rs:346-362; clienthub-api/src/routes/clients.rs:116-140 (build_metadata — no country)

- **Automation log only partially on mobile**
  Desktop AutomationLogView shows the full automation event log. Mobile's Web forms view shows only /api/automations/summary (app.js:2082) — counts, not the per-event log.
  Impact: Cannot inspect which intake/automation events fired or failed from mobile.
  Fix: Add a paged list under the existing summary card, reading whatever route AutomationLogView's data comes from (or add one).
  Evidence: clienthub-api/www/app.js:2047-2151; BUSINESS APP/src/components/AutomationLogView.tsx (exists)

- **Bank-truth refresh is bound to the single desktop that holds the Plaid link — profit data everywhere goes stale when that PC is off**
  Plaid client_id/secret and per-item access tokens live in the linking desktop's local settings/plaid_items ('never sync, matching the anthropic_api_key pattern' — plaid.rs:46), shareable only through the org-secrets bridge (netsync.rs:1303-1305 plaid_item_{id} push, :1417-1435 materialize) which is blocked on the finding-5 deploy. bank_txn/bank_allocation rows themselves sync fine (both in ALLOWED
  Impact: Mobile deal-flow bank-truth status and recorded profit lag reality whenever the importing PC is offline; a mobile user cannot reconcile a completed deal against fresh bank transactions.
  Fix: After deploying the org-secrets bridge (finding 5), share the Plaid credentials/items so a second desktop can import; longer term move the periodic Plaid pull server-side (the deferred 'server-Plaid' item) so refresh is device-independent.
  Evidence: BUSINESS APP/src-tauri/src/plaid.rs:46; BUSINESS APP/src-tauri/src/netsync.rs:1300-1316,1417-1435; clienthub-api/src/sync.rs:1412-1420

- **Brief period length is stored in two different places (desktop setting vs mobile localStorage) so the two briefs cover different windows**
  Desktop reads settings.brief_frequency_days (synced settings table); mobile reads localStorage ec_brief_days (default 7) and passes it as ?days=. Setting Biweekly/Monthly on one surface does not affect the other, so the 'same' brief can aggregate different periods and show different totals even after the guard fixes.
  Impact: Mobile brief may show a 7-day window while desktop shows 14/30, so the numbers legitimately differ and look like a sync bug.
  Fix: Have mobile read/write the org setting (settings API) with localStorage only as a cache, or have the server default days from the stored brief_frequency_days when the param is absent.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:9110-9117 (settings brief_frequency_days); clienthub-api/www/app.js:5655 (localStorage ec_brief_days)

- **Client search on mobile does not match phone numbers**
  Desktop v0.15.91 added format-agnostic phone search. Mobile loadClientList filters only name/company/email (app.js:3322) even though phone is displayed (fmtPhone at 55-56, 3327).
  Impact: Searching a caller's number (the most phone-native lookup) finds nothing on mobile.
  Fix: Add a digits-only comparison to the filter at app.js:3322: strip non-digits from both query and c.phone and use includes().
  Evidence: clienthub-api/www/app.js:3318-3322,55-56

- **Dead loadDealFlows() targets a #df-list container that no longer exists**
  loadDealFlows(stage) (app.js:4792-4876) renders into $('#df-list'), but renderDealFlows builds #df-active-list/#df-completed-drawer, so the function no-ops; it is only self-referenced. It contains a quick-complete path (POST complete with empty body → payout_included=false) whose warning comment no longer matches the live UI (showCompleteDealModal now collects payout_included).
  Impact: None at runtime; misleads maintenance (a future edit could resurrect the payout-skipping quick-complete).
  Fix: Delete loadDealFlows and its handlers.
  Evidence: clienthub-api/www/app.js:4792-4876; clienthub-api/www/app.js:4531-4548 (renderDealFlows markup without #df-list)

- **Desktop and mobile send the same document from different sender identities — tenant SMTP address vs 'Org <no-reply@ecliptr.app>'**
  Desktop invoices/quotes/newsletters go out through the tenant's own SMTP account (their real address). The same document sent from mobile leaves via Resend as 'OrgName <no-reply@ecliptr.app>' with Reply-To set to the tenant address (only ecliptr.app is Resend-verified; a tenant From would 403). Deliberate and well-commented, but user-visible: the same client gets invoices from two different addres
  Impact: Clients see mobile-sent mail from no-reply@ecliptr.app instead of the business's own address; replies still route correctly but the thread and sender reputation differ from desktop-sent mail.
  Fix: Offer per-tenant domain verification in Resend (store a per-org verified From in settings and prefer it in resend_target), or at minimum surface the sender identity in the mobile send confirmation so users aren't surprised.
  Evidence: clienthub-api/src/email.rs:204-234 (identity decision comment + resend_target reply-to logic); BUSINESS APP/src-tauri/src/invoice.rs:1035 (desktop sends via crate::email::send — tenant's own account)

- **Inventory on mobile lacks variants, per-unit pricing and manifest tooling from v0.15.83**
  Mobile inventory has list/detail/status/edit and can view an attached manifest link (app.js:2434-2560, 3610), but no Shopify option-matrix variant editing, no price-per-unit on lot-total listings, and no per-item manifest deep-link management — the v0.15.83 desktop additions.
  Impact: Editing variant matrices or per-unit pricing requires the desktop.
  Fix: Extend the mobile inventory edit form with the variants/per-unit fields; the inventory route already does a dynamic column UPDATE (inventory.rs:368) so server work is minimal.
  Evidence: clienthub-api/www/app.js:2434-2560,3610 (mobile inventory surface); clienthub-api/www/app.js:2475,2517 (manifest view-only)

- **Invoice studio (branding config) missing on mobile; mobile PDFs render branding but never the logo — memory claim reconciled**
  Reconciliation: 'invoice PDFs are desktop-only' is STALE — the server has full invoice_pdf.rs mirroring desktop layout AND per-org branding (invoice_pdf.rs:59-181 reads the synced invoice_template settings; quote branding too at 178-181), and mobile uses it (View PDF app.js:4277-4280, email attach invoices.rs:122-143). Two real gaps remain: (1) company_info.logo_path stores a desktop filesystem pa
  Impact: Invoices emailed/viewed from mobile carry the accent/fields/footer branding but no company logo — visibly different from desktop-sent PDFs.
  Fix: Upload the logo bytes to the server once (settings blob or file store) when desktop saves Invoice studio, and have invoice_pdf.rs prefer the server copy; branding editor on mobile is optional after that.
  Evidence: clienthub-api/src/invoice_pdf.rs:17-21,59-181; clienthub-api/www/app.js:4277-4295; clienthub-api/src/routes/invoices.rs:115-143

- **Mobile client search ignores phone numbers (desktop v0.15.91 parity)**
  loadClientList filters only name/company/email (app.js:3322); desktop just shipped format-agnostic phone search. fmtPhone exists in app.js but is not used for matching.
  Impact: Searching a caller's number on the phone — the primary mobile use case — finds nothing.
  Fix: Normalize query and c.phone to digits (strip \D, drop leading 1) and add an includes() match alongside the existing three fields.
  Evidence: clienthub-api/www/app.js:3317-3325; clienthub-api/www/app.js:56-61 (fmtPhone helper)

- **Operational toggles that gate org-wide data flows are device-local: sheet_sync_enabled, writeback_enabled, brief_frequency_days — no central kill-switch**
  sheet_sync_enabled (commands.rs:13399-13404), sheet writeback_enabled (db.rs:1226-1234), and brief_frequency_days (commands.rs:6011-6019, plain read_setting/write_setting local) are all per-device plain settings with no sync. The v0.15.90 importer freeze therefore only holds on devices that individually stay OFF — an org admin cannot centrally disable the importer or write-back on a teammate's mac
  Impact: A teammate's desktop can re-enable the metadata-wiping sheet importer without the org (or mobile users, who see the corrupted client data) having any visibility or control.
  Fix: Fold these toggles into the org-scoped synced settings once finding 1's scoping fix lands; treat sheet_sync_enabled as org-level (server-checked) rather than per-device.
  Evidence: BUSINESS APP/src-tauri/src/commands.rs:13399-13419,6011-6019; BUSINESS APP/src-tauri/src/db.rs:1225-1234

- **Quote detail badge checks 'rejected' but the status value is 'declined'**
  The detail-hero badge class map uses _qst==='rejected' (app.js:2281) while setStatus sends and the server validates 'declined' (quotes.rs:115). A declined quote shows the gray draft badge in the detail hero instead of the red one (the list view at 2258 maps 'declined' correctly).
  Impact: Declined quotes look like drafts when opened.
  Fix: Change the ternary to _qst==='declined'.
  Evidence: clienthub-api/www/app.js:2281,2308-2332; clienthub-api/src/routes/quotes.rs:115

- **SW offline fallback can serve the HTML shell for failed JS/CSS/image requests**
  sw.js fetch handler's catch falls back to caches.match(req) || caches.match('/') for every non-API GET (sw.js:40). Offline with a cached new index.html referencing a never-fetched app.js?v=NN, the fallback returns the cached '/' HTML document as the script response — a syntax error that bricks the app until back online. Same for images (broken content-type).
  Impact: Rare offline-after-update state renders a blank app instead of the previous working version.
  Fix: Only fall back to caches.match('/') when req.mode === 'navigate'; for scripts/styles, try an ignoreSearch caches.match so the previous versioned copy is reused.
  Evidence: clienthub-api/www/sw.js:27-42; clienthub-api/www/sw.js:5 (SHELL precaches unversioned '/app.js' only)

- **Silent error swallowing on notes, checkup notes, and feedback status writes**
  Sticky-note body saves (app.js:916), color changes (920), deletes (922 — optimistic local removal before/regardless of server result), checkup note blur saves (5385), and feedback status posts (1530) all end in .catch(()=>{}). Offline or after the 7-day 401 these writes vanish with the UI showing success.
  Impact: Notes typed on the phone can be lost without any indication; the note even disappears locally on a failed delete so the user believes it worked.
  Fix: Route these through a helper that toasts on rejection and (for delete) restores the local row; queue-and-retry is optional polish.
  Evidence: clienthub-api/www/app.js:913-922,1529-1532,5385


### P3 — sync-bug

- **Dead Stripe payment stub inserts into the synced payments table without emitting sync**
  payments.rs create_payment_request INSERTs into payments (a synced table, sync.rs:941) with no record_upsert (payments.rs:55-58). Currently unreachable — neither app.js nor desktop api.ts calls /api/invoices/:id/payment — so it's a latent divergence trap for whenever Stripe work resumes (which the commercial plan says is the business).
  Impact: None today; payment rows created via this route would exist on server/mobile but never on desktops.
  Fix: Add sync::record_upsert('payments', ...) beside the INSERT, or delete the stub until Stripe lands.
  Evidence: clienthub-api/src/routes/payments.rs:45-61; clienthub-api/src/sync.rs:941; clienthub-api/www/app.js (no /payment calls); BUSINESS APP/src/lib/api.ts (no matches)

- **Referral code minted on staff_accounts without sync emission**
  routes/referrals.rs lazily writes staff_accounts.referral_code with a raw UPDATE and no emit_staff/record_upsert. staff_accounts is synced; the desktop schema doesn't carry referral_code and the feature is mobile/web-only, so today this only means the column lives server-side. Risk is forward-looking: emit_staff's column list (employees.rs:358) also omits referral_code, so any later desktop surfac
  Impact: None visible today (referrals are mobile-only); becomes a divergence the moment desktop shows referral info.
  Fix: If referral data should ever sync: add referral_code to emit_staff's SELECT/cols and call emit_staff(&user_id) after minting; otherwise leave as documented server-authoritative.
  Evidence: clienthub-api/src/routes/referrals.rs:40-46 (UPDATE staff_accounts SET referral_code, no sync call in file); clienthub-api/src/employees.rs:354-372 (emit_staff column list lacks referral_code)

- **Team-chat read state never syncs (messages mark-read is server-local)**
  messages is a synced table (sync.rs:945) and sends do emit (messages.rs:83 + its record_upsert), but both mark-read UPDATEs (messages.rs:32, 104) emit nothing. Desktop currently has no messages UI (api.ts: no matches), so impact is confined to the synced copy diverging; if desktop ever grows chat, unread badges will be permanently wrong.
  Impact: None visible today (mobile reads the server directly); latent for desktop chat parity.
  Fix: record_upsert the read_at column for each message id marked read, or drop messages from ALLOWED_TABLES if chat is intentionally server-only.
  Evidence: clienthub-api/src/routes/messages.rs:32,83,104; clienthub-api/src/sync.rs:945

- **Workspace purge deletes synced-table rows for the org with zero tombstones (including its own pull log)**
  purge_org_data (employees.rs:2326-2348) hard-DELETEs 26 org tables plus invites/roles/staff_accounts/orgs and — notably — the org's sync_events rows, with no record_delete for anything. Any still-installed desktop of that workspace keeps its full local dataset and, because even the pull log is gone, can never converge; if the org id were ever re-registered, stale desktops could push the old data b
  Impact: None for the deleted workspace's mobile (auth is gone); the hazard is a surviving desktop re-pushing purged data if credentials/org ever come back.
  Fix: On purge, keep (or write) a single org-level tombstone marker the push endpoint checks, rejecting pushes for purged org ids instead of re-accepting resurrected rows.
  Evidence: clienthub-api/src/employees.rs:2311-2318 (ORG_TABLES incl. sync_events), 2326-2348 (purge with no sync recording)

- **deal_stage_history is not a synced table — stage-conversion analytics can never agree across devices**
  Server update_deal_stage inserts deal_stage_history rows locally only (deals.rs:232-237); the table is absent from ALLOWED_TABLES (sync.rs:930-969) and no record_upsert is emitted (nor could one apply). Desktop maintains its own copy from desktop-authored changes. Each side's stage-conversion metrics (deals.rs:476-482 h1/h2 joins) see only its own half of history.
  Impact: Stage-conversion percentages differ between mobile analytics and desktop analytics once both devices move deals.
  Fix: Add deal_stage_history to ALLOWED_TABLES on both sides and emit record_upsert for each insert (rows are append-only, so this is conflict-free).
  Evidence: clienthub-api/src/routes/deals.rs:232-237,476-482; clienthub-api/src/sync.rs:930-969

- **intake_sources.sample_json updated server-side without sync emission**
  The intake endpoint stores the latest raw submission as sample_json via a bare UPDATE (intake.rs:266) with no record_upsert, though intake_sources is synced (sync.rs:951). Desktop's field-mapping preview for a form shows a stale (or empty) sample.
  Impact: Indirect — desktop form-mapping UI works from outdated sample data after mobile-era submissions.
  Fix: Emit record_upsert('intake_sources', id, {sample_json, updated_at}) next to the UPDATE.
  Evidence: clienthub-api/src/routes/intake.rs:266; clienthub-api/src/sync.rs:951

- **messages read-receipt update bypasses sync**
  messages.rs read handler UPDATEs messages.read_at without sync::record_upsert (messages.rs:96-104) while send does emit (messages.rs:92); messages is in ALLOWED_TABLES (sync.rs:944). Read state set from the portal/web never reaches desktop copies.
  Impact: Desktop keeps showing portal messages as unread after they were read elsewhere.
  Fix: Emit sync::record_upsert("messages", &id, {read_at, org_id}) in the read handler.
  Evidence: clienthub-api/src/routes/messages.rs:92-104; clienthub-api/src/sync.rs:944

- **orgs table mutations (plan changes, referral attribution, creation) are never replicated**
  orgs is in ALLOWED_TABLES on both sides (server sync.rs:952; desktop sync.rs:453) and sync.rs even has special org resolution for it (sync.rs:574-575), but the server has zero record_upsert("orgs") calls: org creation (employees.rs:1232), referred_by attribution (1257-1259), superadmin plan change (2544-2547), and the boot-time plan promotions (312-319) all mutate silently. Low impact today becaus
  Impact: Plan upgrades/renames made via the admin console never reach desktops; currently mostly latent because desktop hardly reads orgs.
  Fix: Add an emit_org(id) helper (name/plan/created_at/referred_by_*) and call it from register, set_org_plan, and the referral-attribution write — or consciously remove orgs from ALLOWED_TABLES and document that orgs is server-authoritative.
  Evidence: clienthub-api/src/employees.rs:1232-1233, 1257-1259, 2544-2547 (unreplicated orgs writes); grep of clienthub-api/src for record_upsert("orgs") — zero hits (verified via full record_upsert call-site listing); clienthub-api/src/sync.rs:574-575, 952 (orgs special-cased and allowed)
