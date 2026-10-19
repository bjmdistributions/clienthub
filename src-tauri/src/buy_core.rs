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
    /// What the buy's rows have paid towards the goods and the shipping, never more than each total.
    pub goods_paid: f64,
    pub ship_paid: f64,
}

/// Each order's goods and shipping share, in order.
fn shares(t: &Totals, orders: &[OrderIn]) -> Vec<(f64, f64, bool)> {
    let units = t.units.max(0.0);
    let (ug, us) = if units > 0.0 { (t.goods / units, t.ship / units) } else { (0.0, 0.0) };
    let (mut sold, mut g_sum, mut s_sum) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut out = Vec::with_capacity(orders.len());
    for o in orders {
        let count = o.count.max(0.0);
        let before = sold;
        sold += count;
        let typed = o.goods_typed.map(|g| r2(g.max(0.0)));
        let (g, s, past) = if units <= 0.0 {
            (typed.unwrap_or(0.0), 0.0, false)
        } else if before >= units - 1e-9 {
            (typed.unwrap_or(0.0), 0.0, true)
        } else if sold >= units - 1e-9 {
            // The last of what was bought: whatever is left of each total.
            (typed.unwrap_or_else(|| r2((t.goods - g_sum).max(0.0))), r2((t.ship - s_sum).max(0.0)), false)
        } else {
            (typed.unwrap_or_else(|| r2(count * ug)), r2(count * us), false)
        };
        g_sum += g;
        s_sum += s;
        out.push((g, s, past));
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
    for (o, (g, s, past)) in orders.iter().zip(sh) {
        let mut p = OrderPlan {
            id: o.id.clone(),
            count: o.count.max(0.0),
            goods: g,
            ship: s,
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
    /// (goods + shipping in) / units bought.
    pub unit_cost: f64,
    pub goods_paid: f64,
    pub ship_paid: f64,
    /// The orders' shares (or their own typed cost).
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
        unit_cost: if t.units > 0.0 { (t.goods + t.ship) / t.units } else { 0.0 },
        goods_paid: p.goods_paid,
        ship_paid: p.ship_paid,
        oversold: p.oversold,
        sold_out: t.units > 0.0 && p.sold >= t.units - 1e-9,
        ..Default::default()
    };
    for o in &p.orders {
        let m = money.iter().find(|m| m.id == o.id).cloned().unwrap_or_default();
        let cost = if o.own_cost { r2(m.own_cost) } else { r2(o.goods + o.ship) };
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
    r.made_so_far = r2(r.received - t.goods - t.ship - r.other_cost - r.refunds);
    r
}

/// The id of an order: one per invoice and buy, so a retry never records it twice.
pub fn order_id(invoice_id: &str, buy_id: &str) -> String {
    format!("bo-{invoice_id}-{buy_id}")
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
        let t = Totals { units: 110_000.0, goods: 137_500.0, ship: 3_000.0 };
        let p = plan(&t, &[o("a", 1_000.0)], &[]);
        assert_eq!(p.orders[0].goods, 1_250.0);
        assert_eq!(p.orders[0].ship, 27.27);
        assert!(((p.unit_goods + p.unit_ship) - 1.277_272).abs() < 1e-5);
        assert!(!p.orders[0].goods_paid);
    }

    #[test]
    fn the_last_order_takes_what_is_left_so_shares_never_pass_what_was_paid() {
        let t = Totals { units: 3.0, goods: 100.0, ship: 10.0 };
        let p = plan(&t, &[o("a", 1.0), o("b", 1.0), o("c", 1.0)], &[]);
        let g: Vec<f64> = p.orders.iter().map(|x| x.goods).collect();
        assert_eq!(g, vec![33.33, 33.33, 33.34]);
        let s: f64 = p.orders.iter().map(|x| x.ship).sum();
        assert!((r2(s) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn an_order_past_what_was_bought_takes_nothing_and_says_so() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0 };
        let p = plan(&t, &[o("a", 8.0), o("b", 4.0), o("c", 1.0)], &[]);
        assert_eq!(p.orders[0].goods, 80.0);
        assert_eq!(p.orders[1].goods, 20.0, "crossing the line takes the rest");
        assert_eq!(p.orders[2].goods, 0.0);
        assert!(p.orders[2].past_bought);
        assert!(p.oversold);
    }

    #[test]
    fn a_typed_share_stands_and_the_last_order_takes_what_it_left() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0 };
        let mut a = o("a", 5.0);
        a.goods_typed = Some(60.0);
        let p = plan(&t, &[a, o("b", 5.0)], &[]);
        assert_eq!(p.orders[0].goods, 60.0);
        assert_eq!(p.orders[1].goods, 40.0);
    }

    #[test]
    fn a_wire_covers_the_oldest_orders_in_full_and_holds_the_rest() {
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0 };
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
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0 };
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
        let t = Totals { units: 1.0, goods: 100.0, ship: 0.0 };
        let p = plan(&t, &[], &[row("w", Kind::Goods, 150.0, "2026-10-01")]);
        assert_eq!(p.held, vec![Held { txn_id: "w".into(), kind: Kind::Goods, amount: 100.0 }]);
    }

    #[test]
    fn shipping_in_is_its_own_leg_on_its_own_rows() {
        let t = Totals { units: 4.0, goods: 40.0, ship: 8.0 };
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
        let t = Totals { units: 10.0, goods: 100.0, ship: 0.0 };
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
        let t = Totals { units: 10.0, goods: 100.0, ship: 10.0 };
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
        let p = plan(&Totals { units: 5.0, goods: 10.0, ship: 0.0 }, &[], &[]);
        assert!(p.sold == 0.0 && p.sold.is_sign_positive(), "an empty sum must not serialise as -0.0");
        assert!(r2(-0.0).is_sign_positive());
        assert_eq!(serde_json::to_string(&p.sold).unwrap(), "0.0");
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
}
