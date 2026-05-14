# TASK-DEALFLOW: Deal Flow Tracker, Profit Splits & Brief Updates

Steps 1 and 2 are COMPLETE. Do not re-implement them.

- STEP 1 (comma input bug fix) — DONE
- STEP 2 (deal flow tracker, 16 commands, DealFlowView.tsx) — DONE

Remaining: STEP 3, STEP 4, STEP 5 (new), STEP 6 (new).

Read this entire file before planning anything. One step at a time — plan, approve, build, verify with `cargo check` AND `npm run build` before moving on.

---

## Architecture invariants (apply to every step)

- All writes to synced tables go through `sync::record_upsert` THEN direct SQL mirror
- SQLite connections cannot cross `.await` boundaries — scope all DB work in inner `{ }` blocks
- Migrations are append-only — never edit prior migrations
- Use `tauri::async_runtime::spawn` not `tokio::spawn`
- Use `app.handle().clone()` for spawns — never `app` directly
- Read `PDF-API-CONTRACT.md` before touching `invoice.rs`
- Synced tables: `clients`, `interactions`, `invoices`, `settings`, `payment_methods`, `categories`, `deal_flows`, `suppliers` (new Step 5)

---

## STEP 3 — Weekly Brief: Profit Summary + 40/30/30 Split

### Business purpose

The Weekly Brief currently shows revenue. Update it to show real profit — only from deal flows marked complete. Show the 40/30/30 split so Jack and Ben know exactly what they personally made this week.

### 3A: Backend changes

Update `generate_weekly_brief` command in `src-tauri/src/commands.rs`.

Add to `WeeklyBrief` struct:
```rust
pub completed_deals_this_week: u32,
pub completed_deals_last_week: u32,
pub net_profit_this_week: f64,
pub net_profit_last_week: f64,
pub profit_change_pct: f64,
pub profit_jack_this_week: f64,
pub profit_ben_this_week: f64,
pub profit_business_this_week: f64,
pub profit_jack_all_time: f64,
pub profit_ben_all_time: f64,
pub profit_business_all_time: f64,
pub net_profit_this_month: f64,
pub profit_jack_this_month: f64,
pub profit_ben_this_month: f64,
pub profit_business_this_month: f64,
pub loss_deals_this_week: u32,      // deals where net_profit < 0
pub loss_total_this_week: f64,      // sum of losses (negative)
```

Query — profit only from `deal_flows` where `stage = 'complete'`:
```sql
SELECT
    COUNT(*) as count,
    COALESCE(SUM(net_profit), 0) as total_profit,
    COALESCE(SUM(profit_jack), 0) as jack,
    COALESCE(SUM(profit_ben), 0) as ben,
    COALESCE(SUM(profit_business), 0) as business,
    COUNT(CASE WHEN net_profit < 0 THEN 1 END) as loss_count,
    COALESCE(SUM(CASE WHEN net_profit < 0 THEN net_profit ELSE 0 END), 0) as loss_total
FROM deal_flows
WHERE stage = 'complete'
AND completed_at >= ?1
AND completed_at < ?2
```

Profit stats ONLY from completed deal flows. Revenue from invoices without deal flows is separate (revenue ≠ profit).

### 3B: Frontend changes

**`src/components/BriefView.tsx`** — add "Profit This Week" section after revenue:

```
┌──────────────────────────────────────────────────────────┐
│  PROFIT THIS WEEK                    3 deals completed   │
│                                                          │
│  Net Profit:  $4,200.00  ▲ +12% vs last week           │
│                                                          │
│  ┌────────────────┬──────────────┬──────────────┐       │
│  │  Business 40%  │  Jack 30%    │  Ben 30%     │       │
│  │  $1,680.00     │  $1,260.00   │  $1,260.00   │       │
│  └────────────────┴──────────────┴──────────────┘       │
│                                                          │
│  This Month: $14,300 profit                             │
│  Jack MTD: $4,290  ·  Ben MTD: $4,290                  │
│                                                          │
│  ⚠ 1 deal lost money this week: -$340.00               │
└──────────────────────────────────────────────────────────┘
```

