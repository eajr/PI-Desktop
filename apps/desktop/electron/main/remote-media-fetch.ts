/**
 * Click-to-load fetch for remote media referenced by rendered Markdown
 * (ADR 0327).
 *
 * The renderer's CSP admits no remote image or media origin, so a model reply,
 * tool output, or workspace document cannot make the app contact a host just
 * by being displayed. When the reader clicks one placeholder, the renderer
 * asks Main for that single URL; Main fetches it through the public-network
 * client (public HTTPS hosts only, every redirect hop re-validated, at most
 * three redirects, no cookies or credentials) and returns a data URL bounded in
 * size and restricted to the requested media family.
 *
 * Everything here is transport-agnostic so the policy is testable without
 * Electron or the network.
 */
import {
  isPublicNetworkPolicyFailure,
  publicNetworkRefusalReason,
  type RemoteMediaFetchFailure,
  type RemoteMediaFetchRequest,
  type RemoteMediaFetchResult,
  type RemoteMediaKind,
} from "@pi-desktop/shared";

export const REMOTE_MEDIA_MAX_REDIRECTS = 3;
export const REMOTE_MEDIA_TIMEOUT_MS = 20_000;
export const REMOTE_MEDIA_MAX_BYTES: Record<RemoteMediaKind, number> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 25 * 1024 * 1024,
};
/** Longest URL accepted from the renderer; longer input is refused unread. */
export const REMOTE_MEDIA_MAX_URL_LENGTH = 8192;

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Opens one URL and returns the final, unread, non-redirect response. */
export type RemoteMediaOpen = (
  url: string,
  options: { maxRedirects: number; signal: AbortSignal },
) => Promise<Response>;

function failure(reason: RemoteMediaFetchFailure): RemoteMediaFetchResult {
  return { ok: false, reason };
}

/** Validates renderer input; anything but a single http(s) URL is refused. */
export function parseRemoteMediaRequest(input: unknown): RemoteMediaFetchRequest | null {
  if (!input || typeof input !== "object") return null;
  const { url, kind } = input as { url?: unknown; kind?: unknown };
  if (kind !== "image" && kind !== "audio" && kind !== "video") return null;
  if (typeof url !== "string" || !url || url.length > REMOTE_MEDIA_MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  return { url: parsed.toString(), kind };
}

/** The bare, lower-cased media type when it belongs to the requested family. */
export function acceptedRemoteMediaType(
  header: string | null,
  kind: RemoteMediaKind,
): string | null {
  const type = (header ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return null;
  if (kind === "image") return IMAGE_TYPES.has(type) ? type : null;
  return type.startsWith(`${kind}/`) ? type : null;
}

class BodyTooLargeError extends Error {}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new BodyTooLargeError();
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch one remote media URL the reader explicitly asked to load. Never
 * throws: every refusal maps to a stable reason the renderer can show.
 */
export async function fetchRemoteMedia(
  input: unknown,
  open: RemoteMediaOpen,
  options: { timeoutMs?: number; onError?: (error: unknown) => void } = {},
): Promise<RemoteMediaFetchResult> {
  const request = parseRemoteMediaRequest(input);
  if (!request) return failure("invalid-url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REMOTE_MEDIA_TIMEOUT_MS);
  try {
    const response = await open(request.url, {
      maxRedirects: REMOTE_MEDIA_MAX_REDIRECTS,
      signal: controller.signal,
    });
    const discard = () => response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      await discard();
      return failure("http-error");
    }
    const mimeType = acceptedRemoteMediaType(response.headers.get("content-type"), request.kind);
    if (!mimeType) {
      await discard();
      return failure("unsupported-type");
    }
    const maxBytes = REMOTE_MEDIA_MAX_BYTES[request.kind];
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discard();
      return failure("too-large");
    }
    const bytes = await readBounded(response, maxBytes);
    const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
    return { ok: true, dataUrl, mimeType, size: bytes.byteLength };
  } catch (error) {
    if (error instanceof BodyTooLargeError) return failure("too-large");
    if (controller.signal.aborted) return failure("timeout");
    if (isPublicNetworkPolicyFailure(error)) {
      // A resolver with no answer is an environment condition, not a verdict.
      return failure(publicNetworkRefusalReason(error) === "resolve-failed" ? "network" : "blocked");
    }
    options.onError?.(error);
    return failure("network");
  } finally {
    clearTimeout(timer);
  }
}
