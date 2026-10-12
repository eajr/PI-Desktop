import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";

/**
 * Main-owned policy for paths handed to `shell.openPath` (ADR
 * launchable-files-reveal-instead-of-open).
 *
 * `shell.openPath` asks the OS to "open" a file with its associated handler.
 * For a document that is a viewer; for a `.command`, `.app`, `.exe`, `.bat`,
 * `.desktop`, `.lnk`, or an executable script it *runs code*. Workspace files
 * can be written by the agent or shipped by a cloned repository, so one click
 * on "open" must never be a launch. Launchable paths are revealed in the OS
 * file manager instead; the user can still run them deliberately from there.
 *
 * Every caller of `shell.openPath` with a workspace- or plugin-chosen path
 * goes through `openPathOrReveal`. Paths the app itself owns (the logs
 * directory, a project root, a session scratch folder) are directories opened
 * on purpose and stay outside this policy.
 */

export type LaunchableReason =
  /** The name (or the name it resolves to) has a launchable extension. */
  | "extension"
  /** A directory the OS treats as an application or installer bundle. */
  | "bundle"
  /** A POSIX file with an execute bit and no known document extension. */
  | "executable-mode"
  /** The path could not be inspected, so it is not trusted to be inert. */
  | "unverifiable";

export type OpenPathDecision =
  | { launchable: false }
  | { launchable: true; reason: LaunchableReason };

export type OpenPathOutcome =
  | { outcome: "opened" }
  | { outcome: "revealed"; reason: LaunchableReason };

/**
 * Extensions whose OS association executes code, installs software, changes
 * system configuration, or follows a link to another (possibly executable)
 * target. Checked case-insensitively on every platform: a repository is
 * portable, and refusing a `.bat` on macOS costs nothing.
 */
const LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // macOS applications, bundles, scripts, installers, and location files
  "app", "appex", "action", "applescript", "bundle", "command", "dmg",
  "fileloc", "afploc", "ftploc", "inetloc", "kext", "mobileconfig", "mpkg",
  "osax", "pkg", "plugin", "prefpane", "qlgenerator", "saver", "scpt",
  "scptd", "service", "shortcut", "terminal", "tool", "webloc", "wflow",
  "workflow", "xpc",
  // Windows executables, scripts, installers, shortcuts, and handlers
  "appref-ms", "application", "appx", "appxbundle", "bat", "chm", "cmd",
  "com", "cpl", "diagcab", "exe", "gadget", "hta", "inf", "ins", "isp",
  "jse", "library-ms", "lnk", "msc", "msh", "msh1", "msh2", "mshxml",
  "msh1xml", "msh2xml", "msi", "msix", "msixbundle", "msp", "mst", "pif",
  "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1", "psm1", "reg",
  "scf", "scr", "sct", "search-ms", "searchconnector-ms",
  "settingcontent-ms", "shb", "shs", "url", "vb", "vbe", "vbs", "ws", "wsc",
  "wsf", "wsh", "xbap",
  // Linux launchers, packages, and images
  "appimage", "deb", "desktop", "flatpak", "flatpakref", "rpm", "run",
  "snap",
  // Cross-platform interpreters and launch descriptors
  "bash", "csh", "fish", "jar", "jnlp", "ksh", "sh", "tcsh", "zsh",
]);

/** `.js` runs under Windows Script Host by default; elsewhere it is text. */
const WIN32_LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set(["js"]);

/**
 * Document types that commonly carry a stray execute bit (files unpacked
 * from an archive or copied from a FAT/SMB volume) and whose association is a
 * viewer. Only these are exempt from the POSIX execute-bit rule.
 */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "7z", "aac", "avif", "bmp", "bz2", "csv", "doc", "docx", "epub", "flac",
  "gif", "gz", "heic", "htm", "html", "ico", "jpeg", "jpg", "json", "key",
  "log", "m4a", "m4v", "md", "markdown", "mkv", "mov", "mp3", "mp4", "numbers",
  "odp", "ods", "odt", "ogg", "opus", "pages", "pdf", "png", "ppt", "pptx",
  "rtf", "svg", "tar", "tgz", "tif", "tiff", "tsv", "txt", "wav", "webm",
  "webp", "xls", "xlsx", "xml", "xz", "yaml", "yml", "zip",
]);

