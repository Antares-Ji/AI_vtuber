# AI VTuber「姬岁歌」：朋友与 AI 接手部署指南

更新日期：2026-10-19。用途：与项目源码一起交给新加入的朋友，或直接上传给他的 AI，作为理解工程、部署和继续开发的入口。

本文依据本机源码与项目记录整理；本次只做阅读核对和文档交接，没有在新机器重装，也没有启动游戏、训练或调用付费模型。历史成绩与接手机器的验收必须分别记录。

## 1. 先看这几条

1. 这是一个 **AI 虚拟主播＋游戏智能体的模块化原型**。包含聊天、人格、情绪、记忆、语音、Live2D、直播工作台，以及不同游戏的观察/执行模块。
2. 完整工程在原作者机器的 `E:\Github\AI_vtuber`。`E:\codex\codex_aivtuber` 主要是早期视觉 LoRA 训练结果和 PPT，**只上传后者无法部署完整主播**。朋友不必使用相同盘符，下面命令均从收到的完整源码根目录执行。
3. 原创角色名为「姬岁歌」，包含「岁」与「歌」两套人格设计。已有双人格运行入口与测试，不能等同于训练出了两个成熟的独立人格模型。
4. 项目负责人认为当前 **4B 模型不足以承担目标复杂度，要求升级模型**。这是接下来的明确开发重点；已有记录同时暴露材料推理、数据、寻路、取消、服务拥塞等问题，尚不能把全部失败归因于参数量。
5. 目前源码已接入“大模型负责 Minecraft 阶段规划、本地千问负责互动”的路线。**接入代码存在，不等于云模型已完成真实游戏验收。**
6. 接手顺序：确认文件完整 → 启动基础网页 → 接通一个真实模型 → 按需安装语音 → 接 Minecraft → 做小任务验收 → 对比并升级模型。不要一开始把所有服务一起拉起排错。

## 2. 上传什么、朋友自己准备什么

| 交接项 | 应怎么处理 |
|---|---|
| 完整源码 | 上传主工程的 `src/`、`public/`、`scripts/`、`tests/`、`integrations/`、`docs/`、依赖清单和必要静态资源；包含本指南 |
| 配置模板 | 提供 `.env.example`；朋友自行创建 `.env.local`，填写自己的路径、模型地址和密钥 |
| 本地大模型 | 权重通常不在 Git 中；朋友自行下载匹配版本，或使用其有权限的模型服务 |
| LoRA 适配器 | 仅在确有需要时另行提供权重、基座版本和评估记录；只有训练报告无法加载模型 |
| Python 与 Node 环境 | 朋友重新安装依赖；不要把开发机的虚拟环境和 `node_modules` 当作跨机器安装包 |
| 游戏与账号 | Minecraft Java、匹配的 Java 运行环境、自己的世界/服务器和可用账号；MC 端口以现场为准 |
| 语音 | SenseVoice 模型；如启用 GPT-SoVITS，还需服务本体、匹配权重、参考音频及文字 |
| 直播 | 需要时安装 OBS；正式弹幕接入需平台权限和凭据 |
| 人设与美术 | 人设文档随源码；当前展示模型与原创成品不是一回事。模板特别标记的预览模型不能用于商业直播 |
| 训练数据 | 单独交代数据版本、训练/开发/测试划分、用途和可分享范围；不要默认历史游戏截图已经随源码提供 |

**不要随分享包发送** `.env`、`.env.local`、`data/minecraft-engine.local.json`、`logs/minecraft-control.json`、个人记忆数据库、登录凭据和未审阅的私人聊天日志。Git 忽略规则不会自动过滤手工压缩包；上传压缩包要单独检查文件清单。

早期实验目录有大量带 `(1)` 的文件；它们疑似复制副本，交接前可比对哈希再决定保留，不能仅凭文件名直接删除。

## 3. 整体结构

