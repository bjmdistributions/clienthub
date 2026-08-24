//! Warehouse slot codes: the grammar, and the repair ladder that gets a free-text cell to it.
//!
//! The highest-leverage stage in the system. The same physical shelf appears under many
//! spellings; unmerged, the inventory fragments into slots that do not exist — 8,250
//! "slots" that should have been 7,680.
//!
//! This is a DIFFERENT NAMESPACE from `inventory.location`, which is a canonical FOB
//! `City, ST` driving the storefront state map. A slot code must never be written there:
//! `43-127-04A` would put a lot on the map at nowhere.

use std::sync::OnceLock;

use regex::Regex;

/// Canonical shape: zone(2)-rack(3)-shelf(2) plus an optional sub-slot letter A-D.
const ZONE_W: usize = 2;
const RACK_W: usize = 3;
const SHELF_W: usize = 2;

/// Which rung of the ladder resolved a spelling. Reported in the audit map so an
/// unexpected merge can be traced to the rule that caused it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rung {
    /// Already canonical. No repair needed.
    Exact,
    /// Uppercase and trim only.
    Trim,
    /// Letter-for-digit swap: O -> 0, I -> 1, L -> 1.
    OcrSwap,
    /// Separators collapsed (`43--127-01B`, `43'127'01B`).
    Separators,
    /// A glued run was split (`4312701B` -> `43 127 01B`).
    Split,
    /// Nothing matched. Excluded from lots. Never guessed.
    Unparsed,
}

impl Rung {
    pub fn label(self) -> &'static str {
        match self {
            Rung::Exact => "already canonical",
            Rung::Trim => "trimmed and uppercased",
            Rung::OcrSwap => "letter read as a digit (O/I/L)",
            Rung::Separators => "separators normalised",
            Rung::Split => "glued run split",
            Rung::Unparsed => "no match — excluded",
        }
    }

    pub fn is_repair(self) -> bool {
        !matches!(self, Rung::Exact | Rung::Unparsed)
    }
}

fn canonical_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([0-9]{2})-([0-9]{3})-([0-9]{2})([A-D]?)$").unwrap())
}

fn parts_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Written in the intersection of the regex dialects this project uses: no named
    // groups, no lookbehind, no inline flags.
    RE.get_or_init(|| Regex::new(r"^([0-9]{1,3}) ([0-9]{1,4}) ([0-9]{1,3})([A-D]?)$").unwrap())
}

fn format_slot(zone: &str, rack: &str, shelf: &str, sub: &str) -> String {
    format!(
        "{:0>zw$}-{:0>rw$}-{:0>sw$}{}",
        zone,
        rack,
        shelf,
        sub,
        zw = ZONE_W,
        rw = RACK_W,
        sw = SHELF_W
    )
}

/// Peel an optional trailing sub-slot letter A-D off the end of an otherwise-numeric tail.
///
/// Returns `(body, sub)`. The letter is only taken when what precedes it is a digit, or one
/// of the three letters that are themselves mis-typed digits — so `...0LB` still yields `B`,
/// while `BULKA` yields nothing.
fn peel_sub(s: &str) -> (String, String) {
    let b: Vec<char> = s.chars().collect();
    if b.len() >= 2 {
        let last = b[b.len() - 1];
        let prev = b[b.len() - 2];
        let prev_is_digitish = prev.is_ascii_digit() || matches!(prev, 'O' | 'I' | 'L');
        if ('A'..='D').contains(&last) && prev_is_digitish {
            return (b[..b.len() - 1].iter().collect(), last.to_string());
        }
    }
    (s.to_string(), String::new())
}

/// Rung 2 — swap O/I/L for 0/1/1, but only when the swap leaves the body with no letters
/// left. `43-11O-03A` is a zero typed as the letter O; `43-127-BIN` is not a slot code.
fn ocr_swap(body: &str) -> Option<String> {
    if !body.chars().any(|c| c == 'O' || c == 'I' || c == 'L') {
        return None;
    }
    let swapped: String = body
        .chars()
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    if swapped.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(swapped)
}

