import { invoke } from "@tauri-apps/api/core";

// ===== Types =====
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
  next_follow_up_date: string | null;
  needs_review: boolean;
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
  next_follow_up_date?: string | null;
  needs_review?: boolean;
}

export interface ClientFilter {
  category?: string;
  lead_status?: string;
  tag?: string;
  state?: string;
  stale_days?: number;
  missing?: string;
  needs_review?: boolean;
  search?: string;
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

export interface Category {
  id: string;
  label: string;
  sort_order: number;
}

export interface CategoryInput {
  label: string;
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
}

export interface SupplierPaymentInput {
  supplier_name: string;
  supplier_id?: string | null;
  amount: number;
  quantity?: number | null;
  unit_price?: number | null;
  method?: string | null;
  notes?: string | null;
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
}

export interface EmailSettings {
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  user: string;
  auth_method: "password" | "oauth2";
}

export interface CompanyInfo {
  name: string;
  address: string;
  email: string;
  phone?: string | null;
  tax_id?: string | null;
  logo_path?: string | null;
}

export interface DashboardStats {
  clients: number;
  invoices: number;
  outstanding: number;
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
  active: boolean;
  created_at: string;
}

export interface SignupRuleInput {
  name: string;
  sender_pattern?: string | null;
  subject_pattern?: string | null;
  active: boolean;
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
  getClient: (id: string) => invoke<Client | null>("get_client", { id }),
  createClient: (input: ClientInput) => invoke<Client>("create_client", { input }),
  updateClient: (id: string, input: ClientInput) =>
    invoke<void>("update_client", { id, input }),
  deleteClient: (id: string) => invoke<void>("delete_client", { id }),
  searchClients: (query: string) => invoke<Client[]>("search_clients", { query }),
  listStaleClients: (days: number) => invoke<Client[]>("list_stale_clients", { days }),
  listClientsFiltered: (filter: ClientFilter) => invoke<Client[]>("list_clients_filtered", { filter }),
  clientsMissingInfo: () => invoke<MissingInfoReport>("clients_missing_info"),
  updateClientStatus: (id: string, status: string) =>
    invoke<void>("update_client_status", { id, status }),

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
  markInvoicePaid: (invoiceId: string, paidDate: string, paymentMethodLabel?: string, paymentReference?: string) =>
    invoke<void>("mark_invoice_paid", { invoiceId, paidDate, paymentMethodLabel, paymentReference }),
  saveInvoiceCosts: (invoiceId: string, costItems: CostItem[]) =>
    invoke<void>("save_invoice_costs", { invoiceId, costItems }),
  saveInvoiceShipping: (invoiceId: string, info: ShippingInfo) =>
    invoke<void>("save_invoice_shipping", { invoiceId, info }),
  setInvoiceSentDate: (invoiceId: string, sentDate: string) =>
    invoke<void>("set_invoice_sent_date", { invoiceId, sentDate }),

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
  completeDealFlow: (id: string, shippingStatus?: string | null, completedDate?: string | null) =>
    invoke<CompleteDealResult>("complete_deal_flow", { id, shippingStatus, completedDate }),
  uncompleteDealFlow: (id: string) => invoke<void>("uncomplete_deal_flow", { id }),
  updateDealCompletedAt: (id: string, date: string) =>
    invoke<void>("update_deal_completed_at", { id, date }),
  updateDealFlowNotes: (id: string, notes: string | null) =>
    invoke<void>("update_deal_flow_notes", { id, notes }),
  updateDealFlowName: (id: string, name: string | null) =>
    invoke<void>("update_deal_flow_name", { id, name }),
  deleteDealFlow: (id: string) => invoke<void>("delete_deal_flow", { id }),

  // Profit Split
  getProfitSplit: () => invoke<ProfitSplit>("get_profit_split"),
  saveProfitSplit: (businessPct: number, jackPct: number, benPct: number, jackName: string, benName: string) =>
    invoke<void>("save_profit_split", { businessPct, jackPct, benPct, jackName, benName }),

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

