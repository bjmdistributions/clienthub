import { useEffect, useState, useRef } from "react";
import { api, ParsedEmail, EmailDraft, Client, Newsletter, Category, NewsletterSendResult, ScheduledSend } from "../lib/api";
import { open } from "@tauri-apps/plugin-dialog";
import VariablePicker from "./VariablePicker";
import {
  Sparkles, RefreshCw, Mail, Send, Inbox, AlertCircle, FileEdit, Trash2,
  Users, X, Search, ChevronDown, Eye, Megaphone, CheckCircle2, Paperclip, Clock,
} from "lucide-react";

type Mode = "inbox" | "compose" | "drafts" | "newsletter";

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

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const list = await api.scanInbox();
      setEmails(list);
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-1">
        <h2 className="text-[18px] font-semibold text-ink">Newsletter</h2>
      </div>

      {/* Underline tabs */}
      <div className="flex gap-0 border-b border-line mb-5">
        {(["newsletter", "inbox", "drafts", "compose"] as const).map((m) => {
          const icons = { inbox: Inbox, drafts: FileEdit, compose: Mail, newsletter: Megaphone };
          const labels = { inbox: "Inbox", drafts: "Drafts", compose: "Compose", newsletter: "Newsletter" };
          const Icon = icons[m];
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-[14px] border-b-2 -mb-px transition-colors ${
                mode === m
                  ? "border-accent text-accent-hover font-medium"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon size={14} />
              {labels[m]}
              {m === "drafts" && draftCount > 0 && (
                <span className="bg-accent text-white text-[11px] font-medium rounded-full px-1.5 py-0.5 leading-none ml-0.5">
                  {draftCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {mode === "inbox" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-[13px] text-muted">
              Pulls unread emails since the last scan, parses them, and matches against known clients.
            </p>
            <button
              onClick={scan}
              disabled={scanning}
              className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning..." : "Scan Inbox"}
            </button>
          </div>

          {error && (
            <div className="bg-danger-bg border border-danger text-danger-ink px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-5">
            {/* Email list */}
            <div className="bg-surface border border-line rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-line text-[13px] font-semibold text-ink-2">
                Recent ({emails.length})
              </div>
              <div className="max-h-[600px] overflow-auto">
                {emails.map((e) => (
                  <button
                    key={e.uid}
                    onClick={() => setSelected(e)}
                    className={`w-full text-left px-4 py-3.5 border-b border-line transition-colors ${
                      selected?.uid === e.uid ? "bg-accent/10" : "hover:bg-surface-2"
                    }`}
                  >
                    <div className="font-medium text-[13px] text-ink truncate">
                      {e.from_name || e.from}
                    </div>
                    <div className="text-[13px] text-ink-2 truncate mt-0.5">{e.subject}</div>
                    <div className="text-[12px] text-muted truncate mt-0.5">
                      {e.body_text.slice(0, 80)}
                    </div>
                  </button>
                ))}
                {emails.length === 0 && !scanning && (
                  <div className="px-4 py-10 text-center text-[13px] text-muted">
                    No emails. Configure SMTP/IMAP in Settings, then scan.
                  </div>
                )}
              </div>
            </div>

            {/* Email detail */}
            <div className="bg-surface border border-line rounded-lg p-5">
              {selected ? (
                <EmailDetail email={selected} />
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
    </div>
  );
}

function EmailDetail({ email }: { email: ParsedEmail }) {
  const [draft, setDraft] = useState("");
  const [extracted, setExtracted] = useState<any>(null);
  const [loading, setLoading] = useState<"draft" | "extract" | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [tone, setTone] = useState<string>(() => localStorage.getItem("clienthub_draft_tone") || "neutral");

  const handleDraft = async () => {
    setLoading("draft");
    try {
      const reply = await api.aiDraftReply(email.body_text, undefined, tone);
      setDraft(reply);
    } catch (e: any) { alert(e); }
    finally { setLoading(null); }
  };

  const handleExtract = async () => {
    setLoading("extract");
    try {
      setExtracted(await api.aiExtractData(email.body_text));
    } catch (e: any) { alert(e); }
    finally { setLoading(null); }
  };

  const handleSend = async () => {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await api.sendEmail(
        email.from,
        email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
        draft
      );
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    } catch (e: any) { alert(e); }
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
          onClick={handleDraft}
          disabled={loading !== null}
          className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 disabled:opacity-50"
        >
          {loading === "draft" ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
          Draft Reply
        </button>
        <button
          onClick={handleExtract}
          disabled={loading !== null}
          className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-md text-[14px] disabled:opacity-50"
        >
          Extract Data
        </button>
      </div>

      {/* Draft reply */}
      {draft && (
        <div className="mb-4">
          <label className="block text-[12px] font-medium text-ink-2 mb-1">Draft Reply</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full border border-line-3 rounded-lg px-3 py-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={sending}
            className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 mt-2"
          >
            <Send size={12} />
            {sending ? "Sending..." : sent ? "Sent!" : "Send Reply"}
          </button>
        </div>
      )}

      {/* Extracted data */}
      {extracted && (
        <div>
          <label className="block text-[12px] font-medium text-ink-2 mb-1">Extracted Data</label>
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
      await api.sendDraft(id);
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
                      className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-md text-[14px] font-medium"
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
                      className="bg-accent hover:bg-accent-hover text-white px-3 h-8 rounded-md text-[13px] font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <Send size={12} />
                      {loading === d.id ? "Sending..." : "Send"}
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

  const send = async () => {
    setSending(true);
    try {
      await api.sendEmail(to, subject, body);
      setSent(true);
      setTo(""); setSubject(""); setBody("");
      setTimeout(() => setSent(false), 2000);
    } catch (e: any) { alert(e); }
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
            placeholder="Write your message..."
            rows={12}
            className="w-full border border-line rounded-lg px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <button
          onClick={send}
          disabled={sending || !to || !subject}
          className="bg-accent hover:bg-accent-hover text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50"
        >
          <Send size={14} />
          {sending ? "Sending..." : sent ? "Sent!" : "Send"}
        </button>
      </div>
    </div>
  );
}

function NewsletterTab() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiTone, setAiTone] = useState("neutral");
  const [aiLoading, setAiLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState("");
  const [sendResult, setSendResult] = useState<NewsletterSendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [templates, setTemplates] = useState<Newsletter[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [recipientCategoryFilter, setRecipientCategoryFilter] = useState<string | null>(null);
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null);
  const [attachmentSearch, setAttachmentSearch] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [excludeAsNeeded, setExcludeAsNeeded] = useState(false);
  const [excludeUnder10k, setExcludeUnder10k] = useState(false);
  // Dormant clients are excluded from newsletters by default — kept on record,
  // just not contacted. Untick to include them in a send.
  const [excludeDormant, setExcludeDormant] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState(0);
  const [scheduleCustomDate, setScheduleCustomDate] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduledSends, setScheduledSends] = useState<ScheduledSend[]>([]);
  const [showScheduled, setShowScheduled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocusedRef = useRef<"subject" | "body">("body");

  const defaultSubject = "Update from ClientHub";
  const defaultBody = "Hi {first_name},\n\nI hope you're doing well. I wanted to reach out and share some updates.\n\n[Your message here]\n\nBest regards,\n[Your name]";

  useEffect(() => {
    api.listClients().then((cs) => {
      setClients(cs);
      // Recipients pre-selected from the Clients view "Email" bulk action.
      // Stashed in sessionStorage to avoid a mount-race with the navigate event.
      const raw = sessionStorage.getItem("email_preselect_ids");
      if (raw) {
        sessionStorage.removeItem("email_preselect_ids");
        try {
          const ids = new Set<string>(JSON.parse(raw));
          setSelected(cs.filter((c) => ids.has(c.id)));
        } catch { /* ignore malformed stash */ }
      }
    });
    api.listCategories().then(setAllCategories);
    api.listNewsletters().then(setTemplates);
    api.listScheduledSends().then(setScheduledSends);
    if (!subject && !body) { setSubject(defaultSubject); setBody(defaultBody); }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      api.listScheduledSends().then(setScheduledSends);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const activeScheduled = scheduledSends.filter((s) => s.status === "pending" || s.status === "running");

  const categoryLabels = allCategories.map((c) => c.label);
  const validRecipients = selected.filter((c) => c.email);

  const filteredClients = recipientCategoryFilter
    ? clients.filter((c) => c.category?.toLowerCase().includes(recipientCategoryFilter.toLowerCase()))
    : clients;

  const searchedClients = clientSearch.trim()
    ? filteredClients.filter((c) =>
        c.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
        (c.email && c.email.toLowerCase().includes(clientSearch.toLowerCase()))
      )
    : filteredClients;

  const metadataFilteredClients = searchedClients.filter((c) => {
    if (excludeDormant && c.lead_status === "inactive") return false;
    if (excludeAsNeeded && c.metadata?.purchase_frequency === "As Needed / One Time") return false;
    if (excludeUnder10k && c.metadata?.estimated_annual_spend === "Under $10,000") return false;
    return true;
  });
  const excludedByFilter = searchedClients.length - metadataFilteredClients.length;

  const noEmailCount = selected.length - validRecipients.length;

  const addRecipient = (c: Client) => {
    if (!selected.find((s) => s.id === c.id)) setSelected([...selected, c]);
  };
  const removeRecipient = (id: string) => setSelected(selected.filter((c) => c.id !== id));
  const addAllWithEmail = () => {
    const toAdd = metadataFilteredClients.filter((c) => c.email && !selected.find((s) => s.id === c.id));
    setSelected([...selected, ...toAdd]);
  };

  const addManualEmail = async () => {
    const addr = manualEmail.trim();
    if (!addr || !addr.includes("@")) return;
    const existing = clients.find((c) => c.email?.toLowerCase() === addr.toLowerCase());
    if (existing) {
      if (!selected.find((s) => s.id === existing.id)) setSelected([...selected, existing]);
    } else {
      const newClient = await api.createClient({
        name: addr.split("@")[0],
        email: addr,
        needs_review: true,
        lead_status: "prospect",
      });
      setClients(await api.listClients());
      setSelected([...selected, newClient]);
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
    } catch (e: any) { alert(e); }
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
    setSendProgress("Sending...");
    try {
      const nl = await api.saveNewsletter(null, subject, body);
      const result = await api.sendNewsletter(nl.id, selected.map((c) => c.id), subject, body, attachmentPath);
      setSendResult(result);
      setSendProgress("");
      api.listNewsletters().then(setTemplates);
    } catch (e: any) {
      setSendProgress("");
      setSendError(String(e));
    } finally { setSending(false); }
  };

  const handleSchedule = async () => {
    if (validRecipients.length === 0 || !subject.trim() || !body.trim()) return;
    setScheduling(true);
    setSendError(null);
    try {
      const now = new Date();
      let intervalSeconds: number;
      let scheduledAt: string;

      if (scheduleInterval === 0) {
        intervalSeconds = 0;
        scheduledAt = now.toISOString();
      } else if (scheduleInterval === -1) {
        const parsed = new Date(scheduleCustomDate);
        if (isNaN(parsed.getTime())) { setSendError("Invalid date"); setScheduling(false); return; }
        if (parsed <= new Date(now.getTime() + 60000)) { setSendError("Must be at least 1 minute in the future"); setScheduling(false); return; }
        intervalSeconds = Math.max(3600, Math.floor((parsed.getTime() - now.getTime()) / 1000));
        scheduledAt = parsed.toISOString();
      } else {
        intervalSeconds = scheduleInterval;
        scheduledAt = now.toISOString();
      }

      await api.scheduleNewsletterSend(
        subject, body, validRecipients.map((c) => c.id),
        intervalSeconds, scheduledAt, attachmentPath,
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
    setSelected([]);
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

  const previewClient = validRecipients[previewIdx] || validRecipients[0];
  const previewSub = (t: string, c: Client) => t
    .replace(/\{\{?first_name\}?\}/g, c.name.split(" ")[0])
    .replace(/\{\{?full_name\}?\}/g, c.name)
    .replace(/\{\{?company\}?\}/g, c.company || "");
  const previewSubject = previewClient ? previewSub(subject, previewClient) : subject;
  const previewBody = previewClient ? previewSub(body, previewClient) : body;

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const charCount = body.length;

  return (
    <div className="nl-cols flex flex-col lg:flex-row gap-4" style={{ minHeight: 500 }}>
      {/* Panel A: Recipients */}
      <div className="nl-pane w-full lg:w-[300px] lg:flex-shrink-0 bg-surface border border-line rounded-lg flex flex-col">
        <div className="px-4 py-3 border-b border-line flex items-center justify-between">
          <span className="text-[14px] font-semibold text-ink">Clients</span>
          <span className="bg-accent/10 text-accent-hover text-[11px] font-medium px-2 py-0.5 rounded-full">{clients.length}</span>
        </div>

        <div className="px-3 py-2 border-b border-line">
          <select
            value={recipientCategoryFilter ?? ""}
            onChange={(e) => setRecipientCategoryFilter(e.target.value || null)}
            className="w-full border border-line-3 h-8 px-2 rounded-md text-[12px] bg-surface focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">All Categories</option>
            {categoryLabels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="px-3 py-2 border-b border-line">
          <input
            type="text"
            placeholder="Search clients by name or email..."
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            className="w-full border border-line-3 h-8 px-2 rounded-md text-[12px] focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="px-3 py-2 border-b border-line">
          <button onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-1 text-[11px] text-muted hover:text-ink-2 w-full">
            <ChevronDown size={11} className={`transition-transform ${showFilters ? "rotate-180" : ""}`} />
            Filter recipients
          </button>
          {showFilters && (
            <div className="mt-2 space-y-1.5">
              <label className="flex items-center gap-2 text-[11px] text-ink-2 cursor-pointer">
                <input type="checkbox" checked={excludeDormant} onChange={(e) => setExcludeDormant(e.target.checked)}
                  className="accent-accent" />
                Exclude dormant clients
              </label>
              <label className="flex items-center gap-2 text-[11px] text-ink-2 cursor-pointer">
                <input type="checkbox" checked={excludeAsNeeded} onChange={(e) => setExcludeAsNeeded(e.target.checked)}
                  className="accent-accent" />
                Exclude "As Needed / One Time"
              </label>
              <label className="flex items-center gap-2 text-[11px] text-ink-2 cursor-pointer">
                <input type="checkbox" checked={excludeUnder10k} onChange={(e) => setExcludeUnder10k(e.target.checked)}
                  className="accent-accent" />
                Exclude under $10k annual spend
              </label>
              {excludedByFilter > 0 && (
                <div className="text-[10px] text-warning-ink">{excludedByFilter} client{excludedByFilter !== 1 ? "s" : ""} excluded by filters</div>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto" style={{ maxHeight: 200, minHeight: 120 }}>
          {metadataFilteredClients.map((c) => {
            const isSelected = selected.find((s) => s.id === c.id);
            return (
              <button key={c.id}
                onClick={() => isSelected ? removeRecipient(c.id) : addRecipient(c)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between hover:bg-surface-2 transition-colors border-b border-gray-50 ${
                  isSelected ? "bg-accent/10" : ""
                }`}>
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-ink truncate">{c.name}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {c.category ? (
                      <span className="text-[10px] text-muted bg-surface-3 px-1.5 py-0.5 rounded truncate max-w-[140px]">{c.category}</span>
                    ) : (
                      <span className="text-[10px] text-faint">—</span>
                    )}
                    {!c.email && <span className="text-[9px] text-danger-ink">no email</span>}
                  </div>
                </div>
                {isSelected && <CheckCircle2 size={14} className="text-success-ink flex-shrink-0 ml-2" />}
              </button>
            );
          })}
          {metadataFilteredClients.length === 0 && (
            <div className="text-[12px] text-muted text-center py-6">{clientSearch || excludeDormant || excludeAsNeeded || excludeUnder10k ? "No clients match your filters" : "No clients match this filter"}</div>
          )}
        </div>

        <div className="border-t border-line">
          <div className="px-4 py-2 flex items-center justify-between bg-surface-2 border-b border-line">
            <span className="text-[12px] font-semibold text-ink-2">Recipients</span>
            <span className="bg-accent/10 text-accent-hover text-[11px] font-medium px-2 py-0.5 rounded-full">{selected.length}</span>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 140 }}>
            {selected.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-1.5 px-3 hover:bg-surface-2 border-b border-gray-50">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-ink truncate">{c.name}</div>
                  {c.email ? (
                    <div className="text-[10px] text-muted truncate">{c.email}</div>
                  ) : (
                    <span className="text-[9px] text-danger-ink bg-danger-bg px-1.5 py-0.5 rounded">No email</span>
                  )}
                </div>
                <button onClick={() => removeRecipient(c.id)} className="text-muted hover:text-danger-ink ml-2 flex-shrink-0 p-0.5">
                  <X size={14} />
                </button>
              </div>
            ))}
            {selected.length === 0 && (
              <div className="text-[11px] text-muted text-center py-4">Click a client above to add</div>
            )}
          </div>
        </div>

        <div className="px-3 py-2 border-t border-line text-[11px] text-muted space-y-1.5">
          <div className="flex items-center justify-between">
            <span>{selected.length} selected{noEmailCount > 0 && <span className="text-danger-ink"> ({noEmailCount} skipped)</span>}</span>
            <div className="flex items-center gap-2">
              <button onClick={addAllWithEmail} className="text-accent hover:text-indigo-800">All w/ email</button>
              {selected.length > 0 && <button onClick={() => setSelected([])} className="text-muted hover:text-danger-ink">Clear</button>}
            </div>
          </div>
          <div className="flex gap-1.5">
            <input
              placeholder="Or type an email address..."
              type="email"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addManualEmail()}
              className="flex-1 border border-line-3 h-7 px-2 rounded-md text-[11px] focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button onClick={addManualEmail} disabled={!manualEmail.includes("@")}
              className="bg-accent hover:bg-accent-hover text-white px-2.5 h-7 rounded-md text-[11px] font-medium disabled:opacity-40 transition-colors">
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Panel B: Compose */}
      <div className="nl-pane w-full lg:flex-1 flex flex-col gap-3 min-w-0">
        <div className="bg-surface border border-line rounded-lg flex flex-col flex-1">
          <div className="px-4 py-3 border-b border-line flex items-center gap-2">
            <Mail size={14} className="text-accent" />
            <span className="text-[14px] font-semibold text-ink">Compose</span>
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
                  Saved Templates ({templates.filter((t) => t.status === "draft").length})
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
              placeholder={`Hi {first_name},\n\nWrite your message here...\n\nBest regards,\n[Your name]`}
              rows={12}
              className="flex-1 w-full border border-line rounded-md px-3 py-2.5 text-[14px] font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onFocus={() => { lastFocusedRef.current = "body"; }}
            />

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
                  placeholder="Or paste file path..."
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
                  placeholder="Describe what this newsletter is about..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  className="flex-1 border border-line-3 px-3 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="flex rounded-md border border-line-3 overflow-hidden">
                  {["formal", "neutral", "casual"].map((t) => (
                    <button key={t} onClick={() => setAiTone(t)}
                      className={`px-3 h-9 text-[12px] font-medium transition-colors ${aiTone === t ? "bg-accent text-white" : "bg-surface text-ink-2 hover:bg-surface-2"}`}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
                <button onClick={generateAI} disabled={aiLoading || !aiPrompt.trim()}
                  className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-md text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap">
                  <Sparkles size={13} /> {aiLoading ? "Writing..." : "Generate"}
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* Panel C: Preview & Send */}
      <div className="nl-pane w-full lg:w-[320px] lg:flex-shrink-0 flex flex-col gap-3">
        <div className="bg-surface border border-line rounded-lg flex-1 flex flex-col">
          <div className="px-4 py-3 border-b border-line flex items-center gap-2">
            <Eye size={14} className="text-accent" />
            <span className="text-[14px] font-semibold text-ink">Preview</span>
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
                <div className="flex"><span className="text-muted w-10">From:</span><span className="text-ink-2">Your Business</span></div>
                <div className="flex"><span className="text-muted w-10">To:</span><span className="text-ink-2 truncate">{previewClient ? `${previewClient.name} <${previewClient.email}>` : "Recipient"}</span></div>
                <div className="flex"><span className="text-muted w-10">Subj:</span><span className="text-ink font-medium">{previewSubject || "No subject"}</span></div>
              </div>
              <div className="p-3 text-[13px] text-ink-2 whitespace-pre-wrap overflow-y-auto flex-1 bg-surface">
                {previewBody || "Start writing..."}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-lg p-4">
          {noEmailCount > 0 && (
            <div className="text-[12px] text-warning-ink bg-warning-bg border border-warning rounded-md px-3 py-2 mb-3">
              {noEmailCount} recipient{noEmailCount !== 1 ? "s" : ""} will be skipped (no email)
            </div>
          )}

          <button
            onClick={handleSend}
            disabled={sending || validRecipients.length === 0 || !subject.trim() || !body.trim()}
            className="w-full bg-accent hover:bg-accent-hover text-white rounded-md text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
            style={{ height: 44 }}
          >
            <Send size={16} />
            {sending ? sendProgress : `Send ${validRecipients.length} emails`}
          </button>

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
                { val: 0, label: "Send now — all " + validRecipients.length + " at once" },
                { val: 3600, label: "Spread over 1 hour — ~" + Math.ceil(validRecipients.length / 60) + " emails per minute" },
                { val: 7200, label: "Spread over 2 hours — ~" + Math.ceil(validRecipients.length / 120) + " emails per minute" },
                { val: 14400, label: "Spread over 4 hours — ~" + Math.ceil(validRecipients.length / 240) + " emails per minute" },
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
                <input type="datetime-local" value={scheduleCustomDate} onChange={(e) => setScheduleCustomDate(e.target.value)}
                  className="w-full border border-line-3 h-8 px-2 rounded-md text-[12px]" />
              )}
              <button onClick={handleSchedule} disabled={scheduling}
                className="w-full bg-accent hover:bg-accent-hover text-white rounded-md text-[12px] font-medium h-8 flex items-center justify-center gap-1.5 disabled:opacity-50">
                {scheduling ? "Scheduling..." : "Schedule"}
              </button>
            </div>
          )}

          {activeScheduled.length > 0 && (
            <div className="mt-3 border border-line rounded-md p-3 bg-info-bg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-info-ink">Scheduled Sends</span>
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
                </div>
              ))}
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
                              <span className="text-warning-ink ml-1">— {err.error}</span>
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
                    <div key={t.id} className="text-[12px] text-ink-2 py-1 border-b border-gray-50 last:border-0">
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
