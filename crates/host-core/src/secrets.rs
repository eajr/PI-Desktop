use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rng, Rng};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

mod master_key;
mod private_fs;

pub use master_key::KeyLocation;
pub(crate) use private_fs::{create_private_dir_all, restrict_existing_dir};

use master_key::{BlobCheck, KeyVault, MasterKey};

pub struct SecretStore {
    dir: PathBuf,
    /// `None` while the master key's credential store is unreachable: blobs
    /// stay on disk, reads and writes fail instead of re-keying.
    key: Option<[u8; 32]>,
    location: Option<KeyLocation>,
}

impl SecretStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        Self::open_with_vault(data_dir, master_key::default_vault().as_ref())
    }

    pub(crate) fn open_with_vault(data_dir: &Path, vault: &dyn KeyVault) -> Result<Self> {
        let dir = data_dir.join("secrets");
        private_fs::create_private_dir_all(&dir)?;
        // Directories created by earlier builds used the process umask.
        if let Err(error) = private_fs::restrict_existing_dir(&dir) {
            tracing::warn!(%error, "could not restrict the secrets directory to its owner");
        }
        let verify = |key: &[u8; 32]| check_blobs(&dir, key);
        let (key, location) = match master_key::resolve(&dir, vault, &verify)? {
            MasterKey::Ready { key, location } => (Some(key), Some(location)),
            MasterKey::Locked => (None, None),
        };
        let store = Self { dir, key, location };
        match store.location {
            Some(location) => tracing::info!(?location, "secret store opened"),
            None => tracing::warn!("secret store opened locked"),
        }
        Ok(store)
    }

    /// Where the master key currently lives; `None` while it is unreachable.
    #[cfg(test)]
    pub fn key_location(&self) -> Option<KeyLocation> {
        self.location
    }

    /// AES-256-GCM under the master key.
    ///
    /// `Key<Aes256Gcm>` is exactly the 32 bytes `self.key` holds, so the only
    /// failure is a master key whose credential store is unreachable.
    fn cipher(&self) -> Result<Aes256Gcm> {
        let key = self.key.ok_or_else(|| {
            anyhow!(
                "secret store is locked: the OS credential store holding its key is unavailable"
            )
        })?;
        Ok(Aes256Gcm::new(&key.into()))
    }

    fn path_for(&self, secret_ref: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(secret_ref.as_bytes());
        let hash = hex::encode(hasher.finalize());
        self.dir.join(format!("{hash}.bin"))
    }

    pub fn set(&self, secret_ref: &str, value: &str) -> Result<String> {
        let cipher = self.cipher()?;
        let mut nonce_bytes = [0u8; 12];
        rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from(nonce_bytes);
        let ciphertext = cipher
            .encrypt(&nonce, value.as_bytes())
            .map_err(|e| anyhow!("encrypt failed: {e}"))?;
        let mut blob = Vec::with_capacity(12 + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        private_fs::write_private_file_atomic(
            &self.path_for(secret_ref),
            B64.encode(blob).as_bytes(),
        )?;
        Ok("file_fallback".into())
    }

    pub fn get(&self, secret_ref: &str) -> Result<Option<String>> {
        let path = self.path_for(secret_ref);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(path)?;
        let plain = decrypt_blob(&self.cipher()?, &raw)?;
        Ok(Some(String::from_utf8(plain)?))
    }

    pub fn has(&self, secret_ref: &str) -> bool {
        self.path_for(secret_ref).exists()
    }

    pub fn delete(&self, secret_ref: &str) -> Result<()> {
        let path = self.path_for(secret_ref);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

fn decrypt_blob(cipher: &Aes256Gcm, raw: &str) -> Result<Vec<u8>> {
    let blob = B64.decode(raw.trim()).context("decode secret blob")?;
    if blob.len() < 13 {
        return Err(anyhow!("secret blob too short"));
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let nonce =
        Nonce::try_from(nonce_bytes).map_err(|_| anyhow!("secret nonce is not 12 bytes"))?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|e| anyhow!("decrypt failed: {e}"))
}

/// Whether any blob under `dir` authenticates under `key`. Read-only; used to
/// prove a migrated key before the legacy key file is given up.
fn check_blobs(dir: &Path, key: &[u8; 32]) -> BlobCheck {
    // An unreadable directory proves nothing, so it never passes.
    let Ok(entries) = fs::read_dir(dir) else {
        return BlobCheck::Fails;
    };
    let cipher = Aes256Gcm::new(&(*key).into());
    let mut saw_blob = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "bin") {
            continue;
        }
        saw_blob = true;
        if let Ok(raw) = fs::read_to_string(&path) {
            if decrypt_blob(&cipher, &raw).is_ok() {
                return BlobCheck::Decrypts;
            }
        }
    }
    if saw_blob {
        BlobCheck::Fails
    } else {
        BlobCheck::NoBlobs
    }
}

