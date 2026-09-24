//! Fitting boxes onto pallets (R-346).
//!
//! Given a pallet (its footprint, its own height, and the most the load may stand from the floor)
//! and every box size's measurements, this works out the most boxes a layer, stacks layers as high
//! as the pallet may go, and gives every box an exact place. Every plan keeps these rules, and
//! `check` — written apart from the fitter — proves them again before anything is handed back:
//!   - nothing past the pallet edge and nothing above the height limit;
//!   - no two boxes in the same space;
//!   - every box stands on the deck, or on boxes whose tops are exactly at its bottom, with all four
//!     of its bottom corners on a box and at least 90% of its bottom resting on boxes.
//! Lengths are inches. Each is rounded once to hundredths of an inch, so the geometry below is
//! exact integer arithmetic and a plan can never be off by a rounding error.
//!
//! BYTE-IDENTICAL in BUSINESS APP src-tauri/src/pallet_fit.rs and clienthub-api src/routes/pallet_fit.rs
//! (like warehouse_core.rs): edit one, copy it, test both. No `use crate::` — std and serde only.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// Hundredths of an inch.
const Q: f64 = 100.0;
/// Past these a plan is not a pallet anyone builds by hand — and the work would not end in time.
const MAX_PER_PALLET: usize = 5_000;
const MAX_BOXES: i64 = 25_000;
const MAX_TYPES: usize = 60;
fn q(x: f64) -> i64 {
    if x.is_finite() { (x * Q).round() as i64 } else { 0 }
}
fn inch(v: i64) -> f64 {
    v as f64 / Q
}
/// "48" or "47.5".
fn show(v: i64) -> String {
    let s = format!("{:.2}", inch(v));
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The pallet: its footprint, the deck's own height, and the most the load may stand from the floor.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PalletSpec {
    #[serde(default)]
    pub length: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub deck: f64,
    #[serde(default)]
    pub max_height: f64,
}

/// One box size's outside measurements, and whether it may be laid on its side.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BoxSize {
    #[serde(default)]
    pub length: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub side_ok: bool,
}

/// What a product keeps (warehouse_items.pallet_json): its pallet and each box size's
/// measurements, by box type id. Its own column, so a client that does not know it cannot wipe it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PalletSetup {
    #[serde(default)]
    pub pallet: PalletSpec,
    #[serde(default)]
    pub boxes: BTreeMap<String, BoxSize>,
}

/// A box size as the fitter sees it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FitType {
    #[serde(default)]
    pub type_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub per_box: i64,
    #[serde(default)]
    pub size: BoxSize,
}

/// Some boxes of one size of one section (team) to put on pallets.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FitGroup {
    #[serde(default)]
    pub section_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub type_id: String,
    #[serde(default)]
    pub boxes: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FitRequest {
    #[serde(default)]
    pub pallet: PalletSpec,
    #[serde(default)]
    pub types: Vec<FitType>,
    #[serde(default)]
    pub groups: Vec<FitGroup>,
    /// The biggest size on pallets of its own, the rest together (R-342).
    #[serde(default)]
    pub big_alone: bool,
}

