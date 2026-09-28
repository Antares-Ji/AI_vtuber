require("../src/config/env").loadEnv();

const assert = require("assert");
const { getModuleRegistry } = require("../src/runtime/module-registry");

async function main() {
  const modules = await getModuleRegistry();
  const required = [
    "orchestrator",
    "realtimeAudio",
    "vad",
    "localLlm",
    "cloudLlm",
    "router",
    "asr",
    "tts",
    "memory",
    "vision",
    "gameAgent",
    "optionalNode"
  ];
  for (const name of required) {
    assert(modules[name], `missing module: ${name}`);
    assert.strictEqual(typeof modules[name].ready, "boolean", `${name}.ready must be boolean`);
    assert(modules[name].role, `${name}.role is required`);
  }
  assert.strictEqual(modules.gameAgent.ready, false, "live game control must remain disabled by default");
  assert.strictEqual(modules.optionalNode.capabilities.dynamicJoin, false, "5070 dynamic join is not implemented yet");
  assert.strictEqual(modules.asr.capabilities.batchRecognition, true, "ASR batch recognition must be reported");
  assert.strictEqual(modules.asr.capabilities.partialTranscripts, "client-cumulative-webm-batch-v1", "ASR partials must identify their cumulative batch transport");
  assert.strictEqual(modules.asr.capabilities.nativeAudioStreaming, false, "ASR must not claim native audio streaming before it exists");
  console.log("Module registry test passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
