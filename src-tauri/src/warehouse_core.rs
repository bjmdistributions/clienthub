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
        let m = Move { id: "m".into(), at: String::new(), kind: "out".into(), lines, reference: String::new(), note: String::new(), undone: false };
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
}
