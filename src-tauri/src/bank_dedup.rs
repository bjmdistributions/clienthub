//! R-287 — deciding which bank transactions are the same real transaction.
//!
//! The pure half of `dedupe_bank_txns` and of `plaid_sync`'s account matching: no pool, no
//! oplog, no clock. Every rule here decides whether money is DELETED, so every rule is a
//! plain function over rows that a test can hand a fixture — including a copy of the live
//! book (`live_book_plan`, ignored by default).
//!
//! What it was written for (2026-09-14): Chase upgraded the business account and renamed it,
//! one product name to another. Same last-4, the same Plaid account id delivering rows under
//! both names, over 99% of transactions identical — but the account NAME was part of every
//! duplicate check, so a re-pull put sixteen months of history on the books a second time and
//! not one row looked like a duplicate.
//!
//! The rule the whole module holds to: a duplicate is the same transaction seen twice —
//! identical account, date, amount, direction and memo, with no stored detail (merchant,
//! payment metadata, bank timestamp, check number, wire reference, statement id) that
//! disagrees. A field only one copy carries is not a disagreement; a field both carry and
//! that differs sends the group to a person instead of deleting anything.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::commands::bank_txn_reference;

/// One `bank_txn` row — as much of it as the duplicate decision reads.
#[derive(Clone, Debug, Default)]
pub struct TxnRow {
    pub id: String,
    pub account: String,
    pub date: String,
    pub amount: f64,
    pub dir: String,
    pub desc: String,
    pub memo_raw: String,
    pub check_num: String,
    pub wire_ref: String,
    pub fitid: String,
    pub raw_json: String,
    pub imported_at: String,
    pub created_at: String,
    /// `reviewed = 1`: a person booked it.
    pub reviewed: bool,
    /// Tied to money somewhere else — an allocation, refund, loan, cash purchase, business
    /// expense, or the loan-repayment tag. A linked row is never removed by this module.
    pub linked: bool,
    pub category: String,
    pub counterparty_name: String,
    pub counterparty_type: String,
    pub counterparty_id: String,
    pub note: String,
    pub confirmed_method: String,
}

/// The provenance `plaid_sync` stamps into `raw_json`. Empty strings when absent.
#[derive(Default)]
struct Meta {
    pa: String,
    dt: String,
    merchant: String,
    pm: BTreeMap<String, String>,
    /// Plaid's `pending` flag (R-289), stamped since v0.16.63. False when absent.
    pending: bool,
    /// The bank retracted this row and it was kept because it holds booked work.
    retracted: bool,
}

fn meta(raw: &str) -> Meta {
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(raw) else { return Meta::default() };
    let s = |k: &str| o.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let mut pm = BTreeMap::new();
    if let Some(Value::Object(m)) = o.get("pm") {
        for (k, v) in m {
            if let Some(x) = v.as_str().map(str::trim).filter(|x| !x.is_empty()) {
                pm.insert(k.clone(), x.to_string());
            }
        }
    }
    Meta {
        pa: s("pa"), dt: s("dt"), merchant: s("merchant"), pm,
        pending: o.get("pnd").and_then(|v| v.as_bool()).unwrap_or(false),
        retracted: o.get("rtr").is_some_and(|v| !v.is_null()),
    }
}

/// (pending at the bank, retracted by the bank) as stamped in `raw_json`.
pub fn pending_and_retracted(raw: &str) -> (bool, bool) {
    let m = meta(raw);
    (m.pending, m.retracted)
}

/// One posted transaction that has taken over (or could take over) the booking of a copy the
/// bank retracted or has not posted yet (R-289).
#[derive(Clone, Debug, serde::Serialize)]
pub struct Takeover {
    /// The booked copy — retracted by the bank, or still pending.
    pub from_id: String,
    /// The posted copy the booking moves onto.
    pub to_id: String,
    /// Same amount to the cent, within 7 days, and the only candidate on both sides — safe to
    /// carry over without asking.
    pub automatic: bool,
}

/// R-289 — "I book something and the next day it undoes itself and I book it again."
///
/// A card charge is pending when Jack books it. When it posts, Plaid retracts the pending id and
/// sends the posted charge under a NEW id — and for card accounts usually without
/// `pending_transaction_id`, so `settle_pending_twin` has nothing to pair on. The posted copy
/// imports unbooked (correctly: a same-connection content match is churn, gotchas §11), the
/// booked pending copy is KEPT with `raw_json.rtr` (booked work is never deleted), and the same
/// money is on the books twice: once booked, once asking to be booked again.
///
/// The pairing here is the bank-less half of that settle. A candidate pair is a booked copy the
/// bank has RETRACTED (or, for a chip only, one still pending) and a posted, non-retracted copy
/// on the same account, same direction, dated from one day before to ten days after, with an
/// amount within 30% (card holds settle for a different amount: tips, hotel incidentals).
///
/// Automatic only when the retracted copy and the posted copy match to the cent within seven
/// days and each is the other's ONLY candidate. That is safe even when it is wrong about which
/// charge is which: the bank has already said the retracted row does not exist, so retiring it
/// removes no real money — the worst case is its category landing on the posted charge, which is
/// reported and visible. Everything else is a one-click chip for a person.
pub fn takeover_pairs(rows: &[TxnRow], aliases: &HashMap<String, String>) -> Vec<Takeover> {
    let acct_of = |a: &str| aliases.get(a).cloned().unwrap_or_else(|| a.to_string());
    let metas: Vec<Meta> = rows.iter().map(|r| meta(&r.raw_json)).collect();
    // From: booked, and retracted or still pending.
    let froms: Vec<usize> = (0..rows.len())
        .filter(|&i| (rows[i].reviewed || rows[i].linked) && (metas[i].retracted || metas[i].pending))
        .collect();
    // To: posted and not retracted.
    let tos: Vec<usize> = (0..rows.len())
        .filter(|&i| !metas[i].retracted && !metas[i].pending && !rows[i].date.is_empty())
        .collect();
    let mut by_from: BTreeMap<usize, Vec<(usize, bool)>> = BTreeMap::new();
    let mut by_to: BTreeMap<usize, Vec<(usize, bool)>> = BTreeMap::new();
    for &f in &froms {
        let fr = &rows[f];
        let f_acct = acct_of(&fr.account);
        let f_words = merchant_words(&fr.desc);
        for &t in &tos {
            let tr = &rows[t];
            if t == f || tr.dir != fr.dir || fr.amount <= 0.0 { continue; }
            let same_label = acct_of(&tr.account) == f_acct;
            let same_mask = !label_mask(&tr.account).is_empty() && label_mask(&tr.account) == label_mask(&fr.account);
            if !same_label && !same_mask { continue; }
            let Some(gap) = signed_day_gap(&tr.date, &fr.date) else { continue };
            if !(-1..=10).contains(&gap) { continue; }
            let same_amount = (tr.amount - fr.amount).abs() < 0.005;
            // A different settled amount (a hold, a tip) is a candidate only when the memo names
            // the same merchant — measured on the live book, amount alone matched a $400 hotel
            // hold to five unrelated restaurant and car-rental charges.
            if !same_amount && ((tr.amount - fr.amount).abs() > fr.amount * 0.30 || f_words.is_disjoint(&merchant_words(&tr.desc))) {
                continue;
            }
            let exact = same_label && metas[f].retracted && same_amount && gap <= 7;
            by_from.entry(f).or_default().push((t, exact));
            by_to.entry(t).or_default().push((f, exact));
        }
    }
    // Automatic: a closed cluster of identical copies. Every retracted copy in it matches every
    // posted copy in it exactly and nothing outside it, and every posted copy's only
    // candidates are those retracted copies. Identical amounts on one account in one week, so
    // which retracted copy lands on which posted copy changes nothing; pair them one for one in
    // date order. A cluster with more retracted than posted copies leaves the extras kept.
    let mut automatic: HashSet<(usize, usize)> = HashSet::new();
    let mut seen: HashSet<usize> = HashSet::new();
    for (&f, cands) in &by_from {
        if seen.contains(&f) || !cands.iter().all(|&(_, e)| e) { continue; }
        let tos_set: BTreeSet<usize> = cands.iter().map(|&(t, _)| t).collect();
        let froms_set: BTreeSet<usize> = tos_set.iter()
            .flat_map(|t| by_to[t].iter().map(|&(ff, _)| ff)).collect();
        let closed = froms_set.iter().all(|ff| {
            by_from[ff].iter().all(|&(_, e)| e)
                && by_from[ff].iter().map(|&(t, _)| t).collect::<BTreeSet<_>>() == tos_set
        }) && tos_set.iter().all(|t| by_to[t].iter().all(|&(_, e)| e));
        seen.extend(froms_set.iter().cloned());
        if !closed { continue; }
        let by_date = |s: &BTreeSet<usize>| {
            let mut v: Vec<usize> = s.iter().cloned().collect();
            v.sort_by(|a, b| rows[*a].date.cmp(&rows[*b].date).then(rows[*a].id.cmp(&rows[*b].id)));
            v
        };
        for (ff, t) in by_date(&froms_set).into_iter().zip(by_date(&tos_set)) {
            automatic.insert((ff, t));
        }
    }
    let mut out = Vec::new();
    for (f, cands) in &by_from {
        let paired = automatic.iter().any(|&(ff, _)| ff == *f);
        for &(t, _) in cands {
            let auto = automatic.contains(&(*f, t));
            // A retracted copy already paired automatically offers no chips elsewhere.
            if paired && !auto { continue; }
            out.push(Takeover { from_id: rows[*f].id.clone(), to_id: rows[t].id.clone(), automatic: auto });
        }
    }
    out
}

