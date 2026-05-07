use anyhow::{anyhow, Result};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

const SALT_KEY: &str = "sync_salt";
const PASSPHRASE_CRED_KEY: &str = "sync_passphrase";
const PBKDF2_ITERATIONS: NonZeroU32 = NonZeroU32::new(100_000).unwrap();

#[derive(Serialize, Deserialize)]
struct EncryptedWrapper {
    data: String,
}

fn get_or_create_salt() -> Result<Vec<u8>> {
    let conn = crate::db::pool().get()?;
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [SALT_KEY],
            |r| r.get(0),
        )
        .ok();
    if let Some(s) = existing {
        return base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &s)
            .map_err(|e| anyhow!("bad salt: {}", e));
    }
    let mut salt = vec![0u8; 32];
    SystemRandom::new()
        .fill(&mut salt)
        .map_err(|_| anyhow!("rng failed"))?;
    let encoded =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &salt);
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?1,?2)",
        rusqlite::params![SALT_KEY, encoded],
    )?;
    Ok(salt)
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        PBKDF2_ITERATIONS,
        salt,
        passphrase.as_bytes(),
        &mut key,
    );
    key
}

fn make_key() -> Result<LessSafeKey> {
    let passphrase = crate::email::cred(PASSPHRASE_CRED_KEY)?;
    let salt = get_or_create_salt()?;
    let key_bytes = derive_key(&passphrase, &salt);
    let unbound =
        UnboundKey::new(&CHACHA20_POLY1305, &key_bytes).map_err(|_| anyhow!("invalid key"))?;
    Ok(LessSafeKey::new(unbound))
}

pub fn is_encryption_enabled() -> bool {
    crate::email::cred_opt(PASSPHRASE_CRED_KEY).is_some()
}

pub fn set_passphrase(passphrase: &str) -> Result<()> {
    get_or_create_salt()?;
    crate::email::save_cred(PASSPHRASE_CRED_KEY, passphrase)?;
    Ok(())
}

pub fn encrypt_event(json_bytes: &[u8]) -> Result<Vec<u8>> {
    let key = make_key()?;
    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| anyhow!("rng failed"))?;

    let mut buf = json_bytes.to_vec();
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut buf)
        .map_err(|_| anyhow!("encryption failed"))?;

    let mut result = nonce_bytes.to_vec();
    result.extend_from_slice(&buf);
    Ok(result)
}

pub fn decrypt_event(encrypted_bytes: &[u8]) -> Result<Vec<u8>> {
    if encrypted_bytes.len() < 12 {
        anyhow::bail!("encrypted data too short");
    }
    let key = make_key()?;
    let nonce_bytes: [u8; 12] = encrypted_bytes[..12].try_into().unwrap();
    let mut buf = encrypted_bytes[12..].to_vec();

    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let plaintext = key
        .open_in_place(nonce, Aad::empty(), &mut buf)
        .map_err(|_| anyhow!("decryption failed — wrong passphrase or corrupted data"))?;

    Ok(plaintext.to_vec())
}

pub fn encrypt_to_wrapper(json_bytes: &[u8]) -> Result<String> {
    let encrypted = encrypt_event(json_bytes)?;
    let encoded =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &encrypted);
    let wrapper = EncryptedWrapper { data: encoded };
    Ok(serde_json::to_string(&wrapper)?)
}

pub fn decrypt_from_wrapper(wrapper_json: &str) -> Result<Vec<u8>> {
    let wrapper: EncryptedWrapper = serde_json::from_str(wrapper_json)?;
    let encrypted =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &wrapper.data)
            .map_err(|e| anyhow!("bad base64: {}", e))?;
    decrypt_event(&encrypted)
}
