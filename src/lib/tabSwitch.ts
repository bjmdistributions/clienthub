// DG-02: what a request to open a screen does while another (or the same) one is showing. The shell keys the page
// on a counter that setTab bumps, so a request for the screen already open used to remount it and drop the form,
// filters, selection, scroll and drawer in it. A click on the screen's own row (sidebar, rail, bell, shortcut)
// asks nothing and changes nothing.
//
// A handoff is a navigate-tab event: one screen stashes a value (invoices_prefill, invoices_open_id,
// dealflow_invoice_filter, suppliers_open_id, the globe client) and the destination reads it in its mount
// effect. When the destination is the screen already open, the event still has to remount it or the stash is
// never read, so a handoff takes the same path as a different screen: ask about unsaved typing, then remount.

export type TabSwitch = "stay" | "refused" | "switch";

/** `confirmLeave` is only called when the screen really changes or a handoff remounts it (it asks about unsaved typing and clears the flag). */
export function tabSwitchAction(current: string, next: string, confirmLeave: () => boolean, handoff = false): TabSwitch {
  if (next === current && !handoff) return "stay";
  return confirmLeave() ? "switch" : "refused";
}

// DG-03: the screen to show given the ones this account can open. The last screen (and the split pane's) is stored
// per device, not per person, so the next person to sign in, or the same person after a role change, can be handed
// an id they cannot open, or one that no longer exists. The shell used to paint nothing for it, with no row lit.
export function tabToShow<T extends string>(current: T, reachable: readonly T[], fallback: T): T {
  return reachable.includes(current) ? current : fallback;
}
