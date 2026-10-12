/**
 * Developer-only settings destinations are retained in development builds
 * but omitted from packaged builds. Cloud sync and Remote Hosts are
 * Experimental destinations available in every build. Navigation, search,
 * and stale-page handling must honor the same visibility rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const composerToolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;
const developerOnlyIds = SETTINGS_NAV.filter(entry => entry.developerOnly === true).map(entry => entry.id);

test("there is no Voice settings destination (D662)", () => {
  assert.equal(SETTINGS_NAV.some((entry) => entry.id === "voice"), false);
  assert.deepEqual(searchSettings("voice", identity, { developerMode: true, includeDevelopmentOnly: true })
    .filter((hit) => hit.tab === "voice"), []);
});

test("Cloud sync is Experimental and available in every build", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(visibleSettingsNav(developerMode, includeDevelopmentOnly)
        .some((entry) => entry.id === "sync"));
      assert.equal(isSettingsDestinationHidden("sync", developerMode, includeDevelopmentOnly), false);
      for (const query of [
        "configSync.experimental",
        "configSync.connectionTitle",
        "configSync.endpoint",
        "configSync.syncNow",
      ]) {
        assert.ok(searchSettings(query, identity, {
          developerMode,
          includeDevelopmentOnly,
        }).some((hit) => hit.tab === "sync"));
      }
    }
  }
  const sync = SETTINGS_NAV.find((entry) => entry.id === "sync");
  assert.equal(sync?.developerOnly, undefined);
  assert.equal(sync?.developmentOnly, undefined);
  assert.equal(sync?.experimentalBadgeKey, "settings.configSync.experimental");
});

test("Remote Hosts is Experimental and available in every build", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(visibleSettingsNav(developerMode, includeDevelopmentOnly)
        .some((entry) => entry.id === "remoteHosts"));
      assert.equal(isSettingsDestinationHidden("remoteHosts", developerMode, includeDevelopmentOnly), false);
    }
  }
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "remoteHosts")?.experimentalBadgeKey,
    "settings.remoteHosts.experimental",
  );
});

test("developer mode retains the developer-only destinations in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  for (const id of developerOnlyIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !developerOnlyIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    developerOnlyIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
  // Cloud sync remains available in development builds.
  assert.equal(off.includes("sync"), true);
});

test("packaged builds hide developer-only destinations and retain Experimental surfaces", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  for (const id of developerOnlyIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  for (const id of ["sync", "remoteHosts"]) {
    assert.equal(packaged.includes(id), true);
    assert.equal(isSettingsDestinationHidden(id, true, false), false);
    assert.equal(isSettingsDestinationHidden(id, false, false), false);
  }
  assert.equal(isSettingsDestinationHidden("general", true, false), false);
});

test("settings search mirrors developer and packaged visibility", () => {
  for (const options of [{ developerMode: false }, { developerMode: true }]) {
    assert.ok(
      searchSettings("configSync.connectionTitle", identity, options)
        .some((hit) => hit.tab === "sync"),
    );
  }

  for (const options of [
    { developerMode: false, includeDevelopmentOnly: false },
    { developerMode: true, includeDevelopmentOnly: false },
  ]) {
    assert.ok(
      searchSettings("configSync.connectionTitle", identity, options)
        .some((hit) => hit.tab === "sync"),
    );
  }

  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(searchSettings("remotehosts", identity, { developerMode, includeDevelopmentOnly })
        .some(hit => hit.tab === "remoteHosts"));
    }
  }
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.doesNotMatch(composer, /useVoiceInput|VoiceOverlay|voiceEnabled/);
  assert.doesNotMatch(composerToolbar, /LiveVoice/);
  assert.doesNotMatch(composerToolbar, /VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/);
});
