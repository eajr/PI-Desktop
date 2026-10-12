/**
 * SSH host-key trust (ADR 0328): no connection trusts a host silently, a new
 * host is trusted only after the user approves its SHA-256 fingerprint, and a
 * changed key is never accepted.
 *
 * The probe is driven through an injected runner that plays `ssh` — it writes
 * what `accept-new` would write into the scratch file named by the first
 * `UserKnownHostsFile` entry — so no network, sshd or ssh binary is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  assertTrustedFingerprints, ensureHostKeyTrusted, hostKeyProbeArgs, parseKnownHostsKeys,
  quoteSshConfigPath, userKnownHostsOption,
} = await import("../electron/main/remote/ssh-host-keys.ts");
const { assertSshDestinationField, createSystemSshTransport, sshCommonArgs } = await import(
  "../electron/main/remote/ssh-transport.ts"
);
const { createSshBootstrap } = await import("../electron/main/remote/ssh-bootstrap.ts");
const { sshMetadataOf } = await import("../electron/main/remote/remote-host-metadata.ts");
const { hostKeyPromptOf, remoteHostErrorKey } = await import("../src/lib/remote-host-errors.ts");

// Public halves of throwaway keys; fingerprints as printed by `ssh-keygen -lf`.
const ED25519 = {
  type: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAIOPG6D2ZYCFbwlfW01v4iEW+Un3l5+DJ2QIs9wf5ezfE",
  fingerprint: "SHA256:Vk9ZK4x/WGnRv/8nCGCnntfK6/LmeTbu0tVr+vTjXnA",
};
const ECDSA = {
  type: "ecdsa-sha2-nistp256",
  blob: "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBByD4eEtCRsbLQodYecbdQsX+Jgfo7BPNSCWnGp4on/2ZE7Q2HWN5Tx2UP78dYLLDqwTuSxiECFCQPqA3KBFZgA=",
  fingerprint: "SHA256:WacBh/XBNmHGIpLxdshQoj1Ml3uNrturBESX/xrANyk",
};
const line = (key, host = "[remote.example]:2222") => `${host} ${key.type} ${key.blob}`;

function option(args, name) {
  const index = args.findIndex((arg, i) => args[i - 1] === "-o" && arg.startsWith(`${name}=`));
  return index === -1 ? undefined : args[index].slice(name.length + 1);
}

/** First quoted path of a `UserKnownHostsFile=` value: the scratch file. */
function firstKnownHostsPath(args) {
  const value = option(args, "UserKnownHostsFile");
  const match = /^"([^"]+)"/.exec(value ?? "");
  assert.ok(match, "the first known_hosts entry is a quoted path");
  return match[1];
}

/** A fake `ssh` that records argv and plays one connection outcome. */
function fakeSsh({ learned = "", stderr = "", code = 255 } = {}) {
  const calls = [];
  const run = async (_binary, args) => {
    calls.push(args);
    if (learned) await writeFile(firstKnownHostsPath(args), learned);
    return { stderr, code };
  };
  return { run, calls };
}

async function scratchDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi host keys "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail("expected a rejection");
}

test("every connection checks host keys strictly against the app file, then the user's", () => {
  const args = sshCommonArgs({ host: "remote.example", user: "deploy" }, { knownHostsFile: "/data/PI Desktop/ssh_known_hosts" });
  assert.equal(option(args, "StrictHostKeyChecking"), "yes");
  assert.equal(
    option(args, "UserKnownHostsFile"),
    '"/data/PI Desktop/ssh_known_hosts" ~/.ssh/known_hosts ~/.ssh/known_hosts2',
  );
  assert.ok(!args.includes("StrictHostKeyChecking=accept-new"));
  assert.deepEqual(args.slice(-2), ["--", "deploy@remote.example"]);

  // Without an app file the user's own files still apply, still strictly.
  const bare = sshCommonArgs({ host: "h" });
  assert.equal(option(bare, "StrictHostKeyChecking"), "yes");
  assert.equal(option(bare, "UserKnownHostsFile"), "~/.ssh/known_hosts ~/.ssh/known_hosts2");
});

test("known_hosts paths are quoted for the OpenSSH tokenizer", () => {
  assert.equal(quoteSshConfigPath("/a b/c"), '"/a b/c"');
  assert.equal(quoteSshConfigPath("C:\\Users\\A B\\kh"), '"C:/Users/A B/kh"');
  assert.equal(quoteSshConfigPath("/p%d/kh"), '"/p%%d/kh"', "% tokens are not expanded");
  for (const bad of ['/a"b', "/a\nb", ""]) assert.throws(() => quoteSshConfigPath(bad), { errorCode: "INVALID_ARGUMENT" });
  assert.equal(userKnownHostsOption(["/x"]), 'UserKnownHostsFile="/x" ~/.ssh/known_hosts ~/.ssh/known_hosts2');
});

