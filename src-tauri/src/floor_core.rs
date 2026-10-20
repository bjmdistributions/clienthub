//! The floor plan (R-550): the warehouse drawn to scale in feet, with its doors, its office and
//! any other rooms or shelving, and every delivery pallet standing where it really stands.
//!
//! BYTE-IDENTICAL in two places: BUSINESS APP `src-tauri/src/floor_core.rs` and clienthub-api
//! `src/routes/floor_core.rs`. It uses nothing from either crate (no `use crate::`), so the
//! desktop and the phone can never clean a building or keep a pallet inside the walls
//! differently. Edit one, copy it over, and run the tests in both repos.
//!
//! Coordinates are feet from the top-left corner of the building as drawn: x runs along the top
//! wall (the building's width), y down the left wall (its depth). A pallet stands at (x, y), its
//! top-left corner, and is 48 by 40 inches: 4 ft along x and 3 ft 4 in along y, or the other way
//! round when turned. Where a pallet stands is stored on its own row
//! (`warehouse_load_pallets.floor_id, x, y, turned`), so two phones moving two pallets never
//! overwrite each other. The building itself (its size, doors and rooms) is one
//! `warehouse_floors` row, with the doors and rooms in `shape_json`.
//!
//! `snap` is the rule the screens follow while a pallet or a room is dragged. The server never
//! calls it; it lives here so the desktop (`lib/floor.ts`) and the phone (`whf*` in app.js) copy
//! one tested rule instead of inventing two.

use serde::{Deserialize, Serialize};

/// A pallet's long side, 48 inches, in feet.
pub const PALLET_LONG: f64 = 4.0;
/// A pallet's short side, 40 inches, in feet.
pub const PALLET_SHORT: f64 = 40.0 / 12.0;
/// A building is 10 to 1,000 ft each way.
pub const SIZE_MIN: f64 = 10.0;
pub const SIZE_MAX: f64 = 1_000.0;
/// A door is 2 to 40 ft wide, and never wider than its wall.
pub const DOOR_MIN: f64 = 2.0;
pub const DOOR_MAX: f64 = 40.0;
/// A room or a run of shelving is at least 1 ft each way.
pub const AREA_MIN: f64 = 1.0;
pub const MAX_DOORS: usize = 40;
pub const MAX_AREAS: usize = 200;
pub const MAX_NAME: usize = 60;
pub const MAX_LABEL: usize = 24;
pub const MAX_ID: usize = 40;
/// An edge within this many feet of another edge (or a wall) is pulled onto it while dragging.
pub const SNAP_TOLERANCE: f64 = 0.5;
/// Off any edge, a drag lands on the nearest quarter foot (3 inches).
pub const SNAP_STEP: f64 = 0.25;

pub const SIDES: [&str; 4] = ["top", "bottom", "left", "right"];
pub const DOOR_KINDS: [&str; 3] = ["garage", "dock", "door"];
pub const AREA_KINDS: [&str; 3] = ["office", "shelf", "area"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Door {
    #[serde(default)]
    pub id: String,
    /// "top" | "bottom" | "left" | "right", as drawn: top is the wall along x at y = 0.
    #[serde(default)]
    pub side: String,
    /// Feet from the wall's start (the left end of the top and bottom walls, the top end of the
    /// left and right walls) to the door's near edge.
    #[serde(default)]
    pub at: f64,
    #[serde(default)]
    pub width: f64,
    /// "garage" | "dock" | "door".
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
}

/// A room or a run of shelving drawn on the floor: the office, a shelf, or any named area.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Area {
    #[serde(default)]
    pub id: String,
    /// "office" | "shelf" | "area".
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// Feet along x.
    #[serde(default)]
    pub w: f64,
    /// Feet along y.
    #[serde(default)]
    pub d: f64,
}

/// What `shape_json` holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FloorShape {
    #[serde(default)]
    pub doors: Vec<Door>,
    #[serde(default)]
    pub areas: Vec<Area>,
}

/// A building as stored, after `clean_floor`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CleanFloor {
    pub name: String,
    pub width: f64,
    pub depth: f64,
    pub shape: FloorShape,
}

/// One delivery pallet as the floor plan shows it: where it stands (when it is on a floor) and a
/// count of what is on it. Both runtimes fill it the same way: every pallet of every delivery
/// that is not removed, from `case_core::pallet_views`, joined with its row's position.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FloorPallet {
    /// The pallet's id, `pal-<load_id>-<number>`.
    pub id: String,
    pub load_id: String,
    pub load_name: String,
    pub number: i64,
    pub location: String,
    pub closed: bool,
    pub note: String,
    /// Empty when the pallet is on no floor plan yet.
    pub floor_id: String,
    pub x: f64,
    pub y: f64,
    pub turned: bool,
    pub boxes: usize,
    /// Pairs on the pallet with no box.
    pub loose: i64,
    pub pairs: i64,
    pub styles: usize,
}

