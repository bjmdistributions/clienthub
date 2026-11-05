//! R-585: purchase order creator. A letterhead PDF built with `printpdf`, reusing the
//! invoice branding (`company_info` + `invoice_template`) so the PO goes out on OUR
//! letterhead. The parties, line items and the terms block are all editable; the form
//! prefills the terms with the protection clauses Jack wants on every order (inspection
//! before payment, proof of life, authenticity, condition and shortage).
//!
//! Layout (top to bottom, flowing across pages):
//!   - Letterhead (logo and company name)
//!   - Title "PURCHASE ORDER" with the PO number, date and payment terms
//!   - Parties: buyer and seller, side by side
//!   - Order details: a ruled table (Style / SKU / Size / Condition / Qty / Unit / Extended)
//!   - Totals (units + total price)
//!   - Terms & contingencies of purchase (the editable block)
//!   - Signatures: buyer authorization and seller acceptance

use anyhow::{Context, Result};
use printpdf::*;
use serde::Deserialize;
use std::io::BufWriter;

use crate::invoice::{
    load_company, load_template, render_logo, text_width_mm, CompanyInfo, InvoiceTemplate,
    CONTENT_R, MARGIN_L, PAGE_H, PAGE_W,
};

const TITLE: &str = "PURCHASE ORDER";
const TITLE_SIZE: f32 = 17.0;
const BODY_SIZE: f32 = 9.5;
const SMALL_SIZE: f32 = 8.5;
const LINE_H: f32 = 4.7;
const PARA_GAP: f32 = 2.4;
/// Bottom margin before a new page is started.
const PAGE_BOTTOM: f32 = 26.0;

