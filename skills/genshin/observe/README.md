# genshin:observe

原神前台窗口原生截图，再调用本地视觉 API；不切换窗口、不发送键鼠、不启动 BetterGI 任务。

版本：1。模式：read。资源占用：desktop, genshin。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "target": "YuanShen.exe | GenshinImpact.exe (default YuanShen.exe)"
}
```

通过 `npm run skills -- run genshin:observe` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
