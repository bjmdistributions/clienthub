//! R-678 (Jack, 2026-11-19): "can we make the accounts have color themes that match card colors or have it be the card
//! in a cool way and have red notfication when it has issues ... i need to be able to link the proper stuff to get the
//! correct logos too. just want more customability."
//!
//! How each business account looks on Accounts: a colour and a logo he picks, by `plaid_account_key`, kept in the
//! shared setting `account_looks` so every computer draws the same cards. A missing colour or logo falls back to the
//! bank's own from Plaid (`plaid_branding`). A logo comes from an image file he chooses or from the bank's own website,
//! and is stored as a small PNG. The computer with the bank link sends each account's colour and logo to the server
//! with its balances, so the phone draws the same cards (`publish_extras`).

use crate::db::pool;
use base64::Engine;
use serde_json::{json, Map, Value};

pub const KEY: &str = "account_looks";
/// The longest side of a stored logo, in pixels: sharp on a card at twice its drawn size, a few KB as a PNG.
const LOGO_PX: u32 = 128;

fn b64() -> base64::engine::GeneralPurpose { base64::engine::general_purpose::STANDARD }

/// Every look he has set, as `{account key: {color?, logo?, site?}}`.
pub(crate) fn load(conn: &rusqlite::Connection) -> Map<String, Value> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| r.get::<_, String>(0)).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// `#RRGGBB`, upper case, or nothing.
pub(crate) fn clean_color(s: &str) -> Option<String> {
    let s = s.trim();
    (s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())).then(|| s.to_ascii_uppercase())
}

/// The bare host of what he typed ("https://www.Chase.com/business" becomes "www.chase.com"), or nothing.
pub(crate) fn clean_site(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let s = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(&s);
    let host = s.split(['/', '?', '#']).next().unwrap_or("").trim_end_matches('.');
    (host.len() <= 100 && host.contains('.') && !host.starts_with('.')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .then(|| host.to_string())
}

/// Any image a webview or a bank's website hands over, as a PNG no larger than `LOGO_PX` on its longest side.
pub(crate) fn logo_png(bytes: &[u8]) -> Result<String, String> {
    let img = image::load_from_memory(bytes).map_err(|_| "That file is not a picture this app can read. Try a PNG or JPG.".to_string())?;
    let img = if img.width() > LOGO_PX || img.height() > LOGO_PX {
        img.resize(LOGO_PX, LOGO_PX, image::imageops::FilterType::Lanczos3)
    } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageOutputFormat::Png).map_err(|e| e.to_string())?;
    Ok(b64().encode(out.into_inner()))
}

/// The icons a page's `<link rel="...icon...">` tags name, best first: Apple touch icons (large, square), then the
/// largest declared size. SVG is left out (the decoder cannot draw it).
pub(crate) fn icon_links(html: &str) -> Vec<String> {
    let attr = |tag: &str, name: &str| -> Option<String> {
        let lower = tag.to_ascii_lowercase();
        let mut from = 0;
        while let Some(i) = lower[from..].find(name) {
            let at = from + i;
            from = at + name.len();
            // A whole attribute name: preceded by space, followed by `=`.
            if !lower[..at].ends_with(|c: char| c.is_whitespace()) { continue; }
            let rest = lower[from..].trim_start();
            let Some(rest) = rest.strip_prefix('=') else { continue };
            let start = tag.len() - rest.len();
            let raw = tag[start..].trim_start();
            let (q, body) = match raw.chars().next() { Some(c @ ('"' | '\'')) => (Some(c), &raw[1..]), _ => (None, raw) };
            let end = match q { Some(q) => body.find(q), None => body.find(|c: char| c.is_whitespace() || c == '>') }.unwrap_or(body.len());
            return Some(body[..end].trim().to_string());
        }
        None
    };
    let mut found: Vec<(i64, String)> = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let end = lower[start..].find('>').map(|e| start + e + 1).unwrap_or(lower.len());
        from = end;
        let tag = &html[start..end];
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.split_whitespace().any(|w| w == "icon" || w == "apple-touch-icon" || w == "apple-touch-icon-precomposed") { continue; }
        let Some(href) = attr(tag, "href").filter(|h| !h.is_empty() && !h.starts_with("data:")) else { continue };
        if href.to_ascii_lowercase().split('?').next().unwrap_or("").ends_with(".svg") { continue; }
        let size = attr(tag, "sizes").and_then(|s| s.split(['x', 'X']).next().and_then(|n| n.trim().parse::<i64>().ok())).unwrap_or(0);
        let score = if rel.contains("apple-touch-icon") { 10_000 + size.max(180) } else { size };
        found.push((score, href));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, h)| h).collect()
}

