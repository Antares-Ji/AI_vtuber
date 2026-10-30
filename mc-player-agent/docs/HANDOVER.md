# 架构与接手导航

对应 `0.4.0-alpha.1`。先按 [DEVELOPMENT](DEVELOPMENT.md) 跑通核心，再沿下面的入口定位修改。每个链接都指向实际源码；详细宿主契约在 [HARNESS](HARNESS.md)。

## 模块与允许依赖

| 模块 | 负责 | 可以依赖 |
| --- | --- | --- |
| `harness/` | 计划协议、会话调度、纯技能规则、世界记忆、模型 HTTP、运行记录 | JDK、Gson；测试使用 JUnit |
| `game/src/main/` | 共享服务端辅助、拾取 Mixin、原生计算 | 核心、Minecraft 共享／服务端 API、Mixin |
| `game/src/client/` | 玩家控制、UI、原生技能与证据适配 | 核心、共享层、Minecraft 客户端 API |
| `fabric/`、`neoforge/` | 生命周期、事件注册、运行配置 | 各自加载器 API 与共享游戏源码 |
| `examples/collect-return/` | 通过公开接口注册组合技能；独立模拟与契约测试 | 仅核心与 Gson，测试使用 JUnit |
| `tools/` | 仓库检查与源码／安装包发布 | Python 标准库、Git |

`game/` 没有单独的 `build.gradle`：根构建将它的共享和客户端源码加入两个加载器的 source set，并把核心输出嵌入发行 JAR。不能据此假定共享代码可使用客户端类；服务器加载边界仍需遵守。

## 一次任务如何运行

1. [Fabric 客户端入口](../fabric/src/main/java/dev/mcplayeragent/fabric/AgentFabricClient.java) 或 [NeoForge 客户端入口](../neoforge/src/main/java/dev/mcplayeragent/neoforge/AgentNeoForgeClient.java) 注册按键和客户端 tick，调用 [AgentKeys](../game/src/client/java/dev/mcplayeragent/minecraft/AgentKeys.java)。
2. F8 打开 [MissionControlScreen](../game/src/client/java/dev/mcplayeragent/minecraft/MissionControlScreen.java)。执行按钮把目标交给 [PlayerControl.start](../game/src/client/java/dev/mcplayeragent/minecraft/PlayerControl.java)，创建运行记录、核心会话，并向集成服务器确认玩家控制授权。
3. [AgentHarness](../harness/src/main/java/dev/mcplayeragent/harness/AgentHarness.java) 在宿主线程推进计划；[PlayerModelConnection](../harness/src/main/java/dev/mcplayeragent/harness/PlayerModelConnection.java) 与 [ModelTransport](../harness/src/main/java/dev/mcplayeragent/harness/ModelTransport.java) 提供请求和解析。Future 的完成线程不直接操作玩家。
4. [PlayerTasks](../harness/src/main/java/dev/mcplayeragent/harness/PlayerTasks.java) 定义连续技能协议，[SurvivalPlayerTasks](../game/src/client/java/dev/mcplayeragent/skills/SurvivalPlayerTasks.java) 创建 Minecraft 技能注册表和危险检测。每个动作由控制器执行，等待回执再继续。
5. [PlayerFeedback](../game/src/client/java/dev/mcplayeragent/minecraft/PlayerFeedback.java) 从服务器采样；观察回到客户端后，`PlayerControl.finish` 调用 `AgentHarness.complete`，核心重新核验 DONE 或继续技能。
6. [MissionRun](../harness/src/main/java/dev/mcplayeragent/mission/MissionRun.java) 异步写入事件和汇总，[MissionRecording](../game/src/client/java/dev/mcplayeragent/minecraft/MissionRecording.java) 将当前运行提供给控制台。停止路径释放任务、待处理请求和玩家输入。

## 按修改目标找代码

