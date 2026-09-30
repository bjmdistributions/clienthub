//! R-379: split one manifest into several, by brand, by category, or by brand within
//! each category. Each piece is written as its own Excel file carrying the source's own
//! columns, row heights, column widths and photos (in a cell or placed on the sheet),
//! and each is priced the way the sheet itself was priced unless Jack says otherwise.
//!
//! **No AI anywhere** (Jack, 2026-09-24: not until he can host a model himself). Every
//! "smart" step is a rule in this file, and anything a rule cannot settle becomes a
//! question in `SplitPlan::questions` with a suggested answer. Nothing is written until
//! he exports, and the pieces always add back up to the whole (`reconciles`).
//!
//! Stateless on purpose: every call takes the file path, the answers and the edits, and
//! works the plan out again. The parsed sheet is cached (keyed by path, size and
//! modified time), so a re-plan on every keystroke costs a regroup, not a re-read.

use crate::manifest::{self, find_header_row, guess_category, infer_columns, is_summary_line, parse_money};
use crate::manifest_category;
use crate::manifest_images::{self, SheetImages};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// ── What the screen sends and gets back ─────────────────────────────────────

/// A pricing rule for one split: `pct` (a % of retail), `unit` (a price per unit),
/// `sheet` (each line keeps the sheet's own price) or `none` (no price yet).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PriceRule {
    pub mode: String,
    #[serde(default)]
    pub value: Option<f64>,
}

/// Jack's edits on top of the answers. Keys are split keys (`SplitOut::key`); rows are
/// `LineOut::row`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SplitEdits {
    #[serde(default)]
    pub names: HashMap<String, String>,
    /// A split folded into another: key -> the key it joins.
    #[serde(default)]
    pub combine: HashMap<String, String>,
    #[serde(default)]
    pub pricing: HashMap<String, PriceRule>,
    /// A unit price typed on one line, overriding its split's rule.
    #[serde(default)]
    pub line_prices: HashMap<String, f64>,
    /// Source columns left out of the files, by column index.
    #[serde(default)]
    pub hidden_cols: Vec<usize>,
    /// Columns that look like Jack's own costs (left out unless put back) that he put back.
    #[serde(default)]
    pub show_cols: Vec<usize>,
    /// Splits left out of the export.
    #[serde(default)]
    pub skip: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
    /// "pct" or "money" when picking this choice needs a number typed beside it.
    pub input: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Question {
    pub id: String,
    pub text: String,
    pub detail: Option<String>,
    pub choices: Vec<Choice>,
    /// The answer in force: Jack's, or the suggestion when he has not answered.
    pub answer: String,
    pub answered: bool,
    /// For a choice with an input: the number in force.
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub index: usize,
    pub header: String,
    /// What it was read as: description, quantity, retail, retail_total, sheet_price,
    /// sheet_total, sheet_pct, category, brand, photo_links, or "" for everything else.
    pub role: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SheetPricing {
    /// pct | unit | line | none
    pub kind: String,
    pub pct: Option<f64>,
    pub unit: Option<f64>,
    pub evidence: String,
    /// The sheet's own price across every line, when it has one.
    pub total: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SplitOut {
    pub key: String,
    pub name: String,
    pub lines: usize,
    pub units: f64,
    pub retail: f64,
    /// The sheet's own price for these lines.
    pub sheet_price: Option<f64>,
    /// What these lines come to under `rule` and any line prices.
    pub price: Option<f64>,
    pub rule: PriceRule,
    pub photos: usize,
    /// Lines this split's price rule gives no price (a line the sheet left unpriced,
    /// under "the sheet's own price"), so its total is short by them.
    pub unpriced: usize,
    pub skipped: bool,
    /// A few of the biggest titles, so a split can be recognised at a glance.
    pub examples: Vec<String>,
    /// For a split by category, the category its lines share (not a name typed over it);
    /// None for Mixed, Uncategorized and splits by brand.
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Totals {
    pub lines: usize,
    pub units: f64,
    pub retail: f64,
    pub sheet_price: Option<f64>,
    pub price: Option<f64>,
    /// What the manifests that are not left out hold between them.
    pub kept_lines: usize,
    pub kept_units: f64,
    pub kept_retail: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PhotoStats {
    pub in_cell: usize,
    pub placed: usize,
    pub web: usize,
    pub lines_with_photo: usize,
    pub link_column: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SplitPlan {
    pub file_name: String,
    pub format: String,
    pub sheet: Option<String>,
    /// 1-based row the column names are on; 0 when the file has none.
    pub header_row: usize,
    pub questions: Vec<Question>,
    pub notes: Vec<String>,
    pub columns: Vec<ColumnInfo>,
    pub sheet_pricing: SheetPricing,
    pub totals: Totals,
    pub splits: Vec<SplitOut>,
    pub photos: PhotoStats,
    /// Every line is in exactly one split and the units and retail add back up.
    pub reconciles: bool,
    pub show_price: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LineOut {
    pub row: usize,
    pub desc: String,
    pub qty: f64,
    pub retail: f64,
    pub sheet: Option<f64>,
    pub unit: Option<f64>,
    pub total: Option<f64>,
    pub edited: bool,
    pub photo: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryCount {
    pub name: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportedSplit {
    pub key: String,
    pub name: String,
    pub file: String,
    pub lines: usize,
    pub units: f64,
    pub retail: f64,
    pub price: Option<f64>,
    /// What Jack pays for these lines, when he said the sheet's price is what he pays.
    pub cost: Option<f64>,
    pub photos: Vec<String>,
    pub categories: Vec<CategoryCount>,
    /// The category a lot made from this split files under (`SplitOut::category`).
    pub category: Option<String>,
}

// ── The sheet as read ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Val {
    Empty,
    Text(String),
    Num(f64),
    Bool(bool),
    Date(f64),
}

impl Val {
    fn text(&self) -> String {
        match self {
            Val::Empty => String::new(),
            Val::Text(s) => s.clone(),
            Val::Num(f) => num_text(*f),
            Val::Bool(b) => b.to_string(),
            Val::Date(f) => num_text(*f),
        }
    }
    fn number(&self) -> Option<f64> {
        match self {
            Val::Num(f) => Some(*f),
            Val::Text(s) => parse_money(s),
            _ => None,
        }
    }
}

fn num_text(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{}", f)
    }
}

/// A CSV cell. Numbers become numbers so the files add up, except long digit runs and
/// anything with a leading zero, which are codes (a UPC loses its zero as a number).
fn val_from_text(s: &str) -> Val {
    let t = s.trim();
    if t.is_empty() {
        return Val::Empty;
    }
    let digits_only = t.chars().all(|c| c.is_ascii_digit());
    if digits_only && (t.len() >= 8 || (t.len() > 1 && t.starts_with('0'))) {
        return Val::Text(t.to_string());
    }
    // "12%" stays text so a % column reads it as twelve percent, and "1%" as one.
    if t.chars().any(|c| c.is_ascii_digit()) && !t.chars().any(|c| c.is_alphabetic()) && !t.ends_with('%') {
        if let Some(v) = parse_money(t) {
            return Val::Num(v);
        }
    }
    Val::Text(t.to_string())
}

fn val_from_cell(d: &calamine::Data) -> Val {
    use calamine::Data;
    match d {
        Data::Empty | Data::Error(_) => Val::Empty,
        Data::String(s) => {
            let t = s.trim();
            if t.is_empty() { Val::Empty } else { Val::Text(t.to_string()) }
        }
        Data::Int(i) => Val::Num(*i as f64),
        Data::Float(f) => Val::Num(*f),
        Data::Bool(b) => Val::Bool(*b),
        Data::DateTime(dt) => Val::Date(dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => Val::Text(s.clone()),
    }
}

struct Table {
    file_name: String,
    format: String,
    sheet: Option<String>,
    /// Every sheet with data rows on it, and how many.
    sheets: Vec<(String, usize)>,
    headers: Vec<String>,
    header_in_file: bool,
    header_row: usize,
    header_abs_row: Option<u32>,
    rows: Vec<Vec<Val>>,
    abs_rows: Vec<u32>,
    abs_col0: u32,
    /// Text of the rows above the header (a title, a legend, a pricing note).
    above: Vec<(usize, String)>,
    /// `=IMAGE(...)` formulas by absolute (row, col).
    image_formulas: HashMap<(u32, u32), String>,
    images: SheetImages,
    /// Inferred columns when the file has no header row: (description, quantity, retail).
    inferred: Option<(usize, Option<usize>, usize)>,
    /// What reading the file itself found worth saying (a CSV named .xls, formulas with no
    /// saved values, lines put back together).
    notes: Vec<String>,
    /// Sheets that share one header row (a pallet a sheet), which can be read together.
    same_header: Vec<String>,
}

/// The sheet answer that reads every sheet sharing the manifest's header as one.
const ALL_SHEETS: &str = "All sheets";

fn sheet_score(rows: &[Vec<Val>]) -> usize {
    rows.iter().filter(|r| r.iter().filter(|c| !matches!(c, Val::Empty)).count() >= 2).count()
}

/// How likely a sheet is to be the manifest: its data rows, then its name ("Manifest",
/// "Items" over "Summary", "Totals"), then whether a header row with a description sits on
/// it. A hidden sheet is never the default.
fn sheet_rank(name: &str, rows: &[Vec<Val>], hidden: bool) -> i64 {
    let text: Vec<Vec<String>> = rows.iter().take(200).map(|r| r.iter().map(Val::text).collect()).collect();
    let n = name.to_lowercase();
    let mut rank = sheet_score(rows) as i64;
    if ["manifest", "items", "item", "detail", "details", "lines", "load", "inventory", "products", "data"].iter().any(|w| n.contains(w)) {
        rank += 1_000;
    }
    if ["summary", "total", "totals", "pivot", "cover", "instructions", "notes", "readme", "info", "terms"].iter().any(|w| n.contains(w)) {
        rank -= 1_000;
    }
    if find_header_row(&text).is_some() {
        rank += 500;
    }
    if hidden {
        rank -= 100_000;
    }
    rank
}

/// What a file really is, whatever its name says: many warehouse and marketplace exports
/// write CSV or an HTML table and call it .xls.
fn sniff_kind(path: &str) -> &'static str {
    let mut head = [0u8; 512];
    let n = std::fs::File::open(path).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
    let head = &head[..n];
    if head.starts_with(b"PK") || head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return "excel";
    }
    let text = String::from_utf8_lossy(head).to_lowercase();
    if text.contains("<table") || text.contains("<html") || text.contains("<!doctype") {
        "html"
    } else {
        "text"
    }
}

fn read_table(path: &str, want_sheet: Option<&str>) -> Result<Table> {
    let ext = manifest::extension(path);
    let file_name = Path::new(path).file_name().and_then(|f| f.to_str()).unwrap_or("manifest").to_string();
    if ext == "pdf" {
        bail!("Splitting works on Excel and CSV manifests. This one is a PDF, so ask the supplier for the spreadsheet version.");
    }
    let named_excel = matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods");
    let kind = if named_excel { sniff_kind(path) } else { "text" };
    let excel = named_excel && kind == "excel";
    let mut notes: Vec<String> = Vec::new();
    if named_excel && !excel {
        notes.push(format!("This .{} file is really {}, so it was read as that.", ext, if kind == "html" { "a web page table" } else { "text (CSV)" }));
    }

    let mut same_header: Vec<String> = Vec::new();
    let (sheet, sheets, grid, start, image_formulas, combined) = if excel {
        use calamine::Reader;
        let mut wb = calamine::open_workbook_auto(path).map_err(|e| anyhow::anyhow!("Couldn't open the spreadsheet: {}", e))?;
        let names: Vec<String> = wb.sheet_names().to_vec();
        let hidden = manifest_images::hidden_sheets(path);
        // A sheet's rows, with a merged cell's value given to every cell it covers, so a
        // category merged down eight lines is on all eight. Returns the rows and where the
        // sheet's used range starts.
        let mut read_rows = |name: &str| -> Option<(Vec<Vec<Val>>, (u32, u32))> {
            let range = wb.worksheet_range(name).ok()?;
            let start = range.start().unwrap_or((0, 0));
            let mut rows: Vec<Vec<Val>> = range.rows().map(|r| r.iter().map(val_from_cell).collect()).collect();
            let merges = match &mut wb {
                calamine::Sheets::Xlsx(x) => x.worksheet_merge_cells(name).and_then(|r| r.ok()),
                calamine::Sheets::Xls(x) => x.worksheet_merge_cells(name),
                _ => None,
            };
            for m in merges.unwrap_or_default() {
                let (r0, c0) = (m.start.0.saturating_sub(start.0) as usize, m.start.1.saturating_sub(start.1) as usize);
                let (r1, c1) = (m.end.0.saturating_sub(start.0) as usize, m.end.1.saturating_sub(start.1) as usize);
                let Some(v) = rows.get(r0).and_then(|r| r.get(c0)).cloned() else { continue };
                if matches!(v, Val::Empty) {
                    continue;
                }
                for r in r0..=r1.min(rows.len().saturating_sub(1)) {
                    for c in c0..=c1 {
                        if let Some(cell) = rows.get_mut(r).and_then(|row| row.get_mut(c)) {
                            if matches!(cell, Val::Empty) {
                                *cell = v.clone();
                            }
                        }
                    }
                }
            }
            Some((rows, start))
        };
        let mut scored: Vec<(String, usize)> = Vec::new();
        let mut best: Option<(String, i64)> = None;
        // Sheets that share one header row (a pallet a sheet): they can be read as one.
        let mut signatures: Vec<(String, String)> = Vec::new();
        for name in &names {
            let Some((rows, _)) = read_rows(name) else { continue };
            let score = sheet_score(&rows);
            let is_hidden = hidden.contains(name);
            if score > 0 && !is_hidden {
                scored.push((name.clone(), score));
                let text: Vec<Vec<String>> = rows.iter().take(200).map(|r| r.iter().map(Val::text).collect()).collect();
                if let Some(h) = find_header_row(&text) {
                    let sig: Vec<String> = text[h].iter().map(|c| c.trim().to_lowercase()).filter(|c| !c.is_empty()).collect();
                    signatures.push((name.clone(), sig.join("|")));
                }
            }
            let rank = sheet_rank(name, &rows, is_hidden);
            if best.as_ref().map_or(true, |(_, b)| rank > *b) {
                best = Some((name.clone(), rank));
            }
        }
        if let Some((_, sig)) = signatures.first() {
            let mut counts: HashMap<&String, usize> = HashMap::new();
            for (_, s) in &signatures {
                *counts.entry(s).or_insert(0) += 1;
            }
            let (top, n) = counts.into_iter().max_by_key(|(s, n)| (*n, *s == sig)).unwrap();
            if n >= 2 {
                same_header = signatures.iter().filter(|(_, s)| s == top).map(|(name, _)| name.clone()).collect();
            }
        }
        if want_sheet == Some(ALL_SHEETS) && same_header.len() >= 2 {
            // Every sheet with that header, one after another, with a Sheet column saying
            // which each line came from. Photos stay on their own sheets and are not read.
            let mut out: Vec<Vec<Val>> = Vec::new();
            for name in &same_header {
                let Some((rows, _)) = read_rows(name) else { continue };
                let text: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(Val::text).collect()).collect();
                let Some(h) = find_header_row(&text) else { continue };
                let width = text[h].iter().rposition(|c| !c.trim().is_empty()).map_or(0, |i| i + 1);
                if out.is_empty() {
                    let mut head: Vec<Val> = rows[h][..width].to_vec();
                    head.push(Val::Text("Sheet".into()));
                    out.push(head);
                }
                for r in &rows[h + 1..] {
                    let mut r: Vec<Val> = r.iter().take(width).cloned().collect();
                    r.resize(width, Val::Empty);
                    if r.iter().all(|v| matches!(v, Val::Empty)) {
                        continue;
                    }
                    r.push(Val::Text(name.clone()));
                    out.push(r);
                }
            }
            notes.push(format!("Read {} together ({}). Their photos are not carried into the new files.", plural(same_header.len(), "sheet", "sheets"), list_names(&same_header)));
            (Some(ALL_SHEETS.to_string()), scored, out, (0, 0), HashMap::new(), true)
        } else {
            let chosen = match want_sheet {
                Some(w) if names.iter().any(|n| n == w) => w.to_string(),
                _ => best.map(|(n, _)| n).context("Couldn't read any sheet out of that spreadsheet.")?,
            };
            let (rows, start) = read_rows(&chosen).with_context(|| format!("Couldn't read the sheet {}", chosen))?;
            let mut formulas = HashMap::new();
            if let Ok(fr) = wb.worksheet_formula(&chosen) {
                let fs = fr.start().unwrap_or((0, 0));
                // Formulas Excel never saved a value for read as blank: say so, per column.
                let mut blank_formulas: HashMap<u32, usize> = HashMap::new();
                for (r, c, f) in fr.used_cells() {
                    let (ar, ac) = (fs.0 + r as u32, fs.1 + c as u32);
                    if matches!(ext.as_str(), "xlsx" | "xlsm") && f.to_uppercase().contains("IMAGE(") {
                        formulas.insert((ar, ac), f.clone());
                        continue;
                    }
                    let (rr, cc) = (ar.saturating_sub(start.0) as usize, ac.saturating_sub(start.1) as usize);
                    if rows.get(rr).and_then(|row| row.get(cc)).map_or(false, |v| matches!(v, Val::Empty)) {
                        *blank_formulas.entry(ac).or_insert(0) += 1;
                    }
                }
                let mut cols: Vec<(u32, usize)> = blank_formulas.into_iter().filter(|(_, n)| *n >= 3).collect();
                cols.sort();
                if !cols.is_empty() {
                    let letters: Vec<String> = cols.iter().map(|(c, _)| col_letter(*c)).collect();
                    notes.push(format!(
                        "Column {} holds formulas Excel never saved a value for, so {} blank here. Open the file in Excel, save it, and read it again.",
                        list_names(&letters),
                        if letters.len() == 1 { "it reads" } else { "they read" }
                    ));
                }
            }
            (Some(chosen), scored, rows, start, formulas, false)
        }
    } else {
        let g = if kind == "html" {
            let text = String::from_utf8_lossy(&std::fs::read(path).context("open the file")?).into_owned();
            manifest::grid_from_html(&text).context("Couldn't find a table in that file.")?
        } else {
            manifest::grid_from_delimited(path)?
        };
        let mut rows: Vec<Vec<Val>> = g.rows.iter().map(|r| r.iter().map(|c| val_from_text(c)).collect()).collect();
        let n = repair_ragged(&mut rows);
        if n > 0 {
            notes.push(format!("{} had commas inside the description with no quotes around it, so {} put back together.", plural(n, "line", "lines"), if n == 1 { "it was" } else { "they were" }));
        }
        (None, Vec::new(), rows, (0, 0), HashMap::new(), false)
    };

    let text: Vec<Vec<String>> = grid.iter().map(|r| r.iter().map(Val::text).collect()).collect();
    let ncols = grid.iter().map(|r| r.len()).max().unwrap_or(0);
    let pad = |mut r: Vec<Val>| {
        r.resize(ncols, Val::Empty);
        r
    };

    let images = match (&sheet, excel && !combined) {
        (Some(s), true) => manifest_images::read(path, s),
        _ => SheetImages::default(),
    };

    if let Some(h) = find_header_row(&text) {
        let headers: Vec<String> = (0..ncols).map(|j| text[h].get(j).map(|s| s.trim().to_string()).unwrap_or_default()).collect();
        let above = (0..h).map(|i| (start.0 as usize + i + 1, text[i].iter().filter(|c| !c.is_empty()).cloned().collect::<Vec<_>>().join(" "))).collect();
        let rows: Vec<Vec<Val>> = grid[h + 1..].iter().cloned().map(pad).collect();
        let abs_rows = (h + 1..grid.len()).map(|i| start.0 + i as u32).collect();
        return Ok(Table {
            file_name, format: ext, sheet, sheets, headers, header_in_file: true,
            header_row: start.0 as usize + h + 1, header_abs_row: Some(start.0 + h as u32),
            rows, abs_rows, abs_col0: start.1, above, image_formulas, images, inferred: None, notes, same_header,
        });
    }

    let Some(inf) = infer_columns(&text) else {
        bail!("Couldn't find the column names in this file. It needs a row of headers with something like description, quantity and price on it.");
    };
    let headers = (0..ncols)
        .map(|j| {
            if j == inf.desc {
                "Description".to_string()
            } else if Some(j) == inf.qty {
                "Quantity".to_string()
            } else if j == inf.price {
                "Retail".to_string()
            } else {
                format!("Column {}", j + 1)
            }
        })
        .collect();
    let abs_rows = (0..grid.len()).map(|i| start.0 + i as u32).collect();
    Ok(Table {
        file_name, format: ext, sheet, sheets, headers, header_in_file: false, header_row: 0, header_abs_row: None,
        rows: grid.into_iter().map(pad).collect(), abs_rows, abs_col0: start.1, above: Vec::new(), image_formulas, images,
        inferred: Some((inf.desc, inf.qty, inf.price)), notes, same_header,
    })
}

/// A column's letters: 0 is A, 27 is AB.
fn col_letter(mut c: u32) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s
}

/// Put back together the lines of a CSV whose description had commas and no quotes:
/// "Nike Club Fleece Pants, Grey, Size L,Nike,3,60" reads as six cells under a four-column
/// header. The surplus cells are joined into the description when that makes the rest of
/// the line read as the header says (numbers where the numbers belong). Returns the rows
/// changed.
fn repair_ragged(rows: &mut [Vec<Val>]) -> usize {
    let text: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(Val::text).collect()).collect();
    let Some(h) = find_header_row(&text) else { return 0 };
    let width = text[h].iter().rposition(|c| !c.trim().is_empty()).map_or(0, |i| i + 1);
    let heads: Vec<Vec<String>> = text[h].iter().map(|c| hwords(c)).collect();
    let Some(d) = heads.iter().position(|w| hhas(w, TITLE_HEADS) || hhas(w, DESC_HEADS)) else { return 0 };
    // Columns after the description that should hold numbers.
    let numeric_after: Vec<usize> = (d + 1..width).filter(|&j| hhas(&heads[j], COUNT_WORDS) || hhas(&heads[j], RETAIL_STRONG) || hhas(&heads[j], SALE_WORDS) || hhas(&heads[j], RETAIL_WEAK)).collect();
    if numeric_after.is_empty() {
        return 0;
    }
    let mut fixed = 0;
    for r in rows.iter_mut().skip(h + 1) {
        let filled = r.iter().rposition(|c| !matches!(c, Val::Empty)).map_or(0, |i| i + 1);
        let reads = |row: &[Val]| numeric_after.iter().filter(|&&j| row.get(j).map_or(false, |v| v.number().is_some())).count();
        // The surplus is the cells past the header, counting a trailing empty cell (an
        // empty last column) or not: whichever puts the numbers where the header says.
        let mut best: Option<(usize, Vec<Val>)> = None;
        for len in [r.len(), filled] {
            if len <= width || d + (len - width) >= r.len() {
                continue;
            }
            let surplus = len - width;
            let mut joined: Vec<Val> = r[..d].to_vec();
            let desc: Vec<String> = r[d..=d + surplus].iter().map(Val::text).collect();
            joined.push(Val::Text(desc.join(", ")));
            joined.extend(r[d + surplus + 1..].iter().cloned());
            let n = reads(&joined);
            if n > reads(r) && best.as_ref().map_or(true, |(b, _)| n > *b) {
                best = Some((n, joined));
            }
        }
        if let Some((_, mut joined)) = best {
            joined.resize(r.len(), Val::Empty);
            *r = joined;
            fixed += 1;
        }
    }
    fixed
}

/// The last sheet read, so answering a question does not re-read a 10,000-row file.
static CACHE: Mutex<Option<(String, Option<String>, u64, u128, Arc<Table>)>> = Mutex::new(None);

fn table(path: &str, sheet: Option<&str>) -> Result<Arc<Table>> {
    let meta = std::fs::metadata(path).context("open the manifest")?;
    let len = meta.len();
    let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    let want = sheet.map(|s| s.to_string());
    if let Ok(c) = CACHE.lock() {
        if let Some((p, s, l, m, t)) = c.as_ref() {
            // Asking by name for the sheet the last read already chose is the same read.
            if p == path && *l == len && *m == mtime && (*s == want || (want.is_some() && t.sheet == want)) {
                return Ok(t.clone());
            }
        }
    }
    let t = Arc::new(read_table(path, sheet)?);
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((path.to_string(), want, len, mtime, t.clone()));
    }
    Ok(t)
}

// ── Columns ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct Cols {
    desc: usize,
    /// A second text column beside the title (a long description), read for the category
    /// and brand when the title alone says nothing.
    alt_text: Option<usize>,
    qty: Option<usize>,
    /// Other quantity columns passed over ("Qty Ordered" when "Qty Shipped" was read).
    other_qty: Vec<usize>,
    /// A size run across the columns ("6, 7, 8, 9" or "S, M, L, XL"), each cell a count: with
    /// no quantity column, a line's units are their sum.
    size_cols: Vec<usize>,
    category: Option<usize>,
    brand: Option<usize>,
    retail_unit: Option<usize>,
    retail_ext: Option<usize>,
    sale_unit: Option<usize>,
    sale_ext: Option<usize>,
    pct: Option<usize>,
    /// A plain "Price" column on a sheet with no retail column: it could be either.
    ambiguous: Option<usize>,
    photo_links: Option<usize>,
    /// Columns nothing else claimed whose header reads like a cost, a fee, a supplier or a
    /// source link ("Freight", "Landed", "Vendor", "PO #", "Website Link"). Left out of the
    /// files unless Jack puts them back, so what a supplier charged never reaches a buyer by
    /// accident.
    internal: Vec<usize>,
    /// Columns with no header that hold notes rather than product data ("2+6", "page 21").
    /// Left out too unless put back.
    unnamed: Vec<usize>,
}