pub fn secret_ref_for_provider(provider_id: &str) -> String {
    format!("secret:provider:{provider_id}:api_key")
}

/// Where a vendor-account OAuth credential lives. Kept separate from the API
/// key ref so a provider can hold both without one overwriting the other, and
/// so the API-key read path can never hand a refresh token to the runtime.
pub fn secret_ref_for_provider_oauth(provider_id: &str) -> String {
    format!("secret:provider:{provider_id}:oauth")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The on-disk layout is `base64(nonce ‖ ciphertext ‖ tag)` under a raw
    /// 32-byte machine key, and the filename is `sha256(secret_ref)`. Users have
    /// live provider API keys stored that way, so a crypto-crate bump that
    /// changed any of it would silently lock every one of them out — a round-trip
    /// test cannot catch that, because it would change both sides at once.
    ///
    /// This vector was produced by an independent implementation (Node's
    /// `crypto`), so it pins the format rather than our own behaviour.
    #[test]
    fn decrypts_a_secret_written_by_an_earlier_build() {
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        let dir = tempfile::tempdir().expect("tempdir");
        let secrets_dir = dir.path().join("secrets");
        fs::create_dir_all(&secrets_dir).expect("create secrets dir");
        fs::write(secrets_dir.join(".machine-key"), key).expect("write machine key");
        fs::write(
            secrets_dir
                .join("98c9443fcbc5c60d4da31a04e6cf07028f6144cbfbdb0fd7b86f2e19b463280d.bin"),
            "CwoJCAcGBQQDAgEAU5Z0dF8QGeiN27cNAqFSeAYGwMXktbI1htFNv2eSmf0=",
        )
        .expect("write secret blob");

        let store = SecretStore::open(dir.path()).expect("open store");
        let secret_ref = secret_ref_for_provider("openai");
        assert!(store.has(&secret_ref));
        assert_eq!(
            store.get(&secret_ref).expect("get secret"),
            Some("sk-fixture-value".to_string()),
        );
    }

    #[test]
    fn rejects_a_blob_whose_tag_does_not_authenticate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let secret_ref = secret_ref_for_provider("anthropic");
        store.set(&secret_ref, "sk-real-value").expect("set secret");

        let path = store.path_for(&secret_ref);
        let mut blob = B64
            .decode(fs::read_to_string(&path).expect("read blob").trim())
            .expect("decode blob");
        // Flip a ciphertext bit: GCM must fail authentication rather than hand
        // back a mangled key that would look like a provider auth failure.
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        fs::write(&path, B64.encode(blob)).expect("rewrite blob");

        assert!(store.get(&secret_ref).is_err());
    }

    #[test]
    fn each_write_uses_a_fresh_nonce() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let secret_ref = secret_ref_for_provider("openai");

        store.set(&secret_ref, "same-value").expect("first write");
        let first = fs::read_to_string(store.path_for(&secret_ref)).expect("read first");
        store.set(&secret_ref, "same-value").expect("second write");
        let second = fs::read_to_string(store.path_for(&secret_ref)).expect("read second");

        // Reusing a nonce under one key is the classic GCM break, so identical
        // plaintext must still produce different blobs.
        assert_ne!(first, second);
        assert_eq!(
            store.get(&secret_ref).expect("get secret"),
            Some("same-value".to_string()),
        );
    }

    #[test]
    fn oauth_and_api_key_refs_do_not_collide() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let api_key = secret_ref_for_provider("anthropic");
        let oauth = secret_ref_for_provider_oauth("anthropic");

        assert_eq!(oauth, "secret:provider:anthropic:oauth");
        store.set(&api_key, "sk-ant-api").expect("set api key");
        store
            .set(&oauth, "{\"type\":\"oauth\"}")
            .expect("set oauth credential");

        // A provider may hold both credentials at once, so storing one must
        // never clobber the other or leak across the two read paths.
        assert_eq!(
            store.get(&api_key).expect("get api key"),
            Some("sk-ant-api".to_string()),
        );
        assert_eq!(
            store.get(&oauth).expect("get oauth"),
            Some("{\"type\":\"oauth\"}".to_string()),
        );

        store.delete(&oauth).expect("delete oauth");
        assert!(!store.has(&oauth));
        assert!(store.has(&api_key));
    }
}
