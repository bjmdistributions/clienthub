//! R-557: import lots from a spreadsheet.
//!
//! The column list lives in `src/lib/lotImportTemplate.json` and is read by both sides: this
//! file writes the template from it, and `src/lib/lotImport.ts` reads a filled sheet against
//! it. One list, so the template Jack hands out and the importer never disagree about a
//! column. Everything that decides what a row MEANS (prices, pallets, duplicates) is in the
//! TypeScript, next to the lot form it mirrors; this side only moves bytes.

use serde::{Deserialize, Serialize};

const SPEC: &str = include_str!("../../src/lib/lotImportTemplate.json");

#[derive(Deserialize)]
struct Spec {
    sheet: String,
    help_sheet: String,
    intro: String,
    columns: Vec<Column>,
    examples: Vec<std::collections::HashMap<String, String>>,
}

#[derive(Deserialize)]
struct Column {
    key: String,
    header: String,
    width: f64,
    help: String,
    #[serde(default)]
    choices: Vec<String>,
    #[serde(default)]
    number: bool,
}

fn spec() -> Result<Spec, String> {
    serde_json::from_str(SPEC).map_err(|e| format!("The import template is damaged: {e}"))
}

/// Write the empty template (with its three example rows) to `path`.
fn write_template(path: &str) -> Result<(), String> {
    use rust_xlsxwriter::{Color, DataValidation, DataValidationErrorStyle, Format, FormatAlign, FormatBorder, Workbook};
    let s = spec()?;
    let e = |x: rust_xlsxwriter::XlsxError| format!("Couldn't write the template: {x}");
    let head = Format::new()
        .set_bold()
        .set_text_wrap()
        .set_align(FormatAlign::Top)
        .set_background_color(Color::RGB(0xF1F1EF))
        .set_border_bottom(FormatBorder::Thin);
    let cell = Format::new().set_text_wrap().set_align(FormatAlign::Top);
    let example = Format::new().set_text_wrap().set_align(FormatAlign::Top).set_font_color(Color::RGB(0x6B6B6B));

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name(&s.sheet).map_err(e)?;
    for (c, col) in s.columns.iter().enumerate() {
        let c = c as u16;
        ws.set_column_width(c, col.width).map_err(e)?;
        ws.write_string_with_format(0, c, &col.header, &head).map_err(e)?;
        for (r, ex) in s.examples.iter().enumerate() {
            let r = r as u32 + 1;
            let v = ex.get(&col.key).map(String::as_str).unwrap_or("");
            match v.parse::<f64>() {
                Ok(n) if col.number => { ws.write_number_with_format(r, c, n, &example).map_err(e)?; }
                _ if !v.is_empty() => { ws.write_string_with_format(r, c, v, &example).map_err(e)?; }
                _ => {}
            }
        }
        // A pick list where the form has one. Information style, so a value typed by hand
        // (a condition of his own) is still allowed: the importer reads more spellings than
        // the list shows.
        if !col.choices.is_empty() {
            let dv = DataValidation::new()
                .allow_list_strings(&col.choices)
                .map_err(e)?
                .set_error_style(DataValidationErrorStyle::Information);
            ws.add_data_validation(1, c, 2000, c, &dv).map_err(e)?;
        }
    }
    ws.set_row_height(0, 30).map_err(e)?;
    ws.set_freeze_panes(1, 1).map_err(e)?;

    let help = wb.add_worksheet();
    help.set_name(&s.help_sheet).map_err(e)?;
    help.set_column_width(0, 22).map_err(e)?;
    help.set_column_width(1, 70).map_err(e)?;
    help.set_column_width(2, 26).map_err(e)?;
    help.merge_range(0, 0, 0, 2, &s.intro, &cell).map_err(e)?;
    help.set_row_height(0, 48).map_err(e)?;
    for (i, h) in ["Column", "What to put in it", "Pick from"].iter().enumerate() {
        help.write_string_with_format(2, i as u16, *h, &head).map_err(e)?;
    }
    for (i, col) in s.columns.iter().enumerate() {
        let r = i as u32 + 3;
        help.write_string_with_format(r, 0, &col.header, &cell).map_err(e)?;
        help.write_string_with_format(r, 1, &col.help, &cell).map_err(e)?;
        if !col.choices.is_empty() {
            help.write_string_with_format(r, 2, col.choices.join(", "), &cell).map_err(e)?;
        }
    }
    wb.save(path).map_err(e)
}

#[tauri::command]
pub async fn save_lot_import_template(path: String) -> Result<(), String> {
    write_template(&path)
}

