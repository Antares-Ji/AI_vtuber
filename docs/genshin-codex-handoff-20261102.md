# 原神剧情代理：架构评估与 Codex 执行规格（2026-11-02，Claude 监督）

角色分工（用户 2026-11-02 指定）：**Claude 只做架构评估、规格与监控；Codex 负责实现、测试、部署与启停。**
AGENTS.md 的全部约束保持不变：DeepSeek 决定游戏行动，本地 CV/OCR 观察，原生 API 执行；
Codex 不得读截图给坐标、不得手动游玩；模拟测试、输入回执和真实游戏结果分开记录。

## 1. 现状评估（证据：`scripts/genshin/progress-evaluator.cjs`）

| 范围 | 帧 | DeepSeek token | 实际移动输入 | F 交互 | 任务距离 | HUD 阶段变化 |
| --- | --- | --- | --- | --- | --- | --- |
| 会话 999bd2ba（最近） | 57 | 849,941 | 0.4 秒 | 0 | 186→184m | 0 |
| 全部记录 | 334 | 1,461,350 | 12.95 秒 | 0 | — | 0（始终“前去查看详情”） |

动作分布（全部记录）：key 104、follow_marker 58、turn 46、click_text 35、move 30、wait 30、
list_waypoints 16、advance_quest 7、teleport 5、choose_dialogue 2。
最近 12 帧有 11 帧不在大世界。每步提示词约 1.3 万 token。

结论：安全与回执链路很扎实，但**每 1 秒移动约消耗 11 万 token**，任务没有可测推进。

## 2. 根因（架构层，不是单个 bug）

1. **决策粒度错误。** DeepSeek 每一帧都在选择原子动作（转 250 像素、走 400ms、按 ESC）。
   对 184m 的路程，这意味着数百次“截图→本地视觉→1.3 万 token 推理”。
   LLM 应该选择*意图*（前往任务点 / 交互 / 处理对话 / 回到大世界），
   由原生闭环宏在游戏里以 10Hz 运行，返回时再交给模型。
2. **菜单恢复交给模型逐帧做。** 回到主界面这种确定性操作，每次都要模型判断 ESC，
   而且 OCR 布局误判会造成循环。BetterGI 已有 `genshin.returnMainUi()`。
3. **修补方式是“加限制”。** 每次失败都新增一个拒绝条件，模型可用的动作越来越少，
   最后只剩 ESC/J/wait。新规则必须同时给出一个能前进的替代动作，而不是只禁止。
4. **原生寻路能力没用上。** `follow_marker` 和 BetterGI `AutoTrackTask` 的算法相同
   （俯视角模板匹配 + 按 W），没有防卡、攀爬或游泳处理。
   BetterGI 的 `PathExecutor`（即 `pathingScript.run`）具备这些能力，但只接受坐标。
   注意：上游 `AutoTrackTask` **不可直接调用**。它需要独占任务锁（在剧情脚本内会失败），
   没有超时，取消时可能一直按住 W，超过 150m 时还会盲点固定坐标。
5. **代码可维护性。** `story-main.js` 和 `story-runtime.js` 各约 29KB，多为单行压缩写法，
   规则在 Node 校验器和原生执行器之间重复。继续叠加补丁会越来越难审查。

## 3. 目标架构

```
DeepSeek（意图层，只在决策点调用）
   │  intent: travel_quest | interact | dialogue | return_world | teleport | fight | stop
   ▼
Node 校验器（story-runtime.js）—— 只校验意图前置条件，不做逐帧微操
   ▼
原生宏（story-main.js，BetterGI 进程内闭环）—— 本地 OCR/CV 实时反馈，有界、可取消、必释放
   ▼
结构化回执 {intent, outcome, progress:{distanceBefore, distanceAfter, stageBefore, stageAfter}, stopReason}
```

只有出现以下情况才调用模型：宏返回、场景类型变化、HUD 阶段变化、F 提示出现、出现对话选项。

## 4. 任务包（按优先级，每包独立提交、独立验收）

### P0 `travel_quest`：用原生 PathExecutor 前往任务点

**前置条件（Node 与原生双重校验）：** 场景 world，HUD 有唯一任务距离 d，且 8m < d ≤ 1500m，
当前没有 F 提示、对话或菜单。

**原生流程（story-main.js 新增 `travelQuest(seq)`）：**
1. 读取 HUD 距离 d0 和阶段 s0（复用 `questHud`）。
2. 确定方位：复用 `followMarker` 的对准逻辑（俯视角、V、蓝/黄模板、最多 8 次转向），
   直到唯一标记水平居中（|dx| ≤ 80）。如果模板失配，则用画面内唯一的、等于 d0（±1）的
   世界距离标签作为后备（复用 `questDistanceLabel` 规则）。两者都没有时返回
   `stopReason: bearing_unavailable`，**不移动**。
