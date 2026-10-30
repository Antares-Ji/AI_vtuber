# sts2:learning-status

查看持久学习覆盖率、审核集数量和经验来源；模型推断不升级为实战事实。

版本：1。模式：read。资源占用：无。

实现：[sts2 provider](../../../src/skills/providers/sts2.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run sts2:learning-status` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
