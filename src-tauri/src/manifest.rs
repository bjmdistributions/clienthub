use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;

/// One breakdown row — used for both the by-category and by-brand groupings.
#[derive(Debug, Serialize)]
pub struct ManifestGroup {
    pub name: String,
    pub items: usize,       // number of manifest LINE ROWS in this group
    pub quantity: f64,      // sum of the quantity column across those rows (units)
    pub total_retail: f64,
}

/// What the parser actually did. Surfaced in the UI on purpose: accepting every file
/// format is worthless if a mis-detected price column is wrong in silence.
#[derive(Debug, Serialize)]
pub struct ManifestDetection {
    /// "csv" | "tsv" | "xlsx" | "pdf" — with " (AI)" appended when Claude read it.
    pub format: String,
    /// Spreadsheet tab the rows were read from.
    pub sheet: Option<String>,
    /// 1-based row the column names were found on. 0 when there was no header row
    /// to find (the PDF paths synthesise their own columns).
    pub header_row: usize,
    /// Original-case header text of each column that was used, so Jack can see that
    /// "Unit Retail" — not "Ext Retail" — was read as the price.
    pub description_col: Option<String>,
    pub quantity_col: Option<String>,
    pub price_col: Option<String>,
    pub category_col: Option<String>,
    pub brand_col: Option<String>,
    /// true when the price column holds an already-extended amount, so it was NOT
    /// multiplied by the quantity again.
    pub price_is_extended: bool,
    /// Honest caveats: AI extraction used, document longer than the chunk ceiling,
    /// PDF text layer read heuristically.
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ManifestAnalysis {
    /// Items + retail grouped by the manifest's own category column when present,
    /// otherwise by a generic keyword guess (never the user's saved categories).
    pub categories: Vec<ManifestGroup>,
    /// Items + retail grouped by the manifest's own brand column. Empty when the
    /// manifest has no brand column.
    pub brands: Vec<ManifestGroup>,
    /// true when `categories` came from a category column ON the manifest; false
    /// when it fell back to the keyword guess.
    pub categories_from_manifest: bool,
    pub suggested_bid: f64,
    pub total_retail: f64,
    pub overall_margin_pct: f64,
    /// Number of manifest LINE ROWS analyzed (one per product line).
    pub total_items: usize,
    /// Sum of the quantity column across all rows — the real unit count.
    pub total_quantity: f64,
    pub skipped_rows: usize,
    pub formula: String,
    pub detection: ManifestDetection,
    /// R-396: lines no category could be found for, and their retail, so the screen can
    /// say how much of the breakdown is guesswork.
    #[serde(default)]
    pub uncategorized_lines: usize,
    #[serde(default)]
    pub uncategorized_retail: f64,
    /// Lines whose category was read from the title rather than a category column.
    #[serde(default)]
    pub categories_guessed: usize,
    /// true when the brand table came (at least partly) from the titles.
    #[serde(default)]
    pub brands_from_titles: bool,
    /// Lines kept with no retail value (counted in units, not in retail).
    #[serde(default)]
    pub unpriced_lines: usize,
    /// What was left out and why ("Left out 1 total row ("TOTAL")."), replacing the old
    /// "N skipped (no price)" that was wrong for every reason but one.
    #[serde(default)]
    pub skipped_note: Option<String>,
}

/// A manifest reduced to plain string cells, whatever it arrived as. CSV, TSV,
/// Excel and both PDF paths all produce one of these, so there is a single
/// analysis path underneath and every format gets identical maths.
pub(crate) struct Grid {
    /// Row 0 is not assumed to be the header — `find_header_row` locates it.
    pub(crate) rows: Vec<Vec<String>>,
    format: String,
    sheet: Option<String>,
    note: Option<String>,
    /// false for the PDF paths, whose header row is synthesised rather than read —
    /// reporting "header on row 1" for those would be a lie.
    header_in_file: bool,
}

pub(crate) fn extension(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// Parse a money/number cell. Strips currency symbols and codes ("$", "USD 130.00",
/// "130.00 USD", "US$20"), thousands separators and stray spaces, reads `(123.45)` as
/// negative, and reads a European decimal comma ("130,50", "1.234,50") as a decimal.
/// Deliberately strict after the strip so a SKU like `B08N5` does not parse as a number.
pub(crate) fn parse_money(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let neg = t.starts_with('(') && t.ends_with(')');
    let mut core = t.trim_start_matches('(').trim_end_matches(')').trim_end_matches('*').trim().to_string();
    let upper = core.to_uppercase();
    for code in ["US$", "USD", "CAD", "C$", "AUD", "A$", "NZD", "EUR", "GBP", "MXN"] {
        if let Some(rest) = upper.strip_prefix(code) {
            core = rest.trim().to_string();
            break;
        }
        if let Some(rest) = upper.strip_suffix(code) {
            core = rest.trim().to_string();
            break;
        }
    }
    let mut cleaned: String = core
        .chars()
        .filter(|c| !matches!(c, '$' | '£' | '€' | '¥' | ' ' | '\u{a0}' | '%'))
        .collect();
    if cleaned.contains(',') {
        let last_comma = cleaned.rfind(',').unwrap();
        let after = &cleaned[last_comma + 1..];
        let grouped = cleaned.split(',').skip(1).all(|g| g.len() == 3 || (g.len() > 3 && g.as_bytes()[3] == b'.'));
        if let Some(dot) = cleaned.rfind('.') {
            cleaned = if dot > last_comma { cleaned.replace(',', "") } else { cleaned.replace('.', "").replace(',', ".") };
        } else if !grouped && cleaned.matches(',').count() == 1 && (1..=2).contains(&after.len()) {
            cleaned = cleaned.replace(',', ".");
        } else {
            cleaned = cleaned.replace(',', "");
        }
    }
    let v: f64 = cleaned.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(if neg { -v.abs() } else { v })
}

/// Summary lines and page furniture that are not products: "TOTAL", "Grand Total:",
/// "Pallet 3 Total", "Sub-Total", "TTL", "Total Pallets = 25", "Page 2 of 5", "Continued
/// on next page", a PDF's repeated "LOAD 4471 MANIFEST PAGE 2". Decided by whole words,
/// so "Total Gym", "Totally Awesome Slime", "Discontinued Colorway" and "200 Page
/// Notebook" stay products: every word of a summary line is a summary word or a number.
pub(crate) fn is_summary_line(desc_lower: &str) -> bool {
    const SUMMARY: &[&str] = &["total", "totals", "subtotal", "subtotals", "ttl", "grand", "sum", "summary", "overall"];
    const ALSO: &[&str] = &["sub", "pallet", "pallets", "load", "lot", "page", "pages", "manifest", "net", "est", "estimated",
        "ext", "extended", "retail", "qty", "quantity", "units", "unit", "value", "cost", "price", "amount", "of", "the",
        "and", "all", "items", "item", "lines", "line", "invoice", "order", "shipment", "truck", "box", "boxes",
        "carton", "cartons", "section", "count", "on", "next", "continued", "printed", "end", "for", "this", "msrp",
        "pcs", "pieces", "dollars", "usd"];
    let words: Vec<&str> = desc_lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    if words.is_empty() || words.len() > 8 {
        return false;
    }
    let known = |w: &&str| SUMMARY.contains(w) || ALSO.contains(w) || w.chars().all(|c| c.is_ascii_digit());
    if !words.iter().all(known) {
        return false;
    }
    // A total word, "Page 2 of 5", "Continued on next page", a pivot table's "Sum of Retail".
    words.iter().any(|w| SUMMARY.contains(w))
        || words.windows(2).any(|p| p[0] == "page" && p[1].chars().all(|c| c.is_ascii_digit()))
        || words.contains(&"continued")
        || (words.contains(&"manifest") && words.contains(&"page"))
}

/// A label that reads like a total but carries an id or a word the strict test does not
/// know: "Total for Pallet A", "Total Pallet 3A", "Subtotal - Pallet B", "Total: Pallet C".
/// A caller confirms it by the row's shape (no unit price, or figures that are the sums of
/// the rows above), since "Total Gym XLS" reads the same way.
pub(crate) fn looks_like_total(desc_lower: &str) -> bool {
    const SUMMARY: &[&str] = &["total", "totals", "subtotal", "subtotals", "ttl", "grand", "tot"];
    let words: Vec<&str> = desc_lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    !words.is_empty()
        && words.len() <= 6
        && (SUMMARY.contains(&words[0])
            || SUMMARY.contains(words.last().unwrap())
            || (words[0] == "sub" && words.get(1) == Some(&"total"))
            || (words.len() == 1 && matches!(words[0], "balance" | "combined" | "sum" | "summary")))
}

/// Read a line's trailing numbers by shape and report how many of them were used,
/// so any leading numbers stay part of the description. Returns (used, qty, price).
///
/// `Nike Air Max 90 sz 10  2  130.00  260.00` peels four numbers, and only the last
/// three are the figures — reading the run left-to-right would take 130 as the
/// quantity and report 137 units for a three-line manifest.
fn read_trailing_figures(n: &[f64]) -> (usize, f64, f64) {
    // `qty unit extended`, anchored to the RIGHT of the run: the rightmost adjacent
    // triple that multiplies out is the real quantity/price/amount.
    if n.len() >= 3 {
        let i = n.len() - 3;
        if n[i] > 0.0 && n[i + 1] > 0.0 && (n[i] * n[i + 1] - n[i + 2]).abs() <= 0.02 * n[i + 2].abs().max(1.0) {
            return (3, n[i], n[i + 1]);
        }
    }
    if n.len() >= 2 {
        let (a, b) = (n[n.len() - 2], n[n.len() - 1]);
        if a.fract() == 0.0 && a >= 1.0 && a < 100_000.0 {
            return (2, a, b); // `qty price`
        }
        if a > 0.0 && b >= a && (b / a).fract().abs() < 0.01 {
            return (2, (b / a).round(), a); // `unit_price extended`
        }
    }
    (1, 1.0, n[n.len() - 1])
}

// ── Input layer: one Grid per format ────────────────────────────────────────

/// Decode a text file. Manifests come out of Excel and Windows tools as often as UTF-8:
/// a UTF-16 file ("Unicode Text") is decoded as UTF-16, and bytes that are not UTF-8 are
/// read as Windows-1252 (Excel's own CSV encoding), so "Levi’s" keeps its apostrophe
/// instead of turning into a replacement mark.
fn read_text_lossy(path: &str) -> Result<String> {
    let bytes = std::fs::read(path).context("open the file")?;
    Ok(decode_text(&bytes))
}

pub(crate) fn decode_text(bytes: &[u8]) -> String {
    let utf16 = |b: &[u8], le: bool| -> String {
        let units: Vec<u16> = b.chunks(2).filter(|c| c.len() == 2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16_lossy(&units)
    };
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        utf16(&bytes[2..], true)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        utf16(&bytes[2..], false)
    } else if bytes.len() >= 4 && bytes.iter().take(200).skip(1).step_by(2).all(|b| *b == 0) {
        utf16(bytes, true)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => bytes.iter().map(|&b| cp1252(b)).collect(),
        }
    };
    text.trim_start_matches('\u{feff}').to_string()
}

/// One Windows-1252 byte as its character.
fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—',
        '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }
}

