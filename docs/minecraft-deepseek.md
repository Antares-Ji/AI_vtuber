# DeepSeek API 驱动 Mineflayer

游戏决策链路：Mineflayer 读取真实状态 → DeepSeek 返回一个结构化动作 → 程序校验动作与状态 → Mineflayer 执行 → 读取结果供下一轮规划。游戏控制不需要启动本地 Qwen 4B。

## 接入

1. 启动主服务，打开 `http://127.0.0.1:3000/minecraft.html`。
2. 游戏控制方案选择「DeepSeek API 玩游戏」，填写 DeepSeek API Key 并保存。留空保存会保留已有密钥。
3. 点击「检查 DeepSeek 连接」。该检查调用一次 API，只允许返回观察动作，不操作游戏。
4. Minecraft Java 世界开放局域网，使用原有 Mineflayer 连接流程；面板确认游戏已连接后，输入目标或开启自主循环。

命令行入口：`npm run minecraft:command -- "采集木头并制作工作台"`，使用主服务中所选游戏引擎。旧的 `scripts/minecraft-qwen.js` 是该入口的兼容别名；MCP 的 `run-qwen.cjs` 和长时运行脚本同样读取游戏引擎配置，不再固定调用本地 Qwen。

面板密钥只保存在 Git 忽略的 `data/minecraft-engine.local.json` 的 `deepseekApiKey` 字段，不进入网页持久存储、公开状态或请求日志。各供应商密钥独立保存。

也可以在 `.env.local` 配置以下字段，修改后重启主服务：

```dotenv
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

密钥优先级：面板保存的游戏专用密钥 → `DEEPSEEK_API_KEY` → 旧 `OPENAI_API_KEY` 配置。复用旧配置时，其地址必须是官方 DeepSeek 地址；使用专用密钥时不继承其他供应商的聊天地址或模型。新专用配置默认 `deepseek-flash`，可用 `DEEPSEEK_MODEL` 指定模型。

聊天、主播口播和语音是独立配置；游戏改为 API 后，原有互动仍可能使用本地千问。固定的「查看状态」「自动防卫」「停止」直接走程序，不等待模型。游戏规划失败不会回退到本地 4B。

## 验证与边界

运行 `npm run test:minecraft:api`，覆盖专用密钥、请求格式、API 动作传递、过期决策拒绝、取消任务和供应商兼容性。测试使用模拟 API 和游戏状态；真实 API 连通性与真实游戏执行需另行验证。

API 使用官方 Chat Completions 与 JSON 输出格式：[首次调用](https://api-docs.deepseek.com/)、[JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)。不执行模型生成的任意代码；响应不完整、格式错误或不符合动作合同就拒绝执行。

实机排障：避险层对8格以外的怪物检查两条身体视线；仅当两条视线均被完整方块阻隔时，不再因此取消规划任务。近距离、骑乘怪物、视线开放或未知时仍沿用原来的避险处理。原始实体继续保留在诊断中。`tests/minecraft-occluded-threats.js` 覆盖这项行为。

本轮实机证据保存在本地 `logs/minecraft-deepseek-live-run.json`、自主日志和每3秒采样中。已核验 DeepSeek 决策、从低洼处回到地表、原木入库及制作木剑；不表示整栋房屋或全部动作已经验收。OBS 虚拟摄像头和网页视频已连接，玩家客户端仍显示菜单，机器人旁观画面尚未验收。
