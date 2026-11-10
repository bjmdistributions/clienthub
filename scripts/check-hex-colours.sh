#!/usr/bin/env bash
# No new raw hex colours: a colour belongs in a design token. Files that had hex before the
# rule are allowlisted. Run by .github/workflows/check.yml (Check main) and by
# .githooks/pre-push, so the two can never disagree. Run from the repo root.
set -euo pipefail
allowlist=$(mktemp)
# Pre-existing violations at v0.16.0. Counts are a guide, not enforced.
cat > "$allowlist" <<'EOF'
src/App.tsx
src/components/AnalyticsView.tsx
src/components/AuthView.tsx
src/components/BriefView.tsx
src/components/ClientDetailView.tsx
src/components/DashboardView.tsx
src/components/ErrorBoundary.tsx
src/components/GettingStarted.tsx
src/components/GlobeView.tsx
src/components/InvoicePreview.tsx
src/components/NotesView.tsx
src/components/OnboardingWizard.tsx
src/components/PayablesView.tsx
src/components/ReceivablesView.tsx
src/components/ReleaseLetterView.tsx
src/components/SettingsView.tsx
src/components/UpdateNotification.tsx
src/lib/accent.ts
EOF
# Deliberate exception, not a pre-existing violation (2026-09-14).
# CrossDock's reel symbols are an illustration: eight hues that must stay
# distinct from each other and must not follow the accent, which the mono
# themes invert. The tokens carry four semantic hues, so mapping onto them
# would make symbols collide. The palette is scoped to the component and
# already declared once per ground (.cd and html.dark .cd). The allowlist
# is per file, so review any other hex added to it by hand.
echo "src/components/CrossDock.tsx" >> "$allowlist"
# Deliberate exception (2026-09-16, R-308). `src/__r308-harness.tsx` is a
# DEV-ONLY fixture: index.html does not reference it, so `npm run build`
# never sees it, and its hex values are not styling — they are the colour
# STRINGS the backend returns (invoice_template.accent_color,
# storefront.accent), which the real cards render into a colour input. A
# token here would test something the app never receives. Nothing in this
# file reaches a user.
echo "src/__r308-harness.tsx" >> "$allowlist"
# Deliberate exception (2026-09-30, R-133, from dad2b3c). The globe is a
# fixed dark scene: App.tsx paints its pane #0a0a14 in every theme. These
# two files draw the client pins, marks.ts onto a canvas texture (a
# canvas fillStyle cannot read a CSS variable) and ClientMap2D.tsx as its
# SVG twin on the flat map. Their one hex, #FFFFFF, is the count label's
# ink: inkFor() picks it or a near-black by luminance against the pin's
# own colour, which comes from the fixed palette in places.ts, not from
# the theme. A token would follow the theme and flip the ink on a pin
# whose colour does not move. Review any other hex added to either by hand.
echo "src/components/globe/marks.ts" >> "$allowlist"
echo "src/components/globe/ClientMap2D.tsx" >> "$allowlist"
# Deliberate exception (2026-09-30, R-133, from ede4111).
# `src/__r133-harness.tsx` is a DEV-ONLY fixture: nothing imports it and
# only r133-harness.html loads it, which index.html does not reference,
# so `npm run build` never sees it. Its one hex, #0a0a14, copies the
# background App.tsx gives the globe pane, so the real GlobeView renders
# over the ground it gets in the app. A token would test the globe on a
# ground no user sees. Nothing in this file reaches a user.
echo "src/__r133-harness.tsx" >> "$allowlist"
# Deliberate exception (2026-10-14, R-511). `src/lib/freightMapStyle.test.ts`
# is the test for the map recolouring (R-485 round 2): its hex values are
# OpenFreeMap style JSON as the tiles serve it, the INPUT the function
# under test converts to the theme's tokens. A token there would test a
# style no tile server sends. Nothing in a test file reaches a user. This
# line is why Check was red on main from b7be1c7 to cae4855.
echo "src/lib/freightMapStyle.test.ts" >> "$allowlist"
# Deliberate exception (2026-10-14, R-511 DG-01). `src/components/ErrorBoundary.test.ts`
# mounts the pane fallback over the Globe's forced dark ground (#0a0a14, the
# value App.tsx paints in every theme) to prove its text reads there; the
# hex is the real container, copied from App.tsx (already allowlisted).
echo "src/components/ErrorBoundary.test.ts" >> "$allowlist"
# Deliberate exception (2026-11-10, R-643). The R-638 and R-642 harnesses are DEV ONLY pages that
# never reach a build; each draws an invented logo on a canvas, which takes a colour, not a token.
# This step was hidden behind a red Lint from 85fa14d4 to the fix, so these were never caught.
echo "src/__r546-harness.tsx" >> "$allowlist"
echo "src/__r642-harness.tsx" >> "$allowlist"
# Anchor each allowlisted path to the start of a `path:line:` hit so a
# new file cannot slip through by containing an allowlisted name.
patterns=$(mktemp)
sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d; s/[.]/[.]/g; s|^|^|; s|$|:|' "$allowlist" > "$patterns"
# 3-, 6- and 8-digit hex only, and not when followed by a word
# character — that would be an id, a hash or a template placeholder.
hits=$(grep -rnE '#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})([^0-9a-zA-Z_-]|$)' src \
         --include='*.ts' --include='*.tsx' \
       | grep -vEf "$patterns" || true)
if [ -n "$hits" ]; then
  echo "Raw hex colours in files that had none. Use a design token."
  echo "$hits"
  exit 1
fi
echo "No new raw hex colours."
