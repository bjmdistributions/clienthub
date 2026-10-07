//! Freight bookings on the desktop (R-400): the Logistics screen's rows.
//!
//! A booking is one truck. Jack sends a deal to logistics and the person who books the truck
//! (a Logistics-only account, or Jack himself) fills in everything about it; the server owns the
//! rows and the desktop reads them (`freight_bookings` is synced, never pushed). Three things live
//! here:
//!
//!  * `logistics_request`: the one door to the server's `/api/logistics/*` routes. A Logistics-only
//!    device reads and writes everything through it, because it never holds the workspace. On
//!    Jack's desktop it carries every logistics write, then pulls so the local rows refresh.
//!  * `list_freight_bookings`: the local read Jack's deal pages use, in the booking shape the
//!    server sends a viewer who may see everything.
//!  * `PullHook`: what a pull does about bookings it just applied. The server recomputes a
//!    completed deal's cost when an amount paid changes, but a desktop never recomputes after a
//!    pull, so this checks the books (writing only on a real difference) and announces a delivery.

use crate::db::pool;
use crate::sync::{SyncEvent, SyncOp};
use serde_json::{json, Map, Value};

/// `L-` and the first six characters of the id after its `fb_` prefix, uppercased. The same code
/// the server puts on the booking (routes/logistics.rs `code_for`).
pub fn booking_code(id: &str) -> String {
    let rest = id.strip_prefix("fb_").unwrap_or(id);
    format!("L-{}", rest.chars().take(6).collect::<String>().to_ascii_uppercase())
}

/// R-459: the code a booking shows everywhere: its load number (`LD-0012`, minted by the server)
/// when it has one, else the old `L-xxxxxx` made from the id, so a row from before load numbers
/// still prints something. Twin of the server's `code_for`.
pub fn booking_code_of(id: &str, load_number: &str) -> String {
    let n = load_number.trim();
    if n.is_empty() { booking_code(id) } else { n.to_string() }
}

/// R-459: the live-truck predicate every desktop query over `freight_bookings` uses is
/// `status NOT IN ('cancelled','quote','quoted')` (with `archived = 0`), written as a literal in
/// each query. A quote is a question to logistics, not freight on the road, so it never counts as
/// a truck on its deal. Twin of the server's live predicate. `a_quote_is_never_a_live_truck`
/// fails if a query goes back to testing `cancelled` alone.

/// Only the logistics routes may be reached through `logistics_request`: `/api/logistics`, alone
/// or followed by `/` or `?`, with nothing that could climb out of it.
fn logistics_path_ok(path: &str) -> bool {
    // A percent sign is refused outright: `%2e%2e` is a dot segment once the HTTP client parses
    // the address, and no logistics route needs an encoded character.
    if path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('#') || path.contains('%') || path.chars().any(|c| c.is_control() || c == ' ') {
        return false;
    }
    let shaped = match path.strip_prefix("/api/logistics") {
        Some(rest) => rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'),
        None => false,
    };
    // What the client will actually request must still be under /api/logistics.
    shaped
        && reqwest::Url::parse("http://server.invalid")
            .and_then(|base| base.join(path))
            .map(|u| u.path() == "/api/logistics" || u.path().starts_with("/api/logistics/"))
            .unwrap_or(false)
}

/// The verbs the Logistics screens use. PUT saves the pay rule.
fn logistics_method_ok(m: &str) -> bool {
    matches!(m, "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
}

/// One call to the server's Logistics routes as the signed-in account. `method` is GET, POST,
/// PUT, PATCH or DELETE and `path` starts `/api/logistics`. Returns the JSON the server answered. A
/// refusal comes back as the server's own sentence (it is written to be shown as it is).
#[tauri::command]
pub async fn logistics_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let m = method.trim().to_ascii_uppercase();
    if !logistics_method_ok(&m) {
        return Err("That request is not allowed here.".into());
    }
    if !logistics_path_ok(&path) {
        return Err("That request is not allowed here.".into());
    }
    let (status, value) = crate::netsync::server_request(&m, &path, body).await.map_err(|e| {
        let s = e.to_string();
        if s.starts_with("Sign in") { s } else { "Could not reach the server. Check your connection and try again.".to_string() }
    })?;
    if !(200..300).contains(&status) {
        let said = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
        return Err(said.unwrap_or_else(|| match status {
            401 => "Sign in again to use the Logistics screen.".to_string(),
            403 => "Your account does not have permission for that.".to_string(),
            404 => "That booking was not found.".to_string(),
            _ => "The server could not do that. Try again in a moment.".to_string(),
        }));
    }
    // Jack's desktop holds the workspace: bring the changed rows (and the deal figures the server
    // just recomputed) in now rather than on the next 20 second tick. A Logistics-only device
    // never pulls (pull_apply refuses), so this is a no-op there.
    if m != "GET" && !crate::netsync::logistics_only_device() {
        if let Err(e) = crate::netsync::pull_apply().await {
            tracing::warn!("logistics: pull after {} {} failed: {}", m, path, e);
        }
    }
    Ok(value)
}

/// R-458: save one file on a booking to `dest` (a path the person just chose in the save dialog).
/// The bytes come from the server's file route, never from the page.
#[tauri::command]
pub async fn logistics_save_file(booking_id: String, file_id: String, dest: String) -> Result<(), String> {
    use base64::Engine;
    let ok_id = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok_id(&booking_id) || !ok_id(&file_id) {
        return Err("That file was not found.".into());
    }
    let got = logistics_request("GET".into(), format!("/api/logistics/bookings/{booking_id}/files/{file_id}"), None).await?;
    let data = got.get("data").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "The file could not be read.".to_string())?;
    std::fs::write(&dest, bytes).map_err(|e| format!("Could not save the file: {e}"))
}

/// R-459: the file name a save dialog opens with, from the name the server sent: no folders, no
/// characters Windows refuses, never empty.
fn download_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let clean = clean.trim().trim_matches('.').trim().to_string();
    if clean.is_empty() { "download".to_string() } else { clean }
}

