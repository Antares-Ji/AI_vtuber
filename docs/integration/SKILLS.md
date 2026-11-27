# 已注册 Skill

由 `node scripts/skill-catalog.cjs` 从实际注册表生成；`--check` 可检查文档是否过期。每个 Skill 都有独立说明，执行器按环境分文件实现。

| Skill | 模式 | 用途 |
| --- | --- | --- |
| [mcplayer:native-status](../../skills/mcplayer/native-status/README.md) | read | 读取原生 MC 导演任务 API、当前存档标识及任务占用状态。 |
| [mcplayer:native-play](../../skills/mcplayer/native-play/README.md) | live | 导演控制台通过本地 API 提交目标，由原版 DeepSeek、AgentHarness、原生动作及服务端回执完成任务。 |
| [mcplayer:harness-demo](../../skills/mcplayer/harness-demo/README.md) | simulation | 运行原版 Java AgentHarness 的确定性演示，保留原始验收与任务记录。 |
| [mcplayer:inspect-profile](../../skills/mcplayer/inspect-profile/README.md) | read | 查看 ZIP 的版本化示例配置与原生 Skill 清单。 |
| [minecraft:legacy-status](../../skills/minecraft/legacy-status/README.md) | read | 读取本地 Mineflayer 兼容后端、反射与自主任务状态。 |
| [minecraft:legacy-play](../../skills/minecraft/legacy-play/README.md) | live | 保留 Mineflayer 生存反射、脱困、任务复盘及解说；与原生 MC 后端分开运行。 |
| [sts2:knowledge](../../skills/sts2/knowledge/README.md) | read | 检索现有卡牌知识、人工核验经验与条件化复盘，不重新训练或覆盖资料。 |
| [sts2:play](../../skills/sts2/play/README.md) | live | 复用尖塔 MCP/DeepSeek 执行与复盘链路；停止后等待执行器释放。 |
| [sts2:native-play](../../skills/sts2/native-play/README.md) | live | 复用纯视觉、角色决策及原生键鼠循环，保留已核验的通关经验。 |
| [sts2:learning-status](../../skills/sts2/learning-status/README.md) | read | 查看持久学习覆盖率、审核集数量和经验来源；模型推断不升级为实战事实。 |
| [sts2:learn](../../skills/sts2/learn/README.md) | learning | 运行既有卡库导入、有限批次分析和长期记忆写入。analyze=true会调用模型；不是权重微调。 |
| [genshin:direct-story](../../skills/genshin/direct-story/README.md) | live | 用户明确授权的导演直接控制；本地观察、逐帧意图校验、原生执行，不调用决策模型或主播。 |
| [genshin:window-restore](../../skills/genshin/window-restore/README.md) | live | 显式恢复原神窗口；原生互斥及实际权限检查，无游戏按键，不改变观察接口。 |
| [genshin:story](../../skills/genshin/story/README.md) | live | BetterGI持续剧情会话：本地OCR与视觉观察，DeepSeek逐步选择任务、对话与追踪，并生成主播解说。 |
| [genshin:run-goal](../../skills/genshin/run-goal/README.md) | live | BetterGI截图→本地视觉API→所选模型决定一项路线/自动任务→BetterGI执行；不循环，无法确认场景则停止。 |
| [genshin:bridge-observe](../../skills/genshin/bridge-observe/README.md) | live | 通过 BetterGI 截图并调用本地视觉模型解释；不启用云端视觉，不生成游戏按键。BetterGI 启动可能激活游戏窗口。 |
| [genshin:bridge-start](../../skills/genshin/bridge-start/README.md) | live | 连接固定 BetterGI 管理进程；reuseSession仅复用现有授权，不新建提权进程。 |
| [genshin:bridge-command](../../skills/genshin/bridge-command/README.md) | live | BetterGI 官方脚本桥：截图、已安装路线、9类独立任务；支持停止、超时和原生按键释放。接口返回不代表游戏成功。 |
| [genshin:launch](../../skills/genshin/launch/README.md) | live | 启动原神；systemPrompt=true 时允许 Windows 显示正常权限确认。 |
| [genshin:observe](../../skills/genshin/observe/README.md) | read | 原神前台窗口原生截图，再调用本地视觉 API；不切换窗口、不发送键鼠、不启动 BetterGI 任务。 |
| [genshin:plan](../../skills/genshin/plan/README.md) | read | 通过手动选定的 OpenAI / DeepSeek 规划原神有限技能；不自动切换供应商，生成计划不发送游戏输入。 |
| [genshin:demo](../../skills/genshin/demo/README.md) | simulation | 运行原神模拟技能，明确标记无游戏输入。 |
| [genshin:bettergi](../../skills/genshin/bettergi/README.md) | live | 保留 BetterGI 接入：未完成启动、取消与证据桥接时拒绝实机执行。 |
| [genshin:doctor](../../skills/genshin/doctor/README.md) | read | 通过本机 IPC 检查 BetterGI 实例及路径；在线不代表游戏或执行桥接就绪。 |
| [streamer:context](../../skills/streamer/context/README.md) | read | 统一主播上下文格式，保留人格、记忆和语音系统，区分计划与事实。 |
