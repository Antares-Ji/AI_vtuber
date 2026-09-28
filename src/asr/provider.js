const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const INCOMING_DIR = path.join(ROOT, "runtime", "asr", "incoming");
const LOCAL_ASR_ENV = path.join(ROOT, "runtime", "asr-env");

function getAsrConfig() {
  const baseUrl = process.env.ASR_BASE_URL || "http://127.0.0.1:10095";
  const ffmpegPath = resolveFfmpegPath();
  return {
    provider: process.env.ASR_PROVIDER || "funasr-local",
    baseUrl,
    model: process.env.ASR_MODEL || "iic/SenseVoiceSmall",
    ffmpegReady: require("fs").existsSync(ffmpegPath),
    ffmpegPath,
  };
}

function resolveFfmpegPath() {
  const configured = process.env.ASR_FFMPEG_PATH;
  if (configured && require("fs").existsSync(configured)) return configured;
  const candidates = [
    path.join(LOCAL_ASR_ENV, "Scripts", "ffmpeg.exe"),
    path.join(ROOT, "runtime", "ffmpeg.exe")
  ];
  for (const candidate of candidates) if (require("fs").existsSync(candidate)) return candidate;
  const binaries = path.join(LOCAL_ASR_ENV, "Lib", "site-packages", "imageio_ffmpeg", "binaries");
  try {
    const match = require("fs").readdirSync(binaries).find(name => /^ffmpeg-.*\.exe$/i.test(name));
    if (match) return path.join(binaries, match);
  } catch {}
  return configured || "ffmpeg";
}

async function getAsrStatus() {
  const config = getAsrConfig();
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(800) });
    const health = response.ok ? await response.json() : null;
    return { ...config, backendReady: health?.ready === true, backend: health };
  } catch {
    return { ...config, backendReady: false, backend: null };
  }
}

async function transcribeAudio(audioBuffer, signal = undefined) {
  const config = getAsrConfig();
  if (!config.ffmpegReady) throw new Error("ASR ffmpeg is missing");
  throwIfAborted(signal);
  await fs.mkdir(INCOMING_DIR, { recursive: true });
  const id = randomUUID();
  const sourcePath = path.join(INCOMING_DIR, `${id}.webm`);
  const wavPath = path.join(INCOMING_DIR, `${id}.wav`);
  try {
    await fs.writeFile(sourcePath, audioBuffer);
    throwIfAborted(signal);
    await convertToWav(config.ffmpegPath, sourcePath, wavPath, signal);
    throwIfAborted(signal);
    const wav = await fs.readFile(wavPath);
    const audio = analyzeWav(wav);
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
      signal: requestSignal(signal, 30_000)
    });
    if (!response.ok) throw new Error(`ASR HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
    return { ...(await response.json()), audio };
  } finally {
    await Promise.all([fs.unlink(sourcePath).catch(() => {}), fs.unlink(wavPath).catch(() => {})]);
  }
}

function analyzeWav(wav) {
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitDepth = 16;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const valueOffset = offset + 8;
    if (id === "fmt " && length >= 16) {
      channels = wav.readUInt16LE(valueOffset + 2);
      sampleRate = wav.readUInt32LE(valueOffset + 4);
      bitDepth = wav.readUInt16LE(valueOffset + 14);
    }
    if (id === "data") {
      dataOffset = valueOffset;
      dataLength = length;
      break;
    }
    offset = valueOffset + length + (length % 2);
  }
  if (!dataOffset || bitDepth !== 16) return { durationMs: 0, rmsDb: null };
  let squareSum = 0;
  let count = 0;
  for (let index = dataOffset; index + 1 < dataOffset + dataLength; index += 2) {
    const sample = wav.readInt16LE(index) / 32768;
    squareSum += sample * sample;
    count += 1;
  }
  const rms = count ? Math.sqrt(squareSum / count) : 0;
  return {
    durationMs: Math.round((dataLength / (sampleRate * channels * 2)) * 1000),
    rmsDb: rms ? Number((20 * Math.log10(rms)).toFixed(1)) : -Infinity
  };
}

function convertToWav(ffmpegPath, sourcePath, wavPath, signal = undefined) {
  return new Promise((resolve, reject) => {
    let child;
    let error = "";
    let settled = false;
    let abortRequested = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      abortRequested = true;
      // Do not reject yet: on Windows an ffmpeg handle can still hold the
      // temporary source/destination files until its close event fires.
      try { child?.kill(); } catch {}
    };
    try {
      child = spawn(ffmpegPath, ["-y", "-i", sourcePath, "-ac", "1", "-ar", "16000", "-f", "wav", wavPath], { windowsHide: true });
    } catch (failure) {
      finish(reject, failure);
      return;
    }
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", failure => {
      // A process that could not be spawned has no files to release. A killed
      // child instead reaches close, which is deliberately awaited below.
      if (!abortRequested) finish(reject, failure);
    });
    child.on("close", code => {
      if (abortRequested || signal?.aborted) return finish(reject, abortError());
      if (code === 0) return finish(resolve);
      return finish(reject, new Error(`ffmpeg failed (${code}): ${error.slice(-240)}`));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return new DOMException("ASR transcription cancelled", "AbortError");
}

module.exports = { getAsrConfig, getAsrStatus, transcribeAudio, resolveFfmpegPath, convertToWav };
