# ClientHub — UI Redesign Specification

---

## Section 1: Current Problems

### App.tsx — Sidebar

- `bg-slate-900` dark sidebar reads as a developer tool (VS Code, terminal). Two non-technical business users will find this oppressive for a tool they use all day.
- Active nav state `bg-slate-700` is barely distinguishable from the dark base — the active item doesn't register visually until you look closely.
- Nav icon `size={16}` is 16px — too small at typical Windows DPI. No left accent bar differentiates active from inactive.
- Brand name `text-xl font-bold` with no padding structure, no logo space, no visual separation from the nav list.
- Status footer: `border-t border-slate-700 p-3 space-y-2 text-xs` — 12px text on dark background, ultra-dense, the Sync button looks identical to a status row. No affordance that it's clickable.
- Email badge: `bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5` — generic red pill with no visual relationship to the brand palette.
- `main` has `p-6` padding — 24px feels tight at 1280px wide. The sidebar takes 224px leaving ~1056px, but the content area just starts at the edge.

### DashboardView.tsx

- `text-2xl font-bold` page title — 24px is too large; creates no heading hierarchy since stat card values are also `text-2xl font-bold`.
- Stat card icon containers: `${c.color} p-2 rounded text-white` produces solid-colored square icon boxes (`bg-blue-500`, `bg-violet-500`, `bg-amber-500`, `bg-green-500`). This is a 2015-era Bootstrap dashboard look.
- Cards use `shadow` with no border — inconsistent with the border-driven system needed for a premium feel. Shadow alone floats cards without grounding them.
- Follow-ups section `bg-amber-50 border border-amber-200` is fine conceptually but the amber text sits directly on amber tint — low contrast.
- Secondary metric cards (`bg-white rounded-lg shadow p-4`) are visually identical to stat cards; no hierarchy between KPI data and supporting data.
- Quick Actions: `border border-slate-200 hover:bg-slate-50 p-4 rounded text-left` — no icon, no visual weight. The buttons look like disabled inputs.
- No visual breathing room between sections — everything stacks with `mb-6`, no page-level structure.

### ClientsView.tsx

- Primary button `bg-slate-900 text-white px-4 py-2 rounded` — black. No brand color in the app.
- Search input `border w-full pl-9 pr-3 py-2 rounded text-sm` has no explicit height, no focus ring, no border-radius spec.
- Filter pills active state toggles to `bg-slate-900 text-white` — jarring black chips for simple filter toggles. Should be a lighter indigo tint.
- Pipe separator `text-slate-300 mx-1` between stale and status filters is invisible at small sizes and semantically wrong — a visual divider is needed.
- Table `bg-white rounded shadow overflow-hidden` — missing `border border-gray-200`.
- `thead bg-slate-100` header with `th text-left p-3` — 12px cell padding is too tight. Spec calls for `px-4 py-3`.
- Status column renders as `<select>` with background color applied via `statusColor()` — `px-2 py-0.5` select has no border radius spec and no consistent badge sizing.
- Inline `ClientForm` rendered above the table with `bg-white rounded-lg shadow p-5 mb-4` — drops in and pushes everything down. Cancel button `px-4 py-2 text-sm` has zero visual affordance (no border, no background).
- Empty state `p-6 text-center text-slate-400` — everything is the same gray weight. `text-lg mb-2` for "No clients yet" and `text-sm mb-4` for subtext have no icon.

### InvoicesView.tsx

- Same black primary button pattern.
- Toast `fixed bottom-4 right-4 bg-slate-900 text-white` is a dark tooltip-sized blob — no icon, no semantic color.
- Action buttons column: icon buttons (`Edit2`, `Trash2`, `FileDown`, `Send`, `Check`) plus one text-only `"Deposit"` button in `text-xs` — mixed metaphors. The text button is visually weaker and sits awkwardly alongside icons.
- Status badges `px-2 py-0.5 text-xs rounded` — missing `font-medium`, no border. `rounded` (4px) is inconsistent; spec calls for `rounded-full`.
- `confirmDelete` state shows "Delete?" as bold text replacing the icon — good UX pattern but needs red background treatment.
- `InvoiceForm` line items grid `grid grid-cols-12 gap-2` is technically correct but the read-only amount column `bg-slate-50` blends into the form.
- `InvoiceDetailPanel`: the sticky footer buttons `bg-slate-900 text-white ... flex-1` and `bg-slate-100 ... flex-1` — Download PDF is the primary action but styled identically in size to Resend.
- `payModal` inputs `border p-2 rounded w-full text-sm` — inconsistent height with no focus ring.

### EmailView.tsx

- Mode switcher `px-3 py-1.5 text-sm rounded` with black active state — should be a segmented control or underline tabs, not toggling buttons.
- Email list panel `bg-white rounded shadow overflow-hidden` — no border.
- AI action area mixes `bg-slate-900 text-white` (Draft Reply) with `bg-slate-200` (Extract Data) — no consistent secondary button treatment.
- Send Reply button `bg-green-600 text-white` — only non-black primary in the main flow. Inconsistent.
- Drafts: `bg-green-600 text-white` for Send, `bg-slate-100 text-red-600` for Discard — semantic color mixed into surface color.
- ComposeView `border-b w-full p-2 outline-none` for To/Subject — borderless fields with only a bottom border. Visually fragile and hard to tab through.
- Email detail metadata (`text-slate-500` prefix + normal weight value) lacks sufficient contrast between label and value.

### SettingsView.tsx

- Active tab indicator: `border-slate-900 font-semibold` — a thick black underline. Should be indigo to match the design system.
- Eight tabs in one row: on narrow windows at 1280px, after subtracting the 220px sidebar and 64px content padding, the tab bar has ~996px for 8 tabs × ~80px each = 640px. Fits, but barely. No overflow handling.
- All form panels `bg-white rounded-lg shadow p-6 max-w-2xl` — shadow on white-on-off-white is invisible. Needs border.
- All inputs `border p-2 rounded w-full` — height is ~34px (8px top + 8px bottom + line height). Spec says 40px (`h-10`).
- All save buttons: `bg-slate-900 text-white px-4 py-2 rounded text-sm` — black.
- OAuth authorize button: `bg-blue-600 text-white` — one-off blue, not in the system.
- Import tab: selected meta-key chips `bg-slate-900 text-white border-slate-900` — black chips for simple toggles.
- Import run button: `bg-green-600 text-white` — another one-off green.
- `TemplatesTab` add row: `flex gap-2` with `border p-2 rounded flex-1` description + narrow `w-20` rate + `w-16` qty — visually cramped, no labels.
- `PaymentsTab` up/down chevrons are 14px icon buttons with `text-slate-400` — nearly invisible touch targets.

### ClientDetailView.tsx

- Back button `flex items-center gap-1 text-sm text-slate-600` — functional, but has no chevron-styled arrow treatment.
- Header card client name `text-2xl font-bold` — should be 18px per spec.
- Invoice count pill `bg-slate-900 text-white px-3 py-1.5 rounded-full text-sm inline-flex` — black pill anchored to bottom-left of card, looks like an afterthought.
- Tab bar uses pill-style `px-4 py-1.5 text-sm rounded capitalize` with `bg-slate-900 text-white` — three different tab styles exist in this app (underline in Settings, pill here, button-style in EmailView).
- AI summary section: `bg-violet-50 border border-violet-200` with `bg-violet-600 text-white` button — violet is the only color in the app not in the spec palette. Needs to map to indigo.
- `NoteForm` inside interactions panel: `bg-slate-50 border-b` — form renders inside the list container, creating a confusing spatial relationship.
- `kindColor()` badges — `px-1.5 py-0.5` — too small, no border, no font-weight.
- Metadata cards `bg-white rounded-lg shadow p-4` — same shadow-without-border issue.
- `MetaRow` label: `text-xs text-slate-400` value: `text-slate-700` — adequate contrast but label sits directly above value with no spacing.

