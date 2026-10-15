//! R-533 (audit LD-01): one rule for "the carrier is paid", in both repos.
//!
//! This file is byte-identical in BUSINESS APP/src-tauri/src and clienthub-api/src. It has no `use crate::`.
//!
//! A live load is a `freight_bookings` row with `archived = 0` and a status other than cancelled, quote or quoted.
//! Since R-470 a load is paid only when its bank payment is linked: the server's Link, adopt and settle write
//! `paid_amount` as the sum of the load's own bank links (never capped at the rate). A typed figure with no bank link
//! behind it ("marked") and a recorded $0 exist only as rows from before R-470.
//!
//! Two rules, because Pay carriers already splits loads this way ("To pay" against "Link the bank payment"):
//! - **The gate** (`not_paid_codes`): a load holds its deal's completion until its state is `paid`. Unpaid, part paid,
//!   a $0 and a typed figure all hold it (R-509: the deal waits until the shipping payment is attached).
//! - **The money** (`owes_money`, `still_owed`, `deal_carrier`): what is still to be sent to the carrier. A load owes
//!   money while nothing is recorded (`unpaid`), while its bank links fall short of its rate (`part`, which owes only the
//!   rest of the rate), and while a $0 is recorded (no money moved). A typed figure with no bank link behind it
//!   (`marked`, above $0) owes nothing here: before R-470 the amount typed was what the carrier was paid, often below the
//!   quote, and counting it again would take it twice off Free cash. It still holds the gate until its payment is
//!   linked. Telling a part payment from a typed one needs the bank links, so this is decided per load in Rust, never in
//!   plain SQL.
//!
//! Every money-owed load is gate-held (the money rule is a subset of the gate rule).

/// One live load of a deal, as the rules read it. `code` is its load number, or the code the app shows for a load
/// without one (the caller's `code_for` / `booking_code_of`).
#[derive(Debug, Clone, PartialEq)]
pub struct Load {
    pub id: String,
    pub code: String,
    pub paid: Option<f64>,
    pub rate: Option<f64>,
}

/// The code a load shows: its load number, else `L-` and the first six characters of its id after `fb_`, upper case.
/// Twin of the server's `logistics::code_for` and the desktop's `freight::booking_code_of`, for the shared files that
/// cannot call either.
pub fn code_of(id: &str, load_number: &str) -> String {
    let n = load_number.trim();
    if !n.is_empty() {
        return n.to_string();
    }
    let rest = id.strip_prefix("fb_").unwrap_or(id);
    format!("L-{}", rest.chars().take(6).collect::<String>().to_ascii_uppercase())
}

/// One of the deal's `shipping` bank allocations whose bank row still exists.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub amount: f64,
    pub note: String,
}

/// Whether `note` carries `code` (a load number) as a whole token: the characters either side of it are not letters,
/// digits or a dash, so `LD-0012` is not found in `LD-00123` or `LD-0012-B`. Case does not matter.
pub fn note_has_token(note: &str, code: &str) -> bool {
    let (note, code) = (note.to_lowercase(), code.trim().to_lowercase());
    if code.is_empty() {
        return false;
    }
    let part = |c: char| c.is_alphanumeric() || c == '-';
    note.match_indices(&code).any(|(at, m)| {
        let before = note[..at].chars().next_back().map_or(true, |c| !part(c));
        let after = note[at + m.len()..].chars().next().map_or(true, |c| !part(c));
        before && after
    })
}

