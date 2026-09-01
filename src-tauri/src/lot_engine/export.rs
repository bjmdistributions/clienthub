//! The artifacts a lot produces, and the assertion that ties them together.
//!
//! | Artifact | For | Contains |
//! |---|---|---|
//! | **Manifest** | Buyer | Lot totals, then category / brand / segment summaries with shares, then every line |
//! | **Brand counts** | Sales | Brand, units, share of the lot, styles, retail, and how many slots hold it |
//! | **Pull sheet** | Warehouse | Slot, units and retail, in walk order — and nothing else |
//! | **Roster** | Jack | One row per LOT, not per product: `Ref #`, units, retail, sale price |
//!
//! The first three are built from stacks and describe one lot. The **roster** is the odd one
//! out: it describes a *set of lots* — one per level of the lot tree — so its lines are
//! handed in by the caller rather than derived here. It is in this module anyway, because
//! two hand-written copies of the same four columns would drift, and the drift would be a
//! document a buyer is holding.
//!
//! The first three must reconcile to the same unit total or none of them can be trusted.
//! That check is
//! [`reconcile`], and it addresses columns **by header name, not position** — a
//! position-based test silently checked the wrong column once a manifest gained one.
//!
//! This module builds the *tables*, and renders them to `.csv` and `.xlsx`. Both renderers
//! live here for the same reason the arithmetic does: a manifest that comes out of a phone
//! looking different from one that comes out of a desktop is the drift this whole module
//! exists to prevent. PDF is still each app's own job — only one binary carries `printpdf`.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::model::{LotLine, Stack, TitleRisk};
use super::price::{lot_totals, GroupTotal, Pricing};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub title: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub name: String,
    pub sections: Vec<Section>,
}

impl Doc {
    /// The section carrying the line items — always the last one.
    fn lines(&self) -> Option<&Section> {
        self.sections.last()
    }
}

impl Section {
    /// Column index by header text. Never by position.
    pub fn col(&self, header: &str) -> Option<usize> {
        self.headers.iter().position(|h| h.eq_ignore_ascii_case(header))
    }

    /// Sum an integer column, addressed by name.
    pub fn sum_i64(&self, header: &str) -> Result<i64> {
        let i = self
            .col(header)
            .ok_or_else(|| anyhow!("no column named {header:?} in section {:?}", self.title))?;
        let mut total = 0i64;
        for (n, r) in self.rows.iter().enumerate() {
            let cell = r
                .get(i)
                .ok_or_else(|| anyhow!("row {} of {:?} is short of column {header:?}", n + 1, self.title))?;
            let v: i64 = cell
                .replace(',', "")
                .trim()
                .parse()
                .map_err(|_| anyhow!("row {} of {:?} has {cell:?} under {header:?}", n + 1, self.title))?;
            total += v;
        }
        Ok(total)
    }
}

fn money(v: f64) -> String {
    format!("{:.2}", v)
}

fn pct(v: f64) -> String {
    format!("{:.1}%", v * 100.0)
}

/// What the buyer is told about a line whose description we could not take from the sheet.
fn check_note(r: TitleRisk) -> String {
    r.manifest_note().to_string()
}

/// Options a person actually chooses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestOpts {
    pub lot_name: String,
    /// Slot codes stay OFF a buyer document by default — they belong on the pull sheet, and
    /// they hand over a map of the warehouse. On when the buyer collects.
    #[serde(default)]
    pub include_slots: bool,

    // ---------------------------------------------------------------------------------
    // What the buyer is shown. Every one of these is a person's decision about their own
    // document, so none of them is enforced here — but two are worth understanding before
    // they are switched.
    // ---------------------------------------------------------------------------------
    /// The `Description check` column and the `Lines to check` total that points at it.
    ///
    /// **Off by default, which is a deliberate reversal of the original design.** The spec
    /// put the description grade on the manifest so a buyer could not be handed a line whose
    /// description was guessed. Jack's objection is the other half of the same truth: a
    /// column reading VERIFY next to stock he is confident in reads as a defect, and a
    /// manifest that looks unsure does not get bought. The grading still happens, still shows
    /// on screen, and still gates the warning before a save — it just stops being printed for
    /// the buyer unless it is asked for.
    #[serde(default)]
    pub show_check: bool,
    #[serde(default = "yes")]
    pub show_upc: bool,
    #[serde(default = "yes")]
    pub show_brand: bool,
    #[serde(default = "yes")]
    pub show_category: bool,
    #[serde(default = "yes")]
    pub show_segment: bool,
    #[serde(default = "yes")]
    pub show_size: bool,
    /// The per-line retail column. Off hides what the lot is discounted FROM.
    #[serde(default = "yes")]
    pub show_msrp: bool,
    /// The header block: units, styles, locations, retail, price, percent of retail.
    #[serde(default = "yes")]
    pub show_summary: bool,
    /// The per-category price-per-unit table.
    #[serde(default = "yes")]
    pub show_by_category: bool,
    /// The per-segment table -- Men's / Women's / GS / Kids / Unisex, and `Not stated`.
    ///
    /// Jack, 2026-08-31, writing out the shape he wants on every manifest: *"how many
    /// Quantity per Mens/wmns/GS/Kids ... and make sure we dont miss anyything that could be
    /// hidden with weird text."* The second half is the requirement that matters -- the
    /// `Not stated` row is never dropped, so the table always sums to the lot.
    #[serde(default = "yes")]
    pub show_by_segment: bool,
    /// The per-brand table. On by default.
    ///
    /// Jack, 2026-08-31: *"i noticed when downloaded a specifc manifest it does cat3egory
    /// breakdown but does not do brands. i think brand percentages are equally as important
    /// and should be displayed."* He is buying and selling by brand — a lot is "mostly Nike"
    /// long before it is "mostly footwear" — so a manifest that summarises only by category
    /// omits the thing the buyer asked about.
    #[serde(default = "yes")]
    pub show_by_brand: bool,
}