```text
AI_vtuber/                         ← 完整运行工程
├─ package.json / package-lock.json ← Node 依赖与命令
├─ .env.example                    ← 配置模板
├─ src/
│  ├─ server.js                    ← HTTP 服务、页面和 API 协调
│  ├─ brain.js / brain/            ← 对话、人格、情绪、记忆、模型路由
│  ├─ character/                   ← 角色包与角色契约
│  ├─ local_llm/                   ← 当前本地模型 Python 服务
│  ├─ asr/ / tts/                  ← 语音识别与语音合成适配
│  ├─ minecraft/                   ← 规划、技能、状态、取消、执行核验
│  ├─ vision/ / bot/               ← 游戏视觉与桌面控制
│  ├─ live/ / runtime/ / api/      ← 直播、运行状态、工作台接口
│  └─ story/ / singing/            ← 连续经历；歌唱接口需单独核实成熟度
├─ public/                         ← 舞台、studio.html、minecraft.html
├─ scripts/                        ← 安装、启动、诊断、游戏与训练脚本
│  ├─ flappy-bird/                 ← 可独立运行的轻量游戏 AI
│  └─ minecraft-training/          ← 窄任务 SFT/LoRA 实验
├─ integrations/minecraft-mcp/     ← Minecraft MCP 集成
├─ tests/                          ← 自动检查与模块回归
├─ data/                           ← 配置/数据；其中部分文件是本机私有状态
├─ runtime/ / logs/                ← 本机生成的环境、缓存、运行记录
├─ output/                         ← 实验报告和演示包；是否上传需核对
└─ docs/                           ← 架构、交接、历史结果与操作说明

codex_aivtuber/                    ← 另一个目录：早期训练资料
├─ AI_vtuber_training/runs/        ← Qwen3-VL 视觉相似度实验
├─ deployment_addon/runs/          ← 游戏中“部署结果”的分类实验
└─ ppt/                           ← 训练汇报，不是启动入口
```

注意 `deployment_addon` 中的 deployment 指游戏里的部署状态判断，不是服务器安装部署工具。

## 4. 运行流程

### 4.1 主播互动

```text
文字 / 弹幕 / 麦克风
  → 语音先经过 ASR 转文字
  → 人格、情绪、记忆和上下文组织
  → 模型路由与回复生成
  → 字幕、TTS、播放队列、Live2D 嘴型/动作
  → 记忆候选与连续经历记录（按既有审核规则处理）
```

页面能显示、浏览器能朗读、模型能生成、音响实际出声是不同验收项。fallback 模板回复也不能算作真实模型接通。

### 4.2 Minecraft 当前升级路线

```text
观众文字/语音 → 本地千问整理建议 → 控制台人工确认
                                               ↓
现场状态 → 云端阶段规划 → 程序检查前置条件 → Mineflayer 执行
   ↑                                             ↓
   └──────── 位置、背包、生命及动作结果核验 ────────┘
                         ↓
          事实上下文 → 主播口播 / 互动
```

当前 `astra` 路径一次生成 1–6 步阶段计划，动作仍逐步校验。失败、部分完成、危险、世界/生命周期变化等会使剩余步骤失效并重规划。千问负责互动和建议整理，不应把未经确认的观众文字直接当作游戏命令。

主动口播采用“程序事实句＋千问受限情绪补充”。自由问答仍需检查事实一致性。该模式主要读 Mineflayer 结构化状态，不能把它介绍成模型通过截图逐帧玩游戏。

源码还保留 `local-qwen` 和旧 `astra-jev` 路径。最新分工见 `docs/minecraft-astra-qwen-streamer.md`；旧 JEV 文档不能作为默认部署方案。

### 4.3 Flappy Bird

```text
游戏的 12 维观测 → 附带预训练策略 → 36 帧碰撞预判保护层 → 两种动作之一
```

这条链路不使用千问，不需要云 API，也不代表已经集成了主播解说。

## 5. 现在实现了什么，还差什么

| 模块 | 已有内容/证据 | 尚缺或边界 |
|---|---|---|
| 主播底座 | 人格、情绪、分层记忆、LLM 路由、工作台、字幕、Live2D、语音适配 | 新机器整链路仍需验收；本次未重测所有模块 |
| 双人格 | 人设文档、默认双人格运行入口、`test:personas` | 运行时切换不等于双人格独立训练完成；旧总交接文档部分描述已落后于代码 |
| Minecraft | Qwen 规划、Mineflayer 技能、控制面板、状态核验、取消与生存相关动作 | 75 个注册动作不等于 75 项实机通过；未完成稳定建家和自主生存闭环 |
| 大模型分工 | 阶段规划接口、本地互动、建议确认、状态过期处理 | 需朋友自己的有效凭据、可访问模型与真实世界端到端验收 |
| Minecraft LoRA | 多轮窄任务训练、开发集对比与拒绝/回退记录 | 新权重并非总是更好；v6r1 曾因关键材料回退被拒绝，不能只按 loss 选模型 |
| Flappy Bird | 记录中独立验收 100/100 局达到 1,000 分，另有单局 10,000 分耐久测试 | 有限条件下的成绩，不是永不失败；不是本项目从零训练的模型；主播集成未完成 |
| 明日方舟 | 视觉、控制、部署状态与训练实验 | 局部实验不等于通用自主通关 |
| osu! | 视觉分析、结算字段、训练建议底座 | 真实样本泛化有限，不是自动代打 |
| 直播平台 | OBS 控制、B 站事件适配与联调入口 | 真实平台长连接、凭据和长期稳定直播仍需核验 |
| 歌唱与原创美术 | 规划、接口/配置、角色资料 | 不应宣称完整歌唱能力或正式原创 Live2D 已交付 |

