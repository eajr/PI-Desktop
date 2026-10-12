# Live Voice Work Session Integration (removed)

> ADR: [fork-removes-voice-and-speech](../../adr/fork-removes-voice-and-speech.md)
> (D662). Supersedes [ADR 0311](../../adr/0311-live-work-workspace-admission-guard.md),
> [ADR 0313](../../adr/0313-live-voice-default-session-target.md), and
> [ADR 0315](../../adr/0315-live-voice-spoken-asktool-answers.md).

This build has no Live Work. A call cannot submit, steer, or stop work in a
session, and an asktool question can only be answered from the Composer.

The `voiceOrigin` provenance on queued turns and message meta stays in the
shared types and in Host Core (`voice_origin_json`) so that existing databases
keep loading. Nothing produces it any more, and the native Pi session runtime
rejects a prompt that carries it.
