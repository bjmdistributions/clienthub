//! R-667 (Jack, 2026-11-17: "my book is wrong on all balances. it doesn't give me a way to identify or scan through
//! and cross check to see what the discrepancy is. This is important to always be accurate"): one account as a
//! statement. Every posted row, newest first, with the balance after it, counted back from what the bank says the
//! account holds today. Held beside the bank's own site, the balance on any day must match; where it stops matching
//! is where the books are wrong.
//!
//! Counting back from today is deliberate. There is no opening balance in this system, and the bank's balance today
//! is the one figure that is known to be right. So `balance after a row = today's balance - every row newer than it`.
//! A row doubled in the books, or one the books are missing, shifts every balance OLDER than it by its amount and
//! leaves every newer one right. Two days checked against the bank, one that agrees and an older one that does not,
//! therefore bracket the fault (`window`).
//!
//! Pending rows are not in the bank's balance yet, and a row the bank took back is not money that moved, so neither
//! is in the walk; both are listed apart. All sums are in whole cents.

use serde::Serialize;

pub struct Row {
    pub id: String,
    /// The day the bank posted it (YYYY-MM-DD, anything after the tenth character is ignored).
    pub date: String,
    pub description: String,
    pub amount: f64,
    /// "in" or "out".
    pub direction: String,
    /// When the row reached the books; orders rows within one day.
    pub came: String,
    pub pending: bool,
    pub retracted: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Line {
    pub id: String,
    pub date: String,
    pub description: String,
    pub amount: f64,
    pub direction: String,
    /// The account's balance after this row (a card: negative is owed). Absent for a row outside the walk.
    pub balance: Option<f64>,
}

#[derive(Serialize, Debug)]
pub struct Statement {
    /// Posted rows, newest first.
    pub lines: Vec<Line>,
    /// The balance before the first row on the books: 0 when the books hold the account from its first day.
    pub opening: f64,
    pub pending: Vec<Line>,
    pub pending_total: f64,
    pub withdrawn: Vec<Line>,
    pub withdrawn_total: f64,
}

/// A day the bank's own balance is known for: a statement's ending, or a balance a person read off the bank's site.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Point {
    pub date: String,
    /// What the bank says the account held at the end of that day.
    pub bank: f64,
    /// What the books say it held.
    pub books: f64,
    /// `bank - books`: 0 when they agree.
    pub gap: f64,
    /// "statement" or "you".
    pub source: String,
}

/// Where the books stop matching the bank: after `after` (the newest checked day that differs) and through `through`
/// (the checked day just newer than it that agrees; empty = today).
#[derive(Serialize, Debug, PartialEq)]
pub struct Window {
    pub after: String,
    pub through: String,
    pub gap: f64,
    /// Rows dated in the window.
    pub count: usize,
    /// Rows in the window that are exactly the difference: a doubled row is one of these.
    pub same_amount: Vec<String>,
}

fn cents(x: f64) -> i64 { (x * 100.0).round() as i64 }
fn money(c: i64) -> f64 { c as f64 / 100.0 }
fn day(s: &str) -> &str { s.get(..10).unwrap_or(s) }
fn signed(amount: f64, direction: &str) -> i64 { if direction == "in" { cents(amount) } else { -cents(amount) } }

pub fn walk(bank_balance: f64, mut rows: Vec<Row>) -> Statement {
    // Newest first; within a day, the row that reached the books last is on top.
    rows.sort_by(|a, b| day(&b.date).cmp(day(&a.date)).then_with(|| b.came.cmp(&a.came)).then_with(|| b.id.cmp(&a.id)));
    let mut st = Statement { lines: Vec::new(), opening: 0.0, pending: Vec::new(), pending_total: 0.0, withdrawn: Vec::new(), withdrawn_total: 0.0 };
    let (mut bal, mut pend, mut wd) = (cents(bank_balance), 0i64, 0i64);
    for r in rows {
        let s = signed(r.amount, &r.direction);
        let mut line = Line { id: r.id, date: day(&r.date).to_string(), description: r.description, amount: money(cents(r.amount)), direction: r.direction, balance: None };
        if r.retracted { wd += s; st.withdrawn.push(line); }
        else if r.pending { pend += s; st.pending.push(line); }
        else { line.balance = Some(money(bal)); bal -= s; st.lines.push(line); }
    }
    st.opening = money(bal);
    st.pending_total = money(pend);
    st.withdrawn_total = money(wd);
    st
}

/// What the books say the account held at the end of `date`: today's balance less every posted row after that day.
pub fn balance_on(bank_balance: f64, lines: &[Line], date: &str) -> f64 {
    let after: i64 = lines.iter().filter(|l| l.date.as_str() > day(date)).map(|l| signed(l.amount, &l.direction)).sum();
    money(cents(bank_balance) - after)
}

