# 岁歌 Minecraft MCP Demo

链路：直播面板目标/确认后的观众建议 → 所选游戏 API 模型规划（默认 DeepSeek） → 本地 MCP 客户端 → stdio MCP 服务 → 已有 Mineflayer 控制服务 → 游戏结果 → 下一轮规划。

模型通过严格 JSON 返回动作，由本地主机转换成 MCP 调用。DeepSeek 配置见根目录 `docs/minecraft-deepseek.md`；游戏控制无需本地 4B 模型。聊天与主播互动使用独立配置。

## 启动与使用

1. 使用 Java 版测试世界并对局域网开放。启动项目原有 `scripts/minecraft-session.js`，通过 `MC_PORT` 指定当次端口；不要复用已过期端口。
2. 启动主服务，在面板保存并检查 DeepSeek 密钥。主服务已使用此 MCP 适配器。控制令牌从本地 `logs/minecraft-control.json` 读取，不发送给模型。
3. 打开 http://127.0.0.1:3000/minecraft.html ，选择工作台或铁镐目标；也可在目标输入框写目标。每次显式启动限时15分钟，两个预设根据背包目标物品确认结束。
4. 在聊天区提出饮食、安全等建议；它们与原目标一起进入下一次规划。当前技能不因普通聊天强行中断；立即停止按钮会取消任务并保留连接。
5. 游戏画面需用户点击选择共享窗口。录制演示按钮需用户选择录制面板所在窗口/标签页，结束后下载 WebM；声音取决于浏览器支持及共享选择。可通过舞台下方“主播语音”开启朗读。

## 独立 MCP

在本目录执行 `npm ci`。MCP 客户端启动命令为 `node`，参数为本目录 `server.cjs` 的绝对路径。

工具：`minecraft_observe`、`minecraft_action_schema`、`minecraft_execute`、`minecraft_task`、`minecraft_cancel`、`minecraft_defend`。

独立模型主机（保留旧文件名）：`node run-qwen.cjs --goal "采集木头并制作工作台" --steps 8 --execute`。读取面板保存的游戏引擎配置；省略 `--execute` 仅生成规划。它通过 MCP 提交动作，需先配置 API 密钥并连接游戏。

## 验收边界

- `npm test`：真实子进程 MCP 握手/工具调用，模拟游戏 HTTP 服务；覆盖非法动作、受伤/换生命拒绝、一次性观察、任务所有权、部分结果、取消、换会话拒绝。
- 根目录 `node tests/minecraft-demo-goals.js`：建议保留长期目标，目标物品验证和目标互斥。
- 以上不是实机生存或工作台完成证据。模型加载、真实生成、游戏任务结果需要分别核实。
- 观察有效期10秒；执行前复核世界、生命、位置、库存和安全状态。接口检查与实际游戏派发仍不是单个原子事务，由原有反射层继续处理突发危险。
- 不支持任意聊天命令、传送或给予物品。成功接收动作不等于完成。记录保留模型元数据和真实任务结果。
- 模型能力沿用现有权重；MCP 接入不会自行提高其材料规划或生存能力。

## OBS MCP

运行 `node integrations/minecraft-mcp/obs-server.cjs`，客户端配置见同目录 `obs-mcp-config.json`。复用项目已安装的 obs-websocket-js 和本包 MCP SDK，无需逆向 OBS。

OBS 必须先启用 WebSocket 服务；默认连接本机 4455。启用认证时通过环境变量 `OBS_WEBSOCKET_PASSWORD` 传入密码，不要写进仓库。工具支持状态、来源列表、窗口枚举、新建捕获、选择窗口、切换场景、本地录制、虚拟摄像头和截图验证；不提供推流工具。

2026-10-14 实测：正常模式 OBS 32.1.2 已启用 WebSocket 5.7.3，4455 连接和认证成功。MCP 已新建 Minecraft Bot POV 场景，枚举并选取 java.exe 游戏窗口，实际截图见 `output/minecraft-demo/obs-capture.png`；虚拟摄像头已启动，未启动录制或推流。安全模式实例未加载 WebSocket 插件。新增创建场景工具后共10个工具。

本机配置用 `OBS_CONFIG_FILE` 指向 OBS 已有配置读取认证密码，不复制密码到仓库；可移植配置仍可通过 `OBS_WEBSOCKET_PASSWORD` 提供。选取窗口必须使用 `obs_windows` 返回的实际值；录制停止返回实际输出路径。

## REA 试运行

REA 源码依赖安装和构建成功，CLI help 可运行。对 Mineflayer 的静态分析实测失败：源码构建缺少 Windows 原生控制组件 manifest，保留部分文件清单证据；不可声称完成逆向。REA 不处于游戏执行链路中。
