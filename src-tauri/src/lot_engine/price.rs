//! Pricing a built lot.
//!
//! Price is a property of the **line**, not of the lot. Jack's rule, 2026-08-24:
//!
//! > *"price for customer will be based off a msrp % on these shoes, so when it comes down
//! > to the entire lot, 75$ off retail can be 19.5 a shoe."*
//!
//! So a $75-retail shoe at 26% is $19.50 a shoe, the lot total is the sum of the lines, and
//! **the percentage can differ by category** — *"price per unit per shoe on categories"*.
//! The percentage is always set by a person. Nothing here infers one.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::model::{Stack, TitleRisk};

fn round2(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 100.0).round() / 100.0
}

/// The percentage of MSRP the buyer pays, with per-category overrides.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Pricing {
    /// Global share of MSRP, e.g. `0.26` for 26 cents on the retail dollar.
    #[serde(default)]
    pub pct: f64,
    /// Category name -> its own share. Falls back to `pct`.
    #[serde(default)]
    pub overrides: BTreeMap<String, f64>,
    /// What the lot COSTS, as a share of MSRP, applied per line exactly like `pct`.
    ///
    /// Zero means "not recorded", not "free" — a lot with no cost set reports no margin
    /// rather than a 100% one, which is the difference between an unknown and a lie.
    #[serde(default)]
    pub cost_pct: f64,
    /// Per-category cost shares. Falls back to `cost_pct`.
    #[serde(default)]
    pub cost_overrides: BTreeMap<String, f64>,
}

impl Pricing {
    pub fn flat(pct: f64) -> Self {
        Pricing {
            pct,
            overrides: BTreeMap::new(),
            cost_pct: 0.0,
            cost_overrides: BTreeMap::new(),
        }
    }

    /// A lot priced at `pct` of retail that cost `cost_pct` of retail.
    pub fn with_cost(pct: f64, cost_pct: f64) -> Self {
        Pricing { cost_pct, ..Pricing::flat(pct) }
    }

    pub fn pct_for(&self, category: Option<&str>) -> f64 {
        if let Some(c) = category {
            for (k, v) in &self.overrides {
                if k.eq_ignore_ascii_case(c) {
                    return *v;
                }
            }
        }
        self.pct
    }

    /// The cost share for a category, falling back to the lot's own.
    pub fn cost_pct_for(&self, category: Option<&str>) -> f64 {
        if let Some(c) = category {
            for (k, v) in &self.cost_overrides {
                if k.eq_ignore_ascii_case(c) {
                    return *v;
                }
            }
        }
        self.cost_pct
    }

    /// What one unit costs you. Same shape as `unit_price`, and rounded at the unit for the
    /// same reason: the line total must be exactly `qty x the figure printed beside it`.
    pub fn unit_cost(&self, s: &Stack) -> f64 {
        round2(s.msrp * self.cost_pct_for(s.category.as_deref()))
    }

    pub fn extended_cost(&self, s: &Stack) -> f64 {
        round2(self.unit_cost(s) * s.units as f64)
    }

    /// True when a cost has actually been set. Distinguishes "no cost recorded" from "free".
    pub fn has_cost(&self) -> bool {
        self.cost_pct > 0.0 || self.cost_overrides.values().any(|v| *v > 0.0)
    }

    /// What one unit costs the buyer. A stack with no resolved MSRP prices at zero — which
    /// is reported in the quality report rather than quietly sold for nothing.
    pub fn unit_price(&self, s: &Stack) -> f64 {
        round2(s.msrp * self.pct_for(s.category.as_deref()))
    }

