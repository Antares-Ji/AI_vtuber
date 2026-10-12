(function (root) {
  class PersonaPresentation {
    constructor(onInvalidate = () => {}) {
      this.runtime = null;
      this.revision = 0;
      this.changing = false;
      this.retiredSessions = new Set();
      this.onInvalidate = onInvalidate;
    }
    invalidate() { this.revision += 1; this.onInvalidate(); }
    isCurrent(token) {
      if (!this.runtime) return true; // legacy/single-persona transport
      return Boolean(token && token.sessionId === this.runtime.sessionId && token.personaId === this.runtime.personaId && token.generationEpoch === this.runtime.generationEpoch);
    }
    adopt(runtime, expectedRevision = this.revision) {
      if (!runtime) return !this.runtime;
      if (typeof runtime.sessionId !== "string" || typeof runtime.personaId !== "string" || !Number.isSafeInteger(runtime.generationEpoch) || runtime.generationEpoch < 0) return false;
      if (expectedRevision !== this.revision || this.retiredSessions.has(runtime.sessionId)) return false;
      const previous = this.runtime;
      if (previous?.sessionId === runtime.sessionId && runtime.generationEpoch < previous.generationEpoch) return false;
      if (previous?.sessionId === runtime.sessionId && runtime.generationEpoch === previous.generationEpoch && runtime.personaId !== previous.personaId) return false;
      const changed = previous && !this.isCurrent(runtime);
      if (previous && previous.sessionId !== runtime.sessionId) this.retiredSessions.add(previous.sessionId);
      this.runtime = runtime;
      if (changed) this.invalidate();
      return true;
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { PersonaPresentation };
  else root.PersonaPresentation = PersonaPresentation;
})(globalThis);
