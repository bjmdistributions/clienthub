import type { KeyboardEvent, ReactNode } from "react";

// The DesktopSettings content pattern: a section is a small title (and optional actions), then rows.
// A row has the title with a grey sub line on the left and its control (a value, a button, a Switch)
// on the right, with a hairline between rows. No boxes inside boxes: a Section is not a card.

export function Section({ title, sub, actions, children, className }: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`py-4 ${className || ""}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <div className="min-w-0">
            {title ? <h2 className="m-0 text-[14px] font-medium text-ink">{title}</h2> : null}
            {sub ? <p className="m-0 mt-0.5 text-[12px] leading-relaxed text-muted">{sub}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2 flex-shrink-0">{actions}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function Row({ title, sub, children, onClick, className }: {
  title: ReactNode;
  sub?: ReactNode;
  /** The control: value text, a Button, a Switch. Right-aligned. */
  children?: ReactNode;
  /** Makes the whole row a button (a row that opens something). */
  onClick?: () => void;
  className?: string;
}) {
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only the row itself: Enter on a button inside the row is that button's own click.
    if (onClick && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); }
  };
  return (
    <div
      className={`ui-row ${onClick ? "ui-row-click" : ""} ${className || ""}`}
      onClick={onClick}
      onKeyDown={onClick ? key : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <span className="ui-row-text">
        <span className="ui-row-title">{title}</span>
        {sub ? <span className="ui-row-sub">{sub}</span> : null}
      </span>
      {children ? <div className="flex flex-wrap items-center justify-end gap-2" onClick={onClick ? (e) => e.stopPropagation() : undefined}>{children}</div> : null}
    </div>
  );
}
