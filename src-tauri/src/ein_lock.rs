//! R-668: the company EIN, kept encrypted under a password only the owner knows.
//!
//! The password is never stored anywhere. It is stretched with PBKDF2-HMAC-SHA256
//! (600,000 rounds, a fresh random 16-byte salt per save) into a 256-bit key, and the
//! EIN is sealed with AES-256-GCM. What is stored, in the synced `ein_locked` setting,
//! is only that sealed blob:
//!
//!   {"v":1,"iter":600000,"salt":b64,"iv":b64,"ct":b64}   (ct = ciphertext + 16-byte tag)
//!
//! The phone (`clienthub-api/www/app.js`, `einSeal`/`einOpen`) does the same with
//! WebCrypto, so a blob sealed on one opens on the other. AES-GCM rather than the
//! ChaCha20 the rest of this app uses because WebCrypto has no ChaCha20.
//!
//! Once a lock exists, the plain `company_info.tax_id` is kept empty: `save_company_info`
//! drops it, and the server strips it too, so the EIN no longer prints on invoices.

use anyhow::{anyhow, Result};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const SETTING_KEY: &str = "ein_locked";
const ITER: u32 = 600_000;
const MAX_ITER: u32 = 5_000_000;
const MIN_PASSWORD: usize = 10;

#[derive(Serialize, Deserialize)]
struct Blob {
    v: u32,
    iter: u32,
    salt: String,
    iv: String,
    ct: String,
}

fn b64e(b: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b)
}
fn b64d(s: &str) -> Result<Vec<u8>> {
    Ok(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s)?)
}

fn key_for(password: &str, salt: &[u8], iter: u32) -> Result<LessSafeKey> {
    let mut k = [0u8; 32];
    let rounds = NonZeroU32::new(iter).ok_or_else(|| anyhow!("bad rounds"))?;
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, rounds, salt, password.as_bytes(), &mut k);
    let unbound = UnboundKey::new(&AES_256_GCM, &k).map_err(|_| anyhow!("bad key"))?;
    Ok(LessSafeKey::new(unbound))
}

/// "12-3456789" from any 9 digits, with or without the dash or spaces. None otherwise.
pub fn normalize_ein(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    let rest_ok = raw.chars().all(|c| c.is_ascii_digit() || c == '-' || c == ' ');
    if digits.len() != 9 || !rest_ok {
        return None;
    }
    Some(format!("{}-{}", &digits[..2], &digits[2..]))
}

pub fn seal(ein: &str, password: &str) -> Result<String> {
    let rng = SystemRandom::new();
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    rng.fill(&mut salt).map_err(|_| anyhow!("rng failed"))?;
    rng.fill(&mut iv).map_err(|_| anyhow!("rng failed"))?;
    let key = key_for(password, &salt, ITER)?;
    let mut buf = ein.as_bytes().to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut buf)
        .map_err(|_| anyhow!("encrypt failed"))?;
    Ok(serde_json::to_string(&Blob { v: 1, iter: ITER, salt: b64e(&salt), iv: b64e(&iv), ct: b64e(&buf) })?)
}

/// The EIN, or an error that reads "wrong password" when the tag does not verify.
pub fn open(blob: &str, password: &str) -> Result<String> {
    let b: Blob = serde_json::from_str(blob).map_err(|_| anyhow!("The saved EIN is unreadable."))?;
    if b.v != 1 || b.iter < ITER || b.iter > MAX_ITER {
        return Err(anyhow!("The saved EIN is unreadable."));
    }
    let salt = b64d(&b.salt)?;
    let iv: [u8; 12] = b64d(&b.iv)?.try_into().map_err(|_| anyhow!("The saved EIN is unreadable."))?;
    let mut buf = b64d(&b.ct)?;
    let key = key_for(password, &salt, b.iter)?;
    let plain = key
        .open_in_place(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut buf)
        .map_err(|_| anyhow!("wrong password"))?;
    Ok(String::from_utf8(plain.to_vec())?)
}

// ── Wrong-password throttle ─────────────────────────────────────────────────────
// Five misses in a row, then a wait that doubles each further miss (30 s up to 15 min).
// Held in this process, so typing at the screen cannot be hammered; the real protection
// against someone who copies the blob is the 600,000 rounds and the password's length.
static FAILS: Mutex<(u32, Option<Instant>)> = Mutex::new((0, None));

fn throttle_check() -> Result<(), String> {
    let g = FAILS.lock().unwrap();
    if let Some(until) = g.1 {
        let now = Instant::now();
        if until > now {
            let secs = (until - now).as_secs().max(1);
            return Err(format!("Too many wrong tries. Wait {secs} seconds and try again."));
        }
    }
    Ok(())
}
fn throttle_miss() {
    let mut g = FAILS.lock().unwrap();
    g.0 += 1;
    if g.0 >= 5 {
        let secs = (30u64 << (g.0 - 5).min(5)).min(900);
        g.1 = Some(Instant::now() + Duration::from_secs(secs));
    }
}
fn throttle_ok() {
    *FAILS.lock().unwrap() = (0, None);
}

