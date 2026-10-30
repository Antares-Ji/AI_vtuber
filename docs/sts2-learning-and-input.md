# 杀戮尖塔2：视觉读牌、长期知识与可见输入

## 自动观察、复盘与提示词迭代（2026-10-24）

`node scripts/sts2/summarize.cjs --watch` 持续观察当前局面，每轮结束后等待45秒再检查；局面未变化时跳过模型总结。使用已有官方 DeepSeek 配置，API 请求产生费用。该进程只观察与分析，不发送游戏动作。控制台新增“打法思路”，显示局面、建议、取舍、风险和条件化经验，并注明快照时间与是否过时。

读牌仍使用本地 YOLO＋Qwen-VL。识别记录与当前游戏接口分开标记，OCR不完整时不冒充已核验全文。视觉 worker 的本机请求不经过启动器继承的代理，避免回环采集反复502。卡库替换文件遇到 Windows 短暂文件占用时有限重试。

总结保存于 `runtime/sts2/tactics/` 和长期记忆的 `world/sts2-tactics`。其状态为未实战验证的假设；已知简单攻击的伤害上界用于拦截明显错误的击杀判断。真实游戏 Agent 记录 `observedState` 与下一次观测的 `observed_transition`，区分工具回执、后续状态与因果归属。后续决策读取最新总结的条件化经验，不复用旧手牌下标或旧出牌顺序。

优化后的游戏提示词要求先计算费用与可实现伤害，避免重复计算力量/易伤，考虑不可抽牌、不可打出、状态自伤、格挡、死亡召唤与构筑稀释。Node fetch 的 TLS 连接在本机出现重置时，STS2 改用 Node HTTPS；仍只向官方域名发送密钥、验证 TLS、不跟随重定向、不自动重试已发送的 POST。

这是持续的知识与经验迭代，不是微调模型权重，也不表示已验证胜率提升。

此模块使用已安装版本的卡牌资料、本地 Qwen3-VL-4B 和项目已配置的官方 DeepSeek API。这里的“学习”是保留证据、分析并检索长期知识，不是更新模型权重。

## 数据和记忆

- `integrations/sts2-learning/McpMod.Catalog.cs`：只读 `/api/v1/learning/catalog`，遍历 `ModelDb.AllCards`；对脱离存档的副本生成基础和升级说明，不改变解锁、牌组或存档。
- `data/sts2/knowledge.json`：版本化卡牌、关键词、费用（含星能）、模型分析及 OCR 证据。运行数据不提交 Git。
- `data/memory.db`：原有长期记忆。游戏资料为 `world/sts2-card`；推断协同为 `world/sts2-synergy:*`；攻略为 `character/training`。不同置信度、版本来源，不把模型推断标记成已实战验证。
- `runtime/sts2/learning/`：原始导出、截图哈希、原始模型回答和《攻略与卡牌索引.md》。旧版本保留；重新导入相同资料可跳过已完成分析。
- `src/sts2/knowledge.js`：每次游戏决策按实时牌名/ID召回资料。主播回应也接入相同检索。已经运行的 Node 服务需重启一次加载代码；之后更新知识库无需重启。

全注册卡牌包含状态、诅咒、衍生、事件、任务和废弃牌，不代表每张都能从普通奖励获得。基础说明不能替代遗物、升级、战斗增益影响后的当前牌面。协同只是一组候选，不是穷举所有卡牌组合，更不是证明最优策略。

## 执行学习

在项目根目录：

```powershell
# 首次安装只读导出模块：先正常关闭游戏。已有模组自动备份。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sts2/install-catalog.ps1 -Install
# 从 Steam 启动游戏，停在主菜单也可以导出。
npm run sts2:learn -- --import --analyze --memory
# 第二轮事实复核（仍不是实战验证），然后将修正写回长期记忆。
node scripts/sts2/review.cjs
npm run sts2:learn -- --memory
```

DeepSeek 会产生 API 费用。每批完成即保存；API 余额不足、超时或输出不完整会报错，已完成批次不会丢失。重新执行会跳过已有分析；不自动无限重试。API Key 由现有配置内部读取，不写入报告或日志。

