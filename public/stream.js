import { setLive2DEmotion, setLive2DMouth, startLive2D } from "./live2d-renderer.js";
import { StreamingAsrClient } from "./asr-stream-client.js";
import { VoiceCallController } from "./voice-call.js";

const subtitle = document.querySelector("#subtitle");
const speaker = document.querySelector("#speaker");
const layer = document.querySelector("#danmakuLayer");
const fallback = document.querySelector("#avatarFallback");
const modelError = document.querySelector("#modelError");
const composer = document.querySelector("#danmakuComposer");
const viewerName = document.querySelector("#viewerName");
const danmakuInput = document.querySelector("#danmakuInput");
const sendDanmaku = document.querySelector("#sendDanmaku");
const composerStatus = document.querySelector("#composerStatus");
const brainStatus = document.querySelector("#brainStatus");
const voiceButton = document.querySelector("#voiceButton");
const voiceStatus = document.querySelector("#voiceStatus");
const microphoneSelect = document.querySelector("#microphoneSelect");
const micMeterFill = document.querySelector("#micMeterFill");
const chatModeToggle = document.querySelector("#chatModeToggle");
const chatModeLabel = document.querySelector("#chatModeLabel");
const trainingMemory = document.querySelector("#trainingMemory");
const speechOutputToggle = document.querySelector("#speechOutputToggle");
const speechOutputLabel = document.querySelector("#speechOutputLabel");
const voiceProviderSelect = document.querySelector("#voiceProviderSelect");
const continuousListeningToggle = document.querySelector("#continuousListening");
const voiceCallButton = document.querySelector("#voiceCallButton");
const voiceCallRecord = document.querySelector("#voiceCallRecord");
const voiceCallCalibration = document.querySelector("#voiceCallCalibration");
const voiceCallTiming = document.querySelector("#voiceCallTiming");
let voiceCall = null;
const composerHandle = composer.querySelector(".composer-head");
const renderedDanmakuKeys = new Set();
const renderedDanmakuOrder = [];
let speakingTimer;
let isReading = false;
let personaName = "AI 主播";
let mediaRecorder;
let microphoneStream;
let recordingChunks = [];
let recordingTimer;
let isAsrBusy = false;
let ignoreVoiceClick = false;
let audioContext;
let audioAnalyser;
let audioMeterData;
let audioMeterFrame;
let micLevelDb = -Infinity;
let typingHoldUntil = 0;
let lastRenderedSpeechId = "";
let recordingDeadline = 0;
let recordingStartedAt = 0;
let vadSpeechDetected = false;
let vadSilenceStartedAt = 0;
let vadSpeechCandidateAt = 0;
let partialAsrController = null;
let partialAsrBusy = false;
let partialAsrText = "";
let partialAsrLastAt = 0;
let nativeAsrSession = null;
let streamingAsrStatus = null;
let continuousSessionActive = false;
let bargeInActive = false;
let dualBrainLabel = "双层大脑 · 连接中";
let activeAudio = null;
let finishActiveSpeech = null;
const activeTtsControllers = new Set();
let activeReplyController = null;
let speechEpoch = 0;
let audioOutputSyncUntil = 0;
let audioOutputRequestId = 0;
let pollFailures = 0;
let audioOutputEnabled = localStorage.getItem("streamer-audio-output") !== "off";
let voiceProvider = localStorage.getItem("streamer-voice-provider") || "browser";
let ttsAudioContext;
let ttsLipSyncFrame;
const activeStreamSources = new Set();
const MAX_RECORDING_MS = 90_000;
const audioOutputChannel = "BroadcastChannel" in window ? new BroadcastChannel("streamer-audio-output") : null;

trainingMemory.checked = localStorage.getItem("streamer-training-memory") !== "off";
continuousListeningToggle.checked = false;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function enableComposerDrag() {
  let drag = null;
  composerHandle.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    const rect = composer.getBoundingClientRect();
    composer.style.left = `${rect.left}px`;
    composer.style.top = `${rect.top}px`;
    composer.style.right = "auto";
    composer.style.bottom = "auto";
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    composerHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  composerHandle.addEventListener("pointermove", event => {
    if (!drag) return;
    const width = composer.offsetWidth;
    const height = composer.offsetHeight;
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, drag.left + event.clientX - drag.x));
    const top = Math.min(window.innerHeight - height - 12, Math.max(12, drag.top + event.clientY - drag.y));
    composer.style.left = `${left}px`;
    composer.style.top = `${top}px`;
  });
  const stop = event => {
    if (!drag) return;
    drag = null;
    if (composerHandle.hasPointerCapture(event.pointerId)) composerHandle.releasePointerCapture(event.pointerId);
  };
  composerHandle.addEventListener("pointerup", stop);
  composerHandle.addEventListener("pointercancel", stop);
}

function showDanmaku(item) {
  const key = `${item.user}:${item.text}:${item.timestamp}`;
  if (renderedDanmakuKeys.has(key)) return;
  renderedDanmakuKeys.add(key);
  renderedDanmakuOrder.push(key);
  if (renderedDanmakuOrder.length > 300) renderedDanmakuKeys.delete(renderedDanmakuOrder.shift());
  const node = document.createElement("div");
  node.className = `danmaku ${item.type}`;
  node.style.top = `${10 + Math.floor(Math.random() * 54)}%`;
  node.style.setProperty("--travel", `${9 + Math.random() * 4}s`);
  node.textContent = `${item.user}：${item.text}`;
  node.addEventListener("animationend", () => node.remove());
  layer.append(node);
}

async function speak(text, profile = {}) {
  clearInterval(speakingTimer);
  if (!audioOutputEnabled) return false;
  const epoch = ++speechEpoch;
  if (voiceProvider === "browser") return browserSpeak(text, profile, epoch);
  return playPreparedSpeech(prepareBackendSpeech(text, profile), text, profile, epoch, performance.now());
}

