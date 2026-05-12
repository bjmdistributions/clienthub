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

export interface NewsletterSendResult {
  sent: number;
  failed: number;
  errors: string[];
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
}

export interface CostItem {
  description: string;
  amount: number;
}

export interface InvoiceInput {
  client_id: string;
  due_date: string;
  line_items: LineItem[];
  tax_rate: number;
  notes?: string;
  recurring?: string;
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
  markInvoiceDepositPending: (invoiceId: string) =>
    invoke<void>("mark_invoice_deposit_pending", { invoiceId }),
  saveInvoiceCosts: (invoiceId: string, costItems: CostItem[]) =>
    invoke<void>("save_invoice_costs", { invoiceId, costItems }),

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

  // Sync
  syncReplay: () => invoke<number>("sync_replay"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncSetPassphrase: (passphrase: string) =>
    invoke<void>("sync_set_passphrase", { passphrase }),
  syncIsEncrypted: () => invoke<boolean>("sync_is_encrypted"),

  // Dashboard
  dashboardStats: () => invoke<DashboardStats>("dashboard_stats"),
  getMonthlyProfit: (month: string) => invoke<{ day: string; profit: number }[]>("get_monthly_profit", { month }),
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
};
