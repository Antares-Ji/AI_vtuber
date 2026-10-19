# v3r1 实机窗口审计：第二段

- 时间窗（UTC，左闭右开）：2026-10-12 20:18:39.970–20:22:46.770
- 工件：`output/minecraft-training/v3r1-live-trial2-start.json`、`v3r1-live-trial2-end.json`
- 验收：`output/independent-review/v3r1-trial2-acceptance.json`，由 `scripts/minecraft-live-acceptance.js` 对 autonomy/session 日志离线生成。
- 离线验收测试：`node tests/minecraft-live-acceptance.js` 通过。两份源日志在本窗内均无坏 JSON 行。
- 本审计只读日志与工件；未连接模型端点、未启动游戏动作、未使用 GPU。

**结果。** 窗口内有6次模型决策和6个对应执行结果，全部为 craft 且全部失败；没有成功或经库存证据确认的进展。每次决策及结果的 `modelMetadata` 都是 `used_adapter:true`，adapter 路径为 `runtime/minecraft-training/adapters/minecraft-survival-v3r1-fresh-base/checkpoint-epoch-02`。决策延迟依次为1.606、1.721、1.619、1.764、1.826、1.768秒。这个日志元数据支持“本窗请求声称使用 adapter”；它本身不是对 GPU 上模型权重或运行时加载状态的独立测量。

| Step / task | 模型动作 | 执行结果 |
|---|---|---|
| 1 / `3be93a33…` | craft planks×4 | `updateSlot:0` 20秒超时；失败 |
| 2 / `540dfa04…` | craft stick×8 | `crafted batch inventory: server verification failed` |
| 3 / `ced63506…` | craft stick×8 | `updateSlot:0` 20秒超时 |
| 4 / `6fa4158d…` | craft stick×6 | server verification failed |
| 5 / `b882e15f…` | craft stick×4 | `updateSlot:0` 20秒超时 |
| 6 / `35843793…` | craft stick×8 | server verification failed |

6次 `skill_failed`/`skill_finished` 均有 session 记录。autonomy 结果事件没有携带执行器本地 `result.inventoryBefore/After`，验收器只能看到外围观察前后快照，因此把6次都判为未验证、未佐证。快照显示过 spruce_planks -2、stick 从26消失或重新出现，以及第一次 spruce_log -1/planks +26；这些观察跨越失败处理与后续异步同步，不能用来确认净产量、物品销毁或 cursor 中残留。日志也没有记录 cursor / open-window 槽位状态，故 slot0 超时可证实，cursor 根因不可证实。

**协议与拾取。** 窗内发生的 craft 请求均是旧批量 craft 结果路径；3次明确等候 `updateSlot:0` 超时，另3次服务器库存校验失败。没有 `pickup` 事件或拾取 skill；reactive observation 里出现过附近 `item` entity，但这不是已拾取证据。新增的2×2 crafting/protocol 热载发生在第三段开始前（20:30:40.157），不属于本窗，也没有在本窗被执行。

**安全事件。** 窗内记录1次死亡：20:22:22.746，lifecycle epoch 4；自动防卫随后恢复。死亡前血量日志最低2.167。该窗有19次 escape short-route、2次 blocked、2次 threat-cleared；其中连续出现 `escape_no_progress` / `escape_no_separation_progress`，并在20:22:20.744记录 trapped counterattack，20:22:21.569血量2.167，随后死亡。自动防卫有运行和成功清威胁的记录，但路线未始终拉开距离，不能据“发出路线”认定逃脱成功。死亡后有重生与继续反射事件；20:22:46.770 的 loop end 工件显示 loop disabled/running false、step 6。20:22:55.758 的另一次死亡晚于该窗，不计入此段。

本窗 reactive timing 抽样最大 tick 14.5ms、sample gap 215.1ms；累计最大值分别32.7ms、329ms；fallback overrun为0。这里是日志采样而非逐 tick 性能保证。

实施文件的报告时 checkout 哈希见验收 JSON；它们不是运行时热载哈希。明确可定位的窗口内热载为20:21:10.344 `skills_reloaded`，此前后反射继续运行；不能从事件本身断定被热载文件的部署哈希。loop stop、技能失败、死亡均来自原始窗口事件。