async function prepareBackendSpeech(text, profile = {}, expectedEpoch = speechEpoch) {
  if (!audioOutputEnabled || expectedEpoch !== speechEpoch) {
    throw new DOMException("speech was cancelled before TTS request", "AbortError");
  }
  const requestStartedAt = performance.now();
  const controller = new AbortController();
  activeTtsControllers.add(controller);
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, style: { speechRate: profile.speechRate || 1, pitch: profile.pitch || 0, energy: profile.energy, pauseMs: profile.pauseMs, emotion: profile.expression || "neutral", regulation: profile.regulation, valence: profile.valence, arousal: profile.arousal, dominance: profile.dominance, tension: profile.tension, expressibility: profile.expressibility } }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("backend TTS unavailable");
    if (!audioOutputEnabled || expectedEpoch !== speechEpoch) {
      controller.abort();
      throw new DOMException("speech was cancelled while TTS was preparing", "AbortError");
    }
    return { response, controller, requestStartedAt, headersAt: performance.now() };
  } catch (error) {
    activeTtsControllers.delete(controller);
    throw error;
  }
}

function recordClientLatency(name, valueMs) {
  if (!Number.isFinite(valueMs) || valueMs < 0) return;
  void fetch("/api/metrics/client", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, valueMs: Math.round(valueMs) }),
    keepalive: true
  }).catch(() => {});
}

async function playPreparedSpeech(preparedPromise, text, profile, epoch, queuedAt = performance.now()) {
  let prepared = null;
  const dequeuedAt = performance.now();
  recordClientLatency("tts_queue_wait", dequeuedAt - queuedAt);
  try {
    prepared = await preparedPromise;
    recordClientLatency("tts_request_headers", prepared.headersAt - prepared.requestStartedAt);
    if (!audioOutputEnabled || epoch !== speechEpoch) {
      prepared.controller.abort();
      return false;
    }
    await playStreamingWav(prepared.response, epoch, () => {
      recordClientLatency("tts_first_pcm", performance.now() - queuedAt);
      profile.onFirstAudio?.();
    });
    recordClientLatency("tts_playback_end", performance.now() - queuedAt);
    return true;
  } catch (error) {
    if (error.name !== "AbortError" && audioOutputEnabled && epoch === speechEpoch) {
      composerStatus.textContent = "GPT-SoVITS 播放失败，未切换系统声音。请检查语音服务。";
      throw error;
    }
    return false;
  } finally {
    if (prepared?.controller) activeTtsControllers.delete(prepared.controller);
  }
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function parseWavHeader(bytes) {
  if (bytes.length < 12 || new TextDecoder("ascii").decode(bytes.slice(0, 4)) !== "RIFF") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 32000;
  let channels = 1;
  let bitsPerSample = 16;
  while (offset + 8 <= bytes.length) {
    const id = new TextDecoder("ascii").decode(bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 24 <= bytes.length) {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    }
    if (id === "data") return { dataOffset: offset + 8, sampleRate, channels, bitsPerSample };
    if (offset + 8 + size > bytes.length) return null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function playStreamingWav(response, epoch, onFirstAudio = null) {
  if (!response.body) throw new Error("streaming TTS response has no body");
  ttsAudioContext ||= new AudioContext();
  await ttsAudioContext.resume();
  const reader = response.body.getReader();
  let pending = new Uint8Array();
  let format = null;
  let nextStart = ttsAudioContext.currentTime + 0.04;
  let firstAudioScheduled = false;

  const schedule = bytes => {
    // A stop can happen while reader.read() is pending.  Check again here so a
    // just-arrived old PCM chunk cannot create a new source after the stop
    // routine has already cleared activeStreamSources.
    if (!audioOutputEnabled || epoch !== speechEpoch) return bytes;
    if (format.bitsPerSample !== 16) throw new Error(`unsupported PCM depth: ${format.bitsPerSample}`);
    const frameBytes = format.channels * 2;
    const usable = bytes.length - (bytes.length % frameBytes);
    if (!usable) return bytes;
    const frames = usable / frameBytes;
    const buffer = ttsAudioContext.createBuffer(format.channels, frames, format.sampleRate);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < format.channels; channel += 1) {
        buffer.getChannelData(channel)[frame] = view.getInt16((frame * format.channels + channel) * 2, true) / 32768;
      }
    }
    const source = ttsAudioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(ttsAudioContext.destination);
    const startAt = Math.max(nextStart, ttsAudioContext.currentTime + 0.025);
    nextStart = startAt + buffer.duration;
    activeStreamSources.add(source);
    source.onended = () => activeStreamSources.delete(source);
    source.start(startAt);
    if (!firstAudioScheduled) {
      firstAudioScheduled = true;
      onFirstAudio?.();
    }
    setLive2DMouth(true);
    return bytes.slice(usable);
  };

  while (audioOutputEnabled && epoch === speechEpoch) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!audioOutputEnabled || epoch !== speechEpoch) {
      await reader.cancel();
      return;
    }
    pending = concatBytes(pending, value);
    if (!format) {
      format = parseWavHeader(pending);
      if (!format) continue;
      pending = pending.slice(format.dataOffset);
    }
    pending = schedule(pending);
    if (!audioOutputEnabled || epoch !== speechEpoch) {
      await reader.cancel();
      return;
    }
  }
  if (epoch !== speechEpoch) { await reader.cancel(); return; }
  const remainingMs = Math.max(0, (nextStart - ttsAudioContext.currentTime) * 1000);
  await new Promise(resolve => {
    const timer = setTimeout(resolve, remainingMs);
    finishActiveSpeech = () => { clearTimeout(timer); resolve(); };
  });
  finishActiveSpeech = null;
  setLive2DMouth(false);
}

