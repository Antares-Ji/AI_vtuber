# sts2:play

复用尖塔 MCP/DeepSeek 执行与复盘链路；停止后等待执行器释放。

版本：1。模式：live。资源占用：desktop, sts2。

实现：[sts2 provider](../../../src/skills/providers/sts2.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "goal": "string",
  "steps": "1..500"
}
```

通过 `npm run skills -- run sts2:play` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
