//! Invoice module: PDF generation via `printpdf` (pure Rust, no external binaries).
//!
//! Layout (top to bottom):
//!   - Logo (if configured) at top-left
//!   - Company info (name + address + email + phone) below logo
//!   - INVOICE title + number on the right
//!   - Horizontal divider
//!   - Bill-To block (left) + Issue/Due dates (right)
//!   - Line items table with Description / Qty / Rate / Amount
//!   - Subtotal / Tax / Total rows
//!   - Payment Options (active payment_methods rows)
//!   - Footer: thank-you note + tax ID
//!   - Watermark: PAID (green) or OVERDUE (red) diagonal stamp
//!
//! Supports multi-page output when line items overflow.

use anyhow::{Context, Result};
use chrono::Utc;
use printpdf::*;
use serde::{Deserialize, Serialize};
use std::io::BufWriter;

use crate::db::pool;

// ---------- Types ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineItem {
    pub description: String,
    pub qty: f64,
    pub rate: f64,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyInfo {
    pub name: String,
    pub address: String,
    pub email: String,
    pub phone: Option<String>,
    pub tax_id: Option<String>,
    pub logo_path: Option<String>,
    /// When a logo is present, whether to also print the company name as
    /// text. Defaults to true. Missing in older saved settings → None → true.
    #[serde(default)]
    pub show_company_name: Option<bool>,
}

pub struct ClientAddress {
    pub lines: Vec<String>,
}

// ---------- Invoice branding / template ----------

/// User-configurable invoice branding, stored as JSON in settings key
/// `invoice_template`. Container-level `#[serde(default)]` fills ANY missing field
/// from the `Default` impl below, so old/partial saved JSON (and an absent key)
/// always yields the documented defaults — which are chosen so invoices look
/// ~identical to today until the user changes something.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct InvoiceTemplate {
    /// "left" | "center" | "right"
    pub logo_placement: String,
    /// "small" | "medium" | "large"
    pub logo_size: String,
    /// Print the company name text (migrated from company_info.show_company_name
    /// when the template key is absent — see `load_template`).
    pub show_company_name: bool,
    pub show_address: bool,
    pub show_email: bool,
    pub show_phone: bool,
    pub show_tax_id: bool,
    /// Hex accent color, e.g. "#111827" (near-black → looks like today).
    pub accent_color: String,
    /// Top-right title, default "INVOICE".
    pub title_label: String,
    /// Optional muted note at the page bottom.
    pub footer_note: String,
}

impl Default for InvoiceTemplate {
    fn default() -> Self {
        InvoiceTemplate {
            logo_placement: "left".into(),
            logo_size: "medium".into(),
            show_company_name: true,
            show_address: true,
            show_email: true,
            show_phone: true,
            show_tax_id: true,
            accent_color: "#111827".into(),
            title_label: "INVOICE".into(),
            footer_note: String::new(),
        }
    }
}

impl InvoiceTemplate {
    /// Logo box scale factor for the configured size.
    fn logo_size_factor(&self) -> f32 {
        match self.logo_size.as_str() {
            "small" => 0.7,
            "large" => 1.4,
            _ => 1.0, // medium / anything unknown
        }
    }
    /// Accent color parsed to a printpdf fill/outline color (near-black on bad input).
    fn accent(&self) -> Color {
        parse_hex_color(&self.accent_color)
    }
}

/// Parse `#RRGGBB` / `RRGGBB` (and short `#RGB`) into a printpdf RGB Color with
/// components in 0..1. Falls back to near-black (`#111827`) on anything invalid, so
/// a bad value can never break rendering.
fn parse_hex_color(s: &str) -> Color {
    fn near_black() -> Color { Color::Rgb(Rgb::new(0.067, 0.094, 0.153, None)) } // #111827
    let hex = s.trim().trim_start_matches('#');
    let full = match hex.len() {
        6 => hex.to_string(),
        3 => hex.chars().flat_map(|c| [c, c]).collect::<String>(), // #abc -> #aabbcc
        _ => return near_black(),
    };
    let comp = |i: usize| u8::from_str_radix(&full[i..i + 2], 16).ok().map(|v| v as f32 / 255.0);
    match (comp(0), comp(2), comp(4)) {
        (Some(r), Some(g), Some(b)) => Color::Rgb(Rgb::new(r, g, b, None)),
        _ => near_black(),
    }
}

/// Load the invoice branding template. Precedence:
///   - settings `invoice_template` present → parse it (missing fields → defaults);
///     if that JSON has NO `show_company_name` key, migrate it from
///     `company_info.show_company_name`.
///   - settings key absent entirely → defaults, with `show_company_name` taken
///     from `company_info.show_company_name` (backwards-compatible migration).
/// Never fails — returns defaults on any error.
pub fn load_template() -> InvoiceTemplate {
    let raw: Option<String> = pool().get().ok().and_then(|conn| {
        conn.query_row("SELECT value FROM settings WHERE key='invoice_template'", [], |r| r.get::<_, String>(0)).ok()
    });
    // The template's own `show_company_name` default is true; migrate from
    // company_info only when the template didn't specify it.
    let company_scn = load_company().ok().and_then(|c| c.show_company_name);
    match raw {
        Some(json) => {
            let mut tpl: InvoiceTemplate = serde_json::from_str(&json).unwrap_or_default();
            let has_key = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v.get("show_company_name").cloned())
                .is_some();
            if !has_key {
                if let Some(scn) = company_scn { tpl.show_company_name = scn; }
            }
            tpl
        }
        None => {
            let mut tpl = InvoiceTemplate::default();
            if let Some(scn) = company_scn { tpl.show_company_name = scn; }
            tpl
        }
    }
}

pub fn save_template(tpl: &InvoiceTemplate) -> Result<()> {
    let conn = pool().get()?;
    let json = serde_json::to_string(tpl)?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('invoice_template',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json],
    )?;
    Ok(())
}

