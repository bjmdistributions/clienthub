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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub index: usize,
    pub header: String,
    /// What it was read as. In a split plan: description, quantity, retail, retail_total,
    /// sheet_price, sheet_total, sheet_pct, category, brand, photo_links. In a breakdown
    /// (`Breakdown::columns`) the `ColumnMap` names: description, quantity, retail_unit,
    /// retail_ext, cost, sheet_price, category, brand, code, condition, photo. "" for
    /// everything else.
    pub role: String,
    pub hidden: bool,
    /// Up to three values from the column, so a column can be recognised at a glance.
    #[serde(default)]
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

// ── R-564: how a sheet is read, and what the reader says back ───────────────

/// How the analyzer reads a file when Jack has told it more than the defaults: which pages,
/// which sections, which columns, and his rules. `ReadOptions::default()` is the plain
/// reading `breakdown(path)` does.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReadOptions {
    /// The pages (sheets) to read as product lines. None: the default (every page that
    /// shares the best page's columns, else the best page).
    #[serde(default)]
    pub pages: Option<Vec<String>>,
    /// Section keys (`SectionInfo::key`) left out.
    #[serde(default)]
    pub sections_off: Vec<String>,
    /// His column map. When given it replaces column detection completely.
    #[serde(default)]
    pub columns: Option<ColumnMap>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Read the pages, sections and columns only: no products and no review groups. A
    /// cheap read for the column screen.
    #[serde(default)]
    pub resolve_only: bool,
}

/// Which column holds what. Columns are 0-based positions in the table as read (see
/// `Breakdown::columns`). When a map is given it replaces column detection completely.
/// Roles: description, quantity, retail_unit, retail_ext, cost (a
/// price or cost for one unit), sheet_price (a price for the whole line), category, brand,
/// code, condition, photo.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ColumnMap {
    /// 1-based sheet row the column names are on (like `Breakdown::header_row`); None when
    /// the sheet has no row of column names and its first row is data.
    #[serde(default)]
    pub header_row: Option<usize>,
    #[serde(default)]
    pub roles: HashMap<String, usize>,
}

/// One of his rules. `kind` is one of word, phrase, upc_prefix, sheet_category (a sheet's
/// own category value, mapped to his) or brand_word (a title word that names a brand).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub pattern: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
}

/// One sheet of the workbook (the one page of a CSV).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    pub name: String,
    pub rows: usize,
    /// lines | summary | pricing | totals | copy | empty
    pub kind: String,
    /// Whether it was read as product lines.
    pub read: bool,
    /// 1-based row the column names are on; 0 when there is none.
    pub header_row: usize,
    /// The page whose columns this one shares (the first of its group), when it shares any.
    pub same_header_as: Option<String>,
    /// Hidden in the workbook.
    #[serde(default)]
    pub hidden: bool,
}

/// What a page or a section states about itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stated {
    pub units: Option<f64>,
    pub retail: Option<f64>,
    /// The price of the whole load or section, when the source states one.
    #[serde(default)]
    pub price: Option<f64>,
    /// Where it was read: "the file name", "the total row", "the Summary page".
    pub source: String,
}

/// A stretch of one page that starts over (a pallet, a lot, a load). One per page when
/// the page has no breaks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionInfo {
    /// Stable key, "<page>#<n>", what `ReadOptions::sections_off` takes.
    pub key: String,
    pub page: String,
    pub name: String,
    /// 1-based sheet rows.
    pub first_row: usize,
    pub last_row: usize,
    pub lines: usize,
    pub units: f64,
    pub retail: f64,
    pub read: bool,
    pub stated: Option<Stated>,
}

/// A problem the reader found, to show before anything is saved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Check {
    /// red | amber
    pub severity: String,
    pub code: String,
    pub text: String,
    /// What opens to fix it: columns | lines | pages | none
    pub fix: String,
    /// Sheet rows concerned (capped).
    pub rows: Vec<usize>,
}

/// Every line that is the same product, rolled up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub key: String,
    pub title: String,
    pub code: String,
    pub brand: Option<String>,
    pub category: Option<String>,
    /// How the category was placed: sheet | rule | list | none
    pub placed: String,
    /// Units across all its rows.
    pub qty: f64,
    /// EXTENDED retail for the whole product (the sum over its rows, like
    /// `BreakdownLine::retail`); divide by `qty` for a price per unit.
    pub retail: f64,
    /// EXTENDED cost: the sheet's own price summed over its rows, when it has one; divide
    /// by `qty` for a cost per unit.
    pub cost: Option<f64>,
    /// 1-based sheet rows (on each row's own page).
    pub rows: Vec<usize>,
    pub lines: usize,
    /// A photo link, or "media:<name>" for a picture on the sheet (the first of its rows).
    pub picture: Option<String>,
    /// Positions in `Breakdown::lines`.
    #[serde(default)]
    pub line_ids: Vec<usize>,
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub section: String,
}