fn read_blob() -> Option<String> {
    let conn = crate::db::pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key=?1", [SETTING_KEY], |r| r.get::<_, String>(0))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

pub fn is_locked() -> bool {
    read_blob().is_some()
}

/// Run the slow key stretch off the async runtime, mapping a wrong password onto the throttle.
async fn open_checked(blob: String, password: String) -> Result<String, String> {
    throttle_check()?;
    let r = tokio::task::spawn_blocking(move || open(&blob, &password))
        .await
        .map_err(|e| e.to_string())?;
    match r {
        Ok(ein) => {
            throttle_ok();
            Ok(ein)
        }
        Err(e) if e.to_string() == "wrong password" => {
            throttle_miss();
            Err("That password is not right.".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
pub struct EinLockStatus {
    pub locked: bool,
    /// The EIN still sits in plain text in Company information.
    pub plain: Option<String>,
}

#[tauri::command]
pub async fn ein_lock_status() -> Result<EinLockStatus, String> {
    let locked = is_locked();
    let plain = if locked {
        None
    } else {
        crate::commands::get_company_info().await?.and_then(|c| c.tax_id).filter(|t| !t.trim().is_empty())
    };
    Ok(EinLockStatus { locked, plain })
}

#[tauri::command]
pub async fn ein_lock_open(password: String) -> Result<String, String> {
    let blob = read_blob().ok_or("No EIN is saved yet.")?;
    open_checked(blob, password).await
}

/// Save (or replace) the locked EIN. Replacing with `current` checks that password first.
/// `current: None` is "Forgot the password": the old sealed copy is kept on this computer
/// as `ein_locked_prev` (never synced, still sealed) before the new one replaces it, so
/// starting over never destroys anything. After sealing, the blob is opened again and
/// compared before anything is written, and only then is the plain copy emptied.
#[tauri::command]
pub async fn ein_lock_save(ein: String, password: String, current: Option<String>) -> Result<(), String> {
    let ein = normalize_ein(&ein).ok_or("An EIN is 9 digits, like 12-3456789.")?;
    if password.chars().count() < MIN_PASSWORD {
        return Err(format!("Use a password of at least {MIN_PASSWORD} characters."));
    }
    if let Some(old) = read_blob() {
        match current {
            Some(cur) => {
                open_checked(old, cur).await.map_err(|e| {
                    if e == "That password is not right." { "Your current EIN password is not right.".to_string() } else { e }
                })?;
            }
            None => {
                let conn = crate::db::pool().get().map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO settings (key,value) VALUES ('ein_locked_prev',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    [old],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    let (blob, check) = {
        let (ein, password) = (ein.clone(), password.clone());
        tokio::task::spawn_blocking(move || -> Result<(String, String)> {
            let blob = seal(&ein, &password)?;
            let check = open(&blob, &password)?;
            Ok((blob, check))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
    };
    if check != ein {
        return Err("The EIN did not lock correctly. Nothing was changed.".into());
    }
    let conn = crate::db::pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![SETTING_KEY, blob],
    )
    .map_err(|e| e.to_string())?;
    // The locked copy is written and verified; now the plain one goes.
    conn.execute(
        "UPDATE settings SET value=json_set(value,'$.tax_id',NULL)
         WHERE key='company_info' AND json_valid(value) AND COALESCE(json_extract(value,'$.tax_id'),'')<>''",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens() {
        let b = seal("12-3456789", "correct horse battery").unwrap();
        assert_eq!(open(&b, "correct horse battery").unwrap(), "12-3456789");
        assert_eq!(open(&b, "wrong password!!").unwrap_err().to_string(), "wrong password");
        assert!(!b.contains("3456789"));
        println!("DESKTOP_BLOB {b}"); // opened by the phone code in the R-668 check
    }

    #[test]
    fn opens_a_blob_sealed_by_the_phone() {
        // Made by the phone's einSeal (WebCrypto) in Node: EIN 98-7654321, password "phone-made-pass".
        let blob = include_str!("ein_lock_webcrypto_vector.json");
        assert_eq!(open(blob.trim(), "phone-made-pass").unwrap(), "98-7654321");
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize_ein("123456789").as_deref(), Some("12-3456789"));
        assert_eq!(normalize_ein("12-3456789").as_deref(), Some("12-3456789"));
        assert_eq!(normalize_ein("12 345 6789").as_deref(), Some("12-3456789"));
        assert!(normalize_ein("12345678").is_none());
        assert!(normalize_ein("12-345678a9").is_none());
    }
}
