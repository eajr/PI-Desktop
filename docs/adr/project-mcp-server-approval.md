# ADR: Project MCP servers run only after content-bound approval

- Status: Accepted (implementation candidate)
- Date: 2026-10-12
- Decision: D659; extended to project skills by D661
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

Project skills follow the same model; see the next section.

## Extension: project skills (D661)

A project skill (`<project>/.agents/skills/<id>.md` or
`<project>/.agents/skills/<id>/SKILL.md`) executes nothing by itself, but its
name and description enter the session's skill catalog, the composer offers it
as a slash command, and its body is returned verbatim by the `Skill` tool. A
cloned repository could therefore plant instructions that steer the model. D661
applies decisions 1-6 and 8 to skills:

1. The approval subject is the raw bytes of the skill document (`SKILL.md` or
   the flat `<id>.md`), hashed with SHA-256. That document is everything the
   runtime injects: frontmatter `name` and `description` for the catalog and the
   body for the `Skill` tool, which also names the document's location. Sibling
   resources in a directory-shaped skill are not hashed: the runtime never
   injects them, and the model can reach them only through the ordinary,
   permission-checked file tools, exactly like any other file in the
   repository. Hashing them would also mean reading up to 16 MiB per skill on
   every catalog scan.
2. Approvals use the same `approvals` map, in
   `<data>/agent-capabilities/skills.json`, and are stripped from
   configuration-sync payloads.
3. Project skill records carry `contentHash` and `approval`. `enabled` is true
   only when the switch is on and the approval matches the current hash, so
   `skills.active` (session catalog, composer slash commands, mention
   expansion) omits an unapproved or changed project skill. A pending project
   skill still shadows a global skill with the same id or name, as a disabled
   one already did, so the catalog and `skills.read` never disagree about which
   document an id names.
4. `skills.approve({ id, projectPath, contentHash })` approves and switches on
   one project skill and refuses a stale hash; `skills.setEnabled(true)` refuses
   an unapproved project skill (`SKILL_INVALID`). `skills.read` refuses a
   project document whose bytes changed between the scan and the read, so the
   approval verdict it returns always describes the body it returns.
5. A project skill created or imported through the app is approved as written
   (unless saved disabled, as a configuration-sync copy of an inactive skill
   is); an edit to an approved skill stays approved; editing a pending one does
   not approve it; a skill active at its source stays approved when moved into a
   project. A link-mode import is re-reviewed whenever its target changes.
6. Every `Skill` tool host checks activity, not just existence: Desktop's tool
   already required `isActiveInProject`, and the headless Pi Host tool now does
   too, so a planted document cannot be loaded by guessing its id.
7. Settings > Agent > Skills shows a pending or changed project skill with a
   badge and a review block. "Review text" loads the document; the block then
   shows its name, description and body, and "Approve and enable" echoes the
   hash returned by that same read. The enable switch is hidden until approval.
8. Native Pi continuation reads `.agents/skills` through the Pi SDK, gated by
   Pi's own project trust decision (decision 9); that boundary is unchanged.

Upgrade behaviour matches MCP servers: every project skill present before
upgrade reads as `pending` once, an explicit off stays off, and global skills
are unaffected.

## Alternatives

- **Trust the whole project once.** Simpler, but a later pull could change a
  command under a standing approval; binding to the content hash avoids that.
- **Hash the raw file bytes.** Reformatting or a label edit would require
  re-approval, and a move that renames the server would always void it.
- **Disable project MCP servers entirely.** Removes a supported feature.
