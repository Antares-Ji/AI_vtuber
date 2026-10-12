# Maa / MAA 源码筛查（2026-09-29）

## 下载结果与失败原因

已将以下公开仓库下载到本任务工作区 `E:\Github\AI_vtuber\vendor\maa\`：

| 仓库 | 本地目录 | 固定提交 | 获取方式 |
| --- | --- | --- | --- |
| [MaaFramework](https://github.com/MaaXYZ/MaaFramework) | `vendor/maa/MaaFramework` | `9e1211eb7fc921e773a94c114785cbbf09ce50db` | 浅克隆，完整主仓库工作树 |
| [MaaPracticeBoilerplate](https://github.com/MaaXYZ/MaaPracticeBoilerplate) | `vendor/maa/MaaPracticeBoilerplate` | `c209479b803bba9b2cec4eb00a4a99e4535eda3a` | HTTP/1.1 浅克隆，完整主仓库工作树 |
| [MaaAssistantArknights](https://github.com/MaaAssistantArknights/MaaAssistantArknights) | `vendor/maa/MaaAssistantArknights` | `5e502a81103557f65e9ed0fe328310bd0a98f36b` (`dev-v2`) | HTTP/1.1 浅克隆；稀疏检出肉鸽任务/资源、全部图像模板、地图格、ONNX、OCR 和 `src` |

最初普通终端访问 `github.com:443` 失败。DNS 将 `github.com` 解析到 `198.18.5.246` 和内部 IPv6，TCP 443 连接失败；WinHTTP 与 Git 未配置代理，说明普通命令所在环境的网络出口被隔离。获批的提升网络访问使 `git ls-remote` 成功。随后 Git 的 Schannel 在部分克隆按需获取对象时又报 TLS 握手失败；改用 `http.version=HTTP/1.1` 正常浅克隆后完成下载。此修复针对本轮 Git 命令，未修改系统网络配置。

本地核验：三个仓库都能 `git rev-parse HEAD`，工作树无改动。MAA 中已有 4,219 个地图格 JSON、2,520 张通用图像模板（其中 648 张在 Roguelike 目录）、252 个肉鸽资源文件，以及四个 ONNX 文件。克隆没有检出各仓库的外部 Git 子模块；MAA 的其他非目标目录也未检出。当前下载足够进行静态筛查，不能当作可直接构建运行的 MAA 完整发行包。

## 三个仓库分别提供什么

1. **MaaFramework：通用识别与执行框架。** `docs/zh_cn/3.1-任务流水线协议.md` 列出 TemplateMatch、FeatureMatch、ColorMatch、OCR、NeuralNetworkClassify、NeuralNetworkDetect、And/Or 和 Custom 识别节点；Pipeline 支持节点跳转、超时与错误路径。它没有舟专用关卡策略，但其多级识别和状态机结构值得参考。
2. **MaaPracticeBoilerplate：项目脚手架。** `assets/resource/pipeline/my_task.json` 是极简示例；`agent/my_reco.py` 展示在当前截图的多个 ROI 上复用 OCR，并把数字比较结果交给自定义动作。`assets/interface.json`、`agent/main.py` 给出项目入口。它没有肉鸽图像数据库或舟关卡作业。
3. **MAA：明日方舟识别、规则与作业。** `resource/tasks/Roguelike/{base,routing,BlackFlow,JieGarden,Mizuki,Phantom,Sami,Sarkaz}.json` 描述识别节点、ROI、模板/OCR 条件和后继动作；`src/MaaCore/Task/Roguelike`、`src/MaaCore/Vision/Roguelike` 承载实际状态与视觉逻辑。`resource/roguelike` 按主题存招募、购物、事件和关卡部署计划。

## 优先筛出的可复用部分

### 1. BlackFlow 肉鸽地图识别与路线决策

- `src/MaaCore/Vision/Roguelike/BlackFlow/BlackFlowMapAnalyzer.cpp` 对截图做 16:9 逻辑画布归一化，调用 NodeDetector 和 EdgeDetector，返回节点、连线、耗时和可视化图。`map_perception/edge.json` 明确地图 ROI、网格间距、OCR 匹配阈值等参数。
- `map_perception/templates/manifest.json` 写明普通节点以 OCR 为主、特殊节点用模板；可借鉴这种“稳定规则 + 特殊模板”的识别分工。
- `resource/onnx/BlackFlow_corridor_net.onnx` 与 `corridor_net.runtime.json` 给出地图通道连线模型及输入 `[batch,3,40,160]`、预处理与概率阈值。可作为连线判断候选模型，但需要在本项目截图上独立评估。
- `src/MaaCore/Task/Roguelike/BlackFlow/BlackFlowPlanner.cpp`、`BlackFlowPolicy.cpp`、`BlackFlowRoutingTaskPlugin.cpp` 已包含资源、风险、任务里程碑、未知节点揭示、重规划和动作确认/恢复等逻辑。它说明 MAA 在这个主题已经做了部分动态决策；不能概括为完全没有实时决策，也不能由源码存在推断实战效果。
- 传统 `src/MaaCore/Task/Roguelike/Map/RoguelikeRoutingTaskPlugin.cpp` 有明确限制：注释称插件是实验阶段，仅用于萨卡兹和界园部分一层策略；部分路径用固定代价、特定分队条件甚至跳过识别。这正是跨主题泛化的弱点。

### 2. 关卡与战斗知识库

- `resource/Arknights-Tile-Pos/` 的 4,219 个 JSON 是地图格数据，可用来核对地形、部署格与坐标变换。先确认当前关卡的 stage ID，再做画面到网格的配准，不能把数据格点直接当屏幕坐标。
- `resource/roguelike/*/autopilot/*.json` 包含 `stage_name`、`replacement_home`、`blacklist_location`、`deploy_plan`；每个计划项有干员组、格子坐标和朝向。适合作为“已知关卡建议动作”的候选规则或监督线索；仍需考虑实际阵容、费用、敌人路线和随机词条。
- `resource/onnx/operators_det.onnx`、`deploy_direction_cls.onnx`、`skill_ready_cls.onnx` 是值得比较的专项模型。它们的类别映射、输入预处理和输出解释需对照调用代码；不能仅凭文件名就替换现有模型。

### 3. 稳定 UI 与文字识别

- `resource/template/Roguelike/` 已下载 648 张模板图；可以抽取页面/按钮/节点标识做候选识别器。模板图更适合视觉回归与标注辅助，不能自动视为真实截图标注。
- `resource/PaddleOCR/` 与 `resource/ocr_config.json` 提供 MAA 的 OCR 侧资料；模板开发指南另推荐 PP-OCRv6 的 det/rec/keys 资源。费用、生命、节点名、干员名可分 ROI 独立处理并保存置信度。

## 针对当前 AI_vtuber 的优化次序

1. **建立可复现的离线回放集。** 取现有实战录像中的战斗、地图、招募、事件、结算帧，按“整局”划分训练/验证，遵守 `docs/arknights-game-state-learning-20260927.md` 的防相邻帧泄漏规则。记录游戏版本、客户区尺寸、主题与实际结果。
2. **先比较视觉模块。** 同帧评估现有 YOLO/OCR/ORB 与 MAA 模板、ONNX、地图网格：页面状态准确率、节点/通道召回率、卡片定位误差、费用 OCR 错误率、处理耗时。只有在本项目截图上稳定提升的模块才接入。
3. **输出结构化状态，不直接输出点击。** 屏幕识别结果统一为主题、楼层、页面、地图节点和边、资源、阵容、当前可执行动作及置信度。动作候选先受地图连通、部署合法格、费用和当前 UI 状态约束，再由策略排序。
4. **复用 BlackFlow 的重规划思路。** 先做地图导航的“观察→规划→点选预览→确认→再观察”闭环；将移动失败、页面意外变化和低置信度识别作为停止/恢复条件。再扩展到事件/招募/战斗，不把单主题的阈值硬编码到所有肉鸽。
5. **固定作业当基线，随机局做增量决策。** 先用 autopilot JSON 检验已知关卡的画面配准与落地动作，再加入阵容、费用、敌人入口、生命/漏怪和技能冷却实时特征。每步保存观察、策略理由、动作和动作后截图，区分规则成功与模型自主成功。
6. **保留现有项目的闭环验收。** 继续用客户区坐标、真实方向框、部署位变化、技能 READY 状态和结算画面核验动作；用户之前已确认输入成功返回值本身不构成通关证据。

## 边界与后续

这次完成的是源码/资源静态筛查和下载，未运行脚本、训练新模型或控制游戏。下一步若开始实现，应先读取 MAA 模型调用代码和本项目回放样本，做小规模离线对照，确认增益后才改动实时链路。

仓库主许可分别为 MaaFramework LGPL-3.0、模板 MIT、MAA AGPL-3.0。引入任何源码、模板、模型或数据前，还需逐项核对其文件级来源与许可。
