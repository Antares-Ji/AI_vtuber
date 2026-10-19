# v4r1 trial5：死亡、反射逃生與重生后恢复独立验收

## 范围与来源

本报告只读核对日志时间均为 UTC（日期 2026-10-12）。trial5 窗口：`21:26:13.676–21:29:16.109Z`。来源：

- `logs/minecraft-session-1791830191222.jsonl`：reactive/session/native skill 事件、server message、死亡及 timing 采样。
- `logs/minecraft-autonomy.jsonl`：Qwen 决策、实际 action result、推理 latency 与 adapter 使用元数据。
- `logs/minecraft-loop-state.json`：停止后持久化的 loop 状态/history。

没有操作游戏、运行 GPU 或重启服务。session 日志当前可读尾部到 `21:48:36.224Z`；其后状态由 root 提供的最新 `/observe` 补充，并单独标注。

## 死亡前轨迹与伤害

### 初始状态与寻路失败

- 首个模型决策 step 1：`21:26:15.808Z`，Qwen 选择 `explore(south,20)`；推理耗时 1825 ms，`modelMetadata.used_adapter:true`。
- 该次模型观察：HP `8.177`、food `16`、位置 `(43.4,66,213.3)`；背包为 `stick:10, oak_planks:7, wooden_pickaxe:1, rabbit_hide:1, gravel:4`。该 observation 的 threats 是空数组；这只是这一时点的一次模型快照。
- native task `18adc226-479a-43ea-859e-7b64cd458248` 于 `21:26:16.119Z` 开始；`21:26:21.181Z` 报 `Took to long to decide path to goal!`，21:26:21.183Z 以 failed 结束。库存保持不变。autonomy 在 `21:26:21.631Z` 记录同一 task 失败。后续 step 2 observation 已位于 `(48.4,63,226.4)`，所以路径任务过程中 bot 的位置快照有改变；无 `skill_verified` 证明这次探索完成。

### zombie / skeleton 轮换追击，模型 flee 连续被反射优先级打断

- Step 2 (`21:26:27.983Z`) 选择 `flee`，观察到 zombie id 43587 距离 15.3。native flee task `599ade8b-5f7f-4cd5-afc0-6d690feb74d9` 于 `21:26:28.124Z` 开始；`21:26:28.337Z` 被 reactive `task_preempted`，当时僵尸距 11.70，action 随即 aborted/cancelled。`21:26:28.569Z` safety priority 为 flee/zombie。
- 接着 reactive 在 `21:26:33.048Z`、`:34.902Z`、`:36.260Z` 记录短路线：bot 从约 `(36.63,67,214.52)` 到 `(30.5,68,208.5)` 再到 `(26.5,69,204.5)`；所记录 currentSeparation 由 14.89 增至 19.44、22.24，路线 clearance 分别 16.59、21.03、23.19。这段确有朝路线目标移动且分离增加的证据。`21:26:37.793Z threat_cleared` 的 `killVerified:false` 仅是目标状态清除，不等价于确认击杀或周围安全。
- Step 3 (`21:26:40.372Z`) 又选择 flee；观察到 skeleton id 43398 距离 23.6。task `3718ce54-d37a-462a-9c73-cce5621b8cce` 在 `21:26:40.615Z` 开始，`21:26:44.469Z` 被同一 skeleton（距 23.62）抢占并取消；reactive 于 `21:26:44.670Z` 选 skeleton。`21:26:47.114Z` target cleared 仍为 `killVerified:false`。
- Step 4 (`21:26:51.330Z`) 仍选择 flee；模型观察位置 `(5.5,73,199.4)`，zombie id 43587 距离 23.6。task `a99c287d-50ee-45a9-b55a-ea8932e98744` 于 `21:26:51.512Z` 开始，`:51.719Z` 再被反射抢占而取消；`:52.003Z` 反射仍选 skeleton，`:52.213Z` 又切回 zombie。三个模型 flee 均没有记录为完成，均被优先级层取消。

### 近身受困与死亡

- reactive 从 `21:26:53.638Z` 起又向短路线移动，bot 位置约 `(4.54,73,200.34)`，记录分离 16.60、预期 22.39。随后位置停在 `(2.28–2.30,73,200.71–200.75)` 附近，反复尝试 route edge `(2,73,200)->(1,73,199)`；路线使用 `reusedStalledEdge:true`。至 `21:27:00.720Z` currentSeparation 已降为 4.35，separation objective 10.13。
- 同位置周围的原始 terrain 快照显示：朝西相邻格 feet/head 都是 oak_log；其他方向是 leaf_litter。`21:27:02.387Z escape_blocked` 记录 zombie 在约 0.966 格、`triedSites:5`、`leavesCleared:0`、`noPathCount:0`；所以日志显示的是路线受阻/位移无进展，并非 planner 明确计数为无路径。
- HP 伤害时间链（food 均为16，position 都约 `(2.3,73,200.73)`，source 记录为 unknown；server_message 单独识别凶手）：

| UTC | HP 变化 | Zombie 距离 |
|---|---:|---:|
| 21:27:02.045 | 8.177 → 5.177 | 1.467 |
| 21:27:03.092 | 5.177 → 2.177 | 1.596 |
| 21:27:03.946 | 2.177 → 0 | 0.910 |

