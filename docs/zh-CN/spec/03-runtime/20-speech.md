# 20. 宿主语音（已移除）

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/20-speech) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> ADR：[fork-removes-voice-and-speech](/adr/fork-removes-voice-and-speech)（D662）。
> 取代 [ADR 0281](/adr/0281-host-speech-capability) 与
> [ADR 0291](/adr/0291-remove-speech-settings-ui)。

本构建不再提供宿主语音能力，也不再提供本地听写。

- 没有 `transcribe` / `synthesize` 服务，没有 `pi-desktop/speech/*` IPC 通道，
  也没有 `SPEECH_*` 错误码。
- 没有本地转写运行时：主进程不再录制麦克风，不再有模型目录或下载器，也不会
  请求 Hugging Face。不再有任何 `pi-desktop/voice/*` 通道；实时语音也已移除
  （见 [live-voice.md](live-voice.md)）。
- 插件不再有 `pi.speech` 契约和 `speech.adapter.register` 权限。仍声明该权限的
  插件可以加载，但不会获得任何能力；调用 `pi.speech.registerAdapter` 或
  `unregisterAdapter` 会以 `UNSUPPORTED` 失败。
- 宿主设置对象中已存储的 `AppSettings.voice` 与 `AppSettings.speech` 保持原样且
  不再被读取。配置同步不再采集或应用 `speech`。旧版本下载到
  `<dataDir>/voice-models` 的模型文件不会被删除。
