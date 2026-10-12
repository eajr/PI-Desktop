import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.fn(async (_path: string) => ({ dispose() {} }));
vi.mock("transcribe-cpp", () => ({ TranscribeModel: { load } }));

const PAYLOAD = Buffer.from("pinned model bytes");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

vi.mock("../src/model-catalog.js", () => {
  const model = {
    id: "fixture-model",
    name: "Fixture",
    description: "",
    languages: ["en"],
    sizeBytes: 18,
    hfRepo: "fixture/repo",
    hfFilename: "fixture.gguf",
    hfRevision: "0123456789abcdef0123456789abcdef01234567",
    sha256: createHash("sha256").update(Buffer.from("pinned model bytes")).digest("hex"),
    supportsStreaming: false,
    recommended: true,
  };
  return {
    getCatalog: () => [model],
    findModel: (id: string) => (id === model.id ? model : undefined),
  };
});

const { ModelManager } = await import("../src/model-manager.js");

let cacheDir: string;
let modelFile: string;

beforeEach(async () => {
  load.mockClear();
  cacheDir = await mkdtemp(path.join(tmpdir(), "voice-integrity-"));
  await mkdir(path.join(cacheDir, "fixture-model"));
  modelFile = path.join(cacheDir, "fixture-model", "fixture.gguf");
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("ModelManager load-time verification", () => {
  it("loads a pre-existing file whose sha256 matches the pin", async () => {
    expect(PAYLOAD_SHA).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(modelFile, PAYLOAD);
    const manager = new ModelManager(cacheDir);

    await manager.ensureLoaded("fixture-model");

    expect(load).toHaveBeenCalledWith(modelFile);
    expect(manager.getState("fixture-model")?.status).toBe("loaded");
  });

  it("rejects and deletes a pre-existing file that does not match the pin", async () => {
    // e.g. a file left by an older version that downloaded without checks.
    await writeFile(modelFile, Buffer.from("tampered model bytes"));
    const manager = new ModelManager(cacheDir);
    expect(manager.getState("fixture-model")?.status).toBe("downloaded");

    await expect(manager.ensureLoaded("fixture-model")).rejects.toThrow(
      /failed sha256 verification/,
    );

    expect(load).not.toHaveBeenCalled();
    expect(existsSync(modelFile)).toBe(false);
    const state = manager.getState("fixture-model");
    expect(state?.status).toBe("error");
    expect(state?.localPath).toBeUndefined();
    expect(state?.error).toMatch(/Verification failed/);
  });

  it("verifies once per process, not on every reload", async () => {
    await writeFile(modelFile, PAYLOAD);
    const manager = new ModelManager(cacheDir);
    await manager.ensureLoaded("fixture-model");
    manager.unload();

    // Swapping the file after verification is a local-write attacker, out
    // of scope; this only documents that the re-hash is skipped.
    await manager.ensureLoaded("fixture-model");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
