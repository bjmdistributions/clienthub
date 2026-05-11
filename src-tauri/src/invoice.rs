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
//!
//! Transparency handling: PNG alpha channels are flattened against white
//! before embedding. Without this, transparent pixels become an arbitrary
//! garbage color (often green) when alpha is dropped.
//!
//! Sizing: Logo dimensions are computed against PDF's native 72 DPI rather
//! than trusting embedded DPI metadata, which is unreliable across image
//! editors and exporters.

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
}

pub struct ClientAddress {
    pub lines: Vec<String>,
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
        }),
    }
}

pub fn parse_client_address(metadata: &Option<String>) -> Option<ClientAddress> {
    let meta: serde_json::Value = serde_json::from_str(metadata.as_deref()?).ok()?;
    let street = meta.get("street_address")?.as_str()?;
    let city = meta.get("city")?.as_str()?;
    let state = meta.get("state")?.as_str()?;
    let zip = meta.get("zip_code")?.as_str()?;
    Some(ClientAddress {
        lines: vec![
            street.to_string(),
            format!("{}, {} {}", city, state, zip),
        ],
    })
}

// ---------- Layout constants ----------

const PAGE_W: f32 = 215.9; // US Letter width in mm
const PAGE_H: f32 = 279.4; // US Letter height in mm
const MARGIN_L: f32 = 20.0;
const MARGIN_R: f32 = 20.0;
const CONTENT_R: f32 = PAGE_W - MARGIN_R; // 195.9

