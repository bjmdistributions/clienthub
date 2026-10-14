import { describe, expect, it, vi } from "vitest";
import { submitRunner, useSubmit } from "./useSubmit";

// R-511 DG-11. The suite runs in plain node (vitest.config.ts), so the hook's logic lives in
// submitRunner, which takes the screen's two hooks as arguments; useSubmit is that runner with
// useState and the toast plugged in.

/** A runner whose busy flag and reports are recorded in order. */
function harness() {
  const log: string[] = [];
  const setBusy = vi.fn((b: boolean) => { log.push(b ? "busy" : "idle"); });
  const report = vi.fn((m: string) => { log.push(`report:${m}`); });
  return { log, setBusy, report, run: submitRunner(setBusy, report) };
}

/** A promise the test settles by hand, so a save can be held open mid-flight. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("submitRunner", () => {
  it("is busy while the save runs, idle after, and says true when it landed", async () => {
    const h = harness();
    const d = deferred();
    const pending = h.run(() => d.promise);
    expect(h.log).toEqual(["busy"]);
    d.resolve();
    expect(await pending).toBe(true);
    expect(h.log).toEqual(["busy", "idle"]);
    expect(h.report).not.toHaveBeenCalled();
  });

  it("reports the refusal once, comes back idle, and says false", async () => {
    const h = harness();
    expect(await h.run(() => Promise.reject(new Error("database is locked")))).toBe(false);
    // report fires before the button comes back, so the person never sees an enabled button with no message yet
    expect(h.log).toEqual(["busy", "report:Error: database is locked", "idle"]);
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it("reports a bare string from Tauri exactly as it came", async () => {
    const h = harness();
    await h.run(() => Promise.reject("Client name already exists"));
    expect(h.report).toHaveBeenCalledWith("Client name already exists");
  });

  it("catches a save that throws before it returns a promise", async () => {
    const h = harness();
    expect(await h.run(() => { throw new Error("bad input"); })).toBe(false);
    expect(h.report).toHaveBeenCalledWith("Error: bad input");
    expect(h.log[h.log.length - 1]).toBe("idle");
  });

  it("ignores a second click while the first is still running, so only one record is made", async () => {
    const h = harness();
    const d = deferred();
    const save = vi.fn(() => d.promise);
    const first = h.run(save);
    const second = h.run(save);
    expect(await second).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    d.resolve();
    expect(await first).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual(["busy", "idle"]);
  });

  it("lets the person try again after a refusal", async () => {
    const h = harness();
    const save = vi.fn()
      .mockRejectedValueOnce("offline")
      .mockResolvedValueOnce(undefined);
    expect(await h.run(save)).toBe(false);
    expect(await h.run(save)).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it("lets the person save again after a save that landed", async () => {
    const h = harness();
    const save = vi.fn().mockResolvedValue(undefined);
    await h.run(save);
    await h.run(save);
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("useSubmit", () => {
  it("is exported as a hook", () => {
    expect(typeof useSubmit).toBe("function");
  });
});
