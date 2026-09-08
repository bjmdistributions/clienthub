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
// change no longer invalidates the recharts bytes, and vice versa.
//
// R-134-lazy. DashboardView is now lazy() in App.tsx, so recharts is genuinely
// deferred. That means d3-*/internmap (which recharts reaches through
// victory-vendor, and which three-globe also needs) can no longer be left to
// fall into the recharts chunk by default — the lazily loaded GlobeView would
// then drag the whole charting library in just to get its d3 pieces. They get
// their own chunk below instead.
//
// Only packages recharts alone uses are listed. Before adding a package to
// this list, check nothing outside recharts uses it.
//
// React is pinned to a chunk of its own below. Without that, rollup treats a
// manual chunk as an entry point and hoists everything shared between it and
// the real entry into it — which put all of React inside the chunk named
// "recharts", and made the lazy GlobeView chunk import it just to get React.
// use-sync-external-store rides along here too: react-redux (pulled in by
// recharts) and zustand (needed by the entry) share one instance of it, and
// with DashboardView now lazy, leaving that shared instance to fall into the
// recharts chunk by default made the eager entry import one binding from the
// lazy recharts chunk just to get it — pinning it here keeps the entry chunk
// from ever touching recharts.
const REACT_PACKAGES = ["react", "react-dom", "scheduler", "use-sync-external-store"];

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
          if (after === "internmap" || after.startsWith("internmap/") || after.startsWith("d3-")) return "d3";
          if (inside(RECHARTS_PACKAGES)) return "recharts";
        },
      },
    },
  },
});
