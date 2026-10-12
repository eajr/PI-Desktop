# Unreleased changes

- Plugins can query supported fetch redirect modes and explicitly refuse or
  inspect redirects without following them. Existing calls keep following by
  default; a local-only probe plugin demonstrates the new API.
- Use Pi 1.1.0's 3.5-character text estimate for compaction limits and its
  monotonic request duration for completed-response throughput; interrupted
  streams keep the existing fallback.
- Scanning other tools for MCP servers no longer sends their environment or
  header values (often API tokens) to the renderer. The panel shows only the
  key names; the import resolves the real values in the main process from the
  retained scan.
