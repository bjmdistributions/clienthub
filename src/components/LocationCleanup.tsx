import { useEffect, useState } from "react";
import { X, MapPin, AlertTriangle, Check, Loader2 } from "lucide-react";
import { api, LotLocationGroup } from "../lib/api";
import {
  formatLocation, needsLocationReview, parseLocation, proposeLocation,
  LocationConfidence,
} from "../lib/location";
import { StatePicker } from "./LocationField";

interface Row {
  /** The value stored today. This is what we match on when writing. */
  from: string;
  lotCount: number;
  city: string;
  state: string;
  confidence: LocationConfidence;
  reason: string;
}

/**
 * One-off cleanup for locations typed before the field was structured.
 *
 * Every row is proposed, never applied on its own — the two cases a script gets
 * wrong are exactly the ones sitting in the real data ("LA" could be Los Angeles
 * or Louisiana; "Virgina" is a typo), and a wrong state silently moves a load to
 * the wrong place on the public map. The write itself backs up the previous
 * values first; the confirm step says where.
 */
export default function LocationCleanup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ lots: number; backup: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let groups: LotLocationGroup[] = [];
      try {
        groups = await api.listLotLocations();
      } catch (e) {
        if (!cancelled) setErr(String(e));
        return;
      }
      const todo = groups.filter((g) => needsLocationReview(g.value));
      // A bare city ("Chicago") needs the gazetteer to propose a state.
      const built = await Promise.all(
        todo.map(async (g): Promise<Row> => {
          const parsed = parseLocation(g.value);
          let cities: { state: string; population: number }[] = [];
          if (!parsed.state && parsed.city) {
            try { cities = await api.statesForCity(parsed.city); } catch { /* propose without it */ }
          }
          const p = proposeLocation(g.value, cities);
          return { from: g.value, lotCount: g.lot_count, city: p.city, state: p.state, confidence: p.confidence, reason: p.reason };
        }),
      );
      if (!cancelled) setRows(built);
    })();
    return () => { cancelled = true; };
  }, []);

  const patch = (i: number, p: Partial<Row>) =>
    setRows((r) => (r ? r.map((row, j) => (j === i ? { ...row, ...p } : row)) : r));

  const changes = (rows || [])
    .map((r) => ({ from: r.from, to: formatLocation(r.city, r.state) }))
    .filter((c) => c.to && c.to !== c.from);

  const unresolved = (rows || []).filter((r) => !r.state).length;
  const lotsAffected = (rows || [])
    .filter((r) => { const to = formatLocation(r.city, r.state); return to && to !== r.from; })
    .reduce((s, r) => s + r.lotCount, 0);

  const apply = async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await api.applyLocationNormalization(changes);
      setDone({ lots: res.lots_updated, backup: res.backup_path });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const badge = (c: LocationConfidence) =>
    c === "certain"
      ? { cls: "text-success-ink bg-success-bg border-success-ink/20", label: "Clear" }
      : c === "assumed"
      ? { cls: "text-warning-ink bg-warning-bg border-warning-ink/20", label: "Check this" }
      : { cls: "text-danger-ink bg-danger-bg border-danger-ink/20", label: "Needs you" };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40" onMouseDown={onClose}>
      <div className="bg-surface border border-line rounded-xl shadow-xl w-full max-w-3xl max-h-[86vh] flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
          <div>
            <div className="text-[14px] font-semibold text-ink flex items-center gap-2">
              <MapPin size={15} className="text-accent" /> Tidy up lot locations
            </div>
            <p className="text-[12px] text-muted mt-1 max-w-xl">
              These were typed before the location field had a state picker. Setting a state puts each load on the
              storefront's FOB map. Nothing is written until you press apply, and the current values are backed up first.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink shrink-0"><X size={16} /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          {rows === null && (
            <div className="flex items-center gap-2 text-[13px] text-muted py-8 justify-center">
              <Loader2 size={14} className="animate-spin" /> Reading your locations…
            </div>
          )}

          {rows?.length === 0 && (
            <div className="text-center py-10">
              <Check size={22} className="text-success-ink mx-auto mb-2" />
              <div className="text-[13px] text-ink font-medium">Every location is already in the right format.</div>
              <p className="text-[12px] text-muted mt-1">Nothing to fix.</p>
            </div>
          )}

          {done && (
            <div className="mb-4 rounded-lg border border-success-ink/25 bg-success-bg px-3.5 py-3">
              <div className="text-[13px] font-medium text-success-ink flex items-center gap-2">
                <Check size={14} /> Updated {done.lots} lot{done.lots === 1 ? "" : "s"}.
              </div>
              <p className="text-[11.5px] text-ink-2 mt-1 break-all">Previous values saved to {done.backup}</p>
            </div>
          )}

          {!!rows?.length && !done && (
            <div className="space-y-2">
              {rows.map((r, i) => {
                const to = formatLocation(r.city, r.state);
                const b = badge(r.confidence);
                return (
                  <div key={r.from} className="border border-line rounded-lg p-3">
                    <div className="flex items-center justify-between gap-3 mb-2.5">
                      <div className="min-w-0">
                        <span className="text-[13px] font-medium text-ink">{r.from}</span>
                        <span className="text-[11.5px] text-muted ml-2">
                          {r.lotCount} lot{r.lotCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <span className={`text-[10.5px] px-2 py-0.5 rounded-full border shrink-0 ${b.cls}`}>{b.label}</span>
                    </div>

                    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <input
                        className="border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                        value={r.city}
                        onChange={(e) => patch(i, { city: e.target.value })}
                        placeholder="City — optional"
                      />
                      <StatePicker value={r.state} onChange={(s) => patch(i, { state: s })} placeholder="Pick a state" />
                      <div className="text-[12px] tabular-nums pl-1 min-w-[7.5rem]">
                        {to ? (
                          <span className={to === r.from ? "text-muted" : "text-ink font-medium"}>{to}</span>
                        ) : (
                          <span className="text-muted">no change</span>
                        )}
                      </div>
                    </div>

                    {r.reason && (
                      <p className="text-[11px] text-muted mt-2 flex items-start gap-1.5">
                        {r.confidence !== "certain" && <AlertTriangle size={11} className="mt-0.5 shrink-0 text-warning-ink" />}
                        {r.reason}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {err && <p className="text-[12px] text-danger-ink mt-3">{err}</p>}
        </div>

        {!!rows?.length && !done && (
          <div className="border-t border-line px-5 py-3.5 flex items-center justify-between gap-4">
            <div className="text-[11.5px] text-muted">
              {changes.length === 0
                ? "Nothing changed yet."
                : `${changes.length} value${changes.length === 1 ? "" : "s"} · ${lotsAffected} lot${lotsAffected === 1 ? "" : "s"} will be updated.`}
              {unresolved > 0 && (
                <span className="text-warning-ink">
                  {" "}
                  {unresolved} still {unresolved === 1 ? "has" : "have"} no state and will be left alone.
                </span>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={onClose} className="border border-line rounded-lg px-3 h-9 text-[12.5px] text-ink-2 hover:bg-surface-2">
                Cancel
              </button>
              <button
                onClick={apply}
                disabled={saving || changes.length === 0}
                className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[12.5px] font-medium disabled:opacity-50"
              >
                {saving ? "Applying…" : `Apply ${changes.length || ""}`.trim()}
              </button>
            </div>
          </div>
        )}

        {(done || rows?.length === 0) && (
          <div className="border-t border-line px-5 py-3.5 flex justify-end">
            <button onClick={onClose} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[12.5px] font-medium">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Named export so the parent can show the banner without opening the modal. */
export function useLocationsNeedingReview(reloadKey: unknown) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.listLotLocations()
      .then((gs) => { if (!cancelled) setCount(gs.filter((g) => needsLocationReview(g.value)).length); })
      .catch(() => { if (!cancelled) setCount(0); });
    return () => { cancelled = true; };
  }, [reloadKey]);
  return count;
}
