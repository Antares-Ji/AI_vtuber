# Live2D AI Streamer MVP

一个本地可跑的 AI 虚拟主播原型：Live2D、人格情绪、分层记忆、主动陪聊、GPT-SoVITS、SenseVoice、osu! 视觉分析和直播运行工作台。

## 快速启动

```powershell
npm start
```

打开：

```text
http://localhost:3000
```

导演工作台：`http://localhost:3000/studio.html`

## 已实现

- 本地模拟弹幕：普通弹幕、礼物、SC、舰长。
- 弹幕优先级：礼物/SC/舰长优先，问题和熟人加权。
- 主播人格与世界书、分数制情绪、重复耐受和主动陪聊。
- 可替换角色包、34 维稳定人格、情境表达人格和 63 维动态情绪。
- SQLite 分层记忆、语义检索、关系状态、反思与训练记忆审计。
- 会话结束自动提炼候选，人工确认后才进入长期记忆。
- DeepSeek/OpenAI-compatible LLM，失败时自动使用本地 fallback。
- GPT-SoVITS 与浏览器 TTS、SenseVoice 本地语音识别。
- Live2D 本地模型、字幕、弹幕、嘴型和动作提示。
- 连续故事篇章、角色目标、经历时间线和日程存档。
- 本地 OpenCV osu! 画面分析与结算训练建议。
- OBS WebSocket 控制与 B 站消息统一适配入口。

## 可选 LLM 配置

项目启动时会读取 `.env` 和 `.env.local`；也可以在启动前手动设置环境变量：

```powershell
$env:OPENAI_API_KEY="你的 key"
$env:OPENAI_BASE_URL="https://api.deepseek.com"
$env:OPENAI_MODEL="deepseek-chat"
npm start
```

兼容 OpenAI 风格接口：

```powershell
$env:OPENAI_BASE_URL="https://your-provider.example/v1"
$env:OPENAI_API_KEY="你的 key"
$env:OPENAI_MODEL="你的模型名"
npm start
```

## 导演工作台

`/studio.html` 提供五个可操作模块：

- 记忆训练：查看、搜索、编辑、失效和灌输长期记忆。
- 大脑诊断：查看自我模型、77 项情绪标定、34 维人格、63 维情绪、训练员反馈与运行指标。
- 真人感调优请按 `docs/human-evaluation-guide.md` 做盲测，避免把单次主观感受直接写进人格。
- 连续经历：维护当前篇章、目标、重要事件与约定。
- osu! 视觉：选择游戏窗口，每三秒在本地分析画面；也可记录结算数据。
- 直播运行：查看 OBS/B站状态，模拟官方事件并测试弹幕队列。

## OBS 使用

在 OBS 里添加 Browser Source：

```text
http://localhost:3000
```

建议尺寸：`1920x1080`。后续替换为真实 Live2D 时，前端舞台层可以保留。

如需从工作台切换 OBS 场景，在 OBS 中启用 WebSocket，然后设置：

```text
OBS_WEBSOCKET_ENABLED=true
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=你的密码
```

## B站与 osu! 当前边界

- B站已经有事件标准化、优先级队列和联调 API；正式长连接仍需要开放平台凭据与项目权限。
- osu! 视觉 v2：场景分类（游戏/结算/选歌/暂停/失败/未知，多证据 + evidence）、
  结算字段提取（自研模板 OCR + 格式/置信度三重校验）、一局状态机聚合、
  有证据的训练建议。它是训练数据底座，不是自动代打系统；真实截图样本未评估，
  能力声明保持 `limited`。架构见 `docs/vision-architecture.md`。
- 结算数据会写入 `data/osu-observations.json`（仅结构化结果，不保存原始画面），
  并同步成为角色的连续经历。

## 后续模块

- `src/brain.js`：主播大脑总入口。
- `src/brain/persona.js`：人格和行为边界。
- `src/brain/emotion.js`：情绪状态、关键词、分数和衰减。
- `src/brain/memory.js`：短期记忆、用户记忆、角色记忆。
- `src/brain/llm.js`：DeepSeek / OpenAI-compatible LLM 接口。
- `src/brain/reply.js`：上下文组织和本地 fallback 回复。
- `src/server.js`：弹幕 API 和静态页面。
- `src/tts/provider.js`：TTS provider 预留接口。
- `public/stream.js`：直播页交互、TTS、嘴型、语音输入与唯一播放队列。
- `src/story/store.js`：连续经历、目标和约定。
- `src/vision/`：OpenCV 视觉 provider、Python 分析器、session 状态机与训练建议。
- `src/live/runtime.js`：OBS 连接与 B站事件适配。
- `src/api/studio.js`：导演工作台 API。

## 回归测试

```powershell
npm run test:all
```

该命令连续运行核心冒烟、26 项高级行为、32 项行为课程、77 项情绪标定、通用角色包独立性、1000 次记忆写入、运行恢复和 600 轮情绪压力测试。osu! 视觉测试单独运行：

```powershell
npm run test:vision
```

真实 DeepSeek 隔离评测单独运行：

```powershell
npm run test:external
```

## 小白学习路线

如果你刚学完 C++ 语法，还不熟工程项目，先看：

```text
LEARNING_PATH.md
```

这份路线按“先看懂、再改一点、最后接真实平台”的方式安排。

## 双线程学习资料

后续工程优化和课程讲解都归档在：

```text
docs/
```

重点文件：

- `docs/roadmap.md`：双线程路线图。
- `docs/glossary.md`：术语表。
- `docs/dev-log.md`：每次工程推进记录。
- `docs/lessons/`：课程归档。

## Live2D 模型

你购买模型后，先把模型文件放到：

```text
public/live2d/
```

当前使用项目内的 Cubism 模型；加载失败时才显示 CSS fallback。
