/**
 * provider.js —— Phase G：osu! 视觉 Node provider（schema v2）
 *
 * 职责：
 *  - 调用本地 Python 分析器（src/vision/python/analyzer.py，schemaVersion 2）
 *  - 校验并归一化子进程 JSON 输出（不无条件信任）
 *  - 同一客户端单飞行请求：新帧优先，过期帧丢弃，不堆积
 *  - Python 子进程超时/输出上限/临时图清理
 *  - observation 串行安全写入（限制容量）
 *  - 状态：provider/version、Python/OpenCV/OCR、队列、延迟、丢帧、脱敏错误
 *  - telemetry 兼容入口，但建议逻辑统一走 training-analyzer.js
 */
const fs = require("fs/promises");
const syncFs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const { analyzeObservations, normalizeObservation } = require("./training-analyzer");
const { sanitizeErrorMessage } = require("../runtime/redaction");

const ROOT = path.join(__dirname, "..", "..");
const PYTHON = path.join(ROOT, "runtime", "vision-env", "Scripts", "python.exe");
const ANALYZER = path.join(__dirname, "python", "analyzer.py");
const INCOMING = path.join(ROOT, "runtime", "vision", "incoming");
const OBSERVATIONS = path.join(ROOT, "data", "osu-observations.json");

const ANALYZER_TIMEOUT_MS = 15_000;
const MAX_ANALYZER_OUTPUT = 64 * 1024;
const MAX_OBSERVATIONS = 500;
const SCENE_ENUM = new Set(["gameplay", "results", "songSelect", "pause", "fail", "unknown"]);
const RESULT_FIELDS = ["accuracy", "misses", "maxCombo", "score", "grade"];

class VisionProvider {
  constructor() {
    this.status = {
      provider: "opencv-local-v2",
      version: 2,
      mode: "screen-capture-analysis",
      ready: false,
      python: { ready: false, version: null },
      opencv: { ready: false, version: null },
      ocr: { ready: false, note: null },
      queueLength: 0,
      avgLatencyMs: null,
      lastLatencyMs: null,
      droppedFrames: 0,
      lastError: null,
      lastObservation: null,
    };
    this.inFlight = false;
    this.pendingFrame = null;
    this.latencies = [];
    this.writeQueue = Promise.resolve();
    void this.inspectEnvironment();
  }

  async inspectEnvironment() {
    const pythonReady = syncFs.existsSync(PYTHON);
    const analyzerReady = syncFs.existsSync(ANALYZER);
    this.status.python.ready = pythonReady;
    this.status.ready = pythonReady && analyzerReady;
    if (!pythonReady) return;
    try {
      const result = await runPython(["-c", "import sys, cv2; print(sys.version.split()[0]); print(cv2.__version__)"]);
      const lines = String(result).trim().split(/\r?\n/).filter(Boolean);
      this.status.python.version = lines[0] || null;
      this.status.opencv.version = lines[1] || null;
      this.status.opencv.ready = Boolean(lines[1]);
      this.status.ocr = { ready: true, provider: "template-match", note: "合成图可测；真实图未评估" };
    } catch (error) {
      this.status.lastError = sanitizeErrorMessage(error, "vision environment inspect failed");
    }
  }

  getStatus() {
    return { ...this.status };
  }

  /** 单飞行并发：同一客户端只允许一个在途分析；新帧优先，过期帧丢弃。 */
  async analyzeScreenshot(buffer, contentType = "image/png") {
    if (!buffer?.length) throw new Error("image is required");
    if (!this.status.ready) throw new Error("osu vision runtime is not ready");

    if (this.inFlight) {
      // 已在分析：保留最新帧，丢弃旧帧，不堆积
      this.status.droppedFrames += 1;
      this.pendingFrame = { buffer, contentType };
      return { queued: true, droppedFrames: this.status.droppedFrames };
    }

    this.inFlight = true;
    try {
      // 循环处理：当前帧完成后若有更新的待处理帧则继续（只保留最新）
      let frame = { buffer, contentType };
      let result = null;
      for (;;) {
        const started = Date.now();
        this.status.queueLength = this.pendingFrame ? 1 : 0;
        result = await this.processFrame(frame.buffer, frame.contentType);
        this.status.lastLatencyMs = Date.now() - started;
        this.latencies.push(this.status.lastLatencyMs);
        if (this.latencies.length > 200) this.latencies.splice(0, this.latencies.length - 200);
        this.status.avgLatencyMs = Math.round(this.latencies.reduce((sum, value) => sum + value, 0) / this.latencies.length);
        if (!this.pendingFrame) break;
        frame = this.pendingFrame;
        this.pendingFrame = null;
      }
      return result;
    } finally {
      this.inFlight = false;
      this.pendingFrame = null;
      this.status.queueLength = 0;
    }
  }

