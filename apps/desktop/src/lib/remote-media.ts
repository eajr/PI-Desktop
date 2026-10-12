import type { RemoteMediaFetchResult, RemoteMediaKind } from "@pi-desktop/shared";

/*
 * Remote media in rendered Markdown is click-to-load (ADR 0327). The renderer
 * never hands a remote URL to an `<img>`, `<audio>`, `<video>`, `<source>`,
 * or `poster`; it shows a placeholder until the reader asks for that one item,
 * and Main returns its bytes as a bounded data URL.
 */

// A base no real reference can share, so anything that resolves off it named
// its own host: an absolute `http(s)` URL, a protocol-relative `//host/…`, or a
// backslash form the URL parser normalizes to one.
const LOCAL_BASE = "https://pi-desktop-local.invalid/";
const LOCAL_ORIGIN = new URL(LOCAL_BASE).origin;

/**
 * The absolute URL a media `src` would make the renderer contact, or null for
 * a reference that names no remote host (relative paths, local files,
 * attachment refs). Parsed the way the browser would parse it, so whitespace,
 * tab, and backslash variants cannot slip a host past the check.
 */
export function remoteMediaUrl(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  // An explicit scheme is parsed on its own: against a same-scheme base,
  // `https:host/x` would read as a relative path, but the renderer's own
  // origin is never `https:`, so the browser would fetch it from `host`.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed.replace(/[\t\n\r]/g, ""));
  let resolved: URL;
  try {
    resolved = absolute ? new URL(trimmed) : new URL(trimmed, LOCAL_BASE);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (!absolute && resolved.origin === LOCAL_ORIGIN) return null;
  return resolved.href;
}

/** Host shown on the placeholder chip; the full URL goes in its title. */
export function remoteMediaHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/*
 * Loaded items stay loaded while the app runs, so a virtualized transcript that
 * remounts a message does not ask again. Bounded like the local image cache.
 */
const CACHE_ENTRIES = 32;
const CACHE_MAX_CODE_UNITS = 96 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheSize = 0;

function cacheKey(url: string, kind: RemoteMediaKind): string {
  return `${kind}\u0000${url}`;
}

export function cachedRemoteMedia(url: string, kind: RemoteMediaKind): string | null {
  return cache.get(cacheKey(url, kind)) ?? null;
}

function remember(key: string, dataUrl: string): void {
  const previous = cache.get(key);
  if (previous !== undefined) {
    cacheSize -= previous.length;
    cache.delete(key);
  }
  cache.set(key, dataUrl);
  cacheSize += dataUrl.length;
  while (cache.size > CACHE_ENTRIES || cacheSize > CACHE_MAX_CODE_UNITS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheSize -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

export type RemoteMediaFetcher = (request: {
  url: string;
  kind: RemoteMediaKind;
}) => Promise<RemoteMediaFetchResult>;

/**
 * Load one remote media item the reader clicked. Resolves to a data URL, or
 * null when Main refused or failed; never throws.
 */
export async function loadRemoteMedia(
  url: string,
  kind: RemoteMediaKind,
  fetcher: RemoteMediaFetcher,
): Promise<string | null> {
  const key = cacheKey(url, kind);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const result = await fetcher({ url, kind });
    if (!result.ok || !result.dataUrl.startsWith("data:")) return null;
    remember(key, result.dataUrl);
    return result.dataUrl;
  } catch (error) {
    // The placeholder shows the failure; keep the cause visible to developers.
    console.warn("remote media load failed", error instanceof Error ? error.message : error);
    return null;
  }
}
