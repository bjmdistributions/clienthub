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
