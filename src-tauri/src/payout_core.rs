//! Who gets paid what from a deal (R-577): the rep cut(s), the logistics pay, and the owners'
//! split of what is left, as lines that add up to the deal's net profit to the cent.
//!
//! BYTE-IDENTICAL in two places: BUSINESS APP `src-tauri/src/payout_core.rs` and clienthub-api
//! `src/routes/payout_core.rs`. It uses nothing from either crate (no `use crate::`), so the
//! desktop, the server and the phone (which shows what the server returns) can never work out a
//! commission differently. Edit one, copy it over, and run the tests in both repos.
//!
//! The waterfall, in this order and nowhere else:
//!   net profit, less any refund
//!   less each rep's cut (each rep's own rule applied to their share of the deal)
//!   less the logistics pay (worked out by the logistics engine, passed in as a figure)
//!   = the owners' pool, split by the owner percentages.
//!
//! A rep's rule is what they earn on a deal that is all theirs. On a split deal they earn it on
//! their share: 10% of profit at a 60% share is 10% of 60% of the profit, and "$200 a deal" at a
//! 50% share is $100. A percentage of profit is never below zero (a rep does not owe on a loss);
//! a fixed amount is paid in full on a loss.
//!
//! Any line can be typed over, and a typed amount stays what was typed when the deal changes
//! later (a refund then falls on the lines that were not typed). A typed rep or logistics line
//! changes the pool; a typed owner line takes its amount and the rest of the pool is split between
//! the owners not typed. Whatever no line takes (no owners set up, or every owner typed) is
//! reported as `unallocated`, never dropped.
//!
//! Money is worked in whole cents, and every split (reps' shares of the deal, the owners' pool)
//! is by largest remainder, so the parts always add up to the whole exactly.
//!
//! A deal's lines are written once, when it completes. Anything that changes the deal later (a
//! refund, a typed amount, a rep added) is booked as the difference: `adjustments` compares what
//! is already booked with the new lines, so a rep paid in October shows a minus line on the next
//! payout instead of October changing.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// No amount the engine takes may be larger than this many dollars either way. It keeps every
/// sum of cents far inside an i64.
pub const MAX_MONEY: f64 = 1_000_000_000_000.0;

/// How a rep is paid on a deal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayType {
    /// A percentage of the deal's net profit. Never below zero: a rep does not owe on a loss.
    ProfitPct,
    /// A percentage of the sale (gross).
    GrossPct,
    /// A flat amount a deal, paid in full even on a loss.
    Fixed,
}

impl PayType {
    /// The pay type from what `staff_accounts.pay_type` holds. Anything else, empty included, is
    /// a percentage of profit, as it always has been.
    pub fn from_stored(s: &str) -> PayType {
        match s.trim() {
            "gross_pct" => PayType::GrossPct,
            "fixed" => PayType::Fixed,
            _ => PayType::ProfitPct,
        }
    }
}

/// A rep's pay rule: the type and its figure (a percent for the two percentage types, dollars
/// for `Fixed`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub pay_type: PayType,
    pub value: f64,
}

impl Rule {
    /// The rule in plain words, as every screen shows it: "10% of profit", "5% of the sale",
    /// "$200 a deal".
    pub fn label(&self) -> String {
        match self.pay_type {
            PayType::ProfitPct => format!("{}% of profit", plain_number(self.value)),
            PayType::GrossPct => format!("{}% of the sale", plain_number(self.value)),
            PayType::Fixed => format!("{} a deal", dollars(self.value)),
        }
    }

    /// Why this rule cannot be used, in words a person can act on. The screens that save a rule
    /// call this too, so a rule that is saved always works.
    pub fn check(&self) -> Result<(), String> {
        if !self.value.is_finite() {
            return Err("A pay rule needs a number.".into());
        }
        match self.pay_type {
            PayType::ProfitPct | PayType::GrossPct if !(0.0..=100.0).contains(&self.value) => {
                Err(format!("A percentage must be between 0 and 100, not {}.", plain_number(self.value)))
            }
            PayType::Fixed if self.value < 0.0 => Err("A fixed amount cannot be below $0.".into()),
            PayType::Fixed if self.value > MAX_MONEY => Err("That fixed amount is too large.".into()),
            _ => Ok(()),
        }
    }
}

/// A rule and the day it starts to apply (YYYY-MM-DD). A person's rules are kept as a list of
/// these, so changing a rate changes deals completed from that day on and never the ones before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatedRule {
    pub from: String,
    pub rule: Rule,
}

/// True for a day written YYYY-MM-DD.
pub fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// The rule in force on `day`: the latest one starting on or before it. When two start the same
/// day, the later one in the list wins. Only the first ten characters of each date are compared,
/// so a timestamp counts as its day. None when every rule starts after `day`: the person had no
/// rule then, and earns nothing on that deal. (When a person's first rule is recorded for deals
/// already done, it is dated from before them.)
pub fn rule_on(history: &[DatedRule], day: &str) -> Option<Rule> {
    let day = day_of(day);
    let mut best: Option<&DatedRule> = None;
    for d in history {
        if day_of(&d.from) <= day && best.map_or(true, |b| day_of(&d.from) >= day_of(&b.from)) {
            best = Some(d);
        }
    }
    best.map(|d| d.rule)
}

fn day_of(s: &str) -> &str {
    s.get(..10).unwrap_or(s)
}

/// Who a line pays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayeeKind {
    Rep,
    Logistics,
    Owner,
    Business,
}

/// A rep on a deal. Two reps split a deal by `share_pct` (60 and 40); one rep alone is 100.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepOnDeal {
    pub payee_id: String,
    pub name: String,
    pub share_pct: f64,
    pub rule: Rule,
}

