import { afterEach, describe, expect, it, vi } from "vitest";
import { hasUnsavedWork, setUnsavedWork, confirmLeaveUnsaved } from "./unsavedWork";
import { tabSwitchAction, tabToShow } from "./tabSwitch";
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

// A navigate-tab event (or the onNavigate prop of Dashboard, Quotes and Manifest) is how one screen hands work to
// another: it stashes a value in localStorage and the destination reads it in its mount effect (invoices_prefill,
// invoices_open_id, dealflow_invoice_filter, suppliers_open_id, the globe client). When the destination is the screen
// already open (a split pane) the jump has to remount it or the stash is never read, so only a click on the screen's
// own row is a no-op.
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

  it("only the navigate-tab listener and the three screens' onNavigate props pass handoff, so every click on a row, the bell or a shortcut stays a no-op on its own screen", () => {
    expect(appSource.match(/\bsetTab\([^()]*,\s*true\)/g)).toEqual(["setTab(detail, true)", "setTab(to, true)", "setTab(to, true)", "setTab(to, true)"]);
    expect(appSource).toMatch(/if \(detail && visibleRef\.current\(detail\)\) setTab\(detail, true\);/);
  });

  it("hands no screen a bare setTab: Dashboard, Quotes and Manifest stash a value and jump", () => {
    // DashboardView's recent-invoice row stashes invoices_open_id and calls onNavigate("invoices"); with Invoices open in
    // the other split pane a bare setTab said "stay", Invoices never reread the stash, and the next mount opened a stale drawer.
    expect(appSource).not.toMatch(/onNavigate=\{setTab\}/);
    for (const name of ["DashboardView", "QuotesView", "ManifestView"]) {
      expect(appSource).toContain(`<${name} onNavigate={(to) => setTab(to, true)}`);
    }
  });
});

// DG-03: the screen remembered on this device (or the split pane's) is read back off disk before anyone has signed in,
// and that disk is per device, not per person. A role that cannot open it, a role changed since, or an id that no
// longer exists left a blank page with no row lit. The shell now opens the Dashboard in its place.
describe("tabToShow", () => {
  const reachable = ["dashboard", "clients", "inventory", "settings"] as const;

  it("keeps a screen this account can open", () => {
    expect(tabToShow("inventory", reachable, "dashboard")).toBe("inventory");
  });

  it("opens the Dashboard for a screen this account cannot open", () => {
    expect(tabToShow("financials", reachable, "dashboard")).toBe("dashboard");
  });

  it("opens the Dashboard for an id that no longer exists", () => {
    expect(tabToShow("retired-screen", reachable as readonly string[], "dashboard")).toBe("dashboard");
  });

  it("keeps the Dashboard when it is the one on show", () => {
    expect(tabToShow("dashboard", reachable, "dashboard")).toBe("dashboard");
  });
});

describe("App.tsx wiring for tabToShow", () => {
  // The shell effect that applies it, cut out of the source so each check reads that effect and not a lookalike elsewhere.
  const effect = appSource.slice(appSource.indexOf("// DG-03: the remembered screen"), appSource.indexOf("// A group is open when the user opened it"));

  it("moves the main pane and the split pane to the Dashboard once the account's access is known", () => {
    expect(effect).toContain("tabToShow(tab, openable, \"dashboard\")");
    expect(effect).toContain("tabToShow(splitTab, openable, \"dashboard\")");
  });

  it("leaves a Logistics-only account to its own lock", () => {
    // That account has no Dashboard (visible() refuses it); the R-400 effect sends it to Logistics and closes the split.
    expect(effect).toMatch(/if \(!me \|\| logisticsOnly \|\| !accessSettled\) return;/);
  });

  it("does not write the fallback over the screen stored for the next person", () => {
    expect(effect).not.toContain("localStorage");
    expect(effect).not.toContain("setTab(");
    expect(effect).not.toContain("setSplit(");
  });

  it("waits for the plan, the entitlements and the superadmin answers before judging a screen that rides them", () => {
    // sheetcopy, showpacking, platform and datasafety are hidden until those answers arrive; judging earlier would
    // send an owner on Platform to the Dashboard on every launch.
    expect(appSource).toMatch(/Promise\.all\(\[\s*api\.getMyPlan\(\)[\s\S]*?api\.localIsSuperadmin\(\)[\s\S]*?\]\)\.then\(\(\) => setAccessSettled\(true\)\)/);
    expect(appSource).toMatch(/if \(!me \|\| logisticsOnly\) \{ setAccessSettled\(false\); return; \}/);
  });

  it("forgets the stored screen on every sign-out, not only a Logistics-only account's", () => {
    const signOut = appSource.slice(appSource.indexOf("const signOut = async"), appSource.indexOf("// Disarm on its own."));
    expect(signOut).toContain('localStorage.removeItem("clienthub_last_tab")');
    expect(signOut).not.toMatch(/if \(logisticsOnly\)/);
    expect(signOut).toContain('setTabState("dashboard")');
  });

  it("tells the person when a navigate-tab to a screen their account cannot open is refused", () => {
    expect(appSource).toMatch(/if \(detail && visibleRef\.current\(detail\)\) setTab\(detail, true\);\s*else if \(detail\) toast\("That screen is not available to your account", "error"\);/);
  });
});
