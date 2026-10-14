import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ErrorBoundary, PaneBoundary } from "./ErrorBoundary";

// R-511 DG-01: one throwing screen used to unmount the whole app, and Reload reopened the same screen.
// These tests mount the REAL boundaries around a child that throws while rendering. The suite runs in
// plain node (see vitest.config.ts), so the DOM below is the few dozen lines react-dom needs to render a
// tree; it is not a general DOM, and a test needing more than this one probably wants jsdom instead.

class FakeNode {
  nodeType: number;
  nodeName: string;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  ownerDocument: unknown = doc;
  constructor(nodeType: number, nodeName: string) { this.nodeType = nodeType; this.nodeName = nodeName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): FakeNode | null { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  appendChild(c: FakeNode) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c: FakeNode) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  addEventListener() {}
  removeEventListener() {}
  get text(): string { return this.childNodes.map((c) => c.text).join(""); }
}
class FakeText extends FakeNode {
  nodeValue: string;
  constructor(value: string) { super(3, "#text"); this.nodeValue = value; }
  get text() { return this.nodeValue; }
}
class FakeEl extends FakeNode {
  tagName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  constructor(tag: string) { super(1, tag.toUpperCase()); this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  set textContent(t: string) { this.childNodes = []; if (t) this.appendChild(new FakeText(t)); }
  get textContent() { return this.text; }
  /** Every element under this one, this one included. */
  all(): FakeEl[] {
    return [this, ...this.childNodes.flatMap((c) => (c instanceof FakeEl ? c.all() : []))];
  }
  /** The element's React props: react-dom keeps them on the node under a random-suffixed key. */
  get reactProps(): Record<string, unknown> {
    const key = Object.keys(this).find((k) => k.startsWith("__reactProps$"));
    return key ? ((this as unknown as Record<string, Record<string, unknown>>)[key]) : {};
  }
}
const doc = {
  nodeType: 9,
  activeElement: null,
  createElement: (tag: string) => new FakeEl(tag),
  createTextNode: (t: string) => new FakeText(t),
  addEventListener() {},
  removeEventListener() {},
};

let container: FakeEl;
let root: Root;
let errors: ReturnType<typeof vi.spyOn>;
const reload = vi.fn();
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  reload.mockClear();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { HTMLIFrameElement: class {}, document: doc, location: { reload } });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  // React and both boundaries log a caught render error; keep the run quiet but keep the calls to assert on.
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  container = new FakeEl("div");
  root = createRoot(container as unknown as Element);
});

afterEach(() => {
  flushSync(() => root.unmount());
  errors.mockRestore();
  vi.unstubAllGlobals();
});

const show = (node: React.ReactNode) => flushSync(() => root.render(node));
const click = (label: string) => {
  const button = container.all().find((e) => e.tagName === "BUTTON" && e.text === label);
  expect(button, `a "${label}" button`).toBeDefined();
  flushSync(() => (button!.reactProps.onClick as () => void)());
};

let broken = true;
function Screen(): React.ReactNode {
  if (broken) throw new Error("totals is undefined");
  return React.createElement("p", null, "Clients screen");
}
const shell = (pane: React.ReactNode) =>
  React.createElement("div", null, React.createElement("aside", null, "Sidebar"), pane);
const pane = (props: { onBack: () => void; key?: string }, child: React.ReactNode) =>
  React.createElement(PaneBoundary, { ...props, children: child });

describe("PaneBoundary", () => {
  beforeEach(() => { broken = true; });

  it("keeps the sidebar and shows a recoverable message when its screen throws", () => {
    show(shell(pane({ onBack: () => {} }, React.createElement(Screen))));
    expect(container.text).toContain("Sidebar");
    expect(container.text).toContain("This screen hit an error");
    expect(container.text).toContain("totals is undefined");
    expect(container.text).not.toContain("Clients screen");
    // The error still reaches the console, as the root boundary's does.
    expect(errors.mock.calls.some((c) => String(c[0]).includes("Screen error"))).toBe(true);
  });

  it("Back to Dashboard calls onBack", () => {
    const onBack = vi.fn();
    show(shell(pane({ onBack }, React.createElement(Screen))));
    click("Back to Dashboard");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Try again renders the screen again", () => {
    show(shell(pane({ onBack: () => {} }, React.createElement(Screen))));
    broken = false;
    click("Try again");
    expect(container.text).toContain("Clients screen");
    expect(container.text).not.toContain("This screen hit an error");
  });

  it("a new key (the next screen) clears the error", () => {
    const keyed = (key: string, child: React.ReactNode) => shell(pane({ key, onBack: () => {} }, child));
    show(keyed("clients", React.createElement(Screen)));
    expect(container.text).toContain("This screen hit an error");
    show(keyed("dashboard", React.createElement("p", null, "Dashboard screen")));
    expect(container.text).toContain("Dashboard screen");
    expect(container.text).not.toContain("This screen hit an error");
  });
});

describe("ErrorBoundary (the whole app)", () => {
  beforeEach(() => { broken = true; });

  it("Reload forgets the stored screens first, so the app does not reopen the one that crashed", () => {
    store.set("clienthub_last_tab", "clients");
    store.set("clienthub_split_tab", "inventory");
    store.set("clienthub_split_ratio", "0.4");
    show(React.createElement(ErrorBoundary, null, React.createElement(Screen)));
    expect(container.text).toContain("Something went wrong");
    reload.mockImplementation(() => {
      // By the time the page reloads, both keys must already be gone.
      expect(store.has("clienthub_last_tab")).toBe(false);
      expect(store.has("clienthub_split_tab")).toBe(false);
    });
    click("Reload");
    expect(reload).toHaveBeenCalledTimes(1);
    // Only the two screen keys go; a layout preference stays.
    expect(store.get("clienthub_split_ratio")).toBe("0.4");
  });

  it("still reloads when storage throws", () => {
    show(React.createElement(ErrorBoundary, null, React.createElement(Screen)));
    vi.stubGlobal("localStorage", { removeItem: () => { throw new Error("blocked"); } });
    click("Reload");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
