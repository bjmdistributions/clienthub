import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Two ways a screen gets its header (R-583):
//
//  1. The shell draws it. A screen that lives in a section with several screens (Deals, Clients,
//     Inventory, Money, Insights, More) is wrapped by the shell in a header: the section name on the
//     left, an actions slot on the right, the section's screens as tabs underneath. The screen must NOT
//     draw its own title or its own copy of those tabs. It puts its header buttons (search, filters,
//     New ...) in <PageActions>, which the shell shows in the slot.
//
//  2. The screen draws it. Home, Logistics and Settings are alone in their section, so the shell draws
//     nothing and the screen renders <PageHeader title=... actions=... tabs=...>.
//
// <PageActions> also works in case 2 (no slot), where it just renders a right-aligned row, so a screen
// does not need to know which case it is in.

/** `shell` is true while a shell header is expected; `el` is its actions slot once mounted. */
export const PageSlotContext = createContext<{ shell: boolean; el: HTMLElement | null }>({ shell: false, el: null });

export function PageActions({ children, className }: { children: ReactNode; className?: string }) {
  const { shell, el } = useContext(PageSlotContext);
  if (shell) return el ? createPortal(children, el) : null;
  return <div className={`flex flex-wrap items-center justify-end gap-2 mb-4 ${className || ""}`}>{children}</div>;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** One quiet line under the title. Optional, and never a kicker above it. */
  subtitle?: ReactNode;
  /** Buttons on the right: outline buttons, the primary action as the ink button. */
  actions?: ReactNode;
  /** A <Tabs> element drawn under the header (tabs inside this one view). */
  tabs?: ReactNode;
  className?: string;
}

export default function PageHeader({ title, subtitle, actions, tabs, className }: PageHeaderProps) {
  return (
    <header className={`mb-6 ${className || ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 text-[20px] font-medium leading-7 text-ink">{title}</h1>
          {subtitle ? <p className="m-0 mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ? <div className="mt-4">{tabs}</div> : null}
    </header>
  );
}
