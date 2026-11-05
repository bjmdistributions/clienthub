//! R-590: one bank link per account feeds the books.
//!
//! Jack's Mac and PC each held their own Plaid link to the same bank accounts. Plaid gives one
//! payment a different transaction id on each link, so every payment could arrive twice, and each computer
//! judged copies, retractions and duplicates from its own view. That is how payments went missing, doubled,
//! and were deleted while another computer had booked them. Jack chose "One link per account", and: "the one
//! time link should link to anyone who has finacial access. so my acocuntant and brother admin account can
//! see live feed from the card exactlyt how we have it setup."
//!
//! So each bank account has one feeding computer. Only that computer imports it; every other computer's link
//! for it stands by, and everyone with Financials sees the one feed through sync. Both facts live in the synced
//! `bank_feed` table (settings do not travel between computers): an `own:<account>` row names the feeding
//! computer, and a `seen:<account>:<device>` row is that computer's heartbeat for the account, written after the
//! account's bank pulled cleanly (at most hourly). A standby computer takes over after a day without one.
//!
//! An account is the bank (Plaid's institution name) plus the account's last four digits, from Plaid's own
//! fields, so two banks' cards ending in the same digits stay two accounts.

use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// A feeding computer with no clean pull of an account for this long is taken over by a standby one.
pub const TAKEOVER_HOURS: i64 = 24;

/// The account key: the bank and the last four digits (the account name when Plaid gives no mask).
pub fn account_key(institution: &str, account: &Value) -> String {
    let mask = account.get("mask").and_then(|v| v.as_str()).unwrap_or("").trim();
    let tail = if mask.is_empty() { account.get("name").and_then(|v| v.as_str()).unwrap_or("").trim() } else { mask };
    format!("{}|{}", institution.trim().to_lowercase(), tail.to_lowercase())
}

/// This computer's id (the sync node id) and a plain name for it.
pub fn device_id() -> String { crate::sync::node_id_hex() }
pub fn device_name() -> String {
    match std::env::consts::OS {
        "macos" => "Mac".into(),
        "windows" => std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty())
            .map(|n| format!("Windows PC ({n})")).unwrap_or_else(|| "Windows PC".into()),
        other => other.to_string(),
    }
}

/// One account a computer's bank links serve: its key, its label, and the Plaid account id on this computer.
#[derive(Clone, Debug)]
pub struct Account { pub key: String, pub label: String, pub plaid_id: String, pub item: String }

/// Every depository or credit account this computer's links serve.
pub fn my_accounts(conn: &Connection) -> Vec<Account> {
    let items: Vec<(String, String, String)> = conn
        .prepare("SELECT id, COALESCE(institution,''), COALESCE(accounts_json,'[]') FROM plaid_items")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|it| it.filter_map(|x| x.ok()).collect()))
        .unwrap_or_default();
    let mut out = Vec::new();
    for (item, inst, aj) in items {
        for a in serde_json::from_str::<Vec<Value>>(&aj).unwrap_or_default() {
            if !matches!(a.get("type").and_then(|v| v.as_str()), Some("depository") | Some("credit")) { continue; }
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let mask = a.get("mask").and_then(|v| v.as_str()).unwrap_or("");
            out.push(Account {
                key: account_key(&inst, &a),
                label: if mask.is_empty() { name.to_string() } else { format!("{} \u{00b7}\u{00b7}{}", name, mask) },
                plaid_id: a.get("account_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                item: item.clone(),
            });
        }
    }
    out
}

