import { invoke } from "@tauri-apps/api/core";

// R-546 Cold calls. The list lives on the server (/api/outreach/*), reached through one Tauri command
// that refuses any other path and rejects with the server's own sentence. The status rules live on the
// server too, so this screen and the phone's can never disagree.

export type LeadStatus = "new" | "called" | "emailed" | "talking" | "has_goods" | "supplier" | "not_now" | "do_not_contact";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New", called: "Called", emailed: "Emailed", talking: "Talking", has_goods: "Has goods",
  supplier: "Supplier", not_now: "Not now", do_not_contact: "Do not contact",
};
export const STATUSES = Object.keys(STATUS_LABEL) as LeadStatus[];

export const KIND_LABEL: Record<string, string> = {
  prep: "Prep center", ecom: "Ecom 3PL", apparel: "Apparel 3PL", forwarder: "Forwarder", other: "Other",
};

export const OUTCOMES: [string, string][] = [
  ["no_answer", "No answer"], ["voicemail", "Left a voicemail"], ["send_info", "Send info"], ["call_back", "Call back"],
  ["has_goods", "Has goods"], ["not_interested", "Not interested"], ["wrong_number", "Wrong number"],
];
export const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(OUTCOMES);

export const TOKENS: [string, string][] = [
  ["{first_name}", "First name"], ["{company}", "Company"], ["{city}", "City"], ["{personal_line}", "Personal line"], ["{from_name}", "Your name"],
];

/** A cold email may go to a lead in one of these (the server checks again before every send). */
export const sendable = (s: string) => s === "new" || s === "called" || s === "emailed" || s === "not_now";

export interface Lead {
  id: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  kind: string;
  website: string;
  status: LeadStatus;
  next_touch: string;
  last_touch_at: string;
  personal_line: string;
  notes: string;
  source: string;
  supplier_id: string;
  due?: boolean;
  queued?: number;
  emails_sent?: number;
}

export interface OutreachSettings {
  send_from: string;
  from_name: string;
  address_line: string;
  daily_cap: number;
  pump_seen_at: string;
  pump_note: string;
  hours: string;
  subject: string;
  body: string;
  bump: string;
}

export interface LeadList {
  today: string;
  due: number;
  leads: Lead[];
  counts: Partial<Record<LeadStatus, number>>;
  queue: { waiting: number; sent_today: number; failed: number };
  settings: OutreachSettings;
  /** Replies not answered yet (R-563); absent from a server before deploy-276. */
  replies_waiting?: number;
}

export interface LeadEvent { id: string; kind: string; outcome: string; subject: string; body: string; at: string; by: string }
export interface QueuedEmail { id: string; subject: string; body: string; status: string; error: string; bump: boolean; created_at: string; sent_at: string }
export interface LeadDetail { lead: Lead; events: LeadEvent[]; queue: QueuedEmail[] }

export interface DraftEmail { lead_id: string; company: string; to: string; subject: string; body: string; reply_to: string; bump: boolean }
export interface Skipped { lead_id?: string; row?: number; company: string; reason: string }

/** R-563: one reply, with what they said at a glance (rules on the server, no AI) and whether it was answered. */
export interface OutreachReply {
  id: string; lead_id: string; company: string; contact_name: string; email: string; status: LeadStatus;
  subject: string; at: string; body: string; new_text: string; gist: string; tags: string[]; phone: string;
  answered: boolean; answered_how: string; answered_at: string;
  yours: { subject: string; body: string; at: string } | null;
}

export const REPLY_TAG: Record<string, [string, "neutral" | "step" | "accent" | "warning" | "success" | "danger"]> = {
  stop: ["Asked to stop", "danger"], away: ["Out of office", "neutral"], no: ["Not interested", "neutral"],
  stock: ["Has stock", "success"], call: ["Wants a call", "accent"], details: ["Wants details", "step"],
  elsewhere: ["Points to someone", "step"],
};

export const ANSWERED_HOW: Record<string, string> = {
  answer: "You emailed them", call: "You called", email: "Email sent", answered: "Marked answered", stop: "Asked to stop",
};

export interface PumpState { on: boolean; login: string; inboxes: string[]; last_error: string; last_sent_at: string; watching: string }

const call = <T>(method: "GET" | "POST", path: string, body?: unknown) =>
  invoke<T>("outreach_request", { method, path, body: body ?? null });
const id = (s: string) => encodeURIComponent(s);

export const outreach = {
  list: () => call<LeadList>("GET", "/api/outreach/leads"),
  get: (leadId: string) => call<LeadDetail>("GET", `/api/outreach/leads/${id(leadId)}`),
  add: (fields: Partial<Lead>) => call<{ id: string }>("POST", "/api/outreach/leads", fields),
  edit: (leadId: string, fields: Partial<Lead>) => call<{ ok: boolean }>("POST", `/api/outreach/leads/${id(leadId)}`, fields),
  remove: (leadId: string) => call<{ ok: boolean }>("POST", `/api/outreach/leads/${id(leadId)}/remove`, {}),
  logCall: (leadId: string, outcome: string, note: string, next_touch: string) =>
    call<{ status: LeadStatus; next_touch: string }>("POST", `/api/outreach/leads/${id(leadId)}/call`, { outcome, note, next_touch }),
  note: (leadId: string, text: string) => call<{ ok: boolean }>("POST", `/api/outreach/leads/${id(leadId)}/note`, { text }),
  makeSupplier: (leadId: string) => call<{ supplier_id: string }>("POST", `/api/outreach/leads/${id(leadId)}/supplier`, {}),
  importSheet: (name: string, data: string) =>
    call<{ added: number; skipped: Skipped[]; tab: string }>("POST", "/api/outreach/import", { name, data }),
  preview: (lead_ids: string[], subject: string, body: string) =>
    call<{ emails: DraftEmail[]; skipped: Skipped[] }>("POST", "/api/outreach/preview", { lead_ids, subject, body }),
  bumps: (body: string) => call<{ emails: DraftEmail[]; skipped: Skipped[] }>("POST", "/api/outreach/bumps", { body }),
  queue: (emails: Pick<DraftEmail, "lead_id" | "subject" | "body" | "reply_to" | "bump">[]) =>
    call<{ queued: number; skipped: Skipped[] }>("POST", "/api/outreach/queue", { emails }),
  cancel: (queueId: string) => call<{ ok: boolean }>("POST", `/api/outreach/queue/${id(queueId)}/cancel`, {}),
  retry: (queueId: string) => call<{ ok: boolean }>("POST", `/api/outreach/queue/${id(queueId)}/retry`, {}),
  saveSettings: (s: Pick<OutreachSettings, "send_from" | "from_name" | "address_line" | "daily_cap">) =>
    call<OutreachSettings>("POST", "/api/outreach/settings", s),
  replies: () => call<{ replies: OutreachReply[]; waiting: number }>("GET", "/api/outreach/replies"),
  markAnswered: (replyId: string) => call<{ ok: boolean }>("POST", `/api/outreach/replies/${id(replyId)}/answered`, {}),
  pump: () => invoke<PumpState>("outreach_pump_get"),
  setPump: (on: boolean) => invoke<void>("outreach_pump_set", { on }),
};

/** "Due today", "Due since Tue, Oct 20", "Next Fri, Oct 23", or "" with no date. */
export function nextLine(next: string, today: string): string {
  if (!next) return "";
  if (next === today) return "Due today";
  return (next < today ? "Due since " : "Next ") + dayLabel(next);
}

export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