/// How the bank links stand against what a load was paid: `linked` when they cover it (within 50 cents), `partial`
/// when some do, `none` when none do. A recorded $0 is always `none`.
///
/// Per load when the deal's links name its loads (a link whose note carries a load number as a whole token is that
/// load's own; links that name no load are shared out, in id order, to the loads their named links leave short).
/// When no link names any of the deal's loads, or `booking_id` is not among `loads`, it is the deal-level rule: the
/// deal's links against what all its loads were paid. `loads` are the deal's live loads, `links` its shipping links.
pub fn link_state(loads: &[Load], links: &[Link], booking_id: &str) -> &'static str {
    let verdict = |linked: f64, paid: f64| {
        if linked >= paid - 0.50 {
            "linked"
        } else if linked > 0.005 {
            "partial"
        } else {
            "none"
        }
    };
    // A deal with no live load has no payment to carry.
    if loads.is_empty() {
        return "none";
    }
    let mine = loads.iter().find(|l| l.id == booking_id);
    if matches!(mine, Some(Load { paid: Some(p), .. }) if *p <= 0.005) {
        return "none";
    }
    if let Some(me) = mine {
        let named = |c: &str| links.iter().any(|l| note_has_token(&l.note, c));
        if loads.iter().any(|l| named(&l.code)) {
            let named_sum = |c: &str| links.iter().filter(|l| note_has_token(&l.note, c)).map(|l| l.amount).sum::<f64>();
            let mut pool: f64 = links
                .iter()
                .filter(|l| !loads.iter().any(|x| note_has_token(&l.note, &x.code)))
                .map(|l| l.amount)
                .sum();
            let mut order: Vec<&Load> = loads.iter().collect();
            order.sort_by(|a, b| a.id.cmp(&b.id));
            let mut linked = 0.0;
            for l in order {
                let n = named_sum(&l.code);
                let take = pool.min((l.paid.unwrap_or(0.0) - n).max(0.0));
                pool -= take;
                if l.id == me.id {
                    linked = n + take;
                }
            }
            return verdict(linked, me.paid.unwrap_or(0.0));
        }
    }
    let paid: f64 = loads.iter().filter_map(|l| l.paid).sum();
    let linked: f64 = links.iter().map(|l| l.amount).sum();
    verdict(linked, paid)
}

/// Where a load's payment stands. `unpaid`: nothing recorded. `marked`: a figure is recorded but the bank does not
/// carry it in full (typed before R-470; a $0 is always this). `part`: linked, but short of the rate by more than 50
/// cents. `paid`: the bank payment is linked for the rate, or for any amount while the load has no rate.
pub fn paid_state(loads: &[Load], links: &[Link], booking_id: &str, paid: Option<f64>, rate: Option<f64>) -> &'static str {
    match paid {
        None => "unpaid",
        Some(a) if a <= 0.005 => "marked",
        Some(a) => {
            if link_state(loads, links, booking_id) != "linked" {
                "marked"
            } else if rate.map_or(false, |r| r > 0.005 && a < r - 0.50) {
                "part"
            } else {
                "paid"
            }
        }
    }
}

/// The gate: the codes of the loads whose state is not `paid`, in the order of `loads`. A deal completes only when
/// this is empty (or a person says there is no carrier to pay).
pub fn not_paid_codes(loads: &[Load], links: &[Link]) -> Vec<String> {
    loads
        .iter()
        .filter(|l| paid_state(loads, links, &l.id, l.paid, l.rate) != "paid")
        .map(|l| l.code.clone())
        .collect()
}

/// The money: whether a load in `state` (from `paid_state`) still owes its carrier money: nothing recorded, part paid
/// through the bank, or a $0 recorded.
pub fn owes_money(state: &str, paid: Option<f64>) -> bool {
    state == "unpaid" || state == "part" || paid.map_or(false, |p| p <= 0.005)
}

/// What a load in `state` still owes its carrier: its rate less what is recorded, for a load that owes money; 0
/// otherwise, and 0 when the rate is not known (the deal's estimate then falls back to what the buyer was charged).
pub fn still_owed(state: &str, paid: Option<f64>, rate: Option<f64>) -> f64 {
    if !owes_money(state, paid) {
        return 0.0;
    }
    let r = rate.unwrap_or(0.0);
    if r <= 0.005 {
        return 0.0;
    }
    let left = r - paid.unwrap_or(0.0).max(0.0);
    if left > 0.0 {
        (left * 100.0).round() / 100.0
    } else {
        0.0
    }
}

