import { useEffect, useState, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Note } from "../lib/api";
import { Plus, Pin, Trash2, StickyNote, GripVertical, Lock, Flag, Check, Clock } from "lucide-react";

const COLORS: { key: string; fill: string; accent: string }[] = [
  { key: "yellow", fill: "rgba(250,204,21,0.18)",  accent: "#FACC15" },
  { key: "blue",   fill: "rgba(96,165,250,0.18)",  accent: "#60A5FA" },
  { key: "green",  fill: "rgba(52,211,153,0.18)",  accent: "#34D399" },
  { key: "pink",   fill: "rgba(244,114,182,0.18)", accent: "#F472B6" },
  { key: "purple", fill: "rgba(167,139,250,0.18)", accent: "#A78BFA" },
  { key: "orange", fill: "rgba(251,146,60,0.18)",  accent: "#FB923C" },
];
const colorOf = (k: string) => COLORS.find((c) => c.key === k) || COLORS[0];
const NOTE_W = 226, NOTE_H = 190;      // defaults for a fresh note
const MIN_W = 180, MIN_H = 175;        // smallest a note can be stretched to
const wOf = (n: Note) => n.w || NOTE_W;
const hOf = (n: Note) => n.h || NOTE_H;
// Body text scales with the note's area so a bigger note reads bigger/more important.
// √(area ratio) keeps it proportional; clamped so it stays legible either way.
const BASE_AREA = NOTE_W * NOTE_H;
const fontScale = (n: Note) => Math.max(0.9, Math.min(1.9, Math.sqrt((wOf(n) * hOf(n)) / BASE_AREA)));

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

// Urgency drives how prominently a note reads AND how quickly it counts as "posted too
// long" (its staleness window). Order matters for cycling + sorting the attention list.
const URGENCY: Record<string, { label: string; color: string; staleDays: number; rank: number }> = {
  normal: { label: "Normal", color: "var(--t-tx4)", staleDays: 14, rank: 0 },
  high:   { label: "High",   color: "#FB923C",      staleDays: 5,  rank: 1 },
  urgent: { label: "Urgent", color: "#F43F5E",      staleDays: 2,  rank: 2 },
};
const urg = (n: Note) => URGENCY[n.urgency] || URGENCY.normal;
const NEXT_URGENCY: Record<string, string> = { normal: "high", high: "urgent", urgent: "normal" };
// Staleness is measured from the last "still needed" confirmation (reviewed_at), falling
// back to when it was created. A note is stale once it passes its urgency's window.
const ageDays = (iso: string) => { const t = new Date(iso).getTime(); return t ? (Date.now() - t) / 86_400_000 : 0; };
const noteAge = (n: Note) => ageDays(n.reviewed_at || n.created_at);
const isStale = (n: Note) => noteAge(n) >= urg(n).staleDays;
const staleLabel = (n: Note) => { const d = Math.floor(noteAge(n)); return d <= 0 ? "today" : d === 1 ? "1 day" : `${d} days`; };
const notePreview = (n: Note) => { const t = (n.body || "").trim().replace(/\s+/g, " "); return t ? (t.length > 40 ? t.slice(0, 40) + "…" : t) : "Empty note"; };

// A lock older than this is treated as stale (the editor left without releasing) —
// well above the 5s pull cadence + ~30s renew, so an active editor never flickers.
const LOCK_TTL_MS = 75000;

