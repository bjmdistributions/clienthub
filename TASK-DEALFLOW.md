# TASK-DEALFLOW: Deal Flow Tracker, Profit Splits & Brief Updates

Four features built in strict dependency order. One step at a time — plan, approve, build, verify.

Read this entire file before planning anything. Do NOT start Step 2 until Step 1 passes `cargo check` AND `npm run build`. Same rule for every step.

---

## Architecture invariants (read before every step)

- All writes to synced tables go through `sync::record_upsert` THEN direct SQL mirror
- SQLite connections cannot cross `.await` boundaries — scope all DB work in inner `{ }` blocks
- Migrations are append-only — never edit prior migrations
- Use `tauri::async_runtime::spawn` not `tokio::spawn`
- Use `app.handle().clone()` for spawns — never `app` directly
- Read `PDF-API-CONTRACT.md` before touching `invoice.rs`
- Synced tables: `clients`, `interactions`, `invoices`, `settings`, `payment_methods`, `categories`, `deals`, `deal_flows` (new in Step 2)

---

## STEP 1 — Bug Fix: Comma in cost/profit number inputs

### Priority: CRITICAL — fix this before building anything else

### What's broken

On the Invoices page, when entering cost or profit values, typing a number with a comma (e.g. `1,500.00`) causes the save to fail silently. The comma is treated as an invalid character by `parseFloat()` which returns `NaN`, which then fails validation or saves as 0.

### Files to change

**`src/components/InvoicesView.tsx`**

Find every numeric input in the cost/profit section of the invoice detail panel. For each one:

1. Change the `onChange` handler to strip commas before parsing:
```typescript
// Replace any existing parseFloat(e.target.value) with:
const raw = e.target.value.replace(/,/g, '');
const val = parseFloat(raw);
if (!isNaN(val) || raw === '' || raw === '-') {
  setState(isNaN(val) ? 0 : val);
}
```

2. Change the `value` display to format with commas for readability:
```typescript
// When displaying a number value in an input, use:
value={amount === 0 ? '' : amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
```

3. Add `inputMode="decimal"` to all numeric inputs in this section.

Also check `src/components/DealsView.tsx` if it exists — apply the same fix to any cost/price/amount inputs there.

### Acceptance criteria
- Type `1,500.00` in any cost field → saves correctly as 1500.00
- Type `2,300` → saves as 2300.00
- Type `500` → saves as 500.00
- No silent failures or NaN saves
- `npm run build` passes

### Verification
Human runs `npm run build`. Must pass before Step 2.

---

## STEP 2 — Deal Flow Tracker (new view + DB)

### Business purpose

Receiving payment on an invoice does not close a deal. Money still needs to go out to the supplier. This feature maps the full deal lifecycle: Invoice Sent → Payment Received → Supplier Paid → Deal Complete — with exact amounts tracked at each stage and profit calculated at completion.

### 2A: Database migration

Append to `src-tauri/src/db.rs` (next available migration number):

```sql
CREATE TABLE IF NOT EXISTS deal_flows (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,

    -- Stage tracking
    stage TEXT NOT NULL DEFAULT 'invoiced',
    -- Stages: 'invoiced' | 'payment_received' | 'supplier_paid' | 'complete'

    -- Payment received info
    payment_received_at TEXT,
    payment_received_amount REAL,
    payment_received_method TEXT,
    payment_received_notes TEXT,

    -- Supplier payment info (can have multiple — stored as JSON array)
    supplier_payments_json TEXT DEFAULT '[]',
    -- Each entry: { id, supplier_name, amount, paid_at, method, notes, paid: bool }

    total_supplier_cost REAL DEFAULT 0,

    -- Completion
    completed_at TEXT,
    gross_revenue REAL DEFAULT 0,    -- what client paid
    total_cost REAL DEFAULT 0,       -- supplier costs + any other costs
    net_profit REAL DEFAULT 0,       -- gross_revenue - total_cost
    profit_jack REAL DEFAULT 0,      -- 30% of net_profit
    profit_ben REAL DEFAULT 0,       -- 30% of net_profit
    profit_business REAL DEFAULT 0,  -- 40% of net_profit

    -- Meta
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deal_flows_invoice ON deal_flows(invoice_id);
CREATE INDEX IF NOT EXISTS idx_deal_flows_stage ON deal_flows(stage);
CREATE INDEX IF NOT EXISTS idx_deal_flows_completed ON deal_flows(completed_at);
```