async function startAmplitudeLipSync(audio) {
  try {
    ttsAudioContext ||= new AudioContext();
    await ttsAudioContext.resume();
    const source = ttsAudioContext.createMediaElementSource(audio);
    const analyser = ttsAudioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser); analyser.connect(ttsAudioContext.destination);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
      const rms = Math.sqrt(sum / samples.length);
      setLive2DMouth(rms > 0.018);
      ttsLipSyncFrame = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(ttsLipSyncFrame); source.disconnect(); analyser.disconnect(); setLive2DMouth(false); };
  } catch {
    speakingTimer = setInterval(() => setLive2DMouth(true), 140);
    return () => { clearInterval(speakingTimer); setLive2DMouth(false); };
  }
}

function browserSpeak(text, profile = {}, epoch = speechEpoch) {
  return new Promise(resolve => {
    if (!audioOutputEnabled || epoch !== speechEpoch || !("speechSynthesis" in window)) return resolve(false);
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = Math.min(1.3, Math.max(0.8, 1.08 * (profile.speechRate || 1)));
    utterance.pitch = Math.min(2, Math.max(0, 1.2 + (profile.pitch || 0)));
    clearInterval(speakingTimer);
    speakingTimer = setInterval(() => setLive2DMouth(true), 140);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (finishActiveSpeech === finish) finishActiveSpeech = null;
      clearInterval(speakingTimer);
      setLive2DMouth(false);
      resolve(true);
    };
    finishActiveSpeech = finish;
    utterance.onstart = () => profile.onFirstAudio?.();
    utterance.onend = finish;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  });
}

function stopSpeechOutput() {
  speechEpoch += 1;
  clearInterval(speakingTimer);
  for (const controller of activeTtsControllers) controller.abort();
  activeTtsControllers.clear();
  activeReplyController?.abort();
  activeAudio?.pause();
  for (const source of activeStreamSources) { try { source.stop(); } catch {} }
  activeStreamSources.clear();
  cancelAnimationFrame(ttsLipSyncFrame);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  finishActiveSpeech?.();
  activeAudio = null;
  setLive2DMouth(false);
}

function setAudioOutput(enabled) {
  applyAudioOutput(enabled);
  const requestId = ++audioOutputRequestId;
  audioOutputSyncUntil = Date.now() + 5_000;
  audioOutputChannel?.postMessage({ enabled: audioOutputEnabled });
  void api("/api/audio-output", { method: "POST", body: JSON.stringify({ enabled: audioOutputEnabled }) })
    .then(result => {
      if (requestId === audioOutputRequestId) applyAudioOutput(result.audioOutput.enabled, false);
    })
    .catch(() => { composerStatus.textContent = "语音输出状态同步失败，请刷新后重试"; })
    .finally(() => {
      if (requestId === audioOutputRequestId) audioOutputSyncUntil = 0;
    });
}

function applyAudioOutput(enabled, announce = true) {
  audioOutputEnabled = Boolean(enabled);
  speechOutputToggle.checked = audioOutputEnabled;
  speechOutputLabel.textContent = audioOutputEnabled ? "主播语音输出：开" : "主播语音输出：关";
  localStorage.setItem("streamer-audio-output", audioOutputEnabled ? "on" : "off");
  if (!audioOutputEnabled) stopSpeechOutput();
  if (announce) composerStatus.textContent = audioOutputEnabled ? "语音输出已开启，之后的回复会朗读" : "语音输出已关闭，字幕和回复仍会继续";
}

async function poll() {
  const state = await api("/api/state");
  personaName = state.persona?.displayName || state.persona?.name || personaName;
  if (!lastRenderedSpeechId) speaker.textContent = personaName;
  document.title = `${personaName}直播台`;
  state.queue.slice(0, 5).forEach(showDanmaku);
  setLive2DEmotion(state.emotion.name);
  if (!voiceCall) renderLatestSpeech(state.latestSpeech);
  const llm = state.llm;
  chatModeToggle.checked = Boolean(state.scene?.chatEnabled);
  if (Date.now() >= audioOutputSyncUntil && typeof state.audioOutput?.enabled === "boolean" && state.audioOutput.enabled !== audioOutputEnabled) {
    applyAudioOutput(state.audioOutput.enabled, false);
  }
  chatModeLabel.textContent = state.scene?.chatSuspended ? "主动陪聊：等待回应" : "主动陪聊";
  brainStatus.textContent = dualBrainLabel;
  brainStatus.title = `上一轮：${llm.lastMode || "尚无"}${llm.model ? ` / ${llm.model}` : ""}`;
  if (!voiceCall && !isAsrBusy && (!mediaRecorder || mediaRecorder.state === "inactive")) {
    streamingAsrStatus = state.asr?.streaming?.ready ? state.asr.streaming : null;
    voiceStatus.textContent = state.asr.backendReady
      ? streamingAsrStatus ? `本地识别已就绪：${state.asr.backend.model}（原生流式可用）` : `本地识别已就绪：${state.asr.backend.model}`
      : "本地识别服务未启动";
  }
}

async function pollSafely() {
  try {
    await poll();
    pollFailures = 0;
  } catch {
    pollFailures += 1;
    brainStatus.textContent = pollFailures >= 3 ? "后端连接中断，正在自动重连" : "后端短暂不可用";
  }
}

function renderLatestSpeech(latestSpeech) {
  if (!latestSpeech || latestSpeech.id === lastRenderedSpeechId) return;
  lastRenderedSpeechId = latestSpeech.id;
  subtitle.textContent = latestSpeech.text;
  speaker.textContent = `${personaName} -> ${latestSpeech.item?.user || "你"}`;
  setLive2DEmotion(latestSpeech.emotion?.name || "neutral", latestSpeech.performance?.profile?.intensity);
}

async function setChatMode(enabled) {
  chatModeToggle.disabled = true;
  try {
    await api("/api/scene/chat", { method: "POST", body: JSON.stringify({ enabled }) });
    composerStatus.textContent = enabled ? "主动陪聊已开启：她会继续找话题" : "主动陪聊已关闭：她会安静等待你";
  } catch {
    composerStatus.textContent = "主动陪聊切换失败";
    chatModeToggle.checked = !enabled;
  } finally {
    chatModeToggle.disabled = false;
  }
}

