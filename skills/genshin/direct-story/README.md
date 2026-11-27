# genshin:direct-story

用户明确授权的导演直接控制；本地观察、逐帧意图校验、原生执行，不调用决策模型或主播。

版本：1。模式：live。资源占用：desktop, genshin。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run genshin:direct-story` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
