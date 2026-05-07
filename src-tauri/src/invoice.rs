//! Invoice module: PDF generation via `printpdf` (pure Rust, no external binaries).
//!
//! Layout:
//!   - Letterhead (company name + contact)
//!   - INVOICE title + number + dates
//!   - Bill-To block
//!   - Line items table with Description / Qty / Rate / Amount
//!   - Subtotal / Tax / Total rows
//!   - Footer with payment terms + notes

use anyhow::{Context, Result};
use chrono::Utc;
use printpdf::*;
use serde::{Deserialize, Serialize};
use std::io::BufWriter;

use crate::db::pool;

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
}

fn load_company() -> Result<CompanyInfo> {
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
        }),
    }
}

pub async fn generate_pdf(invoice_id: &str) -> Result<String> {
    let conn = pool().get()?;
    let (number, client_id, issue, due, items_json, subtotal, tax, total): (
        String,
        String,
        String,
        String,
        String,
        f64,
        f64,
        f64,
    ) = conn.query_row(
        "SELECT number,client_id,issue_date,due_date,line_items_json,subtotal,tax,total
         FROM invoices WHERE id=?1",
        [invoice_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    )?;

    let (cname, cemail, ccompany, cmetadata): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT name,email,company,metadata FROM clients WHERE id=?1",
        [&client_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    let client_address = parse_client_address(&cmetadata);

    let items: Vec<LineItem> = serde_json::from_str(&items_json)?;
    let company = load_company()?;

    // ---------- PDF construction ----------
    // US Letter: 215.9mm x 279.4mm
    let (doc, page1, layer1) =
        PdfDocument::new(format!("Invoice {}", number), Mm(215.9), Mm(279.4), "Layer 1");
    let layer = doc.get_page(page1).get_layer(layer1);

    let font_regular = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .context("font")?;
    let font_bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .context("font_bold")?;

    // ----- Header: Company name (top-left), INVOICE title (top-right) -----
    layer.use_text(&company.name, 16.0, Mm(20.0), Mm(265.0), &font_bold);
    layer.use_text(&company.address, 9.0, Mm(20.0), Mm(259.0), &font_regular);
    layer.use_text(&company.email, 9.0, Mm(20.0), Mm(254.0), &font_regular);
    if let Some(phone) = &company.phone {
        layer.use_text(phone, 9.0, Mm(20.0), Mm(249.0), &font_regular);
    }

    layer.use_text("INVOICE", 28.0, Mm(150.0), Mm(263.0), &font_bold);
    layer.use_text(format!("# {}", number), 11.0, Mm(150.0), Mm(255.0), &font_regular);

    // ----- Divider line -----
    let line = Line {
        points: vec![
            (Point::new(Mm(20.0), Mm(240.0)), false),
            (Point::new(Mm(195.9), Mm(240.0)), false),
        ],
        is_closed: false,
    };
    layer.set_outline_thickness(0.5);
    layer.add_line(line);

    // ----- Bill To -----
    layer.use_text("BILL TO", 9.0, Mm(20.0), Mm(232.0), &font_bold);
    layer.use_text(&cname, 11.0, Mm(20.0), Mm(226.0), &font_bold);
    let mut y = 221.0;
    if let Some(co) = &ccompany {
        layer.use_text(co, 10.0, Mm(20.0), Mm(y), &font_regular);
        y -= 5.0;
    }
    if let Some(addr) = &client_address {
        for line in &addr.lines {
            if y < 200.0 {
                break;
            }
            layer.use_text(line, 10.0, Mm(20.0), Mm(y), &font_regular);
            y -= 5.0;
        }
    }
    if let Some(em) = &cemail {
        layer.use_text(em, 10.0, Mm(20.0), Mm(y), &font_regular);
    }

    // ----- Dates (right side) -----
    layer.use_text("ISSUE DATE", 9.0, Mm(140.0), Mm(232.0), &font_bold);
    layer.use_text(short_date(&issue), 10.0, Mm(140.0), Mm(226.0), &font_regular);
    layer.use_text("DUE DATE", 9.0, Mm(170.0), Mm(232.0), &font_bold);
    layer.use_text(short_date(&due), 10.0, Mm(170.0), Mm(226.0), &font_regular);

    // ----- Line item table header -----
    let table_top = 200.0;
    let row_height = 7.0;

    // Header background bar (drawn as a thick line)
    layer.set_fill_color(Color::Rgb(Rgb::new(0.95, 0.95, 0.95, None)));
    let header_rect = Line {
        points: vec![
            (Point::new(Mm(20.0), Mm(table_top + 2.0)), false),
            (Point::new(Mm(195.9), Mm(table_top + 2.0)), false),
            (Point::new(Mm(195.9), Mm(table_top - 5.0)), false),
            (Point::new(Mm(20.0), Mm(table_top - 5.0)), false),
        ],
        is_closed: true,
    };
    layer.add_polygon(Polygon {
        rings: vec![header_rect.points.iter().map(|(p, _)| (*p, false)).collect()],
        mode: path::PaintMode::Fill,
        winding_order: path::WindingOrder::NonZero,
    });
    layer.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));

    layer.use_text("DESCRIPTION", 9.0, Mm(22.0), Mm(table_top - 2.0), &font_bold);
    layer.use_text("QTY", 9.0, Mm(125.0), Mm(table_top - 2.0), &font_bold);
    layer.use_text("RATE", 9.0, Mm(150.0), Mm(table_top - 2.0), &font_bold);
    layer.use_text("AMOUNT", 9.0, Mm(178.0), Mm(table_top - 2.0), &font_bold);

    // ----- Line item rows -----
    let mut row_y = table_top - 12.0;
    for item in &items {
        // Truncate long descriptions
        let desc = if item.description.len() > 60 {
            format!("{}...", &item.description[..57])
        } else {
            item.description.clone()
        };
        layer.use_text(&desc, 10.0, Mm(22.0), Mm(row_y), &font_regular);
        layer.use_text(format!("{}", item.qty), 10.0, Mm(125.0), Mm(row_y), &font_regular);
        layer.use_text(
            format!("${:.2}", item.rate),
            10.0,
            Mm(150.0),
            Mm(row_y),
            &font_regular,
        );
        layer.use_text(
            format!("${:.2}", item.amount),
            10.0,
            Mm(178.0),
            Mm(row_y),
            &font_regular,
        );
        row_y -= row_height;
    }

    // Bottom divider
    let bottom_line = Line {
        points: vec![
            (Point::new(Mm(120.0), Mm(row_y)), false),
            (Point::new(Mm(195.9), Mm(row_y)), false),
        ],
        is_closed: false,
    };
    layer.add_line(bottom_line);

    // ----- Totals -----
    row_y -= 6.0;
    layer.use_text("Subtotal", 10.0, Mm(150.0), Mm(row_y), &font_regular);
    layer.use_text(format!("${:.2}", subtotal), 10.0, Mm(178.0), Mm(row_y), &font_regular);
    row_y -= 5.0;
    layer.use_text("Tax", 10.0, Mm(150.0), Mm(row_y), &font_regular);
    layer.use_text(format!("${:.2}", tax), 10.0, Mm(178.0), Mm(row_y), &font_regular);
    row_y -= 7.0;
    layer.use_text("TOTAL", 12.0, Mm(150.0), Mm(row_y), &font_bold);
    layer.use_text(format!("${:.2}", total), 12.0, Mm(178.0), Mm(row_y), &font_bold);

    // ----- Footer -----
    layer.use_text(
        "Thank you for your business. Please remit payment by the due date.",
        9.0,
        Mm(20.0),
        Mm(25.0),
        &font_regular,
    );
    if let Some(tax_id) = &company.tax_id {
        layer.use_text(format!("Tax ID: {}", tax_id), 8.0, Mm(20.0), Mm(20.0), &font_regular);
    }

    // ----- Save -----
    let dir = pdf_output_dir();
    std::fs::create_dir_all(&dir)?;
    let pdf_path = dir.join(format!("{}.pdf", number));
    let file = std::fs::File::create(&pdf_path)?;
    doc.save(&mut BufWriter::new(file))?;

    // Update invoice row with PDF path
    conn.execute(
        "UPDATE invoices SET pdf_path=?1 WHERE id=?2",
        rusqlite::params![pdf_path.to_string_lossy(), invoice_id],
    )?;

    Ok(pdf_path.to_string_lossy().to_string())
}

