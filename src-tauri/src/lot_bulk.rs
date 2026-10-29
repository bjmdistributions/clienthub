//! R-566: one rule for a mass edit of inventory lots, in both repos.
//!
//! This file is byte-identical in BUSINESS APP/src-tauri/src and clienthub-api/src. It has no `use crate::`.
//!
//! Jack, 2026-10-29: "build a way to do mass edits and select all on inventory listings. for example if i wanted to
//! select all to set a timer on them for expiration etc." The desktop's `bulk_edit_lots` and the server's
//! `POST /api/inventory/bulk-edit` (the phone) both read the stored lot, call `apply`, and write only what it returns.
//!
//! The clock. A lot's `updated_at` is its renewal clock and the listing timer counts from it
//! (vault: decisions/a-lots-renewal-clock-is-its-updated-at). So a mass edit moves `updated_at` ONLY when it sets the
//! timer, which Jack chose to count from today ("Off in 7 days" = 7 days from now): that is a renewal of each lot. Every
//! other field leaves the clock alone, or adding a tag to every lot would restart every timer and answer every waiting
//! "Renew or mark sold" request.
//!
//! What each field does. Blank means leave it as it is; nothing here clears a field except the timer (0 = stays up).
//! - `category`: the lot's categories become just this one (and the `category` column with it).
//! - `add_tags` / `remove_tags`: tags compared case-insensitively, the first spelling kept (the desktop's `dedupeTags`).
//! - `condition`, `supplier`, `location`: set as typed (the caller sends `location` already in `City, ST` form).

use serde::Deserialize;
use serde_json::{json, Map, Value};

/// The longest timer, the same 365 as `lot_timer::MAX_DAYS` and the desktop's `MAX_EXPIRE_DAYS`.
pub const MAX_DAYS: i64 = 365;
/// A text field longer than this is cut; a lot's fields are short.
const MAX_TEXT: usize = 200;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct BulkEdit {
    /// `Some(0)` = stays up until taken down; `Some(n)` = comes off the site n days from now.
    #[serde(default)]
    pub expire_days: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub add_tags: Vec<String>,
    #[serde(default)]
    pub remove_tags: Vec<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub supplier: Option<String>,
}

/// The stored fields a mass edit can touch.
#[derive(Debug, Clone, Default)]
pub struct LotNow<'a> {
    pub category: Option<&'a str>,
    pub details_json: Option<&'a str>,
    pub location: Option<&'a str>,
    pub supplier: Option<&'a str>,
}

/// What to write. `None` = leave that column alone. `renews` = move `updated_at` to now.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    pub category: Option<String>,
    pub details_json: Option<String>,
    pub location: Option<String>,
    pub supplier: Option<String>,
    pub renews: bool,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        self.category.is_none() && self.details_json.is_none() && self.location.is_none()
            && self.supplier.is_none() && !self.renews
    }
}

/// Collapse whitespace, drop control characters, cut to length. Empty = not sent.
fn clean(s: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_TEXT).collect()
}

fn sent(v: &Option<String>) -> Option<String> {
    v.as_deref().map(clean).filter(|s| !s.is_empty())
}

/// Tags from a stored blob value: strings only, cleaned, deduped case-insensitively keeping the first spelling.
fn dedupe(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in raw {
        let v = clean(t);
        if !v.is_empty() && !out.iter().any(|x| x.to_lowercase() == v.to_lowercase()) {
            out.push(v);
        }
    }
    out
}

impl BulkEdit {
    pub fn is_empty(&self) -> bool {
        self.expire_days.is_none() && sent(&self.category).is_none() && dedupe(&self.add_tags).is_empty()
            && dedupe(&self.remove_tags).is_empty() && sent(&self.location).is_none()
            && sent(&self.condition).is_none() && sent(&self.supplier).is_none()
    }