/// Collapse every run of non-alphanumerics to a single space.
fn collapse_separators(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_sep = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            in_sep = false;
        } else {
            if !in_sep && !out.is_empty() {
                out.push(' ');
            }
            in_sep = true;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Rung 4 — split a glued digit run into the canonical widths.
///
/// ONLY a 7-digit run is split, into the canonical 2/3/2 — the widths the code is defined
/// with, and the spec's own worked example (`4312701B` -> `43 127 01B`). Every other length
/// is ambiguous: 6 digits could be 1/3/2 or 2/2/2 or 2/3/1, and 8 could be 2/4/2 or 3/3/2,
/// with nothing in the cell to say which. A wrong split invents a slot that does not exist
/// and quietly sells stock from it, so those are left unparsed. "Never guess."
///
/// A four-digit rack still resolves when the cell separates its parts (`43-1275-01`); it is
/// only the glued form that is refused.
fn split_glued(digits: &str) -> Option<(String, String, String)> {
    if digits.len() != 7 {
        return None;
    }
    let (a, rest) = digits.split_at(2);
    let (b, c) = rest.split_at(3);
    Some((a.to_string(), b.to_string(), c.to_string()))
}

/// Rung 4, two-part case — `43-12701B` arrives as `43` + `12701`. Same rule: only the
/// canonical 3/2 width is split.
fn split_rack_shelf(digits: &str) -> Option<(String, String)> {
    if digits.len() != 5 {
        return None;
    }
    let (a, b) = digits.split_at(3);
    Some((a.to_string(), b.to_string()))
}

/// Run the repair ladder. Returns the canonical code and the rung that produced it, or
/// `(None, Rung::Unparsed)`.
///
/// The ladder, in order:
///   1. uppercase and trim
///   2. O/I/L -> 0/1/1 when that leaves nothing alphabetic
///   3. collapse non-alphanumeric runs to one space
///   4. split a glued run when fewer than three parts remain
///   5. match `(\d{1,3}) (\d{1,4}) (\d{1,3})([A-D]?)` and zero-pad
///   6. no match -> unparsed, excluded from lots, never guessed
pub fn normalize(raw: &str) -> (Option<String>, Rung) {
    let trimmed = raw.trim().to_ascii_uppercase();
    if trimmed.is_empty() {
        return (None, Rung::Unparsed);
    }

    // Rung 1 — already canonical.
    if canonical_re().is_match(&trimmed) {
        return (
            Some(trimmed.clone()),
            if trimmed == raw { Rung::Exact } else { Rung::Trim },
        );
    }

    // Rung 2 — OCR swap, applied to the body with any sub-slot letter held aside so the
    // letter itself is not mistaken for something to swap.
    let (body0, sub0) = peel_sub(&trimmed);
    let mut rung = Rung::Trim;
    let working = match ocr_swap(&body0) {
        Some(swapped) => {
            rung = Rung::OcrSwap;
            format!("{swapped}{sub0}")
        }
        None => trimmed.clone(),
    };

    if canonical_re().is_match(&working) {
        return (Some(working), rung);
    }

    // Rung 3 — separators.
    let collapsed = collapse_separators(&working);
    if collapsed != working && rung == Rung::Trim {
        rung = Rung::Separators;
    }

    let mut fields: Vec<String> = collapsed.split(' ').filter(|p| !p.is_empty()).map(|p| p.to_string()).collect();

    // Rung 4 — glued runs.
    if fields.len() < 3 {
        let joined = fields.join("");
        let (body, sub) = peel_sub(&joined);
        if !body.chars().all(|c| c.is_ascii_digit()) {
            return (None, Rung::Unparsed);
        }
        let rebuilt = if fields.len() == 2 {
            // `43` + `12701B` — the zone is already separate, split the tail.
            let (b0, tail) = (fields[0].clone(), fields[1].clone());
            let (tail_body, tail_sub) = peel_sub(&tail);
            if !b0.chars().all(|c| c.is_ascii_digit())
                || !tail_body.chars().all(|c| c.is_ascii_digit())
            {
                return (None, Rung::Unparsed);
            }
            split_rack_shelf(&tail_body).map(|(r, s)| vec![b0, r, format!("{s}{tail_sub}")])
        } else {
            split_glued(&body).map(|(z, r, s)| vec![z, r, format!("{s}{sub}")])
        };
        match rebuilt {
            Some(v) => {
                fields = v;
                rung = Rung::Split;
            }
            None => return (None, Rung::Unparsed),
        }
    }

    // Rung 5 — match and zero-pad. Extra trailing fields are not a slot code; a warehouse
    // cell with four parts is something else, and guessing which three to keep is exactly
    // what produces slots that do not exist.
    if fields.len() != 3 {
        return (None, Rung::Unparsed);
    }
    let candidate = fields.join(" ");
    match parts_re().captures(&candidate) {
        Some(c) => {
            let out = format_slot(&c[1], &c[2], &c[3], &c[4]);
            // A repair that produced something already canonical from an already-canonical
            // input is not a repair.
            if out == raw {
                return (Some(out), Rung::Exact);
            }
            (Some(out), rung)
        }
        None => (None, Rung::Unparsed),
    }
}

/// Zone — the first slice of the canonical code. 16 of them in the reference export.
pub fn zone(code: &str) -> &str {
    &code[..ZONE_W.min(code.len())]
}

/// Rack — `ZZ-RRR`. 385 of them. Sorting by the canonical string is a warehouse walk in
/// aisle order, so slicing gives the pick path for free.
pub fn rack(code: &str) -> &str {
    let w = ZONE_W + 1 + RACK_W;
    &code[..w.min(code.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> Option<String> {
        normalize(s).0
    }

    #[test]
    fn canonical_passes_through() {
        assert_eq!(norm("43-127-01B").as_deref(), Some("43-127-01B"));
        assert_eq!(normalize("43-127-01B").1, Rung::Exact);
        assert_eq!(norm("43-127-04A").as_deref(), Some("43-127-04A"));
        // No sub-slot is normal.
        assert_eq!(norm("43-127-04").as_deref(), Some("43-127-04"));
    }

    /// Every spelling the spec lists for one physical shelf must land on one code.
    #[test]
    fn the_specs_spelling_list_collapses_to_one_slot() {
        for raw in [
            "43-127-01B",
            "43 127 01b",
            "43'127'01B",
            "43--127-01B",
            "43-127--01B",
            "43-12701B",
            "4312701B",
        ] {
            assert_eq!(norm(raw).as_deref(), Some("43-127-01B"), "failed on {raw:?}");
        }
    }

    #[test]
    fn letter_o_reads_as_zero() {
        assert_eq!(norm("43-11O-03A").as_deref(), Some("43-110-03A"));
        assert_eq!(normalize("43-11O-03A").1, Rung::OcrSwap);
        // I and L both read as 1.
        assert_eq!(norm("43-I27-0LB").as_deref(), Some("43-127-01B"));
    }

    /// The swap must not fire on a cell that is genuinely words.
    #[test]
    fn ocr_swap_does_not_fire_on_words() {
        assert_eq!(norm("OVERSTOCK BIN"), None);
        assert_eq!(norm("FLOOR"), None);
        assert_eq!(norm("RETURNS-LANE"), None);
    }

    #[test]
    fn zero_padding_is_applied() {
        assert_eq!(norm("4-7-1").as_deref(), Some("04-007-01"));
        assert_eq!(norm("4 7 1C").as_deref(), Some("04-007-01C"));
    }

    /// A four-digit rack is inside the grammar when the cell separates its parts...
    #[test]
    fn four_digit_rack_resolves_when_separated() {
        assert_eq!(norm("43-1275-01").as_deref(), Some("43-1275-01"));
        assert_eq!(norm("43 1275 01C").as_deref(), Some("43-1275-01C"));
    }

    /// ...but an ambiguous glued run is left unparsed rather than guessed into a slot that
    /// does not exist. 8 digits could be 2/4/2 or 3/3/2; nothing in the cell says which.
    #[test]
    fn ambiguous_glue_is_never_guessed() {
        assert_eq!(norm("43127501"), None); // 8 digits
        assert_eq!(norm("431270"), None);   // 6 digits: 1/3/2? 2/2/2? unknowable
        assert_eq!(norm("4312"), None);
    }

    #[test]
    fn empty_and_junk_are_unparsed() {
        assert_eq!(norm(""), None);
        assert_eq!(norm("   "), None);
        assert_eq!(norm("N/A"), None);
        assert_eq!(norm("-"), None);
        assert_eq!(normalize("N/A").1, Rung::Unparsed);
    }

    /// A trailing letter outside A-D is not a sub-slot.
    #[test]
    fn sub_slot_letters_are_a_to_d_only() {
        assert_eq!(norm("43-127-01E"), None);
        assert_eq!(norm("43-127-01Z"), None);
    }

    #[test]
    fn four_part_cells_are_not_slots() {
        assert_eq!(norm("43-127-01-99"), None);
    }

    #[test]
    fn zone_and_rack_slices() {
        assert_eq!(zone("43-127-04A"), "43");
        assert_eq!(rack("43-127-04A"), "43-127");
    }
}
