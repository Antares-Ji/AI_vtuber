// One inference in flight; replace queued frames instead of building a backlog.
class LatestFrameAnalyzer {
  constructor(analyze, {maxAgeMs = 1000, now = Date.now} = {}) {
    this.analyze = analyze;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.running = false;
    this.pending = null;
  }
  submit(frame) {
    if (!Number.isFinite(frame.capturedAt)) return Promise.reject(Error('capturedAt timestamp required'));
    return new Promise((resolve, reject) => {
      if (this.pending) this.pending.resolve({status:'dropped', reason:'replaced_by_newer_frame'});
      this.pending = {frame, resolve, reject};
      void this.drain();
    });
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const entry = this.pending;
        this.pending = null;
        try {
          if (this.now() - entry.frame.capturedAt > this.maxAgeMs) {
            entry.resolve({status:'dropped', reason:'expired_before_analysis'});
            continue;
          }
          const result = await this.analyze(entry.frame);
          const ageMs = this.now() - entry.frame.capturedAt;
          entry.resolve(ageMs > this.maxAgeMs ? {status:'dropped', reason:'expired_after_analysis', ageMs}
            : {status:'ready', ageMs, result});
        } catch (error) { entry.reject(error); }
      }
    } finally { this.running = false; }
  }
}
module.exports = {LatestFrameAnalyzer};