/// The logistics pay on a deal, already worked out by the logistics engine. It can be below zero
/// (on a loss load the logistics person can carry a share of the loss), which raises the pool.
/// `pending` is a pay not known yet (the carrier's charge is not in); its line is $0 and says so.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogisticsOnDeal {
    pub payee_id: String,
    pub name: String,
    pub amount: f64,
    #[serde(default)]
    pub pending: bool,
}

/// One entry of the owner split: a person, the business, an investment. The percentages add to
/// 100. `is_business` decides who keeps a deal the business keeps; `kind` (person, business,
/// investment, other) is carried onto the line so the screens can group by it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnerShare {
    pub payee_id: String,
    pub name: String,
    pub pct: f64,
    pub is_business: bool,
    #[serde(default)]
    pub kind: String,
}

/// The owner split from the `profit_split_json` setting (or a deal's `payout_recipients`):
/// `[{id?, name, pct, is_business, kind?}]`. A row with no name that is not the business is
/// skipped; a business row with no name is called "Business"; a missing kind is "business" or
/// "person". An entry's `payee_id` is its `id` when it has one, otherwise made from its name
/// ("growth-fund"), with "-2", "-3" for a second and third of the same name, so the same list
/// gives the same ids on every device and reordering the list never moves money between people.
pub fn owners_from_split_json(arr: &[Value]) -> Vec<OwnerShare> {
    let mut used: HashMap<String, usize> = HashMap::new();
    arr.iter().filter_map(|e| {
        let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let pct = e.get("pct").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let is_business = e.get("is_business").and_then(|x| x.as_bool()).unwrap_or(false);
        if name.is_empty() && !is_business {
            return None;
        }
        let name = if name.is_empty() { "Business".to_string() } else { name };
        let kind = e.get("kind").and_then(|x| x.as_str()).filter(|k| !k.is_empty()).map(|k| k.to_string())
            .unwrap_or_else(|| if is_business { "business".into() } else { "person".into() });
        let given = e.get("id").and_then(|x| x.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
        let base = given.map(|s| s.to_string()).unwrap_or_else(|| slug(&name));
        let n = used.entry(base.clone()).or_insert(0);
        *n += 1;
        let payee_id = if *n == 1 { base } else { format!("{base}-{n}") };
        Some(OwnerShare { payee_id, name, pct, is_business, kind })
    }).collect()
}

/// An amount typed over a line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Typed {
    pub kind: PayeeKind,
    pub payee_id: String,
    pub amount: f64,
}

/// Everything the engine needs about one deal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DealPayoutInput {
    /// The sale, what the buyer paid.
    pub gross: f64,
    /// The net profit after every cost, a partner's cut included, before any refund.
    pub net: f64,
    /// Money refunded to the buyer. It comes off both the sale and the profit.
    #[serde(default)]
    pub refunded: f64,
    #[serde(default)]
    pub reps: Vec<RepOnDeal>,
    #[serde(default)]
    pub logistics: Option<LogisticsOnDeal>,
    #[serde(default)]
    pub owners: Vec<OwnerShare>,
    /// True: the pool is split by the owner percentages. False: the business keeps the pool
    /// (shared by the business entries' percentages, or equally when those are 0; when no entry
    /// is the business, it is split by the percentages after all).
    pub owners_included: bool,
    #[serde(default)]
    pub typed: Vec<Typed>,
}

/// One line of a deal's payouts. It says everything about itself, so a stored line never needs
/// today's rules to be explained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PayoutLine {
    pub kind: PayeeKind,
    pub payee_id: String,
    pub name: String,
    /// In plain words: the rule for a rep ("10% of profit"), the percentage for an owner
    /// ("40%"); None for logistics.
    pub rule: Option<String>,
    /// A rep's rule as applied.
    pub applied: Option<Rule>,
    /// A rep's share of the deal, or an owner's percentage of the pool.
    pub share_pct: Option<f64>,
    /// An owner entry's kind: person, business, investment, other.
    pub split_kind: Option<String>,
    /// The figure the rule was applied to: the rep's share of the profit or the sale (for a fixed
    /// rule, the fixed amount), the pool for an owner, the logistics figure for logistics.
    pub basis: f64,
    /// What the rule works out to.
    pub computed: f64,
    /// What is paid: `computed`, or the typed amount.
    pub amount: f64,
    pub typed: bool,
    /// Logistics pay not known yet.
    pub pending: bool,
}

/// A deal's payouts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DealPayout {
    /// The sale less any refund.
    pub gross: f64,
    /// The net profit less any refund.
    pub net: f64,
    /// Net less the rep and logistics lines.
    pub pool: f64,
    pub lines: Vec<PayoutLine>,
    /// Net less every line. 0 unless no owner split is set up or every owner line is typed.
    pub unallocated: f64,
}

