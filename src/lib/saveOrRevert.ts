/**
 * R-511 DG-10. A Settings control that shows its new value before the server has agreed
 * must put the old value back, and say so, when the save is refused. Before this the
 * panels ended the call in `.catch(() => {})` and then flashed "Saved", so a switch
 * showed a policy that was not in force and a typed password vanished with the error.
 *
 * The caller changes the screen first, then hands the save and the undo here. Resolves
 * true when the save landed; on a refusal it runs `revert`, then `report` once with a
 * message ready to toast, and resolves false so the caller skips its "Saved" tick.
 * RenewalsView.decide is the same shape written inline.
 */
export async function saveOrRevert(
  save: () => Promise<unknown>,
  revert: () => void,
  report: (message: string) => void,
  what = "save",
): Promise<boolean> {
  try {
    await save();
    return true;
  } catch (e) {
    revert();
    report(saveFailedMessage(what, e));
    return false;
  }
}

/** "Couldn't <what>: <reason>". Tauri rejects with a bare string; a thrown Error or a {message} object carries it as `message`. */
export function saveFailedMessage(what: string, e: unknown): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  const reason = typeof e === "string" ? e : typeof m === "string" ? m : "";
  return reason.trim() ? `Couldn't ${what}: ${reason.trim()}` : `Couldn't ${what}`;
}
