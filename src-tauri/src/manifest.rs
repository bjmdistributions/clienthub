use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;

/// One breakdown row — used for both the by-category and by-brand groupings.
#[derive(Debug, Serialize)]
pub struct ManifestGroup {
    pub name: String,
    pub items: usize,
    pub total_retail: f64,
}

#[derive(Debug, Serialize)]
pub struct ManifestAnalysis {
    /// Items + retail grouped by the manifest's own category column when present,
    /// otherwise by a generic keyword guess (never the user's saved categories).
    pub categories: Vec<ManifestGroup>,
    /// Items + retail grouped by the manifest's own brand column. Empty when the
    /// CSV has no brand column.
    pub brands: Vec<ManifestGroup>,
    /// true when `categories` came from a category column ON the manifest; false
    /// when it fell back to the keyword guess.
    pub categories_from_manifest: bool,
    pub suggested_bid: f64,
    pub total_retail: f64,
    pub overall_margin_pct: f64,
    pub total_items: usize,
    pub skipped_rows: usize,
    pub formula: String,
}

#[derive(Debug, Clone)]
pub struct ParsedRow {
    pub description: String,
    pub quantity: f64,
    pub price: f64,
}

pub trait ManifestParser {
    fn parse(path: &str) -> Result<Vec<ParsedRow>>;
}

pub struct CsvManifestParser;
impl ManifestParser for CsvManifestParser {
    fn parse(path: &str) -> Result<Vec<ParsedRow>> {
        let mut rdr = csv::Reader::from_path(path).context("open csv")?;
        let headers: Vec<String> = rdr.headers()?.iter().map(|s| s.trim().to_lowercase()).collect();
        let desc_idx = headers.iter().position(|h| h.contains("desc") || h.contains("item") || h.contains("name") || h.contains("product"));
        let qty_idx = headers.iter().position(|h| h.contains("qty") || h.contains("quant") || h.contains("unit"));
        let price_idx = headers.iter().position(|h| h.contains("price") || h.contains("retail") || h.contains("value") || h.contains("cost"));
        let desc_idx = desc_idx.context("CSV must have a header row with columns like description, quantity, price")?;
        let mut rows = Vec::new();
        for result in rdr.records() {
            let record = result.context("read row")?;
            let desc = record.get(desc_idx).unwrap_or("").trim().to_string();
            if desc.is_empty() { continue; }
            let qty = qty_idx.and_then(|i| record.get(i)).and_then(|s| s.trim().parse().ok()).unwrap_or(1.0);
            let price = price_idx.and_then(|i| record.get(i)).and_then(|s| s.trim().replace("$", "").replace(",", "").parse().ok()).unwrap_or(0.0);
            if price <= 0.0 { continue; }
            rows.push(ParsedRow { description: desc, quantity: qty, price });
        }
        Ok(rows)
    }
}

