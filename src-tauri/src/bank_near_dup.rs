//! R-456 (Jack, 2026-10-06: "i have a duplicate transaction wire in the ledger ... they have
//! slightly different title but shows twice as the same exact number sent ... i need to ensure
//! this wont happen ever").
//!
//! The R-287 rule (`bank_dedup.rs` on the desktop) removes a copy only when it is identical on
//! every detail, and every import guard compares the memo text or a bank reference. Two copies
//! of one payment with different titles were never even compared: a wire's pending copy and its
//! posted copy, a statement row beside the bank feed's row, or two bank connections. This finds
//! them: same account, same direction, the same amount to the cent, dated within a few days.
//!
//! What it reports is a pair to review, never a removal, with one exception it marks
//! `automatic`: the bank's PENDING copy beside the posted copy that replaced it, when nothing was
//! booked to the pending copy. That retires no real money (the bank never posts a pending row
//! twice) and it is the gap R-437 left open.
//!
//! Identical rows from one bank connection are left alone: R-287 found those are two real
//! charges (two same-day fees). A pair someone answered "two real payments" for is never asked
//! again (`not_dup`, stored on both rows as `raw_json.nd`).
//!
//! Pure: no database, no `use crate::`. Byte-identical in both repos (desktop
//! `src-tauri/src/bank_near_dup.rs`, server `src/bank_near_dup.rs`).

use std::collections::{HashMap, HashSet};

/// One bank row as the rule reads it.
#[derive(Clone, Debug, Default)]
pub struct NdRow {
    pub id: String,
    /// The account label ("BUS CHECKING ··1234", a statement's own name, "Cash").
    pub account: String,
    /// `posted_at`; only the first ten characters (the day) are read.
    pub date: String,
    pub amount: f64,
    /// "in" or "out".
    pub dir: String,
    pub desc: String,
    /// `source_format`: plaid, ofx, csv, pdf, ai, manual_cash.
    pub source: String,
    /// The Plaid account id the row came through (`raw_json.pa`), "" when unknown.
    pub conn: String,
    /// Still pending at the bank (`raw_json.pnd`).
    pub pending: bool,
    /// Retracted by the bank and kept for its booking (`raw_json.rtr`); the R-289 take-over's.
    pub retracted: bool,
    /// Tied to money elsewhere: a deal, refund, loan, purchase, expense or bill.
    pub linked: bool,
    /// A person booked it.
    pub reviewed: bool,
    /// Rows someone said are a different payment from this one (`raw_json.nd`).
    pub not_dup: Vec<String>,
    pub created_at: String,
}

/// One likely duplicate: `extra_id` is the copy to retire, `keep_id` the one that stays.
#[derive(Clone, Debug, serde::Serialize)]
pub struct NearDup {
    pub keep_id: String,
    pub extra_id: String,
    /// pending_and_posted | two_sources | two_connections | different_text
    pub reason: &'static str,
    pub gap_days: i64,
    /// Safe without asking: the extra is the bank's pending copy, unbooked, beside its posted copy.
    pub automatic: bool,
}

/// How far apart the two dates may be. A wire or transfer posts a day or two after it is
/// pending; a statement's date can differ from the feed's by the weekend.
pub const WINDOW_DAYS: i64 = 5;

/// Below this, a pair whose only difference is the title is not asked about: two different
/// card charges of the same small amount in one week are common; a repeated wire is not.
pub const MIN_AMOUNT_TEXT_ONLY: f64 = 100.0;

const MASK_SEP: &str = " \u{00b7}\u{00b7}";

