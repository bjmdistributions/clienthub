import { useEffect, useState, useRef, useCallback } from "react";
import { api, Note } from "../lib/api";
import { Plus, Pin, Trash2, StickyNote } from "lucide-react";

// Sticky-note palette — translucent fills + a solid accent so they read well in
// both light and dark themes.
const COLORS: { key: string; fill: string; accent: string; glow: string }[] = [
  { key: "yellow", fill: "rgba(250,204,21,0.13)",  accent: "#FACC15", glow: "rgba(250,204,21,0.25)" },
  { key: "blue",   fill: "rgba(96,165,250,0.13)",  accent: "#60A5FA", glow: "rgba(96,165,250,0.25)" },
  { key: "green",  fill: "rgba(52,211,153,0.13)",  accent: "#34D399", glow: "rgba(52,211,153,0.25)" },
  { key: "pink",   fill: "rgba(244,114,182,0.13)", accent: "#F472B6", glow: "rgba(244,114,182,0.25)" },
  { key: "purple", fill: "rgba(167,139,250,0.13)", accent: "#A78BFA", glow: "rgba(167,139,250,0.25)" },
  { key: "orange", fill: "rgba(251,146,60,0.13)",  accent: "#FB923C", glow: "rgba(251,146,60,0.25)" },
];
const colorOf = (k: string) => COLORS.find((c) => c.key === k) || COLORS[0];

// Live relative time: "just now / 5m ago / 3h ago / yesterday / Mar 5".
function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (!d) return "";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? "s" : ""} ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const exactTime = (iso: string) => { const t = new Date(iso); return isNaN(+t) ? "" : t.toLocaleString(); };

export default function NotesView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0); // forces relative-time refresh
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(() => {
    api.listNotes().then(setNotes).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  // Keep relative timestamps fresh without a reload.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(t); }, []);

  const addNote = async () => {
    try {
      const n = await api.createNote("", "yellow");
      setNotes((p) => [n, ...p]);
      // focus the new note next paint
      requestAnimationFrame(() => document.getElementById(`note-${n.id}`)?.focus());
    } catch {/* ignore */}
  };

  // Optimistic local update + debounced persist (notes save as you type).
  const editBody = (id: string, body: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, body, updated_at: new Date().toISOString() } : n)));
    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => { api.updateNote(id, { body }).catch(() => {}); }, 600);
  };
  const setColor = (id: string, color: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, color } : n)));
    api.updateNote(id, { color }).catch(() => {});
  };
  const togglePin = (id: string, pinned: boolean) => {
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, pinned } : n));
      return [...next].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updated_at > a.updated_at ? 1 : -1));
    });
    api.updateNote(id, { pinned }).catch(() => {});
  };
  const remove = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    api.deleteNote(id).catch(() => {});
  };

  return (
    <div className="min-h-full" style={{ background: "var(--t-bg)" }}>
      <div className="px-6 py-4 flex items-center justify-between flex-shrink-0"
        style={{ background: "var(--t-s1)", borderBottom: "1px solid var(--t-b1)" }}>
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)" }}>Notes</h2>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--t-tx4)" }}>
            {notes.length === 0 ? "Quick sticky notes for your team" : `${notes.length} note${notes.length > 1 ? "s" : ""}`}
          </p>
        </div>
        <button onClick={addNote}
          className="btn-ripple flex items-center gap-1.5 text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-all duration-150 hover:-translate-y-px"
          style={{ background: "linear-gradient(135deg, var(--accent-600), var(--accent-500))", boxShadow: "0 2px 10px var(--accent-glow)" }}>
          <Plus size={14} /> New note
        </button>
      </div>

      <div className="p-6">
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={`skeleton rounded-2xl stagger-${i + 1}`} style={{ height: 168 }} />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-24 animate-fade-up">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: "var(--accent-tint)", color: "var(--accent-400)" }}>
              <StickyNote size={24} />
            </div>
            <p className="text-[15px] font-semibold mb-1" style={{ color: "var(--t-tx1)" }}>No notes yet</p>
            <p className="text-[13px] mb-5" style={{ color: "var(--t-tx4)" }}>Jot down reminders, ideas, or anything your team should see.</p>
            <button onClick={addNote} className="text-[13px] font-medium px-4 h-9 rounded-lg"
              style={{ background: "var(--accent-tint)", color: "var(--accent-400)", border: "1px solid var(--accent-glow)" }}>
              + Add your first note
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {notes.map((n, i) => {
              const c = colorOf(n.color);
              return (
                <div key={n.id}
                  className={`note-card group relative rounded-2xl flex flex-col animate-fade-up stagger-${Math.min(i + 1, 8)}`}
                  style={{ background: c.fill, border: `1px solid ${c.glow}`, boxShadow: `0 4px 18px -8px ${c.glow}` }}>
                  <div className="absolute left-0 top-3 bottom-3 w-1 rounded-r" style={{ background: c.accent }} />
                  {n.pinned && <Pin size={12} className="absolute top-3 right-3" style={{ color: c.accent, fill: c.accent }} />}
                  <textarea
                    id={`note-${n.id}`}
                    value={n.body}
                    onChange={(e) => editBody(n.id, e.target.value)}
                    placeholder="Write a note…"
                    spellCheck={false}
                    className="flex-1 resize-none bg-transparent outline-none px-4 pt-4 pb-2 text-[13.5px] leading-relaxed"
                    style={{ color: "var(--t-tx1)", minHeight: 110 }}
                  />
                  <div className="flex items-center justify-between px-3 pb-3 pt-1">
                    <div className="flex items-center gap-1.5">
                      {COLORS.map((opt) => (
                        <button key={opt.key} title={opt.key} onClick={() => setColor(n.id, opt.key)}
                          className="w-3.5 h-3.5 rounded-full transition-transform hover:scale-125"
                          style={{ background: opt.accent, outline: n.color === opt.key ? `2px solid ${opt.accent}` : "none", outlineOffset: 2, opacity: n.color === opt.key ? 1 : 0.55 }} />
                      ))}
                    </div>
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button title={n.pinned ? "Unpin" : "Pin"} onClick={() => togglePin(n.id, !n.pinned)}
                        className="transition-colors" style={{ color: n.pinned ? c.accent : "var(--t-tx4)" }}>
                        <Pin size={14} />
                      </button>
                      <button title="Delete" onClick={() => remove(n.id)}
                        className="transition-colors hover:text-red-400" style={{ color: "var(--t-tx4)" }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="px-4 pb-3 flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--t-tx4)" }}>
                    <span title={exactTime(n.updated_at)} className="cursor-default tabular-nums">{relTime(n.updated_at)}</span>
                    {n.author && <><span>·</span><span className="truncate">{n.author}</span></>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
