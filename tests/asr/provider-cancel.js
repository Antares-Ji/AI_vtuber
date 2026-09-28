const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const providerPath = require.resolve("../../src/asr/provider");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testFfmpegWaitsForCloseBeforeRejecting() {
  const originalSpawn = childProcess.spawn;
  let child;
  try {
    delete require.cache[providerPath];
    childProcess.spawn = () => {
      child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        setTimeout(() => child.emit("close", null), 25);
        return true;
      };
      return child;
    };
    const { convertToWav } = require("../../src/asr/provider");
    const controller = new AbortController();
    const pending = convertToWav("fake-ffmpeg", "source.webm", "output.wav", controller.signal);
    let settled = false;
    pending.catch(() => { settled = true; });

    controller.abort();
    await delay(10);
    assert.equal(settled, false, "cancellation must wait for child close before cleanup can start");
    await assert.rejects(pending, error => error.name === "AbortError");
    assert.equal(settled, true);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[providerPath];
  }
}

async function main() {
  await testFfmpegWaitsForCloseBeforeRejecting();
  console.log("ASR provider cancellation test passed: waits for ffmpeg close before rejecting.");
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