/// Load the QUOTE branding template (settings key `quote_template`). Reuses the
/// `InvoiceTemplate` shape — the two documents share every branding field. The only
/// difference is the default title: quotes read "QUOTE" (not "INVOICE") when the key is
/// absent or the saved JSON never specified a title. Never fails — defaults on any error.
pub fn load_quote_template() -> InvoiceTemplate {
    let raw: Option<String> = pool().get().ok().and_then(|conn| {
        conn.query_row("SELECT value FROM settings WHERE key='quote_template'", [], |r| r.get::<_, String>(0)).ok()
    });
    match raw {
        Some(json) => {
            let mut tpl: InvoiceTemplate = serde_json::from_str(&json).unwrap_or_default();
            let has_title = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v.get("title_label").cloned())
                .is_some();
            if !has_title { tpl.title_label = "QUOTE".into(); }
            tpl
        }
        None => {
            let mut tpl = InvoiceTemplate::default();
            tpl.title_label = "QUOTE".into();
            tpl
        }
    }
}

pub fn save_quote_template(tpl: &InvoiceTemplate) -> Result<()> {
    let conn = pool().get()?;
    let json = serde_json::to_string(tpl)?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('quote_template',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json],
    )?;
    Ok(())
}

/// Render a SAMPLE quote PDF using the current company_info + `quote_template` and dummy
/// data. Mirrors `render_sample_pdf` but with `kind="quote"`, so the quote branding editor
/// previews the real layout. Writes to app-data and returns the path.
pub fn render_sample_quote_pdf() -> Result<String> {
    let company = load_company()?;
    let items = vec![
        LineItem { description: "Website design & build".into(), qty: 1.0, rate: 2400.00, amount: 2400.00 },
        LineItem { description: "Monthly hosting & maintenance".into(), qty: 3.0, rate: 120.00, amount: 360.00 },
        LineItem { description: "Content migration (per page)".into(), qty: 12.0, rate: 25.00, amount: 300.00 },
        LineItem { description: "Priority support add-on".into(), qty: 1.0, rate: 150.00, amount: 150.00 },
    ];
    let (subtotal, tax, total) = compute_totals(&items, 0.08);
    let client_address = Some(ClientAddress {
        lines: vec!["100 Market Street, Suite 200".into(), "San Francisco, CA 94105".into(), "United States".into()],
    });
    let now = Utc::now().to_rfc3339();
    let valid = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();

    let pdf_bytes = build_pdf_bytes(
        "SAMPLE-Q001", &now, &valid, &items, subtotal, tax, total,
        "Sample Client",
        &Some("sample@client.com".into()),
        &Some("Acme Retail Co.".into()),
        &client_address, &company,
        "This estimate is valid until the date above. Line items and totals here are illustrative.",
        "draft", "quote",
    )?;

    let dir = crate::db::app_data_dir().join("preview");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("sample_quote.pdf");
    std::fs::write(&path, pdf_bytes)?;
    Ok(path.to_string_lossy().to_string())
}

// ---------- Settings loaders ----------

pub fn load_company() -> Result<CompanyInfo> {
    let conn = pool().get()?;
    let json: rusqlite::Result<String> = conn.query_row(
        "SELECT value FROM settings WHERE key='company_info'",
        [],
        |r| r.get(0),
    );
    match json {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(_) => Ok(CompanyInfo {
            name: "Your Company".into(),
            address: "123 Main St, Your City".into(),
            email: "billing@example.com".into(),
            phone: None,
            tax_id: None,
            logo_path: None,
            show_company_name: Some(true),
        }),
    }
}

pub fn parse_client_address(metadata: &Option<String>) -> Option<ClientAddress> {
    let meta: serde_json::Value = serde_json::from_str(metadata.as_deref()?).ok()?;
    let g = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());

    let mut lines: Vec<String> = Vec::new();
    if let Some(s) = g("street_address") { lines.push(s.to_string()); }

    // "City, Region Postal" — include whichever parts exist (works for US ZIP
    // or international province/postal codes).
    let mut region = String::new();
    if let Some(c) = g("city") { region.push_str(c); }
    if let Some(st) = g("state") { if !region.is_empty() { region.push_str(", "); } region.push_str(st); }
    if let Some(z) = g("zip_code") { if !region.is_empty() { region.push(' '); } region.push_str(z); }
    if !region.is_empty() { lines.push(region); }

    if let Some(co) = g("country") { lines.push(co.to_string()); }

    if lines.is_empty() { None } else { Some(ClientAddress { lines }) }
}

// ---------- Layout constants ----------

const PAGE_W: f32 = 215.9;
const PAGE_H: f32 = 279.4;
const MARGIN_L: f32 = 20.0;
const MARGIN_R: f32 = 20.0;
const CONTENT_R: f32 = PAGE_W - MARGIN_R; // 195.9

const LOGO_MAX_W: f32 = 70.6;
const LOGO_MAX_H: f32 = 28.2;
const LOGO_TOP: f32 = 268.0;

/// Left x of the top-right title block ("INVOICE" / "# number"). The logo is kept
/// clear of this so branding can never overlap the title (see `logo_x_for`).
const TITLE_X: f32 = 150.0;
/// The logo's right edge must stay left of this (a 5 mm gap before the title).
const LOGO_SAFE_R: f32 = TITLE_X - 5.0; // 145.0

const ROW_HEIGHT: f32 = 7.0;
const COL_DESC_X: f32 = 22.0;
const COL_QTY_X: f32 = 130.0;
const COL_RATE_X: f32 = 160.0;
const COL_AMT_X: f32 = 193.0;
const TOTALS_LABEL_X: f32 = 150.0;
const TOTALS_VAL_X: f32 = 193.0;

const FOOTER_AREA_Y: f32 = 90.0;
const CONT_START_Y: f32 = PAGE_H - 60.0;
const CONT_BOTTOM_Y: f32 = 30.0;

// ---------- Helvetica width table (1/1000 em units) ----------

