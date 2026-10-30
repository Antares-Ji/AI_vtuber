# genshin:doctor

诊断 BGI 路径与桥接成熟度；程序存在不代表已连接游戏。

版本：1。模式：read。资源占用：无。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run genshin:doctor` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
