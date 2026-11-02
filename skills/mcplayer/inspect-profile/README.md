# mcplayer:inspect-profile

查看 ZIP 的版本化示例配置与原生 Skill 清单。

版本：1。模式：read。资源占用：无。

实现：[minecraft provider](../../../src/skills/providers/minecraft.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run mcplayer:inspect-profile` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
