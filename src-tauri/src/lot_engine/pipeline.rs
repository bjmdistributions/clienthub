//! The cleaning pipeline — seven stages, strictly ordered. Later stages depend on earlier
//! ones having run.
//!
//! 1. drop what is not inventory
//! 2. normalise locations
//! 3. backfill missing titles
//! 4. grade barcodes — merge nothing
//! 5. resolve prices
//! 6. classify
//! 7. roll up to stacks
//!
//! Every row that leaves the pipeline is reported with a reason and a count. The invariant
//! to check first is `sum(stack.units) == sum(input units) - sum(reported drops)`, which
//! catches key collisions, double-counting and filter leakage in one assertion.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::Result;

use super::classify::{classify, Classified};
use super::model::{
    CleanResult, DropReason, LocationRepair, QualityReport, Stack, TitleRisk, UpcConflict,
    UpcConflictName, KEY_SEP,
};
use super::read::{clean_upc, detect_columns, describe, parse_number, read_sheet, Columns, Sheet};
use super::slot::{self, Rung};

/// A barcode is only "ambiguous" when the runner-up product is real: 89% of conflicted
/// barcodes are a single stray unit against hundreds.
const AMBIGUOUS_MIN_UNITS: i64 = 3;
const AMBIGUOUS_MIN_SHARE: f64 = 0.05;

/// A row whose quantity is at least this share of the whole sheet is a totals row whatever
/// else it looks like. One such row doubles the inventory.
const TOTALS_ROW_SHARE: f64 = 0.4;

/// How many worked examples to keep per drop reason, so a surprising drop can be eyeballed
/// rather than trusted.
const DROP_EXAMPLES: usize = 3;

#[derive(Debug, Clone)]
struct Row {
    location_raw: String,
    location: Option<String>,
    r#box: String,
    upc: String,
    title: String,
    units: i64,
    msrp: f64,
    title_risk: TitleRisk,
}

#[derive(Default)]
struct Drops {
    by_reason: BTreeMap<String, DropReason>,
}

impl Drops {
    fn add(&mut self, reason: &str, units: i64, example: &str) {
        let e = self.by_reason.entry(reason.to_string()).or_insert_with(|| DropReason {
            reason: reason.to_string(),
            rows: 0,
            units: 0,
            examples: Vec::new(),
        });
        e.rows += 1;
        e.units += units;
        if e.examples.len() < DROP_EXAMPLES && !example.trim().is_empty() {
            e.examples.push(example.trim().to_string());
        }
    }

    fn into_vec(self) -> Vec<DropReason> {
        let mut v: Vec<DropReason> = self.by_reason.into_values().collect();
        v.sort_by(|a, b| b.units.cmp(&a.units).then(b.rows.cmp(&a.rows)));
        v
    }
}

/// Most common value, ties broken by the largest — deterministic, so two runs over the same
/// file cannot disagree.
fn modal_price(values: &[f64]) -> f64 {
    let mut counts: HashMap<u64, (usize, f64)> = HashMap::new();
    for v in values {
        if *v <= 0.0 {
            continue;
        }
        let key = (v * 100.0).round() as u64;
        let e = counts.entry(key).or_insert((0, *v));
        e.0 += 1;
    }
    counts
        .into_values()
        .max_by(|a, b| a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)))
        .map(|(_, v)| v)
        .unwrap_or(0.0)
}

/// Clean a sheet from disk.
pub fn clean_path(path: &str) -> Result<CleanResult> {
    let sheet = read_sheet(path)?;
    clean_sheet(&sheet)
}

