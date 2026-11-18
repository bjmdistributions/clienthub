// DEV ONLY: the fixture behind harness/r667-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL Accounts tab (or Balances and tax, ?view=tax) so
// the REAL account statement (R-667) opens from it, on an invented bank. Every value here is invented. The fixture
// counts balances back from the bank's figure the way account_statement.rs does, and holds one transaction twice so
// the screen has a fault to bracket.
import ReactDOM from "react-dom/client";
import AccountsView from "./components/AccountsView";
import BalancesAndTax from "./components/BalancesAndTax";
import { ToastHost } from "./components/Toast";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");

const acct = (key: string, institution: string, name: string, mask: string, type: string, balance: number, drift: number) =>
  ({ key, item: "pi_a", institution, name, mask, type, subtype: "", balance, available: null, label: `${name} ··${mask}`, drift, ledger_rows: 40 });
const ACCOUNTS = [
  acct("a1", "Harbor Bank", "Business Checking", "1182", "depository", 18240.35, -412.5),
  acct("a2", "Northfield Card", "Business Rewards", "7731", "credit", -2310.4, 0),
];

const day = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
type Row = { id: string; date: string; description: string; amount: number; direction: string; pending?: boolean; retracted?: boolean };
const NAMES = ["Pallet Depot", "Lakeshore Freight", "Buyer wire Orchard Supply", "City Utilities", "Fuel Stop 22", "Dock Rental", "Buyer wire Mesa Outlet", "Box and Tape Co"];
function rowsFor(card: boolean): Row[] {
  const out: Row[] = [];
  for (let i = 1; i <= 46; i++) {
    const inn = card ? i % 9 === 0 : i % 3 === 0;
    out.push({ id: `t${i}`, date: day(Math.floor(i * 1.7)), description: NAMES[i % NAMES.length].toUpperCase(), amount: Math.round((inn ? 900 + i * 37.5 : 60 + i * 11.25) * 100) / 100, direction: inn ? "in" : "out" });
  }
  if (!card) {
    // The fault: one payment is in the books twice.
    out.push({ id: "dup", date: day(31), description: "LAKESHORE FREIGHT", amount: 412.5, direction: "out" });
    out.push({ id: "dup2", date: day(31), description: "LAKESHORE FREIGHT", amount: 412.5, direction: "out" });
    out.push({ id: "p1", date: day(0), description: "FUEL STOP 22", amount: 48.1, direction: "out", pending: true });
    out.push({ id: "w1", date: day(12), description: "DOCK RENTAL", amount: 300, direction: "out", retracted: true });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
}

const marks: Record<string, Record<string, number>> = {};
const c = (n: number) => Math.round(n * 100);
function statement(account: string, card: boolean) {
  const a = ACCOUNTS.find((x) => x.label === account)!;
  const sign = (r: Row) => (r.direction === "in" ? c(r.amount) : -c(r.amount));
  let bal = c(a.balance);
  const lines: any[] = [], pending: any[] = [], withdrawn: any[] = [];
  for (const r of rowsFor(card)) {
    const l = { id: r.id, date: r.date, description: r.description, amount: r.amount, direction: r.direction, balance: null as number | null };
    if (r.retracted) withdrawn.push(l);
    else if (r.pending) pending.push(l);
    else { l.balance = bal / 100; bal -= sign(r); lines.push(l); }
  }
  const on = (d: string) => (c(a.balance) - lines.filter((l) => l.date > d).reduce((s, l) => s + sign(l), 0)) / 100;
  // An imported statement ending 40 days back, as the bank had it: the books hold 412.50 too much money out since (so they read 412.50 high that day).
  const known: [string, number, string][] = card ? [] : [[day(40), on(day(40)) - 412.5, "statement"]];
  for (const [d, b] of Object.entries(marks[account] ?? {})) known.push([d, b, "you"]);
  const points = known.map(([date, bank, source]) => ({ date, bank, books: on(date), gap: (c(bank) - c(on(date))) / 100, source }))
    .filter((p, i, all) => p.source === "you" || !all.some((o, j) => j !== i && o.date === p.date && o.source === "you"))
    .sort((x, y) => (x.date < y.date ? 1 : -1));
  const at = points.findIndex((p) => c(p.gap) !== 0);
  let window = null;
  if (at >= 0) {
    const bad = points[at], through = at > 0 ? points[at - 1].date : "";
    const inside = lines.filter((l) => l.date > bad.date && (!through || l.date <= through));
    window = { after: bad.date, through, gap: bad.gap, count: inside.length, same_amount: inside.filter((l) => sign(l) === c(bad.gap)).map((l) => l.id) };
  }
  return {
    account, card, bank_balance: a.balance, drift: a.drift, opening: bal / 100, lines, pending, withdrawn,
    pending_total: pending.reduce((s, l) => s + sign(l), 0) / 100, withdrawn_total: withdrawn.reduce((s, l) => s + sign(l), 0) / 100,
    points, window, copies: card ? [] : ["dup2"],
  };
}

(window as any).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "bank_balances": return { last_sync: new Date().toISOString(), reserve_key: "", accounts: ACCOUNTS };
    case "bank_branding": return { pi_a: { logo: null, color: "teal" } };
    case "account_statement": return statement(args.account, args.card);
    case "account_statement_mark": {
      const mine = (marks[args.account] ??= {});
      if (args.balance == null) delete mine[args.date]; else mine[args.date] = args.balance;
      return statement(args.account, args.card);
    }
    case "financials_overview": return { tax_base: 64000, tax_reserve: 19200, tax_paid: 4000, tax_should_have: 15200, tax_sweep_pct: 0.3, reserve_account_key: "", balance_source: "plaid", tax_extra: {} };
    case "get_money_config": return { bank_balance: 0, credit_card_balance: 0, cash_floor: 0, tax_sweep_pct: 0.3, refund_reserve_pct: 0, war_chest: 0 };
    default: return null;
  }
};

const opened: string[] = [];
(window as any).__opened = opened;
const onOpenRow = (id: string) => { opened.push(id); };
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6 max-w-[1180px]">
    {q.get("view") === "tax" ? <BalancesAndTax onToBook={() => {}} onOpenRow={onOpenRow} /> : <AccountsView onOpenRow={onOpenRow} />}
    <ToastHost />
  </div>,
);