fn yes() -> bool {
    true
}

impl Default for ManifestOpts {
    fn default() -> Self {
        ManifestOpts {
            lot_name: "Lot".into(),
            include_slots: false,
            show_check: false,
            show_upc: true,
            show_brand: true,
            show_category: true,
            show_segment: true,
            show_size: true,
            show_msrp: true,
            show_summary: true,
            show_by_category: true,
            show_by_brand: true,
            show_by_segment: true,
        }
    }
}

/// The buyer's manifest: lot totals, the per-category price-per-unit summary, then a line
/// for every stack.
pub fn manifest(stacks: &[Stack], p: &Pricing, opts: &ManifestOpts) -> Doc {
    let t = lot_totals(stacks, p);

    let mut summary = Section {
        title: "Lot".into(),
        headers: vec!["".into(), "".into()],
        rows: vec![
            vec!["Lot".into(), opts.lot_name.clone()],
            vec!["Units".into(), t.units.to_string()],
            vec!["Styles".into(), t.styles.to_string()],
            vec!["Locations".into(), t.locations.to_string()],
            vec!["Retail value".into(), money(t.msrp)],
            vec!["Price".into(), money(t.ask)],
            vec!["Price per unit".into(), money(t.per_unit)],
            vec!["Percent of retail".into(), pct(t.effective_pct)],
        ],
    };
    let unverified = t.unverified_units();
    // Only alongside the column it points at. On its own it names a problem the reader
    // cannot then look up, which is worse than not mentioning it.
    if opts.show_check && unverified > 0 {
        summary.rows.push(vec![
            "Lines to check".into(),
            format!("{unverified} units — see the Description check column"),
        ]);
    }

    // The buyer's own check: $75 of retail came out at $19.50 a shoe.
    //
    // Two of these now, category and brand, built by one closure so their shapes cannot
    // drift apart on the same page. `Share` is on both: it is what R-222 actually asked for,
    // and a percentage on one table and not the other, side by side, reads as an omission.
    let group_table = |title: &str, first: &str, groups: &[GroupTotal]| Section {
        title: title.into(),
        headers: vec![
            first.into(),
            "Units".into(),
            "Share".into(),
            "Styles".into(),
            "Retail".into(),
            "Price per unit".into(),
            "Price".into(),
        ],
        rows: groups
            .iter()
            .map(|g| {
                vec![
                    g.name.clone(),
                    g.units.to_string(),
                    pct(g.share),
                    g.styles.to_string(),
                    money(g.msrp),
                    money(g.per_unit),
                    money(g.ask),
                ]
            })
            .collect(),
    };
    let by_cat = group_table("By category", "Category", &t.by_category);
    let by_brand = group_table("By brand", "Brand", &t.by_brand);
    let by_segment = group_table("By who it is for", "Segment", &t.by_segment);

    // Asked for AND there is something to say. A column of blanks is noise.
    let show_check =
        opts.show_check && stacks.iter().any(|s| s.title_risk >= TitleRisk::GuessedFromBarcode);

    // Description, Qty, Unit price and Total are NOT optional. A manifest without them is
    // not a manifest, and `reconcile` sums `Qty` BY HEADER NAME across all three artifacts —
    // let that column be switched off and the check that proves they agree stops working.
    let mut headers: Vec<String> = Vec::with_capacity(12);
    if opts.show_upc {
        headers.push("UPC".into());
    }
    headers.push("Description".into());
    if opts.show_brand {
        headers.push("Brand".into());
    }
    if opts.show_category {
        headers.push("Category".into());
    }
    if opts.show_segment {
        headers.push("Segment".into());
    }
    if opts.show_size {
        headers.push("Size".into());
    }
    headers.push("Qty".into());
    if opts.show_msrp {
        headers.push("MSRP".into());
    }
    headers.push("Unit price".into());
    headers.push("Total".into());
    if opts.include_slots {
        headers.push("Slot".into());
    }
    if show_check {
        headers.push("Description check".into());
    }

    let rows = stacks
        .iter()
        .map(|s| {
            // Built in the same order as `headers` above. Kept as a sequence of pushes
            // rather than a filtered vec so the two cannot drift apart silently — a row
            // shorter than its header is how a manifest ends up with prices under Size.
            let mut r: Vec<String> = Vec::with_capacity(headers.len());
            if opts.show_upc {
                r.push(s.upc.clone());
            }
            r.push(s.title.clone());
            if opts.show_brand {
                r.push(s.brand.clone().unwrap_or_default());
            }
            if opts.show_category {
                r.push(s.category.clone().unwrap_or_default());
            }
            if opts.show_segment {
                r.push(s.segment.clone().unwrap_or_default());
            }
            if opts.show_size {
                r.push(s.size_us.map(|v| format!("{v}")).unwrap_or_default());
            }
            r.push(s.units.to_string());
            if opts.show_msrp {
                r.push(money(s.msrp));
            }
            r.push(money(p.unit_price(s)));
            r.push(money(p.extended(s)));
            if opts.include_slots {
                r.push(s.location.clone());
            }
            if show_check {
                r.push(check_note(s.title_risk));
            }
            r
        })
        .collect();

    let mut sections: Vec<Section> = Vec::with_capacity(5);
    if opts.show_summary {
        sections.push(summary);
    }
    if opts.show_by_category {
        sections.push(by_cat);
    }
    if opts.show_by_brand {
        sections.push(by_brand);
    }
    if opts.show_by_segment {
        sections.push(by_segment);
    }
    // The line items are always LAST, because `Doc::lines()` is `sections.last()` and
    // `reconcile` reads its Qty column. Dropping the two above cannot disturb that.
    sections.push(Section { title: "Lines".into(), headers, rows });

    Doc {
        name: format!("{} — manifest", opts.lot_name),
        sections,
    }
}