/// Clean an already-read sheet. This is the single entry point both binaries call, and the
/// function the cross-repo parity test compares field by field.
pub fn clean_sheet(sheet: &Sheet) -> Result<CleanResult> {
    let cols = detect_columns(&sheet.rows);
    let detection = describe(sheet, &cols);
    let body_start = cols.header_row.map(|i| i + 1).unwrap_or(0);
    let body: &[Vec<String>] = &sheet.rows[body_start.min(sheet.rows.len())..];

    let mut q = QualityReport::default();
    let mut drops = Drops::default();

    // -----------------------------------------------------------------------------------
    // Stage 1 — drop what is not inventory
    // -----------------------------------------------------------------------------------
    let cell = |r: &Vec<String>, i: Option<usize>| -> String {
        i.and_then(|i| r.get(i)).map(|s| s.trim().to_string()).unwrap_or_default()
    };

    // The totals row is found by shape, before anything is dropped, because its quantity is
    // what makes it obvious: a single row carrying most of the sheet.
    let gross_units: i64 = body
        .iter()
        .map(|r| parse_number(&cell(r, cols.units)).unwrap_or(0.0).max(0.0) as i64)
        .sum();

    let mut rows: Vec<Row> = Vec::with_capacity(body.len());
    let mut dropped_with_title = 0usize;

    for r in body {
        let units = parse_number(&cell(r, cols.units)).unwrap_or(0.0);
        let units = if units.is_finite() && units > 0.0 { units.round() as i64 } else { 0 };
        let title = cell(r, cols.title);
        let upc = clean_upc(&cell(r, cols.upc));
        let location_raw = cell(r, cols.location);
        let label = if !title.is_empty() {
            title.clone()
        } else if !location_raw.is_empty() {
            location_raw.clone()
        } else {
            upc.clone()
        };

        q.rows_in += 1;
        q.units_in += units;

        // A wholly blank row is furniture, not a drop worth naming.
        if units == 0 && title.is_empty() && upc.is_empty() && location_raw.is_empty() {
            drops.add("blank row", 0, "");
            continue;
        }

        // The totals row: no barcode, no description, and a quantity that is most of the
        // sheet. All three tests are needed. The quantity test alone drops a genuine row on
        // any sheet small enough for one slot to be a large share of it — and a true SUM()
        // row is exactly half the gross, because it counts everything else once.
        if gross_units > 0
            && upc.is_empty()
            && title.is_empty()
            && (units as f64) >= (gross_units as f64) * TOTALS_ROW_SHARE
        {
            drops.add("totals row — a SUM() of the sheet, not stock", units, &label);
            continue;
        }

        // An approval column's negatives are rows the warehouse already declined.
        let mut declined = false;
        for fi in &cols.flags {
            let v = r.get(*fi).map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
            if matches!(v.as_str(), "no" | "n" | "false") {
                declined = true;
                break;
            }
        }
        if declined {
            drops.add("marked no in an approval column", units, &label);
            continue;
        }

        // "Detect as UPC is empty" — the spec's structural test for a row that is not stock.
        // Only applied when the sheet actually has a barcode column to test.
        if cols.upc.is_some() && upc.is_empty() {
            if !title.is_empty() {
                dropped_with_title += 1;
            }
            drops.add("no barcode on the row", units, &label);
            continue;
        }

        if units <= 0 {
            drops.add("no quantity on the row", 0, &label);
            continue;
        }

        rows.push(Row {
            location_raw,
            location: None,
            r#box: cell(r, cols.r#box),
            upc,
            title,
            units,
            msrp: parse_number(&cell(r, cols.msrp)).unwrap_or(0.0).max(0.0),
            title_risk: TitleRisk::Typed,
        });
    }

    if dropped_with_title > 0 {
        q.warnings.push(format!(
            "{dropped_with_title} rows had a description but no barcode and were dropped. If this \
             sheet legitimately ships stock without barcodes, the barcode column is the wrong \
             test for it — check the drop examples before selling from this import."
        ));
    }

    // -----------------------------------------------------------------------------------
    // Stage 2 — normalise locations
    // -----------------------------------------------------------------------------------
    let mut repair_index: HashMap<String, (Option<String>, Rung, usize, i64)> = HashMap::new();
    for row in rows.iter_mut() {
        let e = repair_index
            .entry(row.location_raw.clone())
            .or_insert_with(|| {
                let (c, rung) = slot::normalize(&row.location_raw);
                (c, rung, 0, 0)
            });
        e.2 += 1;
        e.3 += row.units;
        row.location = e.0.clone();
    }

    let mut repairs: Vec<LocationRepair> = repair_index
        .iter()
        .map(|(raw, (canonical, rung, rows, units))| LocationRepair {
            raw: raw.clone(),
            canonical: canonical.clone(),
            rule: rung.label().to_string(),
            rows: *rows,
            units: *units,
        })
        .collect();
    repairs.sort_by(|a, b| a.raw.cmp(&b.raw));

    q.location_spellings = repair_index.len();
    q.locations_repaired = repair_index.values().filter(|(_, r, _, _)| r.is_repair()).count();
    q.locations_unparsed = repair_index.values().filter(|(c, _, _, _)| c.is_none()).count();
    q.locations = repair_index
        .values()
        .filter_map(|(c, _, _, _)| c.clone())
        .collect::<HashSet<_>>()
        .len();

    // -----------------------------------------------------------------------------------
    // Stage 3 — backfill missing titles
    //
    // This is THE ONLY place a barcode decides what a title says, so every filled row is
    // graded and the grade travels onto the manifest.
    // -----------------------------------------------------------------------------------
    let mut upc_titles: HashMap<String, HashMap<String, i64>> = HashMap::new();
    for row in &rows {
        if row.upc.is_empty() || row.title.trim().is_empty() {
            continue;
        }
        *upc_titles
            .entry(row.upc.clone())
            .or_default()
            .entry(row.title.clone())
            .or_insert(0) += row.units;
    }

    q.titles_blank = rows.iter().filter(|r| r.title.trim().is_empty()).count();
    for row in rows.iter_mut() {
        if !row.title.trim().is_empty() {
            continue;
        }
        match upc_titles.get(&row.upc) {
            Some(names) if !names.is_empty() => {
                // Modal title, ties broken alphabetically so two runs cannot disagree.
                let best = names
                    .iter()
                    .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                    .map(|(t, _)| t.clone())
                    .unwrap_or_default();
                row.title = best;
                row.title_risk = if names.len() > 1 {
                    TitleRisk::GuessedFromBarcode
                } else {
                    TitleRisk::NamedFromBarcode
                };
                q.titles_backfilled += 1;
            }
            _ => {
                row.title_risk = TitleRisk::Unknown;
                q.titles_unknown += 1;
            }
        }
    }

    // -----------------------------------------------------------------------------------
    // Stage 4 — grade barcodes. MERGE NOTHING.
    //
    // A provisional brand per title is used ONLY to grade the barcode, never to rewrite a
    // title. Two rows typed differently stay two products.
    // -----------------------------------------------------------------------------------
    let mut title_class: HashMap<String, Classified> = HashMap::new();
    for row in &rows {
        let t = row.title.trim();
        if t.is_empty() {
            continue;
        }
        title_class.entry(t.to_string()).or_insert_with(|| classify(t));
    }

    struct NameAgg {
        units: i64,
        locations: HashSet<String>,
        prices: Vec<f64>,
    }
    let mut by_upc: HashMap<String, HashMap<String, NameAgg>> = HashMap::new();
    for row in &rows {
        if row.upc.is_empty() {
            continue;
        }
        let e = by_upc
            .entry(row.upc.clone())
            .or_default()
            .entry(row.title.clone())
            .or_insert_with(|| NameAgg {
                units: 0,
                locations: HashSet::new(),
                prices: Vec::new(),
            });
        e.units += row.units;
        if let Some(l) = &row.location {
            e.locations.insert(l.clone());
        }
        if row.msrp > 0.0 {
            e.prices.push(row.msrp);
        }
    }

    q.upcs = by_upc.len();
    let mut conflicts: Vec<UpcConflict> = Vec::new();
    let mut ambiguous_upcs: HashSet<String> = HashSet::new();

    for (upc, names) in &by_upc {
        if names.len() < 2 {
            continue;
        }
        q.upcs_multi_name += 1;

        let total: i64 = names.values().map(|n| n.units).sum();
        let mut list: Vec<(&String, &NameAgg)> = names.iter().collect();
        list.sort_by(|a, b| b.1.units.cmp(&a.1.units).then(a.0.cmp(b.0)));

        let brand_of = |t: &str| -> Option<String> {
            title_class.get(t.trim()).and_then(|c| c.brand.clone())
        };
        let brands: HashSet<Option<String>> = list.iter().map(|(t, _)| brand_of(t)).collect();
        let runner_up = list.get(1).map(|(_, a)| a.units).unwrap_or(0);
        let share = if total > 0 { runner_up as f64 / total as f64 } else { 0.0 };
        let different_brands = brands.len() > 1;

        // Precedence, in this order, so the tallies add up.
        let grade = if runner_up >= AMBIGUOUS_MIN_UNITS && share >= AMBIGUOUS_MIN_SHARE && different_brands
        {
            ambiguous_upcs.insert(upc.clone());
            q.upcs_ambiguous += 1;
            q.units_ambiguous += total;
            "split"
        } else if runner_up <= 2 {
            "stray"
        } else if !different_brands {
            "same_brand"
        } else {
            "other"
        };

        let all_prices: HashSet<u64> = list
            .iter()
            .flat_map(|(_, a)| a.prices.iter().map(|p| (p * 100.0).round() as u64))
            .collect();

        conflicts.push(UpcConflict {
            upc: upc.clone(),
            grade: grade.to_string(),
            units: total,
            one_price: all_prices.len() == 1 && list.len() >= 2,
            names: list
                .iter()
                .map(|(t, a)| UpcConflictName {
                    title: (*t).clone(),
                    brand: brand_of(t),
                    units: a.units,
                    share: if total > 0 { a.units as f64 / total as f64 } else { 0.0 },
                    locations: a.locations.len(),
                    msrp: modal_price(&a.prices),
                })
                .collect(),
        });
    }
    conflicts.sort_by(|a, b| b.units.cmp(&a.units).then(a.upc.cmp(&b.upc)));

    // -----------------------------------------------------------------------------------
    // Stage 5 — resolve prices
    //
    // Empty titles are EXCLUDED from grouping. Including them makes every undescribed row
    // one pseudo-product and stamps it with a modal price — that fabricated $45,335 of MSRP.
    // -----------------------------------------------------------------------------------
    let mut title_prices: HashMap<&str, Vec<f64>> = HashMap::new();
    let mut upc_prices: HashMap<&str, Vec<f64>> = HashMap::new();
    for row in &rows {
        let t = row.title.trim();
        if !t.is_empty() && row.msrp > 0.0 {
            title_prices.entry(t).or_default().push(row.msrp);
        }
        if !row.upc.is_empty() && row.msrp > 0.0 {
            upc_prices.entry(row.upc.as_str()).or_default().push(row.msrp);
        }
    }
    let title_price: HashMap<String, f64> = title_prices
        .iter()
        .map(|(t, v)| ((*t).to_string(), modal_price(v)))
        .collect();
    let upc_price: HashMap<String, f64> = upc_prices
        .iter()
        .map(|(u, v)| ((*u).to_string(), modal_price(v)))
        .collect();

    // The levelling pass. Without it a stack whose rows were all $0 keeps 0 while a sibling
    // stack of the same product carries the real price, and the per-product index then
    // disagrees with the pipeline's own total.
    for row in rows.iter_mut() {
        let t = row.title.trim();
        if t.is_empty() {
            continue;
        }
        let mut p = title_price.get(t).copied().unwrap_or(0.0);
        if p <= 0.0 {
            p = upc_price.get(&row.upc).copied().unwrap_or(0.0);
        }
        row.msrp = p;
    }

    // -----------------------------------------------------------------------------------
    // Stage 6 — classify. Once per distinct title, joined; never once per row.
    // -----------------------------------------------------------------------------------
    for row in &rows {
        let t = row.title.trim();
        if !t.is_empty() {
            title_class.entry(t.to_string()).or_insert_with(|| classify(t));
        }
    }
    q.products = title_class.len();

    // -----------------------------------------------------------------------------------
    // Stage 7 — roll up to stacks on the four-part key
    // -----------------------------------------------------------------------------------
    let mut agg: HashMap<String, Stack> = HashMap::new();
    for row in &rows {
        let Some(location) = row.location.clone() else {
            drops.add(
                "location could not be read — excluded from lots",
                row.units,
                &row.location_raw,
            );
            continue;
        };
        let key = format!(
            "{}{}{}{}{}{}{}",
            location, KEY_SEP, row.r#box, KEY_SEP, row.upc, KEY_SEP, row.title
        );
        match agg.get_mut(&key) {
            Some(s) => {
                s.units += row.units;
                // The worst grade in the group wins — a stack is only as trustworthy as its
                // least trustworthy row.
                if row.title_risk > s.title_risk {
                    s.title_risk = row.title_risk;
                }
            }
            None => {
                let c = title_class
                    .get(row.title.trim())
                    .cloned()
                    .unwrap_or_default();
                agg.insert(
                    key,
                    Stack {
                        location,
                        r#box: row.r#box.clone(),
                        upc: row.upc.clone(),
                        title: row.title.clone(),
                        units: row.units,
                        msrp: row.msrp,
                        brand: c.brand,
                        category: c.category,
                        segment: c.segment,
                        size_us: c.size_us,
                        title_risk: row.title_risk,
                        upc_ambiguous: ambiguous_upcs.contains(&row.upc),
                    },
                );
            }
        }
    }

    let mut stacks: Vec<Stack> = agg.into_values().collect();
    // Sorted by location so the per-slot index is a contiguous range. That single choice is
    // what makes re-ranking every slot on each keystroke imperceptible.
    stacks.sort_by(|a, b| {
        a.location
            .cmp(&b.location)
            .then(a.r#box.cmp(&b.r#box))
            .then(a.upc.cmp(&b.upc))
            .then(a.title.cmp(&b.title))
    });

    // -----------------------------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------------------------
    q.stacks = stacks.len();
    q.units = stacks.iter().map(|s| s.units).sum();
    q.msrp_total = stacks.iter().map(|s| s.msrp * s.units as f64).sum();
    for s in &stacks {
        q.title_risk_units[s.title_risk.as_u8() as usize] += s.units;
        if s.msrp <= 0.0 {
            q.zero_price_stacks += 1;
            q.zero_price_units += s.units;
        }
    }
    let drops_v = drops.into_vec();
    q.rows_dropped = drops_v.iter().map(|d| d.rows).sum();
    q.units_dropped = drops_v.iter().map(|d| d.units).sum();
    q.drops = drops_v;

    if q.zero_price_units > 0 {
        q.warnings.push(format!(
            "{} units across {} stacks have no retail price after resolution. They price at $0 \
             wherever a percentage of MSRP is applied.",
            q.zero_price_units, q.zero_price_stacks
        ));
    }
    if q.locations_unparsed > 0 {
        q.warnings.push(format!(
            "{} location spellings could not be read and their stock is excluded from every lot. \
             The audit map lists them — they are usually worth fixing at source.",
            q.locations_unparsed
        ));
    }
    let gap = q.reconciliation_gap();
    if gap != 0 {
        q.warnings.push(format!(
            "Reconciliation is off by {gap} units: the input, the stacks and the reported drops \
             do not add up. Treat every total from this import as unproven."
        ));
    }

    Ok(CleanResult {
        stacks,
        repairs,
        conflicts,
        detection,
        quality: q,
    })
}

/// Column detection exposed for callers that want to show what was read before committing
/// to an import.
pub fn preview_columns(sheet: &Sheet) -> Columns {
    detect_columns(&sheet.rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(rows: Vec<Vec<&str>>) -> Sheet {
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

    fn head() -> Vec<&'static str> {
        vec!["UPC/EAN", "Location", "Box #", "Remaining", "Title", "MSRP"]
    }

    /// The assertion the spec says to write first.
    #[test]
    fn every_input_unit_is_either_a_stack_or_a_reported_drop() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-04A", "BOX3", "46", "Nike Air Max 90", "190.00"],
            vec!["197968446084", "43-127-04A", "", "2", "New Balance 9060", "150.00"],
            vec!["197968446085", "NOT A SLOT", "", "9", "Puma Suede", "80.00"],
            vec!["", "43-127-05A", "", "7", "Orphan with no barcode", "20.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.quality.units_in, 64);
        assert_eq!(r.quality.units, 48);
        assert_eq!(r.quality.units_dropped, 16);
        assert_eq!(r.quality.reconciliation_gap(), 0);
    }

    /// One SUM() row doubles the inventory if it is not caught.
    #[test]
    fn a_totals_row_is_dropped_and_named() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-04A", "", "46", "Nike Air Max 90", "190.00"],
            vec!["197968446084", "43-127-05A", "", "54", "New Balance 9060", "150.00"],
            vec!["", "", "", "100", "", ""],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.quality.units, 100);
        assert!(r
            .quality
            .drops
            .iter()
            .any(|d| d.reason.contains("totals row") && d.units == 100));
    }

    #[test]
    fn an_approval_column_drops_its_negatives() {
        let mut rows = vec![vec![
            "UPC/EAN", "Location", "Box #", "Remaining", "Title", "MSRP", "Approved",
        ]];
        for i in 0..6 {
            rows.push(vec![
                if i == 0 { "196969506820" } else if i == 1 { "196969506821" } else if i == 2 { "196969506822" } else if i == 3 { "196969506823" } else if i == 4 { "196969506824" } else { "196969506825" },
                "43-127-04A",
                "",
                "10",
                "Nike Air Max 90",
                "190.00",
                if i % 2 == 0 { "yes" } else { "no" },
            ]);
        }
        let r = clean_sheet(&sheet(rows)).unwrap();
        assert_eq!(r.quality.units, 30);
        assert!(r.quality.drops.iter().any(|d| d.reason.contains("approval column")));
        assert_eq!(r.quality.reconciliation_gap(), 0);
    }

    /// Rule two: two rows typed differently are two products, even under one barcode.
    #[test]
    fn one_barcode_two_titles_stays_two_stacks() {
        let s = sheet(vec![
            head(),
            vec![
                "197968446084",
                "43-127-04A",
                "",
                "380",
                "New Balance 9060 Big Kid Shoes, Great Plains/Twilight Haze, Size 6.5",
                "150.00",
            ],
            vec![
                "197968446084",
                "43-127-04A",
                "",
                "1",
                "New Balance 550 - Men's (Navy/Electric Sky) Size 12",
                "110.00",
            ],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.stacks.len(), 2, "the 550 must not be relabelled as a 9060");
        assert_eq!(r.quality.units, 381);
        // One stray unit against 380 is a typo, not an ambiguity.
        assert_eq!(r.quality.upcs_ambiguous, 0);
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!(r.conflicts[0].grade, "stray");
    }

    /// ...but two brands in real quantity under one barcode IS flagged.
    #[test]
    fn two_brands_in_real_quantity_are_flagged() {
        let s = sheet(vec![
            head(),
            vec!["197968446084", "43-127-04A", "", "60", "Nike Air Max 90", "190.00"],
            vec!["197968446084", "43-127-05A", "", "40", "adidas Samba OG", "100.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.quality.upcs_ambiguous, 1);
        assert_eq!(r.conflicts[0].grade, "split");
        assert!(r.stacks.iter().all(|s| s.upc_ambiguous));
    }

    #[test]
    fn one_brand_under_several_names_is_not_a_split() {
        let s = sheet(vec![
            head(),
            vec!["197968446084", "43-127-04A", "", "60", "Nike Air Max 90 Black", "190.00"],
            vec!["197968446084", "43-127-05A", "", "40", "Nike Air Max 90, Black/White", "190.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.conflicts[0].grade, "same_brand");
        assert_eq!(r.quality.upcs_ambiguous, 0);
        // One price across every name — the price-tier signature.
        assert!(r.conflicts[0].one_price);
    }

    /// A blank description is named from the barcode, and the row says so.
    #[test]
    fn titles_are_backfilled_and_graded() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-04A", "", "10", "Nike Air Max 90", "190.00"],
            vec!["196969506827", "43-127-05A", "", "5", "", "190.00"],
            vec!["196969506999", "43-127-06A", "", "3", "", "50.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        let filled = r.stacks.iter().find(|s| s.location == "43-127-05A").unwrap();
        assert_eq!(filled.title, "Nike Air Max 90");
        assert_eq!(filled.title_risk, TitleRisk::NamedFromBarcode);
        let unknown = r.stacks.iter().find(|s| s.location == "43-127-06A").unwrap();
        assert_eq!(unknown.title_risk, TitleRisk::Unknown);
        assert_eq!(unknown.title_risk.manifest_note(), "NO DESCRIPTION in the source sheet");
    }

    /// A barcode carrying several products can only GUESS at a blank row's description.
    #[test]
    fn a_blank_row_on_a_multi_name_barcode_is_graded_verify() {
        let s = sheet(vec![
            head(),
            vec!["197968446084", "43-127-04A", "", "60", "Nike Air Max 90", "190.00"],
            vec!["197968446084", "43-127-05A", "", "40", "adidas Samba OG", "100.00"],
            vec!["197968446084", "43-127-06A", "", "5", "", "190.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        let guessed = r.stacks.iter().find(|s| s.location == "43-127-06A").unwrap();
        assert_eq!(guessed.title_risk, TitleRisk::GuessedFromBarcode);
        assert!(guessed.title_risk.manifest_note().starts_with("VERIFY"));
    }

    /// The trap that fabricated $45,335: undescribed rows must not become one pseudo-product.
    #[test]
    fn empty_titles_are_excluded_from_price_grouping() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-04A", "", "10", "Nike Air Max 90", "190.00"],
            // Two undescribed rows on barcodes nothing else names. If empty titles were a
            // group key they would both be stamped with the modal price of that group.
            vec!["900000000001", "43-127-05A", "", "5", "", "0"],
            vec!["900000000002", "43-127-06A", "", "5", "", "0"],
        ]);
        let r = clean_sheet(&s).unwrap();
        let priced: f64 = r
            .stacks
            .iter()
            .filter(|s| s.title.is_empty())
            .map(|s| s.msrp)
            .sum();
        assert_eq!(priced, 0.0, "an undescribed row must not inherit a price");
        assert_eq!(r.quality.msrp_total, 1900.0);
    }

    /// The levelling pass: one product, one price across every stack.
    #[test]
    fn price_is_levelled_across_every_stack_of_a_product() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-04A", "", "10", "Nike Air Max 90", "190.00"],
            vec!["196969506827", "43-127-05A", "", "10", "Nike Air Max 90", "190.00"],
            vec!["196969506827", "43-127-06A", "", "10", "Nike Air Max 90", "0"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert!(r.stacks.iter().all(|s| s.msrp == 190.0));
        assert_eq!(r.quality.msrp_total, 5700.0);
        assert_eq!(r.quality.zero_price_stacks, 0);
    }

    /// Spellings collapse; the audit map records what happened.
    #[test]
    fn location_spellings_collapse_into_one_slot() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-01B", "", "10", "Nike Air Max 90", "190.00"],
            vec!["196969506827", "43 127 01b", "", "10", "Nike Air Max 90", "190.00"],
            vec!["196969506827", "4312701B", "", "10", "Nike Air Max 90", "190.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.stacks.len(), 1);
        assert_eq!(r.stacks[0].units, 30);
        assert_eq!(r.quality.location_spellings, 3);
        assert_eq!(r.quality.locations, 1);
        assert_eq!(r.quality.locations_repaired, 2);
        assert!(r.repairs.iter().all(|m| m.canonical.as_deref() == Some("43-127-01B")));
    }

    /// An unreadable location is excluded rather than guessed, and its stock is reported.
    #[test]
    fn an_unparsed_location_is_excluded_and_reported() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "OVERSTOCK BIN", "", "12", "Nike Air Max 90", "190.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert!(r.stacks.is_empty());
        assert_eq!(r.quality.units_dropped, 12);
        assert!(r.quality.drops.iter().any(|d| d.reason.contains("location could not be read")));
        assert_eq!(r.quality.reconciliation_gap(), 0);
    }

    /// Stacks come out in walk order, so the per-slot index is a contiguous range.
    #[test]
    fn stacks_are_sorted_by_location() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "44-001-01", "", "1", "A", "10"],
            vec!["196969506828", "43-127-04A", "", "1", "B", "10"],
            vec!["196969506829", "43-127-01B", "", "1", "C", "10"],
        ]);
        let r = clean_sheet(&s).unwrap();
        let locs: Vec<&str> = r.stacks.iter().map(|s| s.location.as_str()).collect();
        assert_eq!(locs, vec!["43-127-01B", "43-127-04A", "44-001-01"]);
    }

    /// The four-part key must not collide. `box` and `upc` boundaries are real.
    #[test]
    fn the_composite_key_does_not_collide() {
        let s = sheet(vec![
            head(),
            vec!["1", "43-127-04A", "AB", "5", "T", "10"],
            vec!["12", "43-127-04A", "A", "7", "T", "10"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.stacks.len(), 2, "\"AB\"+\"1\" and \"A\"+\"12\" are different stacks");
        assert_eq!(r.quality.units, 12);
    }

    /// The worst grade in a group wins.
    #[test]
    fn rollup_takes_the_worst_title_risk_in_the_group() {
        let s = sheet(vec![
            head(),
            vec!["196969506827", "43-127-04A", "", "10", "Nike Air Max 90", "190.00"],
            vec!["196969506827", "43-127-04A", "", "5", "", "190.00"],
        ]);
        let r = clean_sheet(&s).unwrap();
        assert_eq!(r.stacks.len(), 1);
        assert_eq!(r.stacks[0].units, 15);
        assert_eq!(r.stacks[0].title_risk, TitleRisk::NamedFromBarcode);
    }

    #[test]
    fn classification_rides_along_on_the_stack() {
        let s = sheet(vec![
            head(),
            vec![
                "196969506827",
                "43-127-04A",
                "",
                "46",
                "Nike Air Max 90 Big Kid Shoes, Black, Size 6.5",
                "190.00",
            ],
        ]);
        let r = clean_sheet(&s).unwrap();
        let st = &r.stacks[0];
        assert_eq!(st.brand.as_deref(), Some("Nike"));
        assert_eq!(st.category.as_deref(), Some("Footwear"));
        assert_eq!(st.segment.as_deref(), Some("Kids"));
        assert_eq!(st.size_us, Some(6.5));
    }
}
