# 本次整合验证

日期：2026-10-30。环境：Windows 11、Microsoft OpenJDK 21.0.8、Gradle Wrapper 9.2.0；Node 测试同时使用 WSL Ubuntu 的 Node 22.22.2 和本机 Node，原生 Python 检查使用已有 Windows Python 环境。此文档记录整合版的新验证，原 ZIP 的历史 VALIDATION 原文保持不变。

| 检查 | 本次结果 | 证据范围 |
| --- | --- | --- |
| ZIP 与导入源码 | 全部 151 文件保留，原包 SHA-256 校验通过 | 允许原 .gitattributes 触发的 Git 换行规范化，原始 ZIP 字节不变 |
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

- 原尖塔复盘测试依赖本机存在 API Key，即使注入了假 HTTP 也会先失败。现允许向 summarize 注入测试配置，测试显式使用 fixture 密钥和假响应；实际运行仍默认使用原 settings。
- 停止或超时后不能靠计时器释放桌面占用。统一层等待下层 idle 回执；停止期间迟到成功不算 VERIFIED。主服务关闭时先请求 Skill 清理，再关闭其本机 HTTP 停止通道。
- WSL 的 Windows interop 在本次环境返回 Exec format error，因此 Windows Java、Git 和原生 Python 使用 cmd.exe 直接运行。Linux 测试与文件处理仍优先 WSL。
- 本机 JDK 以 `D:\` 为根，Fabric 源码重映射报告找不到 `D:\release`。双加载器编译和 GameTest 仍通过，但不能据此保证 sourcesJar 中每个第三方源码重映射都正确。本次不创建正式独立 MC Release；原始对应源码完整提供。
- 原工程 Git 自动维护报告 object pack 损坏。发布使用从 GitHub 同一基线重新克隆的独立副本，未删除或重写原工程的对象库。

## 保留资料与未验证范围

本机额外快照复制校验了 355 个学习/记忆文件，为 8,947 个权重、录像和实验文件记录原位保留索引。原路径继续保留；索引不是这些大文件的第二份备份。尖塔历史 48 层通关、MC 历史 LoRA 训练均保留来源与原结论，不计入本次测试数量。

没有在此次整合中启动新的实机冒险、调用付费模型、重新微调、证明胜率提高或验证 BGI 实机桥接。Java GameTest 不覆盖 F8/F9 UI、完整客户端长时接管或第三方模组安装；原生 MC 遥控与跨进程全局控制锁也尚未实现。

已有依赖安装报告存在 npm audit 告警；本次没有为了清空告警而批量升级游戏/模型依赖。它们与客户端实测、长期稳定性一起属于后续维护范围。

顶层已加入整合 CI；GitHub Actions 结果应检查对应提交，不能将“工作流文件已创建”当作云端通过。