/// Lines that share something, offered to Jack to place (or name) once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub key: String,
    /// The kind of rule picking a category here would make: word | phrase | upc_prefix |
    /// brand_word.
    pub kind: String,
    pub pattern: String,
    pub label: String,
    pub lines: usize,
    pub units: f64,
    pub retail: f64,
    /// A category (or brand) to start from, when the lists had one.
    pub suggested: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Review {
    /// Lines placed by the list or not placed at all.
    pub groups: Vec<Group>,
    /// Lines with no brand, by the word their title opens with.
    pub brands: Vec<Group>,
    /// The categories a group can be placed in (the app's own list).
    #[serde(default)]
    pub category_names: Vec<String>,
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
    /// Every sheet of the workbook (the one page of a CSV), classified.
    pages: Vec<PageMeta>,
    /// With several sheets read together: the sheet each row came from (else empty).
    row_pages: Vec<String>,
    /// The file's name without its extension: a CSV's one page.
    stem: String,
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

/// A page's own figures, read from a summary, pricing or totals page.
#[derive(Debug, Clone, Default)]
struct Facts {
    units: Option<f64>,
    retail: Option<f64>,
    price: Option<f64>,
    /// Rows of a table that names one line per pallet or sheet: (label, units, retail, price).
    per_ref: Vec<(String, Option<f64>, Option<f64>, Option<f64>)>,
}

#[derive(Debug, Clone)]
struct PageMeta {
    name: String,
    rows: usize,
    /// lines | summary | pricing | totals | copy | empty
    kind: &'static str,
    hidden: bool,
    /// 1-based row the column names are on; 0 when none was found.
    header_row: usize,
    same_as: Option<String>,
    facts: Facts,
    /// The header's names, lowercased, for telling which pages share columns.
    head: Vec<String>,
}

/// Several sheets chosen by name travel in the sheet selector joined by this character.
const MANY: char = '\u{1f}';

const SUMMARY_NAMES: &[&str] = &["summary", "overview", "quick read", "pivot", "cover", "instructions", "notes", "readme",
    "info", "terms", "department", "sizing", "breakdown", "recap", "analysis", "stats", "dashboard", "index", "legend"];
const PRICING_NAMES: &[&str] = &["pricing", "price", "prices", "offer", "quote", "bid"];
const TOTALS_NAMES: &[&str] = &["total", "totals"];

fn norm_head(s: &str) -> String {
    hwords(s).join(" ")
}

fn head_names(row: &[String]) -> Vec<String> {
    let mut v: Vec<String> = row.iter().map(|c| norm_head(c)).filter(|c| !c.is_empty()).collect();
    v.sort();
    v.dedup();
    v
}

/// Two pages share columns when most of their column names are the same.
fn similar_heads(a: &[String], b: &[String]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let inter = a.iter().filter(|x| b.contains(x)).count();
    let union = a.len() + b.len() - inter;
    inter * 10 >= union * 6
}

fn content_hash(rows: &[Vec<Val>]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for r in rows.iter().take(300) {
        for c in r {
            for b in c.text().bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h ^= 0x1f;
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0x0a;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// What a fact label states: 'u' units, 'r' retail, 'p' the price of the whole page. `loose`
/// also accepts a bare "Price" or "Cost" (a one-row table's column).
fn fact_kind(label: &str, loose: bool) -> Option<char> {
    let w = hwords(label);
    if w.is_empty() || label.contains('%') || label.contains('/') {
        return None;
    }
    if hhas(&w, &["avg", "average", "per", "each", "unit retail", "route", "line items", "line item", "pallets", "pallet sheets"]) {
        return None;
    }
    if hhas(&w, &["msrp", "retail", "ext retail"]) {
        return Some('r');
    }
    if hhas(&w, &["total units", "units", "total qty", "total quantity", "total pieces", "pieces", "quantity", "qty"]) {
        return Some('u');
    }
    if hhas(&w, &["total cost", "total price", "sale price", "asking price", "asking", "offer", "lot price", "load price", "lot cost", "load cost"])
        || (loose && hhas(&w, &["price", "cost"]))
    {
        return Some('p');
    }
    None
}

/// Figures a summary, pricing or totals page states: label and value pairs ("Total units",
/// 49514), a one-row table ("UNITS, TOTAL MSRP" over 3290, 222338.43) and a table with a
/// row per pallet or sheet.
fn page_facts(rows: &[Vec<Val>]) -> Facts {
    let mut f = Facts::default();
    let set = |slot: &mut Option<f64>, v: f64| {
        if slot.is_none() && v > 0.0 {
            *slot = Some(v);
        }
    };
    let rows: Vec<&Vec<Val>> = rows.iter().take(400).collect();
    // Label and value pairs.
    for r in &rows {
        for (c, cell) in r.iter().enumerate() {
            let Val::Text(label) = cell else { continue };
            let Some(k) = fact_kind(label, false) else { continue };
            let value = r.iter().skip(c + 1).take(3).find_map(|v| match v { Val::Num(n) => Some(*n), _ => None });
            if let Some(v) = value {
                match k {
                    'u' => set(&mut f.units, v),
                    'r' => set(&mut f.retail, v),
                    _ => set(&mut f.price, v),
                }
            }
        }
    }
    // A table: a row naming two or more of the figures, and the rows under it.
    for (i, r) in rows.iter().enumerate() {
        let kinds: Vec<(usize, char)> = r
            .iter()
            .enumerate()
            .filter_map(|(c, v)| if let Val::Text(t) = v { fact_kind(t, true).map(|k| (c, k)) } else { None })
            .collect();
        // Two different labels (a merged title repeats one text across the row).
        let distinct: HashSet<String> = kinds.iter().filter_map(|(c, _)| if let Val::Text(t) = &r[*c] { Some(t.clone()) } else { None }).collect();
        if kinds.len() < 2 || distinct.len() < 2 {
            continue;
        }
        let before = (f.units, f.retail, f.price, f.per_ref.len());
        let body: Vec<&Vec<Val>> = rows[i + 1..]
            .iter()
            .copied()
            .take_while(|b| b.iter().any(|v| !matches!(v, Val::Empty)))
            .collect();
        let get = |b: &Vec<Val>, k: char| kinds.iter().find(|(_, kk)| *kk == k).and_then(|(c, _)| b.get(*c)).and_then(|v| match v { Val::Num(n) => Some(*n), _ => None });
        if body.len() == 1 {
            let b = body[0];
            for k in ['u', 'r', 'p'] {
                if let Some(v) = get(b, k) {
                    match k {
                        'u' => set(&mut f.units, v),
                        'r' => set(&mut f.retail, v),
                        _ => set(&mut f.price, v),
                    }
                }
            }
        } else {
            for b in body {
                let label = b.iter().find_map(|v| if let Val::Text(t) = v { Some(t.trim().to_string()) } else { None }).unwrap_or_default();
                let (u, rt, p) = (get(b, 'u'), get(b, 'r'), get(b, 'p'));
                if label.is_empty() || (u.is_none() && rt.is_none() && p.is_none()) {
                    continue;
                }
                let l = label.to_lowercase();
                if l == "total" || l == "grand total" || l.starts_with("total ") {
                    if let Some(v) = u { set(&mut f.units, v) }
                    if let Some(v) = rt { set(&mut f.retail, v) }
                    if let Some(v) = p { set(&mut f.price, v) }
                } else {
                    f.per_ref.push((label, u, rt, p));
                }
            }
        }
        if (f.units, f.retail, f.price, f.per_ref.len()) != before {
            break;
        }
    }
    f
}

/// What a sheet is: product lines, a summary, a pricing page, a totals page, a copy of
/// another page, or empty. Its name decides first (a page called "Summary & Pricing" is a
/// pricing page), unless it is a long list with a manifest's columns.
fn classify_page(name: &str, rows: &[Vec<Val>], text: &[Vec<String>], header: Option<usize>, score: usize) -> &'static str {
    if score == 0 {
        return "empty";
    }
    let nw = hwords(name);
    let named = if hhas(&nw, PRICING_NAMES) {
        Some("pricing")
    } else if hhas(&nw, TOTALS_NAMES) {
        Some("totals")
    } else if hhas(&nw, SUMMARY_NAMES) {
        Some("summary")
    } else {
        None
    };
    let head: Vec<Vec<String>> = header.map(|h| text[h].iter().map(|c| hwords(c)).collect()).unwrap_or_default();
    let has_desc = head.iter().any(|w| hhas(w, TITLE_HEADS) || hhas(w, DESC_HEADS));
    let has_count = head.iter().any(|w| hhas(w, COUNT_WORDS));
    if let Some(k) = named {
        if !(has_desc && has_count && score >= 150) {
            return k;
        }
    }
    let pivot_top = text.iter().take(8).any(|r| r.iter().any(|c| matches!(c.trim().to_lowercase().as_str(), "row labels" | "column labels")) || r.iter().any(|c| c.trim().to_lowercase().starts_with("sum of ")));
    if pivot_top {
        return "summary";
    }
    let Some(_) = header else {
        return if score >= 5 && rows.len() >= 5 { "lines" } else { "summary" };
    };
    let pivot = head.iter().any(|w| w.join(" ") == "row labels" || w.join(" ").starts_with("sum of") || w.join(" ").starts_with("count of"));
    if pivot {
        return "summary";
    }
    if !has_desc && score < 40 {
        return "summary";
    }
    "lines"
}

fn same_name(a: &str, b: &str) -> bool {
    norm_head(a) == norm_head(b)
}

fn read_table(path: &str, want_sheet: Option<&str>, hdr: Option<usize>) -> Result<Table> {
    let ext = manifest::extension(path);
    let file_name = Path::new(path).file_name().and_then(|f| f.to_str()).unwrap_or("manifest").to_string();
    let stem = Path::new(path).file_stem().and_then(|f| f.to_str()).unwrap_or("manifest").to_string();
    if ext == "pdf" {
        bail!("Splitting works on Excel and CSV manifests. This one is a PDF, so ask the supplier for the spreadsheet version.");
    }
    let named_excel = matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods");
    // A workbook saved with a .csv name is still a workbook.
    let sniffed = sniff_kind(path);
    let kind = if named_excel || sniffed == "excel" { sniffed } else { "text" };
    let excel = kind == "excel";
    let mut notes: Vec<String> = Vec::new();
    if named_excel && !excel {
        notes.push(format!("This .{} file is really {}, so it was read as that.", ext, if kind == "html" { "a web page table" } else { "text (CSV)" }));
    }
    if excel && !named_excel {
        notes.push(format!("This {} file is really an Excel workbook, so it was read as one.", if ext.is_empty() { "file".to_string() } else { format!(".{}", ext) }));
    }

    let mut same_header: Vec<String> = Vec::new();
    let mut metas: Vec<PageMeta> = Vec::new();
    // For a combined read: the page and sheet row of every grid row.
    let mut grid_pages: Vec<String> = Vec::new();
    let mut grid_abs: Vec<u32> = Vec::new();
    let (sheet, sheets, grid, start, image_formulas, combined) = if excel {
        use calamine::Reader;
        let bytes = std::fs::read(path).context("open the file")?;
        let mut wb = calamine::open_workbook_auto_from_rs(std::io::Cursor::new(bytes)).map_err(|e| anyhow::anyhow!("Couldn't open the spreadsheet: {}", e))?;
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
        let mut hashes: Vec<(u64, String)> = Vec::new();
        for name in &names {
            let Some((rows, st)) = read_rows(name) else { continue };
            let score = sheet_score(&rows);
            let is_hidden = hidden.contains(name);
            let text: Vec<Vec<String>> = rows.iter().take(200).map(|r| r.iter().map(Val::text).collect()).collect();
            let h = find_header_row(&text);
            let mut kind = classify_page(name, &rows, &text, h, score);
            let mut same_as = None;
            if kind != "empty" {
                let hs = content_hash(&rows);
                if let Some((_, first)) = hashes.iter().find(|(x, _)| *x == hs) {
                    kind = "copy";
                    same_as = Some(first.clone());
                } else {
                    hashes.push((hs, name.clone()));
                }
            }
            let facts = if matches!(kind, "summary" | "pricing" | "totals") { page_facts(&rows) } else { Facts::default() };
            if score > 0 && !is_hidden {
                scored.push((name.clone(), score));
            }
            let mut rank = sheet_rank(name, &rows, is_hidden);
            if kind != "lines" {
                rank -= 5_000;
            }
            if best.as_ref().map_or(true, |(_, b)| rank > *b) {
                best = Some((name.clone(), rank));
            }
            metas.push(PageMeta {
                name: name.clone(),
                rows: score,
                kind,
                hidden: is_hidden,
                header_row: h.map_or(0, |h| st.0 as usize + h + 1),
                same_as,
                facts,
                head: h.map(|h| head_names(&text[h])).unwrap_or_default(),
            });
        }
        // Pages that share columns (a pallet a sheet) can be read as one: the largest group of
        // visible product pages whose column names mostly agree.
        let mut groups: Vec<Vec<usize>> = Vec::new();
        for (i, m) in metas.iter().enumerate() {
            if m.kind != "lines" || m.hidden || m.head.is_empty() {
                continue;
            }
            match groups.iter().position(|g| similar_heads(&metas[g[0]].head, &m.head)) {
                Some(gi) => groups[gi].push(i),
                None => groups.push(vec![i]),
            }
        }
        let best_name = best.as_ref().map(|(n, _)| n.clone());
        if let Some(top) = groups
            .iter()
            .max_by_key(|g| (g.len(), best_name.as_ref().map_or(false, |b| g.iter().any(|&i| &metas[i].name == b))))
            .filter(|g| g.len() >= 2)
        {
            same_header = top.iter().map(|&i| metas[i].name.clone()).collect();
            let rep = same_header[0].clone();
            for &i in top.iter().skip(1) {
                metas[i].same_as = Some(rep.clone());
            }
        }
        let wanted: Option<Vec<String>> = match want_sheet {
            Some(ALL_SHEETS) if same_header.len() >= 2 => Some(same_header.clone()),
            Some(w) if w.starts_with(MANY) => Some(w.split(MANY).filter(|s| !s.is_empty()).map(|s| s.to_string()).collect()),
            _ => None,
        };
        if let Some(pick) = wanted.filter(|p| p.len() >= 2) {
            // Every chosen page one after another, columns lined up by their names, with a
            // Sheet column saying which each line came from. Photos stay on their own sheets
            // and are not read.
            let mut union: Vec<String> = Vec::new();
            let mut union_key: Vec<String> = Vec::new();
            let mut body: Vec<(String, u32, Vec<(usize, Val)>)> = Vec::new();
            let mut used: Vec<String> = Vec::new();
            let mut skipped: Vec<String> = Vec::new();
            let mut first_head: Vec<String> = Vec::new();
            for name in &pick {
                let Some((rows, st)) = read_rows(name) else { continue };
                let text: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(Val::text).collect()).collect();
                let Some(h) = find_header_row(&text) else { skipped.push(name.clone()); continue };
                let hn = head_names(&text[h]);
                if first_head.is_empty() {
                    first_head = hn;
                } else if !similar_heads(&first_head, &hn) {
                    skipped.push(name.clone());
                    continue;
                }
                let width = text[h].iter().rposition(|c| !c.trim().is_empty()).map_or(0, |i| i + 1);
                let mut map: Vec<Option<usize>> = Vec::new();
                let mut here: Vec<String> = Vec::new();
                for j in 0..width {
                    let raw = text[h][j].trim();
                    if raw.is_empty() {
                        map.push(None);
                        continue;
                    }
                    let mut key = norm_head(raw);
                    if key.is_empty() {
                        key = raw.to_lowercase();
                    }
                    let mut n = 1;
                    let base = key.clone();
                    while here.contains(&key) {
                        n += 1;
                        key = format!("{} {}", base, n);
                    }
                    here.push(key.clone());
                    let at = match union_key.iter().position(|k| *k == key) {
                        Some(p) => p,
                        None => {
                            union_key.push(key);
                            union.push(raw.to_string());
                            union.len() - 1
                        }
                    };
                    map.push(Some(at));
                }
                for (k, r) in rows.iter().enumerate().skip(h + 1) {
                    let cells: Vec<(usize, Val)> = (0..width).filter_map(|j| map[j].map(|u| (u, r.get(j).cloned().unwrap_or(Val::Empty)))).collect();
                    body.push((name.clone(), st.0 + k as u32, cells));
                }
                used.push(name.clone());
            }
            let width = union.len();
            let mut out: Vec<Vec<Val>> = Vec::new();
            let mut head: Vec<Val> = union.iter().map(|h| Val::Text(h.clone())).collect();
            head.push(Val::Text("Sheet".into()));
            out.push(head);
            grid_pages.push(used.first().cloned().unwrap_or_default());
            grid_abs.push(0);
            for (name, abs, cells) in body {
                let mut r = vec![Val::Empty; width + 1];
                for (u, v) in cells {
                    r[u] = v;
                }
                r[width] = Val::Text(name.clone());
                out.push(r);
                grid_pages.push(name);
                grid_abs.push(abs);
            }
            notes.push(format!("Read {} together ({}). Their photos are not carried into the new files.", plural(used.len(), "sheet", "sheets"), list_names(&used)));
            if !skipped.is_empty() {
                notes.push(format!("Not read with them, because their columns are different: {}.", list_names(&skipped)));
            }
            (Some(ALL_SHEETS.to_string()), scored, out, (0, 0), HashMap::new(), true)
        } else {
            let chosen = match want_sheet {
                Some(w) if names.iter().any(|n| n == w) => w.to_string(),
                Some(w) if w.starts_with(MANY) && names.iter().any(|n| w.trim_start_matches(MANY).split(MANY).next() == Some(n.as_str())) => {
                    w.trim_start_matches(MANY).split(MANY).next().unwrap().to_string()
                }
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

    // The header row: the one the reader finds, or the one Jack points at (1-based on the
    // sheet; 0 says the sheet has none).
    let found: Option<usize> = if combined {
        Some(0)
    } else {
        match hdr {
            Some(0) => None,
            Some(n) => n.checked_sub(1 + start.0 as usize).filter(|r| *r < text.len()).or_else(|| find_header_row(&text)),
            None => find_header_row(&text),
        }
    };
    if !excel {
        let h = found;
        metas.push(PageMeta {
            name: stem.clone(),
            rows: sheet_score(&grid),
            kind: if sheet_score(&grid) == 0 { "empty" } else { "lines" },
            hidden: false,
            header_row: h.map_or(0, |h| h + 1),
            same_as: None,
            facts: Facts::default(),
            head: h.map(|h| head_names(&text[h])).unwrap_or_default(),
        });
    }

    if let Some(h) = found {
        let headers: Vec<String> = (0..ncols).map(|j| text[h].get(j).map(|s| s.trim().to_string()).unwrap_or_default()).collect();
        let above = (0..h).map(|i| (start.0 as usize + i + 1, text[i].iter().filter(|c| !c.is_empty()).cloned().collect::<Vec<_>>().join(" "))).collect();
        let rows: Vec<Vec<Val>> = grid[h + 1..].iter().cloned().map(pad).collect();
        let (abs_rows, row_pages): (Vec<u32>, Vec<String>) = if combined {
            (grid_abs[h + 1..].to_vec(), grid_pages[h + 1..].to_vec())
        } else {
            ((h + 1..grid.len()).map(|i| start.0 + i as u32).collect(), Vec::new())
        };
        return Ok(Table {
            file_name, format: ext, sheet, sheets, headers, header_in_file: true,
            header_row: if combined { 1 } else { start.0 as usize + h + 1 }, header_abs_row: Some(start.0 + h as u32),
            rows, abs_rows, abs_col0: start.1, above, image_formulas, images, inferred: None, notes, same_header,
            pages: metas, row_pages, stem,
        });
    }

    let inf = infer_columns(&text);
    if grid.is_empty() {
        bail!("Couldn't find any rows in this file.");
    }
    let headers = (0..ncols)
        .map(|j| match &inf {
            Some(inf) if j == inf.desc => "Description".to_string(),
            Some(inf) if Some(j) == inf.qty => "Quantity".to_string(),
            Some(inf) if j == inf.price => "Retail".to_string(),
            _ => format!("Column {}", j + 1),
        })
        .collect();
    let abs_rows = (0..grid.len()).map(|i| start.0 + i as u32).collect();
    Ok(Table {
        file_name, format: ext, sheet, sheets, headers, header_in_file: false, header_row: 0, header_abs_row: None,
        rows: grid.into_iter().map(pad).collect(), abs_rows, abs_col0: start.1, above: Vec::new(), image_formulas, images,
        inferred: inf.map(|i| (i.desc, i.qty, i.price)), notes, same_header,
        pages: metas, row_pages: Vec::new(), stem,
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
static CACHE: Mutex<Option<(String, Option<String>, Option<usize>, u64, u128, Arc<Table>)>> = Mutex::new(None);

fn table(path: &str, sheet: Option<&str>, hdr: Option<usize>) -> Result<Arc<Table>> {
    let meta = std::fs::metadata(path).context("open the manifest")?;
    let len = meta.len();
    let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    let want = sheet.map(|s| s.to_string());
    if let Ok(c) = CACHE.lock() {
        if let Some((p, s, h, l, m, t)) = c.as_ref() {
            // Asking by name for the sheet the last read already chose is the same read.
            if p == path && *l == len && *m == mtime && *h == hdr && (*s == want || (want.is_some() && t.sheet == want)) {
                return Ok(t.clone());
            }
        }
    }
    let t = Arc::new(read_table(path, sheet, hdr)?);
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((path.to_string(), want, hdr, len, mtime, t.clone()));
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
    /// The UPC, SKU or style column and the condition column, for the breakdown.
    code: Option<usize>,
    condition: Option<usize>,
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
    c.code = find_col_by_words(&t.headers, &["upc", "sku", "asin", "ean", "item #", "item number", "model", "style"]);
    c.condition = find_col_by_words(&t.headers, &["condition", "grade"]);
    Ok(c)
}

/// The first column whose header names one of `words`.
fn find_col_by_words(headers: &[String], words: &[&str]) -> Option<usize> {
    (0..headers.len()).find(|&j| hhas(&hwords(&headers[j]), words))
}

/// The columns Jack named, in place of detection. Roles: description, quantity, retail_unit,
/// retail_ext, cost (a price for one unit), sheet_price (a price for the whole line),
/// category, brand, code, condition, photo.
fn cols_from_map(t: &Table, m: &ColumnMap) -> Result<Cols> {
    let n = t.headers.len();
    let get = |k: &str| m.roles.get(k).copied().filter(|&j| j < n);
    let Some(desc) = get("description") else {
        bail!("Pick the column that holds the description.");
    };
    Ok(Cols {
        desc,
        qty: get("quantity"),
        retail_unit: get("retail_unit"),
        retail_ext: get("retail_ext"),
        sale_unit: get("cost"),
        sale_ext: get("sheet_price"),
        category: get("category"),
        brand: get("brand"),
        photo_links: get("photo"),
        code: get("code"),
        condition: get("condition"),
        ..Cols::default()
    })
}

/// Up to three different values from a column, so it can be recognised at a glance.
fn col_samples(t: &Table, j: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in t.rows.iter().take(400) {
        let s = r[j].text();
        let s = s.trim();
        if s.is_empty() || out.iter().any(|o| o == s) {
            continue;
        }
        out.push(s.chars().take(40).collect());
        if out.len() == 3 {
            break;
        }
    }
    out
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
    /// The UPC/SKU/style and condition cells.
    code: String,
    condition: String,
    /// The page (sheet) it came from, and the position of its section on that page.
    page: String,
    section: usize,
    /// A photo link, or "media:<name>" for a picture on the sheet.
    picture: Option<String>,
    /// The sheet gave the line no description; it is named by its code or its row.
    nodesc: bool,
}

/// A total row found among the lines: where it sits and what it states.
#[derive(Debug, Clone)]
struct TotalRow {
    idx: usize,
    label: String,
    units: Option<f64>,
    retail: Option<f64>,
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
    /// Where the layout starts over, by row of the table: repeated header rows, label-only
    /// rows and total rows. Sections are cut from these.
    header_rows: Vec<usize>,
    sep_rows: Vec<(usize, String)>,
    total_rows: Vec<TotalRow>,
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
    let mut pic_by_row: HashMap<u32, String> = HashMap::new();
    for ((r, _), m) in &t.images.in_cell {
        pic_by_row.entry(*r).or_insert_with(|| format!("media:{}", m));
    }
    for p in &t.images.placed {
        pic_by_row.entry(p.row).or_insert_with(|| format!("media:{}", p.media));
    }
    for ((r, _), u) in &t.images.web {
        pic_by_row.insert(*r, u.clone());
    }
    let default_page = t.sheet.clone().unwrap_or_else(|| t.stem.clone());
    // With several sheets read together the last column only says which sheet a row is from.
    let page_col = if t.row_pages.is_empty() { None } else { t.headers.len().checked_sub(1) };
    let num = |r: &Vec<Val>, j: Option<usize>| j.and_then(|j| r[j].number());
    let header_key: Vec<String> = t.headers.iter().map(|h| h.trim().to_lowercase()).collect();
    let filled_headers = header_key.iter().filter(|h| !h.is_empty()).count();
    let money_cols = [c.retail_unit, c.retail_ext, c.sale_unit, c.sale_ext, c.pct, c.qty];
    let mut out = Lines::default();
    let (mut run_qty, mut run_ext) = (0.0f64, 0.0f64);
    // The same sums since the last total row or header: a pallet's own total row.
    let (mut sec_qty, mut sec_ext) = (0.0f64, 0.0f64);
    let mut prev_page: Option<&String> = None;
    for (i, r) in t.rows.iter().enumerate() {
        if let Some(pg) = t.row_pages.get(i) {
            if prev_page != Some(pg) {
                // A new page of a combined read starts its sums again.
                prev_page = Some(pg);
                run_qty = 0.0;
                run_ext = 0.0;
                sec_qty = 0.0;
                sec_ext = 0.0;
            }
        }
        let mut desc = r[c.desc].text();
        let mut unnamed_line = false;
        // A repeated header row (a multi-page export) is not a product.
        if t.header_in_file && filled_headers >= 2 {
            let same = r.iter().zip(&header_key).filter(|(v, h)| !h.is_empty() && v.text().trim().to_lowercase() == **h).count();
            if same * 2 >= filled_headers {
                out.repeated_headers += 1;
                out.header_rows.push(i);
                sec_qty = 0.0;
                sec_ext = 0.0;
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
        let sums = q.map_or(false, |q| near(q, run_qty) || near(q, sec_qty))
            || ext.map_or(false, |e| near(e, run_ext) || near(e, sec_ext))
            || unit.map_or(false, |u| near(u, run_ext) || near(u, sec_ext));
        if desc.is_empty() {
            if !has_numbers {
                continue; // a blank spacer row
            }
            // A total row labelled in another column ("TOTAL" under SKU), or not at all.
            let label = (0..r.len()).filter(|j| *j != c.desc && Some(*j) != page_col && !money_cols.contains(&Some(*j))).map(|j| r[j].text()).find(|s| !s.trim().is_empty());
            let labelled = label.as_ref().map_or(false, |s| is_summary_line(&s.to_lowercase()) || manifest::looks_like_total(&s.to_lowercase()));
            if labelled || (label.is_none() && sums) {
                let name = label.unwrap_or_else(|| "an unlabelled total".into());
                out.total_rows.push(TotalRow { idx: i, label: name.clone(), units: q, retail: ext.or(unit) });
                out.summary.push(name);
                out.stated_total = Some((q, ext.or(unit)));
                sec_qty = 0.0;
                sec_ext = 0.0;
                continue;
            }
            // A product with no description: name it by its UPC, SKU or model, else its row.
            desc = (0..r.len())
                .filter(|j| hhas(&hwords(&t.headers[*j]), &["upc", "sku", "asin", "ean", "model", "style", "item #", "item number", "part"]))
                .map(|j| r[j].text())
                .find(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("Row {} (no description)", t.abs_rows[i] + 1));
            out.unnamed += 1;
            unnamed_line = true;
        } else if is_summary_line(&desc.to_lowercase())
            || (manifest::looks_like_total(&desc.to_lowercase()) && (unit.is_none() || sums))
        {
            // "Total Pallet A" with no unit price, or with figures that are the sums above.
            // Only a total of everything above can be checked against the lines.
            out.summary.push(desc.clone());
            out.total_rows.push(TotalRow { idx: i, label: desc.clone(), units: q, retail: ext.or(unit) });
            if sums || desc.to_lowercase().contains("grand") {
                out.stated_total = Some((q, ext.or(unit)));
            }
            sec_qty = 0.0;
            sec_ext = 0.0;
            continue;
        }
        let sale_cells = [c.sale_unit, c.sale_ext, c.pct].iter().any(|j| j.map_or(false, |j| r[j].number().is_some()));
        let sized = c.size_cols.iter().any(|&j| r[j].number().map_or(false, |v| v > 0.0));
        let described = (0..r.len()).any(|j| j != c.desc && Some(j) != page_col && !money_cols.contains(&Some(j)) && !r[j].text().trim().is_empty());
        let figures = c.qty.is_some() || money_cols.iter().any(|j| j.is_some()) || !c.size_cols.is_empty();
        if figures && qty_cell.is_none() && unit.is_none() && ext.is_none() && !sale_cells && !sized && !described {
            // A label and nothing else: a pallet heading, a section title, a footer note.
            out.sep_rows.push((i, desc.clone()));
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
        sec_qty += qty;
        sec_ext += ext.unwrap_or(retail);
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
            code: c.code.map(|j| r[j].text().trim().to_string()).unwrap_or_default(),
            condition: c.condition.map(|j| r[j].text().trim().to_string()).unwrap_or_default(),
            page: t.row_pages.get(i).cloned().unwrap_or_else(|| default_page.clone()),
            section: 0,
            nodesc: unnamed_line,
            picture: c.photo_links.map(|j| r[j].text().trim().to_string()).filter(|u| !u.is_empty()).or_else(|| pic_by_row.get(&t.abs_rows[i]).cloned()),
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
            code: String::new(),
            condition: String::new(),
            page: String::new(),
            section: 0,
            picture: None,
            nodesc: false,
        })
        .collect();
    let all: Vec<usize> = (0..lines.len()).collect();
    let mut found = brands_from_titles(&lines, &all);
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
/// the first words of a title (a brand that is also an ordinary word only at its start).
/// R-564: a title's first word is never taken as a brand because it opens many titles
/// ("Row", "https", city names); an unknown brand is a question for Jack (`Review::brands`)
/// and becomes a `brand_word` rule.
fn brands_from_titles(lines: &[Line], missing: &[usize]) -> HashMap<usize, String> {
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
    let skippable = |w: &str| LEAD_WORDS.contains(&w) || SPEC_WORDS.contains(&w) || is_code_word(w);

    let mut inferred: HashMap<usize, String> = HashMap::new();
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
        }
    }
    inferred
}

/// A word with a digit and a letter, or only digits: a code, a size, a model number.
fn is_code_word(w: &str) -> bool {
    (w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(|c| c.is_alphabetic())) || w.chars().all(|c| c.is_ascii_digit())
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

struct Piece {
    key: String,
    name: String,
    idx: Vec<usize>,
}

/// Everything a plan, a line list and an export share.
struct State {
    t: Arc<Table>,
    cols: Cols,
    lines: Vec<Line>,
    groups: Vec<Piece>,
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
    /// Per line: how its category was placed (sheet | rule | list | none) and where its
    /// brand came from (sheet | rule | known | none).
    placed: Vec<&'static str>,
    brand_from: Vec<&'static str>,
    /// Every section of the pages read (including ones left out).
    sections: Vec<SectionInfo>,
    /// The sheet's own grand total row: (units, retail).
    sheet_total: Option<(Option<f64>, Option<f64>)>,
    /// Lines on the pages read before any section was left out: (lines, units, retail).
    all_read: (usize, f64, f64),
    /// Lines with no quantity the sheet could read, counted as 1 unit.
    qty_missing: usize,
    /// Lines that repeat the same title and code as a line above (they roll up into products).
    repeat_lines: usize,
}

fn prepare(path: &str, ask: &mut Ask, notes: &mut Vec<String>, o: &ReadOptions) -> Result<Prepared> {
    // Jack's pages and header row, when he gave them; else the default reading.
    let hdr = o.columns.as_ref().map(|m| m.header_row.unwrap_or(0));
    let picked: Option<String> = match &o.pages {
        Some(p) if p.len() == 1 => Some(p[0].clone()),
        Some(p) if p.len() > 1 => Some(format!("{}{}", MANY, p.join(&MANY.to_string()))),
        _ => None,
    };
    let first = table(path, picked.as_deref().or(ask.answers.get("sheet").map(|s| s.as_str())), hdr)?;

    // Which sheet. Sheets that share a header (a pallet a sheet) can be read as one, and
    // that is the suggestion when the best sheet is one of them.
    let t = if first.sheets.len() > 1 && picked.is_none() {
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
        if first.sheet.as_deref() == Some(pick.as_str()) { first } else { table(path, Some(&pick), hdr)? }
    } else {
        first
    };
    notes.extend(t.notes.iter().cloned());

    // A lone "Price" column: retail, or this load's price? (Not asked when Jack mapped the
    // columns himself.)
    let probe = if o.columns.is_some() { Cols::default() } else { detect_cols(&t, "retail")? };
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
    let mut cols = match &o.columns {
        Some(m) => cols_from_map(&t, m)?,
        None => detect_cols(&t, &price_role)?,
    };
    let mut read = build_lines(&t, &cols);
    let mut lines = std::mem::take(&mut read.lines);
    if lines.is_empty() {
        bail!("Read the columns but found no product lines in this file.");
    }
    // Where the layout starts over: sections, each with its own total row.
    let mut sections = cut_sections(&t, &read, &mut lines);
    let all_read = (lines.len(), lines.iter().map(|l| l.qty).sum::<f64>(), lines.iter().map(|l| l.retail).sum::<f64>());
    if !o.sections_off.is_empty() {
        let off: HashSet<String> = o.sections_off.iter().cloned().collect();
        let n = lines.len();
        for sec in sections.iter_mut() {
            if off.contains(sec.key.as_str()) {
                sec.read = false;
            }
        }
        lines.retain(|l| !off.contains(&format!("{}#{}", l.page, l.section + 1)));
        if lines.len() < n {
            notes.push(format!("Left out {} in the sections you turned off.", plural(n - lines.len(), "line", "lines")));
        }
        if lines.is_empty() {
            bail!("Every section is turned off, so there is nothing to read.");
        }
    }
    let qty_missing = read.qty_blank + read.qty_assumed;
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
    // (A sheet with several sections is checked section by section, in the breakdown.)
    if let Some((units, retail)) = read.stated_total.filter(|_| sections.len() == 1) {
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
    let _ = rep_units;
    let repeat_lines = if code_col.is_some() { repeats } else { 0 };

    let known: HashMap<String, &'static str> = KNOWN_BRANDS.iter().map(|b| (brand_key(b), *b)).collect();
    let aliases: HashMap<String, &'static str> = BRAND_ALIASES.iter().map(|(a, b)| (brand_key(a), *b)).collect();
    for l in lines.iter_mut() {
        if let Some(canon) = aliases.get(&brand_key(&l.brand_raw)) {
            l.brand_raw = canon.to_string();
        }
    }

    // Brands missing from lines: his brand_word rules first, then the known brands, their
    // aliases and model names read from the titles. Never a title's first word (R-564).
    let rules = CompiledRules::new(&o.rules);
    let mut brand_from: Vec<&'static str> = lines.iter().map(|l| if is_no_brand(&l.brand_raw) { "none" } else { "sheet" }).collect();
    let mut by_rule = 0usize;
    for i in 0..lines.len() {
        if brand_from[i] == "none" {
            if let Some(b) = rules.brand(&lines[i].desc, &lines[i].alt, &lines[i].code) {
                lines[i].brand_raw = b;
                brand_from[i] = "rule";
                by_rule += 1;
            }
        }
    }
    let missing: Vec<usize> = (0..lines.len()).filter(|&i| is_no_brand(&lines[i].brand_raw)).collect();
    let mut inferred = if missing.is_empty() { HashMap::new() } else { brands_from_titles(&lines, &missing) };
    // A title that says nothing: try the other text column.
    if cols.alt_text.is_some() {
        let still: Vec<usize> = missing.iter().copied().filter(|i| !inferred.contains_key(i)).collect();
        if !still.is_empty() {
            let swapped: Vec<Line> = lines.iter().map(|l| Line { desc: l.alt.clone(), ..l.clone() }).collect();
            for (i, b) in brands_from_titles(&swapped, &still) {
                inferred.insert(i, b);
            }
        }
    }
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
    let brands_read = inferred.len() + by_rule;
    for (i, b) in &inferred {
        lines[*i].brand_raw = b.clone();
        brand_from[*i] = "known";
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
    // Where each category came from: the sheet's own column, his rule, the built-in word
    // list, or nowhere (R-564: a category is never saved as a guess without saying so).
    let mut placed: Vec<&'static str> = vec!["none"; lines.len()];
    // A title repeats down a sheet; the list reads it once.
    let mut memo: HashMap<String, &'static str> = HashMap::new();
    let mut listed = |text: &str| -> &'static str { *memo.entry(text.to_string()).or_insert_with(|| guess_category(text)) };
    let cat_raw: Vec<Option<String>> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let own = l.category.trim();
            if cols.category.is_some() && !own.is_empty() && !manifest_category::is_no_value(own) {
                if let Some(c) = rules.sheet_category(own) {
                    placed[i] = "rule";
                    return Some(c);
                }
                let parts: Vec<&str> = if own.contains('>') { own.split('>').collect() } else { own.split(" / ").collect() };
                let parts: Vec<&str> = parts.into_iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
                let cut = if level == usize::MAX || parts.len() <= level { own.to_string() } else { parts[..level].join(" > ") };
                placed[i] = "sheet";
                return Some(cut);
            }
            if let Some(c) = rules.category(&l.desc, &l.alt, &l.code) {
                placed[i] = "rule";
                return Some(c);
            }
            let mut g = listed(&l.desc);
            if g == manifest_category::UNCATEGORIZED && !l.alt.is_empty() {
                g = listed(&l.alt);
            }
            if g == manifest_category::UNCATEGORIZED {
                None
            } else {
                placed[i] = "list";
                Some(g.to_string())
            }
        })
        .collect();
    let guessed: Vec<bool> = placed.iter().map(|p| *p == "list").collect();
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
            if total_retail > 0.0 {
                format!(
                    "{}. {} of {} ({} of retail) could not be placed.",
                    whence,
                    fmt_int(unplaced.len() as f64),
                    plural(lines.len(), "line", "lines"),
                    fmt_pct(share(unplaced_retail, unplaced.len()) * 100.0) + "%"
                )
            } else {
                let (un, tu): (f64, f64) = (unplaced.iter().map(|&i| lines[i].qty).sum(), lines.iter().map(|l| l.qty).sum());
                format!(
                    "{}. {} of {} ({} of {} units) could not be placed.",
                    whence,
                    fmt_int(unplaced.len() as f64),
                    plural(lines.len(), "line", "lines"),
                    fmt_int(un),
                    fmt_int(tu)
                )
            }
        };
        // A guess that leaves much of the load unplaced goes first, where it is seen.
        if share(unplaced_retail, unplaced.len()) > 0.10 {
            notes.insert(0, text);
        } else {
            notes.push(text);
        }
    }

    let footers: Vec<String> = read.separators.iter().chain(read.summary.iter()).cloned().collect();
    // The sheet's own grand total: its only total row, or one marked "grand". A pallet's
    // total row belongs to the pallet (`SectionInfo::stated`).
    let sheet_total = if sections.len() == 1 {
        read.stated_total
    } else {
        read.total_rows.iter().rev().find(|r| r.label.to_lowercase().contains("grand")).map(|r| (r.units, r.retail))
    };
    Ok(Prepared { t, cols, lines, brands, cats, guessed, brands_read, left_out, footers, placed, brand_from, sections, sheet_total, all_read, qty_missing, repeat_lines })
}

fn build(path: &str, answers: &HashMap<String, String>, edits: &SplitEdits) -> Result<State> {
    let mut ask = Ask { answers, questions: Vec::new() };
    let mut notes: Vec<String> = Vec::new();
    let Prepared { t, mut cols, lines, brands, cats, footers, .. } = prepare(path, &mut ask, &mut notes, &ReadOptions::default())?;
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
    let mut groups: HashMap<String, Piece> = HashMap::new();
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
                Piece { key: key.clone(), name, idx: Vec::new() }
            })
            .idx
            .push(i);
    }
    let weight = |g: &Piece| weight_of(&g.idx);
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
        groups.insert(mixed_key.clone(), Piece { key: mixed_key.clone(), name: name.into(), idx });
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
    let mut ordered: Vec<Piece> = order.into_iter().filter_map(|k| groups.remove(&k)).collect();
    ordered.sort_by(|a, b| {
        let last = |g: &Piece| g.key.starts_with("mixed") || is_blank(&g.key);
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
            samples: col_samples(&t, j),
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

// ── R-564: his rules ────────────────────────────────────────────────────────

/// Jack's rules, ready to match. A rule's pattern matches whole words, case-insensitive; the
/// longest pattern that matches wins; a rule never needs the built-in list.
struct CompiledRules {
    /// (pattern words, pattern length, category, brand) for word, phrase and brand_word rules.
    words: Vec<(Vec<String>, usize, Option<String>, Option<String>)>,
    /// (digits, category, brand) for upc_prefix rules.
    upc: Vec<(String, Option<String>, Option<String>)>,
    /// (category_group_key of a sheet's own category value, his category).
    sheet: Vec<(String, String)>,
}

fn digits_of(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect::<String>().trim_start_matches('0').to_string()
}

fn has_words(hay: &[String], needle: &[String]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

impl CompiledRules {
    fn new(rules: &[Rule]) -> Self {
        let clean = |o: &Option<String>| o.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let mut out = CompiledRules { words: Vec::new(), upc: Vec::new(), sheet: Vec::new() };
        for r in rules {
            let (cat, brand) = (clean(&r.category), clean(&r.brand));
            match r.kind.trim().to_lowercase().as_str() {
                "sheet_category" => {
                    if let Some(c) = cat {
                        out.sheet.push((category_group_key(r.pattern.trim()), c));
                    }
                }
                "upc_prefix" => {
                    let d = digits_of(&r.pattern);
                    if !d.is_empty() && (cat.is_some() || brand.is_some()) {
                        out.upc.push((d, cat, brand));
                    }
                }
                "word" | "phrase" | "brand_word" => {
                    let w = title_words(&r.pattern);
                    if !w.is_empty() && (cat.is_some() || brand.is_some()) {
                        let len = w.join(" ").len();
                        out.words.push((w, len, cat, brand));
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// The longest matching rule's category (or brand).
    fn find(&self, desc: &str, alt: &str, code: &str, brand: bool) -> Option<String> {
        if self.words.is_empty() && self.upc.is_empty() {
            return None;
        }
        let pick = |c: &Option<String>, b: &Option<String>| if brand { b.clone() } else { c.clone() };
        let mut best: Option<(usize, String)> = None;
        let dw = title_words(desc);
        let aw = if alt.is_empty() { Vec::new() } else { title_words(alt) };
        for (w, len, c, b) in &self.words {
            if let Some(v) = pick(c, b) {
                if (has_words(&dw, w) || has_words(&aw, w)) && best.as_ref().map_or(true, |(l, _)| len > l) {
                    best = Some((*len, v));
                }
            }
        }
        let cd = digits_of(code);
        if !cd.is_empty() {
            for (d, c, b) in &self.upc {
                if let Some(v) = pick(c, b) {
                    if cd.starts_with(d.as_str()) && best.as_ref().map_or(true, |(l, _)| d.len() > *l) {
                        best = Some((d.len(), v));
                    }
                }
            }
        }
        best.map(|(_, v)| v)
    }

    fn category(&self, desc: &str, alt: &str, code: &str) -> Option<String> {
        self.find(desc, alt, code, false)
    }

    fn brand(&self, desc: &str, alt: &str, code: &str) -> Option<String> {
        self.find(desc, alt, code, true)
    }

    /// His category for a sheet's own category value.
    fn sheet_category(&self, own: &str) -> Option<String> {
        if self.sheet.is_empty() {
            return None;
        }
        let k = category_group_key(own);
        self.sheet.iter().find(|(p, _)| *p == k).map(|(_, c)| c.clone())
    }
}

// ── R-564: sections ─────────────────────────────────────────────────────────

fn section_label_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)^\s*(pallets?|lots?|loads?|skids?|containers?|shipments?|orders?|cartons?|box)\b\s*(#|no\.?|number|num)?\s*[:\-]?\s*[\w\-/]+").unwrap()
    })
}

/// The table's rows split by page: (page name, first row, row after the last).
fn page_ranges(t: &Table) -> Vec<(String, usize, usize)> {
    let default_page = t.sheet.clone().unwrap_or_else(|| t.stem.clone());
    if t.row_pages.is_empty() {
        return vec![(default_page, 0, t.rows.len())];
    }
    let mut out: Vec<(String, usize, usize)> = Vec::new();
    for (i, p) in t.row_pages.iter().enumerate() {
        match out.last_mut() {
            Some(last) if &last.0 == p => last.2 = i + 1,
            _ => out.push((p.clone(), i, i + 1)),
        }
    }
    out
}

/// Cut each page into sections where its layout starts over: a title row then a header
/// row, a repeated header row, a pallet, lot or load label row, a total row followed by a
/// blank band. Sets each line's `section` and returns every section with its own totals.
fn cut_sections(t: &Table, read: &Lines, lines: &mut [Line]) -> Vec<SectionInfo> {
    let blank = |i: usize| t.rows[i].iter().all(|v| matches!(v, Val::Empty));
    let abs = |i: usize| t.abs_rows.get(i).copied().unwrap_or(0) as usize + 1;
    let mut out: Vec<SectionInfo> = Vec::new();
    for (page, lo, hi) in page_ranges(t) {
        let a = lines.partition_point(|l| l.row < lo);
        let b = lines.partition_point(|l| l.row < hi);
        if a == b {
            continue;
        }
        let line_rows: Vec<usize> = lines[a..b].iter().map(|l| l.row).collect();
        // Where a new section may start: (row, its title if it has one).
        let mut starts: Vec<(usize, Option<String>)> = Vec::new();
        for &h in read.header_rows.iter().filter(|&&h| h >= lo && h < hi) {
            let (mut s, mut name) = (h, None);
            let (mut k, mut back) = (h, 0);
            while k > lo && back < 4 {
                k -= 1;
                back += 1;
                if blank(k) {
                    continue;
                }
                if let Some((_, lab)) = read.sep_rows.iter().find(|(i, _)| *i == k) {
                    s = k;
                    name = Some(lab.trim().to_string());
                }
                break;
            }
            starts.push((s, name));
        }
        for (i, lab) in read.sep_rows.iter().filter(|(i, _)| *i >= lo && *i < hi) {
            if lab.chars().count() <= 40 && section_label_re().is_match(lab) && !starts.iter().any(|(s, _)| s == i) {
                starts.push((*i, Some(lab.trim().to_string())));
            }
        }
        for tr in read.total_rows.iter().filter(|r| r.idx >= lo && r.idx < hi) {
            let mut k = tr.idx + 1;
            let mut blanks = 0;
            while k < hi && blank(k) {
                k += 1;
                blanks += 1;
            }
            if blanks >= 1 && k < hi {
                starts.push((k, None));
            }
        }
        starts.sort_by_key(|s| s.0);
        // Starts that open on the same first line are one; one with no line before it is
        // only the page's beginning.
        let mut first_name: Option<String> = None;
        let mut cuts: Vec<(usize, usize, Option<String>)> = Vec::new(); // (start row, first line row, name)
        for (s, name) in starts {
            let p = line_rows.partition_point(|&r| r < s);
            if p >= line_rows.len() {
                continue;
            }
            if p == 0 {
                if name.is_some() && first_name.is_none() {
                    first_name = name;
                }
                continue;
            }
            match cuts.last_mut() {
                Some(last) if last.1 == line_rows[p] => {
                    if last.2.is_none() {
                        last.2 = name;
                    }
                }
                _ => cuts.push((s, line_rows[p], name)),
            }
        }
        if first_name.is_none() && lo == 0 && !cuts.is_empty() {
            first_name = t.above.iter().rev().map(|(_, s)| s.trim().to_string()).find(|s| !s.is_empty() && s.chars().count() <= 60);
        }
        let mut bounds: Vec<(usize, usize, Option<String>)> = Vec::new(); // (lo, hi exclusive, name)
        let mut from = lo;
        let mut name = first_name;
        for (s, _, n) in &cuts {
            bounds.push((from, *s, name.take()));
            from = *s;
            name = n.clone();
        }
        bounds.push((from, hi, name));
        let several = bounds.len() > 1;
        for (n, (blo, bhi, name)) in bounds.into_iter().enumerate() {
            let x = lines.partition_point(|l| l.row < blo);
            let y = lines.partition_point(|l| l.row < bhi);
            let sect = n;
            let (mut units, mut retail) = (0.0f64, 0.0f64);
            for l in lines[x..y].iter_mut() {
                l.section = sect;
                units += l.qty;
                retail += l.retail;
            }
            let last_line = if y > x { lines[y - 1].row } else { blo };
            let tail = (blo..bhi).rev().find(|&i| !blank(i)).unwrap_or(last_line);
            // Its own total row, when it has one.
            let own: Vec<&TotalRow> = read.total_rows.iter().filter(|r| r.idx >= blo && r.idx < bhi).collect();
            let pick = own.iter().rev().find(|r| !r.label.to_lowercase().contains("grand")).or(own.last()).copied();
            let mut stated = pick.filter(|r| r.units.is_some() || r.retail.is_some()).map(|r| Stated {
                units: r.units,
                retail: r.retail,
                price: None,
                source: format!("the total row (\"{}\")", r.label.trim()),
            });
            if stated.is_none() && !several {
                // A summary page that lists this page by name.
                for m in t.pages.iter().filter(|m| matches!(m.kind, "summary" | "pricing" | "totals")) {
                    if let Some((_, u, r, p)) = m.facts.per_ref.iter().find(|(label, ..)| same_name(label, &page)) {
                        stated = Some(Stated { units: *u, retail: *r, price: *p, source: format!("the {} page", m.name) });
                        break;
                    }
                }
            }
            out.push(SectionInfo {
                key: format!("{}#{}", page, n + 1),
                page: page.clone(),
                name: name.unwrap_or_else(|| if several { format!("Section {}", n + 1) } else { page.clone() }),
                first_row: abs(blo.min(tail)),
                last_row: abs(tail.max(blo)),
                lines: y - x,
                units,
                retail: round2(retail),
                read: true,
                stated,
            });
        }
    }
    out
}

// ── R-564: the breakdown ────────────────────────────────────────────────────

/// One line of the analyzer's breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakdownLine {
    /// 1-based row on the sheet (on its own page), so a line can be found in the file.
    pub row: usize,
    pub desc: String,
    pub qty: f64,
    /// Extended: for the whole line.
    pub retail: f64,
    /// The sheet's own price for the line (extended), when it has one.
    pub sheet: Option<f64>,
    /// (key, name) of its category and brand; None for none.
    pub category: Option<(String, String)>,
    pub brand: Option<(String, String)>,
    /// Whether the category was placed by the built-in word list (placed == "list").
    pub guessed: bool,
    /// The line's UPC/SKU/model and condition cells, blank when the sheet has no such column.
    pub code: String,
    pub condition: String,
    /// The page (sheet) the line came from and the key of its section.
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub section: String,
    /// How the category was placed: sheet (the sheet's own column) | rule (his) | list (the
    /// built-in word list) | none.
    #[serde(default)]
    pub placed: String,
    /// Where the brand came from: sheet | rule | known (the known-brand list) | none.
    #[serde(default)]
    pub brand_from: String,
    /// A photo link, or "media:<name>" for a picture on the sheet.
    #[serde(default)]
    pub picture: Option<String>,
}

/// What the Manifest analyzer shows for a spreadsheet or CSV: the split's own lines, read
/// by the same columns, rows, brands and categories with every question at its suggested
/// answer, so the breakdown and the split can never disagree (R-396).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Breakdown {
    pub format: String,
    pub sheet: Option<String>,
    pub header_row: usize,
    pub description_col: Option<String>,
    pub quantity_col: Option<String>,
    pub price_col: Option<String>,
    pub price_is_extended: bool,
    pub category_col: Option<String>,
    pub brand_col: Option<String>,
    pub lines: Vec<BreakdownLine>,
    /// Lines whose category came from the sheet's own column rather than the title.
    pub from_sheet: usize,
    pub brands_read: usize,
    pub left_out: Option<String>,
    pub notes: Vec<String>,
    /// R-430: how the sheet prices itself, read the way the split reads it.
    pub pricing: SheetPricing,
    pub code_col: Option<String>,
    pub condition_col: Option<String>,
    /// R-564. Every sheet of the file, classified.
    #[serde(default)]
    pub pages: Vec<PageInfo>,
    /// Every section of the pages read (one per page when a page has no breaks).
    #[serde(default)]
    pub sections: Vec<SectionInfo>,
    /// Every column, with what it was read as and three sample values.
    #[serde(default)]
    pub columns: Vec<ColumnInfo>,
    /// The header names joined with " | ", or "nohdr:<columns>:<types>" when there is no
    /// header row. What a saved column map is remembered against.
    #[serde(default)]
    pub header_signature: String,
    /// The columns need Jack's say: no header row, or no quantity, or no price column read.
    #[serde(default)]
    pub needs_map: bool,
    #[serde(default)]
    pub checks: Vec<Check>,
    /// What the file says the load holds (a total row, a summary page or the file name).
    #[serde(default)]
    pub stated: Option<Stated>,
    /// The sheet carries a cost and no retail.
    #[serde(default)]
    pub cost_only: bool,
    #[serde(default)]
    pub products: Vec<Product>,
    #[serde(default)]
    pub review: Review,
    /// The header of the column read as the cost (a price for one unit, else for the line).
    #[serde(default)]
    pub cost_col: Option<String>,
    /// Lines that repeat the same title and code as a line above. Not a warning: they roll
    /// up into one product.
    #[serde(default)]
    pub repeat_lines: usize,
}

fn column_infos(t: &Table, c: &Cols) -> Vec<ColumnInfo> {
    let role = |j: usize| -> &'static str {
        let is = |o: Option<usize>| o == Some(j);
        if j == c.desc { "description" }
        else if is(c.qty) { "quantity" }
        else if is(c.retail_unit) { "retail_unit" }
        else if is(c.retail_ext) { "retail_ext" }
        else if is(c.sale_unit) { "cost" }
        else if is(c.sale_ext) { "sheet_price" }
        else if is(c.pct) { "sheet_pct" }
        else if is(c.category) { "category" }
        else if is(c.brand) { "brand" }
        else if is(c.code) { "code" }
        else if is(c.condition) { "condition" }
        else if is(c.photo_links) { "photo" }
        else { "" }
    };
    t.headers
        .iter()
        .enumerate()
        .filter(|(j, h)| !h.trim().is_empty() || t.rows.iter().any(|r| !matches!(r[*j], Val::Empty)))
        .map(|(j, h)| ColumnInfo {
            index: j,
            header: if h.trim().is_empty() { format!("Column {}", j + 1) } else { h.trim().to_string() },
            role: role(j).into(),
            hidden: t.images.hidden_cols.contains(&(t.abs_col0 + j as u32)) && j != c.desc,
            samples: col_samples(t, j),
        })
        .collect()
}

/// What a remembered column map is keyed by.
fn signature_of(t: &Table) -> String {
    if t.header_in_file {
        let names: Vec<String> = t.headers.iter().map(|h| h.trim().to_lowercase()).filter(|h| !h.is_empty() && h != "sheet").collect();
        return names.join(" | ");
    }
    let kinds: Vec<&str> = (0..t.headers.len())
        .map(|j| {
            let s = col_stats(t, j);
            if s.filled == 0 {
                "blank"
            } else if s.urls >= 0.5 {
                "url"
            } else if s.numeric >= 0.8 {
                "num"
            } else if s.codes >= 0.6 {
                "code"
            } else {
                "text"
            }
        })
        .collect();
    format!("nohdr:{}:{}", kinds.len(), kinds.join(","))
}

/// "N Units" and "Ext. Retail $X" in a file's name (the B-Stock pattern).
fn stated_from_name(name: &str) -> Option<Stated> {
    static RE_U: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static RE_R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let ru = RE_U.get_or_init(|| regex::Regex::new(r"(?i)(\d[\d,]*)\s*units?\b").unwrap());
    let rr = RE_R.get_or_init(|| regex::Regex::new(r"(?i)ext\.?\s*retail\s*\$?\s*(\d[\d,]*(?:\.\d+)?)").unwrap());
    let num = |m: Option<regex::Captures>| m.and_then(|c| c.get(1)).and_then(|g| g.as_str().replace(',', "").parse::<f64>().ok());
    let (units, retail) = (num(ru.captures(name)), num(rr.captures(name)));
    if units.is_none() && retail.is_none() {
        return None;
    }
    Some(Stated { units, retail, price: None, source: "the file name".into() })
}

/// How far a stated figure and the lines disagree: None when they agree, else the
/// description and whether it is 1% or more off.
fn compare_stated(st: &Stated, units: f64, retail: f64) -> Option<(String, bool)> {
    let mut says = Vec::new();
    let mut big = false;
    if let Some(x) = st.units {
        if (x - units).abs() > 0.5 {
            says.push(format!("{} units", fmt_int(x)));
            big |= (x - units).abs() >= 0.01 * x.max(1.0);
        }
    }
    if let Some(x) = st.retail {
        if (x - retail).abs() > 1.0f64.max(0.0005 * x) {
            says.push(format!("{} of retail", fmt_money(x)));
            big |= (x - retail).abs() >= 0.01 * x.max(1.0);
        }
    }
    if says.is_empty() { None } else { Some((says.join(" and "), big)) }
}

fn orig_word(desc: &str, w: &str) -> String {
    desc.split_whitespace()
        .find(|o| title_words(o).first().map_or(false, |x| x == w))
        .unwrap_or(w)
        .split(['-', '/', ':'])
        .find(|s| !s.is_empty())
        .unwrap_or(w)
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string()
}

/// The first word of a title that is not a lead word, spec or code ("Men's", "4K", "12pk").
fn lead_word(desc: &str) -> Option<String> {
    let words = title_words(desc);
    let w = words.iter().take(6).find(|w| !(LEAD_WORDS.contains(&w.as_str()) || SPEC_WORDS.contains(&w.as_str()) || is_code_word(w)))?;
    if w.chars().filter(|c| c.is_alphabetic()).count() < 2 || NOT_BRANDS.contains(&w.as_str()) {
        return None;
    }
    Some(w.clone())
}

fn product_key(l: &BreakdownLine) -> String {
    let code = l.code.trim();
    let digits: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    let upc_like = !code.is_empty() && digits.len() >= 8 && digits.len() == code.chars().filter(|c| c.is_alphanumeric()).count();
    if upc_like {
        return format!("c:{}", digits.trim_start_matches('0'));
    }
    let title = title_words(&l.desc).join(" ");
    if code.is_empty() { format!("t:{}", title) } else { format!("t:{}|{}", code.to_lowercase(), title) }
}

fn roll_up(lines: &[BreakdownLine]) -> Vec<Product> {
    let mut idx: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Product> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let key = product_key(l);
        let at = *idx.entry(key.clone()).or_insert_with(|| {
            out.push(Product {
                key,
                title: l.desc.clone(),
                code: l.code.clone(),
                brand: l.brand.as_ref().map(|b| b.1.clone()),
                category: Some(l.category.as_ref().map(|c| c.1.clone()).unwrap_or_else(|| "Unplaced".into())),
                placed: l.placed.clone(),
                qty: 0.0,
                retail: 0.0,
                cost: None,
                rows: Vec::new(),
                lines: 0,
                picture: None,
                line_ids: Vec::new(),
                page: l.page.clone(),
                section: l.section.clone(),
            });
            out.len() - 1
        });
        let p = &mut out[at];
        p.qty += l.qty;
        p.retail += l.retail;
        if let Some(s) = l.sheet {
            p.cost = Some(p.cost.unwrap_or(0.0) + s);
        }
        p.rows.push(l.row);
        p.lines += 1;
        p.line_ids.push(i);
        if p.picture.is_none() {
            p.picture = l.picture.clone();
        }
        if p.brand.is_none() {
            p.brand = l.brand.as_ref().map(|b| b.1.clone());
        }
    }
    for p in out.iter_mut() {
        p.retail = round2(p.retail);
        p.cost = p.cost.map(round2);
    }
    out
}

fn review_of(lines: &[BreakdownLine], nodesc: &[bool]) -> Review {
    // Every line the sheet did not place (placed by the list, or by nothing) lands in exactly
    // one group. A group never mixes lines whose suggested category differs: lines are
    // first split by what the list suggested (or nothing), then by the word their title
    // opens with; a line whose word opens no other line of its kind is its own group,
    // labelled by its title. A UPC prefix only splits a big word group further.
    let suggested_of = |i: usize| -> Option<String> {
        if lines[i].placed == "list" { lines[i].category.as_ref().map(|c| c.1.clone()) } else { None }
    };
    let group = |key: String, kind: &str, pattern: String, label: String, idx: &[usize], suggested: Option<String>| Group {
        key, kind: kind.into(), pattern, label,
        lines: idx.len(),
        units: idx.iter().map(|&i| lines[i].qty).sum(),
        retail: round2(idx.iter().map(|&i| lines[i].retail).sum()),
        suggested,
    };
    let mut by_word: HashMap<(Option<String>, String), Vec<usize>> = HashMap::new();
    let mut by_title: HashMap<(Option<String>, String), Vec<usize>> = HashMap::new();
    let mut no_description: Vec<usize> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if !(l.placed == "list" || l.placed == "none") {
            continue;
        }
        if nodesc[i] {
            no_description.push(i);
            continue;
        }
        let s = suggested_of(i);
        match lead_word(&l.desc) {
            Some(w) => by_word.entry((s, w)).or_default().push(i),
            None => by_title.entry((s, title_words(&l.desc).join(" "))).or_default().push(i),
        }
    }
    let mut groups: Vec<Group> = Vec::new();
    for ((s, w), mut idx) in by_word {
        if idx.len() < 2 {
            let l = &lines[idx[0]];
            by_title.entry((s, title_words(&l.desc).join(" "))).or_default().extend(idx);
            continue;
        }
        let label = orig_word(&lines[idx[0]].desc, &w);
        if idx.len() >= 10 {
            let mut by_upc: HashMap<String, Vec<usize>> = HashMap::new();
            for &i in &idx {
                let d = digits_of(&lines[i].code);
                if d.len() >= 10 {
                    by_upc.entry(d[..6].to_string()).or_default().push(i);
                }
            }
            for (p, part) in by_upc {
                if part.len() >= 5 && part.len() < idx.len() {
                    idx.retain(|i| !part.contains(i));
                    groups.push(group(format!("upc:{}|{}|{}", p, w, s.clone().unwrap_or_default()), "upc_prefix", p.clone(), format!("{} (UPC starting {})", label, p), &part, s.clone()));
                }
            }
        }
        if !idx.is_empty() {
            groups.push(group(format!("word:{}|{}", w, s.clone().unwrap_or_default()), "word", w.clone(), label, &idx, s.clone()));
        }
    }
    for ((s, title), idx) in by_title {
        let label = lines[idx[0]].desc.trim().to_string();
        let label = if label.is_empty() { "(no title)".to_string() } else { label };
        groups.push(group(format!("line:{}|{}", title, s.clone().unwrap_or_default()), "phrase", title, label, &idx, s));
    }
    if !no_description.is_empty() {
        groups.push(group("nodesc".into(), "phrase", "no description".into(), "Lines with no description".into(), &no_description, None));
    }
    groups.sort_by(|a, b| {
        b.retail.partial_cmp(&a.retail).unwrap_or(std::cmp::Ordering::Equal)
            .then(b.units.partial_cmp(&a.units).unwrap_or(std::cmp::Ordering::Equal))
            .then(b.lines.cmp(&a.lines))
            .then(a.key.cmp(&b.key))
    });

    // Brands: lines with none, by the word their title opens with.
    let mut by_brand: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, l) in lines.iter().enumerate() {
        if nodesc[i] || l.brand.is_some() {
            continue;
        }
        if let Some(w) = lead_word(&l.desc) {
            if !manifest_category::is_product_word(&w) {
                by_brand.entry(w).or_default().push(i);
            }
        }
    }
    let mut brands: Vec<Group> = Vec::new();
    for (w, idx) in &by_brand {
        if idx.len() >= 3 {
            let label = orig_word(&lines[idx[0]].desc, w);
            brands.push(group(format!("brand:{}", w), "brand_word", w.clone(), label.clone(), idx, Some(label)));
        }
    }
    brands.sort_by(|a, b| b.retail.partial_cmp(&a.retail).unwrap_or(std::cmp::Ordering::Equal).then(b.lines.cmp(&a.lines)).then(a.key.cmp(&b.key)));
    brands.truncate(300);
    Review { groups, brands, category_names: manifest_category::category_names().iter().map(|s| s.to_string()).collect() }
}

fn check(severity: &str, code: &str, text: String, fix: &str, rows: Vec<usize>) -> Check {
    Check { severity: severity.into(), code: code.into(), text, fix: fix.into(), rows: rows.into_iter().take(200).collect() }
}

/// A breakdown with no lines: the pages and columns are there to be fixed, with the reason.
fn empty_breakdown(t: &Table, o: &ReadOptions, why_code: &str, why: String, fix: &str, cols: Option<&Cols>) -> Breakdown {
    let mut b = Breakdown {
        format: t.format.clone(),
        sheet: t.sheet.clone(),
        header_row: t.header_row,
        description_col: None,
        quantity_col: None,
        price_col: None,
        price_is_extended: false,
        category_col: None,
        brand_col: None,
        lines: Vec::new(),
        from_sheet: 0,
        brands_read: 0,
        left_out: None,
        notes: t.notes.clone(),
        pricing: SheetPricing { kind: "none".into(), pct: None, unit: None, evidence: "no lines were read".into(), total: None },
        code_col: None,
        condition_col: None,
        pages: pages_info(t, &HashSet::new()),
        sections: Vec::new(),
        columns: match cols {
            Some(c) => column_infos(t, c),
            None => column_infos(t, &Cols::default()),
        },
        header_signature: signature_of(t),
        needs_map: true,
        checks: vec![check("red", why_code, why, fix, Vec::new())],
        stated: None,
        cost_only: false,
        products: Vec::new(),
        review: Review { category_names: manifest_category::category_names().iter().map(|s| s.to_string()).collect(), ..Review::default() },
        cost_col: None,
        repeat_lines: 0,
    };
    let candidates = stated_candidates(t, None, &HashSet::new());
    b.stated = candidates.into_iter().next();
    let _ = o;
    b
}

fn pages_info(t: &Table, read: &HashSet<String>) -> Vec<PageInfo> {
    t.pages
        .iter()
        .map(|m| PageInfo {
            name: m.name.clone(),
            rows: m.rows,
            kind: m.kind.into(),
            read: read.contains(&m.name),
            header_row: m.header_row,
            same_header_as: m.same_as.clone(),
            hidden: m.hidden,
        })
        .collect()
}

/// What the file says about itself, best source first: the sheet's total row, a summary
/// page, the file's name.
fn stated_candidates(t: &Table, sheet_total: Option<(Option<f64>, Option<f64>)>, read_pages: &HashSet<String>) -> Vec<Stated> {
    let mut out: Vec<Stated> = Vec::new();
    if let Some((u, r)) = sheet_total.filter(|(u, r)| u.is_some() || r.is_some()) {
        out.push(Stated { units: u, retail: r, price: None, source: "the total row on the sheet".into() });
    }
    // A summary page that lists each pallet read.
    for m in t.pages.iter().filter(|m| matches!(m.kind, "summary" | "pricing" | "totals")) {
        if !read_pages.is_empty() && !m.facts.per_ref.is_empty() {
            let found: Vec<&(String, Option<f64>, Option<f64>, Option<f64>)> =
                read_pages.iter().filter_map(|p| m.facts.per_ref.iter().find(|(l, ..)| same_name(l, p))).collect();
            if found.len() == read_pages.len() {
                let sum = |f: &dyn Fn(&(String, Option<f64>, Option<f64>, Option<f64>)) -> Option<f64>| -> Option<f64> {
                    if found.iter().all(|x| f(x).is_some()) { Some(found.iter().filter_map(|x| f(x)).sum()) } else { None }
                };
                let st = Stated {
                    units: sum(&|x| x.1),
                    retail: sum(&|x| x.2).map(round2),
                    price: sum(&|x| x.3).map(round2),
                    source: format!("the {} page", m.name),
                };
                if st.units.is_some() || st.retail.is_some() {
                    out.push(st);
                    continue;
                }
            }
        }
        let f = &m.facts;
        if f.units.is_some() || f.retail.is_some() || f.price.is_some() {
            out.push(Stated { units: f.units, retail: f.retail, price: f.price, source: format!("the {} page", m.name) });
        }
    }
    if let Some(st) = stated_from_name(&t.file_name) {
        out.push(st);
    }
    out
}

pub(crate) fn breakdown(path: &str) -> Result<Breakdown> {
    breakdown_with(path, &ReadOptions::default())
}

/// The analyzer's reading of a file, with whatever Jack has said about it: the pages, the
/// sections left out, his column map and his rules. With the defaults it is `breakdown`.
pub fn breakdown_with(path: &str, o: &ReadOptions) -> Result<Breakdown> {
    let hdr = o.columns.as_ref().map(|m| m.header_row.unwrap_or(0));
    let picked: Option<String> = match &o.pages {
        Some(p) if p.len() == 1 => Some(p[0].clone()),
        Some(p) if p.len() > 1 => Some(format!("{}{}", MANY, p.join(&MANY.to_string()))),
        _ => None,
    };
    let t0 = table(path, picked.as_deref(), hdr)?;
    if o.pages.is_none() && !t0.pages.iter().any(|m| m.kind == "lines" && !m.hidden) {
        return Ok(empty_breakdown(
            &t0,
            o,
            "no_lines",
            "No page of this file reads as a list of products. Pick the page that holds the lines, or ask the supplier for the full list.".into(),
            "pages",
            None,
        ));
    }
    let answers = HashMap::new();
    let mut ask = Ask { answers: &answers, questions: Vec::new() };
    let mut notes = Vec::new();
    let p = match prepare(path, &mut ask, &mut notes, o) {
        Ok(p) => p,
        Err(e) => {
            return Ok(empty_breakdown(&t0, o, "columns", format!("{}. Pick the columns by hand.", e.to_string().trim_end_matches('.')), "columns", None));
        }
    };
    let t = p.t.clone();
    notes.retain(|n| Some(n) != p.left_out.as_ref() && !n.starts_with("The sheet's own total row says"));
    if t.pages.len() > 1 && t.sheets.len() > 1 && o.pages.is_none() && t.sheet.as_deref() != Some(ALL_SHEETS) {
        let others: Vec<String> = t.pages.iter().filter(|m| Some(&m.name) != t.sheet.as_ref() && m.kind == "lines" && !m.hidden).map(|m| m.name.clone()).collect();
        if !others.is_empty() {
            notes.insert(0, format!("This file has {} pages that look like product lines; this is {}. The others ({}) can be added in Pages.",
                others.len() + 1, t.sheet.clone().unwrap_or_default(), list_names(&others)));
        }
    }
    let read_pages: HashSet<String> = if t.sheet.as_deref() == Some(ALL_SHEETS) {
        t.row_pages.iter().cloned().collect()
    } else {
        std::iter::once(t.sheet.clone().unwrap_or_else(|| t.stem.clone())).collect()
    };
    let head = |j: Option<usize>| j.map(|j| t.headers[j].trim().to_string()).filter(|h| !h.is_empty());
    let from_sheet = (0..p.lines.len()).filter(|&i| p.cats[i].is_some() && p.placed[i] == "sheet").count();
    let pricing0 = detect_pricing(&t, &p.cols, &p.lines, &p.footers);
    let lines: Vec<BreakdownLine> = (0..p.lines.len())
        .map(|i| {
            let l = &p.lines[i];
            BreakdownLine {
                row: t.abs_rows[l.row] as usize + 1,
                desc: l.desc.clone(),
                qty: l.qty,
                retail: l.retail,
                sheet: l.sheet,
                category: p.cats[i].clone(),
                brand: p.brands[i].clone(),
                guessed: p.guessed[i],
                code: l.code.clone(),
                condition: l.condition.clone(),
                page: l.page.clone(),
                section: format!("{}#{}", l.page, l.section + 1),
                placed: p.placed[i].to_string(),
                brand_from: if p.brands[i].is_some() { p.brand_from[i].to_string() } else { "none".into() },
                picture: l.picture.clone(),
            }
        })
        .collect();
    let nodesc: Vec<bool> = p.lines.iter().map(|l| l.nodesc).collect();
    let (units, retail): (f64, f64) = (lines.iter().map(|l| l.qty).sum(), lines.iter().map(|l| l.retail).sum());
    let cols = &p.cols;
    let cost_only = retail <= 0.0 && (cols.sale_unit.is_some() || cols.sale_ext.is_some());

    // The columns: does the reader know enough, or does Jack have to say?
    let no_header = !t.header_in_file && o.columns.is_none();
    let no_qty = cols.qty.is_none() && cols.size_cols.is_empty();
    let no_price = cols.retail_unit.is_none() && cols.retail_ext.is_none() && cols.sale_unit.is_none() && cols.sale_ext.is_none() && cols.pct.is_none();
    let needs_map = no_header || no_qty || no_price;

    // What the file says it holds, against what was read.
    let candidates = stated_candidates(&t, p.sheet_total, &read_pages);
    let all_pages_read = t.pages.iter().filter(|m| m.kind == "lines" && !m.hidden).all(|m| read_pages.contains(&m.name));
    let stated = candidates.iter().find(|s| s.units.is_some() || s.retail.is_some()).cloned();
    let price_stated = candidates.iter().find_map(|s| s.price.map(|pr| (pr, s.source.clone())));
    let mut pricing = pricing0;
    if pricing.kind == "none" {
        if let Some((pr, src)) = &price_stated {
            pricing = SheetPricing { kind: "line".into(), pct: None, unit: None, evidence: format!("{} gives one price for the whole load: {}", src, fmt_money(*pr)), total: Some(*pr) };
        }
    }

    let mut checks: Vec<Check> = Vec::new();
    if no_header {
        checks.push(check("red", "no_header", "This sheet has no row of column names, so the columns were worked out from the numbers. Check them before trusting any figure.".into(), "columns", Vec::new()));
    }
    if no_qty && !no_header {
        checks.push(check("red", "no_quantity", "No column reads as a quantity, so every line counts as 1 unit.".into(), "columns", Vec::new()));
    }
    if no_price && !no_header {
        checks.push(check("red", "no_price", "No column reads as a retail value or a price.".into(), "columns", Vec::new()));
    }
    let mut guessed: Vec<String> = Vec::new();
    if cols.ambiguous.is_some() && o.columns.is_none() {
        guessed.push(format!("\"{}\" could be retail or this load's price", head(cols.ambiguous).unwrap_or_default()));
    }
    if !cols.other_qty.is_empty() && o.columns.is_none() {
        guessed.push(format!("more than one column holds a quantity (using \"{}\")", head(cols.qty).unwrap_or_default()));
    }
    if t.header_in_file && o.columns.is_none() {
        let dh = hwords(&t.headers[cols.desc]);
        let named = ["name", "product", "title", "desc", "item", "model", "style", "article", "listing"].iter().any(|w| t.headers[cols.desc].to_lowercase().contains(w));
        if !named && !hhas(&dh, TITLE_HEADS) && !hhas(&dh, DESC_HEADS) {
            guessed.push(format!("the description was picked by its contents (\"{}\")", t.headers[cols.desc].trim()));
        }
    }
    if !guessed.is_empty() {
        checks.push(check("amber", "guessed_columns", format!("Some columns were guessed: {}.", guessed.join("; ")), "columns", Vec::new()));
    }
    for st in &candidates {
        if st.units.is_none() && st.retail.is_none() {
            continue;
        }
        if let Some((says, big)) = compare_stated(st, p.all_read.1, p.all_read.2) {
            let partial = st.source != "the total row on the sheet" && !all_pages_read;
            checks.push(check(
                if big && !partial { "red" } else { "amber" },
                "total_mismatch",
                format!(
                    "{} says {}; the lines read add up to {} units and {}.{}",
                    capitalise(&st.source), says, fmt_int(p.all_read.1), fmt_money(p.all_read.2),
                    if partial { " Some pages that look like product lines were not read." } else { "" }
                ),
                if st.source.starts_with("the total row") { "columns" } else { "pages" },
                Vec::new(),
            ));
        }
    }
    for sec in p.sections.iter() {
        if let Some(st) = &sec.stated {
            if let Some((says, big)) = compare_stated(st, sec.units, sec.retail) {
                checks.push(check(
                    if big { "red" } else { "amber" },
                    "section_mismatch",
                    format!("{}: {} says {}; its lines add up to {} units and {}.", sec.name, st.source, says, fmt_int(sec.units), fmt_money(sec.retail)),
                    "lines",
                    vec![sec.first_row, sec.last_row],
                ));
            }
        }
    }
    let nodesc_rows: Vec<usize> = (0..lines.len()).filter(|&i| nodesc[i]).map(|i| lines[i].row).collect();
    if !nodesc_rows.is_empty() {
        let share = nodesc_rows.len() as f64 / lines.len().max(1) as f64;
        checks.push(check(
            if share > 0.02 { "red" } else { "amber" },
            "no_description",
            format!("{} no description on the sheet, so {} named by {} code or row.", plural(nodesc_rows.len(), "line has", "lines have"), if nodesc_rows.len() == 1 { "it is" } else { "they are" }, if nodesc_rows.len() == 1 { "its" } else { "their" }),
            "columns",
            nodesc_rows,
        ));
    }
    let unpriced: Vec<usize> = (0..lines.len()).filter(|&i| if cost_only { lines[i].sheet.is_none() } else { lines[i].retail <= 0.0 }).collect();
    if !unpriced.is_empty() && unpriced.len() < lines.len() {
        let u: f64 = unpriced.iter().map(|&i| lines[i].qty).sum();
        checks.push(check(
            if u * 2.0 > units { "red" } else { "amber" },
            "unpriced",
            format!("{} no {} ({} units), so {} left out of the price.", plural(unpriced.len(), "line has", "lines have"), if cost_only { "cost" } else { "retail value" }, fmt_int(u), if unpriced.len() == 1 { "it is" } else { "they are" }),
            "lines",
            unpriced.iter().map(|&i| lines[i].row).collect(),
        ));
    }
    if p.qty_missing > 0 {
        checks.push(check("amber", "quantity_missing", format!("{} no readable quantity and count as 1 unit each.", plural(p.qty_missing, "line has", "lines have")), "lines", Vec::new()));
    }
    if units > 0.0 && retail / units > 10_000.0 {
        checks.push(check("red", "implausible", format!("The retail comes to {} for {} units, which is too much per unit to be right. A column is probably the wrong one.", fmt_money(retail), fmt_int(units)), "columns", Vec::new()));
    }
    if cost_only {
        checks.push(check("amber", "cost_only", "This sheet gives a cost for each unit and no retail value, so there is no retail to show. The cost is the figure to go by.".into(), "none", Vec::new()));
    }
    let unread: Vec<String> = t.pages.iter().filter(|m| m.kind == "lines" && !m.hidden && !read_pages.contains(&m.name)).map(|m| m.name.clone()).collect();
    if !unread.is_empty() && o.pages.is_none() {
        checks.push(check("amber", "pages_not_read", format!("{} look like product lines and {} not read: {}.", plural(unread.len(), "page", "pages"), if unread.len() == 1 { "was" } else { "were" }, list_names(&unread)), "pages", Vec::new()));
    }
    checks.sort_by_key(|c| if c.severity == "red" { 0 } else { 1 });

    let (products, review) = if o.resolve_only {
        (Vec::new(), Review { category_names: manifest_category::category_names().iter().map(|s| s.to_string()).collect(), ..Review::default() })
    } else {
        (roll_up(&lines), review_of(&lines, &nodesc))
    };

    Ok(Breakdown {
        format: t.format.clone(),
        sheet: t.sheet.clone(),
        header_row: t.header_row,
        description_col: head(Some(cols.desc)),
        quantity_col: head(cols.qty),
        price_col: head(cols.retail_unit.or(cols.retail_ext)),
        price_is_extended: cols.retail_unit.is_none() && cols.retail_ext.is_some(),
        category_col: head(cols.category),
        brand_col: head(cols.brand),
        lines,
        from_sheet,
        brands_read: p.brands_read,
        left_out: p.left_out.clone(),
        notes,
        pricing,
        code_col: head(cols.code),
        condition_col: head(cols.condition),
        pages: pages_info(&t, &read_pages),
        sections: p.sections.clone(),
        columns: column_infos(&t, cols),
        header_signature: signature_of(&t),
        needs_map,
        checks,
        stated,
        cost_only,
        products,
        review,
        cost_col: head(cols.sale_unit.or(cols.sale_ext)),
        repeat_lines: p.repeat_lines,
    })
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
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
    g: &Piece,
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
    let wanted: Vec<&Piece> = s.groups.iter().filter(|g| !s.skipped.contains(&g.key)).collect();
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
        // Not a known brand: a first word that opens four titles is a question, never a brand.
        assert!(!names.contains("Zorbex"), "{:?}", names);
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
    // ── R-564 ───────────────────────────────────────────────────────────────

    fn read_csv(name: &str, csv: &str, o: &ReadOptions) -> Breakdown {
        let p = tmp(name, csv.as_bytes());
        breakdown_with(&p, o).unwrap()
    }

    /// Three pallets on one page: a title row, a header row, lines and a total row each.
    const THREE_PALLETS: &str = "PALLET 101\n\
Description,Brand,Qty,Unit Retail\n\
Nike Air Max 90,Nike,2,100\n\
Adidas Samba OG,Adidas,1,80\n\
TOTAL,,3,280\n\
,,,\n\
PALLET 102\n\
Description,Brand,Qty,Unit Retail\n\
Puma Suede Classic,Puma,4,50\n\
Crocs Classic Clog,Crocs,1,40\n\
TOTAL,,5,240\n\
,,,\n\
PALLET 103\n\
Description,Brand,Qty,Unit Retail\n\
Vans Old Skool,Vans,2,60\n\
Reebok Classic Leather,Reebok,1,70\n\
New Balance 574,New Balance,3,90\n\
TOTAL,,6,460\n";

    #[test]
    fn one_page_with_three_pallets_reads_as_three_sections() {
        let b = read_csv("three.csv", THREE_PALLETS, &ReadOptions::default());
        assert_eq!(b.lines.len(), 7, "{:?}", b.lines.iter().map(|l| &l.desc).collect::<Vec<_>>());
        assert_eq!(b.sections.len(), 3, "{:?}", b.sections.iter().map(|s| (&s.key, &s.name)).collect::<Vec<_>>());
        let got: Vec<(&str, usize, f64, f64)> = b.sections.iter().map(|s| (s.name.as_str(), s.lines, s.units, s.retail)).collect();
        assert_eq!(got, vec![("PALLET 101", 2, 3.0, 280.0), ("PALLET 102", 2, 5.0, 240.0), ("PALLET 103", 3, 6.0, 460.0)]);
        // Each pallet keeps its own total row, and every line says which pallet it is on.
        for s in &b.sections {
            let st = s.stated.as_ref().expect("a total row");
            assert_eq!(st.units, Some(s.units));
            assert_eq!(st.retail, Some(s.retail));
        }
        assert_eq!(b.lines.iter().filter(|l| l.section == b.sections[1].key).count(), 2);
        assert!(!b.checks.iter().any(|c| c.code == "section_mismatch"), "{:?}", b.checks);
    }

    #[test]
    fn a_plain_sheet_is_one_section_and_a_section_can_be_left_out() {
        let plain = read_csv("plain.csv", PRICED_CSV, &ReadOptions::default());
        assert_eq!(plain.sections.len(), 1);
        assert_eq!(plain.sections[0].lines, plain.lines.len());
        let off = ReadOptions { sections_off: vec!["three#2".into()], ..ReadOptions::default() };
        let b = read_csv("three.csv", THREE_PALLETS, &off);
        assert_eq!(b.lines.len(), 5);
        assert!(b.sections.iter().any(|s| s.key == "three#2" && !s.read && s.lines == 2));
        assert!(b.lines.iter().all(|l| l.section != "three#2"));
    }

    #[test]
    fn a_pallet_label_row_without_a_new_header_starts_a_section() {
        let csv = "Description,Qty,Unit Retail\n\
Nike Air Max 90,2,100\n\
Puma Suede Classic,1,50\n\
PALLET 2\n\
Vans Old Skool,2,60\n\
Crocs Classic Clog,1,40\n";
        let b = read_csv("labels.csv", csv, &ReadOptions::default());
        assert_eq!(b.lines.len(), 4);
        assert_eq!(b.sections.len(), 2);
        assert_eq!(b.sections[1].name, "PALLET 2");
        assert_eq!(b.sections[1].lines, 2);
    }

    #[test]
    fn his_column_map_replaces_detection() {
        // No header row: the reader can only guess, and says so.
        let csv = "A100,5,19.99,Garden gnome ceramic\nA101,2,45.00,Patio umbrella blue\nA102,1,9.50,Citronella candle\n";
        let guess = read_csv("nohdr.csv", csv, &ReadOptions::default());
        assert!(guess.needs_map);
        assert!(guess.header_signature.starts_with("nohdr:4:"), "{}", guess.header_signature);
        let map = ColumnMap {
            header_row: None,
            roles: [("description", 3usize), ("quantity", 1), ("retail_unit", 2), ("code", 0)].iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        };
        let b = read_csv("nohdr.csv", csv, &ReadOptions { columns: Some(map), ..ReadOptions::default() });
        assert!(!b.needs_map, "{:?}", b.checks);
        assert_eq!(b.lines.len(), 3);
        assert_eq!(b.lines.iter().map(|l| l.qty).sum::<f64>(), 8.0);
        assert!((b.lines.iter().map(|l| l.retail).sum::<f64>() - (5.0 * 19.99 + 90.0 + 9.5)).abs() < 0.01);
        assert_eq!(b.lines[0].desc, "Garden gnome ceramic");
        assert_eq!(b.lines[0].code, "A100");
        assert!(b.columns.iter().any(|c| c.role == "retail_unit" && c.index == 2 && c.samples.len() == 3));
    }

    #[test]
    fn a_header_row_he_points_at_is_used() {
        let csv = "junk,more junk,x\nthings,here,y\nItem,Count,Each\nWidget,2,5\nGadget,3,7\n";
        let map = ColumnMap {
            header_row: Some(3),
            roles: [("description", 0usize), ("quantity", 1), ("retail_unit", 2)].iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        };
        let b = read_csv("hdr.csv", csv, &ReadOptions { columns: Some(map), ..ReadOptions::default() });
        assert_eq!(b.lines.len(), 2);
        assert_eq!(b.lines.iter().map(|l| l.retail).sum::<f64>(), 31.0);
    }

    fn rule(kind: &str, pattern: &str, cat: &str) -> Rule {
        Rule { kind: kind.into(), pattern: pattern.into(), category: Some(cat.into()), ..Rule::default() }
    }

    #[test]
    fn his_rule_beats_the_built_in_list_and_the_longest_pattern_wins() {
        let csv = "Description,Qty,Unit Retail\nNike Air Max 90 Mens,1,100\nAcme Gizmo Deluxe,1,10\n";
        let plain = read_csv("rules.csv", csv, &ReadOptions::default());
        assert_eq!(plain.lines[0].category.as_ref().map(|c| c.1.as_str()), Some("Shoes"));
        assert_eq!(plain.lines[0].placed, "list");
        assert!(plain.lines[0].guessed);
        assert_eq!(plain.lines[1].placed, "none");
        let o = ReadOptions {
            rules: vec![rule("word", "nike", "Toys"), rule("phrase", "Air Max", "Clothing"), rule("word", "gizmo", "Tools & Hardware")],
            ..ReadOptions::default()
        };
        let b = read_csv("rules.csv", csv, &o);
        // "air max" is the longer pattern.
        assert_eq!(b.lines[0].category.as_ref().map(|c| c.1.as_str()), Some("Clothing"));
        assert_eq!(b.lines[0].placed, "rule");
        assert!(!b.lines[0].guessed);
        assert_eq!(b.lines[1].category.as_ref().map(|c| c.1.as_str()), Some("Tools & Hardware"));
        assert_eq!(b.lines[1].placed, "rule");
    }

    #[test]
    fn a_upc_prefix_and_a_sheet_category_rule_place_lines() {
        let csv = "Description,Category,UPC,Qty,Unit Retail\n\
Mystery thing one,Toys & Games,673419377065,1,10\n\
Mystery thing two,Toys & Games,673419390453,1,10\n\
Mystery thing three,Garden,885911111111,1,10\n";
        let o = ReadOptions { rules: vec![rule("sheet_category", "toys and games", "Toys"), rule("upc_prefix", "885911", "Tools & Hardware")], ..ReadOptions::default() };
        let b = read_csv("sc.csv", csv, &o);
        assert_eq!(b.lines[0].category.as_ref().map(|c| c.1.as_str()), Some("Toys"));
        assert_eq!(b.lines[0].placed, "rule");
        // The sheet's own category stands when no sheet_category rule is about it.
        assert_eq!(b.lines[2].category.as_ref().map(|c| c.1.as_str()), Some("Garden"));
        assert_eq!(b.lines[2].placed, "sheet");
        // A UPC prefix places a line that has no category of its own.
        let csv2 = "Description,UPC,Qty,Unit Retail\nMystery thing,885911222222,1,10\n";
        let b2 = read_csv("upc.csv", csv2, &ReadOptions { rules: vec![rule("upc_prefix", "885911", "Tools & Hardware")], ..ReadOptions::default() });
        assert_eq!(b2.lines[0].category.as_ref().map(|c| c.1.as_str()), Some("Tools & Hardware"));
    }

    #[test]
    fn a_first_word_is_never_a_brand_but_is_offered_as_one() {
        let mut csv = String::from("Description,Qty,Unit Retail\n");
        for i in 0..4 {
            csv.push_str(&format!("Zorbex Widget {},1,15\n", i));
            csv.push_str(&format!("Nike Air Max {},1,120\n", i));
        }
        csv.push_str(",1,5\n");
        let b = read_csv("fw.csv", &csv, &ReadOptions::default());
        let zorbex: Vec<&BreakdownLine> = b.lines.iter().filter(|l| l.desc.starts_with("Zorbex")).collect();
        assert!(zorbex.iter().all(|l| l.brand.is_none() && l.brand_from == "none"));
        assert!(b.lines.iter().filter(|l| l.desc.starts_with("Nike")).all(|l| l.brand_from == "known"));
        // A line with no description is not a brand ("Row 10 (no description)").
        assert!(b.review.brands.iter().all(|g| g.pattern != "row"), "{:?}", b.review.brands);
        let g = b.review.brands.iter().find(|g| g.pattern == "zorbex").expect("a brand group");
        assert_eq!((g.lines, g.kind.as_str()), (4, "brand_word"));
        // The same lines are offered for a category too, starting from what the list knew.
        let c = b.review.groups.iter().find(|g| g.pattern == "zorbex").expect("a category group");
        assert_eq!((c.lines, c.kind.as_str(), c.suggested.clone()), (4, "word", None));
        let n = b.review.groups.iter().find(|g| g.pattern == "nike").expect("a nike group");
        assert_eq!(n.suggested.as_deref(), Some("Shoes"));
        assert!(b.review.category_names.iter().any(|c| c == "Toys"));
        // Once he names it, it is a brand, from his rule.
        let o = ReadOptions { rules: vec![Rule { kind: "brand_word".into(), pattern: "Zorbex".into(), brand: Some("Zorbex".into()), ..Rule::default() }], ..ReadOptions::default() };
        let b = read_csv("fw.csv", &csv, &o);
        assert!(b.lines.iter().filter(|l| l.desc.starts_with("Zorbex")).all(|l| l.brand.as_ref().map(|x| x.1.as_str()) == Some("Zorbex") && l.brand_from == "rule"));
    }

    #[test]
    fn the_file_names_units_and_retail_are_checked_against_the_lines() {
        let csv = "title,quantity,unit_retail_price\nA Thing,3,10\nB Thing,2,20\n";
        let ok = read_csv("BStock_Lot, 5 Units, Ext. Retail $70, Upper Marlboro, MD_Manifest.csv", csv, &ReadOptions::default());
        let st = ok.stated.as_ref().expect("stated from the file name");
        assert_eq!((st.units, st.retail, st.source.as_str()), (Some(5.0), Some(70.0), "the file name"));
        assert!(!ok.checks.iter().any(|c| c.code == "total_mismatch"), "{:?}", ok.checks);
        let bad = read_csv("BStock_Lot, 9 Units, Ext. Retail $70, Upper Marlboro, MD_Manifest.csv", csv, &ReadOptions::default());
        let c = bad.checks.iter().find(|c| c.code == "total_mismatch").expect("a mismatch");
        assert_eq!(c.severity, "red");
        assert!(c.text.contains("9 units"), "{}", c.text);
    }

    #[test]
    fn a_sheet_with_no_quantity_or_no_header_needs_the_map() {
        let b = read_csv("noq.csv", "Description,Unit Retail\nWidget,5\nGadget,7\n", &ReadOptions::default());
        assert!(b.needs_map);
        assert!(b.checks.iter().any(|c| c.severity == "red" && c.code == "no_quantity"));
        let ok = read_csv("ok.csv", PRICED_CSV, &ReadOptions::default());
        assert!(!ok.needs_map);
        assert!(!ok.header_signature.is_empty() && !ok.header_signature.starts_with("nohdr"));
    }

    #[test]
    fn a_cost_only_sheet_is_marked_and_rolled_up_by_code() {
        let csv = "Product,UPC,Qty,Cost,Total\nTee blue,100000000001,2,4,8\nTee blue,100000000001,3,4,12\nCap red,100000000002,1,5,5\n";
        let b = read_csv("cost.csv", csv, &ReadOptions::default());
        assert!(b.cost_only);
        assert!(!b.needs_map);
        assert_eq!(b.products.len(), 2);
        let tee = &b.products[0];
        assert_eq!((tee.lines, tee.qty, tee.cost), (2, 5.0, Some(20.0)));
        assert_eq!(tee.rows.len(), 2);
    }

    #[test]
    fn a_workbook_is_read_page_by_page() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        {
            let ws = wb.add_worksheet().set_name("Summary & Pricing").unwrap();
            for (c, h) in ["UNITS", "TOTAL MSRP", "TOTAL COST"].iter().enumerate() {
                ws.write_string(0, c as u16, *h).unwrap();
            }
            ws.write_number(1, 0, 6.0).unwrap();
            ws.write_number(1, 1, 350.0).unwrap();
            ws.write_number(1, 2, 90.0).unwrap();
        }
        for (name, rows) in [("Z100", [("Nike Air Max 90", 2.0, 100.0), ("Puma Suede", 1.0, 50.0)]), ("Z200", [("Vans Old Skool", 1.0, 50.0), ("Crocs Clog", 2.0, 25.0)])] {
            let ws = wb.add_worksheet().set_name(name).unwrap();
            for (c, h) in ["Item Description", "Qty", "Unit Retail"].iter().enumerate() {
                ws.write_string(0, c as u16, *h).unwrap();
            }
            for (i, (d, q, r)) in rows.iter().enumerate() {
                ws.write_string(i as u32 + 1, 0, *d).unwrap();
                ws.write_number(i as u32 + 1, 1, *q).unwrap();
                ws.write_number(i as u32 + 1, 2, *r).unwrap();
            }
        }
        let path = tmp("book.xlsx", &wb.save_to_buffer().unwrap());
        let b = breakdown_with(&path, &ReadOptions::default()).unwrap();
        let kinds: Vec<(&str, &str, bool)> = b.pages.iter().map(|p| (p.name.as_str(), p.kind.as_str(), p.read)).collect();
        assert_eq!(kinds, vec![("Summary & Pricing", "pricing", false), ("Z100", "lines", true), ("Z200", "lines", true)]);
        assert_eq!(b.pages[2].same_header_as.as_deref(), Some("Z100"));
        // Both pallets together; the summary page is read for the totals and the price, not as lines.
        assert_eq!((b.lines.len(), b.sections.len()), (4, 2));
        let st = b.stated.as_ref().unwrap();
        assert_eq!((st.units, st.retail, st.price), (Some(6.0), Some(350.0), Some(90.0)));
        assert_eq!(b.pricing.total, Some(90.0));
        assert!(!b.checks.iter().any(|c| c.code == "total_mismatch"), "{:?}", b.checks);
        // One page chosen by name.
        let one = breakdown_with(&path, &ReadOptions { pages: Some(vec!["Z200".into()]), ..ReadOptions::default() }).unwrap();
        assert_eq!(one.lines.len(), 2);
        assert!(one.pages.iter().filter(|p| p.read).count() == 1);
    }

    #[test]
    fn a_workbook_of_summaries_has_no_lines_and_asks() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        {
            let ws = wb.add_worksheet().set_name("Quick Read").unwrap();
            ws.write_string(0, 0, "Total units").unwrap();
            ws.write_number(0, 1, 500.0).unwrap();
            ws.write_string(1, 0, "Estimated MSRP").unwrap();
            ws.write_number(1, 1, 12000.0).unwrap();
        }
        {
            let ws = wb.add_worksheet().set_name("Brand Summary").unwrap();
            for (c, h) in ["Brand", "Line items", "Units", "Estimated MSRP"].iter().enumerate() {
                ws.write_string(0, c as u16, *h).unwrap();
            }
            for i in 0..5u32 {
                ws.write_string(i + 1, 0, format!("Brand {}", i)).unwrap();
                ws.write_number(i + 1, 1, 10.0).unwrap();
                ws.write_number(i + 1, 2, 100.0).unwrap();
                ws.write_number(i + 1, 3, 2400.0).unwrap();
            }
        }
        let path = tmp("sums.xlsx", &wb.save_to_buffer().unwrap());
        let b = breakdown_with(&path, &ReadOptions::default()).unwrap();
        assert!(b.lines.is_empty() && b.needs_map);
        assert!(b.checks.iter().any(|c| c.severity == "red" && c.code == "no_lines" && c.fix == "pages"));
        assert!(b.pages.iter().all(|p| p.kind == "summary" && !p.read));
        let st = b.stated.as_ref().unwrap();
        assert_eq!((st.units, st.retail), (Some(500.0), Some(12000.0)));
    }

    #[test]
    fn a_workbook_saved_as_csv_is_still_read() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in ["Description", "Qty", "Unit Retail"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        ws.write_string(1, 0, "Widget").unwrap();
        ws.write_number(1, 1, 3.0).unwrap();
        ws.write_number(1, 2, 4.0).unwrap();
        let path = tmp("really-excel.csv", &wb.save_to_buffer().unwrap());
        let b = breakdown_with(&path, &ReadOptions::default()).unwrap();
        assert_eq!(b.lines.len(), 1);
        assert_eq!(b.lines[0].retail, 12.0);
    }

    fn review_total(b: &Breakdown) -> usize {
        b.review.groups.iter().map(|g| g.lines).sum()
    }

    #[test]
    fn every_unplaced_line_lands_in_exactly_one_review_group() {
        // A cost-only sheet with three lines nothing can place: three groups, each by title.
        let csv = "Product,UPC,Qty,Cost,Total\nQuuxel frame,100000000001,2,4,8\nBlorp stand,100000000002,3,4,12\nSnarf pad,100000000003,1,5,5\n";
        let b = read_csv("cost3.csv", csv, &ReadOptions::default());
        assert_eq!(b.lines.iter().filter(|l| l.placed == "none").count(), 3);
        assert_eq!(b.review.groups.len(), 3, "{:?}", b.review.groups);
        assert_eq!(review_total(&b), 3);
        assert!(b.review.groups.iter().all(|g| g.kind == "phrase" && g.lines == 1 && g.suggested.is_none()));
        assert!(b.review.groups.iter().any(|g| g.label == "Quuxel frame"));
        // Every line the list or nothing placed is counted once, whatever opens its title.
        let b = read_csv("fw2.csv", "Description,Qty,Unit Retail\nZorbex Widget 1,1,5\nZorbex Widget 2,1,5\nNike Air Max 1,1,100\nPlain mystery item,1,3\n,1,2\n", &ReadOptions::default());
        let reviewable = b.lines.iter().filter(|l| l.placed == "list" || l.placed == "none").count();
        assert_eq!(review_total(&b), reviewable);
    }

    #[test]
    fn a_review_group_never_mixes_suggested_categories() {
        let mut csv = String::from("Description,UPC,Qty,Unit Retail\n");
        for i in 0..4 {
            csv.push_str(&format!("Zed Mixer Pro {},88800000{:04},1,20\n", i, i));
            csv.push_str(&format!("Zed Garden Hose {},88800001{:04},1,20\n", i, i));
        }
        for i in 0..3 {
            csv.push_str(&format!("Zed Quuxel {},88800002{:04},1,20\n", i, i));
        }
        let b = read_csv("mix.csv", &csv, &ReadOptions::default());
        let zed: Vec<(&str, usize, Option<&str>)> = {
            let mut v: Vec<_> = b.review.groups.iter().filter(|g| g.pattern == "zed").map(|g| (g.kind.as_str(), g.lines, g.suggested.as_deref())).collect();
            v.sort();
            v
        };
        assert_eq!(zed, vec![("word", 3, None), ("word", 4, Some("Home & Kitchen")), ("word", 4, Some("Patio & Garden"))]);
        assert_eq!(review_total(&b), 11);
        // A UPC prefix never is the only key: no group is keyed by prefix alone here.
        assert!(b.review.groups.iter().all(|g| g.kind != "upc_prefix"));
    }

    #[test]
    fn a_sheet_with_several_sections_is_not_checked_against_its_last_total_row() {
        let b = read_csv("three.csv", THREE_PALLETS, &ReadOptions::default());
        assert!(!b.notes.iter().any(|n| n.contains("total row says")), "{:?}", b.notes);
        assert!(!b.checks.iter().any(|c| c.code == "total_mismatch" || c.code == "section_mismatch"), "{:?}", b.checks);
        // What was left out is said once, in its own field, not again in the notes.
        let left = b.left_out.clone().expect("left out");
        assert!(!b.notes.contains(&left), "{:?}", b.notes);
    }

    #[test]
    fn repeats_are_counted_not_warned_about() {
        let csv = "Description,UPC,Qty,Unit Retail\nBlue mug,100000000001,1,5\nBlue mug,100000000001,1,5\nRed mug,100000000002,1,5\n";
        let b = read_csv("rep.csv", csv, &ReadOptions::default());
        assert_eq!(b.repeat_lines, 1);
        assert!(!b.notes.iter().any(|n| n.contains("repeat")), "{:?}", b.notes);
        assert_eq!(b.products.len(), 2);
    }

    #[test]
    fn a_cost_only_sheet_counts_what_it_could_not_place_in_units_and_names_its_cost_column() {
        let csv = "Product,Qty,Cost\nQuuxel frame,4,4\nBlorp stand,6,4\nNike Air Max 90,10,5\n";
        let b = read_csv("costu.csv", csv, &ReadOptions::default());
        assert!(b.cost_only);
        assert_eq!(b.cost_col.as_deref(), Some("Cost"));
        let note = b.notes.iter().find(|n| n.contains("could not be placed")).expect("a note");
        assert!(note.contains("10 of 20 units"), "{note}");
        assert!(!note.contains("of retail"), "{note}");
        let plain = read_csv("plain2.csv", PRICED_CSV, &ReadOptions::default());
        assert_eq!(plain.cost_col.as_deref(), Some("Unit Cost"));
    }

    #[test]
    fn a_line_with_no_category_is_unplaced() {
        let b = read_csv("unp.csv", "Description,Qty,Unit Retail\nQuuxel frame,1,5\n", &ReadOptions::default());
        assert!(b.lines[0].category.is_none());
        assert_eq!(b.products[0].category.as_deref(), Some("Unplaced"));
    }

    #[test]
    fn page_facts_reads_a_one_row_table() {
        let t = |s: &str| Val::Text(s.to_string());
        let rows = vec![
            vec![t("MIXED LOT")],
            vec![],
            vec![t("UNITS"), t("PALLETS"), t("TOTAL MSRP"), t("AVG MSRP"), t("COST/PR"), t("TOTAL COST"), t("ROUTE-OUT")],
            vec![Val::Num(3290.0), Val::Num(33.0), Val::Num(222338.43), Val::Num(67.5), Val::Num(23.75), Val::Num(111037.0), t("34%")],
            vec![],
            vec![t("PER-BRAND")],
        ];
        let f = page_facts(&rows);
        assert_eq!((f.units, f.retail, f.price), (Some(3290.0), Some(222338.43), Some(111037.0)));
    }
}
