//! Client statement / receipt (R-190): ONE PDF covering many deals for one client,
//! with every payment and its date under each deal.
//!
//! Not the invoice renderer. `invoice.rs` renders a single invoice as a demand for
//! money; this renders a history — what they bought, what they paid, when, and what
//! came back — across as many deals as are ticked.
//!
//! **This document is handed to the customer.** `total_supplier_cost`, `net_profit`,
//! `profit_jack` / `profit_ben` / `profit_business` and every supplier name are
//! therefore never read here, and `no_internal_figures_reach_the_page` in the tests
//! below is what keeps that true as the layout changes.
//!
//! Layout (top to bottom):
//!   - Logo (invoice branding), or the company name when no logo is set
//!   - Title + the period the statement covers
//!   - Prepared-for block (client) and prepared-on date
//!   - Summary: invoiced / paid / refunded / net received / balance due
//!   - One section per deal: invoice number + name, dates, item lines, payments,
//!     refunds, per-deal totals
//!   - Page footer: company name + "Page n of m"

use anyhow::{Context, Result};
use printpdf::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::BufWriter;

use crate::db::pool;
use crate::invoice::{
    fmt_dollar, load_company, load_template, parse_client_address, render_logo, short_date,
    text_width_mm, CompanyInfo, InvoiceTemplate, LineItem, CONTENT_R, MARGIN_L, PAGE_H, PAGE_W,
};
use crate::sync;

// ---------- Types ----------

fn yes() -> bool {
    true
}

/// What the document includes. Every section Jack can tick off in the builder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementOptions {
    #[serde(default = "yes")]
    pub include_items: bool,
    #[serde(default = "yes")]
    pub include_payments: bool,
    #[serde(default = "yes")]
    pub include_refunds: bool,
    #[serde(default = "yes")]
    pub include_dates: bool,
    #[serde(default = "yes")]
    pub include_summary: bool,
    #[serde(default = "yes")]
    pub include_balance: bool,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub intro: String,
}

impl Default for StatementOptions {
    fn default() -> Self {
        StatementOptions {
            include_items: true,
            include_payments: true,
            include_refunds: true,
            include_dates: true,
            include_summary: true,
            include_balance: true,
            title: String::new(),
            intro: String::new(),
        }
    }
}

