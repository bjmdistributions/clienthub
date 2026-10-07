import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, FileText, Paperclip, Plus, Truck, X } from "lucide-react";
import { api, type DealFlow, type DealLogisticsPay, type FreightBooking, type FreightPrefill, type FreightStop, type SupplierPayment } from "../lib/api";
import { fmtAmount, localDay, parseAmount, shippingChargedOf, shippingEstimateOf } from "../lib/format";
import { canPayCarriers, canRecordOn, laneEnds } from "../lib/logisticsCarriers";
import { PAID_BANNER, dealPaid as isDealPaid, isLiveTruck, isQuoteStage, loadNumber, paidMethodWord, pickupNumberUnconfirmed } from "../lib/logisticsLoad";
import { invoiceWasSent, loadProgress, withDealFacts } from "../lib/loadProgress";
import { useSessionMe } from "../lib/useSessionMe";
import StatusPill from "./StatusPill";
import { CarrierHost } from "./LogisticsCarriers";
import { MarkPaidSheet, type PayTarget } from "./LogisticsPayCarriers";
import { LoadTrackerCompact } from "./LoadTracker";
import { RateCard } from "./LogisticsRates";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";
import LogisticsBookingForm, {
  AccessorialsField, AmountNeededPill, EquipmentSelect, FileDrop, FreightStatusPill, PickupNumberPill, UrgentPill, blankStop, fileSize, fmtDay, isHot,
  needsAmount, timingLine, uploadFiles, useNetsyncApplied,
} from "./LogisticsBookingForm";

