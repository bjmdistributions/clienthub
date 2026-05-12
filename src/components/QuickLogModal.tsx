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
      await api.addInteraction({ client_id: selected.id, kind, body: body.trim() });
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.14),0_8px_24px_rgba(0,0,0,0.08)] w-[500px] max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-gray-900">Quick Log</h3>
            <span className="text-[11px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded">L</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Client search */}
          <div className="relative">
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Client</label>
            <input
              ref={inputRef}
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Type client name..."
              value={clientQuery}
              onChange={(e) => { setClientQuery(e.target.value); setSelected(null); }}
              onKeyDown={handleKey}
            />
            {suggestions.length > 0 && !selected && (
              <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.08)] mt-1 z-10 max-h-40 overflow-auto">
                {suggestions.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-4 py-2.5 text-[14px] text-gray-800 hover:bg-gray-50 transition-colors"
                    onClick={() => select(c)}
                  >
                    {c.name}
                    {c.company && <span className="text-[13px] text-gray-400 ml-2">— {c.company}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Interaction type */}
          <div>
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Type</label>
            <div className="flex gap-2">
              {KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`px-3 h-8 text-[13px] font-medium rounded-md transition-colors ${
                    kind === k
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {/* Note body */}
          <div>
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Note</label>
            <textarea
              ref={bodyRef}
              rows={5}
              className="border border-gray-300 px-3 py-2.5 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="What happened..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
            />
          </div>

          {/* Toast */}
          {toast && (
            <div className={`text-[13px] px-4 py-2.5 rounded-lg ${
              toast === "Logged"
                ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                : "bg-red-50 border border-red-200 text-red-700"
            }`}>
              {toast}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-4 h-9 text-[14px] text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting || !selected || !body.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-40"
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
