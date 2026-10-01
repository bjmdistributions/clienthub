// R-425: the grid both profiles are laid out on, the client page and the supplier page.
// Jack, 2026-10-01: "more organized sections for client view and supplier view so
// everything is grid and information is easily accessable and readable."
//
// Shape: the work on the left (deals, payments, history), the reference facts on the
// right (contact, account, terms, notes), every block a titled card. Two columns from
// xl: the 216px sidebar makes the pane xl-wide only from ~1280px of window, so the
// split sits a step higher than it would on a full-width page (desktop-responsive-rule).
// In a split pane the same breakpoints read the pane (postcss-pane-breakpoints).
import type { ReactNode } from "react";

export function ProfileGrid({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
      <div className="min-w-0 flex flex-col gap-4">{main}</div>
      <aside className="min-w-0 grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-1 gap-4 items-start">{side}</aside>
    </div>
  );
}

/** A titled block. `right` carries the block's own figure or action. */
export function ProfileCard({ title, icon, right, children }: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-surface border border-line rounded-2xl min-w-0">
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h3 className="flex items-center gap-2 min-w-0 text-[13px] font-semibold text-ink">
          {icon}<span className="truncate">{title}</span>
        </h3>
        {right}
      </header>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

/** Label and value side by side, one per line, so a column of facts reads down. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-line-2">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-[12px] text-muted pt-px">{label}</dt>
      <dd className="text-[13px] text-ink-2 min-w-0 break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

/** The money band under the header: the same tile everywhere, as many as fit. */
export function KpiBand({ children, cols = 6 }: { children: ReactNode; cols?: 4 | 6 | 7 }) {
  // Rows that fill: six tiles go 2, 3, 6 across; seven go 2, 4, 7.
  const cls = cols === 7 ? "lg:grid-cols-4 2xl:grid-cols-7" : cols === 6 ? "lg:grid-cols-3 2xl:grid-cols-6" : "lg:grid-cols-4";
  return <div className={`grid grid-cols-2 ${cls} gap-3`}>{children}</div>;
}
