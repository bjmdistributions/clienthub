// DEV ONLY: the fixture behind harness/r660-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL Accounts tab (R-659) or the REAL Personal tab
// (R-660, ?view=personal) on invented banks and invented spending. Every value here is invented.
import ReactDOM from "react-dom/client";
import AccountsView from "./components/AccountsView";
import PersonalView from "./components/PersonalView";
import BalancesAndTax from "./components/BalancesAndTax";
import FinancialsAttention from "./components/FinancialsAttention";
import { ToastHost } from "./components/Toast";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");

// A small round logo drawn here, so the logo path is exercised without any real bank's mark.
function logo(letter: string, fill: string): string {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = fill; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = "white"; g.font = "bold 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(letter, 32, 34);
  return c.toDataURL("image/png").split("base64,")[1];
}
const brand = {
  pi_a: { logo: logo("H", "teal"), color: "teal" },
  pi_b: { logo: null, color: "rebeccapurple" },
  pi_c: { logo: logo("N", "crimson"), color: "crimson" },
};
const acct = (key: string, item: string, institution: string, name: string, mask: string, type: string, balance: number, extra: object = {}) =>
  ({ key, item, institution, name, mask, type, subtype: "", balance, available: null, label: `${name} ··${mask}`, drift: null, ledger_rows: 0, ...extra });

const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
let id = 0;
const t = (days: number, amount: number, direction: string, category: string, merchant: string, account = "Everyday Card ··4417") =>
  ({ id: `k.btpl_${++id}`, account_key: "northfield|4417", account, posted_at: d(days), amount, direction, description: merchant.toUpperCase(), merchant, category, pending: days === 0 });

const looks: Record<string, any> = { a4: { color: "#AEAEB2" } };
(window as any).__FIXTURE = (cmd: string, args?: any) => {
  switch (cmd) {
    case "bank_balances": return {
      last_sync: new Date().toISOString(), reserve_key: "",
      accounts: [
        acct("a1", "pi_a", "Harbor Bank", "Business Checking", "1182", "depository", 48210.55, { available: 46110.55 }),
        acct("a2", "pi_a", "Harbor Bank", "Business Savings", "2290", "depository", 120000),
        acct("a3", "pi_b", "Summit Credit Union", "Operating", "0451", "depository", 9312.4, { drift: -85.5 }),
        acct("a4", "pi_c", "Northfield Card", "Business Rewards", "7731", "credit", -3920.18, { limit: 15000 }),
        acct("a5", "pi_b", "Summit Credit Union", "Visa Business", "8810", "credit", -11250, { limit: 12500, needs_fix: true }),
        // R-683: card names that say their finish.
        acct("a6", "pi_c", "Northfield Card", "Business Platinum", "3004", "credit", -18420.75, { limit: 50000, drift: 0 }),
        acct("a7", "pi_c", "Northfield Card", "Business Gold", "5512", "credit", -2210, { limit: 20000, drift: 0 }),
        acct("a8", "pi_a", "Harbor Bank", "Reserve Black", "9001", "credit", -640.2, { limit: 30000, drift: 0 }),
        acct("a9", "pi_a", "Harbor Bank", "Ink Blue Cash", "4470", "credit", -5120, { limit: 10000, drift: 0 }),
      ],
    };
    case "bank_branding": return brand;
    // R-678: card looks he set (a4 in silver), saved in memory here.
    case "account_looks": return looks;
    case "set_account_look": {
      const { key, reset, ...patch } = args ?? {};
      if (reset) delete looks[key];
      else {
        const l = { ...(looks[key] ?? {}) };
        for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; if (v === "") delete l[k]; else l[k] = v; }
        looks[key] = l;
      }
      return { ...looks };
    }
    case "site_logo": return logo("S", "#007AFF");
    case "plaid_refresh_sync": return { refresh_refused: [] };
    case "personal_overview": return {
      accounts: [{ account_key: "northfield|4417", label: "Everyday Card ··4417", institution: "Northfield Card", type: "credit", balance: 842.3, available: null, credit_limit: 5000, balance_at: new Date().toISOString() }],
      txns: [
        t(0, 6.75, "out", "FOOD_AND_DRINK", "Corner Coffee"),
        t(1, 82.4, "out", "GENERAL_MERCHANDISE", "Hometown Market"),
        t(2, 45.0, "out", "TRANSPORTATION", "Quick Fuel"),
        t(3, 24.0, "in", "GENERAL_MERCHANDISE", "Hometown Market"),
        t(4, 129.99, "out", "ENTERTAINMENT", "Lakeside Tickets"),
        t(5, 600, "in", "LOAN_PAYMENTS", "Card payment"),
        t(6, 58.2, "out", "FOOD_AND_DRINK", "Pine Street Grill"),
        t(8, 14.99, "out", "GENERAL_SERVICES", "Stream Box"),
        t(9, 2500, "in", "INCOME", "Owner draw"),
        t(12, 210.0, "out", "TRAVEL", "Coast Hotel"),
        t(13, 31.5, "out", "OTHER", "Unknown Shop"),
        t(14, 12.0, "out", "", "Paper Co"),
      ],
      candidates: [
        { account_key: "harbor bank|1182", label: "Business Checking ··1182", institution: "Harbor Bank", type: "depository", balance: 48210.55, rows: 812 },
        { account_key: "label|old card ··0099", label: "Old Card ··0099", institution: "", type: "", balance: null, rows: 37 },
      ],
    };
    case "personal_mark": return { moved: 37, not_moved: 0, kept: [{ id: "x" }] };
    case "personal_unmark": return { back: 10 };
    // R-663 and R-665: sorting, the notice switch, the attention strip and the tax lines.
    case "personal_set_category": return null;
    case "personal_notify_get": return false;
    case "personal_notify_set": return null;
    case "plaid_health": return { banks: [{ id: "pi_b", institution: "Summit Credit Union", needs_login: true, error: "", code: "", last_ok: null, last_try: null, webhook_ok: null, last_ring: null }], warnings: [] };
    case "reconcile_accounts": return [
      { account: "Business Checking ··1182", bank_balance: 48210.55, ledger_net: 100, implied_opening: 1, baseline: 1, drift: 0, txn_count: 3, settled_before: -420 },
      { account: "Operating ··0451", bank_balance: 9312.4, ledger_net: 100, implied_opening: 1, baseline: 2, drift: -85.5, txn_count: 3, settled_before: 0 },
    ];
    case "financials_overview": return {
      tax_base: 64000, tax_reserve: 19200, tax_paid: 4000, tax_should_have: 15200, tax_sweep_pct: 0.3, reserve_account_key: "a2",
      balance_source: "plaid",
      tax_extra: { reserve_in_year: 14000, reserve_out_year: 4000, uncategorised_in: 1250, uncategorised_out: 3380.4, uncategorised_rows: 7 },
    };
    case "get_money_config": return { bank_balance: 0, credit_card_balance: 0, cash_floor: 0, tax_sweep_pct: 0.3, refund_reserve_pct: 0, war_chest: 0 };
    default: return null;
  }
};

const which = q.get("view");
const view = which === "personal" ? <PersonalView />
  : which === "tax" ? <BalancesAndTax onToBook={() => {}} />
  : which === "attention" ? <FinancialsAttention onGo={(g) => { document.title = `went:${g}`; }} />
  : <AccountsView />;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6 max-w-[1180px]">{view}<ToastHost /></div>,
);
