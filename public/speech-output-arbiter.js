// Shared by the browser and Node behavioural tests. Original implementation;
// inspired by Lumi_Nox's separation of speaker selection and output ownership.
(function (root) {
  class SpeechOutputArbiter {
    constructor() { this.current = null; this.pending = []; this.counter = 0; }

    enqueue(run, { policy = "queue", isValid = () => true, cancel = () => {}, metadata = {}, ttlMs = 60000 } = {}) {
      if (!["queue", "drop", "interrupt"].includes(policy)) throw new RangeError("Unknown speech policy");
      if (!isValid()) return Promise.resolve(false);
      if (policy === "drop" && (this.current || this.pending.length)) return Promise.resolve(false);
      if (policy === "interrupt") this.cancelAll();
      return new Promise((resolve, reject) => {
        this.pending.push({ run, isValid, cancel, metadata, resolve, reject, outputId: `output-${++this.counter}`, expiresAt: Date.now() + ttlMs, cancelled: false });
        this.drain();
      });
    }

    cancelAll() {
      const old = this.current;
      this.current = null;
      const discarded = this.pending.splice(0);
      for (const task of [old, ...discarded].filter(Boolean)) {
        task.cancelled = true;
        // One failed cleanup must not leave the rest of the queue alive.
        try { task.cancel(); } catch {} finally { task.resolve(false); }
      }
    }

    drain() {
      if (this.current) return;
      const task = this.pending.shift();
      if (!task) return;
      if (task.cancelled || !task.isValid() || Date.now() > task.expiresAt) {
        task.resolve(false);
        this.drain();
        return;
      }
      this.current = task;
      Promise.resolve().then(() => {
        if (task.cancelled || !task.isValid()) return false;
        return task.run({ outputId: task.outputId, ...task.metadata });
      }).then(task.resolve, task.reject).finally(() => {
        // A late completion must never release a replacement speaker's floor.
        if (this.current === task) { this.current = null; this.drain(); }
      });
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { SpeechOutputArbiter };
  else root.SpeechOutputArbiter = SpeechOutputArbiter;
})(globalThis);
