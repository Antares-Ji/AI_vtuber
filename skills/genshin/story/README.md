# genshin:story

BetterGI持续剧情会话：本地OCR与视觉观察，DeepSeek逐步选择任务、对话与追踪，并生成主播解说。

版本：1。模式：live。资源占用：desktop, genshin。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run genshin:story` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