| 我要修改 | 入口 | 第一组测试 |
| --- | --- | --- |
| 配置、技能注册与扩展 | [AgentProfile](../harness/src/main/java/dev/mcplayeragent/harness/AgentProfile.java)、[SkillRegistry](../harness/src/main/java/dev/mcplayeragent/harness/SkillRegistry.java)、[示例](../examples/collect-return/README.md) | AgentProfileTest、SkillRegistryTest、CollectReturnTest |
| 会话预算、异步回复、中断恢复 | [AgentHarness](../harness/src/main/java/dev/mcplayeragent/harness/AgentHarness.java) | [AgentHarnessTest](../harness/src/test/java/dev/mcplayeragent/harness/AgentHarnessTest.java) |
| 动作、计划或验收协议 | [PlayerDecision](../harness/src/main/java/dev/mcplayeragent/harness/PlayerDecision.java)、[PlayerPlan](../harness/src/main/java/dev/mcplayeragent/harness/PlayerPlan.java)、[PlayerCondition](../harness/src/main/java/dev/mcplayeragent/harness/PlayerCondition.java) | 同名 `*Test`，再测核心闭环 |
| 模型请求或错误处理 | [PlayerModelConnection](../harness/src/main/java/dev/mcplayeragent/harness/PlayerModelConnection.java)、[ModelTransport](../harness/src/main/java/dev/mcplayeragent/harness/ModelTransport.java) | [PlayerModelConnectionTest](../harness/src/test/java/dev/mcplayeragent/harness/PlayerModelConnectionTest.java) |
| 世界记忆与迁移 | [WorldJournal](../harness/src/main/java/dev/mcplayeragent/skills/WorldJournal.java)、[LegacyMigration](../game/src/client/java/dev/mcplayeragent/minecraft/LegacyMigration.java) | [WorldJournalTest](../harness/src/test/java/dev/mcplayeragent/skills/WorldJournalTest.java) 及测试存档实测 |
| 运行记录 | [MissionRun](../harness/src/main/java/dev/mcplayeragent/mission/MissionRun.java) | [MissionRunTest](../harness/src/test/java/dev/mcplayeragent/mission/MissionRunTest.java) |
| 拾取或背包回执 | [PlayerPickupWatch](../game/src/main/java/dev/mcplayeragent/skills/PlayerPickupWatch.java)、[PlayerPickupMixin](../game/src/main/java/dev/mcplayeragent/mixin/PlayerPickupMixin.java) | [AgentSmokeTests](../game/src/gametest/java/dev/mcplayeragent/gametest/AgentSmokeTests.java)，两个加载器分别运行 |
| F8／F9、模型设置或原生输入 | [AgentKeys](../game/src/client/java/dev/mcplayeragent/minecraft/AgentKeys.java)、[PlayerControlScreen](../game/src/client/java/dev/mcplayeragent/minecraft/PlayerControlScreen.java)、[PlayerControl](../game/src/client/java/dev/mcplayeragent/minecraft/PlayerControl.java) | 双加载器构建与客户端检查 |
| 仓库和发布工具 | [check_repository.py](../tools/check_repository.py)、[package_release.py](../tools/package_release.py) | `tools/test_*.py` |

## 数据与生命周期

- `PlayerEvidence` 是不可变观察，客户端视角信息附加在收到的观察上；不要把模型文本当成服务器回执。
- 任务核心属于实例。游戏桥接的 `PlayerControl`、游戏世界桥接和 `MissionRecording` 仍为单客户端静态入口，不支持同时控制多个玩家。
- 会话硬预算跨重生、维度切换和危险中断持续计数。触及停止条件后结果是 `INTERRUPTED`，不能把停止包装成已完成。
- 世界记忆按存档、玩家和维度隔离；运行记录按 UUID 隔离。路径与迁移规则见 [USAGE](USAGE.md)。
- 记录写盘走独立线程；只有测试和命令行结束时等待 `flushed()`，不要阻塞游戏 tick。

## 接手时保留的约束与技术债

`PlayerControl` 仍同时承担配置、模型接线、观察与原生动作，代码较集中。后续拆分前需要对应测试和真实客户端基线，不宜只为类变短而改动生命周期。

模型生成的单项 `goal_check` 可能不能覆盖自然语言复合目标；会话预算限制消耗，不等于语义无进展识别。客户端长期表现、迁移和真实模型任务仍待验证，见 [VALIDATION](VALIDATION.md) 与 [ROADMAP](ROADMAP.md)。

本地交接基线不能替代完整上游 Git 历史。修改来源、署名与许可证以 [NOTICE](../NOTICE) 和 [provenance.json](../provenance.json) 为依据，历史快照 SHA-256 不改写为当前文件哈希。