/// The account a row is on: the last-4 of a bank label when it has one (so a renamed account
/// still matches itself), otherwise the label itself.
fn account_key(label: &str) -> String {
    match label.rsplit_once(MASK_SEP) {
        Some((_, m)) if !m.trim().is_empty() => format!("mask:{}", m.trim()),
        _ => format!("label:{}", label.trim().to_lowercase()),
    }
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn day(s: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}

fn strength(reason: &str) -> u8 {
    match reason {
        "pending_and_posted" => 4,
        "two_sources" => 3,
        "two_connections" => 2,
        _ => 1,
    }
}

/// Which copy stays: posted over pending, booked over unbooked, the bank feed over a statement,
/// then the older row (it is the one people have been looking at), then the id.
fn keeps_first(a: &NdRow, b: &NdRow) -> bool {
    let score = |r: &NdRow| (!r.pending as u8) * 4 + ((r.linked || r.reviewed) as u8) * 2 + (r.source == "plaid") as u8;
    let (sa, sb) = (score(a), score(b));
    if sa != sb { return sa > sb; }
    if a.created_at != b.created_at && !a.created_at.is_empty() && !b.created_at.is_empty() {
        return a.created_at < b.created_at;
    }
    a.id < b.id
}

/// Why two rows of the same account, direction and amount, close in date, look like one payment;
/// `None` when they do not.
fn reason_for(a: &NdRow, b: &NdRow) -> Option<&'static str> {
    if a.pending && b.pending { return None; }
    if a.pending != b.pending { return Some("pending_and_posted"); }
    if (a.source == "plaid") != (b.source == "plaid") { return Some("two_sources"); }
    if !a.conn.is_empty() && !b.conn.is_empty() && a.conn != b.conn { return Some("two_connections"); }
    if norm(&a.desc) != norm(&b.desc) && a.amount >= MIN_AMOUNT_TEXT_ONLY { return Some("different_text"); }
    None
}

/// Every likely duplicate, each row in at most one pair (the strongest, then the closest).
pub fn near_duplicates(rows: &[NdRow]) -> Vec<NearDup> {
    let mut groups: HashMap<(String, String, i64), Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if r.amount <= 0.005 || r.retracted || day(&r.date).is_none() { continue; }
        let acct = account_key(&r.account);
        if acct == "label:cash" { continue; }
        groups.entry((acct, r.dir.clone(), (r.amount * 100.0).round() as i64)).or_default().push(i);
    }
    let mut cands: Vec<(u8, i64, usize, usize, &'static str)> = Vec::new();
    for idx in groups.values() {
        for x in 0..idx.len() {
            for y in (x + 1)..idx.len() {
                let (a, b) = (&rows[idx[x]], &rows[idx[y]]);
                if a.id == b.id || a.not_dup.contains(&b.id) || b.not_dup.contains(&a.id) { continue; }
                let gap = match (day(&a.date), day(&b.date)) { (Some(p), Some(q)) => (p - q).num_days().abs(), _ => continue };
                if gap > WINDOW_DAYS { continue; }
                let Some(reason) = reason_for(a, b) else { continue };
                let (k, e) = if keeps_first(a, b) { (idx[x], idx[y]) } else { (idx[y], idx[x]) };
                cands.push((strength(reason), gap, k, e, reason));
            }
        }
    }
    cands.sort_by(|p, q| q.0.cmp(&p.0).then(p.1.cmp(&q.1)).then(rows[p.3].id.cmp(&rows[q.3].id)));
    let mut used: HashSet<usize> = HashSet::new();
    let mut out = Vec::new();
    for (_, gap, k, e, reason) in cands {
        if used.contains(&k) || used.contains(&e) { continue; }
        used.insert(k);
        used.insert(e);
        let extra = &rows[e];
        out.push(NearDup {
            keep_id: rows[k].id.clone(),
            extra_id: extra.id.clone(),
            reason,
            gap_days: gap,
            automatic: reason == "pending_and_posted" && extra.pending && !extra.linked && !extra.reviewed,
        });
    }
    out.sort_by(|p, q| p.extra_id.cmp(&q.extra_id));
    out
}

