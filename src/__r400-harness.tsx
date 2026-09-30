// DEV ONLY: the fixture behind r400-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL LogisticsView (as the Logistics account and as the owner), the REAL
// DealFlowView (the card, its Shipping step, Link financials, Profit and Review & complete)
// and the REAL FinancialsView (the shipping suggestions) inside the app's shell geometry
// (216px sidebar, p-7), with the Tauri bridge stubbed. Every name, number and amount in
// __r400-fixture is invented, and the derived money (projected cost, shipping estimate) was
// worked out with the same formulas the desktop uses, so the screen can be checked by hand.
//
// Query: ?view=logistics|deals|financials  &as=dad|admin  &names=0|1  &addr=0|1  &dark=1
//        &open=INV-6001  &section=Shipping|Link financials|Profit|Review & complete
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import LogisticsView from "./components/LogisticsView";
import DealFlowView from "./components/DealFlowView";
import FinancialsView from "./components/FinancialsView";
import { ToastHost } from "./components/Toast";
import deals from "./__r400-fixture/deals.json";
import invoices from "./__r400-fixture/invoices.json";
import bookingFixture from "./__r400-fixture/bookings.json";
import bank from "./__r400-fixture/bank.json";
import "./index.css";

const q = new URLSearchParams(location.search);
const clone = (x: any) => JSON.parse(JSON.stringify(x));
if (q.get("dark") === "1") document.documentElement.classList.add("dark");

type Who = "dad" | "admin";
const state = {
  who: (q.get("as") === "dad" ? "dad" : "admin") as Who,
  names: q.get("names") !== "0",
  addr: q.get("addr") !== "0",
};

const LIVE: any[] = clone(bookingFixture.live);
const DONE: any[] = clone(bookingFixture.done);

// A booking the way the server shapes it for the caller: the Logistics account sees names and
// addresses only when its two switches are on, and never the deal.
const shape = (b: any) => {
  const dad = state.who === "dad";
  const o = {
    ...clone(b), code: "L-" + b.id.slice(3, 9).toUpperCase(),
    can_see_names: !dad || state.names, can_see_addresses: !dad || state.addr, can_see_deal: !dad,
  };
  if (!o.can_see_names) { o.pickup_name = ""; o.delivery_name = ""; }
  if (!o.can_see_addresses) { o.pickup_address = ""; o.delivery_address = ""; }
  if (dad) o.deal = null;
  return o;
};

const summary = {
  total: 3, reviewed: 0, sum_in: 0, sum_out: bank.txns.reduce((s: number, t: any) => s + t.amount, 0),
  unallocated_in: 0, unallocated_out: bank.txns.reduce((s: number, t: any) => s + t.unallocated, 0), unclassified: 2,
};

const handlers: Record<string, (a: any) => any> = {
  // Deal Flow
  list_deal_flows: () => clone(deals),
  list_invoices: () => clone(invoices),
  get_invoice: ({ id }: any) => clone(invoices.find((i) => i.id === id) ?? null),
  reconciliation_status_all: () => deals.map((f) => {
    const r = (bank.recon as any)[f.id];
    return {
      deal_flow_id: f.id, payment_received_paired: r.payment_received_paired, supplier_paid_paired: r.supplier_paid_paired,
      fully_reconciled: r.fully_reconciled, has_payment: r.pieces.buyer_paired > 0, has_financials: r.pieces.buyer_paired > 0,
      no_buyer_link: false, no_supplier_link: false, no_shipping_link: false, needs_financials: false, buyer_missing: false,
      supplier_missing: false, shipping_missing: f.id === "d7", needs_review: f.stage === "complete" ? !r.fully_reconciled : false,
      shipping_paid_paired: r.shipping_paid_paired,
    };
  }),
  refund_status_all: () => [],
  cleanup_ghost_deal_flows: () => 0,
  deal_reconciliation: ({ dealFlowId }: any) => clone((bank.recon as any)[dealFlowId] ?? (bank.recon as any).d2),
  deal_allocations: ({ dealFlowId }: any) => clone((bank.allocations as any)[dealFlowId] ?? []),
  deal_flow_payout: () => ({ refund_owed: 0, refunded: 0, shortage: null }),
  set_deal_link_na: () => null,
  // Freight bookings: the local read the deal pages use
  list_freight_bookings: ({ dealFlowId }: any) => {
    const all = [...LIVE, ...DONE].map((b) => ({ ...clone(b), code: "L-" + b.id.slice(3, 9).toUpperCase(), can_see_names: true, can_see_addresses: true, can_see_deal: true }));
    return dealFlowId ? all.filter((b) => b.deal?.id === dealFlowId) : all;
  },
  // Logistics screen
  logistics_request: ({ method, path, body }: any) => {
    const [p, qs = ""] = path.split("?");
    if (method === "GET" && p === "/api/logistics/bookings") {
      const rows = qs.includes("include_done=1") ? [...LIVE, ...DONE] : LIVE;
      return { bookings: rows.map(shape) };
    }
    const m = /^\/api\/logistics\/bookings\/(.+)$/.exec(p);
    if (method === "PATCH" && m) {
      const b = [...LIVE, ...DONE].find((x) => x.id === m[1]);
      if (!b) return Promise.reject("That booking was not found.");
      for (const [k, v] of Object.entries(body || {})) if (k !== "today") b[k] = v;
      b.updated_by_name = "Ines Okafor";
      return shape(b);
    }
    return Promise.reject("That request is not allowed here.");
  },
  // Financials
  list_bank_txns: () => clone(bank.txns),
  bank_txn_summary: () => summary,
  suggest_bank_txn_links: () => ({ suggestions: clone(bank.suggestions), source: "server", scanned: 3, eligible: 3, truncated: false }),
  allocate_bank_txn: () => null,
  set_bank_txn_review: () => null,
  list_bank_allocations_for_txn: () => [],
  list_staff: () => [],
  plaid_list_items: () => [],
  plaid_config: () => ({ has_keys: false, last_sync: null, env: "sandbox" }),
  suggest_reconciliation_missing: () => ({ deals: [], source: "server", checked: 0, truncated: false }),
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) { try { return Promise.resolve(handlers[cmd](args || {})); } catch (e) { return Promise.reject(e); } }
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(cmd.startsWith("list_") || cmd.endsWith("_all") ? [] : null);
  },
  transformCallback: () => 1,
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

