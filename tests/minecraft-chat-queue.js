const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { QueueStore } = require('../src/runtime/queue-store');
const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
const begin = source.indexOf('if (req.method === "POST" && url.pathname === "/api/next") {');
const end = source.indexOf('if (req.method === "POST" && url.pathname === "/api/next-stream") {', begin);
const routeSource = source.slice(begin, end);
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(route, code = routeSource) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-chat-queue-'));
  const queueStore = new QueueStore({ filePath: path.join(directory, 'queue.json') });
  const queued = queueStore.push({ id: 'audience-turn', type: 'chat', user: 'test-only', text: '现在在做什么', delivery: 'poll', timestamp: new Date().toISOString() });
  const calls = [];
  const context = { Date, nextInFlight: false, cloudReplyInFlight: null, deferredReply: null,
    req: { method: 'POST' }, res: {}, url: { pathname: '/api/next' }, queueStore, queue: queueStore.items,
    parseBody: async () => ({}), send: (_res, _code, data) => data,
    classifyComplexity: () => ({ route, reason: 'test' }), selectThinkingPreface: () => '嗯', sanitizeErrorMessage: error => error.message,
    runtimeMetrics: { recordLatency() {}, replies: 0 }, PERSONA: {},
    brain: { pickDanmaku: candidates => candidates[0], maybeInitiate: () => null, liveGameContextProvider: () => ({ connected: true }),
      emotion: { performance: {} }, visibleEmotion: () => ({}), persona: {}, personaStatus: () => ({}),
      async reply(item) { calls.push(item); return { text: '我正在观察四周。' }; } }
  };
  vm.createContext(context);
  const next = vm.runInContext(`(async () => { ${code} })`, context);
  return { context, next, calls, queueStore, queued, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

(async () => {
  for (const mode of ['local', 'cloud']) {
    const run = fixture(mode);
    try {
      const first = await run.next();
      await settle();
      assert.equal(run.calls.length, 1, `${mode}: exactly one model generation`);
      assert.equal(run.calls[0], run.queued, `${mode}: routing preserves queue item identity`);
      assert.equal(run.calls[0].liveGame, true);
      assert.equal(run.queueStore.items.length, 0, `${mode}: selected audience message removed`);
      assert.deepEqual(JSON.parse(fs.readFileSync(run.queueStore.filePath, 'utf8')), [], `${mode}: deletion persisted`);
      if (mode === 'cloud') {
        assert.equal(first.thinking, true);
        assert.equal((await run.next()).deferred, true);
      }
      assert.equal((await run.next()).idle, true, `${mode}: subsequent polling cannot regenerate the same turn`);
      assert.equal(run.calls.length, 1);
    } finally { run.cleanup(); }
  }
  // Reproduce the original regression against the same production route:
  // cloning for routing leaves the persistent queue entry behind.
  const clonedRoute = routeSource.replace('item.liveGame = true;', 'item = { ...item, liveGame: true };');
  assert.notEqual(clonedRoute, routeSource);
  const broken = fixture('local', clonedRoute);
  try {
    await broken.next(); await broken.next();
    assert.equal(broken.queueStore.items.length, 1);
    assert.equal(broken.calls.length, 2, 'the old clone bug really regenerates the same audience turn');
  } finally { broken.cleanup(); }
  console.log('PASS: local/cloud queue identity, persistent dequeue, no repeated generation; original clone regression reproduced');
})().catch(error => { console.error(error); process.exitCode = 1; });
