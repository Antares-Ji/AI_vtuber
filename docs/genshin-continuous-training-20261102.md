# 持续剧情试跑与自行调试（2026-11-02）

用户已选择：继续当前剧情、重点优化寻路和 F 交互，持续至用户叫停。DeepSeek 决定游戏行动，本地视觉/OCR 观察，导演技能及原生 API 执行。主 agent 独占启动、停止和恢复，子 agent 不并发操作游戏。这里没有训练模型权重。

## 实施状态

- `continuationMode: "until_stopped"` 已实现；旧请求仍默认两小时。单段仍为 600 秒 / 40 步，导演任务上限 740 秒。
- 训练 checkpoint 保存目标、sessionId、revision、runId、nativeId、分段次数、一次临时故障恢复额度和撤销状态。重启后进入等待显式恢复，不自行启动输入。
- 用户停止、换目标、断开连接和切换供应商会撤销会话。维护暂停不撤销，但恢复需要匹配 sessionId/revision、对应原生清理回执和空闲视觉。旧回调或旧 token 不能复活已停止会话。
- 跟标和 F 失败按任务/阶段持久保存，原生 sessionId + seq 去重；每帧归档上一动作，分段结束或有回执的异常结束补齐最终步骤。传给 Node 和原生执行器的是同一份状态等价压缩证据。
- 单帧请求携带 deadlineAt；本地视觉、模型初次决策和纠错共享预算，留十秒回传余量。剩余不足十五秒不再付费纠错，预算到期返回重新观察；原生拒绝已经过期的动作。
- 模型用量与每次已返回的纠错调用 usage 保存在步骤证据中；超时未返回的计费量不能从本地推定。
- supervisor v9 新增显式 `restore_window`。恢复先取原生 mutex，核对 STOP_INPUT、唯一窗口、实际权限、取消状态，再恢复和激活。不改变观察接口的“不隐式恢复”约定。

## API 与命令

| 接口 | 行为 |
| --- | --- |
| `POST /api/genshin/story/start` | `{goal,continueSegments:true,continuationMode:"until_stopped"}` 开启新明确会话 |
| `POST /api/genshin/story/pause-for-repair` | 维护暂停、停止原生输入，保留恢复资格 |
| `POST /api/genshin/story/resume` | `{sessionId,revision}` 显式恢复已暂停会话；匹配清理回执后才启动 |
| `POST /api/genshin/stop` | 用户停止；持久撤销并停止所有当前原神技能 |
| `POST /api/genshin/window/restore` | 调用 `genshin:window-restore`，优先走 v9 已授权 helper |
| `GET /api/genshin/story/training-status` | 紧凑只读状态，含续跑、当前 run、最新步骤、最后原生回执与 helper 状态 |

`scripts/genshin/training-control.cjs` 提供 `compact/status/test/start/stop/pause/resume/restore/connect/disconnect`，统一调用导演 API。`start` 的目标明确保留当前剧情，历史“跟随骗子向导”仅供新画面核对。`connect` 可能触发正常 Windows 权限提示；不得在用户取消后自动重试。

维护时使用 `scripts/genshin/restart-console.py --preserve-story`，随后根据新 checkpoint 显式 resume。普通重启脚本仍使用用户停止语义，不应在需要续跑的维护流程中误用。

## 监督、观看与故障处理

- 网页：`http://127.0.0.1:3000/games.html?game=genshin`，预览每三秒更新。
- 连续画面：OBS 本机 `AI VTuber - Genshin Impact` 场景。未开启公开推流或新的连续录像。
- `scripts/genshin/training-monitor.cjs` 每五秒只读紧凑状态与本地视觉健康；数字参数仍表示有限次数，`until_stopped` 表示常驻。用 `node scripts/genshin/ensure-training-monitor.cjs until_stopped` 检查并复用/启动隐藏后台实例，PID 锁避免重复；聊天每分钟监督先检查此实例。仅变化追加 `events.jsonl`，`latest.json` 每轮刷新。用户撤销后要等同 nativeId 清理回执和视觉空闲才退出，不决定游戏动作。
- 当前聊天监控 automation ID：`automation`，计划每分钟唤醒。创建时为 PAUSED，需成功建立训练会话后激活；尚未运行时不能宣称持续监督已启动。
- 正常分段自动续跑；临时网络/视觉故障全会话最多自动恢复一次，必须确认对应输入释放。402、权限问题、模型主动停止、未知故障或清理不明确均不自动恢复。
- 修复顺序：保存证据 → 维护暂停 → 确认输入释放、子进程退出和视觉空闲 → 修改/测试 → 部署 → 按同一会话及目标恢复。
- 用户停止后先确认清理，再暂停聊天监控。没有用户新的明确启动请求，不得通过创建新 checkpoint 绕过撤销状态。

