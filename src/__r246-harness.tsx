// DEV ONLY — the fixture behind r246-harness.html, throwaway for R-246's newsletter
// category chips. Nothing in the app imports this and index.html does not reference
// the page, so it never reaches a build. Renders the REAL EmailView (defaults to the
// Newsletter tab), not a copy of it.
import ReactDOM from "react-dom/client";
import EmailView from "./components/EmailView";
import "./index.css";

// One client with 2+ categories to exercise the ANY-match preselect from Inventory,
// one whole-category candidate to show the "filled" chip state, one already-excluded
// (No-bulk) client that must never be counted as a category member, and a
// no-email client that must not inflate a category's member count.
const CLIENTS = [
  { id: "c1", name: "Ava Torres", email: "ava@example.com", category: "Shoes",
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "customer",
    created_at: "2026-07-01", updated_at: "2026-07-01" },
  { id: "c2", name: "Ben Ortiz", email: "ben@example.com", category: "Shoes",
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "customer",
    created_at: "2026-07-01", updated_at: "2026-07-01" },
  { id: "c3", name: "Cleo Nash", email: "cleo@example.com", category: "General Merchandise",
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "prospect",
    created_at: "2026-07-01", updated_at: "2026-07-01" },
  { id: "c4", name: "Dana Weiss", email: "dana@example.com", category: "General Merchandise",
    is_blacklisted: false, exclusive: true, metadata: {}, lead_status: "customer",
    created_at: "2026-07-01", updated_at: "2026-07-01" },
  { id: "c5", name: "Eli Frank", email: "", category: "Shoes",
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "prospect",
    created_at: "2026-07-01", updated_at: "2026-07-01" },
];

const CATEGORIES = [
  { id: "cat1", label: "Shoes" },
  { id: "cat2", label: "General Merchandise" },
  { id: "cat3", label: "Apparel" },
];

const EMPTY_OK = new Set([
  "list_newsletters", "list_scheduled_sends", "buyer_tiers", "list_drafts",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "list_clients": return CLIENTS;
    case "list_categories": return CATEGORIES;
    case "get_newsletter_include_ranked": return true;
    case "get_newsletter_unsubscribe_enabled": return true;
    case "get_company_info": return { name: "BJM Distributions", address: "", email: "", phone: null, tax_id: null };
    default:
      if (EMPTY_OK.has(cmd)) return [];
      return null;
  }
};

// Simulates arriving from Inventory → "Send to newsletter" with a lot carrying two
// categories (Shoes) already preselected via the real sessionStorage hand-off.
if (new URLSearchParams(location.search).get("prefill") === "1") {
  sessionStorage.setItem("email_preselect_ids", JSON.stringify(["c1", "c2"]));
  sessionStorage.setItem("newsletter_prefill_content", JSON.stringify({
    subject: "New inventory — 1 lot", body: "Check out this new lot.",
  }));
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <EmailView />
  </div>,
);
