# ADR: Keep the secret master key in the OS credential store

- Status: Accepted
- Date: 2026-10-12
- Related: spec `03-runtime/14-secrets-storage.md`, `03-runtime/04-data-storage.md`
  §4.12, `05-security/01-security.md`; ADR custom-storage-location

## Context

host-core encrypts provider API keys, OAuth credentials, MCP secrets and the
configuration-sync vault key with AES-256-GCM. The 32-byte key lived in
`secrets/.machine-key`, beside the ciphertexts. Any process running as the
same user — a plugin, an agent Bash command, a malicious dependency — could
read both files and decrypt every secret. Blobs were written with plain
`fs::write` (process umask, non-atomic) and the data and secrets directories
were created with default modes.

## Decision

1. **Key location.** host-core stores the master key in the platform
   credential store through the `keyring` crate (v4, `v1` feature): macOS
   Keychain, Windows Credential Manager, Linux Secret Service over pure-Rust
   zbus with `crypto-rust`. The service name is the application id
   `net.aiuo.pi-desktop`. The account is `secret-master-key:<uuid>`, a random
   identifier recorded in the non-secret file `secrets/.keychain-account`.
   Separate data roots (dev, prod, E2E, custom locations) therefore never
   share a key, and a relocated copy of a data root, which copies the marker,
   keeps finding its key.
2. **Blobs are unchanged.** Ciphertexts stay `base64(nonce ‖ ciphertext ‖ tag)`
   under `secrets/sha256(secret_ref).bin`. `secrets_meta.backend` keeps
   recording `file_fallback`, which describes where the blob lives. No SQLite
   schema, RPC or Plugin SDK contract changes.
3. **Migration.** On startup, a data root with `.machine-key` and no recorded
   account imports the key into the credential store, reads it back, and
   proves it by decrypting at least one existing blob. Only then does it write
   the marker and delete `.machine-key`. Any failure removes the half-written
   credential and keeps using the file. A crash between marker and delete is
   finished on the next start when the file equals the stored key.
4. **Explicit fallback.** When no credential store is reachable (headless
   Linux without Secret Service, CI, containers) or
   `PI_DESKTOP_SECRET_KEY_STORE=file` is set, host-core keeps or creates an
   owner-only `.machine-key` and logs a warning without key material. The next
   start with a reachable store migrates it. Unit tests never contact the real
   credential store; the shared E2E host helper selects the file store so
   test profiles do not leave entries in a developer's keychain.
5. **No silent re-keying.** If a data root records an account but the store is
   unreachable and no file key exists, the store opens *locked*: `has` and
   `delete` work, `get` and `set` fail, and nothing on disk changes. If the
   store answers that the entry is gone, host-core creates a new key; the old
   blobs stay on disk, undecryptable, until each secret is re-entered.
6. **File modes.** On Unix the data root and `secrets/` are `0700` (existing
   directories are tightened); blobs, the marker and a fallback key are
   `0600` from their first byte. Blobs are replaced atomically (temporary
   sibling, `fsync`, rename).

## Consequences

- A same-user process can no longer decrypt secrets by reading the data
  directory alone. It still can by asking the credential store as the same
  user where the store does not authenticate the caller (Linux Secret Service
  with an unlocked collection, Windows Credential Manager). On macOS the
  Keychain item's access list is bound to the host-core code signature;
  unsigned development builds can trigger an access prompt after a rebuild,
  and a denied prompt leaves the store locked for that run.
- Copying a whole data root to another machine or user no longer carries the
  key; secrets must be re-entered there. Configuration sync already excluded
  machine keys from portable bundles.
- Deleting a data root leaves its credential-store entry behind; it is a
  32-byte random key with no other use.
- `keyring` adds platform crates (security-framework, windows-sys stores,
  zbus/secret-service); none links OpenSSL or a system D-Bus library.

## Alternatives

- **Electron `safeStorage`.** Would move key custody into Electron main,
  breaking host-core's ownership of secrets and its headless use.
- **Store every secret in the credential store.** Changes the blob data model,
  multiplies keychain prompts and entry-size limits, and complicates
  relocation and sync staging. Only the key needs protection.
- **`keyring` with `dbus-secret-service` or `linux-keyutils`.** The former needs
  libdbus (or a vendored C build); keyutils does not persist across reboots,
  which would lose the key.
- **Fail closed when no store exists.** Would break headless Linux and CI
  users who rely on the existing file key today.
