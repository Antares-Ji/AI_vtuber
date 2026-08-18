/**
 * session-tracker.js —— Phase E：一局 osu 游戏会话状态机（Node 侧时间聚合器）
 *
 * 状态：idle -> possibleGameplay -> gameplay -> possibleResults -> results -> idle
 * 规则：
 *  - 场景需连续多个有效帧才切换（去抖，避免单帧抖动）
 *  - 每局生成 sessionId、起止时间、帧数、置信度统计、最终结算
 *  - 同一结算页重复帧只生成一次完成事件
 *  - 页面停止共享/子进程失败/超时后 session 可明确中断
 *
 * 输入：单帧分析结果（schema v2 或兼容结构）
 * 输出：{ state, sessionId?, event?, session? }
 *  event: session-start | session-update | session-complete | session-abort | none
 */
const { randomUUID } = require("crypto");

const STATE = Object.freeze({
  IDLE: "idle",
  POSSIBLE_GAMEPLAY: "possibleGameplay",
  GAMEPLAY: "gameplay",
  POSSIBLE_RESULTS: "possibleResults",
  RESULTS: "results",
});

const SCENES = Object.freeze({
  GAMEPLAY: "gameplay",
  RESULTS: "results",
  SONG_SELECT: "songSelect",
  PAUSE: "pause",
  FAIL: "fail",
  UNKNOWN: "unknown",
});

class SessionTracker {
  /**
   * @param {object} options
   * @param {number} options.gameplayDebounce 进入 gameplay 所需的连续 gameplay 帧数
   * @param {number} options.resultsDebounce  进入 results 所需的连续 results 帧数
   * @param {number} options.sessionTimeoutMs 无新帧时强制中断的超时
   * @param {number} options.inactivityAbortMs results 后回到 idle 的滞留时间
   */
  constructor({
    gameplayDebounce = 2,
    resultsDebounce = 2,
    sessionTimeoutMs = 15 * 60 * 1000,
    inactivityAbortMs = 10 * 1000,
  } = {}) {
    this.config = { gameplayDebounce, resultsDebounce, sessionTimeoutMs, inactivityAbortMs };
    this.state = STATE.IDLE;
    this.possibleCount = 0;
    this.session = null;
    this.lastFrameAt = 0;
    this.completedAt = 0;
  }

  getState() {
    return { state: this.state, sessionId: this.session?.id || null };
  }

  _startSession(now) {
    this.state = STATE.GAMEPLAY;
    this.possibleCount = 0;
    this.session = {
      id: randomUUID(),
      state: STATE.GAMEPLAY,
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      frames: 0,
      confidenceSum: 0,
      sceneCounts: {},
      result: null,
      aborted: false,
    };
  }

  _finishSession(now, result = null, aborted = false) {
    if (!this.session) return null;
    const session = { ...this.session };
    session.endedAt = new Date(now).toISOString();
    session.frames = session.frames || 1;
    session.averageConfidence = Number((session.confidenceSum / session.frames).toFixed(3));
    session.sceneCounts = session.sceneCounts || {};
    session.result = result;
    session.aborted = aborted;
    const snapshot = JSON.parse(JSON.stringify(session));
    this.session = null;
    this.state = STATE.IDLE;
    this.possibleCount = 0;
    this.completedAt = now;
    return snapshot;
  }