    /// What this edit changes on one lot. A field already holding the value is not written again.
    pub fn apply(&self, lot: &LotNow) -> Change {
        let mut out = Change::default();
        // A blob that is not a JSON object is read as empty, as the desktop's form reads it.
        let mut d: Map<String, Value> = lot.details_json
            .and_then(|t| serde_json::from_str::<Value>(t).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let before = d.clone();

        if let Some(n) = self.expire_days {
            out.renews = true;
            if n > 0 { d.insert("expire_days".into(), json!(n.min(MAX_DAYS))); } else { d.remove("expire_days"); }
        }
        if let Some(c) = sent(&self.category) {
            if lot.category.map(clean).as_deref() != Some(c.as_str()) { out.category = Some(c.clone()); }
            d.insert("categories".into(), json!([c]));
        }
        let add = dedupe(&self.add_tags);
        let remove = dedupe(&self.remove_tags);
        if !add.is_empty() || !remove.is_empty() {
            let stored: Vec<String> = d.get("tags").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut tags: Vec<String> = dedupe(&stored).into_iter()
                .filter(|t| !remove.iter().any(|r| r.to_lowercase() == t.to_lowercase()))
                .collect();
            for t in add {
                if !tags.iter().any(|x| x.to_lowercase() == t.to_lowercase()) { tags.push(t); }
            }
            if tags.is_empty() { d.remove("tags"); } else { d.insert("tags".into(), json!(tags)); }
        }
        if let Some(c) = sent(&self.condition) {
            d.insert("condition".into(), json!(c));
        }
        if d != before {
            out.details_json = Some(Value::Object(d).to_string());
        }
        if let Some(l) = sent(&self.location) {
            if lot.location.map(clean).as_deref() != Some(l.as_str()) { out.location = Some(l); }
        }
        if let Some(s) = sent(&self.supplier) {
            if lot.supplier.map(clean).as_deref() != Some(s.as_str()) { out.supplier = Some(s); }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lot<'a>(details: &'a str) -> LotNow<'a> {
        LotNow { category: Some("Shoes"), details_json: Some(details), location: Some("Newark, NJ"), supplier: Some("Acme") }
    }
    fn blob(c: &Change) -> Value {
        serde_json::from_str(c.details_json.as_deref().unwrap()).unwrap()
    }

    #[test]
    fn a_timer_is_a_renewal_and_keeps_the_rest_of_the_blob() {
        let e = BulkEdit { expire_days: Some(7), ..Default::default() };
        let c = e.apply(&lot(r#"{"pallets":4,"tags":["Nike"]}"#));
        assert!(c.renews);
        let d = blob(&c);
        assert_eq!(d["expire_days"], 7);
        assert_eq!(d["pallets"], 4);
        assert_eq!(d["tags"], json!(["Nike"]));
    }

    #[test]
    fn the_same_timer_still_restarts_from_today() {
        let e = BulkEdit { expire_days: Some(7), ..Default::default() };
        let c = e.apply(&lot(r#"{"expire_days":7}"#));
        assert!(c.renews);
        assert!(c.details_json.is_none());
    }

    #[test]
    fn zero_clears_the_timer_and_the_cap_is_365() {
        let off = BulkEdit { expire_days: Some(0), ..Default::default() }.apply(&lot(r#"{"expire_days":3,"moq":5}"#));
        assert_eq!(blob(&off), json!({"moq":5}));
        let big = BulkEdit { expire_days: Some(9999), ..Default::default() }.apply(&lot("{}"));
        assert_eq!(blob(&big)["expire_days"], 365);
    }

    #[test]
    fn anything_but_the_timer_leaves_the_clock_alone() {
        let e = BulkEdit { add_tags: vec!["Adidas".into()], condition: Some("New".into()), supplier: Some("Bolt".into()), location: Some("Camden, NJ".into()), category: Some("Apparel".into()), ..Default::default() };
        let c = e.apply(&lot(r#"{"expire_days":2}"#));
        assert!(!c.renews);
        assert_eq!(c.category.as_deref(), Some("Apparel"));
        assert_eq!(c.location.as_deref(), Some("Camden, NJ"));
        assert_eq!(c.supplier.as_deref(), Some("Bolt"));
        let d = blob(&c);
        assert_eq!(d["expire_days"], 2);
        assert_eq!(d["categories"], json!(["Apparel"]));
        assert_eq!(d["condition"], "New");
    }

    #[test]
    fn tags_add_and_remove_case_insensitively() {
        let e = BulkEdit { add_tags: vec!["nike".into(), " New  Balance ".into()], remove_tags: vec!["JORDAN".into()], ..Default::default() };
        let c = e.apply(&lot(r#"{"tags":["Nike","Jordan"]}"#));
        assert_eq!(blob(&c)["tags"], json!(["Nike", "New Balance"]));
        let gone = BulkEdit { remove_tags: vec!["nike".into()], ..Default::default() }.apply(&lot(r#"{"tags":["Nike"],"moq":1}"#));
        assert_eq!(blob(&gone), json!({"moq":1}));
    }

    #[test]
    fn a_value_already_held_writes_nothing() {
        let e = BulkEdit { category: Some("Shoes".into()), supplier: Some("Acme".into()), location: Some("Newark, NJ".into()), add_tags: vec!["NIKE".into()], ..Default::default() };
        let c = e.apply(&lot(r#"{"categories":["Shoes"],"tags":["Nike"]}"#));
        assert!(c.is_empty(), "{c:?}");
    }

    #[test]
    fn blank_fields_are_not_sent_and_a_bad_blob_reads_empty() {
        let blank = BulkEdit { category: Some("  ".into()), supplier: Some("".into()), add_tags: vec![" ".into()], ..Default::default() };
        assert!(blank.is_empty());
        assert!(blank.apply(&lot("{}")).is_empty());
        let c = BulkEdit { condition: Some("Used".into()), ..Default::default() }.apply(&lot("not json"));
        assert_eq!(blob(&c), json!({"condition":"Used"}));
    }

    #[test]
    fn hostile_text_is_cleaned() {
        let c = BulkEdit { supplier: Some(format!("A\u{0}B\n{}", "x".repeat(500))), ..Default::default() }.apply(&lot("{}"));
        let s = c.supplier.unwrap();
        assert!(s.starts_with("AB"));
        assert_eq!(s.chars().count(), 200);
    }
}
