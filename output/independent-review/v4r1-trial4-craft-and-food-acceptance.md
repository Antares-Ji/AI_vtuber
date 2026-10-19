# v4r1 trial4：进食、采集与 2×2 制作独立验收

## 范围与来源

本记录是只读日志核对，时间均为 UTC。交叉来源：

- `logs/minecraft-session-1791830191222.jsonl`（session 事件、库存变化、原生 inventory/window 快照与逐点击诊断）
- `logs/minecraft-autonomy.jsonl`（模型 step、决策、推理耗时、adapter 元数据与 action result）

未操作游戏、未调用 GPU、未改源码。验证范围限于下述实际事件；不代表整个 craft 或采集实现已通过全面测试。

## trial4 证据链

### 进食兔肉：真实消耗并增加 food

- 模型 step 23 于 `21:15:59.160Z` 选择 `eat`；推理耗时 `1184 ms`，元数据 `used_adapter: true`。
- session 在 `21:15:59.329Z` 开始 task `36bc2483-6e00-4835-9121-97b50b162d34`；`21:16:01.047Z` 记录 `skill_verified`，并于 `21:16:01.048Z` 完成。
- 验证结果：food `16 → 19`，rabbit `1 → 0`；`rabbit_hide:1` 与 `gravel:4` 保持不变，位置 `(24.5, 67, 160.3)`。
- autonomy 于 `21:16:01.372Z` 收到 completed/verified 结果。session 与 autonomy 的库存和 food 结果一致。

### gather_wood 4：失败，但确认部分获得 1 个

- 模型 step 26 于 `21:16:25.879Z` 选择 `gather_wood(count=4)`；推理耗时 `1813 ms`，`used_adapter: true`。
- task `06013854-e2e0-4823-b13c-700b6cdc7b26` 于 `21:16:26.051Z` 开始；目标 oak log 坐标 `(19,72,163)`。`21:16:30.517Z` 日志出现与挖掘后新出现的 oak_log 掉落相符的拾取路线。
- `21:16:31.562Z` 记录实体对应的 inventory gain `+1`，但事件明确标注 `inventory delta only; individual drop origin not proven`。
- 因 `dig: timeout` 于 `21:16:46.580Z` 失败；session 的 `partialResult` 是 `verifiedPartial:true, gained:1, complete:false`。库存从没有 oak_log 变为 `oak_log:1`。autonomy 于 `21:16:46.998Z` 同样记录 failed，并保留已确认部分结果。
- 结论：这不是 gather 4 成功；可确认任务失败时库存多了 1 个 oak_log。单个物品掉落来源未被证明。

### 制作 oak_planks 4：库存守恒，逐点击全窗确认

- 模型 step 27 于 `21:16:54.061Z` 选择 `craft(planks,count=4)`；推理耗时 `1888 ms`。autonomy 于 `21:16:54.694Z` 收到 completed 结果。
- session task `5b2ae934-a9a2-4958-9082-fa3360f9f956` 于 `21:16:54.225Z` 开始。结果明确 `inventoryConfirmation: server_full_window_per_click`、`verified:true`。
- 库存：`oak_log:1 → 0`，`oak_planks:0 → 4`；rabbit_hide 与 gravel 保持不变。
- 原生 `windowId:0` 的 stateId 快照连续为 **10–17**；逐点击对账序号 **1–5**：`initial`、`click:36:0`、`click:1:1`、`click:0:0`、`click:9:0`。
- 快照显示：36 号库存槽的 oak_log 被拿到 cursor；放入 2×2 crafting grid 的 slot 1 后，slot 0 显示 oak_planks 4；取出产物后，输入格清空，planks 进入背包，最终 cursor 清空。task 前后库存快照与配方产出一致，没有发现日志中虚构的库存增量。

### 第一次制作 stick 4：2×2 格内两块木板，cursor 和产出逐步对账

- 模型 step 28 于 `21:16:58.068Z` 选择 `craft(stick,count=4)`；推理耗时 `1700 ms`。autonomy 于 `21:16:59.026Z` 收到 completed 结果。
- session task `1e2bd6d8-3331-47bb-a676-aee6d1799a2c` 于 `21:16:58.238Z` 开始；确认类型为 `server_full_window_per_click`，`verified:true`。
- 库存：`oak_planks:4 → 2`，`stick:0 → 4`，其他所列物品不变。
- `windowId:0` stateId 连续为 **18–32**；逐点击对账序号 **1–9**，动作阶段依序为：`initial`、`click:9:0`、`click:1:1`、`click:9:0`、`click:9:0`、`click:3:1`、`click:9:0`、`click:0:0`、`click:10:0`。
- slot 1 放入第一块木板时，服务端快照短暂显示 `oak_button` 于结果 slot 0；没有取走此临时结果。放入 slot 3 的第二块木板后，slot 0 转为 `stick:4`。全窗快照记录两个输入格（slot 1、3）、结果 slot 0、cursor、以及随后输入格清空/cursor 中 sticks 被放入背包。最终库存只增加 4 根 sticks，消耗 2 块 planks；日志未显示 oak_button 进入玩家库存。

