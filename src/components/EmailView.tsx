import { useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { toast } from "./Toast";
import { api, ParsedEmail, EmailDraft, Client, Newsletter, Category, NewsletterSendResult, ScheduledSend, BuyerTier } from "../lib/api";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import VariablePicker, { VariableReference } from "./VariablePicker";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { FromPicker, useSendFromOptions } from "./FromPicker";
import { NewsletterSchedule } from "../lib/api";
import {
  AudienceFilters, AudienceRow, Purchase, buyerFacts, categoryOptions, clientCategories, countReach,
  defaultFilters, filterReason, lockReason, resolveAudience, stateOptions,
} from "../lib/audience";
import {
  Sparkles, RefreshCw, Mail, Send, Inbox, AlertCircle, FileEdit, Trash2,
  Users, X, Search, ChevronDown, Megaphone, CheckCircle2, Paperclip, Clock,
  Repeat, Plus, Power, Check, Lock,
} from "lucide-react";

type Mode = "inbox" | "compose" | "drafts" | "newsletter" | "recurring";

export default function EmailView() {
  const [mode, setMode] = useState<Mode>("newsletter");
  const [emails, setEmails] = useState<ParsedEmail[]>([]);
  const [selected, setSelected] = useState<ParsedEmail | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftCount, setDraftCount] = useState(0);

  const refreshDraftCount = async () => {
    try {
      const drafts = await api.listDrafts("pending");
      setDraftCount(drafts.length);
    } catch {}
  };

  useEffect(() => {
    refreshDraftCount();
  }, []);

  // R-278: the Inbox reads what every scan recorded — the background watcher included — so
  // it is never empty just because the watcher got to the mail before this button did.
  const refresh = async () => {
    setScanning(true);
    setError(null);
    try {
      setEmails(await api.refreshInbox(7));
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setScanning(false);
    }
  };

  const inboxLoaded = useRef(false);
  useEffect(() => {
    if (mode !== "inbox") return;
    let live = true;
    api.listInboxMessages().then((list) => {
      if (!live) return;
      setEmails(list);
      // First visit on this device: nothing recorded yet, so read the last week once.
      if (list.length === 0 && !inboxLoaded.current) refresh();
      inboxLoaded.current = true;
    }).catch(() => {});
    // Unsubscribe through the promise itself: leaving the tab before `listen` resolves must
    // still remove the listener.
    const sub = listen("inbox-updated", () => { api.listInboxMessages().then((l) => { if (live) setEmails(l); }).catch(() => {}); });
    return () => { live = false; sub.then((u) => u()).catch(() => {}); };
  }, [mode]);

  const emailKey = (e: ParsedEmail) => e.message_id || `${e.source}:${e.uid}`;

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold text-ink tracking-tight">Newsletter</h2>
        <p className="text-[12px] text-muted mt-0.5">Send newsletters, read replies, and manage drafts.</p>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit mb-5">
        {(["newsletter", "recurring", "inbox", "drafts", "compose"] as const).map((m) => {
          const icons = { inbox: Inbox, drafts: FileEdit, compose: Mail, newsletter: Megaphone, recurring: Repeat };
          const labels = { inbox: "Inbox", drafts: "Drafts", compose: "Compose", newsletter: "Newsletter", recurring: "Recurring" };
          const Icon = icons[m];
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${
                mode === m ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"
              }`}
            >
              <Icon size={13} />
              {labels[m]}
              {m === "drafts" && draftCount > 0 && (
                <span className="bg-accent text-on-accent text-[10px] font-semibold rounded-full px-1.5 py-0.5 leading-none">
                  {draftCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {mode === "inbox" && (
        <div>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <p className="text-[13px] text-muted">
              Recent mail from your connected inboxes. New mail appears on its own while the app is open.
            </p>
            <button
              onClick={refresh}
              disabled={scanning}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Checking…" : "Refresh"}
            </button>
          </div>

          {error && (
            <div className="bg-danger-bg border border-danger text-danger-ink px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Email list */}
            <div className="bg-surface border border-line rounded-lg overflow-hidden min-w-0">
              <div className="px-4 py-3 border-b border-line text-[13px] font-semibold text-ink-2">
                Recent ({emails.length})
              </div>
              <div className="max-h-[600px] overflow-auto">
                {emails.map((e) => (
                  <button
                    key={emailKey(e)}
                    onClick={() => setSelected(e)}
                    className={`w-full text-left px-4 py-3.5 border-b border-line transition-colors ${
                      selected && emailKey(selected) === emailKey(e) ? "bg-accent/10" : "hover:bg-surface-2"
                    }`}
                  >
                    <div className="font-medium text-[13px] text-ink truncate flex items-center gap-1.5">
                      <span className="truncate">{e.from_name || e.from}</span>
                      {e.source && <StatusPill tone="neutral">{e.source}</StatusPill>}
                    </div>
                    <div className="text-[13px] text-ink-2 truncate mt-0.5">{e.subject}</div>
                    <div className="text-[12px] text-muted truncate mt-0.5">
                      {e.body_text.slice(0, 80)}
                    </div>
                  </button>
                ))}
                {emails.length === 0 && !scanning && (
                  <div className="px-4 py-12 flex flex-col items-center">
                    <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3">
                      <Inbox size={18} />
                    </div>
                    <div className="text-[13px] text-muted">No mail in the last week. Check that an inbox is connected in Settings, then refresh.</div>
                  </div>
                )}
              </div>
            </div>

            {/* Email detail */}
            <div className="bg-surface border border-line rounded-lg p-5 min-w-0">
              {selected ? (
                <EmailDetail key={emailKey(selected)} email={selected} onDraftsChanged={refreshDraftCount} />
              ) : (
                <div className="h-full flex items-center justify-center text-[14px] text-muted">
                  Select an email to view.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {mode === "compose" && <ComposeView />}
      {mode === "drafts" && <DraftsTab onAction={refreshDraftCount} />}
      {mode === "newsletter" && <NewsletterTab />}
      {mode === "recurring" && <RecurringTab />}
    </div>
  );
}

function EmailDetail({ email, onDraftsChanged }: { email: ParsedEmail; onDraftsChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const replySubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
  // Coming back to a message picks up the reply already saved for it.
  useEffect(() => {
    if (!email.message_id) return;
    let live = true;
    api.listDrafts("pending").then((list) => {
      const d = list.find((x) => x.in_reply_to_message_id === email.message_id);
      if (live && d) { setDraftId(d.id); setDraft(d.body); setReplying(true); }
    }).catch(() => {});
    return () => { live = false; };
  }, [email.message_id]);
  const [extracted, setExtracted] = useState<any>(null);
  const [loading, setLoading] = useState<"draft" | "extract" | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [tone, setTone] = useState<string>(() => localStorage.getItem("clienthub_draft_tone") || "neutral");
  const [replyFrom, setReplyFrom] = useState<string | undefined>(undefined);
  const fromOptions = useSendFromOptions();

  // R-278: a reply is a real draft from the moment it exists, so leaving the message keeps it
  // in the Drafts tab (nothing used to write that table at all).
  const persistDraft = async (body: string): Promise<string | null> => {
    const d = await api.saveDraft(draftId, email.from, replySubject, body, email.message_id);
    setDraftId(d.id);
    onDraftsChanged();
    return d.id;
  };

  const handleDraft = async () => {
    setLoading("draft");
    try {
      const reply = await api.aiDraftReply(email.body_text, undefined, tone);
      setDraft(reply);
      setReplying(true);
      await persistDraft(reply);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setLoading(null); }
  };

  const handleSaveDraft = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try { await persistDraft(draft); toast("Saved to Drafts"); }
    catch (e: any) { toast(String(e), "error"); }
    finally { setSaving(false); }
  };

  const handleExtract = async () => {
    setLoading("extract");
    try {
      setExtracted(await api.aiExtractData(email.body_text));
    } catch (e: any) { toast(String(e), "error"); }
    finally { setLoading(null); }
  };

  const handleSend = async () => {
    if (!draft.trim()) return;
    setSending(true);
    try {
      // Through the draft, so the saved copy leaves Drafts and the reply is threaded.
      const id = await persistDraft(draft);
      if (id) await api.sendDraft(id, replyFrom);
      else await api.sendEmail(email.from, replySubject, draft, undefined, replyFrom, email.message_id);
      setDraftId(null);
      setDraft("");
      setReplying(false);
      onDraftsChanged();
      setSent(true);
      toast("Reply sent");
      setTimeout(() => setSent(false), 2000);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setSending(false); }
  };

  return (
    <div>
      {/* Metadata */}
      <div className="border-b border-line pb-4 mb-4">
        <div className="text-[13px]">
          <span className="text-[12px] font-medium text-muted">From: </span>
          <span className="font-medium text-ink">
            {email.from_name || email.from} &lt;{email.from}&gt;
          </span>
        </div>
        <div className="text-[13px] mt-0.5">
          <span className="text-[12px] font-medium text-muted">Subject: </span>
          <span className="text-ink">{email.subject}</span>
        </div>
        {email.date && (
          <div className="text-[11px] text-muted mt-1">
            {new Date(email.date).toLocaleString()}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="bg-surface-2 border border-line px-4 py-3 rounded-lg text-[13px] text-ink-2 whitespace-pre-wrap max-h-48 overflow-auto mb-4">
        {email.body_text}
      </div>

      {/* AI actions */}
      <div className="flex gap-2 mb-4">
        <select
          value={tone}
          onChange={(e) => { setTone(e.target.value); localStorage.setItem("clienthub_draft_tone", e.target.value); }}
          className="border border-line-3 px-3 h-9 rounded-md text-[13px] focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="neutral">Neutral</option>
          <option value="formal">Formal</option>
          <option value="casual">Casual</option>
        </select>
        <button
          onClick={() => setReplying(true)}
          disabled={replying}
          className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 disabled:opacity-50"
        >
          <Send size={12} /> Reply
        </button>
        <button
          onClick={handleDraft}
          disabled={loading !== null}
          className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 disabled:opacity-50"
        >
          {loading === "draft" ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
          Draft reply
        </button>
        <button
          onClick={handleExtract}
          disabled={loading !== null}
          className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-md text-[14px] disabled:opacity-50"
        >
          Extract Data
        </button>
      </div>

      {/* Reply */}
      {(replying || draft) && (
        <div className="mb-4">
          <label className="block text-[12px] font-medium text-ink-2 mb-1">Reply to {email.from}</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full border border-line-3 rounded-lg px-3 py-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={handleSend}
              disabled={sending || !draft.trim()}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 disabled:opacity-50"
            >
              <Send size={12} />
              {sending ? "Sending…" : sent ? "Sent" : "Send reply"}
            </button>
            <button
              onClick={handleSaveDraft}
              disabled={saving || !draft.trim()}
              className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-md text-[14px] disabled:opacity-50"
            >
              {saving ? "Saving…" : draftId ? "Save changes" : "Save to Drafts"}
            </button>
            <FromPicker options={fromOptions} value={replyFrom} onChange={setReplyFrom} />
          </div>
        </div>
      )}

      {/* Extracted data */}
      {extracted && (
        <div>
          <label className="block text-[12px] font-medium text-ink-2 mb-1">Extracted data</label>
          <pre className="bg-surface-2 border border-line px-4 py-3 rounded-lg text-[12px] overflow-auto">
            {JSON.stringify(extracted, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function DraftsTab({ onAction }: { onAction: () => void }) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendFrom, setSendFrom] = useState<Record<string, string | undefined>>({});
  const fromOptions = useSendFromOptions();

  const load = async () => {
    try {
      setDrafts(await api.listDrafts("pending"));
    } catch (e: any) {
      setError(e.toString());
    }
  };

  useEffect(() => { load(); }, []);

  const handleEdit = (d: EmailDraft) => {
    setEditing(d.id);
    setEditBody(d.body);
    setEditSubject(d.subject);
  };

  const handleSave = async (id: string) => {
    try {
      await api.updateDraft(id, editBody, editSubject);
      setEditing(null);
      await load();
    } catch (e: any) { setError(e.toString()); }
  };

  const handleSend = async (id: string) => {
    setLoading(id);
    setError(null);
    try {
      await api.sendDraft(id, sendFrom[id]);
      onAction();
      await load();
    } catch (e: any) { setError(e.toString()); }
    finally { setLoading(null); }
  };

  const handleDiscard = async (id: string) => {
    try {
      await api.discardDraft(id);
      onAction();
      await load();
    } catch (e: any) { setError(e.toString()); }
  };

  return (
    <div>
      {error && (
        <div className="bg-danger-bg border border-danger text-danger-ink px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="py-12 text-center text-[14px] text-muted">No pending drafts.</div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <div key={d.id} className="bg-surface border border-line rounded-lg p-4">
              {editing === d.id ? (
                <div>
                  <input
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    className="border border-line-3 px-3 h-10 rounded-md text-[14px] w-full mb-2 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={6}
                    className="border border-line-3 px-3 py-2.5 rounded-md text-[14px] w-full mb-3 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(d.id)}
                      className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[14px] font-medium"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-md text-[14px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[14px] font-medium text-ink">{d.subject}</div>
                      <div className="text-[12px] text-muted mt-0.5">To: {d.to_addr}</div>
                    </div>
                    <div className="text-[11px] text-muted tabular-nums">
                      {new Date(d.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-[13px] text-ink-2 mt-2 whitespace-pre-wrap line-clamp-3">
                    {d.body}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => handleSend(d.id)}
                      disabled={loading === d.id}
                      className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-md text-[13px] font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <Send size={12} />
                      {loading === d.id ? "Sending…" : "Send"}
                    </button>
                    <button
                      onClick={() => handleEdit(d)}
                      className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-3 h-8 rounded-md text-[13px] flex items-center gap-1"
                    >
                      <FileEdit size={12} /> Edit
                    </button>
                    <button
                      onClick={() => handleDiscard(d.id)}
                      className="text-danger-ink hover:text-danger-ink hover:bg-danger-bg px-3 h-8 rounded-md text-[13px] flex items-center gap-1 border border-transparent hover:border-danger"
                    >
                      <Trash2 size={12} /> Discard
                    </button>
                    <FromPicker options={fromOptions} value={sendFrom[d.id]} onChange={(a) => setSendFrom((s) => ({ ...s, [d.id]: a }))} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ComposeView() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const fromOptions = useSendFromOptions();

  const send = async () => {
    setSending(true);
    try {
      await api.sendEmail(to, subject, body, undefined, from);
      setSent(true);
      setTo(""); setSubject(""); setBody("");
      setTimeout(() => setSent(false), 2000);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setSending(false); }
  };

  return (
    <div className="bg-surface border border-line rounded-lg max-w-2xl overflow-hidden">
      <div className="px-5 py-4 space-y-3">
        <div>
          <label className="block text-[12px] font-medium text-muted mb-1">To</label>
          <input
            placeholder="recipient@example.com"
            className="border border-line-3 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-muted mb-1">Subject</label>
          <input
            placeholder="Subject"
            className="border border-line-3 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-muted mb-1">Message</label>
          <textarea
            placeholder="Write your message…"
            rows={12}
            className="w-full border border-line rounded-lg px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={send}
            disabled={sending || !to || !subject}
            className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50"
          >
            <Send size={14} />
            {sending ? "Sending…" : sent ? "Sent" : "Send"}
          </button>
          <FromPicker options={fromOptions} value={from} onChange={setFrom} />
        </div>
      </div>
    </div>
  );
}

// One audience choice. The number is who that choice alone would reach (countReach).
function AudienceChip({ on, count, exclude, onClick, title, children }: {
  on: boolean; count?: number; exclude?: boolean; onClick: () => void; title?: string; children: ReactNode;
}) {
  const onCls = exclude ? "bg-danger-bg text-danger-ink border-danger-ink/30" : "bg-accent text-on-accent border-accent";
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={on}
      className={`h-6 max-w-full px-2.5 rounded-full border text-[11px] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
        on ? onCls : `border-line text-ink-2 hover:bg-surface-2 ${count === 0 ? "opacity-50" : ""}`
      }`}>
      <span className="truncate min-w-0">{children}</span>
      {count !== undefined && <span className={`tabular-nums ${on ? "opacity-80" : "text-muted"}`}>{count}</span>}
    </button>
  );
}

function NewsletterTab() {
  const [clients, setClients] = useState<Client[]>([]);
  // R-297: the audience is the filters' result plus hand edits, so the number at the top is
  // exactly who gets the email — no separate "selected" list that can disagree with it.
  const [filters, setFilters] = useState<AudienceFilters>(defaultFilters());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [showAllCats, setShowAllCats] = useState(false);
  const [showAllStates, setShowAllStates] = useState(false);
  const [peopleTab, setPeopleTab] = useState<"in" | "out">("in");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiTone, setAiTone] = useState("neutral");
  const [aiLoading, setAiLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState("");
  const [sendPct, setSendPct] = useState(0);
  const [sendResult, setSendResult] = useState<NewsletterSendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [templates, setTemplates] = useState<Newsletter[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null);
  const [attachmentSearch, setAttachmentSearch] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [tiers, setTiers] = useState<BuyerTier[]>([]);
  const [includeRanked, setIncludeRanked] = useState(true);
  const [unsubEnabled, setUnsubEnabled] = useState(true);
  // What {sender_name} resolves to. The send path resolves it from the same company
  // name, so the preview shows the words that actually go out.
  const [senderName, setSenderName] = useState("");
  const [newsletterFrom, setNewsletterFrom] = useState<string | undefined>(undefined);
  const fromOptions = useSendFromOptions();
  useEffect(() => {
    api.buyerTiers().then(setTiers).catch(() => {});
    api.getNewsletterIncludeRanked().then(setIncludeRanked).catch(() => {});
    api.getNewsletterUnsubscribeEnabled().then(setUnsubEnabled).catch(() => {});
    api.getCompanyInfo().then((c) => setSenderName(c?.name?.trim() || "")).catch(() => {});
  }, []);
  const [showFilters, setShowFilters] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState(0);
  const [scheduleCustomDate, setScheduleCustomDate] = useState("");
  const [customBatch, setCustomBatch] = useState(50);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledSends, setScheduledSends] = useState<ScheduledSend[]>([]);
  const [showScheduled, setShowScheduled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocusedRef = useRef<"subject" | "body">("body");

  const defaultSubject = "Update from Ecliptr";
  // Signs off with the {sender_name} token rather than a "[Your name]" placeholder that
  // gets mailed verbatim when nobody remembers to replace it.
  const defaultBody = "Hi {first_name},\n\nI hope you're doing well. I wanted to reach out and share some updates.\n\n[Your message here]\n\nBest regards,\n{sender_name}";

  useEffect(() => {
    api.listClients().then((cs) => {
      setClients(cs);
      // Recipients pre-selected from the Clients view "Email" bulk action.
      // Stashed in sessionStorage to avoid a mount-race with the navigate event.
      // Blacklisted, No bulk and unsubscribed clients in the hand-off stay locked out by the
      // same rules as everyone else (lockReason), so they are not filtered here.
      const raw = sessionStorage.getItem("email_preselect_ids");
      if (raw) {
        sessionStorage.removeItem("email_preselect_ids");
        try { setPicked(new Set<string>(JSON.parse(raw))); } catch { /* ignore malformed stash */ }
      }
    });
    // Inventory > "Send to newsletter" hands over the lots' categories as the category filter.
    const rawCats = sessionStorage.getItem("newsletter_preselect_categories");
    if (rawCats) {
      sessionStorage.removeItem("newsletter_preselect_categories");
      try {
        const cats = (JSON.parse(rawCats) as unknown[]).map(String).filter(Boolean);
        if (cats.length) setFilters((f) => ({ ...f, cats }));
      } catch { /* ignore malformed stash */ }
    }
    api.listCategories().then(setAllCategories);
    api.listNewsletters().then(setTemplates);
    api.listScheduledSends().then(setScheduledSends);
    // Body/subject preloaded from Inventory → "Send to newsletter" (the product list is
    // already composed there). Falls back to the default greeting otherwise.
    const prefill = sessionStorage.getItem("newsletter_prefill_content");
    if (prefill) {
      sessionStorage.removeItem("newsletter_prefill_content");
      try { const p = JSON.parse(prefill); if (p.subject) setSubject(p.subject); if (p.body) setBody(p.body); } catch { /* ignore */ }
    } else if (!subject && !body) { setSubject(defaultSubject); setBody(defaultBody); }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      api.listScheduledSends().then(setScheduledSends);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const activeScheduled = scheduledSends.filter((s) => s.status === "pending" || s.status === "running");
  // A send the server refused (R-278: an attachment it could not include) must be seen, not
  // just drop out of the list above. Last seven days.
  const failedScheduled = scheduledSends.filter((s) => s.status === "failed" && Date.now() - new Date(s.created_at).getTime() < 7 * 86_400_000);
  const sendingNow = templates.filter((t) => t.status === "sending");
  const hasSendingNewsletter = sendingNow.length > 0;
  // Keep the history live while a send is in progress, even if the composer is closed.
  useEffect(() => {
    if (!sending && !hasSendingNewsletter) return;
    const iv = setInterval(() => { api.listNewsletters().then(setTemplates).catch(() => {}); }, 1500);
    return () => clearInterval(iv);
  }, [sending, hasSendingNewsletter]);

  // ── Audience (R-297) ──
  // Memoised so typing a subject or body does not re-run it: every chip counts the whole book.
  const known = useMemo(() => allCategories.map((c) => c.label), [allCategories]);
  const facts = useMemo(() => buyerFacts(tiers), [tiers]);
  const f: AudienceFilters = useMemo(() => ({ ...filters, includeRanked }), [filters, includeRanked]);
  const rows = useMemo(() => resolveAudience(clients, known, f, facts, { removed, added, picked }),
    [clients, known, f, facts, removed, added, picked]);
  const validRecipients = useMemo(() => rows.filter((r) => r.receiving).map((r) => r.client), [rows]);
  const locked = rows.filter((r) => r.lock);
  const filteredOut = rows.filter((r) => !r.lock && !r.receiving);
  const handEdits = removed.size + added.size;
  const with1 = (s: Set<string>, id: string) => new Set(s).add(id);
  const without1 = (s: Set<string>, id: string) => { const n = new Set(s); n.delete(id); return n; };

  // Every chip's number is "pick only this, everything else as it is" (countReach).
  const catOptions = useMemo(() => {
    const opts = categoryOptions(rows, known);
    for (const c of f.cats) {
      if (!opts.some((o) => o.label.toLowerCase() === c.toLowerCase())) opts.push({ label: c, base: 0 });
    }
    return opts;
  }, [rows, known, f]);
  const stOptions = useMemo(() => stateOptions(rows), [rows]);
  const reach = useMemo(() => {
    const n = (patch: Partial<AudienceFilters>) => countReach(rows, { ...f, ...patch });
    return {
      cat: new Map(catOptions.map((o) => [o.label, n({ cats: [o.label] })])),
      state: new Map(showFilters ? stOptions.map((o) => [o.code, n({ states: [o.code] })]) : []),
      tier: new Map(["P", "S", "A", "B", "C"].map((code) => [code, n({ tier: [code] })])),
      all: n({ tier: "all" }), ranked: n({ tier: "ranked" }), first: n({ tier: "first_contact" }),
      any: n({ purchase: "any" }), bought: n({ purchase: "bought" }), never: n({ purchase: "never" }),
    };
  }, [rows, f, catOptions, stOptions, showFilters]);
  const catOn = (label: string) => filters.cats.some((c) => c.toLowerCase() === label.toLowerCase());
  const toggleCat = (label: string) => setFilters((p) => ({
    ...p, cats: catOn(label) ? p.cats.filter((c) => c.toLowerCase() !== label.toLowerCase()) : [...p.cats, label],
  }));
  const toggleState = (code: string) => setFilters((p) => ({
    ...p, states: p.states.includes(code) ? p.states.filter((s) => s !== code) : [...p.states, code],
  }));
  const toggleTier = (code: string) => setFilters((p) => {
    const cur = Array.isArray(p.tier) ? p.tier : [];
    const next = cur.includes(code) ? cur.filter((t) => t !== code) : [...cur, code];
    return { ...p, tier: next.length ? next : "all" };
  });
  const moreFiltersOn = filters.states.length + (filters.exOneTime ? 1 : 0) + (filters.exUnder10k ? 1 : 0) + (filters.exDormant ? 0 : 1);

  // A hand edit is kept only where it differs from what the filters say, so ticking someone
  // back just drops the edit.
  const setPerson = (r: AudienceRow, want: boolean) => {
    if (r.lock) return;
    const id = r.client.id;
    const byFilters = picked ? picked.has(id) : filterReason(r.client, r.cats, f, r.facts) === null;
    setRemoved(!want && byFilters ? with1(removed, id) : without1(removed, id));
    setAdded(want && !byFilters ? with1(added, id) : without1(added, id));
  };
  const resetAudience = () => {
    setFilters(defaultFilters()); setRemoved(new Set()); setAdded(new Set()); setPicked(null);
  };

  const q = clientSearch.trim().toLowerCase();
  const matchesSearch = (r: AudienceRow) => !q ||
    r.client.name.toLowerCase().includes(q) ||
    (r.client.email ?? "").toLowerCase().includes(q) ||
    (r.client.company ?? "").toLowerCase().includes(q);
  const byName = (a: AudienceRow, b: AudienceRow) => a.client.name.localeCompare(b.client.name);
  const receivingRows = rows.filter((r) => r.receiving && matchesSearch(r)).sort(byName);
  const lockedRows = locked.filter(matchesSearch).sort((a, b) => (a.lock ?? "").localeCompare(b.lock ?? "") || byName(a, b));
  const filteredRows = filteredOut.filter(matchesSearch).sort(byName);
  // A large book renders a page of people at a time; search finds anyone past it.
  const SHOW = 300;

  const moreLine = (total: number) => total > SHOW && (
    <div className="text-[11px] text-muted text-center px-4 py-3">Showing {SHOW} of {total}. Search to find anyone else.</div>
  );

  const personRow = (r: AudienceRow) => {
    const c = r.client;
    const catText = r.cats.length ? r.cats.slice(0, 2).join(", ") + (r.cats.length > 2 ? ` +${r.cats.length - 2}` : "") : "No category";
    const tone = r.lock === "No email" ? "warning" : r.lock ? "danger" : "neutral";
    return (
      <button key={c.id} type="button" disabled={!!r.lock} onClick={() => setPerson(r, !r.receiving)}
        title={`${c.email || "No email"}${c.company ? `, ${c.company}` : ""}${r.cats.length > 2 ? `\n${r.cats.join(", ")}` : ""}`}
        className="w-full text-left px-3 py-2 flex items-center gap-2.5 border-b border-line-2 enabled:hover:bg-surface-2 disabled:cursor-default transition-colors">
        <span className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border ${
          r.lock ? "border-transparent text-faint" : r.receiving ? "bg-accent border-accent text-on-accent" : "border-line-3"
        }`}>
          {r.lock ? <Lock size={12} /> : r.receiving ? <Check size={11} strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[12px] font-medium truncate ${r.lock ? "text-muted" : "text-ink"}`}>{c.name}</span>
          <span className="block text-[10.5px] text-muted truncate">{catText}</span>
        </span>
        {r.reason ? <StatusPill tone={tone}>{r.reason}</StatusPill>
          : r.facts?.bought ? <StatusPill>{r.facts.deals > 0 ? `Bought ${r.facts.deals}×` : "Bought"}</StatusPill>
          : null}
      </button>
    );
  };

  const addManualEmail = async () => {
    const addr = manualEmail.trim();
    if (!addr || !addr.includes("@")) return;
    const existing = clients.find((c) => c.email?.toLowerCase() === addr.toLowerCase());
    if (existing) {
      const why = lockReason(existing);
      if (why) { toast(`${existing.name} can't receive bulk email: ${why.toLowerCase()}`, "error"); return; }
      const row = rows.find((r) => r.client.id === existing.id);
      if (row) setPerson(row, true);
    } else {
      const newClient = await api.createClient({
        name: addr.split("@")[0],
        email: addr,
        needs_review: true,
        lead_status: "prospect",
      });
      setClients(await api.listClients());
      setAdded(with1(added, newClient.id));
    }
    setManualEmail("");
  };

  const insertVariable = (token: string) => {
    if (lastFocusedRef.current === "subject") {
      const el = subjectRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const before = subject.slice(0, start);
      const after = subject.slice(end);
      setSubject(before + token + after);
      setTimeout(() => { el.selectionStart = el.selectionEnd = start + token.length; }, 0);
    } else {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const before = body.slice(0, start);
      const after = body.slice(end);
      setBody(before + token + after);
      setTimeout(() => { el.selectionStart = el.selectionEnd = start + token.length; }, 0);
    }
  };

  const generateAI = async () => {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const result = await api.aiDraftNewsletter(aiPrompt, aiTone);
      setBody(result);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setAiLoading(false); }
  };

  const saveTemplate = async () => {
    if (!subject.trim() && !body.trim()) return;
    await api.saveNewsletter(null, subject, body);
    api.listNewsletters().then(setTemplates);
  };

  const pickFile = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "All", extensions: ["*"] }] });
    if (selected) setAttachmentPath(selected as string);
  };

  const loadTemplate = (nl: Newsletter) => {
    setSubject(nl.subject);
    setBody(nl.body);
  };

  const deleteTemplate = async (t: Newsletter) => {
    if (!confirm(`Delete template "${t.subject || "Untitled"}"? This cannot be undone.`)) return;
    const prev = templates;
    setTemplates(prev.filter((x) => x.id !== t.id));
    try {
      await api.deleteNewsletter(t.id);
    } catch {
      setTemplates(prev);
    }
  };

  const handleSend = async () => {
    const count = validRecipients.length;
    if (!confirm(`Send to ${count} recipient${count !== 1 ? "s" : ""}? Each will receive an individual email. This cannot be undone.`)) return;
    setSending(true);
    setSendResult(null);
    setSendError(null);
    setShowErrors(false);
    setSendProgress(`0 / ${count} sent`);
    setSendPct(0);
    const unlisten = await listen<{ total: number; done: number }>("newsletter_send_progress", (e) => {
      const { done, total } = e.payload;
      setSendProgress(`${done} / ${total} sent`);
      setSendPct(total > 0 ? Math.round((done / total) * 100) : 0);
    });
    try {
      const nl = await api.saveNewsletter(null, subject, body);
      const result = await api.sendNewsletter(nl.id, validRecipients.map((c) => c.id), subject, body, attachmentPath, newsletterFrom);
      setSendResult(result);
      setSendProgress("");
      api.listNewsletters().then(setTemplates);
    } catch (e: any) {
      setSendProgress("");
      setSendError(String(e));
    } finally { unlisten(); setSending(false); }
  };

  const handleSchedule = async () => {
    if (validRecipients.length === 0 || !subject.trim() || !body.trim()) return;
    setScheduling(true);
    setSendError(null);
    try {
      const now = new Date();
      let intervalSeconds: number;
      let scheduledAt: string;
      let batchPerHour = 0;

      if (scheduleInterval === 0) {
        intervalSeconds = 0;
        scheduledAt = now.toISOString();
      } else if (scheduleInterval === -1) {
        const parsed = new Date(scheduleCustomDate);
        if (isNaN(parsed.getTime())) { setSendError("Invalid date"); setScheduling(false); return; }
        if (parsed <= new Date(now.getTime() + 60000)) { setSendError("Must be at least 1 minute in the future"); setScheduling(false); return; }
        // R-274: the wait until the chosen time used to double as the spread, so a send set
        // for next week trickled out over a further week. Now it starts at the chosen time
        // and goes out all at once or in hourly batches.
        intervalSeconds = 0;
        batchPerHour = customBatch;
        scheduledAt = parsed.toISOString();
      } else {
        intervalSeconds = scheduleInterval;
        scheduledAt = now.toISOString();
      }

      await api.scheduleNewsletterSend(
        subject, body, validRecipients.map((c) => c.id),
        intervalSeconds, scheduledAt, attachmentPath, batchPerHour,
      );
      setShowSchedule(false);
      api.listScheduledSends().then(setScheduledSends);
      api.listNewsletters().then(setTemplates);
      startNew();
    } catch (e: any) {
      setSendError(String(e));
    } finally { setScheduling(false); }
  };

  const handleCancelScheduled = async (id: string) => {
    try {
      await api.cancelScheduledSend(id);
      api.listScheduledSends().then(setScheduledSends);
    } catch (e: any) {
      setSendError(String(e));
    }
  };

  const refreshScheduledSends = () => {
    api.listScheduledSends().then(setScheduledSends);
  };

  const startNew = () => {
    setSubject(defaultSubject);
    setBody(defaultBody);
    resetAudience();
    setAttachmentPath(null);
    setAiPrompt("");
    setSendResult(null);
    setSendError(null);
    setShowErrors(false);
    setShowHistory(false);
    setShowSchedule(false);
    setScheduleInterval(0);
    setPreviewIdx(0);
  };

  // The compose action is a single button: "Send now" (interval 0) sends
  // immediately with a progress bar; any other choice schedules the send. The
  // button's label + icon + handler all follow the currently chosen option, so
  // there's no separate Schedule button.
  const isScheduledSend = scheduleInterval !== 0;
  const scheduleOptLabel =
    scheduleInterval === 3600 ? "spread over 1 hour" :
    scheduleInterval === 7200 ? "spread over 2 hours" :
    scheduleInterval === 14400 ? "spread over 4 hours" :
    scheduleInterval === -1 ? (scheduleCustomDate ? `for ${new Date(scheduleCustomDate).toLocaleString()}${customBatch ? `, ${customBatch} per hour` : ""}` : "for a custom time") :
    "";
  const composeIncomplete = validRecipients.length === 0 || !subject.trim() || !body.trim();
  const actionDisabled = sending || scheduling || composeIncomplete || (scheduleInterval === -1 && !scheduleCustomDate);

  const previewClient = validRecipients[previewIdx] || validRecipients[0];
  const previewSub = (t: string, c: Client) => t
    .replace(/\{\{?first_name\}?\}/g, c.name.split(" ")[0])
    .replace(/\{\{?full_name\}?\}/g, c.name)
    .replace(/\{\{?company\}?\}/g, c.company || "");
  // {sender_name} is a workspace value, not a per-recipient one, so it resolves whether
  // or not a recipient is picked — otherwise the preview shows a literal placeholder and
  // gives no hint that the send will fill it in.
  const previewSender = (t: string) => t.replace(/\{\{?sender_name\}?\}/g, senderName);
  const previewSubject = previewSender(previewClient ? previewSub(subject, previewClient) : subject);
  const previewBody = previewSender(previewClient ? previewSub(body, previewClient) : body);

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const charCount = body.length;

  return (
    <div className="nl-cols flex flex-col xl:flex-row gap-4" style={{ minHeight: 500 }}>
      {/* Panel A: Audience (R-297) — filters decide who receives, hand edits adjust, and the
          number in the header is exactly who the send goes to. */}
      <div className="nl-pane w-full xl:w-[340px] xl:flex-shrink-0 bg-surface border border-line rounded-lg flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-accent/10 text-accent text-[11px] font-bold flex items-center justify-center flex-shrink-0">1</span>
            <span className="text-[14px] font-semibold text-ink">Audience</span>
          </span>
          <span className="bg-accent/10 text-accent-hover text-[12px] font-semibold px-2.5 py-0.5 rounded-full tabular-nums whitespace-nowrap">
            {validRecipients.length} will receive
          </span>
        </div>

        {picked ? (
          <div className="px-4 py-3 border-b border-line text-[12px] text-ink-2 leading-snug">
            {picked.size} {picked.size === 1 ? "person" : "people"} picked from Clients.
            {(() => {
              const n = locked.filter((r) => picked.has(r.client.id)).length;
              return n > 0 ? ` ${n} of them can never get bulk email (see Not receiving).` : "";
            })()}
            <button onClick={resetAudience} className="block mt-1 text-accent hover:text-accent-hover font-medium">
              Build an audience instead
            </button>
          </div>
        ) : (
          <div className="px-4 py-3 border-b border-line space-y-3.5">
            {catOptions.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[12px] font-medium text-ink-2">Categories</span>
                  {filters.cats.length > 0 && (
                    <button onClick={() => setFilters((p) => ({ ...p, cats: [] }))} className="text-[11px] text-muted hover:text-ink-2">Clear</button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {catOptions.filter((o, i) => showAllCats || i < 10 || catOn(o.label)).map((o) => (
                    <AudienceChip key={o.label} on={catOn(o.label)} onClick={() => toggleCat(o.label)}
                      count={reach.cat.get(o.label)}>
                      {o.label}
                    </AudienceChip>
                  ))}
                  {catOptions.length > 10 && (
                    <button onClick={() => setShowAllCats(!showAllCats)} className="text-[11px] text-muted hover:text-ink-2 h-6 px-1">
                      {showAllCats ? "Show fewer" : `Show all ${catOptions.length}`}
                    </button>
                  )}
                </div>
                {filters.cats.length > 1 && (
                  <div className="text-[11px] text-muted mt-1.5">Anyone who buys at least one of these.</div>
                )}
              </div>
            )}

            <div>
              <div className="text-[12px] font-medium text-ink-2 mb-1.5">Buyers</div>
              <div className="flex flex-wrap gap-1.5">
                <AudienceChip on={filters.tier === "all"} count={reach.all}
                  onClick={() => setFilters((p) => ({ ...p, tier: "all" }))}>
                  Everyone
                </AudienceChip>
                <AudienceChip on={filters.tier === "ranked"} count={reach.ranked}
                  onClick={() => setFilters((p) => ({ ...p, tier: p.tier === "ranked" ? "all" : "ranked" }))}>
                  Ranked buyers
                </AudienceChip>
                <AudienceChip on={filters.tier === "first_contact"} count={reach.first}
                  title="Clients never sent any email: one intro send reaches them all"
                  onClick={() => setFilters((p) => ({ ...p, tier: p.tier === "first_contact" ? "all" : "first_contact" }))}>
                  First contact
                </AudienceChip>
                {([["P", "Platinum"], ["S", "Diamond"], ["A", "Gold"], ["B", "Silver"], ["C", "Bronze"]] as [string, string][]).map(([code, label]) => (
                  <AudienceChip key={code} on={Array.isArray(filters.tier) && filters.tier.includes(code)}
                    count={reach.tier.get(code)} onClick={() => toggleTier(code)}>
                    {label}
                  </AudienceChip>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[12px] font-medium text-ink-2 mb-1.5">Purchase history</div>
              <div className="grid grid-cols-3 gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
                {([["any", "Anyone"], ["bought", "Bought before"], ["never", "Never bought"]] as [Purchase, string][]).map(([v, label]) => {
                  const on = filters.purchase === v;
                  return (
                    <button key={v} onClick={() => setFilters((p) => ({ ...p, purchase: v }))} aria-pressed={on}
                      className={`h-10 rounded-md px-1 flex flex-col items-center justify-center leading-tight transition-colors ${
                        on ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"
                      }`}>
                      <span className={`text-[11px] whitespace-nowrap ${on ? "font-medium" : ""}`}>{label}</span>
                      <span className="text-[10px] tabular-nums opacity-70">{reach[v]}</span>
                    </button>
                  );
                })}
              </div>
              {filters.purchase !== "any" && (
                <div className="text-[11px] text-muted mt-1.5">
                  {filters.purchase === "bought" ? "Only clients with a completed deal or a paid invoice." : "Leaves out everyone with a completed deal or a paid invoice."}
                </div>
              )}
            </div>

            <div>
              <button onClick={() => setShowFilters(!showFilters)} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink-2">
                <ChevronDown size={12} className={`transition-transform ${showFilters ? "rotate-180" : ""}`} />
                More filters{moreFiltersOn > 0 ? ` (${moreFiltersOn} on)` : ""}
              </button>
              {showFilters && (
                <div className="mt-2.5 space-y-3">
                  {stOptions.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[12px] font-medium text-ink-2">State</span>
                        {filters.states.length > 0 && (
                          <button onClick={() => setFilters((p) => ({ ...p, states: [] }))} className="text-[11px] text-muted hover:text-ink-2">Clear</button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {stOptions.filter((o, i) => showAllStates || i < 12 || filters.states.includes(o.code)).map((o) => (
                          <AudienceChip key={o.code} on={filters.states.includes(o.code)} onClick={() => toggleState(o.code)}
                            count={reach.state.get(o.code)}>
                            {o.code}
                          </AudienceChip>
                        ))}
                        {stOptions.length > 12 && (
                          <button onClick={() => setShowAllStates(!showAllStates)} className="text-[11px] text-muted hover:text-ink-2 h-6 px-1">
                            {showAllStates ? "Show fewer" : `Show all ${stOptions.length}`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-[12px] font-medium text-ink-2 mb-1.5">Leave out</div>
                    <div className="flex flex-wrap gap-1.5">
                      {([["exDormant", "Dormant"], ["exOneTime", "One-time buyers"], ["exUnder10k", "Under $10k"]] as ["exDormant" | "exOneTime" | "exUnder10k", string][]).map(([key, label]) => (
                        <AudienceChip key={key} on={filters[key]} exclude onClick={() => setFilters((p) => ({ ...p, [key]: !p[key] }))}>
                          {label}
                        </AudienceChip>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
                    <input type="checkbox" checked={includeRanked}
                      onChange={(e) => { setIncludeRanked(e.target.checked); api.setNewsletterIncludeRanked(e.target.checked).catch(() => {}); }}
                      className="accent-accent" />
                    Include ranked buyers when Everyone is selected
                  </label>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="px-4 py-3 border-b border-line">
          <label className={`flex items-start gap-2 text-[11px] cursor-pointer rounded-lg px-2.5 py-2 border transition-colors ${unsubEnabled ? "border-line bg-surface-2/50 text-ink-2" : "border-warning-ink/40 bg-warning-bg text-warning-ink"}`}>
            <input type="checkbox" checked={unsubEnabled}
              onChange={(e) => { setUnsubEnabled(e.target.checked); api.setNewsletterUnsubscribeEnabled(e.target.checked).catch(() => {}); }}
              className="accent-accent mt-0.5 flex-shrink-0" />
            <span className="min-w-0">
              <span className="font-medium">Include an unsubscribe link</span>
              <span className="block text-[10px] mt-0.5 opacity-80">
                {unsubEnabled
                  ? "Added automatically to every send: required by anti-spam law (CAN-SPAM)."
                  : "Off for sends from this app. Sending marketing email without an opt-out can be illegal, so turn this back on. Scheduled sends go out from the server and always carry the link."}
              </span>
            </span>
          </label>
        </div>

        <div className="flex-1 flex flex-col min-h-[320px]">
          <div className="px-3 pt-2.5 pb-2 border-b border-line space-y-2">
            <div className="grid grid-cols-2 gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
              {([["in", "Receiving", validRecipients.length], ["out", "Not receiving", locked.length + filteredOut.length]] as ["in" | "out", string, number][]).map(([v, label, n]) => (
                <button key={v} onClick={() => setPeopleTab(v)} aria-pressed={peopleTab === v}
                  className={`h-7 rounded-md text-[12px] whitespace-nowrap transition-colors ${
                    peopleTab === v ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"
                  }`}>
                  {label} <span className="tabular-nums opacity-70">{n}</span>
                </button>
              ))}
            </div>
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
              <input
                type="text"
                placeholder="Search by name, company or email"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="w-full border border-line-3 h-8 pl-7 pr-2 rounded-md text-[12px] bg-surface focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto" style={{ maxHeight: 440 }}>
            {peopleTab === "in" ? (
              receivingRows.length > 0 ? <>{receivingRows.slice(0, SHOW).map(personRow)}{moreLine(receivingRows.length)}</> : (
                <div className="text-[12px] text-muted text-center px-4 py-8">
                  {q ? "No one receiving matches that search." : "No one matches these filters. Loosen one, or tick someone under Not receiving."}
                </div>
              )
            ) : (
              <>
                {lockedRows.length > 0 && (
                  <>
                    <div className="px-3 pt-2.5 pb-1.5 flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink-2">Never gets bulk email</span>
                      <span className="text-[11px] text-muted tabular-nums">{lockedRows.length}</span>
                    </div>
                    <div className="px-3 pb-2 text-[11px] text-muted leading-snug">
                      Blacklisted, unsubscribed, marked No bulk email, or no address. Nothing you pick here sends to them.
                    </div>
                    {lockedRows.slice(0, SHOW).map(personRow)}{moreLine(lockedRows.length)}
                  </>
                )}
                {filteredRows.length > 0 && (
                  <>
                    <div className="px-3 pt-3 pb-1.5 flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink-2">Left out by your filters</span>
                      <span className="text-[11px] text-muted tabular-nums">{filteredRows.length}</span>
                    </div>
                    <div className="px-3 pb-2 text-[11px] text-muted leading-snug">Tick anyone to add them anyway.</div>
                    {filteredRows.slice(0, SHOW).map(personRow)}{moreLine(filteredRows.length)}
                  </>
                )}
                {lockedRows.length === 0 && filteredRows.length === 0 && (
                  <div className="text-[12px] text-muted text-center px-4 py-8">
                    {q ? "No one left out matches that search." : "Everyone is receiving."}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="px-3 py-2.5 border-t border-line space-y-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted">{handEdits > 0 ? `${handEdits} changed by hand` : ""}</span>
              <span className="flex items-center gap-3">
                {handEdits > 0 && (
                  <button onClick={() => { setRemoved(new Set()); setAdded(new Set()); }} className="text-accent hover:text-accent-hover">Undo hand edits</button>
                )}
                <button onClick={resetAudience} className="text-muted hover:text-ink-2">Reset</button>
              </span>
            </div>
            <div className="flex gap-1.5">
              <input
                placeholder="Or type an email address…"
                type="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addManualEmail()}
                className="flex-1 min-w-0 border border-line-3 h-7 px-2 rounded-md text-[11px] focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button onClick={addManualEmail} disabled={!manualEmail.includes("@")}
                className="bg-accent hover:bg-accent-hover text-on-accent px-2.5 h-7 rounded-md text-[11px] font-medium disabled:opacity-40 transition-colors">
                Add
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Panel B: Compose */}
      <div className="nl-pane w-full xl:flex-1 flex flex-col gap-3 min-w-0">
        <div className="bg-surface border border-line rounded-lg flex flex-col flex-1">
          <div className="px-4 py-3 border-b border-line flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-accent/10 text-accent text-[11px] font-bold flex items-center justify-center flex-shrink-0">2</span>
            <span className="text-[14px] font-semibold text-ink">Write</span>
          </div>
          <div className="p-4 flex-1 flex flex-col">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                ref={subjectRef}
                placeholder="Subject (use {first_name} for personalization)"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                onFocus={() => { lastFocusedRef.current = "subject"; }}
                className="flex-1 min-w-[200px] border border-line-3 px-3 h-10 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
              <select
                value=""
                onChange={(e) => {
                  const nl = templates.find((t) => t.id === e.target.value);
                  if (nl) loadTemplate(nl);
                }}
                className="border border-line-3 h-10 px-2 rounded-md text-[12px] bg-surface focus:outline-none focus:ring-1 focus:ring-accent max-w-[130px]"
              >
                <option value="">Load template</option>
                {templates.filter((t) => t.status === "draft").map((t) => (
                  <option key={t.id} value={t.id}>{t.subject || "Untitled"}</option>
                ))}
              </select>
              <button onClick={saveTemplate}
                className="border border-line-3 h-10 px-2.5 rounded-md text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">
                Save
              </button>
              <button onClick={() => { setSubject(defaultSubject); setBody(defaultBody); }}
                className="text-[11px] text-muted hover:text-ink-2 whitespace-nowrap underline">
                Reset default
              </button>
            </div>

            {templates.filter((t) => t.status === "draft").length > 0 && (
              <div className="mb-2">
                <button onClick={() => setShowTemplates(!showTemplates)}
                  className="flex items-center gap-1 text-[11px] text-muted hover:text-ink-2 w-full mb-1">
                  <ChevronDown size={11} className={`transition-transform ${showTemplates ? "rotate-180" : ""}`} />
                  Saved templates ({templates.filter((t) => t.status === "draft").length})
                </button>
                {showTemplates && (
                  <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
                    {templates.filter((t) => t.status === "draft").map((t) => (
                      <div key={t.id}
                        className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-surface-2 group cursor-pointer transition-colors"
                        onClick={() => loadTemplate(t)}>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium text-ink truncate">{t.subject || "Untitled"}</div>
                          <div className="text-[10px] text-muted">{new Date(t.created_at).toLocaleDateString()}</div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); deleteTemplate(t); }}
                          className="text-faint hover:text-danger-ink p-1 rounded hover:bg-danger-bg md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 mb-2 text-[12px] text-muted">
              <VariablePicker onSelect={insertVariable} />
              <span className="tabular-nums">{charCount} chars</span>
              <span className="tabular-nums">{wordCount} words</span>
            </div>

            <textarea
              ref={textareaRef}
              placeholder={`Hi {first_name},\n\nWrite your message here…\n\nBest regards,\n{sender_name}`}
              rows={12}
              className="flex-1 w-full border border-line rounded-md px-3 py-2.5 text-[14px] font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onFocus={() => { lastFocusedRef.current = "body"; }}
            />

            <div className="mt-3"><VariableReference /></div>

            <div className="mt-3 flex items-center gap-2">
              <button onClick={pickFile}
                className="flex items-center gap-1.5 border border-line-3 h-9 px-3 rounded-md text-[12px] text-ink-2 hover:bg-surface-2 transition-colors">
                <Paperclip size={13} /> Attach file
              </button>
              {attachmentPath && (
                <div className="flex items-center gap-1.5 bg-surface-2 border border-line rounded-md px-2.5 py-1.5 text-[12px] text-ink-2 flex-1 min-w-0">
                  <span className="truncate">{attachmentPath.split(/[\\/]/).pop()}</span>
                  <button onClick={() => setAttachmentPath(null)} className="text-muted hover:text-danger-ink flex-shrink-0">
                    <X size={12} />
                  </button>
                </div>
              )}
              {!attachmentPath && attachmentSearch && (
                <input
                  placeholder="Or paste file path…"
                  value={attachmentSearch}
                  onChange={(e) => { setAttachmentSearch(e.target.value); if (e.target.value) setAttachmentPath(e.target.value); }}
                  className="flex-1 border border-line-3 h-9 px-3 rounded-md text-[12px] focus:outline-none focus:ring-1 focus:ring-accent"
                />
              )}
            </div>

            <details className="mt-3 bg-surface-2 rounded-md border border-line">
              <summary className="px-3 py-2 text-[13px] font-medium text-ink-2 cursor-pointer flex items-center gap-1.5 select-none">
                <Sparkles size={13} className="text-accent" /> AI Assist
              </summary>
              <div className="px-3 pb-3 flex items-center gap-2">
                <input
                  placeholder="Describe what this newsletter is about…"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  className="flex-1 border border-line-3 px-3 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="flex rounded-md border border-line-3 overflow-hidden">
                  {["formal", "neutral", "casual"].map((t) => (
                    <button key={t} onClick={() => setAiTone(t)}
                      className={`px-3 h-9 text-[12px] font-medium transition-colors ${aiTone === t ? "bg-accent text-on-accent" : "bg-surface text-ink-2 hover:bg-surface-2"}`}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
                <button onClick={generateAI} disabled={aiLoading || !aiPrompt.trim()}
                  className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap">
                  <Sparkles size={13} /> {aiLoading ? "Writing…" : "Generate"}
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* Panel C: Preview & Send */}
      <div className="nl-pane w-full xl:w-[320px] xl:flex-shrink-0 flex flex-col gap-3">
        <div className="bg-surface border border-line rounded-lg flex-1 flex flex-col">
          <div className="px-4 py-3 border-b border-line flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-accent/10 text-accent text-[11px] font-bold flex items-center justify-center flex-shrink-0">3</span>
            <span className="text-[14px] font-semibold text-ink">Review &amp; send</span>
          </div>
          <div className="p-4 flex-1 flex flex-col">
            <select
              value={previewIdx}
              onChange={(e) => setPreviewIdx(Number(e.target.value))}
              className="w-full border border-line-3 h-8 px-2 rounded-md text-[12px] mb-3 bg-surface focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {validRecipients.length === 0 && <option value={0}>Sample recipient</option>}
              {validRecipients.map((c, i) => (
                <option key={c.id} value={i}>{c.name}</option>
              ))}
            </select>

            <div className="border border-line rounded-lg overflow-hidden shadow-sm flex-1 flex flex-col">
              <div className="bg-surface-2 px-3 py-2 border-b border-line space-y-0.5 text-[12px]">
                <div className="flex"><span className="text-muted w-10">From:</span><span className="text-ink-2">{newsletterFrom || "Your Business"}</span></div>
                <div className="flex"><span className="text-muted w-10">To:</span><span className="text-ink-2 truncate">{previewClient ? `${previewClient.name} <${previewClient.email}>` : "Recipient"}</span></div>
                <div className="flex"><span className="text-muted w-10">Subj:</span><span className="text-ink font-medium">{previewSubject || "No subject"}</span></div>
              </div>
              <div className="p-3 text-[13px] text-ink-2 whitespace-pre-wrap overflow-y-auto flex-1 bg-surface">
                {previewBody || "Start writing…"}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-lg p-4">
          <FromPicker options={fromOptions} value={newsletterFrom} onChange={setNewsletterFrom} className="mb-3" />

          <button
            onClick={isScheduledSend ? handleSchedule : handleSend}
            disabled={actionDisabled}
            className="w-full bg-accent hover:bg-accent-hover text-on-accent rounded-md text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
            style={{ height: 44 }}
          >
            {isScheduledSend ? <Clock size={16} /> : <Send size={16} />}
            {sending ? sendProgress
              : scheduling ? "Scheduling…"
              : isScheduledSend ? `Schedule: ${scheduleOptLabel}`
              : `Send ${validRecipients.length} emails`}
          </button>
          {sending && (
            <div className="mt-2 h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${sendPct}%` }} />
            </div>
          )}

          <button
            onClick={() => setShowSchedule(!showSchedule)}
            disabled={validRecipients.length === 0 || !subject.trim() || !body.trim()}
            className="w-full mt-2 border border-accent text-accent-hover hover:bg-accent/10 rounded-md text-[13px] font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
            style={{ height: 36 }}
          >
            <Clock size={14} />
            Schedule send
          </button>

          {showSchedule && (
            <div className="mt-2 border border-line rounded-md p-3 bg-surface-2 space-y-2">
              <div className="text-[12px] font-medium text-ink-2 mb-1">When should this send?</div>
              {[
                { val: 0, label: "Send now, all " + validRecipients.length + " at once" },
                { val: 3600, label: "Spread over 1 hour, ~" + Math.ceil(validRecipients.length / 60) + " emails per minute" },
                { val: 7200, label: "Spread over 2 hours, ~" + Math.ceil(validRecipients.length / 120) + " emails per minute" },
                { val: 14400, label: "Spread over 4 hours, ~" + Math.ceil(validRecipients.length / 240) + " emails per minute" },
              ].map((opt) => (
                <label key={opt.val} className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer">
                  <input type="radio" checked={scheduleInterval === opt.val} onChange={() => setScheduleInterval(opt.val)} className="accent-accent" />
                  {opt.label}
                </label>
              ))}
              <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer">
                <input type="radio" checked={scheduleInterval === -1} onChange={() => setScheduleInterval(-1)} className="accent-accent" />
                Custom
              </label>
              {scheduleInterval === -1 && (
                <div className="flex gap-2">
                  <input type="datetime-local" value={scheduleCustomDate} onChange={(e) => setScheduleCustomDate(e.target.value)}
                    className="flex-1 min-w-0 border border-line-3 h-8 px-2 rounded-md text-[12px]" />
                  <select value={customBatch} onChange={(e) => setCustomBatch(parseInt(e.target.value))}
                    title="How fast the list goes out from the chosen time"
                    className="border border-line-3 h-8 px-2 rounded-md text-[12px] bg-surface text-ink">
                    {BATCH_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              )}
              <div className="text-[11px] text-muted pt-0.5">
                {isScheduledSend
                  ? `The button above now schedules this send: ${scheduleOptLabel}.`
                  : "Pick an option above; the send button will switch to scheduling."}
              </div>
            </div>
          )}

          {activeScheduled.length > 0 && (
            <div className="mt-3 border border-line rounded-md p-3 bg-info-bg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-info-ink">Scheduled sends</span>
                <button onClick={refreshScheduledSends} className="text-[11px] text-info-ink hover:text-info-ink">Refresh</button>
              </div>
              {activeScheduled.map((job) => (
                <div key={job.id} className="bg-surface rounded-md p-2 border border-info">
                  <div className="text-[12px] font-medium text-ink truncate">{job.subject || "Untitled"}</div>
                  <div className="mt-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                    <div className="h-full bg-info rounded-full transition-all" style={{ width: `${job.total_recipients > 0 ? ((job.sent_count + job.failed_count + job.skipped_count) / job.total_recipients * 100) : 0}%` }} />
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[11px] text-muted">
                      {job.status === "running"
                        ? `${job.sent_count}/${job.total_recipients} sent`
                        : `Pending · ${new Date(job.scheduled_at).toLocaleString()}`}
                    </span>
                    <button onClick={() => handleCancelScheduled(job.id)}
                      className="text-[11px] text-danger-ink hover:text-danger-ink font-medium">Cancel</button>
                  </div>
                  {job.error && <div className="text-[11px] text-warning-ink mt-1">{job.error}</div>}
                </div>
              ))}
            </div>
          )}

          {failedScheduled.length > 0 && (
            <div className="mt-3 border border-danger rounded-md p-3 bg-danger-bg space-y-2">
              <span className="text-[12px] font-medium text-danger-ink">Scheduled sends that did not go out</span>
              {failedScheduled.map((job) => (
                <div key={job.id} className="bg-surface rounded-md p-2 border border-line">
                  <div className="text-[12px] font-medium text-ink truncate">{job.subject || "Untitled"}</div>
                  <div className="text-[11px] text-danger-ink mt-0.5">{job.error || "The server could not send this."}</div>
                </div>
              ))}
            </div>
          )}

          {sendingNow.length > 0 && (
            <div className="mt-3 border border-line rounded-md p-3 bg-surface-2 space-y-2">
              <div className="text-[12px] font-medium text-ink">Sending now</div>
              {sendingNow.map((nl) => {
                const pct = nl.recipient_count > 0 ? Math.round((nl.sent_count / nl.recipient_count) * 100) : 0;
                return (
                  <div key={nl.id} className="bg-surface rounded-md p-2 border border-line">
                    <div className="text-[12px] font-medium text-ink truncate">{nl.subject || "Untitled"}</div>
                    <div className="mt-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-[11px] text-muted mt-1">{nl.sent_count}/{nl.recipient_count} sent · still working…</div>
                  </div>
                );
              })}
            </div>
          )}

          {sendError && (
            <div className="mt-3 text-[13px] px-3 py-2 rounded-md bg-danger-bg text-danger-ink border border-danger">
              <div className="flex items-center gap-1.5 font-medium mb-1">
                <AlertCircle size={14} /> Send failed
              </div>
              <div className="text-[12px] whitespace-pre-wrap">{sendError}</div>
              <button onClick={startNew}
                className="mt-2 w-full bg-surface border border-line hover:bg-surface-2 text-ink-2 rounded-md text-[12px] font-medium py-1.5 transition-colors">
                + Compose new
              </button>
            </div>
          )}

          {sendResult && (
            <div className={`mt-3 text-[13px] px-3 py-2 rounded-md ${sendResult.failed > 0 || sendResult.skipped > 0 ? "bg-warning-bg text-warning-ink border border-warning" : "bg-success-bg text-success-ink border border-success"}`}>
              {sendResult.failed === 0 && sendResult.skipped === 0 ? (
                <div>
                  <div className="flex items-center gap-1.5 font-medium mb-1">
                    <CheckCircle2 size={14} /> Sent successfully
                  </div>
                  <div className="text-[12px]">{sendResult.sent} email{sendResult.sent !== 1 ? "s" : ""} sent</div>
                </div>
              ) : (
                <div>
                  <div className="font-medium mb-1">
                    {sendResult.sent} sent{sendResult.failed > 0 ? `, ${sendResult.failed} failed` : ""}{sendResult.skipped > 0 ? `, ${sendResult.skipped} skipped` : ""}
                  </div>
                  {sendResult.errors.length > 0 && (
                    <div>
                      <button onClick={() => setShowErrors(!showErrors)}
                        className="underline text-[12px] mb-1">
                        {showErrors ? "Hide details" : `View ${sendResult.errors.length} error${sendResult.errors.length !== 1 ? "s" : ""}`}
                      </button>
                      {showErrors && (
                        <div className="mt-1 space-y-1 max-h-[160px] overflow-y-auto">
                          {sendResult.errors.map((err, i) => (
                            <div key={i} className="text-[11px] bg-surface/60 rounded px-2 py-1 border border-warning">
                              <span className="font-medium">{err.client_name}</span>
                              <span className="text-warning-ink ml-1">: {err.error}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              <button onClick={startNew}
                className="mt-2 w-full bg-surface border border-line hover:bg-surface-2 text-ink-2 rounded-md text-[12px] font-medium py-1.5 transition-colors">
                + Compose new
              </button>
            </div>
          )}

          {templates.filter((t) => t.status === "sent").length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <button onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-[12px] text-muted hover:text-ink-2 w-full">
                <ChevronDown size={12} className={`transition-transform ${showHistory ? "rotate-180" : ""}`} />
                Send history
              </button>
              {showHistory && (
                <div className="mt-2 space-y-1.5">
                  {templates.filter((t) => t.status === "sent").slice(0, 5).map((t) => (
                    <div key={t.id} className="text-[12px] text-ink-2 py-1 border-b border-line-2 last:border-0">
                      <div className="font-medium text-ink truncate">{t.subject || "Untitled"}</div>
                      <div className="text-muted">{new Date(t.created_at).toLocaleDateString()} · {t.sent_count} sent</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// R-274: send_weekday 0 = Monday … 6 = Sunday; the server applies the hour and minute in
// Central time and releases batch_per_hour recipients an hour (0 = the whole list at once).
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const BATCH_OPTIONS: [number, string][] = [[0, "All at once"], [25, "25 per hour"], [50, "50 per hour"], [100, "100 per hour"], [200, "200 per hour"]];
const timeLabel = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;

function RecurringTab() {
  const [schedules, setSchedules] = useState<NewsletterSchedule[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<NewsletterSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form fields
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [intervalType, setIntervalType] = useState("weekly");
  const [intervalValue, setIntervalValue] = useState(1);
  const [sendHour, setSendHour] = useState(9);
  const [sendMinute, setSendMinute] = useState(0);
  const [sendWeekday, setSendWeekday] = useState(0);
  const [batchPerHour, setBatchPerHour] = useState(50);
  const [recipientMode, setRecipientMode] = useState<"all" | "category">("all");
  const [category, setCategory] = useState("");

  const inp = "border border-line px-3 h-10 rounded-lg text-[14px] w-full bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
  const lbl = "block text-[12.5px] font-medium text-muted mb-1";

  const load = () => {
    api.listNewsletterSchedules().then(setSchedules).catch((e) => setError(e.toString()));
  };
  useEffect(() => {
    load();
    api.listClients().then(setClients).catch(() => {});
    api.listCategories().then(setCategories).catch(() => {});
  }, []);

  const resetForm = () => {
    setName(""); setSubject(""); setBody("Hi {first_name},\n\n");
    setIntervalType("weekly"); setIntervalValue(1); setSendHour(9);
    setSendMinute(0); setSendWeekday(0); setBatchPerHour(50);
    setRecipientMode("all"); setCategory(""); setEditing(null); setError(null);
  };

  const openCreate = () => { resetForm(); setShowForm(true); };
  const openEdit = (s: NewsletterSchedule) => {
    setEditing(s);
    setName(s.name); setSubject(s.subject); setBody(s.body);
    setIntervalType(s.interval_type); setIntervalValue(s.interval_value); setSendHour(s.send_hour);
    setSendMinute(s.send_minute ?? 0); setSendWeekday(s.send_weekday ?? -1); setBatchPerHour(s.batch_per_hour ?? 0);
    try {
      const f = JSON.parse(s.recipient_filter || '{"mode":"all"}');
      if (f.mode === "ids" && f.category) { setRecipientMode("category"); setCategory(f.category); }
      else { setRecipientMode("all"); setCategory(""); }
    } catch { setRecipientMode("all"); }
    setError(null);
    setShowForm(true);
  };

  // R-297: a client is in a category when any of their categories is it (not when their whole
  // category string equals it), and locked clients are never counted — the Newsletter's rules.
  const known = categories.map((c) => c.label);
  const categoryMembers = (label: string) => clients.filter((c) =>
    !lockReason(c) && clientCategories(c, known).some((x) => x.toLowerCase() === label.toLowerCase()));

  const buildFilter = (): string => {
    if (recipientMode === "category" && category) {
      const ids = categoryMembers(category).map((c) => c.id);
      return JSON.stringify({ mode: "ids", ids, category });
    }
    return JSON.stringify({ mode: "all" });
  };

  const save = async () => {
    if (!name.trim() || !subject.trim()) { setError("Name and subject are required."); return; }
    setSaving(true); setError(null);
    try {
      const filter = buildFilter();
      if (editing) {
        await api.updateNewsletterSchedule(editing.id, {
          name, subject, body, recipientFilter: filter,
          intervalType, intervalValue, sendHour, sendMinute, sendWeekday, batchPerHour,
        });
      } else {
        await api.createNewsletterSchedule(name, subject, body, filter, intervalType, intervalValue, sendHour, sendWeekday, sendMinute, batchPerHour);
      }
      setShowForm(false);
      resetForm();
      load();
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: NewsletterSchedule) => {
    await api.updateNewsletterSchedule(s.id, { active: s.active ? 0 : 1 });
    load();
  };
  const remove = async (s: NewsletterSchedule) => {
    await api.deleteNewsletterSchedule(s.id);
    load();
  };

  const cadenceLabel = (s: NewsletterSchedule) => {
    const unit = s.interval_type === "daily" ? "day" : s.interval_type === "monthly" ? "month" : "week";
    const day = s.interval_type === "weekly" && s.send_weekday >= 0 && s.send_weekday <= 6 ? WEEKDAYS[s.send_weekday] : null;
    const every = s.interval_value > 1 ? `Every ${s.interval_value} ${unit}s` : `Every ${unit}`;
    const when = day ? (s.interval_value > 1 ? `${every} on ${day}` : `Every ${day}`) : every;
    const pace = s.batch_per_hour > 0 ? ` · ${s.batch_per_hour} per hour` : " · all at once";
    return `${when} at ${timeLabel(s.send_hour, s.send_minute ?? 0)} CT${pace}`;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[13px] text-muted max-w-[520px]">
          Automatically send a newsletter on a repeating schedule. The server delivers each run even when the desktop app is closed.
        </p>
        <button
          onClick={openCreate}
          className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors"
        >
          <Plus size={14} /> New schedule
        </button>
      </div>

      {error && !showForm && (
        <div className="bg-danger-bg border border-danger text-danger-ink px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {schedules.length === 0 ? (
        <div className="text-center text-muted text-[13px] py-16 border border-dashed border-line rounded-xl">
          No recurring schedules yet. Click <b>New schedule</b> to create one.
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="bg-surface border border-line rounded-xl p-4 flex items-center gap-4">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${s.active ? "bg-accent/15 text-accent" : "bg-surface-3 text-faint"}`}>
                <Repeat size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-ink truncate">{s.name}</span>
                  {!s.active && <StatusPill tone="neutral">Paused</StatusPill>}
                </div>
                <div className="text-[12px] text-muted truncate">{s.subject}</div>
                <div className="text-[11px] text-faint mt-0.5">
                  {cadenceLabel(s)} · next run {new Date(s.next_run_at).toLocaleString([], { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} CT
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => toggleActive(s)} title={s.active ? "Pause" : "Resume"}
                  className="p-2 rounded-lg text-muted hover:text-ink hover:bg-surface-2 transition-colors">
                  <Power size={15} />
                </button>
                <button onClick={() => openEdit(s)} title="Edit"
                  className="p-2 rounded-lg text-muted hover:text-ink hover:bg-surface-2 transition-colors">
                  <FileEdit size={15} />
                </button>
                <button onClick={() => remove(s)} title="Delete"
                  className="p-2 rounded-lg text-muted hover:text-danger-ink hover:bg-danger-bg transition-colors">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[7vh] bg-black/25 backdrop-blur-[3px]" onClick={() => setShowForm(false)}>
          <div className="bg-surface rounded-2xl shadow-xl w-[520px] max-w-[92vw] max-h-[82vh] overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-[15px] font-semibold text-ink">{editing ? "Edit schedule" : "New recurring schedule"}</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-ink"><X size={16} /></button>
            </div>

            {error && (
              <div className="bg-danger-bg border border-danger text-danger-ink px-3 py-2 rounded-lg text-[12px] flex items-center gap-2 mb-3">
                <AlertCircle size={13} /> {error}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className={lbl}>Schedule name</label>
                <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly client update" />
              </div>
              <div>
                <label className={lbl}>Subject</label>
                <input className={inp} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Update from Ecliptr" />
              </div>
              <div>
                <label className={lbl}>Body</label>
                <textarea className={inp + " h-28 py-2 resize-none"} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="text-[11px] text-faint mt-1">Use {"{first_name}"}, {"{company}"} etc. for personalization.</div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className={lbl}>Repeat</label>
                  <select className={inp} value={intervalType} onChange={(e) => setIntervalType(e.target.value)}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className={lbl}>Every</label>
                  <NumberInput integer className={inp} value={intervalValue}
                    onValue={(n) => setIntervalValue(Math.max(1, n || 1))} />
                </div>
                {intervalType === "weekly" && (
                  <div>
                    <label className={lbl}>On</label>
                    <select className={inp} value={sendWeekday} onChange={(e) => setSendWeekday(parseInt(e.target.value))}>
                      {sendWeekday === -1 && <option value={-1}>Same day as now</option>}
                      {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className={lbl}>At</label>
                  <select className={inp} value={sendHour} onChange={(e) => setSendHour(parseInt(e.target.value))}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Minute</label>
                  <select className={inp} value={sendMinute} onChange={(e) => setSendMinute(parseInt(e.target.value))}>
                    {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                      <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Release</label>
                  <select className={inp} value={batchPerHour} onChange={(e) => setBatchPerHour(parseInt(e.target.value))}>
                    {BATCH_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div className="text-[11px] text-faint -mt-1">
                Times are Central time. Hourly batches keep a large list under the mail provider's sending limits; if a limit is still hit, sending pauses and picks up where it stopped.
              </div>

              <div>
                <label className={lbl}>Recipients</label>
                <div className="flex gap-2">
                  <select className={inp} value={recipientMode} onChange={(e) => setRecipientMode(e.target.value as any)}>
                    <option value="all">All clients with email</option>
                    <option value="category">By category</option>
                  </select>
                  {recipientMode === "category" && (
                    <select className={inp} value={category} onChange={(e) => setCategory(e.target.value)}>
                      <option value="">Select…</option>
                      {categories.map((c) => <option key={c.id} value={c.label}>{c.label} ({categoryMembers(c.label).length})</option>)}
                    </select>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2">Cancel</button>
              <button onClick={save} disabled={saving}
                className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
                {saving ? "Saving…" : editing ? "Save changes" : "Create schedule"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
