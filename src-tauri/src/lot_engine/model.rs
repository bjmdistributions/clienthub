//! Types shared by every stage of the lot engine.
//!
//! SHARED MODULE — this directory exists byte-identically in `BUSINESS APP/src-tauri/src/`
//! and in `clienthub-api/src/`. It must not reference anything outside itself except the
//! crates both binaries carry (serde, anyhow, regex, calamine, csv). Do not add a
//! `use crate::...` here.

use serde::{Deserialize, Serialize};

/// The character used to join composite keys.
///
/// The spec's trap list names the empty separator as a source of silent key collisions:
/// `"AB" + "" + "C"` and `"A" + "" + "BC"` are the same string. `\u{1}` cannot occur in a
/// spreadsheet cell, so a joined key is unambiguous.
pub const KEY_SEP: char = '\u{1}';

/// Where a row's description came from, and therefore how much the manifest vouches for it.
///
/// The buyer reads the description, not the barcode — so the description is what gets
/// graded, and the grade travels all the way onto the manifest. Revision 1 of the spec
/// graded the barcode instead and produced a 6,338-unit alarm that was mostly noise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(into = "u8", try_from = "u8")]
pub enum TitleRisk {
    /// Typed into the source sheet by a human. No manifest note.
    Typed = 0,
    /// Row was blank; named from a barcode that reads as exactly one product.
    NamedFromBarcode = 1,
    /// Row was blank; the barcode reads as several products. Manifest says VERIFY.
    GuessedFromBarcode = 2,
    /// Nothing in the source to go on. Manifest says NO DESCRIPTION.
    Unknown = 3,
}

impl TitleRisk {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    /// The words that appear in the buyer's manifest. Empty for a typed description.
    pub fn manifest_note(self) -> &'static str {
        match self {
            TitleRisk::Typed => "",
            TitleRisk::NamedFromBarcode => "Description taken from the same barcode elsewhere",
            TitleRisk::GuessedFromBarcode => {
                "VERIFY — description guessed from a barcode used for several products"
            }
            TitleRisk::Unknown => "NO DESCRIPTION in the source sheet",
        }
    }
}

impl From<TitleRisk> for u8 {
    fn from(r: TitleRisk) -> u8 {
        r as u8
    }
}

impl TryFrom<u8> for TitleRisk {
    type Error = String;
    fn try_from(v: u8) -> Result<Self, Self::Error> {
        match v {
            0 => Ok(TitleRisk::Typed),
            1 => Ok(TitleRisk::NamedFromBarcode),
            2 => Ok(TitleRisk::GuessedFromBarcode),
            3 => Ok(TitleRisk::Unknown),
            other => Err(format!("title_risk out of range: {other}")),
        }
    }
}

/// One product sitting in one slot. The atom of the whole system.
///
/// The key is `(location, box, upc, title)` — **including the title**. Two products under
/// one barcode must stay two rows, and the title is the only thing that separates them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stack {
    /// Canonical `ZZ-RRR-SS[A-D]`. Never a free-text spelling, never a FOB `City, ST`.
    pub location: String,
    /// Scoped to the location. Empty is normal — 82% of rows have no box.
    #[serde(default)]
    pub r#box: String,
    /// Kept as a string. Parsing a barcode as a number loses leading zeros and rounds
    /// 13-digit codes.
    #[serde(default)]
    pub upc: String,
    /// Exactly as typed in the source sheet. **Never rewritten, never merged.**
    #[serde(default)]
    pub title: String,
    pub units: i64,
    /// Retail sticker price per unit, levelled so one product carries one price.
    #[serde(default)]
    pub msrp: f64,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub segment: Option<String>,
    #[serde(default)]
    pub size_us: Option<f64>,
    /// The worst grade among the input rows that rolled into this stack.
    pub title_risk: TitleRisk,
    /// The barcode carries two or more products in real quantity (>=3 units AND >=5%).
    #[serde(default)]
    pub upc_ambiguous: bool,
}

impl Stack {
    /// The four-part key, joined with a character that cannot occur in the data.
    pub fn key(&self) -> String {
        format!(
            "{}{}{}{}{}{}{}",
            self.location, KEY_SEP, self.r#box, KEY_SEP, self.upc, KEY_SEP, self.title
        )
    }

