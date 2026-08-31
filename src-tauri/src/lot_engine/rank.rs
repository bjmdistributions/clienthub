//! The lot engine proper: a ranking over locations, plus a set of chosen ones.
//!
//! No allocation, no optimiser. The atom is the **location**, because the location is what
//! a person walks to. A SKU-level allocator answered *"give me 676 Nike"* perfectly and
//! produced a lot spread across 3,545 pick slots that nobody could pull.
//!
//! # Two filters, not one
//!
//! * **WANT** — brand, size range, MSRP range. *Ranks* slots. Excludes nothing.
//! * **ALLOW** — category, segment, described-only, brand-lock. Decides which slots
//!   **qualify at all**.
//!
//! WANT is always a subset of ALLOW. Collapsing them into one filter is wrong in both
//! directions. On *Nike + footwear* over the reference export: one unstrict filter gives
//! 4,477 slots of which 1,921 contain apparel; one strict filter gives 179, demanding 100%
//! *Nike* footwear and discarding a slot that is 95% Nike + 5% adidas; two filters strict
//! gives **2,449** — slots holding nothing but footwear, ranked by Nike content.
//!
//! `slack` is the one dial: the share of a slot allowed to violate ALLOW. Zero is strict.
//! It is the honest expression of *"I'd take a little apparel to get more volume"*.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::model::Stack;

/// What you are looking for. Ranks slots; never excludes one.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Want {
    #[serde(default)]
    pub brands: Vec<String>,
    #[serde(default)]
    pub size_min: Option<f64>,
    #[serde(default)]
    pub size_max: Option<f64>,
    #[serde(default)]
    pub msrp_min: Option<f64>,
    #[serde(default)]
    pub msrp_max: Option<f64>,
}

impl Want {
    pub fn is_set(&self) -> bool {
        !self.brands.is_empty()
            || self.size_min.is_some()
            || self.size_max.is_some()
            || self.msrp_min.is_some()
            || self.msrp_max.is_some()
    }

    fn matches(&self, s: &Stack) -> bool {
        if !self.brands.is_empty() {
            match &s.brand {
                Some(b) if self.brands.iter().any(|w| w.eq_ignore_ascii_case(b)) => {}
                _ => return false,
            }
        }
        if self.size_min.is_some() || self.size_max.is_some() {
            let Some(sz) = s.size_us else { return false };
            if let Some(lo) = self.size_min {
                if sz < lo {
                    return false;
                }
            }
            if let Some(hi) = self.size_max {
                if sz > hi {
                    return false;
                }
            }
        }
        if let Some(lo) = self.msrp_min {
            if s.msrp < lo {
                return false;
            }
        }
        if let Some(hi) = self.msrp_max {
            if s.msrp > hi {
                return false;
            }
        }
        true
    }
}

/// What a slot may contain and still qualify.
///
/// *"Only footwear"* cannot mean "filter out the apparel" — the take is all-or-nothing. It
/// has to mean *"only show slots containing nothing but footwear"*, which is what ALLOW
/// plus `slack = 0` expresses.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Allow {
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub segments: Vec<String>,
    /// Reject stock whose description was guessed or is missing.
    #[serde(default)]
    pub described_only: bool,
    /// Only these brands may appear in the slot at all.
    #[serde(default)]
    pub brand_lock: Vec<String>,
}

impl Allow {
    pub fn is_set(&self) -> bool {
        !self.categories.is_empty()
            || !self.segments.is_empty()
            || self.described_only
            || !self.brand_lock.is_empty()
    }

