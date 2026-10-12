# 实时语音（已移除）

> **翻译说明：** 本页与[英文源规格](/spec/03-runtime/live-voice)对应。代码、协议字段和标识符保留原文；如翻译与英文事实存在差异，以英文版本为准。

> ADR：[fork-removes-voice-and-speech](/adr/fork-removes-voice-and-speech)（D662）。
> 取代 [ADR 0316](/adr/0316-live-voice-docked-widget)。

本构建不再提供实时语音。

- 不再有与 Codex Live、Gemini Live 或 OpenAI Realtime 的实时通话，不再有通话
  按钮、状态宿主或停靠通话挂件，也不再有语音设置页。
- 不再有 `pi-desktop/voice/live/*` IPC 通道、`onLiveVoicePort` preload API、
  `LIVE_*` 错误码以及 `voiceToggle` / `voiceCancel` 快捷键。这些快捷键的已存储
  覆盖会在迁移时丢弃。
- 主渲染进程从不采集媒体：默认 session 拒绝 `media` 权限
  （`default-session-permissions.ts`）。插件麦克风访问（`ui.microphone`、
  `audio.capture.background`）保持不变。
- 宿主设置对象中已存储的 `AppSettings.liveVoice` 保持原样且不再被读取。实时语音
  没有自己的凭证；它复用的 Provider 密钥和厂商 OAuth 会话仍供其他功能使用。旧版本
  留下的 `<dataDir>/live-voice-widget.json` 不会被删除。
- Live Work 也已移除，见 [live-work-session.md](live-work-session.md)。
