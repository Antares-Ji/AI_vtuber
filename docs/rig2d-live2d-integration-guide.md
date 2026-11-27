# 自研 Rig2D（Live2D 自动化立绘绑骨）接入与对接手册

> 适用分支：`musekc_live2d`（基于 `Antares-Ji/AI_vtuber` 最新 `main` 分支）  
> 核心目标：打通 **输入服设图 → 自动分图层（PNG + PS 可编辑 `.psd`）→ 自动绑骨/蒙皮/物理 → 网页关节点微调 → 一键热切接入 `AI_vtuber` 直播主屏** 的完整闭环。  
> 合规声明：遵循 [原画与美术风格设计](design/visual-direction.md)，管线生成的形象默认标记 `draft: true`（可替换草案），不替代项目组正式批准的原画定稿；原有 Cubism 5 本地预览路径继续完整保留，支持随时热切换回退。

---

## 1. 仓库内置“开源/免费 Live2D 模型”核查与深度对比

### 1.1 先澄清：仓库里自带的模型究竟是什么？

最新 `AI_vtuber` 仓库内置的 Live2D 模型位于 `miku_live2d/miku/miku/`（Web 适配清单为 `public/live2d-web/miku-web.model3.json`，服务端通过 `/live2d/` 静态路由提供），是由画师 **玄宝酱** 绘制、建模师 **怂怂koe** 制作的 **初音未来（Hatsune Miku）Live2D Cubism 5 模型**。

> **⚠️ 版权与商用红线核查**（原文见 `miku_live2d/miku/miku/模型使用说明.txt`）  
> 该模型**并非 MIT / Apache / CC 开源模型**，而是限制严格的**个人免费非商用粉丝模型**：
> 1. 仅可免费用作桌宠或 VTube Studio 面捕，**明确禁止二传、二改**；
> 2. **严禁用于任何商业用途，严禁直播牟利**；
> 3. 默认开启作者水印（当前页面通过 `model.expression("watermark-off")` 隐藏），非商用发布视频必须注明出处；
> 4. 属于初音未来第三方 IP，无法作为项目原创主播 **姬岁歌（岁/歌双人格）** 的正式对外形象。

### 1.2 仓库内置初音 Cubism 5 模型 vs 自研 Rig2D 全维度对比

| 对比维度 | 仓库内置初音模型（Live2D Cubism 5） | 自研 Rig2D 模型（PixiJS 8 原生骨骼网格） |
| --- | --- | --- |
| **定位与角色归属** | 本地开发占位图（初音未来第三方 IP） | 原创主播 **姬岁歌** 及任意同比例服设自动化生产与直播上线 |
| **版权与商用风险** | **高风险**：不可二传二改、严禁直播牟利；运行时依赖闭源专有 `live2dcubismcore-v5.min.js` | **完全可控**：开放 JSON + PNG + PSD；渲染层 100% 基于 PixiJS 8 原生 `Mesh`，无 Cubism 闭源 SDK 限制，支持原创服设直播与商用 |
| **生产方式与周期** | 人工拆件 + Live2D Cubism Editor 专业模型师手工绑骨（通常数天～数周/套服设） | **端到端自动化**：输入服设图 → 云端 `gpt-image-2.5` 多 Pass 拆层 → 本地 OpenCV/SciPy 自动关节点、Delaunay 网格与 LBS 蒙皮（数分钟出成品） |
| **可逆编辑与精修** | **不可逆**：仓库只有编译后的 `miku.moc3`（9.51 MB），缺少 `.cmo3` 工程源且协议禁止二改 | **完全可逆**：同步输出标准 Adobe 嵌套图层组 `layered.psd`（5.92 MB）；画师在 PS 修图后上传即可秒级重绑，也支持网页拖拽 27 个关节点微调 |
| **资产体积（实测）** | **34.63 MB**（`.moc3` 9.51 MB + 6 张 4096 图集 26.63 MB + 物理/表情/配置） | 运行包仅 **3.26 MB**（`jisui-xuanjin-gpt25`：21 张裁剪图层 + 12 张歌形态贴图 + JSON），**体积缩小 10 倍以上** |
| **技术规格（实测）** | 141 个参数、78 个 Parts、40 组物理链、8 个 `.exp3.json` 表情切换、1 个 `Scene1.motion3.json` | 27 根标准人体/裙摆/发丝骨骼、21~37 个规范图层、1610 三角面高密蒙皮网格、12 组二阶弹簧物理链、统一躯干无缝蒙皮 + 胸肩肘软焊接 |
| **口型同步（Lip-Sync）** | 二值开关：`setLive2DMouth(open ? 0.72 : 0.08)`（`miku.model3.json` 中 `LipSync.Ids` 为空） | **音频 RMS 连续口型（0..1）** + 4 态平滑混合（`mouth_closed / smile / half / open`），同时兼容布尔调用 |
| **情绪系统对接** | 22 种主播情绪全部折叠映射为 5 个固定开关（`脸红 / 比心 / 前倾 / QQ人 / 圈圈`） | 原生支持全部 **22 种 AI 主播情绪**（眉高/眉角/眼开合/眯眼/微笑/腮红/星芒/歪头/体倾联动）+ **7 种全身预设动作** |
| **岁/歌双人格形态** | **不支持** | 原生支持 **450ms 平滑双形态切换**（`岁·听潮记岁` ↔ `歌·守潮成歌`：差异贴图交叉淡化 + 呼吸/视线/动作能量/姿态偏置联动） |
| **当前画质与表现力边界** | **优势**：手工 40 组物理链与 141 参数带来的大角度 XYZ 立体转头极细腻，带手绘道具切换（大葱/比心/唱歌/QQ人） | **优势**：换装速度极快、零版权风险、与双人格/情绪/连续口型深度融合；**当前局限**：适合正面 ±15°~25° 自然直播动作，暂不支持大角度 90° 侧转体或手指逐节独立动作（后续可通过手势差分贴图 + 脸部网格形变继续强化） |