/// The words in a memo that can name a merchant: letters only, four or more, minus the words
/// every card and bank memo shares.
fn merchant_words(desc: &str) -> HashSet<String> {
    const COMMON: [&str; 16] = ["aplpay", "online", "payment", "transfer", "debit", "credit", "card", "purchase",
        "wire", "domestic", "front", "desk", "recd", "from", "with", "zelle"];
    desc.split(|c: char| !c.is_ascii_alphabetic())
        .map(|w| w.to_lowercase())
        .filter(|w| w.len() >= 4 && !COMMON.contains(&w.as_str()))
        .collect()
}

/// `newer - older` in days, keeping the sign.
fn signed_day_gap(newer: &str, older: &str) -> Option<i64> {
    let d = |s: &str| chrono::NaiveDate::parse_from_str(&s[..s.len().min(10)], "%Y-%m-%d").ok();
    Some((d(newer)? - d(older)?).num_days())
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

const MASK_SEP: &str = " \u{00b7}\u{00b7}";

/// The last-4 in a Plaid label ("BUS CHECKING ··1234" -> "1234"); "" when there is none.
pub fn label_mask(label: &str) -> &str {
    label.rsplit_once(MASK_SEP).map(|(_, m)| m.trim()).unwrap_or("")
}

/// The product name in a Plaid label, lowercased ("BUS CHECKING ··1234" -> "bus checking").
pub fn product_name(label: &str) -> String {
    label.split(MASK_SEP).next().unwrap_or(label).trim().to_lowercase()
}

/// The first stored detail on which two copies DISAGREE: both carry a value and the values
/// differ. `with_memo` is false for the same-reference pass, where the memo and the bank
/// timestamp legitimately differ because the date moved.
pub fn metadata_conflict(a: &TxnRow, b: &TxnRow, with_memo: bool) -> Option<&'static str> {
    let differ = |x: &str, y: &str| {
        let (x, y) = (norm(x), norm(y));
        !x.is_empty() && !y.is_empty() && x != y
    };
    if with_memo && differ(&a.memo_raw, &b.memo_raw) { return Some("memo"); }
    if differ(&a.check_num, &b.check_num) { return Some("check number"); }
    if differ(&a.wire_ref, &b.wire_ref) { return Some("wire reference"); }
    if differ(&a.fitid, &b.fitid) { return Some("statement id"); }
    let (ma, mb) = (meta(&a.raw_json), meta(&b.raw_json));
    if with_memo && differ(&ma.dt, &mb.dt) { return Some("bank timestamp"); }
    if differ(&ma.merchant, &mb.merchant) { return Some("merchant"); }
    for (k, v) in &ma.pm {
        if let Some(w) = mb.pm.get(k) {
            if differ(v, w) { return Some("payment details"); }
        }
    }
    None
}

fn field_ok(x: &str, y: &str) -> bool {
    let (x, y) = (norm(x), norm(y));
    x.is_empty() || y.is_empty() || x == y
}

/// The fields only a person writes — a note, a confirmed payment method, a counterparty tag —
/// agree (or one side is empty). Checked for EVERY removed copy: an unbooked copy can still
/// carry a supplier tag or a note that must not vanish.
pub fn hand_fields_compatible(loser: &TxnRow, survivor: &TxnRow) -> bool {
    field_ok(&loser.note, &survivor.note)
        && field_ok(&loser.confirmed_method, &survivor.confirmed_method)
        // counterparty_type + counterparty_id are one fact (a tag); compared as a pair.
        && (loser.counterparty_type.trim().is_empty() || survivor.counterparty_type.trim().is_empty()
            || (norm(&loser.counterparty_type) == norm(&survivor.counterparty_type)
                && loser.counterparty_id.trim() == survivor.counterparty_id.trim()))
}

/// Can a BOOKED `loser`'s booking be folded into `survivor` without losing or contradicting
/// anything? Every booking field must be equal, or empty on one side (the gap is carried).
/// Category and counterparty name are compared only here: on an unbooked row they are the
/// importer's guess, and a booked survivor's own choice rightly wins over it.
pub fn booking_compatible(loser: &TxnRow, survivor: &TxnRow) -> bool {
    field_ok(&loser.category, &survivor.category)
        && field_ok(&loser.counterparty_name, &survivor.counterparty_name)
        && hand_fields_compatible(loser, survivor)
}

/// Import-time account identity for `plaid_sync`: is `existing` (a label already on the books)
/// the same bank account as `incoming` (the label the bank sends today)?
///
/// Same label, or the same after a confirmed alias — as before. New: the same last-4 under a
/// different product name is a RENAME (the Chase upgrade), unless `live` holds `existing` —
/// the caller passes the labels reported by the item being synced and by items at OTHER
/// banks, never by another item at the same bank (a broken connection keeps its old names).
pub fn same_account(existing: &str, incoming: &str, live: &HashSet<String>, aliases: &HashMap<String, String>) -> bool {
    if existing == incoming { return true; }
    let via = |l: &str| aliases.get(l).cloned().unwrap_or_else(|| l.to_string());
    if via(existing) == via(incoming) { return true; }
    let mask = label_mask(incoming);
    !mask.is_empty() && label_mask(existing) == mask && !live.contains(existing)
}

fn content_key(r: &TxnRow) -> String {
    format!("{}|{:.2}|{}|{}", r.date, r.amount, r.dir, norm(&r.desc))
}

/// Strict content fingerprint. Two distinct memos never share one — deliberately not loosened.
pub fn fingerprint(account: &str, r: &TxnRow) -> String {
    format!("{}|{}", account.trim().to_lowercase(), content_key(r))
}

fn day_gap(a: &str, b: &str) -> Option<i64> {
    let d = |s: &str| chrono::NaiveDate::parse_from_str(&s[..s.len().min(10)], "%Y-%m-%d").ok();
    Some((d(a)? - d(b)?).num_days().abs())
}

/// One label folded into another.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Fold {
    pub from: String,
    pub to: String,
    /// Why the two labels are one account: "same connection" | "bank references" |
    /// "matching history" | "masks" (the older different-last-4 rule).
    pub proof: &'static str,
}

