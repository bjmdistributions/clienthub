// DEV ONLY — the fixture behind r297-harness.html, throwaway for R-297's newsletter
// audience-count fix. Nothing in the app imports this and index.html does not reference
// the page, so it never reaches a build. Renders the REAL EmailView (defaults to the
// Newsletter tab), not a copy of it, against the real 163-client anonymised fixture in
// src/__r297-fixture/ (see that folder + the sibling scratchpad fixture/README.md for
// how expected.json's independent oracle was computed).
import ReactDOM from "react-dom/client";
import EmailView from "./components/EmailView";
import "./index.css";
import CLIENTS from "./__r297-fixture/clients.json";
import CATEGORIES from "./__r297-fixture/categories.json";
import TIERS from "./__r297-fixture/tiers.json";

const EMPTY_OK = new Set([
  "list_newsletters", "list_scheduled_sends", "list_drafts", "list_newsletter_schedules",
  "get_send_from_options",
]);

(window as unknown as { __FIXTURE: (cmd: string) => unknown }).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "list_clients": return CLIENTS;
    case "list_categories": return CATEGORIES;
    case "buyer_tiers": return TIERS;
    case "get_newsletter_include_ranked": return true;
    case "get_newsletter_unsubscribe_enabled": return true;
    case "get_company_info": return { name: "BJM Distributions", address: "", email: "", phone: null, tax_id: null };
    default:
      if (EMPTY_OK.has(cmd)) return [];
      return null;
  }
};

const params = new URLSearchParams(location.search);

// Simulates arriving from Clients view "Email" bulk action with the first 5 fixture
// clients preselected via the real sessionStorage hand-off (see ClientsView.tsx).
if (params.get("pick") === "1") {
  const ids = (CLIENTS as { id: string }[]).slice(0, 5).map((c) => c.id);
  sessionStorage.setItem("email_preselect_ids", JSON.stringify(ids));
}

// Simulates arriving from Inventory "Send to newsletter" with a category preselected
// via the real sessionStorage hand-off, same shape as r246-harness's ?prefill=1.
if (params.get("cats") === "1") {
  sessionStorage.setItem("newsletter_preselect_categories", JSON.stringify(["shoes"]));
  sessionStorage.setItem("newsletter_prefill_content", JSON.stringify({
    subject: "New inventory — 1 lot", body: "Check out this new lot.",
  }));
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <EmailView />
  </div>,
);
