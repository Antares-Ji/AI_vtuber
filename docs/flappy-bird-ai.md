# Flappy Bird AI：安装、运行与实测结果

已在本机下载并运行 `flappy-bird-gymnasium 0.4.0`。使用项目附带的预训练 Dueling DQN，通过 NumPy 推理，并增加基于公开观测的 36 帧碰撞预判保护层。没有重新训练神经网络，也没有修改游戏物理、管道间距、碰撞检测或得分。

## 直接启动

直接双击 `scripts/flappy-bird/start.cmd`，或在任意目录的 PowerShell 中运行：

```powershell
& E:\Github\AI_vtuber\scripts\flappy-bird\start.cmd
```

打开独立游戏窗口，AI 自动操作。每局达到 10,000 分或发生碰撞后自动开始下一局。按 Esc 或关闭窗口即可退出，也可以运行：

```powershell
& E:\Github\AI_vtuber\scripts\flappy-bird\stop.cmd
```

启动脚本会避免重复启动同一个演示。`pythonw.exe` 不显示控制台，但游戏窗口正常显示。启动时需要约数秒编译保护层。

Windows PowerShell 默认可能禁止执行 `.ps1`。`.cmd` 入口直接调用独立 Python 环境，不依赖 `.ps1`，无需修改 ExecutionPolicy；它通过实时心跳和存活进程检测已启动的游戏。

## 验收结果（2026-10-18）

Flappy Bird 没有有限的最终关卡；本次将“稳定维持”落实为不同随机场景的长局测试，并另外验证单局持续运行。

| 测试 | 随机种子 | 结果 |
| --- | --- | --- |
| 原版预训练 DQN 长测 | 20000–20099 | 64/100 局达到 1,000 分；36 局碰撞；最低 19 分，平均 821.84 分 |
| 保护层开发验证 | 20050–20059 | 10/10 局达到 1,000 分，零碰撞 |
| 最终独立场景验收 | 30000–30099 | **100/100 局达到 1,000 分，零碰撞** |
| 单局耐久验证 | 40000 | **连续 10,000 分，零碰撞** |
| 桌面可见窗口实时验证 | 50000 | 同一局已超过 100 分，核验时 112 分、142 秒，进程仍存活 |

最终 100 局共执行 3,769,100 个真实环境步，保护层仅改动 131 次动作；无一次出现“两个动作都找不到安全延续”。单局耐久测试执行 376,691 步，保护层改动 11 次动作。基准测试使用关闭画面的加速执行；10,000 分对应默认 30 FPS 下 12,556.37 秒，约 3 小时 29 分钟的游戏内时间，实际加速计算约 9.36 秒。

基线与最终验收采用不同种子，以上不是同种子逐局性能对比。最终验收种子没有用于保护层开发调试。有限测试说明当前默认环境下表现稳定，不是对所有随机序列永不死亡的数学保证。

原始逐局结果保存在：

- `output/flappy-bird/pretrained-long-baseline.json`
- `output/flappy-bird/acceptance.json`
- `output/flappy-bird/endurance.json`
- `output/flappy-bird/live-status-at-verification.json` 和 `live-frame.png`（实时进度与游戏渲染帧）

最终报告记录游戏源码、智能体源码和原模型的 SHA-256，记录随机种子、动作步数、终止原因、保护层干预次数等。达到测试目标后记录 `target_reached_alive`；这表示人工设定的测试终点，不是游戏通关事件。

## 复测

运行完整的 100 局验收（默认参数、每局目标 1,000 分）：

```powershell
& E:\Github\AI_vtuber\scripts\flappy-bird\start.cmd --evaluate
```

结果写入 `runtime/flappy-bird/acceptance.json`。只有所有局都活着达到目标才返回退出码 0；碰撞或超过步数上限返回 1。

单局 10,000 分耐久验证：

```powershell
.\runtime\flappy-bird\.venv\Scripts\python.exe .\scripts\flappy-bird\run.py --episodes 1 --target 10000 --max-steps 1000000 --seed 40000 --output runtime/flappy-bird/endurance.json
```

移除保护层、单独评估原模型：

```powershell
.\runtime\flappy-bird\.venv\Scripts\python.exe .\scripts\flappy-bird\run.py --policy pretrained --episodes 100 --target 1000 --seed 20000 --output runtime/flappy-bird/pretrained-long-baseline.json
```

## 安装与实现

隔离的 Python 3.11 环境位于 `runtime/flappy-bird/.venv`。依赖和下载的模型均留在本机 runtime，不加入源码库。重装使用已安装的 `uv`：

```powershell
.\scripts\flappy-bird\setup.ps1
```

- 游戏来源：[flappy-bird-gymnasium](https://github.com/markub3327/flappy-bird-gymnasium)，[PyPI 0.4.0](https://pypi.org/project/flappy-bird-gymnasium/0.4.0/)。沿用包内原始素材与模型。
- 智能体：`scripts/flappy-bird/agent.py`。从包内 `assets/model/model.h5` 读取权重；两层 ELU 隐藏层后计算优势分支。Dueling 网络的状态价值与优势均值对两个动作相同，因此直接取优势最大值与原模型选动作等价。
- 保护层：仅使用环境返回的 12 维公开状态和默认物理常数，搜索未来 36 帧是否还有无碰撞动作序列。原模型动作无法安全延续时才尝试另一动作。不读取随机数状态，不窥视未显示管道，不修改环境。
- 默认配置：288×512、管道间隙 100、小鸟位置和重力等均为游戏原始默认值。保护层针对这些默认参数实现；更改尺寸或物理后须同步修改并重新验收。
- 运行不调用大语言模型服务，不需要 GPU 或云端 API。
- Windows 下已禁用递归 Numba 函数的磁盘缓存，避免跨进程加载递归地址时发生访问冲突；每次启动重新编译，验收与耐久测试已分别在新进程通过。
- 演示进度：`runtime/flappy-bird/live-status.json`，每秒更新；`live-frame.png` 每 300 帧更新。进程日志为 `demo.stdout.log` / `demo.stderr.log`，启动 PID 记录为 `demo-process.json`。状态文件可能在异常进程退出后残留，判断运行情况时应同时检查对应 PID。

这些脚本可独立运行。主播对话、语音播报和直播控制台集成不在本次实现范围内。