/// Labels that are ONE account renamed by the bank: the same last-4, a different product
/// name, and proof that cannot hold for two genuinely different accounts —
///
/// * **same connection**: one Plaid account id delivered rows under both names. Plaid's
///   account id names one account; it cannot be two.
/// * **bank references**: at least 95% of the smaller label's rows have an identical twin on
///   the other, and at least two of the shared transactions carry the payment rail's own
///   reference (TRN / IMAD / TRACE# / TRANSACTION# / Zelle token) in the same direction.
///   Those references are unique per payment; two accounts do not share them one-way.
/// * **matching history**: the same 95%, over at least 20 twins and 10 distinct memos.
///
/// Survivor: the name that appeared most recently (the bank's current name).
pub fn detect_renames(rows: &[TxnRow]) -> Vec<Fold> {
    #[derive(Default)]
    struct L { keys: HashMap<String, usize>, sample: HashMap<String, String>, n: usize, pas: HashSet<String>, first_import: String, last_posted: String }
    let mut per: BTreeMap<&str, L> = BTreeMap::new();
    for r in rows {
        if label_mask(&r.account).is_empty() { continue; }
        let e = per.entry(r.account.as_str()).or_default();
        let k = content_key(r);
        *e.keys.entry(k.clone()).or_default() += 1;
        e.sample.entry(k).or_insert_with(|| r.desc.clone());
        e.n += 1;
        let pa = meta(&r.raw_json).pa;
        if !pa.is_empty() { e.pas.insert(pa); }
        if !r.imported_at.is_empty() && (e.first_import.is_empty() || r.imported_at < e.first_import) {
            e.first_import = r.imported_at.clone();
        }
        if r.date > e.last_posted { e.last_posted = r.date.clone(); }
    }
    let labels: Vec<&str> = per.keys().cloned().collect();
    // Proven edges, then connected components so three names for one account fold into one.
    let mut parent: HashMap<&str, &str> = labels.iter().map(|l| (*l, *l)).collect();
    fn root<'a>(p: &HashMap<&'a str, &'a str>, mut x: &'a str) -> &'a str {
        while p[x] != x { x = p[x]; }
        x
    }
    let mut proof_of: HashMap<&str, &'static str> = HashMap::new();
    for i in 0..labels.len() {
        for j in (i + 1)..labels.len() {
            let (la, lb) = (labels[i], labels[j]);
            if label_mask(la) != label_mask(lb) || product_name(la) == product_name(lb) { continue; }
            let (a, b) = (&per[la], &per[lb]);
            let mut twins = 0usize;
            let mut ref_keys = 0usize;
            let mut memos: HashSet<String> = HashSet::new();
            for (k, ca) in &a.keys {
                if let Some(cb) = b.keys.get(k) {
                    twins += (*ca).min(*cb);
                    let desc = &a.sample[k];
                    memos.insert(norm(desc));
                    if bank_txn_reference(desc).is_some() { ref_keys += 1; }
                }
            }
            let smaller = a.n.min(b.n);
            let near_total = smaller >= 3 && twins * 100 >= smaller * 95;
            let proof = if !a.pas.is_disjoint(&b.pas) {
                "same connection"
            } else if near_total && ref_keys >= 2 {
                "bank references"
            } else if near_total && twins >= 20 && memos.len() >= 10 {
                "matching history"
            } else {
                continue;
            };
            proof_of.entry(la).or_insert(proof);
            proof_of.entry(lb).or_insert(proof);
            let (ra, rb) = (root(&parent, la), root(&parent, lb));
            if ra != rb { parent.insert(ra, rb); }
        }
    }
    let mut comps: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for l in &labels {
        if proof_of.contains_key(l) { comps.entry(root(&parent, l)).or_default().push(l); }
    }
    let mut out = Vec::new();
    for members in comps.values() {
        if members.len() < 2 { continue; }
        let survivor = *members.iter().max_by(|x, y| {
            let (a, b) = (&per[**x], &per[**y]);
            a.first_import.cmp(&b.first_import).then(a.last_posted.cmp(&b.last_posted)).then(x.cmp(y))
        }).unwrap();
        for m in members {
            if *m != survivor {
                out.push(Fold { from: m.to_string(), to: survivor.to_string(), proof: proof_of[m] });
            }
        }
    }
    out
}

/// The SAME account linked twice under a DIFFERENT last-4 (Plaid's mask can differ per link:
/// "Blue Business Cash(TM) ··1004" and "··2002"). Unchanged from v0.15.121 — FIVE conditions
/// must ALL hold, because merging two real accounts would delete real transactions:
///   1. SAME product name
///   2. >= 20 shared distinct (date, cent, direction, memo) keys
///   3. >= 95% of the smaller account's keys shared
///   4. >= 10 DISTINCT memos among the shared keys
///   5. the loser is DEMONSTRABLY DEAD: its newest posted_at is >= 7 days behind the survivor's.
pub fn detect_mask_changes(rows: &[TxnRow]) -> Vec<Fold> {
    struct Acct { keys: HashSet<String>, last_posted: String }
    let mut per: BTreeMap<&str, Acct> = BTreeMap::new();
    for r in rows {
        let e = per.entry(r.account.as_str()).or_insert_with(|| Acct { keys: HashSet::new(), last_posted: String::new() });
        e.keys.insert(content_key(r));
        if r.date > e.last_posted { e.last_posted = r.date.clone(); }
    }
    let accts: Vec<&str> = per.keys().cloned().collect();
    let mut out = Vec::new();
    for i in 0..accts.len() {
        for j in (i + 1)..accts.len() {
            let (a, b) = (accts[i], accts[j]);
            if product_name(a) != product_name(b) { continue; }                 // 1
            let (pa_, pb) = (&per[a], &per[b]);
            let shared: Vec<&String> = pa_.keys.intersection(&pb.keys).collect();
            let smaller = pa_.keys.len().min(pb.keys.len());
            if smaller == 0 || shared.len() < 20 { continue; }                  // 2
            if (shared.len() as f64 / smaller as f64) < 0.95 { continue; }      // 3
            let memos: HashSet<&str> = shared.iter().map(|k| k.splitn(4, '|').nth(3).unwrap_or("")).collect();
            if memos.len() < 10 { continue; }                                   // 4
            let (from, to) = if pa_.last_posted > pb.last_posted { (b, a) } else { (a, b) };
            match day_gap(&per[to].last_posted, &per[from].last_posted) {       // 5
                Some(d) if per[to].last_posted >= per[from].last_posted && d >= 7 => {}
                _ => continue,
            }
            out.push(Fold { from: from.to_string(), to: to.to_string(), proof: "masks" });
        }
    }
    out
}

/// Stored (already confirmed) aliases plus this run's folds, chains collapsed to one hop.
/// A stored alias wins over a fresh fold for the same label, and a fold that would close a
/// cycle is dropped.
pub fn resolve_aliases(stored: &HashMap<String, String>, fresh: &[Fold]) -> HashMap<String, String> {
    let mut map = stored.clone();
    let resolve = |m: &HashMap<String, String>, s: &str| -> String {
        let mut v = s.to_string();
        for _ in 0..9 {
            match m.get(&v) { Some(n) if *n != v => v = n.clone(), _ => break }
        }
        v
    };
    for f in fresh {
        if map.contains_key(&f.from) { continue; }
        if resolve(&map, &f.to) == f.from { continue; }
        map.insert(f.from.clone(), f.to.clone());
    }
    let snap = map.clone();
    for v in map.values_mut() { *v = resolve(&snap, v); }
    map.retain(|k, v| k != v);
    map
}

