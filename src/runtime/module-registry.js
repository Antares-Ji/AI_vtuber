const { getAsrStatus } = require("../asr/provider");
const { getTtsStatus } = require("../tts/provider");
const { getLocalLlmConfig } = require("../brain/local-llm");
const { getLlmConfig } = require("../brain/llm");
const { getVisionStatus } = require("../vision/provider");
const { workerNodeRegistry } = require("./node-registry");

async function probeJson(url, timeoutMs = 900) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ready: response.ok, latencyMs: Date.now() - started, health: response.ok ? await response.json() : null, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ready: false, latencyMs: Date.now() - started, health: null, error: error.message };
  }
}

async function getModuleRegistry() {
  const localConfig = getLocalLlmConfig();
  const cloudConfig = getLlmConfig();
  const tts = getTtsStatus();
  const vision = getVisionStatus();
  const workers = workerNodeRegistry.status();
  const [localHealth, asr, ttsHealth] = await Promise.all([
    probeJson(`${localConfig.baseUrl.replace(/\/v1\/?$/, "")}/health`),
    getAsrStatus(),
    process.env.GPT_SOVITS_BASE_URL ? probeJson(`${process.env.GPT_SOVITS_BASE_URL.replace(/\/$/, "")}/openapi.json`, 1500) : Promise.resolve({ ready: false })
  ]);

  return {
    orchestrator: {
      id: "orchestrator-main",
      role: "orchestrator",
      node: "5080-main",
      ready: true,
      transport: "in-process/http",
      capabilities: { cancellation: "llm-and-tts", streaming: true, failover: "local-fallback" }
    },
    realtimeAudio: {
      id: "browser-realtime-audio",
      role: "realtime-audio",
      node: "browser-client",
      ready: true,
      transport: "media-recorder/web-audio",
      capabilities: { microphone: true, pcmPlayback: true, continuousSession: true, echoCancellation: "browser" }
    },
    vad: {
      id: "browser-rms-vad",
      role: "vad-barge-in",
      node: "browser-client",
      ready: true,
      transport: "in-process",
      capabilities: { endOfTurn: true, bargeIn: true, playbackLeakGuard: "threshold-and-hold-v1", neuralVad: false }
    },
    localLlm: {
      id: "qwen-local",
      role: "local-llm",
      node: "5080-main",
      endpoint: localConfig.baseUrl,
      model: localConfig.model,
      ready: localConfig.enabled && localHealth.ready && localHealth.health?.ok === true,
      latencyMs: localHealth.latencyMs,
      capabilities: { chat: true, routing: true, tokenStreaming: true, cancellation: "client-disconnect" }
    },
    cloudLlm: {
      id: "cloud-reasoner",
      role: "cloud-llm",
      node: "cloud",
      endpoint: cloudConfig.baseUrl,
      model: cloudConfig.model,
      ready: cloudConfig.enabled,
      capabilities: { reasoning: true, tokenStreaming: true, cancellation: "client-disconnect" }
    },
    router: {
      id: "dual-brain-router",
      role: "router",
      node: "5080-main",
      ready: localConfig.enabled && cloudConfig.enabled,
      transport: "in-process",
      capabilities: { localFastPath: true, cloudEscalation: true, preface: true, tokenStreaming: true }
    },
    asr: {
      id: "sensevoice-local",
      role: "asr",
      node: "5080-main",
      endpoint: asr.baseUrl,
      model: asr.backend?.model || asr.model,
      ready: asr.backendReady,
      capabilities: {
        batchRecognition: true,
        partialTranscripts: "client-cumulative-webm-batch-v1",
        nativeAudioStreaming: asr.backendReady && asr.backend?.streaming?.ready === true,
        vad: "browser-rms-v1"
      }
    },
    tts: {
      id: "gpt-sovits-local",
      role: "tts",
      node: "5080-main",
      endpoint: process.env.GPT_SOVITS_BASE_URL || null,
      provider: tts.provider,
      ready: tts.provider === "gpt-sovits" && tts.backendReady && ttsHealth.ready,
      capabilities: { synthesis: true, audioStreaming: true, cancellation: "client-abort" }
    },
    memory: {
      id: "memory-local",
      role: "memory",
      node: "5080-main",
      ready: true,
      transport: "in-process/json",
      capabilities: { shortTerm: true, longTerm: true, auditedWritePolicy: true, distributed: false }
    },
    vision: {
      id: "arknights-vision",
      role: "vision",
      node: "on-demand",
      ready: Boolean(vision.ready),
      provider: vision.provider,
      version: vision.version,
      latencyMs: vision.lastLatencyMs,
      capabilities: { screenshots: true, ocr: vision.ocr?.ready ? vision.ocr.provider : "prototype", gpuResident: false, arknightsModel: false },
      note: "当前 provider 主要为 osu! 离线视觉骨架；《明日方舟》识别模型尚未实现"
    },
    gameAgent: {
      id: "arknights-game-agent",
      role: "game-agent",
      node: "disabled",
      ready: false,
      transport: "not-connected",
      capabilities: { discreteActions: "prototype", dryRun: true, liveControl: false },
      note: "只保留离线/校准工具；默认禁止真实输入控制"
    },
    optionalNode: {
      id: "5070-laptop",
      role: "worker",
      node: "5070-laptop",
      ready: workers.online > 0,
      transport: workers.enabled ? "authenticated-http-heartbeat" : "not-configured",
      workers: workers.nodes,
      capabilities: { dynamicJoin: workers.enabled, healthHeartbeat: workers.enabled, automaticFailover: true, taskDispatch: false }
    }
  };
}

module.exports = { getModuleRegistry };
