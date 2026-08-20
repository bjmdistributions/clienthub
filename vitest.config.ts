import { defineConfig } from "vitest/config";

// R-134b. Until this existed the tree had 45 Rust tests and none on the TypeScript
// side, so every pure helper in src/lib was only ever verified by running the app.
//
// Deliberately narrow. `environment: "node"` and `src/**/*.test.ts` (not .tsx) keep
// the suite to helpers that take values and return values: no jsdom, no component
// rendering, no mocked `invoke`. Every component in this tree reaches for Tauri IPC,
// and a suite that needs the whole shell stubbed to assert one label is a suite that
// rots. Widen this when there is something worth widening it for — a helper extracted
// out of a component is the cheap way to get logic under test, not a render harness.
//
// This file replaces vite.config.ts for test runs rather than extending it. The
// helpers import nothing but types, so the manual-chunks config and the react plugin
// are irrelevant here; if a test ever needs them, use `mergeConfig` instead of
// copying anything across.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