fn row(conn: &Connection, id: &str) -> Option<(String, String, String)> {
    conn.query_row("SELECT COALESCE(device,''), COALESCE(device_name,''), COALESCE(at,'') FROM bank_feed WHERE id=?1",
        [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok()
}

fn write(conn: &Connection, id: &str, kind: &str, key: &str, label: &str, at: &str) -> Result<(), String> {
    let (device, name) = (device_id(), device_name());
    let mut c = Map::new();
    for (k, v) in [("kind", kind), ("account_key", key), ("label", label), ("device", device.as_str()),
                   ("device_name", name.as_str()), ("at", at), ("updated_at", at)] {
        c.insert(k.into(), Value::String(v.to_string()));
    }
    crate::sync::record_upsert("bank_feed", id, c).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO bank_feed (id, kind, account_key, label, device, device_name, at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) \
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, account_key=excluded.account_key, label=excluded.label, \
           device=excluded.device, device_name=excluded.device_name, at=excluded.at, updated_at=excluded.updated_at",
        rusqlite::params![id, kind, key, label, device, name, at]).map_err(|e| e.to_string())?;
    Ok(())
}

fn owner_id(key: &str) -> String { format!("own:{key}") }
fn seen_id(key: &str, device: &str) -> String { format!("seen:{key}:{device}") }

fn parse(at: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> { chrono::DateTime::parse_from_rfc3339(at).ok() }

/// Record that this computer pulled the account cleanly just now (at most hourly).
pub fn heartbeat(conn: &Connection, key: &str, label: &str) {
    let now = chrono::Utc::now();
    let id = seen_id(key, &device_id());
    let fresh = row(conn, &id).and_then(|r| parse(&r.2)).is_some_and(|t| now.signed_duration_since(t) < chrono::Duration::hours(1));
    if !fresh { let _ = write(conn, &id, "seen", key, label, &now.to_rfc3339()); }
}

/// Make this computer the one that feeds an account, with a heartbeat so the other computer sees it alive.
pub fn take_over(conn: &Connection, key: &str, label: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    write(conn, &owner_id(key), "owner", key, label, &now)?;
    write(conn, &seen_id(key, &device_id()), "seen", key, label, &now)
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Decision { Feed, Claim, Standby }

/// Pure decision for one account.
/// - `owner_device`: the recorded feeding computer, if any;
/// - `owner_silent_hours`: hours since the later of its last clean pull of the account and its claim;
/// - `pulled_ok`: this computer's pull from the server worked, so it sees every claim made elsewhere.
/// With no owner and no successful pull, this computer imports as before but claims nothing.
pub fn decide(owner_device: Option<&str>, me: &str, owner_silent_hours: i64, pulled_ok: bool) -> Decision {
    match owner_device {
        Some(d) if d == me => Decision::Feed,
        Some(_) if pulled_ok && owner_silent_hours >= TAKEOVER_HOURS => Decision::Claim,
        Some(_) => Decision::Standby,
        None if pulled_ok => Decision::Claim,
        None => Decision::Feed,
    }
}

/// What this pull may import: the accounts this computer feeds (by key), the takeovers it made (for a catch-up
/// check), a sentence for each takeover for the bank health strip, and the accounts this computer feeds but has
/// not pulled for a day while it cannot reach the server (`paused`): the other computer may have taken them over,
/// so their bank waits, cursor unmoved, until this computer can see.
pub struct Fed { pub keys: HashSet<String>, pub took_over: Vec<String>, pub notes: Vec<String>, pub paused: HashSet<String> }

pub fn decide_all(conn: &Connection, mine: &[Account], pulled_ok: bool) -> Fed {
    let me = device_id();
    let now = chrono::Utc::now();
    let mut fed = Fed { keys: HashSet::new(), took_over: Vec::new(), notes: Vec::new(), paused: HashSet::new() };
    let mut labels: HashMap<&str, &str> = HashMap::new();
    for a in mine { labels.entry(a.key.as_str()).or_insert(a.label.as_str()); }
    for (key, label) in labels {
        let owner = row(conn, &owner_id(key)).filter(|o| !o.0.is_empty());
        let silent = owner.as_ref().map(|o| {
            let beat = row(conn, &seen_id(key, &o.0)).and_then(|s| parse(&s.2));
            let claimed = parse(&o.2);
            let last = match (beat, claimed) { (Some(b), Some(c)) => Some(b.max(c)), (b, c) => b.or(c) };
            last.map_or(i64::MAX, |t| now.signed_duration_since(t).num_hours())
        }).unwrap_or(0);
        match decide(owner.as_ref().map(|o| o.0.as_str()), &me, silent, pulled_ok) {
            Decision::Feed if owner.is_some() && !pulled_ok && silent >= TAKEOVER_HOURS => { fed.paused.insert(key.to_string()); }
            Decision::Feed => { fed.keys.insert(key.to_string()); }
            Decision::Claim => {
                if take_over(conn, key, label).is_ok() {
                    if let Some(o) = &owner {
                        fed.took_over.push(key.to_string());
                        let who = if o.1.is_empty() { "the other computer" } else { o.1.as_str() };
                        fed.notes.push(format!("This computer now brings in {label}: {who} has not pulled it from the bank for a day."));
                    }
                    fed.keys.insert(key.to_string());
                }
            }
            Decision::Standby => {}
        }
    }
    fed
}

/// The accounts this computer may judge and import without claiming anything: those it feeds, and those nobody
/// feeds yet. Check against bank reads this; only a bank pull that reached the server claims an account.
pub fn fed_keys_readonly(conn: &Connection, mine: &[Account]) -> HashSet<String> {
    let me = device_id();
    mine.iter()
        .filter(|a| row(conn, &owner_id(&a.key)).filter(|o| !o.0.is_empty()).map_or(true, |o| o.0 == me))
        .map(|a| a.key.clone()).collect()
}

/// Each account this computer's links serve, who feeds it, and when that computer last pulled it cleanly.
pub fn report(conn: &Connection, mine: &[Account]) -> Vec<Value> {
    let me = device_id();
    let mut seen_keys = HashSet::new();
    let mut out = Vec::new();
    for a in mine {
        if !seen_keys.insert(a.key.clone()) { continue; }
        let owner = row(conn, &owner_id(&a.key)).filter(|o| !o.0.is_empty());
        let last = owner.as_ref().and_then(|o| row(conn, &seen_id(&a.key, &o.0))).map(|s| s.2);
        out.push(json!({
            "key": a.key, "label": a.label,
            "here": owner.as_ref().is_some_and(|o| o.0 == me),
            "set": owner.is_some(),
            "owner_name": owner.as_ref().map(|o| o.1.clone()).unwrap_or_default(),
            "last_pull": last,
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_account_is_its_bank_and_its_last_four() {
        let checking = json!({ "mask": "1234", "name": "Checking" });
        let card = json!({ "mask": "1234", "name": "Card" });
        assert_eq!(account_key("Sample Bank", &checking), "sample bank|1234");
        assert_ne!(account_key("Sample Bank", &checking), account_key("Other Card Co", &card), "same digits, two banks");
        assert_eq!(account_key("Sample Bank", &json!({ "name": "Savings" })), "sample bank|savings");
    }

    #[test]
    fn one_computer_feeds_and_the_other_stands_by() {
        assert_eq!(decide(Some("mac"), "mac", 0, true), Decision::Feed);
        assert_eq!(decide(Some("mac"), "pc", 2, true), Decision::Standby);
        assert_eq!(decide(Some("mac"), "pc", 23, true), Decision::Standby);
    }

    #[test]
    fn a_silent_feeding_computer_is_taken_over_after_a_day_but_only_with_a_fresh_view() {
        assert_eq!(decide(Some("mac"), "pc", 24, true), Decision::Claim);
        assert_eq!(decide(Some("mac"), "pc", i64::MAX, true), Decision::Claim);
        assert_eq!(decide(Some("mac"), "pc", 48, false), Decision::Standby, "a failed pull may hide a newer claim");
    }

    #[test]
    fn with_no_feed_set_a_computer_claims_after_a_good_pull_and_imports_meanwhile() {
        assert_eq!(decide(None, "mac", 0, true), Decision::Claim);
        assert_eq!(decide(None, "mac", 0, false), Decision::Feed, "never skip an account nobody feeds");
    }

    #[test]
    fn two_computers_converge_on_one_owner_through_the_synced_rows() {
        let _db = crate::db::init_test_store();
        let c = crate::db::pool().get().unwrap();
        c.execute("DELETE FROM bank_feed WHERE account_key='testbank|0001'", []).unwrap();
        let mine = vec![Account { key: "testbank|0001".into(), label: "Test ··0001".into(), plaid_id: "p1".into(), item: "i1".into() }];
        // Another computer claimed it an hour ago and pulled it cleanly.
        let hour_ago = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        for (id, kind) in [("own:testbank|0001", "owner"), ("seen:testbank|0001:other", "seen")] {
            c.execute("INSERT INTO bank_feed (id, kind, account_key, label, device, device_name, at, updated_at) VALUES (?1,?2,'testbank|0001','Test','other','Mac',?3,?3)",
                rusqlite::params![id, kind, hour_ago]).unwrap();
        }
        let fed = decide_all(&c, &mine, true);
        assert!(fed.keys.is_empty(), "this computer stands by");
        // A day and more of silence: this computer takes over and says so.
        let old = (chrono::Utc::now() - chrono::Duration::hours(30)).to_rfc3339();
        c.execute("UPDATE bank_feed SET at=?1 WHERE account_key='testbank|0001'", [&old]).unwrap();
        let fed = decide_all(&c, &mine, true);
        assert!(fed.keys.contains("testbank|0001"));
        assert_eq!(fed.took_over, vec!["testbank|0001".to_string()]);
        assert_eq!(fed.notes.len(), 1);
        let owner: String = c.query_row("SELECT device FROM bank_feed WHERE id='own:testbank|0001'", [], |r| r.get(0)).unwrap();
        assert_eq!(owner, device_id());
        c.execute("DELETE FROM bank_feed WHERE account_key='testbank|0001'", []).unwrap();
    }

    // R-590: a feeding computer back after days away, that cannot reach the server, waits; and a check never claims.
    #[test]
    fn an_away_feeder_without_the_server_waits_and_a_check_never_claims() {
        let _db = crate::db::init_test_store();
        let c = crate::db::pool().get().unwrap();
        c.execute("DELETE FROM bank_feed WHERE account_key IN ('testbank|0002','testbank|0003')", []).unwrap();
        let me = device_id();
        let old = (chrono::Utc::now() - chrono::Duration::hours(60)).to_rfc3339();
        c.execute("INSERT INTO bank_feed (id, kind, account_key, label, device, device_name, at, updated_at) VALUES ('own:testbank|0002','owner','testbank|0002','Test',?1,'Mac',?2,?2)",
            rusqlite::params![me, old]).unwrap();
        c.execute("INSERT INTO bank_feed (id, kind, account_key, label, device, device_name, at, updated_at) VALUES ('own:testbank|0003','owner','testbank|0003','Test','other','PC',?1,?1)",
            [&old]).unwrap();
        let mine = vec![
            Account { key: "testbank|0002".into(), label: "Test ··0002".into(), plaid_id: "p2".into(), item: "i2".into() },
            Account { key: "testbank|0003".into(), label: "Test ··0003".into(), plaid_id: "p3".into(), item: "i3".into() },
        ];
        let fed = decide_all(&c, &mine, false);
        assert!(fed.paused.contains("testbank|0002") && !fed.keys.contains("testbank|0002"), "away and blind: wait");
        assert!(!fed.keys.contains("testbank|0003") && fed.took_over.is_empty(), "no takeover without the server");
        let ro = fed_keys_readonly(&c, &mine);
        assert!(ro.contains("testbank|0002") && !ro.contains("testbank|0003"));
        let owner: String = c.query_row("SELECT device FROM bank_feed WHERE id='own:testbank|0003'", [], |r| r.get(0)).unwrap();
        assert_eq!(owner, "other", "the check and a blind pull wrote nothing");
        let fed = decide_all(&c, &mine, true);
        assert!(fed.keys.contains("testbank|0002"), "with the server, its own account feeds again");
        c.execute("DELETE FROM bank_feed WHERE account_key IN ('testbank|0002','testbank|0003')", []).unwrap();
    }
}
