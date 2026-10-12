import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { DeviceTokenAuthenticator, MemoryCredentialStore, hashToken } from "@pi-desktop/racp";

import { ADMIN_MAX_BYTES, ADMIN_PAIRING_LIFETIME_MS, startAdminSocket, type AdminSocket } from "./admin-socket.js";
import { runPairingIssue } from "./pairing-issue.js";
import { readCapped } from "./provider-import.js";

const initialCwd = process.cwd();
const directories: string[] = [];
const servers: AdminSocket[] = [];
beforeAll(() => { process.chdir(process.env.PI_SCRATCH_DIR ?? tmpdir()); });
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
afterAll(() => { process.chdir(initialCwd); });

async function fixture(withPairing = true) {
  const dataDir = await mkdtemp(join(process.cwd(), "pairing-admin-"));
  directories.push(dataDir);
  const store = new MemoryCredentialStore();
  const authenticator = new DeviceTokenAuthenticator(store);
  const logs: unknown[] = [];
  const lifetimes: number[] = [];
  const server = await startAdminSocket({
    dataDir, getHost: () => null, log: (...entry) => logs.push(entry),
    ...(withPairing ? { issuePairing: (lifetimeMs: number) => { lifetimes.push(lifetimeMs); return authenticator.issuePairingToken(lifetimeMs); } } : {}),
  });
  servers.push(server);
  return { dataDir, server, store, authenticator, logs, lifetimes };
}

async function cli(dataDir: string) {
  let stdout = "";
  const code = await runPairingIssue(["--data-dir", dataDir], {
    stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
  });
  return { code, stdout };
}

describe("pairing-issue over the owner-only admin socket", () => {
  it("prints one short-lived pairing token the running Host accepts, and never logs it", async () => {
    const { dataDir, store, authenticator, logs, lifetimes } = await fixture();
    const { code, stdout } = await cli(dataDir);
    expect(code).toBe(0);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stdout.startsWith("PI_HOST_PAIRING_TOKEN ")).toBe(true);
    const { token } = JSON.parse(stdout.slice("PI_HOST_PAIRING_TOKEN ".length)) as { token: string; expiresAt: string };
    expect(token.startsWith("ppt1.")).toBe(true);
    expect(lifetimes).toEqual([ADMIN_PAIRING_LIFETIME_MS]);
    expect(await store.findPairing(hashToken(token))).not.toBeNull();
    const verified = await authenticator.verify({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" });
    expect(verified.kind).toBe("pairing");
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it("refuses extra fields and reports an unavailable channel without a token", async () => {
    const { server } = await fixture();
    const socket = createConnection(server.path);
    socket.on("error", () => undefined);
    const response = readCapped(socket, ADMIN_MAX_BYTES, 2000);
    socket.once("connect", () => socket.end(JSON.stringify({ op: "pairing.issue", roles: ["owner"] })));
    try { expect(JSON.parse(await response)).toEqual({ ok: false, code: "INVALID_REQUEST" }); } finally { socket.destroy(); }

    const bare = await fixture(false);
    expect(await cli(bare.dataDir)).toEqual({ code: 1, stdout: 'PI_HOST_FAILED {"code":"ADMIN_UNAVAILABLE"}\n' });
  });

  it("fails cleanly when no Host is running", async () => {
    const dataDir = await mkdtemp(join(process.cwd(), "pairing-none-"));
    directories.push(dataDir);
    const result = await cli(dataDir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('PI_HOST_FAILED {"code":"ADMIN_UNAVAILABLE"}\n');
  });
});
