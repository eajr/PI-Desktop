import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");
const { APP_UPDATES_ENABLED } = await import("../electron/main/update-build-flag.ts");
const { buildApplicationMenuTemplate } = await import(
  "../electron/main/application-menu.ts"
);

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  downloadStarts = [];
  cancellations = [];

  async checkForUpdates() {
    this.emit("checking-for-update");
    const info = {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload
      ? (this.downloadStarts.push(info.version), Promise.resolve([]))
      : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  quitAndInstall() {}
}

function createController({
  updater,
  settings = {},
  persist = async () => {},
  updatesEnabled = true,
}) {
  const logger = { app: () => {} };
  const sent = [];
  const controller = new AppUpdaterController({
    logger,
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform: "darwin",
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => settings,
    persistDismissedVersion: persist,
    updatesEnabled,
  });
  return { controller, sent };
}

test("dismissing an in-app update cancels its download and disables install on quit", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const { controller } = createController({
    updater,
    persist: async (version) => persisted.push(version),
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
  assert.equal(controller.getState().status, "downloading");

  await controller.dismiss();

  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, "available");
  assert.equal(controller.getState().dismissed, true);
  assert.deepEqual(persisted, ["0.16.1"]);
  controller.dispose();
});

test("a restored dismissal blocks that release and a newer release resumes automatic delivery", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  let clearDismissal;
  const cleared = new Promise((resolve) => {
    clearDismissal = resolve;
  });
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.1" },
    persist: async (version) => {
      persisted.push(version);
      if (version === null) clearDismissal();
    },
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().dismissed, true);

  updater.nextVersion = "0.16.2";
  await controller.check();
  await cleared;
  assert.deepEqual(updater.downloadStarts, ["0.16.2"]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(controller.getState().dismissed, false);
  assert.deepEqual(persisted, [null]);
  controller.dispose();
});

test("this fork compiles the updater out by default", () => {
  assert.equal(APP_UPDATES_ENABLED, false);
});

test("a build with the updater compiled out never contacts the update feed", async (t) => {
  const updater = new FakeUpdater();
  let feedCalls = 0;
  updater.checkForUpdates = async () => {
    feedCalls += 1;
    throw new Error("feed must not be contacted");
  };
  updater.downloadUpdate = async () => {
    feedCalls += 1;
    throw new Error("feed must not be contacted");
  };
  const scheduled = [];
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn, ms, ...args) => {
    scheduled.push(["timeout", ms]);
    return realSetTimeout(fn, ms, ...args);
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    scheduled.push(["interval", ms]);
    return realSetInterval(fn, ms, ...args);
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  });

  // Packaged macOS would default to automatic in-app delivery when enabled.
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic" },
    updatesEnabled: false,
  });
  const state = controller.getState();
  assert.equal(state.mode, "disabled");
  assert.equal(state.disabledReason, "build");
  assert.equal(updater.listenerCount("update-available"), 0);
  assert.equal(updater.listenerCount("error"), 0);

  controller.startAutoCheck();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.reclaimRelocatedUpdateCache();
  controller.setPreference("automatic");
  await assert.rejects(controller.check(), /disabled in this build/);
  await assert.rejects(controller.check({ manual: true }), /disabled in this build/);
  await assert.rejects(controller.download(), /not supported/);
  await assert.rejects(controller.openReleases(), /disabled in this build/);
  assert.throws(() => controller.install(), /no downloaded update/);

  assert.equal(feedCalls, 0);
  assert.deepEqual(scheduled, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().mode, "disabled");
  controller.dispose();
});

test("an enabled packaged build still schedules feed checks", async (t) => {
  const updater = new FakeUpdater();
  const scheduled = [];
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn, ms) => {
    scheduled.push(["timeout", ms]);
    return realSetTimeout(() => {}, 0);
  };
  globalThis.setInterval = (fn, ms) => {
    scheduled.push(["interval", ms]);
    return realSetInterval(() => {}, 1_000_000);
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  });
  const { controller } = createController({ updater });
  assert.equal(controller.getState().disabledReason, undefined);
  controller.startAutoCheck();
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  assert.deepEqual(
    scheduled.map(([kind]) => kind),
    ["timeout", "interval"],
  );
  controller.dispose();
});

test("the macOS menu omits Check for Updates when the updater is compiled out", () => {
  const labelsOf = (updatesEnabled) =>
    JSON.stringify(
      buildApplicationMenuTemplate({
        platform: "darwin",
        updatesEnabled,
        dispatch: () => {},
        dispatchNative: () => {},
      }).map((item) => item.submenu),
    );
  assert.match(labelsOf(true), /Check for Updates/i);
  assert.doesNotMatch(labelsOf(false), /Check for Updates/i);
  assert.doesNotMatch(
    JSON.stringify(
      buildApplicationMenuTemplate({
        platform: "darwin",
        dispatch: () => {},
        dispatchNative: () => {},
      }).map((item) => item.submenu),
    ),
    /Check for Updates/i,
    "the default follows APP_UPDATES_ENABLED",
  );
});
