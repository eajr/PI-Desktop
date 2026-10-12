/**
 * SSH host-key trust for remote hosts (ADR 0327, security spec §3.4).
 *
 * Every connection the app makes runs with `StrictHostKeyChecking=yes`, so an
 * unknown or changed host key always fails closed. A host the user has never
 * reached becomes trusted only through an explicit confirmation: the app
 * learns the key the server presents, shows its SHA-256 fingerprint, and only
 * after the user approves that exact fingerprint records the key in an
 * app-managed known_hosts file.
 *
 * The app-managed file sits *first* in `UserKnownHostsFile`, followed by the
 * OpenSSH defaults, so a key the user already trusts in `~/.ssh/known_hosts`
 * keeps working and the user's own file is never written by the app.
 *
 * The key is learned with the system `ssh` itself rather than `ssh-keyscan`:
 * `ssh` honours the user's `~/.ssh/config` (`HostName`, `Port`, `ProxyJump`,
 * `HostKeyAlias`), so the recorded entry is exactly the one later connections
 * look up. The learning connection disables every authentication method, so
 * no credential is offered to a server that is not yet trusted, and it writes
 * only to a private scratch file the app then reads.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ErrorCodes, type RemoteHostSshHostKey } from "@pi-desktop/shared";

/** OpenSSH's own per-user defaults, consulted after the app-managed file. */
export const DEFAULT_USER_KNOWN_HOSTS = ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"] as const;

/** The file name of the app-managed known_hosts under the app data dir. */
export const APP_KNOWN_HOSTS_FILE = "ssh_known_hosts";

/** `SHA256:` + unpadded base64 of a 32-byte digest, as `ssh-keygen -l` prints. */
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_TRUSTED_FINGERPRINTS = 16;
const MAX_LEARNED_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 30_000;

/** Destination of the probe, already validated by the caller. */
export type SshHostKeyTarget = {
  host: string;
  port?: number;
  user?: string;
};

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ?? {}), data });
}

/**
 * Quote one path for an OpenSSH `-o` value. OpenSSH splits multi-file options
 * on whitespace and honours double quotes, and since 8.4 expands `%` tokens in
 * `UserKnownHostsFile`; a path under "Application Support" or a Windows
 * profile with a space must survive both. Backslashes become forward slashes
 * (accepted by Windows OpenSSH) because they are escape characters in the
 * OpenSSH tokenizer. A quote or control character cannot be expressed and is
 * refused rather than mangled.
 */
export function quoteSshConfigPath(path: string): string {
  if (!path || /["\u0000-\u001f\u007f]/.test(path)) {
    throw fail("known_hosts path cannot be passed to ssh", ErrorCodes.INVALID_ARGUMENT, { field: "knownHostsFile" });
  }
  return `"${path.replace(/\\/g, "/").replace(/%/g, "%%")}"`;
}

/** The `UserKnownHostsFile=` value: app-managed file(s) first, then the user's. */
export function userKnownHostsOption(appFiles: readonly string[]): string {
  return `UserKnownHostsFile=${[...appFiles.map(quoteSshConfigPath), ...DEFAULT_USER_KNOWN_HOSTS].join(" ")}`;
}

/** The host-key options every connection uses. Unknown or changed keys fail. */
export function strictHostKeyArgs(knownHostsFile?: string): string[] {
  return [
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    knownHostsFile ? userKnownHostsOption([knownHostsFile]) : `UserKnownHostsFile=${DEFAULT_USER_KNOWN_HOSTS.join(" ")}`,
  ];
}

/** SHA-256 fingerprint of a base64 public-key blob, in `ssh-keygen -l` form. */
export function sha256Fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The algorithm name embedded at the start of an SSH public-key blob. */
function blobKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length < 1 || length > 64 || blob.length < 4 + length) return null;
  return blob.subarray(4, 4 + length).toString("latin1");
}

/**
 * Parse known_hosts text into the keys it names, deduplicated by fingerprint.
 * Marker lines (`@cert-authority`, `@revoked`) are ignored: they never come
 * from a first connection and must not be offered for approval. A line whose
 * blob does not decode, or whose declared type disagrees with the blob, is
 * dropped instead of guessed at.
 */
export function parseKnownHostsKeys(text: string): RemoteHostSshHostKey[] {
  const keys = new Map<string, RemoteHostSshHostKey>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    const fields = line.split(/\s+/);
    const [, type, encoded] = fields;
    if (!type || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    const blob = Buffer.from(encoded, "base64");
    if (blobKeyType(blob) !== type) continue;
    const fingerprint = sha256Fingerprint(blob);
    if (!keys.has(fingerprint)) keys.set(fingerprint, { type, fingerprint });
  }
  return [...keys.values()];
}

/** Validate the fingerprints a renderer request says the user approved. */
export function assertTrustedFingerprints(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TRUSTED_FINGERPRINTS
    || value.some((entry) => typeof entry !== "string" || !FINGERPRINT_PATTERN.test(entry))) {
    throw fail("trustedHostKeys must be SHA256 fingerprints", ErrorCodes.INVALID_ARGUMENT, { field: "trustedHostKeys" });
  }
  return [...new Set(value as string[])];
}

const CHANGED_PATTERNS = [/REMOTE HOST IDENTIFICATION HAS CHANGED/i, /Host key for .* has changed/i, /REVOKED HOST KEY/i];