- Profit number: green if positive, red if negative
- Loss warning row: only shown if `loss_deals_this_week > 0`, amber background, links to the deal flow
- Three split boxes: colored top border (business = indigo, Jack = emerald, Ben = blue)
- Footer note: "Profit calculated from completed deal flows only"

Update `src/lib/api.ts` WeeklyBrief type with all new fields.

### Acceptance criteria
- Brief shows completed deals count and net profit this week
- 40/30/30 split shows correct dollar amounts
- Loss warning appears when any completed deal has negative profit
- Month-to-date totals update as more deals complete
- `cargo check` and `npm run build` pass

---

## STEP 4 — Editable Profit Split Percentages

### Business purpose

The 40/30/30 split is currently hardcoded. Make it configurable in Settings.

### 4A: Backend changes

Add to migrations:
```sql
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('profit_split_business', '40'),
    ('profit_split_jack', '30'),
    ('profit_split_ben', '30');
```

Add commands:
```rust
pub struct ProfitSplit {
    pub business_pct: f64,
    pub jack_pct: f64,
    pub ben_pct: f64,
    pub jack_name: String,   // configurable name, default "Jack"
    pub ben_name: String,    // configurable name, default "Ben"
}

async fn get_profit_split() -> Result<ProfitSplit, String>

async fn save_profit_split(
    business_pct: f64,
    jack_pct: f64,
    ben_pct: f64,
    jack_name: String,
    ben_name: String,
) -> Result<(), String>
// Validate: must sum to 100.0 (±0.01 tolerance)
// Save via sync::record_upsert for each settings key
```

Update `complete_deal_flow` to read split from settings instead of hardcoded values.

### 4B: Frontend changes

**`src/components/SettingsView.tsx`** — add "Profit Split" section:

```
Profit Split (must total 100%)

Partner 1 name: [Jack        ]   Share: [30]%
Partner 2 name: [Ben         ]   Share: [30]%
Business:                        Share: [40]%
                          Total: 100% ✓

[Save Profit Split]
```

Live validation: show total, red warning + disabled save if ≠ 100%.

**`src/components/BriefView.tsx`** — load split from `api.getProfitSplit()` instead of hardcoding labels.

**`src/components/DealFlowView.tsx`** — load split from `api.getProfitSplit()` for the completion preview.

Register commands in `main.rs`. Add to `api.ts`.

### Acceptance criteria
- Changing split to 50/25/25 → new completed deals calculate with new percentages
- Old completed deals keep their stored split (already in deal_flows columns)
- Validation prevents saving if total ≠ 100%
- Partner names update everywhere they appear
- `cargo check` and `npm run build` pass

---

## STEP 5 — Supplier Contacts + Node Deal Map

### Business purpose

Suppliers are a real part of every deal — you pay them after the client pays you. Currently supplier info is just free text. This step makes suppliers first-class contacts with payment info, pricing history, and a visual node diagram showing exactly how money flows through each deal.

### 5A: Database changes

Append to migrations:

```sql
CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    payment_method TEXT,      -- "Wire", "Check", "ACH", "Zelle", "PayPal", "Other"
    payment_details TEXT,     -- account numbers, routing, PayPal email, etc. (encrypted via keychain)
    payment_terms TEXT,       -- "Net 30", "Due on receipt", etc.
    typical_lead_time TEXT,   -- "3-5 business days", etc.
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER DEFAULT 0,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

-- Pricing history per supplier (tracks price changes over time)
CREATE TABLE IF NOT EXISTS supplier_price_history (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL,
    item_description TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER,
    recorded_at TEXT NOT NULL,
    deal_flow_id TEXT,         -- links to the deal this price was observed in
    notes TEXT,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE INDEX IF NOT EXISTS idx_price_history_supplier ON supplier_price_history(supplier_id);
CREATE INDEX IF NOT EXISTS idx_price_history_date ON supplier_price_history(recorded_at);
```

