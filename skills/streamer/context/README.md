# streamer:context

统一主播上下文格式，保留人格、记忆和语音系统，区分计划与事实。

版本：1。模式：read。资源占用：无。

实现：[streamer provider](../../../src/skills/providers/streamer.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run streamer:context` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
