const assert = require("node:assert/strict");
const { openAiTokenStream } = require("../src/brain/streaming-router");
const encoder = new TextEncoder();
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
async function collect() {
  let text = "";
  for await (const token of openAiTokenStream("http://test.invalid", {}, {}, AbortSignal.timeout(1000))) text += token;
  return text;
}
(async () => {
  const original = global.fetch;
  try {
    let cancelled = false;
    global.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(delta("你好") + "data: [DONE]\n\n")); },
      cancel() { cancelled = true; }
    }));
    assert.equal(await collect(), "你好", "DONE must terminate a still-open stream");
    assert.equal(cancelled, true, "terminal event must release upstream reader");

    const payload = encoder.encode(delta("中文分片") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
    global.fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of payload) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
    assert.equal(await collect(), "中文分片", "split UTF8 and final line without newline must decode");

    global.fetch = async () => new Response(delta("不完整"));
    await assert.rejects(collect(), /completion marker/);
    global.fetch = async () => new Response('data: {"error":{"message":"failed"}}\n\n');
    await assert.rejects(collect(), /error event/);
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error("must not fetch"); };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(async () => { for await (const _ of openAiTokenStream("http://test.invalid", {}, {}, controller.signal)) {} }, { name: "AbortError" });
    assert.equal(calls, 0);
    console.log("Streaming protocol passed: DONE cleanup, UTF8 fragments, terminal tail, truncated EOF, error and pre-cancellation.");
  } finally { global.fetch = original; }
})().catch(error => { console.error(error); process.exitCode = 1; });
