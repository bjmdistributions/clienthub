import { invoke } from "@tauri-apps/api/core";

// ===== Types =====
export interface Note {
  id: string;
  body: string;
  color: string;
  pinned: boolean;
  author: string;
  created_at: string;
  updated_at: string;
  x: number;
  y: number;
  w: number;
  h: number;
  editing_by: string;
  editing_at: string;
  urgency: string;      // 'normal' | 'high' | 'urgent'
  reviewed_at: string;  // last "still needed" confirmation; staleness measured from here
}
export interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  billing_status: string;
  lead_status: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, any> | null;
  invoice_count: number;
  last_contact_at?: string | null;
  total_revenue: number;
  category: string | null;
  tags: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  next_follow_up_date: string | null;
  needs_review: boolean;
  is_blacklisted: boolean;
  // Real columns (promoted from metadata). Toggle commands return the new value.
  high_value?: boolean;
  exclusive?: boolean;
  approval_status: string;
  /** True until this client has been sent ANY email; self-clears server-side on first send. */
  first_contact?: boolean;
  /** The supplier record that is the same company (R-175, migration 80). LINKED,
   *  never merged, and money is never netted across it. Optional because
   *  `get_client`'s SELECT does not return it yet — see `getPartyLink`. */
  linked_party_id?: string | null;
}

/** One end of the dual-role party link. The two records stay separate: what they
 *  pay us is revenue and what we pay them is cost, and a UI that shows one
 *  combined figure for the pair calls it POSITION, never profit. */
export interface PartyLink {
  /** The id of the record on the OTHER side of the link. */
  linked_id: string;
  linked_name: string;
  /** Which table `linked_id` lives in. */
  linked_type: "client" | "supplier";
  /** The link names a row THIS DEVICE HAS NOT PULLED YET. Migration 80 is explicit
   *  that an id we do not hold means "not linked here yet", never an error, so the
   *  backend reports it as a flag rather than failing. On this shape `linked_id`
   *  and `linked_name` are empty — there is nothing here to name — so a caller must
   *  read it as "linked, but not on this device" and never print the blank name. */
  link_pending?: boolean;
}

/** The `linked_party_payments` envelope. Only the identity half is read here: both
 *  payment lists are fetched per side through `counterpartyPayments`, which is what
 *  keeps the two sides separate and stops anything netting them. */
interface LinkedPartyEnvelope {
  linked: { ctype: "client" | "supplier"; id: string; name: string } | null;
  link_pending: boolean;
}

export interface ClientInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  notes?: string | null;
  metadata?: Record<string, any> | null;
  lead_status?: string;
  category?: string | null;
  tags?: string | null;
  street_address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  country?: string | null;
  next_follow_up_date?: string | null;
  needs_review?: boolean;
}

export interface ClientFilter {
  category?: string;
  tiers?: string[];
  tag?: string;
  state?: string;
  stale_days?: number;
  missing?: string;
  needs_review?: boolean;
  /** Only clients who unsubscribed from email. */
  unsubscribed?: boolean;
  search?: string;
  sort_by?: string;
  /** Exact lead_status, or "active_not_dormant" for everyone who isn't dormant. */
  lead_status?: string;
  /** Filter to clients whose lead_representative / source_rep matches this name. */
  rep?: string;
}

export interface MissingInfoReport {
  missing_email: Client[];
  missing_phone: Client[];
  missing_address: Client[];
  missing_category: Client[];
  never_contacted: Client[];
  needs_review: Client[];
  total_incomplete: number;
}

export interface Newsletter {
  id: string;
  subject: string;
  body: string;
  status: string;
  recipient_count: number;
  sent_count: number;
  created_at: string;
  sent_at?: string;
}

export interface NewsletterSendError {
  client_name: string;
  error: string;
}

export interface NewsletterSendResult {
  sent: number;
  failed: number;
  skipped: number;
  errors: NewsletterSendError[];
}

export interface GlobalSearchResults {
  clients: SearchClient[];
  invoices: SearchInvoice[];
  deals: SearchDeal[];
  suppliers: SearchSupplier[];
}

export interface SearchClient { id: string; name: string; company: string | null; email: string | null; }
export interface SearchInvoice { id: string; number: string; client_name: string; }
export interface SearchDeal { id: string; title: string; client_name: string; }
export interface SearchSupplier { id: string; name: string; }

export interface ScheduledSend {
  id: string;
  newsletter_id: string;
  subject: string;
  body: string;
  attachment_path: string | null;
  scheduled_at: string;
  interval_seconds: number;
  total_recipients: number;
  recipients_json: string;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  status: "pending" | "running" | "completed" | "cancelled" | "failed";
  error: string | null;
  created_at: string;
}

export interface ScheduledSendProgress {
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  total_recipients: number;
  status: string;
}

export interface Me {
  id: string;
  email: string;
  display_name: string;
  role_id: string;
  role_name: string;
  permissions: string[];
  is_admin: boolean;
  avatar?: string;
  title?: string;
  phone?: string;
}
export interface StaffMember {
  id: string;
  email: string;
  display_name: string;
  role_id: string;
  role_name: string | null;
  status: string;
  commission_pct: number;
  hide_pay_cuts: boolean;
  avatar?: string;
  title?: string;
  phone?: string;
  created_at?: string | null;
}
export interface RoleDef {
  id: string;
  name: string;
  permissions: string[];
  is_system: boolean;
}
export interface InviteRow {
  token: string;
  role_id: string;
  role_name: string | null;
  email: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}
export interface ApprovalRequest {
  id: string;
  kind: string;
  entity_id: string | null;
  summary: string;
  requested_by_name: string | null;
  created_at: string;
}
export interface FormField {
  id: string;
  type: string; // name | email | phone | company | text | textarea | select | checkbox | date
  label: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
  map?: string; // canonical target: "name"|"email"|"phone"|"company"|"notes"|"cf:<key>"|"" (store as answer)
}
export interface FormDef {
  id: string;
  name: string;
  title: string;
  intro: string;
  fields_json: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}
export interface CheckupSession {
  id: string;
  name: string;
  owner_name: string | null;
  status: string;
  created_at: string;
  total: number;
  done: number;
}
export interface CheckupItem {
  id: string;
  client_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** 0 = to reach out, 1 = reached out, 2 = done */
  stage: number;
  note: string;
  reached_out_at: string | null;
}
export interface CheckupDetail {
  id: string;
  name: string;
  status: string;
  items: CheckupItem[];
}

export interface NewsletterSchedule {
  id: string;
  name: string;
  subject: string;
  body: string;
  recipient_filter: string;
  interval_type: string;
  interval_value: number;
  send_hour: number;
  next_run_at: string;
  last_run_at: string | null;
  active: number;
  created_at: string;
}

export interface Category {
  id: string;
  label: string;
  sort_order: number;
  parent_id?: string | null;
}

export interface CategoryInput {
  label: string;
  parent_id?: string | null;
}

export interface SheetSyncConfig {
  id: number;
  sheet_url: string | null;
  name_col: string;
  first_name_col: string;
  last_name_col: string;
  email_col: string;
  phone_col: string;
  company_col: string;
  category_col: string;
  lead_status_col: string;
  notes_col: string;
  skip_header_rows: number;
  last_synced_at: string | null;
  last_synced_count: number;
  field_mapping_json: string | null;
  /** When true, approving a lead appends a row to the connected sheet. */
  writeback_enabled: boolean;
}

/** Live status of the approved-lead → sheet write-back (Settings status banner). */
export interface SheetWritebackStatus {
  enabled: boolean;
  sheet_configured: boolean;
  google_connected: boolean;
  active: boolean;
  state: "active" | "disabled" | "no_sheet" | "not_connected";
  message: string;
}

export interface CustomField {
  id: string;
  field_key: string;
  label: string;
  field_type: string;
  options_json: string | null;
  sort_order: number;
  created_at: string;
}

export interface SheetHeader {
  column_letter: string;
  header_text: string;
}

export interface SheetSyncResult {
  new_clients: number;
  skipped_duplicates: number;
  errors: string[];
}

export interface SheetSyncLogEntry {
  id: string;
  synced_at: string;
  new_clients: number;
  skipped_duplicates: number;
  errors: string | null;
}

export interface Interaction {
  id: string;
  client_id: string;
  kind: string;
  subject: string | null;
  body: string | null;
  created_at: string;
  /** Who logged it. `interactions.user_name` has existed since migration 25 and
   *  the desktop writer fills it in, but the desktop READ path never selected it,
   *  so every row on a profile showed no author (R-152-c). The server half shipped
   *  in v0.16.1. Optional here because a build whose `list_interactions` has not
   *  been updated yet simply omits the field — it must read as "not known", never
   *  as an error. Add `user_name` to the `Interaction` struct and to the SELECT in
   *  `commands.rs::list_interactions` and every row fills in. */
  user_name?: string | null;
}

