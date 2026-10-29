//! Cases on pallets (R-519): a delivery read from its manifest, and every case received.
//!
//! BYTE-IDENTICAL in two places: BUSINESS APP `src-tauri/src/case_core.rs` and clienthub-api
//! `src/routes/case_core.rs`. It uses nothing from either crate (no `use crate::`), so the
//! desktop and the phone can never read a manifest or count a case differently. Edit one,
//! copy it over, and run the tests in both repos.
//!
//! The model. A delivery (`warehouse_loads`) is its manifest as read: one `LoadLine` per style
//! and colour, with its size scale and the pairs the manifest expects in each size. A case
//! (`warehouse_cases`, one row each, so two phones receiving at once never overwrite each
//! other) stands on a numbered pallet and holds pairs of one or more lines, by size. What was
//! received is always the sum over the cases: no received count is stored anywhere.
//!
//! The manifest reader takes every tab. A tab is read when a heading row names a Style column
//! and sizes, in one of three ways: rows of size names above the styles (with no style, every
//! label a size; they name the grid's columns for the rows under them, so one tab can hold baby,
//! kids and adult scales and the sizes can move column from style to style), size names on the
//! heading row, or a Size column with one size a row beside a quantity (a style's rows gather
//! into one line). A row with one word and nothing else is a group heading (KIDS, WOMEN'S). A
//! tab with no Style column is a totals page or nothing: it is never read as items, only for its
//! stated totals, which the preview checks the lines against. Each tab says what it is so the
//! screen can show it and let the tabs to import be chosen.
//!
//! Pictures (R-537): a picture placed over a cell lives in the file's drawings, anchored to a row.
//! It belongs to the line read on that row, and only that line: see `match_pictures`.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const MAX_LINES: usize = 2_000;
pub const MAX_PAIRS_PER_CASE: i64 = 10_000;
pub const MAX_COPIES: i64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SizeQty {
    pub size: String,
    #[serde(default)]
    pub qty: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LoadLine {
    pub id: String,
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color_name: String,
    /// What a pair cost (the sheet's Std Price or Cost).
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub msrp: f64,
    /// The size scale in sheet order, each with the pairs the manifest expects (0 for none).
    #[serde(default)]
    pub sizes: Vec<SizeQty>,
    /// The sheet's own Total for the line when it had one, else the sum of its sizes.
    #[serde(default)]
    pub sheet_total: i64,
    /// Where it was read ("Lamo Hash row 439"), or "Added by hand".
    #[serde(default)]
    pub source: String,
    /// R-537: the tab it was read from ("" when added by hand). The import takes only the tabs
    /// the screen says to.
    #[serde(default)]
    pub sheet: String,
    /// R-537: its picture from the sheet, "media/deliveries/<load>/<line>.jpg", or "".
    #[serde(default)]
    pub image: String,
    /// R-539: the sheet rows (1-based) its pairs were read from: one row, or every row of a
    /// style written one size a row. Empty when added by hand.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<usize>,
    /// R-539: the sheet row its size names came from (a row of sizes above it, or the heading
    /// row); 0 when each row names its own size, or added by hand.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub sizes_row: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A line keeps at most this many rows it was read from.
pub const MAX_LINE_ROWS: usize = 64;

impl LoadLine {
    pub fn expected(&self) -> i64 {
        self.sizes.iter().map(|s| s.qty.max(0)).sum()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CaseLine {
    pub line_id: String,
    pub size: String,
    pub pairs: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Case {
    pub id: String,
    #[serde(default)]
    pub pallet: i64,
    #[serde(default)]
    pub number: i64,
    #[serde(default)]
    pub contents: Vec<CaseLine>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// "" or "box" for a box; "loose" for items on the pallet with no box (R-535). A loose row
    /// has number 0 and never takes a box number. Its pairs count like any box's.
    #[serde(default)]
    pub kind: String,
    /// R-554: the code written on the carton in sharpie (A3-7). Set when the box is made and never
    /// changed by the app afterwards, so a moved box keeps it. "" on a box made before codes.
    #[serde(default)]
    pub code: String,
}

impl Case {
    pub fn is_loose(&self) -> bool {
        self.kind == "loose"
    }
}

// ---------------------------------------------------------------------------------------
// Reading the file: every tab, as text
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Tab {
    pub name: String,
    pub rows: Vec<Vec<String>>,
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

/// Every tab of a workbook (or the one table of a CSV/TSV), as trimmed text.
pub fn read_tabs(filename: &str, bytes: &[u8]) -> Result<Vec<Tab>, String> {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let stem = filename.rsplit(['/', '\\']).next().unwrap_or(filename).to_string();
    match ext.as_str() {
        "csv" | "tsv" | "txt" => {
            let text = String::from_utf8_lossy(bytes).trim_start_matches('\u{feff}').to_string();
            // A blank line is still a row, as it is when the file opens in Excel, so row numbers
            // match the sheet: the csv reader skips truly empty lines, not one holding a space.
            let text = text.split('\n').map(|l| if l.trim().is_empty() { " " } else { l }).collect::<Vec<_>>().join("\n");
            let mut rdr = csv::ReaderBuilder::new()
                .delimiter(sniff_delimiter(&text))
                .has_headers(false)
                .flexible(true)
                .from_reader(text.as_bytes());
            let mut rows = Vec::new();
            for rec in rdr.records() {
                let rec = rec.map_err(|e| format!("A row could not be read: {e}"))?;
                rows.push(rec.iter().map(|c| c.trim().to_string()).collect());
            }
            Ok(vec![Tab { name: stem, rows }])
        }
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => {
            use calamine::Reader;
            let mut wb = calamine::open_workbook_auto_from_rs(std::io::Cursor::new(bytes.to_vec()))
                .map_err(|e| format!("The workbook could not be opened: {e}"))?;
            let names: Vec<String> = wb.sheet_names().to_vec();
            let mut tabs = Vec::new();
            for n in names {
                if let Ok(range) = wb.worksheet_range(&n) {
                    // A range starts at its first used cell. The blank rows above it are put back,
                    // so a row here is the sheet's own row: pictures are anchored by that row.
                    let top = range.start().map(|(r, _)| r as usize).unwrap_or(0).min(100_000);
                    let mut rows: Vec<Vec<String>> = vec![Vec::new(); top];
                    rows.extend(range.rows().map(|r| r.iter().map(cell_text).collect::<Vec<String>>()));
                    tabs.push(Tab { name: n, rows });
                }
            }
            if tabs.is_empty() {
                return Err("The workbook has no tab that could be read.".into());
            }
            Ok(tabs)
        }
        other => Err(format!("A .{other} file is not a sheet: send it as .xlsx or .csv.")),
    }
}

// ---------------------------------------------------------------------------------------
// Reading the manifest
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TabRead {
    pub name: String,
    /// False for a tab with no Style column (a totals or cover tab).
    pub read: bool,
    pub lines: usize,
    pub pairs: i64,
    pub note: String,
    /// R-537: "items" (styles were read), "totals" (a master or totals page: never items, only
    /// used to check the count), or "other" (not a list of items).
    pub kind: String,
    /// R-537: where the size names came from: "above" (a row of sizes above each style, which may
    /// change from style to style), "heading" (sizes on the heading row), "column" (a Size column,
    /// one size a row), or "" for a tab not read.
    pub layout: String,
    /// R-537: the first lines read from the tab, to show what was read.
    pub samples: Vec<String>,
    /// R-537: lines whose Total column disagrees with their sizes.
    pub mismatches: usize,
    /// R-537: pictures in this tab matched to a style.
    pub pictures: usize,
    /// R-537: this tab's own warnings (also in the read's warnings).
    pub warnings: Vec<String>,
}

/// A line whose Total column says something other than its sizes add up to.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mismatch {
    pub line_id: String,
    pub source: String,
    pub style: String,
    pub color: String,
    pub sizes: i64,
    pub total: i64,
}

/// What a totals tab says the manifest holds.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Stated {
    pub tab: String,
    pub lines: Option<i64>,
    pub pairs: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GroupCount {
    pub brand: String,
    pub group: String,
    pub lines: usize,
    pub pairs: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ManifestRead {
    pub lines: Vec<LoadLine>,
    pub tabs: Vec<TabRead>,
    pub groups: Vec<GroupCount>,
    pub mismatches: Vec<Mismatch>,
    pub warnings: Vec<String>,
    pub stated: Option<Stated>,
    pub pairs: i64,
    /// R-537: pictures matched to a style, and pictures left out (on a row with no style, or a
    /// second picture for the same style).
    pub pictures: usize,
    pub pictures_left_out: usize,
}

fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Text on one line: a description written over several lines in its cell reads as one.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "1,234", "$12", "12.0" -> a whole number. Blank or words -> None.
pub fn num(s: &str) -> Option<i64> {
    money(s).map(|f| f.round() as i64)
}

/// "$16.50", "1,234.5" -> a number. Blank or words -> None.
pub fn money(s: &str) -> Option<f64> {
    let t: String = s.chars().filter(|c| !matches!(c, ',' | '$' | ' ')).collect();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite())
}

fn is_total(s: &str) -> bool {
    let l = norm(s);
    l.starts_with("total") || l.starts_with("grand total") || l.starts_with("subtotal") || l.starts_with("sub total") || l == "sum"
}

/// A size as a number: "7", "7.5", "7½", "7 1/2". None for anything else.
fn size_number(s: &str) -> Option<f64> {
    let t = s.trim();
    for half in ["\u{bd}", " 1/2", "-1/2"] {
        if let Some(head) = t.strip_suffix(half) {
            let head = head.trim();
            return if head.is_empty() { Some(0.5) } else { money(head).map(|n| n + 0.5) };
        }
    }
    money(t)
}

/// One size by itself (upper case): 7, 8.5, 7½, 7 1/2, XS, XL, 2XL, 1X, 4C, 11Y, 2T, 12M, 8W, NB,
/// one size, or a European 38. A number must be a believable size, 0 to 60 in halves, so a
/// quantity like 108 is never one.
fn one_size(t: &str) -> bool {
    if let Some(n) = size_number(t) {
        return (0.0..=60.0).contains(&n) && (n * 2.0).fract() == 0.0;
    }
    if matches!(t, "XXS" | "XS" | "S" | "M" | "L" | "XL" | "XXL" | "XXXL" | "OS" | "OSFA" | "OSFM" | "O/S" | "ONE SIZE" | "NB" | "NEWBORN") {
        return true;
    }
    if t.strip_suffix("XL").map(|h| matches!(h, "2" | "3" | "4" | "5" | "6")).unwrap_or(false)
        || t.strip_suffix('X').map(|h| matches!(h, "0" | "1" | "2" | "3" | "4" | "5" | "6")).unwrap_or(false)
    {
        return true;
    }
    let last = t.chars().last().unwrap_or(' ');
    let head: String = t.chars().take(t.chars().count().saturating_sub(1)).collect();
    matches!(last, 'C' | 'Y' | 'T' | 'W' | 'M' | 'K') && size_number(&head).map(|n| (0.0..=60.0).contains(&n)).unwrap_or(false)
}

/// A label that is a size: one size, or two joined as a range or pair (S/M, 5/6, 7-8, 0-3M, XS-S).
fn looks_like_size(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    if t.is_empty() || t.chars().count() > 10 {
        return false;
    }
    if one_size(&t) {
        return true;
    }
    for sep in ['/', '-'] {
        if let Some((a, b)) = t.split_once(sep) {
            let (a, b) = (a.trim(), b.trim());
            if !a.is_empty() && !b.is_empty() && one_size(a) && one_size(b) {
                return true;
            }
        }
    }
    false
}

/// A row of size names: every label looks like a size, or every label is a word (Small, Medium,
/// 34B: words are never quantities), or the labels are numbers rising left to right in small steps
/// (cm sizes 98, 104, 110). A row of quantities such as 24, 36, 108 is never taken for one.
fn is_size_row(labels: &[(usize, String)]) -> bool {
    if labels.is_empty() {
        return false;
    }
    if labels.iter().all(|(_, l)| looks_like_size(l)) {
        return true;
    }
    let filler = |l: &str| {
        let n = norm(l);
        n.is_empty() || matches!(n.as_str(), "pairs" | "pair" | "qty" | "quantity" | "units" | "unit" | "pcs" | "each" | "ea" | "total" | "n a" | "na" | "tbd" | "none" | "size" | "sizes")
    };
    let side_by_side = labels.windows(2).all(|w| w[1].0 == w[0].0 + 1);
    let words = labels.len() >= 2
        && side_by_side
        && labels.iter().all(|(_, l)| num(l).is_none() && l.chars().count() <= 16 && !filler(l))
        && labels.iter().any(|(_, l)| !l.eq_ignore_ascii_case(&labels[0].1));
    if words {
        return true;
    }
    let ns: Vec<f64> = labels.iter().filter_map(|(_, l)| size_number(l)).collect();
    ns.len() == labels.len() && ns.len() >= 2 && ns.windows(2).all(|w| w[1] > w[0] && w[1] - w[0] <= 12.0) && ns.iter().all(|n| (0.0..=250.0).contains(n))
}

/// A size named on a heading row: as `looks_like_size`, or a number up to 250 (a heading is a
/// label, never a quantity, so EU and cm sizes read).
fn heading_size(s: &str) -> bool {
    looks_like_size(s) || size_number(s).map(|n| (0.0..=250.0).contains(&n) && (n * 2.0).fract() == 0.0).unwrap_or(false)
}

/// Size names that appear more than once in a row of sizes, in order.
fn repeated_sizes(labels: &[(usize, String)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, (_, l)) in labels.iter().enumerate() {
        if labels[..i].iter().any(|(_, m)| m == l) && !out.contains(l) {
            out.push(l.clone());
        }
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Cols {
    header_row: usize,
    style: usize,
    color: Option<usize>,
    description: Option<usize>,
    color_name: Option<usize>,
    cost: Option<usize>,
    msrp: Option<usize>,
    total: Option<usize>,
    /// The column headed "Size" (where a size grid starts, or the one size of a row).
    size_col: Option<usize>,
    grid_from: usize,
    grid_to: usize,
    /// Sizes named on the heading row itself, by column.
    scale: Vec<(usize, String)>,
}

/// The first 30 rows with anything in them: where a heading row is looked for.
fn top_rows(rows: &[Vec<String>]) -> Vec<usize> {
    (0..rows.len()).filter(|&r| rows[r].iter().any(|c| !c.trim().is_empty())).take(30).collect()
}

fn find_cols(rows: &[Vec<String>]) -> Option<Cols> {
    for r in top_rows(rows) {
        let h: Vec<String> = rows[r].iter().map(|c| norm(c)).collect();
        let pos = |f: &dyn Fn(&str) -> bool| h.iter().position(|x| f(x));
        let style = match pos(&|x| matches!(x, "style" | "style number" | "style no" | "sku" | "item" | "item number" | "model")) {
            Some(c) => c,
            None => continue,
        };
        let colorish = |x: &str| x.contains("color") || x.contains("colour");
        let color_name = pos(&|x| colorish(x) && (x.contains("desc") || x.contains("name")));
        let color = pos(&|x| matches!(x, "color" | "colour" | "color code" | "colour code" | "clr" | "colorway" | "colourway" | "color way" | "colour way"));
        let description = pos(&|x| !colorish(x) && (x.contains("desc") || x == "name" || x == "style name"));
        let cost = pos(&|x| x.contains("cost") || x.contains("wholesale") || matches!(x, "std price" | "price" | "unit price"));
        let msrp = pos(&|x| x.contains("msrp") || x.contains("retail") || x == "srp");
        let total_head = |x: &str| {
            matches!(x, "total" | "total pairs" | "pairs" | "qty" | "total qty" | "quantity" | "units" | "total units" | "pcs" | "pieces" | "order qty" | "qty ordered" | "on hand")
        };
        // The total column: the first after `from`, else the first after the style.
        let total_after = |from: usize| {
            h.iter().enumerate().skip(from).find(|(_, x)| total_head(x)).map(|(c, _)| c).or_else(|| h.iter().enumerate().skip(style + 1).find(|(_, x)| total_head(x)).map(|(c, _)| c))
        };
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let not_a_measure = |x: &str| !["pack", "case", "box", "carton", "pallet", "inner", "master", "lot", "sample", "min", "max"].iter().any(|w| x.split(' ').any(|p| p == *w));
        let exact_head = |x: &str| (matches!(x, "size" | "sizes" | "sz" | "sizing") || x.starts_with("size ") || x.starts_with("sizes ")) && not_a_measure(x) && !looks_like_size(x);
        let named_on_heading = (style + 1..rows[r].len()).filter(|&k| heading_size(&rows[r][k])).count();
        let loose_head = |x: &str| (x.ends_with(" size") || x.ends_with(" sizes")) && not_a_measure(x) && !looks_like_size(x) && named_on_heading < 2;
        let size_col = h.iter().position(|x| exact_head(x)).or_else(|| h.iter().position(|x| loose_head(x)));
        // A "Size" heading where the grid starts (up to the total after it), or else sizes named
        // as headings (a Qty or Total before them does not cut them off).
        let (grid_from, grid_to, scale, total) = if let Some(c) = size_col {
            let total = total_after(c + 1);
            let end = total.filter(|&k| k > c).unwrap_or(width).max(c + 1);
            let scale = (c + 1..end).filter(|&k| k < rows[r].len() && heading_size(&rows[r][k])).map(|k| (k, rows[r][k].trim().to_string())).collect();
            (c, end, scale, total)
        } else {
            let named: Vec<(usize, String)> = (style + 1..width).filter(|&k| k < rows[r].len() && !total_head(&h[k]) && heading_size(&rows[r][k])).map(|k| (k, rows[r][k].trim().to_string())).collect();
            // Sizes stop at the first total after them, so a size-like heading past Total (an M
            // for markup) never stretches the grid over Total, Cost and MSRP.
            let cut = named.first().and_then(|f| (f.0 + 1..h.len()).find(|&k| total_head(&h[k]))).unwrap_or(width);
            let named: Vec<(usize, String)> = named.into_iter().filter(|(k, _)| *k < cut).collect();
            match (named.first(), named.last()) {
                (Some(a), Some(b)) => (a.0, b.0 + 1, named.clone(), total_after(b.0 + 1)),
                _ => continue,
            }
        };
        if grid_from >= grid_to {
            continue;
        }
        return Some(Cols { header_row: r, style, color, description, color_name, cost, msrp, total, size_col, grid_from, grid_to, scale });
    }
    None
}

fn at(row: &[String], c: Option<usize>) -> String {
    c.and_then(|c| row.get(c)).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// The figures a totals tab states: the row headed Total(s), under the pairs heading and a
/// SKU/style heading when there is one.
fn stated_totals(tab: &Tab) -> Option<Stated> {
    for r in top_rows(&tab.rows) {
        let h: Vec<String> = tab.rows[r].iter().map(|c| norm(c)).collect();
        let pairs_col = match h.iter().position(|x| x.contains("pair") || x == "qty" || x.contains("quantity") || x == "total units") {
            Some(c) => c,
            None => continue,
        };
        let lines_col = h.iter().position(|x| x.starts_with("sku") || x.starts_with("style"));
        for row in &tab.rows[r + 1..] {
            let first = row.iter().find(|c| !c.trim().is_empty()).cloned().unwrap_or_default();
            let sub = norm(&first);
            if is_total(&first) && !sub.starts_with("subtotal") && !sub.starts_with("sub total") {
                let pairs = num(&at(row, Some(pairs_col)))?;
                let lines = lines_col.and_then(|c| num(&at(row, Some(c))));
                return Some(Stated { tab: tab.name.clone(), lines, pairs });
            }
        }
    }
    None
}

/// Where each line was read: (tab index, 1-based row) to line id. A line read over several rows
/// (one size a row) has every one of its rows here. Pictures are matched through it.
pub type RowMap = BTreeMap<(usize, usize), String>;

/// Read every tab of a manifest into lines. Nothing here is saved: the screen shows it first.
pub fn read_manifest(tabs: &[Tab]) -> ManifestRead {
    read_manifest_rows(tabs).0
}

/// `read_manifest`, plus where each line was read (for matching pictures).
pub fn read_manifest_rows(tabs: &[Tab]) -> (ManifestRead, RowMap) {
    let mut lines: Vec<LoadLine> = Vec::new();
    let mut tab_reads = Vec::new();
    let mut mismatches = Vec::new();
    let mut warnings = Vec::new();
    let mut stated = None;
    let mut rowmap: RowMap = BTreeMap::new();
    for (ti, tab) in tabs.iter().enumerate() {
        let cols = match find_cols(&tab.rows) {
            Some(c) => c,
            None => {
                let st = stated_totals(tab);
                let is_totals = st.is_some();
                if stated.is_none() {
                    stated = st;
                }
                let (kind, note) = if is_totals { ("totals", "A totals page. Never read as items, only used to check the count.") } else { ("other", "No Style column, so nothing on it is read.") };
                tab_reads.push(TabRead { name: tab.name.clone(), read: false, lines: 0, pairs: 0, note: note.into(), kind: kind.into(), layout: String::new(), samples: vec![], mismatches: 0, pictures: 0, warnings: vec![] });
                continue;
            }
        };
        let brand = one_line(&tab.name);
        let body = cols.header_row + 1..tab.rows.len();
        // Which way does this tab name its sizes? Rows of sizes above the styles, sizes on the
        // heading row, or one size a row in the Size column next to a quantity.
        let size_rows = body
            .clone()
            .filter(|&r| {
                let row = &tab.rows[r];
                if !one_line(&at(row, Some(cols.style))).is_empty() {
                    return false;
                }
                let grid: Vec<(usize, String)> = (cols.grid_from..cols.grid_to.min(row.len())).filter(|&c| !row[c].trim().is_empty()).map(|c| (c, row[c].trim().to_string())).collect();
                let filled = row.iter().filter(|c| !c.trim().is_empty()).count();
                !grid.is_empty() && grid.len() == filled && is_size_row(&grid)
            })
            .count();
        // Rows with no style whose cells all sit in the size columns: rows of sizes, named in a way
        // the reader knows or not. A tab with any is never one size a row.
        let grid_rows = body
            .clone()
            .filter(|&r| {
                let row = &tab.rows[r];
                let filled: Vec<usize> = (0..row.len()).filter(|&c| !row[c].trim().is_empty()).collect();
                one_line(&at(row, Some(cols.style))).is_empty() && filled.len() > 1 && filled.iter().all(|&c| c >= cols.grid_from && c < cols.grid_to)
            })
            .count();
        let styled: Vec<usize> = body
            .clone()
            .filter(|&r| {
                let s = one_line(&at(&tab.rows[r], Some(cols.style)));
                !s.is_empty() && !is_total(&s) && tab.rows[r].iter().filter(|c| !c.trim().is_empty()).count() > 1
            })
            .collect();
        let sized = styled.iter().filter(|&&r| looks_like_size(&at(&tab.rows[r], cols.size_col))).count();
        let per_row = size_rows == 0 && grid_rows == 0 && cols.scale.is_empty() && cols.size_col.is_some() && cols.total.is_some() && !styled.is_empty() && sized * 10 >= styled.len() * 9;
        let layout = if per_row { "column" } else if size_rows > 0 { "above" } else { "heading" };
        let first_line = lines.len();
        let first_warning = warnings.len();
        let mut scale: Vec<(usize, String)> = cols.scale.clone();
        let mut scale_row = if scale.is_empty() { 0 } else { cols.header_row + 1 };
        let mut group = String::new();
        let mut tab_mismatches = 0usize;
        // Pairs by column since the last row of sizes or group heading: a row with no style whose
        // numbers are exactly these sums is a subtotal.
        let mut since: BTreeMap<usize, i64> = BTreeMap::new();
        for r in body {
            let row = &tab.rows[r];
            let lone: Vec<&String> = row.iter().filter(|c| !c.trim().is_empty()).collect();
            let lone_col = row.iter().position(|c| !c.trim().is_empty()).unwrap_or(0);
            let lone_size = lone_col >= cols.grid_from && lone_col < cols.grid_to && looks_like_size(lone.first().map(|s| s.as_str()).unwrap_or(""));
            if lone.len() == 1 && num(lone[0]).is_none() && !is_total(lone[0]) && !lone_size {
                group = one_line(lone[0]);
                since.clear();
                continue;
            }
            let style = one_line(&at(row, Some(cols.style)));
            let grid: Vec<(usize, String)> = (cols.grid_from..cols.grid_to.min(row.len()))
                .filter(|&c| !row[c].trim().is_empty())
                .map(|c| (c, row[c].trim().to_string()))
                .collect();
            if style.is_empty() {
                let filled: Vec<&String> = row.iter().filter(|c| !c.trim().is_empty()).collect();
                if !per_row && !grid.is_empty() && grid.len() == filled.len() {
                    let subtotal = !since.is_empty()
                        && grid.iter().all(|(c, v)| num(v) == Some(since.get(c).copied().unwrap_or(0)))
                        && since.keys().all(|c| grid.iter().any(|(k, _)| k == c));
                    if subtotal {
                        since.clear();
                    } else if is_size_row(&grid) {
                        let twice = repeated_sizes(&grid);
                        if let Some((last, rest)) = twice.split_last() {
                            let named = if rest.is_empty() { format!("size {last} is") } else { format!("sizes {} and {last} are each", rest.join(", ")) };
                            warnings.push(format!(
                                "{} row {}: {named} named twice in this row of sizes, so the pairs under both count as that one size. If one should be a half size, fix the sheet and read it again.",
                                tab.name,
                                r + 1
                            ));
                        }
                        scale = grid;
                        scale_row = r + 1;
                        since.clear();
                    } else {
                        warnings.push(format!("{} row {}: numbers with no style that are not size names, so they were left out.", tab.name, r + 1));
                    }
                } else if filled.len() > 1 && !filled.iter().any(|c| is_total(c)) {
                    warnings.push(format!("{} row {}: a row with no style, left out.", tab.name, r + 1));
                }
                continue;
            }
            if is_total(&style) {
                continue;
            }
            let source = format!("{} row {}", tab.name, r + 1);
            let color = one_line(&at(row, cols.color));
            if per_row {
                // One size a row: the style and colour gather their sizes from every row.
                let size = one_line(&at(row, cols.size_col));
                let qty = num(&at(row, cols.total)).unwrap_or(0);
                if size.is_empty() {
                    warnings.push(format!("{source}: no size on the row, left out."));
                    continue;
                }
                let color_name = one_line(&at(row, cols.color_name));
                let found = lines[first_line..].iter().position(|l| l.style == style && l.color == color && l.color_name == color_name && l.group == group);
                let k = match found {
                    Some(k) => first_line + k,
                    None => {
                        lines.push(LoadLine {
                            id: format!("t{}r{}", ti + 1, r + 1),
                            brand: brand.clone(),
                            group: group.clone(),
                            style: style.clone(),
                            color: color.clone(),
                            description: one_line(&at(row, cols.description)),
                            color_name: one_line(&at(row, cols.color_name)),
                            cost: money(&at(row, cols.cost)).unwrap_or(0.0),
                            msrp: money(&at(row, cols.msrp)).unwrap_or(0.0),
                            sizes: vec![],
                            sheet_total: 0,
                            source: source.clone(),
                            sheet: tab.name.clone(),
                            image: String::new(),
                            rows: vec![],
                            sizes_row: 0,
                        });
                        lines.len() - 1
                    }
                };
                let l = &mut lines[k];
                if l.rows.len() < MAX_LINE_ROWS {
                    l.rows.push(r + 1);
                }
                match l.sizes.iter_mut().find(|s| s.size == size) {
                    Some(s) => s.qty += qty.max(0),
                    None => l.sizes.push(SizeQty { size, qty: qty.max(0) }),
                }
                l.sheet_total = l.expected();
                rowmap.insert((ti, r + 1), l.id.clone());
                continue;
            }
            let mut sizes: Vec<SizeQty> = Vec::new();
            for (_, label) in &scale {
                if !sizes.iter().any(|s| &s.size == label) {
                    sizes.push(SizeQty { size: label.clone(), qty: 0 });
                }
            }
            for (c, v) in &grid {
                let q = match num(v) {
                    Some(q) => q,
                    None => continue,
                };
                if q <= 0 {
                    continue;
                }
                *since.entry(*c).or_insert(0) += q;
                match scale.iter().find(|(k, _)| k == c) {
                    Some((_, label)) => {
                        if let Some(s) = sizes.iter_mut().find(|s| &s.size == label) {
                            s.qty += q;
                        }
                    }
                    None => warnings.push(format!("{source}: {q} pairs sit under no size heading and were left out.")),
                }
            }
            let sum: i64 = sizes.iter().map(|s| s.qty).sum();
            let id = format!("t{}r{}", ti + 1, r + 1);
            let total = cols.total.and_then(|c| num(&at(row, Some(c))));
            if let Some(t) = total {
                if t != sum {
                    mismatches.push(Mismatch { line_id: id.clone(), source: source.clone(), style: style.clone(), color: at(row, cols.color), sizes: sum, total: t });
                    tab_mismatches += 1;
                }
            }
            rowmap.insert((ti, r + 1), id.clone());
            lines.push(LoadLine {
                id,
                brand: brand.clone(),
                group: group.clone(),
                style,
                color,
                description: one_line(&at(row, cols.description)),
                color_name: one_line(&at(row, cols.color_name)),
                cost: money(&at(row, cols.cost)).unwrap_or(0.0),
                msrp: money(&at(row, cols.msrp)).unwrap_or(0.0),
                sizes,
                sheet_total: total.unwrap_or(sum),
                source,
                sheet: tab.name.clone(),
                image: String::new(),
                rows: vec![r + 1],
                sizes_row: scale_row,
            });
        }
        let read = &lines[first_line..];
        let n = read.len();
        let pairs: i64 = read.iter().map(|l| l.expected()).sum();
        let samples = read.iter().take(3).map(|l| l.id.clone()).collect();
        tab_reads.push(TabRead {
            name: tab.name.clone(),
            read: true,
            lines: n,
            pairs,
            note: if n == 0 { "A Style column, but no styles under it.".into() } else { String::new() },
            kind: if n == 0 { "other".into() } else { "items".into() },
            layout: if n == 0 { String::new() } else { layout.into() },
            samples,
            mismatches: tab_mismatches,
            pictures: 0,
            warnings: warnings[first_warning..].to_vec(),
        });
    }
    // A page listing exactly the styles of all the other pages together is a master list: its
    // pairs are already counted on those pages, so it starts left out (the screen can turn it on).
    let keys = |name: &str| -> BTreeSet<(String, String)> { lines.iter().filter(|l| l.sheet == name).map(|l| (l.style.to_lowercase(), l.color.to_lowercase())).collect() };
    let pairs_of = |name: &str| -> i64 { lines.iter().filter(|l| l.sheet == name).map(|l| l.expected()).sum() };
    let items: Vec<usize> = (0..tab_reads.len()).filter(|&i| tab_reads[i].kind == "items").collect();
    if items.len() == 2 {
        let (a, b) = (items[0], items[1]);
        if keys(&tab_reads[a].name) == keys(&tab_reads[b].name) && pairs_of(&tab_reads[a].name) == pairs_of(&tab_reads[b].name) {
            let w = format!("{} and {} list the same styles and pairs. If one is a copy of the other, switch it off.", tab_reads[a].name, tab_reads[b].name);
            tab_reads[b].warnings.push(w.clone());
            warnings.push(w);
        }
    }
    if items.len() >= 3 {
        for &i in &items {
            let mine = keys(&tab_reads[i].name);
            let others: BTreeSet<(String, String)> = items.iter().filter(|&&j| j != i).flat_map(|&j| keys(&tab_reads[j].name)).collect();
            let others_pairs: i64 = items.iter().filter(|&&j| j != i).map(|&j| pairs_of(&tab_reads[j].name)).sum();
            if mine == others && pairs_of(&tab_reads[i].name) == others_pairs {
                tab_reads[i].kind = "copy".into();
                tab_reads[i].note = "Every style and every pair on this page is also on the other pages, so it looks like a master list. It is left out unless you turn it on.".into();
                break;
            }
        }
    }
    if lines.is_empty() {
        warnings.push("No line was read: no tab has a Style column with sizes beside it.".into());
    }
    // The figures for what is taken by default: every items page, never a copy.
    let taken: Vec<LoadLine> = lines.iter().filter(|l| tab_reads.iter().any(|t| t.name == l.sheet && t.kind == "items")).cloned().collect();
    let pairs = taken.iter().map(|l| l.expected()).sum();
    (ManifestRead { groups: group_counts(&taken), lines, tabs: tab_reads, mismatches, warnings, stated, pairs, pictures: 0, pictures_left_out: 0 }, rowmap)
}

// ---------------------------------------------------------------------------------------
// Pictures in the sheet (R-537)
// ---------------------------------------------------------------------------------------
//
// A picture placed over a cell in Excel lives in the file, not in the cell: the tab's drawing
// says which row and column its top-left corner sits on, and which image file it shows. A
// picture is matched to the style read on the row its top-left corner sits on, and nothing
// else: a picture on a row with no style is counted and left out, never guessed.

/// One picture: the tab it sits on (by name), the 1-based rows its top edge and bottom edge sit
/// on, the 0-based column of its left edge, and its bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Picture {
    pub sheet: String,
    pub row: usize,
    pub row_last: usize,
    pub col: usize,
    pub ext: String,
    /// Shared: one image placed on many rows is read once.
    pub bytes: std::sync::Arc<Vec<u8>>,
}

/// One picture at most this size, at most this many in a file, and at most this much image data
/// unpacked from one file.
pub const MAX_PICTURE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_PICTURES: usize = 5_000;
pub const MAX_PICTURES_TOTAL: usize = 128 * 1024 * 1024;

/// What kind of image these bytes are, by their first bytes (never by a file name).
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn zip_text<R: std::io::Read + std::io::Seek>(z: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    use std::io::Read;
    const MAX_XML: u64 = 50 * 1024 * 1024;
    let f = z.by_name(name).ok()?;
    if f.size() > MAX_XML {
        return None;
    }
    // The size a zip states is only a claim: never unpack more than the cap.
    let mut s = String::new();
    f.take(MAX_XML + 1).read_to_string(&mut s).ok()?;
    if s.len() as u64 > MAX_XML {
        return None;
    }
    Some(s)
}

/// A path inside the package, from a relationship target relative to `base_dir`.
fn package_path(base_dir: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// An attribute's value as text, its XML escapes (&amp;) undone.
fn attr_text(a: &quick_xml::events::attributes::Attribute) -> String {
    let raw = String::from_utf8_lossy(&a.value).to_string();
    quick_xml::escape::unescape(&raw).map(|v| v.to_string()).unwrap_or(raw)
}

/// The attributes of every element named `local` (any prefix) in an XML text.
fn xml_elements(xml: &str, local: &str) -> Vec<BTreeMap<String, String>> {
    use quick_xml::events::Event;
    let mut out = Vec::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == local.as_bytes() {
                    let mut m = BTreeMap::new();
                    for a in e.attributes().flatten() {
                        let key = String::from_utf8_lossy(a.key.local_name().as_ref()).to_string();
                        let val = attr_text(&a);
                        m.insert(key, val);
                    }
                    out.push(m);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// Relationship id to package path, from a `.rels` part. Links to outside the file are skipped.
fn rels<R: std::io::Read + std::io::Seek>(z: &mut zip::ZipArchive<R>, rels_path: &str, base_dir: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(x) = zip_text(z, rels_path) {
        for r in xml_elements(&x, "Relationship") {
            if r.get("TargetMode").map(|m| m.eq_ignore_ascii_case("External")).unwrap_or(false) {
                continue;
            }
            if let (Some(id), Some(t)) = (r.get("Id"), r.get("Target")) {
                out.insert(id.clone(), package_path(base_dir, t));
            }
        }
    }
    out
}

/// One picture anchored in a drawing: the 0-based rows of its top and bottom edges, and its
/// image relationship id.
#[derive(Debug, Clone, PartialEq)]
struct Anchor {
    row: usize,
    row_last: usize,
    col: usize,
    /// None for a picture linked from outside the file: it cannot be read.
    embed: Option<String>,
    /// More pictures inside the same anchor (a group): their place cannot be told, so they are
    /// counted as not read.
    extra: usize,
}

#[derive(PartialEq, Clone, Copy)]
enum Edge {
    None,
    From,
    To,
}

fn blip_embed(e: &quick_xml::events::BytesStart) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.local_name().as_ref() == b"embed").map(|a| attr_text(&a))
}

/// Every picture anchor in a drawing. An anchor inside `mc:Fallback` is the same picture again
/// for older readers, so it is skipped. A picture's bottom edge counts on the row it ends in only
/// when it reaches into that row.
fn drawing_anchors(xml: &str) -> Vec<Anchor> {
    use quick_xml::events::Event;
    let mut out = Vec::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    let (mut in_anchor, mut fallback, mut edge, mut field) = (false, 0usize, Edge::None, String::new());
    let (mut from, mut to, mut to_off): (Option<usize>, Option<usize>, i64) = (None, None, 0);
    let (mut from_col, mut extra, mut saw_blip) = (0usize, 0usize, false);
    let mut embed: Option<String> = None;
    // A row or column past Excel's last is not one.
    let cell = |v: &str| v.parse::<usize>().ok().map(|n| n.min(1_048_575));
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    b"Fallback" => fallback += 1,
                    b"twoCellAnchor" | b"oneCellAnchor" => {
                        in_anchor = true;
                        from = None;
                        to = None;
                        to_off = 0;
                        embed = None;
                        from_col = 0;
                        extra = 0;
                        saw_blip = false;
                    }
                    b"from" if in_anchor => edge = Edge::From,
                    b"to" if in_anchor => edge = Edge::To,
                    b"row" | b"rowOff" | b"col" if edge != Edge::None => field = String::from_utf8_lossy(name.as_ref()).to_string(),
                    b"blip" if in_anchor && !saw_blip => {
                        saw_blip = true;
                        embed = blip_embed(&e);
                    }
                    b"blip" if in_anchor => extra += 1,
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if in_anchor && e.local_name().as_ref() == b"blip" {
                    if !saw_blip {
                        saw_blip = true;
                        embed = blip_embed(&e);
                    } else {
                        extra += 1;
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if !field.is_empty() {
                    let v = String::from_utf8_lossy(&t).trim().to_string();
                    match (edge, field.as_str()) {
                        (Edge::From, "row") => from = cell(&v),
                        (Edge::From, "col") => from_col = cell(&v).unwrap_or(0),
                        (Edge::To, "row") => to = cell(&v),
                        (Edge::To, "rowOff") => to_off = v.parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    b"Fallback" => fallback = fallback.saturating_sub(1),
                    b"row" | b"rowOff" | b"col" => field.clear(),
                    b"from" | b"to" => edge = Edge::None,
                    b"twoCellAnchor" | b"oneCellAnchor" => {
                        in_anchor = false;
                        if let (Some(r), true, 0) = (from, saw_blip, fallback) {
                            let last = match to {
                                Some(t) if t > r && to_off > 0 => t,
                                Some(t) if t > r => t - 1,
                                _ => r,
                            };
                            out.push(Anchor { row: r, row_last: last, col: from_col, embed: embed.take(), extra });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// What a file's pictures read as: every picture placed over a cell, how many pictures could not
/// be read (a missing or oversized image, not a jpg/png/gif/webp, past the caps, or a second
/// picture inside a group), and whether the file also has pictures placed inside cells (Excel's
/// Place in cell), which are not read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SheetPictures {
    pub pictures: Vec<Picture>,
    pub unreadable: usize,
    pub in_cell: bool,
}

/// Every picture placed over a cell, in every tab of an Excel file (.xlsx/.xlsm). Any other
/// file, or a part that cannot be read, gives no pictures rather than an error: the lines read
/// either way. A picture is kept only when its bytes are a jpg, png, gif or webp.
pub fn read_pictures(filename: &str, bytes: &[u8]) -> SheetPictures {
    let mut sp = SheetPictures::default();
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "xlsx" | "xlsm") {
        return sp;
    }
    let mut z = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(z) => z,
        Err(_) => return sp,
    };
    sp.in_cell = z.file_names().any(|n| n.starts_with("xl/richData/"));
    let workbook = match zip_text(&mut z, "xl/workbook.xml") {
        Some(x) => x,
        None => return sp,
    };
    let book_rels = rels(&mut z, "xl/_rels/workbook.xml.rels", "xl");
    let mut out = Vec::new();
    let mut media_seen: BTreeMap<String, Option<(&'static str, std::sync::Arc<Vec<u8>>)>> = BTreeMap::new();
    let mut unpacked = 0usize;
    for sheet in xml_elements(&workbook, "sheet") {
        let (name, rid) = match (sheet.get("name"), sheet.get("id")) {
            (Some(n), Some(r)) => (n.clone(), r.clone()),
            _ => continue,
        };
        let sheet_path = match book_rels.get(&rid) {
            Some(p) => p.clone(),
            None => continue,
        };
        let (dir, file) = match sheet_path.rsplit_once('/') {
            Some((d, f)) => (d.to_string(), f.to_string()),
            None => (String::new(), sheet_path.clone()),
        };
        let sheet_rels = rels(&mut z, &format!("{dir}/_rels/{file}.rels"), &dir);
        for drawing in sheet_rels.values().filter(|p| p.contains("/drawings/") && p.ends_with(".xml")) {
            let xml = match zip_text(&mut z, drawing) {
                Some(x) => x,
                None => continue,
            };
            let (ddir, dfile) = drawing.rsplit_once('/').unwrap_or(("", drawing));
            let drels = rels(&mut z, &format!("{ddir}/_rels/{dfile}.rels"), ddir);
            for a in drawing_anchors(&xml) {
                sp.unreadable += a.extra;
                if out.len() >= MAX_PICTURES {
                    sp.unreadable += 1;
                    continue;
                }
                let media = match a.embed.as_ref().and_then(|e| drels.get(e)) {
                    Some(m) => m.clone(),
                    None => {
                        sp.unreadable += 1;
                        continue;
                    }
                };
                if !media_seen.contains_key(&media) {
                    let got = {
                        use std::io::Read;
                        match z.by_name(&media) {
                            Ok(f) if (f.size() as usize) <= MAX_PICTURE_BYTES => {
                                let mut v = Vec::new();
                                let ok = f.take(MAX_PICTURE_BYTES as u64 + 1).read_to_end(&mut v).is_ok() && v.len() <= MAX_PICTURE_BYTES && unpacked + v.len() <= MAX_PICTURES_TOTAL;
                                match image_ext(&v) {
                                    Some(e) if ok => {
                                        unpacked += v.len();
                                        Some((e, std::sync::Arc::new(v)))
                                    }
                                    _ => None,
                                }
                            }
                            _ => None,
                        }
                    };
                    media_seen.insert(media.clone(), got);
                }
                let (ext, data) = match media_seen.get(&media).cloned().flatten() {
                    Some(x) => x,
                    None => {
                        sp.unreadable += 1;
                        continue;
                    }
                };
                out.push(Picture { sheet: name.clone(), row: a.row + 1, row_last: a.row_last + 1, col: a.col, ext: ext.into(), bytes: data });
            }
        }
    }
    sp.pictures = out;
    sp
}

/// Each line's picture. A picture belongs to the line read on the row its top edge sits on; when
/// no line was read there and it reaches just into the next row, to the line read on that row
/// (never a guess between two, never a banner over many rows). A line keeps one picture: the
/// first in the tab's picture column (where most of its pictures sit), else the first. Returns
/// (line id, picture index) pairs and fills each tab's and the read's picture counts.
pub fn match_pictures(read: &mut ManifestRead, rowmap: &RowMap, tabs: &[Tab], pictures: &[Picture]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    let mut left_out = 0usize;
    let mut per_col: BTreeMap<(&str, usize), usize> = BTreeMap::new();
    for p in pictures {
        *per_col.entry((p.sheet.as_str(), p.col)).or_insert(0) += 1;
    }
    let mut main_col: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for ((s, c), n) in &per_col {
        let best = main_col.entry(s).or_insert((*c, *n));
        if *n > best.1 {
            *best = (*c, *n);
        }
    }
    let mut order: Vec<usize> = (0..pictures.len()).collect();
    order.sort_by_key(|&k| if main_col.get(pictures[k].sheet.as_str()).map(|m| m.0) == Some(pictures[k].col) { 0 } else { 1 });
    for k in order {
        let p = &pictures[k];
        let ti = match tabs.iter().position(|t| t.name == p.sheet) {
            Some(i) => i,
            None => {
                left_out += 1;
                continue;
            }
        };
        let id = match rowmap.get(&(ti, p.row)) {
            Some(id) => Some(id.clone()),
            None if p.row_last == p.row + 1 => rowmap.get(&(ti, p.row + 1)).cloned(),
            None => None,
        };
        match id {
            Some(id) if !out.iter().any(|(l, _)| *l == id) => {
                out.push((id, k));
                if let Some(t) = read.tabs.get_mut(ti) {
                    t.pictures += 1;
                }
            }
            _ => left_out += 1,
        }
    }
    read.pictures = out.len();
    read.pictures_left_out = left_out;
    out
}

/// A file as the import reads it: every tab's lines, and each line's picture.
pub fn read_manifest_file(filename: &str, bytes: &[u8]) -> Result<(ManifestRead, Vec<(String, Picture)>), String> {
    let tabs = read_tabs(filename, bytes)?;
    let (mut read, rowmap) = read_manifest_rows(&tabs);
    let sp = read_pictures(filename, bytes);
    let matched = match_pictures(&mut read, &rowmap, &tabs, &sp.pictures);
    read.pictures_left_out += sp.unreadable;
    if sp.in_cell {
        read.warnings.push("Some pictures in this file are placed inside cells. Those cannot be read yet; pictures placed over the cells are.".into());
    }
    let mut out = Vec::new();
    let mut pics: Vec<Option<Picture>> = sp.pictures.into_iter().map(Some).collect();
    for (id, k) in matched {
        if let Some(p) = pics[k].take() {
            out.push((id, p));
        }
    }
    Ok((read, out))
}

/// A line or delivery id safe to put in a file name.
pub fn safe_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// The bytes' 64-bit FNV-1a hash in hex: in a picture's file name, so a changed picture is a new
/// file and a cache never shows the old one.
pub fn picture_tag(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Where a line's picture is kept: "media/deliveries/<load>/<line>-<tag>.<ext>" (both surfaces
/// serve media/ at /media/), the kind from the bytes themselves. None when an id is not safe for
/// a file name or the bytes are not a jpg, png, gif or webp.
pub fn picture_rel(load_id: &str, line_id: &str, bytes: &[u8]) -> Option<String> {
    let ext = image_ext(bytes)?;
    if !safe_id(load_id) || !safe_id(line_id) {
        return None;
    }
    Some(format!("media/deliveries/{load_id}/{line_id}-{}.{ext}", picture_tag(bytes)))
}

/// An image path a line may carry: one this file made, under media/deliveries/, or none.
pub fn clean_image(s: &str) -> String {
    let s = s.trim();
    let ok = s.starts_with("media/deliveries/")
        && !s.contains("..")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
        && s.len() <= 300;
    if ok { s.to_string() } else { String::new() }
}

/// A preview's picture at most this size; a bigger one still imports, it is only not shown early.
pub const MAX_PREVIEW_BYTES: usize = 400 * 1024;

/// The pictures of each tab's sample lines, as data: URLs, so the preview can show them before
/// anything is saved.
pub fn previews(read: &ManifestRead, pics: &[(String, Picture)]) -> BTreeMap<String, String> {
    use base64::Engine;
    let mut out = BTreeMap::new();
    for id in read.tabs.iter().flat_map(|t| t.samples.iter()) {
        if let Some((_, p)) = pics.iter().find(|(l, _)| l == id) {
            if p.bytes.len() <= MAX_PREVIEW_BYTES {
                let mime = match p.ext.as_str() {
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    _ => "image/jpeg",
                };
                out.insert(id.clone(), format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(p.bytes.as_slice())));
            }
        }
    }
    out
}

/// Which saved line each line read from a file is, for putting the file's pictures on a delivery
/// already saved: the saved line with the same id whose style and colour also match, or else the
/// one saved line with the same tab, style and colour. A line that matches no saved line, or more
/// than one, is left out, and a saved line takes one at most: a picture never lands on a guess.
/// (The id alone is not enough: a row inserted above two rows of the same style and colour would
/// move one onto the other's id; their sizes tell them apart.)
/// Returns (read line id, saved line id) pairs.
pub fn same_lines(saved: &[LoadLine], read: &[LoadLine]) -> Vec<(String, String)> {
    let key = |l: &LoadLine| (l.brand.to_lowercase(), l.style.to_lowercase(), l.color.to_lowercase());
    let mut out: Vec<(String, String)> = Vec::new();
    // Every line found by its id first, so a line matched by tab, style and colour below can never
    // take a saved line that another line owns by id.
    for r in read {
        if let Some(s) = saved.iter().find(|s| s.id == r.id && s.style.eq_ignore_ascii_case(&r.style) && s.color.eq_ignore_ascii_case(&r.color) && s.sizes == r.sizes) {
            if !out.iter().any(|(_, x)| *x == s.id) {
                out.push((r.id.clone(), s.id.clone()));
            }
        }
    }
    for r in read {
        if out.iter().any(|(x, _)| *x == r.id) {
            continue;
        }
        let same: Vec<&LoadLine> = saved.iter().filter(|s| key(s) == key(r)).collect();
        if same.len() == 1 && !out.iter().any(|(_, x)| *x == same[0].id) {
            out.push((r.id.clone(), same[0].id.clone()));
        }
    }
    out
}

/// Lines and pairs by brand and group, in the order they first appear.
pub fn group_counts(lines: &[LoadLine]) -> Vec<GroupCount> {
    let mut out: Vec<GroupCount> = Vec::new();
    for l in lines {
        match out.iter_mut().find(|g| g.brand == l.brand && g.group == l.group) {
            Some(g) => {
                g.lines += 1;
                g.pairs += l.expected();
            }
            None => out.push(GroupCount { brand: l.brand.clone(), group: l.group.clone(), lines: 1, pairs: l.expected() }),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------
// Saving: lines and cases cleaned before they are written
// ---------------------------------------------------------------------------------------

/// Lines as they will be stored: trimmed, a style each, sizes named once, ids unique. The cap keeps
/// one delivery row (all its lines in one column) well inside a sync event.
pub fn clean_lines(lines: Vec<LoadLine>) -> Result<Vec<LoadLine>, String> {
    if lines.len() > MAX_LINES {
        return Err(format!("More than {MAX_LINES} lines on one delivery."));
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for mut l in lines {
        l.style = one_line(&l.style);
        if l.style.is_empty() {
            continue;
        }
        for f in [&mut l.brand, &mut l.group, &mut l.color, &mut l.description, &mut l.color_name, &mut l.source, &mut l.sheet] {
            *f = one_line(f);
        }
        l.image = clean_image(&l.image);
        l.rows.retain(|&r| (1..=1_048_576).contains(&r));
        l.rows.truncate(MAX_LINE_ROWS);
        if l.sizes_row > 1_048_576 {
            l.sizes_row = 0;
        }
        let mut sizes: Vec<SizeQty> = Vec::new();
        for s in l.sizes {
            let size = one_line(&s.size);
            if size.is_empty() {
                continue;
            }
            match sizes.iter_mut().find(|x| x.size == size) {
                Some(x) => x.qty += s.qty.max(0),
                None => sizes.push(SizeQty { size, qty: s.qty.max(0) }),
            }
        }
        if sizes.is_empty() {
            return Err(format!("{} {} has no sizes.", l.style, l.color).trim().to_string());
        }
        l.sizes = sizes;
        l.cost = if l.cost.is_finite() { l.cost.max(0.0) } else { 0.0 };
        l.msrp = if l.msrp.is_finite() { l.msrp.max(0.0) } else { 0.0 };
        let base = if l.id.trim().is_empty() { "line".to_string() } else { l.id.trim().to_string() };
        let k = seen.entry(base.clone()).or_insert(0);
        *k += 1;
        l.id = if *k == 1 { base } else { format!("{base}-{k}") };
        out.push(l);
    }
    if out.is_empty() {
        return Err("There are no lines to save.".into());
    }
    Ok(out)
}

/// "5, 6, 7, 8.5" or "S M L" -> a size scale with nothing expected.
pub fn parse_sizes(text: &str) -> Vec<SizeQty> {
    let mut out: Vec<SizeQty> = Vec::new();
    for s in text.split([',', ' ', '/', ';']).map(str::trim).filter(|s| !s.is_empty()) {
        if !out.iter().any(|x| x.size == s) {
            out.push(SizeQty { size: s.to_string(), qty: 0 });
        }
    }
    out
}

/// What a case holds, checked against the delivery's lines: every style on it, every size on
/// its scale, nothing below zero; zeros dropped and the same style and size merged.
pub fn clean_contents(lines: &[LoadLine], contents: &[CaseLine]) -> Result<Vec<CaseLine>, String> {
    let out = clean_filling(lines, contents)?;
    if out.is_empty() {
        return Err("Put at least one pair in the case.".into());
    }
    Ok(out)
}

/// R-554: what a box that already exists holds, which may be nothing: a box counted onto its
/// pallet and not filled yet, or one emptied again. Otherwise the same rules as `clean_contents`.
pub fn clean_filling(lines: &[LoadLine], contents: &[CaseLine]) -> Result<Vec<CaseLine>, String> {
    let mut out: Vec<CaseLine> = Vec::new();
    for c in contents {
        let line = lines.iter().find(|l| l.id == c.line_id).ok_or("A style in this case is no longer on the delivery.")?;
        let size = one_line(&c.size);
        if !line.sizes.iter().any(|s| s.size == size) {
            return Err(format!("{} {} has no size {size}.", line.style, line.color));
        }
        if c.pairs < 0 {
            return Err("A size cannot hold fewer than 0 pairs.".into());
        }
        if c.pairs == 0 {
            continue;
        }
        match out.iter_mut().find(|x| x.line_id == c.line_id && x.size == size) {
            Some(x) => x.pairs += c.pairs,
            None => out.push(CaseLine { line_id: c.line_id.clone(), size, pairs: c.pairs }),
        }
    }
    let total: i64 = out.iter().map(|c| c.pairs).sum();
    if total > MAX_PAIRS_PER_CASE {
        return Err(format!("More than {MAX_PAIRS_PER_CASE} pairs in one case."));
    }
    Ok(out)
}

/// The next case number on a pallet (one more than the highest there), leaving out one case
/// (the one being moved).
pub fn next_number(cases: &[Case], pallet: i64, skip_id: &str) -> i64 {
    cases.iter().filter(|c| c.pallet == pallet && c.id != skip_id && !c.is_loose()).map(|c| c.number).max().unwrap_or(0) + 1
}

// ---------------------------------------------------------------------------------------
// Pallets as records (R-535): a pallet can stand empty, has a location, and can be marked full
// ---------------------------------------------------------------------------------------
//
// A pallet record (`warehouse_load_pallets`, one row per pallet, id `pal-<load_id>-<number>` so
// two devices starting the same pallet write one row) carries what the boxes cannot: where it
// stands and whether it is full. A pallet number with boxes and no record is still a pallet; it
// shows with no location until one is set.

pub const MAX_LOCATION: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PalletRecord {
    pub id: String,
    #[serde(default)]
    pub number: i64,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// R-554: how its boxes stack, in Jack's words rows (layers, stacked up) of `per_layer` boxes.
    /// 0 when not said. A picture only: nothing is counted from them.
    #[serde(default)]
    pub layers: i64,
    #[serde(default)]
    pub per_layer: i64,
}

pub fn pallet_id(load_id: &str, number: i64) -> String {
    format!("pal-{load_id}-{number}")
}

/// A location as stored: one line, trimmed, at most 40 characters.
pub fn clean_location(s: &str) -> String {
    one_line(s).chars().take(MAX_LOCATION).collect()
}

// R-554: box codes. Jack writes each box's code on the carton in sharpie, so the code is the
// pallet's short name and the box's number (A3-7), given once when the box is made.

pub const MAX_CODE: usize = 16;
/// A pallet's boxes are set up as 1 to 30 rows (stacked) of 1 to 40 boxes, at most 300 in all.
pub const MAX_BOX_ROWS: i64 = 30;
pub const MAX_PER_ROW: i64 = 40;
pub const MAX_BOXES: i64 = 300;

/// A code as stored: one line, at most 16 characters.
pub fn clean_code(s: &str) -> String {
    one_line(s).chars().take(MAX_CODE).collect()
}

/// The short name a pallet's box codes start with: its location when that is a short code (1 to 8
/// letters, digits or dashes, as a row names it: A3), else P and its number.
pub fn pallet_label(location: &str, number: i64) -> String {
    let l = location.trim();
    if !l.is_empty() && l.chars().count() <= 8 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        l.to_string()
    } else {
        format!("P{number}")
    }
}

pub fn box_code(label: &str, number: i64) -> String {
    format!("{label}-{number}")
}

/// Whether `rows` rows of `per_row` boxes, `count` in all, can be set up on a pallet that already
/// has `have` boxes. The top row may be short, so `count` runs from one more than the rows below
/// it hold up to every row full; never fewer than the boxes already on it.
pub fn check_box_setup(label: &str, rows: i64, per_row: i64, count: i64, have: usize) -> Result<(), String> {
    if !(1..=MAX_BOX_ROWS).contains(&rows) {
        return Err(format!("Say how many rows of boxes are stacked, 1 to {MAX_BOX_ROWS}."));
    }
    if !(1..=MAX_PER_ROW).contains(&per_row) {
        return Err(format!("Say how many boxes are in each row, 1 to {MAX_PER_ROW}."));
    }
    let full = rows * per_row;
    if full > MAX_BOXES {
        return Err(format!("A pallet holds at most {MAX_BOXES} boxes here."));
    }
    let least = (rows - 1) * per_row + 1;
    if count < least || count > full {
        let held = if rows == 1 { format!("1 row of {per_row} holds") } else { format!("{rows} rows of {per_row} hold") };
        return Err(if least == full {
            format!("{held} {full} {}.", if full == 1 { "box" } else { "boxes" })
        } else {
            format!("{held} {least} to {full} boxes (the top row can be short).")
        });
    }
    if (count as usize) < have {
        return Err(format!("{label} already has {have} boxes. Remove the extra boxes first."));
    }
    Ok(())
}

/// One pallet as the screens show it: its record (when there is one) and what is on it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PalletView {
    pub pallet: i64,
    pub location: String,
    pub closed: bool,
    pub note: String,
    /// False for a pallet known only through its boxes (no record yet).
    pub recorded: bool,
    pub boxes: usize,
    /// R-554: boxes with at least one pair in them (the rest are counted on, not filled yet).
    pub filled: usize,
    /// Pairs on the pallet with no box.
    pub loose: i64,
    pub pairs: i64,
    pub styles: usize,
    pub cost: f64,
    pub msrp: f64,
    /// R-554: how its boxes stack (0 when not said).
    pub layers: i64,
    pub per_layer: i64,
}

/// Every pallet, recorded or known through its boxes, lowest number first.
pub fn pallet_views(records: &[PalletRecord], sums: &[PalletSum]) -> Vec<PalletView> {
    let mut numbers: Vec<i64> = records.iter().map(|r| r.number).chain(sums.iter().map(|s| s.pallet)).collect();
    numbers.sort();
    numbers.dedup();
    numbers
        .into_iter()
        .map(|n| {
            let r = records.iter().find(|r| r.number == n);
            let s = sums.iter().find(|s| s.pallet == n);
            PalletView {
                pallet: n,
                location: r.map(|r| r.location.clone()).unwrap_or_default(),
                closed: r.map(|r| r.closed).unwrap_or(false),
                note: r.map(|r| r.note.clone()).unwrap_or_default(),
                recorded: r.is_some(),
                boxes: s.map(|s| s.cases).unwrap_or(0),
                filled: s.map(|s| s.filled).unwrap_or(0),
                loose: s.map(|s| s.loose).unwrap_or(0),
                pairs: s.map(|s| s.pairs).unwrap_or(0),
                styles: s.map(|s| s.styles).unwrap_or(0),
                cost: s.map(|s| s.cost).unwrap_or(0.0),
                msrp: s.map(|s| s.msrp).unwrap_or(0.0),
                layers: r.map(|r| r.layers).unwrap_or(0),
                per_layer: r.map(|r| r.per_layer).unwrap_or(0),
            }
        })
        .collect()
}

/// The next pallet number: one more than any recorded or any with boxes on it.
pub fn next_pallet(records: &[PalletRecord], cases: &[Case]) -> i64 {
    records.iter().map(|r| r.number).chain(cases.iter().map(|c| c.pallet)).max().unwrap_or(0) + 1
}

/// "Pallet full" on pallet `number` starts the next pallet only when no later pallet already
/// stands open and empty, and only the first time (a retry after the pallet was already full
/// starts nothing). Otherwise a full on an older pallet, or a second tap, would leave stray
/// empty pallets.
pub fn should_start_next(records: &[PalletRecord], cases: &[Case], number: i64) -> bool {
    if records.iter().any(|r| r.number == number && r.closed) {
        return false;
    }
    !records.iter().any(|r| r.number > number && !r.closed && !cases.iter().any(|c| c.pallet == r.number))
}

// ---------------------------------------------------------------------------------------
// Counting: received against the manifest, and each pallet
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SizeCount {
    pub size: String,
    pub expected: i64,
    pub received: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LineCount {
    pub line_id: String,
    pub sizes: Vec<SizeCount>,
    pub expected: i64,
    pub received: i64,
    /// The pallets its pairs stand on, lowest first.
    pub pallets: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PalletSum {
    pub pallet: i64,
    /// Boxes on the pallet (loose rows are not boxes).
    pub cases: usize,
    /// R-554: boxes with at least one pair in them.
    pub filled: usize,
    pub pairs: i64,
    /// Pairs on the pallet with no box (R-535).
    pub loose: i64,
    pub styles: usize,
    pub cost: f64,
    pub msrp: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Totals {
    pub lines: usize,
    pub expected: i64,
    pub received: i64,
    /// Pairs short across every size (each size counted on its own, so an over in one size
    /// never hides a short in another).
    pub short: i64,
    pub over: i64,
    pub cases: usize,
    pub pallets: usize,
    pub cost: f64,
    pub msrp: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Tally {
    pub counts: Vec<LineCount>,
    pub pallets: Vec<PalletSum>,
    pub totals: Totals,
}

pub fn tally(lines: &[LoadLine], cases: &[Case]) -> Tally {
    let idx: HashMap<&str, usize> = lines.iter().enumerate().map(|(k, l)| (l.id.as_str(), k)).collect();
    let mut got: Vec<BTreeMap<String, i64>> = vec![BTreeMap::new(); lines.len()];
    let mut on: Vec<Vec<i64>> = vec![Vec::new(); lines.len()];
    let mut pallets: BTreeMap<i64, (PalletSum, Vec<usize>)> = BTreeMap::new();
    for c in cases {
        let p = pallets.entry(c.pallet).or_insert((PalletSum { pallet: c.pallet, cases: 0, filled: 0, pairs: 0, loose: 0, styles: 0, cost: 0.0, msrp: 0.0 }, Vec::new()));
        if !c.is_loose() {
            p.0.cases += 1;
            if c.contents.iter().any(|x| x.pairs > 0) {
                p.0.filled += 1;
            }
        }
        for x in &c.contents {
            let k = match idx.get(x.line_id.as_str()) {
                Some(k) => *k,
                None => continue,
            };
            *got[k].entry(x.size.clone()).or_insert(0) += x.pairs;
            if !on[k].contains(&c.pallet) {
                on[k].push(c.pallet);
            }
            p.0.pairs += x.pairs;
            if c.is_loose() {
                p.0.loose += x.pairs;
            }
            p.0.cost += x.pairs as f64 * lines[k].cost;
            p.0.msrp += x.pairs as f64 * lines[k].msrp;
            if !p.1.contains(&k) {
                p.1.push(k);
            }
        }
    }
    let mut totals = Totals { lines: lines.len(), cases: cases.iter().filter(|c| !c.is_loose()).count(), pallets: pallets.len(), ..Default::default() };
    let counts: Vec<LineCount> = lines
        .iter()
        .enumerate()
        .map(|(k, l)| {
            let sizes: Vec<SizeCount> = l.sizes.iter().map(|s| SizeCount { size: s.size.clone(), expected: s.qty, received: got[k].get(&s.size).copied().unwrap_or(0) }).collect();
            for s in &sizes {
                totals.short += (s.expected - s.received).max(0);
                totals.over += (s.received - s.expected).max(0);
            }
            let received: i64 = sizes.iter().map(|s| s.received).sum();
            totals.cost += received as f64 * l.cost;
            totals.msrp += received as f64 * l.msrp;
            let mut ps = on[k].clone();
            ps.sort();
            LineCount { line_id: l.id.clone(), expected: l.expected(), received, sizes, pallets: ps }
        })
        .collect();
    totals.expected = counts.iter().map(|c| c.expected).sum();
    totals.received = counts.iter().map(|c| c.received).sum();
    let pallets = pallets
        .into_values()
        .map(|(mut p, styles)| {
            p.styles = styles.len();
            p.cost = (p.cost * 100.0).round() / 100.0;
            p.msrp = (p.msrp * 100.0).round() / 100.0;
            p
        })
        .collect();
    totals.cost = (totals.cost * 100.0).round() / 100.0;
    totals.msrp = (totals.msrp * 100.0).round() / 100.0;
    Tally { counts, pallets, totals }
}

// ---------------------------------------------------------------------------------------
// Selling (R-519 phase 2): pairs leave a delivery through outs, never by editing a case
// ---------------------------------------------------------------------------------------
//
// An out (`warehouse_load_outs`, one row per order per delivery) lists the pairs an order took,
// by style and size. It is written once, after the invoice exists, and only ever marked undone
// (Put back): a set-once flag, so two devices pressing it agree. The cases stay what was
// received, so "Against the manifest" keeps meaning received against expected. What is left is
// always worked out here: received less every live out, never stored.

/// Styles and sizes one order takes at most, so one out row stays well inside a sync event.
pub const MAX_TAKES: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Out {
    pub id: String,
    #[serde(default)]
    pub invoice_id: String,
    /// The invoice number, or "" for a take with no invoice.
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub takes: Vec<Take>,
    #[serde(default)]
    pub pairs: i64,
    /// What the pairs cost (each pair at its line's cost when taken).
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub undone: bool,
    #[serde(default)]
    pub undone_at: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SizeLeft {
    pub size: String,
    pub received: i64,
    pub out: i64,
    pub left: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LineLeft {
    pub line_id: String,
    pub sizes: Vec<SizeLeft>,
    pub received: i64,
    pub out: i64,
    pub left: i64,
    /// The pallets its pairs stand on, lowest first.
    pub pallets: Vec<i64>,
}

/// More pairs out than were received: two devices sold the last pairs at once, or a case was
/// changed on a device that had not seen the sale. Shown, never hidden.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Oversold {
    pub line_id: String,
    pub size: String,
    pub over: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GroupLeft {
    pub brand: String,
    pub group: String,
    /// Styles in the group with pairs left.
    pub styles: usize,
    pub left: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Stock {
    pub lines: Vec<LineLeft>,
    /// Brand and group in manifest order.
    pub groups: Vec<GroupLeft>,
    pub received: i64,
    pub out: i64,
    pub left: i64,
    pub oversold: Vec<Oversold>,
    /// R-565: pairs sold by a count alone, no style named. In `out`, and off `left`.
    pub unnamed: i64,
    /// R-565: pairs sold that no box holds yet (cases not recorded): they come off as cases go in.
    pub not_boxed: i64,
}

/// Pairs an order took without naming a style: an invoice linked by its pair count (R-565).
pub fn unnamed_pairs(o: &Out) -> i64 {
    (o.pairs - o.takes.iter().map(|t| t.pairs.max(0)).sum::<i64>()).max(0)
}

fn out_by_line(lines: &[LoadLine], outs: &[Out]) -> Vec<BTreeMap<String, i64>> {
    let idx: HashMap<&str, usize> = lines.iter().enumerate().map(|(k, l)| (l.id.as_str(), k)).collect();
    let mut out: Vec<BTreeMap<String, i64>> = vec![BTreeMap::new(); lines.len()];
    for o in outs.iter().filter(|o| !o.undone) {
        for t in &o.takes {
            if let Some(k) = idx.get(t.line_id.as_str()) {
                *out[*k].entry(t.size.clone()).or_insert(0) += t.pairs.max(0);
            }
        }
    }
    out
}

/// What is left of every line and size: received (the cases) less every live out.
pub fn stock(lines: &[LoadLine], cases: &[Case], outs: &[Out]) -> Stock {
    let t = tally(lines, cases);
    let out = out_by_line(lines, outs);
    let mut s = Stock::default();
    for (k, l) in lines.iter().enumerate() {
        let c = &t.counts[k];
        let mut sizes: Vec<SizeLeft> = Vec::new();
        for z in &c.sizes {
            let o = out[k].get(&z.size).copied().unwrap_or(0);
            if o > z.received {
                s.oversold.push(Oversold { line_id: l.id.clone(), size: z.size.clone(), over: o - z.received });
            }
            sizes.push(SizeLeft { size: z.size.clone(), received: z.received, out: o, left: (z.received - o).max(0) });
        }
        let line = LineLeft {
            line_id: l.id.clone(),
            received: c.received,
            out: sizes.iter().map(|z| z.out).sum(),
            left: sizes.iter().map(|z| z.left).sum(),
            sizes,
            pallets: c.pallets.clone(),
        };
        s.received += line.received;
        s.out += line.out;
        s.left += line.left;
        let has = (line.left > 0) as usize;
        match s.groups.iter_mut().find(|g| g.brand == l.brand && g.group == l.group) {
            Some(g) => {
                g.left += line.left;
                g.styles += has;
            }
            None => s.groups.push(GroupLeft { brand: l.brand.clone(), group: l.group.clone(), styles: has, left: line.left }),
        }
        s.lines.push(line);
    }
    let in_boxes = s.left;
    s.unnamed = outs.iter().filter(|o| !o.undone).map(unnamed_pairs).sum();
    s.out += s.unnamed;
    s.left = (in_boxes - s.unnamed).max(0);
    s.not_boxed = s.oversold.iter().map(|o| o.over).sum::<i64>() + (s.unnamed - in_boxes).max(0);
    s
}

/// Pairs asked for and not there: what an order could not take.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TakeShort {
    pub line_id: String,
    pub size: String,
    pub asked: i64,
    pub taken: i64,
}

/// What an order asks for, checked and merged: unknown styles or sizes are refused, and the list
/// comes back in manifest order (line, then the line's own size order), so the same order always
/// plans the same way whatever order a screen sent it in.
fn asked_pairs(lines: &[LoadLine], asked: &[CaseLine]) -> Result<Vec<CaseLine>, String> {
    let mut want: Vec<CaseLine> = Vec::new();
    for a in asked {
        let line = lines.iter().find(|l| l.id == a.line_id).ok_or("A style in this order is no longer on the delivery.")?;
        let size = one_line(&a.size);
        if !line.sizes.iter().any(|s| s.size == size) {
            return Err(format!("{} {} has no size {size}.", line.style, line.color));
        }
        if a.pairs < 0 {
            return Err("An order cannot take fewer than 0 pairs.".into());
        }
        if a.pairs == 0 {
            continue;
        }
        match want.iter_mut().find(|x| x.line_id == a.line_id && x.size == size) {
            Some(x) => x.pairs += a.pairs,
            None => want.push(CaseLine { line_id: a.line_id.clone(), size, pairs: a.pairs }),
        }
    }
    if want.is_empty() {
        return Err("Pick at least one pair.".into());
    }
    if want.len() > MAX_TAKES {
        return Err(format!("More than {MAX_TAKES} styles and sizes in one order."));
    }
    let rank = |c: &CaseLine| {
        let k = lines.iter().position(|l| l.id == c.line_id).unwrap_or(usize::MAX);
        let z = lines.get(k).and_then(|l| l.sizes.iter().position(|s| s.size == c.size)).unwrap_or(usize::MAX);
        (k, z)
    };
    want.sort_by_key(rank);
    Ok(want)
}

/// What an order takes: every style and size asked for, as far as what is left goes, each pair
/// from a box named by the pick plan (R-554: `allocate`, so the pick list shown before the invoice
/// is what the order records). Unknown styles or sizes are refused; nothing goes below zero. A box
/// named in the request is not trusted: the plan is worked out again from what is left now.
/// With `over` (R-565, selling past what is boxed) what no box holds is taken too, naming no box,
/// and nothing comes back short; `stock` counts those pairs as `not_boxed` until their cases go in.
pub fn take(lines: &[LoadLine], cases: &[Case], records: &[PalletRecord], outs: &[Out], asked: &[Take], over: bool) -> Result<(Vec<Take>, Vec<TakeShort>), String> {
    let asked: Vec<CaseLine> = asked.iter().map(|t| CaseLine { line_id: t.line_id.clone(), size: t.size.clone(), pairs: t.pairs }).collect();
    let mut plan = allocate(lines, cases, records, outs, &asked)?;
    let mut taken: Vec<Take> = Vec::new();
    for b in &plan.boxes {
        for t in &b.takes {
            taken.push(Take { line_id: t.line_id.clone(), size: t.size.clone(), pairs: t.pairs, case_id: b.case_id.clone() });
        }
    }
    if over {
        for s in plan.short.drain(..) {
            taken.push(Take { line_id: s.line_id, size: s.size, pairs: s.asked - s.taken, case_id: String::new() });
        }
    }
    Ok((taken, plan.short))
}

/// What the taken pairs cost, each at its line's cost, to the cent.
pub fn takes_cost(lines: &[LoadLine], takes: &[Take]) -> f64 {
    let c: f64 = takes.iter().map(|t| t.pairs as f64 * lines.iter().find(|l| l.id == t.line_id).map(|l| l.cost).unwrap_or(0.0)).sum();
    (c * 100.0).round() / 100.0
}

/// A case change or removal is refused when it would leave fewer pairs than were already sold:
/// the sizes that would newly go below what is out. Empty means the change is fine.
pub fn newly_oversold(lines: &[LoadLine], cases_before: &[Case], cases_after: &[Case], outs: &[Out]) -> Vec<Oversold> {
    let before = stock(lines, cases_before, outs).oversold;
    stock(lines, cases_after, outs)
        .oversold
        .into_iter()
        .filter(|o| before.iter().find(|b| b.line_id == o.line_id && b.size == o.size).map(|b| o.over > b.over).unwrap_or(true))
        .collect()
}

/// "K100 RED size 7 (2 more sold than would be left)" for a refusal.
pub fn describe_oversold(lines: &[LoadLine], over: &[Oversold]) -> String {
    over.iter()
        .take(5)
        .map(|o| {
            let name = lines
                .iter()
                .find(|l| l.id == o.line_id)
                .map(|l| [l.style.as_str(), l.color.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            format!("{name} size {} ({} more sold than would be left)", o.size, o.over)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------------------
// Where to pick from (R-554 part 2): stock box by box, and the pick plan
// ---------------------------------------------------------------------------------------
//
// A take names the box its pairs came from (`Take.case_id`, written when the order is taken).
// What is left in a box is its contents less the takes that name it. Takes that name no box
// (every sale before R-554, or one from a device that had not updated) are charged to boxes in a
// fixed order, lowest pallet then lowest box, loose items last, and those boxes are `assumed`
// (count them), so the boxes always add up to what `stock` says is left. `allocate` chooses the
// boxes for an order and `take` records exactly that plan.

/// One style and size an order took, and the box (or loose items) it came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Take {
    pub line_id: String,
    pub size: String,
    pub pairs: i64,
    /// "" on a take made before R-554: it named no box.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub case_id: String,
}

/// One style and size in one box (or loose items), and what is left of it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoxLeft {
    pub case_id: String,
    pub line_id: String,
    pub size: String,
    pub left: i64,
    /// Pairs from an older sale that named no box were charged here: count this box.
    pub assumed: bool,
}

/// Boxes in the fixed order: lowest pallet, its boxes by number, then its loose items.
fn box_key(c: &Case) -> (i64, bool, i64, String) {
    (c.pallet, c.is_loose(), c.number, c.id.clone())
}

/// What is left in every box, style and size (rows with nothing left are kept, at 0).
pub fn box_stock(lines: &[LoadLine], cases: &[Case], outs: &[Out]) -> Vec<BoxLeft> {
    let known: BTreeSet<&str> = lines.iter().map(|l| l.id.as_str()).collect();
    let mut order: Vec<&Case> = cases.iter().collect();
    order.sort_by_key(|c| box_key(c));
    let mut rows: Vec<BoxLeft> = Vec::new();
    for c in &order {
        for x in c.contents.iter().filter(|x| x.pairs > 0 && known.contains(x.line_id.as_str())) {
            match rows.iter_mut().find(|r| r.case_id == c.id && r.line_id == x.line_id && r.size == x.size) {
                Some(r) => r.left += x.pairs,
                None => rows.push(BoxLeft { case_id: c.id.clone(), line_id: x.line_id.clone(), size: x.size.clone(), left: x.pairs, assumed: false }),
            }
        }
    }
    // Named takes come off their own box; what names no box (or more than the box holds) waits.
    let mut unnamed: BTreeMap<(String, String), i64> = BTreeMap::new();
    for o in outs.iter().filter(|o| !o.undone) {
        for t in o.takes.iter().filter(|t| t.pairs > 0) {
            let mut rest = t.pairs;
            if !t.case_id.is_empty() {
                if let Some(r) = rows.iter_mut().find(|r| r.case_id == t.case_id && r.line_id == t.line_id && r.size == t.size) {
                    let n = rest.min(r.left);
                    r.left -= n;
                    rest -= n;
                }
            }
            if rest > 0 {
                *unnamed.entry((t.line_id.clone(), t.size.clone())).or_insert(0) += rest;
            }
        }
    }
    for ((line_id, size), mut n) in unnamed {
        for r in rows.iter_mut().filter(|r| r.line_id == line_id && r.size == size) {
            if n == 0 {
                break;
            }
            let k = n.min(r.left);
            if k > 0 {
                r.left -= k;
                r.assumed = true;
                n -= k;
            }
        }
    }
    rows
}

/// One box (or a pallet's loose items) on a pick list, and what to take from it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PickBox {
    pub case_id: String,
    pub pallet: i64,
    /// The box's number on its pallet; 0 for loose items.
    pub number: i64,
    pub code: String,
    pub loose: bool,
    /// Where its pallet stands (its location, A3), "" when not said.
    pub location: String,
    /// Every pair still in it is taken: take the box as it is.
    pub whole: bool,
    /// Older sales were charged to this box by guess: count it before taking.
    pub assumed: bool,
    pub pairs: i64,
    pub takes: Vec<CaseLine>,
}

/// A pick list: the boxes to go to, pallet by pallet in the order they stand (A2 before A10),
/// what could not be found, and the totals.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Plan {
    pub boxes: Vec<PickBox>,
    pub short: Vec<TakeShort>,
    /// Pairs an older sale took without naming a box (a sold order's list only).
    pub unnamed: Vec<CaseLine>,
    pub pallets: usize,
    pub pairs: i64,
}

/// "A2" before "A10": text compared as text, runs of digits as numbers. An empty location last.
fn natural_key(s: &str) -> (bool, Vec<(String, u64)>) {
    let mut parts: Vec<(String, u64)> = Vec::new();
    let mut text = String::new();
    let mut num = String::new();
    for ch in s.trim().to_ascii_uppercase().chars() {
        if ch.is_ascii_digit() {
            if !text.is_empty() {
                parts.push((std::mem::take(&mut text), 0));
            }
            num.push(ch);
        } else {
            if !num.is_empty() {
                parts.push((String::new(), num.parse().unwrap_or(u64::MAX)));
                num.clear();
            }
            text.push(ch);
        }
    }
    if !text.is_empty() {
        parts.push((text, 0));
    }
    if !num.is_empty() {
        parts.push((String::new(), num.parse().unwrap_or(u64::MAX)));
    }
    (s.trim().is_empty(), parts)
}

/// The boxes of a plan in walking order: by where their pallet stands, then pallet, then box, loose last.
fn sort_pick(boxes: &mut [PickBox]) {
    boxes.sort_by(|a, b| (natural_key(&a.location), a.pallet, a.loose, a.number).cmp(&(natural_key(&b.location), b.pallet, b.loose, b.number)));
}

fn pick_box(c: &Case, records: &[PalletRecord], whole: bool, assumed: bool, takes: Vec<CaseLine>) -> PickBox {
    let location = records.iter().find(|r| r.number == c.pallet).map(|r| r.location.clone()).unwrap_or_default();
    PickBox {
        case_id: c.id.clone(),
        pallet: c.pallet,
        number: c.number,
        code: c.code.clone(),
        loose: c.is_loose(),
        location,
        whole,
        assumed,
        pairs: takes.iter().map(|t| t.pairs).sum(),
        takes,
    }
}

/// Which boxes to take an order from (R-554). First whole boxes: a box whose every pair left is
/// wanted is taken as it is, the pallets holding most of the order first, so the list has the
/// fewest stops. Then, style and size by style and size, loose items, then boxes already on the
/// list, then boxes on pallets already on the list, then the box holding most of it. What no box
/// holds comes back in `short`. A box charged by guess for an older sale is never taken whole.
pub fn allocate(lines: &[LoadLine], cases: &[Case], records: &[PalletRecord], outs: &[Out], asked: &[CaseLine]) -> Result<Plan, String> {
    let want = asked_pairs(lines, asked)?;
    let mut need: BTreeMap<(String, String), i64> = want.iter().map(|w| ((w.line_id.clone(), w.size.clone()), w.pairs)).collect();
    let mut left = box_stock(lines, cases, outs);
    let case_of = |id: &str| cases.iter().find(|c| c.id == id);
    let mut taken: Vec<(String, CaseLine)> = Vec::new();
    let mut used_boxes: BTreeSet<String> = BTreeSet::new();
    let mut used_pallets: BTreeSet<i64> = BTreeSet::new();

    // Whole boxes, pallets holding most of the order first.
    let mut score: BTreeMap<i64, i64> = BTreeMap::new();
    for r in &left {
        if let (Some(n), Some(c)) = (need.get(&(r.line_id.clone(), r.size.clone())), case_of(&r.case_id)) {
            *score.entry(c.pallet).or_insert(0) += r.left.min(*n);
        }
    }
    let mut boxes: Vec<&Case> = cases.iter().filter(|c| !c.is_loose()).collect();
    boxes.sort_by(|a, b| {
        let sa = score.get(&a.pallet).copied().unwrap_or(0);
        let sb = score.get(&b.pallet).copied().unwrap_or(0);
        sb.cmp(&sa).then(box_key(a).cmp(&box_key(b)))
    });
    for c in boxes {
        let items: Vec<&BoxLeft> = left.iter().filter(|r| r.case_id == c.id && r.left > 0).collect();
        if items.is_empty() || items.iter().any(|r| r.assumed) {
            continue;
        }
        if items.iter().all(|r| need.get(&(r.line_id.clone(), r.size.clone())).copied().unwrap_or(0) >= r.left) {
            for r in &items {
                *need.get_mut(&(r.line_id.clone(), r.size.clone())).unwrap() -= r.left;
                taken.push((c.id.clone(), CaseLine { line_id: r.line_id.clone(), size: r.size.clone(), pairs: r.left }));
            }
            used_boxes.insert(c.id.clone());
            used_pallets.insert(c.pallet);
        }
    }
    for (cid, t) in &taken {
        if let Some(r) = left.iter_mut().find(|r| &r.case_id == cid && r.line_id == t.line_id && r.size == t.size) {
            r.left -= t.pairs;
        }
    }

    // The rest, style and size by style and size.
    for w in &want {
        let key = (w.line_id.clone(), w.size.clone());
        let mut n = need.get(&key).copied().unwrap_or(0);
        if n <= 0 {
            continue;
        }
        let mut cands: Vec<usize> = (0..left.len()).filter(|&i| left[i].line_id == w.line_id && left[i].size == w.size && left[i].left > 0).collect();
        cands.sort_by(|&i, &j| {
            let (a, b) = (&left[i], &left[j]);
            let (ca, cb) = (case_of(&a.case_id), case_of(&b.case_id));
            let rank = |r: &BoxLeft, c: Option<&Case>| {
                let loose = c.map(|c| c.is_loose()).unwrap_or(false);
                let pallet = c.map(|c| c.pallet).unwrap_or(0);
                (!loose, !used_boxes.contains(&r.case_id), !used_pallets.contains(&pallet), std::cmp::Reverse(r.left))
            };
            rank(a, ca).cmp(&rank(b, cb)).then(ca.map(box_key).cmp(&cb.map(box_key)))
        });
        for i in cands {
            if n == 0 {
                break;
            }
            let k = n.min(left[i].left);
            left[i].left -= k;
            n -= k;
            taken.push((left[i].case_id.clone(), CaseLine { line_id: w.line_id.clone(), size: w.size.clone(), pairs: k }));
            used_boxes.insert(left[i].case_id.clone());
            if let Some(c) = case_of(&left[i].case_id) {
                used_pallets.insert(c.pallet);
            }
        }
        need.insert(key, n);
    }

    let mut plan = Plan::default();
    for w in &want {
        let n = need.get(&(w.line_id.clone(), w.size.clone())).copied().unwrap_or(0);
        if n > 0 {
            plan.short.push(TakeShort { line_id: w.line_id.clone(), size: w.size.clone(), asked: w.pairs, taken: w.pairs - n });
        }
    }
    let stock_left = box_stock(lines, cases, outs);
    for cid in taken.iter().map(|(c, _)| c.clone()).collect::<BTreeSet<_>>() {
        let Some(c) = case_of(&cid) else { continue };
        let mut takes: Vec<CaseLine> = Vec::new();
        for (_, t) in taken.iter().filter(|(c2, _)| *c2 == cid) {
            match takes.iter_mut().find(|x| x.line_id == t.line_id && x.size == t.size) {
                Some(x) => x.pairs += t.pairs,
                None => takes.push(t.clone()),
            }
        }
        let had: Vec<&BoxLeft> = stock_left.iter().filter(|r| r.case_id == cid && r.left > 0).collect();
        let whole = !c.is_loose() && had.iter().all(|r| takes.iter().any(|t| t.line_id == r.line_id && t.size == r.size && t.pairs >= r.left));
        let assumed = had.iter().any(|r| r.assumed);
        plan.boxes.push(pick_box(c, records, whole, assumed, takes));
    }
    sort_pick(&mut plan.boxes);
    plan.pallets = plan.boxes.iter().map(|b| b.pallet).collect::<BTreeSet<_>>().len();
    plan.pairs = plan.boxes.iter().map(|b| b.pairs).sum();
    Ok(plan)
}

/// The pick list of an order already taken, rebuilt from what it recorded: each box it named, where
/// that box stands now. Pairs it took without naming a box (before R-554) come back in `unnamed`.
pub fn out_pick(cases: &[Case], records: &[PalletRecord], out: &Out) -> Plan {
    let mut plan = Plan::default();
    let mut by: BTreeMap<String, Vec<CaseLine>> = BTreeMap::new();
    for t in out.takes.iter().filter(|t| t.pairs > 0) {
        let c = (!t.case_id.is_empty()).then(|| cases.iter().find(|c| c.id == t.case_id)).flatten();
        let into = match c {
            Some(c) => by.entry(c.id.clone()).or_default(),
            None => &mut plan.unnamed,
        };
        match into.iter_mut().find(|x| x.line_id == t.line_id && x.size == t.size) {
            Some(x) => x.pairs += t.pairs,
            None => into.push(CaseLine { line_id: t.line_id.clone(), size: t.size.clone(), pairs: t.pairs }),
        }
    }
    for (cid, takes) in by {
        let Some(c) = cases.iter().find(|c| c.id == cid) else { continue };
        let all: i64 = c.contents.iter().map(|x| x.pairs).sum();
        let got: i64 = takes.iter().map(|t| t.pairs).sum();
        plan.boxes.push(pick_box(c, records, !c.is_loose() && got >= all && all > 0, false, takes));
    }
    sort_pick(&mut plan.boxes);
    plan.pallets = plan.boxes.iter().map(|b| b.pallet).collect::<BTreeSet<_>>().len();
    plan.pairs = plan.boxes.iter().map(|b| b.pairs).sum::<i64>() + plan.unnamed.iter().map(|t| t.pairs).sum::<i64>();
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|s| s.to_string()).collect()
    }

    /// An invented manifest in the shape of a real one: a heading row with a "Size Scale"
    /// column, size headings above each style, group headings, a Total column.
    fn sample() -> Vec<Tab> {
        let head = row(&["Image", "Division", "Style", "Color", "Style Description", "Color Description", "Std Price", "MSRP", "Size Scale", "", "", "", "", "Total"]);
        let tab = Tab {
            name: "Acme Hash".into(),
            rows: vec![
                head,
                row(&["KIDS"]),
                row(&["", "", "", "", "", "", "", "", "XS", "S", "M", "L", ""]),
                row(&["", "AC", "K100", "RED", "Bootie\n\nin a gift box", "Red", "$10.50", "29.99", "", "4", "6", "", "", "10"]),
                row(&["", "", "", "", "", "", "", "", "5", "6", "7", "8", "9"]),
                row(&["", "AC", "K200", "BLK", "Runner", "Black", "12", "40", "1", "", "2", "", "", "3"]),
                row(&["WOMEN'S"]),
                row(&["", "", "", "", "", "", "", "", "5", "6", "7", "8", "9"]),
                row(&["", "AC", "W300", "TAN", "Boot", "Tan", "20", "60", "", "3", "", "", "1", "4"]),
                row(&[""]),
            ],
        };
        let totals = Tab {
            name: "Totals".into(),
            rows: vec![row(&["Inventory totals"]), row(&["Brand", "SKU's", "Total Pairs"]), row(&["Acme", "3", "17"]), row(&["Totals", "3", "17"])],
        };
        vec![totals, tab]
    }

    #[test]
    fn a_size_grid_manifest_reads_every_style_with_its_own_scale() {
        let m = read_manifest(&sample());
        assert_eq!(m.lines.len(), 3);
        let a = &m.lines[0];
        assert_eq!((a.brand.as_str(), a.group.as_str(), a.style.as_str(), a.color.as_str()), ("Acme Hash", "KIDS", "K100", "RED"));
        assert_eq!(a.description, "Bootie in a gift box");
        assert_eq!((a.cost, a.msrp), (10.5, 29.99));
        assert_eq!(a.sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("XS", 0), ("S", 4), ("M", 6), ("L", 0)]);
        assert_eq!(m.lines[1].sizes.iter().map(|s| s.size.as_str()).collect::<Vec<_>>(), vec!["5", "6", "7", "8", "9"]);
        assert_eq!(m.lines[2].group, "WOMEN'S");
        assert_eq!(m.pairs, 17);
        assert_eq!(m.stated, Some(Stated { tab: "Totals".into(), lines: Some(3), pairs: 17 }));
        assert_eq!(m.tabs.iter().map(|t| t.read).collect::<Vec<_>>(), vec![false, true]);
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
        assert_eq!(m.groups.len(), 2);
    }

    #[test]
    fn a_total_that_disagrees_with_its_sizes_is_named_not_chosen() {
        let mut tabs = sample();
        tabs[1].rows[3][13] = "12".into();
        let m = read_manifest(&tabs);
        assert_eq!(m.mismatches.len(), 1);
        assert_eq!((m.mismatches[0].sizes, m.mismatches[0].total), (10, 12));
        assert_eq!(m.lines[0].expected(), 10);
        assert_eq!(m.lines[0].sheet_total, 12);
    }

    #[test]
    fn sizes_named_on_the_heading_row_are_the_grid() {
        let tabs = vec![Tab {
            name: "Sheet1".into(),
            rows: vec![row(&["Style", "Color", "Cost", "7", "8", "9", "Total"]), row(&["A1", "Blue", "5", "1", "2", "", "3"])],
        }];
        let m = read_manifest(&tabs);
        assert_eq!(m.lines.len(), 1);
        assert_eq!(m.lines[0].sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("7", 1), ("8", 2), ("9", 0)]);
        assert!(m.mismatches.is_empty());
    }

    #[test]
    fn a_case_is_checked_against_the_lines() {
        let lines = read_manifest(&sample()).lines;
        let id = lines[0].id.clone();
        let ok = clean_contents(&lines, &[
            CaseLine { line_id: id.clone(), size: "S".into(), pairs: 2 },
            CaseLine { line_id: id.clone(), size: "S".into(), pairs: 1 },
            CaseLine { line_id: id.clone(), size: "M".into(), pairs: 0 },
        ])
        .unwrap();
        assert_eq!(ok, vec![CaseLine { line_id: id.clone(), size: "S".into(), pairs: 3 }]);
        assert!(clean_contents(&lines, &[CaseLine { line_id: id.clone(), size: "XXL".into(), pairs: 1 }]).is_err());
        assert!(clean_contents(&lines, &[CaseLine { line_id: "gone".into(), size: "S".into(), pairs: 1 }]).is_err());
        assert!(clean_contents(&lines, &[CaseLine { line_id: id.clone(), size: "S".into(), pairs: -1 }]).is_err());
        assert!(clean_contents(&lines, &[]).is_err());
    }

    #[test]
    fn received_is_the_sum_of_the_cases_and_shorts_never_hide_behind_overs() {
        let lines = read_manifest(&sample()).lines;
        let (a, b) = (lines[0].id.clone(), lines[1].id.clone());
        let cases = vec![
            Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![CaseLine { line_id: a.clone(), size: "S".into(), pairs: 4 }, CaseLine { line_id: a.clone(), size: "L".into(), pairs: 2 }], ..Default::default() },
            Case { id: "c2".into(), pallet: 2, number: 1, contents: vec![CaseLine { line_id: a.clone(), size: "M".into(), pairs: 3 }, CaseLine { line_id: b.clone(), size: "5".into(), pairs: 1 }], ..Default::default() },
        ];
        let t = tally(&lines, &cases);
        assert_eq!((t.counts[0].expected, t.counts[0].received), (10, 9));
        assert_eq!(t.counts[0].pallets, vec![1, 2]);
        // K100: M short 3, L over 2. K200: 7 short 2. W300: short 4.
        assert_eq!((t.totals.short, t.totals.over), (3 + 2 + 4, 2));
        assert_eq!((t.totals.expected, t.totals.received), (17, 10));
        assert_eq!(t.pallets.len(), 2);
        assert_eq!((t.pallets[0].pairs, t.pallets[0].styles, t.pallets[0].cost), (6, 1, 63.0));
        assert_eq!((t.pallets[1].pairs, t.pallets[1].styles), (4, 2));
        assert_eq!(t.totals.cases, 2);
        assert_eq!(next_number(&cases, 1, ""), 2);
        assert_eq!(next_number(&cases, 1, "c1"), 1);
        assert_eq!(next_number(&cases, 5, ""), 1);
    }

    /// An order that took these pairs naming no box, as every order before R-554 did.
    fn sold(id: &str, takes: Vec<CaseLine>) -> Out {
        sold_t(id, takes.into_iter().map(|t| Take { line_id: t.line_id, size: t.size, pairs: t.pairs, case_id: String::new() }).collect())
    }
    fn sold_t(id: &str, takes: Vec<Take>) -> Out {
        Out { id: id.into(), pairs: takes.iter().map(|t| t.pairs).sum(), takes, ..Default::default() }
    }
    fn tk(line: &str, size: &str, pairs: i64, case_id: &str) -> Take {
        Take { line_id: line.into(), size: size.into(), pairs, case_id: case_id.into() }
    }
    fn cl(line: &str, size: &str, pairs: i64) -> CaseLine {
        CaseLine { line_id: line.into(), size: size.into(), pairs }
    }

    #[test]
    fn an_out_takes_pairs_off_what_is_left_and_a_put_back_returns_them() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "S", 4), cl(&a, "M", 6)], ..Default::default() }];
        let (taken, short) = take(&lines, &cases, &[], &[], &[tk(&a, "S", 3, ""), tk(&a, "M", 9, "")], false).unwrap();
        assert_eq!(taken, vec![tk(&a, "S", 3, "c1"), tk(&a, "M", 6, "c1")]);
        assert_eq!(short, vec![TakeShort { line_id: a.clone(), size: "M".into(), asked: 9, taken: 6 }]);
        assert_eq!(takes_cost(&lines, &taken), 94.5);
        let mut outs = vec![sold_t("o1", taken)];
        let s = stock(&lines, &cases, &outs);
        assert_eq!((s.received, s.out, s.left), (10, 9, 1));
        assert_eq!(s.lines[0].sizes.iter().map(|z| (z.size.as_str(), z.left)).collect::<Vec<_>>(), vec![("XS", 0), ("S", 1), ("M", 0), ("L", 0)]);
        assert_eq!(s.groups[0], GroupLeft { brand: "Acme Hash".into(), group: "KIDS".into(), styles: 1, left: 1 });
        assert_eq!(s.groups.iter().map(|g| g.left).sum::<i64>(), s.left);
        // Nothing left in M: a second order gets none of it.
        let (taken2, short2) = take(&lines, &cases, &[], &outs, &[tk(&a, "M", 1, "")], false).unwrap();
        assert!(taken2.is_empty());
        assert_eq!(short2[0].taken, 0);
        outs[0].undone = true;
        assert_eq!(stock(&lines, &cases, &outs).left, 10);
        // What was received never moves.
        assert_eq!(tally(&lines, &cases).totals.received, 10);
        assert!(take(&lines, &cases, &[], &[], &[tk(&a, "XXL", 1, "")], false).is_err());
        assert!(take(&lines, &cases, &[], &[], &[], false).is_err());
    }

    /// R-565: selling past what is boxed. The rest is taken naming no box, counted as not boxed,
    /// and comes off the boxes once its case is recorded.
    #[test]
    fn an_order_can_sell_past_the_boxes_and_the_case_recorded_later_covers_it() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "M", 6)], ..Default::default() }];
        let (taken, short) = take(&lines, &cases, &[], &[], &[tk(&a, "M", 9, ""), tk(&a, "S", 4, "")], true).unwrap();
        assert!(short.is_empty());
        assert_eq!(taken, vec![tk(&a, "M", 6, "c1"), tk(&a, "S", 4, ""), tk(&a, "M", 3, "")]);
        let outs = vec![sold_t("o1", taken)];
        let s = stock(&lines, &cases, &outs);
        assert_eq!((s.received, s.out, s.left, s.not_boxed, s.unnamed), (6, 13, 0, 7, 0));
        // The rest of the truck goes in: the sale is covered, nothing is oversold.
        let mut later = cases.clone();
        later.push(Case { id: "c2".into(), pallet: 2, number: 1, contents: vec![cl(&a, "M", 5), cl(&a, "S", 4)], ..Default::default() });
        let s = stock(&lines, &later, &outs);
        assert_eq!((s.received, s.out, s.left, s.not_boxed), (15, 13, 2, 0));
        assert!(newly_oversold(&lines, &cases, &later, &outs).is_empty());
    }

    /// R-565: an invoice linked by its pair count alone names no style: it comes off the total.
    #[test]
    fn an_order_linked_by_a_pair_count_comes_off_the_total() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "S", 4), cl(&a, "M", 6)], ..Default::default() }];
        let count = Out { id: "o1".into(), pairs: 7, ..Default::default() };
        assert_eq!(unnamed_pairs(&count), 7);
        assert_eq!(unnamed_pairs(&sold("o2", vec![cl(&a, "S", 2)])), 0);
        let mut outs = vec![count, sold("o2", vec![cl(&a, "S", 2)])];
        let s = stock(&lines, &cases, &outs);
        assert_eq!((s.received, s.out, s.left, s.unnamed, s.not_boxed), (10, 9, 1, 7, 0));
        outs[0].pairs = 20;
        let s = stock(&lines, &cases, &outs);
        assert_eq!((s.out, s.left, s.not_boxed), (22, 0, 12));
        outs[0].undone = true;
        assert_eq!(stock(&lines, &cases, &outs).left, 8);
    }

    /// R-554: two lines, three pallets. Pallet 1 at A10: box 1 all K100 S, box 2 K100 S and M.
    /// Pallet 2 at A2: box 1 K200, loose K100 S. Pallet 3 (no location): box 1 K100 M.
    fn yard() -> (Vec<LoadLine>, Vec<Case>, Vec<PalletRecord>) {
        let lines = read_manifest(&sample()).lines;
        let (a, b) = (lines[0].id.clone(), lines[1].id.clone());
        let c = |id: &str, pallet: i64, number: i64, kind: &str, contents: Vec<CaseLine>| Case {
            id: id.into(), pallet, number, contents, kind: kind.into(), code: if kind == "loose" { String::new() } else { format!("P{pallet}-{number}") }, ..Default::default()
        };
        let cases = vec![
            c("p1b1", 1, 1, "box", vec![cl(&a, "S", 6)]),
            c("p1b2", 1, 2, "box", vec![cl(&a, "S", 2), cl(&a, "M", 4)]),
            c("p2b1", 2, 1, "box", vec![cl(&b, "7", 5)]),
            c("p2l", 2, 0, "loose", vec![cl(&a, "S", 3)]),
            c("p3b1", 3, 1, "box", vec![cl(&a, "M", 8)]),
        ];
        let records = vec![
            PalletRecord { number: 1, location: "A10".into(), ..Default::default() },
            PalletRecord { number: 2, location: "A2".into(), ..Default::default() },
        ];
        (lines, cases, records)
    }

    #[test]
    fn the_pick_plan_takes_whole_boxes_first_then_loose_then_the_fewest_boxes() {
        let (lines, cases, records) = yard();
        let (a, b) = (lines[0].id.clone(), lines[1].id.clone());
        // 6 of S and 5 of K200: box p1b1 whole (all its 6 S) and p2b1 whole.
        let p = allocate(&lines, &cases, &records, &[], &[cl(&a, "S", 6), cl(&b, "7", 5)]).unwrap();
        let rows: Vec<(&str, bool, i64)> = p.boxes.iter().map(|x| (x.case_id.as_str(), x.whole, x.pairs)).collect();
        // Walking order: A2 before A10.
        assert_eq!(rows, vec![("p2b1", true, 5), ("p1b1", true, 6)]);
        assert_eq!((p.pallets, p.pairs, p.short.len()), (2, 11, 0));
        assert_eq!((p.boxes[0].location.as_str(), p.boxes[0].code.as_str()), ("A2", "P2-1"));
        // 4 of S: no box is wholly wanted, so loose items first (3), then the box with most (p1b1).
        let p = allocate(&lines, &cases, &records, &[], &[cl(&a, "S", 4)]).unwrap();
        let rows: Vec<(&str, bool, bool, i64)> = p.boxes.iter().map(|x| (x.case_id.as_str(), x.loose, x.whole, x.pairs)).collect();
        assert_eq!(rows, vec![("p2l", true, false, 3), ("p1b1", false, false, 1)]);
        // More than there is: what no box holds is short.
        let p = allocate(&lines, &cases, &records, &[], &[cl(&a, "M", 20)]).unwrap();
        assert_eq!(p.short, vec![TakeShort { line_id: a.clone(), size: "M".into(), asked: 20, taken: 12 }]);
        // The pallet without a location goes last.
        assert_eq!(p.boxes.last().map(|x| (x.case_id.as_str(), x.location.as_str())), Some(("p3b1", "")));
        // The same order in any order plans the same way.
        let x = allocate(&lines, &cases, &records, &[], &[cl(&b, "7", 2), cl(&a, "S", 4)]).unwrap();
        let y = allocate(&lines, &cases, &records, &[], &[cl(&a, "S", 1), cl(&a, "S", 3), cl(&b, "7", 2)]).unwrap();
        assert_eq!(x, y);
        assert!(allocate(&lines, &cases, &records, &[], &[cl(&a, "XXL", 1)]).is_err());
    }

    #[test]
    fn boxes_add_up_to_what_is_left_and_older_sales_are_charged_in_a_fixed_order() {
        let (lines, cases, records) = yard();
        let a = lines[0].id.clone();
        // An order taken now names its boxes; the box view and the delivery view agree.
        let (taken, _) = take(&lines, &cases, &records, &[], &[tk(&a, "S", 7, "")], false).unwrap();
        assert!(taken.iter().all(|t| !t.case_id.is_empty()));
        // An older sale named no box: 4 of S charged to the lowest pallet's first box.
        let outs = vec![sold_t("new", taken), sold("old", vec![cl(&a, "S", 4)])];
        let bs = box_stock(&lines, &cases, &outs);
        let st = stock(&lines, &cases, &outs);
        for l in &st.lines {
            for z in &l.sizes {
                let sum: i64 = bs.iter().filter(|r| r.line_id == l.line_id && r.size == z.size).map(|r| r.left).sum();
                assert_eq!(sum, z.left, "{} {}", l.line_id, z.size);
            }
        }
        assert!(bs.iter().any(|r| r.assumed));
        // A box charged by guess is never offered whole.
        let p = allocate(&lines, &cases, &records, &outs, &[cl(&a, "S", 1)]).unwrap();
        assert!(p.boxes.iter().all(|x| !x.whole || !x.assumed));
        // Put back frees the named pairs in both views.
        let mut back = outs.clone();
        back[0].undone = true;
        back[1].undone = true;
        let bs = box_stock(&lines, &cases, &back);
        assert_eq!(bs.iter().filter(|r| r.line_id == a && r.size == "S").map(|r| r.left).sum::<i64>(), 11);
        assert!(bs.iter().all(|r| !r.assumed));
    }

    #[test]
    fn a_sold_orders_pick_list_is_rebuilt_from_the_boxes_it_named() {
        let (lines, cases, records) = yard();
        let (a, b) = (lines[0].id.clone(), lines[1].id.clone());
        let (taken, _) = take(&lines, &cases, &records, &[], &[tk(&a, "S", 6, ""), tk(&b, "7", 2, "")], false).unwrap();
        let o = sold_t("o", taken);
        let p = out_pick(&cases, &records, &o);
        assert_eq!(p.boxes.iter().map(|x| (x.case_id.as_str(), x.whole, x.pairs)).collect::<Vec<_>>(), vec![("p2b1", false, 2), ("p1b1", true, 6)]);
        assert_eq!((p.pairs, p.pallets, p.unnamed.len()), (8, 2, 0));
        // An older order shows what it took without a box.
        let p = out_pick(&cases, &records, &sold("old", vec![cl(&a, "M", 3)]));
        assert_eq!((p.boxes.len(), p.unnamed, p.pairs), (0, vec![cl(&a, "M", 3)], 3));
        // An old row deserializes with no box named, and a named take keeps its box.
        let t: Take = serde_json::from_str(r#"{"line_id":"x","size":"7","pairs":2}"#).unwrap();
        assert_eq!(t.case_id, "");
        assert_eq!(serde_json::to_string(&tk("x", "7", 2, "")).unwrap(), r#"{"line_id":"x","size":"7","pairs":2}"#);
        assert!(serde_json::to_string(&tk("x", "7", 2, "b1")).unwrap().contains(r#""case_id":"b1""#));
        // A2 before A10, and an empty location last.
        let mut locs = vec!["A10", "", "A2", "B1", "a3"];
        locs.sort_by_key(|l| natural_key(l));
        assert_eq!(locs, vec!["A2", "a3", "A10", "B1", ""]);
    }

    #[test]
    fn two_orders_racing_for_the_last_pairs_show_as_oversold_never_negative() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "S", 2)], ..Default::default() }];
        let outs = vec![sold("o1", vec![cl(&a, "S", 2)]), sold("o2", vec![cl(&a, "S", 2)])];
        let s = stock(&lines, &cases, &outs);
        assert_eq!(s.left, 0);
        assert_eq!(s.oversold, vec![Oversold { line_id: a.clone(), size: "S".into(), over: 2 }]);
    }

    #[test]
    fn a_case_change_that_would_undercut_a_sale_is_named() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let before = vec![Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "S", 4)], ..Default::default() }];
        let outs = vec![sold("o1", vec![cl(&a, "S", 3)])];
        let mut after = before.clone();
        after[0].contents[0].pairs = 2;
        let bad = newly_oversold(&lines, &before, &after, &outs);
        assert_eq!(bad, vec![Oversold { line_id: a.clone(), size: "S".into(), over: 1 }]);
        assert!(describe_oversold(&lines, &bad).contains("K100 RED size S"));
        after[0].contents[0].pairs = 3;
        assert!(newly_oversold(&lines, &before, &after, &outs).is_empty());
        assert_eq!(newly_oversold(&lines, &before, &[], &outs).len(), 1);
    }

    #[test]
    fn loose_items_count_as_pairs_not_boxes_and_take_no_box_number() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![
            Case { id: "b1".into(), pallet: 2, number: 1, contents: vec![cl(&a, "S", 4)], ..Default::default() },
            Case { id: "l1".into(), pallet: 2, number: 0, kind: "loose".into(), contents: vec![cl(&a, "M", 3)], ..Default::default() },
        ];
        let t = tally(&lines, &cases);
        assert_eq!((t.totals.cases, t.totals.received), (1, 7));
        assert_eq!((t.pallets[0].cases, t.pallets[0].pairs, t.pallets[0].loose), (1, 7, 3));
        assert_eq!(next_number(&cases, 2, ""), 2);
        // Selling counts loose pairs like any box's.
        assert_eq!(stock(&lines, &cases, &[]).left, 7);
    }

    #[test]
    fn pallets_are_records_or_known_through_their_boxes() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![Case { id: "b1".into(), pallet: 3, number: 1, contents: vec![cl(&a, "S", 4)], ..Default::default() }];
        let records = vec![
            PalletRecord { id: pallet_id("L", 1), number: 1, location: "Dock door".into(), ..Default::default() },
            PalletRecord { id: pallet_id("L", 3), number: 3, location: "A2".into(), closed: true, ..Default::default() },
        ];
        let v = pallet_views(&records, &tally(&lines, &cases).pallets);
        assert_eq!(v.iter().map(|p| (p.pallet, p.location.as_str(), p.recorded, p.closed, p.pairs)).collect::<Vec<_>>(),
            vec![(1, "Dock door", true, false, 0), (3, "A2", true, true, 4)]);
        let v2 = pallet_views(&[], &tally(&lines, &cases).pallets);
        assert_eq!((v2[0].pallet, v2[0].recorded, v2[0].location.as_str()), (3, false, ""));
        assert_eq!(next_pallet(&records, &cases), 4);
        // Pallet full on 1 starts nothing while 2 stands open and empty; a retry on a full pallet neither.
        let open2 = vec![PalletRecord { number: 1, ..Default::default() }, PalletRecord { number: 2, ..Default::default() }];
        assert!(!should_start_next(&open2, &[], 1));
        assert!(should_start_next(&open2, &[], 2));
        let full1 = vec![PalletRecord { number: 1, closed: true, ..Default::default() }];
        assert!(!should_start_next(&full1, &[], 1));
        assert!(should_start_next(&[PalletRecord { number: 1, ..Default::default() }], &[], 1));
        assert_eq!(next_pallet(&[], &[]), 1);
        assert_eq!(pallet_id("L", 7), "pal-L-7");
        assert_eq!(clean_location("  Row  B,\n spot 4 "), "Row B, spot 4");
        assert_eq!(clean_location(&"x".repeat(60)).chars().count(), MAX_LOCATION);
    }

    #[test]
    fn boxes_can_be_counted_on_before_they_are_filled_and_carry_their_code() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        // A new box needs a pair; a box that exists may hold nothing.
        assert!(clean_contents(&lines, &[]).is_err());
        assert!(clean_contents(&lines, &[cl(&a, "S", 0)]).is_err());
        assert_eq!(clean_filling(&lines, &[]).unwrap(), vec![]);
        assert_eq!(clean_filling(&lines, &[cl(&a, "S", 0)]).unwrap(), vec![]);
        assert_eq!(clean_filling(&lines, &[cl(&a, "S", 2), cl(&a, "S", 1)]).unwrap(), vec![cl(&a, "S", 3)]);
        assert!(clean_filling(&lines, &[cl(&a, "XXL", 1)]).is_err());
        // Empty boxes are boxes, not pairs, and not filled.
        let cases = vec![
            Case { id: "b1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "S", 4)], code: "A1-1".into(), ..Default::default() },
            Case { id: "b2".into(), pallet: 1, number: 2, code: "A1-2".into(), ..Default::default() },
            Case { id: "b3".into(), pallet: 1, number: 3, ..Default::default() },
            Case { id: "l1".into(), pallet: 1, kind: "loose".into(), contents: vec![cl(&a, "M", 2)], ..Default::default() },
        ];
        let t = tally(&lines, &cases);
        assert_eq!((t.pallets[0].cases, t.pallets[0].filled, t.pallets[0].pairs, t.totals.received), (3, 1, 6, 6));
        assert_eq!(stock(&lines, &cases, &[]).left, 6);
        assert_eq!(next_number(&cases, 1, ""), 4);
        let rec = vec![PalletRecord { id: pallet_id("L", 1), number: 1, location: "A1".into(), layers: 4, per_layer: 6, ..Default::default() }];
        let v = pallet_views(&rec, &t.pallets);
        assert_eq!((v[0].boxes, v[0].filled, v[0].layers, v[0].per_layer), (3, 1, 4, 6));
        // An old box with no code reads as one with an empty code.
        let old: Case = serde_json::from_str(r#"{"id":"x","pallet":1,"number":1}"#).unwrap();
        assert_eq!(old.code, "");
        // Codes: the pallet's short name and the box's number.
        assert_eq!(pallet_label("A3", 7), "A3");
        assert_eq!(pallet_label(" B-12 ", 7), "B-12");
        assert_eq!(pallet_label("", 7), "P7");
        assert_eq!(pallet_label("Back by the office", 2), "P2");
        assert_eq!(pallet_label("ABCDEFGHI", 2), "P2");
        assert_eq!(box_code("A3", 7), "A3-7");
        assert_eq!(clean_code("  a3 - 7\n"), "a3 - 7");
        assert_eq!(clean_code(&"x".repeat(30)).chars().count(), MAX_CODE);
        // Setting boxes up: 4 rows of 6 hold 19 to 24, never fewer than are on it.
        assert!(check_box_setup("A3", 4, 6, 24, 0).is_ok());
        assert!(check_box_setup("A3", 4, 6, 19, 0).is_ok());
        assert!(check_box_setup("A3", 4, 6, 18, 0).unwrap_err().contains("19 to 24"));
        assert!(check_box_setup("A3", 4, 6, 25, 0).is_err());
        assert!(check_box_setup("A3", 1, 1, 1, 0).is_ok());
        assert!(check_box_setup("A3", 1, 6, 6, 0).is_ok());
        assert!(check_box_setup("A3", 2, 6, 7, 8).unwrap_err().contains("A3 already has 8 boxes"));
        assert!(check_box_setup("A3", 0, 6, 6, 0).is_err());
        assert!(check_box_setup("A3", 3, 0, 1, 0).is_err());
        assert!(check_box_setup("A3", 30, 40, 1200, 0).unwrap_err().contains("at most 300"));
    }

    #[test]
    fn lines_are_cleaned_before_they_are_stored() {
        let mut lines = read_manifest(&sample()).lines;
        lines.push(LoadLine { id: lines[0].id.clone(), style: " X9 ".into(), sizes: parse_sizes("5, 6 6,7"), ..Default::default() });
        lines.push(LoadLine { id: "blank".into(), style: "  ".into(), ..Default::default() });
        let out = clean_lines(lines).unwrap();
        assert_eq!(out.len(), 4);
        assert_eq!(out[3].id, format!("{}-2", out[0].id));
        assert_eq!(out[3].style, "X9");
        assert_eq!(out[3].sizes.len(), 3);
        assert!(clean_lines(vec![LoadLine { id: "a".into(), style: "A".into(), ..Default::default() }]).is_err());
    }

    #[test]
    fn a_csv_reads_as_one_tab() {
        let tabs = read_tabs("load.csv", b"Style,Color,7,8,Total\nA1,Red,1,2,3\n").unwrap();
        assert_eq!(tabs.len(), 1);
        let m = read_manifest(&tabs);
        assert_eq!(m.pairs, 3);
    }

    #[test]
    fn each_tab_says_what_it_is_and_half_sizes_read() {
        let mut tabs = sample();
        tabs[1].rows.push(row(&["", "", "", "", "", "", "", "", "7", "7\u{bd}", "8", "8 1/2", ""]));
        tabs[1].rows.push(row(&["", "AC", "W400", "GRY", "Flat", "Grey", "15", "45", "1", "2", "", "3", "", "6"]));
        tabs.push(Tab { name: "Notes".into(), rows: vec![row(&["Call the carrier"])] });
        let m = read_manifest(&tabs);
        let kinds: Vec<(&str, &str, &str)> = m.tabs.iter().map(|t| (t.name.as_str(), t.kind.as_str(), t.layout.as_str())).collect();
        assert_eq!(kinds, vec![("Totals", "totals", ""), ("Acme Hash", "items", "above"), ("Notes", "other", "")]);
        let w = m.lines.iter().find(|l| l.style == "W400").unwrap();
        assert_eq!(w.sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("7", 1), ("7\u{bd}", 2), ("8", 0), ("8 1/2", 3)]);
        assert_eq!(m.tabs[1].samples, vec!["t2r4", "t2r6", "t2r9"]);
        assert!(m.lines.iter().all(|l| l.sheet == "Acme Hash" && l.image.is_empty()));
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    }

    #[test]
    fn a_row_of_quantities_with_no_style_never_becomes_the_sizes() {
        let mut tabs = sample();
        // Under W300 (sizes 5 to 9): a subtotal row with no label, then a style sharing W300's sizes.
        tabs[1].rows.insert(9, row(&["", "", "", "", "", "", "", "", "24", "36", "108", "", ""]));
        tabs[1].rows.insert(10, row(&["", "AC", "W301", "TAN", "Boot", "Tan", "20", "60", "1", "", "", "", "", "1"]));
        let m = read_manifest(&tabs);
        let w = m.lines.iter().find(|l| l.style == "W301").unwrap();
        assert_eq!(w.sizes[0], SizeQty { size: "5".into(), qty: 1 });
        assert_eq!(m.tabs[1].warnings.len(), 1);
        assert!(m.tabs[1].warnings[0].contains("row 10") && m.tabs[1].warnings[0].contains("not size names"));
    }

    #[test]
    fn a_size_named_twice_is_counted_as_written_and_named() {
        let tabs = vec![Tab {
            name: "Lamo".into(),
            rows: vec![row(&["Style", "Color", "Size Scale", "", "", "Total"]), row(&["", "", "5", "6", "6", ""]), row(&["E1", "BLK", "1", "2", "3", "6"])],
        }];
        let m = read_manifest(&tabs);
        assert_eq!(m.lines[0].sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("5", 1), ("6", 5)]);
        assert!(m.mismatches.is_empty());
        assert_eq!(m.warnings.len(), 1);
        assert!(m.warnings[0].contains("size 6 is named twice"));
    }

    #[test]
    fn one_size_a_row_gathers_a_style_into_one_line() {
        let tabs = vec![Tab {
            name: "Boots".into(),
            rows: vec![
                row(&["Style", "Color", "Description", "Size", "Qty", "Cost"]),
                row(&["B1", "BLK", "Boot", "7", "2", "10"]),
                row(&["B1", "BLK", "Boot", "8", "3", "10"]),
                row(&["B1", "TAN", "Boot", "7", "1", "10"]),
                row(&["B1", "BLK", "Boot", "7", "1", "10"]),
                row(&["B2", "RED", "Clog", "S", "4", "6"]),
            ],
        }];
        let (m, rows) = read_manifest_rows(&tabs);
        assert_eq!(m.tabs[0].layout, "column");
        let got: Vec<(&str, &str, Vec<(&str, i64)>)> = m.lines.iter().map(|l| (l.style.as_str(), l.color.as_str(), l.sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect())).collect();
        assert_eq!(got, vec![("B1", "BLK", vec![("7", 3), ("8", 3)]), ("B1", "TAN", vec![("7", 1)]), ("B2", "RED", vec![("S", 4)])]);
        assert_eq!(m.lines[0].id, "t1r2");
        assert_eq!(m.lines[0].sheet_total, 6);
        assert_eq!(m.lines[0].cost, 10.0);
        assert_eq!(m.pairs, 11);
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
        // Every row of a style leads to its line, so a picture on any of them finds it.
        assert_eq!(rows.get(&(0, 5)).map(String::as_str), Some("t1r2"));
        assert_eq!(rows.get(&(0, 4)).map(String::as_str), Some("t1r4"));
    }

    #[test]
    fn a_page_that_repeats_all_the_others_is_a_master_list_left_out() {
        let page = |name: &str, styles: &[&str]| Tab {
            name: name.into(),
            rows: std::iter::once(row(&["Style", "Color", "7", "8", "Total"])).chain(styles.iter().map(|s| row(&[s, "BLK", "1", "1", "2"]))).collect(),
        };
        let m = read_manifest(&[page("All", &["A", "B", "C"]), page("Brand 1", &["A", "B"]), page("Brand 2", &["C"])]);
        assert_eq!(m.tabs.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), vec!["copy", "items", "items"]);
        assert_eq!(m.lines.len(), 6);
        assert_eq!(m.pairs, 6);
        assert_eq!(m.groups.iter().map(|g| g.lines).sum::<usize>(), 3);
        // Two pages the same are both items (named in the warnings): see two_pages_the_same_are_named.
        // Pages that only share some styles are both items.
        let m = read_manifest(&[page("One", &["A", "B"]), page("Two", &["A"])]);
        assert_eq!(m.tabs.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), vec!["items", "items"]);
    }

    /// An invented .xlsx holding only what the picture reader opens: the workbook, its links, one
    /// drawing and its images.
    fn picture_book() -> Vec<u8> {
        use std::io::Write;
        let jpg: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        let png: &[u8] = b"\x89PNG\r\n\x1a\n-png-";
        let gif: &[u8] = b"GIF89a-gif-";
        let ns = r#"xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006""#;
        let one = |row: usize, id: &str| format!(r#"<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="9" cy="9"/><xdr:pic><xdr:blipFill><a:blip r:embed="{id}"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>"#);
        let two = |row: usize, to: usize, off: i64, id: &str| format!(r#"<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{to}</xdr:row><xdr:rowOff>{off}</xdr:rowOff></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="{id}"></a:blip></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>"#);
        let drawing = format!(
            r#"<xdr:wsDr {ns}>{}{}{}{}<mc:AlternateContent><mc:Choice Requires="a14">{}</mc:Choice><mc:Fallback>{}</mc:Fallback></mc:AlternateContent>{}</xdr:wsDr>"#,
            one(3, "rId1"),          // on K100's row (row 4): K100
            two(4, 5, 9000, "rId2"), // on a size row, reaching into K200's row (row 6): K200
            two(1, 2, 0, "rId1"),    // on the KIDS row, ending exactly where the sizes start: none
            one(3, "rId2"),          // K100 again: a second picture, left out
            two(8, 9, 0, "rId3"),    // W300 (row 9), once, though written twice
            two(8, 9, 0, "rId3"),
            one(5, "rId4"),          // not an image: never read
        );
        let parts: Vec<(&str, Vec<u8>)> = vec![
            ("xl/workbook.xml", br#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Totals" sheetId="1" r:id="rId1"/><sheet name="Acme &amp; Co" sheetId="2" r:id="rId2"/></sheets></workbook>"#.to_vec()),
            ("xl/_rels/workbook.xml.rels", br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="w" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="w" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#.to_vec()),
            ("xl/worksheets/_rels/sheet2.xml.rels", br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="d" Target="../drawings/drawing1.xml"/></Relationships>"#.to_vec()),
            ("xl/drawings/drawing1.xml", drawing.into_bytes()),
            ("xl/drawings/_rels/drawing1.xml.rels", br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="i" Target="../media/image1.jpeg"/><Relationship Id="rId2" Type="i" Target="../media/image2.png"/><Relationship Id="rId3" Type="i" Target="../media/image3.gif"/><Relationship Id="rId4" Type="i" Target="../media/notes.jpeg"/><Relationship Id="rId5" Type="i" Target="http://example.com/x.jpg" TargetMode="External"/></Relationships>"#.to_vec()),
            ("xl/media/image1.jpeg", jpg.to_vec()),
            ("xl/media/image2.png", png.to_vec()),
            ("xl/media/image3.gif", gif.to_vec()),
            ("xl/media/notes.jpeg", b"hello".to_vec()),
        ];
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in parts {
            w.start_file(name, opts).unwrap();
            w.write_all(&data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn a_picture_belongs_to_the_style_on_its_row_and_nothing_is_guessed() {
        let book = picture_book();
        let pics = read_pictures("shoes.xlsx", &book).pictures;
        assert_eq!(pics.iter().map(|p| (p.sheet.as_str(), p.row, p.row_last, p.ext.as_str())).collect::<Vec<_>>(), vec![
            ("Acme & Co", 4, 4, "jpg"),
            ("Acme & Co", 5, 6, "png"),
            ("Acme & Co", 2, 2, "jpg"),
            ("Acme & Co", 4, 4, "png"),
            ("Acme & Co", 9, 9, "gif"),
        ]);
        assert!(read_pictures("shoes.csv", &book).pictures.is_empty());
        assert!(read_pictures("shoes.xlsx", b"not a zip").pictures.is_empty());
        // The picture whose bytes are not an image is counted, not read.
        assert_eq!(read_pictures("shoes.xlsx", &book).unreadable, 1);
        let mut tabs = sample();
        tabs[1].name = "Acme & Co".into();
        let (mut m, rows) = read_manifest_rows(&tabs);
        let matched = match_pictures(&mut m, &rows, &tabs, &pics);
        assert_eq!(matched, vec![("t2r4".to_string(), 0), ("t2r6".to_string(), 1), ("t2r9".to_string(), 4)]);
        assert_eq!((m.pictures, m.pictures_left_out, m.tabs[1].pictures, m.tabs[0].pictures), (3, 2, 3, 0));
        assert_eq!(*pics[4].bytes, b"GIF89a-gif-".to_vec());
    }

    #[test]
    fn a_picture_is_kept_only_under_its_delivery_with_a_safe_name() {
        let jpg: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 7];
        let tag = picture_tag(jpg);
        assert_eq!(tag.len(), 16);
        assert_ne!(tag, picture_tag(&[0xFF, 0xD8, 0xFF, 0xE0, 8]));
        assert_eq!(picture_rel("6f1c-ab", "t2r4", jpg), Some(format!("media/deliveries/6f1c-ab/t2r4-{tag}.jpg")));
        assert!(picture_rel("../x", "t2r4", jpg).is_none());
        assert!(picture_rel("a", "t2/r4", jpg).is_none());
        assert!(picture_rel("a", "t2r4", b"<svg>").is_none());
        assert_eq!(clean_image(" media/deliveries/a/t2r4.jpg "), "media/deliveries/a/t2r4.jpg");
        assert_eq!(clean_image("media/deliveries/../secret.jpg"), "");
        assert_eq!(clean_image("https://example.com/x.jpg"), "");
        assert_eq!(image_ext(b"<svg onload=x>"), None);
        assert_eq!(image_ext(&[0xFF, 0xD8, 0xFF, 0xE1]), Some("jpg"));
        assert_eq!(image_ext(b"RIFF0000WEBPVP8 "), Some("webp"));
        let mut lines = read_manifest(&sample()).lines;
        lines[0].image = "media/../../etc/passwd".into();
        lines[1].image = "media/deliveries/x/t2r6.png".into();
        let c = clean_lines(lines).unwrap();
        assert_eq!((c[0].image.as_str(), c[1].image.as_str(), c[0].sheet.as_str()), ("", "media/deliveries/x/t2r6.png", "Acme Hash"));
    }

    #[test]
    fn a_file_read_again_finds_its_saved_lines_and_never_guesses() {
        let saved = read_manifest(&sample()).lines;
        // The same file: every line is itself.
        let again = read_manifest(&sample()).lines;
        let ids: Vec<(String, String)> = saved.iter().map(|l| (l.id.clone(), l.id.clone())).collect();
        assert_eq!(same_lines(&saved, &again), ids);
        // A row added near the top moves every row down: found by tab, style and colour.
        let mut tabs = sample();
        tabs[1].rows.insert(1, row(&["Spring order"]));
        let moved = read_manifest(&tabs).lines;
        assert_ne!(moved[0].id, saved[0].id);
        assert_eq!(same_lines(&saved, &moved), ids.iter().zip(&moved).map(|((_, s), m)| (m.id.clone(), s.clone())).collect::<Vec<_>>());
        // A style on the delivery twice by tab, style and colour, under a different id: neither.
        let mut twice = saved.clone();
        twice.push(LoadLine { id: "h1".into(), ..saved[0].clone() });
        assert!(!same_lines(&twice, &moved).iter().any(|(_, s)| *s == saved[0].id || s == "h1"));
        // A style that is not on the delivery: nothing.
        let mut other = again.clone();
        other[0].style = "Z999".into();
        assert!(!same_lines(&saved, &other).iter().any(|(r, _)| *r == other[0].id));
    }

    #[test]
    fn the_preview_shows_each_tabs_sample_pictures() {
        let m = read_manifest(&sample());
        let arc = |v: Vec<u8>| std::sync::Arc::new(v);
        let small = Picture { sheet: "Acme Hash".into(), row: 4, row_last: 4, col: 0, ext: "png".into(), bytes: arc(b"\x89PNG-x".to_vec()) };
        let big = Picture { bytes: arc(vec![0xFF; MAX_PREVIEW_BYTES + 1]), ext: "jpg".into(), ..small.clone() };
        let p = previews(&m, &[("t2r4".into(), small), ("t2r6".into(), big), ("t9r9".into(), Picture { sheet: "x".into(), row: 1, row_last: 1, col: 0, ext: "gif".into(), bytes: arc(b"GIF8".to_vec()) })]);
        assert_eq!(p.keys().collect::<Vec<_>>(), vec!["t2r4"]);
        assert!(p["t2r4"].starts_with("data:image/png;base64,"));
    }

    #[test]
    fn size_names_in_ranges_pairs_and_plus_sizes_read() {
        for s in ["S/M", "M/L", "5/6", "7-8", "0-3M", "6-12M", "XS-S", "4XL", "1X", "NB", "One Size", "O/S", "8W", "10K", "7 1/2", "7-1/2"] {
            assert!(looks_like_size(s), "{s}");
        }
        for s in ["108", "Black", "61", "-5", "7.25", "12/24/36", "S/", "/M", "Size"] {
            assert!(!looks_like_size(s), "{s}");
        }
        let tabs = vec![Tab {
            name: "Tops".into(),
            rows: vec![row(&["Style", "Color", "Size", "", "", "Total"]), row(&["", "", "S/M", "M/L", "L/XL", ""]), row(&["E1", "BLK", "1", "2", "3", "6"])],
        }];
        let m = read_manifest(&tabs);
        assert_eq!(m.tabs[0].layout, "above");
        assert_eq!(m.lines[0].sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("S/M", 1), ("M/L", 2), ("L/XL", 3)]);
    }

    #[test]
    fn one_size_on_the_heading_and_pack_size_never_the_sizes() {
        let m = read_manifest(&[Tab { name: "Hats".into(), rows: vec![row(&["Style", "Color", "OSFA", "Total"]), row(&["H1", "RED", "12", "12"])] }]);
        assert_eq!(m.lines[0].sizes, vec![SizeQty { size: "OSFA".into(), qty: 12 }]);
        // A Pack Size column holding 6, 12, 24 is not a size column: the sizes on the heading are.
        let m = read_manifest(&[Tab {
            name: "Packs".into(),
            rows: vec![row(&["Style", "Color", "Pack Size", "Qty", "7", "8"]), row(&["P1", "TAN", "12", "", "6", "6"])],
        }]);
        assert_eq!(m.tabs[0].layout, "heading");
        assert_eq!(m.lines[0].sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("7", 6), ("8", 6)]);
    }

    #[test]
    fn a_row_of_sums_with_no_label_is_a_subtotal_not_the_sizes() {
        // 12, 18, 24 would pass as sizes; they are the sums of the styles above, so they are skipped
        // and the next style keeps the sizes 5, 6, 7.
        let tabs = vec![Tab {
            name: "Hash".into(),
            rows: vec![
                row(&["Style", "Color", "Size Scale", "", "", "Total"]),
                row(&["", "", "5", "6", "7"]),
                row(&["S1", "BLK", "10", "8", "20", "38"]),
                row(&["S2", "BLK", "2", "10", "4", "16"]),
                row(&["", "", "12", "18", "24"]),
                row(&["S3", "BLK", "1", "", "1", "2"]),
            ],
        }];
        let m = read_manifest(&tabs);
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
        let s3 = m.lines.iter().find(|l| l.style == "S3").unwrap();
        assert_eq!(s3.sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect::<Vec<_>>(), vec![("5", 1), ("6", 0), ("7", 1)]);
    }

    #[test]
    fn a_size_column_that_is_mostly_blank_is_not_one_size_a_row() {
        // Rows of sizes the reader cannot name, a Size heading and a Total: never one size a row.
        let tabs = vec![Tab {
            name: "Odd".into(),
            rows: vec![row(&["Style", "Color", "Size", "", "Total"]), row(&["A1", "BLK", "1", "2", "3"]), row(&["A2", "BLK", "", "2", "2"]), row(&["A3", "BLK", "", "1", "1"])],
        }];
        assert_ne!(read_manifest(&tabs).tabs[0].layout, "column");
    }

    #[test]
    fn identical_pallet_pages_are_not_a_master_list() {
        let page = |name: &str| Tab { name: name.into(), rows: vec![row(&["Style", "Color", "7", "8", "Total"]), row(&["A", "BLK", "1", "1", "2"])] };
        let m = read_manifest(&[page("Pallet 1"), page("Pallet 2"), page("Pallet 3")]);
        assert!(m.tabs.iter().all(|t| t.kind == "items"));
        assert_eq!(m.pairs, 6);
    }

    #[test]
    fn a_row_inserted_above_two_rows_of_one_style_never_swaps_their_pictures() {
        let rows = |extra: bool| {
            let mut r = vec![row(&["Style", "Color", "7", "8", "Total"])];
            if extra {
                r.push(row(&["Spring"]));
            }
            r.push(row(&["A", "BLK", "1", "", "1"]));
            r.push(row(&["A", "BLK", "", "2", "2"]));
            vec![Tab { name: "T".into(), rows: r }]
        };
        let saved = read_manifest(&rows(false)).lines;
        let moved = read_manifest(&rows(true)).lines;
        // moved[0] now has saved[1]'s id but not its sizes: nothing matches by id, and the style is
        // there twice, so nothing matches at all rather than the wrong one.
        assert_eq!(moved[0].id, saved[1].id);
        let m = same_lines(&saved, &moved);
        assert!(!m.iter().any(|(r, s)| *r == moved[0].id && *s == saved[1].id), "{m:?}");
    }

    #[test]
    fn a_row_is_the_sheets_own_row_when_blank_rows_lead_the_tab() {
        let mut tabs = sample();
        let blank: Vec<Vec<String>> = vec![Vec::new(); 3];
        tabs[1].rows.splice(0..0, blank);
        let (m, rows) = read_manifest_rows(&tabs);
        assert_eq!(m.lines[0].id, "t2r7");
        assert_eq!(m.lines[0].source, "Acme Hash row 7");
        assert_eq!(rows.get(&(1, 7)).map(String::as_str), Some("t2r7"));
    }

    #[test]
    fn one_image_on_many_rows_is_read_once() {
        let book = picture_book();
        let pics = read_pictures("shoes.xlsx", &book).pictures;
        // rows 4 (jpg) and 2 (jpg) use one image file: one buffer, shared.
        assert!(std::sync::Arc::ptr_eq(&pics[0].bytes, &pics[2].bytes));
    }

    /// Every manifest in R537_DIR read and written beside it: <name>.json (lines, tabs, warnings,
    /// mismatches, stated) and <name>-pics/<line>.<ext> for each matched picture, for a script to
    /// check against what it wrote: `R537_DIR=dir cargo test manifests_in_a_folder -- --ignored`.
    #[test]
    #[ignore]
    fn manifests_in_a_folder() {
        let dir = std::env::var("R537_DIR").expect("R537_DIR");
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if !(name.ends_with(".xlsx") || name.ends_with(".csv")) {
                continue;
            }
            let bytes = std::fs::read(&p).unwrap();
            let (m, pics) = read_manifest_file(&name, &bytes).unwrap();
            let pd = format!("{dir}/{name}-pics");
            std::fs::create_dir_all(&pd).unwrap();
            for (id, pic) in &pics {
                std::fs::write(format!("{pd}/{id}.{}", pic.ext), pic.bytes.as_slice()).unwrap();
            }
            std::fs::write(format!("{dir}/{name}.json"), serde_json::to_string_pretty(&m).unwrap()).unwrap();
        }
    }

    fn sizes_of(m: &ManifestRead, style: &str) -> Vec<(String, i64)> {
        m.lines.iter().find(|l| l.style == style).unwrap().sizes.iter().map(|s| (s.size.clone(), s.qty)).collect()
    }

    #[test]
    fn size_rows_in_words_or_rising_numbers_are_sizes_and_never_one_size_a_row() {
        let tab = |labels: &[&str]| {
            let mut size_row = vec!["", ""];
            size_row.extend_from_slice(labels);
            vec![Tab {
                name: "T".into(),
                rows: vec![row(&["Style", "Color", "Size Scale", "", "", "Total"]), row(&size_row), row(&["T1", "BLK", "1", "2", "3", "6"]), row(&["T2", "RED", "4", "5", "6", "15"])],
            }]
        };
        for labels in [["Small", "Medium", "Large"], ["34B", "34C", "34D"], ["PS", "PM", "PL"], ["98", "104", "110"]] {
            let m = read_manifest(&tab(&labels));
            assert_eq!(m.tabs[0].layout, "above", "{labels:?}");
            assert_eq!(sizes_of(&m, "T1"), labels.iter().zip([1, 2, 3]).map(|(l, q)| (l.to_string(), q)).collect::<Vec<_>>(), "{labels:?}");
            assert!(m.warnings.is_empty(), "{:?}", m.warnings);
        }
        // Numbers past 60 that do not rise are quantities, never sizes.
        let m = read_manifest(&tab(&["108", "12", "64"]));
        assert_ne!(m.tabs[0].layout, "column");
        assert!(m.warnings.iter().any(|w| w.contains("not size names")));
    }

    #[test]
    fn a_row_of_one_size_is_the_sizes_not_a_group() {
        let rows = |first: bool| {
            let mut r = vec![row(&["Style", "Color", "Size Scale", "", "", "Total"])];
            let sml = [row(&["", "", "S", "M", "L", ""]), row(&["T1", "BLK", "1", "2", "3", "6"])];
            let osfa = [row(&["", "", "OSFA", "", "", ""]), row(&["H1", "RED", "12", "", "", "12"])];
            if first {
                r.extend(osfa.iter().cloned());
                r.extend(sml.iter().cloned());
            } else {
                r.extend(sml.iter().cloned());
                r.extend(osfa.iter().cloned());
            }
            vec![Tab { name: "Mixed".into(), rows: r }]
        };
        for first in [true, false] {
            let m = read_manifest(&rows(first));
            assert_eq!(sizes_of(&m, "H1"), vec![("OSFA".to_string(), 12)]);
            assert_eq!(sizes_of(&m, "T1"), vec![("S".to_string(), 1), ("M".to_string(), 2), ("L".to_string(), 3)]);
            assert!(m.lines.iter().all(|l| l.group.is_empty()));
            assert!(m.warnings.is_empty() && m.mismatches.is_empty(), "{:?} {:?}", m.warnings, m.mismatches);
        }
    }

    #[test]
    fn a_subtotal_showing_a_zero_and_a_subtotal_label_are_skipped() {
        let m = read_manifest(&[Tab {
            name: "Hash".into(),
            rows: vec![
                row(&["Style", "Color", "Size Scale", "", "", "", "Total"]),
                row(&["", "", "5", "6", "7", "8"]),
                row(&["S1", "BLK", "10", "8", "", "2", "20"]),
                row(&["S2", "BLK", "2", "10", "", "4", "16"]),
                row(&["", "", "12", "18", "0", "6"]),
                row(&["Subtotal", "", "12", "18", "", "6", "36"]),
                row(&["S3", "BLK", "1", "", "", "1", "2"]),
            ],
        }]);
        assert_eq!(m.lines.len(), 3);
        assert_eq!(sizes_of(&m, "S3"), vec![("5".to_string(), 1), ("6".to_string(), 0), ("7".to_string(), 0), ("8".to_string(), 1)]);
        assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    }

    #[test]
    fn colour_names_keep_one_size_a_row_apart_and_more_headings_read() {
        let m = read_manifest(&[Tab {
            name: "Boots".into(),
            rows: vec![
                row(&["Style", "Color Name", "UK Size", "Units"]),
                row(&["B1", "Black", "7", "2"]),
                row(&["B1", "Brown", "7", "1"]),
                row(&["B1", "Black", "8", "3"]),
            ],
        }]);
        assert_eq!(m.tabs[0].layout, "column");
        let got: Vec<(&str, Vec<(&str, i64)>)> = m.lines.iter().map(|l| (l.color_name.as_str(), l.sizes.iter().map(|s| (s.size.as_str(), s.qty)).collect())).collect();
        assert_eq!(got, vec![("Black", vec![("7", 2), ("8", 3)]), ("Brown", vec![("7", 1)])]);
        let m = read_manifest(&[Tab { name: "Kids".into(), rows: vec![row(&["Style", "Colorway", "62", "68", "74", "Total", "M"]), row(&["K1", "NAVY", "1", "2", "3", "6", "40%"])] }]);
        assert_eq!(m.lines[0].color, "NAVY");
        assert_eq!(sizes_of(&m, "K1"), vec![("62".to_string(), 1), ("68".to_string(), 2), ("74".to_string(), 3)]);
        assert!(m.mismatches.is_empty());
    }

    #[test]
    fn two_pages_the_same_are_named_and_a_master_needs_two_others() {
        let page = |name: &str, styles: &[&str]| Tab {
            name: name.into(),
            rows: std::iter::once(row(&["Style", "Color", "7", "8", "Total"])).chain(styles.iter().map(|s| row(&[s, "BLK", "1", "1", "2"]))).collect(),
        };
        let m = read_manifest(&[page("One", &["A"]), page("Two", &["A"])]);
        assert_eq!(m.tabs.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), vec!["items", "items"]);
        assert_eq!(m.tabs[1].warnings, vec!["One and Two list the same styles and pairs. If one is a copy of the other, switch it off.".to_string()]);
    }

    #[test]
    fn the_picture_column_wins_and_a_banner_never_lands_on_a_style() {
        let mut tabs = sample();
        tabs[1].name = "Acme & Co".into();
        let (mut m, rows) = read_manifest_rows(&tabs);
        let pic = |row: usize, row_last: usize, col: usize, b: u8| Picture { sheet: "Acme & Co".into(), row, row_last, col, ext: "png".into(), bytes: std::sync::Arc::new(vec![0x89, b'P', b'N', b'G', b]) };
        // A stamp in column K on K100's row comes first in the file; the product pictures are in column A.
        let pics = vec![pic(4, 4, 10, 1), pic(4, 4, 0, 2), pic(6, 6, 0, 3), pic(1, 4, 0, 4), pic(9, 9, 0, 5)];
        let got = match_pictures(&mut m, &rows, &tabs, &pics);
        assert_eq!(got, vec![("t2r4".to_string(), 1), ("t2r6".to_string(), 2), ("t2r9".to_string(), 4)]);
        assert_eq!(m.pictures_left_out, 2);
    }

    #[test]
    fn rows_past_excels_last_never_hang_the_matcher() {
        let xml = r#"<wsDr><twoCellAnchor><from><col>0</col><row>99999999999999</row></from><to><col>1</col><row>99999999999999999</row><rowOff>5</rowOff></to><pic><blip embed="rId1"/></pic></twoCellAnchor></wsDr>"#;
        let a = drawing_anchors(xml);
        assert_eq!((a[0].row, a[0].row_last), (1_048_575, 1_048_575));
        let mut tabs = sample();
        tabs[1].name = "S".into();
        let (mut m, rows) = read_manifest_rows(&tabs);
        let far = Picture { sheet: "S".into(), row: 1, row_last: usize::MAX, col: 0, ext: "png".into(), bytes: std::sync::Arc::new(vec![0x89, b'P', b'N', b'G']) };
        assert!(match_pictures(&mut m, &rows, &tabs, &[far]).is_empty());
    }

    #[test]
    fn a_line_owned_by_its_id_is_never_taken_by_a_style_match() {
        let l = |id: &str, sizes: &[(&str, i64)]| LoadLine { id: id.into(), brand: "T".into(), style: "A".into(), color: "BLK".into(), sizes: sizes.iter().map(|(s, q)| SizeQty { size: s.to_string(), qty: *q }).collect(), ..Default::default() };
        let saved = vec![l("t1r3", &[("7", 1)])];
        // The file has the style twice: row 2 (not saved) and row 3 (saved, same sizes).
        let read = vec![l("t1r2", &[("7", 5)]), l("t1r3", &[("7", 1)])];
        assert_eq!(same_lines(&saved, &read), vec![("t1r3".to_string(), "t1r3".to_string())]);
    }

    #[test]
    fn pictures_placed_inside_cells_are_named() {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        for (n, d) in [("xl/workbook.xml", "<workbook><sheets/></workbook>"), ("xl/richData/rdrichvaluestructure.xml", "<x/>")] {
            w.start_file(n, opts).unwrap();
            w.write_all(d.as_bytes()).unwrap();
        }
        let book = w.finish().unwrap().into_inner();
        assert!(read_pictures("a.xlsx", &book).in_cell);
        assert!(!read_pictures("a.xlsx", &picture_book()).in_cell);
    }

    #[test]
    fn one_size_plus_size_and_lot_size_headings_are_not_the_size_column() {
        let m = read_manifest(&[Tab { name: "Hats".into(), rows: vec![row(&["Style", "Color", "One Size", "Total"]), row(&["H1", "RED", "12", "12"])] }]);
        assert_eq!(sizes_of(&m, "H1"), vec![("One Size".to_string(), 12)]);
        let m = read_manifest(&[Tab { name: "Tops".into(), rows: vec![row(&["Style", "Color", "S", "M", "L", "Plus Size", "Total"]), row(&["T1", "BLK", "1", "2", "3", "", "6"])] }]);
        assert_eq!(sizes_of(&m, "T1"), vec![("S".to_string(), 1), ("M".to_string(), 2), ("L".to_string(), 3)]);
        assert!(m.mismatches.is_empty());
        let m = read_manifest(&[Tab {
            name: "Boots".into(),
            rows: vec![row(&["Style", "Color", "Lot Size", "Size", "Qty"]), row(&["A1", "BLK", "12", "7", "2"]), row(&["A1", "BLK", "12", "8", "3"])],
        }]);
        assert_eq!(m.tabs[0].layout, "column");
        assert_eq!(sizes_of(&m, "A1"), vec![("7".to_string(), 2), ("8".to_string(), 3)]);
    }

    #[test]
    fn heading_words_fillers_and_banners_never_become_the_sizes() {
        let tab = |extra: &[&str]| {
            let mut r = vec![row(&["Style", "Color", "Size Scale", "", "", "Total"]), row(&["", "", "5", "6", "7", ""])];
            r.push(row(extra));
            r.push(row(&["T1", "BLK", "1", "2", "3", "6"]));
            vec![Tab { name: "T".into(), rows: r }]
        };
        for extra in [&["", "", "Pairs", "Pairs", "Pairs"][..], &["", "", "-----", "-----", "-----"][..], &["", "", "N/A", "N/A", "TBD"][..]] {
            let m = read_manifest(&tab(extra));
            assert_eq!(sizes_of(&m, "T1"), vec![("5".to_string(), 1), ("6".to_string(), 2), ("7".to_string(), 3)], "{extra:?}");
        }
        // A banner over the sizes (Youth over 5, Adult over 8) is not a row of sizes.
        let m = read_manifest(&[Tab {
            name: "Kids".into(),
            rows: vec![row(&["Style", "Color", "5", "6", "7", "8", "9", "10", "Total"]), row(&["", "", "Youth", "", "", "Adult", "", "", ""]), row(&["T1", "BLK", "1", "2", "3", "", "", "", "6"])],
        }]);
        assert_eq!(sizes_of(&m, "T1")[..3], [("5".to_string(), 1), ("6".to_string(), 2), ("7".to_string(), 3)]);
        assert!(m.mismatches.is_empty());
    }

    #[test]
    fn the_totals_page_figure_is_the_grand_total() {
        let totals = Tab {
            name: "Totals".into(),
            rows: vec![row(&["Brand", "SKU's", "Total Pairs"]), row(&["A", "3", "10"]), row(&["Subtotal", "3", "10"]), row(&["B", "2", "5"]), row(&["Sub Total", "2", "5"]), row(&["Total", "5", "15"])],
        };
        let mut tabs = sample();
        tabs[0] = totals;
        let m = read_manifest(&tabs);
        assert_eq!(m.stated.as_ref().map(|s| (s.lines, s.pairs)), Some((Some(5), 15)));
    }

    #[test]
    fn a_linked_picture_is_counted_not_lost() {
        let xml = r#"<wsDr><oneCellAnchor><from><col>0</col><row>3</row></from><pic><blip link="rId9"/></pic></oneCellAnchor><oneCellAnchor><from><col>0</col><row>5</row></from><sp><txBody/></sp></oneCellAnchor></wsDr>"#;
        let a = drawing_anchors(xml);
        // The linked picture is an anchor with nothing to read; the text box is no picture at all.
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].embed, None);
    }

    #[test]
    fn each_line_knows_the_rows_it_was_read_from() {
        // Rows of sizes above (the sample): K100 on row 4, its sizes on row 3.
        let m = read_manifest(&sample());
        let k = m.lines.iter().find(|l| l.style == "K100").unwrap();
        assert_eq!((k.rows.clone(), k.sizes_row), (vec![4], 3));
        let w = m.lines.iter().find(|l| l.style == "W300").unwrap();
        assert_eq!((w.rows.clone(), w.sizes_row), (vec![9], 8));
        // Sizes on the heading row.
        let m = read_manifest(&[Tab { name: "S".into(), rows: vec![row(&["Style", "Color", "7", "8", "Total"]), row(&["A1", "BLK", "1", "2", "3"])] }]);
        assert_eq!((m.lines[0].rows.clone(), m.lines[0].sizes_row), (vec![2], 1));
        // One size a row: every row of the style, no row of sizes.
        let m = read_manifest(&[Tab {
            name: "B".into(),
            rows: vec![row(&["Style", "Color", "Size", "Qty"]), row(&["B1", "BLK", "7", "2"]), row(&["B2", "RED", "S", "1"]), row(&["B1", "BLK", "8", "3"])],
        }]);
        let b1 = m.lines.iter().find(|l| l.style == "B1").unwrap();
        assert_eq!((b1.rows.clone(), b1.sizes_row), (vec![2, 4], 0));
        // Stored and read back; a line added by hand has none, and junk is dropped.
        let mut lines = m.lines.clone();
        lines[0].rows = (0..100).chain([2_000_000]).collect();
        lines[0].sizes_row = 5_000_000;
        let c = clean_lines(lines).unwrap();
        assert_eq!(c[0].rows.len(), MAX_LINE_ROWS);
        assert!(c[0].rows.iter().all(|&r| r >= 1));
        assert_eq!(c[0].sizes_row, 0);
        // A CSV's blank lines count as rows, as in Excel.
        let tabs = read_tabs("a.csv", b"Style,Color,7,8,Total\nA1,BLK,1,2,3\n\nA2,BLK,1,2,3\n").unwrap();
        let m = read_manifest(&tabs);
        assert_eq!(m.lines.iter().map(|l| l.rows.clone()).collect::<Vec<_>>(), vec![vec![2], vec![4]]);
        let tabs = read_tabs("b.csv", b"Style,Color,Size,Qty\r\n\r\nB1,BLK,7,2\r\n\r\n\r\nB1,BLK,8,3\r\n").unwrap();
        assert_eq!(read_manifest(&tabs).lines[0].rows, vec![3, 6]);
        let json = serde_json::to_string(&LoadLine { id: "h1".into(), style: "X".into(), ..Default::default() }).unwrap();
        assert!(!json.contains("rows") && !json.contains("sizes_row"), "{json}");
    }

    /// The real sheet, read locally only: `R519_SHEET=path cargo test real_manifest -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_manifest() {
        let path = std::env::var("R519_SHEET").expect("R519_SHEET");
        let bytes = std::fs::read(&path).unwrap();
        let (m, pics) = read_manifest_file(&path, &bytes).unwrap();
        println!("lines {} pairs {} stated {:?} pictures {} left out {}", m.lines.len(), m.pairs, m.stated, m.pictures, m.pictures_left_out);
        // R537_DUMP: every line as read, and every matched picture as a file named by its line,
        // for an independent reader to check.
        if let Ok(dir) = std::env::var("R537_DUMP") {
            std::fs::create_dir_all(format!("{dir}/pics")).unwrap();
            std::fs::write(format!("{dir}/lines.json"), serde_json::to_string_pretty(&m.lines).unwrap()).unwrap();
            std::fs::write(format!("{dir}/tabs.json"), serde_json::to_string_pretty(&m.tabs).unwrap()).unwrap();
            for (id, p) in &pics {
                std::fs::write(format!("{dir}/pics/{id}.{}", p.ext), p.bytes.as_slice()).unwrap();
            }
        }
        for t in &m.tabs {
            println!("tab {:?}", t);
        }
        for g in &m.groups {
            println!("group {:?}", g);
        }
        for x in &m.mismatches {
            println!("mismatch {:?}", x);
        }
        for w in &m.warnings {
            println!("warning {w}");
        }
    }
}
