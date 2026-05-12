import { useEffect, useState, useRef } from "react";
import { api, ParsedEmail, EmailDraft, Client, Newsletter, Category } from "../lib/api";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Sparkles, RefreshCw, Mail, Send, Inbox, AlertCircle, FileEdit, Trash2,
  Users, X, Search, ChevronDown, Eye, Megaphone, CheckCircle2, Paperclip,
} from "lucide-react";

type Mode = "inbox" | "compose" | "drafts" | "newsletter";

export default function EmailView() {
  const [mode, setMode] = useState<Mode>("inbox");
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
        <h2 className="text-[18px] font-semibold text-gray-900">AI Email</h2>
      </div>

      {/* Underline tabs */}
      <div className="flex gap-0 border-b border-gray-200 mb-5">
        {(["inbox", "drafts", "compose", "newsletter"] as const).map((m) => {
          const icons = { inbox: Inbox, drafts: FileEdit, compose: Mail, newsletter: Megaphone };
          const labels = { inbox: "Inbox", drafts: "Drafts", compose: "Compose", newsletter: "Newsletter" };
          const Icon = icons[m];
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-[14px] border-b-2 -mb-px transition-colors ${
                mode === m
                  ? "border-indigo-600 text-indigo-700 font-medium"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              <Icon size={14} />
              {labels[m]}
              {m === "drafts" && draftCount > 0 && (
                <span className="bg-indigo-600 text-white text-[11px] font-medium rounded-full px-1.5 py-0.5 leading-none ml-0.5">
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
            <p className="text-[13px] text-gray-500">
              Pulls unread emails since the last scan, parses them, and matches against known clients.
            </p>
            <button
              onClick={scan}
              disabled={scanning}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning..." : "Scan Inbox"}
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-5">
            {/* Email list */}
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 text-[13px] font-semibold text-gray-700">
                Recent ({emails.length})
              </div>
              <div className="max-h-[600px] overflow-auto">
                {emails.map((e) => (
                  <button
                    key={e.uid}
                    onClick={() => setSelected(e)}
                    className={`w-full text-left px-4 py-3.5 border-b border-gray-100 transition-colors ${
                      selected?.uid === e.uid ? "bg-indigo-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <div className="font-medium text-[13px] text-gray-900 truncate">
                      {e.from_name || e.from}
                    </div>
                    <div className="text-[13px] text-gray-600 truncate mt-0.5">{e.subject}</div>
                    <div className="text-[12px] text-gray-400 truncate mt-0.5">
                      {e.body_text.slice(0, 80)}
                    </div>
                  </button>
                ))}
                {emails.length === 0 && !scanning && (
                  <div className="px-4 py-10 text-center text-[13px] text-gray-400">
                    No emails. Configure SMTP/IMAP in Settings, then scan.
                  </div>
                )}
              </div>
            </div>

            {/* Email detail */}
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              {selected ? (
                <EmailDetail email={selected} />
              ) : (
                <div className="h-full flex items-center justify-center text-[14px] text-gray-400">
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
      <div className="border-b border-gray-100 pb-4 mb-4">
        <div className="text-[13px]">
          <span className="text-[12px] font-medium text-gray-500">From: </span>
          <span className="font-medium text-gray-800">
            {email.from_name || email.from} &lt;{email.from}&gt;
          </span>
        </div>
        <div className="text-[13px] mt-0.5">
          <span className="text-[12px] font-medium text-gray-500">Subject: </span>
          <span className="text-gray-800">{email.subject}</span>
        </div>
        {email.date && (
          <div className="text-[11px] text-gray-400 mt-1">
            {new Date(email.date).toLocaleString()}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="bg-gray-50 border border-gray-100 px-4 py-3 rounded-lg text-[13px] text-gray-700 whitespace-pre-wrap max-h-48 overflow-auto mb-4">
        {email.body_text}
      </div>

      {/* AI actions */}
      <div className="flex gap-2 mb-4">
        <select
          value={tone}
          onChange={(e) => { setTone(e.target.value); localStorage.setItem("clienthub_draft_tone", e.target.value); }}
          className="border border-gray-300 px-3 h-9 rounded-md text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="neutral">Neutral</option>
          <option value="formal">Formal</option>
          <option value="casual">Casual</option>
        </select>
        <button
          onClick={handleDraft}
          disabled={loading !== null}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 disabled:opacity-50"
        >
          {loading === "draft" ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
          Draft Reply
        </button>
        <button
          onClick={handleExtract}
          disabled={loading !== null}
          className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px] disabled:opacity-50"
        >
          Extract Data
        </button>
      </div>

      {/* Draft reply */}
      {draft && (
        <div className="mb-4">
          <label className="block text-[12px] font-medium text-gray-600 mb-1">Draft Reply</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={sending}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 mt-2"
          >
            <Send size={12} />
            {sending ? "Sending..." : sent ? "Sent!" : "Send Reply"}
          </button>
        </div>
      )}

      {/* Extracted data */}
      {extracted && (
        <div>
          <label className="block text-[12px] font-medium text-gray-600 mb-1">Extracted Data</label>
          <pre className="bg-gray-50 border border-gray-100 px-4 py-3 rounded-lg text-[12px] overflow-auto">
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
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="py-12 text-center text-[14px] text-gray-400">No pending drafts.</div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <div key={d.id} className="bg-white border border-gray-200 rounded-lg p-4">
              {editing === d.id ? (
                <div>
                  <input
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={6}
                    className="border border-gray-300 px-3 py-2.5 rounded-md text-[14px] w-full mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(d.id)}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[14px] font-medium text-gray-900">{d.subject}</div>
                      <div className="text-[12px] text-gray-500 mt-0.5">To: {d.to_addr}</div>
                    </div>
                    <div className="text-[11px] text-gray-400 tabular-nums">
                      {new Date(d.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-[13px] text-gray-600 mt-2 whitespace-pre-wrap line-clamp-3">
                    {d.body}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => handleSend(d.id)}
                      disabled={loading === d.id}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 h-8 rounded-md text-[13px] font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <Send size={12} />
                      {loading === d.id ? "Sending..." : "Send"}
                    </button>
                    <button
                      onClick={() => handleEdit(d)}
                      className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 h-8 rounded-md text-[13px] flex items-center gap-1"
                    >
                      <FileEdit size={12} /> Edit
                    </button>
                    <button
                      onClick={() => handleDiscard(d.id)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 px-3 h-8 rounded-md text-[13px] flex items-center gap-1 border border-transparent hover:border-red-200"
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
    <div className="bg-white border border-gray-200 rounded-lg max-w-2xl overflow-hidden">
      <div className="px-5 py-4 space-y-3">
        <div>
          <label className="block text-[12px] font-medium text-gray-500 mb-1">To</label>
          <input
            placeholder="recipient@example.com"
            className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-gray-500 mb-1">Subject</label>
          <input
            placeholder="Subject"
            className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-gray-500 mb-1">Message</label>
          <textarea
            placeholder="Write your message..."
            rows={12}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <button
          onClick={send}
          disabled={sending || !to || !subject}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50"
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
  const [sendResult, setSendResult] = useState<{ sent: number; failed: number; errors: string[] } | null>(null);
  const [templates, setTemplates] = useState<Newsletter[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [recipientCategoryFilter, setRecipientCategoryFilter] = useState<string | null>(null);
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null);
  const [attachmentSearch, setAttachmentSearch] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const defaultSubject = "Update from ClientHub";
  const defaultBody = "Hi {{first_name}},\n\nI hope you're doing well. I wanted to reach out and share some updates.\n\n[Your message here]\n\nBest regards,\n[Your name]";

  useEffect(() => {
    api.listClients().then(setClients);
    api.listCategories().then(setAllCategories);
    api.listNewsletters().then(setTemplates);
    if (!subject && !body) { setSubject(defaultSubject); setBody(defaultBody); }
  }, []);

  const categoryLabels = allCategories.map((c) => c.label);
  const validRecipients = selected.filter((c) => c.email);

  const filteredClients = recipientCategoryFilter
    ? clients.filter((c) => c.category?.toLowerCase().includes(recipientCategoryFilter.toLowerCase()))
    : clients;

  const noEmailCount = selected.length - validRecipients.length;

  const addRecipient = (c: Client) => {
    if (!selected.find((s) => s.id === c.id)) setSelected([...selected, c]);
  };
  const removeRecipient = (id: string) => setSelected(selected.filter((c) => c.id !== id));
  const addAllWithEmail = () => {
    const toAdd = filteredClients.filter((c) => c.email && !selected.find((s) => s.id === c.id));
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

  const insertPlaceholder = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = body.slice(0, start);
    const after = body.slice(end);
    setBody(before + "{{first_name}}" + after);
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + 14; }, 0);
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

  const handleSend = async () => {
    const count = validRecipients.length;
    if (!confirm(`Send to ${count} recipient${count !== 1 ? "s" : ""}? Each will receive an individual email. This cannot be undone.`)) return;
    setSending(true);
    setSendResult(null);
    setSendProgress("Sending...");
    try {
      const nl = await api.saveNewsletter(null, subject, body);
      const result = await api.sendNewsletter(nl.id, selected.map((c) => c.id), subject, body, attachmentPath);
      setSendResult(result);
      setSendProgress("");
      api.listNewsletters().then(setTemplates);
    } catch (e: any) {
      setSendProgress("");
      alert(e);
    } finally { setSending(false); }
  };

  const startNew = () => {
    setSubject(defaultSubject);
    setBody(defaultBody);
    setSelected([]);
    setAttachmentPath(null);
    setAiPrompt("");
    setSendResult(null);
    setShowHistory(false);
    setPreviewIdx(0);
  };

  const previewClient = validRecipients[previewIdx] || validRecipients[0];
  const previewSubject = previewClient
    ? subject.replace(/\{\{first_name\}\}/g, previewClient.name.split(" ")[0])
    : subject;
  const previewBody = previewClient
    ? body.replace(/\{\{first_name\}\}/g, previewClient.name.split(" ")[0])
    : body;

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const charCount = body.length;

  return (
    <div className="flex gap-4" style={{ minHeight: 500 }}>
      {/* Panel A: Recipients */}
      <div className="w-[300px] flex-shrink-0 bg-white border border-gray-200 rounded-lg flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="text-[14px] font-semibold text-gray-900">Clients</span>
          <span className="bg-indigo-50 text-indigo-700 text-[11px] font-medium px-2 py-0.5 rounded-full">{clients.length}</span>
        </div>

        <div className="px-3 py-2 border-b border-gray-100">
          <select
            value={recipientCategoryFilter ?? ""}
            onChange={(e) => setRecipientCategoryFilter(e.target.value || null)}
            className="w-full border border-gray-300 h-8 px-2 rounded-md text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">All Categories</option>
            {categoryLabels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ maxHeight: 200 }}>
          {filteredClients.map((c) => {
            const isSelected = selected.find((s) => s.id === c.id);
            return (
              <button key={c.id}
                onClick={() => isSelected ? removeRecipient(c.id) : addRecipient(c)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between hover:bg-gray-50 transition-colors border-b border-gray-50 ${
                  isSelected ? "bg-indigo-50" : ""
                }`}>
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-gray-800 truncate">{c.name}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {c.category ? (
                      <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded truncate max-w-[140px]">{c.category}</span>
                    ) : (
                      <span className="text-[10px] text-gray-300">—</span>
                    )}
                    {!c.email && <span className="text-[9px] text-red-400">no email</span>}
                  </div>
                </div>
                {isSelected && <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0 ml-2" />}
              </button>
            );
          })}
          {filteredClients.length === 0 && (
            <div className="text-[12px] text-gray-400 text-center py-6">No clients match this filter</div>
          )}
        </div>

        <div className="border-t border-gray-200">
          <div className="px-4 py-2 flex items-center justify-between bg-gray-50 border-b border-gray-100">
            <span className="text-[12px] font-semibold text-gray-700">Recipients</span>
            <span className="bg-indigo-50 text-indigo-700 text-[11px] font-medium px-2 py-0.5 rounded-full">{selected.length}</span>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 140 }}>
            {selected.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-1.5 px-3 hover:bg-gray-50 border-b border-gray-50">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-gray-800 truncate">{c.name}</div>
                  {c.email ? (
                    <div className="text-[10px] text-gray-400 truncate">{c.email}</div>
                  ) : (
                    <span className="text-[9px] text-red-500 bg-red-50 px-1.5 py-0.5 rounded">No email</span>
                  )}
                </div>
                <button onClick={() => removeRecipient(c.id)} className="text-gray-400 hover:text-red-500 ml-2 flex-shrink-0 p-0.5">
                  <X size={14} />
                </button>
              </div>
            ))}
            {selected.length === 0 && (
              <div className="text-[11px] text-gray-400 text-center py-4">Click a client above to add</div>
            )}
          </div>
        </div>

        <div className="px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500 space-y-1.5">
          <div className="flex items-center justify-between">
            <span>{selected.length} selected{noEmailCount > 0 && <span className="text-red-500"> ({noEmailCount} skipped)</span>}</span>
            <div className="flex items-center gap-2">
              <button onClick={addAllWithEmail} className="text-indigo-600 hover:text-indigo-800">All w/ email</button>
              {selected.length > 0 && <button onClick={() => setSelected([])} className="text-gray-400 hover:text-red-500">Clear</button>}
            </div>
          </div>
          <div className="flex gap-1.5">
            <input
              placeholder="Or type any email..."
              type="email"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addManualEmail()}
              className="flex-1 border border-gray-300 h-7 px-2 rounded-md text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button onClick={addManualEmail} disabled={!manualEmail.includes("@")}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 h-7 rounded-md text-[11px] font-medium disabled:opacity-40 transition-colors">
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Panel B: Compose */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        <div className="bg-white border border-gray-200 rounded-lg flex flex-col flex-1">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Mail size={14} className="text-indigo-500" />
            <span className="text-[14px] font-semibold text-gray-900">Compose</span>
          </div>
          <div className="p-4 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <input
                placeholder="Subject (use {{first_name}} for personalization)"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="flex-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <select
                value=""
                onChange={(e) => {
                  const nl = templates.find((t) => t.id === e.target.value);
                  if (nl) loadTemplate(nl);
                }}
                className="border border-gray-300 h-10 px-2 rounded-md text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 max-w-[130px]"
              >
                <option value="">Load template</option>
                {templates.filter((t) => t.status === "draft").map((t) => (
                  <option key={t.id} value={t.id}>{t.subject || "Untitled"}</option>
                ))}
              </select>
              <button onClick={saveTemplate}
                className="border border-gray-300 h-10 px-2.5 rounded-md text-[12px] text-gray-600 hover:bg-gray-50 whitespace-nowrap">
                Save
              </button>
              <button onClick={() => { setSubject(defaultSubject); setBody(defaultBody); }}
                className="text-[11px] text-gray-400 hover:text-gray-600 whitespace-nowrap underline">
                Reset default
              </button>
            </div>

            <div className="flex items-center gap-3 mb-2 text-[12px] text-gray-500">
              <button onClick={insertPlaceholder} className="text-indigo-600 hover:text-indigo-800 font-medium bg-indigo-50 px-2 py-0.5 rounded">
                Insert {`{{first_name}}`}
              </button>
              <span className="tabular-nums">{charCount} chars</span>
              <span className="tabular-nums">{wordCount} words</span>
            </div>

            <textarea
              ref={textareaRef}
              placeholder={`Hi {{first_name}},\n\nWrite your message here...\n\nBest regards,\n[Your name]`}
              rows={12}
              className="flex-1 w-full border border-gray-200 rounded-md px-3 py-2.5 text-[14px] font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />

            <div className="mt-3 flex items-center gap-2">
              <button onClick={pickFile}
                className="flex items-center gap-1.5 border border-gray-300 h-9 px-3 rounded-md text-[12px] text-gray-600 hover:bg-gray-50 transition-colors">
                <Paperclip size={13} /> Attach file
              </button>
              {attachmentPath && (
                <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1.5 text-[12px] text-gray-700 flex-1 min-w-0">
                  <span className="truncate">{attachmentPath.split(/[\\/]/).pop()}</span>
                  <button onClick={() => setAttachmentPath(null)} className="text-gray-400 hover:text-red-500 flex-shrink-0">
                    <X size={12} />
                  </button>
                </div>
              )}
              {!attachmentPath && attachmentSearch && (
                <input
                  placeholder="Or paste file path..."
                  value={attachmentSearch}
                  onChange={(e) => { setAttachmentSearch(e.target.value); if (e.target.value) setAttachmentPath(e.target.value); }}
                  className="flex-1 border border-gray-300 h-9 px-3 rounded-md text-[12px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              )}
            </div>

            <details className="mt-3 bg-gray-50 rounded-md border border-gray-100">
              <summary className="px-3 py-2 text-[13px] font-medium text-gray-700 cursor-pointer flex items-center gap-1.5 select-none">
                <Sparkles size={13} className="text-indigo-500" /> AI Assist
              </summary>
              <div className="px-3 pb-3 flex items-center gap-2">
                <input
                  placeholder="Describe what this newsletter is about..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  className="flex-1 border border-gray-300 px-3 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <div className="flex rounded-md border border-gray-300 overflow-hidden">
                  {["formal", "neutral", "casual"].map((t) => (
                    <button key={t} onClick={() => setAiTone(t)}
                      className={`px-3 h-9 text-[12px] font-medium transition-colors ${aiTone === t ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
                <button onClick={generateAI} disabled={aiLoading || !aiPrompt.trim()}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap">
                  <Sparkles size={13} /> {aiLoading ? "Writing..." : "Generate"}
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* Panel C: Preview & Send */}
      <div className="w-[320px] flex-shrink-0 flex flex-col gap-3">
        <div className="bg-white border border-gray-200 rounded-lg flex-1 flex flex-col">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Eye size={14} className="text-indigo-500" />
            <span className="text-[14px] font-semibold text-gray-900">Preview</span>
          </div>
          <div className="p-4 flex-1 flex flex-col">
            <select
              value={previewIdx}
              onChange={(e) => setPreviewIdx(Number(e.target.value))}
              className="w-full border border-gray-300 h-8 px-2 rounded-md text-[12px] mb-3 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {validRecipients.length === 0 && <option value={0}>Sample recipient</option>}
              {validRecipients.map((c, i) => (
                <option key={c.id} value={i}>{c.name}</option>
              ))}
            </select>

            <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm flex-1 flex flex-col">
              <div className="bg-gray-50 px-3 py-2 border-b border-gray-200 space-y-0.5 text-[12px]">
                <div className="flex"><span className="text-gray-400 w-10">From:</span><span className="text-gray-700">Your Business</span></div>
                <div className="flex"><span className="text-gray-400 w-10">To:</span><span className="text-gray-700 truncate">{previewClient ? `${previewClient.name} <${previewClient.email}>` : "Recipient"}</span></div>
                <div className="flex"><span className="text-gray-400 w-10">Subj:</span><span className="text-gray-900 font-medium">{previewSubject || "No subject"}</span></div>
              </div>
              <div className="p-3 text-[13px] text-gray-700 whitespace-pre-wrap overflow-y-auto flex-1 bg-white">
                {previewBody || "Start writing..."}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4">
          {noEmailCount > 0 && (
            <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
              {noEmailCount} recipient{noEmailCount !== 1 ? "s" : ""} will be skipped (no email)
            </div>
          )}

          <button
            onClick={handleSend}
            disabled={sending || validRecipients.length === 0 || !subject.trim() || !body.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
            style={{ height: 44 }}
          >
            <Send size={16} />
            {sending ? sendProgress : `Send ${validRecipients.length} emails`}
          </button>

          {sendResult && (
            <div className={`mt-3 text-[13px] px-3 py-2 rounded-md ${sendResult.failed > 0 ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-emerald-50 text-emerald-800 border border-emerald-200"}`}>
              {sendResult.failed === 0 ? (
                <div>
                  <div className="flex items-center gap-1.5 font-medium mb-1">
                    <CheckCircle2 size={14} /> Sent successfully
                  </div>
                  <div className="text-[12px]">{sendResult.sent} email{sendResult.sent !== 1 ? "s" : ""} sent</div>
                </div>
              ) : (
                <div>
                  <div className="font-medium mb-1">{sendResult.sent} sent, {sendResult.failed} failed</div>
                  {sendResult.errors.length > 0 && (
                    <button onClick={() => alert(sendResult.errors.join("\n"))} className="underline text-[12px]">View errors</button>
                  )}
                </div>
              )}
              <button onClick={startNew}
                className="mt-2 w-full bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-md text-[12px] font-medium py-1.5 transition-colors">
                + Compose new
              </button>
            </div>
          )}

          {templates.filter((t) => t.status === "sent").length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <button onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-700 w-full">
                <ChevronDown size={12} className={`transition-transform ${showHistory ? "rotate-180" : ""}`} />
                Send history
              </button>
              {showHistory && (
                <div className="mt-2 space-y-1.5">
                  {templates.filter((t) => t.status === "sent").slice(0, 5).map((t) => (
                    <div key={t.id} className="text-[12px] text-gray-600 py-1 border-b border-gray-50 last:border-0">
                      <div className="font-medium text-gray-800 truncate">{t.subject || "Untitled"}</div>
                      <div className="text-gray-400">{new Date(t.created_at).toLocaleDateString()} · {t.sent_count} sent</div>
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
