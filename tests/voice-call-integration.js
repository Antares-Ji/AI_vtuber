/* Behavioural VoiceCallController integration harness (no source-string assertions). */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "voice-call.js"), "utf8")
  .replace("export class VoiceCallController", "class VoiceCallController");

function makeHarness(onSpeechStart, onTurn) {
  const observed = { resume: 0, close: 0, trackStops: 0, outputStops: 0, statuses: [], turns: [], levels: [] };
  const stream = { getTracks: () => [{ stop: () => { observed.trackStops += 1; } }] };
  const context = {
    AbortController, Blob, DataView, DOMException, Float32Array, Math, Promise, Uint8Array,
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.__Controller = VoiceCallController;`, context, { filename: "voice-call-harness.js" });
  const audioContext = {
    sampleRate: 8_000, destination: {}, processor: null,
    async resume() { observed.resume += 1; },
    async close() { observed.close += 1; },
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
    createScriptProcessor() {
      const processor = { onaudioprocess: null, connect() {}, disconnect() {} };
      audioContext.processor = processor;
      return processor;
    },
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  };
  const controller = new context.__Controller({
    getUserMedia: async () => stream,
    audioContextFactory: () => audioContext,
    onSpeechStart,
    onTurn: async (blob, sequence, signal, meta) => { observed.turns.push({ blob, sequence, signal, meta }); return onTurn?.(blob, sequence, signal, meta); },
    onStatus: status => observed.statuses.push(status),
    onLevel: level => observed.levels.push(level),
    silenceMs: 700,
    onsetFrames: 1
  });
  return { controller, audioContext, observed, stream };
}

function emit(processor, value) {
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(value) } });
}

async function main() {
  const streamSource = fs.readFileSync(path.join(__dirname, "..", "public", "stream.js"), "utf8");
  const section = (start, end) => streamSource.slice(streamSource.indexOf(start), streamSource.indexOf(end, streamSource.indexOf(start)));
  let sourceStopped = 0;
  const output = { AbortController, performance, clearInterval, clearTimeout, cancelAnimationFrame() {}, setLive2DMouth() {}, window: { speechSynthesis: { cancel() {} } }, fetch: async () => ({}), voiceStatus: {}, voiceCall: { revision: 0, ending: false, continuedText: "" } };
  output.speechSynthesis = output.window.speechSynthesis;
  vm.createContext(output);
  vm.runInContext(`let speechEpoch = 0, activeReplyController = new AbortController(), activeAudio = null, finishActiveSpeech = null, speakingTimer, ttsLipSyncFrame;
    const activeTtsControllers = new Set(), activeStreamSources = new Set();
    ${section("function stopSpeechOutput(", "function setAudioOutput(")}
    ${section("function interruptVoiceCall(", "async function processVoiceCallTurn(")}
    globalThis.addSource = source => activeStreamSources.add(source);
    globalThis.cancelled = () => activeReplyController.signal.aborted;
    globalThis.onset = () => interruptVoiceCall(voiceCall);`, output);
  output.addSource({ stop() { sourceStopped++; } });
  const harness = makeHarness(() => output.onset());
  await harness.controller.start();
  assert.equal(harness.controller.state, "active");
  assert.equal(harness.observed.resume, 1, "call startup must resume AudioContext");

  emit(harness.audioContext.processor, 0.2);
  assert.equal(output.voiceCall.revision, 1, "production onset adapter must advance ownership");
  assert.equal(output.cancelled(), true, "production adapter must abort the reply request");
  assert.equal(sourceStopped, 1, "onset callback must stop the active output source");
  assert.equal(harness.controller.state, "active", "onset must not end the continuous call");

  emit(harness.audioContext.processor, 0);
  emit(harness.audioContext.processor, 0);
  emit(harness.audioContext.processor, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(harness.observed.turns.length, 1, "700ms silence must close one turn");
  assert.equal(harness.controller.state, "active", "turn end must keep microphone session active");

  await harness.controller.stop();
  assert.equal(harness.controller.state, "stopped");
  assert.equal(harness.observed.trackStops, 1);
  assert.equal(harness.observed.close, 1);
  console.log("Voice call integration passed: resume, VAD onset -> output stop, 700ms turn silence, persistent session, explicit stop.");
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
