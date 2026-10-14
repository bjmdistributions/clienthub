import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * The one way to put text on the clipboard. Resolves true only when the text really was
 * written, so a caller shows "Copied" on true and COPY_FAILED on false.
 *
 * The NATIVE clipboard first, never `navigator.clipboard` alone: the web API throws
 * NotAllowedError in this webview whenever the click has already been through an await
 * (R-214), and it rejects with nothing on screen to say so. The web API is only the
 * fallback for where the plugin is absent (vitest, the browser harnesses).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch { /* no native plugin, or it refused: try the web API */ }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* blocked: report it below */ }
  return false;
}

/** What a toast says when copyText returned false. */
export const COPY_FAILED = "Could not copy, select the text instead";
