//! PDF rendering for a lot export (manifest / brand counts / pull sheet).
//!
//! Deliberately NOT inside `lot_engine::export` — that module is byte-identical between
//! this app and the server (see `lot_engine::tests::module_tree_hash_is_pinned`), and its own
//! doc comment says "PDF is still each app's own job — only one binary carries `printpdf`".
//! This file takes the same `Doc` that module already builds for `to_csv`/`to_xlsx` and turns
//! it into a PDF, entirely on the desktop side.

use anyhow::Result;
use printpdf::*;
use std::io::BufWriter;

use crate::invoice::text_width_mm;
use crate::lot_engine::export::Doc;

// Landscape letter: a manifest's line-item section can carry a dozen columns (UPC, brand,
// category, segment, size...), and the invoice's portrait page leaves no room for any of
// them to stay readable.
const PAGE_W: f32 = 279.4;
const PAGE_H: f32 = 215.9;
const MARGIN: f32 = 12.0;
const CONTENT_W: f32 = PAGE_W - MARGIN * 2.0;
const TOP_Y: f32 = PAGE_H - MARGIN;
const BOTTOM_Y: f32 = MARGIN;

const TITLE_SIZE: f32 = 13.0;
const SECTION_SIZE: f32 = 10.0;
const CELL_SIZE: f32 = 7.5;
const ROW_H: f32 = 4.6;

/// `text`, truncated with an ellipsis so it fits `max_w` mm at `size_pt` — the same
/// character-budget approach `render_item_row`'s description column uses, just measured
/// instead of guessed at a fixed character count, since a PDF column here can be far
/// narrower than an invoice's description column.
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

fn new_page(pdf: &PdfDocumentReference) -> (PdfLayerReference, f32) {
    let (pi, li) = pdf.add_page(Mm(PAGE_W), Mm(PAGE_H), "Layer");
    (pdf.get_page(pi).get_layer(li), TOP_Y)
}

/// Render every section of `doc` as a table, paginating whenever a page runs out of room.
///
/// Columns are divided evenly across the content width. `to_csv`/`to_xlsx` can give every
/// column its natural width; a PDF has to commit to something ahead of time, and equal
/// widths (with per-cell truncation) keep the table legible without a per-report layout
/// hand-tuned to each of manifest/brands/pull's different column counts.
pub fn to_pdf(doc: &Doc) -> Result<Vec<u8>> {
    let (pdf, page1, layer1) = PdfDocument::new(&doc.name, Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let font = pdf.add_builtin_font(BuiltinFont::Helvetica)?;
    let font_bold = pdf.add_builtin_font(BuiltinFont::HelveticaBold)?;

    let mut layer = pdf.get_page(page1).get_layer(layer1);
    let mut y = TOP_Y;
    layer.use_text(&doc.name, TITLE_SIZE, Mm(MARGIN), Mm(y), &font_bold);
    y -= 8.0;

    for section in &doc.sections {
        if y - (SECTION_SIZE + ROW_H * 2.0) < BOTTOM_Y {
            let (l, top) = new_page(&pdf);
            layer = l;
            y = top;
        }
        if !section.title.is_empty() {
            layer.use_text(&section.title, SECTION_SIZE, Mm(MARGIN), Mm(y), &font_bold);
            y -= 6.0;
        }

        // The manifest's "Lot" summary has two blank headers — it reads as label/value
        // pairs, not a table, so it is drawn that way rather than as a table with an
        // empty header row.
        if section.headers.iter().all(|h| h.is_empty()) {
            for row in &section.rows {
                if y < BOTTOM_Y + ROW_H {
                    let (l, top) = new_page(&pdf);
                    layer = l;
                    y = top;
                }
                let label = row.first().map(String::as_str).unwrap_or("");
                let value = row.get(1).map(String::as_str).unwrap_or("");
                layer.use_text(label, CELL_SIZE + 1.0, Mm(MARGIN), Mm(y), &font_bold);
                layer.use_text(value, CELL_SIZE + 1.0, Mm(MARGIN + 55.0), Mm(y), &font);
                y -= ROW_H + 1.0;
            }
            y -= 4.0;
            continue;
        }

        let n_cols = section.headers.len().max(1);
        let col_w = CONTENT_W / n_cols as f32;
        let col_x = |i: usize| MARGIN + col_w * i as f32;

        let draw_header = |layer: &PdfLayerReference, y: f32| {
            for (i, h) in section.headers.iter().enumerate() {
                layer.use_text(
                    &fit(h, CELL_SIZE, true, col_w - 1.0),
                    CELL_SIZE,
                    Mm(col_x(i)),
                    Mm(y),
                    &font_bold,
                );
            }
        };
        draw_header(&layer, y);
        y -= ROW_H;
        layer.set_outline_thickness(0.3);
        layer.add_line(Line {
            points: vec![
                (Point::new(Mm(MARGIN), Mm(y + 1.5)), false),
                (Point::new(Mm(MARGIN + CONTENT_W), Mm(y + 1.5)), false),
            ],
            is_closed: false,
        });
        y -= 1.5;

        for row in &section.rows {
            if y < BOTTOM_Y {
                let (l, top) = new_page(&pdf);
                layer = l;
                y = top;
                draw_header(&layer, y);
                y -= ROW_H + 1.5;
            }
            for (i, cell) in row.iter().enumerate() {
                layer.use_text(
                    &fit(cell, CELL_SIZE, false, col_w - 1.0),
                    CELL_SIZE,
                    Mm(col_x(i)),
                    Mm(y),
                    &font,
                );
            }
            y -= ROW_H;
        }
        y -= 5.0;
    }

    let mut writer = BufWriter::new(Vec::new());
    pdf.save(&mut writer)?;
    writer
        .into_inner()
        .map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lot_engine::export::Section;

    /// The one invariant a PDF renderer can be tested for without a PDF parser: it produces
    /// bytes that start with the format's own magic header, for both a normal table section
    /// and the label/value "Lot" summary shape.
    #[test]
    fn renders_a_valid_pdf_header() {
        let doc = Doc {
            name: "Test lot — manifest".into(),
            sections: vec![
                Section {
                    title: "Lot".into(),
                    headers: vec!["".into(), "".into()],
                    rows: vec![vec!["Units".into(), "120".into()]],
                },
                Section {
                    title: "Lines".into(),
                    headers: vec!["Description".into(), "Qty".into(), "Total".into()],
                    rows: vec![vec!["Assorted apparel".into(), "120".into(), "1,200.00".into()]],
                },
            ],
        };
        let bytes = to_pdf(&doc).expect("renders");
        assert!(bytes.starts_with(b"%PDF-"));
    }
}
