require("./config/env").loadEnv();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { StreamerBrain } = require("./brain");
const { getTtsStatus, synthesizeWithGptSovits } = require("./tts/provider");
const { getAsrStatus, transcribeAudio } = require("./asr/provider");
const { runIsolatedSimulation } = require("./simulation");
const { PERSONA } = require("./brain/persona");
const { runEvaluation } = require("./evaluation");
const { LiveRuntime } = require("./live/runtime");
const { handleStudioApi } = require("./api/studio");
const { QueueStore } = require("./runtime/queue-store");
const { sanitizeTtsStyle } = require("./tts/style");
const { RuntimeMetrics } = require("./runtime/metrics");
const { workerNodeRegistry } = require("./runtime/node-registry");
const { deleteFeedbackForUser } = require("./brain/feedback");
const { assertPublicStateSafe, publicEmotion, publicSpeech, publicAsrStatus } = require("./api/public-state");
const { sanitizeErrorMessage } = require("./runtime/redaction");
const { classifyComplexity } = require("./brain/local-llm");
const { runDualBrainDiagnostics } = require("./brain/dual-brain-diagnostics");
const { getModuleRegistry } = require("./runtime/module-registry");
const { streamRoutedReply, openAiTokenStream, selectThinkingPreface } = require("./brain/streaming-router");
const { getLlmConfig } = require("./brain/llm");
const { responseAbortController } = require("./runtime/request-lifecycle");
const { createVoiceCallRoutes } = require("./api/voice-call-routes");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const BUILD_ID = "studio-v3";
const INSTANCE_ID = process.env.AI_VTUBER_INSTANCE_ID || require("node:crypto").randomUUID();
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const LIVE2D_DIR = path.join(__dirname, "..", "miku_live2d", "miku", "miku");
const VENDOR_FILES = {
  "/vendor/pixi8.min.js": path.join(__dirname, "..", "node_modules", "pixi.js", "dist", "pixi.min.js"),
  "/vendor/live2d-cubism5.min.js": path.join(__dirname, "..", "public", "vendor", "live2d-cubism5.compat.js")
};
const SAMPLE_DANMAKU = path.join(__dirname, "..", "data", "sample-danmaku.json");
const RUNTIME_SETTINGS_PATH = path.join(__dirname, "..", "data", "runtime-settings.json");
const brain = new StreamerBrain();
const queueStore = new QueueStore();
const queue = queueStore.items;
const seenDanmaku = new Map();
const REPEAT_WINDOW_MS = 90_000;
let runtimeSettings = loadRuntimeSettings();
let nextInFlight = false;
let cloudReplyInFlight = null;
let deferredReply = null;
const handleVoiceCall = createVoiceCallRoutes({ brain, streamRoutedReply, parseBody, send, acquire: () => {
  if (nextInFlight || cloudReplyInFlight) return null;
  nextInFlight = true;
  return () => { nextInFlight = false; };
} });
const runtimeMetrics = new RuntimeMetrics();
const liveRuntime = new LiveRuntime({ onDanmaku: item => enqueueDanmaku(item) });
void liveRuntime.start();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function loadRuntimeSettings() {
  try {
    return { audioOutputEnabled: true, ...JSON.parse(fs.readFileSync(RUNTIME_SETTINGS_PATH, "utf8")) };
  } catch {
    return { audioOutputEnabled: true };
  }
}