/// Work out a deal's payout lines.
pub fn deal_payout(input: &DealPayoutInput) -> Result<DealPayout, String> {
    check_input(input)?;
    let typed: HashMap<(PayeeKind, &str), i64> =
        input.typed.iter().map(|t| ((t.kind, t.payee_id.as_str()), cents(t.amount))).collect();
    let refunded_c = cents(input.refunded);
    let net_c = cents(input.net) - refunded_c;
    let gross_c = cents(input.gross) - refunded_c;
    let mut lines = Vec::new();

    let shares: Vec<f64> = input.reps.iter().map(|r| r.share_pct).collect();
    let net_parts = split_cents(net_c, &shares);
    let gross_parts = split_cents(gross_c, &shares);
    for (i, r) in input.reps.iter().enumerate() {
        let (basis_c, computed_c) = match r.rule.pay_type {
            PayType::ProfitPct => (net_parts[i], pct_of(net_parts[i].max(0), r.rule.value)),
            PayType::GrossPct => (gross_parts[i], pct_of(gross_parts[i].max(0), r.rule.value)),
            PayType::Fixed => {
                let b = cents(r.rule.value);
                (b, if shares.len() == 1 { b } else { pct_of(b, r.share_pct) })
            }
        };
        let t = typed.get(&(PayeeKind::Rep, r.payee_id.as_str())).copied();
        lines.push(PayoutLine {
            kind: PayeeKind::Rep,
            payee_id: r.payee_id.clone(),
            name: r.name.clone(),
            rule: Some(r.rule.label()),
            applied: Some(r.rule),
            share_pct: Some(r.share_pct),
            split_kind: None,
            basis: dollars_of(basis_c),
            computed: dollars_of(computed_c),
            amount: dollars_of(t.unwrap_or(computed_c)),
            typed: t.is_some(),
            pending: false,
        });
    }

    if let Some(l) = &input.logistics {
        let c = if l.pending { 0 } else { cents(l.amount) };
        let t = typed.get(&(PayeeKind::Logistics, l.payee_id.as_str())).copied();
        lines.push(PayoutLine {
            kind: PayeeKind::Logistics,
            payee_id: l.payee_id.clone(),
            name: l.name.clone(),
            rule: None,
            applied: None,
            share_pct: None,
            split_kind: None,
            basis: dollars_of(c),
            computed: dollars_of(c),
            amount: dollars_of(t.unwrap_or(c)),
            typed: t.is_some(),
            pending: l.pending && t.is_none(),
        });
    }

    let pool_c = net_c - lines.iter().map(|l| cents(l.amount)).sum::<i64>();

    if !input.owners.is_empty() {
        let any_biz = input.owners.iter().any(|o| o.is_business);
        let biz_pct: f64 = input.owners.iter().filter(|o| o.is_business).map(|o| o.pct).sum();
        // What each owner's slice of the pool is weighed by.
        let weights: Vec<f64> = input.owners.iter().map(|o| {
            if input.owners_included || !any_biz {
                o.pct
            } else if !o.is_business {
                0.0
            } else if biz_pct > 0.0 {
                o.pct
            } else {
                1.0
            }
        }).collect();
        let total_w: f64 = weights.iter().sum();
        let computed = split_cents(pool_c, &weights);
        let typed_amt: Vec<Option<i64>> = input.owners.iter()
            .map(|o| typed.get(&(owner_kind(o), o.payee_id.as_str())).copied()).collect();
        let typed_sum: i64 = typed_amt.iter().flatten().sum();
        let free_w: Vec<f64> = weights.iter().zip(&typed_amt).map(|(w, t)| if t.is_some() { 0.0 } else { *w }).collect();
        let free = split_cents(pool_c - typed_sum, &free_w);
        for (i, o) in input.owners.iter().enumerate() {
            let rule = if input.owners_included || !any_biz {
                format!("{}%", plain_number(o.pct))
            } else if o.is_business && total_w > 0.0 {
                format!("{}% (business keeps this deal)", plain_number(weights[i] / total_w * 100.0))
            } else {
                "0% (business keeps this deal)".into()
            };
            lines.push(PayoutLine {
                kind: owner_kind(o),
                payee_id: o.payee_id.clone(),
                name: o.name.clone(),
                rule: Some(rule),
                applied: None,
                share_pct: Some(o.pct),
                split_kind: Some(owner_split_kind(o)),
                basis: dollars_of(pool_c),
                computed: dollars_of(computed[i]),
                amount: dollars_of(typed_amt[i].unwrap_or(free[i])),
                typed: typed_amt[i].is_some(),
                pending: false,
            });
        }
    }

    let booked: i64 = lines.iter().map(|l| cents(l.amount)).sum();
    Ok(DealPayout {
        gross: dollars_of(gross_c),
        net: dollars_of(net_c),
        pool: dollars_of(pool_c),
        lines,
        unallocated: dollars_of(net_c - booked),
    })
}

/// A line already booked against a deal: the earned line from completion, or a later adjustment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Booked {
    pub kind: PayeeKind,
    pub payee_id: String,
    pub name: String,
    pub amount: f64,
}

/// What to book so a deal's lines come to `target`: for each payee, the target less everything
/// booked so far. Each returned line is the target's line (its rule, share and basis as they are
/// now) with `amount` set to the difference; the caller stamps why (the refund, the edit). Payees
/// no longer on the deal (a rep taken off) get their booked total back as a minus line with no
/// rule. Zero differences are left out. An owner entry that became the business (or stopped
/// being it) is the same payee, so the flip alone books nothing. Order: the target's lines, then
/// removed payees in the order first booked.
pub fn adjustments(booked: &[Booked], target: &DealPayout) -> Vec<PayoutLine> {
    let mut so_far: HashMap<(PayeeKind, &str), i64> = HashMap::new();
    let mut first_seen: Vec<&Booked> = Vec::new();
    for b in booked {
        let key = (slot(b.kind), b.payee_id.as_str());
        if !so_far.contains_key(&key) {
            first_seen.push(b);
        }
        *so_far.entry(key).or_insert(0) += cents(b.amount);
    }
    let mut out = Vec::new();
    for l in &target.lines {
        let had = so_far.remove(&(slot(l.kind), l.payee_id.as_str())).unwrap_or(0);
        let diff = cents(l.amount) - had;
        if diff != 0 {
            out.push(PayoutLine { amount: dollars_of(diff), ..l.clone() });
        }
    }
    for b in first_seen {
        if let Some(had) = so_far.remove(&(slot(b.kind), b.payee_id.as_str())) {
            if had != 0 {
                out.push(PayoutLine {
                    kind: b.kind,
                    payee_id: b.payee_id.clone(),
                    name: b.name.clone(),
                    rule: None,
                    applied: None,
                    share_pct: None,
                    split_kind: None,
                    basis: 0.0,
                    computed: 0.0,
                    amount: dollars_of(-had),
                    typed: false,
                    pending: false,
                });
            }
        }
    }
    out
}

