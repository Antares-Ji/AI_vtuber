# 独立验收清单

本清单只记录可重复的验收证据；不代表 5070 Worker 已获得任务派发能力。

| 范围 | 通过条件 | 离线命令 | 当前结论 |
| --- | --- | --- | --- |
| 旧音频打断 | WAV 头已到达后才迟到的 PCM 不得创建新声源，读取器必须取消 | `node tests/frontend-realtime-behavior.js` | 通过 |
| 流式预取 | 等待话术、首个完整句、余句严格按朗读顺序准备；任意时刻仅一个准备请求 | `node tests/frontend-realtime-behavior.js` | 通过 |
| 双机离线回退 | 未认证/过期 Worker 不可被选择；有能力的最低负载节点才可选；过期回退 5080 | `node tests/node-registry.js` | 通过 |
| ASR 能力声明 | 明确累计 WebM 批量 partial，不得标注成原生音频流 | `node tests/module-registry.js` | 通过 |
| 视觉离线并发 | 多帧分析无挂起，过期帧被合并，正式观察文件不被测试写入 | `node tests/vision/test-concurrency.js` | 全量回归通过 |
| 上游异常停播 | 音源已 `start()` 后上游 error，必须实际调用 `source.stop()` 并清空活动音源 | `node tests/frontend-realtime-behavior.js` | 通过 |

第二轮三条红测已由总协调修复，并经恢复后的独立任务二次复验：`npm run test:realtime` 全部通过；覆盖取消后迟到 LLM delta、error、EOF 缺少 done，以及已开始音源在上游异常后的真实 `source.stop()`。

## 真实通话仍需人工验收

浏览器侧 `tts_queue_wait`、`tts_first_pcm`、`tts_playback_end`、`barge_in_abort` 指标，只有真实浏览器播放/麦克风 VAD 才会写入。仪表板出现“暂无样本”时，不得把服务端 TTS 首字节指标当成这四项的替代。行为测试已覆盖 `source.stop()`，但仍不能替代真实设备上的麦克风/VAD 验收。

人工验收一行标准：**主播朗读中持续说话约 280 ms 后旧音频立即停止，随后迟到的 PCM 不再播放；完成一次本地问候和一次云端复杂提问后，四项客户端指标均至少有 1 个样本。**