    fn matches(&self, s: &Stack) -> bool {
        if !self.categories.is_empty() {
            match &s.category {
                Some(c) if self.categories.iter().any(|a| a.eq_ignore_ascii_case(c)) => {}
                _ => return false,
            }
        }
        if !self.segments.is_empty() {
            match &s.segment {
                Some(g) if self.segments.iter().any(|a| a.eq_ignore_ascii_case(g)) => {}
                _ => return false,
            }
        }
        if self.described_only && !s.described() {
            return false;
        }
        if !self.brand_lock.is_empty() {
            match &s.brand {
                Some(b) if self.brand_lock.iter().any(|a| a.eq_ignore_ascii_case(b)) => {}
                _ => return false,
            }
        }
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sort {
    /// Share of the slot you want. The default — but it puts tiny slots on top.
    Concentration,
    /// Units of what you want. More volume per click, lower purity.
    Volume,
}

impl Default for Sort {
    fn default() -> Self {
        Sort::Concentration
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankOpts {
    /// Share of a slot allowed to violate ALLOW, 0.0-1.0. Zero is strict.
    #[serde(default)]
    pub slack: f64,
    #[serde(default)]
    pub sort: Sort,
    /// Sorting by concentration puts 8-unit slots on top. This is the answer to that.
    #[serde(default)]
    pub min_units: i64,
    /// The concentration floor, 0.0-1.0: the share of a slot that must be what you WANT.
    ///
    /// *"Mostly Nike, but I'll take what comes with it"* is a different request from
    /// *"nothing but Nike"*, and only this expresses it. `brand_lock` + `slack` looks like
    /// the same dial and is not: `slack` is measured against the whole of ALLOW, so a
    /// category filter and a brand lock share one allowance, and it says nothing about
    /// size or MSRP. This is measured on `pct` — the number printed on the card.
    ///
    /// Zero means no floor, which is the ranking exactly as it was. It only applies when
    /// WANT is set; with nothing wanted there is no concentration to have.
    #[serde(default)]
    pub min_pct: f64,
    /// How many slots to return. The ranking always runs over every slot; only the
    /// rendering is capped.
    #[serde(default)]
    pub limit: usize,
}

impl Default for RankOpts {
    fn default() -> Self {
        RankOpts {
            slack: 0.0,
            sort: Sort::Concentration,
            min_units: 0,
            min_pct: 0.0,
            limit: 200,
        }
    }
}

/// A brand (or category) and its units inside one slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Slice {
    pub name: String,
    pub units: i64,
}

/// One qualifying slot, with everything needed to decide **before** the click. Because the
/// take is all-or-nothing, a card that hides what else is in the slot is a card that sells
/// you a surprise.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedSlot {
    pub location: String,
    pub total: i64,
    /// Units matching ALLOW.
    pub allowed: i64,
    /// Units matching WANT (a subset of ALLOW).
    pub want: i64,
    /// Units violating ALLOW — what you take anyway.
    pub breaks: i64,
    /// `want / total`. The number on the card.
    pub pct: f64,
    pub msrp: f64,
    /// Distinct titles in the slot.
    pub styles: usize,
    /// Every brand in the slot, largest first.
    pub brands: Vec<Slice>,
    /// What you did not ask for but are taking. The single most important line on the card.
    pub comes_with: Vec<Slice>,
    pub boxes: Vec<String>,
    /// Units whose description is guessed or missing.
    pub unverified_units: i64,
}

/// The result set, plus the totals that make the trade visible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankResult {
    pub slots: Vec<RankedSlot>,
    /// Qualifying slots before `limit` was applied.
    pub matched_slots: usize,
    /// Slots considered — the pool after staged and removed were taken out.
    pub pool_slots: usize,
    /// Totals across every matching slot, not just the returned page.
    pub matched_units: i64,
    pub matched_want_units: i64,
    pub matched_msrp: f64,
    /// Units of something else per unit you wanted, across the whole match. Taking all
    /// 2,449 slots in the reference query brings 12,865 Nike inside 44,563 total — about
    /// 2.5 units of something else for every unit you wanted.
    pub tagalong_ratio: f64,
    /// Slots skipped because they broke ALLOW past `slack`.
    pub rejected_by_allow: usize,
    /// Slots skipped because they held none of what you wanted.
    pub rejected_by_want: usize,
    /// Slots skipped by `min_units`.
    pub rejected_by_size: usize,
    /// Slots skipped by `min_pct` — they hold what you want, just not enough of it.
    pub rejected_by_pct: usize,
    /// Plain words for what the current sort is costing. Ship it next to the toggle.
    pub sort_note: String,
}

fn top_slices(mut v: Vec<Slice>) -> Vec<Slice> {
    v.sort_by(|a, b| b.units.cmp(&a.units).then(a.name.cmp(&b.name)));
    v
}

fn bump(v: &mut Vec<Slice>, name: &str, units: i64) {
    if let Some(e) = v.iter_mut().find(|s| s.name == name) {
        e.units += units;
    } else {
        v.push(Slice {
            name: name.to_string(),
            units,
        });
    }
}

/// Rank every available slot.
///
/// `stacks` MUST be sorted by location — `pipeline::clean_sheet` guarantees it — so each
/// slot is a contiguous range and the whole pass is one linear walk with no grouping map.
/// That single choice is what makes re-ranking thousands of slots on every keystroke
/// imperceptible.
pub fn rank(
    stacks: &[Stack],
    want: &Want,
    allow: &Allow,
    opts: &RankOpts,
    unavailable: &HashSet<String>,
) -> RankResult {
    let want_set = want.is_set();
    let allow_set = allow.is_set();
    let slack = opts.slack.clamp(0.0, 1.0);
    let min_pct = opts.min_pct.clamp(0.0, 1.0);

    let mut slots: Vec<RankedSlot> = Vec::new();
    let mut pool_slots = 0usize;
    let mut rejected_by_allow = 0usize;
    let mut rejected_by_want = 0usize;
    let mut rejected_by_size = 0usize;
    let mut rejected_by_pct = 0usize;

    let mut i = 0usize;
    while i < stacks.len() {
        let loc = &stacks[i].location;
        let mut j = i;
        while j < stacks.len() && &stacks[j].location == loc {
            j += 1;
        }
        let group = &stacks[i..j];
        i = j;

        if unavailable.contains(loc) {
            continue;
        }
        pool_slots += 1;

        let mut total = 0i64;
        let mut allowed = 0i64;
        let mut wanted = 0i64;
        let mut msrp = 0.0f64;
        let mut unverified = 0i64;
        let mut brands: Vec<Slice> = Vec::new();
        let mut comes_with: Vec<Slice> = Vec::new();
        let mut titles: HashSet<&str> = HashSet::new();
        let mut boxes: Vec<String> = Vec::new();

        for s in group {
            total += s.units;
            msrp += s.msrp * s.units as f64;
            titles.insert(s.title.as_str());
            if !s.r#box.is_empty() && !boxes.iter().any(|b| b == &s.r#box) {
                boxes.push(s.r#box.clone());
            }
            if !s.described() {
                unverified += s.units;
            }
            let name = s.brand.as_deref().unwrap_or("Unbranded");
            bump(&mut brands, name, s.units);

            let ok_allow = !allow_set || allow.matches(s);
            if ok_allow {
                allowed += s.units;
                // WANT is a subset of ALLOW — a stack that does not qualify can never be
                // something you wanted.
                if !want_set || want.matches(s) {
                    wanted += s.units;
                } else {
                    bump(&mut comes_with, name, s.units);
                }
            } else {
                bump(&mut comes_with, name, s.units);
            }
        }

        if total <= 0 {
            continue;
        }
        let breaks = total - allowed;
        if allow_set && (breaks as f64) / (total as f64) > slack {
            rejected_by_allow += 1;
            continue;
        }
        if want_set && wanted == 0 {
            rejected_by_want += 1;
            continue;
        }
        let pct = wanted as f64 / total as f64;
        if want_set && min_pct > 0.0 && pct < min_pct {
            rejected_by_pct += 1;
            continue;
        }
        if opts.min_units > 0 && total < opts.min_units {
            rejected_by_size += 1;
            continue;
        }

        slots.push(RankedSlot {
            location: loc.clone(),
            total,
            allowed,
            want: wanted,
            breaks,
            pct,
            msrp,
            styles: titles.len(),
            brands: top_slices(brands),
            comes_with: top_slices(comes_with),
            boxes,
            unverified_units: unverified,
        });
    }

    match opts.sort {
        Sort::Concentration => slots.sort_by(|a, b| {
            b.pct
                .partial_cmp(&a.pct)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.want.cmp(&a.want))
                .then(a.location.cmp(&b.location))
        }),
        Sort::Volume => slots.sort_by(|a, b| {
            b.want
                .cmp(&a.want)
                .then(
                    b.pct
                        .partial_cmp(&a.pct)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then(a.location.cmp(&b.location))
        }),
    }

    let matched_slots = slots.len();
    let matched_units: i64 = slots.iter().map(|s| s.total).sum();
    let matched_want_units: i64 = slots.iter().map(|s| s.want).sum();
    let matched_msrp: f64 = slots.iter().map(|s| s.msrp).sum();
    let tagalong_ratio = if matched_want_units > 0 {
        (matched_units - matched_want_units) as f64 / matched_want_units as f64
    } else {
        0.0
    };

    let sort_note = sort_note(&slots, opts.sort);

    if opts.limit > 0 && slots.len() > opts.limit {
        slots.truncate(opts.limit);
    }

    RankResult {
        slots,
        matched_slots,
        pool_slots,
        matched_units,
        matched_want_units,
        matched_msrp,
        tagalong_ratio,
        rejected_by_allow,
        rejected_by_want,
        rejected_by_size,
        rejected_by_pct,
        sort_note,
    }
}

/// Say what the current sort costs, in the numbers of THIS result rather than in general.
/// Sorting by concentration puts tiny slots on top; sorting by volume gets more units from
/// the same number of clicks. Neither is wrong — but the trade should be on screen.
fn sort_note(slots: &[RankedSlot], sort: Sort) -> String {
    if slots.is_empty() {
        return String::new();
    }
    let head = slots.len().min(100);
    let by_head: i64 = slots.iter().take(head).map(|s| s.want).sum();

    let mut alt: Vec<&RankedSlot> = slots.iter().collect();
    match sort {
        Sort::Concentration => alt.sort_by(|a, b| b.want.cmp(&a.want)),
        Sort::Volume => alt.sort_by(|a, b| {
            b.pct
                .partial_cmp(&a.pct)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
    }
    let by_alt: i64 = alt.iter().take(head).map(|s| s.want).sum();

    match sort {
        Sort::Concentration => format!(
            "Sorted by concentration: the top {head} slots give {by_head} units of what you want. \
             Sorting by volume would give {by_alt} from the same {head}."
        ),
        Sort::Volume => format!(
            "Sorted by volume: the top {head} slots give {by_head} units of what you want. \
             Sorting by concentration would give {by_alt} from the same {head}, at a higher purity."
        ),
    }
}

// ---------------------------------------------------------------------------------------
// Planning several lots at once
// ---------------------------------------------------------------------------------------

/// What to aim for when cutting the pool into lots.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoPlan {
    /// Roughly how many units per lot. "Roughly" is the honest word: the atom is a whole
    /// location, so a lot closes on the first slot that reaches the target and is normally
    /// a little over. It is never split.
    #[serde(default)]
    pub target_units: i64,
    /// How many lots to cut. Zero means as many as the pool allows.
    #[serde(default)]
    pub max_lots: usize,
    /// Do not emit a final lot smaller than this. Zero means half the target — a tail of
    /// 40 units is not a lot, it is the leftover, and calling it a lot hides that.
    #[serde(default)]
    pub min_lot_units: i64,
}

impl Default for AutoPlan {
    fn default() -> Self {
        AutoPlan { target_units: 1000, max_lots: 0, min_lot_units: 0 }
    }
}

/// One lot the planner would cut. Nothing is saved until a person says so.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedLot {
    /// 1-based, in the order they were cut — lot 1 holds the best slots.
    pub index: usize,
    pub locations: Vec<String>,
    pub units: i64,
    /// Units matching WANT. `want_units / units` is the lot's own concentration.
    pub want_units: i64,
    pub pct: f64,
    pub msrp: f64,
    pub styles: usize,
    pub brands: Vec<Slice>,
    pub unverified_units: i64,
}

/// The plan, plus what it could not place.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoResult {
    pub lots: Vec<PlannedLot>,
    pub total_units: i64,
    pub total_want_units: i64,
    pub total_msrp: f64,
    /// Qualifying slots the plan did not take, and their units.
    pub leftover_slots: usize,
    pub leftover_units: i64,
    /// Plain words for what the plan did and what it left. Ship it next to the result.
    pub note: String,
}