pub struct PdfManifestParser;
impl ManifestParser for PdfManifestParser {
    fn parse(_path: &str) -> Result<Vec<ParsedRow>> {
        unimplemented!("PDF manifest parsing not yet supported")
    }
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

/// Find a column by header name: exact matches (in priority order) win over
/// substring matches, and any column already used for desc/qty/price/etc. is
/// excluded so e.g. an "item type" description column isn't mistaken for a category.
fn find_col(headers: &[String], candidates: &[&str], exclude: &[Option<usize>]) -> Option<usize> {
    let taken = |i: usize| exclude.iter().any(|u| *u == Some(i));
    for cand in candidates {
        if let Some(i) = headers.iter().position(|h| h == *cand) {
            if !taken(i) { return Some(i); }
        }
    }
    for cand in candidates {
        for (i, h) in headers.iter().enumerate() {
            if !taken(i) && h.contains(cand) { return Some(i); }
        }
    }
    None
}

pub fn analyze(path: &str) -> Result<ManifestAnalysis> {
    let mut rdr = csv::Reader::from_path(path).context("open csv")?;
    let headers: Vec<String> = rdr.headers()?
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();

    let desc_idx = headers.iter().position(|h| h.contains("desc") || h.contains("item") || h.contains("name") || h.contains("product"));
    let qty_idx = headers.iter().position(|h| h.contains("qty") || h.contains("quant") || h.contains("unit"));
    let price_idx = headers.iter().position(|h| h.contains("price") || h.contains("retail") || h.contains("value") || h.contains("cost"));

    let desc_idx = match desc_idx {
        Some(i) => i,
        None => anyhow::bail!("Could not detect columns. CSV must have a header row with columns like description, quantity, price."),
    };

    // Group by the manifest's OWN category / brand columns when present. These are
    // detected independently of desc/qty/price and each other so they never collide.
    let category_idx = find_col(&headers,
        &["category", "categories", "department", "dept", "class", "subclass", "segment", "division", "group", "type"],
        &[Some(desc_idx), qty_idx, price_idx]);
    let brand_idx = find_col(&headers,
        &["brand", "brands", "manufacturer", "mfg", "make", "vendor"],
        &[Some(desc_idx), qty_idx, price_idx, category_idx]);

    let keywords = keyword_map();
    let categories_from_manifest = category_idx.is_some();

    let mut cat_data: HashMap<String, ManifestGroup> = HashMap::new();
    let mut brand_data: HashMap<String, ManifestGroup> = HashMap::new();
    let mut total_items = 0usize;
    let mut total_retail = 0.0f64;
    let mut skipped_rows = 0usize;

    for result in rdr.records() {
        let record = match result {
            Ok(r) => r,
            Err(_) => { skipped_rows += 1; continue; }
        };
        let desc = record.get(desc_idx).map(|s| s.trim()).unwrap_or("").to_lowercase();
        if desc.is_empty() { skipped_rows += 1; continue; }

        let qty: f64 = qty_idx
            .and_then(|i| record.get(i))
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(1.0);
        if qty <= 0.0 { skipped_rows += 1; continue; }

        let price: f64 = match price_idx
            .and_then(|i| record.get(i))
            .and_then(|s| s.trim().replace("$", "").replace(",", "").parse().ok())
        {
            Some(p) if p > 0.0 => p,
            _ => { skipped_rows += 1; continue; }
        };

        let retail = qty * price;

        // Category: from the manifest's own column when present; otherwise a generic
        // keyword guess. The user's saved categories are intentionally NOT consulted.
        let cat = if let Some(ci) = category_idx {
            let v = record.get(ci).map(|s| s.trim()).unwrap_or("");
            if v.is_empty() { "Uncategorized".to_string() } else { v.to_string() }
        } else {
            let mut c = "Uncategorized".to_string();
            for (kw, cat_name) in &keywords {
                if desc.contains(kw) { c = cat_name.to_string(); break; }
            }
            c
        };
        let entry = cat_data.entry(cat.clone()).or_insert_with(|| ManifestGroup { name: cat, items: 0, total_retail: 0.0 });
        entry.items += 1;
        entry.total_retail += retail;

        // Brand: only when the manifest actually has a brand column.
        if let Some(bi) = brand_idx {
            let v = record.get(bi).map(|s| s.trim()).unwrap_or("");
            let bname = if v.is_empty() { "Unbranded".to_string() } else { v.to_string() };
            let e = brand_data.entry(bname.clone()).or_insert_with(|| ManifestGroup { name: bname, items: 0, total_retail: 0.0 });
            e.items += 1;
            e.total_retail += retail;
        }

        total_items += 1;
        total_retail += retail;
    }

    let overall_margin_pct: f64 = if let Ok(conn) = crate::db::pool().get() {
        conn.query_row(
            "SELECT COALESCE(AVG(margin), 30.0) FROM invoices WHERE is_complete=1 AND margin IS NOT NULL",
            [], |r| r.get(0),
        ).unwrap_or(30.0)
    } else { 30.0 };

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

    Ok(ManifestAnalysis {
        categories, brands, categories_from_manifest, suggested_bid, total_retail,
        overall_margin_pct, total_items, skipped_rows, formula,
    })
}
