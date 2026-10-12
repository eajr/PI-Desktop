# ADR: Remove local Dictation and host speech

- Status: Accepted
- Date: 2026-10-12
- Decision: D662
- Supersedes: ADR 0281; ADR 0291
- Related: ADR 0257, [live-voice.md](../spec/03-runtime/live-voice.md),
  [20-speech.md](../spec/03-runtime/20-speech.md) (now a removal note)

## Context

The app carried two speech features that are separate from Live Voice.

- **Local Dictation.** `packages/voice-runtime` recorded the microphone in the
  main process through `@picovoice/pvrecorder-node`, downloaded Whisper and
  SenseVoice GGUF models from Hugging Face through `@huggingface/hub`, and ran
  them through the native `transcribe-cpp` addon, with `opencc-js` for Chinese
  variants. Its settings and Composer entry were already hidden; only a
  development build could reach it. It still shipped two native addons, an
  `asarUnpack` payload, a model downloader, and thirteen `pi-desktop/voice/*`
  IPC channels and events.
- **Host speech (ADR 0281).** `transcribe` and `synthesize` over
  OpenAI-audio-compatible providers bound in `AppSettings.speech`, the
  `pi-desktop/speech/*` IPC channels, three error codes, and a plugin contract:
  the high-risk `speech.adapter.register` permission with
  `pi.speech.registerAdapter` / `unregisterAdapter`. ADR 0291 had already
  removed its only renderer surface.

Users of this build run system-wide dictation, so neither feature serves them.
Both add native code, a network download path, IPC surface, and a plugin
permission that has to be reviewed and maintained.

## Decision

Remove local Dictation and host speech. Keep Live Voice.

- **Packages and dependencies.** `packages/voice-runtime` is deleted, along
  with `transcribe-cpp`, `@picovoice/pvrecorder-node`, `@huggingface/hub`,
  `opencc-js`, and their transitive packages (including `koffi`). The pure Live
  Voice wire parsing and PCM code that lived at `@pi-desktop/voice-runtime/live`
  moves unchanged to `packages/live-voice-protocol`
  (`@pi-desktop/live-voice-protocol`). It has no native or network
  dependency. `packages/agent-runtime/src/speech/` is deleted.
- **Packaging.** `apps/desktop` no longer lists the two native modules as
  runtime dependencies, the main bundle no longer externalizes them, and
  `build.asarUnpack` is removed.
- **Electron main.** `voice-service.ts`, `audio-backend.ts`,
  `ipc/voice-ipc.ts`, `services/speech-service.ts`, and `ipc/speech-ipc.ts` are
  deleted. The microphone lease keeps one owner kind, `live`.
- **IPC and shared contracts.** The `pi-desktop/voice/*` channels other than
  `pi-desktop/voice/live/*`, and all `pi-desktop/speech/*` channels, are
  removed from `IPC` and the preload whitelist. The shared speech types,
  `validateSpeechSettings`, `BUILTIN_SPEECH_PROTOCOL_IDS`, `AppSettings.voice`,
  `AppSettings.speech`, and the error codes `SPEECH_NOT_CONFIGURED`,
  `SPEECH_PROTOCOL_UNSUPPORTED`, and `SPEECH_INPUT_TOO_LARGE` are removed.
- **Renderer.** The dormant Dictation listener in the Composer, its IPC
  wrapper, the unused mic button and overlay, their styles, and the
  `settings.voice*` catalog keys in every locale are removed. Live Voice
  captures from the system default input device.
- **Config sync.** `speech` is no longer a portable application field.
- **Plugin SDK contract.** `speech.adapter.register`, the `pi.speech`
  namespace, and the `PluginSpeech*` types are removed from
  `@pi-desktop/plugin-sdk`. `pi-plugin check` reports the permission as
  `permission.removed`.

### Installed plugins

Desktop manifest validation does not reject unknown permission strings, so a
plugin that still declares `speech.adapter.register` loads; the permission
grants nothing and the plugins page shows it by its raw name. The guest keeps a
`pi.speech` stub whose two methods forward to the host, which answers
`UNSUPPORTED: host api not available: speech.registerAdapter` (or
`unregisterAdapter`). A plugin that registers an adapter in `onLoad` therefore
fails its own activation with a clear error instead of reading an undefined
namespace. `apps/desktop/test/plugin-speech-removed.test.mjs` covers this.

### Existing user data

- Stored `voice` and `speech` values in the host settings object are neither
  read nor rewritten. Host Core keeps unknown top-level keys, so startup and
  `settings.set` are unaffected and no migration runs. A config-sync bundle
  from an older build that carries `speech` is filtered on apply.
- Models already downloaded to `<dataDir>/voice-models` are not deleted. Users
  can remove that directory by hand.
- A legacy `voice.deviceId` no longer selects the Live Voice microphone. That
  value was a PvRecorder device index, not a WebRTC device id, so it could not
  match a `getUserMedia` device in the first place.

## Consequences

- The app downloads no speech models and ships no speech native addons. The
  packaged app has no `app.asar.unpacked` payload from this feature.
- Plugins lose the speech adapter contract. A plugin that wants
  transcription or synthesis calls a provider itself through `net.fetch` with
  its own key, or uses `ui.microphone` / `audio.capture.background` for audio.
- Live Voice behavior, settings, IPC, and protocol code are unchanged apart
  from the package rename and the default-device capture above.
- Reverting means restoring the package, the native dependencies and their
  packaging entries, the channels, and the plugin permission together.