/// Cut the qualifying pool into as many ~`target_units` lots as it allows.
///
/// This is the same ranking as [`rank`], read greedily: walk the ranked slots in order and
/// close a lot as soon as it reaches the target. Because the ranking is concentration-first
/// by default, **lot 1 gets the purest slots**, lot 2 the next best, and so on — which is
/// the order you want to sell them in.
///
/// No slot is ever in two lots: each is consumed as it is placed. Nothing here writes
/// anything — the caller shows the plan and a person decides.
///
/// A slot is never split, so a lot lands a little over the target rather than exactly on it.
/// Saying "roughly 1,000" and delivering 1,014 is honest; splitting a location to hit 1,000
/// exactly would break the one rule the whole engine is built on.
pub fn auto_lots(
    stacks: &[Stack],
    want: &Want,
    allow: &Allow,
    opts: &RankOpts,
    unavailable: &HashSet<String>,
    plan: &AutoPlan,
) -> AutoResult {
    // limit 0 — the planner needs every qualifying slot, not the rendered page.
    let all = rank(stacks, want, allow, &RankOpts { limit: 0, ..opts.clone() }, unavailable);

    let target = plan.target_units.max(1);
    let floor = if plan.min_lot_units > 0 { plan.min_lot_units } else { target / 2 };

    let mut lots: Vec<PlannedLot> = Vec::new();
    let mut cur: Vec<&RankedSlot> = Vec::new();
    let mut cur_units = 0i64;
    let mut used = 0usize;

    for s in &all.slots {
        if plan.max_lots > 0 && lots.len() >= plan.max_lots {
            break;
        }
        cur.push(s);
        cur_units += s.total;
        used += 1;
        if cur_units >= target {
            lots.push(close_lot(lots.len() + 1, &cur));
            cur.clear();
            cur_units = 0;
        }
    }
    // The tail. Only a lot if it is big enough to be worth calling one; otherwise it is
    // handed back as leftover, which is why `used` rewinds past it.
    if !cur.is_empty() {
        if cur_units >= floor && (plan.max_lots == 0 || lots.len() < plan.max_lots) {
            lots.push(close_lot(lots.len() + 1, &cur));
        } else {
            used -= cur.len();
        }
    }

    // Slots are consumed in ranked order, so everything past `used` is exactly what was
    // not placed — including a rejected tail, because `used` rewound over it above.
    let leftover_slots = all.slots.len() - used;
    let leftover_units: i64 = all.slots.iter().skip(used).map(|s| s.total).sum();

    let total_units: i64 = lots.iter().map(|l| l.units).sum();
    let total_want_units: i64 = lots.iter().map(|l| l.want_units).sum();
    let total_msrp: f64 = lots.iter().map(|l| l.msrp).sum();

    let note = if lots.is_empty() {
        "Nothing qualifies for these filters, so there is nothing to cut into lots.".to_string()
    } else {
        format!(
            "{} lots averaging {} units. A location is never split, so each lot lands a little \
             over the target rather than exactly on it. {} qualifying slots ({} units) are left \
             over — too few for another lot of this size.",
            lots.len(),
            total_units / lots.len() as i64,
            leftover_slots,
            leftover_units,
        )
    };

    AutoResult {
        lots,
        total_units,
        total_want_units,
        total_msrp,
        leftover_slots,
        leftover_units,
        note,
    }
}