`suppliers` is a **synced table** — add to `ALLOWED_TABLES` in `sync.rs`.
`supplier_price_history` is **local-only** — do NOT add to `ALLOWED_TABLES`.

Also update `deal_flows` supplier payments to optionally reference a supplier_id:

```sql
-- Append to migration
-- supplier_payments_json entries now support optional supplier_id field:
-- { id, supplier_name, supplier_id, amount, original_amount, paid_at, method, notes, paid, price_changed, quantity, unit_price }
```

The `supplier_payments_json` structure expands to:
```typescript
interface SupplierPayment {
  id: string;
  supplier_name: string;
  supplier_id?: string;        // links to suppliers table if known
  amount: number;              // current/final amount
  original_amount?: number;    // original quoted amount (set when created)
  price_changed?: boolean;     // true if amount ≠ original_amount
  quantity?: number;           // units
  unit_price?: number;         // per-unit price
  paid_at?: string;
  method?: string;
  notes?: string;
  paid: boolean;
}
```

### 5B: Backend commands

```rust
pub struct Supplier {
    pub id: String,
    pub name: String,
    pub contact_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub payment_method: Option<String>,
    pub payment_details: Option<String>,
    pub payment_terms: Option<String>,
    pub typical_lead_time: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    // Computed stats (joined from deal_flows)
    pub total_paid: f64,
    pub deal_count: u32,
    pub last_deal_date: Option<String>,
    pub avg_deal_amount: f64,
}

pub struct SupplierInput {
    pub name: String,
    pub contact_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub payment_method: Option<String>,
    pub payment_details: Option<String>,
    pub payment_terms: Option<String>,
    pub typical_lead_time: Option<String>,
    pub notes: Option<String>,
}

pub struct PriceAlert {
    pub supplier_id: String,
    pub supplier_name: String,
    pub item_description: String,
    pub previous_price: f64,
    pub current_price: f64,
    pub change_pct: f64,
    pub deal_flow_id: String,
}

async fn list_suppliers() -> Result<Vec<Supplier>, String>
async fn get_supplier(id: String) -> Result<Supplier, String>
async fn create_supplier(input: SupplierInput) -> Result<String, String>
async fn update_supplier(id: String, input: SupplierInput) -> Result<(), String>
async fn archive_supplier(id: String) -> Result<(), String>
async fn delete_supplier(id: String) -> Result<(), String>
async fn search_suppliers(query: String) -> Result<Vec<Supplier>, String>

// Price history
async fn get_supplier_price_history(supplier_id: String) -> Result<Vec<SupplierPriceEntry>, String>
async fn record_supplier_price(
    supplier_id: String,
    item_description: String,
    price: f64,
    quantity: Option<i32>,
    deal_flow_id: Option<String>,
    notes: Option<String>,
) -> Result<(), String>

// Price change detection
// Compares current unit_price on a supplier payment to the last recorded price
// for that supplier+item combo. Returns alert if >5% change.
async fn check_price_changes(deal_flow_id: String) -> Result<Vec<PriceAlert>, String>

// Node map data — returns deal flow with full supplier details resolved
async fn get_deal_flow_node_map(deal_flow_id: String) -> Result<DealFlowNodeMap, String>

pub struct DealFlowNodeMap {
    pub deal_flow_id: String,
    pub invoice_number: String,
    pub client_name: String,
    pub client_email: Option<String>,
    pub invoice_total: f64,
    pub stage: String,
    pub payment_received: Option<f64>,
    pub supplier_nodes: Vec<SupplierNode>,
    pub net_profit: f64,
    pub profit_jack: f64,
    pub profit_ben: f64,
    pub profit_business: f64,
    pub is_loss: bool,
    pub price_alerts: Vec<PriceAlert>,
}

pub struct SupplierNode {
    pub supplier_payment_id: String,
    pub supplier_id: Option<String>,
    pub supplier_name: String,
    pub amount: f64,
    pub original_amount: Option<f64>,
    pub price_changed: bool,
    pub quantity: Option<f64>,
    pub unit_price: Option<f64>,
    pub paid: bool,
    pub paid_at: Option<String>,
    pub method: Option<String>,
    pub notes: Option<String>,
    // Supplier contact details if linked
    pub supplier_contact: Option<String>,
    pub supplier_email: Option<String>,
    pub supplier_phone: Option<String>,
    pub payment_method: Option<String>,
    pub payment_details: Option<String>,
}
```