async function holdConversation(durationMs) {
  try {
    await api("/api/scene/hold", { method: "POST", body: JSON.stringify({ durationMs }) });
  } catch {
    // The local UI guard in readNext still prevents this tab from interrupting input.
  }
}

async function releaseConversation() {
  try {
    await api("/api/scene/hold", { method: "POST", body: JSON.stringify({ release: true }) });
  } catch {
    // A short local guard remains in place even if the release request fails.
  }
}

async function readNextOwned() {
  const isRecording = mediaRecorder?.state === "recording" || isAsrBusy;
  const isTyping = document.activeElement === danmakuInput && (danmakuInput.value.trim() || Date.now() < typingHoldUntil);
  if (voiceCall || isReading || isRecording || isTyping) return;
  isReading = true;
  let spoke = false;
  try {
    const result = await api("/api/next", { method: "POST", body: JSON.stringify({ preferFresh: true }) });
    if (voiceCall) return;
    if (result.idle) return;
    showDanmaku(result.item);
    subtitle.textContent = result.reply.text;
    lastRenderedSpeechId = "";
    personaName = result.reply.persona?.name || personaName;
    speaker.textContent = `${personaName} -> ${result.item.user}`;
    setLive2DEmotion(result.reply.emotion.name, result.reply.performance?.profile?.intensity);
    const speechTimeout = setTimeout(stopSpeechOutput, 60_000);
    try {
      spoke = await speak(result.reply.text, result.reply.performance?.profile);
    } finally {
      clearTimeout(speechTimeout);
    }
    clearInterval(speakingTimer);
    setLive2DMouth(false);
  } finally {
    isReading = false;
    if (spoke) setTimeout(() => void readNextSafely(), 0);
  }
}

async function readNext() {
  if (!navigator.locks?.request) return readNextOwned();
  return navigator.locks.request("ai-streamer-speech-output", { ifAvailable: true }, async lock => {
    if (!lock) return;
    await readNextOwned();
  });
}

async function readNextSafely() {
  try {
    await readNext();
  } catch {
    brainStatus.textContent = "回复链路短暂不可用，正在重试";
  }
}

async function refreshModuleStatus() {
  try {
    const result = await api("/api/modules");
    const local = result.modules?.localLlm?.ready;
    const cloud = result.modules?.cloudLlm?.ready;
    dualBrainLabel = local && cloud ? "双层大脑 · 千问 + DeepSeek" : local ? "双层大脑 · 仅千问在线" : cloud ? "双层大脑 · 仅 DeepSeek 在线" : "双层大脑 · 正在重连";
    brainStatus.textContent = dualBrainLabel;
  } catch {
    dualBrainLabel = "双层大脑 · 状态检查失败";
  }
}

async function readNextStreaming(expectedItemId = null, callRequest = null) {
  if (isReading && !callRequest) return;
  isReading = true;
  let speechChain = Promise.resolve();
  let fullText = "";
  let queuedPrefixLength = 0;
  let earlySentenceQueued = false;
  const streamSpeechEpoch = ++speechEpoch;
  let ttsRequestGate = Promise.resolve();
  const replyController = new AbortController();
  activeReplyController = replyController;
  const streamIsCurrent = () => !replyController.signal.aborted && speechEpoch === streamSpeechEpoch;
  const cancelStreamSpeech = () => {
    // Invalidate queued work AND stop audio that was already scheduled.
    // A stale reply must never stop a newer reply's sources.
    if (speechEpoch === streamSpeechEpoch) stopSpeechOutput();
    if (!replyController.signal.aborted) replyController.abort();
  };
  const queueSpeech = chunk => {
    const clean = chunk?.trim();
    if (!clean || !audioOutputEnabled || !streamIsCurrent()) return;
    const queuedAt = performance.now();
    const profile = { onFirstAudio: () => {
      if (!streamIsCurrent() || !callRequest || callRequest.firstAudio || typeof voiceCallTiming === "undefined") return;
      callRequest.firstAudio = true;
      voiceCallTiming.textContent += ` · 合成到首音 ${Math.round(performance.now() - queuedAt)}ms · 分句后到首音 ${Math.round(performance.now() - callRequest.startedAt)}ms`;
    } };
    if (voiceProvider === "browser") {
      speechChain = speechChain.then(() => streamIsCurrent() && browserSpeak(clean, profile, streamSpeechEpoch));
      return;
    }
    // Keep prefetch ordered: each sentence requests TTS only after the prior
    // request has settled. Passing the epoch prevents a queued request from
    // starting after barge-in has cancelled this reply.
    const prepared = ttsRequestGate.then(() => {
      if (!streamIsCurrent()) throw new DOMException("speech was cancelled", "AbortError");
      return prepareBackendSpeech(clean, {}, streamSpeechEpoch);
    });
    prepared.catch(() => {});
    ttsRequestGate = prepared.then(() => undefined, () => undefined);
    speechChain = speechChain.then(() => streamIsCurrent() && playPreparedSpeech(prepared, clean, profile, streamSpeechEpoch, queuedAt));
  };
  try {
    let response;
    for (let attempt = 0; ; attempt++) {
      replyController.signal.throwIfAborted();
      response = await fetch(callRequest?.path || "/api/next-stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(callRequest?.body || { preferFresh: true, expectedItemId }), signal: replyController.signal });
      if (!callRequest || response.status !== 409 || attempt >= 19) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (callRequest && response.status === 409) throw new Error("回复仍忙，请稍后再说一次");
    if (response.status === 204 || response.status === 409) return;
    if (!response.ok || !response.body) throw new Error(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let receivedDone = false;
    while (!receivedDone) {
      const { value, done } = await reader.read();
      // Fetch abort is not guaranteed to preempt an already-resolved reader
      // promise. Discard that late chunk before it can touch subtitles or TTS.
      if (!streamIsCurrent()) {
        await reader.cancel();
        return;
      }
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!streamIsCurrent()) {
          await reader.cancel();
          return;
        }
        const event = JSON.parse(line);
        if (event.type === "start") {
          if (!callRequest) showDanmaku(event.item);
          personaName = event.persona?.name || personaName;
          speaker.textContent = `${personaName} → ${event.item.user}`;
          setLive2DEmotion(event.emotion?.name || "neutral");
        } else if (event.type === "preface") {
          subtitle.textContent = event.text;
          queueSpeech(event.text);
        } else if (event.type === "delta") {
          fullText += event.text;
          subtitle.textContent = fullText;
          brainStatus.title = event.mode === "local-stream" ? "本轮路由：本地千问流式" : "本轮路由：DeepSeek 流式";
          if (!earlySentenceQueued && (!callRequest || fullText.length > 100)) {
            for (const match of fullText.matchAll(/[。！？!?；;]+[”’」』】）)]*/g)) {
              const end = match.index + match[0].length;
              if (end >= 18) {
                queueSpeech(fullText.slice(0, end));
                queuedPrefixLength = end;
                earlySentenceQueued = true;
                break;
              }
            }
          }
        } else if (event.type === "done") {
          if (callRequest && typeof voiceCallTiming !== "undefined") {
            voiceCallTiming.textContent += ` · 模型完整回复 ${event.timing?.approvedDeltaMs ?? "?"}ms（首字 ${event.timing?.firstTokenMs ?? "?"}ms，${event.routing?.route === "local" ? "千问" : event.routing?.route || "未知路由"}）`;
          }
          receivedDone = true;
          const remaining = fullText.slice(queuedPrefixLength);
          if (remaining.trim()) queueSpeech(remaining);
          break;
        } else if (event.type === "error") {
          throw new Error(event.error || "流式回复失败");
        }
      }
    }
    if (!receivedDone) throw new Error("流式回复在完成事件前结束");
    await reader.cancel();
    await speechChain;
  } catch (error) {
    cancelStreamSpeech();
    if (error.name !== "AbortError") throw error;
  } finally {
    if (activeReplyController === replyController) {
      activeReplyController = null;
      isReading = false;
    }
  }
}

