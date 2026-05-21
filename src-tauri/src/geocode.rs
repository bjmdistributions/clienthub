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
