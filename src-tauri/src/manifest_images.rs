//! R-379: the photos in an .xlsx manifest, and the row each one belongs to.
//!
//! calamine reads cell values only. Its `picture` feature hands back the bytes of every
//! file under `xl/media` with no idea which row they sit on, so this reads the package
//! itself (zip and quick-xml, both already in the tree through calamine):
//!
//! - **pictures placed on the sheet**: the sheet's drawing part. Each `twoCellAnchor` /
//!   `oneCellAnchor` gives the cell it starts in, its offset and its size.
//! - **pictures placed in a cell** (Excel 365 "Place in cell"): the cell's `vm`
//!   attribute, through `xl/metadata.xml` and `xl/richData/*`, to a media file or to the
//!   address of a web image.
//! - **row heights and column widths**, so the split files lay out the way the source did.
//!
//! Only the index is built here, which is cheap. Bytes are read when a file is written
//! (`media_bytes`). A package this cannot follow yields fewer photos, never an error:
//! the manifest's rows still split.

use anyhow::{Context, Result};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Read;

/// A picture placed over the sheet, already moved onto the row its middle falls on.
#[derive(Debug, Clone)]
pub struct Placed {
    /// Path of the image inside the package, e.g. `xl/media/image3.png`.
    pub media: String,
    /// Zero-based row the picture belongs to (where its vertical middle is).
    pub row: u32,
    /// Zero-based column it starts in.
    pub col: u32,
    /// Offset from the top-left of that cell, in pixels. Never negative.
    pub x_px: f64,
    pub y_px: f64,
    /// Size on the sheet, in pixels.
    pub w_px: f64,
    pub h_px: f64,
}

#[derive(Debug)]
pub struct SheetImages {
    /// (row, col) of a cell holding a picture, to the picture's package path.
    pub in_cell: HashMap<(u32, u32), String>,
    /// (row, col) of a cell holding a web picture, to its address.
    pub web: HashMap<(u32, u32), String>,
    pub placed: Vec<Placed>,
    /// Row heights in points, for rows that set one.
    pub row_heights: HashMap<u32, f64>,
    /// Column widths in pixels, for columns that set one.
    pub col_px: HashMap<u32, f64>,
    pub default_row_pt: f64,
    pub default_col_px: f64,
    /// Pictures the package points at but this could not follow to a file.
    pub unresolved: usize,
    /// false when the file is not an Open XML package at all (.xls, .ods, .xlsb, CSV).
    pub readable: bool,
}

impl Default for SheetImages {
    fn default() -> Self {
        SheetImages {
            in_cell: HashMap::new(),
            web: HashMap::new(),
            placed: Vec::new(),
            row_heights: HashMap::new(),
            col_px: HashMap::new(),
            default_row_pt: 15.0,
            default_col_px: 64.0,
            unresolved: 0,
            readable: false,
        }
    }
}

impl SheetImages {
    pub fn row_px(&self, row: u32) -> f64 {
        self.row_heights.get(&row).copied().unwrap_or(self.default_row_pt) * 4.0 / 3.0
    }
    pub fn col_width_px(&self, col: u32) -> f64 {
        self.col_px.get(&col).copied().unwrap_or(self.default_col_px)
    }
    pub fn count(&self) -> usize {
        self.in_cell.len() + self.web.len() + self.placed.len()
    }
}

const EMU_PER_PX: f64 = 9525.0;

type Zip = zip::ZipArchive<std::fs::File>;

