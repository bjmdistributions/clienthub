# TASK-OPS: Operations Partner Features

Six features that transform ClientHub from a billing tool into a full operations platform. Build in order — each depends on data from the previous.

Read this entire file before planning anything. Do features in order. Plan-first per feature, wait for approval, execute, verify with `npm run build` and `cargo check`.

---

## Architecture invariants (apply to every feature)

- All writes to synced tables go through `sync::record_upsert` THEN direct SQL mirror
- SQLite connections cannot cross `.await` boundaries — scope in inner `{ }` blocks
- Migrations are append-only — never edit prior migrations
- `newsletters`, `newsletter_sends`, `sheet_sync_config`, `sheet_sync_log` are local-only
- Synced tables: `clients`, `interactions`, `invoices`, `settings`, `payment_methods`, `categories`, `deals` (new), `shipments` (new), `suppliers` (new)
- Read `PDF-API-CONTRACT.md` before touching invoice.rs
- Use `tauri::async_runtime::spawn` not `tokio::spawn` for any spawned tasks
- Use `app.handle().clone()` to capture AppHandle in spawns — never `app` directly

---

## FEATURE 1: Deal Pipeline & Quote Builder

### Business purpose

A deal exists between "found a potential buyer" and "money in bank." Currently this lifecycle happens in the salesperson's head and email. By tracking it explicitly, operations gets visibility into deal economics before they close, costs are entered upfront not after, and conversion gets one click instead of manual re-entry.

### DB changes — Migration (next available version)

```sql
CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'lead',
    line_items_json TEXT NOT NULL DEFAULT '[]',
    supplier_costs_json TEXT NOT NULL DEFAULT '[]',
    shipping_cost REAL DEFAULT 0,
    other_costs REAL DEFAULT 0,
    asking_price REAL DEFAULT 0,
    payment_terms TEXT,
    notes TEXT,
    expected_close_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    won_at TEXT,
    lost_at TEXT,
    lost_reason TEXT,
    converted_invoice_id TEXT,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_client ON deals(client_id);
CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at);
```

`deals` is a **synced table** — add to `ALLOWED_TABLES` in `sync.rs`.

### Data structures

```rust
// line_items_json — same shape as invoices
[{ "description": "...", "qty": 10.0, "rate": 50.0, "amount": 500.0 }]

// supplier_costs_json — parallel cost detail
[{ "description": "Product cost", "amount": 300.0, "supplier_id": "uuid" },
 { "description": "Customs fee", "amount": 50.0, "supplier_id": null }]
```

### Stages (in order)
`lead` → `quoted` → `negotiating` → `won` → `lost`

### Backend: `src-tauri/src/commands.rs`

```rust
pub struct Deal { /* all columns above */ }

pub struct DealInput {
    pub client_id: String,
    pub title: String,
    pub stage: Option<String>,
    pub line_items: Vec<LineItem>,
    pub supplier_costs: Vec<CostItem>,
    pub shipping_cost: f64,
    pub other_costs: f64,
    pub asking_price: f64,
    pub payment_terms: Option<String>,
    pub notes: Option<String>,
    pub expected_close_date: Option<String>,
}

pub struct CostItem {
    pub description: String,
    pub amount: f64,
    pub supplier_id: Option<String>,
}

// All commands route writes through sync::record_upsert
async fn list_deals() -> Result<Vec<Deal>, String>
async fn list_deals_by_stage(stage: String) -> Result<Vec<Deal>, String>
async fn get_deal(id: String) -> Result<Deal, String>
async fn create_deal(input: DealInput) -> Result<String, String>  // returns new deal id
async fn update_deal(id: String, input: DealInput) -> Result<(), String>
async fn update_deal_stage(id: String, stage: String, lost_reason: Option<String>) -> Result<(), String>
async fn delete_deal(id: String) -> Result<(), String>

// Conversion: creates an invoice from a won deal, links them
async fn convert_deal_to_invoice(deal_id: String) -> Result<String, String>  // returns invoice id
```

`convert_deal_to_invoice` logic:
1. Load deal, must be stage=`won`
2. Compute totals from line items
3. Create invoice via existing `create_invoice` flow (through `sync::record_upsert`)
4. Copy line items, supplier_costs (as cost_items_json), shipping_cost (add to cost_items), client_id
5. Update deal: set `converted_invoice_id` to new invoice id
6. Return invoice id

Register all in `main.rs`.