// R-400: the deal's Shipping step. Freight is its own leg of the deal, separate from what is
// owed to the supplier: the bookings the person doing logistics fills in are the truth, and a
// freight line typed on the deal only counts while the deal has no booking. Everything a booking
// holds is written through the server's Logistics routes; this step reads the local copy, which
// sync keeps current.

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const day = (v?: string | null) => (v || "").trim();
const fmtSigned = (n: number) => `${n < -0.005 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
      <span className="text-muted">{label}{sub ? <span className="block text-[11px] text-faint">{sub}</span> : null}</span>
      <span className="text-ink font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ── Send to logistics ─────────────────────────────────────────────────────
// A sheet prefilled from the deal: the buyer is where it goes, the supplier on the cost lines
// is where it comes from (one pick when several are owed). Everything can be changed before it
// is sent. R-415: while the team fills in the freight (the default), the pallets, weight and
// dimensions are filled in here, and the person doing logistics only books the truck.
// R-459: the first send is a request for a quote ("Ask for a quote"): logistics answers with a price, the
// team puts it on the invoice, and the load is sent to book from the load's page. R-464: every load starts
// as a quote, so this sheet has the one button, and the load page holds the gate to booking.
function SendSheet({ flow, billed, onClose, onSent }: { flow: DealFlow; billed: number | null; onClose: () => void; onSent: () => void }) {
  const [pre, setPre] = useState<FreightPrefill | null>(null);
  const [err, setErr] = useState("");
  const [pickup, setPickup] = useState({ name: "", address: "" });
  // R-452: more pickups on the same truck, one delivery.
  const [stops, setStops] = useState<FreightStop[]>([]);
  const [delivery, setDelivery] = useState({ name: "", address: "" });
  const [freight, setFreight] = useState({ pallets: "", pieces: "", weight_lbs: "", freight_class: "", dimensions: "", commodity: "", accessorials: "", equipment: "" });
  const [note, setNote] = useState("");
  // R-458: everything logistics needs in one send: how urgent, the day and the times, and the papers.
  const [urgent, setUrgent] = useState(false);
  const [when, setWhen] = useState({ date: "", window: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  // R-459: what the lane cost last time, once both addresses read as a place; a carrier name opens its card.
  const [carrierId, setCarrierId] = useState<string | null>(null);
  const lane = laneEnds(pickup.address, delivery.address);
  // Until the setting is read, the default (on) holds.
  const [byTeam, setByTeam] = useState(true);
  const setF = (patch: Partial<typeof freight>) => setFreight((f) => ({ ...f, ...patch }));
  useEffect(() => {
    let dead = false;
    api.logistics.settings.get().then((s) => { if (!dead) setByTeam(s.freight_by_team !== false); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    let dead = false;
    api.logistics.prefill(flow.id)
      .then((p) => {
        if (dead) return;
        setPre(p);
        setPickup({ name: p.pickup_name, address: p.pickup_address });
        setDelivery({ name: p.delivery_name, address: p.delivery_address });
      })
      .catch((e) => { if (!dead) { setErr(String(e)); setPre({ pickup_name: "", pickup_address: "", delivery_name: "", delivery_address: "", pickup_options: [] }); } });
    return () => { dead = true; };
  }, [flow.id]);

  const missing = byTeam && !(freight.pallets.trim() && freight.weight_lbs.trim() && freight.dimensions.trim());
  const send = async () => {
    if (missing) { setErr("Fill in the pallets, pallet dimensions and weight first."); return; }
    setBusy(true); setErr("");
    try {
      const made = await api.logistics.create(flow.id, {
        status: "quote" as const,
        urgent, pickup_date: when.date, pickup_window: when.window.trim(),
        pickup_name: pickup.name, pickup_address: pickup.address,
        extra_pickups: stops.map((x) => ({ ...x, name: x.name.trim(), address: x.address.trim(), window: x.window.trim() })).filter((x) => x.name || x.address),
        delivery_name: delivery.name, delivery_address: delivery.address,
        pallets: freight.pallets.trim(), pieces: freight.pieces.trim(), weight_lbs: freight.weight_lbs.trim(),
        freight_class: freight.freight_class.trim(), dimensions: freight.dimensions.trim(),
        commodity: freight.commodity.trim(), accessorials: freight.accessorials.trim(), equipment: freight.equipment,
        request_note: note.trim(),
      });
      // The booking exists now; a file that fails to upload says so and can be added on the booking.
      if (files.length) await uploadFiles(made.id, files);
      toast(urgent ? "Quote asked as urgent" : "Quote asked");
      onSent();
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const options = pre?.pickup_options ?? [];
  // A new pickup starts as the next supplier on the deal that is not already one, or blank.
  const addStop = () => {
    const used = [pickup.name, ...stops.map((x) => x.name)].map((n) => n.trim().toLowerCase());
    const next = options.find((o) => o.name && !used.includes(o.name.trim().toLowerCase()));
    setStops((l) => [...l, { ...blankStop(), name: next?.name ?? "", address: next?.address ?? "" }]);
  };
  const setStop = (i: number, patch: Partial<FreightStop>) => setStops((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Send to logistics"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ink">Send to logistics</h2>
            <p className="text-[12px] text-muted mt-0.5">
              {flow.invoice_number ? `${flow.invoice_number}. ` : ""}{byTeam ? "Fill in the freight and ask for a quote. You send it to book from the load once it is on the invoice and the customer has paid." : "Ask for a quote. Logistics fills in the rest."}
            </p>
          </div>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 flex-shrink-0"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {pre === null ? <div className="text-[12.5px] text-muted">Loading...</div> : (
            <>
              {billed != null && (
                <div className={`rounded-lg border px-3 py-2 text-[13px] ${billed > 0.005 ? "bg-surface-2 border-line" : "bg-warning-bg border-warning/30 text-warning-ink"}`}>
                  {billed > 0.005
                    ? <><span className="text-muted">Charged to the customer for shipping</span>{" "}<span className="font-semibold text-ink tabular-nums">{fmtAmount(billed)}</span></>
                    : "The invoice has no shipping line."}
                </div>
              )}
              <label className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${urgent ? "border-danger-ink/30 bg-danger-bg" : "border-line hover:bg-surface-2"}`}>
                <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="w-4 h-4 mt-0.5 accent-danger" />
                <span className="min-w-0">
                  <span className={`block text-[13px] font-medium ${urgent ? "text-danger-ink" : "text-ink"}`}>Urgent</span>
                  <span className="block text-[11.5px] text-muted">It goes to the top of their list in red, and they get a notice that says urgent.</span>
                </span>
              </label>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">When it needs picking up</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {([["Today", 0], ["Tomorrow", 1]] as const).map(([label, add]) => {
                    const d = new Date(); d.setDate(d.getDate() + add);
                    const v = localDay(d);
                    const on = when.date === v;
                    return (
                      <button key={label} type="button" aria-pressed={on} onClick={() => setWhen((w) => ({ ...w, date: on ? "" : v }))}
                        className={`h-8 px-3 rounded-lg border text-[12px] transition-colors ${on ? "border-accent bg-accent/10 text-accent font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                        {label}
                      </button>
                    );
                  })}
                  <input type="date" className={`${inp} w-auto`} aria-label="Pickup day" value={when.date} onChange={(e) => { const v = e.target.value; setWhen((w) => ({ ...w, date: v })); }} />
                </div>
                <div className="text-[11px] text-muted">Leave it empty and logistics sets the day. The day moves the deal's pickup date.</div>
              </div>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Pickup</div>
                {options.length > 1 && (
                  <select className={inp} aria-label="Pickup from"
                    value={options.findIndex((o) => o.name === pickup.name && o.address === pickup.address)}
                    onChange={(e) => { const o = options[Number(e.target.value)]; if (o) setPickup({ name: o.name, address: o.address }); }}>
                    {options.findIndex((o) => o.name === pickup.name && o.address === pickup.address) < 0 && <option value={-1}>Edited</option>}
                    {options.map((o, i) => <option key={i} value={i}>{o.name || o.address || "Pickup"}</option>)}
                  </select>
                )}
                <input className={inp} placeholder="Name" value={pickup.name} onChange={(e) => setPickup({ ...pickup, name: e.target.value })} />
                <input className={inp} placeholder="Address" value={pickup.address} onChange={(e) => setPickup({ ...pickup, address: e.target.value })} />
                <input className={inp} placeholder="Time, like before 4 pm" aria-label="Pickup time" value={when.window} onChange={(e) => { const v = e.target.value; setWhen((w) => ({ ...w, window: v })); }} />
              </div>
              {stops.map((x, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium text-ink-2">Pickup {i + 2}</div>
                    <button type="button" onClick={() => setStops((l) => l.filter((_, j) => j !== i))}
                      className="text-[11.5px] text-muted hover:text-danger-ink px-1.5 h-6 rounded-md hover:bg-danger-bg transition-colors">Remove</button>
                  </div>
                  <input className={inp} placeholder="Name" aria-label={`Pickup ${i + 2} name`} value={x.name} onChange={(e) => setStop(i, { name: e.target.value })} />
                  <input className={inp} placeholder="Address" aria-label={`Pickup ${i + 2} address`} value={x.address} onChange={(e) => setStop(i, { address: e.target.value })} />
                  <input className={inp} placeholder="Time, like before 4 pm" aria-label={`Pickup ${i + 2} time`} value={x.window} onChange={(e) => setStop(i, { window: e.target.value })} />
                </div>
              ))}
              {stops.length < 9 && (
                <button type="button" onClick={addStop}
                  className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink px-2.5 h-8 rounded-lg border border-line hover:bg-surface-2 transition-colors">
                  <Plus size={13} /> Add a pickup
                </button>
              )}
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Delivery</div>
                <input className={inp} placeholder="Name" value={delivery.name} onChange={(e) => setDelivery({ ...delivery, name: e.target.value })} />
                <input className={inp} placeholder="Address" value={delivery.address} onChange={(e) => setDelivery({ ...delivery, address: e.target.value })} />
              </div>
              {lane && <RateCard by={lane} onOpenCarrier={setCarrierId} />}
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Freight</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Pallets{byTeam ? " (required)" : ""}</label>
                    <NumberInput integer className={inp} value={freight.pallets} placeholder="How many" onValue={(_n, raw) => setF({ pallets: raw })} />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Pieces</label>
                    <NumberInput integer className={inp} value={freight.pieces} onValue={(_n, raw) => setF({ pieces: raw })} />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Weight (lbs){byTeam ? " (required)" : ""}</label>
                    <NumberInput className={inp} value={freight.weight_lbs} onValue={(_n, raw) => setF({ weight_lbs: raw })} />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Freight class</label>
                    <input className={inp} value={freight.freight_class} onChange={(e) => setF({ freight_class: e.target.value })} />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Pallet dimensions (L x W x H in){byTeam ? " (required)" : ""}</label>
                    <input className={inp} placeholder="48 x 40 x 60" value={freight.dimensions} onChange={(e) => setF({ dimensions: e.target.value })} />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Description of goods</label>
                    <input className={inp} value={freight.commodity} onChange={(e) => setF({ commodity: e.target.value })} />
                  </div>
                  <div className="min-w-0 col-span-2">
                    <label className="block text-[12px] text-muted mb-1">Equipment</label>
                    <EquipmentSelect value={freight.equipment} onChange={(v) => setF({ equipment: v })} />
                  </div>
                </div>
                <AccessorialsField value={freight.accessorials} onChange={(v) => setF({ accessorials: v })} />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-ink-2 mb-1">Note for logistics</label>
                <textarea
                  className="border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[72px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                  placeholder="Like: needs to go out today, call the dock first" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Files</div>
                {files.length > 0 && (
                  <div className="rounded-lg border border-line divide-y divide-line">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] min-w-0">
                        <FileText size={13} className="text-muted flex-shrink-0" />
                        <span className="truncate min-w-0 flex-1 text-ink">{f.name}</span>
                        <span className="text-[11px] text-muted flex-shrink-0">{fileSize(f.size)}</span>
                        <button type="button" onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} title="Take it off"
                          className="p-1 rounded-md text-muted hover:text-danger-ink hover:bg-danger-bg flex-shrink-0"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <FileDrop onFiles={(l) => setFiles((cur) => [...cur, ...l])} hint="Sent with the booking. Each file up to 15 MB." />
              </div>
            </>
          )}
        </div>
        {/* Outside the scrolling body, so a refusal is never hidden below the fields. */}
        {err && <div className="px-5 py-2 text-[12px] text-danger-ink border-t border-line" role="alert">{err}</div>}
        <div className="px-5 py-3 flex justify-end gap-2 border-t border-line">
          <button onClick={onClose} className="px-4 h-9 rounded-lg text-[13px] text-ink-2 hover:bg-surface-2">Cancel</button>
          <button onClick={send} disabled={busy || pre === null}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">
            {busy ? "Sending..." : "Ask for a quote"}
          </button>
        </div>
      </div>
    </div>
    {/* Beside the sheet, not inside it: a click on the card's backdrop must not close the sheet too. */}
    {carrierId && <CarrierHost id={carrierId} onClose={() => setCarrierId(null)} onChanged={() => {}} />}
    </>
  );
}

// ── Typed freight (R-401) ─────────────────────────────────────────────────
// A freight line typed on the deal is shipping, so it lives here and not among the supplier
// costs. It can be edited or removed, and it has no "paid" toggle: a supplier or a carrier is
// paid outside the deal, and the bank link is what ties the money to it.
function TypedFreightRow({ flow, p, struck, locked, onChanged }: {
  flow: DealFlow; p: SupplierPayment; struck: boolean; locked: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.supplier_name);
  const [amt, setAmt] = useState(String(p.amount));
  const [busy, setBusy] = useState(false);

  // A completed deal keeps its recorded figures in step with a changed cost line.
  const settle = async () => {
    if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch { /* the save already went through */ } }
    onChanged();
  };
  const save = async () => {
    const amount = parseAmount(amt);
    if (!name.trim()) { toast("Name who this freight went to", "error"); return; }
    if (!(amount > 0)) { toast("Add the amount for this freight", "error"); return; }
    setBusy(true);
    try {
      await api.updateSupplierPayment(flow.id, p.id, {
        supplier_name: name.trim(), supplier_id: p.supplier_id ?? null, amount,
        quantity: 1, unit_price: amount, method: p.method ?? null, notes: p.notes ?? null,
        category: "freight", supplier_billed: p.supplier_billed,
      });
      setEditing(false);
      await settle();
    } catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };
  const remove = async () => {
    if (!confirm(`Remove ${fmtAmount(p.amount)} of freight for ${p.supplier_name || "this line"}? It stops counting as this deal's shipping cost.`)) return;
    setBusy(true);
    try { await api.removeSupplierPayment(flow.id, p.id); await settle(); }
    catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };

  if (editing) {
    return (
      <div className="space-y-2 py-1">
        <input className={inp} aria-label="Paid to" placeholder="Who this went to" value={name} onChange={(e) => setName(e.target.value)} />
        <NumberInput className={inp} aria-label="Amount" placeholder="0.00" value={amt} onValue={(_n, raw) => setAmt(raw)} />
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} disabled={busy}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium disabled:opacity-40">
            <Check size={12} strokeWidth={2.5} /> Save
          </button>
          <button type="button" onClick={() => { setEditing(false); setName(p.supplier_name); setAmt(String(p.amount)); }}
            className="px-3 h-8 rounded-lg text-[12px] text-ink-2 hover:bg-surface-3">Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 text-[12.5px]">
      <div className="min-w-0">
        <div className={`truncate ${struck || p.kept ? "text-faint line-through" : "text-ink-2"}`}>{p.supplier_name || "Freight"}</div>
        {p.kept && <div className="text-[11px] text-muted">Kept: didn't pay, not counted</div>}
        {!locked && (
          <div className="flex items-center gap-2.5 mt-0.5">
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className="text-[11px] text-muted hover:text-ink-2 disabled:opacity-40">Edit</button>
            <button type="button" onClick={remove} disabled={busy} className="text-[11px] text-muted hover:text-danger-ink disabled:opacity-40">Remove</button>
          </div>
        )}
      </div>
      <span className={`tabular-nums flex-shrink-0 ${struck || p.kept ? "text-faint line-through" : "text-ink-2"}`}>{fmtAmount(p.amount)}</span>
    </div>
  );
}

const PAY_RULE_WORD: Record<string, string> = {
  share: "share of the shipping profit",
  loss_cover: "covering a load that lost money",
  loss_share: "share of the loss",
  markup: "markup on the freight",
};

// ── The step ──────────────────────────────────────────────────────────────
export default function DealShipping({ flow, onReload, locked, onAdvance, dealPaid }: {
  flow: DealFlow; onReload: () => void; locked: boolean; onAdvance?: () => void;
  /** R-459: whether the buyer has paid, as the deal card reads it (the stage and the bank link). */
  dealPaid?: boolean;
}) {
  const [bookings, setBookings] = useState<FreightBooking[]>([]);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<FreightBooking | null>(null);
  // R-401: what the invoice charged for shipping, and the logistics pay that comes of it.
  const [charged, setCharged] = useState<{ amount: number; source: "lines" | "field" | "none" }>({ amount: 0, source: "none" });
  const [chargedReady, setChargedReady] = useState(false);
  const [pay, setPay] = useState<DealLogisticsPay | null>(null);
  // R-464: whether the deal's invoice has gone out (the loads' tracker and the gate need it) and who may change a payment.
  const [invoiceSent, setInvoiceSent] = useState<boolean | undefined>(undefined);
  const [changing, setChanging] = useState<PayTarget | null>(null);
  const me = useSessionMe();
  const canPay = canPayCarriers(me);

  const loadBookings = useCallback(async () => {
    try { setBookings(await api.listFreightBookings(flow.id)); }
    catch (e) { console.error(e); }
    setReady(true);
  }, [flow.id]);
  useEffect(() => { loadBookings(); }, [loadBookings, flow.updated_at, flow.logistics_bookings, flow.logistics_paid]);
  useNetsyncApplied(loadBookings);

  useEffect(() => {
    let dead = false;
    api.getInvoice(flow.invoice_id)
      .then((inv) => { if (!dead) { setCharged(shippingChargedOf(inv.line_items_json, inv.shipping_charged)); setChargedReady(true); setInvoiceSent(invoiceWasSent(inv)); } })
      .catch(() => {});
    return () => { dead = true; };
  }, [flow.invoice_id]);
  // The pay line is worked out on the desktop by the same rule the server uses, so it moves as
  // soon as a booking or a bank link does.
  useEffect(() => {
    let dead = false;
    api.getDealLogisticsPay(flow.id).then((r) => { if (!dead) setPay(r); }).catch(() => { if (!dead) setPay(null); });
    return () => { dead = true; };
  }, [flow.id, flow.updated_at, flow.logistics_paid, flow.logistics_quoted, flow.logistics_bookings, flow.shipping_linked]);

  const refresh = () => { loadBookings(); onReload(); };

  // R-459: a quote is a load asked about, not a truck. It shows here with its stage and is never counted
  // as a truck (the money rows below come from the deal, which leaves quotes out the same way).
  const live = bookings.filter(isLiveTruck);
  // R-463: "Shipping paid" is the sum of these, so each one is listed where the sum is read.
  const paidLoads = live.filter((b) => b.paid_amount != null);
  const quotes = bookings.filter((b) => isQuoteStage(b.status));
  const cancelled = bookings.filter((b) => b.status === "cancelled");
  const typed = (flow.supplier_payments || []).filter((p) => p.category === "freight");
  const typedTotal = typed.filter((p) => !p.kept).reduce((s, p) => s + (p.amount || 0), 0);
  const mode = !!flow.shipping_mode;
  const paid = flow.logistics_paid ?? 0;
  const linked = flow.shipping_linked ?? 0;
  const quoted = flow.logistics_quoted ?? 0;
  const gap = Math.abs(paid - linked);
  const complete = flow.stage === "complete";

  // R-463: the payment on a load is fixed from where it was seen. The server's copy has the bank link, so it is asked for
  // first; the local copy is enough when the server cannot be reached.
  const startChange = async (b: FreightBooking) => {
    let src = b;
    try { src = await api.logistics.get(b.id); } catch { /* the local copy is enough */ }
    setChanging({
      bookingId: b.id, label: `${src.carrier || "Carrier"}, ${loadNumber(src)}`, rate: src.quoted_cost, payMethod: src.carrier_pay_method || "",
      paidAmount: src.paid_amount, bankLinked: src.bank_linked ?? "",
      current: { paid_amount: src.paid_amount, paid_at: src.paid_at, paid_method: src.paid_method, paid_note: src.paid_note },
    });
  };
  const changed = async (id: string) => {
    setChanging(null);
    // The list reads the local copy, which sync updates in a moment: put the server's answer in now so the row is right at once.
    try { const fresh = await api.logistics.get(id); setBookings((l) => l.map((x) => (x.id === id ? fresh : x))); } catch { /* sync brings it */ }
    refresh();
  };

  const addTruck = async () => {
    const from = live[live.length - 1] ?? bookings[bookings.length - 1];
    if (!from) return;
    try { await api.logistics.copy(from.id); toast("Another truck is on the list"); refresh(); }
    catch (e) { toast(String(e), "error"); }
  };

  // R-458: Shipping is the second step, so a deal with no truck to book answers it here too.
  const shipsDirect = async () => {
    try {
      await api.setDealFlowShipping(flow.id, day(flow.pickup_date) || null, day(flow.expected_delivery_date) || null, true);
      onReload();
    } catch (e) { toast(String(e), "error"); }
  };

  const undoDirect = async () => {
    try {
      await api.setDealFlowShipping(flow.id, day(flow.pickup_date) || null, day(flow.expected_delivery_date) || null, false);
      onReload();
    } catch (e) { toast(String(e), "error"); }
  };

  // The drawer needs the server's copy (the paperwork, BOLs and the paid flag are not in the local mirror).
  // It opens at once on the local one and swaps in the server's unless something was saved in between.
  const openBooking = (b: FreightBooking) => {
    setOpen(b);
    api.logistics.get(b.id).then((s) => setOpen((cur) => (cur === b ? s : cur))).catch(() => {});
  };

  const card = (b: FreightBooking) => {
    const quoteStage = isQuoteStage(b.status);
    const who = [b.carrier, b.broker && (b.carrier ? `via ${b.broker}` : b.broker)].filter(Boolean).join(" ");
    const refs = [b.bol && `BOL ${b.bol}`, b.pro && `PRO ${b.pro}`].filter(Boolean).join(", ");
    // R-458: the times the team set and the ETA logistics typed, in one line.
    const dates = timingLine(b);
    const nFiles = b.files?.length ?? 0;
    const money = [
      b.paid_amount != null && `Amount paid ${fmtAmount(b.paid_amount)}${b.paid_at ? ` on ${fmtDay(b.paid_at)}` : ""}${b.paid_method ? ` with ${paidMethodWord(b.paid_method)}` : ""}`,
      b.paid_amount == null && b.quoted_cost != null && `Carrier rate ${fmtAmount(b.quoted_cost)}`,
      b.status === "quoted" && b.quote_amount != null && `Quote ${fmtAmount(b.quote_amount)}, ${(b.quote_invoiced_at || "").trim() ? "on the invoice" : "not on the invoice yet"}`,
    ].filter(Boolean).join(", ");
    return (
      <button
        key={b.id} type="button" onClick={() => openBooking(b)}
        className={`w-full text-left bg-surface border border-line rounded-xl px-4 py-3 hover:border-accent/40 transition-colors min-w-0 ${b.status === "cancelled" ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-mono text-[12px] text-muted">{loadNumber(b)}</span>
          <FreightStatusPill status={b.status} />
          {isHot(b) && <UrgentPill />}
          {pickupNumberUnconfirmed(b, localDay()) && <PickupNumberPill />}
          {needsAmount(b) && <AmountNeededPill />}
          {who && <span className="text-[13px] font-medium text-ink truncate min-w-0">{who}</span>}
          {nFiles > 0 && <span className="ml-auto inline-flex items-center gap-0.5 text-[11.5px] text-muted"><Paperclip size={11} />{nFiles} {nFiles === 1 ? "file" : "files"}</span>}
        </div>
        {b.status !== "cancelled" && (
          <div className="mt-1.5"><LoadTrackerCompact stages={loadProgress(withDealFacts(b, { invoiceSent, dealPaid }), true)} /></div>
        )}
        {(refs || dates) && <div className="text-[12px] text-ink-2 mt-1">{[refs, dates].filter(Boolean).join(" · ")}</div>}
        {b.status === "requested" && !refs && !dates && <div className="text-[12px] text-muted mt-1">Waiting for logistics to book it.</div>}
        {b.status === "quote" && <div className="text-[12px] text-muted mt-1">Waiting for logistics to quote it.</div>}
        {quoteStage && isDealPaid(b, dealPaid) && <div className="text-[12px] text-success-ink mt-1">{PAID_BANNER}</div>}
        {money && <div className="text-[12px] text-ink-2 mt-0.5 tabular-nums">{money}</div>}
        {b.updated_by_name && <div className="text-[11px] text-muted mt-1">Updated by {b.updated_by_name} {fmtDay(b.updated_at)}</div>}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {flow.ships_direct ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface border border-line px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">This deal ships direct</div>
            <div className="text-[12px] text-muted mt-0.5">The supplier sends it, so there is no truck to book.</div>
          </div>
          <button type="button" onClick={undoDirect} disabled={locked}
            className="px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 disabled:opacity-50 whitespace-nowrap">
            Undo ships direct
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[12.5px] text-muted">
              {live.length === 0 && quotes.length === 0
                ? "Nothing sent to logistics yet."
                : [
                  live.length > 0 && `${live.length} ${live.length === 1 ? "truck" : "trucks"} with logistics.`,
                  quotes.length > 0 && `${quotes.length} ${quotes.length === 1 ? "quote" : "quotes"} with logistics.`,
                ].filter(Boolean).join(" ")}
            </div>
            <div className="flex items-center gap-2">
              {live.length > 0 && (
                <button type="button" onClick={addTruck}
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">
                  <Plus size={13} /> Add another truck
                </button>
              )}
              {live.length === 0 && quotes.length === 0 && !locked && (
                <button type="button" onClick={shipsDirect}
                  className="px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">
                  It ships direct
                </button>
              )}
              <button type="button" onClick={() => setSending(true)}
                className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium whitespace-nowrap">
                <Truck size={13} /> Send to logistics
              </button>
            </div>
          </div>

          {ready && (quotes.length > 0 || live.length > 0) && <div className="space-y-2">{[...quotes, ...live].map(card)}</div>}

          {(mode || paid > 0 || linked > 0 || quoted > 0 || charged.amount > 0.005) && (
            <div className="rounded-xl bg-surface border border-line px-4 py-3 space-y-1.5">
              {charged.amount > 0.005 && (
                <Row label="Charged to the customer for shipping" value={fmtAmount(pay?.charged ?? charged.amount)}
                  sub={(pay?.charged_source ?? charged.source) === "lines" ? "From the invoice's shipping line" : "From the invoice's shipping charge"} />
              )}
              <Row label="Shipping paid" value={fmtAmount(paid)} />
              {paidLoads.length > 0 && (
                <ul className="list-none m-0 pl-3 border-l-2 border-line space-y-1" aria-label="Shipping paid by load">
                  {paidLoads.map((b) => (
                    <li key={b.id} className="flex items-center gap-2 text-[12px] min-w-0">
                      <span className="min-w-0 flex-1 truncate text-ink-2">
                        <span className="font-mono text-muted">{loadNumber(b)}</span>{b.carrier ? `, ${b.carrier}` : ""}
                      </span>
                      <span className="tabular-nums text-ink flex-shrink-0">{fmtAmount(b.paid_amount ?? 0)}</span>
                      {canRecordOn(b, canPay) && (
                        <button type="button" onClick={() => startChange(b)}
                          className="text-[11.5px] text-accent font-medium hover:underline flex-shrink-0">Change</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {linked > 0.005 && (
                <Row
                  label="Linked from the bank"
                  value={fmtAmount(linked)}
                  sub={gap > 0.5 ? `${fmtAmount(gap)} ${linked > paid ? "more" : "less"} than the amount paid` : undefined}
                />
              )}
              {quoted > 0.005 && <Row label="Carrier rate, not paid yet" value={fmtAmount(quoted)} />}
              {charged.amount > 0.005 && (mode || linked > 0.005 || typedTotal > 0.005) && (
                // The surplus is known only once every live truck has its amount paid (R-415), as on the phone.
                (pay ? !pay.pending : (flow.logistics_unpaid ?? 0) === 0)
                  ? <Row label="Shipping profit" value={fmtSigned(pay ? pay.surplus : charged.amount - shippingEstimateOf(flow))} />
                  : <Row label="Shipping profit" value="Waiting on the amount paid" />
              )}
              {pay && (
                pay.rule === "tracked"
                  ? <Row label="Logistics pay" value="Tracked, not paid" sub={pay.markup != null ? `Markup of ${fmtAmount(pay.markup)}, shows in the Brief` : "The surplus shows in the Brief"} />
                : pay.pay == null
                  ? <Row label="Logistics pay" value="Waiting on the amount paid" />
                  : <Row label="Logistics pay" value={fmtAmount(pay.pay)}
                      sub={`${PAY_RULE_WORD[pay.rule] ?? pay.rule}${pay.due_date ? `, due ${fmtDay(pay.due_date)}` : ""}`} />
              )}
              {complete && flow.shipping_cost != null && <Row label="Recorded on the completed deal" value={fmtAmount(flow.shipping_cost)} />}
            </div>
          )}

          {ready && cancelled.length > 0 && (
            <div className="space-y-2">
              <div className="text-[12px] font-medium text-muted flex items-center gap-1.5">Cancelled <StatusPill tone="neutral">{cancelled.length}</StatusPill></div>
              {cancelled.map(card)}
            </div>
          )}
        </>
      )}

      {/* Typed freight stays reachable even when the deal ships direct. */}
      {typed.length > 0 && (
        <div className="rounded-xl bg-surface border border-line px-4 py-3 space-y-1.5">
          <div className="text-[12px] font-medium text-ink-2">
            {mode ? "Typed freight (replaced by the logistics booking)" : "Typed on the deal"}
          </div>
          {typed.map((p) => <TypedFreightRow key={p.id} flow={flow} p={p} struck={mode} locked={locked} onChanged={refresh} />)}
          {!mode && (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px] pt-1.5 border-t border-line">
              <span className="text-muted">Counts as the shipping cost</span>
              <span className="text-ink font-medium tabular-nums">{fmtAmount(typedTotal)}</span>
            </div>
          )}
        </div>
      )}

      {onAdvance && (
        <div className="flex items-center justify-end pt-1">
          <button type="button" onClick={onAdvance}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
            Continue to link financials <Check size={14} strokeWidth={2.5} />
          </button>
        </div>
      )}

      {sending && (
        <SendSheet flow={flow} billed={chargedReady ? ((flow.shipping_billed ?? 0) > 0 ? (flow.shipping_billed as number) : charged.amount) : null}
          onClose={() => setSending(false)} onSent={() => { setSending(false); refresh(); }} />
      )}
      {changing && <MarkPaidSheet target={changing} onClose={() => setChanging(null)} onDone={() => changed(changing.bookingId)} />}
      {open && (
        <LogisticsBookingForm
          booking={open}
          dealPaid={dealPaid}
          invoiceSent={invoiceSent}
          onClose={() => setOpen(null)}
          onSaved={(b) => { setOpen(b); refresh(); }}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