/// A header's words: lowercase, split on anything that is not a letter or digit, with "%"
/// and "#" kept as words of their own ("% of Retail", "Item #").
fn hwords(h: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in h.to_lowercase().chars() {
        if c.is_alphanumeric() {
            cur.push(c);
        } else {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            if c == '%' || c == '#' {
                out.push(c.to_string());
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Whether the header's words hold any of `list`, whole words only; an entry with a space
/// is a phrase ("list price"), and a word may be plural ("units", "totals").
fn hhas(ws: &[String], list: &[&str]) -> bool {
    list.iter().any(|item| {
        let p: Vec<&str> = item.split(' ').collect();
        ws.windows(p.len()).any(|w| {
            w.iter().zip(&p).all(|(a, b)| a == b || (a.len() > 2 && a.strip_suffix('s') == Some(*b)))
        })
    })
}

const INTERNAL_WORDS: &[&str] = &["cost", "price", "landed", "freight", "duty", "fee", "fees", "margin", "profit",
    "invoice", "paid", "supplier", "vendor", "source", "po", "p o", "purchase price", "purchase cost", "bid", "offer",
    "wholesale", "link", "url", "website", "web", "href", "notes", "note", "comment", "comments", "markup", "bought",
    "acquired", "commission", "rebate", "reserve", "floor", "consignor", "broker", "tariff", "customs", "internal",
    "sourcing", "shipping cost", "remarks", "remark"];
/// Headers that are facts about the product, not costs, however they are worded ("Shipping
/// Weight", "Best Seller", "Duty Free", "Purchase Date").
const NOT_INTERNAL: &[&str] = &["weight", "wt", "date", "rating", "rank", "free", "sold", "dimensions", "best", "size"];

/// Retail, for sure ("Unit Retail", "MSRP", "List Price", "Compare At").
const RETAIL_STRONG: &[&str] = &["retail", "msrp", "srp", "rrp", "mrp", "list price", "compare at"];
/// Retail when nothing says it more plainly ("Value", "Original").
const RETAIL_WEAK: &[&str] = &["list", "original", "orig", "value", "compare", "was", "map", "worth"];
const SALE_WORDS: &[&str] = &["cost", "price", "offer", "sell", "selling", "wholesale", "bid", "your", "our",
    "liquidation", "sale", "net", "asking", "pay"];
/// Words that say a plain price column is this load's price rather than retail.
const LOAD_WORDS: &[&str] = &["cost", "offer", "sell", "selling", "wholesale", "bid", "your", "our", "liquidation",
    "net", "asking", "pay", "lot", "load"];
const EXT_WORDS: &[&str] = &["ext", "extended", "total", "amount", "subtotal", "line"];
const COUNT_WORDS: &[&str] = &["qty", "quantity", "quan", "qnty", "pcs", "pieces", "count", "units", "unit count", "on hand",
    "qoh", "available", "avail", "stock", "pairs", "pair", "inventory", "balance", "oh"];
/// Never money, whatever else the header says: an id, a code, a weight, a rank or a size
/// ("Listing ID", "Original PO #", "Net Wt", "Sales Rank", "Cost Center").
const NOT_MONEY: &[&str] = &["id", "#", "no", "number", "code", "sku", "upc", "ean", "asin", "isbn", "weight",
    "wt", "lb", "lbs", "kg", "oz", "rank", "ranking", "center", "terms", "grade", "po", "zip", "phone", "year",
    "page", "dimension", "length", "width", "height", "size", "pallet", "row", "date", "break", "class"];
/// A % column that is not this load's price ("Margin %", "Markup %", "Tax %", "Save %").
const NOT_PRICE_PCT: &[&str] = &["off", "discount", "margin", "markup", "tax", "save", "savings", "recovery",
    "damaged", "damage", "through", "rate", "defect", "return", "fill", "commission", "fee", "profit"];

/// Header words for the description, best first: a title or name column, then a
/// description column.
const TITLE_HEADS: &[&str] = &["title", "name", "product", "item", "model", "style", "article", "listing",
    "merchandise"];
const DESC_HEADS: &[&str] = &["description", "desc", "details"];
/// A column with one of these words is not the description unless its header also says
/// description, title or name ("Item #" no, "SKU Description" yes).
const NOT_DESC: &[&str] = &["id", "#", "no", "number", "code", "sku", "upc", "ean", "asin", "isbn"];
/// A column with one of these words is never the description ("Product Link", "Product
/// Type", "Brand Name").
const NOT_DESC_HARD: &[&str] = &["link", "url", "website", "image", "photo", "picture", "type", "category",
    "categories", "class", "dept", "department", "brand", "manufacturer", "vendor", "mfr", "color", "colour", "size",
    "condition", "qty", "quantity", "price", "cost", "retail", "msrp", "value", "amount", "location", "bin", "seller",
    "supplier", "status", "grade"];
const CATEGORY_HEADS: &[&str] = &["category", "categories", "department", "dept", "product type", "item type",
    "subcategory", "sub category", "class name", "class description", "division", "segment"];
/// A category or brand column with one of these words holds a code, not a name ("Dept #",
/// "Category ID", "Manufacturer Part Number", "Vendor Cost").
const NOT_NAME: &[&str] = &["id", "#", "no", "number", "code", "part", "sku", "cost", "price", "model", "offer",
    "link", "url", "style", "rank", "type id", "shipping", "carrier", "printed", "size", "care"];
const BRAND_HEADS: &[&str] = &["brand", "brands", "manufacturer", "mfr", "mfg", "maker", "make", "designer", "marke", "marca",
    "company", "label"];
/// A "category" whose values are only these is a gender, an age, a size or a condition.
const NOT_CATEGORY_VALUES: &[&str] = &["mens", "men", "womens", "women", "boys", "girls", "kids", "kid", "adult",
    "adults", "unisex", "youth", "toddler", "infant", "baby", "ladies", "s", "m", "l", "xl", "xxl", "xs", "new",
    "used", "refurbished", "open box", "like new", "damaged", "salvage", "return", "returns", "customer return",
    "customer returns", "overstock", "shelf pull", "shelf pulls", "a", "b", "c", "d", "grade a", "grade b",
    "grade c", "regular", "tall", "big", "petite", "plus", "y", "n", "yes", "no", "true", "false"];

/// What a column's first 500 filled cells look like.
struct ColStats {
    filled: usize,
    numeric: f64,
    urls: f64,
    /// Share of cells that look like a code (no space, and a digit in it).
    codes: f64,
    mean_words: f64,
    distinct: usize,
}

fn col_stats(t: &Table, j: usize) -> ColStats {
    let (mut filled, mut nums, mut urls, mut codes, mut words) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut seen: HashSet<String> = HashSet::new();
    for r in t.rows.iter().take(500) {
        let v = &r[j];
        if matches!(v, Val::Empty) {
            continue;
        }
        filled += 1;
        if v.number().is_some() {
            nums += 1;
        }
        let s = v.text();
        let l = s.to_lowercase();
        if l.starts_with("http://") || l.starts_with("https://") || l.starts_with("www.") {
            urls += 1;
        }
        if !s.trim().contains(' ') && s.chars().any(|c| c.is_ascii_digit()) {
            codes += 1;
        }
        words += s.split_whitespace().count();
        if seen.len() < 5000 {
            seen.insert(l.trim().to_string());
        }
    }
    let f = filled.max(1) as f64;
    ColStats {
        filled,
        numeric: nums as f64 / f,
        urls: urls as f64 / f,
        codes: codes as f64 / f,
        mean_words: words as f64 / f,
        distinct: seen.len(),
    }
}

fn detect_cols(t: &Table, price_role: &str) -> Result<Cols> {
    let ws: Vec<Vec<String>> = t.headers.iter().map(|h| hwords(h)).collect();
    let stats: Vec<ColStats> = (0..t.headers.len()).map(|j| col_stats(t, j)).collect();
    let mut c = Cols::default();

    // The description: a title column, else a description column, judged by what is in
    // them as well as their header. A column of links, codes or numbers never is one.
    let text_col = |j: usize| {
        let s = &stats[j];
        s.filled > 0 && s.urls < 0.5 && s.numeric < 0.5 && s.codes < 0.6
    };
    // "SKU Description" and "ASIN Title" are descriptions; "Item #" and "Product Code" are not.
    let not_desc = |w: &[String]| {
        hhas(w, NOT_DESC_HARD) || (hhas(w, NOT_DESC) && !hhas(w, &["description", "desc", "title", "name", "details"]))
    };
    let pick = |heads: &[&str]| -> Option<usize> {
        (0..ws.len())
            .filter(|&j| hhas(&ws[j], heads) && !not_desc(&ws[j]) && text_col(j))
            .max_by(|&a, &b| {
                stats[a].mean_words.partial_cmp(&stats[b].mean_words).unwrap_or(std::cmp::Ordering::Equal).then(b.cmp(&a))
            })
    };
    let (title, long) = if let Some((d, _, _)) = t.inferred { (Some(d), None) } else { (pick(TITLE_HEADS), pick(DESC_HEADS)) };
    c.desc = match (title, long) {
        // A title reads better than the marketing text beside it; the description is still
        // read when the title says nothing. A title of a word or two (clipped, or a code)
        // gives way to the description.
        (Some(ti), Some(de)) if stats[ti].mean_words >= 2.0 => {
            c.alt_text = Some(de);
            ti
        }
        (Some(ti), Some(de)) => {
            c.alt_text = Some(ti);
            de
        }
        (Some(j), None) | (None, Some(j)) => j,
        (None, None) => (0..ws.len())
            .filter(|&j| text_col(j) && stats[j].mean_words >= 2.0 && !not_desc(&ws[j]))
            .max_by(|&a, &b| stats[a].mean_words.partial_cmp(&stats[b].mean_words).unwrap_or(std::cmp::Ordering::Equal))
            .context("Found the header row but no description column.")?,
    };
    let desc = c.desc;

    // How many of a column's filled cells are numbers, over the first 500 rows.
    let numeric = |j: usize| stats[j].numeric;
    if let Some((_, _, price)) = t.inferred {
        c.retail_unit = Some(price);
    } else {
        let mut weak_unit = None;
        let mut weak_ext = None;
        for (j, w) in ws.iter().enumerate() {
            if j == desc || w.is_empty() || numeric(j) < 0.5 || Some(j) == c.alt_text {
                continue;
            }
            if hhas(w, COUNT_WORDS) || hhas(w, NOT_MONEY) {
                continue;
            }
            let ext = hhas(w, EXT_WORDS) && !hhas(w, &["unit", "each", "per"]);
            let pctish = hhas(w, &["%", "percent", "pct"]);
            if pctish {
                // Only "this price as a % of retail", never a margin, a tax or a discount,
                // and never above 100%.
                let within = t.rows.iter().take(500).filter_map(|r| pct_value(&r[j])).all(|v| v <= 1.0 + 1e-9);
                let context = w.len() == 1 || hhas(w, &["retail", "msrp", "of", "price", "cost", "offer", "sell", "liquidation", "lot", "load"]);
                if within && context && !hhas(w, NOT_PRICE_PCT) {
                    c.pct = c.pct.or(Some(j));
                }
                continue;
            }
            let strong = hhas(w, RETAIL_STRONG);
            let sale = hhas(w, SALE_WORDS);
            if strong {
                if ext { c.retail_ext = c.retail_ext.or(Some(j)) } else { c.retail_unit = c.retail_unit.or(Some(j)) }
            } else if hhas(w, RETAIL_WEAK) && !sale {
                if ext { weak_ext = weak_ext.or(Some(j)) } else { weak_unit = weak_unit.or(Some(j)) }
            } else if sale {
                if ext { c.sale_ext = c.sale_ext.or(Some(j)) } else { c.sale_unit = c.sale_unit.or(Some(j)) }
            }
        }
        // "Value" and "Total Value" are retail when nothing says retail more plainly.
        if c.retail_unit.is_none() && c.retail_ext.is_none() {
            c.retail_unit = weak_unit;
            c.retail_ext = weak_ext;
        }
        // A bare "Extended", "Line Total" or "Total" money column, when nothing else is
        // money, is a line total of the same unsure kind as a plain "Price".
        if c.retail_unit.is_none() && c.retail_ext.is_none() && c.sale_unit.is_none() && c.sale_ext.is_none() {
            c.sale_ext = (0..ws.len()).find(|&j| {
                j != desc
                    && Some(j) != c.alt_text
                    && Some(j) != c.pct
                    && numeric(j) >= 0.5
                    && hhas(&ws[j], &["extended", "ext", "line total", "total", "amount"])
                    && !hhas(&ws[j], COUNT_WORDS)
                    && !hhas(&ws[j], NOT_MONEY)
                    && t.rows.iter().take(500).any(|r| r[j].number().map_or(false, |v| v.fract() != 0.0))
            });
        }
        // A sheet with no retail column and one plain "Price": retail or this load's price?
        // Its extended sibling ("Extended Price") goes the same way.
        if c.retail_unit.is_none() && c.retail_ext.is_none() {
            let plain = |j: Option<usize>| j.filter(|&j| !hhas(&ws[j], LOAD_WORDS));
            if let Some(j) = plain(c.sale_unit).or(plain(c.sale_ext)) {
                c.ambiguous = Some(j);
                if price_role != "load" {
                    if plain(c.sale_unit).is_some() {
                        c.retail_unit = c.sale_unit.take();
                    }
                    if plain(c.sale_ext).is_some() {
                        c.retail_ext = c.sale_ext.take();
                    }
                }
            }
        }
    }
    let money = [c.retail_unit, c.retail_ext, c.sale_unit, c.sale_ext, c.pct];
    let mut ex: Vec<Option<usize>> = vec![Some(desc), c.alt_text];
    ex.extend(money);

    // Quantity: a count column that is mostly numbers; the shipped or received count over
    // the ordered one when a sheet has both.
    c.qty = match t.inferred {
        Some((_, q, _)) => q,
        None => {
            // A count column may be written as text ("5 pcs", "x3"): judged by what reads as
            // a quantity, not only by what reads as a number.
            let readable = |j: usize| {
                let (mut filled, mut ok) = (0usize, 0usize);
                for r in t.rows.iter().take(500) {
                    if !matches!(r[j], Val::Empty) {
                        filled += 1;
                        if qty_value(&r[j]).is_some() {
                            ok += 1;
                        }
                    }
                }
                filled > 0 && ok * 2 >= filled
            };
            let mut qs: Vec<usize> = (0..ws.len())
                .filter(|j| !ex.contains(&Some(*j)) && hhas(&ws[*j], COUNT_WORDS) && !hhas(&ws[*j], &["%", "percent"]) && readable(*j))
                .collect();
            let rank = |j: &usize| -> u8 {
                if hhas(&ws[*j], &["shipped", "received", "available", "actual", "delivered", "on hand"]) {
                    0
                } else if hhas(&ws[*j], &["ordered", "requested", "original", "expected", "po"]) {
                    2
                } else {
                    1
                }
            };
            qs.sort_by_key(|j| (rank(j), *j));
            let first = qs.first().copied();
            c.other_qty = qs.into_iter().skip(1).collect();
            first
        }
    };
    ex.push(c.qty);
    ex.extend(c.other_qty.iter().map(|j| Some(*j)));
    // Size columns: three or more headers that are sizes, holding whole counts.
    let size_head = |h: &str| {
        let h = h.trim().to_lowercase();
        let n = h.parse::<f64>().ok();
        n.map_or(false, |v| ((1.0..=16.0).contains(&v) && (v * 2.0).fract() == 0.0) || (24.0..=54.0).contains(&v))
            || ["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl", "4xl", "5xl", "os", "2t", "3t", "4t", "5t"].contains(&h.as_str())
            || (h.len() <= 4 && (h.ends_with('y') || h.ends_with('c')) && h[..h.len() - 1].parse::<f64>().is_ok())
    };
    let sizes: Vec<usize> = (0..t.headers.len())
        .filter(|&j| !ex.contains(&Some(j)) && size_head(&t.headers[j]))
        .filter(|&j| t.rows.iter().take(500).all(|r| matches!(r[j], Val::Empty) || r[j].number().map_or(false, |v| v >= 0.0 && v.fract() == 0.0)))
        .collect();
    if sizes.len() >= 3 && t.inferred.is_none() {
        c.size_cols = sizes;
        ex.extend(c.size_cols.iter().map(|j| Some(*j)));
    }

    // Category and brand: a column of names, never of codes, prices or one repeated value.
    let names_col = |j: usize| {
        let s = &stats[j];
        s.filled > 0 && s.numeric < 0.8 && s.codes < 0.5 && s.urls < 0.5
    };
    if t.inferred.is_none() {
        // "Class", "Type", "Group": a category column only when its values read as categories.
        let reads_as_categories = |j: usize| {
            let vals: HashSet<String> = t.rows.iter().take(500).map(|r| r[j].text().trim().to_string()).filter(|v| !v.is_empty()).collect();
            !vals.is_empty()
                && vals.iter().filter(|v| !matches!(guess_category(v), "Uncategorized" | "General Merchandise")).count() * 10 >= vals.len() * 6
        };
        let mut cats: Vec<usize> = (0..ws.len())
            .filter(|&j| {
                !ex.contains(&Some(j))
                    && (hhas(&ws[j], CATEGORY_HEADS) || (hhas(&ws[j], &["class", "type", "group", "segment"]) && reads_as_categories(j)))
                    && !hhas(&ws[j], NOT_NAME)
                    && names_col(j)
            })
            .filter(|&j| {
                let s = &stats[j];
                let too_many = s.filled >= 20 && s.distinct as f64 > 0.6 * s.filled as f64;
                let values: HashSet<String> = t.rows.iter().take(500).map(|r| r[j].text().trim().to_lowercase()).filter(|v| !v.is_empty()).collect();
                let only_stop = !values.is_empty() && values.iter().all(|v| NOT_CATEGORY_VALUES.contains(&v.as_str()) || manifest_category::is_no_value(v));
                let strong = hhas(&ws[j], &["category", "categories", "department", "dept"]);
                (s.distinct >= 2 || strong) && !too_many && !only_stop
            })
            .collect();
        let tier = |j: &usize| -> u8 {
            let w = &ws[*j];
            if hhas(w, &["subcategory", "sub category", "sub"]) {
                3
            } else if hhas(w, &["category", "categories"]) {
                0
            } else if hhas(w, &["department", "dept", "division"]) {
                1
            } else {
                2
            }
        };
        cats.sort_by_key(|j| (tier(j), *j));
        c.category = cats.first().copied();
        ex.push(c.category);
        c.brand = (0..ws.len())
            .filter(|&j| !ex.contains(&Some(j)) && hhas(&ws[j], BRAND_HEADS) && !hhas(&ws[j], NOT_NAME) && names_col(j))
            .find(|&j| !hhas(&ws[j], &["offer"]));
        // "Vendor" is usually the supplier, but a Shopify export puts the brand there: it is
        // the brand column when its values are brands we know.
        if c.brand.is_none() {
            let known: HashSet<String> = KNOWN_BRANDS.iter().map(|b| brand_key(b)).collect();
            c.brand = (0..ws.len()).filter(|&j| !ex.contains(&Some(j)) && hhas(&ws[j], &["vendor"]) && names_col(j)).find(|&j| {
                let vals: HashSet<String> = t.rows.iter().take(500).map(|r| brand_key(&r[j].text())).filter(|v| !v.is_empty()).collect();
                vals.len() >= 2 && vals.iter().filter(|v| known.contains(*v)).count() * 10 >= vals.len() * 3
            });
        }
        ex.push(c.brand);
    }

    // A column of photo links: mostly web addresses, named like a picture or pointing at
    // image files.
    for j in 0..t.headers.len() {
        if ex.contains(&Some(j)) {
            continue;
        }
        let vals: Vec<String> = t.rows.iter().take(500).map(|r| r[j].text()).filter(|s| !s.is_empty()).collect();
        if vals.len() < 2 {
            continue;
        }
        let urls = vals.iter().filter(|v| v.starts_with("http://") || v.starts_with("https://")).count();
        let pics = vals.iter().filter(|v| is_image_url(v)).count();
        let named = hhas(&ws[j], &["image", "photo", "picture", "img", "pic", "thumbnail"]);
        if urls * 2 >= vals.len() && (named || pics * 2 >= vals.len()) {
            c.photo_links = Some(j);
            break;
        }
    }
    ex.push(c.photo_links);
    c.internal = (0..t.headers.len())
        .filter(|j| {
            !ex.contains(&Some(*j))
                && (hhas(&ws[*j], INTERNAL_WORDS) || t.headers[*j].contains('$') || matches!(ws[*j].as_slice(), [w] if w == "seller"))
                && !hhas(&ws[*j], NOT_INTERNAL)
        })
        .collect();
    // A column with no header and something in it: a note, unless it holds pictures.
    let picture_cols: HashSet<u32> = t
        .images
        .in_cell
        .keys()
        .chain(t.images.web.keys())
        .map(|(_, cc)| *cc)
        .chain(t.images.placed.iter().map(|p| p.col))
        .collect();
    c.unnamed = (0..t.headers.len())
        .filter(|j| {
            t.header_in_file
                && !ex.contains(&Some(*j))
                && !c.internal.contains(j)
                && t.headers[*j].trim().is_empty()
                && t.rows.iter().any(|r| !matches!(r[*j], Val::Empty))
                && !picture_cols.contains(&(t.abs_col0 + *j as u32))
        })
        .collect();
    Ok(c)
}

fn is_image_url(v: &str) -> bool {
    let l = v.to_lowercase();
    let path = l.split(['?', '#']).next().unwrap_or("");
    (l.starts_with("http://") || l.starts_with("https://"))
        && [".jpg", ".jpeg", ".png", ".webp", ".gif"].iter().any(|e| path.ends_with(e))
}

/// A % cell as a fraction: "12%" and 12 and 0.12 are all 0.12, and "1%" is 0.01, not 100%
/// (a CSV's text keeps its % sign, so it is read as written).
fn pct_value(v: &Val) -> Option<f64> {
    match v {
        Val::Text(s) if s.trim().ends_with('%') => parse_money(s).map(|p| p / 100.0),
        _ => v.number().map(pct_fraction),
    }
}

// ── Lines ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Line {
    row: usize,
    desc: String,
    /// Other text read for the category and brand when the title says nothing.
    alt: String,
    qty: f64,
    retail: f64,
    sheet: Option<f64>,
    category: String,
    brand_raw: String,
    photo: bool,
}

#[derive(Default)]
struct Lines {
    lines: Vec<Line>,
    /// Total rows left out, with their labels ("TOTAL", "Pallet 1 Total").
    summary: Vec<String>,
    zero_qty: usize,
    /// Rows that repeat the header row (a multi-page export).
    repeated_headers: usize,
    /// Rows with a label and nothing else: "PALLET 2", "FOOTWEAR", a thank-you note.
    separators: Vec<String>,
    /// Lines kept although their description was blank, named by their UPC or SKU.
    unnamed: usize,
    /// Lines whose quantity could not be read ("five", "N/A"): counted as 1, or as the
    /// extended amount over the unit price when both are there.
    qty_assumed: usize,
    qty_from_amounts: usize,
    /// Lines on a sheet with a quantity column whose quantity cell is blank: counted as 1.
    qty_blank: usize,
    /// Lines where unit x quantity disagrees with the sheet's own extended column, and the
    /// biggest gap, as (row, unit x qty, extended).
    ext_mismatch: Vec<(usize, f64, f64)>,
    /// A total row's own figures, (units, retail), when it states them.
    stated_total: Option<(Option<f64>, Option<f64>)>,
}

/// A quantity cell: a number, or text that starts with one ("5 pcs", "12 EA", "x5", "(5)").
fn qty_value(v: &Val) -> Option<f64> {
    if let Val::Num(n) = v {
        return Some(*n);
    }
    let s = v.text();
    let t = s.trim().trim_start_matches(['(', 'x', 'X']).trim_end_matches(')');
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    let rest = t[digits.len()..].trim().to_lowercase();
    let unit_ok = rest.is_empty()
        || ["pc", "pcs", "piece", "pieces", "ea", "each", "unit", "units", "x", "pk", "pack", "pair", "pairs", "ct", "count"]
            .iter()
            .any(|u| rest == *u || rest.trim_end_matches('.') == *u);
    if digits.is_empty() || !unit_ok {
        return None;
    }
    parse_money(&digits).map(f64::abs)
}

fn build_lines(t: &Table, c: &Cols) -> Lines {
    let photo_rows: HashSet<u32> = t
        .images
        .in_cell
        .keys()
        .chain(t.images.web.keys())
        .map(|(r, _)| *r)
        .chain(t.images.placed.iter().map(|p| p.row))
        .chain(t.image_formulas.keys().map(|(r, _)| *r))
        .collect();
    let num = |r: &Vec<Val>, j: Option<usize>| j.and_then(|j| r[j].number());
    let header_key: Vec<String> = t.headers.iter().map(|h| h.trim().to_lowercase()).collect();
    let filled_headers = header_key.iter().filter(|h| !h.is_empty()).count();
    let money_cols = [c.retail_unit, c.retail_ext, c.sale_unit, c.sale_ext, c.pct, c.qty];
    let mut out = Lines::default();
    let (mut run_qty, mut run_ext) = (0.0f64, 0.0f64);
    for (i, r) in t.rows.iter().enumerate() {
        let mut desc = r[c.desc].text();
        // A repeated header row (a multi-page export) is not a product.
        if t.header_in_file && filled_headers >= 2 {
            let same = r.iter().zip(&header_key).filter(|(v, h)| !h.is_empty() && v.text().trim().to_lowercase() == **h).count();
            if same * 2 >= filled_headers {
                out.repeated_headers += 1;
                continue;
            }
        }
        let qty_cell = c.qty.map(|j| &r[j]).filter(|v| !matches!(v, Val::Empty));
        let unit = num(r, c.retail_unit);
        let ext = num(r, c.retail_ext);
        let has_numbers = money_cols.iter().any(|j| j.map_or(false, |j| r[j].number().is_some()));
        let q = qty_cell.and_then(qty_value);
        let near = |a: f64, b: f64| b > 0.0 && (a - b).abs() <= 0.01 * b.max(1.0);
        // Its figures are the sums of the rows above: a total row's shape.
        let sums = q.map_or(false, |q| near(q, run_qty)) || ext.map_or(false, |e| near(e, run_ext)) || unit.map_or(false, |u| near(u, run_ext));
        if desc.is_empty() {
            if !has_numbers {
                continue; // a blank spacer row
            }
            // A total row labelled in another column ("TOTAL" under SKU), or not at all.
            let label = (0..r.len()).filter(|j| *j != c.desc && !money_cols.contains(&Some(*j))).map(|j| r[j].text()).find(|s| !s.trim().is_empty());
            let labelled = label.as_ref().map_or(false, |s| is_summary_line(&s.to_lowercase()) || manifest::looks_like_total(&s.to_lowercase()));
            if labelled || (label.is_none() && sums) {
                out.summary.push(label.unwrap_or_else(|| "an unlabelled total".into()));
                out.stated_total = Some((q, ext.or(unit)));
                continue;
            }
            // A product with no description: name it by its UPC, SKU or model, else its row.
            desc = (0..r.len())
                .filter(|j| hhas(&hwords(&t.headers[*j]), &["upc", "sku", "asin", "ean", "model", "style", "item #", "item number", "part"]))
                .map(|j| r[j].text())
                .find(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("Row {} (no description)", t.abs_rows[i] + 1));
            out.unnamed += 1;
        } else if is_summary_line(&desc.to_lowercase())
            || (manifest::looks_like_total(&desc.to_lowercase()) && (unit.is_none() || sums))
        {
            // "Total Pallet A" with no unit price, or with figures that are the sums above.
            // Only a total of everything above can be checked against the lines.
            out.summary.push(desc.clone());
            if sums || desc.to_lowercase().contains("grand") {
                out.stated_total = Some((q, ext.or(unit)));
            }
            continue;
        }
        let sale_cells = [c.sale_unit, c.sale_ext, c.pct].iter().any(|j| j.map_or(false, |j| r[j].number().is_some()));
        let sized = c.size_cols.iter().any(|&j| r[j].number().map_or(false, |v| v > 0.0));
        let described = (0..r.len()).any(|j| j != c.desc && !money_cols.contains(&Some(j)) && !r[j].text().trim().is_empty());
        let figures = c.qty.is_some() || money_cols.iter().any(|j| j.is_some()) || !c.size_cols.is_empty();
        if figures && qty_cell.is_none() && unit.is_none() && ext.is_none() && !sale_cells && !sized && !described {
            // A label and nothing else: a pallet heading, a section title, a footer note.
            out.separators.push(desc);
            continue;
        }
        let size_sum: Option<f64> = if c.qty.is_none() && !c.size_cols.is_empty() {
            Some(c.size_cols.iter().filter_map(|&j| r[j].number()).sum())
        } else {
            None
        };
        if qty_cell.is_none() && c.qty.is_some() {
            out.qty_blank += 1;
        }
        let from_amounts = match (unit, ext) {
            (Some(u), Some(e)) if u > 0.0 && e > 0.0 && ((e / u) - (e / u).round()).abs() < 0.01 => Some((e / u).round()),
            _ => None,
        };
        let mut qty = match qty_cell {
            None if c.qty.is_some() && from_amounts.is_some() => {
                out.qty_blank -= 1;
                out.qty_from_amounts += 1;
                from_amounts.unwrap()
            }
            None => size_sum.filter(|q| *q > 0.0).unwrap_or(1.0),
            Some(v) => match qty_value(v) {
                Some(q) => q,
                None => match (unit, ext) {
                    (Some(u), Some(e)) if u > 0.0 && e > 0.0 && ((e / u) - (e / u).round()).abs() < 0.01 => {
                        out.qty_from_amounts += 1;
                        (e / u).round()
                    }
                    _ => {
                        out.qty_assumed += 1;
                        1.0
                    }
                },
            },
        };
        if matches!(qty_cell, Some(Val::Num(n)) if *n < 0.0) {
            qty = 0.0;
        }
        if qty <= 0.0 {
            out.zero_qty += 1;
            continue;
        }
        let retail = match (unit, ext) {
            (Some(u), _) if u > 0.0 => u * qty,
            (_, Some(e)) if e > 0.0 => e,
            _ => 0.0,
        };
        if let (Some(u), Some(e)) = (unit, ext) {
            if u > 0.0 && (u * qty - e).abs() > 0.02 * (u * qty).max(1.0) {
                out.ext_mismatch.push((t.abs_rows[i] as usize + 1, u * qty, e));
            }
        }
        let sheet = match (num(r, c.sale_ext), num(r, c.sale_unit), c.pct.and_then(|j| pct_value(&r[j]))) {
            (Some(e), _, _) if e > 0.0 => Some(e),
            (_, Some(u), _) if u > 0.0 => Some(u * qty),
            (_, _, Some(p)) if p > 0.0 && retail > 0.0 => Some(retail * p),
            _ => None,
        };
        run_qty += qty;
        run_ext += ext.unwrap_or(retail);
        let photo = photo_rows.contains(&t.abs_rows[i]) || c.photo_links.map_or(false, |j| !r[j].text().is_empty());
        out.lines.push(Line {
            row: i,
            desc,
            alt: c.alt_text.map(|j| r[j].text()).unwrap_or_default(),
            qty,
            retail,
            sheet,
            category: c.category.map(|j| r[j].text()).unwrap_or_default(),
            brand_raw: c.brand.map(|j| r[j].text()).unwrap_or_default(),
            photo,
        });
    }
    out
}

/// "12", "12%" and 0.12 are all twelve percent.
fn pct_fraction(p: f64) -> f64 {
    if p > 1.0 { p / 100.0 } else { p }
}

// ── Brands ──────────────────────────────────────────────────────────────────

const BRAND_SUFFIXES: &[&str] = &["inc", "incorporated", "llc", "ltd", "limited", "co", "corp", "corporation",
    "company", "brands", "brand", "usa", "us", "international", "intl", "group", "holdings", "mfg",
    "manufacturing", "products", "enterprises", "industries", "gmbh", "plc", "lp"];

/// A brand column value that means "no brand".
const NO_BRAND: &[&str] = &["", "n a", "na", "none", "no brand", "unbranded", "generic", "unknown", "various",
    "assorted", "mixed", "misc", "miscellaneous", "not applicable", "other", "null", "0", "tbd",
    "see description", "multiple", "multi", "various brands", "assorted brands", "mixed brands", "no name"];

/// Words that, all together, still say "no brand": "Unknown Brand", "Not Listed",
/// "Generic/Unbranded", "Private Label", "nan" (a blank written by pandas).
const NO_BRAND_WORDS: &[&str] = &["unknown", "unbranded", "generic", "misc", "miscellaneous", "mixed", "assorted",
    "various", "varies", "multiple", "multi", "none", "other", "others", "no", "not", "n", "a", "na", "listed",
    "available", "applicable", "specified", "unspecified", "unlisted", "brand", "brands", "name", "noname",
    "private", "label", "store", "see", "description", "desc", "title", "nan", "null", "tbd", "oem", "open", "box",
    "and", "or", "item", "items", "manufacturer", "manufacturers", "non", "branded", "blank", "unbrand", "variety", "all",
    "mix", "lot", "given", "provided", "tba", "unidentified", "makers", "maker", "brandless", "ungrouped", "empty", "value",
    "house"];

/// Words that open a title without being its brand ("Men's Nike Air Max", "2 Pack ...",
/// "(WMNS) Nike", "[Renewed] Apple", "Model: Nike").
const LEAD_WORDS: &[&str] = &["men", "mens", "women", "womens", "ladies", "boys", "girls", "kids", "kid", "baby",
    "toddler", "toddlers", "youth", "unisex", "adult", "infant", "infants", "junior", "juniors", "childrens",
    "children", "womans", "mans", "little", "big", "grade", "school", "gradeschool", "preschool", "td", "ps", "gs",
    "bg", "gg", "wmns", "new", "the", "genuine", "authentic", "official", "original", "lot", "of", "pack", "pk", "set",
    "case", "pcs", "pc", "ct", "count", "x", "pair", "pairs", "a", "an", "clearance", "sale", "refurbished",
    "renewed", "certified", "like", "used", "open", "box", "damaged", "nwt", "nwot", "nib", "bnib", "model", "item",
    "sku", "size", "sz", "us", "brand", "premium", "authentic", "girl", "boy", "man", "woman", "gen", "generation"];

/// All-caps specs that open a title without being a brand ("4K Ultra HD Samsung TV",
/// "OLED LG C2").
const SPEC_WORDS: &[&str] = &["oled", "qled", "uhd", "hd", "fhd", "led", "lcd", "usb", "aa", "aaa", "wifi", "wi",
    "fi", "bt", "hdmi", "ssd", "ultra"];

/// Words that start a title but are never a brand on their own.
const NOT_BRANDS: &[&str] = &["assorted", "mixed", "various", "misc", "black", "white", "red", "blue", "green",
    "gray", "grey", "pink", "purple", "orange", "yellow", "silver", "gold", "brown", "beige", "navy", "clear",
    "small", "medium", "large", "xl", "xxl", "mini", "big", "premium", "deluxe", "portable", "wireless",
    "stainless", "steel", "plastic", "wood", "wooden", "metal", "glass", "cotton", "leather", "heavy", "duty",
    "electric", "digital", "smart", "home", "kitchen", "outdoor", "indoor", "universal", "replacement",
    "compatible", "for", "with", "and", "in", "on", "by", "to", "led", "usb", "hd", "inch", "oz", "lb", "ml",
    "ft", "cm", "mm", "generic", "unbranded", "brand", "other", "shoes", "shoe", "shirt", "shirts", "pants",
    "dress", "jacket", "hoodie", "socks", "bag", "bags", "box", "boxes", "kit", "bundle", "item", "items",
    "product", "products", "sample", "used", "open", "damaged", "return", "returns", "vintage", "classic",
    "modern", "natural", "organic", "soft", "hard", "round", "square", "long", "short", "extra", "super",
    "ultra", "pro", "plus", "max", "one", "two", "three", "four", "five", "womans", "mans", "bluetooth",
    "cordless", "adjustable", "waterproof", "rechargeable", "folding", "reusable", "disposable", "automatic",
    "manual", "magnetic", "dog", "cat", "pet", "car", "phone", "iphone", "screen", "solar", "christmas",
    "halloween", "holiday", "summer", "winter", "spring", "fall", "tshirt", "t", "hand", "face", "body",
    "hair", "wall", "door", "table", "floor", "window", "bath", "bed", "water", "air", "coffee", "tea",
    "wine", "food", "storage", "cleaning", "office", "school", "art", "craft", "party", "gift", "toy",
    "toys", "game", "games", "light", "lights", "lamp", "cable", "charger", "cover", "holder", "stand",
    "rack", "organizer", "tool", "tools", "cup", "mug", "bottle", "towel", "blanket", "pillow", "rug",
    "mat", "curtain", "sheet", "sheets", "shelf", "chair", "desk", "fan", "heater", "vacuum", "mirror",
    // Product lines and marketing words that open titles ("Everyday Elevated Crew Socks",
    // "Essential Fleece", "workout/training shoes").
    "everyday", "essential", "essentials", "elevated", "workout", "training", "performance", "athletic",
    "sport", "sports", "active", "basic", "basics", "signature", "standard", "club", "team", "sportswear",
    "graphic", "printed", "cushioned", "lightweight", "breathable", "slim", "fit", "relaxed", "oversized",
    "cropped", "fleece", "woven", "knit", "wool", "denim", "canvas", "suede", "mesh", "running", "walking",
    "hiking", "casual", "dress", "formal", "comfort", "comfy", "cozy", "warm", "cool", "fashion", "trendy",
    "cute", "funny", "custom", "personalized", "set", "pack", "pair", "womens", "mens", "girls", "boys", "dna", "high", "low",
    "mid", "og", "retro", "se", "prm"];

/// Brands a liquidation manifest carries often, so a title with no brand column can
/// still be read. Several-word brands are matched first ("Hamilton Beach" over
/// "Hamilton"). Anything missing here is still found when it starts enough titles.
const KNOWN_BRANDS: &[&str] = &[
    "Apple", "Samsung", "Sony", "LG", "Bose", "JBL", "Beats", "Skullcandy", "Anker", "Belkin", "Logitech",
    "Razer", "Corsair", "HP", "Dell", "Lenovo", "Asus", "Acer", "Microsoft", "Nintendo", "PlayStation", "Xbox",
    "Canon", "Nikon", "GoPro", "Fitbit", "Garmin", "Arlo", "Roku", "Amazon Basics", "Amazon",
    "Google", "TCL", "Hisense", "Vizio", "Insignia", "Onn", "Philips", "Panasonic",
    "Toshiba", "Motorola", "OnePlus", "OtterBox", "PopSockets", "SanDisk", "Western Digital",
    "Seagate", "Netgear", "TP-Link", "Linksys", "Eufy", "Wyze", "Jabra", "Sennheiser", "Marshall",
    "Ultimate Ears", "Sonos", "Yamaha", "Pioneer", "Kenwood", "Epson", "Brother", "KitchenAid", "Cuisinart",
    "Ninja", "Shark", "Dyson", "Hoover", "Bissell", "iRobot", "Roomba", "Hamilton Beach", "Black+Decker",
    "Instant Pot", "Crock-Pot", "Keurig", "Nespresso", "Breville", "Oster", "Sunbeam", "Mr. Coffee", "Vitamix",
    "NutriBullet", "Magic Bullet", "Calphalon", "T-fal", "Rachael Ray", "Farberware", "Pyrex", "Rubbermaid",
    "OXO", "Le Creuset", "Lenox", "Corelle", "Tupperware", "Yeti", "Stanley", "Hydro Flask",
    "Contigo", "Zojirushi", "Honeywell", "Lasko", "Vornado", "Dreo", "Levoit", "Conair", "Revlon", "Remington",
    "Braun", "Gillette", "Oral-B", "Sonicare", "Waterpik", "CHI", "Hot Tools", "BaBylissPRO", "Mainstays",
    "Better Homes & Gardens", "Threshold", "Room Essentials", "Hearth & Hand", "Pillowfort", "Casaluna",
    "Brightroom", "Made By Design", "Up & Up", "Martha Stewart", "Sealy", "Serta", "Tempur-Pedic", "Casper",
    "Linenspa", "Zinus", "Coleman", "Ozark Trail", "Igloo", "Weber", "Char-Broil", "Traeger", "Blackstone",
    "DeWalt", "Milwaukee", "Makita", "Ryobi", "Craftsman", "Bosch", "Kobalt", "Husky", "Ridgid", "Worx", "Greenworks", "EGO", "Porter-Cable", "Irwin", "Klein Tools", "Dremel", "Skil", "Metabo HPT",
    "Nike", "Jordan", "Adidas", "Puma", "Reebok", "Under Armour", "New Balance", "Converse", "Vans", "ASICS",
    "Brooks", "HOKA", "Saucony", "Skechers", "Crocs", "UGG", "Timberland", "Columbia", "The North Face",
    "Patagonia", "Carhartt", "Champion", "Hanes", "Fruit of the Loom", "Gildan", "Levi's", "Wrangler", "Lee",
    "Calvin Klein", "Tommy Hilfiger", "Ralph Lauren", "Polo Ralph Lauren", "Michael Kors", "Coach",
    "Kate Spade", "Guess", "Nautica", "Izod", "Van Heusen", "Dockers", "Gap", "Old Navy", "Hurley",
    "Quiksilver", "Billabong", "Roxy", "Fila", "Lululemon", "Gymshark", "Spanx", "Maidenform", "Bali",
    "Playtex", "Jockey", "Dickies", "Wolverine", "Merrell", "Teva",
    "Birkenstock", "Dr. Martens", "Steve Madden", "Nine West", "Clarks", "Rockport", "Sperry", "Cole Haan",
    "Kenneth Cole", "DKNY", "Anne Klein", "Fossil", "Casio", "Timex", "Citizen", "Seiko", "Ray-Ban", "Oakley",
    "Cat & Jack", "Goodfellow & Co", "A New Day", "Wild Fable", "Universal Thread", "All in Motion",
    "Knox Rose", "Shade & Shore", "Auden", "Xhilaration", "Art Class", "Original Use", "Stars Above",
    "Time and Tru", "Athletic Works", "Wonder Nation", "Garanimals", "Faded Glory", "No Boundaries",
    "Terra & Sky", "Carter's", "OshKosh", "Gerber", "Disney", "Marvel", "Star Wars", "Pokemon",
    "Hello Kitty", "LEGO", "Mattel", "Hasbro", "Barbie", "Hot Wheels", "Fisher-Price", "Nerf", "Play-Doh",
    "Melissa & Doug", "VTech", "LeapFrog", "Little Tikes", "Step2", "Crayola", "Funko", "Spin Master",
    "Paw Patrol", "Hatchimals", "L.O.L. Surprise", "Jakks Pacific", "Bandai", "Magna-Tiles", "Squishmallows",
    "Razor", "L'Oreal", "Maybelline", "CoverGirl", "Neutrogena", "Olay", "Cetaphil", "CeraVe", "Aveeno",
    "Dove", "Nivea", "Garnier", "Pantene", "Head & Shoulders", "Herbal Essences", "Tresemme", "Suave",
    "e.l.f.", "NYX", "Burt's Bees", "Vaseline", "Colgate", "Crest", "Listerine", "Tylenol", "Advil",
    "Band-Aid", "Johnson's", "Huggies", "Pampers", "Luvs", "Kleenex", "Charmin", "Bounty", "Tide", "Downy", "Clorox", "Lysol", "Febreze", "Glade", "Air Wick", "Mrs. Meyer's", "Seventh Generation", "Ziploc", "Hefty", "Reynolds", "Scotch", "Post-it", "Sharpie", "BIC",
    "Paper Mate", "Elmer's", "Five Star", "Mead", "Avery", "Purina", "Pedigree", "Blue Buffalo",
    "Kong", "Armor All", "Meguiar's", "Chemical Guys", "Rain-X", "Graco", "Chicco", "Evenflo",
    "Baby Trend", "Summer Infant", "Munchkin", "Dr. Brown's", "Philips Avent", "Tommee Tippee", "Boppy",
    "Samsonite", "American Tourister", "SwissGear", "JanSport", "Herschel", "Osprey", "Wilson", "Spalding",
    "Rawlings", "Everlast", "Bowflex", "Nautilus", "Schwinn", "Huffy", "Intex", "Bestway",
    // R-396: brands whose first word is common, so the first-word rule could never read them.
    "Brooks Brothers", "Great Value", "Best Choice", "Pioneer Woman", "American Eagle", "American Girl",
    "American Standard", "Dr. Scholl's", "Dr. Teal's", "Mr. Clean", "Simply Orange", "Simple Green",
    "Bath & Body Works", "Bed Bath & Beyond", "Big Lots", "Gold Bond", "Black Diamond", "Red Wing", "Body Glove",
    "Water Pik", "Smart Balance", "Natural Balance", "Gold Toe", "J.Crew", "K-Swiss", "G-Star", "L.L.Bean", "H&M",
    "T-Mobile", "3M", "Victoria's Secret", "Baby Einstein", "Old Spice", "Blue Diamond", "Good Housekeeping",
    "Kirkland Signature", "Member's Mark", "Hey Dude", "On Running", "Salomon", "Altra", "Allbirds", "Mizuno",
    "New Era", "Original Penguin", "Big Agnes", "Little Debbie", "BabyBjorn", "Baby Bjorn", "Case Logic", "Tommy Bahama",
    "Home Depot", "7 For All Mankind", "'47", "Red Bull", "Green Mountain", "Black Rifle Coffee", "Q-Tips", "U-Haul",
    "Y-3", "A.P.C.", "J Brand", "X-Bionic", "Vera Bradley", "Yankee Candle", "Bath Body Works",
];

/// Other names for a brand: sub-brands and spellings that belong to one, so "Air Jordan",
/// "Jumpman" and "Nike Air Jordan" lines all go to Jordan.
const BRAND_ALIASES: &[(&str, &str)] = &[
    ("Air Jordan", "Jordan"), ("Nike Air Jordan", "Jordan"), ("Nike Jordan", "Jordan"), ("Jordan Brand", "Jordan"),
    ("Jumpman", "Jordan"), ("NikeLab", "Nike"), ("NikeCourt", "Nike"), ("Nike SB", "Nike"), ("Nike ACG", "Nike"),
    ("Levi Strauss", "Levi's"), ("TNF", "The North Face"), ("North Face", "The North Face"),
    ("Adidas Originals", "Adidas"), ("Under Armor", "Under Armour"), ("UA", "Under Armour"),
    ("Kitchen Aid", "KitchenAid"), ("Black Decker", "Black+Decker"), ("Black and Decker", "Black+Decker"),
    ("Hoka One One", "HOKA"), ("Dr Martens", "Dr. Martens"), ("Doc Martens", "Dr. Martens"), ("NB", "New Balance"),
];

/// Model and product-line names that say the brand on their own ("Air Max 90", "Samba OG").
const MODEL_BRANDS: &[(&str, &str)] = &[
    ("Air Max", "Nike"), ("Air Force 1", "Nike"), ("AF1", "Nike"), ("Dunk Low", "Nike"), ("Dunk High", "Nike"),
    ("SB Dunk", "Nike"), ("Cortez", "Nike"), ("LeBron", "Nike"), ("Pegasus", "Nike"), ("Vomero", "Nike"),
    ("VaporMax", "Nike"), ("Air Zoom", "Nike"), ("Zoom Fly", "Nike"), ("ReactX", "Nike"), ("Dri-FIT", "Nike"),
    ("Tech Fleece", "Nike"), ("Air Presto", "Nike"), ("Huarache", "Nike"), ("Blazer Mid", "Nike"),
    ("Court Vision", "Nike"), ("Revolution 7", "Nike"), ("Air Jordan 1", "Jordan"), ("Stan Smith", "Adidas"),
    ("Samba OG", "Adidas"), ("Gazelle", "Adidas"), ("Ultraboost", "Adidas"), ("Yeezy", "Adidas"),
    ("Adilette", "Adidas"), ("Superstar", "Adidas"), ("Chuck Taylor", "Converse"), ("Chuck 70", "Converse"),
    ("Old Skool", "Vans"), ("Sk8-Hi", "Vans"), ("Classic Clog", "Crocs"), ("Jibbitz", "Crocs"),
    ("Gel-Kayano", "ASICS"), ("Gel-Nimbus", "ASICS"), ("Clifton", "HOKA"), ("Bondi", "HOKA"),
    ("Quest 5", "Nike"), ("Quest 6", "Nike"), ("A'Two", "Nike"), ("Jordan 1", "Jordan"), ("Jordan 4", "Jordan"),
    ("Jordan 11", "Jordan"), ("AJ1", "Jordan"), ("AJ4", "Jordan"), ("AJ11", "Jordan"), ("Free Run", "Nike"),
    ("Vaporfly", "Nike"), ("Waffle One", "Nike"), ("Waffle Debut", "Nike"), ("Air Trainer", "Nike"), ("Metcon", "Nike"),
    ("Killshot", "Nike"), ("Tanjun", "Nike"), ("Renew Ride", "Nike"), ("Curry 11", "Under Armour"),
    ("HOVR", "Under Armour"), ("RS-X", "Puma"), ("Suede Classic", "Puma"), ("Endorphin", "Saucony"), ("Ghost 16", "Brooks"),
];

/// Known brands that are also ordinary words or names ("Apple Cider Vinegar", "Coach
/// Whistle", "Guess Who?"): read only at the start of a title, never further in.
const WORD_BRANDS: &[&str] = &["apple", "coach", "guess", "shark", "ninja", "jordan", "lee", "fossil", "pioneer",
    "bounty", "crest", "tide", "dove", "brother", "razor", "champion", "columbia", "marshall", "stanley", "wilson",
    "gap", "onn", "amazon", "google", "vans", "puma", "brooks", "keen", "mead", "avery", "kong", "husky", "reef",
    "scotch", "gerber", "bali", "threshold", "casper", "citizen", "glade", "suave", "downy", "marvel", "disney",
    "intex", "igloo", "weber", "worx", "ego", "skil", "hanes", "oster", "revlon", "chi", "oxo", "hp", "lg",
    "salomon", "altra", "mizuno", "ua", "nb", "tnf"];

/// Phrases where a known brand is really something else: "Guess Who", "Shark Tank",
/// "Ninja Turtles", "Jordan Almonds", "Columbia University".
const NOT_BRAND_PHRASES: &[&str] = &["guess who", "shark tank", "ninja turtles", "teenage mutant ninja",
    "jordan almonds", "marshall university", "columbia university", "bounty hunter", "casper the friendly",
    "apple cider", "apple juice", "apple sauce", "applesauce", "big apple", "stanley cup", "baby shark", "lee press on",
    "fossil dig", "fossil kit", "apple pie", "coach whistle", "guess the", "champion spark", "shark bite", "ninja warrior"];

/// The same brand however it was typed: case, punctuation, "&" or "+", "The" in front and
/// Inc/LLC/Brands/"& Co." behind all fall away. "NIKE", "Nike, Inc." and "nike" are one key,
/// and so are "Levi Strauss & Co." and "Levi Strauss".
fn brand_key(s: &str) -> String {
    let words = title_words(s);
    let mut words: Vec<&str> = words.iter().map(|w| w.as_str()).collect();
    if words.len() > 1 && words[0] == "the" {
        words.remove(0);
    }
    loop {
        let n = words.len();
        while words.len() > 1 && BRAND_SUFFIXES.contains(words.last().unwrap()) {
            words.pop();
        }
        while words.len() > 1 && *words.last().unwrap() == "and" {
            words.pop();
        }
        if words.len() == n {
            break;
        }
    }
    words.join(" ")
}

/// Lowercased words, with "&" and "+" read as "and" and apostrophes dropped
/// ("Levi's" is "levis", "L'Oreal" is "loreal").
fn title_words(s: &str) -> Vec<String> {
    let t = s.to_lowercase().replace('&', " and ").replace('+', " and ");
    let cleaned: String = t
        .chars()
        .filter(|c| !matches!(c, '\'' | '\u{2019}' | '®' | '™' | '©'))
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().map(|w| w.to_string()).collect()
}

fn is_no_brand(s: &str) -> bool {
    let words = title_words(s);
    let k = words.join(" ");
    NO_BRAND.contains(&k.as_str()) || (!words.is_empty() && words.iter().all(|w| NO_BRAND_WORDS.contains(&w.as_str())))
}

/// What a brand is shown as: its most common spelling, but not an all-capitals one when
/// the sheet also spells it normally, and the known spelling when it is a known brand.
/// Capitals stay when they are part of the name ("H&M", "AT&T", "GE Appliances").
fn brand_display(spellings: &HashMap<String, usize>, known: &HashMap<String, &'static str>) -> String {
    let mut v: Vec<(&String, &usize)> = spellings.iter().collect();
    v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let Some((top, _)) = v.first() else { return String::new() };
    if let Some(k) = known.get(&brand_key(top)) {
        return k.to_string();
    }
    let shouting = |s: &str| s.chars().any(|c| c.is_alphabetic()) && !s.chars().any(|c| c.is_lowercase());
    let symbols = top.contains('&') || top.chars().any(|c| c.is_ascii_digit());
    if shouting(top) && !symbols {
        if let Some((normal, _)) = v.iter().find(|(s, _)| !shouting(s)) {
            return normal.to_string();
        }
        if top.chars().filter(|c| c.is_alphabetic()).count() > 4 {
            return top
                .split_whitespace()
                .map(|w| {
                    // Short words stay capitals: they are initials ("GE", "LG", "JVC").
                    let letters = w.chars().filter(|c| c.is_alphabetic()).count();
                    let vowels = w.chars().filter(|c| "AEIOUaeiou".contains(*c)).count();
                    if (letters <= 3 || vowels == 0) && !matches!(w.to_lowercase().as_str(), "and" | "the" | "of" | "for" | "co") {
                        return w.to_string();
                    }
                    let mut c = w.chars();
                    match c.next() {
                        Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
        }
    }
    top.to_string()
}

/// The key the analyzer's breakdown groups a brand by, the same one the split folds
/// spellings with (R-386), so "NIKE", "Nike" and "Nike, Inc." are one row in both. None
/// when the value means no brand ("N/A", "Generic", blank).
pub(crate) fn brand_group_key(raw: &str) -> Option<String> {
    if is_no_brand(raw) { None } else { Some(brand_key(raw)) }
}

/// The name a folded brand is shown by: the split's choice, from how often each spelling
/// appeared.
pub(crate) fn brand_group_name(spellings: &HashMap<String, usize>) -> String {
    let known: HashMap<String, &'static str> = KNOWN_BRANDS.iter().map(|b| (brand_key(b), *b)).collect();
    brand_display(spellings, &known)
}

/// R-402: the brand each title names, read the way the split reads a line with no brand
/// column, from the known brands, aliases and model names only (a brand guessed from a first
/// word needs a whole sheet to count). One dictionary for all the titles. Used by
/// `deal_label.rs` on a deal's invoice lines.
pub(crate) fn brands_in_titles(titles: &[String]) -> Vec<Option<String>> {
    let lines: Vec<Line> = titles
        .iter()
        .enumerate()
        .map(|(i, t)| Line {
            row: i,
            desc: t.clone(),
            alt: String::new(),
            qty: 1.0,
            retail: 0.0,
            sheet: None,
            category: String::new(),
            brand_raw: String::new(),
            photo: false,
        })
        .collect();
    let all: Vec<usize> = (0..lines.len()).collect();
    let mut found = brands_from_titles(&lines, &all, false);
    (0..lines.len()).map(|i| found.remove(&i)).collect()
}

/// Synonyms a category key folds to: "Footwear" and "Shoes" are one category, as are
/// "Apparel", "Clothes" and "Clothing".
const CATEGORY_SYNONYMS: &[(&str, &str)] = &[("footwear", "shoe"), ("sneaker", "shoe"), ("apparel", "clothing"),
    ("clothe", "clothing"), ("clothes", "clothing"), ("garment", "clothing")];

/// The key a category is grouped by: case, punctuation, "&"/"and", spacing and plurals fall
/// away, so "Home & Kitchen" and "home and kitchen", "Toys/Games" and "Toys & Games",
/// "Shoe" and "Shoes", "Home Goods" and "HomeGoods" are one category each.
pub(crate) fn category_group_key(raw: &str) -> String {
    title_words(raw)
        .iter()
        .filter(|w| w.as_str() != "and")
        .map(|w| {
            let mut s = if w.len() > 4 && w.ends_with("ies") {
                format!("{}y", &w[..w.len() - 3])
            } else if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
                w[..w.len() - 1].to_string()
            } else {
                w.clone()
            };
            if let Some((_, to)) = CATEGORY_SYNONYMS.iter().find(|(from, _)| *from == s || *from == w.as_str()) {
                s = to.to_string();
            }
            s
        })
        .collect::<Vec<_>>()
        .join("")
}

/// The name a folded category is shown by: its most common spelling, and on a tie the
/// one that sorts first.
pub(crate) fn category_group_name(spellings: &HashMap<String, usize>) -> String {
    spellings.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(s, _)| s.clone()).unwrap_or_default()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Two brand keys that are probably one brand typed two ways.
fn look_alike(a: &str, b: &str) -> bool {
    let (na, nb) = (a.replace(' ', ""), b.replace(' ', ""));
    if na == nb {
        return true;
    }
    // A plural of a short name: "Nikes", "Hokas", "Vans" and "Van"; a letter doubled or
    // dropped: "Nikee".
    if na.len().min(nb.len()) >= 3 && (format!("{}s", na) == nb || format!("{}s", nb) == na) {
        return true;
    }
    let dropped = |long: &str, short: &str| {
        long.len() == short.len() + 1
            && (0..long.len()).any(|i| long.is_char_boundary(i) && long.is_char_boundary(i + 1) && format!("{}{}", &long[..i], &long[i + 1..]) == short)
    };
    if na.len().min(nb.len()) >= 3 && (dropped(&na, &nb) || dropped(&nb, &na)) {
        return true;
    }
    let short = na.len().min(nb.len());
    if (short >= 5 && levenshtein(&na, &nb) <= 1) || (short >= 9 && levenshtein(&na, &nb) <= 2) {
        return true;
    }
    // "hamilton" and "hamilton beach": the shorter is the start of the longer, word for word.
    let (wa, wb): (Vec<&str>, Vec<&str>) = (a.split(' ').collect(), b.split(' ').collect());
    let (s, l) = if wa.len() <= wb.len() { (&wa, &wb) } else { (&wb, &wa) };
    s.len() < l.len() && s.join(" ").len() >= 4 && l.starts_with(s)
}

/// Brands read from the titles of lines that have none (R-396). Returns, per line index,
/// the brand's display spelling. A known brand, alias or model name is found anywhere in
/// the first words of a title (a brand that is also an ordinary word only at its start);
/// otherwise a first word that opens enough titles is taken as an unknown brand.
fn brands_from_titles(lines: &[Line], missing: &[usize], guess_unknown: bool) -> HashMap<usize, String> {
    // Dictionary: brands the sheet itself names, then the known list, aliases and models.
    // Keyed by their words; longest first so "Hamilton Beach" beats "Hamilton".
    let mut dict: Vec<(Vec<String>, String)> = Vec::new();
    let mut seen = HashSet::new();
    for l in lines {
        if !is_no_brand(&l.brand_raw) {
            let k = brand_key(&l.brand_raw);
            if seen.insert(k.clone()) {
                dict.push((k.split(' ').map(|w| w.to_string()).collect(), l.brand_raw.clone()));
            }
        }
    }
    for b in KNOWN_BRANDS {
        let k = brand_key(b);
        if seen.insert(k.clone()) {
            dict.push((k.split(' ').map(|w| w.to_string()).collect(), b.to_string()));
        }
        // The sheet may spell a known brand with a suffix ("Adidas, Inc."): its own
        // spelling was added above, so add the bare words too.
        let words = title_words(b);
        if words.join(" ") != k && seen.insert(words.join(" ")) {
            dict.push((words, b.to_string()));
        }
    }
    for (alias, brand) in BRAND_ALIASES.iter().chain(MODEL_BRANDS.iter()) {
        let words = title_words(alias);
        if seen.insert(words.join(" ")) {
            dict.push((words, brand.to_string()));
        }
    }
    dict.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    let stop: Vec<Vec<String>> = NOT_BRAND_PHRASES.iter().map(|p| title_words(p)).collect();
    let is_code = |w: &str| {
        (w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(|c| c.is_alphabetic())) || w.chars().all(|c| c.is_ascii_digit())
    };
    let skippable = |w: &str| LEAD_WORDS.contains(&w) || SPEC_WORDS.contains(&w) || is_code(w);

    let mut inferred: HashMap<usize, String> = HashMap::new();
    // First words of titles no dictionary entry explained: (count, spellings, next words).
    let mut first_words: HashMap<String, (usize, HashMap<String, usize>, HashMap<String, usize>)> = HashMap::new();
    let mut pending: Vec<(usize, String, Option<String>)> = Vec::new();
    for &i in missing {
        let all = title_words(&lines[i].desc);
        // What follows "for" or "with" describes something else ("Case for Apple iPhone").
        let cut = all.iter().position(|w| matches!(w.as_str(), "for" | "with" | "compatible" | "fits")).unwrap_or(all.len());
        let words = &all[..cut];
        let mut p = 0;
        while p < words.len().min(6) && skippable(&words[p]) {
            p += 1;
        }
        // A dictionary brand: at the first real word (or a skipped word that starts one,
        // "New Balance", "The North Face", "3M"), else further in unless it is also an
        // ordinary word. "by Nike" always counts.
        let at = |q: usize| -> Option<&(Vec<String>, String)> {
            if stop.iter().any(|s| words[q..].starts_with(s)) {
                return None;
            }
            dict.iter().find(|(w, _)| !w.is_empty() && words[q..].starts_with(w))
        };
        let found = (0..=p.min(words.len().saturating_sub(1)))
            .find_map(|q| at(q))
            .or_else(|| {
                (p + 1..words.len().min(8)).find_map(|q| {
                    at(q).filter(|(w, _)| q > 0 && (words[q - 1] == "by" || !(w.len() == 1 && WORD_BRANDS.contains(&w[0].as_str()))))
                })
            })
            .or_else(|| {
                all.iter().position(|w| w == "by").and_then(|q| if q + 1 < all.len() { dict.iter().find(|(w, _)| all[q + 1..].starts_with(w)) } else { None })
            });
        if let Some((_, name)) = found {
            inferred.insert(i, name.clone());
            continue;
        }
        if !guess_unknown || p >= words.len() {
            continue;
        }
        let w = &words[p];
        if w.chars().count() < 2
            || !w.chars().any(|c| c.is_alphabetic())
            || NOT_BRANDS.contains(&w.as_str())
            || manifest_category::is_product_word(w)
        {
            continue;
        }
        // The original spelling, cut at a hyphen or slash ("Zara-Basic" is Zara).
        let orig = lines[i]
            .desc
            .split_whitespace()
            .find(|o| title_words(o).first().map_or(false, |x| x == w))
            .unwrap_or(w)
            .split(['-', '/', ':'])
            .find(|s| !s.is_empty())
            .unwrap_or(w)
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_string();
        let next = words.get(p + 1).cloned();
        let e = first_words.entry(w.clone()).or_insert((0, HashMap::new(), HashMap::new()));
        e.0 += 1;
        *e.1.entry(orig).or_insert(0) += 1;
        if let Some(n) = &next {
            *e.2.entry(n.clone()).or_insert(0) += 1;
        }
        pending.push((i, w.clone(), next));
    }
    let floor = 3usize.max(lines.len() / 200).min(5);
    // Titles such as "Dr. Scholl's" or "La Roche-Posay" need their second word.
    const JOINERS: &[&str] = &["dr", "mr", "mrs", "ms", "st", "la", "le", "el", "de", "du", "van", "von", "mc", "o", "saint"];
    const SHARED_FIRST: &[&str] = &["american", "simply", "great", "best", "good", "true", "pure", "royal", "golden", "happy",
        "first", "north", "south", "east", "west", "united", "global", "general"];
    let known: HashMap<String, &'static str> = KNOWN_BRANDS.iter().map(|b| (brand_key(b), *b)).collect();
    for (i, w, next) in pending {
        let Some((n, spellings, nexts)) = first_words.get(&w) else { continue };
        if *n < floor {
            continue;
        }
        // One first word shared by several brands ("American Eagle", "American Girl"):
        // each continuation with enough lines of its own is its own brand. Only for words
        // that start brand names; a brand's own product words never make new brands
        // ("Vezzi Duffel", "Vezzi Tote" are Vezzi).
        let shared = SHARED_FIRST.contains(&w.as_str())
            && nexts.iter().filter(|(nx, c)| **c >= floor && !manifest_category::is_product_word(nx) && !NOT_BRANDS.contains(&nx.as_str())).count() >= 2;
        let join = JOINERS.contains(&w.as_str()) || shared;
        let name = brand_display(spellings, &known);
        match (join, next) {
            (true, Some(nx))
                if (nexts.get(&nx).copied().unwrap_or(0) >= floor && !manifest_category::is_product_word(&nx))
                    || JOINERS.contains(&w.as_str()) =>
            {
                let second = lines[i]
                    .desc
                    .split_whitespace()
                    .map(|o| o.trim_matches(|c: char| !c.is_alphanumeric()))
                    .find(|o| title_words(o).first().map_or(false, |x| *x == nx))
                    .unwrap_or(&nx)
                    .to_string();
                inferred.insert(i, format!("{} {}", name, second));
            }
            (true, _) if shared => {}
            _ => {
                inferred.insert(i, name);
            }
        }
    }
    inferred
}

// ── Pricing on the sheet ────────────────────────────────────────────────────

/// The value most of `vals` share, within `tol`, when at least 80% of them do.
fn common_value(vals: &[f64], tol: f64) -> Option<(f64, usize)> {
    if vals.is_empty() {
        return None;
    }
    let mut s = vals.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = s[s.len() / 2];
    let near = s.iter().filter(|v| (*v - median).abs() <= tol).count();
    if near * 5 >= s.len() * 4 { Some((median, near)) } else { None }
}

fn detect_pricing(t: &Table, c: &Cols, lines: &[Line], footers: &[String]) -> SheetPricing {
    let header = |j: Option<usize>| j.map(|j| t.headers[j].trim().to_string()).unwrap_or_default();
    let priced: Vec<&Line> = lines.iter().filter(|l| l.sheet.is_some()).collect();
    let total = if priced.is_empty() { None } else { Some(round2(priced.iter().filter_map(|l| l.sheet).sum())) };
    let pricing = |kind: &str, pct: Option<f64>, unit: Option<f64>, evidence: String| SheetPricing {
        kind: kind.into(), pct, unit, evidence, total,
    };

    if !priced.is_empty() {
        let sheet_total = total.unwrap_or(0.0);
        // A flat rule is only the sheet's pricing when it reproduces the sheet's own total;
        // a flat 10% over lines some of which are priced at 25% would sell those below
        // what they cost.
        let reproduces = |modelled: f64| sheet_total <= 0.0 || (modelled - sheet_total).abs() <= 0.02 * sheet_total;
        // A % of retail: the sheet's own % column, or its price over its retail.
        let ratios: Vec<f64> = priced.iter().filter(|l| l.retail > 0.0).map(|l| l.sheet.unwrap() / l.retail).collect();
        let pct_fit = common_value(&ratios, 0.0025).filter(|(r, _)| reproduces(priced.iter().map(|l| l.retail * r).sum()));
        let unit_fit = common_value(&priced.iter().map(|l| l.sheet.unwrap() / l.qty).collect::<Vec<_>>(), 0.005)
            .filter(|(u, _)| reproduces(priced.iter().map(|l| l.qty * u).sum()));
        if ratios.len() * 2 >= priced.len() {
            if let Some((r, n)) = pct_fit {
                let pct = (r * 1000.0).round() / 10.0;
                // Compare like with like: a unit cost against a unit retail, a line total
                // against a line total.
                let (sale, retail) = match (c.sale_unit, c.sale_ext) {
                    (Some(u), _) if c.retail_unit.is_some() => (Some(u), c.retail_unit),
                    (_, Some(e)) if c.retail_ext.is_some() => (Some(e), c.retail_ext),
                    (u, e) => (u.or(e), c.retail_unit.or(c.retail_ext)),
                };
                let how = match c.pct {
                    Some(j) => format!("the {} column reads {}%", header(Some(j)), fmt_pct(pct)),
                    None => format!("{} is {}% of {}", header(sale), fmt_pct(pct), header(retail)),
                };
                return pricing("pct", Some(pct), None, format!("{} on {} of {} lines", how, n, priced.len()));
            }
        }
        // One price for every unit.
        if let Some((u, n)) = unit_fit {
            let u = round2(u);
            return pricing(
                "unit",
                None,
                Some(u),
                format!("{} is {} a unit on {} of {} lines", header(c.sale_unit.or(c.sale_ext)), fmt_money(u), n, priced.len()),
            );
        }
        let retail: f64 = priced.iter().map(|l| l.retail).sum();
        let overall = if retail > 0.0 { format!(", {}% of retail overall", fmt_pct(total.unwrap_or(0.0) / retail * 100.0)) } else { String::new() };
        return pricing(
            "line",
            None,
            None,
            format!("each line has its own price in {} ({} in all{}), so no single % or unit price fits", header(c.sale_ext.or(c.sale_unit).or(c.pct)), fmt_money(total.unwrap_or(0.0)), overall),
        );
    }

    // No price column: a note above the header ("15% of retail", "$4.50 per unit").
    // The number starts at a word boundary ("100% of retail" is not "00%"), and a rule of
    // 100% or more is not a price. "15 percent of retail" reads too.
    let pct_re = regex::Regex::new(r"(?i)(?:^|[^\d.])(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent)\s*(?:of\s+)?(?:the\s+)?(?:retail|msrp|ext|value|srp)|@\s*(\d{1,3}(?:\.\d{1,2})?)\s*%").unwrap();
    let unit_re = regex::Regex::new(r"(?i)\$\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:(?:/|per|a)\s*(?:unit|pc|pcs|piece|item|pair|ea|each)\b|(?:each|ea)\b)").unwrap();
    let mut notes: Vec<(String, String)> = t.above.iter().map(|(r, s)| (format!("row {}", r), s.clone())).collect();
    notes.extend(footers.iter().map(|f| ("a note below the lines".to_string(), f.clone())));
    if let Some(s) = &t.sheet {
        notes.push(("the sheet's name".into(), s.clone()));
    }
    notes.push(("the file's name".into(), t.file_name.clone()));
    for (where_, text) in &notes {
        if let Some(m) = pct_re.captures(text) {
            if let Some(p) = m.get(1).or(m.get(2)).and_then(|g| g.as_str().parse::<f64>().ok()).filter(|p| *p > 0.0 && *p < 100.0) {
                return pricing("pct", Some(p), None, format!("{} says \"{}\"", where_, m.get(0).unwrap().as_str().trim()));
            }
        }
        if let Some(m) = unit_re.captures(text) {
            if let Some(u) = m.get(1).and_then(|g| g.as_str().parse::<f64>().ok()) {
                return pricing("unit", None, Some(u), format!("{} says \"{}\"", where_, m.get(0).unwrap().as_str().trim()));
            }
        }
    }
    pricing("none", None, None, "the sheet shows retail only, with no price on it".into())
}

// ── Formatting for questions ────────────────────────────────────────────────

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn group_thousands(s: &str) -> String {
    let (int, frac) = match s.find('.') {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    };
    let neg = int.starts_with('-');
    let digits: Vec<char> = int.trim_start_matches('-').chars().collect();
    let mut out = String::new();
    for (i, c) in digits.iter().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*c);
    }
    format!("{}{}{}", if neg { "-" } else { "" }, out, frac)
}

fn fmt_money(v: f64) -> String {
    format!("${}", group_thousands(&format!("{:.2}", v)))
}

fn fmt_int(v: f64) -> String {
    group_thousands(&format!("{}", v.round() as i64))
}

fn fmt_pct(v: f64) -> String {
    let r = (v * 10.0).round() / 10.0;
    if r.fract() == 0.0 { format!("{}", r as i64) } else { format!("{:.1}", r) }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", fmt_int(n as f64), if n == 1 { one } else { many })
}

fn list_names(names: &[String]) -> String {
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        _ => format!("{} and {}", names[..names.len() - 1].join(", "), names[names.len() - 1]),
    }
}

// ── The plan ────────────────────────────────────────────────────────────────

struct Ask<'a> {
    answers: &'a HashMap<String, String>,
    questions: Vec<Question>,
}

impl<'a> Ask<'a> {
    /// Put a question, and return the answer in force (Jack's if he gave one that is
    /// still a choice, else the suggestion).
    fn ask(&mut self, id: &str, text: String, detail: Option<String>, choices: Vec<Choice>, suggested: &str) -> String {
        let given = self.answers.get(id).filter(|a| choices.iter().any(|c| &c.id == *a)).cloned();
        let answer = given.clone().unwrap_or_else(|| suggested.to_string());
        self.questions.push(Question { id: id.into(), text, detail, choices, answer: answer.clone(), answered: given.is_some(), value: None });
        answer
    }
}

fn choice(id: &str, label: impl Into<String>) -> Choice {
    Choice { id: id.into(), label: label.into(), input: None }
}

struct Group {
    key: String,
    name: String,
    idx: Vec<usize>,
}

/// Everything a plan, a line list and an export share.
struct State {
    t: Arc<Table>,
    cols: Cols,
    lines: Vec<Line>,
    groups: Vec<Group>,
    skipped: HashSet<String>,
    rules: HashMap<String, PriceRule>,
    line_prices: HashMap<usize, f64>,
    hidden: HashSet<usize>,
    show_price: bool,
    sheet_is_cost: bool,
    categories: Vec<String>,
    plan: SplitPlan,
}

fn price_of(l: &Line, rule: &PriceRule, override_unit: Option<f64>) -> Option<(f64, f64)> {
    if let Some(u) = override_unit {
        return Some((u, round2(u * l.qty)));
    }
    let ext = match (rule.mode.as_str(), rule.value) {
        // A line with no retail has no % of retail: it is unpriced, not $0.
        ("pct", Some(p)) if l.retail > 0.0 => round2(l.retail * p / 100.0),
        ("unit", Some(u)) => round2(u * l.qty),
        ("sheet", _) => round2(l.sheet?),
        _ => return None,
    };
    Some((round2(ext / l.qty), ext))
}

/// The lines of a manifest with their brand and category settled: everything the split
/// and the analyzer's breakdown share (R-396), so the two screens read one file one way.
struct Prepared {
    t: Arc<Table>,
    cols: Cols,
    lines: Vec<Line>,
    /// Per line: the brand as (key, name) after merges; None for no brand.
    brands: Vec<Option<(String, String)>>,
    /// Per line: the category as (key, name); None for none.
    cats: Vec<Option<(String, String)>>,
    /// Per line: whether its category was guessed from the title.
    guessed: Vec<bool>,
    /// Lines whose brand was read from the title.
    brands_read: usize,
    /// The note that says what was left out, for the analyzer's read-out.
    left_out: Option<String>,
    /// Text of the rows left out below the lines (a footer can state the pricing).
    footers: Vec<String>,
}

fn prepare(path: &str, ask: &mut Ask, notes: &mut Vec<String>) -> Result<Prepared> {
    let first = table(path, ask.answers.get("sheet").map(|s| s.as_str()))?;

    // Which sheet. Sheets that share a header (a pallet a sheet) can be read as one, and
    // that is the suggestion when the best sheet is one of them.
    let t = if first.sheets.len() > 1 {
        let together = first.same_header.len() >= 2 && first.sheet.as_ref().map_or(false, |s| first.same_header.contains(s));
        let best = if together { ALL_SHEETS.to_string() } else { first.sheet.clone().unwrap_or_default() };
        let mut choices: Vec<Choice> = first.sheets.iter().map(|(s, n)| choice(s, format!("{} ({})", s, plural(*n, "row", "rows")))).collect();
        if first.same_header.len() >= 2 {
            choices.insert(0, choice(ALL_SHEETS, format!("All {} together (the same columns)", plural(first.same_header.len(), "sheet", "sheets"))));
        }
        let pick = ask.ask(
            "sheet",
            format!("This file has {} sheets with rows on them. Which one is the manifest?", first.sheets.len()),
            None,
            choices,
            &best,
        );
        if first.sheet.as_deref() == Some(pick.as_str()) { first } else { table(path, Some(&pick))? }
    } else {
        first
    };
    notes.extend(t.notes.iter().cloned());

    // A lone "Price" column: retail, or this load's price?
    let probe = detect_cols(&t, "retail")?;
    let price_role = match probe.ambiguous {
        Some(j) => ask.ask(
            "price_role",
            format!("Is \"{}\" the retail value of each item, or what each item costs on this load?", t.headers[j].trim()),
            Some("The sheet has no column that says retail or MSRP.".into()),
            vec![choice("retail", "Retail value"), choice("load", "Price on this load")],
            "retail",
        ),
        None => "retail".into(),
    };
    let mut cols = detect_cols(&t, &price_role)?;
    let read = build_lines(&t, &cols);
    let mut lines = read.lines;
    if lines.is_empty() {
        bail!("Read the columns but found no product lines in this file.");
    }
    // A "price" that adds up to more than the retail is not this load's price: a rank, a
    // weight or a code that happened to be numbers.
    let retail_sum: f64 = lines.iter().map(|l| l.retail).sum();
    let sheet_sum: f64 = lines.iter().filter_map(|l| l.sheet).sum();
    if retail_sum > 0.0 && sheet_sum > 1.05 * retail_sum {
        let named: Vec<String> = [cols.sale_unit, cols.sale_ext, cols.pct].iter().flatten().map(|&j| t.headers[j].trim().to_string()).collect();
        notes.push(format!(
            "{} adds up to {} against {} of retail, so it is not read as a price.",
            list_names(&named),
            fmt_money(sheet_sum),
            fmt_money(retail_sum)
        ));
        cols.sale_unit = None;
        cols.sale_ext = None;
        cols.pct = None;
        for l in lines.iter_mut() {
            l.sheet = None;
        }
    }

    // Hidden rows: filtered out on the sheet, usually sold or set aside.
    let hidden: Vec<usize> = (0..lines.len()).filter(|&i| t.images.hidden_rows.contains(&t.abs_rows[lines[i].row])).collect();
    if !hidden.is_empty() && hidden.len() < lines.len() {
        let units: f64 = hidden.iter().map(|&i| lines[i].qty).sum();
        let a = ask.ask(
            "hidden_rows",
            format!("{} hidden on the sheet ({} units). Leave them out?", plural(hidden.len(), "line is", "lines are"), fmt_int(units)),
            Some("Rows hidden or filtered out in Excel are usually sold or set aside.".into()),
            vec![choice("out", "Leave them out"), choice("in", "Keep them")],
            "out",
        );
        if a == "out" {
            notes.push(format!("Left out {} hidden on the sheet ({} units).", plural(hidden.len(), "line", "lines"), fmt_int(units)));
            let gone: HashSet<usize> = hidden.into_iter().collect();
            lines = lines.into_iter().enumerate().filter(|(i, _)| !gone.contains(i)).map(|(_, l)| l).collect();
        }
    }

    // What was left out, and why, so a dropped line is never silent.
    let mut why = Vec::new();
    if !read.summary.is_empty() {
        let labels: Vec<String> = read.summary.iter().take(3).map(|s| format!("\"{}\"", s.trim())).collect();
        why.push(format!("{} ({})", plural(read.summary.len(), "total row", "total rows"), labels.join(", ")));
    }
    if read.repeated_headers > 0 {
        why.push(plural(read.repeated_headers, "repeated header row", "repeated header rows"));
    }
    if !read.separators.is_empty() {
        let labels: Vec<String> = read.separators.iter().take(3).map(|s| format!("\"{}\"", s.trim())).collect();
        why.push(format!("{} with a label and no quantity or price ({})", plural(read.separators.len(), "row", "rows"), labels.join(", ")));
    }
    if read.zero_qty > 0 {
        why.push(format!("{} with a quantity of 0 or less", plural(read.zero_qty, "line", "lines")));
    }
    let left_out = if why.is_empty() { None } else { Some(format!("Left out {}.", list_names(&why))) };
    if let Some(n) = &left_out {
        notes.push(n.clone());
    }
    if read.unnamed > 0 {
        notes.push(format!(
            "{} had no description, so {} named by {} UPC or SKU where the sheet has one, else by row.",
            plural(read.unnamed, "line", "lines"),
            if read.unnamed == 1 { "it is" } else { "they are" },
            if read.unnamed == 1 { "its" } else { "their" }
        ));
    }
    if read.qty_from_amounts > 0 {
        notes.push(format!("{} had a quantity that could not be read, so it was worked out from the amounts.", plural(read.qty_from_amounts, "line", "lines")));
    }
    if read.qty_blank > 0 {
        notes.push(format!("{} no quantity and count as 1 unit each. Check them.", plural(read.qty_blank, "line has", "lines have")));
    }
    if !cols.size_cols.is_empty() {
        let first = t.headers[cols.size_cols[0]].trim();
        let last = t.headers[*cols.size_cols.last().unwrap()].trim();
        notes.push(format!("There is no quantity column, so each line's units are the sum of its size columns ({} to {}).", first, last));
    }
    if read.qty_assumed > 0 {
        notes.push(format!("{} had no readable quantity and count as 1 unit each. Check them.", plural(read.qty_assumed, "line", "lines")));
    }
    if let Some((d, q, pr)) = t.inferred {
        let col = |i: usize| format!("column {}", i + 1);
        notes.insert(0, format!(
            "No header row, so the columns were worked out from the data (description: {}, quantity: {}, price: {}). Check the totals against the file.",
            col(d),
            q.map(col).unwrap_or_else(|| "none, 1 per line".into()),
            col(pr)
        ));
    }
    if cols.qty.is_none() && cols.size_cols.is_empty() && t.inferred.is_none() {
        notes.push("There is no quantity column, so every line counts as 1 unit.".into());
    }
    if !cols.other_qty.is_empty() {
        let q = cols.qty.map(|j| t.headers[j].trim().to_string()).unwrap_or_default();
        let others: Vec<String> = cols.other_qty.iter().map(|&j| t.headers[j].trim().to_string()).collect();
        notes.push(format!("Quantities come from {}, not {}.", q, list_names(&others)));
    }
    let no_retail = lines.iter().filter(|l| l.retail <= 0.0).count();
    if no_retail == lines.len() {
        let priced: Vec<String> = [cols.sale_unit, cols.sale_ext, cols.pct].iter().flatten().map(|&j| t.headers[j].trim().to_string()).collect();
        notes.insert(0, if priced.is_empty() {
            "No line has a retail value: no column was read as retail or a price. Check the column names.".into()
        } else {
            format!("There is no retail column: {} reads as your cost or this load's price, not retail, so no retail is shown.", list_names(&priced))
        });
    }
    if no_retail > 0 && no_retail < lines.len() {
        let units: f64 = lines.iter().filter(|l| l.retail <= 0.0).map(|l| l.qty).sum();
        notes.push(format!(
            "{} no retail value ({} units). {} kept at $0 and left unpriced.",
            plural(no_retail, "line has", "lines have"),
            fmt_int(units),
            if no_retail == 1 { "It is" } else { "They are" }
        ));
    }
    if !read.ext_mismatch.is_empty() {
        let gap: f64 = read.ext_mismatch.iter().map(|(_, a, b)| b - a).sum();
        let worst = read.ext_mismatch.iter().max_by(|a, b| (a.2 - a.1).abs().partial_cmp(&(b.2 - b.1).abs()).unwrap_or(std::cmp::Ordering::Equal)).unwrap();
        let unit_h = cols.retail_unit.map(|j| t.headers[j].trim().to_string()).unwrap_or_default();
        let ext_h = cols.retail_ext.map(|j| t.headers[j].trim().to_string()).unwrap_or_default();
        notes.push(format!(
            "On {} the sheet's {} is not {} x quantity ({} {} in all; the biggest is row {}: {} against {}). Retail here is {} x quantity.",
            plural(read.ext_mismatch.len(), "line", "lines"),
            ext_h,
            unit_h,
            if gap >= 0.0 { "adding" } else { "taking away" },
            fmt_money(gap.abs()),
            worst.0,
            fmt_money(worst.2),
            fmt_money(worst.1),
            unit_h
        ));
    }
    if let Some((units, retail)) = read.stated_total {
        let (u, r): (f64, f64) = (lines.iter().map(|l| l.qty).sum(), lines.iter().map(|l| l.retail).sum());
        let off_u = units.map_or(false, |x| (x - u).abs() > 0.5);
        let off_r = retail.map_or(false, |x| (x - r).abs() > 1.0f64.max(0.0005 * r));
        if off_u || off_r {
            let mut says = Vec::new();
            if let Some(x) = units.filter(|_| off_u) {
                says.push(format!("{} units", fmt_int(x)));
            }
            if let Some(x) = retail.filter(|_| off_r) {
                says.push(fmt_money(x));
            }
            notes.push(format!("The sheet's own total row says {}; its lines add up to {} units and {}.", says.join(" and "), fmt_int(u), fmt_money(r)));
        }
    }
    // The same title and code on several lines: kept apart, but said.
    let code_col = (0..t.headers.len()).find(|&j| hhas(&hwords(&t.headers[j]), &["upc", "sku", "style", "asin", "ean", "item #", "model"]));
    let mut seen_pairs: HashSet<(String, String)> = HashSet::new();
    let (mut repeats, mut rep_units) = (0usize, 0.0f64);
    for l in &lines {
        let code = code_col.map(|j| t.rows[l.row][j].text()).unwrap_or_default();
        if !seen_pairs.insert((l.desc.trim().to_lowercase(), code)) {
            repeats += 1;
            rep_units += l.qty;
        }
    }
    if repeats > 0 && code_col.is_some() {
        notes.push(format!("{} the same title and {} as a line above ({} units). Each is kept as its own line.", plural(repeats, "line repeats", "lines repeat"), t.headers[code_col.unwrap()].trim(), fmt_int(rep_units)));
    }

    let known: HashMap<String, &'static str> = KNOWN_BRANDS.iter().map(|b| (brand_key(b), *b)).collect();
    let aliases: HashMap<String, &'static str> = BRAND_ALIASES.iter().map(|(a, b)| (brand_key(a), *b)).collect();
    for l in lines.iter_mut() {
        if let Some(canon) = aliases.get(&brand_key(&l.brand_raw)) {
            l.brand_raw = canon.to_string();
        }
    }

    // Brands missing from lines: read them from the titles? Known brands, their aliases and
    // model names are always looked for; an unknown first word only when many lines lack
    // a brand.
    let missing: Vec<usize> = (0..lines.len()).filter(|&i| is_no_brand(&lines[i].brand_raw)).collect();
    let mut inferred = if missing.is_empty() { HashMap::new() } else { brands_from_titles(&lines, &missing, missing.len() * 10 >= lines.len()) };
    // A title that says nothing: try the other text column.
    if cols.alt_text.is_some() {
        let still: Vec<usize> = missing.iter().copied().filter(|i| !inferred.contains_key(i)).collect();
        if !still.is_empty() {
            let swapped: Vec<Line> = lines.iter().map(|l| Line { desc: l.alt.clone(), ..l.clone() }).collect();
            for (i, b) in brands_from_titles(&swapped, &still, false) {
                inferred.insert(i, b);
            }
        }
    }
    let brands_read = inferred.len();
    if !inferred.is_empty() {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for b in inferred.values() {
            *counts.entry(brand_key(b)).or_insert(0) += 1;
        }
        let mut top: Vec<(String, usize)> = counts.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let example: Vec<String> = top
            .iter()
            .take(3)
            .filter_map(|(k, _)| inferred.values().find(|b| &brand_key(b) == k).cloned())
            .collect();
        let brands_found = top.len();
        let left = missing.len() - inferred.len();
        let lead = if let Some(b) = cols.brand {
            format!("{} have no brand in the {} column.", plural(missing.len(), "line", "lines"), t.headers[b].trim())
        } else {
            format!("There is no brand column, so {} have no brand.", plural(missing.len(), "line", "lines"))
        };
        let a = ask.ask(
            "read_brands",
            format!("{} Read the brand from each title?", lead),
            Some(format!(
                "That finds {} for {} of them, such as {}.{}",
                plural(brands_found, "brand", "brands"),
                fmt_int(inferred.len() as f64),
                list_names(&example),
                if left > 0 { format!(" The other {} unbranded.", if left == 1 { "1 stays".to_string() } else { format!("{} stay", fmt_int(left as f64)) }) } else { String::new() }
            )),
            vec![choice("yes", "Yes, read them"), choice("no", "No, leave them unbranded")],
            "yes",
        );
        if a == "no" {
            inferred.clear();
        }
    }
    for (i, b) in &inferred {
        lines[*i].brand_raw = b.clone();
    }

    // Brand groups: one per key, the display chosen from how the sheet spells it.
    let mut spell: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for l in &lines {
        if !is_no_brand(&l.brand_raw) {
            *spell.entry(brand_key(&l.brand_raw)).or_default().entry(l.brand_raw.clone()).or_insert(0) += 1;
        }
    }
    let mut folded: Vec<String> = Vec::new();
    for sp in spell.values() {
        if sp.len() > 1 {
            let mut v: Vec<&String> = sp.keys().collect();
            v.sort();
            folded.push(format!("{} ({})", brand_display(sp, &known), v.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" / ")));
        }
    }
    if !folded.is_empty() {
        folded.sort();
        let more = folded.len().saturating_sub(3);
        folded.truncate(3);
        notes.push(format!(
            "Read as one brand each, however the sheet spelled it: {}{}.",
            folded.join("; "),
            if more > 0 { format!("; and {} more", more) } else { String::new() }
        ));
    }

    // Look-alike brands: ask, biggest first, at most twelve. Two real brands ("Shark" and
    // "Sharp", both known or both sizeable) default to apart; a stray spelling of a much
    // bigger brand ("Carhart" beside "Carhartt") defaults to together.
    let mut brand_lines: HashMap<String, usize> = HashMap::new();
    for l in &lines {
        if !is_no_brand(&l.brand_raw) {
            *brand_lines.entry(brand_key(&l.brand_raw)).or_insert(0) += 1;
        }
    }
    let mut keys: Vec<(String, usize)> = brand_lines.iter().map(|(k, n)| (k.clone(), *n)).collect();
    keys.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    keys.truncate(300);
    let mut pairs: Vec<(String, String, usize)> = Vec::new();
    for i in 0..keys.len() {
        for j in (i + 1)..keys.len() {
            if look_alike(&keys[i].0, &keys[j].0) {
                pairs.push((keys[i].0.clone(), keys[j].0.clone(), keys[i].1 + keys[j].1));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    let display_of = |k: &str| brand_display(&spell[k], &known);
    let mut parent: HashMap<String, String> = HashMap::new();
    fn root(parent: &HashMap<String, String>, k: &str) -> String {
        let mut k = k.to_string();
        let mut guard = 0;
        while let Some(p) = parent.get(&k) {
            if *p == k || guard > 64 {
                break;
            }
            k = p.clone();
            guard += 1;
        }
        k
    }
    if pairs.len() > 12 {
        notes.push(format!("{} more pairs of brands look alike and were kept apart. Combine them in the list below if they are one brand.", pairs.len() - 12));
    }
    for (a, b, _) in pairs.iter().take(12) {
        let (na, nb) = (brand_lines[a], brand_lines[b]);
        let (ca, cb) = (a.replace(' ', ""), b.replace(' ', ""));
        // One letter dropped or doubled, or an "s" on the end: how a name is mistyped.
        let dropped = |long: &str, short: &str| {
            long.len() == short.len() + 1 && (0..long.len()).any(|i| long.is_char_boundary(i) && long.is_char_boundary(i + 1) && format!("{}{}", &long[..i], &long[i + 1..]) == short)
        };
        let typo = dropped(&ca, &cb) || dropped(&cb, &ca);
        let stray = typo && match (known.contains_key(a), known.contains_key(b)) {
            (true, true) => false,
            (true, false) => nb <= 2 || nb * 10 <= na,
            (false, true) => na <= 2 || na * 10 <= nb,
            (false, false) => na.min(nb) <= 2 || na.min(nb) * 10 <= na.max(nb),
        };
        let suggested = if stray || ca == cb { "yes" } else { "no" };
        let id = format!("merge:{}|{}", a, b);
        let ans = ask.ask(
            &id,
            format!("Are \"{}\" ({}) and \"{}\" ({}) the same brand?", display_of(a), plural(na, "line", "lines"), display_of(b), plural(nb, "line", "lines")),
            None,
            vec![choice("yes", "Same brand"), choice("no", "Different brands")],
            suggested,
        );
        if ans == "yes" {
            let (ra, rb) = (root(&parent, a), root(&parent, b));
            if ra != rb {
                // A known brand names the pair, then the one with more lines, then the
                // longer spelling ("Carhartt" over "Carhart").
                let rank = |k: &String| (known.contains_key(k), brand_lines[k], k.len());
                let (keep, fold) = if rank(&ra) >= rank(&rb) { (ra, rb) } else { (rb, ra) };
                parent.insert(fold, keep);
            }
        }
    }
    let brands: Vec<Option<(String, String)>> = lines
        .iter()
        .map(|l| {
            if is_no_brand(&l.brand_raw) {
                return None;
            }
            let k = root(&parent, &brand_key(&l.brand_raw));
            Some((k.clone(), display_of(&k)))
        })
        .collect();

    // Categories: the sheet's own where a line has one, else a guess from the title (then
    // from the other text column). "N/A", "Unknown", "Other" and "-" are no category.
    let hierarchical = cols.category.map_or(false, |_| {
        let with = lines.iter().filter(|l| l.category.contains('>') || l.category.contains(" / ")).count();
        with * 2 > lines.len()
    });
    let level: usize = if hierarchical {
        let a = ask.ask(
            "category_level",
            "The categories are paths (\"Apparel > Shoes > Athletic Shoes\"). Group by which level?".into(),
            None,
            vec![choice("1", "The first level"), choice("2", "The second level"), choice("all", "The whole path")],
            "1",
        );
        a.parse().unwrap_or(usize::MAX)
    } else {
        usize::MAX
    };
    let mut guessed = vec![false; lines.len()];
    let cat_raw: Vec<Option<String>> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let own = l.category.trim();
            if cols.category.is_some() && !own.is_empty() && !manifest_category::is_no_value(own) {
                let parts: Vec<&str> = if own.contains('>') { own.split('>').collect() } else { own.split(" / ").collect() };
                let parts: Vec<&str> = parts.into_iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
                let cut = if level == usize::MAX || parts.len() <= level { own.to_string() } else { parts[..level].join(" > ") };
                return Some(cut);
            }
            let mut g = guess_category(&l.desc);
            if g == manifest_category::UNCATEGORIZED && !l.alt.is_empty() {
                g = guess_category(&l.alt);
            }
            if g == manifest_category::UNCATEGORIZED {
                None
            } else {
                guessed[i] = true;
                Some(g.to_string())
            }
        })
        .collect();
    let mut cat_spell: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for c in cat_raw.iter().flatten() {
        *cat_spell.entry(category_group_key(c)).or_default().entry(c.clone()).or_insert(0) += 1;
    }
    let mut folded_cats: Vec<String> = cat_spell
        .values()
        .filter(|sp| sp.len() > 1)
        .map(|sp| {
            let mut v: Vec<&String> = sp.keys().collect();
            v.sort();
            format!("{} ({})", category_group_name(sp), v.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" / "))
        })
        .collect();
    if !folded_cats.is_empty() {
        folded_cats.sort();
        notes.push(format!("Read as one category each: {}.", folded_cats.join("; ")));
    }
    let cats: Vec<Option<(String, String)>> = cat_raw
        .iter()
        .map(|c| {
            let c = c.as_ref()?;
            let k = category_group_key(c);
            if k.is_empty() {
                return None;
            }
            Some((k.clone(), category_group_name(&cat_spell[&k])))
        })
        .collect();
    let total_retail: f64 = lines.iter().map(|l| l.retail).sum();
    let unplaced: Vec<usize> = (0..lines.len()).filter(|&i| cats[i].is_none()).collect();
    let unplaced_retail: f64 = unplaced.iter().map(|&i| lines[i].retail).sum();
    let share = |r: f64, n: usize| if total_retail > 0.0 { r / total_retail } else { n as f64 / lines.len() as f64 };
    let from_title = lines.iter().filter(|l| l.category.trim().is_empty() || manifest_category::is_no_value(&l.category)).count();
    if cols.category.is_none() || from_title > 0 {
        let whence = if cols.category.is_none() {
            "There is no category column, so categories are read from the words in each title".to_string()
        } else {
            format!("{} had no category in the {} column, so theirs is read from the title", plural(from_title, "line", "lines"), t.headers[cols.category.unwrap()].trim())
        };
        let text = if unplaced.is_empty() {
            format!("{}.", whence)
        } else {
            format!(
                "{}. {} of {} ({} of retail) could not be placed and are Uncategorized.",
                whence,
                fmt_int(unplaced.len() as f64),
                plural(lines.len(), "line", "lines"),
                fmt_pct(share(unplaced_retail, unplaced.len()) * 100.0) + "%"
            )
        };
        // A guess that leaves much of the load unplaced goes first, where it is seen.
        if share(unplaced_retail, unplaced.len()) > 0.10 {
            notes.insert(0, text);
        } else {
            notes.push(text);
        }
    }

    let footers: Vec<String> = read.separators.iter().chain(read.summary.iter()).cloned().collect();
    Ok(Prepared { t, cols, lines, brands, cats, guessed, brands_read, left_out, footers })
}