const HELV_W: [f32; 96] = [
    278.0,278.0,355.0,556.0,556.0,889.0,667.0,191.0,333.0,333.0,389.0,584.0,278.0,333.0,278.0,278.0,
    556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,278.0,278.0,584.0,584.0,584.0,556.0,
    1015.0,667.0,667.0,722.0,722.0,667.0,611.0,778.0,722.0,278.0,500.0,667.0,556.0,833.0,722.0,778.0,
    667.0,778.0,722.0,667.0,611.0,722.0,667.0,944.0,667.0,667.0,611.0,278.0,278.0,278.0,469.0,556.0,
    333.0,556.0,556.0,500.0,556.0,556.0,278.0,556.0,556.0,222.0,222.0,500.0,222.0,833.0,556.0,556.0,
    556.0,556.0,333.0,500.0,278.0,556.0,500.0,722.0,500.0,500.0,500.0,334.0,260.0,334.0,584.0,0.0,
];

const HELV_BOLD_W: [f32; 96] = [
    278.0,333.0,474.0,556.0,556.0,889.0,722.0,238.0,333.0,333.0,389.0,584.0,278.0,333.0,278.0,278.0,
    556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,333.0,333.0,584.0,584.0,584.0,611.0,
    975.0,722.0,722.0,722.0,722.0,667.0,611.0,778.0,722.0,278.0,556.0,722.0,611.0,833.0,722.0,778.0,
    667.0,778.0,722.0,667.0,611.0,722.0,667.0,944.0,667.0,667.0,611.0,333.0,278.0,333.0,584.0,556.0,
    333.0,556.0,611.0,556.0,611.0,556.0,333.0,611.0,611.0,278.0,278.0,556.0,278.0,889.0,611.0,611.0,
    611.0,611.0,389.0,556.0,333.0,611.0,556.0,778.0,556.0,556.0,500.0,389.0,280.0,389.0,584.0,0.0,
];

fn char_width(ch: char, bold: bool) -> f32 {
    let table = if bold { &HELV_BOLD_W } else { &HELV_W };
    let code = ch as usize;
    if code >= 32 && code < 128 { table[code - 32] } else { 556.0 }
}

fn text_width_mm(text: &str, size_pt: f32, bold: bool) -> f32 {
    let units: f32 = text.chars().map(|c| char_width(c, bold)).sum();
    let width_pt = units / 1000.0 * size_pt;
    width_pt * 25.4 / 72.0
}

fn text_right(
    layer: &PdfLayerReference,
    text: &str,
    size: f32,
    right_x: f32,
    y: f32,
    font: &IndirectFontRef,
    bold: bool,
) {
    let w = text_width_mm(text, size, bold);
    layer.use_text(text, size, Mm(right_x - w), Mm(y), font);
}

fn text_center(
    layer: &PdfLayerReference,
    text: &str,
    size: f32,
    center_x: f32,
    y: f32,
    font: &IndirectFontRef,
    bold: bool,
) {
    let w = text_width_mm(text, size, bold);
    layer.use_text(text, size, Mm(center_x - w / 2.0), Mm(y), font);
}

// ---------- PDF builder ----------

