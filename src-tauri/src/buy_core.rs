//! A buy (R-488): one warehouse product or one delivery bought from a supplier, and the cost each
//! order taken from it carries onto that order's deal.
//!
//! BYTE-IDENTICAL in two places: BUSINESS APP `src-tauri/src/buy_core.rs` and clienthub-api
//! `src/routes/buy_core.rs`. It uses nothing from either crate (no `use crate::`), so the desktop
//! and the phone can never work out a share differently. Edit one, copy it over, and run the tests
//! in both repos.
//!
//! The cost. A unit costs (paid for the goods + shipping in) / units bought. An order's share is
//! its units times that, the goods and the shipping kept apart because they are different legs of
//! a deal. A typed goods share (Jack: "i might sell it different cost and unit each time") stands
//! in for the worked-out one. The order that takes the last of what was bought takes whatever is
//! left of each total, so the shares never add up to more than was paid; an order past that takes
//! nothing more.
//!
//! The bank. The buy's goods payments go to each order's deal as `supplier_payment`, its shipping
//! payments as `fee`: the two cost legs `deal_bank_actuals` reads. Oldest order first, and an order
//! is covered in full or not at all, because a supplier leg linked for part of the cost would
//! replace the typed cost with the smaller linked figure. What the buy has paid that no order has
//! taken yet is held against the buy itself as `adjustment`, which no figure reads, so the bank
//! rows read as booked rather than asking for a deal.
//!
//! A shipping share that no shipping payment covers is written on the deal as a typed `other`
//! cost; one a payment covers is not written as a line at all, since the `fee` link already counts
//! it and the line would count it twice on a deal whose goods are not linked.
//!
//! R-551: the trucks. A buy brought in by logistics loads (`freight_bookings.buy_id`) takes its
//! shipping in from them (`truck_cost`, `ship_in`): each truck at what its carrier was paid (a tied
//! bank row sets that), else its carrier rate, else the carrier cost its quote was built on. A typed
//! shipping in stands only while the buy has no truck. His markup on those trucks is his pay, never a
//! bank row of the buy, so it is not in `ship` and never covered: it is laid on the orders like the
//! shipping in (`OrderPlan::markup`), counted in the cost of a unit and in the rollup, and each runtime
//! takes an order's markup off the top of that order's owner split as logistics pay, the way his
//! markup on any truck is taken.
//!
//! R-552: a payment tied to a buy books in full or says why, never nothing (`pay_take`). With no cost
//! typed the cost becomes what was paid; a payment past what is left books all of it (the cost rises)
//! or only what is left, as Jack chooses each time.

use serde::{Deserialize, Serialize};

/// Money closer than this is the same money.
pub const CENT: f64 = 0.005;

/// The note on every cost line a buy writes, and on every bank booking it makes for an order.
/// `is_buy_line` (both engines) refuses to edit, keep, pay or remove such a line by hand.
pub const LINE_NOTE_PREFIX: &str = "Buy: ";

/// To the cent. `+ 0.0` turns a negative zero (what Rust's float `sum` of nothing is) into a plain
/// zero, so no screen ever prints "-0".
pub fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0 + 0.0
}

/// The sum of what is given, plain zero when there is nothing (`Iterator::sum` gives -0.0 then).
pub fn total(it: impl Iterator<Item = f64>) -> f64 {
    it.fold(0.0, |a, b| a + b)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Goods,
    Ship,
}

/// What was bought and what it cost.
#[derive(Debug, Clone, Default)]
pub struct Totals {
    pub units: f64,
    pub goods: f64,
    pub ship: f64,
    /// R-551: his markup on the trucks that brought the buy in, while the logistics pay rule pays it
    /// (0 otherwise). Laid on the orders like `ship`, never covered by a bank row.
    pub markup: f64,
}

/// One order, in the order they were taken.
#[derive(Debug, Clone, Default)]
pub struct OrderIn {
    pub id: String,
    pub count: f64,
    /// The goods share typed by hand, in place of the worked-out one.
    pub goods_typed: Option<f64>,
    /// The order's deal already carried a supplier cost typed by hand when the buy was recorded:
    /// it keeps that, and nothing is written on it.
    pub own_cost: bool,
}