fn build(path: &str, answers: &HashMap<String, String>, edits: &SplitEdits) -> Result<State> {
    let mut ask = Ask { answers, questions: Vec::new() };
    let mut notes: Vec<String> = Vec::new();
    let Prepared { t, mut cols, lines, brands, cats, footers, .. } = prepare(path, &mut ask, &mut notes)?;
    let brand_of = |i: usize| brands[i].clone();
    let cat_of = |i: usize| cats[i].clone();

    let total_retail: f64 = lines.iter().map(|l| l.retail).sum();
    let total_units: f64 = lines.iter().map(|l| l.qty).sum();
    let weight_of = |idx: &[usize]| -> f64 {
        if total_retail > 0.0 {
            idx.iter().map(|&i| lines[i].retail).sum::<f64>() / total_retail
        } else {
            idx.iter().map(|&i| lines[i].qty).sum::<f64>() / total_units.max(1.0)
        }
    };

    // How to split. The lines with no brand count as a group of their own when there are
    // enough of them, so one brand and a pile of unbranded lines can still be split.
    let mut by_brand: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_cat: HashMap<String, Vec<usize>> = HashMap::new();
    for i in 0..lines.len() {
        by_brand.entry(brand_of(i).map(|b| b.0).unwrap_or_default()).or_default().push(i);
        by_cat.entry(cat_of(i).map(|c| c.0).unwrap_or_default()).or_default().push(i);
    }
    let real = |m: &HashMap<String, Vec<usize>>| -> usize {
        m.iter().filter(|(k, v)| !k.is_empty() || v.len() >= 5 || weight_of(v) >= 0.02).count()
    };
    let (n_brands, n_cats) = (real(&by_brand), real(&by_cat));
    let top_share = |m: &HashMap<String, Vec<usize>>| m.values().map(|v| weight_of(v)).fold(0.0, f64::max);
    let placed = |m: &HashMap<String, Vec<usize>>| 1.0 - m.get("").map_or(0.0, |v| weight_of(v));
    let mut split_choices = Vec::new();
    if n_brands >= 2 {
        split_choices.push(choice("brand", format!("By brand ({})", n_brands)));
    }
    if n_cats >= 2 {
        split_choices.push(choice("category", format!("By category ({})", n_cats)));
    }
    if n_brands >= 2 && n_cats >= 2 {
        split_choices.push(choice("brand_in_category", "By brand within each category"));
    }
    if split_choices.is_empty() {
        let unbranded = by_brand.get("").map_or(0, |v| v.len());
        let uncat = by_cat.get("").map_or(0, |v| v.len());
        let why = if unbranded == lines.len() && uncat == lines.len() {
            "No brand or category could be read for any line of this manifest, so there is nothing to split it by. Add a brand or category column and try again.".to_string()
        } else {
            format!(
                "Every line on this manifest is the same brand and the same category, so there is nothing to split it by.{}",
                if cols.brand.is_none() && cols.category.is_none() { " It has no brand or category column." } else { "" }
            )
        };
        // With other sheets to choose from, keep the plan (one manifest) so the sheet can be
        // changed; with none, there is nothing more to ask.
        if t.sheets.len() < 2 {
            bail!("{}", why);
        }
        notes.insert(0, format!("{} Choose another sheet above if this is not the manifest.", why));
        split_choices.push(choice("brand", "By brand (1)"));
    }
    // Suggest the split that places most of the load and actually splits it: not brand
    // when most lines have none or one brand holds nearly all of it.
    let good = |m: &HashMap<String, Vec<usize>>, n: usize| n >= 2 && placed(m) >= 0.5 && top_share(m) < 0.85;
    let suggested = if good(&by_brand, n_brands) {
        "brand"
    } else if good(&by_cat, n_cats) {
        "category"
    } else {
        split_choices[0].id.as_str()
    }
    .to_string();
    let mut split_detail = match (cols.brand, cols.category) {
        (Some(b), Some(c)) => format!("Brands come from the {} column and categories from the {} column.", t.headers[b].trim(), t.headers[c].trim()),
        (Some(b), None) => format!("Brands come from the {} column and categories from the titles.", t.headers[b].trim()),
        (None, Some(c)) => format!("Brands are read from the titles and categories come from the {} column.", t.headers[c].trim()),
        (None, None) => "Brands and categories are both read from the titles.".into(),
    };
    for (m, what) in [(&by_brand, "brand"), (&by_cat, "category")] {
        let top = top_share(m);
        if top >= 0.85 && m.len() >= 2 {
            split_detail.push_str(&format!(" One {} is {}% of the retail, so splitting by {} barely splits it.", what, fmt_pct(top * 100.0), what));
        }
    }
    let split_by = ask.ask("split_by", "How should this manifest be split?".into(), Some(split_detail), split_choices, &suggested);

    // Group the lines.
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (i, _) in lines.iter().enumerate() {
        let b = brand_of(i);
        let c = cat_of(i);
        let (key, name) = match split_by.as_str() {
            "category" => match c {
                Some((k, n)) => (format!("c:{}", k), n),
                None => ("c:".into(), "Uncategorized".into()),
            },
            "brand_in_category" => {
                let (ck, cn) = c.unwrap_or(("".into(), "Uncategorized".into()));
                let (bk, bn) = b.unwrap_or(("".into(), "Unbranded".into()));
                (format!("c:{}|b:{}", ck, bk), format!("{} / {}", cn, bn))
            }
            _ => match b {
                Some((k, n)) => (format!("b:{}", k), n),
                None => ("b:".into(), "Unbranded".into()),
            },
        };
        groups
            .entry(key.clone())
            .or_insert_with(|| {
                order.push(key.clone());
                Group { key: key.clone(), name, idx: Vec::new() }
            })
            .idx
            .push(i);
    }
    let weight = |g: &Group| weight_of(&g.idx);
    let is_blank = |k: &str| k == "b:" || k == "c:";
    let noun = match split_by.as_str() {
        "category" => ("category", "categories"),
        "brand_in_category" => ("group", "groups"),
        _ => ("brand", "brands"),
    };
    // The fold's key names its mode, so a change of mode never carries its edits across.
    let mixed_key = format!("mixed:{}", split_by);

    // Small groups into one Mixed manifest: the 12 biggest always stay their own; of the
    // rest, those under 2% of the retail fold. A fold that would swallow most of the load
    // is not suggested.
    let mut ranked: Vec<(String, f64)> = order.iter().filter(|k| !is_blank(k.as_str())).map(|k| (k.clone(), weight(&groups[k]))).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let mut small: Vec<String> = ranked
        .iter()
        .enumerate()
        .filter(|(i, (_, w))| *i >= 12 || *w < 0.02)
        .map(|(_, (k, _))| k.clone())
        .collect();
    // Every group is small: the 12 biggest still stay their own, never one Mixed of it all.
    if small.len() == ranked.len() {
        small = ranked.iter().skip(12).map(|(k, _)| k.clone()).collect();
    }
    let capped = ranked.len() > 12 && small.len() == ranked.len() - 12;
    let mut mixed: Vec<String> = Vec::new();
    if small.len() >= 2 {
        let lines_in: usize = small.iter().map(|k| groups[k].idx.len()).sum();
        let retail_in: f64 = small.iter().flat_map(|k| groups[k].idx.iter()).map(|&i| lines[i].retail).sum();
        let share_in: f64 = small.iter().map(|k| weight(&groups[k])).sum();
        let text = if capped {
            format!(
                "Keep the 12 biggest {} as their own manifests and put the other {} together in one Mixed manifest?",
                noun.1,
                fmt_int(small.len() as f64)
            )
        } else {
            format!("{} {} each have under 2% of the retail. Put them together in one Mixed manifest?", fmt_int(small.len() as f64), noun.1)
        };
        let a = ask.ask(
            "small",
            text,
            Some(format!(
                "{} and {} of retail between them{}.",
                plural(lines_in, "line", "lines"),
                fmt_money(retail_in),
                if share_in > 0.30 { format!(", {}% of the load, which would make Mixed the biggest manifest", fmt_pct(share_in * 100.0)) } else { String::new() }
            )),
            vec![choice("mixed", "Yes, one Mixed manifest"), choice("keep", format!("No, keep every {} separate", noun.0))],
            if share_in > 0.30 { "keep" } else { "mixed" },
        );
        if a == "mixed" {
            mixed = small;
        }
    }
    // Lines with no brand (or category).
    if let Some(blank) = order.iter().find(|k| is_blank(k.as_str())).cloned() {
        if groups.len() > 1 {
            let g = &groups[&blank];
            let w = weight(g);
            let retail: f64 = g.idx.iter().map(|&i| lines[i].retail).sum();
            let label = if split_by == "category" { "Uncategorized" } else { "Unbranded" };
            let text = if split_by == "category" && g.idx.iter().any(|&i| cols.category.is_none() || lines[i].category.trim().is_empty() || manifest_category::is_no_value(&lines[i].category)) {
                format!("{} could not be placed in a category from {} ({} of retail). Where should {} go?", plural(g.idx.len(), "line", "lines"), if g.idx.len() == 1 { "its title" } else { "their titles" }, fmt_money(retail), if g.idx.len() == 1 { "it" } else { "they" })
            } else {
                format!("{} no {} ({} of retail). Where should {} go?", plural(g.idx.len(), "line has", "lines have"), if split_by == "category" { "category" } else { "brand" }, fmt_money(retail), if g.idx.len() == 1 { "it" } else { "they" })
            };
            let a = ask.ask(
                "blank",
                text,
                None,
                vec![choice("own", format!("Their own {} manifest", label)), choice("mixed", "In with Mixed")],
                if w >= 0.02 { "own" } else { "mixed" },
            );
            if a == "mixed" {
                mixed.push(blank);
            }
        }
    }
    if !mixed.is_empty() {
        let mut idx: Vec<usize> = Vec::new();
        for k in &mixed {
            if let Some(g) = groups.remove(k) {
                idx.extend(g.idx);
            }
        }
        idx.sort();
        order.retain(|k| !mixed.contains(k));
        order.push(mixed_key.clone());
        // A real group called Mixed keeps its name; the fold says what it is.
        let taken = groups.values().any(|g| g.name.trim().eq_ignore_ascii_case("mixed"));
        let name = if taken { "Mixed (small groups)" } else { "Mixed" };
        groups.insert(mixed_key.clone(), Group { key: mixed_key.clone(), name: name.into(), idx });
    }

    // Jack's edits: combine (in a fixed order, so a cycle always ends the same way), rename.
    let mut combines: Vec<(&String, &String)> = edits.combine.iter().collect();
    combines.sort();
    for (from, to) in combines {
        let mut to = to.clone();
        let mut guard = 0;
        while let Some(next) = edits.combine.get(&to) {
            if guard > 32 || next == from {
                break;
            }
            to = next.clone();
            guard += 1;
        }
        if from == &to || !groups.contains_key(&to) {
            continue;
        }
        if let Some(g) = groups.remove(from) {
            let dest = groups.get_mut(&to).unwrap();
            dest.idx.extend(g.idx);
            dest.idx.sort();
            order.retain(|k| k != from);
        }
    }
    for (k, n) in &edits.names {
        if let Some(g) = groups.get_mut(k) {
            let n = n.trim();
            if !n.is_empty() {
                g.name = n.to_string();
            }
        }
    }
    let mut ordered: Vec<Group> = order.into_iter().filter_map(|k| groups.remove(&k)).collect();
    ordered.sort_by(|a, b| {
        let last = |g: &Group| g.key.starts_with("mixed") || is_blank(&g.key);
        last(a).cmp(&last(b)).then(weight(b).partial_cmp(&weight(a)).unwrap_or(std::cmp::Ordering::Equal)).then(a.name.cmp(&b.name))
    });

    // Pricing.
    let sp = detect_pricing(&t, &cols, &lines, &footers);
    let has_sheet = sp.total.is_some();
    let mut price_choices = vec![
        Choice { id: "pct".into(), label: "A % of retail".into(), input: Some("pct".into()) },
        Choice { id: "unit".into(), label: "A price per unit".into(), input: Some("money".into()) },
    ];
    if has_sheet {
        price_choices.push(choice("sheet", "Each line's own price from the sheet"));
    }
    price_choices.push(choice("none", "No price yet"));
    if total_retail <= 0.0 {
        price_choices.retain(|c| c.id != "pct");
    }
    let (suggest_mode, suggest_value) = match sp.kind.as_str() {
        "pct" if total_retail > 0.0 => ("pct", sp.pct),
        "unit" => ("unit", sp.unit),
        "line" => ("sheet", None),
        _ => ("none", None),
    };
    let pricing_detail = {
        let mut e = sp.evidence.clone();
        if let Some(f) = e.get(0..1) {
            e = f.to_uppercase() + &e[1..];
        }
        match sp.kind.as_str() {
            "pct" => format!("The sheet is priced at {}% of retail: {}.", fmt_pct(sp.pct.unwrap_or(0.0)), sp.evidence),
            "unit" => format!("The sheet is priced at {} a unit: {}.", fmt_money(sp.unit.unwrap_or(0.0)), sp.evidence),
            _ => format!("{}.", e),
        }
    };
    let pricing_detail = if has_sheet && suggest_mode != "none" {
        format!("{} If that price is what you pay, the same rule sells the new manifests at cost: set a higher % or price.", pricing_detail)
    } else {
        pricing_detail
    };
    let mode = ask.ask("pricing", "How should the new manifests be priced?".into(), Some(pricing_detail), price_choices, suggest_mode);
    // A number Jack typed wins; a box he cleared or filled with nonsense means no number
    // yet, never the suggestion behind his back.
    let value = match answers.get("pricing_value") {
        Some(v) => parse_money(v).filter(|v| *v >= 0.0 && (mode != "pct" || *v <= 100.0)),
        None if mode == suggest_mode => suggest_value,
        None => None,
    };
    if let Some(q) = ask.questions.last_mut() {
        q.value = value;
    }
    let default_rule = PriceRule { mode: mode.clone(), value };

    let sheet_is_cost = if has_sheet {
        ask.ask(
            "sheet_price_is",
            format!("Is the sheet's price ({}) what you pay for this load, or what you're asking?", fmt_money(sp.total.unwrap_or(0.0))),
            Some("It fills the cost on each lot you send to inventory.".into()),
            vec![choice("pay", "What I pay"), choice("ask", "What I'm asking")],
            "pay",
        ) == "pay"
    } else {
        false
    };
    let show_price = ask.ask(
        "show_price",
        "Put your price on each line of the new manifests?".into(),
        Some(if has_sheet {
            "With No, the sheet's own price columns are left out too, so its price never reaches a buyer.".into()
        } else {
            "Adds a unit price and a total price column.".into()
        }),
        vec![choice("yes", "Yes, a unit and total price"), choice("no", "No, retail only")],
        if mode == "none" { "no" } else { "yes" },
    ) == "yes";

    // Photos.
    let im = &t.images;
    let line_rows: HashSet<u32> = lines.iter().map(|l| t.abs_rows[l.row]).collect();
    let placed_on_lines = im.placed.iter().filter(|p| line_rows.contains(&p.row)).count();
    let off_lines = im.placed.len() - placed_on_lines
        + im.in_cell.keys().filter(|(r, _)| !line_rows.contains(r)).count();
    let with_photo = lines.iter().filter(|l| l.photo).count();
    let photos = PhotoStats {
        in_cell: im.in_cell.len(),
        placed: im.placed.len(),
        web: im.web.len() + t.image_formulas.len(),
        lines_with_photo: with_photo,
        link_column: cols.photo_links.map(|j| t.headers[j].trim().to_string()),
    };
    let excel_xml = matches!(t.format.as_str(), "xlsx" | "xlsm");
    if !excel_xml {
        notes.push(match t.format.as_str() {
            "xls" | "xlsb" | "ods" => format!("Photos are read from .xlsx and .xlsm files. This one is .{}, so save it as .xlsx in Excel to keep its photos.", t.format),
            _ => "A CSV file cannot hold photos.".into(),
        });
    } else if im.count() + t.image_formulas.len() == 0 && cols.photo_links.is_none() {
        notes.push("No photos in this file.".into());
    } else {
        let mut parts = Vec::new();
        if im.in_cell.len() > 0 {
            parts.push(format!("{} in cells", fmt_int(im.in_cell.len() as f64)));
        }
        if im.placed.len() > 0 {
            parts.push(format!("{} placed on the sheet", fmt_int(im.placed.len() as f64)));
        }
        if photos.web > 0 {
            parts.push(format!("{} web pictures", fmt_int(photos.web as f64)));
        }
        let mut s = if parts.is_empty() { String::new() } else { format!("Found {} photos: {}. ", fmt_int((im.count() + t.image_formulas.len()) as f64), parts.join(", ")) };
        if let Some(l) = &photos.link_column {
            s.push_str(&format!("The {} column links to photos and is kept. ", l));
        }
        s.push_str(&format!("{} of {} lines have one; each goes into its line's new manifest.", fmt_int(with_photo as f64), fmt_int(lines.len() as f64)));
        notes.push(s);
        if off_lines > 0 {
            notes.push(format!("{} sit outside the product rows (a logo, say) and are left out.", plural(off_lines, "picture", "pictures")));
        }
        if im.unresolved > 0 {
            notes.push(format!("{} point at nothing inside the file, so they are left out.", plural(im.unresolved, "picture", "pictures")));
        }
    }

    // Rules per split, line prices, hidden columns.
    let rules: HashMap<String, PriceRule> = ordered
        .iter()
        .map(|g| (g.key.clone(), edits.pricing.get(&g.key).cloned().unwrap_or_else(|| default_rule.clone())))
        .collect();
    let line_prices: HashMap<usize, f64> =
        edits.line_prices.iter().filter_map(|(k, v)| k.parse::<usize>().ok().filter(|_| *v >= 0.0).map(|r| (r, *v))).collect();
    let shown: HashSet<usize> = edits.show_cols.iter().copied().collect();
    let hidden_in_sheet: Vec<usize> = (0..t.headers.len())
        .filter(|j| *j != cols.desc && t.images.hidden_cols.contains(&(t.abs_col0 + *j as u32)))
        .collect();
    let hidden: HashSet<usize> = edits
        .hidden_cols
        .iter()
        .copied()
        .chain(cols.internal.iter().copied().filter(|j| !shown.contains(j)))
        .chain(cols.unnamed.iter().copied().filter(|j| !shown.contains(j)))
        .chain(hidden_in_sheet.iter().copied().filter(|j| !shown.contains(j)))
        .collect();
    let left_out: Vec<String> = cols.internal.iter().filter(|j| !shown.contains(j)).map(|&j| t.headers[j].trim().to_string()).collect();
    if !left_out.is_empty() {
        notes.push(format!(
            "Left out of the files unless you put {} back: {} (read as your own costs, your supplier or where it came from).",
            if left_out.len() == 1 { "it" } else { "them" },
            list_names(&left_out)
        ));
    }
    let quiet: Vec<String> = cols
        .unnamed
        .iter()
        .chain(hidden_in_sheet.iter())
        .filter(|j| !shown.contains(j) && !cols.internal.contains(j))
        .map(|&j| if t.headers[j].trim().is_empty() { format!("Column {}", j + 1) } else { t.headers[j].trim().to_string() })
        .collect();
    if !quiet.is_empty() {
        notes.push(format!(
            "Also left out unless you put {} back: {} (no header, or hidden on the sheet).",
            if quiet.len() == 1 { "it" } else { "them" },
            list_names(&quiet)
        ));
    }
    let skipped: HashSet<String> = edits.skip.iter().cloned().collect();

    let role = |j: usize| -> &'static str {
        let is = |o: Option<usize>| o == Some(j);
        if j == cols.desc { "description" }
        else if is(cols.qty) { "quantity" }
        else if is(cols.retail_unit) { "retail" }
        else if is(cols.retail_ext) { "retail_total" }
        else if is(cols.sale_unit) { "sheet_price" }
        else if is(cols.sale_ext) { "sheet_total" }
        else if is(cols.pct) { "sheet_pct" }
        else if is(cols.category) { "category" }
        else if is(cols.brand) { "brand" }
        else if is(cols.photo_links) { "photo_links" }
        else if cols.internal.contains(&j) { "internal" }
        else { "" }
    };
    let columns: Vec<ColumnInfo> = t
        .headers
        .iter()
        .enumerate()
        .filter(|(j, h)| !h.trim().is_empty() || t.rows.iter().any(|r| !matches!(r[*j], Val::Empty)))
        .map(|(j, h)| ColumnInfo {
            index: j,
            header: if h.trim().is_empty() { format!("Column {}", j + 1) } else { h.trim().to_string() },
            role: role(j).into(),
            hidden: hidden.contains(&j) && j != cols.desc,
        })
        .collect();

    let mut splits: Vec<SplitOut> = Vec::new();
    let (mut sum_lines, mut sum_units, mut sum_retail) = (0usize, 0.0f64, 0.0f64);
    let (mut kept_lines, mut kept_units, mut kept_retail) = (0usize, 0.0f64, 0.0f64);
    let mut all_price: Option<f64> = None;
    for g in &ordered {
        let rule = rules[&g.key].clone();
        let mut price: Option<f64> = None;
        let mut sheet_price: Option<f64> = None;
        let mut unpriced = 0usize;
        for &i in &g.idx {
            let l = &lines[i];
            match price_of(l, &rule, line_prices.get(&l.row).copied()) {
                Some((_, ext)) => price = Some(price.unwrap_or(0.0) + ext),
                None if rule.mode != "none" => unpriced += 1,
                None => {}
            }
            if let Some(s) = l.sheet {
                sheet_price = Some(sheet_price.unwrap_or(0.0) + s);
            }
        }
        let units: f64 = g.idx.iter().map(|&i| lines[i].qty).sum();
        let retail: f64 = g.idx.iter().map(|&i| lines[i].retail).sum();
        sum_lines += g.idx.len();
        sum_units += units;
        sum_retail += retail;
        let skip = skipped.contains(&g.key);
        if !skip {
            if let Some(p) = price {
                all_price = Some(all_price.unwrap_or(0.0) + p);
            }
            kept_lines += g.idx.len();
            kept_units += units;
            kept_retail += retail;
        }
        // The category a lot made from this split files under: the group's own category,
        // never a name Jack typed over it, and nothing for Mixed or Uncategorized.
        let category = if split_by == "category" {
            g.key.strip_prefix("c:").filter(|k| !k.is_empty()).and_then(|_| g.idx.first().and_then(|&i| cat_of(i).map(|c| c.1)))
        } else {
            None
        };
        let mut biggest: Vec<&Line> = g.idx.iter().map(|&i| &lines[i]).collect();
        biggest.sort_by(|a, b| b.retail.partial_cmp(&a.retail).unwrap_or(std::cmp::Ordering::Equal));
        splits.push(SplitOut {
            key: g.key.clone(),
            name: g.name.clone(),
            lines: g.idx.len(),
            units,
            retail: round2(retail),
            sheet_price: sheet_price.map(round2),
            price: price.map(round2),
            rule,
            photos: g.idx.iter().filter(|&&i| lines[i].photo).count(),
            unpriced,
            skipped: skip,
            examples: biggest.iter().take(3).map(|l| l.desc.clone()).collect(),
            category,
        });
    }
    let reconciles = sum_lines == lines.len()
        && (sum_units - total_units).abs() < 1e-6
        && (sum_retail - total_retail).abs() < 0.005 * total_retail.max(1.0) / 100.0 + 0.01;

    let categories: Vec<String> = (0..lines.len()).map(|i| cat_of(i).map(|c| c.1).unwrap_or_else(|| "Uncategorized".into())).collect();
    let plan = SplitPlan {
        file_name: t.file_name.clone(),
        format: t.format.clone(),
        sheet: t.sheet.clone(),
        header_row: t.header_row,
        questions: ask.questions,
        notes,
        columns,
        sheet_pricing: sp,
        totals: Totals {
            lines: lines.len(),
            units: total_units,
            retail: round2(total_retail),
            sheet_price: lines.iter().filter_map(|l| l.sheet).fold(None, |a: Option<f64>, s| Some(a.unwrap_or(0.0) + s)).map(round2),
            price: all_price.map(round2),
            kept_lines,
            kept_units,
            kept_retail: round2(kept_retail),
        },
        splits,
        photos,
        reconciles,
        show_price,
    };
    cols.internal.sort();
    Ok(State { t, cols, lines, groups: ordered, skipped, rules, line_prices, hidden, show_price, sheet_is_cost, categories, plan })
}

