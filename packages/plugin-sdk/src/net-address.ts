/**
 * Pure host and address normalization for the plugin egress policy.
 *
 * A policy that compares hostnames as strings can be walked around by spelling
 * the same address differently: `0xa9fea9fe`, `2852039166`, `169.254.43518`,
 * `[::ffff:a9fe:a9fe]` and `[::169.254.169.254]` all name the IPv4 cloud
 * metadata service. Every check therefore runs on the address a host *means*,
 * never on how it was written. Nothing here performs I/O: resolving a DNS name
 * and pinning the connection to the checked answer belongs to the host process
 * that dials it.
 */

/** What an address or host means to the egress policy. */
export type PluginNetHostClass =
  /** A cloud instance-metadata service: its answers are instance credentials. */
  | "metadata"
  /** Loopback, unspecified, link-local or private (RFC 1918 / ULA / site-local). */
  | "local"
  /** Anything else: a public address, or a DNS name that still needs resolving. */
  | "other";

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data"]);
/** IPv4 metadata services, as 32-bit values: 169.254.169.254 and 100.100.100.200. */
const METADATA_IPV4 = new Set([0xa9fea9fe, 0x646464c8]);

/**
 * Canonical spelling of a hostname for policy decisions.
 *
 * - case, surrounding whitespace, trailing dots and IPv6 brackets are dropped;
 * - an IPv4 literal in any notation the WHATWG URL parser accepts (decimal,
 *   octal, hex, shortened forms) becomes a dotted quad;
 * - an IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`) IPv6
 *   literal becomes the embedded dotted quad, since that is where it connects;
 * - any other IPv6 literal becomes eight lowercase hex groups without zero
 *   compression, so two spellings of one address compare equal;
 * - a DNS name is returned lowercased and otherwise unchanged.
 */
export function normalizeNetHost(host: string): string {
  if (typeof host !== "string") return "";
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  value = value.replace(/\.+$/, "");
  if (!value) return "";
  if (value.includes(":")) {
    const groups = parseIpv6(value);
    if (!groups) return value;
    const embedded = embeddedIpv4(groups);
    if (embedded !== null) return dottedIpv4(embedded);
    return groups.map((group) => group.toString(16)).join(":");
  }
  const ipv4 = parseIpv4Loose(value);
  return ipv4 === null ? value : dottedIpv4(ipv4);
}

/**
 * Classify a hostname or address after normalization. DNS names other than the
 * metadata aliases and `localhost` are `other`: what they resolve to is decided
 * where the connection is made.
 */
export function classifyNetHost(host: string): PluginNetHostClass {
  const value = normalizeNetHost(host);
  if (!value) return "other";
  if (METADATA_NAMES.has(value)) return "metadata";
  if (value === "localhost" || value.endsWith(".localhost")) return "local";
  if (value.includes(":")) {
    const groups = parseIpv6(value);
    return groups ? classifyIpv6(groups) : "other";
  }
  const ipv4 = parseIpv4Loose(value);
  return ipv4 === null ? "other" : classifyIpv4(ipv4);
}

function classifyIpv4(value: number): PluginNetHostClass {
  if (METADATA_IPV4.has(value)) return "metadata";
  const first = value >>> 24;
  const second = (value >>> 16) & 0xff;
  if (first === 0 || first === 10 || first === 127) return "local";
  if (first === 169 && second === 254) return "local";
  if (first === 172 && second >= 16 && second <= 31) return "local";
  if (first === 192 && second === 168) return "local";
  return "other";
}

function classifyIpv6(groups: number[]): PluginNetHostClass {
  // AWS's IPv6 metadata address, fd00:ec2::254.
  if (
    groups[0] === 0xfd00 &&
    groups[1] === 0x0ec2 &&
    groups.slice(2, 7).every((group) => group === 0) &&
    groups[7] === 0x0254
  ) {
    return "metadata";
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] <= 1) return "local"; // :: and ::1
  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return classifyIpv4(embedded);
  const first = groups[0];
  if (first >= 0xfc00 && first <= 0xfdff) return "local"; // fc00::/7 ULA
  if (first >= 0xfe80 && first <= 0xfeff) return "local"; // fe80::/10 link-local, fec0::/10 site-local
  return "other";
}

/** IPv4 carried by an IPv4-mapped or IPv4-compatible IPv6 literal. */
function embeddedIpv4(groups: number[]): number | null {
  if (!groups.slice(0, 5).every((group) => group === 0)) return null;
  if (groups[5] === 0xffff) return groups[6] * 0x10000 + groups[7];
  // `::` and `::1` are IPv6's own unspecified and loopback addresses, not IPv4.
  if (groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1)) return groups[6] * 0x10000 + groups[7];
  return null;
}

function dottedIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

/**
 * IPv4 per the WHATWG URL host parser: one to four parts, each decimal, octal
 * (`0` prefix) or hex (`0x` prefix); the last part fills the remaining bytes.
 * Returns null for anything that is not an IPv4 literal in some notation.
 */
function parseIpv4Loose(value: string): number | null {
  const parts = value.split(".");
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    let parsed: number;
    if (/^0x[0-9a-f]*$/.test(part)) parsed = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) parsed = parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) parsed = Number(part);
    else return null;
    if (!Number.isSafeInteger(parsed)) return null;
    numbers.push(parsed);
  }
  const last = numbers[numbers.length - 1];
  const leading = numbers.slice(0, -1);
  if (leading.some((part) => part > 255)) return null;
  if (last >= 256 ** (5 - numbers.length)) return null;
  let result = last;
  for (const [index, part] of leading.entries()) result += part * 256 ** (3 - index);
  return result;
}

/** Eight 16-bit groups, or null when `value` is not an IPv6 literal. */
function parseIpv6(value: string): number[] | null {
  if (value.includes("%")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const split = (half: string): string[] | null => {
    if (!half) return [];
    const tokens = half.split(":");
    const out: string[] = [];
    for (const [index, token] of tokens.entries()) {
      if (token.includes(".")) {
        if (index !== tokens.length - 1) return null;
        const quad = token.split(".");
        if (quad.length !== 4 || quad.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))) {
          return null;
        }
        const bytes = quad.map(Number);
        if (bytes.some((byte) => byte > 255)) return null;
        out.push(((bytes[0] << 8) | bytes[1]).toString(16), ((bytes[2] << 8) | bytes[3]).toString(16));
      } else {
        out.push(token);
      }
    }
    return out;
  };
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if (!head || !tail) return null;
  let tokens: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    tokens = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  } else {
    tokens = head;
  }
  if (tokens.length !== 8 || tokens.some((token) => !/^[0-9a-f]{1,4}$/.test(token))) return null;
  return tokens.map((token) => parseInt(token, 16));
}