/// Owners and the business are one set of payees: an entry can move between them.
fn slot(kind: PayeeKind) -> PayeeKind {
    if kind == PayeeKind::Business { PayeeKind::Owner } else { kind }
}

fn check_input(input: &DealPayoutInput) -> Result<(), String> {
    for x in [input.gross, input.net, input.refunded] {
        if !money_ok(x) {
            return Err("The deal's sale, profit and refund must be numbers.".into());
        }
    }
    if input.refunded < 0.0 {
        return Err("A refund cannot be below $0.".into());
    }
    let mut seen: Vec<(PayeeKind, &str)> = Vec::new();
    if !input.reps.is_empty() {
        let mut shares = 0.0;
        for r in &input.reps {
            r.rule.check().map_err(|e| format!("{}: {}", r.name, e))?;
            if !r.share_pct.is_finite() || r.share_pct <= 0.0 {
                return Err(format!("{}'s share of the deal must be above 0%.", r.name));
            }
            shares += r.share_pct;
            if seen.contains(&(PayeeKind::Rep, r.payee_id.as_str())) {
                return Err(format!("{} is on the deal twice.", r.name));
            }
            seen.push((PayeeKind::Rep, r.payee_id.as_str()));
        }
        if !adds_to_100(shares) {
            return Err(format!("The reps' shares must add up to 100%, not {}%.", plain_number(shares)));
        }
    }
    if let Some(l) = &input.logistics {
        if !money_ok(l.amount) {
            return Err("The logistics pay must be a number.".into());
        }
        seen.push((PayeeKind::Logistics, l.payee_id.as_str()));
    }
    if !input.owners.is_empty() {
        let mut total = 0.0;
        for o in &input.owners {
            if !o.pct.is_finite() || o.pct < 0.0 {
                return Err(format!("{}'s share of the split cannot be below 0%.", o.name));
            }
            total += o.pct;
            let key = (owner_kind(o), o.payee_id.as_str());
            if seen.iter().any(|(k, id)| slot(*k) == slot(key.0) && *id == key.1) {
                return Err(format!("{} is in the split twice.", o.name));
            }
            seen.push(key);
        }
        if !adds_to_100(total) {
            return Err(format!("The split must add up to 100%, not {}%.", plain_number(total)));
        }
    }
    let mut typed_seen: Vec<(PayeeKind, &str)> = Vec::new();
    for t in &input.typed {
        if !money_ok(t.amount) {
            return Err("A typed amount must be a number.".into());
        }
        let key = (t.kind, t.payee_id.as_str());
        if !seen.contains(&key) {
            let who = match t.kind {
                PayeeKind::Rep => "a rep",
                PayeeKind::Logistics => "a logistics person",
                PayeeKind::Owner | PayeeKind::Business => "an owner",
            };
            return Err(format!("An amount was typed for {who} who is not on this deal."));
        }
        if typed_seen.contains(&key) {
            return Err("Two amounts were typed for the same line.".into());
        }
        typed_seen.push(key);
    }
    Ok(())
}

fn money_ok(x: f64) -> bool {
    x.is_finite() && x.abs() <= MAX_MONEY
}

/// Percentages typed to two places (33.33 three times) count as 100.
fn adds_to_100(total: f64) -> bool {
    (total - 100.0).abs() <= 0.01 + 1e-9
}

fn owner_kind(o: &OwnerShare) -> PayeeKind {
    if o.is_business { PayeeKind::Business } else { PayeeKind::Owner }
}

fn owner_split_kind(o: &OwnerShare) -> String {
    if !o.kind.is_empty() {
        o.kind.clone()
    } else if o.is_business {
        "business".into()
    } else {
        "person".into()
    }
}

/// "Growth Fund" -> "growth-fund".
fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_alphanumeric() {
            s.push(c);
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { "entry".into() } else { s }
}

/// Round half away from zero, nudged so a figure like 940.4999999999 (9.405 dollars in floating
/// point) rounds as the 940.5 it stands for.
fn round_c(x: f64) -> i64 {
    (x + x.signum() * 1e-6).round() as i64
}

/// Whole cents from dollars.
fn cents(x: f64) -> i64 {
    round_c(x * 100.0)
}

fn dollars_of(c: i64) -> f64 {
    c as f64 / 100.0
}

/// `pct` percent of `c` cents, to the nearest cent.
fn pct_of(c: i64, pct: f64) -> i64 {
    round_c(c as f64 * pct / 100.0)
}

/// Split `total` cents by `weights` so the parts sum to `total` exactly: each part is rounded
/// down, and the cents left over go one each to the parts with the largest remainders (the
/// earlier part on a tie). Works the same for a negative total (a loss is shared the same way).
/// All weights 0: every part is 0. Weights are taken to a millionth of a percent and the split is
/// done in whole numbers, so no float rounding can put the sum a cent out.
fn split_cents(total: i64, weights: &[f64]) -> Vec<i64> {
    let w: Vec<i128> = weights.iter().map(|x| (x.max(0.0) * 1_000_000.0).round() as i128).collect();
    let w_sum: i128 = w.iter().sum();
    if w_sum == 0 {
        return vec![0; weights.len()];
    }
    let t = total as i128;
    let mut parts: Vec<i128> = w.iter().map(|wi| (t * wi).div_euclid(w_sum)).collect();
    let rems: Vec<i128> = w.iter().map(|wi| (t * wi).rem_euclid(w_sum)).collect();
    let left = t - parts.iter().sum::<i128>();
    let mut order: Vec<usize> = (0..w.len()).filter(|&i| w[i] > 0).collect();
    order.sort_by(|&a, &b| rems[b].cmp(&rems[a]).then(a.cmp(&b)));
    // Each part was rounded down by less than a cent, so fewer cents are left than there are
    // parts with weight.
    for &i in order.iter().take(left as usize) {
        parts[i] += 1;
    }
    parts.into_iter().map(|p| p as i64).collect()
}

