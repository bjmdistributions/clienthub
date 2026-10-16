import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Paperclip, Search, Truck } from "lucide-react";
import { api, type FreightBooking, type LogisticsCompletion, type Me } from "../lib/api";
import { loadTime24 } from "../lib/time24";
import { localDay } from "../lib/format";
import { can, isAdmin, isLogisticsOnly } from "../lib/permissions";
import { canViewFreightMap } from "../lib/freightMap";
import { OPEN_CARRIER_KEY, OPEN_LOAD_KEY, canPayCarriers, canSeePayCarriers, parseOpenLoad } from "../lib/logisticsCarriers";
import {
  BOARD, BOARD_WORD, arrivesToday, boardKey, boardNeeds, boardSort, dueLabel, dueTone, firstName, groupOf, isHot, isLogisticsSide, isNewToday, loadHaystack,
  loadNumber, missingPaperwork, pickupNumberUnconfirmed, rowLane, type BoardKey, type GroupKey, type LoadStep,
} from "../lib/logisticsLoad";
import StatusPill from "./StatusPill";
import LogisticsShipments from "./LogisticsShipments";
import LogisticsDeliveryChart from "./LogisticsDeliveryChart";
import LogisticsMap from "./LogisticsMap";
import { Seg } from "./bills/ui";
import { YourPayCard } from "./LogisticsPay";
import { LogisticsWeekView } from "./LogisticsWeek";
import { CarriersView } from "./LogisticsCarriers";
import { PayCarriersView } from "./LogisticsPayCarriers";
import { toast } from "./Toast";
import LogisticsBookingForm, {
  FreightStatusPill, PickupNumberPill, UrgentPill, routeLabel, timingLine, useNetsyncApplied,
} from "./LogisticsBookingForm";

// R-400: the Logistics screen. Two people use it. The Logistics account (a person Jack has
// set up to book the freight) sees only this screen, and only what his role allows: names and
// addresses each sit behind a switch, and there is never a deal, an invoice or a figure other
// than the shipping amounts he types. Jack sees the same list with the deal each truck belongs
// to. Every read and write goes through the server's Logistics routes (`logistics_request`), so
// what a person may see is decided in one place and this screen never has to guess.

const REFRESH_MS = 30_000;
/** R-538: the "Deal 100% complete" notes dismissed on this device. */
const DONE_SEEN_KEY = "ec_lg_done_seen";

