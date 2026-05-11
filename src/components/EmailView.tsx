import { useEffect, useState } from "react";
import { api, ParsedEmail, EmailDraft } from "../lib/api";
import {
  Sparkles,
  RefreshCw,
  Mail,
  Send,
  Inbox,
  AlertCircle,
  FileEdit,
  Trash2,
} from "lucide-react";

type Mode = "inbox" | "compose" | "drafts";

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
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">AI Email</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setMode("inbox")}
            className={`px-3 py-1.5 text-sm rounded ${
              mode === "inbox" ? "bg-slate-900 text-white" : "bg-slate-100"
            }`}
          >
            <Inbox size={14} className="inline mr-1" /> Inbox
          </button>
          <button
            onClick={() => setMode("drafts")}
            className={`px-3 py-1.5 text-sm rounded ${
              mode === "drafts" ? "bg-slate-900 text-white" : "bg-slate-100"
            }`}
          >
            <FileEdit size={14} className="inline mr-1" /> Drafts
            {draftCount > 0 && (
              <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5">
                {draftCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setMode("compose")}
            className={`px-3 py-1.5 text-sm rounded ${
              mode === "compose" ? "bg-slate-900 text-white" : "bg-slate-100"
            }`}
          >
            <Mail size={14} className="inline mr-1" /> Compose
          </button>
        </div>
      </div>

      {mode === "inbox" && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-slate-600">
              Pulls unread emails since the last scan, parses them, and matches
              against known clients.
            </p>
            <button
              onClick={scan}
              disabled={scanning}
              className="bg-slate-900 text-white px-3 py-2 rounded text-sm flex items-center gap-2 disabled:opacity-50"
            >
              <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning..." : "Scan Inbox"}
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded text-sm flex items-center gap-2 mb-3">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded shadow overflow-hidden">
              <div className="p-3 border-b font-semibold text-sm">
                Recent ({emails.length})
              </div>
              <div className="max-h-[600px] overflow-auto">
                {emails.map((e) => (
                  <button
                    key={e.uid}
                    onClick={() => setSelected(e)}
                    className={`w-full text-left p-3 border-b hover:bg-slate-50 ${
                      selected?.uid === e.uid ? "bg-slate-100" : ""
                    }`}
                  >
                    <div className="font-semibold text-sm truncate">
                      {e.from_name || e.from}
                    </div>
                    <div className="text-sm truncate">{e.subject}</div>
                    <div className="text-xs text-slate-500 truncate mt-1">
                      {e.body_text.slice(0, 80)}
                    </div>
                  </button>
                ))}
                {emails.length === 0 && !scanning && (
                  <div className="p-6 text-center text-slate-400 text-sm">
                    No emails. Configure SMTP/IMAP in Settings, then scan.
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white rounded shadow p-4">
              {selected ? (
                <EmailDetail email={selected} />
              ) : (
                <div className="text-slate-400 text-sm">Select an email to view.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {mode === "compose" && <ComposeView />}

      {mode === "drafts" && (
        <DraftsTab onAction={refreshDraftCount} />
      )}
    </div>
  );
}

// ========== Email Detail w/ AI ==========
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
    } catch (e: any) {
      alert(e);
    } finally {
      setLoading(null);
    }
  };

  const handleExtract = async () => {
    setLoading("extract");
    try {
      setExtracted(await api.aiExtractData(email.body_text));
    } catch (e: any) {
      alert(e);
    } finally {
      setLoading(null);
    }
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
    } catch (e: any) {
      alert(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="border-b pb-3 mb-3">
        <div className="text-sm">
          <span className="text-slate-500">From: </span>
          <span className="font-semibold">
            {email.from_name || email.from} &lt;{email.from}&gt;
          </span>
        </div>
        <div className="text-sm">
          <span className="text-slate-500">Subject: </span>
          {email.subject}
        </div>
        {email.date && (
          <div className="text-xs text-slate-400 mt-1">
            {new Date(email.date).toLocaleString()}
          </div>
        )}
      </div>

      <div className="bg-slate-50 p-3 rounded text-sm whitespace-pre-wrap max-h-48 overflow-auto mb-3">
        {email.body_text}
      </div>

      <div className="flex gap-2 mb-3">
        <select
          value={tone}
          onChange={(e) => { setTone(e.target.value); localStorage.setItem("clienthub_draft_tone", e.target.value); }}
          className="border p-1.5 rounded text-sm"
        >
          <option value="neutral">Neutral</option>
          <option value="formal">Formal</option>
          <option value="casual">Casual</option>
        </select>
        <button
          onClick={handleDraft}
          disabled={loading !== null}
          className="bg-slate-900 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1 disabled:opacity-50"
        >
          {loading === "draft" ? (
            <RefreshCw size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          Draft Reply
        </button>
        <button
          onClick={handleExtract}
          disabled={loading !== null}
          className="bg-slate-200 px-3 py-1.5 rounded text-sm disabled:opacity-50"
        >
          Extract Data
        </button>
      </div>

      {draft && (
        <div className="mb-3">
          <label className="text-xs font-semibold">Draft Reply</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full border rounded p-2 text-sm mt-1"
          />
          <button
            onClick={handleSend}
            disabled={sending}
            className="bg-green-600 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1 mt-2"
          >
            <Send size={12} />
            {sending ? "Sending..." : sent ? "Sent!" : "Send Reply"}
          </button>
        </div>
      )}

      {extracted && (
        <div>
          <label className="text-xs font-semibold">Extracted Data</label>
          <pre className="bg-slate-50 p-2 rounded text-xs overflow-auto mt-1">
            {JSON.stringify(extracted, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ========== Drafts Queue ==========
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

  useEffect(() => {
    load();
  }, []);

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
    } catch (e: any) {
      setError(e.toString());
    }
  };

  const handleSend = async (id: string) => {
    setLoading(id);
    setError(null);
    try {
      await api.sendDraft(id);
      onAction();
      await load();
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(null);
    }
  };

  const handleDiscard = async (id: string) => {
    try {
      await api.discardDraft(id);
      onAction();
      await load();
    } catch (e: any) {
      setError(e.toString());
    }
  };

  return (
    <div>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded text-sm flex items-center gap-2 mb-3">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="p-6 text-center text-slate-400 text-sm">
          No pending drafts.
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <div key={d.id} className="bg-white rounded shadow p-4">
              {editing === d.id ? (
                <div>
                  <input
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    className="border rounded p-2 text-sm w-full mb-2"
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={6}
                    className="border rounded p-2 text-sm w-full mb-2"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(d.id)}
                      className="bg-slate-900 text-white px-3 py-1.5 rounded text-sm"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="bg-slate-100 px-3 py-1.5 rounded text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm font-semibold">{d.subject}</div>
                      <div className="text-xs text-slate-500">To: {d.to_addr}</div>
                    </div>
                    <div className="text-xs text-slate-400">
                      {new Date(d.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-sm text-slate-600 mt-2 whitespace-pre-wrap line-clamp-3">
                    {d.body}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => handleSend(d.id)}
                      disabled={loading === d.id}
                      className="bg-green-600 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1 disabled:opacity-50"
                    >
                      <Send size={12} />
                      {loading === d.id ? "Sending..." : "Send"}
                    </button>
                    <button
                      onClick={() => handleEdit(d)}
                      className="bg-slate-100 px-3 py-1.5 rounded text-sm flex items-center gap-1"
                    >
                      <FileEdit size={12} /> Edit
                    </button>
                    <button
                      onClick={() => handleDiscard(d.id)}
                      className="bg-slate-100 text-red-600 px-3 py-1.5 rounded text-sm flex items-center gap-1"
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

// ========== Compose ==========
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
      setTo("");
      setSubject("");
      setBody("");
      setTimeout(() => setSent(false), 2000);
    } catch (e: any) {
      alert(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-white rounded shadow p-4 max-w-2xl">
      <input
        placeholder="To"
        className="border-b w-full p-2 outline-none"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input
        placeholder="Subject"
        className="border-b w-full p-2 outline-none"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        placeholder="Message..."
        rows={12}
        className="w-full p-2 outline-none"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button
        onClick={send}
        disabled={sending || !to || !subject}
        className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex items-center gap-1 disabled:opacity-50"
      >
        <Send size={14} />
        {sending ? "Sending..." : sent ? "Sent!" : "Send"}
      </button>
    </div>
  );
}
