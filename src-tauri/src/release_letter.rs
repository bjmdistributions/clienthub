//! Merchandise release & closeout authorization letter: a one-page PDF built with
//! `printpdf`, reusing the invoice branding (`company_info` + `invoice_template`) so
//! the letter goes out on OUR letterhead — our logo, our company name.
//!
//! Layout (top to bottom):
//!   - Logo (invoice placement/size); company name instead when no logo is set
//!   - Title
//!   - Body text — `{BUYER}` / `{SELLER}` / `{DESCRIPTION}` substituted from the
//!     input fields, then word-wrapped to the content width
//!   - Signature block: drawn signature above a rule, then Name / Date

use anyhow::{Context, Result};
use printpdf::*;
use serde::Deserialize;
use std::io::BufWriter;

use crate::invoice::{
    load_company, load_template, render_logo, text_width_mm, CompanyInfo, InvoiceTemplate,
    CONTENT_R, MARGIN_L, PAGE_H, PAGE_W,
};

const TITLE: &str = "Merchandise release & closeout authorization letter";

const TITLE_SIZE: f32 = 15.0;
const BODY_SIZE: f32 = 10.5;
const BODY_LINE_H: f32 = 5.4;
/// Extra gap for a blank line between paragraphs.
const PARA_GAP: f32 = 3.2;

/// Signature rule (the line signed above). Everything below is the name/date block.
const SIG_RULE_Y: f32 = 58.0;
const SIG_RULE_W: f32 = 85.0;
const SIG_MAX_W: f32 = 60.0;
const SIG_MAX_H: f32 = 20.0;
/// Body must stop here so it can never collide with the signature block (one page).
const BODY_MIN_Y: f32 = SIG_RULE_Y + 24.0;

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseLetterInput {
    pub buyer_name: String,
    pub buyer_company: String,
    pub description: String,
    pub letter_date: String,
    pub seller_name: String,
    /// The full letter body, with `{BUYER}` / `{SELLER}` / `{DESCRIPTION}` placeholders.
    pub body: String,
    /// `data:image/png;base64,...` from the signature canvas.
    pub signature_png: Option<String>,
    pub output_path: String,
}

impl ReleaseLetterInput {
    /// How the buyer reads in the body prose: "Jane Doe of Acme Retail" when both
    /// are given, otherwise whichever one there is.
    fn buyer_label(&self) -> String {
        let name = self.buyer_name.trim();
        let company = self.buyer_company.trim();
        match (name.is_empty(), company.is_empty()) {
            (false, false) => format!("{} of {}", name, company),
            (false, true) => name.to_string(),
            (true, false) => company.to_string(),
            (true, true) => String::new(),
        }
    }

    /// `{SELLER}` is the COMPANY, not the signer: the business is the party that
    /// sells and releases liability; the person named at the bottom just signs on
    /// its behalf. Falls back to the signer only when no company name is set.
    fn filled_body(&self, company_name: &str) -> String {
        let seller = match company_name.trim() {
            "" => self.seller_name.trim(),
            c => c,
        };
        self.body
            .replace("{BUYER}", &self.buyer_label())
            .replace("{SELLER}", seller)
            .replace("{DESCRIPTION}", self.description.trim())
    }
}

/// Word-wrap `text` to `max_w` mm. Blank input lines are kept as empty entries so
/// the caller can render a paragraph gap. A single word longer than the line is
/// left long rather than split mid-word.
fn wrap_text(text: &str, size_pt: f32, bold: bool, max_w: f32) -> Vec<String> {
    let mut out = Vec::new();
    for raw_line in text.lines() {
        if raw_line.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        let mut line = String::new();
        for word in raw_line.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_string()
            } else {
                format!("{} {}", line, word)
            };
            if !line.is_empty() && text_width_mm(&candidate, size_pt, bold) > max_w {
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

fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    // "data:image/png;base64,AAAA..." → "AAAA..." (also tolerates bare base64).
    let b64 = data_url.split_once(',').map_or(data_url, |(_, rest)| rest);
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64.trim()).ok()
}

/// Draw a PNG (the signature) with its bottom-left at (`x`, `bottom_y`), scaled to
/// fit `SIG_MAX_W` x `SIG_MAX_H`. Transparency is flattened onto white, the same way
/// `invoice::render_logo` handles a transparent logo.
fn draw_signature(layer: &PdfLayerReference, png: &[u8], x: f32, bottom_y: f32) -> Result<()> {
    let dyn_img = printpdf::image_crate::load_from_memory(png).context("decode signature image")?;
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

    let px_per_mm: f32 = 72.0 / 25.4;
    let native_w_mm = w as f32 / px_per_mm;
    let native_h_mm = h as f32 / px_per_mm;
    let scale = (SIG_MAX_W / native_w_mm).min(SIG_MAX_H / native_h_mm).min(1.0);

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
    printpdf::Image::from(xobj).add_to_layer(
        layer.clone(),
        ImageTransform {
            translate_x: Some(Mm(x)),
            translate_y: Some(Mm(bottom_y)),
            scale_x: Some(scale),
            scale_y: Some(scale),
            rotate: None,
            dpi: Some(72.0),
        },
    );
    Ok(())
}

