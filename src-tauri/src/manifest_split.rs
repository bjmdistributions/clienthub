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

use crate::manifest::{
    self, find_col, find_header_row, guess_category, infer_columns, is_summary_line, parse_money, BRAND_COLS,
    CATEGORY_COLS, DESC_COLS, QTY_COLS,
};
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
}

#[derive(Debug, Clone, Serialize)]
pub struct Totals {
    pub lines: usize,
    pub units: f64,
    pub retail: f64,
    pub sheet_price: Option<f64>,
    pub price: Option<f64>,
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
    if t.chars().any(|c| c.is_ascii_digit()) && !t.chars().any(|c| c.is_alphabetic()) {
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
}

fn sheet_score(rows: &[Vec<Val>]) -> usize {
    rows.iter().filter(|r| r.iter().filter(|c| !matches!(c, Val::Empty)).count() >= 2).count()
}

fn read_table(path: &str, want_sheet: Option<&str>) -> Result<Table> {
    let ext = manifest::extension(path);
    let file_name = Path::new(path).file_name().and_then(|f| f.to_str()).unwrap_or("manifest").to_string();
    if ext == "pdf" {
        bail!("Splitting works on Excel and CSV manifests. This one is a PDF, so ask the supplier for the spreadsheet version.");
    }
    let excel = matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods");

    let (sheet, sheets, grid, start, image_formulas) = if excel {
        use calamine::Reader;
        let mut wb = calamine::open_workbook_auto(path).map_err(|e| anyhow::anyhow!("Couldn't open the spreadsheet: {}", e))?;
        let names: Vec<String> = wb.sheet_names().to_vec();
        let mut scored: Vec<(String, usize)> = Vec::new();
        let mut best: Option<(String, usize)> = None;
        for name in &names {
            let Ok(range) = wb.worksheet_range(name) else { continue };
            let rows: Vec<Vec<Val>> = range.rows().map(|r| r.iter().map(val_from_cell).collect()).collect();
            let score = sheet_score(&rows);
            if score > 0 {
                scored.push((name.clone(), score));
            }
            if best.as_ref().map_or(true, |(_, b)| score > *b) {
                best = Some((name.clone(), score));
            }
        }
        let chosen = match want_sheet {
            Some(w) if names.iter().any(|n| n == w) => w.to_string(),
            _ => best.map(|(n, _)| n).context("Couldn't read any sheet out of that spreadsheet.")?,
        };
        let range = wb.worksheet_range(&chosen).map_err(|e| anyhow::anyhow!("Couldn't read the sheet {}: {}", chosen, e))?;
        let start = range.start().unwrap_or((0, 0));
        let rows: Vec<Vec<Val>> = range.rows().map(|r| r.iter().map(val_from_cell).collect()).collect();
        let mut formulas = HashMap::new();
        if matches!(ext.as_str(), "xlsx" | "xlsm") {
            if let Ok(fr) = wb.worksheet_formula(&chosen) {
                let fs = fr.start().unwrap_or((0, 0));
                for (r, c, f) in fr.used_cells() {
                    if f.to_uppercase().contains("IMAGE(") {
                        formulas.insert((fs.0 + r as u32, fs.1 + c as u32), f.clone());
                    }
                }
            }
        }
        (Some(chosen), scored, rows, start, formulas)
    } else {
        let g = manifest::grid_from_delimited(path)?;
        let rows: Vec<Vec<Val>> = g.rows.iter().map(|r| r.iter().map(|c| val_from_text(c)).collect()).collect();
        (None, Vec::new(), rows, (0, 0), HashMap::new())
    };

    let text: Vec<Vec<String>> = grid.iter().map(|r| r.iter().map(Val::text).collect()).collect();
    let ncols = grid.iter().map(|r| r.len()).max().unwrap_or(0);
    let pad = |mut r: Vec<Val>| {
        r.resize(ncols, Val::Empty);
        r
    };

    let images = match (&sheet, excel) {
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
            rows, abs_rows, abs_col0: start.1, above, image_formulas, images, inferred: None,
        });
    }

    let Some(inf) = infer_columns(&text) else {
        bail!("Couldn't find the columns in this file. It needs a row of headers with something like description, quantity and price on it.");
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
        inferred: Some((inf.desc, inf.qty, inf.price)),
    })
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
    qty: Option<usize>,
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
    /// Columns nothing else claimed whose header reads like a cost, a fee or a supplier
    /// ("Freight", "Landed", "Vendor", "PO #"). Left out of the files unless Jack puts
    /// them back, so what a supplier charged never reaches a buyer by accident.
    internal: Vec<usize>,
}

