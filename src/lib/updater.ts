import { useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

// R-561: the one shared update state for the app. The launch gate (UpdateGate), the in-app
// card (UpdateNotification) and Settings > Check for updates all read and drive this, so
// there is one check, one download and one install no matter how many of them are mounted.
//
// The Tauri modules are imported inside the functions so the pure rules below can be
// tested in plain node, and so none of it loads until an update is actually involved.

export type UpdatePhase = "idle" | "downloading" | "ready" | "installing" | "error";
export interface UpdateState {
  update: Update | null;
  phase: UpdatePhase;
  progress: number;
  error: string | null;
}

// ── Pure rules (tested in updater.test.ts) ──────────────────────────────────

/** The release body GitHub gets before the tag's commit message is put in it. */
const FIXED_NOTES = /download the installer/i;
const NOTES_MAX = 1200;
/** An automatic install that has failed this many times for a version stops being tried. */
export const MAX_AUTO_ATTEMPTS = 2;

export interface Attempts { version: string; count: number }
export interface WhatsNew { version: string; notes: string }

const nums = (v: string) => v.trim().replace(/^v/i, "").split(/[-+]/)[0].split(".").map((p) => parseInt(p, 10) || 0);

/** a >= b for dotted numeric versions ("0.16.195"). */
export function versionAtLeast(a: string, b: string): boolean {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Plain text for the What's new card: empty when there is nothing worth showing. */
export function cleanNotes(body: string | null | undefined): string {
  const t = (body ?? "").replace(/\r\n/g, "\n").trim();
  if (!t || FIXED_NOTES.test(t)) return "";
  return t.length > NOTES_MAX ? t.slice(0, NOTES_MAX).trimEnd() + "…" : t;
}

/** May this version be installed automatically at launch? */
export function mayAutoInstall(rec: Attempts | null, version: string): boolean {
  return !(rec && rec.version === version && rec.count >= MAX_AUTO_ATTEMPTS);
}

/** The record to store right before an automatic install of `version`. */
export function bumpAttempts(rec: Attempts | null, version: string): Attempts {
  return { version, count: rec && rec.version === version ? rec.count + 1 : 1 };
}

/** True once the running app is at or past the version the record is about. */
export function attemptsDone(rec: Attempts | null, current: string): boolean {
  return !!rec && versionAtLeast(current, rec.version);
}

/** "show" on the launch right after the update; "clear" when the note is stale; else "none". */
export function whatsNewAction(stored: WhatsNew | null, current: string): "show" | "clear" | "none" {
  if (!stored) return "none";
  if (stored.version === current) return "show";
  return versionAtLeast(current, stored.version) ? "clear" : "none";
}

export function friendlyError(e: string): string {
  return /read-only|os error 30/i.test(e)
    ? "macOS is running Ecliptr from a read-only spot, so it can't update itself. Tap Download update, then in Finder drag Ecliptr into Applications and reopen it from there. (Re-downloading into Downloads won't fix it: it must live in Applications.)"
    : `Update failed: ${e}`;
}

// ── localStorage records (every access guarded: it can throw or come back empty) ──

const ATTEMPTS_KEY = "ecliptr_update_attempts";
const WHATSNEW_KEY = "ecliptr_whatsnew";

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}
function writeJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }
function remove(key: string) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }

export const readAttempts = () => readJson<Attempts>(ATTEMPTS_KEY);
export const readWhatsNew = () => readJson<WhatsNew>(WHATSNEW_KEY);
export const clearWhatsNew = () => remove(WHATSNEW_KEY);
/** Count one automatic launch attempt (download then install) for `version`, written before the download starts so a failed download counts too. */
export const recordAutoAttempt = (version: string) => writeJson(ATTEMPTS_KEY, bumpAttempts(readAttempts(), version));

