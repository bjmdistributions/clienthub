import { useEffect, useRef, useState } from "react";
import { api, CheckupSession, CheckupDetail, CheckupItem, Category } from "../lib/api";
import { fmtPhone } from "../lib/format";
import { Plus, ArrowLeft, Trash2, Check, Phone, Mail, ArrowRight, Undo2 } from "lucide-react";

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
        <button onClick={() => setCreating(true)} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5"><Plus size={14} /> New session</button>
      </div>
      <p className="text-[12px] text-muted mb-5">Work through your clients in three steps — reach out, note how it went, then mark them done. Move cards back any time.</p>

      {creating && (
        <div className="bg-surface border border-line rounded-xl p-4 mb-4 space-y-3">
          <input autoFocus className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink" placeholder="Session name (e.g. June outreach)" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All clients</option>
            {cats.map((c) => <option key={c.id} value={c.label}>{c.label} only</option>)}
          </select>
          <div className="flex gap-2">
            <button disabled={busy} onClick={create} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">Start session</button>
            <button onClick={() => setCreating(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
          </div>
        </div>
      )}

      {sessions.length === 0 && !creating ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-10 text-center">No sessions yet. Start one to begin reaching out to your clients.</div>
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
                  <div className="text-[12px] text-muted tabular-nums flex-shrink-0">{s.done}/{s.total} done</div>
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

// ---- contact row used in every card ----
function Contact({ it }: { it: CheckupItem }) {
  return (
    <div className="mt-2 space-y-1.5 text-[13px]">
      {it.phone && <a href={`tel:${it.phone}`} className="flex items-center gap-2 text-ink-2 hover:text-accent"><Phone size={13} className="text-muted flex-shrink-0" />{fmtPhone(it.phone)}</a>}
      {it.email && <a href={`mailto:${it.email}`} className="flex items-center gap-2 text-ink-2 hover:text-accent truncate"><Mail size={13} className="text-muted flex-shrink-0" /><span className="truncate">{it.email}</span></a>}
      {!it.phone && !it.email && <div className="text-[12px] text-faint">No contact info</div>}
    </div>
  );
}

function Column({ accent, label, count, children }: { accent: string; label: string; count: number; children: React.ReactNode }) {
  return (
    <div className="bg-surface-2/50 border border-line rounded-2xl p-3 flex flex-col min-h-[120px]">
      <div className="flex items-center gap-2 px-1 pb-2.5 mb-1 border-b border-line">
        <span className="w-2 h-2 rounded-full" style={{ background: accent }} />
        <span className="text-[12px] font-semibold text-ink">{label}</span>
        <span className="ml-auto text-[11px] font-medium text-muted tabular-nums bg-surface border border-line rounded-full px-2 py-0.5">{count}</span>
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function SessionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<CheckupDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  // Local note drafts for "reached out" cards, keyed by item id (so reloads don't clobber typing).
  const drafts = useRef<Record<string, string>>({});
  const load = () => api.getCheckup(id).then(setData).catch(() => {});
  useEffect(() => { load(); }, [id]);

  const items = data?.items ?? [];
  const todo = items.filter((i) => i.stage === 0);
  const reached = items.filter((i) => i.stage === 1);
  const done = items.filter((i) => i.stage === 2);

  const move = async (it: CheckupItem, stage: number) => {
    if (busy) return;
    setBusy(true);
    const note = drafts.current[it.id] ?? it.note ?? "";
    await api.setCheckupItemStage(id, it.id, stage, note).catch(() => {});
    const d = await api.getCheckup(id).catch(() => null);
    if (d) setData(d);
    setBusy(false);
  };
  const saveNote = async (it: CheckupItem) => {
    const note = drafts.current[it.id];
    if (note === undefined || note === it.note) return;
    await api.setCheckupItemStage(id, it.id, 1, note).catch(() => {});
  };
  const doDelete = async () => { await api.deleteCheckup(id).catch(() => {}); onBack(); };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <button onClick={onBack} className="text-[13px] text-muted hover:text-ink inline-flex items-center gap-1"><ArrowLeft size={14} /> Sessions</button>
        <div className="text-[13px] text-muted tabular-nums">{done.length}/{items.length} done</div>
        <button onClick={() => setConfirmDel(true)} className="text-faint hover:text-danger-ink p-1.5 rounded-md"><Trash2 size={14} /></button>
      </div>
      <h2 className="text-[19px] font-semibold text-ink mb-5">{data?.name}</h2>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* 1 — To reach out */}
        <Column accent="rgb(var(--c-faint))" label="To reach out" count={todo.length}>
          {todo.length === 0 ? <Empty text="Everyone's been contacted." /> : todo.map((it) => (
            <div key={it.id} className="bg-surface border border-line rounded-xl p-3.5 shadow-sm">
              <div className="text-[14px] font-semibold text-ink">{it.name}</div>
              <Contact it={it} />
              <button disabled={busy} onClick={() => move(it, 1)} className="mt-3 w-full h-8 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12.5px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                Reached out <ArrowRight size={13} />
              </button>
            </div>
          ))}
        </Column>

        {/* 2 — Reached out (notes live here) */}
        <Column accent="rgb(var(--c-warning))" label="Reached out" count={reached.length}>
          {reached.length === 0 ? <Empty text="Nobody in progress yet." /> : reached.map((it) => (
            <div key={it.id} className="bg-surface border border-warning/60 rounded-xl p-3.5 shadow-sm">
              <div className="text-[14px] font-semibold text-ink">{it.name}</div>
              <Contact it={it} />
              <textarea defaultValue={it.note} onChange={(e) => { drafts.current[it.id] = e.target.value; }} onBlur={() => saveNote(it)} rows={3}
                placeholder="How did it go? (saved to their profile)"
                className="mt-2.5 w-full bg-surface-2 border border-line rounded-lg px-2.5 py-2 text-[12.5px] text-ink resize-none focus:outline-none focus:ring-2 focus:ring-warning/40" />
              <div className="mt-2 flex gap-2">
                <button disabled={busy} onClick={() => move(it, 0)} title="Back to to-do" className="h-8 px-2.5 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[12px] inline-flex items-center gap-1"><Undo2 size={13} /></button>
                <button disabled={busy} onClick={() => move(it, 2)} className="flex-1 h-8 rounded-lg bg-success hover:opacity-90 text-on-accent text-[12.5px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"><Check size={14} /> Submit to done</button>
              </div>
            </div>
          ))}
        </Column>

        {/* 3 — Done */}
        <Column accent="rgb(var(--c-success))" label="Done" count={done.length}>
          {done.length === 0 ? <Empty text="Submitted clients land here." /> : done.map((it) => (
            <div key={it.id} className="bg-surface/70 border border-line rounded-xl p-3.5">
              <div className="text-[14px] font-medium text-ink-2 flex items-center gap-1.5"><Check size={14} className="text-success-ink flex-shrink-0" />{it.name}</div>
              {it.note && <div className="text-[12px] text-muted mt-1.5 whitespace-pre-wrap">{it.note}</div>}
              <button disabled={busy} onClick={() => move(it, 1)} className="mt-2.5 text-[11.5px] text-muted hover:text-ink inline-flex items-center gap-1"><Undo2 size={12} /> Reopen</button>
            </div>
          ))}
        </Column>
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDel(false)}>
          <div className="bg-surface border border-line rounded-2xl p-5 max-w-sm w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-ink">Delete this session?</h3>
            <p className="text-[13px] text-muted mt-1.5 leading-relaxed">This permanently removes “{data?.name}” and its review progress. This can’t be undone. (Clients already reached out to keep their logged contact.)</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
              <button onClick={doDelete} className="bg-danger hover:opacity-90 text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Delete session</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-[12px] text-faint text-center py-6">{text}</div>;
}