const INTERNAL_WORDS: &[&str] = &["cost", "price", "buy", "landed", "freight", "shipping", "duty", "fee", "margin",
    "profit", "invoice", "paid", "supplier", "seller", "vendor", "source", "po ", "po#", "p.o", "purchase", "$",
    "amount", "bid", "offer", "wholesale"];

const RETAIL_WORDS: &[&str] = &["retail", "msrp", "srp", "rrp", "compare", "list", "orig", "value"];
const SALE_WORDS: &[&str] = &["cost", "price", "offer", "sell", "wholesale", "bid", "your", "our", "liquidation",
    "sale", "net", "asking", "pay"];
/// Words that say a plain price column is this load's price rather than retail.
const LOAD_WORDS: &[&str] = &["cost", "offer", "sell", "wholesale", "bid", "your", "our", "liquidation", "net",
    "asking", "pay", "lot", "load"];
const EXT_WORDS: &[&str] = &["ext", "total", "amount", "extended", "subtotal", "line"];
const COUNT_WORDS: &[&str] = &["qty", "quantity", "pcs", "pieces", "count", "units", "unit count"];

fn has_any(h: &str, words: &[&str]) -> bool {
    words.iter().any(|w| h.contains(w))
}

fn detect_cols(t: &Table, price_role: &str) -> Result<Cols> {
    let lower: Vec<String> = t.headers.iter().map(|h| h.trim().to_lowercase()).collect();
    let desc = find_col(&lower, DESC_COLS, &[]).context("Found the header row but no description column.")?;

    // How many of a column's filled cells are numbers, over the first 500 rows.
    let numeric_share = |j: usize| -> f64 {
        let (mut filled, mut nums) = (0usize, 0usize);
        for r in t.rows.iter().take(500) {
            match &r[j] {
                Val::Empty => {}
                v => {
                    filled += 1;
                    if v.number().is_some() {
                        nums += 1;
                    }
                }
            }
        }
        if filled == 0 { 0.0 } else { nums as f64 / filled as f64 }
    };

    let mut c = Cols { desc, ..Default::default() };
    if let Some((_, _, price)) = t.inferred {
        c.retail_unit = Some(price);
    } else {
        for (j, h) in lower.iter().enumerate() {
            if j == desc || h.is_empty() || numeric_share(j) < 0.5 {
                continue;
            }
            if COUNT_WORDS.iter().any(|w| h == w || h.starts_with(&format!("{} ", w)) || h.ends_with(&format!(" {}", w))) {
                continue;
            }
            let ext = has_any(h, EXT_WORDS) && !h.contains("unit") && !h.contains("each");
            let pctish = (h.contains('%') || h.contains("percent") || h.contains("pct") || h.contains("of retail"))
                && !h.contains("off") && !h.contains("discount");
            if pctish {
                c.pct = c.pct.or(Some(j));
            } else if has_any(h, RETAIL_WORDS) {
                if ext { c.retail_ext = c.retail_ext.or(Some(j)) } else { c.retail_unit = c.retail_unit.or(Some(j)) }
            } else if has_any(h, SALE_WORDS) {
                if ext { c.sale_ext = c.sale_ext.or(Some(j)) } else { c.sale_unit = c.sale_unit.or(Some(j)) }
            }
        }
        // A sheet with no retail column and one plain "Price": retail or this load's price?
        if c.retail_unit.is_none() && c.retail_ext.is_none() {
            let plain = |j: Option<usize>| j.filter(|&j| !has_any(&lower[j], LOAD_WORDS));
            if let Some(j) = plain(c.sale_unit).or(plain(c.sale_ext)) {
                c.ambiguous = Some(j);
                if price_role != "load" {
                    if Some(j) == c.sale_unit {
                        c.retail_unit = c.sale_unit.take();
                    } else {
                        c.retail_ext = c.sale_ext.take();
                    }
                }
            }
        }
    }
    let money = [c.retail_unit, c.retail_ext, c.sale_unit, c.sale_ext, c.pct];
    let mut ex: Vec<Option<usize>> = vec![Some(desc)];
    ex.extend(money);
    c.qty = match t.inferred {
        Some((_, q, _)) => q,
        None => find_col(&lower, QTY_COLS, &ex),
    };
    ex.push(c.qty);
    c.category = if t.inferred.is_some() { None } else { find_col(&lower, CATEGORY_COLS, &ex) };
    ex.push(c.category);
    c.brand = if t.inferred.is_some() { None } else { find_col(&lower, BRAND_COLS, &ex) };
    ex.push(c.brand);

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
        let named = has_any(&lower[j], &["image", "photo", "picture", "img", "pic", "thumbnail"]);
        if urls * 2 >= vals.len() && (named || pics * 2 >= vals.len()) {
            c.photo_links = Some(j);
            break;
        }
    }
    ex.push(c.photo_links);
    c.internal = (0..t.headers.len())
        .filter(|j| !ex.contains(&Some(*j)) && (lower[*j] == "po" || has_any(&lower[*j], INTERNAL_WORDS)))
        .collect();
    Ok(c)
}

