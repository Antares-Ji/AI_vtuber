# 整合版使用与扩展

先看 [架构与取舍](ARCHITECTURE.md) 和 [验证记录](VALIDATION.md)。现有主播服务、尖塔服务、原神探索命令保留。MC 原生项目按 [原说明](../../mc-player-agent/README.md) 独立构建安装，F8/F9 和可选的导演任务 API 均保留。

## 统一入口

Node 运行时建议使用项目现有的 Node 24；纯 Skill 核心测试也可用 Node 22.13+。先安装根依赖和尖塔依赖：

```sh
npm ci
npm ci --prefix integrations/sts2-mcp
npm run skills:list
npm run skills:demo
npm run test:skills
```

`skills:list` 不启动游戏或模型。`skills:demo` 只运行原神模拟。实际调用入口挂在已有 `node src/server.js` 的 `/api/skills`，不会另外启动一个规划服务。CLI `npm run skills -- run ...` 将请求发给已有主服务，调用返回 UUID 后用 `status UUID` 查看、`stop UUID` 停止。

```sh
npm run skills -- run sts2:learning-status
npm run skills -- status
npm run skills -- run genshin:doctor
```

参数存入 JSON 文件后用 `--args` 指定。例如 `{"query":"巨像","maxCards":10}` 对应：

```sh
npm run skills -- run sts2:knowledge --args query.json
```

尖塔实机示例参数为 `{"maxSteps":100}`。确认游戏、本地视觉和既有输入链路已启动后：

```sh
npm run skills -- run sts2:native-play --args play.json --live
```

`--live` 只表示本次明确选择实机 Skill，不跳过下层前台保护、急停、状态新鲜度或参数检查。MCP 路线先运行 `npm run sts2:start`；纯视觉路线使用主服务器原有原生输入接口，不能混用两路控制。

`sts2:learn` 参数示例：`{"analyze":true,"memory":true,"maxCards":12}`。分析会使用既有 DeepSeek 配置并产生模型请求；不设置 `analyze` 就不执行该分析分支。该 Skill 复用原学习脚本，保留原始回答、覆盖率和模型推断状态，停止不会回滚已经保存的学习批次。

`minecraft:legacy-play` 参数示例：`{"goal":"收集木头并确保安全","durationMinutes":5}`，先按现有 MC 文档启动 Mineflayer 服务，再加 `--live` 调用。不要同时启动原生 MC 接管同一玩家。

## Java 基线与原始仓库工具

原生 MC 的导演接入需先在对应游戏目录启用[本地任务 API](../../mc-player-agent/docs/DIRECTOR_API.md)，进入用户选定的存档，并配置原项目的 DeepSeek 凭据。在主工程本地创建 `data/mcplayer.local.json`：

```json
{"endpoint":"http://127.0.0.1:17650","tokenFile":"D:/YOUR_GAME/config/mcplayeragent/client/director-token.txt"}
```

替换为该安装实际生成的令牌文件路径，不把令牌文本粘贴进网页。此配置和令牌均忽略上传；可用 `MCPLAYER_DIRECTOR_CONFIG` 指定配置路径。配置默认从 `AIVTUBER_LOCAL_DATA_ROOT` 指向的工程读取。

通过 `mcplayer:native-status` 读取当前 `worldName`、`worldId`、就绪状态；明确选择该存档后，将 `{"goal":"收集木头并确保安全","worldId":"返回的64位存档标识","durationMinutes":5}` 保存到参数文件，再运行 `npm run skills -- run mcplayer:native-play --args mission.json --live`。实际任务由同一导演 Skill API 承接，MC 保持前台且没有打开菜单；模型仍由原 PlayerControl 调用 DeepSeek。任务结果保留原生 Harness 状态，外层不会把“输入结束”解释为通关。客户端实机验收尚未完成。

```sh
python scripts/check-mc-import.py
cd mc-player-agent
bash gradlew -p harness test installDist run --args=demo --no-daemon
bash gradlew -p examples/collect-return :test :run --no-daemon
```

Windows 使用 `gradlew.bat`。`mcplayer:harness-demo` 运行上面构建的发行目录；`JAVA_COMMAND` 可指定本机 Java 21 可执行文件。输出即使来自原核心 `VERIFIED`，统一层仍标注为 `SIMULATED`。

原 ZIP 的仓库检查与发布脚本要求自身就是 Git 根目录。整合仓库不修改这些脚本：`check-mc-import.py` 验证原 ZIP 和源码，然后在临时独立 Git 根中运行原检查与 17 项工具测试。需要发布独立 MC 安装包时，将 `mc-player-agent/` 导出到独立仓库，再执行其原 [发布流程](../../mc-player-agent/docs/RELEASING.md)。整合层 GitHub Actions 位于仓库顶层 `.github/workflows/agent-skills.yml`；保留在子目录的原工作流只是上游快照，不会自动被 GitHub 执行。

## 学习数据和个人配置

仓库不包含 API Key、存档、个人 SQLite 记忆、已训练权重和原始实战录像。它们仍在原本地工程中。生成额外快照可运行：

```sh
python scripts/preserve-local-learning.py --source PATH_TO_EXISTING_PROJECT --destination PATH_TO_NEW_SNAPSHOT
```

目标必须是新目录。脚本复制 MC/尖塔知识与学习资料、使用 SQLite backup API 备份记忆、校验拷贝哈希；大体积模型和输入录像留在原位，写入本机索引。只有出现 `SNAPSHOT_COMPLETE` 才算完成。不要把快照上传公开仓库。

在独立工作区只读检索旧资料时，可设置 `AIVTUBER_LOCAL_DATA_ROOT` 指向旧工程。它仅用于 `sts2:knowledge` 和 `sts2:learning-status`；`sts2:learn` 始终写入运行脚本所属工程，避免悄悄修改另一工作区。实机服务继续使用各自的数据目录。GitHub 新克隆没有卡库时会报告 `available:false`，不会生成虚假的已有学习记录。

## 扩展契约

```js
const { createSkillHost } = require('./src/skills');
const host = createSkillHost({
  providers: [require('./examples/skills/provider.cjs')],
  enabled: ['example:receipt-review']
});
const job = host.start({skill:'example:receipt-review', args:{receipt:'input accepted'}});
console.log(await host.wait(job.id));
```

provider 必须显式注册，不能由模型指定文件路径或下载脚本。`execute` 收到 AbortSignal，必须在释放输入后才 settle；同 JVM/Node 进程中的代码都是可信代码，不是权限沙箱。配合 [Skill 清单](SKILLS.md) 和测试维护版本；第三方项目加入时新增 provider 即可，原 MC Java 插件继续走它自己的 `SkillProvider`。
