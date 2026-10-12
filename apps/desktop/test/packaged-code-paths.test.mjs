import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_PLUGINS_DIR_ENV,
  HOST_BIN_ENV,
  builtinPluginsDirCandidates,
  hostBinaryCandidates,
} from "../electron/main/packaged-code-paths.ts";

const base = {
  env: {
    [HOST_BIN_ENV]: "/tmp/evil/host-core",
    [BUILTIN_PLUGINS_DIR_ENV]: "/tmp/evil/plugins",
  },
  resourcesPath: "/opt/PI-Desktop/resources",
  moduleDirectory: "/opt/PI-Desktop/resources/app.asar/out/main",
  platform: "linux",
};

test("packaged builds ignore the host binary override and source fallbacks", () => {
  assert.deepEqual(hostBinaryCandidates({ ...base, isPackaged: true }), [
    join("/opt/PI-Desktop/resources", "bin/pi-desktop-host-core"),
  ]);
  assert.deepEqual(
    hostBinaryCandidates({ ...base, isPackaged: true, platform: "win32" }),
    [join("/opt/PI-Desktop/resources", "bin/pi-desktop-host-core.exe")],
  );
});

test("packaged builds ignore the bundled plugin directory override", () => {
  assert.deepEqual(builtinPluginsDirCandidates({ ...base, isPackaged: true }), [
    join("/opt/PI-Desktop/resources", "plugins"),
  ]);
});

test("unpackaged builds keep the developer overrides first", () => {
  const dev = { ...base, isPackaged: false };
  const host = hostBinaryCandidates(dev);
  assert.equal(host[0], "/tmp/evil/host-core");
  assert.ok(host.some((c) => c.endsWith(join("target", "debug", "pi-desktop-host-core"))));
  assert.ok(host.some((c) => c.endsWith(join("target", "release", "pi-desktop-host-core"))));
  const plugins = builtinPluginsDirCandidates(dev);
  assert.equal(plugins[0], "/tmp/evil/plugins");
  assert.equal(plugins[1], join("/opt/PI-Desktop/resources", "plugins"));
});

test("blank overrides are ignored in unpackaged builds", () => {
  const dev = {
    ...base,
    isPackaged: false,
    env: { [HOST_BIN_ENV]: "  ", [BUILTIN_PLUGINS_DIR_ENV]: "" },
  };
  assert.equal(hostBinaryCandidates(dev)[0], join("/opt/PI-Desktop/resources", "bin/pi-desktop-host-core"));
  assert.equal(builtinPluginsDirCandidates(dev)[0], join("/opt/PI-Desktop/resources", "plugins"));
});