/// A rectangle on the floor, in feet: top-left corner, then its size along x and y.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub d: f64,
}

/// Feet as stored: to the hundredth.
pub fn feet(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo {
        return lo;
    }
    v.max(lo).min(hi)
}

/// One line of text, trimmed, at most `max` characters.
fn one_line(s: &str, max: usize) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// An id as stored, or a made one when it is empty or already taken.
fn unique_id(id: &str, prefix: &str, i: usize, taken: &mut Vec<String>) -> String {
    let mut id: String = id.trim().chars().take(MAX_ID).collect();
    if id.is_empty() || taken.contains(&id) {
        let mut n = i + 1;
        id = format!("{prefix}-{n}");
        while taken.contains(&id) {
            n += 1;
            id = format!("{prefix}-{n}");
        }
    }
    taken.push(id.clone());
    id
}

/// How long a wall is: the top and bottom walls run the building's width, the sides its depth.
pub fn wall_length(width: f64, depth: f64, side: &str) -> f64 {
    if side == "left" || side == "right" { depth } else { width }
}

/// A pallet's size on the floor: (along x, along y).
pub fn footprint(turned: bool) -> (f64, f64) {
    if turned { (PALLET_SHORT, PALLET_LONG) } else { (PALLET_LONG, PALLET_SHORT) }
}

pub fn pallet_rect(x: f64, y: f64, turned: bool) -> Rect {
    let (w, d) = footprint(turned);
    Rect { x, y, w, d }
}

pub fn area_rect(a: &Area) -> Rect {
    Rect { x: a.x, y: a.y, w: a.w, d: a.d }
}

/// True when two rectangles share floor. Touching edges do not count, and neither does a sliver
/// thinner than a hundredth of a foot (what rounding to the hundredth can leave).
pub fn overlaps(a: Rect, b: Rect) -> bool {
    const E: f64 = 0.01;
    a.x < b.x + b.w - E && b.x < a.x + a.w - E && a.y < b.y + b.d - E && b.y < a.y + a.d - E
}

/// Clean a building as drawn, before it is stored. The size must be 10 to 1,000 ft each way (an
/// error otherwise). Doors keep to their wall: an unknown side is dropped, an unknown kind is a
/// door, the width is held to 2..40 ft and to the wall, the position to the wall, and a door that
/// would overlap an earlier door on the same wall is dropped. Rooms keep inside the walls: an
/// unknown kind is an area, the size is at least 1 ft and at most the building, the position is
/// pulled inside. Names and labels are one line; an empty office or shelf label reads "Office"
/// or "Shelving". Ids are kept when given and unique, otherwise made (`door-3`, `area-2`).
pub fn clean_floor(name: &str, width: f64, depth: f64, shape: FloorShape) -> Result<CleanFloor, String> {
    let ok = |v: f64| v.is_finite() && (SIZE_MIN..=SIZE_MAX).contains(&v);
    if !ok(width) || !ok(depth) {
        return Err("A building is 10 to 1,000 ft each way.".into());
    }
    let (width, depth) = (feet(width), feet(depth));
    let mut name = one_line(name, MAX_NAME);
    if name.is_empty() {
        name = "Warehouse".into();
    }

    let mut doors: Vec<Door> = Vec::new();
    let mut ids = Vec::new();
    for (i, d) in shape.doors.into_iter().enumerate() {
        if doors.len() >= MAX_DOORS {
            break;
        }
        if !SIDES.contains(&d.side.as_str()) || !d.at.is_finite() || !d.width.is_finite() {
            continue;
        }
        let wall = wall_length(width, depth, &d.side);
        let w = feet(clamp(d.width, DOOR_MIN, DOOR_MAX.min(wall)));
        let at = feet(clamp(d.at, 0.0, wall - w));
        if doors.iter().any(|o| o.side == d.side && at < o.at + o.width - 0.01 && o.at < at + w - 0.01) {
            continue;
        }
        let kind = if DOOR_KINDS.contains(&d.kind.as_str()) { d.kind } else { "door".into() };
        doors.push(Door {
            id: unique_id(&d.id, "door", i, &mut ids),
            side: d.side,
            at,
            width: w,
            kind,
            label: one_line(&d.label, MAX_LABEL),
        });
    }

    let mut areas: Vec<Area> = Vec::new();
    let mut ids = Vec::new();
    for (i, a) in shape.areas.into_iter().enumerate() {
        if areas.len() >= MAX_AREAS {
            break;
        }
        if ![a.x, a.y, a.w, a.d].iter().all(|v| v.is_finite()) {
            continue;
        }
        let kind = if AREA_KINDS.contains(&a.kind.as_str()) { a.kind } else { "area".into() };
        let mut label = one_line(&a.label, MAX_LABEL);
        if label.is_empty() {
            label = match kind.as_str() {
                "office" => "Office".into(),
                "shelf" => "Shelving".into(),
                _ => String::new(),
            };
        }
        let w = feet(clamp(a.w, AREA_MIN, width));
        let d = feet(clamp(a.d, AREA_MIN, depth));
        areas.push(Area {
            id: unique_id(&a.id, "area", i, &mut ids),
            kind,
            label,
            x: feet(clamp(a.x, 0.0, width - w)),
            y: feet(clamp(a.y, 0.0, depth - d)),
            w,
            d,
        });
    }

    Ok(CleanFloor { name, width, depth, shape: FloorShape { doors, areas } })
}

