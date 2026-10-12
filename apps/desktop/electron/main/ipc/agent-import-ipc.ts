/**
 * Batch import handlers for third-party AI-tool skills and MCP servers.
 *
 * `*Scan` handlers wrap the on-disk scanners in the `importers/` directory and
 * translate their failures into a `sources[]` row so the panel never receives a
 * rejected promise. `*Run` handlers replay each candidate through the host RPC
 * one at a time and bucket the results into `imported / skipped / failed`, so a
 * single bad entry does not abort the batch.
 *
 * MCP candidates can carry API tokens in `env` / `headers`, so the MCP scan
 * returns a redacted projection plus a `scanId`; the full candidates stay in
 * an in-memory `McpScanCache` and `importRun` resolves the user's selections
 * against it. Secret values never reach the renderer.
 *
 * `runSkillImport`, `runMcpImport`, `scanMcpForRenderer` and
 * `runMcpImportFromScan` are exported so the unit test can drive them against
 * a stub host without booting a real sidecar.
 */
import {
  IPC,
  type ExternalMcpImportPayload,
  type ExternalMcpImportRunResult,
  type ExternalMcpImportSelection,
  type ExternalMcpScanResult,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import { McpScanCache, redactMcpCandidate } from "../importers/agent-mcp-scan-cache";
import {
  scanExternalMcp,
  type McpCandidate,
  type McpScanResult,
  type McpSourceKind,
} from "../importers/agent-mcp-scan";
import {
  scanExternalSkills,
  type SkillCandidate,
  type SkillScanResult,
  type SkillSourceKind,
} from "../importers/agent-skill-scan";
import type { IpcRegistrar } from "./types";

export type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type AgentImportIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  refreshUserMcp?: (projectPath?: string | null) => Promise<unknown>;
  currentWorkspacePath?: () => string | null;
};

export interface SkillImportRunItem {
  source: SkillSourceKind;
  sourcePath: string;
  shape: "file" | "dir";
  rootDir?: string;
  id: string;
  name: string;
  description?: string;
}

export interface SkillImportRunPayload {
  level: "global" | "project";
  projectPath?: string;
  mode?: "copy" | "link";
  items: SkillImportRunItem[];
}

export interface SkillImportRunResult {
  imported: Array<{ item: SkillImportRunItem; skill: unknown }>;
  skipped: Array<{ item: SkillImportRunItem; reason: string }>;
  failed: Array<{ item: SkillImportRunItem; error: string }>;
}

