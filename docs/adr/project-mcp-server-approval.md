# ADR: Project MCP servers run only after content-bound approval

- Status: Accepted (implementation candidate)
- Date: 2026-10-12
- Decision: D657
- Amends: [ADR 0056](0056-extension-activation-scope.md) and [ADR 0112](0112-agent-capability-management-roots-and-settings-ia.md) (project-level MCP activation default); D193
- Related: [ADR 0254](0254-native-pi-session-continuation.md), [security §4.4](../spec/05-security/01-security.md#44-project-provided-capabilities)

## Context

A project's `<project>/.agents/servers/*.json` files arrive with whatever
repository the user opened. host-core listed every such file as a project MCP
server and treated a record with no stored state as enabled. Opening a project
and then building the composer command list or launching a session made
Electron Main connect to every active server, and a stdio server is a child
process started with `commandPolicy: "trusted"` in the project directory. A
cloned repository could therefore run an arbitrary command on the user's
machine with no prompt.

Native Pi continuation had a narrower variant: it refused a project whose
trust-requiring resources existed and were untrusted, but then built its
settings manager with `projectTrusted: true` regardless, so a resource that
appeared between the check and loading would run.

## Decision

1. A project-level MCP server is runnable only when the user approved the exact
   content it would execute or reach. host-core computes a SHA-256 over the
   execution-relevant fields — transport, command, args, env, url, headers — in
   a fixed field order. `id`, `label`, `description`, and `timeoutSeconds` are
   excluded: they do not change what runs, and a rename on move must not void
   an approval.
2. Approvals are application-local state owned by host-core, stored beside the
   existing enable switches in `<data>/agent-capabilities/mcp.json` under a new
   `approvals` map keyed exactly like `values`. They are never written to the
   portable server file and are stripped from configuration-sync payloads.
3. Project records carry `configHash` and `approval`
   (`approved` | `pending` | `changed`). `enabled` is reported true only when the
   switch is on **and** the approval matches the current hash. A changed file
   therefore stops running at the next list, and reads as `changed` until the
   user reviews it again.
4. `mcp.approve({ id, projectPath, configHash })` approves and switches on one
   project server. The caller echoes the hash it displayed; a mismatch is
   refused with `MCP_INVALID`, so a file edited while the review was on screen
   is never approved. `mcp.setEnabled(true)` on an unapproved project server is
   refused with `MCP_INVALID`.
5. Content the user authors through the app is approved as written: a new
   project server saved through `mcp.upsert` (unless saved disabled), an edit to
   an already-approved one, and a server that was running at its source when
   moved into a project. Editing a server that is still pending does not approve
   it, because the edit carries over fields the user may not have reviewed.
6. Global servers (`~/.agents/servers`) are unchanged: they live in the user's
   own home directory and keep their default-on meaning.
7. Electron Main's `UserMcpRuntime` independently refuses to connect or test a
   `level: "project"` record whose `approval` is not `approved`, as a last gate
   before a process is spawned or a socket opened.
8. Settings > Agent > MCP shows a pending or changed project server with a
   badge and a review block that lists the full command line (arguments with
   whitespace quoted), environment, URL, and headers, plus an
   "Approve and enable" action. The enable switch and Test connection are not
   offered until approval.
9. Native Pi continuation passes `projectTrusted` from Pi's own
   `ProjectTrustStore` decision for the session cwd instead of `true`. The
   existing refusal of untrusted projects with trust-requiring resources is
   unchanged; the settings manager now also fails closed.

## Migration and compatibility

No schema version bump is needed: `approvals` defaults to empty, so an existing
state file reads as "nothing approved". Existing explicit `false` entries keep
their meaning (the server stays off); a project server with no stored state —
previously "on" — now reads as `pending` and does not run until approved. This
is the intended security change: every project server present before upgrade
needs one review. An older build that rewrites the state file drops
`approvals`, which also fails closed.

The record and IPC changes are additive (`configHash`, `approval`,
`mcp.approve`, `pi-desktop/mcp/approve`). Plugin-owned MCP servers and the
Plugin SDK are unaffected.

## Consequences

Users opening a project that ships MCP servers see them as "Needs approval"
instead of having them run. After a `git pull` that edits a server file, the
server stops until re-approved. Approval is per project path and per server id.

Project skills (`<project>/.agents/skills`) are **not** covered by this
decision. Their name and description enter the session's skill catalog and the
body is loaded on demand through the `Skill` tool; they do not execute code by
themselves, but they are an untrusted prompt-injection surface. Applying the
same content-bound approval to skills (which may be directories with resources)
is a follow-up decision and is tracked as residual risk in the security spec.

## Alternatives

- **Trust the whole project once.** Simpler, but a later pull could change a
  command under a standing approval; binding to the content hash avoids that.
- **Hash the raw file bytes.** Reformatting or a label edit would require
  re-approval, and a move that renames the server would always void it.
- **Disable project MCP servers entirely.** Removes a supported feature.