// Logo target box (max bounds — preserves aspect ratio)
const LOGO_MAX_W: f32 = 50.0;
const LOGO_MAX_H: f32 = 25.0;
const LOGO_TOP: f32 = 268.0; // top edge of logo from page bottom

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
) -> Result<Vec<u8>> {
    let (doc, page1, layer1) = PdfDocument::new(
        format!("Invoice {}", number),
        Mm(PAGE_W),
        Mm(PAGE_H),
        "Layer 1",
    );
    let layer = doc.get_page(page1).get_layer(layer1);

    let font_regular = doc.add_builtin_font(BuiltinFont::Helvetica).context("font")?;
    let font_bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .context("font_bold")?;

    // ----- Logo + company header -----
    let mut header_bottom: f32 = 250.0; // baseline below header for divider line

    let logo_rendered = if let Some(logo_path) = company.logo_path.as_deref() {
        if std::path::Path::new(logo_path).exists() {
            render_logo(&layer, logo_path).unwrap_or(None)
        } else {
            None
        }
    } else {
        None
    };

    let text_y_top = if let Some(logo_bottom) = logo_rendered {
        // Logo on top, company text below it
        header_bottom = logo_bottom - 4.0;
        logo_bottom - 5.0
    } else {
        // No logo — company text starts at LOGO_TOP
        header_bottom = LOGO_TOP - 22.0;
        LOGO_TOP - 4.0
    };

    layer.use_text(
        &company.name,
        12.0,
        Mm(MARGIN_L),
        Mm(text_y_top),
        &font_bold,
    );
    layer.use_text(
        &company.address,
        9.0,
        Mm(MARGIN_L),
        Mm(text_y_top - 5.0),
        &font_regular,
    );
    layer.use_text(
        &company.email,
        9.0,
        Mm(MARGIN_L),
        Mm(text_y_top - 9.0),
        &font_regular,
    );
    if let Some(phone) = &company.phone {
        layer.use_text(
            phone,
            9.0,
            Mm(MARGIN_L),
            Mm(text_y_top - 13.0),
            &font_regular,
        );
    }

    // ----- INVOICE title (right side) -----
    layer.use_text("INVOICE", 28.0, Mm(150.0), Mm(263.0), &font_bold);
    layer.use_text(
        format!("# {}", number),
        11.0,
        Mm(150.0),
        Mm(255.0),
        &font_regular,
    );

    // ----- Divider line under header -----
    let divider_y = header_bottom.min(238.0); // never below 238mm
    let divider = Line {
        points: vec![
            (Point::new(Mm(MARGIN_L), Mm(divider_y)), false),
            (Point::new(Mm(CONTENT_R), Mm(divider_y)), false),
        ],
        is_closed: false,
    };
    layer.set_outline_thickness(0.5);
    layer.add_line(divider);

    // ----- Bill To block -----
    let bill_top = divider_y - 8.0;
    layer.use_text("BILL TO", 9.0, Mm(MARGIN_L), Mm(bill_top), &font_bold);
    layer.use_text(cname, 11.0, Mm(MARGIN_L), Mm(bill_top - 6.0), &font_bold);

    let mut y = bill_top - 11.0;
    if let Some(co) = ccompany {
        layer.use_text(co, 10.0, Mm(MARGIN_L), Mm(y), &font_regular);
        y -= 5.0;
    }
    if let Some(addr) = client_address {
        for ln in &addr.lines {
            if y < bill_top - 25.0 {
                break;
            }
            layer.use_text(ln, 10.0, Mm(MARGIN_L), Mm(y), &font_regular);
            y -= 5.0;
        }
    }
    if let Some(em) = cemail {
        layer.use_text(em, 10.0, Mm(MARGIN_L), Mm(y), &font_regular);
    }

    // ----- Dates (right side, parallel with Bill To) -----
    layer.use_text("ISSUE DATE", 9.0, Mm(140.0), Mm(bill_top), &font_bold);
    layer.use_text(
        short_date(issue),
        10.0,
        Mm(140.0),
        Mm(bill_top - 6.0),
        &font_regular,
    );
    layer.use_text("DUE DATE", 9.0, Mm(170.0), Mm(bill_top), &font_bold);
    layer.use_text(
        short_date(due),
        10.0,
        Mm(170.0),
        Mm(bill_top - 6.0),
        &font_regular,
    );

    // ----- Line items table -----
    let table_top = bill_top - 35.0;
    let row_height = 7.0_f32;

    // Header row gray bar
    layer.set_fill_color(Color::Rgb(Rgb::new(0.95, 0.95, 0.95, None)));
    let header_rect_pts = vec![
        (Point::new(Mm(MARGIN_L), Mm(table_top + 2.0)), false),
        (Point::new(Mm(CONTENT_R), Mm(table_top + 2.0)), false),
        (Point::new(Mm(CONTENT_R), Mm(table_top - 5.0)), false),
        (Point::new(Mm(MARGIN_L), Mm(table_top - 5.0)), false),
    ];
    layer.add_polygon(Polygon {
        rings: vec![header_rect_pts],
        mode: path::PaintMode::Fill,
        winding_order: path::WindingOrder::NonZero,
    });
    layer.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));

    layer.use_text(
        "DESCRIPTION",
        9.0,
        Mm(22.0),
        Mm(table_top - 2.0),
        &font_bold,
    );
    layer.use_text("QTY", 9.0, Mm(125.0), Mm(table_top - 2.0), &font_bold);
    layer.use_text("RATE", 9.0, Mm(150.0), Mm(table_top - 2.0), &font_bold);
    layer.use_text("AMOUNT", 9.0, Mm(178.0), Mm(table_top - 2.0), &font_bold);

    let mut row_y = table_top - 12.0;
    for item in items {
        let desc = if item.description.len() > 60 {
            format!("{}...", &item.description[..57])
        } else {
            item.description.clone()
        };
        layer.use_text(&desc, 10.0, Mm(22.0), Mm(row_y), &font_regular);
        layer.use_text(
            format!("{:.2}", item.qty),
            10.0,
            Mm(125.0),
            Mm(row_y),
            &font_regular,
        );
        layer.use_text(
            fmt_dollar(item.rate),
            10.0,
            Mm(150.0),
            Mm(row_y),
            &font_regular,
        );
        layer.use_text(
            fmt_dollar(item.amount),
            10.0,
            Mm(178.0),
            Mm(row_y),
            &font_regular,
        );
        row_y -= row_height;
    }

    // ----- Totals block (right-aligned) -----
    let totals_divider_y = row_y;
    let totals_div = Line {
        points: vec![
            (Point::new(Mm(120.0), Mm(totals_divider_y)), false),
            (Point::new(Mm(CONTENT_R), Mm(totals_divider_y)), false),
        ],
        is_closed: false,
    };
    layer.add_line(totals_div);

    row_y -= 6.0;
    layer.use_text("Subtotal", 10.0, Mm(150.0), Mm(row_y), &font_regular);
    layer.use_text(
        fmt_dollar(subtotal),
        10.0,
        Mm(178.0),
        Mm(row_y),
        &font_regular,
    );
    row_y -= 5.0;
    layer.use_text("Tax", 10.0, Mm(150.0), Mm(row_y), &font_regular);
    layer.use_text(fmt_dollar(tax), 10.0, Mm(178.0), Mm(row_y), &font_regular);
    row_y -= 7.0;
    layer.use_text("TOTAL", 12.0, Mm(150.0), Mm(row_y), &font_bold);
    layer.use_text(fmt_dollar(total), 12.0, Mm(178.0), Mm(row_y), &font_bold);

    // ----- Payment Options block -----
    let pm = load_active_payment_methods()?;
    let mut next_y = row_y - 10.0;

    if !pm.is_empty() {
        let mut pay_y = next_y;
        layer.use_text("Payment Options", 10.0, Mm(MARGIN_L), Mm(pay_y), &font_bold);
        pay_y -= 6.0;
        for (kind, details) in &pm {
            if pay_y < 30.0 { break; }
            layer.use_text(format!("{}:", kind), 9.0, Mm(MARGIN_L), Mm(pay_y), &font_bold);
            pay_y -= 4.5;
            for ln in details.lines() {
                if pay_y < 25.0 { break; }
                layer.use_text(ln, 8.0, Mm(MARGIN_L + 5.0), Mm(pay_y), &font_regular);
                pay_y -= 3.5;
            }
            pay_y -= 2.0;
        }
        next_y = pay_y - 8.0;
    }

    if !notes.is_empty() {
        let mut n_y = next_y;
        layer.use_text("Notes:", 9.0, Mm(MARGIN_L), Mm(n_y), &font_bold);
        n_y -= 5.0;
        for ln in notes.lines() {
            if n_y < 25.0 { break; }
            layer.use_text(ln, 8.0, Mm(MARGIN_L + 5.0), Mm(n_y), &font_regular);
            n_y -= 3.5;
        }
    }

    // ----- Footer -----
    layer.use_text(
        "Thank you for your business.",
        9.0,
        Mm(MARGIN_L),
        Mm(18.0),
        &font_regular,
    );
    if let Some(tax_id) = &company.tax_id {
        layer.use_text(
            format!("Tax ID: {}", tax_id),
            8.0,
            Mm(MARGIN_L),
            Mm(13.0),
            &font_regular,
        );
    }

    // ----- Save to bytes -----
    let mut writer = BufWriter::new(Vec::new());
    doc.save(&mut writer)?;
    let pdf_bytes: Vec<u8> = writer
        .into_inner()
        .map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))?;
    Ok(pdf_bytes)
}

