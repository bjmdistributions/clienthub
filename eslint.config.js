// Lint config for the desktop app's TypeScript/React source.
//
// The contract this file keeps: `npx eslint .` must exit 0 on a clean checkout of
// main. Every rule that is at zero violations today is left at error, so it can
// never regress; every rule with existing violations is a warning, so CI is honest
// instead of red on arrival. A check that is red the day it lands gets ignored, and
// an ignored check is worse than no check.
//
// RATCHET — how this gets stricter, in the order the counts make affordable:
//   1. exhaustive-deps (20 warnings) is the one that hides real bugs. Drive it to
//      zero, then move it to error. Do it a few files per release, not in one sweep.
//   2. no-unused-vars (29) and prefer-const (5) are mechanical. Once at zero, error.
//   3. no-explicit-any (354) is off, not warn, on purpose — see the rule below.
// When a rule reaches zero, promote it here in the same commit that empties it.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Without these, `eslint .` reports 32,757 problems instead of 436. The stale
    // agent worktrees under .claude are whole second copies of this repo, and the
    // two vendored bundles are minified builds nobody edits by hand. src/ imports
    // globe.gl and three from node_modules, so these copies are not source at all.
    ignores: [
      "dist/**",
      "src-tauri/**",
      "node_modules/**",
      ".claude/**",
      "public/*.min.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Zero violations today, and the failure it catches is a blank screen: a hook
      // behind a condition desynchronises React's hook order and throws at runtime.
      // Held at error so the clean state is permanent.
      "react-hooks/rules-of-hooks": "error",

      // 20 today. This is the rule worth having — a missing dep is a component that
      // renders yesterday's data with no error anywhere. Warning until the existing
      // 20 are cleared, then error. 16 eslint-disable comments already sit on this
      // rule in src/, so the intent to run it predates this config.
      "react-hooks/exhaustive-deps": "warn",

      // 354 violations. `any` is load-bearing in the Tauri invoke boundary, where
      // payloads are shaped by Rust and typed by hand on arrival. Warning on all 354
      // would bury the 20 exhaustive-deps warnings that point at real defects, so
      // this is off rather than noisy. Revisit only if the invoke layer ever gets
      // generated types.
      "@typescript-eslint/no-explicit-any": "off",

      // 29 today. tsc does not fail on these because noUnusedLocals is not set.
      "@typescript-eslint/no-unused-vars": "warn",

      // 3 today.
      "@typescript-eslint/no-unused-expressions": "warn",

      // 21 today, nearly all deliberate empty catch blocks around best-effort work
      // (clipboard, notifications) where failing loudly would be worse.
      "no-empty": "warn",

      // 5 today.
      "prefer-const": "warn",

      // 1 today, and it is a false positive: GlobeView chains .height(...)(el) across
      // a newline, which is globe.gl's documented fluent API, not an ASI accident.
      "no-unexpected-multiline": "warn",
    },
  },
);
