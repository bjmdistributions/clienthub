//! Desktop side of the Show packing add-on (R-271/R-272).
//!
//! `shows`/`show_items`/`show_buyers`/`show_sales` live on the SERVER only (never
//! synced — see `commands.rs`'s Leads section for the identical shape). Rather than
//! one Tauri command per `/api/shows*` route — a surface still moving across
//! R-271/R-272 — the frontend goes through ONE generic proxy, `show_packing_request`,
//! and gets the server's own error string back on a non-2xx response.
//!
//! PDF rendering for bin labels / run sheets / packing lists is a second, separate
//! command: not proxied, since it never leaves this device — it just writes bytes to
//! wherever the frontend's own save dialog pointed. Kept out of `lot_export_pdf.rs`
//! (that file is specifically the lot-export renderer); the printpdf usage pattern
//! is copied from there.

use printpdf::*;
use serde_json::Value;
use std::io::BufWriter;

use crate::commands::{inbox_http, leads_server};
use crate::invoice::text_width_mm;

/// Proxy one call to `/api/shows*` on the connected server. `path` must start with
/// `/api/shows` so this command can't be pointed at arbitrary server routes from
/// the frontend.
#[tauri::command]
pub async fn show_packing_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/api/shows") {
        return Err("show_packing_request only reaches /api/shows routes.".into());
    }
    let (base, token) = leads_server()?;
    let http = inbox_http()?;
    let url = format!("{base}{path}");
    let mut req = match method.to_ascii_uppercase().as_str() {
        "GET" => http.get(&url),
        "POST" => http.post(&url),
        other => return Err(format!("Unsupported method {other:?}")),
    };
    req = req.bearer_auth(&token);
    if let Some(b) = &body {
        req = req.json(b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v
            .get("error")
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Server returned {status}"));
        return Err(msg);
    }
    Ok(v)
}

