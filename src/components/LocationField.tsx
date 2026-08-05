import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, ChevronDown, Search } from "lucide-react";
import { api, CityEntry } from "../lib/api";
import { US_STATES, formatLocation, parseLocation, stateName } from "../lib/location";

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

/**
 * Searchable US state picker. Type to filter by name or code, arrows to move,
 * Enter to take the highlighted one. A native <select> was the alternative, but
 * 52 options with no type-ahead beyond the first letter is exactly the fiddliness
 * this field is meant to remove.
 */
export function StatePicker({ value, onChange, placeholder = "Select a state" }: {
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return US_STATES;
    // Name prefix beats code match beats a match anywhere in the name, so typing
    // "in" puts Indiana above California.
    const score = (st: { code: string; name: string }) => {
      const n = st.name.toLowerCase();
      if (n.startsWith(s)) return 0;
      if (st.code.toLowerCase() === s) return 1;
      if (n.includes(s)) return 2;
      return 3;
    };
    return US_STATES.filter((st) => score(st) < 3).sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }, [q]);

  useEffect(() => setHi(0), [q]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const take = (code: string) => {
    onChange(code);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${inp} flex items-center justify-between gap-2 text-left ${value ? "text-ink" : "text-muted"}`}
      >
        <span className="truncate">{value ? `${stateName(value)} · ${value}` : placeholder}</span>
        <ChevronDown size={14} className="text-muted shrink-0" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-2.5 border-b border-line">
            <Search size={13} className="text-muted shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(i + 1, matches.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
                else if (e.key === "Enter") { e.preventDefault(); if (matches[hi]) take(matches[hi].code); }
                else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
              }}
              placeholder="Type a state…"
              className="h-9 flex-1 bg-transparent text-[13px] focus:outline-none"
            />
            {!!value && (
              <button type="button" onClick={() => take("")} className="text-[11px] text-muted hover:text-ink shrink-0">
                Clear
              </button>
            )}
          </div>
          <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
            {matches.length === 0 && <div className="px-3 py-2 text-[12px] text-muted">No state matches that.</div>}
            {matches.map((st, i) => (
              <button
                key={st.code}
                type="button"
                data-i={i}
                onMouseEnter={() => setHi(i)}
                onClick={() => take(st.code)}
                className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center justify-between gap-2 ${
                  i === hi ? "bg-surface-2 text-ink" : "text-ink-2"
                } ${st.code === value ? "font-medium" : ""}`}
              >
                <span className="truncate">{st.name}</span>
                <span className="text-[11px] text-muted tabular-nums shrink-0">{st.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The FOB location control: a city box with real-gazetteer autocomplete, and the
 * state picker beside it. Both are optional — a lot with neither simply has no
 * location, and a lot with only a state still lands on the storefront map.
 *
 * The parent keeps holding ONE string, exactly as before; this component just
 * guarantees it is always in canonical "City, ST" / "ST" form.
 */
export default function LocationField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = useMemo(() => parseLocation(value), [value]);
  const [city, setCity] = useState(parsed.city);
  const [state, setState] = useState(parsed.state);
  const [sug, setSug] = useState<CityEntry[]>([]);
  const [showSug, setShowSug] = useState(false);
  const cityRef = useRef<HTMLDivElement>(null);
  // A city typed by hand shouldn't be overwritten by a suggestion arriving late.
  const typedAt = useRef(0);

  // Re-read when the parent swaps in a different lot (edit → edit another).
  useEffect(() => {
    const p = parseLocation(value);
    setCity(p.city);
    setState(p.state);
  }, [value]);

  const push = (c: string, s: string) => {
    setCity(c);
    setState(s);
    onChange(formatLocation(c, s));
  };

  // City autocomplete from the bundled gazetteer.
  useEffect(() => {
    const q = city.trim();
    if (q.length < 2) { setSug([]); return; }
    const at = ++typedAt.current;
    let cancelled = false;
    const t = setTimeout(() => {
      api.suggestCity(q, 7)
        .then((r) => { if (!cancelled && at === typedAt.current) setSug(r); })
        .catch(() => { if (!cancelled) setSug([]); });
    }, 140);
    return () => { cancelled = true; clearTimeout(t); };
  }, [city]);

  useEffect(() => {
    if (!showSug) return;
    const h = (e: MouseEvent) => {
      if (cityRef.current && !cityRef.current.contains(e.target as Node)) setShowSug(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showSug]);

  const preview = formatLocation(city, state);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="relative" ref={cityRef}>
          <input
            className={inp}
            value={city}
            onChange={(e) => { push(e.target.value, state); setShowSug(true); }}
            onFocus={() => setShowSug(true)}
            placeholder="City — optional"
          />
          {showSug && sug.length > 0 && (
            <div className="absolute z-30 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg overflow-hidden max-h-56 overflow-y-auto py-1">
              {sug.map((c) => (
                <button
                  key={`${c.city}-${c.state}`}
                  type="button"
                  onClick={() => { push(c.city, c.state); setShowSug(false); }}
                  className="w-full text-left px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink flex items-center justify-between gap-2"
                >
                  <span className="truncate">{c.city}</span>
                  <span className="text-[11px] text-muted shrink-0">{c.state}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <StatePicker value={state} onChange={(s) => push(city, s)} placeholder="State — optional" />
      </div>

      <p className="text-[10.5px] text-muted flex items-center gap-1.5">
        <MapPin size={11} className="shrink-0" />
        {preview ? (
          <>Saved as <span className="text-ink-2 font-medium">{preview}</span>{state ? " — shows on the storefront map." : " — add a state to place it on the storefront map."}</>
        ) : (
          <>Optional. A lot with a state appears on the storefront's FOB map.</>
        )}
      </p>
    </div>
  );
}