/** Does ssh stderr say the presented key contradicts a trusted one? */
export function isHostKeyChangedDiagnostic(stderr: string): boolean {
  return CHANGED_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** Does ssh stderr say strict checking refused a key it has never seen? */
export function isHostKeyUnknownDiagnostic(stderr: string): boolean {
  return /host key is known for .* and you have requested strict checking/i.test(stderr)
    || (/Host key verification failed/i.test(stderr) && !isHostKeyChangedDiagnostic(stderr));
}

export function hostKeyChangedError(host: string, port?: number): Error {
  return fail(
    `the SSH host key for ${host} has changed; it was not accepted`,
    ErrorCodes.SSH_HOST_KEY_CHANGED,
    { host, ...(port !== undefined ? { port } : {}) },
  );
}

export function hostKeyUnknownError(host: string, port: number | undefined, keys: RemoteHostSshHostKey[]): Error {
  return fail(
    `the SSH host key for ${host} is not trusted yet`,
    ErrorCodes.SSH_HOST_KEY_UNKNOWN,
    { host, ...(port !== undefined ? { port } : {}), keys },
  );
}

/**
 * Argv for the learning connection. Its own options come first because ssh
 * keeps the first value it sees for an option. `accept-new` writes only to the
 * first `UserKnownHostsFile` — the private scratch file — and only when no
 * listed file knows the host yet, so a host that is already trusted leaves the
 * scratch file empty. Every authentication method is off: the server sees a
 * key exchange and nothing else.
 */
export function hostKeyProbeArgs(target: SshHostKeyTarget, scratchFile: string, knownHostsFile?: string): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", userKnownHostsOption(knownHostsFile ? [scratchFile, knownHostsFile] : [scratchFile]),
    "-o", "UpdateHostKeys=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ConnectTimeout=15",
    "-o", "PubkeyAuthentication=no",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "HostbasedAuthentication=no",
    "-o", "GSSAPIAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
  ];
  if (target.port !== undefined) args.push("-p", String(target.port));
  const user = target.user?.trim();
  args.push("--", user ? `${user}@${target.host}` : target.host, "true");
  return args;
}

type ProbeRun = (binary: string, args: string[]) => Promise<{ stderr: string; code: number }>;

const runProbe: ProbeRun = (binary, args) =>
  new Promise((resolveRun, rejectRun) => {
    let stderr = "";
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(fail(`${binary} could not be started: ${error.message}`, ErrorCodes.HOST_BOOTSTRAP_FAILED));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stderr, code: code ?? -1 });
    });
  });

/** Append learned lines to the app-managed file, creating it `0600`. */
async function recordTrustedKeys(knownHostsFile: string, learned: string): Promise<void> {
  await mkdir(dirname(knownHostsFile), { recursive: true, mode: 0o700 });
  let prefix = "";
  try {
    const existing = await readFile(knownHostsFile, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = learned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("@"));
  await appendFile(knownHostsFile, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(knownHostsFile, 0o600).catch(() => undefined);
}

export type EnsureHostKeyTrustedOptions = {
  /** The app-managed known_hosts file approved keys are written to. */
  knownHostsFile?: string;
  /** Fingerprints the user approved for this host in the confirmation dialog. */
  approvedFingerprints: readonly string[];
  binary?: string;
  /** Injectable for tests; defaults to spawning `binary`. */
  run?: ProbeRun;
};

/**
 * Make sure `target`'s host key is trusted before any authenticated
 * connection is attempted.
 *
 * - Already trusted (app file or the user's own known_hosts): returns.
 * - Presented key contradicts a trusted one: throws `SSH_HOST_KEY_CHANGED`.
 *   Never auto-accepted; the user resolves it outside the app.
 * - Unknown and every learned fingerprint is in `approvedFingerprints`:
 *   records the key in the app-managed file and returns.
 * - Unknown otherwise: throws `SSH_HOST_KEY_UNKNOWN` carrying the host and the
 *   learned key types and fingerprints for the confirmation dialog.
 *
 * Any other probe failure (DNS, refused connection, timeout) returns without
 * recording anything; the authenticated connection that follows runs with
 * strict checking and reports the real network error.
 */
export async function ensureHostKeyTrusted(
  target: SshHostKeyTarget,
  options: EnsureHostKeyTrustedOptions,
): Promise<void> {
  const run = options.run ?? runProbe;
  const scratchDir = await mkdtemp(join(tmpdir(), "pi-ssh-hostkey-"));
  try {
    await chmod(scratchDir, 0o700).catch(() => undefined);
    const scratchFile = join(scratchDir, "known_hosts");
    const result = await run(options.binary ?? "ssh", hostKeyProbeArgs(target, scratchFile, options.knownHostsFile));
    let learned = "";
    try {
      const info = await stat(scratchFile);
      if (info.size > MAX_LEARNED_BYTES) throw fail("ssh recorded an unexpectedly large host key", ErrorCodes.HOST_BOOTSTRAP_FAILED);
      learned = await readFile(scratchFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const keys = parseKnownHostsKeys(learned);
    if (keys.length === 0) {
      if (isHostKeyChangedDiagnostic(result.stderr) || /Host key verification failed/i.test(result.stderr)) {
        throw hostKeyChangedError(target.host, target.port);
      }
      return;
    }
    const approved = new Set(options.approvedFingerprints);
    if (options.knownHostsFile && keys.every((key) => approved.has(key.fingerprint))) {
      await recordTrustedKeys(options.knownHostsFile, learned);
      return;
    }
    throw hostKeyUnknownError(target.host, target.port, keys);
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