pub fn build_pdf_bytes(
    number: &str,
    issue: &str,
    due: &str,
    items: &[LineItem],
    subtotal: f64,
    tax: f64,
    total: f64,
    cname: &str,
    cemail: &Option<String>,
    ccompany: &Option<String>,
    client_address: &Option<ClientAddress>,
    company: &CompanyInfo,
    notes: &str,
    status: &str,
    kind: &str,
) -> Result<Vec<u8>> {
    // "quote" reuses the exact invoice layout (incl. logo placement) but
    // swaps the title, the due→valid-until label, drops payment options for
    // a validity note, and omits paid/overdue watermarks.
    let is_quote = kind == "quote";
    // Branding template (defaults keep documents looking identical). Quotes carry their
    // OWN template (`quote_template`) so their appearance is configurable independently
    // of invoices; invoices use `invoice_template`. Loaded here so ALL render paths
    // (real invoice, quote, preview, sample) get the right branding for free.
    let tpl = if is_quote { load_quote_template() } else { load_template() };
    let accent = tpl.accent();
    let black = Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None));
    // Configurable title from the document's own template (defaults: "QUOTE" / "INVOICE").
    let title: &str = if !tpl.title_label.trim().is_empty() {
        tpl.title_label.trim()
    } else if is_quote {
        "QUOTE"
    } else {
        "INVOICE"
    };
    let (doc, page1, layer1) = PdfDocument::new(
        format!("{} {}", if is_quote { "Quote" } else { "Invoice" }, number),
        Mm(PAGE_W),
        Mm(PAGE_H),
        "Layer 1",
    );
    let layer = doc.get_page(page1).get_layer(layer1);

    let font_regular = doc.add_builtin_font(BuiltinFont::Helvetica).context("font")?;
    let font_bold = doc.add_builtin_font(BuiltinFont::HelveticaBold).context("font_bold")?;

    // ----- Pagination: how many items fit on page 1? -----
    let divider_y = 238.0;
    let bill_top = divider_y - 8.0;
    let table_top = bill_top - 35.0;
    let first_row_y = table_top - 12.0;
    let page1_available = first_row_y - FOOTER_AREA_Y;
    let rows_page1 = (page1_available / ROW_HEIGHT).floor() as usize;

    let rows_continuation = ((CONT_START_Y - CONT_BOTTOM_Y) / ROW_HEIGHT).floor() as usize;

    let total_pages = if items.len() <= rows_page1 {
        1
    } else {
        let remaining = items.len() - rows_page1;
        1 + ((remaining + rows_continuation - 1) / rows_continuation)
    };

    // Collect (page_index, layer_index, items_slice) for each page
    let mut page_layers: Vec<(PdfPageIndex, PdfLayerIndex, Vec<usize>)> = Vec::new();

    if items.len() <= rows_page1 || items.is_empty() {
        page_layers.push((page1, layer1, (0..items.len()).collect()));
    } else {
        page_layers.push((page1, layer1, (0..rows_page1).collect()));
        let mut offset = rows_page1;
        while offset < items.len() {
            let end = (offset + rows_continuation).min(items.len());
            let (pi, li) = doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
            page_layers.push((pi, li, (offset..end).collect()));
            offset = end;
        }
    }

    // ----- Page 1: full header -----

    let logo_rendered = if let Some(logo_path) = company.logo_path.as_deref() {
        if std::path::Path::new(logo_path).exists() {
            render_logo(&layer, logo_path, &tpl.logo_placement, tpl.logo_size_factor()).unwrap_or(None)
        } else {
            None
        }
    } else {
        None
    };

    // Company text block: left-aligned under the logo (so it follows placement),
    // or at the left margin when there's no logo. It stacks below the logo band,
    // so it never shares the title's y-band regardless of placement.
    let (text_x, text_y_top) = match &logo_rendered {
        Some(lr) => (lr.x, lr.bottom_y - 5.0),
        None => (MARGIN_L, LOGO_TOP),
    };

    // Build the header text lines honoring the field toggles, so hidden rows leave
    // no gap. When there's no logo the company NAME is the large 18pt heading;
    // with a logo it's an optional 11pt line (show_company_name).
    let mut y = text_y_top;
    if logo_rendered.is_none() {
        // No logo → the name is always the heading (independent of show_company_name,
        // matching prior behavior where a nameless header would be blank).
        layer.use_text(&company.name, 18.0, Mm(text_x), Mm(y), &font_bold);
        y -= 7.0;
    } else if tpl.show_company_name {
        layer.use_text(&company.name, 11.0, Mm(text_x), Mm(y), &font_bold);
        y -= 4.0;
    }
    if tpl.show_address && !company.address.trim().is_empty() {
        layer.use_text(&company.address, 9.0, Mm(text_x), Mm(y), &font_regular);
        y -= 4.0;
    }
    if tpl.show_email && !company.email.trim().is_empty() {
        layer.use_text(&company.email, 9.0, Mm(text_x), Mm(y), &font_regular);
        y -= 4.0;
    }
    if tpl.show_phone {
        if let Some(phone) = company.phone.as_deref().filter(|p| !p.trim().is_empty()) {
            layer.use_text(phone, 9.0, Mm(text_x), Mm(y), &font_regular);
            y -= 4.0;
        }
    }
    let _ = y;

    // Title + number, top-right, in the accent color.
    layer.set_fill_color(accent.clone());
    layer.use_text(title, 28.0, Mm(TITLE_X), Mm(263.0), &font_bold);
    layer.set_fill_color(black.clone());
    layer.use_text(format!("# {}", number), 11.0, Mm(TITLE_X), Mm(255.0), &font_regular);

    // Header divider — accent stroke.
    let div = Line {
        points: vec![
            (Point::new(Mm(MARGIN_L), Mm(divider_y)), false),
            (Point::new(Mm(CONTENT_R), Mm(divider_y)), false),
        ],
        is_closed: false,
    };
    layer.set_outline_color(accent.clone());
    layer.set_outline_thickness(0.5);
    layer.add_line(div);
    layer.set_outline_color(black.clone());

    // Bill To
    layer.use_text("BILL TO", 9.0, Mm(MARGIN_L), Mm(bill_top), &font_bold);
    layer.use_text(cname, 11.0, Mm(MARGIN_L), Mm(bill_top - 6.0), &font_bold);
    let mut y = bill_top - 11.0;
    if let Some(co) = ccompany {
        layer.use_text(co, 10.0, Mm(MARGIN_L), Mm(y), &font_regular);
        y -= 5.0;
    }
    if let Some(addr) = client_address {
        for ln in &addr.lines {
            if y < bill_top - 25.0 { break; }
            layer.use_text(ln, 10.0, Mm(MARGIN_L), Mm(y), &font_regular);
            y -= 5.0;
        }
    }
    if let Some(em) = cemail {
        layer.use_text(em, 10.0, Mm(MARGIN_L), Mm(y), &font_regular);
    }

    // Dates
    layer.use_text("ISSUE DATE", 9.0, Mm(140.0), Mm(bill_top), &font_bold);
    layer.use_text(short_date(issue), 10.0, Mm(140.0), Mm(bill_top - 6.0), &font_regular);
    layer.use_text(if is_quote { "VALID UNTIL" } else { "DUE DATE" }, 9.0, Mm(170.0), Mm(bill_top), &font_bold);
    layer.use_text(short_date(due), 10.0, Mm(170.0), Mm(bill_top - 6.0), &font_regular);

    // Table header
    render_table_header(&layer, table_top, &font_regular, &font_bold, &accent);

    // Items on page 1
    let p1_items = &page_layers[0].2;
    let mut row_y = first_row_y;
    for &idx in p1_items {
        render_item_row(&layer, &items[idx], row_y, &font_regular);
        row_y -= ROW_HEIGHT;
    }

    // Continuation pages
    for page_idx in 1..page_layers.len() {
        let (pi, li, item_indices) = &page_layers[page_idx];
        let cont_layer = doc.get_page(*pi).get_layer(*li);

        // Mini header
        cont_layer.use_text(title, 14.0, Mm(MARGIN_L), Mm(PAGE_H - 20.0), &font_bold);
        cont_layer.use_text(format!("# {}", number), 9.0, Mm(MARGIN_L), Mm(PAGE_H - 30.0), &font_regular);
        let cont_div = Line {
            points: vec![
                (Point::new(Mm(MARGIN_L), Mm(PAGE_H - 35.0)), false),
                (Point::new(Mm(CONTENT_R), Mm(PAGE_H - 35.0)), false),
            ],
            is_closed: false,
        };
        cont_layer.set_outline_thickness(0.3);
        cont_layer.add_line(cont_div);

        render_table_header(&cont_layer, PAGE_H - 45.0, &font_regular, &font_bold, &accent);

        let mut cy = PAGE_H - 57.0;
        for &iidx in item_indices {
            render_item_row(&cont_layer, &items[iidx], cy, &font_regular);
            cy -= ROW_HEIGHT;
        }
    }

    // ----- Totals + Payment + Notes + Footer (on last page) -----
    let last_page_idx = page_layers.len() - 1;
    let last_layer = if last_page_idx == 0 {
        layer.clone()
    } else {
        let (pi, li, _) = &page_layers[last_page_idx];
        doc.get_page(*pi).get_layer(*li)
    };

    let mut last_row_y = if last_page_idx == 0 {
        row_y
    } else {
        let (_, _, indices) = &page_layers[last_page_idx];
        if indices.is_empty() {
            CONT_START_Y
        } else {
            CONT_START_Y - (indices.len() as f32) * ROW_HEIGHT - 5.0
        }
    };

    // Totals divider — accent stroke.
    let totals_div = Line {
        points: vec![
            (Point::new(Mm(120.0), Mm(last_row_y)), false),
            (Point::new(Mm(CONTENT_R), Mm(last_row_y)), false),
        ],
        is_closed: false,
    };
    last_layer.set_outline_color(accent.clone());
    last_layer.set_outline_thickness(0.5);
    last_layer.add_line(totals_div);
    last_layer.set_outline_color(black.clone());

    // Subtotal / Tax stay black (readability); the TOTAL label + amount are accent.
    last_row_y -= 6.0;
    last_layer.use_text("Subtotal", 10.0, Mm(TOTALS_LABEL_X), Mm(last_row_y), &font_regular);
    text_right(&last_layer, &fmt_dollar(subtotal), 10.0, TOTALS_VAL_X, last_row_y, &font_regular, false);
    last_row_y -= 5.0;
    last_layer.use_text("Tax", 10.0, Mm(TOTALS_LABEL_X), Mm(last_row_y), &font_regular);
    text_right(&last_layer, &fmt_dollar(tax), 10.0, TOTALS_VAL_X, last_row_y, &font_regular, false);
    last_row_y -= 7.0;
    last_layer.set_fill_color(accent.clone());
    last_layer.use_text("TOTAL", 12.0, Mm(TOTALS_LABEL_X), Mm(last_row_y), &font_bold);
    text_right(&last_layer, &fmt_dollar(total), 12.0, TOTALS_VAL_X, last_row_y, &font_bold, true);
    last_layer.set_fill_color(black.clone());

    let mut next_y = last_row_y - 10.0;
    if is_quote {
        // Quotes show a validity/terms note instead of payment options.
        last_layer.use_text("This is a quotation, not an invoice.", 9.0, Mm(MARGIN_L), Mm(next_y), &font_bold);
        next_y -= 5.0;
        last_layer.use_text(
            format!("Valid until {}. Prices and availability are subject to change.", short_date(due)),
            8.0, Mm(MARGIN_L), Mm(next_y), &font_regular,
        );
        next_y -= 8.0;
    } else {
        let pm = load_active_payment_methods()?;
        if !pm.is_empty() {
            let mut pay_y = next_y;
            last_layer.use_text("Payment Options", 10.0, Mm(MARGIN_L), Mm(pay_y), &font_bold);
            pay_y -= 6.0;
            for (pkind, details) in &pm {
                if pay_y < 30.0 { break; }
                last_layer.use_text(format!("{}:", pkind), 9.0, Mm(MARGIN_L), Mm(pay_y), &font_bold);
                pay_y -= 4.5;
                for ln in details.lines() {
                    if pay_y < 25.0 { break; }
                    last_layer.use_text(ln, 8.0, Mm(MARGIN_L + 5.0), Mm(pay_y), &font_regular);
                    pay_y -= 3.5;
                }
                pay_y -= 2.0;
            }
            next_y = pay_y - 8.0;
        }
    }

    if !notes.is_empty() {
        let mut n_y = next_y;
        last_layer.use_text("Notes:", 9.0, Mm(MARGIN_L), Mm(n_y), &font_bold);
        n_y -= 5.0;
        for ln in notes.lines() {
            if n_y < 25.0 { break; }
            last_layer.use_text(ln, 8.0, Mm(MARGIN_L + 5.0), Mm(n_y), &font_regular);
            n_y -= 3.5;
        }
    }

    // Footer
    last_layer.use_text("Thank you for your business.", 9.0, Mm(MARGIN_L), Mm(18.0), &font_regular);
    if tpl.show_tax_id {
        if let Some(tax_id) = company.tax_id.as_deref().filter(|t| !t.trim().is_empty()) {
            last_layer.use_text(format!("Tax ID: {}", tax_id), 8.0, Mm(MARGIN_L), Mm(13.0), &font_regular);
        }
    }
    // Optional branding footer note, centered in muted gray at the very bottom.
    if !tpl.footer_note.trim().is_empty() {
        last_layer.set_fill_color(Color::Rgb(Rgb::new(0.5, 0.5, 0.5, None)));
        text_center(&last_layer, tpl.footer_note.trim(), 8.0, PAGE_W / 2.0, 7.0, &font_regular, false);
        last_layer.set_fill_color(black.clone());
    }

    // Page numbers
    if total_pages > 1 {
        for (pn, (pi, li, _)) in page_layers.iter().enumerate() {
            let pg_layer = doc.get_page(*pi).get_layer(*li);
            let label = format!("Page {} of {}", pn + 1, total_pages);
            text_right(&pg_layer, &label, 8.0, CONTENT_R, 10.0, &font_regular, false);
        }
    }

    // ----- Watermark (invoices only) -----
    let is_paid = !is_quote && status == "paid";
    let is_overdue = !is_quote
        && !is_paid
        && status != "draft"
        && status != "void"
        && !due.is_empty()
        && due[..due.len().min(10)].parse::<chrono::NaiveDate>()
            .map(|d| d < chrono::Local::now().date_naive())
            .unwrap_or(false);

    if is_paid || is_overdue {
        for (_, (pi, li, _)) in page_layers.iter().enumerate() {
            let pg_layer = doc.get_page(*pi).get_layer(*li);
            draw_watermark(&pg_layer, &font_bold, is_paid);
        }
    }

    // ----- Save -----
    let mut writer = BufWriter::new(Vec::new());
    doc.save(&mut writer)?;
    let pdf_bytes: Vec<u8> = writer
        .into_inner()
        .map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))?;
    Ok(pdf_bytes)
}