### QuickLogModal.tsx

- Kind type selector: `px-3 py-1 text-sm rounded` pills with `bg-slate-900 text-white` active — same black pill pattern, fourth occurrence.
- Textarea `border p-2 rounded w-full text-sm` — no focus ring.
- Suggestions dropdown `bg-white border rounded shadow-lg mt-0.5 z-10` — missing `border-gray-200` spec, generic shadow.
- Submit button: same black pattern.

---

## Section 2: Design System

Add to `src/index.css` as CSS custom properties:

```css
:root {
  /* Brand */
  --color-primary:        #4F46E5; /* indigo-600 */
  --color-primary-hover:  #4338CA; /* indigo-700 */
  --color-primary-light:  #EEF2FF; /* indigo-50 */
  --color-primary-text:   #4338CA; /* indigo-700 — on light bg */

  /* Semantic */
  --color-success:        #059669; /* emerald-600 */
  --color-success-bg:     #ECFDF5; /* emerald-50 */
  --color-success-border: #A7F3D0; /* emerald-200 */
  --color-success-text:   #065F46; /* emerald-800 */

  --color-warning:        #D97706; /* amber-600 */
  --color-warning-bg:     #FFFBEB; /* amber-50 */
  --color-warning-border: #FDE68A; /* amber-200 */
  --color-warning-text:   #92400E; /* amber-800 */

  --color-error:          #DC2626; /* red-600 */
  --color-error-bg:       #FEF2F2; /* red-50 */
  --color-error-border:   #FECACA; /* red-200 */
  --color-error-text:     #991B1B; /* red-800 */

  --color-info:           #2563EB; /* blue-600 */
  --color-info-bg:        #EFF6FF; /* blue-50 */
  --color-info-border:    #BFDBFE; /* blue-200 */
  --color-info-text:      #1E40AF; /* blue-800 */

  /* Backgrounds */
  --color-bg:             #F8F7F6; /* warm off-white — app background */
  --color-surface:        #FFFFFF; /* cards, panels, modals */
  --color-surface-raised: #FFFFFF; /* same — use shadow to differentiate */

  /* Text */
  --color-text-primary:   #111827; /* gray-900 */
  --color-text-secondary: #6B7280; /* gray-500 */
  --color-text-hint:      #9CA3AF; /* gray-400 */
  --color-text-disabled:  #D1D5DB; /* gray-300 */

  /* Borders */
  --color-border:         #E5E7EB; /* gray-200 */
  --color-border-strong:  #D1D5DB; /* gray-300 */

  /* Sidebar */
  --color-sidebar-bg:          #FFFFFF;
  --color-sidebar-border:      #E5E7EB;
  --color-sidebar-text:        #6B7280;
  --color-sidebar-text-active: #4338CA;
  --color-sidebar-active-bg:   #EEF2FF;

  /* Spacing — 8px grid */
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-7:  28px;
  --space-8:  32px;
  --space-9:  40px;
  --space-10: 48px;

  /* Typography */
  --font-sans:  -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono:  "SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace;

  --text-page-title-size:    18px;
  --text-page-title-weight:  600;
  --text-section-size:       13px;
  --text-section-weight:     600;
  --text-section-tracking:   0.05em;
  --text-body-size:          14px;
  --text-body-weight:        400;
  --text-body-lh:            1.5;
  --text-caption-size:       12px;
  --text-label-size:         12px;
  --text-label-weight:       500;

  /* Shadows */
  --shadow-card:   0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-panel:  0 4px 16px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
  --shadow-modal:  0 20px 60px rgba(0,0,0,0.14), 0 8px 24px rgba(0,0,0,0.08);

  /* Border radius */
  --radius-sm:   6px;  /* inputs, badges, buttons */
  --radius-md:   8px;  /* cards, panels */
  --radius-full: 9999px; /* pills */
}
```

---

## Section 3: Component Redesign Specs

### App.tsx — Sidebar

**Current:**
```
<aside className="w-56 bg-slate-900 text-slate-100 flex flex-col">
  <div className="p-4"><h1 className="text-xl font-bold">ClientHub</h1></div>
  <nav className="flex-1 px-3 space-y-1">
    <button className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm
      ${tab === id ? "bg-slate-700" : "hover:bg-slate-800"}`}>
      <Icon size={16} /> {label}
    </button>
  </nav>
  <div className="border-t border-slate-700 p-3 space-y-2 text-xs">
    ...status rows...
  </div>
</aside>
<main className="flex-1 overflow-auto"><div className="p-6">...</div></main>
```

**Problems:**
- Dark sidebar is tonally wrong for an internal business tool
- `bg-slate-700` active state invisible on dark bg
- 16px icon, `py-2` nav item height ≈ 36px — too small
- Status footer cramped, Sync looks like a label not a button

**Fix (className-only):**
```jsx
// <aside>
"w-[220px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0"

// Brand header
"h-14 px-5 flex items-center border-b border-gray-100"
// <h1>
"text-[15px] font-semibold text-gray-900 tracking-tight"

// <nav>
"flex-1 px-3 py-3 space-y-0.5 overflow-y-auto"

// Nav button — inactive
"w-full flex items-center gap-3 px-3 h-10 rounded-md text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"

// Nav button — active
"w-full flex items-center gap-3 px-3 h-10 rounded-md text-sm bg-indigo-50 text-indigo-700 font-medium"

// Icon inside nav
size={18}  // was size={16}

// Badge on email nav item
"ml-auto bg-indigo-600 text-white text-[11px] font-medium rounded-full px-1.5 py-0.5 leading-none"

// Status footer
"border-t border-gray-100 px-4 py-3 space-y-2"

// Status row wrapper
"flex items-center justify-between text-[12px] text-gray-500"

// Sync button
"w-full flex items-center justify-between text-[12px] text-gray-500 hover:text-gray-800 hover:bg-gray-50 px-2 py-1.5 rounded-md transition-colors"

// main
"flex-1 overflow-auto bg-[#F8F7F6]"
// inner div
"p-8 max-w-[1200px]"
```

**Change type:** className-only

---

### DashboardView.tsx

**Current:**
```
<h2 className="text-2xl font-bold mb-6">Dashboard</h2>
<div className="grid grid-cols-4 gap-4 mb-6">
  <button className="bg-white p-5 rounded-lg shadow hover:shadow-md transition text-left">
    <div className={`${c.color} p-2 rounded text-white`}><c.icon size={16} /></div>
    <div className="text-2xl font-bold">{c.value}</div>
  </button>
</div>
<div className="bg-white rounded-lg shadow p-4"> ...metric card... </div>
<div className="bg-white rounded-lg shadow p-6"> ...quick actions... </div>
```

**Problems:**
- `text-2xl font-bold` heading same weight as card values — no hierarchy
- Solid colored icon boxes look dated
- `shadow` without `border` — cards float ungrounded
- Quick action buttons have no icon and no visual weight

**Fix:**

```jsx
// Page title
"text-[18px] font-semibold text-gray-900 mb-6"

// Stat card button
"bg-white border border-gray-200 p-5 rounded-lg hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)] transition-shadow text-left"

