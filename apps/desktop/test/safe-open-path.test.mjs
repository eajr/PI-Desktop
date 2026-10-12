import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  classifyPathForOpen,
  hasLaunchableExtension,
  launchableRevealedNotice,
  openPathOrReveal,
} = await import("../electron/main/safe-open-path.ts");

const posix = process.platform !== "win32";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-safe-open-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function file(dir, name, mode = 0o644, content = "x") {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  chmodSync(full, mode);
  return full;
}

const LAUNCHABLE_NAMES = [
  // macOS
  "run.command", "Run.COMMAND", "shell.terminal", "Tool.app", "x.scpt",
  "x.applescript", "flow.workflow", "setup.pkg", "image.dmg", "link.webloc",
  "link.inetloc", "profile.mobileconfig", "a.tool",
  // Windows
  "setup.exe", "run.bat", "run.cmd", "script.ps1", "script.vbs", "a.vbe",
  "a.jse", "a.wsf", "setup.msi", "a.com", "a.scr", "a.cpl", "a.pif",
  "shortcut.lnk", "site.url", "tweak.reg", "a.hta", "a.msc", "a.appref-ms",
  "a.settingcontent-ms", "a.library-ms",
  // Linux and cross-platform
  "app.desktop", "app.AppImage", "a.run", "a.deb", "a.rpm", "a.snap",
  "build.sh", "a.bash", "a.zsh", "a.fish", "tool.jar", "a.jnlp",
  // Only the final extension decides the association.
  "report.pdf.command", "invoice.pdf.exe", "notes.txt.lnk",
  // Windows folds trailing dots, spaces, and NTFS stream suffixes away.
  "run.bat.", "run.bat ", "run.bat. . ", "run.bat::$DATA", "run.exe:stream",
];

const INERT_NAMES = [
  "report.pdf", "photo.PNG", "notes.md", "data.json", "movie.mp4",
  "run.command.pdf", "setup.exe.txt", "archive.zip", "page.html", "app.js",
  "main.py", "Makefile", "README", "a.", ".gitignore",
];

for (const name of LAUNCHABLE_NAMES) {
  test(`launchable by name: ${JSON.stringify(name)}`, () => {
    assert.equal(hasLaunchableExtension(name, "darwin"), true);
    assert.equal(hasLaunchableExtension(name, "win32"), true);
    assert.equal(hasLaunchableExtension(name, "linux"), true);
  });
}

for (const name of INERT_NAMES) {
  test(`not launchable by name: ${JSON.stringify(name)}`, () => {
    assert.equal(hasLaunchableExtension(name, "darwin"), false);
    assert.equal(hasLaunchableExtension(name, "linux"), false);
  });
}

test(".js is launchable only where Windows Script Host owns it", () => {
  assert.equal(hasLaunchableExtension("app.js", "win32"), true);
  assert.equal(hasLaunchableExtension("APP.JS.", "win32"), true);
  assert.equal(hasLaunchableExtension("app.js", "darwin"), false);
  assert.equal(hasLaunchableExtension("app.js", "linux"), false);
});

test("a regular document opens; a launchable extension is revealed", async (t) => {
  const dir = tempDir(t);
  assert.deepEqual(await classifyPathForOpen(file(dir, "a.pdf"), "darwin"), { launchable: false });
  assert.deepEqual(await classifyPathForOpen(file(dir, "x.pdf.command"), "darwin"), {
    launchable: true,
    reason: "extension",
  });
  assert.deepEqual(await classifyPathForOpen(file(dir, "SETUP.EXE"), "win32"), {
    launchable: true,
    reason: "extension",
  });
});

test("POSIX execute bit marks files without a document extension", { skip: !posix }, async (t) => {
  const dir = tempDir(t);
  for (const name of ["payload", "script.py", "tool.bin", "a.unknownext"]) {
    assert.deepEqual(
      await classifyPathForOpen(file(dir, name, 0o755), "darwin"),
      { launchable: true, reason: "executable-mode" },
      name,
    );
    assert.deepEqual(
      await classifyPathForOpen(join(dir, name), "linux"),
      { launchable: true, reason: "executable-mode" },
      name,
    );
  }
  // Group- or other-only execute bits count too.
  assert.equal((await classifyPathForOpen(file(dir, "g", 0o610), "linux")).launchable, true);
  // A stray execute bit on a known document type stays openable.
  assert.deepEqual(await classifyPathForOpen(file(dir, "scan.pdf", 0o755), "darwin"), {
    launchable: false,
  });
  // Without the bit, an extensionless file opens normally.
  assert.deepEqual(await classifyPathForOpen(file(dir, "LICENSE", 0o644), "darwin"), {
    launchable: false,
  });
  // Windows has no execute bit; mode is ignored there.
  assert.deepEqual(await classifyPathForOpen(join(dir, "payload"), "win32"), { launchable: false });
});

