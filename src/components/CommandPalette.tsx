import { useState, useEffect, useRef } from "react";
import { api, GlobalSearchResults } from "../lib/api";

interface Props {
  onClose: () => void;
}

export default function CommandPalette({ onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResults | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (query.trim()) setResults(await api.globalSearch(query.trim()));
      else setResults(null);
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  const allItems: { type: string; id: string; label: string; sub: string; icon: string }[] = [];
  if (results) {
    for (const c of results.clients) allItems.push({ type: "Client", id: c.id, label: c.name, sub: c.company || c.email || "", icon: "\ud83d\udc64" });
    for (const i of results.invoices) allItems.push({ type: "Invoice", id: i.id, label: i.number, sub: i.client_name, icon: "\ud83d\udcc4" });
    for (const d of results.deals) allItems.push({ type: "Deal", id: d.id, label: d.title, sub: d.client_name, icon: "\ud83d\udcbc" });
    for (const s of results.suppliers) allItems.push({ type: "Supplier", id: s.id, label: s.name, sub: "", icon: "\ud83d\udce6" });
  }

  const navigate = (item: typeof allItems[0]) => {
    if (item.type === "Client") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
      setTimeout(() => window.dispatchEvent(new CustomEvent("navigate-to-client", { detail: item.id })), 100);
    } else if (item.type === "Invoice") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
    } else if (item.type === "Deal") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "deals" }));
    } else if (item.type === "Supplier") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "suppliers" }));
    }
    onClose();
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, allItems.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && allItems[selectedIdx]) { navigate(allItems[selectedIdx]); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-2xl w-[560px] max-h-[60vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <span className="text-muted text-[16px]">\ud83d\udd0d</span>
          <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0); }}
            onKeyDown={handleKey}
            placeholder="Search clients, invoices, deals, suppliers..."
            className="flex-1 text-[15px] outline-none text-ink placeholder:text-muted" />
          <kbd className="text-[10px] text-muted bg-surface-3 px-1.5 py-0.5 rounded font-mono">Esc</kbd>
        </div>
        {results && allItems.length > 0 && (
          <div className="overflow-y-auto max-h-[50vh] py-1">
            {allItems.map((item, i) => (
              <button key={`${item.type}-${item.id}`}
                onClick={() => navigate(item)}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${i === selectedIdx ? "bg-accent/10" : "hover:bg-surface-2"}`}>
                <span className="text-[16px] w-6 text-center">{item.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{item.label}</div>
                  <div className="text-[11px] text-muted truncate">{item.sub}</div>
                </div>
                <span className="text-[10px] text-faint font-medium uppercase">{item.type}</span>
              </button>
            ))}
          </div>
        )}
        {results && allItems.length === 0 && query.trim() && (
          <div className="px-4 py-8 text-center text-[13px] text-muted">No results for "{query}"</div>
        )}
      </div>
    </div>
  );
}