// Icon container — REMOVE solid colored box
// STRUCTURE CHANGE: replace <div className={`${c.color} p-2 rounded text-white`}><c.icon /></div>
// with a muted tint icon using the icon's semantic color:
<div className="w-8 h-8 rounded-md bg-indigo-50 flex items-center justify-center">
  <c.icon size={16} className="text-indigo-600" />
</div>
// (Map each card to its tint: clients=indigo, invoices=violet, outstanding=amber, paid=emerald)

// Stat value
"text-2xl font-semibold text-gray-900 mt-3"

// Stat label
"text-[13px] text-gray-500 font-medium"

// Follow-ups card
"bg-amber-50 border border-amber-200 rounded-lg p-5 mb-6"
// title
"font-semibold text-[14px] text-amber-900"
// follow-up row name
"text-[14px] text-gray-700 font-medium"
// follow-up date
"text-[12px] text-amber-700 tabular-nums"

// Secondary metric cards
"bg-white border border-gray-200 rounded-lg p-5"
// label
"text-[12px] font-medium text-gray-500 uppercase tracking-wide"
// value
"text-[22px] font-semibold text-gray-900 mt-1"
// sub-label
"text-[12px] text-gray-400 mt-0.5"

// Quick Actions panel
"bg-white border border-gray-200 rounded-lg p-6"
// section heading
"text-[13px] font-semibold text-gray-500 uppercase tracking-wide mb-4"

// Quick Action buttons — STRUCTURE CHANGE: add icon before text
<button className="border border-gray-200 hover:border-indigo-200 hover:bg-indigo-50 p-4 rounded-lg text-left transition-colors group">
  <LayoutDashboard size={16} className="text-gray-400 group-hover:text-indigo-500 mb-2" />
  <div className="font-medium text-[14px] text-gray-800">Add Client</div>
  <div className="text-[12px] text-gray-500 mt-0.5">Create a new client profile</div>
</button>
```

**Change type:** Mixed — stat icon containers and Quick Action buttons are structural; everything else is className-only.

---

### ClientsView.tsx — List

**Current:**
```
<h2 className="text-2xl font-bold">Clients</h2>
<button className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded text-sm">
<input className="border w-full pl-9 pr-3 py-2 rounded text-sm" />
<button className={`px-3 py-1 text-xs rounded ${staleDays === null ? "bg-slate-900 text-white" : "bg-slate-100"}`}>
<div className="bg-white rounded shadow overflow-hidden">
  <thead className="bg-slate-100">
    <th className="text-left p-3">
    <tr className="border-t hover:bg-slate-50 cursor-pointer">
    <td className="p-3 font-medium">
```

**Problems:**
- Black primary button, no brand color
- `shadow` no border on table container
- Filter pills toggle to black
- `p-3` cell padding — too tight

**Fix (className-only):**
```jsx
// Page title
"text-[18px] font-semibold text-gray-900"

// New Client button
"flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors"

// Search input wrapper + input
"relative mb-4"
"border border-gray-300 w-full pl-9 pr-3 h-10 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Search icon
"absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14}

// Filter bar wrapper
"flex items-center gap-1.5 mb-4 flex-wrap"

// Filter pill — inactive
"px-3 h-7 text-[12px] font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"

// Filter pill — active
"px-3 h-7 text-[12px] font-medium rounded-full bg-indigo-600 text-white"

// Pipe separator — STRUCTURE CHANGE: replace <span> with <div>
<div className="w-px h-5 bg-gray-200 mx-1" />

// Table container
"bg-white border border-gray-200 rounded-lg overflow-hidden"

// thead
"bg-gray-50 border-b border-gray-200"

// th
"text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide"

// tbody tr
"border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"

// td — default
"px-4 py-3 text-[14px] text-gray-700"

// td — name (primary)
"px-4 py-3 text-[14px] font-medium text-gray-900"

// td — monospace (email, phone)
"px-4 py-3 text-[13px] text-gray-600"

// Status select (in-cell badge)
// Keep existing statusColor() logic but update the color strings in the function:
// hot_lead:        "bg-red-50 text-red-700 border border-red-200"
// warm:            "bg-orange-50 text-orange-700 border border-orange-200"
// active_customer: "bg-emerald-50 text-emerald-700 border border-emerald-200"
// inactive:        "bg-gray-100 text-gray-600 border border-gray-200"
// default:         "bg-indigo-50 text-indigo-700 border border-indigo-200"
// Wrapper class on the <select>:
"text-[11px] font-medium px-2 py-0.5 rounded-full border-0 cursor-pointer appearance-none"

// Last Contact cell
"text-[13px] text-gray-500 inline-flex items-center gap-1"

// Revenue cell
"px-4 py-3 text-[14px] font-semibold text-gray-900 text-right tabular-nums"

// Action buttons cell
"px-4 py-3 text-right"
// Edit button
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
// Delete button
"text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
```

### ClientsView.tsx — ClientForm

**Current:**
```
<div className="bg-white rounded-lg shadow p-5 mb-4">
<button onClick={onCancel} className="px-4 py-2 text-sm">Cancel</button>
<button className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50">Save</button>
```

**Fix (className-only):**
```jsx
// Form container
"bg-white border border-gray-200 rounded-lg p-6 mb-4"

// Form title
"text-[15px] font-semibold text-gray-900 mb-4"

// grid
"grid grid-cols-2 gap-4 mb-4"

// All inputs inside form
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Textarea (notes)
"border border-gray-300 px-3 py-2 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Field label
"block text-[12px] font-medium text-gray-600 mb-1.5"

// Cancel button
"px-4 h-9 text-[14px] text-gray-600 hover:text-gray-900 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"

// Save button
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium disabled:opacity-40 transition-colors"
```

**Change type:** className-only

---

### InvoicesView.tsx — List

**Current:**
```
<button className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded text-sm">
<div className="fixed bottom-4 right-4 bg-slate-900 text-white px-4 py-2 rounded shadow-lg text-sm z-50">
<div className="bg-white rounded shadow overflow-hidden">
  <thead className="bg-slate-100">
  <span className={`px-2 py-0.5 text-xs rounded ${statusColor(inv.status)}`}>{inv.status}</span>
  // action column with mixed icon + text buttons
  <button className="text-yellow-600 hover:text-yellow-800 text-xs">Deposit</button>
```

**Fix (className-only):**
```jsx
// New Invoice button — same as clients
"flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors"

// Toast — STRUCTURE CHANGE: add check icon
<div className="fixed bottom-5 right-5 bg-gray-900 text-white px-4 py-2.5 rounded-lg shadow-lg text-[13px] z-50 flex items-center gap-2">
  <Check size={13} className="text-emerald-400" />
  {toast}
</div>

// Table container
"bg-white border border-gray-200 rounded-lg overflow-hidden"

// thead / th — same as clients table
"bg-gray-50 border-b border-gray-200"
"text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide"

// tbody tr
"border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"

// td defaults
"px-4 py-3 text-[14px] text-gray-700"

// Invoice number td
"px-4 py-3 font-mono text-[13px] text-gray-600"

// Total td
"px-4 py-3 text-[14px] font-semibold text-gray-900 tabular-nums"

// Status badge — update statusColor() return values:
// paid:            "bg-emerald-50 text-emerald-700 border border-emerald-200"
// sent:            "bg-blue-50 text-blue-700 border border-blue-200"
// overdue:         "bg-red-50 text-red-700 border border-red-200"
// deposit_pending: "bg-amber-50 text-amber-700 border border-amber-200"
// default:         "bg-gray-100 text-gray-600 border border-gray-200"
// Badge wrapper:
"inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide"

