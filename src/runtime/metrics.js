function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(Number(ratio) * sorted.length) - 1));
  return sorted[rank];
}

class RuntimeMetrics {
  constructor(sampleLimit = 200) {
    this.sampleLimit = Math.max(1, sampleLimit);
    this.startedAt = new Date().toISOString();
    this.requests = 0;
    this.replies = 0;
    this.errors = 0;
    this.lastReplyAt = null;
    this.lastError = null;
    this.latencies = new Map();
  }

  recordLatency(name, value) {
    if (!Number.isFinite(value)) return;
    const samples = this.latencies.get(name) || [];
    samples.push(value);
    if (samples.length > this.sampleLimit) samples.splice(0, samples.length - this.sampleLimit);
    this.latencies.set(name, samples);
  }

  status() {
    const latency = {};
    for (const [name, samples] of this.latencies) {
      latency[name] = {
        samples: samples.length,
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        max: samples.length ? Math.max(...samples) : null
      };
    }
    return {
      startedAt: this.startedAt,
      requests: this.requests,
      replies: this.replies,
      errors: this.errors,
      lastReplyAt: this.lastReplyAt,
      lastError: this.lastError,
      latency
    };
  }
}

module.exports = { RuntimeMetrics, percentile };