    /// True when the description is good enough to sell against without a caveat.
    pub fn described(&self) -> bool {
        self.title_risk <= TitleRisk::NamedFromBarcode && !self.title.trim().is_empty()
    }
}

/// One row of the raw -> canonical location audit map.
///
/// Emitted as an artifact on every import. It is how an unexpected merge is audited, and
/// how the warehouse finds spellings worth fixing at source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationRepair {
    pub raw: String,
    pub canonical: Option<String>,
    /// Which rung of the repair ladder resolved it, or why it failed.
    pub rule: String,
    pub rows: usize,
    pub units: i64,
}

/// Why rows left the pipeline. Every drop is reported with a reason and a count, so the
/// reconciliation assertion can account for every unit in the input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropReason {
    pub reason: String,
    pub rows: usize,
    pub units: i64,
    /// A couple of real examples, so a surprising drop can be eyeballed rather than trusted.
    #[serde(default)]
    pub examples: Vec<String>,
}

/// A barcode carrying two or more product names.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpcConflict {
    pub upc: String,
    /// `split` | `stray` | `same_brand` | `other` — same precedence the rows are labelled with.
    pub grade: String,
    pub units: i64,
    pub names: Vec<UpcConflictName>,
    /// Every name on this barcode carries the same price — the signature of a barcode used
    /// as a price tier rather than a product code.
    pub one_price: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpcConflictName {
    pub title: String,
    pub brand: Option<String>,
    pub units: i64,
    /// Share of the barcode's units, 0.0-1.0.
    pub share: f64,
    pub locations: usize,
    pub msrp: f64,
}

/// What the reader actually did. Surfaced in the UI on purpose: accepting every file format
/// is worthless if a mis-detected location column is wrong in silence. Mirrors the honesty
/// contract the shipped manifest analyzer already established.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SheetDetection {
    /// "csv" | "tsv" | "xlsx" | "xls" | "ods" ...
    pub format: String,
    pub sheet: Option<String>,
    /// 1-based row the column names were found on. 0 when there was no header row.
    pub header_row: usize,
    /// Original-case header text of each column that was used.
    pub upc_col: Option<String>,
    pub location_col: Option<String>,
    pub box_col: Option<String>,
    pub units_col: Option<String>,
    pub title_col: Option<String>,
    pub msrp_col: Option<String>,
    /// Columns detected as yes/no approval flags and used to drop rows.
    #[serde(default)]
    pub flag_cols: Vec<String>,
    pub note: Option<String>,
}

/// Everything the pipeline can tell you about a run that is not a stack.
///
/// "Report quality, don't silently fix it." The 38 genuinely split barcodes cannot be
/// resolved by software, but they can be handed back to the warehouse as a list — which is
/// the only thing that actually fixes them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QualityReport {
    pub rows_in: usize,
    pub units_in: i64,
    pub rows_dropped: usize,
    pub units_dropped: i64,
    pub drops: Vec<DropReason>,

    /// Distinct raw location spellings seen, and the canonical slots they resolved to.
    pub location_spellings: usize,
    pub locations: usize,
    pub locations_repaired: usize,
    pub locations_unparsed: usize,

    pub titles_blank: usize,
    pub titles_backfilled: usize,
    pub titles_unknown: usize,

    /// units by title_risk, indexed 0..=3.
    pub title_risk_units: [i64; 4],

    pub upcs: usize,
    pub upcs_multi_name: usize,
    pub upcs_ambiguous: usize,
    pub units_ambiguous: i64,

    pub products: usize,
    pub stacks: usize,
    pub units: i64,
    pub msrp_total: f64,

    /// Stacks priced at zero after resolution and levelling — surfaced rather than
    /// silently sold for nothing.
    pub zero_price_stacks: usize,
    pub zero_price_units: i64,

    /// Non-fatal things worth saying out loud.
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl QualityReport {
    /// The invariant the spec says to write first: every input unit is either in a stack or
    /// in a reported drop. Returns the discrepancy, which must be zero.
    pub fn reconciliation_gap(&self) -> i64 {
        self.units_in - self.units - self.units_dropped
    }
}

/// The full result of cleaning one sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanResult {
    pub stacks: Vec<Stack>,
    pub repairs: Vec<LocationRepair>,
    pub conflicts: Vec<UpcConflict>,
    pub detection: SheetDetection,
    pub quality: QualityReport,
}
