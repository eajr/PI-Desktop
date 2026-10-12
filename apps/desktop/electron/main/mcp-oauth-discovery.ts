/** MCP authorization discovery rules, independent of network and login state. */
export function authorizationMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  const paths = path
    ? [
        `/.well-known/oauth-authorization-server${path}`,
        `/.well-known/openid-configuration${path}`,
        `${path}/.well-known/openid-configuration`,
      ]
    : ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"];
  return paths.map((candidate) => {
    const url = new URL(issuer.origin);
    url.pathname = candidate;
    return url.toString();
  });
}

/** Read one Bearer challenge without borrowing parameters from another scheme. */
export function parseBearerChallenge(header: string): {
  resourceMetadataUrl?: string;
  scope?: string;
} {
  const params = new Map<string, string>();
  let bearer = false;
  // Commas inside quoted strings delimit neither parameters nor challenges.
  for (const part of header.match(/(?:[^",]|"(?:\\.|[^"\\])*")+/g) ?? []) {
    let value = part.trim();
    const scheme = value.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]+(?![ \t]*=)|$)/);
    if (scheme) {
      if (bearer) break;
      bearer = scheme[1].toLowerCase() === "bearer";
      value = value.slice(scheme[0].length);
    }
    if (!bearer) continue;
    const param = value.match(/^([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]+))\s*$/);
    if (param) {
      const key = param[1].toLowerCase();
      if (!params.has(key)) params.set(key, param[2]?.replace(/\\(.)/g, "$1") ?? param[3]);
    }
  }
  return { resourceMetadataUrl: params.get("resource_metadata"), scope: params.get("scope") };
}

// RFC 6749 scope-token excludes whitespace, double quotes and backslashes.
function isScopeToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value);
}

export function selectOAuthScope(challengeScope: string | undefined, resourceScopes: unknown): string | undefined {
  if (challengeScope) {
    const tokens = challengeScope.split(" ").filter(Boolean);
    if (tokens.length > 0 && tokens.every(isScopeToken)) return tokens.join(" ");
  }
  if (!Array.isArray(resourceScopes)) return undefined;
  return resourceScopes.filter(isScopeToken).join(" ") || undefined;
}

/**
 * Canonical resource / issuer identifier for comparison (MCP authorization
 * spec, RFC 8707 §2): lowercase scheme and host, default port dropped, no
 * fragment, and no trailing slash on the path. Returns undefined for a value
 * that is not an absolute http(s) URL.
 */
export function canonicalOAuthIdentifier(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * RFC 9728 §3.3 / §7.3: the `resource` in protected-resource metadata must name
 * the MCP server the user configured, or a token minted for it could be scoped
 * to (and replayed against) another service. Accepted when the canonical forms
 * are equal, or when `resource` is the same origin and a whole-segment path
 * prefix of the server URL (the MCP SDK's `checkResourceAllowed` rule, so a
 * server at `/mcp` may advertise its origin as the resource). A `resource`
 * with a query must match exactly.
 */
export function resourceCoversServerUrl(resource: unknown, serverUrl: string): boolean {
  const claimed = canonicalOAuthIdentifier(resource);
  const server = canonicalOAuthIdentifier(serverUrl);
  if (!claimed || !server) return false;
  if (claimed === server) return true;
  const claimedUrl = new URL(claimed);
  const serverObj = new URL(server);
  if (claimedUrl.origin !== serverObj.origin || claimedUrl.search) return false;
  const prefix = claimedUrl.pathname.replace(/\/+$/, "");
  return prefix === "" || serverObj.pathname === prefix || serverObj.pathname.startsWith(`${prefix}/`);
}

/** RFC 8414 §3.3: the metadata `issuer` must be the issuer the client asked for. */
export function issuerMatches(issuer: unknown, expectedIssuer: string): boolean {
  const claimed = canonicalOAuthIdentifier(issuer);
  return claimed !== undefined && claimed === canonicalOAuthIdentifier(expectedIssuer);
}