### 第二次制作 stick 4：操作守恒，但不能当作有效目标进展

- 模型 step 29 于 `21:17:02.436Z` 再次选择 `craft(stick,count=4)`；推理耗时 `1739 ms`。autonomy 于 `21:17:03.406Z` 收到 completed 结果。
- session task `e2693bb5-b9e0-4904-aaf0-30484848e8ca` 于 `21:17:02.614Z` 开始；`server_full_window_per_click`，`verified:true`。
- 库存：制作前 `oak_planks:2, stick:4`；制作后 `oak_planks:0, stick:8`。每次为 2×2 grid slot 1、3 各放 1 块，slot 0 显示 stick 4；清空两输入格后将 4 根 sticks 放入背包，cursor 清空。
- `windowId:0` stateId 连续为 **33–46**；逐点击对账序号 **1–8**：`initial`、`click:9:0`、`click:1:1`、`click:9:0`、`click:9:0`、`click:3:1`、`click:0:0`、`click:10:0`。
- 配方数量守恒：消耗最后 2 块 planks，产出 4 sticks，最终 sticks 总数 8。日志没有记录这些额外 sticks 的明确用途；因此这里只确认制作协议和库存守恒，**不将第二次制作视为目标有意义的进展或 craft 修复成功的充分证据**。

### 再次 gather_wood 4：完整数量确认

- 模型 step 30 于 `21:17:06.691Z` 选择 `gather_wood(count=4)`；推理耗时 `1584 ms`。
- task `981bd487-8016-4730-ab5e-5d1727465bed` 于 `21:17:06.875Z` 开始；过程中有多个候选木头、路径预检与拾取事件。4 次 inventory gain 均是库存差量证据，日志对单个掉落来源保持未证明说明。
- session 于 `21:17:27.693Z` 记录 `verified:true, gained:4, requested:4, complete:true, dug:4`；库存从没有 oak_log 变为 `oak_log:4`，stick 仍为 8。autonomy 于 `21:17:28.158Z` 收到 completed 结果。
- 结论：该次任务的目标数量与库存增量相符；不能从差量日志证明每个特定掉落实体的单独来源。

## 旧遭遇窗口独立快照（21:01:30–21:06:52.538Z）

本段与上面的 trial4 证据链分开。只表示日志在该时间截点的情况，不声称整个后续 session 已结束。

- 在 session `1791830191222` 中，21:01:30 起至截点共记录 `escape_short_route:171`、`escape_no_separation_progress:19`、`escape_blocked:6`、`threat_cleared:9`。9 个 threat_cleared 是单个目标状态变化，均不能证明 kill 或清空附近威胁。
- 截点前没有该窗口内的 `death`、`respawn`、`disconnect` 或 `server_message` 记录。最后一个伤害快照是 `21:03:05.645Z`，health `12 → 5.177`、food 17；之后至该截点没有新 damage snapshot，采样的 health 仍为 5.177。
- 截点附近仍在发生短路线和 separation stall：`21:06:52.538Z escape_no_separation_progress`，位置约 `(33.44,70,172.44)`，分离约 19.65。它说明逃生仍未见结束证据，不能判作成功。
- 该截点内 timing 抽样最高 `tickMs=662.9 ms`、最高记录 `maxSampleGapMs=861.6 ms`，`fallbackOverruns=0`。
- autonomy 的 `step36` 在 `21:06:16.822Z` 因僵尸在约 18.7 格而使 `hunt` 失败；`step37` 于 `21:06:23.388Z` 选择 `flee`。虽有 `used_adapter:true`，同时存在反射逃生和任务中止，不能把实际逃生路线归因于模型。

## 验收结论与边界

日志支持以下有限结论：rabbit 真实消耗且 food 上升；一次木材采集超时但确认部分获得 1 个；planks 与两次 sticks 制作都得到逐点击有序全窗快照，slot/cursor 后置状态和 inventory delta 符合实际配方数量；后续一次 gather_wood 数量 4 达到 verified complete。该记录不证明天然坡采集修复条件实际被触发，不证明所有配方、取消/重连/延迟包情形均已修复，也不把额外 sticks 制作视作策略进展。
