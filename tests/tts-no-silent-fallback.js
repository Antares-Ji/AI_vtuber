const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("public/stream.js", "utf8");
const start = source.indexOf("async function playPreparedSpeech(");
const end = source.indexOf("\nfunction ", start);
const context = { performance, recordClientLatency() {}, audioOutputEnabled: true, speechEpoch: 1, composerStatus: {}, activeTtsControllers: new Set(), browserSpeak() { throw new Error("must never fall back"); } };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
(async () => {
  await assert.rejects(context.playPreparedSpeech(Promise.reject(new Error("backend offline")), "test", {}, 1), /backend offline/);
  assert.match(context.composerStatus.textContent, /未切换系统声音/);
  console.log("TTS failure visibly reported without system-voice fallback.");
})().catch(error => { console.error(error); process.exitCode = 1; });
