import { useState } from "react";
import { api } from "../lib/api";

// Feedback used to be a modal launched from a sidebar icon, which put a three-field
// form behind an icon nobody could name and stacked it over whatever you were doing.
// It is a Settings section now: same fields, no overlay, nothing to dismiss.
export function FeedbackPanel({ me }: { me: { display_name?: string; email?: string } | null | undefined }) {
  const [kind, setKind] = useState("feature");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const send = async () => {
    if (!title.trim()) { setMsg("Add a short title."); return; }
    setBusy(true); setMsg("");
    try {
      await api.submitFeedback(kind, title.trim(), body.trim(), me?.display_name, me?.email);
      setMsg("Thanks — sent."); setTitle(""); setBody("");
    } catch {
      setMsg("Failed to send — check your connection.");
    }
    setBusy(false);
  };

  return (
    <div className="max-w-md">
      <select value={kind} onChange={(e) => setKind(e.target.value)}
        className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink mb-3">
        <option value="feature">Feature request</option>
        <option value="bug">Bug report</option>
      </select>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" maxLength={160}
        className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink mb-3 focus:outline-none focus:ring-2 focus:ring-accent/40" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Details"
        className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink mb-2 resize-y focus:outline-none focus:ring-2 focus:ring-accent/40" />
      <div className={`text-[12px] mb-2 min-h-[18px] ${msg.startsWith("Thanks") ? "text-success-ink" : "text-danger-ink"}`}>{msg}</div>
      <button disabled={busy} onClick={send}
        className="bg-accent hover:bg-accent-hover text-on-accent h-9 px-5 rounded-lg text-[13px] font-medium disabled:opacity-50">
        {busy ? "Sending…" : "Send feedback"}
      </button>
    </div>
  );
}