/// One line of the analyzer's breakdown.
pub(crate) struct BreakdownLine {
    pub(crate) qty: f64,
    pub(crate) retail: f64,
    /// (key, name) of its category and brand; None for none.
    pub(crate) category: Option<(String, String)>,
    pub(crate) brand: Option<(String, String)>,
}

/// What the Manifest analyzer shows for a spreadsheet or CSV: the split's own lines, read
/// by the same columns, rows, brands and categories with every question at its suggested
/// answer, so the breakdown and the split can never disagree (R-396).
pub(crate) struct Breakdown {
    pub(crate) format: String,
    pub(crate) sheet: Option<String>,
    pub(crate) header_row: usize,
    pub(crate) description_col: Option<String>,
    pub(crate) quantity_col: Option<String>,
    pub(crate) price_col: Option<String>,
    pub(crate) price_is_extended: bool,
    pub(crate) category_col: Option<String>,
    pub(crate) brand_col: Option<String>,
    pub(crate) lines: Vec<BreakdownLine>,
    /// Lines whose category came from the sheet's own column rather than the title.
    pub(crate) from_sheet: usize,
    pub(crate) brands_read: usize,
    pub(crate) left_out: Option<String>,
    pub(crate) notes: Vec<String>,
}

pub(crate) fn breakdown(path: &str) -> Result<Breakdown> {
    let answers = HashMap::new();
    let mut ask = Ask { answers: &answers, questions: Vec::new() };
    let mut notes = Vec::new();
    let p = prepare(path, &mut ask, &mut notes)?;
    if p.t.sheets.len() > 1 && p.t.sheet.as_deref() != Some(ALL_SHEETS) {
        let others: Vec<String> = p.t.sheets.iter().filter(|(n, _)| Some(n) != p.t.sheet.as_ref()).map(|(n, _)| n.clone()).collect();
        notes.insert(0, format!("This file has {} sheets with rows on them; this is {}. The others ({}) can be picked when splitting.",
            p.t.sheets.len(), p.t.sheet.clone().unwrap_or_default(), list_names(&others)));
    }
    let head = |j: Option<usize>| j.map(|j| p.t.headers[j].trim().to_string()).filter(|h| !h.is_empty());
    let from_sheet = (0..p.lines.len()).filter(|&i| p.cats[i].is_some() && !p.guessed[i]).count();
    Ok(Breakdown {
        format: p.t.format.clone(),
        sheet: p.t.sheet.clone(),
        header_row: p.t.header_row,
        description_col: head(Some(p.cols.desc)),
        quantity_col: head(p.cols.qty),
        price_col: head(p.cols.retail_unit.or(p.cols.retail_ext)),
        price_is_extended: p.cols.retail_unit.is_none() && p.cols.retail_ext.is_some(),
        category_col: head(p.cols.category),
        brand_col: head(p.cols.brand),
        lines: (0..p.lines.len())
            .map(|i| BreakdownLine { qty: p.lines[i].qty, retail: p.lines[i].retail, category: p.cats[i].clone(), brand: p.brands[i].clone() })
            .collect(),
        from_sheet,
        brands_read: p.brands_read,
        left_out: p.left_out,
        notes,
    })
}