fn black() -> Color {
    Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None))
}
fn row_fill() -> Color {
    Color::Rgb(Rgb::new(0.96, 0.96, 0.96, None))
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoLine {
    pub style: String,
    pub sku: String,
    pub size: String,
    pub condition: String,
    pub qty: f64,
    pub unit_price: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PurchaseOrderInput {
    pub po_number: String,
    pub po_date: String,
    pub buyer_name: String,
    pub buyer_company: String,
    pub buyer_contact: String,
    pub seller_name: String,
    pub seller_company: String,
    pub seller_contact: String,
    pub items: Vec<PoLine>,
    /// The terms and contingencies, editable. The form prefills the protection clauses.
    pub terms: String,
    pub buyer_sign_name: String,
    pub seller_sign_name: String,
    /// Where the PDF is written (the Downloads folder, resolved in the command).
    pub output_path: String,
}

struct Doc<'a> {
    doc: PdfDocumentReference,
    layer: PdfLayerReference,
    regular: IndirectFontRef,
    bold: IndirectFontRef,
    y: f32,
    company: &'a CompanyInfo,
    tpl: &'a InvoiceTemplate,
}

impl<'a> Doc<'a> {
    fn content_w(&self) -> f32 {
        CONTENT_R - MARGIN_L
    }

    fn page(&mut self) {
        let (pi, li) = self.doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
        self.layer = self.doc.get_page(pi).get_layer(li);
        self.y = PAGE_H - 26.0;
    }

    fn text(&mut self, s: &str, size: f32, x: f32, bold: bool) {
        let font = if bold { &self.bold } else { &self.regular };
        self.layer.use_text(s, size, Mm(x), Mm(self.y), font);
        self.y -= LINE_H;
    }

    fn right(&mut self, s: &str, size: f32, right_x: f32, bold: bool) {
        let font = if bold { &self.bold } else { &self.regular };
        let w = text_width_mm(s, size, bold);
        self.layer.use_text(s, size, Mm(right_x - w), Mm(self.y), font);
        self.y -= LINE_H;
    }

    fn wrapped(&mut self, text: &str, size: f32, bold: bool, indent: f32) {
        let max_w = self.content_w() - indent;
        for raw_line in text.lines() {
            if self.y < PAGE_BOTTOM {
                self.page();
            }
            if raw_line.trim().is_empty() {
                self.y -= PARA_GAP;
                continue;
            }
            let mut line = String::new();
            for word in raw_line.split_whitespace() {
                let cand = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                if !line.is_empty() && text_width_mm(&cand, size, bold) > max_w {
                    self.text(&line, size, MARGIN_L + indent, bold);
                    line = word.to_string();
                } else {
                    line = cand;
                }
            }
            if !line.is_empty() {
                self.text(&line, size, MARGIN_L + indent, bold);
            }
        }
    }

    /// A light grey band, used for the table header row.
    fn band(&self, top: f32, height: f32) {
        self.layer.set_fill_color(row_fill());
        let pts = vec![
            (Point::new(Mm(MARGIN_L), Mm(top)), false),
            (Point::new(Mm(CONTENT_R), Mm(top)), false),
            (Point::new(Mm(CONTENT_R), Mm(top - height)), false),
            (Point::new(Mm(MARGIN_L), Mm(top - height)), false),
        ];
        self.layer.add_polygon(Polygon {
            rings: vec![pts],
            mode: path::PaintMode::Fill,
            winding_order: path::WindingOrder::NonZero,
        });
        self.layer.set_fill_color(black());
    }

    fn rule(&self, y: f32, thickness: f32) {
        self.layer.set_outline_thickness(thickness);
        self.layer.add_line(Line {
            points: vec![(Point::new(Mm(MARGIN_L), Mm(y)), false), (Point::new(Mm(CONTENT_R), Mm(y)), false)],
            is_closed: false,
        });
    }
}

fn extend(line: &PoLine) -> f64 {
    line.qty * line.unit_price
}

fn money(v: f64) -> String {
    format!("${:.2}", v)
}

fn format_qty(v: f64) -> String {
    if v == v.trunc() { format!("{v:.0}") } else { format!("{v}") }
}

fn clip(text: &str, size: f32, bold: bool, max_w: f32) -> String {
    let mut t = text.to_string();
    while !t.is_empty() && text_width_mm(&t, size, bold) > max_w {
        t.pop();
    }
    if t.len() != text.len() {
        t = t.trim_end().to_string();
        t.push('.');
    }
    t
}

/// The columns, as (x, width, right_aligned) for each header.
const COLUMNS: [(&str, f32, bool); 7] = [
    ("Style", 46.0, false),
    ("SKU", 26.0, false),
    ("Size", 13.0, false),
    ("Condition", 24.0, false),
    ("Qty", 14.0, true),
    ("Unit", 24.0, true),
    ("Extended", 0.0, true),
];

pub fn build_po_bytes(
    input: &PurchaseOrderInput,
    company: &CompanyInfo,
    tpl: &InvoiceTemplate,
) -> Result<Vec<u8>> {
    let (doc, page, layer_idx) = PdfDocument::new("Purchase order", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let layer = doc.get_page(page).get_layer(layer_idx);
    let regular = doc.add_builtin_font(BuiltinFont::Helvetica)?;
    let bold = doc.add_builtin_font(BuiltinFont::HelveticaBold)?;
    let mut d = Doc { doc, layer, regular, bold, y: PAGE_H - 26.0, company, tpl };

    // ----- Letterhead -----
    let logo_local = crate::invoice::usable_logo(company.logo_path.as_deref());
    let logo = match logo_local.as_deref() {
        Some(p) if std::path::Path::new(p).exists() => {
            render_logo(&d.layer, p, &tpl.logo_placement, tpl.logo_size_factor()).unwrap_or(None)
        }
        _ => None,
    };
    d.y = match &logo {
        Some(l) => l.bottom_y - 12.0,
        None => {
            d.text(&company.name, 16.0, MARGIN_L, true);
            PAGE_H - 48.0
        }
    };
    if !company.address.trim().is_empty() {
        d.text(company.address.trim(), SMALL_SIZE, MARGIN_L, false);
    }
    let mut contact_parts: Vec<String> = Vec::new();
    if !company.email.trim().is_empty() {
        contact_parts.push(company.email.trim().to_string());
    }
    if let Some(p) = company.phone.as_deref() {
        if !p.trim().is_empty() {
            contact_parts.push(p.trim().to_string());
        }
    }
    let contact = contact_parts.join(", ");
    if !contact.is_empty() {
        d.text(&contact, SMALL_SIZE, MARGIN_L, false);
    }
    d.y -= 4.0;
    d.rule(d.y, 0.4);
    d.y -= 6.0;

    // ----- Title + metadata -----
    d.layer.set_fill_color(tpl.accent());
    d.text(TITLE, TITLE_SIZE, MARGIN_L, true);
    d.layer.set_fill_color(black());
    d.y -= 1.0;
    let number = input.po_number.trim();
    d.text(&format!("PO number: {}", if number.is_empty() { "Not set" } else { number }), BODY_SIZE, MARGIN_L, false);
    d.text(&format!("Date: {}", input.po_date.trim()), BODY_SIZE, MARGIN_L, false);
    d.text("Payment terms: funds released only after every term below is satisfied.", BODY_SIZE, MARGIN_L, false);

    // ----- Parties -----
    d.y -= 6.0;
    let half = d.content_w() / 2.0;
    let party = |d: &mut Doc, title: &str, name: &str, company: &str, contact: &str, x: f32| {
        d.text(title, BODY_SIZE, x, true);
        d.text(&format!("{}", name.trim()), BODY_SIZE, x, false);
        if !company.trim().is_empty() {
            d.text(company.trim(), BODY_SIZE, x, false);
        }
        if !contact.trim().is_empty() {
            d.text(contact.trim(), BODY_SIZE, x, false);
        }
    };
    let y_before = d.y;
    party(&mut d, "BUYER", &input.buyer_name, &input.buyer_company, &input.buyer_contact, MARGIN_L);
    let left_bottom = d.y;
    d.y = y_before;
    party(&mut d, "SELLER", &input.seller_name, &input.seller_company, &input.seller_contact, MARGIN_L + half);
    d.y = left_bottom.min(d.y);

    // ----- Order details table -----
    d.y -= 8.0;
    if d.y < PAGE_BOTTOM + 46.0 {
        d.page();
    }
    d.text("ORDER DETAILS & INVENTORY SCHEDULE", BODY_SIZE, MARGIN_L, true);
    d.y -= 1.0;

    // Column x positions (the last column fills the remaining width).
    let mut xs = Vec::with_capacity(COLUMNS.len());
    let mut cursor = MARGIN_L;
    let mut known_w = 0.0_f32;
    for (_, w, _) in COLUMNS.iter() {
        if *w == 0.0 { continue; }
        known_w += *w;
    }
    for (_, w, _) in COLUMNS.iter() {
        let w = if *w == 0.0 { d.content_w() - known_w } else { *w };
        xs.push((cursor, w));
        cursor += w;
    }

    let header_top = d.y + 1.0;
    d.band(header_top, 6.0);
    d.y -= 4.0;
    for (i, (head, _, right)) in COLUMNS.iter().enumerate() {
        let (x, w) = xs[i];
        d.layer.set_fill_color(black());
        if *right {
            d.right(head, SMALL_SIZE, x + w - 1.0, true);
        } else {
            d.text(head, SMALL_SIZE, x + 1.0, true);
        }
    }
    d.y -= 1.5;
    d.rule(d.y, 0.4);
    d.y -= 3.0;

    let mut total_units = 0.0_f64;
    let mut total_price = 0.0_f64;
    for line in &input.items {
        if d.y < PAGE_BOTTOM + 12.0 {
            d.page();
        }
        let ext = extend(line);
        total_units += line.qty;
        total_price += ext;
        let cells: [(&str, usize, bool); 7] = [
            (&line.style, 0, false),
            (&line.sku, 1, false),
            (&line.size, 2, false),
            (&line.condition, 3, false),
            ("", 4, true),
            ("", 5, true),
            ("", 6, true),
        ];
        // Render the string cells first, then the numeric ones.
        for (text, i, right) in cells {
            let (x, w) = xs[i];
            if text.is_empty() {
                continue;
            }
            let clipped = clip(text, BODY_SIZE, false, w - 2.0);
            if right {
                d.right(&clipped, BODY_SIZE, x + w - 1.0, false);
            } else {
                d.text(&clipped, BODY_SIZE, x + 1.0, false);
            }
        }
        // Numeric cells share the row baseline, so they are drawn after the strings.
        let (qx, qw) = xs[4];
        d.right(&format_qty(line.qty), BODY_SIZE, qx + qw - 1.0, false);
        let (ux, uw) = xs[5];
        d.right(&money(line.unit_price), BODY_SIZE, ux + uw - 1.0, false);
        let (ex, ew) = xs[6];
        d.right(&money(ext), BODY_SIZE, ex + ew - 1.0, false);
        d.y -= LINE_H;
    }
    d.rule(d.y + 3.0, 0.4);
    d.y -= 6.0;

    // ----- Totals -----
    let (ex, ew) = xs[6];
    d.right(&format!("TOTAL UNITS: {}", format_qty(total_units)), BODY_SIZE, ex + ew - 1.0, true);
    d.right(&format!("TOTAL PURCHASE PRICE: {}", money(total_price)), BODY_SIZE, ex + ew - 1.0, true);

    // ----- Terms -----
    d.y -= 8.0;
    if d.y < PAGE_BOTTOM + 60.0 {
        d.page();
    }
    d.text("TERMS & CONTINGENCIES OF PURCHASE", BODY_SIZE, MARGIN_L, true);
    d.y -= 2.0;
    d.wrapped(input.terms.trim(), BODY_SIZE, false, 0.0);

    // ----- Signatures -----
    d.y -= 10.0;
    if d.y < PAGE_BOTTOM + 40.0 {
        d.page();
    }
    let sign = |d: &mut Doc, title: &str, name: &str, x: f32| {
        d.text(title, BODY_SIZE, x, true);
        d.y -= 9.0;
        d.layer.set_outline_thickness(0.4);
        d.layer.add_line(Line {
            points: vec![(Point::new(Mm(x), Mm(d.y)), false), (Point::new(Mm(x + 80.0), Mm(d.y)), false)],
            is_closed: false,
        });
        d.y -= 4.5;
        d.text(&format!("Name: {}", name.trim()), BODY_SIZE, x, false);
        d.text(&format!("Date: {}", input.po_date.trim()), BODY_SIZE, x, false);
        d.y -= 10.0;
    };
    let y_before = d.y;
    sign(&mut d, "BUYER AUTHORIZATION", &input.buyer_sign_name, MARGIN_L);
    let left = d.y;
    d.y = y_before;
    sign(&mut d, "SELLER ACCEPTANCE", &input.seller_sign_name, MARGIN_L + half);
    d.y = left.min(d.y);

    let mut writer = BufWriter::new(Vec::new());
    d.doc.save(&mut writer)?;
    writer.into_inner().map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))
}