/// Where a pallet may stand: pulled inside the walls and stored to the hundredth of a foot.
/// Nothing else is refused: pallets may touch, and one may stand over another (stacked), because
/// the floor is a picture of the building, not a rule about it.
pub fn clean_spot(width: f64, depth: f64, x: f64, y: f64, turned: bool) -> Result<(f64, f64), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("That spot is not on the floor plan.".into());
    }
    let (w, d) = footprint(turned);
    Ok((feet(clamp(x, 0.0, width - w)), feet(clamp(y, 0.0, depth - d))))
}

/// The nearest edge within the tolerance, as the new start of a span of length `len` at `at`:
/// either its start or its end lands on the edge. None when no edge is that close.
fn snap_axis(at: f64, len: f64, edges: &[f64]) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for &e in edges {
        for cand in [e, e - len] {
            let dist = (cand - at).abs();
            if dist <= SNAP_TOLERANCE && best.map_or(true, |(bd, _)| dist < bd) {
                best = Some((dist, cand));
            }
        }
    }
    best.map(|(_, c)| c)
}

/// Where a dragged rectangle lands. Along each axis on its own: when its start or end is within
/// half a foot of a wall or of an edge of another rectangle (`others`: the other pallets and the
/// rooms), it is pulled onto the nearest such edge; otherwise it lands on the nearest quarter
/// foot. Then it is pulled inside the walls and stored to the hundredth. Edges count only from
/// rectangles that overlap it on the other axis, widened by the tolerance, so a pallet lines up
/// with its neighbours in a row, not with something across the building.
pub fn snap(width: f64, depth: f64, r: Rect, others: &[Rect]) -> Rect {
    let near_y = |o: &Rect| o.y < r.y + r.d + SNAP_TOLERANCE && r.y < o.y + o.d + SNAP_TOLERANCE;
    let near_x = |o: &Rect| o.x < r.x + r.w + SNAP_TOLERANCE && r.x < o.x + o.w + SNAP_TOLERANCE;
    let mut xs = vec![0.0, width];
    let mut ys = vec![0.0, depth];
    for o in others {
        if near_y(o) {
            xs.push(o.x);
            xs.push(o.x + o.w);
        }
        if near_x(o) {
            ys.push(o.y);
            ys.push(o.y + o.d);
        }
    }
    let step = |v: f64| (v / SNAP_STEP).round() * SNAP_STEP;
    let x = snap_axis(r.x, r.w, &xs).unwrap_or_else(|| step(r.x));
    let y = snap_axis(r.y, r.d, &ys).unwrap_or_else(|| step(r.y));
    Rect {
        x: feet(clamp(x, 0.0, width - r.w)),
        y: feet(clamp(y, 0.0, depth - r.d)),
        w: r.w,
        d: r.d,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn door(side: &str, at: f64, width: f64, kind: &str) -> Door {
        Door { id: String::new(), side: side.into(), at, width, kind: kind.into(), label: String::new() }
    }
    fn area(kind: &str, x: f64, y: f64, w: f64, d: f64) -> Area {
        Area { id: String::new(), kind: kind.into(), label: String::new(), x, y, w, d }
    }

    #[test]
    fn a_building_needs_a_real_size() {
        assert!(clean_floor("Main", 9.9, 50.0, FloorShape::default()).is_err());
        assert!(clean_floor("Main", 50.0, 1_000.5, FloorShape::default()).is_err());
        assert!(clean_floor("Main", f64::NAN, 50.0, FloorShape::default()).is_err());
        let f = clean_floor("  Main\n building ", 120.004, 80.0, FloorShape::default()).unwrap();
        assert_eq!((f.name.as_str(), f.width, f.depth), ("Main building", 120.0, 80.0));
        assert_eq!(clean_floor("", 10.0, 10.0, FloorShape::default()).unwrap().name, "Warehouse");
    }

    #[test]
    fn doors_keep_to_their_wall() {
        let f = clean_floor("W", 100.0, 60.0, FloorShape {
            doors: vec![
                door("top", 95.0, 12.0, "garage"),   // runs past the end: pulled back
                door("left", 10.0, 80.0, "dock"),    // wider than 40 ft: 40 ft, still at 10
                door("roof", 1.0, 3.0, "door"),      // no such wall: dropped
                door("top", 90.0, 3.0, "door"),      // overlaps the garage door: dropped
                door("bottom", -5.0, 1.0, "hatch"),  // before the start, too narrow, unknown kind
            ],
            areas: vec![],
        }).unwrap();
        let d = &f.shape.doors;
        assert_eq!(d.len(), 3);
        assert_eq!((d[0].side.as_str(), d[0].at, d[0].width, d[0].kind.as_str()), ("top", 88.0, 12.0, "garage"));
        assert_eq!((d[1].at, d[1].width), (10.0, 40.0));
        assert_eq!((d[2].side.as_str(), d[2].at, d[2].width, d[2].kind.as_str()), ("bottom", 0.0, 2.0, "door"));
        assert_eq!(d.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["door-1", "door-2", "door-5"]);
    }

    #[test]
    fn rooms_keep_inside_the_walls() {
        let mut office = area("office", 90.0, -3.0, 20.0, 12.0);
        office.id = "office".into();
        let mut dup = area("shelf", 0.0, 0.0, 0.2, 200.0);
        dup.id = "office".into();
        let f = clean_floor("W", 100.0, 60.0, FloorShape {
            doors: vec![],
            areas: vec![office, dup, area("bathroom", 1.0, 1.0, 5.0, 5.0), area("area", f64::INFINITY, 0.0, 1.0, 1.0)],
        }).unwrap();
        let a = &f.shape.areas;
        assert_eq!(a.len(), 3);
        assert_eq!((a[0].id.as_str(), a[0].label.as_str(), a[0].x, a[0].y), ("office", "Office", 80.0, 0.0));
        assert_eq!((a[1].id.as_str(), a[1].label.as_str(), a[1].w, a[1].d), ("area-2", "Shelving", 1.0, 60.0));
        assert_eq!((a[2].kind.as_str(), a[2].label.as_str()), ("area", ""));
    }

    #[test]
    fn a_pallet_is_48_by_40_and_turns() {
        assert_eq!(footprint(false), (4.0, 40.0 / 12.0));
        assert_eq!(footprint(true), (40.0 / 12.0, 4.0));
        assert_eq!(clean_spot(100.0, 60.0, 98.0, 59.0, false).unwrap(), (96.0, 56.67));
        assert_eq!(clean_spot(100.0, 60.0, 98.0, 59.0, true).unwrap(), (96.67, 56.0));
        assert_eq!(clean_spot(100.0, 60.0, -3.0, 10.123, false).unwrap(), (0.0, 10.12));
        assert!(clean_spot(100.0, 60.0, f64::NAN, 1.0, false).is_err());
    }

    #[test]
    fn touching_is_not_overlapping() {
        let a = pallet_rect(0.0, 0.0, false);
        assert!(!overlaps(a, pallet_rect(4.0, 0.0, false)));
        assert!(!overlaps(a, pallet_rect(0.0, 3.33, false)));
        assert!(overlaps(a, pallet_rect(3.0, 1.0, false)));
        assert!(overlaps(a, pallet_rect(0.0, 0.0, true)));
    }

    #[test]
    fn a_dragged_pallet_lines_up_with_its_row() {
        let a = pallet_rect(10.0, 10.0, false);
        // Dropped just past a's right edge on the same row: pulled against it, and level with it.
        let s = snap(100.0, 60.0, pallet_rect(14.3, 10.4, false), &[a]);
        assert_eq!((s.x, s.y), (14.0, 10.0));
        // Far from everything: the nearest quarter foot.
        let s = snap(100.0, 60.0, pallet_rect(50.13, 30.4, false), &[a]);
        assert_eq!((s.x, s.y), (50.25, 30.5));
        // Near the right wall: its end lands on the wall.
        let s = snap(100.0, 60.0, pallet_rect(95.8, 30.0, false), &[]);
        assert_eq!(s.x, 96.0);
        // Something across the building is no edge to line up with.
        let s = snap(100.0, 60.0, pallet_rect(14.3, 40.0, false), &[a]);
        assert_eq!(s.x, 14.25);
        // Never outside the walls.
        let s = snap(100.0, 60.0, pallet_rect(-7.0, 70.0, true), &[]);
        assert_eq!((s.x, s.y), (0.0, 56.0));
    }

    #[test]
    fn the_shape_reads_with_fields_missing() {
        let s: FloorShape = serde_json::from_str(r#"{"doors":[{"side":"top","at":3,"width":10}]}"#).unwrap();
        assert_eq!((s.doors.len(), s.areas.len()), (1, 0));
        let s: FloorShape = serde_json::from_str("{}").unwrap();
        assert_eq!(s, FloorShape::default());
    }
}
