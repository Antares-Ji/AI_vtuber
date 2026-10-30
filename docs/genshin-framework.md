# 原神 AI 框架（第一阶段）

当前已实现独立任务服务、API 规划入口、白名单技能校验、模拟执行、单任务互斥、取消/超时、事件日志和主播上下文。启动服务本身不访问模型；提交规划请求时默认调用 DeepSeek API。当前执行适配器仍默认模拟，不启动原神或 BetterGI，不发送游戏输入。

## 启动与验证

```powershell
npm run test:genshin
npm run genshin:demo
npm run genshin:start
```

演示目标为“观察当前场景并钓鱼”，结果应为 `simulated`。它验证软件流程，**不表示已经截图或钓鱼成功**。

独立服务默认监听 `127.0.0.1:17650`，不会重启或替换现有 3000 端口主播服务。
每次启动生成新的令牌，保存至已被 Git 忽略的 `runtime/genshin/service-token.txt`。不打印令牌，不向浏览器开放跨域访问。

```powershell
$genshinToken = (Get-Content -Raw runtime/genshin/service-token.txt).Trim()
$genshinHeaders = @{Authorization="Bearer $genshinToken"}
$genshinBase = 'http://127.0.0.1:17650'
$genshinPlan = Invoke-RestMethod "$genshinBase/plan" -Method Post -Headers $genshinHeaders -ContentType 'application/json; charset=utf-8' -Body '{"goal":"观察当前场景并钓鱼"}'
Invoke-RestMethod "$genshinBase/run" -Method Post -Headers $genshinHeaders -ContentType 'application/json; charset=utf-8' -Body (@{plan=$genshinPlan} | ConvertTo-Json -Depth 8)
Invoke-RestMethod "$genshinBase/state" -Headers $genshinHeaders
Invoke-RestMethod "$genshinBase/stop" -Method Post -Headers $genshinHeaders
```

## 分层

1. `src/genshin/planner.js`：将目标变成有限技能计划；规则模式保留给明确的演练入口。`api-planner.js` 为导演 Skill 和独立服务接入 DeepSeek。支持 `observe / fish / fight`，不接受任意代码、命令或模型自造技能。
2. `src/genshin/runtime.js`：单任务运行，逐步执行，统一取消、超时、结果和事件。超时先请求取消，适配器未退出前不释放任务占用。
3. `src/genshin/adapters.js`：`MockAdapter` 已可运行；`BetterGiAdapter` 提供路径状态和本机 IPC 存活诊断，实机执行明确拒绝，避免把进程存在误当成任务成功。
4. `src/genshin/server.js`：本机令牌保护的 HTTP 接口。
5. `src/games/live-context.js`：新增原神语境，区分计划、回执、模拟结果与真实画面证据。现有 Minecraft/STS2 分支不变。

调用链：目标 → 规划/校验 → 串行执行器 → 适配器 → 状态/事件 → 主播上下文。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 模式与存活状态，无需令牌 |
| GET | `/capabilities` | 当前技能、规划模式与执行器就绪情况 |
| POST | `/plan` | `{ "goal": "..." }`，只生成计划，不自动运行 |
| POST | `/run` | `{ "plan": { "goal": "...", "steps": [{ "skill": "observe", "timeoutMs": 30000 }] } }` |
| POST | `/stop` | 请求取消规划及当前执行 |
| GET | `/state` | 当前/最近任务；`busy` 为是否仍占用执行器 |
| GET | `/events` | 最近200条事件；完整记录为 `runtime/genshin/events.jsonl` |
| GET | `/context` | 可供现有主播读取的原神上下文 |

状态：`running → simulated / failed / cancelled`；取消过程中为 `stopping`。真实适配器未来可使用 `completed`，但仍不能脱离证据宣称游戏胜负。服务重启不自动恢复任务，保留日志供复盘。

## 模型规划与明确的模拟入口

```powershell
$env:GENSHIN_PLANNER = 'llm'
# 在本机环境中设置 GENSHIN_LLM_API_KEY、GENSHIN_LLM_BASE_URL、GENSHIN_LLM_MODEL。
# 也可使用已有 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL 环境变量。
npm run genshin:start
```