/** The What's new note for this launch, or null. Clears a stale one as a side effect. */
export function whatsNewFor(current: string): WhatsNew | null {
  const stored = readWhatsNew();
  const action = whatsNewAction(stored, current);
  if (action === "clear") clearWhatsNew();
  return action === "show" ? stored : null;
}

// ── Shared state ────────────────────────────────────────────────────────────

let state: UpdateState = { update: null, phase: "idle", progress: 0, error: null };
const listeners = new Set<() => void>();
function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export const getUpdateState = () => state;
export function subscribeUpdate(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export const useUpdateState = () => useSyncExternalStore(subscribeUpdate, getUpdateState);

// R-409: one check per launch, shared by every mount. Re-checks (every 4 hours, or from
// Settings) pass force.
let launchCheck: Promise<Update | null> | null = null;
let downloading: Promise<void> | null = null;

export const CHECK_TIMEOUT_MS = 8000;

async function runCheck(): Promise<Update | null> {
  try {
    // Once the app has caught up with a version it was auto-installing, forget the failures.
    const rec = readAttempts();
    if (rec) {
      const { getVersion } = await import("@tauri-apps/api/app");
      if (attemptsDone(rec, await getVersion())) remove(ATTEMPTS_KEY);
    }
  } catch { /* not fatal */ }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check({ timeout: CHECK_TIMEOUT_MS });
    // A download or install in progress keeps its own Update: swapping in a newer one mid-way
    // would mark an Update ready that was never downloaded.
    const busy = state.phase === "downloading" || state.phase === "ready" || state.phase === "installing";
    if (found && found.version !== state.update?.version && !busy) {
      set({ update: found, phase: "idle", progress: 0, error: null });
    }
    return found ? state.update : null;
  } catch (e: any) {
    console.warn("Update check failed:", e?.message ?? e);
    return null;
  }
}

/** Look for an update. Without force this is the launch check: it runs once and every caller shares it. */
export function checkNow(force = false): Promise<Update | null> {
  if (force) return runCheck();
  if (!launchCheck) launchCheck = runCheck();
  return launchCheck;
}

/** Download the found update (kept in memory only), reporting progress. Safe to call from several places. */
export function downloadIfNeeded(): Promise<void> {
  const u = state.update;
  if (!u) return Promise.resolve();
  if (state.phase === "ready" || state.phase === "installing") return Promise.resolve();
  if (downloading) return downloading;
  set({ phase: "downloading", progress: 0, error: null });
  let total = 0, got = 0, last = -1;
  downloading = u
    .download((e) => {
      // Tauri v2 emits Started / Progress / Finished with the payload on `e.data`.
      if (e.event === "Started") total = e.data?.contentLength ?? 0;
      if (e.event === "Progress") {
        got += e.data?.chunkLength ?? 0;
        const pct = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : 0;
        if (pct !== last) { last = pct; set({ progress: pct }); }
      }
    })
    .then(() => { set({ phase: "ready", progress: 100 }); })
    .catch((err: any) => {
      // Never swallow silently: a signing-key mismatch or download failure must be visible.
      set({ phase: "error", error: err?.message ?? String(err) });
      console.error("Update download failed:", err);
    })
    .finally(() => { downloading = null; });
  return downloading;
}

/**
 * Install the downloaded update. On Windows install() starts the installer and the app exits
 * (the installer reopens it), so this never returns there. On a Mac it swaps the bundle and
 * returns, so we relaunch.
 */
export async function installNow(): Promise<void> {
  const u = state.update;
  if (!u || state.phase === "installing") return;
  if (state.phase !== "ready") {
    await downloadIfNeeded();
    if (getUpdateState().phase !== "ready") return;
  }
  set({ phase: "installing", error: null });
  writeJson(WHATSNEW_KEY, { version: u.version, notes: cleanNotes(u.body) } as WhatsNew);
  try {
    await u.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err: any) {
    clearWhatsNew();
    set({ phase: "error", error: err?.message ?? String(err) });
    console.error("Update install failed:", err);
  }
}
