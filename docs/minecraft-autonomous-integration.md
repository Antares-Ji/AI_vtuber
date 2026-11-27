# Minecraft 自主通关引擎集成说明（`musekc_mc`）

本分支将完整的 Mineflayer 1.21.1 自主通关引擎（23 级科技树阶梯 + 59 个注册技能 + 确定性网格合成 + `stageLock` 卡点升级 + `stepLease` 单驾驶者租约）全量合入 `AI_vtuber`，并原生接入主播层控制契约、实况口播与统一 Skill 注册表。

## 架构目录

- `src/minecraft/autonomous/`：自主通关引擎本体（与原有 `src/minecraft/*.js` 解耦，保持所有既有测试 100% 兼容）
  - `index.js`：单账号 PID 互斥 + 断线重连监督器
  - `config.js`：环境变量与实例隔离配置，运行产物统一落盘到 gitignore 的 `runtime/minecraft-autonomous/`
  - `bot.js`：Mineflayer 1.21.1 装配、防踢/水体路由、静默失败守卫、NaN yaw/位置脱同步熔断、拒挖基岩
  - `gridcraft.js`：绕过 mineflayer#3906 的确定性 2×2 / 3×3 窗口点击合成
  - `stepLease.js` / `stageLock.js`：异步上下文单驾驶者租约 + 阶段增量卡死检测与绕行升级
  - `agent/planner.js`：23 级确定性阶梯 + 失败即 DeepSeek 反思（最多 6 步）+ 生存闸门 + 胜后停泊
  - `skills/{registry,primitives,progression,base,endgame}.js`：59 个确定性技能与 23 级阶梯（砍树 → 杀龙全链）
  - `host/bridge.js`：原生 HTTP 控制桥（`127.0.0.1:3001`，写 `logs/minecraft-control.json`），1s 缓存快照、默认 `busy:true` 单驾驶者护栏、里程碑翻转自动同步 goal
  - `server/start.js`：本地 Paper 1.21.1 服务端启动器（自动从服务端控制台下发 `gamerule keepInventory true`，无需 bot OP）
- `src/minecraft/live-context.js` & `src/minecraft/fact-speech.js`：向后兼容扩展 `state.autonomous` 核验遥测，使主播层在不抢控制权的前提下实时准确播报里程碑进展、在途阶段与通关结果
- `src/skills/providers/minecraft.js` & `skills/catalog.json`：新增只读 Skill `minecraft:autonomous-status`
- `scripts/minecraft-{doctor,server,autonomous}.js`：自检、开服、不作弊陪跑启动脚本
- `tests/minecraft-autonomous.js`：核心防回归测试（含反证用例）

## 本轮落地的关键优化与缺陷修复

1. **修复地下 `food`/死亡螺旋同步空转死循环**：
   - 新增 `runHelper()` 在调用所有前置恢复技能（`recover_surface`/`dry_escape`/`survive`/`stageLock.runUnblock`）前重新装配 `_stepDeadline`，消除因上一步 `expireStepDeadline()` 遗留 `1` 导致 `climbOut` 毫秒级空返的问题；
   - `survive()` 新增按原因分类冷却与位移/血量增量校验，地下干洞穴无僵尸时不再反复调用无效的被动动物打猎；
   - 主循环增加最低步频底线，杜绝无 `await` 同步空转。
2. **修复服务端 `keepInventory` 静默失效**：
   - Paper/原版忽略 `server.properties` 中的 `keepInventory=true`，改为由 `server/start.js` 在开服 `Done` 后直接向服务端 stdin 控制台下发 `gamerule keepInventory true`，在保持 `MC_NO_SELF_OP=1`（bot 绝非 OP）的前提下真正生效。
3. **修复 23/23 通关后无限重规划 `kill_dragon` 空转**：
   - 新增 `handleVictory()`，通关后一次性落盘 `victory.json`、推送核验事件并转入低功耗待机。
4. **修复 `MC_TALK` 单一发声与服务端广播自回声**：
   - `attachChat()` 仅响应 `<Player> ...` 真人聊天，不再对成就广播/登录提示/死亡播报触发 LLM 回复；
   - `MC_TALK=host` 模式下计划与里程碑播报仅走日志与主播桥，不与主播层双重发声。
5. **补齐根目录 MCP 依赖**：将 `@modelcontextprotocol/client`、`@modelcontextprotocol/server`、`zod` 及 Mineflayer 插件依赖纳入根 `package.json`。

## 快速使用

```bash
npm run minecraft:doctor          # 依赖、59 技能、23 阶梯与桥接自检
npm run test:minecraft:autonomous # 自主通关引擎核心回归测试
npm run minecraft:server          # 起全新随机种子 Paper 1.21.1 服（25568，bot 非 OP，仅服务端开死亡不掉落）
npm run start:server              # 起 AI_vtuber 主播服务（3000）
npm run minecraft:autonomous      # 起不作弊自主通关 bot（自动接入 3001 控制桥与 3000 主播层）
```