test("fingerprints match ssh-keygen and malformed or marker lines are dropped", () => {
  const keys = parseKnownHostsKeys([
    "# comment",
    line(ED25519),
    line(ED25519, "remote.example"), // the same key under another name: one entry
    line(ECDSA),
    `@cert-authority * ${ED25519.type} ${ED25519.blob}`,
    `host ssh-rsa ${ED25519.blob}`, // declared type disagrees with the blob
    "host ssh-ed25519 not*base64",
    "|1|hashed|name= ssh-ed25519", // missing blob
  ].join("\n"));
  assert.deepEqual(keys, [
    { type: ED25519.type, fingerprint: ED25519.fingerprint },
    { type: ECDSA.type, fingerprint: ECDSA.fingerprint },
  ]);
});

test("the probe offers no credential and ends option parsing before the destination", () => {
  const args = hostKeyProbeArgs({ host: "remote.example", port: 2222, user: "deploy" }, "/tmp/s/kh", "/data/kh");
  for (const [name, value] of [
    ["BatchMode", "yes"], ["StrictHostKeyChecking", "accept-new"], ["PubkeyAuthentication", "no"],
    ["PasswordAuthentication", "no"], ["KbdInteractiveAuthentication", "no"], ["HostbasedAuthentication", "no"],
    ["GSSAPIAuthentication", "no"], ["ControlPath", "none"], ["UpdateHostKeys", "no"],
  ]) assert.equal(option(args, name), value, name);
  assert.equal(option(args, "UserKnownHostsFile"), '"/tmp/s/kh" "/data/kh" ~/.ssh/known_hosts ~/.ssh/known_hosts2');
  assert.deepEqual(args.slice(-3), ["--", "deploy@remote.example", "true"]);
  assert.ok(!args.includes("-i"));
});

test("an unknown host is refused with its fingerprints and nothing is recorded", async (t) => {
  const dir = await scratchDir(t);
  const knownHostsFile = join(dir, "ssh_known_hosts");
  const ssh = fakeSsh({ learned: `${line(ED25519)}\n` });
  const error = await rejection(ensureHostKeyTrusted({ host: "remote.example", port: 2222 }, {
    knownHostsFile, approvedFingerprints: [], run: ssh.run,
  }));
  assert.equal(error.errorCode, "SSH_HOST_KEY_UNKNOWN");
  assert.deepEqual(error.data, {
    host: "remote.example", port: 2222, keys: [{ type: ED25519.type, fingerprint: ED25519.fingerprint }],
  });
  await assert.rejects(stat(knownHostsFile), { code: "ENOENT" });
});

test("approving a different fingerprint than the server presents records nothing", async (t) => {
  const dir = await scratchDir(t);
  const knownHostsFile = join(dir, "ssh_known_hosts");
  const ssh = fakeSsh({ learned: `${line(ECDSA)}\n` });
  const error = await rejection(ensureHostKeyTrusted({ host: "remote.example" }, {
    knownHostsFile, approvedFingerprints: [ED25519.fingerprint], run: ssh.run,
  }));
  assert.equal(error.errorCode, "SSH_HOST_KEY_UNKNOWN");
  assert.deepEqual(error.data.keys, [{ type: ECDSA.type, fingerprint: ECDSA.fingerprint }]);
  await assert.rejects(stat(knownHostsFile), { code: "ENOENT" });
});

test("an approved key is appended to the app-managed file only, mode 0600", async (t) => {
  const dir = await scratchDir(t);
  const knownHostsFile = join(dir, "nested", "ssh_known_hosts");
  const ssh = fakeSsh({ learned: `${line(ED25519)}\n` });
  await ensureHostKeyTrusted({ host: "remote.example", port: 2222 }, {
    knownHostsFile, approvedFingerprints: [ED25519.fingerprint], run: ssh.run,
  });
  assert.equal(await readFile(knownHostsFile, "utf8"), `${line(ED25519)}\n`);
  if (process.platform !== "win32") assert.equal((await stat(knownHostsFile)).mode & 0o777, 0o600);

  // A second host appends; an existing file without a trailing newline is
  // not merged into one line.
  await writeFile(knownHostsFile, line(ED25519));
  await chmod(knownHostsFile, 0o600);
  await ensureHostKeyTrusted({ host: "other" }, {
    knownHostsFile, approvedFingerprints: [ECDSA.fingerprint], run: fakeSsh({ learned: line(ECDSA, "other") }).run,
  });
  assert.equal(await readFile(knownHostsFile, "utf8"), `${line(ED25519)}\n${line(ECDSA, "other")}\n`);
  // The scratch file lived in its own directory and is gone.
  await assert.rejects(stat(dirname(firstKnownHostsPath(ssh.calls[0]))), { code: "ENOENT" });
});