async function submitDanmaku(text) {
  if (voiceCall) return;
  sendDanmaku.disabled = true;
  composerStatus.textContent = "主播正在看弹幕...";
  try {
    void holdConversation(12_000);
    const created = await api("/api/danmaku", {
      method: "POST",
      body: JSON.stringify({ user: viewerName.value.trim() || "测试观众", text, type: "chat", training: trainingMemory.checked, delivery: "stream" })
    });
    showDanmaku(created.item);
    danmakuInput.value = "";
    await readNextStreaming(created.item.id);
    await poll();
    composerStatus.textContent = created.suppressed
      ? "重复弹幕过多，主播这次先不读"
      : created.duplicate ? `重复弹幕已降权排队，第 ${created.repeatCount} 次重复` : "已读出并生成回复";
  } catch (error) {
    composerStatus.textContent = "发送失败，请查看开发者调试页";
  } finally {
    sendDanmaku.disabled = false;
    danmakuInput.focus();
  }
}

composer.addEventListener("submit", async event => {
  event.preventDefault();
  const text = danmakuInput.value.trim();
  if (!text) return;
  await submitDanmaku(text);
});

async function startRecording() {
  if (mediaRecorder?.state === "recording") return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    voiceStatus.textContent = "当前浏览器不支持麦克风录音";
    return;
  }
  try {
    stopSpeechOutput();
    await holdConversation(MAX_RECORDING_MS + 25_000);
    isAsrBusy = true;
    voiceButton.disabled = true;
    voiceButton.textContent = "正在连接麦克风...";
    voiceStatus.textContent = "正在请求浏览器麦克风权限...";
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
    await refreshMicrophoneChoices();
    startMicMeter(microphoneStream);
    nativeAsrSession = await startNativeAsr(microphoneStream);
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(microphoneStream, { mimeType });
    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data.size) recordingChunks.push(event.data);
      if (!nativeAsrSession?.active && Date.now() - partialAsrLastAt >= 1200) void requestPartialTranscript();
    });
    mediaRecorder.addEventListener("stop", processRecording, { once: true });
    mediaRecorder.start(800);
    voiceButton.classList.add("recording");
    voiceButton.disabled = false;
    voiceButton.setAttribute("aria-pressed", "true");
    voiceButton.textContent = "结束并发送";
    voiceStatus.textContent = "正在听你说话...";
    recordingStartedAt = Date.now();
    vadSpeechDetected = false;
    vadSilenceStartedAt = 0;
    vadSpeechCandidateAt = 0;
    bargeInActive = false;
    partialAsrText = "";
    partialAsrLastAt = 0;
    recordingDeadline = Date.now() + MAX_RECORDING_MS;
    recordingTimer = setTimeout(stopRecording, MAX_RECORDING_MS);
  } catch (error) {
    void nativeAsrSession?.cancel();
    nativeAsrSession = null;
    isAsrBusy = false;
    voiceButton.disabled = false;
    voiceButton.textContent = "语音发弹幕";
    voiceStatus.textContent = `麦克风未启用：${error.name || "unknown"} ${error.message || ""}`;
    void releaseConversation();
  }
}

function microphoneConstraints() {
  const selectedId = microphoneSelect.value;
  return {
    deviceId: selectedId ? { exact: selectedId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
}

async function refreshMicrophoneChoices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const selected = microphoneSelect.value || localStorage.getItem("streamer-microphone-id") || "";
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter(device => device.kind === "audioinput");
  microphoneSelect.innerHTML = '<option value="">系统默认麦克风</option>';
  microphones.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `麦克风 ${index + 1}`;
    microphoneSelect.append(option);
  });
  microphoneSelect.value = [...microphoneSelect.options].some(option => option.value === selected) ? selected : "";
  if (microphoneSelect.value) localStorage.setItem("streamer-microphone-id", microphoneSelect.value);
}

