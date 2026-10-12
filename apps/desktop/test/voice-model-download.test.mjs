import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect `@huggingface/hub` to the stub and esbuild-transform the
// voice-runtime sources so the real downloader runs without network access.
register(new URL("./helpers/hub-stub-hook.mjs", import.meta.url).href);

const { downloadModel } = await import(
  "../../../packages/voice-runtime/src/model-downloader.ts"
);
const { setBehavior } = await import("./helpers/hub-stub.mjs");

const MODEL = {
  id: "whisper-small",
  hfRepo: "fixture/whisper-small-GGUF",
  hfFilename: "ggml-small-q8_0.bin",
  hfRevision: "0123456789abcdef0123456789abcdef01234567",
  // sha256 of bytes 1..9, the payload the success case streams.
  sha256: "47e4ee7f211f73265dd17658f6e21c1318bd6c81f37598e20a2756299542efcf",
  sizeBytes: 9,
};

function responseFrom(chunks, { failAfter } = {}) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  let sent = 0;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        sent += 1;
        controller.enqueue(new Uint8Array(chunk));
        if (failAfter !== undefined && sent >= failAfter) {
          controller.error(new Error("hub connection reset mid-stream"));
          return;
        }
      }
      if (failAfter === undefined) controller.close();
    },
  });
  return {
    headers: { get: () => String(total) },
    body,
  };
}

async function tmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "voice-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function consume(generator) {
  let last = 0;
  for await (const progress of generator) last = progress;
  return last;
}

test("a completed download lands at the final path with the .part file gone", async (t) => {
  const dir = await tmpDir(t);
  let requested = null;
  setBehavior((args) => {
    requested = args;
    return responseFrom([[1, 2, 3], [4, 5], [6, 7, 8, 9]]);
  });

  const last = await consume(downloadModel(MODEL, dir));
  assert.equal(last, 1);
  const bytes = await readFile(join(dir, "ggml-small-q8_0.bin"));
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["ggml-small-q8_0.bin"], "no .part residue");
  assert.equal(requested.revision, MODEL.hfRevision, "fetches the pinned commit");
});

test("a download whose sha256 does not match the pin is rejected and deleted", async (t) => {
  const dir = await tmpDir(t);
  // Same length as the pinned payload, different content.
  setBehavior(() => responseFrom([[9, 8, 7, 6, 5, 4, 3, 2, 1]]));

  await assert.rejects(
    consume(downloadModel(MODEL, dir)),
    /failed sha256 verification/,
  );
  const entries = await readdir(dir);
  assert.deepEqual(entries, [], "neither the final file nor the .part survives");
});

test("a catalog entry with an empty sha256 is refused before any network request", async (t) => {
  const dir = await tmpDir(t);
  let called = false;
  setBehavior(() => {
    called = true;
    return responseFrom([[1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  });

  await assert.rejects(
    consume(downloadModel({ ...MODEL, sha256: "" }, dir)),
    /no valid pinned sha256/,
  );
  assert.equal(called, false, "the hub is never contacted");
  assert.deepEqual(await readdir(dir), []);
});

test("a catalog entry without a pinned commit is refused", async (t) => {
  const dir = await tmpDir(t);
  setBehavior(() => responseFrom([[1, 2, 3, 4, 5, 6, 7, 8, 9]]));

  await assert.rejects(
    consume(downloadModel({ ...MODEL, hfRevision: "main" }, dir)),
    /no pinned Hugging Face commit/,
  );
});

test("a mid-stream source failure rejects and leaves neither the final file nor the .part", async (t) => {
  const dir = await tmpDir(t);
  setBehavior(() => responseFrom([[1, 2, 3], [4, 5, 6]], { failAfter: 2 }));

  await assert.rejects(
    consume(downloadModel(MODEL, dir)),
    /hub connection reset mid-stream/,
  );
  const entries = await readdir(dir);
  assert.deepEqual(entries, [], "no truncated model, no .part residue");
});

test("an unwritable .part path surfaces a download failure instead of crashing the process", async (t) => {
  const dir = await tmpDir(t);
  let sourceCancelled = false;
  setBehavior(() => ({
    headers: { get: () => "3" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        sourceCancelled = true;
      },
    }),
  }));
  // A directory sitting at the .part path makes the WriteStream's open fail
  // asynchronously — the exact "unhandled stream error" shape that used to
  // take down the Electron main process.
  await mkdir(join(dir, "ggml-small-q8_0.bin.part"));

  await assert.rejects(consume(downloadModel(MODEL, dir)));
  assert.equal(sourceCancelled, true, "a write failure cancels the open response body");
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["ggml-small-q8_0.bin.part"], "final path never created");
});