export default function NotesView({ me }: { me: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null); // pulsed when jumped to from the attention strip
  const boardRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<Note[]>([]);
  notesRef.current = notes;
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const resize = useRef<{ id: string; startX: number; startY: number; startW: number; startH: number; moved: boolean } | null>(null);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingBodies = useRef<Record<string, string>>({}); // last unsaved body per note
  const pendingCreates = useRef<Set<string>>(new Set());     // ids created locally, not yet echoed by the server
  const heldLock = useRef<string | null>(null);              // note id whose edit-lock this device holds
  const lastRenew = useRef<number>(0);                       // last time we re-stamped the held lock

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

  // Live-share: when a sync pull applies (the other admin posted/edited/resized a
  // note on his device), fold the incoming notes in immediately — without yanking a
  // note out from under an active drag/resize/edit, and without dropping a note this
  // device just created that the server hasn't echoed back yet.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => {
      api.listNotes().then((incoming) => {
        setNotes((prev) => {
          const activeId = drag.current?.id || resize.current?.id;
          const ae = document.activeElement as HTMLElement | null;
          const focusedId = ae?.id?.startsWith("note-ta-") ? ae.id.slice(8) : null;
          const incIds = new Set(incoming.map((n) => n.id));
          // The server now knows these ids — they're no longer pending creates.
          for (const id of incIds) pendingCreates.current.delete(id);
          const ts = (s: string) => new Date(s).getTime() || 0; // epoch, so 'Z' vs '+00:00' formats compare correctly
          const merged = incoming.map((inc) => {
            const local = prev.find((p) => p.id === inc.id);
            if (!local) return inc;
            const keepLocal = inc.id === activeId || inc.id === focusedId || ts(local.updated_at) > ts(inc.updated_at);
            return keepLocal ? local : inc;
          });
          // Re-add ONLY notes this device created that the server hasn't echoed yet.
          // A note missing from `incoming` because it was deleted elsewhere must NOT
          // be resurrected (the old code re-added every missing note).
          for (const p of prev) if (!incIds.has(p.id) && pendingCreates.current.has(p.id)) merged.push(p);
          return merged;
        });
      }).catch(() => {});
    }).then((u) => { un = u; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  // Near-live: while the board is open, pull remote changes every ~5s (and on
  // window focus) so a teammate's note appears in seconds, not on the 20s loop.
  useEffect(() => {
    const kick = () => { api.pullNow().catch(() => {}); };
    const iv = setInterval(kick, 5000);
    window.addEventListener("focus", kick);
    return () => { clearInterval(iv); window.removeEventListener("focus", kick); };
  }, []);

  // On unmount (e.g. switching tabs), flush any debounced body edit that hasn't
  // saved yet — otherwise the last keystrokes are lost when the view tears down.
  useEffect(() => () => {
    for (const id of Object.keys(saveTimers.current)) {
      clearTimeout(saveTimers.current[id]);
      const body = pendingBodies.current[id];
      if (body !== undefined) api.updateNote(id, { body }).catch(() => {});
    }
    // Release the edit-lock so leaving the tab doesn't strand a note locked.
    if (heldLock.current) api.setNoteEditing(heldLock.current, false).catch(() => {});
  }, []);

  // Drag + resize — global listeners read the latest via refs (no stale closures).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const rz = resize.current;
      if (rz) {
        rz.moved = true;
        const w = Math.max(MIN_W, rz.startW + (e.clientX - rz.startX));
        const h = Math.max(MIN_H, rz.startH + (e.clientY - rz.startY));
        setNotes((prev) => prev.map((n) => (n.id === rz.id ? { ...n, w, h } : n)));
        return;
      }
      const d = drag.current, board = boardRef.current; if (!d || !board) return;
      const rect = board.getBoundingClientRect();
      const cur = notesRef.current.find((n) => n.id === d.id);
      const w = cur ? wOf(cur) : NOTE_W;
      let x = e.clientX - rect.left - d.dx;
      let y = e.clientY - rect.top - d.dy;
      x = Math.max(0, Math.min(board.clientWidth - w, x));
      y = Math.max(0, y);
      d.moved = true;
      setNotes((prev) => prev.map((n) => (n.id === d.id ? { ...n, x, y } : n)));
    };
    const up = () => {
      const rz = resize.current;
      if (rz) {
        resize.current = null;
        document.body.style.userSelect = "";
        const n = notesRef.current.find((x) => x.id === rz.id);
        if (n && rz.moved) {
          setNotes((prev) => prev.map((m) => (m.id === rz.id ? { ...m, updated_at: new Date().toISOString() } : m)));
          api.updateNote(n.id, { w: Math.round(wOf(n)), h: Math.round(hOf(n)) }).catch(() => {});
        }
        return;
      }
      const d = drag.current; if (!d) return; drag.current = null;
      document.body.style.userSelect = "";
      const n = notesRef.current.find((x) => x.id === d.id);
      if (n && d.moved) {
        setNotes((prev) => prev.map((m) => (m.id === d.id ? { ...m, updated_at: new Date().toISOString() } : m)));
        api.updateNote(n.id, { x: Math.round(n.x), y: Math.round(n.y) }).catch(() => {});
      }
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

  const startResize = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const n = notesRef.current.find((x) => x.id === id);
    if (!n) return;
    resize.current = { id, startX: e.clientX, startY: e.clientY, startW: wOf(n), startH: hOf(n), moved: false };
    document.body.style.userSelect = "none";
  };

  const addNote = async () => {
    const w = boardRef.current?.clientWidth || 800;
    const k = notes.length % 7;
    const x = Math.max(16, Math.min(w - NOTE_W - 16, 48 + k * 30));
    const y = 24 + k * 28;
    try {
      const note = await api.createNote("", "yellow", x, y);
      pendingCreates.current.add(note.id); // protect it in the merge until the server echoes it
      setNotes((p) => [...p, note]);
      requestAnimationFrame(() => document.getElementById(`note-ta-${note.id}`)?.focus());
    } catch {/* ignore */}
  };
  // Bump updated_at on every optimistic change so the sync merge's newer-wins guard
  // protects it — otherwise a concurrent pull could snap the note back to its old value.
  const now = () => new Date().toISOString();

  // Advisory edit-lock. lockedBy returns the OTHER user currently editing a note
  // (empty/self/stale-TTL → not locked). Acquire on focus, release on blur/unmount;
  // renew while typing so a long edit doesn't TTL-expire under a teammate.
  const lockedBy = (n: Note): string | null => {
    if (!n.editing_by || n.editing_by === me) return null;
    const at = Date.parse(n.editing_at || "");
    if (!at || Date.now() - at > LOCK_TTL_MS) return null;
    return n.editing_by;
  };
  const acquireLock = (id: string) => {
    heldLock.current = id; lastRenew.current = Date.now();
    api.setNoteEditing(id, true).catch(() => {});
  };
  const releaseLock = (id: string) => {
    if (heldLock.current !== id) return; // only release a lock we actually hold
    heldLock.current = null;
    api.setNoteEditing(id, false).catch(() => {});
  };

  const editBody = (id: string, body: string) => {
    pendingBodies.current[id] = body;
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, body, updated_at: now() } : n)));
    // Keep the lock fresh during a long edit (throttled well under the TTL).
    if (heldLock.current === id && Date.now() - lastRenew.current > 25000) {
      lastRenew.current = Date.now();
      api.setNoteEditing(id, true).catch(() => {});
    }
    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => {
      api.updateNote(id, { body }).catch(() => {});
      delete pendingBodies.current[id]; delete saveTimers.current[id];
    }, 600);
  };
  const setColor = (id: string, color: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, color, updated_at: now() } : n)));
    api.updateNote(id, { color }).catch(() => {});
  };
  const togglePin = (id: string, pinned: boolean) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, pinned, updated_at: now() } : n)));
    api.updateNote(id, { pinned }).catch(() => {});
  };
  const remove = (id: string) => {
    if (!confirm("Delete this note?")) return;
    clearTimeout(saveTimers.current[id]); // cancel a pending body save so it can't fire post-delete
    delete saveTimers.current[id]; delete pendingBodies.current[id];
    pendingCreates.current.delete(id);
    if (heldLock.current === id) heldLock.current = null;
    setNotes((prev) => prev.filter((n) => n.id !== id));
    api.deleteNote(id).catch(() => {});
  };

  // Cycle urgency normal → high → urgent → normal.
  const cycleUrgency = (id: string) => {
    const cur = notesRef.current.find((n) => n.id === id);
    const next = NEXT_URGENCY[cur?.urgency || "normal"] || "normal";
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, urgency: next, updated_at: now() } : n)));
    api.updateNote(id, { urgency: next }).catch(() => {});
  };
  // "Still needed" — the keep-active check. Resets the staleness clock (reviewed_at=now).
  const keep = (id: string) => {
    const iso = now();
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, reviewed_at: iso, updated_at: iso } : n)));
    api.keepNote(id).catch(() => {});
  };
  // Jump from the attention strip to a note on the board and pulse it briefly.
  const focusNote = (id: string) => {
    const el = document.getElementById(`note-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    setTimeout(() => setHighlightId((h) => (h === id ? null : h)), 1600);
  };

  const boardH = Math.max(520, ...notes.map((n) => n.y + hOf(n) + 24), 0);
  // What needs a look: notes past their staleness window, most-urgent + longest-up first.
  const attention = notes
    .filter(isStale)
    .sort((a, b) => (urg(b).rank - urg(a).rank) || (noteAge(b) - noteAge(a)));

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

      {attention.length > 0 && (
        <div className="px-6 py-3 flex-shrink-0" style={{ background: "var(--t-s1)", borderBottom: "1px solid var(--t-b1)" }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={13} style={{ color: "#FB923C" }} />
            <span className="text-[12px] font-medium" style={{ color: "var(--t-tx2)" }}>
              {attention.length} note{attention.length > 1 ? "s" : ""} up for a while — still needed?
            </span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {attention.map((n) => {
              const u = urg(n);
              return (
                <div key={n.id}
                  className="flex items-center gap-2 flex-shrink-0 rounded-lg pl-2.5 pr-1.5 py-1.5"
                  style={{ background: "var(--t-s2)", border: "1px solid var(--t-b1)", borderLeft: `3px solid ${u.color}` }}>
                  <button onClick={() => focusNote(n.id)} className="text-left max-w-[190px]" title="Show on board">
                    <div className="text-[12px] truncate" style={{ color: "var(--t-tx1)" }}>{notePreview(n)}</div>
                    <div className="text-[10.5px]" style={{ color: "var(--t-tx4)" }}>
                      up {staleLabel(n)}{n.urgency !== "normal" ? ` · ${u.label.toLowerCase()}` : ""}
                    </div>
                  </button>
                  <button onClick={() => keep(n.id)} title="Keep — still needed"
                    className="w-7 h-7 flex items-center justify-center rounded-md flex-shrink-0"
                    style={{ color: "#34D399" }}><Check size={14} /></button>
                  <button onClick={() => remove(n.id)} title="Delete"
                    className="w-7 h-7 flex items-center justify-center rounded-md flex-shrink-0"
                    style={{ color: "var(--t-tx4)" }}><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
              const locker = lockedBy(n);
              const u = urg(n);
              const stale = isStale(n);
              const hot = highlightId === n.id;
              const emphasize = stale || n.urgency !== "normal";
              return (
                <div key={n.id} id={`note-${n.id}`} className="sticky-note"
                  style={{ left: n.x, top: n.y, width: wOf(n), height: hOf(n), minHeight: 0, zIndex: n.pinned || hot ? 6 : 1,
                    transform: `rotate(${stableRot(n.id)}deg)`, transition: "box-shadow 160ms ease",
                    background: `linear-gradient(162deg, ${c.fill}, transparent 78%), var(--t-s1)`,
                    borderColor: locker ? `${c.accent}` : stale ? "#FB923C" : (n.urgency !== "normal" ? u.color : `${c.accent}55`),
                    borderWidth: emphasize ? 2 : undefined,
                    boxShadow: hot ? `0 0 0 3px ${u.color}, 0 8px 24px rgba(0,0,0,0.16)` : undefined }}>
                  <div className="sn-grip" onPointerDown={(e) => startDrag(e, n.id)} title="Drag to move">
                    <GripVertical size={13} style={{ color: c.accent, opacity: 0.8 }} />
                    {!locker && n.urgency !== "normal" && (
                      <span className="flex items-center gap-1 text-[10px] font-medium" style={{ color: u.color }} title={`${u.label} urgency`}>
                        <Flag size={9} /> {u.label}
                      </span>
                    )}
                    <span className="sn-grip-fill" />
                    {locker && (
                      <span className="flex items-center gap-1 text-[10px] font-medium truncate"
                        style={{ color: c.accent }} title={`${locker} is editing this note`}>
                        <Lock size={10} /> {locker} editing
                      </span>
                    )}
                    {n.pinned && <Pin size={12} style={{ color: c.accent, fill: c.accent }} />}
                  </div>
                  <textarea id={`note-ta-${n.id}`} value={n.body} onChange={(e) => editBody(n.id, e.target.value)}
                    onFocus={() => { if (!locker) acquireLock(n.id); }} onBlur={() => releaseLock(n.id)}
                    readOnly={!!locker}
                    placeholder={locker ? "" : "Write a note…"} spellCheck={false} className="sn-body"
                    style={{ color: "var(--t-tx1)", fontSize: `${(13.5 * fontScale(n)).toFixed(1)}px`, lineHeight: 1.5,
                             cursor: locker ? "not-allowed" : "text", opacity: locker ? 0.7 : 1 }} />
                  <div className="sn-foot">
                    <div className="sn-dots">
                      {COLORS.map((o) => (
                        <button key={o.key} title={o.key} onClick={() => setColor(n.id, o.key)} className="sn-dot"
                          style={{ background: o.accent, opacity: n.color === o.key ? 1 : 0.5, transform: n.color === o.key ? "scale(1.18)" : "none" }} />
                      ))}
                    </div>
                    <div className="sn-actions">
                      <button title={`Urgency: ${u.label} — click to change`} onClick={() => cycleUrgency(n.id)}
                        style={{ color: n.urgency === "normal" ? "var(--t-tx4)" : u.color }}><Flag size={13} /></button>
                      <button title={n.pinned ? "Unpin" : "Pin"} onClick={() => togglePin(n.id, !n.pinned)} style={{ color: n.pinned ? c.accent : "var(--t-tx4)" }}><Pin size={13} /></button>
                      {!locker && <button title="Delete" onClick={() => remove(n.id)} className="sn-del" style={{ color: "var(--t-tx4)" }}><Trash2 size={13} /></button>}
                    </div>
                  </div>
                  <div className="sn-time" title={exactTime(n.updated_at)}
                    style={stale ? { color: "#FB923C", display: "flex", alignItems: "center", gap: 5 } : undefined}>
                    {stale ? (
                      <>
                        <Clock size={10} /> up {staleLabel(n)}
                        <button onClick={() => keep(n.id)} title="Still needed — keep it (resets the clock)"
                          className="flex items-center gap-0.5 rounded px-1" style={{ color: "#34D399", fontWeight: 600, marginLeft: 2 }}>
                          <Check size={11} /> Keep
                        </button>
                      </>
                    ) : (
                      <>{relTime(n.updated_at)}{n.author ? ` · ${n.author}` : ""}</>
                    )}
                  </div>
                  <div
                    onPointerDown={(e) => startResize(e, n.id)}
                    title="Drag to resize"
                    style={{
                      position: "absolute", right: 3, bottom: 3, width: 14, height: 14,
                      cursor: "nwse-resize", touchAction: "none",
                      borderRight: `2px solid ${c.accent}`, borderBottom: `2px solid ${c.accent}`,
                      borderBottomRightRadius: 9, opacity: 0.5,
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