Register all in `main.rs`.

### 5C: API types

Add to `src/lib/api.ts`:

```typescript
export interface Supplier {
  id: string;
  name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  payment_method?: string;
  payment_details?: string;
  payment_terms?: string;
  typical_lead_time?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
  total_paid: number;
  deal_count: number;
  last_deal_date?: string;
  avg_deal_amount: number;
}

export interface PriceAlert {
  supplier_id: string;
  supplier_name: string;
  item_description: string;
  previous_price: number;
  current_price: number;
  change_pct: number;
  deal_flow_id: string;
}

export interface SupplierNode {
  supplier_payment_id: string;
  supplier_id?: string;
  supplier_name: string;
  amount: number;
  original_amount?: number;
  price_changed: boolean;
  quantity?: number;
  unit_price?: number;
  paid: boolean;
  paid_at?: string;
  method?: string;
  notes?: string;
  supplier_contact?: string;
  supplier_email?: string;
  supplier_phone?: string;
  payment_method?: string;
  payment_details?: string;
}

export interface DealFlowNodeMap {
  deal_flow_id: string;
  invoice_number: string;
  client_name: string;
  client_email?: string;
  invoice_total: number;
  stage: string;
  payment_received?: number;
  supplier_nodes: SupplierNode[];
  net_profit: number;
  profit_jack: number;
  profit_ben: number;
  profit_business: number;
  is_loss: boolean;
  price_alerts: PriceAlert[];
}
```

Add all API methods.

### 5D: Supplier View — new file `src/components/SuppliersView.tsx`

**Layout: two panels**

**Left — Supplier list (320px):**
- Search bar
- Filter: All / Active / Archived
- Sort: Name / Total Paid / Last Deal
- Each supplier card shows:
  - Name (bold)
  - Contact name + phone
  - Payment method badge (Wire / ACH / Check / etc.)
  - Total paid to them: `$X,XXX`
  - Deal count: "N deals"
- Click card → opens detail panel
- "+ New Supplier" button at top

**Right — Supplier detail panel:**

**Contact section:**
- Name, contact name, email, phone, address (all editable)
- Payment method dropdown
- Payment details textarea (routing number, account, PayPal email — user enters this manually)
- Payment terms, typical lead time
- Notes

**Stats section (read-only, computed):**
- Total paid to date
- Number of deals used in
- Average per deal
- Last deal date

**Price history section:**
- Table: Date | Item | Qty | Unit Price | Deal
- Shows price trend — if price went up, amber arrow ▲, if down, green arrow ▼
- "Log price" button to manually record a price observation

**Recent deals section:**
- Last 5 deal flows this supplier appeared in
- Each row: Invoice # | Client | Amount paid to supplier | Date | Status

**Archive / Delete buttons** at bottom.

Add "Suppliers" to App.tsx sidebar. Icon: `Package` from lucide-react.

### 5E: Node Deal Map — integrated into DealFlowView.tsx

In the existing `DealFlowView.tsx`, add a **"Node Map" toggle button** at the top of each expanded deal flow card. Clicking switches the card between "List View" (existing) and "Node Map View."

**Node Map View — visual money flow diagram:**