fn close_lot(index: usize, slots: &[&RankedSlot]) -> PlannedLot {
    let mut brands: Vec<Slice> = Vec::new();
    let mut units = 0i64;
    let mut want_units = 0i64;
    let mut msrp = 0.0f64;
    let mut styles = 0usize;
    let mut unverified = 0i64;
    for s in slots {
        units += s.total;
        want_units += s.want;
        msrp += s.msrp;
        styles += s.styles;
        unverified += s.unverified_units;
        for b in &s.brands {
            bump(&mut brands, &b.name, b.units);
        }
    }
    PlannedLot {
        index,
        locations: slots.iter().map(|s| s.location.clone()).collect(),
        units,
        want_units,
        pct: if units > 0 { want_units as f64 / units as f64 } else { 0.0 },
        msrp,
        // Summed per slot, so this over-counts a style that sits in two slots. Named
        // "styles" rather than "products" for that reason; the saved lot's own totals come
        // from `lot_totals`, which counts distinct titles properly.
        styles,
        brands: top_slices(brands),
        unverified_units: unverified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lot_engine::model::TitleRisk;

    fn stack(loc: &str, brand: &str, cat: &str, units: i64) -> Stack {
        Stack {
            location: loc.into(),
            r#box: String::new(),
            upc: format!("{loc}-{brand}-{cat}"),
            title: format!("{brand} {cat} item"),
            units,
            msrp: 100.0,
            brand: Some(brand.into()),
            category: Some(cat.into()),
            segment: None,
            size_us: None,
            title_risk: TitleRisk::Typed,
            upc_ambiguous: false,
        }
    }

    fn sorted(mut v: Vec<Stack>) -> Vec<Stack> {
        v.sort_by(|a, b| a.location.cmp(&b.location));
        v
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    /// The spec's three-row table, reproduced. This is the test that proves WANT and ALLOW
    /// are not the same filter.
    #[test]
    fn two_filters_beat_one_in_both_directions() {
        let stacks = sorted(vec![
            // Pure Nike footwear.
            stack("01-001-01", "Nike", "Footwear", 50),
            // 95% Nike footwear + 5% adidas footwear — a slot one strict filter throws away.
            stack("02-001-01", "Nike", "Footwear", 95),
            stack("02-001-01", "adidas", "Footwear", 5),
            // Nike footwear sitting with apparel — qualifies only if apparel is tolerated.
            stack("03-001-01", "Nike", "Footwear", 60),
            stack("03-001-01", "Nike", "Apparel-Top", 40),
        ]);

        let want_nike = Want {
            brands: vec!["Nike".into()],
            ..Default::default()
        };
        let allow_footwear = Allow {
            categories: vec!["Footwear".into()],
            ..Default::default()
        };

        // One filter, no strictness: everything holding Nike, apparel included.
        let loose = rank(&stacks, &want_nike, &Allow::default(), &RankOpts::default(), &none());
        assert_eq!(loose.matched_slots, 3);

        // One filter, strict: demands 100% Nike footwear, discards the 95/5 slot.
        let one_strict = rank(
            &stacks,
            &Want::default(),
            &Allow {
                categories: vec!["Footwear".into()],
                brand_lock: vec!["Nike".into()],
                ..Default::default()
            },
            &RankOpts::default(),
            &none(),
        );
        assert_eq!(one_strict.matched_slots, 1);
        assert_eq!(one_strict.slots[0].location, "01-001-01");

        // Two filters, strict: slots holding nothing but footwear, RANKED by Nike content.
        let two = rank(&stacks, &want_nike, &allow_footwear, &RankOpts::default(), &none());
        assert_eq!(two.matched_slots, 2);
        assert_eq!(two.slots[0].location, "01-001-01");
        assert_eq!(two.slots[1].location, "02-001-01");
        assert!((two.slots[1].pct - 0.95).abs() < 1e-9);
    }

    /// *"Mostly Nike, but not only Nike."* The floor keeps the 95/5 slot that `brand_lock`
    /// throws away, and drops the one that is only 60% of what was asked for.
    #[test]
    fn a_concentration_floor_is_not_a_brand_lock() {
        let stacks = sorted(vec![
            stack("01-001-01", "Nike", "Footwear", 50),
            stack("02-001-01", "Nike", "Footwear", 95),
            stack("02-001-01", "adidas", "Footwear", 5),
            stack("03-001-01", "Nike", "Footwear", 60),
            stack("03-001-01", "adidas", "Footwear", 40),
        ]);
        let want = Want {
            brands: vec!["Nike".into()],
            ..Default::default()
        };

        let floor = rank(
            &stacks,
            &want,
            &Allow::default(),
            &RankOpts {
                min_pct: 0.9,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(floor.matched_slots, 2);
        assert_eq!(floor.rejected_by_pct, 1);
        // The 95/5 slot survives — the 5% of adidas comes with it, which is the point.
        assert_eq!(floor.slots[1].location, "02-001-01");
        assert_eq!(floor.slots[1].comes_with[0].name, "adidas");

        // A lock over the same brand would have thrown that slot away instead.
        let lock = rank(
            &stacks,
            &want,
            &Allow {
                brand_lock: vec!["Nike".into()],
                ..Default::default()
            },
            &RankOpts::default(),
            &none(),
        );
        assert_eq!(lock.matched_slots, 1);

        // A floor with nothing wanted is not a filter at all — there is no concentration.
        let no_want = rank(
            &stacks,
            &Want::default(),
            &Allow::default(),
            &RankOpts {
                min_pct: 0.9,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(no_want.matched_slots, 3);
        assert_eq!(no_want.rejected_by_pct, 0);
    }

    /// The planner cuts the pool into ~target lots, best slots first, and never puts one
    /// location in two lots.
    #[test]
    fn auto_lots_cuts_the_pool_without_overlapping() {
        // 30 locations, 100 units each — 3,000 units in the pool.
        let stacks = sorted(
            (1..=30)
                .map(|i| stack(&format!("01-{i:03}-01"), "Nike", "Footwear", 100))
                .collect(),
        );
        let want = Want { brands: vec!["Nike".into()], ..Default::default() };

        let r = auto_lots(
            &stacks,
            &want,
            &Allow::default(),
            &RankOpts::default(),
            &none(),
            &AutoPlan { target_units: 1000, ..Default::default() },
        );
        assert_eq!(r.lots.len(), 3);
        assert_eq!(r.total_units, 3000);
        assert_eq!(r.leftover_slots, 0);
        assert_eq!(r.leftover_units, 0);
        for l in &r.lots {
            assert_eq!(l.units, 1000);
            assert_eq!(l.locations.len(), 10);
        }
        // No location is in two lots — the invariant the whole engine rests on.
        let mut seen: HashSet<&str> = HashSet::new();
        for l in &r.lots {
            for loc in &l.locations {
                assert!(seen.insert(loc.as_str()), "{loc} was placed in two lots");
            }
        }
        assert_eq!(seen.len(), 30);

        // Asking for fewer lots leaves the rest in the pool rather than cramming them in.
        let two = auto_lots(
            &stacks,
            &want,
            &Allow::default(),
            &RankOpts::default(),
            &none(),
            &AutoPlan { target_units: 1000, max_lots: 2, ..Default::default() },
        );
        assert_eq!(two.lots.len(), 2);
        assert_eq!(two.total_units, 2000);
        assert_eq!(two.leftover_slots, 10);
        assert_eq!(two.leftover_units, 1000);

        // A tail below the floor is leftover, not a lot pretending to be one. Stated
        // explicitly rather than leaning on the default floor: at target 2000 the default
        // floor is exactly 1000 and the 1,000-unit tail would qualify.
        let tail = auto_lots(
            &stacks,
            &want,
            &Allow::default(),
            &RankOpts::default(),
            &none(),
            &AutoPlan { target_units: 2000, min_lot_units: 1500, max_lots: 0 },
        );
        assert_eq!(tail.lots.len(), 1, "2,000 fits once and the 1,000 tail is under the floor");
        assert_eq!(tail.leftover_slots, 10);
        assert_eq!(tail.leftover_units, 1000);
    }

    /// Slack is the honest expression of "I'd take a little apparel to get more volume".
    #[test]
    fn slack_admits_a_slot_that_breaks_allow_a_little() {
        let stacks = sorted(vec![
            stack("03-001-01", "Nike", "Footwear", 60),
            stack("03-001-01", "Nike", "Apparel-Top", 40),
        ]);
        let want = Want {
            brands: vec!["Nike".into()],
            ..Default::default()
        };
        let allow = Allow {
            categories: vec!["Footwear".into()],
            ..Default::default()
        };
        let strict = rank(&stacks, &want, &allow, &RankOpts::default(), &none());
        assert_eq!(strict.matched_slots, 0);
        assert_eq!(strict.rejected_by_allow, 1);

        let slack = rank(
            &stacks,
            &want,
            &allow,
            &RankOpts {
                slack: 0.5,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(slack.matched_slots, 1);
        assert_eq!(slack.slots[0].breaks, 40);
    }

    /// The single most important element in the interface.
    #[test]
    fn the_comes_with_line_names_what_you_did_not_ask_for() {
        let stacks = sorted(vec![
            stack("43-127-04A", "Nike", "Footwear", 46),
            stack("43-127-04A", "New Balance", "Footwear", 2),
        ]);
        let r = rank(
            &stacks,
            &Want {
                brands: vec!["Nike".into()],
                ..Default::default()
            },
            &Allow::default(),
            &RankOpts::default(),
            &none(),
        );
        let s = &r.slots[0];
        assert_eq!(s.total, 48);
        assert_eq!(s.want, 46);
        assert_eq!(s.styles, 2);
        assert_eq!(s.comes_with.len(), 1);
        assert_eq!(s.comes_with[0].name, "New Balance");
        assert_eq!(s.comes_with[0].units, 2);
        assert!((s.pct - 46.0 / 48.0).abs() < 1e-9);
    }

    #[test]
    fn the_tagalong_ratio_is_reported_across_the_whole_match() {
        let stacks = sorted(vec![
            stack("01-001-01", "Nike", "Footwear", 100),
            stack("01-001-01", "adidas", "Footwear", 250),
        ]);
        let r = rank(
            &stacks,
            &Want {
                brands: vec!["Nike".into()],
                ..Default::default()
            },
            &Allow::default(),
            &RankOpts::default(),
            &none(),
        );
        assert_eq!(r.matched_units, 350);
        assert_eq!(r.matched_want_units, 100);
        assert!((r.tagalong_ratio - 2.5).abs() < 1e-9);
    }

    /// Concentration puts tiny slots first; volume puts big ones first. Both orderings are
    /// available and the note says what the current one costs.
    #[test]
    fn the_two_sorts_disagree_and_say_so() {
        let stacks = sorted(vec![
            stack("01-001-01", "Nike", "Footwear", 8),
            stack("02-001-01", "Nike", "Footwear", 400),
            stack("02-001-01", "adidas", "Footwear", 100),
        ]);
        let want = Want {
            brands: vec!["Nike".into()],
            ..Default::default()
        };
        let conc = rank(&stacks, &want, &Allow::default(), &RankOpts::default(), &none());
        assert_eq!(conc.slots[0].location, "01-001-01");
        assert!(conc.sort_note.contains("concentration"));

        let vol = rank(
            &stacks,
            &want,
            &Allow::default(),
            &RankOpts {
                sort: Sort::Volume,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(vol.slots[0].location, "02-001-01");
        assert!(vol.sort_note.contains("volume"));
    }

    /// The answer to concentration's small-slot problem.
    #[test]
    fn min_units_removes_the_tiny_slots() {
        let stacks = sorted(vec![
            stack("01-001-01", "Nike", "Footwear", 8),
            stack("02-001-01", "Nike", "Footwear", 400),
        ]);
        let r = rank(
            &stacks,
            &Want {
                brands: vec!["Nike".into()],
                ..Default::default()
            },
            &Allow::default(),
            &RankOpts {
                min_units: 50,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(r.matched_slots, 1);
        assert_eq!(r.rejected_by_size, 1);
    }

    /// Staged and removed slots leave the pool immediately, so a later search only shows
    /// what is still unclaimed.
    #[test]
    fn staged_and_removed_slots_leave_the_pool() {
        let stacks = sorted(vec![
            stack("01-001-01", "Nike", "Footwear", 10),
            stack("02-001-01", "Nike", "Footwear", 10),
        ]);
        let mut gone = HashSet::new();
        gone.insert("01-001-01".to_string());
        let r = rank(
            &stacks,
            &Want::default(),
            &Allow::default(),
            &RankOpts::default(),
            &gone,
        );
        assert_eq!(r.pool_slots, 1);
        assert_eq!(r.matched_slots, 1);
        assert_eq!(r.slots[0].location, "02-001-01");
    }

    /// With no WANT set, concentration means "share of the slot that qualifies", so the
    /// ranking is still meaningful rather than uniformly zero.
    #[test]
    fn an_empty_want_ranks_by_qualifying_share() {
        let stacks = sorted(vec![
            stack("01-001-01", "Nike", "Footwear", 10),
            stack("02-001-01", "Nike", "Footwear", 5),
            stack("02-001-01", "Nike", "Apparel-Top", 5),
        ]);
        let r = rank(
            &stacks,
            &Want::default(),
            &Allow {
                categories: vec!["Footwear".into()],
                ..Default::default()
            },
            &RankOpts {
                slack: 1.0,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(r.slots[0].location, "01-001-01");
        assert!((r.slots[0].pct - 1.0).abs() < 1e-9);
        assert!((r.slots[1].pct - 0.5).abs() < 1e-9);
    }

    /// Described-only is an ALLOW rule: it decides whether the slot qualifies, because you
    /// cannot take half a slot.
    #[test]
    fn described_only_qualifies_the_slot_not_the_line() {
        let mut guessed = stack("01-001-01", "Nike", "Footwear", 5);
        guessed.title_risk = TitleRisk::Unknown;
        let stacks = sorted(vec![stack("01-001-01", "Nike", "Footwear", 45), guessed]);
        let strict = rank(
            &stacks,
            &Want::default(),
            &Allow {
                described_only: true,
                ..Default::default()
            },
            &RankOpts::default(),
            &none(),
        );
        assert_eq!(strict.matched_slots, 0);

        let tolerant = rank(
            &stacks,
            &Want::default(),
            &Allow {
                described_only: true,
                ..Default::default()
            },
            &RankOpts {
                slack: 0.1,
                ..Default::default()
            },
            &none(),
        );
        assert_eq!(tolerant.matched_slots, 1);
        assert_eq!(tolerant.slots[0].unverified_units, 5);
    }
}
