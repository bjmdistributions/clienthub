//! R-402: one category and one brand for every closed deal, so Analytics can show what sells
//! and what earns, by category and by brand, one row each. Byte-identical in
//! `BUSINESS APP/src-tauri/src` and `clienthub-api/src` (like `manifest_category.rs`): the
//! desktop and the phone must put the same deal in the same row.
//!
//! A deal's label is the one Jack gave it (`deal_flows.category` / `deal_flows.brand`). When
//! he has not, it is guessed, and every guess says where it came from so the review screen
//! can show its work:
//! 1. **learned**: a word in the deal's products that has only ever been on deals he filed
//!    under one label ("hoodie" on three deals, all Clothing). The more deals he labels, the
//!    more it knows. That is the "gets smarter over time" he asked for.
//! 2. **reader**: the manifest reader (R-396) on each product line, the answer most lines
//!    give, in his spelling. When he has renamed that answer consistently ("Jordan" filed as
//!    Nike twice), his name is used.
//! 3. **buyer** (category only): the buyer's own category, when they carry exactly one.
//!
//! When learned and reader disagree, the reader wins unless the learned evidence is strong
//! (a score of 3: one word on three of his deals, or several words together), because one
//! stray word such as "womens" should not outvote "boots".
//!
//! Nothing found is Uncategorized, or no brand. Spellings fold the way the manifest split
//! folds them ("Shoes", "shoes" and "Footwear" are one row), shown in the spelling he uses
//! most. No AI (Jack's rule, R-379): every step is a count.

use crate::{manifest_category, manifest_split};
use std::collections::{HashMap, HashSet};

/// The row a deal with no brand at all is counted in.
pub(crate) const NO_BRAND: &str = "No brand";

/// Evidence a learned guess needs before it may overrule the reader.
const STRONG: u32 = 3;

/// The reader's answer for "a mixed lot of something". It is a weak answer: any learned
/// guess beats it, and it is never renamed, because what Jack files a mixed pallet under
/// depends on what was in it ("Mixed pallet of Nike apparel" is his Clothing, not every
/// mixed pallet).
const MIXED_LOT: &str = "General Merchandise";

/// Words that say nothing about what was sold: how it was packed, sized, counted or sold.
/// A word must be at least three letters and carry no digit to be read at all.
const STOP: &[&str] = &[
    "the", "and", "for", "with", "from", "new", "mixed", "mix", "assorted", "assortment", "lot", "lots", "load",
    "loads", "pallet", "pallets", "truckload", "truck", "ftl", "ltl", "case", "cases", "unit", "units", "pcs",
    "piece", "pieces", "each", "box", "boxes", "gaylord", "gaylords", "bulk", "wholesale", "liquidation", "overstock",
    "return", "returns", "customer", "shelf", "pull", "pulls", "grade", "retail", "msrp", "manifest", "manifested",
    "unmanifested", "brand", "brands", "name", "item", "items", "goods", "merchandise", "general", "various", "misc",
    "miscellaneous", "other", "others", "total", "qty", "quantity", "deposit", "balance", "payment", "invoice", "order",
    "sale", "deal", "price", "cost", "value", "size", "sizes", "color", "colors", "colour", "men", "mens", "women",
    "womens", "kid", "kids", "youth", "boy", "boys", "girl", "girls", "adult", "adults", "unisex", "black", "white",
    "blue", "red", "grey", "gray", "pink", "green", "large", "small", "medium", "full", "half", "first", "second",
    "per", "all", "not", "one", "two", "three", "set", "sets", "pack", "packs", "style", "styles", "stock", "high",
    "low", "top", "quality", "good", "great", "like", "used", "open", "damaged", "untested", "tested", "working",
    "salvage", "shelfpull", "uninspected", "inspected", "shipped", "delivered", "pickup", "fob", "via",
];

