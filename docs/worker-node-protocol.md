# 可选 5070 Worker 协议（骨架）

当前阶段只实现节点注册、心跳、能力发现、过期下线和 5080 回退选择，不传输音频、模型或执行任务。

## 安全边界

- 主服务默认仍绑定 `127.0.0.1`，局域网设备无法访问。
- 启用前必须在两台机器配置相同且至少 16 字符的 `WORKER_SHARED_TOKEN`。
- Token 只通过 `x-worker-token` 请求头发送，不会出现在节点状态响应中。
- 能力白名单只有 `asr`、`tts`、`local-llm`、`vision`；不能注册 shell 或游戏控制能力。
- 节点超过心跳 TTL 后立即视为离线，选择器自动返回 `5080-main`。

## 注册

`POST /api/nodes/register`

```json
{
  "id": "5070-laptop",
  "label": "RTX 5070 Laptop",
  "endpoint": "http://192.168.1.20:12000",
  "capabilities": ["asr", "vision"],
  "gpu": { "name": "RTX 5070", "totalVramMb": 8192, "freeVramMb": 7000 },
  "load": 0,
  "queueDepth": 0
}
```

## 心跳

`POST /api/nodes/heartbeat`

```json
{
  "id": "5070-laptop",
  "load": 0.35,
  "queueDepth": 1,
  "gpu": { "freeVramMb": 6100 }
}
```

建议每 5 秒一次；默认 TTL 为 15 秒。`GET /api/nodes` 返回脱敏后的在线状态。

## 尚未实现

- 主机向 Worker 派发任务。
- WebSocket/gRPC 音频流。
- 任务 deadline、取消和幂等重试。
- 5070 离线后把在途任务重试到 5080。

这些能力必须等 ASR/TTS 接口稳定后逐项接入；当前模块注册表会明确显示 `taskDispatch: false`。