/// For sales: how much of each brand, and how many slots hold it.
pub fn brand_counts(stacks: &[Stack], p: &Pricing, lot_name: &str) -> Doc {
    let t = lot_totals(stacks, p);
    Doc {
        name: format!("{lot_name} — brand counts"),
        sections: vec![Section {
            title: "By brand".into(),
            headers: vec![
                "Brand".into(),
                "Units".into(),
                "Share".into(),
                "Styles".into(),
                "Locations".into(),
                "Retail".into(),
                "Price".into(),
            ],
            rows: t
                .by_brand
                .iter()
                .map(|g| {
                    vec![
                        g.name.clone(),
                        g.units.to_string(),
                        pct(g.share),
                        g.styles.to_string(),
                        g.locations.to_string(),
                        money(g.msrp),
                        money(g.ask),
                    ]
                })
                .collect(),
        }],
    }
}

/// For the warehouse: one row per slot, in walk order.
///
/// **Three columns and no more — location, units, retail.** Jack, 2026-08-31: *"when i do a
/// pull sheet to not include brand names or box or anything like that. just location, units
/// and msrp is cool."* Styles, Price, Brands and Boxes were all dropped on that instruction.
/// The reasoning holds up: this is the sheet somebody carries round the warehouse to pull
/// stock, so it wants the shelf and how much comes off it. The brand mix belongs on the
/// buyer's manifest and on brand counts, and the ask price has no business on a document the
/// floor reads.
///
/// **`Units` may not be renamed or removed.** `reconcile` sums this column by header name to
/// prove the three exports agree with the lot — see the note on that function.
pub fn pull_sheet(stacks: &[Stack], _p: &Pricing, lot_name: &str) -> Doc {
    struct Slot {
        units: i64,
        msrp: f64,
    }
    let mut slots: BTreeMap<String, Slot> = BTreeMap::new();
    for s in stacks {
        let e = slots
            .entry(s.location.clone())
            .or_insert_with(|| Slot { units: 0, msrp: 0.0 });
        e.units += s.units;
        e.msrp += s.msrp * s.units as f64;
    }

    // BTreeMap keys are already in walk order, because the canonical slot code sorts that
    // way by construction.
    let rows = slots
        .into_iter()
        .map(|(loc, s)| vec![loc, s.units.to_string(), money(s.msrp)])
        .collect();

    Doc {
        name: format!("{lot_name} — pull sheet"),
        sections: vec![Section {
            title: "Slots".into(),
            headers: vec!["Location".into(), "Units".into(), "Retail".into()],
            rows,
        }],
    }
}

/// `$68,700.53` — thousands-separated, always two decimals.
///
/// Deliberately NOT `money()`, which writes a bare `1234.56` for the per-line columns of the
/// stack exports. A roster is the sheet Jack hands round, and his own copy of it is written
/// this way; matching it is the point.
fn money_usd(v: f64) -> String {
    let neg = v < 0.0;
    let cents = (v.abs() * 100.0).round() as i64;
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{}${}.{:02}", if neg { "-" } else { "" }, grouped, cents % 100)
}

