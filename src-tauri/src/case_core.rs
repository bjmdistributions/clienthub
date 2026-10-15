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
//! and a size grid (a "Size" heading where the grid starts, or size names as headings). Rows
//! with no style that put labels in the grid are size headings: they name the grid's columns
//! for the rows under them, so one tab can hold baby, kids and adult scales. A row with one
//! word and nothing else is a group heading (KIDS, WOMEN'S). A tab with no Style column is
//! read only for its stated totals, which the preview checks the lines against.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

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

/// A heading that is a size by itself: 7, 8.5, XS, XL, 4C, 11Y, 2T.
fn looks_like_size(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    if t.is_empty() || t.len() > 6 {
        return false;
    }
    if money(&t).is_some() {
        return true;
    }
    if matches!(t.as_str(), "XXS" | "XS" | "S" | "M" | "L" | "XL" | "XXL" | "XXXL" | "2XL" | "3XL" | "OS" | "OSFA") {
        return true;
    }
    let (head, tail) = t.split_at(t.len() - 1);
    matches!(tail, "C" | "Y" | "T" | "W" | "M") && money(head).is_some()
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
        let total = h.iter().enumerate().skip(style + 1).find(|(_, x)| matches!(x.as_str(), "total" | "total pairs" | "pairs" | "qty" | "total qty" | "quantity")).map(|(c, _)| c);
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let end = total.unwrap_or(width);
        // A "Size" heading where the grid starts, or else sizes named as headings.
        let (grid_from, grid_to, scale) = if let Some(c) = h.iter().position(|x| x.contains("size")) {
            let scale = (c + 1..end).filter(|&k| looks_like_size(&rows[r][k])).map(|k| (k, rows[r][k].trim().to_string())).collect();
            (c, end, scale)
        } else {
            let named: Vec<(usize, String)> = (style + 1..end).filter(|&k| looks_like_size(&rows[r][k])).map(|k| (k, rows[r][k].trim().to_string())).collect();
            match (named.first(), named.last()) {
                (Some(a), Some(b)) => (a.0, b.0 + 1, named.clone()),
                _ => continue,
            }
        };
        if grid_from >= grid_to {
            continue;
        }
        return Some(Cols { header_row: r, style, color, description, color_name, cost, msrp, total, grid_from, grid_to, scale });
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
        let pairs_col = match h.iter().position(|x| x.contains("pair")) {
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

/// Read every tab of a manifest into lines. Nothing here is saved: the screen shows it first.
pub fn read_manifest(tabs: &[Tab]) -> ManifestRead {
    let mut lines: Vec<LoadLine> = Vec::new();
    let mut tab_reads = Vec::new();
    let mut mismatches = Vec::new();
    let mut warnings = Vec::new();
    let mut stated = None;
    for (ti, tab) in tabs.iter().enumerate() {
        let cols = match find_cols(&tab.rows) {
            Some(c) => c,
            None => {
                if stated.is_none() {
                    stated = stated_totals(tab);
                }
                let note = if stated.as_ref().map(|s| s.tab == tab.name).unwrap_or(false) { "Totals, checked against the lines" } else { "No Style column, so not read" };
                tab_reads.push(TabRead { name: tab.name.clone(), read: false, lines: 0, pairs: 0, note: note.into() });
                continue;
            }
        };
        let brand = one_line(&tab.name);
        let mut scale: Vec<(usize, String)> = cols.scale.clone();
        let mut group = String::new();
        let (mut n, mut pairs) = (0usize, 0i64);
        for r in cols.header_row + 1..tab.rows.len() {
            let row = &tab.rows[r];
            let style = one_line(&at(row, Some(cols.style)));
            let grid: Vec<(usize, String)> = (cols.grid_from..cols.grid_to.min(row.len()))
                .filter(|&c| !row[c].trim().is_empty())
                .map(|c| (c, row[c].trim().to_string()))
                .collect();
            if style.is_empty() {
                let filled: Vec<&String> = row.iter().filter(|c| !c.trim().is_empty()).collect();
                if !grid.is_empty() && grid.len() == filled.len() {
                    scale = grid;
                } else if filled.len() == 1 && num(filled[0]).is_none() && !is_total(filled[0]) {
                    group = one_line(filled[0]);
                }
                continue;
            }
            if is_total(&style) {
                continue;
            }
            let source = format!("{} row {}", tab.name, r + 1);
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
                }
            }
            lines.push(LoadLine {
                id,
                brand: brand.clone(),
                group: group.clone(),
                style,
                color: one_line(&at(row, cols.color)),
                description: one_line(&at(row, cols.description)),
                color_name: one_line(&at(row, cols.color_name)),
                cost: money(&at(row, cols.cost)).unwrap_or(0.0),
                msrp: money(&at(row, cols.msrp)).unwrap_or(0.0),
                sizes,
                sheet_total: total.unwrap_or(sum),
                source,
            });
            n += 1;
            pairs += sum;
        }
        tab_reads.push(TabRead { name: tab.name.clone(), read: true, lines: n, pairs, note: String::new() });
    }
    if lines.is_empty() {
        warnings.push("No line was read: no tab has a Style column with a size grid beside it.".into());
    }
    let pairs = lines.iter().map(|l| l.expected()).sum();
    ManifestRead { groups: group_counts(&lines), lines, tabs: tab_reads, mismatches, warnings, stated, pairs }
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
        for f in [&mut l.brand, &mut l.group, &mut l.color, &mut l.description, &mut l.color_name, &mut l.source] {
            *f = one_line(f);
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
    cases.iter().filter(|c| c.pallet == pallet && c.id != skip_id).map(|c| c.number).max().unwrap_or(0) + 1
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
    pub cases: usize,
    pub pairs: i64,
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
        let p = pallets.entry(c.pallet).or_insert((PalletSum { pallet: c.pallet, cases: 0, pairs: 0, styles: 0, cost: 0.0, msrp: 0.0 }, Vec::new()));
        p.0.cases += 1;
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
            p.0.cost += x.pairs as f64 * lines[k].cost;
            p.0.msrp += x.pairs as f64 * lines[k].msrp;
            if !p.1.contains(&k) {
                p.1.push(k);
            }
        }
    }
    let mut totals = Totals { lines: lines.len(), cases: cases.len(), pallets: pallets.len(), ..Default::default() };
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

    /// The real sheet, read locally only: `R519_SHEET=path cargo test real_manifest -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_manifest() {
        let path = std::env::var("R519_SHEET").expect("R519_SHEET");
        let bytes = std::fs::read(&path).unwrap();
        let m = read_manifest(&read_tabs(&path, &bytes).unwrap());
        println!("lines {} pairs {} stated {:?}", m.lines.len(), m.pairs, m.stated);
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
