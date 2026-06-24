import { useEffect, useState } from "react";
import { api, CheckupSession, CheckupDetail, CheckupItem, Category } from "../lib/api";
import { fmtPhone } from "../lib/format";
import { Plus, ArrowLeft, Trash2, Check, Phone, Mail } from "lucide-react";

export default function CheckupView() {
  const [sessions, setSessions] = useState<CheckupSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = () => api.listCheckups().then(setSessions).catch(() => {});
  useEffect(() => { load(); }, []);

  if (openId) return <SessionDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;
  return <SessionsList sessions={sessions} onOpen={setOpenId} reload={load} />;
}

function SessionsList({ sessions, onOpen, reload }: { sessions: CheckupSession[]; onOpen: (id: string) => void; reload: () => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [cats, setCats] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listCategories().then(setCats).catch(() => {}); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createCheckup(name.trim() || undefined, category || undefined);
      setCreating(false); setName(""); setCategory("");
      reload();
      onOpen(r.id);
    } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <div className="p-7 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[18px] font-semibold text-ink">Checkup</h2>
        <button onClick={() => setCreating(true)} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5"><Plus size={14} /> New session</button>
      </div>
      <p className="text-[12px] text-muted mb-5">Work through your clients one by one — call or message each, then mark them reviewed with a note.</p>

      {creating && (
        <div className="bg-surface border border-line rounded-xl p-4 mb-4 space-y-3">
          <input autoFocus className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink" placeholder="Session name (e.g. June outreach)" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All clients</option>
            {cats.map((c) => <option key={c.id} value={c.label}>{c.label} only</option>)}
          </select>
          <div className="flex gap-2">
            <button disabled={busy} onClick={create} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">Start session</button>
            <button onClick={() => setCreating(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
          </div>
        </div>
      )}

      {sessions.length === 0 && !creating ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-10 text-center">No sessions yet. Start one to begin reviewing your clients.</div>
      ) : (
        <div className="space-y-2.5">
          {sessions.map((s) => {
            const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
            return (
              <button key={s.id} onClick={() => onOpen(s.id)} className="w-full text-left bg-surface border border-line rounded-xl p-4 hover:bg-surface-2/70 transition-colors">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-ink truncate">{s.name}</div>
                    <div className="text-[11px] text-muted">{s.owner_name ? `${s.owner_name} · ` : ""}{new Date(s.created_at).toLocaleDateString()}</div>
                  </div>
                  <div className="text-[12px] text-muted tabular-nums flex-shrink-0">{s.done}/{s.total} reviewed</div>
                </div>
                <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden"><div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} /></div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SessionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<CheckupDetail | null>(null);
  const [selected, setSelected] = useState<CheckupItem | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.getCheckup(id).then(setData).catch(() => {});
  useEffect(() => { load(); }, [id]);

  const todo = data?.items.filter((i) => !i.reviewed) ?? [];
  const done = data?.items.filter((i) => i.reviewed) ?? [];

  const select = (it: CheckupItem) => { setSelected(it); setNote(it.note || ""); };
  const markReviewed = async () => {
    if (!selected) return;
    setBusy(true);
    await api.reviewCheckupItem(id, selected.id, true, note.trim()).catch(() => {});
    setBusy(false);
    const d = await api.getCheckup(id).catch(() => null);
    if (d) setData(d);
    // auto-advance to the next unreviewed
    const next = d?.items.find((i) => !i.reviewed && i.id !== selected.id) ?? null;
    setSelected(next); setNote(next?.note || "");
  };
  const remove = async () => { if (!window.confirm("Delete this session?")) return; await api.deleteCheckup(id).catch(() => {}); onBack(); };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="text-[13px] text-muted hover:text-ink inline-flex items-center gap-1"><ArrowLeft size={14} /> Sessions</button>
        <div className="text-[13px] text-muted tabular-nums">{done.length}/{(data?.items.length ?? 0)} reviewed</div>
        <button onClick={remove} className="text-faint hover:text-danger-ink p-1.5 rounded-md"><Trash2 size={14} /></button>
      </div>
      <h2 className="text-[18px] font-semibold text-ink mb-4">{data?.name}</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* To review */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-1">To review ({todo.length})</div>
          {todo.length === 0 ? <div className="text-[12px] text-muted py-4 text-center">All done</div> :
            todo.map((it) => (
              <button key={it.id} onClick={() => select(it)} className={`w-full text-left rounded-lg p-2.5 border transition-colors ${selected?.id === it.id ? "border-accent bg-accent/10" : "border-line bg-surface hover:bg-surface-2"}`}>
                <div className="text-[13px] font-medium text-ink truncate">{it.name}</div>
                <div className="text-[11px] text-muted truncate">{it.phone ? fmtPhone(it.phone) : it.email || "—"}</div>
              </button>
            ))}
        </div>

        {/* Review panel */}
        <div className="bg-surface border border-line rounded-xl p-4">
          {selected ? (
            <>
              <div className="text-[15px] font-semibold text-ink">{selected.name}</div>
              <div className="mt-2 space-y-1 text-[13px] text-ink-2">
                {selected.phone && <div className="flex items-center gap-2"><Phone size={13} className="text-muted" /><a href={`tel:${selected.phone}`} className="hover:text-accent">{fmtPhone(selected.phone)}</a></div>}
                {selected.email && <div className="flex items-center gap-2"><Mail size={13} className="text-muted" /><a href={`mailto:${selected.email}`} className="hover:text-accent truncate">{selected.email}</a></div>}
              </div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} placeholder="How did the outreach go? (logged on their profile)"
                className="mt-3 w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink resize-none focus:outline-none focus:ring-2 focus:ring-accent/40" />
              <button disabled={busy} onClick={markReviewed} className="mt-2 w-full bg-accent hover:bg-accent-hover text-white h-9 rounded-lg text-[13px] font-medium inline-flex items-center justify-center gap-1.5"><Check size={14} /> Mark reviewed</button>
            </>
          ) : (
            <div className="text-[13px] text-muted text-center py-10">Select a client on the left to review them.</div>
          )}
        </div>

        {/* Reviewed */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-1">Reviewed ({done.length})</div>
          {done.map((it) => (
            <button key={it.id} onClick={() => select(it)} className="w-full text-left rounded-lg p-2.5 border border-line bg-surface/60 hover:bg-surface-2">
              <div className="text-[13px] text-ink-2 truncate flex items-center gap-1.5"><Check size={12} className="text-emerald-500 flex-shrink-0" />{it.name}</div>
              {it.note && <div className="text-[11px] text-muted truncate mt-0.5 pl-5">{it.note}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
