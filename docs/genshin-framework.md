# 原神 AI 框架（第一阶段）

当前已实现独立的任务服务、规则/LLM 规划入口、白名单技能校验、模拟执行、单任务互斥、取消/超时、事件日志和主播上下文。默认不访问模型、不启动原神或 BetterGI、不发送游戏输入。

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

1. `src/genshin/planner.js`：将目标变成有限技能计划；默认规则仅用于演练。支持 `observe / fish / fight`，不接受任意代码、命令或模型自造技能。
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

## 可选模型规划

```powershell
$env:GENSHIN_PLANNER = 'llm'
# 在本机环境中设置 GENSHIN_LLM_API_KEY、GENSHIN_LLM_BASE_URL、GENSHIN_LLM_MODEL。
# 也可使用已有 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL 环境变量。
npm run genshin:start
```

复用现有 OpenAI 兼容传输层，不读取或修改 `.env`，不会打印密钥。使用前需将环境变量载入当前进程。
LLM 目前只做目标到计划的结构化转换，没有视觉观察或战斗实时推理；输出失败会报错，不伪装成成功。规则模式不支持的目标会明确拒绝。

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