/// Hold each known bank balance against the books. `known` is (day, the bank's balance, source); a day a person
/// checked wins over a statement ending on the same day. Newest first.
pub fn points(bank_balance: f64, lines: &[Line], known: &[(String, f64, &str)]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::new();
    for (date, bank, source) in known {
        let d = day(date).to_string();
        if d.len() != 10 { continue; }
        let books = balance_on(bank_balance, lines, &d);
        let p = Point { date: d, bank: money(cents(*bank)), books, gap: money(cents(*bank) - cents(books)), source: source.to_string() };
        match out.iter_mut().find(|x| x.date == p.date) {
            Some(x) => { if p.source == "you" { *x = p; } }
            None => out.push(p),
        }
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    out
}

/// The stretch of days the fault is in, from the checked days; `None` while every checked day agrees.
pub fn window(lines: &[Line], points: &[Point]) -> Option<Window> {
    let at = points.iter().position(|p| cents(p.gap) != 0)?;
    let bad = &points[at];
    let through = if at > 0 { points[at - 1].date.clone() } else { String::new() };
    let inside = |l: &&Line| l.date > bad.date && (through.is_empty() || l.date <= through);
    // bank - books = (rows the books hold after that day) - (rows that really happened): a doubled row is the gap.
    let same_amount = lines.iter().filter(inside).filter(|l| signed(l.amount, &l.direction) == cents(bad.gap)).map(|l| l.id.clone()).collect();
    let count = lines.iter().filter(inside).count();
    Some(Window { after: bad.date.clone(), through, gap: bad.gap, count, same_amount })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, date: &str, amount: f64, direction: &str) -> Row {
        Row { id: id.into(), date: date.into(), description: id.into(), amount, direction: direction.into(), came: date.into(), pending: false, retracted: false }
    }

    fn book() -> Vec<Row> {
        vec![
            row("open", "2026-03-01", 1000.0, "in"),
            row("rent", "2026-03-05", 400.0, "out"),
            row("sale", "2026-03-09", 250.10, "in"),
            row("fuel", "2026-03-12", 60.05, "out"),
        ]
    }

    #[test]
    fn each_row_carries_the_balance_after_it_counted_back_from_the_bank() {
        let st = walk(790.05, book());
        let got: Vec<(&str, f64)> = st.lines.iter().map(|l| (l.id.as_str(), l.balance.unwrap())).collect();
        assert_eq!(got, vec![("fuel", 790.05), ("sale", 850.10), ("rent", 600.0), ("open", 1000.0)]);
        // The books hold the account from its first day: nothing before the first row.
        assert_eq!(st.opening, 0.0);
        assert_eq!(balance_on(790.05, &st.lines, "2026-03-09"), 850.10);
        assert_eq!(balance_on(790.05, &st.lines, "2026-03-10"), 850.10);
        assert_eq!(balance_on(790.05, &st.lines, "2026-02-28"), 0.0);
    }

    #[test]
    fn pending_and_withdrawn_rows_are_listed_apart_and_move_no_balance() {
        let mut rows = book();
        rows.push(Row { pending: true, ..row("hold", "2026-03-13", 20.0, "out") });
        rows.push(Row { retracted: true, ..row("gone", "2026-03-08", 75.0, "out") });
        let st = walk(790.05, rows);
        assert_eq!(st.lines.len(), 4);
        assert_eq!(st.lines[0].balance, Some(790.05));
        assert_eq!(st.opening, 0.0);
        assert_eq!((st.pending.len(), st.pending_total), (1, -20.0));
        assert_eq!((st.withdrawn.len(), st.withdrawn_total), (1, -75.0));
        assert_eq!(st.pending[0].balance, None);
    }

    #[test]
    fn a_card_counts_back_from_what_is_owed() {
        // A card's balance is owed, so negative: two charges and a payment.
        let st = walk(-130.0, vec![row("a", "2026-04-01", 100.0, "out"), row("pay", "2026-04-03", 50.0, "in"), row("b", "2026-04-04", 80.0, "out")]);
        let got: Vec<f64> = st.lines.iter().map(|l| l.balance.unwrap()).collect();
        assert_eq!(got, vec![-130.0, -50.0, -100.0]);
        assert_eq!(st.opening, 0.0);
    }

    #[test]
    fn a_doubled_row_is_bracketed_by_the_day_that_agrees_and_the_day_that_does_not() {
        // The books hold `rent` twice; the bank's balance is the true one.
        let mut rows = book();
        rows.push(row("rent2", "2026-03-05", 400.0, "out"));
        let st = walk(790.05, rows);
        // Read off the bank's site: 850.10 on the 9th (agrees), 1000 on the 2nd (the books say 1400).
        let known = vec![("2026-03-09".to_string(), 850.10, "you"), ("2026-03-02".to_string(), 1000.0, "statement")];
        let pts = points(790.05, &st.lines, &known);
        assert_eq!(pts[0].gap, 0.0);
        assert_eq!((pts[1].books, pts[1].gap), (1400.0, -400.0));
        let w = window(&st.lines, &pts).unwrap();
        assert_eq!((w.after.as_str(), w.through.as_str(), w.gap, w.count), ("2026-03-02", "2026-03-09", -400.0, 3));
        let mut same = w.same_amount.clone();
        same.sort();
        assert_eq!(same, vec!["rent", "rent2"]);
    }

    #[test]
    fn a_missing_row_is_bracketed_and_nothing_in_the_books_is_named() {
        // The books never got `sale`.
        let rows: Vec<Row> = book().into_iter().filter(|r| r.id != "sale").collect();
        let st = walk(790.05, rows);
        let pts = points(790.05, &st.lines, &[("2026-03-06".to_string(), 600.0, "you")]);
        // The books say 850.10 that day; the bank said 600: the books are short 250.10 of money in since.
        assert_eq!(pts[0].gap, -250.10);
        let w = window(&st.lines, &pts).unwrap();
        assert_eq!((w.after.as_str(), w.through.as_str(), w.count), ("2026-03-06", "", 1));
        assert!(w.same_amount.is_empty());
    }

    #[test]
    fn every_day_agreeing_leaves_no_window_and_your_own_check_wins_a_shared_day() {
        let st = walk(790.05, book());
        let known = vec![("2026-03-09".to_string(), 999.0, "statement"), ("2026-03-09".to_string(), 850.10, "you"), ("bad".to_string(), 1.0, "you")];
        let pts = points(790.05, &st.lines, &known);
        assert_eq!(pts.len(), 1);
        assert_eq!((pts[0].source.as_str(), pts[0].gap), ("you", 0.0));
        assert_eq!(window(&st.lines, &pts), None);
    }
}
