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

/// The booking's text columns, in the order the booking object lists them (status first, then
/// everything down to the accessorials). Selected as strings, never NULL.
const TEXT_A: &[&str] = &[
    "status", "request_note", "pickup_name", "pickup_address", "pickup_date", "pickup_window", "pickup_contact",
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
            "id", "code", "status", "request_note", "pickup_name", "pickup_address", "pickup_date", "pickup_window", "pickup_contact", "pickup_phone",
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
