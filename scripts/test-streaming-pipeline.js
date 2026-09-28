require("../src/config/env").loadEnv();

async function measureStream(name, url, options) {
  const started = performance.now();
  let response;
  try { response = await fetch(url, options); }
  catch (error) { throw new Error(`${name} fetch failed: ${error.cause?.message || error.message}`); }
  const headersMs = Math.round(performance.now() - started);
  if (!response.ok || !response.body) throw new Error(`${name} HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const reader = response.body.getReader();
  let firstChunkMs = null;
  let bytes = 0;
  let chunks = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - started);
    bytes += value.byteLength;
    chunks += 1;
  }
  return { name, passed: chunks > 0, headersMs, firstChunkMs, totalMs: Math.round(performance.now() - started), chunks, bytes };
}

async function main() {
  const local = await measureStream("Qwen local tokens", "http://127.0.0.1:11435/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.5-4b", stream: true, temperature: 0.2, max_tokens: 60, messages: [{ role: "system", content: "直接简短回答。" }, { role: "user", content: "用一句话欢迎观众。" }] })
  });

  const cloudBase = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const cloud = await measureStream("DeepSeek cloud tokens", `${cloudBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "deepseek-chat", stream: true, temperature: 0.2, max_tokens: 60, messages: [{ role: "user", content: "只回答：流式链路正常" }] })
  });

  const tts = await measureStream("GPT-SoVITS audio", "http://127.0.0.1:3000/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "流式语音链路现在开始播放。", style: { emotion: "neutral" } })
  });

  console.table([local, cloud, tts]);
  if (![local, cloud, tts].every(result => result.passed)) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