#[derive(Serialize)]
pub struct ImportSheet {
    /// The sheet the rows came from, so the screen can say which one it read.
    sheet: String,
    /// Every row as text, the header row included. The importer finds the header itself.
    rows: Vec<Vec<String>>,
}

fn cell_text(d: &calamine::Data) -> String {
    use calamine::Data;
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        // Excel stores every number as a float; 250.0 must not read as "250.0".
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", *f as i64) } else { format!("{}", f) }
        }
        other => other.to_string(),
    }
}

fn read_sheet(path: &str) -> Result<ImportSheet, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") || lower.ends_with(".tsv") || lower.ends_with(".txt") {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(if lower.ends_with(".tsv") { b'\t' } else { b',' })
            .from_path(path)
            .map_err(|e| format!("Couldn't open the file: {e}"))?;
        let mut rows = Vec::new();
        for rec in rdr.records() {
            let rec = rec.map_err(|e| format!("Couldn't read the file: {e}"))?;
            rows.push(rec.iter().map(|c| c.trim().to_string()).collect());
        }
        return Ok(ImportSheet { sheet: String::new(), rows });
    }
    use calamine::Reader;
    let mut wb = calamine::open_workbook_auto(path).map_err(|e| format!("Couldn't open the spreadsheet: {e}"))?;
    let s = spec()?;
    let names = wb.sheet_names().to_vec();
    // The template's own sheet when it is there; otherwise the first sheet that is not the
    // instructions, so a file someone renamed or rebuilt still reads.
    let pick = names
        .iter()
        .find(|n| n.trim().eq_ignore_ascii_case(&s.sheet))
        .or_else(|| names.iter().find(|n| !n.trim().eq_ignore_ascii_case(&s.help_sheet)))
        .cloned()
        .ok_or("The spreadsheet has no sheets.")?;
    let range = wb.worksheet_range(&pick).map_err(|e| format!("Couldn't read the sheet {pick}: {e}"))?;
    let rows = range.rows().map(|r| r.iter().map(cell_text).collect()).collect();
    Ok(ImportSheet { sheet: pick, rows })
}