test("a symlink is judged by its target name and mode as well", { skip: !posix }, async (t) => {
  const dir = tempDir(t);
  const target = file(dir, "run.command");
  const link = join(dir, "harmless.pdf");
  symlinkSync(target, link);
  assert.deepEqual(await classifyPathForOpen(link, "darwin"), {
    launchable: true,
    reason: "extension",
  });

  const exe = file(dir, "blob", 0o755);
  const mp4 = join(dir, "alias.mp4");
  symlinkSync(exe, mp4);
  assert.deepEqual(await classifyPathForOpen(mp4, "darwin"), {
    launchable: true,
    reason: "executable-mode",
  });
});

test("application bundles are revealed; plain folders are not launchable", async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "Tool.app"));
  mkdirSync(join(dir, "Flow.WORKFLOW"));
  mkdirSync(join(dir, "plain"));
  mkdirSync(join(dir, "Disguised", "Contents"), { recursive: true });
  writeFileSync(
    join(dir, "Disguised", "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>x</string></dict></plist>",
  );
  assert.deepEqual(await classifyPathForOpen(join(dir, "Tool.app"), "darwin"), {
    launchable: true,
    reason: "bundle",
  });
  assert.deepEqual(await classifyPathForOpen(join(dir, "Flow.WORKFLOW"), "linux"), {
    launchable: true,
    reason: "bundle",
  });
  assert.deepEqual(await classifyPathForOpen(join(dir, "plain"), "darwin"), { launchable: false });
  assert.deepEqual(await classifyPathForOpen(join(dir, "Disguised"), "darwin"), {
    launchable: true,
    reason: "bundle",
  });
});

test("a path that cannot be inspected is not trusted to be inert", async (t) => {
  const dir = tempDir(t);
  assert.deepEqual(await classifyPathForOpen(join(dir, "missing.pdf"), "darwin"), {
    launchable: true,
    reason: "unverifiable",
  });
});

test("openPathOrReveal never hands a launchable path to the opener", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const deps = {
    openPath: async (path) => calls.push(["open", path]),
    revealPath: (path) => calls.push(["reveal", path]),
    platform: "darwin",
  };
  const doc = file(dir, "a.md");
  assert.deepEqual(await openPathOrReveal(doc, deps), { outcome: "opened" });
  const script = file(dir, "run.command");
  assert.deepEqual(await openPathOrReveal(script, deps, join(dir, "shown")), {
    outcome: "revealed",
    reason: "extension",
  });
  assert.deepEqual(calls, [
    ["open", doc],
    ["reveal", join(dir, "shown")],
  ]);
});

test("openPathOrReveal surfaces an opener failure", async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    openPathOrReveal(file(dir, "a.txt"), {
      openPath: async () => {
        throw new Error("no handler");
      },
      revealPath: () => {},
      platform: "linux",
    }),
    /no handler/,
  );
});

test("the reveal notice is localized and falls back to English", () => {
  assert.match(launchableRevealedNotice("en"), /run programs/);
  assert.match(launchableRevealedNotice(undefined), /run programs/);
  assert.notEqual(launchableRevealedNotice("zh-CN"), launchableRevealedNotice("en"));
});

test("every workspace- or plugin-chosen openPath goes through the policy", () => {
  const workspaceIpc = readMainModuleSync("ipc/workspace-ipc.ts");
  const fsOpen = workspaceIpc.slice(workspaceIpc.indexOf("handle(IPC.invoke.fsOpen"));
  const fsOpenBody = fsOpen.slice(0, fsOpen.indexOf("handle(IPC.invoke.fsIndex"));
  assert.match(fsOpenBody, /openPathOrReveal\(/);
  assert.doesNotMatch(fsOpenBody, /shell\.openPath/);

  const services = readMainModuleSync("services/plugin-services.ts");
  const openPathService = services.slice(services.indexOf("openPath: async (fullPath)"));
  assert.match(openPathService.slice(0, 400), /openPathOrReveal\(/);
  assert.doesNotMatch(openPathService.slice(0, 400), /shell\.openPath/);

  const browserView = readMainModuleSync("browser-view.ts");
  assert.doesNotMatch(browserView, /shell\.openPath/);
  assert.match(browserView, /openPathOrReveal\(/);
});