// ---------- Table rendering helpers ----------

fn render_table_header(
    layer: &PdfLayerReference,
    ttop: f32,
    _font_regular: &IndirectFontRef,
    font_bold: &IndirectFontRef,
    accent: &Color,
) {
    layer.set_fill_color(Color::Rgb(Rgb::new(0.95, 0.95, 0.95, None)));
    let pts = vec![
        (Point::new(Mm(MARGIN_L), Mm(ttop + 2.0)), false),
        (Point::new(Mm(CONTENT_R), Mm(ttop + 2.0)), false),
        (Point::new(Mm(CONTENT_R), Mm(ttop - 5.0)), false),
        (Point::new(Mm(MARGIN_L), Mm(ttop - 5.0)), false),
    ];
    layer.add_polygon(Polygon {
        rings: vec![pts],
        mode: path::PaintMode::Fill,
        winding_order: path::WindingOrder::NonZero,
    });

    // Header labels in the accent color, plus a thin accent rule under the row.
    layer.set_fill_color(accent.clone());
    layer.use_text("DESCRIPTION", 9.0, Mm(COL_DESC_X), Mm(ttop - 2.0), font_bold);
    text_center(layer, "QTY", 9.0, COL_QTY_X, ttop - 2.0, font_bold, true);
    text_right(layer, "UNIT PRICE", 9.0, COL_RATE_X, ttop - 2.0, font_bold, true);
    text_right(layer, "AMOUNT", 9.0, COL_AMT_X, ttop - 2.0, font_bold, true);
    layer.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));

    let rule = Line {
        points: vec![
            (Point::new(Mm(MARGIN_L), Mm(ttop - 5.0)), false),
            (Point::new(Mm(CONTENT_R), Mm(ttop - 5.0)), false),
        ],
        is_closed: false,
    };
    layer.set_outline_color(accent.clone());
    layer.set_outline_thickness(0.4);
    layer.add_line(rule);
    layer.set_outline_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));
}

