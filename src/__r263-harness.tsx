// DEV ONLY — fixture behind r263-harness.html. Mounts LeadBubbles (+ its three
// sub-view modals) and ApprovalsView against a window.__FIXTURE answering every
// R-263 command (call_requests / notifications / lead_clicks — Pass 2, server
// proxy) with realistic data, so the UI can be checked visually before those
// commands exist. Nothing in the app imports this and index.html does not
// reference the page.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { api, type Client } from "./lib/api";
import LeadBubbles from "./components/LeadBubbles";
import { ApprovalsView } from "./components/ApprovalsView";
import "./index.css";

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
const hoursFromNow = (h: number) => new Date(now + h * 3600_000).toISOString();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

// ---- fixture data ----------------------------------------------------

const PENDING_CLIENTS: Partial<Client>[] = [
  {
    id: "c1", name: "Marcus Webb", email: "marcus@webbsupply.com", phone: "512-555-0142",
    company: "Webb Supply Co", approval_status: "pending", created_at: hoursAgo(3), updated_at: hoursAgo(3),
    metadata: { source: "intake", inquiry_type: "New account", volume: "40 pallets/mo", region: "Texas" },
  },
  {
    id: "c2", name: "Priya Shah", email: "priya@shahtrading.com", phone: "310-555-0199",
    company: "Shah Trading", approval_status: "pending", created_at: hoursAgo(20), updated_at: hoursAgo(20),
    metadata: { source: "shopify" },
  },
];

const RESOLVED_CLIENTS: Partial<Client>[] = [
  {
    id: "c3", name: "Dale Kim", email: "dale@kimwholesale.com", company: "Kim Wholesale",
    approval_status: "approved", created_at: daysAgo(4), updated_at: daysAgo(3),
    metadata: { source: "intake" },
  },
  {
    id: "c4", name: "Olivia Brandt", email: "olivia@brandtgoods.com", company: "Brandt Goods",
    approval_status: "rejected", created_at: daysAgo(9), updated_at: daysAgo(8),
    metadata: { source: "form" },
  },
];

const CLIENTS_BY_ID: Record<string, Partial<Client>> = {
  c5: { id: "c5", name: "Old Client LLC", email: "contact@oldclient.com", company: "Old Client LLC" },
};

const APPROVAL_REQUESTS = [
  {
    id: "a1", kind: "listing_stale", entity_id: null,
    summary: "Renew or mark sold: Pallet of iPhone 13 cases", requested_by_name: null, created_at: hoursAgo(50),
  },
  {
    id: "a2", kind: "client_delete", entity_id: "c5",
    summary: "Delete: Old Client LLC", requested_by_name: "Jordan (rep)", created_at: hoursAgo(6),
  },
];

const CALL_REQUESTS = [
  {
    id: "call1", org_id: "org1", client_id: null, name: "Renee Alvarez", email: "renee@alvarezimports.com",
    phone: "702-555-0110", company: "Alvarez Imports", best_time: "Morning",
    questions: "Interested in bulk electronics-returns pricing for a standing monthly order.",
    status: "pending", scheduled_at: null, confirmed_at: null, confirmation_sent_via: null,
    archived: false, created_at: hoursAgo(5), updated_at: hoursAgo(5),
  },
  {
    id: "call2", org_id: "org1", client_id: null, name: "Wes Okafor", email: "wes@okaforlogistics.com",
    phone: "213-555-0166", company: "Okafor Logistics", best_time: "Afternoon",
    questions: "Want to walk through FOB terms before committing to a lane.",
    status: "pending", scheduled_at: null, confirmed_at: null, confirmation_sent_via: null,
    archived: false, created_at: hoursAgo(28), updated_at: hoursAgo(28),
  },
  {
    id: "call3", org_id: "org1", client_id: "c3", name: "Tomas Rivera", email: "tomas@riveralogistics.com",
    phone: "915-555-0133", company: "Rivera Logistics", best_time: "Evening", questions: null,
    status: "confirmed", scheduled_at: hoursFromNow(26), confirmed_at: hoursAgo(2),
    confirmation_sent_via: "desktop_smtp", archived: false, created_at: daysAgo(2), updated_at: hoursAgo(2),
  },
  {
    id: "call4", org_id: "org1", client_id: null, name: "Grace Liu", email: "grace@liuwholesale.com",
    phone: "408-555-0177", company: "Liu Wholesale", best_time: "Morning", questions: null,
    status: "declined", scheduled_at: null, confirmed_at: null, confirmation_sent_via: null,
    archived: false, created_at: daysAgo(5), updated_at: daysAgo(5),
  },
];

