/**
 * Plugin egress policy.
 *
 * Reading a secret is only half of an exfiltration; the other half is an
 * outbound request. Permissions cannot express "read broadly but leak nothing",
 * so the host keeps a single per-plugin domain allowlist and enforces it at
 * every egress chokepoint it owns: the panel session, `pi.net.fetch`, and
 * remote MCP endpoints. Absent `manifest.net.domains`, a plugin gets no egress
 * at all — which is what makes a generous `fs.read` grant affordable.
 *
 * The one escape hatch is the `net.anyHost` permission: an install-time grant
 * that lifts the allowlist for every public http(s)/ws(s) host. It exists for
 * plugins whose endpoints the user types in (self-hosted servers), where no
 * manifest written ahead of time can name the hosts. It never reaches the
 * cloud metadata service, whose answers are instance credentials, and it does
 * not reach loopback, link-local or private addresses: a host on the user's own
 * machine or LAN is reachable only when `net.domains` names it.
 *
 * Every decision here runs on the normalized host (`normalizeNetHost`), so an
 * alternate spelling of an IP literal is judged as the address it means. These
 * checks are syntactic; the host process that dials a DNS name also checks the
 * addresses it resolves to (`isNetAddressAllowedWithGrant`) and connects only
 * to an address it checked.
 */

import { classifyNetHost, normalizeNetHost } from "./net-address.js";

export { classifyNetHost, normalizeNetHost, type PluginNetHostClass } from "./net-address.js";

/** Hostname, or `*.suffix` for "this domain and its subdomains". */
export type PluginNetDomain = string;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Hostnames cloud providers answer with instance credentials. */
const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "100.100.100.200",
  "fd00:ec2::254",
]);

/**
 * Whether an allowlist entry admits a loopback, link-local, or cloud metadata
 * host. Such an entry gives the plugin a path to local services and instance
 * credentials that the egress allowlist exists to keep it from, so tooling
 * warns about it; the entry itself stays valid because a plugin that talks to
 * a local daemon is a legitimate, if unusual, design.
 */
export function isLocalNetDomain(entry: string): boolean {
  const value = entry.trim().toLowerCase().replace(/\.$/, "");
  const bare = value.startsWith("*.") ? value.slice(2) : value;
  if (!bare) return false;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "0.0.0.0" || bare === "::1" || bare === "::") return true;
  if (CLOUD_METADATA_HOSTS.has(bare)) return true;
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 127) return true;
    if (first === 169 && second === 254) return true;
    return false;
  }
  // IPv6 link-local (fe80::/10) and IPv4-mapped loopback.
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  if (bare === "::ffff:127.0.0.1") return true;
  return false;
}

/**
 * Validate `manifest.net.domains`. Patterns are hostnames only: no scheme, no
 * port, no path, and no bare `*`. A plugin that genuinely needs arbitrary,
 * user-chosen hosts declares the `net.anyHost` permission instead — there is
 * no way to declare its way there.
 */
export function parseNetDomains(raw: unknown): {
  ok: boolean;
  domains?: string[];
  error?: string;
} {
  if (raw === undefined) return { ok: true, domains: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "net.domains must be an array" };
  const domains: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { ok: false, error: "net.domains entries must be non-empty strings" };
    }
    const value = entry.trim().toLowerCase();
    if (value === "*") {
      return { ok: false, error: 'net.domains must not contain "*"; list the hosts you call' };
    }
    if (/[:/?#]/.test(value)) {
      return {
        ok: false,
        error: `net.domains entry must be a bare hostname: ${entry}`,
      };
    }
    const bare = value.startsWith("*.") ? value.slice(2) : value;
    if (!bare || !HOSTNAME.test(bare)) {
      return { ok: false, error: `net.domains entry is not a valid hostname: ${entry}` };
    }
    if (!domains.includes(value)) domains.push(value);
  }
  return { ok: true, domains };
}

/** Match a hostname against one parsed allowlist entry. */
function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalizeNetHost(pattern);
}

