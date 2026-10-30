# genshin:demo

运行原神模拟技能，明确标记无游戏输入。

版本：1。模式：simulation。资源占用：genshin-simulation。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "goal": "string"
}
```

通过 `npm run skills -- run genshin:demo` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
