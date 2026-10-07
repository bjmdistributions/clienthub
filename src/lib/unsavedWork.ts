// R-464: whether a full-page form holds typing that is not saved. The form sets it; the shell asks before it
// switches screens (the sidebar and the navigate-tab events stay live behind a full page).

export const UNSAVED_LEAVE = "You have changes that are not saved. Leave without saving them?";

let unsaved = false;

export function setUnsavedWork(v: boolean): void { unsaved = v; }

export function hasUnsavedWork(): boolean { return unsaved; }

/** True when leaving is fine: nothing is unsaved, or the person says to leave anyway (the flag is cleared then). */
export function confirmLeaveUnsaved(ask: (message: string) => boolean = (m) => confirm(m)): boolean {
  if (!unsaved) return true;
  if (!ask(UNSAVED_LEAVE)) return false;
  unsaved = false;
  return true;
}