/// One box on a pallet. x runs along the pallet's length, y across its width, z up from the top
/// of the deck; (x, y, z) is the corner nearest the pallet's back-left corner, on the deck side.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Placed {
    pub type_id: String,
    pub section_id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub l: f64,
    pub w: f64,
    pub h: f64,
    /// 1 = the layer on the deck.
    pub layer: usize,
    /// Laid on its side (only for a size that may be).
    pub on_side: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FitLayer {
    pub n: usize,
    pub type_id: String,
    pub z: f64,
    pub height: f64,
    pub boxes: usize,
    /// Every spot of the layer's pattern is used.
    pub full: bool,
    pub on_side: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FitPallet {
    pub n: usize,
    pub boxes: Vec<Placed>,
    pub layers: Vec<FitLayer>,
    /// Top of the load above the deck, and from the floor.
    pub load_height: f64,
    pub total_height: f64,
    pub units: i64,
    /// What is on it, per section and size.
    pub counts: Vec<FitGroup>,
}

/// The most of one size a pallet holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Capacity {
    pub type_id: String,
    pub per_layer: usize,
    pub layers: usize,
    /// Boxes in the layers laid another way up on top, if the size may go on its side.
    pub top_boxes: usize,
    pub boxes: usize,
    /// The layer pattern is as many as the footprint's area allows — no pattern can hold more.
    pub layer_is_best: bool,
    pub on_side: bool,
    pub total_height: f64,
    pub pallet: FitPallet,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FitResult {
    pub pallets: Vec<FitPallet>,
    pub capacity: Vec<Capacity>,
}

// ---------------------------------------------------------------------------------------------
// Checking the inputs.

struct P {
    l: i64,
    w: i64,
    deck: i64,
    load: i64,
}

fn pallet_q(p: &PalletSpec) -> Result<P, String> {
    let (l, w, deck, top) = (q(p.length), q(p.width), q(p.deck), q(p.max_height));
    if l <= 0 || w <= 0 {
        return Err("Enter the pallet's length and width.".into());
    }
    if top <= 0 {
        return Err("Enter the most the pallet may stand from the floor.".into());
    }
    if deck < 0 {
        return Err("The pallet's own height cannot be below zero.".into());
    }
    if top <= deck {
        return Err(format!("The most it may stand ({} in) must be above the pallet's own height ({} in).", show(top), show(deck)));
    }
    if l > q(240.0) || w > q(240.0) || top > q(480.0) {
        return Err("That pallet is larger than any pallet (over 240 in, or over 480 in high).".into());
    }
    Ok(P { l, w, deck, load: top - deck })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Dims {
    l: i64,
    w: i64,
    h: i64,
    side_ok: bool,
}

fn box_q(t: &FitType) -> Result<Dims, String> {
    let d = Dims { l: q(t.size.length), w: q(t.size.width), h: q(t.size.height), side_ok: t.size.side_ok };
    if d.l <= 0 || d.w <= 0 || d.h <= 0 {
        return Err(format!("Enter the length, width and height of {}.", name_of(t)));
    }
    // Under an inch a side, a pallet would be thousands of boxes a layer — not a box anyone stacks by hand.
    if d.l < q(1.0) || d.w < q(1.0) || d.h < q(1.0) {
        return Err(format!("{} is under an inch on a side. Check its measurements.", name_of(t)));
    }
    Ok(d)
}

fn name_of(t: &FitType) -> String {
    if t.name.trim().is_empty() { "a box size".into() } else { t.name.trim().to_string() }
}

// ---------------------------------------------------------------------------------------------
// One layer: the most rectangles of a × b (turned either way) inside a pallet's footprint.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct R {
    x: i64,
    y: i64,
    l: i64,
    w: i64,
}

impl R {
    fn area(&self) -> i64 {
        self.l * self.w
    }
    fn overlap(&self, o: &R) -> i64 {
        let dx = (self.x + self.l).min(o.x + o.l) - self.x.max(o.x);
        let dy = (self.y + self.w).min(o.y + o.w) - self.y.max(o.y);
        if dx > 0 && dy > 0 { dx * dy } else { 0 }
    }
    fn holds(&self, px: i64, py: i64) -> bool {
        px >= self.x && px <= self.x + self.l && py >= self.y && py <= self.y + self.w
    }
    fn corners(&self) -> [(i64, i64); 4] {
        [(self.x, self.y), (self.x + self.l, self.y), (self.x, self.y + self.w), (self.x + self.l, self.y + self.w)]
    }
}

/// Every length a row of a's and b's can add up to, up to `limit` (the only lengths a cut needs).
fn raster(limit: i64, a: i64, b: i64, cap: usize) -> Option<Vec<i64>> {
    let mut v = Vec::new();
    let mut i = 0;
    while i * a <= limit {
        let mut j = 0;
        while i * a + j * b <= limit {
            v.push(i * a + j * b);
            j += 1;
        }
        i += 1;
        if v.len() > cap * 64 {
            return None;
        }
    }
    v.sort_unstable();
    v.dedup();
    if v.len() > cap { None } else { Some(v) }
}

#[derive(Clone, Copy, Debug)]
enum Cut {
    Grid(bool),
    V(i64),
    H(i64),
}

/// Guillotine search: a rectangle is filled by a plain grid, or cut in two and each half filled.
struct Dp {
    a: i64,
    b: i64,
    rx: Vec<i64>,
    ry: Vec<i64>,
    memo: HashMap<(i64, i64), (u32, Cut)>,
}

fn floor_in(r: &[i64], v: i64) -> i64 {
    match r.binary_search(&v) {
        Ok(i) => r[i],
        Err(0) => 0,
        Err(i) => r[i - 1],
    }
}

impl Dp {
    fn fx(&self, v: i64) -> i64 {
        floor_in(&self.rx, v)
    }
    fn fy(&self, v: i64) -> i64 {
        floor_in(&self.ry, v)
    }
    fn grid(&self, x: i64, y: i64, turned: bool) -> u32 {
        let (p, r) = if turned { (self.b, self.a) } else { (self.a, self.b) };
        ((x / p) * (y / r)) as u32
    }
    fn bound(&self, x: i64, y: i64) -> u32 {
        ((x as i128 * y as i128) / (self.a as i128 * self.b as i128)) as u32
    }
    fn best(&mut self, x: i64, y: i64) -> u32 {
        if x <= 0 || y <= 0 {
            return 0;
        }
        if let Some(&(n, _)) = self.memo.get(&(x, y)) {
            return n;
        }
        let (g0, g1) = (self.grid(x, y, false), self.grid(x, y, true));
        let (mut n, mut cut) = if g1 > g0 { (g1, Cut::Grid(true)) } else { (g0, Cut::Grid(false)) };
        let bound = self.bound(x, y);
        if n < bound {
            let xs: Vec<i64> = self.rx.iter().copied().filter(|&c| c > 0 && 2 * c <= x).collect();
            for x1 in xs {
                let rest = self.fx(x - x1);
                let v = self.best(x1, y) + self.best(rest, y);
                if v > n {
                    n = v;
                    cut = Cut::V(x1);
                    if n >= bound {
                        break;
                    }
                }
            }
        }
        if n < bound {
            let ys: Vec<i64> = self.ry.iter().copied().filter(|&c| c > 0 && 2 * c <= y).collect();
            for y1 in ys {
                let rest = self.fy(y - y1);
                let v = self.best(x, y1) + self.best(x, rest);
                if v > n {
                    n = v;
                    cut = Cut::H(y1);
                    if n >= bound {
                        break;
                    }
                }
            }
        }
        self.memo.insert((x, y), (n, cut));
        n
    }
    fn place(&self, x0: i64, y0: i64, x: i64, y: i64, out: &mut Vec<R>) {
        if x <= 0 || y <= 0 {
            return;
        }
        let cut = match self.memo.get(&(x, y)) {
            Some(&(_, c)) => c,
            None => return,
        };
        match cut {
            Cut::Grid(turned) => {
                let (p, r) = if turned { (self.b, self.a) } else { (self.a, self.b) };
                for i in 0..x / p {
                    for j in 0..y / r {
                        out.push(R { x: x0 + i * p, y: y0 + j * r, l: p, w: r });
                    }
                }
            }
            Cut::V(x1) => {
                self.place(x0, y0, x1, y, out);
                self.place(x0 + x1, y0, self.fx(x - x1), y, out);
            }
            Cut::H(y1) => {
                self.place(x0, y0, x, y1, out);
                self.place(x0, y0 + y1, x, self.fy(y - y1), out);
            }
        }
    }
}

/// The most a × b boxes in an L × W footprint, placed and centred on the pallet, and whether that
/// is as many as the area allows.
fn best_layer(pl: i64, pw: i64, a: i64, b: i64) -> (Vec<R>, bool) {
    if a <= 0 || b <= 0 || (a > pl || b > pw) && (b > pl || a > pw) {
        return (Vec::new(), false);
    }
    let bound = ((pl as i128 * pw as i128) / (a as i128 * b as i128)) as usize;
    let mut out = Vec::new();
    match (raster(pl, a, b, 160), raster(pw, a, b, 160)) {
        (Some(rx), Some(ry)) => {
            let mut dp = Dp { a, b, rx, ry, memo: HashMap::new() };
            let (x, y) = (dp.fx(pl), dp.fy(pw));
            let n = dp.best(x, y);
            // First-order non-guillotine (the "pinwheel" of five blocks), when the grid is small
            // enough to try every way: it finds the extra box a straight cut cannot.
            let mut five: Option<(u32, [R; 5])> = None;
            if (n as usize) < bound && dp.rx.len() <= 48 && dp.ry.len() <= 48 {
                let rx: Vec<i64> = dp.rx.iter().copied().filter(|&v| v > 0 && v < x).collect();
                let ry: Vec<i64> = dp.ry.iter().copied().filter(|&v| v > 0 && v < y).collect();
                let mut top = n;
                'search: for (i, &x1) in rx.iter().enumerate() {
                    for &x2 in &rx[i + 1..] {
                        for (k, &y1) in ry.iter().enumerate() {
                            for &y2 in &ry[k + 1..] {
                                let blocks = [
                                    R { x: 0, y: 0, l: dp.fx(x2), w: dp.fy(y1) },
                                    R { x: x2, y: 0, l: dp.fx(x - x2), w: dp.fy(y2) },
                                    R { x: x1, y: y2, l: dp.fx(x - x1), w: dp.fy(y - y2) },
                                    R { x: 0, y: y1, l: dp.fx(x1), w: dp.fy(y - y1) },
                                    R { x: x1, y: y1, l: dp.fx(x2 - x1), w: dp.fy(y2 - y1) },
                                ];
                                let v: u32 = blocks.iter().map(|r| dp.best(r.l, r.w)).sum();
                                if v > top {
                                    top = v;
                                    five = Some((v, blocks));
                                    if top as usize >= bound {
                                        break 'search;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            match five {
                Some((_, blocks)) => blocks.iter().for_each(|r| dp.place(r.x, r.y, r.l, r.w, &mut out)),
                None => dp.place(0, 0, x, y, &mut out),
            }
            // Short of what the area allows: search every packing (small layers only), which
            // either finds the box the patterns above missed or proves there is none.
            if out.len() < bound && bound <= 64 {
                let (better, done) = exact_layer(x, y, a, b, &dp.rx, &dp.ry, out.len(), 800_000);
                if let Some(v) = better {
                    out = v;
                }
                if done {
                    return (centre(out, pl, pw), true);
                }
            }
        }
        // A box tiny next to the pallet: two plain blocks side by side, the best split.
        _ => out = two_blocks(pl, pw, a, b),
    }
    let best = out.len() >= bound;
    (centre(out, pl, pw), best)
}

/// Every packing of a layer, searched (R-346 review). Any packing can be slid down and to the
/// left until each box's corner sits on raster points, so trying, at the lowest-leftmost raster
/// point no box covers, "a box one way", "a box the other way" and "leave it empty" reaches every
/// packing. A point left empty wastes the cell up to the next raster point for good, which bounds
/// what a branch can still hold. Returns a packing with more than `seed` boxes if there is one,
/// and whether the search finished (then nothing holds more than its answer, or `seed`).
fn exact_layer(x: i64, y: i64, a: i64, b: i64, rx: &[i64], ry: &[i64], seed: usize, limit: u64) -> (Option<Vec<R>>, bool) {
    let xs: Vec<i64> = rx.iter().copied().filter(|&v| v <= x).collect();
    let ys: Vec<i64> = ry.iter().copied().filter(|&v| v <= y).collect();
    let next = |v: &[i64], at: i64, end: i64| v.iter().copied().find(|&n| n > at).unwrap_or(end).min(end);
    let mut pts: Vec<(i64, i64, i64)> = Vec::new(); // (x, y, the cell a point left empty wastes)
    for &py in ys.iter().filter(|&&v| v < y) {
        for &px in xs.iter().filter(|&&v| v < x) {
            pts.push((px, py, (next(&xs, px, x) - px) * (next(&ys, py, y) - py)));
        }
    }
    pts.sort_by_key(|&(px, py, _)| (py, px));
    struct S<'a> {
        pts: &'a [(i64, i64, i64)],
        turns: Vec<(i64, i64)>,
        x: i64,
        y: i64,
        area: i64,
        placed: Vec<R>,
        best: usize,
        found: Option<Vec<R>>,
        nodes: u64,
        limit: u64,
        stopped: bool,
    }
    fn go(s: &mut S, from: usize, waste: i64) {
        s.nodes += 1;
        if s.nodes > s.limit {
            s.stopped = true;
            return;
        }
        let free = s.x * s.y - s.placed.len() as i64 * s.area - waste;
        if s.placed.len() + (free.max(0) / s.area) as usize <= s.best {
            return;
        }
        let mut i = from;
        while i < s.pts.len() {
            let (px, py, _) = s.pts[i];
            if !s.placed.iter().any(|r| px >= r.x && px < r.x + r.l && py >= r.y && py < r.y + r.w) {
                break;
            }
            i += 1;
        }
        if i == s.pts.len() {
            if s.placed.len() > s.best {
                s.best = s.placed.len();
                s.found = Some(s.placed.clone());
            }
            return;
        }
        let (px, py, cell) = s.pts[i];
        for k in 0..s.turns.len() {
            let (l, w) = s.turns[k];
            let r = R { x: px, y: py, l, w };
            if px + l <= s.x && py + w <= s.y && s.placed.iter().all(|o| o.overlap(&r) == 0) {
                s.placed.push(r);
                go(s, i + 1, waste);
                s.placed.pop();
                if s.stopped {
                    return;
                }
            }
        }
        go(s, i + 1, waste + cell);
    }
    let turns = if a == b { vec![(a, b)] } else { vec![(a, b), (b, a)] };
    let mut st = S { pts: &pts, turns, x, y, area: a * b, placed: Vec::new(), best: seed, found: None, nodes: 0, limit, stopped: false };
    go(&mut st, 0, 0);
    (st.found, !st.stopped)
}

fn two_blocks(pl: i64, pw: i64, a: i64, b: i64) -> Vec<R> {
    let grid = |x0: i64, y0: i64, x: i64, y: i64, p: i64, r: i64, out: &mut Vec<R>| {
        for i in 0..x / p {
            for j in 0..y / r {
                out.push(R { x: x0 + i * p, y: y0 + j * r, l: p, w: r });
            }
        }
    };
    let mut best: Vec<R> = Vec::new();
    for (p, r, p2, r2) in [(a, b, b, a), (b, a, a, b)] {
        for i in 0..=pl / p {
            let mut v = Vec::new();
            grid(0, 0, i * p, pw, p, r, &mut v);
            grid(i * p, 0, pl - i * p, pw, p2, r2, &mut v);
            if v.len() > best.len() {
                best = v;
            }
        }
        for j in 0..=pw / r {
            let mut v = Vec::new();
            grid(0, 0, pl, j * r, p, r, &mut v);
            grid(0, j * r, pl, pw - j * r, p2, r2, &mut v);
            if v.len() > best.len() {
                best = v;
            }
        }
    }
    best
}

/// Shift a pattern so it sits in the middle of the pallet.
fn centre(mut v: Vec<R>, pl: i64, pw: i64) -> Vec<R> {
    if v.is_empty() {
        return v;
    }
    let (x0, y0) = (v.iter().map(|r| r.x).min().unwrap_or(0), v.iter().map(|r| r.y).min().unwrap_or(0));
    let (x1, y1) = (v.iter().map(|r| r.x + r.l).max().unwrap_or(0), v.iter().map(|r| r.y + r.w).max().unwrap_or(0));
    let (dx, dy) = ((pl - (x1 - x0)) / 2 - x0, (pw - (y1 - y0)) / 2 - y0);
    for r in &mut v {
        r.x += dx;
        r.y += dy;
    }
    // Build order: back row first, left to right.
    v.sort_by_key(|r| (r.y, r.x));
    v
}

// ---------------------------------------------------------------------------------------------
// One size, stacked: which way up, how many a layer, how many layers.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Way {
    /// Footprint and height of the box this way up.
    a: i64,
    b: i64,
    h: i64,
    on_side: bool,
}

fn ways(d: &Dims) -> Vec<Way> {
    let mut v = vec![Way { a: d.l, b: d.w, h: d.h, on_side: false }];
    if d.side_ok {
        for w in [Way { a: d.l, b: d.h, h: d.w, on_side: true }, Way { a: d.w, b: d.h, h: d.l, on_side: true }] {
            if !v.iter().any(|x| x.h == w.h && ((x.a, x.b) == (w.a, w.b) || (x.a, x.b) == (w.b, w.a))) {
                v.push(w);
            }
        }
    }
    v
}

#[derive(Clone, Debug)]
struct Layer {
    way: Way,
    rects: Vec<R>,
}

/// A full pallet of one size: base layers of one pattern, then (for a size that may go on its
/// side) layers another way up on top, each wholly on the layer below.
#[derive(Clone, Debug)]
struct Stack {
    base: Layer,
    layers: usize,
    best: bool,
    top: Vec<Layer>,
}

impl Stack {
    fn per_pallet(&self) -> usize {
        self.base.rects.len() * self.layers + self.top.iter().map(|l| l.rects.len()).sum::<usize>()
    }
    fn height(&self) -> i64 {
        self.base.way.h * self.layers as i64 + self.top.iter().map(|l| l.way.h).sum::<i64>()
    }
    /// Every spot on a full pallet, bottom layer first: (layer index from 1, z, rect, way).
    fn spots(&self) -> Vec<(usize, i64, R, Way)> {
        let mut v = Vec::new();
        let mut z = 0;
        for k in 0..self.layers {
            for r in &self.base.rects {
                v.push((k + 1, z, *r, self.base.way));
            }
            z += self.base.way.h;
        }
        for (k, l) in self.top.iter().enumerate() {
            for r in &l.rects {
                v.push((self.layers + k + 1, z, *r, l.way));
            }
            z += l.way.h;
        }
        v
    }
}

/// The rects of `upper` that stand wholly on `lower` (every point of the bottom on a box).
fn wholly_on(lower: &[R], upper: &[R]) -> Vec<R> {
    upper.iter().copied().filter(|u| lower.iter().map(|s| s.overlap(u)).sum::<i64>() == u.area()).collect()
}

/// The support rule for a box standing on boxes of one height: all four bottom corners on a box
/// and at least 90% of the bottom resting on boxes.
fn stands_on(lower: &[R], u: &R) -> bool {
    let covered: i64 = lower.iter().map(|s| s.overlap(u)).sum();
    covered * 10 >= u.area() * 9 && u.corners().iter().all(|&(px, py)| lower.iter().any(|s| s.holds(px, py)))
}

fn stack_of(p: &P, d: &Dims) -> Option<Stack> {
    let mut best: Option<Stack> = None;
    for way in ways(d) {
        if way.h > p.load {
            continue;
        }
        let (rects, is_best) = best_layer(p.l, p.w, way.a, way.b);
        if rects.is_empty() {
            continue;
        }
        let layers = (p.load / way.h) as usize;
        let mut s = Stack { base: Layer { way, rects }, layers, best: is_best, top: Vec::new() };
        // Room left above the last layer: layers of another way up, each wholly on the one below.
        let mut room = p.load - way.h * layers as i64;
        let mut under = s.base.rects.clone();
        loop {
            let mut pick: Option<Layer> = None;
            for w2 in ways(d) {
                if w2.h > room || w2 == way {
                    continue;
                }
                let (cand, _) = best_layer(p.l, p.w, w2.a, w2.b);
                let mut kept = wholly_on(&under, &cand);
                // The same pattern, shifted onto the layer below's corner, can keep more.
                let shifted = shift_onto(&cand, &under);
                let kept2 = wholly_on(&under, &shifted);
                if kept2.len() > kept.len() {
                    kept = kept2;
                }
                if !kept.is_empty() && pick.as_ref().map_or(true, |x| kept.len() > x.rects.len()) {
                    pick = Some(Layer { way: w2, rects: kept });
                }
            }
            match pick {
                Some(l) => {
                    room -= l.way.h;
                    under = l.rects.clone();
                    s.top.push(l);
                }
                None => break,
            }
        }
        let better = match &best {
            None => true,
            Some(b) => {
                let (n, bn) = (s.per_pallet(), b.per_pallet());
                n > bn || (n == bn && s.height() < b.height())
            }
        };
        if better && s.per_pallet() > 0 {
            best = Some(s);
        }
    }
    best
}

/// A pattern moved so its back-left corner sits on the back-left corner of the layer below.
fn shift_onto(cand: &[R], under: &[R]) -> Vec<R> {
    if cand.is_empty() || under.is_empty() {
        return Vec::new();
    }
    let (cx, cy) = (cand.iter().map(|r| r.x).min().unwrap_or(0), cand.iter().map(|r| r.y).min().unwrap_or(0));
    let (ux, uy) = (under.iter().map(|r| r.x).min().unwrap_or(0), under.iter().map(|r| r.y).min().unwrap_or(0));
    cand.iter().map(|r| R { x: r.x - cx + ux, y: r.y - cy + uy, l: r.l, w: r.w }).collect()
}

/// A pattern turned end for end and/or side to side on the pallet — the ways a layer can be laid
/// that keep it on the pallet, tried in turn until one stands on the layer below.
fn mirrors(v: &[R], pl: i64, pw: i64) -> [Vec<R>; 4] {
    let fx = |r: &R| R { x: pl - r.x - r.l, ..*r };
    let fy = |r: &R| R { y: pw - r.y - r.w, ..*r };
    [v.to_vec(), v.iter().map(fx).collect(), v.iter().map(fy).collect(), v.iter().map(|r| fy(&fx(r))).collect()]
}

// ---------------------------------------------------------------------------------------------
// Building pallets.

/// A box as the builder holds it: its size, which way up, where, its bottom, and whether it is
/// part of a full layer of one size.
#[derive(Clone, Copy, Debug)]
struct Bx {
    t: usize,
    way: Way,
    r: R,
    z: i64,
    full: bool,
}

struct Built {
    boxes: Vec<Bx>,
    /// The top of its last full layer, and that layer's boxes: where the next full layer stands.
    flat: i64,
    flat_top: Vec<R>,
    /// A pallet of the biggest size alone takes nothing else (R-342).
    alone: bool,
}

/// The lowest place a box can go on a pallet as it stands, back-left first: on the deck, or on
/// boxes whose tops are exactly at its bottom (all four corners on a box, at least 90% of its
/// bottom resting on boxes), clear of every box, inside the edge and under the height limit.
/// Tried first at the spots of the size's own best layer (every way it can be laid on the pallet),
/// so leftover boxes line up the way a full layer of them would; then at the corners of the boxes
/// it would stand on and beside the boxes around it — where a box pushed back and left ends up.
fn place_one(p: &P, boxes: &[Bx], way: Way, pattern: &[Vec<R>]) -> Option<(R, i64)> {
    let mut levels: Vec<i64> = boxes.iter().map(|b| b.z + b.way.h).collect();
    levels.push(0);
    levels.sort_unstable();
    levels.dedup();
    let turns = if way.a == way.b { vec![(way.a, way.b)] } else { vec![(way.a, way.b), (way.b, way.a)] };
    for z in levels {
        if z + way.h > p.load {
            break;
        }
        let supports: Vec<R> = if z == 0 { vec![R { x: 0, y: 0, l: p.l, w: p.w }] } else { boxes.iter().filter(|b| b.z + b.way.h == z).map(|b| b.r).collect() };
        if supports.is_empty() {
            continue;
        }
        let blockers: Vec<R> = boxes.iter().filter(|b| b.z < z + way.h && b.z + b.way.h > z).map(|b| b.r).collect();
        let fits = |r: &R| !blockers.iter().any(|o| o.overlap(r) > 0) && (z == 0 || stands_on(&supports, r));
        let mut on_pattern: Vec<R> = pattern.iter().flatten().copied().filter(|r| fits(r)).collect();
        on_pattern.sort_by_key(|r| (r.y, r.x));
        if let Some(r) = on_pattern.first() {
            return Some((*r, z));
        }
        let mut best: Option<R> = None;
        for &(l, w) in &turns {
            let mut at: Vec<(i64, i64)> = vec![(0, 0), (p.l - l, 0), (0, p.w - w), (p.l - l, p.w - w)];
            for s in &supports {
                at.extend([(s.x, s.y), (s.x + s.l - l, s.y), (s.x, s.y + s.w - w), (s.x + s.l - l, s.y + s.w - w)]);
            }
            for o in &blockers {
                at.extend([(o.x + o.l, o.y), (o.x, o.y + o.w), (o.x + o.l, 0), (0, o.y + o.w), (o.x - l, o.y), (o.x, o.y - w)]);
            }
            at.retain(|&(x, y)| x >= 0 && y >= 0 && x + l <= p.l && y + w <= p.w);
            at.sort_unstable_by_key(|&(x, y)| (y, x));
            at.dedup();
            for (x, y) in at {
                if best.map_or(false, |b| (b.y, b.x) <= (y, x)) {
                    break;
                }
                let r = R { x, y, l, w };
                if blockers.iter().any(|o| o.overlap(&r) > 0) {
                    continue;
                }
                if z > 0 && !stands_on(&supports, &r) {
                    continue;
                }
                best = Some(r);
                break;
            }
        }
        if let Some(r) = best {
            return Some((r, z));
        }
    }
    None
}

/// Fit the request. Every pallet is checked before it is returned; a plan that fails the check is
/// an error, never a picture.
pub fn fit(req: &FitRequest) -> Result<FitResult, String> {
    let p = pallet_q(&req.pallet)?;
    if req.types.len() > MAX_TYPES {
        return Err(format!("More than {MAX_TYPES} box sizes in one plan."));
    }
    let mut asked: i64 = 0;
    for g in &req.groups {
        if g.boxes < 0 {
            return Err("A count of boxes cannot be below zero.".into());
        }
        asked = asked.checked_add(g.boxes).filter(|&n| n <= MAX_BOXES).ok_or_else(|| format!("That is more than {} boxes in one plan. Split the load.", MAX_BOXES))?;
    }
    let mut types: Vec<(FitType, Dims, Stack)> = Vec::new();
    let mut capacity = Vec::new();
    for t in &req.types {
        let needed = req.groups.iter().any(|g| g.type_id == t.type_id && g.boxes > 0);
        let d = match box_q(t) {
            Ok(d) => d,
            Err(e) if needed => return Err(e),
            Err(_) => continue,
        };
        let s = match stack_of(&p, &d) {
            Some(s) => s,
            None if needed => {
                return Err(format!(
                    "{} ({} × {} × {} in) does not fit on a {} × {} in pallet under {} in{}.",
                    name_of(t), show(d.l), show(d.w), show(d.h), show(p.l), show(p.w), show(p.load + p.deck),
                    if d.side_ok { "" } else { " standing up" }
                ))
            }
            None => continue,
        };
        if !needed {
            continue;
        }
        capacity.push(capacity_of(&p, t, &s)?);
        types.push((t.clone(), d, s));
    }
    // What to place, per size: sections in order of most boxes first (their boxes stay together).
    let mut queues: Vec<Vec<(String, i64)>> = vec![Vec::new(); types.len()];
    for g in req.groups.iter().filter(|g| g.boxes > 0) {
        let i = types.iter().position(|(t, _, _)| t.type_id == g.type_id).ok_or_else(|| format!("No box size {} on this product.", g.type_id))?;
        match queues[i].iter_mut().find(|(s, _)| *s == g.section_id) {
            Some(e) => e.1 += g.boxes,
            None => queues[i].push((g.section_id.clone(), g.boxes)),
        }
    }
    for q in &mut queues {
        q.sort_by(|a, b| b.1.cmp(&a.1));
    }
    // Safe: every group is at least zero and the total is at most MAX_BOXES (checked above).
    let count = |i: usize| queues[i].iter().map(|(_, n)| n).sum::<i64>() as usize;

    let mut built: Vec<Built> = Vec::new();
    let big = types.iter().enumerate().max_by_key(|(_, (t, _, _))| t.per_box).map(|(i, _)| i);
    let mut mixed: Vec<usize> = (0..types.len()).filter(|&i| count(i) > 0).collect();
    if req.big_alone {
        if let Some(bi) = big {
            if count(bi) > 0 {
                mixed.retain(|&i| i != bi);
                // Pallets of the biggest size alone, each filled bottom layer first.
                too_many(&types[bi].0, &types[bi].2)?;
                let st = &types[bi].2;
                let spots = st.spots();
                let full_n = |k: usize| if k <= st.layers { st.base.rects.len() } else { st.top[k - st.layers - 1].rects.len() };
                let mut left = count(bi);
                while left > 0 {
                    let take = left.min(spots.len());
                    let on = |k: usize| spots[..take].iter().filter(|s| s.0 == k).count();
                    let boxes = spots[..take].iter().map(|&(k, z, r, way)| Bx { t: bi, way, r, z, full: on(k) == full_n(k) }).collect();
                    built.push(Built { boxes, flat: 0, flat_top: Vec::new(), alone: true });
                    left -= take;
                }
            }
        }
    }
    // The rest together. First whole layers of one size — flat, and quick to build — widest-covering
    // sizes lowest, each on the first pallet it fits and stands on.
    let cover = |i: usize| types[i].2.base.rects.iter().map(|r| r.area()).sum::<i64>();
    mixed.sort_by(|&a, &b| cover(b).cmp(&cover(a)).then(types[b].2.base.way.h.cmp(&types[a].2.base.way.h)));
    let lay = |bl: &Built, rects: &[R]| -> Option<Vec<R>> {
        if bl.flat_top.is_empty() {
            return Some(rects.to_vec());
        }
        mirrors(rects, p.l, p.w).into_iter().find(|m| m.iter().all(|u| stands_on(&bl.flat_top, u)))
    };
    // Pallets that can still take the lowest layer there is; a full one is never looked at again.
    let lowest = mixed.iter().map(|&i| types[i].2.base.way.h).min().unwrap_or(0);
    let mut open: Vec<usize> = Vec::new();
    for &i in &mixed {
        let (per, way) = (types[i].2.base.rects.len(), types[i].2.base.way);
        for _ in 0..count(i) / per {
            let mut home: Option<(usize, Vec<R>)> = None;
            for (k, &j) in open.iter().enumerate() {
                if built[j].flat + way.h > p.load {
                    continue;
                }
                if let Some(rects) = lay(&built[j], &types[i].2.base.rects) {
                    home = Some((k, rects));
                    break;
                }
            }
            let (k, rects) = match home {
                Some(x) => x,
                None => {
                    built.push(Built { boxes: Vec::new(), flat: 0, flat_top: Vec::new(), alone: false });
                    open.push(built.len() - 1);
                    (open.len() - 1, types[i].2.base.rects.clone())
                }
            };
            let j = open[k];
            let z = built[j].flat;
            built[j].boxes.extend(rects.iter().map(|&r| Bx { t: i, way, r, z, full: true }));
            built[j].flat = z + way.h;
            built[j].flat_top = rects;
            if p.load - built[j].flat < lowest {
                open.remove(k);
            }
        }
    }
    // Then what is left of each size, box by box: each on the lowest place it can stand on a pallet
    // already begun (first come first), bigger boxes first; a new pallet only when none has room.
    let mut rest: Vec<usize> = Vec::new();
    for &i in &mixed {
        let per = types[i].2.base.rects.len();
        rest.extend(std::iter::repeat(i).take(count(i) % per));
    }
    let foot = |i: usize| types[i].2.base.way.a * types[i].2.base.way.b;
    rest.sort_by(|&a, &b| foot(b).cmp(&foot(a)).then(types[b].2.base.way.h.cmp(&types[a].2.base.way.h)).then(a.cmp(&b)));
    // Every way up a size may go: its own first, then (a size that may lie on its side) the others,
    // so a leftover box can lie down in the room left on top instead of starting a pallet (R-346 review).
    let options = |i: usize| -> Vec<Way> {
        let base = types[i].2.base.way;
        let mut v = vec![base];
        v.extend(ways(&types[i].1).into_iter().filter(|w| *w != base));
        v
    };
    let short = rest.iter().flat_map(|&i| options(i).into_iter().map(|w| w.h)).min().unwrap_or(0);
    // Each size's best layer each way up, in every mirror — worked out once.
    let mut patterns: HashMap<(usize, Way), Vec<Vec<R>>> = HashMap::new();
    for &i in rest.iter() {
        for w in options(i) {
            patterns.entry((i, w)).or_insert_with(|| {
                let rects = if w == types[i].2.base.way { types[i].2.base.rects.clone() } else { best_layer(p.l, p.w, w.a, w.b).0 };
                mirrors(&rects, p.l, p.w).to_vec()
            });
        }
    }
    let mut roomy: Vec<usize> = (0..built.len()).filter(|&j| !built[j].alone && built[j].flat + short <= p.load).collect();
    for i in rest {
        let way = types[i].2.base.way;
        let mut placed = false;
        for &j in &roomy {
            // The lowest place any way up; a tie keeps the size's own way.
            let mut best: Option<(R, i64, Way)> = None;
            for w in options(i) {
                if let Some((r, z)) = place_one(&p, &built[j].boxes, w, &patterns[&(i, w)]) {
                    if best.map_or(true, |(_, bz, _)| z < bz) {
                        best = Some((r, z, w));
                    }
                }
            }
            if let Some((r, z, w)) = best {
                built[j].boxes.push(Bx { t: i, way: w, r, z, full: false });
                placed = true;
                break;
            }
        }
        if !placed {
            built.push(Built { boxes: Vec::new(), flat: 0, flat_top: Vec::new(), alone: false });
            let j = built.len() - 1;
            roomy.push(j);
            let (r, z) = place_one(&p, &built[j].boxes, way, &patterns[&(i, way)]).ok_or_else(|| format!("{} does not fit on an empty pallet. The plan is wrong.", name_of(&types[i].0)))?;
            built[j].boxes.push(Bx { t: i, way, r, z, full: false });
        }
    }

    // Layers are the heights boxes start at. Boxes go to sections in pallet order, layer by layer,
    // so each section's boxes of a size stay together.
    let mut pallets = Vec::new();
    let mut cursor: Vec<(usize, i64)> = vec![(0, 0); types.len()];
    for (n, bl) in built.iter().enumerate() {
        let mut v = bl.boxes.clone();
        v.sort_by_key(|b| (b.z, b.r.y, b.r.x));
        let mut starts: Vec<i64> = v.iter().map(|b| b.z).collect();
        starts.dedup();
        let mut boxes = Vec::new();
        for b in &v {
            let (qi, used) = &mut cursor[b.t];
            while *qi < queues[b.t].len() && *used >= queues[b.t][*qi].1 {
                *qi += 1;
                *used = 0;
            }
            let section_id = queues[b.t].get(*qi).map(|(s, _)| s.clone()).ok_or("More places than boxes. The plan is wrong.")?;
            *used += 1;
            let layer = starts.iter().position(|&z| z == b.z).unwrap_or(0) + 1;
            boxes.push(Placed {
                type_id: types[b.t].0.type_id.clone(), section_id,
                x: inch(b.r.x), y: inch(b.r.y), z: inch(b.z), l: inch(b.r.l), w: inch(b.r.w), h: inch(b.way.h),
                layer, on_side: b.way.on_side,
            });
        }
        let layers = starts.iter().enumerate().map(|(k, &z)| {
            let at: Vec<&Bx> = v.iter().filter(|b| b.z == z).collect();
            let one = at.iter().all(|b| b.t == at[0].t);
            FitLayer {
                n: k + 1,
                type_id: if one { types[at[0].t].0.type_id.clone() } else { String::new() },
                z: inch(z),
                height: inch(at.iter().map(|b| b.way.h).max().unwrap_or(0)),
                boxes: at.len(),
                full: one && at.iter().all(|b| b.full),
                on_side: at.iter().any(|b| b.way.on_side),
            }
        }).collect();
        let top = v.iter().map(|b| b.z + b.way.h).max().unwrap_or(0);
        pallets.push(finish(n + 1, &p, &req.types, boxes, layers, top));
    }
    // Every box placed exactly once.
    for (i, q) in queues.iter().enumerate() {
        let want = q.iter().map(|(_, n)| n).sum::<i64>();
        let got = pallets.iter().flat_map(|p| &p.boxes).filter(|b| b.type_id == types[i].0.type_id).count() as i64;
        if want != got {
            return Err(format!("The plan placed {} of {} {}. It is wrong and is not shown.", got, want, name_of(&types[i].0)));
        }
    }
    for pl in &pallets {
        let bad = check(&req.pallet, &req.types, &pl.boxes);
        if let Some(e) = bad.first() {
            return Err(format!("Pallet {} failed its check ({}). The plan is not shown.", pl.n, e));
        }
    }
    Ok(FitResult { pallets, capacity })
}

fn finish(n: usize, p: &P, types: &[FitType], boxes: Vec<Placed>, layers: Vec<FitLayer>, z: i64) -> FitPallet {
    let mut counts: Vec<FitGroup> = Vec::new();
    for b in &boxes {
        match counts.iter_mut().find(|c| c.section_id == b.section_id && c.type_id == b.type_id) {
            Some(c) => c.boxes += 1,
            None => counts.push(FitGroup { section_id: b.section_id.clone(), name: String::new(), type_id: b.type_id.clone(), boxes: 1 }),
        }
    }
    let per = |id: &str| types.iter().find(|t| t.type_id == id).map_or(0, |t| t.per_box.max(0));
    let units = boxes.iter().map(|b| per(&b.type_id)).sum();
    FitPallet { n, boxes, layers, load_height: inch(z), total_height: inch(z + p.deck), units, counts }
}

fn too_many(t: &FitType, s: &Stack) -> Result<(), String> {
    if s.per_pallet() > MAX_PER_PALLET {
        return Err(format!(
            "{} would be {} boxes on one pallet, more than anyone stacks by hand. Check its measurements.",
            name_of(t), s.per_pallet()
        ));
    }
    Ok(())
}

fn capacity_of(p: &P, t: &FitType, s: &Stack) -> Result<Capacity, String> {
    too_many(t, s)?;
    let mut boxes = Vec::new();
    let mut layers: Vec<FitLayer> = Vec::new();
    for (k, z, r, way) in s.spots() {
        boxes.push(Placed { type_id: t.type_id.clone(), section_id: String::new(), x: inch(r.x), y: inch(r.y), z: inch(z), l: inch(r.l), w: inch(r.w), h: inch(way.h), layer: k, on_side: way.on_side });
        match layers.last_mut() {
            Some(l) if l.n == k => l.boxes += 1,
            _ => layers.push(FitLayer { n: k, type_id: t.type_id.clone(), z: inch(z), height: inch(way.h), boxes: 1, full: true, on_side: way.on_side }),
        }
    }
    let pallet = finish(1, p, std::slice::from_ref(t), boxes, layers, s.height());
    let spec = PalletSpec { length: inch(p.l), width: inch(p.w), deck: inch(p.deck), max_height: inch(p.deck + p.load) };
    if let Some(e) = check(&spec, std::slice::from_ref(t), &pallet.boxes).first() {
        return Err(format!("A full pallet of {} failed its check ({}).", name_of(t), e));
    }
    Ok(Capacity {
        type_id: t.type_id.clone(),
        per_layer: s.base.rects.len(),
        layers: s.layers,
        top_boxes: s.top.iter().map(|l| l.rects.len()).sum(),
        boxes: s.per_pallet(),
        layer_is_best: s.best,
        on_side: s.base.way.on_side,
        total_height: inch(s.height() + p.deck),
        pallet,
    })
}

/// A setup as it is stored: measurements only for the product's own box sizes, and nothing that
/// is not a finite number at or above zero (a blank field is 0, which the fitter reads as unset).
pub fn clean_setup(mut s: PalletSetup, type_ids: &[&str]) -> PalletSetup {
    let ok = |v: f64| if v.is_finite() && v > 0.0 { (v * Q).round() / Q } else { 0.0 };
    s.pallet = PalletSpec { length: ok(s.pallet.length), width: ok(s.pallet.width), deck: ok(s.pallet.deck), max_height: ok(s.pallet.max_height) };
    s.boxes.retain(|id, _| type_ids.contains(&id.as_str()));
    for b in s.boxes.values_mut() {
        *b = BoxSize { length: ok(b.length), width: ok(b.width), height: ok(b.height), side_ok: b.side_ok };
    }
    s
}

/// The pallet size, in units, that a setup gives the biggest box: the most of it one pallet holds.
/// None until the pallet and that box are measured, or when it does not fit at all — then the
/// size typed on the product stands.
pub fn pallet_units_from(setup: &PalletSetup, big_id: &str, big_name: &str, per_box: i64) -> Option<i64> {
    let size = setup.boxes.get(big_id)?.clone();
    let t = FitType { type_id: big_id.to_string(), name: big_name.to_string(), per_box, size };
    let caps = capacities(&setup.pallet, std::slice::from_ref(&t)).ok()?;
    caps.first().map(|c| c.boxes as i64 * per_box.max(0)).filter(|&u| u > 0)
}

/// Exactly these boxes on one pallet (R-348: a pallet Jack says he built, or two pallets combined):
/// the same fitter with every size together, and an error naming how many pallets it would take
/// when they do not all go on one.
pub fn fit_one(pallet: &PalletSpec, types: &[FitType], groups: &[FitGroup]) -> Result<FitPallet, String> {
    let r = fit(&FitRequest { pallet: pallet.clone(), types: types.to_vec(), groups: groups.to_vec(), big_alone: false })?;
    match r.pallets.len() {
        0 => Err("There is nothing on this pallet.".into()),
        1 => Ok(r.pallets.into_iter().next().unwrap_or_default()),
        n => Err(format!(
            "These boxes do not go on one pallet: the fitter needs {n} to keep every box inside the edge, under {} in and standing on the ones below.",
            show(q(pallet.max_height))
        )),
    }
}

// ---------------------------------------------------------------------------------------------
// Pallet records (R-348): what is on a pallet Jack built, and the picture of it.

/// Some boxes of one size of one section on a recorded pallet. Names are copied in, so a pallet
/// still reads right after a team or a size is renamed or removed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PalletLine {
    #[serde(default)]
    pub section_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub type_id: String,
    #[serde(default)]
    pub type_name: String,
    #[serde(default)]
    pub per_box: i64,
    #[serde(default)]
    pub boxes: i64,
}

/// A recorded pallet's picture: the pallet it was fitted to and every box's place.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PalletPlan {
    #[serde(default)]
    pub spec: PalletSpec,
    #[serde(default)]
    pub pallet: FitPallet,
}

/// A pallet's lines as stored: one line per section and size (repeats added together), nothing
/// at or below zero, a sane size.
pub fn clean_lines(lines: &[PalletLine]) -> Result<Vec<PalletLine>, String> {
    let mut out: Vec<PalletLine> = Vec::new();
    let mut total: i64 = 0;
    for l in lines {
        if l.boxes < 0 {
            return Err("A count of boxes cannot be below zero.".into());
        }
        if l.boxes == 0 || l.type_id.is_empty() {
            continue;
        }
        total = total.checked_add(l.boxes).filter(|&n| n <= MAX_PER_PALLET as i64).ok_or_else(|| format!("More than {MAX_PER_PALLET} boxes on one pallet."))?;
        match out.iter_mut().find(|o| o.section_id == l.section_id && o.type_id == l.type_id) {
            Some(o) => o.boxes += l.boxes,
            None => out.push(PalletLine { name: l.name.trim().to_string(), type_name: l.type_name.trim().to_string(), per_box: l.per_box.max(0), ..l.clone() }),
        }
    }
    if out.is_empty() {
        return Err("Say what is on the pallet: at least one box.".into());
    }
    out.sort_by(|a, b| b.per_box.cmp(&a.per_box).then(b.boxes.cmp(&a.boxes)).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Several pallets' lines as one (combining pallets).
pub fn merge_lines(sets: &[Vec<PalletLine>]) -> Result<Vec<PalletLine>, String> {
    clean_lines(&sets.concat())
}

/// The picture of a pallet holding exactly these lines: Ok(None) when the pallet or a size on it is
/// not measured (the record stands without a picture), Err when measured and they do not go on one.
pub fn plan_lines(setup: &PalletSetup, lines: &[PalletLine]) -> Result<Option<PalletPlan>, String> {
    let ready = q(setup.pallet.length) > 0 && q(setup.pallet.width) > 0 && q(setup.pallet.max_height) > q(setup.pallet.deck);
    let measured = |id: &str| setup.boxes.get(id).map_or(false, |b| q(b.length) > 0 && q(b.width) > 0 && q(b.height) > 0);
    if !ready || !lines.iter().all(|l| measured(&l.type_id)) {
        return Ok(None);
    }
    let mut types: Vec<FitType> = Vec::new();
    for l in lines {
        if !types.iter().any(|t| t.type_id == l.type_id) {
            types.push(FitType { type_id: l.type_id.clone(), name: l.type_name.clone(), per_box: l.per_box, size: setup.boxes[&l.type_id].clone() });
        }
    }
    let groups: Vec<FitGroup> = lines.iter().map(|l| FitGroup { section_id: l.section_id.clone(), name: l.name.clone(), type_id: l.type_id.clone(), boxes: l.boxes }).collect();
    let pallet = fit_one(&setup.pallet, &types, &groups)?;
    Ok(Some(PalletPlan { spec: setup.pallet.clone(), pallet }))
}

/// A plan sent in (a pallet built from Build this lot) is kept only if it holds exactly these
/// lines and passes the check; otherwise it is worked out again from the lines.
pub fn keep_or_plan(setup: &PalletSetup, lines: &[PalletLine], sent: Option<PalletPlan>) -> Result<Option<PalletPlan>, String> {
    if let Some(p) = sent {
        let types: Vec<FitType> = lines.iter().filter_map(|l| {
            setup.boxes.get(&l.type_id).map(|b| FitType { type_id: l.type_id.clone(), name: l.type_name.clone(), per_box: l.per_box, size: b.clone() })
        }).collect();
        let same = lines.iter().all(|l| p.pallet.boxes.iter().filter(|b| b.section_id == l.section_id && b.type_id == l.type_id).count() as i64 == l.boxes)
            && p.pallet.boxes.len() as i64 == lines.iter().map(|l| l.boxes).sum::<i64>();
        if same && types.len() == lines.iter().map(|l| &l.type_id).collect::<std::collections::BTreeSet<_>>().len() && check(&p.spec, &types, &p.pallet.boxes).is_empty() {
            return Ok(Some(p));
        }
    }
    plan_lines(setup, lines)
}

/// A full pallet of each size (for the setup screen). Sizes without measurements are left out.
pub fn capacities(pallet: &PalletSpec, types: &[FitType]) -> Result<Vec<Capacity>, String> {
    let p = pallet_q(pallet)?;
    if types.len() > MAX_TYPES {
        return Err(format!("More than {MAX_TYPES} box sizes."));
    }
    let mut out = Vec::new();
    for t in types {
        let d = match box_q(t) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if let Some(s) = stack_of(&p, &d) {
            out.push(capacity_of(&p, t, &s)?);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The check. Written apart from the fitter: it trusts nothing the fitter decided.

/// Every rule a built pallet must keep; empty when it keeps them all.
pub fn check(pallet: &PalletSpec, types: &[FitType], boxes: &[Placed]) -> Vec<String> {
    let mut bad = Vec::new();
    let p = match pallet_q(pallet) {
        Ok(p) => p,
        Err(e) => return vec![e],
    };
    struct B {
        x: i64,
        y: i64,
        z: i64,
        l: i64,
        w: i64,
        h: i64,
    }
    let mut v: Vec<B> = Vec::with_capacity(boxes.len());
    for (i, b) in boxes.iter().enumerate() {
        let c = B { x: q(b.x), y: q(b.y), z: q(b.z), l: q(b.l), w: q(b.w), h: q(b.h) };
        let tag = format!("box {} ({})", i + 1, b.type_id);
        let t = match types.iter().find(|t| t.type_id == b.type_id) {
            Some(t) => t,
            None => {
                bad.push(format!("{}: not a size of this product", tag));
                continue;
            }
        };
        // Its measurements are its size's, one way up.
        let (sl, sw, sh) = (q(t.size.length), q(t.size.width), q(t.size.height));
        let mut want = [sl, sw, sh];
        let mut got = [c.l, c.w, c.h];
        want.sort_unstable();
        got.sort_unstable();
        if want != got {
            bad.push(format!("{}: measures {} × {} × {}, its size is {} × {} × {}", tag, show(c.l), show(c.w), show(c.h), show(sl), show(sw), show(sh)));
        }
        if c.h != sh && !t.size.side_ok {
            bad.push(format!("{}: on its side, and this size must stand up", tag));
        }
        if c.x < 0 || c.y < 0 || c.x + c.l > p.l || c.y + c.w > p.w {
            bad.push(format!("{}: past the pallet edge", tag));
        }
        if c.z < 0 || c.z + c.h > p.load {
            bad.push(format!("{}: above the height limit", tag));
        }
        v.push(c);
    }
    // Overlap: by x, each box against only the boxes that start before it ends (a sweep).
    let mut order: Vec<usize> = (0..v.len()).collect();
    order.sort_by_key(|&i| v[i].x);
    for (k, &i) in order.iter().enumerate() {
        for &j in &order[k + 1..] {
            let (a, b) = (&v[i], &v[j]);
            if b.x >= a.x + a.l {
                break;
            }
            let apart = b.x + b.l <= a.x || a.y + a.w <= b.y || b.y + b.w <= a.y || a.z + a.h <= b.z || b.z + b.h <= a.z;
            if !apart {
                bad.push(format!("boxes {} and {} share space", i.min(j) + 1, i.max(j) + 1));
            }
        }
    }
    // Support: each box against only the boxes whose tops are at its bottom.
    let mut tops: HashMap<i64, Vec<R>> = HashMap::new();
    for b in &v {
        tops.entry(b.z + b.h).or_default().push(R { x: b.x, y: b.y, l: b.l, w: b.w });
    }
    for (i, a) in v.iter().enumerate() {
        if a.z == 0 {
            continue;
        }
        let under: &[R] = tops.get(&a.z).map(|x| x.as_slice()).unwrap_or(&[]);
        let me = R { x: a.x, y: a.y, l: a.l, w: a.w };
        let covered: i64 = under.iter().map(|s| s.overlap(&me)).sum();
        if covered * 10 < me.area() * 9 {
            bad.push(format!("box {}: only {}% of its bottom rests on boxes", i + 1, covered * 100 / me.area().max(1)));
        }
        if !me.corners().iter().all(|&(px, py)| under.iter().any(|s| s.holds(px, py))) {
            bad.push(format!("box {}: a corner hangs over nothing", i + 1));
        }
    }
    bad
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pallet(l: f64, w: f64, deck: f64, top: f64) -> PalletSpec {
        PalletSpec { length: l, width: w, deck, max_height: top }
    }
    fn size(l: f64, w: f64, h: f64, side_ok: bool) -> BoxSize {
        BoxSize { length: l, width: w, height: h, side_ok }
    }
    fn ty(id: &str, per: i64, s: BoxSize) -> FitType {
        FitType { type_id: id.into(), name: id.into(), per_box: per, size: s }
    }
    fn g(sec: &str, id: &str, n: i64) -> FitGroup {
        FitGroup { section_id: sec.into(), name: sec.into(), type_id: id.into(), boxes: n }
    }
    fn valid_layer(v: &[R], pl: i64, pw: i64) -> bool {
        v.iter().all(|r| r.x >= 0 && r.y >= 0 && r.x + r.l <= pl && r.y + r.w <= pw)
            && (0..v.len()).all(|i| (i + 1..v.len()).all(|j| v[i].overlap(&v[j]) == 0))
    }
    /// A small xorshift, so the random cases are the same every run.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn range(&mut self, lo: i64, hi: i64) -> i64 {
            lo + (self.next() % (hi - lo + 1) as u64) as i64
        }
    }

    #[test]
    fn a_layer_fills_the_footprint_when_the_boxes_divide_it() {
        let (v, best) = best_layer(4800, 4000, 1200, 1000);
        assert_eq!(v.len(), 16);
        assert!(best && valid_layer(&v, 4800, 4000));
    }

    #[test]
    fn a_layer_finds_the_pinwheel_a_straight_cut_misses() {
        // Four 3 × 2 boxes around a 1 × 1 hole: only a pinwheel holds four.
        let (v, best) = best_layer(500, 500, 300, 200);
        assert_eq!(v.len(), 4);
        assert!(best && valid_layer(&v, 500, 500));
    }

    #[test]
    fn a_layer_mixes_both_turns_when_that_holds_more() {
        // 48 × 40 with 15 × 11: 3 × 3 one way leaves 3 × 7 unused; turning a block wins more.
        let (v, _) = best_layer(4800, 4000, 1500, 1100);
        assert!(v.len() >= 10, "{}", v.len());
        assert!(valid_layer(&v, 4800, 4000));
    }

    #[test]
    fn random_layers_are_valid_and_never_worse_than_a_plain_grid() {
        let mut rng = Rng(0x9E3779B97F4A7C15);
        for _ in 0..160 {
            let (pl, pw) = (rng.range(2000, 6000), rng.range(2000, 5000));
            let (a, b) = (rng.range(300, 2600), rng.range(300, 2600));
            let (v, best) = best_layer(pl, pw, a, b);
            let grid = ((pl / a) * (pw / b)).max((pl / b) * (pw / a)) as usize;
            assert!(valid_layer(&v, pl, pw), "{pl} {pw} {a} {b}");
            assert!(v.len() >= grid, "{pl} {pw} {a} {b}: {} < grid {grid}", v.len());
            let bound = ((pl * pw) / (a * b)) as usize;
            assert!(v.len() <= bound);
            // "Best" is either the area's own limit or a finished search of every packing.
            if v.len() == bound {
                assert!(best);
            }
        }
    }

    #[test]
    fn a_huge_or_overflowing_order_is_refused_not_hung() {
        let t = vec![ty("big", 72, size(24.0, 20.0, 12.0, false))];
        let spec = pallet(48.0, 40.0, 6.0, 60.0);
        let huge = fit(&FitRequest { pallet: spec.clone(), types: t.clone(), groups: vec![g("owls", "big", 999_999_999_999)], big_alone: true });
        assert!(huge.unwrap_err().contains("more than 25000 boxes"));
        let wrap = fit(&FitRequest { pallet: spec.clone(), types: t.clone(), groups: vec![g("owls", "big", i64::MAX / 2 + 10), g("hawks", "big", i64::MAX / 2 + 10)], big_alone: true });
        assert!(wrap.is_err());
        assert!(fit(&FitRequest { pallet: spec, types: t, groups: vec![g("owls", "big", -3)], big_alone: true }).unwrap_err().contains("below zero"));
    }

    #[test]
    fn tiny_boxes_are_refused_with_a_reason() {
        let t = vec![ty("cube", 1, size(1.0, 1.0, 1.0, false))];
        let e = capacities(&pallet(48.0, 40.0, 0.0, 48.0), &t).unwrap_err();
        assert!(e.contains("boxes on one pallet"), "{e}");
    }

    #[test]
    fn a_size_nobody_asked_for_costs_nothing() {
        let types = vec![ty("big", 72, size(24.0, 20.0, 12.0, false)), ty("pin", 1, size(1.0, 1.0, 2.0, false))];
        let t = std::time::Instant::now();
        let r = fit(&FitRequest { pallet: pallet(48.0, 40.0, 6.0, 60.0), types, groups: vec![g("owls", "big", 4)], big_alone: false }).unwrap();
        assert_eq!(r.pallets.len(), 1);
        assert!(t.elapsed().as_secs_f64() < 1.0, "{:?}", t.elapsed());
    }

    #[test]
    fn a_big_load_of_mixed_pallets_is_quick() {
        let t = vec![ty("a", 72, size(24.0, 20.0, 12.0, false)), ty("b", 48, size(20.0, 16.0, 12.0, false))];
        let start = std::time::Instant::now();
        let r = fit(&FitRequest { pallet: pallet(48.0, 40.0, 6.0, 60.0), types: t.clone(), groups: vec![g("owls", "a", 12_000), g("owls", "b", 12_000)], big_alone: false }).unwrap();
        assert_eq!(r.pallets.iter().map(|p| p.boxes.len()).sum::<usize>(), 24_000);
        assert!(start.elapsed().as_secs_f64() < 10.0, "{:?}", start.elapsed());
    }

    #[test]
    fn leftover_boxes_fill_the_pallet_already_begun_before_a_new_one() {
        // R-346: 27 smaller boxes of four sizes are about 40% of one pallet — one pallet, not three.
        let types = vec![
            ty("big", 72, size(24.0, 20.0, 12.0, false)),
            ty("sq", 48, size(20.0, 16.0, 12.0, false)),
            ty("rect", 36, size(18.0, 16.0, 10.0, false)),
            ty("ssq", 24, size(16.0, 12.0, 10.0, false)),
            ty("tiny", 12, size(12.0, 10.0, 8.0, false)),
        ];
        let spec = pallet(48.0, 40.0, 6.0, 72.0);
        let req = FitRequest {
            pallet: spec.clone(), types: types.clone(),
            groups: vec![g("owls", "big", 12), g("owls", "sq", 6), g("hawks", "rect", 6), g("bears", "ssq", 3), g("lions", "tiny", 6)],
            big_alone: true,
        };
        let r = fit(&req).unwrap();
        assert_eq!(r.pallets.len(), 2, "{:?}", r.pallets.iter().map(|p| p.boxes.len()).collect::<Vec<_>>());
        for p in &r.pallets {
            assert!(check(&spec, &types, &p.boxes).is_empty());
            assert!(p.total_height <= 72.0);
        }
        // Every layer is numbered by where its boxes start, bottom first.
        let mixed = &r.pallets[1];
        assert!(mixed.layers.windows(2).all(|w| w[0].z < w[1].z));
        assert!(mixed.boxes.iter().all(|b| mixed.layers[b.layer - 1].z == b.z));
    }

    #[test]
    fn a_size_that_may_lie_down_finishes_a_shared_pallet_instead_of_starting_one() {
        // R-346 review: 20 × 8 × 24 in on a 48 × 40 pallet under 58 in holds 28 (2 layers of 12
        // standing, 4 lying on top). Shared pallets must get the same, not 24 and a new pallet.
        let t = ty("tall", 48, size(20.0, 8.0, 24.0, true));
        let spec = pallet(48.0, 40.0, 0.0, 58.0);
        assert_eq!(capacities(&spec, &[t.clone()]).unwrap()[0].boxes, 28);
        for (n, want) in [(28, 1), (56, 2)] {
            let r = fit(&FitRequest { pallet: spec.clone(), types: vec![t.clone()], groups: vec![g("owls", "tall", n)], big_alone: false }).unwrap();
            assert_eq!(r.pallets.len(), want, "{n} boxes");
            for p in &r.pallets {
                assert!(check(&spec, &[t.clone()], &p.boxes).is_empty());
            }
        }
        // And when a bigger size has pallets of its own.
        let big = ty("big", 72, size(24.0, 20.0, 12.0, false));
        let r = fit(&FitRequest { pallet: spec.clone(), types: vec![big.clone(), t.clone()], groups: vec![g("owls", "big", 4), g("owls", "tall", 28)], big_alone: true }).unwrap();
        assert_eq!(r.pallets.len(), 2);
        assert!(r.pallets.iter().all(|p| check(&spec, &[big.clone(), t.clone()], &p.boxes).is_empty()));
    }

    #[test]
    fn one_pallet_or_a_reason() {
        let t = vec![ty("big", 72, size(24.0, 20.0, 12.0, false)), ty("tiny", 12, size(12.0, 10.0, 8.0, false))];
        let spec = pallet(48.0, 40.0, 6.0, 60.0);
        // 24 big boxes is 16 + 8 at 4 a layer under 54 in — it does not go on one.
        let e = fit_one(&spec, &t, &[g("owls", "big", 12), g("hawks", "big", 12)]).unwrap_err();
        assert!(e.contains("needs 2"), "{e}");
        let p = fit_one(&spec, &t, &[g("owls", "big", 8), g("hawks", "big", 4), g("owls", "tiny", 10)]).unwrap();
        assert_eq!(p.boxes.len(), 22);
        assert!(check(&spec, &t, &p.boxes).is_empty());
        assert!(fit_one(&spec, &t, &[]).is_err());
    }

    #[test]
    fn pallet_records_add_up_combine_and_get_a_picture_only_when_they_fit() {
        let line = |sec: &str, t: &str, per: i64, n: i64| PalletLine { section_id: sec.into(), name: sec.to_uppercase(), type_id: t.into(), type_name: t.into(), per_box: per, boxes: n };
        let a = vec![line("owls", "big", 72, 8), line("owls", "big", 72, 4), line("hawks", "tiny", 12, 0)];
        let c = clean_lines(&a).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].boxes, 12);
        assert!(clean_lines(&[line("owls", "big", 72, -1)]).is_err());
        assert!(clean_lines(&[]).is_err());
        let m = merge_lines(&[c.clone(), vec![line("hawks", "big", 72, 4), line("owls", "big", 72, 2)]]).unwrap();
        assert_eq!(m.iter().map(|l| (l.name.as_str(), l.boxes)).collect::<Vec<_>>(), vec![("OWLS", 14), ("HAWKS", 4)]);

        let mut setup = PalletSetup::default();
        // Unmeasured: the record stands, no picture.
        assert_eq!(plan_lines(&setup, &m).unwrap(), None);
        // 66 in of load: 5 layers of 4 = 20 Big Box a pallet.
        setup.pallet = pallet(48.0, 40.0, 6.0, 72.0);
        setup.boxes.insert("big".into(), size(24.0, 20.0, 12.0, false));
        let p = plan_lines(&setup, &m).unwrap().unwrap();
        assert_eq!(p.pallet.boxes.len(), 18);
        // Too many for one pallet: an error, not a picture.
        assert!(plan_lines(&setup, &[line("owls", "big", 72, 21)]).is_err());
        // A plan sent in is kept only when it holds these lines and checks.
        let kept = keep_or_plan(&setup, &m, Some(p.clone())).unwrap().unwrap();
        assert_eq!(kept, p);
        let mut wrong = p.clone();
        wrong.pallet.boxes.pop();
        let redone = keep_or_plan(&setup, &m, Some(wrong)).unwrap().unwrap();
        assert_eq!(redone.pallet.boxes.len(), 18);
    }

    #[test]
    fn the_layer_search_finds_the_box_the_patterns_miss() {
        // R-346 review: a 44 × 40 pallet holds 9 boxes of 12 × 16, not the 8 the patterns found.
        let (v, best) = best_layer(4400, 4000, 1200, 1600);
        assert_eq!(v.len(), 9);
        assert!(best && valid_layer(&v, 4400, 4000));
    }

    /// The slowest layers to search: time them, so a change that makes the search crawl shows.
    #[test]
    fn the_hardest_layers_search_in_time() {
        let mut rng = Rng(0xA5A5_5A5A_1234_4321);
        let mut worst = std::time::Duration::ZERO;
        for _ in 0..60 {
            let (pl, pw) = (rng.range(3600, 5600), rng.range(3000, 4800));
            let (a, b) = (rng.range(700, 2000), rng.range(700, 2000));
            let t = std::time::Instant::now();
            let (v, _) = best_layer(pl, pw, a, b);
            worst = worst.max(t.elapsed());
            assert!(valid_layer(&v, pl, pw));
        }
        println!("slowest layer: {worst:?}");
    }

    #[test]
    fn a_full_pallet_of_big_boxes_is_as_high_as_it_may_go_and_checks() {
        // 48 × 40 pallet, 6 in deck, 60 in from the floor: 54 in of load; boxes 24 × 20 × 12.
        let t = ty("big", 72, size(24.0, 20.0, 12.0, false));
        let caps = capacities(&pallet(48.0, 40.0, 6.0, 60.0), &[t]).unwrap();
        assert_eq!(caps[0].per_layer, 4);
        assert_eq!(caps[0].layers, 4); // 4 × 12 = 48 of 54 in
        assert_eq!(caps[0].boxes, 16);
        assert_eq!(caps[0].total_height, 54.0);
        assert!(caps[0].layer_is_best);
    }

    #[test]
    fn a_size_that_may_lie_on_its_side_uses_the_room_left_on_top() {
        // Standing up: 4 a layer, 4 layers (48 in), 6 in spare. On its side it is 10 in high,
        // not 6 — so nothing goes on top here; with 60 in of load it fits one more layer lying down.
        let t = ty("big", 72, size(24.0, 20.0, 12.0, true));
        let caps = capacities(&pallet(48.0, 40.0, 0.0, 58.0), &[t.clone()]).unwrap();
        let c = &caps[0];
        assert!(c.boxes >= 16);
        assert!(c.total_height <= 58.0);
        assert!(check(&pallet(48.0, 40.0, 0.0, 58.0), &[t], &c.pallet.boxes).is_empty());
    }

    #[test]
    fn a_standing_size_is_never_laid_down() {
        let t = ty("big", 72, size(24.0, 20.0, 12.0, false));
        let caps = capacities(&pallet(48.0, 40.0, 0.0, 70.0), &[t]).unwrap();
        assert!(caps[0].pallet.boxes.iter().all(|b| b.h == 12.0 && !b.on_side));
    }

    #[test]
    fn big_boxes_go_alone_and_the_rest_together_every_box_once() {
        let types = vec![
            ty("big", 72, size(24.0, 20.0, 12.0, false)),
            ty("sq", 48, size(20.0, 16.0, 12.0, false)),
            ty("tiny", 12, size(12.0, 10.0, 8.0, false)),
        ];
        let req = FitRequest {
            pallet: pallet(48.0, 40.0, 6.0, 60.0),
            types: types.clone(),
            groups: vec![g("owls", "big", 20), g("hawks", "big", 7), g("owls", "sq", 9), g("bears", "tiny", 30), g("hawks", "sq", 3)],
            big_alone: true,
        };
        let r = fit(&req).unwrap();
        let bigs: Vec<&FitPallet> = r.pallets.iter().filter(|p| p.boxes.iter().any(|b| b.type_id == "big")).collect();
        assert!(bigs.iter().all(|p| p.boxes.iter().all(|b| b.type_id == "big")), "big boxes alone");
        assert_eq!(bigs.len(), 2); // 27 at 16 a pallet
        let n = |id: &str, sec: &str| r.pallets.iter().flat_map(|p| &p.boxes).filter(|b| b.type_id == id && b.section_id == sec).count();
        assert_eq!((n("big", "owls"), n("big", "hawks"), n("sq", "owls"), n("sq", "hawks"), n("tiny", "bears")), (20, 7, 9, 3, 30));
        for p in &r.pallets {
            assert!(check(&req.pallet, &types, &p.boxes).is_empty());
            assert!(p.total_height <= 60.0);
        }
    }

    #[test]
    fn the_check_catches_every_broken_rule() {
        let t = vec![ty("big", 72, size(24.0, 20.0, 12.0, false))];
        let spec = pallet(48.0, 40.0, 6.0, 60.0);
        let b = |x: f64, y: f64, z: f64, l: f64, w: f64, h: f64| Placed { type_id: "big".into(), x, y, z, l, w, h, layer: 1, ..Default::default() };
        assert!(check(&spec, &t, &[b(0.0, 0.0, 0.0, 24.0, 20.0, 12.0)]).is_empty());
        assert!(!check(&spec, &t, &[b(30.0, 0.0, 0.0, 24.0, 20.0, 12.0)]).is_empty(), "past the edge");
        assert!(!check(&spec, &t, &[b(0.0, 0.0, 44.0, 24.0, 20.0, 12.0)]).is_empty(), "too high");
        assert!(!check(&spec, &t, &[b(0.0, 0.0, 0.0, 24.0, 20.0, 12.0), b(10.0, 5.0, 0.0, 24.0, 20.0, 12.0)]).is_empty(), "overlap");
        assert!(!check(&spec, &t, &[b(0.0, 0.0, 12.0, 24.0, 20.0, 12.0)]).is_empty(), "floating");
        // Half on a box, half over nothing.
        assert!(!check(&spec, &t, &[b(0.0, 0.0, 0.0, 24.0, 20.0, 12.0), b(12.0, 0.0, 12.0, 24.0, 20.0, 12.0)]).is_empty());
        assert!(!check(&spec, &t, &[b(0.0, 0.0, 0.0, 12.0, 20.0, 24.0)]).is_empty(), "on its side");
        assert!(!check(&spec, &t, &[b(0.0, 0.0, 0.0, 25.0, 20.0, 12.0)]).is_empty(), "wrong size");
    }

    #[test]
    fn what_cannot_fit_says_so_instead_of_guessing() {
        let t = vec![ty("big", 72, size(50.0, 42.0, 12.0, false))];
        let e = fit(&FitRequest { pallet: pallet(48.0, 40.0, 6.0, 60.0), types: t, groups: vec![g("owls", "big", 1)], big_alone: true }).unwrap_err();
        assert!(e.contains("does not fit"), "{e}");
        let t = vec![ty("big", 72, size(0.0, 20.0, 12.0, false))];
        assert!(fit(&FitRequest { pallet: pallet(48.0, 40.0, 6.0, 60.0), types: t, groups: vec![g("owls", "big", 1)], big_alone: true }).unwrap_err().contains("Enter the length"));
        assert!(fit(&FitRequest { pallet: pallet(48.0, 40.0, 60.0, 60.0), ..Default::default() }).unwrap_err().contains("must be above"));
    }

    #[test]
    fn random_loads_always_check_and_place_every_box() {
        let mut rng = Rng(0xD1B54A32D192ED03);
        for case in 0..120 {
            let spec = pallet(rng.range(36, 56) as f64, rng.range(30, 48) as f64, rng.range(0, 7) as f64, rng.range(40, 96) as f64);
            let n_types = rng.range(1, 5) as usize;
            let mut types = Vec::new();
            for k in 0..n_types {
                let s = size(rng.range(600, 3000) as f64 / 100.0, rng.range(500, 2400) as f64 / 100.0, rng.range(400, 1800) as f64 / 100.0, rng.range(0, 3) == 0);
                types.push(ty(&format!("t{k}"), [72, 48, 36, 24, 12][k], s));
            }
            let mut groups = Vec::new();
            for (k, t) in types.iter().enumerate() {
                for sec in 0..rng.range(1, 4) {
                    groups.push(g(&format!("s{sec}"), &t.type_id, rng.range(0, 45) + k as i64));
                }
            }
            let req = FitRequest { pallet: spec.clone(), types: types.clone(), groups: groups.clone(), big_alone: rng.range(0, 1) == 1 };
            match fit(&req) {
                Ok(r) => {
                    for p in &r.pallets {
                        let bad = check(&spec, &types, &p.boxes);
                        assert!(bad.is_empty(), "case {case}: {bad:?}");
                        assert!(p.total_height <= spec.max_height + 1e-9);
                    }
                    for gr in &groups {
                        let want: i64 = groups.iter().filter(|x| x.type_id == gr.type_id && x.section_id == gr.section_id).map(|x| x.boxes).sum();
                        let got = r.pallets.iter().flat_map(|p| &p.boxes).filter(|b| b.type_id == gr.type_id && b.section_id == gr.section_id).count() as i64;
                        assert_eq!(want, got, "case {case}");
                    }
                }
                Err(e) => assert!(e.contains("does not fit"), "case {case}: {e}"),
            }
        }
    }
}

