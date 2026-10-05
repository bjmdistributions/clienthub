//! R-449 / R-445 / R-446 / R-447: the rules behind Bills, the money that leaves the business
//! on a schedule (rent paid by Zelle, insurance, a car note), plus the spending read that
//! sits beside it. Byte-identical in `BUSINESS APP/src-tauri/src` and `clienthub-api/src`
//! (like `deal_label.rs`): the desktop links a payment the moment Plaid brings it in, the
//! server links the same payment for the phone, and both must reach the same answer, so
//! both run this file. No `use crate::`, no database, no clock: every input is passed in.
//!
//! No AI (Jack's rule): every decision here is a word match, an amount band, a date window
//! or a count.
//!
//! - A bill is due on a schedule that starts at its first due date (`anchor`). Monthly,
//!   quarterly, twice-yearly and yearly bills keep the anchor's day of the month, clamped to
//!   the month's last day (due on the 31st means the 28th in February, then the 31st again).
//! - A payment matches a bill when it went out, every word of the bill's "shows in the bank
//!   as" text is in the payment's payee or memo, the amount is inside the bill's band, and
//!   the date is inside the window around one due date. It then pays that due date.
//! - A link's id is made from the bill and the bank row, so two devices that link the same
//!   payment write one row, never two.

use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Duration, NaiveDate};

/// Days after a due date before an unpaid bill is called overdue. Zelle posts the same day,
/// an ACH draft a day or two later.
pub const GRACE_DAYS: i64 = 2;
/// Days ahead that a bill counts as due soon (Jack's choice, 2026-10-05).
pub const DUE_SOON_DAYS: i64 = 3;
/// How far back an unpaid due date still raises the alarm. Older gaps show in the bill's
/// history but do not call it overdue: bank history may simply not reach that far.
pub const ALARM_LOOKBACK_DAYS: i64 = 90;
/// Default amount band, as a percentage of the bill's amount.
pub const DEFAULT_TOLERANCE_PCT: f64 = 10.0;
/// The largest logo a bill may carry, as data-URL characters (about 30 KB of image).
pub const MAX_LOGO_CHARS: usize = 40_000;

pub const CADENCES: &[&str] = &["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"];

/// Categories that are deal money (or the owner's own), never a bill and never spending.
/// A payment in one of these is left alone by detection and by the matcher.
const DEAL_MONEY: &[&str] = &[
    "receipt", "payment", "merchandise", "customs", "customer_refund", "supplier_refund",
    "owner_draw", "owner_contribution", "cash_in", "loan_received",
];

/// Words that are how a payment was sent, not who it went to.
const RAIL_WORDS: &[&str] = &[
    "a", "ach", "auto", "autopay", "bill", "bpay", "card", "checkcard", "co", "com", "conf",
    "corp", "debit", "des", "draft", "electronic", "entry", "for", "from", "id", "inc", "indn",
    "llc", "ltd", "of", "online", "orig", "pay", "payment", "pmt", "pos", "ppd", "purchase",
    "recurring", "ref", "sent", "the", "to", "transfer", "web", "withdrawal", "www", "zelle",
];

// ----------------------------------------------------------------------------- inputs

#[derive(Debug, Clone, Default)]
pub struct Bill {
    pub id: String,
    pub name: String,
    /// "Shows in the bank as": every word must appear in the payment's payee or memo.
    pub payee_match: String,
    /// The usual amount. 0 means it varies, and only the words and the date are checked.
    pub amount: f64,
    pub tolerance_pct: f64,
    pub cadence: String,
    /// The first due date, YYYY-MM-DD.
    pub anchor: String,
    /// 'active', 'archived' or 'ignored' (a dismissed suggestion; never shown as a bill).
    pub status: String,
}

