import { useEffect, useRef, useState } from "react";
import { api, CheckupSession, CheckupDetail, CheckupItem, Category } from "../lib/api";
import { fmtPhone } from "../lib/format";
import { Plus, ArrowLeft, Trash2, Check, Phone, Mail, ArrowRight, Undo2 } from "lucide-react";
import { Button, PageActions } from "./ui";

const FIELD = "w-full bg-transparent border border-line-3 rounded-lg h-9 px-3 text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-150";

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
    <div>
      <PageActions>
        <Button variant="ink" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New session</Button>
      </PageActions>
      <p className="text-[14px] text-muted mb-5">Work through your clients in three steps: reach out, note how it went, then mark them done. Move cards back any time.</p>

      {creating && (
        <div className="py-4 mb-4 space-y-3 shadow-[inset_0_1px_0_rgb(var(--c-line)),inset_0_-1px_0_rgb(var(--c-line))] animate-fade-in">
          <label className="block"><span className="ui-label block mb-1.5">Session name</span>
            <input autoFocus className={FIELD} placeholder="Session name (e.g. June outreach)" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="block"><span className="ui-label block mb-1.5">Who to include</span>
            <select className={FIELD} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All clients</option>
              {cats.map((c) => <option key={c.id} value={c.label}>{c.label} only</option>)}
            </select></label>
          <div className="flex gap-2">
            <Button variant="ink" disabled={busy} onClick={create}>Start session</Button>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {sessions.length === 0 && !creating ? (
        <div className="text-[14px] text-muted py-16 text-center">No sessions yet. Start one to begin reaching out to your clients.</div>
      ) : (
        <div>
          {sessions.map((s) => {
            const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
            return (
              <button key={s.id} onClick={() => onOpen(s.id)} className="w-full text-left py-4 px-2 -mx-2 rounded-lg shadow-[inset_0_1px_0_rgb(var(--c-line))] hover:bg-surface-2 transition-colors duration-150">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-ink truncate">{s.name}</div>
                    <div className="ui-note">{s.owner_name ? `${s.owner_name} · ` : ""}{new Date(s.created_at).toLocaleDateString()}</div>
                  </div>
                  <div className="text-[13px] text-muted tabular-nums flex-shrink-0">{s.done}/{s.total} done</div>
                </div>
                <div className="h-1 bg-surface-3 rounded-full overflow-hidden"><div className="h-full bg-accent rounded-full transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
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
      {it.phone && <a href={`tel:${it.phone}`} className="flex items-center gap-2 text-ink-2 hover:text-ink"><Phone size={14} className="text-muted flex-shrink-0" />{fmtPhone(it.phone)}</a>}
      {it.email && <a href={`mailto:${it.email}`} className="flex items-center gap-2 text-ink-2 hover:text-ink truncate"><Mail size={14} className="text-muted flex-shrink-0" /><span className="truncate">{it.email}</span></a>}
      {!it.phone && !it.email && <div className="ui-note text-faint">No contact info</div>}
    </div>
  );
}

function Column({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-[120px] min-w-0 px-1">
      <div className="flex items-center gap-2 pb-3">
        <span className="text-[14px] font-medium text-ink">{label}</span>
        <span className="ui-count">{count}</span>
      </div>
      <div>{children}</div>
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
    <div>
      <div className="flex items-center justify-between mb-3">
        <button onClick={onBack} className="ui-link muted"><ArrowLeft size={14} /> Sessions</button>
        <div className="text-[13px] text-muted tabular-nums">{done.length}/{items.length} done</div>
        <button onClick={() => setConfirmDel(true)} title="Delete this session" aria-label="Delete this session" className="ui-ib hover:!text-danger-ink"><Trash2 size={15} /></button>
      </div>
      <h2 className="text-[20px] font-medium text-ink mb-5">{data?.name}</h2>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr_1px_1fr] gap-y-6 items-start">
        {/* 1: To reach out */}
        <Column label="To reach out" count={todo.length}>
          {todo.length === 0 ? <Empty text="Everyone has been contacted." /> : todo.map((it) => (
            <div key={it.id} className="py-3.5 shadow-[inset_0_1px_0_rgb(var(--c-line))]">
              <div className="text-[14px] font-medium text-ink">{it.name}</div>
              <Contact it={it} />
              <Button variant="ink" block disabled={busy} onClick={() => move(it, 1)} className="mt-3">
                Reached out <ArrowRight size={14} />
              </Button>
            </div>
          ))}
        </Column>
        <div className="vsep hidden lg:block mx-3" />

        {/* 2: Reached out (notes live here) */}
        <Column label="Reached out" count={reached.length}>
          {reached.length === 0 ? <Empty text="Nobody in progress yet." /> : reached.map((it) => (
            <div key={it.id} className="py-3.5 shadow-[inset_0_1px_0_rgb(var(--c-line))]">
              <div className="text-[14px] font-medium text-ink">{it.name}</div>
              <Contact it={it} />
              <textarea defaultValue={it.note} onChange={(e) => { drafts.current[it.id] = e.target.value; }} onBlur={() => saveNote(it)} rows={3}
                aria-label={`Note for ${it.name}`}
                placeholder="How did it go? (saved to their profile)"
                className="mt-2.5 w-full bg-transparent border border-line-3 rounded-lg px-2.5 py-2 text-[13px] text-ink resize-none focus:outline-none focus:border-ink transition-colors duration-150" />
              <div className="mt-2 flex gap-2">
                <Button disabled={busy} onClick={() => move(it, 0)} title="Back to to-do" icon={<Undo2 size={14} />}>Back</Button>
                <Button variant="ink" className="flex-1" disabled={busy} onClick={() => move(it, 2)} icon={<Check size={14} />}>Submit to done</Button>
              </div>
            </div>
          ))}
        </Column>
        <div className="vsep hidden lg:block mx-3" />

        {/* 3: Done */}
        <Column label="Done" count={done.length}>
          {done.length === 0 ? <Empty text="Submitted clients land here." /> : done.map((it) => (
            <div key={it.id} className="py-3.5 shadow-[inset_0_1px_0_rgb(var(--c-line))]">
              <div className="text-[14px] font-medium text-ink-2 flex items-center gap-1.5"><Check size={14} className="text-success-ink flex-shrink-0" />{it.name}</div>
              {it.note && <div className="text-[13px] text-muted mt-1.5 whitespace-pre-wrap">{it.note}</div>}
              <button disabled={busy} onClick={() => move(it, 1)} className="ui-link muted mt-2.5"><Undo2 size={13} /> Reopen</button>
            </div>
          ))}
        </Column>
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDel(false)}>
          <div className="bg-surface border border-line rounded-2xl p-5 max-w-sm w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[16px] font-medium text-ink">Delete this session?</h3>
            <p className="text-[13px] text-muted mt-1.5 leading-relaxed">This permanently removes "{data?.name}" and its review progress. This can't be undone. (Clients already reached out to keep their logged contact.)</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
              <Button variant="danger" onClick={doDelete}>Delete session</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-[13px] text-faint text-center py-6">{text}</div>;
}
