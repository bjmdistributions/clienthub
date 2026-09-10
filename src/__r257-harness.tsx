// DEV ONLY — fixture behind r257-harness.html. Renders TiersView against ten rows
// shaped like the live tiers table (the values in Jack's R-257 screenshot), so the
// Revenue and Frequency odometer cells can be compared against plain text.
// Nothing in the app imports this and index.html does not reference the page.
import ReactDOM from "react-dom/client";
import TiersView from "./components/TiersView";
import { BuyerTier } from "./lib/api";
import "./index.css";

// The Browser pane reports prefers-reduced-motion, which makes <Odometer> render plain text.
// Report "no preference" here so the digit windows render and their geometry can be measured.
const realMatchMedia = window.matchMedia.bind(window);
window.matchMedia = (q: string) =>
  q.includes("prefers-reduced-motion") ? ({ matches: false, media: q } as unknown as MediaQueryList) : realMatchMedia(q);

const RAW: [string, string, number, number | null, number][] = [
  ["Dylan Sanders", "P", 31493.99, 15, 4.5],
  ["Miles Campbell", "S", 67660.0, 31, 19.8],
  ["Zayd Rahman", "A", 59819.75, 8, 12.8],
  ["Priya Nair", "A", 26336.25, 31, 8.1],
  ["Owen Fitzgerald", "B", 34461.67, 52, 2.2],
  ["Harper Lin", "B", 50540.0, null, 7.1],
  ["Ali Rehman", "C", 15966.67, 40, 17.8],
  ["Tamim Younes", "C", 8420.9, 24, 14.4],
  ["Marcus Whitfield", "C", 16244.0, 99, 10.2],
  ["Ronnie Diaz", "P", 38412.0, null, 35.2],
];

const ROWS: BuyerTier[] = RAW.map(([client_name, tier, avg, cadence, margin], i) => ({
  client_id: `c${i}`, client_name, tier,
  avg_deal_value: avg, actual_paid: avg * 4, total_profit: avg * 0.4,
  invoices_sent: 4, last_invoice_date: "2026-09-01", purchase_cadence_days: cadence,
  avg_commission_pct: margin, quotes_sent: 3, quotes_won: 2, deals_landed: 4,
  reliability: "reliable", reliability_pct: 66,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => (cmd === "buyer_tiers" ? ROWS : null);

ReactDOM.createRoot(document.getElementById("root")!).render(<TiersView />);