## 实际截图 OCR

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/sts2/game-preview -OutFile runtime/sts2/card.jpg
runtime/vlm-env/Scripts/python.exe scripts/sts2/read-screen.py runtime/sts2/card.jpg --out runtime/sts2/learning/card-ocr.json
npm run sts2:learn -- --ocr runtime/sts2/learning/card-ocr.json
```

请在卡牌详情展开、文字无遮挡时截图。OCR 保留原文及图片 SHA256；只有卡名、说明及费用匹配游戏资料才记为 `exact_text_and_cost`。名称匹配但文本不同需要复核，可能来自识别错误，也可能是战斗修正，程序不会覆盖原始资料。地图截图没有卡牌时不能算作完成读牌。`--gpu-gib 5` 控制 GPU 权重预算，其余卸载到 CPU，速度取决于当时显存情况。

## 真实可见的鼠标键盘输入

`scripts/sts2/native_input.py` 使用 Windows `SendInput`，光标走最小加加速度轨迹，目标采样率 120Hz（不是保证实际帧率）。坐标 `[0..1, 0..1]` 相对于游戏**客户区**，自动转换到多显示器物理坐标。

```powershell
# 仅校验，不点击：示例坐标不是游戏策略，不能盲放到当前画面执行。
npm run sts2:input -- scripts/sts2/input-example.json
# 在冒险地图/战斗画面打开牌组；只在已观察到正确界面时执行。
npm run sts2:input -- scripts/sts2/open-deck.json --execute --focus
# 执行你根据最新截图生成的动作，并保存输入记录。
npm run sts2:input -- runtime/sts2/my-actions.json --execute --focus --log runtime/sts2/input-log.json
```

动作包括 `move/click/drag/down/up/key/key_down/key_up/wait`。`drag` 要求 `from` 和 `to`，`duration` 是移动秒数，`hold` 是按住等待秒数。一次最多30秒，批次结束或异常时释放本控制器按下的键/鼠标；跨批次不保持按下。

- 按 **F8** 或创建 `runtime/sts2/STOP_INPUT` 文件可停止。文件存在时禁止再次执行；恢复时由操作者移除该文件。
- 游戏失去前台、窗口移动/缩放、目标被其他窗口覆盖时停止；不会盲点其他应用。
- 如果系统拒绝 `SendInput`，会报错，不自行提升权限。
- 输入日志只证明发出了事件。点击/拖拽成功还必须用新画面或游戏状态验证。

## 验证

`npm run test:sts2:learning` 验证持久检索、来源/ID校验、OCR冲突保留、非法动作拒绝、拖拽中断后的释放与负坐标映射。`npm run test:sts2` 检查既有游戏桥和 OBS 接口。

## 本地 VL + YOLO 常驻读牌

```powershell
# 训练数据/权重仅是本次会话卡牌界面的原型，不代表广泛泛化测试。
runtime/vlm-env/Scripts/python.exe scripts/sts2/train-card-detector.py --epochs 25
runtime/vlm-env/Scripts/python.exe scripts/sts2/vision_worker.py --gpu-gib 5
```

常驻服务绑定 `127.0.0.1:17645`。控制台的“自动读牌并记忆”启用每35秒观察一次：YOLO 定位卡牌，最多选3张，放大详情优先；Qwen3-VL读取裁剪后的文字；再比对卡库、保留截图哈希、写入原有长期记忆。相同截图使用缓存。没有检测到卡牌时不伪造文字。服务不执行鼠标键盘操作。

- `GET /health`：模型和处理状态。
- `POST /read {"image":"E:/Github/AI_vtuber/runtime/sts2/learning/card-upgraded.jpg"}`：复读已有记录。图片限制为本项目 STS2 的 runtime/output 目录。
- `POST /capture {}`：读取当前 OBS 游戏画面。
- `POST /watch {"enabled":true}`：连续观察；false 暂停。
- `POST /stop {}`：停止本地模型服务。

模型在显存不足时会卸载部分权重到 CPU，读字不是实时帧率。YOLO 原型只用2张实际训练截图的卡牌区域、200张合成排列、3张负样本训练；同一会话的升级牌面只作诊断，不能用其高分宣称在新角色/分辨率上可靠。误检、漏检或文字不一致一律保留为待核验。

已开启主播语音时，新识别并匹配的卡牌会通过现有聊天接口请求一句吐槽，每60秒最多一次。同一卡牌不反复播报。新增服务内 `learning-commentary` 逻辑需在尖塔控制服务下次重启后才加载；当前视觉服务通过已有接口也可播报。

吐槽在独立线程中请求，不阻塞视觉模型；播报失败单独记录 `commentary_error`，不撤销已经写入的识别记忆。

## 本次操作归因（2026-10-21）

用户明确纠正：刚才游戏中的操作由用户本人完成。因此，本次看到的打开牌组、切换详情、地图变化不能作为 AI 点击或拖拽成功的证据。输入日志只能证明脚本尝试发送事件；真实游戏效果尚未单独验证。自动观察服务没有鼠标键盘控制权限；人工操作时只读画面、记忆和吐槽。

用户随后明确“我现在不操作了，全权交给你了”。新接管从 `2026-10-21T09:28:15Z` 起单独计数：奖励界面第4层、73/80血、286金币。当前使用游戏 MCP 接口自主游玩与播报，100步为本轮上限；已验证从奖励界面进入第5层战斗，并收到主播播放开始/结束回执。证据 `logs/sts2/1792574895811-24776.jsonl`、`output/sts2/console-ai-takeover.png`。这不构成原生鼠标拖拽成功的验证。

本轮实际完成第5层战斗后70/80生命，推进到第8层。发现升级选择连续空转，已暂停后在当前任务目标中明确“可确认时完成确认”，随后实际恢复。OBS 预览仍有停帧：切换捕获方法只刷新一帧，不能当作修复。正常退出提示仍有虚拟摄像头输出（推流和录制均关闭），已取消退出以保留该输出。视觉服务检测到游戏状态变化而图片哈希相同时拒绝作为新证据；历史 `card-detail.jpg` 和 `card-upgraded.jpg` 已分别跑通 YOLO→VL→卡库核验→记忆，约56秒/张，不是实时读字。实时游玩使用游戏接口独立继续。

## 2026-10-22 捕获与学习恢复

控制台曾保持旧选牌帧（70/80生命、第5层），而游戏接口已推进第二幕第21层。将 OBS 的 STS2 Game Window 从 WGC(method=2) 改为 BitBlt(method=1) 后，连续截图分别显示第21层战后、地图，并继续到第22层战斗；不能把旧冻结画面当作 AI 停止操作。`src/sts2/obs.js` 新建/重连默认也改为 BitBlt；已运行的主服务须下次重启才加载该默认值，当前 OBS 设置已直接生效。

本地视觉 worker 使用5 GiB显存预算启动，自动读牌已开启。只保存实际截图与 OCR，文字不完整或战斗修正费用不匹配时仍保留待核验，不算新增核验卡。自然吐槽目标已应用到当前500步任务；工具说明同步改为局势反应优先，下一次控制服务启动加载。游玩仍经游戏 MCP 接口，不能据此声称原生鼠标拖拽。
