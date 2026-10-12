# ADR: Remove Live Voice, local Dictation and host speech

- Status: Accepted
- Date: 2026-10-12
- Decision: D662
- Supersedes: ADR 0281; ADR 0291; ADR 0311; ADR 0313; ADR 0315; ADR 0316
- Related: ADR 0257,
  [live-voice.md](../spec/03-runtime/live-voice.md),
  [live-work-session.md](../spec/03-runtime/live-work-session.md), and
  [20-speech.md](../spec/03-runtime/20-speech.md) (all now removal notes)

## Context

The app carried three voice features.

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

- **Live Voice and Live Work (ADRs 0311, 0313, 0315, 0316).** An
  app-owned, default-off real-time call to Codex Live, Gemini Live, or OpenAI
  Realtime. The renderer captured the microphone with `getUserMedia`; Main
  negotiated WebRTC SDP or bridged a provider WebSocket to a per-call PCM
  `MessagePort`. Live Work let a call submit bounded work requests to a
  session, answer an open asktool question by voice, and show a docked call
  widget window. It added `AppSettings.liveVoice`, 22
  `pi-desktop/voice/live/*` channels, 26 `LIVE_*` error codes, the
  `voiceToggle` / `voiceCancel` shortcuts, a Voice settings page, and the
  `voiceOrigin` provenance on queued turns.

Users of this build run system-wide dictation and do not use real-time calls,
so none of these features serves them. Together they add native code, a
network download path, three provider protocol clients, a second
`BrowserWindow`, IPC surface, and a plugin permission that has to be reviewed
and maintained.

## Decision

Remove Live Voice, Live Work, local Dictation, and host speech. The first
stage removed Dictation and host speech and briefly moved the Live Voice wire
code to `packages/live-voice-protocol`; the second stage removes Live Voice
and that package.

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
  deleted. `electron/main/live-voice/` (call service, provider adapters,
  microphone lease, widget window, Live Work admission and asktool bridge) and
  `ipc/live-voice-ipc.ts` are deleted. The `AgentHostBridge` methods that only
  Live Work called (`openAsk`, `resolveOpenAsk`, `lookupWorkAdmission`,
  `steerWorkSession`, `stopWorkSession`) are removed.
- **Default-session permissions.** Live Voice installed the permission
  handler for the default session, which carries the main renderer. It is
  replaced by `default-session-permissions.ts`, which refuses `media` and keeps
  every other permission allowed as before. Without a replacement the default
  session would fall back to Electron's grant-all default for media. Plugin
  panels keep their own partition and their `ui.microphone` checks.
- **IPC and shared contracts.** All `pi-desktop/voice/*` and
  `pi-desktop/speech/*` channels and the `onLiveVoicePort` preload API are
  removed from `IPC` and the preload whitelist. The shared Live Voice types,
  `AppSettings.liveVoice`, and the 26 `LIVE_*` error codes are removed. The shared speech types,
  `validateSpeechSettings`, `BUILTIN_SPEECH_PROTOCOL_IDS`, `AppSettings.voice`,
  `AppSettings.speech`, and the error codes `SPEECH_NOT_CONFIGURED`,
  `SPEECH_PROTOCOL_UNSUPPORTED`, and `SPEECH_INPUT_TOO_LARGE` are removed.
- **Renderer.** The dormant Dictation listener in the Composer, its IPC
  wrapper, the unused mic button and overlay, their styles, and the
  `settings.voice*` catalog keys in every locale are removed. The Live Voice
  call button, status host, widget surface, Voice settings page, Mic and
  waveform icons, the `voiceToggle` / `voiceCancel` shortcuts, and the
  `liveVoice` and `settings.nav.voice` catalog keys are removed too.
- **Scripts and tests.** `test:e2e:live-voice`,
  `test:e2e:live-voice-interaction`, their fixtures, and the Live Voice and
  Live Work unit tests are removed. `apps/desktop/test/voice-removed.test.mjs`
  asserts the entry points are gone and covers the default-session policy.
- **Microphone entitlement.** `com.apple.security.device.audio-input` and
  `NSMicrophoneUsageDescription` stay, because plugins still use
  `ui.microphone` and `audio.capture.background` (ADR 0257). The usage string
  now names plugin audio only.
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

- Stored `liveVoice`, `voice`, and `speech` values in the host settings
  object are neither read nor rewritten. Host Core keeps unknown top-level keys, so startup and
  `settings.set` are unaffected and no migration runs. A config-sync bundle
  from an older build that carries `speech` is filtered on apply.
- Models already downloaded to `<dataDir>/voice-models` are not deleted. Users
  can remove that directory by hand.
- Live Voice stored no credentials of its own. It resolved existing provider
  API keys and the Codex vendor OAuth session, which other features still use,
  so no secret is deleted.
- Keybinding overrides for `voiceToggle` and `voiceCancel` are dropped when
  overrides are migrated, so they cannot collide with another command.
- The widget placement file `<dataDir>/live-voice-widget.json` is not deleted.
- The `voiceOrigin` provenance stays in the shared turn types and in Host
  Core (`voice_origin_json` on queued turns, message meta). It is dormant: no
  producer remains. Keeping it avoids a schema change, and existing rows keep
  loading.

## Consequences

- The app downloads no speech models and ships no speech native addons. The
  packaged app has no `app.asar.unpacked` payload from this feature.
- Plugins lose the speech adapter contract. A plugin that wants
  transcription or synthesis calls a provider itself through `net.fetch` with
  its own key, or uses `ui.microphone` / `audio.capture.background` for audio.
- The app has no real-time call path. The main renderer never captures media.
- Reverting means restoring the packages, the native dependencies and their
  packaging entries, the Live Voice services and widget, the channels, the
  settings page, and the plugin permission together.