/// One copy scheduled for removal and the survivor its booking is carried onto.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Removal {
    pub id: String,
    pub carry_to: String,
    /// The copy was booked; its booking is identical to (or a subset of) the survivor's.
    pub booked: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AutoGroup {
    pub keep: String,
    pub keep_all: Vec<String>,
    pub remove: Vec<String>,
    pub removals: Vec<Removal>,
    pub account: String,
    pub date: String,
    pub amount: f64,
    pub direction: String,
    pub description: String,
    pub cross_account: bool,
    /// "identical" | "same reference" (the bank's reference matches, the memo or date differs).
    pub kind: &'static str,
    pub date_moved: bool,
}

pub struct Plan {
    /// The full alias map to persist (stored + this run's folds, collapsed).
    pub aliases: HashMap<String, String>,
    /// Folds found this run, with their proof.
    pub folds: Vec<Fold>,
    pub groups: Vec<AutoGroup>,
    pub review: Vec<Value>,
}

/// Decide every removal. Nothing is removed here; `dedupe_bank_txns` executes the plan with
/// a re-check, a backup and a tombstone per row.
pub fn plan(rows: &[TxnRow], stored: &HashMap<String, String>, aggressive: bool) -> Plan {
    let renames = detect_renames(rows);
    let mut folds = renames.clone();
    for m in detect_mask_changes(rows) {
        if !folds.iter().any(|f| f.from == m.from || f.to == m.from || f.from == m.to) { folds.push(m); }
    }
    let aliases = resolve_aliases(stored, &folds);
    let acct_of = |a: &str| aliases.get(a).cloned().unwrap_or_else(|| a.to_string());
    // A fresh different-last-4 fold is the weaker proof: in safe mode its removals are still
    // confirmed by hand, as before. A rename is proven, and a stored alias was confirmed by
    // the person who ran the cleanup that wrote it.
    let unconfirmed: HashSet<&str> = folds.iter()
        .filter(|f| f.proof == "masks" && !stored.contains_key(&f.from))
        .map(|f| f.from.as_str()).collect();

    let rank = |a: &usize, b: &usize| {
        let (x, y) = (&rows[*a], &rows[*b]);
        y.linked.cmp(&x.linked)
            .then(y.reviewed.cmp(&x.reviewed))
            .then(x.imported_at.cmp(&y.imported_at))
            .then(x.created_at.cmp(&y.created_at))
            .then(x.id.cmp(&y.id))
    };
    let base = |idxs: &[usize], s: &TxnRow| json!({
        "account": s.account, "date": s.date, "amount": s.amount, "direction": s.dir,
        "description": s.desc, "keep": s.id, "count": idxs.len(),
        "ids": idxs.iter().map(|&i| rows[i].id.clone()).collect::<Vec<_>>(),
    });
    let review_item = |idxs: &[usize], s: &TxnRow, reason: String, cross: bool| {
        let mut g = base(idxs, s);
        g["reason"] = json!(reason);
        if cross { g["cross_account"] = json!(true); }
        g
    };
    // Every loser needs a survivor to carry its booking to; a booked loser only onto a booked
    // survivor whose booking agrees with it.
    let removals_for = |keep: &[usize], losers: &[usize]| -> Option<Vec<Removal>> {
        losers.iter().map(|&l| {
            let lr = &rows[l];
            let k = if lr.reviewed {
                *keep.iter().find(|&&k| rows[k].reviewed && booking_compatible(lr, &rows[k]))?
            } else {
                *keep.iter().find(|&&k| hand_fields_compatible(lr, &rows[k]))?
            };
            Some(Removal { id: lr.id.clone(), carry_to: rows[k].id.clone(), booked: lr.reviewed })
        }).collect()
    };

    let generic_terms = ["atm", "cash", "withdrawal", "deposit", "transfer", "zelle", "venmo", "wire", "e-transfer", "check "];
    let mut groups: Vec<AutoGroup> = Vec::new();
    let mut review: Vec<Value> = Vec::new();
    let mut removed: HashSet<usize> = HashSet::new();

    let mut buckets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, r) in rows.iter().enumerate() {
        buckets.entry(fingerprint(&acct_of(&r.account), r)).or_default().push(i);
    }

    for idxs in buckets.values() {
        if idxs.len() < 2 { continue; }
        let mut ordered = idxs.clone();
        ordered.sort_by(rank);
        let s = &rows[ordered[0]];

        // Every pair, every stored detail. One disagreement and nothing here is deleted.
        let mut conflict = None;
        'pairs: for (n, &i) in idxs.iter().enumerate() {
            for &j in &idxs[n + 1..] {
                if let Some(f) = metadata_conflict(&rows[i], &rows[j], true) { conflict = Some(f); break 'pairs; }
            }
        }
        if let Some(f) = conflict {
            review.push(review_item(idxs, s, format!("same date, amount and memo, but the {f} differs — could be two real transactions"), false));
            continue;
        }

        let mut per_label: BTreeMap<&str, usize> = BTreeMap::new();
        for &i in idxs { *per_label.entry(rows[i].account.as_str()).or_default() += 1; }
        let folded = per_label.len() > 1;
        let all_have_pa = !folded && idxs.iter().all(|&i| !meta(&rows[i].raw_json).pa.is_empty());
        // How many copies are real. Each view of an account reports each real transaction
        // once, so within one label the answer is the most any single view reported. A view is
        // a Plaid connection (`pa`), or — for rows imported before `pa` was stamped — one
        // import run: two identical rows that arrived in the SAME run came from one pull and
        // are two real charges (several such fee pairs are on the live book). Across the
        // labels of one folded account, each label's own count is a view of the same account:
        // keep the largest — the 1-for-1 rule — so a copy is removed only when it has a twin.
        // One connection reports each real transaction once WHATEVER label it used, so a
        // connection that delivered copies under both names (a repeat charge straddling the
        // rename) floors the count too.
        let mut per_pa: HashMap<String, usize> = HashMap::new();
        for &i in idxs {
            let pa = meta(&rows[i].raw_json).pa;
            if !pa.is_empty() { *per_pa.entry(pa).or_default() += 1; }
        }
        let keep_n = if folded {
            per_label.values().cloned().max().unwrap_or(1).max(per_pa.values().cloned().max().unwrap_or(0))
        } else {
            let mut per: HashMap<String, usize> = HashMap::new();
            for &i in idxs {
                let pa = meta(&rows[i].raw_json).pa;
                *per.entry(if pa.is_empty() { format!("run:{}", rows[i].imported_at) } else { pa }).or_default() += 1;
            }
            per.values().cloned().max().unwrap_or(1)
        };

        let linked = idxs.iter().filter(|&&i| rows[i].linked).count();
        if linked > keep_n {
            review.push(review_item(idxs, s, "more copies are linked to deals, loans or refunds than the bank shows — resolve by hand".into(), folded));
            continue;
        }

        // The bank's current feed (the label everything folds into) holds FEWER copies than an
        // older name did — extras from an earlier duplicate episode. They are kept (they carry
        // booking work), and said out loud so they can be deleted by hand.
        if folded {
            let target = acct_of(&s.account);
            let target_n = per_label.get(target.as_str()).cloned().unwrap_or(0);
            if target_n > 0 && target_n < keep_n {
                let mut g = review_item(idxs, s, format!(
                    "all kept — the bank's current feed shows {target_n}, so delete the {} extra by hand if they are duplicates",
                    keep_n - target_n), true);
                g["account"] = json!(target);
                g["count"] = json!(keep_n);
                g["kept_extras"] = json!(true);
                review.push(g);
            }
        }

        if keep_n >= idxs.len() { continue; }
        let (keep, losers) = ordered.split_at(keep_n);
        if losers.iter().any(|&i| rows[i].linked) {
            review.push(review_item(idxs, s, "a copy linked to a deal would be removed — resolve by hand".into(), folded));
            continue;
        }
        let cross = folded && per_label.keys().any(|l| unconfirmed.contains(l));
        // A booked copy is only ever removed on proof that it is a second view of one
        // transaction: every copy carries its connection, or the account's two names are a
        // proven rename. Older rows with no connection stamp keep the old rule.
        if (cross || (!folded && !all_have_pa)) && losers.iter().any(|&i| rows[i].reviewed) {
            review.push(review_item(idxs, s, "a booked copy would be removed — resolve by hand".into(), folded));
            continue;
        }
        let Some(removals) = removals_for(keep, losers) else {
            review.push(review_item(idxs, s, "the copies are booked differently — resolve by hand".into(), folded));
            continue;
        };
        if cross && !aggressive {
            review.push(review_item(idxs, s, "same transaction on two account labels — confirm these accounts are one".into(), true));
            continue;
        }
        if !folded && !all_have_pa && !aggressive {
            let whole_dollar = ((s.amount * 100.0).round() as i64) % 100 == 0;
            let dl = s.desc.to_lowercase();
            let generic = s.desc.trim().is_empty() || generic_terms.iter().any(|t| dl.contains(t));
            if generic || whole_dollar || idxs.len() > 2 {
                review.push(review_item(idxs, s, (if generic { "generic memo — could be a real repeat (re-pull to confirm by connection)" }
                    else if whole_dollar { "round amount — could be a real repeat (re-pull to confirm by connection)" }
                    else { "more than two copies — re-pull to confirm by connection" }).into(), false));
                continue;
            }
        }
        removed.extend(losers.iter().cloned());
        groups.push(AutoGroup {
            keep: s.id.clone(),
            keep_all: keep.iter().map(|&i| rows[i].id.clone()).collect(),
            remove: removals.iter().map(|r| r.id.clone()).collect(),
            removals,
            account: acct_of(&s.account), date: s.date.clone(), amount: s.amount,
            direction: s.dir.clone(), description: s.desc.clone(),
            cross_account: folded, kind: "identical", date_moved: false,
        });
    }

    // The same payment whose DATE moved between two views of the account (a pending date on
    // one connection, the posted date on the other). Not identical, so the pass above leaves
    // it — but the payment rail's own reference names one payment. Only a pair, only two
    // views (two labels, or two different connections), same account, direction and amount
    // to the cent, dates within five days, no disagreeing detail.
    let mut by_ref: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, r) in rows.iter().enumerate() {
        if removed.contains(&i) { continue; }
        if let Some((kind, val)) = bank_txn_reference(&r.desc) {
            by_ref.entry(format!("{}|{}|{:.2}|{}|{}", acct_of(&r.account).to_lowercase(), r.dir, r.amount, kind, val))
                .or_default().push(i);
        }
    }
    for idxs in by_ref.values() {
        if idxs.len() < 2 { continue; }
        let distinct: HashSet<String> = idxs.iter().map(|&i| fingerprint(&acct_of(&rows[i].account), &rows[i])).collect();
        if distinct.len() < 2 { continue; } // all identical — decided in the pass above
        let mut ordered = idxs.clone();
        ordered.sort_by(rank);
        let s = &rows[ordered[0]];
        if idxs.len() > 2 {
            review.push(review_item(idxs, s, format!("the same bank reference is on {} transactions — resolve by hand", idxs.len()), false));
            continue;
        }
        let (a, b) = (&rows[idxs[0]], &rows[idxs[1]]);
        if day_gap(&a.date, &b.date).map_or(true, |d| d > 5) { continue; }
        let (pa, pb) = (meta(&a.raw_json).pa, meta(&b.raw_json).pa);
        // Two views: two connections, or — when a connection is unknown — two labels. The same
        // connection under two names is one view (and a real repeat stays).
        let two_views = if !pa.is_empty() && !pb.is_empty() { pa != pb } else { a.account != b.account };
        if !two_views { continue; }
        if let Some(f) = metadata_conflict(a, b, false) {
            review.push(review_item(idxs, s, format!("same bank reference, but the {f} differs — resolve by hand"), a.account != b.account));
            continue;
        }
        let (keep, losers) = ordered.split_at(1);
        if rows[losers[0]].linked {
            review.push(review_item(idxs, s, "same bank reference on two dates, both linked to deals — resolve by hand".into(), a.account != b.account));
            continue;
        }
        let Some(removals) = removals_for(keep, losers) else {
            review.push(review_item(idxs, s, "same bank reference on two dates, booked differently — resolve by hand".into(), a.account != b.account));
            continue;
        };
        let cross = a.account != b.account && (unconfirmed.contains(a.account.as_str()) || unconfirmed.contains(b.account.as_str()));
        if cross && rows[losers[0]].reviewed {
            review.push(review_item(idxs, s, "a booked copy would be removed — resolve by hand".into(), true));
            continue;
        }
        if cross && !aggressive {
            review.push(review_item(idxs, s, "same bank reference on two account labels — confirm these accounts are one".into(), true));
            continue;
        }
        removed.insert(losers[0]);
        groups.push(AutoGroup {
            keep: s.id.clone(),
            keep_all: vec![s.id.clone()],
            remove: removals.iter().map(|r| r.id.clone()).collect(),
            removals,
            account: acct_of(&s.account), date: s.date.clone(), amount: s.amount,
            direction: s.dir.clone(), description: s.desc.clone(),
            cross_account: a.account != b.account, kind: "same reference", date_moved: a.date != b.date,
        });
    }

    Plan { aliases, folds, groups, review }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "BUSINESS CHECKING \u{00b7}\u{00b7}1234";
    const NEW: &str = "PREMIER BUSINESS CHECKING \u{00b7}\u{00b7}1234";

    fn row(id: &str, account: &str, date: &str, amount: f64, dir: &str, desc: &str, pa: &str, imported: &str) -> TxnRow {
        TxnRow {
            id: id.into(), account: account.into(), date: date.into(), amount, dir: dir.into(),
            desc: desc.into(), memo_raw: desc.into(),
            raw_json: if pa.is_empty() { String::new() } else { json!({"pa": pa, "tid": id, "dt": ""}).to_string() },
            imported_at: imported.into(), created_at: imported.into(), category: "payment".into(),
            ..Default::default()
        }
    }
    fn booked(mut r: TxnRow, category: &str) -> TxnRow { r.reviewed = true; r.category = category.into(); r }
    fn linked(mut r: TxnRow) -> TxnRow { r.linked = true; r.reviewed = true; r }

    /// The live shape: history under the old name (booked), the same history re-pulled under
    /// the new name, and one row from the old connection already delivered under the new name.
    fn renamed_book() -> Vec<TxnRow> {
        let mut v = Vec::new();
        for d in 1..=9 {
            let date = format!("2026-06-0{d}");
            let desc = format!("Card purchase {d}");
            v.push(booked(row(&format!("old{d}"), OLD, &date, 10.0 + d as f64, "out", &desc, "", "2026-07-14T00:00:00Z"), "supplies"));
            v.push(row(&format!("new{d}"), NEW, &date, 10.0 + d as f64, "out", &desc, "pa_fresh", "2026-09-14T16:52:00Z"));
        }
        v.push(row("old_live", OLD, "2026-09-10", 5.0, "out", "Coffee", "pa_same", "2026-09-10T00:00:00Z"));
        v.push(row("new_live", NEW, "2026-09-12", 7.0, "out", "Lunch", "pa_same", "2026-09-13T00:00:00Z"));
        v
    }

    #[test]
    fn a_renamed_account_folds_on_a_shared_connection() {
        let folds = detect_renames(&renamed_book());
        assert_eq!(folds.len(), 1);
        assert_eq!((folds[0].from.as_str(), folds[0].to.as_str(), folds[0].proof), (OLD, NEW, "same connection"));
    }

    #[test]
    fn a_rename_removes_each_unbooked_twin_and_keeps_the_booked_copy() {
        let p = plan(&renamed_book(), &HashMap::new(), false);
        let removed: HashSet<String> = p.groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert_eq!(removed.len(), 9);
        for d in 1..=9 {
            assert!(removed.contains(&format!("new{d}")));
            assert!(!removed.contains(&format!("old{d}")));
        }
        assert!(p.review.is_empty(), "{:?}", p.review);
        assert_eq!(p.aliases.get(OLD).map(String::as_str), Some(NEW));
    }

    #[test]
    fn two_accounts_sharing_a_last4_without_proof_never_fold() {
        // Same last-4, different products, two identical rows — but no shared connection, no
        // bank references and far too little history to call it one account.
        let v = vec![
            row("a1", "SAVINGS \u{00b7}\u{00b7}1111", "2026-06-01", 15.0, "out", "Monthly fee", "pa_a", "2026-07-01T00:00:00Z"),
            row("b1", "CHECKING \u{00b7}\u{00b7}1111", "2026-06-01", 15.0, "out", "Monthly fee", "pa_b", "2026-07-02T00:00:00Z"),
            row("a2", "SAVINGS \u{00b7}\u{00b7}1111", "2026-07-01", 15.0, "out", "Monthly fee", "pa_a", "2026-07-01T00:00:00Z"),
            row("b2", "CHECKING \u{00b7}\u{00b7}1111", "2026-07-01", 15.0, "out", "Monthly fee", "pa_b", "2026-07-02T00:00:00Z"),
        ];
        assert!(detect_renames(&v).is_empty());
        let p = plan(&v, &HashMap::new(), true);
        assert!(p.groups.is_empty(), "nothing may be removed across two unproven accounts");
    }

    #[test]
    fn bank_references_prove_a_rename_with_no_shared_connection() {
        let o = "BUSINESS SAVINGS \u{00b7}\u{00b7}5678";
        let n = "PREMIER BUSINESS SAVINGS \u{00b7}\u{00b7}5678";
        let v = vec![
            booked(row("o1", o, "2026-05-28", 100.0, "in", "Online Transfer from CHK ...1234 transaction#: 11112222333", "", "2026-07-14T00:00:00Z"), "transfer"),
            booked(row("o2", o, "2026-06-08", 1000.0, "in", "Online Transfer from CHK ...1234 transaction#: 44445555666", "", "2026-07-14T00:00:00Z"), "transfer"),
            booked(row("o3", o, "2026-06-30", 0.01, "in", "INTEREST PAYMENT", "pa_x", "2026-07-14T00:00:00Z"), "interest"),
            row("n1", n, "2026-05-28", 100.0, "in", "Online Transfer from CHK ...1234 transaction#: 11112222333", "pa_y", "2026-09-14T00:00:00Z"),
            row("n2", n, "2026-06-08", 1000.0, "in", "Online Transfer from CHK ...1234 transaction#: 44445555666", "pa_y", "2026-09-14T00:00:00Z"),
            row("n3", n, "2026-06-30", 0.01, "in", "INTEREST PAYMENT", "pa_y", "2026-09-14T00:00:00Z"),
        ];
        let folds = detect_renames(&v);
        assert_eq!(folds.len(), 1);
        assert_eq!((folds[0].from.as_str(), folds[0].to.as_str(), folds[0].proof), (o, n, "bank references"));
        let removed: HashSet<String> = plan(&v, &HashMap::new(), false).groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert_eq!(removed, ["n1", "n2", "n3"].iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn a_booked_copy_on_the_new_name_survives_and_its_old_twin_goes() {
        let mut v = renamed_book();
        v.push(row("old_wire", OLD, "2026-09-11", 5800.0, "out", "ONLINE DOMESTIC WIRE TRANSFER", "pa_same", "2026-09-11T00:00:00Z"));
        v.push(linked(row("new_wire", NEW, "2026-09-11", 5800.0, "out", "ONLINE DOMESTIC WIRE TRANSFER", "pa_fresh", "2026-09-14T16:52:00Z")));
        let p = plan(&v, &HashMap::new(), false);
        let g = p.groups.iter().find(|g| g.remove.contains(&"old_wire".to_string())).expect("old unbooked twin removed");
        assert_eq!(g.keep, "new_wire");
    }

    #[test]
    fn identically_booked_twins_lose_one_copy_differently_booked_twins_go_to_review() {
        let mut v = renamed_book();
        v.push(booked(row("o_zelle", OLD, "2026-09-11", 30.0, "out", "Zelle payment to Pat 12121212121", "pa_same", "2026-09-11T00:00:00Z"), "owner_draw"));
        v.push(booked(row("n_zelle", NEW, "2026-09-11", 30.0, "out", "Zelle payment to Pat 12121212121", "pa_fresh", "2026-09-14T00:00:00Z"), "owner_draw"));
        v.push(booked(row("o_fee", OLD, "2026-09-12", 12.0, "out", "Service fee", "pa_same", "2026-09-12T00:00:00Z"), "fees"));
        v.push(booked(row("n_fee", NEW, "2026-09-12", 12.0, "out", "Service fee", "pa_fresh", "2026-09-14T00:00:00Z"), "software"));
        let p = plan(&v, &HashMap::new(), false);
        let removed: HashSet<String> = p.groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert!(removed.contains("n_zelle"));
        assert!(!removed.contains("o_zelle"));
        assert!(!removed.contains("o_fee") && !removed.contains("n_fee"));
        assert!(p.review.iter().any(|r| r["reason"].as_str().unwrap().contains("booked differently")));
    }

    #[test]
    fn an_unbooked_copy_with_a_different_supplier_tag_goes_to_review() {
        let mut v = renamed_book();
        let mut a = row("o_tag", OLD, "2026-09-11", 480.0, "out", "Zelle payment to Acme Loads", "pa_same", "2026-09-11T00:00:00Z");
        a.counterparty_type = "supplier".into(); a.counterparty_id = "sup_1".into();
        let mut b = row("n_tag", NEW, "2026-09-11", 480.0, "out", "Zelle payment to Acme Loads", "pa_fresh", "2026-09-14T00:00:00Z");
        b.counterparty_type = "supplier".into(); b.counterparty_id = "sup_2".into();
        v.push(a);
        v.push(b);
        let p = plan(&v, &HashMap::new(), true);
        let removed: HashSet<String> = p.groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert!(!removed.contains("o_tag") && !removed.contains("n_tag"));
    }

    #[test]
    fn a_repeat_charge_straddling_a_rename_on_one_connection_keeps_both() {
        // One connection, two real $25 fees on 09-11: one synced before the rename, one after.
        let mut v = renamed_book();
        v.push(booked(row("fee1", OLD, "2026-09-11", 25.0, "out", "ONLINE DOMESTIC WIRE FEE", "pa_same", "2026-09-11T00:00:00Z"), "fees"));
        v.push(booked(row("fee2", NEW, "2026-09-11", 25.0, "out", "ONLINE DOMESTIC WIRE FEE", "pa_same", "2026-09-13T00:00:00Z"), "fees"));
        v.push(row("p1", OLD, "2026-09-09", 900.0, "out", "WIRE TRN: 1234567890AB", "pa_same", "2026-09-09T00:00:00Z"));
        v.push(row("p2", NEW, "2026-09-10", 900.0, "out", "WIRE TRN: 1234567890AB", "pa_same", "2026-09-13T00:00:00Z"));
        for aggressive in [false, true] {
            let removed: HashSet<String> = plan(&v, &HashMap::new(), aggressive).groups.iter().flat_map(|g| g.remove.clone()).collect();
            assert!(!removed.contains("fee1") && !removed.contains("fee2"));
            assert!(!removed.contains("p1") && !removed.contains("p2"));
        }
    }

    #[test]
    fn a_linked_copy_is_never_removed() {
        let mut v = renamed_book();
        v.push(linked(row("o_rcpt", OLD, "2026-09-11", 3700.0, "in", "Zelle payment from Buyer Co", "pa_same", "2026-09-11T00:00:00Z")));
        v.push(linked(row("n_rcpt", NEW, "2026-09-11", 3700.0, "in", "Zelle payment from Buyer Co", "pa_fresh", "2026-09-14T00:00:00Z")));
        let p = plan(&v, &HashMap::new(), true);
        let removed: HashSet<String> = p.groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert!(!removed.contains("o_rcpt") && !removed.contains("n_rcpt"));
        assert!(p.review.iter().any(|r| r["reason"].as_str().unwrap().contains("linked")));
    }

    #[test]
    fn any_disagreeing_detail_blocks_removal() {
        let mut v = renamed_book();
        let mut a = row("o_m", OLD, "2026-09-11", 42.79, "out", "Workspace", "pa_same", "2026-09-11T00:00:00Z");
        a.raw_json = json!({"pa": "pa_same", "merchant": "Google Workspace"}).to_string();
        let mut b = row("n_m", NEW, "2026-09-11", 42.79, "out", "Workspace", "pa_fresh", "2026-09-14T00:00:00Z");
        b.raw_json = json!({"pa": "pa_fresh", "merchant": "Slack"}).to_string();
        v.push(a);
        v.push(b);
        let p = plan(&v, &HashMap::new(), true);
        let removed: HashSet<String> = p.groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert!(!removed.contains("o_m") && !removed.contains("n_m"));
        assert!(p.review.iter().any(|r| r["reason"].as_str().unwrap().contains("merchant differs")));
    }

    #[test]
    fn one_connection_reporting_two_identical_charges_keeps_both() {
        let acct = "CARDHOLDER \u{00b7}\u{00b7}9012";
        let v = vec![
            row("x1", acct, "2026-08-21", 284.47, "out", "American Airlines", "pa_1", "2026-08-22T00:00:00Z"),
            row("x2", acct, "2026-08-21", 284.47, "out", "American Airlines", "pa_1", "2026-08-22T00:00:00Z"),
        ];
        assert!(plan(&v, &HashMap::new(), true).groups.is_empty());
    }

    #[test]
    fn two_identical_rows_from_one_pull_are_two_real_charges() {
        // The live shape: pre-`pa` rows, one import run, the same marketplace fee twice on a day.
        let acct = "BUSINESS CARD \u{00b7}\u{00b7}3456";
        let v = vec![
            booked(row("w1", acct, "2026-02-02", 3.96, "out", "MARKETPLACE FEE", "", "2026-07-14T02:39:06Z"), "software"),
            booked(row("w2", acct, "2026-02-02", 3.96, "out", "MARKETPLACE FEE", "", "2026-07-14T02:39:06Z"), "software"),
            row("u1", acct, "2026-02-03", 7.13, "out", "MARKETPLACE FEE", "", "2026-07-14T02:39:06Z"),
            row("u2", acct, "2026-02-03", 7.13, "out", "MARKETPLACE FEE", "", "2026-07-14T02:39:06Z"),
        ];
        for aggressive in [false, true] {
            assert!(plan(&v, &HashMap::new(), aggressive).groups.is_empty());
        }
    }

    #[test]
    fn a_booked_copy_without_connection_proof_goes_to_review() {
        let acct = "BUSINESS CARD \u{00b7}\u{00b7}3456";
        let v = vec![
            booked(row("w1", acct, "2026-02-02", 3.96, "out", "MARKETPLACE FEE", "", "2026-07-14T02:39:06Z"), "software"),
            booked(row("w2", acct, "2026-02-02", 3.96, "out", "MARKETPLACE FEE", "", "2026-07-22T17:58:13Z"), "software"),
        ];
        let p = plan(&v, &HashMap::new(), true);
        assert!(p.groups.is_empty());
        assert!(p.review.iter().any(|r| r["reason"].as_str().unwrap().contains("a booked copy would be removed")));
    }

    #[test]
    fn extras_from_an_older_episode_are_kept_and_reported() {
        // Four booked wire fees under the old name (two July re-links), the bank's fresh feed
        // shows two: the two fresh copies go, the four booked stay, and the gap is reported.
        let mut v = renamed_book();
        for (i, imp) in ["2026-07-14T00:00:00Z", "2026-07-14T00:00:00Z", "2026-07-22T00:00:00Z", "2026-07-22T00:00:00Z"].iter().enumerate() {
            v.push(booked(row(&format!("of{i}"), OLD, "2026-06-04", 25.0, "out", "ONLINE DOMESTIC WIRE FEE", "", imp), "fees"));
        }
        v.push(row("nf0", NEW, "2026-06-04", 25.0, "out", "ONLINE DOMESTIC WIRE FEE", "pa_fresh", "2026-09-14T16:53:00Z"));
        v.push(row("nf1", NEW, "2026-06-04", 25.0, "out", "ONLINE DOMESTIC WIRE FEE", "pa_fresh", "2026-09-14T16:53:00Z"));
        let p = plan(&v, &HashMap::new(), false);
        let removed: HashSet<String> = p.groups.iter().flat_map(|g| g.remove.clone()).collect();
        assert!(removed.contains("nf0") && removed.contains("nf1"));
        assert!((0..4).all(|i| !removed.contains(&format!("of{i}"))));
        assert!(p.review.iter().any(|r| r["reason"].as_str().unwrap().contains("current feed shows 2")));
    }

    #[test]
    fn a_date_moved_payment_pairs_on_its_bank_reference() {
        let mut v = renamed_book();
        v.push(linked(row("o_rtp", OLD, "2026-09-07", 2458.0, "in", "REAL TIME TRANSFER RECD FROM PAYPAL TRN: 0999888777GE", "pa_same", "2026-09-07T00:00:00Z")));
        v.push(row("n_rtp", NEW, "2026-09-08", 2458.0, "in", "REAL TIME TRANSFER RECD FROM PAYPAL TRN: 0999888777GE", "pa_fresh", "2026-09-14T00:00:00Z"));
        let p = plan(&v, &HashMap::new(), false);
        let g = p.groups.iter().find(|g| g.kind == "same reference").expect("reference pair");
        assert_eq!((g.keep.as_str(), g.remove.clone()), ("o_rtp", vec!["n_rtp".to_string()]));
    }

    #[test]
    fn a_date_moved_pair_on_one_connection_is_left_alone() {
        let acct = "CARDHOLDER \u{00b7}\u{00b7}9012";
        let v = vec![
            row("p1", acct, "2026-09-07", 900.0, "out", "WIRE TRN: 1234567890AB", "pa_1", "2026-09-07T00:00:00Z"),
            row("p2", acct, "2026-09-08", 900.0, "out", "WIRE TRN: 1234567890AB", "pa_1", "2026-09-08T00:00:00Z"),
        ];
        assert!(plan(&v, &HashMap::new(), true).groups.is_empty());
    }

    #[test]
    fn import_identity_matches_a_rename_but_not_a_live_separate_account() {
        let aliases = HashMap::new();
        assert!(same_account(OLD, NEW, &HashSet::new(), &aliases));
        let live: HashSet<String> = [OLD.to_string(), NEW.to_string()].into_iter().collect();
        assert!(!same_account(OLD, NEW, &live, &aliases), "the bank still reports both names as accounts");
        assert!(!same_account("Amex \u{00b7}\u{00b7}1004", NEW, &HashSet::new(), &aliases));
        assert!(!same_account("NO MASK", "NO MASK 2", &HashSet::new(), &aliases));
    }

    #[test]
    fn a_stored_alias_is_not_reversed_by_a_fresh_fold() {
        let stored: HashMap<String, String> = [(NEW.to_string(), OLD.to_string())].into_iter().collect();
        let fresh = vec![Fold { from: OLD.into(), to: NEW.into(), proof: "same connection" }];
        let m = resolve_aliases(&stored, &fresh);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get(NEW).map(String::as_str), Some(OLD));
    }

    fn raw(r: TxnRow, pa: &str, pending: bool, retracted: bool) -> TxnRow {
        let mut o = json!({"pa": pa, "tid": r.id, "pnd": pending});
        if retracted { o["rtr"] = json!("2026-09-08T20:50:14Z"); }
        TxnRow { raw_json: o.to_string(), ..r }
    }

    #[test]
    fn a_retracted_booked_charge_hands_its_booking_to_the_one_posted_copy() {
        let card = "BUSINESS CARD \u{00b7}\u{00b7}3456";
        let v = vec![
            raw(booked(row("pend", card, "2026-08-23", 363.91, "out", "TURO", "", "2026-08-24T00:00:00Z"), "travel"), "pa_1", true, true),
            raw(row("post", card, "2026-08-25", 363.91, "out", "TURO* TRIP HX93", "", "2026-08-26T00:00:00Z"), "pa_1", false, false),
        ];
        let p = takeover_pairs(&v, &HashMap::new());
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].from_id.as_str(), p[0].to_id.as_str(), p[0].automatic), ("pend", "post", true));
    }

    #[test]
    fn two_posted_candidates_or_a_changed_amount_ask_instead() {
        let card = "BUSINESS CARD \u{00b7}\u{00b7}3456";
        let two = vec![
            raw(booked(row("pend", card, "2026-09-01", 5.0, "in", "MARKETPLACE FEE", "", "2026-09-01T00:00:00Z"), "other_income"), "pa_1", true, true),
            raw(row("a", card, "2026-09-02", 5.0, "in", "MARKETPLACE FEE", "", "2026-09-02T00:00:00Z"), "pa_1", false, false),
            raw(row("b", card, "2026-09-02", 5.0, "in", "MARKETPLACE FEE", "", "2026-09-02T00:00:00Z"), "pa_1", false, false),
        ];
        let p = takeover_pairs(&two, &HashMap::new());
        assert_eq!(p.len(), 1, "identical copies pair one for one");
        assert!(p[0].automatic);

        // Two retracted and two posted, identical: both pair.
        let mut four = two.clone();
        four.push(raw(booked(row("pend2", card, "2026-09-01", 5.0, "in", "MARKETPLACE FEE", "", "2026-09-01T00:00:00Z"), "other_income"), "pa_2", true, true));
        let p = takeover_pairs(&four, &HashMap::new());
        assert_eq!(p.iter().filter(|t| t.automatic).count(), 2);
        assert_eq!(p.iter().map(|t| t.to_id.clone()).collect::<HashSet<_>>().len(), 2);

        // A $5 retracted copy with a $5 posted copy AND a $5.50 same-merchant posted copy: ask.
        let mut mixed = vec![two[0].clone(), two[1].clone()];
        mixed.push(raw(row("c", card, "2026-09-03", 5.50, "in", "MARKETPLACE FEE", "", "2026-09-03T00:00:00Z"), "pa_1", false, false));
        let p = takeover_pairs(&mixed, &HashMap::new());
        assert_eq!(p.len(), 2);
        assert!(p.iter().all(|t| !t.automatic));

        let hold = vec![
            raw(booked(row("hold", card, "2026-08-23", 400.0, "out", "HOTEL FRONT DESK", "", "2026-08-23T00:00:00Z"), "travel"), "pa_1", true, true),
            raw(row("final", card, "2026-08-26", 432.18, "out", "HOTEL FRONT DESK", "", "2026-08-27T00:00:00Z"), "pa_1", false, false),
        ];
        let p = takeover_pairs(&hold, &HashMap::new());
        assert_eq!(p.len(), 1);
        assert!(!p[0].automatic, "a different settled amount is a chip, never automatic");
    }

    #[test]
    fn a_booked_copy_that_is_still_pending_is_only_ever_a_chip() {
        let card = "BUSINESS CARD \u{00b7}\u{00b7}3456";
        let v = vec![
            raw(booked(row("pend", card, "2026-09-10", 42.0, "out", "PARKING", "", "2026-09-10T00:00:00Z"), "travel"), "pa_1", true, false),
            raw(row("post", card, "2026-09-11", 42.0, "out", "PARKING", "", "2026-09-12T00:00:00Z"), "pa_2", false, false),
        ];
        let p = takeover_pairs(&v, &HashMap::new());
        assert_eq!(p.len(), 1);
        assert!(!p[0].automatic);
    }

    #[test]
    fn unrelated_rows_never_pair() {
        let card = "BUSINESS CARD \u{00b7}\u{00b7}3456";
        let other = "OTHER CARD \u{00b7}\u{00b7}7777";
        let v = vec![
            raw(booked(row("pend", card, "2026-08-23", 100.0, "out", "SUPPLIER", "", "2026-08-23T00:00:00Z"), "payment"), "pa_1", true, true),
            // wrong direction, another account, too late, too different
            raw(row("in", card, "2026-08-24", 100.0, "in", "SUPPLIER", "", "2026-08-24T00:00:00Z"), "pa_1", false, false),
            raw(row("acct", other, "2026-08-24", 100.0, "out", "SUPPLIER", "", "2026-08-24T00:00:00Z"), "pa_9", false, false),
            raw(row("late", card, "2026-09-10", 100.0, "out", "SUPPLIER", "", "2026-09-10T00:00:00Z"), "pa_1", false, false),
            raw(row("far", card, "2026-08-24", 250.0, "out", "SUPPLIER", "", "2026-08-24T00:00:00Z"), "pa_1", false, false),
            // close amount, different merchant
            raw(row("rest", card, "2026-08-25", 109.05, "out", "AplPay RESTAURANT CHICAGO", "", "2026-08-25T00:00:00Z"), "pa_1", false, false),
            // an unbooked retracted row hands nothing over
            raw(row("unbooked_rtr", card, "2026-08-23", 60.0, "out", "X", "", "2026-08-23T00:00:00Z"), "pa_1", false, true),
            raw(row("post60", card, "2026-08-24", 60.0, "out", "X", "", "2026-08-24T00:00:00Z"), "pa_1", false, false),
        ];
        assert!(takeover_pairs(&v, &HashMap::new()).is_empty());
    }

    /// The live book, read-only: `ECLIPTR_DEDUP_DB=<path to a COPY> cargo test --bin clienthub
    /// live_book_plan -- --ignored --nocapture`. Prints the plan; writes nothing.
    #[test]
    #[ignore]
    fn live_book_plan() {
        let path = std::env::var("ECLIPTR_DEDUP_DB").expect("ECLIPTR_DEDUP_DB");
        let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let rows = crate::commands::load_dedup_rows(&conn).unwrap();
        let stored: HashMap<String, String> = conn
            .query_row("SELECT value FROM settings WHERE key='bank_account_aliases'", [], |r| r.get::<_, String>(0))
            .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let takeovers = takeover_pairs(&rows, &stored);
        std::fs::write(format!("{path}.takeovers.json"), serde_json::to_string_pretty(&takeovers).unwrap()).unwrap();
        println!("takeovers={} automatic={}", takeovers.len(), takeovers.iter().filter(|t| t.automatic).count());
        for aggressive in [false, true] {
            let p = plan(&rows, &stored, aggressive);
            let out = json!({
                "aggressive": aggressive,
                "rows": rows.len(),
                "folds": p.folds,
                "aliases": p.aliases,
                "groups": p.groups,
                "review": p.review,
            });
            let file = format!("{path}.plan-{}.json", if aggressive { "aggressive" } else { "safe" });
            std::fs::write(&file, serde_json::to_string_pretty(&out).unwrap()).unwrap();
            let removals: usize = p.groups.iter().map(|g| g.removals.len()).sum();
            let booked: usize = p.groups.iter().flat_map(|g| g.removals.iter()).filter(|r| r.booked).count();
            println!("aggressive={aggressive} rows={} folds={} groups={} removals={removals} booked_removals={booked} review={} -> {file}",
                rows.len(), p.folds.len(), p.groups.len(), p.review.len());
        }
    }
}
