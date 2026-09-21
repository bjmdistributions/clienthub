//! Warehouse core (R-326, R-327, R-328) — the counting rules and the spreadsheet reader.
//!
//! BYTE-IDENTICAL in two places: BUSINESS APP `src-tauri/src/warehouse_core.rs` and
//! clienthub-api `src/routes/warehouse_core.rs`. It uses nothing from either crate (no
//! `use crate::`), so the desktop and the phone can never count a pick or read a sheet
//! differently. Edit one, copy it over, and run the tests in both repos.
//!
//! The model. A product has box sizes, declared once (`BoxType`: "Big Box" of 72). Each
//! section (a team) holds a count of whole boxes of each size, plus `loose` units — what is
//! left of a box that has been opened. A section's units are always
//! sum(count x per_box) + loose, so no stored total can disagree with the boxes.
//!
//! The one choosing rule, used wherever this file has to pick boxes by itself
//! (`take_units`): whole boxes largest first while one still fits, then loose units from a
//! box already open, then open the smallest box that covers what is left. The packer on
//! each client picks across sections with the same order of preference.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

pub const LOG_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoxType {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub per_box: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Section {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Whole boxes, by box type id.
    #[serde(default)]
    pub counts: BTreeMap<String, i64>,
    /// Units out of a full box.
    #[serde(default)]
    pub loose: i64,
    /// The R-326 shape (one box size per section). Read by `upgrade`, never written.
    #[serde(default, skip_serializing)]
    pub boxes: i64,
    #[serde(default, skip_serializing)]
    pub per_box: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MoveLine {
    pub section_id: String,
    pub name: String,
    /// Signed whole boxes moved, by box type id.
    #[serde(default, deserialize_with = "map_or_nothing")]
    pub boxes: BTreeMap<String, i64>,
    /// Signed loose units moved.
    #[serde(default)]
    pub loose: i64,
    /// Boxes opened to make up loose units (positive), or closed again by a put-back (negative).
    #[serde(default, deserialize_with = "map_or_nothing")]
    pub opened: BTreeMap<String, i64>,
    /// Signed total units the section changed by.
    #[serde(default)]
    pub units: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Move {
    pub id: String,
    pub at: String,
    /// "out" | "in" | "count"
    pub kind: String,
    pub lines: Vec<MoveLine>,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub undone: bool,
    /// Boxes this move took off (negative) or put back on (positive) the map's pallets and
    /// shelf levels (R-340), so a put-back returns them to the same places.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub places: Vec<PlaceMove>,
}

/// One section's part of a move. Every field is optional and they apply in this order:
/// loose units put back, opened boxes closed, whole boxes moved, loose units taken (opening
/// boxes if needed), then `units` taken by the choosing rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Change {
    pub section_id: String,
    #[serde(default)]
    pub boxes: BTreeMap<String, i64>,
    #[serde(default)]
    pub loose: i64,
    /// Negative: take this many units, letting `take_units` choose the boxes.
    #[serde(default)]
    pub units: i64,
    /// Put opened boxes back together (a put-back of a move that opened them).
    #[serde(default)]
    pub close: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Short {
    pub name: String,
    /// Units asked for, and units there were.
    pub wanted: i64,
    pub taken: i64,
}

/// Tolerates the R-326 log shape, where `boxes` was a single number.
fn map_or_nothing<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, i64>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn per_of(types: &[BoxType], id: &str) -> i64 {
    types.iter().find(|t| t.id == id).map(|t| t.per_box.max(0)).unwrap_or(0)
}

pub fn units_of(types: &[BoxType], s: &Section) -> i64 {
    s.counts.iter().map(|(t, n)| n * per_of(types, t)).sum::<i64>() + s.loose
}

pub fn boxes_of(s: &Section) -> i64 {
    s.counts.values().sum()
}

fn size_label(name: &str, per: i64) -> String {
    let n = name.trim();
    if n.is_empty() { format!("Box of {per}") } else { n.to_string() }
}

/// Find the box type for (name, per_box), adding it if the product does not have it yet. A
/// size with no name of its own ("Box of 12") is the product's existing size of 12, whatever
/// that one is called.
pub fn type_for(types: &mut Vec<BoxType>, name: &str, per: i64) -> String {
    let label = size_label(name, per);
    if let Some(t) = types.iter().find(|t| t.per_box == per && t.name.eq_ignore_ascii_case(&label)) {
        return t.id.clone();
    }
    if label == size_label("", per) {
        if let Some(t) = types.iter().find(|t| t.per_box == per) {
            return t.id.clone();
        }
    }
    let id = new_id();
    types.push(BoxType { id: id.clone(), name: label, per_box: per });
    id
}

/// Convert R-326 sections (one size each) to box types, in place. Idempotent.
pub fn upgrade(types: &mut Vec<BoxType>, sections: &mut [Section]) {
    for s in sections.iter_mut() {
        if s.per_box > 0 && s.counts.is_empty() {
            let id = type_for(types, "", s.per_box);
            if s.boxes > 0 {
                s.counts.insert(id, s.boxes);
            }
        }
        s.boxes = 0;
        s.per_box = 0;
    }
}

fn sort_types(types: &mut [BoxType]) {
    types.sort_by(|a, b| b.per_box.cmp(&a.per_box).then_with(|| a.name.cmp(&b.name)));
}

/// Clean what a form or an import sent: trim names, give new rows ids, drop box sizes with
/// no size, drop counts for sizes that no longer exist, and refuse what cannot be counted.
pub fn clean(mut types: Vec<BoxType>, mut sections: Vec<Section>) -> Result<(Vec<BoxType>, Vec<Section>), String> {
    upgrade(&mut types, &mut sections);
    let mut out_types = Vec::new();
    for t in types {
        let name = t.name.trim().to_string();
        if t.per_box < 1 {
            if name.is_empty() { continue; }
            return Err(format!("Say how many units are in one {name}."));
        }
        let id = if t.id.trim().is_empty() { new_id() } else { t.id };
        out_types.push(BoxType { id, name: size_label(&name, t.per_box), per_box: t.per_box });
    }
    sort_types(&mut out_types);
    let mut out = Vec::new();
    for s in sections {
        let name = s.name.trim().to_string();
        let counts: BTreeMap<String, i64> = s
            .counts
            .into_iter()
            .filter(|(t, n)| *n > 0 && out_types.iter().any(|x| &x.id == t))
            .collect();
        let loose = s.loose.max(0);
        if name.is_empty() {
            if counts.is_empty() && loose == 0 { continue; }
            return Err("Every row with boxes needs a name.".into());
        }
        let id = if s.id.trim().is_empty() { new_id() } else { s.id };
        out.push(Section { id, name, counts, loose, boxes: 0, per_box: 0 });
    }
    Ok((out_types, out))
}

/// What changed between two versions of the sections, one line per section that moved.
/// A section that was removed counts as going to zero.
pub fn count_lines(types: &[BoxType], old: &[Section], new: &[Section]) -> Vec<MoveLine> {
    let mut lines = Vec::new();
    let empty = Section::default();
    for n in new {
        let o = old.iter().find(|o| o.id == n.id).unwrap_or(&empty);
        if let Some(l) = diff_line(types, o, n) {
            lines.push(l);
        }
    }
    for o in old {
        if !new.iter().any(|n| n.id == o.id) {
            let gone = Section { id: o.id.clone(), name: o.name.clone(), ..Default::default() };
            if let Some(l) = diff_line(types, o, &gone) {
                lines.push(l);
            }
        }
    }
    lines
}

fn diff_line(types: &[BoxType], o: &Section, n: &Section) -> Option<MoveLine> {
    let mut boxes = BTreeMap::new();
    for t in o.counts.keys().chain(n.counts.keys()) {
        let d = n.counts.get(t).copied().unwrap_or(0) - o.counts.get(t).copied().unwrap_or(0);
        if d != 0 {
            boxes.insert(t.clone(), d);
        }
    }
    let loose = n.loose - o.loose;
    if boxes.is_empty() && loose == 0 {
        return None;
    }
    Some(MoveLine {
        section_id: n.id.clone(),
        name: n.name.clone(),
        boxes,
        loose,
        opened: BTreeMap::new(),
        units: units_of(types, n) - units_of(types, o),
    })
}

/// Take `want` loose units: from the open box first, then by opening the smallest box that
/// covers what is left (the largest there is, again and again, if none does). Returns the
/// units taken and the boxes opened.
fn take_loose(types: &[BoxType], s: &mut Section, want: i64) -> (i64, BTreeMap<String, i64>) {
    let mut opened = BTreeMap::new();
    let from_loose = want.min(s.loose).max(0);
    s.loose -= from_loose;
    let mut need = want - from_loose;
    while need > 0 {
        let have: Vec<(&BoxType, i64)> = types
            .iter()
            .filter(|t| t.per_box > 0)
            .filter_map(|t| s.counts.get(&t.id).filter(|n| **n > 0).map(|n| (t, *n)))
            .collect();
        let pick = have
            .iter()
            .filter(|(t, _)| t.per_box >= need)
            .min_by_key(|(t, _)| t.per_box)
            .or_else(|| have.iter().max_by_key(|(t, _)| t.per_box));
        let Some((t, _)) = pick else { break };
        let (id, per) = (t.id.clone(), t.per_box);
        *s.counts.get_mut(&id).unwrap() -= 1;
        *opened.entry(id).or_insert(0) += 1;
        let got = need.min(per);
        s.loose += per - got;
        need -= got;
    }
    s.counts.retain(|_, n| *n > 0);
    (want - need, opened)
}

/// The choosing rule for "take N units from this section": whole boxes largest first while
/// one still fits, then loose units (opening a box if it has to). Returns the whole boxes
/// taken, the loose units taken, the boxes opened, and what could not be found.
pub fn take_units(types: &[BoxType], s: &mut Section, n: i64) -> (BTreeMap<String, i64>, i64, BTreeMap<String, i64>, i64) {
    let mut sizes: Vec<&BoxType> = types.iter().filter(|t| t.per_box > 0).collect();
    sizes.sort_by(|a, b| b.per_box.cmp(&a.per_box));
    let mut rem = n.max(0);
    let mut boxes = BTreeMap::new();
    for t in sizes {
        let have = s.counts.get(&t.id).copied().unwrap_or(0);
        let k = have.min(rem / t.per_box);
        if k > 0 {
            *s.counts.get_mut(&t.id).unwrap() -= k;
            boxes.insert(t.id.clone(), k);
            rem -= k * t.per_box;
        }
    }
    s.counts.retain(|_, n| *n > 0);
    let (got, opened) = take_loose(types, s, rem);
    (boxes, got, opened, rem - got)
}

/// Apply a set of changes to the sections. Nothing goes below zero: whatever a section could
/// not supply is taken as far as it goes and reported, in units.
pub fn apply_changes(types: &[BoxType], sections: &mut [Section], changes: &[Change]) -> Result<(Vec<MoveLine>, Vec<Short>), String> {
    let mut lines = Vec::new();
    let mut short = Vec::new();
    for c in changes {
        let s = sections
            .iter_mut()
            .find(|s| s.id == c.section_id)
            .ok_or_else(|| "A section on this pick is no longer on the product. Plan it again.".to_string())?;
        for t in c.boxes.keys().chain(c.close.keys()) {
            if per_of(types, t) < 1 {
                return Err(format!("A box size on this pick for {} is no longer on the product. Plan it again.", s.name));
            }
        }
        let before = units_of(types, s);
        let mut wanted_out = 0i64;
        let mut moved = BTreeMap::new();
        let mut opened: BTreeMap<String, i64> = BTreeMap::new();
        let mut loose_moved = 0i64;
        // 1. Loose units put back.
        if c.loose > 0 {
            s.loose += c.loose;
            loose_moved += c.loose;
        }
        // 2. Opened boxes closed again.
        for (t, n) in &c.close {
            let per = per_of(types, t);
            let k = (*n).max(0).min(s.loose / per);
            if k > 0 {
                s.loose -= k * per;
                *s.counts.entry(t.clone()).or_insert(0) += k;
                *opened.entry(t.clone()).or_insert(0) -= k;
            }
        }
        // 3. Whole boxes.
        for (t, d) in &c.boxes {
            let have = s.counts.get(t).copied().unwrap_or(0);
            let applied = if *d < 0 { -((-d).min(have)) } else { *d };
            if *d < 0 {
                wanted_out += -d * per_of(types, t);
            }
            if applied != 0 {
                *s.counts.entry(t.clone()).or_insert(0) += applied;
                *moved.entry(t.clone()).or_insert(0) += applied;
            }
        }
        // 4. Loose units taken.
        if c.loose < 0 {
            wanted_out += -c.loose;
            let (got, op) = take_loose(types, s, -c.loose);
            loose_moved -= got;
            for (t, n) in op {
                *opened.entry(t).or_insert(0) += n;
            }
        }
        // 5. Units by the choosing rule.
        if c.units < 0 {
            wanted_out += -c.units;
            let (b, got, op, _) = take_units(types, s, -c.units);
            for (t, n) in b {
                *moved.entry(t).or_insert(0) -= n;
            }
            loose_moved -= got;
            for (t, n) in op {
                *opened.entry(t).or_insert(0) += n;
            }
        }
        s.counts.retain(|_, n| *n > 0);
        moved.retain(|_, n| *n != 0);
        opened.retain(|_, n| *n != 0);
        let units = units_of(types, s) - before;
        if wanted_out > 0 && -units < wanted_out && c.loose <= 0 && c.close.is_empty() {
            short.push(Short { name: s.name.clone(), wanted: wanted_out, taken: (-units).max(0) });
        }
        if moved.is_empty() && loose_moved == 0 && opened.is_empty() {
            continue;
        }
        lines.push(MoveLine { section_id: s.id.clone(), name: s.name.clone(), boxes: moved, loose: loose_moved, opened, units });
    }
    Ok((lines, short))
}

pub fn kind_of(lines: &[MoveLine]) -> &'static str {
    if lines.iter().all(|l| l.units < 0) {
        "out"
    } else if lines.iter().all(|l| l.units > 0) {
        "in"
    } else {
        "count"
    }
}

/// The changes that undo a move: whole boxes and loose units back, opened boxes closed.
pub fn undo_changes(m: &Move) -> Vec<Change> {
    m.lines
        .iter()
        .map(|l| Change {
            section_id: l.section_id.clone(),
            boxes: l.boxes.iter().map(|(t, n)| (t.clone(), -n)).collect(),
            loose: -l.loose,
            units: 0,
            close: l.opened.iter().filter(|(_, n)| **n > 0).map(|(t, n)| (t.clone(), *n)).collect(),
        })
        .collect()
}

pub fn push_log(log: &mut Vec<Move>, m: Move) {
    log.insert(0, m);
    log.truncate(LOG_CAP);
}

// ---------------------------------------------------------------------------------------
// Reading a spreadsheet (R-328)
// ---------------------------------------------------------------------------------------

/// Which column is what. Columns are 0-based; rows at or above `header_row` are ignored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Mapping {
    #[serde(default)]
    pub header_row: usize,
    /// "rows": a row per section, or per section and box size (a blank section name
    /// carries the one above). "grouped": a heading row per section, its box sizes on the
    /// rows under it. "across": a row per section, a column per box size.
    #[serde(default)]
    pub layout: String,
    #[serde(default)]
    pub team_col: Option<usize>,
    #[serde(default)]
    pub size_col: Option<usize>,
    #[serde(default)]
    pub boxes_col: Option<usize>,
    #[serde(default)]
    pub per_box_col: Option<usize>,
    #[serde(default)]
    pub units_col: Option<usize>,
    /// "across" only: the columns that are box sizes.
    #[serde(default)]
    pub size_cols: Vec<SizeCol>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SizeCol {
    pub col: usize,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub per_box: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ImportResult {
    pub box_types: Vec<BoxType>,
    pub sections: Vec<Section>,
    pub warnings: Vec<String>,
    pub rows_used: usize,
    pub rows_skipped: usize,
}

fn cell(rows: &[Vec<String>], r: usize, c: Option<usize>) -> String {
    c.and_then(|c| rows.get(r).and_then(|row| row.get(c))).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// "1,234", "$12", "12.0", " 7 " -> a number. Blank or words -> None.
pub fn num(s: &str) -> Option<i64> {
    let t: String = s.chars().filter(|c| !matches!(c, ',' | '$' | ' ')).collect();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f.round() as i64)
}

fn is_total(name: &str) -> bool {
    let l = name.trim().to_lowercase();
    l.starts_with("total") || l.starts_with("grand total") || l == "sum" || l == "totals"
}

fn has(h: &str, words: &[&str]) -> bool {
    words.iter().any(|w| h.contains(w))
}

fn is_per_header(h: &str) -> bool {
    has(h, &["per box", "per case", "per carton", "per ctn", "qty per", "units per", "pcs per", "per pack", "pack size", "case pack", "casepack", "inner", "per bx"])
}

fn is_boxes_header(h: &str) -> bool {
    !is_per_header(h) && has(h, &["box", "carton", "case", "ctn"]) && !has(h, &["size", "type", "kind"])
}

fn is_units_header(h: &str) -> bool {
    !is_per_header(h) && !is_boxes_header(h) && has(h, &["total", "unit", "qty", "quantity", "pcs", "pieces", "each", "hats", "count"])
}

fn is_size_header(h: &str) -> bool {
    !is_per_header(h) && has(h, &["box type", "box size", "carton type", "carton size", "packaging", "pack type", "size", "type"])
}

fn is_team_header(h: &str) -> bool {
    has(h, &["team", "name", "style", "color", "colour", "description", "item", "product", "sku", "model", "section", "variant"])
}

fn header_score(row: &[String]) -> i32 {
    row.iter()
        .map(|c| {
            let h = c.trim().to_lowercase();
            if h.is_empty() || num(&h).is_some() {
                0
            } else if is_per_header(&h) || is_team_header(&h) {
                3
            } else if is_boxes_header(&h) {
                2
            } else if is_units_header(&h) || is_size_header(&h) {
                1
            } else {
                0
            }
        })
        .sum()
}

/// A first guess at the mapping, for the person to correct. Never trusted blind: the screen
/// shows the preview it produces before anything is saved.
pub fn guess_mapping(rows: &[Vec<String>]) -> Mapping {
    let scan = rows.len().min(30);
    let header_row = (0..scan).max_by_key(|&r| (header_score(&rows[r]), -(r as i64))).unwrap_or(0);
    let headers: Vec<String> = rows.get(header_row).map(|r| r.iter().map(|c| c.trim().to_lowercase()).collect()).unwrap_or_default();
    let find = |f: &dyn Fn(&str) -> bool, taken: &[Option<usize>]| {
        headers.iter().position(|h| !h.is_empty() && f(h)).filter(|c| !taken.contains(&Some(*c)))
    };
    let per_box_col = find(&is_per_header, &[]);
    let boxes_col = find(&is_boxes_header, &[per_box_col]);
    let units_col = find(&is_units_header, &[per_box_col, boxes_col]);
    let mut team_col = find(&is_team_header, &[per_box_col, boxes_col, units_col]);
    if team_col.is_none() {
        // The first column holding mostly words under the header.
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        team_col = (0..width).find(|&c| {
            let vals: Vec<String> = (header_row + 1..rows.len()).map(|r| cell(rows, r, Some(c))).filter(|v| !v.is_empty()).collect();
            !vals.is_empty() && vals.iter().filter(|v| num(v).is_none()).count() * 2 > vals.len()
        });
    }
    let size_col = find(&is_size_header, &[per_box_col, boxes_col, units_col, team_col]);
    let mut m = Mapping { header_row, layout: "rows".into(), team_col, size_col, boxes_col, per_box_col, units_col, size_cols: vec![] };
    if looks_grouped(rows, &m) {
        m.layout = "grouped".into();
        m.size_col = None;
    }
    m
}

/// Heading rows (a name, no units per box) with box-size rows under them whose names repeat
/// from one heading to the next.
fn looks_grouped(rows: &[Vec<String>], m: &Mapping) -> bool {
    let (Some(_), Some(_)) = (m.team_col, m.per_box_col) else { return false };
    let mut headings = 0;
    let mut size_names: BTreeMap<String, usize> = BTreeMap::new();
    for r in m.header_row + 1..rows.len() {
        let name = cell(rows, r, m.team_col);
        if name.is_empty() || is_total(&name) {
            continue;
        }
        if num(&cell(rows, r, m.per_box_col)).filter(|p| *p > 0).is_some() {
            *size_names.entry(name.to_lowercase()).or_insert(0) += 1;
        } else {
            headings += 1;
        }
    }
    headings >= 2 && size_names.values().any(|n| *n >= 2)
}

#[derive(Default)]
struct Acc {
    types: Vec<BoxType>,
    sections: Vec<Section>,
    warnings: Vec<String>,
    used: usize,
    skipped: usize,
}

impl Acc {
    fn section(&mut self, name: &str) -> usize {
        if let Some(i) = self.sections.iter().position(|s| s.name.eq_ignore_ascii_case(name)) {
            return i;
        }
        self.sections.push(Section { name: name.to_string(), ..Default::default() });
        self.sections.len() - 1
    }

    fn add_boxes(&mut self, team: &str, size: &str, per: i64, boxes: i64) {
        let i = self.section(team);
        if boxes > 0 {
            let id = type_for(&mut self.types, size, per);
            *self.sections[i].counts.entry(id).or_insert(0) += boxes;
        }
    }

    fn add_loose(&mut self, team: &str, units: i64) {
        let i = self.section(team);
        self.sections[i].loose += units.max(0);
    }
}

/// Read the rows with a mapping. Box sizes are matched by name and size, sections by name
/// (so a team split over several rows adds up), and every row that could not be read is
/// counted and, where it matters, named in a warning.
pub fn apply_mapping(rows: &[Vec<String>], m: &Mapping) -> ImportResult {
    let mut a = Acc::default();
    let data = m.header_row + 1..rows.len();
    match m.layout.as_str() {
        "grouped" => {
            let mut team = String::new();
            let mut heading_boxes: Option<i64> = None;
            let mut child_boxes = 0i64;
            let check = |a: &mut Acc, team: &str, hb: Option<i64>, cb: i64| {
                if let Some(h) = hb {
                    if !team.is_empty() && h != cb {
                        a.warnings.push(format!("{team}: the heading says {h} boxes, the rows under it add up to {cb}."));
                    }
                }
            };
            for r in data {
                let name = cell(rows, r, m.team_col);
                if name.is_empty() || is_total(&name) {
                    a.skipped += 1;
                    continue;
                }
                match num(&cell(rows, r, m.per_box_col)).filter(|p| *p > 0) {
                    None => {
                        check(&mut a, &team, heading_boxes, child_boxes);
                        team = name;
                        heading_boxes = num(&cell(rows, r, m.boxes_col));
                        child_boxes = 0;
                        a.section(&team);
                        a.used += 1;
                    }
                    Some(per) => {
                        if team.is_empty() {
                            a.skipped += 1;
                            continue;
                        }
                        let size = m.size_col.map(|c| cell(rows, r, Some(c))).filter(|s| !s.is_empty()).unwrap_or(name);
                        let boxes = num(&cell(rows, r, m.boxes_col))
                            .or_else(|| num(&cell(rows, r, m.units_col)).map(|u| u / per))
                            .unwrap_or(0);
                        a.add_boxes(&team, &size, per, boxes);
                        child_boxes += boxes.max(0);
                        a.used += 1;
                    }
                }
            }
            check(&mut a, &team, heading_boxes, child_boxes);
        }
        "across" => {
            for r in data {
                let team = cell(rows, r, m.team_col);
                if team.is_empty() || is_total(&team) {
                    a.skipped += 1;
                    continue;
                }
                let mut any = false;
                for sc in &m.size_cols {
                    let n = num(&cell(rows, r, Some(sc.col))).unwrap_or(0);
                    if n > 0 && sc.per_box < 1 {
                        a.warnings.push(format!("Column {} has no units per box, so it was left out.", col_name(sc.col)));
                        continue;
                    }
                    if n > 0 {
                        let size = if sc.name.trim().is_empty() { cell(rows, m.header_row, Some(sc.col)) } else { sc.name.clone() };
                        a.add_boxes(&team, &size, sc.per_box, n);
                        any = true;
                    }
                }
                if any { a.used += 1; } else { a.section(&team); a.skipped += 1; }
            }
            a.warnings.dedup();
        }
        _ => {
            let mut last_team = String::new();
            for r in data {
                let mut team = cell(rows, r, m.team_col);
                let boxes = num(&cell(rows, r, m.boxes_col));
                let per = num(&cell(rows, r, m.per_box_col)).filter(|p| *p > 0);
                let units = num(&cell(rows, r, m.units_col));
                if team.is_empty() && (boxes.is_some() || units.is_some()) {
                    team = last_team.clone();
                }
                if team.is_empty() || is_total(&team) || (boxes.is_none() && units.is_none()) {
                    a.skipped += 1;
                    continue;
                }
                last_team = team.clone();
                let size = cell(rows, r, m.size_col);
                match (boxes, per, units) {
                    (Some(b), Some(p), _) => a.add_boxes(&team, &size, p, b),
                    (Some(b), None, Some(u)) if b > 0 && u % b == 0 => a.add_boxes(&team, &size, u / b, b),
                    (None, Some(p), Some(u)) => {
                        a.add_boxes(&team, &size, p, u / p);
                        a.add_loose(&team, u % p);
                    }
                    (_, _, Some(u)) => a.add_loose(&team, u),
                    _ => {
                        a.warnings.push(format!("{team}: {} boxes but no units per box, so they were left out.", boxes.unwrap_or(0)));
                        a.skipped += 1;
                        continue;
                    }
                }
                a.used += 1;
            }
        }
    }
    sort_types(&mut a.types);
    ImportResult { box_types: a.types, sections: a.sections, warnings: a.warnings, rows_used: a.used, rows_skipped: a.skipped }
}

/// "A", "B", ... "AA" — how a person names a column.
pub fn col_name(c: usize) -> String {
    let mut n = c + 1;
    let mut s = String::new();
    while n > 0 {
        let r = (n - 1) % 26;
        s.insert(0, (b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    s
}

/// Fold an import into a product. "replace": the sheet's sections take the counts in the
/// sheet (sections the sheet does not mention keep theirs). "add": the sheet's counts are
/// added on top. Box sizes are matched by name and size; new ones are added.
pub fn merge_import(types: &mut Vec<BoxType>, sections: &mut Vec<Section>, imp: &ImportResult, add: bool) {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for t in &imp.box_types {
        map.insert(t.id.clone(), type_for(types, &t.name, t.per_box));
    }
    for s in &imp.sections {
        let counts: BTreeMap<String, i64> = s.counts.iter().filter_map(|(t, n)| map.get(t).map(|id| (id.clone(), *n))).collect();
        match sections.iter_mut().find(|x| x.name.eq_ignore_ascii_case(&s.name)) {
            Some(x) if add => {
                for (t, n) in counts {
                    *x.counts.entry(t).or_insert(0) += n;
                }
                x.loose += s.loose;
            }
            Some(x) => {
                x.counts = counts;
                x.loose = s.loose;
            }
            None => sections.push(Section { id: String::new(), name: s.name.clone(), counts, loose: s.loose, boxes: 0, per_box: 0 }),
        }
    }
    sort_types(types);
}

// ---------------------------------------------------------------------------------------
// The warehouse map (R-330)
// ---------------------------------------------------------------------------------------

/// The biggest map either side draws — a floor of 60 by 60 pallet spots, or 60 bays of 60
/// shelves. Well past a real building; it keeps a typo from drawing 90,000 cells.
pub const MAP_MAX: i64 = 60;

/// One spot on a map: a pallet position on a floor, or a shelf in a bay. Only spots that say
/// something are stored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LayoutCell {
    pub r: i64,
    pub c: i64,
    /// What sits here, when it is one of the warehouse's products and sections.
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub section_id: String,
    /// Free text, for anything that is not (or not yet) a counted product.
    #[serde(default)]
    pub label: String,
    /// How full, in quarters: 0 empty .. 4 full.
    #[serde(default)]
    pub fill: i64,
    #[serde(default)]
    pub note: String,
    /// Not a spot at all — an aisle, a door, a post.
    #[serde(default)]
    pub aisle: bool,
}

/// The most levels a shelf standing on a floor map holds (R-333).
pub const SHELF_MAX: usize = 10;

/// A door in one of a floor map's four walls (R-332). `side` is the wall — "top" (the row A
/// side), "bottom" (the last row's side), "left" (spot 1's end), "right" (the far end); `at` is
/// the first spot (top/bottom) or row (left/right) it spans, `width` how many.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Door {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub width: i64,
    /// "garage", "dock" or "door" (a walk-in door).
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
}

/// One level of a shelf on a floor map, bottom level first — the same "what and how full" a
/// pallet spot says.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ShelfLevel {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub section_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub fill: i64,
}

/// A shelf unit standing on a pallet floor, in place of a pallet spot (R-333).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FloorShelf {
    #[serde(default)]
    pub levels: Vec<ShelfLevel>,
    #[serde(default)]
    pub note: String,
}

/// Everything about a map beyond its spots (R-332, R-333), in its own column so a client that
/// predates it can save the spots without wiping any of it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LayoutShape {
    /// Spots in each row, top row first (pallets in a row; bays on a level of shelving). Empty
    /// means every row is `cols` long — how every map before R-332 reads.
    #[serde(default)]
    pub row_lengths: Vec<i64>,
    /// A title per row ("Back wall"), shown beside its letter. Empty = none.
    #[serde(default)]
    pub row_names: Vec<String>,
    #[serde(default)]
    pub doors: Vec<Door>,
    /// A short name for what a spot holds, by the spot's key (lib/warehouse.ts cellKey) —
    /// shown on the map in place of the full name.
    #[serde(default)]
    pub short_names: BTreeMap<String, String>,
    /// Shelves standing on a pallet floor, by spot ("row:col").
    #[serde(default)]
    pub shelves: BTreeMap<String, FloorShelf>,
}

/// A map after cleaning.
#[derive(Debug, Clone, PartialEq)]
pub struct CleanLayout {
    pub kind: String,
    pub rows: i64,
    pub cols: i64,
    pub cells: Vec<LayoutCell>,
    pub shape: LayoutShape,
}

fn cut(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect::<String>().trim().to_string()
}

fn spot_key(k: &str) -> Option<(i64, i64)> {
    let (r, c) = k.split_once(':')?;
    Some((r.trim().parse().ok()?, c.trim().parse().ok()?))
}

/// Clean a map as drawn: "pallets" or "shelving", a size inside MAP_MAX, rows of their own
/// lengths, and only the spots that say something — one per position, inside its row (a map
/// that shrinks drops what fell off its edge). Doors are kept inside their wall and never
/// overlap; shelves stand only on a pallet floor, and a shelf's spot holds nothing else.
pub fn clean_layout(kind: &str, rows: i64, cols: i64, cells: Vec<LayoutCell>, shape: LayoutShape) -> Result<CleanLayout, String> {
    let kind = if kind == "shelving" { "shelving" } else { "pallets" };
    let floor = kind == "pallets";
    if rows < 1 {
        return Err("A map needs at least one row and one column.".into());
    }
    if rows > MAP_MAX {
        return Err(format!("A map can be at most {MAP_MAX} by {MAP_MAX}."));
    }
    // Row lengths: given per row, or every row `cols` long.
    let lengths: Vec<i64> = if shape.row_lengths.is_empty() {
        if cols < 1 {
            return Err("A map needs at least one row and one column.".into());
        }
        if cols > MAP_MAX {
            return Err(format!("A map can be at most {MAP_MAX} by {MAP_MAX}."));
        }
        vec![cols; rows as usize]
    } else {
        if shape.row_lengths.iter().any(|&n| n > MAP_MAX) {
            return Err(format!("A row can hold at most {MAP_MAX} spots."));
        }
        let last = *shape.row_lengths.last().unwrap_or(&cols);
        (0..rows as usize).map(|i| shape.row_lengths.get(i).copied().unwrap_or(last).clamp(0, MAP_MAX)).collect()
    };
    let cols = lengths.iter().copied().max().unwrap_or(0);
    if cols < 1 {
        return Err("A map needs at least one spot.".into());
    }
    let inside = |r: i64, c: i64| r >= 0 && c >= 0 && r < rows && c < lengths[r as usize];

    // Shelves on the floor.
    let mut shelves: BTreeMap<String, FloorShelf> = BTreeMap::new();
    if floor {
        for (k, mut sh) in shape.shelves {
            let Some((r, c)) = spot_key(&k) else { continue };
            if !inside(r, c) {
                continue;
            }
            sh.levels.truncate(SHELF_MAX);
            if sh.levels.is_empty() {
                sh.levels.push(ShelfLevel::default());
            }
            for l in sh.levels.iter_mut() {
                l.fill = l.fill.clamp(0, 4);
                l.label = cut(&l.label, 80);
                if l.section_id.is_empty() {
                    l.item_id.clear();
                }
            }
            sh.note = sh.note.trim().to_string();
            shelves.insert(format!("{r}:{c}"), sh);
        }
    }

    let mut out: Vec<LayoutCell> = Vec::new();
    for mut c in cells {
        if !inside(c.r, c.c) || shelves.contains_key(&format!("{}:{}", c.r, c.c)) {
            continue;
        }
        c.fill = c.fill.clamp(0, 4);
        c.label = c.label.trim().to_string();
        c.note = c.note.trim().to_string();
        if c.aisle {
            c.item_id.clear();
            c.section_id.clear();
            c.label.clear();
            c.fill = 0;
        }
        if c.section_id.is_empty() {
            c.item_id.clear();
        }
        let says_nothing = !c.aisle && c.section_id.is_empty() && c.label.is_empty() && c.fill == 0 && c.note.is_empty();
        if says_nothing {
            continue;
        }
        out.retain(|x| !(x.r == c.r && x.c == c.c));
        out.push(c);
    }
    out.sort_by_key(|c| (c.r, c.c));

    // Doors: a floor's walls only, inside the wall, never on top of each other.
    let mut doors: Vec<Door> = Vec::new();
    if floor {
        let rank = |side: &str| match side { "top" => 0, "right" => 1, "bottom" => 2, "left" => 3, _ => 9 };
        let mut given: Vec<Door> = shape.doors.into_iter().filter(|d| rank(&d.side) < 9).collect();
        given.sort_by(|a, b| (rank(&a.side), a.at).cmp(&(rank(&b.side), b.at)));
        for mut d in given {
            let wall = if d.side == "top" || d.side == "bottom" { cols } else { rows };
            d.at = d.at.clamp(0, wall - 1);
            d.width = d.width.clamp(1, wall - d.at);
            if !matches!(d.kind.as_str(), "garage" | "dock" | "door") {
                d.kind = "door".into();
            }
            d.label = cut(&d.label, 40);
            d.id = cut(&d.id, 64);
            if d.id.is_empty() {
                d.id = format!("door-{}-{}", d.side, d.at);
            }
            let clash = doors.iter().any(|o| o.id == d.id || (o.side == d.side && d.at < o.at + o.width && o.at < d.at + d.width));
            if !clash && doors.len() < 40 {
                doors.push(d);
            }
        }
    }

    // Row lengths are stored only when the rows differ; titles only when one is set.
    let row_lengths = if lengths.iter().all(|&n| n == cols) { Vec::new() } else { lengths };
    let mut row_names: Vec<String> = (0..rows as usize).map(|i| shape.row_names.get(i).map(|n| cut(n, 40)).unwrap_or_default()).collect();
    if row_names.iter().all(|n| n.is_empty()) {
        row_names.clear();
    }
    let short_names: BTreeMap<String, String> = shape.short_names.into_iter()
        .map(|(k, v)| (cut(&k, 200), cut(&v, 8)))
        .filter(|(k, v)| !k.is_empty() && !v.is_empty())
        .take(300)
        .collect();

    Ok(CleanLayout {
        kind: kind.into(),
        rows,
        cols,
        cells: out,
        shape: LayoutShape { row_lengths, row_names, doors, short_names, shelves },
    })
}

// ---------------------------------------------------------------------------------------
// Boxes on each place of a map (R-340): what is recorded on a pallet spot ("r:c") or a shelf
// level ("r:c:L") for the team marked there. Live: a move that takes boxes off a team takes
// them off its places too, fewest-first, and a put-back returns them. Kept in its own column
// (stock_json) and written place by place, never with a whole-map save, so a map edited on
// one device cannot put back boxes another device has already taken off.
// ---------------------------------------------------------------------------------------

/// The boxes recorded on one place, and the team they belong to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PlaceStock {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub section_id: String,
    #[serde(default)]
    pub boxes: BTreeMap<String, i64>,
}

