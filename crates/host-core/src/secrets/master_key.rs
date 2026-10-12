//! Where the secret store's AES-256-GCM master key lives (ADR
//! secret-master-key-os-credential-store).
//!
//! The ciphertext blobs stay under `secrets/`; only the 32-byte master key
//! moves into the OS credential store (macOS Keychain, Windows Credential
//! Manager, Linux Secret Service). A same-user process that can read the data
//! directory therefore no longer finds the key beside the ciphertexts.
//!
//! `secrets/.keychain-account` names the credential-store account that holds
//! this data root's key. It is a random, non-secret identifier, so dev, prod
//! and test data roots never share a key, and a relocated copy of the data
//! root (which copies the marker) keeps finding its key.
//!
//! When no credential store is reachable the legacy `secrets/.machine-key`
//! file (owner-only) remains the key. That fallback is explicit, logged
//! without key material, and never discards an existing key.

use anyhow::{anyhow, Result};
use rand::{rng, Rng};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use super::private_fs;

/// Credential-store service name: the desktop application id.
pub(crate) const KEYCHAIN_SERVICE: &str = "net.aiuo.pi-desktop";
/// Legacy (and fallback) on-disk master key.
pub(crate) const FILE_KEY_NAME: &str = ".machine-key";
/// Names the credential-store account holding this data root's master key.
pub(crate) const ACCOUNT_MARKER_NAME: &str = ".keychain-account";
/// Set to `file` to keep the master key in `.machine-key` and never contact
/// the OS credential store (headless hosts, hermetic E2E profiles).
pub(crate) const KEY_STORE_ENV: &str = "PI_DESKTOP_SECRET_KEY_STORE";

const ACCOUNT_PREFIX: &str = "secret-master-key:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyLocation {
    OsCredentialStore,
    File,
}

/// Whether a candidate key opens the blobs already on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlobCheck {
    NoBlobs,
    Decrypts,
    Fails,
}

pub(crate) enum MasterKey {
    Ready {
        key: [u8; 32],
        location: KeyLocation,
    },
    /// The key lives in a credential store that cannot be reached right now
    /// and no file key exists. Secrets stay on disk untouched; reads and
    /// writes fail until the store is reachable again.
    Locked,
}

#[derive(Debug)]
pub(crate) enum VaultError {
    NoEntry,
    Unavailable(String),
}

/// The narrow credential-store surface the master key needs.
pub(crate) trait KeyVault {
    fn get(&self, account: &str) -> Result<Vec<u8>, VaultError>;
    fn set(&self, account: &str, key: &[u8]) -> Result<(), VaultError>;
    fn delete(&self, account: &str) -> Result<(), VaultError>;
}

/// The platform credential store through the `keyring` crate.
pub(crate) struct OsKeyVault;

/// A vault that is never reachable: forces the file-key fallback.
pub(crate) struct DisabledVault(pub &'static str);

impl KeyVault for DisabledVault {
    fn get(&self, _account: &str) -> Result<Vec<u8>, VaultError> {
        Err(VaultError::Unavailable(self.0.to_string()))
    }
    fn set(&self, _account: &str, _key: &[u8]) -> Result<(), VaultError> {
        Err(VaultError::Unavailable(self.0.to_string()))
    }
    fn delete(&self, _account: &str) -> Result<(), VaultError> {
        Err(VaultError::Unavailable(self.0.to_string()))
    }
}

/// Map a keyring failure; the reason never echoes payload bytes it carries.
fn classify(error: keyring::Error) -> VaultError {
    match error {
        keyring::Error::NoEntry => VaultError::NoEntry,
        other => VaultError::Unavailable(describe(&other)),
    }
}

fn describe(error: &keyring::Error) -> String {
    match error {
        keyring::Error::PlatformFailure(inner) => format!("platform failure: {inner}"),
        keyring::Error::NoStorageAccess(inner) => format!("no storage access: {inner}"),
        keyring::Error::NoDefaultStore => "no credential store is available".into(),
        keyring::Error::NotSupportedByStore(what) => format!("not supported by store: {what}"),
        _ => "unexpected credential store error".into(),
    }
}

impl OsKeyVault {
    /// Run one credential-store call on its own OS thread: the Secret Service
    /// client blocks on D-Bus and must not run on a tokio worker, and a panic
    /// inside a platform backend must surface as "unavailable", not abort.
    fn call<T: Send>(
        account: &str,
        op: impl FnOnce(&keyring::Entry) -> keyring::Result<T> + Send,
    ) -> Result<T, VaultError> {
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(classify)?;
                    op(&entry).map_err(classify)
                })
                .join()
                .unwrap_or_else(|_| {
                    Err(VaultError::Unavailable(
                        "credential store backend panicked".into(),
                    ))
                })
        })
    }
}

