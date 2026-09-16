//! Freight tracking from Priority1's shipment-update emails (R-277).
//!
//! The IMAP watcher hands every inbound message to `email::process_new_emails`, which
//! offers it to `ingest` too. A Priority1 update becomes (or updates) one `shipments`
//! row, synced so the phone shows the same status. A shipment attaches to a deal three
//! ways: a reference number in the email equals one of the org's invoice numbers; a BOL,
//! PRO or pickup number pasted on the deal (`link_shipment_ref`); or one tap on a
//! suggested deal. Once a deal carries a Priority1 shipment WITH a BOL, Priority1 sets the
//! deal's pickup and delivery dates (R-279, reversing R-277's "never"); a deal without one
//! keeps the dates typed on it. The dates are derived from the whole timeline every time, so
//! it does not matter whether the email or the typed BOL came first.
//!
//! Parsing is deliberately label-and-pattern based rather than position based: the same
//! email arrives as an HTML table (label cells and value cells can come out interleaved
//! when flattened) or as plain text, and every field is optional.

use crate::db::pool;
use crate::email::ParsedEmail;
use chrono::{TimeZone, Utc};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};

/// R-318: the app handle, so a delivery can announce itself. Set once at startup; the
/// tests and any path running before setup simply do not announce.
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Hand the handle over at startup (`main.rs` setup).
pub fn set_app(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Parsed {
    pub shipment_number: String,
    pub bol: String,
    pub pro: String,
    pub pickup_number: String,
    /// Every reference row the email lists, label and value (BOL, PRO, PO, …).
    pub refs: Vec<(String, String)>,
    pub carrier: String,
    pub status: String,
    pub stage: String,
    pub origin: String,
    pub destination: String,
    pub location: String,
    pub note: String,
    /// RFC3339 UTC, or empty when the email gives no update date.
    pub update_at: String,
    pub details_url: String,
    /// YYYY-MM-DD when the email states a pickup date / an estimated delivery (booking and
    /// dispatch confirmations do; the plain status update does not). Empty otherwise.
    pub pickup_date: String,
    pub eta: String,
}

pub fn is_priority1_sender(from: &str) -> bool {
    let f = from.trim().to_ascii_lowercase();
    f.ends_with("@priority1.com") || f.ends_with(".priority1.com")
}

/// Flatten an HTML body into trimmed, non-empty lines. Cell and block ends become line
/// breaks so a label and its value never run together.
fn html_lines(html: &str) -> Vec<String> {
    let drop = Regex::new(r"(?is)<(style|script|head)[^>]*>.*?</(style|script|head)>").unwrap();
    let s = drop.replace_all(html, " ");
    // Opening tags too: `<b>Reference Numbers:</b><table><tr><td>BOL` must not flatten
    // into one "Reference Numbers: BOL" line.
    let brk = Regex::new(r"(?i)<br\s*/?>|</?(p|div|tr|td|th|h[1-6]|li|table|tbody|thead)\b[^>]*>").unwrap();
    let s = brk.replace_all(&s, "\n");
    let tag = Regex::new(r"(?s)<[^>]+>").unwrap();
    let s = tag.replace_all(&s, " ");
    text_lines(&decode_entities(&s))
}

fn text_lines(text: &str) -> Vec<String> {
    let ws = Regex::new(r"[ \t\u{00a0}]+").unwrap();
    text.lines()
        .map(|l| ws.replace_all(l, " ").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ").replace("&#160;", " ").replace("&amp;", "&").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'")
}

const LABELS: &[&str] = &[
    "carrier:", "status:", "origin:", "destination:", "reference numbers:", "update date:",
    "city:", "state:",
];

fn is_label(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    LABELS.contains(&l.as_str()) || (l.starts_with("update from") && l.ends_with(':'))
}

/// The date stated for a label, as YYYY-MM-DD. Handles the value on the label's own line, and
/// a flattened table row where several labels come first and their values follow in order.
fn day_after_label(lines: &[String], labels: &[&str]) -> String {
    let re = Regex::new(r"(\d{1,2})/(\d{1,2})/(\d{4})|(\d{4})-(\d{2})-(\d{2})").unwrap();
    let to_day = |c: regex::Captures| -> Option<String> {
        let (y, m, d): (i32, u32, u32) = if c.get(1).is_some() {
            (c[3].parse().ok()?, c[1].parse().ok()?, c[2].parse().ok()?)
        } else {
            (c[4].parse().ok()?, c[5].parse().ok()?, c[6].parse().ok()?)
        };
        chrono::NaiveDate::from_ymd_opt(y, m, d).map(|dt| dt.format("%Y-%m-%d").to_string())
    };
    let is_lab = |l: &str| { let x = l.to_ascii_lowercase(); labels.iter().any(|lb| x.starts_with(lb)) && x.contains(':') };
    let Some(i) = lines.iter().position(|l| is_lab(l)) else { return String::new() };
    if let Some(c) = re.captures(&lines[i]) { return to_day(c).unwrap_or_default(); }
    // A block of bare labels ("Pickup Date:", "Estimated Delivery:") followed by their values.
    let bare = |l: &str| l.trim_end().ends_with(':');
    let mut start = i;
    while start > 0 && bare(&lines[start - 1]) { start -= 1; }
    let mut end = i;
    while end + 1 < lines.len() && bare(&lines[end + 1]) { end += 1; }
    // Each label's value sits at the same offset in the row that follows. Taken only if THAT
    // line is a date — never the next date-shaped value, which would belong to another label.
    lines.get(end + 1 + (i - start)).and_then(|l| re.captures(l)).and_then(|c| to_day(c)).unwrap_or_default()
}

fn find_line(lines: &[String], label: &str) -> Option<usize> {
    lines.iter().position(|l| l.to_ascii_lowercase().starts_with(label))
}

/// Map a carrier status to the stage the UI shows.
pub fn stage_of(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.is_empty() {
        ""
    } else if s.contains("out for delivery") {
        "out_for_delivery"
    } else if ["exception", "delay", "hold", "refused", "damage", "attempt", "missed", "returned", "cancel"]
        .iter().any(|w| s.contains(w))
    {
        "exception"
    } else if s.contains("deliver") && !s.contains("schedul") && !s.contains("appointment") {
        "delivered"
    } else if s.contains("transit") || s.contains("terminal") || s.contains("arrived") || s.contains("departed") || s.contains("en route") {
        "in_transit"
    } else if s.contains("picked up") || s.contains("picked-up") || s.contains("pickup complete") {
        "picked_up"
    } else {
        "booked"
    }
}

/// Parse one Priority1 email. `None` when it carries no shipment identity or nothing
/// about the shipment (a quote, an invoice, a newsletter from the same domain).
pub fn parse(subject: &str, body_text: &str, body_html: Option<&str>) -> Option<Parsed> {
    let lines = match body_html {
        Some(h) if !h.trim().is_empty() => html_lines(h),
        _ => text_lines(body_text),
    };
    let mut p = Parsed::default();

    let ship_re = Regex::new(r"(?i)shipment\s*(?:#|no\.?|number)?\s*:?\s*([A-Z]{0,4}\d[0-9A-Z-]{3,})").unwrap();
    p.shipment_number = ship_re.captures(subject)
        .or_else(|| lines.iter().find_map(|l| ship_re.captures(l)))
        .map(|c| c[1].to_string())
        .unwrap_or_default();

    // Reference rows: "BOL 6011…" on one line, "BOL: 6011…", or the label alone with the
    // value on the next line (a two-cell table row flattened).
    let ref_re = Regex::new(r"(?i)^(BOL|B/L|PRO|Carrier Pickup|Pickup|PO|PO Number|Purchase Order|Shipper Reference|Shipper Ref|Customer Reference|Customer Ref|Reference|Order|Order Number|Quote|Quote Number)\s*(?:#|No\.?|Number)?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})?$").unwrap();
    let value_re = Regex::new(r"(?i)^[A-Z0-9][A-Z0-9-]{2,}$").unwrap();
    let mut i = 0;
    while i < lines.len() {
        if let Some(c) = ref_re.captures(&lines[i]) {
            let label = c[1].to_string();
            let value = match c.get(2) {
                Some(v) => Some(v.as_str().to_string()),
                None => lines.get(i + 1).filter(|n| value_re.is_match(n) && n.chars().any(|ch| ch.is_ascii_digit())).cloned(),
            };
            if let Some(v) = value {
                if c.get(2).is_none() { i += 1; }
                match label.to_ascii_lowercase().as_str() {
                    "bol" | "b/l" if p.bol.is_empty() => p.bol = v.clone(),
                    "pro" if p.pro.is_empty() => p.pro = v.clone(),
                    "carrier pickup" | "pickup" if p.pickup_number.is_empty() => p.pickup_number = v.clone(),
                    _ => {}
                }
                if !p.refs.iter().any(|(l, x)| l.eq_ignore_ascii_case(&label) && *x == v) {
                    p.refs.push((label, v));
                }
            }
        }
        i += 1;
    }

    // Carrier: "Name (SCAC)" after the Carrier: label, else the next non-label line.
    let scac_re = Regex::new(r"^([A-Za-z0-9][A-Za-z0-9&.,' -]{1,60}?)\s*\(([A-Z0-9]{2,5})\)$").unwrap();
    if let Some(ci) = lines.iter().position(|l| l.eq_ignore_ascii_case("carrier:") || l.to_ascii_lowercase().starts_with("carrier: ")) {
        let inline = lines[ci].splitn(2, ':').nth(1).map(str::trim).unwrap_or("");
        p.carrier = if !inline.is_empty() {
            inline.to_string()
        } else {
            lines[ci + 1..].iter().take(4).find(|l| scac_re.is_match(l)).cloned()
                .or_else(|| lines.get(ci + 1).filter(|l| !is_label(l)).cloned())
                .unwrap_or_default()
        };
    }

    // Status: the value after Status:, else the first known status phrase after it.
    let phrase_re = Regex::new(r"(?i)\b(out for delivery|delivered|in transit|picked up|pickup scheduled|dispatched|booked|exception|delayed|on hold|arrived at terminal|at terminal)\b").unwrap();
    if let Some(si) = lines.iter().position(|l| l.eq_ignore_ascii_case("status:") || l.to_ascii_lowercase().starts_with("status: ")) {
        let inline = lines[si].splitn(2, ':').nth(1).map(str::trim).unwrap_or("");
        p.status = if !inline.is_empty() {
            inline.to_string()
        } else {
            lines[si + 1..].iter().take(6).find(|l| phrase_re.is_match(l) && l.len() <= 60).cloned()
                .or_else(|| lines.get(si + 1).filter(|l| !is_label(l) && l.len() <= 60).cloned())
                .unwrap_or_default()
        };
    }
    if p.status.is_empty() {
        if let Some(c) = phrase_re.captures(subject) { p.status = c[1].to_string(); }
    }
    p.stage = stage_of(&p.status).to_string();

    // Origin / destination: the first "City, ST 12345" line after each label.
    let csz_re = Regex::new(r"^([A-Za-z][A-Za-z .'-]*?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$").unwrap();
    let csz_after = |from: usize, until: usize| -> String {
        lines.iter().enumerate().skip(from + 1).take_while(|(k, _)| *k < until)
            .find_map(|(_, l)| csz_re.captures(l).map(|c| format!("{}, {} {}", c[1].trim(), &c[2], &c[3])))
            .unwrap_or_default()
    };
    let oi = find_line(&lines, "origin:");
    let di = find_line(&lines, "destination:");
    if let Some(o) = oi {
        p.origin = csz_after(o, di.filter(|d| *d > o).unwrap_or(lines.len()));
    }
    if let Some(d) = di {
        p.destination = csz_after(d, lines.len());
    }

    // Update date: M/D/YYYY [H:MM AM], read as Central time.
    let date_re = Regex::new(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?").unwrap();
    if let Some(ui) = find_line(&lines, "update date:") {
        if let Some(c) = lines[ui..].iter().take(4).find_map(|l| date_re.captures(l)) {
            let (mo, d, y) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0));
            let mut h: u32 = c.get(4).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let mi: u32 = c.get(5).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            if let Some(ap) = c.get(6) {
                let pm = ap.as_str().eq_ignore_ascii_case("pm");
                if pm && h < 12 { h += 12; }
                if !pm && h == 12 { h = 0; }
            }
            if let Some(naive) = chrono::NaiveDate::from_ymd_opt(y, mo, d).and_then(|dt| dt.and_hms_opt(h.min(23), mi.min(59), 0)) {
                if let Some(local) = chrono_tz::America::Chicago.from_local_datetime(&naive).earliest() {
                    p.update_at = local.with_timezone(&Utc).to_rfc3339();
                }
            }
        }
    }

    p.pickup_date = day_after_label(&lines, &["pickup date", "scheduled pickup", "pickup scheduled", "ship date"]);
    p.eta = day_after_label(&lines, &["estimated delivery", "est. delivery", "est delivery", "eta", "expected delivery", "delivery date"]);

    // Where the update happened: "City, ST" after City:, when the email fills it in.
    let city_re = Regex::new(r"^[A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2}\b").unwrap();
    if let Some(ci) = find_line(&lines, "city:") {
        let inline = lines[ci].splitn(2, ':').nth(1).map(str::trim).unwrap_or("");
        p.location = if city_re.is_match(inline) {
            inline.to_string()
        } else {
            lines[ci + 1..].iter().take(3).find(|l| city_re.is_match(l)).cloned().unwrap_or_default()
        };
    }

    // The carrier's own words, after "Update from <carrier>:" up to the button.
    if let Some(ni) = lines.iter().position(|l| { let x = l.to_ascii_lowercase(); x.starts_with("update from") && x.contains(':') }) {
        let inline = lines[ni].splitn(2, ':').nth(1).map(str::trim).unwrap_or("").to_string();
        let mut parts: Vec<String> = if inline.is_empty() { vec![] } else { vec![inline] };
        for l in &lines[ni + 1..] {
            let x = l.to_ascii_lowercase();
            if x == "more details" || x.starts_with("sent by") || is_label(l) { break; }
            parts.push(l.clone());
        }
        let note = parts.join(" ");
        p.note = note.chars().take(500).collect();
    }

    if let Some(h) = body_html {
        let lower = h.to_ascii_lowercase();
        if let Some(at) = lower.find("more details") {
            if let Some(hi) = lower[..at].rfind("href=") {
                let rest = &h[hi + 5..];
                let q = rest.chars().next().unwrap_or('"');
                if q == '"' || q == '\'' {
                    if let Some(end) = rest[1..].find(q) {
                        let url = decode_entities(&rest[1..1 + end]);
                        if url.starts_with("http") { p.details_url = url; }
                    }
                }
            }
        }
    }

    // A quote, rate confirmation or invoice from the same sender can carry a route and a
    // carrier too, so without a status the email must at least SAY it is about tracking.
    let has_id = !(p.bol.is_empty() && p.pro.is_empty() && p.shipment_number.is_empty());
    let subj = subject.to_ascii_lowercase();
    let about_tracking = ["shipment", "tracking", "delivered", "picked up", "in transit"].iter().any(|w| subj.contains(w));
    let has_news = !p.status.is_empty()
        || (about_tracking && !(p.carrier.is_empty() && p.origin.is_empty() && p.destination.is_empty()));
    if has_id && has_news { Some(p) } else { None }
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct Shipment {
    pub id: String,
    pub deal_flow_id: String,
    pub broker: String,
    pub shipment_number: String,
    pub bol: String,
    pub pro: String,
    pub pickup_number: String,
    pub refs_json: String,
    pub carrier: String,
    pub status: String,
    pub stage: String,
    pub origin: String,
    pub destination: String,
    pub last_location: String,
    pub last_note: String,
    pub last_update_at: String,
    pub details_url: String,
    pub events_json: String,
    pub dismissed: i64,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str = "id, COALESCE(deal_flow_id,''), COALESCE(broker,''), COALESCE(shipment_number,''), COALESCE(bol,''), \
    COALESCE(pro,''), COALESCE(pickup_number,''), COALESCE(refs_json,'[]'), COALESCE(carrier,''), COALESCE(status,''), \
    COALESCE(stage,''), COALESCE(origin,''), COALESCE(destination,''), COALESCE(last_location,''), COALESCE(last_note,''), \
    COALESCE(last_update_at,''), COALESCE(details_url,''), COALESCE(events_json,'[]'), COALESCE(dismissed,0), created_at, updated_at";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<Shipment> {
    Ok(Shipment {
        id: r.get(0)?, deal_flow_id: r.get(1)?, broker: r.get(2)?, shipment_number: r.get(3)?, bol: r.get(4)?,
        pro: r.get(5)?, pickup_number: r.get(6)?, refs_json: r.get(7)?, carrier: r.get(8)?, status: r.get(9)?,
        stage: r.get(10)?, origin: r.get(11)?, destination: r.get(12)?, last_location: r.get(13)?, last_note: r.get(14)?,
        last_update_at: r.get(15)?, details_url: r.get(16)?, events_json: r.get(17)?, dismissed: r.get(18)?,
        created_at: r.get(19)?, updated_at: r.get(20)?,
    })
}

/// A readable, stable row id. Two desktops watch the same mailboxes, so both ingest the
/// same email — a deterministic id makes that one row instead of two after sync. The org is
/// part of it because the server's table is shared and BOL/PRO numbers are carrier-assigned,
/// so two workspaces can hold the same one. Same rule as clienthub-api routes/shipments.rs.
fn id_for(org: &str, key: &str) -> String {
    let k: String = key.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase();
    format!("shp-{org}-{k}")
}

/// The row an email's update belongs to. Numbers match like for like — a BOL against BOLs,
/// a PRO against PROs — because a carrier's PRO can equal an unrelated shipment's pickup
/// number, and matching across types would merge two shipments' histories. Priority1's
/// "Shipment #" is the BOL, so those two are one family. A row made by pasting a number on
/// a deal knows only that number, not its type, so it matches any of them.
fn find_for_update(conn: &rusqlite::Connection, p: &Parsed) -> Option<Shipment> {
    // An empty value must never match an empty column; this sentinel cannot be a reference.
    let v = |s: &str| if s.trim().is_empty() { "#NONE#".to_string() } else { s.trim().to_ascii_uppercase() };
    let sql = format!(
        "SELECT {COLS} FROM shipments WHERE
            (COALESCE(bol,'') <> '' AND UPPER(bol) IN (?1, ?3))
         OR (COALESCE(shipment_number,'') <> '' AND UPPER(shipment_number) IN (?1, ?3)
             AND (COALESCE(bol,'') <> '' OR COALESCE(pro,'') <> '' OR COALESCE(pickup_number,'') <> ''))
         OR (COALESCE(pro,'') <> '' AND UPPER(pro) = ?2)
         OR (COALESCE(pickup_number,'') <> '' AND UPPER(pickup_number) = ?4)
         OR (COALESCE(bol,'') = '' AND COALESCE(pro,'') = '' AND COALESCE(pickup_number,'') = ''
             AND UPPER(COALESCE(shipment_number,'')) IN (?1, ?2, ?3, ?4))
         ORDER BY created_at LIMIT 1"
    );
    conn.query_row(&sql, rusqlite::params![v(&p.bol), v(&p.pro), v(&p.shipment_number), v(&p.pickup_number)], map_row).ok()
}

/// A number pasted on a deal: whichever of the four it is.
fn find_by_any_ref(conn: &rusqlite::Connection, r: &str) -> Option<Shipment> {
    let sql = format!(
        "SELECT {COLS} FROM shipments WHERE UPPER(bol) = ?1 OR UPPER(pro) = ?1 \
         OR UPPER(shipment_number) = ?1 OR UPPER(pickup_number) = ?1 ORDER BY created_at LIMIT 1"
    );
    conn.query_row(&sql, [r.trim().to_ascii_uppercase()], map_row).ok()
}

/// A reference in the email that is one of this org's invoice numbers → that deal.
fn deal_for_refs(conn: &rusqlite::Connection, refs: &[(String, String)]) -> Option<String> {
    refs.iter().find_map(|(_, v)| {
        conn.query_row(
            "SELECT df.id FROM deal_flows df JOIN invoices i ON i.id = df.invoice_id
             WHERE LOWER(i.number) = LOWER(?1) AND COALESCE(i.archived,0) = 0 AND COALESCE(i.voided,0) = 0
             ORDER BY df.created_at DESC LIMIT 1",
            [v], |r| r.get::<_, String>(0),
        ).ok()
    })
}

fn write_cols(conn: &rusqlite::Connection, id: &str, cols: &Map<String, Value>, create: bool) -> Result<(), String> {
    if create {
        let keys: Vec<&String> = cols.keys().collect();
        let sql = format!(
            "INSERT OR IGNORE INTO shipments (id, {}) VALUES (?1, {})",
            keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "),
            (2..=keys.len() + 1).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
        );
        let mut params: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(id.to_string())];
        params.extend(cols.values().map(to_sql));
        conn.execute(&sql, rusqlite::params_from_iter(params.iter())).map_err(|e| e.to_string())?;
    } else {
        let sets: Vec<String> = cols.keys().enumerate().map(|(i, k)| format!("{k}=?{}", i + 1)).collect();
        let sql = format!("UPDATE shipments SET {} WHERE id=?{}", sets.join(", "), cols.len() + 1);
        let mut params: Vec<rusqlite::types::Value> = cols.values().map(to_sql).collect();
        params.push(rusqlite::types::Value::Text(id.to_string()));
        conn.execute(&sql, rusqlite::params_from_iter(params.iter())).map_err(|e| e.to_string())?;
    }
    crate::sync::record_upsert("shipments", id, cols.clone()).map_err(|e| e.to_string())
}

fn to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
        _ => rusqlite::types::Value::Null,
    }
}

