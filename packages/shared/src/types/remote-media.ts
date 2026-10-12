/**
 * Click-to-load remote media for rendered Markdown (ADR 0327).
 *
 * The renderer never contacts a remote media host itself: its CSP admits no
 * `https:` image or media source. When the reader explicitly asks to load one
 * placeholder, Electron Main fetches that single URL under the public-network
 * policy and hands back a bounded data URL.
 */
export type RemoteMediaKind = "image" | "audio" | "video";

export type RemoteMediaFetchRequest = {
  url: string;
  kind: RemoteMediaKind;
};

export type RemoteMediaFetchFailure =
  | "invalid-url"
  | "blocked"
  | "http-error"
  | "unsupported-type"
  | "too-large"
  | "timeout"
  | "network";

export type RemoteMediaFetchResult =
  | { ok: true; dataUrl: string; mimeType: string; size: number }
  | { ok: false; reason: RemoteMediaFetchFailure };
