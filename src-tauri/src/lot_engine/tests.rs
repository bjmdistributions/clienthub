//! End-to-end tests, and the guard that keeps the two copies of this module identical.

#![cfg(test)]

use std::collections::HashSet;

use super::export::{brand_counts, manifest, pull_sheet, reconcile, ManifestOpts};
use super::model::TitleRisk;
use super::pipeline::clean_sheet;
use super::price::{lot_totals, Pricing};
use super::rank::{rank, Allow, RankOpts, Sort, Want};
use super::read::Sheet;

/// A sheet with every shape the pipeline has to survive, in one file: a title block above
/// the header, a `SUM()` totals row, four spellings of one shelf, a blank description, a
/// barcode carrying two brands in real quantity, a `$0` row that must inherit its sibling's
/// price, an unreadable location, and an approval column with a declined row.
fn messy_sheet() -> Sheet {
    let rows: Vec<Vec<&str>> = vec![
        vec!["ACME WAREHOUSE — WEEKLY EXPORT", "", "", "", "", "", ""],
        vec!["generated 2026-08-21", "", "", "", "", "", ""],
        vec!["", "", "", "", "", "", ""],
        vec!["UPC/EAN", "Location", "Box #", "Remaining", "Title", "MSRP", "Approved"],
        // One shelf, four spellings — must collapse to 43-127-01B with 100 units.
        vec!["196969506827", "43-127-01B", "BOX3", "40", "Nike Air Max 90 Big Kid Shoes, Black, Size 6.5", "$190.00", "yes"],
        vec!["196969506827", "43 127 01b", "BOX3", "30", "Nike Air Max 90 Big Kid Shoes, Black, Size 6.5", "190", "yes"],
        vec!["196969506827", "4312701B", "BOX3", "20", "Nike Air Max 90 Big Kid Shoes, Black, Size 6.5", "", "yes"],
        vec!["196969506827", "43--127--01B", "BOX3", "10", "", "190.00", "yes"],
        // A different shelf, and the letter O typed for a zero.
        vec!["197968446084", "43-11O-03A", "", "380", "New Balance 9060 Big Kid Shoes, Great Plains/Twilight Haze, Size 6.5", "150.00", "yes"],
        // Rule two: same barcode, a genuinely different shoe. Must stay its own line.
        vec!["197968446084", "43-110-03A", "", "1", "New Balance 550 - Men's (Navy/Electric Sky) Size 12", "110.00", "yes"],
        // Two brands in real quantity under one barcode — the 38-barcode case.
        vec!["100000000001", "44-002-01", "", "60", "Nike Court Vision Low", "80.00", "yes"],
        vec!["100000000001", "44-002-02", "", "40", "adidas Samba OG Shoes", "100.00", "yes"],
        // Apparel, so a footwear-only ALLOW must reject the slot it sits in.
        vec!["100000000002", "44-002-01", "", "15", "Champion Crew Neck Sweatshirt, 2XL", "60.00", "yes"],
        // Declined by the warehouse.
        vec!["100000000003", "44-003-01", "", "25", "Puma Suede Classic", "70.00", "no"],
        // Unreadable location — excluded from lots, reported, never guessed.
        vec!["100000000004", "OVERSTOCK BIN", "", "12", "Vans Old Skool", "65.00", "yes"],
        // A totals row: no barcode, no description, the sum of the sheet.
        vec!["", "", "", "633", "", "", ""],
    ];
    Sheet {
        rows: rows
            .into_iter()
            .map(|r| r.into_iter().map(|c| c.to_string()).collect())
            .collect(),
        format: "csv".into(),
        sheet_name: None,
        note: None,
    }
}