导演控制台 `genshin:plan` 和独立服务的 `/plan` 默认使用 DeepSeek API。凭据优先使用 `GENSHIN_LLM_API_KEY`、`DEEPSEEK_API_KEY`，其次复用本地游戏配置 `data/minecraft-engine.local.json` 中的 DeepSeek 专用密钥，最后才使用兼容环境配置。复用凭据仅允许发送到官方 DeepSeek 地址，拒绝其他域名及重定向；密钥不写入结果或日志。模型可由 `GENSHIN_LLM_MODEL` 或 `DEEPSEEK_MODEL` 指定，默认 `deepseek-flash`。

DeepSeek 请求启用 thinking/high、4096 token 上限和45秒超时。输出必须完整结束、符合技能白名单且首步为 observe；取消后即使迟到响应有效也不得接受。结果包含实际模型、用量和是否返回思考内容的标记，不保存思考正文。`genshin:plan` 的 executed 始终为 false，模型规划成功不代表观察到游戏或已经钓鱼。

`genshin:demo` 和 `npm run genshin:demo` 明确使用规则与模拟适配器，不消耗模型调用。独立服务可显式配置 `GENSHIN_PLANNER=rules` 用于离线演练；导演的 `genshin:plan` 不会因为这个变量静默改用规则。BetterGI 实机入口先检查桥接就绪情况，当前仍拒绝未接通的实机运行。

`genshin:plan` 目前只做目标到计划的结构化转换，尚未消费实时观察，也不执行战斗。独立的 `genshin:observe` 已接入原生截图和本地视觉 API，见下文；规划与执行闭环仍需完成第二阶段桥接。规划失败会报错，不回退为规则成功。

可选环境项：`GENSHIN_PORT`（17650）、`GENSHIN_ADAPTER`（mock/bettergi）、`GENSHIN_PLANNER`（rules/llm）、`BETTERGI_EXE`。

```powershell
$env:BETTERGI_EXE = 'C:\Users\Antares.Ji\Downloads\GameAutomation-2026-10-25\BetterGI-v0.66.0\BetterGI\BetterGI.exe'
npm run genshin:doctor
```

即使程序存在，`ready` 仍为 false：程序存在不等于与游戏建立连接。

`genshin:doctor` 和命令行 doctor 还会执行一次只读的 BetterGI v2 本机管道 ping。`ipc.online` 表示收到带匹配请求编号的实例回执；`executableConfigured/executableFound` 分别表示路径配置和文件存在；`bridgeReady/ready/gameConnected` 继续报告执行桥接未就绪。此诊断不启动程序、不注册激活连接、不发送游戏输入。非 Windows 主机明确返回不支持；超时、协议不匹配和访问拒绝保留失败结果，不尝试提权。

## 第二阶段：BetterGI 实机桥接契约

以下是待实现和实测的接口契约，不是现有功能：

- `status()`：区分程序存在、桥接在线、当前游戏已连接及是否可执行。
- `execute(step, {signal, onProgress})`：先核验当前场景；执行有限任务；取消时停止输入；清理完成后返回。
- 回执格式：`{ simulated: false, verified: boolean, evidence: {...}, message: string }`。`verified` 必须有证据；观察需要新截图时间、来源和场景，完成需要可核验结果。
- 对接候选：BetterGI 的 `--startGroups` 和 JS `dispatcher.runTask(new SoloTask("AutoFishing"/"AutoFight"))`。命令行接受不等于任务完成，仍需桥接回执和取消通道。
- 后续要做截图/状态新鲜度检查、任务前置条件、全局键鼠互斥、前台与权限诊断、断连/重启恢复；当前互斥只覆盖此原神服务，不覆盖其他游戏控制器。
- 前端游戏工作台切换、自动向主服务器推送状态/解说尚未接线。当前 `/context` 和共享格式化函数只是接入点。
- 不自动消费树脂、不购买、不执行任意生成脚本。任务前置条件和资源限制应在实机接线时实现。

