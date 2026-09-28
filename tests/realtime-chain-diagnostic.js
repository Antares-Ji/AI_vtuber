const fs = require("node:fs");
const path = require("node:path");

require("../src/config/env").loadEnv();

const BASE = process.env.AI_VTUBER_BASE_URL || "http://127.0.0.1:3000";

function elapsed(started) {
  return Math.round(performance.now() - started);
}

async function json(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function measureAppStream(text) {
  const user = `realtime-diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const created = await json(`${BASE}/api/danmaku`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, text, type: "chat", delivery: "stream" })
  });
  const started = performance.now();
  const response = await fetch(`${BASE}/api/next-stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferFresh: true, expectedItemId: created.item.id })
  });
  if (!response.ok || !response.body) throw new Error(`/api/next-stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push({ ...event, atMs: elapsed(started) });
    }
  }
  await json(`${BASE}/api/memory/forget-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user })
  }).catch(() => {});
  const deltas = events.filter(event => event.type === "delta");
  const done = events.find(event => event.type === "done");
  if (!done || !deltas.length || events.some(event => event.type === "error")) throw new Error("App stream did not complete successfully");
  return {
    prompt: text,
    mode: done?.mode,
    preface: events.find(event => event.type === "preface")?.text || null,
    firstDeltaMs: deltas[0]?.atMs ?? null,
    totalMs: done?.atMs ?? elapsed(started),
    deltaCount: deltas.length,
    outputChars: String(done?.text || "").length
  };
}

function asciiOccurrences(buffer, needle) {
  const positions = [];
  let index = 0;
  while ((index = buffer.indexOf(needle, index, "ascii")) >= 0) {
    positions.push(index);
    index += needle.length;
  }
  return positions;
}

async function measureTts() {
  const before = await json(`${BASE}/api/health`);
  const started = performance.now();
  const response = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "现在进行一次完整的流式语音诊断，检查首音、分片和音频格式。", style: { emotion: "neutral" } })
  });
  const headersMs = elapsed(started);
  if (!response.ok || !response.body) throw new Error(`/api/tts HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const reader = response.body.getReader();
  const chunks = [];
  const chunkTimesMs = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    chunkTimesMs.push(elapsed(started));
  }
  const audio = Buffer.concat(chunks);
  const after = await json(`${BASE}/api/health`);
  const channels = audio.length >= 24 ? audio.readUInt16LE(22) : 0;
  const sampleRate = audio.length >= 28 ? audio.readUInt32LE(24) : 0;
  const bitsPerSample = audio.length >= 36 ? audio.readUInt16LE(34) : 0;
  const pcmBytes = Math.max(0, audio.length - 44);
  return {
    headersMs,
    firstAudioMs: chunkTimesMs[0] ?? null,
    totalMs: elapsed(started),
    chunks: chunks.length,
    chunkSizes: chunks.map(chunk => chunk.length),
    bytes: audio.length,
    pcmDurationMs: sampleRate && channels && bitsPerSample ? Math.round(pcmBytes / (sampleRate * channels * bitsPerSample / 8) * 1000) : null,
    audioFormat: { channels, sampleRate, bitsPerSample },
    riffHeaders: asciiOccurrences(audio, "RIFF"),
    dataHeaders: asciiOccurrences(audio, "data"),
    chunkTimesMs,
    serverTtsSampleDelta: (after.latency?.tts?.samples || 0) - (before.latency?.tts?.samples || 0)
  };
}

async function measureTtsAbort() {
  const controller = new AbortController();
  const started = performance.now();
  const response = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "这是一段故意很长的打断测试语音。请连续朗读足够长的内容，以便客户端在收到第一块音频以后立即取消后续传输。", style: { emotion: "neutral" } }),
    signal: controller.signal
  });
  if (!response.ok || !response.body) throw new Error(`/api/tts abort probe HTTP ${response.status}`);
  const reader = response.body.getReader();
  let bytesReceived = 0;
  let firstPcmMs = null;
  while (bytesReceived <= 44) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("/api/tts abort probe ended before PCM arrived");
    bytesReceived += chunk.value?.byteLength || 0;
    if (bytesReceived > 44) firstPcmMs = elapsed(started);
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 350));
  const health = await json(`${BASE}/api/health`);
  return { firstPcmMs, bytesReceivedBeforeAbort: bytesReceived, aborted: controller.signal.aborted, serverHealthyAfterAbort: health.ok };
}

async function measureAsr() {
  const audioPath = path.join(__dirname, "..", "assets", "tts", "seele-reference-16k.wav");
  const audio = fs.readFileSync(audioPath);
  const started = performance.now();
  const response = await fetch(`${BASE}/api/asr`, { method: "POST", headers: { "content-type": "audio/wav" }, body: audio });
  if (!response.ok) throw new Error(`/api/asr HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const result = await response.json();
  return { totalMs: elapsed(started), inputBytes: audio.length, durationMs: result.audio?.durationMs, rmsDb: result.audio?.rmsDb, text: result.text || result.transcript || "" };
}

