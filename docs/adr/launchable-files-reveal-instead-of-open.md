# ADR: Reveal launchable files instead of opening them

- Status: Accepted (implementation candidate)
- Date: 2026-10-12
- Amends: [ADR 0109](0109-open-files-with-the-os-associated-application.md)
- Related: [ADR 0111](0111-reveal-files-in-file-manager.md) ·
  [ADR 0168](0168-main-owned-open-external-allowlist.md) ·
  [05-security/01-security](../spec/05-security/01-security.md) §2a

## Context

Three main-process paths hand a workspace- or plugin-chosen file to
`shell.openPath`: the `fs/open` IPC (work-panel files), the plugin
`fs.openDefault` API, and the browser pane's "open externally" action for a
`file:` preview. Each one checked only *where* the file lives (real-path
containment, plugin scope, the browser file root), never *what* it is.

`shell.openPath` asks the OS to open the file with its associated handler. For
`.command`, `.terminal`, `.app`, `.exe`, `.bat`, `.ps1`, `.vbs`, `.desktop`,
`.lnk`, `.url`, `.webloc`, installers, or an extensionless POSIX executable,
that handler runs code. Workspace files are written by the agent and shipped by
cloned repositories, so a single click could execute attacker-chosen code with
the user's privileges.

## Decision

1. One main-owned policy module, `apps/desktop/electron/main/safe-open-path.ts`,
   classifies a path before any `shell.openPath` with a workspace- or
   plugin-chosen path. A path is *launchable* when:
   - its final extension (case-insensitive, after folding trailing dots and
     spaces and an NTFS `:stream` suffix, which Windows ignores) is in the
     launchable list — applications, bundles, scripts, installers, shortcuts
     and location files for macOS, Windows, and Linux, plus shell scripts,
     `.jar`, and `.jnlp`; `.js` counts only on Windows, where Windows Script
     Host owns it. Only the final extension decides, so `x.pdf.command` is
     launchable and `x.command.pdf` is not;
   - it is a directory with a launchable extension (`.app`, `.workflow`, …),
     or on macOS a directory whose `Contents/Info.plist` names a
     `CFBundleExecutable`;
   - on POSIX, it is a regular file with any execute bit and not every name of
     it carries a known document extension (`.pdf`, `.png`, `.mp4`, …);
   - it cannot be inspected (`realpath`/`stat` fails).
   The literal name and the symlink-resolved name are both checked.
2. `openPathOrReveal` opens an inert path and *reveals* a launchable one in the
   OS file manager (`shell.showItemInFolder`) instead. The user can still run
   the file deliberately from there; the app never launches it on one click.
3. `fs/open` returns `FsOpenResult` (`{ ok: true, outcome: "opened" |
   "revealed", reason? }`), an additive field on the old `{ ok: true }`. The
   renderer shows the localized `panel.files.launchableRevealed` notice.
4. `fs.openDefault` keeps its `Promise<void>` SDK contract: a launchable file
   is revealed, the call resolves, the audit entry records
   `data.outcome: "revealed"` and the reason, and the host shows the same
   localized notice as a toast. The `openPath` host service re-applies the
   policy at the Electron boundary.
5. The browser pane's "open externally" for an allowed `file:` URL goes through
   the same policy and shows the same notice when it reveals.
6. App-owned directories opened on purpose (logs, project root, session
   scratch folder) are outside this policy.

## Consequences

- An agent-written or repository-supplied launcher no longer runs from a click
  in the Files panel, a plugin view, or the browser pane.
- A plugin calling `fs.openDefault` on a script now reveals it instead of
  opening it in the user's script handler. A plugin cannot opt out.
- Files with a stray execute bit and an unrecognized extension are revealed
  rather than opened; the notice tells the user why.
- No IPC channel, permission, or persisted data changes. `FsOpenResult` is
  additive; older renderers ignore the new fields.

## Alternatives considered

- **Refuse with an error.** Rejected: the user asked to see the file, and the
  file manager is a safe, useful fallback that keeps the deliberate path open.
- **Allowlist of openable document types.** Rejected for now: it would break
  opening the long tail of legitimate document formats. The denylist plus the
  execute-bit rule covers the launch vectors the OS actually honors.
- **A confirmation dialog.** Rejected: a dialog trains click-through and still
  executes on confirm; revealing never executes.
