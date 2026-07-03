import { useEffect, useState, useRef, useCallback } from "react";
import { api, Note } from "../lib/api";
import { Plus, Pin, Trash2, StickyNote, GripVertical } from "lucide-react";

const COLORS: { key: string; fill: string; accent: string }[] = [
  { key: "yellow", fill: "rgba(250,204,21,0.18)",  accent: "#FACC15" },
  { key: "blue",   fill: "rgba(96,165,250,0.18)",  accent: "#60A5FA" },
  { key: "green",  fill: "rgba(52,211,153,0.18)",  accent: "#34D399" },
  { key: "pink",   fill: "rgba(244,114,182,0.18)", accent: "#F472B6" },
  { key: "purple", fill: "rgba(167,139,250,0.18)", accent: "#A78BFA" },
  { key: "orange", fill: "rgba(251,146,60,0.18)",  accent: "#FB923C" },
];
const colorOf = (k: string) => COLORS.find((c) => c.key === k) || COLORS[0];
const NOTE_W = 226, NOTE_H = 190;

// Stable tiny rotation per note so the board feels hand-pinned, not gridded.
function stableRot(id: string): number {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((((h % 5) + 5) % 5) - 2) * 0.7;
}
function relTime(iso: string): string {
  const d = new Date(iso).getTime(); if (!d) return "";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr${h > 1 ? "s" : ""} ago`;
  const days = Math.floor(h / 24); if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const exactTime = (iso: string) => { const t = new Date(iso); return isNaN(+t) ? "" : t.toLocaleString(); };

export default function NotesView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<Note[]>([]);
  notesRef.current = notes;
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(() => {
    api.listNotes().then((ns) => {
      // Notes made before the board existed have x=y=0 — lay them out once.
      if (ns.length > 1 && ns.every((n) => !n.x && !n.y)) {
        const bw = (boardRef.current?.clientWidth || 920) - 24;
        const cols = Math.max(1, Math.floor(bw / (NOTE_W + 18)));
        ns = ns.map((n, i) => ({ ...n, x: 18 + (i % cols) * (NOTE_W + 18), y: 18 + Math.floor(i / cols) * (NOTE_H + 18) }));
        ns.forEach((n) => api.updateNote(n.id, { x: n.x, y: n.y }).catch(() => {}));
      }
      setNotes(ns);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(t); }, []);

  // Drag — global listeners read the latest via refs (no stale closures).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current, board = boardRef.current; if (!d || !board) return;
      const rect = board.getBoundingClientRect();
      let x = e.clientX - rect.left - d.dx;
      let y = e.clientY - rect.top - d.dy;
      x = Math.max(0, Math.min(board.clientWidth - NOTE_W, x));
      y = Math.max(0, y);
      d.moved = true;
      setNotes((prev) => prev.map((n) => (n.id === d.id ? { ...n, x, y } : n)));
    };
    const up = () => {
      const d = drag.current; if (!d) return; drag.current = null;
      document.body.style.userSelect = "";
      const n = notesRef.current.find((x) => x.id === d.id);
      if (n && d.moved) api.updateNote(n.id, { x: Math.round(n.x), y: Math.round(n.y) }).catch(() => {});
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const startDrag = (e: React.PointerEvent, id: string) => {
    const n = notesRef.current.find((x) => x.id === id), board = boardRef.current;
    if (!n || !board) return;
    const rect = board.getBoundingClientRect();
    drag.current = { id, dx: e.clientX - rect.left - n.x, dy: e.clientY - rect.top - n.y, moved: false };
    document.body.style.userSelect = "none";
  };

  const addNote = async () => {
    const w = boardRef.current?.clientWidth || 800;
    const k = notes.length % 7;
    const x = Math.max(16, Math.min(w - NOTE_W - 16, 48 + k * 30));
    const y = 24 + k * 28;
    try {
      const note = await api.createNote("", "yellow", x, y);
      setNotes((p) => [...p, note]);
      requestAnimationFrame(() => document.getElementById(`note-ta-${note.id}`)?.focus());
    } catch {/* ignore */}
  };
  const editBody = (id: string, body: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, body, updated_at: new Date().toISOString() } : n)));
    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => api.updateNote(id, { body }).catch(() => {}), 600);
  };
  const setColor = (id: string, color: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, color } : n)));
    api.updateNote(id, { color }).catch(() => {});
  };
  const togglePin = (id: string, pinned: boolean) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, pinned } : n)));
    api.updateNote(id, { pinned }).catch(() => {});
  };
  const remove = (id: string) => {
    if (!confirm("Delete this note?")) return;
    setNotes((prev) => prev.filter((n) => n.id !== id));
    api.deleteNote(id).catch(() => {});
  };

  const boardH = Math.max(520, ...notes.map((n) => n.y + NOTE_H + 24), 0);

  return (
    <div className="min-h-full flex flex-col" style={{ background: "var(--t-bg)" }}>
      <div className="px-6 py-4 flex items-center justify-between flex-shrink-0"
        style={{ background: "var(--t-s1)", borderBottom: "1px solid var(--t-b1)" }}>
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)" }}>Notes</h2>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--t-tx4)" }}>
            {notes.length === 0 ? "Pin quick notes to your board — drag to arrange" : `${notes.length} note${notes.length > 1 ? "s" : ""} · drag by the top bar to move`}
          </p>
        </div>
        <button onClick={addNote}
          className="btn-ripple flex items-center gap-1.5 text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium"
          style={{ background: "var(--accent-600)" }}>
          <Plus size={14} /> New note
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 p-6">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className={`skeleton rounded-2xl`} style={{ height: NOTE_H }} />)}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-28 animate-fade-up">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: "var(--accent-tint)", color: "var(--accent-400)" }}>
              <StickyNote size={24} />
            </div>
            <p className="text-[15px] font-semibold mb-1" style={{ color: "var(--t-tx1)" }}>Your board is empty</p>
            <p className="text-[13px] mb-5" style={{ color: "var(--t-tx4)" }}>Add a sticky note and drag it anywhere.</p>
            <button onClick={addNote} className="text-[13px] font-medium px-4 h-9 rounded-lg"
              style={{ background: "var(--accent-tint)", color: "var(--accent-400)", border: "1px solid var(--accent-glow)" }}>
              + Add your first note
            </button>
          </div>
        ) : (
          <div ref={boardRef} className="notes-board" style={{ minHeight: boardH }}>
            {notes.map((n) => {
              const c = colorOf(n.color);
              return (
                <div key={n.id} className="sticky-note"
                  style={{ left: n.x, top: n.y, width: NOTE_W, zIndex: n.pinned ? 5 : 1,
                    transform: `rotate(${stableRot(n.id)}deg)`,
                    background: `linear-gradient(162deg, ${c.fill}, transparent 78%), var(--t-s1)`,
                    borderColor: `${c.accent}55` }}>
                  <div className="sn-grip" onPointerDown={(e) => startDrag(e, n.id)} title="Drag to move">
                    <GripVertical size={13} style={{ color: c.accent, opacity: 0.8 }} />
                    <span className="sn-grip-fill" />
                    {n.pinned && <Pin size={12} style={{ color: c.accent, fill: c.accent }} />}
                  </div>
                  <textarea id={`note-ta-${n.id}`} value={n.body} onChange={(e) => editBody(n.id, e.target.value)}
                    placeholder="Write a note…" spellCheck={false} className="sn-body" style={{ color: "var(--t-tx1)" }} />
                  <div className="sn-foot">
                    <div className="sn-dots">
                      {COLORS.map((o) => (
                        <button key={o.key} title={o.key} onClick={() => setColor(n.id, o.key)} className="sn-dot"
                          style={{ background: o.accent, opacity: n.color === o.key ? 1 : 0.5, transform: n.color === o.key ? "scale(1.18)" : "none" }} />
                      ))}
                    </div>
                    <div className="sn-actions">
                      <button title={n.pinned ? "Unpin" : "Pin"} onClick={() => togglePin(n.id, !n.pinned)} style={{ color: n.pinned ? c.accent : "var(--t-tx4)" }}><Pin size={13} /></button>
                      <button title="Delete" onClick={() => remove(n.id)} className="sn-del" style={{ color: "var(--t-tx4)" }}><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <div className="sn-time" title={exactTime(n.updated_at)}>
                    {relTime(n.updated_at)}{n.author ? ` · ${n.author}` : ""}
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
