const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { responseAbortController } = require("../src/runtime/request-lifecycle");

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  output = "";
  writeHead(code) { this.code = code; this.headersSent = true; }
  write(text) { assert.equal(this.destroyed, false); this.output += text; }
  end(text = "") { this.write(text); this.writableEnded = true; this.emit("finish"); }
  disconnect() { this.destroyed = true; this.emit("close"); }
}

// Execute the production route function with isolated providers and memory.
const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const routeSource = source.slice(source.indexOf("async function handleApi("), source.indexOf("function isLive2dModelReady("));
function harness(stream) {
  const remembered = [];
  const item = { id: "one", text: "hello", type: "chat", delivery: "stream" };
  const context = {
    URL, Date, JSON, responseAbortController,
    nextInFlight: false, cloudReplyInFlight: null,
    handleStudioApi: async () => false,
    liveRuntime: {}, parseBody: async () => ({}), parseBinaryBody: async () => Buffer.from("audio"),
    send: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    queue: [item], queueStore: { remove() {} },
    brain: { pickDanmaku: () => item, prepareStreamReply: item => ({ item, context: {} }), visibleEmotion: () => ({}), commitStreamReply: (item, context, text) => { remembered.push([item, text]); return { text }; }, llmStatus: {} },
    PERSONA: {}, runtimeMetrics: { recordLatency() {}, replies: 0 },
    sanitizeErrorMessage: error => error.message,
    streamRoutedReply: stream
  };
  vm.createContext(context);
  vm.runInContext(routeSource, context);
  return { context, remembered, run: (res, url = "/api/next-stream") => context.handleApi({ method: "POST", url, headers: { host: "localhost" } }, res) };
}

(async () => {
  const parsers = { Buffer, DOMException, setTimeout, clearTimeout };
  vm.createContext(parsers);
  vm.runInContext(source.slice(source.indexOf("function parseBody("), source.indexOf("function serveStatic(")), parsers);
  for (const parser of [parsers.parseBody, parsers.parseBinaryBody]) {
    const upload = new EventEmitter();
    upload.destroy = () => {};
    const pending = parser(upload);
    upload.emit("aborted");
    await assert.rejects(pending, { name: "AbortError" });
    upload.aborted = true;
    await assert.rejects(parser(upload), { name: "AbortError" });
  }
  const normal = new Response();
  const normalController = responseAbortController(normal);
  normal.end(); normal.emit("close");
  assert.equal(normalController.signal.aborted, false);
  const closed = new Response(); closed.disconnect();
  assert.equal(responseAbortController(closed).signal.aborted, true);

  for (const lateToken of [false, true]) {
    const res = new Response();
    const test = harness(async function* (_item, _context, signal) {
      yield { type: "delta", text: "partial", mode: "local-stream" };
      res.disconnect();
      assert.equal(signal.aborted, true);
      if (lateToken) yield { type: "delta", text: "late" };
    });
    await test.run(res);
    assert.equal(test.remembered.length, 0, "cancelled text must not enter memory");
    assert.equal(test.context.runtimeMetrics.replies, 0);
    assert.equal(test.context.nextInFlight, false, "cancelled reply must release lock");
    assert.equal(res.output.includes("late"), false);
    test.context.streamRoutedReply = async function* () { yield { type: "delta", text: "recovered", mode: "local-stream" }; };
    const next = new Response(); await test.run(next);
    assert.equal(test.remembered.length, 1);
    assert.equal(test.context.runtimeMetrics.replies, 1);
    assert.equal(JSON.parse(next.output.trim().split("\n").at(-1)).type, "done");
  }
  for (const throws of [false, true]) {
    const res = new Response();
    const test = harness(async function* () {});
    test.context.transcribeAudio = async (_audio, signal) => {
      assert.equal(signal.aborted, false);
      res.disconnect();
      assert.equal(signal.aborted, true);
      if (throws) throw signal.reason;
      return { text: "late transcript" };
    };
    await test.run(res, "/api/asr");
    assert.equal(res.headersSent, false, "disconnected ASR must not send a success or error response");
  }
  {
    const res = new Response();
    const test = harness(async function* () {
      yield { type: "delta", text: "unreviewed draft", mode: "local-stream" };
      assert.equal(res.output.includes("unreviewed"), false, "draft must not escape before policy");
    });
    test.context.brain.commitStreamReply = (item, context, text) => {
      assert.equal(text, "unreviewed draft");
      test.remembered.push([item, "reviewed speech"]);
      return { text: "reviewed speech" };
    };
    await test.run(res);
    const events = res.output.trim().split("\n").map(JSON.parse);
    const emitted = events.filter(event => event.type === "delta").map(event => event.text).join("");
    assert.equal(emitted, test.remembered[0][1]);
    assert.equal(emitted, events.at(-1).text);
    assert.equal(res.output.includes("unreviewed"), false);
  }
  {
    const res = new Response();
    const test = harness(async function* () {});
    await test.run(res);
    assert.equal(test.remembered.length, 0, "empty successful EOF must not commit a fabricated reply");
    assert.equal(JSON.parse(res.output.trim().split("\n").at(-1)).type, "error");
  }
  for (const throws of [false, true]) {
    const res = new Response();
    const test = harness(async function* () {});
    let cancelled = false;
    Object.assign(test.context, {
      parseBody: async () => ({ text: "speech" }),
      sanitizeTtsStyle: style => style,
      runtimeSettings: { audioOutputEnabled: true },
      synthesizeWithGptSovits: async (_text, _style, signal) => {
        res.disconnect();
        assert.equal(signal.aborted, true);
        if (throws) throw signal.reason;
        return { body: { cancel: async () => { cancelled = true; } } };
      }
    });
    await test.run(res, "/api/tts");
    assert.equal(res.headersSent, false);
    assert.equal(cancelled, !throws, "a late TTS body must be released");
  }
  console.log("Server cancellation: normal completion, preclosed response, late token, late EOF, memory isolation and next-request recovery passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
