/**
 * Resolved-address guard for plugin egress (ADR plugin-net-resolved-address-guard).
 *
 * The plugin-sdk policy judges the hostname a plugin wrote. These tests pin the
 * main-process half: a DNS name is resolved once, every answer is judged, and
 * the connection goes to an address that was judged — never to a second answer
 * a rebinding resolver hands out between the check and the connect.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  createPluginFetchTransport,
  createPluginNetLookup,
  PluginNetAddressError,
  resolvePluginNetAddresses,
} = await import("../electron/main/plugin-net-guard.ts");
const { pluginNetFetch } = await import("../electron/main/plugin-net-fetch.ts");
const { PluginWebSocketRegistry } = await import("../electron/main/plugin-websocket.ts");

const PUBLIC = "93.184.216.34";
const ANY_HOST = { domains: [], anyHost: true };

/** A resolver that answers from a script, one entry per call, and counts calls. */
function scriptedResolve(...answers) {
  const calls = [];
  const resolve = async (host) => {
    calls.push(host);
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { resolve, calls };
}

function isRefusal(error) {
  return error instanceof PluginNetAddressError && error.code === "PERMISSION_DENIED";
}

test("a name that resolves to a metadata address is refused, even when declared", async () => {
  for (const address of ["169.254.169.254", "100.100.100.200", "fd00:ec2::254", "::ffff:a9fe:a9fe"]) {
    const { resolve } = scriptedResolve([address]);
    await assert.rejects(
      resolvePluginNetAddresses("meta.attacker.example", {
        grant: { domains: ["meta.attacker.example"], anyHost: true },
        resolve,
      }),
      isRefusal,
      address,
    );
  }
});

test("under anyHost a name that resolves to loopback or LAN is refused unless declared", async () => {
  for (const address of ["127.0.0.1", "10.0.0.8", "192.168.1.1", "169.254.10.10", "::1", "fd12::1"]) {
    const { resolve } = scriptedResolve([address]);
    await assert.rejects(
      resolvePluginNetAddresses("self-hosted.example", { grant: ANY_HOST, resolve }),
      isRefusal,
      address,
    );
  }
  const { resolve } = scriptedResolve(["192.168.1.10"]);
  assert.deepEqual(
    await resolvePluginNetAddresses("nas.lan", {
      grant: { domains: ["nas.lan"], anyHost: true },
      resolve,
    }),
    [{ address: "192.168.1.10", family: 4 }],
  );
});

test("an IP literal is judged as itself, without DNS", async () => {
  const { resolve, calls } = scriptedResolve([PUBLIC]);
  await assert.rejects(
    resolvePluginNetAddresses("[::ffff:a9fe:a9fe]", { grant: ANY_HOST, resolve }),
    isRefusal,
  );
  await assert.rejects(
    resolvePluginNetAddresses("127.0.0.1", { grant: ANY_HOST, resolve }),
    isRefusal,
  );
  assert.deepEqual(await resolvePluginNetAddresses(PUBLIC, { grant: ANY_HOST, resolve }), [
    { address: PUBLIC, family: 4 },
  ]);
  assert.deepEqual(calls, []);
});

test("a mixed answer keeps only the admitted addresses", async () => {
  const { resolve } = scriptedResolve(["127.0.0.1", PUBLIC, "169.254.169.254"]);
  assert.deepEqual(
    await resolvePluginNetAddresses("mixed.example", { grant: ANY_HOST, resolve }),
    [{ address: PUBLIC, family: 4 }],
  );
});

test("DNS rebinding: the fetch connects to the address it checked, and re-checks each hop", async () => {
  // Public on the first answer, loopback on every answer after it.
  const { resolve, calls } = scriptedResolve([PUBLIC], ["127.0.0.1"]);
  const dialed = [];
  const transport = createPluginFetchTransport({
    grant: ANY_HOST,
    resolve,
    pinnedFetch: async (url, init, address) => {
      dialed.push({ url, address: address.address, method: init.method });
      return new Response("ok", { status: 200 });
    },
  });
  const signal = new AbortController().signal;

  const first = await transport("https://rebind.attacker.example/a", { method: "GET", signal });
  assert.equal(first.status, 200);
  // One resolution per hop, and the socket was handed that answer — there is
  // no second lookup between the check and the connect for DNS to swap.
  assert.deepEqual(calls, ["rebind.attacker.example"]);
  assert.deepEqual(dialed, [
    { url: "https://rebind.attacker.example/a", address: PUBLIC, method: "GET" },
  ]);

  // The next hop resolves again and now gets loopback: refused, never dialed.
  await assert.rejects(
    transport("https://rebind.attacker.example/b", { method: "GET", signal }),
    isRefusal,
  );
  assert.equal(dialed.length, 1);
});

test("the pinned transport dials the checked address with the plugin's request", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, host: req.headers.host, body,
        encoding: req.headers["accept-encoding"], custom: req.headers["x-plugin"] });
      if (req.url === "/hop") {
        res.writeHead(302, { location: "http://intranet.example/secret" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  // `plugin-host.test` is declared, so its loopback answer is the manifest's
  // own design; `intranet.example` is not, so a redirect there is refused.
  const { resolve } = scriptedResolve(["127.0.0.1"]);
  const grant = { domains: ["plugin-host.test"], anyHost: true };
  const transport = createPluginFetchTransport({ grant, resolve });

  const { result } = await pluginNetFetch(
    {
      url: `http://plugin-host.test:${port}/data`,
      method: "POST",
      headers: { "x-plugin": "1", "Accept-Encoding": "gzip" },
      body: "payload",
    },
    () => {},
    transport,
  );
  assert.equal(result.status, 200);
  assert.equal(result.bodyText, "pinned");
  assert.deepEqual(seen[0], {
    method: "POST",
    host: `plugin-host.test:${port}`,
    body: "payload",
    encoding: "identity",
    custom: "1",
  });

  await assert.rejects(
    pluginNetFetch({ url: `http://plugin-host.test:${port}/hop` }, () => {}, transport),
    isRefusal,
  );
});

test("a proxied route keeps the proxy transport but still refuses a forbidden local answer", async () => {
  const proxied = [];
  const proxiedFetch = async (url) => {
    proxied.push(url);
    return new Response("via proxy", { status: 200 });
  };
  const pinnedFetch = async () => assert.fail("a proxied hop must not be pinned");
  const signal = new AbortController().signal;

  const ok = createPluginFetchTransport({
    grant: ANY_HOST,
    resolve: scriptedResolve([PUBLIC]).resolve,
    resolveRoute: async () => "PROXY 127.0.0.1:7890",
    proxiedFetch,
    pinnedFetch,
  });
  assert.equal((await ok("https://api.example/x", { signal })).status, 200);

  // The proxy resolves the name; a local resolver failure is not a verdict.
  const unresolved = createPluginFetchTransport({
    grant: ANY_HOST,
    resolve: scriptedResolve(Object.assign(new Error("nx"), { code: "ENOTFOUND" })).resolve,
    resolveRoute: async () => "PROXY 127.0.0.1:7890",
    proxiedFetch,
    pinnedFetch,
  });
  assert.equal((await unresolved("https://internal-only.example/x", { signal })).status, 200);

  const metadata = createPluginFetchTransport({
    grant: ANY_HOST,
    resolve: scriptedResolve(["169.254.169.254"]).resolve,
    resolveRoute: async () => "PROXY 127.0.0.1:7890",
    proxiedFetch,
    pinnedFetch,
  });
  await assert.rejects(metadata("https://meta.attacker.example/", { signal }), isRefusal);
  assert.deepEqual(proxied, ["https://api.example/x", "https://internal-only.example/x"]);
});

test("the socket lookup hook answers only with checked addresses", async () => {
  const lookup = createPluginNetLookup({
    grant: ANY_HOST,
    resolve: scriptedResolve(["127.0.0.1", PUBLIC, "2606:4700::1111"]).resolve,
  });
  const single = await new Promise((resolve, reject) =>
    lookup("x.example", {}, (error, address, family) =>
      error ? reject(error) : resolve({ address, family })),
  );
  assert.deepEqual(single, { address: PUBLIC, family: 4 });
  const all = await new Promise((resolve, reject) =>
    lookup("x.example", { all: true }, (error, list) => (error ? reject(error) : resolve(list))),
  );
  assert.deepEqual(all, [
    { address: PUBLIC, family: 4 },
    { address: "2606:4700::1111", family: 6 },
  ]);

  const refusing = createPluginNetLookup({
    grant: ANY_HOST,
    resolve: scriptedResolve(["169.254.169.254"]).resolve,
  });
  const error = await new Promise((resolve) => refusing("x.example", {}, (err) => resolve(err)));
  assert.ok(isRefusal(error));
});

test("a real ws connect is pinned and refused by the resolved-address guard", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const registry = new PluginWebSocketRegistry({ onEvent: () => {}, connectTimeoutMs: 5_000 });
  t.after(() => registry.releasePlugin("com.example.sock"));

  // Declared host resolving to loopback: the manifest's own design.
  const declared = scriptedResolve(["127.0.0.1"]);
  const { socketId } = await registry.connect({
    pluginId: "com.example.sock",
    url: `ws://sock.test:${port}/live`,
    lookup: createPluginNetLookup({
      grant: { domains: ["sock.test"], anyHost: true },
      resolve: declared.resolve,
    }),
  });
  assert.ok(socketId);
  assert.deepEqual(declared.calls, ["sock.test"]);

  // Undeclared name under anyHost resolving to loopback: refused at connect.
  await assert.rejects(
    registry.connect({
      pluginId: "com.example.sock",
      url: `ws://rebind.attacker.example:${port}/live`,
      lookup: createPluginNetLookup({
        grant: ANY_HOST,
        resolve: scriptedResolve(["127.0.0.1"]).resolve,
      }),
    }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.equal(registry.list("com.example.sock").length, 1);
});
