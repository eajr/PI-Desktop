/**
 * Renderer-facing contract for `pi-desktop/mcp/importScan` and
 * `pi-desktop/mcp/importRun`.
 *
 * Other tools' MCP configs routinely carry API tokens in `env` and `headers`.
 * Those values stay in Electron main: a scan returns only the variable / header
 * names plus a `hasValue` flag, and an import names the candidates it wants by
 * `scanId` + `{ source, sourcePath, id }`. Main resolves the real values from
 * the scan it kept in memory.
 */
export type ExternalMcpSourceKind =
  | "claude-desktop"
  | "claude-code"
  | "cursor-global"
  | "cursor-project"
  | "codex"
  | "opencode"
  | "chatgpt-desktop";

/** A redacted `env` or `headers` entry: the key is shown, the value never is. */
export interface ExternalMcpRedactedEntry {
  name: string;
  hasValue: boolean;
}

export interface ExternalMcpCandidate {
  source: ExternalMcpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: ExternalMcpRedactedEntry[];
  url?: string;
  headers?: ExternalMcpRedactedEntry[];
  disabled?: boolean;
  warnings: string[];
}

export interface ExternalMcpSourceReport {
  kind: ExternalMcpSourceKind | "error";
  path: string;
  exists: boolean;
  error?: string;
  count: number;
}

export interface ExternalMcpScanResult {
  /** Opaque handle for the scan kept in main; expires and is single-use. */
  scanId: string;
  candidates: ExternalMcpCandidate[];
  sources: ExternalMcpSourceReport[];
}

/** Identifies one candidate from a prior scan. */
export interface ExternalMcpImportSelection {
  source: ExternalMcpSourceKind;
  sourcePath: string;
  id: string;
}

export interface ExternalMcpImportPayload {
  scanId: string;
  /** Defaults to global for existing callers. */
  level?: "global" | "project";
  projectPath?: string;
  items: ExternalMcpImportSelection[];
}

export interface ExternalMcpImportRunResult<TServer = unknown> {
  imported: Array<{ item: ExternalMcpImportSelection; server: TServer }>;
  skipped: Array<{ item: ExternalMcpImportSelection; reason: string }>;
  failed: Array<{ item: ExternalMcpImportSelection; error: string }>;
}