export interface McpImportRunItem {
  source: McpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpImportRunPayload {
  /** Defaults to global for existing callers. */
  level?: "global" | "project";
  projectPath?: string;
  items: McpImportRunItem[];
}

export interface McpImportRunResult {
  imported: Array<{ item: McpImportRunItem; server: unknown }>;
  skipped: Array<{ item: McpImportRunItem; reason: string }>;
  failed: Array<{ item: McpImportRunItem; error: string }>;
}

/** True when a host error message is the "same name/id already imported" case. */
function isExistsError(message: string): boolean {
  return /already exists/i.test(message);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * Replay each skill candidate through `skills.import`. One failure never stops
 * the batch; anything that reads like "already at this level" is skipped, and
 * every other RPC error is captured with its message.
 */
export async function runSkillImport(
  hostCall: HostCall,
  payload: SkillImportRunPayload,
): Promise<SkillImportRunResult> {
  const mode = payload.mode ?? "copy";
  const level = payload.level;
  const projectPath = payload.projectPath;
  const result: SkillImportRunResult = {
    imported: [],
    skipped: [],
    failed: [],
  };
  for (const item of payload.items) {
    // Directory shape: `rootDir` is the folder that contains SKILL.md, and the
    // scanner leaves it filled. Fall back to the source path only when it is
    // missing so a partly-formed candidate still reports through the failed
    // bucket rather than silently pointing at the SKILL.md file itself.
    const path = item.shape === "dir" ? item.rootDir ?? item.sourcePath : item.sourcePath;
    const params: Record<string, unknown> = {
      path,
      id: item.id,
      name: item.name,
      level,
      mode,
      shape: item.shape,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(projectPath !== undefined ? { projectPath } : {}),
    };
    try {
      const res = await hostCall<{ skill: unknown }>("skills.import", params);
      result.imported.push({ item, skill: res?.skill });
    } catch (error) {
      const message = describeError(error);
      if (isExistsError(message)) {
        result.skipped.push({ item, reason: "exists" });
      } else {
        result.failed.push({ item, error: message });
      }
    }
  }
  return result;
}

/**
 * Assemble each MCP candidate into an `mcp.upsert` server payload. `disabled`
 * is stripped from the payload — host-core's `McpConfig` does not accept it —
 * and applied separately through `mcp.setEnabled` after a successful import so
 * the runtime never briefly starts a server the user asked to keep off.
 */
export async function runMcpImport(
  hostCall: HostCall,
  payload: McpImportRunPayload,
): Promise<McpImportRunResult> {
  const level = payload.level ?? "global";
  const projectPath = level === "project" ? payload.projectPath : undefined;
  const result: McpImportRunResult = {
    imported: [],
    skipped: [],
    failed: [],
  };
  for (const item of payload.items) {
    const server: Record<string, unknown> = {
      id: item.id,
      level,
      ...(projectPath ? { projectPath } : {}),
      transport: item.transport,
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.args !== undefined ? { args: item.args } : {}),
      ...(item.env !== undefined ? { env: item.env } : {}),
      ...(item.url !== undefined ? { url: item.url } : {}),
      ...(item.headers !== undefined ? { headers: item.headers } : {}),
    };
    try {
      const res = await hostCall<{ server: unknown }>("mcp.upsert", { server });
      if (item.disabled === true) {
        try {
          await hostCall("mcp.setEnabled", {
            id: item.id,
            level,
            ...(projectPath ? { projectPath } : {}),
            enabled: false,
          });
        } catch (error) {
          // Turning off failed after the server was written; report it as a
          // failure so the user is not left with an enabled server they did
          // not want, even though the write itself succeeded.
          result.failed.push({ item, error: describeError(error) });
          continue;
        }
      }
      result.imported.push({ item, server: res?.server });
    } catch (error) {
      const message = describeError(error);
      if (isExistsError(message)) {
        result.skipped.push({ item, reason: "exists" });
      } else {
        result.failed.push({ item, error: message });
      }
    }
  }
  return result;
}

/**
 * A synthetic `sources[]` row for a scan whose top-level call threw. The panel
 * knows how to render one; a rejected IPC promise it has nowhere to display.
 *
 * `kind: "error"` sits outside the scanners' own unions on purpose — no real
 * source ever emits it — so the row is distinguishable from a normal source
 * that happened to be missing on disk.
 */
type ScanErrorReport = {
  candidates: [];
  sources: [{ kind: "error"; path: string; exists: false; error: string; count: 0 }];
};

function scanErrorReport(error: unknown): ScanErrorReport {
  return {
    candidates: [],
    sources: [
      {
        kind: "error",
        path: "",
        exists: false,
        error: describeError(error),
        count: 0,
      },
    ],
  };
}

/**
 * Run a scan, retain its full candidates in `cache`, and return the redacted
 * projection the renderer may see. A scan that throws becomes a synthetic
 * error source row with an empty (still valid) scan handle.
 */
export async function scanMcpForRenderer(
  cache: McpScanCache,
  scan: () => Promise<McpScanResult>,
): Promise<ExternalMcpScanResult> {
  let raw: McpScanResult | ScanErrorReport;
  try {
    raw = await scan();
  } catch (error) {
    raw = scanErrorReport(error);
  }
  const candidates: McpCandidate[] = raw.candidates;
  const scanId = cache.put(candidates);
  return { scanId, candidates: candidates.map(redactMcpCandidate), sources: raw.sources };
}

function selectionOf(value: unknown): ExternalMcpImportSelection | null {
  if (!value || typeof value !== "object") return null;
  const { source, sourcePath, id } = value as Record<string, unknown>;
  if (typeof source !== "string" || typeof sourcePath !== "string" || typeof id !== "string") {
    return null;
  }
  return { source: source as ExternalMcpImportSelection["source"], sourcePath, id };
}

/**
 * Resolve the renderer's selections against the retained scan and import the
 * full candidates (including their real `env` / `headers`). The scan handle is
 * consumed; selections that do not match a live scan land in `failed`.
 */
export async function runMcpImportFromScan(
  hostCall: HostCall,
  cache: McpScanCache,
  payload: ExternalMcpImportPayload,
): Promise<ExternalMcpImportRunResult> {
  const selections = (Array.isArray(payload?.items) ? payload.items : [])
    .map(selectionOf)
    .filter((entry): entry is ExternalMcpImportSelection => entry !== null);
  const { found, missing } = cache.take(payload?.scanId, selections);
  // `runMcpImport` echoes back the item objects it was given, so key the
  // renderer-safe selection by object identity.
  const selectionByItem = new Map<McpImportRunItem, ExternalMcpImportSelection>();
  for (const { selection, candidate } of found) {
    const { warnings: _warnings, ...item } = candidate;
    selectionByItem.set(item, selection);
  }
  const level = payload?.level === "project" ? "project" : "global";
  const run = await runMcpImport(hostCall, {
    level,
    ...(typeof payload?.projectPath === "string" ? { projectPath: payload.projectPath } : {}),
    items: [...selectionByItem.keys()],
  });
  const toSelection = (item: McpImportRunItem): ExternalMcpImportSelection =>
    selectionByItem.get(item) ?? { source: item.source, sourcePath: item.sourcePath, id: item.id };
  return {
    imported: run.imported.map(({ item, server }) => ({ item: toSelection(item), server })),
    skipped: run.skipped.map(({ item, reason }) => ({ item: toSelection(item), reason })),
    failed: [
      ...run.failed.map(({ item, error }) => ({ item: toSelection(item), error })),
      ...missing.map((item) => ({ item, error: "scan expired or unknown; scan again" })),
    ],
  };
}

/** Register the four `*importScan` / `*importRun` handlers. */
export function registerAgentImportIpc({
  registrar,
  getHost,
  sendToRenderer,
  refreshUserMcp,
  currentWorkspacePath,
}: AgentImportIpcDependencies): void {
  registrar.handle(
    IPC.invoke.skillImportScan,
    async ({ projectPath }: { projectPath?: string } = {}) => {
      try {
        return await scanExternalSkills({ projectPath });
      } catch (error) {
        return scanErrorReport(error);
      }
    },
  );

  registrar.handle(IPC.invoke.skillImportRun, async (payload: SkillImportRunPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const hostCall: HostCall = (method, params) => host.call(method, params);
    const result = await runSkillImport(hostCall, payload);
    if (result.imported.length) {
      sendToRenderer(IPC.event.pluginChanged, { reason: "skill" });
    }
    return result;
  });

  const mcpScans = new McpScanCache();

  registrar.handle(
    IPC.invoke.mcpImportScan,
    async ({ projectPath }: { projectPath?: string } = {}) =>
      scanMcpForRenderer(mcpScans, () => scanExternalMcp({ projectPath })),
  );

  registrar.handle(IPC.invoke.mcpImportRun, async (payload: ExternalMcpImportPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const hostCall: HostCall = (method, params) => host.call(method, params);
    const result = await runMcpImportFromScan(hostCall, mcpScans, payload);
    if (result.imported.length) {
      if (refreshUserMcp && currentWorkspacePath) {
        await refreshUserMcp(currentWorkspacePath()).catch(() => undefined);
      }
      sendToRenderer(IPC.event.pluginChanged, { reason: "mcp" });
    }
    return result;
  });
}

export type { McpCandidate, McpScanResult, SkillCandidate, SkillScanResult };