// ---------- Logo rendering ----------
//
// Returns the y-coordinate of the bottom edge of the rendered logo (in mm),
// or None if rendering failed. Caller uses this to place company text below.
//
// Key correctness details:
//   1. PNGs typically have an alpha channel. Naive RGB conversion drops alpha
//      and the resulting RGB values for fully-transparent pixels are undefined
//      (often green, depending on the decoder). We composite over white first.
//   2. Image DPI metadata is unreliable. We compute size from raw pixel
//      dimensions against PDF's native 72 DPI baseline, then scale to fit
//      within the LOGO_MAX_W x LOGO_MAX_H box while preserving aspect ratio.
fn render_logo(layer: &PdfLayerReference, logo_path: &str) -> Result<Option<f32>> {
    let bytes = std::fs::read(logo_path)?;
    let dyn_img = printpdf::image_crate::load_from_memory(&bytes)
        .context("decode logo image")?;

    // Composite RGBA over white background to flatten transparency.
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

    // Compute scale to fit within max box, preserving aspect ratio.
    // PDF's native baseline is 72 DPI: 1 mm = 72/25.4 ≈ 2.835 px.
    let px_per_mm: f32 = 72.0 / 25.4;
    let native_w_mm = w as f32 / px_per_mm;
    let native_h_mm = h as f32 / px_per_mm;
    let scale = (LOGO_MAX_W / native_w_mm)
        .min(LOGO_MAX_H / native_h_mm)
        .min(1.0);
    let logo_h_mm = native_h_mm * scale;
    let logo_y_bottom = LOGO_TOP - logo_h_mm;

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
            translate_x: Some(Mm(MARGIN_L)),
            translate_y: Some(Mm(logo_y_bottom)),
            scale_x: Some(scale),
            scale_y: Some(scale),
            rotate: None,
            dpi: Some(72.0),
        },
    );
    Ok(Some(logo_y_bottom))
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
    // Collect all DB data first (conn is not Send, can't cross await)
    let (number, _client_id, issue, due, items_json, subtotal, tax, total, notes, cname, cemail, ccompany, cmetadata) = {
        let conn = pool().get()?;
        let inv: (String, String, String, String, String, f64, f64, f64, String) = conn.query_row(
            "SELECT number,client_id,issue_date,due_date,line_items_json,subtotal,tax,total,notes
             FROM invoices WHERE id=?1",
            [invoice_id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                    r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?,
                ))
            },
        )?;
        let cli: (String, Option<String>, Option<String>, Option<String>) = conn.query_row(
            "SELECT name,email,company,metadata FROM clients WHERE id=?1",
            [&inv.1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        (
            inv.0, inv.1, inv.2, inv.3, inv.4, inv.5, inv.6, inv.7, inv.8,
            cli.0, cli.1, cli.2, cli.3,
        )
    };

    let client_address = parse_client_address(&cmetadata);
    let items: Vec<LineItem> = serde_json::from_str(&items_json)?;
    let company = load_company()?;

    let pdf_bytes = build_pdf_bytes(
        &number, &issue, &due, &items, subtotal, tax, total,
        &cname, &cemail, &ccompany, &client_address, &company, &notes,
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

pub async fn send_invoice(invoice_id: &str) -> Result<()> {
    // Collect everything we need before the await
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

    let conn = pool().get()?;
    conn.execute(
        "UPDATE invoices SET status='sent', sent_at=?1 WHERE id=?2",
        rusqlite::params![Utc::now().to_rfc3339(), invoice_id],
    )?;
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