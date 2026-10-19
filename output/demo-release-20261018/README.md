# 姬岁歌 · AI 游戏 Demo

先双击 **index.html** 查看离线展示。重点展示 Flappy Bird 的已验收结果；Minecraft是开发中原型，当前已停止。

## 运行 Flappy Bird（Windows）

1. 解压到可写目录。安装官方 `uv`（https://docs.astral.sh/uv/getting-started/installation/），首次需联网下载Python 3.11和锁定依赖。
2. 在解压目录打开 PowerShell，执行 `./scripts/flappy-bird/start.ps1`。
3. 按Esc或关闭游戏窗口退出，也可以执行 `./scripts/flappy-bird/stop.ps1`。

如本机禁止运行PowerShell脚本，请由机器使用者按其管理规则处理；本包不会自动修改系统策略。无需Qwen、Minecraft、OBS或GPU就能运行Flappy。

完整验收复测：`./scripts/flappy-bird/start.ps1 -Evaluate`（100局、每局1,000分）。

`start.ps1` 会检查已有演示进程，避免重复启动。首次编译保护层需等数秒。已有虚拟环境不随包分发，安装环境依赖目标机器和网络。本包未在另一台全新机器验收。

## 阅读顺序

- [阶段总结](docs/阶段总结.md)
- [90秒演示讲稿](docs/演示讲稿.md)
- [Flappy详细说明](docs/flappy-bird-ai.md)
- [Minecraft生存攻略](docs/minecraft-survival-step-guide.md)
- [Minecraft接口能力](docs/minecraft-expanded-capabilities.md)

截图和测试JSON是历史证据；index.html不是实时游戏页面。Minecraft不会因打开本包自动重启。
