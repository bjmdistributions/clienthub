import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, type FreightBooking } from "../lib/api";
import { localDay } from "../lib/format";
import { ADDRESS_HINT, addressNote } from "../lib/fullAddress";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";

// R-551: send a buy to logistics. The sheet a deal uses (DealShipping's SendSheet), for stock that is coming in to us: the
// pickup is the supplier and the delivery is our own warehouse, both prefilled and both changeable; the freight is filled in
// here while our side does that (R-415); and it asks how many trucks bring it in (1 to 6) and the day they deliver. Each truck
// is a quote of its own on the server. The server must know the buy first, so the buy is pushed and waited for before the
// trucks are asked for, and the ask is tried once more when the server says it has not got the buy yet.

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const NOT_YET = /that buy was not found/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function AddressNote({ value }: { value: string }) {
  const note = addressNote(value);
  return note ? <div className="text-[11px] text-muted">{note}</div> : null;
}

export default function BuySendSheet({ buy, live, onClose, onSent }: {
  buy: { id: string; name: string }; live: number; onClose: () => void; onSent: (made: FreightBooking[]) => void;
}) {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [trucks, setTrucks] = useState(1);
  const [day, setDay] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [pickup, setPickup] = useState({ name: "", address: "" });
  const [delivery, setDelivery] = useState({ name: "", address: "" });
  const [freight, setFreight] = useState({ pallets: "", weight_lbs: "", dimensions: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Until the setting is read, the default (on) holds.
  const [byTeam, setByTeam] = useState(true);
  const setF = (patch: Partial<typeof freight>) => setFreight((f) => ({ ...f, ...patch }));

  useEffect(() => {
    let dead = false;
    api.logistics.settings.get().then((s) => { if (!dead) setByTeam(s.freight_by_team !== false); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  // The buy may have been made a moment ago on this computer: push it, then ask the server where the trucks go.
  useEffect(() => {
    let dead = false;
    (async () => {
      await api.pushAndWait().catch(() => {});
      try {
        const p = await api.logistics.prefillBuy(buy.id);
        if (dead) return;
        setPickup({ name: p.pickup_name, address: p.pickup_address });
        setDelivery({ name: p.delivery_name, address: p.delivery_address });
      } catch (e) { if (!dead) setErr(String(e)); }
      if (!dead) setReady(true);
    })();
    return () => { dead = true; };
  }, [buy.id]);

  const missing = byTeam && !(freight.pallets.trim() && freight.weight_lbs.trim() && freight.dimensions.trim());
  const send = async () => {
    if (missing) { setErr("Fill in the pallets, pallet dimensions and weight first."); return; }
    setBusy(true); setErr("");
    const ask = () => api.logistics.createForBuy(buy.id, trucks, {
      urgent, delivery_date: day,
      pickup_name: pickup.name, pickup_address: pickup.address,
      delivery_name: delivery.name, delivery_address: delivery.address,
      pallets: freight.pallets.trim(), weight_lbs: freight.weight_lbs.trim(), dimensions: freight.dimensions.trim(),
      request_note: note.trim(),
    });
    try {
      await api.pushAndWait().catch(() => {});
      let r;
      try { r = await ask(); }
      catch (e) {
        if (!NOT_YET.test(String(e))) throw e;
        await sleep(2000);
        await api.pushAndWait().catch(() => {});
        r = await ask();
      }
      toast(r.bookings.length === 1 ? "Quote asked" : `Quotes asked for ${r.bookings.length} trucks`);
      onSent(r.bookings);
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const chip = (on: boolean) => `h-8 px-3 rounded-lg border text-[12px] transition-colors ${on ? "border-accent bg-accent/10 text-accent font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Send to logistics"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ink">Send to logistics</h2>
            <p className="text-[12px] text-muted mt-0.5">
              {buy.name}. {live > 0 ? "More trucks for this buy. " : ""}Logistics quotes each truck, and what it costs shows on the buy as soon as it is quoted.
            </p>
          </div>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 flex-shrink-0"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {!ready ? <div className="text-[12.5px] text-muted">Loading...</div> : (
            <>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">How many trucks</div>
                <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="How many trucks">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <button key={n} type="button" aria-pressed={trucks === n} onClick={() => setTrucks(n)} className={`${chip(trucks === n)} w-9 px-0`}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Deliver on</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {([["Today", 0], ["Tomorrow", 1]] as const).map(([label, add]) => {
                    const d = new Date(); d.setDate(d.getDate() + add);
                    const v = localDay(d);
                    return <button key={label} type="button" aria-pressed={day === v} onClick={() => setDay(day === v ? "" : v)} className={chip(day === v)}>{label}</button>;
                  })}
                  <input type="date" className={`${inp} w-auto`} aria-label="Delivery day" value={day} onChange={(e) => setDay(e.target.value)} />
                </div>
                <div className="text-[11px] text-muted">{trucks > 1 ? "All the trucks come this day, at different times." : "Leave it empty and logistics sets the day."}</div>
              </div>
              <label className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${urgent ? "border-danger-ink/30 bg-danger-bg" : "border-line hover:bg-surface-2"}`}>
                <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="w-4 h-4 mt-0.5 accent-danger" />
                <span className="min-w-0">
                  <span className={`block text-[13px] font-medium ${urgent ? "text-danger-ink" : "text-ink"}`}>Urgent</span>
                  <span className="block text-[11.5px] text-muted">It goes to the top of their list in red, and they get a notice that says urgent.</span>
                </span>
              </label>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Pickup</div>
                <input className={inp} placeholder="Name" aria-label="Pickup name" value={pickup.name} onChange={(e) => setPickup({ ...pickup, name: e.target.value })} />
                <textarea className={`${inp} h-auto py-2`} rows={2} placeholder={ADDRESS_HINT} aria-label="Pickup address" value={pickup.address} onChange={(e) => setPickup({ ...pickup, address: e.target.value })} />
                <AddressNote value={pickup.address} />
              </div>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Delivery</div>
                <input className={inp} placeholder="Name" aria-label="Delivery name" value={delivery.name} onChange={(e) => setDelivery({ ...delivery, name: e.target.value })} />
                <textarea className={`${inp} h-auto py-2`} rows={2} placeholder={ADDRESS_HINT} aria-label="Delivery address" value={delivery.address} onChange={(e) => setDelivery({ ...delivery, address: e.target.value })} />
                <AddressNote value={delivery.address} />
              </div>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Freight on each truck</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Pallets{byTeam ? " (required)" : ""}</label>
                    <NumberInput integer className={inp} value={freight.pallets} placeholder="How many" onValue={(_n, raw) => setF({ pallets: raw })} />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[12px] text-muted mb-1">Weight (lbs){byTeam ? " (required)" : ""}</label>
                    <NumberInput className={inp} value={freight.weight_lbs} onValue={(_n, raw) => setF({ weight_lbs: raw })} />
                  </div>
                  <div className="min-w-0 col-span-2">
                    <label className="block text-[12px] text-muted mb-1">Pallet dimensions (L x W x H in){byTeam ? " (required)" : ""}</label>
                    <input className={inp} placeholder="48 x 40 x 60" value={freight.dimensions} onChange={(e) => setF({ dimensions: e.target.value })} />
                  </div>
                </div>
                {trucks > 1 && <div className="text-[11px] text-muted">Each truck gets the pallets, weight and dimensions above. Your logistics person sets each truck's time.</div>}
              </div>
              <div>
                <label className="block text-[12px] font-medium text-ink-2 mb-1">Note for logistics</label>
                <textarea
                  className="border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[72px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                  placeholder="Like: call the dock first" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </>
          )}
        </div>
        {/* Outside the scrolling body, so a refusal is never hidden below the fields. */}
        {err && <div className="px-5 py-2 text-[12px] text-danger-ink border-t border-line" role="alert">{err}</div>}
        <div className="px-5 py-3 flex justify-end gap-2 border-t border-line">
          <button onClick={onClose} className="px-4 h-9 rounded-lg text-[13px] text-ink-2 hover:bg-surface-2">Cancel</button>
          <button onClick={send} disabled={busy || !ready}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">
            {busy ? "Sending..." : trucks > 1 ? `Ask for ${trucks} quotes` : "Ask for a quote"}
          </button>
        </div>
      </div>
    </div>
  );
}
