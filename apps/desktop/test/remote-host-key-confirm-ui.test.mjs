/**
 * Settings ▸ Remote Hosts host-key confirmation, driven in a real renderer
 * (ADR 0328): an unknown SSH host key opens a confirmation with the host and
 * SHA-256 fingerprint; Cancel sends nothing more; "Trust and install" resends
 * the same request with exactly the fingerprints that were shown.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { RemoteHostsPage } from "../../apps/desktop/src/components/settings/RemoteHostsPage";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false, ns: ["translation", "remote"],
  resources: { en: { translation: flattenCatalog(catalogs.en), remote: {} } }, interpolation: { escapeValue: false } });
const label = (key) => i18n.t("settings.remoteHosts." + key);
const FINGERPRINT = "SHA256:Vk9ZK4x/WGnRv/8nCGCnntfK6/LmeTbu0tVr+vTjXnA";
const calls = [];
window.piDesktop = { platform: "darwin", channels: IPC,
  on() { return () => undefined; },
  async invoke(channel, input) {
    calls.push({ channel, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) });
    if (channel === IPC.invoke.remoteHostList) return { ok: true, data: { hosts: [] } };
    if (channel === IPC.invoke.remoteHostBootstrap) {
      if (input.trustedHostKeys) {
        return { ok: true, data: { host: { hostKey: "k", label: input.label, url: "", connected: true }, ssh: {}, steps: [] } };
      }
      return { ok: false, error: { code: "SSH_HOST_KEY_UNKNOWN", message: "unknown",
        details: { host: "remote.example", port: 2222, keys: [{ type: "ssh-ed25519", fingerprint: FINGERPRINT }] } } };
    }
    return { ok: true, data: {} };
  },
};
const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(typeof message === "function" ? message() : message); await frame(); }
};
const input = (key) => document.querySelector('input[aria-label="' + label(key) + '"]');
const button = (key) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label(key));
const dialog = () => document.querySelector('[role="alertdialog"]');
const bootstraps = () => calls.filter((call) => call.channel === IPC.invoke.remoteHostBootstrap);
const fill = async (key, value) => {
  const element = input(key); check(element, "missing input " + key);
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const click = async (key) => {
  await until(() => button(key) && !button(key).disabled, "action unavailable " + key);
  flushSync(() => button(key).click()); await frame();
};

window.hostKeyProbe = async () => {
  try {
    const view = createRoot(document.getElementById("root"));
    flushSync(() => view.render(React.createElement(RemoteHostsPage)));
    await fill("fieldLabel", "Box");
    await fill("sshHost", "remote.example");
    await fill("sshPort", "2222");
    await click("sshAction");
    await until(() => dialog(), "the host-key confirmation did not open");
    check(dialog().textContent.includes(FINGERPRINT), "fingerprint not shown");
    check(dialog().textContent.includes("ssh-ed25519"), "key type not shown");
    check(dialog().textContent.includes("remote.example:2222"), "host not shown");
    await until(() => document.activeElement === button("hostKeyCancel"), "focus is not on Cancel");
    check(input("sshHost").disabled, "the form stays editable under the prompt");
    check(bootstraps().length === 1 && bootstraps()[0].input.trustedHostKeys === undefined, "first attempt trusted something");

    await click("hostKeyCancel");
    await until(() => !dialog(), "cancel did not close the confirmation");
    check(bootstraps().length === 1, "cancel sent another request");

    await click("sshAction");
    await until(() => dialog(), "the confirmation did not reopen");
    await click("hostKeyTrust");
    await until(() => !dialog() && bootstraps().length === 3, () => "trust did not resend: " + bootstraps().length + " dialog=" + !!dialog() + " calls=" + JSON.stringify(calls.map((c) => c.channel)));
    check(bootstraps()[1].input.trustedHostKeys === undefined, "re-install trusted without asking");
    const sent = bootstraps()[2].input;
    check(JSON.stringify(sent.trustedHostKeys) === JSON.stringify([FINGERPRINT]), "wrong fingerprints sent");
    check(sent.host === "remote.example" && sent.port === 2222 && sent.label === "Box", "request changed on trust");
    return { passed: true };
  } catch (error) {
    return { passed: false, error: String(error?.message ?? error) };
  }
};
`;

test("an unknown SSH host key asks for confirmation and trusts only the shown fingerprint", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "ssh-hostkey-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "styles.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("HOST_KEY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.hostKeyProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /HOST_KEY_PROBE \{"passed":true\}/, output.slice(-3000));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