/// The PDF's file name: the PO number if it was given, else `purchase-order.pdf`.
fn file_name(po_number: &str) -> String {
    let n = po_number.trim();
    if n.is_empty() {
        return "purchase-order.pdf".into();
    }
    let cleaned: String = n.chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    if cleaned.trim().is_empty() { "purchase-order.pdf".into() } else { format!("{cleaned}.pdf") }
}

/// The Downloads folder, falling back to the documents directory. Jack asked for a
/// one-button download that lands straight in Downloads with no save dialog.
fn downloads_dir() -> std::path::PathBuf {
    dirs::download_dir()
        .or_else(|| dirs::document_dir())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

#[tauri::command]
pub async fn generate_purchase_order(input: PurchaseOrderInput) -> Result<String, String> {
    let company = load_company().map_err(|e| e.to_string())?;
    let tpl = load_template();
    let bytes = build_po_bytes(&input, &company, &tpl).map_err(|e| e.to_string())?;
    let path = downloads_dir().join(file_name(&input.po_number));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn company() -> CompanyInfo {
        CompanyInfo {
            name: "BJM Distributions".into(),
            address: String::new(),
            email: String::new(),
            phone: None,
            tax_id: None,
            logo_path: None,
            show_company_name: None,
        }
    }

    fn line(style: &str, qty: f64, unit: f64) -> PoLine {
        PoLine { style: style.into(), sku: "SKU".into(), size: "10".into(), condition: "New".into(), qty, unit_price: unit }
    }

    fn input(items: Vec<PoLine>) -> PurchaseOrderInput {
        PurchaseOrderInput {
            po_number: "PO-001".into(),
            po_date: "2026-11-04".into(),
            buyer_name: "Jack".into(),
            buyer_company: "BJM Distributions".into(),
            buyer_contact: "x".into(),
            seller_name: "S".into(),
            seller_company: String::new(),
            seller_contact: String::new(),
            items,
            terms: "This purchase order is binding only after inspection.\n\n1. Live inspection.".into(),
            buyer_sign_name: "Jack".into(),
            seller_sign_name: "S".into(),
            output_path: String::new(),
        }
    }

    #[test]
    fn totals_add_up_and_a_pdf_is_built() {
        let i = input(vec![line("Nike Dunk", 2.0, 90.0), line("Jordan 1", 1.0, 120.0)]);
        assert_eq!(extend(&i.items[0]), 180.0);
        assert_eq!(extend(&i.items[1]), 120.0);
        let bytes = build_po_bytes(&i, &company(), &load_template()).unwrap();
        assert!(bytes.len() > 1000, "a PDF, not an empty buffer");
        assert_eq!(bytes[..4], *b"%PDF");
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_name("PO-001"), "PO-001.pdf");
        assert_eq!(file_name(""), "purchase-order.pdf");
        assert_eq!(file_name("a/b\\c"), "abc.pdf");
    }
}