/// A part's text, found case-insensitively (packages written by other tools do not
/// always keep Excel's casing).
fn part(zip: &mut Zip, names: &HashMap<String, String>, name: &str) -> Option<String> {
    let real = names.get(&name.to_lowercase())?.clone();
    let mut f = zip.by_name(&real).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Resolve a relationship target against the part that owns it.
fn resolve(base_part: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base_part.split('/').collect();
    parts.pop(); // the file name; what is left is its folder
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// `folder/_rels/name.rels` for a part at `folder/name`.
fn rels_path(part_path: &str) -> String {
    match part_path.rfind('/') {
        Some(i) => format!("{}/_rels/{}.rels", &part_path[..i], &part_path[i + 1..]),
        None => format!("_rels/{}.rels", part_path),
    }
}

fn attr(e: &BytesStart, local: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == local {
            // calamine turns on quick-xml's `encoding` feature, which removes
            // `unescape_value`; package parts are UTF-8, so decode and unescape by hand.
            let raw = std::str::from_utf8(&a.value).ok()?;
            return Some(quick_xml::escape::unescape(raw).map(|v| v.into_owned()).unwrap_or_else(|_| raw.to_string()));
        }
    }
    None
}

/// Relationship id to (target resolved against its part, is-external).
fn relationships(zip: &mut Zip, names: &HashMap<String, String>, owner: &str) -> HashMap<String, (String, bool)> {
    let mut out = HashMap::new();
    let Some(xml) = part(zip, names, &rels_path(owner)) else { return out };
    let mut r = Reader::from_str(&xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"Relationship" => {
                let (Some(id), Some(target)) = (attr(&e, b"Id"), attr(&e, b"Target")) else { continue };
                let external = attr(&e, b"TargetMode").map_or(false, |m| m.eq_ignore_ascii_case("External"));
                let t = if external { target } else { resolve(owner, &target) };
                out.insert(id, (t, external));
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// "B12" to (row 11, col 1).
fn cell_ref(r: &str) -> Option<(u32, u32)> {
    let letters: String = r.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits = &r[letters.len()..];
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let mut col: u32 = 0;
    for c in letters.chars() {
        col = col * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    let row: u32 = digits.parse().ok()?;
    if row == 0 || col == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

/// Excel's stored column width (characters, padding included) in pixels, for the
/// default 11pt Calibri whose widest digit is 7 pixels.
fn width_to_px(w: f64) -> f64 {
    if w <= 0.0 {
        return 0.0;
    }
    (((256.0 * w + (128.0f64 / 7.0).trunc()) / 256.0) * 7.0).trunc()
}

/// The package path of the sheet named `sheet`.
fn sheet_part(zip: &mut Zip, names: &HashMap<String, String>, sheet: &str) -> Option<String> {
    let workbook = relationships(zip, names, "")
        .into_values()
        .map(|(t, _)| t)
        .find(|t| t.to_lowercase().ends_with("workbook.xml"))
        .unwrap_or_else(|| "xl/workbook.xml".to_string());
    let xml = part(zip, names, &workbook)?;
    let mut rid = None;
    let mut r = Reader::from_str(&xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"sheet" => {
                if attr(&e, b"name").as_deref() == Some(sheet) {
                    rid = attr(&e, b"id");
                    break;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let rels = relationships(zip, names, &workbook);
    rels.get(&rid?).map(|(t, _)| t.clone())
}

/// What the sheet part itself says: row heights, column widths, the cells that hold a
/// picture (`vm`), and which drawing belongs to it.
struct SheetXml {
    vm_cells: Vec<((u32, u32), u32)>,
    drawing_rid: Option<String>,
}

fn read_sheet(xml: &str, out: &mut SheetImages) -> SheetXml {
    let mut s = SheetXml { vm_cells: Vec::new(), drawing_rid: None };
    let mut base_col: Option<f64> = None;
    let mut default_col: Option<f64> = None;
    let mut r = Reader::from_str(xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"sheetFormatPr" => {
                    if let Some(h) = attr(&e, b"defaultRowHeight").and_then(|v| v.parse::<f64>().ok()) {
                        if h > 0.0 {
                            out.default_row_pt = h;
                        }
                    }
                    default_col = attr(&e, b"defaultColWidth").and_then(|v| v.parse().ok());
                    base_col = attr(&e, b"baseColWidth").and_then(|v| v.parse().ok());
                }
                b"col" => {
                    let min: u32 = attr(&e, b"min").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let max: u32 = attr(&e, b"max").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let w: Option<f64> = attr(&e, b"width").and_then(|v| v.parse().ok());
                    if let Some(w) = w {
                        if min >= 1 && max >= min {
                            // A `col` spanning to 16384 is "the rest of the sheet"; only the
                            // first few hundred columns can matter to a manifest.
                            for c in min..=max.min(min + 512) {
                                out.col_px.insert(c - 1, width_to_px(w));
                            }
                        }
                    }
                }
                b"row" => {
                    let rn: Option<u32> = attr(&e, b"r").and_then(|v| v.parse().ok());
                    let ht: Option<f64> = attr(&e, b"ht").and_then(|v| v.parse().ok());
                    if let (Some(rn), Some(ht)) = (rn, ht) {
                        if rn >= 1 {
                            out.row_heights.insert(rn - 1, ht);
                        }
                    }
                }
                b"c" => {
                    if let (Some(rf), Some(vm)) = (attr(&e, b"r"), attr(&e, b"vm")) {
                        if let (Some(at), Ok(vm)) = (cell_ref(&rf), vm.parse::<u32>()) {
                            s.vm_cells.push((at, vm));
                        }
                    }
                }
                b"drawing" => s.drawing_rid = attr(&e, b"id"),
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out.default_col_px = match (default_col, base_col) {
        (Some(w), _) => width_to_px(w),
        // Excel's own default: the base width in digits plus 5 pixels of padding,
        // rounded up to a multiple of 8. Eight digits is the 64 pixels everyone knows.
        (None, Some(b)) => ((b * 7.0 + 5.0) / 8.0).ceil() * 8.0,
        (None, None) => 64.0,
    };
    s
}

/// Follow each `vm` cell to its picture: valueMetadata -> futureMetadata (XLRICHVALUE)
/// -> the rich value -> its structure -> the relationship to the media file, or the
/// web image's address.
fn read_in_cell(zip: &mut Zip, names: &HashMap<String, String>, vm_cells: &[((u32, u32), u32)], out: &mut SheetImages) {
    if vm_cells.is_empty() {
        return;
    }
    let Some(meta) = part(zip, names, "xl/metadata.xml") else {
        out.unresolved += vm_cells.len();
        return;
    };

    // metadataType names (1-based), the XLRICHVALUE future blocks' rich value indexes,
    // and the valueMetadata blocks' (type, index) pairs.
    let mut types: Vec<String> = Vec::new();
    let mut rich_of_future: Vec<Option<u32>> = Vec::new();
    let mut value_blocks: Vec<Option<(u32, u32)>> = Vec::new();
    {
        let (mut in_future_rich, mut in_value) = (false, false);
        let mut r = Reader::from_str(&meta);
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) => match e.local_name().as_ref() {
                    b"metadataType" => types.push(attr(&e, b"name").unwrap_or_default()),
                    b"futureMetadata" => in_future_rich = attr(&e, b"name").as_deref() == Some("XLRICHVALUE"),
                    b"valueMetadata" => in_value = true,
                    b"bk" if in_future_rich => rich_of_future.push(None),
                    b"bk" if in_value => value_blocks.push(None),
                    _ => {}
                },
                Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                    b"metadataType" => types.push(attr(&e, b"name").unwrap_or_default()),
                    b"rvb" if in_future_rich => {
                        if let Some(last) = rich_of_future.last_mut() {
                            *last = attr(&e, b"i").and_then(|v| v.parse().ok());
                        }
                    }
                    b"rc" if in_value => {
                        if let Some(last) = value_blocks.last_mut() {
                            let t = attr(&e, b"t").and_then(|v| v.parse().ok());
                            let v = attr(&e, b"v").and_then(|v| v.parse().ok());
                            if let (Some(t), Some(v)) = (t, v) {
                                *last = Some((t, v));
                            }
                        }
                    }
                    _ => {}
                },
                Ok(Event::End(e)) => match e.local_name().as_ref() {
                    b"futureMetadata" => in_future_rich = false,
                    b"valueMetadata" => in_value = false,
                    _ => {}
                },
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    // Rich values: (structure index, values in key order).
    let mut values: Vec<(usize, Vec<String>)> = Vec::new();
    if let Some(xml) = part(zip, names, "xl/richData/rdrichvalue.xml") {
        let mut r = Reader::from_str(&xml);
        // The text of the <v> being read. An empty <v></v> still takes its key's place.
        let mut v_text: Option<String> = None;
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) if e.local_name().as_ref() == b"rv" => {
                    values.push((attr(&e, b"s").and_then(|v| v.parse().ok()).unwrap_or(0), Vec::new()));
                }
                Ok(Event::Start(e)) if e.local_name().as_ref() == b"v" => v_text = Some(String::new()),
                Ok(Event::Text(t)) => {
                    if let Some(buf) = v_text.as_mut() {
                        buf.push_str(&t.unescape().map(|s| s.into_owned()).unwrap_or_default());
                    }
                }
                Ok(Event::End(e)) if e.local_name().as_ref() == b"v" => {
                    if let (Some(buf), Some(last)) = (v_text.take(), values.last_mut()) {
                        last.1.push(buf);
                    }
                }
                Ok(Event::Empty(e)) if e.local_name().as_ref() == b"v" => {
                    if let Some(last) = values.last_mut() {
                        last.1.push(String::new());
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    // Structures: (type, key names in order).
    let mut structures: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(xml) = part(zip, names, "xl/richData/rdrichvaluestructure.xml") {
        let mut r = Reader::from_str(&xml);
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) if e.local_name().as_ref() == b"s" => {
                    structures.push((attr(&e, b"t").unwrap_or_default(), Vec::new()));
                }
                Ok(Event::Empty(e)) if e.local_name().as_ref() == b"s" => {
                    structures.push((attr(&e, b"t").unwrap_or_default(), Vec::new()));
                }
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"k" => {
                    if let Some(last) = structures.last_mut() {
                        last.1.push(attr(&e, b"n").unwrap_or_default());
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    // Local pictures: the rich value's relationship index -> richValueRel.xml -> media.
    let mut local_rels: Vec<Option<String>> = Vec::new();
    if let Some(xml) = part(zip, names, "xl/richData/richValueRel.xml") {
        let rels = relationships(zip, names, "xl/richData/richValueRel.xml");
        let mut r = Reader::from_str(&xml);
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"rel" => {
                    local_rels.push(attr(&e, b"id").and_then(|id| rels.get(&id).map(|(t, _)| t.clone())));
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    // Web pictures: the rich value's web image index -> its address relationship.
    let mut web_addrs: Vec<Option<String>> = Vec::new();
    if let Some(xml) = part(zip, names, "xl/richData/rdRichValueWebImage.xml") {
        let rels = relationships(zip, names, "xl/richData/rdRichValueWebImage.xml");
        let mut r = Reader::from_str(&xml);
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) if e.local_name().as_ref() == b"webImageSrd" => web_addrs.push(None),
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"address" => {
                    if let Some(last) = web_addrs.last_mut() {
                        *last = attr(&e, b"id").and_then(|id| rels.get(&id).map(|(t, _)| t.clone()));
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    for &(at, vm) in vm_cells {
        let found = (|| -> Option<Result<String, String>> {
            let (t, v) = (*value_blocks.get(vm.checked_sub(1)? as usize)?)?;
            if types.get(t.checked_sub(1)? as usize)?.as_str() != "XLRICHVALUE" {
                return None;
            }
            let rv_index = (*rich_of_future.get(v as usize)?)? as usize;
            let (s, vals) = values.get(rv_index)?;
            let (stype, keys) = structures.get(*s)?;
            let key_val = |name: &str| -> Option<usize> {
                let i = keys.iter().position(|k| k == name)?;
                vals.get(i)?.trim().parse().ok()
            };
            if stype.eq_ignore_ascii_case("_localImage") {
                let i = key_val("_rvRel:LocalImageIdentifier")?;
                return Some(Ok(local_rels.get(i)?.clone()?));
            }
            if stype.eq_ignore_ascii_case("_webimage") {
                let i = key_val("WebImageIdentifier")?;
                return Some(Err(web_addrs.get(i)?.clone()?));
            }
            None
        })();
        match found {
            Some(Ok(media)) => {
                out.in_cell.insert(at, media);
            }
            Some(Err(url)) => {
                out.web.insert(at, url);
            }
            // A `vm` that is not a picture (a stock or a geography value) is not a miss.
            None => {
                if value_blocks
                    .get((vm.max(1) - 1) as usize)
                    .and_then(|b| *b)
                    .and_then(|(t, _)| types.get((t.max(1) - 1) as usize))
                    .map_or(false, |n| n == "XLRICHVALUE")
                {
                    out.unresolved += 1;
                }
            }
        }
    }
}

#[derive(Default, Clone, Copy)]
struct Marker {
    col: u32,
    col_off: i64,
    row: u32,
    row_off: i64,
}

/// Pictures over the sheet, from its drawing part.
fn read_drawing(zip: &mut Zip, names: &HashMap<String, String>, drawing: &str, out: &mut SheetImages) {
    let Some(xml) = part(zip, names, drawing) else { return };
    let rels = relationships(zip, names, drawing);
    let (placed, unresolved) = parse_drawing(&xml, &rels, out);
    out.placed.extend(placed);
    out.unresolved += unresolved;
}

/// One picture inside an anchor, with its own position when it sits in a group.
#[derive(Default)]
struct Pic {
    media: Option<String>,
    off: Option<(i64, i64)>,
    ext: Option<(i64, i64)>,
}

/// A group's size on the sheet, and the child coordinate space its pictures are
/// positioned in.
#[derive(Default, Clone, Copy)]
struct GroupXfrm {
    ext: Option<(i64, i64)>,
    ch_off: Option<(i64, i64)>,
    ch_ext: Option<(i64, i64)>,
}

fn parse_drawing(xml: &str, rels: &HashMap<String, (String, bool)>, s: &SheetImages) -> (Vec<Placed>, usize) {
    struct Anchor {
        from: Option<Marker>,
        to: Option<Marker>,
        /// The anchor's own `xdr:ext` (a oneCellAnchor's size).
        ext: Option<(i64, i64)>,
        pics: Vec<Pic>,
        group: Option<GroupXfrm>,
    }
    let mut out = Vec::new();
    let mut unresolved = 0usize;
    let mut anchor: Option<Anchor> = None;
    let mut pic: Option<Pic> = None;
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut field: Option<&'static str> = None;
    let mut cur = Marker::default();

    let pair = |e: &BytesStart, a: &[u8], b: &[u8]| -> Option<(i64, i64)> {
        Some((attr(e, a)?.parse().ok()?, attr(e, b)?.parse().ok()?))
    };

    let mut r = Reader::from_str(xml);
    loop {
        let ev = r.read_event();
        match ev {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let empty = matches!(ev, Ok(Event::Empty(_)));
                let name = e.local_name().as_ref().to_vec();
                let parent = stack.last().map(|p| p.as_slice());
                let grandparent = if stack.len() >= 2 { Some(stack[stack.len() - 2].as_slice()) } else { None };
                match name.as_slice() {
                    b"twoCellAnchor" | b"oneCellAnchor" => {
                        anchor = Some(Anchor { from: None, to: None, ext: None, pics: Vec::new(), group: None });
                    }
                    // Pinned to the page, not to a cell: no row to belong to.
                    b"absoluteAnchor" => anchor = None,
                    b"from" | b"to" if anchor.is_some() => cur = Marker::default(),
                    b"col" | b"colOff" | b"row" | b"rowOff" if matches!(parent, Some(b"from") | Some(b"to")) => {
                        field = Some(match name.as_slice() {
                            b"col" => "col",
                            b"colOff" => "colOff",
                            b"row" => "row",
                            _ => "rowOff",
                        });
                    }
                    b"pic" if anchor.is_some() => pic = Some(Pic::default()),
                    b"ext" if matches!(parent, Some(b"twoCellAnchor") | Some(b"oneCellAnchor")) => {
                        if let Some(a) = anchor.as_mut() {
                            a.ext = pair(e, b"cx", b"cy");
                        }
                    }
                    b"off" | b"ext" | b"chOff" | b"chExt" if parent == Some(b"xfrm") => {
                        let v = if name.as_slice() == b"off" || name.as_slice() == b"chOff" {
                            pair(e, b"x", b"y")
                        } else {
                            pair(e, b"cx", b"cy")
                        };
                        match grandparent {
                            // The outermost group only; a group inside a group is rare enough
                            // to place by its outer box.
                            Some(b"grpSpPr") => {
                                if let Some(a) = anchor.as_mut() {
                                    let g = a.group.get_or_insert_with(GroupXfrm::default);
                                    match name.as_slice() {
                                        b"ext" if g.ext.is_none() => g.ext = v,
                                        b"chOff" if g.ch_off.is_none() => g.ch_off = v,
                                        b"chExt" if g.ch_ext.is_none() => g.ch_ext = v,
                                        _ => {}
                                    }
                                }
                            }
                            Some(b"spPr") => {
                                if let Some(p) = pic.as_mut() {
                                    match name.as_slice() {
                                        b"off" => p.off = v,
                                        b"ext" => p.ext = v,
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    b"blip" => {
                        if let (Some(a), Some(id)) = (anchor.as_mut(), attr(e, b"embed")) {
                            match rels.get(&id) {
                                Some((t, false)) => match pic.as_mut() {
                                    Some(p) => p.media = Some(t.clone()),
                                    // A shape filled with a picture: placed by its anchor.
                                    None => a.pics.push(Pic { media: Some(t.clone()), off: None, ext: None }),
                                },
                                _ => unresolved += 1,
                            }
                        }
                    }
                    _ => {}
                }
                if !empty {
                    stack.push(name);
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(f) = field {
                    let v: i64 = t.unescape().ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                    match f {
                        "col" => cur.col = v.max(0) as u32,
                        "colOff" => cur.col_off = v,
                        "row" => cur.row = v.max(0) as u32,
                        _ => cur.row_off = v,
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                stack.pop();
                match e.local_name().as_ref() {
                    b"col" | b"colOff" | b"row" | b"rowOff" => field = None,
                    b"from" => {
                        if let Some(a) = anchor.as_mut() {
                            a.from = Some(cur);
                        }
                    }
                    b"to" => {
                        if let Some(a) = anchor.as_mut() {
                            a.to = Some(cur);
                        }
                    }
                    b"pic" => {
                        if let (Some(a), Some(p)) = (anchor.as_mut(), pic.take()) {
                            if p.media.is_some() {
                                a.pics.push(p);
                            }
                        }
                    }
                    b"twoCellAnchor" | b"oneCellAnchor" => {
                        if let Some(a) = anchor.take() {
                            if let Some(from) = a.from {
                                let grouped = a.group.and_then(|g| Some((g.ext?, g.ch_off?, g.ch_ext?)));
                                for p in a.pics {
                                    let media = p.media.unwrap_or_default();
                                    let placed = match (grouped, p.off, p.ext) {
                                        // A picture inside a group: its own box, scaled from the
                                        // group's child space onto the sheet, from the group's corner.
                                        (Some((ge, co, ce)), Some(off), Some(ext)) if ce.0 > 0 && ce.1 > 0 => {
                                            let (sx, sy) = (ge.0 as f64 / ce.0 as f64, ge.1 as f64 / ce.1 as f64);
                                            let dx = (off.0 - co.0) as f64 * sx;
                                            let dy = (off.1 - co.1) as f64 * sy;
                                            let at = shift(s, from, dx, dy);
                                            let size = ((ext.0 as f64 * sx) as i64, (ext.1 as f64 * sy) as i64);
                                            place(s, at, None, Some(size), media)
                                        }
                                        _ => place(s, from, a.to, a.ext.or(p.ext), media),
                                    };
                                    out.push(placed);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (out, unresolved)
}

/// A marker moved right and down by some EMU, carried across column and row edges.
fn shift(s: &SheetImages, from: Marker, dx: f64, dy: f64) -> Marker {
    let mut m = from;
    let mut x = m.col_off as f64 + dx.max(0.0);
    while m.col < from.col + 64 && x >= s.col_width_px(m.col) * EMU_PER_PX {
        x -= s.col_width_px(m.col) * EMU_PER_PX;
        m.col += 1;
    }
    let mut y = m.row_off as f64 + dy.max(0.0);
    while m.row < from.row + 1024 && y >= s.row_px(m.row) * EMU_PER_PX {
        y -= s.row_px(m.row) * EMU_PER_PX;
        m.row += 1;
    }
    m.col_off = x as i64;
    m.row_off = y as i64;
    m
}

/// Size a picture and move it onto the row its middle falls on, so a photo that starts
/// a few pixels into the row above still travels with its own line.
fn place(s: &SheetImages, from: Marker, to: Option<Marker>, ext: Option<(i64, i64)>, media: String) -> Placed {
    let x = from.col_off as f64 / EMU_PER_PX;
    let y = from.row_off as f64 / EMU_PER_PX;
    let (w, h) = match (ext, to) {
        (Some((cx, cy)), _) if cx > 0 && cy > 0 => (cx as f64 / EMU_PER_PX, cy as f64 / EMU_PER_PX),
        (_, Some(t)) => {
            let mut w = -x + t.col_off as f64 / EMU_PER_PX;
            for c in from.col..t.col.min(from.col + 64) {
                w += s.col_width_px(c);
            }
            let mut h = -y + t.row_off as f64 / EMU_PER_PX;
            for r in from.row..t.row.min(from.row + 256) {
                h += s.row_px(r);
            }
            (w.max(1.0), h.max(1.0))
        }
        _ => (s.col_width_px(from.col), s.row_px(from.row)),
    };
    let mid = y + h / 2.0;
    let (mut row, mut top) = (from.row, 0.0);
    while row < from.row + 256 && mid > top + s.row_px(row) {
        top += s.row_px(row);
        row += 1;
    }
    Placed { media, row, col: from.col, x_px: x.max(0.0), y_px: (y - top).max(0.0), w_px: w, h_px: h }
}

/// The photo index for one sheet of the workbook at `path`. Anything that is not an
/// Open XML package returns an empty, unreadable index rather than an error.
pub fn read(path: &str, sheet: &str) -> SheetImages {
    let mut out = SheetImages::default();
    let Ok(file) = std::fs::File::open(path) else { return out };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return out };
    let names: HashMap<String, String> = zip.file_names().map(|n| (n.to_lowercase(), n.to_string())).collect();
    let Some(sheet_path) = sheet_part(&mut zip, &names, sheet) else { return out };
    let Some(xml) = part(&mut zip, &names, &sheet_path) else { return out };
    out.readable = true;
    let s = read_sheet(&xml, &mut out);
    drop(xml);
    read_in_cell(&mut zip, &names, &s.vm_cells, &mut out);
    if let Some(rid) = s.drawing_rid {
        let rels = relationships(&mut zip, &names, &sheet_path);
        if let Some((drawing, false)) = rels.get(&rid) {
            read_drawing(&mut zip, &names, &drawing.clone(), &mut out);
        }
    }
    out
}

/// The bytes of each named part, read once however many cells show the same picture.
pub fn media_bytes(path: &str, media: &[String]) -> Result<HashMap<String, Vec<u8>>> {
    let file = std::fs::File::open(path).context("open the manifest again to copy its photos")?;
    let mut zip = zip::ZipArchive::new(file).context("read the manifest's photos")?;
    let names: HashMap<String, String> = zip.file_names().map(|n| (n.to_lowercase(), n.to_string())).collect();
    let mut out = HashMap::new();
    for m in media {
        if out.contains_key(m) {
            continue;
        }
        let Some(real) = names.get(&m.to_lowercase()).cloned() else { continue };
        let Ok(mut f) = zip.by_name(&real) else { continue };
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
            out.insert(m.clone(), buf);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relationship_targets_resolve_against_their_part() {
        assert_eq!(resolve("xl/worksheets/sheet1.xml", "../drawings/drawing1.xml"), "xl/drawings/drawing1.xml");
        assert_eq!(resolve("xl/richData/richValueRel.xml", "../media/image1.png"), "xl/media/image1.png");
        assert_eq!(resolve("xl/workbook.xml", "worksheets/sheet2.xml"), "xl/worksheets/sheet2.xml");
        assert_eq!(resolve("xl/workbook.xml", "/xl/worksheets/sheet3.xml"), "xl/worksheets/sheet3.xml");
        assert_eq!(resolve("", "xl/workbook.xml"), "xl/workbook.xml");
        assert_eq!(rels_path("xl/worksheets/sheet1.xml"), "xl/worksheets/_rels/sheet1.xml.rels");
        assert_eq!(rels_path(""), "_rels/.rels");
    }

    #[test]
    fn cell_references_read_as_zero_based() {
        assert_eq!(cell_ref("A1"), Some((0, 0)));
        assert_eq!(cell_ref("B12"), Some((11, 1)));
        assert_eq!(cell_ref("AA3"), Some((2, 26)));
        assert_eq!(cell_ref("12"), None);
    }

    #[test]
    fn the_default_column_is_64_pixels() {
        assert_eq!(width_to_px(9.140625), 64.0);
    }

    #[test]
    fn pictures_in_one_group_each_keep_their_own_row() {
        // Two photos grouped under one anchor starting at row 2: the group is 20px wide and
        // 40px tall on the sheet, its children are laid out in a 100 x 200 space, and the
        // second photo sits in the lower half, so it belongs to row 3.
        let e = |px: f64| (px * EMU_PER_PX) as i64;
        let xml = format!(
            r#"<xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:r="r"><xdr:twoCellAnchor>
            <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
            <xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
            <xdr:grpSp><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{gw}" cy="{gh}"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="200"/></a:xfrm></xdr:grpSpPr>
              <xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></xdr:spPr></xdr:pic>
              <xdr:pic><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="100"/><a:ext cx="100" cy="100"/></a:xfrm></xdr:spPr></xdr:pic>
            </xdr:grpSp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>"#,
            gw = e(20.0),
            gh = e(40.0)
        );
        let rels: HashMap<String, (String, bool)> = [("rId1", "xl/media/a.png"), ("rId2", "xl/media/b.png")]
            .iter()
            .map(|(k, v)| (k.to_string(), (v.to_string(), false)))
            .collect();
        let s = SheetImages::default(); // 20px rows
        let (placed, missed) = parse_drawing(&xml, &rels, &s);
        assert_eq!(missed, 0);
        assert_eq!(placed.len(), 2);
        assert_eq!((placed[0].media.as_str(), placed[0].row), ("xl/media/a.png", 2));
        assert_eq!((placed[1].media.as_str(), placed[1].row), ("xl/media/b.png", 3));
        assert!((placed[1].h_px - 20.0).abs() < 0.5);
    }

    #[test]
    fn a_picture_starting_low_in_one_row_belongs_to_the_next() {
        let s = SheetImages::default(); // 20px rows
        // Starts 15px into row 3 and is 20px tall: its middle is in row 4.
        let from = Marker { col: 1, col_off: 0, row: 3, row_off: (15.0 * EMU_PER_PX) as i64 };
        let p = place(&s, from, None, Some(((20.0 * EMU_PER_PX) as i64, (20.0 * EMU_PER_PX) as i64)), "m".into());
        assert_eq!(p.row, 4);
        assert_eq!(p.y_px, 0.0);
        // Starts at the top of row 3: stays there.
        let from = Marker { col: 1, col_off: 0, row: 3, row_off: 0 };
        let p = place(&s, from, None, Some(((20.0 * EMU_PER_PX) as i64, (18.0 * EMU_PER_PX) as i64)), "m".into());
        assert_eq!(p.row, 3);
    }
}
