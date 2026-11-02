import { useState } from "react";
import { api, type DealFlow } from "../lib/api";
import { LEG_NAME, legLine, type DealLegs, type LegKey } from "../lib/dealLegs";
import { toast } from "./Toast";

// R-578 (Jack: "it takes for ever to find that hidden little button to make a reason for payment not being exact"): every
// payment that is short or missing gets its reason box right where completion says so. Saving marks the leg "No payment
// recorded" with that note (R-555), so the deal can complete with what is linked; the figures do not move.
export default function OpenLegReasons({ flow, legs, keys, onSaved }: {
  flow: DealFlow; legs: DealLegs; keys: LegKey[]; onSaved: () => void;
}) {
  const [why, setWhy] = useState<Partial<Record<LegKey, string>>>({});
  const [busy, setBusy] = useState(false);
  // Legs marked here before the deal reloads, so a second save never takes the first one's mark off.
  const [marked, setMarked] = useState<LegKey[]>([]);

  const save = async (k: LegKey) => {
    const note = (why[k] || "").trim();
    if (!note || busy) return;
    let meta: any = {};
    try { meta = JSON.parse((flow as any).metadata || "{}"); } catch { /* no flags yet */ }
    const on = (key: LegKey, flag: string) => key === k || marked.includes(key) || !!meta[flag];
    setBusy(true);
    try {
      await api.setDealLinkNa(flow.id, on("buyer", "no_buyer_link"), on("supplier", "no_supplier_link"), on("shipping", "no_shipping_link"), { [k]: note });
      setMarked((m) => [...m, k]);
      toast(`${LEG_NAME[k]}: reason saved`);
      onSaved();
    } catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      {keys.map((k) => (
        <div key={k} className="space-y-1.5">
          <div className={legs[k].state === "missing" ? "text-danger-ink" : "text-warning-ink"}>{legLine(k, legs[k])}</div>
          <div className="flex items-center gap-2">
            <input value={why[k] || ""} onChange={(e) => setWhy((w) => ({ ...w, [k]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void save(k); }}
              placeholder={legs[k].state === "part" ? "Why it is short, e.g. carrier paid next week" : "Why there is no payment, e.g. paid in cash"}
              className="flex-1 min-w-0 border border-line px-2.5 h-8 rounded-lg text-[12px] text-ink bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40" />
            <button onClick={() => void save(k)} disabled={busy || !(why[k] || "").trim()}
              className="flex-shrink-0 h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium disabled:opacity-40 transition-colors">
              Save reason
            </button>
          </div>
        </div>
      ))}
      <div className="text-[11.5px] text-ink-2">Or link the rest in Link financials. A reason lets the deal complete with what is linked.</div>
    </div>
  );
}
