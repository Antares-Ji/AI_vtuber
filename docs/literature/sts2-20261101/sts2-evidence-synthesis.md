# STS2 视觉智能体阶段研究：定向文献证据综合

日期：2026-11-01。研究问题：现有 Slay the Spire 长程智能体与通用计算机控制研究，能够为本项目的视觉观察、策略决策、原生输入和结果验证提供哪些参照？

这是针对阶段报告的叙述性检索，纳入 5 个一手来源，覆盖原版 StS、StS2、通用屏幕控制与 Qwen3-VL。按用户要求使用中文。仅定向阅读公开 HTML 的相关章节，未声称逐页全文审读、系统综述或复现；没有下载 PDF、上传私密材料或操作游戏。检索和逐项证据定位见 [search-log.md](search-log.md)。来源 ID 为本次任务内稳定标识，不代表本仓库已有全局文献目录。

## 文献给出的核心判断

**接口必须先于成绩交代。** SpireBench 研究原版 StS，通过 CommunicationModPlus 交换 JSON 状态与文本命令；它提供长程策略评测参照，却不能直接充当视觉定位能力的证据。AgenticSTS 则明确利用 StS2 可转写为文本记录的规则、合法动作和状态，研究有界记忆契约。二者与截图输入、鼠标键盘输出承担的错误来源不同。[SpireBench，§3、附录 B.1](https://arxiv.org/html/2610.12596v1)；[AgenticSTS，§3–4](https://arxiv.org/html/2607.02255v1)。

**视觉计算机控制已有直接先例，但不能据此确认本项目效果。** Cradle 定义截图到键鼠动作的通用计算机控制，并将信息采集、自我反思、任务推断、技能整理、动作规划和记忆分开。其对象包含四款商业游戏和应用任务，不包含 StS2。Epoch 的 SpireClimb 原始报告更接近本任务：采用视觉 computer-use harness，在两个 StS 游戏中按固定种子、每角色每模型 15 次独立尝试评测，并允许笔记及查询游戏 wiki。它证明相关评测范式可行；其外部知识、模型、预算与版本条件必须随成绩一起报告。[Cradle，摘要、§1](https://arxiv.org/html/2403.03186v3)；[SpireClimb，评测方法段](https://epoch.ai/publications/ai-systems-are-improving-rapidly-at-slay-the-spire-and-its-sequel)。

**记忆是否有效取决于内容和实验条件。** SpireBench 报告其跨局记忆机制未带来改进，并指出错误与过度保守建议可能累积。AgenticSTS 的同框架 A0 对照中，无脚手架为 3/10 胜，启用技能的条件为 6/10；作者明确给出 Fisher 检验约 p=0.37，将其限定为方向性观察。它没有确证有界契约优于严格匹配的累积上下文设计。这些结果并不构成简单矛盾：游戏、接口、记忆对象、策略和样本都不一致。[SpireBench，§1 贡献与记忆分析](https://arxiv.org/html/2610.12596v1)；[AgenticSTS，§6.2、Limitations](https://arxiv.org/html/2607.02255v1)。

**视觉模型报告支持候选能力，不支持本机定位成功率。** Qwen3-VL 技术报告覆盖 OCR、grounding 和 GUI agent；§5.10 区分界面定位任务与在线环境决策任务。这样的划分适合本项目分别检查“目标是否看对”和“游戏是否真的推进”。公开模型族基准不能替代本地具体模型尺寸、量化、截图分辨率、提示词和延迟条件下的验证。[Qwen3-VL，§5.4–5.5、§5.10](https://arxiv.org/html/2511.21631v1)。

## 对本阶段报告的适用方式（本综述的研究建议）

1. 每轮记录实际观察提供者、模型版本、截图/文本输入、OCR/CV 校验、决策提供者、动作接口和输入回执；云视觉不得写成“本地模型观察”。
2. 将观察正确、动作提交、原生服务接受、界面发生预期变化、战斗/整局完成分层报告。输入回执只能支持输入链路事实；游戏结果应另有独立可核验证据。
3. 纯视觉试验不得补入隐藏状态来填平观察缺失。结构化 harness 可另设对照条件，但须显式标注，不与纯视觉结果合并。
4. 若测试记忆，固定游戏 build、角色、难度、种子集合、模型和预算；报告完整尝试分母、失败原因、停机条件、成本与耗时，不从少数成功动作推导胜率。
5. 优先定位本项目证据链的缺口，再讨论策略优化：错误观察、过期坐标、输入未到达、动画等待不足和决策错误需要不同修复。以上是从文献接口差异形成的建议，尚非项目对照实验结论。

## 仍未解决的问题

纳入来源没有验证本项目 DeepSeek 决策与本地/云视觉分工的组合，也未验证其原生输入服务、中文 UI、小字卡牌、遮挡和长时运行。文献成绩不构成项目通关或自主性证明。StS2 仍需绑定实际游戏版本；不同版本、角色、难度和外部知识权限下的胜率不宜直接排序。本综述也没有独立复核各作者轨迹数据或统计脚本。

## 核实的一手来源

| ID | 已核实书目信息与版本 | 定向阅读范围 | 本阶段用途与限制 |
| --- | --- | --- | --- |
| STS-L01 | Scott C. Lowe, Sander W. Keemink，*SpireBench: Evaluating Long-Horizon Strategic Play of Agentic Models with Slay the Spire*，2026；[arXiv:2610.12596v1](https://arxiv.org/abs/2610.12596v1)，2026-10-08 预印本 | 标题作者、摘要、§1–3 相关段、表1、附录 B.1 接口段及记忆结论 | 原版 StS 长程策略与评测；结构化接口，不能代替视觉实验 |
| STS-L02 | Xiangchen Cheng, Yunwei Jiang, Jianwen Sun, Zizhen Li, Chuanhao Li, Xiangcheng Cao, Yihao Liu, Fanrui Zhang, Li Jin, Kaipeng Zhang，*AgenticSTS: A Bounded-Memory Testbed for Long-Horizon LLM Agents*，2026；[arXiv:2607.02255v1](https://arxiv.org/abs/2607.02255v1)，2026-07-02 预印本 | 作者与摘要、§1、§3、§6.2–6.4、§7 对照限定段；未审计全部附录轨迹 | StS2 记忆消融；小样本、跨系统混杂；网页 §7 还注明增加的 operational comparison，故不把整页内容的历史状态当作已核定 |
| STS-L03 | Weihao Tan 等 28 位作者，*Cradle: Empowering Foundation Agents Towards General Computer Control*，2024；[arXiv:2403.03186v3](https://arxiv.org/abs/2403.03186v3)，2024-07-02 修订 | arXiv 作者/版本记录、HTML 摘要、§1–2 相关段、模块说明 | 截图与键鼠控制架构；本次按预印本版本引用，未额外核定会议版差异；无 StS2 实验 |
| STS-L04 | Qwen Team（HTML 团队署名；arXiv 元数据列 Shuai Bai 等），*Qwen3-VL Technical Report*，2025；[arXiv:2511.21631v1](https://arxiv.org/abs/2511.21631v1)，2025-11-26 技术报告 | 标题/署名、摘要、训练章节相关段、§5.10、模型规模表的相关段；未重算全部表格 | OCR/grounding/GUI 能力参照；不能外推本机部署或 StS2 胜率 |
| STS-L05 | Benjamin Ou, Simon Chen，*AI systems are improving rapidly at Slay the Spire and its sequel*，Epoch AI，2026-10-14；[作者原始评测报告](https://epoch.ai/publications/ai-systems-are-improving-rapidly-at-slay-the-spire-and-its-sequel) | 署名日期、Overview、方法、Future plans、版本脚注及引用块 | 视觉 StS1/StS2 直接参照；机构报告而非已核实同行评审论文；本次没有复核轨迹 |