// Action buttons — icon buttons
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
// Delete icon button
"text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
// confirmDelete state
"text-red-600 font-medium text-[12px] px-2 py-0.5 rounded bg-red-50 hover:bg-red-100"
// Deposit button — change from text to consistent styling
"text-amber-600 hover:text-amber-800 text-[12px] font-medium px-2 py-0.5 rounded hover:bg-amber-50"
// PDF button (primary action icon)
"text-gray-500 hover:text-indigo-600 p-1 rounded hover:bg-indigo-50"
// Send button
"text-gray-400 hover:text-blue-600 p-1 rounded hover:bg-blue-50"
// Mark paid button
"text-gray-400 hover:text-emerald-600 p-1 rounded hover:bg-emerald-50"
```

### InvoicesView.tsx — InvoiceForm

**Current:**
```
<div className="bg-white rounded-lg shadow p-5 mb-4">
<input className="border p-2 rounded w-full text-sm" />
<button className="bg-slate-100 text-slate-700 px-4 py-2 rounded text-sm ...">Preview</button>
<button className="bg-slate-900 text-white px-4 py-2 rounded text-sm ...">Create Invoice</button>
```

**Fix (className-only):**
```jsx
// Form container
"bg-white border border-gray-200 rounded-lg p-6 mb-4"

// Form title
"text-[15px] font-semibold text-gray-900"

// All inputs/selects
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Line items column header row
"grid grid-cols-12 gap-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5 px-1"

// Line item inputs (per-row)
// description
"col-span-6 border border-gray-300 px-3 h-9 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
// qty
"col-span-1 border border-gray-300 px-2 h-9 rounded-md text-[14px] text-center focus:outline-none focus:ring-1 focus:ring-indigo-500"
// rate
"col-span-2 border border-gray-300 px-3 h-9 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
// amount (read-only)
"col-span-2 border border-gray-100 bg-gray-50 px-3 h-9 rounded-md text-[14px] text-right text-gray-600 tabular-nums"
// remove row button
"col-span-1 text-gray-400 hover:text-red-600 flex items-center justify-center"

// Add line button
"text-[13px] text-indigo-600 hover:text-indigo-800 mt-2 flex items-center gap-1 font-medium"

// Template pills
"text-[11px] bg-gray-100 px-2.5 py-1 rounded-full text-gray-600 hover:bg-gray-200 transition-colors"

// Totals section
"border-t border-gray-200 pt-4 flex justify-end"
// inner div
"w-56 text-[14px] space-y-1.5"
// total row (bold)
"flex justify-between text-[15px] font-semibold text-gray-900 pt-1.5 border-t border-gray-200"

// Cancel
"px-4 h-9 text-[14px] text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
// Preview
"bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 h-9 rounded-md text-[14px] flex items-center gap-1.5 disabled:opacity-40"
// Create Invoice
"bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40"

// New client inline form container
"grid grid-cols-2 gap-3 mb-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg"
```

**Change type:** className-only

### InvoicesView.tsx — payModal

**Current:**
```
<div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40">
  <div className="bg-white rounded-lg shadow-xl w-[420px]">
    <div className="flex items-center justify-between p-4 border-b">
    <div className="p-4 space-y-3">
    <input type="date" className="border p-2 rounded w-full text-sm" />
    <button className="bg-slate-900 text-white px-4 py-2 rounded text-sm ...">Confirm</button>
```

**Fix (className-only):**
```jsx
// Backdrop
"fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/30 backdrop-blur-[2px]"

// Modal card
"bg-white rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.14),0_8px_24px_rgba(0,0,0,0.08)] w-[420px]"

// Modal header
"flex items-center justify-between px-5 py-4 border-b border-gray-100"
// title
"text-[15px] font-semibold text-gray-900"
// close button
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"

// Modal body
"px-5 py-4 space-y-4"

// Inputs in modal
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Footer buttons
"px-4 h-9 text-[14px] text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
"bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40"
```

### InvoicesView.tsx — InvoiceDetailPanel

**Current:**
```
<div className="fixed inset-0 z-50 flex justify-end">
  <div className="absolute inset-0 bg-black/40" />
  <div className="relative w-[480px] bg-white shadow-xl h-full overflow-auto">
    <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between z-10">
    <div className="p-4 space-y-4">
    <div className="sticky bottom-0 bg-white border-t p-4 flex gap-2">
      <button className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex-1">Download PDF</button>
      <button className="bg-slate-100 px-4 py-2 rounded text-sm flex-1">Resend</button>
```

**Fix (className-only):**
```jsx
// Backdrop
"fixed inset-0 bg-black/30 backdrop-blur-[1px]"

// Panel
"fixed inset-y-0 right-0 w-[480px] bg-white shadow-[0_0_40px_rgba(0,0,0,0.12)] h-full overflow-auto z-50"

// Panel header
"sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between z-10"
// Invoice number
"text-[16px] font-semibold text-gray-900 font-mono"
// Close button
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"

// Panel body
"px-6 py-5 space-y-5"

// Meta label
"text-[11px] font-medium text-gray-400 uppercase tracking-wide"
// Meta value
"text-[14px] text-gray-900 font-medium mt-0.5"

// Grid for dates
"grid grid-cols-2 gap-4"

// Line items table
"w-full text-[13px]"
// thead
"bg-gray-50"
// th
"text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide"
// tbody tr
"border-t border-gray-100"
// td
"px-3 py-2.5 text-gray-700"

// Totals section
"border-t border-gray-200 pt-4 space-y-1.5 text-[14px]"
// total row (bold)
"flex justify-between text-[15px] font-semibold text-gray-900 pt-1.5 border-t border-gray-200"

// Notes block
"bg-gray-50 border border-gray-100 px-4 py-3 rounded-lg text-[13px] text-gray-600"

