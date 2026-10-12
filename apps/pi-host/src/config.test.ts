import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs, resolveConfig } from "./config.js";
import { DeviceTokenAuthenticator, hashToken, newDeviceToken } from "@pi-desktop/racp";
import { CREDENTIAL_FILE_VERSION, FileCredentialStore, loadOrCreateHostId } from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-host-test-"));
  dirs.push(dir);
  return dir;
}

describe("config", () => {
  it("parses flags with and without values and validates the port", () => {
    expect(parseArgs(["--pair", "--port", "4123", "--data-dir=/x", "--host-core", "/bin/hc"])).toEqual({ pair: true, port: "4123", "data-dir": "/x", "host-core": "/bin/hc" });
    const config = resolveConfig({ "data-dir": "/data", port: "4123", "host-core": "/bin/hc", sidecar: "/s.js", pair: true }, {});
    expect(config).toMatchObject({ dataDir: "/data", port: 4123, host: "127.0.0.1", hostCoreBinary: "/bin/hc", sidecarEntry: "/s.js", pair: true, logLevel: "info" });
    expect(() => resolveConfig({ port: "70000", "host-core": "/bin/hc", sidecar: "/s.js" }, {})).toThrow(/invalid port/);
    expect(() => resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", port: "abc" }, {})).toThrow(/invalid port/);
    expect(resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", "log-level": "warn" }, {}).logLevel).toBe("warn");
  });
});

describe("identity and credentials", () => {
  it("mints the host id once and keeps it across restarts", async () => {
    const dir = await tempDir();
    const first = await loadOrCreateHostId(dir);
    expect(first.startsWith("host_")).toBe(true);
    expect(await loadOrCreateHostId(dir)).toBe(first);
    const info = await stat(join(dir, "pi-host", "identity.json"));
    expect(info.mode & 0o077).toBe(0);
  });

  it("stores devices and pairings hashed, owner-readable, and survives a reload", async () => {
    const dir = await tempDir();
    const store = new FileCredentialStore(dir);
    await store.saveDevice({ deviceId: "dev_1", label: "laptop", roles: ["owner"], tokenHash: "ab".repeat(32), createdAt: "2026-09-18T00:00:00.000Z" });
    await store.savePairing({ tokenHash: "cd".repeat(32), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await store.savePairing({ tokenHash: "ef".repeat(32), expiresAt: "2000-01-01T00:00:00.000Z" });
    const raw = await readFile(join(dir, "pi-host", "credentials.json"), "utf8");
    expect(raw).not.toContain("pdt1.");
    expect(raw).toContain("ab".repeat(32));
    expect(raw).not.toContain("ef".repeat(32));
    const info = await stat(join(dir, "pi-host", "credentials.json"));
    expect(info.mode & 0o077).toBe(0);

    const reloaded = new FileCredentialStore(dir);
    expect((await reloaded.findDeviceByTokenHash("ab".repeat(32)))?.deviceId).toBe("dev_1");
    expect(await reloaded.consumePairing("cd".repeat(32), "2026-09-18T00:00:01.000Z")).toBe(true);
    expect(await reloaded.consumePairing("cd".repeat(32), "2026-09-18T00:00:02.000Z")).toBe(false);
    expect(await reloaded.revokeDevice("dev_1", "2026-09-18T00:00:03.000Z")).toBe(true);
    expect(await reloaded.revokeDevice("dev_1", "2026-09-18T00:00:04.000Z")).toBe(false);
    const again = new FileCredentialStore(dir);
    expect((await again.listDevices())[0]?.revokedAt).toBe("2026-09-18T00:00:03.000Z");
    expect(await again.findPairing("cd".repeat(32))).toBeNull();
  });

  it("migrates a version 1 file by starting existing tokens' lifetime at migration time", async () => {
    const dir = await tempDir();
    const token = newDeviceToken();
    // Paired a year ago and never seen since: under expiry rules alone this
    // device would be refused on the first connection after upgrading.
    const legacy = {
      devices: [{ deviceId: "dev_old", label: "laptop", roles: ["owner"], tokenHash: hashToken(token), createdAt: "2025-01-01T00:00:00.000Z" }],
      pairings: [],
    };
    await mkdir(join(dir, "pi-host"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "pi-host", "credentials.json"), JSON.stringify(legacy), { mode: 0o600 });
    const migratedAt = Date.parse("2026-10-01T00:00:00.000Z");
    let now = migratedAt;
    const store = new FileCredentialStore(dir, () => now);
    const authenticator = new DeviceTokenAuthenticator(store, () => now);
    const verify = () => authenticator.verify({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" });
    expect((await verify()).kind).toBe("device");

    const file = JSON.parse(await readFile(join(dir, "pi-host", "credentials.json"), "utf8"));
    expect(file.version).toBe(CREDENTIAL_FILE_VERSION);
    expect(file.devices[0]).toMatchObject({ createdAt: "2025-01-01T00:00:00.000Z", tokenIssuedAt: "2026-10-01T00:00:00.000Z" });

    // A restart does not move the migration time; the token ages from it.
    now = migratedAt + 20 * 24 * 60 * 60 * 1000;
    const restarted = new DeviceTokenAuthenticator(new FileCredentialStore(dir, () => now), () => now);
    expect((await restarted.verify({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" })).kind).toBe("device");
    now = migratedAt + 181 * 24 * 60 * 60 * 1000;
    const late = new DeviceTokenAuthenticator(new FileCredentialStore(dir, () => now), () => now);
    expect(await late.verify({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" }))
      .toMatchObject({ kind: "rejected", reason: "expired", expiry: "absolute" });
  });

  it("persists last use so the idle window survives a restart", async () => {
    const dir = await tempDir();
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const store = new FileCredentialStore(dir, () => now);
    const token = newDeviceToken();
    const issuedAt = new Date(now).toISOString();
    await store.saveDevice({ deviceId: "dev_1", label: "laptop", roles: ["owner"], tokenHash: hashToken(token), createdAt: issuedAt, tokenIssuedAt: issuedAt });
    now += 25 * 24 * 60 * 60 * 1000;
    await store.touchDevice("dev_1", new Date(now).toISOString());
    // An older touch never moves last use backwards.
    await store.touchDevice("dev_1", issuedAt);
    now += 25 * 24 * 60 * 60 * 1000;
    const restarted = new DeviceTokenAuthenticator(new FileCredentialStore(dir, () => now), () => now);
    expect((await restarted.verify({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" })).kind).toBe("device");
  });
});
