/*
 * Browser-runtime contract tests without a browser dependency.
 *
 * stream.js is an ES module with private functions, so this test executes the
 * production function bodies inside a small Web Audio/Fetch harness.  It is
 * deliberately behavioural: assertions are about created audio sources,
 * cancelled readers, and observed TTS request order rather than source text.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const streamSource = fs.readFileSync(path.join(__dirname, "..", "public", "stream.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = streamSource.indexOf(startMarker);
  const end = streamSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing stream.js marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing stream.js marker: ${endMarker}`);
  return streamSource.slice(start, end);
}

function wavHeader() {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("RIFF"), 0); view.setUint32(4, 40, true); bytes.set(Buffer.from("WAVE"), 8);
  bytes.set(Buffer.from("fmt "), 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(Buffer.from("data"), 36); view.setUint32(40, 0, true);
  return bytes;
}

function createPlaybackHarness() {
  const observed = { starts: 0, stops: 0, mouths: [] };
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; }
    async resume() {}
    createBuffer(channels, frames, sampleRate) {
      return { duration: frames / sampleRate, getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() {
      return {
        connect() {},
        start() { observed.starts += 1; },
        stop() { observed.stops += 1; this.onended?.(); }
      };
    }
  }
  const context = {
    AbortController,
    AudioContext: FakeAudioContext,
    DOMException,
    DataView,
    Promise,
    Set,
    TextDecoder,
    Uint8Array,
    clearInterval,
    clearTimeout,
    performance,
    setInterval,
    setTimeout,
    window: {},
    fetch: async () => ({ ok: true }),
    cancelAnimationFrame() {},
    setLive2DMouth(value) { observed.mouths.push(value); }
  };
  const code = `
    let speakingTimer; let activeAudio = null; let finishActiveSpeech = null;
    const activeTtsControllers = new Set(); let activeReplyController = null;
    let speechEpoch = 0; let audioOutputEnabled = true; let ttsAudioContext; let ttsLipSyncFrame;
    const activeStreamSources = new Set();
    ${sourceBetween("function concatBytes", "function setAudioOutput")}
    globalThis.__harness = {
      playStreamingWav, stopSpeechOutput,
      setEpoch(value) { speechEpoch = value; },
      state() { return { speechEpoch, activeSources: activeStreamSources.size }; }
    };
  `;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "stream-playback-harness.js" });
  return { harness: context.__harness, observed };
}

function controlledWavReader() {
  let stage = 0;
  let releaseLateChunk;
  let waiting = false;
  let cancelled = false;
  const lateChunk = new Promise(resolve => { releaseLateChunk = resolve; });
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (stage++ === 0) return { value: wavHeader(), done: false };
            waiting = true;
            return lateChunk;
          },
          async cancel() { cancelled = true; }
        };
      }
    },
    releasePcm() { releaseLateChunk({ value: new Uint8Array([0, 0, 1, 0]), done: false }); },
    get waiting() { return waiting; },
    get cancelled() { return cancelled; }
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function testLatePcmCannotRestartCancelledSpeech() {
  const { harness, observed } = createPlaybackHarness();
  const reader = controlledWavReader();
  harness.setEpoch(7);
  const playback = harness.playStreamingWav({ body: reader.body }, 7);
  await waitFor(() => reader.waiting, "WAV header to be consumed");
  harness.stopSpeechOutput();
  reader.releasePcm();
  await playback;
  assert.equal(reader.cancelled, true, "late PCM reader must be cancelled after barge-in");
  assert.equal(observed.starts, 0, "late PCM from an old epoch must never create an audio source");
  assert.equal(harness.state().activeSources, 0, "cancelled speech must leave no active stream source");
}

async function testFirstPcmSchedulesExactlyOneSource() {
  const { harness, observed } = createPlaybackHarness();
  harness.setEpoch(3);
  let index = 0;
  const reader = {
    cancelled: false,
    body: { getReader: () => ({
      async read() {
        const chunks = [wavHeader(), new Uint8Array([0, 0, 1, 0]), null];
        const value = chunks[index++];
        return value ? { value, done: false } : { done: true };
      },
      async cancel() { reader.cancelled = true; }
    }) }
  };
  let firstPcmCallbacks = 0;
  await harness.playStreamingWav({ body: reader.body }, 3, () => { firstPcmCallbacks += 1; });
  assert.equal(observed.starts, 1, "valid PCM must schedule one audio source");
  assert.equal(firstPcmCallbacks, 1, "first PCM metric must fire once, not for the WAV header");
  assert.equal(reader.cancelled, false, "a completed current stream should not be cancelled");
}

async function testStartedSourceIsStoppedAfterUpstreamFailure() {
  const { harness, observed } = createPlaybackHarness();
  harness.setEpoch(11);
  let releaseFailure;
  const failure = new Promise((_resolve, reject) => { releaseFailure = reject; });
  let index = 0;
  const reader = {
    body: { getReader: () => ({
      async read() {
        if (index++ === 0) return { value: wavHeader(), done: false };
        if (index === 2) return { value: new Uint8Array([0, 0, 1, 0]), done: false };
        return failure;
      },
      async cancel() {}
    }) }
  };
  const playback = harness.playStreamingWav({ body: reader.body }, 11);
  await waitFor(() => observed.starts === 1, "PCM source to start before upstream failure");
  releaseFailure(new Error("upstream EOF/error"));
  await assert.rejects(playback, /upstream EOF\/error/);
  harness.stopSpeechOutput();
  assert.equal(observed.stops, 1, "an already-started source must receive stop() after upstream failure");
  assert.equal(harness.state().activeSources, 0, "stopping failed playback must clear active sources");
}

async function testPrefetchIsStrictlyOrdered() {
  const observed = { prepares: [], playback: [], maxPrepareInFlight: 0 };
  let prepareInFlight = 0;
  const events = [
    { type: "start", item: { user: "验收" }, persona: { name: "测试主播" }, emotion: { name: "neutral" } },
    { type: "preface", text: "让我看一下。" },
    { type: "delta", mode: "local-stream", text: "这是一个足够长的第一句，用于验证语音预取顺序。" },
    { type: "delta", mode: "local-stream", text: "第二句仍然应该排在后面。" },
    { type: "done" }
  ];
  const encoded = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join("\n") + "\n");
  let sent = false;
  const context = {
    AbortController,
    JSON,
    Promise,
    TextDecoder,
    TextEncoder,
    performance,
    setLive2DEmotion() {},
    showDanmaku() {},
    subtitle: { textContent: "" }, speaker: { textContent: "" }, brainStatus: { title: "" },
    isReading: false, personaName: "AI 主播", activeReplyController: null, speechEpoch: 0,
    audioOutputEnabled: true, voiceProvider: "gpt-sovits",
    async fetch() {
      return {
        ok: true, status: 200,
        body: { getReader: () => ({ async read() {
          if (sent) return { done: true };
          sent = true;
          return { value: encoded, done: false };
        }, async cancel() {} }) }
      };
    },
    async prepareBackendSpeech(chunk, _profile, epoch) {
      observed.prepares.push({ chunk, epoch });
      prepareInFlight += 1;
      observed.maxPrepareInFlight = Math.max(observed.maxPrepareInFlight, prepareInFlight);
      await Promise.resolve();
      prepareInFlight -= 1;
      return { chunk };
    },
    async playPreparedSpeech(prepared, chunk, _profile, epoch) {
      await prepared;
      observed.playback.push({ chunk, epoch });
      return true;
    },
    browserSpeak: async () => { throw new Error("test must exercise backend prefetch"); }
  };
  const code = `${sourceBetween("async function readNextStreaming", "async function submitDanmaku")}\nglobalThis.__run = readNextStreaming;`;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "stream-prefetch-harness.js" });
  await context.__run("accepted-item");
  const expected = ["让我看一下。", "这是一个足够长的第一句，用于验证语音预取顺序。", "第二句仍然应该排在后面。"];
  assert.deepEqual(observed.prepares.map(item => item.chunk), expected, "prefetch order must match spoken order");
  assert.deepEqual(observed.playback.map(item => item.chunk), expected, "playback order must match prefetch order");
  assert.equal(observed.maxPrepareInFlight, 1, "a later sentence must not prefetch before the previous request settles");
}

async function main() {
  await testLatePcmCannotRestartCancelledSpeech();
  await testFirstPcmSchedulesExactlyOneSource();
  await testStartedSourceIsStoppedAfterUpstreamFailure();
  await testPrefetchIsStrictlyOrdered();
  console.log("Frontend realtime behaviour test passed: cancel, PCM scheduling, and ordered prefetch.");
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