### Frontend: `src/lib/api.ts`

```typescript
export interface Deal {
  id: string;
  client_id: string;
  title: string;
  stage: 'lead' | 'quoted' | 'negotiating' | 'won' | 'lost';
  line_items_json: string;
  supplier_costs_json: string;
  shipping_cost: number;
  other_costs: number;
  asking_price: number;
  payment_terms?: string;
  notes?: string;
  expected_close_date?: string;
  created_at: string;
  updated_at: string;
  won_at?: string;
  lost_at?: string;
  lost_reason?: string;
  converted_invoice_id?: string;
}

export interface DealInput { /* matches backend */ }
```

Add all API methods.

### Frontend: new file `src/components/DealsView.tsx`

**Layout: Kanban board** — 5 columns horizontally scrollable:
- Lead (gray)
- Quoted (blue)
- Negotiating (amber)
- Won (green)
- Lost (red, collapsed by default)

Each column shows deal cards stacked vertically. Card shows:
- Client name (bold)
- Deal title
- Asking price (right side, bold)
- Calculated margin badge (green if >20%, amber if 10-20%, red if <10%)
- Expected close date if set

Card drag-and-drop between columns updates stage (use HTML5 drag API, no library needed).

When dragging to "Lost" — prompt for reason before saving.
When dragging to "Won" — show "Convert to invoice now?" confirmation.

**Deal detail panel** (slide-in from right, 520px wide):
- Top: client selector + deal title input
- Stage dropdown
- Line items section (same UI as invoice form)
- Supplier costs section (mirrors line items — description, amount, supplier dropdown)
- Shipping cost input
- Other costs input
- Asking price input
- **Live margin calculation** (large, prominent):
  - Revenue: asking_price
  - Total costs: sum of supplier_costs + shipping + other
  - Profit: revenue - costs (green/red)
  - Margin %: (profit / revenue) * 100 (green/red)
- Payment terms, notes, expected close date
- Save / Delete / Convert to Invoice buttons

### App.tsx changes

Add "Deals" to the nav between Clients and Invoices. Icon: `Briefcase` from lucide-react.

### Acceptance criteria
- Kanban board renders with 5 columns
- Creating a deal saves to DB and appears in correct column
- Drag-and-drop moves deal between stages
- Margin updates live as costs/price change
- Convert-to-invoice creates a synced invoice with all data carried over
- Lost deals require a reason
- `cargo check` and `npm run build` pass

---

## FEATURE 2: Shipping Cost Intelligence

### Business purpose

Shipping pricing currently lives in the salesperson's head. Build a historical cost database so anyone can quote shipping in seconds based on past data.

### DB changes — Migration (next version)

```sql
CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT,
    deal_id TEXT,
    origin_city TEXT,
    origin_state TEXT,
    origin_zip TEXT NOT NULL,
    dest_city TEXT,
    dest_state TEXT,
    dest_zip TEXT NOT NULL,
    weight_lbs REAL NOT NULL,
    dimensions_inches TEXT,
    carrier TEXT,
    service_level TEXT,
    quoted_cost REAL,
    actual_cost REAL,
    shipped_at TEXT,
    delivered_at TEXT,
    tracking_number TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shipments_invoice ON shipments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_shipments_zips ON shipments(origin_zip, dest_zip);
CREATE INDEX IF NOT EXISTS idx_shipments_weight ON shipments(weight_lbs);
```

`shipments` is a **synced table** — add to `ALLOWED_TABLES`.

### Backend commands

```rust
pub struct Shipment { /* all columns */ }
pub struct ShipmentInput { /* all fields */ }

pub struct ShippingEstimate {
    pub sample_count: u32,
    pub avg_cost: f64,
    pub min_cost: f64,
    pub max_cost: f64,
    pub p50_cost: f64,  // median
    pub recent_samples: Vec<ShipmentSample>,
}

pub struct ShipmentSample {
    pub date: String,
    pub origin_zip: String,
    pub dest_zip: String,
    pub weight_lbs: f64,
    pub carrier: Option<String>,
    pub actual_cost: f64,
}

async fn list_shipments() -> Result<Vec<Shipment>, String>
async fn get_shipment(id: String) -> Result<Shipment, String>
async fn create_shipment(input: ShipmentInput) -> Result<String, String>
async fn update_shipment(id: String, input: ShipmentInput) -> Result<(), String>
async fn delete_shipment(id: String) -> Result<(), String>

// Find similar past shipments and return aggregate stats
async fn estimate_shipping(
    origin_zip: String,
    dest_zip: String,
    weight_lbs: f64,
) -> Result<ShippingEstimate, String>
```

