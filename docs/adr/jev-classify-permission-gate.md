# ADR: JevClassify passes the host-core permission gate

- Status: Accepted
- Date: 2026-10-12

## Context

`JevClassify` sends up to 24 KiB of model-chosen JSON (`state` and
`questions`) to TypeSafe (`api.typesafe.ai`). The sidecar called the
classifier directly, so the call never reached host-core `tools.execute` and
the session's permission mode did not apply: under `ask`, the Agent could send
workspace content to a third party without an approval card. Enabling Jev in
Settings opts into the tool being offered, not into every payload leaving the
machine. `GenerateImages`, the other third-party request tool, is already
authorized by host-core before the trusted runner performs the request.

## Decision

Before any request, the sidecar calls `tools.execute` with
`toolName: "JevClassify"` and the validated `state`/`questions`. Host-core
classifies `JevClassify` as `high` risk and evaluates it like any other tool:
`ask` and `accept-edits` show an approval card, `allow-session` grants cover the
tool for the session, `auto` auto-allows, and Plan/Goal hard-deny. Host-core
returns only `{ authorized: true }` and never contacts TypeSafe. The approval
card's reason names the destination host, and its preview (`destination`,
`payloadBytes`, `state`, `questions`) is computed by host-core rather than
accepted from the caller. `tools.abort` cancels a pending card. Deny,
cancellation, or a gate error returns a tool error, and the sidecar makes no
request.

`tools.execute` gains one accepted tool name; parameters, results, and the
`permissions.request` shape are unchanged. No schema or persistence change.

## Consequences

Users in `ask` and `accept-edits` approve each `JevClassify` call (or grant it
for the session) and see where the data goes and how large it is. Users in
`auto` keep the previous no-prompt behavior, consistent with `GenerateImages`.
The request itself still runs in the sidecar, which holds the key; the gate is
enforced by runtime code, not by process isolation.

## Alternatives

Moving the request into Electron main as a host-local tool (the
`GenerateImages` pattern) would keep the key out of the sidecar, but is a
larger change to key delivery and tool dispatch. Treating third-party egress as
always-prompt even under `auto` would diverge from `GenerateImages` and from
what users opted into with `auto`.
