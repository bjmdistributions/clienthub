use std::collections::HashMap;
use std::sync::OnceLock;

/// One city as the location picker sees it: display name, 2-letter state, population.
/// Population is what ranks "Springfield" — the one in MO beats the one in VT.
#[derive(Clone, serde::Serialize)]
pub struct CityEntry {
    pub city: String,
    pub state: String,
    pub population: u32,
}

pub struct CityLookup {
    by_state_id: HashMap<String, (f64, f64)>,
    by_state_name: HashMap<String, (f64, f64)>,
    /// Every city, for prefix search and for resolving a bare city name to a state.
    cities: Vec<CityEntry>,
    /// Lowercased city name → indices into `cities`. A name like "Portland" has several.
    by_city: HashMap<String, Vec<u32>>,
    pub loaded: u32,
}

static CITY_LOOKUP: OnceLock<CityLookup> = OnceLock::new();

pub fn init() -> Result<u32, String> {
    let data = include_str!("../assets/uscities.csv");

    let mut by_state_id: HashMap<String, (f64, f64)> = HashMap::new();
    let mut by_state_name: HashMap<String, (f64, f64)> = HashMap::new();
    let mut cities: Vec<CityEntry> = Vec::new();
    let mut by_city: HashMap<String, Vec<u32>> = HashMap::new();
    let mut count = 0u32;

    let mut chars = data.chars().peekable();
    let mut line = String::new();

    loop {
        line.clear();
        let mut in_quotes = false;
        while let Some(&ch) = chars.peek() {
            chars.next();
            if ch == '"' {
                in_quotes = !in_quotes;
            } else if ch == '\n' && !in_quotes {
                break;
            } else {
                line.push(ch);
            }
        }

        if line.is_empty() && chars.peek().is_none() {
            break;
        }

        // Strip trailing \r for Windows CRLF line endings in the embedded CSV.
        // Quotes were already consumed by the char loop above, so split on plain
        // commas and trim any stray quote/whitespace from each field.
        let line_clean = line.trim_end_matches('\r');
        let fields: Vec<&str> = line_clean.split(',').collect();
        if fields.len() < 8 {
            continue;
        }

        let city = fields[0].trim_matches('"').trim();
        if city.is_empty() {
            continue;
        }

        let state_id = fields[2].trim_matches('"').trim().to_lowercase();
        let state_name = fields[3].trim_matches('"').trim().to_lowercase();
        let lat: f64 = match fields[6].trim_matches('"').trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let lng: f64 = match fields[7].trim_matches('"').trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        if !state_id.is_empty() {
            by_state_id.insert(format!("{}|{}", city.to_lowercase(), state_id), (lat, lng));
        }
        if !state_name.is_empty() {
            by_state_name.insert(format!("{}|{}", city.to_lowercase(), state_name), (lat, lng));
        }
        // Index for the location picker. Population is column 8 and is blank for
        // some small places — those rank last rather than being dropped.
        if !state_id.is_empty() {
            let population: u32 = fields
                .get(8)
                .map(|f| f.trim_matches('"').trim())
                .and_then(|f| f.parse::<f64>().ok())
                .map(|p| p as u32)
                .unwrap_or(0);
            by_city
                .entry(city.to_lowercase())
                .or_default()
                .push(cities.len() as u32);
            cities.push(CityEntry { city: city.to_string(), state: state_id.to_uppercase(), population });
        }
        count += 1;
    }

    tracing::info!("geocode: loaded {} city entries", count);

    let lookup = CityLookup { by_state_id, by_state_name, cities, by_city, loaded: count };
    CITY_LOOKUP.set(lookup).map_err(|_| "geocode already initialized".to_string())?;
    Ok(count)
}

pub fn get() -> Option<&'static CityLookup> {
    CITY_LOOKUP.get()
}