官方接口依据：
- https://www.bettergi.com/feats/command/introduce.html
- https://www.bettergi.com/dev/js/create.html
- https://www.bettergi.com/dev/js/dispatcher.html

本阶段验证：本地单元/HTTP测试与 mock 演示。没有宣称本地模型或游戏实测通过。

## 2026-10-30 导演 Skill 的真实 API 验证

修复前 `genshin:plan` 总是直接调用规则规划器，独立服务也默认 rules，与用户要求的模型 API 推演不一致。现导演规划与独立服务默认调用模型，明确的 demo 仍保持可重复的离线模拟。

通过主服务 `POST /api/skills/run` 启动 `genshin:plan`，任务 `a81116c2-ae92-46f9-99bc-3b621b3cbe50` 返回 COMPLETED，实际模型 `deepseek-flash`，thinking enabled，输入219、输出1325 token，其中 reasoning 1297。模型针对“观察并规划钓鱼、只生成计划”的目标只返回 observe 步骤，executed=false。没有截图、钓鱼或键鼠动作，因此不能当作原神实机通过。回执保存在本地 `runtime/genshin-skill-api-replay-1793397721277.json`，未提交凭据或推理正文。

同轮 `genshin:doctor` 任务 `f51ca981-8306-447a-9b26-af04a17e144a` 返回桥接 ready=false、gameConnected=false，配置的可执行文件未找到。独立查到 BetterGI 进程存在，并不能代替配置路径、桥接与回执检查；仍需完成第二阶段。Minecraft 的 `/api/minecraft/engine/test` 已真实调用 DeepSeek 并成功，只读测试不证明当前连接了游戏服务器。

Node 整合回归现为 87/87；新增验证覆盖真实规划入口的凭据来源、仅官方地址、思考请求参数、截断拒绝、首步观察以及取消后迟到响应拒绝。HTTP 测试用替身验证默认 llm 调用，以上导演任务则是独立的真实 API 证据。

## BetterGI 0.66.0 本机 IPC 核对

2026-10-30 已确认本机安装目录和仍在运行的 BetterGI 实例。匹配上游 `0.66.0` tag 的提交为 `0af68c28f6b0e714d5304625ce644736d508022e`，不能直接把最新分支或文档中的接口视为当前版本已支持。

- [InstanceIpcProtocol.cs](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Service/Instance/InstanceIpcProtocol.cs) 定义 v2：4字节小端长度、1字节载荷类型、UTF-8 JSON。只读客户端仅发送 ping，限制帧长、等待时间、请求编号、版本和根实例字段，完成或失败都会关闭管道。
- [InstanceContext.cs](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Service/Instance/InstanceContext.cs) 按当前 Windows 用户 SID 定位根管道；[InstanceBootstrap.cs](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Service/Instance/InstanceBootstrap.cs) 使用现有用户权限。诊断结果不输出 SID、账户名或管道路径，没有修改权限。
- [InstanceRequestHandler.cs](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Service/Instance/MessageHandlers/InstanceRequestHandler.cs) 明确尚未注册 task.* 操作；连接注册可能转发启动参数，所以本诊断不调用 connection.open 或 activation.dispatch。ping 成功不能替代任务开始、完成或清理回执。
- [EngineExtend.cs](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Core/Script/EngineExtend.cs) 暴露脚本 CancellationTokenSource；[Dispatcher.cs](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Core/Script/Dependence/Dispatcher.cs) 支持链接取消源和带令牌的任务。下一步桥接可以利用这些实际接口，但仍须接通外部取消、等待输入释放、绑定本次截图与回执，不能直接把调用返回当作游戏结果。

真实只读 ping 返回 protocol=2、primary、processId=121440、windowsSessionId=1，与本地运行实例一致。生产 doctor 随后得到同样结果，ready 和 gameConnected 仍为 false。现有 `AI-VTuber-Probe` 脚本包含 Escape 输入且没有本次截图回执，保留但未启动；未用它替代只读诊断。新增6项 IPC 测试覆盖碎片帧、错误编号/版本/实例、大小边界、断线、超时、取消和权限失败。任务桥接与原神实机推演仍未完成。

