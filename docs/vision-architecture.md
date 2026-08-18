# osu! 视觉观察系统架构（v2）

> 对应任务书 `docs/deepseek-osu-vision-implementation-brief.md` 的 Phase A–H 实施记录。

## 1. 定位与边界

本系统是**本地运行的 osu! 画面观察与训练分析底座**：识别游戏场景、提取结算信息、
按时间聚合一局表现、生成有证据的训练建议。它是"训练数据底座"，不是自动代打。

明确不做：

- 不发送鼠标/键盘/数位板输入，不自动瞄准/点击/代打，不绕过反作弊。
- 不宣称仅凭低帧率截图精确重建每个 hit object 或判定每个 miss 原因。
- 不上传、不长期保存完整屏幕画面（临时文件分析后即删）。
- 不训练深度学习模型（第一版为 OpenCV + ROI + 规则 + 模板 OCR + 时间聚合）。
- 不修改 brain/memory/TTS/Live2D/B站等无关模块。

## 2. 总体架构

```text
用户主动选择 osu! 窗口（浏览器 getDisplayMedia）
  -> 前端限频截图（约 1-2 FPS，JPEG）
  -> POST /api/vision/analyze（Node 输入校验 + 单飞行调度）
  -> Python 单帧分析（src/vision/python/analyzer.py, schema v2）
      -> quality（亮度/模糊/黑屏/高频噪声）
      -> scenes（6 类场景多证据打分 + evidence）
      -> OCR（自研模板匹配，结算字段三重校验）
  -> Node provider 校验归一化 -> observation 串行落盘（限 500 条）
  -> session-tracker（一局状态机：去抖/结算/中断）
  -> training-analyzer（基于事实的建议，不武断归因）
  -> Studio 调试展示
```

## 3. 数据契约（schemaVersion 2）

```json
{
  "schemaVersion": 2,
  "frame": { "width": 1280, "height": 720,
             "quality": { "brightness": 0.42, "blur": 73.2, "usable": true, "warnings": [] } },
  "scene": { "name": "gameplay", "confidence": 0.84,
             "candidates": { "gameplay": 0.84, "results": 0.08, "songSelect": 0.03,
                             "pause": 0.02, "fail": 0.01, "unknown": 0.02 },
             "evidence": ["playfield-circle-pattern", "active-combo-region"] },
  "gameplay": { "circleCandidates": 7, "combo": { "value": null, "confidence": 0 },
                "health": { "value": null, "confidence": 0 } },
  "results": { "accuracy": { "value": 95.28, "confidence": 0.9 }, "misses": { "value": 3, "confidence": 0.8 },
               "maxCombo": { "value": 412, "confidence": 0.8 }, "score": { "value": 2341567, "confidence": 0.7 },
               "grade": { "value": "S", "confidence": 0.9 } },
  "timingMs": { "total": 0 }, "warnings": []
}
```

规则：

- 未识别值一律 `null`，**绝不用 0 冒充**。
- 置信度限定 `[0,1]`；`scene.name` 只取固定枚举
  `gameplay/results/songSelect/pause/fail/unknown`。
- 输出必须含 evidence 与 warnings，方便验收误判。
- Node 侧 `validateFrame()` 严格校验：schema/场景/置信度/尺寸为**结构错误（throw）**；
  结算字段业务范围非法（accuracy 越界、miss 负数、grade 非枚举）**降级为 null 并附 warning**。

## 4. 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/vision/python/analyzer.py` | v2 入口：解码校验 -> 质量 -> 场景 -> OCR -> schema v2 |
| `src/vision/python/quality.py` | 尺寸/像素上限、亮度、模糊、黑屏、高频噪声护栏 |
| `src/vision/python/scenes.py` | 6 类场景多证据打分；每类 ≥2 个独立证据；低置信落 unknown |
| `src/vision/python/roi.py` | 归一化 ROI 与颜色/亮度统计（BGR 语义） |
| `src/vision/python/features.py` | 圆形、边缘、颜色、布局、细条带特征 |
| `src/vision/python/ocr.py` | 可替换 OCR provider（自研模板匹配 + 格式/置信度校验） |
| `src/vision/osu_analyzer.py` | v1 兼容入口（保留，避免失效路径） |
| `src/vision/provider.js` | Node provider：spawn 超时/输出上限、schema 校验、单飞行并发、串行 observation 写入、状态指标 |
| `src/vision/session-tracker.js` | 一局状态机 `idle->possibleGameplay->gameplay->possibleResults->results->idle`，去抖/单次完成/超时中断；**已接入 provider 生产链路**（自动形成"开始→结算→一局完成"事件） |
| `src/vision/training-analyzer.js` | 基于结构化 observation 的建议：evidence、不武断归因、单局仅初步、≥3 局谈趋势；**telemetry 读取同谱面历史后聚合** |
| `src/api/studio.js` | `/api/vision/analyze`（v2）、`/api/vision/telemetry`（兼容）、状态入 `/api/studio/state` |
| `public/studio.js/html/css` | 调试页：场景/置信度/质量/延迟/OCR 字段（null 显示"未识别"）、evidence、建议、采样状态 |

## 5. 安装与运行

```powershell
# 依赖已就绪：runtime/vision-env（Python 3.12 + OpenCV 5.0 + NumPy 2.5），无额外 Python 包

# 生成合成测试图（17 张，6 类场景 + 负样本，3 种分辨率）
npm run vision:fixtures

# 视觉测试（Python 21 项 + Node 状态机/建议/校验 16+ 项 + session 集成 + 多局趋势 + 并发）
npm run test:vision

# 性能基准（1280 宽 JPEG 单帧延迟 P50/P95）
npm run test:vision:perf
```

## 6. 样本与准确率声明

- 当前 fixtures 全部为**程序合成图**（`tests/fixtures/vision/manifest.json`，17 张），
  仅用于数据契约、分辨率适配、错误路径、场景分类与 OCR 格式测试。
- **真实截图样本为 0 张**，因此：
  - 场景分类与 OCR 的**真实准确率未评估**（不得据此宣称 ready）。
  - `src/brain/capabilities.js` 中 `osu-vision` 保持 `limited`。
- 达到任务书 §6 最低样本要求（每场景 ≥10 张、results ≥30 张、≥5 张负样本、
  覆盖 ≥2 分辨率、来自用户自有截图或明确授权素材）后才能做真实评估。

## 7. 已知限制

- OCR 为自研模板匹配：对合成图（与模板同源字体）有效；对真实 osu 结算页
  （不同字体/缩放/皮肤）未评估，置信度不足时字段保持 null。
- 场景分类基于颜色/布局启发式，不同 skin 可能降低置信度（evidence 会显示原因）。
- 单帧分析 P95 ≈ 408ms（1280x720 JPEG，Intel Ultra 9 275HX），未达实时视频推理；
  前端建议 1-2 FPS 采样。
- 仅凭 accuracy/miss/combo 无法区分 aim/读图/手速，建议模块只给对照实验建议。

## 8. 隐私边界

- 屏幕画面只在浏览器页面 canvas 临时绘制，**不落盘**；发送到后端的 JPEG
  写入 `runtime/vision/incoming/` 临时目录，分析完成后 `finally` 删除。
- `data/osu-observations.json` 只保存**结构化分析结果**（场景/置信度/结算字段/建议），
  不保存原始图像，上限 500 条，串行原子写入。