3. 读取 `θ = genshin.getCameraOrientation()` 和 `p = genshin.getPositionFromMap()`（采样 2 次，偏差 > 10 则拒绝）。
4. 换算坐标（已核对固定源码）：`Navigation.GetTargetOrientation` 在图像坐标系中定义角度，
   方向为 (cosθ, sinθ)。`SceneBaseMap.ConvertGenshinMapCoordinatesToImageCoordinates` 为
   `image = origin − game × scale`，两个轴都翻转。因此游戏坐标中的前进方向为
   **(−cosθ, −sinθ)**。目标点 `t = p + leg × (−cosθ, −sinθ)`。
   1 个游戏单位约等于 1 米，属于近似值，靠每一段重新测量来纠正误差。
5. 分段：第一段 `leg = min(d, 25)`，**用来校验方向符号**。如果 HUD 距离下降不到 leg 的 40%，
   就停止并返回 `direction_unverified`，不再继续后面的段。之后每段 `min(d, 60)`，最多 6 段。
   每段执行前调用 `checkInput()`、复位镜头（中键），然后
   `pathingScript.run(JSON.stringify({info:{name:'AI-VTuber-travel',type:'collect',bgi_version:'0.66.0'},positions:[{id:1,x:t.x,y:t.y,type:'path',move_mode:'walk',action:''}]}))`。
6. 每段结束后重读 HUD，满足任一条件立即返回：出现 F 提示、对话或菜单（`movementStop`）；
   阶段变化；距离 ≤ 8m；距离增大；本段下降不足 3m；HUD 读数丢失；接近期限。
7. 若 d > 300m 且第 3 步定位成功，可先调用 `genshin.tp(t_far.x, t_far.y)`，
   其中 t_far 是按完整距离 d 推算的目标点。这是 BetterGI 选择最近传送点的原生能力。
   但必须遵守现有跨会话传送记忆：同一阶段同一推算点只传送一次。
8. 回执：`{kind:'quest-travel', legs:[{from,to,theta,distanceBefore,distanceAfter}], movedLegs, stopReason, verified:false}`。

**已知风险：** PathExecutor 会吞掉部分异常，返回不等于到达，必须以 HUD 距离判断。
PathExecutor 内部按键不逐键检查焦点，这一点和现有 teleport/fight 一样，只在入口检查。
PathExecutor 没有可传入的期限，需用剩余时间限制段数；超时依赖外层看门狗，回执中要写明。

**验收：**
- 单元测试：坐标换算（θ=0/90/180/270 四个方向）、第一段方向校验失败即停止、
  各种停止条件、`bearing_unavailable` 时不移动。
- 实机（由 DeepSeek 自主选择 `travel_quest`）：连续 3 次调用中，至少 2 次 HUD 距离下降 ≥ 30m。
  在 progress-evaluator 中，`movementMsSent` 和 `distance` 必须出现实质变化。

### P1 `return_world`：确定性返回主界面

新增意图 `return_world`，由原生调用 `genshin.returnMainUi()`（上游 ReturnMainUi）。
执行前后都用 `Bv.IsInMainUi` 的等价检查（`getPositionFromMap` 不抛“不在主界面”即可作为证据）。
复苏提示和特殊剧情退出框仍走现有专门分支。
在 world 之外的场景，模型可以直接选择此意图，不再需要逐帧判断 ESC。
**验收：** 实机中由菜单回到大世界只需 1 次模型调用；MENU_LOOP 告警不再出现。

### P2 对话宏 `dialogue`

在对话场景内由原生循环推进：没有选项时按 SPACE 并重读字幕；出现选项时**立即返回**，交给模型选择
（复用 `choose_dialogue` 的复核规则），也可以评估 `genshin.chooseTalkOption(option)`。
有界：最多 30 次推进或 60 秒；字幕连续 3 次不变则返回。
**验收：** 一段普通剧情对话只需 1–2 次模型调用。

### P3 节省 token、限制调用

- 每步提示词从约 1.3 万 token 降到 4 千以内：`mapAreas`（279 项）只在 `list_waypoints`
  或 `teleport` 时下发；长 rule 字符串移入 system prompt 并保证缓存命中；只保留最近 3 个原生步骤。
- 宏执行期间不调用模型。
- **验收：** 每帧 token 中位数 < 5000；`TOKEN_BURN` 告警不出现。

### P4 规则去重（可与 P3 并行）

