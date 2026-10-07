import { useState, useEffect, useRef } from "react";
import { api, GlobalSearchResults, type LogisticsSearchResults } from "../lib/api";
import { User, FileText, Briefcase, Package, Search, Truck, ScrollText, Contact } from "lucide-react";
import { openLogisticsHit, searchHits, searchable, type LogisticsHit } from "../lib/logisticsSearch";

interface Props {
  onClose: () => void;
  /** R-459: a Logistics-only account has no clients, invoices or deals to search, only loads, BOLs and carriers. */
  logisticsOnly?: boolean;
}

type Item = { type: string; id: string; label: string; sub: string; icon: typeof User };

const LOGISTICS_ICON: Record<LogisticsHit["kind"], typeof User> = { Load: Truck, BOL: ScrollText, Carrier: Contact };

export default function CommandPalette({ onClose, logisticsOnly = false }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResults | null>(null);
  const [lg, setLg] = useState<LogisticsSearchResults | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Only the newest question's answer is kept: a slow answer to "LD-00" must not land over "LD-0012".
  const asked = useRef(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      const text = query.trim();
      const mine = ++asked.current;
      if (!text) { setResults(null); setLg(null); return; }
      // R-459: the Logistics routes answer loads, BOLs and carriers by number or name. Offline, or for someone the
      // routes refuse, this stays quiet and the rest of the palette still answers.
      const logistics = searchable(text)
        ? api.logistics.search(text).catch(() => null)
        : Promise.resolve(null);
      const local = logisticsOnly ? Promise.resolve(null) : api.globalSearch(text).catch(() => null);
      const [l, g] = await Promise.all([logistics, local]);
      if (mine !== asked.current) return;
      setLg(l); setResults(g);
    }, 150);
    return () => clearTimeout(t);
  }, [query, logisticsOnly]);

  const allItems: Item[] = [];
  if (results) {
    for (const c of results.clients) allItems.push({ type: "Client", id: c.id, label: c.name, sub: c.company || c.email || "", icon: User });
    for (const i of results.invoices) allItems.push({ type: "Invoice", id: i.id, label: i.number, sub: i.client_name, icon: FileText });
    for (const d of results.deals) allItems.push({ type: "Deal", id: d.id, label: d.title, sub: d.client_name, icon: Briefcase });
    for (const s of results.suppliers) allItems.push({ type: "Supplier", id: s.id, label: s.name, sub: "", icon: Package });
  }
  for (const h of searchHits(lg, logisticsOnly)) allItems.push({ type: h.kind, id: h.id, label: h.label, sub: h.sub, icon: LOGISTICS_ICON[h.kind] });
  const answered = results !== null || lg !== null;

  const navigate = (item: Item) => {
    if (item.type === "Client") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
      setTimeout(() => window.dispatchEvent(new CustomEvent("navigate-to-client", { detail: item.id })), 100);
    } else if (item.type === "Invoice") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
    } else if (item.type === "Deal") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "completed" }));
    } else if (item.type === "Supplier") {
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "suppliers" }));
    } else if (item.type === "Load" || item.type === "BOL" || item.type === "Carrier") {
      // R-459: open the record itself, not just its screen.
      openLogisticsHit({ kind: item.type, id: item.id });
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
      <div className="bg-surface rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[60vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <Search size={16} className="text-muted flex-shrink-0" />
          <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0); }}
            onKeyDown={handleKey}
            placeholder={logisticsOnly ? "Search loads, BOLs, carriers..." : "Search clients, invoices, deals, suppliers, loads, BOLs..."}
            className="flex-1 text-[15px] outline-none text-ink placeholder:text-muted" />
          <kbd className="text-[10px] text-muted bg-surface-3 px-1.5 py-0.5 rounded font-mono">Esc</kbd>
        </div>
        {answered && allItems.length > 0 && (
          <div className="overflow-y-auto max-h-[50vh] py-1">
            {allItems.map((item, i) => (
              <button key={`${item.type}-${item.id}`}
                onClick={() => navigate(item)}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${i === selectedIdx ? "bg-accent/10" : "hover:bg-surface-2"}`}>
                <span className="w-6 flex items-center justify-center text-muted flex-shrink-0"><item.icon size={15} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{item.label}</div>
                  <div className="text-[11px] text-muted truncate">{item.sub}</div>
                </div>
                <span className="text-[10px] text-faint font-medium">{item.type}</span>
              </button>
            ))}
          </div>
        )}
        {answered && allItems.length === 0 && query.trim() && (
          <div className="px-4 py-8 text-center text-[13px] text-muted">No results for "{query}"</div>
        )}
      </div>
    </div>
  );
}
