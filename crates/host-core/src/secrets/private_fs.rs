//! Owner-only filesystem helpers for the secret store and the data root.
//!
//! On Unix every directory these helpers create is `0700` and every file is
//! `0600` from its first byte, so there is no umask-dependent window in which
//! another account can open it. Windows relies on the per-user profile ACLs.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Create `path` (and any missing ancestors) owner-only.
///
/// Directories that already exist keep their mode; use
/// [`restrict_existing_dir`] where tightening an existing directory is intended.
pub(crate) fn create_private_dir_all(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Tighten an existing directory to `0700` on Unix (no-op elsewhere).
pub(crate) fn restrict_existing_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)?.permissions().mode() & 0o777;
        if mode != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn private_file_options() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Create a new owner-only file; fails if `path` already exists.
pub(crate) fn write_new_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = private_file_options().open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

/// Replace `path` atomically with an owner-only file holding `contents`.
///
/// The bytes go to a uniquely named sibling first and are renamed over the
/// target only after they are durable, so a crash leaves either the previous
/// value or the new one — never a truncated blob. The temporary name starts
/// with a dot and never ends in `.bin`, so blob enumeration ignores it.
pub(crate) fn write_private_file_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result =
        write_new_private_file(&temporary, contents).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