    /// Qty times unit price. Rounded at the unit, then multiplied, so the manifest's line
    /// total is exactly `qty x the price printed beside it`.
    pub fn extended(&self, s: &Stack) -> f64 {
        round2(self.unit_price(s) * s.units as f64)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupTotal {
    pub name: String,
    pub units: i64,
    pub styles: usize,
    pub locations: usize,
    pub msrp: f64,
    pub ask: f64,
    /// Ask divided by units — the figure Jack checks: $75 retail came out at $19.50.
    pub per_unit: f64,
    /// Share of the lot's units, 0.0-1.0.
    pub share: f64,
    /// What this slice costs and leaves. Zero when no cost has been set — read
    /// `LotTotals::cost_known` before showing either as a fact.
    pub cost: f64,
    pub profit: f64,
}

/// Everything a lot is worth saying about itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LotTotals {
    pub locations: usize,
    pub stacks: usize,
    pub styles: usize,
    pub units: i64,
    pub msrp: f64,
    pub ask: f64,
    /// Blended cents on the retail dollar across the whole lot.
    pub effective_pct: f64,
    pub per_unit: f64,
    /// What the lot costs you, and what it leaves. All three are zero when no cost has been
    /// set — see `cost_known`, which is what a UI must check before showing a margin.
    pub cost: f64,
    pub cost_per_unit: f64,
    pub profit: f64,
    /// Profit over ask, 0.0-1.0. Zero when there is no ask or no cost.
    pub margin: f64,
    /// False when no cost percentage was set, so "0 profit" can be told from "unknown".
    pub cost_known: bool,
    pub by_brand: Vec<GroupTotal>,
    pub by_category: Vec<GroupTotal>,
    /// Units by `title_risk`, indexed 0..=3. Grades 2 and 3 are the only ones that can
    /// mis-describe a lot.
    pub title_risk_units: [i64; 4],
}

impl LotTotals {
    /// Units the manifest carries a caveat against.
    pub fn unverified_units(&self) -> i64 {
        self.title_risk_units[TitleRisk::GuessedFromBarcode as usize]
            + self.title_risk_units[TitleRisk::Unknown as usize]
    }
}

struct Agg {
    units: i64,
    msrp: f64,
    ask: f64,
    cost: f64,
    styles: std::collections::HashSet<String>,
    locations: std::collections::HashSet<String>,
}

impl Default for Agg {
    fn default() -> Self {
        Agg {
            units: 0,
            msrp: 0.0,
            ask: 0.0,
            cost: 0.0,
            styles: Default::default(),
            locations: Default::default(),
        }
    }
}

fn finish(map: BTreeMap<String, Agg>, total_units: i64) -> Vec<GroupTotal> {
    let mut v: Vec<GroupTotal> = map
        .into_iter()
        .map(|(name, a)| GroupTotal {
            name,
            units: a.units,
            styles: a.styles.len(),
            locations: a.locations.len(),
            msrp: round2(a.msrp),
            ask: round2(a.ask),
            per_unit: if a.units > 0 { round2(a.ask / a.units as f64) } else { 0.0 },
            share: if total_units > 0 { a.units as f64 / total_units as f64 } else { 0.0 },
            cost: round2(a.cost),
            profit: round2(a.ask - a.cost),
        })
        .collect();
    v.sort_by(|a, b| b.units.cmp(&a.units).then(a.name.cmp(&b.name)));
    v
}

/// Total up the stacks that make up a lot.
pub fn lot_totals(stacks: &[Stack], p: &Pricing) -> LotTotals {
    let mut t = LotTotals::default();
    let mut brands: BTreeMap<String, Agg> = BTreeMap::new();
    let mut cats: BTreeMap<String, Agg> = BTreeMap::new();
    let mut styles: std::collections::HashSet<&str> = Default::default();
    let mut locations: std::collections::HashSet<&str> = Default::default();

    for s in stacks {
        let line_msrp = s.msrp * s.units as f64;
        let line_ask = p.extended(s);
        let line_cost = p.extended_cost(s);

        t.units += s.units;
        t.msrp += line_msrp;
        t.ask += line_ask;
        t.cost += line_cost;
        t.stacks += 1;
        t.title_risk_units[s.title_risk.as_u8() as usize] += s.units;
        styles.insert(s.title.as_str());
        locations.insert(s.location.as_str());

        for (map, key) in [
            (&mut brands, s.brand.clone().unwrap_or_else(|| "Unbranded".into())),
            (&mut cats, s.category.clone().unwrap_or_else(|| "Uncategorized".into())),
        ] {
            let e = map.entry(key).or_default();
            e.units += s.units;
            e.msrp += line_msrp;
            e.ask += line_ask;
            e.cost += line_cost;
            e.styles.insert(s.title.clone());
            e.locations.insert(s.location.clone());
        }
    }

    t.styles = styles.len();
    t.locations = locations.len();
    t.msrp = round2(t.msrp);
    t.ask = round2(t.ask);
    t.per_unit = if t.units > 0 { round2(t.ask / t.units as f64) } else { 0.0 };
    t.effective_pct = if t.msrp > 0.0 { t.ask / t.msrp } else { 0.0 };
    t.cost_known = p.has_cost();
    t.cost = round2(t.cost);
    t.cost_per_unit = if t.units > 0 { round2(t.cost / t.units as f64) } else { 0.0 };
    t.profit = round2(t.ask - t.cost);
    // Margin over the ask, not over the cost — "what share of what I charge do I keep" is
    // the question, and dividing by cost answers a different one (markup).
    t.margin = if t.cost_known && t.ask > 0.0 { t.profit / t.ask } else { 0.0 };
    t.by_brand = finish(brands, t.units);
    t.by_category = finish(cats, t.units);
    t
}

#[cfg(test)]
mod cost_tests {
    use super::*;

