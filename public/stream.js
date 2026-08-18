import { setLive2DEmotion, setLive2DMouth, startLive2D } from "./live2d-renderer.js";

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
let activeAudio = null;
let finishActiveSpeech = null;
let activeTtsController = null;
let speechEpoch = 0;
let audioOutputSyncUntil = 0;
let audioOutputRequestId = 0;
let pollFailures = 0;
let audioOutputEnabled = localStorage.getItem("streamer-audio-output") !== "off";
let ttsAudioContext;
let ttsLipSyncFrame;
const MAX_RECORDING_MS = 90_000;
const audioOutputChannel = "BroadcastChannel" in window ? new BroadcastChannel("streamer-audio-output") : null;

trainingMemory.checked = localStorage.getItem("streamer-training-memory") !== "off";

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
  const controller = new AbortController();
  activeTtsController = controller;
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, style: { speechRate: profile.speechRate || 1, pitch: profile.pitch || 0, energy: profile.energy, pauseMs: profile.pauseMs, emotion: profile.expression || "neutral", regulation: profile.regulation, valence: profile.valence, arousal: profile.arousal, dominance: profile.dominance, tension: profile.tension, expressibility: profile.expressibility } }),
      signal: controller.signal
    });
    if (response.ok) {
      if (!audioOutputEnabled || epoch !== speechEpoch) return;
      const audio = new Audio(URL.createObjectURL(await response.blob()));
      activeAudio = audio;
      const stopLipSync = await startAmplitudeLipSync(audio);
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(audio.src);
          if (activeAudio === audio) activeAudio = null;
          if (finishActiveSpeech === finish) finishActiveSpeech = null;
          setLive2DMouth(false);
          stopLipSync();
          resolve();
        };
        finishActiveSpeech = finish;
        audio.onended = finish;
        audio.onerror = finish;
        audio.play().catch(error => { finish(); reject(error); });
      });
      return true;
    } else {
      throw new Error("backend TTS unavailable");
    }
  } catch (error) {
    if (error.name !== "AbortError" && audioOutputEnabled && epoch === speechEpoch) return browserSpeak(text, profile, epoch);
    return false;
  } finally {
    if (activeTtsController === controller) activeTtsController = null;
  }
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
    utterance.onend = finish;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  });
}

function stopSpeechOutput() {
  speechEpoch += 1;
  clearInterval(speakingTimer);
  activeTtsController?.abort();
  activeTtsController = null;
  activeAudio?.pause();
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
  renderLatestSpeech(state.latestSpeech);
  const llm = state.llm;
  chatModeToggle.checked = Boolean(state.scene?.chatEnabled);
  if (Date.now() >= audioOutputSyncUntil && typeof state.audioOutput?.enabled === "boolean" && state.audioOutput.enabled !== audioOutputEnabled) {
    applyAudioOutput(state.audioOutput.enabled, false);
  }
  chatModeLabel.textContent = state.scene?.chatSuspended ? "主动陪聊：等待回应" : "主动陪聊";
  brainStatus.textContent = llm.lastMode === "external"
    ? `DeepSeek ${llm.lastLatencyMs || ""}ms`
    : llm.enabled ? "DeepSeek 待测试" : "本地备用大脑";
  if (!isAsrBusy && (!mediaRecorder || mediaRecorder.state === "inactive")) {
    voiceStatus.textContent = state.asr.backendReady
      ? `本地识别已就绪：${state.asr.backend.model}`
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
  if (isReading || isRecording || isTyping) return;
  isReading = true;
  let spoke = false;
  try {
    const result = await api("/api/next", { method: "POST", body: JSON.stringify({ preferFresh: true }) });
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

async function submitDanmaku(text) {
  sendDanmaku.disabled = true;
  composerStatus.textContent = "主播正在看弹幕...";
  try {
    void holdConversation(12_000);
    const created = await api("/api/danmaku", {
      method: "POST",
      body: JSON.stringify({ user: viewerName.value.trim() || "测试观众", text, type: "chat", training: trainingMemory.checked })
    });
    showDanmaku(created.item);
    danmakuInput.value = "";
    await readNext();
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
    await holdConversation(MAX_RECORDING_MS + 25_000);
    isAsrBusy = true;
    voiceButton.disabled = true;
    voiceButton.textContent = "正在连接麦克风...";
    voiceStatus.textContent = "正在请求浏览器麦克风权限...";
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
    await refreshMicrophoneChoices();
    startMicMeter(microphoneStream);
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(microphoneStream, { mimeType });
    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data.size) recordingChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", processRecording, { once: true });
    mediaRecorder.start();
    voiceButton.classList.add("recording");
    voiceButton.disabled = false;
    voiceButton.setAttribute("aria-pressed", "true");
    voiceButton.textContent = "结束并发送";
    voiceStatus.textContent = "正在听你说话...";
    recordingDeadline = Date.now() + MAX_RECORDING_MS;
    recordingTimer = setTimeout(stopRecording, MAX_RECORDING_MS);
  } catch (error) {
    isAsrBusy = false;
    voiceButton.disabled = false;
    voiceButton.textContent = "开始说话";
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
  const selected = microphoneSelect.value;
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
    voiceStatus.textContent = `正在听你说话... 输入音量 ${Number.isFinite(micLevelDb) ? micLevelDb.toFixed(1) : "-∞"}dB，还可录 ${remaining}s`;
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

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  clearTimeout(recordingTimer);
  recordingDeadline = 0;
  mediaRecorder.stop();
  voiceButton.classList.remove("recording");
  voiceButton.setAttribute("aria-pressed", "false");
  voiceButton.textContent = "开始说话";
}

async function processRecording() {
  const stream = microphoneStream;
  microphoneStream = null;
  stopMicMeter();
  stream?.getTracks().forEach(track => track.stop());
  const blob = new Blob(recordingChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  mediaRecorder = null;
  if (blob.size < 1200) {
    isAsrBusy = false;
    voiceStatus.textContent = "没有收到足够的语音，请再试一次";
    return;
  }
  voiceButton.disabled = true;
  try {
    voiceStatus.textContent = "正在本地识别...";
    const response = await fetch("/api/asr", { method: "POST", headers: { "content-type": blob.type }, body: blob });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "语音识别失败");
    if (!result.text) {
      const audio = result.audio || {};
      voiceStatus.textContent = `未识别到文字：录音 ${audio.durationMs || 0}ms，音量 ${audio.rmsDb ?? "未知"}dB。请说完整一句再结束。`;
      return;
    }
    voiceStatus.textContent = `识别完成 ${result.latencyMs}ms：${result.text}`;
    await submitDanmaku(result.text);
  } catch (error) {
    voiceStatus.textContent = `语音识别失败：${error.message}`;
  } finally {
    isAsrBusy = false;
    voiceButton.disabled = false;
    void releaseConversation();
  }
}

function toggleVoiceRecording() {
  if (mediaRecorder?.state === "recording") stopRecording();
  else startRecording();
}

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

danmakuInput.addEventListener("input", () => {
  typingHoldUntil = Date.now() + 1200;
  void holdConversation(4_000);
});

chatModeToggle.addEventListener("change", () => setChatMode(chatModeToggle.checked));
speechOutputToggle.addEventListener("change", () => setAudioOutput(speechOutputToggle.checked));
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
  setInterval(() => void pollSafely(), 1800);
  setInterval(() => void readNextSafely(), 1100);
}

boot();