`estimate_shipping` logic:
1. Match on first 3 digits of zip codes (zip prefix) — broader if no matches, narrower if many
2. Weight range: weight_lbs ± 20%
3. Pull shipments with actual_cost IS NOT NULL
4. Try strictest match first: same zip3 + weight range
5. If <3 results: relax to same first 2 digits of state zip
6. If still <3 results: relax to same state
7. Return aggregate stats + last 5 sample shipments

### Frontend: `src/lib/api.ts`

Add `Shipment`, `ShipmentInput`, `ShippingEstimate` types and 6 API methods.

### Frontend: new file `src/components/ShippingView.tsx`

Two panels side-by-side:

**Left panel — Estimator (sticky top):**
- Origin ZIP input
- Destination ZIP input
- Weight (lbs) input
- "Estimate" button
- Result card showing:
  - Sample count: "Based on N similar shipments"
  - Median: bold large number
  - Range: min-max
  - Carrier breakdown if mixed
  - Recent samples table (last 5)
- "Copy estimate" button (copies "Estimated shipping: $X-$Y based on N past shipments")

**Right panel — Shipments list:**
- Search bar
- Filter by carrier dropdown
- Table: Date | Origin | Dest | Weight | Carrier | Quoted | Actual | Status
- Click row opens detail/edit panel
- "Add Shipment" button

### Integration with Deal form

In the Deal detail panel, add a "Get shipping estimate" button next to the shipping_cost field. Clicking it opens a small inline form (origin zip, dest zip, weight) and calls `estimate_shipping`. The result auto-populates `shipping_cost` with the median (user can override).

### Acceptance criteria
- Add shipments manually
- Estimator returns reasonable results based on past data
- Estimator handles "no matches" gracefully ("Not enough historical data — log this shipment to start building your dataset")
- Integration with Deal form auto-fills shipping cost
- `cargo check` and `npm run build` pass

---

## FEATURE 3: Supplier Performance Dashboard

### Business purpose

Suppliers are graded by data, not gut feel. Track which suppliers actually make money over time.

### DB changes — Migration (next version)

```sql
CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    payment_terms TEXT,
    category TEXT,
    rating INTEGER DEFAULT 3,
    notes TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);
```

`suppliers` is a **synced table** — add to `ALLOWED_TABLES`.

### Backend commands

```rust
pub struct Supplier { /* all columns */ }
pub struct SupplierInput { /* all fields */ }

pub struct SupplierStats {
    pub supplier_id: String,
    pub supplier_name: String,
    pub total_spend: f64,
    pub order_count: u32,
    pub last_order_date: Option<String>,
    pub avg_margin: f64,        // avg margin on invoices using this supplier
    pub on_time_rate: f64,      // % shipments delivered on time
    pub recent_price_change: Option<f64>,  // % change in last 90 days
}

async fn list_suppliers() -> Result<Vec<Supplier>, String>
async fn get_supplier(id: String) -> Result<Supplier, String>
async fn create_supplier(input: SupplierInput) -> Result<String, String>
async fn update_supplier(id: String, input: SupplierInput) -> Result<(), String>
async fn delete_supplier(id: String) -> Result<(), String>
async fn supplier_stats() -> Result<Vec<SupplierStats>, String>
async fn get_supplier_stats(id: String) -> Result<SupplierStats, String>
```

`supplier_stats` queries:
- Total spend: sum of `amount` from `cost_items_json` across all invoices where supplier_id matches
- Order count: distinct invoice count with this supplier in any cost item
- Last order date: max(invoices.issue_date)
- Avg margin: across invoices with this supplier, average profit margin
- On-time rate: from shipments table if invoice has shipment linked (Phase 4)
- Recent price change: compare avg `amount` per supplier item in last 90 days vs prior 90 days

### Frontend: `src/lib/api.ts`

Add Supplier types and 7 API methods.

### Frontend: new file `src/components/SuppliersView.tsx`

**Suppliers list:**
- Search bar
- Filter: All / Active / Archived
- Sort: Name / Total Spend / Avg Margin / Last Order
- Table: Name | Category | Last Order | Total Spend | Avg Margin % | Rating (stars)
- Margin column color-coded (green >20%, amber 10-20%, red <10%)
- Click row opens detail panel

