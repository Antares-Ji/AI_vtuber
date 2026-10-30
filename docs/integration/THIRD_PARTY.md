# 来源保留

- `mc-player-agent/`：来自用户提供的 `MC-Player-Agent-0.4.0-alpha.1-GitHub.zip`。原 `LICENSE`、`COPYING`、`NOTICE`、`provenance.json`、Gradle Wrapper Apache-2.0 许可完整保留；继承实现仍按原 LGPL-3.0-only 声明，不被根项目 package.json 的 ISC 标签覆盖。
- `archives/`：保存同一用户提供压缩包，SHA-256 见 `import-manifest.json`。它用于准确恢复原始内容与换行，不代替可直接阅读、构建的源码目录。
- `vendor/minecraft-agent/`：来自本地已有的 rmalde/minecraft-agent 兼容源码快照，来源提交和逐文件 SHA-256 见 `minecraft-legacy-source.json`。保留其 README 和来源说明；导入时该快照未提供独立 LICENSE 文件，本次没有为其附加或虚构 ISC/LGPL 许可，也不把它的历史演示成绩写成整合版实测成绩。
- `integrations/sts2-mcp/upstream.lock.json`：保留既有 STS2MCP 来源、固定提交和许可信息。下载依赖、游戏安装及模组使用仍按原集成说明进行。
- 新增统一层在 `src/skills/` 与 `src/api/skills.js`；原始 ZIP 全部 151 个文件完整保留；工作源码仅包含导入清单记录的一处测试等待修复，不声称重写或原创其 Java 调度实现。

Numen 不作为此次工程的构建或运行依赖引入。原包已经说明与 Numen 的继承关系；这些声明继续有效。