## 验证记录

本轮 76 项 Node 回归通过，涵盖剧情、反馈记忆、截止时间、持续会话持久化、路由、管理进程复用与解说。窗口恢复 6 项、supervisor 8 项 Python 模拟测试通过。测试没有发送游戏输入。

```text
node --test tests/genshin-story.cjs tests/genshin-story-feedback.cjs tests/genshin-story-feedback-memory.cjs tests/genshin-story-deadline.cjs tests/genshin-story-continuation.cjs tests/genshin-training-session.cjs tests/genshin-training-routes.cjs tests/genshin-story-commentary.cjs tests/genshin-bridge-reuse.cjs tests/genshin-console.cjs
runtime\vlm-env\Scripts\python.exe tests\test_genshin_bridge.py
runtime\vlm-env\Scripts\python.exe tests\test_genshin_window_restore.py
```

首次启动检查结果：

1. DeepSeek 连通成功，实际返回模型 `deepseek-flash`，本次测试共 18 tokens。供应商未切换，游戏观察仍是本地视觉。
2. 普通进程显式恢复窗口真实失败：`Game window privilege mismatch; window was not restored`。
3. 因旧 v8 helper 缺少显式恢复命令，在清理确认后关闭旧连接，通过正常 Windows UAC 请求新 v9 helper。
4. 启动 run `4f6e59b0-46f3-44cf-82d2-ef10c2f624e9` 于 `2026-11-02T09:30:40.200Z` 返回 Windows 提权被取消（1223）。没有反复请求提权；已向用户请求是否重新发起一次。

截至以上启动检查，尚未开始新剧情输入。后方目标、丢标恢复、距离停滞、唯一 F、目标变化、按后无响应等新实机场景均为“未覆盖”。不能将回归测试或历史日志回放当作本轮实机成功率。后续运行结果应追加在下方，保留这次失败记录。

## 用户重新授权后的实机启动

用户明确同意重新发起一次 Windows 权限确认。`93f59b58-fa68-4215-a70d-ef02170c2cf3` 于 `2026-11-02T09:36:28.742Z` 返回 v9 helper 就绪（PID 63120、会话 `29c1dec5-1115-48e3-9e24-1af226f37ced`）。

显式窗口恢复 run `4d9d4997-562f-4075-8156-2840983e967a` 返回 restored/focused=true、权限兼容、1920×1080 客户区、inputSent=false；对应原生回执确认 inputReleased/processStopped=true。

完成输入与视觉空闲检查后，于 `2026-11-02T09:37:10.450Z` 启动剧情 run `ec21dece-9bcb-4543-a785-ed628d6b392e`。持久训练会话 `57e30a02-03f9-48e6-ae5e-a458894b8488` 已启用 until_stopped，首段 nativeId 为 `c68ff4af-9bc4-41c5-a571-41994776dd59`，步骤证据目录 `runtime/genshin/story/e89b4a4d-6834-441e-8df1-a6bdbc6ab805`。

当前聊天监控 `automation` 已从 PAUSED 更新为 ACTIVE，每分钟唤醒；只读监控另以五秒间隔采样。本地观察与 DeepSeek 已返回首批决策，首个待处理实际场景为连接断开/账号另一处重复登录提示，模型选择确认文字；需后续帧核对是否回到剧情，尚不能宣称寻路或 F 的本轮实机验收通过。

### 首轮实机发现与维护恢复

后续原生回执与新观察确认：模型点击“确认”，之后 OCR 出现“点击进入”，模型点击进入并等待，已回到大世界并用 J 打开任务列表。实际返回模型为 `deepseek-flash`，供应商仍为 DeepSeek，没有改用云端视觉。

步骤 7 复现新版任务菜单缺少“任务专注模式”，导致菜单被标为 world、选中任务未保存；“紧急修理”分别出现在左侧列表和右侧标题，旧全屏唯一文字校验拒绝点击。模型还曾把另一行的 224m 错配给该任务。此次拒绝回执不证明存在多个同名任务。

维护暂停后确认 inputReleased/processStopped=true、视觉空闲，再补齐共享任务菜单布局识别；新增 `click_text.scope="quest_list"`，执行前重新验证菜单及左侧唯一文字；将列表距离绑定到各自行的邻近 OCR。正常全屏同名点击仍拒绝。采用真实 OCR 布局的新测试覆盖菜单漏识别、同名详情标题、区域内重复目标、执行前菜单变化及跨行距离关联；相关 38 项回归通过。

