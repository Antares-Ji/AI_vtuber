const { classifyComplexity, callLocalLlm } = require("./local-llm");
const { getLlmConfig } = require("./llm");

async function runDualBrainDiagnostics() {
  const simpleItem = { user: "验收", text: "晚上好" };
  const complexItem = { user: "验收", text: "请分析双模型架构的故障点并给出改进方案" };
  const localStarted = Date.now();
  const local = await callLocalLlm(simpleItem, { persona: "你是友好的中文 AI 主播。", recent: [] });

  const cloudConfig = getLlmConfig();
  const cloudStarted = Date.now();
  let cloud = { ok: false, latencyMs: 0, model: cloudConfig.model, error: "Cloud LLM is not configured" };
  if (cloudConfig.enabled) {
    try {
      const response = await fetch(`${cloudConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: cloudConfig.model,
          messages: [{ role: "system", content: "你是链路健康检查器，只回答正常。" }, { role: "user", content: "链路检查" }],
          temperature: 0,
          max_tokens: 8
        }),
        signal: AbortSignal.timeout(15_000)
      });
      cloud = { ok: response.ok, latencyMs: Date.now() - cloudStarted, model: cloudConfig.model, error: response.ok ? null : `HTTP ${response.status}` };
      await response.body?.cancel();
    } catch (error) {
      cloud = { ok: false, latencyMs: Date.now() - cloudStarted, model: cloudConfig.model, error: error.message };
    }
  }

  const simpleRoute = classifyComplexity(simpleItem);
  const complexRoute = classifyComplexity(complexItem);
  return {
    ok: simpleRoute.route === "local" && complexRoute.route === "cloud" && local.status.lastMode === "local" && cloud.ok,
    local: { ok: local.status.lastMode === "local", latencyMs: Date.now() - localStarted, model: local.status.model, route: simpleRoute.route },
    cloudAcknowledgement: { ok: complexRoute.route === "cloud", latencyMs: 0, route: complexRoute.route, text: "这个问题稍微复杂一点，我想想啊。" },
    cloud,
    note: "This probe bypasses the public danmaku queue, so an open browser cannot consume its test messages."
  };
}

module.exports = { runDualBrainDiagnostics };