`deal_flows` is a **synced table** — add `"deal_flows"` to `ALLOWED_TABLES` in `src-tauri/src/sync.rs`.

Also add to `invoices` table (append to same migration):
```sql
ALTER TABLE invoices ADD COLUMN deal_flow_id TEXT;
ALTER TABLE invoices ADD COLUMN deal_flow_stage TEXT DEFAULT 'none';
```

`deal_flow_stage` values: `'none'` | `'invoiced'` | `'payment_received'` | `'supplier_paid'` | `'complete'`

### 2B: Backend commands

Add to `src-tauri/src/commands.rs`:

```rust
pub struct SupplierPayment {
    pub id: String,
    pub supplier_name: String,
    pub amount: f64,
    pub paid_at: Option<String>,
    pub method: Option<String>,
    pub notes: Option<String>,
    pub paid: bool,
}

pub struct DealFlow {
    pub id: String,
    pub invoice_id: String,
    pub stage: String,
    pub payment_received_at: Option<String>,
    pub payment_received_amount: Option<f64>,
    pub payment_received_method: Option<String>,
    pub payment_received_notes: Option<String>,
    pub supplier_payments: Vec<SupplierPayment>,  // parsed from JSON
    pub total_supplier_cost: f64,
    pub completed_at: Option<String>,
    pub gross_revenue: f64,
    pub total_cost: f64,
    pub net_profit: f64,
    pub profit_jack: f64,
    pub profit_ben: f64,
    pub profit_business: f64,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct DealFlowInput {
    pub invoice_id: String,
    pub notes: Option<String>,
}

pub struct PaymentReceivedInput {
    pub amount: f64,
    pub method: Option<String>,
    pub notes: Option<String>,
    pub received_at: Option<String>,  // defaults to now if None
}

pub struct SupplierPaymentInput {
    pub supplier_name: String,
    pub amount: f64,
    pub method: Option<String>,
    pub notes: Option<String>,
}
```

Commands to add:

```rust
// Create a new deal flow for an invoice (stage = 'invoiced')
// Also updates invoices.deal_flow_stage = 'invoiced'
pub async fn create_deal_flow(input: DealFlowInput) -> Result<String, String>

// Get deal flow by invoice_id (returns None if not started)
pub async fn get_deal_flow_by_invoice(invoice_id: String) -> Result<Option<DealFlow>, String>

// Get deal flow by deal_flow id
pub async fn get_deal_flow(id: String) -> Result<DealFlow, String>

// List all deal flows
pub async fn list_deal_flows() -> Result<Vec<DealFlow>, String>

// List deal flows by stage
pub async fn list_deal_flows_by_stage(stage: String) -> Result<Vec<DealFlow>, String>

// Mark payment received — advances stage to 'payment_received'
// Updates invoice.deal_flow_stage too
pub async fn mark_payment_received(
    deal_flow_id: String,
    input: PaymentReceivedInput,
) -> Result<(), String>

// Unmark payment received — reverts stage to 'invoiced'
pub async fn unmark_payment_received(deal_flow_id: String) -> Result<(), String>

// Add a supplier payment entry (does not mark as paid yet)
pub async fn add_supplier_payment(
    deal_flow_id: String,
    input: SupplierPaymentInput,
) -> Result<String, String>  // returns supplier payment id

// Update a supplier payment entry
pub async fn update_supplier_payment(
    deal_flow_id: String,
    supplier_payment_id: String,
    input: SupplierPaymentInput,
) -> Result<(), String>

// Remove a supplier payment entry
pub async fn remove_supplier_payment(
    deal_flow_id: String,
    supplier_payment_id: String,
) -> Result<(), String>

// Mark a specific supplier payment as paid
// When ALL supplier payments are marked paid, advances stage to 'supplier_paid'
pub async fn mark_supplier_payment_paid(
    deal_flow_id: String,
    supplier_payment_id: String,
    paid_at: Option<String>,
) -> Result<(), String>

// Unmark a supplier payment as paid (reverts stage if needed)
pub async fn unmark_supplier_payment_paid(
    deal_flow_id: String,
    supplier_payment_id: String,
) -> Result<(), String>

// Mark deal as complete — advances to 'complete', calculates all profit fields
// gross_revenue = invoice.total
// total_cost = sum of all supplier payment amounts
// net_profit = gross_revenue - total_cost
// profit_jack = net_profit * 0.30
// profit_ben = net_profit * 0.30
// profit_business = net_profit * 0.40
pub async fn complete_deal_flow(deal_flow_id: String) -> Result<(), String>

// Unmark complete — reverts to 'supplier_paid'
pub async fn uncomplete_deal_flow(deal_flow_id: String) -> Result<(), String>

// Update notes on deal flow
pub async fn update_deal_flow_notes(
    deal_flow_id: String,
    notes: String,
) -> Result<(), String>

// Delete a deal flow entirely (and reset invoice.deal_flow_stage to 'none')
pub async fn delete_deal_flow(deal_flow_id: String) -> Result<(), String>
```

