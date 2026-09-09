// DEV ONLY — fixture behind r181a-harness.html, throwaway for R-181a's Paid/
// Refunded/Net columns. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL
// SupplierDealsModal with a fixed `deals` prop (the same shape list_deals_for_supplier
// now returns), plus a mocked get_deal_flow for the row-expand drill-in.
import ReactDOM from "react-dom/client";
import SupplierDealsModal from "./components/SupplierDealsModal";
import "./index.css";

const SUPPLIER = {
  id: "s1", name: "Acme Wholesale", contact_name: null, email: null, phone: null,
  address: null, payment_method: null, payment_details: null, payment_terms: null,
  typical_lead_time: null, notes: null, created_at: "2026-07-01", updated_at: "2026-07-01",
  archived: false, total_paid: 0, deal_count: 0, last_deal_date: null, avg_deal_amount: 0,
  total_profit: 0, total_revenue: 0,
};

// d1: no refund — Refunded reads "—", Net === Paid. d2: a $1,000 client refund on a
// $6,000 total-supplier-payment deal where this supplier took $4,000 of it, so their
// apportioned share is $1,000 * 4000/6000 = $666.67.
const DEALS = [
  { id: "df1", completed_at: "2026-08-01", gross_revenue: 5000, net_profit: 900, stage: "complete",
    invoice_number: "INV-101", client_name: "Torres Co", supplier_amount: 3000, df_total: 3000, deal_refunded: 0 },
  { id: "df2", completed_at: "2026-08-10", gross_revenue: 8000, net_profit: 1200, stage: "complete",
    invoice_number: "INV-102", client_name: "Ortiz LLC", supplier_amount: 4000, df_total: 6000, deal_refunded: 1000 },
];

(window as unknown as { __FIXTURE: (cmd: string, args?: any) => unknown }).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "get_deal_flow":
      return { id: args?.id, stage: "complete", gross_revenue: 5000, net_profit: 900 };
    default:
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <SupplierDealsModal
      supplier={SUPPLIER as any}
      deals={DEALS}
      onClose={() => {}}
      onReload={async () => {}}
    />
  </div>,
);