/// 10 -> "10", 7.5 -> "7.5", 33.333333 -> "33.33".
fn plain_number(x: f64) -> String {
    let s = format!("{:.2}", x);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// 200 -> "$200", 1250.5 -> "$1,250.50". Every screen and note writes money this way.
pub fn dollars(x: f64) -> String {
    let c = cents(x.clamp(-MAX_MONEY, MAX_MONEY)).abs();
    let whole = (c / 100).to_string();
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let sign = if x < 0.0 && c != 0 { "-" } else { "" };
    if c % 100 == 0 { format!("{sign}${grouped}") } else { format!("{sign}${grouped}.{:02}", c % 100) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rep(id: &str, share: f64, pay_type: PayType, value: f64) -> RepOnDeal {
        RepOnDeal { payee_id: id.into(), name: id.into(), share_pct: share, rule: Rule { pay_type, value } }
    }
    fn owner(id: &str, pct: f64, is_business: bool) -> OwnerShare {
        OwnerShare { payee_id: id.into(), name: id.into(), pct, is_business, kind: String::new() }
    }
    fn deal(gross: f64, net: f64) -> DealPayoutInput {
        DealPayoutInput { gross, net, refunded: 0.0, reps: vec![], logistics: None, owners: vec![], owners_included: true, typed: vec![] }
    }
    fn logistics(amount: f64, pending: bool) -> Option<LogisticsOnDeal> {
        Some(LogisticsOnDeal { payee_id: "lg".into(), name: "Logistics".into(), amount, pending })
    }
    fn amount(p: &DealPayout, id: &str) -> f64 {
        p.lines.iter().find(|l| l.payee_id == id).map(|l| l.amount).unwrap()
    }
    fn total(p: &DealPayout) -> i64 {
        p.lines.iter().map(|l| cents(l.amount)).sum::<i64>() + cents(p.unallocated)
    }
    fn book(lines: &[PayoutLine]) -> Vec<Booked> {
        lines.iter().map(|l| Booked { kind: l.kind, payee_id: l.payee_id.clone(), name: l.name.clone(), amount: l.amount }).collect()
    }

    #[test]
    fn the_waterfall_takes_the_rep_and_logistics_off_before_the_owners_split() {
        // The deal from the R-577 diagnosis: three screens showed three different owner splits.
        let mut d = deal(20_000.0, 3_650.0);
        d.reps = vec![rep("sam", 100.0, PayType::ProfitPct, 10.0)];
        d.logistics = logistics(150.0, false);
        d.owners = vec![owner("a", 60.0, false), owner("b", 40.0, false)];
        let p = deal_payout(&d).unwrap();
        assert_eq!(amount(&p, "sam"), 365.0);
        assert_eq!(amount(&p, "lg"), 150.0);
        assert_eq!(p.pool, 3_135.0);
        assert_eq!(amount(&p, "a"), 1_881.0);
        assert_eq!(amount(&p, "b"), 1_254.0);
        assert_eq!(p.unallocated, 0.0);
        assert_eq!(p.lines[0].rule.as_deref(), Some("10% of profit"));
        assert_eq!(p.lines[0].applied, Some(Rule { pay_type: PayType::ProfitPct, value: 10.0 }));
        assert_eq!(p.lines[2].rule.as_deref(), Some("60%"));
        assert_eq!(p.lines[2].split_kind.as_deref(), Some("person"));
    }

    #[test]
    fn split_reps_each_apply_their_own_rule_to_their_share() {
        let mut d = deal(10_000.0, 1_000.0);
        d.reps = vec![rep("ann", 60.0, PayType::ProfitPct, 10.0), rep("bo", 40.0, PayType::GrossPct, 1.0)];
        d.owners = vec![owner("biz", 100.0, true)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((p.lines[0].basis, amount(&p, "ann")), (600.0, 60.0));
        assert_eq!((p.lines[1].basis, amount(&p, "bo")), (4_000.0, 40.0));
        assert_eq!(amount(&p, "biz"), 900.0);
    }

    #[test]
    fn split_reps_share_an_odd_cent_without_losing_it() {
        let mut d = deal(0.01, 0.01);
        d.reps = vec![rep("a", 100.0 / 3.0, PayType::ProfitPct, 100.0), rep("b", 100.0 / 3.0, PayType::ProfitPct, 100.0), rep("c", 100.0 / 3.0, PayType::ProfitPct, 100.0)];
        let p = deal_payout(&d).unwrap();
        let bases: i64 = p.lines.iter().map(|l| cents(l.basis)).sum();
        assert_eq!(bases, 1);
        assert_eq!(total(&p), 1);
        let mut d = deal(1_000.0, 100.01);
        d.reps = vec![rep("a", 50.0, PayType::ProfitPct, 100.0), rep("b", 50.0, PayType::ProfitPct, 100.0)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((amount(&p, "a"), amount(&p, "b")), (50.01, 50.0));
    }

    #[test]
    fn a_fixed_rep_is_paid_in_full_on_a_loss_and_split_by_share() {
        let mut d = deal(5_000.0, -500.0);
        d.reps = vec![rep("ann", 50.0, PayType::Fixed, 200.0), rep("bo", 50.0, PayType::Fixed, 300.0)];
        d.owners = vec![owner("a", 50.0, false), owner("b", 50.0, false)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((p.lines[0].basis, amount(&p, "ann")), (200.0, 100.0));
        assert_eq!(amount(&p, "bo"), 150.0);
        assert_eq!(p.pool, -750.0);
        assert_eq!(amount(&p, "a"), -375.0);
        assert_eq!(amount(&p, "b"), -375.0);
        assert_eq!(total(&p), cents(-500.0));
    }

    #[test]
    fn a_profit_rep_gets_nothing_on_a_loss_but_a_sale_rep_still_does() {
        let mut d = deal(5_000.0, -500.0);
        d.reps = vec![rep("p", 50.0, PayType::ProfitPct, 10.0), rep("g", 50.0, PayType::GrossPct, 2.0)];
        let p = deal_payout(&d).unwrap();
        assert_eq!(amount(&p, "p"), 0.0);
        assert_eq!(amount(&p, "g"), 50.0);
    }

    #[test]
    fn the_lines_always_add_up_to_the_net_to_the_cent() {
        let splits: [&[f64]; 5] = [&[33.33, 33.33, 33.34], &[33.33, 33.33, 33.33], &[25.0, 35.0, 20.0, 20.0], &[70.0, 30.0], &[100.0]];
        for s in splits {
            for n in -2_000..2_000 {
                let net = n as f64 * 1.37 + 0.01;
                let mut d = deal(net.abs() * 3.0, net);
                d.reps = vec![rep("r1", 60.0, PayType::ProfitPct, 7.5), rep("r2", 40.0, PayType::Fixed, 33.33)];
                d.logistics = logistics(n as f64 * 0.11, false);
                d.owners = s.iter().enumerate().map(|(i, pct)| owner(&format!("o{i}"), *pct, i == 0)).collect();
                let p = deal_payout(&d).unwrap();
                assert_eq!(total(&p), cents(net), "split {s:?} net {net}");
                assert_eq!(p.unallocated, 0.0);
            }
        }
    }

    #[test]
    fn a_third_each_puts_the_odd_cent_on_the_first() {
        let mut d = deal(0.0, 100.0);
        d.owners = vec![owner("a", 100.0 / 3.0, false), owner("b", 100.0 / 3.0, false), owner("c", 100.0 / 3.0, false)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((amount(&p, "a"), amount(&p, "b"), amount(&p, "c")), (33.34, 33.33, 33.33));
    }

    #[test]
    fn when_the_business_keeps_the_deal_only_business_entries_share_it() {
        let mut d = deal(0.0, 1_000.0);
        d.owners_included = false;
        d.owners = vec![owner("jack", 30.0, false), owner("biz", 30.0, true), owner("fund", 10.0, true), owner("ben", 30.0, false)];
        let p = deal_payout(&d).unwrap();
        assert_eq!(amount(&p, "jack"), 0.0);
        assert_eq!(amount(&p, "ben"), 0.0);
        assert_eq!(amount(&p, "biz"), 750.0);
        assert_eq!(amount(&p, "fund"), 250.0);
        assert_eq!(p.lines[1].rule.as_deref(), Some("75% (business keeps this deal)"));
        // No entry is the business: the split applies after all.
        d.owners = vec![owner("a", 60.0, false), owner("b", 40.0, false)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((amount(&p, "a"), amount(&p, "b")), (600.0, 400.0));
    }

    #[test]
    fn a_typed_rep_amount_changes_the_pool() {
        let mut d = deal(20_000.0, 3_650.0);
        d.reps = vec![rep("sam", 100.0, PayType::Fixed, 200.0)];
        d.owners = vec![owner("a", 50.0, false), owner("b", 50.0, false)];
        d.typed = vec![Typed { kind: PayeeKind::Rep, payee_id: "sam".into(), amount: 650.0 }];
        let p = deal_payout(&d).unwrap();
        let sam = &p.lines[0];
        assert_eq!((sam.computed, sam.amount, sam.typed), (200.0, 650.0, true));
        assert_eq!(p.pool, 3_000.0);
        assert_eq!(amount(&p, "a"), 1_500.0);
    }

    #[test]
    fn a_typed_owner_takes_their_amount_and_the_rest_split_the_remainder() {
        let mut d = deal(0.0, 1_000.0);
        d.owners = vec![owner("a", 50.0, false), owner("b", 30.0, false), owner("biz", 20.0, true)];
        d.typed = vec![Typed { kind: PayeeKind::Owner, payee_id: "a".into(), amount: 100.0 }];
        let p = deal_payout(&d).unwrap();
        assert_eq!(amount(&p, "a"), 100.0);
        assert_eq!(amount(&p, "b"), 540.0);
        assert_eq!(amount(&p, "biz"), 360.0);
        assert_eq!(p.lines[0].computed, 500.0);
        assert_eq!(p.unallocated, 0.0);
        // Every owner typed: what they leave is shown, not lost.
        d.typed.push(Typed { kind: PayeeKind::Owner, payee_id: "b".into(), amount: 100.0 });
        d.typed.push(Typed { kind: PayeeKind::Business, payee_id: "biz".into(), amount: 100.0 });
        let p = deal_payout(&d).unwrap();
        assert_eq!(p.unallocated, 700.0);
        assert_eq!(total(&p), cents(1_000.0));
    }

    #[test]
    fn with_no_split_set_up_the_pool_is_unallocated() {
        let mut d = deal(1_000.0, 400.0);
        d.reps = vec![rep("r", 100.0, PayType::ProfitPct, 25.0)];
        let p = deal_payout(&d).unwrap();
        assert_eq!(p.lines.len(), 1);
        assert_eq!(p.unallocated, 300.0);
    }

    #[test]
    fn logistics_pay_can_be_pending_or_below_zero() {
        let mut d = deal(1_000.0, 400.0);
        d.logistics = logistics(120.0, true);
        d.owners = vec![owner("biz", 100.0, true)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((amount(&p, "lg"), p.lines[0].pending), (0.0, true));
        assert_eq!(amount(&p, "biz"), 400.0);
        d.logistics = logistics(-50.0, false);
        let p = deal_payout(&d).unwrap();
        assert_eq!(amount(&p, "biz"), 450.0);
        assert_eq!(total(&p), cents(400.0));
    }

    #[test]
    fn a_refund_comes_off_the_sale_and_the_profit() {
        let mut d = deal(20_000.0, 3_650.0);
        d.refunded = 650.0;
        d.reps = vec![rep("p", 50.0, PayType::ProfitPct, 10.0), rep("g", 50.0, PayType::GrossPct, 1.0)];
        let p = deal_payout(&d).unwrap();
        assert_eq!((p.gross, p.net), (19_350.0, 3_000.0));
        assert_eq!(amount(&p, "p"), 150.0);
        assert_eq!(amount(&p, "g"), 96.75);
    }

    #[test]
    fn bad_input_is_refused_in_plain_words() {
        let base = || {
            let mut d = deal(1_000.0, 400.0);
            d.reps = vec![rep("ann", 100.0, PayType::ProfitPct, 10.0)];
            d.owners = vec![owner("a", 100.0, false)];
            d
        };
        let mut d = base();
        d.reps = vec![rep("ann", 60.0, PayType::ProfitPct, 10.0), rep("bo", 30.0, PayType::ProfitPct, 10.0)];
        assert_eq!(deal_payout(&d).unwrap_err(), "The reps' shares must add up to 100%, not 90%.");
        let mut d = base();
        d.reps[0].rule.value = 150.0;
        assert_eq!(deal_payout(&d).unwrap_err(), "ann: A percentage must be between 0 and 100, not 150.");
        let mut d = base();
        d.reps[0].rule = Rule { pay_type: PayType::Fixed, value: -5.0 };
        assert!(deal_payout(&d).is_err());
        let mut d = base();
        d.reps[0].rule = Rule { pay_type: PayType::Fixed, value: 5e16 };
        assert!(deal_payout(&d).is_err());
        let mut d = base();
        d.owners = vec![owner("a", 60.0, false), owner("b", 30.0, false)];
        assert_eq!(deal_payout(&d).unwrap_err(), "The split must add up to 100%, not 90%.");
        let mut d = base();
        d.owners = vec![owner("a", 50.0, false), owner("a", 50.0, true)];
        assert_eq!(deal_payout(&d).unwrap_err(), "a is in the split twice.");
        let mut d = base();
        d.reps.push(rep("ann", 0.0001, PayType::ProfitPct, 1.0));
        assert!(deal_payout(&d).is_err());
        let mut d = base();
        d.typed = vec![Typed { kind: PayeeKind::Rep, payee_id: "nobody".into(), amount: 5.0 }];
        assert_eq!(deal_payout(&d).unwrap_err(), "An amount was typed for a rep who is not on this deal.");
        let mut d = base();
        d.typed = vec![Typed { kind: PayeeKind::Rep, payee_id: "ann".into(), amount: 5.0 }, Typed { kind: PayeeKind::Rep, payee_id: "ann".into(), amount: 9.0 }];
        assert_eq!(deal_payout(&d).unwrap_err(), "Two amounts were typed for the same line.");
        let mut d = base();
        d.typed = vec![Typed { kind: PayeeKind::Rep, payee_id: "ann".into(), amount: 1e300 }];
        assert!(deal_payout(&d).is_err());
        let mut d = base();
        d.net = f64::NAN;
        assert!(deal_payout(&d).is_err());
        let mut d = base();
        d.refunded = -1.0;
        assert!(deal_payout(&d).is_err());
        let mut d = base();
        d.reps[0].share_pct = 0.0;
        assert!(deal_payout(&d).is_err());
    }

    #[test]
    fn a_refund_after_payment_books_only_the_difference() {
        let mut d = deal(20_000.0, 3_650.0);
        d.reps = vec![rep("sam", 100.0, PayType::ProfitPct, 10.0)];
        d.owners = vec![owner("a", 60.0, false), owner("b", 40.0, false)];
        let first = deal_payout(&d).unwrap();
        let booked = book(&first.lines);
        assert!(adjustments(&booked, &first).is_empty());

        d.refunded = 650.0;
        let after = deal_payout(&d).unwrap();
        let adj = adjustments(&booked, &after);
        let by = |id: &str| adj.iter().find(|b| b.payee_id == id).unwrap().clone();
        assert_eq!(by("sam").amount, -65.0);
        assert_eq!(by("sam").basis, 3_000.0);
        assert_eq!(by("sam").rule.as_deref(), Some("10% of profit"));
        assert_eq!(by("a").amount, -351.0);
        assert_eq!(by("b").amount, -234.0);
        assert_eq!(adj.iter().map(|b| cents(b.amount)).sum::<i64>(), cents(-650.0));

        // Booking those leaves nothing more to book.
        let mut all = booked.clone();
        all.extend(book(&adj));
        assert!(adjustments(&all, &after).is_empty());
    }

    #[test]
    fn a_typed_rep_keeps_their_amount_through_a_refund() {
        let mut d = deal(20_000.0, 3_650.0);
        d.reps = vec![rep("sam", 100.0, PayType::ProfitPct, 10.0)];
        d.owners = vec![owner("a", 100.0, false)];
        d.typed = vec![Typed { kind: PayeeKind::Rep, payee_id: "sam".into(), amount: 650.0 }];
        let booked = book(&deal_payout(&d).unwrap().lines);
        d.refunded = 650.0;
        let adj = adjustments(&booked, &deal_payout(&d).unwrap());
        assert_eq!(adj.len(), 1);
        assert_eq!((adj[0].payee_id.as_str(), adj[0].amount), ("a", -650.0));
    }

    #[test]
    fn a_rep_taken_off_a_deal_gets_their_booked_total_back_as_a_minus_line() {
        let booked = vec![
            Booked { kind: PayeeKind::Rep, payee_id: "sam".into(), name: "Sam".into(), amount: 365.0 },
            Booked { kind: PayeeKind::Owner, payee_id: "a".into(), name: "A".into(), amount: 3_285.0 },
            Booked { kind: PayeeKind::Rep, payee_id: "sam".into(), name: "Sam".into(), amount: -65.0 },
        ];
        let mut d = deal(20_000.0, 3_650.0);
        d.owners = vec![owner("a", 100.0, false)];
        let adj = adjustments(&booked, &deal_payout(&d).unwrap());
        assert_eq!(adj.len(), 2);
        assert_eq!((adj[0].payee_id.as_str(), adj[0].amount), ("a", 365.0));
        assert_eq!((adj[1].payee_id.as_str(), adj[1].amount, adj[1].rule.clone()), ("sam", -300.0, None));
    }

    #[test]
    fn an_owner_becoming_the_business_books_nothing_by_itself() {
        let booked = vec![Booked { kind: PayeeKind::Owner, payee_id: "fund".into(), name: "Fund".into(), amount: 1_000.0 }];
        let mut d = deal(0.0, 1_000.0);
        d.owners = vec![owner("fund", 100.0, true)];
        assert!(adjustments(&booked, &deal_payout(&d).unwrap()).is_empty());
    }

    #[test]
    fn a_rate_change_applies_from_its_day_on() {
        let h = vec![
            DatedRule { from: "2026-01-01".into(), rule: Rule { pay_type: PayType::ProfitPct, value: 10.0 } },
            DatedRule { from: "2026-11-01".into(), rule: Rule { pay_type: PayType::ProfitPct, value: 15.0 } },
            DatedRule { from: "2026-11-01T09:00:00Z".into(), rule: Rule { pay_type: PayType::Fixed, value: 200.0 } },
        ];
        assert_eq!(rule_on(&h, "2025-12-31"), None);
        assert_eq!(rule_on(&h, "2026-10-31T23:59:59Z").unwrap().value, 10.0);
        assert_eq!(rule_on(&h, "2026-11-01").unwrap().pay_type, PayType::Fixed);
        assert!(is_day("2026-11-01"));
        assert!(!is_day("2026-1-5"));
        assert!(!is_day("2026-11-01T09:00"));
    }

    #[test]
    fn rules_read_in_plain_words() {
        assert_eq!(Rule { pay_type: PayType::ProfitPct, value: 10.0 }.label(), "10% of profit");
        assert_eq!(Rule { pay_type: PayType::GrossPct, value: 7.5 }.label(), "7.5% of the sale");
        assert_eq!(Rule { pay_type: PayType::Fixed, value: 200.0 }.label(), "$200 a deal");
        assert_eq!(Rule { pay_type: PayType::Fixed, value: 1_250.5 }.label(), "$1,250.50 a deal");
        assert_eq!(Rule { pay_type: PayType::Fixed, value: 1_000_000.0 }.label(), "$1,000,000 a deal");
    }

    #[test]
    fn pay_types_keep_the_names_already_stored() {
        for (t, s) in [(PayType::ProfitPct, "profit_pct"), (PayType::GrossPct, "gross_pct"), (PayType::Fixed, "fixed")] {
            assert_eq!(serde_json::to_string(&t).unwrap(), format!("\"{s}\""));
            assert_eq!(serde_json::from_str::<PayType>(&format!("\"{s}\"")).unwrap(), t);
            assert_eq!(PayType::from_stored(s), t);
        }
        assert_eq!(PayType::from_stored(""), PayType::ProfitPct);
        assert_eq!(PayType::from_stored("percent"), PayType::ProfitPct);
    }

    #[test]
    fn the_split_setting_reads_with_stable_ids() {
        let arr = vec![
            json!({"name": "Jack", "pct": 30, "is_business": false}),
            json!({"name": "", "pct": 0, "is_business": false}),
            json!({"name": "", "pct": 40, "is_business": true}),
            json!({"name": "Growth Fund", "pct": 10, "is_business": false, "kind": "investment"}),
            json!({"name": "Jack", "pct": 10, "is_business": false}),
            json!({"id": "s-77", "name": "Ben", "pct": 10, "is_business": false}),
        ];
        let o = owners_from_split_json(&arr);
        let ids: Vec<&str> = o.iter().map(|x| x.payee_id.as_str()).collect();
        assert_eq!(ids, ["jack", "business", "growth-fund", "jack-2", "s-77"]);
        assert_eq!((o[1].name.as_str(), o[1].kind.as_str(), o[1].is_business), ("Business", "business", true));
        assert_eq!(o[2].kind, "investment");
        assert_eq!(o[0].kind, "person");
        // Reordering the list never moves money between people.
        let mut rev = arr.clone();
        rev.swap(0, 3);
        let r = owners_from_split_json(&rev);
        assert_eq!(r.iter().find(|x| x.name == "Growth Fund").unwrap().payee_id, "growth-fund");
    }

    #[test]
    fn half_cents_round_as_written() {
        assert_eq!(cents(1.005), 101);
        assert_eq!(cents(9.405), 941);
        assert_eq!(cents(-1.005), -101);
        assert_eq!(pct_of(50_000, 1.005), 503);
    }

    #[test]
    fn a_loss_is_shared_to_the_cent() {
        assert_eq!(split_cents(-10_001, &[50.0, 50.0]), vec![-5_000, -5_001]);
        assert_eq!(split_cents(7, &[0.0, 0.0]), vec![0, 0]);
        assert_eq!(split_cents(10, &[1.0, 0.0, 1.0]), vec![5, 0, 5]);
    }
}
