# Live Voice 工作会话接入（已移除）

> **翻译说明：** 本页与[英文源规格](/spec/03-runtime/live-work-session)对应。代码、协议字段和标识符保留原文；如翻译与英文事实存在差异，以英文版本为准。

> ADR：[fork-removes-voice-and-speech](/adr/fork-removes-voice-and-speech)（D662）。
> 取代 [ADR 0311](/adr/0311-live-work-workspace-admission-guard)、
> [ADR 0313](/adr/0313-live-voice-default-session-target) 与
> [ADR 0315](/adr/0315-live-voice-spoken-asktool-answers)。

本构建不再提供 Live Work。通话无法向会话提交、引导或停止工作，asktool 问题只能在
Composer 中回答。

队列 turn 与消息 meta 上的 `voiceOrigin` 来源信息仍保留在共享类型和 Host Core
（`voice_origin_json`）中，以便现有数据库继续加载。已不再有任何生产者，原生 Pi
会话运行时会拒绝携带它的提示。
