//! R-518: the two bank-row flags every query must read the same way, in both repos.
//!
//! This file is byte-identical in BUSINESS APP/src-tauri/src and clienthub-api/src. It has no `use crate::`.
//!
//! A bank row carries two flags inside `raw_json`:
//! - `$.pnd`: Plaid served it as pending. The money has not settled; its posted copy will arrive under a new id.
//! - `$.rtr`: the bank withdrew the row after it was booked, so it was kept for a person to resolve (the R-497
//!   Retracted by bank list). The money did not move under this row; if it moved at all, it moved under the
//!   posted copy, which is counted on its own.
//!
//! `raw_json` is read through `json_valid()` (invariant 10: an empty string must never throw).

/// SQL that is true when the row (under `alias`) is pending at the bank.
pub fn pending(alias: &str) -> String {
    format!("COALESCE(CASE WHEN json_valid({a}.raw_json) THEN json_extract({a}.raw_json,'$.pnd') END,0)<>0", a = alias)
}

/// SQL that is true when the bank retracted the row (under `alias`) and it was kept for a person to resolve.
pub fn retracted(alias: &str) -> String {
    format!("CASE WHEN json_valid({a}.raw_json) THEN json_extract({a}.raw_json,'$.rtr') END IS NOT NULL", a = alias)
}

/// SQL that is true when the row (under `alias`) is money that moved under this row: not retracted.
/// Every bank total (P&L, true net, overhead, summaries, Tie out, loan repaid, exports) reads only these rows.
/// A pending row still counts: it is real money in flight, and when its posted copy arrives the bank removes it.
pub fn counted(alias: &str) -> String {
    format!("NOT ({})", retracted(alias))
}

/// SQL that is true when an automatic pass (rules, booking from history) may act on the row: neither pending nor
/// retracted. A pending row is booked once its posted copy arrives, never before.
pub fn settled(alias: &str) -> String {
    format!("NOT ({}) AND NOT ({})", pending(alias), retracted(alias))
}

/// R-518 (F9): the message when booking a row to a deal that already holds its withdrawn copy.
pub const WITHDRAWN_COPY_BOOKED: &str = "This payment's withdrawn copy is already booked to this deal. Use Swap under Retracted by bank to move that booking onto this row.";

/// R-518 (F9): true when a row the bank withdrew is already booked to `deal_id` and looks like this row's earlier copy:
/// same direction, same account (its label, or its last four digits), an amount within 30%, dated from one day after
/// to ten days before this row. Booking this row to the same deal would count one payment twice while the withdrawn
/// copy waits under Retracted by bank; Swap moves its booking instead. Fails open (false) on a query error, since the
/// allocation's own guards still hold.
pub fn withdrawn_copy_booked_to(conn: &rusqlite::Connection, txn_id: &str, deal_id: &str) -> bool {
    let sql = format!(
        "SELECT 1 FROM bank_txn x \
           JOIN bank_txn w ON w.id <> x.id AND w.direction = x.direction \
           JOIN bank_allocation a ON a.bank_txn_id = w.id AND a.deal_flow_id = ?2 \
          WHERE x.id = ?1 AND {w_rtr} AND NOT ({x_rtr}) \
            AND (w.account_id = x.account_id \
                 OR (instr(w.account_id, '{sep}') > 0 \
                     AND substr(w.account_id, instr(w.account_id, '{sep}')) = substr(x.account_id, instr(x.account_id, '{sep}')))) \
            AND ABS(w.amount - x.amount) <= 0.30 * w.amount + 0.005 \
            AND julianday(substr(x.posted_at, 1, 10)) - julianday(substr(w.posted_at, 1, 10)) BETWEEN -1 AND 10 \
          LIMIT 1",
        w_rtr = retracted("w"), x_rtr = retracted("x"), sep = "\u{00b7}\u{00b7}",
    );
    conn.query_row(&sql, rusqlite::params![txn_id, deal_id], |_| Ok(())).is_ok()
}

