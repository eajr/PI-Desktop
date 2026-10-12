/**
 * Re-pair an SSH-managed Host whose device token expired (security §3.4).
 *
 * The SSH login is the root of trust for pairing, so a Host that refuses this
 * desktop's device token as expired does not need the user: the desktop asks
 * the running `pi-host` for a fresh single-use pairing token over SSH, through
 * the Host's owner-only admin socket, and exchanges it over the forward for a
 * new device token. Nothing is installed or restarted, so work running on the
 * Host is untouched. A revoked or unknown token is a different refusal
 * (`REMOTE_AUTH_FAILED`) and never reaches this path.
 */
import { ErrorCodes, type RemoteHostSshMetadata } from "@pi-desktop/shared";
import { parseBootstrapOutput } from "./pi-host-bootstrap-script.js";
import type { SshTarget, SshTransport } from "./ssh-transport.js";
import { sshTargetOf } from "./ssh-tunnel.js";

/** Prefers the bundled Node, as the readiness supervisor does. */
export const PAIRING_ISSUE_COMMAND =
  'base="$HOME/.pi-desktop/pi-host/current"; node="$base/bin/node"; [ -x "$node" ] || node=node; ' +
  'exec "$node" "$base/pi-host.js" pairing-issue';
const OUTPUT_MAX_BYTES = 16 * 1024;

export type RepairDeviceInput = {
  ssh: RemoteHostSshMetadata;
  sshSecret?: string;
  /** Loopback RACP URL of the live forward to this Host. */
  url: string;
  label: string;
  buildTransport: (target: SshTarget) => SshTransport;
  exchangePairing: (input: { url: string; pairingToken: string; label: string; expectedHostId?: string }) => Promise<string>;
};

export function isDeviceTokenExpired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fields = error as { errorCode?: string; code?: string };
  return (fields.errorCode ?? fields.code) === ErrorCodes.REMOTE_DEVICE_TOKEN_EXPIRED;
}

function failed(): Error {
  // SSH output may carry the pairing token; never echo it into the error.
  return Object.assign(new Error("Remote Host re-pairing over SSH failed"), {
    errorCode: ErrorCodes.REMOTE_DEVICE_TOKEN_EXPIRED, retriable: false,
  });
}

/** Mint a pairing token over SSH and exchange it; returns the new device token. */
export async function repairDeviceOverSsh(input: RepairDeviceInput): Promise<string> {
  const transport = input.buildTransport(sshTargetOf(input.ssh, input.sshSecret));
  let pairingToken: string;
  try {
    const result = await transport.exec(PAIRING_ISSUE_COMMAND, { timeoutMs: 60_000 });
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > OUTPUT_MAX_BYTES) throw failed();
    const pairing = parseBootstrapOutput(result.stdout).pairing;
    if (!pairing) throw failed();
    pairingToken = pairing.token;
  } catch {
    throw failed();
  } finally {
    transport.dispose();
  }
  // The exchange verifies the Host identity before spending the token.
  return input.exchangePairing({
    url: input.url, pairingToken, label: input.label,
    ...(input.ssh.hostId ? { expectedHostId: input.ssh.hostId } : {}),
  });
}