/// Every column a create must carry (a create upsert missing a column the other side
/// needs is silently written as 0 rows — decisions/a-create-event-carries-every-not-null-column).
fn full_cols(s: &Shipment) -> Map<String, Value> {
    let mut c = Map::new();
    // An empty link is left OFF the create: two desktops create the same row from the same
    // email, and per-column last-writer-wins would let one that has not synced the invoice
    // yet overwrite the other's real link with "". Absent, the column defaults to ''.
    if !s.deal_flow_id.is_empty() {
        c.insert("deal_flow_id".into(), Value::String(s.deal_flow_id.clone()));
    }
    c.insert("org_id".into(), Value::String(crate::employees::session_org_id()));
    for (k, v) in [
        ("broker", &s.broker), ("shipment_number", &s.shipment_number),
        ("bol", &s.bol), ("pro", &s.pro), ("pickup_number", &s.pickup_number), ("refs_json", &s.refs_json),
        ("carrier", &s.carrier), ("status", &s.status), ("stage", &s.stage), ("origin", &s.origin),
        ("destination", &s.destination), ("last_location", &s.last_location), ("last_note", &s.last_note),
        ("last_update_at", &s.last_update_at), ("details_url", &s.details_url), ("events_json", &s.events_json),
        ("created_at", &s.created_at), ("updated_at", &s.updated_at),
    ] {
        c.insert(k.into(), Value::String(v.clone()));
    }
    c.insert("dismissed".into(), json!(s.dismissed));
    c
}