test("an already trusted host passes without a prompt or a write", async (t) => {
  const dir = await scratchDir(t);
  const knownHostsFile = join(dir, "ssh_known_hosts");
  await ensureHostKeyTrusted({ host: "remote.example" }, {
    knownHostsFile, approvedFingerprints: [], run: fakeSsh({ stderr: "Permission denied (publickey).\n" }).run,
  });
  await assert.rejects(stat(knownHostsFile), { code: "ENOENT" });
});

test("a changed host key is refused and never auto-accepted, even if approved", async (t) => {
  const dir = await scratchDir(t);
  const stderr = [
    "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
    "Host key for [remote.example]:2222 has changed and you have requested strict checking.",
    "Host key verification failed.",
  ].join("\n");
  const error = await rejection(ensureHostKeyTrusted({ host: "remote.example", port: 2222 }, {
    knownHostsFile: join(dir, "kh"), approvedFingerprints: [ED25519.fingerprint], run: fakeSsh({ stderr }).run,
  }));
  assert.equal(error.errorCode, "SSH_HOST_KEY_CHANGED");
  assert.deepEqual(error.data, { host: "remote.example", port: 2222 });
});

test("a failed connection with a changed-key diagnostic surfaces SSH_HOST_KEY_CHANGED", async (t) => {
  const dir = await scratchDir(t);
  const binary = join(dir, "ssh");
  await writeFile(binary, `#!/bin/sh
echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2
echo "Host key verification failed." >&2
exit 255
`);
  await chmod(binary, 0o755);
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });
  t.after(() => transport.dispose());
  await assert.rejects(transport.exec("true"), { errorCode: "SSH_HOST_KEY_CHANGED" });
  await writeFile(binary, `#!/bin/sh
echo "No ED25519 host key is known for remote.example and you have requested strict checking." >&2
echo "Host key verification failed." >&2
exit 255
`);
  await assert.rejects(transport.exec("true"), { errorCode: "SSH_HOST_KEY_UNKNOWN" });
});

test("destination fields refuse option, whitespace and control-character injection", () => {
  for (const bad of ["-oProxyCommand=evil", "host name", "host\nProxyCommand", "a\tb", " -x"]) {
    assert.throws(() => assertSshDestinationField(bad, "host"), { errorCode: "INVALID_ARGUMENT" }, JSON.stringify(bad));
  }
  assert.equal(assertSshDestinationField(" remote.example ", "host"), "remote.example");
  assert.throws(() => sshCommonArgs({ host: "-oProxyCommand=x" }), { errorCode: "INVALID_ARGUMENT" });
  assert.throws(() => sshCommonArgs({ host: "h", user: "a b" }), { errorCode: "INVALID_ARGUMENT" });
  assert.throws(() => sshCommonArgs({ host: "h", port: 0 }), { errorCode: "INVALID_ARGUMENT" });
  assert.throws(() => sshCommonArgs({ host: "h", identityFile: "/k\n-oX" }), { errorCode: "INVALID_ARGUMENT" });
  // An identity file path may contain a space; it is its own argv entry.
  assert.ok(sshCommonArgs({ host: "h", identityFile: "/My Keys/id" }).includes("/My Keys/id"));
  // Persisted descriptors go through the same rule.
  assert.equal(sshMetadataOf({ hostKey: "k", label: "l", url: "u", deviceToken: "t",
    metadata: { transport: "ssh", ssh: { host: "evil host", remotePort: 1, version: "" } } }), null);
});

test("trustedHostKeys must be well-formed SHA256 fingerprints", () => {
  assert.deepEqual(assertTrustedFingerprints(undefined), []);
  assert.deepEqual(assertTrustedFingerprints([ED25519.fingerprint, ED25519.fingerprint]), [ED25519.fingerprint]);
  for (const bad of ["x", ["MD5:aa"], [`${ED25519.fingerprint} extra`], Array(17).fill(ED25519.fingerprint)]) {
    assert.throws(() => assertTrustedFingerprints(bad), { errorCode: "INVALID_ARGUMENT" });
  }
});

