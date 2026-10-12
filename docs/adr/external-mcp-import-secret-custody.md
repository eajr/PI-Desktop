# ADR: Keep external MCP import secrets in Electron main

- Status: Accepted
- Date: 2026-10-12
- Deciders: PI-Desktop core
- Related: ADR 0179, ADR 0319, `03-runtime/01-ipc-protocol.md`
  (`pi-desktop/mcp/importScan` / `importRun`), `04-ux/08-component-spec.md`
  §18.7

## Context

The external MCP workbench scans Claude Desktop, Claude Code, Cursor, Codex,
OpenCode and ChatGPT Desktop configs. Their `env` and `headers` maps routinely
hold API tokens. `importScan` returned those maps verbatim to the renderer,
and `importRun` accepted the full server definition back from it. The panel
never displayed the values, but they sat in renderer memory and crossed IPC
twice. Model configuration import (ADR 0179) already keeps secrets in main.

## Decision

- `importScan` returns `{ scanId, candidates, sources }`. Candidate `env` and
  `headers` are `Array<{ name, hasValue }>`; values never leave main.
- Main keeps the full candidates in an in-memory `McpScanCache` keyed by the
  opaque `scanId`: at most four scans, each live for ten minutes, evicted
  oldest first.
- `importRun` takes `{ scanId, level?, projectPath?, items: Array<{ source,
  sourcePath, id }> }`. Main resolves each selection against the scan, ignores
  any other renderer-supplied field, consumes the handle, and writes the real
  values through `mcp.upsert`. Unknown, expired or consumed scans put each
  selection in `failed`; the user rescans.
- The DTOs live in `@pi-desktop/shared` (`external-mcp-import.ts`) so producer
  and consumer share one contract.

## Consequences

- The renderer can no longer read or alter an imported server's command, env,
  headers or URL; it only chooses which scanned candidates to import.
- A renderer that held results across a long pause must rescan. The panel
  already rescans after every import.
- `args` and `url` remain visible to the renderer (the UI reduces URLs to the
  host); tokens embedded there are out of scope of this change.
- Electron-only IPC; no host protocol, schema or persisted-data change.