/// Offer an inbound email. Returns true when it was a Priority1 shipment update and has
/// been recorded. The caller carries on with its normal handling either way.
pub fn ingest(email: &ParsedEmail) -> bool {
    if !is_priority1_sender(&email.from) {
        return false;
    }
    let Some(p) = parse(&email.subject, &email.body_text, email.body_html.as_deref()) else {
        tracing::info!("priority1: mail '{}' has no shipment update in it, left alone", email.subject);
        return false;
    };
    match apply(&p, email.message_id.as_deref(), email.date.as_deref()) {
        Ok(id) => { tracing::info!("priority1: shipment {} updated ({})", id, p.status); true }
        Err(e) => { tracing::warn!("priority1: could not record shipment update: {}", e); false }
    }
}

/// Merge one parsed update into the store, then let it move the deal's dates (R-279). Split
/// from `ingest` so tests and the mailbox backfill share it.
pub fn apply(p: &Parsed, message_id: Option<&str>, email_date: Option<&str>) -> Result<String, String> {
    let (id, delivered) = apply_inner(p, message_id, email_date)?;
    sync_deal_dates(&id);
    if delivered {
        announce_delivered(&id);
    }
    Ok(id)
}

/// R-318: say out loud that a shipment has landed, because the deal it is on can now be
/// completed and nothing else tells anyone. An OS notification (the app is usually not the
/// window in front when the email arrives) plus an event the open window turns into a green
/// toast; the green row on Deal Flow is what keeps saying it afterwards.
///
/// Only for a shipment attached to a deal that is still open: the whole point is "so we can
/// mark the deals as complete", so a delivery on a deal already completed says nothing, and
/// an unattached shipment is already listed under "Shipments not on a deal". Best-effort —
/// a failure here never fails the update that caused it.
fn announce_delivered(shipment_id: &str) {
    let Some(app) = APP.get() else { return };
    let Ok(conn) = pool().get() else { return };
    let Ok(s) = conn.query_row(&format!("SELECT {COLS} FROM shipments WHERE id=?1"), [shipment_id], map_row) else { return };
    if s.deal_flow_id.is_empty() {
        return;
    }
    let Ok((stage, client, number)) = conn.query_row(
        "SELECT df.stage, COALESCE(c.name,''), COALESCE(i.number,'')
           FROM deal_flows df
           JOIN invoices i ON i.id = df.invoice_id
           LEFT JOIN clients c ON c.id = i.client_id
          WHERE df.id = ?1",
        [&s.deal_flow_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
    ) else { return };
    if stage == "complete" {
        return;
    }
    let mut parts: Vec<String> = Vec::new();
    if !client.is_empty() { parts.push(client); }
    if !number.is_empty() { parts.push(number); }
    if parts.is_empty() { parts.push(refs_line(&s)); }
    let label = parts.join(" · ");

    use tauri::Emitter;
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder()
        .title("Delivered")
        .body(format!("{label} — ready to mark the deal complete"))
        .show();
    let _ = app.emit("shipment-delivered", json!({ "id": s.id, "deal_flow_id": s.deal_flow_id, "label": label }));
    tracing::info!("priority1: shipment {} delivered, deal {} can be completed", s.id, s.deal_flow_id);
}

/// "BOL 60115779865 · PRO 687651776", or the shipment number when it has neither.
fn refs_line(s: &Shipment) -> String {
    let refs: Vec<String> = [
        (!s.bol.is_empty()).then(|| format!("BOL {}", s.bol)),
        (!s.pro.is_empty()).then(|| format!("PRO {}", s.pro)),
    ].into_iter().flatten().collect();
    if refs.is_empty() { format!("#{}", s.shipment_number) } else { refs.join(" · ") }
}

/// The deal's pickup and delivery dates according to Priority1's timeline, as YYYY-MM-DD in
/// Central time. `None` means Priority1 has not said, and the deal keeps what it has.
///   pickup   — the day it was picked up; else a pickup date an email stated; else the first
///              day it was moving. A delivery alone never invents a pickup date.
///   delivery — the day it was delivered; else the latest estimated delivery an email stated.
pub fn deal_dates(events: &[Value]) -> (Option<String>, Option<String>) {
    let mut ev: Vec<&Value> = events.iter().collect();
    ev.sort_by(|a, b| a.get("at").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("at").and_then(|v| v.as_str()).unwrap_or("")));
    let s = |e: &Value, k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let stage = |e: &Value| { let st = s(e, "stage"); if st.is_empty() { stage_of(&s(e, "status")).to_string() } else { st } };
    let day = |e: &Value| chrono::DateTime::parse_from_rfc3339(&s(e, "at")).ok()
        .map(|d| d.with_timezone(&chrono_tz::America::Chicago).format("%Y-%m-%d").to_string());
    let picked = ev.iter().filter(|e| stage(e) == "picked_up").find_map(|e| day(e));
    let stated_pickup = ev.iter().rev().map(|e| s(e, "pickup_date")).find(|d| !d.is_empty());
    let moving = ev.iter().filter(|e| matches!(stage(e).as_str(), "in_transit" | "out_for_delivery")).find_map(|e| day(e));
    let delivered = ev.iter().rev().filter(|e| stage(e) == "delivered").find_map(|e| day(e));
    let eta = ev.iter().rev().map(|e| s(e, "eta")).find(|d| !d.is_empty());
    (picked.or(stated_pickup).or(moving), delivered.or(eta))
}

