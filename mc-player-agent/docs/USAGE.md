# 游戏安装、使用与数据

对应 `0.4.0-alpha.1`。首次使用请备份测试存档，当前支持 Minecraft Java 1.21.1 单人世界和本机局域网房主。

## 安装与使用

需要 Java 21、Minecraft Java 1.21.1，以及对应加载器：Fabric Loader 0.18.1 或 NeoForge 21.1.233。Fabric 版本还需 Fabric API 0.116.7+1.21.1。

1. 在启动器里创建一个独立的 1.21.1 游戏实例。
2. 将对应加载器的 `mcplayeragent-*-0.4.0-alpha.1.jar`（从本版本源码构建，或使用仓库维护者发布的同版本附件）放入该实例的 `mods` 目录。每次只装一个加载器版本。
3. 迁移已有实例时，先将旧的 `numen` JAR 移出 `mods`（保留备份），避免两个玩家接管系统同时运行。不要删除旧配置或存档。
4. 进入单人世界，按 **F8** 打开任务控制台。首次使用点击“模型连接与提示词”，配置 DeepSeek 官方接口或本机 Ollama，并测试连接；随后在控制台填写目标，点击“执行任务”。
5. **F9、实体键盘输入、鼠标移动或点击都会停止接管**。

当前支持单人世界和本机开放局域网的房主。加入别人服务器的客户端尚不支持这套服务器状态回执；不能把它当作任意远程服务器上的客户端机器人使用。

DeepSeek 地址为 `https://api.deepseek.com`；模型名可在面板里修改，迁移时保留旧值。思考配置沿用 `thinking=enabled`、`reasoning_effort=low`。本机 Ollama 地址为 `http://127.0.0.1:11434/v1`，填写已经安装的模型名称。

聊天窗显示模型输出的计划、行动说明和结果摘要。模型服务返回的私有推理字段不会作为聊天内容或动作执行。

## 会话停止与记录

默认每次接管最多持续 20 分钟、发起 120 次模型规划或复盘请求、交付 2,000 个动作。时长达到上限，或继续执行将超出次数上限时，任务以 `INTERRUPTED` 结束，释放控制权；控制台和 `summary.json` 会保留 `BUDGET_EXHAUSTED` 原因。

计数包括失败或取消的模型请求；切换维度、重生和遇险不能重置预算。次数上限是本地保护阈值，不是模型服务的 token 或费用额度。已经发送的请求可能仍由服务端处理。

可在 `player-control.json` 的 `limits` 中设置上限，F8 保存其他设置会保留这些高级字段；每次启动重新读取并固定。字段和技能选择见 [EXTENSIONS](EXTENSIONS.md)。达到上限后先核对任务记录、缩小目标，再开始新任务。停止不会撤回已经发生的挖掘、物品操作或世界变化；遇险时停止也不保证玩家已经脱险。

运行记录在实际存档的 `mcplayeragent/runs/<UUID>/`：`events.jsonl` 是时间线，`summary.json` 是汇总。`VERIFIED` 表示已建立的观测条件通过，`UNVERIFIED` 表示缺少可验收条件；这些状态不自动证明完整自然语言目标或整个长任务成功。

运行记录还包括解析后 profile 的 SHA-256 与启用技能版本；这些元数据用于比对运行条件，不保存原始提示词。

## 配置、记忆与迁移

以下路径相对于**实际游戏实例目录**，不固定指向源码目录：

- 配置：`config/mcplayeragent/client/player-control.json`
- API Key：`config/mcplayeragent/client/keys/player-deepseek.key`（本机明文文件，不应分享或提交）
- 世界记忆：`saves/<存档>/mcplayeragent/memory/`
- 维度记忆：按玩家 UUID 和编码后的维度分别保存。
- 跨维度目标：`mcplayeragent/memory/players/<玩家 UUID>/agenda.json`
- 任务记录：`saves/<存档>/mcplayeragent/runs/<运行 UUID>/events.jsonl` 与 `summary.json`
- 日志：`logs/latest.log`，日志标签 `mcplayeragent`；崩溃报告位于 `crash-reports/`。

首次启动会从同一实例的 `config/numen/client/` 复制缺失的玩家配置和密钥；首次进入存档时，从该存档的 `numen/player-control/` 复制世界标识、当前玩家的目标和当前维度记忆。仅在目标文件不存在时复制，不覆盖新数据，也不删除旧文件。其他维度在进入时迁移。

代码中保留的旧目录名仅用于迁移；没有旧目录时会直接创建新配置和记忆。


构建命令见 [README](../README.md)，验收范围见 [VALIDATION](VALIDATION.md)。