// Panel footer
"sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4 flex gap-3"
// Primary (Download PDF)
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex-1 transition-colors"
// Secondary (Resend)
"bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px] flex-1 transition-colors"
```

**Change type:** className-only

---

### EmailView.tsx

**Current:**
```
<div className="flex gap-2">
  <button className={`px-3 py-1.5 text-sm rounded ${mode === "inbox" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>
// Two-panel
<div className="grid grid-cols-2 gap-4">
  <div className="bg-white rounded shadow overflow-hidden">
  <div className="bg-white rounded shadow p-4">
// AI buttons
<button className="bg-slate-900 text-white px-3 py-1.5 rounded text-sm ...">Draft Reply</button>
<button className="bg-slate-200 px-3 py-1.5 rounded text-sm ...">Extract Data</button>
// Send reply
<button className="bg-green-600 text-white px-3 py-1.5 rounded text-sm ...">Send Reply</button>
```

**Fix:**

```jsx
// Mode switcher — STRUCTURE CHANGE: use underline tab style matching Settings
<div className="flex gap-0 border-b border-gray-200 mb-5">
  <button className={`px-4 py-2.5 text-[14px] border-b-2 -mb-px transition-colors ${
    mode === "inbox"
      ? "border-indigo-600 text-indigo-700 font-medium"
      : "border-transparent text-gray-500 hover:text-gray-800"
  }`}>
    <Inbox size={14} className="inline mr-1.5 mb-0.5" /> Inbox
  </button>
  // ... same for drafts and compose
</div>

// Scan inbox button
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50"

// Inbox description
"text-[13px] text-gray-500"

// Error alert
"bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-[13px] flex items-center gap-2 mb-4"

// Two-panel grid
"grid grid-cols-2 gap-5"

// Email list panel
"bg-white border border-gray-200 rounded-lg overflow-hidden"
// List header
"px-4 py-3 border-b border-gray-100 text-[13px] font-semibold text-gray-700"
// Email list item — inactive
"w-full text-left px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
// Email list item — selected
"w-full text-left px-4 py-3.5 border-b border-gray-100 bg-indigo-50"
// Sender name
"font-medium text-[13px] text-gray-900 truncate"
// Subject
"text-[13px] text-gray-600 truncate mt-0.5"
// Preview text
"text-[12px] text-gray-400 truncate mt-0.5"

// Email detail panel
"bg-white border border-gray-200 rounded-lg p-5"

// Email metadata section (From/Subject/Date)
"border-b border-gray-100 pb-4 mb-4"
// Label prefix
"text-[12px] font-medium text-gray-500"
// Value
"text-[13px] text-gray-800"
// Date
"text-[11px] text-gray-400 mt-1"

// Email body
"bg-gray-50 border border-gray-100 px-4 py-3 rounded-lg text-[13px] text-gray-700 whitespace-pre-wrap max-h-48 overflow-auto mb-4"

// Tone select
"border border-gray-300 px-3 h-9 rounded-md text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500"

// Draft Reply button (AI primary)
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 disabled:opacity-50"

// Extract Data button
"bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px] disabled:opacity-50"

// Draft reply label
"text-[12px] font-medium text-gray-600 mb-1"
// Draft reply textarea
"w-full border border-gray-300 rounded-lg px-3 py-2.5 text-[13px] mt-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Send reply button — align semantically: primary action = indigo, not green
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 mt-2"

// ComposeView container
"bg-white border border-gray-200 rounded-lg max-w-2xl overflow-hidden"
// STRUCTURE CHANGE: replace borderless fields with standard inputs
<div className="px-5 py-4 space-y-3">
  <div>
    <label className="block text-[12px] font-medium text-gray-500 mb-1">To</label>
    <input className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" ... />
  </div>
  // same for Subject
  <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-[14px] min-h-[240px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none" ... />
  <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-50">

// DraftsTab empty state
"py-12 text-center text-[14px] text-gray-400"

// Draft card
"bg-white border border-gray-200 rounded-lg p-4"
// Draft subject
"text-[14px] font-medium text-gray-900"
// Draft to
"text-[12px] text-gray-500 mt-0.5"
// Draft timestamp
"text-[11px] text-gray-400"
// Draft body preview
"text-[13px] text-gray-600 mt-2 whitespace-pre-wrap line-clamp-3"
// Send draft button
"bg-indigo-600 hover:bg-indigo-700 text-white px-3 h-8 rounded-md text-[13px] font-medium flex items-center gap-1 disabled:opacity-50"
// Edit draft button
"bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 h-8 rounded-md text-[13px] flex items-center gap-1"
// Discard draft button
"text-red-600 hover:text-red-700 hover:bg-red-50 px-3 h-8 rounded-md text-[13px] flex items-center gap-1 border border-transparent hover:border-red-200"
```

**Change type:** Mode switcher and ComposeView are structural; rest is className-only.

---

### SettingsView.tsx

**Current:**
```
<h2 className="text-2xl font-bold mb-4">Settings</h2>
<div className="flex gap-2 border-b border-slate-200 mb-6">
  <button className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${
    tab === t ? "border-slate-900 font-semibold" : "border-transparent text-slate-500 hover:text-slate-900"
  }`}>
// All panels
<div className="bg-white rounded-lg shadow p-6 max-w-2xl">
// All inputs
<input className="border p-2 rounded w-full" />
// All save buttons
<button className="bg-slate-900 text-white px-4 py-2 rounded text-sm ...">Save</button>
// OAuth button
<button className={`... ${oauthConnected ? "bg-green-600" : "bg-blue-600"} text-white`}>
// Import run button
<button className="bg-green-600 text-white px-4 py-2 rounded text-sm ...">Import</button>
```

**Fix (className-only):**
```jsx
// Page title
"text-[18px] font-semibold text-gray-900 mb-4"

// Tab bar wrapper — keep border-b
"flex gap-0 border-b border-gray-200 mb-6"

// Tab button — inactive
"px-4 py-2.5 text-[14px] border-b-2 border-transparent text-gray-500 hover:text-gray-800 -mb-px capitalize transition-colors"
// Tab button — active
"px-4 py-2.5 text-[14px] border-b-2 border-indigo-600 text-indigo-700 font-medium -mb-px capitalize"

// All panel cards
"bg-white border border-gray-200 rounded-lg p-6 max-w-2xl"

// Panel helper text
"text-[13px] text-gray-500 mb-5"

// All inputs (every tab)
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Number inputs
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Field label (global in SettingsView)
"block text-[12px] font-medium text-gray-600 mb-1.5"

// All save buttons
"bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 transition-colors"

// OAuth authorize button
// Change from one-off bg-blue-600 / bg-green-600 to:
// pending: bg-indigo-600 hover:bg-indigo-700
// connected: bg-emerald-600 (keep success semantic, change to brand-adjacent green)
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium disabled:opacity-40 flex items-center gap-2"
// connected state:
"bg-emerald-600 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-2"

// SecretInput toggle button
"absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"

// Radio label wrapper
"flex items-center gap-2 text-[14px] text-gray-700"

// Import: run button
"bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40"
// Import: pick file button
"bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px] flex items-center gap-2"
// Import: success result
"mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-[14px]"
// success title
"font-medium text-emerald-800"

// Import meta-key chips — inactive
"text-[12px] px-3 py-1 rounded-full cursor-pointer border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
// selected
"text-[12px] px-3 py-1 rounded-full cursor-pointer border border-indigo-600 bg-indigo-600 text-white"

// Column mapping selects
"border border-gray-300 px-3 h-10 rounded-md text-[14px] col-span-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"

// SyncTab section headers
"text-[14px] font-semibold text-gray-900 mb-2"
// mono values
"font-mono text-[13px] text-gray-700"
// Replay button
"bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-5 h-9 rounded-md text-[14px]"
// Sync how-it-works code block
"block bg-gray-50 border border-gray-200 px-4 py-3 rounded-lg text-[12px] font-mono text-gray-600"

// AutomationTab: rule form container
"border border-gray-200 rounded-lg p-4 mb-4 space-y-3 bg-gray-50"
// mono inputs (patterns)
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
// Rule card
"border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between hover:border-gray-300"
// Rule name
"text-[14px] font-medium text-gray-900"
// Rule pattern
"text-[12px] text-gray-500 font-mono"
// Automation info box
"mt-6 p-4 bg-indigo-50 border border-indigo-200 rounded-lg text-[12px]"
// info title
"font-semibold text-indigo-900 mb-1.5"

// PaymentsTab: method card
"border border-gray-200 rounded-lg px-4 py-3 flex items-start justify-between"
// kind badge
"text-[11px] font-medium font-mono bg-gray-100 px-2 py-0.5 rounded text-gray-600"
// method label
"font-medium text-[14px] text-gray-900"
// details pre
"text-[12px] text-gray-500 mt-1 whitespace-pre-wrap font-mono"
// up/down buttons
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
// edit button
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
// delete button
"text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"

// TemplatesTab: add row — STRUCTURE CHANGE: add labels above inputs
<div className="grid grid-cols-12 gap-2 mb-4">
  <div className="col-span-7">
    <label className="block text-[12px] font-medium text-gray-500 mb-1">Description</label>
    <input className="border border-gray-300 px-3 h-9 rounded-md text-[14px] w-full ..." />
  </div>
  <div className="col-span-2">
    <label className="block text-[12px] font-medium text-gray-500 mb-1">Rate</label>
    <input ... />
  </div>
  <div className="col-span-1">
    <label className="block text-[12px] font-medium text-gray-500 mb-1">Qty</label>
    <input ... />
  </div>
  <div className="col-span-2 flex items-end">
    <button className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-4 rounded-md text-[14px] font-medium w-full ...">Add</button>
  </div>
