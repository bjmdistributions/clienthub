import { useEffect, useState } from "react";
import { api, Deal, DealInput, Client, LineItem, DealCostItem, SupplierNameSuggestion } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Plus, X, Briefcase, GripVertical, Check, Trash2, DollarSign, TrendingUp, FileDown,
} from "lucide-react";

const STAGES = ["lead", "quoted", "negotiating", "won", "lost"] as const;
type Stage = typeof STAGES[number];

const stageLabel = (s: Stage): string => {
  const m: Record<Stage, string> = { lead: "Lead", quoted: "Quoted", negotiating: "Negotiating", won: "Won", lost: "Lost" };
  return m[s];
};

const stageColor = (s: Stage): string => {
  const m: Record<Stage, string> = { lead: "bg-surface-3 text-ink-2", quoted: "bg-info-bg text-info-ink", negotiating: "bg-warning-bg text-warning-ink", won: "bg-success-bg text-success-ink", lost: "bg-danger-bg text-danger-ink" };
  return m[s];
};

export default function DealsView() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [editingDeal, setEditingDeal] = useState<DealInput | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showLost, setShowLost] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [showLostReason, setShowLostReason] = useState(false);
  const [dragDealId, setDragDealId] = useState<string | null>(null);

  const load = async () => {
    setDeals(await api.listDeals());
    setClients(await api.listClients());
  };
  useEffect(() => { load(); }, []);

  const dealsByStage = (s: Stage) => deals.filter((d) => d.stage === s);

  const startDrag = (e: React.DragEvent, id: string) => {
    setDragDealId(id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDrop = async (e: React.DragEvent, targetStage: Stage) => {
    e.preventDefault();
    const id = dragDealId;
    setDragDealId(null);
    if (!id) return;
    const deal = deals.find((d) => d.id === id);
    if (!deal || deal.stage === targetStage) return;

    if (targetStage === "lost") {
      setSelectedDeal(deal);
      setLostReason("");
      setShowLostReason(true);
    } else if (targetStage === "won") {
      if (confirm("Won this deal? Convert to invoice now?")) {
        await api.updateDealStage(id, "won");
        try { await api.convertDealToInvoice(id); } catch (e: any) { alert(e); }
        load();
      }
    } else {
      await api.updateDealStage(id, targetStage);
      load();
    }
  };

  const saveLost = async () => {
    if (!selectedDeal || !lostReason.trim()) return;
    await api.updateDealStage(selectedDeal.id, "lost", lostReason);
    setSelectedDeal(null);
    setLostReason("");
    setShowLostReason(false);
    load();
  };

  const handleSave = async (input: DealInput) => {
    if (selectedDeal && selectedDeal.id) {
      await api.updateDeal(selectedDeal.id, input);
    } else {
      await api.createDeal(input);
    }
    setShowForm(false);
    setSelectedDeal(null);
    setEditingDeal(null);
    load();
  };

  const openDetail = (deal: Deal) => {
    setSelectedDeal(deal);
    const items: DealInput = {
      client_id: deal.client_id,
      title: deal.title,
      stage: deal.stage,
      line_items: JSON.parse(deal.line_items_json || "[]"),
      supplier_costs: JSON.parse(deal.supplier_costs_json || "[]"),
      shipping_cost: deal.shipping_cost,
      other_costs: deal.other_costs,
      asking_price: deal.asking_price,
      payment_terms: deal.payment_terms,
      notes: deal.notes,
      expected_close_date: deal.expected_close_date,
    };
    setEditingDeal(items);
    setShowForm(true);
  };

  const totalCosts = (dl: Deal | DealInput) => {
    const costs: number[] = [];
    if ("supplier_costs_json" in dl) {
      const sc: DealCostItem[] = JSON.parse(dl.supplier_costs_json || "[]");
      sc.forEach((c) => costs.push(c.amount));
    } else {
      dl.supplier_costs.forEach((c) => costs.push(c.amount));
    }
    return costs.reduce((s, c) => s + c, 0) + (dl.shipping_cost || 0) + (dl.other_costs || 0);
  };

  const marginPct = (dl: Deal | DealInput) => {
    const rev = dl.asking_price || 0;
    if (!rev) return 0;
    return ((rev - totalCosts(dl)) / rev) * 100;
  };

  const marginColor = (pct: number) =>
    pct >= 20 ? "text-success-ink bg-success-bg" : pct >= 10 ? "text-warning-ink bg-warning-bg" : "text-danger-ink bg-danger-bg";

  const handleExportDeals = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "deals.csv" });
    if (!path) return;
    const count = await api.exportDealsCsv(path as string);
    alert(`Exported ${count} deals to CSV.`);
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-[18px] font-semibold text-ink">Deals</h2>
        <button onClick={() => {
          setSelectedDeal(null);
          setEditingDeal({
            client_id: clients[0]?.id ?? "",
            title: "",
            line_items: [{ description: "", qty: 1, rate: 0, amount: 0 }],
            supplier_costs: [],
            shipping_cost: 0, other_costs: 0, asking_price: 0,
          });
          setShowForm(true);
        }}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[14px] font-medium transition-colors">
          <Plus size={16} /> New Deal
        </button>
        <button onClick={handleExportDeals}
          className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2 transition-colors">
          <FileDown size={13} /> Export CSV
        </button>
      </div>

      {/* Lost reason modal */}
      {showLostReason && selectedDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => { setShowLostReason(false); setSelectedDeal(null); }}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-surface rounded-xl p-6 shadow-xl w-[400px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[16px] font-semibold text-ink mb-1">Lost Deal</h3>
            <p className="text-[13px] text-muted mb-4">Why was "{selectedDeal?.title}" lost?</p>
            <textarea
              autoFocus
              rows={3}
              className="border border-line-3 px-3 py-2 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent resize-none"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Reason for losing this deal..."
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowLostReason(false); setSelectedDeal(null); }}
                className="px-4 h-9 text-[14px] text-ink-2 hover:text-ink border border-line rounded-md">Cancel</button>
              <button onClick={saveLost} disabled={!lostReason.trim()}
                className="px-4 h-9 bg-danger hover:bg-danger text-white rounded-md text-[14px] font-medium disabled:opacity-40">Mark Lost</button>
            </div>
          </div>
        </div>
      )}

      {/* Kanban */}
      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 400 }}>
        {STAGES.filter((s) => s !== "lost" || showLost).map((stage) => (
          <div
            key={stage}
            className="flex-shrink-0 w-[280px] bg-surface-2 border border-line rounded-lg flex flex-col"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(e, stage)}
          >
            <div className="px-4 py-3 border-b border-line flex items-center justify-between">
              <span className={`text-[12px] font-semibold uppercase tracking-wide ${stageColor(stage).split(" ")[1]}`}>
                {stageLabel(stage)}
              </span>
              <span className="bg-surface-3 text-ink-2 text-[11px] font-medium px-2 py-0.5 rounded-full">
                {dealsByStage(stage).length}
              </span>
            </div>
            <div className="flex-1 p-3 space-y-2 overflow-y-auto">
              {dealsByStage(stage).map((deal) => {
                const mp = marginPct(deal);
                return (
                  <div
                    key={deal.id}
                    draggable
                    onDragStart={(e) => startDrag(e, deal.id)}
                    onClick={() => openDetail(deal)}
                    className="bg-surface border border-line rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-line-3 transition-all"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px] font-medium text-ink truncate flex-1">
                        {clients.find((c) => c.id === deal.client_id)?.name || "Unknown"}
                      </span>
                      <GripVertical size={12} className="text-faint ml-1" />
                    </div>
                    <div className="text-[12px] text-ink-2 mb-2 truncate">{deal.title}</div>
                    <div className="flex items-center justify-between">
                      <span className="text-[14px] font-semibold text-ink tabular-nums">
                        {deal.asking_price > 0 ? fmtAmount(deal.asking_price) : "—"}
                      </span>
                      {deal.asking_price > 0 && (
                        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${marginColor(mp)}`}>
                          {mp.toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {deal.expected_close_date && (
                      <div className="text-[11px] text-muted mt-1">
                        Close: {deal.expected_close_date.slice(0, 10)}
                      </div>
                    )}
                  </div>
                );
              })}
              {dealsByStage(stage).length === 0 && (
                <div className="text-[12px] text-muted text-center py-6">No deals</div>
              )}
            </div>
          </div>
        ))}

        {/* Lost toggle */}
        {!showLost && (
          <button onClick={() => setShowLost(true)}
            className="flex-shrink-0 w-[40px] flex items-center justify-center bg-surface-2 border border-line rounded-lg text-muted hover:text-danger-ink hover:border-danger transition-colors">
            <Trash2 size={16} />
          </button>
        )}
        {showLost && (
          <button onClick={() => setShowLost(false)}
            className="flex-shrink-0 w-[40px] flex items-center justify-center bg-danger-bg border border-danger rounded-lg text-danger-ink hover:text-danger-ink transition-colors">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Detail panel */}
      {showForm && editingDeal && (
        <DealDetailPanel
          deal={selectedDeal}
          input={editingDeal}
          clients={clients}
          onChange={setEditingDeal}
          onSave={() => handleSave(editingDeal)}
          onClose={() => { setShowForm(false); setSelectedDeal(null); setEditingDeal(null); }}
          onDelete={async () => {
            if (selectedDeal && confirm("Delete this deal?")) {
              await api.deleteDeal(selectedDeal.id);
              setShowForm(false); setSelectedDeal(null); setEditingDeal(null);
              load();
            }
          }}
          onConvert={async () => {
            if (selectedDeal && confirm("Convert to invoice?")) {
              try { await api.convertDealToInvoice(selectedDeal.id); load(); }
              catch (e: any) { alert(e); }
            }
          }}
        />
      )}
    </div>
  );
}

function DealDetailPanel({
  deal, input, clients, onChange, onSave, onClose, onDelete, onConvert,
}: {
  deal: Deal | null; input: DealInput;
  clients: Client[]; onChange: (i: DealInput) => void;
  onSave: () => void; onClose: () => void; onDelete: () => void; onConvert: () => void;
}) {
  const [supplierSuggestions, setSupplierSuggestions] = useState<SupplierNameSuggestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [clientSearch, setClientSearch] = useState("");

  useEffect(() => {
    api.supplierNameSuggestions().then(setSupplierSuggestions).catch(() => {});
  }, []);

  const updateLineItem = (i: number, f: keyof LineItem, v: any) => {
    const li = [...input.line_items];
    (li[i] as any)[f] = v;
    if (f === "qty" || f === "rate") li[i].amount = (li[i].qty || 0) * (li[i].rate || 0);
    onChange({ ...input, line_items: li });
  };

  const updateCostItem = (i: number, f: keyof DealCostItem, v: any) => {
    const sc = [...input.supplier_costs];
    (sc[i] as any)[f] = v;
    onChange({ ...input, supplier_costs: sc });
  };

  const totalCost = input.supplier_costs.reduce((s, c) => s + c.amount, 0) + (input.shipping_cost || 0) + (input.other_costs || 0);
  const profit = (input.asking_price || 0) - totalCost;
  const margin = (input.asking_price || 0) > 0 ? (profit / input.asking_price!) * 100 : 0;

  const filteredClients = clientSearch.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(clientSearch.toLowerCase())).slice(0, 8)
    : clients.slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
      <div className="relative w-[540px] bg-surface shadow-xl h-full overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-surface border-b px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-[16px] font-semibold text-ink">
            {deal ? "Edit Deal" : "New Deal"}
          </h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Client */}
          <div>
            <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Client</label>
            <input
              placeholder="Search client..."
              value={clients.find((c) => c.id === input.client_id)?.name || clientSearch}
              onChange={(e) => {
                setClientSearch(e.target.value);
                const match = clients.find((c) => c.name.toLowerCase().includes(e.target.value.toLowerCase()));
                if (match) onChange({ ...input, client_id: match.id });
              }}
              className="mt-1 border border-line-3 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {clientSearch.trim() && (
              <div className="border border-line rounded-md mt-1 overflow-hidden">
                {filteredClients.map((c) => (
                  <button key={c.id} onClick={() => { onChange({ ...input, client_id: c.id }); setClientSearch(""); }}
                    className="w-full text-left px-3 py-2 text-[13px] hover:bg-accent/10">{c.name}</button>
                ))}
              </div>
            )}
          </div>

          {/* Title + Stage */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Deal Title</label>
              <input className="mt-1 border border-line-3 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent"
                value={input.title} onChange={(e) => onChange({ ...input, title: e.target.value })} />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Stage</label>
              <select value={input.stage || "lead"} onChange={(e) => onChange({ ...input, stage: e.target.value })}
                className="mt-1 border border-line-3 px-3 h-10 rounded-md text-[14px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent">
                {STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
              </select>
            </div>
          </div>

          {/* Line Items */}
          <div>
            <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Line Items</label>
            <div className="mt-2 space-y-2">
              {input.line_items.map((it, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <input className="col-span-6 border border-line-3 px-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                    placeholder="Description" value={it.description} onChange={(e) => updateLineItem(i, "description", e.target.value)} />
                  <input type="number" inputMode="decimal" step="1" className="col-span-1 border border-line-3 px-1 h-9 rounded-md text-[13px] text-center focus:outline-none focus:ring-1 focus:ring-accent"
                    value={it.qty || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); updateLineItem(i, "qty", isNaN(v) ? 0 : v); }} />
                  <div className="col-span-2 relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                    <input type="number" inputMode="decimal" step="0.01" className="w-full border border-line-3 pl-5 pr-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                      value={it.rate || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); updateLineItem(i, "rate", isNaN(v) ? 0 : v); }} />
                  </div>
                  <input readOnly className="col-span-2 border border-line bg-surface-2 px-2 h-9 rounded-md text-[13px] text-right text-ink-2 tabular-nums"
                    value={it.amount ? fmtAmount(it.amount).replace("$", "") : ""} />
                  <button onClick={() => onChange({ ...input, line_items: input.line_items.filter((_, j) => j !== i) })}
                    className="col-span-1 text-muted hover:text-danger-ink flex items-center justify-center"><X size={14} /></button>
                </div>
              ))}
              <button onClick={() => onChange({ ...input, line_items: [...input.line_items, { description: "", qty: 1, rate: 0, amount: 0 }] })}
                className="text-[12px] font-medium text-accent hover:text-accent-hover flex items-center gap-1">
                <Plus size={12} /> Add line item
              </button>
            </div>
          </div>

          {/* Supplier Costs */}
          <div>
            <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Supplier Costs</label>
            <div className="mt-2 space-y-2">
              {input.supplier_costs.map((sc, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <input className="col-span-3 border border-line-3 px-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                    placeholder="Description" value={sc.description} onChange={(e) => updateCostItem(i, "description", e.target.value)} />
                  <div className="col-span-2 relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                    <input type="number" inputMode="decimal" step="0.01" className="w-full border border-line-3 pl-5 pr-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                      value={sc.amount || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); updateCostItem(i, "amount", isNaN(v) ? 0 : v); }} />
                  </div>
                  <div className="col-span-3 relative">
                    <input className="w-full border border-line-3 px-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
                      placeholder="Supplier"
                      list={`supplier-list-${i}`}
                      value={sc.supplier_name || ""}
                      onChange={(e) => updateCostItem(i, "supplier_name", e.target.value)} />
                    <datalist id={`supplier-list-${i}`}>
                      {supplierSuggestions.map((s) => <option key={s.supplier_name} value={s.supplier_name} />)}
                    </datalist>
                  </div>
                  <input readOnly className="col-span-3 border border-line bg-surface-2 px-2 h-9 rounded-md text-[13px] text-muted"
                    value={sc.description || sc.supplier_name ? `${sc.supplier_name || ""}` : ""} />
                  <button onClick={() => onChange({ ...input, supplier_costs: input.supplier_costs.filter((_, j) => j !== i) })}
                    className="col-span-1 text-muted hover:text-danger-ink flex items-center justify-center"><X size={14} /></button>
                </div>
              ))}
              <button onClick={() => onChange({ ...input, supplier_costs: [...input.supplier_costs, { description: "", amount: 0, supplier_name: "" }] })}
                className="text-[12px] font-medium text-accent hover:text-accent-hover flex items-center gap-1">
                <Plus size={12} /> Add supplier cost
              </button>
            </div>
          </div>

          {/* Costs + Price */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Shipping</label>
              <div className="relative mt-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input type="number" inputMode="decimal" step="0.01" className="w-full border border-line-3 pl-5 pr-2 h-10 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-accent"
                  value={input.shipping_cost || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); onChange({ ...input, shipping_cost: isNaN(v) ? 0 : v }); }} />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Other Costs</label>
              <div className="relative mt-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input type="number" inputMode="decimal" step="0.01" className="w-full border border-line-3 pl-5 pr-2 h-10 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-accent"
                  value={input.other_costs || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); onChange({ ...input, other_costs: isNaN(v) ? 0 : v }); }} />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Asking Price</label>
              <div className="relative mt-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input type="number" inputMode="decimal" step="0.01" className="w-full border border-line-3 pl-5 pr-2 h-10 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-accent"
                  value={input.asking_price || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); onChange({ ...input, asking_price: isNaN(v) ? 0 : v }); }} />
              </div>
            </div>
          </div>

          {/* Live margin */}
          <div className="bg-surface-2 border border-line rounded-lg p-4">
            <div className="grid grid-cols-4 gap-3 text-[13px]">
              <div>
                <div className="text-muted text-[11px] uppercase tracking-wide">Revenue</div>
                <div className="font-semibold text-ink mt-0.5">{fmtAmount(input.asking_price || 0)}</div>
              </div>
              <div>
                <div className="text-muted text-[11px] uppercase tracking-wide">Costs</div>
                <div className="font-semibold text-ink mt-0.5">{fmtAmount(totalCost)}</div>
              </div>
              <div>
                <div className="text-muted text-[11px] uppercase tracking-wide">Profit</div>
                <div className={`font-semibold mt-0.5 ${profit >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
                  {fmtAmount(profit)}
                </div>
              </div>
              <div>
                <div className="text-muted text-[11px] uppercase tracking-wide">Margin</div>
                <div className={`font-semibold mt-0.5 ${margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink"}`}>
                  {margin.toFixed(1)}%
                </div>
              </div>
            </div>
          </div>

          {/* Optional fields */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Payment Terms</label>
              <input className="mt-1 border border-line-3 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent"
                value={input.payment_terms || ""} onChange={(e) => onChange({ ...input, payment_terms: e.target.value })} />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Expected Close</label>
              <input type="date" className="mt-1 border border-line-3 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent"
                value={input.expected_close_date || ""} onChange={(e) => onChange({ ...input, expected_close_date: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted uppercase tracking-wide">Notes</label>
            <textarea rows={2} className="mt-1 border border-line-3 px-3 py-2 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent resize-none"
              value={input.notes || ""} onChange={(e) => onChange({ ...input, notes: e.target.value })} />
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-surface border-t px-6 py-4 flex gap-3">
          <button onClick={async () => { setSaving(true); await onSave(); setSaving(false); }}
            disabled={!input.title || !input.client_id}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[14px] font-medium flex-1 disabled:opacity-40 transition-colors">
            {saving ? "Saving..." : "Save"}
          </button>
          {deal && deal.stage === "won" && !deal.converted_invoice_id && (
            <button onClick={onConvert}
              className="bg-success hover:bg-success text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors flex items-center gap-1.5">
              <Check size={14} /> Convert to Invoice
            </button>
          )}
          {deal && (
            <button onClick={onDelete}
              className="bg-surface border border-danger hover:bg-danger-bg text-danger-ink px-3 h-9 rounded-md text-[13px] font-medium transition-colors flex items-center gap-1">
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