/// One closed deal, as the caller read it.
pub(crate) struct Deal {
    /// Product lines: the invoice's line descriptions with shipping lines removed, plus the
    /// deal's own name when it has one.
    pub lines: Vec<String>,
    /// The buyer's category field, a comma list as stored.
    pub buyer_categories: String,
    /// What Jack set on the deal, or "".
    pub category: String,
    pub brand: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Label {
    /// Always one category: "Uncategorized" when nothing was found.
    pub category: String,
    /// "you", "learned", "reader", "buyer", or "" when nothing was found.
    pub category_from: &'static str,
    /// One plain sentence saying why, for a guess. Empty for "you" and "".
    pub category_why: String,
    /// Always one brand: "No brand" when nothing was found.
    pub brand: String,
    pub brand_from: &'static str,
    pub brand_why: String,
}

/// Lowercased words the way the manifest split reads a title: "&" is "and", apostrophes
/// fall away ("Levi's" is "levis"), anything else not a letter or digit splits words.
fn raw_words(s: &str) -> Vec<String> {
    let t = s.to_lowercase().replace('&', " and ").replace('+', " and ");
    let cleaned: String = t
        .chars()
        .filter(|c| !matches!(c, '\'' | '\u{2019}'))
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().map(|w| w.to_string()).collect()
}

/// The words a line teaches with, as `(key, word as written)`: no digits, three letters or
/// more, not in `STOP`, and a plain plural folded in the key ("hoodies" is "hoodie", "dress"
/// stays "dress"). The written form is what a reason quotes.
fn signal_words(s: &str) -> Vec<(String, String)> {
    raw_words(s)
        .into_iter()
        .filter(|w| w.chars().count() >= 3 && !w.chars().any(|c| c.is_ascii_digit()) && !STOP.contains(&w.as_str()))
        .map(|w| {
            let k = if w.len() > 4 && w.ends_with('s') && !w.ends_with("ss") { w[..w.len() - 1].to_string() } else { w.clone() };
            (k, w)
        })
        .filter(|(k, _)| !STOP.contains(&k.as_str()))
        .collect()
}

fn category_key(raw: &str) -> String {
    manifest_split::category_group_key(raw.trim())
}

/// A brand's key. A label that means "no brand" ("Generic", "Mixed") keeps its own words as
/// its key, so a brand Jack chose to call Mixed is still its own row, but it is never looked
/// for in a title (see `named`).
fn brand_key(raw: &str) -> String {
    let raw = raw.trim();
    manifest_split::brand_group_key(raw).unwrap_or_else(|| raw_words(raw).join(" "))
}

/// Deals counted per label key, per word.
#[derive(Default)]
struct Votes(HashMap<String, HashMap<String, u32>>);

impl Votes {
    fn add(&mut self, words: &HashMap<String, String>, key: &str) {
        for w in words.keys() {
            *self.0.entry(w.clone()).or_default().entry(key.to_string()).or_insert(0) += 1;
        }
    }

    /// The label the words point to: `(key, score, deciding word, deals it was on)`. A word
    /// counts when it was on two or more of his deals and at least 80% of them share one
    /// label; its score is the number of those deals. A tie between labels is no answer.
    fn best(&self, words: &HashMap<String, String>) -> Option<(String, u32, String, u32)> {
        let mut score: HashMap<&str, (u32, &str, u32)> = HashMap::new();
        let mut sorted: Vec<&String> = words.keys().collect();
        sorted.sort();
        for w in sorted {
            let Some(by) = self.0.get(w) else { continue };
            let total: u32 = by.values().sum();
            let Some((key, n)) = by.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))) else { continue };
            if total < 2 || n * 5 < total * 4 {
                continue;
            }
            let e = score.entry(key.as_str()).or_insert((0, w.as_str(), 0));
            e.0 += n;
            if *n > e.2 {
                e.1 = w.as_str();
                e.2 = *n;
            }
        }
        let mut v: Vec<(&str, (u32, &str, u32))> = score.into_iter().collect();
        v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(b.0)));
        match v.as_slice() {
            [] => None,
            [(k, (s, w, n)), rest @ ..] => {
                if rest.first().map_or(false, |r| r.1 .0 == *s) {
                    None
                } else {
                    Some((k.to_string(), *s, words.get(*w).cloned().unwrap_or_else(|| w.to_string()), *n))
                }
            }
        }
    }
}

/// The spelling each key is shown in: the one Jack used most, ties to the first seen.
#[derive(Default)]
struct Spellings(HashMap<String, Vec<(String, u32)>>);

impl Spellings {
    fn add(&mut self, key: &str, spelling: &str) {
        let v = self.0.entry(key.to_string()).or_default();
        match v.iter_mut().find(|(s, _)| s == spelling) {
            Some(e) => e.1 += 1,
            None => v.push((spelling.to_string(), 1)),
        }
    }