function saveRuntimeSettings() {
  const temporary = `${RUNTIME_SETTINGS_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(runtimeSettings, null, 2), "utf8");
  fs.renameSync(temporary, RUNTIME_SETTINGS_PATH);
}

function createSilentWav(durationMs = 40, sampleRate = 16_000) {
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function send(res, code, data, type = "application/json; charset=utf-8") {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { "content-type": type, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": type.startsWith("application/json") ? "no-store" : "no-cache" });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { finish(reject, new Error("Request body timeout")); req.destroy(); }, 8_000);
    req.on("data", chunk => {
      if (settled) return;
      raw += chunk;
      if (raw.length > 1_000_000) {
        finish(reject, new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (settled) return;
      try {
        finish(resolve, raw ? JSON.parse(raw) : {});
      } catch (error) {
        finish(reject, error);
      }
    });
    req.on("error", error => finish(reject, error));
    req.on("aborted", () => finish(reject, new DOMException("Request upload cancelled", "AbortError")));
    if (req.aborted) finish(reject, new DOMException("Request upload cancelled", "AbortError"));
  });
}

function parseBinaryBody(req, limit = 15_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("Audio request timeout")); req.destroy(); } }, 30_000);
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    req.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(reject, new Error("Audio is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(resolve, Buffer.concat(chunks)));
    req.on("error", error => finish(reject, error));
    req.on("aborted", () => finish(reject, new DOMException("Audio upload cancelled", "AbortError")));
    if (req.aborted) finish(reject, new DOMException("Audio upload cancelled", "AbortError"));
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (VENDOR_FILES[url.pathname]) {
    const filePath = VENDOR_FILES[url.pathname];
    if (!fs.existsSync(filePath)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
    return fs.createReadStream(filePath).pipe(res);
  }
  if (url.pathname.startsWith("/live2d/")) {
    const relative = decodeURIComponent(url.pathname.slice("/live2d/".length));
    const filePath = safeFilePath(LIVE2D_DIR, relative);
    if (!filePath) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
    return fs.createReadStream(filePath).pipe(res);
  }
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = safeFilePath(PUBLIC_DIR, relative);
  if (!filePath) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, "Not found", "text/plain; charset=utf-8");
  res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

function safeFilePath(root, relative) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, candidate);
  return relation && !relation.startsWith("..") && !path.isAbsolute(relation) ? candidate : null;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/voice-calls/")) return handleVoiceCall(req, res, url);

  if (await handleStudioApi(req, res, url, { brain, liveRuntime, runtimeMetrics, parseBody, parseBinaryBody, send })) return;

  if (req.method === "GET" && url.pathname === "/api/state") {
    const asrStatus = await getAsrStatus();
    const live2dModelPath = process.env.LIVE2D_MODEL_PATH || "/live2d-web/miku-web.model3.json";
    const publicState = {
      queue,
      queueStatus: { pending: queue.length, replyInFlight: nextInFlight },
      emotion: publicEmotion(brain.visibleEmotion()),
      scene: { chatEnabled: brain.sceneState.chatEnabled, chatSuspended: brain.sceneState.chatSuspended },
      latestSpeech: publicSpeech(brain.lastSpeech),
      persona: { id: PERSONA.id, name: PERSONA.name, displayName: PERSONA.displayName },
      llm: { enabled: brain.llmStatus.enabled, provider: brain.llmStatus.provider, model: brain.llmStatus.model, lastMode: brain.llmStatus.lastMode, lastLatencyMs: brain.llmStatus.lastLatencyMs, route: brain.llmStatus.route, routeReason: brain.llmStatus.routeReason },
      asr: publicAsrStatus(asrStatus),
      audioOutput: { enabled: runtimeSettings.audioOutputEnabled },
      build: BUILD_ID,
      instance: { id: INSTANCE_ID, pid: process.pid },
      avatar: {
        renderer: "live2d-local-preview",
        live2dModelPath,
        live2dReady: isLive2dModelReady(live2dModelPath),
        license: "local-preview-only"
      }
    };
    assertPublicStateSafe(publicState);
    return send(res, 200, publicState);
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, ...runtimeMetrics.status(), instance: { id: INSTANCE_ID, pid: process.pid }, uptimeSeconds: Math.floor((Date.now() - Date.parse(runtimeMetrics.startedAt)) / 1000), queue: queueStore.status(), replyInFlight: nextInFlight, memoryIntegrity: brain.memoryStore.integrityCheck() });
  }

  if (req.method === "GET" && url.pathname === "/api/sample-danmaku") {
    return send(res, 200, JSON.parse(fs.readFileSync(SAMPLE_DANMAKU, "utf8")));
  }

  if (req.method === "POST" && url.pathname === "/api/audio-output") {
    const body = await parseBody(req);
    runtimeSettings.audioOutputEnabled = Boolean(body.enabled);
    saveRuntimeSettings();
    return send(res, 200, { ok: true, audioOutput: { enabled: runtimeSettings.audioOutputEnabled } });
  }

  if (req.method === "POST" && url.pathname === "/api/danmaku") {
    const body = await parseBody(req);
    const result = enqueueDanmaku({
      user: String(body.user || "匿名观众").slice(0, 40),
      text: String(body.text || "").trim().slice(0, 300),
      type: normalizeDanmakuType(body.type),
      training: Boolean(body.training),
      timestamp: body.timestamp || new Date().toISOString(),
      delivery: body.delivery === "stream" ? "stream" : "poll"
    });
    if (result.error) return send(res, 400, { error: result.error });
    return send(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/memory/forget-user") {
    const body = await parseBody(req);
    const user = String(body.user || "").trim().slice(0, 40);
    if (!user) return send(res, 400, { error: "user is required" });
    brain.forgetUser(user);
    queueStore.prune(item => item.user === user);
    if (deferredReply?.item?.user === user) deferredReply = null;
    deleteFeedbackForUser(user);
    brain.shortTerm = brain.memoryStore.shortTerm;
    brain.memory = brain.memoryStore.data;
    return send(res, 200, { ok: true, user, memoryStatus: brain.memoryStore.getStatus() });
  }

  if (req.method === "POST" && url.pathname === "/api/memory/train") {
    const body = await parseBody(req);
    const user = String(body.user || "训练者").trim().slice(0, 40);
    const text = String(body.text || "").trim().slice(0, 800);
    if (!text) return send(res, 400, { error: "text is required" });
    const memoryId = brain.memoryStore.saveTrainingMemory(user, text, { scope: body.scope === "character" ? "character" : "user", title: body.title || null });
    brain.memory = brain.memoryStore.data;
    return send(res, 200, { ok: true, memoryId, memoryStatus: brain.memoryStore.getStatus() });
  }

  if (req.method === "POST" && url.pathname === "/api/session/end") {
    const ended = brain.memoryStore.endCurrentSession();
    deferredReply = null;
    queueStore.prune(() => true);
    brain.shortTerm = brain.memoryStore.shortTerm;
    brain.memory = brain.memoryStore.data;
    return send(res, 200, { ok: true, ended, memoryStatus: brain.memoryStore.getStatus() });
  }

  if (req.method === "POST" && url.pathname === "/api/scene/chat") {
    const body = await parseBody(req);
    const enabled = Boolean(body.enabled);
    const { setChatEnabled } = require("./brain/scenes");
    brain.sceneState = setChatEnabled(brain.sceneState, enabled);
    return send(res, 200, { ok: true, scene: brain.sceneState });
  }

  if (req.method === "POST" && url.pathname === "/api/scene/hold") {
    const body = await parseBody(req);
    const scene = body.release ? brain.clearInteractionHold() : brain.setInteractionHold(body.durationMs);
    return send(res, 200, { ok: true, scene });
  }

  if (req.method === "POST" && url.pathname === "/api/next") {
    if (deferredReply) {
      const completed = deferredReply;
      deferredReply = null;
      return send(res, 200, completed);
    }
    if (cloudReplyInFlight) return send(res, 200, { idle: true, busy: true, thinking: true, queueSize: queue.length });
    if (nextInFlight) return send(res, 200, { idle: true, busy: true, queueSize: queue.length });
    nextInFlight = true;
    try {
      const body = await parseBody(req);
      const highTraffic = queue.length >= 3;
      let item = brain.pickDanmaku(queue.filter(candidate => candidate.delivery !== "stream"), { preferFresh: highTraffic || Boolean(body.preferFresh) });
      if (!item) item = brain.maybeInitiate();
      if (!item) return send(res, 200, { idle: true });
      const routing = classifyComplexity(item);
      if (routing.route === "cloud" && item.type !== "proactive") {
        if (queue.includes(item)) queueStore.remove(item);
        const thinkingReply = {
          text: selectThinkingPreface(item),
          performance: { cues: [], profile: brain.emotion.performance },
          emotion: brain.visibleEmotion(),
          persona: { id: PERSONA.id, name: PERSONA.name, displayName: PERSONA.displayName },
          llm: { lastMode: "cloud-thinking", route: "cloud", routeReason: routing.reason },
          routing
        };
        const replyStarted = Date.now();
        cloudReplyInFlight = brain.reply(item)
          .then(reply => {
            runtimeMetrics.recordLatency("reply", Date.now() - replyStarted);
            runtimeMetrics.replies += 1;
            runtimeMetrics.lastReplyAt = new Date().toISOString();
            deferredReply = { idle: false, deferred: true, item, reply, queueSize: queue.length, highTraffic, dropped: 0 };
          })
          .catch(error => {
            if (error.code === "STALE_REPLY") return;
            deferredReply = { idle: false, deferred: true, item, reply: { ...thinkingReply, text: "刚才思路断了一下，你再问我一次好吗？", llm: { ...thinkingReply.llm, lastMode: "cloud-error", lastError: sanitizeErrorMessage(error) } }, queueSize: queue.length };
          })
          .finally(() => { cloudReplyInFlight = null; });
        return send(res, 200, { idle: false, thinking: true, item, reply: thinkingReply, queueSize: queue.length, highTraffic, dropped: 0 });
      }
      const replyStarted = Date.now();
      const reply = await brain.reply(item);
      runtimeMetrics.recordLatency("reply", Date.now() - replyStarted);
      runtimeMetrics.replies += 1;
      runtimeMetrics.lastReplyAt = new Date().toISOString();
      if (queue.includes(item)) queueStore.remove(item);
      let dropped = 0;
      if (highTraffic) {
        const chosenAt = Date.parse(item.timestamp || 0);
        dropped = queueStore.prune(candidate => candidate.type === "chat" && Date.parse(candidate.timestamp || 0) <= chosenAt);
      }
      return send(res, 200, { idle: false, item, reply, queueSize: queue.length, highTraffic, dropped });
    } finally {
      nextInFlight = false;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/next-stream") {
    if (nextInFlight || cloudReplyInFlight) return send(res, 409, { error: "reply is busy" });
    const streamStarted = Date.now();
    let firstTokenMs = null;
    nextInFlight = true;
    const controller = responseAbortController(res);
    try {
      const body = await parseBody(req);
      controller.signal.throwIfAborted();
      let item = body.expectedItemId
        ? queue.find(candidate => candidate.id === body.expectedItemId)
        : brain.pickDanmaku(queue.filter(candidate => candidate.delivery === "stream"), { preferFresh: Boolean(body.preferFresh) });
      if (!item) return send(res, 204, {});
      if (queue.includes(item)) queueStore.remove(item);
      const prepared = brain.prepareStreamReply(item);
      item = prepared.item;
      const context = prepared.context;
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      res.write(`${JSON.stringify({ type: "start", item, emotion: brain.visibleEmotion(), persona: { id: PERSONA.id, name: PERSONA.name, displayName: PERSONA.displayName }, timing: { acceptedMs: Date.now() - streamStarted } })}\n`);
      let text = "";
      let route = null;
      let model = null;
      let mode = null;
      for await (const event of streamRoutedReply(item, context, controller.signal)) {
        controller.signal.throwIfAborted();
        if (event.type === "preface") res.write(`${JSON.stringify({ ...event, timing: { serverElapsedMs: Date.now() - streamStarted } })}\n`);
        else {
          const isFirstToken = firstTokenMs === null;
          if (isFirstToken) {
            firstTokenMs = Date.now() - streamStarted;
            runtimeMetrics.recordLatency("llm_ttft", firstTokenMs);
            runtimeMetrics.recordLatency(event.mode === "local-stream" ? "llm_ttft_local" : "llm_ttft_cloud", firstTokenMs);
          }
          text += event.text;
          route = event.routing;
          model = event.model;
          mode = event.mode;
          // Hold model drafts until reply policy and speech normalization have
          // produced the exact text that will also be committed to memory.
        }
      }
      controller.signal.throwIfAborted();
      if (!text.trim()) throw new Error("Stream completed without reply text");
      brain.llmStatus = { ...brain.llmStatus, enabled: true, model, lastMode: mode, route: route?.route, routeReason: route?.reason, lastError: null };
      const reply = brain.commitStreamReply(item, context, text.trim());
      const approvedDeltaMs = Date.now() - streamStarted;
      runtimeMetrics.recordLatency("reply_approved_delta", approvedDeltaMs);
      res.write(`${JSON.stringify({ type: "delta", text: reply.text, routing: route, model, mode, reviewed: true, timing: { serverElapsedMs: approvedDeltaMs, upstreamFirstTokenMs: firstTokenMs } })}\n`);
      const totalMs = Date.now() - streamStarted;
      runtimeMetrics.recordLatency("reply_stream_total", totalMs);
      runtimeMetrics.replies += 1;
      runtimeMetrics.lastReplyAt = new Date().toISOString();
      res.end(`${JSON.stringify({ type: "done", text: reply.text, routing: route, model, mode, reviewed: true, timing: { firstTokenMs, approvedDeltaMs, totalMs } })}\n`);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (!res.headersSent) return send(res, 503, { error: sanitizeErrorMessage(error) });
      res.end(`${JSON.stringify({ type: "error", error: sanitizeErrorMessage(error) })}\n`);
    } finally {
      nextInFlight = false;
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/modules") {
    return send(res, 200, { ok: true, modules: await getModuleRegistry() });
  }

  if (req.method === "POST" && url.pathname === "/api/metrics/client") {
    const body = await parseBody(req);
    const allowed = new Set(["tts_request_headers", "tts_queue_wait", "tts_first_pcm", "tts_playback_end", "barge_in_abort"]);
    const name = String(body.name || "");
    const valueMs = Number(body.valueMs);
    if (!allowed.has(name) || !Number.isFinite(valueMs) || valueMs < 0 || valueMs > 300_000) {
      return send(res, 400, { error: "invalid client metric" });
    }
    runtimeMetrics.recordLatency(`client_${name}`, Math.round(valueMs));
    return send(res, 202, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/nodes") {
    return send(res, 200, { ok: true, main: { id: "5080-main", online: true }, workers: workerNodeRegistry.status() });
  }

  if (req.method === "POST" && (url.pathname === "/api/nodes/register" || url.pathname === "/api/nodes/heartbeat")) {
    try {
      const body = await parseBody(req);
      const token = req.headers["x-worker-token"];
      const node = url.pathname.endsWith("register")
        ? workerNodeRegistry.register(body, token)
        : workerNodeRegistry.heartbeat(body, token);
      return send(res, 200, { ok: true, node });
    } catch (error) {
      return send(res, error.statusCode || 400, { error: sanitizeErrorMessage(error, "worker node request failed") });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/diagnostics/dual-brain") {
    const result = await runDualBrainDiagnostics();
    return send(res, result.ok ? 200 : 503, result);
  }

  if (req.method === "POST" && url.pathname === "/api/diagnostics/compare-brains") {
    const body = await parseBody(req);
    const prompt = String(body.prompt || "请用两句话说明为什么流式交互能降低等待感。不要使用 Markdown。").trim().slice(0, 300);
    const item = { id: `compare-${Date.now()}`, user: "架构验收", text: prompt, type: "chat", timestamp: new Date().toISOString() };
    const config = getLlmConfig();
    const directRun = async () => {
      const started = Date.now();
      let firstTokenMs = null;
      let text = "";
      for await (const token of openAiTokenStream(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, { model: config.model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 180 }, AbortSignal.timeout(30_000))) {
        firstTokenMs ??= Date.now() - started;
        text += token;
      }
      return { firstTokenMs, totalMs: Date.now() - started, model: config.model, text: text.trim() };
    };
    const dualRun = async () => {
      const started = Date.now();
      let firstTokenMs = null;
      let preface = null;
      let text = "";
      let route = null;
      let model = null;
      for await (const event of streamRoutedReply(item, brain.buildContext(item), AbortSignal.timeout(30_000))) {
        if (event.type === "preface") preface = event.text;
        if (event.type === "delta") {
          firstTokenMs ??= Date.now() - started;
          text += event.text;
          route = event.routing?.route;
          model = event.model;
        }
      }
      return { acknowledgementMs: preface ? 0 : null, firstTokenMs, totalMs: Date.now() - started, route, model, preface, text: text.trim() };
    };
    const [directDeepSeek, dualLayer] = await Promise.all([directRun(), dualRun()]);
    return send(res, 200, {
      ok: true,
      prompt,
      methodology: "parallel-same-prompt-same-token-budget",
      directDeepSeek,
      dualLayer
    });
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    const ttsStarted = Date.now();
    const ttsController = responseAbortController(res);
    const body = await parseBody(req);
    if (ttsController.signal.aborted) return;
    const text = String(body.text || "").trim().slice(0, 500);
    const style = sanitizeTtsStyle(body.style);
    if (!text) return send(res, 400, { error: "text is required" });
    if (!runtimeSettings.audioOutputEnabled) {
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
      return res.end(createSilentWav());
    }
    try {
      const audio = await synthesizeWithGptSovits(text, style, ttsController.signal);
      if (ttsController.signal.aborted) {
        await audio.body?.cancel().catch(() => {});
        return;
      }
      const ttsFirstByteMs = Date.now() - ttsStarted;
      runtimeMetrics.recordLatency("tts", ttsFirstByteMs);
      runtimeMetrics.recordLatency("tts_first_byte", ttsFirstByteMs);
      if (!runtimeSettings.audioOutputEnabled) {
        await audio.body?.cancel().catch(() => {});
        res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
        return res.end(createSilentWav());
      }
      res.writeHead(200, { "content-type": audio.headers.get("content-type") || "audio/wav" });
      const audioStream = Readable.fromWeb(audio.body);
      audioStream.on("error", error => {
        if (error?.name !== "AbortError" && !res.destroyed) res.destroy(error);
      });
      res.on("close", () => audioStream.destroy());
      return audioStream.pipe(res);
    } catch (error) {
      if (ttsController.signal.aborted || res.destroyed) return;
      runtimeMetrics.recordLatency("tts", Date.now() - ttsStarted);
      if (res.headersSent) return res.destroy(error);
      return send(res, 503, { error: sanitizeErrorMessage(error, "TTS 暂时不可用"), tts: getTtsStatus() });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/asr") {
    const asrStarted = Date.now();
    const asrController = responseAbortController(res);
    const audio = await parseBinaryBody(req);
    if (asrController.signal.aborted) return;
    if (!audio.length) return send(res, 400, { error: "audio is required" });
    try {
      const result = await transcribeAudio(audio, asrController.signal);
      if (asrController.signal.aborted) return;
      const asrTotalMs = Date.now() - asrStarted;
      runtimeMetrics.recordLatency("asr", asrTotalMs);
      runtimeMetrics.recordLatency("asr_total", asrTotalMs);
      return send(res, 200, result);
    } catch (error) {
      if (asrController.signal.aborted || res.destroyed) return;
      runtimeMetrics.recordLatency("asr", Date.now() - asrStarted);
      return send(res, 503, { error: sanitizeErrorMessage(error, "ASR 暂时不可用"), asr: publicAsrStatus(await getAsrStatus()) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/simulation") {
    const body = await parseBody(req);
    const rounds = Math.min(Math.max(Number(body.rounds) || 6, 1), 8);
    return send(res, 200, await runIsolatedSimulation(rounds));
  }

  if (req.method === "POST" && url.pathname === "/api/evaluate") {
    return send(res, 200, await runEvaluation());
  }

  return send(res, 404, { error: "Unknown API route" });
}

function isLive2dModelReady(modelPath) {
  const pathname = String(modelPath || "").split(/[?#]/)[0];
  const target = pathname.startsWith("/live2d/")
    ? safeFilePath(LIVE2D_DIR, pathname.slice("/live2d/".length))
    : safeFilePath(PUBLIC_DIR, pathname.replace(/^\/+/, ""));
  return Boolean(target && fs.existsSync(target) && fs.statSync(target).isFile());
}

function enqueueDanmaku(input) {
  const item = {
    id: input.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    user: String(input.user || "匿名观众").slice(0, 40), text: String(input.text || "").trim().slice(0, 300),
    type: normalizeDanmakuType(input.type), training: Boolean(input.training), source: input.source || "local",
    timestamp: input.timestamp || new Date().toISOString(), delivery: input.delivery === "stream" ? "stream" : "poll"
  };
  if (!item.text) return { error: "text is required" };
  const normalizedText = item.text.toLowerCase().replace(/[\s\p{P}]/gu, "");
  const duplicateKey = `${item.user}:${normalizedText}:${item.type}`;
  const previous = seenDanmaku.get(duplicateKey);
  const withinWindow = previous && Date.now() - previous.at < REPEAT_WINDOW_MS;
  const repeatCount = withinWindow ? previous.count + 1 : 0;
  seenDanmaku.set(duplicateKey, { at: Date.now(), count: repeatCount });
  if (seenDanmaku.size > 5_000) {
    const cutoff = Date.now() - REPEAT_WINDOW_MS;
    for (const [key, value] of seenDanmaku) if (value.at < cutoff) seenDanmaku.delete(key);
  }
  item.repeatCount = repeatCount;
  item.repeatPenalty = Math.min(36, repeatCount * 12);
  if (repeatCount >= 4) {
    const admissionChance = Math.max(0.15, 0.72 - repeatCount * 0.12);
    if (Math.random() > admissionChance) return { ok: true, duplicate: true, suppressed: true, repeatCount, admissionChance, item, queueSize: queue.length };
  }
  queueStore.push(item);
  queue.sort((a, b) => brain.scoreDanmaku(b) - brain.scoreDanmaku(a));
  queueStore.save();
  return { ok: true, duplicate: repeatCount > 0, repeatCount, item, queueSize: queue.length };
}

function normalizeDanmakuType(type) {
  const value = String(type || "chat");
  return ["chat", "gift", "superchat", "guard", "proactive"].includes(value) ? value : "chat";
}

const server = http.createServer((req, res) => {
  runtimeMetrics.requests += 1;
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch(error => {
      runtimeMetrics.errors += 1;
      runtimeMetrics.lastError = { at: new Date().toISOString(), message: error.message };
      if (!res.headersSent) send(res, 500, { error: sanitizeErrorMessage(error) }); else res.destroy();
    });
  } else {
    serveStatic(req, res);
  }
});
server.requestTimeout = 65_000;
server.headersTimeout = 10_000;

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down cleanly.`);
  server.close(() => {
    try { brain.persistRuntime(); brain.memoryStore.close(); } finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  console.log(`Live2D AI Streamer MVP running at http://${HOST}:${PORT}`);
});