  // Customer Health
  customerHealthScores: () => invoke<CustomerHealth[]>("customer_health_scores"),
  getCustomerHealth: (clientId: string) => invoke<CustomerHealth>("get_customer_health", { clientId }),
  buyerTiers: () => invoke<BuyerTier[]>("buyer_tiers"),
  getBuyerTier: (clientId: string) => invoke<BuyerTier>("get_buyer_tier", { clientId }),
  generateWeeklyBrief: (forDate?: string | null) => invoke<WeeklyBrief>("generate_weekly_brief", { forDate: forDate ?? null }),
  pipelineAnalytics: (timeframeDays?: number) => invoke<PipelineAnalytics>("pipeline_analytics", { timeframeDays }),
  detectDuplicateClients: () => invoke<DuplicateGroup[]>("detect_duplicate_clients"),
  cleanupClients: () => invoke<{ duplicates_merged: number; ghosts_removed: number; remaining_clients: number }>("cleanup_clients"),

  // Email
  sendEmail: (to: string, subject: string, body: string, attachmentPath?: string) =>
    invoke<void>("send_email", { to, subject, body, attachmentPath }),
  scanInbox: () => invoke<ParsedEmail[]>("scan_inbox"),
  oauthStartConsent: (clientId: string, clientSecret: string) =>
    invoke<void>("oauth_start_consent", { clientId, clientSecret }),

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
  saveEmailSettings: (settings: EmailSettings) =>
    invoke<void>("save_email_settings", { settings }),
  getEmailSettings: () => invoke<EmailSettings | null>("get_email_settings"),
  saveCompanyInfo: (info: CompanyInfo) => invoke<void>("save_company_info", { info }),
  getCompanyInfo: () => invoke<CompanyInfo | null>("get_company_info"),

  getOnboardingStatus: () => invoke<boolean>("get_onboarding_status"),
  completeOnboarding: () => invoke<void>("complete_onboarding"),

  // Backup
  backupDatabase: (dir?: string) => invoke<string>("backup_database", { customDir: dir ?? null }),
  restoreDatabase: (path: string) => invoke<void>("restore_database", { path }),
  listBackups: () => invoke<{ filename: string; size: number; date: string }[]>("list_backups"),
  getBackupStatus: () => invoke<{ last_backup: string | null; backup_dir: string }>("get_backup_status"),

  // Sync
  syncReplay: () => invoke<number>("sync_replay"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncSetPassphrase: (passphrase: string) =>
    invoke<void>("sync_set_passphrase", { passphrase }),
  syncIsEncrypted: () => invoke<boolean>("sync_is_encrypted"),

  // Dashboard
  dashboardStats: () => invoke<DashboardStats>("dashboard_stats"),
  getMonthlyProfit: (month: string) => invoke<{ day: string; profit: number }[]>("get_monthly_profit", { month }),
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
  deleteSignupRule: (id: string) => invoke<void>("delete_signup_rule", { id }),
  toggleSignupRule: (id: string, active: boolean) =>
    invoke<void>("toggle_signup_rule", { id, active }),

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
  saveSmtpSettingsForPi: (settings: Record<string, string>) =>
    invoke<void>("save_smtp_settings_for_pi", { settings }),
  getSmtpSettingsForPi: () =>
    invoke<Record<string, string>>("get_smtp_settings_for_pi"),

  // Categories
  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (input: CategoryInput) => invoke<string>("create_category", { input }),
  updateCategory: (id: string, input: CategoryInput) => invoke<void>("update_category", { id, input }),
  deleteCategory: (id: string) => invoke<void>("delete_category", { id }),
  reorderCategories: (ids: string[]) => invoke<void>("reorder_categories", { ids }),

  // Sheet Sync
  getSheetSyncConfig: () => invoke<SheetSyncConfig>("get_sheet_sync_config"),
  saveSheetSyncConfig: (config: SheetSyncConfig) => invoke<void>("save_sheet_sync_config", { config }),
  syncFromSheet: () => invoke<SheetSyncResult>("sync_from_sheet"),
  getSheetSyncLog: () => invoke<SheetSyncLogEntry[]>("get_sheet_sync_log"),

  // Geocoding
  geocodeClient: (clientId: string) => invoke<{ lat: number; lng: number }>("geocode_client", { clientId }),
  geocodeAllClients: () => invoke<string>("geocode_all_clients"),

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
  createLot: (lot: { name: string; quantity: number; total_cost: number; asking_price: number; description?: string; category?: string; photos?: string[] }) =>
    invoke<Lot>("create_lot", { ...lot }),
  updateLot: (id: string, fields: Record<string, any>) => invoke<void>("update_lot", { id, ...fields }),
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
};