新规则必须写在 `StoryGrounding` 里，同时供 Node 和原生使用，不要在两侧各写一份。
新增“拒绝”规则时，必须同时给出可执行的替代意图，并在测试中证明替代路径存在。
`story-main.js` 拆成模块，每个宏一个文件，构建时再拼接，不要继续单行压缩。

## 5. Claude 的监控协议

- Claude 定期运行 `node scripts/genshin/progress-evaluator.cjs`（只读），结果写入
  `runtime/genshin/progress-evaluation.json`。
- 告警：`NO_PROGRESS`、`MENU_LOOP`、`REPEATED_ACTION`、`TOKEN_BURN`、`NO_NEW_FRAMES`。
  Claude 报告给用户，并给出建议；**不启动、不停止、不操作游戏**。是否停机由用户或 Codex 决定。
- 每个任务包上线后，Codex 在本文件末尾追加：提交、测试数、实机 run id，以及评估器的前后对比。

## 6. 给 Codex 的执行顺序

1. 先停止当前会话，确认 inputReleased、processStopped 和视觉空闲（现在已是停止状态）。
2. 依次实现 P0（含测试）→ 部署 → 用导演 API 启动剧情 → 用评估器对比。
3. P0 达标后做 P1 和 P2，P3 和 P4 可以穿插进行。
4. 先把当前未提交的大量改动做一次提交作为基线，方便回退。

## 7. Codex 实施记录

### P0 代码完成，等待实机验收

- 用户重新授权按本规格实施并恢复实机；原已撤销会话保持撤销，部署后新建授权会话。
- 基线提交：`8dac4fe46a5663d112f4282d77270ccf4c4f02ca`，分支 `codex/genshin-intents-20261102`。排除 runtime、密钥和临时产物。
- 新增 `travel_quest` 的 Node 与原生接线、共享 HUD/距离规则、坐标推算和有界分段寻路；拆出 grounding、native-runner 与独立 travel 宏，构建生成独立 story-main.js。
- 已通过 94 项相关测试：travel/路由/tracking/story 39 项；焦点、反馈、deadline、续段、菜单与恢复 42 项；评估器 13 项。生成文件一致性检查通过。模拟测试不构成实机验收。
- 源码核对修正：相机方位返回度数，需转换弧度；地图定位使用 `getPositionFromMap('Teyvat',0)` 避免默认缓存；`pathingScript.run` 实际支持第二参数取消令牌，每段最多 30 秒，取消后等待退出再释放。
- 实现边界：F/菜单在段间复核，未宣称 PathExecutor 内部 10Hz 交互中断；首版未开启可选的远点估算传送。PathExecutor 未提供实际按键时长，`movementMsSent:null`、`movementTelemetryComplete:false`，路径运行时长独立记录，不冒充移动输入时长。
- 评估器按 nativeId/seq 去重，合并末步回执；新帧携带 trainingSessionId。连续三次 travel 调用必须有两次匹配同任务/阶段的独立后帧证明距离下降至少 30m，宏自身的 after 数字不单独算通过。
- 上线前对照：旧会话 57 帧 / 849941 token / 每帧中位数 14870 / 已报告移动输入 400ms / HUD 186→184m；没有 travel 调用。新的实机 run id 和结果待部署后补充。

### P0 首次实机反馈与修复

- 实现提交 `5459314`；运行 `a885a9ec-c8ad-4b9c-b569-047f9cd2d286`，训练会话 `7317260d-0dc5-4925-99f3-dfb8fa46f581`，原生 `b22dcd23-95ac-49a2-8a6b-c48ffc4e86f7`。
- 新帧确认“紧急修理 / 前去查看详情”，HUD 为 283m。DeepSeek 在第 2 步自主选择 travel_quest，两个定位采样均无模板、无独立世界距离标签，未调用 PathExecutor。独立后帧仍为 283m，P0 **未通过**。
- 维护暂停前 5 个决策帧 / 60800 token / 中位数 12150，已报告行走输入 0ms、F 0、任务阶段未变。回执为定位失败，不能把转镜或原生返回算作任务推进。
- 已保存证据到 `runtime/genshin/repair-evidence/p0-bearing-1793618500`；pause-for-repair 后核对上述 nativeId 的 inputReleased/processStopped=true，输入和视觉空闲，checkpoint revoked=false/reason=repair。
- 根因：缺标仅同视角复读两次，没有实际水平搜索。修复将保持最多 8 次转向，每次复读菜单/F/HUD/期限；仅在唯一方位对准后允许定位和路径。同时补模板加载与后备拒绝诊断。
- 穿插 P3：两份完整历史及重复规则为主要提示体积来源；只压缩模型输入，完整原始请求仍用于校验及归档。统一 travel_quest 优先级，保留失败后的有界恢复路径。