function applyVoiceProvider(provider, announce = true) {
  voiceProvider = provider === "gpt-sovits" ? "gpt-sovits" : "browser";
  voiceProviderSelect.value = voiceProvider;
  localStorage.setItem("streamer-voice-provider", voiceProvider);
  stopSpeechOutput();
  if (announce) composerStatus.textContent = voiceProvider === "gpt-sovits"
    ? "已选择希儿 GPT-SoVITS；服务失败将报错，不会自动切换系统声音"
    : "语音来源已切换为系统机器声音";
}

function startMicMeter(stream) {
  stopMicMeter();
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  audioAnalyser = audioContext.createAnalyser();
  audioAnalyser.fftSize = 1024;
  audioMeterData = new Uint8Array(audioAnalyser.fftSize);
  source.connect(audioAnalyser);
  const renderMeter = () => {
    audioAnalyser.getByteTimeDomainData(audioMeterData);
    let squareSum = 0;
    for (const sample of audioMeterData) {
      const value = (sample - 128) / 128;
      squareSum += value * value;
    }
    const rms = Math.sqrt(squareSum / audioMeterData.length);
    micLevelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const percent = Math.min(100, Math.max(0, (micLevelDb + 65) * 2.1));
    micMeterFill.style.width = `${percent}%`;
    micMeterFill.classList.toggle("loud", micLevelDb > -16);
    const remaining = Math.max(0, Math.ceil((recordingDeadline - Date.now()) / 1000));
    const level = Number.isFinite(micLevelDb) ? `${micLevelDb.toFixed(1)}dB` : "-∞dB";
    const silent = Date.now() - recordingStartedAt > 1500 && micLevelDb < -50;
    const aiSpeaking = Boolean(activeTtsControllers.size || activeReplyController || activeStreamSources.size || activeAudio);
    const threshold = aiSpeaking ? -30 : -38;
    if (micLevelDb > threshold) {
      if (!vadSpeechDetected && aiSpeaking) {
        vadSpeechCandidateAt ||= Date.now();
        if (Date.now() - vadSpeechCandidateAt >= 280) {
          const bargeInStartedAt = vadSpeechCandidateAt;
          stopSpeechOutput();
          recordClientLatency("barge_in_abort", Date.now() - bargeInStartedAt);
          bargeInActive = true;
          vadSpeechDetected = true;
          vadSilenceStartedAt = 0;
          subtitle.textContent = "（停下来听你说）";
        }
      } else {
        vadSpeechDetected = true;
        vadSpeechCandidateAt = 0;
        vadSilenceStartedAt = 0;
      }
    } else if (vadSpeechDetected && micLevelDb < -45) {
      vadSilenceStartedAt ||= Date.now();
      if (Date.now() - vadSilenceStartedAt >= 1100 && Date.now() - recordingStartedAt >= 1200) {
        voiceStatus.textContent = "检测到你已说完，正在提交识别...";
        stopRecording(true);
        return;
      }
    } else {
      if (!vadSpeechDetected) vadSpeechCandidateAt = 0;
      vadSilenceStartedAt = 0;
    }
    voiceStatus.textContent = bargeInActive
      ? `已打断主播，继续说完即可… ${partialAsrText}`
      : silent
      ? `几乎没有声音输入（${level}），请检查当前麦克风是否选对`
      : `正在听你说话... 输入音量 ${level}，还可录 ${remaining}s`;
    audioMeterFrame = requestAnimationFrame(renderMeter);
  };
  renderMeter();
}

function stopMicMeter() {
  if (audioMeterFrame) cancelAnimationFrame(audioMeterFrame);
  audioMeterFrame = null;
  audioAnalyser = null;
  audioMeterData = null;
  micMeterFill.style.width = "0";
  audioContext?.close();
  audioContext = null;
}

function stopRecording(keepContinuous = false) {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  if (!keepContinuous) continuousSessionActive = false;
  clearTimeout(recordingTimer);
  recordingDeadline = 0;
  recordingStartedAt = 0;
  mediaRecorder.stop();
  voiceButton.classList.remove("recording");
  voiceButton.setAttribute("aria-pressed", "false");
  voiceButton.textContent = keepContinuous ? "识别中…" : "语音发弹幕";
}

async function requestPartialTranscript() {
  if (partialAsrBusy || recordingChunks.length < 2) return;
  const blob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  if (blob.size < 2400) return;
  partialAsrBusy = true;
  partialAsrLastAt = Date.now();
  partialAsrController = new AbortController();
  try {
    const response = await fetch("/api/asr", { method: "POST", headers: { "content-type": blob.type }, body: blob, signal: partialAsrController.signal });
    const result = await response.json();
    if (response.ok && result.text) {
      partialAsrText = result.text;
      voiceStatus.textContent = bargeInActive ? `已打断主播，正在听：${partialAsrText}` : `正在听你说话… ${partialAsrText}`;
    }
  } catch (error) {
    if (error.name !== "AbortError") voiceStatus.textContent = "正在听你说话…部分转写暂不可用";
  } finally {
    partialAsrBusy = false;
    partialAsrController = null;
  }
}

async function startNativeAsr(stream) {
  if (!streamingAsrStatus?.ready || !streamingAsrStatus.endpoint) return null;
  const session = new StreamingAsrClient({
    url: streamingAsrStatus.endpoint,
    onTranscript: event => {
      partialAsrText = event.text;
      voiceStatus.textContent = event.isFinal
        ? `流式识别完成：${partialAsrText}`
        : `正在听你说话… ${partialAsrText}`;
    }
  });
  try {
    await session.start(stream);
    return session;
  } catch {
    await session.cancel();
    return null;
  }
}

