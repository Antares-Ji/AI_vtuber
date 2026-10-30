'use strict';

// Trusted, explicitly installed providers. A manifest is not a security sandbox.
class SkillRegistry {
  #skills = new Map();
  #sealed = false;
  #enabled = new Set();
  register(definition) {
    if (this.#sealed) throw Error('Skill registry is sealed');
    if (!definition || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(definition.id) ||
        typeof definition.version !== 'string' || !definition.version ||
        typeof definition.execute !== 'function' || typeof definition.validate !== 'function' ||
        !['read', 'simulation', 'live', 'learning'].includes(definition.mode)) throw Error('Invalid skill definition');
    if (this.#skills.has(definition.id)) throw Error(`Duplicate skill: ${definition.id}`);
    const resources = [...(definition.resources || [])];
    if (resources.some(r => typeof r !== 'string' || !r)) throw Error('Invalid resource');
    this.#skills.set(definition.id, Object.freeze({ ...definition, resources: Object.freeze(resources) }));
    return this;
  }
  seal(enabled = ['*']) {
    if (this.#sealed) throw Error('Skill registry is already sealed');
    if (!Array.isArray(enabled) || enabled.some(id => id !== '*' && !this.#skills.has(id))) throw Error('Unknown enabled skill');
    this.#enabled = new Set(enabled.includes('*') ? this.#skills.keys() : enabled);
    this.#sealed = true;
    return this;
  }
  get(id) {
    if (!this.#sealed) throw Error('Seal registry before execution');
    if (!this.#enabled.has(id)) throw Error(`Unknown or disabled skill: ${id}`);
    return this.#skills.get(id);
  }
  list() {
    return [...this.#skills.values()].map(s => ({ id: s.id, version: s.version, game: s.game,
      mode: s.mode, description: s.description, resources: [...s.resources],
      enabled: this.#sealed ? this.#enabled.has(s.id) : false, arguments: structuredClone(s.arguments || {}) }));
  }
}

function objectArgs(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Skill args must be an object');
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw Error(`Unknown argument: ${key}`);
  return value;
}
function textArg(value, name, fallback = '', max = 2000) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !result.trim() || result.length > max) throw Error(`Invalid ${name}`);
  return result;
}
function intArg(value, name, fallback, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < 1 || result > max) throw Error(`Invalid ${name}: expected 1..${max}`);
  return result;
}
module.exports = { SkillRegistry, objectArgs, textArg, intArg };
