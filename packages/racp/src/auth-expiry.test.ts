import { describe, expect, it } from "vitest";
import { RACP_DEVICE_TOKEN_IDLE_TTL_MS, RACP_DEVICE_TOKEN_MAX_LIFETIME_MS } from "@pi-desktop/shared";

import { DeviceTokenAuthenticator, MemoryCredentialStore, deviceTokenExpiry, hashToken, newDeviceToken, type DeviceRecord } from "./auth.js";
import { AuthFailureRateLimiter } from "./auth-rate-limit.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

async function setup(record: Partial<DeviceRecord> = {}) {
  const clock = { now: T0 };
  const store = new MemoryCredentialStore();
  const token = newDeviceToken();
  await store.saveDevice({
    deviceId: "dev_1", label: "laptop", roles: ["owner"], tokenHash: hashToken(token),
    createdAt: new Date(T0).toISOString(), tokenIssuedAt: new Date(T0).toISOString(), ...record,
  });
  const authenticator = new DeviceTokenAuthenticator(store, () => clock.now);
  const verify = () => authenticator.verify({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" });
  return { clock, store, authenticator, verify, token };
}

describe("device token lifetime", () => {
  it("documents a 30-day idle window inside a 180-day absolute lifetime", () => {
    expect(RACP_DEVICE_TOKEN_IDLE_TTL_MS).toBe(30 * DAY);
    expect(RACP_DEVICE_TOKEN_MAX_LIFETIME_MS).toBe(180 * DAY);
  });

  it("refuses a token unused for the idle window and reports it as expired", async () => {
    const { clock, verify, authenticator, token } = await setup();
    clock.now = T0 + 30 * DAY - 1;
    expect((await verify()).kind).toBe("device");
    clock.now += 30 * DAY;
    expect(await verify()).toEqual({ kind: "rejected", reason: "expired", deviceId: "dev_1", expiry: "idle" });
    // The compatibility form still says only "no".
    expect(await authenticator.authenticate({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c" })).toBeNull();
  });

  it("slides the idle window with use and with the end of a connection", async () => {
    const { clock, verify, authenticator } = await setup();
    for (let day = 20; day <= 160; day += 20) {
      clock.now = T0 + day * DAY;
      expect((await verify()).kind).toBe("device");
    }
    clock.now = T0 + 175 * DAY;
    await authenticator.touch("dev_1");
    clock.now = T0 + 179 * DAY;
    expect((await verify()).kind).toBe("device");
  });

  it("refuses a token past its absolute lifetime however recently it was used", async () => {
    const { clock, verify } = await setup();
    for (let day = 25; day < 180; day += 25) {
      clock.now = T0 + day * DAY;
      expect((await verify()).kind).toBe("device");
    }
    clock.now = T0 + 180 * DAY;
    expect(await verify()).toMatchObject({ kind: "rejected", reason: "expired", expiry: "absolute" });
  });

  it("measures a legacy record without tokenIssuedAt from createdAt", () => {
    const legacy: DeviceRecord = { deviceId: "d", label: "l", roles: ["owner"], tokenHash: "00", createdAt: new Date(T0).toISOString() };
    expect(deviceTokenExpiry(legacy, T0 + DAY)).toBeNull();
    expect(deviceTokenExpiry(legacy, T0 + 31 * DAY)).toBe("idle");
    expect(deviceTokenExpiry({ ...legacy, createdAt: "garbage" }, T0)).toBe("absolute");
  });

  it("never reports expiry for a revoked or unknown token", async () => {
    const { clock, verify, store, authenticator } = await setup();
    clock.now = T0 + 200 * DAY;
    await store.revokeDevice("dev_1", new Date(clock.now).toISOString());
    expect(await verify()).toEqual({ kind: "rejected", reason: "invalid" });
    expect(await authenticator.verify({ authorization: `Bearer ${newDeviceToken()}`, urlHasToken: false, connectionId: "c" }))
      .toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("issues new pairings with a lifetime start", async () => {
    const { clock, authenticator, store } = await setup();
    const pairing = await authenticator.issuePairingToken(60_000);
    clock.now += 1_000;
    const { deviceId } = await authenticator.pair(hashToken(pairing.token), "second", ["owner"]);
    const record = (await store.listDevices()).find((device) => device.deviceId === deviceId);
    expect(record?.tokenIssuedAt).toBe(new Date(clock.now).toISOString());
  });
});

describe("failed-authentication rate limit", () => {
  it("allows a burst, then refuses with a doubling, capped backoff", () => {
    const clock = { now: 0 };
    const limiter = new AuthFailureRateLimiter({ capacity: 3, refillIntervalMs: 10_000, baseBackoffMs: 1_000, maxBackoffMs: 4_000 }, () => clock.now);
    for (let index = 0; index < 2; index += 1) {
      expect(limiter.check("127.0.0.1").allowed).toBe(true);
      limiter.recordFailure("127.0.0.1");
    }
    limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(limiter.check("::1").allowed).toBe(true);
    clock.now += 1_000;
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
    limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: false, retryAfterMs: 2_000 });
    clock.now += 2_000;
    limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: false, retryAfterMs: 4_000 });
    clock.now += 4_000;
    limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: false, retryAfterMs: 4_000 });
  });

  it("forgets an address once its bucket refills", () => {
    const clock = { now: 0 };
    const limiter = new AuthFailureRateLimiter({ capacity: 2, refillIntervalMs: 1_000, baseBackoffMs: 500, maxBackoffMs: 8_000 }, () => clock.now);
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.check("a").allowed).toBe(false);
    clock.now += 2_000;
    expect(limiter.check("a").allowed).toBe(true);
    // A fresh burst starts from the base backoff again.
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterMs: 500 });
  });
});
