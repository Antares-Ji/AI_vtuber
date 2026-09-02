/**
 * provider.js —— Phase G（返修）：osu! 视觉 Node provider（schema v2）
 *
 * 职责：
 *  - 调用本地 Python 分析器（schemaVersion 2）
 *  - validateFrame 严格校验：schema/场景/置信度/尺寸为结构错误（throw），
 *    结算字段业务范围非法（accuracy 越界、miss 负数、grade 非枚举）降级为 null
 *  - 单飞行并发：新帧优先，过期帧丢弃，不堆积
 *  - 子进程超时/输出上限/临时图清理
 *  - observation 串行安全写入（限容量）
 *  - **session-tracker 接入生产链路**：自动形成 开始→结算→一局完成 事件
 *  - **多局趋势**：telemetry 读取同谱面历史 observation 后聚合分析
 *  - 状态：provider/version、Python/OpenCV/OCR、队列、延迟、丢帧、session、脱敏错误
 */
const fs = require("fs/promises");
const syncFs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const { analyzeObservations, normalizeObservation } = require("./training-analyzer");
const { SessionTracker, STATE } = require("./session-tracker");
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
const GRADE_ENUM = new Set(["SS", "S", "A", "B", "C", "D", "X"]);
const RESULT_FIELDS = ["accuracy", "misses", "maxCombo", "score", "grade"];