    fn get(&self, key: &str) -> Option<&str> {
        let v = self.0.get(key)?;
        let mut best: Option<&(String, u32)> = None;
        for e in v {
            if best.map_or(true, |b| e.1 > b.1) {
                best = Some(e);
            }
        }
        best.map(|e| e.0.as_str())
    }
}

/// When the reader says X and Jack filed it as Y on two or more deals, and Y is at least 80%
/// of what he did with X, the reader's X is read as his Y.
fn alias(renames: &HashMap<String, HashMap<String, u32>>, reader_key: &str) -> Option<String> {
    let by = renames.get(reader_key)?;
    let total: u32 = by.values().sum();
    let (key, n) = by.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))?;
    if total >= 2 && n * 5 >= total * 4 && key != reader_key {
        Some(key.clone())
    } else {
        None
    }
}

/// The answer most lines give, with the first line that gave it. Ties go to the answer
/// that appeared first.
fn majority(answers: &[(String, String, String)]) -> Option<(String, String, String)> {
    let mut count: Vec<(usize, u32)> = Vec::new();
    for (i, (k, _, _)) in answers.iter().enumerate() {
        match count.iter_mut().find(|(j, _)| answers[*j].0 == *k) {
            Some(e) => e.1 += 1,
            None => count.push((i, 1)),
        }
    }
    let mut best: Option<(usize, u32)> = None;
    for e in count {
        if best.map_or(true, |b| e.1 > b.1) {
            best = Some(e);
        }
    }
    best.map(|(i, _)| answers[i].clone())
}

fn clip(line: &str) -> String {
    let t = line.trim();
    if t.chars().count() <= 60 {
        t.to_string()
    } else {
        format!("{}...", t.chars().take(57).collect::<String>().trim_end())
    }
}

/// Which learned or reader answer stands. See the module notes for the rule. `needed` is
/// the learned score that overrules the reader: `STRONG`, or 0 against a weak answer.
fn decide(
    learned: Option<(String, String)>,
    learned_score: u32,
    reader: Option<(String, String)>,
    needed: u32,
) -> Option<(String, &'static str, String)> {
    match (learned, reader) {
        (Some((lk, lw)), Some((rk, _))) if lk == rk => Some((lk, "learned", lw)),
        (Some((lk, lw)), Some(_)) if learned_score >= needed => Some((lk, "learned", lw)),
        (_, Some((rk, rw))) => Some((rk, "reader", rw)),
        (Some((lk, lw)), None) => Some((lk, "learned", lw)),
        (None, None) => None,
    }
}