/// Pick the delimiter that splits the first lines into the most consistent number of
/// columns, counting only separators outside quotes: a comma CSV whose titles carry pipes
/// or semicolons ("Nike | Dri-FIT | Shorts") is still a comma CSV. Comma wins a tie.
fn sniff_delimiter(text: &str) -> u8 {
    let sample: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(20).collect();
    let outside = |line: &str, d: char| -> usize {
        let mut quoted = false;
        let mut n = 0;
        for c in line.chars() {
            if c == '"' {
                quoted = !quoted;
            } else if c == d && !quoted {
                n += 1;
            }
        }
        n
    };
    let mut best: Option<(u8, (usize, usize))> = None;
    for (d, c) in [(b',', ','), (b'\t', '\t'), (b';', ';'), (b'|', '|')] {
        let counts: Vec<usize> = sample.iter().map(|l| outside(l, c)).collect();
        let mut freq: HashMap<usize, usize> = HashMap::new();
        for &n in counts.iter().filter(|n| **n > 0) {
            *freq.entry(n).or_insert(0) += 1;
        }
        let Some((&cols, &lines)) = freq.iter().max_by_key(|(n, k)| (**k, **n)) else { continue };
        let score = (lines, cols);
        if best.map_or(true, |(_, b)| score > b) {
            best = Some((d, score));
        }
    }
    best.map(|(d, _)| d).unwrap_or(b',')
}

pub(crate) fn grid_from_delimited(path: &str) -> Result<Grid> {
    grid_from_text(&read_text_lossy(path)?)
}

fn grid_from_text(text: &str) -> Result<Grid> {
    let delim = sniff_delimiter(text);
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        // We locate the header ourselves — row 1 is often a title.
        .has_headers(false)
        // Ragged rows are normal in real manifests (title rows, trailing totals).
        // Without this the whole file errors on the first short row.
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut rows: Vec<Vec<String>> = Vec::new();
    for result in rdr.records() {
        let rec = match result {
            Ok(r) => r,
            Err(_) => continue,
        };
        rows.push(rec.iter().map(|c| c.trim().to_string()).collect());
    }

    let (format, note) = match delim {
        b'\t' => ("tsv".to_string(), None),
        b';' => ("csv".to_string(), Some("Semicolon-delimited.".to_string())),
        b'|' => ("csv".to_string(), Some("Pipe-delimited.".to_string())),
        _ => ("csv".to_string(), None),
    };
    Ok(Grid { rows, format, sheet: None, note, header_in_file: true })
}

/// The first table of an HTML page as rows of cell text: what many exports save and name
/// .xls. Tags inside a cell are dropped and the common entities decoded.
pub(crate) fn grid_from_html(html: &str) -> Option<Grid> {
    let row_re = regex::Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").ok()?;
    let cell_re = regex::Regex::new(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>").ok()?;
    let tag_re = regex::Regex::new(r"(?s)<[^>]*>").ok()?;
    let text = |s: &str| -> String {
        tag_re
            .replace_all(s, " ")
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut rows: Vec<Vec<String>> = row_re
        .captures_iter(html)
        .map(|r| cell_re.captures_iter(&r[1]).map(|c| text(&c[1])).collect::<Vec<String>>())
        .filter(|r| !r.is_empty())
        .collect();
    // Excel 2003's XML spreadsheet ("<Row><Cell><Data>"), also often saved as .xls.
    if rows.is_empty() {
        let xrow = regex::Regex::new(r"(?is)<(?:ss:)?Row[^>]*>(.*?)</(?:ss:)?Row>").ok()?;
        let xcell = regex::Regex::new(r"(?is)<(?:ss:)?Cell[^>]*?(?:/>|>(.*?)</(?:ss:)?Cell>)").ok()?;
        rows = xrow
            .captures_iter(html)
            .map(|r| xcell.captures_iter(&r[1]).map(|c| c.get(1).map(|m| text(m.as_str())).unwrap_or_default()).collect::<Vec<String>>())
            .filter(|r| r.iter().any(|c| !c.is_empty()))
            .collect();
    }
    if rows.is_empty() {
        return None;
    }
    Some(Grid { rows, format: "html".into(), sheet: None, note: None, header_in_file: true })
}

fn cell_text(d: &calamine::Data) -> String {
    use calamine::Data;
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        // Excel stores every number as a float; 250.0 must not read as "250.0".
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{}", f)
            }
        }
        other => other.to_string(),
    }
}