class VisionProvider {
  constructor({ observationsPath = OBSERVATIONS } = {}) {
    this.observationsPath = observationsPath;
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
      session: { state: STATE.IDLE, sessionId: null },
    };
    this.inFlight = false;
    this.pendingFrame = null;
    this.latencies = [];
    this.writeQueue = Promise.resolve();
    this.tracker = new SessionTracker({
      gameplayDebounce: 2,
      resultsDebounce: 2,
      sessionTimeoutMs: 15 * 60 * 1000,
    });
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
      this.status.droppedFrames += 1;
      this.pendingFrame = { buffer, contentType };
      return { queued: true, droppedFrames: this.status.droppedFrames };
    }

    this.inFlight = true;
    try {
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

      // 接入一局状态机：单帧 -> 状态转换 -> 可能触发一局完成
      const track = this.tracker.ingest(frame);
      this.status.session = { state: track.state, sessionId: track.sessionId || null };

      const observation = {
        ...frame,
        at: new Date().toISOString(),
        source: "screen",
        tracker: { state: track.state, event: track.event },
      };
      this.status.lastObservation = observation;
      void this.enqueueObservationWrite(observation);

      // 一局完成：生成一次性结算 observation + 训练分析（不读原始图）
      let sessionResult = null;
      let sessionAnalysis = null;
      if (track.event === "session-complete" && track.session) {
        sessionResult = this.persistSessionComplete(track.session);
        const flat = sessionResult.flat;
        if (flat && typeof flat.accuracy === "number") {
          sessionAnalysis = analyzeObservations([normalizeObservation(flat)]);
        }
      }

      return { ...observation, sessionEvent: track.event, session: track.session, sessionResult, sessionAnalysis };
    } catch (error) {
      this.status.lastError = sanitizeErrorMessage(error, "vision analyze failed");
      throw error;
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  }

  /** 一局完成的结算事件：规范化字段 + 写入 observation（仅一次）。 */
  persistSessionComplete(session) {
    const flat = flattenResult(session.result);
    const observation = {
      at: new Date().toISOString(),
      source: "session-complete",
      scene: "osu-session",
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      frames: session.frames,
      averageConfidence: session.averageConfidence,
      mapTitle: null, // 屏幕截图无法自动识别谱面名；趋势需结合 telemetry 谱面记录
      ...flat,
    };
    this.status.lastObservation = observation;
    void this.enqueueObservationWrite(observation);
    return { observation, flat };
  }

  /** telemetry 兼容入口：读取同谱面历史后做多局趋势分析。 */
  async recordTelemetry(input) {
    const normalized = normalizeObservation({
      mapTitle: input.mapTitle,
      accuracy: input.accuracy,
      misses: input.misses,
      maxCombo: input.combo !== undefined ? input.combo : input.maxCombo,
      score: input.score,
      mods: input.mods,
    });
    // 多局趋势：同谱面历史 + 当前局
    const history = await this.readHistoryForMap(normalized.mapTitle);
    const analysis = analyzeObservations([...history, normalized]);
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
    await this.enqueueObservationWrite(observation);
    return { ...observation, analysis, historyCount: history.length };
  }

  /** 读取同谱面历史 observation（仅 telemetry 中带明确谱面名且有 accuracy 的记录）。 */
  async readHistoryForMap(mapTitle) {
    if (!mapTitle) return [];
    let data = [];
    try {
      data = JSON.parse(await fs.readFile(this.observationsPath, "utf8"));
      if (!Array.isArray(data)) data = [];
    } catch { return []; }
    return data
      .filter(item => item && item.mapTitle === mapTitle && typeof item.accuracy === "number")
      .slice(-10)
      .map(item => normalizeObservation({
        mapTitle: item.mapTitle,
        accuracy: item.accuracy,
        misses: item.misses,
        maxCombo: item.combo ?? item.maxCombo,
        score: item.score,
        mods: item.mods,
      }));
  }

  /** observation 写入串行化：避免并发损坏；tmp+rename 原子替换；限制容量。 */
  enqueueObservationWrite(observation) {
    this.writeQueue = this.writeQueue.then(async () => {
      let data = [];
      try {
        data = JSON.parse(await fs.readFile(this.observationsPath, "utf8"));
        if (!Array.isArray(data)) data = [];
      } catch { /* 文件缺失或损坏则从空开始 */ }
      data.push(observation);
      const trimmed = data.slice(-MAX_OBSERVATIONS);
      const temporary = `${this.observationsPath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(trimmed, null, 2), "utf8");
      await fs.rename(temporary, this.observationsPath);
    }).catch(error => {
      this.status.lastError = sanitizeErrorMessage(error, "observation write failed");
    });
    return this.writeQueue;
  }
}

/** 把 session.result {accuracy:{value,confidence},...} 拍平成顶层字段。 */
function flattenResult(result = {}) {
  const flat = {};
  for (const key of RESULT_FIELDS) {
    const field = result[key];
    if (field && field.value !== null && field.value !== undefined) {
      flat[key] = field.value;
    }
  }
  return flat;
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
  const width = Number(frame.width);
  const height = Number(frame.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("invalid frame dimensions");
  }

  const results = {};
  const warnings = Array.isArray(raw.warnings) ? [...raw.warnings] : [];
  for (const key of RESULT_FIELDS) {
    const field = raw.results?.[key] || {};
    const value = field.value ?? null;
    const fieldConfidence = Number(field.confidence ?? 0);
    if (!Number.isFinite(fieldConfidence) || fieldConfidence < 0 || fieldConfidence > 1) throw new Error(`bad confidence: ${key}`);
    const sanitized = sanitizeResultValue(key, value, warnings);
    results[key] = { value: sanitized, confidence: sanitized === null ? 0.0 : fieldConfidence };
  }

  return {
    schemaVersion: 2,
    frame: {
      width,
      height,
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
    warnings,
    ocr: raw.ocr || null,
    analyzerSource: filePath ? path.basename(filePath) : null,
  };
}

/** 结算字段业务范围校验：非法值降级为 null（不允许非法值以原样通过）。 */
function sanitizeResultValue(key, value, warnings) {
  if (value === null || value === undefined) return null;
  if (key === "grade") {
    if (typeof value === "string" && GRADE_ENUM.has(value)) return value;
    warnings.push(`grade-out-of-enum`);
    return null;
  }
  if (key === "accuracy") {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= 100) return number;
    warnings.push(`accuracy-out-of-range`);
    return null;
  }
  // misses / maxCombo / score：非负整数
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0 && Number.isInteger(number)) return number;
  warnings.push(`${key}-out-of-range`);
  return null;
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
  OBSERVATIONS_PATH: OBSERVATIONS,
};