**早期视觉实验作为背景资料保留：**Qwen3-VL-4B 使用 840 张截图，768/896 两组约各训两小时，留出相似度 loss 约从 1.50 降到 0.082/0.051。部署状态实验仅 18 条训练、4 条验证、4 条测试；384 组测试由 50% 到 100%，640 组训练前已经 100%。标签来自 AI 视觉审阅，样本存在同阶段近重复限制。这些结果不能证明成熟游戏决策能力。

## 6. 朋友怎么部署

### 6.1 先检查机器和源码

当前脚本主要面向 Windows/PowerShell。需要 Node、npm；启用 Python 模块时准备 Python/uv。本地 GPU 模型还需可用 NVIDIA 驱动与匹配运行环境。按选定模型、上下文、量化和语音并发实测显存，不把历史训练用 A6000 当作所有人的最低配置。

```powershell
# 在完整源码根目录执行
node --version
npm --version
node -e "require('node:sqlite'); console.log('sqlite OK')"
Test-Path .\src\server.js
Test-Path .\package-lock.json
npm ci
```

`src/brain/memory.js` 使用 Node 内置 `node:sqlite`；如果检查失败，先换成支持该模块的 Node 版本。不要忽略导入错误直接往下部署。

### 6.2 最小启动：先跑网页

从 `.env.example` 创建自己的 `.env.local`，已有文件先保留，不要覆盖密钥。第一次可设：

```dotenv
HOST=127.0.0.1
PORT=3000
LOCAL_LLM_ENABLED=false
TTS_PROVIDER=browser-speech-synthesis
OBS_WEBSOCKET_ENABLED=false
```

```powershell
npm run start:server
```

浏览器打开：

- 舞台：`http://127.0.0.1:3000/`
- 导演工作台：`http://127.0.0.1:3000/studio.html`
- Minecraft：`http://127.0.0.1:3000/minecraft.html`
- 服务健康：`http://127.0.0.1:3000/api/health`

没有真实模型时，只验收网页/API 基础和降级行为。**新机器不要直接照旧 README 执行 `npm start`**：目前它调用 `start-services.ps1`，会拉起并等待 ASR、Qwen 和 GPT-SoVITS；缺少任一依赖容易卡在等待或报错。

### 6.3 接通本地模型或远程模型

本地旧基座的安装入口：

```powershell
uv --version
npm run llm:setup
```

之后自行取得模型，核对 `scripts/start-local-llm.ps1`、`src/local_llm/server.py` 和 `.env.local`：

- 启动脚本目前把 `QWEN_MODEL_PATH` 强制设为 `E:\Qwen3.5-4B`，把名字强制设为 `qwen3.5-4b`。**仅改 `.env.local` 不足以修复这一覆盖。**接手 AI 应将脚本改为优先读取显式配置，再设默认值。
- 服务当前用多模态加载类和 4-bit 量化；换成不同架构的模型必须核对加载器、processor、模板、图像输入和依赖兼容性。
- 启动器可能自动读取 `runtime/minecraft-training/active-adapter.json`；首次复现基座时使用 `-BaseOnly`，避免无意加载旧实验适配器。
- Python 服务不应被假定会读取 Node 的 `.env.local`；需要给启动进程传入对应环境变量，或修正统一配置加载。

修正目标机器路径后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-llm.ps1 -BaseOnly
# 另开终端检查
Invoke-RestMethod http://127.0.0.1:11435/health
```

在 Node 的 `.env.local` 设置 `LOCAL_LLM_ENABLED=true`、`LOCAL_LLM_BASE_URL=http://127.0.0.1:11435/v1` 和服务实际模型名，重启 Node。再发送真实对话，确认响应来自模型而不是 fallback。