/// Coordinates for international clients the US dataset can't cover.
/// Canada gets major cities plus a province-centroid fallback so any Canadian
/// client still gets a pin even if the city isn't listed. Every other country
/// falls back to `country_centroid` below — a single pin per country rather
/// than per city, which is enough to put the client on the right side of the
/// globe instead of dropping them off the map entirely.
pub fn lookup_international(city: &str, region: &str, country: &str) -> Option<(f64, f64)> {
    let c = country.trim().to_lowercase();
    if c.is_empty() {
        return None;
    }
    if !(c == "canada" || c == "ca" || c == "can") {
        return country_centroid(&c);
    }
    let city_l = city.trim().to_lowercase();
    let city_coord = match city_l.as_str() {
        "toronto" => Some((43.6532, -79.3832)),
        "ottawa" => Some((45.4215, -75.6972)),
        "mississauga" => Some((43.5890, -79.6441)),
        "brampton" => Some((43.7315, -79.7624)),
        "hamilton" => Some((43.2557, -79.8711)),
        "london" => Some((42.9849, -81.2453)),
        "markham" => Some((43.8561, -79.3370)),
        "vaughan" => Some((43.8361, -79.4983)),
        "kitchener" => Some((43.4516, -80.4925)),
        "windsor" => Some((42.3149, -83.0364)),
        "montreal" | "montréal" => Some((45.5019, -73.5674)),
        "quebec city" | "québec" | "quebec" => Some((46.8139, -71.2080)),
        "laval" => Some((45.6066, -73.7124)),
        "gatineau" => Some((45.4765, -75.7013)),
        "vancouver" => Some((49.2827, -123.1207)),
        "surrey" => Some((49.1913, -122.8490)),
        "burnaby" => Some((49.2488, -122.9805)),
        "victoria" => Some((48.4284, -123.3656)),
        "calgary" => Some((51.0447, -114.0719)),
        "edmonton" => Some((53.5461, -113.4938)),
        "winnipeg" => Some((49.8951, -97.1384)),
        "saskatoon" => Some((52.1332, -106.6700)),
        "regina" => Some((50.4452, -104.6189)),
        "halifax" => Some((44.6488, -63.5752)),
        "st. john's" | "st johns" | "st. johns" => Some((47.5615, -52.7126)),
        "fredericton" => Some((45.9636, -66.6431)),
        "charlottetown" => Some((46.2382, -63.1311)),
        _ => None,
    };
    if city_coord.is_some() {
        return city_coord;
    }
    // Province centroid fallback (2-letter code or full name).
    match region.trim().to_lowercase().as_str() {
        "on" | "ontario" => Some((50.0, -85.0)),
        "qc" | "quebec" | "québec" => Some((52.0, -72.0)),
        "bc" | "british columbia" => Some((53.7267, -127.6476)),
        "ab" | "alberta" => Some((53.9333, -116.5765)),
        "mb" | "manitoba" => Some((53.7609, -98.8139)),
        "sk" | "saskatchewan" => Some((52.9399, -106.4509)),
        "ns" | "nova scotia" => Some((44.6820, -63.7443)),
        "nb" | "new brunswick" => Some((46.5653, -66.4619)),
        "nl" | "newfoundland and labrador" | "newfoundland" => Some((53.1355, -57.6604)),
        "pe" | "prince edward island" => Some((46.5107, -63.4168)),
        "yt" | "yukon" => Some((64.2823, -135.0000)),
        "nt" | "northwest territories" => Some((64.8255, -124.8457)),
        "nu" | "nunavut" => Some((70.2998, -83.1076)),
        _ => None,
    }
}

