const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function loadClient() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "asr-stream-client.js"), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class MockSocket {
  static instances = [];
  static behavior = { finish: "final" };
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    MockSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data) {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const control = JSON.parse(data);
    if (control.type === "start") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ready" }) }));
    if (control.type === "finish" && MockSocket.behavior.finish === "final") queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ type: "final", sequence: 1, text: "世界", isFinal: true }) });
      this.close();
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

function fakeAudioContextFactory({ resume = async () => {} } = {}) {
  const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
  const context = {
    destination: {},
    processor,
    closed: false,
    createProcessorCalls: 0,
    resume,
    async close() { context.closed = true; },
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
    createScriptProcessor() { context.createProcessorCalls += 1; return processor; },
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  };
  return context;
}

function floatSamples(length) {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) samples[index] = Math.sin(index / 17);
  return samples;
}

async function main() {
  const { StreamingAsrClient, Pcm16Resampler, downsampleToPcm16, getStreamingAsrAvailability } = await loadClient();
  const pcm = downsampleToPcm16(new Float32Array([-1, -0.5, 0, 0.5, 1, 0.5]), 48_000);
  assert.equal(pcm.length, 2, "48 kHz must become 16 kHz");
  assert.ok(pcm[0] < 0 && pcm[1] > 0, "PCM conversion preserves signed waveform");
  const source = floatSamples(4_096 * 12);
  const oneShot = downsampleToPcm16(source, 44_100);
  const resampler = new Pcm16Resampler(44_100);
  const segmented = [];
  for (let offset = 0; offset < source.length; offset += 4_096) segmented.push(...resampler.push(source.slice(offset, offset + 4_096)));
  assert.deepEqual(segmented, [...oneShot], "4096-frame chunks preserve all complete 44.1 kHz output samples");

  const unavailable = await getStreamingAsrAvailability({ fetchImpl: async () => ({ ok: true, json: async () => ({ streaming: { ready: false, error: "disabled" } }) }) });
  assert.deepEqual(unavailable.ready, false, "disabled health must not be treated as ready");

  const context = fakeAudioContextFactory();
  const transcripts = [];
  const client = new StreamingAsrClient({
    url: "ws://127.0.0.1:10095/stream",
    webSocketFactory: url => new MockSocket(url),
    audioContextFactory: () => context,
    onTranscript: event => transcripts.push(event)
  });
  await client.start({});
  const socket = MockSocket.instances.at(-1);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "start", sampleRate: 16000, channels: 1, format: "pcm_s16le" });
  socket.onmessage({ data: JSON.stringify({ type: "partial", sequence: 0, text: "你好", isFinal: false }) });
  context.processor.onaudioprocess({ inputBuffer: { sampleRate: 48_000, getChannelData: () => new Float32Array(4_800).fill(0.25) } });
  assert.ok(socket.sent.some(value => value instanceof ArrayBuffer), "client must send binary PCM16 frames");
  const final = await client.finish();
  assert.equal(final.text, "你好世界", "partial and final segments are ordered into one transcript");
  assert.equal(client.state, "closed");
  assert.equal(transcripts.at(-1).isFinal, true);

  MockSocket.behavior = { finish: "silent" };
  const timeoutContext = fakeAudioContextFactory();
  const timeoutClient = new StreamingAsrClient({ url: "ws://127.0.0.1:10095/stream", webSocketFactory: url => new MockSocket(url), audioContextFactory: () => timeoutContext, finishTimeoutMs: 15 });
  await timeoutClient.start({});
  assert.equal(await timeoutClient.finish(), null, "missing final/close must time out and fall back");
  assert.equal(timeoutClient.state, "closed");
  assert.equal(timeoutContext.closed, true);

  MockSocket.behavior = { finish: "final" };
  const closeContext = fakeAudioContextFactory();
  const closeClient = new StreamingAsrClient({ url: "ws://127.0.0.1:10095/stream", webSocketFactory: url => new MockSocket(url), audioContextFactory: () => closeContext });
  await closeClient.start({});
  MockSocket.instances.at(-1).close();
  await tick();
  assert.equal(closeClient.state, "socket-closed", "unexpected close marks the native path unavailable");
  assert.equal(closeContext.closed, true, "unexpected close releases its AudioContext");

  const lateEvents = [];
  const lateContext = fakeAudioContextFactory();
  const lateClient = new StreamingAsrClient({ url: "ws://127.0.0.1:10095/stream", webSocketFactory: url => new MockSocket(url), audioContextFactory: () => lateContext, onTranscript: event => lateEvents.push(event) });
  await lateClient.start({});
  const lateSocket = MockSocket.instances.at(-1);
  await lateClient.cancel();
  lateSocket.onmessage({ data: JSON.stringify({ type: "final", sequence: 0, text: "取消后不得写入", isFinal: true }) });
  assert.deepEqual(lateEvents, [], "late server messages after cancel are ignored");

  let resolveResume;
  const resumeGate = new Promise(resolve => { resolveResume = resolve; });
  const resumeContext = fakeAudioContextFactory({ resume: () => resumeGate });
  const resumeClient = new StreamingAsrClient({ url: "ws://127.0.0.1:10095/stream", webSocketFactory: url => new MockSocket(url), audioContextFactory: () => resumeContext });
  const starting = resumeClient.start({});
  await tick();
  await resumeClient.cancel();
  resolveResume();
  await assert.rejects(starting, error => error.name === "AbortError");
  assert.equal(resumeContext.createProcessorCalls, 0, "cancel during resume must not attach an audio graph afterwards");

  const pressureContext = fakeAudioContextFactory();
  const pressureClient = new StreamingAsrClient({ url: "ws://127.0.0.1:10095/stream", webSocketFactory: url => new MockSocket(url), audioContextFactory: () => pressureContext, maxBufferedBytes: 10 });
  await pressureClient.start({});
  const pressureSocket = MockSocket.instances.at(-1);
  pressureSocket.bufferedAmount = 11;
  pressureContext.processor.onaudioprocess({ inputBuffer: { sampleRate: 48_000, getChannelData: () => new Float32Array(4_096) } });
  await tick();
  assert.equal(pressureClient.state, "failed", "backpressure must fail native streaming instead of silently dropping audio");
  assert.equal(await pressureClient.finish(), null, "failed native stream returns no final transcript so batch ASR can run");

  const cancelContext = fakeAudioContextFactory();
  const cancelled = new StreamingAsrClient({ url: "ws://127.0.0.1:10095/stream", webSocketFactory: url => new MockSocket(url), audioContextFactory: () => cancelContext });
  await cancelled.start({});
  await cancelled.cancel();
  await tick();
  const cancelSocket = MockSocket.instances.at(-1);
  assert.ok(cancelSocket.sent.some(value => typeof value === "string" && JSON.parse(value).type === "cancel"));
  assert.equal(cancelled.state, "closed");
  console.log("ASR streaming browser-client test passed: readiness gate, PCM16, start/partial/final/cancel.");
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