/// The deal's own dates, captured the first time Priority1 is about to move them, so a
/// shipment taken off the deal can hand them back ("unless I do not have a BOL, show what I
/// had"). `shipments.deal_dates_before` (migration 96): {"deal", "pickup", "delivery", "direct"}.
fn stash_deal_dates(shipment_id: &str, deal: &str) {
    let Ok(conn) = pool().get() else { return };
    let before: String = conn.query_row("SELECT COALESCE(deal_dates_before,'') FROM shipments WHERE id=?1", [shipment_id], |r| r.get(0)).unwrap_or_default();
    if serde_json::from_str::<Value>(&before).ok().and_then(|v| v.get("deal").and_then(|d| d.as_str()).map(|d| d == deal)).unwrap_or(false) {
        return; // already holding this deal's own dates
    }
    let Ok((pickup, delivery, direct)) = conn.query_row(
        "SELECT pickup_date, expected_delivery_date, COALESCE(ships_direct,0) FROM deal_flows WHERE id=?1", [deal],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?)),
    ) else { return };
    let stash = json!({"deal": deal, "pickup": pickup, "delivery": delivery, "direct": direct}).to_string();
    let mut cols = Map::new();
    cols.insert("deal_dates_before".into(), Value::String(stash));
    if let Err(e) = write_cols(&conn, shipment_id, &cols, false) {
        tracing::warn!("priority1: could not remember deal {}'s dates: {}", deal, e);
    }
}

/// A shipment left `old_deal` (detached, or moved to another deal): if Priority1 had been
/// setting that deal's dates and no other Priority1 shipment with a BOL is still on it, put
/// back the dates it had before.
fn restore_deal_dates(shipment_id: &str, old_deal: &str) {
    if old_deal.is_empty() { return; }
    let Ok(conn) = pool().get() else { return };
    let before: String = conn.query_row("SELECT COALESCE(deal_dates_before,'') FROM shipments WHERE id=?1", [shipment_id], |r| r.get(0)).unwrap_or_default();
    let Some(v) = serde_json::from_str::<Value>(&before).ok() else { return };
    if v.get("deal").and_then(|d| d.as_str()) != Some(old_deal) { return; }
    let still_tracked: i64 = conn.query_row(
        "SELECT COUNT(*) FROM shipments WHERE deal_flow_id=?1 AND id<>?2 AND COALESCE(bol,'')<>''", [old_deal, shipment_id], |r| r.get(0),
    ).unwrap_or(0);
    if still_tracked == 0 {
        let day = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
        let direct = v.get("direct").and_then(|x| x.as_i64()).unwrap_or(0) != 0;
        match crate::commands::restore_shipping_dates(old_deal, day("pickup"), day("delivery"), direct) {
            Ok(_) => tracing::info!("priority1: deal {} got its own dates back", old_deal),
            Err(e) => { tracing::warn!("priority1: could not restore deal {}'s dates: {}", old_deal, e); return; }
        }
    }
    let mut cols = Map::new();
    cols.insert("deal_dates_before".into(), Value::String(String::new()));
    let _ = write_cols(&conn, shipment_id, &cols, false);
}

/// Push Priority1's dates onto the deal a shipment is attached to — only when the shipment
/// has a BOL. Called after every email and every attach, so the order they happen in never
/// matters. Best-effort: a failure is logged and the shipment itself is already saved.
pub fn sync_deal_dates(shipment_id: &str) {
    let row = pool().get().ok().and_then(|conn| {
        conn.query_row(&format!("SELECT {COLS} FROM shipments WHERE id=?1"), [shipment_id], map_row).ok()
    });
    let Some(s) = row else { return };
    if s.deal_flow_id.is_empty() || s.bol.trim().is_empty() {
        return;
    }
    let events: Vec<Value> = serde_json::from_str(&s.events_json).unwrap_or_default();
    let (pickup, delivery) = deal_dates(&events);
    if pickup.is_none() && delivery.is_none() {
        return;
    }
    stash_deal_dates(&s.id, &s.deal_flow_id);
    match crate::commands::apply_shipping_dates(&s.deal_flow_id, pickup, delivery) {
        Ok(true) => tracing::info!("priority1: shipment {} moved deal {}'s dates", s.id, s.deal_flow_id),
        Ok(false) => {}
        Err(e) => tracing::warn!("priority1: could not set deal {}'s dates: {}", s.deal_flow_id, e),
    }
}

