import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Paperclip, Search, Truck } from "lucide-react";
import { api, type FreightBooking, type Me } from "../lib/api";
import { can, isAdmin, isLogisticsOnly } from "../lib/permissions";
import StatusPill from "./StatusPill";
import LogisticsShipments from "./LogisticsShipments";
import { YourPayCard } from "./LogisticsPay";
import LogisticsBookingForm, {
  AmountNeededPill, FreightStatusPill, UrgentPill, extraStops, isHot, needsAmount, routeLabel, timingLine, useNetsyncApplied,
} from "./LogisticsBookingForm";

// R-400: the Logistics screen. Two people use it. The Logistics account (a person Jack has
// set up to book the freight) sees only this screen, and only what his role allows: names and
// addresses each sit behind a switch, and there is never a deal, an invoice or a figure other
// than the shipping amounts he types. Jack sees the same list with the deal each truck belongs
// to. Every read and write goes through the server's Logistics routes (`logistics_request`), so
// what a person may see is decided in one place and this screen never has to guess.

const REFRESH_MS = 30_000;

type GroupKey = "urgent" | "requested" | "needs" | "booked" | "way" | "delivered";
const GROUPS: { key: GroupKey; title: string }[] = [
  // R-458: urgent trucks that are not picked up yet sit above everything else.
  { key: "urgent", title: "Urgent" },
  { key: "requested", title: "To book" },
  { key: "needs", title: "Needs the amount paid" },
  { key: "booked", title: "Booked" },
  { key: "way", title: "On the way" },
  { key: "delivered", title: "Delivered" },
];

function groupOf(b: FreightBooking): GroupKey | null {
  if (b.status === "cancelled") return null;
  if (isHot(b)) return "urgent";
  if (b.status === "requested") return "requested";
  if (needsAmount(b)) return "needs";
  if (b.status === "booked") return "booked";
  if (b.status === "picked_up") return "way";
  return "delivered";
}

/** Everything a person could type in the search box, of what this viewer can see. */
function haystack(b: FreightBooking): string {
  return [
    b.code, b.pickup_name, b.delivery_name, b.pickup_address, b.delivery_address,
    b.carrier, b.broker, b.bol, b.pro, b.reference, b.request_note,
    b.deal?.invoice_number, b.deal?.client_name,
    ...extraStops(b).flatMap((x) => [x.name, x.address]),
  ].join(" ").toLowerCase();
}

/** Earliest pickup first, an empty pickup last, then the order they were sent. */
const byPickup = (a: FreightBooking, b: FreightBooking) => {
  if (!!a.pickup_date !== !!b.pickup_date) return a.pickup_date ? -1 : 1;
  return a.pickup_date.localeCompare(b.pickup_date) || a.created_at.localeCompare(b.created_at);
};