Rendered using SVG or plain HTML with absolutely positioned elements and CSS lines. No external library needed.

Layout (horizontal flow, left to right):

```
┌──────────────┐         ┌─────────────────────┐         ┌──────────────────┐
│   CLIENT     │ ──────► │   YOUR BUSINESS     │ ──────► │  SUPPLIER A      │
│  Acme Corp   │ $5,200  │                     │ $2,100  │  Pacific Imports  │
│              │  ● PAID │  Revenue: $5,200    │  ○ UNPD │  ACH · Net 30    │
└──────────────┘         │  Costs:  -$3,800    │         └──────────────────┘
                         │  ─────────────────  │ ──────► ┌──────────────────┐
                         │  Profit:  $1,400 ✓  │ $1,700  │  SUPPLIER B      │
                         │                     │  ● PAID │  Global Trade Co  │
                         │  Jack:    $420       │         │  Wire · Due now  │
                         │  Ben:     $420       │         └──────────────────┘
                         │  Business: $560      │
                         └─────────────────────┘
```

**Visual rules:**

- Client box: blue border, shows client name + invoice total + payment status dot
- Business box: indigo border, center of the diagram, shows all financial summary
- Supplier boxes: one per supplier payment, stacked vertically on the right
- Connecting lines: CSS borders or SVG lines between boxes
  - Client → Business line: blue when payment received, gray when pending
  - Business → Supplier line: green when supplier paid, amber when unpaid
- Profit display in business box:
  - Green text if profit > 0
  - Red text + ⚠ icon if profit < 0 (loss)
  - Shows loss amount prominently: "LOSS: -$340"
- Price change indicators on supplier boxes:
  - If `price_changed = true`: amber ⚠ badge showing original vs current: "$1,800 → $2,100"
- Each supplier box shows:
  - Supplier name
  - Amount (current)
  - If price changed: original amount struck through, new amount in amber
  - Payment method
  - Paid/unpaid status dot
  - If supplier is linked to suppliers table: small "📋" icon that opens supplier contact card on hover

**Loss flagging:**

If `net_profit < 0` anywhere in the deal:
- Business center box shows red background tint
- "⚠ LOSS DEAL" banner across the top of the node map
- Profit row shows in bold red
- The deal flow card header in the list shows a red badge "Loss"
- Dashboard widget counts loss deals separately

**Price change flagging:**

When a supplier payment amount differs from `original_amount`:
- Amber ⚠ badge on the supplier node: "Price changed"
- Tooltip/hover: "Originally $X, now $Y (+Z%)"
- In list view (existing deal flow card): amber warning row under the supplier payment
- `check_price_changes` command auto-runs when a supplier payment amount is edited

**Quantity change flagging:**

If quantity changes after initial entry:
- Similar amber warning on supplier node: "Qty changed: 100 → 85 units"
- Recalculates unit price automatically: new amount / new quantity

### 5F: Supplier selector in deal flow

Update the supplier payment entry form in `DealFlowView.tsx`:

When adding a supplier payment, show a supplier search input:
- Type to search existing suppliers (calls `api.searchSuppliers(q)`)
- If found: clicking selects the supplier, auto-fills name, pre-fills payment method from supplier record
- Shows supplier's payment details inline (so you know where to send money)
- If not found: "Create new supplier" option → opens quick-create form inline (name, payment method, payment details only — full edit later)

When a supplier is selected:
- Store `supplier_id` in the payment entry
- Show a small card below the amount input with the supplier's payment info:
  ```
  Payment: ACH Transfer
  Routing: ****1234
  Account: ****5678
  ```
- This is the "how do I pay them" reference while processing the deal

### 5G: Loss detection and alerts

In `complete_deal_flow` backend command — after calculating profit:

If `net_profit < 0`:
1. Set a `is_loss` flag (store in `deal_flows.metadata` JSON as `{"is_loss": true}`)
2. Return a warning in the result: `{ profit: -340.0, is_loss: true, warning: "This deal resulted in a loss of $340.00" }`

