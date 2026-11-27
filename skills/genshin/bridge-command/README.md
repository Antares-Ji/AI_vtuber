# genshin:bridge-command

BetterGI 官方脚本桥：截图、已安装路线、9类独立任务；支持停止、超时和原生按键释放。接口返回不代表游戏成功。

版本：1。模式：live。资源占用：desktop, genshin。

实现：[genshin provider](../../../src/skills/providers/genshin.js)。

参数元数据（实际参数由 provider.validate 严格检查）：

```json
{}
```

通过 `npm run skills -- run genshin:bridge-command` 调用；有参数时加 `--args FILE.json`，实机必须显式加 `--live`。完整配置、停止与验证边界见 [使用说明](../../../docs/integration/USAGE.md)。