fn is_image_url(v: &str) -> bool {
    let l = v.to_lowercase();
    let path = l.split(['?', '#']).next().unwrap_or("");
    (l.starts_with("http://") || l.starts_with("https://"))
        && [".jpg", ".jpeg", ".png", ".webp", ".gif"].iter().any(|e| path.ends_with(e))
}

// ── Lines ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Line {
    row: usize,
    desc: String,
    qty: f64,
    retail: f64,
    sheet: Option<f64>,
    category: String,
    brand_raw: String,
    photo: bool,
}

struct Lines {
    lines: Vec<Line>,
    summary_rows: usize,
    zero_qty: usize,
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
    let mut out = Lines { lines: Vec::new(), summary_rows: 0, zero_qty: 0 };
    for (i, r) in t.rows.iter().enumerate() {
        let desc = r[c.desc].text();
        if desc.is_empty() {
            continue;
        }
        if is_summary_line(&desc.to_lowercase()) {
            out.summary_rows += 1;
            continue;
        }
        let qty = num(r, c.qty).unwrap_or(1.0);
        if qty <= 0.0 {
            out.zero_qty += 1;
            continue;
        }
        let retail = match (num(r, c.retail_unit), num(r, c.retail_ext)) {
            (Some(u), _) if u > 0.0 => u * qty,
            (_, Some(e)) if e > 0.0 => e,
            _ => 0.0,
        };
        let sheet = match (num(r, c.sale_ext), num(r, c.sale_unit), num(r, c.pct)) {
            (Some(e), _, _) if e > 0.0 => Some(e),
            (_, Some(u), _) if u > 0.0 => Some(u * qty),
            (_, _, Some(p)) if p > 0.0 && retail > 0.0 => Some(retail * pct_fraction(p)),
            _ => None,
        };
        let photo = photo_rows.contains(&t.abs_rows[i]) || c.photo_links.map_or(false, |j| !r[j].text().is_empty());
        out.lines.push(Line {
            row: i,
            desc,
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

/// Words that open a title without being its brand ("Men's Nike Air Max", "2 Pack ...").
const LEAD_WORDS: &[&str] = &["men", "mens", "women", "womens", "ladies", "boys", "girls", "kids", "kid", "baby",
    "toddler", "youth", "unisex", "adult", "infant", "junior", "juniors", "new", "the", "genuine", "authentic",
    "official", "original", "lot", "of", "pack", "pk", "set", "case", "pcs", "pc", "ct", "count", "x", "pair",
    "pairs", "a", "an"];

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
    "mat", "curtain", "sheet", "sheets", "shelf", "chair", "desk", "fan", "heater", "vacuum", "mirror"];

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
];

/// The same brand however it was typed: case, punctuation, "&" or "+", "The" in front and
/// Inc/LLC/Brands behind all fall away. "NIKE", "Nike, Inc." and "nike" are one key.
fn brand_key(s: &str) -> String {
    let words = title_words(s);
    let mut words: Vec<&str> = words.iter().map(|w| w.as_str()).collect();
    if words.len() > 1 && words[0] == "the" {
        words.remove(0);
    }
    while words.len() > 1 && BRAND_SUFFIXES.contains(words.last().unwrap()) {
        words.pop();
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
    let k = title_words(s).join(" ");
    NO_BRAND.contains(&k.as_str())
}

/// What a brand is shown as: its most common spelling, but not an all-capitals one when
/// the sheet also spells it normally, and the known spelling when it is a known brand.
fn brand_display(spellings: &HashMap<String, usize>, known: &HashMap<String, &'static str>) -> String {
    let mut v: Vec<(&String, &usize)> = spellings.iter().collect();
    v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let Some((top, _)) = v.first() else { return String::new() };
    if let Some(k) = known.get(&brand_key(top)) {
        return k.to_string();
    }
    let shouting = |s: &str| s.chars().any(|c| c.is_alphabetic()) && !s.chars().any(|c| c.is_lowercase());
    if shouting(top) {
        if let Some((normal, _)) = v.iter().find(|(s, _)| !shouting(s)) {
            return normal.to_string();
        }
        if top.chars().filter(|c| c.is_alphabetic()).count() > 4 {
            return top
                .split_whitespace()
                .map(|w| {
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
    let short = na.len().min(nb.len());
    if (short >= 5 && levenshtein(&na, &nb) <= 1) || (short >= 9 && levenshtein(&na, &nb) <= 2) {
        return true;
    }
    // "hamilton" and "hamilton beach": the shorter is the start of the longer, word for word.
    let (wa, wb): (Vec<&str>, Vec<&str>) = (a.split(' ').collect(), b.split(' ').collect());
    let (s, l) = if wa.len() <= wb.len() { (&wa, &wb) } else { (&wb, &wa) };
    s.len() < l.len() && s.join(" ").len() >= 4 && l.starts_with(s)
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

fn detect_pricing(t: &Table, c: &Cols, lines: &[Line]) -> SheetPricing {
    let header = |j: Option<usize>| j.map(|j| t.headers[j].trim().to_string()).unwrap_or_default();
    let priced: Vec<&Line> = lines.iter().filter(|l| l.sheet.is_some()).collect();
    let total = if priced.is_empty() { None } else { Some(round2(priced.iter().filter_map(|l| l.sheet).sum())) };
    let pricing = |kind: &str, pct: Option<f64>, unit: Option<f64>, evidence: String| SheetPricing {
        kind: kind.into(), pct, unit, evidence, total,
    };

    if !priced.is_empty() {
        // A % of retail: the sheet's own % column, or its price over its retail.
        let ratios: Vec<f64> = priced.iter().filter(|l| l.retail > 0.0).map(|l| l.sheet.unwrap() / l.retail).collect();
        if ratios.len() * 2 >= priced.len() {
            if let Some((r, n)) = common_value(&ratios, 0.0025) {
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
        let units: Vec<f64> = priced.iter().map(|l| l.sheet.unwrap() / l.qty).collect();
        if let Some((u, n)) = common_value(&units, 0.005) {
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
    let pct_re = regex::Regex::new(r"(?i)(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:retail|msrp|ext|value|srp)|@\s*(\d{1,2}(?:\.\d{1,2})?)\s*%").unwrap();
    let unit_re = regex::Regex::new(r"(?i)\$\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:/|per|a|each|ea\.?)\s*(?:unit|pc|pcs|piece|item|pair|ea|each)\b").unwrap();
    let mut notes: Vec<(String, String)> = t.above.iter().map(|(r, s)| (format!("row {}", r), s.clone())).collect();
    if let Some(s) = &t.sheet {
        notes.push(("the sheet's name".into(), s.clone()));
    }
    notes.push(("the file's name".into(), t.file_name.clone()));
    for (where_, text) in &notes {
        if let Some(m) = pct_re.captures(text) {
            if let Some(p) = m.get(1).or(m.get(2)).and_then(|g| g.as_str().parse::<f64>().ok()) {
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
    fn value(&self, id: &str) -> Option<f64> {
        self.answers.get(id).and_then(|v| parse_money(v)).filter(|v| *v >= 0.0)
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
        ("pct", Some(p)) => round2(l.retail * p / 100.0),
        ("unit", Some(u)) => round2(u * l.qty),
        ("sheet", _) => round2(l.sheet?),
        _ => return None,
    };
    Some((ext / l.qty, ext))
}

fn build(path: &str, answers: &HashMap<String, String>, edits: &SplitEdits) -> Result<State> {
    let first = table(path, answers.get("sheet").map(|s| s.as_str()))?;
    let mut ask = Ask { answers, questions: Vec::new() };
    let mut notes: Vec<String> = Vec::new();

    // Which sheet.
    let t = if first.sheets.len() > 1 {
        let best = first.sheets.iter().max_by_key(|(_, n)| *n).map(|(s, _)| s.clone()).unwrap_or_default();
        let choices = first.sheets.iter().map(|(s, n)| choice(s, format!("{} ({})", s, plural(*n, "row", "rows")))).collect();
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
    let cols = detect_cols(&t, &price_role)?;
    let Lines { mut lines, summary_rows, zero_qty } = build_lines(&t, &cols);
    if lines.is_empty() {
        bail!("Read the columns but found no product lines in this file.");
    }
    if summary_rows + zero_qty > 0 {
        let mut why = Vec::new();
        if summary_rows > 0 {
            why.push(plural(summary_rows, "total line", "total lines"));
        }
        if zero_qty > 0 {
            why.push(format!("{} with a quantity of 0", plural(zero_qty, "line", "lines")));
        }
        notes.push(format!("Left out {}.", why.join(" and ")));
    }

    let known: HashMap<String, &'static str> = KNOWN_BRANDS.iter().map(|b| (brand_key(b), *b)).collect();

    // Brands missing from lines: read them from the titles?
    let missing: Vec<usize> = (0..lines.len()).filter(|&i| is_no_brand(&lines[i].brand_raw)).collect();
    let mut inferred: HashMap<usize, String> = HashMap::new();
    if !missing.is_empty() && missing.len() * 10 >= lines.len() {
        // Dictionary: brands the sheet itself names, then the known list. Longest first.
        let mut dict: Vec<(Vec<String>, String)> = Vec::new();
        let mut seen = HashSet::new();
        for l in &lines {
            if !is_no_brand(&l.brand_raw) {
                let k = brand_key(&l.brand_raw);
                if seen.insert(k.clone()) {
                    dict.push((title_words(&l.brand_raw), l.brand_raw.clone()));
                }
            }
        }
        for b in KNOWN_BRANDS {
            if seen.insert(brand_key(b)) {
                dict.push((title_words(b), b.to_string()));
            }
        }
        dict.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let start_of = |words: &[String]| -> usize {
            let mut p = 0;
            while p < words.len().min(4) && (LEAD_WORDS.contains(&words[p].as_str()) || words[p].chars().all(|c| c.is_ascii_digit())) {
                p += 1;
            }
            p
        };
        let mut first_words: HashMap<String, (usize, HashMap<String, usize>)> = HashMap::new();
        let mut pending: Vec<(usize, String)> = Vec::new();
        for &i in &missing {
            let words = title_words(&lines[i].desc);
            let p = start_of(&words);
            if p >= words.len() {
                continue;
            }
            // A known brand can itself start with a word that is skipped as filler
            // ("New Balance", "The North Face"), so try every start up to the first real
            // word, earliest first.
            let known_at = (0..=p).find_map(|q| dict.iter().find(|(w, _)| !w.is_empty() && words[q..].starts_with(w)));
            if let Some((_, name)) = known_at {
                inferred.insert(i, name.clone());
                continue;
            }
            let w = &words[p];
            if w.len() >= 2 && w.chars().any(|c| c.is_alphabetic()) && !NOT_BRANDS.contains(&w.as_str()) {
                // The original spelling of that word, for display.
                let orig = lines[i]
                    .desc
                    .split_whitespace()
                    .find(|o| title_words(o).first().map_or(false, |x| x == w))
                    .unwrap_or(w)
                    .trim_matches(|c: char| !c.is_alphanumeric())
                    .to_string();
                let e = first_words.entry(w.clone()).or_insert((0, HashMap::new()));
                e.0 += 1;
                *e.1.entry(orig).or_insert(0) += 1;
                pending.push((i, w.clone()));
            }
        }
        let floor = 3usize.max(lines.len() / 200);
        for (i, w) in pending {
            if let Some((n, spellings)) = first_words.get(&w) {
                if *n >= floor {
                    inferred.insert(i, brand_display(spellings, &known));
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
            let lead = if cols.brand.is_some() {
                format!("{} have no brand in the {} column.", plural(missing.len(), "line", "lines"), t.headers[cols.brand.unwrap()].trim())
            } else {
                format!("There is no brand column, so {} have no brand.", plural(missing.len(), "line", "lines"))
            };
            let a = ask.ask(
                "read_brands",
                format!("{} Read the brand from the start of each title?", lead),
                Some(format!(
                    "That finds {} for {} of them, such as {}.{}",
                    plural(brands_found, "brand", "brands"),
                    fmt_int(inferred.len() as f64),
                    list_names(&example),
                    if left > 0 { format!(" The other {} stay unbranded.", fmt_int(left as f64)) } else { String::new() }
                )),
                vec![choice("yes", "Yes, read them"), choice("no", "No, leave them unbranded")],
                "yes",
            );
            if a == "no" {
                inferred.clear();
            }
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

    // Look-alike brands: ask, biggest first, at most twelve.
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
    pairs.sort_by(|a, b| b.2.cmp(&a.2));
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
        let id = format!("merge:{}|{}", a, b);
        let ans = ask.ask(
            &id,
            format!(
                "Are \"{}\" ({}) and \"{}\" ({}) the same brand?",
                display_of(a),
                plural(brand_lines[a], "line", "lines"),
                display_of(b),
                plural(brand_lines[b], "line", "lines")
            ),
            None,
            vec![choice("yes", "Same brand"), choice("no", "Different brands")],
            "yes",
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
    let brand_of = |l: &Line| -> Option<(String, String)> {
        if is_no_brand(&l.brand_raw) {
            return None;
        }
        let k = root(&parent, &brand_key(&l.brand_raw));
        Some((k.clone(), display_of(&k)))
    };

    // Categories: the sheet's own, else a guess from the title.
    let mut cat_spell: HashMap<String, HashMap<String, usize>> = HashMap::new();
    let cat_of_raw: Vec<Option<String>> = lines
        .iter()
        .map(|l| {
            let c = if cols.category.is_some() { l.category.clone() } else { guess_category(&l.desc.to_lowercase()).to_string() };
            let c = c.trim().to_string();
            if c.is_empty() || c.eq_ignore_ascii_case("uncategorized") { None } else { Some(c) }
        })
        .collect();
    for c in cat_of_raw.iter().flatten() {
        *cat_spell.entry(title_words(c).join(" ")).or_default().entry(c.clone()).or_insert(0) += 1;
    }
    let cat_of = |i: usize| -> Option<(String, String)> {
        let c = cat_of_raw[i].as_ref()?;
        let k = title_words(c).join(" ");
        let sp = &cat_spell[&k];
        let name = sp.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(s, _)| s.clone()).unwrap_or_default();
        Some((k, name))
    };
    if cols.category.is_none() {
        notes.push("There is no category column, so categories are guessed from words in each title.".into());
    }

    // How to split.
    let n_brands: HashSet<String> = lines.iter().filter_map(|l| brand_of(l).map(|b| b.0)).collect();
    let n_cats: HashSet<String> = (0..lines.len()).filter_map(|i| cat_of(i).map(|c| c.0)).collect();
    let branded = lines.iter().filter(|l| brand_of(l).is_some()).count();
    let mut split_choices = Vec::new();
    if n_brands.len() >= 2 {
        split_choices.push(choice("brand", format!("By brand ({})", n_brands.len())));
    }
    if n_cats.len() >= 2 {
        split_choices.push(choice("category", format!("By category ({})", n_cats.len())));
    }
    if n_brands.len() >= 2 && n_cats.len() >= 2 {
        split_choices.push(choice("brand_in_category", "By brand within each category"));
    }
    if split_choices.is_empty() {
        bail!(
            "Every line on this manifest is the same brand and the same category, so there is nothing to split it by. {}",
            if cols.brand.is_none() && cols.category.is_none() { "It has no brand or category column." } else { "" }
        );
    }
    let suggested = if n_brands.len() >= 2 && branded * 2 >= lines.len() { "brand" } else { split_choices[0].id.as_str() };
    let split_detail = match (cols.brand, cols.category) {
        (Some(b), Some(c)) => format!("Brands come from the {} column and categories from the {} column.", t.headers[b].trim(), t.headers[c].trim()),
        (Some(b), None) => format!("Brands come from the {} column.", t.headers[b].trim()),
        (None, Some(c)) => format!("Categories come from the {} column.", t.headers[c].trim()),
        (None, None) => "Brands are read from the titles and categories guessed from them.".into(),
    };
    let suggested = suggested.to_string();
    let split_by = ask.ask("split_by", "How should this manifest be split?".into(), Some(split_detail), split_choices, &suggested);

    // Group the lines.
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (i, l) in lines.iter().enumerate() {
        let b = brand_of(l);
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
    let total_retail: f64 = lines.iter().map(|l| l.retail).sum();
    let total_units: f64 = lines.iter().map(|l| l.qty).sum();
    let weight = |g: &Group| -> f64 {
        if total_retail > 0.0 {
            g.idx.iter().map(|&i| lines[i].retail).sum::<f64>() / total_retail
        } else {
            g.idx.iter().map(|&i| lines[i].qty).sum::<f64>() / total_units.max(1.0)
        }
    };
    let is_blank = |k: &str| k == "b:" || k == "c:" || k.ends_with("|b:");
    let noun = match split_by.as_str() {
        "category" => ("category", "categories"),
        "brand_in_category" => ("group", "groups"),
        _ => ("brand", "brands"),
    };

    // Small groups into one Mixed manifest.
    let mut ranked: Vec<(String, f64)> = order.iter().filter(|k| !is_blank(k.as_str())).map(|k| (k.clone(), weight(&groups[k]))).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let mut small: Vec<String> = ranked.iter().filter(|(_, w)| *w < 0.02).map(|(k, _)| k.clone()).collect();
    let capped = ranked.len() - small.len() > 12;
    if capped {
        small = ranked.iter().skip(12).map(|(k, _)| k.clone()).collect();
    }
    let mut mixed: Vec<String> = Vec::new();
    if small.len() >= 2 {
        let lines_in: usize = small.iter().map(|k| groups[k].idx.len()).sum();
        let retail_in: f64 = small.iter().flat_map(|k| groups[k].idx.iter()).map(|&i| lines[i].retail).sum();
        let text = if capped {
            format!(
                "Keep the 12 biggest {} as their own manifests and put the other {} together in one Mixed manifest?",
                noun.1,
                fmt_int(small.len() as f64)
            )
        } else {
            format!(
                "{} {} each have under 2% of the retail. Put them together in one Mixed manifest?",
                fmt_int(small.len() as f64),
                noun.1
            )
        };
        let a = ask.ask(
            "small",
            text,
            Some(format!("{} and {} of retail between them.", plural(lines_in, "line", "lines"), fmt_money(retail_in))),
            vec![choice("mixed", "Yes, one Mixed manifest"), choice("keep", format!("No, keep every {} separate", noun.0))],
            "mixed",
        );
        if a == "mixed" {
            mixed = small;
        }
    }
    // Lines with no brand (or category).
    if let Some(blank) = order.iter().find(|k| is_blank(k.as_str())).cloned() {
        if groups.len() > 1 && split_by != "brand_in_category" {
            let g = &groups[&blank];
            let w = weight(g);
            let retail: f64 = g.idx.iter().map(|&i| lines[i].retail).sum();
            let label = if split_by == "category" { "Uncategorized" } else { "Unbranded" };
            let what = if split_by == "category" { "category" } else { "brand" };
            let a = ask.ask(
                "blank",
                format!("{} have no {} ({} of retail). Where should they go?", plural(g.idx.len(), "line", "lines"), what, fmt_money(retail)),
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
        order.push("mixed".into());
        groups.insert("mixed".into(), Group { key: "mixed".into(), name: "Mixed".into(), idx });
    }

    // Jack's edits: combine, rename.
    for (from, to) in &edits.combine {
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
        let last = |g: &Group| g.key == "mixed" || is_blank(&g.key);
        last(a).cmp(&last(b)).then(weight(b).partial_cmp(&weight(a)).unwrap_or(std::cmp::Ordering::Equal)).then(a.name.cmp(&b.name))
    });

    // Pricing.
    let sp = detect_pricing(&t, &cols, &lines);
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
    let mode = ask.ask("pricing", "How should the new manifests be priced?".into(), Some(pricing_detail), price_choices, suggest_mode);
    let value = ask.value("pricing_value").or(if mode == suggest_mode { suggest_value } else { None });
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
    let hidden: HashSet<usize> = edits
        .hidden_cols
        .iter()
        .copied()
        .chain(cols.internal.iter().copied().filter(|j| !shown.contains(j)))
        .collect();
    let left_out: Vec<String> = cols.internal.iter().filter(|j| !shown.contains(j)).map(|&j| t.headers[j].trim().to_string()).collect();
    if !left_out.is_empty() {
        notes.push(format!(
            "Left out of the files unless you put {} back: {} (read as your own costs or your supplier).",
            if left_out.len() == 1 { "it" } else { "them" },
            list_names(&left_out)
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
        }
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
        },
        splits,
        photos,
        reconciles,
        show_price,
    };
    Ok(State { t, cols, lines, groups: ordered, skipped, rules, line_prices, hidden, show_price, sheet_is_cost, categories, plan })
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
    let append_price = s.show_price && c.sale_unit.is_none() && c.sale_ext.is_none() && rule.mode != "none";
    let ncols_out = abs_cols.len() as u16 + if append_price { 2 } else { 0 };
    if ncols_out == 0 {
        bail!("Nothing to write for {}.", g.name);
    }

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name(safe_name(&g.name, 31))?;
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
        if h.is_empty() { "Photo".into() } else { h.to_string() }
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
            let name = &s.categories[i];
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
}