### 1.3 团队选型与共存策略

- **零破坏双后端共存**：`public/live2d-renderer.js` 根据模型路径后缀自动分流——`.rig2d.json` 走 `Rig2DPixiStage`（PixiJS 8 原生网格），`.model3.json` 走原有 Cubism 5 运行库。
- **推荐分工**：
  - 日常研发、原创服设测试、双人格直播与对外推流 → **统一使用自研 Rig2D 模型**（如 `jisui-xuanjin-gpt25` 或后续新服设）；
  - 仅在需要对照传统 Cubism 5 物理手感或本地离线兼容回归时 → 在 `/studio.html`「形象与换装」面板一键切回「初音占位模型（Cubism 5 回退）」。

---

## 2. 架构总览与代码地图（最新版 `AI_vtuber` 对接点）

```text
服设参考图 (PNG/JPG)
        │
        ▼
[tools/avatar-pipeline] (Python 3.12 · OpenCV / SciPy / FastAPI)
  Stage 1: 规范化去背与居中对齐 (1024x1536)
  Stage 2: 云端多 Pass 拆层 (gpt-image-2.5) 或本地 synthetic_demo + 歌形态差异贴图
  Stage 3: 导出标准 Adobe 嵌套图层组 layered.psd (可进 Photoshop 精修并回灌)
  Stage 4: 解剖关节点检测 (27 骨骼) + 统一躯干/胸肩肘软焊接 Delaunay 网格 + 12 组物理链
  Stage 5: 自动质检 QA (图层/权重/骨骼/PSD 完整性) → 原子发布到 public/avatars/<model_id>/
        │
        ▼
[AI_vtuber 服务端 & 前端] (Node.js · PixiJS 8 WebGL)
  ├── src/avatars/registry.js      模型发现、路径防穿越校验、默认激活解析
  ├── src/server.js                GET /api/avatars · POST /api/avatars/active · POST /api/avatars/action · GET /api/state
  ├── public/rig2d-engine.js       Rig2DController (纯数学 FK/LBS/弹簧物理) + Rig2DPixiStage (PixiJS 8 Mesh)
  ├── public/live2d-renderer.js    双后端统一入口 (.rig2d.json / .model3.json) + 热切换 + 画布拖拽
  ├── public/stream.js             连续 RMS 口型 + 岁/歌双人格同步 + BroadcastChannel 瞬时热切 (兼容 MC/STS2/原神/陪聊)
  └── public/studio.html & .js     导演工作台「形象与换装」页签 (预览/换装/动作/情绪/PSD 下载)
```