/// One live load's verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadVerdict {
    pub id: String,
    pub code: String,
    /// `unpaid`, `marked`, `part` or `paid` (`paid_state`).
    pub state: &'static str,
    /// It still owes its carrier money (`owes_money`).
    pub owes: bool,
    /// What it still owes (`still_owed`).
    pub still_owed: f64,
}

/// One deal's carrier position: every live load's verdict, how many still owe money and what they still owe, and the
/// codes the gate holds the deal for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DealCarrier {
    /// Per live load, in the order given.
    pub loads: Vec<LoadVerdict>,
    /// How many loads still owe money (the money rule).
    pub owing: i64,
    /// What they still owe, rounded to the cent, each against its own recorded figure (for the per-truck payable rows).
    pub still_owed: f64,
    /// What the deal's shipping is expected to cost, truck by truck: the rate of a truck that still owes money (what it
    /// will cost; 0 when its rate is not known), and the recorded figure of one that does not (linked, or typed before
    /// R-470). The deal's remainder (`remainder`) is this less what is already known, so a bank link that has not
    /// reached a truck's recorded figure yet is never counted twice.
    pub expected: f64,
    /// The codes of the loads not paid in full (the gate).
    pub not_paid: Vec<String>,
}

impl DealCarrier {
    /// What is still to pay the carriers: the expected cost less `known` (what the deal already counts as paid: its
    /// bank links, else its recorded figures), and never more than the loads that owe money still owe. So a figure
    /// typed before R-470 that a smaller bank link only partly covers adds nothing: that load owes nothing.
    pub fn remainder(&self, known: f64) -> f64 {
        let left = (self.expected - known).max(0.0).min(self.still_owed);
        (left * 100.0).round() / 100.0
    }
}

