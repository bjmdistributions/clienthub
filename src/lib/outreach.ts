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
  // R-581, worked out on the server (absent from a server before it):
  /** The list it came in on: its import's name. */
  list?: string;
  /** The phone written plainly, "(201) 360-6143", and its ten digits ("" when it is not a US number). */
  phone_shown?: string;
  phone_digits?: string;
  emailed?: boolean;
  first_email_at?: string;
  replied?: boolean;
  /** Called or emailed and never heard back. */
  no_reply?: boolean;
  texted?: { at: string; by: string } | null;
  said?: Said | null;
}

/** R-581: one thing they said or we heard: a reply's gist and tags, a call's outcome and note, or a note. */
export interface Said { kind: "reply" | "call" | "note"; outcome: string; text: string; tags: string[]; at: string; by: string }

export interface LeadListName { name: string; total: number; emailed: number; replied: number; texted: number; suppliers: number }
export interface MapPin { id: string; lat: number; lng: number; place: "street" | "city" }
export interface MapAnswer { pins: MapPin[]; pending: number; unplaced: number; problem: "" | "no_key" | "key_refused" }

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
  /** R-581: each list, in the order they came in. */
  lists?: LeadListName[];
}

export interface LeadEvent { id: string; kind: string; outcome: string; subject: string; body: string; at: string; by: string }
export interface QueuedEmail { id: string; subject: string; body: string; status: string; error: string; bump: boolean; created_at: string; sent_at: string }
export interface LeadDetail { lead: Lead; events: LeadEvent[]; queue: QueuedEmail[]; said?: Said[] }

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
  importSheet: (name: string, data: string, source = "") =>
    call<{ added: number; skipped: Skipped[]; tab: string }>("POST", "/api/outreach/import", { name, data, source }),
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
  texted: (leadId: string, texted: boolean) => call<{ texted: boolean }>("POST", `/api/outreach/leads/${id(leadId)}/texted`, { texted }),
  renameList: (from: string, to: string) => call<{ renamed: number }>("POST", "/api/outreach/lists/rename", { from, to }),
  map: () => call<MapAnswer>("GET", "/api/outreach/map"),
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

// ── R-581: lists, filters, the map's colours, what they said ──

/** Where a warehouse stands on the map and in the legend, furthest first. */
export type Stage = "stop" | "supplier" | "replied" | "emailed" | "not_emailed";
export const STAGES: [Stage, string, string][] = [
  ["not_emailed", "Not emailed", "--c-muted"], ["emailed", "Emailed, no reply", "--c-step-now"], ["replied", "Replied", "--c-accent"],
  ["supplier", "Supplier", "--c-success"], ["stop", "Do not contact", "--c-danger"],
];
export function stageOf(l: Lead): Stage {
  if (l.status === "do_not_contact") return "stop";
  if (l.status === "supplier") return "supplier";
  if (l.replied) return "replied";
  return l.emailed ? "emailed" : "not_emailed";
}

/** The chips over the warehouses. `due` and `all` as before; the rest read what the server worked out. */
export const REACH: [string, string][] = [
  ["due", "Due today"], ["all", "All"], ["not_emailed", "Not emailed"], ["emailed", "Emailed"], ["replied", "Replied"],
  ["no_reply", "No reply yet"], ["texted", "Texted"],
];
export function inReach(l: Lead, f: string): boolean {
  switch (f) {
    case "due": return !!l.due;
    case "not_emailed": return !l.emailed;
    case "emailed": return !!l.emailed;
    case "replied": return !!l.replied;
    case "no_reply": return !!l.no_reply;
    case "texted": return !!l.texted;
    default: return true;
  }
}

/** The line under a warehouse saying what they said, or what the last call or note was. "" with nothing. */
export function saidLine(s: Said | null | undefined): string {
  if (!s) return "";
  if (s.kind === "reply") return s.text ? `They said: ${s.text}` : "They replied";
  if (s.kind === "call") return `Call: ${OUTCOME_LABEL[s.outcome] ?? s.outcome}${s.text ? `. ${s.text}` : ""}`;
  return `Note: ${s.text}`;
}

/** "Emailed Oct 20", "Emailed" (set by hand, no email on record), or "Not emailed". */
export function emailedLine(l: Lead): string {
  if (!l.emailed) return "Not emailed";
  const t = l.first_email_at ? new Date(l.first_email_at) : null;
  return t && !isNaN(t.getTime()) ? `Emailed ${t.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Emailed";
}

/** Pins of one city sit on one point: spread them in a small ring so each can be clicked. */
export function spread(pins: MapPin[]): MapPin[] {
  const seen = new Map<string, number>();
  return pins.map((p) => {
    const k = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (n === 0) return p;
    const a = n * 2.4, r = 0.012 * Math.sqrt(n);
    return { ...p, lat: p.lat + r * Math.sin(a), lng: p.lng + r * Math.cos(a) };
  });
}
