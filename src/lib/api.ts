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
  created_at: string;
  updated_at: string;
  metadata: Record<string, any> | null;
  invoice_count: number;
}

export interface ClientInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  notes?: string | null;
  metadata?: Record<string, any> | null;
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
}

export interface InvoiceInput {
  client_id: string;
  due_date: string;
  line_items: LineItem[];
  tax_rate: number;
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
}

export interface DashboardStats {
  clients: number;
  invoices: number;
  outstanding: number;
  paid_ytd: number;
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

  // Interactions
  listInteractions: (clientId: string) =>
    invoke<Interaction[]>("list_interactions", { clientId }),
  addInteraction: (input: { client_id: string; kind: string; subject?: string; body?: string }) =>
    invoke<string>("add_interaction", { input }),

  // Invoices
  listInvoices: () => invoke<Invoice[]>("list_invoices"),
  createInvoice: (input: InvoiceInput) => invoke<string>("create_invoice", { input }),
  generateInvoicePdf: (invoiceId: string) =>
    invoke<string>("generate_invoice_pdf", { invoiceId }),
  sendInvoice: (invoiceId: string) => invoke<void>("send_invoice", { invoiceId }),
  markInvoicePaid: (invoiceId: string) => invoke<void>("mark_invoice_paid", { invoiceId }),

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
  aiDraftReply: (emailBody: string, context?: string) =>
    invoke<string>("ai_draft_reply", { emailBody, context }),
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
};