export function BookingRow({ b, group, onOpen }: { b: FreightBooking; group: GroupKey; onOpen: () => void }) {
  const route = routeLabel(b);
  const today = localDay();
  // R-459: a load that waits on paperwork says which; the team sees when the carrier is due.
  const missing = group === "paperwork" ? missingPaperwork(b) : [];
  const due = group === "topay" && b.can_see_deal ? b.pay_due_date || "" : null;
  // R-458: when it has to happen, the team's note and the files, readable without opening it.
  const dates = timingLine(b);
  // R-478: where it goes, city and state, so the lane reads at a glance.
  const lane = rowLane(b);
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
          <span className="font-mono text-[12px] text-muted flex-shrink-0">{loadNumber(b)}</span>
          {route && <span className="text-[13.5px] font-medium text-ink truncate min-w-0">{route}</span>}
        </div>
        {lane && <div className="text-[12px] text-muted mt-0.5 truncate">{lane}</div>}
        {(dates || who) && (
          <div className="text-[12px] text-muted mt-0.5 truncate">
            {dates}{dates && who ? " · " : ""}{who && <span className="text-ink-2">{who}</span>}
          </div>
        )}
        {missing.length > 0 && <div className="text-[12px] text-muted mt-0.5 truncate">Needs {missing.join(", ").toLowerCase()}</div>}
        {(note || files > 0) && (
          <div className="text-[12px] mt-0.5 flex items-center gap-2 min-w-0">
            {note && <span className="text-ink-2 truncate min-w-0">{note}</span>}
            {files > 0 && <span className="inline-flex items-center gap-0.5 text-muted flex-shrink-0"><Paperclip size={11} />{files}</span>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {isHot(b) && <UrgentPill />}
        {pickupNumberUnconfirmed(b, today) && <PickupNumberPill />}
        {due !== null && <StatusPill tone={dueTone(due, today)}>{dueLabel(due, today)}</StatusPill>}
        <FreightStatusPill status={b.status} logistics={isLogisticsSide(b)} />
      </div>
      <ChevronRight size={14} className="text-faint flex-shrink-0" />
    </button>
  );
}

// R-525: the board's colours, one per place a load can be, the website's twins (style.css --lgs-*): Apple system hues
// already in the chart tokens. Purple a quote, indigo with the team, orange ready to book, blue waiting on pickup, teal
// on the way, pink waiting on paperwork, green waiting for payment (R-507: teal ships, green is the carrier owed).
const BOARD_TONE: Record<BoardKey, string> = {
  quote: "--c-chart-5", team: "--c-chart-3", book: "--c-chart-6", pickup: "--c-chart-1", moving: "--c-chart-2", paper: "--c-chart-4", pay: "--c-chart-profit",
};
const toneOf = (k: BoardKey | null) => `rgb(var(${k ? BOARD_TONE[k] : "--c-line-3"}))`;

/** R-525: one load on the board, in the colour of where it is. Large type, three lines, nothing it does not need. */
/** `done`: a card in Completed and cancelled reads by its status, grey (R-538), whatever its paperwork. */
function BoardCard({ b, onOpen, done, canPay }: { b: FreightBooking; onOpen: () => void; done?: boolean; canPay?: boolean }) {
  const k = done ? null : boardKey(b);
  const tone = toneOf(k);
  const route = routeLabel(b);
  const lane = rowLane(b);
  const when = [timingLine(b) || "No dates yet", b.deal?.client_name].filter(Boolean).join(" · ");
  const today = localDay();
  const arriving = !done && b.status !== "delivered" && arrivesToday(b, today);
  const fresh = !done && isNewToday(b);
  // R-538: the warnings the old rows carried (R-459): the pickup number not confirmed, and for whoever pays carriers when
  // the payment is due; and what a waiting-for-payment load still lacks.
  const unconfirmed = !done && pickupNumberUnconfirmed(b, today);
  // The website's rule (lgDuePill): only for a load still owed with its paperwork in, and only for whoever pays carriers.
  const due = !done && canPay && groupOf(b) === "topay" ? b.pay_due_date || "" : null;
  const needs = done ? [] : boardNeeds(b);
  return (
    <button type="button" onClick={onOpen} style={{ boxShadow: `inset 5px 0 0 ${tone}` }}
      className={`w-full text-left flex flex-col gap-0.5 min-w-0 bg-surface border rounded-xl pl-4 pr-3.5 py-3 hover:bg-surface-2/60 transition-colors ${isHot(b) ? "border-danger-ink/40" : "border-line"}`}>
      <span className="flex items-center justify-between gap-2 min-w-0">
        <span className="font-mono text-[13px] text-muted">{loadNumber(b)}</span>
        {k ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink whitespace-nowrap">
            <span aria-hidden className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: tone }} />{BOARD_WORD[k]}
          </span>
        ) : <FreightStatusPill status={b.status} logistics={isLogisticsSide(b)} />}
      </span>
      {route && <span className="text-[15px] font-semibold text-ink leading-snug break-words">{route}</span>}
      {lane && <span className="text-[13.5px] text-ink-2 break-words">{lane}</span>}
      <span className="text-[13.5px] text-ink-2 break-words">{when}</span>
      {(isHot(b) || unconfirmed || due !== null || needs.length > 0 || arriving || fresh) && (
        <span className="flex flex-wrap gap-1.5 mt-1">
          {isHot(b) && <UrgentPill />}
          {unconfirmed && <PickupNumberPill />}
          {due !== null && <StatusPill tone={dueTone(due, today)}>{dueLabel(due, today)}</StatusPill>}
          {needs.length > 0 && <StatusPill tone="neutral">Needs {needs.join(" and ")}</StatusPill>}
          {arriving && <StatusPill tone="neutral">Arriving today</StatusPill>}
          {fresh && <StatusPill tone="neutral">New</StatusPill>}
        </span>
      )}
    </button>
  );
}