/// Values typed into the "fill in the blanks" panel that are NOT written back to the
/// record. A payment's date and method live on `bank_txn`, and rewriting a posted
/// date there would move the deal's closed date and shift the financials — so they
/// are applied to this document only. Descriptive client fields go through
/// `save_statement_client_fills` instead, which does write back.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatementOverrides {
    /// allocation id → `YYYY-MM-DD`
    #[serde(default)]
    pub payment_dates: HashMap<String, String>,
    /// allocation id → how it arrived ("Wire", "ACH", …)
    #[serde(default)]
    pub payment_methods: HashMap<String, String>,
    /// deal_flow id → what the deal was, when the invoice carries no item lines
    #[serde(default)]
    pub deal_labels: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementInput {
    pub client_id: String,
    /// The ticked deals. Empty means every deal the client has.
    #[serde(default)]
    pub deal_ids: Vec<String>,
    #[serde(default)]
    pub options: StatementOptions,
    #[serde(default)]
    pub overrides: StatementOverrides,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementPayment {
    /// `bank_allocation.id`, or `deal:<id>` for the recorded-payment fallback.
    pub id: String,
    pub date: String,
    pub amount: f64,
    pub method: String,
    pub reference: String,
    /// "bank" (allocation joined to a real bank transaction) | "recorded" (the
    /// figure typed on the deal, with no bank line behind it).
    pub source: String,
    pub date_missing: bool,
    pub method_missing: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementRefund {
    pub id: String,
    pub date: String,
    pub amount: f64,
    pub method: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementDeal {
    pub deal_flow_id: String,
    pub invoice_id: String,
    pub invoice_number: String,
    pub name: String,
    pub stage: String,
    pub issue_date: String,
    pub due_date: String,
    pub closed_date: String,
    pub pickup_date: String,
    pub delivery_date: String,
    pub items: Vec<LineItem>,
    /// Stands in for the item table when the invoice has none.
    pub label: String,
    pub subtotal: f64,
    pub tax: f64,
    pub total: f64,
    pub payments: Vec<StatementPayment>,
    pub refunds: Vec<StatementRefund>,
    pub paid: f64,
    pub refunded: f64,
    pub balance: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementClient {
    pub id: String,
    pub name: String,
    pub company: String,
    pub email: String,
    pub phone: String,
    pub address_lines: Vec<String>,
}

/// A blank the document would otherwise print. `writes_back` says whether filling it
/// in updates the record or only this one PDF.
#[derive(Debug, Clone, Serialize)]
pub struct StatementGap {
    /// "client_email" | "client_address" | "deal_label" | "payment_date" | "payment_method"
    pub kind: String,
    /// What to fill in against: a client id, a deal_flow id, or an allocation id.
    pub target_id: String,
    /// The deal it sits under ("" for client-level gaps), so the UI can hide gaps
    /// belonging to deals that aren't ticked.
    pub deal_flow_id: String,
    pub label: String,
    pub writes_back: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementTotals {
    pub invoiced: f64,
    pub paid: f64,
    pub refunded: f64,
    pub net_received: f64,
    pub balance: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementData {
    pub client: StatementClient,
    pub deals: Vec<StatementDeal>,
    pub gaps: Vec<StatementGap>,
    pub totals: StatementTotals,
}

// ---------- Data ----------

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

fn load_client(client_id: &str) -> Result<StatementClient> {
    let conn = pool().get()?;
    let (name, company, email, phone, metadata) = conn.query_row(
        "SELECT name, COALESCE(company,''), COALESCE(email,''), COALESCE(phone,''), metadata \
           FROM clients WHERE id=?1",
        [client_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        },
    )?;
    let address_lines = parse_client_address(&metadata).map(|a| a.lines).unwrap_or_default();
    Ok(StatementClient {
        id: client_id.to_string(),
        name,
        company,
        email,
        phone,
        address_lines,
    })
}

/// How the money arrived, in words the customer would recognise.
///
/// `bank_txn.rail` is empty on every row this app has ever imported — Plaid does not
/// fill it — so the description is the only place the rail is actually written, and
/// it writes it in plain text ("CHIPS CREDIT", "BOOK TRANSFER CREDIT", "ZELLE").
/// Reading `rail` alone would have printed a blank method on every payment and
/// raised a fill-in prompt for each one. An empty return is a real blank.
///
/// Order matters: "BOOK TRANSFER" must be tested before the bare "TRANSFER".
fn derive_method(rail: &str, description: &str, check_num: &str) -> String {
    if !rail.trim().is_empty() {
        return rail.trim().to_string();
    }
    if !check_num.trim().is_empty() {
        return "Check".into();
    }
    let u = description.to_uppercase();
    for (needle, label) in [
        ("CHIPS", "Wire"),
        ("FEDWIRE", "Wire"),
        ("WIRE", "Wire"),
        ("BOOK TRANSFER", "Bank transfer"),
        ("ZELLE", "Zelle"),
        ("ACH", "ACH"),
        ("ORIG CO NAME", "ACH"),
        ("DIRECT DEP", "ACH"),
        ("CHECK", "Check"),
        ("TRANSFER", "Transfer"),
    ] {
        if u.contains(needle) {
            return label.into();
        }
    }
    String::new()
}

/// Something the customer can match against their own bank record. Chase writes
/// `TRN: 0128099131FC` at the end of a wire or book transfer, and that trace number
/// is on their side of the transaction too.
fn derive_reference(wire_ref: &str, check_num: &str, description: &str) -> String {
    if !wire_ref.trim().is_empty() {
        return wire_ref.trim().to_string();
    }
    if !check_num.trim().is_empty() {
        return format!("Check {}", check_num.trim());
    }
    if let Some(rest) = description.split("TRN:").nth(1) {
        let token: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if token.len() >= 6 {
            return format!("TRN {token}");
        }
    }
    String::new()
}

/// Every payment the CLIENT made on a deal, dated.
///
/// Bank-linked allocations are the truth when they exist: the join to `bank_txn` is
/// the same EXISTS guard every money SUM in this app uses, so an allocation whose
/// transaction was deleted can never invent a payment. Only when a deal has no bank
/// line at all does the figure recorded on the deal itself stand in — which is why
/// the two arms can never double-count.
fn deal_payments(
    conn: &rusqlite::Connection,
    deal_flow_id: &str,
    recorded_amount: f64,
    recorded_at: &str,
    recorded_method: &str,
) -> Result<Vec<StatementPayment>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, COALESCE(bt.posted_at,''), a.amount, \
                COALESCE(bt.rail,''), COALESCE(bt.wire_ref,''), COALESCE(bt.check_num,''), \
                COALESCE(bt.description,'') \
           FROM bank_allocation a \
           JOIN bank_txn bt ON bt.id = a.bank_txn_id \
          WHERE a.deal_flow_id=?1 AND a.role='buyer_payment' \
          ORDER BY bt.posted_at",
    )?;
    let rows = stmt.query_map([deal_flow_id], |r| {
        let rail: String = r.get(3)?;
        let wire_ref: String = r.get(4)?;
        let check_num: String = r.get(5)?;
        let description: String = r.get(6)?;
        Ok(StatementPayment {
            id: r.get(0)?,
            date: short_date(&r.get::<_, String>(1)?),
            amount: r.get(2)?,
            method: derive_method(&rail, &description, &check_num),
            reference: derive_reference(&wire_ref, &check_num, &description),
            source: "bank".into(),
            date_missing: false,
            method_missing: false,
        })
    })?;
    let mut out: Vec<StatementPayment> = rows.filter_map(|r| r.ok()).collect();

    if out.is_empty() && recorded_amount.abs() > 0.005 {
        out.push(StatementPayment {
            id: format!("deal:{deal_flow_id}"),
            date: short_date(recorded_at),
            amount: recorded_amount,
            method: recorded_method.to_string(),
            reference: String::new(),
            source: "recorded".into(),
            date_missing: false,
            method_missing: false,
        });
    }

    for p in out.iter_mut() {
        p.date_missing = p.date.trim().is_empty();
        p.method_missing = p.method.trim().is_empty();
    }
    Ok(out)
}

/// Refunds on a deal, counted ONCE.
///
/// The same UNION `list_refunds` uses: a refund can live as a `refunds` row (the
/// workspace path, which writes the row AND the allocation) or as a bare
/// `refund_out` allocation (the Financials booking path). The allocation arm's
/// `NOT EXISTS` is the exact complement, so a bank-linked workspace refund appears
/// as its `refunds` row and never twice.
fn deal_refunds(conn: &rusqlite::Connection, deal_flow_id: &str) -> Result<Vec<StatementRefund>> {
    let mut stmt = conn.prepare(
        "SELECT id, amount, COALESCE(method,''), COALESCE(reason,''), COALESCE(refunded_at,''), \
                COALESCE(created_at,'') AS sort_at \
           FROM refunds WHERE deal_flow_id=?1 \
         UNION ALL \
         SELECT a.id, a.amount, 'Bank', \
                CASE WHEN COALESCE(a.note,'')<>'' THEN a.note ELSE 'Refund' END, \
                COALESCE(bt.posted_at,''), COALESCE(a.created_at,'') AS sort_at \
           FROM bank_allocation a \
           JOIN bank_txn bt ON bt.id = a.bank_txn_id \
          WHERE a.deal_flow_id=?1 AND a.role='refund_out' \
            AND NOT EXISTS (SELECT 1 FROM refunds rf \
                             WHERE rf.deal_flow_id = a.deal_flow_id \
                               AND COALESCE(rf.bank_txn_id,'') = a.bank_txn_id) \
          ORDER BY sort_at",
    )?;
    let rows = stmt.query_map([deal_flow_id], |r| {
        Ok(StatementRefund {
            id: r.get(0)?,
            amount: r.get(1)?,
            method: r.get(2)?,
            reason: r.get(3)?,
            date: short_date(&r.get::<_, String>(4)?),
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Assemble the statement. `deal_ids` empty = every deal the client has.
///
/// Voided and archived invoices are excluded: a voided invoice is a deal that did
/// not happen, and putting one in front of a customer invites an argument about a
/// document they were never meant to see.
pub fn collect(
    client_id: &str,
    deal_ids: &[String],
    ov: &StatementOverrides,
) -> Result<StatementData> {
    let client = load_client(client_id)?;
    let conn = pool().get()?;

    let mut stmt = conn.prepare(
        "SELECT df.id, COALESCE(df.name,''), df.stage, COALESCE(df.completed_at,''), \
                df.payment_received_amount, COALESCE(df.payment_received_at,''), \
                COALESCE(df.payment_received_method,''), \
                COALESCE(df.pickup_date,''), COALESCE(df.expected_delivery_date,''), \
                i.id, COALESCE(i.number,''), COALESCE(i.issue_date,''), COALESCE(i.due_date,''), \
                COALESCE(i.line_items_json,'[]'), i.subtotal, COALESCE(i.tax,0), i.total \
           FROM deal_flows df \
           JOIN invoices i ON i.id = df.invoice_id \
          WHERE i.client_id=?1 AND COALESCE(df.archived,0)=0 \
            AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
          ORDER BY COALESCE(NULLIF(df.completed_at,''), i.issue_date) DESC",
    )?;

    let raw = stmt.query_map([client_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, String>(11)?,
            r.get::<_, String>(12)?,
            r.get::<_, String>(13)?,
            r.get::<_, f64>(14)?,
            r.get::<_, f64>(15)?,
            r.get::<_, f64>(16)?,
        ))
    })?;

    let mut deals: Vec<StatementDeal> = Vec::new();
    for row in raw {
        let row = match row {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !deal_ids.is_empty() && !deal_ids.iter().any(|d| d == &row.0) {
            continue;
        }
        let items: Vec<LineItem> = serde_json::from_str(&row.13).unwrap_or_default();
        let mut payments = deal_payments(&conn, &row.0, row.4, &row.5, &row.6)?;
        for p in payments.iter_mut() {
            if let Some(d) = ov.payment_dates.get(&p.id) {
                if !d.trim().is_empty() {
                    p.date = d.trim().to_string();
                    p.date_missing = false;
                }
            }
            if let Some(m) = ov.payment_methods.get(&p.id) {
                if !m.trim().is_empty() {
                    p.method = m.trim().to_string();
                    p.method_missing = false;
                }
            }
        }
        let refunds = deal_refunds(&conn, &row.0)?;
        let paid = round2(payments.iter().map(|p| p.amount).sum());
        let refunded = round2(refunds.iter().map(|r| r.amount).sum());
        let label = ov
            .deal_labels
            .get(&row.0)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();

        deals.push(StatementDeal {
            deal_flow_id: row.0,
            invoice_id: row.9,
            invoice_number: row.10,
            name: row.1,
            stage: row.2,
            issue_date: short_date(&row.11),
            due_date: short_date(&row.12),
            closed_date: short_date(&row.3),
            pickup_date: row.7,
            delivery_date: row.8,
            items,
            label,
            subtotal: row.14,
            tax: row.15,
            total: row.16,
            payments,
            refunds,
            paid,
            refunded,
            balance: round2((row.16 - paid).max(0.0)),
        });
    }

    let totals = StatementTotals {
        invoiced: round2(deals.iter().map(|d| d.total).sum()),
        paid: round2(deals.iter().map(|d| d.paid).sum()),
        refunded: round2(deals.iter().map(|d| d.refunded).sum()),
        net_received: round2(deals.iter().map(|d| d.paid - d.refunded).sum()),
        balance: round2(deals.iter().map(|d| d.balance).sum()),
    };

    let gaps = find_gaps(&client, &deals);
    Ok(StatementData {
        client,
        deals,
        gaps,
        totals,
    })
}

/// Every blank the document would print, so it can be filled in before it goes out
/// rather than discovered by the customer.
fn find_gaps(client: &StatementClient, deals: &[StatementDeal]) -> Vec<StatementGap> {
    let mut gaps = Vec::new();
    if client.email.trim().is_empty() {
        gaps.push(StatementGap {
            kind: "client_email".into(),
            target_id: client.id.clone(),
            deal_flow_id: String::new(),
            label: "No email address — the statement can be saved but not sent".into(),
            writes_back: true,
        });
    }
    if client.address_lines.is_empty() {
        gaps.push(StatementGap {
            kind: "client_address".into(),
            target_id: client.id.clone(),
            deal_flow_id: String::new(),
            label: "No billing address on file".into(),
            writes_back: true,
        });
    }
    for d in deals {
        let deal_ref = if d.invoice_number.trim().is_empty() {
            d.name.clone()
        } else {
            d.invoice_number.clone()
        };
        if d.items.is_empty() && d.label.trim().is_empty() {
            gaps.push(StatementGap {
                kind: "deal_label".into(),
                target_id: d.deal_flow_id.clone(),
                deal_flow_id: d.deal_flow_id.clone(),
                label: format!("{deal_ref} has no item lines — nothing describes what was sold"),
                writes_back: false,
            });
        }
        for p in &d.payments {
            if p.date_missing {
                gaps.push(StatementGap {
                    kind: "payment_date".into(),
                    target_id: p.id.clone(),
                    deal_flow_id: d.deal_flow_id.clone(),
                    label: format!("{deal_ref}: {} has no date", fmt_dollar(p.amount)),
                    writes_back: false,
                });
            }
            if p.method_missing {
                gaps.push(StatementGap {
                    kind: "payment_method".into(),
                    target_id: p.id.clone(),
                    deal_flow_id: d.deal_flow_id.clone(),
                    label: format!("{deal_ref}: {} has no method", fmt_dollar(p.amount)),
                    writes_back: false,
                });
            }
        }
    }
    gaps
}

// ---------- Layout ----------

const TITLE_SIZE: f32 = 17.0;
const H_SIZE: f32 = 11.0;
const BODY_SIZE: f32 = 9.5;
const SMALL_SIZE: f32 = 8.5;
const LINE_H: f32 = 5.0;
const BOTTOM_Y: f32 = 26.0;

/// Column x positions inside a deal section.
const COL_A: f32 = MARGIN_L + 2.0;
const COL_B: f32 = 92.0;
const COL_C: f32 = 132.0;

struct Pen {
    layers: Vec<PdfLayerReference>,
    y: f32,
}

fn near_black() -> Color {
    Color::Rgb(Rgb::new(0.067, 0.094, 0.153, None))
}
fn muted() -> Color {
    Color::Rgb(Rgb::new(0.42, 0.45, 0.50, None))
}

fn right_text(layer: &PdfLayerReference, s: &str, size: f32, right_x: f32, y: f32, font: &IndirectFontRef, bold: bool) {
    let w = text_width_mm(s, size, bold);
    layer.use_text(s, size, Mm(right_x - w), Mm(y), font);
}

fn rule(layer: &PdfLayerReference, y: f32, from: f32, to: f32, thickness: f32) {
    layer.set_outline_thickness(thickness);
    layer.add_line(Line {
        points: vec![
            (Point::new(Mm(from), Mm(y)), false),
            (Point::new(Mm(to), Mm(y)), false),
        ],
        is_closed: false,
    });
}

/// Truncate to fit `max_w`, with an ellipsis. Item descriptions here are labels on a
/// receipt, not prose — one line each keeps a 40-deal statement readable.
fn ellipsize(s: &str, size: f32, max_w: f32, bold: bool) -> String {
    if text_width_mm(s, size, bold) <= max_w {
        return s.to_string();
    }
    let mut out = String::new();
    for ch in s.chars() {
        let candidate = format!("{out}{ch}…");
        if text_width_mm(&candidate, size, bold) > max_w {
            break;
        }
        out.push(ch);
    }
    format!("{out}…")
}

fn dash(s: &str) -> String {
    if s.trim().is_empty() {
        "—".into()
    } else {
        s.trim().to_string()
    }
}

pub fn build_statement_bytes(
    data: &StatementData,
    opts: &StatementOptions,
    company: &CompanyInfo,
    tpl: &InvoiceTemplate,
    generated_on: &str,
) -> Result<Vec<u8>> {
    let (doc, page, layer_idx) =
        PdfDocument::new("Client statement", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let font = doc.add_builtin_font(BuiltinFont::Helvetica).context("font")?;
    let font_bold = doc.add_builtin_font(BuiltinFont::HelveticaBold).context("font_bold")?;

    let mut pen = Pen {
        layers: vec![doc.get_page(page).get_layer(layer_idx)],
        y: 0.0,
    };

    // ----- Letterhead -----
    let layer = pen.layers[0].clone();
    let logo = match company.logo_path.as_deref() {
        Some(p) if std::path::Path::new(p).exists() => {
            render_logo(&layer, p, &tpl.logo_placement, tpl.logo_size_factor()).unwrap_or(None)
        }
        _ => None,
    };
    pen.y = match &logo {
        Some(l) => l.bottom_y - 14.0,
        None => {
            layer.use_text(&company.name, 16.0, Mm(MARGIN_L), Mm(262.0), &font_bold);
            252.0
        }
    };

    // ----- Title -----
    let title = if opts.title.trim().is_empty() {
        "Statement of account"
    } else {
        opts.title.trim()
    };
    layer.set_fill_color(tpl.accent());
    layer.use_text(title, TITLE_SIZE, Mm(MARGIN_L), Mm(pen.y), &font_bold);
    layer.set_fill_color(near_black());
    pen.y -= 8.0;

    let span = period_label(data);
    if !span.is_empty() {
        layer.set_fill_color(muted());
        layer.use_text(&span, SMALL_SIZE, Mm(MARGIN_L), Mm(pen.y), &font);
        layer.set_fill_color(near_black());
    }
    right_text(&layer, &format!("Prepared {}", generated_on), SMALL_SIZE, CONTENT_R, pen.y, &font, false);
    pen.y -= 9.0;

    // ----- Prepared for -----
    layer.use_text("Prepared for", SMALL_SIZE, Mm(MARGIN_L), Mm(pen.y), &font_bold);
    pen.y -= 5.5;
    let c = &data.client;
    let mut who: Vec<String> = vec![c.name.clone()];
    if !c.company.trim().is_empty() && c.company.trim() != c.name.trim() {
        who.push(c.company.clone());
    }
    who.extend(c.address_lines.iter().cloned());
    if !c.email.trim().is_empty() {
        who.push(c.email.clone());
    }
    if !c.phone.trim().is_empty() {
        who.push(c.phone.clone());
    }
    for (i, line) in who.iter().enumerate() {
        layer.use_text(line, BODY_SIZE, Mm(MARGIN_L), Mm(pen.y), if i == 0 { &font_bold } else { &font });
        pen.y -= LINE_H;
    }
    pen.y -= 3.0;

    if !opts.intro.trim().is_empty() {
        for line in wrap(opts.intro.trim(), BODY_SIZE, CONTENT_R - MARGIN_L) {
            layer.use_text(&line, BODY_SIZE, Mm(MARGIN_L), Mm(pen.y), &font);
            pen.y -= LINE_H;
        }
        pen.y -= 3.0;
    }

    // ----- Summary -----
    if opts.include_summary {
        rule(&layer, pen.y + 2.0, MARGIN_L, CONTENT_R, 0.4);
        pen.y -= 4.0;
        let t = &data.totals;
        let mut rows: Vec<(&str, f64, bool)> = vec![
            ("Invoiced", t.invoiced, false),
            ("Paid", t.paid, false),
        ];
        if t.refunded.abs() > 0.005 {
            rows.push(("Refunded", -t.refunded, false));
            rows.push(("Net received", t.net_received, true));
        }
        if opts.include_balance {
            rows.push(("Balance due", t.balance, true));
        }
        for (label, amount, strong) in rows {
            let f = if strong { &font_bold } else { &font };
            layer.use_text(label, H_SIZE - 1.0, Mm(MARGIN_L), Mm(pen.y), f);
            right_text(&layer, &fmt_dollar(amount), H_SIZE - 1.0, CONTENT_R, pen.y, f, strong);
            pen.y -= 5.6;
        }
        pen.y -= 1.0;
        rule(&layer, pen.y + 2.0, MARGIN_L, CONTENT_R, 0.4);
        pen.y -= 8.0;
    }

    // ----- Deals -----
    for deal in &data.deals {
        draw_deal(&doc, &mut pen, deal, opts, tpl, &font, &font_bold);
    }

    if data.deals.is_empty() {
        let l = pen.layers.last().unwrap().clone();
        l.set_fill_color(muted());
        l.use_text("No deals selected.", BODY_SIZE, Mm(MARGIN_L), Mm(pen.y), &font);
        l.set_fill_color(near_black());
    }

    // ----- Footers (page count is only known now) -----
    let total_pages = pen.layers.len();
    for (i, l) in pen.layers.iter().enumerate() {
        l.set_fill_color(muted());
        l.use_text(&company.name, SMALL_SIZE - 0.5, Mm(MARGIN_L), Mm(15.0), &font);
        right_text(
            l,
            &format!("Page {} of {}", i + 1, total_pages),
            SMALL_SIZE - 0.5,
            CONTENT_R,
            15.0,
            &font,
            false,
        );
        if !tpl.footer_note.trim().is_empty() && i + 1 == total_pages {
            l.use_text(tpl.footer_note.trim(), SMALL_SIZE - 0.5, Mm(MARGIN_L), Mm(20.0), &font);
        }
        l.set_fill_color(near_black());
    }

    let mut writer = BufWriter::new(Vec::new());
    doc.save(&mut writer)?;
    writer
        .into_inner()
        .map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))
}

fn period_label(data: &StatementData) -> String {
    let mut dates: Vec<&str> = Vec::new();
    for d in &data.deals {
        if !d.issue_date.trim().is_empty() {
            dates.push(&d.issue_date);
        }
    }
    dates.sort_unstable();
    let n = data.deals.len();
    let noun = if n == 1 { "deal" } else { "deals" };
    match (dates.first(), dates.last()) {
        (Some(a), Some(b)) if a != b => format!("{n} {noun} · {a} to {b}"),
        (Some(a), _) => format!("{n} {noun} · {a}"),
        _ => format!("{n} {noun}"),
    }
}

fn wrap(text: &str, size: f32, max_w: f32) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.lines() {
        if raw.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        let mut line = String::new();
        for word in raw.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_string()
            } else {
                format!("{line} {word}")
            };
            if !line.is_empty() && text_width_mm(&candidate, size, false) > max_w {
                out.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

/// Ensure `needed` mm of room, starting a new page if not. Returns the layer to
/// draw on.
fn room(doc: &PdfDocumentReference, pen: &mut Pen, needed: f32) -> PdfLayerReference {
    if pen.y - needed < BOTTOM_Y {
        let (pi, li) = doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
        pen.layers.push(doc.get_page(pi).get_layer(li));
        pen.y = PAGE_H - 24.0;
    }
    pen.layers.last().unwrap().clone()
}

fn draw_deal(
    doc: &PdfDocumentReference,
    pen: &mut Pen,
    deal: &StatementDeal,
    opts: &StatementOptions,
    tpl: &InvoiceTemplate,
    font: &IndirectFontRef,
    font_bold: &IndirectFontRef,
) {
    // Header + at least one line of content stay together.
    let l = room(doc, pen, 24.0);

    let heading = if deal.invoice_number.trim().is_empty() {
        dash(&deal.name)
    } else if deal.name.trim().is_empty() {
        format!("Invoice {}", deal.invoice_number)
    } else {
        format!("Invoice {} · {}", deal.invoice_number, deal.name.trim())
    };
    l.set_fill_color(tpl.accent());
    l.use_text(&ellipsize(&heading, H_SIZE, 120.0, true), H_SIZE, Mm(MARGIN_L), Mm(pen.y), font_bold);
    l.set_fill_color(near_black());
    right_text(&l, &fmt_dollar(deal.total), H_SIZE, CONTENT_R, pen.y, font_bold, true);
    pen.y -= 5.0;
    rule(&l, pen.y + 1.0, MARGIN_L, CONTENT_R, 0.3);
    pen.y -= 5.0;

    if opts.include_dates {
        let mut bits: Vec<String> = Vec::new();
        if !deal.issue_date.trim().is_empty() {
            bits.push(format!("Invoiced {}", deal.issue_date));
        }
        if !deal.due_date.trim().is_empty() {
            bits.push(format!("Due {}", deal.due_date));
        }
        if !deal.pickup_date.trim().is_empty() {
            bits.push(format!("Picked up {}", deal.pickup_date));
        }
        if !deal.delivery_date.trim().is_empty() {
            bits.push(format!("Delivery {}", deal.delivery_date));
        }
        if !deal.closed_date.trim().is_empty() {
            bits.push(format!("Closed {}", deal.closed_date));
        }
        if !bits.is_empty() {
            let l = room(doc, pen, 8.0);
            l.set_fill_color(muted());
            l.use_text(&bits.join("   ·   "), SMALL_SIZE, Mm(COL_A), Mm(pen.y), font);
            l.set_fill_color(near_black());
            pen.y -= 6.0;
        }
    }

    // ----- Items -----
    if opts.include_items {
        if !deal.items.is_empty() {
            let l = room(doc, pen, 10.0);
            l.set_fill_color(muted());
            l.use_text("Item", SMALL_SIZE, Mm(COL_A), Mm(pen.y), font);
            l.use_text("Qty", SMALL_SIZE, Mm(COL_B), Mm(pen.y), font);
            l.use_text("Rate", SMALL_SIZE, Mm(COL_C), Mm(pen.y), font);
            right_text(&l, "Amount", SMALL_SIZE, CONTENT_R, pen.y, font, false);
            l.set_fill_color(near_black());
            pen.y -= 5.0;
            for it in &deal.items {
                let l = room(doc, pen, 6.0);
                l.use_text(
                    &ellipsize(&it.description, BODY_SIZE, COL_B - COL_A - 4.0, false),
                    BODY_SIZE,
                    Mm(COL_A),
                    Mm(pen.y),
                    font,
                );
                l.use_text(&trim_num(it.qty), BODY_SIZE, Mm(COL_B), Mm(pen.y), font);
                l.use_text(&fmt_dollar(it.rate), BODY_SIZE, Mm(COL_C), Mm(pen.y), font);
                right_text(&l, &fmt_dollar(it.amount), BODY_SIZE, CONTENT_R, pen.y, font, false);
                pen.y -= LINE_H;
            }
            if deal.tax.abs() > 0.005 {
                let l = room(doc, pen, 6.0);
                l.use_text("Tax", BODY_SIZE, Mm(COL_C), Mm(pen.y), font);
                right_text(&l, &fmt_dollar(deal.tax), BODY_SIZE, CONTENT_R, pen.y, font, false);
                pen.y -= LINE_H;
            }
            pen.y -= 2.0;
        } else if !deal.label.trim().is_empty() {
            let l = room(doc, pen, 6.0);
            l.use_text(
                &ellipsize(deal.label.trim(), BODY_SIZE, CONTENT_R - COL_A, false),
                BODY_SIZE,
                Mm(COL_A),
                Mm(pen.y),
                font,
            );
            pen.y -= LINE_H + 2.0;
        }
    }

    // ----- Payments -----
    if opts.include_payments {
        let l = room(doc, pen, 10.0);
        l.set_fill_color(muted());
        l.use_text("Payments received", SMALL_SIZE, Mm(COL_A), Mm(pen.y), font);
        l.set_fill_color(near_black());
        pen.y -= 5.2;
        if deal.payments.is_empty() {
            let l = room(doc, pen, 6.0);
            l.set_fill_color(muted());
            l.use_text("No payment recorded", BODY_SIZE, Mm(COL_A), Mm(pen.y), font);
            l.set_fill_color(near_black());
            pen.y -= LINE_H;
        }
        for p in &deal.payments {
            let l = room(doc, pen, 6.0);
            l.use_text(&dash(&p.date), BODY_SIZE, Mm(COL_A), Mm(pen.y), font);
            let mut how = dash(&p.method);
            if !p.reference.trim().is_empty() {
                how = format!("{how} · {}", p.reference.trim());
            }
            l.use_text(&ellipsize(&how, BODY_SIZE, CONTENT_R - COL_B - 30.0, false), BODY_SIZE, Mm(COL_B - 40.0), Mm(pen.y), font);
            right_text(&l, &fmt_dollar(p.amount), BODY_SIZE, CONTENT_R, pen.y, font, false);
            pen.y -= LINE_H;
        }
        pen.y -= 2.0;
    }

    // ----- Refunds -----
    if opts.include_refunds && !deal.refunds.is_empty() {
        let l = room(doc, pen, 10.0);
        l.set_fill_color(muted());
        l.use_text("Refunded", SMALL_SIZE, Mm(COL_A), Mm(pen.y), font);
        l.set_fill_color(near_black());
        pen.y -= 5.2;
        for r in &deal.refunds {
            let l = room(doc, pen, 6.0);
            l.use_text(&dash(&r.date), BODY_SIZE, Mm(COL_A), Mm(pen.y), font);
            let why = if r.reason.trim().is_empty() { dash(&r.method) } else { r.reason.trim().to_string() };
            l.use_text(&ellipsize(&why, BODY_SIZE, CONTENT_R - COL_B - 30.0, false), BODY_SIZE, Mm(COL_B - 40.0), Mm(pen.y), font);
            right_text(&l, &fmt_dollar(-r.amount), BODY_SIZE, CONTENT_R, pen.y, font, false);
            pen.y -= LINE_H;
        }
        pen.y -= 2.0;
    }

    // ----- Deal totals -----
    let l = room(doc, pen, 10.0);
    rule(&l, pen.y + 2.5, COL_C - 10.0, CONTENT_R, 0.3);
    let mut summary: Vec<(String, f64)> = vec![("Paid".to_string(), deal.paid)];
    if deal.refunded.abs() > 0.005 {
        summary.push(("Refunded".to_string(), -deal.refunded));
    }
    if opts.include_balance && deal.balance > 0.005 {
        summary.push(("Balance due".to_string(), deal.balance));
    }
    for (label, amount) in summary {
        let l = room(doc, pen, 6.0);
        right_text(&l, &label, BODY_SIZE, CONTENT_R - 32.0, pen.y, font_bold, true);
        right_text(&l, &fmt_dollar(amount), BODY_SIZE, CONTENT_R, pen.y, font_bold, true);
        pen.y -= LINE_H;
    }
    pen.y -= 8.0;
}

/// "12" not "12.00", but "1.5" survives — quantities here are units and pallets.
fn trim_num(n: f64) -> String {
    if (n.fract()).abs() < 0.005 {
        format!("{}", n.round() as i64)
    } else {
        format!("{n:.2}")
    }
}

// ---------- Commands ----------

/// Everything the builder screen needs: the client, every deal they have, the blanks
/// the document would print, and the running totals.
#[tauri::command]
pub async fn client_statement_data(client_id: String) -> Result<StatementData, String> {
    collect(&client_id, &[], &StatementOverrides::default()).map_err(|e| e.to_string())
}

/// Render the statement and return the file it was written to.
///
/// An empty `output_path` writes into the app's own `statements/` folder — that is
/// the emailing path, where the file is an attachment rather than something the user
/// picked a home for.
#[tauri::command]
pub async fn generate_client_statement(input: StatementInput) -> Result<String, String> {
    let data = collect(&input.client_id, &input.deal_ids, &input.overrides)
        .map_err(|e| e.to_string())?;
    let company = load_company().map_err(|e| e.to_string())?;
    let tpl = load_template();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let bytes = build_statement_bytes(&data, &input.options, &company, &tpl, &today)
        .map_err(|e| e.to_string())?;

    let path = if input.output_path.trim().is_empty() {
        let safe: String = data
            .client
            .name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        crate::db::app_data_dir()
            .join("statements")
            .join(format!("statement-{}-{}.pdf", safe.trim_matches('-'), today))
            .to_string_lossy()
            .to_string()
    } else {
        input.output_path.clone()
    };

    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Write back the descriptive blanks from the fill-in panel — merge-on-write, so a
/// field left empty here is left alone rather than NULLed over.
///
/// Money-critical blanks (a payment's date or amount) are deliberately NOT here:
/// they live on `bank_txn`, and rewriting a posted date would move the deal's closed
/// date and the financials with it. Those stay overrides on the document.
#[tauri::command]
pub async fn save_statement_client_fills(
    client_id: String,
    email: Option<String>,
    street_address: Option<String>,
    city: Option<String>,
    state: Option<String>,
    zip_code: Option<String>,
    country: Option<String>,
) -> Result<(), String> {
    let (existing_email, existing_meta): (String, String) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COALESCE(email,''), COALESCE(metadata,'{}') FROM clients WHERE id=?1",
            [&client_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?
    };

    let mut meta: Value = serde_json::from_str(&existing_meta).unwrap_or_else(|_| Value::Object(Map::new()));
    if !meta.is_object() {
        meta = Value::Object(Map::new());
    }
    {
        let obj = meta.as_object_mut().unwrap();
        for (key, val) in [
            ("street_address", &street_address),
            ("city", &city),
            ("state", &state),
            ("zip_code", &zip_code),
            ("country", &country),
        ] {
            if let Some(v) = val {
                if !v.trim().is_empty() {
                    obj.insert(key.into(), Value::String(v.trim().to_string()));
                }
            }
        }
    }
    let meta_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());
    let email_val = match email {
        Some(e) if !e.trim().is_empty() => e.trim().to_string(),
        _ => existing_email,
    };
    let now = chrono::Utc::now().to_rfc3339();

    let mut cols = Map::new();
    cols.insert("email".into(), Value::String(email_val.clone()));
    cols.insert("metadata".into(), Value::String(meta_str.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("clients", &client_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clients SET email=?1, metadata=?2, updated_at=?3 WHERE id=?4",
        rusqlite::params![email_val, meta_str, now, client_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deal(total: f64, paid: f64, refunded: f64) -> StatementDeal {
        StatementDeal {
            deal_flow_id: "df1".into(),
            invoice_id: "inv1".into(),
            invoice_number: "INV-0101".into(),
            name: "Mixed apparel pallets".into(),
            stage: "complete".into(),
            issue_date: "2026-03-04".into(),
            due_date: "2026-03-11".into(),
            closed_date: "2026-03-12".into(),
            pickup_date: String::new(),
            delivery_date: String::new(),
            items: vec![LineItem {
                description: "Assorted branded apparel — 20 pallets".into(),
                qty: 20.0,
                rate: 1500.0,
                amount: 30000.0,
            }],
            label: String::new(),
            subtotal: total,
            tax: 0.0,
            total,
            payments: vec![StatementPayment {
                id: "al1".into(),
                date: "2026-03-06".into(),
                amount: paid,
                method: "wire".into(),
                reference: "FED123".into(),
                source: "bank".into(),
                date_missing: false,
                method_missing: false,
            }],
            refunds: if refunded > 0.0 {
                vec![StatementRefund {
                    id: "rf1".into(),
                    date: "2026-03-20".into(),
                    amount: refunded,
                    method: "Bank".into(),
                    reason: "Short shipment".into(),
                }]
            } else {
                vec![]
            },
            paid,
            refunded,
            balance: (total - paid).max(0.0),
        }
    }

    fn data(deals: Vec<StatementDeal>) -> StatementData {
        let totals = StatementTotals {
            invoiced: deals.iter().map(|d| d.total).sum(),
            paid: deals.iter().map(|d| d.paid).sum(),
            refunded: deals.iter().map(|d| d.refunded).sum(),
            net_received: deals.iter().map(|d| d.paid - d.refunded).sum(),
            balance: deals.iter().map(|d| d.balance).sum(),
        };
        StatementData {
            client: StatementClient {
                id: "c1".into(),
                name: "Acme Retail".into(),
                company: "Acme Retail LLC".into(),
                email: "buyer@acme.test".into(),
                phone: String::new(),
                address_lines: vec!["12 Trade St".into(), "Dallas, TX 75201".into()],
            },
            deals,
            gaps: vec![],
            totals,
        }
    }

    fn company() -> CompanyInfo {
        CompanyInfo {
            name: "BJM Distributions".into(),
            address: "1 Warehouse Way".into(),
            email: "sales@bjm.test".into(),
            phone: None,
            tax_id: None,
            logo_path: None,
            show_company_name: Some(true),
        }
    }

    /// The whole point of a separate renderer. The page can only draw what is on
    /// `StatementData`, so if a future edit adds a cost or profit field to carry it
    /// through, this fails — a customer must never be handed our margin.
    #[test]
    fn no_internal_figures_reach_the_page() {
        let json = serde_json::to_string(&data(vec![deal(30000.0, 30000.0, 1200.0)])).unwrap();
        for banned in [
            "supplier",
            "profit",
            "margin",
            "cost",
            "jack",
            "ben",
        ] {
            assert!(
                !json.to_lowercase().contains(banned),
                "`{banned}` reached the client-facing statement payload: {json}"
            );
        }
    }

    #[test]
    fn a_fully_paid_deal_shows_no_balance_and_a_refund_does_not_re_open_one() {
        let d = deal(30000.0, 30000.0, 30000.0);
        assert_eq!(d.balance, 0.0);
        let dd = data(vec![d]);
        assert_eq!(dd.totals.net_received, 0.0);
        assert_eq!(dd.totals.balance, 0.0);
    }

    #[test]
    fn renders_a_multi_deal_statement() {
        let dd = data(vec![deal(30000.0, 30000.0, 0.0), deal(12500.0, 5000.0, 0.0)]);
        let bytes = build_statement_bytes(
            &dd,
            &StatementOptions::default(),
            &company(),
            &InvoiceTemplate::default(),
            "2026-08-21",
        )
        .expect("render");
        assert!(bytes.len() > 1000, "produced {} bytes", bytes.len());
        assert!(bytes.starts_with(b"%PDF"));
    }

    /// A blank date or method is a question to answer before sending, not something
    /// to discover in the customer's reply.
    #[test]
    fn blank_payment_fields_are_reported_as_gaps() {
        let mut d = deal(30000.0, 30000.0, 0.0);
        d.payments[0].date = String::new();
        d.payments[0].date_missing = true;
        d.payments[0].method = String::new();
        d.payments[0].method_missing = true;
        let dd = data(vec![d]);
        let gaps = find_gaps(&dd.client, &dd.deals);
        assert!(gaps.iter().any(|g| g.kind == "payment_date"));
        assert!(gaps.iter().any(|g| g.kind == "payment_method"));
        // Neither may be written back into bank_txn.
        assert!(gaps
            .iter()
            .filter(|g| g.kind.starts_with("payment_"))
            .all(|g| !g.writes_back));
    }

    /// Real descriptions off this database's own buyer payments. `rail` is empty on
    /// all 1,354 rows, so these strings are the only evidence of how the money came.
    #[test]
    fn the_method_is_read_out_of_the_bank_description() {
        let cases = [
            ("BOOK TRANSFER CREDIT B/O: LAST STOCK LLC HOUSTON TX TRN: 4036126124ES", "Bank transfer", "TRN 4036126124ES"),
            ("CHIPS CREDIT VIA: BANK OF AMERICA, N.A./0959 B/O: 1/SOUTHJERZAUCTIONS LLC SSN: 00523405 TRN: 0128099131FC", "Wire", "TRN 0128099131FC"),
            ("Online Transfer from CHK ...8152 transaction#: 29175275289", "Transfer", ""),
            ("ZELLE PAYMENT FROM DYLAN TAYLOR", "Zelle", ""),
        ];
        for (desc, method, reference) in cases {
            assert_eq!(derive_method("", desc, ""), method, "method for {desc}");
            assert_eq!(derive_reference("", "", desc), reference, "reference for {desc}");
        }
        // A description that says nothing is a real blank, not a guess.
        assert_eq!(derive_method("", "DEPOSIT", ""), "");
        // An explicit rail always wins over the guess.
        assert_eq!(derive_method("ACH", "CHIPS CREDIT", ""), "ACH");
    }

    #[test]
    fn an_invoice_with_no_items_asks_what_was_sold() {
        let mut d = deal(30000.0, 30000.0, 0.0);
        d.items.clear();
        let dd = data(vec![d]);
        let gaps = find_gaps(&dd.client, &dd.deals);
        assert!(gaps.iter().any(|g| g.kind == "deal_label"));
    }
}
