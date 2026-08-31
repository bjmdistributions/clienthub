//! Reading a warehouse sheet into rows, and working out which column is which.
//!
//! Self-contained on purpose. The desktop app has a manifest reader already
//! (`crate::manifest`), but this module has to compile in the server binary too, and two
//! readers that are *nearly* the same are exactly the failure the spec warns about. One
//! reader, in one file, used by both.
//!
//! Six columns matter and everything else is ignored. Column order does not matter, and the
//! header row may sit below junk rows.

use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use super::model::SheetDetection;

/// How far down to look for a header row. Real exports carry a title block, a logo row and
/// a blank line before the columns start.
const HEADER_SCAN_ROWS: usize = 30;

/// How many rows to sample when typing a column.
const TYPE_SAMPLE_ROWS: usize = 500;

/// A hard ceiling, reported honestly rather than enforced silently. The reference export is
/// 144,635 rows; anything an order of magnitude past that is a runaway or a wrong file.
pub const MAX_ROWS: usize = 2_000_000;

/// The sheet as read: raw string cells, nothing interpreted yet.
pub struct Sheet {
    pub rows: Vec<Vec<String>>,
    pub format: String,
    pub sheet_name: Option<String>,
    pub note: Option<String>,
}

/// Which column index holds what. `None` means the sheet does not have that column.
#[derive(Debug, Clone, Default)]
pub struct Columns {
    pub upc: Option<usize>,
    pub location: Option<usize>,
    pub r#box: Option<usize>,
    pub units: Option<usize>,
    pub title: Option<usize>,
    pub msrp: Option<usize>,
    /// Columns whose values are all yes/no. Their negatives drop the row.
    pub flags: Vec<usize>,
    /// 0-based index of the header row, or `None` when the file had no header.
    pub header_row: Option<usize>,
}

/// The answer "this sheet does not have that column", as opposed to "no opinion".
///
/// The two are genuinely different. A role missing from a `ColumnMap` keeps whatever
/// detection guessed; a role set to this says the sheet has no such column, which is how a
/// product catalogue tells the engine it holds no locations.
pub const NOT_PRESENT: i32 = -1;

/// Which column a person says each role is, overriding the guess.
///
/// `detect_columns` reads header text and is right most of the time. When it is wrong it
/// does not error - it produces a clean import of the wrong thing, and that is only caught
/// when a total looks wrong downstream. A 1,183-row Carhartt offer cleaned to zero stacks
/// because its quantity column was headed `order`. Adding aliases fixes one sheet at a
/// time; this fixes the next one without a release.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnMap {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upc: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#box: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub units: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msrp: Option<i32>,
}

/// One role's override, checked against the sheet. `Ok(None)` means "no opinion".
fn resolve(role: &str, v: Option<i32>, width: usize) -> Result<Option<Option<usize>>> {
    let Some(i) = v else { return Ok(None) };
    if i == NOT_PRESENT {
        return Ok(Some(None));
    }
    // Out of range is refused rather than ignored: `Vec::get` past the end yields nothing,
    // so a mapping pointing at a column this sheet does not have would read every row as
    // empty and clean the whole file away without ever saying why.
    if i < 0 || i as usize >= width {
        return Err(anyhow!(
            "the {role} column was set to column {}, and this sheet only has {width}",
            i + 1
        ));
    }
    Ok(Some(Some(i as usize)))
}

impl ColumnMap {
    pub fn is_empty(&self) -> bool {
        self.upc.is_none()
            && self.location.is_none()
            && self.r#box.is_none()
            && self.units.is_none()
            && self.title.is_none()
            && self.msrp.is_none()
    }

    /// What the engine is reading right now, in the shape the screen posts back. Every role
    /// is filled in - a role with no column is `NOT_PRESENT`, not absent, because the screen
    /// has to show "not present" as an answer rather than as a blank.
    pub fn from_columns(c: &Columns) -> ColumnMap {
        let f = |v: Option<usize>| Some(v.map(|i| i as i32).unwrap_or(NOT_PRESENT));
        ColumnMap {
            upc: f(c.upc),
            location: f(c.location),
            r#box: f(c.r#box),
            units: f(c.units),
            title: f(c.title),
            msrp: f(c.msrp),
        }
    }

