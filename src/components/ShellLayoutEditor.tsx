import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import Switch from "./Switch";
import { Row } from "./ui";
import {
  ALWAYS_SHOWN, CLOSED_SECTIONS, SECTION_NAME_MAX, SHELL_LAYOUT_EVENT, SHELL_LAYOUT_KEY,
  addSection, hiddenSections, isCustomSection, layoutSections, moveSection, moveTab, readShellLayout, removeSection,
  renameSection, setSectionIcon,
  type SectionDef, type SectionId, type ShellLayout,
} from "../lib/sections";
import { ICON_CHOICES, sectionIcon } from "../lib/sectionIcons";

// R-623: Settings > Appearance > Sidebar and tabs. The sidebar's order, which sections it shows, and the order
// of the tabs on each page. Per computer, like the rest of Appearance. Every change is saved as it is made
// and the shell redraws at once (App listens for SHELL_LAYOUT_EVENT), so what you see is what you get.
// Settings is not listed: it is where you put things back. More keeps the bottom of the sidebar with it.
//
// R-684: drag and drop. A page drags into any section (Home and Settings excepted), a section drags up or
// down the sidebar, New section makes one of your own, and any section can be renamed. The drag uses
// pointer events on the window, not HTML5 drag and drop, which the Windows Tauri window does not deliver.

const EMPTY: ShellLayout = { sections: [], hidden: [], tabs: {} };

type Drop = { section?: string; index: number };
type Drag = { kind: "tab" | "section"; id: string; label: string; x: number; y: number; to: Drop | null };

/** Where a drag would land, read off the rows on screen. Only the pointer's height matters, so a drag that
 *  strays sideways off the list still lands in the section level with it. */
function dropAt(root: HTMLElement, kind: Drag["kind"], id: string, y: number): Drop | null {
  const above = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 < y; };
  if (kind === "section") {
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-move-section]")].filter((b) => b.dataset.moveSection !== id);
    return { index: blocks.filter(above).length };
  }
  let zone: HTMLElement | null = null;
  let best = Infinity;
  for (const z of root.querySelectorAll<HTMLElement>("[data-drop-section]")) {
    const r = z.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < best) { best = d; zone = z; }
  }
  if (!zone?.dataset.dropSection) return null;
  const rows = [...zone.querySelectorAll<HTMLElement>("[data-tab-row]")].filter((r) => r.dataset.tabRow !== id);
  return { section: zone.dataset.dropSection, index: rows.filter(above).length };
}

/** The element that scrolls the settings page, so a drag held near its edge can scroll it. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Where a drop would land: a hairline in the accent, drawn without moving anything around it. */
const DropLine = () => (
  <div className="relative h-0" aria-hidden>
    <div className="absolute inset-x-0 -top-px h-0.5 rounded-full bg-accent" />
  </div>
);

