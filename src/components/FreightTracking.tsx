// R-277: Priority1 freight tracking on Deal Flow.
//
// Shipments are built on the Rust side from Priority1's tracking emails (shipments.rs) and
// synced. This file is the three places they show: a status pill on a deal's collapsed row,
// a Freight panel inside the open deal (paste a BOL/PRO to attach, see the timeline), and a
// "not on a deal yet" list with a suggested deal for each. One shared store so every deal
// card reads the same list without each one fetching it.
import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ExternalLink, Mail, Truck, X } from "lucide-react";
import { api, type Shipment, type ShipmentDealSuggestion } from "../lib/api";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// ── shared store ─────────────────────────────────────────────────────────────
let cache: Shipment[] = [];
let signature = "";
let listening = false;
const subs = new Set<() => void>();
// R-279: Priority1 can move a deal's dates, so a screen showing those dates re-reads when
// the shipments change (an email the desktop just read, or a link made on the phone).
const changeSubs = new Set<() => void>();

export async function refreshShipments() {
  try {
    const next = await api.listShipments();
    const sig = next.map((x) => `${x.id}:${x.updated_at}:${x.deal_flow_id}`).join("|");
    const changed = signature !== "" && sig !== signature;
    signature = sig;
    cache = next;
    subs.forEach((f) => f());
    if (changed) changeSubs.forEach((f) => f());
  } catch { /* the table arrives with the migration; an older DB just shows nothing */ }
}

/** Call `onChange` whenever the shipment list changes after the first load. */
export function useShipmentChanges(onChange: () => void) {
  useEffect(() => {
    changeSubs.add(onChange);
    return () => { changeSubs.delete(onChange); };
  }, [onChange]);
}

function subscribe(f: () => void) {
  subs.add(f);
  if (!listening) {
    listening = true;
    refreshShipments();
    // A new Priority1 email or a link made on the phone lands through sync.
    listen("netsync-applied", () => refreshShipments()).catch(() => {});
    // R-318: the delivery that just announced itself must be on screen behind the toast.
    listen("shipment-delivered", () => refreshShipments()).catch(() => {});
    window.setInterval(refreshShipments, 60_000);
  }
  return () => { subs.delete(f); };
}

export function useShipments(): Shipment[] {
  return useSyncExternalStore(subscribe, () => cache);
}

/**
 * R-318: the deals whose freight has landed. Deal Flow pins these at the top, green, until
 * the deal is marked complete — a delivery is a job to finish, not a message that scrolls
 * away, so the popup is only the first half of telling anyone.
 */
export function useDeliveredDeals(): Set<string> {
  const all = useShipments();
  return new Set(all.filter((s) => s.stage === "delivered" && s.deal_flow_id).map((s) => s.deal_flow_id));
}

// ── presentation ─────────────────────────────────────────────────────────────
const STAGE: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "danger" }> = {
  "": { label: "Waiting for Priority1", tone: "neutral" },
  booked: { label: "Booked", tone: "neutral" },
  picked_up: { label: "Picked up", tone: "accent" },
  in_transit: { label: "In transit", tone: "accent" },
  out_for_delivery: { label: "Out for delivery", tone: "accent" },
  delivered: { label: "Delivered", tone: "success" },
  exception: { label: "Exception", tone: "danger" },
};

function stageOf(s: Shipment) {
  const st = STAGE[s.stage] ?? STAGE.booked;
  // An exception reads better in the carrier's own words ("Delayed - weather").
  return s.stage === "exception" && s.status ? { ...st, label: s.status } : st;
}

/** Central time; a midnight stamp is a date-only update and shows as just the date. */
function fmtWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" });
  return time === "12:00 AM" ? date : `${date}, ${time}`;
}

function refsLine(s: Shipment): string {
  return [s.bol && `BOL ${s.bol}`, s.pro && `PRO ${s.pro}`, !s.bol && !s.pro && s.shipment_number && `#${s.shipment_number}`]
    .filter(Boolean).join(" · ");
}

function route(s: Shipment): string {
  return s.origin || s.destination ? `${s.origin || "?"} → ${s.destination || "?"}` : "";
}

type Event = { at: string; status: string; location: string; note: string };