/**
 * True when `host` is covered by the allowlist. An empty list allows nothing.
 * The host is normalized first, so `0x7f000001` is matched as `127.0.0.1`.
 */
export function isNetHostAllowed(host: string, domains: readonly string[]): boolean {
  const value = normalizeNetHost(host);
  if (!value) return false;
  return domains.some((pattern) => matchesDomain(value, pattern));
}

/**
 * True when a URL may be requested. Only http(s) is considered: other schemes
 * are decided by the caller, because what is safe differs per chokepoint (a
 * panel may load its own `file://` assets; `pi.net.fetch` may not).
 */
export function isNetUrlAllowed(url: string, domains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return isNetHostAllowed(parsed.hostname, domains);
}

/**
 * True when a WebSocket URL may be connected to. `ws`/`wss` are the same
 * decision as `http`/`https` for the host: the hostname still has to be in the
 * allowlist, and `ws://` is the plaintext form of `http://` rather than a
 * second, more permissive channel.
 */
export function isNetSocketUrlAllowed(url: string, domains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return false;
  return isNetHostAllowed(parsed.hostname, domains);
}

/**
 * Whether `host` is a cloud metadata endpoint, in any spelling. No egress
 * decision reaches these, with or without `net.anyHost` and whatever
 * `net.domains` lists: their answers are instance credentials, and the egress
 * policy exists to keep a plugin from exfiltrating exactly that. A declared
 * entry naming one still parses (tooling warns about it) but admits nothing.
 */
export function isMetadataNetHost(host: string): boolean {
  return classifyNetHost(host) === "metadata";
}

/**
 * The host half of the grant decision once the allowlist did not match: a
 * public name or address is admitted under `net.anyHost`; metadata, loopback,
 * link-local and private literals (and `localhost`) are not.
 */
function isAnyHostReachable(host: string, grant: PluginNetEgressGrant): boolean {
  return grant.anyHost === true && classifyNetHost(host) === "other";
}

/**
 * The resolved-address decision a host process makes after DNS, immediately
 * before it connects (and to the address it connects to):
 *
 * - a cloud metadata address is always refused;
 * - a loopback, unspecified, link-local or private address is admitted only
 *   when `host` itself is covered by `net.domains` — the manifest named that
 *   host, so reaching it on the local network is the declared design;
 * - any other address is admitted (the hostname already passed the URL check).
 *
 * This is what closes a DNS name that resolves to `169.254.169.254`, and an
 * `anyHost` request to a name that resolves to the user's loopback or LAN.
 */
export function isNetAddressAllowedWithGrant(
  host: string,
  address: string,
  grant: PluginNetEgressGrant,
): boolean {
  const kind = classifyNetHost(address);
  if (kind === "metadata") return false;
  if (kind === "local") return isNetHostAllowed(host, grant.domains);
  return true;
}

/** What a plugin's egress decision needs: its allowlist plus the anyHost grant. */
export type PluginNetEgressGrant = {
  domains: readonly string[];
  anyHost?: boolean;
};

/**
 * `isNetUrlAllowed` with the `net.anyHost` escape hatch. A cloud metadata
 * endpoint is refused first, in any spelling and whatever the allowlist says;
 * then the declared allowlist decides; then the grant admits any other public
 * http(s) host — not a loopback, link-local or private literal, and not
 * `localhost`. Unparseable input and non-http schemes are refused either way.
 */
export function isNetUrlAllowedWithGrant(
  url: string,
  grant: PluginNetEgressGrant,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (isMetadataNetHost(parsed.hostname)) return false;
  if (isNetUrlAllowed(url, grant.domains)) return true;
  return isAnyHostReachable(parsed.hostname, grant);
}

/**
 * The socket half of the grant: same decision shape as
 * `isNetUrlAllowedWithGrant` over `ws`/`wss`.
 */
export function isNetSocketUrlAllowedWithGrant(
  url: string,
  grant: PluginNetEgressGrant,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return false;
  if (isMetadataNetHost(parsed.hostname)) return false;
  if (isNetSocketUrlAllowed(url, grant.domains)) return true;
  return isAnyHostReachable(parsed.hostname, grant);
}
