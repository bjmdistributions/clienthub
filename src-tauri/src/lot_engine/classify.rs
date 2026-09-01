//! Brand, category, segment and size — all inferred from one unstructured text field.
//!
//! The dictionaries matter less than the resolution order. Two orderings are load-bearing
//! and neither is optional:
//!
//! * **Literal brand names beat model names.** `WMNS` is Nike's own women's prefix, so it
//!   sat in the Nike pattern list; this data uses it generically, and Nike was checked
//!   before adidas — so *"adidas Sambae WMNS Sneakers"* classified as **Nike**. 32 titles,
//!   707 units, invisible until someone cross-checked a brand total against a spreadsheet
//!   filter. Here `WMNS` is a *segment* marker and carries no brand signal at all.
//! * **Non-footwear categories are tested first.** A shoe title rarely says "coverall", but
//!   an apparel title often says "crew" or "low".
//!
//! Every pattern is written against an **uppercased** title, which makes case-insensitivity
//! structural rather than a flag that one of five patterns can be missing. That flag going
//! missing is exactly why lowercase `Size 6w` never matched in the original build.
//!
//! Patterns stay in the intersection of the regex dialects this project uses: no named
//! groups, no lookaround, no inline flags.
//!
//! Call this **once per distinct title** (~15,000) and join the result, never once per row
//! (~145,000).

use std::sync::OnceLock;

use regex::{Regex, RegexSet};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Classified {
    pub brand: Option<String>,
    pub category: Option<String>,
    pub segment: Option<String>,
    pub size_us: Option<f64>,
}

// ---------------------------------------------------------------------------------------
// Brand — tier 1: literal names
// ---------------------------------------------------------------------------------------

/// `(canonical name, alternate spellings)`. Written without word boundaries; the boundaries
/// are added when the pattern is built, so a brand can never match inside another word.
///
/// Deliberately absent: **On** (the running brand) — two letters that appear in half of all
/// English titles. A brand this short cannot be matched literally without poisoning the
/// totals, and the spec's own guidance is to explain the gap rather than guess.
const LITERAL_BRANDS: &[(&str, &[&str])] = &[
    ("Nike", &["NIKE"]),
    ("Jordan", &["JORDAN", "AIR JORDAN"]),
    ("adidas", &["ADIDAS"]),
    ("New Balance", &["NEW BALANCE"]),
    ("Converse", &["CONVERSE"]),
    ("Vans", &["VANS"]),
    ("Puma", &["PUMA"]),
    ("Reebok", &["REEBOK"]),
    ("Crocs", &["CROCS"]),
    ("ASICS", &["ASICS"]),
    ("Brooks", &["BROOKS"]),
    ("HOKA", &["HOKA", "HOKA ONE ONE"]),
    ("Saucony", &["SAUCONY"]),
    ("Skechers", &["SKECHERS"]),
    ("Timberland", &["TIMBERLAND"]),
    ("Dr. Martens", &["DR MARTENS", "DR. MARTENS", "DOC MARTENS", "DOCMARTENS"]),
    ("Birkenstock", &["BIRKENSTOCK"]),
    ("UGG", &["UGG"]),
    ("Columbia", &["COLUMBIA"]),
    ("The North Face", &["NORTH FACE"]),
    ("Under Armour", &["UNDER ARMOUR", "UNDER ARMORE", "UNDERARMOUR"]),
    ("Champion", &["CHAMPION"]),
    ("Levi's", &["LEVIS", "LEVI'S", "LEVI STRAUSS"]),
    ("Carhartt", &["CARHARTT"]),
    ("Wrangler", &["WRANGLER"]),
    ("Dickies", &["DICKIES"]),
    ("Fila", &["FILA"]),
    ("Sperry", &["SPERRY"]),
    ("Clarks", &["CLARKS"]),
    ("Merrell", &["MERRELL"]),
    ("Salomon", &["SALOMON"]),
    ("KEEN", &["KEEN"]),
    ("Steve Madden", &["STEVE MADDEN"]),
    ("Michael Kors", &["MICHAEL KORS"]),
    ("Coach", &["COACH"]),
    ("Ralph Lauren", &["RALPH LAUREN", "POLO RALPH LAUREN"]),
    ("Tommy Hilfiger", &["TOMMY HILFIGER"]),
    ("Calvin Klein", &["CALVIN KLEIN"]),
    ("GUESS", &["GUESS"]),
    ("Hanes", &["HANES"]),
    ("Fruit of the Loom", &["FRUIT OF THE LOOM"]),
    ("Gildan", &["GILDAN"]),
    ("Oakley", &["OAKLEY"]),
    ("Ray-Ban", &["RAY BAN", "RAY-BAN", "RAYBAN"]),
    ("Lacoste", &["LACOSTE"]),
    ("Kappa", &["KAPPA"]),
    ("Diadora", &["DIADORA"]),
    ("Mizuno", &["MIZUNO"]),
    ("K-Swiss", &["K SWISS", "K-SWISS"]),
    ("Lugz", &["LUGZ"]),
    ("Nautica", &["NAUTICA"]),
    ("Eddie Bauer", &["EDDIE BAUER"]),
    ("Patagonia", &["PATAGONIA"]),
    ("Sorel", &["SOREL"]),
    ("Cole Haan", &["COLE HAAN"]),
    ("Nine West", &["NINE WEST"]),
    ("Aldo", &["ALDO"]),
    ("Josef Seibel", &["JOSEF SEIBEL"]),
];

