// R-449 / R-445 / R-446 / R-447 / R-448: the desktop's calls for Bills, Spending, True profit
// and phone notifications (src-tauri/src/bills.rs). The shapes are the build spec's JSON, the
// same ones the server routes return to the phone, so a field is never renamed here alone.
import { invoke } from "@tauri-apps/api/core";

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "annual";
/** 'ignored' rows are dismissed suggestions; the list never returns them. */
export type BillStatus = "active" | "archived" | "ignored";
export type BillMethod = "zelle" | "ach" | "card" | "check" | "other" | "";
export type BillStateStatus = "overdue" | "due_soon" | "paid" | "upcoming" | "not_seen" | "archived";
export type PeriodState = "paid" | "late" | "missed" | "due";

export interface BillPeriod {
  due: string;
  paid_on: string | null;
  paid_amount: number;
  state: PeriodState;
}

export interface BillState {
  status: BillStateStatus;
  next_due: string | null;
  days_until: number | null;
  /** Unpaid due dates the bank feed has caught up with, oldest first. */
  overdue: string[];
  last_paid: string | null;
  last_amount: number | null;
  current_paid: boolean;
  paid_count: number;
  on_time_count: number;
  /** Newest first, at most 12. */
  history: BillPeriod[];
}

export interface BillOut {
  id: string;
  name: string;
  /** "Shows in the bank as": every word must appear in the payee or description. */
  payee_match: string;
  /** 0 means the amount varies. */
  amount: number;
  tolerance_pct: number;
  cadence: Cadence;
  anchor_date: string;
  category: string;
  method: BillMethod;
  website: string;
  /** A small data:image/png or jpeg data URL, or ''. */
  logo: string;
  notes: string;
  status: BillStatus;
  created_at: string;
  updated_at: string;
  monthly: number;
  state: BillState;
}

export interface BillsSummary {
  active: number;
  monthly_total: number;
  due_30_total: number;
  due_30_count: number;
  overdue_count: number;
  overdue_total: number;
  due_soon_count: number;
  paid_this_month: number;
  expected_this_month: number;
}

export interface UpcomingDue {
  bill_id: string;
  due: string;
  amount: number;
  paid: boolean;
}

export interface BillsList {
  today: string;
  feed_latest: string | null;
  /** Active bills first (soonest due first), then archived. */
  bills: BillOut[];
  summary: BillsSummary;
  upcoming: UpcomingDue[];
  /** How many repeating payments the bank history suggests tracking. */
  suggestions: number;
}

export interface BillPayment {
  id: string;
  bank_txn_id: string;
  period: string;
  status: "auto" | "confirmed" | "rejected";
  amount: number;
  posted_at: string;
  payee: string;
  memo: string;
  account_id: string;
}

export interface BillDetail {
  bill: BillOut;
  /** Newest first. Rejected ones are included so they can be undone. */
  payments: BillPayment[];
}

/** The columns a person edits. On an update only the keys present change. */
export interface BillFields {
  name: string;
  payee_match: string;
  amount: number;
  tolerance_pct: number;
  cadence: Cadence;
  anchor_date: string;
  category: string;
  method: BillMethod;
  website: string;
  logo: string;
  notes: string;
}

export interface BillCandidate {
  key: string;
  name: string;
  cadence: Cadence;
  amount: number;
  tolerance_pct: number;
  anchor: string;
  next_due: string;
  category: string;
  count: number;
  first_paid: string;
  last_paid: string;
  monthly: number;
  /** A plain sentence saying why it looks like a bill. */
  why: string;
}

export interface PickTxn {
  id: string;
  posted_at: string;
  amount: number;
  payee: string;
  memo: string;
  account_id: string;
  /** The due date it would pay. */
  due: string;
}

export interface PreviewTxn {
  id: string;
  posted_at: string;
  amount: number;
  payee: string;
}

export interface BillsAlertItem {
  id: string;
  name: string;
  status: "overdue" | "due_soon";
  next_due: string | null;
  days_until: number | null;
  overdue: string[];
}

export interface BillsAlerts {
  overdue_count: number;
  due_soon_count: number;
  items: BillsAlertItem[];
}

