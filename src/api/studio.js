const { getVisionStatus, analyzeScreenshot, recordTelemetry } = require("../vision/provider");
const { generateMemoryCandidates } = require("../brain/memory-candidates");
const { analyzeMemoryHealth, consolidateExactDuplicates } = require("../brain/memory-maintenance");
const { AFFECT_GROUPS, AFFECT_LABELS } = require("../brain/affect-schema");
const { PERSONALITY_GROUPS, PERSONALITY_LABELS } = require("../brain/personality-schema");
const { getSingingStatus } = require("../singing/provider");
const { getTtsStatus } = require("../tts/provider");
const { BRAIN_THRESHOLDS } = require("../brain/thresholds");
const { recordReplyFeedback, getFeedbackSummary } = require("../brain/feedback");
const fs = require("fs");
const path = require("path");

const RUNTIME_DIR = path.join(__dirname, "..", "..", "runtime");

async function handleStudioApi(req, res, url, dependencies) {
  const { brain, liveRuntime, runtimeMetrics, parseBody, parseBinaryBody, send } = dependencies;

  if (req.method === "GET" && url.pathname === "/api/studio/state") {
    return handled(send(res, 200, {
      memories: brain.memoryStore.listMemories({ limit: 120 }),
      memoryCandidates: brain.memoryStore.listMemoryCandidates("pending"),
      session: brain.memoryStore.getSessionStatus(),
      sessions: brain.memoryStore.listSessions(30),
      memoryHealth: analyzeMemoryHealth(brain.memoryStore),
      brain: { emotion: brain.visibleEmotion(), cognition: brain.cognition, persona: brain.memory.character, personality: brain.personality, personalityExpression: brain.personalityExpression, affectGroups: AFFECT_GROUPS, affectLabels: AFFECT_LABELS, personalityGroups: PERSONALITY_GROUPS, personalityLabels: PERSONALITY_LABELS, llm: brain.llmStatus, lastDirection: brain.lastDirection },
      story: brain.storyStore.getState(),
      vision: getVisionStatus(),
      live: liveRuntime.getStatus()
      ,runtime: runtimeMetrics.status(), singing: getSingingStatus(), tts: getTtsStatus(),
      evaluations: {
        advanced: readReport("advanced-evaluation-report.json"),
        curriculum: readReport("curriculum-evaluation-report.json"),
        emotion: readReport("emotion-evaluation-report.json"),
        external: readReport("external-evaluation-report.json")
      },
      thresholds: BRAIN_THRESHOLDS
      ,feedback: getFeedbackSummary()
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/memories") {
    return handled(send(res, 200, brain.memoryStore.listMemories({
      scope: url.searchParams.get("scope"), user: url.searchParams.get("user"), kind: url.searchParams.get("kind"),
      status: url.searchParams.get("status") || "active", limit: url.searchParams.get("limit") || 100
    })));
  }

  if (req.method === "POST" && url.pathname === "/api/memory/update") {
    const body = await parseBody(req);
    return handled(send(res, 200, { ok: true, memory: brain.memoryStore.updateMemory(body.id, body) }));
  }

  if (req.method === "POST" && url.pathname === "/api/memory/candidates/generate") {
    const body = await parseBody(req);
    return handled(send(res, 200, await generateMemoryCandidates(brain.memoryStore, { sessionId: body.sessionId || null })));
  }

  if (req.method === "POST" && url.pathname === "/api/memory/candidates/commit") {
    const body = await parseBody(req);
    const result = brain.memoryStore.commitMemoryCandidates(Array.isArray(body.items) ? body.items : []);
    if (result.approved.length) brain.storyStore.addBeat({ title: "完成一次会话记忆整理", detail: `经人工审核保存 ${result.approved.length} 条长期记忆。`, importance: 0.78 });
    return handled(send(res, 200, { ok: true, result }));
  }

  if (req.method === "GET" && url.pathname === "/api/memory/health") {
    return handled(send(res, 200, analyzeMemoryHealth(brain.memoryStore)));
  }

  if (req.method === "POST" && url.pathname === "/api/memory/maintenance/exact-duplicates") {
    const body = await parseBody(req);
    return handled(send(res, 200, consolidateExactDuplicates(brain.memoryStore, { apply: body.apply === true })));
  }

  if (req.method === "POST" && url.pathname === "/api/memory/export") {
    return handled(send(res, 200, { ok: true, ledger: brain.memoryStore.exportTrainingLedger() }));
  }

  if (req.method === "POST" && url.pathname === "/api/brain/feedback") {
    const body = await parseBody(req);
    const feedback = recordReplyFeedback({ category: String(body.category || ""), note: body.note, speech: brain.lastSpeech });
    return handled(send(res, 200, { ok: true, feedback, summary: getFeedbackSummary() }));
  }

  if (req.method === "POST" && url.pathname === "/api/story/arc") {
    return handled(send(res, 200, { ok: true, story: brain.storyStore.setArc(await parseBody(req)) }));
  }
  if (req.method === "POST" && url.pathname === "/api/story/goal") {
    const body = await parseBody(req);
    return handled(send(res, 200, { ok: true, story: body.id ? brain.storyStore.updateGoal(body.id, body.status) : brain.storyStore.addGoal(body.text) }));
  }
  if (req.method === "POST" && url.pathname === "/api/story/beat") {
    return handled(send(res, 200, { ok: true, story: brain.storyStore.addBeat(await parseBody(req)) }));
  }
  if (req.method === "POST" && url.pathname === "/api/story/schedule") {
    const body = await parseBody(req);
    return handled(send(res, 200, { ok: true, story: body.completeId ? brain.storyStore.markScheduleDone(body.completeId) : brain.storyStore.addSchedule(body) }));
  }

  if (req.method === "POST" && url.pathname === "/api/vision/analyze") {
    const image = await parseBinaryBody(req, 12_000_000);
    return handled(send(res, 200, await analyzeScreenshot(image, req.headers["content-type"] || "image/png")));
  }
  if (req.method === "POST" && url.pathname === "/api/vision/telemetry") {
    const observation = await recordTelemetry(await parseBody(req));
    brain.storyStore.addBeat({ title: `osu! 训练：${observation.mapTitle}`, detail: `准确率 ${observation.accuracy}%，miss ${observation.misses}，建议：${observation.suggestions.join("；")}`, importance: 0.82 });
    return handled(send(res, 200, observation));
  }

  if (req.method === "POST" && url.pathname === "/api/live/bilibili-event") {
    return handled(send(res, 200, liveRuntime.ingestBilibiliEvent(await parseBody(req))));
  }
  if (req.method === "POST" && url.pathname === "/api/live/obs-scene") {
    const body = await parseBody(req);
    return handled(send(res, 200, await liveRuntime.setScene(String(body.sceneName || ""))));
  }

  return false;
}

function handled() { return true; }

function readReport(fileName) {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, fileName), "utf8"));
    const total = Number(report.total ?? report.turns ?? report.results?.length ?? 0);
    const passed = Number(report.passed ?? (Array.isArray(report.results)
      ? report.results.filter(item => item.passed === true || (item.checks && Object.values(item.checks).every(Boolean))).length : 0));
    return { generatedAt: report.generatedAt, score: report.score, passed, total, isolated: report.isolated !== false };
  } catch { return null; }
}

module.exports = { handleStudioApi };