async function processRecording() {
  partialAsrController?.abort();
  const nativeSession = nativeAsrSession;
  nativeAsrSession = null;
  let nativeFinal = null;
  if (nativeSession) {
    voiceStatus.textContent = "正在完成流式识别...";
    try { nativeFinal = await nativeSession.finish(); }
    catch { await nativeSession.cancel(); }
  }
  const stream = microphoneStream;
  microphoneStream = null;
  stopMicMeter();
  stream?.getTracks().forEach(track => track.stop());
  const blob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  mediaRecorder = null;
  const nativeText = nativeFinal?.text?.trim() || "";
  if (blob.size < 1200 && !nativeText) {
    isAsrBusy = false;
    voiceStatus.textContent = "没有收到足够的语音，请再试一次";
    return;
  }
  voiceButton.disabled = true;
  let rearmedForDuplex = false;
  try {
    let result;
    if (nativeText) {
      result = { text: nativeText, streaming: true };
    } else {
      voiceStatus.textContent = "正在本地识别...";
      const response = await fetch("/api/asr", { method: "POST", headers: { "content-type": blob.type }, body: blob });
      result = await response.json();
      if (!response.ok) throw new Error(result.error || "语音识别失败");
    }
    if (!result.text) {
      const audio = result.audio || {};
      voiceStatus.textContent = `未识别到文字：录音 ${audio.durationMs || 0}ms，音量 ${audio.rmsDb ?? "未知"}dB。请说完整一句再结束。`;
      return;
    }
    voiceStatus.textContent = result.streaming ? `流式识别完成：${result.text}` : `识别完成 ${result.latencyMs}ms：${result.text}`;
    if (continuousSessionActive && continuousListeningToggle.checked) {
      isAsrBusy = false;
      voiceButton.disabled = false;
      await startRecording();
      rearmedForDuplex = mediaRecorder?.state === "recording";
    }
    await submitDanmaku(result.text);
  } catch (error) {
    voiceStatus.textContent = `语音识别失败：${error.message}`;
  } finally {
    if (!rearmedForDuplex) {
      isAsrBusy = false;
      voiceButton.disabled = false;
    }
    void releaseConversation();
    if (!rearmedForDuplex && continuousSessionActive && continuousListeningToggle.checked) {
      voiceButton.textContent = "即将继续聆听…";
      setTimeout(() => { if (continuousSessionActive && !isAsrBusy) void startRecording(); }, 350);
    } else {
      voiceButton.textContent = "语音发弹幕";
    }
  }
}

function toggleVoiceRecording() {
  if (voiceCall) return;
  if (mediaRecorder?.state === "recording") stopRecording();
  else {
    continuousSessionActive = false;
    startRecording();
  }
}

continuousListeningToggle.addEventListener("change", () => {
  localStorage.setItem("streamer-continuous-listening", continuousListeningToggle.checked ? "on" : "off");
  if (!continuousListeningToggle.checked) continuousSessionActive = false;
});

voiceButton.addEventListener("pointerdown", event => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (voiceButton.disabled) return;
  ignoreVoiceClick = true;
  event.preventDefault();
  toggleVoiceRecording();
  setTimeout(() => { ignoreVoiceClick = false; }, 250);
});

voiceButton.addEventListener("click", () => {
  if (ignoreVoiceClick || voiceButton.disabled) return;
  toggleVoiceRecording();
});

function interruptVoiceCall(call) {
  if (voiceCall !== call || call.ending) return;
  call.revision += 1;
  call.continuedText = "";
  stopSpeechOutput();
  voiceStatus.textContent = "听你说话中…（已取消上一条语音）";
}

