# 本次整合验证

日期：2026-10-30。环境：Windows 11、Microsoft OpenJDK 21.0.8、Gradle Wrapper 9.2.0；本次追加回归使用 Node 24.19，文件检查优先使用 WSL Ubuntu。原 ZIP 字节不变，其历史验证段落保留；整合修改在导入清单登记。

## 导演任务 API 追加验证

- Java Harness：125 项通过，其中 20 项新增本地 HTTP/假宿主测试；外部 collect-return 测试 7 项通过。
- Node 整合回归：127 项通过，其中 8 项新增 MC 适配测试。均为程序测试，不代表新增客户端通关。
- Fabric/NeoForge 完整编译通过。现有本机 JDK 缺失 `D:\release` 导致 Fabric 第三方 sources remap 告警仍存在，边界见下文。
- NeoForge 与 Fabric 顺序运行的服务端 GameTest 各 3/3 通过；计数、日志和 JAR 哈希见[追加验证摘要](director-validation.json)。
- 原始 ZIP 校验通过，151 个原文件保留，其中 145 个内容完全一致、6 个有明确补丁；新增 4 个本地整合文件另列来源与哈希。独立导出检查及原 17 项工具测试通过；新增 3 项导入保护测试通过。
- Skill 注册表生成 18 项说明，新增 `mcplayer:native-status` 与 `mcplayer:native-play`。任务 API 默认关闭，客户端实机测试尚未完成；没有自动选择存档、安装到用户游戏目录或启动新的 MC 世界。
- F8/F9 会取消排队任务并使此前的启动请求版本失效；断连或取消时，适配层只向自己的请求 UUID 发送停止，等待释放确认。未实现跨进程租约恢复。

后续尖塔的真实 DeepSeek、本地 Qwen/CV/OCR 与原生输入记录见[实机 API 验证](../sts2-api-autonomy-validation-20261030.md)。该记录不等同于 MC 原生客户端已通过。

## 初次整合记录（下表为当时结果）

| 检查 | 本次结果 | 证据范围 |
| --- | --- | --- |
| ZIP 与导入源码 | 全部 151 文件保留，原包 SHA-256 校验通过 | 原始 ZIP 字节不变；允许 Git 换行规范化及清单明确记录的一处测试等待修复 |
| ZIP 原仓库边界检查 | 通过 | 从原包清单导出独立 Git 根；不放宽原检查 |
| ZIP Python 工具测试 | 17 通过 | 文档链接、模块边界、发布源码和测试报告检查 |
| Java Harness | 105 通过 | 原调度、预算、配置、技能注册和验收单元测试 |
| 外部 collect-return 示例 | 7 通过；模拟 VERIFIED | 独立入口、ServiceLoader、组合技能与生命周期 |
| 统一 Skill → Java 核心 | 通过，3 个模拟动作 | 原核心返回 VERIFIED，统一层正确标记 SIMULATED |
| Node 整合回归 | 61 通过，0 跳过 | Skill、HTTP、原神、尖塔 MCP、视觉自主循环、知识、复盘、输入参数等 |
| MC API 回归 | 5 个测试入口全部通过 | DeepSeek、传输、遮挡威胁、Astra/JEV、主播接线；均非新的实机生存实验 |
| Windows 原生输入与视觉规则 | 5＋3 通过 | 参数与规则单元测试，不发送游戏输入 |
| 学习数据保存 | 2 个测试通过；本机快照完成 | 活跃 SQLite WAL 备份、内容校验、不覆盖和目录边界 |
| Fabric 与 NeoForge 构建 | 均 BUILD SUCCESSFUL | 原 ZIP 的双加载器源码可在本机编译 |
| NeoForge 原生 GameTest | 3/3 通过 | 原生拾取回执测试 |
| Fabric 原生 GameTest | 3/3 通过 | 原生拾取回执测试，和 NeoForge 顺序执行 |
| Skill 清单 | 14 项与注册表一致 | 独立说明、ID、版本、模式、参数元数据 |

Java XML 测试数量、GameTest 日志与 JAR 的哈希见 [本次机器可读摘要](validation.json)。源码发布前检查本次新增/整合的文本，未发现真实常见格式的密钥；真实凭据、SQLite 记忆、权重、原始运行日志未加入提交。

## 本次修复与遇到的问题

- GitHub PR 检查暴露原 MissionRunTest 的临时目录清理竞态：第三个 journal 未等待 flush。补充 saved(again) 的隔离断言，等待全部三个日志完成；原 ZIP 不变，工作源码的一行修复由导入清单记录和逐项验证。

- 原尖塔复盘测试依赖本机存在 API Key，即使注入了假 HTTP 也会先失败。现允许向 summarize 注入测试配置，测试显式使用 fixture 密钥和假响应；实际运行仍默认使用原 settings。
- 停止或超时后不能靠计时器释放桌面占用。统一层等待下层 idle 回执；停止期间迟到成功不算 VERIFIED。主服务关闭时先请求 Skill 清理，再关闭其本机 HTTP 停止通道。
- WSL 的 Windows interop 在本次环境返回 Exec format error，因此 Windows Java、Git 和原生 Python 使用 cmd.exe 直接运行。Linux 测试与文件处理仍优先 WSL。
- 本机 JDK 以 `D:\` 为根，Fabric 源码重映射报告找不到 `D:\release`。双加载器编译和 GameTest 仍通过，但不能据此保证 sourcesJar 中每个第三方源码重映射都正确。本次不创建正式独立 MC Release；原始对应源码完整提供。
- 原工程 Git 自动维护报告 object pack 损坏。发布使用从 GitHub 同一基线重新克隆的独立副本，未删除或重写原工程的对象库。

## 保留资料与未验证范围

本机额外快照复制校验了 355 个学习/记忆文件，为 8,947 个权重、录像和实验文件记录原位保留索引。原路径继续保留；索引不是这些大文件的第二份备份。尖塔历史 48 层通关、MC 历史 LoRA 训练均保留来源与原结论，不计入本次测试数量。

初次整合时没有启动新的实机冒险或调用付费模型；后续尖塔 API 实测另见上方记录。没有重新微调、证明胜率提高或验证 BGI 实机桥接。Java GameTest 不覆盖 F8/F9 UI、完整客户端长时接管或第三方模组安装；新增 MC 任务接口的编译通过也不证明客户端已验证，跨进程全局控制锁尚未实现。

已有依赖安装报告存在 npm audit 告警；本次没有为了清空告警而批量升级游戏/模型依赖。它们与客户端实测、长期稳定性一起属于后续维护范围。

顶层已加入整合 CI；GitHub Actions 结果应检查对应提交，不能将“工作流文件已创建”当作云端通过。
