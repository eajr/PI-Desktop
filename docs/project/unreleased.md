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
- Removed the hidden local dictation feature and the host speech
  (transcribe/synthesize) capability. The app no longer ships the
  `transcribe-cpp` and PvRecorder native modules or downloads speech models
  from Hugging Face. Live Voice is unchanged and now always captures from the
  system default microphone. Previously downloaded models stay in the
  `voice-models` folder under the app data directory and can be deleted by
  hand.
- Plugin SDK: the `speech.adapter.register` permission and the `pi.speech` API
  are removed. Plugins that still declare the permission keep loading, but
  `pi.speech.registerAdapter` / `unregisterAdapter` now fail with
  `UNSUPPORTED`, and `pi-plugin check` reports the permission as removed.