    fn stack(cat: &str, msrp: f64, units: i64) -> Stack {
        Stack {
            location: "01-001-01".into(),
            r#box: String::new(),
            upc: format!("u-{cat}"),
            title: format!("{cat} item"),
            units,
            msrp,
            brand: Some("Nike".into()),
            category: Some(cat.into()),
            segment: None,
            size_us: None,
            title_risk: TitleRisk::Typed,
            upc_ambiguous: false,
        }
    }

    /// Cost is a share of MSRP applied per line, exactly like the ask — so a $100 shoe at
    /// 26% sells for $26 and at 12% cost leaves $14.
    #[test]
    fn cost_and_margin_come_off_the_line_not_the_lot() {
        let lot = vec![stack("Footwear", 100.0, 10)];
        let t = lot_totals(&lot, &Pricing::with_cost(0.26, 0.12));
        assert_eq!(t.msrp, 1000.0);
        assert_eq!(t.ask, 260.0);
        assert_eq!(t.cost, 120.0);
        assert_eq!(t.profit, 140.0);
        assert_eq!(t.cost_per_unit, 12.0);
        assert!((t.margin - 140.0 / 260.0).abs() < 1e-9, "margin is over the ask, not the cost");
        assert!(t.cost_known);
        // Per category, so a lot with a cheap apparel tail can be read line by line.
        assert_eq!(t.by_category[0].cost, 120.0);
        assert_eq!(t.by_category[0].profit, 140.0);
    }

    /// No cost set is UNKNOWN, not free. A lot with no cost must not report 100% margin.
    #[test]
    fn no_cost_set_reports_unknown_rather_than_free() {
        let lot = vec![stack("Footwear", 100.0, 10)];
        let t = lot_totals(&lot, &Pricing::flat(0.26));
        assert!(!t.cost_known, "nothing was recorded, so nothing is known");
        assert_eq!(t.cost, 0.0);
        assert_eq!(t.margin, 0.0, "a 100% margin here would be a lie, not a default");
    }

