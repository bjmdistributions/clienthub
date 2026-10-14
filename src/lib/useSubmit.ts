import { useState } from "react";
import { toast } from "../components/Toast";

/**
 * R-511 DG-11. A create or save button that calls the backend with no catch and no busy
 * state does two bad things: a refused save shows nothing (the form just stays, which
 * looks like a dead button), and a second click while the first is still running makes a
 * second record. InvoicesView and QuotesView already did this by hand; ClientsView,
 * RecurringView and the Stripe keys did not.
 *
 * `run(save)` marks the screen busy, runs the save, and on a refusal toasts the reason
 * (String(e): Tauri rejects with a bare string). It resolves true when the save landed,
 * false when it was refused or was ignored because one is already running. The save
 * closes its own form only after its await, so a refusal leaves the form open with what
 * was typed. Bind `disabled={busy}` on the button.
 */
export function submitRunner(
  setBusy: (busy: boolean) => void,
  report: (message: string) => void,
): (save: () => unknown) => Promise<boolean> {
  // Not the busy state: that only reaches the screen after a render, and a second
  // click can arrive first.
  let inFlight = false;
  return async (save) => {
    if (inFlight) return false;
    inFlight = true;
    setBusy(true);
    try {
      await save();
      return true;
    } catch (e) {
      report(String(e));
      return false;
    } finally {
      inFlight = false;
      setBusy(false);
    }
  };
}

export function useSubmit(): { busy: boolean; run: (save: () => unknown) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [run] = useState(() => submitRunner(setBusy, (message) => toast(message, "error")));
  return { busy, run };
}
