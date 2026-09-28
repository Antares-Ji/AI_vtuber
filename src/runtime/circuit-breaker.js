class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30_000, now = Date.now } = {}) {
    this.failureThreshold = Math.max(1, failureThreshold);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.now = now;
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  canRequest() {
    if (this.openedAt === null) return true;
    if (this.now() - this.openedAt < this.cooldownMs) return false;
    return true;
  }

  success() {
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  failure(error) {
    this.failures += 1;
    this.lastError = error instanceof Error ? error.message : String(error || "unknown error");
    if (this.failures >= this.failureThreshold && this.openedAt === null) this.openedAt = this.now();
  }

  status() {
    const coolingDown = this.openedAt !== null && this.now() - this.openedAt < this.cooldownMs;
    return {
      state: coolingDown ? "open" : (this.openedAt === null ? "closed" : "half-open"),
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      retryAt: coolingDown ? new Date(this.openedAt + this.cooldownMs).toISOString() : null,
      lastError: this.lastError
    };
  }
}

module.exports = { CircuitBreaker };