/// Tier 2 — silhouette and model names, consulted **only** when no literal brand appears.
///
/// Roughly 1,700 units of Crocs carry no literal brand at all; they are titled
/// *"Classic Clog K Lagoon J6"* or *"Gothic Punk Love Jibbitz Pin Set of 5"*. Tier 2 is what
/// catches them, and it is why a plain text search undercounts a brand by about 30%.
///
/// Ordered. Word patterns come before bare model numbers, so *"Classic Clog 550"* reads as
/// Crocs rather than New Balance.
const SILHOUETTES: &[(&str, &str)] = &[
    // adidas
    ("SAMBA", "adidas"),
    ("GAZELLE", "adidas"),
    ("SUPERSTAR", "adidas"),
    ("STAN SMITH", "adidas"),
    ("ULTRABOOST", "adidas"),
    ("ULTRA BOOST", "adidas"),
    ("CLOUDFOAM", "adidas"),
    ("ADILETTE", "adidas"),
    ("FORUM LOW", "adidas"),
    ("CAMPUS 00", "adidas"),
    // Nike
    ("AIR MAX", "Nike"),
    ("AIR FORCE 1", "Nike"),
    ("BLAZER MID", "Nike"),
    ("PEGASUS", "Nike"),
    ("REVOLUTION 7", "Nike"),
    ("COURT VISION", "Nike"),
    // Converse
    ("CHUCK TAYLOR", "Converse"),
    ("ALL STAR", "Converse"),
    ("RUN STAR", "Converse"),
    // Vans
    ("OLD SKOOL", "Vans"),
    ("SK8-HI", "Vans"),
    ("SK8 HI", "Vans"),
    // Crocs
    ("CLASSIC CLOG", "Crocs"),
    ("JIBBITZ", "Crocs"),
    ("CROCBAND", "Crocs"),
    ("BAYA CLOG", "Crocs"),
    // Bare model numbers last — a naked number is the weakest signal in a title.
    ("9060", "New Balance"),
    ("2002R", "New Balance"),
    ("990V", "New Balance"),
    ("574", "New Balance"),
    ("530", "New Balance"),
    ("327", "New Balance"),
    ("550", "New Balance"),
];

struct BrandTables {
    literal_set: RegexSet,
    literal_pats: Vec<Regex>,
    /// Index into `LITERAL_BRANDS` for each pattern in `literal_pats`.
    literal_owner: Vec<usize>,
    silhouette_pats: Vec<Regex>,
}

fn word_pattern(alt: &str) -> String {
    // Spaces in a brand name may arrive as any run of whitespace.
    let body = regex::escape(alt).replace("\\ ", r"\s+");
    format!(r"(^|[^A-Z0-9]){body}([^A-Z0-9]|$)")
}