fn render_item_row(
    layer: &PdfLayerReference,
    item: &LineItem,
    y: f32,
    font: &IndirectFontRef,
) {
    let desc = if item.description.len() > 60 {
        format!("{}...", &item.description[..57])
    } else {
        item.description.clone()
    };
    layer.use_text(&desc, 10.0, Mm(COL_DESC_X), Mm(y), font);
    text_center(layer, &format!("{:.2}", item.qty), 10.0, COL_QTY_X, y, font, false);
    text_right(layer, &fmt_dollar(item.rate), 10.0, COL_RATE_X, y, font, false);
    text_right(layer, &fmt_dollar(item.amount), 10.0, COL_AMT_X, y, font, false);
}

// ---------- Watermark ----------

fn draw_watermark(layer: &PdfLayerReference, font: &IndirectFontRef, paid: bool) {
    let label = if paid { "PAID" } else { "OVERDUE" };
    let (r, g, b) = if paid {
        (0.856, 0.946, 0.874) // green tint (simulates 0.18 alpha)
    } else {
        (0.973, 0.847, 0.847) // red tint (simulates 0.18 alpha)
    };

    layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
    layer.begin_text_section();
    layer.set_font(font, 90.0);
    let cx: Pt = Mm(PAGE_W / 2.0).into();
    let cy: Pt = Mm(PAGE_H / 2.0).into();
    layer.set_text_matrix(TextMatrix::TranslateRotate(cx, cy, 45.0));
    layer.write_text(label, font);
    layer.end_text_section();
    layer.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));
}

// ---------- Logo rendering ----------

/// The rendered logo's box: its left x and bottom y (mm). The drawn width is used
/// internally (in `logo_x_for`) to place the box, so it isn't returned.
pub struct LogoRender {
    pub x: f32,
    pub bottom_y: f32,
}

/// Left x of the logo for a placement + drawn width `w`. Uses the placement
/// formulas (left=MARGIN_L, center=(PAGE_W-w)/2, right=CONTENT_R-w), then clamps so
/// the logo's RIGHT edge never crosses `LOGO_SAFE_R` (keeping it clear of the
/// top-right title). Never returns < MARGIN_L. This is the exact math the HTML
/// preview must mirror.
fn logo_x_for(placement: &str, w: f32) -> f32 {
    let raw = match placement {
        "center" => (PAGE_W - w) / 2.0,
        "right" => CONTENT_R - w,
        _ => MARGIN_L, // left / unknown
    };
    raw.min(LOGO_SAFE_R - w).max(MARGIN_L)
}

