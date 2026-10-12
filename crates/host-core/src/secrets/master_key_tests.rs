use super::*;
use crate::secrets::{secret_ref_for_provider, SecretStore};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

/// An in-memory credential store shared across `SecretStore::open` calls, so
/// a test can observe what survives a restart. Never touches the real OS store.
#[derive(Default)]
struct MemoryVault {
    entries: RefCell<HashMap<String, Vec<u8>>>,
    unavailable: Cell<bool>,
    /// Simulates a store that accepts a write but hands back other bytes.
    corrupt_reads: Cell<bool>,
}

impl MemoryVault {
    fn check(&self) -> Result<(), VaultError> {
        if self.unavailable.get() {
            Err(VaultError::Unavailable("test store offline".into()))
        } else {
            Ok(())
        }
    }
}

impl KeyVault for MemoryVault {
    fn get(&self, account: &str) -> Result<Vec<u8>, VaultError> {
        self.check()?;
        let mut value = self
            .entries
            .borrow()
            .get(account)
            .cloned()
            .ok_or(VaultError::NoEntry)?;
        if self.corrupt_reads.get() {
            value[0] ^= 0xff;
        }
        Ok(value)
    }
    fn set(&self, account: &str, key: &[u8]) -> Result<(), VaultError> {
        self.check()?;
        self.entries
            .borrow_mut()
            .insert(account.to_string(), key.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.check()?;
        self.entries
            .borrow_mut()
            .remove(account)
            .map(|_| ())
            .ok_or(VaultError::NoEntry)
    }
}

const LEGACY_BLOB_NAME: &str =
    "98c9443fcbc5c60d4da31a04e6cf07028f6144cbfbdb0fd7b86f2e19b463280d.bin";
const LEGACY_BLOB: &str = "CwoJCAcGBQQDAgEAU5Z0dF8QGeiN27cNAqFSeAYGwMXktbI1htFNv2eSmf0=";

fn legacy_key() -> [u8; 32] {
    std::array::from_fn(|i| i as u8)
}

/// A data root as an earlier build left it: `.machine-key` beside a blob for
/// `secret:provider:openai:api_key` = `sk-fixture-value`.
fn legacy_profile() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    let secrets = dir.path().join("secrets");
    fs::create_dir_all(&secrets).expect("secrets dir");
    fs::write(secrets.join(FILE_KEY_NAME), legacy_key()).expect("machine key");
    fs::write(secrets.join(LEGACY_BLOB_NAME), LEGACY_BLOB).expect("blob");
    dir
}

fn marker_account(data: &Path) -> String {
    fs::read_to_string(data.join("secrets").join(ACCOUNT_MARKER_NAME)).expect("marker")
}

fn read_openai(store: &SecretStore) -> Option<String> {
    store
        .get(&secret_ref_for_provider("openai"))
        .expect("get secret")
}