const LEAD_NOTIFICATIONS = [
  {
    id: "n1", org_id: "org1", kind: "supply_lead",
    title: "Supplier lead: Liu Wholesale",
    body: "Grace Liu wants to sell a load of electronics returns.",
    payload_json: JSON.stringify({ company: "Liu Wholesale", volume: "3 truckloads", category: "Electronics", contact: "grace@liuwholesale.com" }),
    entity_id: null, status: "unread", acknowledged_at: null, acknowledged_by: null, created_at: hoursAgo(9),
  },
  {
    id: "n2", org_id: "org1", kind: "supply_lead",
    title: "Supplier lead: Hendricks Freight",
    body: "New sell-to-us submission from the website.",
    payload_json: JSON.stringify({ company: "Hendricks Freight", volume: "1 pallet", category: "Apparel", contact: "sam@hendricksfreight.com", phone: "701-555-0121" }),
    entity_id: null, status: "unread", acknowledged_at: null, acknowledged_by: null, created_at: hoursAgo(31),
  },
];

const LEAD_STATS = {
  pending_requests: PENDING_CLIENTS.length,
  next_call: { id: "call3", name: "Tomas Rivera", scheduled_at: hoursFromNow(26) },
  pending_calls: CALL_REQUESTS.filter((c) => c.status === "pending").length,
  organic_leads: { total: 47, last_30d: 12, today: 2 },
  unacknowledged: { supply_lead: LEAD_NOTIFICATIONS.length },
};

function lotClicks(lotId: string, lotName: string, n: number, spreadHours: number) {
  return Array.from({ length: n }, (_, i) => {
    const at = hoursAgo(Math.round((i / n) * spreadHours));
    return { id: `${lotId}-${i}`, org_id: "org1", kind: "whatsapp", lot_id: lotId, lot_name: lotName, source_host: "bjmdistributions.com", created_at: at, day: at.slice(0, 10) };
  });
}
const LEAD_CLICKS = [
  ...lotClicks("lot1", "Pallet of Nike Apparel Returns", 5, 600),
  ...lotClicks("lot2", "Mixed Electronics Pallet", 3, 400),
  ...lotClicks("lot3", "Amazon Return Pallet — Home Goods", 2, 100),
];

// ---- fixture dispatch --------------------------------------------------

let supplyLeadStatus: Record<string, string> = { n1: "unread", n2: "unread" };
let pendingClients = [...PENDING_CLIENTS];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "get_pending_approvals": return pendingClients;
    case "list_resolved_approval_requests": return RESOLVED_CLIENTS;
    case "list_approval_requests": return APPROVAL_REQUESTS;
    case "get_client": return CLIENTS_BY_ID[args?.id] ?? null;
    case "update_client": return null;
    case "approve_client":
      pendingClients = pendingClients.filter((c) => c.id !== args?.id);
      return null;
    case "reject_client":
      pendingClients = pendingClients.filter((c) => c.id !== args?.id);
      return null;
    case "resolve_approval_request": return null;
    case "lead_dashboard_stats": return LEAD_STATS;
    case "list_call_requests": return CALL_REQUESTS;
    case "confirm_call_request": return null;
    case "cancel_call_request": return null;
    case "reschedule_call_request": return null;
    case "archive_call_request": return null;
    case "list_lead_notifications": {
      const kind = args?.kind;
      const status = args?.status;
      return LEAD_NOTIFICATIONS
        .filter((n) => !kind || n.kind === kind)
        .map((n) => ({ ...n, status: supplyLeadStatus[n.id] }))
        .filter((n) => !status || n.status === status);
    }
    case "ack_lead_notification":
      if (args?.id) supplyLeadStatus[args.id] = "acknowledged";
      return null;
    case "list_lead_clicks": return LEAD_CLICKS;
    default: return null;
  }
};

