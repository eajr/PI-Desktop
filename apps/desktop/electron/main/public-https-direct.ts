import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export type PinnedNetworkAddress = {
  address: string;
  family: 4 | 6;
};

/**
 * Optional request shape. Absent, the request is the bare `GET` the public
 * catalog guard has always made; a caller that needs a method, headers or a
 * body (plugin `pi.net.fetch`) passes them. `Host` always names the URL's host.
 */
export type PinnedRequestInit = {
  signal: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Make a direct request to the exact address already accepted by the guard. */
export function fetchPinnedDirect(
  url: string,
  init: PinnedRequestInit,
  resolved: PinnedNetworkAddress,
): Promise<Response> {
  const parsed = new URL(url);
  const secure = parsed.protocol === "https:";
  if (!secure && parsed.protocol !== "http:") {
    return Promise.reject(new Error("unsupported protocol for a pinned request"));
  }
  const hostname = parsed.hostname.startsWith("[")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const request = secure ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: parsed.protocol,
        hostname: resolved.address,
        family: resolved.family,
        ...(parsed.port ? { port: parsed.port } : {}),
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
        headers: {
          Accept: "*/*",
          ...(init.headers ?? {}),
          ...(init.body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(init.body)) }
            : {}),
          Host: parsed.host,
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
        signal: init.signal,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) {
          incoming.destroy();
          req.destroy();
          reject(new Error("invalid HTTP response status"));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") {
            headers.set(name, value);
          } else if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          }
        }
        const body = [204, 205, 304].includes(status)
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    req.once("error", reject);
    req.end(init.body);
  });
}