async function processVoiceCallTurn(call, blob, sequence, revision, continuation, segmentedAt = performance.now()) {
  if (voiceCall !== call) return;
  await call.ready;
  const asrStartedAt = performance.now();
  const response = await fetch("/api/asr", { method: "POST", headers: { "content-type": blob.type }, body: blob, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (typeof voiceCallTiming !== "undefined") voiceCallTiming.textContent = `分句静音 550ms · 排队 ${Math.round(asrStartedAt - segmentedAt)}ms · 识别 ${Math.round(performance.now() - asrStartedAt)}ms`;
  if (!response.ok) throw new Error(result.error || "语音识别失败");
  if (!result.text?.trim()) return;
  const text = result.text.trim();
  const path = `/api/voice-calls/${call.id}/turn`;
  // Keep input even when a newer utterance has cancelled the old answer.
  if (call.ending || revision !== call.revision || continuation) {
    await api(path, { method: "POST", body: JSON.stringify({ sequence, text, interrupted: true }) });
    if (continuation && revision === call.revision) call.continuedText += text;
    return;
  }
  voiceStatus.textContent = `第 ${sequence} 段：${text}`;
  const combined = call.continuedText + text;
  call.continuedText = "";
  await readNextStreaming(null, { path, body: { sequence, text: combined }, startedAt: segmentedAt });
}

async function endVoiceCall() {
  const call = voiceCall;
  if (!call || call.ending) return;
  call.ending = true;
  voiceCallButton.disabled = true;
  stopSpeechOutput();
  voiceStatus.textContent = "正在结束通话并保存最后一段…";
  try {
    // Finalize the last utterance without generating another spoken answer.
    await call.controller.stop({ finalize: true });
    await call.queue;
    await api(`/api/voice-calls/${call.id}/end`, { method: "POST", body: "{}" });
    voiceStatus.textContent = call.failures ? `通话已结束；有 ${call.failures} 段识别或保存失败，请检查记录。` : "通话已结束，已识别的轮次已保存。";
  } catch (error) {
    voiceStatus.textContent = `麦克风已关闭；通话保存异常：${error.message}`;
  } finally {
    clearInterval(call.holdTimer);
    voiceCall = null;
    voiceCallButton.disabled = false;
    voiceCallButton.textContent = "开始语音通话";
    voiceCallButton.setAttribute("aria-pressed", "false");
    voiceButton.disabled = false;
    microphoneSelect.disabled = false;
    sendDanmaku.disabled = false;
    micMeterFill.style.width = "0%";
    void releaseConversation();
  }
}

async function startVoiceCall() {
  if (voiceCall || isAsrBusy || mediaRecorder?.state === "recording") return;
  const call = { id: null, controller: null, queue: Promise.resolve(), revision: 0, ending: false, pending: 0, failures: 0, continuedText: "" };
  voiceCall = call;
  voiceCallButton.disabled = true;
  voiceButton.disabled = true;
  microphoneSelect.disabled = true;
  sendDanmaku.disabled = true;
  stopSpeechOutput();
  try {
    call.ready = api("/api/voice-calls/start", { method: "POST", body: JSON.stringify({ user: viewerName.value.trim() || "测试观众" }) }).then(result => { call.id = result.call.id; });
    call.ready.catch(() => {});
    call.controller = new VoiceCallController({
      constraints: { audio: microphoneConstraints() },
      onSpeechStart: () => interruptVoiceCall(call),
      onLevel: ({ rms, threshold, voiceRms }) => {
        micMeterFill.style.width = `${Math.min(100, rms * 900)}%`;
        if (typeof voiceCallCalibration !== "undefined") {
          const db = value => value > 0 ? `${Math.round(20 * Math.log10(value))} dBFS` : "学习中";
          voiceCallCalibration.textContent = `输入 ${db(rms)} · 正常音量 ${db(voiceRms)} · 触发阈值 ${db(threshold)} / 持续 120ms`;
        }
      },
      onStatus: status => {
        if (voiceCall !== call || call.ending) return;
        if (status.state === "active") voiceStatus.textContent = "通话中：请直接说话，停顿自动分句";
        if (status.state === "turn-error") voiceStatus.textContent = `本段失败，可继续说话：${status.error?.message}`;
      },
      onTurn: (blob, sequence, signal, { continuation }) => {
        const revision = call.revision;
        const segmentedAt = performance.now();
        if (call.pending >= 8) {
          call.failures++;
          voiceStatus.textContent = "识别积压，本段未保存，请稍等后重说。";
          return;
        }
        call.pending++;
        const work = call.queue.then(() => processVoiceCallTurn(call, blob, sequence, revision, continuation, segmentedAt));
        call.queue = work.catch(error => {
          call.failures++;
          voiceStatus.textContent = `第 ${sequence} 段未完成：${error.message}；可继续说话`;
        }).finally(() => { call.pending--; });
        return call.queue;
      }
    });
    // Resume Web Audio from the user gesture before waiting for server IO.
    await call.controller.start();
    await call.ready;
    voiceCallRecord.href = `/api/voice-calls/${call.id}`;
    voiceCallRecord.hidden = false;
    await holdConversation(30_000);
    call.holdTimer = setInterval(() => { void holdConversation(30_000).catch(() => {}); }, 15_000);
    voiceCallButton.textContent = "结束语音通话";
    voiceCallButton.setAttribute("aria-pressed", "true");
    voiceCallButton.disabled = false;
  } catch (error) {
    await call.controller?.stop();
    await call.ready?.catch(() => {});
    if (call.id) await api(`/api/voice-calls/${call.id}/end`, { method: "POST", body: "{}" }).catch(() => {});
    voiceCall = null;
    voiceCallButton.disabled = false;
    voiceButton.disabled = false;
    microphoneSelect.disabled = false;
    sendDanmaku.disabled = false;
    voiceStatus.textContent = `无法开始通话：${error.message}`;
  }
}

voiceCallButton.addEventListener("click", () => { void (voiceCall ? endVoiceCall() : startVoiceCall()); });

danmakuInput.addEventListener("input", () => {
  typingHoldUntil = Date.now() + 1200;
  void holdConversation(4_000);
});

chatModeToggle.addEventListener("change", () => setChatMode(chatModeToggle.checked));
speechOutputToggle.addEventListener("change", () => setAudioOutput(speechOutputToggle.checked));
voiceProviderSelect.addEventListener("change", () => applyVoiceProvider(voiceProviderSelect.value));
microphoneSelect.addEventListener("change", () => {
  localStorage.setItem("streamer-microphone-id", microphoneSelect.value);
  voiceStatus.textContent = microphoneSelect.value ? `已选择：${microphoneSelect.selectedOptions[0]?.textContent || "麦克风"}` : "已选择系统默认麦克风";
});
audioOutputChannel?.addEventListener("message", event => {
  audioOutputSyncUntil = Date.now() + 5_000;
  applyAudioOutput(Boolean(event.data?.enabled), false);
});
window.addEventListener("storage", event => {
  if (event.key === "streamer-audio-output") {
    audioOutputSyncUntil = Date.now() + 5_000;
    applyAudioOutput(event.newValue !== "off", false);
  }
});
trainingMemory.addEventListener("change", () => {
  localStorage.setItem("streamer-training-memory", trainingMemory.checked ? "on" : "off");
  composerStatus.textContent = trainingMemory.checked
    ? "训练素材已开启：本条只进入本场临时记忆，稍后由工作台提炼"
    : "训练素材已关闭：本条只作为普通会话上下文";
});

async function boot() {
  applyAudioOutput(audioOutputEnabled);
  applyVoiceProvider(voiceProvider, false);
  enableComposerDrag();
  await refreshMicrophoneChoices();
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicrophoneChoices);
  try {
    const state = await api("/api/state");
    personaName = state.persona?.name || personaName;
    speaker.textContent = personaName;
    await startLive2D({ container: document.querySelector("#live2d-stage"), modelPath: state.avatar.live2dModelPath });
    fallback.hidden = true;
  } catch (error) {
    modelError.textContent = `Live2D 未加载：${error.message}。当前使用后备形象。`;
  }
  await pollSafely();
  await refreshModuleStatus();
  setInterval(() => void pollSafely(), 1800);
  setInterval(() => void refreshModuleStatus(), 10_000);
  setInterval(() => void readNextSafely(), 1100);
}

boot();
