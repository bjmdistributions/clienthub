//! The artifacts every import emits: a plain-text quality report, the raw→canonical
//! location audit map, and the barcode conflicts list.
//!
//! **Report quality, don't silently fix it.** The 38 genuinely split barcodes in the
//! reference export cannot be resolved by software — but they can be handed back to the
//! warehouse as a list, which is the only thing that actually fixes them. The audit map is
//! how an unexpected merge is traced, and how the warehouse finds spellings worth fixing at
//! source.

use super::export::{to_csv, Doc, Section};
use super::model::CleanResult;

fn n(v: i64) -> String {
    let s = v.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if v < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn money(v: f64) -> String {
    format!("${}", n(v.round() as i64))
}

/// The report a person reads after an import, before trusting a single total from it.
pub fn quality_report_text(r: &CleanResult, sheet_name: &str) -> String {
    let q = &r.quality;
    let mut o = String::new();

    o.push_str(&format!("{sheet_name}\n"));
    o.push_str(&"=".repeat(sheet_name.len().max(8)));
    o.push_str("\n\n");

    o.push_str(&format!(
        "Read as {}{}, header on row {}.\n",
        r.detection.format,
        r.detection
            .sheet
            .as_ref()
            .map(|s| format!(" (tab {s})"))
            .unwrap_or_default(),
        r.detection.header_row
    ));
    for (label, col) in [
        ("barcode", &r.detection.upc_col),
        ("location", &r.detection.location_col),
        ("box", &r.detection.box_col),
        ("quantity", &r.detection.units_col),
        ("description", &r.detection.title_col),
        ("retail", &r.detection.msrp_col),
    ] {
        match col {
            Some(c) => o.push_str(&format!("  {label:<12} read from \"{c}\"\n")),
            None => o.push_str(&format!("  {label:<12} not present\n")),
        }
    }
    if !r.detection.flag_cols.is_empty() {
        o.push_str(&format!(
            "  approval     \"{}\" — rows marked no were dropped\n",
            r.detection.flag_cols.join("\", \"")
        ));
    }
    if let Some(note) = &r.detection.note {
        o.push_str(&format!("  note         {note}\n"));
    }

    o.push_str("\nWhat came out\n-------------\n");
    o.push_str(&format!("  {:>12} rows in\n", n(q.rows_in as i64)));
    o.push_str(&format!("  {:>12} units in\n", n(q.units_in)));
    o.push_str(&format!("  {:>12} stacks\n", n(q.stacks as i64)));
    o.push_str(&format!("  {:>12} distinct products\n", n(q.products as i64)));
    o.push_str(&format!("  {:>12} locations\n", n(q.locations as i64)));
    o.push_str(&format!("  {:>12} units\n", n(q.units)));
    o.push_str(&format!("  {:>12} retail\n", money(q.msrp_total)));

    o.push_str("\nWhat was dropped, and why\n-------------------------\n");
    if q.drops.is_empty() {
        o.push_str("  Nothing.\n");
    } else {
        for d in &q.drops {
            o.push_str(&format!(
                "  {:>8} rows  {:>10} units  {}\n",
                n(d.rows as i64),
                n(d.units),
                d.reason
            ));
            for e in &d.examples {
                let e = if e.chars().count() > 60 {
                    format!("{}...", e.chars().take(57).collect::<String>())
                } else {
                    e.clone()
                };
                o.push_str(&format!("                                    e.g. {e}\n"));
            }
        }
    }
    let gap = q.reconciliation_gap();
    o.push_str(&format!(
        "\n  {} in, {} in stacks, {} dropped. {}\n",
        n(q.units_in),
        n(q.units),
        n(q.units_dropped),
        if gap == 0 {
            "Reconciles.".to_string()
        } else {
            format!("OFF BY {}. Treat every total here as unproven.", n(gap))
        }
    ));

    o.push_str("\nLocations\n---------\n");
    o.push_str(&format!(
        "  {} spellings resolved to {} slots ({} repaired, {} unreadable).\n",
        n(q.location_spellings as i64),
        n(q.locations as i64),
        n(q.locations_repaired as i64),
        n(q.locations_unparsed as i64)
    ));
    if q.locations_unparsed > 0 {
        o.push_str("  The unreadable ones are in the audit map. Their stock is in no lot.\n");
    }

    o.push_str("\nDescriptions\n------------\n");
    o.push_str(&format!(
        "  {:>10} units  typed into the source sheet\n",
        n(q.title_risk_units[0])
    ));
    o.push_str(&format!(
        "  {:>10} units  named from a barcode nothing else disputes\n",
        n(q.title_risk_units[1])
    ));
    o.push_str(&format!(
        "  {:>10} units  VERIFY — guessed from a barcode used for several products\n",
        n(q.title_risk_units[2])
    ));
    o.push_str(&format!(
        "  {:>10} units  NO DESCRIPTION in the source sheet\n",
        n(q.title_risk_units[3])
    ));
    let risky = q.title_risk_units[2] + q.title_risk_units[3];
    if q.units > 0 {
        o.push_str(&format!(
            "  Only the last two can mis-describe a lot — {} units, {:.1}% of stock.\n",
            n(risky),
            risky as f64 / q.units as f64 * 100.0
        ));
    }

    o.push_str("\nBarcodes\n--------\n");
    o.push_str(&format!("  {:>10} distinct barcodes\n", n(q.upcs as i64)));
    o.push_str(&format!(
        "  {:>10} carry more than one product name\n",
        n(q.upcs_multi_name as i64)
    ));
    o.push_str(&format!(
        "  {:>10} carry two brands in real quantity ({} units) — hand these back to the floor\n",
        n(q.upcs_ambiguous as i64),
        n(q.units_ambiguous)
    ));

    if !q.warnings.is_empty() {
        o.push_str("\nWorth knowing\n-------------\n");
        for w in &q.warnings {
            o.push_str(&format!("  - {w}\n"));
        }
    }

    o
}

/// Every raw spelling and what it became. The audit trail for a merge nobody expected.
pub fn audit_map_csv(r: &CleanResult) -> String {
    to_csv(&Doc {
        name: "location audit map".into(),
        sections: vec![Section {
            title: String::new(),
            headers: vec![
                "Raw".into(),
                "Canonical".into(),
                "Rule".into(),
                "Rows".into(),
                "Units".into(),
            ],
            rows: r
                .repairs
                .iter()
                .map(|m| {
                    vec![
                        m.raw.clone(),
                        m.canonical.clone().unwrap_or_default(),
                        m.rule.clone(),
                        m.rows.to_string(),
                        m.units.to_string(),
                    ]
                })
                .collect(),
        }],
    })
}

/// Every barcode carrying more than one product name, one row per name.
pub fn conflicts_csv(r: &CleanResult) -> String {
    let mut rows = Vec::new();
    for c in &r.conflicts {
        for nm in &c.names {
            rows.push(vec![
                c.upc.clone(),
                c.grade.clone(),
                c.units.to_string(),
                if c.one_price { "one price across every name".into() } else { String::new() },
                nm.title.clone(),
                nm.brand.clone().unwrap_or_default(),
                nm.units.to_string(),
                format!("{:.1}%", nm.share * 100.0),
                nm.locations.to_string(),
                format!("{:.2}", nm.msrp),
            ]);
        }
    }
    to_csv(&Doc {
        name: "barcode conflicts".into(),
        sections: vec![Section {
            title: String::new(),
            headers: vec![
                "UPC".into(),
                "Grade".into(),
                "Barcode units".into(),
                "Note".into(),
                "Product name".into(),
                "Brand".into(),
                "Units".into(),
                "Share".into(),
                "Slots".into(),
                "MSRP".into(),
            ],
            rows,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lot_engine::pipeline::clean_sheet;
    use crate::lot_engine::read::Sheet;

    fn s() -> Sheet {
        Sheet {
            rows: vec![
                vec!["UPC/EAN", "Location", "Box #", "Remaining", "Title", "MSRP"],
                vec!["196969506827", "43-127-04A", "", "46", "Nike Air Max 90", "190.00"],
                vec!["196969506828", "OVERSTOCK", "", "5", "Vans Old Skool", "65.00"],
            ]
            .into_iter()
            .map(|r| r.into_iter().map(|c| c.to_string()).collect())
            .collect(),
            format: "csv".into(),
            sheet_name: None,
            note: None,
        }
    }

    #[test]
    fn the_report_names_every_drop_and_says_whether_it_reconciles() {
        let r = clean_sheet(&s()).unwrap();
        let txt = quality_report_text(&r, "Master list");
        assert!(txt.contains("Master list"));
        assert!(txt.contains("read from \"Location\""));
        assert!(txt.contains("location could not be read"));
        assert!(txt.contains("Reconciles."));
    }

    #[test]
    fn the_audit_map_records_what_each_spelling_became() {
        let r = clean_sheet(&s()).unwrap();
        let csv = audit_map_csv(&r);
        assert!(csv.contains("43-127-04A"));
        // An unreadable spelling is listed with an empty canonical, not omitted.
        assert!(csv.contains("OVERSTOCK,,no match"));
    }

    #[test]
    fn a_clean_sheet_has_no_conflicts_to_report() {
        let r = clean_sheet(&s()).unwrap();
        let csv = conflicts_csv(&r);
        assert!(csv.contains("Product name"));
        assert_eq!(csv.lines().count(), 1);
    }
}