/// Draw the logo scaled to a `size_factor`-scaled max box and positioned by
/// `placement`. Returns the box (x, w, bottom_y) so the company text can stack
/// beneath it.
fn render_logo(
    layer: &PdfLayerReference,
    logo_path: &str,
    placement: &str,
    size_factor: f32,
) -> Result<Option<LogoRender>> {
    let bytes = std::fs::read(logo_path)?;
    let dyn_img = printpdf::image_crate::load_from_memory(&bytes)
        .context("decode logo image")?;

    let rgba = dyn_img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut raw = Vec::with_capacity((w * h * 3) as usize);
    for pixel in rgba.pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = a as f32 / 255.0;
        let inv = 1.0 - alpha;
        raw.push((r as f32 * alpha + 255.0 * inv).round().clamp(0.0, 255.0) as u8);
        raw.push((g as f32 * alpha + 255.0 * inv).round().clamp(0.0, 255.0) as u8);
        raw.push((b as f32 * alpha + 255.0 * inv).round().clamp(0.0, 255.0) as u8);
    }

    // Scale the max logo box by the size factor (small 0.7 / medium 1.0 / large 1.4).
    let max_w = LOGO_MAX_W * size_factor;
    let max_h = LOGO_MAX_H * size_factor;

    let px_per_mm: f32 = 72.0 / 25.4;
    let native_w_mm = w as f32 / px_per_mm;
    let native_h_mm = h as f32 / px_per_mm;
    let scale = (max_w / native_w_mm)
        .min(max_h / native_h_mm)
        .min(1.0);
    let logo_w_mm = native_w_mm * scale;
    let logo_h_mm = native_h_mm * scale;
    let logo_y_bottom = LOGO_TOP - logo_h_mm;
    let logo_x = logo_x_for(placement, logo_w_mm);

    let xobj = printpdf::ImageXObject {
        width: printpdf::Px(w as usize),
        height: printpdf::Px(h as usize),
        color_space: printpdf::ColorSpace::Rgb,
        bits_per_component: printpdf::ColorBits::Bit8,
        image_data: raw,
        interpolate: true,
        image_filter: None,
        clipping_bbox: None,
        smask: None,
    };
    let pimg = printpdf::Image::from(xobj);
    pimg.add_to_layer(
        layer.clone(),
        ImageTransform {
            translate_x: Some(Mm(logo_x)),
            translate_y: Some(Mm(logo_y_bottom)),
            scale_x: Some(scale),
            scale_y: Some(scale),
            rotate: None,
            dpi: Some(72.0),
        },
    );
    Ok(Some(LogoRender { x: logo_x, bottom_y: logo_y_bottom }))
}

// ---------- Payment methods loader ----------

fn load_active_payment_methods() -> Result<Vec<(String, String)>> {
    let conn = pool().get()?;
    let mut stmt = conn
        .prepare(
            "SELECT kind, details FROM payment_methods
             WHERE active=1 ORDER BY sort_order, kind",
        )
        .context("prepare payment_methods query")?;
    let collected: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(collected)
}

// ---------- Top-level commands ----------

pub async fn generate_pdf(invoice_id: &str) -> Result<String> {
    let (number, _client_id, issue, due, items_json, subtotal, tax, total, notes, status, cname, cemail, ccompany, cmetadata) = {
        let conn = pool().get()?;
        let inv: (String, String, String, String, String, f64, f64, f64, String, String) = conn.query_row(
            "SELECT number,client_id,issue_date,due_date,line_items_json,subtotal,tax,total,notes,status
             FROM invoices WHERE id=?1",
            [invoice_id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                    r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                ))
            },
        )?;
        let cli: (String, Option<String>, Option<String>, Option<String>) = conn.query_row(
            "SELECT name,email,company,metadata FROM clients WHERE id=?1",
            [&inv.1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        (
            inv.0, inv.1, inv.2, inv.3, inv.4, inv.5, inv.6, inv.7, inv.8, inv.9,
            cli.0, cli.1, cli.2, cli.3,
        )
    };

    let client_address = parse_client_address(&cmetadata);
    let items: Vec<LineItem> = serde_json::from_str(&items_json)?;
    let company = load_company()?;

    let pdf_bytes = build_pdf_bytes(
        &number, &issue, &due, &items, subtotal, tax, total,
        &cname, &cemail, &ccompany, &client_address, &company, &notes, &status, "invoice",
    )?;

    let dir = pdf_output_dir();
    std::fs::create_dir_all(&dir)?;
    let pdf_path = dir.join(format!("{}.pdf", number));
    std::fs::write(&pdf_path, pdf_bytes)?;

    let conn = pool().get()?;
    conn.execute(
        "UPDATE invoices SET pdf_path=?1 WHERE id=?2",
        rusqlite::params![pdf_path.to_string_lossy(), invoice_id],
    )?;

    Ok(pdf_path.to_string_lossy().to_string())
}

/// Render a SAMPLE invoice PDF using the current company_info + invoice_template
/// and dummy data (a "Sample Client" + a few realistic line items). Reuses the real
/// `build_pdf_bytes` path so it is byte-for-byte the real layout — this backs the
/// branding editor's "View actual PDF". Writes to app-data and returns the path.
pub fn render_sample_pdf() -> Result<String> {
    let company = load_company()?;
    let items = vec![
        LineItem { description: "Website design & build".into(), qty: 1.0, rate: 2400.00, amount: 2400.00 },
        LineItem { description: "Monthly hosting & maintenance".into(), qty: 3.0, rate: 120.00, amount: 360.00 },
        LineItem { description: "Content migration (per page)".into(), qty: 12.0, rate: 25.00, amount: 300.00 },
        LineItem { description: "Priority support add-on".into(), qty: 1.0, rate: 150.00, amount: 150.00 },
    ];
    let (subtotal, tax, total) = compute_totals(&items, 0.08);
    let client_address = Some(ClientAddress {
        lines: vec!["100 Market Street, Suite 200".into(), "San Francisco, CA 94105".into(), "United States".into()],
    });
    let now = Utc::now().to_rfc3339();
    let due = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();

    let pdf_bytes = build_pdf_bytes(
        "SAMPLE-001", &now, &due, &items, subtotal, tax, total,
        "Sample Client",
        &Some("sample@client.com".into()),
        &Some("Acme Retail Co.".into()),
        &client_address, &company,
        "Thanks for reviewing this sample. Line items and totals here are illustrative.",
        "draft", "invoice",
    )?;

    let dir = crate::db::app_data_dir().join("preview");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("sample_invoice.pdf");
    std::fs::write(&path, pdf_bytes)?;
    Ok(path.to_string_lossy().to_string())
}