/// Render one of the three show-packing print jobs straight to `path` — the
/// destination the frontend's own `@tauri-apps/plugin-dialog` save dialog picked.
#[tauri::command]
pub async fn show_packing_pdf(kind: String, path: String, payload: Value) -> Result<(), String> {
    let bytes = match kind.as_str() {
        "bin_labels" => bin_labels_pdf(&payload)?,
        "run_sheet" => run_sheet_pdf(&payload)?,
        "packing_list" => packing_list_pdf(&payload)?,
        other => return Err(format!("{other:?} is not one of bin_labels, run_sheet or packing_list")),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Truncate `text` with an ellipsis so it fits `max_w` mm — copied from
/// `lot_export_pdf::fit` (private there, and this module has no other reason to
/// depend on it) rather than shared for one ten-line helper.
fn fit(text: &str, size_pt: f32, bold: bool, max_w: f32) -> String {
    if text_width_mm(text, size_pt, bold) <= max_w {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars() {
        let candidate = format!("{out}{ch}…");
        if text_width_mm(&candidate, size_pt, bold) > max_w {
            break;
        }
        out.push(ch);
    }
    format!("{out}…")
}

fn finish(pdf: PdfDocumentReference) -> Result<Vec<u8>, String> {
    let mut writer = BufWriter::new(Vec::new());
    pdf.save(&mut writer).map_err(|e| e.to_string())?;
    writer.into_inner().map_err(|e| format!("BufWriter flush: {e}"))
}

/// One 4x6in page per bin number in `payload.from..=payload.to`, the number
/// centred as large as it can be while still fitting the label.
fn bin_labels_pdf(payload: &Value) -> Result<Vec<u8>, String> {
    const PAGE_W: f32 = 101.6; // 4in
    const PAGE_H: f32 = 152.4; // 6in
    const MAX_TEXT_W: f32 = PAGE_W - 16.0;

    let from = payload.get("from").and_then(|v| v.as_i64()).unwrap_or(1);
    let to = payload.get("to").and_then(|v| v.as_i64()).unwrap_or(from);
    if to < from {
        return Err("The label range's end must not be before its start.".into());
    }

    let (pdf, page1, layer1) = PdfDocument::new("Box labels", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let font_bold = pdf.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    let mut layer = pdf.get_page(page1).get_layer(layer1);

    for (n, bin) in (from..=to).enumerate() {
        if n > 0 {
            let (pi, li) = pdf.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
            layer = pdf.get_page(pi).get_layer(li);
        }
        let label = format!("Box {bin}");
        let mut size = 110.0;
        while size > 24.0 && text_width_mm(&label, size, true) > MAX_TEXT_W {
            size -= 2.0;
        }
        let w = text_width_mm(&label, size, true);
        let size_mm = size * 25.4 / 72.0;
        layer.use_text(&label, size, Mm((PAGE_W - w) / 2.0), Mm(PAGE_H / 2.0 - size_mm * 0.35), &font_bold);
    }
    finish(pdf)
}

/// US Letter table: item #, title, unit cost, start price, from `payload.items`.
fn run_sheet_pdf(payload: &Value) -> Result<Vec<u8>, String> {
    const PAGE_W: f32 = 215.9;
    const PAGE_H: f32 = 279.4;
    const MARGIN: f32 = 15.0;
    const TITLE_W: f32 = 105.0;

    let items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let (pdf, page1, layer1) = PdfDocument::new("Run sheet", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let font = pdf.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let font_bold = pdf.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    let mut layer = pdf.get_page(page1).get_layer(layer1);

    let cols = [MARGIN, MARGIN + 16.0, MARGIN + 16.0 + TITLE_W, MARGIN + 16.0 + TITLE_W + 30.0];
    let headers = ["#", "Title", "Unit cost", "Start price"];

    let mut y = PAGE_H - MARGIN;
    layer.use_text("Run sheet", 14.0, Mm(MARGIN), Mm(y), &font_bold);
    y -= 10.0;
    for (i, h) in headers.iter().enumerate() {
        layer.use_text(*h, 9.0, Mm(cols[i]), Mm(y), &font_bold);
    }
    y -= 5.0;

    for item in &items {
        if y < MARGIN + 8.0 {
            let (pi, li) = pdf.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
            layer = pdf.get_page(pi).get_layer(li);
            y = PAGE_H - MARGIN;
            for (i, h) in headers.iter().enumerate() {
                layer.use_text(*h, 9.0, Mm(cols[i]), Mm(y), &font_bold);
            }
            y -= 5.0;
        }
        let num = item.get("item_number").and_then(|v| v.as_i64()).unwrap_or(0);
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let cost = item.get("unit_cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let start = item.get("start_price").and_then(|v| v.as_f64());
        layer.use_text(format!("{num}"), 9.0, Mm(cols[0]), Mm(y), &font);
        layer.use_text(fit(title, 9.0, false, TITLE_W - 2.0), 9.0, Mm(cols[1]), Mm(y), &font);
        layer.use_text(format!("${cost:.2}"), 9.0, Mm(cols[2]), Mm(y), &font);
        layer.use_text(start.map(|s| format!("${s:.2}")).unwrap_or_default(), 9.0, Mm(cols[3]), Mm(y), &font);
        y -= 6.0;
    }
    finish(pdf)
}

/// One section per buyer ordered by bin: "Bin N — @username", then that buyer's
/// items (#, title, price), from `payload.buyers`.
fn packing_list_pdf(payload: &Value) -> Result<Vec<u8>, String> {
    const PAGE_W: f32 = 215.9;
    const PAGE_H: f32 = 279.4;
    const MARGIN: f32 = 15.0;

    let buyers = payload.get("buyers").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let (pdf, page1, layer1) = PdfDocument::new("Packing list", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let font = pdf.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let font_bold = pdf.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    let mut layer = pdf.get_page(page1).get_layer(layer1);

    let mut y = PAGE_H - MARGIN;
    layer.use_text("Packing list", 14.0, Mm(MARGIN), Mm(y), &font_bold);
    y -= 10.0;

    for buyer in &buyers {
        let bin = buyer.get("bin_number").and_then(|v| v.as_i64()).unwrap_or(0);
        let username = buyer.get("username").and_then(|v| v.as_str()).unwrap_or("");
        let items = buyer.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        if y - 8.0 < MARGIN {
            let (pi, li) = pdf.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
            layer = pdf.get_page(pi).get_layer(li);
            y = PAGE_H - MARGIN;
        }
        layer.use_text(format!("Box {bin} · @{username}"), 11.0, Mm(MARGIN), Mm(y), &font_bold);
        y -= 6.0;

        for item in &items {
            if y < MARGIN + 6.0 {
                let (pi, li) = pdf.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
                layer = pdf.get_page(pi).get_layer(li);
                y = PAGE_H - MARGIN;
            }
            let num = item.get("item_number").and_then(|v| v.as_i64()).unwrap_or(0);
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let price = item.get("sale_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let line = format!("#{num}  {}  ${price:.2}", fit(title, 9.0, false, 140.0));
            layer.use_text(&line, 9.0, Mm(MARGIN + 4.0), Mm(y), &font);
            y -= 5.5;
        }
        y -= 4.0;
    }
    finish(pdf)
}
