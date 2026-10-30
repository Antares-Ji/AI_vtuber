# 杀戮尖塔 2：STS2MCP + DeepSeek

此目录将上游 [Gennadiyev/STS2MCP](https://github.com/Gennadiyev/STS2MCP) 接入 AI_vtuber。DeepSeek 通过标准 MCP 工具调用控制真实游戏，不需要截图识别。

```text
DeepSeek API → Node Agent → Python MCP Server → 游戏内 C# Mod → 杀戮尖塔 2
```

## 启动

在项目根目录执行：

```powershell
# 首次安装或游戏更新后重新编译（需要 git、Node、uv、.NET 9+ SDK）
npm run sts2:setup

# 从 Steam 启动游戏；首次需在游戏中确认启用 Mod，按提示重启游戏

# 游戏连接检查；--probe 会调用 DeepSeek 并实际执行只读 MCP 工具
npm run sts2:doctor -- --probe

# 打开本地控制服务
npm run sts2:start
```

控制面板：<http://127.0.0.1:15527>。支持开始、停止、目标、决策次数、读取状态和连接检查。游戏内 Mod 监听 `127.0.0.1:15526`。

## 主播联动

```powershell
npm run sts2:stream
# 同时开始最多100次决策的自主游玩：
npm run sts2:stream -- -Play
```

直播间：<http://127.0.0.1:3000/sts2.html>。启动脚本复用已运行的服务，按需启动主服务、尖塔控制、GPT-SoVITS 和游戏，连接 OBS，并开启主播联动。需要 OBS 已运行且 WebSocket 可连接。

- DeepSeek 在同一次动作规划中返回简短第一人称台词和表情，不额外调用一个模型生成解说。
- 台词交给现有姬岁歌人格与 Live2D，使用项目已有 GPT-SoVITS 语音及口型。
- 收到前端实际开始播放的回执后才放行对应游戏动作；下一句等待上一句结束，避免台词积压。语音服务首次推理可能较慢；播放失败或超时会暂停游玩。
- 聊天入口通过 DeepSeek 结合实时尖塔状态回应，复用当前人格；聊天不直接执行游戏动作。
- OBS 新增独立场景 `AI VTuber - Slay the Spire 2`，游戏在左、主播在右、字幕在上。未在录制或推流时会切到此场景；录制、推流按钮由用户控制。
- 网页使用约1帧/秒的 OBS 合成预览，实际 OBS 场景保持原采集帧率。OBS 浏览器源负责语音，网页预览本身不重复播放。
- 主播页控制与状态接口在 `/api/sts2/`；旧的15527游戏控制台继续可用。使用15527直接启动时，是否联动取决于当前主播联动开关。

也可直接在终端运行：

```powershell
npm run sts2:play -- --steps 100
npm run sts2:play -- --steps 1 --dry-run
npm run test:sts2
```

每轮运行最多 500 次模型决策；达到上限会停止 Agent，保留当前游戏。CLI 使用 Ctrl+C 停止，面板使用“停止”。游戏进入结算界面后自动停止，不开启下一局。

## DeepSeek 配置

模型默认 `deepseek-flash`，可用 `STS2_MODEL` 或 `DEEPSEEK_MODEL` 修改。密钥按下列顺序读取，控制面板和日志不输出密钥：

1. `STS2_DEEPSEEK_API_KEY`
2. `DEEPSEEK_API_KEY`
3. 已有 `data/minecraft-engine.local.json` 的 `deepseekApiKey`（仅读取，不修改 Minecraft 设置）
4. 指向官方 DeepSeek 地址的 `OPENAI_API_KEY`

只将密钥发送到 `https://api.deepseek.com`。本集成直接连接官方 API，不继承其他游戏的 `DEEPSEEK_DNS_MODE` 覆盖。`.env.local` 继续使用项目原有加载机制。

可选环境变量：`STS2_GAME_DIR`（安装目录）、`STS2_GAME_PORT`（游戏端口）、`STS2_CONTROL_PORT`（面板端口）。端口改变后重启对应服务。

## 项目接口

本地服务仅监听 `127.0.0.1`，拒绝其他来源的跨站控制请求：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/status` | GET | Agent 状态、模型和密钥是否已配置 |
| `/api/state` | GET | 通过 MCP 获取当前游戏状态 |
| `/api/probe` | POST | 真实 DeepSeek + 只读工具检查 |
| `/api/start` | POST | `{"steps":100,"goal":"完成当前单人冒险"}` |
| `/api/stop` | POST | 取消模型请求并停止后续动作 |

POST 请求使用 `Content-Type: application/json`。`/api/start` 可设置 `execute:false` 只生成一次决策。

上游 MCP Server 也能独立运行，供其他 MCP 客户端使用：

```powershell
uv run --directory integrations/sts2-mcp/upstream/mcp --locked python server.py --host 127.0.0.1 --no-trust-env
```

## 执行与记录

- 根据当前界面选择工具，每次只执行一个模型提议的动作，并校验真实 MCP 输入 Schema。
- 执行动作前重新观察；状态变化则重新规划。出牌后重新读取手牌下标。
- 敌方回合和动画过渡等待新决策点；工具超时不直接重放动作。
- 连续三个工具错误或长时间无法进入可操作状态时停止并显示原因。
- 自动玩家只开放单人游玩操作，不开放档案删除、切换或多人操作。
- Agent 日志：`logs/sts2/*.jsonl`，包含工具、真实结果、模型用量和错误。
- 安装记录：`runtime/sts2/install.json`。安装前存档备份：`runtime/sts2/backups/`。

## 来源与验证范围

上游版本记录在 `upstream.lock.json`，新下载固定到该 commit；源码和第三方依赖保留在本地忽略目录。安装脚本使用本机游戏 DLL 编译 Mod，再复制到游戏 `mods/`，不发布游戏 DLL。

2026-10-20 在 Windows、本机游戏 `v0.107.1`、上游 Mod `0.4.0` 上验证：编译零警告零错误、64 个 MCP 工具可枚举、DeepSeek 实际调用只读工具，并自主开始铁甲战士冒险，完成首场战斗、领取奖励、继续走图。`npm run test:sts2` 覆盖参数校验、状态变化重规划、停止、只规划模式和本地接口边界。

以上验证不代表所有事件、角色或完整通关流程已覆盖。游戏版本更新后需要重新编译并检查兼容性。

同日主播联动验证：真实 GPT-SoVITS 音频、OBS Live2D 合成画面、播放开始/结束回执与游戏动作同步；观众询问当前游戏时，主播正确回答杀戮尖塔2、当前角色、幕数、楼层及敌人状态。16项尖塔测试与现有实时上下文、前端播放和取消测试通过。现场验收记录保存在 `output/sts2/streamer-acceptance.json`。

统一入口为 [游戏工作台](http://127.0.0.1:3000/games.html?game=sts2)。顶部切换游戏仅切换画面、状态和专属功能，共用的 Live2D、语音通话、聊天记录与输入框保持挂载。目标和聊天按当前游戏分发，未发送的文字保留。切换不自动停止后台游戏任务，可点“停止当前游戏任务”；尖塔支持设置本轮步数与解说联动。原 `/sts2.html` 和 15527 控制页保留。

画面重连需保持游戏窗口还原，避免最小化；窗口被其他页面遮挡仍可捕获。重连会启用尖塔场景内的游戏与主播源，等待游戏首帧就绪后才返回成功；未找到窗口、窗口最小化或捕获超时会显示具体提示。牌堆查看等游戏弹层也可能阻止回合动作，即使状态仍显示玩家回合；先关闭弹层，再继续爬塔，不要重复发送结束回合。
