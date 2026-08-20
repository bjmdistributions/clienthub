import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// R-134c. Recharts and its private dependency tree are ~400 kB of the entry
// chunk. They cannot be split with React.lazy from here because DashboardView
// imports recharts eagerly and App.tsx imports DashboardView eagerly, so the
// split is done at the bundler instead. Measured at v0.16.0: entry 1,535.87 kB
// before, 1,035.27 kB after (recharts 403.27 kB + react 142.35 kB split out).
//
// This moves recharts OUT of the entry chunk, it does not make it lazy: the
// entry still statically imports the new chunk, so the bytes are still fetched
// on first load. What it buys is a parallel fetch and a cache boundary — an app
// change no longer invalidates the recharts bytes, and vice versa. Making the
// charts genuinely deferred needs a lazy() around DashboardView in App.tsx,
// which is a separate change in a file this config does not own.
//
// Only packages recharts alone uses are listed. Deliberately EXCLUDED:
//   - d3-* — recharts reaches them through victory-vendor, but three-globe (the
//     lazily loaded GlobeView) needs the same d3 packages, so rollup parks them
//     in the recharts chunk and GlobeView imports it for them. That is free
//     today because the entry loads the recharts chunk anyway. THE DAY
//     DashboardView BECOMES lazy(), give d3-*/internmap a chunk of their own
//     here, or opening the globe will drag the whole charting library with it.
//   - use-sync-external-store — shared with zustand, which the entry needs.
// Before adding a package to this list, check nothing outside recharts uses it.
//
// React is pinned to a chunk of its own below. Without that, rollup treats a
// manual chunk as an entry point and hoists everything shared between it and
// the real entry into it — which put all of React inside the chunk named
// "recharts", and made the lazy GlobeView chunk import it just to get React.
const REACT_PACKAGES = ["react", "react-dom", "scheduler"];

const RECHARTS_PACKAGES = [
  "recharts",
  "victory-vendor",
  "@reduxjs/toolkit",
  "react-redux",
  "reselect",
  "immer",
  "decimal.js-light",
  "es-toolkit",
  "eventemitter3",
  "tiny-invariant",
];

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Rollup ids arrive with backslashes on Windows; the release matrix
          // builds on both, so match against a normalised path.
          const path = id.replace(/\\/g, "/");
          if (!path.includes("/node_modules/")) return;
          const after = path.slice(path.lastIndexOf("/node_modules/") + "/node_modules/".length);
          const inside = (pkgs: string[]) =>
            pkgs.some((pkg) => after === pkg || after.startsWith(pkg + "/"));
          if (inside(REACT_PACKAGES)) return "react";
          if (inside(RECHARTS_PACKAGES)) return "recharts";
        },
      },
    },
  },
});