/// Each account's colour and logo as the cards draw them: his choice, else the bank's own from Plaid.
fn effective(looks: &Map<String, Value>, brands: &Value, key: &str, item: &str) -> (Option<String>, Option<String>) {
    let mine = looks.get(key);
    let plaid = brands.get(item);
    let pick = |k: &str| mine.and_then(|m| m.get(k)).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .or_else(|| plaid.and_then(|p| p.get(k)).and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .map(str::to_string);
    (pick("color"), pick("logo"))
}

/// For the phone: each account row gets its `color` and the id of its `logo`, and the logos travel once each in a map
/// beside the rows (a bank's logo is shared by all its accounts). Called before the key and bank link are stripped.
pub(crate) fn publish_extras(conn: &rusqlite::Connection, accounts: &mut [Value]) -> Value {
    let looks = load(conn);
    let brands: Value = conn.query_row("SELECT value FROM settings WHERE key='plaid_branding'", [], |r| r.get::<_, String>(0)).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
    let mut logos = Map::new();
    for a in accounts.iter_mut() {
        let key = a.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let item = a.get("item").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (color, logo) = effective(&looks, &brands, &key, &item);
        if let Some(c) = color { a["color"] = json!(c); }
        if let Some(l) = logo {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            l.hash(&mut h);
            let id = format!("{:016x}", h.finish());
            a["logo"] = json!(id);
            logos.insert(id, json!(l));
        }
    }
    Value::Object(logos)
}

/// Whether an account's bank needs its connection fixed: the bank wants a sign-in, or this account is one the bank
/// stopped sharing (R-652's Fix connection answers both).
pub(crate) fn needs_fix(health: &Value, item: &str, name: &str, mask: &str) -> bool {
    let Some(e) = health.get("items").and_then(|i| i.get(item)) else { return false };
    let code = e.get("code").and_then(|v| v.as_str()).unwrap_or("");
    crate::commands::plaid_needs_login(code)
        || e.get("dropped").and_then(|v| v.as_array()).is_some_and(|d| d.iter().any(|x|
            x.get("mask").and_then(|v| v.as_str()) == Some(mask) && x.get("name").and_then(|v| v.as_str()) == Some(name)))
}

#[tauri::command]
pub async fn account_looks() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(Value::Object(load(&conn)))
}

/// Change one account's look. Each field left out stays as it is; an empty string takes that field back to the
/// bank's own. `logo` is any picture as base64 (an image file he chose, or what `site_logo` fetched) and is stored as
/// a small PNG. `reset` takes the whole account back to the bank's own look.
#[tauri::command]
pub async fn set_account_look(key: String, color: Option<String>, logo: Option<String>, site: Option<String>, reset: Option<bool>) -> Result<Value, String> {
    let key = key.trim().to_string();
    if key.is_empty() || key.len() > 300 { return Err("Which account is this for?".into()); }
    let mut looks = { let conn = pool().get().map_err(|e| e.to_string())?; load(&conn) };
    if reset == Some(true) {
        looks.remove(&key);
    } else {
        let mut look = looks.get(&key).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if let Some(c) = color {
            if c.trim().is_empty() { look.remove("color"); }
            else { look.insert("color".into(), json!(clean_color(&c).ok_or("A colour looks like #007AFF.")?)); }
        }
        if let Some(l) = logo {
            if l.trim().is_empty() { look.remove("logo"); }
            else {
                let raw = l.split_once("base64,").map(|(_, b)| b).unwrap_or(&l);
                let bytes = b64().decode(raw.trim()).map_err(|_| "That picture could not be read.".to_string())?;
                if bytes.len() > 8 * 1024 * 1024 { return Err("That picture is over 8 MB. Choose a smaller one.".into()); }
                look.insert("logo".into(), json!(logo_png(&bytes)?));
            }
        }
        if let Some(s) = site {
            if s.trim().is_empty() { look.remove("site"); }
            else { look.insert("site".into(), json!(clean_site(&s).ok_or("Type the bank's website, like chase.com.")?)); }
        }
        if look.is_empty() { looks.remove(&key); } else { looks.insert(key, Value::Object(look)); }
    }
    crate::commands::write_setting(KEY, &Value::Object(looks.clone()).to_string())?;
    Ok(Value::Object(looks))
}

