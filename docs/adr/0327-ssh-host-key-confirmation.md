# ADR 0327: Confirm SSH host keys instead of trusting on first use

- Status: Accepted
- Date: 2026-10-12
- Deciders: PI-Desktop maintainers (security audit remediation)
- Amends: [ADR 0292](0292-ssh-remote-host-bootstrap.md) decision 1 (`StrictHostKeyChecking=accept-new`)
- Related: [ADR 0293](0293-ssh-password-authentication.md), [ADR 0326](0326-verified-ssh-host-installation.md), [security §3.4](../spec/05-security/02-remote-control-security.md#34-ssh-bootstrap-pairing-first-remote-topology), [architecture §5.2](../spec/02-architecture/05-remote-agent-control.md#52-remote-host-over-an-ssh-tunnel-first-remote-topology)

## Context

ADR 0292 ran every `ssh` child with `StrictHostKeyChecking=accept-new`. A
host the user had never connected to was trusted silently on the first
connection and recorded in `~/.ssh/known_hosts`. Unlike an interactive
terminal, the app showed no fingerprint and asked no question.

A network attacker present at that first connection could impersonate the
host. The desktop would then send the SSH login password (ADR 0293, through
the askpass helper), install and pair a `pi-host` controlled by the attacker,
and, on request, stream the user's provider API keys over SSH stdin
(`remote-provider-sync.ts`). Every one of those secrets is protected only by
the SSH channel, so silent trust on first use is a credential-exposure path,
not a usability detail.

## Decision

1. **Every connection checks strictly.** `ssh-transport.ts` sets
   `StrictHostKeyChecking=yes` on every `exec`, `execWithInput`,
   `execWithFile` and `forward`. An unknown or changed key fails the
   connection before authentication; nothing is ever trusted implicitly.

2. **An app-managed known_hosts file, consulted first.** Approved keys are
   written to `<dataDir>/ssh_known_hosts` (`0600`). Every connection passes
   `UserKnownHostsFile="<dataDir>/ssh_known_hosts" ~/.ssh/known_hosts
   ~/.ssh/known_hosts2`, so a host the user already trusts in their own files
   keeps working with no prompt, while the app never writes the user's
   `~/.ssh/known_hosts`. The app file is first so that any key OpenSSH itself
   might record (for example `CheckHostIP`) also lands in the app's file.
   Editing the user's own file was rejected: an app that rewrites a
   security-sensitive user file it does not own is harder to audit, and a
   user removing a host from the app should not have to clean their personal
   file.

3. **Learn the key with `ssh`, not `ssh-keyscan`.** Before the first
   authenticated command of a bootstrap, the transport runs one probe:
   `ssh` with `StrictHostKeyChecking=accept-new`, a private scratch file as the
   *first* `UserKnownHostsFile` entry (followed by the app file and the user's
   files), `BatchMode=yes`, and every authentication method disabled
   (`PubkeyAuthentication`, `PasswordAuthentication`,
   `KbdInteractiveAuthentication`, `HostbasedAuthentication`,
   `GSSAPIAuthentication` all `no`; `ControlPath=none`;
   `UpdateHostKeys=no`). OpenSSH writes a new key only to the first file and
   only when no listed file knows the host, so:
   - an empty scratch file and no host-key diagnostic means the host is
     already trusted;
   - an empty scratch file with a changed-key diagnostic means the key
     contradicts a trusted one;
   - a non-empty scratch file holds exactly the entry later connections will
     look up.
   Using `ssh` rather than `ssh-keyscan` honours the user's `~/.ssh/config`
   (`HostName`, `Port`, `ProxyJump`, `HostKeyAlias`) and records the entry
   under the same name ssh will use. The probe never offers a credential, never
   uses the askpass helper, and runs in a `0700` temporary directory that is
   removed afterwards.

4. **The user confirms the SHA-256 fingerprint.** For an unknown key the
   bootstrap fails with `SSH_HOST_KEY_UNKNOWN`, whose details carry the host,
   port, and each key's type and `SHA256:` fingerprint (computed in-process
   from the key blob, matching `ssh-keygen -l`). The Settings SSH form shows a
   confirmation with that host, key type and fingerprint, focused on Cancel.
   Cancel sends nothing and records nothing. "Trust and install" resends the
   same request with `trustedHostKeys` set to the shown fingerprints. Main
   probes again and records the learned entry only if *every* fingerprint the
   server now presents is in that list; a different key (for example a
   swapped server between the two attempts) raises a fresh confirmation.

5. **A changed key is never auto-accepted.** A changed or revoked key fails
   with `SSH_HOST_KEY_CHANGED`, during the probe and on any later connection
   (tunnel reopen, provider sync). The UI explains that the connection may be
   intercepted and that the user must verify and fix `known_hosts` outside the
   app. An approved fingerprint never overrides a changed-key diagnostic, and
   the host's status becomes `action-required` instead of retrying.

6. **Argument hardening at the argv builder.** `sshCommonArgs` re-validates
   its inputs: host and user must be non-empty, must not start with `-`, and
   must not contain whitespace or control characters; the identity file must
   not start with `-` or contain control characters (a space is allowed: it is
   its own `-i` argv entry); the port must be an integer in 1..65535. The
   destination is preceded by `--`, so no value can be parsed as an option.
   Known-hosts paths are double-quoted, `%`-escaped and use forward slashes so
   paths with spaces (macOS "Application Support", Windows profiles) survive
   the OpenSSH tokenizer.

## Consequences

- IPC: `RemoteHostBootstrapRequest` gains the optional `trustedHostKeys`
  field, and two error codes are added (`SSH_HOST_KEY_UNKNOWN`,
  `SSH_HOST_KEY_CHANGED`). Both are additive; an older renderer still works
  and shows a generic failure for an unknown host.
- Hosts paired before this change were recorded by `accept-new` in the
  user's `~/.ssh/known_hosts`, which is still consulted, so they reconnect
  with no prompt and no migration.
- A host whose key is missing from every consulted file after pairing (for
  example the user cleared `~/.ssh/known_hosts`) fails closed with
  `SSH_HOST_KEY_UNKNOWN`; the user removes and re-adds it to confirm the
  fingerprint again.
- Limitation: a custom `UserKnownHostsFile` set in the user's
  `~/.ssh/config` is overridden by the command-line option, so such a user is
  asked to confirm once even for a host they already trust. This fails
  safe (a prompt, never a silent trust).
- Limitation: a `ProxyJump` hop is a separate `ssh` process that uses the
  user's own host-key configuration; this ADR covers the destination host.
- Verification: unit tests cover argv building, fingerprint parsing,
  approve/decline/mismatch/changed outcomes and injection validation
  (`apps/desktop/test/remote-host-ssh-host-keys.test.mjs`), plus a renderer
  interaction test (`remote-host-key-confirm-ui.test.mjs`). The probe's
  OpenSSH behaviour (write to the first file only, nothing written for a
  known host, changed-key diagnostics) was checked against a local `sshd` with
  OpenSSH 10.3.
