import { useEffect, useState, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Note } from "../lib/api";
import { Plus, Pin, Trash2, StickyNote, GripVertical, Lock, Flag, Check, Clock } from "lucide-react";
import { Button, PageActions } from "./ui";

const COLORS: { key: string; name: string; accent: string }[] = [
  { key: "yellow", name: "Yellow", accent: "#FFD60A" },
  { key: "blue",   name: "Blue",   accent: "#0A84FF" },
  { key: "green",  name: "Green",  accent: "#30D158" },
  { key: "pink",   name: "Pink",   accent: "#FF375F" },
  { key: "purple", name: "Purple", accent: "#BF5AF2" },
  { key: "orange", name: "Orange", accent: "#FF9F0A" },
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
  normal: { label: "Normal", color: "rgb(var(--c-faint))",      staleDays: 14, rank: 0 },
  high:   { label: "High",   color: "rgb(var(--c-ink))",        staleDays: 5,  rank: 1 },
  urgent: { label: "Urgent", color: "rgb(var(--c-danger-ink))", staleDays: 2,  rank: 2 },
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
  const [confirmId, setConfirmId] = useState<string | null>(null);     // the note whose delete is waiting on a second click
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
    setConfirmId(null);
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

  // Delete asks on the note itself (Cancel / Delete), and brings the note into view.
  const askRemove = (id: string) => { setConfirmId(id); focusNote(id); };

  const boardH = Math.max(520, ...notes.map((n) => n.y + hOf(n) + 24), 0);
  // What needs a look: notes past their staleness window, most-urgent + longest-up first.
  const attention = notes
    .filter(isStale)
    .sort((a, b) => (urg(b).rank - urg(a).rank) || (noteAge(b) - noteAge(a)));

  return (
    <div className="flex flex-col">
      <PageActions>
        <span className="text-[12px] text-muted">
          {notes.length === 0 ? "Pin quick notes to your board, drag to arrange" : `${notes.length} note${notes.length > 1 ? "s" : ""}, drag by the top bar to move`}
        </span>
        <Button variant="ink" icon={<Plus size={14} />} onClick={addNote}>New note</Button>
      </PageActions>

      {attention.length > 0 && (
        <>
          <section aria-label="Notes that need a look" className="pb-4">
            <div className="flex items-center gap-2 mb-3 text-[13px] font-medium text-ink">
              <Clock size={16} className="text-muted" />
              {attention.length} note{attention.length > 1 ? "s" : ""} up for a while, still needed?
            </div>
            <div className="flex gap-2.5 overflow-x-auto pb-1">
              {attention.map((n) => {
                const u = urg(n);
                return (
                  <div key={n.id}
                    className="flex items-center gap-1 flex-shrink-0 rounded-[10px] bg-surface-2 border border-line pl-3 pr-1.5 py-1.5"
                    style={{ boxShadow: `inset 3px 0 0 ${u.color}` }}>
                    <button onClick={() => focusNote(n.id)} className="text-left max-w-[220px] min-w-0 pl-1 pr-2" title="Show on board">
                      <div className="text-[13px] font-medium text-ink truncate">{notePreview(n)}</div>
                      <div className="text-[12px] text-muted">
                        up {staleLabel(n)}{n.urgency !== "normal" ? `, ${u.label.toLowerCase()}` : ""}
                      </div>
                    </button>
                    <button onClick={() => keep(n.id)} title="Keep (still needed)" aria-label="Keep, still needed" className="ui-ib flex-shrink-0">
                      <Check size={16} />
                    </button>
                    <button onClick={() => askRemove(n.id)} title="Delete" aria-label="Delete note" className="ui-ib flex-shrink-0 hover:!text-danger-ink">
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
          <div className="hsep" />
        </>
      )}

      <div>
        {loading ? (
          <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 pt-4">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton rounded-xl" style={{ height: NOTE_H }} />)}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-28 animate-fade-up">
            <StickyNote size={22} className="text-muted" />
            <p className="m-0 mt-3 mb-1 text-[15px] font-medium text-ink">Your board is empty</p>
            <p className="m-0 mb-5 text-[13px] text-muted">Add a sticky note and drag it anywhere.</p>
            <Button icon={<Plus size={14} />} onClick={addNote}>Add your first note</Button>
          </div>
        ) : (
          <div ref={boardRef} className="relative w-full mt-4" style={{ minHeight: boardH, touchAction: "none" }}>
            {notes.map((n) => {
              const c = colorOf(n.color);
              const locker = lockedBy(n);
              const u = urg(n);
              const stale = isStale(n);
              const hot = highlightId === n.id;
              const emphasize = stale || n.urgency !== "normal";
              const confirming = confirmId === n.id;
              const border = locker ? c.accent : n.urgency !== "normal" ? u.color : stale ? "rgb(var(--c-muted))" : `${c.accent}66`;
              return (
                <div key={n.id} id={`note-${n.id}`}
                  className="absolute flex flex-col overflow-hidden rounded-xl"
                  style={{ left: n.x, top: n.y, width: wOf(n), height: hOf(n), zIndex: n.pinned || hot ? 6 : 1,
                    transform: `rotate(${stableRot(n.id)}deg)`,
                    transition: "box-shadow 160ms var(--ease), filter 160ms var(--ease)",
                    animation: "noteIn 0.26s var(--ease) both",
                    background: `linear-gradient(162deg, ${c.accent}2E, transparent 78%), rgb(var(--c-surface-2))`,
                    boxShadow: `inset 0 0 0 ${emphasize ? 1.5 : 1}px ${border}`,
                    outline: hot ? "3px solid rgb(var(--c-ink))" : undefined, outlineOffset: hot ? 2 : undefined,
                    filter: n.pinned ? "drop-shadow(0 10px 18px rgba(0,0,0,0.35))" : undefined }}>
                  <div className="flex items-center gap-2 flex-none h-7 px-2 select-none cursor-grab active:cursor-grabbing"
                    style={{ touchAction: "none" }} onPointerDown={(e) => startDrag(e, n.id)} title="Drag to move">
                    <GripVertical size={16} className="text-faint" />
                    {!locker && n.urgency !== "normal" && (
                      <span className="flex items-center gap-1 text-[12px] font-medium" style={{ color: n.urgency === "urgent" ? u.color : "rgb(var(--c-ink))" }} title={`${u.label} urgency`}>
                        <Flag size={12} /> {u.label}
                      </span>
                    )}
                    <span className="flex-1 h-full" />
                    {locker && (
                      <span className="flex items-center gap-1 text-[12px] font-medium truncate text-muted" title={`${locker} is editing this note`}>
                        <Lock size={12} /> {locker} editing
                      </span>
                    )}
                    {n.pinned && <Pin size={14} className="text-ink" fill="currentColor" />}
                  </div>
                  <textarea id={`note-ta-${n.id}`} value={n.body} onChange={(e) => editBody(n.id, e.target.value)}
                    onFocus={() => { if (!locker) acquireLock(n.id); }} onBlur={() => releaseLock(n.id)}
                    readOnly={!!locker}
                    placeholder={locker ? "" : "Write a note…"} spellCheck={false}
                    className="flex-1 min-h-0 w-full bg-transparent border-0 outline-none resize-none text-ink px-3 pt-0.5 pb-1"
                    style={{ fontSize: `${(13.5 * fontScale(n)).toFixed(1)}px`, lineHeight: 1.5,
                             cursor: locker ? "not-allowed" : "text", opacity: locker ? 0.7 : 1 }} />
                  {confirming ? (
                    <div className="flex items-center justify-between gap-1.5 flex-none px-2 py-1 bg-surface-2">
                      <span className="text-[12.5px] font-medium text-ink">Delete this note?</span>
                      <span className="flex gap-1.5">
                        <Button size="sm" onClick={() => setConfirmId(null)}>Cancel</Button>
                        <Button size="sm" variant="danger" onClick={() => remove(n.id)}>Delete</Button>
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-1.5 flex-none px-2 py-1">
                      <div className="flex gap-1.5" role="group" aria-label="Note colour">
                        {COLORS.map((o) => (
                          <button key={o.key} title={o.name} aria-label={o.name} onClick={() => setColor(n.id, o.key)}
                            className="w-3.5 h-3.5 p-0 border-0 rounded-full cursor-pointer"
                            style={{ background: o.accent, opacity: n.color === o.key ? 1 : 0.45, transform: n.color === o.key ? "scale(1.2)" : "none",
                                     transition: "transform 150ms var(--ease), opacity 150ms var(--ease)" }} />
                        ))}
                      </div>
                      <div className="flex gap-0.5">
                        <button title={`Urgency: ${u.label}, click to change`} aria-label={`Urgency: ${u.label}, click to change`} onClick={() => cycleUrgency(n.id)}
                          className="ui-ib !w-6 !h-6" style={{ color: u.color }}><Flag size={14} /></button>
                        <button title={n.pinned ? "Unpin" : "Pin"} aria-label={n.pinned ? "Unpin" : "Pin"} onClick={() => togglePin(n.id, !n.pinned)}
                          className="ui-ib !w-6 !h-6" style={{ color: n.pinned ? "rgb(var(--c-ink))" : "rgb(var(--c-faint))" }}><Pin size={14} /></button>
                        {!locker && <button title="Delete" aria-label="Delete note" onClick={() => setConfirmId(n.id)}
                          className="ui-ib !w-6 !h-6 hover:!text-danger-ink" style={{ color: "rgb(var(--c-faint))" }}><Trash2 size={14} /></button>}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 flex-none px-3 pb-2 text-[12px] text-faint" title={exactTime(n.updated_at)}>
                    {stale ? (
                      <>
                        <Clock size={12} /> <span className="text-ink">up {staleLabel(n)}</span>
                        <button onClick={() => keep(n.id)} title="Still needed, keep it (resets the clock)"
                          className="flex items-center gap-0.5 rounded px-1 text-[12px] font-medium text-ink hover:opacity-70 transition-opacity">
                          <Check size={12} /> Keep
                        </button>
                      </>
                    ) : (
                      <>{relTime(n.updated_at)}{n.author ? ` · ${n.author}` : ""}</>
                    )}
                  </div>
                  <div
                    onPointerDown={(e) => startResize(e, n.id)}
                    title="Drag to resize" aria-hidden="true"
                    className="absolute right-1 bottom-1 w-3 h-3 opacity-60 border-r-2 border-b-2 border-faint rounded-br-[7px]"
                    style={{ cursor: "nwse-resize", touchAction: "none" }}
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