</div>
// Template item row
"flex items-center justify-between border border-gray-100 rounded-lg px-4 py-2.5 text-[14px] hover:border-gray-200"
```

**Change type:** Tab bar, TemplatesTab add row are structural; all others className-only.

---

### ClientDetailView.tsx

**Current:**
```
<button className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-4">
  <ArrowLeft size={14} /> Back to Clients
</button>
<div className="bg-white rounded-lg shadow p-6 mb-4">
  <h2 className="text-2xl font-bold">{client.name}</h2>
  <div className="mt-4 inline-flex items-center gap-2 bg-slate-900 text-white px-3 py-1.5 rounded-full text-sm">
<div className="flex gap-2 mb-4">
  <button className={`px-4 py-1.5 text-sm rounded capitalize ${detailTab === t ? "bg-slate-900 text-white" : "bg-slate-100"}`}>
<div className="bg-violet-50 border border-violet-200 rounded-lg p-4 mb-4">
  <button className="text-xs bg-violet-600 text-white px-3 py-1 rounded ...">
```

**Fix (className-only):**
```jsx
// Back button
"flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-900 mb-5 font-medium transition-colors"

// Header card
"bg-white border border-gray-200 rounded-lg p-6 mb-4"

// Client name
"text-[18px] font-semibold text-gray-900"

// Company line
"text-[13px] text-gray-500 flex items-center gap-1.5 mt-1"

// Lead status badge — use updated statusColor with border+bg pattern
"text-[11px] font-medium px-2.5 py-1 rounded-full border uppercase tracking-wide"

// Contact row
"flex gap-4 mt-3"
// Contact link
"flex items-center gap-1.5 text-[13px] text-indigo-600 hover:text-indigo-800"

// Outstanding/Paid section (right side of header)
"text-right text-[13px]"
// label
"text-[12px] font-medium text-gray-400 uppercase tracking-wide"
// outstanding value
"text-[20px] font-semibold text-amber-600 tabular-nums"
// paid value
"text-[16px] font-semibold text-emerald-600 tabular-nums mt-1"

// Invoice count pill
"mt-4 inline-flex items-center gap-2 bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full text-[13px] font-medium"

// Notes block
"mt-4 px-4 py-3 bg-gray-50 border border-gray-100 rounded-lg text-[13px] text-gray-600"

// Metadata grid
"grid grid-cols-3 gap-4 mb-4"

// MetadataCard
"bg-white border border-gray-200 rounded-lg p-4"
// Card title
"text-[12px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-2 mb-3 pb-2 border-b border-gray-100"

// MetaRow
// label: "text-[11px] font-medium text-gray-400 uppercase tracking-wide mt-2 first:mt-0"
// value: "text-[13px] text-gray-800 mt-0.5"

// Detail tab bar — change to underline tabs matching SettingsView
"flex gap-0 border-b border-gray-200 mb-4"
// inactive
"px-4 py-2.5 text-[14px] border-b-2 border-transparent text-gray-500 hover:text-gray-800 -mb-px capitalize"
// active
"px-4 py-2.5 text-[14px] border-b-2 border-indigo-600 text-indigo-700 font-medium -mb-px capitalize"

// AI Summary section — map violet to indigo
"bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-4"
// title
"font-semibold text-[14px] text-indigo-900 flex items-center gap-2"
// Summarize button
"text-[12px] bg-indigo-600 hover:bg-indigo-700 text-white px-3 h-7 rounded-md font-medium disabled:opacity-50 flex items-center gap-1.5"
// summary text
"text-[13px] text-gray-700 whitespace-pre-wrap leading-relaxed"
// helper text
"text-[13px] text-indigo-700"

// Interactions / Invoices panels
"bg-white border border-gray-200 rounded-lg"
// panel header
"flex items-center justify-between px-4 py-3.5 border-b border-gray-100"
// panel title
"text-[14px] font-semibold text-gray-800 flex items-center gap-2"
// Add Note button
"text-[12px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1"

// Interaction item
"px-4 py-3 border-b border-gray-100"
// kind badge — use kindColor() updated:
// email_in:  "bg-blue-50 text-blue-700 border border-blue-200"
// email_out: "bg-indigo-50 text-indigo-700 border border-indigo-200"
// call:      "bg-emerald-50 text-emerald-700 border border-emerald-200"
// meeting:   "bg-amber-50 text-amber-700 border border-amber-200"
// default:   "bg-gray-100 text-gray-600 border border-gray-200"
// badge class: "text-[11px] font-medium px-2 py-0.5 rounded-full border uppercase tracking-wide"
// timestamp: "text-[11px] text-gray-400 ml-1"
// subject: "text-[14px] font-medium text-gray-900 mt-1"
// body: "text-[13px] text-gray-600 mt-0.5 whitespace-pre-wrap"

// NoteForm
"px-4 py-3 bg-gray-50 border-b border-gray-200"
// kind select
"border border-gray-300 px-2 h-8 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
// subject input
"border border-gray-300 px-3 h-8 rounded-md text-[13px] flex-1 focus:outline-none focus:ring-1 focus:ring-indigo-500"
// textarea
"border border-gray-300 px-3 py-2 rounded-md text-[13px] w-full mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
// save button
"bg-indigo-600 hover:bg-indigo-700 text-white px-3 h-7 rounded-md text-[12px] font-medium disabled:opacity-40"
// cancel button
"text-[12px] text-gray-500 hover:text-gray-800"

// Invoice card in detail
"px-4 py-3 border-b border-gray-100"
// number
"font-mono text-[12px] text-gray-500"
// total
"text-[14px] font-semibold text-gray-900 tabular-nums"
// due date
"text-[12px] text-gray-500"
// status badge — same invoiceStatusColor with border pattern

// Email thread item
"px-4 py-3.5 border-b border-gray-100"
// Received badge
"bg-blue-50 text-blue-700 border border-blue-200 text-[11px] font-medium px-2 py-0.5 rounded-full border uppercase"
// Sent badge
"bg-indigo-50 text-indigo-700 border border-indigo-200 text-[11px] font-medium px-2 py-0.5 rounded-full border uppercase"

// Timeline item
"px-4 py-3 border-b border-gray-100"
// date
"text-[11px] text-gray-400 mb-1"
// invoice badge (timeline)
"text-[11px] font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600"
```

**Change type:** Tab bar is structural (underline vs pill); all others className-only.

---

### QuickLogModal.tsx

**Current:**
```
<div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40">
  <div className="bg-white rounded-lg shadow-xl w-[500px] max-h-[80vh] overflow-auto">
  <div className="flex items-center justify-between p-4 border-b">
    <h3 className="font-semibold">Quick Log</h3>
  <div className="p-4 space-y-4">
    <input className="border p-2 rounded w-full text-sm" />
    <button className={`px-3 py-1 text-sm rounded ${kind === k ? "bg-slate-900 text-white" : "bg-slate-100"}`}>
    <textarea className="border p-2 rounded w-full text-sm" />
    <button className="bg-slate-900 text-white px-4 py-2 rounded text-sm ... disabled:opacity-50">Log</button>
```

**Fix (className-only):**
```jsx
// Backdrop
"fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/30 backdrop-blur-[2px]"

// Modal card
"bg-white rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.14)] w-[500px] max-h-[80vh] overflow-auto"

