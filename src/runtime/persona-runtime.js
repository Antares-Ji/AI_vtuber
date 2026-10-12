const { randomUUID } = require("node:crypto");

// One body, one active persona. Revocation is synchronous; abort is best effort.
class PersonaRuntime {
  constructor(personas, initialId) {
    this.personas = personas;
    this.activeId = initialId;
    this.sessionId = randomUUID();
    this.generationEpoch = 0;
    this.controller = new AbortController();
    this.validate(initialId);
  }

  validate(id) {
    if (!Object.hasOwn(this.personas, id)) throw new RangeError("Unknown persona");
  }

  snapshot() {
    return { sessionId: this.sessionId, personaId: this.activeId, generationEpoch: this.generationEpoch };
  }

  isCurrent(token) {
    return Boolean(token && token.sessionId === this.sessionId && token.personaId === this.activeId && token.generationEpoch === this.generationEpoch);
  }

  invalidate(reason = "interrupted") {
    const old = this.controller;
    this.generationEpoch += 1;
    this.controller = new AbortController();
    old.abort(new DOMException(reason, "AbortError"));
    return this.snapshot();
  }

  switchTo(id) {
    this.validate(id);
    if (id === this.activeId) return this.snapshot();
    this.activeId = id;
    return this.invalidate("persona switched");
  }

  beginTurn() {
    return { ...this.snapshot(), turnId: randomUUID(), signal: this.controller.signal };
  }
}

module.exports = { PersonaRuntime };
