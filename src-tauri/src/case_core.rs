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
}

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
                    let rows = range.rows().map(|r| r.iter().map(cell_text).collect::<Vec<String>>()).collect();
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
    l.starts_with("total") || l.starts_with("grand total") || l == "sum"
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

/// A heading that is a size by itself: 7, 8.5, 7½, XS, XL, 4C, 11Y, 2T, or a European 38. A
/// number must be a believable size: 0 to 60 in halves, so a quantity like 108 is never a size.
fn looks_like_size(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    if t.is_empty() || t.chars().count() > 6 {
        return false;
    }
    if let Some(n) = size_number(&t) {
        return (0.0..=60.0).contains(&n) && (n * 2.0).fract() == 0.0;
    }
    if matches!(t.as_str(), "XXS" | "XS" | "S" | "M" | "L" | "XL" | "XXL" | "XXXL" | "2XL" | "3XL" | "OS" | "OSFA") {
        return true;
    }
    let last = t.chars().last().unwrap_or(' ');
    let head: String = t.chars().take(t.chars().count() - 1).collect();
    matches!(last, 'C' | 'Y' | 'T' | 'W' | 'M') && size_number(&head).map(|n| (0.0..=60.0).contains(&n)).unwrap_or(false)
}

/// A row of size names: every label looks like a size. A row of quantities with no style
/// (24, 36, 108) or words is never taken for one.
fn is_size_row(labels: &[(usize, String)]) -> bool {
    !labels.is_empty() && labels.iter().all(|(_, l)| looks_like_size(l))
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

fn find_cols(rows: &[Vec<String>]) -> Option<Cols> {
    for r in 0..rows.len().min(30) {
        let h: Vec<String> = rows[r].iter().map(|c| norm(c)).collect();
        let pos = |f: &dyn Fn(&str) -> bool| h.iter().position(|x| f(x));
        let style = match pos(&|x| matches!(x, "style" | "style number" | "style no" | "sku" | "item" | "item number" | "model")) {
            Some(c) => c,
            None => continue,
        };
        let colorish = |x: &str| x.contains("color") || x.contains("colour");
        let color_name = pos(&|x| colorish(x) && (x.contains("desc") || x.contains("name")));
        let color = pos(&|x| matches!(x, "color" | "colour" | "color code" | "colour code" | "clr"));
        let description = pos(&|x| !colorish(x) && (x.contains("desc") || x == "name" || x == "style name"));
        let cost = pos(&|x| x.contains("cost") || x.contains("wholesale") || matches!(x, "std price" | "price" | "unit price"));
        let msrp = pos(&|x| x.contains("msrp") || x.contains("retail") || x == "srp");
        let total = h.iter().enumerate().skip(style + 1).find(|(_, x)| matches!(x.as_str(), "total" | "total pairs" | "pairs" | "qty" | "total qty" | "quantity" | "units" | "on hand")).map(|(c, _)| c);
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let end = total.unwrap_or(width);
        let size_col = h.iter().position(|x| x.contains("size"));
        // A "Size" heading where the grid starts, or else sizes named as headings.
        let (grid_from, grid_to, scale) = if let Some(c) = size_col {
            let scale = (c + 1..end.max(c + 1)).filter(|&k| k < rows[r].len() && looks_like_size(&rows[r][k])).map(|k| (k, rows[r][k].trim().to_string())).collect();
            (c, end.max(c + 1), scale)
        } else {
            let named: Vec<(usize, String)> = (style + 1..end).filter(|&k| k < rows[r].len() && looks_like_size(&rows[r][k])).map(|k| (k, rows[r][k].trim().to_string())).collect();
            match (named.first(), named.last()) {
                (Some(a), Some(b)) if named.len() >= 2 => (a.0, b.0 + 1, named.clone()),
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
    for r in 0..tab.rows.len().min(30) {
        let h: Vec<String> = tab.rows[r].iter().map(|c| norm(c)).collect();
        let pairs_col = match h.iter().position(|x| x.contains("pair") || x == "qty" || x.contains("quantity") || x == "total units") {
            Some(c) => c,
            None => continue,
        };
        let lines_col = h.iter().position(|x| x.starts_with("sku") || x.starts_with("style"));
        for row in &tab.rows[r + 1..] {
            let first = row.iter().find(|c| !c.trim().is_empty()).cloned().unwrap_or_default();
            if is_total(&first) {
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
        let per_row = size_rows == 0 && cols.scale.is_empty() && cols.size_col.is_some() && cols.total.is_some()
            && body.clone().filter(|&r| !one_line(&at(&tab.rows[r], Some(cols.style))).is_empty()).any(|r| looks_like_size(&at(&tab.rows[r], cols.size_col)));
        let layout = if per_row { "column" } else if size_rows > 0 { "above" } else { "heading" };
        let first_line = lines.len();
        let first_warning = warnings.len();
        let mut scale: Vec<(usize, String)> = cols.scale.clone();
        let mut group = String::new();
        let mut tab_mismatches = 0usize;
        for r in body {
            let row = &tab.rows[r];
            let style = one_line(&at(row, Some(cols.style)));
            let grid: Vec<(usize, String)> = (cols.grid_from..cols.grid_to.min(row.len()))
                .filter(|&c| !row[c].trim().is_empty())
                .map(|c| (c, row[c].trim().to_string()))
                .collect();
            if style.is_empty() {
                let filled: Vec<&String> = row.iter().filter(|c| !c.trim().is_empty()).collect();
                if !per_row && !grid.is_empty() && grid.len() == filled.len() {
                    if is_size_row(&grid) {
                        let twice = repeated_sizes(&grid);
                        if !twice.is_empty() {
                            warnings.push(format!(
                                "{} row {}: size {} is named twice in this row of sizes, so the pairs under both count as that one size. If one should be a half size, fix the sheet and read it again.",
                                tab.name,
                                r + 1,
                                twice.join(", ")
                            ));
                        }
                        scale = grid;
                    } else {
                        warnings.push(format!("{} row {}: numbers with no style that are not size names, so they were left out.", tab.name, r + 1));
                    }
                } else if filled.len() == 1 && num(filled[0]).is_none() && !is_total(filled[0]) {
                    group = one_line(filled[0]);
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
                let found = lines[first_line..].iter().position(|l| l.style == style && l.color == color && l.group == group);
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
                        });
                        lines.len() - 1
                    }
                };
                let l = &mut lines[k];
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
    let items: Vec<usize> = (0..tab_reads.len()).filter(|&i| tab_reads[i].kind == "items").collect();
    if items.len() >= 2 {
        for &i in &items {
            let mine = keys(&tab_reads[i].name);
            let others: BTreeSet<(String, String)> = items.iter().filter(|&&j| j != i).flat_map(|&j| keys(&tab_reads[j].name)).collect();
            if mine == others {
                tab_reads[i].kind = "copy".into();
                tab_reads[i].note = "Every style on this page is also on the other pages, so it looks like a master list. It is left out unless you turn it on.".into();
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
/// on, and its bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Picture {
    pub sheet: String,
    pub row: usize,
    pub row_last: usize,
    pub ext: String,
    pub bytes: Vec<u8>,
}

/// One picture at most this size, and at most this many in a file.
pub const MAX_PICTURE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_PICTURES: usize = 5_000;

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
    let mut f = z.by_name(name).ok()?;
    if f.size() > 50 * 1024 * 1024 {
        return None;
    }
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
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
    embed: String,
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
    let mut embed: Option<String> = None;
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
                    }
                    b"from" if in_anchor => edge = Edge::From,
                    b"to" if in_anchor => edge = Edge::To,
                    b"row" | b"rowOff" if edge != Edge::None => field = String::from_utf8_lossy(name.as_ref()).to_string(),
                    b"blip" if in_anchor && embed.is_none() => embed = blip_embed(&e),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if in_anchor && embed.is_none() && e.local_name().as_ref() == b"blip" {
                    embed = blip_embed(&e);
                }
            }
            Ok(Event::Text(t)) => {
                if !field.is_empty() {
                    let v = String::from_utf8_lossy(&t).trim().to_string();
                    match (edge, field.as_str()) {
                        (Edge::From, "row") => from = v.parse().ok(),
                        (Edge::To, "row") => to = v.parse().ok(),
                        (Edge::To, "rowOff") => to_off = v.parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    b"Fallback" => fallback = fallback.saturating_sub(1),
                    b"row" | b"rowOff" => field.clear(),
                    b"from" | b"to" => edge = Edge::None,
                    b"twoCellAnchor" | b"oneCellAnchor" => {
                        in_anchor = false;
                        if let (Some(r), Some(id), 0) = (from, embed.take(), fallback) {
                            let last = match to {
                                Some(t) if t > r && to_off > 0 => t,
                                Some(t) if t > r => t - 1,
                                _ => r,
                            };
                            out.push(Anchor { row: r, row_last: last, embed: id });
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

/// Every picture placed over a cell, in every tab of an Excel file (.xlsx/.xlsm). Any other
/// file, or a part that cannot be read, gives no pictures rather than an error: the lines read
/// either way. A picture is kept only when its bytes are a jpg, png, gif or webp.
pub fn read_pictures(filename: &str, bytes: &[u8]) -> Vec<Picture> {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "xlsx" | "xlsm") {
        return vec![];
    }
    let mut z = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(z) => z,
        Err(_) => return vec![],
    };
    let workbook = match zip_text(&mut z, "xl/workbook.xml") {
        Some(x) => x,
        None => return vec![],
    };
    let book_rels = rels(&mut z, "xl/_rels/workbook.xml.rels", "xl");
    let mut out = Vec::new();
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
                let media = match drels.get(&a.embed) {
                    Some(m) => m.clone(),
                    None => continue,
                };
                let data = {
                    use std::io::Read;
                    let f = match z.by_name(&media) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    if f.size() as usize > MAX_PICTURE_BYTES {
                        continue;
                    }
                    let mut v = Vec::new();
                    if f.take(MAX_PICTURE_BYTES as u64 + 1).read_to_end(&mut v).is_err() || v.len() > MAX_PICTURE_BYTES {
                        continue;
                    }
                    v
                };
                let ext = match image_ext(&data) {
                    Some(e) => e,
                    None => continue,
                };
                out.push(Picture { sheet: name.clone(), row: a.row + 1, row_last: a.row_last + 1, ext: ext.into(), bytes: data });
                if out.len() >= MAX_PICTURES {
                    return out;
                }
            }
        }
    }
    out
}

/// Each line's picture. A picture belongs to the line read on the row its top edge sits on; when
/// no line was read there, to the one line read on the rows it covers (never a guess between
/// two). A line keeps the first picture that belongs to it. Returns (line id, picture index)
/// pairs and fills each tab's and the read's picture counts.
pub fn match_pictures(read: &mut ManifestRead, rowmap: &RowMap, tabs: &[Tab], pictures: &[Picture]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    let mut left_out = 0usize;
    for (k, p) in pictures.iter().enumerate() {
        let ti = match tabs.iter().position(|t| t.name == p.sheet) {
            Some(i) => i,
            None => {
                left_out += 1;
                continue;
            }
        };
        let id = match rowmap.get(&(ti, p.row)) {
            Some(id) => Some(id.clone()),
            None => {
                let mut under: Vec<&String> = (p.row + 1..=p.row_last.max(p.row)).filter_map(|r| rowmap.get(&(ti, r))).collect();
                under.dedup();
                if under.len() == 1 {
                    Some(under[0].clone())
                } else {
                    None
                }
            }
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
    let pictures = read_pictures(filename, bytes);
    let matched = match_pictures(&mut read, &rowmap, &tabs, &pictures);
    let mut out = Vec::new();
    let mut pics: Vec<Option<Picture>> = pictures.into_iter().map(Some).collect();
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

/// Where a line's picture is kept: "media/deliveries/<load>/<line>.<ext>" (both surfaces serve
/// media/ at /media/). None when an id is not safe for a file name.
pub fn picture_rel(load_id: &str, line_id: &str, ext: &str) -> Option<String> {
    if !safe_id(load_id) || !safe_id(line_id) || !matches!(ext, "jpg" | "png" | "webp" | "gif") {
        return None;
    }
    Some(format!("media/deliveries/{load_id}/{line_id}.{ext}"))
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
    if total == 0 {
        return Err("Put at least one pair in the case.".into());
    }
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
}

pub fn pallet_id(load_id: &str, number: i64) -> String {
    format!("pal-{load_id}-{number}")
}

/// A location as stored: one line, trimmed, at most 40 characters.
pub fn clean_location(s: &str) -> String {
    one_line(s).chars().take(MAX_LOCATION).collect()
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
    /// Pairs on the pallet with no box.
    pub loose: i64,
    pub pairs: i64,
    pub styles: usize,
    pub cost: f64,
    pub msrp: f64,
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
                loose: s.map(|s| s.loose).unwrap_or(0),
                pairs: s.map(|s| s.pairs).unwrap_or(0),
                styles: s.map(|s| s.styles).unwrap_or(0),
                cost: s.map(|s| s.cost).unwrap_or(0.0),
                msrp: s.map(|s| s.msrp).unwrap_or(0.0),
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
        let p = pallets.entry(c.pallet).or_insert((PalletSum { pallet: c.pallet, cases: 0, pairs: 0, loose: 0, styles: 0, cost: 0.0, msrp: 0.0 }, Vec::new()));
        if !c.is_loose() {
            p.0.cases += 1;
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
    pub takes: Vec<CaseLine>,
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

/// What an order takes: every style and size asked for, as far as what is left goes. Unknown
/// styles or sizes are refused; nothing goes below zero.
pub fn take(lines: &[LoadLine], cases: &[Case], outs: &[Out], asked: &[CaseLine]) -> Result<(Vec<CaseLine>, Vec<TakeShort>), String> {
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
    let st = stock(lines, cases, outs);
    let left = |line_id: &str, size: &str| -> i64 {
        st.lines.iter().find(|l| l.line_id == line_id).and_then(|l| l.sizes.iter().find(|z| z.size == size)).map(|z| z.left).unwrap_or(0)
    };
    let mut taken = Vec::new();
    let mut short = Vec::new();
    for w in want {
        let n = w.pairs.min(left(&w.line_id, &w.size));
        if n < w.pairs {
            short.push(TakeShort { line_id: w.line_id.clone(), size: w.size.clone(), asked: w.pairs, taken: n });
        }
        if n > 0 {
            taken.push(CaseLine { line_id: w.line_id, size: w.size, pairs: n });
        }
    }
    Ok((taken, short))
}

/// What the taken pairs cost, each at its line's cost, to the cent.
pub fn takes_cost(lines: &[LoadLine], takes: &[CaseLine]) -> f64 {
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

    fn sold(id: &str, takes: Vec<CaseLine>) -> Out {
        Out { id: id.into(), pairs: takes.iter().map(|t| t.pairs).sum(), takes, ..Default::default() }
    }
    fn cl(line: &str, size: &str, pairs: i64) -> CaseLine {
        CaseLine { line_id: line.into(), size: size.into(), pairs }
    }

    #[test]
    fn an_out_takes_pairs_off_what_is_left_and_a_put_back_returns_them() {
        let lines = read_manifest(&sample()).lines;
        let a = lines[0].id.clone();
        let cases = vec![Case { id: "c1".into(), pallet: 1, number: 1, contents: vec![cl(&a, "S", 4), cl(&a, "M", 6)], ..Default::default() }];
        let (taken, short) = take(&lines, &cases, &[], &[cl(&a, "S", 3), cl(&a, "M", 9)]).unwrap();
        assert_eq!(taken, vec![cl(&a, "S", 3), cl(&a, "M", 6)]);
        assert_eq!(short, vec![TakeShort { line_id: a.clone(), size: "M".into(), asked: 9, taken: 6 }]);
        assert_eq!(takes_cost(&lines, &taken), 94.5);
        let mut outs = vec![sold("o1", taken)];
        let s = stock(&lines, &cases, &outs);
        assert_eq!((s.received, s.out, s.left), (10, 9, 1));
        assert_eq!(s.lines[0].sizes.iter().map(|z| (z.size.as_str(), z.left)).collect::<Vec<_>>(), vec![("XS", 0), ("S", 1), ("M", 0), ("L", 0)]);
        assert_eq!(s.groups[0], GroupLeft { brand: "Acme Hash".into(), group: "KIDS".into(), styles: 1, left: 1 });
        assert_eq!(s.groups.iter().map(|g| g.left).sum::<i64>(), s.left);
        // Nothing left in M: a second order gets none of it.
        let (taken2, short2) = take(&lines, &cases, &outs, &[cl(&a, "M", 1)]).unwrap();
        assert!(taken2.is_empty());
        assert_eq!(short2[0].taken, 0);
        outs[0].undone = true;
        assert_eq!(stock(&lines, &cases, &outs).left, 10);
        // What was received never moves.
        assert_eq!(tally(&lines, &cases).totals.received, 10);
        assert!(take(&lines, &cases, &[], &[cl(&a, "XXL", 1)]).is_err());
        assert!(take(&lines, &cases, &[], &[]).is_err());
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
        // Two pages the same: the first is the copy, never both.
        let m = read_manifest(&[page("One", &["A"]), page("Two", &["A"])]);
        assert_eq!(m.tabs.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(), vec!["copy", "items"]);
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
        let pics = read_pictures("shoes.xlsx", &book);
        assert_eq!(pics.iter().map(|p| (p.sheet.as_str(), p.row, p.row_last, p.ext.as_str())).collect::<Vec<_>>(), vec![
            ("Acme & Co", 4, 4, "jpg"),
            ("Acme & Co", 5, 6, "png"),
            ("Acme & Co", 2, 2, "jpg"),
            ("Acme & Co", 4, 4, "png"),
            ("Acme & Co", 9, 9, "gif"),
        ]);
        assert!(read_pictures("shoes.csv", &book).is_empty());
        assert!(read_pictures("shoes.xlsx", b"not a zip").is_empty());
        let mut tabs = sample();
        tabs[1].name = "Acme & Co".into();
        let (mut m, rows) = read_manifest_rows(&tabs);
        let matched = match_pictures(&mut m, &rows, &tabs, &pics);
        assert_eq!(matched, vec![("t2r4".to_string(), 0), ("t2r6".to_string(), 1), ("t2r9".to_string(), 4)]);
        assert_eq!((m.pictures, m.pictures_left_out, m.tabs[1].pictures, m.tabs[0].pictures), (3, 2, 3, 0));
        assert_eq!(pics[4].bytes, b"GIF89a-gif-".to_vec());
    }

    #[test]
    fn a_picture_is_kept_only_under_its_delivery_with_a_safe_name() {
        assert_eq!(picture_rel("6f1c-ab", "t2r4", "jpg").as_deref(), Some("media/deliveries/6f1c-ab/t2r4.jpg"));
        assert!(picture_rel("../x", "t2r4", "jpg").is_none());
        assert!(picture_rel("a", "t2/r4", "jpg").is_none());
        assert!(picture_rel("a", "t2r4", "svg").is_none());
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
                std::fs::write(format!("{dir}/pics/{id}.{}", p.ext), &p.bytes).unwrap();
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
