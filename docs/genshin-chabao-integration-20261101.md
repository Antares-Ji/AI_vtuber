# 茶包 BetterGI 合并记录（2026-11-01）

用户授权“下载并合并”。下载 `kaedelcb/better-genshin-impact` 的
`main-OldTeaBag-B186`，固定提交 `e153ea23ff508ebc0d298615af27b4960c0d6017`。
默认 main 是公版同步分支，本次产品使用包含联机增强的 B186。

## 已交付

- 源码工作树：`runtime/genshin/bettergi-chabao-b186`，分支 `codex/chabao-b186-20261101`。
- BGI 本体版本 `0.66.3-alpha.1`，已合并本机原生补丁；Nexus 助手、协调服务器均已编译并安装。
- 安装沿用 `data/genshin.local.json` 中的原 BetterGI 路径，目录名字仍含 v0.66.0，不代表实际二进制版本。
- Nexus：安装目录下 `Tools/MultiplayerHoeingAssistant/MultiplayerHoeingAssistant.exe`。
- 协调服务器：安装目录下 `Tools/BgiCoordinatorServer/BgiCoordinatorServer.exe`。未启动监听、开放端口或加入公共服务器。
- 原神控制台仍使用 DeepSeek；保留手动 OpenAI 切换与原授权桥接服务。
- 控制台安装信息从 `aivtuber-installation.json` 读取版本与来源。

## 合并内容

将原定制源码七个文件的补丁三方移植到茶包版：仅全队复苏策略、阵亡槽位归因、
短按 Q 的释放保证与本地 ONNX 观测、战斗超时不拾取、禁低血量自动回神像、
自有剧情桥跳过等待大世界 UI。保留茶包版 InputHub、角色技能门控、联机分支和
脚本启动 TaskRunResult。未重新加入茶包版已移除的并发索敌循环。

补丁保存在 `scripts/genshin/patches/bettergi-chabao-b186-aivtuber.patch`。
原 `bettergi-custom` 工作树和 `bettergi-0.66-party-recovery.patch` 保持不变。
本次复苏策略合并在茶包战斗引擎；用户若切换到茶包所附公版战斗引擎，不能声称
该引擎也有相同的定制复苏策略。

## 验证与边界

- 三个项目 Release publish 成功；构建使用 `DeployToBgiTools=false`，独立输出后显式部署。
- 32 项 Node 回归、7 项 Python 回归及原生 RecoveryPolicyTests 通过。原生测试指向 B186 源码。
- 备份后替换/补充 1173 个文件；原有 1828 个 User 文件逐文件 SHA-256 核验一致。
- 主服务重启并复用 PID49216 授权桥接服务；安装接口报告 B186、655 条路线及46组原配置。
- 截图试验 `7d65925e-75f2-423f-99ce-e6d5042dbb5c` 因游戏最小化被原生接口拒绝，未取得截图。
  不将编译、安装或旧版游戏证据当作本次新版游戏实测。联机与剧情运行均未验证。
- 收尾时导演无运行任务，inputReleased/processStopped=true，visionBusy=false，provider=deepseek。
- 上游构建仍有警告，包括 SharpCompress 0.38.0 的 NU1902；未把依赖升级混入本次合并。

联机实际使用还需要同伴、服务器地址和用户身份配置，以及上游教程要求的“锄地一条龙”JS。
本次未创建房间、发送联机邀请、订阅第三方 JS 或恢复旧游戏目标。

## 回退与证据

部署清单与全部替换文件摘要：`runtime/genshin/chabao-deployment.json`。
备份：`runtime/genshin/native-backups/pre-chabao-1793601783`，包含原 User、安装配置及 overwritten 文件。
回退前先通过导演 API 停止任务并核实输入释放/视觉空闲，确认 BetterGI/Nexus 均关闭，
然后将备份的 `overwritten` 按相对路径恢复到原安装目录，并移走本次版本清单。
User 备份用于有依据的恢复；不要覆盖回退之后产生的新用户数据。

构建日志：`runtime/genshin/chabao-{BetterGenshinImpact,MultiplayerHoeingAssistant,BgiCoordinatorServer}-build.log`。
截图拒绝回执：`runtime/genshin/chabao-smoke.json`；空闲核验：`runtime/genshin/chabao-preflight.json`。
