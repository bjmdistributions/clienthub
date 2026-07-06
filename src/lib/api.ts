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
  avg_deal_amount: number;
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

export interface DealFlow {
  id: string;
  name?: string | null;
  invoice_id: string;
  stage: 'invoiced' | 'payment_received' | 'supplier_paid' | 'complete';
  payment_received_amount: number;
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
}

export interface BuyerTier {
  client_id: string;
  client_name: string;
  tier: string;
  effective_annual: number;
  spend_per_frequency: string | null;
  actual_paid: number;
  invoices_sent: number;
  last_invoice_date: string | null;
  purchase_frequency: string | null;
  avg_commission_pct: number;
  quotes_sent: number;
  quotes_won: number;
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

export interface InvoiceInput {
  client_id: string;
  due_date: string;
  issue_date?: string;
  line_items: LineItem[];
  tax_rate: number;
  notes?: string;
  recurring?: string;
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

export interface StuckDeal {
  deal_id: string;
  title: string;
  stage: string;
  days_in_stage: number;
}

export interface WeeklyBrief {
  generated_at: string;
  week_start: string;
  week_end: string;
  revenue_this_week: number;
  revenue_last_week: number;
  revenue_change_pct: number;
  profit_this_week: number;
  profit_last_week: number;
  profit_change_pct: number;
  avg_margin_this_week: number;
  deals_by_stage: { stage: string; count: number; value: number }[];
  pipeline_value: number;
  deals_closed_this_week: number;
  deals_lost_this_week: number;
  win_rate_this_week: number;
  at_risk_customers: BuyerTier[];
  overdue_invoices_count: number;
  overdue_invoices_value: number;
  follow_ups_due: number;
  best_margin_deal: DealHighlight | null;
  worst_margin_deal: DealHighlight | null;
  biggest_invoice: InvoiceHighlight | null;
  stuck_deals: StuckDeal[];
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
}

export interface PipelineAnalytics {
  funnel_counts: Record<string, number>;
  funnel_values: Record<string, number>;
  avg_days_per_stage: Record<string, number>;
  conversion_rates: Record<string, number>;
  win_rate_overall: number;
  win_rate_last_30d: number;
  win_rate_last_90d: number;
  avg_deal_size_won: number;
  avg_deal_size_lost: number;
  avg_cycle_time_days: number;
  stuck_deals: StuckDeal[];
  top_lost_reasons: [string, number][];
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
  supplier: string | null;
  location: string | null;
  manifest_path: string | null;
  price_type: string;
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
  items: number;
  total_retail: number;
}

export interface ManifestAnalysis {
  categories: ManifestGroup[];        // by the manifest's category column, else keyword guess
  brands: ManifestGroup[];            // by the manifest's brand column; empty if none
  categories_from_manifest: boolean;  // false = fell back to keyword guess
  suggested_bid: number;
  total_retail: number;
  overall_margin_pct: number;
  total_items: number;
  skipped_rows: number;
  formula: string;
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

export interface SignupRule {
  id: string;
  name: string;
  sender_pattern: string | null;
  subject_pattern: string | null;
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
  toggleClientHighValue: (id: string) =>
    invoke<boolean>("toggle_client_high_value", { id }),
  setClientCreditLimit: (id: string, limit: number) => invoke<void>("set_client_credit_limit", { id, limit }),
  getClientCreditStatus: (id: string) =>
    invoke<{ credit_limit: number; exposure: number; available: number; over: boolean }>("get_client_credit_status", { id }),
  getNewsletterIncludeRanked: () => invoke<boolean>("get_newsletter_include_ranked"),
  setNewsletterIncludeRanked: (value: boolean) => invoke<void>("set_newsletter_include_ranked", { value }),
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
  updateInvoice: (id: string, input: { due_date: string; line_items: LineItem[]; tax_rate: number; notes?: string; recurring?: string }) =>
    invoke<void>("update_invoice", { id, input }),
  deleteInvoice: (id: string) => invoke<void>("delete_invoice", { id }),
  generateInvoicePdf: (invoiceId: string) =>
    invoke<string>("generate_invoice_pdf", { invoiceId }),
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
  sendQuote: (quoteId: string) => invoke<void>("send_quote", { quoteId }),
  markQuoteConverted: (quoteId: string, invoiceId: string) => invoke<void>("mark_quote_converted", { quoteId, invoiceId }),
  getQuoteNumberingConfig: () => invoke<InvoiceNumberingConfig>("get_quote_numbering_config"),
  saveQuoteNumberingConfig: (prefix: string, nextNumber: number, padding: number) =>
    invoke<void>("save_quote_numbering_config", { prefix, nextNumber, padding }),
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
  completeDealFlow: (id: string, shippingStatus?: string | null, completedDate?: string | null, payoutIncluded?: boolean) =>
    invoke<CompleteDealResult>("complete_deal_flow", { id, shippingStatus, completedDate, payoutIncluded }),
  uncompleteDealFlow: (id: string) => invoke<void>("uncomplete_deal_flow", { id }),
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
  createRefund: (dealFlowId: string, amount: number, opts?: { method?: string; source?: string; sourceSupplierRef?: string; keepRepCut?: boolean; reason?: string }) =>
    invoke<string>("create_refund", { dealFlowId, amount, ...(opts || {}) }),
  listRefunds: (dealFlowId: string) => invoke<any[]>("list_refunds", { dealFlowId }),
  setRefundOwed: (dealFlowId: string, amount: number) => invoke<void>("set_refund_owed", { dealFlowId, amount }),
  deleteRefund: (id: string) => invoke<void>("delete_refund", { id }),
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
  getPayoutSplit: () => invoke<{ name: string; pct: number; is_business: boolean }[]>("get_payout_split"),
  savePayoutSplit: (shares: { name: string; pct: number; is_business: boolean }[]) => invoke<void>("save_payout_split", { shares }),
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

