import { useState } from "react";
import { api } from "../lib/api";

export function FeedbackModal({ me, onClose }: { me: { display_name?: string; email?: string } | null; onClose: () => void }) {
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
      setMsg("Thanks! 🙌"); setTitle(""); setBody("");
      setTimeout(onClose, 1100);
    } catch (e) {
      setMsg("Failed to send — check your connection.");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-ink">Send feedback</h3>
          <button onClick={onClose} className="text-muted hover:text-ink text-[15px] leading-none">✕</button>
        </div>
        <p className="text-[12px] text-muted mb-4">Request a feature or report a bug — it goes straight to the team.</p>
        <select value={kind} onChange={(e) => setKind(e.target.value)}
          className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink mb-3">
          <option value="feature">💡 Feature request</option>
          <option value="bug">🐞 Bug report</option>
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" maxLength={160}
          className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink mb-3 focus:outline-none focus:ring-2 focus:ring-accent/40" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Details"
          className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink mb-2 resize-y focus:outline-none focus:ring-2 focus:ring-accent/40" />
        <div className="text-[12px] mb-2 min-h-[18px]" style={{ color: msg.startsWith("Thanks") ? "#34d399" : "#f87171" }}>{msg}</div>
        <button disabled={busy} onClick={send}
          className="w-full bg-accent hover:bg-accent-hover text-on-accent h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
          {busy ? "Sending…" : "Send feedback"}
        </button>
      </div>
    </div>
  );
}
