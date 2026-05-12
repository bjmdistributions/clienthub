import { useEffect, useState, useRef } from "react";
import { api, Client } from "../lib/api";
import { X, Send, Phone, Users, FileText, Mail } from "lucide-react";

interface Props {
  onClose: () => void;
}

const KIND_CONFIG: Record<string, { label: string; icon: React.ReactNode }> = {
  call:      { label: "Call",     icon: <Phone size={12} /> },
  meeting:   { label: "Meeting",  icon: <Users size={12} /> },
  note:      { label: "Note",     icon: <FileText size={12} /> },
  email_out: { label: "Email",    icon: <Mail size={12} /> },
};

const KINDS = Object.keys(KIND_CONFIG);

export default function QuickLogModal({ onClose }: Props) {
  const [clientQuery, setClientQuery]   = useState("");
  const [suggestions, setSuggestions]   = useState<Client[]>([]);
  const [selected,    setSelected]      = useState<Client | null>(null);
  const [kind,        setKind]          = useState("call");
  const [body,        setBody]          = useState("");
  const [submitting,  setSubmitting]    = useState(false);
  const [toast,       setToast]         = useState<{ msg: string; ok: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (clientQuery.length < 2) { setSuggestions([]); return; }
      try {
        setSuggestions(await api.searchClients(clientQuery));
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
      setToast({ msg: "Logged successfully", ok: true });
      setTimeout(() => onClose(), 700);
    } catch (e: any) {
      setToast({ msg: e.toString(), ok: false });
    } finally {
      setSubmitting(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/25 backdrop-blur-[2px] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.14),0_8px_24px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] w-[500px] max-h-[80vh] overflow-auto animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <h3 className="text-[15px] font-semibold text-gray-900">Quick Log</h3>
            <span className="text-[10px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded-md">L</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          {/* Client search */}
          <div className="relative">
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Client</label>
            <input
              ref={inputRef}
              className="border border-gray-200 px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
              placeholder="Type client name..."
              value={clientQuery}
              onChange={(e) => { setClientQuery(e.target.value); setSelected(null); }}
              onKeyDown={handleKey}
            />
            {suggestions.length > 0 && !selected && (
              <div className="absolute top-full left-0 right-0 bg-white border border-gray-100 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.08)] mt-1 z-10 max-h-44 overflow-auto">
                {suggestions.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-4 py-2.5 text-[14px] text-gray-800 hover:bg-gray-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
                    onClick={() => select(c)}
                  >
                    {c.name}
                    {c.company && (
                      <span className="text-[13px] text-gray-400 ml-2">— {c.company}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Interaction type */}
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Type</label>
            <div className="flex gap-1.5">
              {KINDS.map((k) => {
                const cfg = KIND_CONFIG[k];
                return (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`flex items-center gap-1.5 px-3 h-8 text-[12px] font-medium rounded-lg transition-colors ${
                      kind === k
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    {cfg.icon}
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Note body */}
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Note</label>
            <textarea
              rows={5}
              className="border border-gray-200 px-3 py-2.5 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors resize-none"
              placeholder="What happened..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
            />
            <div className="text-[10px] text-gray-300 mt-1">Enter to submit · Shift+Enter for new line</div>
          </div>

          {/* Toast */}
          {toast && (
            <div
              className={`text-[13px] px-4 py-2.5 rounded-lg animate-fade-in ${
                toast.ok
                  ? "bg-[#1A1A1E] text-emerald-400"
                  : "bg-red-50 border border-red-200 text-red-700"
              }`}
            >
              {toast.msg}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-4 h-9 text-[13px] text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting || !selected || !body.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 disabled:opacity-40 transition-colors"
            >
              <Send size={13} />
              {submitting ? "Saving..." : "Log"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
