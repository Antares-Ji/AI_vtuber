# genshin:bridge-observe

通过 BetterGI 截图并调用本地视觉模型解释；不启用云端视觉，不生成游戏按键。BetterGI 启动可能激活游戏窗口。

版本：1。模式：live。资源占用：desktop, genshin。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run genshin:bridge-observe` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
