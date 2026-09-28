# 双脑路由与记忆交接

## 已实现（双脑专项）

- `src/brain/realtime-context.js` 是本地实时模型与流式路由共同使用的上下文构造器：人格、世界书、情绪、可靠记忆、话题、能力边界、同步记忆查询、导演指令和近期对话不再只出现在非流式路径。
- `StreamerBrain.prepareStreamReply(item)` 返回 `{ item, context, direction }`，并完成与 `reply()` 相同的活动记录、时间核验、情绪更新、重复处理、检索、人格/认知上下文和导演决策。它还提供 `context.fallbackText`。
- `StreamerBrain.commitStreamReply(item, context, rawText)` 只用于完整、未取消的输出；它写入记忆、认知和运行态，返回 `{ text, policy, performance, ... }`。取消、超时或已输出部分后上游失败时不得调用它。
- `streamRoutedReply` 的两个上游都无首个 token/空响应时会切换；两个上游都不可用时使用 `context.fallbackText`。任何已输出 token 后不会切换，避免把两段回答拼接。
- 每个流式上游都有 `STREAMING_LLM_TIMEOUT_MS`（默认 20 秒）上限，并继续响应客户端 abort。
- 轻量路由只匹配整句问候/音频检查；“你好，帮我写 SQL”“晚上好，分析架构”“谢谢，安排计划”均走云端。

## 服务端接入顺序

1. 在写 `start` 前调用 `const prepared = brain.prepareStreamReply(item)`，并替换后续 `item` 与 `context`。
2. 将 `prepared.context` 传给 `streamRoutedReply`。
3. 仅在流完整结束、响应未取消且 `text.trim()` 非空时调用 `const committed = brain.commitStreamReply(item, context, text.trim())`；`done.text` 使用 `committed.text`。
4. 断连、AbortError、超时以及任何已经有 partial token 后的错误，都不调用 commit，也不标记成功指标。

## 流式策略约束

当前服务端把上游 token 缓存到完整回复，再调用 `commitStreamReply` 的 policy，并只发送已审核的文本。因此浏览器听到的内容、`done.text` 与写入记忆的内容一致；代价是失去 token 级首句响应。路由仍在首 token 前拦截提示词提取、直接歌词请求、未就绪能力和同步记忆查询，使用规则回复。

若以后恢复 token 直出，不能在 `done` 阶段才用 policy 改写文本：身份冒充或密钥回显等只能从输出识别的情况会已经被播出。严格安全需采用“按完整句缓存 -> policy -> TTS”，这是首句延迟与输出级安全之间的明确取舍，而不是等价替换。

## 已运行验收

- `npm run test:router`：37/37 路由评测通过；本地/云端双向回退、双失败规则兜底、部分输出不切换均通过。
- `node tests/streaming-brain-state.js`：准备阶段不写记忆、完整提交写入记忆/运行态、后置策略介入可观察。
