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
    /// "csv" | "tsv" | "xlsx" | "pdf" | "pdf (AI)"
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
}

/// A manifest reduced to plain string cells, whatever it arrived as. CSV, TSV,
/// Excel and both PDF paths all produce one of these, so there is a single
/// analysis path underneath and every format gets identical maths.
struct Grid {
    /// Row 0 is not assumed to be the header — `find_header_row` locates it.
    rows: Vec<Vec<String>>,
    format: String,
    sheet: Option<String>,
    note: Option<String>,
    /// false for the PDF paths, whose header row is synthesised rather than read —
    /// reporting "header on row 1" for those would be a lie.
    header_in_file: bool,
}

fn extension(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// Parse a money/number cell. Strips currency symbols, thousands separators and
/// stray spaces, and reads `(123.45)` as negative. Deliberately strict after the
/// strip so a SKU like `B08N5` does not parse as a number.
fn parse_money(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let neg = t.starts_with('(') && t.ends_with(')');
    let core = t.trim_start_matches('(').trim_end_matches(')');
    let cleaned: String = core
        .chars()
        .filter(|c| !matches!(c, '$' | '£' | '€' | ',' | ' ' | '\u{a0}' | '%'))
        .collect();
    let v: f64 = cleaned.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(if neg { -v.abs() } else { v })
}

/// Summary lines and page furniture that are not products. A trailing
/// `TOTAL … $45,000` row would otherwise be counted as a product line and inflate
/// the retail, and a PDF's repeated `LOAD 4471 MANIFEST — PAGE 2` header would be
/// read as a $1 item.
fn is_summary_line(desc_lower: &str) -> bool {
    // Only at the start: "Total Gym fitness system" is a real product.
    const PREFIX: [&str; 6] = ["total", "subtotal", "sub total", "grand total", "sum of", "count of"];
    // Anywhere in the line: these only ever appear in headers and footers.
    const ANYWHERE: [&str; 4] = ["manifest", "page ", "continued", "printed on"];
    PREFIX.iter().any(|n| desc_lower.starts_with(n)) || ANYWHERE.iter().any(|n| desc_lower.contains(n))
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

/// Decode a text file. Manifests come out of Excel and Windows tools as often as
/// UTF-8, so a BOM is stripped and invalid bytes are replaced rather than failing.
fn read_text_lossy(path: &str) -> Result<String> {
    let bytes = std::fs::read(path).context("open the file")?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// Pick the delimiter by counting candidates over the first lines. A tab-delimited
/// manifest read as CSV collapses into one column, which is the most common reason
/// a "CSV" import silently fails.
fn sniff_delimiter(text: &str) -> u8 {
    let sample: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(20).collect();
    let count = |d: char| -> usize { sample.iter().map(|l| l.matches(d).count()).sum() };
    let candidates = [(b'\t', count('\t')), (b';', count(';')), (b'|', count('|')), (b',', count(','))];
    candidates
        .iter()
        .filter(|(_, n)| *n > 0)
        .max_by_key(|(_, n)| *n)
        .map(|(d, _)| *d)
        .unwrap_or(b',')
}

fn grid_from_delimited(path: &str) -> Result<Grid> {
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
    let mut wb = calamine::open_workbook_auto(path)
        .map_err(|e| anyhow::anyhow!("Couldn't open the spreadsheet: {}", e))?;
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
        Some(format!("{} sheets in the file — read the one with the most rows.", names.len()))
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

/// Find the header row. Real manifests open with a title, a blank line, or a legend,
/// so row 1 is only a guess — score the first 25 rows on how many manifest-ish
/// column names they hold and take the best one.
fn find_header_row(rows: &[Vec<String>]) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for (i, row) in rows.iter().take(25).enumerate() {
        let cells: Vec<String> = row.iter().map(|c| c.trim().to_lowercase()).collect();
        let nonempty = cells.iter().filter(|c| !c.is_empty()).count();
        if nonempty < 2 {
            continue;
        }
        // Header cells are labels, not data — a mostly-numeric row is a data row.
        let numeric = cells.iter().filter(|c| !c.is_empty() && parse_money(c).is_some()).count();
        if numeric * 2 > nonempty {
            continue;
        }
        let has = |kws: &[&str]| cells.iter().any(|c| kws.iter().any(|k| c.contains(k)));
        if !has(&["desc", "item", "name", "product", "title"]) {
            continue;
        }
        let mut score = 1;
        if has(&["qty", "quant", "pcs", "pieces", "count", "unit"]) { score += 1; }
        if has(&["price", "retail", "value", "cost", "msrp", "srp"]) { score += 1; }
        if has(&["categ", "department", "dept", "class", "segment"]) { score += 1; }
        if has(&["brand", "manufacturer", "mfg", "make", "vendor"]) { score += 1; }
        if best.map_or(true, |(_, b)| score > b) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

/// Find a column by header name: exact matches (in candidate priority order) win
/// over substring matches, and any column already used is excluded so e.g. an
/// "item type" description column isn't mistaken for a category.
fn find_col(headers: &[String], candidates: &[&str], exclude: &[Option<usize>]) -> Option<usize> {
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

fn keyword_map() -> HashMap<&'static str, &'static str> {
    [
        ("shoe", "Shoes"), ("sneaker", "Shoes"), ("boot", "Shoes"), ("sandal", "Shoes"),
        ("tv", "Electronics"), ("monitor", "Electronics"), ("laptop", "Electronics"),
        ("phone", "Electronics"), ("tablet", "Electronics"), ("camera", "Electronics"),
        ("speaker", "Electronics"), ("headphone", "Electronics"), ("charger", "Electronics"),
        ("shirt", "Clothing"), ("pants", "Clothing"), ("jacket", "Clothing"),
        ("dress", "Clothing"), ("sweater", "Clothing"), ("hoodie", "Clothing"),
        ("jean", "Clothing"), ("coat", "Clothing"), ("sock", "Clothing"),
        ("sofa", "Furniture"), ("chair", "Furniture"), ("table", "Furniture"),
        ("desk", "Furniture"), ("bed", "Furniture"), ("shelf", "Furniture"),
        ("toy", "Toys"), ("game", "Toys"), ("puzzle", "Toys"), ("doll", "Toys"),
        ("bag", "Accessories"), ("wallet", "Accessories"), ("watch", "Accessories"),
        ("jewelry", "Accessories"), ("belt", "Accessories"), ("hat", "Accessories"),
        ("kitchen", "Home & Kitchen"), ("cookware", "Home & Kitchen"), ("bakeware", "Home & Kitchen"),
        ("towel", "Home & Kitchen"), ("bath", "Home & Kitchen"), ("decor", "Home & Kitchen"),
        ("tool", "Tools & Hardware"), ("drill", "Tools & Hardware"), ("wrench", "Tools & Hardware"),
        ("hammer", "Tools & Hardware"), ("screwdriver", "Tools & Hardware"),
        ("beauty", "Health & Beauty"), ("cosmetic", "Health & Beauty"), ("skincare", "Health & Beauty"),
        ("makeup", "Health & Beauty"), ("shampoo", "Health & Beauty"),
        ("book", "Books & Media"), ("dvd", "Books & Media"), ("cd", "Books & Media"),
        ("pallet", "General Merchandise"), ("lot", "General Merchandise"),
        ("misc", "General Merchandise"), ("assorted", "General Merchandise"),
        ("mixed", "General Merchandise"), ("general", "General Merchandise"),
    ].into()
}

// ── Analysis (shared by every format) ───────────────────────────────────────

/// Average margin across completed deals — the basis for the suggested bid. Split
/// out so the analysis itself stays pure and testable without a live database.
fn avg_completed_margin() -> f64 {
    if let Ok(conn) = crate::db::pool().get() {
        conn.query_row(
            "SELECT COALESCE(AVG(margin), 30.0) FROM invoices WHERE is_complete=1 AND margin IS NOT NULL",
            [], |r| r.get(0),
        ).unwrap_or(30.0)
    } else { 30.0 }
}

fn analyze_grid(grid: Grid) -> Result<ManifestAnalysis> {
    analyze_grid_with_margin(grid, avg_completed_margin())
}

fn analyze_grid_with_margin(grid: Grid, overall_margin_pct: f64) -> Result<ManifestAnalysis> {
    let header_idx = find_header_row(&grid.rows).ok_or_else(|| {
        anyhow::anyhow!(
            "Couldn't find the column names in this {}. It needs a row of headers with \
             something like description, quantity and price on it.",
            grid.format
        )
    })?;
    let headers_raw: Vec<String> = grid.rows[header_idx].clone();
    let headers: Vec<String> = headers_raw.iter().map(|h| h.trim().to_lowercase()).collect();

    let desc_idx = find_col(
        &headers,
        &["description", "item description", "product description", "desc", "item name",
          "product name", "product", "item", "name", "title"],
        &[],
    )
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
    let qty_idx = find_col(
        &headers,
        &["qty", "quantity", "units", "unit count", "pcs", "pieces", "count", "quan", "unit"],
        &[Some(desc_idx), price_idx],
    );
    let category_idx = find_col(
        &headers,
        &["category", "categories", "department", "dept", "class", "subclass", "segment",
          "division", "group", "type"],
        &[Some(desc_idx), price_idx, qty_idx],
    );
    let brand_idx = find_col(
        &headers,
        &["brand", "brands", "manufacturer", "mfg", "make", "vendor"],
        &[Some(desc_idx), price_idx, qty_idx, category_idx],
    );

    // An extended/total column already has the quantity in it.
    let price_is_extended = price_idx
        .map(|i| {
            let h = &headers[i];
            (h.contains("ext") || h.contains("total") || h.contains("amount")) && !h.contains("unit")
        })
        .unwrap_or(false);

    let keywords = keyword_map();
    let categories_from_manifest = category_idx.is_some();

    let mut cat_data: HashMap<String, ManifestGroup> = HashMap::new();
    let mut brand_data: HashMap<String, ManifestGroup> = HashMap::new();
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
            let mut c = "Uncategorized".to_string();
            for (kw, cat_name) in &keywords {
                if desc.contains(kw) {
                    c = cat_name.to_string();
                    break;
                }
            }
            c
        };
        let entry = cat_data
            .entry(cat.clone())
            .or_insert_with(|| ManifestGroup { name: cat, items: 0, quantity: 0.0, total_retail: 0.0 });
        entry.items += 1;
        entry.quantity += qty;
        entry.total_retail += retail;

        // Brand: only when the manifest actually has a brand column.
        if let Some(bi) = brand_idx {
            let v = cell(bi);
            let bname = if v.is_empty() { "Unbranded".to_string() } else { v.to_string() };
            let e = brand_data
                .entry(bname.clone())
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
    let mut note = grid.note;
    if price_is_extended {
        let extra = "Price column holds an extended amount, so it was not multiplied by the quantity.";
        note = Some(match note {
            Some(n) => format!("{} {}", n, extra),
            None => extra.to_string(),
        });
    }
    if qty_idx.is_none() {
        let extra = "No quantity column found — every line counted as 1 unit.";
        note = Some(match note {
            Some(n) => format!("{} {}", n, extra),
            None => extra.to_string(),
        });
    }

    let detection = ManifestDetection {
        format: grid.format,
        sheet: grid.sheet,
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
    })
}

// ── PDF: text layer first, Claude when the layout defeats it ────────────────

async fn analyze_pdf(path: &str, force_ai: bool) -> Result<ManifestAnalysis> {
    let text = pdf_extract::extract_text(path).context("read the text out of that PDF")?;

    // A scan or a photo has no text layer. Say so — returning zero rows would look
    // like an empty manifest, and OCR is not something this path can do.
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 40 {
        anyhow::bail!(
            "This PDF has no text layer — it's a scan or a photo of a manifest, so there \
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
                note: Some("Read from the PDF's own text layer — check the units and retail against the document.".into()),
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

    let (ai_rows, truncated) = crate::ai::extract_manifest(&text)
        .await
        .map_err(|e| anyhow::anyhow!("Couldn't read product lines out of this PDF's layout. {}", e))?;
    if ai_rows.is_empty() {
        anyhow::bail!("Read the PDF's text but found no product lines in it.");
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

    let mut note = format!("Read by AI from the PDF's text — {} lines. Spot-check the totals against the document.", rows.len() - 1);
    if truncated {
        note.push_str(" The document was longer than one pass could cover, so the tail was NOT read — totals are incomplete.");
    }
    let mut a = analyze_grid(Grid {
        rows, format: "pdf (AI)".into(), sheet: None, note: Some(note), header_in_file: false,
    })?;
    // The AI is told to return a category only when the manifest states one, so an
    // empty column means the manifest had none — fall back to the keyword guess.
    if a.categories.len() == 1 && a.categories[0].name == "Uncategorized" {
        a.categories_from_manifest = false;
    }
    Ok(a)
}

/// Analyze a manifest in whatever form it arrived: CSV, TSV, plain text, Excel, or
/// PDF. `force_ai` re-reads a PDF through Claude when the text-layer heuristic got
/// it wrong.
pub async fn analyze(path: &str, force_ai: bool) -> Result<ManifestAnalysis> {
    match extension(path).as_str() {
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => analyze_grid(grid_from_excel(path)?),
        "pdf" => analyze_pdf(path, force_ai).await,
        // csv / tsv / txt / tab / dat / no extension — all delimited text.
        _ => analyze_grid(grid_from_delimited(path)?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_file_with_no_header_row_is_rejected_with_a_reason() {
        let err = analyze_grid_with_margin(grid_from_text("4,5,6\n7,8,9\n").unwrap(), 30.0)
            .unwrap_err()
            .to_string();
        assert!(err.contains("column names"), "err={}", err);
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
}