/// `counted(alias)` as a string literal, for SQL that is a `const` built with `concat!`. The alias is a literal too:
/// `concat!("... WHERE ", bank_counted_sql!("t"), " AND ...")`.
#[macro_export]
macro_rules! bank_counted_sql {
    ($a:literal) => {
        concat!("NOT (CASE WHEN json_valid(", $a, ".raw_json) THEN json_extract(", $a, ".raw_json,'$.rtr') END IS NOT NULL)")
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_posted_copy_cannot_be_booked_to_the_deal_its_withdrawn_copy_holds() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE bank_txn (id TEXT PRIMARY KEY, account_id TEXT, direction TEXT, amount REAL, posted_at TEXT, raw_json TEXT);
             CREATE TABLE bank_allocation (id TEXT PRIMARY KEY, bank_txn_id TEXT, deal_flow_id TEXT, amount REAL);
             INSERT INTO bank_txn VALUES ('w','Checking \u{00b7}\u{00b7}1111','in',5000,'2026-10-01','{\"rtr\":\"2026-10-03T00:00:00Z\"}');
             INSERT INTO bank_txn VALUES ('p','Business checking \u{00b7}\u{00b7}1111','in',5000,'2026-10-03','{}');
             INSERT INTO bank_txn VALUES ('far','Checking \u{00b7}\u{00b7}1111','in',5000,'2026-10-30','{}');
             INSERT INTO bank_txn VALUES ('other','Card \u{00b7}\u{00b7}9999','in',5000,'2026-10-03','');
             INSERT INTO bank_allocation VALUES ('a','w','deal_1',5000);",
        ).unwrap();
        assert!(withdrawn_copy_booked_to(&c, "p", "deal_1"), "the posted copy, renamed account, same last four");
        assert!(!withdrawn_copy_booked_to(&c, "p", "deal_2"), "another deal is a different booking");
        assert!(!withdrawn_copy_booked_to(&c, "far", "deal_1"), "outside the ten-day window");
        assert!(!withdrawn_copy_booked_to(&c, "other", "deal_1"), "another account");
        assert!(!withdrawn_copy_booked_to(&c, "w", "deal_1"), "the withdrawn row itself is not its own copy");
    }

    #[test]
    fn the_literal_form_is_the_same_test() {
        assert_eq!(crate::bank_counted_sql!("t"), counted("t"));
        assert_eq!(crate::bank_counted_sql!("bt"), counted("bt"));
    }

    fn eval(raw: &str, sql: String) -> bool {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE bank_txn (id TEXT, raw_json TEXT)").unwrap();
        c.execute("INSERT INTO bank_txn VALUES ('a', ?1)", [raw]).unwrap();
        c.query_row(&format!("SELECT CASE WHEN {} THEN 1 ELSE 0 END FROM bank_txn t", sql), [], |r| r.get::<_, i64>(0)).unwrap() == 1
    }

    #[test]
    fn flags_read_through_json_valid() {
        assert!(eval(r#"{"pnd":true}"#, pending("t")));
        assert!(!eval(r#"{"pnd":false}"#, pending("t")));
        assert!(!eval("", pending("t")), "an empty raw_json is not pending and does not throw");
        assert!(eval(r#"{"rtr":"2026-10-14T10:00:00Z"}"#, retracted("t")));
        assert!(!eval("not json", retracted("t")));
    }

    #[test]
    fn counted_leaves_out_only_retracted_rows() {
        assert!(eval(r#"{"pnd":true}"#, counted("t")), "pending money in flight still counts");
        assert!(eval("", counted("t")));
        assert!(!eval(r#"{"rtr":"x"}"#, counted("t")));
    }

    #[test]
    fn settled_leaves_out_pending_and_retracted_rows() {
        assert!(eval(r#"{}"#, settled("t")));
        assert!(eval("", settled("t")));
        assert!(!eval(r#"{"pnd":true}"#, settled("t")));
        assert!(!eval(r#"{"rtr":"x","pnd":false}"#, settled("t")));
    }
}