/// Look through the monitored mailboxes for Priority1 mail mentioning `reference` and record
/// it, so a BOL typed on a deal after the email was already read — even mail that arrived
/// before this app ever watched the inbox — still brings its updates with it.
async fn backfill_ref(reference: &str) {
    if !valid_ref(reference) {
        return;
    }
    let since = (Utc::now() - chrono::Duration::days(120)).format("%d-%b-%Y").to_string();
    let query = format!("FROM \"priority1.com\" TEXT \"{reference}\" SINCE {since}");
    // Every mailbox at once, each capped at 15 s, so one that does not answer cannot hold up
    // the paste on the deal.
    let searches = crate::email::load_inboxes().into_iter().filter(|i| !i.demo).map(|ib| {
        let q = query.clone();
        async move {
            match tokio::time::timeout(std::time::Duration::from_secs(15), crate::email::search_inbox(&ib.id, q, 50, u32::MAX)).await {
                Ok(Ok(mails)) => mails,
                Ok(Err(e)) => { tracing::warn!("priority1: could not search {}: {}", ib.label, e); Vec::new() }
                Err(_) => { tracing::warn!("priority1: searching {} timed out", ib.label); Vec::new() }
            }
        }
    });
    let mut mails: Vec<ParsedEmail> = futures::future::join_all(searches).await.into_iter().flatten().collect();
    mails.sort_by(|a, b| a.date.cmp(&b.date));
    record_priority1_mail(&mails);
}

/// Record every Priority1 update in `mails` (oldest first). The half of the mailbox backfill
/// that does not need a mailbox, so it is testable.
fn record_priority1_mail(mails: &[ParsedEmail]) -> usize {
    let mut n = 0;
    for m in mails.iter().filter(|m| is_priority1_sender(&m.from)) {
        if let Some(p) = parse(&m.subject, &m.body_text, m.body_html.as_deref()) {
            match apply(&p, m.message_id.as_deref(), m.date.as_deref()) {
                Ok(_) => n += 1,
                Err(e) => tracing::warn!("priority1: could not record '{}': {}", m.subject, e),
            }
        }
    }
    n
}

/// A reference as Priority1 writes one: 3–40 letters, digits and dashes, with a digit in it.
/// Also what makes it safe to put inside an IMAP search.
fn valid_ref(r: &str) -> bool {
    (3..=40).contains(&r.len()) && r.chars().any(|c| c.is_ascii_digit()) && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Merge one update into the row. Returns the shipment id and whether THIS update is what
/// moved it to delivered — a row created already delivered is the mailbox backfill reading
/// old mail, which is history rather than news, so it does not announce.
fn apply_inner(p: &Parsed, message_id: Option<&str>, email_date: Option<&str>) -> Result<(String, bool), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let at = if !p.update_at.is_empty() { p.update_at.clone() } else { email_date.unwrap_or(&now).to_string() };
    let event = json!({
        "at": at, "status": p.status, "stage": p.stage, "location": p.location, "note": p.note,
        "message_id": message_id.unwrap_or(""), "pickup_date": p.pickup_date, "eta": p.eta,
    });
    let existing = find_for_update(&conn, p);
    let refs_json = serde_json::to_string(&p.refs.iter().map(|(l, v)| json!({"label": l, "value": v})).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());

    match existing {
        None => {
            let key = [&p.bol, &p.shipment_number, &p.pro].into_iter().find(|s| !s.is_empty()).cloned().unwrap_or_default();
            let id = id_for(&crate::employees::session_org_id(), &key);
            let s = Shipment {
                id: id.clone(),
                deal_flow_id: deal_for_refs(&conn, &p.refs).unwrap_or_default(),
                broker: "Priority1".into(),
                shipment_number: p.shipment_number.clone(), bol: p.bol.clone(), pro: p.pro.clone(),
                pickup_number: p.pickup_number.clone(), refs_json,
                carrier: p.carrier.clone(), status: p.status.clone(), stage: p.stage.clone(),
                origin: p.origin.clone(), destination: p.destination.clone(),
                last_location: p.location.clone(), last_note: p.note.clone(), last_update_at: at,
                details_url: p.details_url.clone(), events_json: Value::Array(vec![event]).to_string(),
                dismissed: 0, created_at: now.clone(), updated_at: now,
            };
            write_cols(&conn, &id, &full_cols(&s), true)?;
            Ok((id, false))
        }
        Some(s) => {
            let mut events: Vec<Value> = serde_json::from_str(&s.events_json).unwrap_or_default();
            let dup = events.iter().any(|e| {
                let mid = e.get("message_id").and_then(|v| v.as_str()).unwrap_or("");
                (!mid.is_empty() && Some(mid) == message_id)
                    || (e.get("at") == event.get("at") && e.get("status") == event.get("status") && e.get("note") == event.get("note"))
            });
            if !dup {
                events.push(event);
                events.sort_by(|a, b| a.get("at").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("at").and_then(|v| v.as_str()).unwrap_or("")));
            }
            let mut cols = Map::new();
            let mut fill = |k: &str, cur: &str, new: &str| {
                if !new.is_empty() && cur != new { cols.insert(k.into(), Value::String(new.to_string())); }
            };
            // Identity and route fields only ever gain information.
            if s.bol.is_empty() { fill("bol", &s.bol, &p.bol); }
            if s.pro.is_empty() { fill("pro", &s.pro, &p.pro); }
            if s.pickup_number.is_empty() { fill("pickup_number", &s.pickup_number, &p.pickup_number); }
            if s.shipment_number.is_empty() { fill("shipment_number", &s.shipment_number, &p.shipment_number); }
            fill("carrier", &s.carrier, &p.carrier);
            fill("origin", &s.origin, &p.origin);
            fill("destination", &s.destination, &p.destination);
            fill("details_url", &s.details_url, &p.details_url);
            if !p.refs.is_empty() { fill("refs_json", &s.refs_json, &refs_json); }
            // Status moves only forward in time: a backfilled older email adds to the
            // timeline without winding the current status back.
            if !dup && at.as_str() >= s.last_update_at.as_str() {
                fill("status", &s.status, &p.status);
                fill("stage", &s.stage, &p.stage);
                cols.insert("last_location".into(), Value::String(p.location.clone()));
                cols.insert("last_note".into(), Value::String(p.note.clone()));
                cols.insert("last_update_at".into(), Value::String(at.clone()));
            }
            if s.deal_flow_id.is_empty() {
                if let Some(df) = deal_for_refs(&conn, &p.refs) { cols.insert("deal_flow_id".into(), Value::String(df)); }
            }
            // R-318: this update, and no other, is the one that landed the shipment.
            let became_delivered = s.stage != "delivered"
                && cols.get("stage").and_then(|v| v.as_str()) == Some("delivered");
            if !dup { cols.insert("events_json".into(), Value::String(Value::Array(events).to_string())); }
            if cols.is_empty() { return Ok((s.id, false)); }
            cols.insert("updated_at".into(), Value::String(Utc::now().to_rfc3339()));
            write_cols(&conn, &s.id, &cols, false)?;
            Ok((s.id, became_delivered))
        }
    }
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

#[tauri::command]
pub async fn list_shipments() -> Result<Vec<Shipment>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {COLS} FROM shipments ORDER BY COALESCE(NULLIF(last_update_at,''), created_at) DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Attach (or with an empty `deal_flow_id`, detach) a shipment.
#[tauri::command]
pub async fn link_shipment(id: String, deal_flow_id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let old_deal: String = conn.query_row("SELECT COALESCE(deal_flow_id,'') FROM shipments WHERE id=?1", [&id], |r| r.get(0)).unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("deal_flow_id".into(), Value::String(deal_flow_id.clone()));
    cols.insert("dismissed".into(), json!(0));
    cols.insert("updated_at".into(), Value::String(Utc::now().to_rfc3339()));
    write_cols(&conn, &id, &cols, false)?;
    drop(conn);
    if old_deal != deal_flow_id {
        restore_deal_dates(&id, &old_deal);
    }
    sync_deal_dates(&id);
    Ok(())
}