  /**
   * 处理一帧分析结果。
   * @param {object} frame 单帧结果：{ scene: {name, confidence}, results, frame, timingMs, warnings }
   * @param {number} [now] 可注入当前时间（测试用），默认 Date.now()
   * @returns {{state: string, sessionId: string|null, event: string, session?: object}}
   */
  ingest(frame = {}, now = Date.now()) {
    const sceneName = frame?.scene?.name || SCENES.UNKNOWN;
    const confidence = Number(frame?.scene?.confidence || 0);
    const results = frame?.results || {};

    // 会话超时/中断
    if (this.session && sceneName !== SCENES.GAMEPLAY && sceneName !== SCENES.RESULTS) {
      if (now - this.lastFrameAt > this.config.sessionTimeoutMs && this.session.state === STATE.GAMEPLAY) {
        const aborted = this._finishSession(now, null, true);
        return { state: this.state, sessionId: null, event: "session-abort", session: aborted };
      }
    }

    // 空闲/中断后重新开始的静默窗口（仅当确实完成/中断过一局后生效）
    if (this.state === STATE.IDLE && this.completedAt > 0 && now - this.completedAt < this.config.inactivityAbortMs) {
      return { state: this.state, sessionId: null, event: "none" };
    }

    switch (this.state) {
      case STATE.IDLE: {
        if (sceneName === SCENES.GAMEPLAY) {
          this.state = STATE.POSSIBLE_GAMEPLAY;
          this.possibleCount = 1;
          this.lastFrameAt = now;
        }
        return { state: this.state, sessionId: null, event: "none" };
      }

      case STATE.POSSIBLE_GAMEPLAY: {
        if (sceneName === SCENES.GAMEPLAY) {
          this.possibleCount += 1;
          this.lastFrameAt = now;
          if (this.possibleCount >= this.config.gameplayDebounce) {
            this._startSession(now);
            this._recordFrame(sceneName, confidence);
            return { state: this.state, sessionId: this.session.id, event: "session-start", session: this._snapshot() };
          }
          return { state: this.state, sessionId: null, event: "none" };
        }
        // 非 gameplay 帧打断候选
        this.state = STATE.IDLE;
        this.possibleCount = 0;
        return { state: this.state, sessionId: null, event: "none" };
      }

      case STATE.GAMEPLAY: {
        this._recordFrame(sceneName, confidence);
        if (sceneName === SCENES.GAMEPLAY) {
          this.lastFrameAt = now;
          return { state: this.state, sessionId: this.session.id, event: "session-update", session: this._snapshot() };
        }
        if (sceneName === SCENES.RESULTS) {
          this.state = STATE.POSSIBLE_RESULTS;
          this.possibleCount = 1;
          this.lastFrameAt = now;
          return { state: this.state, sessionId: this.session.id, event: "session-update", session: this._snapshot() };
        }
        // 其他场景（选歌/暂停/失败/未知）：帧分析仍属本局，但可能代表中断
        if (sceneName === SCENES.UNKNOWN) {
          const aborted = this._finishSession(now, null, true);
          return { state: this.state, sessionId: null, event: "session-abort", session: aborted };
        }
        return { state: this.state, sessionId: this.session.id, event: "session-update", session: this._snapshot() };
      }

      case STATE.POSSIBLE_RESULTS: {
        if (sceneName === SCENES.RESULTS) {
          this.possibleCount += 1;
          this._recordFrame(sceneName, confidence);
          this.lastFrameAt = now;
          if (this.possibleCount >= this.config.resultsDebounce) {
            this.state = STATE.RESULTS;
            return { state: this.state, sessionId: this.session.id, event: "session-complete", session: this._finishSession(now, normalizeResult(results)) };
          }
          return { state: this.state, sessionId: this.session.id, event: "none", session: this._snapshot() };
        }
        if (sceneName === SCENES.GAMEPLAY) {
          // 结算页抖动回游戏
          this.state = STATE.GAMEPLAY;
          this.possibleCount = 0;
          this._recordFrame(sceneName, confidence);
          this.lastFrameAt = now;
          return { state: this.state, sessionId: this.session.id, event: "session-update", session: this._snapshot() };
        }
        if (sceneName === SCENES.UNKNOWN) {
          const aborted = this._finishSession(now, null, true);
          return { state: this.state, sessionId: null, event: "session-abort", session: aborted };
        }
        // 其他场景打断候选结算
        this.state = STATE.GAMEPLAY;
        this.possibleCount = 0;
        return { state: this.state, sessionId: this.session.id, event: "session-update", session: this._snapshot() };
      }

      case STATE.RESULTS: {
        if (sceneName === SCENES.RESULTS) {
          // 同一结算页重复帧：不重复生成完成事件
          return { state: this.state, sessionId: null, event: "none" };
        }
        // 离开结算页回到 idle
        this.state = STATE.IDLE;
        this.possibleCount = 0;
        return { state: this.state, sessionId: null, event: "none" };
      }

      default:
        return { state: this.state, sessionId: null, event: "none" };
    }
  }

  _recordFrame(sceneName, confidence) {
    if (!this.session) return;
    this.session.frames += 1;
    this.session.confidenceSum += confidence;
    this.session.sceneCounts[sceneName] = (this.session.sceneCounts[sceneName] || 0) + 1;
  }

  _snapshot() {
    return this.session ? JSON.parse(JSON.stringify(this.session)) : null;
  }
}

/** 结算字段规范化：只保留已发布（value != null）的字段。 */
function normalizeResult(results = {}) {
  const output = {};
  for (const key of ["accuracy", "misses", "maxCombo", "score", "grade"]) {
    const field = results[key];
    if (field && field.value !== null && field.value !== undefined) {
      output[key] = { value: field.value, confidence: Number(field.confidence || 0) };
    }
  }
  return output;
}

module.exports = { SessionTracker, normalizeResult, STATE };