/// One centroid per country, keyed by lowercased common name and ISO
/// alpha-2/alpha-3 code (matches whatever the free-text country field on a
/// client happens to hold). US and Canada are handled by the city-level
/// lookups above and are deliberately absent here, so a US client with a
/// typo'd city still falls through to "not found" instead of silently
/// landing on a country-wide pin.
fn country_centroid(country: &str) -> Option<(f64, f64)> {
    match country {
        // Europe
        "united kingdom" | "uk" | "gb" | "gbr" | "great britain" | "england" | "scotland" | "wales" | "northern ireland" => Some((54.7, -3.4)),
        "ireland" | "ie" | "irl" => Some((53.1, -8.2)),
        "france" | "fr" | "fra" => Some((46.6, 2.2)),
        "germany" | "de" | "deu" => Some((51.2, 10.4)),
        "spain" | "es" | "esp" => Some((40.0, -3.7)),
        "portugal" | "pt" | "prt" => Some((39.6, -8.0)),
        "italy" | "it" | "ita" => Some((42.8, 12.8)),
        "netherlands" | "nl" | "nld" | "holland" => Some((52.1, 5.3)),
        "belgium" | "be" | "bel" => Some((50.6, 4.5)),
        "switzerland" | "ch" | "che" => Some((46.8, 8.2)),
        "austria" | "at" | "aut" => Some((47.6, 14.1)),
        "sweden" | "se" | "swe" => Some((60.1, 18.6)),
        "norway" | "no" | "nor" => Some((60.5, 8.5)),
        "denmark" | "dk" | "dnk" => Some((56.3, 9.5)),
        "finland" | "fi" | "fin" => Some((64.0, 26.0)),
        "poland" | "pl" | "pol" => Some((51.9, 19.1)),
        "czech republic" | "czechia" | "cz" | "cze" => Some((49.8, 15.5)),
        "greece" | "gr" | "grc" => Some((39.1, 21.8)),
        "romania" | "ro" | "rou" => Some((45.9, 24.9)),
        "ukraine" | "ua" | "ukr" => Some((48.4, 31.2)),

        // Latin America / Caribbean
        "mexico" | "mx" | "mex" => Some((23.6, -102.6)),
        "brazil" | "br" | "bra" => Some((-14.2, -51.9)),
        "argentina" | "ar" | "arg" => Some((-38.4, -63.6)),
        "chile" | "cl" | "chl" => Some((-35.7, -71.5)),
        "colombia" | "co" | "col" => Some((4.6, -74.3)),
        "peru" | "pe" | "per" => Some((-9.2, -75.0)),
        "ecuador" | "ec" | "ecu" => Some((-1.8, -78.2)),
        "panama" | "pa" | "pan" => Some((8.5, -80.8)),
        "costa rica" | "cr" | "cri" => Some((9.7, -83.8)),
        "guatemala" | "gt" | "gtm" => Some((15.8, -90.2)),
        "dominican republic" | "do" | "dom" => Some((18.7, -70.2)),
        "jamaica" | "jm" | "jam" => Some((18.1, -77.3)),
        "bahamas" | "bs" | "bhs" => Some((25.0, -77.4)),
        "trinidad and tobago" | "trinidad" | "tt" | "tto" => Some((10.7, -61.2)),
        "puerto rico" | "pr" | "pri" => Some((18.2, -66.6)),

        // Asia
        "china" | "cn" | "chn" => Some((35.9, 104.2)),
        "japan" | "jp" | "jpn" => Some((36.2, 138.3)),
        "south korea" | "korea" | "kr" | "kor" => Some((35.9, 127.8)),
        "india" | "in" | "ind" => Some((20.6, 79.0)),
        "pakistan" | "pk" | "pak" => Some((30.4, 69.3)),
        "bangladesh" | "bd" | "bgd" => Some((23.7, 90.4)),
        "vietnam" | "viet nam" | "vn" | "vnm" => Some((14.1, 108.3)),
        "thailand" | "th" | "tha" => Some((15.9, 101.0)),
        "philippines" | "ph" | "phl" => Some((12.9, 121.8)),
        "indonesia" | "id" | "idn" => Some((-0.8, 113.9)),
        "malaysia" | "my" | "mys" => Some((4.2, 108.0)),
        "singapore" | "sg" | "sgp" => Some((1.35, 103.8)),
        "taiwan" | "tw" | "twn" => Some((23.7, 121.0)),
        "hong kong" | "hk" | "hkg" => Some((22.3, 114.2)),
        "united arab emirates" | "uae" | "ae" | "are" => Some((23.4, 53.8)),
        "saudi arabia" | "sa" | "sau" => Some((23.9, 45.1)),
        "israel" | "il" | "isr" => Some((31.0, 34.9)),
        "turkey" | "türkiye" | "tr" | "tur" => Some((38.9, 35.2)),

        // Oceania
        "australia" | "au" | "aus" => Some((-25.3, 133.8)),
        "new zealand" | "nz" | "nzl" => Some((-41.0, 174.9)),

        // Africa
        "south africa" | "za" | "zaf" => Some((-30.6, 22.9)),
        "nigeria" | "ng" | "nga" => Some((9.1, 8.7)),
        "kenya" | "ke" | "ken" => Some((-0.0, 37.9)),
        "egypt" | "eg" | "egy" => Some((26.8, 30.8)),
        "morocco" | "ma" | "mar" => Some((31.8, -7.1)),
        "ghana" | "gh" | "gha" => Some((7.9, -1.0)),

        _ => None,
    }
}