  buyerTiers: () => invoke<BuyerTier[]>("buyer_tiers"),
  getBuyerTier: (clientId: string) => invoke<BuyerTier>("get_buyer_tier", { clientId }),
  generateWeeklyBrief: (forDate?: string | null, repName?: string | null) => invoke<WeeklyBrief>("generate_weekly_brief", { forDate: forDate ?? null, repName }),
  pipelineAnalytics: (timeframeDays?: number) => invoke<PipelineAnalytics>("pipeline_analytics", { timeframeDays }),
  detectDuplicateClients: () => invoke<DuplicateGroup[]>("detect_duplicate_clients"),
  cleanupClients: () => invoke<{ duplicates_merged: number; ghosts_removed: number; remaining_clients: number }>("cleanup_clients"),

  // Email
  sendEmail: (to: string, subject: string, body: string, attachmentPath?: string) =>
    invoke<void>("send_email", { to, subject, body, attachmentPath }),
  scanInbox: () => invoke<ParsedEmail[]>("scan_inbox"),
  getEmailInboxes: () => invoke<EmailInbox[]>("get_email_inboxes"),
  saveEmailInbox: (p: { id?: string; label: string; host: string; port: number; user: string; password?: string; scope?: "org" | "me" }) =>
    invoke<string>("save_email_inbox", p),
  deleteEmailInbox: (id: string) => invoke<void>("delete_email_inbox", { id }),
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
    invoke<{ connected: boolean; url: string; pending_push: number; pull_cursor: number }>("netsync_status"),
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

  // Sticky notes
  listNotes: () => invoke<Note[]>("list_notes"),
  createNote: (body: string, color?: string, x?: number, y?: number) => invoke<Note>("create_note", { body, color, x, y }),
  updateNote: (id: string, patch: { body?: string; color?: string; pinned?: boolean; x?: number; y?: number }) =>
    invoke<void>("update_note", { id, ...patch }),
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
  getSmtpSettingsForPi: () =>
    invoke<Record<string, string>>("get_smtp_settings_for_pi"),

