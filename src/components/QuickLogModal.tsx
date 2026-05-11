import { useEffect, useState, useRef } from "react";
import { api, Client } from "../lib/api";
import { X, Send } from "lucide-react";

interface Props {
  onClose: () => void;
}

const KINDS = ["call", "meeting", "note", "email_out"];

export default function QuickLogModal({ onClose }: Props) {
  const [clientQuery, setClientQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [kind, setKind] = useState("call");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (clientQuery.length < 2) { setSuggestions([]); return; }
      try {
        const r = await api.searchClients(clientQuery);
        setSuggestions(r);
      } catch { setSuggestions([]); }
    }, 150);
    return () => clearTimeout(t);
  }, [clientQuery]);

  const select = (c: Client) => {
    setSelected(c);
    setClientQuery(c.name);
    setSuggestions([]);
  };

  const submit = async () => {
    if (!selected || !body.trim()) return;
    setSubmitting(true);
    try {
      await api.addInteraction({
        client_id: selected.id,
        kind,
        body: body.trim(),
      });
      setToast("Logged");
      setTimeout(() => onClose(), 600);
    } catch (e: any) {
      setToast(e.toString());
    } finally {
      setSubmitting(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[500px] max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold">Quick Log</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4">
          <div className="relative">
            <label className="block text-xs font-semibold text-slate-600 mb-1">Client</label>
            <input
              ref={inputRef}
              className="border p-2 rounded w-full text-sm"
              placeholder="Type client name..."
              value={clientQuery}
              onChange={(e) => { setClientQuery(e.target.value); setSelected(null); }}
              onKeyDown={handleKey}
            />
            {suggestions.length > 0 && !selected && (
              <div className="absolute top-full left-0 right-0 bg-white border rounded shadow-lg mt-0.5 z-10 max-h-40 overflow-auto">
                {suggestions.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                    onClick={() => select(c)}
                  >
                    {c.name}
                    {c.company && <span className="text-slate-400 ml-2">— {c.company}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Type</label>
            <div className="flex gap-2">
              {KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`px-3 py-1 text-sm rounded ${kind === k ? "bg-slate-900 text-white" : "bg-slate-100"}`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Note</label>
            <textarea
              ref={bodyRef}
              rows={5}
              className="border p-2 rounded w-full text-sm"
              placeholder="What happened..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            />
          </div>

          {toast && (
            <div className={`text-sm px-3 py-2 rounded ${toast === "Logged" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"}`}>
              {toast}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm">Cancel</button>
            <button
              onClick={submit}
              disabled={submitting || !selected || !body.trim()}
              className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex items-center gap-2 disabled:opacity-50"
            >
              <Send size={14} />
              {submitting ? "Saving..." : "Log"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