pub fn plan(path: &str, answers: &HashMap<String, String>, edits: &SplitEdits) -> Result<SplitPlan> {
    Ok(build(path, answers, edits)?.plan)
}

/// One split's lines, for editing a price on a single line.
pub fn lines(path: &str, answers: &HashMap<String, String>, edits: &SplitEdits, key: &str) -> Result<Vec<LineOut>> {
    let s = build(path, answers, edits)?;
    let g = s.groups.iter().find(|g| g.key == key).context("That split is no longer in the plan.")?;
    let rule = &s.rules[key];
    Ok(g.idx
        .iter()
        .map(|&i| {
            let l = &s.lines[i];
            let over = s.line_prices.get(&l.row).copied();
            let p = price_of(l, rule, over);
            LineOut {
                row: l.row,
                desc: l.desc.clone(),
                qty: l.qty,
                retail: round2(l.retail),
                sheet: l.sheet.map(round2),
                unit: p.map(|p| p.0),
                total: p.map(|p| p.1),
                edited: over.is_some(),
                photo: l.photo,
            }
        })
        .collect())
}

// ── Writing the files ───────────────────────────────────────────────────────

fn safe_name(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '[' | ']') || c.is_control() { ' ' } else { c })
        .collect();
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = joined.chars().take(max).collect();
    let t = t.trim().trim_end_matches('.').to_string();
    if t.is_empty() { "Split".into() } else { t }
}