/// The logo a bank's own website shows, as a small PNG (base64): its Apple touch icon or largest page icon, then the
/// usual fixed places. Only the bank's own site is asked; nothing about him or his accounts is sent.
#[tauri::command]
pub async fn site_logo(site: String) -> Result<String, String> {
    let host = clean_site(&site).ok_or("Type the bank's website, like chase.com.")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
        .build().map_err(|e| e.to_string())?;
    let home = format!("https://{}/", host);
    let mut tries: Vec<String> = Vec::new();
    if let Ok(r) = client.get(&home).send().await {
        let base = r.url().clone();
        if let Ok(html) = r.text().await {
            for href in icon_links(&html) {
                if let Ok(u) = base.join(&href) { tries.push(u.to_string()); }
            }
        }
    }
    for p in ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.ico"] {
        tries.push(format!("https://{}{}", host, p));
    }
    tries.dedup();
    for u in tries.iter().take(8) {
        let Ok(r) = client.get(u).send().await else { continue };
        if !r.status().is_success() { continue; }
        let Ok(bytes) = r.bytes().await else { continue };
        if bytes.len() > 4 * 1024 * 1024 { continue; }
        if let Ok(png) = logo_png(&bytes) { return Ok(png); }
    }
    Err(format!("{} did not give a logo this app can read. Choose an image file instead.", host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_and_sites_are_cleaned() {
        assert_eq!(clean_color(" #007aff "), Some("#007AFF".into()));
        assert_eq!(clean_color("blue"), None);
        assert_eq!(clean_color("#12345"), None);
        assert_eq!(clean_site("https://www.Example-Bank.com/business?x=1"), Some("www.example-bank.com".into()));
        assert_eq!(clean_site("examplebank.com"), Some("examplebank.com".into()));
        assert_eq!(clean_site("not a site"), None);
        assert_eq!(clean_site("localhost"), None);
        assert_eq!(clean_site("http://a.com@evil/"), None);
    }

    #[test]
    fn page_icons_come_best_first() {
        let html = r#"<head><link rel="stylesheet" href="/a.css">
            <link rel="icon" type="image/png" sizes="32x32" href="/fav-32.png">
            <link href='/touch.png' rel='apple-touch-icon' sizes='180x180'>
            <LINK REL="shortcut icon" HREF="/favicon.ico">
            <link rel="icon" href="/logo.svg">
            <link rel="icon" sizes="192x192" href="https://cdn.example.com/i-192.png"></head>"#;
        assert_eq!(icon_links(html), vec!["/touch.png", "https://cdn.example.com/i-192.png", "/fav-32.png", "/favicon.ico"]);
        assert!(icon_links("<html>no icons</html>").is_empty());
    }

    #[test]
    fn a_logo_is_stored_small() {
        let img = image::DynamicImage::new_rgba8(600, 300);
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageOutputFormat::Png).unwrap();
        let png = b64().decode(logo_png(&buf.into_inner()).unwrap()).unwrap();
        let back = image::load_from_memory(&png).unwrap();
        assert_eq!((back.width(), back.height()), (128, 64));
        assert!(logo_png(b"not an image").is_err());
    }

    #[test]
    fn his_choice_wins_over_the_banks_own() {
        let looks: Map<String, Value> = serde_json::from_value(json!({ "p:1": { "color": "#FF2D55" } })).unwrap();
        let brands = json!({ "item-a": { "color": "#117ACA", "logo": "PLAID" } });
        assert_eq!(effective(&looks, &brands, "p:1", "item-a"), (Some("#FF2D55".into()), Some("PLAID".into())));
        assert_eq!(effective(&looks, &brands, "p:2", "item-a"), (Some("#117ACA".into()), Some("PLAID".into())));
        assert_eq!(effective(&looks, &brands, "p:3", "item-b"), (None, None));
    }

    #[test]
    fn a_bank_wanting_a_sign_in_marks_its_accounts() {
        let h = json!({ "items": {
            "a": { "code": "ITEM_LOGIN_REQUIRED" },
            "b": { "code": "", "dropped": [{ "name": "Savings", "mask": "4821", "since": "2026-11-01" }] } } });
        assert!(needs_fix(&h, "a", "Checking", "1102"));
        assert!(needs_fix(&h, "b", "Savings", "4821"));
        assert!(!needs_fix(&h, "b", "Checking", "1102"));
        assert!(!needs_fix(&h, "c", "Checking", "1102"));
    }
}
