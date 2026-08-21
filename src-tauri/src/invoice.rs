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
    pub(crate) fn logo_size_factor(&self) -> f32 {
        match self.logo_size.as_str() {
            "small" => 0.7,
            "large" => 1.4,
            _ => 1.0, // medium / anything unknown
        }
    }
    /// Accent color parsed to a printpdf fill/outline color (near-black on bad input).
    pub(crate) fn accent(&self) -> Color {
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
    // `pool_opt`: this function documents "never fails", but bare `pool()` panics when the
    // pool is not up, which is the opposite of that promise.
    let raw: Option<String> = crate::db::pool_opt().and_then(|p| p.get().ok()).and_then(|conn| {
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

// ---------- Policy clauses (R-162) ----------

/// A standing clause that prints at the foot of a document and repeats in the send
/// email. `(heading, body)`.
pub type Clause = (&'static str, String);

fn setting(conn: &rusqlite::Connection, key: &str) -> String {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .unwrap_or_default()
}

fn flag(conn: &rusqlite::Connection, key: &str) -> bool {
    matches!(setting(conn, key).as_str(), "1" | "true")
}

/// The clauses to print on a document and repeat in its email (R-162).
///
/// Loaded here rather than passed in, for the same reason the branding template is:
/// every render path — real invoice, quote, preview, sample — gets them for free.
///
/// The two clauses have deliberately different lifetimes. The 24-hour notice is a
/// standing term of business and is read from settings on every render. The return
/// policy is NOT: it is frozen on the invoice row and arrives here as `return_policy`,
/// so an invoice keeps the wording it was actually sent under even after the default is
/// re-edited. An empty `return_policy` means no clause was sent on that invoice and
/// renders as nothing — it must never fall back to today's default, or an old PDF and
/// the buyer's copy would disagree about what was agreed.
///
/// Quotes pass `""` — the return policy is an invoice-level term.
pub fn document_clauses(return_policy: &str) -> Vec<Clause> {
    let mut out: Vec<Clause> = Vec::new();
    // `pool_opt`, not `pool()`: a render must never panic because this optional lookup had
    // no database. The frozen per-invoice policy below still prints either way.
    if let Some(conn) = crate::db::pool_opt().and_then(|p| p.get().ok()) {
        if flag(&conn, "email_notice_24h_enabled") {
            let t = setting(&conn, "email_notice_24h_text");
            if !t.trim().is_empty() { out.push(("Notice", t.trim().to_string())); }
        }
    }
    if !return_policy.trim().is_empty() {
        out.push(("Return policy", return_policy.trim().to_string()));
    }
    out
}

/// The same clauses as a plain-text block appended to an outbound email body, so the
/// wording a buyer reads in the message matches the wording on the attached PDF.
/// Empty string when nothing is enabled, so callers can append unconditionally.
pub fn clause_email_block(return_policy: &str) -> String {
    let clauses = document_clauses(return_policy);
    if clauses.is_empty() { return String::new(); }
    let mut s = String::from("\n\n---");
    for (heading, body) in clauses {
        s.push_str(&format!("\n\n{}: {}", heading, body));
    }
    s
}

/// The return-policy text frozen on an invoice row. Empty for a row that predates
/// R-162 or was finalized with the clause switched off.
pub fn invoice_return_policy(invoice_id: &str) -> String {
    crate::db::pool_opt().and_then(|p| p.get().ok())
        .and_then(|conn| conn.query_row(
            "SELECT COALESCE(return_policy,'') FROM invoices WHERE id=?1",
            [invoice_id],
            |r| r.get::<_, String>(0),
        ).ok())
        .unwrap_or_default()
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
    let raw: Option<String> = crate::db::pool_opt().and_then(|p| p.get().ok()).and_then(|conn| {
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
        // Quotes carry no return policy — it is an invoice-level term (R-162).
        "",
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
    let conn = crate::db::pool_opt()
        .ok_or_else(|| anyhow::anyhow!("DB pool not initialized"))?
        .get()?;
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

pub(crate) const PAGE_W: f32 = 215.9;
pub(crate) const PAGE_H: f32 = 279.4;
pub(crate) const MARGIN_L: f32 = 20.0;
const MARGIN_R: f32 = 20.0;
pub(crate) const CONTENT_R: f32 = PAGE_W - MARGIN_R; // 195.9

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

/// Walks the clause block down the page, rolling onto a new page instead of running out
/// of room (R-162). Pure arithmetic so the page-break rule is unit-testable; the renderer
/// turns each `page` increment into a real PDF page.
///
/// This exists because the first cut of the clause block simply stopped at the footer
/// floor, silently cutting contract terms off mid-sentence — and it did so precisely on
/// the long, item-heavy invoices where the money is biggest. A truncated warranty
/// disclaimer is worse than no disclaimer: it reads as though the seller said less than
/// they did. Nothing here ever drops a row.
pub(crate) struct ClauseCursor {
    pub(crate) y: f32,
    /// 0 = the page the block started on; every increment is one added page.
    pub(crate) page: usize,
    floor: f32,
    top: f32,
}

impl ClauseCursor {
    pub(crate) fn new(y: f32, floor: f32, top: f32) -> Self {
        ClauseCursor { y, page: 0, floor, top }
    }

    /// Reserve `h` mm and return the baseline to draw at, breaking the page first when
    /// this row plus `keep_with` (rows that must not be orphaned from it, e.g. the first
    /// lines that belong under a heading) would fall below the floor.
    ///
    /// Never breaks twice in a row: if we are already at the top of a fresh page the row
    /// is emitted regardless, so a clause taller than a whole page cannot loop forever.
    pub(crate) fn take(&mut self, h: f32, keep_with: f32) -> f32 {
        if self.y - (h + keep_with) < self.floor && self.y < self.top {
            self.page += 1;
            self.y = self.top;
        }
        let at = self.y;
        self.y -= h;
        at
    }

    /// Blank space between clauses. Never triggers a break on its own — trailing
    /// whitespace at a page foot is not worth a page.
    pub(crate) fn gap(&mut self, h: f32) {
        self.y -= h;
    }
}

/// Greedy word-wrap for a clause body (R-162), at `max_chars` per line. Blank lines in
/// the source are preserved so a multi-paragraph policy keeps its shape. A single word
/// longer than the limit is emitted on its own line rather than split, which is what the
/// notes block above does too.
fn wrap_clause(text: &str, max_chars: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw_line in text.lines() {
        if raw_line.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        let mut line = String::new();
        for word in raw_line.split_whitespace() {
            let extra = if line.is_empty() { 0 } else { 1 };
            if !line.is_empty() && line.chars().count() + extra + word.chars().count() > max_chars {
                out.push(std::mem::take(&mut line));
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

pub(crate) fn text_width_mm(text: &str, size_pt: f32, bold: bool) -> f32 {
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

/// Add a page for clause overflow (R-162) and return its layer, carrying the same mini
/// header the item continuation pages use so a terms page is identifiable on its own.
///
/// Registers the page in `page_layers` and bumps `total_pages`, which is what keeps the
/// "Page n of m" footer and the paid/overdue watermark correct — both loop `page_layers`
/// after this runs. An empty item-index list marks it as a non-table page.
fn start_clause_page(
    doc: &PdfDocumentReference,
    page_layers: &mut Vec<(PdfPageIndex, PdfLayerIndex, Vec<usize>)>,
    total_pages: &mut usize,
    title: &str,
    number: &str,
    font_bold: &IndirectFontRef,
    font_regular: &IndirectFontRef,
) -> PdfLayerReference {
    let (pi, li) = doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
    page_layers.push((pi, li, Vec::new()));
    *total_pages += 1;
    let l = doc.get_page(pi).get_layer(li);
    l.use_text(title, 14.0, Mm(MARGIN_L), Mm(PAGE_H - 20.0), font_bold);
    l.use_text(format!("# {}", number), 9.0, Mm(MARGIN_L), Mm(PAGE_H - 30.0), font_regular);
    let div = Line {
        points: vec![
            (Point::new(Mm(MARGIN_L), Mm(PAGE_H - 35.0)), false),
            (Point::new(Mm(CONTENT_R), Mm(PAGE_H - 35.0)), false),
        ],
        is_closed: false,
    };
    l.set_outline_thickness(0.3);
    l.add_line(div);
    l
}

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
    // The return-policy text frozen on this invoice row (R-162). Empty for quotes and
    // for any invoice finalized without the clause.
    return_policy: &str,
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

    // `mut` because the clause block may add pages of its own after the item pages are
    // laid out; the page-number footer below reads this, so it has to stay truthful.
    let mut total_pages = if items.len() <= rows_page1 {
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
    let mut last_layer = if last_page_idx == 0 {
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
        // A payment-method read that fails means "no payment block", not "no invoice".
        // Propagating here would abort the whole render over an optional section.
        let pm = load_active_payment_methods().unwrap_or_default();
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
        next_y = n_y - 4.0;
    }

    // Standing policy clauses (R-162), below the notes and above the footer. Kept
    // visually separate from Notes on purpose: notes are per-shipment instructions,
    // these are terms.
    //
    // These CONTINUE ONTO A NEW PAGE rather than truncating at the footer floor. The
    // first cut of this block just stopped, cutting the warranty disclaimer off
    // mid-sentence on exactly the item-heavy invoices where the amounts are largest.
    // Terms that stop halfway are worse than no terms, so nothing here is ever dropped.
    let clauses = document_clauses(return_policy);
    if !clauses.is_empty() {
        const CLAUSE_FLOOR: f32 = 25.0;
        const LINE_H: f32 = 3.5;
        const HEAD_H: f32 = 5.0;
        let mut cur = ClauseCursor::new(next_y, CLAUSE_FLOOR, CONT_START_Y);
        let mut clause_layer = last_layer.clone();
        let mut spilled = false;

        for (heading, body) in clauses {
            let lines = wrap_clause(&body, 108);
            // Keep a heading with its first two lines so it never orphans at a page foot.
            let keep = LINE_H * (lines.len().min(2) as f32);

            let was = cur.page;
            let hy = cur.take(HEAD_H, keep);
            if cur.page != was {
                clause_layer = start_clause_page(&doc, &mut page_layers, &mut total_pages,
                                                 title, number, &font_bold, &font_regular);
                spilled = true;
            }
            clause_layer.use_text(format!("{}:", heading), 9.0, Mm(MARGIN_L), Mm(hy), &font_bold);

            for ln in lines {
                let was = cur.page;
                let ly = cur.take(LINE_H, 0.0);
                if cur.page != was {
                    clause_layer = start_clause_page(&doc, &mut page_layers, &mut total_pages,
                                                     title, number, &font_bold, &font_regular);
                    spilled = true;
                }
                clause_layer.use_text(&ln, 8.0, Mm(MARGIN_L + 5.0), Mm(ly), &font_regular);
            }
            cur.gap(4.0);
        }

        // The closing footer belongs under the terms, on whatever page they ended on.
        if spilled {
            last_layer = clause_layer;
        }
        next_y = cur.y;
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
pub(crate) fn render_logo(
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
    // Errors here are already handled by the caller as "no payment block"; a missing pool
    // must take the same path rather than panicking mid-render.
    let conn = crate::db::pool_opt()
        .ok_or_else(|| anyhow::anyhow!("DB pool not initialized"))?
        .get()?;
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
        &cname, &cemail, &ccompany, &client_address, &company, &notes,
        // The wording frozen on THIS row, never today's default (R-162).
        &invoice_return_policy(invoice_id),
        &status, "invoice",
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
        // The sample has no invoice row to freeze a policy on, so it renders none.
        "",
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
         Payment instructions are detailed in the document.\n\nThank you!{}",
        cname.split_whitespace().next().unwrap_or(&cname),
        number,
        fmt_dollar(total),
        // The clauses repeat in the message body, not just on the attached PDF (R-162):
        // a buyer who never opens the attachment has still been told. This is the policy
        // frozen on THIS invoice, so the email restates exactly what the PDF prints.
        clause_email_block(&invoice_return_policy(invoice_id)),
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
        &cli.0, &cli.1, &cli.2, &client_address, &company, &q.8,
        // Quotes carry no return policy — it is an invoice-level term (R-162).
        "",
        &q.9, "quote",
    )?;

    let dir = quote_output_dir();
    std::fs::create_dir_all(&dir)?;
    let pdf_path = dir.join(format!("{}.pdf", q.0));
    std::fs::write(&pdf_path, pdf_bytes)?;

    let conn = pool().get()?;
    conn.execute("UPDATE quotes SET pdf_path=?1 WHERE id=?2", rusqlite::params![pdf_path.to_string_lossy(), quote_id])?;
    Ok(pdf_path.to_string_lossy().to_string())
}

pub async fn send_quote(quote_id: &str, thread: bool) -> Result<()> {
    let (number, total, pdf_path, cname, cemail, src_mid, src_subject, was_draft) = {
        let conn = pool().get()?;
        let q: (String, String, f64, Option<String>, String) = conn.query_row(
            "SELECT number,client_id,total,pdf_path,status FROM quotes WHERE id=?1",
            [quote_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let cli: (String, Option<String>, String) = conn.query_row(
            "SELECT name,email,COALESCE(metadata,'') FROM clients WHERE id=?1", [&q.1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        // The last inbound email we captured from this client — the thread to reply into.
        let meta: serde_json::Value = serde_json::from_str(&cli.2).unwrap_or(serde_json::Value::Null);
        let str_meta = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        (q.0, q.2, q.3, cli.0, cli.1, str_meta("src_message_id"), str_meta("src_subject"), q.4 == "draft")
    };

    let pdf = match pdf_path {
        Some(p) if std::path::Path::new(&p).exists() => p,
        _ => generate_quote_pdf(quote_id).await?,
    };

    let to = cemail.context("client has no email")?;

    // When threading into the customer's conversation, use a matching "Re: …" subject
    // (from their last email) so Gmail/Outlook group it; fall back to the plain quote
    // subject when we have the thread id but no stored subject, or aren't threading.
    let (subject, in_reply_to) = if thread {
        match src_mid {
            Some(mid) => {
                let subj = match src_subject {
                    Some(s) if s.to_lowercase().starts_with("re:") => s,
                    Some(s) => format!("Re: {s}"),
                    None => format!("Quote {number}"),
                };
                (subj, Some(mid))
            }
            None => (format!("Quote {number}"), None),
        }
    } else {
        (format!("Quote {number}"), None)
    };

    let body = format!(
        "Hi {},\n\nPlease find attached our quote {} for {}.\n\n\
         This quotation is valid until the date shown in the document. \
         Let us know if you'd like to proceed.\n\nThank you!{}",
        cname.split_whitespace().next().unwrap_or(&cname), number, fmt_dollar(total),
        // Standing notice only. The return policy is an invoice-level term, so a quote
        // passes an empty string — a quotation is not yet a sale and carries no return terms.
        clause_email_block(""),
    );

    crate::email::send_threaded(&to, &subject, &body, Some(&pdf), in_reply_to.as_deref()).await?;

    let now = Utc::now().to_rfc3339();
    let mut cols = serde_json::Map::new();
    // Only a draft is promoted to "sent" — re-emailing an accepted/converted quote
    // (the Email button is always available) must not revert its status, locally or
    // across synced devices. Mirrors send_invoice.
    if was_draft {
        cols.insert("status".into(), serde_json::Value::String("sent".into()));
    }
    cols.insert("sent_at".into(), serde_json::Value::String(now.clone()));
    crate::sync::record_upsert("quotes", quote_id, cols)?;
    let conn = pool().get()?;
    conn.execute(
        "UPDATE quotes SET status = CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at=?1 WHERE id=?2",
        rusqlite::params![now, quote_id],
    )?;
    Ok(())
}

// ---------- Helpers ----------

fn pdf_output_dir() -> std::path::PathBuf {
    crate::db::app_data_dir().join("invoices")
}

pub(crate) fn short_date(rfc3339: &str) -> String {
    rfc3339.split('T').next().unwrap_or(rfc3339).to_string()
}

pub(crate) fn fmt_dollar(n: f64) -> String {
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

#[cfg(test)]
mod clause_tests {
    use super::{wrap_clause, ClauseCursor};

    // The layout the real renderer uses: 25mm footer floor, continuation pages start at
    // 219.4mm (PAGE_H - 60).
    const FLOOR: f32 = 25.0;
    const TOP: f32 = 279.4 - 60.0;
    const LINE: f32 = 3.5;

    // Plenty of room: the block stays where it started and adds no pages.
    #[test]
    fn a_block_that_fits_never_breaks() {
        let mut c = ClauseCursor::new(200.0, FLOOR, TOP);
        for _ in 0..10 { c.take(LINE, 0.0); }
        assert_eq!(c.page, 0);
    }

    // The defect this replaced: rows below the floor used to be dropped on the floor.
    // Every requested row must come back with a baseline at or above the floor.
    #[test]
    fn rows_past_the_floor_move_to_a_new_page_instead_of_vanishing() {
        let mut c = ClauseCursor::new(40.0, FLOOR, TOP);
        let ys: Vec<f32> = (0..20).map(|_| c.take(LINE, 0.0)).collect();
        assert_eq!(ys.len(), 20, "no row may be dropped");
        assert!(ys.iter().all(|y| *y >= FLOOR), "every row sits above the footer floor");
        assert_eq!(c.page, 1, "one page was enough for 20 rows");
    }

    // A heading stranded at the foot of a page with its text overleaf reads as a defect,
    // so `keep_with` moves it down with the first lines that belong to it.
    #[test]
    fn a_heading_is_never_orphaned_from_its_first_lines() {
        // Room for the heading alone, but not for the heading plus two lines.
        let mut c = ClauseCursor::new(FLOOR + 6.0, FLOOR, TOP);
        let heading_y = c.take(5.0, LINE * 2.0);
        let first_line_y = c.take(LINE, 0.0);
        assert_eq!(c.page, 1, "the heading moved to the next page");
        assert!(heading_y > first_line_y, "the first line still sits under its heading");
    }

    // Termination guard: at the top of a fresh page a row is emitted even if it somehow
    // still does not fit, so a clause taller than a page cannot loop forever.
    #[test]
    fn a_fresh_page_never_breaks_again_immediately() {
        let mut c = ClauseCursor::new(TOP, FLOOR, TOP);
        c.take(500.0, 500.0);
        assert_eq!(c.page, 0, "already at the top — emit rather than add an empty page");
    }

    // ---- End-to-end: render a real PDF and count the pages in the bytes ----
    // The unit tests above prove the arithmetic; this proves the arithmetic is actually
    // wired to printpdf. Renders the same invoice twice, once with terms and once without,
    // and asserts the terms bought a page. Without the fix the clause block truncated in
    // silence and the page count was identical.
    use super::{build_pdf_bytes, CompanyInfo, LineItem};

    fn page_count(pdf: &[u8]) -> usize {
        // `/Count n` in the page-tree node is the page total. Read the first one; printpdf
        // emits a single flat Pages node. Falls back to counting `/Type/Page` markers.
        let hay = pdf.to_vec();
        if let Some(i) = hay.windows(7).position(|w| w == b"/Count ") {
            let mut n = 0usize;
            for b in &hay[i + 7..] {
                if b.is_ascii_digit() { n = n * 10 + (b - b'0') as usize; } else { break; }
            }
            if n > 0 { return n; }
        }
        hay.windows(10).filter(|w| *w == b"/Type/Page" ).count()
    }

    #[test]
    fn page_count_helper_can_actually_read_a_pdf() {
        // Guards the guard: if this returns 0 the assertions below would pass vacuously.
        assert!(page_count(&render(2, "")) >= 1, "page_count must find pages in a real PDF");
    }

    fn render(items: usize, policy: &str) -> Vec<u8> {
        let li: Vec<LineItem> = (0..items).map(|i| LineItem {
            description: format!("Mixed pallet lot {}", i),
            qty: 1.0, rate: 100.0, amount: 100.0,
        }).collect();
        build_pdf_bytes(
            "INV-9001", "2026-08-20", "2026-09-20", &li,
            100.0 * items as f64, 0.0, 100.0 * items as f64,
            "Test Buyer", &None, &None, &None,
            &CompanyInfo {
                name: "BJM DISTRIBUTIONS".into(),
                address: "699 Green Garden Place".into(),
                email: "test@example.com".into(),
                phone: None, tax_id: None, logo_path: None, show_company_name: Some(true),
            },
            "", policy, "sent", "invoice",
        ).expect("render must succeed")
    }

    const REAL_POLICY: &str = "All sales are final. No returns, refunds, exchanges, or cancellations are accepted once payment is made or the goods are removed, whichever occurs first. All goods are sold AS-IS, WHERE-IS and WITH ALL FAULTS. SELLER DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. Manifests, piece counts, condition codes, and stated retail values are estimates provided for reference only and are not warranted; Buyer is responsible for its own inspection and relies solely on its own judgment in purchasing. Where Seller accepts a timely claim under the notice provision, Buyer's sole and exclusive remedy is, at Seller's option, replacement or a credit not to exceed the purchase price of the affected lot. Seller is not liable for incidental, consequential, special, or lost-profit damages. Payment of this invoice or removal of the goods constitutes acceptance of these terms.";

    // 13 items is the boundary measured on this layout: the table still fits on one page,
    // and the leftover space below it is smaller than the terms. Before the fix this
    // rendered as a single page with the warranty disclaimer cut off mid-sentence.
    #[test]
    fn a_cramped_invoice_gains_a_page_rather_than_losing_its_terms() {
        let without = page_count(&render(13, ""));
        let with = page_count(&render(13, REAL_POLICY));
        assert_eq!(without, 1, "13 items alone still fit on one page");
        assert_eq!(with, 2, "the terms did not fit under them, so they took a page");
    }

    // The band either side of that boundary must behave: no spurious page when there is
    // room, and never fewer pages with terms than without, at any length.
    #[test]
    fn terms_never_shrink_a_document_and_never_pad_one_that_had_room() {
        for n in 0..24 {
            let without = page_count(&render(n, ""));
            let with = page_count(&render(n, REAL_POLICY));
            assert!(with >= without, "items={} lost a page ({} -> {})", n, without, with);
            assert!(with <= without + 1, "items={} added more than one page ({} -> {})", n, without, with);
        }
    }

    // The common case must not sprout a spurious page.
    #[test]
    fn a_short_invoice_with_terms_stays_on_one_page() {
        assert_eq!(page_count(&render(2, REAL_POLICY)), 1);
    }

    // No clauses configured: byte-identical to the pre-R-162 document.
    #[test]
    fn no_clauses_means_no_extra_page() {
        assert_eq!(page_count(&render(2, "")), 1);
    }

    // Whitespace between clauses must not be worth a page of its own.
    #[test]
    fn a_trailing_gap_does_not_add_a_page() {
        let mut c = ClauseCursor::new(FLOOR + 1.0, FLOOR, TOP);
        c.gap(10.0);
        assert_eq!(c.page, 0);
    }

    // The full real block — the 972-char return policy and the 570-char notice at the
    // measured wrap of 108 chars — starting from a cramped position on a busy invoice.
    // Before the fix this silently lost most of the disclaimer.
    #[test]
    fn the_real_two_clause_block_survives_a_cramped_invoice() {
        let counts = [9usize, 6];
        let mut c = ClauseCursor::new(60.0, FLOOR, TOP);
        let mut emitted = 0;
        for n in counts {
            c.take(5.0, LINE * 2.0);
            for _ in 0..n { assert!(c.take(LINE, 0.0) >= FLOOR); emitted += 1; }
            c.gap(4.0);
        }
        assert_eq!(emitted, 15, "every wrapped line of both clauses is placed");
        assert!(c.page >= 1, "it did not fit on the cramped page, so it spilled");
    }

    // A clause is one long sentence in practice; the renderer has a fixed page width, so
    // wrapping is the only thing standing between a real policy and text running off the
    // right edge of the PDF. The 25.0mm floor in build_pdf_bytes stops the vertical run.
    #[test]
    fn wraps_at_the_limit_without_splitting_words() {
        let out = wrap_clause("alpha bravo charlie delta echo", 11);
        assert_eq!(out, vec!["alpha bravo", "charlie", "delta echo"]);
        assert!(out.iter().all(|l| l.chars().count() <= 11));
    }

    // A multi-paragraph policy keeps its shape: blank lines survive so the clause reads
    // the way it was typed rather than collapsing into one block.
    #[test]
    fn blank_lines_are_preserved() {
        assert_eq!(wrap_clause("one\n\ntwo", 40), vec!["one", "", "two"]);
    }

    // A word longer than the limit (a URL, a case number) gets its own line rather than
    // being cut in half — the notes block above behaves the same way.
    #[test]
    fn an_overlong_word_is_not_split() {
        assert_eq!(wrap_clause("hi supercalifragilistic", 5), vec!["hi", "supercalifragilistic"]);
    }

    // Nothing in, nothing out — the guard that keeps an enabled-but-empty clause from
    // printing a bare heading on an invoice.
    #[test]
    fn empty_text_yields_no_lines() {
        assert!(wrap_clause("", 40).is_empty());
        assert!(wrap_clause("   ", 40).iter().all(|l| l.is_empty()));
    }
}
