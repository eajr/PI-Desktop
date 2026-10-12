import { join } from "node:path";

/**
 * Where the desktop finds the executable code it hands to child processes:
 * the host-core binary and the bundled plugin tree host-core reconciles.
 *
 * A packaged build resolves both only from `process.resourcesPath`, inside the
 * signed bundle. The developer overrides below and the source-checkout
 * fallbacks apply to unpackaged builds only, so an inherited environment
 * variable cannot make a signed install run a different binary or trust a
 * different plugin tree (ADR electron-fuses-and-packaged-code-paths). Data
 * location overrides such as `PI_DESKTOP_DATA_DIR` are user-facing and are not
 * handled here.
 */

/** Developer override for the host-core binary; unpackaged builds only. */
export const HOST_BIN_ENV = "PI_DESKTOP_HOST_BIN";

/**
 * Directory host-core treats as this build's bundled plugins. Electron always
 * sets (or clears) it for the host-core child; an inherited value is honored
 * as a developer override in unpackaged builds only.
 */
export const BUILTIN_PLUGINS_DIR_ENV = "PI_DESKTOP_BUILTIN_PLUGINS_DIR";

export type CodePathContext = {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** `process.resourcesPath`; may be empty outside Electron. */
  resourcesPath: string;
  /** Directory of the bundled main-process module. */
  moduleDirectory: string;
  platform: NodeJS.Platform;
};

function devOverride(ctx: CodePathContext, name: string): string[] {
  if (ctx.isPackaged) return [];
  const value = ctx.env[name]?.trim();
  return value ? [value] : [];
}

/** Ordered host-core binary candidates; the first that exists wins. */
export function hostBinaryCandidates(ctx: CodePathContext): string[] {
  const exe = ctx.platform === "win32" ? ".exe" : "";
  const packaged = join(ctx.resourcesPath, `bin/pi-desktop-host-core${exe}`);
  if (ctx.isPackaged) return [packaged];
  return [
    ...devOverride(ctx, HOST_BIN_ENV),
    packaged,
    join(ctx.moduleDirectory, `../../../../target/debug/pi-desktop-host-core${exe}`),
    join(ctx.moduleDirectory, `../../../../target/release/pi-desktop-host-core${exe}`),
  ];
}

/** Ordered bundled-plugin directory candidates; the first that exists wins. */
export function builtinPluginsDirCandidates(ctx: CodePathContext): string[] {
  const packaged = join(ctx.resourcesPath, "plugins");
  if (ctx.isPackaged) return [packaged];
  return [
    ...devOverride(ctx, BUILTIN_PLUGINS_DIR_ENV),
    packaged,
    join(ctx.moduleDirectory, "../../resources/plugins"),
    join(ctx.moduleDirectory, "../../../resources/plugins"),
  ];
}
