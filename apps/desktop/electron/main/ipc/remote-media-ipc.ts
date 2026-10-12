/**
 * The one renderer channel that may contact a remote media host: an explicit
 * click on a Markdown media placeholder (ADR 0327). It is not routed to a
 * paired remote host, not exposed through the MCP control surface, and never
 * forwards renderer-supplied headers, methods, or bodies.
 */
import { net, session } from "electron";
import { IPC } from "@pi-desktop/shared";
import { fetchPinnedDirect } from "../public-https-direct";
import { createPublicHttpsClient } from "../public-https-fetch";
import { relaxedNetworkPolicyEnabled } from "../endpoint-policy";
import { fetchRemoteMedia } from "../remote-media-fetch";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

const client = createPublicHttpsClient({
  // `credentials: "omit"` keeps the default session's cookies and HTTP auth
  // out of the request, and `no-store` keeps the bytes out of the shared cache.
  fetchImpl: (url, init) => net.fetch(url, { ...init, credentials: "omit", cache: "no-store" }),
  pinnedFetchImpl: (url, init, address) => fetchPinnedDirect(url, init, address),
  routeImpl: (url) => session.defaultSession.resolveProxy(url),
  allowFakeIp: () => relaxedNetworkPolicyEnabled(),
  timeoutMs: 15_000,
});

export function registerRemoteMediaIpc({
  registrar,
  logger,
}: {
  registrar: IpcRegistrar;
  logger: Pick<Logger, "app">;
}): void {
  registrar.handleWithEvent(IPC.invoke.mediaFetchRemote, async (_event, input: unknown) =>
    fetchRemoteMedia(input, (url, options) => client.open(url, options), {
      // The URL is reader content and may carry private data; log only the
      // failure class so an unexpected transport error stays observable.
      onError: (error) =>
        logger.app("diagnostics", "warn", "Remote media fetch failed", {
          data: { error: error instanceof Error ? error.name : typeof error },
        }),
    }),
  );
}