/** R-525: one box of the board: its number, its title, the key to its colours with a count each, and its cards. */
function BoardColumn({ col, loads, searching, onOpen, canPay }: { col: (typeof BOARD)[number]; loads: FreightBooking[]; searching: boolean; onOpen: (b: FreightBooking) => void; canPay: boolean }) {
  return (
    <section className="min-w-0 rounded-2xl bg-surface-2 p-3" aria-label={col.title}>
      <h3 className="flex items-center gap-2.5 px-0.5 text-[18px] font-semibold text-ink">
        <span aria-hidden className="flex-shrink-0 w-[26px] h-[26px] rounded-full bg-ink text-surface grid place-items-center text-[14px] font-bold">{col.n}</span>
        <span className="min-w-0">{col.title}</span>
        <span className="ml-auto text-[15px] text-ink-2 tabular-nums">{loads.length}</span>
      </h3>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 px-0.5 mt-1.5 mb-2.5">
        {col.keys.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 whitespace-nowrap">
            <span aria-hidden className="w-2.5 h-2.5 rounded-full" style={{ background: toneOf(k) }} />
            {BOARD_WORD[k]} <b className="text-ink font-semibold tabular-nums">{loads.filter((b) => boardKey(b) === k).length}</b>
          </span>
        ))}
      </div>
      <div className="grid gap-2.5">
        {loads.length === 0
          ? <div className="px-1 py-3 text-[13.5px] text-muted">{searching ? "Nothing here matches that." : "Nothing here right now."}</div>
          : loads.map((b) => <BoardCard key={b.id} b={b} canPay={canPay} onOpen={() => onOpen(b)} />)}
      </div>
    </section>
  );
}

