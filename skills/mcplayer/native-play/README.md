# mcplayer:native-play

导演控制台通过本地 API 提交目标，由原版 DeepSeek、AgentHarness、原生动作及服务端回执完成任务。

版本：1。模式：live。资源占用：desktop, minecraft。

实现：[minecraft provider](../../../src/skills/providers/minecraft.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "goal": "string",
  "worldId": "native-status 返回的当前存档 SHA256",
  "durationMinutes": "1..20"
}
```

通过 `npm run skills -- run mcplayer:native-play` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
