// DEV ONLY: the fixture behind r133-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL GlobeView inside the app's shell geometry (216px sidebar). Every
// client, name and figure is INVENTED; the cities are just places on a map. The mix
// covers each "not on the map" reason, a rejected lead (must not appear anywhere),
// a country-only client, a state-only client (approximate pin), and a client at
// Kenya's centroid (latitude -0.0, which used to vanish).
//   ?rep=1     render without the money permission
//   ?n=1000    add that many generated clients, for a load test
//   ?timerraf  drive animation frames from a 30ms timer: a hidden preview pane stops
//              requestAnimationFrame entirely, and camera flights need frames to land
import ReactDOM from "react-dom/client";
import GlobeView from "./components/GlobeView";
import "./index.css";

const params = new URLSearchParams(location.search);
if (params.has("timerraf")) {
  // Each callback's duration lands in window.__rafMs, so frame cost can be measured.
  const ms: number[] = ((window as any).__rafMs = []);
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => {
    const t = performance.now();
    cb(t);
    ms.push(performance.now() - t);
  }, 30) as unknown as number;
  (window as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

const pinned: [string, string, string, number, number, string, number][] = [
  // name, city, state, lat, lng, tier, profit
  ["Harbor Lane Goods",    "Newark",       "NJ", 40.7357, -74.1724, "P", 41000],
  ["Northgate Surplus",    "Newark",       "NJ", 40.7357, -74.1724, "B",  4200],
  ["Pine Row Trading",     "Edison",       "NJ", 40.5187, -74.4121, "A", 12800],
  ["Blue Kettle Outlet",   "Philadelphia", "PA", 39.9526, -75.1652, "S", 23300],
  ["Cobalt Dock Supply",   "Brooklyn",     "NY", 40.6782, -73.9442, "C",  1500],
  ["Maple Yard Resale",    "Albany",       "NY", 42.6526, -73.7562, "Prospect", 0],
  ["Sunfield Wholesale",   "Atlanta",      "GA", 33.7490, -84.3880, "A", 10900],
  ["Red Clay Liquidators", "Charlotte",    "NC", 35.2271, -80.8431, "B",  3800],
  ["Lakeshore Bins",       "Chicago",      "IL", 41.8781, -87.6298, "S", 26100],
  ["Prairie Crate Co",     "Omaha",        "NE", 41.2565, -95.9345, "C",  1100],
  ["Mesa Pallet House",    "Phoenix",      "AZ", 33.4484, -112.0740, "B", 5300],
  ["Golden Aisle Deals",   "Los Angeles",  "CA", 34.0522, -118.2437, "A", 15600],
  ["Fogline Traders",      "Oakland",      "CA", 37.8044, -122.2712, "Prospect", 0],
  ["Cedar Point Retail",   "Seattle",      "WA", 47.6062, -122.3321, "C",  1900],
  ["Longhorn Overstock",   "Dallas",       "TX", 32.7767, -96.7970, "S", 19800],
  ["Bayou Box Market",     "Houston",      "TX", 29.7604, -95.3698, "B",  2900],
  ["Summit Bargain Barn",  "Denver",       "CO", 39.7392, -104.9903, "Prospect", 0],
  ["Keystone Resellers",   "Pittsburgh",   "PA", 40.4406, -79.9959, "C", -1200],
  ["Palmetto Pickers",     "Miami",        "FL", 25.7617, -80.1918, "A",  8700],
  ["Great Lakes Lots",     "Detroit",      "MI", 42.3314, -83.0458, "B",  3400],
];

const CATS = ["Clothing", "Shoes", "Home goods", "Electronics"];
const LEADS = ["customer", "hot_lead", "prospect", "inactive"];
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

let n = 0;
const tiers: any[] = [];
const client = (name: string, meta: Record<string, any>, extra: Record<string, any> = {}) => ({
  id: `c${++n}`, name, email: null, phone: null, company: name, notes: null,
  billing_status: "", lead_status: LEADS[n % LEADS.length], created_at: "2026-06-01", updated_at: "2026-09-01",
  metadata: meta, invoice_count: 2, last_contact_at: daysAgo((n * 7) % 60), total_revenue: 0,
  category: CATS[n % CATS.length], tags: null, street_address: null, city: meta.city ?? null, state: meta.state ?? null,
  zip_code: null, country: meta.country ?? null, next_follow_up_date: n % 5 === 0 ? daysAgo(n % 3) : n % 7 === 0 ? daysAgo(-4) : null,
  needs_review: false, is_blacklisted: false, approval_status: "approved", high_value: n % 6 === 0, ...extra,
});
const tier = (id: string, t: string, profit: number, i: number) => tiers.push({
  client_id: id, client_name: "", tier: t, avg_deal_value: 0, actual_paid: 0, total_profit: profit,
  invoices_sent: 3, last_invoice_date: t === "Prospect" ? null : daysAgo((i * 23) % 260), purchase_cadence_days: t === "Prospect" ? null : 30 + (i % 4) * 15,
  avg_commission_pct: 0, quotes_sent: 2, quotes_won: 1, deals_landed: t === "Prospect" ? 0 : 1 + (i % 6),
  reliability: ["reliable", "mixed", "low", "unrated"][i % 4], reliability_pct: 80,
});

const clients: any[] = [
  ...pinned.map(([name, city, state, lat, lng, t, profit], i) => {
    const c = client(name, { city, state, lat, lng }, { total_revenue: Math.max(0, profit) * 4 });
    tier(c.id, t, profit, i);
    return c;
  }),
  client("Savanna Trade House", { city: "Nairobi", country: "Kenya", lat: -0.0, lng: 37.9, geo_precision: "country" }),
  client("Rue Claire Stock",    { country: "France", lat: 46.6, lng: 2.2, geo_precision: "country" }),
  client("Tidewater Lots",      { state: "VA", lat: 37.9, lng: -78.3, geo_precision: "region" }),
  // Not on the map, one per reason:
  client("Quarry Road Goods",   { city: "Pittsbrgh", state: "PA" }),
  client("Willow Bend Surplus", { city: "Springfeld", state: "IL" }),
  client("Juniper Crate Co",    { city: "Boise" }),
  client("Lantern Row Resale",  { state: "Atlantis" }),
  client("Birch Hollow Goods",  { country: "USA" }),
  client("Atlas Bay Traders",   { city: "Reykjavik", country: "Iceland" }),
  client("Open Gate Market",    {}),
  client("Hollow Oak Resale",   {}),
  // A rejected lead: must not be drawn, counted, or listed.
  client("Rejected Lead Inc",   { city: "Boston", state: "MA", lat: 42.3601, lng: -71.0589 }, { approval_status: "rejected" }),
];

// Load test: invented clients spread over real city coordinates, many sharing a city.
const CITIES: [string, string, number, number][] = [
  ["New York", "NY", 40.7128, -74.006], ["Los Angeles", "CA", 34.0522, -118.2437], ["Chicago", "IL", 41.8781, -87.6298],
  ["Houston", "TX", 29.7604, -95.3698], ["Phoenix", "AZ", 33.4484, -112.074], ["Philadelphia", "PA", 39.9526, -75.1652],
  ["San Antonio", "TX", 29.4241, -98.4936], ["San Diego", "CA", 32.7157, -117.1611], ["Dallas", "TX", 32.7767, -96.797],
  ["Austin", "TX", 30.2672, -97.7431], ["Jacksonville", "FL", 30.3322, -81.6557], ["Columbus", "OH", 39.9612, -82.9988],
  ["Charlotte", "NC", 35.2271, -80.8431], ["Indianapolis", "IN", 39.7684, -86.1581], ["Seattle", "WA", 47.6062, -122.3321],
  ["Denver", "CO", 39.7392, -104.9903], ["Nashville", "TN", 36.1627, -86.7816], ["Boston", "MA", 42.3601, -71.0589],
  ["Detroit", "MI", 42.3314, -83.0458], ["Memphis", "TN", 35.1495, -90.049], ["Atlanta", "GA", 33.749, -84.388],
  ["Miami", "FL", 25.7617, -80.1918], ["Newark", "NJ", 40.7357, -74.1724], ["Jersey City", "NJ", 40.7178, -74.0431],
  ["Paterson", "NJ", 40.9168, -74.1718], ["Trenton", "NJ", 40.2206, -74.7597], ["Camden", "NJ", 39.9259, -75.1196],
  ["Baltimore", "MD", 39.2904, -76.6122], ["Richmond", "VA", 37.5407, -77.436], ["Pittsburgh", "PA", 40.4406, -79.9959],
  ["Cleveland", "OH", 41.4993, -81.6944], ["St. Louis", "MO", 38.627, -90.1994], ["Kansas City", "MO", 39.0997, -94.5786],
  ["Minneapolis", "MN", 44.9778, -93.265], ["Portland", "OR", 45.5152, -122.6784], ["Las Vegas", "NV", 36.1699, -115.1398],
  ["Salt Lake City", "UT", 40.7608, -111.891], ["Orlando", "FL", 28.5383, -81.3792], ["Tampa", "FL", 27.9506, -82.4572],
  ["New Orleans", "LA", 29.9511, -90.0715], ["Buffalo", "NY", 42.8864, -78.8784], ["Albany", "NY", 42.6526, -73.7562],
];
const TIERS = ["P", "S", "A", "A", "B", "B", "C", "C", "C", "Prospect", "Prospect", "New"];
for (let i = 0; i < Number(params.get("n") || 0); i++) {
  const [city, state, lat, lng] = CITIES[(i * 7 + (i % 5)) % CITIES.length];
  const t = TIERS[i % TIERS.length];
  const c = client(`Invented Buyer ${i + 1}`, { city, state, lat, lng });
  tier(c.id, t, t === "Prospect" || t === "New" ? 0 : 500 + ((i * 3137) % 30000), i);
  clients.push(c);
}

const handlers: Record<string, (a: any) => any> = {
  list_clients_filtered: () => JSON.parse(JSON.stringify(clients)),
  buyer_tiers: () => tiers,
  geocode_all_clients: () => ({ total: clients.length, matched: 0, skipped: 2, not_found: 6, removed: 0, message: "" }),
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) return Promise.resolve(handlers[cmd](args || {}));
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(cmd.startsWith("list_") ? [] : null);
  },
  transformCallback: () => 1,
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

const me: any = { id: "u1", email: "invented@example.com", permissions: params.has("rep") ? ["clients:view"] : ["*"] };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen bg-bg">
    <div className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 text-[13px] text-ink-2">Globe</div>
    <main className="flex-1 min-w-0 h-full overflow-hidden" style={{ background: "#0a0a14" }}>
      <GlobeView me={me} />
    </main>
  </div>,
);
