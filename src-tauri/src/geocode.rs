use std::collections::HashMap;
use std::sync::OnceLock;

pub struct CityLookup {
    by_state_id: HashMap<String, (f64, f64)>,
    by_state_name: HashMap<String, (f64, f64)>,
    pub loaded: u32,
}

static CITY_LOOKUP: OnceLock<CityLookup> = OnceLock::new();

pub fn init() -> Result<u32, String> {
    let data = include_str!("../assets/uscities.csv");

    let mut by_state_id: HashMap<String, (f64, f64)> = HashMap::new();
    let mut by_state_name: HashMap<String, (f64, f64)> = HashMap::new();
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
        count += 1;
    }

    tracing::info!("geocode: loaded {} city entries", count);

    let lookup = CityLookup { by_state_id, by_state_name, loaded: count };
    CITY_LOOKUP.set(lookup).map_err(|_| "geocode already initialized".to_string())?;
    Ok(count)
}

pub fn get() -> Option<&'static CityLookup> {
    CITY_LOOKUP.get()
}

/// Coordinates for international clients the US dataset can't cover.
/// Currently Canada: major cities, with a province-centroid fallback so any
/// Canadian client still gets a pin even if the city isn't listed.
pub fn lookup_international(city: &str, region: &str, country: &str) -> Option<(f64, f64)> {
    let c = country.trim().to_lowercase();
    if !(c == "canada" || c == "ca" || c == "can") {
        return None;
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
}