/// A path in `dir` for `name` that does not exist yet: nothing already there is ever
/// overwritten.
fn free_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{}.{}", stem, ext));
    if !first.exists() {
        return first;
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{} {}.{}", stem, n, ext));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{} {}.{}", stem, uuid::Uuid::new_v4().simple(), ext))
}

/// What kind of image some bytes are, by their first bytes.
fn image_kind(b: &[u8]) -> &'static str {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if b.starts_with(&[0xFF, 0xD8]) {
        "jpg"
    } else if b.starts_with(b"GIF8") {
        "gif"
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "webp"
    } else if b.starts_with(b"BM") {
        "bmp"
    } else {
        ""
    }
}

/// PNG bytes for a picture Excel can hold but a writer or a browser cannot (WebP, TIFF).
/// None for vector pictures (EMF, WMF), which there is no way to redraw here.
fn to_png(b: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(b).ok()?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageOutputFormat::Png).ok()?;
    Some(out.into_inner())
}

fn xlsx_image(b: &[u8]) -> Option<rust_xlsxwriter::Image> {
    if matches!(image_kind(b), "png" | "jpg" | "gif" | "bmp") {
        if let Ok(i) = rust_xlsxwriter::Image::new_from_buffer(b) {
            return Some(i);
        }
    }
    rust_xlsxwriter::Image::new_from_buffer(&to_png(b)?).ok()
}

fn is_url(s: &str) -> bool {
    (s.starts_with("http://") || s.starts_with("https://")) && !s.contains(char::is_whitespace) && s.len() <= 2000
}

/// An `=IMAGE(...)` formula as the file format stores it.
fn image_formula(f: &str) -> String {
    let body = f.trim_start_matches('=');
    let upper = body.to_uppercase();
    if upper.contains("_XLFN.IMAGE(") {
        return body.to_string();
    }
    let mut out = String::new();
    let mut rest = body;
    while let Some(i) = rest.to_uppercase().find("IMAGE(") {
        out.push_str(&rest[..i]);
        out.push_str("_xlfn.IMAGE(");
        rest = &rest[i + "IMAGE(".len()..];
    }
    out.push_str(rest);
    out
}