function inspectFrontend() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "stream.js"), "utf8");
  const readStart = source.indexOf("async function readNextStreaming");
  const readEnd = source.indexOf("async function submitDanmaku", readStart);
  const readSource = source.slice(readStart, readEnd);
  return {
    queueSpeechCallSites: (readSource.match(/queueSpeech\(/g) || []).length,
    queuesPreface: /event\.type === "preface"[\s\S]*?queueSpeech\(event\.text\)/.test(readSource),
    queuesDeltas: /event\.type === "delta"[\s\S]*?queueSpeech\(event\.text\)/.test(readSource),
    queuesNaturalSentenceEarly: /matchAll\(\/\[。！？!?；;\]/.test(readSource),
    queuesOnlyRemainingAtDone: /event\.type === "done"[\s\S]*?fullText\.slice\(queuedPrefixLength\)/.test(readSource),
    gatedTtsPrefetch: /ttsRequestGate\.then\(\(\) =>[\s\S]*?prepareBackendSpeech/.test(readSource),
    prefetchKeepsReplyEpoch: /prepareBackendSpeech\(clean, \{\}, streamSpeechEpoch\)/.test(readSource),
    pcmStreamingReader: /playStreamingWav[\s\S]*?response\.body\.getReader\(\)/.test(source),
    cancellationCheckedAfterRead: /const \{ value, done \} = await reader\.read\(\);[\s\S]*?await reader\.cancel\(\);/.test(source),
    cancellationCheckedBeforeSchedule: /const schedule = bytes => \{[\s\S]*?if \(!audioOutputEnabled \|\| epoch !== speechEpoch\) return bytes;/.test(source),
    interruptionConfirmationMs: Number(source.match(/vadSpeechCandidateAt >= (\d+)/)?.[1] || NaN),
    endOfTurnSilenceMs: Number(source.match(/vadSilenceStartedAt >= (\d+)/)?.[1] || NaN),
    aiSpeakingThresholdDb: Number(source.match(/const threshold = aiSpeaking \? (-?\d+)/)?.[1] || NaN),
    normalSpeechThresholdDb: Number(source.match(/const threshold = aiSpeaking \? -?\d+ : (-?\d+)/)?.[1] || NaN)
  };
}

async function main() {
  const frontend = inspectFrontend();
  const missing = ["gatedTtsPrefetch", "prefetchKeepsReplyEpoch", "pcmStreamingReader", "cancellationCheckedAfterRead", "cancellationCheckedBeforeSchedule"]
    .filter(key => !frontend[key]);
  if (missing.length) throw new Error(`frontend realtime safeguards missing: ${missing.join(", ")}`);
  const result = {
    timestamp: new Date().toISOString(),
    frontend,
    router: {
      local: await measureAppStream("Hello, Hello，能听到吗？"),
      cloud: await measureAppStream("请详细分析本地实时语音系统的端到端延迟瓶颈，并给出完整优化方案。")
    },
    tts: await measureTts(),
    ttsAbort: await measureTtsAbort(),
    asr: await measureAsr()
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
