# DeepSeek 执行任务：osu! 计算机视觉与训练分析系统

## 0. 你的角色与工作方式

你正在修改现有项目 `E:\iwen_codex\codex_neurosama`，不是新建项目。先完整审计当前实现，再做增量修改。

必须采用下面的工程循环，逐阶段执行，不要只给计划：

1. 定义一个可验证的小目标。
2. 重新读取即将修改的文件和当前 `git diff`，避免覆盖其他 agent 的改动。
3. 选择最小可行修改。
4. 修改代码并运行对应测试。
5. 检查完成条件；失败则定位证据、调整假设并重试。
6. 通过后记录证据，再进入下一阶段。
7. 只有遇到需要用户授权、缺少真实样本或会扩大任务范围的阻塞时才停止询问。

每完成一个阶段，汇报：改了什么、测试结果、下一阶段、预计剩余时间。不要声称未实际测试的功能可用。

## 1. 总目标与边界

目标：建立一个可离线验证、可持续扩展的 osu! 视觉观察系统，让 AI 主播能够识别游戏所处场景、提取结算信息、按时间聚合表现，并生成有证据的训练建议。

本任务不做：

- 不发送鼠标、键盘或数位板输入。
- 不实现自动瞄准、自动点击、代打或绕过反作弊。
- 不宣称能仅凭低帧率截图精确重建每个 hit object 或判定每个 miss 原因。
- 不上传、长期保存用户完整屏幕画面。
- 不重构无关的 brain、memory、TTS、Live2D 或 B 站模块。
- 不训练深度学习模型；第一版使用 OpenCV、ROI、规则、OCR 和时间聚合。

## 2. 现有系统，必须复用

- `public/studio.html`：已有“osu! 视觉”页面。
- `public/studio.js`：通过 `getDisplayMedia` 获取用户主动选择的窗口，每 3 秒发送 JPEG。
- `POST /api/vision/analyze`：接收最大 12 MB 的图像。
- `src/vision/provider.js`：Node provider，调用本地 Python，并记录 observation。
- `src/vision/osu_analyzer.py`：现有 OpenCV v1，仅使用 Hough circle 和 edge density。
- `POST /api/vision/telemetry`：手工录入结算信息并生成简单建议。
- `data/osu-observations.json`：当前观察记录，最多 500 条。
- `runtime/vision-env`：现有 Python 3.12 虚拟环境；先检查已安装依赖，不要盲目重装。
- `src/brain/capabilities.js`：视觉能力目前必须保持 `limited`，除非所有正式验收条件都满足。

## 3. 总体架构

```text
用户主动选择 osu! 窗口
  -> 浏览器限频截图
  -> Node 输入校验与任务调度
  -> Python 单帧分析
      -> 图像质量检查
      -> 场景分类
      -> 场景专属 ROI / OCR / 几何特征
      -> 证据与置信度
  -> Node 时间聚合器
      -> 去抖与状态转换
      -> 一局 session
      -> 结算 observation
  -> 训练分析器
      -> 基于事实的建议
      -> 不确定性说明
  -> Studio 调试展示 / 后续 brain 只读接入
```

模块职责必须分开：单帧识别不能直接生成角色台词；训练建议不能假装成视觉事实；前端不能自行推断核心分析结果。

## 4. 稳定数据契约

Python 每次只向 stdout 输出一行 UTF-8 JSON，日志写 stderr。建议建立 `schemaVersion: 2`：

```json
{
  "schemaVersion": 2,
  "frame": {
    "width": 1280,
    "height": 720,
    "quality": { "brightness": 0.42, "blur": 0.73, "usable": true, "warnings": [] }
  },
  "scene": {
    "name": "gameplay",
    "confidence": 0.84,
    "candidates": { "gameplay": 0.84, "results": 0.08, "songSelect": 0.03, "pause": 0.02, "fail": 0.01, "unknown": 0.02 },
    "evidence": ["playfield-circle-pattern", "active-combo-region"]
  },
  "gameplay": {
    "circleCandidates": 7,
    "combo": { "value": null, "confidence": 0.0 },
    "health": { "value": null, "confidence": 0.0 }
  },
  "results": {
    "accuracy": { "value": null, "confidence": 0.0 },
    "misses": { "value": null, "confidence": 0.0 },
    "maxCombo": { "value": null, "confidence": 0.0 },
    "score": { "value": null, "confidence": 0.0 },
    "grade": { "value": null, "confidence": 0.0 }
  },
  "timingMs": { "total": 0 },
  "warnings": []
}
```

要求：

- 未识别到的值必须是 `null`，不能用 `0` 冒充。
- 所有置信度限定在 `[0, 1]`。
- `scene.name` 只能来自固定枚举：`gameplay/results/songSelect/pause/fail/unknown`。
- 输出中必须包含判断证据和 warnings，方便验收误判。
- Node 侧必须校验和归一化 Python 输出，不能无条件信任子进程 JSON。