#[test]
fn end_to_end_over_a_messy_sheet() {
    let r = clean_sheet(&messy_sheet()).unwrap();

    // Detection told the truth about what it read.
    assert_eq!(r.detection.header_row, 4);
    assert_eq!(r.detection.location_col.as_deref(), Some("Location"));
    assert_eq!(r.detection.msrp_col.as_deref(), Some("MSRP"));
    assert_eq!(r.detection.flag_cols, vec!["Approved".to_string()]);

    // Nothing vanished: every input unit is a stack or a reported drop.
    assert_eq!(r.quality.reconciliation_gap(), 0);
    assert_eq!(r.quality.units_in, 633 + 633);

    // The four spellings became one slot...
    let one = r
        .stacks
        .iter()
        .filter(|s| s.location == "43-127-01B")
        .collect::<Vec<_>>();
    assert_eq!(one.len(), 1, "four spellings, one shelf, one product");
    assert_eq!(one[0].units, 100);
    // ...and the $0 row inherited the levelled price, so retail is not understated.
    assert_eq!(one[0].msrp, 190.0);
    // The blank description was named from a barcode nothing else disputes.
    assert_eq!(one[0].title_risk, TitleRisk::NamedFromBarcode);

    // Rule two: the 550 was not relabelled as a 9060.
    let nb: Vec<_> = r.stacks.iter().filter(|s| s.location == "43-110-03A").collect();
    assert_eq!(nb.len(), 2);
    assert!(nb.iter().any(|s| s.title.contains("9060")));
    assert!(nb.iter().any(|s| s.title.contains("550")));

    // One stray unit against 380 is a typo; two brands at 60/40 is an ambiguity.
    let stray = r.conflicts.iter().find(|c| c.upc == "197968446084").unwrap();
    assert_eq!(stray.grade, "stray");
    let split = r.conflicts.iter().find(|c| c.upc == "100000000001").unwrap();
    assert_eq!(split.grade, "split");
    assert_eq!(r.quality.upcs_ambiguous, 1);

    // Both drops are named, with their units.
    assert!(r.quality.drops.iter().any(|d| d.reason.contains("totals row") && d.units == 633));
    assert!(r.quality.drops.iter().any(|d| d.reason.contains("approval column") && d.units == 25));
    assert!(r
        .quality
        .drops
        .iter()
        .any(|d| d.reason.contains("location could not be read") && d.units == 12));

    // The audit map explains the merge that happened.
    let repaired = r
        .repairs
        .iter()
        .find(|m| m.raw == "43-11O-03A")
        .expect("the O-for-zero spelling is in the audit map");
    assert_eq!(repaired.canonical.as_deref(), Some("43-110-03A"));
    assert!(repaired.rule.contains("letter"));

    assert_eq!(r.quality.units, 596);
    assert_eq!(r.quality.units_dropped, 633 - 596 + 633);
}

#[test]
fn ranking_and_the_three_exports_agree_end_to_end() {
    let cleaned = clean_sheet(&messy_sheet()).unwrap();

    // "Slots holding nothing but footwear, ranked by Nike content" — strictly, so the slot
    // carrying a sweatshirt is rejected.
    let want = Want {
        brands: vec!["Nike".into()],
        ..Default::default()
    };
    let allow = Allow {
        categories: vec!["Footwear".into()],
        ..Default::default()
    };
    let ranked = rank(
        &cleaned.stacks,
        &want,
        &allow,
        &RankOpts {
            slack: 0.0,
            sort: Sort::Concentration,
            min_units: 0,
            min_pct: 0.0,
            limit: 100,
        },
        &HashSet::new(),
    );
    assert!(
        ranked.slots.iter().all(|s| s.location != "44-002-01"),
        "44-002-01 holds a sweatshirt, so a footwear-only ALLOW must reject the whole slot"
    );
    assert!(ranked.slots.iter().any(|s| s.location == "43-127-01B"));

    // Stage the top slots into a lot, and price them.
    let taken: HashSet<String> = ranked.slots.iter().map(|s| s.location.clone()).collect();
    let lot: Vec<_> = cleaned
        .stacks
        .iter()
        .filter(|s| taken.contains(&s.location))
        .cloned()
        .collect();

    let mut pricing = Pricing::flat(0.26);
    pricing.overrides.insert("Apparel-Top".into(), 0.10);
    let totals = lot_totals(&lot, &pricing);
    assert!(totals.units > 0);

    let opts = ManifestOpts {
        lot_name: "Lot 1".into(),
        include_slots: false,
        ..Default::default()
    };
    let m = manifest(&lot, &pricing, &opts);
    let b = brand_counts(&lot, &pricing, "Lot 1");
    let p = pull_sheet(&lot, &pricing, "Lot 1");

    // The assertion the spec says to write first.
    reconcile(&m, &b, &p, totals.units).unwrap();

    // A slot never lands in two lots: the pull sheet has one row per location.
    let slots = p.sections.last().unwrap();
    let locs: HashSet<&String> = slots.rows.iter().map(|r| &r[0]).collect();
    assert_eq!(locs.len(), slots.rows.len());

    // Every title in the output came from the input. Nothing was invented.
    let src: HashSet<&str> = cleaned.stacks.iter().map(|s| s.title.as_str()).collect();
    let lines = m.sections.last().unwrap();
    let desc = lines.col("Description").unwrap();
    assert!(lines.rows.iter().all(|r| src.contains(r[desc].as_str())));

    // One product, one price, across every stack of it.
    let mut seen: std::collections::HashMap<&str, f64> = Default::default();
    for s in &cleaned.stacks {
        if let Some(prev) = seen.insert(s.title.as_str(), s.msrp) {
            assert_eq!(prev, s.msrp, "{} carries two prices", s.title);
        }
    }
}

