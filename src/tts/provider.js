const { CircuitBreaker } = require("../runtime/circuit-breaker");
const { TTS_EMOTIONS } = require("./style");
const ttsCircuit = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000 });

function getTtsStatus() {
  const provider = process.env.TTS_PROVIDER || "browser-speech-synthesis";
  const gptSovitsReady = Boolean(
    process.env.GPT_SOVITS_BASE_URL &&
    process.env.GPT_SOVITS_REF_AUDIO &&
    process.env.GPT_SOVITS_PROMPT_TEXT
  );
  return {
    provider,
    voiceHint: process.env.TTS_VOICE_HINT || "zh",
    profile: process.env.GPT_SOVITS_PROFILE || "default",
    emotionProfiles: configuredEmotionProfiles(),
    backendReady: provider === "gpt-sovits" ? gptSovitsReady : false,
    circuit: ttsCircuit.status(),
    note: provider === "gpt-sovits"
      ? "GPT-SoVITS 配置就绪后，前端会优先请求本地语音服务。"
      : "当前使用浏览器 TTS。把 TTS_PROVIDER 改为 gpt-sovits 后可切换本地服务。"
  };
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function synthesizeWithGptSovits(text, style = {}) {
  const status = getTtsStatus();
  if (status.provider !== "gpt-sovits") throw new Error("TTS provider is not gpt-sovits");
  if (!status.backendReady) throw new Error("GPT-SoVITS 配置不完整：需要参考音频路径和参考文本");
  if (!ttsCircuit.canRequest()) throw new Error("GPT-SoVITS 连续失败，正在短暂冷却并使用浏览器语音");

  const baseUrl = process.env.GPT_SOVITS_BASE_URL.replace(/\/$/, "");
  const emotionSampling = samplingForStyle(style);
  const reference = referenceForStyle(style);
  let response;
  try {
    response = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
      text,
      text_lang: process.env.GPT_SOVITS_TEXT_LANG || "zh",
      ref_audio_path: reference.audioPath,
      prompt_text: reference.promptText,
      prompt_lang: process.env.GPT_SOVITS_PROMPT_LANG || "zh",
      media_type: "wav",
      text_split_method: "cut5",
      top_k: numberEnv("GPT_SOVITS_TOP_K", 12),
      top_p: Math.min(1, Math.max(0.5, numberEnv("GPT_SOVITS_TOP_P", 0.82) + emotionSampling.topPDelta)),
      temperature: Math.min(1, Math.max(0.25, numberEnv("GPT_SOVITS_TEMPERATURE", 0.65) + emotionSampling.temperatureDelta)),
      repetition_penalty: numberEnv("GPT_SOVITS_REPETITION_PENALTY", 1.2),
      speed_factor: Math.min(1.16, Math.max(0.84, numberEnv("GPT_SOVITS_SPEED", 0.96) * Number(style.speechRate || 1))),
      fragment_interval: numberEnv("GPT_SOVITS_FRAGMENT_INTERVAL", 0.22),
      seed: numberEnv("GPT_SOVITS_SEED", -1)
      }),
      signal: AbortSignal.timeout(45_000)
    });
  } catch (error) {
    ttsCircuit.failure(error);
    throw error;
  }
  if (!response.ok || !response.body) {
    ttsCircuit.failure(`GPT-SoVITS HTTP ${response.status}`);
    throw new Error(`GPT-SoVITS HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
  }
  ttsCircuit.success();
  return response;
}

function referenceForStyle(style = {}) {
  const profile = String(style.emotion || "neutral").replace(/[^a-z0-9_]/gi, "_").toUpperCase();
  const audioPath = process.env[`GPT_SOVITS_REF_AUDIO_${profile}`];
  const promptText = process.env[`GPT_SOVITS_PROMPT_TEXT_${profile}`];
  if (audioPath && promptText) return { profile: profile.toLowerCase(), audioPath, promptText };
  return { profile: "default", audioPath: process.env.GPT_SOVITS_REF_AUDIO, promptText: process.env.GPT_SOVITS_PROMPT_TEXT };
}

function configuredEmotionProfiles() {
  return TTS_EMOTIONS
    .filter(name => process.env[`GPT_SOVITS_REF_AUDIO_${name.toUpperCase()}`] && process.env[`GPT_SOVITS_PROMPT_TEXT_${name.toUpperCase()}`]);
}

function samplingForEmotion(emotion, regulation) {
  const expressive = ["happy", "excited", "proud", "playful"].includes(emotion);
  const gentle = ["shy", "concerned", "sad", "relieved"].includes(emotion);
  const settling = ["settle", "down-regulate", "boundary"].includes(regulation);
  return { temperatureDelta: expressive ? 0.06 : gentle || settling ? -0.06 : 0, topPDelta: expressive ? 0.03 : gentle || settling ? -0.04 : 0 };
}

function samplingForStyle(style = {}) {
  const categorical = samplingForEmotion(style.emotion, style.regulation);
  const arousal = bounded(style.arousal, -1, 1, 0);
  const valence = bounded(style.valence, -1, 1, 0);
  const tension = bounded(style.tension, -1, 1, 0);
  const expressibility = bounded(style.expressibility, 0, 1, 0.5);
  const regulationBrake = ["settle", "down-regulate", "boundary"].includes(style.regulation) ? 0.035 : 0;
  return {
    temperatureDelta: bounded(categorical.temperatureDelta + arousal * 0.045 + (expressibility - 0.5) * 0.035 - tension * 0.02 - regulationBrake, -0.12, 0.12, 0),
    topPDelta: bounded(categorical.topPDelta + arousal * 0.02 + Math.max(0, valence) * 0.01 - regulationBrake * 0.6, -0.09, 0.07, 0)
  };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

module.exports = { getTtsStatus, synthesizeWithGptSovits, samplingForEmotion, samplingForStyle, referenceForStyle };
