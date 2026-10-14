import { afterEach, describe, expect, it, vi } from "vitest";
import { hasUnsavedWork, setUnsavedWork, confirmLeaveUnsaved } from "./unsavedWork";
import { tabSwitchAction } from "./tabSwitch";

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