In `DealFlowView.tsx` — when user clicks "Confirm Complete":
- If the result has `is_loss: true`, show a prominent warning dialog before finalizing:
  ```
  ⚠ Warning: This deal lost money

  Revenue:    $5,200.00
  Costs:     -$5,540.00
  Loss:        -$340.00

  Are you sure you want to mark this complete?
  [Cancel]  [Mark Complete Anyway]
  ```

In `DashboardView.tsx` — add loss tracking widget:
- "Loss Deals This Month": count + total amount lost
- Red colored card, only shown if count > 0

### Acceptance criteria
- Supplier CRUD works — create, edit, archive, delete
- Supplier search works in deal flow payment entry
- Selecting a supplier auto-fills payment details
- Node map renders for every deal flow
- Client → Business → Supplier flow shows correct amounts and colors
- Lines turn green/blue when stages are paid
- Loss deals show red in node map and "LOSS DEAL" banner
- Price change flag appears when amount differs from original
- Quantity change recalculates unit price
- Loss confirmation dialog appears before completing a loss deal
- `cargo check` and `npm run build` pass

---

## STEP 6 — Price & Quantity Change Handling

### Business purpose

Supplier prices and quantities change unexpectedly. The system needs to track these changes, show the delta, and recalculate profit automatically so nothing slips through.

### 6A: Backend changes

Update `update_supplier_payment` command to:
1. When amount changes: if `original_amount` is null, set it to the previous amount first, then update amount and set `price_changed = true`
2. When quantity changes: recalculate `amount = quantity * unit_price`, set `price_changed = true`
3. Call `record_supplier_price` automatically when a linked supplier_id exists
4. Recalculate deal flow totals: `total_supplier_cost`, and if stage is complete, recalculate `net_profit`, `profit_jack`, `profit_ben`, `profit_business`
5. Re-run loss detection: if recalculated profit goes negative, update `is_loss` flag

Add command:
```rust
async fn revert_supplier_price_change(
    deal_flow_id: String,
    supplier_payment_id: String,
) -> Result<(), String>
// Sets amount back to original_amount, clears price_changed flag
// Recalculates totals
```

### 6B: Frontend changes

In `DealFlowView.tsx` supplier payment entry:

Add quantity and unit price fields alongside the amount:
```
Supplier: [Pacific Imports ▼]
Qty: [100]  ×  Unit price: [$21.00]  =  Total: $2,100.00
Method: [ACH ▼]
Notes: [_______________]
```

When qty or unit price changes, total auto-calculates. The `amount` field becomes read-only (computed from qty × unit_price). User can also override total directly (which back-calculates unit price).

When amount changes from original:
- Show inline amber warning: "⚠ Price changed from $1,800.00 (+$300 / +16.7%)"
- Show "Revert to original" link → calls `api.revertSupplierPriceChange()`

When profit goes negative due to price change:
- Show red warning: "⚠ This price change causes a loss on this deal"
- Recalculate and display new profit split in real time

### Acceptance criteria
- Qty × unit price = total (auto-calculated)
- Changing qty or price shows change delta vs original
- Revert button restores original amount
- Profit recalculates in real time on any amount change
- Loss warning appears immediately when profit goes negative (not just at completion)
- `cargo check` and `npm run build` pass

---

## Build sequence

```
STEP 1: DONE
STEP 2: DONE
STEP 3: Brief profit + splits     → cargo check + npm run build → verify
STEP 4: Editable split %          → cargo check + npm run build → verify
STEP 5: Suppliers + Node map      → cargo check + npm run build → verify (largest step)
STEP 6: Price/qty change handling → cargo check + npm run build → verify → ship v0.7.0
```

---

## Start instructions

Steps 1 and 2 are complete. Generate Phase 1 plan for **STEP 3 only** (Weekly Brief profit summary). List every file and every specific change. Wait for approval before executing.
