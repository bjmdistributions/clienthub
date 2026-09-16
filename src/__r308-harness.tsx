// DEV ONLY — the fixture behind r308-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL SettingsView for R-307 and R-308:
//   R-307 — `save_company_info` REJECTS here, exactly as it did on Jack's machine
//           (company_info.logo_path held the droplet's /home/ecliptr path). If any
//           section still autosaves the value it just loaded, the pill goes red on
//           arrival. It must not.
//   R-308 — the regrouped rail, the search box, and jumping to one setting.
// Every name and figure is invented.
import ReactDOM from "react-dom/client";
import SettingsView from "./components/SettingsView";
import "./index.css";

const CALLS: string[] = [];
(window as any).__CALLS = CALLS;

const COMPANY = {
  name: "Rivermount Trading",
  address: "44 Kelso Avenue, Unit 3",
  email: "hello@rivermount.example",
  phone: "5550142",
  tax_id: null,
  // The R-307 shape: a path from another device, which this one has never had.
  logo_path: "/home/ecliptr/sync/media/logos/org_default.png",
  show_company_name: false,
};

const TEMPLATE = {
  logo_placement: "left", logo_size: "medium", show_company_name: false,
  show_address: true, show_email: true, show_phone: true, show_tax_id: true,
  accent_color: "#111827", title_label: "INVOICE", footer_note: "",
};

// ?role=sales renders the non-admin Settings: three sections, and search must not
// return a result in any of the others.
const SALES = new URLSearchParams(location.search).get("role") === "sales";
const ME = SALES
  ? { id: "u2", email: "rep@rivermount.example", display_name: "Dana Reyes",
      role_id: "r2", role_name: "Sales", permissions: ["clients:view"], is_admin: false }
  : { id: "u1", email: "owner@rivermount.example", display_name: "Sam Okafor",
      role_id: "r1", role_name: "Owner", permissions: ["*"], is_admin: true };

const LISTS = new Set([
  "list_payment_methods", "list_line_item_templates", "list_categories", "list_custom_fields",
  "list_intake_sources", "list_email_inboxes", "list_follow_up_rules", "list_signup_rules",
  "list_staff", "list_roles", "list_invites", "list_payout_recipients", "list_backups",
  "list_captured_customers", "list_forms", "ollama_models", "list_sheet_sync_log",
]);

(window as any).__FIXTURE = (cmd: string) => {
  CALLS.push(cmd);
  // The live failure this harness exists to catch: a save that cannot succeed.
  if (cmd === "save_company_info") throw new Error("logo copy failed (simulated R-307)");
  switch (cmd) {
    case "get_company_info": return COMPANY;
    case "get_invoice_template": return TEMPLATE;
    case "get_quote_template": return { ...TEMPLATE, title_label: "QUOTE" };
    case "get_invoice_numbering_config": return { prefix: "INV-", next_number: 184, padding: 4, preview: "INV-0184" };
    case "get_quote_numbering_config": return { prefix: "QUO-", next_number: 61, padding: 4, preview: "QUO-0061" };
    case "get_organization_name": return "Rivermount Trading";
    case "plugin:app|version": return "0.16.71";
    case "get_whatsapp_settings":
      return { template: "New load just landed - {lots}", lot_format: "{title} - {units} units", footer: "Reply to claim.", phone: "5550142" };
    case "employee_me": return ME;
    case "get_whatsapp_description": return "";
    case "get_storefront_config":
      return { enabled: false, token: "sample-token", show_prices: true, show_logo: true,
               title: "Rivermount inventory", subtitle: "Updated weekly", contact_wa: "", contact_email: "",
               accent: "#FF6520", bg: "paper" };
    case "get_email_settings":
      return { smtp_host: "smtp.example.com", smtp_port: 587, imap_host: "imap.example.com", imap_port: 993,
               user: "sales@rivermount.example", auth_method: "password", from_email: "sales@rivermount.example",
               from_invoices: "billing@rivermount.example" };
    case "get_email_use_org_default": return true;
    case "google_email_status": return { connected: false, email: "", scopes: "" };
    case "get_email_inboxes": return [];
    case "get_policy_clause_settings":
      return { notice_24h_enabled: true, notice_24h_text: "We give 24 hours' notice before a pickup.",
               return_policy_enabled: false, return_policy_text: "" };
    case "get_newsletter_product_template":
      return { intro: "Hi {first_name}, this week's list:", outro: "Reply to claim anything here.",
               lot_format: "{title} — {units} units at {price_per_unit}" };
    // list_roles answers with an object, not a list — the one command whose name
    // lies about its shape.
    case "list_roles":
      return { roles: [
        { id: "r1", name: "Owner", permissions: ["*"], builtin: true },
        { id: "r2", name: "Sales", permissions: ["clients:view", "invoices:view"], builtin: false },
      ] };
    case "get_sync_status":
      return { connected: false, auth: null, last_pull_at: null, last_push_at: null, pending: 0 };
    // Everything else: a list for a list, an empty record for a getter. The real
    // commands never hand these components null, and a null here just blanks the
    // section with a TypeError, which tells us nothing about the screen.
    default:
      if (LISTS.has(cmd) || cmd.startsWith("list_")) return [];
      if (/_(log|logs|history|rules|models|backups|sources|fields|inboxes|methods|recipients|pages|contacts)$/.test(cmd)) return [];
      return cmd.startsWith("get_") ? {} : null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen p-6">
    <SettingsView me={ME as any} />
  </div>,
);