// ── collapsed deal row ───────────────────────────────────────────────────────
export function FreightChip({ dealFlowId }: { dealFlowId: string }) {
  const mine = useShipments().filter((s) => s.deal_flow_id === dealFlowId);
  if (mine.length === 0) return null;
  const s = mine[0];
  const st = stageOf(s);
  return (
    <StatusPill tone={st.tone} title={[s.carrier, refsLine(s), route(s), s.last_update_at && `updated ${fmtWhen(s.last_update_at)}`].filter(Boolean).join(" · ")}>
      <Truck size={10} className="mr-1" />{" "}
      <span className={s.stage === "delivered" ? "font-semibold" : undefined}>{st.label}</span>
      {mine.length > 1 ? ` +${mine.length - 1}` : ""}
    </StatusPill>
  );
}

// ── open deal ────────────────────────────────────────────────────────────────
export function FreightPanel({ dealFlowId, locked, onReload }: { dealFlowId: string; locked: boolean; onReload: () => void }) {
  const mine = useShipments().filter((s) => s.deal_flow_id === dealFlowId);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  const attach = async () => {
    if (!ref.trim()) return;
    setBusy(true);
    try {
      const s = await api.linkShipmentRef(dealFlowId, ref.trim());
      setRef("");
      await refreshShipments();
      onReload(); // Priority1's dates may have just replaced the deal's
      toast(s.last_update_at ? "Shipment attached" : "Saved — updates for this number will land on this deal");
    } catch (e) {
      toast(String(e), "error");
    } finally { setBusy(false); }
  };

  return (
    <div className="border-t border-line px-5 py-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12.5px] font-medium text-ink-2 inline-flex items-center gap-1.5"><Truck size={13} /> Freight</span>
        {!locked && (
          <div className="flex items-center gap-1.5 ml-auto">
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") attach(); }}
              placeholder="Priority1 BOL, PRO or pickup #"
              maxLength={40}
              className="h-8 w-56 max-w-full px-2.5 border border-line rounded-lg text-[12px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
            <button onClick={attach} disabled={busy || !ref.trim()}
              className="h-8 px-3 rounded-lg text-[12px] font-medium border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-50">
              {busy ? "Saving…" : "Attach"}
            </button>
          </div>
        )}
      </div>
      {mine.length === 0 ? (
        <p className="text-[12px] text-muted">
          No shipment yet. Paste the BOL when you book with Priority1 — even after the email has come in — and this deal's pickup and delivery dates will follow Priority1. Without one, the dates you set stay.
        </p>
      ) : (
        <>
          {mine.map((s) => <ShipmentRow key={s.id} s={s} locked={locked} onReload={onReload} />)}
          <p className="text-[11.5px] text-faint">
            {mine.some((s) => s.bol)
              ? "Pickup and delivery dates on this deal follow Priority1's updates."
              : "Dates follow Priority1 once its first update with a BOL arrives."}
          </p>
        </>
      )}
    </div>
  );
}