  async processFrame(buffer, contentType) {
    const extension = contentType.includes("jpeg") ? ".jpg" : ".png";
    const filePath = path.join(INCOMING, `${randomUUID()}${extension}`);
    try {
      await fs.mkdir(INCOMING, { recursive: true });
      await fs.writeFile(filePath, buffer);
      const raw = await runPython([ANALYZER, filePath]);
      const parsed = JSON.parse(raw);
      const frame = validateFrame(parsed, filePath);
      const observation = { ...frame, at: new Date().toISOString(), source: "screen" };
      this.status.lastObservation = observation;
      void this.enqueueObservationWrite(observation);
      return observation;
    } catch (error) {
      this.status.lastError = sanitizeErrorMessage(error, "vision analyze failed");
      throw error;
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  }

  /** telemetry 兼容入口：手工录入结算，建议逻辑统一走 training-analyzer。 */
  async recordTelemetry(input) {
    const normalized = normalizeObservation({
      mapTitle: input.mapTitle,
      accuracy: input.accuracy,
      misses: input.misses,
      maxCombo: input.combo !== undefined ? input.combo : input.maxCombo,
      score: input.score,
      mods: input.mods,
    });
    const analysis = analyzeObservations([normalized]);
    const observation = {
      at: new Date().toISOString(),
      source: "telemetry",
      scene: "osu-result",
      mapTitle: normalized.mapTitle,
      accuracy: normalized.accuracy ?? null,
      misses: normalized.misses ?? null,
      combo: normalized.maxCombo ?? null,
      score: normalized.score ?? null,
      mods: normalized.mods,
      suggestions: analysis.suggestions.map(item => item.text),
    };
    this.status.lastObservation = observation;
    void this.enqueueObservationWrite(observation);
    return { ...observation, analysis };
  }

  /** observation 写入串行化：避免并发损坏；tmp+rename 原子替换；限制容量。 */
  enqueueObservationWrite(observation) {
    this.writeQueue = this.writeQueue.then(async () => {
      let data = [];
      try {
        data = JSON.parse(await fs.readFile(OBSERVATIONS, "utf8"));
        if (!Array.isArray(data)) data = [];
      } catch { /* 文件缺失或损坏则从空开始 */ }
      data.push(observation);
      const trimmed = data.slice(-MAX_OBSERVATIONS);
      const temporary = `${OBSERVATIONS}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(trimmed, null, 2), "utf8");
      await fs.rename(temporary, OBSERVATIONS);
    }).catch(error => {
      this.status.lastError = sanitizeErrorMessage(error, "observation write failed");
    });
    return this.writeQueue;
  }
}

/** 校验并归一化 Python 输出（不无条件信任子进程 JSON）。 */
function validateFrame(raw, filePath) {
  if (!raw || typeof raw !== "object") throw new Error("vision output is not an object");
  if (raw.error) throw new Error(`vision error: ${String(raw.error).slice(0, 200)}`);
  if (raw.schemaVersion !== 2) throw new Error(`unexpected schemaVersion: ${raw.schemaVersion}`);
  const scene = raw.scene || {};
  if (!SCENE_ENUM.has(scene.name)) throw new Error(`invalid scene name: ${scene.name}`);
  const confidence = Number(scene.confidence || 0);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("scene confidence out of bounds");

  const frame = raw.frame || {};
  const results = {};
  for (const key of RESULT_FIELDS) {
    const field = raw.results?.[key] || {};
    const value = field.value ?? null;
    const fieldConfidence = Number(field.confidence ?? 0);
    if (value !== null) {
      // 数值/枚举类型校验；不允许 0 冒充 null
      if (key === "grade" && typeof value !== "string") throw new Error(`grade must be a string: ${key}`);
      if (key !== "grade" && !["number", "string"].includes(typeof value)) throw new Error(`bad value type: ${key}`);
    }
    if (!Number.isFinite(fieldConfidence) || fieldConfidence < 0 || fieldConfidence > 1) throw new Error(`bad confidence: ${key}`);
    results[key] = { value, confidence: fieldConfidence };
  }
  return {
    schemaVersion: 2,
    frame: {
      width: Number(frame.width) || 0,
      height: Number(frame.height) || 0,
      quality: frame.quality || {},
    },
    scene: {
      name: scene.name,
      confidence,
      candidates: scene.candidates || {},
      evidence: Array.isArray(scene.evidence) ? scene.evidence : [],
    },
    results,
    timingMs: raw.timingMs || {},
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    ocr: raw.ocr || null,
    analyzerSource: filePath ? path.basename(filePath) : null,
  };
}

/** 运行 Python，返回 stdout；超时/输出上限/清理由调用方负责。 */
function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { windowsHide: true });
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
      finish(resolve, output.trim());
    });
  });
}

const provider = new VisionProvider();

module.exports = {
  getVisionStatus: () => provider.getStatus(),
  analyzeScreenshot: (buffer, contentType) => provider.analyzeScreenshot(buffer, contentType),
  recordTelemetry: input => provider.recordTelemetry(input),
  validateFrame,
  VisionProvider,
};
