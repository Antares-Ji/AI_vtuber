> 历史方案：当前已选择官方 Astra 阶段规划＋本地千问互动，无需 JEV 或 OpenRouter。请参阅 [当前配置](minecraft-astra-qwen-streamer.md)。

# 方案二：GPT Astra + JEV

入口：主直播台、调试直播台、导演工作台的 **Minecraft · Astra + JEV** 链接，或 `http://127.0.0.1:3000/minecraft.html`。

## 本机配置

1. 在“游戏控制方案”选择“方案二 · GPT Astra + JEV”。
2. 填入自己的 OpenRouter API Key，保存配置。也支持服务端环境变量 `OPENROUTER_API_KEY`；不会把项目其他用途的 `OPENAI_API_KEY` 当作 OpenRouter 密钥。
3. 点击“检查两模型连接”。它执行 Astra 规划与 JEV 决策的真实 API 请求，但只允许观察候选，不提交 Minecraft 动作。该检查产生 API 用量。
4. 启动已有 Minecraft Java 世界，对局域网开放，使用本次实际端口启动项目的 `scripts/minecraft-session.js`（已有会话要先核对，不能重复同名登录）。复用原账号及生存世界，不依赖参考项目的专用种子和固定路线。
5. 顶部确认游戏已连接后，在“游戏目标”提交目标，或使用“做工作台 / 做铁镐”。默认每次运行最多15分钟；可随时“停止游戏任务”。

密钥保存在服务端 `data/minecraft-engine.local.json`，该文件及临时文件已加入 Git 忽略；它是本机明文配置，请勿上传或分享。读取接口仅返回是否已配置，不回传密钥；密码框留空表示保留现有密钥。配置管理接口只接受本机访问和同源浏览器请求。模型测试不会证明游戏已连接。

## 控制链与验证边界

- Astra：`openai/gpt-6-astra`，通过 OpenRouter `/api/v1/chat/completions`。读取当前结构化观察、目标、建议和近期真实结果，生成阶段与有限的动作备选。
- JEV：`typesafe/jev-1.13`，通过 OpenRouter `/api/alpha/decisions`。从候选中选择下一项动作，不使用聊天补全接口调用 JEV。
- 执行：复用现有 MCP → Mineflayer 技能接口、动作参数校验、任务互斥、取消和执行后的状态核验。推理期间世界会话、位置、生命或库存发生关键变化时，该动作作废并重规划。
- 不是逐帧视觉操控，也不直接照搬 `vendor/minecraft-agent` 的已知种子演示。Astra 每轮提供备选，JEV 每轮选一步，不自动执行候选序列。创造动作被拒绝，模型接口失败不降级成伪造决策或自动切回千问。
- 主播人格、聊天与语音沿用现有设置，控制方案只切换 Minecraft 规划与动作选择。

保存模型方案不会启动游戏任务。运行中禁止切换；先停止并等待取消完成。切换会清空预取动作和旧的模型显示信息。网页持续刷新状态，不重复发送付费模型探测。

## 验证

`node tests/minecraft-astra-jev.js` 覆盖配置持久化、密钥不进入公开状态/日志、JEV实际选择、无效候选拒绝、连通性检查限定观察、取消、状态过期和自主循环集成。现有循环与规划合同测试继续适用。

本次本机验证：离线单元测试与桌面/移动网页检查通过。方案二已保存。**尚缺 OpenRouter 密钥，未完成真实云端调用或 Astra/JEV 实机动作验收。**

接口依据：[Astra 官方模型说明](https://developers.openai.com/api/docs/models/gpt-6-astra)、[OpenRouter JEV 官方调用说明](https://openrouter.ai/blog/tutorials/how-to-use-jev/)。