/// The `raw_json.nd` list ("not a duplicate of") read from a row's raw_json.
pub fn not_dup_of(raw_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(raw_json).ok()
        .and_then(|v| v.get("nd").and_then(|n| n.as_array()).cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// `raw_json` with `other` added to its `nd` list (kept as an object; a non-object becomes one).
pub fn with_not_dup(raw_json: &str, other: &str) -> String {
    let mut v = serde_json::from_str::<serde_json::Value>(raw_json).ok()
        .filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}));
    let o = v.as_object_mut().expect("object");
    let mut list: Vec<serde_json::Value> = o.get("nd").and_then(|n| n.as_array()).cloned().unwrap_or_default();
    if !list.iter().any(|x| x.as_str() == Some(other)) { list.push(serde_json::Value::String(other.to_string())); }
    o.insert("nd".into(), serde_json::Value::Array(list));
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, acct: &str, date: &str, amount: f64, desc: &str) -> NdRow {
        NdRow { id: id.into(), account: acct.into(), date: date.into(), amount, dir: "out".into(), desc: desc.into(),
                source: "plaid".into(), conn: "pa1".into(), created_at: format!("2026-10-0{}", id.len()), ..Default::default() }
    }
    const A: &str = "BUS CHECKING \u{00b7}\u{00b7}1234";

    #[test]
    fn the_wire_with_two_titles_is_found() {
        let rows = vec![
            row("w1", A, "2026-10-03", 12540.0, "WIRE TYPE:WIRE OUT DATE:251003 TRN:2025100300123"),
            row("w2", A, "2026-10-03", 12540.0, "Online Domestic Wire Transfer Via: ACME"),
        ];
        let d = near_duplicates(&rows);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].reason, d[0].automatic), ("different_text", false));
    }

    #[test]
    fn pending_beside_posted_is_automatic_only_when_nothing_is_booked_to_it() {
        let mut p = row("p", A, "2026-10-02", 900.0, "PENDING WIRE");
        p.pending = true;
        let q = row("q", A, "2026-10-04", 900.0, "WIRE OUT ACME");
        let d = near_duplicates(&[p.clone(), q.clone()]);
        assert_eq!((d[0].keep_id.as_str(), d[0].extra_id.as_str(), d[0].automatic), ("q", "p", true));
        p.reviewed = true;
        assert!(!near_duplicates(&[p, q])[0].automatic);
    }

    #[test]
    fn real_repeats_and_answered_pairs_are_left_alone() {
        // Two identical same-day fees from one connection: two real charges (R-287).
        assert!(near_duplicates(&[row("f1", A, "2026-10-03", 25.0, "WIRE FEE"), row("f2", A, "2026-10-03", 25.0, "WIRE FEE")]).is_empty());
        // A small amount differing only by title is not asked about.
        assert!(near_duplicates(&[row("c1", A, "2026-10-03", 40.0, "SHELL OIL"), row("c2", A, "2026-10-04", 40.0, "AMAZON")]).is_empty());
        // Too far apart, another account, another direction.
        assert!(near_duplicates(&[row("x1", A, "2026-10-01", 5000.0, "WIRE A"), row("x2", A, "2026-10-09", 5000.0, "WIRE B")]).is_empty());
        let mut other = row("o2", "SAVINGS \u{00b7}\u{00b7}9999", "2026-10-01", 5000.0, "WIRE B");
        assert!(near_duplicates(&[row("o1", A, "2026-10-01", 5000.0, "WIRE A"), other.clone()]).is_empty());
        other.account = A.into();
        other.dir = "in".into();
        assert!(near_duplicates(&[row("o1", A, "2026-10-01", 5000.0, "WIRE A"), other]).is_empty());
        // Answered "two real payments".
        let mut a = row("n1", A, "2026-10-01", 5000.0, "WIRE A");
        a.not_dup = vec!["n2".into()];
        assert!(near_duplicates(&[a, row("n2", A, "2026-10-02", 5000.0, "WIRE B")]).is_empty());
    }

    #[test]
    fn a_statement_row_beside_the_feed_keeps_the_feed_and_a_renamed_account_still_matches() {
        let mut s = row("s1", "CHASE PLATINUM \u{00b7}\u{00b7}1234", "2026-10-03", 300.0, "ACME SUPPLY");
        s.source = "csv".into();
        s.conn = String::new();
        let d = near_duplicates(&[s, row("p1", A, "2026-10-03", 300.0, "ACME SUPPLY")]);
        assert_eq!((d[0].keep_id.as_str(), d[0].reason), ("p1", "two_sources"));
    }

    #[test]
    fn three_copies_pair_once_each_and_the_answer_is_stored_in_raw_json() {
        let rows = vec![row("a", A, "2026-10-01", 7000.0, "W 1"), row("b", A, "2026-10-01", 7000.0, "W 2"), row("c", A, "2026-10-02", 7000.0, "W 3")];
        let d = near_duplicates(&rows);
        assert_eq!(d.len(), 1);
        let rj = with_not_dup(r#"{"pa":"x","nd":["q"]}"#, "z");
        assert_eq!(not_dup_of(&rj), vec!["q".to_string(), "z".to_string()]);
        assert_eq!(not_dup_of(&with_not_dup("", "z")), vec!["z".to_string()]);
    }
}