## 5. 分阶段实施

### Phase A：基线、样本与可复现测试

先完成，不要直接改算法。

- 审计 Python 环境：输出 Python、OpenCV、NumPy 版本。
- 建立 `tests/fixtures/vision/`，只放用户提供或项目自生成的合法测试图。
- 如果真实图片不足，创建纯程序生成的合成图用于数据契约、尺寸适配和错误路径测试；合成图不能用于宣称真实准确率。
- 建立 JSON manifest，记录每张图的预期场景、来源、分辨率和允许识别字段。
- 保存 v1 在现有样本上的输出作为 baseline。

完成条件：相同 fixture 连续运行两次输出结构一致；不存在图片时测试可明确 skip，并报告缺少何种真实样本。

### Phase B：分析器拆分与输入安全

将单文件分析器拆成清晰模块，文件名可按现有风格微调：

- `src/vision/python/analyzer.py`：入口与数据契约。
- `src/vision/python/quality.py`：亮度、模糊、尺寸、黑屏检查。
- `src/vision/python/scenes.py`：场景候选分数与证据。
- `src/vision/python/roi.py`：归一化 ROI 和坐标转换。
- `src/vision/python/ocr.py`：可替换 OCR provider。
- `src/vision/python/features.py`：圆形、边缘、颜色、布局特征。

保留 `src/vision/osu_analyzer.py` 作为兼容入口或同步更新 provider，不能留下失效路径。

输入安全：限制像素总数、验证解码结果、拒绝超大尺寸/空文件；Python 子进程增加超时和最大 stdout/stderr；临时图仍需 finally 删除。

完成条件：正常图、空文件、损坏图、超大图都有自动测试；失败返回受控错误，不挂住 Node。

### Phase C：场景分类 v2

不要只靠圆形数量。每个场景至少组合两类互相独立的证据，例如：

- gameplay：playfield 几何候选、屏幕布局、combo/health 位置活动、连续帧稳定性。
- results：固定布局区域、accuracy/score 数字候选、grade 区域、低 playfield 活动。
- songSelect：列表式水平结构、封面/标题区域、无 gameplay 证据。
- pause：中心菜单块、背景暗化、低运动。
- fail：失败覆盖层特征、低运动、特定布局。
- unknown：图像质量差，或最高候选低于阈值。

所有 ROI 使用相对坐标，至少测试 `1280x720`、`1920x1080` 和一种非 16:9 分辨率。不要把某一种 skin 的颜色当作唯一依据。

完成条件：fixture 场景测试通过；低置信度必须落入 unknown；结果包含候选分数和 evidence。

### Phase D：OCR 与结算页提取

OCR 必须抽象为 provider。先检测当前环境可用方案，再选择最小依赖：OpenCV 数字预处理 + 可用 OCR 引擎。若 OCR 模型或可执行文件缺失，系统应降级为 `ready=false` 或字段 `null`，而不是崩溃。

处理流程：ROI -> 灰度/对比度 -> 自适应阈值 -> 候选字符过滤 -> OCR -> 格式校验 -> 置信度校准。

字段规则：

- accuracy：`0.00` 到 `100.00`。
- misses/combo/score：非负整数。
- grade：固定枚举，无法确定则 null。
- OCR 原文只进入 debug，不直接成为事实。
- 只有格式、场景和 OCR 三重检查通过才发布值。

完成条件：每个字段有正常、缺失、乱码、越界测试；OCR 错误不会被写成可信 observation。

### Phase E：时间聚合与一局状态机

新增 Node 侧聚合器，例如 `src/vision/session-tracker.js`：

- 状态：`idle -> possibleGameplay -> gameplay -> possibleResults -> results -> idle`。
- 场景需连续多个有效帧才切换，避免单帧抖动。
- 为每局生成 `sessionId`、开始/结束时间、帧数、置信度统计、最终结算。
- 同一结算页重复帧只生成一次完成事件。
- 页面停止共享、子进程失败或超过超时后，session 可明确中断。

完成条件：用人工构造的帧序列测试去抖、重复结果、突然中断和重新开始；不能重复记录同一局。

### Phase F：训练建议 v2

将建议逻辑从 provider 中拆到 `src/vision/training-analyzer.js`。输入只能是结构化 observation/session，不读原始图。

每条建议输出：

```json
{
  "category": "accuracy|consistency|aim|reading|speed|insufficient-data",
  "text": "建议内容",
  "evidence": ["accuracy=91.24", "misses=8"],
  "confidence": 0.76,
  "nextMeasurement": "下一局记录同谱面无 Mod 的 accuracy 与 miss"
}
```

原则：

