import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ADR electron-fuses-and-packaged-code-paths: every fuse is pinned explicitly
// so a packaging change cannot silently fall back to Electron's defaults.
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const entitlements = await readFile(
  new URL("../build/entitlements.mac.plist", import.meta.url),
  "utf8",
);
const sidecarSource = await readFile(
  new URL("../electron/main/agent-sidecar.ts", import.meta.url),
  "utf8",
);

test("electron-builder pins every Electron fuse to the decided value", () => {
  assert.deepEqual(packageJson.build.electronFuses, {
    // The agent sidecar runs on the Electron binary as Node (D008).
    runAsNode: true,
    enableCookieEncryption: true,
    // Disabling it also drops the documented NODE_EXTRA_CA_CERTS trust input.
    enableNodeOptionsEnvironmentVariable: true,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    // The renderer is loaded from file:// with module scripts.
    grantFileProtocolExtraPrivileges: true,
    // Unsigned arm64 macOS packs need a valid ad-hoc signature after flipping.
    resetAdHocDarwinSignature: true,
  });
});

test("asar integrity has an asar to validate", () => {
  assert.notEqual(packageJson.build.asar, false);
  assert.ok(packageJson.build.files.includes("out/**/*"));
});

test("runAsNode stays enabled only while the sidecar needs it", () => {
  // If the sidecar stops launching through ELECTRON_RUN_AS_NODE, flip the
  // runAsNode fuse off in the same change.
  assert.match(sidecarSource, /command: process\.execPath/);
  assert.match(sidecarSource, /ELECTRON_RUN_AS_NODE: "1"/);
});

test("macOS entitlements stay the minimum hardened-runtime set", () => {
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.device.audio-input",
  ]);
  assert.doesNotMatch(entitlements, /<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>/);
  assert.doesNotMatch(entitlements, /<key>com\.apple\.security\.cs\.allow-dyld-environment-variables<\/key>/);
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
});
