import { existsSync } from "node:fs";
import * as electron from "electron";
import {
  HostProcess as RuntimeHostProcess,
  type DiagnosedHostFailure,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  GlibcUnsupportedError,
  glibcMissingSymbol,
} from "./linux-glibc";
import { DbSchemaTooNewError, parseSchemaTooNew } from "./host-boot-diagnostics";
import { redactValue } from "./logger";
import { getModuleDirectory } from "./module-path";
import {
  BUILTIN_PLUGINS_DIR_ENV,
  builtinPluginsDirCandidates,
  type CodePathContext,
  hostBinaryCandidates,
} from "./packaged-code-paths";

export type {
  HostNotificationHandler,
  ProcessExitHandler,
  StderrHandler,
} from "@pi-desktop/host-runtime";

function codePathContext(): CodePathContext {
  return {
    // `app` is missing only outside Electron (the node --test harness loads
    // this module); every Electron main process, packaged or not, has it.
    isPackaged: electron.app?.isPackaged === true,
    env: process.env,
    resourcesPath: process.resourcesPath || "",
    moduleDirectory: getModuleDirectory(import.meta.url),
    platform: process.platform,
  };
}

/**
 * The host-core binary to spawn. A packaged build only runs the one inside its
 * own `resources/bin`; `PI_DESKTOP_HOST_BIN` and the source-checkout fallbacks
 * are development-only (see `packaged-code-paths`).
 */
export function resolveHostBinary(): string {
  for (const candidate of hostBinaryCandidates(codePathContext())) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "host-core binary not found. Run `cargo build -p host-core` first.",
  );
}

/**
 * Directory holding the plugins this build ships, or null when it ships none.
 *
 * Mirrors `resolveBuiltinSkillPath`: electron-builder copies
 * `resources/plugins` to `<resources>/plugins`, and a source checkout reaches
 * the same tree relatively. Packaged builds look only inside their own
 * resources.
 */
function resolveBuiltinPluginsDir(): string | null {
  for (const candidate of builtinPluginsDirCandidates(codePathContext())) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Name the two boot refusals the desktop phrases for the user (D380): a data
 * directory newer than this build, and a glibc below the packaged floor. The
 * schema refusal is checked first because its stderr line is the more specific
 * one; anything else stays the generic `HOST_UNAVAILABLE` transport error.
 */
export function diagnoseHostFailure({
  lastStderr,
  message,
}: {
  lastStderr: string;
  message: string;
}): DiagnosedHostFailure | null {
  const schema = parseSchemaTooNew(lastStderr) ?? parseSchemaTooNew(message);
  if (schema) {
    return Object.assign(new DbSchemaTooNewError(schema), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }
  if (glibcMissingSymbol(lastStderr) || glibcMissingSymbol(message)) {
    return Object.assign(new GlibcUnsupportedError(), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }
  return null;
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[host/runtime] ${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      channel: "host",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

/**
 * The desktop's host-core child: the shared stdio transport from
 * `@pi-desktop/host-runtime` plus the two things only Electron knows — where
 * this build keeps the binary and its bundled plugins, and how to name the
 * boot refusals the renderer phrases.
 */
export class HostProcess extends RuntimeHostProcess {
  constructor(dataDir: string, onStderr?: StderrHandler) {
    const builtinPlugins = resolveBuiltinPluginsDir();
    super({
      binaryPath: resolveHostBinary(),
      dataDir,
      // Only Electron knows whether this build runs from `resources/` or a
      // source checkout, so it resolves the bundled-plugin directory and
      // host-core simply reconciles its registry against it (ADR 0105).
      env: {
        PI_DESKTOP_ELECTRON_PID: String(process.pid),
        // Always set or clear it: an inherited value must never pick the
        // tree host-core trusts as bundled (ADR 0241).
        [BUILTIN_PLUGINS_DIR_ENV]: builtinPlugins ?? undefined,
      },
      onStderr: onStderr ?? fallbackStderrLogger,
      diagnoseFailure: diagnoseHostFailure,
    });
  }
}