function ShipmentRow({ s, locked, onReload }: { s: Shipment; locked: boolean; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const st = stageOf(s);
  let events: Event[] = [];
  try { events = JSON.parse(s.events_json || "[]"); } catch { events = []; }

  const detach = async () => {
    try { await api.linkShipment(s.id, ""); await refreshShipments(); onReload(); toast("Shipment detached"); }
    catch (e) { toast(String(e), "error"); }
  };

  return (
    <div className="rounded-lg border border-line bg-surface-2/50 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap text-[12px]">
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
        {s.carrier && <span className="text-ink-2 font-medium">{s.carrier}</span>}
        {refsLine(s) && <span className="text-muted tabular-nums">{refsLine(s)}</span>}
        {route(s) && <span className="text-muted min-w-0 truncate">{route(s)}</span>}
        <span className="ml-auto flex items-center gap-1 flex-shrink-0">
          {s.last_update_at && <span className="text-faint tabular-nums mr-1">Updated {fmtWhen(s.last_update_at)}</span>}
          {s.details_url && (
            <button onClick={() => api.openExternal(s.details_url).catch(() => {})} title="Open on Priority1"
              className="p-1 rounded text-muted hover:text-ink hover:bg-surface-3"><ExternalLink size={13} /></button>
          )}
          {events.length > 0 && (
            <button onClick={() => setOpen((v) => !v)} title={open ? "Hide updates" : "Show every update"}
              className="p-1 rounded text-muted hover:text-ink hover:bg-surface-3">
              <ChevronDown size={13} className={`transition-transform duration-[130ms] ${open ? "rotate-180" : ""}`} />
            </button>
          )}
          {!locked && (
            <button onClick={detach} title="Detach from this deal"
              className="p-1 rounded text-muted hover:text-danger-ink hover:bg-danger-bg"><X size={13} /></button>
          )}
        </span>
      </div>
      {(s.last_note || s.last_location) && (
        <div className="text-[12px] text-muted mt-1">{[s.last_location, s.last_note].filter(Boolean).join(" — ")}</div>
      )}
      {open && (
        <ol className="mt-2 space-y-1 border-l border-line pl-3">
          {[...events].reverse().map((e, i) => (
            <li key={i} className="text-[11.5px]">
              <span className="text-faint tabular-nums">{fmtWhen(e.at)}</span>
              <span className="text-ink-2 font-medium ml-2">{e.status || "Update"}</span>
              {(e.location || e.note) && <span className="text-muted ml-2">{[e.location, e.note].filter(Boolean).join(" — ")}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── not on a deal yet ────────────────────────────────────────────────────────
export function UnlinkedShipments({ onChange }: { onChange: () => void }) {
  const all = useShipments();
  const loose = all.filter((s) => !s.deal_flow_id && !s.dismissed && s.stage !== "");
  const [open, setOpen] = useState(true);
  const [scanning, setScanning] = useState(false);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanPriority1Mail(30);
      await refreshShipments();
      if (r.errors.length) toast(`Checked mail with ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}: ${r.errors[0]}`, "error");
      else toast(r.emails ? `Found ${r.emails} Priority1 update${r.emails === 1 ? "" : "s"} across ${r.shipments} shipment${r.shipments === 1 ? "" : "s"}` : "No Priority1 updates in the last 30 days");
    } catch (e) {
      toast(String(e), "error");
    } finally { setScanning(false); }
  };

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 px-4 h-11">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
          <Truck size={14} />
          Shipments not on a deal
          <span className="text-muted tabular-nums">{loose.length}</span>
          {loose.length > 0 && <ChevronDown size={13} className={`text-muted transition-transform duration-[130ms] ${open ? "rotate-180" : ""}`} />}
        </button>
        <button onClick={scan} disabled={scanning}
          title="Look through the connected mailboxes for Priority1 tracking emails from the last 30 days"
          className="ml-auto flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 px-2.5 h-8 rounded-lg hover:bg-surface-3 disabled:opacity-50">
          <Mail size={13} /> {scanning ? "Checking mail…" : "Check Priority1 mail"}
        </button>
      </div>
      {open && loose.length > 0 && (
        <div className="border-t border-line divide-y divide-line">
          {loose.map((s) => <LooseRow key={s.id} s={s} onChange={onChange} />)}
        </div>
      )}
    </div>
  );
}

function LooseRow({ s, onChange }: { s: Shipment; onChange: () => void }) {
  const [options, setOptions] = useState<ShipmentDealSuggestion[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const st = stageOf(s);

  useEffect(() => {
    let live = true;
    api.suggestShipmentDeals(s.id).then((list) => {
      if (!live) return;
      setOptions(list);
      if (list[0] && list[0].score >= 30) setPick(list[0].deal_flow_id);
    }).catch(() => {});
    return () => { live = false; };
  }, [s.id]);

  const chosen = options.find((o) => o.deal_flow_id === pick);
  const act = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try { await fn(); await refreshShipments(); onChange(); toast(done); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
          <span className="text-ink-2 font-medium tabular-nums">{refsLine(s)}</span>
          {s.carrier && <span className="text-muted">{s.carrier}</span>}
        </div>
        <div className="text-[11.5px] text-muted mt-0.5 truncate">
          {[route(s), s.last_update_at && `updated ${fmtWhen(s.last_update_at)}`].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <div className="flex flex-col">
          <select value={pick} onChange={(e) => setPick(e.target.value)}
            className="h-8 w-60 max-w-full px-2 border border-line rounded-lg text-[12px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40">
            <option value="">Choose a deal…</option>
            {options.map((o) => <option key={o.deal_flow_id} value={o.deal_flow_id}>{o.label || "Untitled deal"}</option>)}
          </select>
          {chosen?.reason && <span className="text-[10.5px] text-faint mt-0.5">Suggested: {chosen.reason}</span>}
        </div>
        <button disabled={busy || !pick} onClick={() => act(() => api.linkShipment(s.id, pick), "Shipment attached")}
          className="h-8 px-3 rounded-lg text-[12px] font-medium bg-accent hover:bg-accent-hover text-on-accent disabled:opacity-50">
          Attach
        </button>
        <button disabled={busy} onClick={() => act(() => api.dismissShipment(s.id), "Hidden — it is not a deal")}
          title="Not a deal (a transfer between your own buildings, for example)"
          className="h-8 px-2.5 rounded-lg text-[12px] text-muted hover:text-ink-2 hover:bg-surface-3">
          Not a deal
        </button>
      </div>
    </div>
  );
}