**Supplier detail panel:**
- Name, contact, email, phone, address, payment terms, category, rating (1-5 stars)
- Stats section (read-only):
  - Total spend
  - Order count
  - Last order date
  - Average margin
  - Recent price change (with arrow indicator)
- Recent invoices using this supplier (last 5)
- Notes textarea
- Save / Archive / Delete buttons

### Integration with Deal/Invoice cost items

When entering supplier costs in a deal or invoice, the supplier dropdown shows the suppliers list. Quick-add new supplier inline if not in the list (small "+ New supplier" option opens a mini form).

### App.tsx changes

Add "Suppliers" to the nav, icon `Truck` or `Package` from lucide-react.

### Acceptance criteria
- Suppliers table renders with stats
- Cost items in deals/invoices can reference a supplier
- Supplier stats update as new invoices are paid
- Top-3 suppliers by spend shown on dashboard
- `cargo check` and `npm run build` pass

---

## FEATURE 4: Customer Health Score

### Business purpose

Surface at-risk customers automatically. Operations generates the priority list, sales acts on it.

### No DB changes

Compute on demand from existing data.

### Backend commands

```rust
pub struct CustomerHealth {
    pub client_id: String,
    pub client_name: String,
    pub score: u32,  // 0-100
    pub risk_level: String,  // "healthy" | "watch" | "at_risk" | "critical"
    pub trend: String,  // "improving" | "stable" | "declining"
    pub risk_factors: Vec<String>,  // human-readable reasons
    pub last_interaction_days: Option<u32>,
    pub last_invoice_days: Option<u32>,
    pub avg_days_to_pay: Option<f64>,
    pub revenue_trend_pct: f64,  // last 90 days vs prior 90 days
}

async fn customer_health_scores() -> Result<Vec<CustomerHealth>, String>
async fn get_customer_health(client_id: String) -> Result<CustomerHealth, String>
```

Scoring algorithm (each component 0-100, weighted average):

**Component 1 — Recency of interaction (40% weight):**
- 0 days = 100
- 30 days = 70
- 60 days = 40
- 90+ days = 10
- Linear interpolation between

**Component 2 — Recency of invoice (30% weight):**
- Same curve as above but tuned to typical order cycle (calculate avg cycle per customer if 3+ invoices)

**Component 3 — Payment timeliness (15% weight):**
- Avg days from sent → paid across last 5 invoices
- If avg ≤ 14 days: 100
- If avg 15-30 days: 70
- If avg 31-45 days: 40
- If avg >45 days: 10

**Component 4 — Order size trend (15% weight):**
- Avg invoice total last 3 invoices vs prior 3 invoices
- Growing >10%: 100
- Stable ±10%: 70
- Declining 10-25%: 40
- Declining >25%: 10

Risk level from final score:
- 70-100: healthy (green)
- 50-69: watch (yellow)
- 30-49: at_risk (orange)
- 0-29: critical (red)

Trend: compute score 30 days ago using historical data, compare:
- Score went up 5+ points: improving
- Score changed ±5: stable
- Score went down 5+ points: declining

Risk factors (populate based on triggers):
- "No contact in N days"
- "No order in N days (avg cycle: M days)"
- "Slow paying: avg N days to pay"
- "Declining order size: down X%"
- "No payment received yet on $X overdue"

### Frontend: `src/lib/api.ts`

Add CustomerHealth type and 2 methods.

### Frontend changes

**`src/components/DashboardView.tsx`** — add "At-Risk Customers" widget:
- Section header
- Top 5 customers with score < 50, sorted by score ascending
- Each row: client name + score badge + top risk factor
- Click client → opens client detail
- "View all" link → opens full health view

**`src/components/ClientsView.tsx`** — add health score badge to client rows when score is computed (small colored dot with score number). Hover shows risk factors.

**`src/components/ClientDetailView.tsx`** — add Health card in the sidebar:
- Large score number + risk level badge
- Trend arrow (improving/declining)
- List of risk factors
- "Refresh" button (recomputes)

**New file `src/components/HealthView.tsx`** — accessible from "Customer Health" tab in sidebar:
- Full list of all clients with scores, sortable
- Filter by risk level
- Bulk actions: "Log follow-ups for selected"

### Acceptance criteria
- Health scores computed for all clients
- Dashboard shows top at-risk
- Client detail shows individual score with breakdown
- Trend correctly identifies declining customers
- `cargo check` and `npm run build` pass