export default function ShellLayoutEditor({ title }: { title: ReactNode }) {
  const [layout, setLayoutState] = useState<ShellLayout>(() => readShellLayout() ?? EMPTY);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sections = layoutSections(layout);
  const hidden = hiddenSections(layout);
  const changed = layout.sections.length > 0 || layout.hidden.length > 0 || Object.keys(layout.tabs).length > 0
    || (layout.custom?.length ?? 0) > 0 || Object.keys(layout.labels ?? {}).length > 0;

  const save = (next: ShellLayout | null) => {
    setLayoutState(next ?? EMPTY);
    try {
      if (next) localStorage.setItem(SHELL_LAYOUT_KEY, JSON.stringify(next));
      else localStorage.removeItem(SHELL_LAYOUT_KEY);
    } catch { /* a blocked store keeps the layout for this run only */ }
    window.dispatchEvent(new CustomEvent(SHELL_LAYOUT_EVENT, { detail: next }));
  };
  // The drag's window listeners are added once per drag; they read the current layout through this.
  const latest = useRef({ layout, save });
  latest.current = { layout, save };
  const start = useRef<Drag | null>(null);

  const toggle = (id: string) =>
    save({ ...layout, hidden: hidden.has(id) ? [...hidden].filter((h) => h !== id) : [...hidden, id] });
  const commitName = (id: string, name: string) => {
    const next = renameSection(layout, id, name);
    if (JSON.stringify(next) !== JSON.stringify(layout)) save(next);
    setRenaming(null);
  };
  const newSection = () => {
    const id = `mine-${Date.now().toString(36)}`;
    save(addSection(layout, id, "New section"));
    setPicking(null);
    setRenaming(id);
  };

  const beginDrag = (e: ReactPointerEvent, kind: Drag["kind"], id: string, label: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setRenaming(null);
    setPicking(null);
    start.current = { kind, id, label, x: e.clientX, y: e.clientY, to: null };
    setDrag(start.current);
  };
  const dragKey = drag ? `${drag.kind}:${drag.id}` : null;
  useEffect(() => {
    const begun = start.current;
    if (!dragKey || !begun) return;
    const { kind, id } = begun;
    const scroller = scrollerOf(rootRef.current);
    let { x, y } = begun;
    let to: Drop | null = null;
    let raf = 0;
    const place = () => {
      to = rootRef.current ? dropAt(rootRef.current, kind, id, y) : null;
      setDrag((d) => (d ? { ...d, x, y, to } : d));
    };
    const onMove = (e: PointerEvent) => { x = e.clientX; y = e.clientY; place(); };
    // Held near the top or bottom of the page, the page keeps scrolling so a drag can reach any section.
    const tick = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const step = y < r.top + 56 ? -14 : y > r.bottom - 56 ? 14 : 0;
        const was = scroller.scrollTop;
        if (step) scroller.scrollTop = was + step;
        if (scroller.scrollTop !== was) place();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const end = (drop: boolean) => {
      const { layout: l, save: commit } = latest.current;
      if (drop && to) {
        const next = kind === "section" ? moveSection(l, id, to.index) : to.section ? moveTab(l, id, to.section, to.index) : l;
        if (next !== l) commit(next);
      }
      start.current = null;
      setDrag(null);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(false); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragKey]);

  const grip = (kind: Drag["kind"], id: string, label: string) => (
    <button
      type="button"
      className="ui-ib flex-shrink-0 cursor-grab touch-none"
      onPointerDown={(e) => beginDrag(e, kind, id, label)}
      title={kind === "section" ? `Drag to move ${label} up or down the sidebar` : `Drag ${label} into any section`}
      aria-label={kind === "section" ? `Move ${label}` : `Move ${label} to another section`}
    >
      <GripVertical size={14} />
    </button>
  );

  const block = (s: SectionDef, movable: boolean) => {
    const off = hidden.has(s.id);
    const pinned = ALWAYS_SHOWN.includes(s.id as SectionId);
    const closed = CLOSED_SECTIONS.includes(s.id);
    const mine = isCustomSection(layout, s.id);
    const Icon = sectionIcon(s);
    const lifted = drag?.kind === "section" && drag.id === s.id;
    const dropHere = drag?.kind === "tab" && drag.to?.section === s.id ? drag.to.index : null;
    let n = 0; // rows drawn so far, not counting the one being dragged
    return (
      <div
        data-move-section={movable ? s.id : undefined}
        data-drop-section={closed ? undefined : s.id}
        className={`py-2.5 border-t border-line first:border-t-0 transition-opacity ${lifted ? "opacity-40" : ""}`}
      >
        <div className="flex items-center gap-2 h-9">
          {movable ? grip("section", s.id, s.label) : <span className="w-7 flex-shrink-0" />}
          <Switch on={!off} onToggle={() => toggle(s.id)} label={`Show ${s.label} in the sidebar`} disabled={pinned} />
          {mine ? (
            <button
              type="button" className="ui-ib flex-shrink-0" onClick={() => setPicking(picking === s.id ? null : s.id)}
              title="Choose an icon" aria-label={`Choose an icon for ${s.label}`} aria-expanded={picking === s.id}
            >
              <Icon size={16} />
            </button>
          ) : (
            <span className="w-7 flex-shrink-0 flex justify-center text-muted"><Icon size={16} /></span>
          )}
          {renaming === s.id ? (
            <input
              autoFocus defaultValue={s.label} maxLength={SECTION_NAME_MAX} aria-label={`Name of ${s.label}`}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitName(s.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { e.currentTarget.value = s.label; e.currentTarget.blur(); }
              }}
              className="border border-line-3 bg-transparent px-2.5 h-8 w-56 rounded-lg text-[13px] text-ink focus:outline-none focus:border-ink transition-colors"
            />
          ) : (
            <button
              type="button" onClick={() => setRenaming(s.id)} title={`Rename ${s.label}`}
              className={`min-w-0 truncate text-left text-[14px] font-medium h-8 px-1.5 -mx-1.5 rounded-md hover:bg-surface-3 transition-colors ${off ? "text-faint" : "text-ink"}`}
            >
              {s.label}
            </button>
          )}
          <span className="flex-1" />
          {s.id === "more" && <span className="text-[12px] text-faint">Stays at the bottom</span>}
          <button type="button" className="ui-ib flex-shrink-0" onClick={() => setRenaming(s.id)} title={`Rename ${s.label}`} aria-label={`Rename ${s.label}`}>
            <Pencil size={14} />
          </button>
          {mine && (
            <button
              type="button" className="ui-ib flex-shrink-0" onClick={() => save(removeSection(layout, s.id))}
              title="Remove this section. Its pages go back to where they were." aria-label={`Remove ${s.label}`}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {picking === s.id && (
          <div className="ml-[92px] mt-1.5 flex flex-wrap gap-1" role="group" aria-label={`Icon for ${s.label}`}>
            {Object.entries(ICON_CHOICES).map(([name, Choice]) => (
              <button
                key={name} type="button" aria-pressed={s.icon === name} aria-label={`Use the ${name} icon`}
                className={`ui-ib ${s.icon === name ? "ring-1 ring-ink text-ink" : ""}`}
                onClick={() => { save(setSectionIcon(layout, s.id, name)); setPicking(null); }}
              >
                <Choice size={16} />
              </button>
            ))}
          </div>
        )}
        {!closed && (
          <div className="ml-[92px] mt-1 pl-2 border-l border-line">
            {s.tabs.map((t) => {
              const held = drag?.kind === "tab" && drag.id === t.id;
              const line = !held && dropHere === n;
              if (!held) n++;
              return (
                <Fragment key={t.id}>
                  {line && <DropLine />}
                  <div data-tab-row={t.id} className={`flex items-center gap-2 h-8 transition-opacity ${held ? "opacity-40" : ""}`}>
                    {grip("tab", t.id, t.label)}
                    <span className={`flex-1 min-w-0 truncate text-[13px] ${off ? "text-faint" : "text-ink-2"}`}>{t.label}</span>
                  </div>
                </Fragment>
              );
            })}
            {dropHere !== null && dropHere >= n && n > 0 && <DropLine />}
            {n === 0 && (
              <div className={`h-8 flex items-center pl-1 text-[12px] ${dropHere !== null ? "text-ink" : "text-faint"}`}>
                No pages yet. Drag one here.
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // The movable band is everything above More; the stored order lists just those and the rest keep their place.
  const movable = sections.filter((s) => s.id !== "settings" && s.id !== "more");
  const sectionDrop = drag?.kind === "section" && drag.to ? drag.to.index : null;
  let m = 0;

  return (
    <>
      <Row
        title={title}
        sub="Drag a page into any section, or drag a section up or down the sidebar. New section makes one of your own; press a name to rename it. The first page in a section is where a click on it lands. Home and Settings always stay, and a section you switch off is still in search, All screens and split view."
      >
        <span className="flex items-center gap-2">
          <button type="button" className="ui-opt inline-flex items-center gap-1.5" onClick={newSection}>
            <Plus size={14} />New section
          </button>
          <button type="button" className="ui-opt" disabled={!changed} onClick={() => save(null)}>Reset to default</button>
        </span>
      </Row>
      <div ref={rootRef} className="pt-1">
        {movable.map((s) => {
          const lifted = drag?.kind === "section" && drag.id === s.id;
          const line = !lifted && sectionDrop === m;
          if (!lifted) m++;
          return (
            <Fragment key={s.id}>
              {line && <DropLine />}
              {block(s, true)}
            </Fragment>
          );
        })}
        {sectionDrop !== null && sectionDrop >= m && <DropLine />}
        {sections.filter((s) => s.id === "more").map((s) => <Fragment key={s.id}>{block(s, false)}</Fragment>)}
      </div>
      {drag && createPortal(
        <div
          className="fixed z-50 pointer-events-none flex items-center gap-2 h-8 px-3 rounded-lg bg-surface ring-1 ring-line shadow-lg text-[13px] font-medium text-ink"
          style={{ left: drag.x + 14, top: drag.y - 16 }}
        >
          <GripVertical size={14} className="text-muted" />
          {drag.label}
        </div>,
        document.body,
      )}
    </>
  );
}