#[tauri::command]
pub async fn read_lot_import_sheet(path: String) -> Result<ImportSheet, String> {
    tauri::async_runtime::spawn_blocking(move || read_sheet(&path)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct ImportFile {
    reference: String,
    /// A file on this computer the lot form can use: the file itself, or a downloaded copy.
    path: Option<String>,
    error: Option<String>,
}

const PHOTO_EXTS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "gif"];
const MANIFEST_EXTS: [&str; 5] = ["pdf", "csv", "xlsx", "xls", "xlsm"];
const MAX_BYTES: usize = 25 * 1024 * 1024;

fn ext_of(name: &str) -> Option<String> {
    let base = name.split(['?', '#']).next().unwrap_or(name);
    let file = base.rsplit(['/', '\\']).next().unwrap_or(base);
    file.rsplit_once('.').map(|(_, x)| x.to_lowercase())
}

/// Share links that open a viewer page instead of the file, turned into their direct
/// download form. Both are the usual way a photo reaches a spreadsheet from a phone.
fn direct_link(url: &str) -> String {
    if let Some(rest) = url.split("drive.google.com/file/d/").nth(1) {
        let id = rest.split(['/', '?']).next().unwrap_or("");
        if !id.is_empty() {
            return format!("https://drive.google.com/uc?export=download&id={id}");
        }
    }
    if url.contains("dropbox.com/") && url.contains("dl=0") {
        return url.replace("dl=0", "dl=1");
    }
    url.to_string()
}

async fn download(client: &reqwest::Client, url: &str, photo: bool) -> Result<String, String> {
    let resp = client
        .get(direct_link(url))
        .send()
        .await
        .map_err(|_| "Couldn't reach that link".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("The link answered {}", resp.status().as_u16()));
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let ext = if photo {
        match ctype.split(';').next().unwrap_or("").trim() {
            "image/jpeg" | "image/jpg" => "jpg".to_string(),
            "image/png" => "png".to_string(),
            "image/webp" => "webp".to_string(),
            "image/gif" => "gif".to_string(),
            t if t.starts_with("text/html") => return Err("That link opens a web page, not a picture".into()),
            t if t.starts_with("image/") => return Err(format!("That picture is a {} file, which can't be shown. Use JPG or PNG", &t[6..])),
            _ => ext_of(url).filter(|x| PHOTO_EXTS.contains(&x.as_str())).ok_or("That link is not a picture")?,
        }
    } else {
        match ext_of(url).filter(|x| MANIFEST_EXTS.contains(&x.as_str())) {
            Some(x) => x,
            None if ctype.starts_with("application/pdf") => "pdf".into(),
            None if ctype.starts_with("text/csv") => "csv".into(),
            None if ctype.contains("spreadsheetml") => "xlsx".into(),
            None => return Err("That link is not a PDF, CSV or Excel file".into()),
        }
    };
    if resp.content_length().map_or(false, |n| n as usize > MAX_BYTES) {
        return Err("That file is over 25 MB".into());
    }
    let bytes = resp.bytes().await.map_err(|_| "The download stopped part way".to_string())?;
    if bytes.is_empty() {
        return Err("The link gave back an empty file".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("That file is over 25 MB".into());
    }
    let dir = std::env::temp_dir().join("ecliptr-import");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}.{}", uuid::Uuid::new_v4().simple(), ext));
    std::fs::write(&dest, &bytes).map_err(|e| format!("Couldn't save the download: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

fn local(reference: &str, base_dir: &str, photo: bool) -> Result<String, String> {
    let r = reference.strip_prefix("file:///").or_else(|| reference.strip_prefix("file://")).unwrap_or(reference);
    let p = std::path::Path::new(r);
    // A bare name is a file beside the spreadsheet, the way the template's help sheet says.
    let full = if p.is_absolute() { p.to_path_buf() } else { std::path::Path::new(base_dir).join(p) };
    if !full.is_file() {
        return Err(format!("No file called {} next to the spreadsheet", p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| r.to_string())));
    }
    let allowed: &[&str] = if photo { &PHOTO_EXTS } else { &MANIFEST_EXTS };
    match ext_of(r) {
        Some(x) if allowed.contains(&x.as_str()) => Ok(full.to_string_lossy().to_string()),
        _ if photo => Err("Not a picture. Use JPG, PNG, WEBP or GIF".into()),
        _ => Err("Not a PDF, CSV or Excel file".into()),
    }
}

/// Turn the photo or manifest references in one row into files on this computer. Links are
/// downloaded to a temp folder; names are looked up beside the spreadsheet. Nothing is
/// copied into a lot here: that happens when the lot is added, exactly as the form does it.
#[tauri::command]
pub async fn fetch_lot_import_files(refs: Vec<String>, base_dir: String, kind: String) -> Vec<ImportFile> {
    let photo = kind != "manifest";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Ecliptr lot import)")
        .build()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(refs.len());
    for reference in refs {
        let r = reference.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        let lower = r.to_lowercase();
        let got = if lower.starts_with("http://") || lower.starts_with("https://") {
            download(&client, &r, photo).await
        } else {
            local(&r, &base_dir, photo)
        };
        out.push(match got {
            Ok(path) => ImportFile { reference, path: Some(path), error: None },
            Err(error) => ImportFile { reference, path: None, error: Some(error) },
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The template reads back through the importer's own reader with the spec's headers
    /// in order and the example rows intact. Set LOT_IMPORT_TEMPLATE_OUT to keep a copy.
    #[test]
    fn template_round_trips() {
        let out = std::env::var("LOT_IMPORT_TEMPLATE_OUT")
            .unwrap_or_else(|_| std::env::temp_dir().join("ecliptr-lot-import-template.xlsx").to_string_lossy().to_string());
        write_template(&out).unwrap();
        let sheet = read_sheet(&out).unwrap();
        let s = spec().unwrap();
        assert_eq!(sheet.sheet, s.sheet);
        let headers: Vec<&str> = s.columns.iter().map(|c| c.header.as_str()).collect();
        assert_eq!(sheet.rows[0], headers);
        assert_eq!(sheet.rows.len(), 1 + s.examples.len());
        assert_eq!(sheet.rows[1][0], s.examples[0]["name"]);
        let qty = s.columns.iter().position(|c| c.key == "quantity").unwrap();
        assert_eq!(sheet.rows[1][qty], "450");
    }

    #[test]
    fn share_links_become_direct() {
        assert_eq!(
            direct_link("https://drive.google.com/file/d/AbC123/view?usp=sharing"),
            "https://drive.google.com/uc?export=download&id=AbC123"
        );
        assert_eq!(direct_link("https://www.dropbox.com/s/x/a.jpg?dl=0"), "https://www.dropbox.com/s/x/a.jpg?dl=1");
        assert_eq!(ext_of("https://x.com/a/b.JPG?v=2"), Some("jpg".into()));
    }

    #[test]
    fn local_names_resolve_beside_the_sheet() {
        let dir = std::env::temp_dir().join(format!("r557-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("front.jpg"), b"x").unwrap();
        let base = dir.to_string_lossy().to_string();
        assert!(local("front.jpg", &base, true).is_ok());
        assert!(local("missing.jpg", &base, true).unwrap_err().contains("missing.jpg"));
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        assert!(local("notes.txt", &base, true).is_err());
    }
}
