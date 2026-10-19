# Minecraft 扩展能力与验证边界

本清单由当前动作 Schema 生成，共 75 种动作，全部默认注册；数量指项目动作，不是 Mineflayer 全部 JavaScript 方法数。

普通和避险寻路启用挖掘、垫块、跳跃与原生下降能力，移除项目额外的涉水、采集路径挖掘/放置/跳跃及血量硬拒绝；模型提示中旧的禁止坐标、聊天和追击要求已移除。保留任务互斥、取消、参数校验与真实结果验证。

## 动作及参数

- `chat_message`: text
- `whisper_message`: username, text
- `chat_complete`: text
- `wait_message`: contains, timeoutMs
- `resource_pack_response`: response
- `client_settings`: locale, viewDistance, chat, mainHand, colorsEnabled, enableTextFiltering, enableServerListing, particleStatus, skinPartsMask
- `activate_entity_at`: entityId, x, y, z
- `window_transaction`: target, x, y, z, entityId, operationsJson
- `respawn`: 
- `creative_set_slot`: slot, item, count
- `creative_clear_slot`: slot
- `creative_clear_inventory`: 
- `creative_start_flying`: 
- `creative_stop_flying`: 
- `creative_fly_to`: x, y, z
- `look_at`: x, y, z
- `move_controls`: control, durationMs
- `move_vehicle`: left, forward, durationMs
- `elytra_fly`: 
- `swing_arm`: 
- `unequip_item`: destination
- `select_hotbar`: slot
- `toss_item`: item, count
- `use_on_entity`: entityId, item
- `place_entity`: x, y, z, item, face
- `write_sign`: x, y, z, text, side
- `write_book`: slot, pagesJson
- `sign_book`: slot, pagesJson, author, title
- `find_blocks`: name, radius, count
- `inspect_block`: x, y, z
- `inspect_inventory`: 
- `inspect_entities`: 
- `inspect_recipes`: item
- `furnace_inspect`: x, y, z
- `furnace_take`: x, y, z, slot
- `window_click`: x, y, z, slot, button, mode
- `wait_ticks`: ticks
- `navigate`: x, y, z
- `dig_block`: x, y, z
- `place_block`: x, y, z, item
- `attack_entity`: entityId
- `sleep`: x, y, z
- `wake`: 
- `container_inspect`: x, y, z
- `container_transfer`: x, y, z, direction, item, count
- `inventory_move`: fromSlot, toSlot
- `equip_item`: item, destination
- `use_item`: item, durationMs
- `activate_block`: x, y, z
- `activate_entity`: entityId
- `fish`: 
- `mount`: entityId
- `dismount`: 
- `trade_inspect`: entityId
- `trade`: entityId, index, count
- `enchant`: x, y, z, item, choice
- `anvil`: x, y, z, item, secondItem, name
- `smelt_item`: x, y, z, item, fuel, count, fuelCount
- `consume_item`: item
- `observe`: 
- `eat`: 
- `flee`: 
- `build_portal`: 
- `enter_portal`: 
- `collect_water`: 
- `place_water`: 
- `dig_staircase`: direction, steps
- `explore`: direction, distance
- `gather_wood`: count
- `craft`: item, count
- `mine`: resource, count
- `smelt`: item, count
- `hunt`: count, animal
- `build_home`: count
- `furnish_home`: item

## 新接口语义

- window_transaction 在同一个窗口内执行 1–32 个操作，支持 click（原生模式 0–6）、move、put_away、put_selected、transfer，执行后关闭窗口。操作范围按实际窗口槽位校验。
- 创造接口只在服务器已将 bot 设为 creative 时执行，不自动切换模式。当前小家目标仍按生存规则推进，不给物品、不发作弊命令。
- resource_pack_response 调用 Mineflayer 的接受/拒绝协议响应；Mineflayer 不会因此下载、渲染资源包纹理。
- chat_message 是游戏聊天文本，不是管理员命令入口。respawn 可在死亡时调用；原生自动重生仍保留。
- EventEmitter、插件加载、原始协议、私有方法、连接销毁、聊天正则监听器配置不作为千问游戏动作。命令方块管理员编辑没有封装；不能据此声称整个库所有 API 都已开放。

## 验证

已通过扩展动作与原生接口测试，覆盖参数、寻路开关、到达检查、战斗击杀证据、窗口操作与取消清理、创造模式条件、客户端设置和资源包响应分支；MCP stdio 集成测试通过。模拟测试通过不等于全部动作都已实机成功；钓鱼、交易、附魔、创造接口等需要对应世界条件。

在线注册数量可从认证控制端 /capabilities 查询。四十分钟轮次已于2026-10-18 14:04:05 UTC结束。用户随后明确授权持续运行直到STOP；当前untilStopped=true、deadline=null。用户STOP优先，停止主循环与主动任务、保留连接和安全层，并暂停监督，停止后不得自动恢复。不录屏。
