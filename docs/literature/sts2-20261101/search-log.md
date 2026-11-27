# STS2 定向检索与证据记录

检索日：2026-11-01。方式：公开 Web 搜索发现候选，再访问作者/研究机构原始页面和 arXiv HTML/元数据核对。任务边界：最多 6 个来源，本次纳入 5 个；目标是阶段报告的方法参照，不是系统检索、资格筛选或效果合并。无地域或发表语言筛选；以能核查且贴合问题的一手来源优先。浏览器返回的发布时间相对词仅作导航，年份日期以原始页面核定。

## 精确检索式与选择记录

| 次序 | 索引/入口 | 原样查询或跟踪入口 | 筛选和实际结果 |
| --- | --- | --- | --- |
| Q1 | Web 搜索 | `Slay the Spire LLM benchmark agent paper arxiv` | 找到 SpireBench、AgenticSTS、Orak、2024 游戏难度测试论文及社区导航；纳入前二者，因覆盖原版完整策略与 StS2 记忆；未将社区/导航页用于论断 |
| Q2 | Web 搜索 | `Cradle Empowering Foundation Agents General Computer Control paper arxiv` | 找到作者项目页、arXiv 和论文镜像；跟到 arXiv:2403.03186，纳入 v3；镜像与二手笔记不作为证据 |
| Q3 | Web 搜索 | `Qwen3 VL Technical Report arxiv` | 纳入 Qwen3-VL 报告；排除纯文本 Qwen3 报告、检索 embedding/reranker 扩展及非官方翻译 |
| Q4 | Q1 返回的研究机构报告 | Epoch AI 上述原始报告 URL | 纳入其自报 SpireClimb 方法；没有把文中转述的其他团队成绩当作额外独立原始研究 |
| F1 | arXiv HTML 内定向查找 | `CommunicationMod`、`structured`、`3/10`、`six key`、`5.10 Agent` | 用于定位接口、记忆结果、模块与 GUI 评测；以章节名为主要稳定定位 |

本次执行 3 条发现检索式，外加 1 个直接机构来源跟踪；5 个来源被正式纳入。搜索工具混合返回且结果可变化，本次未导出全量可去重的候选集合，因此不声称完整命中数、排除总数或 PRISMA 流程。未纳入 Orak 与 2024 测试论文是受本任务 4–6 篇上限及主题优先级约束，不代表其质量不足。`spirebench.com` 与同名学术 SpireBench 可能指向不同项目；本记录的 STS-L01 仅指指定 arXiv 作者和 ID，不混用网站成绩。

## 阅读范围、身份核查与逐项提取

所有来源均为公开网页在线阅读，没有本地论文文件；SHA-256/bytes 不适用。没有使用仓库 `papers/` 目录记录（任务开始时该目录不存在）。ID 为此次任务内稳定 ID；若以后建立全局目录，应建立映射，不将其冒充既有 P001 编号。

| Claim ID / 来源 | 可核查定位 | 实际读到的材料与作者报告 | 适用性及限定 |
| --- | --- | --- | --- |
| C01 / STS-L01 | [§3、附录 B.1](https://arxiv.org/html/2610.12596v1)；HTML 约 159、341 行，行号会随解析变化 | CommunicationModPlus 通过 JSON 状态/文本命令控制原版游戏；方法表1明确 A20、Ironclad 和分幕指标 | 可支持“结构化策略评测”，不支持“纯视觉定位已解决” |
| C02 / STS-L01 | 同上，§1 记忆贡献段（约132行），§2.1 与表1 | 作者报告跨局记忆未改善表现；表1给出模型、局数及成本列 | 仅引述该研究结论；未复核数据；不把其对其他论文的评价当作独立核查 |
| C03 / STS-L02 | [§3 Testbed、§4 契约](https://arxiv.org/html/2607.02255v1)，约157行起；标题/作者及 arXiv 摘要页 | 该环境可将规则、卡牌、合法动作和状态表为文本；每次决策使用 typed retrieval 构造新消息 | 支持记忆契约与观察接口比较；不能认定为视觉屏幕控制研究 |
| C04 / STS-L02 | 同上，§6.2，表2（约227–239行） | 3/10 对 6/10，Fisher p≈0.37；作者限定为方向性结果 | 每条件10局；不能断言显著提高或有界契约因果优越 |
| C05 / STS-L02 | 同上，§7 开头（约261–263行）、Limitations | 作者称跨开源系统比较同时改变 patch、routing、thinking effort、batching、prompt cadence | operational comparison 与受控消融分开；本次未审计复现或所有附录 |
| C06 / STS-L03 | [摘要、§1，图2相关模块说明](https://arxiv.org/html/2403.03186v3)，约103–118行；[版本与作者元数据](https://arxiv.org/abs/2403.03186v3) | 截图输入、键鼠输出；六模块；四游戏、五应用及 OSWorld | 论证通用控制架构的研究先例；不是本项目、不是 StS2 结果；未审核全部实验表 |
| C07 / STS-L04 | [§5.10 Agent](https://arxiv.org/html/2511.21631v1)，约418–421行；摘要/标题署名 | 分别评 GUI grounding 和 AndroidWorld/OSWorld 在线环境任务；报告多个尺寸模型 | 适合划分感知与决策指标；不报告本机性能、不推导游戏成功率 |
| C08 / STS-L05 | [Overview 后的方法段](https://epoch.ai/publications/ai-systems-are-improving-rapidly-at-slay-the-spire-and-its-sequel)，约174–177行，Future plans与脚注 | 基于 Inspect ReAct 的视觉 harness，固定种子，每角色每模型15次独立尝试，允许笔记/wiki；版本政策有可比性取舍 | 最接近视觉 STS2 的方法参照；网页机构报告；本次只借方法，不转引排行榜数值 |

完整书目信息与访问链接见 [综合文档来源表](sts2-evidence-synthesis.md#核实的一手来源)。身份核查依据：arXiv 标题/作者/提交历史；Cradle 按 v3 2024 版本；Qwen HTML 署名为 Qwen Team 而元数据为个人作者表，两者如实保留；Epoch 页给出日期、作者与 Citation 块。除明确记录的版本状态外，没有自行推断同行评审状态、DOI 期刊记录或作者实验的正确性。

## 技能依赖与执行限制

已读本机 `C:/Users/Antares.Ji/.codex/skills/deep-research/SKILL.md` 及项目 `docs/wsl-execution.md`。技能的相对 papers 指南在本项目未发现，因此仅在线阅读授权仓库的 [papers/GUIDELINES.md](https://raw.githubusercontent.com/kinqsradio/academic-research-skills/main/papers/GUIDELINES.md)、[REFERENCES.md](https://raw.githubusercontent.com/kinqsradio/academic-research-skills/main/papers/REFERENCES.md)、[DOWNLOADS.md](https://raw.githubusercontent.com/kinqsradio/academic-research-skills/main/papers/DOWNLOADS.md) 模板规则，未导入其空白目录，也未下载论文。规则内容仅用于证据登记工作流，不作为研究结论来源。

本工作不读取游戏截图做决策、不改现场 runtime、不发送未公开数据。主要限制是定向片段阅读、样本文献少、未审计原始数据/代码和未复现。综述中的本项目建议属于研究者推论与设计建议；项目已完成能力必须由单独运行日志和独立结果核查支持。
