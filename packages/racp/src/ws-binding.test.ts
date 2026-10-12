import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RACP_UPGRADE_ERROR_HEADER, RACP_WS_SUBPROTOCOL } from "@pi-desktop/shared";

import { hashToken, newDeviceToken } from "./auth.js";

import { RacpClient } from "./client.js";
import { OWNER_TOKEN, harness } from "./test-harness.js";
import { bindRacpWebSocket, wsClientTransport } from "./ws-binding.js";

describe("RACP-WS over a loopback socket", () => {
  it("authenticates on the upgrade, runs the handshake, and delivers events over ws", async () => {
    const h = await harness();
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined });
    try {
      const url = `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`;
      const events: unknown[] = [];
      const client = new RacpClient({
        transport: wsClientTransport({ url, token: OWNER_TOKEN }),
        client: { name: "test", version: "0.15.0" },
        onEvent: (envelope) => events.push(envelope),
      });
      const init = await client.connect();
      expect(init.server.hostId).toBe("host_test");
      await client.request("session/attach", { sessionId: "s1" });
      await client.request("events/subscribe", { scope: "session", sessionId: "s1" });
      await client.request("turn/start", { sessionId: "s1", input: { text: "hi" }, context: { requestId: "r1" } });
      h.host.ingest({ sessionId: "s1", turnId: "rt_1", ts: 1, event: { type: "agent_start" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toHaveLength(1);
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.server.connectionCount()).toBe(0);
    } finally {
      await binding.close();
    }
  });

  it("refuses a missing credential, a token in the URL, a wrong path, and a binary frame", async () => {
    const h = await harness();
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined });
    try {
      const base = `ws://127.0.0.1:${binding.address.port}`;
      const status = (url: string, headers: Record<string, string> = {}) =>
        new Promise<number | "open">((resolve) => {
          const socket = new WebSocket(url, [RACP_WS_SUBPROTOCOL], { headers });
          socket.once("unexpected-response", (_request, response) => {
            resolve(response.statusCode ?? 0);
            socket.terminate();
          });
          socket.once("open", () => {
            resolve("open");
            socket.terminate();
          });
          socket.once("error", () => resolve(0));
        });
      expect(await status(`${base}/v1/racp/ws`)).toBe(401);
      expect(await status(`${base}/v1/racp/ws?token=${OWNER_TOKEN}`, { Authorization: `Bearer ${OWNER_TOKEN}` })).toBe(401);
      expect(await status(`${base}/other`, { Authorization: `Bearer ${OWNER_TOKEN}` })).toBe(404);
      expect(await status(`${base}/v1/racp/ws`, { Authorization: `Bearer ${OWNER_TOKEN}` })).toBe("open");
      await expect(new RacpClient({ transport: wsClientTransport({ url: `${base}/v1/racp/ws`, token: "pdt1.bad" }), client: { name: "t", version: "1" } }).connect()).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });

      const closeCode = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`${base}/v1/racp/ws`, [RACP_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
        socket.once("open", () => socket.send(Buffer.from([1, 2, 3])));
        socket.once("close", (code) => resolve(code));
      });
      expect(closeCode).toBe(1003);
      // The client observed its own close frame; the server drops the
      // connection on its side of the socket's close event, which can lag
      // under parallel test load. Poll instead of asserting on the same tick.
      for (let i = 0; i < 100 && h.server.connectionCount() > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.server.connectionCount()).toBe(0);
    } finally {
      await binding.close();
    }
  });

  it("stops reconnecting after a real WebSocket upgrade rejects a revoked device", async () => {
    const h = await harness();
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined });
    const factory = wsClientTransport({ url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`, token: OWNER_TOKEN });
    let attempts = 0;
    let drop!: () => void;
    let failed!: () => void;
    const ended = new Promise<void>(resolve => { failed = resolve; });
    const client = new RacpClient({
      transport: async () => { attempts++; const transport = await factory(); drop = () => transport.close(); return transport; },
      client: { name: "test", version: "1" }, reconnect: { enabled: true, maxAttempts: 3 }, sleep: async () => undefined,
      onStateChange: state => { if (state === "error") failed(); },
    });
    try {
      await client.connect();
      await h.store.revokeDevice("dev_owner", "2026-09-18T00:00:00.000Z");
      drop();
      await ended;
      expect(attempts).toBe(2);
      expect(client.state).toBe("error");
    } finally { await client.close(); await binding.close(); }
  });

  it("tells an expired device token apart from an invalid one, without logging token material", async () => {
    const h = await harness();
    const expired = newDeviceToken();
    await h.store.saveDevice({
      deviceId: "dev_old", label: "old laptop", roles: ["owner"], tokenHash: hashToken(expired),
      createdAt: "2000-01-01T00:00:00.000Z", tokenIssuedAt: "2000-01-01T00:00:00.000Z",
    });
    const logs: unknown[] = [];
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: (...entry) => logs.push(entry) });
    try {
      const url = `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`;
      const header = await new Promise<string | string[] | undefined>((resolve) => {
        const socket = new WebSocket(url, [RACP_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${expired}` } });
        socket.once("unexpected-response", (_request, response) => {
          resolve(response.headers[RACP_UPGRADE_ERROR_HEADER]);
          socket.terminate();
        });
        socket.once("error", () => resolve(undefined));
      });
      expect(header).toBe("REMOTE_DEVICE_TOKEN_EXPIRED");
      await expect(new RacpClient({ transport: wsClientTransport({ url, token: expired }), client: { name: "t", version: "1" } }).connect())
        .rejects.toMatchObject({ code: "REMOTE_DEVICE_TOKEN_EXPIRED", retriable: false });
      await expect(new RacpClient({ transport: wsClientTransport({ url, token: newDeviceToken() }), client: { name: "t", version: "1" } }).connect())
        .rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
      const text = JSON.stringify(logs);
      expect(text).toContain("dev_old");
      expect(text).not.toContain(expired);
      expect(text).not.toContain("pdt1.");
    } finally {
      await binding.close();
    }
  });

  it("throttles repeated failed authentication with 429 and Retry-After, then recovers", async () => {
    const h = await harness();
    let now = 1_000_000;
    const binding = await bindRacpWebSocket({
      server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined,
      now: () => now, authRateLimit: { capacity: 3, refillIntervalMs: 1_000, baseBackoffMs: 5_000 },
    });
    try {
      const url = `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`;
      const attempt = (token: string) =>
        new Promise<{ status: number | "open"; retryAfter?: string }>((resolve) => {
          const socket = new WebSocket(url, [RACP_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${token}` } });
          socket.once("unexpected-response", (_request, response) => {
            const retryAfter = response.headers["retry-after"];
            resolve({ status: response.statusCode ?? 0, ...(typeof retryAfter === "string" ? { retryAfter } : {}) });
            socket.terminate();
          });
          socket.once("open", () => {
            resolve({ status: "open" });
            socket.terminate();
          });
          socket.once("error", () => resolve({ status: 0 }));
        });
      for (let index = 0; index < 3; index += 1) expect((await attempt("pdt1.guess")).status).toBe(401);
      // Exhausted: even a valid token waits out the backoff, and nothing is evaluated.
      expect(await attempt(OWNER_TOKEN)).toEqual({ status: 429, retryAfter: "5" });
      now += 5_000;
      expect((await attempt(OWNER_TOKEN)).status).toBe("open");
    } finally {
      await binding.close();
    }
  });

  it("refuses to bind a non-loopback address and plain ws to a non-loopback host", async () => {
    const h = await harness();
    await expect(bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, host: "0.0.0.0", port: 0, log: () => undefined })).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    await expect(wsClientTransport({ url: "ws://example.com/v1/racp/ws", token: OWNER_TOKEN })()).rejects.toMatchObject({ errorCode: "REMOTE_CONNECTION_FAILED" });
  });
});
