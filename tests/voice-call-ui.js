const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const controller = fs.readFileSync("public/voice-call.js", "utf8").replace("export class", "class");
const stream = fs.readFileSync("public/stream.js", "utf8");
const section = stream.slice(stream.indexOf("function interruptVoiceCall("), stream.indexOf('voiceCallButton.addEventListener("click"'));
const element = () => ({ style: {}, setAttribute() {} });
(async () => {
  const requests = [];
  let processor, tracksStopped = 0, cancelled = 0, constraints;
  const context = {
    AbortController, AbortSignal, DOMException, Blob, DataView, Float32Array, performance, setInterval, clearInterval,
    voiceCall: null, isAsrBusy: false, mediaRecorder: null,
    voiceStatus: element(), micMeterFill: element(), voiceCallButton: element(), voiceCallRecord: element(), voiceButton: element(), microphoneSelect: element(), sendDanmaku: element(), viewerName: { value: "测试" },
    microphoneConstraints: () => ({ echoCancellation: true }),
    stopSpeechOutput() { cancelled++; }, holdConversation: async () => {}, releaseConversation: async () => {},
    api: async (path, options) => { requests.push([path, options]); return { call: { id: "test-call" } }; },
    fetch: async () => ({ ok: true, json: async () => ({ text: "你好" }) }),
    readNextStreaming: async (id, request) => requests.push([request.path, request.body]),
    navigator: { mediaDevices: { getUserMedia: async input => { constraints = input; return { getTracks: () => [{ stop() { tracksStopped++; } }] }; } } },
    AudioContext: class {
      sampleRate = 8000; destination = {};
      async resume() {} async close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; }
      createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${controller}\n${section}`, context);
  await context.startVoiceCall();
  assert.equal(constraints.audio.echoCancellation, true, "getUserMedia needs audio envelope");
  assert.equal(context.voiceCallButton.disabled, false);
  const feed = value => processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(value) } });
  feed(.03); feed(0); feed(0); feed(0);
  await context.voiceCall.queue;
  assert.ok(requests.some(([path]) => path === "/api/voice-calls/test-call/turn"));
  assert.ok(requests.every(([path]) => path !== "/api/danmaku"));
  assert.equal(tracksStopped, 0, "turn does not release microphone");
  feed(.03);
  await context.endVoiceCall();
  assert.ok(requests.some(([path, options]) => path.endsWith("/turn") && options.body && JSON.parse(options.body).interrupted));
  assert.equal(tracksStopped, 1);
  assert.equal(context.voiceCall, null);
  assert.equal(context.voiceCallButton.disabled, false);
  assert.ok(cancelled >= 3);
  assert.equal(requests.at(-1)[0], "/api/voice-calls/test-call/end");
  console.log("Voice call UI passed: audio constraints, independent routing, continuous mic, final utterance flush, end cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