// ---- harness shell: theme + width toggles ------------------------------
//
// The width toggle below drives an <iframe>, not a plain inner div. A div's
// pixel width has no effect on Tailwind's `md:`/`lg:` classes — those are
// real CSS media queries keyed to the browser's own viewport, not to any
// container's rendered width. An iframe gets its own viewport equal to its
// box size, so setting the iframe's width is the one DOM technique that
// actually re-triggers `md:`/`lg:` inside it. (Confirmed via r263 fixer
// round 1: the old div-width toggle produced zero visible change at either
// preset because both exceeded the buggy `md` breakpoint; use
// resize_window on the real browser tab for a second opinion when in doubt.)
//
// "1024/1440" name the real app WINDOW width the preset stands in for; the
// iframe itself is sized to that minus the fixed 216px sidebar, since the
// harness doesn't render the sidebar and this is the content width the
// sidebar would actually leave `lg:` (1024px) to key off of.

const WIDTHS = { "1024": 1024 - 216, "1440": 1440 - 216 } as const;
type WidthKey = keyof typeof WIDTHS;
type ThemeKey = "light" | "dark" | "matte" | "light-mono";

function applyTheme(theme: ThemeKey) {
  const html = document.documentElement;
  html.classList.toggle("dark", theme === "dark" || theme === "matte");
  html.classList.toggle("matte", theme === "matte" || theme === "light-mono");
}

// Rendered inside the iframe (?embed=1&theme=...): the actual component
// tree under test, with no theme/width chrome of its own.
function Embedded({ theme }: { theme: ThemeKey }) {
  const [pending, setPending] = useState<Client[]>([]);
  const refreshPending = () => { api.getPendingApprovals().then(setPending).catch(() => {}); };
  useEffect(() => { refreshPending(); }, []);
  useEffect(() => { applyTheme(theme); }, [theme]);

  return (
    <div style={{ background: "var(--t-bg)", minHeight: "100vh" }}>
      <div style={{ padding: 24 }}>
        <LeadBubbles pendingApprovals={pending} onApprovalsChanged={refreshPending} />
      </div>
      <div style={{ borderTop: "1px solid var(--t-b1, #ddd)" }}>
        <ApprovalsView />
      </div>
    </div>
  );
}

// The top-level page: theme/width toggle chrome plus the iframe that hosts
// <Embedded>. Changing `theme` reloads the iframe (a fresh document, so the
// fixture's window.__TAURI_INTERNALS__/__FIXTURE re-initialize cleanly);
// changing `width` just resizes the iframe box, which is all real
// media-query re-evaluation needs.
function Harness() {
  const [theme, setTheme] = useState<ThemeKey>("light");
  const [width, setWidth] = useState<WidthKey>("1440");
  const src = `${window.location.pathname}?embed=1&theme=${theme}`;

  return (
    <div style={{ background: "#eee", minHeight: "100vh", padding: 20 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", fontFamily: "system-ui" }}>
        {(["light", "dark", "matte", "light-mono"] as ThemeKey[]).map((t) => (
          <button key={t} onClick={() => setTheme(t)}
            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #999", background: theme === t ? "#333" : "#fff", color: theme === t ? "#fff" : "#111", cursor: "pointer", fontSize: 12 }}>
            {t}
          </button>
        ))}
        <span style={{ width: 1, background: "#999", margin: "0 4px" }} />
        {(Object.keys(WIDTHS) as WidthKey[]).map((w) => (
          <button key={w} onClick={() => setWidth(w)}
            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #999", background: width === w ? "#333" : "#fff", color: width === w ? "#fff" : "#111", cursor: "pointer", fontSize: 12 }}>
            {w}px window ({WIDTHS[w]}px content — real iframe viewport)
          </button>
        ))}
      </div>

      <iframe
        title="R-263 harness preview"
        src={src}
        style={{ width: WIDTHS[width], maxWidth: "100%", height: 1600, border: "1px solid #999", background: "#fff", display: "block", margin: "0 auto" }}
      />
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
const isEmbed = params.get("embed") === "1";
const embedTheme = (params.get("theme") as ThemeKey | null) ?? "light";

ReactDOM.createRoot(document.getElementById("root")!).render(
  isEmbed ? <Embedded theme={embedTheme} /> : <Harness />
);