通用聊天也有 OpenAI-compatible 配置 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`。这条聊天路由与 Minecraft 阶段规划的专用凭据是两回事，不要混用。

### 6.4 语音按需加装

- **先用浏览器 TTS**：开启页面声音并做一次真人听音，避免把“排队成功”当作出声成功。
- **ASR**：运行 `npm run asr:setup`，随后 `npm run asr:start`；默认服务端口 10095，首次需下载模型。无 GPU 时可用 `setup-asr.ps1 -CpuOnly` 安装并为启动进程设置 `ASR_DEVICE=cpu`，不能只安装 CPU 包却继续指定 CUDA。
- **GPT-SoVITS**：自行安装服务、匹配权重与参考音频。当前启动脚本优先找原机器 `D:\GPT-SoVITS-v2pro-20250604-nvidia50`，且检查特定 v4 权重；旧接入文档描述的是另一套 v2 路径。**先统一脚本、服务版本、模型文件与配置再启动，不能机械照搬旧教程。**就绪后配置 `GPT_SOVITS_BASE_URL` 等字段并切换 `TTS_PROVIDER=gpt-sovits`。

### 6.5 Minecraft

先准备 Java 版世界，对局域网开放，记录本次端口。不要复用文档里的历史端口或原作者账号。

```powershell
$env:MC_HOST = '127.0.0.1'
$env:MC_PORT = '<本次局域网端口>'
$env:MC_USERNAME = '<自己的机器人名称>'
$env:MC_OWNER = '<自己的游戏名>'
# 按目标服务器的登录方式配置 MC_AUTH；需要正版认证时使用 microsoft
node .\scripts\minecraft-session.js
```

另开终端：

```powershell
node .\scripts\minecraft-command.js 状态
node .\scripts\minecraft-command.js 停止
```

机器人控制默认端口为 3001，主网页为 3000；控制令牌由本机生成。先验收连接、状态、停止，再做一个有明确背包增量证据的小任务。不要使用旧的一次性 `minecraft-workbench.js` 代替常驻会话。

使用云端阶段规划时，在 Minecraft 面板选择对应方案、填写自己的专用凭据，再检查连接。当前源码的 `astra` 路径使用 `ASTRA_API_KEY` 或本机配置中的 `astraApiKey`，模型标识硬编码在 `src/minecraft/astra-direct.js`。**本文只记录仓库实现，不保证接手账号可调用该标识；部署前核对供应商当前可用模型与接口，必要时替换适配层。**连接检查会产生 API 用量，但不证明机器人能完成任务。

### 6.6 OBS、平台和 Flappy Bird

- OBS：浏览器源指向舞台地址；需要程序控制时启用 WebSocket 并配置 4455 端口/密码。Minecraft 游戏画面另按现有摄像头/捕获流程接入；舞台出现不代表游戏画面已经连通。
- B 站：取得正式权限后单独联调。模拟弹幕成功不等于真实直播间长连接成功。
- Flappy Bird：安装 uv 后在根目录执行以下命令，依赖安装完成再开窗口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flappy-bird\setup.ps1
.\scripts\flappy-bird\start.cmd
# 验收模式（重新计算，不会自动沿用历史成绩）
.\scripts\flappy-bird\start.cmd --evaluate
```

## 7. 换模型：本轮优先任务

### 7.1 分清三种模型

| 角色 | 当前记录 | 升级时关注 |
|---|---|---|
| 日常主播/旧游戏规划 | Qwen3.5-4B | 事实约束、中文互动、工具参数、延迟和并发 |
| 早期视觉实验 | Qwen3-VL-4B-Instruct | 截图输入、视觉处理和对应 LoRA；与前者不是同一个基座 |
| 新阶段规划路径 | 仓库 `astra` 云端适配 | 实际账号可用模型、接口契约、费用、超时、结构化输出与回退 |

负责人希望升级 4B。朋友应先对比“更强规划模型＋本地互动”的现有路线，再判断聊天模型是否也需升级。本文不指定未经目标机器测试的最终新基座。

### 7.2 接手 AI 具体要做

1. 保存旧模型、配置、适配器选择与评测结果作为回退；不覆盖原权重。
2. 整理冻结评测集：材料刚好够/少一件、已有工具不重复制作、满饥饿不无效进食、危险时避险、失败后重规划、状态过期不编造进度。
3. 同一批输入对比旧基座与候选模型，分别记录 JSON 合法率、动作可执行率、事实错误、延迟和资源/调用成本。
4. 检查模型名是否只用于展示，还是实际参与请求；同步修改配置、加载器和路由，避免“界面改名但仍调用 4B”。
5. 不把旧 LoRA 直接套到新架构或尺寸。逐一验证基座、层名、张量形状与模板；通常应在新基座上重新训练对应适配器，并先测未经微调的新基座。
6. 保留动作校验、取消、状态新鲜度和执行后核验；更强模型仍可能输出不可执行计划。
7. 从单步、短阶段进入实机，再做跨世界多次验收。模型 API 返回、HTTP 202、规划成功均不等于游戏完成。

同时排查寻路/库存/执行预算、长请求、取消后占槽、503 和过期状态；这些问题不能靠换模型名解决。