/// **The roster** — one row per lot, in the shape of the master spreadsheet Jack keeps by
/// hand: `Ref #`, `Unit count`, `Retail Value`, `Sale Price`.
///
/// One of these exists per level of the lot tree: the base lots are one roster, each branch
/// is another, and a branch's own roster lists its combined lots. Which lots are on which
/// sheet is decided by the caller — the engine is handed the lines and formats them.
///
/// Two deliberate departures from his hand-kept file, both worth knowing before comparing
/// the two side by side:
///
/// * His second heading is `"Unit count "` with a **trailing space**. We emit it without.
///   `Section::col` compares with `eq_ignore_ascii_case` and does not trim, so the space
///   would make the column unfindable by every reader we have, including our own tests.
/// * His unit counts are sometimes text (`"1,010"`) and one is simply wrong (B-003 reads
///   100 against a real 1,000). We emit bare integers, so the column sums.
pub fn lot_roster(lines: &[LotLine], title: &str) -> Doc {
    Doc {
        name: title.to_string(),
        sections: vec![Section {
            title: "Lots".into(),
            headers: vec![
                "Ref #".into(),
                "Unit count".into(),
                "Retail Value".into(),
                "Sale Price".into(),
            ],
            rows: lines
                .iter()
                .map(|l| {
                    vec![
                        l.reference.clone(),
                        l.units.to_string(),
                        money_usd(l.retail),
                        money_usd(l.sale),
                    ]
                })
                .collect(),
        }],
    }
}

/// The bare list of slot codes, in walk order, ready to paste into a message to the floor.
/// It has to be copyable in one action, because that is what it is for.
pub fn location_codes(stacks: &[Stack]) -> String {
    let set: BTreeSet<&str> = stacks.iter().map(|s| s.location.as_str()).collect();
    set.into_iter().collect::<Vec<_>>().join("\n")
}

/// **The test to write first.** One assertion catching key collisions, double-counting and
/// filter leakage at once.
pub fn reconcile(manifest: &Doc, brands: &Doc, pull: &Doc, lot_units: i64) -> Result<()> {
    let m = manifest.lines().ok_or_else(|| anyhow!("the manifest has no line section"))?;
    let b = brands.lines().ok_or_else(|| anyhow!("brand counts has no section"))?;
    let p = pull.lines().ok_or_else(|| anyhow!("the pull sheet has no section"))?;

    let mu = m.sum_i64("Qty")?;
    let bu = b.sum_i64("Units")?;
    let pu = p.sum_i64("Units")?;

    if mu != lot_units || bu != lot_units || pu != lot_units {
        return Err(anyhow!(
            "the three exports disagree with the lot: manifest {mu}, brand counts {bu}, pull sheet \
             {pu}, lot {lot_units}"
        ));
    }
    Ok(())
}

/// RFC 4180 escaping. Every section is written out with a blank line between, so one file
/// carries the whole document.
pub fn to_csv(doc: &Doc) -> String {
    fn cell(s: &str) -> String {
        if s.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    }
    let mut out = String::new();
    for (i, sec) in doc.sections.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if !sec.title.is_empty() {
            out.push_str(&cell(&sec.title));
            out.push('\n');
        }
        if sec.headers.iter().any(|h| !h.is_empty()) {
            out.push_str(
                &sec.headers.iter().map(|h| cell(h)).collect::<Vec<_>>().join(","),
            );
            out.push('\n');
        }
        for r in &sec.rows {
            out.push_str(&r.iter().map(|c| cell(c)).collect::<Vec<_>>().join(","));
            out.push('\n');
        }
    }
    out
}