控制台维护重启复用同一 v9 helper PID 63120。以原 sessionId/revision 验证清理回执后，于 `2026-11-02T09:42:17.981Z` 恢复为第 2 段 run `ff9875e4-c313-4861-b97f-9b16f9e64478`，nativeId `76659c55-d598-4052-a12e-7fe228a20de1`，证据目录 `runtime/genshin/story/0f3d7768-7351-47d9-91ea-56c361adbd72`。这证明维护暂停和同会话恢复通路已实际运行，尚需后续帧验证新菜单规则及实际导航/交互效果。

### 第二轮：复苏提示漏识别

第二段 8 帧均有中央“严寒”、说明文字和底部唯一“复苏”，本地视觉却持续标为 world/open。模型轮换 ESC、V、300ms 移动、等待、复位及转镜，界面未变。原生回执只证明发送过移动，不能作为可走或剧情进展。

维护暂停并确认清理后，新增共享 `recoveryPrompt`：必须同时有底部中央唯一复苏按钮、中央大标题及说明布局；不根据单独“严寒”判断，也不推断全队状态。观察归类 menu，校验禁止世界按键与导航，模型仍负责决定是否点击 OCR 按钮；原生执行前再核对，防止迟到世界动作及已变界面的旧按钮点击。

31 项相关回归通过，另加原生界面变化测试通过（共 3 项 recovery 测试）。这些是回放/模拟检查，不是游戏成功。部署再次复用 helper PID 63120；同会话第 3 段 run `f4cf28c0-6586-4b78-9206-a20f0e88de49` 于 `2026-11-02T09:47:33.162Z` 启动。

第三段实际证据目录 `runtime/genshin/story/64565b2d-41b6-41c8-977e-6bb9bed0aff7`：DeepSeek 在步骤 1 选择“复苏”，原生复核后点击；下一帧变为护盾机制说明，之后本地观察回到大世界。这里只确认恢复提示已解除和界面变化，未确认剧情任务完成。

步骤 2 另外复现底部加载说明标题被 OCR 对话规则当成说话人，覆盖了本地模型原本正确的 menu 分类。再次维护暂停并确认清理，修改为：没有自动标识或回复选项时，单独“底部标题＋长文字”不能把 menu/loading 升为 dialogue；原本本地确认的对话可继续核对。加入真实 OCR 负例，33 项相关回归通过。第 4 段 run `5c1c4972-85ed-43f8-bcda-1b3cabe1e0f4` 于 `2026-11-02T09:50:00.610Z` 从同一持久会话恢复，仍复用 helper PID 63120。

第四段证据 `runtime/genshin/story/06bdd6fe-c501-4f61-995b-95449d3769e6` 记录模型调用目录传送，之后本地观察由雪地变为草地；没有目标距离或任务阶段变化，不能证明到达任务点。两轮跟标均因缺标返回且 movedMs=0，后续反馈 blocked=true 已在实机触发。模型改用转镜和重复查目录，暴露“只允许首次选任务时按 J”的指令妨碍核对追踪。维护暂停及清理后，新增 trackingEvidence，区分历史选中任务与当前 HUD 追踪证据，允许模型重新核对同一任务；不替模型选按键。API 新增 observationSeq/observationAt，避免把正在采集的新帧号当成上一条决策的序号。

相关 34 项回归通过；其中曾发现两小时默认窗口的开始与截止分别读时钟导致 1ms 测试差异，已统一基准时刻。第 5 段 run `80a83c1b-55dc-4964-ad35-4589f7b67350` 于 `2026-11-02T09:53:41.548Z` 恢复同会话。常驻五秒监控已启动，7 项独立监控测试通过。此前有限次数观察进程不再作为持续监控保障。

第 5 段 `runtime/genshin/story/9bb20fb6-ca3a-4dbe-afc7-2be05c37b165`：模型在 unconfirmed 状态自行打开任务页，当前菜单被正确识别，并选择唯一“追踪目标”。回执确认点击；模型之后返回世界并依本地目标方位进行有界转向和短移，未把历史失败跟标计数清空。此阶段还没有独立任务完成证据。