    /// Lay this map over a detected `Columns`. `width` is the widest row in the sheet.
    pub fn apply(&self, cols: &mut Columns, width: usize) -> Result<()> {
        let upc = resolve("barcode", self.upc, width)?;
        let location = resolve("location", self.location, width)?;
        let boxc = resolve("box", self.r#box, width)?;
        let units = resolve("quantity", self.units, width)?;
        let title = resolve("description", self.title, width)?;
        let msrp = resolve("retail", self.msrp, width)?;

        let mut claimed: Vec<usize> = Vec::new();
        for o in [&upc, &location, &boxc, &units, &title, &msrp] {
            if let Some(Some(i)) = o {
                claimed.push(*i);
            }
        }

        // A column claimed by hand is claimed. Any role that was only GUESSED onto the same
        // column gives it up - otherwise one column is read as two roles at once and both
        // carry the same cell, which is the silent wrongness this whole override exists to
        // end. Two HAND-picked roles on one column are left alone: that is a deliberate
        // answer, and "the description is also the location" is what a catalogue means.
        let settle = |slot: &mut Option<usize>, over: &Option<Option<usize>>| match over {
            Some(v) => *slot = *v,
            None => {
                if slot.is_some_and(|i| claimed.contains(&i)) {
                    *slot = None;
                }
            }
        };
        settle(&mut cols.upc, &upc);
        settle(&mut cols.location, &location);
        settle(&mut cols.r#box, &boxc);
        settle(&mut cols.units, &units);
        settle(&mut cols.title, &title);
        settle(&mut cols.msrp, &msrp);
        // A column somebody named as a role is not an approval flag as well. Left in, its
        // "no" values would drop every row the person just pointed the engine at.
        cols.flags.retain(|i| !claimed.contains(i));
        Ok(())
    }
}

/// How many body rows the mapping screen shows. Enough to recognise a column by what is in
/// it, few enough that the payload is not the sheet.
pub const PREVIEW_ROWS: usize = 5;

/// The top of a sheet exactly as it was read, for the screen that corrects the mapping.
///
/// Raw cells, nothing normalised: a person matching a column to a role has to see what is
/// actually in it, not what the engine made of it.
#[derive(Debug, Clone, Serialize)]
pub struct SheetPreview {
    pub format: String,
    pub sheet: Option<String>,
    /// 1-based row the header was found on, 0 when the file had none.
    pub header_row: usize,
    /// One entry per column, in order: its header text, or `Column D` when it has none.
    pub headers: Vec<String>,
    /// The first `PREVIEW_ROWS` rows under the header.
    pub rows: Vec<Vec<String>>,
    /// Which column each role reads right now, after any override.
    pub columns: ColumnMap,
}

/// Excel's own name for a column, so a role pointed at a column with no header still has
/// something to print. A blank header described as "not found", which is the exact
/// confusion a mapping screen exists to remove.
pub fn column_label(i: usize) -> String {
    let mut n = i + 1;
    let mut out = String::new();
    while n > 0 {
        let r = (n - 1) % 26;
        out.insert(0, (b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    out
}

/// Build the mapping screen's payload from a sheet and the columns in force for it.
pub fn preview(sheet: &Sheet, cols: &Columns) -> SheetPreview {
    let width = sheet.rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let header = cols.header_row.and_then(|i| sheet.rows.get(i));
    let headers = (0..width)
        .map(|i| {
            header
                .and_then(|h| h.get(i))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Column {}", column_label(i)))
        })
        .collect();
    let body_start = cols.header_row.map(|i| i + 1).unwrap_or(0);
    let rows = sheet
        .rows
        .iter()
        .skip(body_start)
        .take(PREVIEW_ROWS)
        .map(|r| (0..width).map(|i| r.get(i).cloned().unwrap_or_default()).collect())
        .collect();
    SheetPreview {
        format: sheet.format.clone(),
        sheet: sheet.sheet_name.clone(),
        header_row: cols.header_row.map(|i| i + 1).unwrap_or(0),
        headers,
        rows,
        columns: ColumnMap::from_columns(cols),
    }
}

// ---------------------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------------------

/// Money and counts arrive with `$`, commas, non-breaking spaces and the occasional
/// parenthesised negative. Strict enough that a style code like `B08N5` does not parse.
pub fn parse_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let negative = t.starts_with('(') && t.ends_with(')');
    let mut cleaned = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            '0'..='9' | '.' => cleaned.push(c),
            '-' if cleaned.is_empty() => cleaned.push(c),
            ',' | '$' | '\u{a0}' | ' ' | '(' | ')' | '\u{2019}' | '\'' => {}
            _ => return None,
        }
    }
    if cleaned.is_empty() || cleaned == "-" || cleaned == "." {
        return None;
    }
    let v: f64 = cleaned.parse().ok()?;
    Some(if negative { -v.abs() } else { v })
}

/// A barcode is text. Parsing it as a number loses leading zeros and rounds 13-digit codes,
/// and Excel likes to hand them over in scientific notation with a leading apostrophe.
pub fn clean_upc(s: &str) -> String {
    let t = s.trim().trim_start_matches('\'').trim();
    if t.is_empty() {
        return String::new();
    }
    // Excel scientific notation: 1.96969E+11 — recover the digits when we can.
    if t.contains(['E', 'e']) && t.contains('+') {
        if let Some(v) = parse_sci(t) {
            return v;
        }
    }
    t.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

fn parse_sci(t: &str) -> Option<String> {
    let up = t.to_ascii_uppercase();
    let (mant, exp) = up.split_once('E')?;
    let exp: i32 = exp.trim_start_matches('+').parse().ok()?;
    let mant: f64 = mant.parse().ok()?;
    let v = mant * 10f64.powi(exp);
    if !v.is_finite() || v < 0.0 || v >= 1e18 {
        return None;
    }
    Some(format!("{}", v.round() as u64))
}

fn norm_header(s: &str) -> String {
    s.trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------------------
// Column candidates
// ---------------------------------------------------------------------------------------

const UPC_NAMES: &[&str] = &["upc", "ean", "upcean", "upc ean", "barcode", "bar code", "gtin", "upc code"];
const LOCATION_NAMES: &[&str] = &[
    "location", "loc", "bin", "bin location", "slot", "warehouse location", "pick location",
    "bin no", "location code", "position",
];
const BOX_NAMES: &[&str] = &["box", "box no", "box number", "carton", "carton no", "case", "case no", "pallet id"];
/// Order matters: the exact pass runs over ALL of these before the substring pass, so a
/// header that IS one of these wins over a header that merely contains an earlier one.
///
/// `order` is here because offer sheets head their quantity column with it, and it is late
/// in the list because as a substring it also matches "Order Date" and "Backorder". The
/// substring pass alone cannot tell those apart, which is why `find_units_col` re-reads the
/// column it picked and checks the data actually counts.
const UNITS_NAMES: &[&str] = &[
    "remaining", "qty", "quantity", "units", "unit", "on hand", "onhand", "count", "available",
    "qty remaining", "qty on hand", "total qty", "pcs", "pieces", "eaches", "each",
    "order", "order qty", "qty ordered", "ordered", "cases", "stock", "in stock", "inventory",
];
const TITLE_NAMES: &[&str] = &[
    "title", "description", "item description", "product description", "product", "product name",
    "name", "item", "item name", "desc", "style description",
];
const MSRP_NAMES: &[&str] = &[
    "msrp", "retail", "unit retail", "retail price", "list price", "srp", "price", "unit price",
    "retail value", "msrp unit",
];

/// Exact header text beats a substring, and a column already claimed cannot be claimed
/// again — without that rule "Unit Price" gets read as a quantity.
fn find_col(headers: &[String], candidates: &[&str], claimed: &[Option<usize>]) -> Option<usize> {
    let taken = |i: usize| claimed.iter().any(|c| *c == Some(i));
    for cand in candidates {
        for (i, h) in headers.iter().enumerate() {
            if !taken(i) && h == cand {
                return Some(i);
            }
        }
    }
    for cand in candidates {
        for (i, h) in headers.iter().enumerate() {
            if !taken(i) && h.contains(cand) {
                return Some(i);
            }
        }
    }
    None
}

/// Pick the quantity column, then **prove it counts** against the rows underneath it.
///
/// `find_col` matches on the header alone, and a quantity alias is the one group where that
/// is not enough: `order` has to be in the list because offer sheets use it, and as a
/// substring it equally matches "Order Date" and "Backorder Ref". A date column chosen as the
/// quantity makes every row read as zero units and the whole sheet is dropped for having no
/// quantity — which is exactly how a 1,183-row Carhartt offer cleaned to nothing.
///
/// So: take the best header match, read up to 200 body cells, and keep it only if most of
/// the non-empty ones parse as a non-negative number. Otherwise mark it claimed and try the
/// next candidate. A column of dates, colours or style codes fails on the first test.
fn find_units_col(headers: &[String], body: &[Vec<String>], claimed: &[Option<usize>]) -> Option<usize> {
    let mut rejected: Vec<Option<usize>> = claimed.to_vec();
    for _ in 0..4 {
        let pick = find_col(headers, UNITS_NAMES, &rejected)?;
        let mut seen = 0usize;
        let mut numeric = 0usize;
        for r in body.iter().take(200) {
            let Some(cell) = r.get(pick) else { continue };
            let t = cell.trim();
            if t.is_empty() {
                continue;
            }
            seen += 1;
            if parse_number(t).is_some_and(|v| v.is_finite() && v >= 0.0) {
                numeric += 1;
            }
        }
        // No data to judge by: keep the header match rather than invent a reason to refuse.
        if seen == 0 || numeric * 4 >= seen * 3 {
            return Some(pick);
        }
        rejected.push(Some(pick));
    }
    None
}

fn header_score(cells: &[String]) -> usize {
    let hs: Vec<String> = cells.iter().map(|c| norm_header(c)).collect();
    let groups: [&[&str]; 6] = [UPC_NAMES, LOCATION_NAMES, BOX_NAMES, UNITS_NAMES, TITLE_NAMES, MSRP_NAMES];
    groups
        .iter()
        .filter(|g| {
            g.iter()
                .any(|cand| hs.iter().any(|h| h == cand || (!h.is_empty() && h.contains(cand))))
        })
        .count()
}

/// A column of yes/no answers. Order sheets often carry one, and its negatives are rows the
/// warehouse has already declined.
const FLAG_VALUES: &[&str] = &["yes", "no", "y", "n", "true", "false", "x", ""];

fn is_flag_column(rows: &[Vec<String>], idx: usize) -> bool {
    let mut non_empty = 0usize;
    for r in rows.iter().take(TYPE_SAMPLE_ROWS) {
        let v = r.get(idx).map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
        if v.is_empty() {
            continue;
        }
        non_empty += 1;
        if !FLAG_VALUES.contains(&v.as_str()) {
            return false;
        }
    }
    // A column of nothing is not a flag column.
    non_empty >= 3
}

/// True when a column looks like barcodes: long digit runs, consistently.
fn is_upc_column(rows: &[Vec<String>], idx: usize) -> bool {
    let mut seen = 0usize;
    let mut barcode_like = 0usize;
    for r in rows.iter().take(TYPE_SAMPLE_ROWS) {
        let v = r.get(idx).map(|s| clean_upc(s)).unwrap_or_default();
        if v.is_empty() {
            continue;
        }
        seen += 1;
        if v.len() >= 11 && v.len() <= 14 && v.chars().all(|c| c.is_ascii_digit()) {
            barcode_like += 1;
        }
    }
    seen >= 5 && barcode_like * 10 >= seen * 8
}

/// Resolve the six columns. `rows` is the whole sheet including any junk above the header.
pub fn detect_columns(rows: &[Vec<String>]) -> Columns {
    let mut best: Option<(usize, usize)> = None;
    for (i, r) in rows.iter().take(HEADER_SCAN_ROWS).enumerate() {
        let s = header_score(r);
        if s >= 3 && best.map(|(_, bs)| s > bs).unwrap_or(true) {
            best = Some((i, s));
        }
    }

    let mut cols = Columns::default();
    let body_start = match best {
        Some((i, _)) => {
            cols.header_row = Some(i);
            i + 1
        }
        None => 0,
    };
    let body = &rows[body_start.min(rows.len())..];

    if let Some((i, _)) = best {
        let headers: Vec<String> = rows[i].iter().map(|c| norm_header(c)).collect();
        // Order matters: the most specific names are claimed first, so a sheet carrying both
        // "Retail" and "Price" does not lose the retail column to a generic match.
        cols.upc = find_col(&headers, UPC_NAMES, &[]);
        cols.location = find_col(&headers, LOCATION_NAMES, &[cols.upc]);
        cols.r#box = find_col(&headers, BOX_NAMES, &[cols.upc, cols.location]);
        cols.title = find_col(&headers, TITLE_NAMES, &[cols.upc, cols.location, cols.r#box]);
        cols.units = find_units_col(&headers, body, &[cols.upc, cols.location, cols.r#box, cols.title]);
        cols.msrp = find_col(
            &headers,
            MSRP_NAMES,
            &[cols.upc, cols.location, cols.r#box, cols.title, cols.units],
        );

        let claimed = [cols.upc, cols.location, cols.r#box, cols.title, cols.units, cols.msrp];
        for (idx, _) in headers.iter().enumerate() {
            if claimed.iter().any(|c| *c == Some(idx)) {
                continue;
            }
            if is_flag_column(body, idx) {
                cols.flags.push(idx);
            }
        }
    }

    // The UPC column is the one place where shape beats naming: a sheet may call it
    // "Item #", but a column of 12-digit numbers is a column of barcodes.
    if cols.upc.is_none() {
        let width = body.iter().take(TYPE_SAMPLE_ROWS).map(|r| r.len()).max().unwrap_or(0);
        let claimed = [cols.location, cols.r#box, cols.title, cols.units, cols.msrp];
        for idx in 0..width {
            if claimed.iter().any(|c| *c == Some(idx)) {
                continue;
            }
            if is_upc_column(body, idx) {
                cols.upc = Some(idx);
                break;
            }
        }
    }

    cols
}

/// Fill in `SheetDetection` with the ORIGINAL-CASE header text of every column used, so a
/// mis-detected column is visible rather than wrong in silence.
pub fn describe(sheet: &Sheet, cols: &Columns) -> SheetDetection {
    let header = cols.header_row.and_then(|i| sheet.rows.get(i));
    // A column with no header text still gets a name. It used to describe as "not found",
    // which reads as "this role is missing" - wrong for a shape-detected barcode column,
    // and wrong for any column somebody mapped a role onto by hand.
    let name = |c: Option<usize>| -> Option<String> {
        let i = c?;
        Some(
            header
                .and_then(|h| h.get(i))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Column {}", column_label(i))),
        )
    };
    SheetDetection {
        format: sheet.format.clone(),
        sheet: sheet.sheet_name.clone(),
        header_row: cols.header_row.map(|i| i + 1).unwrap_or(0),
        upc_col: name(cols.upc),
        location_col: name(cols.location),
        box_col: name(cols.r#box),
        units_col: name(cols.units),
        title_col: name(cols.title),
        msrp_col: name(cols.msrp),
        flag_cols: cols.flags.iter().filter_map(|i| name(Some(*i))).collect(),
        note: sheet.note.clone(),
    }
}

// ---------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------

fn extension(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

fn cell_text(d: &calamine::Data) -> String {
    use calamine::Data;
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(_) => String::new(),
    }
}

fn read_excel(path: &str) -> Result<Sheet> {
    use calamine::Reader;
    let mut wb = calamine::open_workbook_auto(path).context("could not open the workbook")?;
    let names: Vec<String> = wb.sheet_names().to_vec();
    if names.is_empty() {
        return Err(anyhow!("the workbook has no sheets"));
    }

    // Real files carry notes and cover tabs. Pick the tab with the most data rows, scoring
    // without materialising every sheet twice.
    let mut best: Option<(String, Vec<Vec<String>>, usize)> = None;
    for n in &names {
        let range = match wb.worksheet_range(n) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|r| r.iter().map(cell_text).collect::<Vec<String>>())
            .collect();
        let score = rows.iter().filter(|r| r.iter().filter(|c| !c.is_empty()).count() >= 2).count();
        if best.as_ref().map(|(_, _, bs)| score > *bs).unwrap_or(true) {
            best = Some((n.clone(), rows, score));
        }
    }

    let (sheet_name, rows, _) = best.ok_or_else(|| anyhow!("no readable sheet in the workbook"))?;
    let note = if names.len() > 1 {
        Some(format!(
            "{} tabs in the workbook; read the one with the most rows ({sheet_name}).",
            names.len()
        ))
    } else {
        None
    };
    Ok(Sheet {
        rows,
        format: extension(path),
        sheet_name: Some(sheet_name),
        note,
    })
}

/// A tab-delimited sheet read as CSV collapses into one column, so the delimiter is sniffed
/// rather than assumed.
fn sniff_delimiter(text: &str) -> u8 {
    let sample: String = text.lines().take(20).collect::<Vec<_>>().join("\n");
    let counts = [
        (b'\t', sample.matches('\t').count()),
        (b';', sample.matches(';').count()),
        (b'|', sample.matches('|').count()),
        (b',', sample.matches(',').count()),
    ];
    counts.iter().max_by_key(|(_, n)| *n).map(|(d, _)| *d).unwrap_or(b',')
}

fn read_delimited(path: &str) -> Result<Sheet> {
    let bytes = std::fs::read(path).context("could not read the file")?;
    let text = String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string();
    let delim = sniff_delimiter(&text);
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for rec in rdr.records() {
        let rec = rec.context("malformed row")?;
        rows.push(rec.iter().map(|c| c.trim().to_string()).collect());
        if rows.len() > MAX_ROWS {
            return Err(anyhow!(
                "the file has more than {MAX_ROWS} rows — that is not a warehouse manifest"
            ));
        }
    }
    Ok(Sheet {
        rows,
        format: if delim == b'\t' { "tsv".into() } else { extension(path) },
        sheet_name: None,
        note: None,
    })
}

/// Read a warehouse sheet from disk.
pub fn read_sheet(path: &str) -> Result<Sheet> {
    let ext = extension(path);
    let sheet = match ext.as_str() {
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => read_excel(path)?,
        "csv" | "tsv" | "txt" => read_delimited(path)?,
        other => {
            return Err(anyhow!(
                "{other} is not a sheet the lot engine can read — send it as .xlsx or .csv"
            ))
        }
    };
    if sheet.rows.is_empty() {
        return Err(anyhow!("the sheet is empty"));
    }
    if sheet.rows.len() > MAX_ROWS {
        return Err(anyhow!(
            "the sheet has {} rows, past the {MAX_ROWS} ceiling",
            sheet.rows.len()
        ));
    }
    Ok(sheet)
}

/// Read from bytes already in memory — the path the phone takes, where the upload never
/// touches a well-known directory.
pub fn read_bytes(filename: &str, bytes: &[u8]) -> Result<Sheet> {
    let dir = std::env::temp_dir().join("ecliptr-lot-engine");
    std::fs::create_dir_all(&dir).context("could not create a scratch directory")?;
    let safe: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let name = if safe.is_empty() { "upload.xlsx".to_string() } else { safe };
    let tmp = dir.join(format!("{}-{}", std::process::id(), name));
    std::fs::write(&tmp, bytes).context("could not stage the upload")?;
    let out = read_sheet(&tmp.to_string_lossy());
    let _ = std::fs::remove_file(&tmp);
    out
}

/// Column-name lookup used by the tests and by the quality report.
pub fn header_names(sheet: &Sheet, cols: &Columns) -> HashMap<&'static str, String> {
    let d = describe(sheet, cols);
    let mut m = HashMap::new();
    for (k, v) in [
        ("upc", d.upc_col),
        ("location", d.location_col),
        ("box", d.box_col),
        ("units", d.units_col),
        ("title", d.title_col),
        ("msrp", d.msrp_col),
    ] {
        if let Some(v) = v {
            m.insert(k, v);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    #[test]
    fn money_parsing() {
        assert_eq!(parse_number("$1,234.50"), Some(1234.50));
        assert_eq!(parse_number("190"), Some(190.0));
        assert_eq!(parse_number("(45.00)"), Some(-45.0));
        assert_eq!(parse_number("  "), None);
        // A style code must not read as a number.
        assert_eq!(parse_number("B08N5"), None);
        assert_eq!(parse_number("43-127-04A"), None);
    }

    #[test]
    fn barcodes_keep_their_leading_zeros() {
        assert_eq!(clean_upc("0196969506827"), "0196969506827");
        assert_eq!(clean_upc("'0196969506827"), "0196969506827");
        assert_eq!(clean_upc(" 196969506827 "), "196969506827");
        // Excel scientific notation is recovered rather than stored as "1.97E+11".
        assert_eq!(clean_upc("1.96969506827E+11"), "196969506827");
    }

    #[test]
    fn header_is_found_below_junk_rows() {
        let rows = grid(&[
            &["ACME WAREHOUSE", "", "", "", "", ""],
            &["Export generated 2026-08-21", "", "", "", "", ""],
            &["", "", "", "", "", ""],
            &["UPC/EAN", "Location", "Box #", "Remaining", "Title", "MSRP"],
            &["196969506827", "43-127-04A", "BOX3", "46", "Nike Air Max", "190.00"],
        ]);
        let c = detect_columns(&rows);
        assert_eq!(c.header_row, Some(3));
        assert_eq!(c.upc, Some(0));
        assert_eq!(c.location, Some(1));
        assert_eq!(c.r#box, Some(2));
        assert_eq!(c.units, Some(3));
        assert_eq!(c.title, Some(4));
        assert_eq!(c.msrp, Some(5));
    }

    /// Column order is irrelevant.
    #[test]
    fn columns_may_arrive_in_any_order() {
        let rows = grid(&[
            &["Description", "Qty", "Retail", "Bin", "Barcode"],
            &["Nike Air Max", "46", "190.00", "43-127-04A", "196969506827"],
        ]);
        let c = detect_columns(&rows);
        assert_eq!(c.title, Some(0));
        assert_eq!(c.units, Some(1));
        assert_eq!(c.msrp, Some(2));
        assert_eq!(c.location, Some(3));
        assert_eq!(c.upc, Some(4));
    }

    /// "Unit Price" must not be claimed as the quantity column.
    #[test]
    fn a_claimed_column_is_not_claimed_twice() {
        let rows = grid(&[
            &["UPC", "Location", "Description", "Units", "Unit Price"],
            &["196969506827", "43-127-04A", "Nike Air Max", "46", "190.00"],
        ]);
        let c = detect_columns(&rows);
        assert_eq!(c.units, Some(3));
        assert_eq!(c.msrp, Some(4));
    }

    /// A sheet that names the barcode column something else is still readable, because a
    /// column of 12-digit numbers is a column of barcodes whatever it is called.
    #[test]
    fn upc_column_found_by_shape_when_the_name_does_not_help() {
        let mut rows = vec![
            vec!["Item #".into(), "Location".into(), "Description".into(), "Qty".into(), "Retail".into()],
        ];
        for i in 0..10 {
            rows.push(vec![
                format!("19696950682{i}"),
                "43-127-04A".into(),
                "Nike Air Max".into(),
                "4".into(),
                "190.00".into(),
            ]);
        }
        let c = detect_columns(&rows);
        assert_eq!(c.upc, Some(0));
    }

    #[test]
    fn yes_no_columns_are_recognised_as_flags() {
        let mut rows = vec![vec![
            "UPC".into(),
            "Location".into(),
            "Description".into(),
            "Qty".into(),
            "Retail".into(),
            "Approved".into(),
        ]];
        for i in 0..8 {
            rows.push(vec![
                format!("19696950682{i}"),
                "43-127-04A".into(),
                "Nike Air Max".into(),
                "4".into(),
                "190.00".into(),
                if i % 2 == 0 { "yes".into() } else { "no".into() },
            ]);
        }
        let c = detect_columns(&rows);
        assert_eq!(c.flags, vec![5]);
    }

    /// The whole point of the override: a column detection never considered, picked by hand.
    #[test]
    fn a_hand_picked_column_beats_the_guess() {
        let rows = grid(&[
            &["UPC", "Location", "Description", "Qty", "Retail", "Take"],
            &["196969506827", "43-127-04A", "Nike Air Max", "46", "190.00", "12"],
        ]);
        let mut c = detect_columns(&rows);
        assert_eq!(c.units, Some(3), "Qty is what detection reads");
        ColumnMap { units: Some(5), ..Default::default() }
            .apply(&mut c, 6)
            .unwrap();
        assert_eq!(c.units, Some(5));
        // Nothing else moved: an override is about one role, not a re-detection.
        assert_eq!(c.msrp, Some(4));
        assert_eq!(c.title, Some(2));
    }

    /// A role a person moved onto a column takes it off whatever merely guessed it.
    #[test]
    fn a_guess_yields_the_column_a_person_claimed() {
        let rows = grid(&[
            &["UPC", "Location", "Description", "Units", "Unit Price"],
            &["196969506827", "43-127-04A", "Nike Air Max", "46", "190.00"],
        ]);
        let mut c = detect_columns(&rows);
        assert_eq!(c.title, Some(2));
        // "the description is column 3" - so Units, which only guessed column 3, lets go.
        ColumnMap { title: Some(3), ..Default::default() }
            .apply(&mut c, 5)
            .unwrap();
        assert_eq!(c.title, Some(3));
        assert_eq!(c.units, None, "a guess must not keep a column somebody else claimed");
    }

    /// "This sheet has no location column" is an answer, not a blank.
    #[test]
    fn not_present_clears_a_detected_column() {
        let rows = grid(&[
            &["UPC", "Location", "Description", "Qty", "Retail"],
            &["196969506827", "43-127-04A", "Nike Air Max", "46", "190.00"],
        ]);
        let mut c = detect_columns(&rows);
        assert_eq!(c.location, Some(1));
        ColumnMap { location: Some(NOT_PRESENT), ..Default::default() }
            .apply(&mut c, 5)
            .unwrap();
        assert_eq!(c.location, None);
        // Nothing else moved.
        assert_eq!(c.units, Some(3));
    }

    /// Past the end is refused, not ignored. `Vec::get` would read every row as empty and
    /// the sheet would clean away to nothing with no reason given.
    #[test]
    fn a_column_this_sheet_does_not_have_is_refused() {
        let rows = grid(&[&["UPC", "Qty"], &["196969506827", "4"]]);
        let mut c = detect_columns(&rows);
        let e = ColumnMap { msrp: Some(9), ..Default::default() }
            .apply(&mut c, 2)
            .unwrap_err()
            .to_string();
        assert!(e.contains("retail"), "{e}");
        assert!(e.contains("only has 2"), "{e}");
    }

    /// A column somebody named as a role stops being read as an approval flag, or its
    /// "no" values would drop every row they just pointed the engine at.
    #[test]
    fn claiming_a_flag_column_stops_it_dropping_rows() {
        let mut rows = vec![vec![
            "UPC".into(), "Location".into(), "Description".into(), "Qty".into(),
            "Retail".into(), "Approved".into(),
        ]];
        for i in 0..8 {
            rows.push(vec![
                format!("19696950682{i}"),
                "43-127-04A".into(),
                "Nike Air Max".into(),
                "4".into(),
                "190.00".into(),
                if i % 2 == 0 { "yes".into() } else { "no".into() },
            ]);
        }
        let mut c = detect_columns(&rows);
        assert_eq!(c.flags, vec![5]);
        ColumnMap { r#box: Some(5), ..Default::default() }.apply(&mut c, 6).unwrap();
        assert_eq!(c.r#box, Some(5));
        assert!(c.flags.is_empty());
    }

    #[test]
    fn from_columns_names_a_missing_role_rather_than_omitting_it() {
        let rows = grid(&[&["UPC", "Qty", "MSRP"], &["196969506827", "4", "190.00"]]);
        let m = ColumnMap::from_columns(&detect_columns(&rows));
        assert_eq!(m.upc, Some(0));
        assert_eq!(m.units, Some(1));
        assert_eq!(m.msrp, Some(2));
        assert_eq!(m.location, Some(NOT_PRESENT));
        assert_eq!(m.title, Some(NOT_PRESENT));
        assert!(!m.is_empty());
    }

    #[test]
    fn a_column_with_no_header_is_still_named() {
        assert_eq!(column_label(0), "A");
        assert_eq!(column_label(25), "Z");
        assert_eq!(column_label(26), "AA");
        let rows = grid(&[
            &["UPC", "", "Description", "Qty"],
            &["196969506827", "43-127-04A", "Nike Air Max", "46"],
        ]);
        let mut c = detect_columns(&rows);
        ColumnMap { location: Some(1), ..Default::default() }.apply(&mut c, 4).unwrap();
        let sheet = Sheet { rows, format: "csv".into(), sheet_name: None, note: None };
        assert_eq!(describe(&sheet, &c).location_col.as_deref(), Some("Column B"));
    }

    #[test]
    fn the_preview_shows_the_sheet_as_it_is() {
        let rows = grid(&[
            &["ACME", "", "", ""],
            &["UPC", "Location", "Description", "Qty"],
            &["196969506827", "43-127-04A", "Nike Air Max", "46"],
            &["196969506828", "43-127-04A", "Nike Air Max 2", "12"],
        ]);
        let sheet = Sheet { rows, format: "csv".into(), sheet_name: None, note: None };
        let c = detect_columns(&sheet.rows);
        let p = preview(&sheet, &c);
        assert_eq!(p.header_row, 2, "1-based");
        assert_eq!(p.headers, vec!["UPC", "Location", "Description", "Qty"]);
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[0][3], "46");
        assert_eq!(p.columns.units, Some(3));
    }

    #[test]
    fn a_free_text_column_is_not_a_flag_column() {
        let mut rows = vec![vec![
            "UPC".into(),
            "Location".into(),
            "Description".into(),
            "Qty".into(),
            "Retail".into(),
            "Notes".into(),
        ]];
        for i in 0..8 {
            rows.push(vec![
                format!("19696950682{i}"),
                "43-127-04A".into(),
                "Nike Air Max".into(),
                "4".into(),
                "190.00".into(),
                "damaged box".into(),
            ]);
        }
        assert!(detect_columns(&rows).flags.is_empty());
    }
}
