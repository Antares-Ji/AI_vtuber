# sts2:learn

运行既有卡库导入、有限批次分析和长期记忆写入。analyze=true会调用模型；不是权重微调。

版本：1。模式：learning。资源占用：sts2-knowledge。

实现：[sts2 provider](../../../src/skills/providers/sts2.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{
  "import": "boolean",
  "analyze": "boolean",
  "memory": "boolean",
  "maxCards": "1..120"
}
```

通过 `npm run skills -- run sts2:learn` 调用；有参数时加 `--args FILE.json`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
