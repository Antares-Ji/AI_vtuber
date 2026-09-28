const assert = require("node:assert/strict");
const { WorkerNodeRegistry } = require("../src/runtime/node-registry");

let now = 1_000;
const token = "0123456789abcdef0123456789abcdef";
const registry = new WorkerNodeRegistry({ token, ttlMs: 5_000, now: () => now });

assert.throws(() => registry.register({ id: "5070", endpoint: "http://192.168.1.20:12000", capabilities: ["asr"] }, "wrong"), error => error.statusCode === 401);
const registered = registry.register({ id: "5070-laptop", label: "RTX 5070 Laptop", endpoint: "http://192.168.1.20:12000", capabilities: ["asr", "vision", "shell"], load: 0.6, gpu: { name: "RTX 5070", totalVramMb: 8192, freeVramMb: 7000 } }, token);
assert.deepEqual(registered.capabilities, ["asr", "vision"]);
assert.equal(registered.online, true);
assert.equal(registry.select("asr").target, "worker");
assert.equal(registry.select("tts").target, "main");

// Offline two-machine contract: selection stays local-only until an authenticated
// worker advertises an allowed capability, then chooses the least loaded worker.
const desktop = registry.register({ id: "desktop-vision", endpoint: "https://192.168.1.30:12000/", capabilities: ["vision"], load: 0.1, queueDepth: 0 }, token);
assert.equal(desktop.endpoint, "https://192.168.1.30:12000");
assert.equal(registry.select("vision").node.id, "desktop-vision");
assert.equal(registry.select("asr").node.id, "5070-laptop");
assert.throws(() => registry.heartbeat({ id: "not-registered" }, token), error => error.statusCode === 404);

now += 4_000;
const heartbeat = registry.heartbeat({ id: "5070-laptop", load: 0.4, queueDepth: 2, gpu: { freeVramMb: 6000 } }, token);
assert.equal(heartbeat.load, 0.4);
assert.equal(heartbeat.gpu.freeVramMb, 6000);

now += 5_001;
assert.equal(registry.status().nodes[0].online, false);
assert.equal(registry.select("asr").target, "main");
assert.equal(registry.select("vision").target, "main");

const disabled = new WorkerNodeRegistry({ token: "", now: () => now });
assert.throws(() => disabled.register({ id: "offline-worker", endpoint: "http://192.168.1.9:12000", capabilities: ["asr"] }, token), error => error.statusCode === 503);
console.log("Worker node registry test passed.");