export interface LineItem {
  description: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface Invoice {
  id: string;
  client_id: string;
  number: string;
  issue_date: string;
  due_date: string;
  line_items_json: string;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  pdf_path: string | null;
  sent_at: string | null;
  notes?: string;
  cost_items_json: string | null;
  total_cost: number | null;
  profit: number | null;
  margin: number | null;
  carrier: string | null;
  tracking_number: string | null;
  shipping_charged: number | null;
  pickup_date: string | null;
  delivery_date: string | null;
  is_complete: boolean;
  deal_flow_id?: string | null;
  deal_flow_stage?: string | null;
  voided?: boolean;
  /** Return-policy wording this invoice was sent under (R-162), frozen at creation.
   *  Empty/absent means no clause was sent — never falls back to the current default. */
  return_policy?: string | null;
}

export interface ShippingInfo {
  carrier?: string;
  tracking_number?: string;
  shipping_charged?: number;
  pickup_date?: string;
  delivery_date?: string;
  is_complete: boolean;
}

export interface CostItem {
  description: string;
  amount: number;
}

export interface DealCostItem {
  description: string;
  amount: number;
  supplier_name?: string;
}

export interface InvoiceNumberingConfig {
  prefix: string;
  next_number: number;
  padding: number;
  preview: string;
}

export interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  currency: string;
  status: string;
  payment_method: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_customer_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface StripeConfigStatus {
  configured: boolean;
  publishable_key_present: boolean;
  secret_key_present: boolean;
  webhook_secret_present: boolean;
}

export interface SupplierNameSuggestion {
  supplier_name: string;
  count: number;
}

export interface Deal {
  id: string;
  client_id: string;
  title: string;
  stage: 'lead' | 'quoted' | 'negotiating' | 'won' | 'lost';
  line_items_json: string;
  supplier_costs_json: string;
  shipping_cost: number;
  other_costs: number;
  asking_price: number;
  payment_terms?: string;
  notes?: string;
  expected_close_date?: string;
  created_at: string;
  updated_at: string;
  won_at?: string;
  lost_at?: string;
  lost_reason?: string;
  converted_invoice_id?: string;
  metadata?: string;
}

export interface DealInput {
  client_id: string;
  title: string;
  stage?: string;
  line_items: LineItem[];
  supplier_costs: DealCostItem[];
  shipping_cost?: number;
  other_costs?: number;
  asking_price?: number;
  payment_terms?: string;
  notes?: string;
  expected_close_date?: string;
}

// ── Receivables (AR) — aged by invoice due date, deal-aware ──
export interface ReceivablesSummary {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  open_count: number;
  due_soon: number;
}
export interface ARClient {
  client_id: string;
  client_name: string;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  oldest_days: number;
}
/** One open receivable (invoice). `deal_flow_id` set → drill-down to the deal. */
export interface ARItem {
  invoice_id: string;
  invoice_number: string;
  deal_flow_id: string | null;
  client_id: string;
  client_name: string;
  amount: number;
  due_date: string;
  days_overdue: number;
  bucket: string;
  /** true = deal past the speculative stage; false = speculative early invoice. */
  committed: boolean;
  deal_flow_stage: string | null;
}
export interface ReceivablesAging {
  summary: ReceivablesSummary;
  by_client: ARClient[];
  items: ARItem[];
}

// ── Payables (AP) — what you owe suppliers/freight/wires, deal-aware ──
export interface PayablesSummary {
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  open_count: number;
}
export interface PayableSupplier {
  payee: string;
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  oldest_days: number;
}
/** One open payable (a deal cost). Surfaces which customer/deal it's for. */
export interface APItem {
  deal_flow_id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  payee: string;
  amount: number;
  client_id: string | null;
  client_name: string | null;
  anchor_date: string;
  days: number;
  bucket: string;
  /** true = deal past the speculative stage; false = speculative early payable. */
  committed: boolean;
  deal_flow_stage: string | null;
}
export interface PayablesAging {
  summary: PayablesSummary;
  by_payee: PayableSupplier[];
  items: APItem[];
}

export interface SupplierPayment {
  id: string;
  supplier_name: string;
  supplier_id?: string | null;
  amount: number;
  original_amount?: number | null;
  price_changed?: boolean;
  quantity?: number | null;
  unit_price?: number | null;
  method?: string | null;
  notes?: string | null;
  paid: boolean;
  paid_at?: string | null;
  /** Cost type: supplier (default) | freight | wire_in | wire_out | other. */
  category?: string | null;
  /** "Didn't pay — kept it": excluded from cost/profit. Distinct from `paid`. */
  kept?: boolean;
}

export interface SupplierPaymentInput {
  supplier_name: string;
  supplier_id?: string | null;
  amount: number;
  quantity?: number | null;
  unit_price?: number | null;
  method?: string | null;
  notes?: string | null;
  category?: string | null;
}

export interface PaymentReceivedInput {
  amount: number;
  method?: string | null;
  notes?: string | null;
  received_at?: string | null;
}

export interface Supplier {
  id: string;
  name: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  payment_method?: string | null;
  payment_details?: string | null;
  payment_terms?: string | null;
  typical_lead_time?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  total_paid: number;
  deal_count: number;
  last_deal_date?: string | null;
  /** Most recent email to or from this supplier (R-239). Distinct from last_deal_date,
   *  which counts COMPLETED deals only. */
  last_contact?: string | null;
  /** 'email_in' or 'email_out' — which direction that most recent contact was. */
  last_contact_kind?: string | null;
  avg_deal_amount: number;
  total_profit: number;    // profit on their deals, apportioned by their share of the payments
  total_revenue: number;   // apportioned the same way — 0 means "no revenue recorded", not "0%"
  /** The client record that is the same company (R-175, migration 80). See
   *  `PartyLink` — linked, never merged, never netted. */
  linked_party_id?: string | null;
}

export interface SupplierInput {
  name: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  payment_method?: string | null;
  payment_details?: string | null;
  payment_terms?: string | null;
  typical_lead_time?: string | null;
  notes?: string | null;
}

export interface SupplierPriceEntry {
  id: string;
  supplier_id: string;
  item_description: string;
  price: number;
  quantity?: number | null;
  recorded_at: string;
  deal_flow_id?: string | null;
  notes?: string | null;
}

export interface PriceAlert {
  supplier_id: string;
  supplier_name: string;
  item_description: string;
  previous_price: number;
  current_price: number;
  change_pct: number;
  deal_flow_id: string;
}

export interface SupplierNode {
  supplier_payment_id: string;
  supplier_id?: string | null;
  supplier_name: string;
  amount: number;
  original_amount?: number | null;
  price_changed: boolean;
  quantity?: number | null;
  unit_price?: number | null;
  paid: boolean;
  paid_at?: string | null;
  method?: string | null;
  notes?: string | null;
  supplier_contact?: string | null;
  supplier_email?: string | null;
  supplier_phone?: string | null;
  payment_method?: string | null;
  payment_details?: string | null;
}

export interface DealFlowNodeMap {
  deal_flow_id: string;
  invoice_number: string;
  client_name: string;
  client_email?: string | null;
  invoice_total: number;
  stage: string;
  payment_received?: number | null;
  supplier_nodes: SupplierNode[];
  net_profit: number;
  profit_jack: number;
  profit_ben: number;
  profit_business: number;
  is_loss: boolean;
  price_alerts: PriceAlert[];
}

export interface CompleteDealResult {
  profit: number;
  is_loss: boolean;
  warning?: string | null;
}

export interface ProfitSplit {
  business_pct: number;
  jack_pct: number;
  ben_pct: number;
  jack_name: string;
  ben_name: string;
}

/** A configured payout recipient. Empty recipient list = payouts not set up. */
export interface PayoutShare {
  name: string;
  pct: number;
  is_business: boolean;
}

/** A recipient's cut across the brief periods (empty list when unconfigured). */
export interface PayoutTotal {
  name: string;
  is_business: boolean;
  this_week: number;
  this_month: number;
  all_time: number;
}

/**
 * Split a single completed deal's net profit across the configured recipients.
 * Mirrors the Rust `allocate_payout`: the whole net goes to the "included" bucket
 * when partners were cut in, otherwise to the business recipient(s). Returns [] when
 * unconfigured so callers render no split (never an assumed split or partner names).
 */
export function allocateDealPayout(
  net: number,
  payoutIncluded: boolean,
  recipients: PayoutShare[],
): { name: string; is_business: boolean; amount: number }[] {
  if (!recipients.length) return [];
  const netIncl = payoutIncluded ? net : 0;
  const netExcl = payoutIncluded ? 0 : net;
  const bizPctSum = recipients.filter((r) => r.is_business).reduce((a, r) => a + (Number(r.pct) || 0), 0);
  const bizCount = recipients.filter((r) => r.is_business).length;
  const anyBiz = bizCount > 0;
  return recipients.map((r) => {
    const pct = Number(r.pct) || 0;
    const base = (netIncl * pct) / 100;
    let extra = 0;
    if (Math.abs(netExcl) >= 1e-6) {
      if (anyBiz) {
        if (r.is_business) extra = bizPctSum > 0 ? (netExcl * pct) / bizPctSum : netExcl / bizCount;
      } else {
        extra = (netExcl * pct) / 100;
      }
    }
    return { name: r.name, is_business: r.is_business, amount: Math.round((base + extra) * 100) / 100 };
  });
}

/** Parse a deal_flow's metadata for whether partners were cut in (default false). */
export function dealPayoutIncluded(flow: { metadata?: string | null }): boolean {
  try { return !!JSON.parse(flow.metadata || "{}").payout_included; } catch { return false; }
}

/**
 * The recipients breakdown captured when the deal was completed
 * (metadata.payout_recipients, written by complete_deal_flow). These are the
 * authoritative per-deal amounts — they reflect the split configured at
 * completion time, not today's config. Null for deals completed before
 * breakdowns existed (callers fall back to allocateDealPayout + live config).
 */
export function dealPayoutRecipients(
  flow: { metadata?: string | null },
): { name: string; pct: number; is_business: boolean; kind?: string; amount: number }[] | null {
  try {
    const arr = JSON.parse(flow.metadata || "{}").payout_recipients;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr
      .filter((r) => r && typeof r === "object" && (r.name || r.is_business))
      .map((r) => ({
        name: r.is_business && !r.name ? "Business" : String(r.name ?? ""),
        pct: Number(r.pct) || 0,
        is_business: !!r.is_business,
        kind: typeof r.kind === "string" ? r.kind : undefined,
        amount: Number(r.amount) || 0,
      }));
  } catch { return null; }
}

/**
 * Per-deal profit split for display: the completion-time breakdown when the
 * deal has one, otherwise re-derived from the CURRENT config (old deals).
 * Empty when payouts aren't set up.
 */
export function dealPayoutSplit(
  flow: { metadata?: string | null; net_profit: number },
  recipients: PayoutShare[],
): { name: string; is_business: boolean; amount: number }[] {
  const stored = dealPayoutRecipients(flow);
  if (stored) return stored;
  return allocateDealPayout(flow.net_profit, dealPayoutIncluded(flow), recipients);
}

export interface DealFlow {
  id: string;
  name?: string | null;
  invoice_id: string;
  stage: 'invoiced' | 'payment_received' | 'supplier_paid' | 'complete';
  payment_received_amount: number;
  deposit_amount: number;
  payment_received_method: string | null;
  payment_received_at: string | null;
  supplier_payments_json: string;
  supplier_payments: SupplierPayment[];
  total_supplier_cost: number;
  completed_at: string | null;
  gross_revenue: number;
  total_cost: number;
  net_profit: number;
  profit_jack: number;
  profit_ben: number;
  profit_business: number;
  notes: string | null;
  metadata?: string | null;
  created_at: string;
  updated_at: string;
  invoice_number: string | null;
  client_id: string | null;
  client_name: string | null;
  invoice_total: number;
  /** Shipping lifecycle (R-154). pickup_date = when it leaves, expected_delivery_date
   *  = when it lands. Bare 'YYYY-MM-DD' — parse with parseDay, never `new Date(s)`,
   *  or it renders one day early in Central. */
  pickup_date?: string | null;
  expected_delivery_date?: string | null;
  /** The explicit "no pickup / ships direct" answer — an empty date is an unanswered
   *  question, this is the answer "there isn't one". */
  ships_direct?: boolean;
  /** What a reschedule replaced, so a slipped date does not rewrite history. */
  pickup_date_prev?: string | null;
  expected_delivery_date_prev?: string | null;
}

export interface BuyerTier {
  client_id: string;
  client_name: string;
  tier: string;
  effective_annual: number;
  spend_per_frequency: string | null;
  actual_paid: number;
  total_profit: number;   // net profit earned from this client, after refunds
  invoices_sent: number;
  last_invoice_date: string | null;
  purchase_frequency: string | null;
  avg_commission_pct: number;
  quotes_sent: number;
  quotes_won: number;
  deals_landed: number;      // completed deals — now a tier factor
  reliability: string;       // "unrated" | "reliable" | "mixed" | "low"
  reliability_pct: number;
}

export interface CustomerHealth {
  client_id: string;
  client_name: string;
  score: number;
  risk_level: 'healthy' | 'watch' | 'at_risk' | 'critical';
  trend: 'improving' | 'stable' | 'declining';
  risk_factors: string[];
  last_interaction_days?: number;
  last_invoice_days?: number;
  avg_days_to_pay?: number;
  revenue_trend_pct: number;
}

export interface PolicyClauseSettings {
  /** The 24-hour notification clause: rides invoice AND quote sends. */
  notice_24h_enabled: boolean;
  notice_24h_text: string;
  /** The return policy: invoices only, and editable per deal on the invoice form. */
  return_policy_enabled: boolean;
  return_policy_text: string;
}

export interface InvoiceInput {
  client_id: string;
  due_date: string;
  issue_date?: string;
  line_items: LineItem[];
  tax_rate: number;
  notes?: string;
  recurring?: string;
  return_policy?: string;
}

export interface ReleaseLetterInput {
  buyer_name: string;
  buyer_company: string;
  description: string;
  letter_date: string;
  seller_name: string;
  /** Letter body; {BUYER}, {SELLER} and {DESCRIPTION} are substituted server-side. */
  body: string;
  /** data:image/png;base64,... from the signature canvas. */
  signature_png: string | null;
  output_path: string;
}

// ---- Client statement / receipt (R-190) ----
// One PDF covering many deals for one client. Deliberately carries no cost, margin
// or supplier field — it is handed to the customer.

export interface StatementPayment {
  id: string;
  date: string;
  amount: number;
  method: string;
  reference: string;
  /** 'bank' = a real bank line behind it; 'recorded' = the figure typed on the deal. */
  source: 'bank' | 'recorded';
  date_missing: boolean;
  method_missing: boolean;
}

export interface StatementRefund {
  id: string;
  date: string;
  amount: number;
  method: string;
  reason: string;
}

export interface StatementDeal {
  deal_flow_id: string;
  invoice_id: string;
  invoice_number: string;
  name: string;
  stage: string;
  issue_date: string;
  due_date: string;
  closed_date: string;
  pickup_date: string;
  delivery_date: string;
  items: LineItem[];
  /** Stands in for the item table when the invoice has none. */
  label: string;
  subtotal: number;
  tax: number;
  total: number;
  payments: StatementPayment[];
  refunds: StatementRefund[];
  paid: number;
  refunded: number;
  balance: number;
}

export interface StatementClient {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  address_lines: string[];
}

/** A blank the document would print. `writes_back` says whether filling it in updates
 *  the record or only this one PDF — payment dates/methods live on bank_txn, and
 *  rewriting a posted date would move the deal's closed date. */
export interface StatementGap {
  kind: 'client_email' | 'client_address' | 'deal_label' | 'payment_date' | 'payment_method';
  target_id: string;
  deal_flow_id: string;
  label: string;
  writes_back: boolean;
}

export interface StatementTotals {
  invoiced: number;
  paid: number;
  refunded: number;
  net_received: number;
  balance: number;
}

export interface StatementData {
  client: StatementClient;
  deals: StatementDeal[];
  gaps: StatementGap[];
  totals: StatementTotals;
}

export interface StatementOptions {
  include_items: boolean;
  include_payments: boolean;
  include_refunds: boolean;
  include_dates: boolean;
  include_summary: boolean;
  include_balance: boolean;
  title: string;
  intro: string;
}

export interface StatementOverrides {
  /** allocation id -> YYYY-MM-DD */
  payment_dates: Record<string, string>;
  /** allocation id -> how it arrived */
  payment_methods: Record<string, string>;
  /** deal_flow id -> what the deal was, when the invoice has no item lines */
  deal_labels: Record<string, string>;
}

export interface StatementInput {
  client_id: string;
  /** Ticked deals. Empty = every deal the client has. */
  deal_ids: string[];
  options: StatementOptions;
  overrides: StatementOverrides;
  output_path: string;
}

export interface Quote {
  id: string;
  client_id: string;
  number: string;
  issue_date: string;
  valid_until: string;
  line_items_json: string;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  pdf_path: string | null;
  sent_at: string | null;
  notes: string | null;
  converted_invoice_id: string | null;
  created_at: string;
}

export interface QuoteInput {
  client_id: string;
  valid_until: string;
  issue_date?: string;
  line_items: LineItem[];
  tax_rate: number;
  notes?: string;
}

export interface RecurringInvoice {
  id: string;
  client_id: string;
  client_name: string;
  template_name: string;
  line_items_json: string;
  tax_rate: number;
  notes: string | null;
  payment_method_label: string | null;
  frequency: string;
  next_due_date: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RecurringInvoiceInput {
  client_id: string;
  template_name: string;
  line_items: LineItem[];
  tax_rate: number;
  notes?: string;
  payment_method_label?: string;
  frequency: string;
}

export interface DealHighlight {
  deal_id: string;
  client_name: string;
  title: string;
  asking_price: number;
  margin_pct: number;
}

export interface InvoiceHighlight {
  invoice_id: string;
  client_name: string;
  number: string;
  total: number;
}

export interface MonthStat {
  month: string;       // "YYYY-MM"
  count: number;
  revenue: number;
  net_profit: number;  // refund-aware
  margin_pct: number;
}

export interface WeeklyBrief {
  generated_at: string;
  week_start: string;
  week_end: string;
  avg_margin_this_month: number;
  avg_margin_all_time: number;
  revenue_this_month: number;
  revenue_all_time: number;
  monthly_breakdown: MonthStat[];
  revenue_this_week: number;
  revenue_last_week: number;
  revenue_change_pct: number;
  profit_this_week: number;
  profit_last_week: number;
  profit_change_pct: number;
  avg_margin_this_week: number;
  deals_closed_this_week: number;
  deals_lost_this_week: number;
  win_rate_this_week: number;
  overdue_invoices_count: number;
  overdue_invoices_value: number;
  follow_ups_due: number;
  best_margin_deal: DealHighlight | null;
  worst_margin_deal: DealHighlight | null;
  biggest_invoice: InvoiceHighlight | null;
  new_clients_this_week: number;
  interactions_this_week: number;
  completed_deals_this_week: number;
  completed_deals_last_week: number;
  net_profit_this_week: number;
  net_profit_last_week: number;
  net_profit_change_pct: number;
  profit_jack_this_week: number;
  profit_ben_this_week: number;
  profit_business_this_week: number;
  profit_jack_all_time: number;
  profit_ben_all_time: number;
  profit_business_all_time: number;
  net_profit_this_month: number;
  profit_jack_this_month: number;
  profit_ben_this_month: number;
  profit_business_this_month: number;
  loss_deals_this_week: number;
  loss_total_this_week: number;
  refunded_deals_this_week: number;
  refunded_total_this_week: number;
  rep_earnings_this_week: number;
  /** Config-driven payout split per recipient; empty when payouts aren't set up. */
  payout_totals: PayoutTotal[];
}


export interface DuplicateGroup {
  key: string;
  count: number;
  client_ids: string[];
  names: string[];
}

export interface ParsedEmail {
  uid: number;
  message_id: string | null;
  from: string;
  from_name: string | null;
  to: string[];
  subject: string;
  body_text: string;
  body_html: string | null;
  date: string | null;
  has_attachments: boolean;
  source?: string;
}
export interface EmailInbox {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  /** "org" (shared, inherited by all admins) or "me" (personal, this device only). */
  scope?: "org" | "me";
  /** "oauth2" once this mailbox's owner has linked it by signing in with Google. */
  auth_method?: "password" | "oauth2";
}

export interface EmailSettings {
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  user: string;
  auth_method: "password" | "oauth2";
  /** Staff id of the admin who currently owns/receives the shared inbox. */
  owner_staff_id?: string;
  /** Address mail leaves as, when it differs from the login. Blank = use `user`. */
  from_email?: string;
  /** Invoice-only From, so invoices carry a billing address. Blank = `from_email`. */
  from_invoices?: string;
}

export interface CompanyInfo {
  name: string;
  address: string;
  email: string;
  phone?: string | null;
  tax_id?: string | null;
  logo_path?: string | null;
  show_company_name?: boolean | null;
}

// Invoice branding template — drives the generated PDF (and the live preview).
// Defaults keep today's look.
export interface InvoiceTemplate {
  logo_placement: "left" | "center" | "right";
  logo_size: "small" | "medium" | "large";
  show_company_name: boolean;
  show_address: boolean;
  show_email: boolean;
  show_phone: boolean;
  show_tax_id: boolean;
  accent_color: string;   // hex
  title_label: string;    // default "INVOICE"
  footer_note: string;
}

// One soft-deleted (archived) record — an invoice, deal, or deal flow.
export interface ArchiveItem {
  kind: "invoice" | "deal" | "deal_flow";
  id: string;
  title: string;
  client_name: string | null;
  amount: number;
  reason: "deleted" | "fell_through";
  archived_at: string | null;
}

// Data safety — one cross-device integrity anomaly and the rows a converge would delete.
export interface IntegrityTarget {
  table: string;
  id: string;
  label: string;
}
export interface IntegrityItem {
  kind: "resurrected_invoice" | "orphan_payment" | "orphan_deal_flow";
  id: string;
  title: string;
  detail: string;
  amount: number | null;
  targets: IntegrityTarget[];
}

/// One account's answer to "does the ledger still agree with the bank?".
/// `implied_opening` (bank balance minus net ledger movement) can never legitimately
/// change; `drift` is how far it has moved since the baseline, i.e. the size of the
/// transactions that were added, removed or altered behind us.
export interface ReconAccount {
  account: string;
  bank_balance: number;
  ledger_net: number;
  implied_opening: number;
  baseline: number | null;
  drift: number;
  txn_count: number;
}

/// A write this device gave up delivering to the server (and therefore to every
/// other device). The local row is still correct here — only the delivery failed.
export interface StrandedWrite {
  event_id: string;
  table: string;
  row_id: string;
  op: "upsert" | "delete" | "unknown";
  reason: string;
  at: string;
  /// One of the money tables — these are the ones that change a figure.
  is_money: boolean;
  detail: string;
}

export interface DashboardStats {
  clients: number;
  invoices: number;
  outstanding: number;
  // New hero counts (backend-provided).
  total_clients: number;
  open_deals: number;
  completed_this_month: number;
  // Hero money — revenue = paid invoices, profit = completed deal flows.
  revenue_all_time: number;
  revenue_prev_month: number;
  profit_all_time: number;
  profit_prev_month: number;
  paid_ytd: number;
  revenue_this_week: number;
  clients_this_week: number;
  interactions_this_week: number;
  total_cost: number;
  total_profit: number;
  avg_margin: number;
  monthly_profit: { month: string; revenue: number; cost: number; profit: number }[];
  top_clients_by_profit: { name: string; total_revenue: number; total_profit: number; margin: number }[];
  pipeline_value: number;
  pipeline_count: number;
  incomplete_shipping: number;
  category_breakdown: { category: string; client_count: number; revenue: number }[];
  invoice_status_breakdown: { status: string; count: number; total: number }[];
  top_spenders: { name: string; company: string | null; invoice_count: number; total_spent: number; total_profit: number; last_invoice: string | null }[];
  loss_deals_this_month: number;
  loss_total_this_month: number;
  revenue_mtd: number;
  profit_mtd: number;
  deals_mtd: number;
  top_suppliers: { name: string; contact_name: string; deal_count: number; total_paid: number }[];
  all_time_revenue: number;
  all_time_profit: number;
  refunded_total: number;
  refund_owed_remaining: number;
  deals_won_all: number;
  deals_lost_all: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  invite_code: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Lot {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  quantity: number;
  total_cost: number;
  asking_price: number;
  status: string;
  linked_deal_id: string | null;
  photos_json: string;
  created_at: string;
  updated_at: string;
  notes: string | null;
  sent_whatsapp: boolean;
  sent_email: boolean;
  sent_facebook: boolean;
  supplier: string | null;
  location: string | null;
  manifest_path: string | null;
  price_type: string;
  details_json: string | null;
}

/** One city from the bundled US gazetteer, as the location picker sees it. */
export interface CityEntry {
  city: string;
  state: string;
  population: number;
}

/** A distinct value in use in `inventory.location`, and how many lots carry it. */
export interface LotLocationGroup {
  value: string;
  lot_count: number;
}

export interface LocationFixSummary {
  lots_updated: number;
  values_changed: number;
  /** Where the pre-change values were saved. Shown so the undo path is never a mystery. */
  backup_path: string;
}

/** Parsed shape of Lot.details_json — public structured extras. */
export interface LotDetails {
  pallets?: number | null;
  // How the quantity was entered. `quantity` on the lot is ALWAYS the total unit
  // count — the storefront, analytics and every report read it that way — but a
  // supplier usually quotes per pallet, so the form lets you type that figure and
  // records the basis here. `qty_per_pallet` is stored rather than re-derived by
  // division so re-opening the form shows exactly what was typed.
  qty_basis?: "total" | "per_pallet" | null;
  qty_per_pallet?: number | null;
  // Upper end of a quoted per-pallet RANGE ("450-500 units per pallet"). `quantity`
  // keeps the LOW end multiplied out, so stock is never overstated to a buyer; the
  // range itself is what gets displayed beside it.
  qty_per_pallet_max?: number | null;
  msrp?: number | null;
  avg_msrp?: number | null;
  moq?: number | null;
  size_run?: { size: string; qty: number }[] | null;
  price_text?: string | null;   // free-text price shown verbatim when price_type === "custom"
  // How the PRICE was entered, mirroring `qty_basis`. `asking_price` is ALWAYS the
  // figure `price_type` describes — a per-pallet lot stores `price_type: "total"` and
  // the multiplied-out whole-load price — so every existing value/profit sum stays
  // correct. `price_per_pallet` is the figure the supplier actually quoted, kept so the
  // form shows it back and every surface can print "$1,500 per pallet · $3.16 / unit".
  price_basis?: "total" | "per_pallet" | null;
  price_per_pallet?: number | null;
  open_to_offers?: boolean | null;  // storefront shows a "Make an offer" form when true
  // Shopify-style variants: option TYPES (Color, Size…) each with their values, and
  // one variant row per combination the seller stocks, with its own qty + price.
  options?: LotOption[] | null;
  variants?: LotVariant[] | null;
  // Extra categories beyond the primary `category` column (multi-category lots). The
  // primary stays in the column for existing segment/newsletter matching; the full set
  // lives here and shows on the lot + storefront.
  categories?: string[] | null;
  // Free-form / picked condition of the goods (New, Customer returns, Shelf pulls…).
  condition?: string | null;
  // The prior asking price, stamped when the price is DROPPED — powers the "reduced from
  // X" indicator on the card, detail, and storefront. Cleared when the price rises back.
  prev_price?: number | null;
  // Public manifest summary saved from the analyzer — the storefront renders a
  // "what's inside" panel from it. Internal pricing (retail/margin/bid) is NOT kept here.
  manifest?: LotManifestSummary | null;
}
/** Public-safe manifest summary persisted on a lot and shown on the storefront. */
export interface LotManifestSummary {
  units: number;        // total unit count (sum of the quantity column)
  lines: number;        // number of product-line rows
  categories: { name: string; quantity: number }[];  // per-category unit counts, desc
}

/** Facebook Page connection status for the Settings UI (never carries tokens). */
export interface FbStatus {
  has_app: boolean;          // App ID + secret saved
  connected: boolean;        // a Page is connected and postable
  page_name: string | null;  // the connected Page's name
  redirect_uri: string;      // exact URI to register in the Meta app
}
/** A Facebook Page the user manages, returned during connect for selection. */
export interface FbPageLite {
  id: string;
  name: string;
}
export interface Offer {
  id: string;
  lot_id: string;
  name: string;
  email: string;
  amount: number | null;
  message: string;
  status: string;      // new | accepted | declined
  offer_type: string;  // per_unit | lot
  created_at: string;
}
export interface LotOption { name: string; values: string[] }
export interface LotMatch {
  client_id: string;
  client_name: string;
  score: number;
  bought: string;
  unit_price: number;
  qty: number;
  invoice_id: string;
  invoice_number: string;
  issue_date: string;
  closed: boolean;
  price_close: boolean;
  shared: string[];
}

export interface LotVariant {
  values: string[];              // one value per option, aligned to options order (e.g. ["Red","M"])
  qty: number;
  price?: number | null;         // per-variant price; null → falls back to the lot's asking price
}

export interface FollowUpRule {
  id: string;
  name: string;
  trigger_type: string;
  trigger_value: number;
  action_type: string;
  email_subject: string | null;
  email_body: string | null;
  is_active: boolean;
  created_at: string;
}

export interface FollowUpLogEntry {
  id: string;
  rule_id: string;
  client_id: string | null;
  triggered_at: string;
  action_taken: string;
  details: string | null;
}

export interface ManifestGroup {
  name: string;
  items: number;       // number of line rows in this group
  quantity: number;    // sum of the quantity column (units) in this group
  total_retail: number;
}

/** What the parser actually did — shown in the UI so a mis-read price column is visible. */
export interface ManifestDetection {
  format: string;                  // "csv" | "tsv" | "xlsx" | "pdf" | "pdf (AI)"
  sheet: string | null;            // spreadsheet tab the rows came from
  header_row: number;              // 1-based; 0 = header synthesised (the PDF paths)
  description_col: string | null;
  quantity_col: string | null;
  price_col: string | null;
  category_col: string | null;
  brand_col: string | null;
  price_is_extended: boolean;      // price already includes qty, so it wasn't multiplied
  note: string | null;             // caveats: AI used, truncated, qty defaulted to 1
}

export interface ManifestAnalysis {
  categories: ManifestGroup[];        // by the manifest's category column, else keyword guess
  brands: ManifestGroup[];            // by the manifest's brand column; empty if none
  categories_from_manifest: boolean;  // false = fell back to keyword guess
  suggested_bid: number;
  total_retail: number;
  overall_margin_pct: number;
  total_items: number;      // number of product line rows analyzed
  total_quantity: number;   // sum of the quantity column — the real unit count
  skipped_rows: number;
  formula: string;
  detection: ManifestDetection;
}

export interface ProfitForecast {
  actual_profit_mtd: number;
  projected_profit: number;
  total_forecast: number;
  pipeline_value: number;
  open_deal_count: number;
  overall_win_rate: number;
  win_rate_label: string;
}

export interface PortalLink {
  id: string;
  client_id: string;
  token: string;
  expires_at: string;
  is_active: boolean;
  created_at: string;
  client_name: string | null;
  portal_url: string;
}

export interface SyncStatus {
  events_applied: number;
  last_applied: string | null;
}

export interface OllamaModel {
  name: string;
  size?: number;
}

/** Public storefront configuration (synced; the server serves the catalog from it). */
export interface StorefrontConfig {
  enabled: boolean;
  token: string;
  url: string | null;
  show_prices: boolean;
  show_logo: boolean;
  title: string;
  subtitle: string;
  contact_wa: string;
  contact_email: string;
  accent: string;
  bg: string;
}

/** Fields from the free rule-based parser (server /api/tools/parse-loads). */
export interface ParsedLoad {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  total_cost?: number | null;
  asking_price?: number | null;
  price_type?: string | null;
  condition?: string | null;
  location?: string | null;
  supplier?: string | null;
  notes?: string | null;
  pallets?: number | null;
  msrp?: number | null;
  avg_msrp?: number | null;
  moq?: number | null;
  size_run?: { size: string; qty: number }[] | null;
  // Per-pallet quoting off a supplier message ("450-500 UNITS PER PALLET / $1,500 A
  // PALLET"). `quantity` and `asking_price` above are already multiplied out; these are
  // the quoted figures, so the form can show back what was actually said.
  qty_per_pallet?: number | null;
  qty_per_pallet_max?: number | null;
  price_per_pallet?: number | null;
}

/// A forwarded supplier post waiting to be turned into inventory. Lives on the
/// server (it can arrive while this computer is asleep); nothing exists as a lot
/// until it's approved. `photos` are server-relative `media/inbound/...` paths.
export interface InboundLoad {
  id: string;
  source: string;
  sender: string;
  body: string;
  photos: string[];
  parsed: ParsedLoad[];
  received_at: string;
}

/// One lot to create out of a candidate. Snake_case: this crosses to the server.
export interface ApproveLotInput {
  name: string;
  description?: string | null;
  category?: string | null;
  quantity?: number | null;
  total_cost?: number | null;
  asking_price?: number | null;
  price_type?: string | null;
  supplier?: string | null;
  location?: string | null;
  notes?: string | null;
  details_json?: string | null;
  photos: string[];
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  total_rows: number;
}

export interface ColumnMapping {
  fields: Record<string, string>;
  metadata_keys: string[];
}

export interface LotMediaFile {
  path: string;
  lot_name: string;
}

export interface LotMediaFiles {
  photos: LotMediaFile[];
  manifests: LotMediaFile[];
}

export interface WhatsappSettings {
  template: string;
  lot_format: string;
  footer: string;
  phone: string;
}

export interface NewsletterProductTemplate {
  intro: string;      // wraps the top of the list (supports {first_name})
  outro: string;      // wraps the bottom
  lot_format: string; // per-product block: {title} {units} {price_per_unit} {price} {link}
}

export interface GoogleContact {
  resource_name: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  organization: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface BankRow {
  posted_at: string;
  amount: number;
  direction: "in" | "out";
  description: string;
  memo_raw: string;
  rail: string;
  category: string;
  counterparty_name: string;
  fitid: string;
  wire_ref: string;
  check_num: string;
  balance: number;
}
export interface BankPreview {
  format: "ofx" | "csv";
  total: number;
  has_fitid: boolean;
  sample: BankRow[];
}
export interface BankImportSummary {
  imported: number;
  skipped: number;
  errors: string[];
  format: "ofx" | "csv";
  has_fitid: boolean;
}
export interface BankTxn {
  id: string;
  posted_at: string;
  amount: number;
  direction: "in" | "out";
  description: string;
  /** A MACHINE GUESS at the payment method, never a confirmation.
   *  `bank_import::classify` string-matches the raw memo and persists `rail` on
   *  every statement parse path (OFX, CSV, PDF); its own doc comment says "This is
   *  a SUGGESTION only". Replaying it over the live ledger's 1,342 rows sets a
   *  non-empty `rail` on 690 of them. So this may be shown as `likely` and must
   *  NEVER be read as `certain` or taught to the payee memory — use
   *  `confirmed_method` for that. */
  rail: string;
  /** The payment method a HUMAN confirmed — one of BANK_METHODS, or "" for not
   *  set. `set_bank_txn_review` is its only writer. Plaid supplies no payment_meta
   *  for this institution (0 of 1,342 rows, measured 2026-08-17), so this is the
   *  only certain answer the ledger holds. The memo classifier's guesses are
   *  computed at read time and never written, which is what keeps "certain" and
   *  "likely" apart. */
  confirmed_method: string;
  category: string;
  counterparty_name: string;
  counterparty_type: string;
  counterparty_id: string;
  wire_ref: string;
  reviewed: boolean;
  account_id: string;
  allocated: number;
  alloc_count: number;
  unallocated: number;
  balance?: number | null;      // running balance — populated for statement imports, not Plaid
  posted_dt?: string | null;    // exact timestamp from the bank when available (Plaid datetime)
  /** The bank's OWN payment method from raw_json.pm.payment_method, when it sends
   *  one. Null on every row today (Plaid sends no payment_meta for this
   *  institution) — read anyway so the method facet is field-first the day some
   *  institution starts supplying it. */
  bank_method?: string | null;
}
/// The fields a review save may change. Every one is optional because a save
/// sends only what the user actually edited (see setBankTxnReview).
/// `confirmed_method` is the human's payment method (R-157) — see BankMethod.
/// `rail` is deliberately NOT here: it is the importer's guess and no UI action
/// may overwrite it, or a guess and an answer become indistinguishable again.
export type BankTxnReviewPatch = Partial<
  Pick<BankTxn, "category" | "counterparty_name" | "counterparty_type" | "counterparty_id" | "confirmed_method" | "reviewed">
>;
export interface BankTxnSummary {
  total: number;
  reviewed: number;
  sum_in: number;
  sum_out: number;
  unallocated_in: number;
  unallocated_out: number;
  unclassified: number;
}
export interface DedupeGroup {
  keep: string;
  ids?: string[];
  remove?: string[];
  account: string;
  date: string;
  amount: number;
  direction: string;
  description: string;
  count?: number;
  reason?: string;
  cross_account?: boolean;   // removal exists only because two account labels were merged
}
export interface AccountMerge { from: string; to: string; rows: number }
export interface DedupeResult {
  dry_run: boolean;
  total_transactions?: number;
  auto_groups?: number;
  auto_remove?: number;
  removed?: number;
  skipped_now_referenced?: number;
  relabelled?: number;
  account_merges?: AccountMerge[];
  review: DedupeGroup[];
  review_count: number;
  sample?: DedupeGroup[];
  backup_table?: string;
}
export interface BankAllocation {
  id: string;
  deal_flow_id: string;
  amount: number;
  role: string;
  note: string;
  deal_name: string;
  invoice_number: string;
  client_name: string;
}
export interface DealAllocation {
  id: string;
  bank_txn_id: string;
  amount: number;
  role: string;
  note: string;
  posted_at: string;
  direction: "in" | "out";
  counterparty_name: string;
  description: string;
  wire_ref: string;
  rail: string;
  txn_amount: number;
  source_format: string; // "manual_cash" for a hand-entered line
}
export interface RefundRow {
  id: string;
  amount: number;
  method: string;
  source: string;
  source_supplier_ref: string;
  keep_rep_cut: boolean;
  reason: string;
  refunded_at: string;
  bank_txn_id: string; // "" when this refund is a custom amount (not from the bank feed)
  /** Which store this line came from. "refund" = a `refunds` row (remove with
   *  deleteRefund, which also tears down its allocation). "allocation" = a bare
   *  refund_out bank allocation booked from Financials with no refunds row
   *  (remove with removeBankAllocation). The two are unioned counted-once by
   *  list_refunds, so a line never appears twice. */
  origin: "refund" | "allocation";
}
export interface DealReceipt {
  id: string;
  amount: number;
  label: string;
  received_at: string;
}
/** A deal restated around a short shipment (R-163), off `dealFlowPayout().shortage`.
 *  The input is `shortage_units` — a COUNT. Every figure below is derived from it
 *  and the rates already on record, so nobody retypes a price.
 *
 *  `expected` is the deal if the supplier takes the short units back and pays what
 *  is owed. `actual` counts only money that has really moved. They are separate on
 *  purpose: when the supplier keeps our money, cost does not fall and the profit on
 *  the kept units is zero — never the figure the unit math alone suggests. */
export interface DealShortage {
  /** false when nobody has recorded a shortage yet — which is not the same as 0 short. */
  recorded: boolean;
  invoice_units: number;    // what the invoice says, and it is never rewritten
  shortage_units: number | null;
  kept_units: number;
  buyer_rate: number;
  buyer_rate_blended: boolean;      // averaged across several invoice lines
  supplier_rate: number;
  supplier_rate_estimated: boolean; // no supplier quantity on record; cost spread over invoice units
  suggested_buyer_refund: number;
  suggested_supplier_refund: number;
  supplier_refund_owed: number | null; // an explicit figure (0 = agreed, nothing owed)
  supplier_refund_expected: number;
  supplier_refund_actual: number;      // landed as a refund_in allocation with a live bank txn
  supplier_gap: number;                // never netted against what we owe the buyer
  expected: { units: number; revenue: number; cost: number; profit: number };
  actual: { units: number; revenue: number; cost: number; profit: number };
}
export interface UnallocatedTxn {
  id: string;
  posted_at: string;
  amount: number;
  direction: "in" | "out";
  description: string;
  counterparty_name: string;
  wire_ref: string;
  rail: string;
  category: string;
  original: number;    // full transaction amount (never changes)
  mine: number;        // already allocated to THIS deal
  allocated: number;   // total claimed across all deals
  unallocated: number; // money still free to allocate anywhere (original − allocated)
}
export interface UnallocatedBankTxns {
  money_in: UnallocatedTxn[];
  money_out: UnallocatedTxn[];
}
export interface DealReconciliation {
  expected_profit: number;
  gross_revenue: number;
  total_cost: number;
  actual_profit: number;
  pieces: {
    buyer_paired: number;
    supplier_paired: number;
    fee_paired: number;
    refund_total: number;
    refund_in: number;
  };
  payment_received_paired: boolean;
  supplier_paid_paired: boolean;
  fully_reconciled: boolean;
}
export interface MoneyConfig {
  bank_balance: number;
  credit_card_balance: number;
  cash_floor: number;
  tax_sweep_pct: number;
  refund_reserve_pct: number;
  war_chest: number;
}
export interface BankAiPreview {
  total: number;
  ending_balance: number | null;
  sample: { date: string; description: string; amount: number; direction: "in" | "out"; category: string; counterparty: string }[];
}
export interface BankAiImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  extracted: number;
  ending_balance: number | null;
}
export interface PlaidItem {
  id: string;
  institution: string;
  account_count: number;
  created_at: string;
}
export interface PlaidSyncResult {
  institution: string;
  env: string;
  imported: number;
  status: string; // "ok" | "preparing" | "error"
  error: string;
}
/** What one run of the bank feed did. Every field that can destroy or defer booked
 *  work must be surfaced by EVERY caller — see surfaceSyncWarnings in FinancialsView. */
export interface PlaidSyncSummary {
  imported: number;
  removed: number;
  amended: number;
  over_allocated: string[];
  /** Bookings carried from a pending row onto the posted twin that replaced it. */
  settled: number;
  /** A pending/posted pair was identified but the booking was NOT moved. Both rows
   *  kept, nothing changed — needs a human. */
  settle_refused: string[];
  /** Booked work the bank retracted with no replacement identified. The row is KEPT,
   *  not deleted (invariant 3). */
  retracted_kept: number;
  /** Added transactions carrying Plaid's `pending_transaction_id`. This is the canary:
   *  after a sync that imported anything, 0 means Plaid is not serving the pointer for
   *  these institutions and the automatic carry-forward is inert. */
  with_pending_ref: number;
  /** Always 0 since v0.15.137 — booked work is no longer deleted by a retraction.
   *  Kept so older callers still type-check. */
  unlinked: number;
  preparing: boolean;
  results: PlaidSyncResult[];
}
export interface FinancialsOverview {
  bank_balance: number;
  credit_card_balance: number;
  supplier_payables: number;
  refund_liability: number;
  tax_reserve: number;
  refund_reserve: number;
  /** Free cash if both reserve TARGETS were actually parked elsewhere. The headline
   *  `free_cash` no longer subtracts reserves — see financials_overview. */
  free_cash_after_reserves: number;
  refund_reserve_base: number;
  refund_reserve_pct: number;
  cash_floor: number;
  loan_outstanding: number;
  war_chest: number;
  free_cash: number;
  has_plaid: boolean;
  balance_source?: "live" | "synced" | "manual";
  balance_as_of?: string | null;
  status: "green" | "yellow" | "red";
  runway_months: number;
  alerts: { refund_deals: number; stale_unallocated_in: number };
  allocated_actuals: { buyer_in: number; supplier_paid: number; refunds_out: number };
}
export interface Loan {
  id: string;
  name: string;
  lender: string;
  principal: number;
  set_aside: number;
  received_at: string;
  bank_txn_id: string;
  status: string;
  paid_at: string;
  note: string;
  outstanding: number;
}
export interface LoanLedgerEntry {
  posted_at: string;
  description: string;
  amount: number;
  kind: "received" | "repayment";
}
export interface LoanLedger {
  entries: LoanLedgerEntry[];
  received_total: number;
  repaid_total: number;
}
export interface TxnRule {
  id: string;
  match_counterparty: string;
  category: string;
  target_type: "deal" | "loan" | "expense";
  target_id: string;
  role: string;
  loan_name: string;
  created_at: string;
  direction: string; // "" any, "in" money-in only, "out" money-out only
  // Per-rule opt-in: matched transactions are booked outright (reviewed set),
  // not just pre-filled. Synced org-wide with the rule.
  auto_book: boolean;
}

// ── Smart linking (R-150) — server-scored txn → deal suggestions ──
export interface BankSuggestCandidate {
  txn_id: string;
  deal_id: string;
  role: "buyer_payment" | "supplier_payment";
  client_name: string;
  client_id: string;
  supplier_name: string | null;
  supplier_id: string | null;
  invoice_number: string;
  invoice_total: number;
  /** What this leg still expects — one meaning everywhere since R-204. Buyer:
   *  the invoice's outstanding balance. Supplier: the leg's amount. It used to
   *  be three different things across the three server code paths. */
  leg_amount: number;
  score: number;
  tier: "certain" | "strong" | "weak";
  reason: string;
  // ── R-204 ranking metadata. Optional: a server older than deploy-49 omits
  // them and the picker falls back to the deal list's own stage field.
  /** The deal's stage verbatim (`invoiced`, `payment_received`, `complete`…). */
  stage?: string;
  /** Still in the pipeline — anything but `complete`. */
  active?: boolean;
  /** Its buyer money already looks accounted for by some route (invoice stamped
   *  paid, or recorded/bank payments cover the total). Ranked down, never
   *  hidden: a late supplier leg or a refund still books against it. */
  settled?: boolean;
  /** Invoice total less what is already bank-linked. Buyer candidates only. */
  outstanding?: number;
}

/// A PERSON the server thinks a transaction belongs to (R-156/W1-b) — the same
/// name match that nominates a deal, read as a party instead. Returned alongside
/// `candidates` on /api/bank/suggestions, additively: a server that predates
/// deploy-41 simply omits it and the picker falls back to search.
///
/// Identity, never accounting. Applying one writes counterparty_type/id and
/// moves no money figure. Never auto-applied — R-150's locked decision.
export interface BankPersonCandidate {
  type: "client" | "supplier";
  id: string;
  name: string;
  score: number;
  tier: "certain" | "strong" | "weak";
  reason: string;
}

export interface CounterpartyPaymentRow {
  txn_id: string;
  posted_at: string;
  amount: number;
  direction: "in" | "out";
  description: string;
  counterparty_name: string;
  deal_flow_id: string;
  role: string;
  invoice_number: string;
  client_name: string;
  tagged: boolean;
}

export interface ReconciliationMissingDeal {
  deal_id: string;
  invoice_number: string;
  client_name: string;
  missing: {
    leg: "buyer_payment" | "supplier_payment";
    supplier_name?: string;
    target_amount: number;
    candidates: BankSuggestCandidate[];
  }[];
}

export interface SignupRule {
  id: string;
  name: string;
  sender_pattern: string | null;  subject_pattern: string | null;
  inbox_source: string | null;
  active: boolean;
  created_at: string;
}

export interface SignupRuleInput {
  name: string;
  sender_pattern?: string | null;
  subject_pattern?: string | null;
  inbox_source?: string | null;
  active: boolean;
}

// ── Form-capture preview (Settings → Email → Capture) ──
export interface CapturedCustomer {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  tax_id: string | null;
  categories: string[];
  extra: Record<string, string>;
}
export interface FormCapturePreview {
  found: boolean;
  customer: CapturedCustomer | null;
  matched_from: string | null;
  matched_subject: string | null;
}

// ── Automations dashboard summary (Automation tab) ──
export interface IntakeSourceSummary {
  id: string;
  name: string;
  token: string;
  kind: string;
  captured_count: number;
  url: string;
}
export interface AutomationsSummary {
  followup_rules: { total: number; active: number };
  signup_rules: { total: number; active: number };
  intake_sources: IntakeSourceSummary[];
  intake_base_url: string;
}

export interface LineItemTemplate {
  id: string;
  description: string;
  rate: number;
  qty: number;
  sort_order: number;
}

export interface PaymentMethod {
  id: string;
  kind: string;
  label: string;
  details: string;
  active: boolean;
  sort_order: number;
}

export interface PaymentMethodInput {
  kind: string;
  label: string;
  details?: string;
}

export interface EmailDraft {
  id: string;
  client_id: string | null;
  in_reply_to_message_id: string | null;
  to_addr: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

// ===== API =====
export const api = {
  // Clients
  listClients: () => invoke<Client[]>("list_clients"),
  clientLastActivity: () => invoke<{ client_id: string; kind: string; at: string }[]>("client_last_activity"),
  getClient: (id: string) => invoke<Client | null>("get_client", { id }),
  createClient: (input: ClientInput) => invoke<Client>("create_client", { input }),
  updateClient: (id: string, input: ClientInput) =>
    invoke<void>("update_client", { id, input }),
  deleteClient: (id: string) => invoke<void>("delete_client", { id }),
  searchClients: (query: string) => invoke<Client[]>("search_clients", { query }),
  globalSearch: (query: string) => invoke<GlobalSearchResults>("global_search", { query }),
  listStaleClients: (days: number) => invoke<Client[]>("list_stale_clients", { days }),
  listClientsFiltered: (filter: ClientFilter) => invoke<Client[]>("list_clients_filtered", { filter }),
  listClientReps: () => invoke<string[]>("list_client_reps"),
  clientsMissingInfo: () => invoke<MissingInfoReport>("clients_missing_info"),
  updateClientStatus: (id: string, status: string) =>
    invoke<void>("update_client_status", { id, status }),
  toggleClientBlacklist: (id: string) =>
    invoke<boolean>("toggle_client_blacklist", { id }),
  toggleClientExclusive: (id: string) =>
    invoke<boolean>("toggle_client_exclusive", { id }),
  resubscribeClient: (id: string) =>
    invoke<void>("resubscribe_client", { id }),
  toggleClientHighValue: (id: string) =>
    invoke<boolean>("toggle_client_high_value", { id }),
  setClientCreditLimit: (id: string, limit: number) => invoke<void>("set_client_credit_limit", { id, limit }),
  getClientCreditStatus: (id: string) =>
    invoke<{ credit_limit: number; exposure: number; available: number; over: boolean }>("get_client_credit_status", { id }),
  getNewsletterIncludeRanked: () => invoke<boolean>("get_newsletter_include_ranked"),
  setNewsletterIncludeRanked: (value: boolean) => invoke<void>("set_newsletter_include_ranked", { value }),
  getNewsletterUnsubscribeEnabled: () => invoke<boolean>("get_newsletter_unsubscribe_enabled"),
  setNewsletterUnsubscribeEnabled: (value: boolean) => invoke<void>("set_newsletter_unsubscribe_enabled", { value }),
  approveClient: (id: string) =>
    invoke<void>("approve_client", { id }),
  rejectClient: (id: string) =>
    invoke<void>("reject_client", { id }),
  getPendingApprovals: () =>
    invoke<Client[]>("get_pending_approvals"),
  bulkDeleteClients: (ids: string[]) =>
    invoke<number>("bulk_delete_clients", { ids }),
  bulkUpdateCategory: (ids: string[], category: string) =>
    invoke<number>("bulk_update_category", { ids, category }),
  bulkUpdateLeadStatus: (ids: string[], leadStatus: string) =>
    invoke<number>("bulk_update_lead_status", { ids, leadStatus }),
  exportClientsCsv: (ids: string[], outputPath: string) =>
    invoke<number>("export_clients_csv", { ids, outputPath }),
  exportInvoicesCsv: (outputPath: string) =>
    invoke<number>("export_invoices_csv", { outputPath }),
  exportDealsCsv: (outputPath: string) =>
    invoke<number>("export_deals_csv", { outputPath }),
  exportDealFlowsCsv: (outputPath: string) =>
    invoke<number>("export_deal_flows_csv", { outputPath }),
  exportInventoryCsv: (statusFilter: string | null, outputPath: string) =>
    invoke<number>("export_inventory_csv", { statusFilter, outputPath }),
  exportAnalyticsXlsx: (outputPath: string) =>
    invoke<void>("export_analytics_xlsx", { outputPath }),

  // Interactions
  listInteractions: (clientId: string) =>
    invoke<Interaction[]>("list_interactions", { clientId }),
  addInteraction: (input: { client_id: string; kind: string; subject?: string; body?: string }) =>
    invoke<string>("add_interaction", { input }),

  // Invoices
  listInvoices: () => invoke<Invoice[]>("list_invoices"),
  getInvoice: (id: string) => invoke<Invoice>("get_invoice", { id }),
  listInvoicesForClient: (clientId: string) => invoke<Invoice[]>("list_invoices_for_client", { clientId }),
  createInvoice: (input: InvoiceInput) => invoke<string>("create_invoice", { input }),
  // `return_policy` omitted (undefined) means "leave the stored clause alone" — it is NOT
  // the same as "", which explicitly clears it. See the merge-on-write rule in R-162.
  updateInvoice: (id: string, input: { due_date: string; line_items: LineItem[]; tax_rate: number; notes?: string; recurring?: string; return_policy?: string }) =>
    invoke<void>("update_invoice", { id, input }),
  deleteInvoice: (id: string) => invoke<void>("delete_invoice", { id }),
  generateInvoicePdf: (invoiceId: string) =>
    invoke<string>("generate_invoice_pdf", { invoiceId }),
  openInvoicePdf: (invoiceId: string) => invoke<string>("open_invoice_pdf", { invoiceId }),
  previewInvoicePdf: (input: InvoiceInput) =>
    invoke<string>("preview_invoice_pdf", { input }),
  sendInvoice: (invoiceId: string) => invoke<void>("send_invoice", { invoiceId }),

  // Quotes
  listQuotes: () => invoke<Quote[]>("list_quotes"),
  listQuotesForClient: (clientId: string) => invoke<Quote[]>("list_quotes_for_client", { clientId }),
  getQuote: (id: string) => invoke<Quote>("get_quote", { id }),
  createQuote: (input: QuoteInput) => invoke<string>("create_quote", { input }),
  updateQuote: (id: string, input: QuoteInput) => invoke<void>("update_quote", { id, input }),
  deleteQuote: (id: string) => invoke<void>("delete_quote", { id }),
  setQuoteStatus: (id: string, status: string) => invoke<void>("set_quote_status", { id, status }),
  generateQuotePdf: (quoteId: string) => invoke<string>("generate_quote_pdf", { quoteId }),
  sendQuote: (quoteId: string, thread?: boolean) => invoke<void>("send_quote", { quoteId, thread: thread ?? false }),
  markQuoteConverted: (quoteId: string, invoiceId: string) => invoke<void>("mark_quote_converted", { quoteId, invoiceId }),
  getQuoteNumberingConfig: () => invoke<InvoiceNumberingConfig>("get_quote_numbering_config"),
  saveQuoteNumberingConfig: (prefix: string, nextNumber: number, padding: number) =>
    invoke<void>("save_quote_numbering_config", { prefix, nextNumber, padding }),

  // Release letter — one-page closeout authorization PDF on our invoice branding.
  generateReleaseLetter: (input: ReleaseLetterInput) =>
    invoke<string>("generate_release_letter", { input }),
  // Client statement / receipt (R-190) — many deals, one client, one PDF.
  clientStatementData: (clientId: string) =>
    invoke<StatementData>("client_statement_data", { clientId }),
  generateClientStatement: (input: StatementInput) =>
    invoke<string>("generate_client_statement", { input }),
  /** Merge-on-write: an omitted field is left alone, never NULLed over. */
  saveStatementClientFills: (clientId: string, fills: {
    email?: string; streetAddress?: string; city?: string;
    state?: string; zipCode?: string; country?: string;
  }) => invoke<void>("save_statement_client_fills", { clientId, ...fills }),
  markInvoicePaid: (invoiceId: string, paidDate: string, paymentMethodLabel?: string, paymentReference?: string) =>
    invoke<void>("mark_invoice_paid", { invoiceId, paidDate, paymentMethodLabel, paymentReference }),
  // Void / un-void an invoice ("deal fell through"). Voided invoices drop out of
  // receivables and owed totals; nothing is deleted, so it can be reversed.
  setInvoiceVoid: (invoiceId: string, voided: boolean) =>
    invoke<void>("set_invoice_void", { invoiceId, void: voided }),
  saveInvoiceCosts: (invoiceId: string, costItems: CostItem[]) =>
    invoke<void>("save_invoice_costs", { invoiceId, costItems }),
  saveInvoiceShipping: (invoiceId: string, info: ShippingInfo) =>
    invoke<void>("save_invoice_shipping", { invoiceId, info }),
  setInvoiceSentDate: (invoiceId: string, sentDate: string) =>
    invoke<void>("set_invoice_sent_date", { invoiceId, sentDate }),

  // Invoice numbering
  getInvoiceNumberingConfig: () => invoke<InvoiceNumberingConfig>("get_invoice_numbering_config"),
  saveInvoiceNumberingConfig: (prefix: string, nextNumber: number, padding: number) =>
    invoke<void>("save_invoice_numbering_config", { prefix, nextNumber, padding }),

  // Recurring Invoices
  listRecurringInvoices: () => invoke<RecurringInvoice[]>("list_recurring_invoices"),
  createRecurringInvoice: (input: RecurringInvoiceInput) => invoke<string>("create_recurring_invoice", { input }),
  updateRecurringInvoice: (id: string, input: RecurringInvoiceInput) => invoke<void>("update_recurring_invoice", { id, input }),
  pauseRecurringInvoice: (id: string) => invoke<void>("pause_recurring_invoice", { id }),
  resumeRecurringInvoice: (id: string) => invoke<void>("resume_recurring_invoice", { id }),
  deleteRecurringInvoice: (id: string) => invoke<void>("delete_recurring_invoice", { id }),

  // Payments
  listPayments: (invoiceId?: string) => invoke<Payment[]>("list_payments", { invoiceId: invoiceId ?? null }),
  getPayment: (id: string) => invoke<Payment | null>("get_payment", { id }),
  createPaymentRequest: (invoiceId: string) => invoke<Payment>("create_payment_request", { invoiceId }),
  updatePaymentStatus: (id: string, status: string, stripeId?: string | null) =>
    invoke<void>("update_payment_status", { id, status, stripeId: stripeId ?? null }),
  markPaymentFailed: (id: string, error: string) => invoke<void>("mark_payment_failed", { id, error }),
  refundPayment: (id: string, reason?: string | null) => invoke<void>("refund_payment", { id, reason: reason ?? null }),
  saveStripeKeys: (publishable: string, secret: string, webhookSecret: string) =>
    invoke<void>("save_stripe_keys", { publishable, secret, webhookSecret }),
  getStripeConfig: () => invoke<StripeConfigStatus>("get_stripe_config"),
  deleteStripeKeys: () => invoke<void>("delete_stripe_keys"),

  // Deals
  listDeals: () => invoke<Deal[]>("list_deals"),
  listDealsByStage: (stage: string) => invoke<Deal[]>("list_deals_by_stage", { stage }),
  getDeal: (id: string) => invoke<Deal>("get_deal", { id }),
  createDeal: (input: DealInput) => invoke<string>("create_deal", { input }),
  updateDeal: (id: string, input: DealInput) => invoke<void>("update_deal", { id, input }),
  updateDealStage: (id: string, stage: string, lostReason?: string) =>
    invoke<void>("update_deal_stage", { id, stage, lostReason }),
  deleteDeal: (id: string) => invoke<void>("delete_deal", { id }),
  convertDealToInvoice: (dealId: string) => invoke<string>("convert_deal_to_invoice", { dealId }),
  supplierNameSuggestions: () => invoke<SupplierNameSuggestion[]>("supplier_name_suggestions"),

  // Deal Flows
  createDealFlow: (invoiceId: string, notes?: string | null, name?: string | null) =>
    invoke<string>("create_deal_flow", { invoiceId, notes, name }),
  getDealFlowByInvoice: (invoiceId: string) =>
    invoke<DealFlow | null>("get_deal_flow_by_invoice", { invoiceId }),
  getDealFlow: (id: string) => invoke<DealFlow>("get_deal_flow", { id }),
  listDealFlows: () => invoke<DealFlow[]>("list_deal_flows"),
  listDealFlowsByStage: (stage: string) => invoke<DealFlow[]>("list_deal_flows_by_stage", { stage }),
  markPaymentReceived: (id: string, input: PaymentReceivedInput) =>
    invoke<void>("mark_payment_received", { id, input }),
  unmarkPaymentReceived: (id: string) =>
    invoke<void>("unmark_payment_received", { id }),
  setDeposit: (id: string, amount: number) =>
    invoke<void>("set_deposit", { id, amount }),
  addSupplierPayment: (id: string, input: SupplierPaymentInput) =>
    invoke<string>("add_supplier_payment", { id, input }),
  updateSupplierPayment: (id: string, paymentId: string, input: SupplierPaymentInput) =>
    invoke<void>("update_supplier_payment", { id, paymentId, input }),
  removeSupplierPayment: (id: string, paymentId: string) =>
    invoke<void>("remove_supplier_payment", { id, paymentId }),
  markSupplierPaymentPaid: (id: string, paymentId: string) =>
    invoke<void>("mark_supplier_payment_paid", { id, paymentId }),
  unmarkSupplierPaymentPaid: (id: string, paymentId: string) =>
    invoke<void>("unmark_supplier_payment_paid", { id, paymentId }),
  setSupplierPaymentKept: (id: string, paymentId: string, kept: boolean) =>
    invoke<void>("set_supplier_payment_kept", { id, paymentId, kept }),
  /** R-154 shipping lifecycle. Writes all five deal_flows columns in one upsert,
   *  and keeps the value a reschedule replaced in the matching `*_prev` column.
   *  Returns the refreshed deal. */
  setDealFlowShipping: (
    id: string, pickupDate: string | null, expectedDeliveryDate: string | null, shipsDirect: boolean,
  ) => invoke<DealFlow>("set_deal_flow_shipping", { id, pickupDate, expectedDeliveryDate, shipsDirect }),
  /** `overrideReason` is required only when the R-154 gate blocks — completing
   *  before the expected delivery (or, unset, the pickup) date. It is recorded on
   *  the deal with who overrode it and when. */
  completeDealFlow: (id: string, shippingStatus?: string | null, completedDate?: string | null, payoutIncluded?: boolean, overrideReason?: string | null) =>
    invoke<CompleteDealResult>("complete_deal_flow", { id, shippingStatus, completedDate, payoutIncluded, overrideReason }),
  uncompleteDealFlow: (id: string) => invoke<void>("uncomplete_deal_flow", { id }),
  recalcDealFromBank: (id: string) => invoke<any>("recalc_deal_from_bank", { id }),
  cleanupOrphanAllocations: () => invoke<number>("cleanup_orphan_allocations"),
  resyncAllCompletedDeals: () => invoke<number>("resync_all_completed_deals"),
  setDealLinkNa: (id: string, noBuyer: boolean, noSupplier: boolean) =>
    invoke<void>("set_deal_link_na", { id, noBuyer, noSupplier }),
  setRefundDone: (id: string, done: boolean) => invoke<void>("set_refund_done", { id, done }),
  setDealPayoutIncluded: (id: string, included: boolean) => invoke<void>("set_deal_payout_included", { id, included }),
  updateDealCompletedAt: (id: string, date: string) =>
    invoke<void>("update_deal_completed_at", { id, date }),
  updateDealFlowNotes: (id: string, notes: string | null) =>
    invoke<void>("update_deal_flow_notes", { id, notes }),
  updateDealFlowName: (id: string, name: string | null) =>
    invoke<void>("update_deal_flow_name", { id, name }),
  deleteDealFlow: (id: string) => invoke<void>("delete_deal_flow", { id }),
  // Mark a deal flow as "fell through" — voids its linked invoice and drops it
  // from the pipeline. Reversible via the Archive.
  setDealFlowFellThrough: (dealFlowId: string, fellThrough: boolean) =>
    invoke<void>("set_deal_flow_fell_through", { dealFlowId, fellThrough }),

  // Archive — soft-deleted invoices/deals/deal-flows, restorable.
  listArchive: () => invoke<ArchiveItem[]>("list_archive"),
  restoreArchived: (kind: ArchiveItem["kind"], id: string) =>
    invoke<void>("restore_archived", { kind, id }),
  recoverDeletedFromBackups: () =>
    invoke<{ deal_flows: number; invoices: number }>("recover_deleted_from_backups"),

  // Data safety (superadmin) — scan for cross-device integrity anomalies + converge one
  // to deleted everywhere via the sync path.
  scanDataIntegrity: () => invoke<IntegrityItem[]>("scan_data_integrity"),
  /// Writes this device permanently stopped trying to deliver. The local row is
  /// still correct here; what failed is reaching the server and the other devices.
  listStrandedWrites: () => invoke<StrandedWrite[]>("list_stranded_writes"),
  /// Does the ledger still tie out to the bank? Pass `rebaseline` to accept the
  /// current figures as correct after a deliberate change (cleanup, re-pull).
  reconcileAccounts: (rebaseline = false) => invoke<ReconAccount[]>("reconcile_accounts", { rebaseline }),
  convergeIntegrityItem: (kind: IntegrityItem["kind"], id: string) =>
    invoke<string[]>("converge_integrity_item", { kind, id }),

  // Profit Split
  getProfitSplit: () => invoke<ProfitSplit>("get_profit_split"),
  saveProfitSplit: (businessPct: number, jackPct: number, benPct: number, jackName: string, benName: string) =>
    invoke<void>("save_profit_split", { businessPct, jackPct, benPct, jackName, benName }),

  // Brief frequency + organization name (settings-backed, synced)
  getBriefFrequency: () => invoke<number>("get_brief_frequency"),
  setBriefFrequency: (days: number) => invoke<void>("set_brief_frequency", { days }),
  getOrganizationName: () => invoke<string>("get_organization_name"),
  setOrganizationName: (name: string) => invoke<void>("set_organization_name", { name }),

  // ── Unified accounts + RBAC (synced with web/mobile) ──
  employeeStatus: () => invoke<{ has_accounts: boolean; signed_in: boolean }>("employee_status"),
  employeeMe: () => invoke<Me | null>("employee_me"),
  localIsSuperadmin: () => invoke<boolean>("local_is_superadmin"),
  updateMyAccount: (p: { display_name?: string; title?: string; phone?: string; avatar?: string }) =>
    invoke<Me>("update_my_account", p),
  employeeLogout: () => invoke<void>("employee_logout"),
  employeeBootstrap: (displayName: string, email: string, password: string) =>
    invoke<Me>("employee_bootstrap", { displayName, email, password }),
  employeeLogin: (email: string, password: string) =>
    invoke<Me>("employee_login", { email, password }),
  // Unified sign-in: local-first, then server-hub sync (falls back to server auth
  // for a website-created account on a fresh device). See employees::login.
  login: (email: string, password: string) =>
    invoke<Me>("login", { email, password }),
  // Team management (admin only)
  listStaff: () => invoke<StaffMember[]>("list_staff"),
  updateStaff: (id: string, fields: Partial<{ roleId: string; status: string; commissionPct: number; hidePayCuts: boolean; payType: string }>) =>
    invoke<void>("update_staff", { id, ...fields }),

  // Refunds, customer credits, rep payouts
  createRefund: (dealFlowId: string, amount: number, opts?: { method?: string; source?: string; sourceSupplierRef?: string; keepRepCut?: boolean; reason?: string; bankTxnId?: string }) =>
    invoke<string>("create_refund", { dealFlowId, amount, ...(opts || {}) }),
  listRefunds: (dealFlowId: string) => invoke<RefundRow[]>("list_refunds", { dealFlowId }),
  /** Set what's owed back to the buyer. `opts` records the short-shipment behind
   *  it (R-163): the unit shortfall and what the supplier owes us for those units,
   *  saved in the same call so the deal never sits in a state where units say
   *  short and the money says nothing is owed. Omitting `opts` leaves both
   *  shortage columns exactly as they were. */
  setRefundOwed: (dealFlowId: string, amount: number, opts?: { shortageUnits?: number; supplierRefundOwed?: number }) =>
    invoke<void>("set_refund_owed", { dealFlowId, amount, ...(opts || {}) }),
  deleteRefund: (id: string) => invoke<void>("delete_refund", { id }),
  // Money received on a deal that isn't in the bank feed (custom lines). Bank-linked
  // receipts use allocateBankTxn(role="buyer_payment"); these are the manual side.
  addDealReceipt: (dealFlowId: string, amount: number, label?: string) =>
    invoke<string>("add_deal_receipt", { dealFlowId, amount, label }),
  listDealReceipts: (dealFlowId: string) =>
    invoke<DealReceipt[]>("list_deal_receipts", { dealFlowId }),
  deleteDealReceipt: (id: string) => invoke<void>("delete_deal_receipt", { id }),
  dealFlowPayout: (dealFlowId: string) => invoke<any>("deal_flow_payout", { dealFlowId }),
  listDealReps: () => invoke<{ id: string; display_name: string }[]>("list_deal_reps"),
  setDealLeadRep: (dealFlowId: string, leadRepId: string | null) => invoke<void>("set_deal_lead_rep", { dealFlowId, leadRepId }),
  addClientCredit: (clientId: string, amount: number, opts?: { kind?: string; note?: string; sourceDealFlowId?: string; appliedDealFlowId?: string }) =>
    invoke<string>("add_client_credit", { clientId, amount, ...(opts || {}) }),
  getClientCredit: (clientId: string) => invoke<any>("get_client_credit", { clientId }),
  listRepPayouts: (start?: string, end?: string) => invoke<any>("list_rep_payouts", { start, end }),
  markRepPayoutPaid: (repId: string, periodStart: string, periodEnd: string, amount: number) =>
    invoke<string>("mark_rep_payout_paid", { repId, periodStart, periodEnd, amount }),
  getRepPayoutSettings: () => invoke<any>("get_rep_payout_settings"),
  getShopifyConfig: () => invoke<any>("get_shopify_config"),
  getPayoutSplit: () => invoke<{ name: string; pct: number; is_business: boolean; kind?: string }[]>("get_payout_split"),
  savePayoutSplit: (shares: { name: string; pct: number; is_business: boolean; kind?: string }[]) => invoke<void>("save_payout_split", { shares }),
  setShopifySecret: (secret: string) => invoke<void>("set_shopify_secret", { secret }),
  createIntakeSource: (name: string) => invoke<any>("create_intake_source", { name }),
  listIntakeSources: () => invoke<any[]>("list_intake_sources"),
  saveIntakeMapping: (id: string, mappingJson: string) => invoke<void>("save_intake_mapping", { id, mappingJson }),
  deleteIntakeSource: (id: string) => invoke<void>("delete_intake_source", { id }),
  getIntakeFields: () => invoke<{ value: string; label: string }[]>("get_intake_fields"),
  setRepPayoutSettings: (fields: Partial<{ enabled: boolean; period: string; anchor: string; customDays: number }>) =>
    invoke<void>("set_rep_payout_settings", { ...fields }),
  deleteStaff: (id: string) => invoke<void>("delete_staff", { id }),
  listRoles: () => invoke<{ roles: RoleDef[]; modules: string[] }>("list_roles"),
  createRole: (name: string) => invoke<RoleDef>("create_role", { name }),
  updateRole: (id: string, permissions: string[]) => invoke<void>("update_role", { id, permissions }),
  // Admin approval queue (rep client add/delete requests)
  listApprovalRequests: () => invoke<ApprovalRequest[]>("list_approval_requests"),
  approvalRequestsCount: () => invoke<number>("approval_requests_count"),
  resolveApprovalRequest: (id: string, approve: boolean) => invoke<void>("resolve_approval_request", { id, approve }),
  getApprovalPolicy: () => invoke<{ require_client_add_approval: boolean; require_client_delete_approval: boolean }>("get_approval_policy"),
  setApprovalPolicy: (requireAdd: boolean, requireDelete: boolean) => invoke<void>("set_approval_policy", { requireAdd, requireDelete }),
  submitFeedback: (kind: string, title: string, body: string, name?: string, email?: string) =>
    invoke<void>("submit_feedback", { kind, title, body, name, email }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  // Custom lead forms
  listForms: () => invoke<FormDef[]>("list_forms"),
  saveForm: (f: { id?: string; name: string; title: string; intro: string; fields_json: string; active: boolean }) =>
    invoke<string>("save_form", f),
  deleteForm: (id: string) => invoke<void>("delete_form", { id }),
  // Checkup sessions
  createCheckup: (name?: string, category?: string) => invoke<{ id: string; total: number }>("create_checkup", { name, category }),
  listCheckups: () => invoke<CheckupSession[]>("list_checkups"),
  getCheckup: (id: string) => invoke<CheckupDetail>("get_checkup", { id }),
  setCheckupItemStage: (sessionId: string, itemId: string, stage: number, note: string) =>
    invoke<void>("set_checkup_item_stage", { sessionId, itemId, stage, note }),
  deleteCheckup: (id: string) => invoke<void>("delete_checkup", { id }),
  setCheckupVisibility: (visibility: string) => invoke<void>("set_checkup_visibility", { visibility }),
  listInvites: () => invoke<InviteRow[]>("list_invites"),
  createInvite: (roleId: string, email: string | null, expiresDays: number | null) =>
    invoke<{ token: string; signup_path: string; expires_at: string }>("create_invite", { roleId, email, expiresDays }),
  revokeInvite: (token: string) => invoke<void>("revoke_invite", { token }),
  reopenInvite: (token: string) => invoke<{ token: string; expires_at: string }>("reopen_invite", { token }),

  // Suppliers
  listSuppliers: () => invoke<Supplier[]>("list_suppliers"),
  getSupplier: (id: string) => invoke<Supplier>("get_supplier", { id }),
  createSupplier: (input: SupplierInput) => invoke<string>("create_supplier", { input }),
  updateSupplier: (id: string, input: SupplierInput) => invoke<void>("update_supplier", { id, input }),
  archiveSupplier: (id: string) => invoke<void>("archive_supplier", { id }),
  deleteSupplier: (id: string) => invoke<void>("delete_supplier", { id }),
  searchSuppliers: (query: string) => invoke<Supplier[]>("search_suppliers", { query }),
  getSupplierPriceHistory: (supplierId: string) =>
    invoke<SupplierPriceEntry[]>("get_supplier_price_history", { supplierId }),
  recordSupplierPrice: (supplierId: string, itemDescription: string, price: number, quantity?: number | null, dealFlowId?: string | null, notes?: string | null) =>
    invoke<void>("record_supplier_price", { supplierId, itemDescription, price, quantity, dealFlowId, notes }),
  checkPriceChanges: (dealFlowId: string) => invoke<PriceAlert[]>("check_price_changes", { dealFlowId }),
  revertSupplierPriceChange: (id: string, paymentId: string) =>
    invoke<void>("revert_supplier_price_change", { id, paymentId }),
  getDealFlowNodeMap: (dealFlowId: string) => invoke<DealFlowNodeMap>("get_deal_flow_node_map", { dealFlowId }),

  // ── The dual-role party link (R-175 / R-153) ──────────────────────────────
  // `linked_party_id` shipped on both `clients` and `suppliers` in v0.16.1 with
  // no readers and no writers. These are the readers and the writer.
  // A LINK, not a merge: the two records stay separate everywhere, and what we
  // pay them (cost) is never netted against what they pay us (revenue).
  //
  // The command names here are NOT `get_party_link`/`set_party_link`. Those were
  // never registered and every call rejected, unseen, through eleven published
  // tags. The Rust half is `link_party`, `unlink_party` and `linked_party_payments`
  // (main.rs, defined in commands.rs), whose first argument is `ctype`, not `ptype`.
  //
  // Callers MUST still tolerate a rejection — a build that predates the Rust half
  // has none of these — and the surface is expected to hide itself rather than
  // offer a control that cannot work.
  //
  // The getter is built from `linked_party_payments`, which is the only reader:
  // it takes the identity half of the envelope and drops both payment lists, which
  // the profile fetches per side so that nothing can arrive pre-combined.
  getPartyLink: async (ctype: "client" | "supplier", id: string): Promise<PartyLink | null> => {
    const r = await invoke<LinkedPartyEnvelope>("linked_party_payments", { ctype, id });
    if (r.linked) {
      return { linked_id: r.linked.id, linked_name: r.linked.name, linked_type: r.linked.ctype };
    }
    // Linked to a row this device has not pulled yet. Not an error and not "no
    // link" — the pointer is real, so the caller is told, and there is no name to
    // show because there is no row here to read one from.
    if (r.link_pending) {
      return { linked_id: "", linked_name: "", linked_type: ctype === "client" ? "supplier" : "client", link_pending: true };
    }
    return null;
  },
  /** `linkedId` null clears the link. Writes BOTH sides — a one-sided pointer is
   *  a link only one profile can see. Two commands, because `link_party` has no
   *  null path: clearing is `unlink_party`, which takes no counterpart at all. */
  setPartyLink: (ctype: "client" | "supplier", id: string, linkedId: string | null) =>
    linkedId === null
      ? invoke<void>("unlink_party", { ctype, id })
      : invoke<void>("link_party", { ctype, id, otherId: linkedId }),

  buyerTiers: () => invoke<BuyerTier[]>("buyer_tiers"),
  getBuyerTier: (clientId: string) => invoke<BuyerTier>("get_buyer_tier", { clientId }),
  generateWeeklyBrief: (forDate?: string | null, repName?: string | null) => invoke<WeeklyBrief>("generate_weekly_brief", { forDate: forDate ?? null, repName }),
  detectDuplicateClients: () => invoke<DuplicateGroup[]>("detect_duplicate_clients"),
  cleanupClients: () => invoke<{ duplicates_merged: number; ghosts_removed: number; remaining_clients: number }>("cleanup_clients"),

  // Email
  sendEmail: (to: string, subject: string, body: string, attachmentPath?: string) =>
    invoke<void>("send_email", { to, subject, body, attachmentPath }),
  scanInbox: () => invoke<ParsedEmail[]>("scan_inbox"),
  getEmailInboxes: () => invoke<EmailInbox[]>("get_email_inboxes"),
  /** `readFromNow` (default true) starts a NEW mailbox at its current head instead
   *  of importing its entire history as activity dated today. */
  saveEmailInbox: (p: { id?: string; label: string; host: string; port: number; user: string; password?: string; scope?: "org" | "me"; readFromNow?: boolean }) =>
    invoke<string>("save_email_inbox", p),
  deleteEmailInbox: (id: string) => invoke<void>("delete_email_inbox", { id }),
  /** Launch Google consent for ONE mailbox. Its owner signs in as themselves; no
   *  password is ever created. Reuses the primary account's Google client. */
  oauthStartConsentForInbox: (inboxId: string, clientId = "", clientSecret = "") =>
    invoke<void>("oauth_start_consent_for_inbox", { inboxId, clientId, clientSecret }),
  inboxGoogleConnected: (inboxId: string) => invoke<boolean>("inbox_google_connected", { inboxId }),
  // Org-shared vs personal send config (this device's choice).
  getEmailUseOrgDefault: () => invoke<boolean>("get_email_use_org_default"),
  setEmailUseOrgDefault: (on: boolean) => invoke<void>("set_email_use_org_default", { on }),
  // Reassign the shared inbox to a different email admin.
  transferOrgInbox: (targetStaffId: string) => invoke<void>("transfer_org_inbox", { targetStaffId }),
  // Live connection tests + Google OAuth status (Settings → Email).
  testSmtpConnection: () => invoke<{ ok: boolean; message: string }>("test_smtp_connection"),
  testInboxConnection: (id: string) => invoke<{ ok: boolean; message: string }>("test_inbox_connection", { id }),
  googleEmailStatus: () => invoke<{ connected: boolean; email: string; scopes: string }>("google_email_status"),
   oauthStartConsent: (clientId: string, clientSecret: string) =>
    invoke<void>("oauth_start_consent", { clientId, clientSecret }),
  googleContactsOauthStart: (clientId: string, clientSecret: string) =>
    invoke<void>("google_contacts_oauth_start", { clientId, clientSecret }),
  googleContactsList: () =>
    invoke<GoogleContact[]>("google_contacts_list"),
  googleContactsImport: (contacts: GoogleContact[]) =>
    invoke<ImportSummary>("google_contacts_import", { contacts }),

  // Email Drafts
  listDrafts: (status?: string) => invoke<EmailDraft[]>("list_drafts", { status }),
  updateDraft: (id: string, body: string, subject: string) =>
    invoke<void>("update_draft", { id, body, subject }),
  sendDraft: (id: string) => invoke<void>("send_draft", { id }),
  discardDraft: (id: string) => invoke<void>("discard_draft", { id }),

  // AI
  aiDraftReply: (emailBody: string, context?: string, tone?: string) =>
    invoke<string>("ai_draft_reply", { emailBody, context, tone }),
  aiExtractData: (emailBody: string) => invoke<any>("ai_extract_data", { emailBody }),
  aiSuggestInvoice: (description: string) =>
    invoke<{ items: LineItem[]; suggested_due_days: number }>("ai_suggest_invoice", {
      description,
    }),
  aiSummarizeHistory: (clientId: string) =>
    invoke<string>("ai_summarize_history", { clientId }),
  aiHealthCheck: () => invoke<boolean>("ai_health_check"),
  aiListModels: () => invoke<OllamaModel[]>("ai_list_models"),
  aiSetModel: (model: string) => invoke<void>("ai_set_model", { model }),

  // Paste-to-load: parse a supplier load message (+ optional image) into lot fields
  parseLoad: (text: string, imageBase64?: string | null, imageMediaType?: string | null) =>
    invoke<ParsedLoad>("parse_load", { text, imageBase64: imageBase64 ?? null, imageMediaType: imageMediaType ?? null }),
  // Multi-load: parse a pasted blob (several messages) into a list of lot fields.
  parseLoads: (text: string, imageBase64?: string | null, imageMediaType?: string | null) =>
    invoke<ParsedLoad[]>("parse_loads", { text, imageBase64: imageBase64 ?? null, imageMediaType: imageMediaType ?? null }),
  loadAiStatus: () => invoke<boolean>("load_ai_status"),

  // Load inbox — supplier posts forwarded from a phone, waiting for approval.
  // `server` is the base URL the inbound photos are served from.
  getLoadInbox: () => invoke<{ token: string; url: string | null; server: string | null }>("get_load_inbox"),
  listInboundLoads: () => invoke<InboundLoad[]>("list_inbound_loads"),
  approveInboundLoad: (id: string, lots: ApproveLotInput[]) => invoke<string[]>("approve_inbound_load", { id, lots }),
  rejectInboundLoad: (id: string) => invoke<void>("reject_inbound_load", { id }),
  setAnthropicKey: (key: string) => invoke<void>("set_anthropic_key", { key }),

  // Public storefront config
  getStorefrontConfig: () => invoke<StorefrontConfig>("get_storefront_config"),
  saveStorefrontConfig: (c: Omit<StorefrontConfig, "token" | "url">) =>
    invoke<StorefrontConfig>("save_storefront_config", {
      enabled: c.enabled, showPrices: c.show_prices, showLogo: c.show_logo,
      title: c.title, subtitle: c.subtitle, contactWa: c.contact_wa, contactEmail: c.contact_email, accent: c.accent, bg: c.bg,
    }),

  // Settings
  saveCredential: (key: string, value: string) =>
    invoke<void>("save_credential", { key, value }),
  deleteCredential: (key: string) => invoke<void>("delete_credential", { key }),
  saveEmailSettings: (settings: EmailSettings, scope: "org" | "me" = "org") =>
    invoke<void>("save_email_settings", { settings, scope }),
  sendTestEmail: () => invoke<string>("send_test_email"),
  getEmailSettings: () => invoke<EmailSettings | null>("get_email_settings"),
  saveCompanyInfo: (info: CompanyInfo) => invoke<void>("save_company_info", { info }),
  getCompanyInfo: () => invoke<CompanyInfo | null>("get_company_info"),
  // Invoice branding template + sample render (backend opens the PDF and returns its path).
  getInvoiceTemplate: () => invoke<InvoiceTemplate>("get_invoice_template"),
  saveInvoiceTemplate: (template: InvoiceTemplate) => invoke<void>("save_invoice_template", { template }),
  renderSampleInvoicePdf: () => invoke<string>("render_sample_invoice_pdf"),
  getQuoteTemplate: () => invoke<InvoiceTemplate>("get_quote_template"),
  saveQuoteTemplate: (template: InvoiceTemplate) => invoke<void>("save_quote_template", { template }),
  renderSampleQuotePdf: () => invoke<string>("render_sample_quote_pdf"),

  getOnboardingStatus: () => invoke<boolean>("get_onboarding_status"),
  completeOnboarding: () => invoke<void>("complete_onboarding"),

  // Backup
  backupDatabase: (dir?: string) => invoke<string>("backup_database", { customDir: dir ?? null }),
  restoreDatabase: (path: string) => invoke<void>("restore_database", { path }),
  listBackups: () => invoke<{ filename: string; size: number; date: string; is_valid: boolean }[]>("list_backups"),
  getBackupStatus: () => invoke<{ last_backup: string | null; backup_dir: string }>("get_backup_status"),

  // Sync
  syncReplay: () => invoke<number>("sync_replay"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncSetPassphrase: (passphrase: string) =>
    invoke<void>("sync_set_passphrase", { passphrase }),
  syncIsEncrypted: () => invoke<boolean>("sync_is_encrypted"),

  // Network sync (Phase 2 — central server push/pull)
  netsyncStatus: () =>
    invoke<{ connected: boolean; url: string; pending_push: number; pull_cursor: number;
             auth: "ok" | "auth_lost" | "offline"; last_pull_at: string; last_push_at: string;
             invariants: string[]; invariants_at: string }>("netsync_status"),
  netsyncConnect: (url: string, email: string, password: string) =>
    invoke<void>("netsync_connect", { url, email, password }),
  netsyncDisconnect: () => invoke<void>("netsync_disconnect"),
  netsyncSyncNow: () => invoke<{ pushed: number; pulled: number }>("netsync_sync_now"),
  netsyncRepair: () => invoke<{ reapplied: number; pushed: number }>("netsync_repair"),
  netsyncRepairHard: () => invoke<{ reapplied: number; pushed: number }>("netsync_repair_hard"),
  netsyncRestoreSnapshot: () => invoke<Record<string, number>>("netsync_restore_snapshot"),
  netsyncDiagnostics: () => invoke<{
    version: string; connected: boolean; url: string; email: string; org: string;
    pull_cursor: number; local_counts: Record<string, number>;
    server_counts: Record<string, number> | null;
  }>("netsync_diagnostics"),
  getMyPlan: () => invoke<{ name: string; plan: string; members: number; member_limit: number | null; clients: number; client_limit: number | null; is_superadmin: boolean }>("get_my_plan"),
  getPlatformSignups: () => invoke<{ orgs: any[] }>("get_platform_signups"),
  // Superadmin admin console
  adminWaitlistAll: () =>
    invoke<{ id: string; first_name: string; email: string; features: string; created_at: string }[]>("admin_waitlist_all"),
  adminFeedbackAll: () =>
    invoke<{ id: string; org_id: string | null; submitter_name: string | null; submitter_email: string | null; kind: string; title: string; body: string; app: string; status: string; created_at: string }[]>("admin_feedback_all"),
  adminSetOrgPlan: (orgId: string, plan: string) =>
    invoke<{ ok: boolean }>("admin_set_org_plan", { orgId, plan }),
  adminDeleteWorkspace: (orgId: string) =>
    invoke<{ ok: boolean; deleted: string }>("admin_delete_workspace", { orgId }),
  adminOnboarding: () =>
    invoke<{ orgs: { org_id: string; name: string; plan: string; created_at: string | null; members: number; has_client: boolean; has_invoice: boolean; has_inventory: boolean; email_configured: boolean }[] }>("admin_onboarding"),
  adminPlatformUsers: () =>
    invoke<{ users: { id: string; email: string; display_name: string | null; org_id: string; org_name: string; plan: string; role: string; status: string; created_at: string | null; org_clients: number; org_invoices: number }[] }>("admin_platform_users"),
  adminBroadcastPreview: (includeAccounts: boolean, includeWaitlist: boolean) =>
    invoke<{ recipients: number; emails: string[] }>("admin_broadcast_preview", { includeAccounts, includeWaitlist }),
  adminBroadcastSend: (subject: string, body: string, includeAccounts: boolean, includeWaitlist: boolean, emails?: string[]) =>
    invoke<{ ok: boolean; id: string; recipients: number }>("admin_broadcast_send", { subject, body, includeAccounts, includeWaitlist, emails: emails ?? null }),
  adminBroadcastTest: (subject?: string, body?: string) =>
    invoke<{ ok: boolean; to: string }>("admin_broadcast_test", { subject: subject ?? null, body: body ?? null }),
  netsyncWhoami: () =>
    invoke<{ email: string; org_id: string; display_name: string | null; is_superadmin: boolean }>("netsync_whoami"),

  // Sticky notes
  // Pull remote sync events now (near-live) — used by the shared notes board.
  pullNow: () => invoke<number>("pull_now"),
  // Acquire/release the advisory edit-lock on a note (who's editing it right now).
  setNoteEditing: (id: string, editing: boolean) => invoke<void>("set_note_editing", { id, editing }),
  listNotes: () => invoke<Note[]>("list_notes"),
  createNote: (body: string, color?: string, x?: number, y?: number) => invoke<Note>("create_note", { body, color, x, y }),
  updateNote: (id: string, patch: { body?: string; color?: string; pinned?: boolean; x?: number; y?: number; w?: number; h?: number; urgency?: string }) =>
    invoke<void>("update_note", { id, ...patch }),
  keepNote: (id: string) => invoke<void>("keep_note", { id }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),

  // Dashboard
  dashboardStats: () => invoke<DashboardStats>("dashboard_stats"),
  getMonthlyProfit: (month: string) => invoke<{ day: string; profit: number; revenue: number }[]>("get_monthly_profit", { month }),
  getReceivablesAging: () => invoke<ReceivablesAging>("get_receivables_aging"),
  getPayablesAging: () => invoke<PayablesAging>("get_payables_aging"),
  getAnalyticsRange: (startDate: string, endDate: string) => invoke<any>("get_analytics_range", { startDate, endDate }),
  getDealsForSupplier: (supplierId: string) => invoke<any[]>("list_deals_for_supplier", { supplierId }),
  dueFollowups: () => invoke<Client[]>("due_followups"),

  // CSV import
  csvPreview: (path: string) => invoke<CsvPreview>("csv_preview", { path }),
  csvImport: (path: string, mapping: ColumnMapping) =>
    invoke<ImportSummary>("csv_import", { path, mapping }),

  // Bank statement import (financial engine)
  bankPreview: (path: string) => invoke<BankPreview>("bank_preview", { path }),
  bankImport: (path: string, accountId: string) =>
    invoke<BankImportSummary>("bank_import", { path, accountId }),
  bankPreviewAi: (path: string) => invoke<BankAiPreview>("bank_preview_ai", { path }),
  bankImportAi: (path: string, accountId: string) =>
    invoke<BankAiImportResult>("bank_import_ai", { path, accountId }),
  // Plaid live bank/card feed
  plaidSetKeys: (clientId: string, secret: string, env: string) => invoke<void>("plaid_set_keys", { clientId, secret, env }),
  plaidHasKeys: () => invoke<boolean>("plaid_has_keys"),
  plaidConfig: () => invoke<{ has_keys: boolean; env: string }>("plaid_config"),
  plaidTestKeys: () => invoke<string>("plaid_test_keys"),
  plaidLinkToken: () => invoke<string>("plaid_link_token"),
  plaidConnectStart: () => invoke<{ hosted_link_url: string; link_token: string }>("plaid_connect_start"),
  plaidConnectPoll: (linkToken: string) =>
    invoke<{ status: string; institution?: string }>("plaid_connect_poll", { linkToken }),
  plaidExchange: (publicToken: string, institution: string) =>
    invoke<void>("plaid_exchange", { publicToken, institution }),
  plaidListItems: () => invoke<PlaidItem[]>("plaid_list_items"),
  plaidRemoveItem: (id: string) => invoke<void>("plaid_remove_item", { id }),
  plaidSync: () => invoke<PlaidSyncSummary>("plaid_sync"),
  plaidResyncAll: () => invoke<PlaidSyncSummary>("plaid_resync_all"),
  plaidRefreshSync: () => invoke<PlaidSyncSummary>("plaid_refresh_sync"),
  listBankTxns: () => invoke<BankTxn[]>("list_bank_txns"),
  bankTxnSummary: () => invoke<BankTxnSummary>("bank_txn_summary"),
  // Takes a patch, not a full row: only the fields present are written. Sync is
  // per-column last-write-wins, so sending a field you aren't changing re-stamps
  // it and can clobber another device's newer edit (a category change used to
  // un-book a reviewed txn this way).
  setBankTxnReview: (id: string, patch: BankTxnReviewPatch) =>
    invoke<void>("set_bank_txn_review", {
      id,
      category: patch.category,
      counterpartyName: patch.counterparty_name,
      counterpartyType: patch.counterparty_type,
      counterpartyId: patch.counterparty_id,
      confirmedMethod: patch.confirmed_method,
      reviewed: patch.reviewed,
    }),
  allocateBankTxn: (bankTxnId: string, dealFlowId: string, amount: number, role: string, note: string, allowSplit?: boolean) =>
    invoke<string>("allocate_bank_txn", { bankTxnId, dealFlowId, amount, role, note, allowSplit }),
  removeBankAllocation: (id: string) => invoke<void>("remove_bank_allocation", { id }),
  clearBankTxns: (scope: "statements" | "plaid" | "all", force = false) =>
    invoke<{ deleted: number; allocations_removed: number; kept: number }>("clear_bank_txns", { scope, force }),
  dedupeBankTxns: (dryRun: boolean, aggressive = false) =>
    invoke<DedupeResult>("dedupe_bank_txns", { dryRun, aggressive }),
  /** Delete hand-picked bank transactions. Booked rows are skipped, not silently removed. */
  deleteBankTxns: (ids: string[]) =>
    invoke<{ deleted: number; skipped_booked: number }>("delete_bank_txns", { ids }),
  getBankBackupSettings: () =>
    invoke<{ sheet_url: string; enabled: boolean; last_at: string; last_total: string }>("get_bank_backup_settings"),
  setBankBackupSettings: (sheetUrl: string, enabled: boolean) =>
    invoke<void>("set_bank_backup_settings", { sheetUrl, enabled }),
  backupBankTxnsNow: () =>
    invoke<{ added: number; total: number; at: string }>("backup_bank_txns_now"),
  listBankAllocationsForTxn: (bankTxnId: string) =>
    invoke<BankAllocation[]>("list_bank_allocations_for_txn", { bankTxnId }),
  dealAllocations: (dealFlowId: string) =>
    invoke<DealAllocation[]>("deal_allocations", { dealFlowId }),
  // Re-point allocations stranded on a duplicate deal_flow row onto the survivor
  // the deal view shows. Idempotent; returns how many were fixed.
  reattachOrphanedDealAllocations: () =>
    invoke<number>("reattach_orphaned_deal_allocations"),
  // Archive duplicate/orphan deal_flow rows (re-pointing allocations first) so
  // aggregates stop counting rows the UI hides. Idempotent; returns rows archived.
  cleanupGhostDealFlows: () =>
    invoke<number>("cleanup_ghost_deal_flows"),
  // Trim allocations that exceed their txn amount (concurrent-device double-book).
  // Idempotent; returns how many allocations were removed.
  healOverallocatedTxns: () =>
    invoke<number>("heal_overallocated_txns"),
  unallocatedBankTxns: (dealFlowId?: string) =>
    invoke<UnallocatedBankTxns>("unallocated_bank_txns", { dealFlowId }),
  addCashTransaction: (amount: number, direction: "in" | "out", postedAt: string, counterparty?: string, note?: string) =>
    invoke<string>("add_cash_transaction", { amount, direction, postedAt, counterparty: counterparty ?? null, note: note ?? null }),
  // A money line on a deal that never hit the bank statement (cash on the side, an
  // offset). Books a manual_cash transaction and allocates it to the leg in one go.
  addManualDealLine: (dealFlowId: string, role: "buyer_payment" | "supplier_payment" | "fee" | "refund_in", amount: number, postedAt?: string, counterparty?: string, note?: string) =>
    invoke<string>("add_manual_deal_line", { dealFlowId, role, amount, postedAt: postedAt ?? null, counterparty: counterparty ?? null, note: note ?? null }),
  dealReconciliation: (dealFlowId: string) =>
    invoke<DealReconciliation>("deal_reconciliation", { dealFlowId }),
  reconciliationStatusAll: () =>
    invoke<{ deal_flow_id: string; payment_received_paired: boolean; supplier_paid_paired: boolean; fully_reconciled: boolean; has_payment: boolean; has_financials: boolean; no_buyer_link: boolean; no_supplier_link: boolean; needs_financials: boolean; buyer_missing: boolean; supplier_missing: boolean; needs_review: boolean }[]>("reconciliation_status_all"),
  refundStatusAll: () =>
    invoke<{ deal_flow_id: string; refund_owed: number; refunded: number; remaining: number; done: boolean }[]>("refund_status_all"),
  getMoneyConfig: () => invoke<MoneyConfig>("get_money_config"),
  /// `publishManual` must be true ONLY when this device's manual balance is the figure
  /// actually in use here (Free Cash showing `balance_source === "manual"`). It is what
  /// stops a device that is displaying someone else's synced balance from republishing
  /// its own stale manual number over the live one.
  setMoneyConfig: (bankBalance: number, creditCardBalance: number, cashFloor: number, taxSweepPct: number, refundReservePct: number, warChest: number, publishManual = false) =>
    invoke<void>("set_money_config", { bankBalance, creditCardBalance, cashFloor, taxSweepPct, refundReservePct, warChest, publishManual }),
  financialsOverview: () => invoke<FinancialsOverview>("financials_overview"),
  aiCategorizeBankTxns: () => invoke<{ updated: number; remaining: number }>("ai_categorize_bank_txns"),
  listLoans: () => invoke<Loan[]>("list_loans"),
  createLoan: (name: string, lender: string, principal: number, receivedAt: string, bankTxnId: string, note: string) =>
    invoke<string>("create_loan", { name, lender, principal, receivedAt, bankTxnId, note }),
  updateLoan: (id: string, name: string, lender: string, principal: number, setAside: number, status: string, note: string, receivedAt?: string) =>
    invoke<void>("update_loan", { id, name, lender, principal, setAside, status, note, receivedAt }),
  /** Returns how many tagged transactions were untagged and returned to the queue. */
  deleteLoan: (id: string) => invoke<number>("delete_loan", { id }),
  tagBankTxnToLoan: (bankTxnId: string, loanId: string) =>
    invoke<void>("tag_bank_txn_to_loan", { bankTxnId, loanId }),
  untagBankTxnLoan: (bankTxnId: string) => invoke<void>("untag_bank_txn_loan", { bankTxnId }),
  loanLedger: (loanId: string) => invoke<LoanLedger>("loan_ledger", { loanId }),
  applyLoanRepaymentsToSetAside: (loanId: string) =>
    invoke<number>("apply_loan_repayments_to_set_aside", { loanId }),
  listTxnRules: () => invoke<TxnRule[]>("list_txn_rules"),
  // Rules are synced org-wide since v0.15.139. autoBook: matched transactions are
  // booked outright (category + reviewed) instead of only pre-filled — per-rule opt-in.
  createTxnRule: (matchCounterparty: string, category: string, targetType: "deal" | "loan" | "expense", targetId: string, role: string, direction: string, autoBook?: boolean) =>
    invoke<string>("create_txn_rule", { matchCounterparty, category, targetType, targetId, role, direction, autoBook: autoBook ?? false }),
  deleteTxnRule: (id: string) => invoke<void>("delete_txn_rule", { id }),
  setTxnRuleAuto: (id: string, autoBook: boolean) => invoke<void>("set_txn_rule_auto", { id, autoBook }),
  applyTxnRules: () => invoke<{ updated: number; auto_booked: number }>("apply_txn_rules"),
  // Smart linking (R-150): the server's read-only matching engine scores unbooked
  // transactions against deals (names, amounts, dates, invoice-number-in-memo) and
  // returns ranked candidates per txn. `source: "local"` means the server was
  // unreachable — the UI keeps its own matcher. Nothing here books money.
  // `counterparty_candidates` (R-156/W1-b) names the PERSON rather than the deal,
  // so a payment that belongs to nobody's deal can still be tagged. Optional: a
  // server older than deploy-41 omits it and the person picker falls back to
  // searching clients/suppliers by hand.
  // `scanned`/`eligible`/`truncated` (R-204) describe scan scope: the sweep takes
  // the newest N rows, so without them a transaction older than that cut-off is
  // indistinguishable from one the engine looked at and found nothing for.
  // Optional — an older server omits all three, which reads as not truncated.
  suggestBankTxnLinks: () =>
    invoke<{
      suggestions: {
        txn_id: string;
        candidates: BankSuggestCandidate[];
        counterparty?: BankPersonCandidate | null;
        counterparty_candidates?: BankPersonCandidate[];
      }[];
      source?: "server" | "local";
      scanned?: number;
      eligible?: number;
      truncated?: boolean;
    }>("suggest_bank_txn_links"),
  // `checked`/`truncated` describe scan scope: the server caps at the 30 newest
  // completed deals and flags when older ones were left unscanned. Optional —
  // an old server omits both, which means not truncated.
  suggestReconciliationMissing: () =>
    invoke<{ deals: ReconciliationMissingDeal[]; source?: "server" | "local"; checked?: number; truncated?: boolean }>("suggest_reconciliation_missing"),
  // R-150 phase 4: stamp the supplier/client identity on a transaction so
  // profiles show payment history even for money never tied to a deal.
  tagBankTxnCounterparty: (bankTxnId: string, ctype: "supplier" | "client", counterpartyId: string) =>
    invoke<void>("tag_bank_txn_counterparty", { bankTxnId, ctype, counterpartyId }),
  // Clears only the supplier/client link — never category (a counterparty tag
  // never set one). Loan tags go through untagBankTxnLoan instead.
  untagBankTxnCounterparty: (bankTxnId: string) =>
    invoke<void>("untag_bank_txn_counterparty", { bankTxnId }),
  // R-150: every bank transaction a supplier or client touches — directly
  // tagged rows plus role allocations on their deals, deduped per txn.
  counterpartyPayments: (ctype: "supplier" | "client", id: string, name: string) =>
    invoke<CounterpartyPaymentRow[]>("counterparty_payments", { ctype, id, name }),

  // Signup rules
  listSignupRules: () => invoke<SignupRule[]>("list_signup_rules"),
  createSignupRule: (input: SignupRuleInput) =>
    invoke<string>("create_signup_rule", { input }),
  updateSignupRule: (id: string, input: SignupRuleInput) =>
    invoke<void>("update_signup_rule", { id, input }),
  deleteSignupRule: (id: string) => invoke<void>("delete_signup_rule", { id }),
  toggleSignupRule: (id: string, active: boolean) =>
    invoke<void>("toggle_signup_rule", { id, active }),
  previewFormCapture: (inboxId: string, senderPattern?: string | null, subjectPattern?: string | null) =>
    invoke<FormCapturePreview>("preview_form_capture", { inboxId, senderPattern, subjectPattern }),

  // Payment methods
  listPaymentMethods: () => invoke<PaymentMethod[]>("list_payment_methods"),
  createPaymentMethod: (input: PaymentMethodInput) =>
    invoke<string>("create_payment_method", { input }),
  updatePaymentMethod: (id: string, input: PaymentMethodInput) =>
    invoke<void>("update_payment_method", { id, input }),
  deletePaymentMethod: (id: string) => invoke<void>("delete_payment_method", { id }),
  reorderPaymentMethods: (ids: string[]) =>
    invoke<void>("reorder_payment_methods", { ids }),

  // Line item templates
  /** R-236: buyers whose purchase history is genuinely close to this lot.
   *  An empty array is a real answer — no history is close — not a failure. */
  findLotMatches: (lotId: string) => invoke<LotMatch[]>("find_lot_matches", { lotId }),
  listLineItemTemplates: () => invoke<LineItemTemplate[]>("list_line_item_templates"),
  createLineItemTemplate: (description: string, rate: number, qty: number) =>
    invoke<string>("create_line_item_template", { description, rate, qty }),
  deleteLineItemTemplate: (id: string) => invoke<void>("delete_line_item_template", { id }),
  reorderLineItemTemplates: (ids: string[]) =>
    invoke<void>("reorder_line_item_templates", { ids }),

  // Newsletters
  listNewsletters: () => invoke<Newsletter[]>("list_newsletters"),
  saveNewsletter: (id: string | null, subject: string, body: string) =>
    invoke<Newsletter>("save_newsletter", { id, subject, body }),
  deleteNewsletter: (id: string) => invoke<void>("delete_newsletter", { id }),
  sendNewsletter: (newsletterId: string, clientIds: string[], subjectTemplate: string, bodyTemplate: string, attachmentPath?: string | null) =>
    invoke<NewsletterSendResult>("send_newsletter", {
      newsletterId, clientIds, subjectTemplate, bodyTemplate, attachmentPath,
    }),
  aiDraftNewsletter: (prompt: string, tone: string) =>
    invoke<string>("ai_draft_newsletter", { prompt, tone }),

  // Scheduled Sends
  scheduleNewsletterSend: (subject: string, body: string, clientIds: string[], intervalSeconds: number, scheduledAt: string, attachmentPath?: string | null) =>
    invoke<ScheduledSend>("schedule_newsletter_send", { subject, body, clientIds, intervalSeconds, scheduledAt, attachmentPath }),
  cancelScheduledSend: (id: string) =>
    invoke<void>("cancel_scheduled_send", { id }),
  listScheduledSends: () =>
    invoke<ScheduledSend[]>("list_scheduled_sends"),
  getScheduledSendProgress: (id: string) =>
    invoke<ScheduledSendProgress>("get_scheduled_send_progress", { id }),

  // Recurring newsletter schedules
  listNewsletterSchedules: () =>
    invoke<NewsletterSchedule[]>("list_newsletter_schedules"),
  createNewsletterSchedule: (
    name: string,
    subject: string,
    body: string,
    recipientFilter: string,
    intervalType: string,
    intervalValue: number,
    sendHour: number,
  ) =>
    invoke<NewsletterSchedule>("create_newsletter_schedule", {
      name, subject, body, recipientFilter, intervalType, intervalValue, sendHour,
    }),
  updateNewsletterSchedule: (
    id: string,
    fields: Partial<{
      name: string; subject: string; body: string; recipientFilter: string;
      intervalType: string; intervalValue: number; sendHour: number; active: number;
    }>,
  ) =>
    invoke<NewsletterSchedule>("update_newsletter_schedule", { id, ...fields }),
  deleteNewsletterSchedule: (id: string) =>
    invoke<void>("delete_newsletter_schedule", { id }),
  saveSmtpSettingsForPi: (settings: Record<string, string>) =>
    invoke<void>("save_smtp_settings_for_pi", { settings }),
  pushDesktopSmtpToPi: (fromName: string) =>
    invoke<boolean>("push_desktop_smtp_to_pi", { fromName }),
  pushEmailLoginToServer: () =>
    invoke<boolean>("push_email_login_to_server"),
  shareConnectionsWithTeam: () =>
    invoke<string>("share_connections_with_team"),
  getSmtpSettingsForPi: () =>
    invoke<Record<string, string>>("get_smtp_settings_for_pi"),

  // Categories
  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (input: CategoryInput) => invoke<string>("create_category", { input }),
  updateCategory: (id: string, input: CategoryInput) => invoke<void>("update_category", { id, input }),
  deleteCategory: (id: string) => invoke<void>("delete_category", { id }),
  reorderCategories: (ids: string[]) => invoke<void>("reorder_categories", { ids }),
  sortCategories: (desc: boolean) => invoke<void>("sort_categories", { desc }),
  dedupeCategories: () => invoke<number>("dedupe_categories"),
  importCategories: (labels: string[]) => invoke<number>("import_categories", { labels }),
  csvDistinctColumn: (path: string, column: number) => invoke<string[]>("csv_distinct_column", { path, column }),
  sheetCategoryValues: () => invoke<string[]>("sheet_category_column_values"),

  // Sheet Sync
  getSheetSyncConfig: () => invoke<SheetSyncConfig>("get_sheet_sync_config"),
  saveSheetSyncConfig: (config: SheetSyncConfig) => invoke<void>("save_sheet_sync_config", { config }),
  sheetWritebackStatus: () => invoke<SheetWritebackStatus>("sheet_writeback_status"),
  syncAllClientsToSheet: () =>
    invoke<{ added: number; skipped: number; total: number; dedup: boolean }>("sync_all_clients_to_sheet"),
  syncFromSheet: () => invoke<SheetSyncResult>("sync_from_sheet"),
  getSheetSyncLog: () => invoke<SheetSyncLogEntry[]>("get_sheet_sync_log"),
  listCustomFields: () => invoke<CustomField[]>("list_custom_fields"),
  saveCustomField: (id: string | null, fieldKey: string, label: string, fieldType: string, optionsJson: string | null) =>
    invoke<CustomField>("save_custom_field", { id, fieldKey, label, fieldType, optionsJson }),
  deleteCustomField: (id: string) => invoke<void>("delete_custom_field", { id }),
  getSheetHeaders: (sheetUrl: string) => invoke<SheetHeader[]>("get_sheet_headers", { sheetUrl }),
  // Read-and-rebuild a view-only supplier sheet into a fresh sheet the user owns (Unlimited plan).
  cloneGoogleSheet: (url: string) =>
    invoke<{ title: string; newUrl: string; sheetCount: number; warnings: string[] }>("clone_google_sheet", { url }),

  // Geocoding
  geocodeClient: (clientId: string) => invoke<{ lat: number; lng: number }>("geocode_client", { clientId }),
  geocodeAllClients: () => invoke<{ total: number; matched: number; skipped: number; not_found: number; message: string }>("geocode_all_clients"),

  // Users
  listUsers: () => invoke<User[]>("list_users"),
  createOwnerUser: (name: string, email: string) => invoke<User>("create_owner_user", { name, email }),
  inviteUser: (name: string, email: string, role: string) => invoke<User>("invite_user", { name, email, role }),
  claimInvite: (code: string) => invoke<User>("claim_invite", { code }),
  removeUser: (id: string) => invoke<void>("remove_user", { id }),
  updateUserRole: (id: string, role: string) => invoke<void>("update_user_role", { id, role }),
  getCurrentUser: () => invoke<User | null>("get_current_user"),
  setCurrentUser: (id: string) => invoke<void>("set_current_user", { id }),

  // Inventory
  listInventory: (status?: string) => invoke<Lot[]>("list_inventory", { status: status ?? null }),
  createLot: (lot: { name: string; quantity: number; totalCost: number; askingPrice: number; description?: string; category?: string; photos?: string[]; notes?: string; supplier?: string; location?: string; priceType?: string; detailsJson?: string }) =>
    invoke<Lot>("create_lot", { ...lot }),
  updateLot: (id: string, fields: Record<string, any>) => invoke<void>("update_lot", { id, ...fields }),

  // Lot locations (FOB)
  suggestCity: (prefix: string, limit?: number) =>
    invoke<CityEntry[]>("suggest_city", { prefix, limit: limit ?? null }),
  statesForCity: (city: string) => invoke<CityEntry[]>("states_for_city", { city }),
  listLotLocations: () => invoke<LotLocationGroup[]>("list_lot_locations"),
  applyLocationNormalization: (changes: { from: string; to: string }[]) =>
    invoke<LocationFixSummary>("apply_location_normalization", { changes }),
  setLotStatus: (id: string, status: string) => invoke<void>("set_lot_status", { id, status }),
  deleteLot: (id: string) => invoke<void>("delete_lot", { id }),
  deleteLots: (ids: string[]) => invoke<number>("delete_lots", { ids }),
  listOffers: () => invoke<Offer[]>("list_offers"),
  listStaleServerLots: () => invoke<{ id: string; name: string; status: string }[]>("list_stale_server_lots"),
  setOfferStatus: (id: string, status: string) => invoke<void>("set_offer_status", { id, status }),
  deleteOffer: (id: string) => invoke<void>("delete_offer", { id }),
  resyncInventory: () => invoke<number>("resync_inventory"),
  // Two-way media reconcile: download photos/manifests this device is missing and
  // upload any the server lacks. Returns how many files moved each way.
  reconcileInventoryMedia: () => invoke<{ downloaded: number; uploaded: number }>("reconcile_inventory_media"),
  // Lots whose media hasn't fully synced (a file missing on this device, or still uploading).
  listMediaSyncIssues: () => invoke<{ lot_id: string; missing_local: boolean; pending_upload: boolean }[]>("list_media_sync_issues"),
  importLotPhotos: (lotId: string, paths: string[]) => invoke<string[]>("import_lot_photos", { lotId, paths }),
  // Clipboard-pasted image -> temp file path, so it can then go through importLotPhotos
  // like any picked or dragged file. Used by paste-a-load (copy an image in WhatsApp Web).
  stagePastedImage: (dataBase64: string, ext?: string | null) =>
    invoke<string>("stage_pasted_image", { dataBase64, ext: ext ?? null }),
  removeLotPhoto: (lotId: string, photoPath: string) => invoke<string[]>("remove_lot_photo", { lotId, photoPath }),
  attachLotManifest: (lotId: string, filePath: string) => invoke<string>("attach_lot_manifest", { lotId, filePath }),
  removeLotManifest: (lotId: string) => invoke<void>("remove_lot_manifest", { lotId }),
  mediaBaseDir: () => invoke<string>("media_base_dir"),
  generateWhatsappMessage: (lotIds: string[]) => invoke<string>("generate_whatsapp_message", { lotIds }),
  getLotMediaFiles: (lotIds: string[]) => invoke<LotMediaFiles>("get_lot_media_files", { lotIds }),
  saveWhatsappFooter: (footer: string) => invoke<void>("save_whatsapp_footer", { footer }),
  getWhatsappFooter: () => invoke<string>("get_whatsapp_footer"),
  saveWhatsappDescription: (description: string) => invoke<void>("save_whatsapp_description", { description }),
  getWhatsappDescription: () => invoke<string>("get_whatsapp_description"),
  getWhatsappSettings: () => invoke<WhatsappSettings>("get_whatsapp_settings"),
  // R-162 policy clauses. Both texts are Jack's wording and ship empty; an enabled
  // toggle with empty text renders nothing anywhere.
  getPolicyClauseSettings: () => invoke<PolicyClauseSettings>("get_policy_clause_settings"),
  savePolicyClauseSettings: (settings: PolicyClauseSettings) =>
    invoke<void>("save_policy_clause_settings", { settings }),
  saveWhatsappSettings: (s: WhatsappSettings) =>
    invoke<void>("save_whatsapp_settings", { template: s.template, lotFormat: s.lot_format, footer: s.footer, phone: s.phone }),
  // Editable inventory-newsletter template: intro/outro wrap the list, lot_format is the
  // per-product block ({title} {units} {price_per_unit} {price} {link}).
  getNewsletterProductTemplate: () => invoke<NewsletterProductTemplate>("get_newsletter_product_template"),
  saveNewsletterProductTemplate: (t: NewsletterProductTemplate) =>
    invoke<void>("save_newsletter_product_template", { intro: t.intro, outro: t.outro, lotFormat: t.lot_format }),
  openLotFolder: (lotId: string) => invoke<void>("open_lot_folder", { lotId }),
  whatsappWebReachable: () => invoke<boolean>("whatsapp_web_reachable"),
  openWhatsappWindow: () => invoke<void>("open_whatsapp_window"),
  closeWhatsappWindow: () => invoke<void>("close_whatsapp_window"),
  whatsappEmbedShow: (x: number, y: number, width: number, height: number) =>
    invoke<void>("whatsapp_embed_show", { x, y, width, height }),
  whatsappEmbedClose: () => invoke<void>("whatsapp_embed_close"),
  // Facebook Page auto-post. Meta blocks app-posting to groups, so this targets a Page.
  fbStatus: () => invoke<FbStatus>("fb_status"),
  fbSetApp: (appId: string, appSecret: string) => invoke<void>("fb_set_app", { appId, appSecret }),
  fbConnect: () => invoke<FbPageLite[]>("fb_connect"),
  fbSelectPage: (pageId: string) => invoke<string>("fb_select_page", { pageId }),
  fbDisconnect: () => invoke<void>("fb_disconnect"),
  fbPostLot: (message: string, photoRels: string[]) => invoke<string>("fb_post_lot", { message, photoRels }),
  archiveLot: (id: string) => invoke<void>("archive_lot", { id }),
  linkLotToDeal: (lotId: string, dealId: string) => invoke<void>("link_lot_to_deal", { lotId, dealId }),

  // Follow-up rules
  listFollowupRules: () => invoke<FollowUpRule[]>("list_followup_rules"),
  createFollowupRule: (r: { name: string; trigger_type: string; trigger_value: number; action_type: string; email_subject?: string | null; email_body?: string | null }) =>
    invoke<FollowUpRule>("create_followup_rule", { ...r }),
  updateFollowupRule: (id: string, fields: Record<string, any>) => invoke<void>("update_followup_rule", { id, ...fields }),
  deleteFollowupRule: (id: string) => invoke<void>("delete_followup_rule", { id }),
  toggleFollowupRule: (id: string) => invoke<void>("toggle_followup_rule", { id }),
  processFollowupRules: () => invoke<FollowUpLogEntry[]>("process_followup_rules"),
  getFollowupLog: () => invoke<FollowUpLogEntry[]>("get_followup_log"),
  automationsSummary: () => invoke<AutomationsSummary>("automations_summary"),

  // Portal
  generatePortalLink: (clientId: string) => invoke<PortalLink>("generate_portal_link", { clientId }),
  revokePortalLink: (token: string) => invoke<void>("revoke_portal_link", { token }),
  listPortalLinks: (clientId?: string) => invoke<PortalLink[]>("list_portal_links", { clientId: clientId ?? null }),
  getPortalBaseUrl: () => invoke<string | null>("get_portal_base_url"),
  savePortalBaseUrl: (url: string) => invoke<void>("save_portal_base_url", { url }),

  // Manifest
  // forceAi re-reads a PDF through Claude when the text-layer heuristic got it wrong.
  analyzeManifest: (path: string, forceAi?: boolean) =>
    invoke<ManifestAnalysis>("analyze_manifest", { path, forceAi: forceAi ?? false }),

  // Forecast
  getProfitForecast: () => invoke<ProfitForecast>("get_profit_forecast"),

  // ===== Lot engine (R-200) =====
  // A warehouse sheet becomes priced, pickable lots. Every number below is computed in
  // Rust by `src-tauri/src/lot_engine/`, which is shared byte-for-byte with the server so
  // the phone and the desktop cannot disagree. Nothing here re-implements the maths.
  importLotSheet: (path: string, name?: string) =>
    invoke<LotImportResult>("import_lot_sheet", { path, name: name ?? null }),
  listLotSheets: (includeArchived?: boolean) =>
    invoke<LotSheet[]>("list_lot_sheets", { includeArchived: includeArchived ?? false }),
  lotSheetReport: (sheetId: string) => invoke<LotSheetReport>("lot_sheet_report", { sheetId }),
  renameLotSheet: (sheetId: string, name: string) =>
    invoke<void>("rename_lot_sheet", { sheetId, name }),
  archiveLotSheet: (sheetId: string, archived: boolean) =>
    invoke<void>("archive_lot_sheet", { sheetId, archived }),
  lotSheetFacets: (sheetId: string) => invoke<LotFacets>("lot_sheet_facets", { sheetId }),
  // Called on every keystroke behind a debounce. Ranks every available slot, returns the top
  // `limit` — the ranking itself always runs over the whole pool.
  // `exclude` is the slots already picked into the lot on screen but not yet saved — they
  // leave the pool the moment they are picked.
  rankLotSlots: (sheetId: string, want: LotWant, allow: LotAllow, opts: LotRankOpts, exclude?: string[]) =>
    invoke<LotRankResult>("rank_lot_slots", { sheetId, want, allow, opts, exclude: exclude ?? null }),
  // Running totals for a lot being built. Goes to Rust rather than adding prices up here, so
  // the figures on screen are the ones the manifest will carry.
  previewLotTotals: (
    sheetId: string,
    slots: string[],
    pricePct: number,
    priceOverrides?: string,
    costPct?: number,
    costOverrides?: string,
  ) =>
    invoke<LotTotals>("preview_lot_totals", {
      sheetId,
      slots,
      pricePct,
      priceOverrides: priceOverrides ?? null,
      costPct: costPct ?? 0,
      costOverrides: costOverrides ?? null,
    }),
  lotSlotContents: (sheetId: string, location: string) =>
    invoke<LotStack[]>("lot_slot_contents", { sheetId, location }),
  setLotSlotState: (
    sheetId: string,
    locations: string[],
    state: "available" | "staged" | "removed",
    lotId?: string,
    note?: string,
  ) =>
    invoke<number>("set_lot_slot_state", {
      sheetId,
      locations,
      state,
      lotId: lotId ?? null,
      note: note ?? null,
    }),
  listLotSlotStates: (sheetId: string) => invoke<LotSlotState[]>("list_lot_slot_states", { sheetId }),
  saveLotBuild: (p: {
    sheetId: string;
    buildId?: string;
    name: string;
    slots: string[];
    pricePct: number;
    priceOverrides?: string;
    costPct?: number;
    costOverrides?: string;
    notes?: string;
  }) =>
    invoke<LotBuild>("save_lot_build", {
      sheetId: p.sheetId,
      buildId: p.buildId ?? null,
      name: p.name,
      slots: p.slots,
      pricePct: p.pricePct,
      priceOverrides: p.priceOverrides ?? null,
      costPct: p.costPct ?? 0,
      costOverrides: p.costOverrides ?? null,
      notes: p.notes ?? null,
    }),
  lotBuildDetail: (buildId: string) => invoke<LotBuildDetail>("lot_build_detail", { buildId }),
  listLotBuilds: (sheetId?: string) =>
    invoke<LotBuild[]>("list_lot_builds", { sheetId: sheetId ?? null }),
  archiveLotBuild: (buildId: string, archived: boolean) =>
    invoke<void>("archive_lot_build", { buildId, archived }),

  // The lot tree (R-218): branch > combined > base lot, one spreadsheet per level.
  createLotBranch: (sheetId: string, name: string) =>
    invoke<LotBuild>("create_lot_branch", { sheetId, name }),
  /** Merges the picked lots into ONE new lot. The sources are untouched. */
  combineLotBuilds: (p: {
    sheetId: string;
    name: string;
    childIds: string[];
    pricePct: number;
    costPct?: number;
    branchId?: string | null;
  }) =>
    invoke<LotBuild>("combine_lot_builds", {
      sheetId: p.sheetId,
      name: p.name,
      childIds: p.childIds,
      pricePct: p.pricePct,
      costPct: p.costPct ?? null,
      branchId: p.branchId ?? null,
    }),
  /** One percentage and one cost across every lot in a branch. Overrides each lot's own. */
  setBranchPricing: (branchId: string, pricePct: number, costPct?: number) =>
    invoke<number>("set_branch_pricing", { branchId, pricePct, costPct: costPct ?? null }),
  /** The item lines a lot contains — the same rows that go on its workbook page. */
  lotBuildLines: (buildId: string) =>
    invoke<{ title: string; headers: string[]; rows: string[][] }>("lot_build_lines", { buildId }),
  /** A branch: one breakdown page, then one page per lot. xlsx only. */
  /** A level: 1 breakdown page + one page per lot. `branchId` null is the top level. */
  exportBranchWorkbook: (
    sheetId: string,
    branchId: string | null,
    title: string,
    path: string,
  ) =>
    invoke<LotExportResult>("export_branch_workbook", { sheetId, branchId, title, path }),
  /** One lot: breakdown, then all its items. Two pages. */
  exportLotWorkbook: (buildId: string, path: string) =>
    invoke<LotExportResult>("export_lot_workbook", { buildId, path }),
  setLotParent: (buildId: string, parentId: string | null) =>
    invoke<void>("set_lot_parent", { buildId, parentId }),
  /** Cascades: everything inside it goes with it. */
  markLotSold: (buildId: string, sold: boolean) =>
    invoke<number>("mark_lot_sold", { buildId, sold }),
  lotRosterLines: (sheetId: string, nodeId: string | null) =>
    invoke<LotLine[]>("lot_roster_lines", { sheetId, nodeId }),
  exportLotRoster: (p: { sheetId: string; nodeId: string | null; title: string; path: string }) =>
    invoke<LotExportResult>("export_lot_roster", {
      sheetId: p.sheetId,
      nodeId: p.nodeId,
      title: p.title,
      path: p.path,
    }),
  // The deliberate half: staging is automatic, taking stock off the master list is a button.
  removeLotFromMasterList: (buildId: string, removed: boolean) =>
    invoke<number>("remove_lot_from_master_list", { buildId, removed }),
  /** `destPath` is a complete path from a save dialog and beats `destDir`; `format` is
   *  "csv" or "xlsx", both rendered from the same table by the shared engine. */
  exportLotBuild: (
    buildId: string,
    kind: "manifest" | "brands" | "pull",
    opts?: { includeSlots?: boolean; destDir?: string; format?: "csv" | "xlsx"; destPath?: string },
  ) =>
    invoke<LotExportResult>("export_lot_build", {
      buildId,
      kind,
      includeSlots: opts?.includeSlots ?? false,
      destDir: opts?.destDir ?? null,
      format: opts?.format ?? "csv",
      destPath: opts?.destPath ?? null,
    }),
  /** Cut the qualifying pool into ~target-unit lots. A preview — nothing is written. */
  planLotBuilds: (
    sheetId: string,
    want: LotWant,
    allow: LotAllow,
    opts: LotRankOpts,
    plan: LotAutoPlan,
    exclude?: string[],
  ) =>
    invoke<LotAutoResult>("plan_lot_builds", { sheetId, want, allow, opts, plan, exclude: exclude ?? null }),
  lotBuildLocationCodes: (buildId: string) =>
    invoke<string>("lot_build_location_codes", { buildId }),
  // Re-emit every lot engine row so it replicates again. The escape hatch for a desktop
  // that pushed sheets to a server which did not yet accept the tables — those events are
  // rejected, and a rejection is treated as an acknowledgement, so nothing is left to retry.
  resyncLotEngine: () => invoke<number>("resync_lot_engine"),
  /** Rename a saved lot. The export filename is built from the name, so this renames the
   *  lot's downloads too — which is the point. */
  /** Distinct products on a sheet, biggest first — the ones worth correcting carry the units. */
  lotSheetProducts: (sheetId: string, query?: string, limit?: number) =>
    invoke<LotProduct[]>("lot_sheet_products", { sheetId, query: query ?? null, limit: limit ?? null }),
  /** Correct one product's retail, or pass null to go back to the sheet's own price. Applied
   *  wherever stacks are loaded, so every figure that mentions the product moves with it. */
  setLotRetail: (sheetId: string, title: string, msrp: number | null) =>
    invoke<void>("set_lot_retail", { sheetId, title, msrp }),
  /** One percentage across every line in a saved lot, and optionally what it cost. Drops any
   *  per-category overrides — this is the whole-lot number you quote a buyer. Recomputes the
   *  ask and the per-brand/per-category blocks, and touches nothing about what is IN the lot. */
  repriceLotBuild: (buildId: string, pricePct: number, costPct?: number) =>
    invoke<LotBuild>("reprice_lot_build", { buildId, pricePct, costPct: costPct ?? 0 }),
  getLotManifestOpts: () => invoke<LotManifestOpts>("get_lot_manifest_opts"),
  setLotManifestOpts: (opts: LotManifestOpts) => invoke<void>("set_lot_manifest_opts", { opts }),
  renameLotBuild: (buildId: string, name: string) =>
    invoke<void>("rename_lot_build", { buildId, name }),
  /** The same, for one sheet: its row, its slot states, its lots and its stacks artifact.
   *  The narrow escape hatch, and the one with a button — the failure it repairs (a push
   *  rejected before the server knew the table, then dropped instead of retried) happens
   *  per sheet, and nothing re-sends it on its own. */
  resyncLotSheet: (sheetId: string) => invoke<number>("resync_lot_sheet", { sheetId }),
  lotSheetConflicts: (sheetId: string, query?: string, limit?: number) =>
    invoke<LotUpcConflict[]>("lot_sheet_conflicts", {
      sheetId,
      query: query ?? null,
      limit: limit ?? null,
    }),
  /** The barcode-conflict list as a CSV. It is what the warehouse needs to fix the habit at
   *  source, which is why it leaves the app rather than only living on screen. */
  exportLotConflicts: (sheetId: string, destDir?: string) =>
    invoke<LotExportResult>("export_lot_conflicts", { sheetId, destDir: destDir ?? null }),
};

// ===== Lot engine types =====

/** One product sitting in one slot. The key is (location, box, upc, title) — INCLUDING the
 *  title, because two rows typed differently are two products. */
export interface LotStack {
  location: string;
  box: string;
  upc: string;
  title: string;
  units: number;
  msrp: number;
  brand: string | null;
  category: string | null;
  segment: string | null;
  size_us: number | null;
  /** 0 typed · 1 named from a clean barcode · 2 VERIFY · 3 no description in the source. */
  title_risk: number;
  upc_ambiguous: boolean;
}

export interface LotSheet {
  id: string;
  name: string;
  source_filename: string | null;
  imported_at: string;
  rows_in: number;
  stacks: number;
  products: number;
  units: number;
  locations: number;
  msrp_total: number;
  artifact_path: string | null;
  report_path: string | null;
  audit_map_path: string | null;
  archived: boolean;
  staged_slots: number;
  removed_slots: number;
  /** False when this sheet was imported elsewhere and its stacks have not arrived yet. */
  has_stacks: boolean;
}

export interface LotDropReason {
  reason: string;
  rows: number;
  units: number;
  examples: string[];
}

export interface LotQuality {
  rows_in: number;
  units_in: number;
  rows_dropped: number;
  units_dropped: number;
  drops: LotDropReason[];
  location_spellings: number;
  locations: number;
  locations_repaired: number;
  locations_unparsed: number;
  titles_blank: number;
  titles_backfilled: number;
  titles_unknown: number;
  title_risk_units: [number, number, number, number];
  upcs: number;
  upcs_multi_name: number;
  upcs_ambiguous: number;
  units_ambiguous: number;
  products: number;
  stacks: number;
  units: number;
  msrp_total: number;
  zero_price_stacks: number;
  zero_price_units: number;
  warnings: string[];
}

/** What the reader actually did — surfaced on purpose, because accepting every file format
 *  is worthless if a mis-detected location column is wrong in silence. */
export interface LotDetection {
  format: string;
  sheet: string | null;
  header_row: number;
  upc_col: string | null;
  location_col: string | null;
  box_col: string | null;
  units_col: string | null;
  title_col: string | null;
  msrp_col: string | null;
  flag_cols: string[];
  note: string | null;
}

export interface LotImportResult {
  sheet: LotSheet;
  quality: LotQuality;
  detection: LotDetection;
  report_text: string;
}

export interface LotSheetReport {
  sheet: LotSheet;
  quality: LotQuality | null;
  detection: LotDetection | null;
  report_text: string;
  report_path: string | null;
  audit_map_path: string | null;
}

export interface LotFacet {
  name: string;
  units: number;
  slots: number;
}

export interface LotFacets {
  brands: LotFacet[];
  categories: LotFacet[];
  segments: LotFacet[];
  size_min: number | null;
  size_max: number | null;
  msrp_min: number;
  msrp_max: number;
  pool_slots: number;
  pool_units: number;
  pool_msrp: number;
}

/** WANT ranks slots and excludes nothing. */
export interface LotWant {
  brands: string[];
  size_min: number | null;
  size_max: number | null;
  msrp_min: number | null;
  msrp_max: number | null;
}

/** ALLOW decides which slots qualify at all. WANT is always a subset of ALLOW. */
export interface LotAllow {
  categories: string[];
  segments: string[];
  described_only: boolean;
  brand_lock: string[];
}

export interface LotRankOpts {
  /** Share of a slot allowed to violate ALLOW, 0–1. Zero is strict. */
  slack: number;
  sort: "concentration" | "volume";
  min_units: number;
  /** Concentration floor, 0–1: the share of a slot that must be what you WANT. Not a brand
   *  lock — the rest of the slot still comes with it. Zero means no floor. */
  min_pct: number;
  limit: number;
}

export interface LotSlice {
  name: string;
  units: number;
}

export interface LotRankedSlot {
  location: string;
  total: number;
  allowed: number;
  want: number;
  breaks: number;
  pct: number;
  msrp: number;
  styles: number;
  brands: LotSlice[];
  /** What you did not ask for but are taking. The most important line on the card. */
  comes_with: LotSlice[];
  boxes: string[];
  unverified_units: number;
}

export interface LotRankResult {
  slots: LotRankedSlot[];
  matched_slots: number;
  pool_slots: number;
  matched_units: number;
  matched_want_units: number;
  matched_msrp: number;
  /** Units of something else per unit you wanted, across the whole match. */
  tagalong_ratio: number;
  rejected_by_allow: number;
  rejected_by_want: number;
  rejected_by_size: number;
  /** Slots holding what you want, just not enough of it. */
  rejected_by_pct: number;
  sort_note: string;
}

/** What to aim for when cutting the pool into lots. */
export interface LotAutoPlan {
  /** Roughly how many units per lot. A location is never split, so a lot lands a little
   *  over rather than exactly on it. */
  target_units: number;
  /** How many lots to cut. Zero means as many as the pool allows. */
  max_lots: number;
  /** Don't emit a final lot smaller than this. Zero means half the target. */
  min_lot_units: number;
}

/** One lot the planner would cut. Nothing is saved until a person says so. */
export interface LotPlannedLot {
  index: number;
  locations: string[];
  units: number;
  want_units: number;
  pct: number;
  msrp: number;
  styles: number;
  brands: LotSlice[];
  unverified_units: number;
}

export interface LotAutoResult {
  lots: LotPlannedLot[];
  total_units: number;
  total_want_units: number;
  total_msrp: number;
  leftover_slots: number;
  leftover_units: number;
  note: string;
}

/** One distinct product on a sheet, for the screen that corrects retail prices. */
export interface LotProduct {
  title: string;
  upc: string;
  brand: string | null;
  category: string | null;
  units: number;
  /** The price in force — the corrected one where there is a correction. */
  msrp: number;
  overridden: boolean;
  locations: number;
}

/** What a manifest shows. A hard setting, org-shared, not a per-export choice. */
export interface LotManifestOpts {
  lot_name: string;
  include_slots: boolean;
  /** The "Description check" column and the "Lines to check" total. Off by default — it
   *  reads as a defect to a buyer, and the grading still happens on screen regardless. */
  show_check: boolean;
  show_upc: boolean;
  show_brand: boolean;
  show_category: boolean;
  show_segment: boolean;
  show_size: boolean;
  show_msrp: boolean;
  show_summary: boolean;
  show_by_category: boolean;
}

export interface LotSlotState {
  location_code: string;
  state: string;
  lot_id: string | null;
  updated_at: string;
}

export interface LotGroupTotal {
  name: string;
  units: number;
  styles: number;
  locations: number;
  msrp: number;
  ask: number;
  /** Ask divided by units — $75 of retail at 26% reads as 19.50 here. */
  per_unit: number;
  share: number;
  /** What this slice costs and leaves. Both zero unless a cost was recorded — read
   *  `LotTotals.cost_known` before showing either as a fact. */
  cost: number;
  profit: number;
}

export interface LotTotals {
  locations: number;
  stacks: number;
  styles: number;
  units: number;
  msrp: number;
  ask: number;
  effective_pct: number;
  per_unit: number;
  /** What the lot costs you and what it leaves. All zero when no cost has been recorded. */
  cost: number;
  cost_per_unit: number;
  profit: number;
  /** Profit over the ask, 0–1. */
  margin: number;
  /** False when no cost was set, so "no profit" can be told from "not known". Every
   *  surface must check this before printing a margin — a lot with no cost showing 100%
   *  margin is a lie, not a default. */
  cost_known: boolean;
  by_brand: LotGroupTotal[];
  by_category: LotGroupTotal[];
  /**
   * Men's / Women's / GS / Kids / Unisex, and `Not stated` (R-223).
   *
   * `Not stated` is a row, never an omission — every breakdown table sums to the lot, so a
   * manifest can never look complete while failing to add up.
   */
  by_segment: LotGroupTotal[];
  title_risk_units: [number, number, number, number];
}

export interface LotBuild {
  id: string;
  sheet_id: string;
  sheet_name: string | null;
  name: string;
  status: string;
  price_pct: number;
  price_pct_json: string | null;
  /** What the lot COST, a share of MSRP per line. Zero means not recorded, not free. */
  cost_pct: number;
  cost_pct_json: string | null;
  locations: number;
  units: number;
  styles: number;
  msrp_total: number;
  ask_total: number;
  slots: string[];
  notes: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  /** The node this lot sits inside, or null at the top level (R-218). */
  parent_id: string | null;
  /** `lot` | `combined` | `branch`. Only a `lot` owns warehouse slots. */
  kind: string;
  /** Stamped when `status` became `sold`. */
  sold_at: string | null;
  /**
   * The lots this one was MERGED FROM (R-224). Empty for an ordinary lot.
   *
   * Not `parent_id`: that is which branch a lot is *displayed in*, this is which lots a
   * merge was *built out of*. The canvas draws a wire per entry, and the red strike
   * travels down this list — never up it.
   */
  merged_from: string[];
}

/** One row of a roster - the master spreadsheet, one line per lot rather than per product. */
export interface LotLine {
  reference: string;
  units: number;
  retail: number;
  sale: number;
}

export interface LotBuildDetail {
  build: LotBuild;
  totals: LotTotals;
  /** Walk-ordered slot codes, ready to paste into a message to the floor. */
  location_codes: string;
}

export interface LotExportResult {
  path: string;
  rows: number;
  /** True when the manifest, brand counts and pull sheet agree on the unit total. */
  reconciled: boolean;
}

export interface LotUpcConflictName {
  title: string;
  brand: string | null;
  units: number;
  share: number;
  locations: number;
  msrp: number;
}

export interface LotUpcConflict {
  upc: string;
  /** split · stray · same_brand · other */
  grade: string;
  units: number;
  names: LotUpcConflictName[];
  /** One price across every name — a barcode used as a price tier, not a product code. */
  one_price: boolean;
}
