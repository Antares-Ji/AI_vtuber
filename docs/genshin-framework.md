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
3. `src/genshin/adapters.js`：`MockAdapter` 已可运行；`BetterGiAdapter` 只做路径诊断，实机执行明确拒绝，避免把进程启动误当成任务成功。
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

LLM 目前只做目标到计划的结构化转换，没有原神实时视觉观察或战斗推理；这些仍需完成第二阶段桥接。规划失败会报错，不回退为规则成功。

可选环境项：`GENSHIN_PORT`（17650）、`GENSHIN_ADAPTER`（mock/bettergi）、`GENSHIN_PLANNER`（rules/llm）、`BETTERGI_EXE`。

```powershell
$env:BETTERGI_EXE = 'C:\Users\Antares.Ji\Downloads\GameAutomation-2026-10-25\BetterGI-v0.66.0\BetterGI\BetterGI.exe'
npm run genshin:doctor
```

即使程序存在，`ready` 仍为 false：程序存在不等于与游戏建立连接。

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
