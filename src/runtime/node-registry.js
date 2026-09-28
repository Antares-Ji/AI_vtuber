const crypto = require("node:crypto");

const ALLOWED_CAPABILITIES = new Set(["asr", "tts", "local-llm", "vision"]);

class WorkerNodeRegistry {
  constructor({ token = process.env.WORKER_SHARED_TOKEN || "", ttlMs = Number(process.env.WORKER_HEARTBEAT_TTL_MS || 15_000), now = () => Date.now() } = {}) {
    this.token = String(token);
    this.ttlMs = Math.max(5_000, Number(ttlMs) || 15_000);
    this.now = now;
    this.workers = new Map();
  }

  enabled() {
    return this.token.length >= 16;
  }

  authenticate(candidate) {
    if (!this.enabled()) throw serviceError(503, "worker registration is disabled until WORKER_SHARED_TOKEN is configured");
    const left = Buffer.from(String(candidate || ""));
    const right = Buffer.from(this.token);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw serviceError(401, "invalid worker token");
  }

  register(input, token) {
    this.authenticate(token);
    const id = normalizeId(input.id);
    const capabilities = normalizeCapabilities(input.capabilities);
    if (!capabilities.length) throw serviceError(400, "at least one supported capability is required");
    const now = this.now();
    const node = {
      id,
      label: String(input.label || id).slice(0, 80),
      endpoint: normalizeEndpoint(input.endpoint),
      capabilities,
      gpu: normalizeGpu(input.gpu),
      load: normalizeLoad(input.load),
      queueDepth: normalizeQueueDepth(input.queueDepth),
      registeredAt: this.workers.get(id)?.registeredAt || now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs
    };
    this.workers.set(id, node);
    return this.publicNode(node);
  }

  heartbeat(input, token) {
    this.authenticate(token);
    const id = normalizeId(input.id);
    const node = this.workers.get(id);
    if (!node) throw serviceError(404, "worker is not registered");
    const now = this.now();
    node.load = normalizeLoad(input.load);
    node.queueDepth = normalizeQueueDepth(input.queueDepth);
    node.gpu = normalizeGpu({ ...node.gpu, ...input.gpu });
    node.lastSeenAt = now;
    node.expiresAt = now + this.ttlMs;
    return this.publicNode(node);
  }

  list() {
    return [...this.workers.values()].map(node => this.publicNode(node));
  }

  select(capability) {
    const candidates = [...this.workers.values()]
      .filter(node => this.isOnline(node) && node.capabilities.includes(capability))
      .sort((a, b) => (a.load + a.queueDepth * 0.1) - (b.load + b.queueDepth * 0.1));
    if (candidates[0]) return { target: "worker", node: this.publicNode(candidates[0]), fallback: "5080-main" };
    return { target: "main", node: { id: "5080-main", online: true }, fallback: null };
  }

  status() {
    const nodes = this.list();
    return { enabled: this.enabled(), ttlMs: this.ttlMs, online: nodes.filter(node => node.online).length, nodes };
  }

  isOnline(node) {
    return node.expiresAt > this.now();
  }

  publicNode(node) {
    return { ...node, online: this.isOnline(node) };
  }
}

function normalizeId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/i.test(id)) throw serviceError(400, "invalid worker id");
  return id;
}

function normalizeEndpoint(value) {
  try {
    const endpoint = new URL(String(value || ""));
    if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("unsupported protocol");
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    throw serviceError(400, "invalid worker endpoint");
  }
}

function normalizeCapabilities(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(value => ALLOWED_CAPABILITIES.has(value)))];
}

function normalizeLoad(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function normalizeQueueDepth(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(1000, Math.max(0, number)) : 0;
}

function normalizeGpu(input = {}) {
  return {
    name: String(input.name || "unknown").slice(0, 80),
    totalVramMb: Math.max(0, Math.floor(Number(input.totalVramMb) || 0)),
    freeVramMb: Math.max(0, Math.floor(Number(input.freeVramMb) || 0))
  };
}

function serviceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const workerNodeRegistry = new WorkerNodeRegistry();

module.exports = { WorkerNodeRegistry, workerNodeRegistry, ALLOWED_CAPABILITIES };