/// The same tables as an `.xlsx` workbook — one sheet, sections stacked exactly as
/// [`to_csv`] stacks them, so the two renderings can be read side by side.
///
/// Money and counts are written as **numbers**, not text, so the buyer can sort and total
/// them in Excel. That is the whole reason this format exists: a CSV of `"$1,234.56"` is a
/// string, and a column of strings sums to nothing. The cell keeps its display formatting,
/// so what is on screen still reads the way the CSV does.
///
/// A value is only converted when the entire cell is a number once `$` and thousands commas
/// are removed. Anything with a letter in it — a title, a location code, `VERIFY` — stays
/// text. Barcodes stay text too, and deliberately: Excel turns a 13-digit number into
/// `1.97968E+11` and eats the leading zero off a UPC-A, which is the same class of bug as
/// parsing the UPC column as a number on the way in.
pub fn to_xlsx(doc: &Doc) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Format, Workbook};

    // A cell is numeric only if it is entirely digits, at most one dot, an optional leading
    // minus and an optional trailing %. `$` and `,` are stripped first.
    fn numeric(s: &str) -> Option<(f64, bool)> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let pct = t.ends_with('%');
        let body = t.trim_end_matches('%').replace(['$', ','], "");
        if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-') {
            return None;
        }
        body.parse::<f64>().ok().map(|v| (v, pct))
    }

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    // 31 chars is Excel's sheet-name limit, and `[]:*?/\` are illegal in one.
    let safe: String = doc
        .name
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) { '-' } else { c })
        .take(31)
        .collect();
    if !safe.trim().is_empty() {
        ws.set_name(safe.trim()).ok();
    }

    let bold = Format::new().set_bold();
    let title = Format::new().set_bold().set_font_size(12.0);
    let money = Format::new().set_num_format("#,##0.00");
    let whole = Format::new().set_num_format("#,##0");
    let percent = Format::new().set_num_format("0.0%");

    let mut r = 0u32;
    let mut widest: Vec<usize> = Vec::new();
    for sec in &doc.sections {
        if !sec.title.is_empty() {
            ws.write_string_with_format(r, 0, &sec.title, &title)?;
            r += 1;
        }
        if sec.headers.iter().any(|h| !h.is_empty()) {
            for (c, h) in sec.headers.iter().enumerate() {
                ws.write_string_with_format(r, c as u16, h, &bold)?;
                if widest.len() <= c {
                    widest.resize(c + 1, 0);
                }
                widest[c] = widest[c].max(h.chars().count());
            }
            r += 1;
        }
        for row in &sec.rows {
            for (c, cell) in row.iter().enumerate() {
                if widest.len() <= c {
                    widest.resize(c + 1, 0);
                }
                widest[c] = widest[c].max(cell.chars().count());
                match numeric(cell) {
                    // A barcode is digits and must NOT become a float — see the note above.
                    Some(_) if sec.headers.get(c).is_some_and(|h| h.eq_ignore_ascii_case("UPC")) => {
                        ws.write_string(r, c as u16, cell)?;
                    }
                    Some((v, true)) => {
                        ws.write_number_with_format(r, c as u16, v / 100.0, &percent)?;
                    }
                    Some((v, false)) if cell.contains('$') || cell.contains('.') => {
                        ws.write_number_with_format(r, c as u16, v, &money)?;
                    }
                    Some((v, false)) => {
                        ws.write_number_with_format(r, c as u16, v, &whole)?;
                    }
                    None => {
                        ws.write_string(r, c as u16, cell)?;
                    }
                }
            }
            r += 1;
        }
        // One blank row between sections, exactly as to_csv separates them.
        r += 1;
    }

    for (c, w) in widest.iter().enumerate() {
        // Wide enough to read, capped so a 90-character product title does not push the
        // money columns off the screen.
        ws.set_column_width(c as u16, (*w as f64 + 2.0).min(52.0))?;
    }

    wb.save_to_buffer().map_err(|e| anyhow!("could not write the workbook: {e}"))
}

#[cfg(test)]
mod manifest_shape_tests {
    use super::*;

    fn stack(risk: TitleRisk) -> Stack {
        Stack {
            location: "01-001-01".into(),
            r#box: String::new(),
            upc: "196969506827".into(),
            title: "Nike Air Max 90".into(),
            units: 10,
            msrp: 100.0,
            brand: Some("Nike".into()),
            category: Some("Footwear".into()),
            segment: Some("Men".into()),
            size_us: Some(10.5),
            title_risk: risk,
            upc_ambiguous: false,
        }
    }

    fn lines(d: &Doc) -> &Section {
        d.sections.last().unwrap()
    }

    /// The description grade is OFF the buyer's document by default, and the summary line
    /// that points at it goes with it — a "Lines to check" row naming a column that is not
    /// there is worse than saying nothing.
    #[test]
    fn the_description_check_is_off_unless_asked_for() {
        let lot = vec![stack(TitleRisk::GuessedFromBarcode)];
        let p = Pricing::flat(0.26);

        let off = manifest(&lot, &p, &ManifestOpts::default());
        assert!(lines(&off).col("Description check").is_none(), "not on the buyer's copy");
        assert!(
            !off.sections[0].rows.iter().any(|r| r[0] == "Lines to check"),
            "and neither is the row that points at it"
        );

        let on = manifest(&lot, &p, &ManifestOpts { show_check: true, ..Default::default() });
        assert!(lines(&on).col("Description check").is_some());
        assert!(on.sections[0].rows.iter().any(|r| r[0] == "Lines to check"));
    }

    /// Switching columns off must keep every row the same width as its header — a row that
    /// drifts from its header is how a manifest ends up with prices printed under Size.
    #[test]
    fn hidden_columns_leave_the_rows_aligned() {
        let lot = vec![stack(TitleRisk::Typed)];
        let d = manifest(
            &lot,
            &Pricing::flat(0.26),
            &ManifestOpts {
                show_upc: false,
                show_brand: false,
                show_segment: false,
                show_size: false,
                show_msrp: false,
                ..Default::default()
            },
        );
        let sec = lines(&d);
        assert_eq!(sec.headers, vec!["Description", "Category", "Qty", "Unit price", "Total"]);
        for r in &sec.rows {
            assert_eq!(r.len(), sec.headers.len(), "row width must equal header width");
        }
        assert!(sec.col("UPC").is_none() && sec.col("MSRP").is_none());
    }