/// Build the letter PDF. Takes the branding explicitly (rather than loading it) so
/// the layout is exercisable without a database.
pub fn build_letter_bytes(
    input: &ReleaseLetterInput,
    company: &CompanyInfo,
    tpl: &InvoiceTemplate,
) -> Result<Vec<u8>> {
    let (doc, page, layer_idx) =
        PdfDocument::new("Release letter", Mm(PAGE_W), Mm(PAGE_H), "Layer 1");
    let layer = doc.get_page(page).get_layer(layer_idx);
    let font_regular = doc.add_builtin_font(BuiltinFont::Helvetica)?;
    let font_bold = doc.add_builtin_font(BuiltinFont::HelveticaBold)?;
    let content_w = CONTENT_R - MARGIN_L;

    // ----- Letterhead: logo, or the company name when no logo is configured -----
    let logo = match company.logo_path.as_deref() {
        Some(p) if std::path::Path::new(p).exists() => {
            render_logo(&layer, p, &tpl.logo_placement, tpl.logo_size_factor()).unwrap_or(None)
        }
        _ => None,
    };
    let mut y = match &logo {
        Some(l) => l.bottom_y - 16.0,
        None => {
            layer.use_text(&company.name, 18.0, Mm(MARGIN_L), Mm(262.0), &font_bold);
            250.0
        }
    };

    // ----- Title -----
    layer.set_fill_color(tpl.accent());
    for line in wrap_text(TITLE, TITLE_SIZE, true, content_w) {
        layer.use_text(&line, TITLE_SIZE, Mm(MARGIN_L), Mm(y), &font_bold);
        y -= 7.0;
    }
    layer.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));

    // ----- Body -----
    y -= 6.0;
    for line in wrap_text(&input.filled_body(&company.name), BODY_SIZE, false, content_w) {
        // One page by contract: anything that would run into the signature block
        // is dropped rather than pushed onto a second page.
        if y < BODY_MIN_Y {
            break;
        }
        if line.is_empty() {
            y -= PARA_GAP;
            continue;
        }
        layer.use_text(&line, BODY_SIZE, Mm(MARGIN_L), Mm(y), &font_regular);
        y -= BODY_LINE_H;
    }

    // ----- Signature block -----
    if let Some(png) = input.signature_png.as_deref().and_then(decode_data_url) {
        draw_signature(&layer, &png, MARGIN_L + 2.0, SIG_RULE_Y + 2.0)?;
    }
    layer.set_outline_thickness(0.4);
    layer.add_line(Line {
        points: vec![
            (Point::new(Mm(MARGIN_L), Mm(SIG_RULE_Y)), false),
            (Point::new(Mm(MARGIN_L + SIG_RULE_W), Mm(SIG_RULE_Y)), false),
        ],
        is_closed: false,
    });
    layer.use_text(
        format!("Name: {}", input.seller_name.trim()),
        10.0,
        Mm(MARGIN_L),
        Mm(SIG_RULE_Y - 8.0),
        &font_regular,
    );
    layer.use_text(
        format!("Date: {}", input.letter_date.trim()),
        10.0,
        Mm(MARGIN_L),
        Mm(SIG_RULE_Y - 15.0),
        &font_regular,
    );

    let mut writer = BufWriter::new(Vec::new());
    doc.save(&mut writer)?;
    writer
        .into_inner()
        .map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))
}

#[tauri::command]
pub async fn generate_release_letter(input: ReleaseLetterInput) -> Result<String, String> {
    let company = load_company().map_err(|e| e.to_string())?;
    let tpl = load_template();
    let bytes = build_letter_bytes(&input, &company, &tpl).map_err(|e| e.to_string())?;
    std::fs::write(&input.output_path, bytes).map_err(|e| e.to_string())?;
    Ok(input.output_path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The releasing party must be the BUSINESS. If the signer's name lands in
    /// {SELLER}, the letter reads as though a person — not the company — sold the
    /// goods and released the liability, which is not what it is meant to say.
    #[test]
    fn seller_is_the_company_not_the_signer() {
        let i = ReleaseLetterInput {
            buyer_name: "Jane Doe".into(),
            buyer_company: "Acme Retail".into(),
            description: "1,200 units of assorted branded apparel".into(),
            letter_date: "2026-07-16".into(),
            seller_name: "Jack Johnson".into(),
            body: "{SELLER} agrees to sell to {BUYER}. {SELLER} releases {DESCRIPTION}.".into(),
            signature_png: None,
            output_path: String::new(),
        };
        let out = i.filled_body("BJM Distributions");
        assert!(out.contains("BJM Distributions agrees to sell"));
        assert!(!out.contains("Jack Johnson agrees"));
        // Only with no company configured does the signer stand in.
        assert!(i.filled_body("").contains("Jack Johnson agrees"));
    }
}
