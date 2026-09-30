// Split view (R-417). The app's split view (App.tsx) puts each screen in a pane about half
// the window, but Tailwind's sm: md: lg: xl: 2xl: are media queries: they read the WINDOW,
// so a half-width pane got the full window's 3- and 4-up layouts.
//
// For every `@media (min-width: Npx)` rule this adds a twin `@container (min-width: N-216px)`
// right after it, and fences the media original off from anything inside a .pane-container.
// Only the split panes are query containers (`.pane-container`, index.css), so:
//   - full window: no container ancestor, the twins never match, the media rules run as before;
//   - split pane: the media rules are fenced out, the twins run against the pane's width.
// 216 is the expanded sidebar, so a pane N px wide gets the layout a full window whose content
// pane is N px wide gets (desktop-responsive-rule in the vault). Twins sit where the originals
// sat, so a later breakpoint still wins over an earlier one.
const SIDEBAR = 216;
const MIN_WIDTH = /^\(min-width:\s*(\d+)px\)$/;
// :where() adds no specificity, so a fenced rule wins and loses exactly as it did before.
const FENCE = ":where(:not(.pane-container *))";

// The fence goes on the subject element, ahead of any pseudo-element (::placeholder etc.),
// which must stay last in a selector.
const fence = (sel) => {
  const i = sel.indexOf("::");
  return i < 0 ? sel + FENCE : sel.slice(0, i) + FENCE + sel.slice(i);
};

const paneBreakpoints = () => ({
  postcssPlugin: "pane-breakpoints",
  OnceExit(root) {
    root.walkAtRules("media", (media) => {
      const hit = MIN_WIDTH.exec(media.params.trim());
      if (!hit) return;
      const twin = media.clone({ name: "container", params: `(min-width: ${Number(hit[1]) - SIDEBAR}px)` });
      media.walkRules((rule) => {
        if (rule.parent.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
        rule.selectors = rule.selectors.map(fence);
      });
      media.after(twin);
    });
  },
});
paneBreakpoints.postcss = true;

export default paneBreakpoints;
