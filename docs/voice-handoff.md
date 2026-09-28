# 实时语音交接

## 已完成

- `public/stream.js` 的 TTS 播放以 `speechEpoch` 标识一次回复。停止输出后，读取到的迟到 PCM 会在排程前再次校验代次并取消 reader，不能重新创建 `AudioBufferSourceNode`。
- 流式回复的句子预取通过 `ttsRequestGate` 串行化；每个预取请求携带原回复的 `streamSpeechEpoch`，已取消的回复不会在队列尾部发起新的 TTS 请求。
- `transcribeAudio(audioBuffer, signal?)` 支持可选 `AbortSignal`：取消会终止 ffmpeg 子进程、取消上游 `/transcribe` fetch，`finally` 仍清理 webm/wav 临时文件。
- `tests/realtime-chain-diagnostic.js` 的 TTS 取消探针已改为收到超过 44-byte WAV 头的真实 PCM 后才取消。它证明的是网络取消后服务健康；浏览器端的可听停止由 `speechEpoch` 和已排程 source 的 `stop()` 共同保证。

## 当前 ASR 的真实状态

当前浏览器“部分转写”会把截至当前的完整 WebM Blob 再次 POST 到 `/api/asr`。它改善了交互反馈，但仍是重复批量识别，**不是原生增量 ASR**。当前 `SenseVoiceSmall` 批量模型不应被标记为 streaming。

已交付 [`src/asr/streaming.py`](../src/asr/streaming.py) 的独立会话适配器。它在不加载模型的情况下即可验证缓存复用、单调 chunk 序号、最后一段的 `is_final=True` flush 与取消时释放缓存；离线 mock 验收在 `tests/asr/test_streaming.py`。

要由服务端接通原生最小闭环，需独立加载 FunASR 的 `paraformer-zh-streaming`，通过 WebSocket 接收 16 kHz 单声道 PCM；每个连接创建一个 `StreamingAsrSession(FunAsrOnlineRecognizer(model))`。服务端应只在 `ASR_STREAMING_ENABLED=true` 且 `ASR_STREAMING_MODEL_PATH` 指向已有本地权重时注册/宣告此能力，绝不按浏览器连接隐式下载模型。官方参考：

- [FunASR streaming model source](https://github.com/modelscope/FunASR/blob/main/funasr/models/paraformer_streaming/model.py)
- [FunASR WebSocket runtime](https://github.com/modelscope/FunASR/blob/main/runtime/python/websocket/README.md)

本机已确认具备 FunASR 1.4.13、NumPy、WebSocket 与 Paraformer 流式代码，但没有本地 Paraformer 流式权重；因此该适配器未做真实模型推理验证，也没有悄然启用，避免启动录音时意外下载大模型或改变现有 SenseVoice 回退路径。

浏览器端已新增 [`public/asr-stream-client.js`](../public/asr-stream-client.js)，在 `state.asr.streaming.ready === true` 且服务端给出 WebSocket endpoint 时才会建立会话。它将麦克风采样降至 16 kHz 单声道 PCM16，发送 start/PCM/finish/cancel，并按 sequence 合并 partial/final 文本；`public/stream.js` 已接入。会话使用代次防止取消后的迟到消息写入，finish 有超时，异常关闭释放音频资源，背压超过上限会明确失败并回退批量 ASR；44.1/48 kHz 均以跨 4096-frame 回调保留余量的重采样器处理。未就绪、连接失败或未产出 final 文本时，页面继续使用原有批量 WebM `/api/asr` 路径，绝不显示为原生流式已就绪。离线协议/采样测试：`node tests/asr-stream-client.js`。

## 总协调待接入

服务端调用应将 request disconnect 的 `AbortSignal` 传给 `transcribeAudio(audio, signal)`。调用方收到 `AbortError` 时应结束请求而非向客户端写 503。

总协调已完成此项接入。另外新增 `src/asr/streaming_endpoint.py`，并在 ASR 服务源码注册 `/stream`：默认不可用，仅显式启用且本地 `model.pt`/`config.yaml` 齐备并成功加载后接受流式会话。支持 start/PCM/finish/cancel、30 秒空闲超时和帧/会话大小限制；本地 mock 协议测试已通过。浏览器客户端已接入，但因没有本地流式权重保持关闭，不能宣称真实原生全链路已完成。

建议的 WebSocket 协议：客户端先发送 `{"type":"start","sampleRate":16000,"channels":1,"format":"pcm_s16le"}`，随后发送二进制 PCM；服务端每次 `feed_pcm` 的事件回传 `{"type":"partial","sequence":n,"text":"...","isFinal":false}`。客户端发 `{"type":"finish"}` 时回传最后一个 `isFinal:true` 事件并关闭；连接断开或 `{"type":"cancel"}` 必须调用 `session.cancel()`，不做 final decode。
