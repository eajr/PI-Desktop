import assert from "node:assert/strict";
import test from "node:test";
import { createPublicHttpsClient } from "../electron/main/public-https-fetch.ts";
import {
  REMOTE_MEDIA_MAX_BYTES,
  REMOTE_MEDIA_MAX_REDIRECTS,
  acceptedRemoteMediaType,
  fetchRemoteMedia,
  parseRemoteMediaRequest,
} from "../electron/main/remote-media-fetch.ts";

/*
 * ADR 0327: the only path from rendered Markdown to a remote media host is
 * one reader click, served by Main under the public-network policy with a
 * bounded, type-checked body.
 */

function response(status, { type = "image/png", body = new Uint8Array([1, 2, 3]), location, length } = {}) {
  const headers = new Headers();
  if (type) headers.set("content-type", type);
  if (location) headers.set("location", location);
  if (length !== undefined) headers.set("content-length", String(length));
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

function publicClient(fetchImpl, lookup = async () => [{ address: "93.184.216.34" }]) {
  return createPublicHttpsClient({ fetchImpl, lookupImpl: lookup });
}

test("renderer input must be a single http(s) URL of a known media kind", () => {
  assert.equal(parseRemoteMediaRequest(null), null);
  assert.equal(parseRemoteMediaRequest({ url: "https://a.example/x.png", kind: "script" }), null);
  assert.equal(parseRemoteMediaRequest({ url: "file:///etc/passwd", kind: "image" }), null);
  assert.equal(parseRemoteMediaRequest({ url: "javascript:alert(1)", kind: "image" }), null);
  assert.equal(parseRemoteMediaRequest({ url: "https://user:pw@a.example/x.png", kind: "image" }), null);
  assert.equal(parseRemoteMediaRequest({ url: `https://a.example/${"x".repeat(9000)}`, kind: "image" }), null);
  assert.deepEqual(parseRemoteMediaRequest({ url: "https://a.example/x.png", kind: "image" }), {
    url: "https://a.example/x.png",
    kind: "image",
  });
});

test("content type must belong to the requested media family", () => {
  assert.equal(acceptedRemoteMediaType("image/PNG; charset=binary", "image"), "image/png");
  assert.equal(acceptedRemoteMediaType("text/html", "image"), null);
  assert.equal(acceptedRemoteMediaType("video/mp4", "image"), null);
  assert.equal(acceptedRemoteMediaType("video/mp4", "video"), "video/mp4");
  assert.equal(acceptedRemoteMediaType("audio/mpeg", "audio"), "audio/mpeg");
  assert.equal(acceptedRemoteMediaType(null, "audio"), null);
});

test("a clicked image comes back as a bounded data URL", async () => {
  const seen = [];
  const client = publicClient(async (url, init) => {
    seen.push({ url, init });
    return response(200);
  });
  const result = await fetchRemoteMedia(
    { url: "https://img.example/a.png", kind: "image" },
    (url, options) => client.open(url, options),
  );
  assert.deepEqual(result, { ok: true, dataUrl: "data:image/png;base64,AQID", mimeType: "image/png", size: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.redirect, "manual");
  // The client never forwards renderer headers, methods, or bodies.
  assert.equal(seen[0].init.headers, undefined);
  assert.equal(seen[0].init.method, undefined);
});

test("refuses wrong types, HTTP errors, and invalid input without throwing", async () => {
  const open = (res) => async () => res;
  assert.deepEqual(
    await fetchRemoteMedia({ url: "https://a.example/x", kind: "image" }, open(response(200, { type: "text/html" }))),
    { ok: false, reason: "unsupported-type" },
  );
  assert.deepEqual(
    await fetchRemoteMedia({ url: "https://a.example/x", kind: "image" }, open(response(404))),
    { ok: false, reason: "http-error" },
  );
  assert.deepEqual(
    await fetchRemoteMedia({ url: "ftp://a.example/x", kind: "image" }, open(response(200))),
    { ok: false, reason: "invalid-url" },
  );
});

test("oversized bodies are refused by header and while streaming", async () => {
  const limit = REMOTE_MEDIA_MAX_BYTES.image;
  assert.deepEqual(
    await fetchRemoteMedia(
      { url: "https://a.example/x", kind: "image" },
      async () => response(200, { length: limit + 1 }),
    ),
    { ok: false, reason: "too-large" },
  );
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
  assert.deepEqual(
    await fetchRemoteMedia({ url: "https://a.example/x", kind: "image" }, async () => streamed),
    { ok: false, reason: "too-large" },
  );
  assert.equal(cancelled, true);
});

test("follows at most three redirects and re-validates every hop", async () => {
  const hops = [];
  const client = publicClient(async (url) => {
    hops.push(url);
    const n = Number(new URL(url).searchParams.get("n") ?? "0");
    return response(302, { location: `https://img.example/r?n=${n + 1}` });
  });
  const result = await fetchRemoteMedia(
    { url: "https://img.example/r?n=0", kind: "image" },
    (url, options) => client.open(url, options),
  );
  assert.deepEqual(result, { ok: false, reason: "blocked" });
  assert.equal(hops.length, REMOTE_MEDIA_MAX_REDIRECTS + 1);

  const privateHop = publicClient(
    async (url) => (url.includes("start") ? response(302, { location: "https://internal.example/x.png" }) : response(200)),
    async (host) => [{ address: host === "internal.example" ? "10.0.0.5" : "93.184.216.34" }],
  );
  assert.deepEqual(
    await fetchRemoteMedia(
      { url: "https://img.example/start", kind: "image" },
      (url, options) => privateHop.open(url, options),
    ),
    { ok: false, reason: "blocked" },
  );
});

test("plain http and non-public hosts are blocked before any request", async () => {
  let calls = 0;
  const client = publicClient(async () => {
    calls += 1;
    return response(200);
  }, async () => [{ address: "127.0.0.1" }]);
  const open = (url, options) => client.open(url, options);
  assert.deepEqual(await fetchRemoteMedia({ url: "http://img.example/a.png", kind: "image" }, open), {
    ok: false,
    reason: "blocked",
  });
  assert.deepEqual(await fetchRemoteMedia({ url: "https://localhost/a.png", kind: "image" }, open), {
    ok: false,
    reason: "blocked",
  });
  assert.equal(calls, 0);
});

test("a stalled transfer times out", async () => {
  const result = await fetchRemoteMedia(
    { url: "https://slow.example/a.png", kind: "image" },
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    { timeoutMs: 20 },
  );
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});