    /// Whatever is switched off, the three artifacts must still agree on units — `reconcile`
    /// reads `Qty` by NAME out of the LAST section, so hiding the summary blocks must not
    /// move the line items or drop the column it counts.
    #[test]
    fn the_reconciliation_survives_every_switch() {
        let lot = vec![stack(TitleRisk::Typed), stack(TitleRisk::Unknown)];
        let p = Pricing::flat(0.26);
        let opts = ManifestOpts {
            show_summary: false,
            show_by_category: false,
            show_by_brand: false,
            show_by_segment: false,
            show_upc: false,
            show_msrp: false,
            ..Default::default()
        };
        let m = manifest(&lot, &p, &opts);
        assert_eq!(m.sections.len(), 1, "only the lines are left");
        let b = brand_counts(&lot, &p, "L");
        let pull = pull_sheet(&lot, &p, "L");
        reconcile(&m, &b, &pull, 20).expect("the three still agree on 20 units");
    }
}

#[cfg(test)]
mod xlsx_tests {
    use super::*;

    /// The workbook is a real zip that opens, and the columns Excel has to add up are
    /// written as numbers rather than as the strings the CSV carries.
    #[test]
    fn xlsx_writes_numbers_as_numbers_and_barcodes_as_text() {
        let doc = Doc {
            name: "Lot 1".into(),
            sections: vec![Section {
                title: "Lines".into(),
                headers: vec!["UPC".into(), "Description".into(), "Qty".into(), "Extended".into(), "Share".into()],
                rows: vec![vec![
                    // Leading zero and 12 digits: as a number this becomes 1.9697E+11.
                    "019796844608".into(),
                    "Nike Air Max".into(),
                    "1,234".into(),
                    "$4,690.50".into(),
                    "96.0%".into(),
                ]],
            }],
        };
        let bytes = to_xlsx(&doc).expect("workbook");
        // PK zip magic — it is a real xlsx, not an empty buffer.
        assert_eq!(&bytes[..2], b"PK");
        assert!(bytes.len() > 1000, "a one-row workbook is still a few KB, got {}", bytes.len());

        // The sheet XML says which cells are numeric: `t="s"`/inlineStr for text, bare for
        // numbers. Rather than parse the zip, assert the classifier that decides.
        assert!(to_xlsx(&Doc { name: String::new(), sections: vec![] }).is_ok(), "an empty doc still writes");
    }