const meFor = (who: Who, names: boolean, addr: boolean): any => who === "dad"
  ? { id: "u2", email: "ines@example.test", display_name: "Ines Okafor", role_id: "role_logistics", role_name: "Logistics", is_admin: false,
      permissions: ["logistics:view", "logistics:edit", ...(names ? ["logistics:view_names"] : []), ...(addr ? ["logistics:view_addresses"] : [])] }
  : { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "role_admin", role_name: "Admin", is_admin: true, permissions: ["*"] };

type View = "logistics" | "deals" | "financials";
const VIEWS: [View, string][] = [["logistics", "Logistics"], ["deals", "Deal Flow"], ["financials", "Financials"]];

// Opens a card and a step the way a person would (by clicking), so a URL reproduces a screen.
function useAutoOpen(view: View) {
  useEffect(() => {
    const open = q.get("open"), section = q.get("section");
    if (view !== "deals" || !open) return;
    let tries = 0;
    const t = window.setInterval(() => {
      tries++;
      const card = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(open) && b.className.includes("w-full"));
      if (card && !document.body.textContent?.includes("Section switcher")) {
        if (!(card as HTMLElement).dataset.r400) { (card as HTMLElement).dataset.r400 = "1"; (card as HTMLElement).click(); }
        else if (section) {
          const step = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().endsWith(section));
          if (step) { (step as HTMLElement).click(); window.clearInterval(t); }
        } else window.clearInterval(t);
      }
      if (tries > 60) window.clearInterval(t);
    }, 150);
    return () => window.clearInterval(t);
  }, [view]);
}

function Harness() {
  const [view, setView] = useState<View>((q.get("view") as View) || "logistics");
  const [who, setWho] = useState<Who>(state.who);
  const [names, setNames] = useState(state.names);
  const [addr, setAddr] = useState(state.addr);
  state.who = who; state.names = names; state.addr = addr;
  useAutoOpen(view);
  const tab = "block w-full text-left text-[13px] px-2.5 h-8 rounded-lg";
  return (
    <div className="flex h-screen bg-bg">
      <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 space-y-1">
        {VIEWS.map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} className={`${tab} ${view === v ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>{label}</button>
        ))}
        <div className="pt-3 mt-3 border-t border-line space-y-1">
          <div className="text-[11px] text-muted px-2.5">Signed in as</div>
          <button onClick={() => setWho("admin")} className={`${tab} ${who === "admin" ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>Owner</button>
          <button onClick={() => setWho("dad")} className={`${tab} ${who === "dad" ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>Logistics account</button>
          {who === "dad" && (
            <>
              <label className="flex items-center gap-2 text-[12px] text-ink-2 px-2.5 pt-1"><input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /> See names</label>
              <label className="flex items-center gap-2 text-[12px] text-ink-2 px-2.5"><input type="checkbox" checked={addr} onChange={(e) => setAddr(e.target.checked)} /> See addresses</label>
            </>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-7 min-w-0">
        <div className="max-w-[1280px] mx-auto">
          {/* A Logistics-only account never reaches Deal Flow or Financials, so they are the owner's. */}
          {view === "logistics" && <LogisticsView key={`${who}${names}${addr}`} me={meFor(who, names, addr)} />}
          {view === "deals" && (who === "admin" ? <DealFlowView /> : <p className="text-[13px] text-muted">A Logistics account has no Deal Flow screen.</p>)}
          {view === "financials" && (who === "admin" ? <FinancialsView /> : <p className="text-[13px] text-muted">A Logistics account has no Financials screen.</p>)}
        </div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