- 只有 accuracy/miss/combo 时，不能武断断言是 aim、读图还是手速问题。
- 原因不确定时给“对照实验”建议，例如同图降速、无 Mod、重复三次取分布。
- 单局只给初步建议；至少三局同谱面数据才能谈趋势。
- 保留现有 telemetry 兼容，但必须走同一个规范化和建议模块。

完成条件：边界值测试、缺失字段测试、单局与多局趋势测试通过；每条建议都有 evidence。

### Phase G：API、性能和并发

保持已有接口兼容，并新增必要状态字段：

- `GET` 状态中显示 provider/version、Python/OpenCV/OCR 状态、队列长度、平均/最近延迟、丢帧数、最近错误的脱敏摘要。
- `/api/vision/analyze` 返回 schema v2。
- 同一客户端只允许一个在途分析；新帧优先，过期帧丢弃，不堆积。
- Python 子进程必须有超时和清理；浏览器停止共享后不再请求。
- observation 文件写入采用安全、串行策略，避免并发损坏；限制容量。

性能目标：1280 宽 JPEG 的本地单帧分析 P95 小于 1000 ms；达不到时报告实测，不伪造。前端建议 1-2 FPS 采样，而不是追求实时视频推理。

完成条件：并发请求、超时、快速停止共享、连续 100 帧模拟测试不泄漏进程、不无限增长队列。

### Phase H：Studio 调试体验

在现有 osu! 视觉页内增量完善：

- 明确显示当前场景、置信度、图像质量、延迟、session 状态。
- 显示 OCR 字段及各自置信度，null 显示“未识别”，不显示 0。
- 显示 evidence/warnings 和最终训练建议。
- 增加采样中/停止/错误状态，避免重复点击。
- 不显示完整持久化截图；如需调试叠加框，仅在当前页面 canvas 临时绘制。
- 保持页面与主界面现有风格，不新增大型框架。

完成条件：桌面视口无重叠；开始、停止、拒绝屏幕权限、服务端失败均有明确状态；刷新页面不会自动申请屏幕权限。

### Phase I：测试、文档和能力声明

新增独立测试命令，例如：

- `npm run test:vision`
- Python 单元测试命令
- `npm run test:all` 仍通过

至少覆盖：数据契约、损坏图、三种分辨率、六类场景、OCR 格式校验、状态机去抖、重复结算、建议证据、并发/超时、旧 telemetry 兼容。

更新 README 和视觉架构文档，写清安装依赖、运行、样本要求、已知限制和隐私边界。

除非真实样本集达到最低覆盖且评测通过，不得把 `src/brain/capabilities.js` 中 `osu-vision` 从 `limited` 改成 `ready`。

## 6. 最低真实样本要求

没有这些样本时可以完成架构和合成测试，但必须把真实准确率标为“未评估”：

- 每种场景至少 10 张，覆盖至少 2 种分辨率。
- gameplay 至少覆盖 3 种 skin、亮/暗背景、不同 circle size。
- results 至少 30 张，覆盖不同 accuracy、miss、combo、grade。
- 至少 5 张黑屏/桌面/其他游戏作为负样本。
- 样本必须来自用户自己的截图或有明确测试授权的素材。

不要下载来源不明或版权不清晰的游戏录屏作为项目数据集。

## 7. DeepSeek 最终必须交付的验收包

完成后不要只说“已完成”，请提供：

1. 修改文件清单及每个文件职责。
2. `git diff --stat` 和关键 diff 说明。
3. 所有执行过的测试命令、退出码和摘要。
4. fixture manifest 与真实/合成样本数量。
5. 按场景的混淆矩阵；无真实样本时明确写“未评估”。
6. OCR 每字段准确率与失败示例；无真实样本时明确写“未评估”。
7. P50/P95 分析延迟、测试机器与图片尺寸。
8. 已知限制、未完成项、人工测试步骤。
9. 明确确认：没有自动输入、没有代打、没有保留完整屏幕截图、没有改动无关模块。

## 8. Codex 后续验收标准

Codex 会独立重新读取全部 diff，并重点拒收以下情况：

- 只看圆形数量却宣称能识别 osu!。
- 用 `0` 替代识别失败。
- OCR 无置信度或无格式校验。
- 单帧直接触发“一局结束”，造成重复记录。
- 训练建议没有证据，或把 miss 武断归因于 aim/手速。
- 修改了记忆、大脑、人格、TTS 等无关模块。
- 测试只覆盖合成图却声称真实准确率。
- 子进程无超时、临时图未清理、请求无限堆积。
- 加入任何游戏输入控制或自动代打功能。

先执行 Phase A，提交阶段证据，再连续推进到 Phase I。若缺少真实截图，不要停止整个工程：完成不依赖真实样本的架构、契约、错误处理和合成测试，把真实准确率评估列为唯一人工数据阻塞。