export interface CategorySpendRow {
  category: string;
  label: string;
  amount: number;
  prev_amount: number;
  count: number;
}

export interface PayeeSpendRow {
  payee: string;
  /** The bill this payee is, or ''. */
  bill_id: string;
  amount: number;
  count: number;
}

export interface MonthSpendRow {
  month: string;
  fixed: number;
  other: number;
}

export interface SpendInsight {
  kind: "up" | "down" | "new" | "info";
  text: string;
}

export interface SpendReport {
  total: number;
  prev_total: number;
  /** Money that went out to bills. */
  fixed: number;
  /** Everything else that counts as spending. */
  other: number;
  by_category: CategorySpendRow[];
  by_payee: PayeeSpendRow[];
  months: MonthSpendRow[];
  insights: SpendInsight[];
}

export interface ProfitMonthRow {
  month: string;
  profit: number;
  shipping: number;
  fees: number;
  true_net: number;
  operating: number;
  true_profit: number;
}

export interface ProfitTotals {
  profit: number;
  shipping: number;
  fees: number;
  true_net: number;
  operating: number;
  true_profit: number;
}

export interface ProfitBlock {
  months: ProfitMonthRow[];
  totals: ProfitTotals;
  /** Shipping already inside deal costs (already in deal profit). */
  shipping_in_deals: number;
}

export interface SpendingResponse {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  report: SpendReport;
  /** Money out with no category yet and no bill behind it. */
  unbooked: { count: number; amount: number };
  /** Null when the answer holds no deal profit (the caller may not see it): show Spending instead. */
  profit: ProfitBlock | null;
}

export interface PushPrefs {
  forms: boolean;
  bills: boolean;
  inventory: boolean;
  /** R-450: a booking sent to Logistics, as a push and as an email. Absent on an older server. */
  logistics?: boolean;
  logistics_email?: boolean;
}

export interface PushPrefsResponse {
  prefs: PushPrefs;
  /** The categories this person's permissions let them receive. */
  allowed: PushPrefs;
  devices: { id: string; platform: string; label: string; last_seen_at: string }[];
  /** False while the server has no APNs key. */
  configured: boolean;
}

export const billsApi = {
  list: () => invoke<BillsList>("bills_list"),
  alerts: () => invoke<BillsAlerts>("bills_alerts"),
  get: (id: string) => invoke<BillDetail>("bills_get", { id }),
  /** id null creates. On an update send only the keys that changed (logo especially). */
  save: (id: string | null, fields: Partial<BillFields>) =>
    invoke<{ bill: BillOut; linked: number }>("bills_save", { id, fields }),
  archive: (id: string, archived: boolean) => invoke<{ bill: BillOut }>("bills_archive", { id, archived }),
  detect: () => invoke<{ candidates: BillCandidate[] }>("bills_detect").then((r) => r.candidates || []),
  ignore: (key: string, name: string) => invoke<{ ok: boolean }>("bills_ignore", { key, name }),
  candidates: (id: string) => invoke<{ txns: PickTxn[] }>("bills_candidates", { id }).then((r) => r.txns || []),
  link: (id: string, bankTxnId: string) => invoke<{ ok: boolean }>("bills_link", { id, bankTxnId }),
  reject: (pid: string) => invoke<{ ok: boolean }>("bills_reject", { pid }),
  restore: (pid: string) => invoke<{ ok: boolean }>("bills_restore", { pid }),
  preview: (payeeMatch: string, amount: number, tolerancePct: number) =>
    invoke<{ count: number; txns: PreviewTxn[] }>("bills_preview", { payeeMatch, amount, tolerancePct }),
  /** A 128px PNG data URL from the website's own icon (the server fetches it). */
  icon: (site: string) => invoke<{ logo: string }>("bills_icon", { site }).then((r) => r.logo),
  spending: (from: string, to: string) => invoke<SpendingResponse>("bills_spending", { from, to }),
};

export const pushApi = {
  get: () => invoke<PushPrefsResponse>("push_prefs_get"),
  set: (prefs: Partial<PushPrefs>) => invoke<PushPrefsResponse>("push_prefs_set", { prefs }),
};