---

## FEATURE 5: Weekly Brief Generator

### Business purpose

A single document that captures business state. Print-friendly. The basis of a weekly ops meeting between you and your brother.

### No DB changes

Aggregate from existing data.

### Backend commands

```rust
pub struct WeeklyBrief {
    pub generated_at: String,
    pub week_start: String,
    pub week_end: String,

    // Revenue & profit
    pub revenue_this_week: f64,
    pub revenue_last_week: f64,
    pub revenue_change_pct: f64,
    pub profit_this_week: f64,
    pub profit_last_week: f64,
    pub profit_change_pct: f64,
    pub avg_margin_this_week: f64,

    // Pipeline
    pub deals_count_by_stage: HashMap<String, u32>,
    pub pipeline_value: f64,  // sum of asking_price for all non-closed deals
    pub deals_closed_this_week: u32,
    pub deals_lost_this_week: u32,
    pub win_rate_this_week: f64,

    // Customer health
    pub at_risk_customers: Vec<CustomerHealth>,  // top 5

    // Cash & receivables
    pub overdue_invoices_count: u32,
    pub overdue_invoices_value: f64,
    pub follow_ups_due: u32,

    // Highlights
    pub best_margin_deal: Option<DealHighlight>,
    pub worst_margin_deal: Option<DealHighlight>,
    pub biggest_invoice: Option<InvoiceHighlight>,

    // Action items
    pub supplier_alerts: Vec<String>,  // e.g. "Supplier X price increased 15%"
    pub stuck_deals: Vec<StuckDeal>,  // deals in same stage >2x avg

    // Activity
    pub new_clients_this_week: u32,
    pub interactions_this_week: u32,
}

pub struct DealHighlight {
    pub deal_id: String,
    pub client_name: String,
    pub title: String,
    pub asking_price: f64,
    pub margin_pct: f64,
}

pub struct InvoiceHighlight {
    pub invoice_id: String,
    pub client_name: String,
    pub number: String,
    pub total: f64,
}

pub struct StuckDeal {
    pub deal_id: String,
    pub title: String,
    pub stage: String,
    pub days_in_stage: u32,
}

async fn generate_weekly_brief() -> Result<WeeklyBrief, String>
```

Week boundaries: Sunday 00:00 to Saturday 23:59 in local time. "This week" = current week. "Last week" = 7 days prior.

### Frontend: `src/lib/api.ts`

Add WeeklyBrief and related types.

### Frontend: new file `src/components/BriefView.tsx`

Print-friendly layout. Designed for either screen or paper.

**Header:**
- Logo / "ClientHub Weekly Brief"
- Date range
- Generated timestamp

**Section 1: This Week At-a-Glance** (4-stat grid)
- Revenue (with arrow vs last week)
- Profit (with arrow + margin %)
- Deals Closed
- Win Rate

**Section 2: Pipeline Snapshot**
- Bar chart: deals by stage with counts and values
- Pipeline total value
- Notes on stuck deals

**Section 3: Customer Health Alerts**
- List of top 5 at-risk customers with names, scores, primary risk factor
- One-line action recommendation each

**Section 4: Receivables & Follow-ups**
- Overdue invoice count + value
- Follow-ups due count
- Top 3 oldest overdue listed by client name

**Section 5: This Week's Highlights**
- Best margin deal (celebrate)
- Worst margin deal (learn)
- Biggest invoice

**Section 6: Action Items for Next Week**
- Supplier alerts
- Stuck deals needing attention
- Recommended priorities (generated based on rules)

**Buttons at top:**
- Print (calls `window.print()`)
- Refresh / Regenerate
- Email this brief (sends to a configured email address — use existing email send)

### Print styles

Add `@media print` rules in `index.css` to hide nav/sidebar and render Brief as letter-size page.

### App.tsx changes

Add "Weekly Brief" to nav, icon `FileText` from lucide-react.

### Acceptance criteria
- Brief generates with all sections populated
- All numbers accurate based on test data
- Print preview shows clean one-page layout
- Email button sends the brief to configured address
- `cargo check` and `npm run build` pass

---

## FEATURE 6: Deal Pipeline Analytics

### Business purpose

Find leaks in the sales process by measuring where deals stall and which die.

### DB changes — Migration (next version)

