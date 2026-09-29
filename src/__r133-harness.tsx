// DEV ONLY: the fixture behind r133-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL GlobeView inside the app's shell geometry (216px sidebar). Every
// client, name, place and figure is INVENTED. The mix covers each "not on the globe"
// reason, a rejected lead (must not appear anywhere), a country-only client, and a
// client at Kenya's centroid (latitude -0.0, which used to vanish).
import ReactDOM from "react-dom/client";
import GlobeView from "./components/GlobeView";
import "./index.css";

const pinned: [string, string, string, number, number, string, number][] = [
  // name, city, state, lat, lng, tier, revenue
  ["Harbor Lane Goods",    "Newark",       "NJ", 40.7357, -74.1724, "P", 184000],
  ["Northgate Surplus",    "Newark",       "NJ", 40.7357, -74.1724, "B",  22000],
  ["Pine Row Trading",     "Edison",       "NJ", 40.5187, -74.4121, "A",  61000],
  ["Blue Kettle Outlet",   "Philadelphia", "PA", 39.9526, -75.1652, "S",  97000],
  ["Cobalt Dock Supply",   "Brooklyn",     "NY", 40.6782, -73.9442, "C",   8000],
  ["Maple Yard Resale",    "Albany",       "NY", 42.6526, -73.7562, "Prospect", 0],
  ["Sunfield Wholesale",   "Atlanta",      "GA", 33.7490, -84.3880, "A",  54000],
  ["Red Clay Liquidators", "Charlotte",    "NC", 35.2271, -80.8431, "B",  19000],
  ["Lakeshore Bins",       "Chicago",      "IL", 41.8781, -87.6298, "S", 112000],
  ["Prairie Crate Co",     "Omaha",        "NE", 41.2565, -95.9345, "C",   6000],
  ["Mesa Pallet House",    "Phoenix",      "AZ", 33.4484, -112.0740, "B", 27000],
  ["Golden Aisle Deals",   "Los Angeles",  "CA", 34.0522, -118.2437, "A",  71000],
  ["Fogline Traders",      "Oakland",      "CA", 37.8044, -122.2712, "Prospect", 0],
  ["Cedar Point Retail",   "Seattle",      "WA", 47.6062, -122.3321, "C",   9000],
  ["Longhorn Overstock",   "Dallas",       "TX", 32.7767, -96.7970, "S",  88000],
  ["Bayou Box Market",     "Houston",      "TX", 29.7604, -95.3698, "B",  15000],
  ["Summit Bargain Barn",  "Denver",       "CO", 39.7392, -104.9903, "Prospect", 0],
  ["Keystone Resellers",   "Pittsburgh",   "PA", 40.4406, -79.9959, "C",  11000],
  ["Palmetto Pickers",     "Miami",        "FL", 25.7617, -80.1918, "A",  43000],
  ["Great Lakes Lots",     "Detroit",      "MI", 42.3314, -83.0458, "B",  17000],
];

let n = 0;
const client = (name: string, meta: Record<string, any>, extra: Record<string, any> = {}) => ({
  id: `c${++n}`, name, email: null, phone: null, company: name, notes: null,
  billing_status: "", lead_status: "customer", created_at: "2026-06-01", updated_at: "2026-09-01",
  metadata: meta, invoice_count: 2, last_contact_at: "2026-09-12", total_revenue: 0,
  category: null, tags: null, street_address: null, city: meta.city ?? null, state: meta.state ?? null,
  zip_code: null, country: meta.country ?? null, next_follow_up_date: null, needs_review: false,
  is_blacklisted: false, approval_status: "approved", ...extra,
});

const tiers: { client_id: string; tier: string }[] = [];
const clients = [
  ...pinned.map(([name, city, state, lat, lng, tier, revenue]) => {
    const c = client(name, { city, state, lat, lng }, { total_revenue: revenue });
    tiers.push({ client_id: c.id, tier });
    return c;
  }),
  client("Savanna Trade House", { city: "Nairobi", country: "Kenya", lat: -0.0, lng: 37.9 }),
  client("Rue Claire Stock",    { country: "France", lat: 46.6, lng: 2.2 }),
  // Not on the globe, one per reason:
  client("Quarry Road Goods",   { city: "Pittsbrgh", state: "PA" }),
  client("Willow Bend Surplus", { city: "Springfeld", state: "IL" }),
  client("Tidewater Lots",      { state: "VA" }),
  client("Juniper Crate Co",    { city: "Boise" }),
  client("Atlas Bay Traders",   { city: "Reykjavik", country: "Iceland" }),
  client("Open Gate Market",    {}),
  client("Hollow Oak Resale",   {}),
  // A rejected lead: must not be drawn, counted, or listed.
  client("Rejected Lead Inc",   { city: "Boston", state: "MA", lat: 42.3601, lng: -71.0589 }, { approval_status: "rejected" }),
];

const handlers: Record<string, (a: any) => any> = {
  list_clients_filtered: () => JSON.parse(JSON.stringify(clients)),
  buyer_tiers: () => tiers,
  geocode_all_clients: () => ({ total: clients.length, matched: 0, skipped: 2, not_found: 5, removed: 0, message: "" }),
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

const rep = new URLSearchParams(location.search).has("rep");
const me: any = { id: "u1", email: "invented@example.com", permissions: rep ? ["clients:view"] : ["*"] };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen bg-bg">
    <div className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 text-[13px] text-ink-2">Globe</div>
    <main className="flex-1 min-w-0 h-full overflow-hidden" style={{ background: "#0a0a14" }}>
      <GlobeView me={me} />
    </main>
  </div>,
);