/// One bank row paying the buy, with the room on it: its amount less what it is booked to
/// anything that is not this buy.
#[derive(Debug, Clone)]
pub struct RowIn {
    pub txn_id: String,
    pub kind: Kind,
    pub room: f64,
    pub posted_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Slice {
    pub txn_id: String,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderPlan {
    pub id: String,
    pub count: f64,
    /// The goods and shipping shares. For an `own_cost` order these are what it would have taken;
    /// nothing is written for it.
    pub goods: f64,
    pub ship: f64,
    /// R-551: the order's share of his markup on the trucks (0 for an `own_cost` order, which keeps
    /// its own typed cost and takes nothing of the buy's).
    pub markup: f64,
    pub goods_slices: Vec<Slice>,
    pub ship_slices: Vec<Slice>,
    pub goods_paid: bool,
    pub ship_paid: bool,
    /// The latest date among the rows that cover it, "" when not covered.
    pub goods_paid_at: String,
    pub ship_paid_at: String,
    pub own_cost: bool,
    /// Taken after everything bought was already sold: it takes no share.
    pub past_bought: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Held {
    pub txn_id: String,
    pub kind: Kind,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub orders: Vec<OrderPlan>,
    pub held: Vec<Held>,
    pub sold: f64,
    /// More was sold than bought: the units bought want checking.
    pub oversold: bool,
    pub unit_goods: f64,
    pub unit_ship: f64,
    /// R-551: his markup on the trucks, a unit.
    pub unit_markup: f64,
    /// What the buy's rows have paid towards the goods and the shipping, never more than each total.
    pub goods_paid: f64,
    pub ship_paid: f64,
}

/// Each order's goods, shipping and markup share, in order.
fn shares(t: &Totals, orders: &[OrderIn]) -> Vec<(f64, f64, f64, bool)> {
    let units = t.units.max(0.0);
    let (ug, us, um) = if units > 0.0 { (t.goods / units, t.ship / units, t.markup / units) } else { (0.0, 0.0, 0.0) };
    let (mut sold, mut g_sum, mut s_sum, mut m_sum) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let mut out = Vec::with_capacity(orders.len());
    for o in orders {
        let count = o.count.max(0.0);
        let before = sold;
        sold += count;
        let typed = o.goods_typed.map(|g| r2(g.max(0.0)));
        let (g, s, m, past) = if units <= 0.0 {
            (typed.unwrap_or(0.0), 0.0, 0.0, false)
        } else if before >= units - 1e-9 {
            (typed.unwrap_or(0.0), 0.0, 0.0, true)
        } else if sold >= units - 1e-9 {
            // The last of what was bought: whatever is left of each total.
            (
                typed.unwrap_or_else(|| r2((t.goods - g_sum).max(0.0))),
                r2((t.ship - s_sum).max(0.0)),
                r2((t.markup - m_sum).max(0.0)),
                false,
            )
        } else {
            (typed.unwrap_or_else(|| r2(count * ug)), r2(count * us), r2(count * um), false)
        };
        g_sum += g;
        s_sum += s;
        m_sum += m;
        out.push((g, s, m, past));
    }
    out
}

/// Take `need` from the rows in order, or nothing when they cannot cover all of it.
fn cover(rooms: &mut [(String, f64, String)], need: f64) -> Option<(Vec<Slice>, String)> {
    let have = total(rooms.iter().map(|r| r.1));
    if have + CENT < need {
        return None;
    }
    let mut left = r2(need);
    let mut slices = Vec::new();
    let mut at = String::new();
    for r in rooms.iter_mut() {
        if left <= CENT {
            break;
        }
        let take = r2(r.1.min(left));
        if take <= CENT {
            continue;
        }
        r.1 = r2(r.1 - take);
        left = r2(left - take);
        slices.push(Slice { txn_id: r.0.clone(), amount: take });
        if r.2 > at {
            at = r.2.clone();
        }
    }
    Some((slices, at))
}

fn rooms_of(rows: &[RowIn], kind: Kind) -> Vec<(String, f64, String)> {
    let mut v: Vec<&RowIn> = rows.iter().filter(|r| r.kind == kind).collect();
    v.sort_by(|a, b| a.posted_at.cmp(&b.posted_at).then(a.txn_id.cmp(&b.txn_id)));
    v.into_iter().map(|r| (r.txn_id.clone(), r2(r.room.max(0.0)), r.posted_at.clone())).collect()
}

/// Hold what the buy has paid and no order took, up to `total` less what the orders took.
fn hold(rooms: &[(String, f64, String)], kind: Kind, total: f64, taken: f64, out: &mut Vec<Held>) -> f64 {
    let mut want = r2((total - taken).max(0.0));
    for r in rooms {
        if want <= CENT {
            break;
        }
        let a = r2(r.1.min(want));
        if a > CENT {
            out.push(Held { txn_id: r.0.clone(), kind, amount: a });
            want = r2(want - a);
        }
    }
    r2((total - taken).max(0.0) - want)
}

/// The whole plan: every order's shares and what covers them, and what is held on the buy.
pub fn plan(t: &Totals, orders: &[OrderIn], rows: &[RowIn]) -> Plan {
    let sh = shares(t, orders);
    let mut goods_rooms = rooms_of(rows, Kind::Goods);
    let mut ship_rooms = rooms_of(rows, Kind::Ship);
    let (mut goods_open, mut ship_open) = (true, true);
    let (mut goods_taken, mut ship_taken) = (0.0_f64, 0.0_f64);
    let mut out = Vec::with_capacity(orders.len());
    for (o, (g, s, m, past)) in orders.iter().zip(sh) {
        let mut p = OrderPlan {
            id: o.id.clone(),
            count: o.count.max(0.0),
            goods: g,
            ship: s,
            markup: if o.own_cost { 0.0 } else { m },
            goods_slices: Vec::new(),
            ship_slices: Vec::new(),
            goods_paid: false,
            ship_paid: false,
            goods_paid_at: String::new(),
            ship_paid_at: String::new(),
            own_cost: o.own_cost,
            past_bought: past,
        };
        if !o.own_cost {
            // Oldest first: once a payment cannot cover an order, no later order is covered.
            if g > CENT && goods_open {
                match cover(&mut goods_rooms, g) {
                    Some((sl, at)) => {
                        goods_taken += g;
                        p.goods_slices = sl;
                        p.goods_paid = true;
                        p.goods_paid_at = at;
                    }
                    None => goods_open = false,
                }
            }
            if s > CENT && ship_open {
                match cover(&mut ship_rooms, s) {
                    Some((sl, at)) => {
                        ship_taken += s;
                        p.ship_slices = sl;
                        p.ship_paid = true;
                        p.ship_paid_at = at;
                    }
                    None => ship_open = false,
                }
            }
        }
        out.push(p);
    }
    let mut held = Vec::new();
    let goods_held = hold(&goods_rooms, Kind::Goods, t.goods, goods_taken, &mut held);
    let ship_held = hold(&ship_rooms, Kind::Ship, t.ship, ship_taken, &mut held);
    let sold = total(orders.iter().map(|o| o.count.max(0.0)));
    let units = t.units.max(0.0);
    Plan {
        sold,
        oversold: units > 0.0 && sold > units + 1e-9,
        unit_goods: if units > 0.0 { t.goods / units } else { 0.0 },
        unit_ship: if units > 0.0 { t.ship / units } else { 0.0 },
        unit_markup: if units > 0.0 { t.markup / units } else { 0.0 },
        goods_paid: r2(goods_taken + goods_held),
        ship_paid: r2(ship_taken + ship_held),
        orders: out,
        held,
    }
}

/// What one order brought in and cost besides the buy, read off its deal by the runtime.
#[derive(Debug, Clone, Default)]
pub struct OrderMoney {
    pub id: String,
    /// The invoice's total.
    pub sales: f64,
    /// What the buyer has paid so far.
    pub received: f64,
    /// The deal's other costs: shipping to the buyer and any cost line that is not the buy's.
    pub other_cost: f64,
    pub refunds: f64,
    /// For an `own_cost` order, the supplier cost typed on its deal.
    pub own_cost: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct OrderFigures {
    pub id: String,
    pub cost: f64,
    pub sales: f64,
    pub received: f64,
    pub other_cost: f64,
    pub refunds: f64,
    pub made: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Rollup {
    pub bought: f64,
    pub sold: f64,
    pub left: f64,
    pub goods_total: f64,
    pub ship_total: f64,
    /// R-551: his markup on the trucks that brought it in.
    pub markup_total: f64,
    /// (goods + shipping in + his markup on the trucks) / units bought.
    pub unit_cost: f64,
    pub goods_paid: f64,
    pub ship_paid: f64,
    /// The orders' shares, his markup on the trucks included (or their own typed cost).
    pub cost_sold: f64,
    pub sales: f64,
    pub received: f64,
    pub other_cost: f64,
    pub refunds: f64,
    /// Sales less the cost of what was sold, the orders' other costs and the refunds.
    pub made_on_sold: f64,
    /// Money in from buyers less everything the buy cost (all of it, sold or not), the orders'
    /// other costs and the refunds: what the whole buy has made so far, the unsold stock at nothing.
    /// Once everything is sold and paid it is the exact profit.
    pub made_so_far: f64,
    pub sold_out: bool,
    pub oversold: bool,
    pub orders: Vec<OrderFigures>,
}

pub fn rollup(t: &Totals, p: &Plan, money: &[OrderMoney], left: f64) -> Rollup {
    let mut r = Rollup {
        bought: t.units.max(0.0),
        sold: p.sold,
        left,
        goods_total: r2(t.goods),
        ship_total: r2(t.ship),
        markup_total: r2(t.markup),
        unit_cost: if t.units > 0.0 { (t.goods + t.ship + t.markup) / t.units } else { 0.0 },
        goods_paid: p.goods_paid,
        ship_paid: p.ship_paid,
        oversold: p.oversold,
        sold_out: t.units > 0.0 && p.sold >= t.units - 1e-9,
        ..Default::default()
    };
    for o in &p.orders {
        let m = money.iter().find(|m| m.id == o.id).cloned().unwrap_or_default();
        let cost = if o.own_cost { r2(m.own_cost) } else { r2(o.goods + o.ship + o.markup) };
        let made = r2(m.sales - cost - m.other_cost - m.refunds);
        r.cost_sold += cost;
        r.sales += m.sales;
        r.received += m.received;
        r.other_cost += m.other_cost;
        r.refunds += m.refunds;
        r.orders.push(OrderFigures { id: o.id.clone(), cost, sales: r2(m.sales), received: r2(m.received), other_cost: r2(m.other_cost), refunds: r2(m.refunds), made });
    }
    r.cost_sold = r2(r.cost_sold);
    r.sales = r2(r.sales);
    r.received = r2(r.received);
    r.other_cost = r2(r.other_cost);
    r.refunds = r2(r.refunds);
    r.made_on_sold = r2(r.sales - r.cost_sold - r.other_cost - r.refunds);
    r.made_so_far = r2(r.received - t.goods - t.ship - t.markup - r.other_cost - r.refunds);
    r
}

/// R-551: one truck bringing a buy in, as the runtime reads it off `freight_bookings`.
#[derive(Debug, Clone, Default)]
pub struct TruckIn {
    /// `freight_bookings.status`.
    pub status: String,
    pub archived: bool,
    /// `paid_amount`: what the carrier was paid (tying a bank row in Pay carriers sets it).
    pub paid: Option<f64>,
    /// `quoted_cost`: the carrier rate.
    pub rate: Option<f64>,
    /// `quote_cost`: the carrier cost the quote was built on.
    pub quote_cost: Option<f64>,
    /// `markup_amount`: his markup on this truck.
    pub markup: Option<f64>,
}

impl TruckIn {
    /// Neither removed nor cancelled. A truck still waiting for its quote is live and costs nothing yet.
    pub fn live(&self) -> bool {
        !self.archived && self.status != "cancelled"
    }
}

/// What one truck's carrier costs the buy: what it was paid, else its carrier rate, else the carrier cost
/// its quote was built on, else nothing yet. A cancelled or removed truck costs nothing. A recorded $0 is
/// not a payment (the R-533 rule), so the truck still counts at its rate.
pub fn truck_carrier(t: &TruckIn) -> f64 {
    if !t.live() {
        return 0.0;
    }
    let some = |x: Option<f64>| x.filter(|v| v.is_finite() && *v > CENT);
    r2(some(t.paid).or(some(t.rate)).or(some(t.quote_cost)).unwrap_or(0.0))
}

/// A buy's trucks, totalled.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct TruckCost {
    /// Trucks neither removed nor cancelled.
    pub live: usize,
    /// Live trucks with a carrier figure (paid, a rate or a quote).
    pub priced: usize,
    /// Live trucks whose carrier was paid.
    pub paid: usize,
    pub carrier: f64,
    /// His markup on the live trucks, when `pays_markup` (the logistics pay rule is on and paying);
    /// 0 otherwise.
    pub markup: f64,
}

pub fn truck_cost(trucks: &[TruckIn], pays_markup: bool) -> TruckCost {
    let mut c = TruckCost::default();
    let (mut carrier, mut markup) = (0.0_f64, 0.0_f64);
    for t in trucks.iter().filter(|t| t.live()) {
        c.live += 1;
        let x = truck_carrier(t);
        if x > CENT {
            c.priced += 1;
        }
        if t.paid.map_or(false, |p| p.is_finite() && p > CENT) {
            c.paid += 1;
        }
        carrier += x;
        if pays_markup {
            markup += t.markup.filter(|m| m.is_finite() && *m > 0.0).unwrap_or(0.0);
        }
    }
    c.carrier = r2(carrier);
    c.markup = r2(markup);
    c
}

/// The buy's shipping in: its trucks' carriers once it has a truck, the typed figure only while it has none.
pub fn ship_in(typed: f64, trucks: &TruckCost) -> f64 {
    if trucks.live > 0 { trucks.carrier } else { r2(typed.max(0.0)) }
}

/// The id of an order: one per invoice and buy, so a retry never records it twice.
pub fn order_id(invoice_id: &str, buy_id: &str) -> String {
    format!("bo-{invoice_id}-{buy_id}")
}

/// The id of a bank booking a buy makes: the same on every device for the same deal, row and
/// role, so two devices writing at once write one row, and every booking a buy owns starts with
/// `alloc_<buy id>_` (`alloc_prefix`) so two buys on one deal never touch each other's.
pub fn alloc_id(buy_id: &str, deal: &str, txn_id: &str, role: &str) -> String {
    // FNV-1a, 64 bits: a stable hash the same in both crates (no hasher seed).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in deal.bytes().chain([0u8]).chain(txn_id.bytes()).chain([0u8]).chain(role.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{}{:016x}", alloc_prefix(buy_id), h)
}
pub fn alloc_prefix(buy_id: &str) -> String {
    format!("alloc_{buy_id}_")
}

/// The ids of the two cost lines a buy writes on an order's deal.
pub fn goods_line_id(order_id: &str) -> String {
    format!("buyg-{order_id}")
}
pub fn ship_line_id(order_id: &str) -> String {
    format!("buys-{order_id}")
}

/// The note on an order's goods line and its bank bookings, and on its shipping line.
pub fn goods_note(buy_name: &str) -> String {
    format!("{LINE_NOTE_PREFIX}{buy_name}")
}
pub fn ship_note(buy_name: &str) -> String {
    format!("{LINE_NOTE_PREFIX}{buy_name}, shipping in")
}
/// The note on what a buy holds on its own bank rows.
pub fn held_note(buy_name: &str, kind: Kind) -> String {
    match kind {
        Kind::Goods => format!("Held as stock: {buy_name}"),
        Kind::Ship => format!("Held as stock, shipping in: {buy_name}"),
    }
}
/// Which leg a held booking is, from its note.
pub fn held_kind(note: &str) -> Kind {
    if note.starts_with("Held as stock, shipping in: ") { Kind::Ship } else { Kind::Goods }
}

pub fn is_buy_note(note: &str) -> bool {
    note.starts_with(LINE_NOTE_PREFIX)
}

/// R-552: the buy that made a bank booking, read off its id (`alloc_<buy id>_<16 hex>`, `alloc_id`). None for any
/// other booking, so Financials can take a buy's payment off the whole buy instead of one slice of it.
pub fn buy_of_alloc(alloc_id: &str) -> Option<&str> {
    let rest = alloc_id.strip_prefix("alloc_")?;
    let (buy, hash) = rest.rsplit_once('_')?;
    (!buy.is_empty() && hash.len() == 16 && hash.chars().all(|c| c.is_ascii_hexdigit())).then_some(buy)
}

/// R-552: how a payment past what is left to pay on a buy is booked. Jack chooses each time.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Take {
    /// Book the whole payment: what the buy cost rises to what has been paid.
    All,
    /// Book only what is left to pay; the rest of the payment stays free in Financials.
    Left,
}

/// Shown verbatim on every surface.
pub const PAY_NO_ROOM: &str = "That payment is already booked in full in Financials. Take it off there first.";
pub const PAY_PAID_IN_FULL: &str =
    "This buy is already paid in full, so nothing is left for this payment. Book all of it to raise what the buy cost.";
pub const PAY_ALREADY_HERE: &str = "That payment is already on this buy.";

/// R-552: tying a payment to a buy books all of it or says why not; it is never dropped. `total` is what the buy cost for
/// that leg, `paid` what is booked on it now, `room` what the payment still has free. Returns what it books and, when the
/// buy's cost has to rise for it, the new cost. No cost yet: the cost becomes what has been paid. A payment past what is
/// left books all of it (`Take::All`) or only what is left (`Take::Left`, and no choice reads as that).
pub fn pay_take(total: f64, paid: f64, room: f64, take: Option<Take>) -> Result<(f64, Option<f64>), &'static str> {
    let room = r2(room);
    if room <= CENT {
        return Err(PAY_NO_ROOM);
    }
    if total <= CENT {
        return Ok((room, Some(r2(paid.max(0.0) + room))));
    }
    let left = r2((total - paid).max(0.0));
    if room <= left + CENT {
        return Ok((room, None));
    }
    match take {
        Some(Take::All) => Ok((room, Some(r2(paid.max(0.0) + room)))),
        _ if left <= CENT => Err(PAY_PAID_IN_FULL),
        _ => Ok((left, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(id: &str, count: f64) -> OrderIn {
        OrderIn { id: id.into(), count, ..Default::default() }
    }
    fn row(id: &str, kind: Kind, room: f64, at: &str) -> RowIn {
        RowIn { txn_id: id.into(), kind, room, posted_at: at.into() }
    }

    #[test]
    fn a_unit_costs_what_was_paid_plus_shipping_in_over_the_units() {
        // Jack's example: 110,000 pairs at $1.25 and $3,000 shipping in.
        let t = Totals { units: 110_000.0, goods: 137_500.0, ship: 3_000.0, markup: 0.0 };
        let p = plan(&t, &[o("a", 1_000.0)], &[]);
        assert_eq!(p.orders[0].goods, 1_250.0);
        assert_eq!(p.orders[0].ship, 27.27);
        assert!(((p.unit_goods + p.unit_ship) - 1.277_272).abs() < 1e-5);
        assert!(!p.orders[0].goods_paid);
    }

    #[test]
    fn the_last_order_takes_what_is_left_so_shares_never_pass_what_was_paid() {
        let t = Totals { units: 3.0, goods: 100.0, ship: 10.0, markup: 0.0 };
        let p = plan(&t, &[o("a", 1.0), o("b", 1.0), o("c", 1.0)], &[]);
        let g: Vec<f64> = p.orders.iter().map(|x| x.goods).collect();
        assert_eq!(g, vec![33.33, 33.33, 33.34]);
        let s: f64 = p.orders.iter().map(|x| x.ship).sum();
        assert!((r2(s) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn an_order_past_what_was_bought_takes_nothing_and_says_so() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0, markup: 0.0 };
        let p = plan(&t, &[o("a", 8.0), o("b", 4.0), o("c", 1.0)], &[]);
        assert_eq!(p.orders[0].goods, 80.0);
        assert_eq!(p.orders[1].goods, 20.0, "crossing the line takes the rest");
        assert_eq!(p.orders[2].goods, 0.0);
        assert!(p.orders[2].past_bought);
        assert!(p.oversold);
    }

    #[test]
    fn a_typed_share_stands_and_the_last_order_takes_what_it_left() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0, markup: 0.0 };
        let mut a = o("a", 5.0);
        a.goods_typed = Some(60.0);
        let p = plan(&t, &[a, o("b", 5.0)], &[]);
        assert_eq!(p.orders[0].goods, 60.0);
        assert_eq!(p.orders[1].goods, 40.0);
    }

    #[test]
    fn a_wire_covers_the_oldest_orders_in_full_and_holds_the_rest() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0, markup: 0.0 };
        let rows = [row("w1", Kind::Goods, 100.0, "2026-10-01")];
        let p = plan(&t, &[o("a", 2.0), o("b", 3.0)], &rows);
        assert_eq!(p.orders[0].goods_slices, vec![Slice { txn_id: "w1".into(), amount: 20.0 }]);
        assert_eq!(p.orders[0].goods_paid_at, "2026-10-01");
        assert_eq!(p.orders[1].goods_slices, vec![Slice { txn_id: "w1".into(), amount: 30.0 }]);
        assert_eq!(p.held, vec![Held { txn_id: "w1".into(), kind: Kind::Goods, amount: 50.0 }]);
        assert_eq!(p.goods_paid, 100.0);
    }

    #[test]
    fn a_deposit_and_a_balance_fill_in_date_order_and_an_order_never_part_covered() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0, markup: 0.0 };
        let rows = [row("bal", Kind::Goods, 30.0, "2026-10-05"), row("dep", Kind::Goods, 40.0, "2026-10-01")];
        let p = plan(&t, &[o("a", 5.0), o("b", 3.0), o("c", 1.0)], &rows);
        // a: 50 = 40 deposit + 10 balance; b: 30 > the 20 left, so b and every later order wait.
        assert_eq!(p.orders[0].goods_slices, vec![Slice { txn_id: "dep".into(), amount: 40.0 }, Slice { txn_id: "bal".into(), amount: 10.0 }]);
        assert_eq!(p.orders[0].goods_paid_at, "2026-10-05");
        assert!(!p.orders[1].goods_paid);
        assert!(!p.orders[2].goods_paid, "oldest first: c waits behind b");
        assert_eq!(p.held, vec![Held { txn_id: "bal".into(), kind: Kind::Goods, amount: 20.0 }]);
        assert_eq!(p.goods_paid, 70.0);
    }