### 关键新增与修改文件清单

| 文件路径 | 作用 |
| --- | --- |
| `public/rig2d-engine.js` | 自研 2D 骨骼蒙皮与物理渲染引擎（含无 DOM 可单测控制器） |
| `public/live2d-renderer.js` | 双后端调度器（支持 `startLive2D / switchLive2DModel / setLive2DEmotion / setLive2DMouth / setLive2DPersona / triggerLive2DMotion / setLive2DMouseFollow`） |
| `public/stream.js` | 接入音频流与 `<audio>` 的连续 RMS 口型、双人格联动、`jisui-avatar` 广播热切换（完整保留原神 / MC / STS2 解说与实时测试契约） |
| `public/studio.html`, `public/studio.js` | 导演工作台新增「形象与换装」面板 |
| `src/avatars/registry.js`, `src/server.js` | 形象注册表与本地控制台鉴权 API |
| `tools/avatar-pipeline/` | 完整服设拆层、PSD 读写、自动绑骨、QA 与 Web 校准台（默认 `127.0.0.1:8770`） |
| `public/avatars/jisui-xuanjin-gpt25/` | 已验证的 `gpt-image-2.5` 实测黑金国风模型包（含 `model.rig2d.json`、21 层 PNG、12 张歌形态贴图、`layered.psd`、`preview.png`） |
| `tests/rig2d-avatar-system.js` | Node 端运动学、口型、双人格淡化、物理稳定与注册表安全单测 |

---

## 3. 环境部署与快速启动（Windows PowerShell）

### 3.1 拉取分支与安装依赖

```powershell
# 1. 切换到本接入分支
git checkout musekc_live2d

# 2. 安装 AI_vtuber Node 依赖（若尚未安装）
npm install

# 3. 创建自研立绘绑骨管线 Python 3.12 虚拟环境（推荐使用 uv + 清华源，约 10 秒完成）
uv venv tools/avatar-pipeline/.venv --python 3.12
uv pip install --python tools/avatar-pipeline/.venv/Scripts/python.exe `
  --default-index https://pypi.tuna.tsinghua.edu.cn/simple `
  -r tools/avatar-pipeline/requirements.txt
```

### 3.2 配置云端生图/拆层 API（仅在生成新服设时需要）

在仓库根目录创建 `.env.local`（已被 `.gitignore` 忽略，**严禁提交密钥到 Git**），参考 `.env.example`：

```dotenv
# 必填：仅用于新服设拆层，已有模型运行和本地重绑不需要 API Key
OPENAI_IMAGE_API_KEY=你的_API_KEY
OPENAI_IMAGE_BASE_URL=https://ai-api.ai-member.icu/v1
OPENAI_IMAGE_MODEL=gpt-image-2.5
OPENAI_IMAGE_QUALITY=2K
OPENAI_IMAGE_RESPONSE_FORMAT=url
AVATAR_PIPELINE_PROVIDER=openai_gpt_image
```

> **接入 Sub2API / OpenAI 兼容图片接口注意事项**：
> - `openai_gpt_image.py` 已严格适配 `additionalProperties: false` 契约：`/images/generations` 仅传 `model / prompt / size / quality / response_format / n`，`/images/edits` 使用重复字段名 `image`；
> - 每次请求携带 `Idempotency-Key` 与 `X-Request-ID`，仅在明确收到 `429/502/503` 时退避重试，**超时绝不盲目重试**以防重复扣费；
> - 同一任务号 `--job-id` 会自动复用 `tools/avatar-pipeline/cache/<job-id>/passes/` 下的 7 张高分辨率 Pass 缓存，后续微调切片/蒙皮/关节点均为 **0 API 费用**。

### 3.3 启动双服务体验

```powershell
# 终端 1：启动 AI_vtuber 主服务（端口 3000）
npm start
# 打开主舞台：      http://127.0.0.1:3000/
# 打开导演工作台：  http://127.0.0.1:3000/studio.html （切到「形象与换装」页签）

