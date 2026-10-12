# Live Voice (removed)

> ADR: [fork-removes-voice-and-speech](../../adr/fork-removes-voice-and-speech.md)
> (D662). Supersedes [ADR 0316](../../adr/0316-live-voice-docked-widget.md).

This build has no Live Voice.

- There is no real-time call to Codex Live, Gemini Live, or OpenAI Realtime,
  no call button, status host, or docked call widget, and no Voice settings
  page.
- There is no `pi-desktop/voice/live/*` IPC channel, no `onLiveVoicePort`
  preload API, no `LIVE_*` error code, and no `voiceToggle` / `voiceCancel`
  shortcut. Stored overrides for those shortcuts are dropped on migration.
- The main renderer never captures media: the default session refuses the
  `media` permission (`default-session-permissions.ts`). Plugin microphone
  access (`ui.microphone`, `audio.capture.background`) is unchanged.
- A stored `AppSettings.liveVoice` value is left in the host settings object
  untouched and is not read. Live Voice stored no credentials of its own;
  provider keys and vendor OAuth sessions it reused are kept for other
  features. `<dataDir>/live-voice-widget.json` from older builds is not
  deleted.
- Live Work is removed as well; see [live-work-session.md](live-work-session.md).
