import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ModelInfo } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_COMMIT_HEX = /^[0-9a-f]{40}$/;

/** Raised when a model file or its catalog pin fails integrity checks. */
export class ModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelIntegrityError";
  }
}

/**
 * Throw unless the catalog entry carries a usable pin. Model files are
 * parsed by native code, so a missing hash or revision must fail closed
 * instead of silently accepting whatever the hub serves.
 */
export function assertPinnedModel(info: ModelInfo): void {
  if (!SHA256_HEX.test(info.sha256)) {
    throw new ModelIntegrityError(
      `Model ${info.id} has no valid pinned sha256; refusing to use it`,
    );
  }
  if (!GIT_COMMIT_HEX.test(info.hfRevision)) {
    throw new ModelIntegrityError(
      `Model ${info.id} has no pinned Hugging Face commit; refusing to use it`,
    );
  }
}

/** Throw if `actual` (lowercase hex) does not equal the pinned sha256. */
export function assertDigestMatches(info: ModelInfo, actual: string): void {
  if (actual !== info.sha256) {
    throw new ModelIntegrityError(
      `Model ${info.id} failed sha256 verification (expected ${info.sha256}, got ${actual})`,
    );
  }
}

/** Stream a file through SHA-256 and return the lowercase hex digest. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Verify a file on disk against the catalog pin; throws on any mismatch. */
export async function verifyModelFile(info: ModelInfo, filePath: string): Promise<void> {
  assertPinnedModel(info);
  assertDigestMatches(info, await sha256File(filePath));
}
