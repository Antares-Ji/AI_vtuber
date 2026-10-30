# GameScaling 开源代码分析

分析对象：https://github.com/Antares-Ji/GameScaling

本地目录：`E:\Github\GameScaling`

提交：`6764efabfbb4121d6e5d3cfcbc54dedf1469bf5a`。下载时，上游 `THUSI-Lab/GameScaling` 的 main 与此提交一致。未修改仓库源代码，未下载模型权重，也未启动或操作游戏。

## 结论

这是一个规模很小、边界清晰的视觉游戏策略推理客户端。可复用的主要是多轮图像请求、与训练对齐的提示格式、动作解析协议。它没有完整的游戏运行循环、截图器、Windows 按键执行器、训练流水线或论文全部 benchmark harness。

对当前 AI Vtuber 项目，它适合作为一个独立的视觉操控后端进行试验。它与当前 Minecraft 的 Mineflayer 技能控制路径处于不同抽象层：现有路径把规划转为采集、合成等技能；GameScaling 输出鼠标位移和短时按键。接入需要增加执行器和控制权仲裁。

## 实际执行流程

```text
外部截图器 -> PIL.Image
            -> GameScalingPolicy.act()
            -> 图片缩放/编码 + 最近帧和动作历史
            -> POST /v1/chat/completions
            -> finalize() 恢复预填内容和结束标记
            -> parse_action()
            -> Decision(Action, reasoning, latency, error)
            -> 外部执行器播放按键和鼠标动作
            -> 新截图验证结果
```

| 文件 | 职责 | 重要细节 |
|---|---|---|
| `gamescaling/policy.py` | 请求与状态 | 默认保留最近 5 次决策；历史默认删除推理文字；同步 HTTP；默认超时 120 秒 |
| `gamescaling/action.py` | 动作解析 | 每包 200ms、6 个子步、每组最多 4 键；74 个允许键名；鼠标限幅 |
| `gamescaling/prompt.py` | 提示构造 | 游戏名、规则、键位是可填项；其余格式与训练保持一致 |
| `gamescaling/keymaps.py` | 键名映射 | 提供 Playwright/UE5 名称表，没有调用这些后端的执行逻辑 |
| `scripts/serve_vllm.sh` | 模型服务启动 | bf16、32768 上下文、最多 8 张图、默认 TP=1 |
| `examples/run_example.py` | 单帧示例 | 检查输出能否解析；不会控制 Doom |
| `tests/test_core.py` | 离线检查 | 提示模板、请求结构、图像编码和解析等 14 项 |

## 动作协议与容易踩的坑

```text
<|action_start|>X Y Z ; g1 ; g2 ; g3 ; g4 ; g5 ; g6<|action_end|>
```

- X/Y 是相对位移，单位为画面宽/高的千分之一，不是屏幕绝对坐标，也不是目标框坐标；Z 是滚轮格数。
- 相邻子步同时出现的键应保持按住；空组表示释放。执行器应维护 held-key 集合，而不是每步重复点击。
- 包时长为 200ms；实现常量 `STEP_MS=200/6`，执行时宜按约 33.333ms 调度，避免把文档的 33ms 四舍五入累积成时序偏差。
- 小写 `one` 表示数字 1；大写 `One` 表示 F1，不能统一转小写。
- `reasoning=False` 是预填一个空 `<think>` 段，仍然使用原提示模板。
- 请求依赖 `continue_final_message`、`add_generation_prompt`、`skip_special_tokens` 等 vLLM 扩展。声称兼容 OpenAI 风格接口并不等于所有兼容服务器都支持这一请求。
- 必须使用模型随附的 chat template。普通 Qwen 权重即使接受此接口，也不等于具有 GameScaling 的游戏能力。

## 代码优点

1. 请求、提示、解析和键位映射拆分清楚，客户端依赖只有 requests/Pillow。
2. 默认只解析最后一个闭合推理段之后的动作，降低误执行推理中示例的可能；未闭合推理默认转为空操作。
3. HTTP 超时等常见请求错误可返回带 error 的空动作；解析失败时将空动作写入历史。
4. 提示构造器与模板、Doom 示例之间有一致性测试。

## 已复现的问题

复现脚本：`probe.py`；机器可读结果：`probe-results.json`。这些是离线构造输入及模拟响应，不代表实际模型会频繁产生这些输出。

### 1. 动作历史与提供给执行器的动作可能不一致

位置：`gamescaling/action.py:96`、`:121`；历史写入位置 `gamescaling/policy.py:225`。

输入鼠标 `5000 -5000 9`、按键组 `A B C D E`、`Foo W` 后，执行字段变为鼠标 `1000 -1000 5`、按键 `A B C D`、`W`。但 `history_text` 仍保存原 body，包含越界值、被截去的 E 和非法 Foo。下一轮模型看到的“过去动作”与执行字段不一致。

