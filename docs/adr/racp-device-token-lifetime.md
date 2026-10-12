# ADR: RACP device token lifetime, SSH re-pairing, and failed-auth throttling

- Status: Accepted
- Date: 2026-10-12
- Amends: ADR 0285 (RACP-WS header-profile authentication), [remote-provider-import](remote-provider-import.md) (the admin socket's single operation), security §3.4 ("a new pairing needs a new SSH bootstrap"; daily readiness never re-pairs)
- Related: D448, D658, [security §3.4](../spec/05-security/02-remote-control-security.md#34-ssh-bootstrap-pairing-first-remote-topology), [error codes](../spec/03-runtime/08-error-codes.md)

## Context

A `pdt1.` device token minted by `connection/pair` never expired. Every paired
desktop holds `owner` on its Host (terminal, workspace tools, files), so a
token copied off a desktop stayed useful for as long as the Host kept the
record. Failed bearer authentications on the RACP-WS upgrade were also not
throttled; the tokens are 256-bit, so guessing is not practical, but nothing
bounded log or CPU cost from a local process hammering the loopback port.

## Decision

1. **Lifetime.** A device token is refused once it has gone unused for
   `RACP_DEVICE_TOKEN_IDLE_TTL_MS` (30 days) or once
   `RACP_DEVICE_TOKEN_MAX_LIFETIME_MS` (180 days) has passed since it was
   issued, whichever comes first. An authenticated upgrade and the close of
   an authenticated connection both record use, sliding the idle window;
   nothing extends the absolute lifetime. An open connection is not cut when
   its token expires; the refusal applies to the next upgrade.
2. **Distinct refusal.** A device token that matches a live, unrevoked record
   but is past its lifetime is refused with `401` and the response header
   `x-racp-error: REMOTE_DEVICE_TOKEN_EXPIRED`; every other refusal carries
   `x-racp-error: REMOTE_AUTH_FAILED`. The client maps the header to the
   non-retriable `REMOTE_DEVICE_TOKEN_EXPIRED` code. A guesser learns nothing:
   only the holder of a once-valid token can see the expired code. Older
   clients ignore the header and see `REMOTE_AUTH_FAILED` as before.
3. **Re-pairing over SSH.** SSH is the pairing root of trust. When an
   SSH-managed Host refuses the desktop's token as expired, the desktop runs
   `pi-host pairing-issue` over SSH. That command asks the running Host,
   through its owner-only admin socket, to mint one single-use pairing token
   (two-minute lifetime) and prints it on stdout. The desktop exchanges it over
   the existing forward with the saved Host id check, stores the new device
   token encrypted, and retries the connection once. The Host is not
   reinstalled or restarted, so running work is untouched. A revoked or unknown
   token (`REMOTE_AUTH_FAILED`) is never re-paired automatically, and a failed
   re-pair leaves the host `action-required`. The admin socket therefore
   accepts two operations: `providers.import` and `pairing.issue`. It is still
   not a general RPC tunnel. Reaching it already requires a login as the
   Host's user, the same authority SSH bootstrap pairing rests on.
4. **Stored-record migration.** `credentials.json` gains `version: 2`,
   `tokenIssuedAt`, and a persisted `lastSeenAt`. A version 1 file (no
   `version` field) is migrated on first load: each existing device's
   lifetime and idle window start at migration time, not its original pairing
   time, and the migration is written back so a restart does not move it.
   Upgrading never locks a paired desktop out on the spot. Version 1 readers
   ignore the new fields.
5. **Failed-auth throttle.** Each remote address has a token bucket
   (10 failures, one refilled every 6 seconds) drained only by failed upgrade
   authentications. An empty bucket refuses the address with `429` and
   `Retry-After` for a backoff that starts at 1 second and doubles per repeat
   up to 60 seconds; a full bucket forgets past backoff. Successful
   authentications neither drain nor refill it. Refusals are logged with the
   peer address, the reason, and (for an expired token) the device id, never
   with the token or the `Authorization` header.
6. **Ceiling for paired devices stays off.** `applyCeilingToPairedDevices`
   remains `false`. `RACP_DEFAULT_POLICY` is also the Agent Host module's
   default for the local desktop principal, which is a paired-device `owner`,
   so turning it on would cap the desktop's own local sessions at `ask` as well
   as remote ones. Security §4.3 already records why an SSH-paired owner is
   exempt (its SSH login grants shell access anyway).

## Consequences

- A desktop that does not connect to an SSH Host for 30 days, or that has used
  the same token for 180 days, re-pairs silently on its next connection, as
  long as its SSH login still works. A Host added by pasting a URL and
  pairing token (no SSH metadata) must be paired again by hand.
- Because every SSH-forwarded peer is loopback, all clients of one Host share
  one throttle bucket. A local process that floods bad tokens can delay a
  legitimate reconnect by up to the backoff cap. That is the accepted cost of
  bounding failures without per-client identity before authentication.
- The token lifetime is a Host-wide constant, not a per-Host policy setting.

## Alternatives

- **Re-run the full SSH bootstrap on expiry.** Rejected: it restarts the Host
  (ending in-flight turns), may download a release, and conflicts with the
  rule that daily readiness never reinstalls.
- **In-band token rotation over RACP.** Would avoid an SSH round trip for
  active devices but adds a protocol operation and does not help an idle
  desktop, which needs SSH re-pairing anyway.
- **Apply expiry to legacy records from their original `createdAt`.** Rejected:
  it would lock out every desktop paired more than 30 days before the upgrade.
