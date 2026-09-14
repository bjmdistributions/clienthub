//! Freight tracking from Priority1's shipment-update emails (R-277).
//!
//! The IMAP watcher hands every inbound message to `email::process_new_emails`, which
//! offers it to `ingest` too. A Priority1 update becomes (or updates) one `shipments`
//! row, synced so the phone shows the same status. A shipment attaches to a deal three
//! ways: a reference number in the email equals one of the org's invoice numbers; a BOL,
//! PRO or pickup number pasted on the deal (`link_shipment_ref`); or one tap on a
//! suggested deal. Nothing here writes a deal's own pickup or delivery dates — tracking
//! sits beside them, so a carrier's status can never rewrite the schedule the deal holds.
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

/// Merge one parsed update into the store. Split from `ingest` so tests and the mailbox
/// backfill share it.
pub fn apply(p: &Parsed, message_id: Option<&str>, email_date: Option<&str>) -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let at = if !p.update_at.is_empty() { p.update_at.clone() } else { email_date.unwrap_or(&now).to_string() };
    let event = json!({
        "at": at, "status": p.status, "stage": p.stage, "location": p.location, "note": p.note,
        "message_id": message_id.unwrap_or(""),
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
            Ok(id)
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
            if !dup { cols.insert("events_json".into(), Value::String(Value::Array(events).to_string())); }
            if cols.is_empty() { return Ok(s.id); }
            cols.insert("updated_at".into(), Value::String(Utc::now().to_rfc3339()));
            write_cols(&conn, &s.id, &cols, false)?;
            Ok(s.id)
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
    let mut cols = Map::new();
    cols.insert("deal_flow_id".into(), Value::String(deal_flow_id));
    cols.insert("dismissed".into(), json!(0));
    cols.insert("updated_at".into(), Value::String(Utc::now().to_rfc3339()));
    write_cols(&conn, &id, &cols, false)
}

/// Paste a BOL / PRO / pickup number on a deal. Attaches the shipment if Priority1 has
/// already emailed about it; otherwise records the number so the first email lands here.
#[tauri::command]
pub async fn link_shipment_ref(deal_flow_id: String, reference: String) -> Result<Shipment, String> {
    let r = reference.trim().to_string();
    if r.len() < 3 || !r.chars().any(|c| c.is_ascii_digit()) {
        return Err("Paste the BOL, PRO or pickup number from Priority1.".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let id = match find_by_any_ref(&conn, &r) {
        Some(s) => {
            let mut cols = Map::new();
            cols.insert("deal_flow_id".into(), Value::String(deal_flow_id));
            cols.insert("dismissed".into(), json!(0));
            cols.insert("updated_at".into(), Value::String(now));
            write_cols(&conn, &s.id, &cols, false)?;
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
        match crate::email::search_inbox(&ib.id, query.clone(), 300).await {
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
    fn stages() {
        assert_eq!(stage_of("Out for delivery"), "out_for_delivery");
        assert_eq!(stage_of("Delivery appointment scheduled"), "booked");
        assert_eq!(stage_of("Picked up"), "picked_up");
        assert_eq!(stage_of("Delayed - weather"), "exception");
        assert_eq!(stage_of("Dispatched"), "booked");
        assert_eq!(id_for("org_default", "601-157 79865"), "shp-org_default-60115779865");
    }
}
