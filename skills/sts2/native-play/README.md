# sts2:native-play

复用纯视觉、角色决策及原生键鼠循环，保留已核验的通关经验。

版本：1。模式：live。资源占用：desktop, sts2。

实现：[sts2 provider](../../../src/skills/providers/sts2.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "maxSteps": "1..1000",
  "continueAfterDefeat": "boolean; allow current defeat settlement (up to 3 confirmed clicks), revoked on new adventure"
}
```

通过 `npm run skills -- run sts2:native-play` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