#[derive(Debug, Clone, Default)]
pub struct Txn {
    pub id: String,
    /// YYYY-MM-DD (a longer value is cut to its date).
    pub posted_at: String,
    /// Always positive; `direction` carries the sign.
    pub amount: f64,
    pub direction: String,
    pub payee: String,
    pub memo: String,
    pub category: String,
    pub counterparty_type: String,
    pub pending: bool,
    pub retracted: bool,
    /// Sum of this row's deal allocations. Deal money is never a bill.
    pub allocated: f64,
    /// The bill this row already pays (a link that was not rejected), if any.
    pub bill_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct Link {
    pub id: String,
    pub bill_id: String,
    pub bank_txn_id: String,
    /// The due date this payment covers.
    pub period: String,
    /// 'auto', 'confirmed' or 'rejected'.
    pub status: String,
    /// The bank row's date and amount, joined in by the caller.
    pub posted_at: String,
    pub amount: f64,
}

// ---------------------------------------------------------------------------- dates

pub fn parse_day(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    let d = if s.len() >= 10 { &s[..10] } else { s };
    NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()
}

pub fn fmt_day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

fn add_months_keep_day(anchor: NaiveDate, months: i64) -> NaiveDate {
    let total = anchor.year() as i64 * 12 + (anchor.month() as i64 - 1) + months;
    let y = total.div_euclid(12) as i32;
    let m = (total.rem_euclid(12) + 1) as u32;
    let d = anchor.day().min(days_in_month(y, m));
    NaiveDate::from_ymd_opt(y, m, d).unwrap_or(anchor)
}

/// (step in days, or step in months). Exactly one is non-zero.
fn step_of(cadence: &str) -> (i64, i64) {
    match cadence {
        "weekly" => (7, 0),
        "biweekly" => (14, 0),
        "quarterly" => (0, 3),
        "semiannual" => (0, 6),
        "annual" => (0, 12),
        _ => (0, 1),
    }
}

/// Days a payment may come before / after its due date and still pay it.
fn window_of(cadence: &str) -> (i64, i64) {
    match cadence {
        "weekly" => (3, 3),
        "biweekly" => (5, 6),
        "quarterly" | "semiannual" | "annual" => (20, 30),
        _ => (10, 15),
    }
}

/// The k-th due date (k may be negative: before the first due date).
pub fn occurrence(anchor: NaiveDate, cadence: &str, k: i64) -> NaiveDate {
    let (days, months) = step_of(cadence);
    if days > 0 {
        anchor + Duration::days(days * k)
    } else {
        add_months_keep_day(anchor, months * k)
    }
}

/// The index of the due date nearest to `d`.
fn nearest_index(anchor: NaiveDate, cadence: &str, d: NaiveDate) -> i64 {
    let (days, months) = step_of(cadence);
    let guess = if days > 0 {
        ((d - anchor).num_days() as f64 / days as f64).round() as i64
    } else {
        let diff = (d.year() as i64 * 12 + d.month() as i64) - (anchor.year() as i64 * 12 + anchor.month() as i64);
        diff.div_euclid(months)
    };
    let mut best = guess;
    let mut best_gap = i64::MAX;
    for k in [guess - 1, guess, guess + 1] {
        let gap = (occurrence(anchor, cadence, k) - d).num_days().abs();
        if gap < best_gap {
            best = k;
            best_gap = gap;
        }
    }
    best
}

/// The due date a payment on `d` would pay, when it falls inside that due date's window.
pub fn period_for(bill: &Bill, d: NaiveDate) -> Option<NaiveDate> {
    let anchor = parse_day(&bill.anchor)?;
    let k = nearest_index(anchor, &bill.cadence, d);
    let due = occurrence(anchor, &bill.cadence, k);
    let (early, late) = window_of(&bill.cadence);
    let gap = (d - due).num_days();
    if gap >= -early && gap <= late { Some(due) } else { None }
}

/// The due date nearest to `d`, window or not. A payment Jack links by hand pays this one
/// when it falls outside every window (paid very late, or very early).
pub fn nearest_due(bill: &Bill, d: NaiveDate) -> Option<NaiveDate> {
    let anchor = parse_day(&bill.anchor)?;
    Some(occurrence(anchor, &bill.cadence, nearest_index(anchor, &bill.cadence, d)))
}

/// What the bill costs in an average month.
pub fn monthly_equivalent(amount: f64, cadence: &str) -> f64 {
    let f = match cadence {
        "weekly" => 52.0 / 12.0,
        "biweekly" => 26.0 / 12.0,
        "quarterly" => 1.0 / 3.0,
        "semiannual" => 1.0 / 6.0,
        "annual" => 1.0 / 12.0,
        _ => 1.0,
    };
    round2(amount * f)
}

pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------- words

/// Lower-case words of letters and digits.
pub fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

/// The words that name who was paid: no rail words ("zelle", "payment", "to"), and no word
/// holding a digit (a per-payment reference such as JPM99X2 or a confirmation number).
pub fn payee_key(s: &str) -> String {
    words(s)
        .into_iter()
        .filter(|w| !w.chars().any(|c| c.is_ascii_digit()))
        .filter(|w| w.len() > 1 && !RAIL_WORDS.contains(&w.as_str()))
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}

/// "oak street properties" -> "Oak Street Properties".
pub fn title_case(key: &str) -> String {
    key.split(' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn text_words(t: &Txn) -> HashSet<String> {
    let mut set: HashSet<String> = words(&t.payee).into_iter().collect();
    set.extend(words(&t.memo));
    set
}

/// Every word of the bill's "shows in the bank as" text is somewhere in the payment.
pub fn words_match(payee_match: &str, t: &Txn) -> bool {
    let want = words(payee_match);
    if want.is_empty() {
        return false;
    }
    let have = text_words(t);
    want.iter().all(|w| have.contains(w))
}

pub fn amount_matches(bill: &Bill, amount: f64) -> bool {
    if bill.amount <= 0.0 {
        return true;
    }
    let tol = if bill.tolerance_pct > 0.0 { bill.tolerance_pct } else { DEFAULT_TOLERANCE_PCT };
    (amount - bill.amount).abs() <= (bill.amount * tol / 100.0).max(1.0)
}

/// A bank row that could be a bill payment at all: money out, posted, not deal money.
pub fn eligible(t: &Txn) -> bool {
    t.direction == "out"
        && !t.pending
        && !t.retracted
        && t.amount > 0.0
        && t.allocated < 0.01
        && t.counterparty_type != "client"
        && t.counterparty_type != "supplier"
        && !DEAL_MONEY.contains(&t.category.as_str())
}

pub fn link_id(bill_id: &str, bank_txn_id: &str) -> String {
    format!("bp-{bill_id}-{bank_txn_id}")
}

// --------------------------------------------------------------------------- matching

/// The due date `t` pays on `bill`, when it is that bill's payment.
pub fn match_payment(bill: &Bill, t: &Txn) -> Option<NaiveDate> {
    if bill.status != "active" || !eligible(t) {
        return None;
    }
    if !words_match(&bill.payee_match, t) || !amount_matches(bill, t.amount) {
        return None;
    }
    period_for(bill, parse_day(&t.posted_at)?)
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewLink {
    pub id: String,
    pub bill_id: String,
    pub bank_txn_id: String,
    pub period: String,
    pub amount: f64,
}

/// The links to write: for each unlinked payment, the bill it pays best. `known` holds every
/// link id that already exists in any status, so a link Jack rejected is never written again.
pub fn auto_links(bills: &[Bill], txns: &[Txn], known: &HashSet<String>) -> Vec<NewLink> {
    let mut out = Vec::new();
    for t in txns {
        if !t.bill_id.is_empty() {
            continue;
        }
        let mut best: Option<(&Bill, NaiveDate, f64, usize)> = None;
        for b in bills {
            let Some(due) = match_payment(b, t) else { continue };
            if known.contains(&link_id(&b.id, &t.id)) {
                continue;
            }
            let gap = if b.amount > 0.0 { (t.amount - b.amount).abs() } else { f64::MAX / 4.0 };
            let specific = words(&b.payee_match).len();
            let better = match &best {
                None => true,
                Some((_, _, g, s)) => gap < *g - 0.005 || ((gap - *g).abs() <= 0.005 && specific > *s),
            };
            if better {
                best = Some((b, due, gap, specific));
            }
        }
        if let Some((b, due, _, _)) = best {
            out.push(NewLink {
                id: link_id(&b.id, &t.id),
                bill_id: b.id.clone(),
                bank_txn_id: t.id.clone(),
                period: fmt_day(due),
                amount: round2(t.amount),
            });
        }
    }
    out
}

// ------------------------------------------------------------------------------ state

#[derive(Debug, Clone, PartialEq)]
pub struct Period {
    pub due: String,
    /// The latest payment date for this due date, when paid.
    pub paid_on: Option<String>,
    pub paid_amount: f64,
    /// 'paid', 'late' (paid after the grace days), 'missed', 'due' (not yet due or in grace)
    pub state: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BillState {
    /// 'overdue', 'due_soon', 'paid', 'upcoming', 'not_seen' (unpaid past due, but the bank
    /// feed has not reached that date yet), or 'archived'.
    pub status: String,
    pub next_due: Option<String>,
    pub days_until: Option<i64>,
    /// Unpaid due dates inside the alarm window, oldest first.
    pub overdue: Vec<String>,
    pub last_paid: Option<String>,
    pub last_amount: Option<f64>,
    /// The latest due date on or before today + DUE_SOON_DAYS is paid.
    pub current_paid: bool,
    pub paid_count: usize,
    pub on_time_count: usize,
    /// Expected due dates, newest first, at most 12.
    pub history: Vec<Period>,
}

/// Where the bill stands on `today`. `feed_latest` is the newest bank date seen: an unpaid
/// due date the feed has not reached yet is "not seen", never overdue, so a desktop that was
/// closed for a week does not set every bill off.
pub fn bill_state(bill: &Bill, links: &[Link], today: NaiveDate, feed_latest: Option<NaiveDate>) -> BillState {
    let mut paid: HashMap<String, (String, f64)> = HashMap::new();
    let mut last: Option<(String, f64)> = None;
    for l in links.iter().filter(|l| l.bill_id == bill.id && l.status != "rejected") {
        let day = l.posted_at.get(..10).unwrap_or(&l.posted_at).to_string();
        let e = paid.entry(l.period.clone()).or_insert((day.clone(), 0.0));
        if day > e.0 {
            e.0 = day.clone();
        }
        e.1 += l.amount;
        if last.as_ref().map_or(true, |(d, _)| day > *d) {
            last = Some((day, l.amount));
        }
    }
    let mut st = BillState {
        status: "upcoming".into(),
        next_due: None,
        days_until: None,
        overdue: Vec::new(),
        last_paid: last.as_ref().map(|(d, _)| d.clone()),
        last_amount: last.as_ref().map(|(_, a)| round2(*a)),
        current_paid: false,
        paid_count: 0,
        on_time_count: 0,
        history: Vec::new(),
    };
    let Some(anchor) = parse_day(&bill.anchor) else {
        st.status = if bill.status == "active" { "upcoming".into() } else { "archived".into() };
        return st;
    };
    let horizon = today + Duration::days(DUE_SOON_DAYS);
    let mut k = 0i64;
    let mut periods: Vec<Period> = Vec::new();
    loop {
        let due = occurrence(anchor, &bill.cadence, k);
        let key = fmt_day(due);
        let p = paid.get(&key);
        if due > horizon && p.is_none() {
            if st.next_due.is_none() {
                st.next_due = Some(key.clone());
                st.days_until = Some((due - today).num_days());
            }
            break;
        }
        if k > 2000 {
            break;
        }
        let state = match p {
            Some((on, _)) => {
                st.paid_count += 1;
                let late = parse_day(on).map_or(false, |d| (d - due).num_days() > GRACE_DAYS);
                if !late {
                    st.on_time_count += 1;
                }
                if late { "late" } else { "paid" }
            }
            None if (today - due).num_days() > GRACE_DAYS => "missed",
            None => "due",
        };
        if p.is_none() && st.next_due.is_none() && due >= today - Duration::days(GRACE_DAYS) {
            st.next_due = Some(key.clone());
            st.days_until = Some((due - today).num_days());
        }
        periods.push(Period {
            due: key,
            paid_on: p.map(|(d, _)| d.clone()),
            paid_amount: p.map_or(0.0, |(_, a)| round2(*a)),
            state: state.into(),
        });
        k += 1;
    }
    st.current_paid = periods.last().map_or(false, |p| p.paid_on.is_some());
    let mut not_seen = false;
    for p in &periods {
        if p.state != "missed" {
            continue;
        }
        let due = parse_day(&p.due).unwrap_or(today);
        if (today - due).num_days() > ALARM_LOOKBACK_DAYS {
            continue;
        }
        let seen = feed_latest.map_or(false, |f| (f - due).num_days() > GRACE_DAYS);
        if seen {
            st.overdue.push(p.due.clone());
        } else {
            not_seen = true;
        }
    }
    st.status = if bill.status != "active" {
        "archived".into()
    } else if !st.overdue.is_empty() {
        "overdue".into()
    } else if not_seen {
        "not_seen".into()
    } else if st.days_until.map_or(false, |d| d <= DUE_SOON_DAYS) {
        "due_soon".into()
    } else if st.current_paid {
        "paid".into()
    } else {
        "upcoming".into()
    };
    periods.reverse();
    periods.truncate(12);
    st.history = periods;
    st
}

// -------------------------------------------------------------------------- detection

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// The payee words; becomes the bill's "shows in the bank as" text.
    pub key: String,
    pub name: String,
    pub cadence: String,
    pub amount: f64,
    pub tolerance_pct: f64,
    /// First due date, set so the payments already in the bank pay their due dates.
    pub anchor: String,
    pub next_due: String,
    pub category: String,
    pub count: usize,
    pub first_paid: String,
    pub last_paid: String,
    pub monthly: f64,
    pub txn_ids: Vec<String>,
    /// One plain sentence on why this looks like a bill.
    pub why: String,
}

fn median(v: &mut Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

fn cadence_of_gap(days: f64) -> Option<&'static str> {
    match days {
        d if (5.0..=9.0).contains(&d) => Some("weekly"),
        d if (12.0..=16.0).contains(&d) => Some("biweekly"),
        d if (26.0..=35.0).contains(&d) => Some("monthly"),
        d if (80.0..=100.0).contains(&d) => Some("quarterly"),
        _ => None,
    }
}

fn in_band(gap: i64, cadence: &str) -> bool {
    match cadence {
        "weekly" => (5..=9).contains(&gap),
        "biweekly" => (11..=17).contains(&gap),
        "monthly" => (24..=38).contains(&gap),
        "quarterly" => (75..=105).contains(&gap),
        _ => false,
    }
}

fn ordinal(d: u32) -> String {
    let suffix = match (d % 10, d % 100) {
        (1, n) if n != 11 => "st",
        (2, n) if n != 12 => "nd",
        (3, n) if n != 13 => "rd",
        _ => "th",
    };
    format!("{d}{suffix}")
}

fn money(v: f64) -> String {
    let cents = (v * 100.0).round() as i64;
    let whole = cents / 100;
    let s = whole.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if cents % 100 != 0 {
        out.push_str(&format!(".{:02}", cents % 100));
    }
    format!("${out}")
}

/// Payments that repeat: same payee words, a similar amount, a regular gap. At least three
/// payments, the latest recent enough that the bill is still running. Payee words already
/// used by a bill (active, archived or a dismissed suggestion) are skipped.
pub fn detect(txns: &[Txn], bills: &[Bill], today: NaiveDate) -> Vec<Candidate> {
    let taken: HashSet<String> = bills.iter().map(|b| payee_key(&b.payee_match)).collect();
    let mut groups: HashMap<String, Vec<&Txn>> = HashMap::new();
    for t in txns {
        if !eligible(t) || !t.bill_id.is_empty() || parse_day(&t.posted_at).is_none() {
            continue;
        }
        let src = if t.payee.trim().is_empty() { &t.memo } else { &t.payee };
        let key = payee_key(src);
        if key.is_empty() || taken.contains(&key) {
            continue;
        }
        groups.entry(key).or_default().push(t);
    }
    let mut out = Vec::new();
    for (key, rows) in groups {
        if rows.len() < 3 {
            continue;
        }
        // Split one payee into amount clusters (two policies with one insurer), each
        // within 30% of its own median.
        let mut sorted = rows.clone();
        sorted.sort_by(|a, b| a.amount.partial_cmp(&b.amount).unwrap_or(std::cmp::Ordering::Equal));
        let mut clusters: Vec<Vec<&Txn>> = Vec::new();
        for t in sorted {
            match clusters.last_mut() {
                Some(c) if {
                    let mut a: Vec<f64> = c.iter().map(|x| x.amount).collect();
                    let m = median(&mut a);
                    m > 0.0 && (t.amount - m).abs() / m <= 0.30
                } => c.push(t),
                _ => clusters.push(vec![t]),
            }
        }
        for mut c in clusters {
            if c.len() < 3 {
                continue;
            }
            c.sort_by(|a, b| a.posted_at.cmp(&b.posted_at));
            let dates: Vec<NaiveDate> = c.iter().filter_map(|t| parse_day(&t.posted_at)).collect();
            let gaps: Vec<i64> = dates.windows(2).map(|w| (w[1] - w[0]).num_days()).collect();
            let mut gf: Vec<f64> = gaps.iter().map(|g| *g as f64).collect();
            let Some(cadence) = cadence_of_gap(median(&mut gf)) else { continue };
            let regular = gaps.iter().filter(|g| in_band(**g, cadence)).count();
            if (regular as f64) < (gaps.len() as f64 * 0.6) {
                continue;
            }
            let last = *dates.last().unwrap();
            let (sd, sm) = step_of(cadence);
            let step_days = if sd > 0 { sd } else { sm * 31 };
            if (today - last).num_days() > step_days * 2 + 15 {
                continue;
            }
            let mut amts: Vec<f64> = c.iter().map(|t| t.amount).collect();
            let amount = round2(median(&mut amts));
            let spread = c.iter().map(|t| (t.amount - amount).abs() / amount.max(0.01)).fold(0.0, f64::max);
            let tolerance = ((spread * 100.0 / 5.0).ceil() * 5.0).clamp(5.0, 30.0);
            let first = dates[0];
            let anchor = if sd > 0 {
                first
            } else {
                // The day of the month it is usually paid on.
                let mut by_day: HashMap<u32, usize> = HashMap::new();
                for d in &dates {
                    *by_day.entry(d.day()).or_default() += 1;
                }
                let day = by_day.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(d, _)| *d).unwrap_or(first.day());
                let d = day.min(days_in_month(first.year(), first.month()));
                let mut a = NaiveDate::from_ymd_opt(first.year(), first.month(), d).unwrap_or(first);
                // A first payment made early (the 28th for the 1st) belongs to next month.
                if (first - a).num_days() < -10 {
                    a = add_months_keep_day(a, -1);
                }
                if (first - a).num_days() > 15 {
                    a = add_months_keep_day(a, 1);
                }
                a
            };
            let probe = Bill {
                id: String::new(),
                name: String::new(),
                payee_match: key.clone(),
                amount,
                tolerance_pct: tolerance,
                cadence: cadence.into(),
                anchor: fmt_day(anchor),
                status: "active".into(),
            };
            // The due date after the one the latest payment paid.
            let paid_through = period_for(&probe, last).unwrap_or(last);
            let k = nearest_index(anchor, cadence, paid_through);
            let next = occurrence(anchor, cadence, k + 1);
            let mut cats: HashMap<&str, usize> = HashMap::new();
            for t in &c {
                if !t.category.is_empty() {
                    *cats.entry(t.category.as_str()).or_default() += 1;
                }
            }
            let category = cats.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map(|(k, _)| k.to_string()).unwrap_or_default();
            let every = match cadence {
                "weekly" => "every week".to_string(),
                "biweekly" => "every two weeks".to_string(),
                "quarterly" => "every three months".to_string(),
                _ => format!("every month, usually on the {}", ordinal(anchor.day())),
            };
            let why = format!(
                "Paid {} times since {}, {}, about {} each time.",
                c.len(),
                first.format("%b %-d, %Y"),
                every,
                money(amount)
            );
            out.push(Candidate {
                name: title_case(&key),
                key: key.clone(),
                cadence: cadence.into(),
                amount,
                tolerance_pct: tolerance,
                anchor: fmt_day(anchor),
                next_due: fmt_day(next),
                category,
                count: c.len(),
                first_paid: fmt_day(first),
                last_paid: fmt_day(last),
                monthly: monthly_equivalent(amount, cadence),
                txn_ids: c.iter().map(|t| t.id.clone()).collect(),
                why,
            });
        }
    }
    out.sort_by(|a, b| b.monthly.partial_cmp(&a.monthly).unwrap_or(std::cmp::Ordering::Equal).then(a.key.cmp(&b.key)));
    out
}

// --------------------------------------------------------------------------- spending

/// One payment that counts as spending. The caller decides what counts (its chart of
/// accounts), and passes the share of the row not allocated to a deal.
#[derive(Debug, Clone, Default)]
pub struct SpendRow {
    pub id: String,
    pub posted_at: String,
    pub amount: f64,
    pub category: String,
    /// The chart-of-accounts label for `category` ("Rent & warehouse"), or "" for none.
    pub label: String,
    pub payee: String,
    pub memo: String,
    /// The bill this payment pays, if any, and that bill's name.
    pub bill_id: String,
    pub bill_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CategorySpend {
    pub category: String,
    pub label: String,
    pub amount: f64,
    pub prev_amount: f64,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PayeeSpend {
    pub payee: String,
    pub bill_id: String,
    pub amount: f64,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonthSpend {
    pub month: String,
    pub fixed: f64,
    pub other: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Insight {
    /// 'up', 'down', 'new', 'info'
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpendReport {
    pub total: f64,
    pub prev_total: f64,
    /// Paid toward a bill.
    pub fixed: f64,
    pub other: f64,
    pub by_category: Vec<CategorySpend>,
    pub by_payee: Vec<PayeeSpend>,
    pub months: Vec<MonthSpend>,
    pub insights: Vec<Insight>,
}

fn day_in(d: &str, from: &str, to: &str) -> bool {
    let d = d.get(..10).unwrap_or(d);
    (from.is_empty() || d >= from) && (to.is_empty() || d <= to)
}

fn payee_label(r: &SpendRow) -> (String, String) {
    if !r.bill_id.is_empty() {
        return (format!("bill:{}", r.bill_id), r.bill_name.clone());
    }
    let src = if r.payee.trim().is_empty() { &r.memo } else { &r.payee };
    let key = payee_key(src);
    if key.is_empty() {
        let raw: String = src.trim().chars().take(40).collect();
        (format!("raw:{}", raw.to_ascii_lowercase()), raw)
    } else {
        (format!("key:{key}"), title_case(&key))
    }
}

/// Where the money went between `from` and `to` (inclusive YYYY-MM-DD), against the same
/// number of days just before, plus the twelve months ending with `to`'s month. `rows` must
/// cover `prev_from` .. `to` and the twelve months.
pub fn spending(rows: &[SpendRow], from: &str, to: &str, prev_from: &str, prev_to: &str) -> SpendReport {
    let mut rep = SpendReport {
        total: 0.0,
        prev_total: 0.0,
        fixed: 0.0,
        other: 0.0,
        by_category: Vec::new(),
        by_payee: Vec::new(),
        months: Vec::new(),
        insights: Vec::new(),
    };
    let mut cats: HashMap<String, CategorySpend> = HashMap::new();
    let mut payees: HashMap<String, PayeeSpend> = HashMap::new();
    let mut seen_before: HashSet<String> = HashSet::new();
    for r in rows {
        let key = payee_label(r).0;
        if r.posted_at.get(..10).unwrap_or(&r.posted_at) < from {
            seen_before.insert(key);
        }
    }
    let mut new_payees: HashMap<String, (String, f64)> = HashMap::new();
    for r in rows {
        let cat_key = if r.category.is_empty() { "other_expense".to_string() } else { r.category.clone() };
        if day_in(&r.posted_at, from, to) {
            rep.total += r.amount;
            if r.bill_id.is_empty() { rep.other += r.amount } else { rep.fixed += r.amount }
            let c = cats.entry(cat_key.clone()).or_insert(CategorySpend {
                category: cat_key.clone(),
                label: if r.label.is_empty() { "Other expense".into() } else { r.label.clone() },
                amount: 0.0,
                prev_amount: 0.0,
                count: 0,
            });
            c.amount += r.amount;
            c.count += 1;
            let (pk, pname) = payee_label(r);
            let p = payees.entry(pk.clone()).or_insert(PayeeSpend { payee: pname.clone(), bill_id: r.bill_id.clone(), amount: 0.0, count: 0 });
            p.amount += r.amount;
            p.count += 1;
            if !seen_before.contains(&pk) {
                new_payees.entry(pk).or_insert((pname, 0.0)).1 += r.amount;
            }
        } else if day_in(&r.posted_at, prev_from, prev_to) {
            rep.prev_total += r.amount;
            let c = cats.entry(cat_key.clone()).or_insert(CategorySpend {
                category: cat_key.clone(),
                label: if r.label.is_empty() { "Other expense".into() } else { r.label.clone() },
                amount: 0.0,
                prev_amount: 0.0,
                count: 0,
            });
            c.prev_amount += r.amount;
        }
    }
    let mut by_category: Vec<CategorySpend> = cats.into_values().map(|mut c| {
        c.amount = round2(c.amount);
        c.prev_amount = round2(c.prev_amount);
        c
    }).collect();
    by_category.sort_by(|a, b| b.amount.partial_cmp(&a.amount).unwrap_or(std::cmp::Ordering::Equal).then(a.category.cmp(&b.category)));
    let mut by_payee: Vec<PayeeSpend> = payees.into_values().map(|mut p| {
        p.amount = round2(p.amount);
        p
    }).collect();
    by_payee.sort_by(|a, b| b.amount.partial_cmp(&a.amount).unwrap_or(std::cmp::Ordering::Equal).then(a.payee.cmp(&b.payee)));
    by_payee.truncate(12);

    // Twelve months ending with `to`'s month.
    if let Some(end) = parse_day(to) {
        let mut months: Vec<MonthSpend> = (0..12)
            .rev()
            .map(|i| {
                let d = add_months_keep_day(NaiveDate::from_ymd_opt(end.year(), end.month(), 1).unwrap_or(end), -i);
                MonthSpend { month: d.format("%Y-%m").to_string(), fixed: 0.0, other: 0.0 }
            })
            .collect();
        for r in rows {
            let m = r.posted_at.get(..7).unwrap_or("");
            if let Some(ms) = months.iter_mut().find(|x| x.month == m) {
                if r.bill_id.is_empty() { ms.other += r.amount } else { ms.fixed += r.amount }
            }
        }
        for m in months.iter_mut() {
            m.fixed = round2(m.fixed);
            m.other = round2(m.other);
        }
        rep.months = months;
    }

    // Insights: plain sentences from counts, largest movements first.
    let mut ups: Vec<(f64, String)> = Vec::new();
    for c in &by_category {
        let diff = c.amount - c.prev_amount;
        if c.prev_amount > 0.0 && diff >= 100.0 && diff / c.prev_amount >= 0.25 {
            ups.push((diff, format!(
                "{} is up {}% on the period before ({} more).",
                c.label,
                ((diff / c.prev_amount) * 100.0).round() as i64,
                money(diff)
            )));
        }
    }
    ups.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    for (_, text) in ups.into_iter().take(3) {
        rep.insights.push(Insight { kind: "up".into(), text });
    }
    let mut downs: Vec<(f64, String)> = by_category
        .iter()
        .filter(|c| c.prev_amount >= 100.0 && c.prev_amount - c.amount >= 100.0 && (c.prev_amount - c.amount) / c.prev_amount >= 0.25)
        .map(|c| (c.prev_amount - c.amount, format!("{} is down {} on the period before.", c.label, money(c.prev_amount - c.amount))))
        .collect();
    downs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    for (_, text) in downs.into_iter().take(2) {
        rep.insights.push(Insight { kind: "down".into(), text });
    }
    let mut fresh: Vec<(String, f64)> = new_payees.into_values().filter(|(_, a)| *a >= 100.0).collect();
    fresh.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for (name, amt) in fresh.into_iter().take(3) {
        rep.insights.push(Insight { kind: "new".into(), text: format!("First payment to {name} in this period: {}.", money(amt)) });
    }
    if rep.total > 0.0 && rep.fixed > 0.0 {
        rep.insights.push(Insight {
            kind: "info".into(),
            text: format!("Bills were {}% of what went out.", ((rep.fixed / rep.total) * 100.0).round() as i64),
        });
    }
    rep.total = round2(rep.total);
    rep.prev_total = round2(rep.prev_total);
    rep.fixed = round2(rep.fixed);
    rep.other = round2(rep.other);
    rep.by_category = by_category;
    rep.by_payee = by_payee;
    rep
}

// ------------------------------------------------------------------------ true profit

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProfitMonth {
    pub month: String,
    /// Deal profit, as Analytics shows it.
    pub profit: f64,
    /// Shipping and bank fees not on any deal (Analytics' true net takes these off).
    pub shipping: f64,
    pub fees: f64,
    pub true_net: f64,
    /// Running costs: every spending row except shipping and bank fees, which true net has
    /// already taken off.
    pub operating: f64,
    pub true_profit: f64,
}

/// Spending that true profit takes off on top of true net. Shipping and bank fees are left
/// out: true net already subtracted them, and subtracting them again would count them twice.
pub fn operating_only(r: &SpendRow) -> bool {
    r.category != "shipping" && r.category != "fee"
}

/// Adds running costs to the months Analytics already reports. A month with spending and no
/// deal is added, because rent is still paid in a month nothing closed.
pub fn true_profit(months: &[ProfitMonth], rows: &[SpendRow], from: &str, to: &str) -> Vec<ProfitMonth> {
    let mut by_month: HashMap<String, f64> = HashMap::new();
    for r in rows.iter().filter(|r| operating_only(r) && day_in(&r.posted_at, from, to)) {
        *by_month.entry(r.posted_at.get(..7).unwrap_or("").to_string()).or_default() += r.amount;
    }
    let mut out: Vec<ProfitMonth> = months.to_vec();
    for (m, _) in by_month.iter() {
        if !out.iter().any(|x| &x.month == m) {
            out.push(ProfitMonth { month: m.clone(), ..Default::default() });
        }
    }
    for m in out.iter_mut() {
        m.operating = round2(*by_month.get(&m.month).unwrap_or(&0.0));
        m.true_profit = round2(m.true_net - m.operating);
    }
    out.sort_by(|a, b| a.month.cmp(&b.month));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    fn bill(id: &str, payee: &str, amount: f64, cadence: &str, anchor: &str) -> Bill {
        Bill {
            id: id.into(),
            name: id.into(),
            payee_match: payee.into(),
            amount,
            tolerance_pct: 10.0,
            cadence: cadence.into(),
            anchor: anchor.into(),
            status: "active".into(),
        }
    }

    fn out(id: &str, day: &str, amount: f64, payee: &str) -> Txn {
        Txn {
            id: id.into(),
            posted_at: day.into(),
            amount,
            direction: "out".into(),
            payee: payee.into(),
            memo: payee.into(),
            ..Default::default()
        }
    }

    #[test]
    fn month_end_clamps_and_returns() {
        let a = d("2026-01-31");
        assert_eq!(occurrence(a, "monthly", 1), d("2026-02-28"));
        assert_eq!(occurrence(a, "monthly", 2), d("2026-03-31"));
        assert_eq!(occurrence(a, "monthly", -2), d("2025-11-30"));
        assert_eq!(occurrence(d("2024-01-31"), "monthly", 1), d("2024-02-29"));
        assert_eq!(occurrence(d("2026-01-15"), "quarterly", 1), d("2026-04-15"));
        assert_eq!(occurrence(d("2026-01-02"), "biweekly", 2), d("2026-01-30"));
    }

    #[test]
    fn early_rent_pays_the_coming_due_date() {
        let b = bill("rent", "Oak Street", 2400.0, "monthly", "2026-01-01");
        assert_eq!(period_for(&b, d("2026-02-27")), Some(d("2026-03-01")));
        assert_eq!(period_for(&b, d("2026-03-04")), Some(d("2026-03-01")));
        // Mid-month is nobody's window, but a hand link still finds the nearest due date.
        assert_eq!(period_for(&b, d("2026-03-18")), None);
        assert_eq!(nearest_due(&b, d("2026-03-18")), Some(d("2026-04-01")));
        assert_eq!(nearest_due(&b, d("2026-03-14")), Some(d("2026-03-01")));
    }

    #[test]
    fn zelle_memo_matches_on_words_and_amount() {
        let b = bill("rent", "oak street properties", 2400.0, "monthly", "2026-01-01");
        let t = out("t1", "2026-02-01", 2400.0, "Zelle payment to Oak Street Properties JPM99A1B2");
        assert_eq!(match_payment(&b, &t), Some(d("2026-02-01")));
        let mut wrong_amount = t.clone();
        wrong_amount.amount = 1900.0;
        assert_eq!(match_payment(&b, &wrong_amount), None);
        let mut deal_money = t.clone();
        deal_money.allocated = 2400.0;
        assert_eq!(match_payment(&b, &deal_money), None);
        let mut pending = t.clone();
        pending.pending = true;
        assert_eq!(match_payment(&b, &pending), None);
        let mut money_in = t.clone();
        money_in.direction = "in".into();
        assert_eq!(match_payment(&b, &money_in), None);
        let other = out("t2", "2026-02-01", 2400.0, "Zelle payment to Pine Road LLC");
        assert_eq!(match_payment(&b, &other), None);
    }

    #[test]
    fn a_varying_bill_checks_words_and_date_only() {
        let b = bill("power", "city electric", 0.0, "monthly", "2026-01-20");
        let t = out("t1", "2026-03-22", 311.4, "CITY ELECTRIC AUTOPAY");
        assert_eq!(match_payment(&b, &t), Some(d("2026-03-20")));
    }

    #[test]
    fn auto_links_pick_the_closest_bill_and_never_repeat_a_rejection() {
        let car = bill("car", "ally", 612.0, "monthly", "2026-01-05");
        let truck = bill("truck", "ally", 845.0, "monthly", "2026-01-05");
        let t = out("t1", "2026-02-05", 845.0, "ALLY PAYMT");
        let links = auto_links(&[car.clone(), truck.clone()], &[t.clone()], &HashSet::new());
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].bill_id, "truck");
        assert_eq!(links[0].id, "bp-truck-t1");
        assert_eq!(links[0].period, "2026-02-05");
        let mut known = HashSet::new();
        known.insert("bp-truck-t1".to_string());
        let again = auto_links(&[car, truck], &[t], &known);
        assert!(again.is_empty(), "a rejected link must not come back, got {again:?}");
    }

    #[test]
    fn a_row_already_paying_a_bill_is_not_linked_again() {
        let b = bill("rent", "oak", 1000.0, "monthly", "2026-01-01");
        let mut t = out("t1", "2026-02-01", 1000.0, "oak");
        t.bill_id = "other".into();
        assert!(auto_links(&[b], &[t], &HashSet::new()).is_empty());
    }

    fn link(bill: &str, txn: &str, period: &str, posted: &str, amount: f64) -> Link {
        Link {
            id: link_id(bill, txn),
            bill_id: bill.into(),
            bank_txn_id: txn.into(),
            period: period.into(),
            status: "auto".into(),
            posted_at: posted.into(),
            amount,
        }
    }

    #[test]
    fn state_paid_then_due_soon_then_overdue() {
        let b = bill("rent", "oak", 1000.0, "monthly", "2026-01-01");
        let links = vec![
            link("rent", "a", "2026-01-01", "2026-01-01", 1000.0),
            link("rent", "b", "2026-02-01", "2026-02-02", 1000.0),
        ];
        // Feb paid, next due Mar 1, ten days out.
        let s = bill_state(&b, &links, d("2026-02-19"), Some(d("2026-02-19")));
        assert_eq!(s.status, "paid");
        assert_eq!(s.next_due.as_deref(), Some("2026-03-01"));
        assert_eq!(s.days_until, Some(10));
        assert_eq!(s.paid_count, 2);
        assert_eq!(s.on_time_count, 2);
        // Two days before.
        let s = bill_state(&b, &links, d("2026-02-27"), Some(d("2026-02-27")));
        assert_eq!(s.status, "due_soon");
        // Unpaid past the grace days, and the bank has data past it: overdue.
        let s = bill_state(&b, &links, d("2026-03-05"), Some(d("2026-03-05")));
        assert_eq!(s.status, "overdue");
        assert_eq!(s.overdue, vec!["2026-03-01".to_string()]);
        assert_eq!(s.next_due.as_deref(), Some("2026-04-01"));
        // Same day, but the bank feed stopped on Feb 26: not seen, never overdue.
        let s = bill_state(&b, &links, d("2026-03-05"), Some(d("2026-02-26")));
        assert_eq!(s.status, "not_seen");
        assert!(s.overdue.is_empty());
    }

    #[test]
    fn rejected_links_do_not_count_as_paid() {
        let b = bill("rent", "oak", 1000.0, "monthly", "2026-01-01");
        let mut l = link("rent", "a", "2026-01-01", "2026-01-01", 1000.0);
        l.status = "rejected".into();
        let s = bill_state(&b, &[l], d("2026-01-10"), Some(d("2026-01-10")));
        assert_eq!(s.status, "overdue");
        assert_eq!(s.paid_count, 0);
    }

    #[test]
    fn early_payment_moves_next_due_on() {
        let b = bill("rent", "oak", 1000.0, "monthly", "2026-01-01");
        let links = vec![link("rent", "a", "2026-03-01", "2026-02-27", 1000.0)];
        let s = bill_state(&b, &links, d("2026-02-28"), Some(d("2026-02-28")));
        assert_eq!(s.next_due.as_deref(), Some("2026-04-01"));
        assert!(s.current_paid);
    }

    #[test]
    fn a_future_first_due_date_is_upcoming() {
        let b = bill("ins", "geico", 300.0, "semiannual", "2026-06-15");
        let s = bill_state(&b, &[], d("2026-02-01"), Some(d("2026-02-01")));
        assert_eq!(s.status, "upcoming");
        assert_eq!(s.next_due.as_deref(), Some("2026-06-15"));
        assert!(s.history.is_empty());
    }

    #[test]
    fn old_gaps_stay_in_history_without_the_alarm() {
        let b = bill("rent", "oak", 1000.0, "monthly", "2025-01-01");
        let s = bill_state(&b, &[], d("2025-06-20"), Some(d("2025-06-20")));
        // Only due dates inside the last 90 days alarm.
        assert_eq!(s.overdue, vec!["2025-04-01", "2025-05-01", "2025-06-01"]);
        assert_eq!(s.history.len(), 6);
    }

    #[test]
    fn detect_finds_monthly_rent_by_zelle() {
        let txns = vec![
            out("1", "2026-01-01", 2400.0, "Zelle payment to Oak Street Properties JPM1A"),
            out("2", "2026-01-30", 2400.0, "Zelle payment to Oak Street Properties JPM2B"),
            out("3", "2026-03-02", 2400.0, "Zelle payment to Oak Street Properties JPM3C"),
            out("4", "2026-04-01", 2400.0, "Zelle payment to Oak Street Properties JPM4D"),
            // Noise: one-offs and deal money.
            out("5", "2026-02-11", 88.0, "HOME DEPOT 4411"),
            Txn { allocated: 9000.0, ..out("6", "2026-02-01", 9000.0, "Wire to Big Supplier") },
            Txn { allocated: 9000.0, ..out("7", "2026-03-01", 9000.0, "Wire to Big Supplier") },
            Txn { allocated: 9000.0, ..out("8", "2026-04-01", 9000.0, "Wire to Big Supplier") },
        ];
        let c = detect(&txns, &[], d("2026-04-10"));
        assert_eq!(c.len(), 1, "{c:?}");
        let r = &c[0];
        assert_eq!(r.key, "oak street properties");
        assert_eq!(r.name, "Oak Street Properties");
        assert_eq!(r.cadence, "monthly");
        assert_eq!(r.amount, 2400.0);
        assert_eq!(r.anchor, "2026-01-01");
        assert_eq!(r.next_due, "2026-05-01");
        assert_eq!(r.count, 4);
        // Accepting it links every payment it was found from.
        let b = Bill { id: "b".into(), payee_match: r.key.clone(), amount: r.amount, tolerance_pct: r.tolerance_pct, cadence: r.cadence.clone(), anchor: r.anchor.clone(), status: "active".into(), name: r.name.clone() };
        let links = auto_links(&[b], &txns, &HashSet::new());
        assert_eq!(links.len(), 4, "{links:?}");
        assert_eq!(links.iter().find(|l| l.bank_txn_id == "2").unwrap().period, "2026-02-01");
        // An existing bill with those words hides the suggestion.
        let taken = bill("x", "Oak Street Properties", 2400.0, "monthly", "2026-01-01");
        assert!(detect(&txns, &[taken], d("2026-04-10")).is_empty());
    }

    #[test]
    fn detect_needs_regular_gaps_and_a_recent_payment() {
        let irregular = vec![
            out("1", "2026-01-01", 50.0, "CORNER CAFE"),
            out("2", "2026-01-04", 50.0, "CORNER CAFE"),
            out("3", "2026-03-20", 50.0, "CORNER CAFE"),
            out("4", "2026-03-22", 50.0, "CORNER CAFE"),
        ];
        assert!(detect(&irregular, &[], d("2026-03-25")).is_empty());
        let stopped = vec![
            out("1", "2025-01-05", 612.0, "ALLY PAYMT"),
            out("2", "2025-02-05", 612.0, "ALLY PAYMT"),
            out("3", "2025-03-05", 612.0, "ALLY PAYMT"),
        ];
        assert!(detect(&stopped, &[], d("2026-03-25")).is_empty());
        let weekly = vec![
            out("1", "2026-03-02", 75.0, "FUEL CARD"),
            out("2", "2026-03-09", 80.0, "FUEL CARD"),
            out("3", "2026-03-16", 72.0, "FUEL CARD"),
        ];
        let c = detect(&weekly, &[], d("2026-03-18"));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].cadence, "weekly");
        assert_eq!(c[0].key, "fuel");
    }

    #[test]
    fn detect_splits_two_policies_with_one_insurer() {
        let txns = vec![
            out("1", "2026-01-10", 120.0, "STATE MUTUAL INS"),
            out("2", "2026-01-12", 480.0, "STATE MUTUAL INS"),
            out("3", "2026-02-10", 120.0, "STATE MUTUAL INS"),
            out("4", "2026-02-12", 480.0, "STATE MUTUAL INS"),
            out("5", "2026-03-10", 120.0, "STATE MUTUAL INS"),
            out("6", "2026-03-12", 480.0, "STATE MUTUAL INS"),
        ];
        let c = detect(&txns, &[], d("2026-03-20"));
        assert_eq!(c.len(), 2, "{c:?}");
        assert_eq!(c[0].amount, 480.0);
        assert_eq!(c[1].amount, 120.0);
    }

    #[test]
    fn payee_key_drops_rails_and_references() {
        assert_eq!(payee_key("Zelle payment to Oak Street Properties JPM99A1B2"), "oak street properties");
        assert_eq!(payee_key("ACH DEBIT GEICO *AUTO PPD ID: 123456"), "geico");
        assert_eq!(payee_key("123 456"), "");
    }

    fn spend(id: &str, day: &str, amount: f64, cat: &str, label: &str, payee: &str, bill: &str) -> SpendRow {
        SpendRow {
            id: id.into(),
            posted_at: day.into(),
            amount,
            category: cat.into(),
            label: label.into(),
            payee: payee.into(),
            memo: payee.into(),
            bill_id: bill.into(),
            bill_name: if bill.is_empty() { String::new() } else { format!("Bill {bill}") },
        }
    }

    #[test]
    fn spending_splits_fixed_from_other_and_compares_periods() {
        let rows = vec![
            spend("1", "2026-02-01", 2400.0, "rent", "Rent & warehouse", "oak", "rent"),
            spend("2", "2026-02-10", 200.0, "software", "Software & subscriptions", "Acme Cloud 77", ""),
            spend("3", "2026-03-01", 2400.0, "rent", "Rent & warehouse", "oak", "rent"),
            spend("4", "2026-03-10", 450.0, "software", "Software & subscriptions", "Acme Cloud 78", ""),
            spend("5", "2026-03-15", 300.0, "office", "Office & supplies", "Paper Barn", ""),
        ];
        let r = spending(&rows, "2026-03-01", "2026-03-31", "2026-01-29", "2026-02-28");
        assert_eq!(r.total, 3150.0);
        assert_eq!(r.prev_total, 2600.0);
        assert_eq!(r.fixed, 2400.0);
        assert_eq!(r.other, 750.0);
        assert_eq!(r.by_category[0].category, "rent");
        let sw = r.by_category.iter().find(|c| c.category == "software").unwrap();
        assert_eq!((sw.amount, sw.prev_amount), (450.0, 200.0));
        assert_eq!(r.by_payee[0].payee, "Bill rent");
        assert!(r.insights.iter().any(|i| i.kind == "up" && i.text.starts_with("Software & subscriptions is up 125%")), "{:?}", r.insights);
        assert!(r.insights.iter().any(|i| i.kind == "new" && i.text.contains("Paper Barn")), "{:?}", r.insights);
        assert!(!r.insights.iter().any(|i| i.kind == "new" && i.text.contains("Acme")), "{:?}", r.insights);
        assert_eq!(r.months.len(), 12);
        assert_eq!(r.months[11], MonthSpend { month: "2026-03".into(), fixed: 2400.0, other: 750.0 });
        assert_eq!(r.months[10], MonthSpend { month: "2026-02".into(), fixed: 2400.0, other: 200.0 });
    }

    #[test]
    fn true_profit_never_takes_shipping_or_fees_twice() {
        let months = vec![ProfitMonth { month: "2026-03".into(), profit: 10000.0, shipping: 500.0, fees: 50.0, true_net: 9450.0, ..Default::default() }];
        let rows = vec![
            spend("1", "2026-03-01", 2400.0, "rent", "", "oak", "rent"),
            spend("2", "2026-03-03", 500.0, "shipping", "", "freight co", ""),
            spend("3", "2026-03-04", 50.0, "fee", "", "bank", ""),
            spend("4", "2026-04-01", 2400.0, "rent", "", "oak", "rent"),
        ];
        let out = true_profit(&months, &rows, "2026-03-01", "2026-04-30");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].operating, 2400.0);
        assert_eq!(out[0].true_profit, 7050.0);
        // April had rent and no deal: it still shows, as a loss.
        assert_eq!(out[1].month, "2026-04");
        assert_eq!(out[1].true_profit, -2400.0);
    }

    #[test]
    fn money_reads_like_a_person_wrote_it() {
        assert_eq!(money(2400.0), "$2,400");
        assert_eq!(money(1234567.5), "$1,234,567.50");
        assert_eq!(money(12.0), "$12");
    }
}