/**
 * Spellings the OS may resolve to the same file name. Windows ignores trailing
 * dots and spaces (`run.bat.` is `run.bat`) and an NTFS stream suffix
 * (`run.bat::$DATA`). Both are folded on every platform: the fold can only add
 * candidates, never remove the literal one.
 */
function nameSpellings(name: string): string[] {
  const lower = name.toLowerCase();
  const trimmed = lower.replace(/[. ]+$/u, "");
  const colon = trimmed.indexOf(":");
  const withoutStream = colon >= 0 ? trimmed.slice(0, colon).replace(/[. ]+$/u, "") : trimmed;
  return [...new Set([lower, trimmed, withoutStream])];
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1);
}

function isLaunchableExtension(ext: string | null, platform: NodeJS.Platform): boolean {
  if (!ext) return false;
  return LAUNCHABLE_EXTENSIONS.has(ext) || (platform === "win32" && WIN32_LAUNCHABLE_EXTENSIONS.has(ext));
}

/**
 * True when a file *name* alone marks the path as launchable. Only the final
 * extension decides the OS association, so `report.pdf.command` is launchable
 * and `run.command.pdf` is not.
 */
export function hasLaunchableExtension(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return nameSpellings(name).some((spelling) => isLaunchableExtension(extensionOf(spelling), platform));
}

function hasDocumentExtension(name: string): boolean {
  return nameSpellings(name).every((spelling) => {
    const ext = extensionOf(spelling);
    return ext !== null && DOCUMENT_EXTENSIONS.has(ext);
  });
}

async function isMacBundleDirectory(path: string): Promise<boolean> {
  try {
    // A directory with an Info.plist naming an executable is launched by
    // LaunchServices whatever its extension.
    const plist = await readFile(join(path, "Contents", "Info.plist"), "utf8");
    return plist.includes("CFBundleExecutable");
  } catch {
    return false;
  }
}

/**
 * Decide whether `shell.openPath(path)` could launch code.
 *
 * The literal name and the name it resolves to through symbolic links are
 * both checked, because the OS opens what the link points at.
 */
export async function classifyPathForOpen(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenPathDecision> {
  const names = [basename(path)];
  let info;
  try {
    const real = await realpath(path);
    if (basename(real) !== names[0]) names.push(basename(real));
    info = await stat(real);
  } catch {
    return { launchable: true, reason: "unverifiable" };
  }

  if (info.isDirectory()) {
    if (names.some((name) => hasLaunchableExtension(name, platform))) {
      return { launchable: true, reason: "bundle" };
    }
    if (platform === "darwin" && (await isMacBundleDirectory(path))) {
      return { launchable: true, reason: "bundle" };
    }
    return { launchable: false };
  }

  if (names.some((name) => hasLaunchableExtension(name, platform))) {
    return { launchable: true, reason: "extension" };
  }
  if (
    platform !== "win32" &&
    (info.mode & 0o111) !== 0 &&
    !names.every((name) => hasDocumentExtension(name))
  ) {
    return { launchable: true, reason: "executable-mode" };
  }
  return { launchable: false };
}

export interface OpenPathDeps {
  /** Hand the path to the OS default application; throws on failure. */
  openPath: (path: string) => Promise<void>;
  /** Select the path in the OS file manager. */
  revealPath: (path: string) => void | Promise<void>;
  platform?: NodeJS.Platform;
}

/**
 * Open `path` with its default application, or — when that could launch
 * code — reveal `revealTarget` (default: `path`) in the file manager instead.
 */
export async function openPathOrReveal(
  path: string,
  deps: OpenPathDeps,
  revealTarget: string = path,
): Promise<OpenPathOutcome> {
  const decision = await classifyPathForOpen(path, deps.platform);
  if (decision.launchable) {
    await deps.revealPath(revealTarget);
    return { outcome: "revealed", reason: decision.reason };
  }
  await deps.openPath(path);
  return { outcome: "opened" };
}

/** Localized notice for a reveal that replaced an open. */
export function launchableRevealedNotice(locale: string | undefined): string {
  return catalogs[resolveLocale(locale)].panel.files.launchableRevealed;
}