export default function LogisticsView({ me }: { me: Me | null | undefined }) {
  const logisticsOnly = isLogisticsOnly(me);
  // R-415: every shipment, for the business. The server reads it for an admin, or for someone who
  // sees deals and their dollar figures; a Logistics-only account never does.
  const canShipments = !logisticsOnly && (isAdmin(me) || (can(me, "deal_flow:view") && can(me, "deal_flow:view_numbers")));
  // R-459: Carriers for everyone on this screen, Pay carriers for whoever may pay them.
  // R-527: the payer, whoever attaches, and the Logistics person (who never attaches) see Pay carriers.
  const seePay = canSeePayCarriers(me);
  // R-538: the due pill on the board, for whoever pays carriers (the website's lgDuePill).
  const canPay = canPayCarriers(me);
  const [view, setView] = useState<"bookings" | "carriers" | "pay" | "shipments">("bookings");
  // R-485: Loads (the list below) or Map (the delivered freight on the road), for whoever may see load addresses.
  const canMap = canViewFreightMap(me);
  const [mode, setMode] = useState<"loads" | "map">("loads");
  const [carrierId, setCarrierId] = useState<string | undefined>(undefined);
  const [payRev, setPayRev] = useState(0);
  const [rows, setRows] = useState<FreightBooking[] | null>(null);
  // R-538: deals just completed with every truck paid, for the "Deal 100% complete" note, and the ones dismissed here.
  const [completed, setCompleted] = useState<LogisticsCompletion[]>([]);
  const [doneSeen, setDoneSeen] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(DONE_SEEN_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const dismissDone = (key: string) => {
    const next = [...doneSeen.filter((k) => k !== key), key].slice(-50);
    setDoneSeen(next);
    try { localStorage.setItem(DONE_SEEN_KEY, JSON.stringify(next)); } catch { /* the note comes back next time */ }
  };
  const [doneRows, setDoneRows] = useState<FreightBooking[] | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  // A snapshot, not a pointer into `rows`: a background refresh must never replace what the
  // open form is holding while someone is typing into it.
  const [open, setOpen] = useState<FreightBooking | null>(null);
  const [openStep, setOpenStep] = useState<LoadStep | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await api.logistics.list();
      setRows(r.bookings);
      setCompleted(r.completed ?? []);
      setError("");
    } catch (e) {
      setError(String(e));
      setRows((prev) => prev ?? []);
    }
  }, []);
  const loadDone = useCallback(async () => {
    try { setDoneRows((await api.logistics.list({ includeDone: true })).bookings); } catch { /* the main list already says if the server is unreachable */ }
  }, []);

  /** Open a load, on a step when another screen names one (Bills opens it on Pay). Reads the server's copy: it has the paperwork. */
  const openLoad = useCallback(async (id: string, step?: LoadStep) => {
    try { const b = await api.logistics.get(id); setOpenStep(step); setOpen(b); }
    catch (e) { toast(String(e), "error"); }
  }, []);
  // Another screen stashed a load (or a carrier) to open, then switched here. Read on arrival and when this
  // screen is already open.
  const takeHandoff = useCallback(() => {
    try {
      const raw = localStorage.getItem(OPEN_LOAD_KEY);
      if (raw) { localStorage.removeItem(OPEN_LOAD_KEY); const t = parseOpenLoad(raw); if (t) { setView("bookings"); openLoad(t.id, t.step); } }
      const c = localStorage.getItem(OPEN_CARRIER_KEY);
      if (c) { localStorage.removeItem(OPEN_CARRIER_KEY); setView("carriers"); setCarrierId(c.trim() || undefined); }
    } catch { /* storage can be blocked: nothing to open */ }
  }, [openLoad]);
  useEffect(() => {
    takeHandoff();
    window.addEventListener("logistics-open-load", takeHandoff);
    return () => window.removeEventListener("logistics-open-load", takeHandoff);
  }, [takeHandoff]);

  useEffect(() => { load(); loadTime24(); }, [load]);
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

  const views: (readonly ["bookings" | "carriers" | "pay" | "shipments", string])[] = [
    ["bookings", "Bookings"], ["carriers", "Carriers"],
    ...(seePay ? [["pay", "Pay carriers"] as const] : []),
    ...(canShipments ? [["shipments", "All shipments"] as const] : []),
  ];
  const needle = q.trim().toLowerCase();
  const match = (b: FreightBooking) => !needle || loadHaystack(b).includes(needle);

  // R-525 (2026-10-14): Jack: "i dont want list anymore ... everything moves on a left to right basis". The board: box 1
  // holds the quote, the team's part and booking; box 2 booked and waiting on pickup, then on the way with its ETA; box 3
  // delivered and waiting on the paperwork, then waiting for payment once the carrier invoice is in. Urgent, Arriving
  // today and New are tags on the cards now (R-458, R-487, R-476), so a load shows once, in its box.
  const board = useMemo(() => {
    const all = (rows ?? []).filter(match);
    return BOARD.map((col) => ({ col, loads: all.filter((b) => { const k = boardKey(b); return !!k && col.keys.includes(k); }).sort(boardSort) }));
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, needle]);

  // Completed: a finished load still on the main list, then what the include_done list has that the main one does not
  // (cancelled bookings and finished ones the server already counts as done).
  const done = useMemo(() => {
    const mine = new Set((rows ?? []).map((b) => b.id));
    const finished = (rows ?? []).filter(match).filter((b) => !boardKey(b));
    return [...finished, ...(doneRows ?? []).filter((b) => !mine.has(b.id)).filter(match)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, doneRows, needle]);

  const shown = board.reduce((n, c) => n + c.loads.length, 0);
  const hello = firstName(me?.display_name);
  const row = (b: FreightBooking) => <BookingRow key={b.id} b={b} group={groupOf(b) ?? "delivered"} onOpen={() => { setOpenStep(undefined); setOpen(b); }} />;

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
          {/* R-476: the Bookings view opens on a large hello and the date, easy to read at a glance. */}
          {view === "bookings" ? (<>
            <h2 className="text-[26px] font-semibold text-ink tracking-tight">{hello ? `Hello, ${hello}` : "Hello"}</h2>
            <p className="text-[15px] text-ink-2 mt-1">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
          </>) : (<>
          <h2 className="text-[20px] font-semibold text-ink tracking-tight">Logistics</h2>
          <p className="text-[13px] text-muted mt-0.5">
            {logisticsOnly
              ? "Quotes to give, trucks to book, and the paperwork for each load."
              : view === "shipments" ? "Every deal with a truck sent to logistics: what was charged, what the carrier was paid, what is left."
              : view === "carriers" ? "The carriers you book, how to reach them and how each one gets paid."
              : view === "pay" ? "What each carrier is owed, what has been paid, and the bank payment behind it."
              : "Every load, from the quote to the carrier being paid."}
          </p>
          </>)}
        </div>
        {view === "bookings" && !(canMap && mode === "map") && <div className="relative w-full max-w-[280px] min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search load number, place, carrier, BOL or PRO"
            aria-label="Search bookings"
            className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] bg-surface text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>}
      </div>

      {(views.length > 1 || (view === "bookings" && canMap)) && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {views.length > 1 && (
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line max-w-full overflow-x-auto" role="group" aria-label="Logistics view">
              {views.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={view === k} onClick={() => { setView(k); if (k !== "carriers") setCarrierId(undefined); }}
                  className={`h-8 px-3.5 rounded-md text-[12.5px] whitespace-nowrap transition-colors ${view === k ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {view === "bookings" && canMap && (
            <Seg value={mode} onChange={setMode} options={[{ value: "loads", label: "Loads" }, { value: "map", label: "Map" }]} />
          )}
        </div>
      )}

      {view === "shipments" && canShipments ? <LogisticsShipments />
        : view === "carriers" ? <CarriersView openId={carrierId} onHostClose={() => setCarrierId(undefined)} onOpenLoad={(id) => { setView("bookings"); openLoad(id); }} />
        : view === "pay" && seePay ? <PayCarriersView rev={payRev} onOpenLoad={(id, step) => openLoad(id, step)} />
        : canMap && mode === "map" ? <LogisticsMap me={me} /> : (<>

      {/* When the loads are expected, then the board. */}
      {!needle && <LogisticsDeliveryChart rows={rows} today={localDay()} renderRow={row} />}

      {/* R-542: the trucks booked each day of the week, and his commission for it. Always shown, to him and to the owner. */}
      {!needle && <LogisticsWeekView onOpenLoad={(id) => openLoad(id)} />}

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
          <div className="text-[14px] font-medium text-ink">{needle ? "Nothing matches that search" : "No loads yet"}</div>
          <div className="text-[12.5px] text-muted mt-1">
            {needle ? "Try a load number, a place, a carrier or a BOL number." : logisticsOnly ? "New requests show up here as they are sent." : "Ask logistics for a quote from a deal's Shipping step."}
          </div>
        </div>
      )}

      {/* R-538: "Deal 100% complete", so the Logistics person hears of it here and not only on an iPhone. */}
      {completed.filter((c) => !doneSeen.includes(c.key)).slice(0, 3).map((c) => (
        <div key={c.key} role="status" style={{ boxShadow: "inset 5px 0 0 rgb(var(--c-chart-profit))" }}
          className="flex items-center justify-between gap-3 bg-surface border border-line rounded-xl pl-4 pr-3.5 py-3 text-[14px] text-ink">
          <span className="min-w-0 break-words">
            <span className="font-semibold">Deal 100% complete.</span>{" "}
            {c.loads.map((l) => (l.lane ? `${l.code}, ${l.lane}` : l.code)).join("; ")}: the carrier is paid and the deal is done.
          </span>
          <button type="button" onClick={() => dismissDone(c.key)} className="text-[12.5px] text-muted hover:text-ink underline flex-shrink-0">Dismiss</button>
        </div>
      ))}
      {shown > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3.5 items-start">
          {board.map(({ col, loads }) => (
            <BoardColumn key={col.n} col={col} loads={loads} searching={!!needle} canPay={canPay} onOpen={(b) => { setOpenStep(undefined); setOpen(b); }} />
          ))}
        </div>
      )}

      <section className="bg-surface border border-line rounded-xl overflow-hidden">
        <button
          type="button" onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2/60 transition-colors"
        >
          <ChevronRight size={13} className={`text-muted transition-transform ${doneOpen ? "rotate-90" : ""}`} />
          <span className="text-[13px] font-semibold text-ink">Completed and cancelled</span>
          {doneOpen && doneRows && <StatusPill tone="neutral">{done.length}</StatusPill>}
        </button>
        {doneOpen && (
          <div className="border-t border-line p-3">
            {doneRows === null && done.length === 0
              ? <div className="px-1 py-1 text-[12.5px] text-muted">Loading...</div>
              : done.length === 0
                ? <div className="px-1 py-1 text-[12.5px] text-muted">Nothing here yet.</div>
                : <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{done.map((b) => <BoardCard key={b.id} b={b} done onOpen={() => { setOpenStep(undefined); setOpen(b); }} />)}</div>}
          </div>
        )}
      </section>

      </>)}

      {open && (
        <LogisticsBookingForm
          booking={open}
          initialStep={openStep}
          onClose={() => { setOpen(null); setPayRev((n) => n + 1); }}
          onSaved={(b) => {
            setOpen(b);
            setPayRev((n) => n + 1);
            setRows((prev) => (prev ?? []).map((x) => (x.id === b.id ? b : x)));
            load(); if (doneOpen) loadDone();
          }}
          onChanged={() => { load(); if (doneOpen) loadDone(); }}
        />
      )}
    </div>
  );
}
