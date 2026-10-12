import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ModelInfo, ModelState } from "./types.js";
import { findModel, getCatalog } from "./model-catalog.js";
import { ModelIntegrityError, verifyModelFile } from "./model-integrity.js";

/**
 * Manages model discovery, download, loading, and unloading.
 *
 * - Models are cached in `cacheDir` (typically ~/.cache/pi-desktop/voice-models/).
 * - Loading uses transcribe-cpp's TranscribeModel (lazy-imported).
 * - Only one model is loaded at a time.
 * - A model file is SHA-256 verified against the catalog pin before the
 *   first native load in each process (downloads are verified while they
 *   stream). Files left by older app versions, or modified on disk, are
 *   therefore re-checked rather than trusted because they exist; a file
 *   that fails is deleted and the model reverts to needing a download.
 *   Later loads in the same process (e.g. after the idle unload) skip the
 *   re-hash to avoid re-reading hundreds of MB on every recording.
 */
export class ModelManager extends EventEmitter {
  private states = new Map<string, ModelState>();
  private loadedModelId: string | null = null;
  private loadedModel: unknown = null; // TranscribeModel instance (lazy typed)
  /** Model ids whose on-disk file has been verified in this process. */
  private verifiedModelIds = new Set<string>();

  constructor(private readonly cacheDir: string) {
    super();
    this.initializeStates();
  }

  private initializeStates(): void {
    for (const info of getCatalog()) {
      const localPath = this.modelPath(info);
      const downloaded = existsSync(localPath);
      this.states.set(info.id, {
        info,
        status: downloaded ? "downloaded" : "not-downloaded",
        localPath: downloaded ? localPath : undefined,
      });
    }
  }

  private modelPath(info: ModelInfo): string {
    return path.join(this.cacheDir, info.id, info.hfFilename);
  }

  /** Get all known model states. */
  getAllStates(): ModelState[] {
    return [...this.states.values()];
  }

  /** Get a single model state. */
  getState(modelId: string): ModelState | undefined {
    return this.states.get(modelId);
  }

  /** Get the currently loaded model ID. */
  getLoadedModelId(): string | null {
    return this.loadedModelId;
  }

  /**
   * Download a model from HuggingFace Hub with progress reporting.
   * Returns an async generator yielding progress 0–1.
   */
  async *download(
    modelId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<number, void, unknown> {
    const info = findModel(modelId);
    if (!info) throw new Error(`Unknown model: ${modelId}`);

    const state = this.states.get(modelId)!;
    if (state.status === "downloaded" || state.status === "loaded") {
      yield 1;
      return;
    }

    this.updateState(modelId, { status: "downloading", downloadProgress: 0 });

    try {
      const { downloadModel } = await import("./model-downloader.js");
      const targetDir = path.join(this.cacheDir, modelId);

      for await (const progress of downloadModel(info, targetDir, signal)) {
        this.updateState(modelId, { status: "downloading", downloadProgress: progress });
        yield progress;
      }
      // downloadModel only renames the file into place after its streamed
      // SHA-256 matched the catalog pin.
      this.verifiedModelIds.add(modelId);

      const localPath = this.modelPath(info);
      this.updateState(modelId, {
        status: "downloaded",
        downloadProgress: 1,
        localPath,
      });
      yield 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState(modelId, {
        status: "error",
        error: `Download failed: ${message}`,
      });
      throw error;
    }
  }

  /** Delete a downloaded model. */
  async deleteModel(modelId: string): Promise<void> {
    if (this.loadedModelId === modelId) {
      this.unload();
    }

    const info = findModel(modelId);
    if (!info) return;

    this.verifiedModelIds.delete(modelId);
    const modelDir = path.join(this.cacheDir, modelId);
    const { rm } = await import("node:fs/promises");
    await rm(modelDir, { recursive: true, force: true });
    this.updateState(modelId, { status: "not-downloaded", localPath: undefined });
  }

  /** Ensure a model is loaded into memory. Lazy-imports transcribe-cpp. */
  async ensureLoaded(modelId: string): Promise<void> {
    if (this.loadedModelId === modelId && this.loadedModel) return;

    const state = this.states.get(modelId);
    if (!state || !state.localPath) {
      throw new Error(`Model ${modelId} is not downloaded`);
    }

    // Unload any previously loaded model
    this.unload();

    this.updateState(modelId, { status: "loading" });

    if (!this.verifiedModelIds.has(modelId)) {
      try {
        await verifyModelFile(state.info, state.localPath);
        this.verifiedModelIds.add(modelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ModelIntegrityError) {
          // Never hand an unverified file to the native parser, and do not
          // leave it on disk to be picked up as "downloaded" next launch.
          this.updateState(modelId, {
            status: "error",
            localPath: undefined,
            error: `Verification failed: ${message}`,
          });
          // A failed delete is safe to ignore: the file is still re-verified
          // (and rejected again) before any future load.
          const { rm } = await import("node:fs/promises");
          await rm(state.localPath, { force: true }).catch(() => {});
        } else {
          this.updateState(modelId, { status: "error", error: `Load failed: ${message}` });
        }
        throw error;
      }
    }

    try {
      const transcribeCpp = await import("transcribe-cpp");
      const model = await transcribeCpp.TranscribeModel.load(state.localPath);
      this.loadedModel = model;
      this.loadedModelId = modelId;
      this.updateState(modelId, { status: "loaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState(modelId, { status: "error", error: `Load failed: ${message}` });
      throw error;
    }
  }

  /** Get the loaded transcribe-cpp model instance. */
  getLoadedModel(): unknown {
    return this.loadedModel;
  }

  /** Unload the currently loaded model to free memory. */
  unload(): void {
    if (this.loadedModel && typeof (this.loadedModel as any).dispose === "function") {
      try {
        (this.loadedModel as any).dispose();
      } catch {
        // Best-effort cleanup
      }
    }
    if (this.loadedModelId) {
      const state = this.states.get(this.loadedModelId);
      if (state && state.status === "loaded") {
        this.updateState(this.loadedModelId, { status: "downloaded" });
      }
    }
    this.loadedModel = null;
    this.loadedModelId = null;
  }

  private updateState(modelId: string, patch: Partial<ModelState>): void {
    const current = this.states.get(modelId);
    if (!current) return;
    const next = { ...current, ...patch };
    this.states.set(modelId, next);
    this.emit("modelStateChanged", modelId, next);
  }
}
