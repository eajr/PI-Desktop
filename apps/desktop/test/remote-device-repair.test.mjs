import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");
const { PAIRING_ISSUE_COMMAND, repairDeviceOverSsh } = await import("../electron/main/remote/remote-device-repair.ts");
const { remoteHostErrorKey } = await import("../src/lib/remote-host-errors.ts");

const encryption = {
  isAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (buf) => buf.toString("utf8").slice("enc:".length),
};
const SSH = { host: "remote.example", remotePort: 1234, version: "0.15.0", hostId: "host_1" };
const expired = () => Object.assign(new Error("upgrade refused: 401"), { errorCode: "REMOTE_DEVICE_TOKEN_EXPIRED" });

function adapterFor(record, connections) {
  let state = "disconnected";
  return {
    state: () => state,
    async connect() {
      connections.push(record.deviceToken);
      if (record.deviceToken === "pdt1.old") throw expired();
      if (record.deviceToken === "pdt1.revoked") throw Object.assign(new Error("upgrade refused: 401"), { errorCode: "REMOTE_AUTH_FAILED" });
      state = "connected";
    },
    async close() { state = "disconnected"; },
    client: {
      request: async (method) => {
        if (method === "session/list") return { sessions: [] };
        if (method === "events/subscribe") return { subscriptionId: "sub-host", starting: { epoch: "e1", sequence: 1 }, replayComplete: true };
        return { ok: true };
      },
      subscribe: () => () => undefined,
    },
  };
}

async function boot(repairDevice) {
  const dir = await mkdtemp(join(tmpdir(), "remote-repair-"));
  const connections = [];
  const tunnelEvents = [];
  const tunnels = {
    open: async (hostKey) => { tunnelEvents.push(`open:${hostKey}`); return { url: "ws://127.0.0.1:4000/v1/racp/ws", localPort: 4000 }; },
    close: async (hostKey) => { tunnelEvents.push(`close:${hostKey}`); },
    adopt: async () => undefined,
    dispose: async () => undefined,
  };
  const hosts = createRemoteHostsBoot({
    dataDir: dir, encryption, router: createBackendRouter(), emit: () => undefined,
    clientInfo: { name: "test", version: "0.15.0" }, tunnels,
    buildAdapter: (record) => adapterFor(record, connections), repairDevice,
  });
  await hosts.registry.upsert({
    hostKey: "box", label: "Box", url: "ws://127.0.0.1:1/v1/racp/ws", deviceToken: "pdt1.old",
    sshSecret: "pw", metadata: { transport: "ssh", ssh: SSH },
  });
  return { hosts, connections, tunnelEvents, cleanup: async () => { await hosts.closeAll(); await rm(dir, { recursive: true, force: true }); } };
}

test("an expired device token re-pairs over SSH once and the new token is persisted", async () => {
  const calls = [];
  const { hosts, connections, cleanup } = await boot(async (record, url) => {
    calls.push({ hostKey: record.hostKey, label: record.label, url, sshSecret: record.sshSecret });
    return "pdt1.new";
  });
  try {
    assert.equal(await hosts.open(), 1);
    assert.deepEqual(calls, [{ hostKey: "box", label: "Box", url: "ws://127.0.0.1:4000/v1/racp/ws", sshSecret: "pw" }]);
    assert.deepEqual(connections, ["pdt1.old", "pdt1.new"]);
    const [stored] = await hosts.registry.list();
    assert.equal(stored.deviceToken, "pdt1.new");
    assert.deepEqual(stored.metadata, { transport: "ssh", ssh: SSH });
    assert.equal(stored.sshSecret, "pw");
    assert.equal((await hosts.list())[0].status, "connected");
  } finally { await cleanup(); }
});

test("a failed re-pair leaves the host action-required with its old token", async () => {
  const { hosts, connections, tunnelEvents, cleanup } = await boot(async () => {
    throw Object.assign(new Error("Remote Host re-pairing over SSH failed"), { errorCode: "REMOTE_DEVICE_TOKEN_EXPIRED" });
  });
  try {
    await assert.rejects(hosts.ensureReady("box"), { errorCode: "REMOTE_DEVICE_TOKEN_EXPIRED" });
    assert.deepEqual(connections, ["pdt1.old"]);
    assert.equal((await hosts.registry.list())[0].deviceToken, "pdt1.old");
    assert.equal((await hosts.list())[0].status, "action-required");
    assert.equal(tunnelEvents.at(-1), "close:box");
  } finally { await cleanup(); }
});

test("a revoked or unknown token is never re-paired automatically", async () => {
  let repairs = 0;
  const { hosts, connections, cleanup } = await boot(async () => { repairs++; return "pdt1.new"; });
  try {
    const [record] = await hosts.registry.list();
    await hosts.registry.upsert({ ...record, deviceToken: "pdt1.revoked" });
    await assert.rejects(hosts.ensureReady("box"), { errorCode: "REMOTE_AUTH_FAILED" });
    assert.equal(repairs, 0);
    assert.deepEqual(connections, ["pdt1.revoked"]);
    assert.equal((await hosts.list())[0].status, "action-required");
  } finally { await cleanup(); }
});

test("repairDeviceOverSsh mints over SSH, never echoes the token in errors, and checks the Host id", async () => {
  const commands = [];
  let disposed = 0;
  const transport = (stdout, code = 0) => () => ({
    exec: async (command) => { commands.push(command); return { stdout, stderr: "", code }; },
    execWithInput: async () => { throw new Error("unused"); },
    forward: async () => { throw new Error("unused"); },
    dispose: () => { disposed++; },
  });
  const exchanges = [];
  const token = await repairDeviceOverSsh({
    ssh: SSH, url: "ws://127.0.0.1:4000/v1/racp/ws", label: "Box",
    buildTransport: transport('PI_HOST_PAIRING_TOKEN {"token":"ppt1.fresh","expiresAt":"2026-10-12T00:02:00.000Z"}\n'),
    exchangePairing: async (input) => { exchanges.push(input); return "pdt1.minted"; },
  });
  assert.equal(token, "pdt1.minted");
  assert.deepEqual(commands, [PAIRING_ISSUE_COMMAND]);
  assert.deepEqual(exchanges, [{ url: "ws://127.0.0.1:4000/v1/racp/ws", pairingToken: "ppt1.fresh", label: "Box", expectedHostId: "host_1" }]);
  assert.equal(disposed, 1);

  for (const [stdout, code] of [['PI_HOST_FAILED {"code":"ADMIN_UNAVAILABLE"}\n', 1], ['PI_HOST_PAIRING_TOKEN {"token":"ppt1.leak"}\n', 1], ["", 0]]) {
    await assert.rejects(
      repairDeviceOverSsh({ ssh: SSH, url: "ws://x", label: "Box", buildTransport: transport(stdout, code), exchangePairing: async () => "never" }),
      (error) => error.errorCode === "REMOTE_DEVICE_TOKEN_EXPIRED" && !String(error.message).includes("ppt1.") && !JSON.stringify(error).includes("ppt1."),
    );
  }
});

test("an expired token that could not be re-paired asks for authentication in the UI", () => {
  assert.equal(remoteHostErrorKey({ errorCode: "REMOTE_DEVICE_TOKEN_EXPIRED" }), "remote:authenticationRequired");
});
