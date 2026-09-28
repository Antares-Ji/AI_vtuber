/*
 * Red tests for the readNextStreaming cancellation contract.
 * Run with: node tests/frontend-realtime-cancellation-gaps.js
 *
 * These tests execute the production readNextStreaming function in a tiny
 * Fetch/TTS harness. They intentionally fail while a known cancellation gap
 * exists; --report-only prints the exact trigger without a non-zero exit.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "stream.js"), "utf8");
const start = source.indexOf("async function readNextStreaming");
const end = source.indexOf("async function submitDanmaku", start);
assert(start >= 0 && end > start, "readNextStreaming function is missing");
const readFunction = source.slice(start, end);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeHarness(chunks, options = {}) {
  const state = { queued: [], played: [], subtitle: "", prepare: [], readerWaiting: false, cancelled: false, stopped: 0 };
  const secondRead = deferred();
  let readIndex = 0;
  const context = {
    AbortController,
    DOMException,
    JSON,
    Promise,
    TextDecoder,
    TextEncoder,
    performance,
    setTimeout,
    clearTimeout,
    setLive2DEmotion() {},
    showDanmaku() {},
    subtitle: { get textContent() { return state.subtitle; }, set textContent(value) { state.subtitle = value; } },
    speaker: { textContent: "" },
    brainStatus: { title: "" },
    isReading: false,
    personaName: "AI 主播",
    activeReplyController: null,
    speechEpoch: 0,
    audioOutputEnabled: true,
    voiceProvider: "gpt-sovits",
    stopSpeechOutput() {
      context.speechEpoch += 1;
      context.activeReplyController?.abort();
      state.stopped += 1;
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({
          async read() {
            if (readIndex === 0) { readIndex += 1; return { value: chunks[0], done: false }; }
            if (readIndex === 1) {
              readIndex += 1;
              state.readerWaiting = true;
              return secondRead.promise;
            }
            return { done: true };
          },
          async cancel() { state.cancelled = true; }
        }) }
      };
    },
    async prepareBackendSpeech(chunk) {
      state.prepare.push(chunk);
      if (options.blockPrepare) await options.blockPrepare;
      return { chunk };
    },
    async playPreparedSpeech(prepared, chunk, _profile, epoch) {
      await prepared;
      if (epoch !== context.speechEpoch) return false;
      state.played.push(chunk);
      return true;
    },
    browserSpeak: async () => true
  };
  vm.createContext(context);
  const instrumentedRead = readFunction.replace("  const queueSpeech =", "  globalThis.__captureCancel = () => cancelStreamSpeech;\n  const queueSpeech =");
  vm.runInContext(`${instrumentedRead}
    globalThis.__run = readNextStreaming;
    globalThis.__cancel = () => { speechEpoch += 1; activeReplyController?.abort(); };
    globalThis.__advanceReply = () => { speechEpoch += 1; };
  `, context, { filename: "stream-cancellation-harness.js" });
  return {
    context,
    state,
    releaseLate(value) { secondRead.resolve({ value, done: false }); },
    finishLate() { secondRead.resolve({ done: true }); }
  };
}

function encode(events) {
  return new TextEncoder().encode(events.map(event => JSON.stringify(event)).join("\n") + "\n");
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function lateDeltaAfterCancellation() {
  const harness = makeHarness([encode([{ type: "start", item: { user: "u" } }])]);
  const running = harness.context.__run("item");
  await waitFor(() => harness.state.readerWaiting, "reader.read() after start");
  harness.context.__cancel();
  harness.releaseLate(encode([
    { type: "delta", mode: "local-stream", text: "取消后这句迟到内容不应再更新字幕或排队。" },
    { type: "done" }
  ]));
  await running;
  assert.equal(harness.state.subtitle, "", "late delta after cancellation must not update subtitle");
  assert.deepEqual(harness.state.prepare, [], "late delta after cancellation must not enqueue TTS");
}

async function errorWithoutDoneDoesNotPlayQueuedSpeech() {
  const harness = makeHarness([encode([
    { type: "delta", mode: "local-stream", text: "这是已经排队但尚未完成的一句，错误后不应继续播放。" },
    { type: "error", error: "upstream disconnected" }
  ])]);
  let thrown = false;
  try { await harness.context.__run("item"); } catch { thrown = true; }
  // The production function throws before awaiting speechChain; allow its
  // already-enqueued microtasks to run so the leak is observable.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(thrown, true, "upstream error should remain observable to the caller");
  assert.deepEqual(harness.state.played, [], "queued TTS must be cancelled when stream errors before done");
}

async function eofWithoutDoneDoesNotPlayQueuedSpeech() {
  const preparation = deferred();
  const harness = makeHarness([encode([
    { type: "delta", mode: "local-stream", text: "这是正常 EOF 前已排队的一句，缺少 done 时不应播放。" }
  ])], { blockPrepare: preparation.promise });
  const running = harness.context.__run("item");
  await waitFor(() => harness.state.readerWaiting, "reader.read() before EOF");
  harness.finishLate();
  await assert.rejects(running, /完成事件前结束/);
  preparation.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(harness.state.stopped, 1, "EOF must stop active sources as well as queued work");
  assert.deepEqual(harness.state.played, [], "queued TTS must be cancelled when stream EOF arrives without done");
}

async function staleReplyCannotStopNewReply() {
  const harness = makeHarness([encode([{ type: "start", item: { user: "u" } }])]);
  const running = harness.context.__run("old-item");
  await waitFor(() => harness.state.readerWaiting, "old reply reader to wait");
  const oldCancel = harness.context.__captureCancel();
  // A newer reply owns the incremented epoch. Stale cleanup may abort its own
  // request, but must not stop audio belonging to the newer reply.
  harness.context.__advanceReply();
  oldCancel();
  assert.equal(harness.state.stopped, 0, "stale reply cancellation must not stop a newer reply's audio");
  harness.finishLate();
  await running;
}

(async () => {
  const failures = [];
  for (const [name, test] of [["late delta", lateDeltaAfterCancellation], ["error without done", errorWithoutDoneDoesNotPlayQueuedSpeech], ["EOF without done", eofWithoutDoneDoesNotPlayQueuedSpeech], ["stale reply", staleReplyCannotStopNewReply]]) {
    try { await test(); }
    catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  if (!failures.length) return console.log("Cancellation gap test passed.");
  for (const failure of failures) console.error(`KNOWN CANCELLATION GAP: ${failure}`);
  if (!process.argv.includes("--report-only")) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