fn brands() -> &'static BrandTables {
    static T: OnceLock<BrandTables> = OnceLock::new();
    T.get_or_init(|| {
        let mut pats = Vec::new();
        let mut owner = Vec::new();
        let mut src = Vec::new();
        for (i, (_, alts)) in LITERAL_BRANDS.iter().enumerate() {
            for alt in *alts {
                let p = word_pattern(alt);
                src.push(p.clone());
                pats.push(Regex::new(&p).expect("literal brand pattern"));
                owner.push(i);
            }
        }
        BrandTables {
            literal_set: RegexSet::new(&src).expect("literal brand set"),
            literal_pats: pats,
            literal_owner: owner,
            silhouette_pats: SILHOUETTES
                .iter()
                .map(|(p, _)| Regex::new(&word_pattern(p)).expect("silhouette pattern"))
                .collect(),
        }
    })
}

/// Literal names beat silhouettes. Where several literal brands appear, the one written
/// **first** wins — titles lead with the brand — and a longer name beats a shorter one that
/// starts at the same place.
fn brand_of(up: &str) -> Option<String> {
    let t = brands();
    let hits: Vec<usize> = t.literal_set.matches(up).into_iter().collect();
    if !hits.is_empty() {
        let mut best: Option<(usize, usize, usize)> = None; // (start, -len, owner)
        for h in hits {
            if let Some(m) = t.literal_pats[h].find(up) {
                let len = m.end() - m.start();
                let cand = (m.start(), usize::MAX - len, t.literal_owner[h]);
                if best.is_none() || cand < best.unwrap() {
                    best = Some(cand);
                }
            }
        }
        if let Some((_, _, owner)) = best {
            return Some(LITERAL_BRANDS[owner].0.to_string());
        }
    }
    for (i, re) in t.silhouette_pats.iter().enumerate() {
        if re.is_match(up) {
            return Some(SILHOUETTES[i].1.to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------------------
// Category — an ordered cascade, first match wins
// ---------------------------------------------------------------------------------------

/// Non-footwear first, on purpose. Order is the whole design; the keyword lists are the
/// easy part.
const CATEGORY_CASCADE: &[(&str, &[&str])] = &[
    ("Socks", &["SOCK", "SOCKS", "CREW SOCK", "NO SHOW SOCK", "ANKLE SOCK", "TUBE SOCK"]),
    (
        "Underwear",
        &["UNDERWEAR", "BOXER", "BRIEF", "BRALETTE", "SPORTS BRA", "PANTY", "PANTIES", "THONG", "CAMISOLE"],
    ),
    (
        "Apparel-Bottom",
        &[
            "PANT", "PANTS", "JEAN", "JEANS", "SHORT", "SHORTS", "LEGGING", "JOGGER", "TROUSER",
            "CHINO", "SWEATPANT", "CAPRI", "SKIRT", "COVERALL", "OVERALL", "BIB", "SNOW PANT",
        ],
    ),
    (
        "Apparel-Top",
        &[
            "SHIRT", "T-SHIRT", "TEE", "HOODIE", "SWEATSHIRT", "JACKET", "COAT", "SWEATER",
            "PULLOVER", "CREWNECK", "CREW NECK", "CREW", "POLO", "TANK", "VEST", "BLOUSE",
            "CARDIGAN", "FLEECE", "PARKA", "ANORAK", "JERSEY",
        ],
    ),
    (
        "Bag",
        &["BACKPACK", "DUFFEL", "DUFFLE", "TOTE", "HANDBAG", "PURSE", "CROSSBODY", "SATCHEL", "LUGGAGE", "MESSENGER BAG"],
    ),
    ("Headwear", &["HAT", "CAP", "BEANIE", "VISOR", "HEADBAND", "SNAPBACK", "BUCKET HAT"]),
    (
        "Accessory",
        &[
            "BELT", "WALLET", "SUNGLASSES", "WATCH", "LANYARD", "KEYCHAIN", "JIBBITZ", "SHOELACE",
            "SHOE LACE", "LACES", "INSOLE", "GLOVE", "GLOVES", "SCARF", "MITTEN", "UMBRELLA",
        ],
    ),
    ("Boots", &["BOOT", "BOOTS", "BOOTIE"]),
    ("Sandals", &["SANDAL", "SANDALS", "FLIP FLOP", "FLIP-FLOP", "SLIDE", "SLIDES"]),
    ("Clogs", &["CLOG", "CLOGS"]),
    ("Slippers", &["SLIPPER", "SLIPPERS"]),
    ("Cleats", &["CLEAT", "CLEATS", "SPIKES"]),
    (
        "Footwear",
        &[
            "SHOE", "SHOES", "SNEAKER", "SNEAKERS", "TRAINER", "TRAINERS", "RUNNER", "FOOTWEAR",
            "LOAFER", "MOCCASIN", "OXFORD", "HIGH TOP", "LOW TOP", "HIGH-TOP", "LOW-TOP", "PUMP",
            "ESPADRILLE", "DERBY",
        ],
    ),
];

fn category_pats() -> &'static Vec<(String, Vec<Regex>)> {
    static T: OnceLock<Vec<(String, Vec<Regex>)>> = OnceLock::new();
    T.get_or_init(|| {
        CATEGORY_CASCADE
            .iter()
            .map(|(label, words)| {
                (
                    label.to_string(),
                    words
                        .iter()
                        .map(|w| Regex::new(&word_pattern(w)).expect("category pattern"))
                        .collect(),
                )
            })
            .collect()
    })
}

/// Apparel size markers: `2XL`, `XXL`, `XS`, `W42 x L36`, `SIZE M`.
fn apparel_size_re() -> &'static Vec<Regex> {
    static T: OnceLock<Vec<Regex>> = OnceLock::new();
    T.get_or_init(|| {
        vec![
            Regex::new(r"(^|[^A-Z0-9])[0-9]?X{1,3}[SL]([^A-Z0-9]|$)").unwrap(),
            Regex::new(r"(^|[^A-Z0-9])W[0-9]{2}\s*X\s*L[0-9]{2}([^A-Z0-9]|$)").unwrap(),
            Regex::new(r"(^|[^A-Z0-9])SIZE\s+(XS|S|M|L|XL)([^A-Z0-9]|$)").unwrap(),
        ]
    })
}

/// The cascade. `Uncategorized` is the honest answer, not a bucket to force things into —
/// it runs at about 6% of titles.
fn category_of(up: &str, has_shoe_size: bool, brand_from_silhouette: bool) -> String {
    for (label, pats) in category_pats() {
        if pats.iter().any(|re| re.is_match(up)) {
            return label.clone();
        }
    }
    // A silhouette name that carried a brand is itself a footwear signal — "Classic Clog"
    // already matched Clogs above, but "Samba" or "Air Max" alone would not.
    if brand_from_silhouette {
        return "Footwear".to_string();
    }
    if apparel_size_re().iter().any(|re| re.is_match(up)) {
        return "Apparel-Other".to_string();
    }
    // 43% of titles carry no category word at all, and this one test rescues most of them.
    if has_shoe_size {
        return "Footwear".to_string();
    }
    "Uncategorized".to_string()
}

// ---------------------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------------------

/// Kids is checked before gender — a *"Big Kid"* line is a kids line whatever else it says.
/// Women is checked before Men because "WOMEN" contains "MEN".
fn segment_pats() -> &'static Vec<(&'static str, Vec<Regex>)> {
    static T: OnceLock<Vec<(&'static str, Vec<Regex>)>> = OnceLock::new();
    T.get_or_init(|| {
        let build = |ws: &[&str]| -> Vec<Regex> {
            ws.iter().map(|w| Regex::new(&word_pattern(w)).unwrap()).collect()
        };
        vec![
            // GS is checked BEFORE Kids, and is its own bucket rather than part of it.
            //
            // Jack lists them separately -- "Men's / wmns / GS / Kids" -- and he is right to:
            // grade school is a 3.5-7 shoe an adult often buys, and a toddler 4 is not the
            // same buyer or the same price. Folding them together, which is what the single
            // Kids list did, hides the split on every manifest.
            //
            // "BIG KID" belongs here, not below: in this data it is the size run GS covers.
            // The bare abbreviations are the ones the source sheet actually uses -- and they
            // are matched as WHOLE WORDS by `word_pattern`, so "GS" cannot fire inside
            // "LEGGINGS" and "TD" cannot fire inside "LTD".
            (
                "GS",
                // BG / GG are Nike's own grade-school codes (boys' and girls' grade school)
                // and appear bare in this data -- "Air Force 1 BG Trainers".
                build(&["GS", "GRADE SCHOOL", "BIG KID", "BIG KIDS", "GRADESCHOOL", "BG", "GG"]),
            ),
            (
                "Kids",
                build(&[
                    "KID", "KIDS", "LITTLE KID", "TODDLER", "INFANT", "YOUTH", "BOYS",
                    "GIRLS", "JUNIOR", "PRESCHOOL", "PRE SCHOOL", "BABY", "CHILDRENS",
                    "TD", "PS", "CRIB", "NEONATI",
                ]),
            ),
            // WMNS is Nike's own women's prefix, used generically in this data. It belongs
            // here — as a segment marker — and NOT in the Nike brand list, which is the
            // mistake that classified "adidas Sambae WMNS Sneakers" as Nike.
            ("Women's", build(&["WOMEN", "WOMENS", "WOMEN'S", "WMNS", "LADIES", "FEMALE"])),
            ("Men's", build(&["MEN", "MENS", "MEN'S", "MALE"])),
            ("Unisex", build(&["UNISEX"])),
        ]
    })
}

fn segment_of(up: &str) -> Option<String> {
    for (label, pats) in segment_pats() {
        if pats.iter().any(|re| re.is_match(up)) {
            return Some(label.to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------

const SIZE_MIN: f64 = 0.5;
const SIZE_MAX: f64 = 20.0;

/// Five ordered patterns. Range-checked rather than bounded by lookahead, because the regex
/// dialects this has to compile in do not all support lookaround — and the range check is
/// what rejects EU sizes and style numbers anyway.
fn size_pats() -> &'static Vec<Regex> {
    static T: OnceLock<Vec<Regex>> = OnceLock::new();
    T.get_or_init(|| {
        vec![
            // "9.5 US"
            Regex::new(r"([0-9]+(?:\.[0-9])?)\s*US([^A-Z0-9]|$)").unwrap(),
            // "Size 11", and "Size 6w" — no trailing boundary, so a width letter is fine.
            Regex::new(r"SIZE\s+([0-9]+(?:\.[0-9])?)").unwrap(),
            // ", 7.5 M"
            Regex::new(r",\s*([0-9]+(?:\.[0-9])?)\s*[MWY]([^A-Z0-9]|$)").unwrap(),
            // "10 M"
            Regex::new(r"(^|[^A-Z0-9.])([0-9]+(?:\.[0-9])?)\s*[MW]([^A-Z0-9]|$)").unwrap(),
            // "7Y"
            Regex::new(r"(^|[^A-Z0-9.])([0-9]+(?:\.[0-9])?)Y([^A-Z0-9]|$)").unwrap(),
        ]
    })
}

fn size_of(up: &str) -> Option<f64> {
    for (i, re) in size_pats().iter().enumerate() {
        if let Some(c) = re.captures(up) {
            // Patterns 4 and 5 open with a boundary group, so their number is capture 2.
            let g = if i >= 3 { 2 } else { 1 };
            if let Some(m) = c.get(g) {
                if let Ok(v) = m.as_str().parse::<f64>() {
                    // Only whole and half sizes are real. 9.3 is a measurement, not a size.
                    let half = (v * 2.0).fract() == 0.0;
                    if half && (SIZE_MIN..=SIZE_MAX).contains(&v) {
                        return Some(v);
                    }
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------------------

/// Classify one title. Call once per DISTINCT title and join the result.
pub fn classify(title: &str) -> Classified {
    let up = title.trim().to_ascii_uppercase();
    if up.is_empty() {
        return Classified::default();
    }
    let brand = brand_of(&up);
    let from_silhouette = brand.is_some()
        && !brands()
            .literal_set
            .is_match(&up);
    let size_us = size_of(&up);
    let category = category_of(&up, size_us.is_some(), from_silhouette);
    Classified {
        brand,
        category: Some(category),
        segment: segment_of(&up),
        size_us,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(t: &str) -> Classified {
        classify(t)
    }

    /// The bug the spec spent a paragraph on: `WMNS` is a women's marker, not a Nike
    /// signal, and a literal `adidas` must beat any model pattern.
    #[test]
    fn wmns_does_not_pull_adidas_into_nike() {
        let r = c("adidas Sambae WMNS Sneakers");
        assert_eq!(r.brand.as_deref(), Some("adidas"));
        assert_eq!(r.segment.as_deref(), Some("Women's"));
    }

    #[test]
    fn literal_beats_silhouette() {
        // "Air Max" is a Nike silhouette, but the literal brand written here is adidas.
        assert_eq!(c("adidas Air Max Style Runner").brand.as_deref(), Some("adidas"));
        // With no literal brand, the silhouette carries it.
        assert_eq!(c("Air Max 90 Big Kid Shoes").brand.as_deref(), Some("Nike"));
    }

    /// ~1,700 units of Crocs carry no literal brand at all. Tier 2 is what finds them, and
    /// is why plain text search undercounts a brand by 30%.
    #[test]
    fn crocs_without_the_word_crocs() {
        assert_eq!(c("Classic Clog K Lagoon J6").brand.as_deref(), Some("Crocs"));
        assert_eq!(
            c("Gothic Punk Love Jibbitz Pin Set of 5").brand.as_deref(),
            Some("Crocs")
        );
    }

    /// A word pattern must beat a bare model number.
    #[test]
    fn word_silhouettes_beat_bare_model_numbers() {
        assert_eq!(c("Classic Clog 550 Lagoon").brand.as_deref(), Some("Crocs"));
    }

    #[test]
    fn brand_written_first_wins_when_several_appear() {
        assert_eq!(c("Nike vs adidas comparison pack").brand.as_deref(), Some("Nike"));
        assert_eq!(c("adidas vs Nike comparison pack").brand.as_deref(), Some("adidas"));
    }

    #[test]
    fn brands_never_match_inside_a_word() {
        assert_eq!(c("Reconverse Rebook Nikeish Thing").brand, None);
    }

    /// Non-footwear is tested first, because an apparel title often says "crew".
    /// R-223: GS is its own bucket, and it is checked before Kids.
    #[test]
    fn grade_school_is_not_filed_under_kids() {
        assert_eq!(c("Nike Kobe 9 Elite Protro (GS) 6.5").segment.as_deref(), Some("GS"));
        assert_eq!(c("New Balance Grade School 550 White").segment.as_deref(), Some("GS"));
        assert_eq!(c("Jordan 4 Retro Big Kid 5.5").segment.as_deref(), Some("GS"));
        // ...and the younger sizes stay Kids.
        assert_eq!(c("Jordan Pro Strong (TD)").segment.as_deref(), Some("Kids"));
        assert_eq!(c("Crocs Classic Puff Moc Little Kid 6").segment.as_deref(), Some("Kids"));
        assert_eq!(c("Vans Old Skool Crib Infant 3").segment.as_deref(), Some("Kids"));
        // Whole words only -- the bare abbreviations must not fire inside another word.
        assert_ne!(c("Nike Pro Leggings Black").segment.as_deref(), Some("GS"));
        assert_ne!(c("Adidas LTD Edition Jacket").segment.as_deref(), Some("Kids"));
    }

    #[test]
    fn category_cascade_order() {
        assert_eq!(c("Nike Crew Socks 6 Pack").category.as_deref(), Some("Socks"));
        assert_eq!(c("Champion Crew Neck Sweatshirt").category.as_deref(), Some("Apparel-Top"));
        assert_eq!(c("Carhartt Coverall Duck Brown").category.as_deref(), Some("Apparel-Bottom"));
        assert_eq!(c("Nike Dunk Low Shoes").category.as_deref(), Some("Footwear"));
        assert_eq!(c("Crocs Classic Clog").category.as_deref(), Some("Clogs"));
        assert_eq!(c("Timberland 6-Inch Boot").category.as_deref(), Some("Boots"));
    }

    /// 43% of titles carry no category word. The size test rescues most of them.
    #[test]
    fn a_shoe_size_alone_means_footwear() {
        assert_eq!(c("New Balance 9060 Great Plains, Size 6.5").category.as_deref(), Some("Footwear"));
    }

    #[test]
    fn an_apparel_size_marker_means_apparel() {
        assert_eq!(c("Heavyweight Pocket 2XL").category.as_deref(), Some("Apparel-Other"));
        assert_eq!(c("Utility W42 x L36").category.as_deref(), Some("Apparel-Other"));
    }

    #[test]
    fn uncategorized_is_an_honest_answer() {
        assert_eq!(c("Assorted Overstock Pallet").category.as_deref(), Some("Uncategorized"));
    }

    /// All five size patterns, and the lowercase one that never matched in the original
    /// build because a single pattern was missing its case-insensitive flag.
    #[test]
    fn all_five_size_patterns() {
        assert_eq!(c("Runner 9.5 US Black").size_us, Some(9.5));
        assert_eq!(c("Nike Air Max, Size 11").size_us, Some(11.0));
        assert_eq!(c("Some Shoe, 7.5 M").size_us, Some(7.5));
        assert_eq!(c("Some Shoe 10 M Black").size_us, Some(10.0));
        assert_eq!(c("Kids Runner 7Y").size_us, Some(7.0));
        // The regression: lowercase, with a width letter glued to the number.
        assert_eq!(c("Some Shoe size 6w").size_us, Some(6.0));
    }

    #[test]
    fn sizes_outside_the_us_range_are_rejected() {
        assert_eq!(c("EU Size 42").size_us, None);
        assert_eq!(c("Style Size 197968").size_us, None);
        // Quarter sizes are measurements, not shoe sizes.
        assert_eq!(c("Size 9.3").size_us, None);
    }

    #[test]
    fn segment_kids_beats_gender_and_women_beats_men() {
        // R-223 moved this expectation, deliberately: "Big Kid" is the GS size run and GS is
        // now its own bucket, checked first. The property the test exists for is unchanged
        // and still asserted -- a kids-family marker beats the gender word beside it.
        assert_eq!(c("Nike Big Kid Boys Shoes").segment.as_deref(), Some("GS"));
        assert_eq!(c("Nike Toddler Boys Shoes").segment.as_deref(), Some("Kids"));
        assert_eq!(c("Women's Running Shoe").segment.as_deref(), Some("Women's"));
        assert_eq!(c("Men's Running Shoe").segment.as_deref(), Some("Men's"));
        // "WOMEN" contains "MEN" — the order is what stops this reading as Men's.
        assert_eq!(c("Womens Trainer").segment.as_deref(), Some("Women's"));
    }

    #[test]
    fn empty_title_classifies_to_nothing() {
        let r = c("   ");
        assert_eq!(r.brand, None);
        assert_eq!(r.category, None);
        assert_eq!(r.segment, None);
        assert_eq!(r.size_us, None);
    }

    /// The spec's worked example of why titles are never merged: one barcode, two shoes.
    #[test]
    fn the_two_products_under_one_barcode_classify_differently() {
        let a = c("New Balance 9060 Big Kid Shoes, Great Plains/Twilight Haze, Size 6.5");
        let b = c("New Balance 550 - Men's (Navy/Electric Sky) Size 12");
        assert_eq!(a.brand.as_deref(), Some("New Balance"));
        assert_eq!(b.brand.as_deref(), Some("New Balance"));
        // "Big Kid" is GS since R-223; the point of the test is that a and b differ.
        assert_eq!(a.segment.as_deref(), Some("GS"));
        assert_eq!(b.segment.as_deref(), Some("Men's"));
        assert_eq!(a.size_us, Some(6.5));
        assert_eq!(b.size_us, Some(12.0));
    }
}
