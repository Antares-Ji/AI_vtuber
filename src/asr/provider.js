const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const INCOMING_DIR = path.join(ROOT, "runtime", "asr", "incoming");
const DEFAULT_FFMPEG = "E:\\GPT-SoVITS-v2pro-20250604-nvidia50\\GPT-SoVITS-v2pro-20250604-nvidia50\\runtime\\ffmpeg.exe";

function getAsrConfig() {
  const baseUrl = process.env.ASR_BASE_URL || "http://127.0.0.1:10095";
  const ffmpegPath = process.env.ASR_FFMPEG_PATH || DEFAULT_FFMPEG;
  return {
    provider: process.env.ASR_PROVIDER || "funasr-local",
    baseUrl,
    model: process.env.ASR_MODEL || "iic/SenseVoiceSmall",
    ffmpegReady: require("fs").existsSync(ffmpegPath),
    ffmpegPath,
  };
}

async function getAsrStatus() {
  const config = getAsrConfig();
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(800) });
    const health = response.ok ? await response.json() : null;
    return { ...config, backendReady: Boolean(health), backend: health };
  } catch {
    return { ...config, backendReady: false, backend: null };
  }
}

async function transcribeAudio(audioBuffer) {
  const config = getAsrConfig();
  if (!config.ffmpegReady) throw new Error("ASR ffmpeg is missing");
  await fs.mkdir(INCOMING_DIR, { recursive: true });
  const id = randomUUID();
  const sourcePath = path.join(INCOMING_DIR, `${id}.webm`);
  const wavPath = path.join(INCOMING_DIR, `${id}.wav`);
  try {
    await fs.writeFile(sourcePath, audioBuffer);
    await convertToWav(config.ffmpegPath, sourcePath, wavPath);
    const wav = await fs.readFile(wavPath);
    const audio = analyzeWav(wav);
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
      signal: AbortSignal.timeout(30_000)
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

function convertToWav(ffmpegPath, sourcePath, wavPath) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, ["-y", "-i", sourcePath, "-ac", "1", "-ar", "16000", "-f", "wav", wavPath], { windowsHide: true });
    let error = "";
    process.stderr.on("data", chunk => { error += chunk; });
    process.on("error", reject);
    process.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${error.slice(-240)}`)));
  });
}

module.exports = { getAsrConfig, getAsrStatus, transcribeAudio };
