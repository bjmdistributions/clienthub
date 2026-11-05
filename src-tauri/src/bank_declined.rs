//! R-586/R-587: no bank transaction goes missing, and a posted row is exactly what the bank says.
//!
//! Jack (R-586): "i have a bank account transaction that was never posted ... it just didnt show up in my
//! ledger." Four places declined a real transaction the bank offered (a content copy, a held payment
//! reference, a bank change for a row never held, a statement row matched to a feed row) and the cursor then
//! moved past it, so the bank never offered it again. Every such row is now kept in `bank_declined` until a
//! person answers it.
//!
//! Jack (R-587): "i need hard checks against all posted finilzed transactions to make sure once its
//! solidified its 100% exact to what the bank shows." `compare` holds the bank's whole posted history against
//! the ledger, both ways: missing from the ledger, different from the bank, and in the ledger but no longer
//! at the bank. Pure, so the matching is tested without a bank.

use rusqlite::Connection;
use serde_json::{json, Map, Value};

/// Why a row is on the list. The first five are bank transactions with no ledger row (Import brings them in).
pub const COPY: &str = "copy";
pub const HELD_REFERENCE: &str = "held_reference";
pub const CHANGE_UNKNOWN: &str = "change_unknown";
pub const STATEMENT_FEED_TWIN: &str = "statement_feed_twin";
pub const MISSING: &str = "missing";
/// A ledger row whose date, amount, direction or memo is not what the bank says.
pub const DIFFERS: &str = "differs";
/// A posted bank-feed row the bank no longer reports.
pub const NOT_AT_BANK: &str = "not_at_bank";

/// One row for the list. `bank` is the bank_txn columns Import writes (or, for `differs`, the bank's values).
#[derive(Clone, Debug, Default)]
pub struct Decline {
    pub txn_id: String,
    pub source: String,
    pub reason: String,
    pub account: String,
    pub date: String,
    pub amount: f64,
    pub direction: String,
    pub description: String,
    pub matched: Vec<String>,
    pub bank: Map<String, Value>,
}

pub fn row_id(reason: &str, txn_id: &str) -> String {
    match reason {
        DIFFERS => format!("bd_d_{txn_id}"),
        NOT_AT_BANK => format!("bd_n_{txn_id}"),
        _ => format!("bd_{txn_id}"),
    }
}

/// Keeps the row, or brings an answered one back when what was answered is no longer true. Never deletes.
/// - open: refreshed with what the bank says now;
/// - copy, kept (same bank values): left as answered;
/// - imported, removed, fixed: found again, so open again;
/// - kept with different bank values: the bank changed since, so open again.
pub fn record(conn: &Connection, d: &Decline, now: &str) -> Result<bool, String> {
    let id = row_id(&d.reason, &d.txn_id);
    let bank_json = Value::Object(d.bank.clone()).to_string();
    let existing: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT status, COALESCE(bank_json,'{}'), COALESCE(created_at,''), reason FROM bank_declined WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();
    let (status, created, reason) = match &existing {
        None => ("open".to_string(), now.to_string(), d.reason.clone()),
        Some((st, stored, created, reason)) => {
            let reopen = match st.as_str() {
                "open" => true,
                "copy" => false,
                "kept" => stored != &bank_json,
                _ => true,
            };
            if !reopen { return Ok(false); }
            // An open row keeps the reason it was first declined for: the check finding it missing too adds nothing.
            let reason = if st == "open" { reason.clone() } else { d.reason.clone() };
            ("open".to_string(), created.clone(), reason)
        }
    };
    let fresh = existing.as_ref().map_or(true, |(st, ..)| st != "open");
    let matched = json!(d.matched).to_string();
    let mut cols = Map::new();
    let s = |v: &str| Value::String(v.to_string());
    cols.insert("txn_id".into(), s(&d.txn_id));
    cols.insert("source".into(), s(&d.source));
    cols.insert("reason".into(), s(&reason));
    cols.insert("account_id".into(), s(&d.account));
    cols.insert("posted_at".into(), s(&d.date));
    cols.insert("amount".into(), json!(d.amount));
    cols.insert("direction".into(), s(&d.direction));
    cols.insert("description".into(), s(&d.description));
    cols.insert("matched_json".into(), s(&matched));
    cols.insert("bank_json".into(), s(&bank_json));
    cols.insert("status".into(), s(&status));
    cols.insert("resolved_by".into(), s(""));
    cols.insert("resolved_at".into(), s(""));
    cols.insert("created_at".into(), s(&created));
    cols.insert("updated_at".into(), s(now));
    crate::sync::record_upsert("bank_declined", &id, cols).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO bank_declined (id, txn_id, source, reason, account_id, posted_at, amount, direction, \
           description, matched_json, bank_json, status, resolved_by, resolved_at, created_at, updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'','',?13,?14)",
        rusqlite::params![id, d.txn_id, d.source, reason, d.account, d.date, d.amount, d.direction,
            d.description, matched, bank_json, status, created, now],
    ).map_err(|e| e.to_string())?;
    Ok(fresh)
}