fn grid_from_excel(path: &str) -> Result<Grid> {
    use calamine::Reader;
    let mut wb = match calamine::open_workbook_auto(path) {
        Ok(wb) => wb,
        Err(e) => {
            // Many exports write CSV or an HTML table and call it .xls.
            let text = decode_text(&std::fs::read(path).context("open the file")?);
            if text.to_lowercase().contains("<table") {
                return grid_from_html(&text).context("Couldn't find a table in that file.");
            }
            if text.lines().take(5).any(|l| l.contains(',') || l.contains('\t') || l.contains(';')) {
                return grid_from_text(&text);
            }
            anyhow::bail!("Couldn't open the spreadsheet: {}", e);
        }
    };
    let names: Vec<String> = wb.sheet_names().to_vec();
    if names.is_empty() {
        anyhow::bail!("That spreadsheet has no sheets in it.");
    }

    // Manifests routinely arrive with a cover or summary tab first, so take the
    // sheet with the most real data rows rather than the first one.
    let mut best: Option<(String, Vec<Vec<String>>, usize)> = None;
    for name in &names {
        let range = match wb.worksheet_range(name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rows: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(cell_text).collect()).collect();
        let score = rows.iter().filter(|r| r.iter().filter(|c| !c.is_empty()).count() >= 2).count();
        if best.as_ref().map_or(true, |(_, _, b)| score > *b) {
            best = Some((name.clone(), rows, score));
        }
    }

    let (sheet, rows, _) = best.context("Couldn't read any sheet out of that spreadsheet.")?;
    let note = if names.len() > 1 {
        Some(format!("{} sheets in the file. Read the one with the most rows.", names.len()))
    } else {
        None
    };
    Ok(Grid { rows, format: extension(path), sheet: Some(sheet), note, header_in_file: true })
}

/// Pull product lines out of flattened PDF text. A manifest line ends in numbers —
/// `… description  QTY  UNIT  EXTENDED`, `… description  QTY  PRICE`, or just
/// `… description  PRICE` — so the trailing numeric run is peeled off the end and
/// read by its shape. Returns synthetic description/quantity/price rows.
fn pdf_rows(text: &str) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 2 {
            continue;
        }

        // Peel numeric tokens off the end (at most 4 — beyond that it is a table of
        // figures, not a product line).
        let mut nums: Vec<f64> = Vec::new();
        let mut end = tokens.len();
        while end > 0 && nums.len() < 4 {
            match parse_money(tokens[end - 1]) {
                Some(v) => {
                    nums.push(v);
                    end -= 1;
                }
                None => break,
            }
        }
        nums.reverse();
        if nums.is_empty() || end == 0 {
            continue;
        }

        let (used, qty, price) = read_trailing_figures(&nums);
        // Numbers the figures didn't claim belong to the description — a shoe size or
        // a model number, not a quantity.
        let desc = tokens[..end + (nums.len() - used)].join(" ");
        // A description needs real words: a row of codes and figures is not a line.
        if desc.chars().filter(|c| c.is_alphabetic()).count() < 3 {
            continue;
        }
        if is_summary_line(&desc.to_lowercase()) {
            continue;
        }
        if qty <= 0.0 || price <= 0.0 {
            continue;
        }
        out.push(vec![desc, format!("{}", qty), format!("{}", price)]);
    }
    out
}

fn synthetic_header(with_cat_brand: bool) -> Vec<String> {
    let mut h: Vec<String> = vec!["description".into(), "quantity".into(), "price".into()];
    if with_cat_brand {
        h.push("category".into());
        h.push("brand".into());
    }
    h
}

// ── Column detection ────────────────────────────────────────────────────────

