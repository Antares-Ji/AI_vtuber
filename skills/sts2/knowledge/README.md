# sts2:knowledge

检索现有卡牌知识、人工核验经验与条件化复盘，不重新训练或覆盖资料。

版本：1。模式：read。资源占用：无。

实现：[sts2 provider](../../../src/skills/providers/sts2.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "query": "string",
  "maxCards": "1..20"
}
```

通过 `npm run skills -- run sts2:knowledge` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
