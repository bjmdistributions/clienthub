import { afterEach, describe, expect, it, vi } from "vitest";
import { hasUnsavedWork, setUnsavedWork, confirmLeaveUnsaved } from "./unsavedWork";
import { tabSwitchAction } from "./tabSwitch";
import appSource from "../App.tsx?raw";

afterEach(() => { setUnsavedWork(false); });

describe("tabSwitchAction", () => {
  it("stays put on the screen already open, without asking about unsaved work", () => {
    const ask = vi.fn(() => true);
    expect(tabSwitchAction("clients", "clients", ask)).toBe("stay");
    expect(ask).not.toHaveBeenCalled();
  });

  it("leaves unsaved typing flagged when the open screen's own row is clicked", () => {
    setUnsavedWork(true);
    const ask = vi.fn(() => true);
    expect(tabSwitchAction("invoices", "invoices", () => confirmLeaveUnsaved(ask))).toBe("stay");
    expect(ask).not.toHaveBeenCalled();
    expect(hasUnsavedWork()).toBe(true);
  });

  it("switches to another screen when nothing is unsaved", () => {
    expect(tabSwitchAction("clients", "suppliers", () => confirmLeaveUnsaved(() => false))).toBe("switch");
  });

  it("is refused when the person keeps their unsaved typing", () => {
    setUnsavedWork(true);
    expect(tabSwitchAction("clients", "suppliers", () => confirmLeaveUnsaved(() => false))).toBe("refused");
    expect(hasUnsavedWork()).toBe(true);
  });

  it("switches and clears the flag when the person leaves anyway", () => {
    setUnsavedWork(true);
    expect(tabSwitchAction("clients", "suppliers", () => confirmLeaveUnsaved(() => true))).toBe("switch");
    expect(hasUnsavedWork()).toBe(false);
  });
});

// A navigate-tab event is how one screen hands work to another: it stashes a value in localStorage and the
// destination reads it in its mount effect (invoices_prefill, invoices_open_id, dealflow_invoice_filter,
// suppliers_open_id, the globe client). When the destination is the screen already open the event has to
// remount it or the stash is never read, so only a click on the screen's own row is a no-op.
describe("tabSwitchAction for a handoff", () => {
  it("remounts the screen already open, so the stash left for it is read", () => {
    const ask = vi.fn(() => true);
    expect(tabSwitchAction("dealflow", "dealflow", ask, true)).toBe("switch");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks about unsaved typing first and does not remount when the person keeps it", () => {
    setUnsavedWork(true);
    expect(tabSwitchAction("invoices", "invoices", () => confirmLeaveUnsaved(() => false), true)).toBe("refused");
    expect(hasUnsavedWork()).toBe(true);
  });

  it("clears the flag when the person leaves anyway", () => {
    setUnsavedWork(true);
    expect(tabSwitchAction("invoices", "invoices", () => confirmLeaveUnsaved(() => true), true)).toBe("switch");
    expect(hasUnsavedWork()).toBe(false);
  });

  it("is the same as a plain request when the screen is different", () => {
    expect(tabSwitchAction("clients", "invoices", () => true, true)).toBe("switch");
    expect(tabSwitchAction("clients", "invoices", () => false, true)).toBe("refused");
  });
});

// App.tsx cannot be rendered under this suite (node environment, no component tests), so these pin the
// wiring the decision above depends on. They are read from the source: remove one and the bug it prevents is back.
describe("App.tsx wiring for tabSwitchAction", () => {
  it("setTab decides from a ref kept in step with the screen on show, not from its own closure", () => {
    // The navigate-tab and keyboard listeners mount once and keep the first render's setTab, so a closure
    // over `tab` would see the first screen forever and remount (or not) wrongly.
    expect(appSource).toContain("tabSwitchAction(tabRef.current, t, confirmLeaveUnsaved, handoff)");
    expect(appSource).toContain("useEffect(() => { tabRef.current = tab; }, [tab]);");
    expect(appSource.match(/\btabSwitchAction\(/g)).toHaveLength(1);
  });

  it("only the navigate-tab listener passes handoff, so every click on a row, the bell or a shortcut stays a no-op on its own screen", () => {
    expect(appSource.match(/\bsetTab\([^()]*,\s*true\)/g)).toEqual(["setTab(detail, true)"]);
    expect(appSource).toMatch(/if \(detail && visibleRef\.current\(detail\)\) setTab\(detail, true\);/);
  });
});
