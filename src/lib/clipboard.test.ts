import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { COPY_FAILED, copyText } from "./clipboard";

const plugin = vi.mocked(writeText);

beforeEach(() => { plugin.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("copyText", () => {
  it("writes through the native plugin and says true", async () => {
    plugin.mockResolvedValue(undefined);
    const web = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: web } });
    expect(await copyText("https://ecliptr.app/f/abc")).toBe(true);
    expect(plugin).toHaveBeenCalledWith("https://ecliptr.app/f/abc");
    expect(web).not.toHaveBeenCalled();
  });

  it("falls back to the web clipboard when the plugin is unavailable", async () => {
    plugin.mockRejectedValue(new Error("plugin not found"));
    const web = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: web } });
    expect(await copyText("link")).toBe(true);
    expect(web).toHaveBeenCalledWith("link");
  });

  it("says false when the plugin and the web clipboard both refuse", async () => {
    plugin.mockRejectedValue(new Error("denied"));
    const web = vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText: web } });
    expect(await copyText("link")).toBe(false);
  });

  it("says false, and does not throw, when there is no web clipboard either", async () => {
    plugin.mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {});
    expect(await copyText("link")).toBe(false);
  });

  it("says false when the web clipboard throws synchronously", async () => {
    plugin.mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText: () => { throw new Error("no gesture"); } } });
    expect(await copyText("link")).toBe(false);
  });

  it("the failure line is plain words with no dash", () => {
    expect(COPY_FAILED).toBe("Could not copy, select the text instead");
    expect(COPY_FAILED).not.toMatch(/[\u2013\u2014]/);
  });
});
