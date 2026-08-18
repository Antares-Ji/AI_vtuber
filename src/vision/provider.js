const fs = require("fs/promises");
const syncFs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const PYTHON = path.join(ROOT, "runtime", "vision-env", "Scripts", "python.exe");
const ANALYZER = path.join(__dirname, "osu_analyzer.py");
const INCOMING = path.join(ROOT, "runtime", "vision", "incoming");
const OBSERVATIONS = path.join(ROOT, "data", "osu-observations.json");
let lastObservation = null;

function getVisionStatus() {
  return {
    provider: "opencv-local-v1",
    ready: syncFs.existsSync(PYTHON) && syncFs.existsSync(ANALYZER),
    mode: "screen-capture-analysis",
    lastObservation
  };
}

async function analyzeScreenshot(buffer, contentType = "image/png") {
  if (!getVisionStatus().ready) throw new Error("osu vision runtime is not ready");
  if (!buffer?.length) throw new Error("image is required");
  await fs.mkdir(INCOMING, { recursive: true });
  const extension = contentType.includes("jpeg") ? ".jpg" : ".png";
  const filePath = path.join(INCOMING, `${randomUUID()}${extension}`);
  try {
    await fs.writeFile(filePath, buffer);
    const result = await runAnalyzer(filePath);
    lastObservation = { ...result, at: new Date().toISOString(), source: "screen" };
    await appendObservation(lastObservation);
    return lastObservation;
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function recordTelemetry(input) {
  const observation = {
    at: new Date().toISOString(), source: "telemetry", scene: "osu-result",
    mapTitle: String(input.mapTitle || "未知谱面").slice(0, 120),
    accuracy: clampNumber(input.accuracy, 0, 100), misses: Math.max(0, Number(input.misses) || 0),
    combo: Math.max(0, Number(input.combo) || 0), mods: Array.isArray(input.mods) ? input.mods.slice(0, 8) : [],
    suggestions: trainingSuggestions(input)
  };
  lastObservation = observation;
  await appendObservation(observation);
  return observation;
}

function trainingSuggestions(input) {
  const suggestions = [];
  const accuracy = Number(input.accuracy || 0);
  const misses = Number(input.misses || 0);
  if (accuracy && accuracy < 90) suggestions.push("先降速练习节奏与读图，目标稳定到 95% 再提速");
  else if (accuracy && accuracy < 96) suggestions.push("重点检查偏早或偏晚，分段重复不稳定区间");
  if (misses >= 5) suggestions.push("记录 miss 时间点，区分读图、手速与瞄准问题");
  if ((input.mods || []).some(mod => /HR|DT/i.test(mod))) suggestions.push("与无 Mod 成绩对照，确认失误是否由视野或速度变化引起");
  if (!suggestions.length) suggestions.push("保存本次成绩作为基线，下一次比较准确率、miss 与最大连击");
  return suggestions;
}

const ANALYZER_TIMEOUT_MS = 15_000;
const MAX_ANALYZER_OUTPUT = 64 * 1024;

function runAnalyzer(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [ANALYZER, filePath], { windowsHide: true });
    let output = "";
    let error = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("vision analyzer timed out"));
    }, ANALYZER_TIMEOUT_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > MAX_ANALYZER_OUTPUT) {
        child.kill();
        finish(reject, new Error("vision analyzer stdout too large"));
      }
    });
    child.stderr.on("data", chunk => {
      error += chunk;
      if (error.length > MAX_ANALYZER_OUTPUT) error = error.slice(-MAX_ANALYZER_OUTPUT);
    });
    child.on("error", err => finish(reject, err));
    child.on("close", code => {
      if (code !== 0) return finish(reject, new Error(error || output || `vision exited ${code}`));
      try { finish(resolve, JSON.parse(output)); } catch { finish(reject, new Error(`invalid vision output: ${output.slice(0, 200)}`)); }
    });
  });
}

async function appendObservation(observation) {
  let data = [];
  try { data = JSON.parse(await fs.readFile(OBSERVATIONS, "utf8")); } catch {}
  data.push(observation);
  await fs.writeFile(OBSERVATIONS, JSON.stringify(data.slice(-500), null, 2), "utf8");
}

function clampNumber(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }

module.exports = { getVisionStatus, analyzeScreenshot, recordTelemetry };
