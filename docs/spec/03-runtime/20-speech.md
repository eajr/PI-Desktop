# 20. Host speech (removed)

> ADR: [fork-removes-voice-and-speech](../../adr/fork-removes-voice-and-speech.md)
> (D662). Supersedes [ADR 0281](../../adr/0281-host-speech-capability.md) and
> [ADR 0291](../../adr/0291-remove-speech-settings-ui.md).

This build has no host speech capability and no local Dictation.

- There is no `transcribe` / `synthesize` service, no `pi-desktop/speech/*`
  IPC channel, and no `SPEECH_*` error code.
- There is no local transcription runtime: no microphone recorder in the main
  process, no model catalog or downloader, and no request to Hugging Face. The
  only `pi-desktop/voice/*` channels left belong to Live Voice
  (`pi-desktop/voice/live/*`, see [live-voice.md](live-voice.md)).
- Plugins have no `pi.speech` contract and no `speech.adapter.register`
  permission. A plugin that still declares the permission loads and is granted
  nothing; calling `pi.speech.registerAdapter` or `unregisterAdapter` fails with
  `UNSUPPORTED`.
- Stored `AppSettings.voice` and `AppSettings.speech` values are left in the
  host settings object untouched and are not read. Config sync no longer
  captures or applies `speech`. Model files under `<dataDir>/voice-models` from
  older builds are not deleted.