# 终端 2（可选）：启动 Rig2D 形象验收与关节点校准台（端口 8770）
npm run avatar:workbench
# 打开校准工作台：  http://127.0.0.1:8770/
```

---

## 4. 三种日常工作流（服设制作 / PS 精修 / 直播热切）

### 4.1 命令行：从服设图一键生成并发布到 `AI_vtuber`

**场景 A：输入已是标准正面全身 A-pose 立绘（强烈推荐，加 `--keep-base` 保真原图且省 1 次生图费用）**

```powershell
.\tools\avatar-pipeline\.venv\Scripts\python.exe tools/avatar-pipeline/run_pipeline.py generate `
  --outfit "你的服设图路径.jpg" `
  --model-id jisui-new-outfit `
  --name "姬岁歌·新服设（草案）" `
  --provider openai_gpt_image `
  --persona-mode dual `
  --keep-base `
  --publish
```

**场景 B：输入是平铺服设 / 穿搭参考图（去掉 `--keep-base`，由模型先生成正面立绘再拆层）**

```powershell
.\tools\avatar-pipeline\.venv\Scripts\python.exe tools/avatar-pipeline/run_pipeline.py generate `
  --outfit "服设平铺图.png" `
  --character-ref "角色脸发参考图.png" `
  --notes "强调深蓝海浪裙摆与银线刺绣" `
  --model-id jisui-wave-dress `
  --name "姬岁歌·海浪礼服（草案）" `
  --provider openai_gpt_image `
  --persona-mode dual `
  --publish
```

**场景 C：零费用离线生成演示模型（无 API Key 时快速联调）**

```powershell
npm run avatar:demo
```

### 4.2 Web 校准台 + Photoshop 精修闭环

1. 打开 `http://127.0.0.1:8770/`，在左侧任务列表选中模型；
2. 勾选 **「显示可拖拽骨骼关节点」**，可直接拖动任意蓝点微调肩/肘/颈/腰/裙摆枢轴，点击 **「保存关节点并秒级重绑」**（零 API 费用，2 秒内刷新网格）；
3. 若个别边缘需要人工精修：点击底部 **「下载分层 .psd（PS 精修）」**，用 Photoshop 打开对应嵌套分组（`Head / FaceEyes / FaceMouth / Arms / Torso / FrontHair / BackHair / Variants_Ge`）修改像素，保存后点击 **「上传修改后的 .psd 重绑」** 自动重打包；
4. 在右侧面板测试 **岁/歌切换**、**连续口型滑块**、**22 种情绪**、**7 种全身动作**，确认 QA 全绿后点击 **「一键发布到 AI_vtuber」**，正在运行的直播页会即时刷新可用列表。

### 4.3 在 `AI_vtuber` 中热切换形象与回退 Cubism 5

- **导演工作台热切换**：打开 `http://127.0.0.1:3000/studio.html` → 「形象与换装」→ 选择任意模型点击切换，直播主屏通过 `BroadcastChannel("jisui-avatar")` 与 `/api/state` 轮询同步生效，无需刷新 OBS 浏览器源；
- **强制指定默认模型（环境变量）**：
  - 优先使用 Rig2D（默认行为）：只要 `public/avatars/` 下存在合法 `model.rig2d.json`，自动选最新发布的 Rig2D 模型；
  - 如需强制锁定回退到旧版初音 Cubism 5：在 `.env.local` 设置 `LIVE2D_MODEL_PATH=/live2d-web/miku-web.model3.json`（或直接在导演台切换到「初音占位模型」）。

---

## 5. 程序接口对接契约（前后端开发参考）

