// R-347/R-348: the pallets of each order. What is on each pallet, its 4 × 6 label with a QR code
// that opens its manifest, its picture, combining pallets, and the order's passcode. Pallets are
// added by hand ("12 pallets like this") or arrive from Build this lot when its invoice is made.

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, Layers, Plus, Printer, Trash2, X } from "lucide-react";
import { api, type Client, type Invoice } from "../lib/api";
import { byOrder, manifestUrl, palletBoxes, palletUnits, type NewPallet, type PalletLine, type WarehousePallet } from "../lib/palletFit";
import type { WarehouseItem } from "../lib/warehouse";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, rgba, teamColor } from "./warehouseUi";

const PalletView3D = lazy(() => import("./PalletView3D"));

/** `was`: the line as the pallet already has it, so a team or size since removed from the product keeps its name. */
type Row = { section_id: string; type_id: string; boxes: number; was?: PalletLine };
const toLines = (item: WarehouseItem, rows: Row[]): PalletLine[] => rows.filter((r) => r.section_id && r.type_id && r.boxes > 0).map((r) => {
  const s = item.sections.find((x) => x.id === r.section_id), t = item.box_types.find((x) => x.id === r.type_id);
  const was = r.was && r.was.section_id === r.section_id && r.was.type_id === r.type_id ? r.was : undefined;
  return { section_id: r.section_id, name: s?.name ?? was?.name ?? "", type_id: r.type_id, type_name: t?.name ?? was?.type_name ?? "", per_box: t?.per_box ?? was?.per_box ?? 0, boxes: r.boxes };
});

/** The boxes on one pallet: a row per team and size. */
function LinesEditor({ item, rows, onChange }: { item: WarehouseItem; rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_88px_32px] gap-2 items-center">
          <select value={r.section_id} onChange={(e) => set(i, { section_id: e.target.value })} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Team">
            <option value="">{item.section_label || "Team"}…</option>
            {item.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {r.was && r.section_id === r.was.section_id && !item.sections.some((s) => s.id === r.section_id) && <option value={r.section_id}>{r.was.name}</option>}
          </select>
          <select value={r.type_id} onChange={(e) => set(i, { type_id: e.target.value })} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Box size">
            {item.box_types.map((t) => <option key={t.id} value={t.id}>{t.name} of {t.per_box}</option>)}
            {r.was && r.type_id === r.was.type_id && !item.box_types.some((t) => t.id === r.type_id) && <option value={r.type_id}>{r.was.type_name} of {r.was.per_box}</option>}
          </select>
          <input type="text" inputMode="numeric" value={r.boxes || ""} placeholder="Boxes" aria-label="Boxes"
            onChange={(e) => set(i, { boxes: Math.max(0, Math.floor(Number(e.target.value.replace(/[^\d]/g, "")) || 0)) })}
            style={WH_INPUT_BG} className={`${WH_INPUT} tabular-nums`} />
          <button onClick={() => onChange(rows.filter((_, k) => k !== i))} disabled={rows.length === 1} className="h-9 grid place-items-center text-muted hover:text-ink-2 disabled:opacity-30" aria-label="Remove this row"><X size={14} /></button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { section_id: "", type_id: item.box_types[0]?.id ?? "", boxes: 0 }])} className="text-[12.5px] text-accent hover:underline">Add another {(item.section_label || "team").toLowerCase()} or size</button>
    </div>
  );
}

type Kind = { rows: Row[]; copies: number };
const blankKind = (item?: WarehouseItem): Kind => ({ rows: [{ section_id: "", type_id: item?.box_types[0]?.id ?? "", boxes: 0 }], copies: 1 });

