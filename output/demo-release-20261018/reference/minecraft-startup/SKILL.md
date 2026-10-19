---
name: minecraft-startup
description: 启动或恢复本机 AI_vtuber 的 Minecraft、局域网服务器、Mineflayer、Qwen、OBS 和网页游戏画面，并验证连接；用于用户要求开游戏、恢复直播画面或继续 Minecraft 自主运行。
---

# Minecraft 启动与画面恢复

工作目录 `E:/Github/AI_vtuber`。用户希望启动、连接、验证完成后再报告结果，无需逐项重复确认。遵循本次请求的服务器、账号与运行时长；上次会话端口不是永久配置。当前已知账号为 `jiaobenbot`，旧局域网端口49729仅供核对。

## 先恢复现场

- 阅读项目 AGENTS.md、`docs/minecraft-expanded-capabilities.md`、`docs/minecraft-survival-step-guide.md`，以及 `logs/minecraft-forty-minute-run.json`、`logs/minecraft-three-second-monitor.json` 和最新自主日志。旧文件里的 enabled、pid、deadline 需用当前服务核验。
- 分别核验主服务3000、本地模型11435、Java游戏、Mineflayer控制服务、OBS及采样器的真实进程和端点。服务正常则复用；失效先核验PID和完整命令行，再修复。启动后台服务使用隐藏窗口，不重复拉起。
- 游戏UI使用可用的 computer-use 技能和返回的唯一Minecraft Java窗口。没有游戏窗口时，查明已安装的HMCL/官方启动器入口并启动，选择已有Minecraft安装；不得猜Java启动参数。登录或缺少现有游戏账号时交由用户处理。
- 查看游戏当前界面。已有正确世界/服务器连接就继续；否则从多人游戏连接用户指定服务器。局域网世界在实际游戏中开放后读取本次显示的端口，核验监听，再更新机器人连接。不得擅自创建/重置世界。无法确定世界或服务器时询问具体缺项。

## 主服务、模型和机器人

- 主服务参考 `scripts/restart-main.ps1`：仅在缺失或需部署时使用，先检查实现及当前进程；健康主服务不例行重启。
- 本地模型参考 `scripts/start-local-llm.ps1 -BaseOnly`，11435健康且模型已加载才继续。不要因为health能返回就宣称推理已完成。不要无故启用训练或旧adapter。
- 机器人入口为 `scripts/minecraft-session.js`，实际参数来自当前会话：`MC_HOST`、`MC_PORT`、`MC_USERNAME`、`MC_AUTH`。入口默认25565/SuiGeBot不适用于所有会话，不可盲用。已有机器人先复用。
- 通过 `require('./src/minecraft/autonomy-loop').controlRequest('/observe')` 和 `controlRequest('/capabilities')` 核验。认证配置在 `logs/minecraft-control.json`，绝不输出token或整份配置。
- 应确认机器人 connected、服务器与账号正确、`expanded=true`，动作数与当前Schema一致（本次75）。接口注册不等于全部动作已实机成功。继续保持生存模式，不作弊、给物品、自动切创造模式。

## OBS与网页

- 检查已安装OBS进程；本机已知安装 `D:/obs-studio/bin/64bit/obs64.exe`，先核验路径存在并复用现有实例。OBS WebSocket通常4455，密码从用户已有配置读取，不能打印。
- 本项目源 `Minecraft Bot Window`、场景 `Minecraft Bot POV`。查询真实源设置，使用窗口捕获 `method=2`（Windows Graphics Capture）并绑定当前Java/GLFW Minecraft窗口，启用源并启动虚拟摄像头。不要录屏。源名缺失时先查当前场景/输入，不覆盖无关场景。
- 玩家旁观授权已给出时，在玩家客户端输入 `/spectate jiaobenbot`，观察游戏确认旁观成功。这是玩家视角操作，不是修改机器人模式。死亡可能解除旁观；核验后恢复。关闭工作台、物品栏、暂停菜单才能验收实际游戏视角。
- 在用户现有 `http://127.0.0.1:3000/minecraft.html` 标签操作，保留未发送文本。点击“连接 OBS 画面”；若旧流停滞，先“停止共享”，再连接。使用已有授权的虚拟摄像头，不能仅凭按钮文字宣称有画面。
- 截图确认网页中实际显示Minecraft，检查新帧持续到达（该页面可显示帧率），确认没有停在菜单、全黑或错误游戏。最小化游戏可能中断捕获。保存截图并在结果里展示。

## 把攻略接给Qwen，再启动规划

- 文件存在不表示模型读过。读取攻略 `## 完整执行攻略` 到 `## 规划约定` 之间的完整核心，结合实际授权构造不超过1000字的长期goal；保留“木剑并装备→真实房屋与门→羊毛床→照明熟食箱子→浅矿返家”和真实验收条件。
- 正在运行相同目标时通过 `POST /api/minecraft/chat` 发送事实/攻略建议：`{text,influence:true,suggestionOnly:true}`。每条不超过500字；建议只保留最后3条，不能无限分块全文。核心可分两条，第三条放精简规划约定，逐条检查accepted及快照 audienceSuggestions。后续反馈会挤出旧建议，因此持续运行的核心应放进长期goal。
- 已有循环目标不能热替换；需要换目标时先在授权范围内停止并等待取消完成，然后以新goal启动。先读取loop状态，避免重复启动。持续运行授权使用 `{enabled:true,continuous:true,untilStopped:true,goal}` 提交到 `/api/minecraft/loop`；限时运行遵循用户截止，不擅自延长。
- 由Qwen自主选动作并调用Mineflayer；监督者不直接发合成、采集、建造等游戏技能来冒充模型完成。检查真实模型请求、决策、技能结果与库存/世界增量。只收到 next-planning-step 表示排队，不能报告Qwen已理解或执行。
- 若先前操作被自动审批拒绝，报告被拒动作及系统给出的原因；不改用UI、其他工具、拆分启动等方式绕过拒绝，也不自行点击审批通过。可以继续独立的文档整理、健康检查、画面修复和建议投递。

## 采样与验收

- 运行配置保存在 `logs/minecraft-forty-minute-run.json`；即使文件名为forty-minute也需按本次 untilStopped/deadline解释。
- 采样入口 `scripts/minecraft-three-second-monitor.js`。先核验旧PID是否仍是该脚本；没有运行实例且启动已授权/允许时才隐藏启动。它每3秒采样，并非模型每3秒推理；循环关闭时会退出，不会自行恢复。
- 完成报告须分别说明游戏/服务器、机器人、Qwen规划循环、OBS虚拟摄像头、网页实际画面、采样器及攻略的加载/消费状态。至少观察一次真实规划或明确具体阻塞；仅端口开放不算自主运行成功。
- 用户STOP时立即停止主loop并取消主动任务，保留机器人连接和安全层，暂停监督；不自动恢复。无实质变化保持安静。
