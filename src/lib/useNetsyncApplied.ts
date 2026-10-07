import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** Reload on a sync that applied changes from another device (Logistics types a date on his
 *  phone or laptop, this desktop pulls it). A Tauri event, so it needs listen(), not a window
 *  listener. Debounced so a burst of applied events is one reload. */
export function useNetsyncApplied(cb: () => void, ms = 800) {
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    let dead = false;
    listen("netsync-applied", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ref.current(), ms);
    }).then((u) => { if (dead) u(); else unlisten = u; }).catch(() => {});
    return () => { dead = true; window.clearTimeout(timer); unlisten?.(); };
  }, [ms]);
}