impl CityLookup {
    pub fn lookup(&self, city: &str, state: &str) -> Option<(f64, f64)> {
        let city_lower = city.trim().to_lowercase();
        let state_lower = state.trim().to_lowercase();
        if city_lower.is_empty() || state_lower.is_empty() {
            return None;
        }
        let key = format!("{}|{}", city_lower, state_lower);
        if let Some(c) = self.by_state_id.get(&key) {
            return Some(*c);
        }
        if let Some(c) = self.by_state_name.get(&key) {
            return Some(*c);
        }
        None
    }

    /// Cities whose name starts with `prefix`, biggest first. Powers the city
    /// autocomplete on the lot form — picking a suggestion fills the state too.
    pub fn suggest(&self, prefix: &str, limit: usize) -> Vec<CityEntry> {
        let p = prefix.trim().to_lowercase();
        if p.len() < 2 {
            return Vec::new();
        }
        let mut hits: Vec<&CityEntry> = self
            .cities
            .iter()
            .filter(|c| c.city.to_lowercase().starts_with(&p))
            .collect();
        // Exact name first, then by population. Keeps "Chicago" above "Chicago Heights".
        hits.sort_by(|a, b| {
            let exact = |c: &CityEntry| c.city.to_lowercase() == p;
            exact(b).cmp(&exact(a)).then(b.population.cmp(&a.population))
        });
        hits.into_iter().take(limit).cloned().collect()
    }

    /// Every state a city of this name exists in, biggest first. Used by the reformat
    /// screen to propose a state for a bare city like "Chicago" — and to SHOW that
    /// "Springfield" is ambiguous rather than silently picking one.
    pub fn states_for_city(&self, city: &str) -> Vec<CityEntry> {
        let mut hits: Vec<CityEntry> = match self.by_city.get(&city.trim().to_lowercase()) {
            Some(idx) => idx.iter().filter_map(|i| self.cities.get(*i as usize)).cloned().collect(),
            None => return Vec::new(),
        };
        hits.sort_by(|a, b| b.population.cmp(&a.population));
        // One entry per state — the same city name repeats across counties.
        let mut seen = std::collections::HashSet::new();
        hits.retain(|c| seen.insert(c.state.clone()));
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_canada_country_plots_at_its_centroid() {
        // A client outside the US/Canada dataset used to vanish silently —
        // any recognized country should now still resolve to a pin.
        assert!(lookup_international("Paris", "", "France").is_some());
        assert!(lookup_international("", "NSW", "Australia").is_some());
        assert!(lookup_international("", "", "mx").is_some()); // ISO code, not full name
    }

    #[test]
    fn unrecognized_or_empty_country_still_not_found() {
        // No regression for domestic clients: an empty country (the common
        // case for US clients) or a country we don't have data for stays None.
        assert_eq!(lookup_international("Chicago", "IL", ""), None);
        assert_eq!(lookup_international("Nowhereville", "", "Narnia"), None);
    }

    #[test]
    fn canada_city_and_province_fallback_unaffected() {
        assert_eq!(lookup_international("Toronto", "", "Canada"), Some((43.6532, -79.3832)));
        assert!(lookup_international("Some Small Town", "ON", "Canada").is_some());
    }
}
