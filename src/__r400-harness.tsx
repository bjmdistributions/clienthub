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
// R-401 adds the logistics pay to it: the Brief block and "ready to close" list, the Settings
// screen (the Logistics pay section under Splits and the tracker under Team, payouts), his "Your
// pay" card (as=dad), and INV-6008, a deal whose invoice has an item line and a Shipping line.
//
// Query: ?view=logistics|deals|financials|brief|settings  &as=dad|admin  &names=0|1  &addr=0|1  &dark=1
//        &open=INV-6001  &section=Supplier & cost|Link financials|Shipping|Profit|Review & complete
//        &tab=splits|payouts (settings: which Settings screen to open)
// R-415: &mode=pay|track|off (the logistics pay choice) and &byteam=0|1 (who fills in the freight). The
// booking objects carry shipping_billed, trucks_on_deal and freight_by_team; the Brief block, the Settings
// cards and the tracker follow the mode.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import LogisticsView from "./components/LogisticsView";
import DealFlowView from "./components/DealFlowView";
import FinancialsView from "./components/FinancialsView";
import BriefView from "./components/BriefView";
import SettingsView from "./components/SettingsView";
import { ToastHost } from "./components/Toast";
import { payRoute, r415, r415Route, settings as paySettings } from "./__r400-fixture/pay";
import deals from "./__r400-fixture/deals.json";
import invoices from "./__r400-fixture/invoices.json";
import bookingFixture from "./__r400-fixture/bookings.json";
import bank from "./__r400-fixture/bank.json";
import "./index.css";

