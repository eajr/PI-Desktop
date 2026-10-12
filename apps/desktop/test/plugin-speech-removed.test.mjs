import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Host speech adapters were removed. A plugin that still declares the old
// `speech.adapter.register` permission must load, and a call to the removed
// `pi.speech` API must fail clearly at call time with UNSUPPORTED.

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const dataDir = mkdtempSync(join(tmpdir(), "pi-speech-removed-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const PLUGIN_ID = "com.example.legacy-speech";

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-speech-removed-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Legacy Speech Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions: ["speech.adapter.register"],
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "main.js"),
    `
  module.exports = {
    async onPanelInvoke(channel) {
      try {
        if (channel === "register") {
          await pi.speech.registerAdapter({
            protocol: "example.tts",
            label: "Example TTS",
            roles: ["synthesize"],
            handle: async () => ({ kind: "text", text: "x" }),
          });
        } else {
          await pi.speech.unregisterAdapter("example.tts");
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, code: error.code, message: String(error.message) };
      }
    },
  };
`,
    "utf8",
  );
  return dir;
}

test("a plugin declaring the removed speech permission loads and gets UNSUPPORTED from pi.speech", async (t) => {
  const runtime = new PluginRuntime({ hostEntry: hostProcessEntry, spawnProcess: forkPluginProcess });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  await runtime.loadFromPath(writePlugin(t));
  assert.deepEqual(runtime.listLoaded().map((loaded) => loaded.manifest.id), [PLUGIN_ID]);

  for (const channel of ["register", "unregister"]) {
    const answer = await runtime.invokePanelBridge(PLUGIN_ID, channel);
    assert.equal(answer.ok, false, channel);
    assert.equal(answer.code, "UNSUPPORTED", channel);
    assert.match(answer.message, /host api not available: speech\./);
  }
  assert.equal(typeof runtime.listSpeechAdapters, "undefined");
});