### 5.1 服务端 HTTP API（`src/server.js`）

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/avatars` | 无（公开只读） | 列出所有可用 Rig2D 模型与 Cubism 5 回退项，返回 `activeModelPath`、`active` 及 `avatars[]` |
| `POST /api/avatars/active` | 仅本机 loopback + 同源校验 | 持久化并切换当前激活形象，请求体：`{ "modelPath": "/avatars/<id>/model.rig2d.json" }`（或 `/live2d-web/miku-web.model3.json`） |
| `POST /api/avatars/action` | 仅本机 loopback + 同源校验 | 远程触发表演动作/情绪/视线跟随，请求体：`{ "motion": "wave", "emotion": "excited", "intensity": 1, "mouseFollow": true }` |
| `GET /api/state` | 无（公开只读） | `state.avatar` 返回 `{ id, name, renderer, live2dModelPath, live2dReady, license, action }` |

### 5.2 前端渲染器导出函数（`public/live2d-renderer.js`）

```js
import {
  startLive2D,          // ({ container, modelPath }) -> 初始化 PixiJS 8 画布并加载 .rig2d.json 或 .model3.json
  switchLive2DModel,    // (modelPath) -> 零重建画布热切换模型（含跨引擎 Rig2D <-> Cubism 5 切换）
  setLive2DEmotion,     // (emotion, intensity = 1) -> 驱动 22 种 AI 主播情绪
  setLive2DMouth,       // (openOrLevel) -> 支持 0..1 连续 RMS 口型及旧版 boolean 兼容
  setLive2DPersona,     // ("sui" | "ge") -> 触发 450ms 岁/歌双形态贴图与姿态平滑过渡
  triggerLive2DMotion,  // ("idle"|"wave"|"lean_in"|"happy_bounce"|"think"|"cross_arms"|"bow")
  setLive2DMouseFollow, // (enabled) -> 开关鼠标视线与微倾跟随
  getLive2DSnapshot     // () -> 返回当前后端类型、模型路径、情绪与物理状态快照
} from "./live2d-renderer.js";
```

### 5.3 `model.rig2d.json`（`rig2d-v1`）核心结构速查

```json
{
  "schemaVersion": "rig2d-v1",
  "id": "jisui-xuanjin-gpt25",
  "name": "黑金国风服设（gpt-image-2.5）",
  "draft": true,
  "provider": "openai_gpt_image",
  "psdFile": "layered.psd",
  "previewImage": "preview.png",
  "canvas": { "width": 1024, "height": 1536, "anchorX": 0.5, "anchorY": 0.945 },
  "bones": [ { "id": "chest", "parent": "spine", "x": 504.7, "y": 404.5, "tipX": 504.7, "tipY": 323.4 } ],
  "layers": [
    {
      "id": "torso_base",
      "group": "Torso",
      "texture": "layers/torso_base.png",
      "zOrder": 50,
      "role": "unified_body",
      "parallaxX": 0.0,
      "parallaxY": 0.0,
      "bbox": [249, 324, 773, 1459],
      "mesh": { "positions": [], "uvs": [], "indices": [], "weights": [] }
    }
  ],
  "physics": [ { "bone": "hair_back_l", "stiffness": 58.0, "damping": 8.5, "maxAngleDeg": 8.5 } ],
  "variants": {
    "sui": { "id": "sui", "textures": {}, "profile": { "breathRate": 0.27 } },
    "ge":  { "id": "ge",  "textures": { "hair_back": "variants/ge/hair_back.png" }, "profile": { "breathRate": 0.21 } }
  },
  "expressions": { "neutral": {}, "excited": {} },
  "motions": { "wave": { "durationMs": 1600 } },
  "qa": { "passed": true, "errors": [], "warnings": [] }
}
```

---

## 6. 联调与回归验收命令

每次修改绑骨管线、渲染器或合并 `main` 后，建议执行以下命令验证全链路无回归：

```powershell
# 1. Python 管线单元测试（PSD 往返、绑骨与 QA、HTTP 契约、校准台 API）
.\tools\avatar-pipeline\.venv\Scripts\python.exe -m pytest tools/avatar-pipeline/tests -v

# 2. Node Rig2D 引擎与注册表安全测试
npm run test:rig2d

# 3. AI_vtuber 实时前端、双人格、77 项情绪与游戏工作台回归
node tests/frontend-realtime-behavior.js
node tests/frontend-realtime-cancellation-gaps.js
npm run test:personas
npm run test:emotion
npm run test:skills
npm run test:genshin
npm run test:games
```

### 已知待演进项（Roadmap）

1. **手势与微表情扩展**：后续可在 `variants` 同构机制下增加比心/持道具差分手层，并在头部网格上增加脸颊与下颌微形变以支持更大角度转头；
2. **自定义服设批量换装库**：可在 `public/avatars/` 下持续沉淀多套服设草案，通过导演台一键秒切，不改动任何业务代码；
3. **OBS 推流建议**：OBS Browser Source 继续指向 `http://127.0.0.1:3000`（`1920x1080`），更新模型或热切服设后无需重启推流。
