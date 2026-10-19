# v3r1 实机窗口审计：第三段

- 时间窗（UTC，左闭右开）：2026-10-12 20:30:50.020–20:31:53.877
- 工件：`output/minecraft-training/v3r1-live-trial3-start.json`、`v3r1-live-trial3-end.json`
- 验收：`output/independent-review/v3r1-trial3-acceptance.json`，由 `scripts/minecraft-live-acceptance.js` 对 autonomy/session 日志离线生成。
- 离线验收测试：`node tests/minecraft-live-acceptance.js` 通过。两份源日志在本窗内均无坏 JSON 行。
- 本审计只读日志与工件；未连接模型端点、未启动游戏动作、未使用 GPU。

**结果。** 起始工件的累计 `loop.step` 为6；本窗新增 step 7–15 共9次决策，不是新的35步试验。9个结果全部有 `used_adapter:true` 与路径 `runtime/minecraft-training/adapters/minecraft-survival-v3r1-fresh-base/checkpoint-epoch-02`。决策延迟为1.030–1.489秒。该字段是请求元数据，不构成对运行时权重或 GPU 推理的独立校验。

| Step | 动作 | 结果与日志证据 |
|---|---|---|
| 7 | eat | 失败：无安全可食物品；背包仅 rotten_flesh×2 |
| 8 | hunt×1 | 失败：应急狩猎地形不满足安全、干燥、有支撑条件 |
| 9 | flee | completed、verified；位置从(-188.5,63,2.5)到(-167.6,64,2.5) |
| 10 | flee | completed、verified；到(-146.6,67,2.3) |
| 11 | flee | completed、verified；到(-124.4,63.9,2.4) |
| 12 | eat | 失败：仍无安全可食物品，背包未变 |
| 13 | hunt×1 | 失败：附近没有可狩猎被动动物 |
| 14 | eat | 失败：仍无安全可食物品，背包未变 |
| 15 | gather_wood×4 | 失败：`Unsafe: critical health; eat or flee first` |

离线验收将3次 flee 的已验证起终点位移视为 movement progress；它们没有恢复血量，也不表示威胁已解除或生存已恢复。其余6个结果均失败，验收未确认任何物品进展。模型观察在窗口起点和末尾均报告 health=1、food=17，背包为 rotten_flesh×2；腐肉被执行器排除为安全食物。第三步 flee 后仍无食物；可见实体包括 rabbit，但没有合法猎物可用，且最近一次 hunt 已明确失败。日志不能支持“逃跑会恢复血量”或“周边必有可恢复资源”的说法。

**安全与结尾。** 本窗 session 没有 death、escape route、blocked 或 threat-cleared 事件；所以未在该段发生死亡，但因为状态观察已是1血，不能把它解释为安全窗口。验收器没有收到独立 session health trace（`minimumLoggedHealth:null`）；1血来自 autonomy 的模型状态快照。20:31:53.877 的结束工件显示累计 step 15、loop disabled/running false、末次 `gather_wood` 因 critical health 被拒绝。没有模型决策被 stale/rejected 事件拦截。

**热载、craft 与拾取。** 新 crafting protocol 的热载记录是20:30:40.157 `skills_reloaded`，在本窗开始前10秒；同时有 `defense_enabled` 记录。当前窗内没有 craft、slot0/cursor 错误、pickup 事件或拾取 skill，也没有触发新2×2 crafting protocol；因此这次窗口不能验证其实际工作。session 事件计数为 `skill_started:9`、`skill_finished:9`、`skill_failed:6`、`skill_verified:3`、`reactive_timing:7`。

本窗 sampled reactive timing 最大 tick 0.3ms、sample gap 215ms；累计最大值0.4ms、412ms；fallback overrun为0。样本量稀疏，不能推导逐 tick 延迟分布。验收 JSON 中实现哈希是报告时 checkout 状态，不等同部署时热载文件哈希。
