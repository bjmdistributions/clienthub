import { useEffect, useState } from "react";
import { api, Deal, DealInput, Client, LineItem, DealCostItem, SupplierNameSuggestion } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  Plus, X, Briefcase, GripVertical, Check, Trash2, DollarSign, TrendingUp,
} from "lucide-react";

const STAGES = ["lead", "quoted", "negotiating", "won", "lost"] as const;
type Stage = typeof STAGES[number];

const stageLabel = (s: Stage): string => {
  const m: Record<Stage, string> = { lead: "Lead", quoted: "Quoted", negotiating: "Negotiating", won: "Won", lost: "Lost" };
  return m[s];
};

const stageColor = (s: Stage): string => {
  const m: Record<Stage, string> = { lead: "bg-gray-100 text-gray-700", quoted: "bg-blue-50 text-blue-700", negotiating: "bg-amber-50 text-amber-700", won: "bg-emerald-50 text-emerald-700", lost: "bg-red-50 text-red-700" };
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
    pct >= 20 ? "text-emerald-600 bg-emerald-50" : pct >= 10 ? "text-amber-600 bg-amber-50" : "text-red-600 bg-red-50";

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-[18px] font-semibold text-gray-900">Deals</h2>
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
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors">
          <Plus size={16} /> New Deal
        </button>
      </div>

      {/* Lost reason modal */}
      {showLostReason && selectedDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => { setShowLostReason(false); setSelectedDeal(null); }}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-white rounded-xl p-6 shadow-xl w-[400px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[16px] font-semibold text-gray-900 mb-1">Lost Deal</h3>
            <p className="text-[13px] text-gray-500 mb-4">Why was "{selectedDeal?.title}" lost?</p>
            <textarea
              autoFocus
              rows={3}
              className="border border-gray-300 px-3 py-2 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Reason for losing this deal..."
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowLostReason(false); setSelectedDeal(null); }}
                className="px-4 h-9 text-[14px] text-gray-600 hover:text-gray-900 border border-gray-200 rounded-md">Cancel</button>
              <button onClick={saveLost} disabled={!lostReason.trim()}
                className="px-4 h-9 bg-red-600 hover:bg-red-700 text-white rounded-md text-[14px] font-medium disabled:opacity-40">Mark Lost</button>
            </div>
          </div>
        </div>
      )}

      {/* Kanban */}
      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 400 }}>
        {STAGES.filter((s) => s !== "lost" || showLost).map((stage) => (
          <div
            key={stage}
            className="flex-shrink-0 w-[280px] bg-gray-50 border border-gray-200 rounded-lg flex flex-col"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(e, stage)}
          >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <span className={`text-[12px] font-semibold uppercase tracking-wide ${stageColor(stage).split(" ")[1]}`}>
                {stageLabel(stage)}
              </span>
              <span className="bg-gray-200 text-gray-600 text-[11px] font-medium px-2 py-0.5 rounded-full">
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
                    className="bg-white border border-gray-200 rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-gray-300 transition-all"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px] font-medium text-gray-900 truncate flex-1">
                        {clients.find((c) => c.id === deal.client_id)?.name || "Unknown"}
                      </span>
                      <GripVertical size={12} className="text-gray-300 ml-1" />
                    </div>
                    <div className="text-[12px] text-gray-600 mb-2 truncate">{deal.title}</div>
                    <div className="flex items-center justify-between">
                      <span className="text-[14px] font-semibold text-gray-900 tabular-nums">
                        {deal.asking_price > 0 ? fmtAmount(deal.asking_price) : "—"}
                      </span>
                      {deal.asking_price > 0 && (
                        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${marginColor(mp)}`}>
                          {mp.toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {deal.expected_close_date && (
                      <div className="text-[11px] text-gray-400 mt-1">
                        Close: {deal.expected_close_date.slice(0, 10)}
                      </div>
                    )}
                  </div>
                );
              })}
              {dealsByStage(stage).length === 0 && (
                <div className="text-[12px] text-gray-400 text-center py-6">No deals</div>
              )}
            </div>
          </div>
        ))}

        {/* Lost toggle */}
        {!showLost && (
          <button onClick={() => setShowLost(true)}
            className="flex-shrink-0 w-[40px] flex items-center justify-center bg-gray-50 border border-gray-200 rounded-lg text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors">
            <Trash2 size={16} />
          </button>
        )}
        {showLost && (
          <button onClick={() => setShowLost(false)}
            className="flex-shrink-0 w-[40px] flex items-center justify-center bg-red-50 border border-red-200 rounded-lg text-red-400 hover:text-red-600 transition-colors">
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
      <div className="relative w-[540px] bg-white shadow-xl h-full overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-[16px] font-semibold text-gray-900">
            {deal ? "Edit Deal" : "New Deal"}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Client */}
          <div>
            <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Client</label>
            <input
              placeholder="Search client..."
              value={clients.find((c) => c.id === input.client_id)?.name || clientSearch}
              onChange={(e) => {
                setClientSearch(e.target.value);
                const match = clients.find((c) => c.name.toLowerCase().includes(e.target.value.toLowerCase()));
                if (match) onChange({ ...input, client_id: match.id });
              }}
              className="mt-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {clientSearch.trim() && (
              <div className="border border-gray-200 rounded-md mt-1 overflow-hidden">
                {filteredClients.map((c) => (
                  <button key={c.id} onClick={() => { onChange({ ...input, client_id: c.id }); setClientSearch(""); }}
                    className="w-full text-left px-3 py-2 text-[13px] hover:bg-indigo-50">{c.name}</button>
                ))}
              </div>
            )}
          </div>

          {/* Title + Stage */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Deal Title</label>
              <input className="mt-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={input.title} onChange={(e) => onChange({ ...input, title: e.target.value })} />
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Stage</label>
              <select value={input.stage || "lead"} onChange={(e) => onChange({ ...input, stage: e.target.value })}
                className="mt-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
              </select>
            </div>
          </div>

          {/* Line Items */}
          <div>
            <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Line Items</label>
            <div className="mt-2 space-y-2">
              {input.line_items.map((it, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <input className="col-span-6 border border-gray-300 px-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder="Description" value={it.description} onChange={(e) => updateLineItem(i, "description", e.target.value)} />
                  <input type="number" step="1" className="col-span-1 border border-gray-300 px-1 h-9 rounded-md text-[13px] text-center focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    value={it.qty || ""} onChange={(e) => updateLineItem(i, "qty", parseFloat(e.target.value) || 0)} />
                  <div className="col-span-2 relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                    <input type="number" step="0.01" className="w-full border border-gray-300 pl-5 pr-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      value={it.rate || ""} onChange={(e) => updateLineItem(i, "rate", parseFloat(e.target.value) || 0)} />
                  </div>
                  <input readOnly className="col-span-2 border border-gray-100 bg-gray-50 px-2 h-9 rounded-md text-[13px] text-right text-gray-600 tabular-nums"
                    value={it.amount ? fmtAmount(it.amount).replace("$", "") : ""} />
                  <button onClick={() => onChange({ ...input, line_items: input.line_items.filter((_, j) => j !== i) })}
                    className="col-span-1 text-gray-400 hover:text-red-500 flex items-center justify-center"><X size={14} /></button>
                </div>
              ))}
              <button onClick={() => onChange({ ...input, line_items: [...input.line_items, { description: "", qty: 1, rate: 0, amount: 0 }] })}
                className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                <Plus size={12} /> Add line item
              </button>
            </div>
          </div>

          {/* Supplier Costs */}
          <div>
            <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Supplier Costs</label>
            <div className="mt-2 space-y-2">
              {input.supplier_costs.map((sc, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <input className="col-span-3 border border-gray-300 px-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder="Description" value={sc.description} onChange={(e) => updateCostItem(i, "description", e.target.value)} />
                  <div className="col-span-2 relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                    <input type="number" step="0.01" className="w-full border border-gray-300 pl-5 pr-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      value={sc.amount || ""} onChange={(e) => updateCostItem(i, "amount", parseFloat(e.target.value) || 0)} />
                  </div>
                  <div className="col-span-3 relative">
                    <input className="w-full border border-gray-300 px-2 h-9 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="Supplier"
                      list={`supplier-list-${i}`}
                      value={sc.supplier_name || ""}
                      onChange={(e) => updateCostItem(i, "supplier_name", e.target.value)} />
                    <datalist id={`supplier-list-${i}`}>
                      {supplierSuggestions.map((s) => <option key={s.supplier_name} value={s.supplier_name} />)}
                    </datalist>
                  </div>
                  <input readOnly className="col-span-3 border border-gray-100 bg-gray-50 px-2 h-9 rounded-md text-[13px] text-gray-400"
                    value={sc.description || sc.supplier_name ? `${sc.supplier_name || ""}` : ""} />
                  <button onClick={() => onChange({ ...input, supplier_costs: input.supplier_costs.filter((_, j) => j !== i) })}
                    className="col-span-1 text-gray-400 hover:text-red-500 flex items-center justify-center"><X size={14} /></button>
                </div>
              ))}
              <button onClick={() => onChange({ ...input, supplier_costs: [...input.supplier_costs, { description: "", amount: 0, supplier_name: "" }] })}
                className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                <Plus size={12} /> Add supplier cost
              </button>
            </div>
          </div>

          {/* Costs + Price */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Shipping</label>
              <div className="relative mt-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                <input type="number" step="0.01" className="w-full border border-gray-300 pl-5 pr-2 h-10 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={input.shipping_cost || ""} onChange={(e) => onChange({ ...input, shipping_cost: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Other Costs</label>
              <div className="relative mt-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                <input type="number" step="0.01" className="w-full border border-gray-300 pl-5 pr-2 h-10 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={input.other_costs || ""} onChange={(e) => onChange({ ...input, other_costs: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Asking Price</label>
              <div className="relative mt-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                <input type="number" step="0.01" className="w-full border border-gray-300 pl-5 pr-2 h-10 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  value={input.asking_price || ""} onChange={(e) => onChange({ ...input, asking_price: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
          </div>

          {/* Live margin */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <div className="grid grid-cols-4 gap-3 text-[13px]">
              <div>
                <div className="text-gray-500 text-[11px] uppercase tracking-wide">Revenue</div>
                <div className="font-semibold text-gray-900 mt-0.5">{fmtAmount(input.asking_price || 0)}</div>
              </div>
              <div>
                <div className="text-gray-500 text-[11px] uppercase tracking-wide">Costs</div>
                <div className="font-semibold text-gray-900 mt-0.5">{fmtAmount(totalCost)}</div>
              </div>
              <div>
                <div className="text-gray-500 text-[11px] uppercase tracking-wide">Profit</div>
                <div className={`font-semibold mt-0.5 ${profit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {fmtAmount(profit)}
                </div>
              </div>
              <div>
                <div className="text-gray-500 text-[11px] uppercase tracking-wide">Margin</div>
                <div className={`font-semibold mt-0.5 ${margin >= 20 ? "text-emerald-600" : margin >= 10 ? "text-amber-600" : "text-red-600"}`}>
                  {margin.toFixed(1)}%
                </div>
              </div>
            </div>
          </div>

          {/* Optional fields */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Payment Terms</label>
              <input className="mt-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={input.payment_terms || ""} onChange={(e) => onChange({ ...input, payment_terms: e.target.value })} />
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Expected Close</label>
              <input type="date" className="mt-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={input.expected_close_date || ""} onChange={(e) => onChange({ ...input, expected_close_date: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Notes</label>
            <textarea rows={2} className="mt-1 border border-gray-300 px-3 py-2 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={input.notes || ""} onChange={(e) => onChange({ ...input, notes: e.target.value })} />
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t px-6 py-4 flex gap-3">
          <button onClick={async () => { setSaving(true); await onSave(); setSaving(false); }}
            disabled={!input.title || !input.client_id}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex-1 disabled:opacity-40 transition-colors">
            {saving ? "Saving..." : "Save"}
          </button>
          {deal && deal.stage === "won" && !deal.converted_invoice_id && (
            <button onClick={onConvert}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors flex items-center gap-1.5">
              <Check size={14} /> Convert to Invoice
            </button>
          )}
          {deal && (
            <button onClick={onDelete}
              className="bg-white border border-red-200 hover:bg-red-50 text-red-600 px-3 h-9 rounded-md text-[13px] font-medium transition-colors flex items-center gap-1">
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