/// R-459: the name and bytes of a server download, `{name, mime, data}` with `data` base64.
fn read_download(got: &Value) -> Result<(String, Vec<u8>), String> {
    use base64::Engine;
    let data = got.get("data").and_then(|v| v.as_str()).unwrap_or("");
    if data.is_empty() {
        return Err("The file could not be read.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "The file could not be read.".to_string())?;
    Ok((download_name(got.get("name").and_then(|v| v.as_str()).unwrap_or("")), bytes))
}

/// R-459: fetch a file the server builds (our own bill of lading PDF, `/api/logistics/bols/{id}/pdf`)
/// and save it where the person chooses. `path` must pass the same check as `logistics_request`
/// and is read through the same server door, as GET. The answer is `{name, mime, data}` with
/// `data` base64. The save dialog opens with `name`. Returns the saved path, or `None` when the
/// person closed the dialog.
#[tauri::command]
pub async fn logistics_save_download(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !logistics_path_ok(&path) {
        return Err("That request is not allowed here.".into());
    }
    let got = logistics_request("GET".into(), path, None).await?;
    let (name, bytes) = read_download(&got)?;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(&name).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(dest) = picked else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&dest, bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

// ── the local read ──────────────────────────────────────────────────────────

/// The booking's text columns, in the order the booking object lists them (status, booked_at,
/// then everything down to the accessorials). Selected as strings, never NULL.
const TEXT_A: &[&str] = &[
    "status", "booked_at", "request_note", "pickup_name", "pickup_address", "pickup_date", "pickup_window", "pickup_contact",
    "pickup_phone", "pickup_notes", "delivery_name", "delivery_address", "delivery_date", "delivery_window",
    "delivery_contact", "delivery_phone", "delivery_notes", "delivered_at", "carrier", "broker", "service",
    "equipment", "bol", "pro", "pickup_number", "reference", "tracking_url", "driver_name", "driver_phone",
    "truck_number", "trailer_number", "pallets", "pieces", "weight_lbs", "freight_class", "dimensions",
    "commodity", "accessorials",
];
/// After the two money columns.
const TEXT_B: &[&str] = &[
    "paid_at", "paid_method", "paid_note", "notes", "created_by_name", "updated_by_name", "created_at", "updated_at",
];
/// R-459: the text columns that came with quote-first logistics, after everything else in the
/// SELECT (so the offsets above never move). `load_number` is the server-minted `LD-0001`.
const TEXT_C: &[&str] = &[
    "load_number", "quote_note", "quoted_at", "quoted_by_name", "quote_invoiced_at", "sent_to_book_at", "carrier_id",
    "pickup_appt_time", "picked_up_at", "picked_up_time", "delivery_appt_time", "delivered_time", "pickup_dock",
    "delivery_dock", "pickup_number_confirmed_at", "pickup_number_confirmed_by", "pay_due_date",
];
/// (`quote_amount` and `quote_invoiced_amount`, the two new REAL columns, are selected by name
/// right after `files`.)

/// R-459: which of the three papers a load has, from the kinds on its live files. Same shape as
/// the server's `paperwork`. A file with no `kind` is `other` and counts for none of them.
fn paperwork_of(files: &[Value]) -> Value {
    let has = |kind: &str| files.iter().any(|f| f.get("kind").and_then(|k| k.as_str()) == Some(kind));
    json!({ "bol": has("bol"), "pod": has("pod"), "carrier_invoice": has("carrier_invoice") })
}

/// The Priority1 shipment (not dismissed) whose BOL or PRO equals the booking's, as the small
/// tracking object. Never the shipment's references or its deal.
fn tracking_for(ships: &[(String, String, Value)], bol: &str, pro: &str) -> Value {
    let mine: Vec<String> = [crate::shipments::norm_ref(bol), crate::shipments::norm_ref(pro)]
        .into_iter().filter(|x| !x.is_empty()).collect();
    if mine.is_empty() {
        return Value::Null;
    }
    ships.iter()
        .find(|(b, p, _)| mine.iter().any(|m| (!b.is_empty() && m == b) || (!p.is_empty() && m == p)))
        .map(|(_, _, obj)| obj.clone())
        .unwrap_or(Value::Null)
}

/// Freight bookings that are not archived, as booking objects for a viewer who may see
/// everything (Jack): every `can_see_*` true, the deal filled in, `tracking` from the local
/// shipments. Cancelled and finished ones are included, the screen decides what to show. With a
/// deal, only that deal's; otherwise all. Requested first, then by pickup date (empty last), then
/// oldest first. The deal is inside `deal`: the object has no `deal_flow_id` key, like the
/// server's.
#[tauri::command]
pub async fn list_freight_bookings(deal_flow_id: Option<String>) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    let ships: Vec<(String, String, Value)> = {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(stage,''), COALESCE(status,''), COALESCE(carrier,''), COALESCE(last_location,''),
                    COALESCE(last_update_at,''), COALESCE(bol,''), COALESCE(pro,'')
             FROM shipments WHERE COALESCE(dismissed,0)=0 AND (COALESCE(bol,'')<>'' OR COALESCE(pro,'')<>'')
             ORDER BY COALESCE(NULLIF(last_update_at,''), created_at) DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((
            crate::shipments::norm_ref(&r.get::<_, String>(5)?),
            crate::shipments::norm_ref(&r.get::<_, String>(6)?),
            json!({
                "stage": r.get::<_, String>(0)?, "status": r.get::<_, String>(1)?, "carrier": r.get::<_, String>(2)?,
                "last_location": r.get::<_, String>(3)?, "last_update_at": r.get::<_, String>(4)?,
            }),
        ))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let a: Vec<String> = TEXT_A.iter().map(|c| format!("COALESCE(fb.{c},'')")).collect();
    let b: Vec<String> = TEXT_B.iter().map(|c| format!("COALESCE(fb.{c},'')")).collect();
    let c: Vec<String> = TEXT_C.iter().map(|c| format!("COALESCE(fb.{c},'')")).collect();
    let sql = format!(
        "SELECT fb.id, {a}, fb.quoted_cost, fb.paid_amount, {b},
                COALESCE(df.id,''), COALESCE(i.number,''), COALESCE(c.name,''), COALESCE(df.stage,''),
                COALESCE(i.line_items_json,'[]'), COALESCE(i.shipping_charged,0),
                (SELECT COUNT(*) FROM freight_bookings tb WHERE tb.deal_flow_id = fb.deal_flow_id AND tb.archived = 0 AND tb.status NOT IN ('cancelled','quote','quoted')),
                COALESCE(fb.extra_pickups,'[]'), COALESCE(fb.urgent,0), COALESCE(fb.files,'[]'),
                fb.quote_amount, fb.quote_invoiced_amount, {c}
         FROM freight_bookings fb
         LEFT JOIN deal_flows df ON df.id = fb.deal_flow_id
         LEFT JOIN invoices i ON i.id = df.invoice_id
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE fb.archived = 0 AND (?1 = '' OR fb.deal_flow_id = ?1)
         ORDER BY CASE WHEN COALESCE(fb.urgent,0) = 1 AND fb.status IN ('requested','booked') THEN 0 ELSE 1 END,
                  CASE WHEN fb.status IN ('requested','quote') THEN 0 ELSE 1 END,
                  CASE WHEN COALESCE(fb.pickup_date,'') = '' THEN 1 ELSE 0 END, fb.pickup_date, fb.created_at",
        a = a.join(", "), b = b.join(", "), c = c.join(", "),
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let na = TEXT_A.len();
    let by_team = read_freight_by_team();
    let rows = stmt.query_map([deal_flow_id.unwrap_or_default()], |r| {
        let id: String = r.get(0)?;
        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        for (i, c) in TEXT_A.iter().enumerate() {
            m.insert((*c).into(), json!(r.get::<_, String>(1 + i)?));
        }
        m.insert("quoted_cost".into(), json!(r.get::<_, Option<f64>>(1 + na)?));
        m.insert("paid_amount".into(), json!(r.get::<_, Option<f64>>(2 + na)?));
        for (i, c) in TEXT_B.iter().enumerate() {
            m.insert((*c).into(), json!(r.get::<_, String>(3 + na + i)?));
        }
        let at = 3 + na + TEXT_B.len();
        let (deal, number, client, stage): (String, String, String, String) = (r.get(at)?, r.get(at + 1)?, r.get(at + 2)?, r.get(at + 3)?);
        // R-415: what we charged the customer for shipping on this deal (null with no deal), how
        // many live trucks the deal has, and whether our side fills in the freight.
        let (items, field, trucks): (String, f64, i64) = (r.get(at + 4)?, r.get(at + 5)?, r.get(at + 6)?);
        m.insert("shipping_billed".into(), if deal.is_empty() { Value::Null } else { json!(charged_of(&items, field).0) });
        m.insert("trucks_on_deal".into(), json!(if deal.is_empty() { 0 } else { trucks }));
        m.insert("freight_by_team".into(), json!(by_team));
        // R-452: the pickups after the first, as the server sends them to a full viewer.
        let stops: Vec<Value> = serde_json::from_str::<Vec<Value>>(&r.get::<_, String>(at + 7)?)
            .unwrap_or_default().into_iter().filter(|v| v.is_object()).collect();
        m.insert("extra_pickups".into(), Value::Array(stops));
        // R-458: urgent as a yes or no, and the files listed on the booking (the server's shape).
        m.insert("urgent".into(), json!(r.get::<_, i64>(at + 8)? == 1));
        let files: Vec<Value> = serde_json::from_str::<Vec<Value>>(&r.get::<_, String>(at + 9)?)
            .unwrap_or_default().into_iter()
            .filter(|f| f.get("id").and_then(|v| v.as_str()).map_or(false, |id| !id.is_empty()))
            .collect();
        m.insert("paperwork".into(), paperwork_of(&files));
        m.insert("files".into(), Value::Array(files));
        // R-459: the quote and invoice amounts, the load number and the other new columns. The
        // code prefers the load number and falls back to the old id-derived one.
        m.insert("quote_amount".into(), json!(r.get::<_, Option<f64>>(at + 10)?));
        m.insert("quote_invoiced_amount".into(), json!(r.get::<_, Option<f64>>(at + 11)?));
        for (i, c) in TEXT_C.iter().enumerate() {
            m.insert((*c).into(), json!(r.get::<_, String>(at + 12 + i)?));
        }
        let load_number = m.get("load_number").and_then(|v| v.as_str()).unwrap_or("").to_string();
        m.insert("code".into(), json!(booking_code_of(&id, &load_number)));
        m.insert("can_see_names".into(), json!(true));
        m.insert("can_see_addresses".into(), json!(true));
        m.insert("can_see_deal".into(), json!(true));
        let bol = m.get("bol").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let pro = m.get("pro").and_then(|v| v.as_str()).unwrap_or("").to_string();
        m.insert("tracking".into(), tracking_for(&ships, &bol, &pro));
        m.insert("deal".into(), if deal.is_empty() {
            Value::Null
        } else {
            json!({ "id": deal, "invoice_number": number, "client_name": client, "stage": stage })
        });
        Ok(Value::Object(m))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ── logistics pay (R-401) ───────────────────────────────────────────────────
//
// The person who books the freight is paid a share of what the shipping made: what the customer
// was charged for shipping (the invoice's shipping lines) less what the carrier was paid. The
// rule lives in one org setting, `logistics_pay`, which only the server writes. These are the
// same pure functions, with the same tests, as the server's. The desktop uses them to take the
// logistics pay off the top before the owner split, exactly as a sales rep's cut is taken.

/// The `logistics_pay` setting. Every field has a default, so a missing or half-written value
/// reads as "off".
#[derive(Debug, Clone, PartialEq)]
pub struct PaySettings {
    pub enabled: bool,
    pub payee_id: String,
    pub payee_name: String,
    pub share_pct: f64,
    pub cover_losses: bool,
    pub loss_pay_pct: f64,
    /// `weekly`, `biweekly` or `monthly`.
    pub frequency: String,
    /// 0 is Monday, 6 is Sunday.
    pub pay_weekday: u32,
    pub anchor_date: String,
    pub pay_day_of_month: u32,
    pub method: String,
    pub details: String,
    /// R-415: `pay` (the default: the surplus is paid to the payee) or `track` (the surplus is
    /// worked out and shown in the Brief, nothing is owed). Anything else reads as `pay`.
    pub surplus_mode: String,
}

impl Default for PaySettings {
    fn default() -> Self {
        PaySettings {
            enabled: false, payee_id: String::new(), payee_name: String::new(), share_pct: 100.0,
            cover_losses: true, loss_pay_pct: 0.0, frequency: "weekly".into(), pay_weekday: 4,
            anchor_date: String::new(), pay_day_of_month: 1, method: String::new(), details: String::new(),
            surplus_mode: "pay".into(),
        }
    }
}

impl PaySettings {
    pub fn from_json(raw: &str) -> Self {
        let mut s = PaySettings::default();
        let Ok(v) = serde_json::from_str::<Value>(raw) else { return s };
        let text = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        if let Some(b) = v.get("enabled").and_then(|x| x.as_bool()) { s.enabled = b; }
        s.payee_id = text("payee_id");
        s.payee_name = text("payee_name");
        if let Some(n) = v.get("share_pct").and_then(|x| x.as_f64()) { s.share_pct = n; }
        if let Some(b) = v.get("cover_losses").and_then(|x| x.as_bool()) { s.cover_losses = b; }
        if let Some(n) = v.get("loss_pay_pct").and_then(|x| x.as_f64()) { s.loss_pay_pct = n; }
        let f = text("frequency");
        if matches!(f.as_str(), "weekly" | "biweekly" | "monthly") { s.frequency = f; }
        if let Some(n) = v.get("pay_weekday").and_then(|x| x.as_u64()) { s.pay_weekday = (n as u32).min(6); }
        s.anchor_date = text("anchor_date");
        if let Some(n) = v.get("pay_day_of_month").and_then(|x| x.as_u64()) { s.pay_day_of_month = (n as u32).clamp(1, 28); }
        s.method = text("method");
        s.details = text("details");
        if text("surplus_mode") == "track" { s.surplus_mode = "track".into(); }
        s
    }

    /// Track mode: the surplus is reported, never owed.
    pub fn tracks(&self) -> bool {
        self.surplus_mode == "track"
    }
}

/// The org's logistics pay rule from the local settings table (the server writes it and it
/// reaches this device through the pull). Off when it was never set.
pub fn read_pay_settings() -> PaySettings {
    read_org_setting("logistics_pay").map(|s| PaySettings::from_json(&s)).unwrap_or_default()
}

/// An org setting the server writes (`logistics_pay`, `logistics_settings`), as stored. The server
/// keeps it under `{org}::{key}` for any org but the default one, and the row reaches this device
/// under that same key. Try this device's org first, then the plain key.
fn read_org_setting(key: &str) -> Option<String> {
    let c = pool().get().ok()?;
    let org: String = c.query_row("SELECT value FROM device_state WHERE key='netsync_org'", [], |r| r.get(0)).unwrap_or_default();
    let read = |k: &str| -> Option<String> { c.query_row("SELECT value FROM settings WHERE key=?1", [k], |r| r.get(0)).ok() };
    let scoped = if org.is_empty() || org == "org_default" { None } else { read(&format!("{org}::{key}")) };
    scoped.or_else(|| read(key))
}

/// R-415: whether our side fills in the freight details (pallets, weight, dimensions,
/// accessorials) before a load is sent to logistics. The `logistics_settings` setting's
/// `freight_by_team`, true when the setting was never written.
pub fn read_freight_by_team() -> bool {
    read_org_setting("logistics_settings")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("freight_by_team").and_then(|x| x.as_bool()))
        .unwrap_or(true)
}

fn cents(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// What the customer was charged for shipping, from the invoice: the sum of the stored `amount`
/// of every line with a non-empty description that is a shipping line by the R-255 rule. That is
/// the figure the invoice itself adds up, so a line stored with amount 0 charged nothing; only a
/// line with no `amount` key is qty x rate. When no such line exists at all (even one that sums to
/// 0), the invoice's `shipping_charged` field stands in when above zero, else nothing. Returns the
/// amount and where it came from: `lines`, `field`, `none`. The same rule as the server's.
pub fn charged_of(line_items_json: &str, shipping_charged: f64) -> (f64, &'static str) {
    let items: Vec<Value> = serde_json::from_str(line_items_json).unwrap_or_default();
    let mut found = false;
    let mut sum = 0.0;
    for it in &items {
        let desc = it.get("description").and_then(|v| v.as_str()).unwrap_or("");
        if desc.trim().is_empty() || !crate::commands::is_shipping_line(desc) {
            continue;
        }
        found = true;
        sum += match it.get("amount").and_then(|v| v.as_f64()) {
            Some(a) => a,
            None => it.get("qty").and_then(|v| v.as_f64()).unwrap_or(0.0) * it.get("rate").and_then(|v| v.as_f64()).unwrap_or(0.0),
        };
    }
    if found {
        (cents(sum), "lines")
    } else if shipping_charged > 0.005 {
        (cents(shipping_charged), "field")
    } else {
        (0.0, "none")
    }
}

/// The pay for one deal: `None` while the freight amount is not known, else the amount rounded
/// to cents (half away from zero), and which rule produced it.
///   surplus > 0                   share_pct of the surplus                  rule `share`
///   surplus <= 0, cover_losses    loss_pay_pct of the freight cost          rule `loss_cover`
///   surplus <= 0, not cover       share_pct of the surplus (zero or less)   rule `loss_share`
/// In track mode (R-415) the pay is always 0 with rule `tracked`; a load still waiting on the
/// amount paid stays pending.
pub fn pay_for(s: &PaySettings, charged: f64, freight: f64, pending: bool) -> (Option<f64>, &'static str) {
    let surplus = charged - freight;
    if pending {
        return (None, "pending");
    }
    if s.tracks() {
        return (Some(0.0), "tracked");
    }
    if surplus > 0.0 {
        (Some(cents(s.share_pct / 100.0 * surplus)), "share")
    } else if s.cover_losses {
        (Some(cents(s.loss_pay_pct / 100.0 * freight)), "loss_cover")
    } else {
        (Some(cents(s.share_pct / 100.0 * surplus)), "loss_share")
    }
}

/// The owner split's starting figure: the net with the rep's cut and the logistics pay taken off
/// the top. `net_profit` itself is never changed by either.
pub fn owner_remainder(net: f64, rep_cut: f64, logistics_pay: f64) -> f64 {
    net - rep_cut - logistics_pay
}

/// A pay date and the days it covers.
#[derive(Debug, Clone, PartialEq)]
pub struct PayDate {
    pub pay_date: String,
    pub period_start: String,
    pub period_end: String,
}

fn day(s: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d").ok()
}

/// The day the pay for a deal earned on `earned_on` is due.
///   weekly    the first date strictly after it on `pay_weekday`, covering the 7 days before it
///   biweekly  the first date strictly after it that is `anchor_date` plus a whole number of
///             14-day steps (either direction), covering the 14 days before it
///   monthly   `pay_day_of_month` of the month after it, covering the month it was earned in
/// `None` when `earned_on` is not a date, or biweekly has no usable anchor.
pub fn pay_date_for(earned_on: &str, s: &PaySettings) -> Option<PayDate> {
    use chrono::{Datelike, Duration, NaiveDate};
    let earned = day(earned_on)?;
    let fmt = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let (pay, start, end) = match s.frequency.as_str() {
        "biweekly" => {
            let anchor = day(&s.anchor_date)?;
            let steps = (earned - anchor).num_days().div_euclid(14) + 1;
            let pay = anchor + Duration::days(steps * 14);
            (pay, pay - Duration::days(14), pay - Duration::days(1))
        }
        "monthly" => {
            let (y, m) = if earned.month() == 12 { (earned.year() + 1, 1) } else { (earned.year(), earned.month() + 1) };
            let pay = NaiveDate::from_ymd_opt(y, m, s.pay_day_of_month.clamp(1, 28))?;
            let first = NaiveDate::from_ymd_opt(earned.year(), earned.month(), 1)?;
            (pay, first, pay.with_day(1)? - Duration::days(1))
        }
        _ => {
            let want = s.pay_weekday.min(6) as i64;
            let have = earned.weekday().num_days_from_monday() as i64;
            let ahead = (want - have).rem_euclid(7);
            let pay = earned + Duration::days(if ahead == 0 { 7 } else { ahead });
            (pay, pay - Duration::days(7), pay - Duration::days(1))
        }
    };
    Some(PayDate { pay_date: fmt(pay), period_start: fmt(start), period_end: fmt(end) })
}

/// One deal's logistics pay, with the figures behind it.
#[derive(Debug, Clone, PartialEq)]
pub struct DealPay {
    pub charged: f64,
    pub charged_source: &'static str,
    pub freight: f64,
    pub freight_source: &'static str,
    pub surplus: f64,
    pub pay: Option<f64>,
    pub rule: &'static str,
    pub pending: bool,
    pub earned_on: String,
    pub due_date: String,
    pub booking_codes: Vec<String>,
}

impl DealPay {
    pub fn to_json(&self) -> Value {
        json!({
            "charged": self.charged, "charged_source": self.charged_source,
            "freight": self.freight, "freight_source": self.freight_source,
            "surplus": cents(self.surplus), "pay": self.pay, "rule": self.rule, "pending": self.pending,
            "earned_on": self.earned_on, "due_date": self.due_date, "booking_codes": self.booking_codes,
        })
    }
}

/// The freight cost a deal's pay is measured against, and where it came from: the shipping link
/// when there is one (`bank`), else the amounts paid (`paid`). R-415: a quote no longer makes the
/// freight known, so a load whose amount paid is missing is pending (see `deal_pay`) and is never
/// measured against a quote or the billed figure.
pub fn freight_of(facts: &crate::commands::ShipFacts) -> (f64, &'static str) {
    if facts.has_link { (cents(facts.linked), "bank") } else { (cents(facts.paid), "paid") }
}

/// The logistics pay for one deal under the org's rule, or `None` when there is no line: the rule
/// is off, the deal is archived or voided, or no live booking has been confirmed booked yet.
/// A deal whose freight amount is not known yet (a live booking has no amount paid) is a line
/// with `pay: None` (pending).
pub fn deal_pay(conn: &rusqlite::Connection, deal_flow_id: &str, s: &PaySettings) -> Option<DealPay> {
    if !s.enabled {
        return None;
    }
    // A load already covered by a recorded payment keeps the rule it was paid under (the rule on
    // its latest covering payment line); a rule change applies only to loads not paid yet. Same
    // as the server's rules_by_deal / settings_for.
    let effective = rule_for_deal(conn, deal_flow_id, s);
    let s = &effective;
    let (archived, voided, items, field): (i64, i64, String, f64) = conn.query_row(
        "SELECT COALESCE(df.archived,0), MAX(COALESCE(i.voided,0), COALESCE(i.archived,0)), COALESCE(i.line_items_json,'[]'), COALESCE(i.shipping_charged,0)
         FROM deal_flows df LEFT JOIN invoices i ON i.id=df.invoice_id WHERE df.id=?1",
        [deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).ok()?;
    if archived != 0 || voided != 0 {
        return None;
    }
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(booked_at,''), CASE WHEN paid_amount IS NULL THEN 1 ELSE 0 END, COALESCE(load_number,'')
         FROM freight_bookings WHERE deal_flow_id=?1 AND archived=0 AND status NOT IN ('cancelled','quote','quoted') ORDER BY created_at, id",
    ).ok()?;
    let live: Vec<(String, String, i64, String)> = stmt
        .query_map([deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).ok()?
        .filter_map(|r| r.ok()).collect();
    let earned_on = live.iter().map(|(_, b, _, _)| b.as_str()).filter(|b| !b.is_empty()).min()?.to_string();
    let pending = live.iter().any(|(_, _, none, _)| *none != 0);
    let (charged, charged_source) = charged_of(&items, field);
    let (freight, freight_source) = freight_of(&crate::commands::ship_facts(conn, deal_flow_id));
    let (pay, rule) = pay_for(s, charged, freight, pending);
    // Nothing is owed in track mode, so there is no pay date either.
    let due_date = if s.tracks() { String::new() } else { pay_date_for(&earned_on, s).map(|d| d.pay_date).unwrap_or_default() };
    Some(DealPay {
        charged, charged_source, freight, freight_source, surplus: charged - freight, pay, rule, pending,
        earned_on, due_date,
        booking_codes: live.iter().map(|(id, _, _, ln)| booking_code_of(id, ln)).collect(),
    })
}

/// The settings one deal's pay is worked under: the current rule, unless a non-archived payment
/// to this payee already covered the deal, in which case the rule stored on the latest covering
/// line (by pay date, then when it was recorded). A latest line without a stored rule (recorded
/// before rules were stored) means the current rule. A stored rule means the load was paid, so it
/// is worked in pay mode whatever the current mode: switching to track never takes money back (R-415).
pub fn rule_for_deal(conn: &rusqlite::Connection, deal_flow_id: &str, s: &PaySettings) -> PaySettings {
    let Ok(mut stmt) = conn.prepare(
        "SELECT COALESCE(lines_json,'[]') FROM logistics_payouts
         WHERE COALESCE(archived,0)=0 AND COALESCE(payee_id,'')=?1 ORDER BY pay_date, created_at",
    ) else { return s.clone() };
    let rows: Vec<String> = match stmt.query_map([&s.payee_id], |r| r.get::<_, String>(0)) {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => return s.clone(),
    };
    let mut rule: Option<(f64, bool, f64)> = None;
    for text in rows {
        let lines: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
        for l in lines.iter().filter(|l| l.get("deal_flow_id").and_then(|x| x.as_str()) == Some(deal_flow_id)) {
            if l.get("amount").and_then(|x| x.as_f64()).is_none() {
                continue;
            }
            rule = match (
                l.get("share_pct").and_then(|x| x.as_f64()),
                l.get("cover_losses").and_then(|x| x.as_bool()),
                l.get("loss_pay_pct").and_then(|x| x.as_f64()),
            ) {
                (Some(a), Some(b), Some(c)) => Some((a, b, c)),
                _ => None,
            };
        }
    }
    match rule {
        Some((share_pct, cover_losses, loss_pay_pct)) => PaySettings { share_pct, cover_losses, loss_pay_pct, surplus_mode: "pay".into(), ..s.clone() },
        None => s.clone(),
    }
}

/// The cut a completed deal's owner split is taken after: `Some(amount)` while the rule is on (0
/// for a deal with no line or no amount yet), `None` while it is off. Kept in
/// `metadata.logistics_pay`, like the server's `cut_for_deal`.
pub fn logistics_cut(conn: &rusqlite::Connection, deal_flow_id: &str) -> Option<f64> {
    let s = read_pay_settings();
    if !s.enabled {
        return None;
    }
    Some(deal_pay(conn, deal_flow_id, &s).and_then(|d| d.pay).unwrap_or(0.0))
}

/// One deal's logistics pay line for the deal page: the figures behind it, or `null` when the
/// deal has none (the rule is off, or nothing is booked yet).
#[tauri::command]
pub async fn get_deal_logistics_pay(deal_flow_id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let settings = read_pay_settings();
    Ok(match deal_pay(&conn, &deal_flow_id, &settings) {
        Some(d) => {
            let mut v = d.to_json();
            v["payee_name"] = json!(settings.payee_name);
            v["surplus_mode"] = json!(settings.surplus_mode);
            v
        }
        None => Value::Null,
    })
}

// ── the post-pull hook ──────────────────────────────────────────────────────

/// Booking events applied during one pull. Dropping it (the pull ended, however it ended) does the
/// work, so events applied before a network error are not missed.
#[derive(Default)]
pub struct PullHook {
    bookings: Vec<String>,
    delivered: Vec<String>,
}

impl PullHook {
    /// Note an event that has just been applied. Only booking upserts matter. A booking counts as
    /// newly delivered when the event itself sets its status to delivered and the event is recent:
    /// the first pull of a new install replays months of history, and none of that is news.
    pub fn note(&mut self, ev: &SyncEvent) {
        let SyncOp::Upsert { table, row_id, columns } = &ev.op else { return };
        if table != "freight_bookings" {
            return;
        }
        if !self.bookings.contains(row_id) {
            self.bookings.push(row_id.clone());
        }
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let recent = now_ms.saturating_sub(ev.hlc.physical_ms) < 3 * 24 * 3600 * 1000;
        if recent && columns.get("status").and_then(|v| v.as_str()) == Some("delivered") && !self.delivered.contains(row_id) {
            self.delivered.push(row_id.clone());
        }
    }
}

impl Drop for PullHook {
    fn drop(&mut self) {
        if self.bookings.is_empty() {
            return;
        }
        after_pull(&self.bookings, &self.delivered);
    }
}

/// For each distinct deal the applied bookings belong to: a completed deal whose recorded cost,
/// profit or shipping leg the bookings now disagree with is re-derived (and nothing is written
/// when they agree). Then each newly delivered booking is announced.
fn after_pull(bookings: &[String], delivered: &[String]) {
    let mut deals: Vec<String> = Vec::new();
    // No store yet (early boot, or a test with no database): nothing to check.
    let Some(p) = crate::db::pool_opt() else { return };
    if let Ok(conn) = p.get() {
        for id in bookings {
            let deal: String = conn
                .query_row("SELECT COALESCE(deal_flow_id,'') FROM freight_bookings WHERE id=?1", [id], |r| r.get(0))
                .unwrap_or_default();
            if !deal.is_empty() && !deals.contains(&deal) {
                deals.push(deal);
            }
        }
    }
    for deal in &deals {
        match crate::commands::resync_completed_deal_if_changed(deal) {
            Ok(true) => tracing::info!("logistics: completed deal {} re-derived after a booking changed", deal),
            Ok(false) => {}
            Err(e) => tracing::warn!("logistics: could not check completed deal {}: {}", deal, e),
        }
    }
    for id in delivered {
        crate::shipments::announce_booking_delivered(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::Hlc;

    #[test]
    fn a_booking_code_is_the_first_six_characters_after_the_prefix() {
        assert_eq!(booking_code("fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77"), "L-7F3K2A");
        assert_eq!(booking_code("fb_ab"), "L-AB");
    }

    #[test]
    fn r459_the_code_is_the_load_number_with_the_old_code_as_the_fallback() {
        let id = "fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77";
        assert_eq!(booking_code_of(id, "LD-0012"), "LD-0012");
        assert_eq!(booking_code_of(id, "  LD-0012 "), "LD-0012", "stray spaces are not part of it");
        assert_eq!(booking_code_of(id, ""), "L-7F3K2A", "a row from before load numbers keeps the old code");
        assert_eq!(booking_code_of(id, "   "), "L-7F3K2A");
        assert_eq!(booking_code_of("fb_ab", ""), "L-AB");
    }

    #[test]
    fn r459_a_download_has_a_safe_name_and_decodes() {
        assert_eq!(download_name("BOL-0003.pdf"), "BOL-0003.pdf");
        assert_eq!(download_name("..\\..\\evil/BOL 0003.pdf"), "BOL 0003.pdf", "no folders");
        assert_eq!(download_name("a:b*c?.pdf"), "abc.pdf");
        assert_eq!(download_name(""), "download");
        assert_eq!(download_name("../"), "download");
        let ok = json!({ "name": "BOL-0003.pdf", "mime": "application/pdf", "data": "JVBERi0xLjQ=" });
        let (name, bytes) = read_download(&ok).unwrap();
        assert_eq!((name.as_str(), bytes.as_slice()), ("BOL-0003.pdf", b"%PDF-1.4".as_slice()));
        assert!(read_download(&json!({ "name": "x.pdf", "data": "" })).is_err(), "no bytes is not a file");
        assert!(read_download(&json!({ "name": "x.pdf", "data": "!!not base64!!" })).is_err());
        assert!(read_download(&json!({ "name": "x.pdf" })).is_err());
    }

    #[test]
    fn r459_the_download_door_is_the_logistics_door() {
        // logistics_save_download checks logistics_path_ok before it asks the server for anything.
        assert!(logistics_path_ok("/api/logistics/bols/bol_1/pdf"));
        assert!(!logistics_path_ok("/api/clients"));
        assert!(!logistics_path_ok("/api/logistics/../clients"));
        assert!(!logistics_path_ok("/api/logistics/bols/%2e%2e/pdf"));
    }

    #[test]
    fn only_the_logistics_routes_can_be_reached() {
        for ok in ["/api/logistics", "/api/logistics/bookings", "/api/logistics/bookings?include_done=1", "/api/logistics/bookings/fb_1"] {
            assert!(logistics_path_ok(ok), "{ok}");
        }
        for bad in [
            "", "/api/deal-flows", "/api/logisticsx", "/api/logistics/../deal-flows", "/api/logistics//x", "api/logistics",
            "https://evil.example/api/logistics", "/api/logistics/bookings x", "/api/logistics\\bookings", "/api/sync/pull",
            "/api/logistics#x", "/x/api/logistics",
        ] {
            assert!(!logistics_path_ok(bad), "{bad}");
        }
    }

    fn event(row: &str, cols: Value, age_ms: u64) -> SyncEvent {
        let now = chrono::Utc::now().timestamp_millis() as u64;
        SyncEvent {
            id: format!("ev-{row}-{age_ms}"),
            hlc: Hlc { physical_ms: now - age_ms, logical: 0, node_id: [0; 8] },
            op: SyncOp::Upsert { table: "freight_bookings".into(), row_id: row.into(), columns: cols.as_object().unwrap().clone() },
        }
    }

    #[test]
    fn the_hook_notes_only_booking_events_and_only_a_recent_delivery() {
        let mut h = PullHook::default();
        h.note(&event("fb_a", json!({"status": "delivered"}), 1000));
        h.note(&event("fb_b", json!({"status": "delivered"}), 10 * 24 * 3600 * 1000));
        h.note(&event("fb_c", json!({"paid_amount": 900.0}), 1000));
        let mut other = event("x", json!({"status": "delivered"}), 1000);
        other.op = SyncOp::Upsert { table: "shipments".into(), row_id: "x".into(), columns: Map::new() };
        h.note(&other);
        assert_eq!(h.bookings, vec!["fb_a", "fb_b", "fb_c"]);
        assert_eq!(h.delivered, vec!["fb_a"], "a replayed old delivery is history, not news");
        // Nothing to do when dropped here: the ids are not in the test store.
        h.bookings.clear();
    }

    /// The tests that need the real schema share one store; ids here are unique to them.
    fn seed_deal(tag: &str, stage: &str, total_cost: f64, shipping_cost: Option<f64>) -> String {
        let id = format!("df-fr-{tag}");
        let conn = pool().get().unwrap();
        conn.execute("INSERT OR IGNORE INTO clients (id, name, created_at, updated_at) VALUES ('c-fr', 'Sample buyer', '2026-09-01', '2026-09-01')", []).unwrap();
        conn.execute(
            "INSERT INTO invoices (id, client_id, number, issue_date, due_date, line_items_json, subtotal, total, created_at)
             VALUES (?1, 'c-fr', ?2, '2026-09-01', '2026-09-30', '[]', 10000, 10000, '2026-09-01')",
            rusqlite::params![format!("inv-fr-{tag}"), format!("INV-FR-{tag}")],
        ).unwrap();
        conn.execute(
            "INSERT INTO deal_flows (id, invoice_id, stage, created_at, updated_at, supplier_payments_json, total_supplier_cost, payment_received_amount, gross_revenue, total_cost, net_profit, shipping_cost, completed_at)
             VALUES (?1, ?2, ?3, '2026-09-01', '2026-09-01', '[]', 6000, 10000, 10000, ?4, ?5, ?6, '2026-09-05')",
            rusqlite::params![id, format!("inv-fr-{tag}"), stage, total_cost, 10000.0 - total_cost, shipping_cost],
        ).unwrap();
        id
    }

    fn add_booking(id: &str, deal: &str, paid: Option<f64>) {
        pool().get().unwrap().execute(
            "INSERT INTO freight_bookings (id, deal_flow_id, status, paid_amount, created_at, updated_at)
             VALUES (?1, ?2, 'delivered', ?3, '2026-09-02', '2026-09-02')",
            rusqlite::params![id, deal, paid],
        ).unwrap();
    }

    fn queued() -> i64 {
        pool().get().unwrap().query_row("SELECT COUNT(*) FROM netsync_outbound", [], |r| r.get(0)).unwrap()
    }

    /// A completed deal whose books already agree with its booking is left alone, and one that
    /// does not is corrected, once, when the pull ends.
    #[test]
    fn the_hook_writes_only_when_the_books_differ() {
        let _db = crate::db::init_test_store();
        // Recorded with the shipping leg the booking now says: nothing to do.
        let same = seed_deal("same", "complete", 6800.0, Some(800.0));
        add_booking("fb_hooksame", &same, Some(800.0));
        let before = queued();
        {
            let mut h = PullHook::default();
            h.note(&event("fb_hooksame", json!({"paid_amount": 800.0}), 1000));
        }
        assert_eq!(queued(), before, "no write and no queued event when nothing differs");

        // Recorded at 800, the booking now says 900: the books move by exactly 100.
        let moved = seed_deal("moved", "complete", 6800.0, Some(800.0));
        add_booking("fb_hookmoved", &moved, Some(900.0));
        {
            let mut h = PullHook::default();
            h.note(&event("fb_hookmoved", json!({"paid_amount": 900.0}), 1000));
        }
        let (cost, net, ship): (f64, f64, Option<f64>) = pool().get().unwrap().query_row(
            "SELECT total_cost, net_profit, shipping_cost FROM deal_flows WHERE id=?1", [&moved], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!((cost, net, ship), (6900.0, 3100.0, Some(900.0)));

        // A deal that is not complete is never touched.
        let open = seed_deal("open", "supplier_paid", 0.0, None);
        add_booking("fb_hookopen", &open, Some(900.0));
        let before = queued();
        {
            let mut h = PullHook::default();
            h.note(&event("fb_hookopen", json!({"paid_amount": 900.0}), 1000));
        }
        assert_eq!(queued(), before);
    }

    #[tokio::test]
    async fn the_local_read_has_the_booking_shape_the_server_sends_a_full_viewer() {
        let _db = crate::db::init_test_store();
        let deal = seed_deal("read", "supplier_paid", 0.0, None);
        {
            let conn = pool().get().unwrap();
            conn.execute(
                "INSERT INTO freight_bookings (id, deal_flow_id, status, bol, pickup_name, pickup_date, quoted_cost, paid_amount, created_by_name, created_at, updated_at)
                 VALUES ('fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77', ?1, 'booked', '7788-1', 'Sample warehouse', '2026-10-02', 700, NULL, 'Sample sender', '2026-09-02', '2026-09-02')",
                [&deal],
            ).unwrap();
            conn.execute(
                "INSERT INTO freight_bookings (id, deal_flow_id, status, created_at, updated_at) VALUES ('fb_readgone', ?1, 'requested', '2026-09-01', '2026-09-01')", [&deal],
            ).unwrap();
            conn.execute("UPDATE freight_bookings SET archived=1 WHERE id='fb_readgone'", []).unwrap();
            // R-452: a second pickup on the same truck.
            conn.execute(
                "UPDATE freight_bookings SET extra_pickups='[{\"name\":\"Second sample yard\",\"address\":\"1 Sample Rd, Sample City, ST 00001\",\"window\":\"1 to 4\",\"contact\":\"\",\"phone\":\"\",\"notes\":\"\"}]' WHERE id='fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77'", [],
            ).unwrap();
            conn.execute(
                "INSERT INTO shipments (id, deal_flow_id, bol, stage, status, carrier, last_location, last_update_at, refs_json, created_at, updated_at, dismissed)
                 VALUES ('shp-org_default-77881', '', '77881', 'in_transit', 'In transit', 'Sample Freight', 'Sample City, ST', '2026-10-03T12:00:00Z', '[{\"label\":\"PO\",\"value\":\"secret\"}]', '2026-10-01', '2026-10-03', 0)", [],
            ).unwrap();
        }
        let rows = list_freight_bookings(Some(deal.clone())).await.unwrap();
        assert_eq!(rows.len(), 1, "the archived one is not listed");
        let b = &rows[0];
        assert_eq!(b["code"], "L-7F3K2A");
        assert_eq!(b["status"], "booked");
        assert_eq!(b["pickup_name"], "Sample warehouse");
        assert_eq!(b["pickup_date"], "2026-10-02");
        assert_eq!(b["quoted_cost"], json!(700.0));
        assert_eq!(b["paid_amount"], Value::Null);
        assert_eq!(b["created_by_name"], "Sample sender");
        assert_eq!((b["can_see_names"].as_bool(), b["can_see_addresses"].as_bool(), b["can_see_deal"].as_bool()), (Some(true), Some(true), Some(true)));
        assert_eq!(b["deal"]["id"], json!(deal));
        assert_eq!(b["deal"]["invoice_number"], "INV-FR-read");
        // R-415: what the customer was charged (no shipping line on this invoice), the live trucks
        // on the deal, and whether our side fills in the freight (on when never set).
        assert_eq!((b["shipping_billed"].as_f64(), b["trucks_on_deal"].as_i64(), b["freight_by_team"].as_bool()), (Some(0.0), Some(1), Some(true)));
        assert_eq!(b["deal"]["client_name"], "Sample buyer");
        assert!(b.get("deal_flow_id").is_none(), "the deal is inside `deal`, like the server's object");
        assert_eq!(b["tracking"]["stage"], "in_transit", "7788-1 and 77881 are the same number");
        assert!(b["tracking"].get("refs_json").is_none() && b["tracking"].get("deal_flow_id").is_none());
        for key in [
            "id", "code", "status", "booked_at", "request_note", "pickup_name", "pickup_address", "pickup_date", "pickup_window", "pickup_contact", "pickup_phone",
            "pickup_notes", "delivery_name", "delivery_address", "delivery_date", "delivery_window", "delivery_contact", "delivery_phone", "delivery_notes",
            "delivered_at", "carrier", "broker", "service", "equipment", "bol", "pro", "pickup_number", "reference", "tracking_url", "driver_name",
            "driver_phone", "truck_number", "trailer_number", "pallets", "pieces", "weight_lbs", "freight_class", "dimensions", "commodity", "accessorials",
            "quoted_cost", "paid_amount", "paid_at", "paid_method", "paid_note", "notes", "created_by_name", "updated_by_name", "created_at", "updated_at",
            "can_see_names", "can_see_addresses", "can_see_deal", "tracking", "deal", "extra_pickups", "urgent", "files",
            // R-459
            "load_number", "quote_amount", "quote_note", "quoted_at", "quoted_by_name", "quote_invoiced_at", "quote_invoiced_amount",
            "sent_to_book_at", "carrier_id", "pickup_appt_time", "picked_up_at", "picked_up_time", "delivery_appt_time", "delivered_time",
            "pickup_dock", "delivery_dock", "pickup_number_confirmed_at", "pickup_number_confirmed_by", "pay_due_date", "paperwork",
        ] {
            assert!(b.get(key).is_some(), "the key {key} is always there");
        }
        assert_eq!(b["extra_pickups"][0]["name"], "Second sample yard");
        assert_eq!(b["extra_pickups"][0]["window"], "1 to 4");
        // R-458: not urgent and no files until the server says so; then both read as the server sends them.
        assert_eq!((b["urgent"].as_bool(), b["files"].clone()), (Some(false), json!([])));
        assert_eq!(b["paperwork"], json!({ "bol": false, "pod": false, "carrier_invoice": false }));
        {
            let conn = pool().get().unwrap();
            conn.execute(
                "UPDATE freight_bookings SET urgent=1, files='[{\"id\":\"ff_1\",\"name\":\"Sample BOL.pdf\",\"mime\":\"application/pdf\",\"size\":1200,\"by\":\"Sample sender\",\"at\":\"2026-10-06\"},{\"name\":\"no id\"}]' WHERE id='fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77'", [],
            ).unwrap();
        }
        let b = &list_freight_bookings(Some(deal.clone())).await.unwrap()[0];
        assert_eq!(b["urgent"], true);
        assert_eq!(b["files"].as_array().unwrap().len(), 1, "an entry without an id is not a file");
        assert_eq!(b["files"][0]["name"], "Sample BOL.pdf");
        // R-459: no load number yet reads the old code, quote and times are empty or null.
        assert_eq!(b["code"], "L-7F3K2A");
        assert_eq!((b["load_number"].as_str(), b["pickup_appt_time"].as_str(), b["pay_due_date"].as_str()), (Some(""), Some(""), Some("")));
        assert_eq!((b["quote_amount"].clone(), b["quote_invoiced_amount"].clone()), (Value::Null, Value::Null));
        assert_eq!(b["paperwork"], json!({ "bol": false, "pod": false, "carrier_invoice": false }), "an entry with no kind is not any of the three");
        {
            let conn = pool().get().unwrap();
            conn.execute(
                "UPDATE freight_bookings SET load_number='LD-0012', quote_amount=1850.5, quote_note='Sample note', quoted_at='2026-10-06T09:00:00Z', quoted_by_name='Sample logistics',
                        quote_invoiced_at='2026-10-06', quote_invoiced_amount=1900, sent_to_book_at='2026-10-07', carrier_id='fc_sample', pickup_appt_time='08:30', picked_up_at='2026-10-02',
                        picked_up_time='09:15', delivery_appt_time='14:00', delivered_time='13:40', pickup_dock='Door 4', delivery_dock='Door 9',
                        pickup_number_confirmed_at='2026-10-01T12:00:00Z', pickup_number_confirmed_by='Sample sender', pay_due_date='2026-11-05',
                        files='[{\"id\":\"ff_1\",\"name\":\"a.pdf\",\"kind\":\"bol\"},{\"id\":\"ff_2\",\"name\":\"b.pdf\",\"kind\":\"carrier_invoice\"},{\"id\":\"ff_3\",\"name\":\"c.pdf\"}]'
                 WHERE id='fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77'", [],
            ).unwrap();
        }
        let b = &list_freight_bookings(Some(deal.clone())).await.unwrap()[0];
        assert_eq!(b["code"], "LD-0012", "the load number wins");
        assert_eq!((b["quote_amount"].as_f64(), b["quote_invoiced_amount"].as_f64()), (Some(1850.5), Some(1900.0)));
        for (k, v) in [
            ("load_number", "LD-0012"), ("quote_note", "Sample note"), ("quoted_at", "2026-10-06T09:00:00Z"), ("quoted_by_name", "Sample logistics"),
            ("quote_invoiced_at", "2026-10-06"), ("sent_to_book_at", "2026-10-07"), ("carrier_id", "fc_sample"), ("pickup_appt_time", "08:30"),
            ("picked_up_at", "2026-10-02"), ("picked_up_time", "09:15"), ("delivery_appt_time", "14:00"), ("delivered_time", "13:40"),
            ("pickup_dock", "Door 4"), ("delivery_dock", "Door 9"), ("pickup_number_confirmed_at", "2026-10-01T12:00:00Z"),
            ("pickup_number_confirmed_by", "Sample sender"), ("pay_due_date", "2026-11-05"),
        ] {
            assert_eq!(b[k], v, "{k}");
        }
        assert_eq!(b["paperwork"], json!({ "bol": true, "pod": false, "carrier_invoice": true }));
        assert_eq!(b["files"][2]["id"], "ff_3");
        // Without a deal filter: all live rows, whichever deal.
        assert!(list_freight_bookings(None).await.unwrap().iter().any(|r| r["id"] == "fb_7f3k2a91c0d84e5b8a6f13c2d9e04b77"));
    }
}

/// R-401: the logistics pay rule. Same numbers as the server's tests.
#[cfg(test)]
mod pay_tests {
    use super::*;

    fn rule(share: f64, cover: bool, loss: f64) -> PaySettings {
        PaySettings { enabled: true, share_pct: share, cover_losses: cover, loss_pay_pct: loss, ..PaySettings::default() }
    }

    fn lines(desc: &str, qty: f64, rate: f64) -> String {
        json!([{ "description": desc, "qty": qty, "rate": rate, "amount": qty * rate }]).to_string()
    }

    /// charged from the invoice lines, freight as given, never pending.
    fn pay(s: &PaySettings, items: &str, field: f64, freight: f64) -> (Option<f64>, &'static str) {
        let (charged, _) = charged_of(items, field);
        pay_for(s, charged, freight, false)
    }

    #[test]
    fn case_1_charged_500_paid_350_is_150() {
        assert_eq!(pay(&rule(100.0, true, 10.0), &lines("Shipping", 1.0, 500.0), 0.0, 350.0), (Some(150.0), "share"));
    }

    #[test]
    fn case_2_a_half_share_is_75() {
        assert_eq!(pay(&rule(50.0, true, 10.0), &lines("Shipping", 1.0, 500.0), 0.0, 350.0), (Some(75.0), "share"));
    }

    #[test]
    fn case_3_a_loss_is_covered_at_the_loss_percentage_of_the_freight() {
        assert_eq!(pay(&rule(100.0, true, 10.0), &lines("Shipping", 1.0, 300.0), 0.0, 350.0), (Some(35.0), "loss_cover"));
    }

    #[test]
    fn case_4_with_cover_off_the_loss_is_shared_and_negative() {
        assert_eq!(pay(&rule(100.0, false, 10.0), &lines("Shipping", 1.0, 300.0), 0.0, 350.0), (Some(-50.0), "loss_share"));
    }

    #[test]
    fn case_5_nothing_charged_and_200_paid_covers_5_percent() {
        assert_eq!(pay(&rule(100.0, true, 5.0), "[]", 0.0, 200.0), (Some(10.0), "loss_cover"));
        assert_eq!(charged_of("[]", 0.0), (0.0, "none"));
    }

    /// R-415: this was "a quote not paid yet is the freight" (pay 180). A quote no longer makes the
    /// freight known, so a load with a quote and no amount paid is pending until the amount is typed.
    #[test]
    fn case_6_changed_by_r415_a_quote_with_no_amount_paid_is_pending() {
        let _db = crate::db::init_test_store();
        let d = seed("c6quote", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&d, "1", "booked", "2026-10-01", None, Some(320.0));
        let line = read(&d, &on()).unwrap();
        assert!(line.pending && line.pay.is_none() && line.rule == "pending", "a quote does not make the freight known");
        // Once the amount paid is typed the pay follows it, whatever the quote said.
        pool().get().unwrap().execute("UPDATE freight_bookings SET paid_amount=350 WHERE deal_flow_id=?1", [&d]).unwrap();
        let line = read(&d, &on()).unwrap();
        assert_eq!((line.freight, line.pay, line.pending), (350.0, Some(150.0), false));
    }

    #[test]
    fn case_7_a_booking_with_no_amount_is_pending() {
        assert_eq!(pay_for(&rule(100.0, true, 10.0), 500.0, 0.0, true).0, None);
    }

    #[test]
    fn case_8_two_bookings_add_up() {
        let facts = crate::commands::ShipFacts { bookings: 2, unpaid: 0, paid: 325.0, ..Default::default() };
        let (freight, source) = freight_of(&facts);
        assert_eq!((freight, source), (325.0, "paid"));
        assert_eq!(pay(&rule(100.0, true, 10.0), &lines("Freight", 1.0, 400.0), 0.0, freight), (Some(75.0), "share"));
        // R-415: a quote is not part of the freight any more (it was 860, "mixed").
        let bank = crate::commands::ShipFacts { bookings: 1, has_link: true, linked: 810.0, quoted: 50.0, ..Default::default() };
        assert_eq!(freight_of(&bank), (810.0, "bank"));
        let only_bank = crate::commands::ShipFacts { bookings: 1, has_link: true, linked: 810.0, ..Default::default() };
        assert_eq!(freight_of(&only_bank), (810.0, "bank"));
    }

    #[test]
    fn case_9_which_lines_count_as_shipping() {
        assert_eq!(charged_of(&lines("Shipping to Orlando, FL", 1.0, 400.0), 0.0), (400.0, "lines"));
        assert_eq!(charged_of(&lines("Ship-to deposit", 1.0, 400.0), 0.0), (0.0, "none"));
        assert_eq!(charged_of(&lines("", 1.0, 400.0), 0.0), (0.0, "none"), "an empty description is not a shipping line here");
        assert_eq!(charged_of(&lines("Ship-to deposit", 1.0, 400.0), 275.0), (275.0, "field"), "the invoice field stands in when no line is a shipping line");
        // The invoice adds up each line's stored amount, so a line stored at 0 charged 0; only a
        // line with no amount at all is qty x rate.
        assert_eq!(charged_of(r#"[{"description":"Freight","qty":2,"rate":125,"amount":0}]"#, 0.0), (0.0, "lines"));
        assert_eq!(charged_of(r#"[{"description":"Shipping","qty":2,"rate":125,"amount":0}]"#, 300.0), (0.0, "lines"), "a shipping line at 0 beats the field");
        assert_eq!(charged_of(r#"[{"description":"Freight","qty":2,"rate":125}]"#, 0.0), (250.0, "lines"));
        // Goods lines never count, whatever their size.
        let mixed = json!([{"description":"Pallet of shoes","qty":1,"rate":5000,"amount":5000},{"description":"Shipping & handling","qty":1,"rate":90,"amount":90}]).to_string();
        assert_eq!(charged_of(&mixed, 0.0), (90.0, "lines"));
    }

    fn weekly(weekday: u32) -> PaySettings {
        PaySettings { frequency: "weekly".into(), pay_weekday: weekday, ..PaySettings::default() }
    }

    #[test]
    fn put_passes_the_method_check_and_head_and_options_do_not() {
        for m in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            assert!(logistics_method_ok(m), "{m}");
        }
        for m in ["HEAD", "OPTIONS", "TRACE", "CONNECT", ""] {
            assert!(!logistics_method_ok(m), "{m}");
        }
    }

    #[test]
    fn an_encoded_dot_segment_cannot_climb_out_of_the_logistics_routes() {
        for bad in ["/api/logistics/%2e%2e/deal-flows", "/api/logistics/%2E%2E/bank/txns", "/api/logistics/bookings%2fx", "/api/logistics/.%2e/x"] {
            assert!(!logistics_path_ok(bad), "{bad}");
        }
        assert!(logistics_path_ok("/api/logistics/pay/settings"));
        assert!(logistics_path_ok("/api/logistics/pay/tracker?today=2026-10-10"));
    }

    #[test]
    fn case_10_pay_dates() {
        // Earned Thursday 2026-10-01, paid Fridays: the next day. Earned Friday: a week later.
        let d = pay_date_for("2026-10-01", &weekly(4)).unwrap();
        assert_eq!((d.pay_date.as_str(), d.period_start.as_str(), d.period_end.as_str()), ("2026-10-02", "2026-09-25", "2026-10-01"));
        assert_eq!(pay_date_for("2026-10-02", &weekly(4)).unwrap().pay_date, "2026-10-09");
        // A full timestamp reads as its day.
        assert_eq!(pay_date_for("2026-10-02T15:04:05Z", &weekly(4)).unwrap().pay_date, "2026-10-09");
        // Monthly on the 5th, earned at the end of September.
        let m = PaySettings { frequency: "monthly".into(), pay_day_of_month: 5, ..PaySettings::default() };
        let d = pay_date_for("2026-09-30", &m).unwrap();
        assert_eq!((d.pay_date.as_str(), d.period_start.as_str(), d.period_end.as_str()), ("2026-10-05", "2026-09-01", "2026-09-30"));
        assert_eq!(pay_date_for("2026-12-15", &m).unwrap().pay_date, "2027-01-05");
        // Every two weeks from an anchor: strictly after, either direction.
        let b = PaySettings { frequency: "biweekly".into(), anchor_date: "2026-10-02".into(), ..PaySettings::default() };
        let d = pay_date_for("2026-10-03", &b).unwrap();
        assert_eq!((d.pay_date.as_str(), d.period_start.as_str(), d.period_end.as_str()), ("2026-10-16", "2026-10-02", "2026-10-15"));
        assert_eq!(pay_date_for("2026-10-02", &b).unwrap().pay_date, "2026-10-16", "earned on a pay date is paid on the next one");
        assert_eq!(pay_date_for("2026-09-01", &b).unwrap().pay_date, "2026-09-04", "before the anchor counts back in whole steps");
        assert_eq!(pay_date_for("2026-10-01", &b).unwrap().pay_date, "2026-10-02");
        let no_anchor = PaySettings { frequency: "biweekly".into(), ..PaySettings::default() };
        assert!(pay_date_for("2026-10-03", &no_anchor).is_none());
        assert!(pay_date_for("", &weekly(4)).is_none());
    }

    #[test]
    fn case_11_the_owner_split_starts_after_the_rep_and_the_logistics_pay() {
        assert_eq!(owner_remainder(1000.0, 100.0, 150.0), 750.0);
        assert_eq!(owner_remainder(1000.0, 0.0, 0.0), 1000.0);
        assert_eq!(owner_remainder(1000.0, 0.0, -50.0), 1050.0, "a shared loss adds back");
    }

    fn track() -> PaySettings {
        PaySettings { surplus_mode: "track".into(), ..on() }
    }

    /// R-415 case 3: track mode. Charged 500, paid 350: the surplus is still 150 but the pay is 0
    /// with rule tracked, there is no pay date, and the owner split takes no logistics cut.
    #[test]
    fn r415_track_mode_reports_the_surplus_and_owes_nothing() {
        let _db = crate::db::init_test_store();
        let d = seed("trk", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&d, "1", "delivered", "2026-10-01", Some(350.0), None);
        let line = read(&d, &track()).unwrap();
        assert_eq!((line.pay, line.rule, line.pending), (Some(0.0), "tracked", false));
        assert_eq!((line.charged, line.freight, cents(line.surplus)), (500.0, 350.0, 150.0), "the surplus is still reported");
        assert_eq!(line.due_date, "", "nothing is owed, so no pay date");
        assert_eq!(read(&d, &on()).unwrap().pay, Some(150.0), "the same load in pay mode");
        // The owner split takes no logistics cut: it starts from the whole net.
        assert_eq!(owner_remainder(1000.0, 0.0, line.pay.unwrap_or(0.0)), 1000.0);
        // Pending stays pending.
        let p = seed("trkpend", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&p, "1", "booked", "2026-10-01", None, None);
        let line = read(&p, &track()).unwrap();
        assert!(line.pending && line.pay.is_none() && line.rule == "pending");
        // Off still means no line at all, in either mode.
        assert!(read(&d, &PaySettings { enabled: false, ..track() }).is_none());
    }

    /// R-415 case 3, second half: a load paid before the switch keeps its paid rule, so switching
    /// to track never takes money back (no negative delta).
    #[test]
    fn r415_a_load_paid_before_switching_to_track_keeps_its_paid_150() {
        let _db = crate::db::init_test_store();
        let paid = seed("trkpaid", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&paid, "1", "delivered", "2026-10-01", Some(350.0), None);
        let open = seed("trkopen", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&open, "1", "delivered", "2026-10-01", Some(350.0), None);
        pool().get().unwrap().execute(
            "INSERT INTO logistics_payouts (id, payee_id, pay_date, amount, lines_json, created_at, updated_at)
             VALUES ('lp_trk', '', '2026-10-02', 150, ?1, '2026-10-02', '2026-10-02')",
            [json!([{ "deal_flow_id": paid, "amount": 150.0, "share_pct": 100.0, "cover_losses": true, "loss_pay_pct": 10.0 }]).to_string()],
        ).unwrap();
        let kept = read(&paid, &track()).unwrap();
        assert_eq!((kept.pay, kept.rule), (Some(150.0), "share"), "the paid load keeps the paid rule, in pay mode");
        let new = read(&open, &track()).unwrap();
        assert_eq!((new.pay, new.rule), (Some(0.0), "tracked"), "a load not paid yet is tracked");
        pool().get().unwrap().execute("UPDATE logistics_payouts SET archived=1 WHERE id='lp_trk'", []).unwrap();
    }

    #[test]
    fn r415_the_surplus_mode_reads_tolerantly_and_defaults_to_pay() {
        assert_eq!(PaySettings::default().surplus_mode, "pay");
        assert_eq!(PaySettings::from_json(r#"{"enabled":true}"#).surplus_mode, "pay");
        assert_eq!(PaySettings::from_json(r#"{"enabled":true,"surplus_mode":"track"}"#).surplus_mode, "track");
        assert_eq!(PaySettings::from_json(r#"{"surplus_mode":"sideways"}"#).surplus_mode, "pay");
        assert!(PaySettings::from_json(r#"{"surplus_mode":"track"}"#).tracks());
        assert_eq!(pay_for(&track(), 500.0, 350.0, false), (Some(0.0), "tracked"));
        assert_eq!(pay_for(&track(), 500.0, 0.0, true), (None, "pending"));
        assert_eq!(pay_for(&track(), 300.0, 350.0, false), (Some(0.0), "tracked"), "a loss is tracked too");
    }

    #[test]
    fn r415_freight_by_team_is_read_from_the_org_setting_and_defaults_to_on() {
        let _db = crate::db::init_test_store();
        let conn = pool().get().unwrap();
        let put = |k: &str, v: &str| conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]).unwrap();
        conn.execute("DELETE FROM settings WHERE key LIKE '%logistics_settings'", []).unwrap();
        conn.execute("DELETE FROM device_state WHERE key='netsync_org'", []).unwrap();
        assert!(read_freight_by_team(), "never written reads as on");
        put("logistics_settings", r#"{"freight_by_team":false}"#);
        assert!(!read_freight_by_team());
        conn.execute("INSERT INTO device_state (key, value) VALUES ('netsync_org', 'org_sample') ON CONFLICT(key) DO UPDATE SET value=excluded.value", []).unwrap();
        put("org_sample::logistics_settings", r#"{"freight_by_team":true}"#);
        assert!(read_freight_by_team(), "the org's scoped key is read first");
        put("org_sample::logistics_settings", "not json");
        assert!(read_freight_by_team(), "a broken value reads as on");
        conn.execute("DELETE FROM settings WHERE key LIKE '%logistics_settings'", []).unwrap();
        conn.execute("DELETE FROM device_state WHERE key='netsync_org'", []).unwrap();
    }

    #[test]
    fn the_setting_reads_tolerantly() {
        assert!(!PaySettings::from_json("").enabled);
        assert!(!PaySettings::from_json("not json").enabled);
        let s = PaySettings::from_json(r#"{"enabled":true,"payee_name":"Sample payee","share_pct":60.5,"cover_losses":false,"loss_pay_pct":7,"frequency":"monthly","pay_weekday":9,"pay_day_of_month":40,"method":"Zelle"}"#);
        assert!(s.enabled && !s.cover_losses);
        assert_eq!((s.share_pct, s.loss_pay_pct, s.pay_weekday, s.pay_day_of_month), (60.5, 7.0, 6, 28));
        assert_eq!((s.frequency.as_str(), s.payee_name.as_str(), s.method.as_str()), ("monthly", "Sample payee", "Zelle"));
        assert_eq!(PaySettings::from_json(r#"{"frequency":"daily"}"#).frequency, "weekly");
    }

    // The deal-level read: what counts as a line, and what the booking's day does.

    fn seed(tag: &str, items: &str, field: f64) -> String {
        let id = format!("df-pay-{tag}");
        let conn = pool().get().unwrap();
        conn.execute("INSERT OR IGNORE INTO clients (id, name, created_at, updated_at) VALUES ('c-pay', 'Sample buyer', '2026-09-01', '2026-09-01')", []).unwrap();
        conn.execute(
            "INSERT INTO invoices (id, client_id, number, issue_date, due_date, line_items_json, subtotal, total, shipping_charged, created_at)
             VALUES (?1, 'c-pay', ?2, '2026-09-01', '2026-09-30', ?3, 10000, 10000, ?4, '2026-09-01')",
            rusqlite::params![format!("inv-pay-{tag}"), format!("INV-PAY-{tag}"), items, field],
        ).unwrap();
        conn.execute(
            "INSERT INTO deal_flows (id, invoice_id, stage, created_at, updated_at, supplier_payments_json, total_supplier_cost)
             VALUES (?1, ?2, 'supplier_paid', '2026-09-01', '2026-09-01', '[]', 6000)",
            rusqlite::params![id, format!("inv-pay-{tag}")],
        ).unwrap();
        id
    }

    fn book(deal: &str, n: &str, status: &str, booked_at: &str, paid: Option<f64>, quoted: Option<f64>) {
        pool().get().unwrap().execute(
            "INSERT INTO freight_bookings (id, deal_flow_id, status, booked_at, paid_amount, quoted_cost, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-09-02', '2026-09-02')",
            rusqlite::params![format!("fb_{deal}_{n}"), deal, status, booked_at, paid, quoted],
        ).unwrap();
    }

    fn on() -> PaySettings {
        rule(100.0, true, 10.0)
    }

    fn read(deal: &str, s: &PaySettings) -> Option<DealPay> {
        deal_pay(&pool().get().unwrap(), deal, s)
    }

    #[test]
    fn a_rule_change_does_not_reprice_a_paid_load() {
        let _db = crate::db::init_test_store();
        let paid = seed("rulepaid", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&paid, "1", "booked", "2026-10-01", Some(350.0), None);
        let open = seed("ruleopen", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&open, "1", "booked", "2026-10-01", Some(350.0), None);
        assert_eq!(read(&paid, &on()).unwrap().pay, Some(150.0));
        // Paid under share 100 (the rule rides on the payment line, as the server records it).
        pool().get().unwrap().execute(
            "INSERT INTO logistics_payouts (id, payee_id, pay_date, amount, lines_json, created_at, updated_at)
             VALUES ('lp_rule', '', '2026-10-02', 150, ?1, '2026-10-02', '2026-10-02')",
            [json!([{ "deal_flow_id": paid, "amount": 150.0, "share_pct": 100.0, "cover_losses": true, "loss_pay_pct": 10.0 }]).to_string()],
        ).unwrap();
        let half = rule(50.0, true, 10.0);
        assert_eq!(read(&paid, &half).unwrap().pay, Some(150.0), "the paid load keeps its rule");
        assert_eq!(read(&open, &half).unwrap().pay, Some(75.0), "an unpaid load takes the new one");
        // A line recorded without a rule uses the current one; an archived payment is ignored.
        pool().get().unwrap().execute("UPDATE logistics_payouts SET archived=1 WHERE id='lp_rule'", []).unwrap();
        assert_eq!(read(&paid, &half).unwrap().pay, Some(75.0));
    }

    #[test]
    fn a_deal_has_a_line_only_once_a_live_booking_is_booked() {
        let _db = crate::db::init_test_store();
        let items = lines("Shipping", 1.0, 500.0);
        let off = seed("off", &items, 0.0);
        book(&off, "1", "booked", "2026-10-01", Some(350.0), None);
        assert!(read(&off, &PaySettings { enabled: false, ..on() }).is_none(), "the rule is off");

        let requested = seed("req", &items, 0.0);
        book(&requested, "1", "requested", "", Some(350.0), None);
        assert!(read(&requested, &on()).is_none(), "sent to logistics but not booked yet");

        let cancelled = seed("can", &items, 0.0);
        book(&cancelled, "1", "cancelled", "2026-10-01", Some(350.0), None);
        assert!(read(&cancelled, &on()).is_none(), "a cancelled booking is simply not live, even with its booked day kept");

        let archived = seed("arc", &items, 0.0);
        book(&archived, "1", "booked", "2026-10-01", Some(350.0), None);
        pool().get().unwrap().execute("UPDATE deal_flows SET archived=1 WHERE id=?1", [&archived]).unwrap();
        assert!(read(&archived, &on()).is_none());

        let voided = seed("void", &items, 0.0);
        book(&voided, "1", "booked", "2026-10-01", Some(350.0), None);
        pool().get().unwrap().execute("UPDATE invoices SET voided=1 WHERE id='inv-pay-void'", []).unwrap();
        assert!(read(&voided, &on()).is_none());

        let inv_archived = seed("invarc", &items, 0.0);
        book(&inv_archived, "1", "booked", "2026-10-01", Some(350.0), None);
        pool().get().unwrap().execute("UPDATE invoices SET archived=1 WHERE id='inv-pay-invarc'", []).unwrap();
        assert!(read(&inv_archived, &on()).is_none(), "an archived invoice drops the line, as the server does");

        let ok = seed("ok", &items, 0.0);
        book(&ok, "1", "delivered", "2026-10-01", Some(350.0), None);
        let d = read(&ok, &on()).unwrap();
        assert_eq!((d.charged, d.charged_source, d.freight, d.freight_source), (500.0, "lines", 350.0, "paid"));
        assert_eq!((d.pay, d.rule, d.pending), (Some(150.0), "share", false));
        assert_eq!((d.earned_on.as_str(), d.due_date.as_str()), ("2026-10-01", "2026-10-02"));
        assert_eq!(d.booking_codes.len(), 1);
    }

    #[test]
    fn the_rule_is_read_from_the_orgs_scoped_key_then_the_plain_one() {
        let _db = crate::db::init_test_store();
        let conn = pool().get().unwrap();
        let put = |k: &str, v: &str| conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]).unwrap();
        conn.execute("DELETE FROM settings WHERE key LIKE '%logistics_pay'", []).unwrap();
        conn.execute("INSERT INTO device_state (key, value) VALUES ('netsync_org', 'org_sample') ON CONFLICT(key) DO UPDATE SET value=excluded.value", []).unwrap();
        put("org_sample::logistics_pay", r#"{"enabled":true,"share_pct":40}"#);
        let s = read_pay_settings();
        assert!(s.enabled && s.share_pct == 40.0, "a workspace other than the default reads its prefixed key");
        conn.execute("DELETE FROM settings WHERE key='org_sample::logistics_pay'", []).unwrap();
        put("logistics_pay", r#"{"enabled":true,"share_pct":70}"#);
        assert_eq!(read_pay_settings().share_pct, 70.0, "the plain key still works");
        conn.execute("DELETE FROM settings WHERE key='logistics_pay'", []).unwrap();
        conn.execute("DELETE FROM device_state WHERE key='netsync_org'", []).unwrap();
        assert!(!read_pay_settings().enabled);
    }

    #[test]
    fn a_booked_truck_with_no_amount_is_pending_and_the_earliest_booked_day_is_when_it_was_earned() {
        let _db = crate::db::init_test_store();
        let items = lines("Shipping", 1.0, 500.0);
        let pend = seed("pend", &items, 0.0);
        book(&pend, "1", "booked", "2026-10-05", Some(150.0), None);
        book(&pend, "2", "booked", "2026-10-02", None, None);
        let d = read(&pend, &on()).unwrap();
        assert!(d.pending && d.pay.is_none(), "one truck has neither an amount nor a quote");
        assert_eq!(d.earned_on, "2026-10-02");

        // R-415: a quote alone no longer makes the amount known, so it stays pending.
        let quote = seed("quote", &items, 0.0);
        book(&quote, "1", "booked", "2026-10-02", None, Some(320.0));
        let d = read(&quote, &on()).unwrap();
        assert_eq!((d.pending, d.pay, d.rule), (true, None, "pending"));

        // Two trucks, one not booked yet: the booked one sets the day.
        let two = seed("two", &lines("Freight", 1.0, 400.0), 0.0);
        book(&two, "1", "booked", "2026-10-06", Some(150.0), None);
        book(&two, "2", "requested", "", Some(175.0), None);
        let d = read(&two, &on()).unwrap();
        assert_eq!((d.freight, d.pay, d.earned_on.as_str()), (325.0, Some(75.0), "2026-10-06"));
    }

    #[test]
    fn migration_106_creates_the_booked_day_and_the_pay_record() {
        let _db = crate::db::init_test_store();
        let conn = pool().get().unwrap();
        let cols = |t: &str| -> Vec<String> {
            let mut st = conn.prepare(&format!("PRAGMA table_info({t})")).unwrap();
            st.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect()
        };
        let fb = cols("freight_bookings");
        assert_eq!(fb.iter().position(|c| c == "booked_at"), fb.iter().position(|c| c == "status").map(|i| i + 1), "booked_at sits right after status, in the CREATE");
        let lp = cols("logistics_payouts");
        for c in ["id", "org_id", "payee_id", "payee_name", "pay_date", "period_start", "period_end", "amount", "lines_json", "method", "reference", "note", "paid_at", "created_by", "created_by_name", "archived", "created_at", "updated_at"] {
            assert!(lp.iter().any(|x| x == c), "logistics_payouts.{c}");
        }
        let versions: Vec<i64> = conn.prepare("SELECT version FROM schema_migrations WHERE version BETWEEN 104 AND 106 ORDER BY version").unwrap()
            .query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
        assert_eq!(versions, vec![105, 106], "R-402 owns 105, R-400 and R-401 share 106, nothing sits at 104");
    }

    /// R-459: a quote-stage booking is not a truck, so it neither opens the logistics pay line nor
    /// holds one back as pending, whatever it carries.
    #[test]
    fn r459_a_quote_stage_booking_changes_no_logistics_pay() {
        let _db = crate::db::init_test_store();
        let items = lines("Shipping", 1.0, 500.0);
        // Only a quote (even with a booked day on it): no line at all.
        let only = seed("q459a", &items, 0.0);
        book(&only, "1", "quote", "2026-10-01", None, Some(300.0));
        book(&only, "2", "quoted", "2026-10-01", None, Some(300.0));
        assert!(read(&only, &on()).is_none(), "nothing live is booked, so nothing is earned");
        // A paid live truck beside an open quote: the pay is worked as if the quote were not there.
        let both = seed("q459b", &items, 0.0);
        book(&both, "1", "booked", "2026-10-02", Some(350.0), None);
        let alone = read(&both, &on()).unwrap();
        book(&both, "2", "quoted", "", None, Some(900.0));
        book(&both, "3", "quote", "", None, None);
        let with = read(&both, &on()).unwrap();
        assert_eq!(alone, with, "the quotes change nothing");
        assert_eq!((with.pending, with.pay, with.freight, with.earned_on.as_str()), (false, Some(150.0), 350.0, "2026-10-02"));
        assert_eq!(with.booking_codes.len(), 1, "only the live truck is listed");
    }

    #[test]
    fn r459_a_deal_pay_line_names_its_trucks_by_load_number() {
        let _db = crate::db::init_test_store();
        let id = seed("q459c", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&id, "1", "booked", "2026-10-01", Some(350.0), None);
        book(&id, "2", "booked", "2026-10-01", Some(100.0), None);
        pool().get().unwrap().execute("UPDATE freight_bookings SET load_number='LD-0007' WHERE id=?1", [format!("fb_{id}_1")]).unwrap();
        let d = read(&id, &on()).unwrap();
        assert_eq!(d.booking_codes.len(), 2);
        assert!(d.booking_codes.contains(&"LD-0007".to_string()), "a load number wins");
        assert!(d.booking_codes.iter().any(|c| c.starts_with("L-")), "a truck with no load number keeps the old code");
    }

    #[test]
    fn migration_110_adds_every_quote_first_column() {
        let _db = crate::db::init_test_store();
        let conn = pool().get().unwrap();
        let mut st = conn.prepare("PRAGMA table_info(freight_bookings)").unwrap();
        let cols: Vec<(String, String, String)> = st
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(4)?.unwrap_or_default())))
            .unwrap().filter_map(|r| r.ok()).collect();
        let want_text = [
            "load_number", "quote_note", "quoted_at", "quoted_by_name", "quote_invoiced_at", "sent_to_book_at", "carrier_id", "pickup_appt_time",
            "picked_up_at", "picked_up_time", "delivery_appt_time", "delivered_time", "pickup_dock", "delivery_dock",
            "pickup_number_confirmed_at", "pickup_number_confirmed_by", "pay_due_date",
        ];
        for c in want_text {
            let found = cols.iter().find(|(n, _, _)| n == c).unwrap_or_else(|| panic!("freight_bookings.{c} is missing"));
            assert_eq!((found.1.as_str(), found.2.as_str()), ("TEXT", "''"), "{c} is TEXT DEFAULT ''");
        }
        for c in ["quote_amount", "quote_invoiced_amount"] {
            let found = cols.iter().find(|(n, _, _)| n == c).unwrap_or_else(|| panic!("freight_bookings.{c} is missing"));
            assert_eq!((found.1.as_str(), found.2.as_str()), ("REAL", ""), "{c} is a nullable REAL");
        }
        assert_eq!(want_text.len() + 2, 19, "the contract lists 19 new columns");
        let v: i64 = conn.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version=110", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
        // An old row (no new column named) reads back with the defaults.
        conn.execute("INSERT INTO freight_bookings (id, status, created_at, updated_at) VALUES ('fb_m110', 'requested', '2026-10-01', '2026-10-01')", []).unwrap();
        let (ln, qa): (String, Option<f64>) = conn.query_row("SELECT load_number, quote_amount FROM freight_bookings WHERE id='fb_m110'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((ln.as_str(), qa), ("", None));
    }

    #[test]
    fn the_json_the_deal_page_reads_has_every_figure() {
        let _db = crate::db::init_test_store();
        let id = seed("json", &lines("Shipping", 1.0, 500.0), 0.0);
        book(&id, "1", "booked", "2026-10-01", Some(350.0), None);
        let v = read(&id, &on()).unwrap().to_json();
        for k in ["charged", "charged_source", "freight", "freight_source", "surplus", "pay", "rule", "pending", "earned_on", "due_date", "booking_codes"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!((v["surplus"].as_f64(), v["pay"].as_f64()), (Some(150.0), Some(150.0)));
    }
}
