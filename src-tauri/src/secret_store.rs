//! App-local encrypted secret store — a TEMPORARY replacement for OS-keyring reads
//! so an ad-hoc-signed build stops re-prompting for macOS keychain access on every
//! update. Secrets are ChaCha20-Poly1305-encrypted (ring, same primitive as
//! sync_crypto.rs) under a random 32-byte key kept in the app-data ROOT. Neither the
//! key nor the store lives under the synced folder, so secrets never enter the oplog.
//!
//! SECURITY TRADEOFF (deliberate, interim): this is weaker than the OS keychain — the
//! key file sits on disk readable by any process running as the same user, with no
//! login-session binding. It is an explicit stopgap to kill the ad-hoc-signing prompt
//! storm; the permanent fix is Developer ID signing, after which the keyring path can
//! be restored. Migration is non-destructive: on any file/key error, callers fall
//! back to the still-intact keyring (see email.rs), so nothing is ever lost.

use anyhow::{anyhow, Result};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

fn key_path() -> PathBuf { crate::db::app_root_dir().join("secrets.key") }
fn enc_path() -> PathBuf { crate::db::app_root_dir().join("secrets.enc") }

/// The machine-local 32-byte file key — generated once, cached for the process.
fn store_key() -> Result<[u8; 32]> {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    if let Some(k) = KEY.get() { return Ok(*k); }
    let path = key_path();
    let bytes = if path.exists() {
        let raw = std::fs::read(&path)?;
        if raw.len() != 32 { return Err(anyhow!("bad key length")); }
        let mut k = [0u8; 32]; k.copy_from_slice(&raw); k
    } else {
        let mut k = [0u8; 32];
        SystemRandom::new().fill(&mut k).map_err(|_| anyhow!("rng failed"))?;
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        std::fs::write(&path, k)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        k
    };
    let _ = KEY.set(bytes);
    Ok(bytes)
}

fn aead_key() -> Result<LessSafeKey> {
    let kb = store_key()?;
    let unbound = UnboundKey::new(&CHACHA20_POLY1305, &kb).map_err(|_| anyhow!("invalid key"))?;
    Ok(LessSafeKey::new(unbound))
}

fn enc_value(plain: &str) -> Result<String> {
    let key = aead_key()?;
    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new().fill(&mut nonce_bytes).map_err(|_| anyhow!("rng failed"))?;
    let mut buf = plain.as_bytes().to_vec();
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut buf).map_err(|_| anyhow!("encrypt failed"))?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&buf);
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &out))
}

fn dec_value(encoded: &str) -> Result<String> {
    let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)?;
    if raw.len() < 12 { return Err(anyhow!("too short")); }
    let key = aead_key()?;
    let nonce_bytes: [u8; 12] = raw[..12].try_into().unwrap();
    let mut buf = raw[12..].to_vec();
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let plain = key.open_in_place(nonce, Aad::empty(), &mut buf).map_err(|_| anyhow!("decrypt failed"))?;
    Ok(String::from_utf8(plain.to_vec())?)
}

fn load_map() -> HashMap<String, String> {
    std::fs::read_to_string(enc_path()).ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

fn save_map(map: &HashMap<String, String>) -> Result<()> {
    let path = enc_path();
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    let json = serde_json::to_string(map)?;
    let tmp = path.with_extension("enc.tmp");
    std::fs::write(&tmp, json.as_bytes())?;
    // rename-over-existing fails on Windows; remove the destination first.
    #[cfg(windows)]
    { let _ = std::fs::remove_file(&path); }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Read a secret. None on any miss/error so callers fall back to the keyring.
pub fn get(key: &str) -> Option<String> {
    let map = load_map();
    let enc = map.get(key)?;
    dec_value(enc).ok()
}

pub fn put(key: &str, value: &str) -> Result<()> {
    let mut map = load_map();
    map.insert(key.to_string(), enc_value(value)?);
    save_map(&map)
}

pub fn remove(key: &str) -> Result<()> {
    let mut map = load_map();
    map.remove(key);
    save_map(&map)
}