    #[test]
    fn a_row_bigger_than_the_buy_holds_only_the_buy_and_leaves_the_rest_unbooked() {
        let t = Totals { units: 1.0, goods: 100.0, ship: 0.0, markup: 0.0 };
        let p = plan(&t, &[], &[row("w", Kind::Goods, 150.0, "2026-10-01")]);
        assert_eq!(p.held, vec![Held { txn_id: "w".into(), kind: Kind::Goods, amount: 100.0 }]);
    }

    #[test]
    fn shipping_in_is_its_own_leg_on_its_own_rows() {
        let t = Totals { units: 4.0, goods: 40.0, ship: 8.0, markup: 0.0 };
        let rows = [row("w", Kind::Goods, 40.0, "2026-10-01"), row("f", Kind::Ship, 8.0, "2026-10-15")];
        let p = plan(&t, &[o("a", 1.0)], &rows);
        assert_eq!(p.orders[0].goods_slices, vec![Slice { txn_id: "w".into(), amount: 10.0 }]);
        assert_eq!(p.orders[0].ship_slices, vec![Slice { txn_id: "f".into(), amount: 2.0 }]);
        assert!(p.orders[0].ship_paid);
        assert!(p.held.contains(&Held { txn_id: "f".into(), kind: Kind::Ship, amount: 6.0 }));
        assert!(p.held.contains(&Held { txn_id: "w".into(), kind: Kind::Goods, amount: 30.0 }));
    }