/// Every place's boxes on one map, by place key.
pub type MapStock = BTreeMap<String, PlaceStock>;

/// Boxes a move took off (negative) or put back on (positive) one place of one map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PlaceMove {
    pub layout_id: String,
    pub place: String,
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub section_id: String,
    #[serde(default)]
    pub boxes: BTreeMap<String, i64>,
}

/// A place's key: a pallet spot "r:c", or level `l` (0 = bottom) of a shelf "r:c:l".
pub fn place_key(r: i64, c: i64, level: Option<usize>) -> String {
    match level {
        Some(l) => format!("{r}:{c}:{l}"),
        None => format!("{r}:{c}"),
    }
}

/// The places on a map that hold a team, in reading order: (key, item_id, section_id).
/// Aisles, labels and empty spots are not places; each level of a shelf is.
pub fn map_places(cells: &[LayoutCell], shape: &LayoutShape) -> Vec<(String, String, String)> {
    let mut out: Vec<((i64, i64, usize), String, String, String)> = Vec::new();
    for c in cells {
        if !c.aisle && !c.section_id.is_empty() && !shape.shelves.contains_key(&format!("{}:{}", c.r, c.c)) {
            out.push(((c.r, c.c, 0), place_key(c.r, c.c, None), c.item_id.clone(), c.section_id.clone()));
        }
    }
    for (k, sh) in &shape.shelves {
        let Some((r, c)) = spot_key(k) else { continue };
        for (i, lv) in sh.levels.iter().enumerate() {
            if !lv.section_id.is_empty() {
                out.push(((r, c, i + 1), place_key(r, c, Some(i)), lv.item_id.clone(), lv.section_id.clone()));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, k, i, s)| (k, i, s)).collect()
}

/// Keep only what still makes sense: places that exist and still hold the same team, and
/// whole positive box counts. A place with no boxes left stays — it was counted, and it is
/// empty — so the map can show it empty.
pub fn clean_stock(stock: MapStock, cells: &[LayoutCell], shape: &LayoutShape) -> MapStock {
    let places = map_places(cells, shape);
    let mut out = MapStock::new();
    for (k, mut ps) in stock {
        let holds = places.iter().any(|(pk, i, sid)| *pk == k && *i == ps.item_id && *sid == ps.section_id);
        if !holds {
            continue;
        }
        ps.boxes.retain(|t, n| !t.is_empty() && *n > 0);
        out.insert(k, ps);
    }
    out
}

/// Set what one place holds. Refused when the place does not hold that team.
pub fn set_place_stock(stock: &mut MapStock, cells: &[LayoutCell], shape: &LayoutShape, place: &str, item_id: &str, section_id: &str, boxes: BTreeMap<String, i64>) -> Result<(), String> {
    let holds = map_places(cells, shape).iter().any(|(k, i, s)| k == place && i == item_id && s == section_id);
    if !holds {
        return Err("That spot no longer holds that team — mark it on the map first.".into());
    }
    let boxes: BTreeMap<String, i64> = boxes.into_iter().filter(|(t, n)| !t.is_empty() && *n > 0).collect();
    stock.insert(place.to_string(), PlaceStock { item_id: item_id.into(), section_id: section_id.into(), boxes });
    Ok(())
}

/// Change what one place holds, size by size: `set` puts a size at a number, `add` moves it by
/// some — both against what is stored now, so an editor showing an older count never puts
/// back boxes a pick has since taken off. Sizes not named are left as they are.
pub fn change_place_stock(stock: &mut MapStock, cells: &[LayoutCell], shape: &LayoutShape, place: &str, item_id: &str, section_id: &str, set: &BTreeMap<String, i64>, add: &BTreeMap<String, i64>) -> Result<(), String> {
    let holds = map_places(cells, shape).iter().any(|(k, i, s)| k == place && i == item_id && s == section_id);
    if !holds {
        return Err("That spot no longer holds that team — mark it on the map first.".into());
    }
    let e = stock.entry(place.to_string()).or_insert_with(|| PlaceStock { item_id: item_id.into(), section_id: section_id.into(), boxes: BTreeMap::new() });
    if e.item_id != item_id || e.section_id != section_id {
        *e = PlaceStock { item_id: item_id.into(), section_id: section_id.into(), boxes: BTreeMap::new() };
    }
    for (t, n) in set.iter().filter(|(t, _)| !t.is_empty()) {
        if *n > 0 { e.boxes.insert(t.clone(), *n); } else { e.boxes.remove(t); }
    }
    for (t, d) in add.iter().filter(|(t, _)| !t.is_empty()) {
        let v = (e.boxes.get(t).copied().unwrap_or(0) + d).max(0);
        if v > 0 { e.boxes.insert(t.clone(), v); } else { e.boxes.remove(t); }
    }
    Ok(())
}

/// Which places a team's boxes come off: for each box type, the places holding it, fewest
/// first (a part pallet empties before a full one is broken into), then map order. `maps`
/// is every live map in order, as (layout_id, its stock, its places in reading order).
/// Boxes no place records come off nowhere — the team's count still drops.
pub fn take_from_places(maps: &[(String, MapStock, Vec<(String, String, String)>)], item_id: &str, section_id: &str, take: &BTreeMap<String, i64>) -> Vec<PlaceMove> {
    let mut out: Vec<PlaceMove> = Vec::new();
    for (tid, want) in take {
        let mut need = *want;
        if need <= 0 {
            continue;
        }
        let mut cands: Vec<(i64, usize, usize, &String, &String)> = Vec::new();
        for (mi, (lid, stock, places)) in maps.iter().enumerate() {
            for (pi, (k, i, s)) in places.iter().enumerate() {
                if i != item_id || s != section_id {
                    continue;
                }
                let have = stock.get(k).filter(|ps| ps.item_id == item_id && ps.section_id == section_id)
                    .and_then(|ps| ps.boxes.get(tid)).copied().unwrap_or(0);
                if have > 0 {
                    cands.push((have, mi, pi, lid, k));
                }
            }
        }
        cands.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
        for (have, _, _, lid, k) in cands {
            if need <= 0 {
                break;
            }
            let n = have.min(need);
            need -= n;
            match out.iter_mut().find(|m| &m.layout_id == lid && &m.place == k) {
                Some(m) => { m.boxes.insert(tid.clone(), -n); }
                None => {
                    let mut boxes = BTreeMap::new();
                    boxes.insert(tid.clone(), -n);
                    out.push(PlaceMove { layout_id: lid.clone(), place: k.clone(), item_id: item_id.into(), section_id: section_id.into(), boxes });
                }
            }
        }
    }
    out
}

/// Apply place moves to one map's stock. Boxes taken never go below zero, and a place taken
/// to nothing stays, empty; boxes put back land only on a place that still holds that team.
/// Returns what actually changed, so a move records only boxes that really came off (or went
/// back on) a place — and its put-back returns exactly those.
pub fn apply_place_moves(stock: &mut MapStock, cells: &[LayoutCell], shape: &LayoutShape, layout_id: &str, moves: &[PlaceMove]) -> Vec<PlaceMove> {
    let places = map_places(cells, shape);
    let mut applied: Vec<PlaceMove> = Vec::new();
    for m in moves.iter().filter(|m| m.layout_id == layout_id) {
        let holds = places.iter().any(|(k, i, s)| *k == m.place && *i == m.item_id && *s == m.section_id);
        if !holds {
            continue;
        }
        let e = stock.entry(m.place.clone()).or_insert_with(|| PlaceStock { item_id: m.item_id.clone(), section_id: m.section_id.clone(), boxes: BTreeMap::new() });
        if e.item_id != m.item_id || e.section_id != m.section_id {
            *e = PlaceStock { item_id: m.item_id.clone(), section_id: m.section_id.clone(), boxes: BTreeMap::new() };
        }
        let mut done: BTreeMap<String, i64> = BTreeMap::new();
        for (t, n) in &m.boxes {
            let was = e.boxes.get(t).copied().unwrap_or(0);
            let v = (was + n).max(0);
            if v > 0 { e.boxes.insert(t.clone(), v); } else { e.boxes.remove(t); }
            if v != was { done.insert(t.clone(), v - was); }
        }
        if !done.is_empty() {
            applied.push(PlaceMove { boxes: done, ..m.clone() });
        }
    }
    applied
}

/// Place moves a client named for a take (a grab from one pallet): always taking, never adding.
pub fn taking(moves: Vec<PlaceMove>) -> Vec<PlaceMove> {
    moves.into_iter().map(|m| PlaceMove { boxes: m.boxes.into_iter().filter(|(_, n)| *n != 0).map(|(t, n)| (t, -n.abs())).collect(), ..m }).filter(|m| !m.boxes.is_empty()).collect()
}

/// Boxes that left a team in a move — whole boxes taken plus boxes opened for loose units —
/// by section, as positive counts. What comes off the places.
pub fn boxes_out(lines: &[MoveLine]) -> Vec<(String, BTreeMap<String, i64>)> {
    lines.iter().filter_map(|l| {
        let mut m: BTreeMap<String, i64> = BTreeMap::new();
        for (t, n) in &l.boxes { if *n < 0 { *m.entry(t.clone()).or_insert(0) += -n; } }
        for (t, n) in &l.opened { if *n > 0 { *m.entry(t.clone()).or_insert(0) += n; } }
        if m.is_empty() { None } else { Some((l.section_id.clone(), m)) }
    }).collect()
}


#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, per: i64) -> BoxType {
        BoxType { id: id.into(), name: id.to_uppercase(), per_box: per }
    }
    fn s(id: &str, counts: &[(&str, i64)], loose: i64) -> Section {
        Section { id: id.into(), name: id.to_uppercase(), counts: counts.iter().map(|(k, v)| (k.to_string(), *v)).collect(), loose, boxes: 0, per_box: 0 }
    }
    fn sizes() -> Vec<BoxType> {
        vec![t("big", 72), t("sq", 48), t("rect", 36), t("small", 24), t("tiny", 12)]
    }
    fn rows(csv: &str) -> Vec<Vec<String>> {
        csv.lines().map(|l| l.split(',').map(|c| c.to_string()).collect()).collect()
    }

    #[test]
    fn a_section_counts_every_size_and_its_loose_units() {
        assert_eq!(units_of(&sizes(), &s("a", &[("big", 2), ("tiny", 3)], 5)), 144 + 36 + 5);
    }

    #[test]
    fn taking_units_uses_big_boxes_first_then_opens_the_smallest_that_covers() {
        let ty = sizes();
        let mut a = s("a", &[("big", 2), ("small", 3), ("tiny", 1)], 0);
        // 100 = 72 + 24, then 4 loose out of the 12 box.
        let (boxes, loose, opened, short) = take_units(&ty, &mut a, 100);
        assert_eq!(boxes, BTreeMap::from([("big".into(), 1), ("small".into(), 1)]));
        assert_eq!((loose, short), (4, 0));
        assert_eq!(opened, BTreeMap::from([("tiny".into(), 1)]));
        assert_eq!(a.loose, 8);
        assert_eq!(units_of(&ty, &a), 72 + 48 + 8);
    }

    #[test]
    fn a_pick_is_taken_as_far_as_it_goes_and_the_shortfall_is_in_units() {
        let ty = sizes();
        let mut secs = vec![s("a", &[("small", 2)], 0)];
        let (lines, short) = apply_changes(&ty, &mut secs, &[Change {
            section_id: "a".into(), boxes: BTreeMap::from([("small".into(), -3)]), ..Default::default()
        }]).unwrap();
        assert_eq!(secs[0].counts.get("small"), None);
        assert_eq!(lines[0].units, -48);
        assert_eq!(short, vec![Short { name: "A".into(), wanted: 72, taken: 48 }]);
        assert_eq!(kind_of(&lines), "out");
    }

    #[test]
    fn a_put_back_closes_the_box_it_opened() {
        let ty = sizes();
        let mut secs = vec![s("a", &[("small", 2)], 0)];
        let (lines, _) = apply_changes(&ty, &mut secs, &[Change { section_id: "a".into(), loose: -20, ..Default::default() }]).unwrap();
        assert_eq!((secs[0].counts.get("small").copied(), secs[0].loose), (Some(1), 4));
        let m = Move { id: "m".into(), at: String::new(), kind: "out".into(), lines, reference: String::new(), note: String::new(), undone: false, places: Vec::new() };
        apply_changes(&ty, &mut secs, &undo_changes(&m)).unwrap();
        assert_eq!((secs[0].counts.get("small").copied(), secs[0].loose), (Some(2), 0));
    }

    #[test]
    fn a_recount_is_one_line_per_section() {
        let ty = sizes();
        let old = vec![s("a", &[("big", 2)], 0), s("b", &[("tiny", 1)], 0)];
        let new = vec![s("a", &[("big", 1), ("sq", 1)], 3)];
        let lines = count_lines(&ty, &old, &new);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].boxes, BTreeMap::from([("big".into(), -1), ("sq".into(), 1)]));
        assert_eq!((lines[0].loose, lines[0].units), (3, -72 + 48 + 3));
        assert_eq!(lines[1].units, -12);
    }

    #[test]
    fn the_one_size_shape_is_upgraded_to_box_types() {
        let mut types = vec![];
        let mut secs = vec![Section { id: "a".into(), name: "A".into(), boxes: 5, per_box: 24, ..Default::default() }];
        upgrade(&mut types, &mut secs);
        assert_eq!(types.len(), 1);
        assert_eq!((types[0].per_box, types[0].name.as_str()), (24, "Box of 24"));
        assert_eq!(secs[0].counts.get(&types[0].id).copied(), Some(5));
        let old_log: Vec<Move> = serde_json::from_str(r#"[{"id":"m","at":"","kind":"out","lines":[{"section_id":"a","name":"A","boxes":-3,"units":-72}]}]"#).unwrap();
        assert_eq!(old_log[0].lines[0].units, -72);
    }

    #[test]
    fn clean_refuses_a_size_with_no_units_and_a_nameless_row_with_boxes() {
        assert!(clean(vec![BoxType { id: "".into(), name: "Crate".into(), per_box: 0 }], vec![]).is_err());
        assert!(clean(sizes(), vec![Section { counts: BTreeMap::from([("big".into(), 1)]), ..Default::default() }]).is_err());
        let (ty, secs) = clean(sizes(), vec![s("a", &[("big", 1), ("gone", 4), ("tiny", 0)], 0)]).unwrap();
        assert_eq!(ty[0].per_box, 72);
        assert_eq!(secs[0].counts.len(), 1);
    }

    // An invented sheet in the shape of a real one: a summary block, then team headings with
    // their box sizes on the rows beneath.
    const GROUPED: &str = "TOTAL BOXES,Big Box,Small Box,,\n\
        30,72,12,,\n\
        ,,,,\n\
        TEAM,BOXES QTY,QTY PER BOX,TOTAL UNITS,TOTAL BOXES FOR TEAM\n\
        OWLS,5,,,5\n\
        Big Box,2,72,144,\n\
        Small Box,3,12,36,\n\
        HAWKS,25,,,25\n\
        Big Box,20,72,1440,\n\
        Small Box,4,12,48,\n\
        TOTAL,30,,,";

    #[test]
    fn a_grouped_sheet_is_recognised_and_read() {
        let r = rows(GROUPED);
        let m = guess_mapping(&r);
        assert_eq!(m.header_row, 3);
        assert_eq!(m.layout, "grouped");
        assert_eq!((m.team_col, m.boxes_col, m.per_box_col, m.units_col), (Some(0), Some(1), Some(2), Some(3)));
        let out = apply_mapping(&r, &m);
        assert_eq!(out.box_types.iter().map(|t| (t.name.as_str(), t.per_box)).collect::<Vec<_>>(), vec![("Big Box", 72), ("Small Box", 12)]);
        assert_eq!(out.sections.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["OWLS", "HAWKS"]);
        assert_eq!(units_of(&out.box_types, &out.sections[0]), 180);
        assert_eq!(boxes_of(&out.sections[1]), 24);
        // The HAWKS heading says 25; the rows say 24.
        assert_eq!(out.warnings, vec!["HAWKS: the heading says 25 boxes, the rows under it add up to 24.".to_string()]);
    }

    #[test]
    fn a_row_per_team_and_size_carries_the_team_down() {
        let r = rows("Style,Carton type,Cartons,Units per carton\nRed,Large,4,50\n,Small,2,10\nBlue,Large,1,50\nTotal,,7,");
        let m = guess_mapping(&r);
        assert_eq!(m.layout, "rows");
        assert_eq!((m.team_col, m.size_col, m.boxes_col, m.per_box_col), (Some(0), Some(1), Some(2), Some(3)));
        let out = apply_mapping(&r, &m);
        assert_eq!(out.sections.len(), 2);
        assert_eq!(units_of(&out.box_types, &out.sections[0]), 220);
        assert_eq!(out.rows_used, 3);
    }

    #[test]
    fn units_with_a_box_size_are_boxes_and_loose() {
        let r = rows("Team,Pack size,Total units\nMets,24,100");
        let m = guess_mapping(&r);
        let out = apply_mapping(&r, &m);
        assert_eq!(boxes_of(&out.sections[0]), 4);
        assert_eq!(out.sections[0].loose, 4);
    }

    #[test]
    fn a_column_per_size_reads_across() {
        let r = rows("Team,Big (72),Small (12)\nMets,2,5\nCubs,,3");
        let m = Mapping {
            header_row: 0, layout: "across".into(), team_col: Some(0),
            size_cols: vec![SizeCol { col: 1, name: "".into(), per_box: 72 }, SizeCol { col: 2, name: "Small".into(), per_box: 12 }],
            ..Default::default()
        };
        let out = apply_mapping(&r, &m);
        assert_eq!(out.box_types[0].name, "Big (72)");
        assert_eq!(units_of(&out.box_types, &out.sections[0]), 144 + 60);
        assert_eq!(units_of(&out.box_types, &out.sections[1]), 36);
    }

    #[test]
    fn an_import_replaces_or_adds_by_name() {
        let mut types = vec![BoxType { id: "x".into(), name: "Big Box".into(), per_box: 72 }];
        let mut secs = vec![Section { id: "1".into(), name: "Owls".into(), counts: BTreeMap::from([("x".into(), 9)]), ..Default::default() }];
        let imp = apply_mapping(&rows(GROUPED), &guess_mapping(&rows(GROUPED)));
        merge_import(&mut types, &mut secs, &imp, false);
        assert_eq!(types.len(), 2);
        assert_eq!(secs[0].counts.get("x").copied(), Some(2));
        assert_eq!(secs.len(), 2);
        merge_import(&mut types, &mut secs, &imp, true);
        assert_eq!(secs[0].counts.get("x").copied(), Some(4));
    }

    #[test]
    fn column_names_read_like_a_spreadsheet() {
        assert_eq!((col_name(0), col_name(25), col_name(26)), ("A".to_string(), "Z".to_string(), "AA".to_string()));
    }

    #[test]
    fn a_map_keeps_only_spots_that_say_something_inside_its_edges() {
        let cell = |r, c, fill, label: &str| LayoutCell { r, c, fill, label: label.into(), ..Default::default() };
        let m = clean_layout("shelving", 3, 4, vec![
            cell(0, 0, 4, "Owls"),
            cell(0, 1, 0, ""),            // says nothing
            cell(5, 1, 2, "Off the edge"), // outside a 3-row map
            cell(1, 2, 9, "Hawks"),        // fill clamps to full
            cell(0, 0, 2, "Owls again"),   // the last word on a spot wins
            LayoutCell { r: 2, c: 3, aisle: true, label: "ignored".into(), fill: 3, ..Default::default() },
        ], LayoutShape::default()).unwrap();
        assert_eq!((m.kind.as_str(), m.rows, m.cols), ("shelving", 3, 4));
        assert_eq!(m.cells.len(), 3);
        assert_eq!((m.cells[0].label.as_str(), m.cells[0].fill), ("Owls again", 2));
        assert_eq!(m.cells[1].fill, 4);
        assert!(m.cells[2].aisle && m.cells[2].label.is_empty() && m.cells[2].fill == 0);
        assert_eq!(m.shape, LayoutShape::default());
        assert!(clean_layout("pallets", 0, 4, vec![], LayoutShape::default()).is_err());
        assert!(clean_layout("pallets", 61, 4, vec![], LayoutShape::default()).is_err());
        assert_eq!(clean_layout("anything", 1, 1, vec![], LayoutShape::default()).unwrap().kind, "pallets");
    }

    #[test]
    fn rows_of_their_own_lengths_doors_titles_and_shelves() {
        let cell = |r, c, label: &str| LayoutCell { r, c, fill: 4, label: label.into(), ..Default::default() };
        let door = |side: &str, at, width, kind: &str| Door { side: side.into(), at, width, kind: kind.into(), ..Default::default() };
        let mut shelves = BTreeMap::new();
        shelves.insert("1:0".to_string(), FloorShelf {
            levels: vec![ShelfLevel { label: "Owls".into(), fill: 7, ..Default::default() }, ShelfLevel { item_id: "stray".into(), ..Default::default() }],
            note: "  top level loose  ".into(),
        });
        shelves.insert("2:5".to_string(), FloorShelf::default()); // row 2 is 4 long: off the end
        shelves.insert("junk".to_string(), FloorShelf::default());
        let mut short = BTreeMap::new();
        short.insert("l:owls".to_string(), " OWLSVILLE ".to_string());
        short.insert("l:empty".to_string(), "  ".to_string());
        let m = clean_layout("pallets", 3, 99, vec![
            cell(0, 5, "Hawks"),  // row 0 is 6 long: kept
            cell(2, 4, "Bears"),  // row 2 is 4 long: dropped
            cell(1, 0, "Under the shelf"), // the shelf holds this spot: dropped
        ], LayoutShape {
            row_lengths: vec![6, 4],       // the third row, not given, takes the last length
            row_names: vec![" Back wall ".into()],
            doors: vec![door("top", 2, 2, "garage"), door("top", 3, 1, "door"), door("left", 9, 5, "hatch"), door("roof", 0, 1, "door")],
            short_names: short,
            shelves,
        }).unwrap();
        assert_eq!((m.rows, m.cols), (3, 6));
        assert_eq!(m.shape.row_lengths, vec![6, 4, 4]);
        assert_eq!(m.shape.row_names, vec!["Back wall".to_string(), String::new(), String::new()]);
        assert_eq!(m.cells.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), vec!["Hawks"]);
        // The overlapping door goes, the one past the wall is pulled inside it, an unknown kind is a door.
        assert_eq!(m.shape.doors.len(), 2);
        assert_eq!((m.shape.doors[0].side.as_str(), m.shape.doors[0].at, m.shape.doors[0].width, m.shape.doors[0].kind.as_str()), ("top", 2, 2, "garage"));
        assert_eq!((m.shape.doors[1].side.as_str(), m.shape.doors[1].at, m.shape.doors[1].width, m.shape.doors[1].kind.as_str()), ("left", 2, 1, "door"));
        assert_eq!(m.shape.doors[1].id, "door-left-2");
        assert_eq!(m.shape.short_names.len(), 1);
        assert_eq!(m.shape.short_names["l:owls"], "OWLSVILL");
        assert_eq!(m.shape.shelves.len(), 1);
        let sh = &m.shape.shelves["1:0"];
        assert_eq!((sh.levels[0].fill, sh.levels[1].item_id.as_str(), sh.note.as_str()), (4, "", "top level loose"));

        // Every row the same length again: stored as no lengths at all, like a map before R-332.
        let even = clean_layout("pallets", 2, 1, vec![], LayoutShape { row_lengths: vec![5, 5], ..Default::default() }).unwrap();
        assert_eq!((even.cols, even.shape.row_lengths.len()), (5, 0));
        // Shelving has no walls and no floor shelves.
        let rack = clean_layout("shelving", 2, 3, vec![], LayoutShape { doors: vec![door("top", 0, 1, "dock")], shelves: m.shape.shelves.clone(), ..Default::default() }).unwrap();
        assert!(rack.shape.doors.is_empty() && rack.shape.shelves.is_empty());
        assert!(clean_layout("pallets", 2, 4, vec![], LayoutShape { row_lengths: vec![0, 0], ..Default::default() }).is_err());
        assert!(clean_layout("pallets", 2, 4, vec![], LayoutShape { row_lengths: vec![61], ..Default::default() }).is_err());
    }

    #[test]
    fn boxes_come_off_part_pallets_first_and_go_back_where_they_came_from() {
        let cell = |r, c, sec: &str| LayoutCell { r, c, item_id: "w".into(), section_id: sec.into(), fill: 4, ..Default::default() };
        let cells = vec![cell(0, 0, "owls"), cell(0, 1, "owls"), cell(0, 2, "hawks"), LayoutCell { r: 1, c: 0, aisle: true, ..Default::default() }];
        let mut shelves = BTreeMap::new();
        shelves.insert("1:1".to_string(), FloorShelf { levels: vec![ShelfLevel { item_id: "w".into(), section_id: "owls".into(), fill: 2, ..Default::default() }, ShelfLevel::default()], note: String::new() });
        let shape = LayoutShape { shelves, ..Default::default() };
        let places = map_places(&cells, &shape);
        assert_eq!(places.iter().map(|p| p.0.as_str()).collect::<Vec<_>>(), vec!["0:0", "0:1", "0:2", "1:1:0"]);

        let b = |pairs: &[(&str, i64)]| pairs.iter().map(|(t, n)| (t.to_string(), *n)).collect::<BTreeMap<_, _>>();
        let mut stock = MapStock::new();
        set_place_stock(&mut stock, &cells, &shape, "0:0", "w", "owls", b(&[("big", 20)])).unwrap();
        set_place_stock(&mut stock, &cells, &shape, "0:1", "w", "owls", b(&[("big", 5), ("small", 3)])).unwrap();
        set_place_stock(&mut stock, &cells, &shape, "1:1:0", "w", "owls", b(&[("big", 2)])).unwrap();
        assert!(set_place_stock(&mut stock, &cells, &shape, "0:2", "w", "owls", b(&[("big", 1)])).is_err()); // a hawks pallet
        assert!(set_place_stock(&mut stock, &cells, &shape, "1:0", "w", "owls", b(&[("big", 1)])).is_err()); // an aisle

        // 9 big + 1 small: the shelf level's 2 go first, then the part pallet's 5, then 2 off the full one.
        let maps = vec![("floor".to_string(), stock.clone(), places.clone())];
        let moves = take_from_places(&maps, "w", "owls", &b(&[("big", 9), ("small", 1)]));
        let got: Vec<(String, BTreeMap<String, i64>)> = moves.iter().map(|m| (m.place.clone(), m.boxes.clone())).collect();
        assert_eq!(got, vec![
            ("1:1:0".to_string(), b(&[("big", -2)])),
            ("0:1".to_string(), b(&[("big", -5), ("small", -1)])),
            ("0:0".to_string(), b(&[("big", -2)])),
        ]);
        let applied = apply_place_moves(&mut stock, &cells, &shape, "floor", &moves);
        assert_eq!(applied, moves); // everything asked for was there
        assert_eq!(stock["0:0"].boxes, b(&[("big", 18)]));
        assert_eq!(stock["0:1"].boxes, b(&[("small", 2)]));
        assert!(stock["1:1:0"].boxes.is_empty()); // emptied, and still known to be empty

        // A put-back returns them to the same places.
        let back: Vec<PlaceMove> = moves.iter().map(|m| PlaceMove { boxes: m.boxes.iter().map(|(t, n)| (t.clone(), -n)).collect(), ..m.clone() }).collect();
        apply_place_moves(&mut stock, &cells, &shape, "floor", &back);
        assert_eq!(stock["0:0"].boxes, b(&[("big", 20)]));
        assert_eq!(stock["1:1:0"].boxes, b(&[("big", 2)]));

        // More than the places hold: they give what they have, the team still drops.
        let all = take_from_places(&[("floor".to_string(), stock.clone(), places.clone())], "w", "owls", &b(&[("big", 100)]));
        assert_eq!(all.iter().map(|m| -m.boxes["big"]).sum::<i64>(), 27);

        // Re-marking a pallet with another team drops its recorded boxes.
        let mut cells2 = cells.clone();
        cells2[0].section_id = "hawks".into();
        let cleaned = clean_stock(stock.clone(), &cells2, &shape);
        assert!(!cleaned.contains_key("0:0") && cleaned.contains_key("0:1"));

        // A grab named by the client takes, never adds, and records only what was there.
        let asked = taking(vec![PlaceMove { layout_id: "floor".into(), place: "1:1:0".into(), item_id: "w".into(), section_id: "owls".into(), boxes: b(&[("big", 5)]) }]);
        assert_eq!(asked[0].boxes, b(&[("big", -5)]));
        let got = apply_place_moves(&mut stock, &cells, &shape, "floor", &asked);
        assert_eq!(got[0].boxes, b(&[("big", -2)])); // the level held 2

        // An editor changes one size against what is stored now: a +1 made on an old screen after
        // a pick took 3 off leaves the pallet at (stored - 3) + 1, never back at the old count.
        let mut s2 = MapStock::new();
        set_place_stock(&mut s2, &cells, &shape, "0:0", "w", "owls", b(&[("big", 20), ("small", 4)])).unwrap();
        change_place_stock(&mut s2, &cells, &shape, "0:0", "w", "owls", &BTreeMap::new(), &b(&[("big", -3)])).unwrap(); // the pick
        change_place_stock(&mut s2, &cells, &shape, "0:0", "w", "owls", &BTreeMap::new(), &b(&[("big", 1)])).unwrap(); // the editor
        change_place_stock(&mut s2, &cells, &shape, "0:0", "w", "owls", &b(&[("small", 6)]), &BTreeMap::new()).unwrap(); // a typed size
        assert_eq!(s2["0:0"].boxes, b(&[("big", 18), ("small", 6)]));
        assert!(change_place_stock(&mut s2, &cells, &shape, "0:2", "w", "owls", &BTreeMap::new(), &b(&[("big", 1)])).is_err());

        // What left a team: whole boxes out plus boxes opened.
        let line = MoveLine { section_id: "owls".into(), name: "OWLS".into(), boxes: b(&[("big", -3), ("small", 1)]), loose: -5, opened: b(&[("small", 1)]), units: 0 };
        assert_eq!(boxes_out(&[line]), vec![("owls".to_string(), b(&[("big", 3), ("small", 1)]))]);
    }
}