可运行 `node scripts/genshin/summarize-live-training.cjs` 生成 `runtime/genshin/training-live-summary.json`：只统计当前 checkpoint 开始后的实际记录，按 nativeId/seq 去重并合并最终回执，分别列出识别、输入回执、界面变化、两帧确认的 HUD 阶段变化及模型用量。首份汇总为 38 帧、36 个原生回执、F 发送 0、确认阶段变化 0；不计算缺少真值的识别召回率或 F 成功率。后续监督应刷新该报告，不能把其数字当固定最终结果。后方目标、距离停滞、移动途中出现 F、唯一 F、目标变化及按后无响应的新实机验收仍标为未覆盖；缺标返回、跨维护保留限制及任务菜单恢复已观察到。

### 09:57 UTC 心跳：防止恢复步骤改变任务

第 5 段步骤 11 的模型纠错以“刷新列表”为由，点击了“古云有「螭」”；步骤 12 随后点击其追踪按钮。没有“紧急修理”完成证据，不能当作正常完成后选择下一任务。主 agent 维护暂停，确认原生输入释放、进程停止和视觉空闲后修复。

新增 `story-quest-focus.js`：按持久训练 sessionId 保持任务，首次迁移取本会话开始后最早有效菜单证据，避免被最新的误切换覆盖；相同任务可刷新详情，未完成不得换任务。Node 拒绝以切换任务刷新列表、追踪另一个详情页；原生点击前再核对固定任务与当前菜单。只有模型选择 `complete_quest` 且当前非任务菜单 OCR 同时有唯一精确“任务完成”和同一任务名时，才保存完成证据并解除任务保持；该确认本身不发送输入，尚未实机覆盖。

41 项相关回归通过，包含迁移、重启保持、完成去重、模糊完成拒绝、任务切换拒绝及执行前详情变化。继续复用 helper PID 63120，第 6 段 run `541180f7-850f-4c7e-b92a-644db279af8e` 于 `2026-11-02T10:01:36.935Z` 恢复同一训练会话。五秒监控 PID 38712 一直存活；维护期间未撤销用户授权，也未新增 UAC。

第 6 段证据 `runtime/genshin/story/234844f6-2db7-4165-ac37-b40b56dfa1d0`：模型依据保持任务自行返回菜单并选回“紧急修理”，步骤 3 点击其“追踪目标”，原生复核返回已点击；未由主 agent 选择游戏按键或坐标。累计报告已刷新为 48 帧、45 个原生回执，F 发送与确认 HUD 阶段变化仍为 0。任务完成确认分支仅通过模拟测试，尚未实机覆盖。

### 停止后再次继续：追踪、地图与输入焦点修复

旧会话随后收到用户停止，checkpoint revision 29、revoked=true，nativeId `a1dc46de-5437-4c95-964e-a597ca37614c` 输入释放及进程停止已确认，视觉空闲；五秒监控以 stopped_clean 退出，聊天监控 PAUSED。用户目标再次要求“我充完deepseek的api了你请继续”后继续修复；旧撤销状态不取消，后续需明确新建会话，不用旧 token resume。

第 6 段最后几帧暴露三项问题：HUD“前去查看详情”未匹配旧阶段前缀；任务页“停止追踪”未作为已追踪证据，模型曾误取消刷新；地图总览及冒险家协会详情被识别为 world，ESC 回执未伴随退出地图证据。已加入共享前缀、当前追踪状态与地图组合布局，Node 和原生拒绝相关错误世界动作。sceneEvidence 随实际观察归档，区分 OCR 布局补正和模型判断。

原生代码审查确认 JS 按键通路未逐次检查前台。新增限定 owned story 目录与 command ID 的 `isGameActive` / `ensureGameFocus`；后者只发一次 SetForegroundWindow、等待可取消的 100ms 并复核，不恢复最小化或修改用户全局配置。JS 有输入动作前调用，按下/移动/点击前再核对前台及期限，失败关闭；keyUp 始终允许，错误和焦点检查写入 receipt。观察、等待、完成确认不激活窗口。传送/自动战斗仅在调用入口检查，其内部输入仍由 BetterGI 管理；不能将入口核验描述成内部逐键核验。

包含地图与焦点的 55 项相关回归通过；随后修正 ClearScript host delegate 的 typeof 兼容，受影响 47 项再次通过。原生 Release/x64 publish 退出码 0。专用补丁为 `scripts/genshin/patches/bettergi-chabao-b186-focus.patch`，基线 `3616fece5fda7c6e7b009247af3a72ce0c719e1a`。部署只更新 BetterGI.exe 和三个 PDB，校验 2193 个 User 文件未变，不更新 Tools。备份及 SHA 清单见 `runtime/genshin/focus-deployment.json`。