pub async fn send_invoice(invoice_id: &str) -> Result<()> {
    let (number, total, pdf_path, cname, cemail) = {
        let conn = pool().get()?;
        let inv: (String, String, f64, Option<String>) = conn.query_row(
            "SELECT number,client_id,total,pdf_path FROM invoices WHERE id=?1",
            [invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let cli: (String, Option<String>) = conn.query_row(
            "SELECT name,email FROM clients WHERE id=?1",
            [&inv.1],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        (inv.0, inv.2, inv.3, cli.0, cli.1)
    };

    let pdf = match pdf_path {
        Some(p) if std::path::Path::new(&p).exists() => p,
        _ => generate_pdf(invoice_id).await?,
    };

    let to = cemail.context("client has no email")?;
    let subject = format!("Invoice {}", number);
    let body = format!(
        "Hi {},\n\nPlease find attached invoice {} for {}.\n\n\
         Payment instructions are detailed in the document.\n\nThank you!",
        cname.split_whitespace().next().unwrap_or(&cname),
        number,
        fmt_dollar(total),
    );

    crate::email::send(&to, &subject, &body, Some(&pdf)).await?;

    let now = Utc::now().to_rfc3339();
    // Only a draft is promoted to 'sent'. A paid-but-never-emailed invoice keeps
    // its 'paid' status so sending doesn't silently un-mark it paid.
    let was_draft: bool = {
        let conn = pool().get()?;
        conn.query_row(
            "SELECT status FROM invoices WHERE id=?1",
            [invoice_id],
            |r| r.get::<_, String>(0),
        )? == "draft"
    };

    let mut cols = serde_json::Map::new();
    if was_draft {
        cols.insert("status".into(), serde_json::Value::String("sent".into()));
    }
    cols.insert("sent_at".into(), serde_json::Value::String(now.clone()));
    crate::sync::record_upsert("invoices", invoice_id, cols)?;

    let conn = pool().get()?;
    conn.execute(
        "UPDATE invoices SET status = CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at=?1 WHERE id=?2",
        rusqlite::params![now, invoice_id],
    )?;
    Ok(())
}

// ---------- Quotes ----------

fn quote_output_dir() -> std::path::PathBuf {
    crate::db::app_data_dir().join("quotes")
}

pub async fn generate_quote_pdf(quote_id: &str) -> Result<String> {
    let conn0 = pool().get()?;
    let q: (String, String, String, String, String, f64, f64, f64, String, String) = conn0.query_row(
        "SELECT number,client_id,issue_date,valid_until,line_items_json,subtotal,tax,total,notes,status
         FROM quotes WHERE id=?1",
        [quote_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
    )?;
    let cli: (String, Option<String>, Option<String>, Option<String>) = conn0.query_row(
        "SELECT name,email,company,metadata FROM clients WHERE id=?1",
        [&q.1],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    drop(conn0);

    let items: Vec<LineItem> = serde_json::from_str(&q.4)?;
    let client_address = parse_client_address(&cli.3);
    let company = load_company()?;

    let pdf_bytes = build_pdf_bytes(
        &q.0, &q.2, &q.3, &items, q.5, q.6, q.7,
        &cli.0, &cli.1, &cli.2, &client_address, &company, &q.8, &q.9, "quote",
    )?;

    let dir = quote_output_dir();
    std::fs::create_dir_all(&dir)?;
    let pdf_path = dir.join(format!("{}.pdf", q.0));
    std::fs::write(&pdf_path, pdf_bytes)?;

    let conn = pool().get()?;
    conn.execute("UPDATE quotes SET pdf_path=?1 WHERE id=?2", rusqlite::params![pdf_path.to_string_lossy(), quote_id])?;
    Ok(pdf_path.to_string_lossy().to_string())
}

pub async fn send_quote(quote_id: &str) -> Result<()> {
    let (number, total, pdf_path, cname, cemail) = {
        let conn = pool().get()?;
        let q: (String, String, f64, Option<String>) = conn.query_row(
            "SELECT number,client_id,total,pdf_path FROM quotes WHERE id=?1",
            [quote_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let cli: (String, Option<String>) = conn.query_row(
            "SELECT name,email FROM clients WHERE id=?1", [&q.1],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        (q.0, q.2, q.3, cli.0, cli.1)
    };

    let pdf = match pdf_path {
        Some(p) if std::path::Path::new(&p).exists() => p,
        _ => generate_quote_pdf(quote_id).await?,
    };

    let to = cemail.context("client has no email")?;
    let subject = format!("Quote {}", number);
    let body = format!(
        "Hi {},\n\nPlease find attached our quote {} for {}.\n\n\
         This quotation is valid until the date shown in the document. \
         Let us know if you'd like to proceed.\n\nThank you!",
        cname.split_whitespace().next().unwrap_or(&cname), number, fmt_dollar(total),
    );

    crate::email::send(&to, &subject, &body, Some(&pdf)).await?;

    let now = Utc::now().to_rfc3339();
    let mut cols = serde_json::Map::new();
    cols.insert("status".into(), serde_json::Value::String("sent".into()));
    cols.insert("sent_at".into(), serde_json::Value::String(now.clone()));
    crate::sync::record_upsert("quotes", quote_id, cols)?;
    let conn = pool().get()?;
    conn.execute("UPDATE quotes SET status='sent', sent_at=?1 WHERE id=?2", rusqlite::params![now, quote_id])?;
    Ok(())
}

// ---------- Helpers ----------

fn pdf_output_dir() -> std::path::PathBuf {
    crate::db::app_data_dir().join("invoices")
}

fn short_date(rfc3339: &str) -> String {
    rfc3339.split('T').next().unwrap_or(rfc3339).to_string()
}

fn fmt_dollar(n: f64) -> String {
    let int_part = n.trunc() as i64;
    let frac = ((n.fract().abs() * 100.0).round() as i64) % 100;
    let abs = int_part.abs();

    let mut digits: Vec<char> = abs.to_string().chars().rev().collect();
    let mut out = String::new();
    for (i, c) in digits.drain(..).enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    let int_str: String = out.chars().rev().collect();
    let sign = if int_part < 0 { "-" } else { "" };
    format!("{sign}${int_str}.{frac:02}")
}

pub fn compute_totals(items: &[LineItem], tax_rate: f64) -> (f64, f64, f64) {
    let subtotal: f64 = items.iter().map(|i| i.amount).sum();
    let tax = (subtotal * tax_rate * 100.0).round() / 100.0;
    let total = subtotal + tax;
    (subtotal, tax, total)
}