All write commands must:
1. Call `sync::record_upsert("deal_flows", &deal_flow_id, cols)` with changed fields
2. Run direct SQL as local apply
3. Also update `invoices` table `deal_flow_stage` column via `sync::record_upsert("invoices", ...)`

Register all commands in `src-tauri/src/main.rs`.

### 2C: API types

Add to `src/lib/api.ts`:

```typescript
export interface SupplierPayment {
  id: string;
  supplier_name: string;
  amount: number;
  paid_at?: string;
  method?: string;
  notes?: string;
  paid: boolean;
}

export interface DealFlow {
  id: string;
  invoice_id: string;
  stage: 'invoiced' | 'payment_received' | 'supplier_paid' | 'complete';
  payment_received_at?: string;
  payment_received_amount?: number;
  payment_received_method?: string;
  payment_received_notes?: string;
  supplier_payments: SupplierPayment[];
  total_supplier_cost: number;
  completed_at?: string;
  gross_revenue: number;
  total_cost: number;
  net_profit: number;
  profit_jack: number;
  profit_ben: number;
  profit_business: number;
  notes?: string;
  created_at: string;
  updated_at: string;
}
```

Add all API methods matching the commands above.

Update `Invoice` type to include:
```typescript
deal_flow_id?: string;
deal_flow_stage?: 'none' | 'invoiced' | 'payment_received' | 'supplier_paid' | 'complete';
```

### 2D: Deal Flow View — new file `src/components/DealFlowView.tsx`

#### Layout: Full-page pipeline tracker

**Top section — Pipeline summary bar:**
Four counts with colored badges:
- Invoiced (gray): N deals awaiting payment
- Payment Received (blue): N deals awaiting supplier payment
- Supplier Paid (amber): N deals ready to complete
- Complete (green): N deals done this month

**Main section — Deal flow list:**

Each deal flow renders as a **flow card** — a horizontal strip showing:

```
┌────────────────────────────────────────────────────────────────────┐
│ Invoice #INV-0042 · Acme Corp · $5,200.00          [↗ Open Invoice]│
├──────────┬──────────────┬──────────────┬──────────────┤
│ ● Sent   │ ○ Received   │ ○ Supplier   │ ○ Complete   │
│ Jan 15   │              │   Paid       │              │
├──────────┴──────────────┴──────────────┴──────────────┤
│ [Expand for details ▼]                                             │
└────────────────────────────────────────────────────────────────────┘
```

Stage circles:
- Filled solid circle = completed stage
- Hollow circle = not yet reached
- Pulsing/animated circle = current active stage
- Line connecting circles fills in as stages complete (left to right)

Colors:
- Invoiced: gray
- Payment Received: blue (`bg-blue-500`)
- Supplier Paid: amber (`bg-amber-500`)
- Complete: green (`bg-emerald-500`)

**Expanded deal flow card** (click to expand):

**Stage 1 — Invoice Sent (always complete once flow exists):**
- Shows: Invoice number, client, amount, sent date
- Cannot be unmarked (the flow starting point)

**Stage 2 — Payment Received:**
- If not done: "Mark Payment Received" button → opens inline form:
  - Amount received (number input — MUST use comma-safe parsing from Step 1)
  - Payment method (dropdown: Check, Wire, ACH, Cash, Other)
  - Date received (date picker, default today)
  - Notes (optional text)
  - "Confirm Payment Received" button
- If done: shows amount, method, date, notes. "Edit" button to change. "Undo" button to revert.

**Stage 3 — Supplier Payments:**
- Header: "Money Going Out" with total
- List of supplier payment entries. Each entry:
  - Supplier name (text input)
  - Amount (number input — comma-safe)
  - Method (dropdown)
  - Notes (optional)
  - Checkbox: "✓ Paid" — when checked, marks that payment as paid with timestamp
  - Delete button (×)
- "+ Add Supplier Payment" button adds a new empty entry
- When ALL entries are checked paid → stage advances to 'supplier_paid'
- Any entry can be unchecked to revert