    /// A per-category cost override beats the lot's own, like the ask side.
    #[test]
    fn a_category_can_carry_its_own_cost() {
        let lot = vec![stack("Footwear", 100.0, 10), stack("Apparel-Top", 100.0, 10)];
        let mut p = Pricing::with_cost(0.26, 0.20);
        p.cost_overrides.insert("Apparel-Top".into(), 0.05);
        let t = lot_totals(&lot, &p);
        // 10 x $20 + 10 x $5.
        assert_eq!(t.cost, 250.0);
        let apparel = t.by_category.iter().find(|c| c.name == "Apparel-Top").unwrap();
        assert_eq!(apparel.cost, 50.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(cat: &str, msrp: f64, units: i64) -> Stack {
        Stack {
            location: "01-001-01".into(),
            r#box: String::new(),
            upc: format!("upc-{cat}-{msrp}"),
            title: format!("{cat} item {msrp}"),
            units,
            msrp,
            brand: Some("Nike".into()),
            category: Some(cat.into()),
            segment: None,
            size_us: None,
            title_risk: TitleRisk::Typed,
            upc_ambiguous: false,
        }
    }

    /// Jack's worked example: $75 off retail at 26% is $19.50 a shoe.
    #[test]
    fn seventy_five_dollars_of_retail_becomes_nineteen_fifty() {
        let p = Pricing::flat(0.26);
        assert_eq!(p.unit_price(&s("Footwear", 75.0, 1)), 19.50);
    }

    #[test]
    fn a_category_override_beats_the_global_percentage() {
        let mut p = Pricing::flat(0.26);
        p.overrides.insert("Apparel-Top".into(), 0.10);
        assert_eq!(p.unit_price(&s("Footwear", 100.0, 1)), 26.0);
        assert_eq!(p.unit_price(&s("Apparel-Top", 100.0, 1)), 10.0);
        // Matching is case-insensitive, because the category came from a dictionary and the
        // override came from a form.
        p.overrides.insert("footwear".into(), 0.30);
        assert_eq!(p.unit_price(&s("Footwear", 100.0, 1)), 30.0);
    }

    /// The line total is exactly qty x the price printed beside it — not qty x an
    /// unrounded intermediate, which would leave the manifest failing its own arithmetic.
    #[test]
    fn the_line_total_matches_the_printed_unit_price() {
        let p = Pricing::flat(0.2633);
        let st = s("Footwear", 75.0, 46);
        let unit = p.unit_price(&st);
        assert_eq!(unit, 19.75);
        assert_eq!(p.extended(&st), 19.75 * 46.0);
    }

    #[test]
    fn a_stack_with_no_retail_price_costs_nothing_rather_than_guessing() {
        let p = Pricing::flat(0.26);
        assert_eq!(p.unit_price(&s("Footwear", 0.0, 10)), 0.0);
    }

    #[test]
    fn lot_totals_reconcile_and_report_per_unit_by_category() {
        let mut p = Pricing::flat(0.26);
        p.overrides.insert("Apparel-Top".into(), 0.10);
        let stacks = vec![s("Footwear", 75.0, 100), s("Apparel-Top", 40.0, 50)];
        let t = lot_totals(&stacks, &p);

        assert_eq!(t.units, 150);
        assert_eq!(t.msrp, 75.0 * 100.0 + 40.0 * 50.0);
        assert_eq!(t.ask, 19.50 * 100.0 + 4.0 * 50.0);
        assert_eq!(t.locations, 1);
        assert_eq!(t.styles, 2);

        let foot = t.by_category.iter().find(|g| g.name == "Footwear").unwrap();
        assert_eq!(foot.per_unit, 19.50);
        let top = t.by_category.iter().find(|g| g.name == "Apparel-Top").unwrap();
        assert_eq!(top.per_unit, 4.0);

        // The blended rate is not either percentage — which is exactly why it is shown.
        assert!(t.effective_pct > 0.10 && t.effective_pct < 0.26);
        assert_eq!(t.by_brand.len(), 1);
        assert_eq!(t.by_brand[0].units, 150);
    }

    #[test]
    fn unverified_units_are_grades_two_and_three_only() {
        let mut a = s("Footwear", 10.0, 5);
        a.title_risk = TitleRisk::NamedFromBarcode;
        let mut b = s("Footwear", 10.0, 3);
        b.title_risk = TitleRisk::GuessedFromBarcode;
        b.title = "other".into();
        let mut c = s("Footwear", 10.0, 2);
        c.title_risk = TitleRisk::Unknown;
        c.title = "another".into();
        let t = lot_totals(&[a, b, c], &Pricing::flat(0.5));
        assert_eq!(t.unverified_units(), 5);
    }
}
