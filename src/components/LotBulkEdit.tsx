import { useState } from "react";
import { X, Pencil } from "lucide-react";
import { api, Lot, LotBulkEditFields } from "../lib/api";
import { MAX_EXPIRE_DAYS } from "../lib/lotTimer";
import { lotTags, dedupeTags, isTagged } from "../lib/tags";
import { formatLocation, parseLocation } from "../lib/location";
import LocationField from "./LocationField";
import { toast } from "./Toast";

// R-566: one edit across every selected lot. Each field starts at "leave as is" and only
// what is filled in is written; the rules are in src-tauri/src/lot_bulk.rs, shared with
// the server, so the phone's mass edit does exactly the same thing.

const inp = "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const splitTags = (s: string) => dedupeTags(s.split(","));

export default function LotBulkEdit({ lots, categories, conditions, onClose, onSaved }: {
  lots: Lot[];
  categories: string[];
  conditions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [timer, setTimer] = useState<"keep" | "up" | "off">("keep");
  const [days, setDays] = useState(2);
  const [category, setCategory] = useState("");
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [condition, setCondition] = useState("");
  const [supplier, setSupplier] = useState("");
  const [saving, setSaving] = useState(false);

  const n = lots.length;
  const tagsOnLots = dedupeTags(lots.flatMap((l) => lotTags(l.details_json))).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const suppliers = Array.from(new Set(lots.map((l) => (l.supplier || "").trim()).filter(Boolean))).sort();

  const loc = (() => { const p = parseLocation(location); return formatLocation(p.city, p.state); })();
  const edit: LotBulkEditFields = {};
  if (timer !== "keep") edit.expire_days = timer === "up" ? 0 : Math.min(Math.max(1, days), MAX_EXPIRE_DAYS);
  if (category.trim()) edit.category = category.trim();
  if (splitTags(addTags).length) edit.add_tags = splitTags(addTags);
  if (removeTags.length) edit.remove_tags = removeTags;
  if (loc) edit.location = loc;
  if (condition.trim()) edit.condition = condition.trim();
  if (supplier.trim()) edit.supplier = supplier.trim();
  const nothing = Object.keys(edit).length === 0;

  const save = async () => {
    if (nothing) return;
    setSaving(true);
    try {
      const changed = await api.bulkEditLots(lots.map((l) => l.id), edit);
      toast(changed === 0 ? "Nothing to change: the lots already had that" : `Updated ${changed} lot${changed !== 1 ? "s" : ""}`);
      onSaved();
    } catch (e: any) { toast(String(e), "error"); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/30 backdrop-blur-[3px] overflow-y-auto" onClick={() => !saving && onClose()}>
      <div className="bg-surface rounded-2xl border border-line shadow-[0_8px_24px_rgba(0,0,0,0.12)] w-[480px] max-w-[94vw] mb-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <Pencil size={14} className="text-muted flex-shrink-0" />
            <h3 className="text-[14px] font-semibold text-ink">Edit {n} lot{n !== 1 ? "s" : ""}</h3>
          </div>
          <button onClick={onClose} disabled={saving} className="text-muted hover:text-ink-2"><X size={16} /></button>
        </div>
        <p className="px-5 pt-3 text-[12px] text-muted">Only what you fill in changes. Everything left blank stays as it is on each lot.</p>

        <div className="px-5 py-4 space-y-4">
          <div>
            <div className="text-[12.5px] font-medium text-ink">On the site</div>
            <div className="flex flex-col gap-2 mt-1.5 text-[12.5px] text-ink-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="bulk-expire" className="accent-accent" checked={timer === "keep"} onChange={() => setTimer("keep")} />
                Leave as it is
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="bulk-expire" className="accent-accent" checked={timer === "up"} onChange={() => setTimer("up")} />
                Stays up until I take it down
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="bulk-expire" className="accent-accent" checked={timer === "off"} onChange={() => setTimer("off")} />
                Comes off
                <input type="number" min={1} max={MAX_EXPIRE_DAYS} step={1} value={days}
                  onFocus={() => setTimer("off")}
                  onChange={(e) => { const v = Math.floor(Number(e.target.value)); setDays(Number.isFinite(v) && v > 0 ? Math.min(v, MAX_EXPIRE_DAYS) : 1); }}
                  className="w-16 h-8 px-2 rounded-lg border border-line bg-surface text-[13px] text-ink tabular-nums" />
                {days === 1 ? "day" : "days"} from today
              </label>
            </div>
            {timer === "off" && (
              <span className="block text-[11px] text-muted mt-1.5">Each lot is renewed now and comes off the site {days === 1 ? "a day" : `${days} days`} from today, then archived. You can restore it from archived.</span>
            )}
          </div>

          <label className="block">
            <span className="text-[12.5px] font-medium text-ink">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${inp} mt-1.5`}>
              <option value="">Leave as it is</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {category && <span className="block text-[11px] text-muted mt-1">Each lot's categories become just {category}.</span>}
          </label>

          <div>
            <span className="text-[12.5px] font-medium text-ink">Tags</span>
            <input value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="Add tags, separated by commas" className={`${inp} mt-1.5`} />
            {tagsOnLots.length > 0 && (
              <div className="mt-2">
                <span className="text-[11px] text-muted">Remove from these lots:</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {tagsOnLots.map((t) => {
                    const on = isTagged(removeTags, t);
                    return (
                      <button key={t} type="button" onClick={() => setRemoveTags(on ? removeTags.filter((x) => x !== t) : [...removeTags, t])}
                        className={`text-[11.5px] px-2 h-6 rounded-full border transition-colors ${on ? "border-danger text-danger-ink bg-danger-bg line-through" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div>
            <span className="text-[12.5px] font-medium text-ink">Location</span>
            <div className="mt-1.5"><LocationField value={location} onChange={setLocation} /></div>
          </div>

          <label className="block">
            <span className="text-[12.5px] font-medium text-ink">Condition</span>
            <input value={condition} onChange={(e) => setCondition(e.target.value)} list="bulk-conditions" placeholder="Leave as it is" className={`${inp} mt-1.5`} />
            <datalist id="bulk-conditions">{conditions.map((c) => <option key={c} value={c} />)}</datalist>
          </label>

          <label className="block">
            <span className="text-[12.5px] font-medium text-ink">Supplier</span>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} list="bulk-suppliers" placeholder="Leave as it is" className={`${inp} mt-1.5`} />
            <datalist id="bulk-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
          <button onClick={onClose} disabled={saving} className="text-[13px] text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2 transition-colors">Cancel</button>
          <button onClick={save} disabled={nothing || saving}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
            {saving ? "Saving…" : `Save to ${n} lot${n !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