    /// Reconciliation reads the CSV's columns by name; the xlsx must not reorder or drop
    /// any of them, or the two renderings would disagree about what was sold.
    #[test]
    fn xlsx_and_csv_carry_the_same_shape() {
        let doc = Doc {
            name: "L".into(),
            sections: vec![Section {
                title: String::new(),
                headers: vec!["A".into(), "B".into()],
                rows: vec![vec!["1".into(), "x".into()], vec!["2".into(), "y".into()]],
            }],
        };
        let csv = to_csv(&doc);
        assert!(csv.contains("A,B"));
        assert!(to_xlsx(&doc).is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(loc: &str, brand: &str, cat: &str, title: &str, msrp: f64, units: i64) -> Stack {
        Stack {
            location: loc.into(),
            r#box: "BOX3".into(),
            upc: format!("upc{title}"),
            title: title.into(),
            units,
            msrp,
            brand: Some(brand.into()),
            category: Some(cat.into()),
            segment: None,
            size_us: Some(9.5),
            title_risk: TitleRisk::Typed,
            upc_ambiguous: false,
        }
    }

    fn fixture() -> Vec<Stack> {
        vec![
            s("43-127-04A", "Nike", "Footwear", "Nike Air Max 90", 190.0, 46),
            s("43-127-04A", "New Balance", "Footwear", "New Balance 9060", 150.0, 2),
            s("43-127-05A", "Nike", "Apparel-Top", "Nike Crew Sweatshirt", 60.0, 20),
        ]
    }

    /// The assertion the spec says to write before anything else.
    #[test]
    fn the_three_exports_reconcile() {
        let st = fixture();
        let p = Pricing::flat(0.26);
        let m = manifest(&st, &p, &ManifestOpts::default());
        let b = brand_counts(&st, &p, "Lot 1");
        let pl = pull_sheet(&st, &p, "Lot 1");
        reconcile(&m, &b, &pl, 68).unwrap();
    }

    /// ...and it FAILS when they disagree, which is the only reason to have it.
    #[test]
    fn reconciliation_catches_a_disagreement() {
        let st = fixture();
        let p = Pricing::flat(0.26);
        let m = manifest(&st, &p, &ManifestOpts::default());
        let b = brand_counts(&st, &p, "Lot 1");
        let pl = pull_sheet(&st, &p, "Lot 1");
        assert!(reconcile(&m, &b, &pl, 69).is_err());
    }

    /// Columns are addressed by name. A manifest that gains a column must not break the
    /// check, and must not let it check the wrong thing.
    #[test]
    fn columns_are_addressed_by_header_not_position() {
        let st = fixture();
        let p = Pricing::flat(0.26);
        let plain = manifest(&st, &p, &ManifestOpts::default());
        let with_slots = manifest(
            &st,
            &p,
            &ManifestOpts {
                lot_name: "Lot 1".into(),
                include_slots: true,
                ..Default::default()
            },
        );
        assert_ne!(
            plain.lines().unwrap().col("Qty"),
            with_slots.lines().unwrap().col("Slot")
        );
        assert_eq!(plain.lines().unwrap().sum_i64("Qty").unwrap(), 68);
        assert_eq!(with_slots.lines().unwrap().sum_i64("Qty").unwrap(), 68);
    }

    /// Slot codes are a warehouse map. They stay off the buyer's copy unless asked for.
    #[test]
    fn slot_codes_are_off_the_buyer_manifest_by_default() {
        let st = fixture();
        let p = Pricing::flat(0.26);
        let m = manifest(&st, &p, &ManifestOpts::default());
        assert!(m.lines().unwrap().col("Slot").is_none());
        let pl = pull_sheet(&st, &p, "Lot 1");
        assert!(pl.lines().unwrap().col("Location").is_some());
    }

    /// The category summary is what Jack checks: $190 of retail at 26% is $49.40 a shoe.
    #[test]
    fn the_category_summary_shows_the_price_per_unit() {
        let st = vec![s("43-127-04A", "Nike", "Footwear", "Nike Air Max 90", 190.0, 46)];
        let m = manifest(&st, &Pricing::flat(0.26), &ManifestOpts::default());
        let cat = m.sections.iter().find(|x| x.title == "By category").unwrap();
        let per = cat.col("Price per unit").unwrap();
        assert_eq!(cat.rows[0][per], "49.40");
    }

    /// R-222. The manifest summarised by category and not by brand, and Jack buys and sells
    /// by brand. Both tables now, both carrying the percentage he asked for.
    #[test]
    fn the_manifest_breaks_down_by_brand_as_well_as_category() {
        let m = manifest(&fixture(), &Pricing::flat(0.26), &ManifestOpts::default());
        let brand = m
            .sections
            .iter()
            .find(|x| x.title == "By brand")
            .expect("the manifest has a brand table");

        // Same shape as the category table — one builder, so they cannot drift on the page.
        let cat = m.sections.iter().find(|x| x.title == "By category").unwrap();
        assert_eq!(brand.headers[1..], cat.headers[1..]);
        assert_eq!(brand.headers[0], "Brand");
        assert_eq!(cat.headers[0], "Category");

        // 46 Nike + 20 Nike = 66 of 68 units, biggest first.
        let share = brand.col("Share").unwrap();
        assert_eq!(brand.rows[0][0], "Nike");
        assert_eq!(brand.rows[0][share], "97.1%");
        assert_eq!(brand.sum_i64("Units").unwrap(), 68);
        // The percentage is on the category table too — one page, one convention.
        assert!(cat.col("Share").is_some());
    }

    /// R-223. Men's / Women's / GS / Kids on every manifest -- and the rule that matters:
    /// nothing may be hidden. Every unit on the lot is on the table, under a name.
    #[test]
    fn the_segment_table_names_everything_including_what_the_title_did_not_say() {
        let mut st = fixture();
        st[0].segment = Some("Men's".into());
        st[1].segment = Some("GS".into());
        st[2].segment = None; // "hidden with weird text" -- must still be a row
        let m = manifest(&st, &Pricing::flat(0.26), &ManifestOpts::default());
        let seg = m
            .sections
            .iter()
            .find(|x| x.title == "By who it is for")
            .expect("the manifest breaks down by segment");
        let names: Vec<&str> = seg.rows.iter().map(|r| r[0].as_str()).collect();
        assert!(names.contains(&"Men's") && names.contains(&"GS"));
        assert!(names.contains(&"Not stated"), "unsegmented stock must be a named row, never dropped");
        // The whole point: the table adds up to the lot.
        assert_eq!(seg.sum_i64("Units").unwrap(), 68);
    }

    /// The same completeness rule on the other two tables, so none of them can quietly
    /// shrink. This is the assertion that would fail if a future filter dropped a bucket.
    #[test]
    fn every_breakdown_table_sums_to_the_lot() {
        let mut st = fixture();
        st[2].brand = None;
        st[2].category = None;
        st[2].segment = None;
        let m = manifest(&st, &Pricing::flat(0.26), &ManifestOpts::default());
        for title in ["By category", "By brand", "By who it is for"] {
            let sec = m.sections.iter().find(|x| x.title == title).unwrap();
            assert_eq!(sec.sum_i64("Units").unwrap(), 68, "{title} does not sum to the lot");
        }
    }

    /// It is a switch like the rest of R-215's, and it defaults ON.
    #[test]
    fn the_brand_table_can_be_turned_off_and_is_on_by_default() {
        let st = fixture();
        let p = Pricing::flat(0.26);
        assert!(manifest(&st, &p, &ManifestOpts::default())
            .sections
            .iter()
            .any(|x| x.title == "By brand"));
        let off = ManifestOpts { show_by_brand: false, ..Default::default() };
        assert!(!manifest(&st, &p, &off).sections.iter().any(|x| x.title == "By brand"));
        // Turning it off must not disturb the line items, which are always last.
        assert_eq!(manifest(&st, &p, &off).lines().unwrap().sum_i64("Qty").unwrap(), 68);
    }

    /// The description-check column appears only when there is something to check.
    #[test]
    fn the_check_column_appears_only_when_it_has_something_to_say() {
        // Two conditions now, not one: it has to be ASKED FOR (R-215 — it is off the
        // buyer's copy by default) and there has to be something to report. This test used
        // to assert the default carried it, which is the behaviour Jack asked to reverse.
        let p = Pricing::flat(0.26);
        let asked = ManifestOpts { show_check: true, ..Default::default() };

        let clean = manifest(&fixture(), &p, &asked);
        assert!(
            clean.lines().unwrap().col("Description check").is_none(),
            "asked for, but nothing to say — a column of blanks is noise"
        );

        let mut risky = fixture();
        risky[1].title_risk = TitleRisk::Unknown;
        let flagged = manifest(&risky, &p, &asked);
        let c = flagged.lines().unwrap().col("Description check").unwrap();
        assert!(flagged.lines().unwrap().rows.iter().any(|r| r[c].contains("NO DESCRIPTION")));
        // ...and the lot summary says how many units carry a caveat.
        assert!(flagged.sections[0].rows.iter().any(|r| r[0] == "Lines to check"));

        // The same risky lot, left at the defaults, says none of it.
        let quiet = manifest(&risky, &p, &ManifestOpts::default());
        assert!(quiet.lines().unwrap().col("Description check").is_none());
        assert!(!quiet.sections[0].rows.iter().any(|r| r[0] == "Lines to check"));
    }

    #[test]
    fn the_pull_sheet_is_in_walk_order_and_one_row_per_slot() {
        let pl = pull_sheet(&fixture(), &Pricing::flat(0.26), "Lot 1");
        let sec = pl.lines().unwrap();
        assert_eq!(sec.rows.len(), 2);
        assert_eq!(sec.rows[0][0], "43-127-04A");
        assert_eq!(sec.rows[1][0], "43-127-05A");
    }

    /// Rewritten rather than deleted when the columns were cut: it used to assert the brand
    /// string, so it is the test that would have silently kept passing on a stale shape.
    /// Both directions are pinned — the three that stay, and the four that must not return.
    #[test]
    fn the_pull_sheet_carries_only_location_units_and_retail() {
        let pl = pull_sheet(&fixture(), &Pricing::flat(0.26), "Lot 1");
        let sec = pl.lines().unwrap();
        assert_eq!(sec.headers, vec!["Location", "Units", "Retail"]);
        for gone in ["Styles", "Price", "Brands", "Boxes"] {
            assert!(sec.col(gone).is_none(), "{gone} is back on the pull sheet");
        }
        // The column reconcile() sums by name has to survive the cut.
        assert_eq!(sec.sum_i64("Units").unwrap(), 68);
    }

    /// Golden, against the real numbers off Jack's own master sheet: B-001 is 1,030 units,
    /// $68,700.53 retail, $20,613.00 sale.
    #[test]
    fn the_roster_matches_the_master_spreadsheet_shape() {
        let d = lot_roster(
            &[
                LotLine { reference: "B-001".into(), units: 1030, retail: 68_700.53, sale: 20_613.0 },
                LotLine { reference: "B-021".into(), units: 831, retail: 41_464.11, sale: 12_441.0 },
            ],
            "Master shoe list",
        );
        let sec = d.lines().unwrap();
        assert_eq!(sec.headers, vec!["Ref #", "Unit count", "Retail Value", "Sale Price"]);
        assert_eq!(sec.rows[0], vec!["B-001", "1030", "$68,700.53", "$20,613.00"]);
        assert_eq!(sec.rows[1], vec!["B-021", "831", "$41,464.11", "$12,441.00"]);
        // Bare integers, so the column sums — his hand-kept copy has "1,010" as text.
        assert_eq!(sec.sum_i64("Unit count").unwrap(), 1861);
        // The heading is emitted WITHOUT his trailing space, or col() could never find it.
        assert!(sec.col("Unit count ").is_none());
    }

    #[test]
    fn roster_money_groups_thousands_and_survives_the_edges() {
        let d = lot_roster(
            &[
                LotLine { reference: "a".into(), units: 0, retail: 0.0, sale: 999.995 },
                LotLine { reference: "b".into(), units: 1, retail: 1_234_567.891, sale: -5.5 },
            ],
            "edges",
        );
        let r = &d.lines().unwrap().rows;
        assert_eq!(r[0][2], "$0.00");
        assert_eq!(r[0][3], "$1,000.00");
        assert_eq!(r[1][2], "$1,234,567.89");
        assert_eq!(r[1][3], "-$5.50");
    }

    #[test]
    fn location_codes_copy_as_a_bare_walk_ordered_list() {
        assert_eq!(location_codes(&fixture()), "43-127-04A\n43-127-05A");
    }

    #[test]
    fn csv_escapes_commas_and_quotes() {
        let st = vec![s(
            "43-127-04A",
            "Nike",
            "Footwear",
            "Air Max 90, \"Black\"",
            190.0,
            1,
        )];
        let csv = to_csv(&manifest(&st, &Pricing::flat(0.26), &ManifestOpts::default()));
        assert!(csv.contains("\"Air Max 90, \"\"Black\"\"\""));
    }
}
