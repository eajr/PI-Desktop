/**
 * Resolved-address egress guard for plugin `pi.net.fetch` and
 * `pi.net.websocket` (ADR plugin-net-resolved-address-guard).
 *
 * `@pi-desktop/plugin-sdk` decides on the hostname a plugin wrote, normalized
 * so alternate IP spellings cannot pass. A DNS name still says nothing about
 * where a connection lands: `meta.attacker.example` may resolve to
 * `169.254.169.254`, and under `net.anyHost` any name may resolve to the
 * user's loopback or LAN. This module resolves the name in the main process,
 * judges every answer with `isNetAddressAllowedWithGrant`, and then connects
 * only to an address it judged — the socket never performs a second lookup an
 * attacker's DNS could answer differently (DNS rebinding).
 *
 * The verdict follows the route the request will take (ADR 0272). On a direct
 * route the request is pinned to the checked address. When Chromium will dial
 * a proxy instead (`proxied`) or may (`unknown`), the request keeps going
 * through `net.fetch` so the user's proxy still applies; the local answer is
 * checked first and refused when it names a forbidden address, but the proxy
 * resolves the name itself, so the pin cannot be enforced there. WebSockets
 * use the `ws` client, which always dials directly, so they are always pinned.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { classifyProxyRoute, type PublicNetworkRoute } from "@pi-desktop/shared";
import {
  isNetAddressAllowedWithGrant,
  normalizeNetHost,
  type PluginNetEgressGrant,
} from "@pi-desktop/plugin-sdk";
import { fetchPinnedDirect, type PinnedNetworkAddress, type PinnedRequestInit } from "./public-https-direct";
import type { PluginFetchTransport } from "./plugin-net-fetch";

/** Every answer for one name; `dns.lookup(host, { all: true })` in production. */
export type PluginNetResolve = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>;

/** A resolved address the policy refused. `code` is what the plugin sees. */
export class PluginNetAddressError extends Error {
  readonly code = "PERMISSION_DENIED";
  readonly host: string;
  readonly address: string;

  constructor(host: string, address: string) {
    super(`host resolves to an address plugins may not reach: ${host} -> ${address}`);
    this.name = "PluginNetAddressError";
    this.host = host;
    this.address = address;
  }
}

export type PluginNetGuardOptions = {
  grant: PluginNetEgressGrant;
  /** Injectable so tests never touch real DNS. */
  resolve?: PluginNetResolve;
};

const defaultResolve: PluginNetResolve = (host) => dnsLookup(host, { all: true });

/** The URL hostname without IPv6 brackets — what a socket would dial. */
function dialHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Resolve `hostname` once and return the answers the policy admits, in
 * resolver order. An IP literal is judged as itself. When no answer is
 * admitted the connection is refused with the first offending address; a
 * resolver failure propagates unchanged (it is a network error, not a verdict).
 */
export async function resolvePluginNetAddresses(
  hostname: string,
  options: PluginNetGuardOptions,
): Promise<PinnedNetworkAddress[]> {
  const host = dialHost(hostname);
  const literalFamily = isIP(host);
  const answers =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: host, family: literalFamily }]
      : await (options.resolve ?? defaultResolve)(host);
  const admitted: PinnedNetworkAddress[] = [];
  let refused: string | undefined;
  for (const answer of answers) {
    const family = isIP(answer.address);
    if (family !== 4 && family !== 6) continue;
    if (isNetAddressAllowedWithGrant(host, answer.address, options.grant)) {
      admitted.push({ address: answer.address, family });
    } else {
      refused ??= answer.address;
    }
  }
  if (!admitted.length) {
    throw new PluginNetAddressError(normalizeNetHost(host), refused ?? "no address");
  }
  return admitted;
}

/**
 * A `net` lookup hook that answers only with checked addresses. Handed to a
 * socket client (`ws`), it replaces the client's own resolution, so the
 * address the policy judged is the address the socket connects to. Supports
 * both the single-answer and the `all: true` form (happy eyeballs).
 */
export function createPluginNetLookup(options: PluginNetGuardOptions): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    const wanted = typeof lookupOptions === "object" ? lookupOptions : {};
    resolvePluginNetAddresses(hostname, options).then(
      (addresses) => {
        const family = wanted.family === 4 || wanted.family === 6 ? wanted.family : 0;
        const usable = family ? addresses.filter((item) => item.family === family) : addresses;
        if (!usable.length) {
          const error = Object.assign(new Error(`no IPv${family} address for ${hostname}`), {
            code: "ENOTFOUND",
          });
          callback(error, "", 0);
          return;
        }
        if (wanted.all) {
          (callback as unknown as (error: null, list: PinnedNetworkAddress[]) => void)(null, usable);
        } else {
          callback(null, usable[0].address, usable[0].family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

export type PluginFetchTransportOptions = PluginNetGuardOptions & {
  /** Chromium's proxy decision for a URL (`Session.resolveProxy`); absent = direct. */
  resolveRoute?: (url: string) => Promise<string>;
  /** Transport for a proxied or unknown route (`net.fetch` in the app). */
  proxiedFetch?: PluginFetchTransport;
  /** Transport for a direct route; must connect to exactly `address`. */
  pinnedFetch?: (
    url: string,
    init: PinnedRequestInit,
    address: PinnedNetworkAddress,
  ) => Promise<Response>;
};

async function routeFor(
  url: string,
  resolveRoute: PluginFetchTransportOptions["resolveRoute"],
): Promise<PublicNetworkRoute> {
  if (!resolveRoute) return "direct";
  try {
    return classifyProxyRoute(await resolveRoute(url));
  } catch {
    return "unknown";
  }
}

/** Headers a pinned request sends; content negotiation stays uncompressed. */
function pinnedHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key !== "accept-encoding") out[key] = value;
  });
  // `net.fetch` decoded compressed bodies transparently; the pinned transport
  // does not decode, so it asks for an identity body instead.
  out["accept-encoding"] = "identity";
  return out;
}

/**
 * The single-hop transport `pluginNetFetch` drives for one plugin. Every hop —
 * the first request and each redirect — is resolved and judged here, right
 * before it is dialed.
 */
export function createPluginFetchTransport(options: PluginFetchTransportOptions): PluginFetchTransport {
  const pinnedFetch = options.pinnedFetch ?? fetchPinnedDirect;
  const proxiedFetch = options.proxiedFetch ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    const hostname = new URL(url).hostname;
    const route = await routeFor(url, options.resolveRoute);
    if (route !== "direct") {
      // The proxy resolves the name; a local answer that names a forbidden
      // address is still refused, while a local resolver failure is not ours
      // to decide on that route.
      try {
        await resolvePluginNetAddresses(hostname, options);
      } catch (error) {
        if (error instanceof PluginNetAddressError) throw error;
      }
      return proxiedFetch(url, init);
    }
    const [address] = await resolvePluginNetAddresses(hostname, options);
    if (!init.signal) throw new Error("pinned plugin fetch requires an abort signal");
    return pinnedFetch(
      url,
      {
        signal: init.signal,
        method: init.method,
        headers: pinnedHeaders(init.headers),
        body: typeof init.body === "string" ? init.body : undefined,
      },
      address,
    );
  };
}
