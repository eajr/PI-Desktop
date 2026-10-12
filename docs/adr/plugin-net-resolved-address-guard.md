# ADR: Judge plugin egress on the address, not the spelling

- Status: Accepted (implementation candidate)
- Date: 2026-10-12
- Amends: `net.anyHost` semantics in
  [02-plugin-manifest-schema.md §5.3.1](../spec/07-plugins/02-plugin-manifest-schema.md#531-netanyhost--the-escape-hatch)
- Related: [ADR 0272](0272-connection-time-public-network-route.md),
  [plugin fetch redirect policy](plugin-fetch-redirect-policy.md),
  [04-plugin-security.md §8.0](../spec/07-plugins/04-plugin-security.md#80-egress-allowlist)

## Context

The plugin egress policy in `@pi-desktop/plugin-sdk` (`net-policy.ts`)
compared hostnames as strings. Three gaps followed from that:

1. **Alternate spellings.** The metadata block matched `fd00:ec2::254` while
   `URL.hostname` yields `[fd00:ec2::254]`, and `[::ffff:a9fe:a9fe]`,
   `[::169.254.169.254]` and other IPv6 forms of `169.254.169.254` were not
   recognized at all. A plugin with `net.anyHost` could reach the cloud
   metadata service by spelling it differently.
2. **DNS names.** No chokepoint resolved a name before connecting, so any
   name whose A/AAAA record is `169.254.169.254`, `100.100.100.200` or
   `fd00:ec2::254` passed, as did a name that answers with a public address at
   check time and a private one at connect time (DNS rebinding).
3. **`net.anyHost` and the local network.** The grant admitted loopback, LAN
   and link-local targets; `isLocalNetDomain` only made tooling warn about an
   *allowlist entry*. A plugin with the grant could probe `127.0.0.1` and the
   user's LAN without naming any of it in its manifest.

## Decision

1. **Normalize before deciding.** `normalizeNetHost` folds every IPv4
   notation the WHATWG parser accepts (decimal, octal, hex, shortened),
   IPv4-mapped and IPv4-compatible IPv6, brackets, case and trailing dots to
   one spelling. Every plugin-sdk egress decision runs on it. The SDK stays
   pure: no DNS, no I/O.
2. **Metadata is never reachable.** A cloud metadata host or address is refused
   in every spelling, with or without `net.anyHost`, and also when
   `net.domains` names it. (Previously a declared entry admitted it.)
3. **`net.anyHost` reaches public hosts only.** Loopback, unspecified,
   link-local and private (RFC 1918, ULA, site-local) literals and `localhost`
   are refused under the grant unless `net.domains` names the host. A plugin
   that talks to a local daemon or a LAN server declares that host, as before.
4. **Resolve, judge, then dial the judged address.** For `pi.net.fetch` and
   `pi.net.websocket`, Electron main (`plugin-net-guard.ts`) resolves the name
   once per hop and judges every answer with `isNetAddressAllowedWithGrant`:
   metadata is refused; a local address is admitted only for a host covered by
   `net.domains`; anything else is admitted. The connection is then made to an
   admitted address only:
   - `pi.net.fetch` on a **direct** route (Chromium's `resolveProxy` answers
     `DIRECT`) uses a Node `http`/`https` request to that exact IP with the
     original `Host` and TLS `servername`. Every redirect hop is resolved and
     judged again.
   - `pi.net.fetch` on a **proxied or unknown** route keeps `net.fetch`, so the
     user's proxy still applies (ADR 0177 / ADR 0272). The local answer is
     judged first and a forbidden one refused; a local resolver failure is not
     a verdict there, because the proxy resolves the name.
   - `pi.net.websocket` hands the `ws` client a lookup hook that only answers
     with admitted addresses, so the socket never performs its own lookup.
5. **Refusals are coded and audited.** A refused address surfaces as
   `PERMISSION_DENIED` to the plugin and as an audit entry with the host and
   the refused address.

## Consequences

- A plugin holding `net.anyHost` that targeted a LAN or loopback server without
  declaring it in `net.domains` now gets `PERMISSION_DENIED`. The fix is to
  declare the host. Manifests that declare their hosts are unaffected, apart
  from a declared metadata entry, which now admits nothing.
- The direct-route fetch no longer goes through Chromium's network stack: it
  uses Node's TLS trust store (bundled roots plus `NODE_EXTRA_CA_CERTS`) and
  asks for an uncompressed body (`Accept-Encoding: identity`) because it does
  not decode content encodings.
- On a proxied or unknown route the address pin cannot be enforced; the proxy
  chooses where the request lands. The local check still refuses a name whose
  local answer is forbidden.
- The panel session (`onBeforeRequest`) and remote HTTP MCP endpoints get the
  normalized hostname policy (items 1–3) but no resolved-address check:
  Chromium and the MCP client resolve names themselves and expose no hook to
  pin the connection. That gap is recorded in the plugin security spec.