/// Staging a slot takes it out of the pool immediately, so header counts and every later
/// search only show what is unclaimed — and removing it is a separate, deliberate step.
#[test]
fn staged_stock_leaves_the_pool_and_totals_drop_with_it() {
    let cleaned = clean_sheet(&messy_sheet()).unwrap();
    let all = rank(
        &cleaned.stacks,
        &Want::default(),
        &Allow::default(),
        &RankOpts::default(),
        &HashSet::new(),
    );

    let mut unavailable = HashSet::new();
    unavailable.insert("43-127-01B".to_string());
    let after = rank(
        &cleaned.stacks,
        &Want::default(),
        &Allow::default(),
        &RankOpts::default(),
        &unavailable,
    );

    assert_eq!(after.pool_slots, all.pool_slots - 1);
    assert_eq!(after.matched_units, all.matched_units - 100);
}

// ---------------------------------------------------------------------------------------
// Cross-repo drift guard
// ---------------------------------------------------------------------------------------

/// A cheap content hash. Not a security primitive — it only has to notice that a file
/// changed, and it must not need a crate the other binary might lack.
fn fnv1a(bytes: &[u8], mut h: u64) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Hash of every source file in this module, computed at compile time from the files
/// themselves.
pub fn module_tree_hash() -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    // Line endings differ between checkouts; the content does not.
    // `tests.rs` is hashed too, so the two copies cannot drift in what they assert. The
    // pinned constant is stripped before hashing, or the hash would chase its own tail.
    for src in [
        include_str!("tests.rs"),
        include_str!("mod.rs"),
        include_str!("classify.rs"),
        include_str!("export.rs"),
        include_str!("model.rs"),
        include_str!("pipeline.rs"),
        include_str!("price.rs"),
        include_str!("rank.rs"),
        include_str!("report.rs"),
        include_str!("read.rs"),
        include_str!("slot.rs"),
    ] {
        let normalised: Vec<u8> = src
            .lines()
            .filter(|l| !l.contains("PINNED_TREE_HASH"))
            .flat_map(|l| l.bytes().chain(std::iter::once(b'\n')))
            .filter(|b| *b != b'\r')
            .collect();
        h = fnv1a(&normalised, h);
    }
    h
}

/// `lot_engine/` exists byte-identically in two repositories: the desktop app and the
/// server. This test is what stops them drifting.
///
/// **When it fails after you edited the engine:** copy the whole `lot_engine/` directory
/// into the other repository, then put the new number in `PINNED_TREE_HASH` in BOTH copies.
/// The other repo's build then fails until it has the same files, which is the point — a
/// server cleaner and a desktop cleaner that disagree produce two different manifests for
/// the same sheet, and the disagreement is invisible until a buyer counts the units.
#[test]
fn module_tree_hash_is_pinned() {
    const PINNED_TREE_HASH: u64 = 0x4a797e4690891c3c;
    let actual = module_tree_hash();
    assert_eq!(
        actual, PINNED_TREE_HASH,
        "lot_engine has changed. Copy the whole directory into the other repository and \
         update PINNED_TREE_HASH to {actual:#x} in both copies."
    );
}