/// `DealCarrier` for one deal's live loads and its shipping links.
pub fn deal_carrier(loads: &[Load], links: &[Link]) -> DealCarrier {
    let mut out = DealCarrier::default();
    for l in loads {
        let state = paid_state(loads, links, &l.id, l.paid, l.rate);
        let left = still_owed(state, l.paid, l.rate);
        let owes = owes_money(state, l.paid);
        if owes {
            out.owing += 1;
        }
        out.still_owed += left;
        out.expected += if owes { l.rate.filter(|r| *r > 0.005).unwrap_or(0.0) } else { l.paid.unwrap_or(0.0).max(0.0) };
        if state != "paid" {
            out.not_paid.push(l.code.clone());
        }
        out.loads.push(LoadVerdict { id: l.id.clone(), code: l.code.clone(), state, owes, still_owed: left });
    }
    out.still_owed = (out.still_owed * 100.0).round() / 100.0;
    out.expected = (out.expected * 100.0).round() / 100.0;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(id: &str, code: &str, paid: Option<f64>, rate: Option<f64>) -> Load {
        Load { id: id.into(), code: code.into(), paid, rate }
    }
    fn link(amount: f64, note: &str) -> Link {
        Link { amount, note: note.into() }
    }

    #[test]
    fn a_load_without_a_number_shows_a_code_from_its_id() {
        assert_eq!(code_of("fb_ab12cd34ef", ""), "L-AB12CD");
        assert_eq!(code_of("fb_ab12cd34ef", " LD-0042 "), "LD-0042");
        assert_eq!(code_of("xyz", ""), "L-XYZ");
    }

    #[test]
    fn a_token_is_a_whole_load_number() {
        assert!(note_has_token("Carrier LD-0012 paid", "LD-0012"));
        assert!(note_has_token("ld-0012", "LD-0012"));
        assert!(!note_has_token("LD-00123", "LD-0012"));
        assert!(!note_has_token("LD-0012-B", "LD-0012"));
        assert!(!note_has_token("anything", " "));
    }

    /// The golden table: one load with a rate of 800 unless said, the deal's links as given. (state, gate holds,
    /// owes money, still owed).
    #[test]
    fn the_golden_table() {
        let cases: Vec<(&str, Option<f64>, Option<f64>, Vec<Link>, &str, bool, bool, f64)> = vec![
            ("nothing recorded", None, Some(800.0), vec![], "unpaid", true, true, 800.0),
            ("part paid, 300 linked by name", Some(300.0), Some(800.0), vec![link(300.0, "LD-1")], "part", true, true, 500.0),
            ("a recorded $0", Some(0.0), Some(800.0), vec![], "marked", true, true, 800.0),
            // Before R-470 the figure typed was what the carrier was paid, often under the quote: settled for the money,
            // but the deal still waits for its bank link.
            ("typed 300 under the rate, no link", Some(300.0), Some(800.0), vec![], "marked", true, false, 0.0),
            ("typed 800 at the rate, no link", Some(800.0), Some(800.0), vec![], "marked", true, false, 0.0),
            ("typed 900 over the rate, no link", Some(900.0), Some(800.0), vec![], "marked", true, false, 0.0),
            ("linked for the rate", Some(800.0), Some(800.0), vec![link(800.0, "LD-1")], "paid", false, false, 0.0),
            ("linked within 50 cents", Some(799.6), Some(800.0), vec![link(799.6, "")], "paid", false, false, 0.0),
            ("overpaid and linked", Some(900.0), Some(800.0), vec![link(900.0, "LD-1")], "paid", false, false, 0.0),
            ("no rate, 300 linked", Some(300.0), None, vec![link(300.0, "")], "paid", false, false, 0.0),
            ("no rate, nothing recorded", None, None, vec![], "unpaid", true, true, 0.0),
            ("no rate, a $0", Some(0.0), Some(0.0), vec![], "marked", true, true, 0.0),
            ("an unnamed link pays the only load", Some(800.0), Some(800.0), vec![link(800.0, "wire 7731")], "paid", false, false, 0.0),
        ];
        for (name, paid, rate, links, state, holds, owes, left) in cases {
            let loads = vec![load("fb_1", "LD-1", paid, rate)];
            assert_eq!(paid_state(&loads, &links, "fb_1", paid, rate), state, "{name}: state");
            assert_eq!(!not_paid_codes(&loads, &links).is_empty(), holds, "{name}: gate");
            let st = paid_state(&loads, &links, "fb_1", paid, rate);
            assert_eq!(owes_money(st, paid), owes, "{name}: owes money");
            assert_eq!(still_owed(st, paid, rate), left, "{name}: still owed");
            let d = deal_carrier(&loads, &links);
            assert_eq!((d.owing == 1, d.still_owed, d.not_paid.len() == 1), (owes, left, holds), "{name}: the deal summary");
            // The money rule never says owed where the gate says paid.
            assert!(!owes || holds, "{name}: money owed implies the gate holds");
        }
    }

    #[test]
    fn named_links_read_per_load_and_unnamed_ones_fill_the_short_loads_in_id_order() {
        // Two loads of 500: A is linked by name, B has only the unnamed 500 left in the pool.
        let loads = vec![load("fb_a", "LD-A", Some(500.0), Some(500.0)), load("fb_b", "LD-B", Some(500.0), Some(500.0))];
        let links = vec![link(500.0, "LD-A"), link(500.0, "older wire")];
        assert_eq!(link_state(&loads, &links, "fb_a"), "linked");
        assert_eq!(link_state(&loads, &links, "fb_b"), "linked");
        assert!(not_paid_codes(&loads, &links).is_empty());
        // Without the unnamed wire, B's typed 500 is not carried: marked, and the gate holds B only.
        let links = vec![link(500.0, "LD-A")];
        assert_eq!(paid_state(&loads, &links, "fb_b", Some(500.0), Some(500.0)), "marked");
        assert_eq!(not_paid_codes(&loads, &links), vec!["LD-B".to_string()]);
    }

    #[test]
    fn with_no_named_link_the_deal_level_rule_applies() {
        let loads = vec![load("fb_a", "LD-A", Some(400.0), Some(400.0)), load("fb_b", "LD-B", Some(600.0), Some(600.0))];
        assert_eq!(link_state(&loads, &[link(1000.0, "")], "fb_a"), "linked");
        assert_eq!(link_state(&loads, &[link(700.0, "")], "fb_b"), "partial");
        assert_eq!(link_state(&loads, &[], "fb_b"), "none");
        // Not among the loads: the deal-level rule.
        assert_eq!(link_state(&loads, &[link(1000.0, "")], "fb_gone"), "linked");
    }

    #[test]
    fn a_figure_with_no_live_load_is_never_paid() {
        assert_eq!(link_state(&[], &[], "fb_gone"), "none");
        assert_eq!(paid_state(&[], &[], "fb_gone", Some(500.0), None), "marked");
        assert_eq!(deal_carrier(&[], &[link(500.0, "")]), DealCarrier::default());
    }

    #[test]
    fn the_remainder_is_never_more_than_the_owed_loads_still_owe() {
        // A typed 800 that a 500 deal link only partly covers owes nothing more: the bank's 500 is what is known.
        let typed = deal_carrier(&[load("fb_t", "LD-T", Some(800.0), Some(800.0))], &[link(500.0, "")]);
        assert_eq!((typed.owing, typed.remainder(500.0)), (0, 0.0));
        // A link that has not reached the truck's figure yet is not counted twice: 700 rate, 200 linked, 500 left.
        let open = deal_carrier(&[load("fb_o", "LD-O", None, Some(700.0))], &[link(200.0, "")]);
        assert_eq!(open.remainder(200.0), 500.0);
        // Part paid: 300 of 800 linked by name, 500 left.
        let part = deal_carrier(&[load("fb_p", "LD-P", Some(300.0), Some(800.0))], &[link(300.0, "LD-P")]);
        assert_eq!(part.remainder(300.0), 500.0);
    }

    #[test]
    fn the_gate_keeps_the_order_it_was_given() {
        let loads = vec![
            load("fb_2", "LD-2", None, Some(100.0)),
            load("fb_1", "LD-1", Some(800.0), Some(800.0)),
            load("fb_3", "LD-3", Some(0.0), Some(50.0)),
        ];
        assert_eq!(not_paid_codes(&loads, &[link(800.0, "LD-1")]), vec!["LD-2".to_string(), "LD-3".to_string()]);
    }

    #[test]
    fn a_deal_adds_up_what_its_loads_still_owe() {
        // A: part paid, 300 of 800 linked by name. B: typed 500 at its rate, no link. C: nothing recorded, rate 250.
        let loads = vec![
            load("fb_a", "LD-A", Some(300.0), Some(800.0)),
            load("fb_b", "LD-B", Some(500.0), Some(500.0)),
            load("fb_c", "LD-C", None, Some(250.0)),
        ];
        let links = vec![link(300.0, "LD-A")];
        let d = deal_carrier(&loads, &links);
        let seen: Vec<(&str, &str, bool, f64)> = d.loads.iter().map(|v| (v.code.as_str(), v.state, v.owes, v.still_owed)).collect();
        assert_eq!(seen, vec![("LD-A", "part", true, 500.0), ("LD-B", "marked", false, 0.0), ("LD-C", "unpaid", true, 250.0)]);
        assert_eq!(d.loads[0].id, "fb_a");
        assert_eq!((d.owing, d.still_owed), (2, 750.0));
        // Expected cost: A's rate, B's typed figure, C's rate.
        assert_eq!(d.expected, 800.0 + 500.0 + 250.0);
        assert_eq!(d.not_paid, vec!["LD-A".to_string(), "LD-B".to_string(), "LD-C".to_string()]);
        // The rest of A is linked: A is paid; B still holds the gate and owes nothing; C still owes 250.
        let links = vec![link(300.0, "LD-A"), link(500.0, "LD-A second")];
        let loads2 = vec![load("fb_a", "LD-A", Some(800.0), Some(800.0)), loads[1].clone(), loads[2].clone()];
        let d = deal_carrier(&loads2, &links);
        assert_eq!((d.owing, d.still_owed), (1, 250.0));
        assert_eq!(d.not_paid, vec!["LD-B".to_string(), "LD-C".to_string()]);
    }
}
