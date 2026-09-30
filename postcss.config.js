import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import paneBreakpoints from "./postcss-pane-breakpoints.js";

export default {
  // pane-breakpoints runs last: it rewrites the media queries Tailwind generated (R-417).
  plugins: [tailwindcss(), autoprefixer(), paneBreakpoints()],
};
