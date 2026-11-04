import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// The mockups' tab bar: a chip track, the active tab lit by a thumb that glides to it.
// Used by the shell for a section's screens, and by any screen for tabs inside one view.
// Keyboard: Left/Right/Home/End move between tabs (and select them), Tab leaves the bar.

export interface TabItem {
  id: string;
  label: ReactNode;
  /** A number shown after the label (unread, waiting). 0 or undefined shows nothing. */
  count?: number;
  /** urgent = red text, draft = amber text, calm (default) = ink. */
  countTone?: "calm" | "urgent" | "draft";
  disabled?: boolean;
  title?: string;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the bar, e.g. "Money". */
  label?: string;
  className?: string;
}

export default function Tabs({ tabs, value, onChange, label, className }: TabsProps) {
  const track = useRef<HTMLDivElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  // The first placement must not glide in from the left edge: it is placed with transitions off, then shown.
  const [ready, setReady] = useState(false);

  const measure = () => {
    const el = buttons.current[value];
    if (!el) { setThumb(null); return; }
    setThumb((t) => (t && t.x === el.offsetLeft && t.w === el.offsetWidth ? t : { x: el.offsetLeft, w: el.offsetWidth }));
  };

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, tabs.map((t) => `${t.id}:${t.count ?? ""}`).join("|")]);

  useEffect(() => {
    if (!thumb || ready) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [thumb, ready]);

  // Fonts settling or the window resizing moves the tabs without changing `value`.
  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    Object.values(buttons.current).forEach((b) => b && ro.observe(b));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, tabs.length]);

  // Keep the active tab in view when the bar scrolls sideways.
  useEffect(() => {
    buttons.current[value]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const live = tabs.filter((t) => !t.disabled);
    if (live.length === 0) return;
    e.preventDefault();
    const at = live.findIndex((t) => t.id === value);
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? live.length - 1
      : e.key === "ArrowRight" ? (at + 1) % live.length
      : (at - 1 + live.length) % live.length;
    const target = live[next];
    buttons.current[target.id]?.focus();
    if (target.id !== value) onChange(target.id);
  };

  return (
    <div
      ref={track}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`ui-tabs ${className || ""}`}
    >
      <span
        aria-hidden
        className={`ui-tab-thumb ${thumb ? (ready ? "ready" : "still") : ""}`}
        style={thumb ? { width: thumb.w, transform: `translateX(${thumb.x}px)` } : undefined}
      />
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { buttons.current[t.id] = el; }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            onClick={() => { if (!on) onChange(t.id); }}
            className="ui-tab"
          >
            {t.label}
            {t.count ? <span className={`ui-count ${t.countTone || "calm"}`}>{t.count > 99 ? "99+" : t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
