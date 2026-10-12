/** Only approved localized summaries cross into remote-host UI; never raw stderr. */
export function remoteHostErrorKey(error: unknown): string {
  let code: unknown;
  if (error && typeof error === "object") {
    code = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  }
  switch (code) {
    case "REMOTE_PATH_NOT_FOUND": return "remote:pathUnavailable";
    case "REMOTE_PATH_FORBIDDEN": return "remote:pathForbidden";
    case "HOST_VERSION_MISMATCH": return "remote:upgradeRequired";
    case "HOST_AUTH_FAILED":
    case "SSH_AUTH_FAILED":
    case "TOKEN_INVALID":
    case "PAIRING_FAILED": return "remote:authenticationRequired";
    case "HOST_DISCONNECTED":
    case "REMOTE_CONNECTION_FAILED":
    case "AGENT_UNAVAILABLE": return "remote:connectionUnavailable";
    case "REMOTE_MUTATION_OUTCOME_UNKNOWN": return "remote:mutationUncertain";
    case "SSH_HOST_KEY_CHANGED": return "remote:hostKeyChanged";
    case "SSH_HOST_KEY_UNKNOWN": return "remote:hostKeyUntrusted";
    default: return "remote:operationFailed";
  }
}

export type RemoteHostKeyPrompt = {
  host: string;
  port?: number;
  keys: { type: string; fingerprint: string }[];
};

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * The host-key confirmation an `SSH_HOST_KEY_UNKNOWN` error asks for, or null.
 * Only well-formed fingerprints are shown: anything else falls back to the
 * plain error toast rather than inviting the user to trust a garbled key.
 */
export function hostKeyPromptOf(error: unknown): RemoteHostKeyPrompt | null {
  if (!error || typeof error !== "object") return null;
  const fields = error as { code?: unknown; errorCode?: unknown; details?: unknown };
  if ((fields.code ?? fields.errorCode) !== "SSH_HOST_KEY_UNKNOWN") return null;
  const details = fields.details as { host?: unknown; port?: unknown; keys?: unknown } | undefined;
  if (!details || typeof details.host !== "string" || !details.host || !Array.isArray(details.keys)) return null;
  const keys = details.keys.filter(
    (key): key is { type: string; fingerprint: string } =>
      !!key && typeof key === "object"
      && typeof (key as { type?: unknown }).type === "string"
      && /^[A-Za-z0-9@.-]{1,64}$/.test((key as { type: string }).type)
      && typeof (key as { fingerprint?: unknown }).fingerprint === "string"
      && FINGERPRINT.test((key as { fingerprint: string }).fingerprint),
  );
  if (keys.length === 0 || keys.length !== details.keys.length) return null;
  const port = typeof details.port === "number" && Number.isInteger(details.port) ? details.port : undefined;
  return { host: details.host, ...(port !== undefined ? { port } : {}), keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) };
}
