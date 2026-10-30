# minecraft:legacy-play

保留 Mineflayer 生存反射、脱困、任务复盘及解说；与原生 MC 后端分开运行。

版本：1。模式：live。资源占用：desktop, minecraft。

实现：[minecraft provider](../../../src/skills/providers/minecraft.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "goal": "string",
  "durationMinutes": "1..20"
}
```

通过 `npm run skills -- run minecraft:legacy-play` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
