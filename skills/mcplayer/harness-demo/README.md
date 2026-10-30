# mcplayer:harness-demo

运行原版 Java AgentHarness 的确定性演示，保留原始验收与任务记录。

版本：1。模式：simulation。资源占用：mcplayer-demo。

实现：[minecraft provider](../../../src/skills/providers/minecraft.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run mcplayer:harness-demo` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
