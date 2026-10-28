import { describe, it, expect } from "vitest";
import {
  bumpAttempts, attemptsDone, mayAutoInstall, cleanNotes, whatsNewAction, versionAtLeast, friendlyError,
} from "./updater";

// R-561: the launch updater's decisions. The Tauri calls are not testable in node, so only the
// rules that decide what the user sees and when an automatic install gives up are covered.

describe("versions", () => {
  it("compares dotted numbers, not strings", () => {
    expect(versionAtLeast("0.16.195", "0.16.99")).toBe(true);
    expect(versionAtLeast("0.16.9", "0.16.10")).toBe(false);
    expect(versionAtLeast("0.16.195", "0.16.195")).toBe(true);
    expect(versionAtLeast("v1.0", "0.99.99")).toBe(true);
  });
});

describe("automatic install backoff", () => {
  it("counts per version and stops after two failures", () => {
    let rec = bumpAttempts(null, "0.16.196");
    expect(rec).toEqual({ version: "0.16.196", count: 1 });
    expect(mayAutoInstall(rec, "0.16.196")).toBe(true);
    rec = bumpAttempts(rec, "0.16.196");
    expect(rec.count).toBe(2);
    expect(mayAutoInstall(rec, "0.16.196")).toBe(false);
  });
  it("a newer version starts again from one", () => {
    const rec = { version: "0.16.196", count: 2 };
    expect(mayAutoInstall(rec, "0.16.197")).toBe(true);
    expect(bumpAttempts(rec, "0.16.197")).toEqual({ version: "0.16.197", count: 1 });
  });
  it("is cleared once the app is at or past that version", () => {
    const rec = { version: "0.16.196", count: 1 };
    expect(attemptsDone(rec, "0.16.195")).toBe(false);
    expect(attemptsDone(rec, "0.16.196")).toBe(true);
    expect(attemptsDone(rec, "0.17.0")).toBe(true);
    expect(attemptsDone(null, "0.17.0")).toBe(false);
  });
});

describe("what's new", () => {
  it("shows only on the launch that is the stored version", () => {
    const w = { version: "0.16.196", notes: "x" };
    expect(whatsNewAction(w, "0.16.196")).toBe("show");
    expect(whatsNewAction(w, "0.16.195")).toBe("none");
    expect(whatsNewAction(null, "0.16.196")).toBe("none");
  });
  it("drops a note the app has already moved past", () => {
    expect(whatsNewAction({ version: "0.16.196", notes: "x" }, "0.16.200")).toBe("clear");
  });
});

describe("notes", () => {
  it("skips empty notes and the fixed release sentence", () => {
    expect(cleanNotes(undefined)).toBe("");
    expect(cleanNotes("   \n ")).toBe("");
    expect(cleanNotes("Download the installer for your platform below. See https://ecliptr.app/download to get set up.")).toBe("");
  });
  it("keeps real notes as plain text, trimmed and capped", () => {
    expect(cleanNotes("\r\n  Faster imports.\r\n")).toBe("Faster imports.");
    expect(cleanNotes("<b>bold</b>")).toBe("<b>bold</b>");
    const long = cleanNotes("a".repeat(5000));
    expect(long.length).toBe(1201);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("errors", () => {
  it("explains the macOS read-only case and passes the rest through", () => {
    expect(friendlyError("Read-only file system (os error 30)")).toMatch(/Applications/);
    expect(friendlyError("boom")).toBe("Update failed: boom");
  });
});
