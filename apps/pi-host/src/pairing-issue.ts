import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { importFailureCode } from "./provider-import.js";

/**
 * `pi-host pairing-issue [--data-dir <dir>]`: ask the running Host, over its
 * owner-only admin socket, for a fresh single-use pairing token. The desktop
 * runs this over SSH when the Host refused its device token as expired, then
 * exchanges the token over the existing forward. The Host is not restarted.
 *
 * stdout carries exactly one line: `PI_HOST_PAIRING_TOKEN {...}` on success,
 * `PI_HOST_FAILED {"code":..}` otherwise.
 */
export async function runPairingIssue(
  argv: string[],
  io: { stdout: NodeJS.WritableStream } = process,
): Promise<number> {
  try {
    if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--data-dir" && argv[1])) {
      io.stdout.write(`PI_HOST_FAILED ${JSON.stringify({ code: "INVALID_REQUEST" })}\n`);
      return 1;
    }
    const dataDir = resolve(argv[1] ?? process.env.PI_DESKTOP_DATA_DIR ?? join(homedir(), ".pi-desktop"));
    const { requestAdminPairing } = await import("./admin-socket.js");
    const pairing = await requestAdminPairing(dataDir);
    io.stdout.write(`PI_HOST_PAIRING_TOKEN ${JSON.stringify(pairing)}\n`);
    return 0;
  } catch (error) {
    io.stdout.write(`PI_HOST_FAILED ${JSON.stringify({ code: importFailureCode(error) })}\n`);
    return 1;
  }
}