## 8. 接手验收与分工

| 优先级 | 工作 | 完成标准 |
|---|---|---|
| P0 | 补齐源码、资源、配置与机器依赖 | 输出缺失清单、安装记录；所有必需文件有来源 |
| P0 | 改掉模型和语音的本机硬编码 | 换盘符可配置，启动日志可定位缺失项 |
| P0 | 最小主播链路 | 页面可用；真实模型回复；字幕和实际出声分别通过 |
| P0 | 更强模型对比与接入 | 有同输入对照、真实请求记录、回退配置 |
| P1 | Minecraft 小任务和停止 | 现场状态、背包增量与动作结果一致；停止后不继续旧动作 |
| P1 | 多次生存任务 | 不同场景记录成功/失败；不以一次采木成功代替建家验收 |
| P1 | 主播事实一致性与语音 | 不把目标数量说成已获得数量；断线/过期时不报假进度 |
| P2 | 正式平台、原画、声音、节目化与歌唱 | 各模块独立验收，补齐素材和服务条件 |

可按范围运行现有检查：

```powershell
npm test
npm run test:personas
npm run test:router
node .\tests\minecraft-astra-streamer.js
node .\tests\minecraft-loop.js
node .\tests\minecraft-partial-evidence.js
```

这些是接手后的建议命令，本次没有重新执行。`npm run test:all` 包含依赖独立 Python 视觉环境的检查，不能在未安装依赖时把失败简单归为代码坏了。真实模型、外部 API 和实机测试应另列；模拟测试通过不能替代它们。

朋友/项目负责人负责提供机器条件、可用服务账号、分享范围、模型预算及角色目标；接手 AI 负责查清代码、配置迁移、分阶段部署、评估与更新交接记录。暂不具备条件的模块明确列为未启用，不伪造已完成状态。

## 9. 可直接发给朋友的 AI 的指令

> 请把本文件作为项目交接背景，先检查我上传的是否为完整 AI_vtuber 源码，而不是仅有早期 LoRA 报告和 PPT。阅读 AGENTS.md、README.md、PROJECT_HANDOFF.md、package.json、.env.example，再读最新 Minecraft 阶段规划和 Demo 总结，并以实际源码校正文档差异。输出文件/依赖缺失清单、目标机器部署配置和分阶段验收记录。先启动最小网页与一个真实模型，再逐个接语音和游戏。重点处理旧脚本写死的模型路径和语音权重，以及 4B 模型升级：保留旧版回退、做同输入对照、验证候选模型可用性，不能只改显示名称。不要假定旧 LoRA 兼容新基座，不把 mock 测试、接口接收或生成计划当作真实游戏成功。不读取或复述无关私密数据，不在日志/提交中写密钥。需要我提供的信息集中列出，其余可完成的检查和文档先继续推进。

## 10. 依据与后续阅读

本文核对了完整工程的当前工作区；Git HEAD 为 `cdb27732919ea0783ba1ef2f3e363db43197404d`，**工作区可能包含该提交以外的更改，不能仅用此哈希复现全部内容**。上传时应另外提供实际文件清单/快照版本。

优先阅读以下源码相对路径（本文为便于单独上传，用纯路径而非依赖本机盘符的链接）：

1. `PROJECT_HANDOFF.md`、`docs/AI_HANDOFF.md`：整体背景，旧描述需与最新代码交叉核对。
2. `docs/demo-summary-20261018.md`：近期游戏与主播能力边界。
3. `docs/minecraft-astra-qwen-streamer.md`：当前阶段规划、互动和建议审核方案。
4. `docs/minecraft-connection-and-training.md`、`docs/minecraft-expanded-capabilities.md`：连接和技能；其中历史端口/早期动作数量不作为当前默认值。
5. `docs/minecraft-local-qwen-training-results-20261013.md`、`scripts/minecraft-training/README.md`：训练记录、失败归因和数据边界。
6. `docs/flappy-bird-ai.md`：独立演示、复测命令和历史成绩。
7. `.env.example`、`package.json`、`scripts/start-services.ps1`、`scripts/start-local-llm.ps1`、`scripts/start-gpt-sovits.ps1`：部署时实际要核对和适配的入口。
8. `src/server.js`、`src/local_llm/server.py`、`src/minecraft/astra-direct.js`、`src/minecraft/autonomy-loop.js`：主服务、模型服务和游戏执行主链。

朋友的新部署结果应追加日期、机器、模型版本、配置变化、测试命令、真实结果与剩余问题。旧实验报告保留原样，不把新结论回写成旧实验已经证明的事实。
