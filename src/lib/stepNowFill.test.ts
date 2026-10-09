import { describe, it, expect } from "vitest";
import tailwind from "../../tailwind.config.js?raw";
import stepBar from "../components/StepBar.tsx?raw";

// R-480: the numbered circle on a deal's open step is a white 11px digit on blue, which needs 4.5:1. The website's blue
// (--c-step-now) gives 4.0:1 in light and 3.65:1 in dark, so the dot, the ring and the tint keep it and the circle's fill
// is its own token, --c-step-now-fill (0 113 227, 4.7:1 under white, one value for every theme). Vitest empties CSS
// files, so the value itself is not read here; what this pins is that the circle uses the token and the token is a colour.
describe("the step number's blue fill", () => {
  it("is registered as a colour", () => {
    expect(tailwind).toContain("'step-now-fill': 'rgb(var(--c-step-now-fill) / <alpha-value>)'");
  });
  it("is what the open step's circle is filled with, not the plain step blue", () => {
    expect(stepBar).toContain('isCur ? "bg-step-now-fill text-on-step-now"');
    expect(stepBar).not.toContain('isCur ? "bg-step-now text-on-step-now"');
  });
  it("leaves the open step's tint and ring on the plain step blue", () => {
    expect(stepBar).toContain("bg-step-now/10 text-ink ring-1 ring-step-now/30");
  });
});
