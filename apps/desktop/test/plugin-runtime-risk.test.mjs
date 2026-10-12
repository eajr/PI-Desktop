import {
  readPluginsSourceSync,
  readStoreModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { en } from "../../../packages/i18n/dist/locales/en/index.js";
import { zhCN } from "../../../packages/i18n/dist/locales/zh-CN/index.js";
import { tr } from "../../../packages/i18n/dist/locales/tr/index.js";
import { ko } from "../../../packages/i18n/dist/locales/ko/index.js";

const catalogs = { en, "zh-CN": zhCN, tr, ko };

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const panelSrc = readFileSync(join(desktopRoot, "electron/main/plugin-panel-host.ts"), "utf8");
const mainSrc = readMainSourceSync();
const pageSrc = readPluginsSourceSync();
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");
const catalogSliceSrc = readStoreModuleSync("slices/catalog-slice.ts");
const registrySrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/registry.rs"), "utf8");
const validationSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/validation.rs"), "utf8");
const installSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/install.rs"), "utf8");

test("plugin runtime exposes gated high-risk host APIs", () => {
  for (const token of [
    "fs.write",
    "fs.delete",
    "fs.openDefault",
    "fs.reveal",
    "net.fetch",
    "agent.complete",
    "desktop.control",
    "session.read",
    "session.autoTitle",
    "models.list",
    "shell.openExternal",
    "clipboard.read",
    "clipboard.write",
    "assertPermission",
  ]) {
    assert.match(runtimeSrc, new RegExp(token.replaceAll(".", "\\.")));
  }
});

test("large-file host reads stay behind the fs.read gateway", () => {
  for (const api of ["fs.stat", "fs.readRange", "fs.registerDropped"]) {
    assert.match(runtimeSrc, new RegExp(`\\"${api}\\"`));
  }
  assert.match(runtimeSrc, /MAX_FS_READ_RANGE_BYTES/);
  assert.match(runtimeSrc, /dropped-file grants are read-only/);
  assert.match(runtimeSrc, /new Map\(\)/);
});

test("native plugin notifications stay behind the existing notify permission", () => {
  for (const channel of [
    "ui.getNotificationPermission",
    "ui.requestNotificationPermission",
    "ui.showNativeNotification",
  ]) {
    assert.match(runtimeSrc, new RegExp(`\\"${channel}\\"`));
  }
  assert.match(runtimeSrc, /getNotificationPermission: async \(\) => \{/);
  assert.match(runtimeSrc, /requestNotificationPermission: async \(\) => \{/);
  assert.match(runtimeSrc, /showNativeNotification: async \(input/);
  assert.match(runtimeSrc, /this\.assertPermission\(loaded, "notify"\)/);
});

test("workspace deletion and panel operations stay bounded", () => {
  assert.match(runtimeSrc, /PANEL_SKILL_CHANNELS/);
  assert.match(runtimeSrc, /method: "panel.invoke"/);
  assert.match(runtimeSrc, /"fs.remove"/);
  assert.match(runtimeSrc, /recursive: false/);
  assert.match(runtimeSrc, /cannot remove the root itself/);
  // Deleting goes to the OS trash, so a delete this gate got wrong is still
  // recoverable; `rmSync` survives only as the fallback for a host that has no
  // trash to offer.
  assert.match(runtimeSrc, /this\.services\.trashItem\(full\)/);
  // A single-file remove in a loop empties a workspace as well as `rm -rf`;
  // the rolling window is what tells the two apart.
  assert.match(runtimeSrc, /MAX_DELETES_PER_WINDOW/);
});

test("the plugins page shows the file scope behind a file permission", () => {
  // A permission name says "may touch files"; only the scope says which ones,
  // so the row has to carry it or the user is approving a blank cheque.
  assert.match(pageSrc, /"fs\.write": "high"/);
  assert.match(pageSrc, /"fs\.read": "medium"/);
  assert.match(pageSrc, /"background\.service": "medium"/);
  assert.match(pageSrc, /function FsScopeChips\(/);
  assert.match(pageSrc, /t\("plugins\.fsAsksEachTime"\)/);
  assert.match(pageSrc, /t\("plugins\.legacyFsDowngraded"\)/);
  // The scope reaches the renderer from the registry, not from a second read
  // of the manifest, so an old record simply has no scope to show.
  assert.match(registrySrc, /fs: manifest\.fs\.clone\(\)/);
  for (const catalog of Object.values(catalogs)) {
    assert.equal(typeof catalog.plugins.legacyFsDowngraded, "string");
    assert.equal(typeof catalog.plugins.fsMode.delete, "string");
    assert.equal(typeof catalog.plugins.permissions["fs.delete"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["fs.delete"], "string");
    assert.equal(typeof catalog.plugins.permissions["agent.complete"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["session.read"], "string");
    assert.equal(typeof catalog.plugins.permissions["session.autoTitle"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["session.autoTitle"], "string");
    assert.equal(typeof catalog.plugins.permissions["models.list"], "string");
    assert.equal(typeof catalog.plugins.permissions["ui.microphone"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["ui.microphone"], "string");
    assert.equal(typeof catalog.plugins.permissions["desktop.control"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["desktop.control"], "string");
  }
});

test("plugin panels use sandboxed isolated host windows", () => {
  assert.match(panelSrc, /session\.fromPartition/);
  assert.match(panelSrc, /sandbox:\s*true/);
  assert.match(panelSrc, /nodeIntegration:\s*false/);
  assert.match(panelSrc, /plugin-panel\.js/);
  assert.match(panelSrc, /allowMicrophone/);
  assert.match(runtimeSrc, /this\.assertPermission\(loaded, "desktop\.control"\)/);
  assert.match(runtimeSrc, /desktop\.listOperations/);
  assert.match(runtimeSrc, /desktop\.invoke/);
});

// This build has no remote plugin marketplace (ADR
// fork-removes-plugin-marketplace): plugins arrive bundled, from a local
// package, or from a development folder, and nothing is fetched to find,
// install, or update one.
test("plugins page offers local installs and no marketplace", () => {
  assert.match(pageSrc, /api\.installPluginFromPackage\(\)/);
  assert.match(pageSrc, /permissionReview|grantedPermissions/);
  assert.doesNotMatch(
    pageSrc,
    /api\.market[A-Z]|tabMarket|applyAutoUpdates|checkUpdates|setPluginAutoUpdate|onPluginInstallProgress/,
  );
});

test("the installed-plugin refresh is shared, not duplicated", () => {
  assert.match(
    catalogSliceSrc,
    /const existing = catalogRuntime\.getPluginRefresh\(\);\s*if \(existing\) return existing/,
  );
});

test("shared protocol declares package install IPC and no marketplace IPC", () => {
  for (const channel of ["pluginInstallFromPackage", "pluginOpenPanel"]) {
    assert.match(protocolSrc, new RegExp(channel));
  }
  for (const channel of [
    "marketSearch",
    "marketGetDetail",
    "marketInstall",
    "marketCancelInstall",
    "marketCheckUpdates",
    "marketApplyUpdates",
    "marketRefresh",
    "pluginSetAutoUpdate",
    "pluginInstallProgress",
  ]) {
    assert.doesNotMatch(protocolSrc, new RegExp(`\\b${channel}\\b`));
  }
});

test("host-core plugin install has no network download path", () => {
  const hostSrc = validationSrc + "\n" + installSrc;
  assert.doesNotMatch(hostSrc, /PACKAGE_HOST_ALLOWLIST|package_host_allowed|download_url/);
  assert.doesNotMatch(hostSrc, /Command::new\("curl"\)|TcpStream/);
  assert.match(installSrc, /pub fn install_from_path\(/);
});

test("PERMISSION_RISK mirrors every permission tier in the permissions matrix (#1480)", () => {
  const matrixPath = join(repoRoot, "docs/spec/07-plugins/13-plugin-permissions-matrix.md");
  const matrixContent = readFileSync(matrixPath, "utf8");
  const matrixEntries = [...matrixContent.matchAll(/^\| `([A-Za-z0-9.]+)` \| (low|medium|high) \|/gm)].map((m) => ({
    permission: m[1],
    risk: m[2],
  }));

  assert.ok(matrixEntries.length > 0, "permissions matrix must contain permission rows");

  const matrixMap = Object.fromEntries(matrixEntries.map((e) => [e.permission, e.risk]));
  const modelEntries = [...pageSrc.matchAll(/"([a-zA-Z0-9.]+)":\s*"(low|medium|high)"/g)].map((m) => ({
    permission: m[1],
    risk: m[2],
  }));
  const modelMap = Object.fromEntries(modelEntries.map((e) => [e.permission, e.risk]));

  for (const [permission, expectedRisk] of Object.entries(matrixMap)) {
    assert.equal(
      modelMap[permission],
      expectedRisk,
      `PERMISSION_RISK["${permission}"] should be "${expectedRisk}" as defined in permissions matrix`,
    );
  }

  assert.deepEqual(
    Object.keys(modelMap).sort(),
    Object.keys(matrixMap).sort(),
    "PERMISSION_RISK must define exactly the set of permissions from the permissions matrix",
  );
});
