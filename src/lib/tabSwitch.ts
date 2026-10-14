// DG-02: what a request to open a screen does while another (or the same) one is showing. The shell keys the page
// on a counter that setTab bumps, so a request for the screen already open used to remount it and drop the form,
// filters, selection, scroll and drawer in it. The same screen asks nothing and changes nothing.

export type TabSwitch = "stay" | "refused" | "switch";

/** `confirmLeave` is only called when the screen really changes (it asks about unsaved typing and clears the flag). */
export function tabSwitchAction(current: string, next: string, confirmLeave: () => boolean): TabSwitch {
  if (next === current) return "stay";
  return confirmLeave() ? "switch" : "refused";
}
