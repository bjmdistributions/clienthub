//! The lot engine — a warehouse manifest becomes priced, pickable lots.
//!
//! # This module is shared between two repositories
//!
//! `lot_engine/` exists **byte-identically** in `BUSINESS APP/src-tauri/src/` (the desktop
//! app) and in `clienthub-api/src/` (the server, which cleans sheets uploaded from the
//! phone). Both copies are guarded by `tests::module_tree_hash_is_pinned`, so drift fails
//! the build in whichever repo was edited second.
//!
//! Two consequences for anyone editing it:
//!
//! * **No `use crate::...`.** The module may only reach for crates both binaries carry:
//!   `serde`, `serde_json`, `anyhow`, `regex`, `calamine`, `csv`.
//! * **Edit both copies in the same session.** The spec's own history is the argument: a
//!   server cleaner and a browser cleaner that were only ever compared on totals hid four
//!   real bugs — a fabricated $45,335 of MSRP, a missing case-insensitive flag, a
//!   null-skipping aggregate that took a title from one product and a size from another,
//!   and a composite key joined with an empty separator.
//!
//! # The two rules everything else follows from
//!
//! 1. **A warehouse location is all or nothing.** Lots are built by ranking and taking
//!    whole slots. Filters rank and qualify locations; they never select items. A
//!    SKU-level allocator answered "give me 676 Nike" perfectly and produced a lot spread
//!    across 3,545 pick slots that nobody could pull.
//! 2. **Two rows typed differently are two products.** Same barcode, same brand, doesn't
//!    matter. The buyer reads the title, so nothing may silently rewrite it. Merging
//!    relabelled a New Balance 550 as a 9060.

pub mod classify;
pub mod export;
pub mod model;
pub mod pipeline;
pub mod price;
pub mod rank;
pub mod read;
pub mod report;
pub mod slot;

#[cfg(test)]
mod tests;

pub use classify::{classify, Classified};
pub use pipeline::{clean_path, clean_sheet};
pub use export::{brand_counts, location_codes, manifest, pull_sheet, reconcile, to_csv, Doc, ManifestOpts, Section};
pub use price::{lot_totals, GroupTotal, LotTotals, Pricing};
pub use report::{audit_map_csv, conflicts_csv, quality_report_text};
pub use rank::{rank, Allow, RankOpts, RankResult, RankedSlot, Sort, Want};
pub use model::{
    CleanResult, DropReason, LocationRepair, QualityReport, SheetDetection, Stack, TitleRisk,
    UpcConflict, UpcConflictName, KEY_SEP,
};