/// Paste a BOL / PRO / pickup number on a deal. Attaches the shipment if Priority1 has
/// already emailed about it; otherwise records the number so the first email lands here.
#[tauri::command]
pub async fn link_shipment_ref(deal_flow_id: String, reference: String) -> Result<Shipment, String> {
    let r = reference.trim().to_string();
    if !valid_ref(&r) {
        return Err("Paste the BOL, PRO or pickup number from Priority1.".into());
    }
    // Not seen yet? The email may already be sitting in the inbox (read or not, from before
    // Ecliptr watched it): look for it before recording the number as a wait.
    let known = pool().get().ok().map(|conn| find_by_any_ref(&conn, &r).is_some()).unwrap_or(false);
    if !known {
        backfill_ref(&r).await;
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let id = match find_by_any_ref(&conn, &r) {
        Some(s) => {
            let mut cols = Map::new();
            cols.insert("deal_flow_id".into(), Value::String(deal_flow_id.clone()));
            cols.insert("dismissed".into(), json!(0));
            cols.insert("updated_at".into(), Value::String(now));
            write_cols(&conn, &s.id, &cols, false)?;
            if !s.deal_flow_id.is_empty() && s.deal_flow_id != deal_flow_id {
                restore_deal_dates(&s.id, &s.deal_flow_id);
            }
            s.id
        }
        None => {
            let id = id_for(&crate::employees::session_org_id(), &r);
            let s = Shipment {
                id: id.clone(), deal_flow_id, broker: "Priority1".into(), shipment_number: r,
                bol: String::new(), pro: String::new(), pickup_number: String::new(), refs_json: "[]".into(),
                // stage '' = "waiting for Priority1": nothing has been emailed about it yet.
                carrier: String::new(), status: String::new(), stage: String::new(), origin: String::new(),
                destination: String::new(), last_location: String::new(), last_note: String::new(),
                last_update_at: String::new(), details_url: String::new(), events_json: "[]".into(),
                dismissed: 0, created_at: now.clone(), updated_at: now,
            };
            write_cols(&conn, &id, &full_cols(&s), true)?;
            id
        }
    };
    sync_deal_dates(&id);
    let sql = format!("SELECT {COLS} FROM shipments WHERE id=?1");
    conn.query_row(&sql, [&id], map_row).map_err(|e| e.to_string())
}

/// Hide an unattached shipment that is not a deal (a transfer between your own buildings).
#[tauri::command]
pub async fn dismiss_shipment(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("dismissed".into(), json!(1));
    cols.insert("updated_at".into(), Value::String(Utc::now().to_rfc3339()));
    write_cols(&conn, &id, &cols, false)
}

#[derive(Serialize)]
pub struct DealSuggestion {
    pub deal_flow_id: String,
    pub label: String,
    pub score: i64,
    pub reason: String,
}

/// Rank open deals for an unattached shipment: the buyer's city/state against the
/// destination, and the deal's pickup date against when the shipment first appeared.
#[tauri::command]
pub async fn suggest_shipment_deals(id: String) -> Result<Vec<DealSuggestion>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {COLS} FROM shipments WHERE id=?1");
    let s = conn.query_row(&sql, [&id], map_row).map_err(|e| e.to_string())?;
    let first_seen = serde_json::from_str::<Vec<Value>>(&s.events_json).ok()
        .and_then(|ev| ev.first().and_then(|e| e.get("at")).and_then(|v| v.as_str()).map(|x| x.to_string()))
        .unwrap_or(s.created_at.clone());
    let seen_day = first_seen.get(..10).and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let dest = s.destination.to_ascii_lowercase();
    let dest_state = Regex::new(r",\s*([a-z]{2})\b").unwrap().captures(&dest).map(|c| c[1].to_string()).unwrap_or_default();
    let dest_city = dest.split(',').next().unwrap_or("").trim().to_string();

    let mut stmt = conn.prepare(
        "SELECT df.id, COALESCE(i.number,''), COALESCE(c.name,''), COALESCE(df.pickup_date,''),
                LOWER(COALESCE(json_extract(CASE WHEN json_valid(c.metadata) THEN c.metadata END,'$.city'),'')),
                LOWER(COALESCE(json_extract(CASE WHEN json_valid(c.metadata) THEN c.metadata END,'$.state'),'')),
                EXISTS(SELECT 1 FROM shipments sh WHERE sh.deal_flow_id = df.id)
         FROM deal_flows df
         JOIN invoices i ON i.id = df.invoice_id
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE df.stage <> 'complete' AND COALESCE(i.archived,0) = 0 AND COALESCE(i.voided,0) = 0
         ORDER BY df.created_at DESC LIMIT 200",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
        r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, bool>(6)?,
    ))).map_err(|e| e.to_string())?;

    let mut out: Vec<DealSuggestion> = rows.filter_map(|r| r.ok()).map(|(df, num, client, pickup, city, state, has)| {
        let mut score = 0;
        let mut why: Vec<String> = Vec::new();
        let st = state.trim();
        if !dest_state.is_empty() && (st == dest_state || (st.len() > 2 && us_state_code(st) == dest_state)) {
            score += 40; why.push("buyer is in the destination state".into());
            if !dest_city.is_empty() && city.trim() == dest_city { score += 20; why.push("same city".into()); }
        }
        if let (Some(seen), Ok(pd)) = (seen_day, chrono::NaiveDate::parse_from_str(pickup.get(..10).unwrap_or(""), "%Y-%m-%d")) {
            let gap = (pd - seen).num_days().abs();
            if gap <= 3 { score += 30; why.push(format!("pickup {}", pd.format("%b %-d"))); }
            else if gap <= 7 { score += 15; why.push(format!("pickup {}", pd.format("%b %-d"))); }
        }
        if !has { score += 10; }
        let label = [num.as_str(), client.as_str()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
        DealSuggestion { deal_flow_id: df, label, score, reason: why.join(", ") }
    }).collect();
    out.sort_by(|a, b| b.score.cmp(&a.score));
    Ok(out)
}

fn us_state_code(name: &str) -> String {
    const STATES: &[(&str, &str)] = &[
        ("alabama","al"),("alaska","ak"),("arizona","az"),("arkansas","ar"),("california","ca"),("colorado","co"),
        ("connecticut","ct"),("delaware","de"),("florida","fl"),("georgia","ga"),("hawaii","hi"),("idaho","id"),
        ("illinois","il"),("indiana","in"),("iowa","ia"),("kansas","ks"),("kentucky","ky"),("louisiana","la"),
        ("maine","me"),("maryland","md"),("massachusetts","ma"),("michigan","mi"),("minnesota","mn"),
        ("mississippi","ms"),("missouri","mo"),("montana","mt"),("nebraska","ne"),("nevada","nv"),
        ("new hampshire","nh"),("new jersey","nj"),("new mexico","nm"),("new york","ny"),("north carolina","nc"),
        ("north dakota","nd"),("ohio","oh"),("oklahoma","ok"),("oregon","or"),("pennsylvania","pa"),
        ("rhode island","ri"),("south carolina","sc"),("south dakota","sd"),("tennessee","tn"),("texas","tx"),
        ("utah","ut"),("vermont","vt"),("virginia","va"),("washington","wa"),("west virginia","wv"),
        ("wisconsin","wi"),("wyoming","wy"),
    ];
    STATES.iter().find(|(n, _)| *n == name).map(|(_, c)| c.to_string()).unwrap_or_default()
}

#[derive(Serialize)]
pub struct Priority1Scan {
    pub emails: usize,
    pub shipments: usize,
    pub errors: Vec<String>,
}