fn write_split(
    s: &State,
    g: &Group,
    media: &HashMap<String, rust_xlsxwriter::Image>,
) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Color, Format, FormatBorder, ObjectMovement, Workbook};
    let t = &s.t;
    let c = &s.cols;
    let rule = &s.rules[&g.key];
    let im = &t.images;
    let lines: Vec<&Line> = g.idx.iter().map(|&i| &s.lines[i]).collect();
    let rows: HashSet<u32> = lines.iter().map(|l| t.abs_rows[l.row]).collect();
    let sheet_cols = [c.sale_unit, c.sale_ext, c.pct];
    let is_sheet_col = |j: usize| sheet_cols.contains(&Some(j));

    // Output columns, by absolute sheet column: the table's columns that carry anything,
    // plus any column that only holds pictures (a photo column with no header).
    let mut abs_cols: Vec<u32> = Vec::new();
    for j in 0..t.headers.len() {
        if s.hidden.contains(&j) && j != c.desc {
            continue;
        }
        if is_sheet_col(j) && !s.show_price {
            continue;
        }
        let abs = t.abs_col0 + j as u32;
        let used = !t.headers[j].trim().is_empty()
            || lines.iter().any(|l| !matches!(t.rows[l.row][j], Val::Empty))
            || im.in_cell.keys().chain(im.web.keys()).any(|(r, cc)| *cc == abs && rows.contains(r))
            || im.placed.iter().any(|p| p.col == abs && rows.contains(&p.row));
        if used {
            abs_cols.push(abs);
        }
    }
    for p in im.placed.iter().filter(|p| rows.contains(&p.row)) {
        let inside = p.col >= t.abs_col0 && ((p.col - t.abs_col0) as usize) < t.headers.len();
        if !inside && !abs_cols.contains(&p.col) {
            abs_cols.push(p.col);
        }
    }
    for (r, cc) in im.in_cell.keys().chain(im.web.keys()) {
        let inside = *cc >= t.abs_col0 && ((*cc - t.abs_col0) as usize) < t.headers.len();
        if rows.contains(r) && !inside && !abs_cols.contains(cc) {
            abs_cols.push(*cc);
        }
    }
    abs_cols.sort();
    let out_of: HashMap<u32, u16> = abs_cols.iter().enumerate().map(|(i, a)| (*a, i as u16)).collect();
    let table_col = |abs: u32| -> Option<usize> {
        if abs < t.abs_col0 {
            return None;
        }
        let j = (abs - t.abs_col0) as usize;
        if j < t.headers.len() { Some(j) } else { None }
    };
    let typed = lines.iter().any(|l| s.line_prices.contains_key(&l.row));
    let append_price = s.show_price && c.sale_unit.is_none() && c.sale_ext.is_none() && (rule.mode != "none" || typed);
    let ncols_out = abs_cols.len() as u16 + if append_price { 2 } else { 0 };
    if ncols_out == 0 {
        bail!("Nothing to write for {}.", g.name);
    }

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name(safe_name(&g.name, 31).trim_matches('\'').trim())?;
    let head = Format::new().set_bold().set_text_wrap().set_background_color(Color::RGB(0xF2F2F2)).set_border_bottom(FormatBorder::Thin);
    let money = Format::new().set_num_format("$#,##0.00");
    let whole = Format::new().set_num_format("#,##0");
    let pct = Format::new().set_num_format("0.0%");
    let date = Format::new().set_num_format("m/d/yyyy");
    let bold = Format::new().set_bold().set_border_top(FormatBorder::Thin);
    let bold_money = Format::new().set_bold().set_num_format("$#,##0.00").set_border_top(FormatBorder::Thin);
    let bold_whole = Format::new().set_bold().set_num_format("#,##0").set_border_top(FormatBorder::Thin);

    // Header.
    let label = |j: usize| -> String {
        if s.show_price && Some(j) == c.sale_unit {
            return "Unit price".into();
        }
        if s.show_price && Some(j) == c.sale_ext {
            return "Total price".into();
        }
        if s.show_price && Some(j) == c.pct {
            return "% of retail".into();
        }
        let h = t.headers[j].trim();
        let abs = t.abs_col0 + j as u32;
        let pictures = im.placed.iter().any(|p| p.col == abs) || im.in_cell.keys().chain(im.web.keys()).any(|(_, cc)| *cc == abs);
        if !h.is_empty() {
            h.to_string()
        } else if pictures {
            "Photo".into()
        } else {
            format!("Column {}", j + 1)
        }
    };
    for (i, abs) in abs_cols.iter().enumerate() {
        let text = table_col(*abs).map(label).unwrap_or_else(|| "Photo".into());
        ws.write_string_with_format(0, i as u16, text, &head)?;
    }
    if append_price {
        ws.write_string_with_format(0, abs_cols.len() as u16, "Unit price", &head)?;
        ws.write_string_with_format(0, abs_cols.len() as u16 + 1, "Total price", &head)?;
    }
    if let Some(h) = t.header_abs_row.and_then(|r| im.row_heights.get(&r)) {
        ws.set_row_height(0, *h)?;
    }

    let money_cols: HashSet<usize> = [c.retail_unit, c.retail_ext, c.sale_unit, c.sale_ext].iter().flatten().copied().collect();
    let mut urls = 0usize;
    let (mut units, mut retail_total, mut price_total) = (0.0f64, 0.0f64, 0.0f64);
    let mut any_price = false;
    for (n, l) in lines.iter().enumerate() {
        let r = (n + 1) as u32;
        let abs_r = t.abs_rows[l.row];
        let price = price_of(l, rule, s.line_prices.get(&l.row).copied());
        units += l.qty;
        if let Some((_, e)) = price {
            price_total += e;
            any_price = true;
        }
        if let Some(j) = c.retail_ext {
            retail_total += t.rows[l.row][j].number().unwrap_or(0.0);
        }
        for (i, abs) in abs_cols.iter().enumerate() {
            let col = i as u16;
            if let Some(m) = im.in_cell.get(&(abs_r, *abs)) {
                if let Some(img) = media.get(m) {
                    ws.embed_image(r, col, img)?;
                }
                continue;
            }
            if let Some(url) = im.web.get(&(abs_r, *abs)) {
                ws.write_formula(r, col, format!("=_xlfn.IMAGE(\"{}\")", url.replace('"', "\"\"")).as_str())?;
                continue;
            }
            if let Some(f) = t.image_formulas.get(&(abs_r, *abs)) {
                ws.write_formula(r, col, format!("={}", image_formula(f)).as_str())?;
                continue;
            }
            let Some(j) = table_col(*abs) else { continue };
            if s.show_price && is_sheet_col(j) {
                if let Some((u, e)) = price {
                    if Some(j) == c.sale_unit {
                        ws.write_number_with_format(r, col, u, &money)?;
                    } else if Some(j) == c.sale_ext {
                        ws.write_number_with_format(r, col, e, &money)?;
                    } else if l.retail > 0.0 {
                        ws.write_number_with_format(r, col, e / l.retail, &pct)?;
                    }
                }
                continue;
            }
            match &t.rows[l.row][j] {
                Val::Empty => {}
                Val::Text(v) => {
                    let v: String = v.chars().take(32_000).collect();
                    if is_url(&v) && urls < 60_000 {
                        urls += 1;
                        ws.write_url(r, col, v.as_str())?;
                    } else {
                        ws.write_string(r, col, v)?;
                    }
                }
                Val::Num(v) => {
                    if money_cols.contains(&j) {
                        ws.write_number_with_format(r, col, *v, &money)?;
                    } else if Some(j) == c.qty {
                        ws.write_number_with_format(r, col, *v, &whole)?;
                    } else if v.fract() == 0.0 && v.abs() >= 1e11 {
                        // A 12-digit UPC as a number shows as 1.23457E+11.
                        ws.write_string(r, col, num_text(*v))?;
                    } else {
                        ws.write_number(r, col, *v)?;
                    }
                }
                Val::Bool(b) => {
                    ws.write_boolean(r, col, *b)?;
                }
                Val::Date(v) => {
                    ws.write_number_with_format(r, col, *v, &date)?;
                }
            }
        }
        if append_price {
            if let Some((u, e)) = price {
                ws.write_number_with_format(r, abs_cols.len() as u16, u, &money)?;
                ws.write_number_with_format(r, abs_cols.len() as u16 + 1, e, &money)?;
            }
        }
        if let Some(h) = im.row_heights.get(&abs_r) {
            ws.set_row_height(r, *h)?;
        }
        for p in im.placed.iter().filter(|p| p.row == abs_r) {
            let (Some(col), Some(img)) = (out_of.get(&p.col), media.get(&p.media)) else { continue };
            let img = img.clone().set_scale_to_size(p.w_px, p.h_px, false).set_object_movement(ObjectMovement::MoveAndSizeWithCells);
            ws.insert_image_with_offset(r, *col, &img, p.x_px.round() as u32, p.y_px.round() as u32)?;
        }
    }

    // Totals, so the file checks itself.
    let tr = (lines.len() + 1) as u32;
    if let Some(col) = out_of.get(&(t.abs_col0 + c.desc as u32)) {
        ws.write_string_with_format(tr, *col, "Total", &bold)?;
    }
    if let Some(col) = c.qty.and_then(|j| out_of.get(&(t.abs_col0 + j as u32))) {
        ws.write_number_with_format(tr, *col, units, &bold_whole)?;
    }
    if let Some(col) = c.retail_ext.and_then(|j| out_of.get(&(t.abs_col0 + j as u32))) {
        ws.write_number_with_format(tr, *col, round2(retail_total), &bold_money)?;
    }
    if s.show_price && any_price {
        let total_col = if append_price {
            Some(abs_cols.len() as u16 + 1)
        } else {
            c.sale_ext.and_then(|j| out_of.get(&(t.abs_col0 + j as u32)).copied())
        };
        if let Some(col) = total_col {
            ws.write_number_with_format(tr, col, round2(price_total), &bold_money)?;
        }
    }

    // Widths: the source's own where it set them, else sized to the text.
    for (i, abs) in abs_cols.iter().enumerate() {
        let col = i as u16;
        if let Some(px) = im.col_px.get(abs) {
            ws.set_column_width_pixels(col, px.round().clamp(8.0, 2000.0) as u16)?;
            continue;
        }
        let pictures = im.placed.iter().any(|p| p.col == *abs) || im.in_cell.keys().any(|(_, cc)| cc == abs);
        let width = match table_col(*abs) {
            Some(j) if j == c.desc => 48.0,
            Some(j) => {
                let longest = lines.iter().take(300).map(|l| t.rows[l.row][j].text().chars().count()).max().unwrap_or(0);
                (label(j).chars().count().max(longest) as f64 + 2.0).clamp(8.0, 40.0)
            }
            None => 12.0,
        };
        ws.set_column_width(col, if pictures { width.max(12.0) } else { width })?;
    }
    if append_price {
        ws.set_column_width(abs_cols.len() as u16, 12)?;
        ws.set_column_width(abs_cols.len() as u16 + 1, 13)?;
    }
    ws.set_freeze_panes(1, 0)?;
    if !lines.is_empty() {
        ws.autofilter(0, 0, lines.len() as u32, ncols_out - 1)?;
    }
    Ok(wb.save_to_buffer()?)
}

