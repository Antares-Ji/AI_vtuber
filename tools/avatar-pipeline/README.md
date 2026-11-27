# Rig2D Avatar Pipeline（服设 → 分图层立绘/PSD → 自动绑骨 → AI_vtuber）

本工具位于 `tools/avatar-pipeline/`，为 `Antares-Ji/AI_vtuber` 提供 **100% 无头全自动 2D 全身可动模型生产链路**，输出自研开放格式包 `model.rig2d.json` + 分层 PNG + 可进 Photoshop 2026 二次精修的分层 `.psd`，并可直接热发布到 `public/avatars/<model_id>/` 由 `AI_vtuber` 的 PixiJS 8 原生 `Mesh` 渲染器驱动。

## 快速开始

### 1. 创建 Python 依赖环境
```powershell
uv venv --python 3.12 tools\avatar-pipeline\.venv
uv pip install --python tools\avatar-pipeline\.venv\Scripts\python.exe -r tools\avatar-pipeline\requirements.txt
```

### 2. 零成本离线全链路验收（内置 37 层「姬岁歌 · 岁/歌」草案夹具）
```powershell
.\tools\avatar-pipeline\.venv\Scripts\python.exe tools\avatar-pipeline\run_pipeline.py demo --publish
```
产出将发布至 `public/avatars/jisui-tidal-draft/model.rig2d.json`（含 `layered.psd` 与 `variants/ge/` 差异贴图），可直接在 `AI_vtuber` 导演工作台 `/studio.html` 的「形象与换装」页热切换。

### 3. 接入真实 OpenAI GPT Image API（`gpt-image-1` / 兼容中转）
在仓库根目录 `.env.local` 中配置：
```env
OPENAI_IMAGE_API_KEY=你的密钥
OPENAI_IMAGE_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_MODEL=gpt-image-1
```
运行真实服设生成：
```powershell
.\tools\avatar-pipeline\.venv\Scripts\python.exe tools\avatar-pipeline\run_pipeline.py generate `
  --name "姬岁歌·星海礼服" `
  --outfit path\to\outfit.png `
  --notes "保留海浪裙摆和冷银蓝挑染" `
  --publish
```

### 4. 启动本地 Web 验收与关节点校准台
```powershell
.\tools\avatar-pipeline\.venv\Scripts\python.exe tools\avatar-pipeline\run_pipeline.py workbench
```
打开 `http://127.0.0.1:8770` 可上传服设、实时测试 22 情绪 / 连续口型 / 7 套全身动作 / 发丝裙摆弹簧物理 / 岁歌双形态切换、直接拖拽修正骨骼关节点并秒级重绑、下载或上传修改后的 `.psd` 重新打包、以及一键发布到 `AI_vtuber`。
