import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import Switch from "./Switch";
import { Row } from "./ui";
import {
  ALWAYS_SHOWN, SHELL_LAYOUT_EVENT, SHELL_LAYOUT_KEY, hiddenSections, layoutSections, readShellLayout,
  type SectionDef, type ShellLayout,
} from "../lib/sections";

// R-623: Settings > Appearance > Sidebar and tabs. The sidebar's order, which sections it shows, and the order
// of the tabs on each page. Per computer, like the rest of Appearance. Every change is saved as it is made
// and the shell redraws at once (App listens for SHELL_LAYOUT_EVENT), so what you see is what you get.
// Settings is not listed: it is where you put things back. More keeps the bottom of the sidebar with it.

const EMPTY: ShellLayout = { sections: [], hidden: [], tabs: {} };

function swap(ids: string[], id: string, dir: -1 | 1): string[] {
  const at = ids.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

export default function ShellLayoutEditor({ title }: { title: ReactNode }) {
  const [layout, setLayoutState] = useState<ShellLayout>(() => readShellLayout() ?? EMPTY);
  const sections = layoutSections(layout);
  const hidden = hiddenSections(layout);
  const changed = layout.sections.length > 0 || layout.hidden.length > 0 || Object.keys(layout.tabs).length > 0;

  const save = (next: ShellLayout | null) => {
    setLayoutState(next ?? EMPTY);
    try {
      if (next) localStorage.setItem(SHELL_LAYOUT_KEY, JSON.stringify(next));
      else localStorage.removeItem(SHELL_LAYOUT_KEY);
    } catch { /* a blocked store keeps the layout for this run only */ }
    window.dispatchEvent(new CustomEvent(SHELL_LAYOUT_EVENT, { detail: next }));
  };
  // The movable band is everything above More; the stored order lists just those and the rest keep their place.
  const movable = sections.filter((s) => s.id !== "settings" && s.id !== "more");
  const moveSection = (id: string, dir: -1 | 1) => save({ ...layout, sections: swap(movable.map((s) => s.id), id, dir) });
  const moveTab = (s: SectionDef, id: string, dir: -1 | 1) =>
    save({ ...layout, tabs: { ...layout.tabs, [s.id]: swap(s.tabs.map((t) => t.id), id, dir) } });
  const toggle = (id: string) =>
    save({ ...layout, hidden: hidden.has(id) ? [...hidden].filter((h) => h !== id) : [...hidden, id] });

  const arrows = (onUp: (() => void) | null, onDown: (() => void) | null, what: string) => (
    <span className="flex items-center gap-0.5 flex-shrink-0">
      <button type="button" className="ui-ib" disabled={!onUp} onClick={onUp ?? undefined} title={`Move ${what} up`} aria-label={`Move ${what} up`}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="ui-ib" disabled={!onDown} onClick={onDown ?? undefined} title={`Move ${what} down`} aria-label={`Move ${what} down`}>
        <ChevronDown size={14} />
      </button>
    </span>
  );

  const sectionRow = (s: SectionDef, at: number, movableHere: boolean) => {
    const off = hidden.has(s.id);
    const pinned = ALWAYS_SHOWN.includes(s.id);
    return (
      <div key={s.id} className="py-1">
        <div className="flex items-center gap-3 h-9">
          <Switch on={!off} onToggle={() => toggle(s.id)} label={`Show ${s.label} in the sidebar`} disabled={pinned} />
          <span className={`flex-1 min-w-0 truncate text-[13px] font-medium ${off ? "text-faint" : "text-ink"}`}>{s.label}</span>
          {movableHere
            ? arrows(at > 0 ? () => moveSection(s.id, -1) : null, at < movable.length - 1 ? () => moveSection(s.id, 1) : null, s.label)
            : <span className="text-[12px] text-faint">Stays at the bottom</span>}
        </div>
        {s.tabs.length > 1 && (
          <div className="ml-[52px] mb-1 pl-3 border-l border-line">
            {s.tabs.map((t, i) => (
              <div key={t.id} className="flex items-center gap-3 h-7">
                <span className={`flex-1 min-w-0 truncate text-[13px] ${off ? "text-faint" : "text-ink-2"}`}>{t.label}</span>
                {arrows(i > 0 ? () => moveTab(s, t.id, -1) : null, i < s.tabs.length - 1 ? () => moveTab(s, t.id, 1) : null, t.label)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <Row
        title={title}
        sub="Which sections the sidebar shows and in what order, and the order of the tabs on each page. The first tab is where a click on the section lands. Home and Settings always stay; a section you switch off is still in search, All screens and split view."
      >
        <button type="button" className="ui-opt" disabled={!changed} onClick={() => save(null)}>Reset to default</button>
      </Row>
      <div className="pt-1">
        {movable.map((s, at) => sectionRow(s, at, true))}
        {sections.filter((s) => s.id === "more").map((s) => sectionRow(s, 0, false))}
      </div>
    </>
  );
}