部署后通过导演 `POST /api/skills/run` 调用 `genshin:doctor`，任务 `79d9f092-27b2-4300-9fe5-4f9b8680f4f4` 返回 COMPLETED，正式 Skill 回执也取得上述在线实例信息，bridgeReady=false。证据文件为本地 `runtime/genshin-skill-api-replay-1793400464422.json`。Node 整合回归96项通过，包含新增 IPC 测试；未运行原神、未发送键鼠动作。

## 原神观察 Skill：原生截图 → 本地视觉 API

`genshin:observe` 是独立的只读入口。导演 `POST /api/skills/run` 请求如下：

```json
{"skill":"genshin:observe","args":{"target":"YuanShen.exe"},"timeoutMs":120000}
```

国际服可使用 `GenshinImpact.exe`，其他程序名、路径和动作参数都会拒绝。游戏必须已经运行并位于前台；观察不会启动游戏、恢复最小化窗口、切换焦点、按键或移动鼠标。原生窗口识别复用已有 `NativeInput`，显式关闭最小化恢复，截图前后核验前台和客户区，取得原生跨进程互斥；Skill 同时占用 desktop/genshin 资源。即使键鼠已停止，仍可进行这条无输入的观察。

截图保存在 `runtime/genshin/observations/<UUID>/frame.png`，回执包含本次编号、时间、目标进程、客户区和 SHA-256。Node 核验编号、路径、时间与文件摘要，再请求 `127.0.0.1:17646/read` 的 `genshin-scene` 模式；该模式仅接受这个专用目录中的固定文件，不把任意本地图片路径开放给服务。前台变化、截图失败、过期或替换、模型忙、模型 JSON 错误均失败；不伪造观察。取消会阻止后续模型请求或结果发布，纯截图子进程退出后才释放 Skill。已提交给视觉服务的 GPU 推理可能继续结束，但不会因此产生游戏输入。

本地 Qwen 只返回 scene、summary、visible_text、uncertain，不返回可执行坐标；结果始终标记 `unverified_local_model_output`、verified=false、inputSent=false、betterGiExecuted=false。Skill 的 COMPLETED 只代表管道完成，不代表模型内容已被游戏独立证实。结果与模型记录保存在本地原神证据目录，没有自动加入训练集。`genshin:plan` 尚未读取这些观察；`genshin:bettergi` 继续拒绝未就绪的执行。

选择独立观察入口的依据：当前安装版本的 [ScriptService.StartGameTask](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/Service/ScriptService.cs) 会启动截图器并等待游戏主界面，超过30秒可能尝试返回主界面；[TaskRunner](https://github.com/babalae/better-genshin-impact/blob/0af68c28f6b0e714d5304625ce644736d508022e/BetterGenshinImpact/GameTask/TaskRunner.cs) 还会激活窗口并重置实时触发器。因此 `--startGroups` 不能被包装成无副作用截图接口，未调用现有带 Escape 的探针脚本，也未改变 BetterGI 用户配置。

离线验证：Node 整合回归103项通过，新增7项观察测试覆盖身份/时间/摘要、错误图像、动作字段、取消、输出大小及资源互斥；Python 新增6项验证图像目录边界、符号链接逃逸、前台变化、客户区与像素上限，原生输入5项回归通过。替身测试不能替代真实原神截图与模型读取，实机结果另行记录。

现场部署后，导演注册表返回15个 Skill，视觉 `/health` 返回 genshinSceneSupport=true。通过正式 API 启动 `genshin:observe`，任务 `acef7c6a-371e-49e4-bc3f-68e9dd260e3a` 返回 FAILED：未找到可见 YuanShen.exe 窗口（0个），result=null。该失败与现场无原神进程一致，没有发送键鼠，也没有把 BetterGI 在线当成原神截图。证据保存在本地 `runtime/genshin-observe-api-replay-1793401272155.json`。当前只验证了真实 API 的缺失前置条件，尚无真实原神图像的正向观察结果。