**Stage 4 — Complete:**
- Only shown/enabled when stage = 'supplier_paid'
- "Mark Deal Complete" button → calculates and shows preview:
  ```
  Revenue:          $5,200.00
  Supplier Costs:  -$3,800.00
  ─────────────────────────────
  Net Profit:       $1,400.00

  Split (40/30/30):
  Business (40%):    $560.00
  Jack (30%):        $420.00
  Ben (30%):         $420.00
  ```
- "Confirm Complete" and "Cancel" buttons
- If done: shows the profit breakdown permanently. "Undo Complete" button to revert to supplier_paid.

**Notes field** at bottom of expanded card — free text, saves on blur.

**Filter bar above the list:**
- Filter by stage (All / Invoiced / Payment Received / Supplier Paid / Complete)
- Search by invoice number or client name
- Date range filter (by invoice date)

**"Start Deal Flow" button** at top right:
- Opens a modal to select an invoice (that doesn't have a deal flow yet)
- Searchable invoice list showing number, client, amount, date
- Creates the deal flow in 'invoiced' stage

### 2E: Invoice list updates (on existing `InvoicesView.tsx`)

On each invoice row, add a deal flow status indicator:

**If no deal flow:** Show a subtle "+" button or "Track Deal" text link. Clicking it creates a deal flow and opens the deal flow view.

**If deal flow exists:** Show a progress indicator — 4 small circles in a row, filled based on stage:

```
● ● ○ ○  Payment Received
● ● ● ○  Supplier Paid
● ● ● ●  Complete
```

Also add a colored status tag next to the existing invoice status badge:
- No flow: nothing
- Invoiced: gray "Awaiting Payment"
- Payment Received: blue "Payment In"
- Supplier Paid: amber "Pending Completion"
- Complete: green "Deal Complete"

Clicking the circles or the tag opens the Deal Flow view filtered to that invoice.

### 2F: App navigation

Add "Deal Flow" to the sidebar nav between Invoices and Deals (if Deals exists), or after Invoices. Icon: `GitBranch` or `ArrowRightLeft` from lucide-react.

### Acceptance criteria
- Creating a deal flow from an invoice works
- All 4 stages advance correctly with correct data
- Any stage can be unmarked/reverted
- Supplier payments can be added, edited, removed, marked paid individually
- All stages update on invoice row in InvoicesView
- Profit split calculates correctly (test: $1,400 profit → Jack $420, Ben $420, Business $560)
- All amount inputs use comma-safe parsing from Step 1
- `cargo check` and `npm run build` pass

---

## STEP 3 — Weekly Brief: Profit Summary + 40/30/30 Split

### Business purpose

The Weekly Brief currently shows revenue. Update it to show REAL profit — only from deals that are marked complete. Show the 40/30/30 split so Jack and Ben know exactly what they made this week.

### 3A: Backend changes

Update `generate_weekly_brief` command in `src-tauri/src/commands.rs`:

Add to `WeeklyBrief` struct:
```rust
// Profit — only from deal_flows where stage='complete' AND completed_at in range
pub completed_deals_this_week: u32,
pub completed_deals_last_week: u32,
pub net_profit_this_week: f64,
pub net_profit_last_week: f64,
pub profit_change_pct: f64,

// Splits this week
pub profit_jack_this_week: f64,      // sum of profit_jack from completed deals this week
pub profit_ben_this_week: f64,       // sum of profit_ben from completed deals this week
pub profit_business_this_week: f64,  // sum of profit_business from completed deals this week

// Splits all time (for context)
pub profit_jack_all_time: f64,
pub profit_ben_all_time: f64,
pub profit_business_all_time: f64,

// Running totals (current month)
pub net_profit_this_month: f64,
pub profit_jack_this_month: f64,
pub profit_ben_this_month: f64,
pub profit_business_this_month: f64,
```

Query logic:
```sql
-- This week's completed deals
SELECT
    COUNT(*) as count,
    COALESCE(SUM(net_profit), 0) as total_profit,
    COALESCE(SUM(profit_jack), 0) as jack,
    COALESCE(SUM(profit_ben), 0) as ben,
    COALESCE(SUM(profit_business), 0) as business
FROM deal_flows
WHERE stage = 'complete'
AND completed_at >= ?1  -- week start (Sunday 00:00:00)
AND completed_at < ?2   -- week end (Saturday 23:59:59)
```

Important: profit stats only come from `deal_flows.stage = 'complete'`. Partially completed deals are NOT counted. Revenue from invoices without deal flows is NOT counted in profit — only in revenue.

### 3B: Frontend changes

**`src/components/BriefView.tsx`** — add new section after existing revenue section:

**"This Week's Profit" section:**

```
┌─────────────────────────────────────────────────────────┐
│  PROFIT THIS WEEK                                        │
│                                                          │
│  Completed Deals: 3                                      │
│  Net Profit:  $4,200.00  ▲ +12% vs last week           │
│                                                          │
│  ┌──────────────┬──────────────┬──────────────┐         │
│  │  Business    │   Jack       │   Ben        │         │
│  │    40%       │    30%       │    30%       │         │
│  │  $1,680.00   │  $1,260.00   │  $1,260.00   │         │
│  └──────────────┴──────────────┴──────────────┘         │
│                                                          │
│  This Month: $14,300.00 profit                          │
│  Jack (MTD): $4,290.00 · Ben (MTD): $4,290.00          │
└─────────────────────────────────────────────────────────┘
```

Color the profit number green. If negative (loss), red.

The three split boxes should be clearly labeled and visually distinct — use card styling with subtle colored top borders (business = indigo, Jack = emerald, Ben = blue).

Add a note at the bottom of the section:
> "Profit calculated from completed deals only (deal flow marked complete). Deals still in progress are not included."

**`src/lib/api.ts`** — update `WeeklyBrief` type with all new profit fields.

### Acceptance criteria
- Brief shows completed deals count this week
- Net profit matches sum of `deal_flows.net_profit` for completed deals this week
- 40/30/30 split shows correct dollar amounts
- Month-to-date totals update as more deals complete
- Zero profit shows as $0.00 not blank
- `cargo check` and `npm run build` pass

---

## STEP 4 — Deal Flow: Editable profit split percentages (optional polish)

### Business purpose

Right now the 40/30/30 split is hardcoded. Make it configurable in Settings so it can be adjusted without code changes.

### 4A: DB changes

```sql
-- Append to migrations
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('profit_split_business', '40'),
    ('profit_split_jack', '30'),
    ('profit_split_ben', '30');
```

No new table — use existing `settings` table. These are local-only settings (not synced — the split is a business decision made on one device).

Actually: make this synced so all devices show the same split. Include in sync event when saved.

### 4B: Backend changes

Add command `get_profit_split() -> Result<ProfitSplit, String>`:
```rust
pub struct ProfitSplit {
    pub business_pct: f64,  // e.g. 40.0
    pub jack_pct: f64,      // e.g. 30.0
    pub ben_pct: f64,       // e.g. 30.0
}
```

Add command `save_profit_split(business_pct: f64, jack_pct: f64, ben_pct: f64) -> Result<(), String>`:
- Validate: must sum to 100.0 (allow ±0.01 for float rounding)
- Save each as a settings key via `sync::record_upsert`

Update `complete_deal_flow` to read split from settings instead of hardcoded values.

### 4C: Frontend changes

**`src/components/SettingsView.tsx`** — add "Profit Split" section in a logical tab (Business or General):

```
Profit Split (must total 100%)

Business:  [40]%
Jack:      [30]%
Ben:       [30]%
           Total: 100% ✓

[Save Profit Split]
```

Live validation: show total as you type. If not 100, show red warning and disable save.

**`src/components/BriefView.tsx`** — load split from `api.getProfitSplit()` instead of hardcoding 40/30/30 in labels.

### Acceptance criteria
- Changing split to 50/25/25 → new completed deals calculate with new percentages
- Old completed deals keep their original split (already stored in deal_flows table)
- Validation prevents saving if total ≠ 100%
- Brief shows the correct partner names and current split percentages
- `cargo check` and `npm run build` pass

---

## Build sequence

```
STEP 1: Bug fix (comma inputs)         → npm run build → verify → continue
STEP 2: Deal Flow Tracker              → cargo check + npm run build → verify → continue
STEP 3: Brief profit summary           → cargo check + npm run build → verify → continue
STEP 4: Editable profit split          → cargo check + npm run build → verify → ship
```

Each step is independent enough to ship if needed. Step 3 depends on Step 2 data existing. Step 4 depends on Step 2 and 3.

After all 4 steps pass, bump to v0.7.0 and ship.

---

## Start instructions

Generate Phase 1 plan for **STEP 1 only** (comma input bug fix). List every specific change — file name, what you're changing, and the exact fix. This is a small focused fix. Wait for approval before executing.

After STEP 1 is verified (`npm run build` passes), come back and plan STEP 2.
