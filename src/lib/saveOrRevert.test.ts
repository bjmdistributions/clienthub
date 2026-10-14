import { describe, expect, it, vi } from "vitest";
import { saveFailedMessage, saveOrRevert } from "./saveOrRevert";

describe("saveFailedMessage", () => {
  it("names what failed and carries the reason", () => {
    expect(saveFailedMessage("add the inbox", "IMAP login refused")).toBe("Couldn't add the inbox: IMAP login refused");
  });

  it("reads the reason off an Error as well as a Tauri string", () => {
    expect(saveFailedMessage("save", new Error("database is locked"))).toBe("Couldn't save: database is locked");
  });

  it("reads the reason off a plain {message} object too", () => {
    expect(saveFailedMessage("save", { message: "offline" })).toBe("Couldn't save: offline");
  });

  it("says just what failed when there is no reason to give", () => {
    expect(saveFailedMessage("save", undefined)).toBe("Couldn't save");
    expect(saveFailedMessage("save", "")).toBe("Couldn't save");
    expect(saveFailedMessage("save", new Error(""))).toBe("Couldn't save");
  });

  it("never writes an em dash", () => {
    expect(saveFailedMessage("save", "x")).not.toContain("\u2014");
  });
});

describe("saveOrRevert", () => {
  it("keeps the screen as it is and says true when the save lands", async () => {
    const revert = vi.fn();
    const report = vi.fn();
    expect(await saveOrRevert(() => Promise.resolve("ok"), revert, report)).toBe(true);
    expect(revert).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("puts the screen back and reports once when the save is refused", async () => {
    const order: string[] = [];
    const revert = vi.fn(() => { order.push("revert"); });
    const report = vi.fn(() => { order.push("report"); });
    expect(await saveOrRevert(() => Promise.reject("not allowed"), revert, report)).toBe(false);
    expect(revert).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("Couldn't save: not allowed");
    expect(order).toEqual(["revert", "report"]);
  });

  it("treats a synchronous throw the same as a rejection", async () => {
    const revert = vi.fn();
    const report = vi.fn();
    const save = () => { throw new Error("no server"); };
    expect(await saveOrRevert(save, revert, report, "save the policy")).toBe(false);
    expect(revert).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("Couldn't save the policy: no server");
  });

  it("starts the save only after the caller has changed the screen", async () => {
    let shown = "old";
    const seen: string[] = [];
    shown = "new";
    await saveOrRevert(() => { seen.push(shown); return Promise.resolve(); }, () => { shown = "old"; }, () => {});
    expect(seen).toEqual(["new"]);
  });
});
