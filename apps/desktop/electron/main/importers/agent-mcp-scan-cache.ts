/**
 * Main-process custody of external MCP scan results.
 *
 * A scan reads other tools' configs, whose `env` / `headers` values are often
 * API tokens. Those values never cross IPC: the renderer gets a redacted copy
 * of each candidate and an opaque `scanId`, and the full candidates stay here
 * until the matching import consumes them, a newer scan evicts them, or they
 * expire.
 */
import { randomUUID } from "node:crypto";
import type {
  ExternalMcpCandidate,
  ExternalMcpImportSelection,
  ExternalMcpRedactedEntry,
} from "@pi-desktop/shared";
import type { McpCandidate } from "./agent-mcp-scan";

/** How long an unconsumed scan stays importable. */
export const MCP_SCAN_TTL_MS = 10 * 60 * 1000;
/** Upper bound on concurrently retained scans (one per open panel is typical). */
export const MCP_SCAN_MAX_ENTRIES = 4;

function redactEntries(
  map: Record<string, string> | undefined,
): ExternalMcpRedactedEntry[] | undefined {
  if (!map) return undefined;
  return Object.entries(map).map(([name, value]) => ({ name, hasValue: value.length > 0 }));
}

/** The renderer-safe projection of a scanned candidate. */
export function redactMcpCandidate(candidate: McpCandidate): ExternalMcpCandidate {
  const { env, headers, ...rest } = candidate;
  const out: ExternalMcpCandidate = { ...rest };
  const redactedEnv = redactEntries(env);
  if (redactedEnv) out.env = redactedEnv;
  const redactedHeaders = redactEntries(headers);
  if (redactedHeaders) out.headers = redactedHeaders;
  return out;
}

function selectionKey(selection: ExternalMcpImportSelection): string {
  return JSON.stringify([selection.source, selection.sourcePath, selection.id]);
}

type CacheEntry = { expiresAt: number; candidates: Map<string, McpCandidate> };

export class McpScanCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    opts: {
      ttlMs?: number;
      maxEntries?: number;
      now?: () => number;
      newId?: () => string;
    } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? MCP_SCAN_TTL_MS;
    this.maxEntries = Math.max(1, opts.maxEntries ?? MCP_SCAN_MAX_ENTRIES);
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  /** Retain a scan's full candidates and return its handle. */
  put(candidates: McpCandidate[]): string {
    this.prune();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const scanId = this.newId();
    const map = new Map<string, McpCandidate>();
    for (const candidate of candidates) {
      const key = selectionKey(candidate);
      if (!map.has(key)) map.set(key, candidate);
    }
    this.entries.set(scanId, { expiresAt: this.now() + this.ttlMs, candidates: map });
    return scanId;
  }

  /**
   * Remove a scan and resolve the selections against it. Single use: a second
   * import with the same `scanId` finds nothing. Unknown or expired scans
   * resolve every selection as missing.
   */
  take(
    scanId: unknown,
    selections: readonly ExternalMcpImportSelection[],
  ): { found: Array<{ selection: ExternalMcpImportSelection; candidate: McpCandidate }>; missing: ExternalMcpImportSelection[] } {
    this.prune();
    const entry = typeof scanId === "string" ? this.entries.get(scanId) : undefined;
    if (typeof scanId === "string") this.entries.delete(scanId);
    const found: Array<{ selection: ExternalMcpImportSelection; candidate: McpCandidate }> = [];
    const missing: ExternalMcpImportSelection[] = [];
    for (const selection of selections) {
      const candidate = entry?.candidates.get(selectionKey(selection));
      if (candidate) found.push({ selection, candidate });
      else missing.push(selection);
    }
    return { found, missing };
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
