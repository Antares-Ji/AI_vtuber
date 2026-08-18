const { getLlmConfig } = require("./brain/llm");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { StreamerBrain } = require("./brain");

const VIEWERS = [
  { name: "星野", style: "温柔的老观众，喜欢夸主播，也会追问上次聊过的话题。" },
  { name: "Maple", style: "喜欢 osu! 的观众，问题具体，偶尔会玩梗。" },
  { name: "Neko", style: "活跃观众，说话短，负责带动气氛。" }
];

const fallbackLines = [
  "天依，今天状态怎么样？",
  "这段是不是可以聊聊 osu! 的练习思路？",
  "主播刚刚的反应好可爱，再说一句嘛。"
];

async function askExternal(system, user) {
  const config = getLlmConfig();
  if (!config.enabled) return null;
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.85,
        max_tokens: 70
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return null;
    return (await response.json()).choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

async function runSimulation(brain, rounds = 6) {
  const transcript = [];
  for (let turn = 0; turn < rounds; turn += 1) {
    const viewer = VIEWERS[turn % VIEWERS.length];
    const prompt = `你是直播间观众 ${viewer.name}。${viewer.style}。只发一条自然、简短的中文弹幕，不要自我介绍。`;
    const text = await askExternal(prompt, `第 ${turn + 1} 轮互动，围绕 AI 主播、音乐游戏或刚才的话题发言。`) || fallbackLines[turn % fallbackLines.length];
    const item = { user: viewer.name, text, type: "chat", timestamp: new Date().toISOString() };
    const reply = await brain.reply(item);
    transcript.push({ viewer: viewer.name, danmaku: text, streamer: reply.text, emotion: reply.emotion.name });
  }
  return { rounds, mode: getLlmConfig().enabled ? "external-llm" : "local-fallback", transcript };
}

async function runIsolatedSimulation(rounds = 6) {
  const id = randomUUID();
  const root = path.join(__dirname, "..", "runtime", "simulation");
  const databasePath = path.join(root, `${id}.db`);
  const storyPath = path.join(root, `${id}.story.json`);
  fs.mkdirSync(root, { recursive: true });
  const brain = new StreamerBrain({
    memoryOptions: { databasePath, legacyPath: path.join(root, "missing-legacy.json") },
    storyOptions: { filePath: storyPath },
    runtimeOptions: { filePath: null }
  });
  try {
    const result = await runSimulation(brain, rounds);
    return { ...result, isolated: true, productionMemoryChanged: false };
  } finally {
    brain.memoryStore.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
    fs.rmSync(storyPath, { force: true });
  }
}

module.exports = { runSimulation, runIsolatedSimulation };