function BookingRow({ b, onOpen }: { b: FreightBooking; onOpen: () => void }) {
  const route = routeLabel(b);
  // R-458: when it has to happen, the team's note and the files, readable without opening it.
  const dates = timingLine(b);
  const who = b.deal ? [b.deal.invoice_number, b.deal.client_name].filter(Boolean).join(" for ") : "";
  const note = b.request_note.trim().split("\n")[0];
  const files = b.files?.length ?? 0;
  return (
    <button
      type="button" onClick={onOpen}
      className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60 transition-colors min-w-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-[12px] text-muted flex-shrink-0">{b.code}</span>
          {route && <span className="text-[13.5px] font-medium text-ink truncate min-w-0">{route}</span>}
        </div>
        {(dates || who) && (
          <div className="text-[12px] text-muted mt-0.5 truncate">
            {dates}{dates && who ? " · " : ""}{who && <span className="text-ink-2">{who}</span>}
          </div>
        )}
        {(note || files > 0) && (
          <div className="text-[12px] mt-0.5 flex items-center gap-2 min-w-0">
            {note && <span className="text-ink-2 truncate min-w-0">{note}</span>}
            {files > 0 && <span className="inline-flex items-center gap-0.5 text-muted flex-shrink-0"><Paperclip size={11} />{files}</span>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {isHot(b) && <UrgentPill />}
        {needsAmount(b) && <AmountNeededPill />}
        <FreightStatusPill status={b.status} />
      </div>
      <ChevronRight size={14} className="text-faint flex-shrink-0" />
    </button>
  );
}

function GroupCard({ title, count, children, hot }: { title: string; count: number; children: ReactNode; hot?: boolean }) {
  return (
    <section className={`bg-surface border rounded-xl overflow-hidden ${hot ? "border-danger-ink/30" : "border-line"}`}>
      <div className={`px-4 py-2.5 border-b flex items-center gap-2 ${hot ? "border-danger-ink/20 bg-danger-bg" : "border-line"}`}>
        <h3 className={`text-[13px] font-semibold ${hot ? "text-danger-ink" : "text-ink"}`}>{title}</h3>
        <StatusPill tone={hot ? "danger" : "neutral"}>{count}</StatusPill>
      </div>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

export default function LogisticsView({ me }: { me: Me | null | undefined }) {
  const logisticsOnly = isLogisticsOnly(me);
  // R-415: every shipment, for the business. The server reads it for an admin, or for someone who
  // sees deals and their dollar figures; a Logistics-only account never does.
  const canShipments = !logisticsOnly && (isAdmin(me) || (can(me, "deal_flow:view") && can(me, "deal_flow:view_numbers")));
  const [view, setView] = useState<"bookings" | "shipments">("bookings");
  const [rows, setRows] = useState<FreightBooking[] | null>(null);
  const [doneRows, setDoneRows] = useState<FreightBooking[] | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  // A snapshot, not a pointer into `rows`: a background refresh must never replace what the
  // open form is holding while someone is typing into it.
  const [open, setOpen] = useState<FreightBooking | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.logistics.list();
      setRows(r.bookings);
      setError("");
    } catch (e) {
      setError(String(e));
      setRows((prev) => prev ?? []);
    }
  }, []);
  const loadDone = useCallback(async () => {
    try { setDoneRows((await api.logistics.list({ includeDone: true })).bookings); } catch { /* the main list already says if the server is unreachable */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Another person changes these rows from another device. A Logistics-only desktop never
    // syncs the workspace, so it asks; Jack's desktop also hears about it through sync.
    const id = window.setInterval(() => { load(); if (doneOpen) loadDone(); }, REFRESH_MS);
    const onFocus = () => { load(); if (doneOpen) loadDone(); };
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [load, loadDone, doneOpen]);
  useNetsyncApplied(() => { load(); if (doneOpen) loadDone(); });
  useEffect(() => { if (doneOpen) loadDone(); }, [doneOpen, loadDone]);

  const needle = q.trim().toLowerCase();
  const match = (b: FreightBooking) => !needle || haystack(b).includes(needle);

  const grouped = useMemo(() => {
    const g: Record<GroupKey, FreightBooking[]> = { urgent: [], requested: [], needs: [], booked: [], way: [], delivered: [] };
    for (const b of (rows ?? []).filter(match)) {
      const k = groupOf(b);
      if (k) g[k].push(b);
    }
    for (const k of ["urgent", "needs", "booked", "way"] as GroupKey[]) g[k].sort(byPickup);
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, needle]);

  // Whatever the include_done list has that the main one does not: cancelled bookings and
  // delivered-and-paid ones that have aged out.
  const done = useMemo(() => {
    const mine = new Set((rows ?? []).map((b) => b.id));
    return (doneRows ?? []).filter((b) => !mine.has(b.id)).filter(match).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, doneRows, needle]);

  const shown = GROUPS.reduce((n, g) => n + grouped[g.key].length, 0);
  const row = (b: FreightBooking) => <BookingRow key={b.id} b={b} onOpen={() => setOpen(b)} />;

  if (rows === null) {
    return (
      <div className="space-y-5" aria-busy="true">
        <div className="h-6 w-28 bg-surface-2 rounded-md animate-pulse" />
        <div className="h-9 w-full max-w-sm bg-surface-2 rounded-lg animate-pulse" />
        <div className="h-[180px] bg-surface-2 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5 min-w-0">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold text-ink tracking-tight">Logistics</h2>
          <p className="text-[13px] text-muted mt-0.5">
            {logisticsOnly
              ? "Each truck to book, and the amount paid once the carrier is paid."
              : view === "shipments" ? "Every deal with a truck sent to logistics: what was charged, what the carrier was paid, what is left."
              : "Every truck sent to logistics, and where each one stands."}
          </p>
        </div>
        {view === "bookings" && <div className="relative w-full max-w-[280px] min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, place, carrier, BOL or PRO"
            aria-label="Search bookings"
            className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] bg-surface text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>}
      </div>

      {canShipments && (
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line" role="group" aria-label="Logistics view">
          {([["bookings", "Bookings"], ["shipments", "All shipments"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}
              className={`h-8 px-3.5 rounded-md text-[12.5px] whitespace-nowrap transition-colors ${view === k ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {view === "shipments" && canShipments ? <LogisticsShipments /> : (<>

      {/* R-401: his own pay, only when he is the one being paid. Nothing about what a customer was charged. */}
      <YourPayCard />

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={load} className="font-medium underline flex-shrink-0">Try again</button>
        </div>
      )}

      {shown === 0 && !error && (
        <div className="bg-surface border border-line rounded-xl px-6 py-12 text-center">
          <Truck size={22} className="mx-auto text-faint mb-2" />
          <div className="text-[14px] font-medium text-ink">{needle ? "Nothing matches that search" : "No trucks to book"}</div>
          <div className="text-[12.5px] text-muted mt-1">
            {needle ? "Try a code, a place, a carrier or a BOL number." : logisticsOnly ? "New requests show up here as they are sent." : "Send a deal to logistics from its Shipping step."}
          </div>
        </div>
      )}

      {GROUPS.map((g) => grouped[g.key].length > 0 && (
        <GroupCard key={g.key} title={g.title} count={grouped[g.key].length} hot={g.key === "urgent"}>{grouped[g.key].map(row)}</GroupCard>
      ))}

      <section className="bg-surface border border-line rounded-xl overflow-hidden">
        <button
          type="button" onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2/60 transition-colors"
        >
          <ChevronRight size={13} className={`text-muted transition-transform ${doneOpen ? "rotate-90" : ""}`} />
          <span className="text-[13px] font-semibold text-ink">Done and cancelled</span>
          {doneOpen && doneRows && <StatusPill tone="neutral">{done.length}</StatusPill>}
        </button>
        {doneOpen && (
          <div className="border-t border-line divide-y divide-line">
            {doneRows === null
              ? <div className="px-4 py-4 text-[12.5px] text-muted">Loading...</div>
              : done.length === 0
                ? <div className="px-4 py-4 text-[12.5px] text-muted">Nothing here yet.</div>
                : done.map(row)}
          </div>
        )}
      </section>

      {open && (
        <LogisticsBookingForm
          booking={open}
          onClose={() => setOpen(null)}
          onSaved={(b) => {
            setOpen(b);
            setRows((prev) => (prev ?? []).map((x) => (x.id === b.id ? b : x)));
            load(); if (doneOpen) loadDone();
          }}
          onChanged={() => { load(); if (doneOpen) loadDone(); }}
        />
      )}
      </>)}
    </div>
  );
}
