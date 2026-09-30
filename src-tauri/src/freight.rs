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

/// Only the logistics routes may be reached through `logistics_request`: `/api/logistics`, alone
/// or followed by `/` or `?`, with nothing that could climb out of it.
fn logistics_path_ok(path: &str) -> bool {
    if path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('#') || path.chars().any(|c| c.is_control() || c == ' ') {
        return false;
    }
    match path.strip_prefix("/api/logistics") {
        Some(rest) => rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'),
        None => false,
    }
}

/// One call to the server's Logistics routes as the signed-in account. `method` is GET, POST,
/// PATCH or DELETE and `path` starts `/api/logistics`. Returns the JSON the server answered. A
/// refusal comes back as the server's own sentence (it is written to be shown as it is).
#[tauri::command]
pub async fn logistics_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let m = method.trim().to_ascii_uppercase();
    if !matches!(m.as_str(), "GET" | "POST" | "PATCH" | "DELETE") {
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
    let sql = format!(
        "SELECT fb.id, {a}, fb.quoted_cost, fb.paid_amount, {b},
                COALESCE(df.id,''), COALESCE(i.number,''), COALESCE(c.name,''), COALESCE(df.stage,'')
         FROM freight_bookings fb
         LEFT JOIN deal_flows df ON df.id = fb.deal_flow_id
         LEFT JOIN invoices i ON i.id = df.invoice_id
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE fb.archived = 0 AND (?1 = '' OR fb.deal_flow_id = ?1)
         ORDER BY CASE fb.status WHEN 'requested' THEN 0 ELSE 1 END,
                  CASE WHEN COALESCE(fb.pickup_date,'') = '' THEN 1 ELSE 0 END, fb.pickup_date, fb.created_at",
        a = a.join(", "), b = b.join(", "),
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let na = TEXT_A.len();
    let rows = stmt.query_map([deal_flow_id.unwrap_or_default()], |r| {
        let id: String = r.get(0)?;
        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        m.insert("code".into(), json!(booking_code(&id)));
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
}

impl Default for PaySettings {
    fn default() -> Self {
        PaySettings {
            enabled: false, payee_id: String::new(), payee_name: String::new(), share_pct: 100.0,
            cover_losses: true, loss_pay_pct: 0.0, frequency: "weekly".into(), pay_weekday: 4,
            anchor_date: String::new(), pay_day_of_month: 1, method: String::new(), details: String::new(),
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
        s
    }
}

/// The org's logistics pay rule from the local settings table (the server writes it and it
/// reaches this device through the pull). Off when it was never set.
pub fn read_pay_settings() -> PaySettings {
    let raw: Option<String> = pool().get().ok()
        .and_then(|c| c.query_row("SELECT value FROM settings WHERE key='logistics_pay'", [], |r| r.get(0)).ok());
    raw.map(|s| PaySettings::from_json(&s)).unwrap_or_default()
}

fn cents(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// What the customer was charged for shipping, from the invoice. The sum of the line amounts
/// whose description is non-empty and a shipping line by the R-255 rule (a line's amount is the
/// stored amount the invoice itself adds up, or qty x rate for a line that never had it filled
/// in). When no shipping line carries money, the invoice's `shipping_charged` field when it is
/// above zero, else nothing. Returns the amount and where it came from: `lines`, `field`, `none`.
pub fn charged_of(line_items_json: &str, shipping_charged: f64) -> (f64, &'static str) {
    let items: Vec<crate::invoice::LineItem> = serde_json::from_str(line_items_json).unwrap_or_default();
    let from_lines: f64 = items.iter()
        .filter(|l| !l.description.trim().is_empty() && crate::commands::is_shipping_line(&l.description))
        .map(|l| if l.amount != 0.0 { l.amount } else { l.qty * l.rate })
        .sum();
    if from_lines > 0.005 {
        (cents(from_lines), "lines")
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
pub fn pay_for(s: &PaySettings, charged: f64, freight: f64, pending: bool) -> (Option<f64>, &'static str) {
    let surplus = charged - freight;
    if pending {
        return (None, "pending");
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

/// The freight cost a deal's pay is measured against, and where it came from: the shipping
/// estimate (linked-or-paid plus the quotes not paid yet), named `bank` (a shipping link),
/// `paid` (the amounts paid), `quote` (quotes only) or `mixed` (paid or linked plus a quote).
pub fn freight_of(facts: &crate::commands::ShipFacts) -> (f64, &'static str) {
    let base = if facts.has_link { Some("bank") } else if facts.bookings - facts.unpaid > 0 { Some("paid") } else { None };
    let quoted = facts.quoted > 0.005;
    let source = match (base, quoted) {
        (Some(_), true) => "mixed",
        (Some(b), false) => b,
        (None, true) => "quote",
        (None, false) => "paid",
    };
    (cents(facts.estimate()), source)
}

/// The logistics pay for one deal under the org's rule, or `None` when there is no line: the rule
/// is off, the deal is archived or voided, or no live booking has been confirmed booked yet.
/// A deal whose freight amount is not known yet is a line with `pay: None` (pending).
pub fn deal_pay(conn: &rusqlite::Connection, deal_flow_id: &str, s: &PaySettings) -> Option<DealPay> {
    if !s.enabled {
        return None;
    }
    let (archived, voided, items, field): (i64, i64, String, f64) = conn.query_row(
        "SELECT COALESCE(df.archived,0), COALESCE(i.voided,0), COALESCE(i.line_items_json,'[]'), COALESCE(i.shipping_charged,0)
         FROM deal_flows df LEFT JOIN invoices i ON i.id=df.invoice_id WHERE df.id=?1",
        [deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).ok()?;
    if archived != 0 || voided != 0 {
        return None;
    }
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(booked_at,''), CASE WHEN paid_amount IS NULL AND quoted_cost IS NULL THEN 1 ELSE 0 END
         FROM freight_bookings WHERE deal_flow_id=?1 AND archived=0 AND status!='cancelled' ORDER BY created_at, id",
    ).ok()?;
    let live: Vec<(String, String, i64)> = stmt
        .query_map([deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok()?
        .filter_map(|r| r.ok()).collect();
    let earned_on = live.iter().map(|(_, b, _)| b.as_str()).filter(|b| !b.is_empty()).min()?.to_string();
    let pending = live.iter().any(|(_, _, none)| *none != 0);
    let (charged, charged_source) = charged_of(&items, field);
    let (freight, freight_source) = freight_of(&crate::commands::ship_facts(conn, deal_flow_id));
    let (pay, rule) = pay_for(s, charged, freight, pending);
    let due_date = pay_date_for(&earned_on, s).map(|d| d.pay_date).unwrap_or_default();
    Some(DealPay {
        charged, charged_source, freight, freight_source, surplus: charged - freight, pay, rule, pending,
        earned_on, due_date,
        booking_codes: live.iter().map(|(id, _, _)| booking_code(id)).collect(),
    })
}

/// The amount of logistics pay to take off the top of a deal's net: its pay, or 0 when the rule
/// is off, there is no line, or the amount is not known yet.
pub fn logistics_pay_amount(conn: &rusqlite::Connection, deal_flow_id: &str) -> f64 {
    deal_pay(conn, deal_flow_id, &read_pay_settings()).and_then(|d| d.pay).unwrap_or(0.0)
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
            "can_see_names", "can_see_addresses", "can_see_deal", "tracking", "deal",
        ] {
            assert!(b.get(key).is_some(), "the key {key} is always there");
        }
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

    #[test]
    fn case_6_a_quote_not_paid_yet_is_the_freight() {
        let facts = crate::commands::ShipFacts { bookings: 1, unpaid: 1, quoted: 320.0, ..Default::default() };
        let (freight, source) = freight_of(&facts);
        assert_eq!((freight, source), (320.0, "quote"));
        assert_eq!(pay(&rule(100.0, true, 10.0), &lines("Shipping", 1.0, 500.0), 0.0, freight), (Some(180.0), "share"));
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
        let bank = crate::commands::ShipFacts { bookings: 1, has_link: true, linked: 810.0, quoted: 50.0, ..Default::default() };
        assert_eq!(freight_of(&bank), (860.0, "mixed"));
        let only_bank = crate::commands::ShipFacts { bookings: 1, has_link: true, linked: 810.0, ..Default::default() };
        assert_eq!(freight_of(&only_bank), (810.0, "bank"));
    }

    #[test]
    fn case_9_which_lines_count_as_shipping() {
        assert_eq!(charged_of(&lines("Shipping to Orlando, FL", 1.0, 400.0), 0.0), (400.0, "lines"));
        assert_eq!(charged_of(&lines("Ship-to deposit", 1.0, 400.0), 0.0), (0.0, "none"));
        assert_eq!(charged_of(&lines("", 1.0, 400.0), 0.0), (0.0, "none"), "an empty description is not a shipping line here");
        assert_eq!(charged_of(&lines("Ship-to deposit", 1.0, 400.0), 275.0), (275.0, "field"), "the invoice field stands in when no line is a shipping line");
        // A line that never had its amount filled in is qty x rate, as the invoice's own unit maths does.
        assert_eq!(charged_of(r#"[{"description":"Freight","qty":2,"rate":125,"amount":0}]"#, 0.0), (250.0, "lines"));
        // Goods lines never count, whatever their size.
        let mixed = json!([{"description":"Pallet of shoes","qty":1,"rate":5000,"amount":5000},{"description":"Shipping & handling","qty":1,"rate":90,"amount":90}]).to_string();
        assert_eq!(charged_of(&mixed, 0.0), (90.0, "lines"));
    }

    fn weekly(weekday: u32) -> PaySettings {
        PaySettings { frequency: "weekly".into(), pay_weekday: weekday, ..PaySettings::default() }
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

        let ok = seed("ok", &items, 0.0);
        book(&ok, "1", "delivered", "2026-10-01", Some(350.0), None);
        let d = read(&ok, &on()).unwrap();
        assert_eq!((d.charged, d.charged_source, d.freight, d.freight_source), (500.0, "lines", 350.0, "paid"));
        assert_eq!((d.pay, d.rule, d.pending), (Some(150.0), "share", false));
        assert_eq!((d.earned_on.as_str(), d.due_date.as_str()), ("2026-10-01", "2026-10-02"));
        assert_eq!(d.booking_codes.len(), 1);
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

        let quote = seed("quote", &items, 0.0);
        book(&quote, "1", "booked", "2026-10-02", None, Some(320.0));
        let d = read(&quote, &on()).unwrap();
        assert_eq!((d.freight, d.freight_source, d.pay), (320.0, "quote", Some(180.0)));

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
        let versions: Vec<i64> = conn.prepare("SELECT version FROM schema_migrations WHERE version >= 104").unwrap()
            .query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
        assert_eq!(versions, vec![106], "R-400 and R-401 share 106 and this build adds nothing at 104 or 105");
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