function bootstrapWith(trustHostKey) {
  const calls = [];
  const bootstrap = createSshBootstrap({
    version: "1.0.0",
    fetchChecksum: async () => assert.fail("must not reach the release"),
    exchangePairing: async () => assert.fail("must not pair"),
    buildTransport: () => ({
      trustHostKey: async (approved) => { calls.push(["trust", approved]); await trustHostKey(approved); },
      exec: async (command) => { calls.push(["exec", command]); throw new Error("stop after the probe"); },
      execWithInput: async () => assert.fail("must not install"),
      forward: async () => assert.fail("must not forward"),
      dispose: () => calls.push(["dispose"]),
    }),
  });
  return { bootstrap, calls };
}

test("bootstrap confirms the host key before any authenticated command", async () => {
  const declined = bootstrapWith(async () => {
    throw Object.assign(new Error("unknown"), { errorCode: "SSH_HOST_KEY_UNKNOWN" });
  });
  await assert.rejects(declined.bootstrap.bootstrap({ host: "remote.example", label: "Box" }), { errorCode: "SSH_HOST_KEY_UNKNOWN" });
  assert.deepEqual(declined.calls, [["trust", []], ["dispose"]], "no command ran against an untrusted host");

  const approved = bootstrapWith(async () => undefined);
  await assert.rejects(approved.bootstrap.bootstrap({
    host: "remote.example", label: "Box", trustedHostKeys: [ED25519.fingerprint],
  }), /stop after the probe/);
  assert.deepEqual(approved.calls.slice(0, 2), [["trust", [ED25519.fingerprint]], ["exec", "uname -s && uname -m"]]);

  const injected = bootstrapWith(async () => assert.fail("must not probe"));
  await assert.rejects(injected.bootstrap.bootstrap({ host: "remote example", label: "Box" }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(injected.bootstrap.bootstrap({ host: "h", label: "Box", trustedHostKeys: ["nope"] }), { errorCode: "INVALID_ARGUMENT" });
  assert.deepEqual(injected.calls, []);
});

test("the renderer turns only a well-formed unknown-key error into a confirmation", () => {
  const keys = [{ type: ED25519.type, fingerprint: ED25519.fingerprint }];
  assert.deepEqual(
    hostKeyPromptOf({ code: "SSH_HOST_KEY_UNKNOWN", details: { host: "remote.example", port: 2222, keys } }),
    { host: "remote.example", port: 2222, keys },
  );
  assert.equal(hostKeyPromptOf({ code: "SSH_HOST_KEY_UNKNOWN", details: { host: "h", keys: [] } }), null);
  assert.equal(hostKeyPromptOf({ code: "SSH_HOST_KEY_UNKNOWN", details: { host: "h", keys: [{ type: "x", fingerprint: "bad" }] } }), null);
  assert.equal(hostKeyPromptOf({ code: "SSH_HOST_KEY_CHANGED", details: { host: "h", keys } }), null);
  assert.equal(remoteHostErrorKey({ code: "SSH_HOST_KEY_CHANGED" }), "remote:hostKeyChanged");
  assert.equal(remoteHostErrorKey({ code: "SSH_HOST_KEY_UNKNOWN" }), "remote:hostKeyUntrusted");
});

test("every production SSH transport consults the app-managed known_hosts", async () => {
  // A transport built without `knownHostsFile` falls back to the user's own
  // files only, so a host the user confirmed in the app would be refused.
  // The RACP device re-pair path once missed it (integration of ADR 0328
  // with racp-device-token-lifetime).
  const { readdir } = await import("node:fs/promises");
  const mainDir = join(here, "../electron/main");
  const files = (await readdir(mainDir, { recursive: true })).filter((name) => name.endsWith(".ts"));
  let calls = 0;
  for (const name of files) {
    if (name.endsWith("ssh-transport.ts")) continue;
    const source = await readFile(join(mainDir, name), "utf8");
    for (const match of source.matchAll(/createSystemSshTransport\(/g)) {
      let depth = 1;
      let end = match.index + match[0].length;
      while (depth > 0 && end < source.length) {
        const char = source[end++];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
      }
      const call = source.slice(match.index, end);
      if (/^createSystemSshTransport\(\s*target\s*:/.test(call)) continue; // the declaration
      calls += 1;
      assert.match(call, /knownHostsFile/, `${name}: ${call.slice(0, 160)}`);
    }
  }
  assert.ok(calls >= 4, `found ${calls} transport constructions`);
});