/// Marks a row answered: imported, copy, fixed, kept or removed. `open` puts it back.
pub fn set_status(conn: &Connection, id: &str, status: &str, by: &str, now: &str) -> Result<(), String> {
    let (by, at) = if status == "open" { ("", "") } else { (by, now) };
    let mut cols = Map::new();
    cols.insert("status".into(), json!(status));
    cols.insert("resolved_by".into(), json!(by));
    cols.insert("resolved_at".into(), json!(at));
    cols.insert("updated_at".into(), json!(now));
    crate::sync::record_upsert("bank_declined", id, cols).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE bank_declined SET status=?1, resolved_by=?2, resolved_at=?3, updated_at=?4 WHERE id=?5",
        rusqlite::params![status, by, at, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn row_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let parse = |s: String| serde_json::from_str::<Value>(&s).unwrap_or(Value::Null);
    Ok(json!({
        "id": r.get::<_, String>(0)?, "txn_id": r.get::<_, String>(1)?, "source": r.get::<_, String>(2)?,
        "reason": r.get::<_, String>(3)?, "account_id": r.get::<_, String>(4)?, "posted_at": r.get::<_, String>(5)?,
        "amount": r.get::<_, f64>(6)?, "direction": r.get::<_, String>(7)?, "description": r.get::<_, String>(8)?,
        "matched": parse(r.get::<_, String>(9)?), "bank": parse(r.get::<_, String>(10)?),
        "status": r.get::<_, String>(11)?, "resolved_by": r.get::<_, String>(12)?, "resolved_at": r.get::<_, String>(13)?,
        "created_at": r.get::<_, String>(14)?,
    }))
}

pub const ROW_COLS: &str = "id, txn_id, source, reason, COALESCE(account_id,''), COALESCE(posted_at,''), COALESCE(amount,0), \
    COALESCE(direction,''), COALESCE(description,''), COALESCE(matched_json,'[]'), COALESCE(bank_json,'{}'), status, \
    COALESCE(resolved_by,''), COALESCE(resolved_at,''), COALESCE(created_at,'')";

/// Open rows first (newest bank date first), then the 50 answered most recently, so an answer can be undone.
pub fn list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for sql in [
        format!("SELECT {ROW_COLS} FROM bank_declined WHERE status='open' ORDER BY posted_at DESC, id"),
        format!("SELECT {ROW_COLS} FROM bank_declined WHERE status<>'open' ORDER BY resolved_at DESC LIMIT 50"),
    ] {
        let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = st.query_map([], row_json).map_err(|e| e.to_string())?;
        for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------
// Check against bank (R-587)
// ---------------------------------------------------------------------------------------------------------

/// A posted transaction as the bank reports it now. `account` is already the ledger's label for it.
#[derive(Clone, Debug, Default)]
pub struct BankTxn {
    pub id: String,
    pub account: String,
    pub date: String,
    pub amount: f64,
    pub direction: String,
    pub memo: String,
    /// The bank_txn columns Import would write.
    pub cols: Map<String, Value>,
}

/// A ledger row, with its account already folded onto the bank's label when it is the same account.
#[derive(Clone, Debug, Default)]
pub struct LedgerTxn {
    pub id: String,
    pub account: String,
    pub date: String,
    pub amount: f64,
    pub direction: String,
    pub memo: String,
    /// `source_format`: only bank-feed rows (`plaid`) can be "no longer at the bank".
    pub source: String,
    pub pending: bool,
    pub retracted: bool,
    /// R-590: the Plaid account id of the link that brought the row in (`raw_json.pa`), empty for older rows.
    pub pa: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Finding {
    /// The bank has it posted and no ledger row is it. `removed_before`: its own id was removed from the books.
    Missing { bank: usize, removed_before: bool },
    /// Paired with a ledger row whose values are not the bank's. `fields` names each one that differs.
    Differs { bank: usize, ledger: usize, fields: Vec<&'static str> },
    /// A posted bank-feed row, inside the bank's history for its account, that the bank does not list.
    NotAtBank { ledger: usize },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountTally {
    pub account: String,
    pub posted: usize,
    pub exact: usize,
    pub not_exact: usize,
    /// Paired with a statement or hand-entered row, which carries the statement's own text and date.
    pub from_statement: usize,
}

fn norm(memo: &str) -> String {
    memo.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn cents(x: f64) -> i64 { (x * 100.0).round() as i64 }

pub(crate) fn days_apart(a: &str, b: &str) -> i64 {
    let p = |s: &str| chrono::NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d").ok();
    match (p(a), p(b)) {
        (Some(x), Some(y)) => (x - y).num_days().abs(),
        _ => i64::MAX,
    }
}

fn differing(b: &BankTxn, l: &LedgerTxn) -> Vec<&'static str> {
    let mut f = Vec::new();
    if b.date.get(..10) != l.date.get(..10) { f.push("date"); }
    if cents(b.amount) != cents(l.amount) { f.push("amount"); }
    if b.direction != l.direction { f.push("direction"); }
    if norm(&b.memo) != norm(&l.memo) { f.push("memo"); }
    f
}

/// Holds every posted bank transaction to exactly one ledger row, in four passes, each pairing a ledger row
/// at most once:
/// 1. the bank's own id;
/// 2. identical content (account, date, amount to the cent, direction, memo): another link's copy;
/// 3. a bank-feed row on the same account, direction and amount within five days: the same payment with a
///    different date or memo, reported as Differs;
/// 4. a statement or hand-entered row on the same account, direction and amount within three days: present,
///    from the statement.
/// What is left of the bank is Missing. A posted bank-feed ledger row on a checked account, dated inside the
/// bank's history for it, that nothing paired is NotAtBank. Pending and withdrawn ledger rows are never
/// paired by content and never reported: the bank names their replacement, and Retracted by bank holds them.
/// `removed` is the ids removed from the books (tombstoned).
///
/// R-590: after the check told Jack to remove real payments, a ledger row is "not at the bank" only when the link
/// that brought it in is one this check read (`fed_pas`): another computer's link, or a row from before links were
/// stamped, cannot be judged by this feed.
pub fn compare(bank: &[BankTxn], ledger: &[LedgerTxn], removed: &std::collections::HashSet<String>,
               fed_pas: &std::collections::HashSet<String>) -> (Vec<Finding>, Vec<AccountTally>)
{
    let mut taken = vec![false; ledger.len()];
    let mut pair: Vec<Option<usize>> = vec![None; bank.len()];
    let by_id: std::collections::HashMap<&str, usize> = ledger.iter().enumerate().map(|(i, l)| (l.id.as_str(), i)).collect();
    for (bi, b) in bank.iter().enumerate() {
        if let Some(&li) = by_id.get(b.id.as_str()) {
            if !taken[li] { taken[li] = true; pair[bi] = Some(li); }
        }
    }
    let open = |l: &LedgerTxn| !l.pending && !l.retracted;
    for bi in 0..bank.len() {
        if pair[bi].is_some() { continue; }
        let b = &bank[bi];
        if let Some(li) = (0..ledger.len()).find(|&li| !taken[li] && open(&ledger[li]) && ledger[li].account == b.account
            && differing(b, &ledger[li]).is_empty()) {
            taken[li] = true; pair[bi] = Some(li);
        }
    }
    let near = |b: &BankTxn, l: &LedgerTxn, days: i64| l.account == b.account && l.direction == b.direction
        && cents(l.amount) == cents(b.amount) && days_apart(&l.date, &b.date) <= days;
    for (pass_plaid, days) in [(true, 5), (false, 3)] {
        for bi in 0..bank.len() {
            if pair[bi].is_some() { continue; }
            let b = &bank[bi];
            let best = (0..ledger.len())
                .filter(|&li| !taken[li] && open(&ledger[li]) && (ledger[li].source == "plaid") == pass_plaid && near(b, &ledger[li], days))
                .min_by_key(|&li| (days_apart(&ledger[li].date, &b.date), ledger[li].id.clone()));
            if let Some(li) = best { taken[li] = true; pair[bi] = Some(li); }
        }
    }

    let mut findings = Vec::new();
    let mut tallies: std::collections::BTreeMap<String, AccountTally> = Default::default();
    let mut earliest: std::collections::HashMap<&str, &str> = Default::default();
    for (bi, b) in bank.iter().enumerate() {
        let e = earliest.entry(b.account.as_str()).or_insert(b.date.as_str());
        if b.date.as_str() < *e { *e = b.date.as_str(); }
        let t = tallies.entry(b.account.clone()).or_insert_with(|| AccountTally { account: b.account.clone(), ..Default::default() });
        t.posted += 1;
        match pair[bi] {
            None => {
                t.not_exact += 1;
                findings.push(Finding::Missing { bank: bi, removed_before: removed.contains(&b.id) });
            }
            Some(li) if ledger[li].source != "plaid" && ledger[li].id != b.id => {
                t.exact += 1;
                t.from_statement += 1;
            }
            Some(li) => {
                let fields = differing(b, &ledger[li]);
                if fields.is_empty() { t.exact += 1; } else {
                    t.not_exact += 1;
                    findings.push(Finding::Differs { bank: bi, ledger: li, fields });
                }
            }
        }
    }
    for (li, l) in ledger.iter().enumerate() {
        if taken[li] || !open(l) || l.source != "plaid" || l.pa.is_empty() || !fed_pas.contains(&l.pa) { continue; }
        let Some(first) = earliest.get(l.account.as_str()) else { continue };
        if l.date.get(..10).unwrap_or("") < first.get(..10).unwrap_or("") { continue; }
        if let Some(t) = tallies.get_mut(&l.account) { t.not_exact += 1; }
        findings.push(Finding::NotAtBank { ledger: li });
    }
    (findings, tallies.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(id: &str, date: &str, amount: f64, memo: &str) -> BankTxn {
        BankTxn { id: id.into(), account: "Checking ··1111".into(), date: date.into(), amount, direction: "out".into(), memo: memo.into(), cols: Map::new() }
    }
    fn l(id: &str, date: &str, amount: f64, memo: &str, source: &str) -> LedgerTxn {
        LedgerTxn { id: id.into(), account: "Checking ··1111".into(), date: date.into(), amount, direction: "out".into(), memo: memo.into(), source: source.into(), pending: false, retracted: false, pa: "link1".into() }
    }
    fn none() -> std::collections::HashSet<String> { Default::default() }
    fn fed() -> std::collections::HashSet<String> { ["link1".to_string()].into_iter().collect() }
    fn cmp(bank: &[BankTxn], ledger: &[LedgerTxn], removed: &std::collections::HashSet<String>) -> (Vec<Finding>, Vec<AccountTally>) {
        compare(bank, ledger, removed, &fed())
    }

    #[test]
    fn an_exact_ledger_is_all_exact() {
        let bank = vec![b("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM"), b("btpl_b", "2026-10-02", 20.0, "FEE")];
        let ledger = vec![l("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM", "plaid"), l("btpl_b", "2026-10-02", 20.0, "FEE", "plaid")];
        let (f, t) = cmp(&bank, &ledger, &none());
        assert!(f.is_empty());
        assert_eq!(t[0].exact, 2);
        assert_eq!(t[0].not_exact, 0);
    }

    #[test]
    fn a_posted_transaction_with_no_ledger_row_is_missing() {
        let bank = vec![b("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM"), b("btpl_b", "2026-10-03", 1250.0, "WIRE TO ACME")];
        let ledger = vec![l("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM", "plaid")];
        let (f, _) = cmp(&bank, &ledger, &none());
        assert_eq!(f, vec![Finding::Missing { bank: 1, removed_before: false }]);
    }

    #[test]
    fn another_links_identical_copy_counts_as_present() {
        let bank = vec![b("btpl_mine", "2026-10-01", 500.0, "ZELLE TO SAM")];
        let ledger = vec![l("btpl_other", "2026-10-01", 500.0, "Zelle  to Sam", "plaid")];
        let (f, t) = cmp(&bank, &ledger, &none());
        assert!(f.is_empty());
        assert_eq!(t[0].exact, 1);
    }

    #[test]
    fn two_identical_real_charges_need_two_rows() {
        let bank = vec![b("btpl_a", "2026-10-01", 9.99, "WHATNOT FEE"), b("btpl_b", "2026-10-01", 9.99, "WHATNOT FEE")];
        let ledger = vec![l("btpl_x", "2026-10-01", 9.99, "WHATNOT FEE", "plaid")];
        let (f, _) = cmp(&bank, &ledger, &none());
        assert_eq!(f.len(), 1);
        assert!(matches!(f[0], Finding::Missing { .. }));
    }

    #[test]
    fn a_row_whose_amount_or_date_is_not_the_banks_differs() {
        let bank = vec![b("btpl_a", "2026-10-02", 500.25, "ZELLE TO SAM")];
        let ledger = vec![l("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM", "plaid")];
        let (f, t) = cmp(&bank, &ledger, &none());
        assert_eq!(f, vec![Finding::Differs { bank: 0, ledger: 0, fields: vec!["date", "amount"] }]);
        assert_eq!(t[0].not_exact, 1);
    }

    #[test]
    fn the_same_payment_under_another_memo_differs_rather_than_missing() {
        let bank = vec![b("btpl_mine", "2026-10-02", 2000.0, "WIRE TO ACME TRN: 12345678")];
        let ledger = vec![l("btpl_other", "2026-10-01", 2000.0, "WIRE TO ACME", "plaid")];
        let (f, _) = cmp(&bank, &ledger, &none());
        assert_eq!(f, vec![Finding::Differs { bank: 0, ledger: 0, fields: vec!["date", "memo"] }]);
    }

    #[test]
    fn a_statement_row_counts_as_present() {
        let bank = vec![b("btpl_a", "2026-10-02", 75.0, "AMAZON MKTPL")];
        let ledger = vec![l("bt_stmt", "2026-10-01", 75.0, "Amazon Marketplace", "pdf")];
        let (f, t) = cmp(&bank, &ledger, &none());
        assert!(f.is_empty());
        assert_eq!(t[0].from_statement, 1);
    }

    #[test]
    fn a_feed_row_the_bank_no_longer_lists_is_not_at_bank() {
        let bank = vec![b("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM")];
        let ledger = vec![
            l("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM", "plaid"),
            l("btpl_gone", "2026-10-04", 40.0, "GAS", "plaid"),
            // Before the bank's history for this account: not judged.
            l("btpl_old", "2024-01-04", 40.0, "GAS", "plaid"),
            // A statement row is never "no longer at the bank".
            l("bt_stmt", "2026-10-05", 40.0, "GAS", "csv"),
        ];
        let (f, _) = cmp(&bank, &ledger, &none());
        assert_eq!(f, vec![Finding::NotAtBank { ledger: 1 }]);
    }

    #[test]
    fn pending_and_withdrawn_rows_are_never_paired_or_reported() {
        let bank = vec![b("btpl_posted", "2026-10-02", 60.0, "SHELL OIL")];
        let mut pend = l("btpl_pend", "2026-10-01", 60.0, "SHELL OIL", "plaid");
        pend.pending = true;
        let mut gone = l("btpl_rtr", "2026-10-01", 60.0, "SHELL OIL", "plaid");
        gone.retracted = true;
        let (f, _) = cmp(&bank, &[pend, gone], &none());
        assert_eq!(f, vec![Finding::Missing { bank: 0, removed_before: false }]);
    }

    // R-590: the Mac's link brought the row in; this computer's link does not list it yet.
    #[test]
    fn a_row_from_another_link_is_never_called_not_at_the_bank() {
        let bank = vec![b("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM")];
        let mut other = l("btpl_mac", "2026-01-14", 1500.0, "ONLINE ACH PAYMENT", "plaid");
        other.pa = "link2".into();
        let mut legacy = l("btpl_old", "2026-01-14", 40.0, "GAS", "plaid");
        legacy.pa = String::new();
        let ledger = vec![l("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM", "plaid"), other, legacy];
        let (f, _) = cmp(&bank, &ledger, &none());
        assert!(f.is_empty(), "{f:?}");
    }

    #[test]
    fn a_removed_row_the_bank_still_lists_says_so() {
        let bank = vec![b("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM")];
        let removed: std::collections::HashSet<String> = ["btpl_a".to_string()].into_iter().collect();
        let (f, _) = cmp(&bank, &[], &removed);
        assert_eq!(f, vec![Finding::Missing { bank: 0, removed_before: true }]);
    }

    #[test]
    fn another_account_is_never_paired() {
        let bank = vec![b("btpl_a", "2026-10-01", 500.0, "ZELLE TO SAM")];
        let mut other = l("btpl_x", "2026-10-01", 500.0, "ZELLE TO SAM", "plaid");
        other.account = "Savings ··2222".into();
        let (f, _) = cmp(&bank, &[other], &none());
        assert_eq!(f, vec![Finding::Missing { bank: 0, removed_before: false }]);
    }

    fn status(c: &Connection, id: &str) -> String {
        c.query_row("SELECT status FROM bank_declined WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_answered_copy_stays_answered_and_an_import_that_vanished_reopens() {
        let _db = crate::db::init_test_store();
        let c = crate::db::pool().get().unwrap();
        let d = Decline { txn_id: "btpl_r586_copy".into(), source: "plaid".into(), reason: COPY.into(), amount: 5.0, ..Default::default() };
        assert!(record(&c, &d, "t1").unwrap());
        assert!(!record(&c, &d, "t2").unwrap(), "an open row is refreshed, not new");
        set_status(&c, "bd_btpl_r586_copy", "copy", "Jack", "t3").unwrap();
        let missing = Decline { reason: MISSING.into(), ..d.clone() };
        assert!(!record(&c, &missing, "t4").unwrap());
        assert_eq!(status(&c, "bd_btpl_r586_copy"), "copy");
        set_status(&c, "bd_btpl_r586_copy", "imported", "Jack", "t5").unwrap();
        assert!(record(&c, &missing, "t6").unwrap());
        assert_eq!(status(&c, "bd_btpl_r586_copy"), "open");
    }

    #[test]
    fn a_kept_difference_reopens_only_when_the_bank_changes_again() {
        let _db = crate::db::init_test_store();
        let c = crate::db::pool().get().unwrap();
        let mut d = Decline { txn_id: "btpl_r586_diff".into(), source: "plaid".into(), reason: DIFFERS.into(), ..Default::default() };
        d.bank.insert("amount".into(), json!(10.0));
        record(&c, &d, "t1").unwrap();
        set_status(&c, "bd_d_btpl_r586_diff", "kept", "Jack", "t2").unwrap();
        assert!(!record(&c, &d, "t3").unwrap());
        assert_eq!(status(&c, "bd_d_btpl_r586_diff"), "kept");
        d.bank.insert("amount".into(), json!(11.0));
        assert!(record(&c, &d, "t4").unwrap());
        assert_eq!(status(&c, "bd_d_btpl_r586_diff"), "open");
    }
}