/// Label every deal at once: learn from the ones Jack labelled, then guess the rest. The
/// result is in the same order as `deals`.
pub(crate) fn label_all(deals: &[Deal]) -> Vec<Label> {
    // What the reader makes of every line, read once. The brand dictionary is built once
    // for all of them.
    let all_lines: Vec<String> = deals.iter().flat_map(|d| d.lines.iter().cloned()).collect();
    let line_brands = manifest_split::brands_in_titles(&all_lines);
    let mut at = 0usize;
    // Per deal: its signal words, and the reader's (key, spelling, line) per line.
    let mut read: Vec<(HashMap<String, String>, Vec<(String, String, String)>, Vec<(String, String, String)>)> = Vec::new();
    for d in deals {
        let mut words: HashMap<String, String> = HashMap::new();
        let mut cats = Vec::new();
        let mut brands = Vec::new();
        for line in &d.lines {
            for (k, w) in signal_words(line) {
                words.entry(k).or_insert(w);
            }
            let c = manifest_category::guess_category(line);
            if c != manifest_category::UNCATEGORIZED {
                cats.push((category_key(c), c.to_string(), line.clone()));
            }
            if let Some(b) = &line_brands[at] {
                brands.push((brand_key(b), b.clone(), line.clone()));
            }
            at += 1;
        }
        read.push((words, cats, brands));
    }

    // Learn from what he set.
    let mut cat_votes = Votes::default();
    let mut brand_votes = Votes::default();
    let mut cat_names = Spellings::default();
    let mut brand_names = Spellings::default();
    let mut cat_renames: HashMap<String, HashMap<String, u32>> = HashMap::new();
    let mut brand_renames: HashMap<String, HashMap<String, u32>> = HashMap::new();
    // Brand names he has used, as word sequences, to find in titles. Longest first.
    let mut named: Vec<(Vec<String>, String)> = Vec::new();
    for (d, (words, cats, brands)) in deals.iter().zip(&read) {
        let c = d.category.trim();
        if !c.is_empty() {
            let k = category_key(c);
            cat_votes.add(words, &k);
            cat_names.add(&k, c);
            if let Some((rk, _, _)) = majority(cats) {
                *cat_renames.entry(rk).or_default().entry(k.clone()).or_insert(0) += 1;
            }
        }
        let b = d.brand.trim();
        if !b.is_empty() {
            let k = brand_key(b);
            brand_votes.add(words, &k);
            brand_names.add(&k, b);
            if let Some((rk, _, _)) = majority(brands) {
                *brand_renames.entry(rk).or_default().entry(k.clone()).or_insert(0) += 1;
            }
            if manifest_split::brand_group_key(b).is_some() && !named.iter().any(|(_, nk)| *nk == k) {
                named.push((k.split(' ').map(|w| w.to_string()).collect(), k.clone()));
            }
        }
    }
    named.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.1.cmp(&b.1)));

    let cat_show = |k: &str, fallback: &str| cat_names.get(k).unwrap_or(fallback).to_string();
    let brand_show = |k: &str, fallback: &str| brand_names.get(k).unwrap_or(fallback).to_string();

    deals
        .iter()
        .zip(&read)
        .map(|(d, (words, cats, brands))| {
            // ── Category ──
            let (category, category_from, category_why) = if !d.category.trim().is_empty() {
                let c = d.category.trim();
                (cat_show(&category_key(c), c), "you", String::new())
            } else {
                let learned = cat_votes.best(words);
                let score = learned.as_ref().map_or(0, |l| l.1);
                let learned = learned.map(|(k, _, w, n)| {
                    let name = cat_show(&k, &k);
                    (k, format!("\"{w}\" was on {n} of your {name} deals"))
                });
                let top = majority(cats);
                let weak = top.as_ref().map_or(false, |(rk, _, _)| *rk == category_key(MIXED_LOT));
                let reader = top.clone().map(|(rk, spelling, line)| match alias(&cat_renames, &rk).filter(|_| !weak) {
                    Some(k) => {
                        let name = cat_show(&k, &k);
                        (k, format!("The products read as {spelling}, which you file as {name}"))
                    }
                    None => (rk, format!("Read from \"{}\"", clip(&line))),
                });
                let reader_spelling = top.map(|(_, s, _)| s);
                match decide(learned, score, reader, if weak { 0 } else { STRONG }) {
                    Some((k, from, why)) => {
                        let fallback = reader_spelling.unwrap_or_else(|| k.clone());
                        (cat_show(&k, &fallback), from, why)
                    }
                    None => {
                        let mut seen = HashSet::new();
                        let own: Vec<&str> = d
                            .buyer_categories
                            .split(',')
                            .map(|s| s.trim().trim_matches('"').trim())
                            .filter(|s| !s.is_empty() && seen.insert(category_key(s)))
                            .collect();
                        if own.len() == 1 {
                            let name = cat_show(&category_key(own[0]), own[0]);
                            (name.clone(), "buyer", format!("The buyer buys only {name}"))
                        } else {
                            (manifest_category::UNCATEGORIZED.to_string(), "", String::new())
                        }
                    }
                }
            };

            // ── Brand ──
            let (brand, brand_from, brand_why) = if !d.brand.trim().is_empty() {
                let b = d.brand.trim();
                (brand_show(&brand_key(b), b), "you", String::new())
            } else {
                let learned = brand_votes.best(words);
                let score = learned.as_ref().map_or(0, |l| l.1);
                let learned = learned.map(|(k, _, w, n)| {
                    let name = brand_show(&k, &k);
                    (k, format!("\"{w}\" was on {n} of your {name} deals"))
                });
                // A brand he has named, found in a title, before the reader's dictionary.
                let mut answers: Vec<(String, String, String)> = Vec::new();
                for line in &d.lines {
                    let lw = raw_words(line);
                    let hit = named.iter().find(|(w, _)| !w.is_empty() && lw.windows(w.len()).any(|x| x == w.as_slice()));
                    if let Some((_, k)) = hit {
                        answers.push((k.clone(), brand_show(k, k), line.clone()));
                    } else if let Some(r) = brands.iter().find(|(_, _, l)| l == line) {
                        answers.push(r.clone());
                    }
                }
                let top = majority(&answers);
                let reader = top.clone().map(|(rk, spelling, line)| match alias(&brand_renames, &rk) {
                    Some(k) => {
                        let name = brand_show(&k, &k);
                        (k, format!("The products name {spelling}, which you file as {name}"))
                    }
                    None => (rk, format!("Named in \"{}\"", clip(&line))),
                });
                match decide(learned, score, reader, STRONG) {
                    Some((k, from, why)) => {
                        let fallback = top.map(|(_, s, _)| s).unwrap_or_else(|| k.clone());
                        (brand_show(&k, &fallback), from, why)
                    }
                    None => (NO_BRAND.to_string(), "", String::new()),
                }
            };

            Label { category, category_from, category_why, brand, brand_from, brand_why }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deal(lines: &[&str], buyer: &str, category: &str, brand: &str) -> Deal {
        Deal {
            lines: lines.iter().map(|s| s.to_string()).collect(),
            buyer_categories: buyer.to_string(),
            category: category.to_string(),
            brand: brand.to_string(),
        }
    }

    #[test]
    fn what_he_set_is_kept_and_shown_in_his_most_used_spelling() {
        let l = label_all(&[
            deal(&["Crocs clogs"], "", "Footwear", "Crocs"),
            deal(&["Ugg boots"], "", "Footwear", "UGG"),
            deal(&["Vans slip ons"], "", "footwear", "vans"),
        ]);
        assert_eq!(l[2].category, "Footwear");
        assert_eq!(l[2].category_from, "you");
        assert_eq!(l[1].brand, "UGG");
    }

    #[test]
    fn the_reader_names_what_he_never_labelled() {
        let l = label_all(&[deal(&["Nike Dri-FIT Game Classic Shorts", "Shipping"], "", "", "")]);
        assert_eq!(l[0].category, "Clothing");
        assert_eq!(l[0].category_from, "reader");
        assert_eq!(l[0].brand, "Nike");
        assert_eq!(l[0].brand_from, "reader");
    }

    #[test]
    fn the_reader_answer_folds_onto_his_spelling() {
        // "Shoes" and "Footwear" are one key, so a reader "Shoes" shows as his "Footwear".
        let l = label_all(&[
            deal(&["Crocs classic clog"], "", "Footwear", ""),
            deal(&["Adidas Samba OG size 10"], "", "", ""),
        ]);
        assert_eq!(l[1].category, "Footwear");
        assert_eq!(l[1].category_from, "reader");
    }

    #[test]
    fn a_word_on_his_deals_teaches_a_category_the_reader_cannot_read() {
        let l = label_all(&[
            deal(&["Zorvex 4400 lot A"], "", "Electronics", ""),
            deal(&["Zorvex 4410 lot B"], "", "Electronics", ""),
            deal(&["Zorvex 5000 returns"], "", "", ""),
        ]);
        assert_eq!(l[2].category, "Electronics");
        assert_eq!(l[2].category_from, "learned");
        assert_eq!(l[2].category_why, "\"zorvex\" was on 2 of your Electronics deals");
    }

    #[test]
    fn one_labelled_deal_teaches_nothing_on_its_own() {
        let l = label_all(&[deal(&["Zorvex 4400"], "", "Electronics", ""), deal(&["Zorvex 5000"], "", "", "")]);
        assert_eq!(l[1].category, "Uncategorized");
        assert_eq!(l[1].category_from, "");
    }

    #[test]
    fn a_weak_learned_word_does_not_outvote_the_reader() {
        // "fleece" was on two Clothing deals; the reader reads "boots" as Shoes and wins.
        let l = label_all(&[
            deal(&["fleece jacket"], "", "Clothing", ""),
            deal(&["fleece joggers"], "", "Clothing", ""),
            deal(&["fleece lined boots"], "", "", ""),
        ]);
        assert_eq!(l[2].category, "Shoes");
        assert_eq!(l[2].category_from, "reader");
    }

    #[test]
    fn strong_learned_evidence_overrules_the_reader() {
        let l = label_all(&[
            deal(&["Kinetic sand game"], "", "Crafts", ""),
            deal(&["Kinetic sand bucket"], "", "Crafts", ""),
            deal(&["Kinetic sand castle"], "", "Crafts", ""),
            deal(&["Kinetic sand board game"], "", "", ""),
        ]);
        assert_eq!(l[3].category, "Crafts");
        assert_eq!(l[3].category_from, "learned");
    }

    #[test]
    fn a_word_split_between_labels_teaches_nothing() {
        let l = label_all(&[
            deal(&["Blorp one"], "", "Toys", ""),
            deal(&["Blorp two"], "", "Electronics", ""),
            deal(&["Blorp three"], "", "", ""),
        ]);
        assert_eq!(l[2].category, "Uncategorized");
    }

    #[test]
    fn stop_words_and_sizes_never_teach() {
        let l = label_all(&[
            deal(&["Case 500 units"], "", "Toys", ""),
            deal(&["Case 200 units"], "", "Toys", ""),
            deal(&["Case 300 units"], "", "", ""),
        ]);
        assert_eq!(l[2].category, "Uncategorized");
    }

    #[test]
    fn a_mixed_lot_is_never_renamed_and_any_learned_word_beats_it() {
        let l = label_all(&[
            deal(&["Mixed pallet of Zorvex apparel"], "", "Clothing", ""),
            deal(&["Mixed pallet of Zorvex tees"], "", "Clothing", ""),
            deal(&["Mixed pallet of assorted household items"], "", "", ""),
            deal(&["Mixed pallet of Zorvex joggers"], "", "", ""),
        ]);
        assert_eq!(l[2].category, "General Merchandise");
        assert_eq!(l[2].category_from, "reader");
        assert_eq!(l[3].category, "Clothing");
        assert_eq!(l[3].category_from, "learned");
    }

    #[test]
    fn the_buyer_category_is_the_last_resort_and_only_when_single() {
        let l = label_all(&[
            deal(&["Truckload for Delmar"], "Shoes", "", ""),
            deal(&["Truckload for Tacoma"], "Shoes, Clothing", "", ""),
            deal(&["Truckload for Ocala"], "\"Shoes\", shoes", "", ""),
        ]);
        assert_eq!(l[0].category, "Shoes");
        assert_eq!(l[0].category_from, "buyer");
        assert_eq!(l[0].category_why, "The buyer buys only Shoes");
        assert_eq!(l[1].category, "Uncategorized");
        assert_eq!(l[2].category, "Shoes");
    }

    #[test]
    fn a_brand_he_named_is_found_in_later_titles() {
        let l = label_all(&[
            deal(&["Quillo throw blankets"], "", "", "Quillo"),
            deal(&["Quillo sherpa throw"], "", "", ""),
        ]);
        assert_eq!(l[1].brand, "Quillo");
        assert_eq!(l[1].brand_from, "reader");
        assert_eq!(l[1].brand_why, "Named in \"Quillo sherpa throw\"");
    }

    #[test]
    fn a_consistent_rename_of_the_reader_brand_is_learned() {
        let l = label_all(&[
            deal(&["Jordan Retro 4 size 9"], "", "", "Nike"),
            deal(&["Jordan 1 Mid size 10"], "", "", "Nike"),
            deal(&["Jordan 11 Low size 8"], "", "", ""),
        ]);
        assert_eq!(l[2].brand, "Nike");
    }

    #[test]
    fn nothing_found_is_uncategorized_and_no_brand() {
        let l = label_all(&[deal(&["Shipping"], "", "", ""), deal(&[], "", "", "")]);
        for x in &l {
            assert_eq!(x.category, "Uncategorized");
            assert_eq!(x.brand, NO_BRAND);
            assert_eq!(x.category_from, "");
            assert_eq!(x.brand_from, "");
        }
    }

    #[test]
    fn a_no_brand_label_of_his_is_its_own_row_but_never_read_from_titles() {
        let l = label_all(&[
            deal(&["Mixed brand apparel"], "", "", "Mixed"),
            deal(&["Mixed load of towels"], "", "", ""),
        ]);
        assert_eq!(l[0].brand, "Mixed");
        assert_eq!(l[1].brand, NO_BRAND);
    }

    #[test]
    fn plurals_teach_as_one_word() {
        let l = label_all(&[
            deal(&["Quozzle hoodies"], "", "Loungewear", ""),
            deal(&["Quozzle hoodie"], "", "Loungewear", ""),
            deal(&["Quozzles"], "", "", ""),
        ]);
        assert_eq!(l[2].category, "Loungewear");
    }
}