fn pdf_output_dir() -> std::path::PathBuf {
    crate::db::app_data_dir().join("invoices")
}

fn short_date(rfc3339: &str) -> String {
    rfc3339.split('T').next().unwrap_or(rfc3339).to_string()
}

struct ClientAddress {
    lines: Vec<String>,
}

fn parse_client_address(metadata: &Option<String>) -> Option<ClientAddress> {
    let meta: serde_json::Value =
        serde_json::from_str(metadata.as_deref()?).ok()?;
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

/// Compute totals from line items. Tax is a percentage (e.g. 0.0875 for 8.75%).
pub fn compute_totals(items: &[LineItem], tax_rate: f64) -> (f64, f64, f64) {
    let subtotal: f64 = items.iter().map(|i| i.amount).sum();
    let tax = (subtotal * tax_rate * 100.0).round() / 100.0;
    let total = subtotal + tax;
    (subtotal, tax, total)
}

/// Helper to send invoice via email with auto-generated message body.
pub async fn send_invoice(invoice_id: &str) -> Result<()> {
    let conn = pool().get()?;
    let (number, client_id, total, pdf_path): (String, String, f64, Option<String>) = conn
        .query_row(
            "SELECT number,client_id,total,pdf_path FROM invoices WHERE id=?1",
            [invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;

    let pdf = match pdf_path {
        Some(p) if std::path::Path::new(&p).exists() => p,
        _ => generate_pdf(invoice_id).await?,
    };

    let (cname, cemail): (String, Option<String>) = conn.query_row(
        "SELECT name,email FROM clients WHERE id=?1",
        [&client_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let to = cemail.context("client has no email")?;
    let subject = format!("Invoice {}", number);
    let body = format!(
        "Hi {},\n\nPlease find attached invoice {} for ${:.2}.\n\n\
         Payment instructions are detailed in the document.\n\nThank you!",
        cname.split_whitespace().next().unwrap_or(&cname),
        number,
        total
    );

    crate::email::send(&to, &subject, &body, Some(&pdf)).await?;

    conn.execute(
        "UPDATE invoices SET status='sent', sent_at=?1 WHERE id=?2",
        rusqlite::params![Utc::now().to_rfc3339(), invoice_id],
    )?;
    Ok(())
}