控制台重启为 PID 64992，继续复用 helper PID 63120；旧 checkpoint 仍 revoked=true（revision 30），不会自动续跑。DeepSeek 连通检查成功，实际模型 deepseek-flash，用量18 tokens。显式窗口恢复 run `3e732b53-89dc-4b5e-9ddb-3c53652e13c9` 发现可见原神窗口数为0；普通启动 run `56b4d5be-f511-40ad-a21f-ea32751f8659` 返回 WinError740。随后通过既有导演启动 API 发起一次正常 Windows 权限确认，run `bd2f8a75-e67c-4646-b3f7-66ee2ac0a505`；结果需继续核对，不能宣称已恢复剧情输入。

该启动随后返回 YuanShen.exe PID 49908、windowFound/foreground=true。窗口核对 run `c47cc188-c348-4046-9bf2-2e4757430be7` 确认控制器和游戏均已提权、权限兼容、无需恢复最小化；清理回执和空闲视觉通过。于 `2026-11-02T10:35:46.961Z` 按用户再次继续的授权新建会话 `999bd2ba-77ee-447c-826b-aa751776ccc8`，run `1b9e8c73-0547-42f2-9693-9a1eda360ad7`，nativeId `5096ce18-3e72-42d5-b7ee-4fb8d2eabb83`，证据目录 `runtime/genshin/story/afb0a68b-4984-4bac-ae6e-7f5eb71a764b`。首步 DeepSeek 选择 J；原生焦点 API 在真实 V8 环境运行，focus.before/after/ensureResult 均 true，inputChecks=1。该回执仅证明焦点检查与发送，不能证明任务菜单已打开。五秒监控 PID 33624，既有聊天 automation 恢复 ACTIVE；后续继续核对新帧。

该段随后复现特殊剧情退出框被标为 world，以及“暂时无法完成该任务”被模型误读；取消/确认均因执行前目标变化或歧义未点击，focus.inputChecks=0，不能说点击发送但无效。已保存只读诊断 `runtime/genshin/modal-diagnosis-20261102.md`。主 agent 维护暂停并确认对应 nativeId 清理及视觉空闲；用户随后明确要求“快给我继续”，因此未部署额外 modal 修复，立即恢复同一会话。此项仍是待修复，不可宣称已修好。

第 2 段 run `b3a7e40d-6b1c-44e9-be50-74330042fe3d` 于 `2026-11-02T10:39:06.875Z` 启动，nativeId `0d57f0f5-9dc1-4b49-9fab-41ef53d8fbc4`，目录 `runtime/genshin/story/e2b6b4b4-b303-4f4a-a14e-14c9b708c6cc`。首步焦点 before=false、ensureResult/after=true，实际验证了非前台到前台的原生检查通路。后续 OCR 读到186m，模型选择有界转向和跟标；步骤4跟标缺标两次、movedMs=0，故不计作位移或到达。只读监控复用 PID33624，新帧持续更新，当前没有 F 发送或确认任务阶段变化。

第 2 段步骤5发送 W400ms，之后186m→冲突185/184→一致184m，支持小幅接近约2m，不证明到达。后续多次点击“任务”实际上已打开任务页：step10被识别，step21/25有完整右侧“紧急修理/停止追踪”，但左侧“进行中”漏读、类别截字而未满足旧布局。先前监督中“尚未确认任务列表打开”是不完整状态摘要所致，应以这些逐帧证据修正，不能归因于点击坐标错误。坐标链只读审查及证据见 `runtime/genshin/click-diagnosis-20261102.md`。

另有局部菜单 OCR 让原生 guard 判 menu、观察却保留 world 的不一致。维护时新增与 guard 相同的菜单线索补正；右侧完整详情可独立识别为 menu，但列表残缺时只返回 `entries:[] / listIncomplete:true`，禁止猜残字换任务，Node 和原生均限制点击。完整任务详情优先于混入的派蒙菜单文字。目标回归21项、剧情与菜单一致性20项均通过；未扩大 F 或导航动作权限。

第2段正常结束后后端自动启动第3段 `3b0a0445-be51-43db-9ab1-46b21b5c4d9b`，native `3cf803e2-321d-4047-ae3a-057e67197ca3` 因窗口位置变化在输入前停止；对应清理及空闲视觉已确认。维护重启保持同 sessionId，revision43仍revoked=false；于 `2026-11-02T10:51:00.650Z` 恢复第4段 run `24a5bde4-9d9f-4137-80ad-141b6235b91e`。helper仍PID63120，未额外提权。特殊剧情退出框的单独识别建议尚未实施，本次仅修正已复现的任务菜单与菜单依据不一致。