/// Write every split that is not left out into `dir`, and, for lots, up to six photos
/// per split beside them. Nothing already in `dir` is overwritten.
pub fn export(path: &str, answers: &HashMap<String, String>, edits: &SplitEdits, dir: &Path, for_lots: bool) -> Result<Vec<ExportedSplit>> {
    let s = build(path, answers, edits)?;
    if !s.plan.reconciles {
        bail!("The splits do not add back up to the manifest, so nothing was written.");
    }
    std::fs::create_dir_all(dir).context("make the folder for the new manifests")?;

    // Every picture any written line needs, read out of the file once.
    let wanted: Vec<&Group> = s.groups.iter().filter(|g| !s.skipped.contains(&g.key)).collect();
    if wanted.is_empty() {
        bail!("Every split is left out, so there is nothing to write.");
    }
    let rows: HashSet<u32> = wanted.iter().flat_map(|g| g.idx.iter()).map(|&i| s.t.abs_rows[s.lines[i].row]).collect();
    let im = &s.t.images;
    let mut need: Vec<String> = im.in_cell.iter().filter(|((r, _), _)| rows.contains(r)).map(|(_, m)| m.clone()).collect();
    need.extend(im.placed.iter().filter(|p| rows.contains(&p.row)).map(|p| p.media.clone()));
    need.sort();
    need.dedup();
    let bytes = if need.is_empty() { HashMap::new() } else { manifest_images::media_bytes(path, &need)? };
    let media: HashMap<String, rust_xlsxwriter::Image> = bytes.iter().filter_map(|(k, b)| xlsx_image(b).map(|i| (k.clone(), i))).collect();

    let stem = safe_name(Path::new(path).file_stem().and_then(|f| f.to_str()).unwrap_or("Manifest"), 80);
    let mut out = Vec::new();
    for g in wanted {
        let file = free_path(dir, &format!("{} ({})", stem, safe_name(&g.name, 60)), "xlsx");
        let data = write_split(&s, g, &media)?;
        std::fs::write(&file, data).with_context(|| format!("write {}", file.display()))?;

        let rule = &s.rules[&g.key];
        let mut price: Option<f64> = None;
        let mut cost: Option<f64> = None;
        let mut cats: Vec<(String, f64)> = Vec::new();
        for &i in &g.idx {
            let l = &s.lines[i];
            if let Some((_, e)) = price_of(l, rule, s.line_prices.get(&l.row).copied()) {
                price = Some(price.unwrap_or(0.0) + e);
            }
            if s.sheet_is_cost {
                if let Some(v) = l.sheet {
                    cost = Some(cost.unwrap_or(0.0) + v);
                }
            }
            // "Uncategorized" says nothing to a buyer: the storefront summary leaves it out.
            let name = &s.categories[i];
            if name == "Uncategorized" {
                continue;
            }
            match cats.iter_mut().find(|(n, _)| n == name) {
                Some(e) => e.1 += l.qty,
                None => cats.push((name.clone(), l.qty)),
            }
        }
        cats.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut photos = Vec::new();
        if for_lots {
            let mut with: Vec<&Line> = g.idx.iter().map(|&i| &s.lines[i]).collect();
            with.sort_by(|a, b| b.retail.partial_cmp(&a.retail).unwrap_or(std::cmp::Ordering::Equal));
            let mut used = HashSet::new();
            for l in with {
                if photos.len() >= 6 {
                    break;
                }
                let abs_r = s.t.abs_rows[l.row];
                let m = im
                    .in_cell
                    .iter()
                    .find(|((r, _), _)| *r == abs_r)
                    .map(|(_, m)| m.clone())
                    .or_else(|| im.placed.iter().find(|p| p.row == abs_r).map(|p| p.media.clone()));
                let Some(m) = m else { continue };
                if !used.insert(m.clone()) {
                    continue;
                }
                let Some(b) = bytes.get(&m) else { continue };
                let (data, ext) = match image_kind(b) {
                    k @ ("png" | "jpg" | "gif" | "webp") => (b.clone(), k),
                    _ => match to_png(b) {
                        Some(p) => (p, "png"),
                        None => continue,
                    },
                };
                let p = free_path(dir, &format!("{} ({}) photo {}", stem, safe_name(&g.name, 60), photos.len() + 1), ext);
                if std::fs::write(&p, data).is_ok() {
                    photos.push(p.to_string_lossy().to_string());
                }
            }
        }

        out.push(ExportedSplit {
            key: g.key.clone(),
            name: g.name.clone(),
            file: file.to_string_lossy().to_string(),
            lines: g.idx.len(),
            units: g.idx.iter().map(|&i| s.lines[i].qty).sum(),
            retail: round2(g.idx.iter().map(|&i| s.lines[i].retail).sum()),
            price: price.map(round2),
            cost: cost.map(round2),
            photos,
            categories: cats.into_iter().map(|(name, q)| CategoryCount { name, quantity: q.round() as i64 }).collect(),
            category: s.plan.splits.iter().find(|x| x.key == g.key).and_then(|x| x.category.clone()),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("ecliptr-r379-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().to_string()
    }

    fn answers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    const PRICED_CSV: &str = "LOAD 4471 MANIFEST\n\
Item Description,Brand,Category,Qty,Unit Retail,Unit Cost\n\
Apple AirPods Pro,Apple,Electronics,4,249.00,29.88\n\
Apple Watch Band,APPLE,Electronics,10,49.00,5.88\n\
Nike Air Max 90,Nike,Footwear,2,130.00,15.60\n\
Nike Dri-Fit Tee,\"Nike, Inc.\",Apparel,6,35.00,4.20\n\
Ninja Blender BN701,Ninja,Home,3,99.00,11.88\n\
Total,,,25,,\n";

    #[test]
    fn brand_spellings_fold_into_one_key() {
        assert_eq!(brand_key("NIKE"), brand_key("Nike, Inc."));
        assert_eq!(brand_key("nike"), "nike");
        assert_eq!(brand_key("Black+Decker"), brand_key("Black & Decker"));
        assert_eq!(brand_key("Hamilton Beach Brands"), "hamilton beach");
        assert_eq!(brand_key("The North Face"), "north face");
        assert!(is_no_brand("N/A"));
        assert!(is_no_brand(" Unbranded "));
        assert!(look_alike("carhart", "carhartt"));
        assert!(look_alike("hamilton", "hamilton beach"));
        assert!(!look_alike("nike", "ninja"));
    }

    #[test]
    fn a_look_alike_merge_keeps_the_right_spelling() {
        let csv = "Description,Brand,Qty,Retail
Beanie,Carhartt,1,20
Gloves,Carhart,1,18
Hat,Nike,1,25
";
        let p = tmp("m.csv", csv.as_bytes());
        let plan = plan(&p, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert!(plan.questions.iter().any(|q| q.id.starts_with("merge:")));
        let names: Vec<&str> = plan.splits.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Carhartt"));
        assert!(!names.contains(&"Carhart"));
    }

    #[test]
    fn a_percent_of_retail_sheet_is_read_as_one() {
        let p = tmp("load.csv", PRICED_CSV.as_bytes());
        let plan = plan(&p, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert_eq!(plan.sheet_pricing.kind, "pct");
        assert_eq!(plan.sheet_pricing.pct, Some(12.0));
        let q = plan.questions.iter().find(|q| q.id == "pricing").unwrap();
        assert_eq!(q.answer, "pct");
        assert_eq!(q.value, Some(12.0));
        // The total row is not a product.
        assert_eq!(plan.totals.lines, 5);
    }

    #[test]
    fn splits_by_brand_add_back_up_to_the_whole() {
        let p = tmp("load.csv", PRICED_CSV.as_bytes());
        let plan = plan(&p, &answers(&[("small", "keep")]), &SplitEdits::default()).unwrap();
        assert!(plan.reconciles);
        let names: Vec<&str> = plan.splits.iter().map(|s| s.name.as_str()).collect();
        // APPLE and Apple are one brand; "Nike, Inc." and Nike are one brand.
        assert_eq!(names, vec!["Apple", "Nike", "Ninja"]);
        let units: f64 = plan.splits.iter().map(|s| s.units).sum();
        assert_eq!(units, plan.totals.units);
        let retail: f64 = plan.splits.iter().map(|s| s.retail).sum();
        assert!((retail - plan.totals.retail).abs() < 0.01);
        // 12% of Apple's retail (4 x 249 + 10 x 49 = 1,486).
        assert_eq!(plan.splits[0].price, Some(178.32));
    }

    #[test]
    fn a_unit_priced_sheet_is_read_as_one() {
        let csv = "Description,Brand,Qty,Retail,Price Each\nA hat,Nike,2,20,5\nA cap,Nike,3,25,5\nA bag,Coach,1,90,5\nSocks,Hanes,10,8,5\n";
        let p = tmp("u.csv", csv.as_bytes());
        let plan = plan(&p, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert_eq!(plan.sheet_pricing.kind, "unit");
        assert_eq!(plan.sheet_pricing.unit, Some(5.0));
    }

    #[test]
    fn brands_are_read_from_titles_when_there_is_no_brand_column() {
        let mut csv = String::from("Description,Qty,Retail\n");
        for i in 0..4 {
            csv.push_str(&format!("Samsung Galaxy Buds {},1,99\n", i));
            csv.push_str(&format!("Men's Nike Air Max {},1,120\n", i));
            csv.push_str(&format!("Zorbex Widget {},1,15\n", i));
        }
        csv.push_str("Blue plastic bowl,1,5\n");
        let p = tmp("t.csv", csv.as_bytes());
        let plan = plan(&p, &answers(&[("small", "keep")]), &SplitEdits::default()).unwrap();
        let q = plan.questions.iter().find(|q| q.id == "read_brands").unwrap();
        assert_eq!(q.answer, "yes");
        let names: HashSet<&str> = plan.splits.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains("Samsung"));
        assert!(names.contains("Nike"));
        // Not a known brand, but it starts four titles.
        assert!(names.contains("Zorbex"));
        assert!(plan.reconciles);
    }

    #[test]
    fn a_known_brand_that_starts_with_a_filler_word_is_still_read() {
        let mut csv = String::from("Description,Qty,Retail\n");
        for i in 0..3 {
            csv.push_str(&format!("New Balance 574 Sneakers {},1,90\n", i));
            csv.push_str(&format!("The North Face Fleece {},1,120\n", i));
            csv.push_str(&format!("New Nike Air Max {},1,110\n", i));
        }
        let p = tmp("nb.csv", csv.as_bytes());
        let plan = plan(&p, &answers(&[("small", "keep")]), &SplitEdits::default()).unwrap();
        let names: HashSet<&str> = plan.splits.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains("New Balance"), "{:?}", names);
        assert!(names.contains("The North Face"), "{:?}", names);
        assert!(names.contains("Nike"), "{:?}", names);
        assert!(plan.reconciles);
    }

    #[test]
    fn small_brands_fold_into_mixed() {
        let mut csv = String::from("Description,Brand,Qty,Retail\n");
        csv.push_str("Big thing,Alpha,1,1000\nBig thing 2,Beta,1,1000\n");
        csv.push_str("Tiny,Gamma,1,5\nTiny,Delta,1,5\nTiny,Epsilon,1,5\n");
        let p = tmp("s.csv", csv.as_bytes());
        let plan = plan(&p, &HashMap::new(), &SplitEdits::default()).unwrap();
        let names: Vec<&str> = plan.splits.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Beta", "Mixed"]);
        assert_eq!(plan.splits[2].lines, 3);
    }

    #[test]
    fn edits_rename_combine_and_price_a_line() {
        let p = tmp("load.csv", PRICED_CSV.as_bytes());
        let mut e = SplitEdits::default();
        e.combine.insert("b:ninja".into(), "b:nike".into());
        e.names.insert("b:nike".into(), "Nike and Ninja".into());
        e.pricing.insert("b:apple".into(), PriceRule { mode: "unit".into(), value: Some(10.0) });
        let plan = plan(&p, &answers(&[("small", "keep")]), &e).unwrap();
        assert_eq!(plan.splits.len(), 2);
        assert_eq!(plan.splits[1].name, "Nike and Ninja");
        assert_eq!(plan.splits[0].price, Some(140.0)); // 14 units x $10
        assert!(plan.reconciles);
        let ls = lines(&p, &answers(&[("small", "keep")]), &e, "b:apple").unwrap();
        let mut e2 = e.clone();
        e2.line_prices.insert(ls[0].row.to_string(), 20.0);
        let plan2 = plan_fn(&p, &e2);
        assert_eq!(plan2.splits[0].price, Some(4.0 * 20.0 + 10.0 * 10.0));
    }

    fn plan_fn(p: &str, e: &SplitEdits) -> SplitPlan {
        plan(p, &answers(&[("small", "keep")]), e).unwrap()
    }

    fn png(r: u8) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(8, 8, image::Rgb([r, 20, 30]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageOutputFormat::Png).unwrap();
        out.into_inner()
    }

    /// A workbook with a picture in a cell on one line and a picture placed over another,
    /// split by brand: each picture lands in its own line's file, in the same kind of
    /// place, and the supplier's cost never reaches a file written without prices.
    #[test]
    fn photos_travel_with_their_lines_and_cost_stays_out() {
        use rust_xlsxwriter::{Image, Workbook};
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Manifest").unwrap();
        for (c, h) in ["Photo", "Description", "Brand", "Qty", "Retail", "Cost"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        let rows = [("Apple AirPods", "Apple", 2.0, 249.0, 29.88), ("Nike Air Max", "Nike", 1.0, 130.0, 15.6), ("Apple Watch", "Apple", 1.0, 399.0, 47.88)];
        for (i, (d, b, q, r, cost)) in rows.iter().enumerate() {
            let row = i as u32 + 1;
            ws.write_string(row, 1, *d).unwrap();
            ws.write_string(row, 2, *b).unwrap();
            ws.write_number(row, 3, *q).unwrap();
            ws.write_number(row, 4, *r).unwrap();
            ws.write_number(row, 5, *cost).unwrap();
            ws.set_row_height(row, 60).unwrap();
        }
        ws.set_column_width(0, 14).unwrap();
        ws.embed_image(1, 0, &Image::new_from_buffer(&png(200)).unwrap()).unwrap();
        ws.insert_image(2, 0, &Image::new_from_buffer(&png(100)).unwrap()).unwrap();
        let src = tmp("photos.xlsx", &wb.save_to_buffer().unwrap());

        let idx = manifest_images::read(&src, "Manifest");
        assert!(idx.readable);
        assert_eq!(idx.in_cell.len(), 1, "the in-cell picture is found");
        assert_eq!(idx.placed.len(), 1, "the placed picture is found");
        assert_eq!(idx.placed[0].row, 2);
        assert_eq!(idx.row_heights.get(&1), Some(&60.0));

        let a = answers(&[("small", "keep"), ("show_price", "no")]);
        let plan = plan(&src, &a, &SplitEdits::default()).unwrap();
        assert_eq!(plan.photos.in_cell, 1);
        assert_eq!(plan.photos.placed, 1);
        assert_eq!(plan.photos.lines_with_photo, 2);

        let dir = std::env::temp_dir().join(format!("ecliptr-r379-out-{}", uuid::Uuid::new_v4().simple()));
        let out = export(&src, &a, &SplitEdits::default(), &dir, true).unwrap();
        assert_eq!(out.len(), 2);
        let apple = out.iter().find(|o| o.name == "Apple").unwrap();
        let nike = out.iter().find(|o| o.name == "Nike").unwrap();
        assert_eq!(apple.photos.len(), 1);
        assert_eq!(nike.photos.len(), 1);
        assert_eq!(apple.cost, Some(107.64)); // 2 x 29.88 + 47.88

        // Apple's file keeps its in-cell picture in a cell; Nike's keeps its placed one.
        let a_idx = manifest_images::read(&apple.file, "Apple");
        assert_eq!(a_idx.in_cell.len(), 1);
        assert_eq!(a_idx.placed.len(), 0);
        assert!(a_idx.in_cell.contains_key(&(1, 0)));
        assert_eq!(a_idx.row_heights.get(&1), Some(&60.0));
        let n_idx = manifest_images::read(&nike.file, "Nike");
        assert_eq!(n_idx.placed.len(), 1);
        assert_eq!(n_idx.placed[0].row, 1);

        // No cost anywhere in a file written without prices.
        use calamine::Reader;
        let mut book = calamine::open_workbook_auto(&apple.file).unwrap();
        let range = book.worksheet_range("Apple").unwrap();
        let text: Vec<String> = range.rows().flat_map(|r| r.iter().map(|c| c.to_string())).collect();
        assert!(!text.iter().any(|c| c == "Cost" || c == "29.88" || c == "47.88"));
        assert!(text.iter().any(|c| c == "Apple AirPods"));
        assert!(!text.iter().any(|c| c == "Nike Air Max"));

        // Nothing is overwritten: a second export writes new names beside the first.
        let again = export(&src, &a, &SplitEdits::default(), &dir, false).unwrap();
        assert!(again.iter().all(|o| !out.iter().any(|x| x.file == o.file)));
    }

    #[test]
    fn columns_that_read_like_costs_stay_off_the_files_unless_put_back() {
        use calamine::Reader;
        let csv = "Description,Brand,Qty,Retail,Freight,Vendor,Color
Hat,Nike,2,25,3.10,Acme Liquidators,Red
Cap,Nike,1,20,1.55,Acme Liquidators,Blue
Bag,Coach,1,90,4.00,Acme Liquidators,Tan
";
        let p = tmp("f.csv", csv.as_bytes());
        let a = answers(&[("show_price", "no")]);
        let plan = plan(&p, &a, &SplitEdits::default()).unwrap();
        let roles: Vec<(&str, &str, bool)> = plan.columns.iter().map(|c| (c.header.as_str(), c.role.as_str(), c.hidden)).collect();
        assert!(roles.contains(&("Freight", "internal", true)));
        assert!(roles.contains(&("Vendor", "internal", true)));
        assert!(roles.contains(&("Color", "", false)));
        let dir = std::env::temp_dir().join(format!("ecliptr-r379-out-{}", uuid::Uuid::new_v4().simple()));
        let out = export(&p, &a, &SplitEdits::default(), &dir, false).unwrap();
        let mut book = calamine::open_workbook_auto(&out[0].file).unwrap();
        let name = book.sheet_names()[0].clone();
        let text: Vec<String> = book.worksheet_range(&name).unwrap().rows().flat_map(|r| r.iter().map(|c| c.to_string())).collect();
        assert!(!text.iter().any(|c| c == "Freight" || c == "3.1" || c == "Acme Liquidators"));
        assert!(text.iter().any(|c| c == "Color"));
        // Put back by hand, it is written.
        let mut e = SplitEdits::default();
        e.show_cols.push(4);
        let out = export(&p, &a, &e, &dir, false).unwrap();
        let mut book = calamine::open_workbook_auto(&out[0].file).unwrap();
        let text: Vec<String> = book.worksheet_range(&name).unwrap().rows().flat_map(|r| r.iter().map(|c| c.to_string())).collect();
        assert!(text.iter().any(|c| c == "Freight"));
    }

    #[test]
    fn a_line_the_sheet_left_unpriced_is_counted_not_hidden() {
        let csv = "Description,Brand,Qty,Retail,Cost
Hat,Nike,2,25,5
Cap,Nike,1,20,
Bag,Coach,1,90,20
Belt,Coach,1,40,7
";
        let p = tmp("u2.csv", csv.as_bytes());
        let plan = plan(&p, &answers(&[("pricing", "sheet")]), &SplitEdits::default()).unwrap();
        let nike = plan.splits.iter().find(|s| s.name == "Nike").unwrap();
        assert_eq!(nike.unpriced, 1);
        assert_eq!(nike.price, Some(10.0));
    }

    #[test]
    fn prices_replace_the_sheet_cost_when_shown() {
        use calamine::Reader;
        let p = tmp("load.csv", PRICED_CSV.as_bytes());
        let mut e = SplitEdits::default();
        e.pricing.insert("b:apple".into(), PriceRule { mode: "pct".into(), value: Some(20.0) });
        let dir = std::env::temp_dir().join(format!("ecliptr-r379-out-{}", uuid::Uuid::new_v4().simple()));
        let out = export(&p, &answers(&[("small", "keep")]), &e, &dir, false).unwrap();
        let apple = out.iter().find(|o| o.name == "Apple").unwrap();
        let mut book = calamine::open_workbook_auto(&apple.file).unwrap();
        let range = book.worksheet_range("Apple").unwrap();
        let rows: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(|c| c.to_string()).collect()).collect();
        assert_eq!(rows[0][5], "Unit price");
        assert_eq!(rows[1][5], "49.8"); // 20% of 249
        assert!(!rows.iter().flatten().any(|c| c == "29.88"));
        // The total row: units and the price.
        let last = rows.last().unwrap();
        assert_eq!(last[0], "Total");
        assert_eq!(last[3], "14");
    }

    // ── R-396: every way the reading went wrong, each pinned ────────────────────────

    fn plan_of(csv: &str, a: &[(&str, &str)]) -> SplitPlan {
        plan(&tmp("r396.csv", csv.as_bytes()), &answers(a), &SplitEdits::default()).unwrap()
    }
    fn split_names(p: &SplitPlan) -> Vec<(String, usize)> {
        p.splits.iter().map(|s| (s.name.clone(), s.lines)).collect()
    }
    fn role(p: &SplitPlan, header: &str) -> String {
        p.columns.iter().find(|c| c.header == header).map(|c| c.role.clone()).unwrap_or_else(|| "missing".into())
    }

    /// The owner's own case, in invented titles: a sneaker and apparel load with no brand
    /// or category column. Before, most of it was Uncategorized, "Game" shorts were Toys and
    /// "Air Jordan" lines had no brand.
    #[test]
    fn a_sneaker_and_apparel_load_is_read_by_category_and_brand() {
        let csv = "Name,UPC/SKU,Quantity,Value,Total Value\n\
Air Jordan 1 Mid 'Chicago Black Toe' - 10.5,AB1234 100,2,125,250\n\
Air Jordan 1 Mid 'Chicago Black Toe' - 11,AB1234 100,1,125,125\n\
Nike Dri-FIT Game Classic 8\" Shorts - L,CD5678 010,4,35,140\n\
Nike Court Royale, White/Black - 9,EF9012 101,3,65,195\n\
TD Jordan Flight Club '91 - 8C,GH3456 001,2,60,120\n\
Jordan Jumpman Fleece Hoodie - XL,JK7890 010,5,70,350\n\
Everyday Elevated Crew Socks (3 Pairs) - M,LM1234 902,6,22,132\n\
Nike Heritage Drawstring Bag (13L),NP5678 010,3,18,54\n\
TOTAL,,26,,1366\n";
        let p = plan_of(csv, &[("split_by", "category")]);
        let names = split_names(&p);
        assert!(names.contains(&("Shoes".into(), 4)), "{names:?}");
        assert!(names.iter().any(|(n, c)| n == "Clothing" && *c == 3), "{names:?}");
        assert!(!names.iter().any(|(n, _)| n == "Toys" || n == "Uncategorized"), "{names:?}");
        let b = plan_of(csv, &[("split_by", "brand"), ("small", "keep"), ("blank", "own")]);
        let brands = split_names(&b);
        assert!(brands.contains(&("Jordan".into(), 4)), "{brands:?}");
        assert!(!brands.iter().any(|(n, _)| ["TD", "Everyday", "Air"].contains(&n.as_str())), "{brands:?}");
        // The TOTAL row is left out and said.
        assert_eq!(p.totals.lines, 8);
        assert!(p.notes.iter().any(|n| n.contains("total row")), "{:?}", p.notes);
    }

    /// The analyzer's breakdown is the split's own reading: same lines, units and retail,
    /// even with an unpriced line, a total row and a repeated header.
    #[test]
    fn the_breakdown_and_the_split_read_one_file_one_way() {
        let csv = "Description,Qty,Unit Retail\n\
Nike Air Max 90 Mens 10,2,130\n\
Nike Club Fleece Pants - S,7,\n\
Description,Qty,Unit Retail\n\
Adidas Samba OG Womens 8,3,100\n\
PALLET 2\n\
Hanes Crew Tee 6 Pack - L,4,20\n\
Total,16,640\n";
        let path = tmp("parity.csv", csv.as_bytes());
        let b = breakdown(&path).unwrap();
        let p = plan(&path, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert_eq!(b.lines.len(), 4);
        assert_eq!(p.totals.lines, 4);
        let units: f64 = b.lines.iter().map(|l| l.qty).sum();
        assert_eq!(units, 16.0);
        assert_eq!(p.totals.units, 16.0);
        let retail: f64 = b.lines.iter().map(|l| l.retail).sum();
        assert!((retail - 640.0).abs() < 0.01 && (p.totals.retail - 640.0).abs() < 0.01);
        let left = b.left_out.unwrap();
        assert!(left.contains("total row") && left.contains("repeated header") && left.contains("PALLET 2"), "{left}");
    }

    #[test]
    fn a_product_named_total_or_discontinued_is_kept() {
        let csv = "Description,Qty,Unit Retail\n\
Total Gym Fitness System XLS,1,499\n\
Nike Air Force 1 Low Discontinued Colorway 9,2,110\n\
Composition Notebook 200 Page Wide Ruled,6,4.99\n\
Totally Awesome Slime Kit,3,12\n\
Pallet 1 Total,12,\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.totals.lines, 4, "{:?}", p.notes);
    }

    /// Retail beside the load's price: the retail column is retail, whichever comes first.
    #[test]
    fn a_price_beside_retail_is_the_loads_price_not_retail() {
        let csv = "Description,Qty,Price,Retail\nNike Air Max 90 Mens 10,2,26,130\nAdidas Samba OG Womens 8,3,20,100\n";
        let path = tmp("price.csv", csv.as_bytes());
        let b = breakdown(&path).unwrap();
        assert_eq!(b.price_col.as_deref(), Some("Retail"));
        let p = plan(&path, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert!((p.totals.retail - 560.0).abs() < 0.01);
        assert_eq!(p.sheet_pricing.kind, "pct");
    }

    #[test]
    fn codes_links_and_types_are_never_the_description() {
        for header in ["Item #,Model Name,Qty,Retail", "Product Link,Product Title,Qty,Retail", "Product Type,Product Title,Qty,Retail"] {
            let csv = format!("{header}\n100234,Nike Air Zoom Pegasus 41 Road Running Shoes,2,140\n100235,Adidas Tiro 24 Training Pants,3,50\n");
            let csv = csv.replace("100234,", if header.starts_with("Product Link") { "https://example.com/a," } else if header.starts_with("Product Type") { "Shoes," } else { "100234," })
                .replace("100235,", if header.starts_with("Product Link") { "https://example.com/b," } else if header.starts_with("Product Type") { "Apparel," } else { "100235," });
            let p = plan_of(&csv, &[]);
            let want = header.split(',').nth(1).unwrap();
            assert_eq!(role(&p, want), "description", "{header}: {:?}", p.columns);
        }
    }

    #[test]
    fn a_vendor_column_is_the_supplier_not_the_brand() {
        let csv = "Description,Vendor,Qty,Retail\nNike Air Max 90 Mens 10,Acme Liquidators,2,130\nNike Pegasus 41 Mens 9,Acme Liquidators,1,140\nAdidas Samba OG 8,Acme Liquidators,3,100\nAdidas Gazelle 7,Acme Liquidators,1,100\n";
        let p = plan_of(csv, &[("split_by", "brand")]);
        assert_eq!(role(&p, "Vendor"), "internal");
        let names = split_names(&p);
        assert!(names.iter().any(|(n, _)| n == "Nike") && names.iter().any(|(n, _)| n == "Adidas"), "{names:?}");
    }

    /// One real brand and a pile of unbranded lines still splits, with no false message.
    #[test]
    fn one_brand_and_unbranded_lines_can_still_be_split() {
        let mut csv = String::from("Description,Qty,Retail\n");
        for i in 0..20 {
            csv.push_str(&format!("Nike Club Tee {i} - M,1,30\n"));
        }
        for i in 0..8 {
            csv.push_str(&format!("Plain Cotton Tee {i} - M,1,10\n"));
        }
        let p = plan_of(&csv, &[("split_by", "brand")]);
        assert!(p.questions.iter().any(|q| q.id == "split_by" && q.choices.iter().any(|c| c.id == "brand")));
    }

    #[test]
    fn two_real_brands_that_look_alike_default_to_apart() {
        let mut csv = String::from("Description,Brand,Qty,Retail\n");
        for i in 0..6 {
            csv.push_str(&format!("Robot Vacuum {i},Shark,1,200\nMicrowave {i},Sharp,1,150\n"));
        }
        let p = plan_of(&csv, &[]);
        let q = p.questions.iter().find(|q| q.id.starts_with("merge:")).unwrap();
        assert_eq!(q.answer, "no");
    }

    #[test]
    fn placeholder_categories_fall_back_to_the_title() {
        let csv = "Description,Category,Qty,Retail\n\
Adidas Tiro 24 Training Pants,,1,50\n\
Crocs Classic Clog Navy 9,N/A,1,50\n\
Puma Suede Classic Sneakers 10,Unknown,1,70\n\
Champion Powerblend Crew Sweatshirt - L,Other,1,45\n\
Sony WH-1000XM5 Headphones,Electronics,1,350\n";
        let p = plan_of(csv, &[("split_by", "category")]);
        let names = split_names(&p);
        assert!(!names.iter().any(|(n, _)| ["N/A", "Unknown", "Other", "Uncategorized"].contains(&n.as_str())), "{names:?}");
        assert!(names.contains(&("Clothing".into(), 2)) && names.contains(&("Shoes".into(), 2)), "{names:?}");
    }

    #[test]
    fn quantities_written_as_text_are_read() {
        let csv = "Description,Qty,Unit Retail\nNike Air Max 90 Mens 10,5 pcs,130\nNike Dri-FIT Shorts - M,4 EA,35\nAdidas Samba OG 8,x3,100\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.totals.units, 12.0);
    }

    #[test]
    fn a_pricing_note_is_read_with_its_whole_number() {
        let csv = "Priced at 100% of retail\nDescription,Qty,Retail\nNike Air Max 90 Mens 10,2,130\nAdidas Samba OG 8,3,100\n";
        assert_eq!(plan_of(csv, &[]).sheet_pricing.kind, "none");
        let csv = "All items $5 each\nDescription,Qty,Retail\nNike Air Max 90 Mens 10,2,130\nAdidas Samba OG 8,3,100\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.sheet_pricing.kind, "unit");
        assert_eq!(p.sheet_pricing.unit, Some(5.0));
    }

    /// A flat % that does not reproduce the sheet's own total is not the sheet's pricing:
    /// it would sell the dearer lines below cost.
    #[test]
    fn a_flat_percent_with_outliers_keeps_each_lines_own_price() {
        let mut csv = String::from("Description,Brand,Qty,Retail,Price\n");
        for i in 0..9 {
            csv.push_str(&format!("Item {i} Tee - M,{},1,100,10\n", if i % 2 == 0 { "Nike" } else { "Adidas" }));
        }
        csv.push_str("Big Item Jacket - L,Nike,1,1000,250\n");
        assert_eq!(plan_of(&csv, &[]).sheet_pricing.kind, "line");
    }

    #[test]
    fn a_margin_or_markup_column_is_not_the_sheets_price() {
        let csv = "Description,Qty,Retail,Markup %\nNike Air Max 90 Mens 10,2,130,150%\nAdidas Samba OG 8,3,100,150%\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.sheet_pricing.kind, "none");
        assert_ne!(role(&p, "Markup %"), "sheet_pct");
    }

    /// A line with no retail has no % of retail: unpriced, never $0.
    #[test]
    fn a_line_with_no_retail_is_unpriced_under_a_percent() {
        let csv = "Description,Brand,Qty,Retail\nNike Club Fleece Pants - S,Nike,7,\nNike Air Max 90 Mens 10,Nike,2,130\nAdidas Samba OG 8,Adidas,3,100\n";
        let p = plan_of(csv, &[("split_by", "brand"), ("pricing", "pct"), ("pricing_value", "20")]);
        let nike = p.splits.iter().find(|s| s.name == "Nike").unwrap();
        assert_eq!(nike.unpriced, 1);
    }

    #[test]
    fn a_cleared_percent_box_means_no_number_yet() {
        let csv = "Description,Qty,Retail,Price\nNike Air Max 90 Mens 10,2,130,15.60\nAdidas Samba OG 8,3,100,12\n";
        let p = plan_of(csv, &[("pricing", "pct"), ("pricing_value", "")]);
        assert_eq!(p.questions.iter().find(|q| q.id == "pricing").unwrap().value, None);
    }

    /// Many small brands: the 12 biggest stay their own and the rest can fold, but a fold
    /// that would make Mixed the biggest manifest is not the suggestion.
    #[test]
    fn a_long_tail_keeps_the_twelve_biggest() {
        let mut csv = String::from("Description,Brand,Qty,Retail\n");
        let names = ["Acme", "Bolt", "Crest", "Delta", "Echo", "Fable", "Gamma", "Halo", "Ivory", "Juno", "Kilo", "Lumen", "Mango",
            "Nova", "Orbit", "Pixel", "Quill", "Rune", "Sable", "Tango", "Violet", "Willow", "Xenon", "Yarrow", "Zephyr",
            "Birch", "Cedar", "Dune", "Fjord", "Grove"];
        for (b, n) in names.iter().enumerate() {
            csv.push_str(&format!("Widget {b},{n} Home,1,{}\n", 100 + b));
        }
        let p = plan_of(&csv, &[("split_by", "brand")]);
        let q = p.questions.iter().find(|q| q.id == "small").unwrap();
        assert_eq!(q.answer, "keep", "{}", q.text);
        let p = plan_of(&csv, &[("split_by", "brand"), ("small", "mixed")]);
        let live = p.splits.iter().filter(|s| !s.skipped).count();
        assert_eq!(live, 13, "{:?}", split_names(&p));
    }

    #[test]
    fn a_column_with_no_header_is_left_out_of_the_files() {
        let csv = "Description,Qty,Retail,\nNike Air Max 90 Mens 10,2,130,paid 40%\nAdidas Samba OG 8,3,100,2+1\n";
        let p = plan_of(csv, &[]);
        let c = p.columns.iter().find(|c| c.header == "Column 4").unwrap();
        assert!(c.hidden);
    }

    #[test]
    fn category_spellings_fold_into_one() {
        assert_eq!(category_group_key("Health/Beauty"), category_group_key("Health & Beauty"));
        assert_eq!(category_group_key("Shoe"), category_group_key("Shoes"));
        assert_eq!(category_group_key("Footwear"), category_group_key("Shoes"));
        assert_eq!(category_group_key("Home Goods"), category_group_key("HomeGoods"));
        assert_eq!(brand_key("Levi Strauss & Co."), brand_key("Levi Strauss"));
        assert!(is_no_brand("Unknown Brand") && is_no_brand("Not Listed") && is_no_brand("nan") && is_no_brand("Private Label"));
        assert!(!is_no_brand("Nike"));
    }

    /// A CSV whose description has unquoted commas is put back together.
    #[test]
    fn unquoted_commas_in_a_description_are_put_back() {
        let csv = "Description,Brand,Qty,Unit Retail\nNike Air Max 90,Nike,2,130\nNike Club Fleece Pants, Grey, Size L,Nike,3,60\nAdidas Samba OG,Adidas,1,100\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.totals.units, 6.0);
        assert!((p.totals.retail - 540.0).abs() < 0.01, "{}", p.totals.retail);
    }

    #[test]
    fn a_csv_named_xls_is_read_as_text() {
        let csv = "Description,Qty,Retail\nNike Air Max 90 Mens 10,2,130\nAdidas Samba OG 8,3,100\n";
        let path = tmp("really-a.xls", csv.as_bytes());
        let p = plan(&path, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert_eq!(p.totals.lines, 2);
        assert!(p.notes.iter().any(|n| n.contains("really")), "{:?}", p.notes);
    }

    /// Merged cells: a category merged down several lines is on every one of them.
    #[test]
    fn a_merged_category_reaches_every_line_it_covers() {
        use rust_xlsxwriter::{Format, Workbook};
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in ["Description", "Category", "Qty", "Retail"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        let rows = [("Nike Air Max 90", 2.0, 130.0), ("Adidas Samba OG", 1.0, 100.0), ("Puma Suede", 1.0, 70.0), ("Nike Club Tee", 3.0, 30.0)];
        for (i, (d, q, r)) in rows.iter().enumerate() {
            ws.write_string(i as u32 + 1, 0, *d).unwrap();
            ws.write_number(i as u32 + 1, 2, *q).unwrap();
            ws.write_number(i as u32 + 1, 3, *r).unwrap();
        }
        ws.merge_range(1, 1, 3, 1, "Footwear", &Format::new()).unwrap();
        ws.write_string(4, 1, "Apparel").unwrap();
        let path = tmp("merged.xlsx", &wb.save_to_buffer().unwrap());
        let p = plan(&path, &answers(&[("split_by", "category")]), &SplitEdits::default()).unwrap();
        let names = split_names(&p);
        assert!(names.contains(&("Footwear".into(), 3)) && names.contains(&("Apparel".into(), 1)), "{names:?}");
    }

    /// A pallet a sheet: sheets with the same header are read together, with a Sheet column.
    #[test]
    fn sheets_with_one_header_are_read_together() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        for (n, lines) in [("Pallet 1", 3), ("Pallet 2", 4), ("Pallet 3", 2)] {
            let ws = wb.add_worksheet();
            ws.set_name(n).unwrap();
            for (c, h) in ["Description", "Qty", "Retail"].iter().enumerate() {
                ws.write_string(0, c as u16, *h).unwrap();
            }
            for i in 0..lines {
                ws.write_string(i + 1, 0, format!("Nike Club Tee {n} {i} - M")).unwrap();
                ws.write_number(i + 1, 1, 2.0).unwrap();
                ws.write_number(i + 1, 2, 30.0).unwrap();
            }
        }
        let path = tmp("pallets.xlsx", &wb.save_to_buffer().unwrap());
        let b = breakdown(&path).unwrap();
        assert_eq!(b.lines.len(), 9);
        let p = plan(&path, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert_eq!(p.totals.lines, 9);
        assert!(p.columns.iter().any(|c| c.header == "Sheet"));
        let p = plan(&path, &answers(&[("sheet", "Pallet 2")]), &SplitEdits::default()).unwrap();
        assert_eq!(p.totals.lines, 4);
    }

    #[test]
    fn a_description_header_with_a_code_word_is_still_the_description() {
        for h in ["SKU Description", "UPC Description", "ASIN Title", "Item # Description"] {
            let csv = format!("{h},Qty,Retail\nNike Air Max 90 Mens 10,2,130\nAdidas Samba OG Womens 8,3,100\n");
            let p = plan_of(&csv, &[]);
            assert_eq!(role(&p, h), "description", "{h}");
        }
    }

    #[test]
    fn a_sheet_of_titles_alone_is_still_read() {
        let csv = "Description,Brand\nNike Air Max 90 Mens 10,Nike\nAdidas Samba OG 8,Adidas\nSony WH-1000XM5 Headphones,Sony\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.totals.lines, 3);
    }

    #[test]
    fn a_vendor_column_of_real_brands_is_the_brand_column() {
        let csv = "Description,Vendor,Qty,Retail\nAir Max 90 Mens 10,Nike,2,130\nWH-1000XM5 Headphones,Sony,1,350\nGalaxy Buds 2,Samsung,3,100\nSamba OG 8,Adidas,1,100\n";
        let p = plan_of(csv, &[("split_by", "brand")]);
        assert_eq!(role(&p, "Vendor"), "brand");
    }

    #[test]
    fn a_class_column_of_category_names_is_the_category_column() {
        let csv = "Description,Class,Qty,Retail\nAir Max 90 Mens 10,Shoes,2,130\nClub Tee - M,Apparel,1,30\nDrill Kit 20V,Tools,3,100\nThrow Pillow,Home,1,20\n";
        let p = plan_of(csv, &[]);
        assert_eq!(role(&p, "Class"), "category");
    }

    /// A block of load details above the real header does not take its place.
    #[test]
    fn a_block_of_load_details_above_the_header_is_not_the_header() {
        let csv = "Lot ID,Item Count,Retail Value,Vendor\nL4471,2,230,ACME Liquidation\n\nDescription,Qty,Retail\nNike Air Max 90 Mens 10,1,130\nAdidas Samba OG 8,1,100\n";
        let p = plan_of(csv, &[]);
        assert_eq!(p.totals.lines, 2);
        assert_eq!(role(&p, "Description"), "description");
    }

    /// A multi-page export repeats its header: the first one is the header, and the repeat
    /// is left out, so no page is lost.
    #[test]
    fn a_repeated_header_does_not_hide_the_first_page() {
        let mut csv = String::from("Description,Qty,Retail\n");
        for i in 0..12 {
            csv.push_str(&format!("Nike Club Tee {i} - M,1,30\n"));
        }
        csv.push_str("Description,Qty,Retail\n");
        for i in 0..12 {
            csv.push_str(&format!("Adidas Tee {i} - M,1,30\n"));
        }
        let p = plan_of(&csv, &[]);
        assert_eq!(p.totals.lines, 24);
    }

    /// Rows hidden on the sheet (filtered out: sold, set aside) are asked about and left
    /// out by default.
    #[test]
    fn hidden_rows_are_left_out_unless_kept() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in ["Description", "Brand", "Qty", "Retail"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        let rows = [("Nike Air Max 90", "Nike"), ("Adidas Samba OG", "Adidas"), ("Puma Suede", "Puma"), ("Nike Club Tee", "Nike")];
        for (i, (d, b)) in rows.iter().enumerate() {
            ws.write_string(i as u32 + 1, 0, *d).unwrap();
            ws.write_string(i as u32 + 1, 1, *b).unwrap();
            ws.write_number(i as u32 + 1, 2, 1.0).unwrap();
            ws.write_number(i as u32 + 1, 3, 50.0).unwrap();
        }
        ws.set_row_hidden(2).unwrap();
        let path = tmp("hidden.xlsx", &wb.save_to_buffer().unwrap());
        let p = plan(&path, &HashMap::new(), &SplitEdits::default()).unwrap();
        assert!(p.questions.iter().any(|q| q.id == "hidden_rows" && q.answer == "out"));
        assert_eq!(p.totals.lines, 3);
    }
}