/** Add pallets to an order: each kind of pallet with "how many like this". */
function AddPallets({ items, invoiceId: fixedInvoice, onDone, onCancel }: { items: WarehouseItem[]; invoiceId?: string; onDone: (ps: WarehousePallet[], added: number) => void; onCancel: () => void }) {
  const live = items.filter((i) => !i.archived && i.box_types.length);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [invoiceId, setInvoiceId] = useState(fixedInvoice ?? "");
  const [q, setQ] = useState("");
  const [itemId, setItemId] = useState(live[0]?.id ?? "");
  const item = live.find((i) => i.id === itemId);
  const [kinds, setKinds] = useState<Kind[]>([blankKind(live[0])]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    Promise.all([api.listInvoices(), api.listClients()]).then(([inv, cl]) => { setInvoices(inv); setClients(cl); }).catch((e) => setErr(String(e)));
  }, []);
  const clientOf = (id: string) => clients.find((c) => c.id === id)?.name ?? "";
  const shown = useMemo(() => (invoices || []).filter((i) => !i.voided && !(i as { archived?: boolean }).archived)
    .filter((i) => !q.trim() || `${i.number} ${clientOf(i.client_id)}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.issue_date.localeCompare(a.issue_date) || b.number.localeCompare(a.number)).slice(0, 200),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [invoices, q, clients]);
  const pallets = kinds.reduce((a, k) => a + k.copies, 0);
  const boxes = kinds.reduce((a, k) => a + k.copies * k.rows.reduce((x, r) => x + (r.section_id ? r.boxes : 0), 0), 0);
  const save = async () => {
    if (!item) return;
    setErr("");
    if (!invoiceId) { setErr("Choose the order these pallets belong to."); return; }
    // A kind set to 0 pallets is left out, so what is made is what the button says.
    const payload: NewPallet[] = kinds.filter((k) => k.copies > 0).map((k) => ({ lines: toLines(item, k.rows), copies: k.copies }));
    if (payload.some((p) => !p.lines.length)) { setErr("Every pallet needs at least one team, size and number of boxes."); return; }
    setBusy(true);
    try { onDone(await api.addWarehousePallets(invoiceId, item.id, payload), pallets); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  if (!live.length) return <div className={`${WH_CARD} p-5 text-[13px] text-muted`}>Add a product with its box sizes first.</div>;
  return (
    <div className={`${WH_CARD} p-5 space-y-4`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[14px] font-semibold text-ink">Add pallets to an order</div>
        <button onClick={onCancel} className="text-[12px] text-muted hover:text-ink-2">Cancel</button>
      </div>
      {!fixedInvoice && (
        <div>
          <label className="block text-[12px] text-muted mb-1.5">Order</label>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an invoice or customer" style={WH_INPUT_BG} className={WH_INPUT} />
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Order">
              <option value="">{invoices === null ? "Loading invoices…" : shown.length ? "Choose the invoice…" : "No invoice matches"}</option>
              {shown.map((i) => <option key={i.id} value={i.id}>{i.number}{clientOf(i.client_id) ? ` · ${clientOf(i.client_id)}` : ""} · {i.issue_date}</option>)}
            </select>
          </div>
        </div>
      )}
      {live.length > 1 && (
        <div>
          <label className="block text-[12px] text-muted mb-1.5">Product</label>
          <select value={itemId} onChange={(e) => { setItemId(e.target.value); setKinds([blankKind(live.find((i) => i.id === e.target.value))]); }} style={WH_INPUT_BG} className={WH_INPUT}>
            {live.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
      )}
      {item && kinds.map((k, ki) => (
        <div key={ki} className="rounded-lg border border-line p-3 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[13px] font-medium text-ink">{kinds.length > 1 ? `Pallet kind ${ki + 1}` : "Each pallet holds"}</div>
            <div className="flex items-center gap-2">
              <label className="text-[12.5px] text-ink-2">Pallets like this</label>
              <input type="text" inputMode="numeric" value={k.copies || ""} aria-label="Pallets like this"
                onChange={(e) => setKinds(kinds.map((x, i) => (i === ki ? { ...x, copies: Math.max(0, Math.min(200, Math.floor(Number(e.target.value.replace(/[^\d]/g, "")) || 0))) } : x)))}
                style={WH_INPUT_BG} className="w-16 border border-line h-8 rounded-lg text-center text-[13px] tabular-nums text-ink" />
              {kinds.length > 1 && <button onClick={() => setKinds(kinds.filter((_, i) => i !== ki))} className="text-muted hover:text-ink-2" aria-label="Remove this kind"><X size={14} /></button>}
            </div>
          </div>
          <LinesEditor item={item} rows={k.rows} onChange={(rows) => setKinds(kinds.map((x, i) => (i === ki ? { ...x, rows } : x)))} />
        </div>
      ))}
      <button onClick={() => setKinds([...kinds, blankKind(item)])} className={WH_BTN_SECONDARY}><Plus size={13} /> A different pallet</button>
      {err && <p className="text-[12.5px] text-danger-ink">{err}</p>}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={save} disabled={busy || !pallets} className={WH_BTN_PRIMARY}>{busy ? "Fitting…" : `Add ${n0(pallets)} ${pallets === 1 ? "pallet" : "pallets"}`}</button>
        <span className="text-[12.5px] text-muted tabular-nums">{n0(boxes)} boxes in all. Each is fitted and pictured when the product is measured.</span>
      </div>
    </div>
  );
}

export default function WarehouseOrders({ items }: { items: WarehouseItem[] }) {
  const [pallets, setPallets] = useState<WarehousePallet[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // "" = any order, or an invoice id
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shown3d, setShown3d] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; rows: Row[] } | null>(null);
  const [codeFor, setCodeFor] = useState<{ invoice: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.listWarehousePallets().then(setPallets).catch((e) => toast(String(e), "error"));
  useEffect(() => {
    load();
    const un = listen("netsync-applied", () => load());
    return () => { un.then((f) => f()); };
  }, []);
  const orders = useMemo(() => byOrder(pallets || []), [pallets]);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const replaceOrder = (invoiceId: string, ps: WarehousePallet[]) =>
    setPallets((cur) => [...(cur || []).filter((p) => p.invoice_id !== invoiceId), ...ps]);
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } catch (e) { toast(String(e), "error"); } finally { setBusy(false); } };

  const print = (ids: string[]) => run(async () => { await api.warehousePalletLabels(ids); toast(`${ids.length === 1 ? "The label" : `${ids.length} labels`} opened as a PDF — print on 4 × 6.`); });
  const combine = (invoiceId: string, ids: string[]) => run(async () => {
    replaceOrder(invoiceId, await api.combineWarehousePallets(ids));
    setPicked(new Set());
    toast(`Combined into one pallet — the order is renumbered.`);
  });
  const remove = (p: WarehousePallet) => run(async () => { replaceOrder(p.invoice_id, await api.removeWarehousePallet(p.id)); toast(`Pallet ${p.number} taken off the order.`); });
  const saveEdit = (p: WarehousePallet, item: WarehouseItem) => editing && run(async () => {
    const lines = toLines(item, editing.rows);
    if (!lines.length) throw new Error("A pallet needs at least one box — remove it instead.");
    const np = await api.updateWarehousePallet(p.id, lines);
    setPallets((cur) => (cur || []).map((x) => (x.id === np.id ? np : x)));
    setEditing(null);
  });
  const savePasscode = (invoiceId: string, code: string) => run(async () => {
    replaceOrder(invoiceId, await api.setOrderPasscode(invoiceId, code));
    setCodeFor(null);
    toast(code.trim() ? "Passcode set — send it to your customer with the order." : "Passcode removed — anyone with a label can open it.");
  });
  const copy = (text: string, what: string) => { navigator.clipboard.writeText(text).then(() => toast(`${what} copied`)).catch(() => toast(text)); };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-[12.5px] text-ink-2 max-w-[720px]">Every pallet you ship, on its order: what is on it, a 4 × 6 label with a QR code (scanning it opens this pallet's manifest), and its picture. Add them by hand, or make the invoice from <span className="font-medium">Build this lot</span> and they land here.</p>
        {adding === null && <button onClick={() => setAdding("")} className={WH_BTN_PRIMARY}><Plus size={14} /> Add pallets</button>}
      </div>
      {adding !== null && (
        <AddPallets items={items} invoiceId={adding || undefined} onCancel={() => setAdding(null)}
          onDone={(ps, added) => { if (ps[0]) replaceOrder(ps[0].invoice_id, ps); setAdding(null); toast(`${added} ${added === 1 ? "pallet" : "pallets"} added to order ${ps[0]?.invoice_number ?? ""}, ${ps.length} on it now. Print their labels below.`); }} />
      )}
      {pallets === null ? <div className="h-[120px] bg-surface-2 rounded-xl animate-pulse" />
        : !orders.length ? (
          <div className={`${WH_CARD} px-6 py-10 text-center border-dashed`}>
            <div className="text-[14px] font-semibold text-ink">No pallets yet</div>
            <p className="text-[12.5px] text-muted mt-1 max-w-[520px] mx-auto">Add the pallets of an order — for 288 boxes on 12 pallets, say what one pallet holds and "12 like this". Each gets a label to print and a link its QR code opens.</p>
          </div>
        ) : orders.map((o) => {
          const item = itemOf(o.item_id);
          const boxes = o.pallets.reduce((a, p) => a + palletBoxes(p), 0), units = o.pallets.reduce((a, p) => a + palletUnits(p), 0);
          const sel = o.pallets.filter((p) => picked.has(p.id));
          const code = o.pallets[0]?.passcode ?? "";
          return (
            <div key={o.invoice_id} className={`${WH_CARD} overflow-hidden`}>
              <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-ink">{o.invoice_number ? `Order ${o.invoice_number}` : "Order"}{o.client_name ? <span className="font-normal text-ink-2"> · {o.client_name}</span> : null}</div>
                  <div className="text-[12.5px] text-muted mt-0.5 tabular-nums">{o.pallets.length} {o.pallets.length === 1 ? "pallet" : "pallets"} · {n0(boxes)} boxes · {n0(units)} units{item ? ` · ${item.name}` : ""}</div>
                  <div className="text-[12px] mt-1">{code
                    ? <span className="text-ink-2">Passcode <span className="font-medium text-ink">{code}</span> — send it to your customer. <button onClick={() => copy(code, "Passcode")} className="text-accent hover:underline">Copy</button></span>
                    : <span className="text-muted">No passcode — anyone with a label can open it.</span>}</div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => print(o.pallets.map((p) => p.id))} disabled={busy} className={WH_BTN_PRIMARY}><Printer size={14} /> Print all labels</button>
                  <button onClick={() => setCodeFor({ invoice: o.invoice_id, code })} className={WH_BTN_SECONDARY}>{code ? "Change passcode" : "Add a passcode"}</button>
                  <button onClick={() => setAdding(o.invoice_id)} className={WH_BTN_SECONDARY}><Plus size={13} /> Pallets</button>
                </div>
              </div>
              {codeFor?.invoice === o.invoice_id && (
                <div className="mx-5 mb-3 p-3 rounded-lg bg-surface-2 border border-line flex items-center gap-2 flex-wrap">
                  <input value={codeFor.code} onChange={(e) => setCodeFor({ ...codeFor, code: e.target.value })} placeholder="e.g. harbour7" style={WH_INPUT_BG} className={`${WH_INPUT} max-w-[220px]`} aria-label="Passcode" autoFocus />
                  <button onClick={() => savePasscode(o.invoice_id, codeFor.code)} disabled={busy} className={WH_BTN_PRIMARY}>Save</button>
                  {code && <button onClick={() => savePasscode(o.invoice_id, "")} disabled={busy} className={WH_BTN_SECONDARY}>Remove the passcode</button>}
                  <button onClick={() => setCodeFor(null)} className="text-[12px] text-muted hover:text-ink-2">Cancel</button>
                  <span className="text-[11.5px] text-muted w-full">Whoever scans a label types it once to see that pallet and the rest of the order.</span>
                </div>
              )}
              {sel.length >= 2 && (
                <div className="mx-5 mb-3 flex items-center gap-2 flex-wrap text-[12.5px] text-ink-2">
                  <button onClick={() => combine(o.invoice_id, sel.map((p) => p.id))} disabled={busy} className={WH_BTN_PRIMARY}><Layers size={14} /> Combine {sel.length} pallets into one</button>
                  <span className="text-muted">{n0(sel.reduce((a, p) => a + palletBoxes(p), 0))} boxes — the fitter checks they go on one pallet first.</span>
                  <button onClick={() => setPicked(new Set())} className="text-[12px] text-muted hover:text-ink-2">Clear</button>
                </div>
              )}
              <div className="border-t border-line grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-px bg-line">
                {o.pallets.map((p) => {
                  const on = picked.has(p.id);
                  return (
                    <div key={p.id} className={`bg-surface p-4 min-w-0 ${shown3d === p.id || editing?.id === p.id ? "xl:col-span-2 2xl:col-span-3" : ""}`}>
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex items-center gap-2 cursor-pointer min-w-0">
                          <input type="checkbox" checked={on} onChange={() => setPicked((s) => { const n = new Set(s); if (on) n.delete(p.id); else n.add(p.id); return n; })} className="accent-[rgb(var(--c-accent))]" aria-label={`Choose pallet ${p.number} to combine`} />
                          <span className="text-[14px] font-semibold text-ink">Pallet {p.number}</span>
                          <span className="text-[12px] text-muted tabular-nums">{n0(palletBoxes(p))} boxes · {n0(palletUnits(p))} units{p.plan ? ` · ${Math.round(p.plan.pallet.total_height * 10) / 10} in` : ""}</span>
                        </label>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => print([p.id])} disabled={busy} className="p-1.5 text-muted hover:text-ink-2" title="Print its label" aria-label={`Print pallet ${p.number}'s label`}><Printer size={14} /></button>
                          <button onClick={() => copy(manifestUrl(p.token), "Manifest link")} className="p-1.5 text-muted hover:text-ink-2" title="Copy its manifest link" aria-label="Copy the manifest link"><Copy size={14} /></button>
                          <button onClick={() => remove(p)} disabled={busy} className="p-1.5 text-muted hover:text-danger-ink" title="Take it off the order" aria-label={`Remove pallet ${p.number}`}><Trash2 size={14} /></button>
                        </div>
                      </div>
                      <ul className="mt-2 space-y-0.5">
                        {p.lines.map((l, i) => (
                          <li key={i} className="flex items-center gap-2 text-[12.5px] text-ink-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-[3px] flex-shrink-0" style={{ background: rgba(teamColor(`s:${p.item_id}:${l.section_id}`), 0.9) }} />
                            <span className="truncate"><span className="text-ink font-medium">{l.name}</span> · {l.type_name} of {l.per_box}</span>
                            <span className="ml-auto tabular-nums text-ink">{n0(l.boxes)}</span>
                          </li>
                        ))}
                      </ul>
                      {p.notes && <p className="text-[12px] text-muted mt-1">{p.notes}</p>}
                      <div className="flex items-center gap-3 mt-2 text-[12.5px]">
                        <button onClick={() => setShown3d(shown3d === p.id ? null : p.id)} className="text-accent hover:underline">{shown3d === p.id ? "Hide the picture" : "See it in 3D"}</button>
                        {item && <button onClick={() => setEditing(editing?.id === p.id ? null : { id: p.id, rows: p.lines.map((l) => ({ section_id: l.section_id, type_id: l.type_id, boxes: l.boxes, was: l })) })} className="text-muted hover:text-ink-2">{editing?.id === p.id ? "Cancel" : "Change what is on it"}</button>}
                      </div>
                      {editing?.id === p.id && item && (
                        <div className="mt-3 space-y-3">
                          <LinesEditor item={item} rows={editing.rows} onChange={(rows) => setEditing({ id: p.id, rows })} />
                          <button onClick={() => saveEdit(p, item)} disabled={busy} className={WH_BTN_PRIMARY}><Check size={14} /> Save the pallet</button>
                        </div>
                      )}
                      {shown3d === p.id && (
                        <div className="mt-3">
                          {p.plan ? (
                            <Suspense fallback={<div className="h-[340px] rounded-lg border border-line grid place-items-center text-[12px] text-muted">Drawing the pallet…</div>}>
                              <PalletView3D pallet={p.plan.pallet} spec={p.plan.spec} colorOf={(sid) => teamColor(`s:${p.item_id}:${sid}`)}
                                labelOf={(sid) => p.lines.find((l) => l.section_id === sid)?.name ?? ""} typeName={(tid) => p.lines.find((l) => l.type_id === tid)?.type_name ?? "Box"} />
                            </Suspense>
                          ) : <p className="text-[12.5px] text-muted">No picture yet: measure the pallet and the box sizes on the product's Measurements tab, then change the pallet (or add it again) to have it fitted.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
    </div>
  );
}