/// Find the header row. Real manifests open with a title, a blank line, a legend or a
/// block of load details, so row 1 is only a guess: score the first 200 rows on the column
/// names they hold, whole words only, and on how many product rows run on under them. A
/// row with a description column, or with two other known column names, can be the
/// header, even when its size columns are numbers ("Style, Description, 6, 7, 8, 9").
pub(crate) fn find_header_row(rows: &[Vec<String>]) -> Option<usize> {
    let words = |c: &str| -> Vec<String> {
        c.to_lowercase().split(|ch: char| !ch.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.to_string()).collect()
    };
    let mut best: Option<(usize, usize)> = None;
    let key = |r: &Vec<String>| r.iter().map(|c| c.trim().to_lowercase()).collect::<Vec<_>>();
    for (i, row) in rows.iter().take(200).enumerate() {
        let cells: Vec<Vec<String>> = row.iter().map(|c| words(c)).collect();
        let nonempty = row.iter().filter(|c| !c.trim().is_empty()).count();
        if nonempty < 2 {
            continue;
        }
        let has = |kws: &[&str]| cells.iter().any(|ws| ws.iter().any(|w| kws.contains(&w.as_str())));
        let desc = has(&["description", "desc", "title", "name", "product", "model", "style", "article", "details", "merchandise"])
            || row.iter().any(|c| c.trim().eq_ignore_ascii_case("item"));
        let mut known = 0;
        if has(&["qty", "quantity", "quan", "units", "pcs", "pieces", "count", "pairs", "qoh"]) { known += 1; }
        if has(&["price", "retail", "value", "cost", "msrp", "srp", "rrp", "ext", "amount"]) { known += 1; }
        if has(&["category", "categories", "department", "dept", "class"]) { known += 1; }
        if has(&["brand", "manufacturer", "mfg", "mfr", "make", "vendor"]) { known += 1; }
        if has(&["upc", "sku", "asin", "ean"]) { known += 1; }
        // Header cells are labels, not data: a mostly-numeric row is a data row unless it
        // also names its columns (a size-run header).
        let numeric = row.iter().filter(|c| !c.trim().is_empty() && parse_money(c).is_some()).count();
        if numeric * 2 > nonempty && !(desc && known >= 1) {
            continue;
        }
        if !desc && known < 2 {
            continue;
        }
        let run = rows[i + 1..].iter().take(20).take_while(|r| r.iter().filter(|c| !c.trim().is_empty()).count() >= 2).count();
        let score = if desc { 4 } else { 0 } + known * 2 + run.min(10);
        // A tie goes to the later row (a block of load details sits above the header, never
        // below it), except a repeat of the same header further down a multi-page export.
        let better = match best {
            None => true,
            Some((bi, b)) => score > b || (score == b && key(&rows[bi]) != key(row)),
        };
        if better {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

/// Find a column by header name: exact matches (in candidate priority order) win
/// over substring matches, and any column already used is excluded so e.g. an
/// "item type" description column isn't mistaken for a category.
pub(crate) fn find_col(headers: &[String], candidates: &[&str], exclude: &[Option<usize>]) -> Option<usize> {
    let taken = |i: usize| exclude.iter().any(|u| *u == Some(i));
    for cand in candidates {
        if let Some(i) = headers.iter().position(|h| h == *cand) {
            if !taken(i) {
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

/// The category a title reads as when the sheet gives none: `manifest_category.rs`, shared
/// byte for byte with the server (R-396).
pub(crate) use crate::manifest_category::guess_category;

// ── Analysis (shared by every format) ───────────────────────────────────────

/// Average margin across completed deals, the basis for the suggested bid. Voided invoices
/// are left out, as the server's copy (the phone's analyzer) leaves them out, so the same
/// manifest suggests the same bid on both. Split out so the analysis itself stays pure and
/// testable without a live database.
fn avg_completed_margin() -> f64 {
    if let Ok(conn) = crate::db::pool().get() {
        conn.query_row(
            "SELECT COALESCE(AVG(margin), 30.0) FROM invoices \
             WHERE is_complete=1 AND margin IS NOT NULL AND COALESCE(voided,0)=0",
            [], |r| r.get(0),
        ).unwrap_or(30.0)
    } else { 30.0 }
}

fn analyze_grid(grid: Grid) -> Result<ManifestAnalysis> {
    analyze_grid_with_margin(grid, avg_completed_margin())
}

/// Header-row analysis first; when the file simply has no header row, fall back to
/// inferring which columns hold the description, quantity and price from the data
/// itself. A manifest without headers still gets a breakdown — with the guess
/// spelled out in the detection so it is never wrong in silence.
fn analyze_grid_with_margin(grid: Grid, overall_margin_pct: f64) -> Result<ManifestAnalysis> {
    let had_header = find_header_row(&grid.rows).is_some();
    let first_err = match analyze_rows(&grid, overall_margin_pct) {
        Ok(a) => return Ok(a),
        Err(e) => e,
    };
    // A file WITH a header row that still failed has a data problem — guessing
    // columns over it would produce confident nonsense. Only headerless files
    // fall through to inference.
    if had_header {
        return Err(first_err);
    }
    let Some(inf) = infer_columns(&grid.rows) else { return Err(first_err) };
    let mut rows = vec![synthetic_header(false)];
    for r in &grid.rows {
        let cell = |i: usize| r.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
        let desc = cell(inf.desc);
        if desc.is_empty() {
            continue;
        }
        let qty = match inf.qty {
            Some(i) => cell(i),
            None => "1".to_string(),
        };
        rows.push(vec![desc, qty, cell(inf.price)]);
    }
    let col = |i: usize| format!("column {}", i + 1);
    let inferred = format!(
        "No header row, so the columns were inferred from the data itself (description: {}, \
         quantity: {}, price: {}). Check the totals against the file.",
        col(inf.desc),
        inf.qty.map(col).unwrap_or_else(|| "none found, 1 unit per line".to_string()),
        col(inf.price)
    );
    let note = Some(match &grid.note {
        Some(n) => format!("{} {}", n, inferred),
        None => inferred,
    });
    let inferred_grid = Grid {
        rows,
        format: grid.format.clone(),
        sheet: grid.sheet.clone(),
        note,
        header_in_file: false,
    };
    analyze_rows(&inferred_grid, overall_margin_pct).map_err(|_| first_err)
}

/// Columns picked out of the data itself for a file with no header row.
pub(crate) struct InferredCols {
    pub(crate) desc: usize,
    pub(crate) qty: Option<usize>,
    pub(crate) price: usize,
}

/// Work out which columns hold the description, quantity and price by looking at
/// the data: the wordiest column is the description, and the numeric columns are
/// read by shape — `qty × unit ≈ extended` pins all three at once, a whole-number
/// column is a quantity, and a 12-digit column is a UPC, not money.
pub(crate) fn infer_columns(rows: &[Vec<String>]) -> Option<InferredCols> {
    #[derive(Default, Clone)]
    struct Tally {
        nonempty: usize,
        numeric: usize,
        ints: usize,
        big: usize,
        texty: usize,
        alpha: usize,
        sum: f64,
    }

    let data: Vec<&Vec<String>> = rows
        .iter()
        .filter(|r| r.iter().filter(|c| !c.trim().is_empty()).count() >= 2)
        .take(500)
        .collect();
    if data.len() < 2 {
        return None;
    }
    let ncols = data.iter().map(|r| r.len()).max()?;
    let mut cols = vec![Tally::default(); ncols];
    for r in &data {
        for (i, t) in cols.iter_mut().enumerate() {
            let c = r.get(i).map(|s| s.trim()).unwrap_or("");
            if c.is_empty() {
                continue;
            }
            t.nonempty += 1;
            if let Some(v) = parse_money(c) {
                t.numeric += 1;
                t.sum += v;
                if v.fract() == 0.0 {
                    t.ints += 1;
                }
                if v.abs() >= 1e8 {
                    t.big += 1; // UPC/EAN-sized — a barcode, not money or a count
                }
            } else {
                let letters = c.chars().filter(|ch| ch.is_alphabetic()).count();
                if letters >= 3 {
                    t.texty += 1;
                    t.alpha += letters;
                }
            }
        }
    }

    // Description: most letters overall (not most rows), so a short brand column
    // never beats the real description column.
    let desc = (0..ncols)
        .filter(|&i| cols[i].texty >= 2 && cols[i].texty * 2 > cols[i].nonempty)
        .max_by_key(|&i| cols[i].alpha)?;

    // Numeric candidates: mostly numbers, and not a column of barcodes.
    let nums: Vec<usize> = (0..ncols)
        .filter(|&i| {
            i != desc
                && cols[i].numeric >= 2
                && cols[i].numeric * 2 > cols[i].nonempty
                && cols[i].big * 2 < cols[i].numeric
        })
        .collect();
    let mean = |c: usize| cols[c].sum / cols[c].numeric as f64;
    let all_int = |c: usize| cols[c].ints == cols[c].numeric;

    // `qty × unit ≈ extended` holding across the rows pins all three columns.
    for a in 0..nums.len() {
        for b in (a + 1)..nums.len() {
            for &e in &nums {
                let (i, j) = (nums[a], nums[b]);
                if e == i || e == j {
                    continue;
                }
                let (mut tried, mut hit) = (0usize, 0usize);
                for r in &data {
                    let get = |c: usize| r.get(c).and_then(|s| parse_money(s));
                    if let (Some(x), Some(y), Some(z)) = (get(i), get(j), get(e)) {
                        if x <= 0.0 || y <= 0.0 {
                            continue;
                        }
                        tried += 1;
                        if (x * y - z).abs() <= 0.02 * z.abs().max(1.0) {
                            hit += 1;
                        }
                    }
                }
                if tried >= 2 && hit * 5 >= tried * 4 {
                    // x·y = y·x, so the product can't say which one is the quantity —
                    // whole numbers and the smaller average can.
                    let (q, p) = match (all_int(i), all_int(j)) {
                        (true, false) => (i, j),
                        (false, true) => (j, i),
                        _ if mean(i) <= mean(j) => (i, j),
                        _ => (j, i),
                    };
                    return Some(InferredCols { desc, qty: Some(q), price: p });
                }
            }
        }
    }

    match nums.len() {
        0 => None,
        1 => Some(InferredCols { desc, qty: None, price: nums[0] }),
        _ => {
            // A quantity is whole numbers with the smallest average.
            let qty = nums
                .iter()
                .copied()
                .filter(|&c| all_int(c) && mean(c) < 100_000.0)
                .min_by(|&x, &y| mean(x).partial_cmp(&mean(y)).unwrap_or(std::cmp::Ordering::Equal));
            match qty {
                Some(q) => {
                    let price = nums.iter().copied().filter(|&c| c != q).last()?;
                    Some(InferredCols { desc, qty: Some(q), price })
                }
                // Two money columns and no whole-number one: the rightmost is the
                // amount, and every line counts as 1 unit.
                None => Some(InferredCols { desc, qty: None, price: *nums.last()? }),
            }
        }
    }
}

/// Header names for each column the analyzer reads, in priority order. Shared with the
/// split (`manifest_split.rs`) so both read the same column as the description,
/// quantity, category and brand.
pub(crate) const DESC_COLS: &[&str] = &["description", "item description", "product description", "desc",
    "item name", "product name", "product", "item", "name", "title"];
pub(crate) const QTY_COLS: &[&str] = &["qty", "quantity", "units", "unit count", "pcs", "pieces", "count", "quan", "unit"];
pub(crate) const CATEGORY_COLS: &[&str] = &["category", "categories", "department", "dept", "class", "subclass",
    "segment", "division", "group", "type"];
pub(crate) const BRAND_COLS: &[&str] = &["brand", "brands", "manufacturer", "mfg", "make", "vendor"];

fn analyze_rows(grid: &Grid, overall_margin_pct: f64) -> Result<ManifestAnalysis> {
    let header_idx = find_header_row(&grid.rows).ok_or_else(|| {
        anyhow::anyhow!(
            "Couldn't find the column names in this {}. It needs a row of headers with \
             something like description, quantity and price on it.",
            grid.format
        )
    })?;
    let headers_raw: Vec<String> = grid.rows[header_idx].clone();
    let headers: Vec<String> = headers_raw.iter().map(|h| h.trim().to_lowercase()).collect();

    let desc_idx = find_col(&headers, DESC_COLS, &[])
    .ok_or_else(|| {
        anyhow::anyhow!(
            "Found a header row but no description column. Columns seen: {}",
            headers_raw.iter().filter(|h| !h.is_empty()).cloned().collect::<Vec<_>>().join(", ")
        )
    })?;

    // Price BEFORE quantity, and both through `find_col`, so a "Unit Price" column
    // can never be claimed as the quantity — the old substring scan on "unit" did
    // exactly that and then multiplied the price by itself.
    // Unit-price candidates come first: retail is qty x price, so picking an
    // already-extended column and multiplying again would double the totals.
    let price_idx = find_col(
        &headers,
        &["unit retail", "unit price", "retail price", "unit cost", "msrp", "srp",
          "price", "retail", "value", "cost", "ext retail", "extended retail",
          "total retail", "ext price", "amount"],
        &[Some(desc_idx)],
    );
    let qty_idx = find_col(&headers, QTY_COLS, &[Some(desc_idx), price_idx]);
    let category_idx = find_col(&headers, CATEGORY_COLS, &[Some(desc_idx), price_idx, qty_idx]);
    let brand_idx = find_col(&headers, BRAND_COLS, &[Some(desc_idx), price_idx, qty_idx, category_idx]);

    // An extended/total column already has the quantity in it.
    let price_is_extended = price_idx
        .map(|i| {
            let h = &headers[i];
            (h.contains("ext") || h.contains("total") || h.contains("amount")) && !h.contains("unit")
        })
        .unwrap_or(false);

    let categories_from_manifest = category_idx.is_some();

    // Grouped by the split's spelling-folded keys (R-386), so "NIKE", "Nike" and "Nike, Inc."
    // are one brand here as they are in the split, each group named by its most used
    // spelling once every line is in.
    let mut cat_data: HashMap<String, ManifestGroup> = HashMap::new();
    let mut brand_data: HashMap<String, ManifestGroup> = HashMap::new();
    let mut cat_names: HashMap<String, HashMap<String, usize>> = HashMap::new();
    let mut brand_names: HashMap<String, HashMap<String, usize>> = HashMap::new();
    let mut total_items = 0usize;
    let mut total_quantity = 0.0f64;
    let mut total_retail = 0.0f64;
    let mut skipped_rows = 0usize;

    for record in grid.rows.iter().skip(header_idx + 1) {
        let cell = |i: usize| record.get(i).map(|s| s.trim()).unwrap_or("");

        let desc_raw = cell(desc_idx);
        if desc_raw.is_empty() {
            continue; // blank spacer row — not a skipped product line
        }
        let desc = desc_raw.to_lowercase();
        if is_summary_line(&desc) {
            skipped_rows += 1;
            continue;
        }

        let qty: f64 = qty_idx.and_then(|i| parse_money(cell(i))).unwrap_or(1.0);
        if qty <= 0.0 {
            skipped_rows += 1;
            continue;
        }

        let price: f64 = match price_idx.and_then(|i| parse_money(cell(i))) {
            Some(p) if p > 0.0 => p,
            _ => {
                skipped_rows += 1;
                continue;
            }
        };

        let retail = if price_is_extended { price } else { qty * price };

        // Category: from the manifest's own column when present; otherwise a generic
        // keyword guess. The user's saved categories are intentionally NOT consulted.
        let cat = if let Some(ci) = category_idx {
            let v = cell(ci);
            if v.is_empty() { "Uncategorized".to_string() } else { v.to_string() }
        } else {
            guess_category(&desc).to_string()
        };
        let cat_key = crate::manifest_split::category_group_key(&cat);
        *cat_names.entry(cat_key.clone()).or_default().entry(cat.clone()).or_insert(0) += 1;
        let entry = cat_data
            .entry(cat_key)
            .or_insert_with(|| ManifestGroup { name: cat, items: 0, quantity: 0.0, total_retail: 0.0 });
        entry.items += 1;
        entry.quantity += qty;
        entry.total_retail += retail;

        // Brand: only when the manifest actually has a brand column.
        if let Some(bi) = brand_idx {
            let v = cell(bi);
            // "N/A", "Generic" and a blank are all Unbranded, under the empty key.
            let (bkey, bname) = match crate::manifest_split::brand_group_key(v) {
                Some(k) => (k, v.to_string()),
                None => (String::new(), "Unbranded".to_string()),
            };
            if !bkey.is_empty() {
                *brand_names.entry(bkey.clone()).or_default().entry(bname.clone()).or_insert(0) += 1;
            }
            let e = brand_data
                .entry(bkey)
                .or_insert_with(|| ManifestGroup { name: bname, items: 0, quantity: 0.0, total_retail: 0.0 });
            e.items += 1;
            e.quantity += qty;
            e.total_retail += retail;
        }

        total_items += 1;
        total_quantity += qty;
        total_retail += retail;
    }

    if total_items == 0 {
        anyhow::bail!(
            "Read the columns but found no priced product lines ({} rows skipped). \
             Check that the price column has values in it.",
            skipped_rows
        );
    }

    let suggested_bid = (total_retail * overall_margin_pct / 100.0 * 0.85 * 100.0).round() / 100.0;

    let sort_desc = |mut v: Vec<ManifestGroup>| -> Vec<ManifestGroup> {
        v.sort_by(|a, b| b.total_retail.partial_cmp(&a.total_retail).unwrap_or(std::cmp::Ordering::Equal));
        v
    };
    for (k, g) in cat_data.iter_mut() {
        if let Some(sp) = cat_names.get(k) {
            g.name = crate::manifest_split::category_group_name(sp);
        }
    }
    for (k, g) in brand_data.iter_mut() {
        if let Some(sp) = brand_names.get(k) {
            g.name = crate::manifest_split::brand_group_name(sp);
        }
    }
    let categories = sort_desc(cat_data.into_values().collect());
    let brands = sort_desc(brand_data.into_values().collect());

    let margin_source = if overall_margin_pct == 30.0 { "(default, no completed deals yet)" } else { "" };
    let formula = format!("Total retail ${:.0} × {:.0}% margin {} × 0.85 buffer = suggested bid ${:.0}",
        total_retail, overall_margin_pct, margin_source, suggested_bid);

    // The read-out reports names, not indexes, so a wrong guess is visible.
    let label = |i: Option<usize>| -> Option<String> {
        i.and_then(|i| headers_raw.get(i))
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
    };
    let mut note = grid.note.clone();
    if price_is_extended {
        let extra = "Price column holds an extended amount, so it was not multiplied by the quantity.";
        note = Some(match note {
            Some(n) => format!("{} {}", n, extra),
            None => extra.to_string(),
        });
    }
    if qty_idx.is_none() {
        let extra = "No quantity column found, so every line counted as 1 unit.";
        note = Some(match note {
            Some(n) => format!("{} {}", n, extra),
            None => extra.to_string(),
        });
    }

    let detection = ManifestDetection {
        format: grid.format.clone(),
        sheet: grid.sheet.clone(),
        // 1-based, and 0 for the synthesised PDF grids whose header is not in the file.
        header_row: if grid.header_in_file { header_idx + 1 } else { 0 },
        description_col: label(Some(desc_idx)),
        quantity_col: label(qty_idx),
        price_col: label(price_idx),
        category_col: label(category_idx),
        brand_col: label(brand_idx),
        price_is_extended,
        note,
    };

    Ok(ManifestAnalysis {
        categories, brands, categories_from_manifest, suggested_bid, total_retail,
        overall_margin_pct, total_items, total_quantity, skipped_rows, formula, detection,
        uncategorized_lines: 0, uncategorized_retail: 0.0, categories_guessed: 0, brands_from_titles: false,
        unpriced_lines: 0, skipped_note: None,
    })
}

/// The analyzer's breakdown of a spreadsheet or CSV, from the split's own reading of it
/// (R-396): the same columns, the same lines, brands read from titles, categories filled
/// line by line. Before this the two screens read one file two ways and disagreed on the
/// price column, the line count, the units and the brands.
pub(crate) fn from_breakdown(b: crate::manifest_split::Breakdown, overall_margin_pct: f64) -> Result<ManifestAnalysis> {
    let mut cat_data: HashMap<String, ManifestGroup> = HashMap::new();
    let mut brand_data: HashMap<String, ManifestGroup> = HashMap::new();
    let (mut total_quantity, mut total_retail) = (0.0f64, 0.0f64);
    let (mut uncategorized_lines, mut uncategorized_retail, mut unpriced_lines) = (0usize, 0.0f64, 0usize);
    let any_brand = b.lines.iter().any(|l| l.brand.is_some());
    for l in &b.lines {
        let (ck, cn) = l.category.clone().unwrap_or_else(|| (String::new(), "Uncategorized".into()));
        if l.category.is_none() {
            uncategorized_lines += 1;
            uncategorized_retail += l.retail;
        }
        let e = cat_data.entry(ck).or_insert_with(|| ManifestGroup { name: cn, items: 0, quantity: 0.0, total_retail: 0.0 });
        e.items += 1;
        e.quantity += l.qty;
        e.total_retail += l.retail;
        if any_brand {
            let (bk, bn) = l.brand.clone().unwrap_or_else(|| (String::new(), "Unbranded".into()));
            let e = brand_data.entry(bk).or_insert_with(|| ManifestGroup { name: bn, items: 0, quantity: 0.0, total_retail: 0.0 });
            e.items += 1;
            e.quantity += l.qty;
            e.total_retail += l.retail;
        }
        if l.retail <= 0.0 {
            unpriced_lines += 1;
        }
        total_quantity += l.qty;
        total_retail += l.retail;
    }
    let sort_desc = |mut v: Vec<ManifestGroup>| -> Vec<ManifestGroup> {
        v.sort_by(|a, b| b.total_retail.partial_cmp(&a.total_retail).unwrap_or(std::cmp::Ordering::Equal));
        v
    };
    let suggested_bid = (total_retail * overall_margin_pct / 100.0 * 0.85 * 100.0).round() / 100.0;
    let margin_source = if overall_margin_pct == 30.0 { "(default, no completed deals yet)" } else { "" };
    let formula = format!("Total retail ${:.0} × {:.0}% margin {} × 0.85 buffer = suggested bid ${:.0}",
        total_retail, overall_margin_pct, margin_source, suggested_bid);
    let total_items = b.lines.len();
    let categories_guessed = total_items - b.from_sheet - uncategorized_lines;
    let note = if b.notes.is_empty() { None } else { Some(b.notes.join(" ")) };
    Ok(ManifestAnalysis {
        categories: sort_desc(cat_data.into_values().collect()),
        brands: sort_desc(brand_data.into_values().collect()),
        categories_from_manifest: b.category_col.is_some() && b.from_sheet * 2 >= total_items,
        suggested_bid,
        total_retail,
        overall_margin_pct,
        total_items,
        total_quantity,
        skipped_rows: 0,
        formula,
        detection: ManifestDetection {
            format: b.format,
            sheet: b.sheet,
            header_row: b.header_row,
            description_col: b.description_col,
            quantity_col: b.quantity_col,
            price_col: b.price_col,
            category_col: b.category_col,
            brand_col: b.brand_col,
            price_is_extended: b.price_is_extended,
            note,
        },
        uncategorized_lines,
        uncategorized_retail,
        categories_guessed,
        brands_from_titles: b.brands_read > 0,
        unpriced_lines,
        skipped_note: b.left_out,
    })
}

// ── PDF: text layer first, Claude when the layout defeats it ────────────────

async fn analyze_pdf(path: &str, force_ai: bool) -> Result<ManifestAnalysis> {
    let text = pdf_extract::extract_text(path).context("read the text out of that PDF")?;

    // A scan or a photo has no text layer. Say so — returning zero rows would look
    // like an empty manifest, and OCR is not something this path can do.
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 40 {
        anyhow::bail!(
            "This PDF has no text layer. It's a scan or a photo of a manifest, so there \
             are no rows to read out of it. Send the spreadsheet or CSV version, or use \
             Paste a load with the image instead."
        );
    }

    if !force_ai {
        let mut rows = pdf_rows(&text);
        if rows.len() >= 3 {
            let mut all = vec![synthetic_header(false)];
            all.append(&mut rows);
            let grid = Grid {
                rows: all,
                format: "pdf".into(),
                sheet: None,
                note: Some("Read from the PDF's own text layer. Check the units and retail against the document.".into()),
                header_in_file: false,
            };
            // A layout the heuristic mis-reads produces a grid that analyses fine but
            // says very little, so fall through to the AI path rather than trusting it.
            if let Ok(a) = analyze_grid(grid) {
                if a.total_items >= 3 && a.total_retail > 0.0 {
                    return Ok(a);
                }
            }
        }
    }

    analyze_via_ai(&text, "pdf (AI)", None).await
}

/// Last resort for any format: have Claude read the raw text and return product
/// lines. Used when a PDF's layout defeats the heuristic, and when a spreadsheet
/// or CSV defeats both the header scan and column inference.
async fn analyze_via_ai(text: &str, format_label: &str, sheet: Option<String>) -> Result<ManifestAnalysis> {
    let (ai_rows, truncated) = crate::ai::extract_manifest(text)
        .await
        .map_err(|e| anyhow::anyhow!("Couldn't read product lines out of this document's layout. {}", e))?;
    if ai_rows.is_empty() {
        anyhow::bail!("Read the document's text but found no product lines in it.");
    }

    let field = |v: &serde_json::Value, k: &str| -> String {
        match v.get(k) {
            Some(serde_json::Value::String(s)) => s.trim().to_string(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }
    };
    let mut rows = vec![synthetic_header(true)];
    for r in &ai_rows {
        let desc = field(r, "description");
        if desc.is_empty() {
            continue;
        }
        let qty = field(r, "quantity");
        rows.push(vec![
            desc,
            if qty.is_empty() { "1".to_string() } else { qty },
            field(r, "price"),
            field(r, "category"),
            field(r, "brand"),
        ]);
    }

    let mut note = format!("Read by AI from the document's text: {} lines. Spot-check the totals against the document.", rows.len() - 1);
    if truncated {
        note.push_str(" The document was longer than one pass could cover, so the tail was NOT read. Totals are incomplete.");
    }
    let mut a = analyze_grid(Grid {
        rows, format: format_label.to_string(), sheet, note: Some(note), header_in_file: false,
    })?;
    // The AI is told to return a category only when the manifest states one, so an
    // empty column means the manifest had none — fall back to the keyword guess.
    if a.categories.len() == 1 && a.categories[0].name == "Uncategorized" {
        a.categories_from_manifest = false;
    }
    Ok(a)
}

/// Spreadsheets and delimited text: the grid path first (header scan, then column
/// inference), and Claude as the last resort — an unrecognizable layout gets a
/// breakdown instead of a refusal. `force_ai` skips straight to the AI read.
async fn analyze_tabular(grid: Grid, force_ai: bool) -> Result<ManifestAnalysis> {
    let flat: String = grid.rows.iter().map(|r| r.join("\t")).collect::<Vec<_>>().join("\n");
    let label = format!("{} (AI)", grid.format);
    let sheet = grid.sheet.clone();
    if force_ai {
        return analyze_via_ai(&flat, &label, sheet).await;
    }
    let err = match analyze_grid(grid) {
        Ok(a) => return Ok(a),
        Err(e) => e,
    };
    analyze_via_ai(&flat, &label, sheet)
        .await
        .map_err(|ai| anyhow::anyhow!("{} The AI fallback couldn't read it either: {}", err, ai))
}

/// Analyze a manifest in whatever form it arrived: CSV, TSV, plain text, Excel, or
/// PDF. `force_ai` re-reads the file through Claude when the heuristics got it wrong.
pub async fn analyze(path: &str, force_ai: bool) -> Result<ManifestAnalysis> {
    match extension(path).as_str() {
        "pdf" => analyze_pdf(path, force_ai).await,
        // Excel, CSV, TSV, text: read the way the split reads it (R-396).
        _ => analyze_sheet(path, force_ai).await,
    }
}

/// A spreadsheet or CSV: the split's own reading of it, so the breakdown and the split
/// agree on every line (R-396). Claude only when asked, or when that reading fails.
async fn analyze_sheet(path: &str, force_ai: bool) -> Result<ManifestAnalysis> {
    let grid = || match extension(path).as_str() {
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => grid_from_excel(path),
        _ => grid_from_delimited(path),
    };
    if force_ai {
        return analyze_tabular(grid()?, true).await;
    }
    let err = match crate::manifest_split::breakdown(path).and_then(|b| from_breakdown(b, avg_completed_margin())) {
        Ok(a) => return Ok(a),
        Err(e) => e,
    };
    let g = grid()?;
    let flat: String = g.rows.iter().map(|r| r.join("\t")).collect::<Vec<_>>().join("\n");
    let label = format!("{} (AI)", g.format);
    analyze_via_ai(&flat, &label, g.sheet.clone())
        .await
        .map_err(|ai| anyhow::anyhow!("{} The AI fallback couldn't read it either: {}", err, ai))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R-386: the breakdown folds spellings the way the split does, so the two agree.
    #[test]
    fn the_breakdown_folds_brand_and_category_spellings() {
        let csv = "Description,Brand,Category,Qty,Unit Retail\n\
Air Max,NIKE,Home & Kitchen,1,100\n\
Dri-Fit Tee,Nike,home and kitchen,2,20\n\
Duffel,\"Nike, Inc.\",Home & Kitchen,1,45\n\
Mystery box,N/A,Toys,1,10\n\
Plain tote,,Toys,1,5\n";
        let a = analyze_grid_with_margin(grid_from_text(csv).unwrap(), 30.0).unwrap();
        let brands: Vec<(&str, usize)> = a.brands.iter().map(|b| (b.name.as_str(), b.items)).collect();
        assert_eq!(brands, vec![("Nike", 3), ("Unbranded", 2)]);
        let cats: Vec<(&str, usize)> = a.categories.iter().map(|c| (c.name.as_str(), c.items)).collect();
        assert_eq!(cats, vec![("Home & Kitchen", 3), ("Toys", 2)]);
    }

    /// A real supplier manifest: a title row, a blank row, the header on row 4, and a
    /// grand-total row at the bottom. Every one of those breaks a row-1-is-the-header
    /// parser, and the ragged rows break `csv::Reader` unless it is flexible.
    const MESSY_CSV: &str = "LOAD #4471 — CUSTOMER RETURNS MANIFEST\n\
,,,,\n\
Prepared for BJM Distributions\n\
Item Description,Brand,Category,Qty,Unit Retail,Ext Retail\n\
Apple AirPods Pro 2nd Gen,Apple,Electronics,4,\"$249.00\",\"$996.00\"\n\
Nike Air Max 90 sz 10,Nike,Footwear,2,$130.00,$260.00\n\
Ninja Blender BN701,Ninja,Home & Kitchen,3,\"$1,099.50\",\"$3,298.50\"\n\
,,,,\n\
GRAND TOTAL,,,9,,\"$4,554.50\"\n";

    fn analyze_csv(text: &str) -> ManifestAnalysis {
        analyze_grid_with_margin(grid_from_text(text).unwrap(), 30.0).unwrap()
    }

    #[test]
    fn finds_a_header_below_title_rows_and_skips_the_total() {
        let a = analyze_csv(MESSY_CSV);
        assert_eq!(a.detection.header_row, 4, "header should be found on row 4");
        assert_eq!(a.total_items, 3, "3 product lines, not the title or total rows");
        assert_eq!(a.total_quantity, 9.0);
        // 4x249 + 2x130 + 3x1099.50 = 996 + 260 + 3298.50
        assert!((a.total_retail - 4554.50).abs() < 0.01, "retail={}", a.total_retail);
        assert_eq!(a.skipped_rows, 1, "the GRAND TOTAL row is a skip, not a product");
    }

    #[test]
    fn prefers_unit_retail_over_the_extended_column() {
        // The bug this guards: reading "Ext Retail" as the price and multiplying it by
        // the quantity again, which would report $17,447 instead of $4,554.
        let a = analyze_csv(MESSY_CSV);
        assert_eq!(a.detection.price_col.as_deref(), Some("Unit Retail"));
        assert!(!a.detection.price_is_extended);
        assert_eq!(a.detection.quantity_col.as_deref(), Some("Qty"));
        assert_eq!(a.detection.category_col.as_deref(), Some("Category"));
        assert_eq!(a.detection.brand_col.as_deref(), Some("Brand"));
    }

    #[test]
    fn a_unit_price_column_is_never_read_as_the_quantity() {
        // The old substring scan matched "unit" first, so "Unit Price" became the
        // quantity column AND the price column — retail came out as price x price.
        let csv = "Description,Unit Price,Pieces\n\
Cordless drill,45.00,10\n";
        let a = analyze_csv(csv);
        assert_eq!(a.detection.price_col.as_deref(), Some("Unit Price"));
        assert_eq!(a.detection.quantity_col.as_deref(), Some("Pieces"));
        assert_eq!(a.total_quantity, 10.0);
        assert!((a.total_retail - 450.0).abs() < 0.01, "retail={}", a.total_retail);
    }

    #[test]
    fn an_extended_only_column_is_not_multiplied_by_quantity() {
        // No unit price anywhere: the amount already includes the quantity.
        let csv = "Item,Qty,Ext Retail\n\
Mixed apparel carton,24,1200.00\n";
        let a = analyze_csv(csv);
        assert!(a.detection.price_is_extended);
        assert_eq!(a.total_quantity, 24.0);
        assert!((a.total_retail - 1200.0).abs() < 0.01, "retail={}", a.total_retail);
    }

    #[test]
    fn tab_and_semicolon_delimited_files_are_detected() {
        let tsv = "Description\tQty\tPrice\nBluetooth speaker\t5\t39.99\n";
        let a = analyze_csv(tsv);
        assert_eq!(a.detection.format, "tsv");
        assert_eq!(a.total_quantity, 5.0);
        assert!((a.total_retail - 199.95).abs() < 0.01, "retail={}", a.total_retail);

        let scsv = "Description;Qty;Price\nLaptop sleeve;3;12.50\n";
        let b = analyze_csv(scsv);
        assert_eq!(b.total_items, 1);
        assert!((b.total_retail - 37.50).abs() < 0.01, "retail={}", b.total_retail);
    }

    #[test]
    fn a_missing_quantity_column_counts_one_unit_per_line_and_says_so() {
        let csv = "Product,Retail\nGaming chair,189.00\nDesk lamp,24.00\n";
        let a = analyze_csv(csv);
        assert_eq!(a.detection.quantity_col, None);
        assert_eq!(a.total_quantity, 2.0);
        assert!(a.detection.note.unwrap().contains("1 unit"));
    }

    #[test]
    fn a_file_of_bare_numbers_is_still_rejected_with_a_reason() {
        // Nothing here can be a description, so inference must refuse too — turning
        // pure figures into a confident breakdown would be worse than the error.
        let err = analyze_grid_with_margin(grid_from_text("4,5,6\n7,8,9\n").unwrap(), 30.0)
            .unwrap_err()
            .to_string();
        assert!(err.contains("column names"), "err={}", err);
    }

    #[test]
    fn a_headerless_manifest_is_inferred_from_the_data() {
        // The R-160 file shape: no header row anywhere, straight into product lines.
        let csv = "Apple AirPods Pro 2nd Gen,4,249.00\n\
Nike Air Max 90 sz 10,2,130.00\n\
Ninja Blender BN701,3,1099.50\n";
        let a = analyze_csv(csv);
        assert_eq!(a.detection.header_row, 0, "an inferred header is not in the file");
        assert_eq!(a.total_items, 3);
        assert_eq!(a.total_quantity, 9.0);
        assert!((a.total_retail - 4554.50).abs() < 0.01, "retail={}", a.total_retail);
        let note = a.detection.note.unwrap();
        assert!(note.contains("inferred"), "note must say the columns were guessed: {}", note);
    }

    #[test]
    fn headerless_inference_reads_upc_qty_unit_ext_by_shape() {
        // A UPC column parses as a huge number — it must never be read as the price,
        // and qty x unit = ext pins the three money columns.
        let csv = "085911253007,Ninja Blender BN701,3,99.00,297.00\n\
194512345678,Nike Air Max 90 sz 10,2,130.00,260.00\n";
        let a = analyze_csv(csv);
        assert_eq!(a.total_items, 2);
        assert_eq!(a.total_quantity, 5.0);
        assert!((a.total_retail - 557.0).abs() < 0.01, "retail={}", a.total_retail);
    }

    #[test]
    fn a_headered_file_that_fails_on_data_is_not_guessed_over() {
        // Header found but every price cell empty: the error must be the honest one —
        // inference over a file like this would invent a price column.
        let err = analyze_grid_with_margin(
            grid_from_text("Description,Qty,Price\nBroken pallet,3,\nBent pallet,2,\n").unwrap(),
            30.0,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("no priced product lines"), "err={}", err);
    }

    #[test]
    fn priced_lines_are_required_before_reporting_a_bid() {
        let err = analyze_grid_with_margin(
            grid_from_text("Description,Qty,Price\nBroken pallet,3,\n").unwrap(), 30.0,
        ).unwrap_err().to_string();
        assert!(err.contains("no priced product lines"), "err={}", err);
    }

    #[test]
    fn money_cells_parse_but_skus_do_not() {
        assert_eq!(parse_money("$1,234.56"), Some(1234.56));
        assert_eq!(parse_money("(45.00)"), Some(-45.0));
        assert_eq!(parse_money(" 250 "), Some(250.0));
        // A part number must not parse as a number, or it poisons header detection
        // and gets read as a price.
        assert_eq!(parse_money("B08N5KWB9H"), None);
        assert_eq!(parse_money("12-345"), None);
        assert_eq!(parse_money(""), None);
    }

    #[test]
    fn pdf_lines_are_read_by_the_shape_of_their_trailing_numbers() {
        let text = "LOAD 4471 MANIFEST — PAGE 1\n\
DESCRIPTION QTY UNIT EXT\n\
Apple AirPods Pro 2nd Gen 4 249.00 996.00\n\
Nike Air Max 90 sz 10 2 130.00\n\
Ninja Blender BN701 89.99\n\
GRAND TOTAL 1385.99\n";
        let rows = pdf_rows(text);
        assert_eq!(rows.len(), 3, "got {:?}", rows);
        // qty / unit / extended — the first two multiply out to the third.
        assert_eq!(rows[0][1], "4");
        assert_eq!(rows[0][2], "249");
        assert!(rows[0][0].contains("AirPods"));
        // qty / price — and the shoe size stays in the description instead of being
        // swallowed as a quantity.
        assert_eq!(rows[1][1], "2");
        assert_eq!(rows[1][2], "130");
        assert_eq!(rows[1][0], "Nike Air Max 90 sz 10");
        // price only — one unit
        assert_eq!(rows[2][1], "1");
        assert_eq!(rows[2][2], "89.99");
    }

    #[test]
    fn pdf_rows_analyze_end_to_end() {
        let text = "Apple AirPods Pro 2nd Gen 4 249.00 996.00\n\
Nike Air Max 90 sz 10 2 130.00 260.00\n\
Ninja Blender BN701 3 99.00 297.00\n";
        let mut rows = pdf_rows(text);
        let mut all = vec![synthetic_header(false)];
        all.append(&mut rows);
        let a = analyze_grid_with_margin(
            Grid { rows: all, format: "pdf".into(), sheet: None, note: None, header_in_file: false },
            30.0,
        ).unwrap();
        assert_eq!(a.detection.header_row, 0, "a synthesised header is not in the file");
        assert_eq!(a.total_items, 3);
        assert_eq!(a.total_quantity, 9.0);
        assert!((a.total_retail - 1553.0).abs() < 0.01, "retail={}", a.total_retail);
        // No category column on a PDF, so the keyword guess is used — and labelled.
        assert!(!a.categories_from_manifest);
    }

    #[test]
    fn excel_round_trips_through_calamine() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        let sheet = wb.add_worksheet();
        // Same shape as the messy CSV: a title row, a gap, then the real header.
        sheet.write_string(0, 0, "LOAD #4471 — MANIFEST").unwrap();
        for (col, h) in ["Item Description", "Brand", "Qty", "Unit Retail"].iter().enumerate() {
            sheet.write_string(2, col as u16, *h).unwrap();
        }
        sheet.write_string(3, 0, "Apple AirPods Pro 2nd Gen").unwrap();
        sheet.write_string(3, 1, "Apple").unwrap();
        sheet.write_number(3, 2, 4.0).unwrap();
        sheet.write_number(3, 3, 249.0).unwrap();
        sheet.write_string(4, 0, "Nike Air Max 90").unwrap();
        sheet.write_string(4, 1, "Nike").unwrap();
        sheet.write_number(4, 2, 2.0).unwrap();
        sheet.write_number(4, 3, 130.0).unwrap();

        let path = std::env::temp_dir().join("ecliptr-manifest-test.xlsx");
        wb.save(&path).unwrap();
        let p = path.to_string_lossy().to_string();

        let a = analyze_grid_with_margin(grid_from_excel(&p).unwrap(), 30.0).unwrap();
        assert_eq!(a.detection.format, "xlsx");
        assert_eq!(a.detection.header_row, 3);
        assert_eq!(a.total_items, 2);
        assert_eq!(a.total_quantity, 6.0);
        // Excel holds 4 as 4.0 — it must not read as "4.0" and fail to parse.
        assert!((a.total_retail - 1256.0).abs() < 0.01, "retail={}", a.total_retail);
        assert_eq!(a.brands.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    /// R-396: money as suppliers write it.
    #[test]
    fn money_is_read_the_way_suppliers_write_it() {
        assert_eq!(parse_money("$1,234.50"), Some(1234.5));
        assert_eq!(parse_money("130,50"), Some(130.5));
        assert_eq!(parse_money("1.234,50"), Some(1234.5));
        assert_eq!(parse_money("1,234"), Some(1234.0));
        assert_eq!(parse_money("USD 130.00"), Some(130.0));
        assert_eq!(parse_money("130.00 USD"), Some(130.0));
        assert_eq!(parse_money("US$20"), Some(20.0));
        assert_eq!(parse_money("12.99*"), Some(12.99));
        assert_eq!(parse_money("(12.00)"), Some(-12.0));
        assert_eq!(parse_money("$-"), None);
        assert_eq!(parse_money("B08N5"), None);
    }

    /// A total row is a row of summary words and numbers; a product that starts with
    /// "Total" or says "Discontinued" is not one.
    #[test]
    fn total_rows_are_told_from_products_by_their_words() {
        for t in ["TOTAL", "Totals:", "Grand Total", "Sub-Total", "Pallet 3 Total", "TTL", "Total Pallets = 25", "Page 2 of 5",
            "Continued on next page", "Load 4471 Manifest Page 2", "Sum of Retail"] {
            assert!(is_summary_line(&t.to_lowercase()), "{t}");
        }
        for t in ["Total Gym Fitness System XLS", "Totally Awesome Slime Kit", "Nike Air Force 1 Discontinued Colorway",
            "Composition Notebook 200 Page", "Total 90 III Black/White", "Count of Monte Cristo Book", "Adidas Manifest Tote"] {
            assert!(!is_summary_line(&t.to_lowercase()), "{t}");
        }
    }

    #[test]
    fn the_delimiter_is_counted_outside_quotes() {
        let csv = "Description,Qty,Retail\n\"Nike | Dri-FIT | Game | Shorts Black M\",2,35\n\"Nike | Club | Tee\",1,30\n";
        assert_eq!(sniff_delimiter(csv), b',');
        assert_eq!(sniff_delimiter("Description;Qty;Retail\nNike Air Max 90;2;130,00\n"), b';');
    }

    #[test]
    fn windows_and_utf16_text_is_decoded() {
        // "Levi’s" as Excel's Windows-1252 CSV writes it.
        assert_eq!(decode_text(&[b'L', b'e', b'v', b'i', 0x92, b's']), "Levi’s");
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("Qty\t2".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(decode_text(&utf16), "Qty\t2");
    }
}