// Header
"flex items-center justify-between px-5 py-4 border-b border-gray-100"
// title
"text-[15px] font-semibold text-gray-900"
// shortcut hint — STRUCTURE CHANGE: add hint next to title
<div className="flex items-center gap-2">
  <h3 className="text-[15px] font-semibold text-gray-900">Quick Log</h3>
  <span className="text-[11px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded">L</span>
</div>
// close button
"text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"

// Body
"px-5 py-4 space-y-4"

// All labels
"block text-[12px] font-medium text-gray-600 mb-1.5"

// Client input
"border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"

// Suggestions dropdown
"absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.08)] mt-1 z-10 max-h-40 overflow-auto"
// Suggestion item
"w-full text-left px-4 py-2.5 text-[14px] text-gray-800 hover:bg-gray-50 transition-colors"
// Company in suggestion
"text-gray-400 ml-2 text-[13px]"

// Kind pill — inactive
"px-3 h-8 text-[13px] font-medium rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
// Kind pill — active
"px-3 h-8 text-[13px] font-medium rounded-md bg-indigo-600 text-white"

// Textarea
"border border-gray-300 px-3 py-2.5 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"

// Toast messages
// success: "text-[13px] px-4 py-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800"
// error:   "text-[13px] px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700"

// Footer buttons
"px-4 h-9 text-[14px] text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
"bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 disabled:opacity-40"
```

**Change type:** Modal header shortcut hint is structural; all others className-only.

---

### Shared Elements

**Status badges (all components)**

Replace current `statusColor()` and `kindColor()` strings in every component with:
```js
// Client lead_status
hot_lead:        "bg-red-50 text-red-700 border border-red-200"
warm:            "bg-orange-50 text-orange-700 border border-orange-200"
active_customer: "bg-emerald-50 text-emerald-700 border border-emerald-200"
inactive:        "bg-gray-100 text-gray-500 border border-gray-200"
prospect:        "bg-indigo-50 text-indigo-700 border border-indigo-200"

// Invoice status
paid:            "bg-emerald-50 text-emerald-700 border border-emerald-200"
sent:            "bg-blue-50 text-blue-700 border border-blue-200"
overdue:         "bg-red-50 text-red-700 border border-red-200"
deposit_pending: "bg-amber-50 text-amber-700 border border-amber-200"
draft:           "bg-gray-100 text-gray-600 border border-gray-200"

// Badge wrapper class (every usage)
"inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide"
```

**Empty states**
```jsx
// wrapper (inside td or container)
"py-16 text-center"
// icon wrapper — STRUCTURE CHANGE: all empty states need an icon
<div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
  <Users size={18} className="text-gray-400" />  {/* or relevant icon */}
</div>
// heading
"text-[16px] font-semibold text-gray-800 mb-1"
// subtext
"text-[14px] text-gray-400 mb-4"
// CTA button — same as primary button
"bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium inline-flex items-center gap-2"
```

**Tables (shared pattern)**
```jsx
// Container
"bg-white border border-gray-200 rounded-lg overflow-hidden"
// thead
"bg-gray-50 border-b border-gray-200"
// th
"text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide"
// tbody tr
"border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
// td default
"px-4 py-3 text-[14px] text-gray-700"
// td primary (name/number)
"px-4 py-3 text-[14px] font-medium text-gray-900"
// td monospace
"px-4 py-3 font-mono text-[13px] text-gray-600"
// td numeric
"px-4 py-3 text-[14px] font-semibold text-gray-900 tabular-nums"
```

---

## Section 4: Global CSS Changes

Full replacement for `src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --color-primary:        #4F46E5;
  --color-primary-hover:  #4338CA;
  --color-primary-light:  #EEF2FF;
  --color-primary-text:   #4338CA;
  --color-success:        #059669;
  --color-success-bg:     #ECFDF5;
  --color-success-border: #A7F3D0;
  --color-success-text:   #065F46;
  --color-warning:        #D97706;
  --color-warning-bg:     #FFFBEB;
  --color-warning-border: #FDE68A;
  --color-warning-text:   #92400E;
  --color-error:          #DC2626;
  --color-error-bg:       #FEF2F2;
  --color-error-border:   #FECACA;
  --color-error-text:     #991B1B;
  --color-info:           #2563EB;
  --color-info-bg:        #EFF6FF;
  --color-info-border:    #BFDBFE;
  --color-info-text:      #1E40AF;
  --color-bg:             #F8F7F6;
  --color-surface:        #FFFFFF;
  --color-text-primary:   #111827;
  --color-text-secondary: #6B7280;
  --color-text-hint:      #9CA3AF;
  --color-border:         #E5E7EB;
  --color-border-strong:  #D1D5DB;
  --shadow-card:          0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-panel:         0 4px 16px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
  --shadow-modal:         0 20px 60px rgba(0,0,0,0.14), 0 8px 24px rgba(0,0,0,0.08);
  --radius-sm:            6px;
  --radius-md:            8px;
  --radius-full:          9999px;
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body, #root {
  height: 100%;
}

body {
  background-color: #F8F7F6;
  color: #111827;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Scrollbar styling — Windows/Chrome */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: #D1D5DB;
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: #9CA3AF;
}

/* Selection */
::selection {
  background: #EEF2FF;
  color: #3730A3;
}

/* Focus visible — override browser default with indigo ring */
:focus-visible {
  outline: 2px solid #4F46E5;
  outline-offset: 2px;
}

/* Remove default focus for mouse users */
:focus:not(:focus-visible) {
  outline: none;
}

/* Monospace font for invoice numbers, IDs, code */
.font-mono,
code,
pre {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
}

/* Tabular numbers utility (already in Tailwind as tabular-nums but explicit here) */
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

/* Sidebar nav item utility (used 5+ times) */
.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  height: 40px;
  border-radius: 6px;
  font-size: 14px;
  color: #6B7280;
  transition: background-color 0.1s, color 0.1s;
  text-decoration: none;
  border: none;
  background: none;
  cursor: pointer;
  white-space: nowrap;
}
.nav-item:hover {
  background-color: #F3F4F6;
  color: #111827;
}
.nav-item.active {
  background-color: #EEF2FF;
  color: #4338CA;
  font-weight: 500;
}

/* Badge utility (used 8+ times across status badges) */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  border-width: 1px;
  border-style: solid;
  line-height: 1.4;
}

/* Card utility (used 10+ times) */
.card {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
}

/* Input utility (used 20+ times) */
.input {
  border: 1px solid #D1D5DB;
  padding: 0 12px;
  height: 40px;
  border-radius: 6px;
  font-size: 14px;
  width: 100%;
  background: #FFFFFF;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.input:focus {
  outline: none;
  border-color: transparent;
  box-shadow: 0 0 0 2px #4F46E5;
}
.input::placeholder {
  color: #9CA3AF;
}

/* Btn-primary utility (used 15+ times) */
.btn-primary {
  background: #4F46E5;
  color: #FFFFFF;
  padding: 0 16px;
  height: 36px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background-color 0.15s;
  white-space: nowrap;
}
.btn-primary:hover:not(:disabled) {
  background: #4338CA;
}
.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Btn-secondary utility */
.btn-secondary {
  background: #FFFFFF;
  color: #374151;
  padding: 0 16px;
  height: 36px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 400;
  border: 1px solid #E5E7EB;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background-color 0.15s;
  white-space: nowrap;
}
.btn-secondary:hover:not(:disabled) {
  background: #F9FAFB;
}