/// Look back through every monitored mailbox for Priority1 updates the watcher never saw
/// (anything that arrived before this build, or while the app was closed).
#[tauri::command]
pub async fn scan_priority1_mail(days: i64) -> Result<Priority1Scan, String> {
    let since = (Utc::now() - chrono::Duration::days(days.clamp(1, 120))).format("%d-%b-%Y").to_string();
    let query = format!("FROM \"priority1.com\" SINCE {since}");
    let mut result = Priority1Scan { emails: 0, shipments: 0, errors: vec![] };
    let mut touched = std::collections::HashSet::new();
    for ib in crate::email::load_inboxes().into_iter().filter(|i| !i.demo) {
        match crate::email::search_inbox(&ib.id, query.clone(), 300, u32::MAX).await {
            Ok(mut mails) => {
                mails.sort_by(|a, b| a.date.cmp(&b.date));
                for m in mails {
                    if !is_priority1_sender(&m.from) { continue; }
                    let Some(p) = parse(&m.subject, &m.body_text, m.body_html.as_deref()) else { continue };
                    result.emails += 1;
                    match apply(&p, m.message_id.as_deref(), m.date.as_deref()) {
                        Ok(id) => { touched.insert(id); }
                        Err(e) => result.errors.push(e),
                    }
                }
            }
            Err(e) => result.errors.push(format!("{}: {}", ib.label, e)),
        }
    }
    result.shipments = touched.len();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The update in Jack's screenshot (2026-09-11), as Priority1's HTML table flattens.
    const HTML: &str = r#"<html><head><style>td{font-family:Arial}</style></head><body>
<table><tr><td><h2>Update on Shipment #60115779865 for BJM Distributions</h2></td></tr>
<tr><td><b>Carrier:</b></td><td><b>Status:</b></td></tr>
<tr><td>EDI Express <small>(EDXI)</small></td><td>In transit</td></tr>
<tr><td><b>Origin:</b><br>BJM DISTRIBUTIONS<br><a href="https://maps.google.com/?q=x">20-21 Wagaraw Rd</a><br>Bldg 37<br>Fair Lawn, NJ 07410<br>Ben Mildice<br>+1 (815) 593-2342</td>
<td><b>Reference Numbers:</b><table><tr><td>BOL</td><td>60115779865</td></tr><tr><td>Carrier Pickup</td><td>1746470</td></tr><tr><td>PRO</td><td>687651776</td></tr></table></td></tr>
<tr><td><b>Destination:</b><br>BJM DISTRIBUTIONS<br><a href="https://maps.google.com/?q=y">6843 Conway Rd</a><br>Ste 210 DD2<br>Orlando, FL 32812<br>Ben Mildice<br>+1 (815) 593-2342</td></tr>
<tr><td><b>Update Date:</b></td><td><b>City:</b></td></tr>
<tr><td>9/10/2026 0:00 AM</td><td>,</td></tr>
<tr><td><b>Update from EDI Express:</b></td></tr>
<tr><td><a href="https://www.priority1.com/track?bol=60115779865&amp;t=abc" style="background:#2b6de8">More Details</a></td></tr>
<tr><td>Sent by <b>Priority1</b>, Little Rock, AR</td></tr></table></body></html>"#;

    #[test]
    fn parses_the_screenshot_update() {
        let p = parse("Tracking Update for Shipment 60115779865", "", Some(HTML)).expect("parsed");
        assert_eq!(p.shipment_number, "60115779865");
        assert_eq!(p.bol, "60115779865");
        assert_eq!(p.pro, "687651776");
        assert_eq!(p.pickup_number, "1746470");
        assert_eq!(p.carrier, "EDI Express (EDXI)");
        assert_eq!(p.status, "In transit");
        assert_eq!(p.stage, "in_transit");
        assert_eq!(p.origin, "Fair Lawn, NJ 07410");
        assert_eq!(p.destination, "Orlando, FL 32812");
        assert_eq!(p.location, "");
        assert_eq!(p.note, "");
        // 9/10/2026 midnight Central (daylight time) is 05:00 UTC.
        assert_eq!(p.update_at, "2026-09-10T05:00:00+00:00");
        assert_eq!(p.details_url, "https://www.priority1.com/track?bol=60115779865&t=abc");
    }

    #[test]
    fn parses_a_plain_text_update_with_inline_values() {
        let text = "Update on Shipment #60115779865 for BJM Distributions\nCarrier: EDI Express (EDXI)\nStatus: Delivered\n\
            Origin:\nBJM DISTRIBUTIONS\nFair Lawn, NJ 07410\nReference Numbers:\nBOL: 60115779865\nPRO: 687651776\nPO: INV-1042\n\
            Destination:\nAcme Liquidators\nTampa, FL 33601\nUpdate Date: 9/12/2026 2:15 PM\nCity: Tampa, FL\n\
            Update from EDI Express: Delivered, signed by J SMITH\nMore Details";
        let p = parse("Delivered: Shipment 60115779865", text, None).expect("parsed");
        assert_eq!(p.stage, "delivered");
        assert_eq!(p.destination, "Tampa, FL 33601");
        assert_eq!(p.location, "Tampa, FL");
        assert_eq!(p.note, "Delivered, signed by J SMITH");
        assert_eq!(p.update_at, "2026-09-12T19:15:00+00:00");
        assert!(p.refs.contains(&("PO".to_string(), "INV-1042".to_string())));
    }

    #[test]
    fn ignores_priority1_mail_that_is_not_a_shipment_update() {
        assert!(parse("Your Priority1 invoice is ready", "Invoice 88123 is attached. Amount due $412.00", None).is_none());
        assert!(!is_priority1_sender("notifications@priority1.co"));
        assert!(is_priority1_sender("Tracking@Priority1.com"));
    }

    #[test]
    fn a_rate_confirmation_with_a_route_is_not_an_update() {
        let text = "Rate confirmation\nCarrier: Estes Express (EXLA)\nOrigin:\nFair Lawn, NJ 07410\nDestination:\nTampa, FL 33601\nBOL: 70220011223";
        assert!(parse("Your Priority1 rate confirmation", text, None).is_none());
        // The same content with a tracking subject is one.
        assert!(parse("Tracking update for shipment 70220011223", text, None).is_some());
    }

    #[test]
    fn a_stated_pickup_and_eta_are_read_from_a_flattened_table_row() {
        let text = "Update on Shipment #60115779865\nStatus:\nBooked\nPickup Date:\nEstimated Delivery:\n9/9/2026\n9/15/2026\nBOL: 60115779865";
        let p = parse("Shipment 60115779865 booked", text, None).expect("parsed");
        assert_eq!(p.pickup_date, "2026-09-09");
        assert_eq!(p.eta, "2026-09-15");
        let inline = "Shipment #70220011223\nStatus: In transit\nETA: 2026-09-18\nBOL: 70220011223";
        assert_eq!(parse("Tracking update for shipment 70220011223", inline, None).unwrap().eta, "2026-09-18");
    }

    #[test]
    fn stated_dates_pair_with_their_own_label_when_other_labels_share_the_row() {
        let text = "Shipment #60115779865\nCarrier:\nStatus:\nPickup Date:\nEstimated Delivery:\nEDI Express (EDXI)\nBooked\n9/9/2026\n9/15/2026\nBOL: 60115779865";
        let p = parse("Shipment 60115779865 booked", text, None).expect("parsed");
        assert_eq!((p.pickup_date.as_str(), p.eta.as_str()), ("2026-09-09", "2026-09-15"));
        // A label whose own cell is not a date gets nothing, never its neighbour's date.
        let missing = "Shipment #60115779865\nStatus:\nPickup Date:\nEstimated Delivery:\nBooked\nTBD\n9/15/2026\nBOL: 60115779865";
        let q = parse("Shipment 60115779865 booked", missing, None).expect("parsed");
        assert_eq!((q.pickup_date.as_str(), q.eta.as_str()), ("", "2026-09-15"));
    }

    #[test]
    fn deal_dates_follow_the_timeline_not_the_order_emails_arrived() {
        let e = |at: &str, stage: &str, pickup: &str, eta: &str| json!({"at": at, "status": "", "stage": stage, "pickup_date": pickup, "eta": eta});
        // Booked with a stated pickup and ETA only.
        assert_eq!(deal_dates(&[e("2026-09-08T15:00:00Z", "booked", "2026-09-09", "2026-09-15")]),
            (Some("2026-09-09".into()), Some("2026-09-15".into())));
        // Delivered arrives before the in-transit email (backfill order): same answer as time order.
        let late_first = [e("2026-09-12T19:00:00Z", "delivered", "", ""), e("2026-09-10T05:00:00Z", "in_transit", "", "")];
        assert_eq!(deal_dates(&late_first), (Some("2026-09-10".into()), Some("2026-09-12".into())));
        // An actual pickup beats a stated one; a delivered day beats an ETA.
        let full = [e("2026-09-08T15:00:00Z", "booked", "2026-09-09", "2026-09-15"), e("2026-09-10T14:00:00Z", "picked_up", "", ""), e("2026-09-13T20:00:00Z", "delivered", "", "")];
        assert_eq!(deal_dates(&full), (Some("2026-09-10".into()), Some("2026-09-13".into())));
        // A delivery alone never invents a pickup date; nothing at all changes nothing.
        assert_eq!(deal_dates(&[e("2026-09-13T20:00:00Z", "delivered", "", "")]), (None, Some("2026-09-13".into())));
        assert_eq!(deal_dates(&[]), (None, None));
    }

    /// Jack's order, end to end against a real database: Priority1 emails first (read in
    /// Gmail, nothing on the deal), the BOL typed on the deal afterwards, then a later email.
    #[tokio::test]
    async fn an_email_read_before_the_bol_is_typed_still_moves_the_deal() {
        crate::db::init_test_store();
        {
            let conn = pool().get().unwrap();
            conn.execute("INSERT INTO clients (id, name, created_at, updated_at) VALUES ('c-r279', 'Acme', '2026-09-01', '2026-09-01')", []).unwrap();
            conn.execute("INSERT INTO invoices (id, client_id, number, issue_date, due_date, line_items_json, subtotal, total, created_at)
                           VALUES ('inv-r279', 'c-r279', 'INV-R279', '2026-09-01', '2026-09-30', '[]', 1000, 1000, '2026-09-01')", []).unwrap();
            conn.execute("INSERT INTO deal_flows (id, invoice_id, stage, created_at, updated_at, pickup_date, expected_delivery_date)
                           VALUES ('df-r279', 'inv-r279', 'invoiced', '2026-09-01', '2026-09-01', '2026-09-20', '2026-09-25')", []).unwrap();
            // The same deal's twin with no BOL ever typed keeps its dates throughout.
            conn.execute("INSERT INTO invoices (id, client_id, number, issue_date, due_date, line_items_json, subtotal, total, created_at)
                           VALUES ('inv-r279b', 'c-r279', 'INV-R279B', '2026-09-01', '2026-09-30', '[]', 1000, 1000, '2026-09-01')", []).unwrap();
            conn.execute("INSERT INTO deal_flows (id, invoice_id, stage, created_at, updated_at, pickup_date, expected_delivery_date)
                           VALUES ('df-r279b', 'inv-r279b', 'invoiced', '2026-09-01', '2026-09-01', '2026-09-21', '2026-09-26')", []).unwrap();
        }
        let dates = |id: &str| -> (Option<String>, Option<String>, Option<String>, Option<String>) {
            pool().get().unwrap().query_row(
                "SELECT pickup_date, expected_delivery_date, pickup_date_prev, expected_delivery_date_prev FROM deal_flows WHERE id=?1",
                [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
        };
        let s = |v: &str| Some(v.to_string());

        // 1. Two Priority1 emails land before anything is typed on the deal.
        let picked = "Update on Shipment #60115779865 for BJM Distributions\nCarrier: EDI Express (EDXI)\nStatus: Picked up\nBOL: 60115779865\nPRO: 687651776\nUpdate Date: 9/9/2026 2:00 PM";
        apply(&parse("Tracking Update for Shipment 60115779865", picked, None).unwrap(), Some("<p1-a@priority1.com>"), None).unwrap();
        apply(&parse("Tracking Update for Shipment 60115779865", "", Some(HTML)).unwrap(), Some("<p1-b@priority1.com>"), None).unwrap();
        assert_eq!(dates("df-r279"), (s("2026-09-20"), s("2026-09-25"), None, None), "no BOL on the deal yet: its dates stay");

        // 2. Jack types the BOL on the deal afterwards.
        let sh = link_shipment_ref("df-r279".into(), "60115779865".into()).await.unwrap();
        assert_eq!(sh.deal_flow_id, "df-r279");
        assert_eq!(dates("df-r279"), (s("2026-09-09"), s("2026-09-25"), s("2026-09-20"), None),
            "the pickup Priority1 already reported is applied, and the typed date is kept as the previous one");

        // 3. A later delivered email moves the delivery date too.
        let delivered = "Update on Shipment #60115779865\nStatus: Delivered\nBOL: 60115779865\nUpdate Date: 9/12/2026 3:30 PM";
        apply(&parse("Delivered: shipment 60115779865", delivered, None).unwrap(), Some("<p1-c@priority1.com>"), None).unwrap();
        assert_eq!(dates("df-r279"), (s("2026-09-09"), s("2026-09-12"), s("2026-09-20"), s("2026-09-25")));

        // 4. The deal with no BOL was never touched.
        assert_eq!(dates("df-r279b"), (s("2026-09-21"), s("2026-09-26"), None, None));

        // 5. Taking the shipment off the deal hands back the dates Jack had typed.
        link_shipment(sh.id.clone(), String::new()).await.unwrap();
        let (p, d, _, _) = dates("df-r279");
        assert_eq!((p, d), (s("2026-09-20"), s("2026-09-25")), "no BOL on the deal any more: the typed dates come back");

        // 6. Mail found by searching the inbox (the path for a BOL typed long after the email)
        //    records the shipment, and typing the number then moves the deal.
        let old_mail = crate::email::ParsedEmail {
            uid: 9, message_id: Some("<p1-old@priority1.com>".into()), from: "tracking@priority1.com".into(), from_name: None,
            to: vec![], subject: "Tracking Update for Shipment 70220011223".into(),
            body_text: "Update on Shipment #70220011223\nCarrier: Estes Express (EXLA)\nStatus: Picked up\nBOL: 70220011223\nUpdate Date: 8/28/2026 9:00 AM".into(),
            body_html: None, date: Some("2026-08-28T14:00:00+00:00".into()), has_attachments: false, source: "ben".into(),
        };
        assert_eq!(record_priority1_mail(&[old_mail]), 1);
        link_shipment_ref("df-r279b".into(), "70220011223".into()).await.unwrap();
        assert_eq!(dates("df-r279b").0, s("2026-08-28"));
    }

    /// R-318: exactly one update per shipment reports the delivery, and a row that arrives
    /// already delivered (the mailbox backfill reading old mail) reports none.
    #[test]
    fn only_the_update_that_lands_it_reports_a_delivery() {
        crate::db::init_test_store();
        let ev = |status: &str, when: &str| {
            let text = format!("Update on Shipment #80330022114
Status: {status}
BOL: 80330022114
Update Date: {when}");
            parse(&format!("Tracking Update for Shipment 80330022114 ({status})"), &text, None).unwrap()
        };
        assert_eq!(apply_inner(&ev("Picked up", "9/9/2026 8:00 AM"), Some("<a@priority1.com>"), None).unwrap().1, false,
            "a row created by its first email never announces, however it arrives");
        assert_eq!(apply_inner(&ev("In transit", "9/10/2026 8:00 AM"), Some("<b@priority1.com>"), None).unwrap().1, false);
        assert_eq!(apply_inner(&ev("Delivered", "9/12/2026 3:30 PM"), Some("<c@priority1.com>"), None).unwrap().1, true,
            "the update that moves it to delivered is the one that announces");
        assert_eq!(apply_inner(&ev("Delivered", "9/12/2026 4:00 PM"), Some("<d@priority1.com>"), None).unwrap().1, false,
            "a second delivered email does not announce it again");
    }

    #[test]
    fn stages() {
        assert_eq!(stage_of("Out for delivery"), "out_for_delivery");
        assert_eq!(stage_of("Delivery appointment scheduled"), "booked");
        assert_eq!(stage_of("Picked up"), "picked_up");
        assert_eq!(stage_of("Delayed - weather"), "exception");
        assert_eq!(stage_of("Dispatched"), "booked");
        assert_eq!(id_for("org_default", "601-157 79865"), "shp-org_default-60115779865");
    }
}