```sql
CREATE TABLE IF NOT EXISTS deal_stage_history (
    id TEXT PRIMARY KEY,
    deal_id TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (deal_id) REFERENCES deals(id)
);

CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history(deal_id);
```

`deal_stage_history` is **local-only** — do NOT add to `ALLOWED_TABLES`. Each device tracks its own observation order. The deal itself syncs; the stage history can be reconstructed.

Modify the `update_deal_stage` command from Feature 1 to insert a row in `deal_stage_history` on every stage change.

### Backend commands

```rust
pub struct PipelineAnalytics {
    pub funnel_counts: HashMap<String, u32>,  // count per stage
    pub funnel_values: HashMap<String, f64>,  // sum asking_price per stage
    pub avg_days_per_stage: HashMap<String, f64>,
    pub conversion_rates: HashMap<String, f64>,  // e.g. "quoted_to_negotiating": 0.65
    pub win_rate_overall: f64,
    pub win_rate_last_30d: f64,
    pub win_rate_last_90d: f64,
    pub avg_deal_size_won: f64,
    pub avg_deal_size_lost: f64,
    pub avg_cycle_time_days: f64,  // lead → won
    pub stuck_deals: Vec<StuckDeal>,
    pub top_lost_reasons: Vec<(String, u32)>,  // (reason, count)
}

async fn pipeline_analytics(timeframe_days: Option<u32>) -> Result<PipelineAnalytics, String>
```

Stuck deal: deal in same stage > 2x the average time for that stage.

### Frontend: `src/lib/api.ts`

Add PipelineAnalytics type and method.

### Frontend: new file `src/components/AnalyticsView.tsx`

**Top selector:** Timeframe — Last 30 / 90 / 365 days / All time

**Section 1: Funnel visualization**
- Horizontal bar chart, one bar per stage, width proportional to count
- Above each bar: count and total value
- Between bars: conversion rate %

**Section 2: Key metrics grid**
- Win rate (this period vs all-time)
- Avg cycle time (days from lead to won)
- Avg won deal size
- Avg lost deal size
- Stuck deal count

**Section 3: Stuck deals**
- Table listing each stuck deal with days in stage and stage average
- Click row to open deal detail

**Section 4: Lost analysis**
- Top reasons deals are lost (bar chart)
- Comparison: lost deals had avg X days in stage vs won deals avg Y days
- Insight cards: "Deals taking >N days in Negotiating have 80% loss rate"

**Section 5: Trends**
- Win rate over time (line chart, monthly)
- Avg cycle time over time
- Pipeline value over time

### Acceptance criteria
- Funnel renders with accurate counts
- Conversion rates calculated correctly between stages
- Stuck deals identified accurately
- Timeframe selector filters data correctly
- `cargo check` and `npm run build` pass

---

## Implementation Order

**Phase 1: Deals + Suppliers (Week 1-2)**
- FEATURE 3 first (Suppliers) — needed by Feature 1's cost item supplier references
- FEATURE 1 second (Deals) — depends on suppliers, becomes the pipeline foundation

**Phase 2: Shipping + Health (Week 2-3)**
- FEATURE 2 (Shipping) — independent, can be done parallel
- FEATURE 4 (Customer Health) — pure compute on existing data, fast win

**Phase 3: Brief + Analytics (Week 3-4)**
- FEATURE 5 (Weekly Brief) — pulls data from everything else
- FEATURE 6 (Pipeline Analytics) — depends on Feature 1 stage history

---

## Start instructions

Generate Phase 1 plan for **FEATURE 3 (Suppliers) only**. List every file you will change and every specific change. Wait for approval.

After FEATURE 3 is verified clean (`cargo check` + `npm run build` both pass), then plan FEATURE 1.

Do not start FEATURE 2, 4, 5, or 6 until both FEATURE 3 and FEATURE 1 are merged and verified. They build on top of supplier and deal data.

---

## Constraints summary (read before every feature)

- All synced table writes through `sync::record_upsert`
- No SQLite conn across `.await`
- Migrations append-only — never edit prior
- `tauri::async_runtime::spawn` not `tokio::spawn`
- `app.handle().clone()` for spawns, never `app` directly
- No new npm packages needed for any of these features
- No new Rust crates needed — use existing stack
- Read `PDF-API-CONTRACT.md` before any invoice.rs touch
- Tables added in this spec to `ALLOWED_TABLES`: `deals`, `shipments`, `suppliers`
- Tables NOT in `ALLOWED_TABLES`: `deal_stage_history`