建议：用规范化字段生成历史；更完整的适配层应在执行成功后提交真正执行的动作，避免把尚未执行或被中止的意图记为事实。

### 2. 非有限数字被当作有效位移

位置：`gamescaling/action.py:149`、`:121`。

`float()` 接受 NaN/Inf，随后限幅逻辑把 NaN 和正无穷变为 X=1000、负无穷变为 X=-1000，且 `parsed=True`。异常数值可能变成一次最大幅度鼠标动作。

建议：解析后先用 `math.isfinite()` 验证，异常值拒绝执行。

### 3. 异常 JSON 结构可能使 act() 直接抛错

位置：`gamescaling/policy.py:213`、`:218`、`:222`。

模拟响应为 JSON 数组、`choices=[null]` 或列表类型的 `message.content` 时，均产生未捕获的 AttributeError，没有转成带 error 的空动作。

建议：对 payload、choices、message、content 做类型校验，对协议错误统一返回可诊断的失败结果。

### 4. parsed=True 不能视为协议严格合格

只有一个按键组的包也会被补齐并标为成功；超出 6 组、每组多于 4 键的部分会被截去。这种容错有使用价值，但统计接入质量时，应分别记录原始格式合格率、修复率、截断率和执行成功率。

## 实时能力的实际边界

`Decision.latency_ms` 从图片编码和消息构造完成后开始计时，在解析前结束，主要反映请求往返；它不是端到端闭环延迟。

200ms 是动作包覆盖时长，不能据此声称整个系统达到 5Hz。若串行“截图 -> 推理 -> 播放 200ms -> 再截图”，周期还要加上截图、编码、推理和调度时间。并行化时需要解决旧画面决策、执行反馈和控制权问题，不能简单叠加线程。

仓库也没有帧时间戳、过期结果丢弃、焦点检查、急停、输入释放或并发控制。这些应由实际游戏适配层实现。默认 120 秒 HTTP 超时适合通用调用容错，接入实时操控时需要单独设置决策截止时间。

## 本机运行条件

检查到 RTX 5080，显存总量 16303MiB，检查时空闲约 955MiB。当前运行测试的 Python 3.11.15 环境已有 requests 2.33.0、Pillow 12.2.0，没有 vLLM。

模型卡列出的 bf16 权重文件体积为：0.8B 约 2.2GB、2B 约 5.4GB、9B 约 18.8GB、27B 约 54.7GB。文件体积不等于完整推理显存需求，仍需留出视觉编码、KV cache 和运行时空间。

若后续部署，建议先为 0.8B/2B 选择独立服务环境并实测延迟。9B 的 bf16 文件体积已超过本卡总显存；使用它需要另行验证量化、卸载或其他设备方案。仓库提供 Bash 启动脚本，没有 Windows 一键部署流程。没有为本次分析卸载、停止或重配置现有 GPU 服务。

## 与 AI_vtuber 的接入判断

- Minecraft 视觉操控实验可先比较 S1 的 0.8B/2B；多游戏视觉操控实验可先比较 S3。这是实验选择建议，不是已验证的本机性能结论。
- 当前 `src/minecraft/autonomy-loop.js` 使用结构化世界状态和技能规划；GameScaling 不能直接替换其 JSON planner。应作为可切换的游戏控制后端，定义独立的观察和动作契约。
- 现有 `src/minecraft/visual-commentary.js` 可继续负责口播。模型的控制推理内容不宜直接当作主播台词。
- `scripts/sts2/native_input.py` 有焦点、急停及释放机制可参考，但目前偏向归一化绝对坐标、点击/拖拽语义；GameScaling 的相对位移、滚轮和 6 子步 held-key 序列需要单独适配。
- 建议顺序：修复三个已复现的边界问题 -> 单帧真实推理 -> 录制动作但不注入 -> 独立游戏窗口小范围闭环 -> 加入前后帧验证、延迟统计和控制权切换。

## 验证记录

- `python tests/test_core.py`：14 tests passed。
- `python examples/run_example.py --offline`：参考输出 parsed=True，鼠标 (-37,-3,0)，6 步均包含左键。
- 额外模拟：正常请求路径、历史长度限制和超时转空操作通过；上文三个边界问题均复现。
- 未执行真实权重推理、游戏实机测试或论文 benchmark，因此不能据此确认游戏成功率、消费级显卡帧率或长时间自主可靠性。
- 下载的 GameScaling 仓库在测试后 git 工作区保持干净。

## 来源

- 代码：[Antares-Ji/GameScaling](https://github.com/Antares-Ji/GameScaling)
- 上游：[THUSI-Lab/GameScaling](https://github.com/THUSI-Lab/GameScaling)
- 模型卡：[GameScaling](https://huggingface.co/THUSI-Lab/GameScaling)
- 论文：[arXiv:2610.28698](https://arxiv.org/abs/2610.28698)