#[test]
fn a_fresh_profile_keeps_its_key_in_the_credential_store() {
    let vault = MemoryVault::default();
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SecretStore::open_with_vault(dir.path(), &vault).expect("open");
    assert_eq!(store.key_location(), Some(KeyLocation::OsCredentialStore));
    assert!(!dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    let account = marker_account(dir.path());
    assert!(account.starts_with(ACCOUNT_PREFIX));
    assert_eq!(vault.entries.borrow().get(&account).map(Vec::len), Some(32));

    store
        .set(&secret_ref_for_provider("openai"), "sk-new")
        .expect("set");
    drop(store);
    let reopened = SecretStore::open_with_vault(dir.path(), &vault).expect("reopen");
    assert_eq!(read_openai(&reopened), Some("sk-new".into()));
}

#[test]
fn a_legacy_file_key_moves_into_the_credential_store() {
    let vault = MemoryVault::default();
    let dir = legacy_profile();
    let store = SecretStore::open_with_vault(dir.path(), &vault).expect("open");

    assert_eq!(store.key_location(), Some(KeyLocation::OsCredentialStore));
    assert!(!dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    let account = marker_account(dir.path());
    assert_eq!(
        vault.entries.borrow().get(&account).cloned(),
        Some(legacy_key().to_vec())
    );
    assert_eq!(read_openai(&store), Some("sk-fixture-value".into()));

    // After a restart only the credential store can open the blob.
    let reopened = SecretStore::open_with_vault(dir.path(), &vault).expect("reopen");
    assert_eq!(read_openai(&reopened), Some("sk-fixture-value".into()));
}

#[test]
fn migration_keeps_the_file_when_no_existing_secret_decrypts() {
    let vault = MemoryVault::default();
    let dir = legacy_profile();
    // The key file no longer matches the blob (e.g. restored from elsewhere).
    fs::write(dir.path().join("secrets").join(FILE_KEY_NAME), [7u8; 32]).expect("rewrite key");

    let store = SecretStore::open_with_vault(dir.path(), &vault).expect("open");
    assert_eq!(store.key_location(), Some(KeyLocation::File));
    assert!(dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    assert!(!dir
        .path()
        .join("secrets")
        .join(ACCOUNT_MARKER_NAME)
        .exists());
    assert!(
        vault.entries.borrow().is_empty(),
        "half-migrated entry is removed"
    );
}

#[test]
fn migration_keeps_the_file_when_the_store_returns_other_bytes() {
    let vault = MemoryVault::default();
    vault.corrupt_reads.set(true);
    let dir = legacy_profile();

    let store = SecretStore::open_with_vault(dir.path(), &vault).expect("open");
    assert_eq!(store.key_location(), Some(KeyLocation::File));
    assert!(dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    assert!(vault.entries.borrow().is_empty());
    assert_eq!(read_openai(&store), Some("sk-fixture-value".into()));
}

#[test]
fn an_unavailable_store_falls_back_to_the_existing_file_key() {
    let dir = legacy_profile();
    let store = SecretStore::open_with_vault(dir.path(), &DisabledVault("headless")).expect("open");
    assert_eq!(store.key_location(), Some(KeyLocation::File));
    assert!(dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    assert!(!dir
        .path()
        .join("secrets")
        .join(ACCOUNT_MARKER_NAME)
        .exists());
    assert_eq!(read_openai(&store), Some("sk-fixture-value".into()));
}

#[test]
fn an_unavailable_store_creates_an_owner_only_file_key() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SecretStore::open_with_vault(dir.path(), &DisabledVault("headless")).expect("open");
    assert_eq!(store.key_location(), Some(KeyLocation::File));
    let key_path = dir.path().join("secrets").join(FILE_KEY_NAME);
    assert_eq!(fs::read(&key_path).expect("key").len(), 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&key_path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // When the store comes back, the next start migrates the fallback key.
    store
        .set(&secret_ref_for_provider("openai"), "sk-later")
        .expect("set");
    let vault = MemoryVault::default();
    let migrated = SecretStore::open_with_vault(dir.path(), &vault).expect("reopen");
    assert_eq!(
        migrated.key_location(),
        Some(KeyLocation::OsCredentialStore)
    );
    assert!(!key_path.exists());
    assert_eq!(read_openai(&migrated), Some("sk-later".into()));
}

#[test]
fn a_store_outage_after_migration_locks_instead_of_rekeying() {
    let vault = MemoryVault::default();
    let dir = legacy_profile();
    SecretStore::open_with_vault(dir.path(), &vault).expect("migrate");
    let blob_path = dir.path().join("secrets").join(LEGACY_BLOB_NAME);
    let blob_before = fs::read(&blob_path).expect("blob");

    vault.unavailable.set(true);
    let locked = SecretStore::open_with_vault(dir.path(), &vault).expect("open locked");
    assert_eq!(locked.key_location(), None);
    let secret_ref = secret_ref_for_provider("openai");
    assert!(locked.has(&secret_ref));
    assert!(locked.get(&secret_ref).is_err());
    assert!(locked.set(&secret_ref, "sk-overwrite").is_err());
    assert!(!dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    assert_eq!(fs::read(&blob_path).expect("blob"), blob_before);

    vault.unavailable.set(false);
    let recovered = SecretStore::open_with_vault(dir.path(), &vault).expect("recover");
    assert_eq!(read_openai(&recovered), Some("sk-fixture-value".into()));
}

#[test]
fn an_interrupted_migration_finishes_by_removing_the_identical_file() {
    let vault = MemoryVault::default();
    let dir = legacy_profile();
    SecretStore::open_with_vault(dir.path(), &vault).expect("migrate");
    // Crash between recording the account and removing the old file.
    fs::write(dir.path().join("secrets").join(FILE_KEY_NAME), legacy_key()).expect("restore");

    let store = SecretStore::open_with_vault(dir.path(), &vault).expect("reopen");
    assert_eq!(store.key_location(), Some(KeyLocation::OsCredentialStore));
    assert!(!dir.path().join("secrets").join(FILE_KEY_NAME).exists());
    assert_eq!(read_openai(&store), Some("sk-fixture-value".into()));
}

#[test]
fn separate_data_roots_use_separate_accounts() {
    let vault = MemoryVault::default();
    let first = tempfile::tempdir().expect("first");
    let second = tempfile::tempdir().expect("second");
    SecretStore::open_with_vault(first.path(), &vault).expect("first");
    SecretStore::open_with_vault(second.path(), &vault).expect("second");
    assert_ne!(marker_account(first.path()), marker_account(second.path()));
    assert_eq!(vault.entries.borrow().len(), 2);
}

#[test]
fn a_relocated_copy_finds_its_key_through_the_copied_marker() {
    let vault = MemoryVault::default();
    let source = legacy_profile();
    SecretStore::open_with_vault(source.path(), &vault).expect("migrate");
    let copy = tempfile::tempdir().expect("copy");
    let copied_secrets = copy.path().join("secrets");
    fs::create_dir_all(&copied_secrets).expect("copy dir");
    for name in [ACCOUNT_MARKER_NAME, LEGACY_BLOB_NAME] {
        fs::copy(
            source.path().join("secrets").join(name),
            copied_secrets.join(name),
        )
        .expect("copy file");
    }
    let store = SecretStore::open_with_vault(copy.path(), &vault).expect("open copy");
    assert_eq!(read_openai(&store), Some("sk-fixture-value".into()));
    assert_eq!(vault.entries.borrow().len(), 1);
}

#[test]
fn keyring_errors_classify_without_echoing_payloads() {
    assert!(matches!(
        classify(keyring::Error::NoEntry),
        VaultError::NoEntry
    ));
    let VaultError::Unavailable(reason) =
        classify(keyring::Error::BadEncoding(b"sk-leak".to_vec()))
    else {
        panic!("bad encoding must be unavailable");
    };
    assert!(!reason.contains("sk-leak"));
    assert!(matches!(
        classify(keyring::Error::NoDefaultStore),
        VaultError::Unavailable(_)
    ));
}

#[cfg(unix)]
#[test]
fn secrets_directory_and_blobs_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("tempdir");
    let secrets = dir.path().join("secrets");
    // Earlier builds created the directory with the process umask.
    fs::create_dir_all(&secrets).expect("secrets dir");
    fs::set_permissions(&secrets, fs::Permissions::from_mode(0o755)).expect("chmod");

    let vault = MemoryVault::default();
    let store = SecretStore::open_with_vault(dir.path(), &vault).expect("open");
    let secret_ref = secret_ref_for_provider("openai");
    store.set(&secret_ref, "sk-a").expect("set");
    store.set(&secret_ref, "sk-b").expect("overwrite");

    let mode = |path: &Path| fs::metadata(path).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode(&secrets), 0o700);
    assert_eq!(mode(&store.path_for(&secret_ref)), 0o600);
    assert_eq!(mode(&secrets.join(ACCOUNT_MARKER_NAME)), 0o600);
    let leftovers: Vec<_> = fs::read_dir(&secrets)
        .expect("list")
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "atomic writes leave no temporaries");
    assert_eq!(store.get(&secret_ref).expect("get"), Some("sk-b".into()));
}

#[cfg(unix)]
#[test]
fn a_new_data_root_is_created_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("nested").join("data");
    private_fs::create_private_dir_all(&root).expect("create");
    let mode = fs::metadata(&root).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
}