  // Categories
  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (input: CategoryInput) => invoke<string>("create_category", { input }),
  updateCategory: (id: string, input: CategoryInput) => invoke<void>("update_category", { id, input }),
  deleteCategory: (id: string) => invoke<void>("delete_category", { id }),
  reorderCategories: (ids: string[]) => invoke<void>("reorder_categories", { ids }),
  sortCategories: (desc: boolean) => invoke<void>("sort_categories", { desc }),
  importCategories: (labels: string[]) => invoke<number>("import_categories", { labels }),
  csvDistinctColumn: (path: string, column: number) => invoke<string[]>("csv_distinct_column", { path, column }),
  sheetCategoryValues: () => invoke<string[]>("sheet_category_column_values"),

  // Sheet Sync
  getSheetSyncConfig: () => invoke<SheetSyncConfig>("get_sheet_sync_config"),
  saveSheetSyncConfig: (config: SheetSyncConfig) => invoke<void>("save_sheet_sync_config", { config }),
  sheetWritebackStatus: () => invoke<SheetWritebackStatus>("sheet_writeback_status"),
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
  createLot: (lot: { name: string; quantity: number; totalCost: number; askingPrice: number; description?: string; category?: string; photos?: string[]; notes?: string; supplier?: string; location?: string; priceType?: string }) =>
    invoke<Lot>("create_lot", { ...lot }),
  updateLot: (id: string, fields: Record<string, any>) => invoke<void>("update_lot", { id, ...fields }),
  setLotStatus: (id: string, status: string) => invoke<void>("set_lot_status", { id, status }),
  deleteLot: (id: string) => invoke<void>("delete_lot", { id }),
  deleteLots: (ids: string[]) => invoke<number>("delete_lots", { ids }),
  resyncInventory: () => invoke<number>("resync_inventory"),
  importLotPhotos: (lotId: string, paths: string[]) => invoke<string[]>("import_lot_photos", { lotId, paths }),
  removeLotPhoto: (lotId: string, photoPath: string) => invoke<string[]>("remove_lot_photo", { lotId, photoPath }),
  attachLotManifest: (lotId: string, filePath: string) => invoke<string>("attach_lot_manifest", { lotId, filePath }),
  removeLotManifest: (lotId: string) => invoke<void>("remove_lot_manifest", { lotId }),
  mediaBaseDir: () => invoke<string>("media_base_dir"),
  generateWhatsappMessage: (lotIds: string[]) => invoke<string>("generate_whatsapp_message", { lotIds }),
  getLotMediaFiles: (lotIds: string[]) => invoke<LotMediaFiles>("get_lot_media_files", { lotIds }),
  saveWhatsappFooter: (footer: string) => invoke<void>("save_whatsapp_footer", { footer }),
  getWhatsappFooter: () => invoke<string>("get_whatsapp_footer"),
  getWhatsappSettings: () => invoke<WhatsappSettings>("get_whatsapp_settings"),
  saveWhatsappSettings: (s: WhatsappSettings) =>
    invoke<void>("save_whatsapp_settings", { template: s.template, lotFormat: s.lot_format, footer: s.footer, phone: s.phone }),
  openLotFolder: (lotId: string) => invoke<void>("open_lot_folder", { lotId }),
  whatsappWebReachable: () => invoke<boolean>("whatsapp_web_reachable"),
  openWhatsappWindow: () => invoke<void>("open_whatsapp_window"),
  closeWhatsappWindow: () => invoke<void>("close_whatsapp_window"),
  whatsappEmbedShow: (x: number, y: number, width: number, height: number) =>
    invoke<void>("whatsapp_embed_show", { x, y, width, height }),
  whatsappEmbedClose: () => invoke<void>("whatsapp_embed_close"),
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
  analyzeManifest: (path: string) => invoke<ManifestAnalysis>("analyze_manifest", { path }),

  // Forecast
  getProfitForecast: () => invoke<ProfitForecast>("get_profit_forecast"),
};