    #[test]
    fn an_order_with_its_own_cost_takes_its_share_but_is_never_covered() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0, markup: 0.0 };
        let mut a = o("a", 5.0);
        a.own_cost = true;
        let p = plan(&t, &[a, o("b", 5.0)], &[row("w", Kind::Goods, 100.0, "2026-10-01")]);
        assert!(p.orders[0].goods_slices.is_empty());
        assert_eq!(p.orders[1].goods, 50.0, "b still takes only its own half");
        assert_eq!(p.orders[1].goods_slices.len(), 1);
        assert_eq!(p.held, vec![Held { txn_id: "w".into(), kind: Kind::Goods, amount: 50.0 }]);
    }

    #[test]
    fn the_rollup_counts_the_unsold_stock_at_nothing_until_it_sells() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 10.0, markup: 0.0 };
        let p = plan(&t, &[o("a", 5.0)], &[]);
        let m = [OrderMoney { id: "a".into(), sales: 120.0, received: 120.0, other_cost: 5.0, ..Default::default() }];
        let r = rollup(&t, &p, &m, 5.0);
        assert_eq!(r.cost_sold, 55.0);
        assert_eq!(r.made_on_sold, 60.0);
        assert_eq!(r.made_so_far, 5.0);
        assert!(!r.sold_out);
        let p2 = plan(&t, &[o("a", 5.0), o("b", 5.0)], &[]);
        let m2 = [m[0].clone(), OrderMoney { id: "b".into(), sales: 100.0, received: 100.0, ..Default::default() }];
        let r2_ = rollup(&t, &p2, &m2, 0.0);
        assert!(r2_.sold_out);
        assert_eq!(r2_.made_on_sold, r2_.made_so_far, "sold out and paid: the two figures meet");
    }

    #[test]
    fn nothing_sold_reads_as_a_plain_zero() {
        let p = plan(&Totals { units: 5.0, goods: 10.0, ship: 0.0, markup: 0.0 }, &[], &[]);
        assert!(p.sold == 0.0 && p.sold.is_sign_positive(), "an empty sum must not serialise as -0.0");
        assert!(r2(-0.0).is_sign_positive());
        assert_eq!(serde_json::to_string(&p.sold).unwrap(), "0.0");
    }

    #[test]
    fn a_booking_id_is_the_same_everywhere_and_names_its_buy() {
        let a = alloc_id("buy_1", "deal_1", "txn_1", "supplier_payment");
        assert_eq!(a, alloc_id("buy_1", "deal_1", "txn_1", "supplier_payment"));
        assert!(a.starts_with(&alloc_prefix("buy_1")));
        assert_ne!(a, alloc_id("buy_1", "deal_1", "txn_1", "fee"));
        assert_ne!(a, alloc_id("buy_2", "deal_1", "txn_1", "supplier_payment"));
        assert_eq!(a, "alloc_buy_1_".to_string() + &a[12..]);
    }

    fn truck(status: &str, paid: Option<f64>, rate: Option<f64>, quote_cost: Option<f64>, markup: Option<f64>) -> TruckIn {
        TruckIn { status: status.into(), archived: false, paid, rate, quote_cost, markup }
    }

    #[test]
    fn a_truck_costs_what_was_paid_else_its_rate_else_its_quote() {
        assert_eq!(truck_carrier(&truck("delivered", Some(1_740.0), Some(1_750.0), Some(1_700.0), None)), 1_740.0);
        assert_eq!(truck_carrier(&truck("booked", None, Some(1_750.0), Some(1_700.0), None)), 1_750.0);
        assert_eq!(truck_carrier(&truck("quoted", None, None, Some(1_700.0), None)), 1_700.0);
        assert_eq!(truck_carrier(&truck("quote", None, None, None, None)), 0.0, "waiting for its quote");
        assert_eq!(truck_carrier(&truck("booked", Some(0.0), Some(1_750.0), None, None)), 1_750.0, "a $0 is not a payment");
        assert_eq!(truck_carrier(&truck("cancelled", Some(500.0), Some(1_750.0), None, None)), 0.0);
        let mut gone = truck("booked", None, Some(900.0), None, None);
        gone.archived = true;
        assert_eq!(truck_carrier(&gone), 0.0);
    }

    #[test]
    fn two_trucks_make_the_shipping_in_and_a_typed_figure_stands_only_without_one() {
        let ts = [
            truck("quoted", None, None, Some(1_600.0), Some(150.0)),
            truck("booked", None, Some(1_700.0), Some(1_650.0), Some(150.0)),
            truck("cancelled", None, Some(9_999.0), None, Some(99.0)),
        ];
        let c = truck_cost(&ts, true);
        assert_eq!(c, TruckCost { live: 2, priced: 2, paid: 0, carrier: 3_300.0, markup: 300.0 });
        assert_eq!(truck_cost(&ts, false).markup, 0.0, "no markup while the pay rule does not pay it");
        assert_eq!(ship_in(3_000.0, &c), 3_300.0);
        assert_eq!(ship_in(3_000.0, &TruckCost::default()), 3_000.0);
        let waiting = truck_cost(&[truck("quote", None, None, None, None)], true);
        assert_eq!((waiting.live, waiting.priced, ship_in(3_000.0, &waiting)), (1, 0, 0.0), "a truck sent replaces the typed figure");
    }

    #[test]
    fn his_markup_is_laid_on_the_orders_like_the_shipping_and_never_covered() {
        // Jack's plan example: 110,000 pairs at $1.25, two trucks: carriers $3,300 and his $300 markup.
        let t = Totals { units: 110_000.0, goods: 137_500.0, ship: 3_300.0, markup: 300.0 };
        let p = plan(&t, &[o("a", 1_000.0)], &[row("f", Kind::Ship, 3_300.0, "2026-10-30")]);
        assert_eq!(p.orders[0].ship, 30.0);
        assert_eq!(p.orders[0].markup, 2.73);
        assert!(p.orders[0].ship_paid, "the carrier row covers the shipping, the markup is not a bank cost");
        assert!(((p.unit_goods + p.unit_ship + p.unit_markup) - 1.282_727).abs() < 1e-5);
        let m = [OrderMoney { id: "a".into(), sales: 2_000.0, received: 2_000.0, ..Default::default() }];
        let r = rollup(&t, &p, &m, 109_000.0);
        assert_eq!(r.markup_total, 300.0);
        assert_eq!(r.cost_sold, 1_282.73);
        assert_eq!(r.made_on_sold, 717.27);
        assert_eq!(r.made_so_far, r2(2_000.0 - 137_500.0 - 3_300.0 - 300.0));
    }

    #[test]
    fn the_last_order_takes_what_is_left_of_the_markup_and_an_own_cost_order_none() {
        let t = Totals { units: 3.0, goods: 30.0, ship: 0.0, markup: 10.0 };
        let mut b = o("b", 1.0);
        b.own_cost = true;
        let p = plan(&t, &[o("a", 1.0), b, o("c", 1.0)], &[]);
        let m: Vec<f64> = p.orders.iter().map(|x| x.markup).collect();
        assert_eq!(m, vec![3.33, 0.0, 3.34], "b keeps its own cost; c takes what is left after a and b's shares");
    }

    #[test]
    fn notes_and_ids_round_trip() {
        assert!(is_buy_note(&goods_note("Shoe truck")));
        assert!(is_buy_note(&ship_note("Shoe truck")));
        assert!(!is_buy_note(&held_note("Shoe truck", Kind::Goods)));
        assert_eq!(held_kind(&held_note("x", Kind::Ship)), Kind::Ship);
        assert_eq!(held_kind(&held_note("x", Kind::Goods)), Kind::Goods);
        assert_eq!(order_id("inv1", "buy1"), "bo-inv1-buy1");
    }

    #[test]
    fn a_bookings_buy_is_read_off_its_id_and_no_other_booking_has_one() {
        let a = alloc_id("buy_7f3a-1", "deal1", "txn1", "supplier_payment");
        assert_eq!(buy_of_alloc(&a), Some("buy_7f3a-1"));
        assert_eq!(buy_of_alloc("alloc_3f2b8c1e-9d4a-4b7e-8f00-123456789abc"), None, "a hand booking's uuid id");
        assert_eq!(buy_of_alloc("alloc__0123456789abcdef"), None);
        assert_eq!(buy_of_alloc("bt_x_0123456789abcdef"), None);
    }

    #[test]
    fn a_deposit_then_the_final_payment_both_book() {
        assert_eq!(pay_take(50_000.0, 0.0, 10_000.0, None), Ok((10_000.0, None)), "the deposit");
        assert_eq!(pay_take(50_000.0, 10_000.0, 40_000.0, None), Ok((40_000.0, None)), "the final payment, exactly what is left");
    }

    #[test]
    fn with_no_cost_typed_the_cost_becomes_what_was_paid() {
        assert_eq!(pay_take(0.0, 0.0, 10_000.0, None), Ok((10_000.0, Some(10_000.0))));
        assert_eq!(pay_take(0.0, 0.0, 10_000.0, Some(Take::Left)), Ok((10_000.0, Some(10_000.0))));
    }

    #[test]
    fn a_payment_past_what_is_left_books_all_or_only_what_is_left_and_never_nothing() {
        assert_eq!(pay_take(10_000.0, 10_000.0, 40_000.0, Some(Take::All)), Ok((40_000.0, Some(50_000.0))), "the cost rises");
        assert_eq!(pay_take(50_000.0, 45_000.0, 12_000.0, Some(Take::Left)), Ok((5_000.0, None)), "the rest stays free");
        assert_eq!(pay_take(50_000.0, 45_000.0, 12_000.0, None), Ok((5_000.0, None)));
        assert_eq!(pay_take(10_000.0, 10_000.0, 40_000.0, None), Err(PAY_PAID_IN_FULL), "paid in full says so");
        assert_eq!(pay_take(10_000.0, 10_000.0, 40_000.0, Some(Take::Left)), Err(PAY_PAID_IN_FULL));
        assert_eq!(pay_take(50_000.0, 0.0, 0.004, None), Err(PAY_NO_ROOM), "nothing free on the row");
    }
}