/* Section label utility */
.section-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6B7280;
}
```

---

## Section 5: Implementation Order

Ordered by visual impact — highest to lowest. All changes are in `src/components/` and `src/App.tsx` only (plus `src/index.css`).

| # | File | What Changes | Type | Est. Lines |
|---|------|-------------|------|-----------|
| 1 | `src/index.css` | Full replacement — CSS vars, resets, scrollbar, utility classes | Rewrite | 7 → ~140 |
| 2 | `src/App.tsx` | Sidebar: white bg, indigo active state, 40px nav items, status footer | className-only | ~15 lines |
| 3 | `src/App.tsx` | Main area: `bg-[#F8F7F6]`, `p-8` padding | className-only | 2 lines |
| 4 | `src/components/InvoicesView.tsx` | `statusColor()` — add borders, rounded-full badges | className-only | 5 lines |
| 5 | `src/components/ClientsView.tsx` | `statusColor()` — same badge fix | className-only | 5 lines |
| 6 | `src/components/ClientDetailView.tsx` | `kindColor()` + `invoiceStatusColor()` — same badge fix | className-only | 10 lines |
| 7 | `src/components/DashboardView.tsx` | Stat card icon containers → tinted, border on cards, indigo quick-action hover | Structural + className | ~25 lines |
| 8 | `src/components/ClientsView.tsx` | Table: border container, `px-4 py-3` cells, indigo primary button, filter pills | className-only | ~20 lines |
| 9 | `src/components/InvoicesView.tsx` | Table + action buttons + primary button + toast | className-only | ~25 lines |
| 10 | `src/components/InvoicesView.tsx` | InvoiceDetailPanel: panel header, meta labels, footer buttons | className-only | ~20 lines |
| 11 | `src/components/SettingsView.tsx` | Tab indicator → `border-indigo-600`, all save buttons → indigo, all inputs → h-10 | className-only | ~35 lines |
| 12 | `src/components/EmailView.tsx` | Mode switcher → underline tabs, scan button, panel borders | Structural + className | ~20 lines |
| 13 | `src/components/ClientDetailView.tsx` | Tab bar → underline, AI section → indigo, header card, badge improvements | Structural + className | ~30 lines |
| 14 | `src/components/QuickLogModal.tsx` | Modal card, kind pills → indigo, input focus rings, toast semantic colors | Structural + className | ~20 lines |
| 15 | `src/components/InvoicesView.tsx` | payModal: backdrop blur, card border-radius, indigo confirm button | className-only | ~10 lines |
| 16 | `src/components/InvoicesView.tsx` | InvoiceForm: indigo create button, focus rings on all inputs, totals border | className-only | ~20 lines |
| 17 | `src/components/ClientsView.tsx` | ClientForm: indigo save button, h-10 inputs, cancel button with border | className-only | ~15 lines |
| 18 | `src/components/DashboardView.tsx` | Secondary metrics → `border` not `shadow`, quick actions → indigo hover | className-only | ~10 lines |
| 19 | `src/components/SettingsView.tsx` | Automation: info box indigo, rule cards, PaymentsTab chevrons, TemplatesTab labels | Structural + className | ~25 lines |
| 20 | Empty states (all files) | Icon + heading + subtext + indigo CTA in every empty state | Structural | ~30 lines total |

---

## Section 6: Before/After Description

### Sidebar (App.tsx)

**Before:** A dark charcoal panel (`bg-slate-900`) covering the full height of the app. The brand name "ClientHub" sits in white text in the top-left. Nav items are 36px tall buttons with white text and a 16px icon — active items darken to `bg-slate-700` which is nearly invisible on the dark base, giving no clear signal about which view you're in. The footer status area is a dense 12px text zone with a sync button that looks identical to the status display. The email badge is a generic red `bg-red-500` pill.

**After:** A clean white sidebar with a single 1px right border (`border-r border-gray-200`). The brand name is 15px semibold in near-black. Each nav item is exactly 40px tall, rounded with `rounded-md`, and the icon is 18px. Inactive items are medium-gray; hover shows a light gray tint. The active item shows an indigo-tinted background (`bg-indigo-50`) with indigo text (`text-indigo-700`) and medium weight — unmistakable at a glance. The email badge is `bg-indigo-600`. The footer is airy at 12px medium gray. The Sync button has a subtle hover state that differentiates it from the status labels.

---

### Dashboard (DashboardView.tsx)

**Before:** Four stat cards with visually identical page-title-sized values (`text-2xl font-bold`). Each card has a colored icon box — a solid blue, violet, amber, or green square — which reads as dated Bootstrap dashboard chrome. Cards float with `shadow` only, no border. Below them, three secondary metric cards are styled identically, creating no information hierarchy. Quick Action buttons are plain bordered boxes with no icon, looking like inactive input fields.

**After:** Four stat cards on a white surface with `border border-gray-200` and a subtle card shadow. Each icon lives in a small tinted rounded square — indigo-50 for clients, violet-50 for invoices, amber-50 for outstanding, emerald-50 for paid — with the icon itself in the matching tint color. The label is 12px uppercase gray, the value is 22px semibold. Secondary metrics have their own lighter visual weight with a 12px uppercase section label. Quick Action buttons feature a relevant icon, hover to `bg-indigo-50 border-indigo-200` with the icon tinting indigo — giving them clear clickability without screaming for attention.

---

### Client List (ClientsView.tsx)

**Before:** A page with a black `bg-slate-900` "New Client" button top-right, a borderless search input, black filter pills for active states, and a table with `bg-white rounded shadow` container — no border. Table headers are in a `bg-slate-100` strip with 12px padding per cell. Status is a raw `<select>` element with background color applied. Revenue and name cells have identical `p-3` padding and weight. Empty state is plain centered gray text.

**After:** The "New Client" button is `bg-indigo-600` with medium weight — the only indigo-600 element in the toolbar, making it the obvious primary action. The search input is 40px tall with a `border-gray-300` and a visible indigo focus ring. Filter pills show `bg-indigo-600 text-white` when active (not black), and a 1px vertical divider separates stale filters from status filters. The table container has `border border-gray-200 rounded-lg`. Headers are `bg-gray-50` with 12px uppercase tracking. Cells are `px-4 py-3`. Name cells are `font-medium text-gray-900`; secondary fields are `text-gray-700`; revenue is right-aligned monospace `font-semibold`. Status badges are pill-shaped with a matching tinted border and background. Empty state has a centered Users icon in a gray circle, a 16px heading, subtext, and an indigo CTA.

---

### Invoice List (InvoicesView.tsx)

**Before:** Same layout as client list but the action column is especially rough — icon buttons (`Edit2`, `Trash2`, `FileDown`, `Send`, `Check`) plus one text-only `"Deposit"` button in 12px yellow, all jammed into `space-x-2`. Status badges use `px-2 py-0.5 rounded` — square-ish, no border, inconsistent weights. The toast notification is a black rectangle (`bg-slate-900`) at the bottom-right with no icon. The detail slide-in panel footer has two equal-weight buttons side by side.

**After:** Action column icons each have a `p-1 rounded hover:bg-*-50` wrapper giving them a clear tap target and semantic color on hover (indigo for PDF/download, blue for send, emerald for mark paid, red for delete). "Deposit" becomes a consistently styled 12px amber-colored text pill matching the deposit badge's palette. Status badges are `rounded-full` with the full border+bg treatment — visually distinct from any other element type. The toast gains a small `text-emerald-400 Check` icon on the left. The detail panel footer makes "Download PDF" the clear primary (`bg-indigo-600 flex-1`) and "Resend" the secondary (`border border-gray-200 flex-1`).
