const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function loadController() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "voice-call.js"), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const frame = (amplitude, samples = 2048) => new Float32Array(samples).fill(amplitude);

function makeAudioContext() {
  const processor = { onaudioprocess: null, connect() {}, disconnect() {} };
  return {
    sampleRate: 16_000,
    destination: {},
    processor,
    resumed: false,
    closed: false,
    async resume() { this.resumed = true; },
    async close() { this.closed = true; },
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
    createScriptProcessor() { return processor; },
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  };
}

function send(context, samples) {
  context.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
}

function makeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track] };
}

async function startCall(VoiceCallController, options = {}) {
  const stream = makeStream();
  const context = makeAudioContext();
  let micCalls = 0;
  const controller = new VoiceCallController({
    getUserMedia: async () => { micCalls += 1; return stream; },
    audioContextFactory: () => context,
    silenceMs: 200,
    preRollMs: 200,
    minRms: 0.006,
    ...options
  });
  await controller.start();
  return { controller, stream, context, micCalls: () => micCalls };
}

async function main() {
  const { VoiceCallController } = await loadController();

  const adaptiveOnsets = [];
  const adaptive = await startCall(VoiceCallController, { onSpeechStart: () => adaptiveOnsets.push(true) });
  // 20ms frames: a click is not speech, regardless of its peak amplitude.
  send(adaptive.context, frame(0.2, 320));
  send(adaptive.context, frame(0, 320));
  assert.equal(adaptiveOnsets.length, 0);
  for (let i = 0; i < 6; i++) send(adaptive.context, frame(0.06, 320));
  assert.equal(adaptiveOnsets.length, 1, "120ms sustained normal voice must trigger");
  for (let i = 0; i < 20; i++) send(adaptive.context, frame(0.06, 320));
  for (let i = 0; i < 12; i++) send(adaptive.context, frame(0, 320));
  assert.ok(adaptive.controller._threshold > 0.012, "normal voice calibration must survive turn reset");
  for (let i = 0; i < 8; i++) send(adaptive.context, frame(0.009, 320));
  assert.equal(adaptiveOnsets.length, 1, "quieter background must not interrupt calibrated voice");
  for (let i = 0; i < 6; i++) send(adaptive.context, frame(0.035, 320));
  assert.equal(adaptiveOnsets.length, 2, "moderately softer speaker must still be heard");
  await adaptive.controller.stop();

  const speechStarts = [];
  const first = await startCall(VoiceCallController, { onSpeechStart: event => speechStarts.push(event) });
  send(first.context, frame(0.002));
  send(first.context, frame(0.05));
  await tick();
  assert.equal(speechStarts.length, 1, "assistant playback can be interrupted on the first speech onset frame");
  assert.equal(first.micCalls(), 1);
  assert.equal(first.context.resumed, true);
  await first.controller.stop();

  const quietStarts = [];
  const quiet = await startCall(VoiceCallController, { onSpeechStart: () => quietStarts.push(true) });
  for (let index = 0; index < 10; index += 1) send(quiet.context, frame(0.003));
  send(quiet.context, frame(0.009));
  await tick();
  assert.equal(quietStarts.length, 1, "adaptive VAD must still detect a quiet voice above its learned floor");
  await quiet.controller.stop();

  const turns = [];
  const continuous = await startCall(VoiceCallController, { onTurn: async (blob, sequence) => turns.push({ blob, sequence }) });
  send(continuous.context, frame(0.001));
  send(continuous.context, frame(0.05));
  send(continuous.context, frame(0.001));
  send(continuous.context, frame(0.001));
  await tick();
  send(continuous.context, frame(0.05));
  send(continuous.context, frame(0.001));
  send(continuous.context, frame(0.001));
  await tick();
  assert.deepEqual(turns.map(turn => turn.sequence), [1, 2], "one microphone session emits independent consecutive turns");
  assert.ok(turns[0].blob.size > 44 + 2048 * 2, "pre-roll is retained in the first WAV turn");
  assert.equal(continuous.micCalls(), 1, "continuous conversation never reacquires the microphone");
  assert.equal(continuous.stream.track.stopped, false, "turn segmentation does not release the microphone");
  await continuous.controller.stop();
  assert.equal(continuous.stream.track.stopped, true);
  await assert.rejects(continuous.controller.start(), /cannot restart/);

  let resolveLate;
  let lateSignal;
  const lateResult = new Promise(resolve => { resolveLate = resolve; });
  const statusAfterStop = [];
  const late = await startCall(VoiceCallController, {
    onTurn: async (_blob, _sequence, signal) => { lateSignal = signal; await lateResult; },
    onStatus: event => statusAfterStop.push(event.state)
  });
  send(late.context, frame(0.05));
  send(late.context, frame(0.001));
  send(late.context, frame(0.001));
  await tick();
  await late.controller.stop();
  resolveLate();
  await tick();
  assert.equal(lateSignal.aborted, true, "stop aborts in-flight ASR callbacks");
  assert.equal(statusAfterStop.includes("turn-complete"), false, "late ASR completion cannot revive a stopped session");

  let resolveMic;
  const delayedMic = new Promise(resolve => { resolveMic = resolve; });
  const oldStream = makeStream();
  const old = new VoiceCallController({ getUserMedia: () => delayedMic, audioContextFactory: makeAudioContext });
  const starting = old.start();
  await old.stop();
  resolveMic(oldStream);
  await assert.rejects(starting, error => error.name === "AbortError");
  assert.equal(oldStream.track.stopped, true, "late microphone grant belongs to the old stopped session and is released");
  const fresh = await startCall(VoiceCallController);
  assert.equal(fresh.controller.isActive, true, "a new controller is isolated from the old stopped session");
  await fresh.controller.stop();

  console.log("Voice call controller tests passed: onset, quiet VAD, multi-turn mic continuity, stop races, and session isolation.");
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