- `21:27:03.945Z` server message：`SuiGeBot was slain by Zombie`；`21:27:03.947Z` death event，`lifecycleEpoch:8, safetyWillResume:true`。就本窗口证据而言，死亡紧接于僵尸贴身、逃生路线近 10 秒未能增加分离之后；damageSource 未知，但服务器死亡消息确认被 Zombie 击杀。
- trial5 期间反射 timing 共18个样本：最大 `tickMs=52.3 ms`、累计最大 `maxSampleGapMs=466.9 ms`、`maxFallbackMs=50.2 ms`（预算60 ms），`fallbackOverruns=0`、`skippedTicks=0`。这些是抽样与上限字段，不表示每一帧延迟；没有看到本窗口内反射计时超预算。

## 重生、模型任务与物资变化

- `21:27:04.003Z` session status 位置 `(18.5,66,7.5)`、survival；step 5 observation 在 `21:27:24.421Z` 已为 HP20/food20、inventory 空、tools/equipment 空、threats 空。与 pre-death `wooden_pickaxe:1`、`oak_planks:7`、`stick:10` 等 inventory 对照，重生后的活动背包不再包含这些物品。库存日志不能证明它们被销毁或世界掉落物不可追回；root 最新 `/observe` 显示当前 inventory 仅 `spruce_log:1`。
- trial 窗口内 Qwen 共16个 decision，延迟范围 `1184–2157 ms`，16个都带 `used_adapter:true`。15条 `model_action_result` 统计为 **completed 10、failed 2、cancelled 3**：
  - Failed：step 1 explore 路径决策超时；step 9 `gather_wood(4)` 因 search budget/timeout、可达性未确认、inventory gain 0 失败。
  - Cancelled：step 2–4 的 flee 均被 reactive 目标优先级抢占。
  - Completed 10：全部是重生后的 explore（step 5–8、10–15），均带 verified movement，但没有物资增量；移动只证明这些短探索任务完成，不等于恢复物资或完成生存目标。
- Step 16 于 `21:28:52.311Z` 选择 `gather_wood(4)`，model latency 1800 ms、`used_adapter:true`；native task `46439ca5-7710-4a39-8e6c-9668dd6abf11` 于 `21:28:52.559Z` 开始。`21:28:59.587Z` 记录一项 inventory gain after pickup；随后在 loop stop 时任务被取消：`21:29:16.105Z` skill_failed/aborted，库存 `inventoryBefore:[]`、`inventoryAfter:[spruce_log:1]`；`:16.106Z` skill_finished status cancelled。loop 于 `21:29:16.105Z` 记录 `loop_stop_requested`、`:16.107Z` `loop_finished`。没有 step 16 对应的 autonomy `model_action_result`；因此模型 action-result 统计中只有前述15条，另有这一条 native cancellation 证据，不能把它记成 gather 成功或已验证部分完成。
- `logs/minecraft-loop-state.json` 当前快照为 `enabled:false,running:false,step:16`；说明模型 loop 已停止。root 的最新 `/observe` 报 HP20、food20、lifecycle8、背包仅 `spruce_log:1`。

## 窗口后至 session 当前日志尾

session 文件尾部时间为 `21:48:36.224Z`。从 trial 截点后至该尾部：

- session 没有第二条 death event；lifecycle 8 的重生状态没有在日志中再被死亡覆盖。
- loop 已关闭；session 继续出现 reactive escape/timing 事件，表示 reactive 层仍在运行。截点后另记录 `21:43:00.694Z` 受 zombie 命中：HP `20 → 17`、food20，位置约 `(46.51,71,-78.63)`，zombie 距离1.695。root 最新 `/observe` 又显示 HP20/food20；其查询时点没有记录在日志文件内，故只以 root 现场观察陈述当前值。
- session 截点后记录59个 `escape_short_route`、1个 `escape_blocked`，以及7个 `threat_cleared`（这些单目标事件不证明附近无威胁）。`:42:35.917` 的 blocked 快照中同时有 zombie 13.89、creeper 13.95、skeleton 15.27 格；日志尾前 `21:47:55.975` 的另一个 blocked 快照有 skeleton/creeper/skeleton 约17.92/17.98/19.81格。说明后续仍经历多敌人追击，不应用 target-cleared 事件宣称清场。
- 截点后116个 timing 采样，最高 `maxTickMs=193 ms`、`maxSampleGapMs=504.3 ms`、`maxFallbackMs=73.8 ms`（超过60 ms预算）；累计 `fallbackOverruns` 于 `21:42:49.980Z` 达到1并在后续样本维持1，`skippedTicks` 最大仍为0。该超预算记录发生在死亡之后很久，不是死亡前窗口的计时证据。

## 结论与限制

trial5 是一次真实死亡：僵尸贴身、路线分离停滞、近身伤害后被服务器确认 slain；生命 epoch 从7变成8。重生后背包为空，稍后的 `gather_wood(4)` 只在取消时留下 spruce_log 1，loop 已停止。模型的15条已落盘 action result 为10完成、2失败、3取消，另有 step16 native gather 取消但未生成 autonomy result。

日志不足以证明死亡后原工具/材料的物理掉落位置或能否取回，也不能把逃生路线归功于 Qwen：三次模型 flee 被 reactive 抢占，而死亡前的位置、路线和伤害同时受 reactive 层控制。死亡前 timing 没记录超预算；trial 后的反射时延则出现过一次累计超预算。该窗口证据显示系统有真实失败，不是只看模型输出的成功率。
