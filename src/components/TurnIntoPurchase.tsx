// R-596: a deal flow that is only a purchase (no invoice to a buyer, no money from one) can become a purchase order. The server
// does it in one go: the supplier cost, units, shortage and refund owed carry over, the bank payments move onto the order, and the
// deal is archived with an Undo on the order. Shown only where it can work; the server says why when it cannot.
import { useState } from "react";
import { PackagePlus } from "lucide-react";
import { api, type DealFlow } from "../lib/api";
import { OPEN_BUY_KEY } from "../lib/buyLoads";
import { can, isAdmin } from "../lib/permissions";
import { useSessionMe } from "../lib/useSessionMe";
import { toast } from "./Toast";

/** The deal has no buyer side: no invoice and no money received. */
export const dealIsOnlyAPurchase = (f: DealFlow): boolean =>
  !f.invoice_number && !f.invoice_id && !(f.payment_received_amount > 0) && (f.supplier_payments || []).length > 0;

export default function TurnIntoPurchase({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const me = useSessionMe();
  const [busy, setBusy] = useState(false);
  if (!dealIsOnlyAPurchase(flow) || !(isAdmin(me) || (can(me, "deal_flow:edit") && can(me, "financials:edit")))) return null;
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(
      "Turn this deal into a purchase order?\n\n"
      + "Its supplier cost, units, shortage and refund owed move to a new order in Purchases, and its bank payments to the supplier move onto that order. "
      + "This deal is archived, not deleted, and the order has an Undo that puts everything back as it was.\n\n"
      + "It cannot be done if the deal has an invoice to a buyer or money from one.",
    )) return;
    setBusy(true);
    try {
      const buyId = await api.buyFromDeal(flow.id);
      try { localStorage.setItem(OPEN_BUY_KEY, buyId); } catch { /* ignore */ }
      toast("Turned into a purchase order.");
      onReload();
      window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "purchases" }));
    } catch (err) { toast(String(err), "error"); setBusy(false); }
  };
  return (
    <button onClick={go} disabled={busy} className="ui-btn ui-btn-sm !border-transparent text-muted hover:text-ink">
      <PackagePlus size={14} /> {busy ? "Turning into an order…" : "Turn into a purchase order"}
    </button>
  );
}