const q = new URLSearchParams(location.search);
// A confirm sheet would block the page in a headless run, so the harness answers yes.
window.confirm = () => true;
const clone = (x: any) => JSON.parse(JSON.stringify(x));
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
r415.byTeam = q.get("byteam") !== "0";
if (q.get("mode") === "track") paySettings.surplus_mode = "track";
if (q.get("mode") === "off") paySettings.enabled = false;

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
// What each deal was charged for shipping (the server works it out), and how many live trucks it has.
const CHARGED: Record<string, number> = { d1: 800, d2: 650, d3: 500, d6: 300, d7: 400, d8: 500, d9: 620 };
const r415Fields = (b: any) => ({
  shipping_billed: CHARGED[b.deal?.id] ?? 0,
  trucks_on_deal: [...LIVE, ...DONE].filter((x) => x.deal?.id === b.deal?.id && x.status !== "cancelled").length,
  freight_by_team: r415.byTeam,
});
const shape = (b: any) => {
  const dad = state.who === "dad";
  const o = {
    ...clone(b), ...r415Fields(b), code: "L-" + b.id.slice(3, 9).toUpperCase(),
    can_see_names: !dad || state.names, can_see_addresses: !dad || state.addr, can_see_deal: !dad,
  };
  if (!o.can_see_names) { o.pickup_name = ""; o.delivery_name = ""; }
  if (!o.can_see_addresses) { o.pickup_address = ""; o.delivery_address = ""; }
  // R-452: the extra pickups, redacted the same way.
  o.extra_pickups = (o.extra_pickups ?? []).map((x: any) => ({ ...x, name: o.can_see_names ? x.name : "", address: o.can_see_addresses ? x.address : "" }));
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
  deal_flow_payout: ({ dealFlowId }: any) => ({
    refund_owed: 0, refunded: 0, shortage: null,
    logistics_pay: dealFlowId === "d8" ? 150 : 0, logistics_pay_pending: dealFlowId === "d6",
  }),
  // R-401: the pay line for one deal. INV-6008 is the worked one (charged 500, paid 350, pays 150).
  get_deal_logistics_pay: ({ dealFlowId }: any) => dealFlowId === "d8"
    ? { charged: 500, charged_source: "lines", freight: 350, freight_source: "paid", surplus: 150, pay: 150, rule: "share", pending: false,
        earned_on: "2026-09-21", due_date: "2026-10-02", booking_codes: ["L-8B1D4E"], payee_name: "Ines Okafor" }
    : null,
  search_suppliers: () => [],
  add_supplier_payment: () => "sp_new",
  update_supplier_payment: () => null,
  remove_supplier_payment: () => null,
  recalc_deal_from_bank: () => null,
  due_followups: () => [],
  get_receivables_aging: () => ({ summary: {}, by_client: [], items: [] }),
  generate_weekly_brief: () => ({
    week_start: "2026-09-28", week_end: "2026-10-04", new_clients_this_week: 3, interactions_this_week: 11,
    net_profit_this_week: 4200, payout_totals: [],
  }),
  set_deal_link_na: () => null,
  // Freight bookings: the local read the deal pages use
  list_freight_bookings: ({ dealFlowId }: any) => {
    const all = [...LIVE, ...DONE].map((b) => ({ ...clone(b), ...r415Fields(b), code: "L-" + b.id.slice(3, 9).toUpperCase(), can_see_names: true, can_see_addresses: true, can_see_deal: true }));
    return dealFlowId ? all.filter((b) => b.deal?.id === dealFlowId) : all;
  },
  // Logistics screen
  logistics_request: ({ method, path, body }: any) => {
    const paid = payRoute(method, path, body, state.who === "dad" ? "payee" : "owner", state.names);
    if (paid !== undefined) return paid;
    const r415r = r415Route(method, path, body, state.who === "dad" ? "payee" : "owner");
    if (r415r !== undefined) return r415r;
    const [p, qs = ""] = path.split("?");
    if (method === "GET" && p === "/api/logistics/bookings") {
      const rows = qs.includes("include_done=1") ? [...LIVE, ...DONE] : LIVE;
      return { bookings: rows.map(shape) };
    }
    // R-452: the Send sheet's prefill (two suppliers on the deal) and its create.
    if (method === "GET" && p.startsWith("/api/logistics/prefill/")) {
      return { pickup_name: "Northgate Wholesale", pickup_address: "410 Mercer Ave, Northgate, OH 44120", delivery_name: "Lakeside Discount Co",
        delivery_address: "12 Shore Rd, Lakeside, MI 49001", pickup_options: [
          { name: "Northgate Wholesale", address: "410 Mercer Ave, Northgate, OH 44120" },
          { name: "Birchwood Supply Yard", address: "88 Kiln St, Fairhaven, OH 44101" }] };
    }
    if (method === "POST" && p === "/api/logistics/bookings") { (window as any).__created = body; return shape({ ...LIVE[0], ...body, id: "fb_new0000000" }); }
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
  list_staff: () => [
    { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "role_admin", role_name: "Admin", status: "active", commission_pct: 0, hide_pay_cuts: false },
    { id: "u2", email: "ines@example.test", display_name: "Ines Okafor", role_id: "role_logistics", role_name: "Logistics", status: "active", commission_pct: 0, hide_pay_cuts: false },
    { id: "u3", email: "sam@example.test", display_name: "Sam Rivera", role_id: "role_sales", role_name: "Sales", status: "active", commission_pct: 10, hide_pay_cuts: false },
  ],
  list_roles: () => ({ modules: [], roles: [
    { id: "role_admin", name: "Admin", permissions: ["*"], is_system: true },
    { id: "role_logistics", name: "Logistics", permissions: ["logistics:view", "logistics:edit"], is_system: true },
    { id: "role_sales", name: "Sales", permissions: ["deal_flow:view"], is_system: false },
  ] }),
  get_payout_split: () => [{ name: "Business", pct: 60, is_business: true, kind: "business" }, { name: "Partner one", pct: 40, is_business: false, kind: "person" }],
  list_rep_payouts: () => ({ enabled: true, payouts: [{ rep_id: "u3", name: "Sam Rivera", deals: 4, refunded_deals: 0, owed: 1240 }] }),
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

type View = "logistics" | "deals" | "financials" | "brief" | "settings";
const VIEWS: [View, string][] = [["logistics", "Logistics"], ["deals", "Deal Flow"], ["financials", "Financials"], ["brief", "Brief"], ["settings", "Settings"]];

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

// Clicks through Settings the way a person would: the Splits tab, or Team and then Payouts.
function useOpenSettings(view: View) {
  useEffect(() => {
    if (view !== "settings") return;
    const tab = q.get("tab") === "payouts" ? "payouts" : "splits";
    let tries = 0, stage = 0;
    const t = window.setInterval(() => {
      tries++;
      const btns = Array.from(document.querySelectorAll("button"));
      const find = (w: string) => btns.find((b) => b.textContent?.trim().startsWith(w));
      if (stage === 0) { const b = find(tab === "payouts" ? "Team" : "Splits"); if (b) { (b as HTMLElement).click(); stage = tab === "payouts" ? 1 : 2; } }
      else if (stage === 1) { const b = btns.find((x) => x.textContent?.trim().toLowerCase() === "payouts"); if (b) { (b as HTMLElement).click(); stage = 2; } }
      if (stage === 2 || tries > 60) window.clearInterval(t);
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
  useOpenSettings(view);
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
          {view === "brief" && (who === "admin" ? <BriefView currentUser={{ role: "admin", name: "Owner" }} /> : <p className="text-[13px] text-muted">A Logistics account has no Brief.</p>)}
          {view === "settings" && (who === "admin" ? <SettingsView me={meFor("admin", true, true)} /> : <p className="text-[13px] text-muted">A Logistics account sees only its own settings.</p>)}
        </div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