impl KeyVault for OsKeyVault {
    fn get(&self, account: &str) -> Result<Vec<u8>, VaultError> {
        Self::call(account, |entry| entry.get_secret())
    }
    fn set(&self, account: &str, key: &[u8]) -> Result<(), VaultError> {
        Self::call(account, |entry| entry.set_secret(key))
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        Self::call(account, |entry| entry.delete_credential())
    }
}

/// The vault `SecretStore::open` uses. Unit tests never touch the developer's
/// real credential store; `PI_DESKTOP_SECRET_KEY_STORE=file` opts out at runtime.
pub(crate) fn default_vault() -> Box<dyn KeyVault> {
    if cfg!(test) {
        return Box::new(DisabledVault("disabled in unit tests"));
    }
    match std::env::var(KEY_STORE_ENV) {
        Ok(value) if value == "file" => Box::new(DisabledVault(
            "file key store selected by PI_DESKTOP_SECRET_KEY_STORE",
        )),
        _ => Box::new(OsKeyVault),
    }
}

fn key_from(bytes: &[u8]) -> Option<[u8; 32]> {
    bytes.try_into().ok()
}

fn read_file_key(dir: &Path) -> Result<Option<[u8; 32]>> {
    match fs::read(dir.join(FILE_KEY_NAME)) {
        Ok(bytes) => key_from(&bytes)
            .map(Some)
            .ok_or_else(|| anyhow!("invalid machine key length")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

enum Marker {
    Absent,
    Account(String),
    Invalid,
}

fn read_marker(dir: &Path) -> Result<Marker> {
    match fs::read_to_string(dir.join(ACCOUNT_MARKER_NAME)) {
        Ok(text) => {
            let account = text.trim();
            let valid = account.len() <= 128
                && account.strip_prefix(ACCOUNT_PREFIX).is_some_and(|id| {
                    !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                });
            Ok(if valid {
                Marker::Account(account.to_string())
            } else {
                Marker::Invalid
            })
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Marker::Absent),
        Err(error) => Err(error.into()),
    }
}

fn write_marker(dir: &Path, account: &str) -> std::io::Result<()> {
    private_fs::write_private_file_atomic(&dir.join(ACCOUNT_MARKER_NAME), account.as_bytes())
}

/// Store `key` and read it back; a store that does not return the same bytes
/// is treated as unavailable and the half-written entry is removed.
fn store_and_confirm(vault: &dyn KeyVault, account: &str, key: &[u8; 32]) -> Result<(), String> {
    let outcome = match vault.set(account, key) {
        Ok(()) => match vault.get(account) {
            Ok(back) if back.as_slice() == key.as_slice() => return Ok(()),
            Ok(_) => "credential store returned a different key on read-back".to_string(),
            Err(VaultError::NoEntry) => "credential store lost the key on read-back".to_string(),
            Err(VaultError::Unavailable(reason)) => reason,
        },
        Err(VaultError::NoEntry) => "credential store rejected the key".to_string(),
        Err(VaultError::Unavailable(reason)) => return Err(reason),
    };
    let _ = vault.delete(account);
    Err(outcome)
}

fn fallback_or_locked(file_key: Option<[u8; 32]>) -> MasterKey {
    match file_key {
        Some(key) => MasterKey::Ready {
            key,
            location: KeyLocation::File,
        },
        None => {
            tracing::warn!(
                "secret master key is in the OS credential store, which is unavailable; \
                 stored secrets cannot be read until it is reachable"
            );
            MasterKey::Locked
        }
    }
}

/// Move the legacy file key into the credential store. Any failure keeps the
/// file and keeps using it, so no secret becomes unreadable.
fn migrate(
    dir: &Path,
    vault: &dyn KeyVault,
    account: &str,
    key: [u8; 32],
    marker_present: bool,
    verify: &dyn Fn(&[u8; 32]) -> BlobCheck,
) -> MasterKey {
    let file = MasterKey::Ready {
        key,
        location: KeyLocation::File,
    };
    if let Err(reason) = store_and_confirm(vault, account, &key) {
        tracing::warn!(%reason, "OS credential store unavailable; keeping the owner-only machine key file");
        return file;
    }
    // Verify with the bytes the store hands back (store_and_confirm proved
    // they equal `key`) against a real blob before giving up the file.
    if verify(&key) == BlobCheck::Fails {
        let _ = vault.delete(account);
        tracing::warn!("machine key migration could not decrypt an existing secret; keeping the machine key file");
        return file;
    }
    if !marker_present {
        if let Err(error) = write_marker(dir, account) {
            let _ = vault.delete(account);
            tracing::warn!(%error, "could not record the credential store account; keeping the machine key file");
            return file;
        }
    }
    if let Err(error) = fs::remove_file(dir.join(FILE_KEY_NAME)) {
        // The next start sees marker + identical file key and retries removal.
        tracing::warn!(%error, "machine key moved to the OS credential store but the old file could not be removed");
    } else {
        tracing::info!("secret master key moved to the OS credential store");
    }
    MasterKey::Ready {
        key,
        location: KeyLocation::OsCredentialStore,
    }
}

/// Generate a fresh key, preferring the credential store.
fn create(
    dir: &Path,
    vault: &dyn KeyVault,
    account: &str,
    marker_present: bool,
) -> Result<MasterKey> {
    let mut key = [0u8; 32];
    rng().fill_bytes(&mut key);
    match store_and_confirm(vault, account, &key) {
        Ok(()) => {
            let recorded = if marker_present {
                Ok(())
            } else {
                write_marker(dir, account)
            };
            match recorded {
                Ok(()) => {
                    return Ok(MasterKey::Ready {
                        key,
                        location: KeyLocation::OsCredentialStore,
                    })
                }
                Err(error) => {
                    let _ = vault.delete(account);
                    tracing::warn!(%error, "could not record the credential store account; using an owner-only machine key file");
                }
            }
        }
        Err(reason) => {
            tracing::warn!(%reason, "OS credential store unavailable; using an owner-only machine key file");
        }
    }
    private_fs::write_new_private_file(&dir.join(FILE_KEY_NAME), &key)?;
    Ok(MasterKey::Ready {
        key,
        location: KeyLocation::File,
    })
}

/// Resolve the master key for the secrets directory `dir`.
///
/// `verify(key)` reports whether at least one existing blob decrypts under
/// `key`; it must not modify anything.
pub(crate) fn resolve(
    dir: &Path,
    vault: &dyn KeyVault,
    verify: &dyn Fn(&[u8; 32]) -> BlobCheck,
) -> Result<MasterKey> {
    let file_key = read_file_key(dir)?;
    match read_marker(dir)? {
        Marker::Absent => {
            let account = format!("{ACCOUNT_PREFIX}{}", uuid::Uuid::new_v4());
            match file_key {
                Some(key) => Ok(migrate(dir, vault, &account, key, false, verify)),
                None => create(dir, vault, &account, false),
            }
        }
        Marker::Invalid => {
            tracing::warn!("credential store account marker is malformed");
            Ok(fallback_or_locked(file_key))
        }
        Marker::Account(account) => match vault.get(&account) {
            Ok(bytes) => match key_from(&bytes) {
                Some(key) => {
                    if let Some(old) = file_key {
                        if old == key {
                            // Finish a migration interrupted before the file
                            // was removed.
                            if let Err(error) = fs::remove_file(dir.join(FILE_KEY_NAME)) {
                                tracing::warn!(%error, "could not remove the migrated machine key file");
                            }
                        } else {
                            tracing::warn!("a machine key file differs from the credential store key; leaving it in place");
                        }
                    }
                    Ok(MasterKey::Ready {
                        key,
                        location: KeyLocation::OsCredentialStore,
                    })
                }
                None => {
                    tracing::warn!("OS credential store returned a malformed secret master key");
                    Ok(fallback_or_locked(file_key))
                }
            },
            Err(VaultError::NoEntry) => match file_key {
                Some(key) => Ok(migrate(dir, vault, &account, key, true, verify)),
                None => {
                    let created = create(dir, vault, &account, true)?;
                    if let MasterKey::Ready { key, .. } = &created {
                        if verify(key) == BlobCheck::Fails {
                            // The key is gone from the store (deleted entry,
                            // profile copied to another machine). Blobs stay on
                            // disk untouched; re-entering a secret replaces it.
                            tracing::warn!("secret master key is missing from the OS credential store; existing secrets cannot be decrypted");
                        }
                    }
                    Ok(created)
                }
            },
            Err(VaultError::Unavailable(reason)) => {
                tracing::warn!(%reason, "OS credential store unavailable");
                Ok(fallback_or_locked(file_key))
            }
        },
    }
}

#[cfg(test)]
#[path = "master_key_tests.rs"]
mod tests;
