const BASE = process.env.AI_VTUBER_BASE_URL || "http://127.0.0.1:3000";
const user = `流式验收-${Date.now()}`;

async function post(path, value) {
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${await response.text()}`);
  return response.headers.get("content-type")?.startsWith("application/json") ? response.json() : response;
}

async function main() {
  try {
    const prompt = process.env.APP_STREAM_TEXT || "晚上好，请用两句话欢迎观众";
    const created = await post("/api/danmaku", { user, text: prompt, type: "chat", delivery: "stream" });
    const started = performance.now();
    const response = await post("/api/next-stream", { preferFresh: true, expectedItemId: created.item.id });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let firstDeltaMs = null;
    const events = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "delta" && firstDeltaMs === null) firstDeltaMs = Math.round(performance.now() - started);
      }
    }
    const done = events.find(event => event.type === "done");
    const preface = events.find(event => event.type === "preface");
    const result = { passed: Boolean(done && firstDeltaMs !== null), firstDeltaMs, totalMs: Math.round(performance.now() - started), eventTypes: [...new Set(events.map(event => event.type))], preface: preface?.text || null, mode: done?.mode, text: done?.text };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await post("/api/memory/forget-user", { user }).catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
