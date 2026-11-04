import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Paperclip, Search, Truck } from "lucide-react";
import { api, type FreightBooking, type LogisticsCompletion, type Me } from "../lib/api";
import { loadTime24 } from "../lib/time24";
import { localDay } from "../lib/format";
import { can, isAdmin, isLogisticsOnly } from "../lib/permissions";
import { canViewFreightMap } from "../lib/freightMap";
import { buyLabelOf } from "../lib/buyLoads";
import { OPEN_CARRIER_KEY, OPEN_LOAD_KEY, canPayCarriers, canSeePayCarriers, parseOpenLoad } from "../lib/logisticsCarriers";
import {
  BOARD, BOARD_WORD, arrivesToday, boardKey, boardNeeds, boardSort, dueLabel, dueTone, firstName, groupOf, isHot, isLogisticsSide, isNewToday, loadHaystack,
  loadNumber, missingPaperwork, pickupNumberUnconfirmed, rowLane, type BoardKey, type GroupKey, type LoadStep,
} from "../lib/logisticsLoad";
import StatusPill from "./StatusPill";
import LogisticsShipments from "./LogisticsShipments";
import LogisticsDeliveryChart from "./LogisticsDeliveryChart";
import LogisticsMap from "./LogisticsMap";
import { Button, PageHeader, Tabs } from "./ui";
import { YourPayCard } from "./LogisticsPay";
import { LogisticsWeekView } from "./LogisticsWeek";
import { CarriersView } from "./LogisticsCarriers";
import { PayCarriersView } from "./LogisticsPayCarriers";
import { toast } from "./Toast";
import BuySendSheet from "./BuySendSheet";
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
  const who = b.deal ? [b.deal.invoice_number, b.deal.client_name].filter(Boolean).join(" for ") : buyLabelOf(b);
  const note = b.request_note.trim().split("\n")[0];
  const files = b.files?.length ?? 0;
  return (
    <button
      type="button" onClick={onOpen}
      className="w-full text-left flex items-center gap-3 px-2 py-3 rounded-lg transition-colors duration-[130ms] hover:bg-surface-2 min-w-0"
      style={{ boxShadow: "inset 0 1px 0 rgb(var(--c-line))" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="text-[14px] text-muted tabular-nums flex-shrink-0">{loadNumber(b)}</span>
          {route && <span className="text-[15px] font-medium text-ink truncate min-w-0">{route}</span>}
        </div>
        {lane && <div className="text-[14px] text-muted mt-0.5 truncate">{lane}</div>}
        {(dates || who) && (
          <div className="text-[14px] text-muted mt-0.5 truncate">
            {dates}{dates && who ? " · " : ""}{who && <span className="text-ink-2">{who}</span>}
          </div>
        )}
        {missing.length > 0 && <div className="text-[13px] text-muted mt-0.5 truncate">Needs {missing.join(", ").toLowerCase()}</div>}
        {(note || files > 0) && (
          <div className="text-[13px] mt-0.5 flex items-center gap-2 min-w-0">
            {note && <span className="text-ink-2 truncate min-w-0">{note}</span>}
            {files > 0 && <span className="inline-flex items-center gap-0.5 text-muted flex-shrink-0"><Paperclip size={13} />{files}</span>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {isHot(b) && <UrgentPill />}
        {pickupNumberUnconfirmed(b, today) && <PickupNumberPill />}
        {due !== null && <StatusPill tone={dueTone(due, today)}>{dueLabel(due, today)}</StatusPill>}
        <FreightStatusPill status={b.status} logistics={isLogisticsSide(b)} />
      </div>
      <ChevronRight size={16} className="text-faint flex-shrink-0" />
    </button>
  );
}

// R-525: the board. R-583: a load shows where it is by the edge of its card and the word at the top: teal once it is
// booked (soft while it waits on pickup, solid on the way), green when the carrier is owed, red when it is late, grey
// for everything else. No dots, no colour legend: the box's key is the words with a count each.
const BOARD_EDGE: Record<BoardKey, string> = {
  quote: "rgb(var(--c-faint))", team: "rgb(var(--c-faint))", book: "rgb(var(--c-faint))",
  pickup: "rgb(var(--c-chart-2) / 0.5)", moving: "rgb(var(--c-chart-2))", paper: "rgb(var(--c-faint))", pay: "rgb(var(--c-chart-profit))",
};
const BOARD_INK: Record<BoardKey, string> = {
  quote: "text-ink", team: "text-ink", book: "text-ink", pickup: "text-ship-ink", moving: "text-ship-ink", paper: "text-ink", pay: "text-success-ink",
};
const LATE_EDGE = "rgb(var(--c-chart-loss))";
/** A booked or moving load whose delivery day has passed (the delivery chart's Late column). */
const isLate = (b: FreightBooking, today: string): boolean =>
  (b.status === "booked" || b.status === "picked_up") && !!b.delivery_date && b.delivery_date.slice(0, 10) < today;

/** R-525: one load on the board. Large type, three lines, nothing it does not need. */
/** `done`: a card in Completed and cancelled reads by its status, grey (R-538), whatever its paperwork. */
function BoardCard({ b, onOpen, done, canPay }: { b: FreightBooking; onOpen: () => void; done?: boolean; canPay?: boolean }) {
  const k = done ? null : boardKey(b);
  const today = localDay();
  const late = !done && isLate(b, today);
  const edge = late ? LATE_EDGE : k ? BOARD_EDGE[k] : "rgb(var(--c-line-3))";
  const route = routeLabel(b);
  const lane = rowLane(b);
  const when = [timingLine(b) || "No dates yet", b.deal?.client_name || buyLabelOf(b)].filter(Boolean).join(" · ");
  const arriving = !done && b.status !== "delivered" && arrivesToday(b, today);
  const fresh = !done && isNewToday(b);
  // R-538: the warnings the old rows carried (R-459): the pickup number not confirmed, and for whoever pays carriers when
  // the payment is due; and what a waiting-for-payment load still lacks.
  const unconfirmed = !done && pickupNumberUnconfirmed(b, today);
  // The website's rule (lgDuePill): only for a load still owed with its paperwork in, and only for whoever pays carriers.
  const due = !done && canPay && groupOf(b) === "topay" ? b.pay_due_date || "" : null;
  const needs = done ? [] : boardNeeds(b);
  return (
    <button type="button" onClick={onOpen} style={{ boxShadow: `inset 4px 0 0 ${edge}, 0 0 0 1px rgb(var(--c-line))` }}
      className="w-full text-left flex flex-col gap-1 min-w-0 bg-surface rounded-xl pl-5 pr-4 py-3.5 transition-[background-color,transform] duration-[130ms] hover:bg-surface-3 hover:-translate-y-px active:translate-y-0">
      <span className="flex items-center justify-between gap-2 min-w-0 text-[14px]">
        <span className="text-muted tabular-nums">{loadNumber(b)}</span>
        {k ? (
          <span className={`font-medium whitespace-nowrap ${late ? "text-danger-ink" : BOARD_INK[k]}`}>{BOARD_WORD[k]}</span>
        ) : <FreightStatusPill status={b.status} logistics={isLogisticsSide(b)} />}
      </span>
      {route && <span className="text-[17px] font-medium text-ink leading-snug break-words">{route}</span>}
      {lane && <span className="text-[15px] text-muted break-words">{lane}</span>}
      <span className="text-[15px] text-muted break-words">{when}</span>
      {(isHot(b) || unconfirmed || due !== null || needs.length > 0 || arriving || fresh) && (
        <span className="flex flex-wrap gap-1.5 mt-1.5">
          {isHot(b) && <UrgentPill />}
          {unconfirmed && <PickupNumberPill />}
          {due !== null && <StatusPill tone={dueTone(due, today)}>{dueLabel(due, today)}</StatusPill>}
          {needs.length > 0 && <StatusPill tone="neutral">Needs {needs.join(" and ")}</StatusPill>}
          {arriving && <StatusPill tone="shipping">Arriving today</StatusPill>}
          {fresh && <StatusPill tone="neutral">New</StatusPill>}
        </span>
      )}
    </button>
  );
}

/** R-525: one box of the board: its number, its title, the key to its words with a count each, and its cards. */
function BoardColumn({ col, loads, searching, onOpen, canPay }: { col: (typeof BOARD)[number]; loads: FreightBooking[]; searching: boolean; onOpen: (b: FreightBooking) => void; canPay: boolean }) {
  return (
    <section className="min-w-0 rounded-2xl bg-surface-2 p-4" style={{ boxShadow: "inset 0 0 0 1px rgb(var(--c-line))" }} aria-label={col.title}>
      <h3 className="flex items-baseline gap-2.5 m-0 text-[18px] font-medium text-ink leading-[26px]">
        <span aria-hidden className="text-[15px] text-faint tabular-nums">{col.n}</span>
        <span className="min-w-0 flex-1">{col.title}</span>
        <span className="text-[16px] text-muted tabular-nums">{loads.length}</span>
      </h3>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 mb-3.5 text-[14px] text-muted">
        {col.keys.map((k) => (
          <span key={k} className="whitespace-nowrap">
            {BOARD_WORD[k]} <span className={`font-medium tabular-nums ${BOARD_INK[k]}`}>{loads.filter((b) => boardKey(b) === k).length}</span>
          </span>
        ))}
      </div>
      <div className="grid gap-2.5">
        {loads.length === 0
          ? <div className="px-1 pt-1.5 pb-2.5 text-[15px] text-muted">{searching ? "Nothing here matches that." : "Nothing here right now."}</div>
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
  // R-583: the screen's own tabs. Loads is the board; Week holds the delivery chart and the trucks booked each week;
  // Map (R-485) is the delivered freight on the road, for whoever may see load addresses.
  const canMap = canViewFreightMap(me);
  const [tab, setTab] = useState<"loads" | "week" | "map" | "carriers" | "pay" | "shipments">("loads");
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
  // R-584: New load, a load with no deal, while the setting is on and this person may send a deal.
  const [canSend, setCanSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [openStep, setOpenStep] = useState<LoadStep | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await api.logistics.list();
      setRows(r.bookings);
      setCompleted(r.completed ?? []);
      setCanSend(r.can_send_load === true);
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
      if (raw) { localStorage.removeItem(OPEN_LOAD_KEY); const t = parseOpenLoad(raw); if (t) { setTab("loads"); openLoad(t.id, t.step); } }
      const c = localStorage.getItem(OPEN_CARRIER_KEY);
      if (c) { localStorage.removeItem(OPEN_CARRIER_KEY); setTab("carriers"); setCarrierId(c.trim() || undefined); }
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

  const tabs = [
    { id: "loads", label: "Loads" }, { id: "week", label: "Week" },
    ...(canMap ? [{ id: "map", label: "Map" }] : []),
    { id: "carriers", label: "Carriers" },
    ...(seePay ? [{ id: "pay", label: "Pay carriers" }] : []),
    ...(canShipments ? [{ id: "shipments", label: "All shipments" }] : []),
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
  const openCard = (b: FreightBooking) => { setOpenStep(undefined); setOpen(b); };

  // One quiet sentence under the date: what needs doing now, counted from the loads on the board (all of them, not the search).
  const summary = useMemo(() => {
    const today = localDay();
    const all = rows ?? [];
    const n = (k: BoardKey) => all.filter((b) => boardKey(b) === k).length;
    const late = all.filter((b) => isLate(b, today)).length;
    const overdue = canPay ? all.filter((b) => groupOf(b) === "topay" && dueTone(b.pay_due_date || "", today) === "danger").length : 0;
    const parts = [
      n("quote") > 0 && `${n("quote")} ${n("quote") === 1 ? "load needs" : "loads need"} a quote`,
      n("book") > 0 && `${n("book")} ${n("book") === 1 ? "is" : "are"} ready to book`,
      late > 0 && `${late} ${late === 1 ? "is" : "are"} late`,
      overdue > 0 && `${overdue} carrier ${overdue === 1 ? "payment is" : "payments are"} overdue`,
    ].filter((x): x is string => !!x);
    if (parts.length === 0) return "";
    return parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
  }, [rows, canPay]);

  const subtitle = tab === "loads" ? undefined
    : logisticsOnly && tab !== "week" ? "Quotes to give, trucks to book, and the paperwork for each load."
    : tab === "shipments" ? "Every deal with a truck sent to logistics: what was charged, what the carrier was paid, what is left."
    : tab === "carriers" ? "The carriers you book, how to reach them and how each one gets paid."
    : tab === "pay" ? "What each carrier is owed, what has been paid, and the bank payment behind it."
    : tab === "week" ? "Deliveries over the next two weeks, and the trucks booked each week."
    : undefined;

  const header = (
    <PageHeader
      title="Logistics"
      subtitle={subtitle}
      actions={tab === "loads" ? (<>
        <label className="ui-search" style={{ width: 380, maxWidth: "100%" }}>
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search load number, place, carrier, BOL or PRO" aria-label="Search bookings" style={{ width: "100%" }} />
        </label>
        {canSend && <Button variant="ink" onClick={() => setSending(true)}>New load</Button>}
      </>) : undefined}
      tabs={<Tabs label="Logistics views" value={tab} onChange={(id) => { setTab(id as typeof tab); if (id !== "carriers") setCarrierId(undefined); }} tabs={tabs} />}
    />
  );

  if (rows === null) {
    return (
      <div className="min-w-0" aria-busy="true">
        {header}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-7">
          {[0, 1, 2].map((i) => <div key={i} className="h-[420px] rounded-2xl bg-surface-2 animate-pulse" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {header}

      <div key={tab} className="animate-page-slide-in space-y-5 min-w-0">
      {tab === "shipments" && canShipments ? <LogisticsShipments />
        : tab === "carriers" ? <CarriersView openId={carrierId} onHostClose={() => setCarrierId(undefined)} onOpenLoad={(id) => { setTab("loads"); openLoad(id); }} />
        : tab === "pay" && seePay ? <PayCarriersView rev={payRev} onOpenLoad={(id, step) => openLoad(id, step)} />
        : tab === "map" && canMap ? <LogisticsMap me={me} />
        : tab === "week" ? (<>
          {/* When the loads are expected. */}
          <LogisticsDeliveryChart rows={rows} today={localDay()} renderRow={row} />
          <div className="hsep" />
          {/* R-542: the trucks booked each day of the week, and his commission for it. Always shown, to him and to the owner. */}
          <LogisticsWeekView onOpenLoad={(id) => openLoad(id)} />
        </>) : (<>

      {/* R-476: the board opens on a large hello and the date, easy to read at a glance. */}
      <div className="mt-6 mb-5">
        <h2 className="m-0 text-[24px] font-medium text-ink leading-8" style={{ letterSpacing: "-0.6px" }}>{hello ? `Hello, ${hello}` : "Hello"}</h2>
        <div className="text-[16px] text-muted mt-0.5">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
        {summary && <p className="m-0 mt-3 text-[18px] leading-7 text-muted">{summary}</p>}
      </div>

      {/* R-401: his own pay, only when he is the one being paid. Nothing about what a customer was charged. */}
      <YourPayCard />

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-warning-bg px-4 py-3 text-[14px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={load} className="ui-link flex-shrink-0">Try again</button>
        </div>
      )}

      {shown === 0 && !error && (
        <div className="px-6 py-14 text-center">
          <Truck size={20} className="mx-auto text-faint mb-2" />
          <div className="text-[15px] font-medium text-ink">{needle ? "Nothing matches that search" : "No loads yet"}</div>
          <div className="text-[13px] text-muted mt-1">
            {needle ? "Try a load number, a place, a carrier or a BOL number." : logisticsOnly ? "New requests show up here as they are sent." : "Ask logistics for a quote from a deal's Shipping step."}
          </div>
        </div>
      )}

      {/* R-538: "Deal 100% complete", so the Logistics person hears of it here and not only on an iPhone. */}
      {completed.filter((c) => !doneSeen.includes(c.key)).slice(0, 3).map((c) => (
        <div key={c.key} role="status" style={{ boxShadow: "inset 4px 0 0 rgb(var(--c-chart-profit)), 0 0 0 1px rgb(var(--c-line))" }}
          className="flex items-center justify-between gap-3 bg-surface-2 rounded-xl pl-5 pr-4 py-3.5 text-[16px] text-ink animate-page-slide-in">
          <span className="min-w-0 break-words">
            <span className="font-medium">Deal 100% complete.</span>{" "}
            <span className="text-muted">{c.loads.map((l) => (l.lane ? `${l.code}, ${l.lane}` : l.code)).join("; ")}: the carrier is paid and the deal is done.</span>
          </span>
          <button type="button" onClick={() => dismissDone(c.key)} className="ui-link muted flex-shrink-0">Dismiss</button>
        </div>
      ))}
      {shown > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          {board.map(({ col, loads }) => (
            <BoardColumn key={col.n} col={col} loads={loads} searching={!!needle} canPay={canPay} onOpen={openCard} />
          ))}
        </div>
      )}

      <section className="pt-2">
        <button
          type="button" onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}
          className="w-full flex items-center gap-2.5 h-12 px-3 rounded-xl text-left text-[16px] font-medium text-ink transition-colors duration-[130ms] hover:bg-surface-2"
        >
          <ChevronRight size={16} className={`text-muted transition-transform duration-200 ${doneOpen ? "rotate-90" : ""}`} />
          Completed and cancelled
          {doneOpen && doneRows && <StatusPill tone="neutral">{done.length}</StatusPill>}
        </button>
        {doneOpen && (
          <div className="pt-3 pb-1 animate-page-slide-in">
            {doneRows === null && done.length === 0
              ? <div className="px-1 py-1 text-[14px] text-muted">Loading...</div>
              : done.length === 0
                ? <div className="px-1 py-1 text-[14px] text-muted">Nothing here yet.</div>
                : <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{done.map((b) => <BoardCard key={b.id} b={b} done onOpen={() => openCard(b)} />)}</div>}
          </div>
        )}
      </section>

      </>)}
      </div>

      {sending && <BuySendSheet buy={null} live={0} onClose={() => setSending(false)} onSent={() => { setSending(false); load(); }} />}

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
