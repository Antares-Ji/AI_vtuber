const { classifyComplexity, getLocalLlmConfig } = require("./local-llm");
const { getLlmConfig } = require("./llm");
const { buildRealtimeMessages } = require("./realtime-context");
const { applyReplyPolicy } = require("./policy");

const THINKING_PREFACES = [
  "嗯……",
  "呃……让我看看。",
  "唔……",
  "啊，等一下。",
  "嗯，对……",
  "呃，我想一下。",
  "唔，我看看。",
  "嗯……让我捋一下。",
  "啊……我想想。",
  "嗯，稍等一下哦。",
  "呃……对，让我看一下。",
  "唔，这里我想一下。"
];
let lastPrefaceIndex = -1;

function selectThinkingPreface(item = {}) {
  const seed = [...String(item.text || "")].reduce((sum, char) => sum + char.codePointAt(0), Date.now() % 997);
  let index = Math.abs(seed) % THINKING_PREFACES.length;
  if (index === lastPrefaceIndex) index = (index + 1) % THINKING_PREFACES.length;
  lastPrefaceIndex = index;
  return THINKING_PREFACES[index];
}

async function* openAiTokenStream(url, headers, body, signal) {
  signal?.throwIfAborted();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ...body, stream: true }), signal });
  if (!response.ok || !response.body) throw new Error(`Streaming LLM HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
  const decoder = new TextDecoder();
  let pending = "";
  const parseLine = line => {
    if (!line.startsWith("data:")) return {};
    const data = line.slice(5).trim();
    if (!data) return {};
    if (data === "[DONE]") return { complete: true };
    const payload = JSON.parse(data);
    if (payload.error) throw new Error("Streaming LLM returned an error event");
    const choice = payload.choices?.[0];
    return { token: choice?.delta?.content, complete: choice?.finish_reason != null };
  };
  for await (const chunk of response.body) {
    signal?.throwIfAborted();
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      const { token, complete } = parseLine(line);
      if (token) yield token;
      if (complete) return;
    }
  }
  signal?.throwIfAborted();
  const { token, complete } = parseLine(pending + decoder.decode());
  if (token) yield token;
  if (!complete) throw new Error("Streaming LLM ended before a completion marker");
}

async function* streamRoutedReply(item, context, signal) {
  const preflight = selectStreamPreflight(item, context);
  if (preflight) {
    yield {
      type: "delta",
      text: preflight.text,
      routing: { route: "fallback", reason: preflight.reason, originalReason: "policy-preflight" },
      model: "local-rule-fallback",
      mode: "policy-fallback"
    };
    return;
  }
  const routing = classifyComplexity(item);
  const messages = buildRealtimeMessages(item, context);
  const localConfig = getLocalLlmConfig();
  const cloudConfig = getLlmConfig();
  const localTokens = () => providerTokens({ name: "local", enabled: localConfig.enabled && !context.disableExternalLlm, url: `${localConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, headers: {}, model: localConfig.model, messages, signal, maxTokens: context.realtimeMaxTokens });
  const cloudTokens = () => providerTokens({ name: "cloud", enabled: cloudConfig.enabled && !context.disableExternalLlm, url: `${cloudConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, model: cloudConfig.model, messages, signal });
  const plans = routing.route === "local"
    ? [{ route: "local", model: localConfig.model, mode: "local-stream", tokens: localTokens }, { route: "cloud", model: cloudConfig.model, mode: "cloud-stream", tokens: cloudTokens }]
    : [{ route: "cloud", model: cloudConfig.model, mode: "cloud-stream", tokens: cloudTokens }, { route: "local", model: localConfig.model, mode: "local-stream", tokens: localTokens }];
  if (routing.route === "cloud") yield { type: "preface", text: selectThinkingPreface(item), routing };

  let firstError = null;
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const eventRouting = index === 0 ? routing : {
      ...routing,
      route: plan.route,
      reason: `${plans[index - 1].route}-unavailable-fallback`,
      fallbackFrom: plans[index - 1].route,
      originalReason: routing.reason
    };
    let emitted = false;
    try {
      for await (const token of plan.tokens()) {
        emitted = true;
        yield { type: "delta", text: token, routing: eventRouting, model: plan.model, mode: plan.mode };
      }
      if (!emitted) throw new Error(`${plan.route} streamed an empty response`);
      return;
    } catch (error) {
      if (signal?.aborted || emitted) throw error;
      firstError ||= error;
      if (index === 0 && routing.route === "local") {
        const fallbackRouting = {
          ...routing,
          route: plans[1].route,
          reason: `${plan.route}-unavailable-fallback`,
          fallbackFrom: plan.route,
          originalReason: routing.reason
        };
        yield { type: "preface", text: selectThinkingPreface(item), routing: fallbackRouting };
      }
    }
  }

  if (context.fallbackText) {
    yield {
      type: "delta",
      text: context.fallbackText,
      routing: { ...routing, route: "fallback", reason: "providers-unavailable-fallback", fallbackFrom: routing.route, originalReason: routing.reason },
      model: "local-rule-fallback",
      mode: "rule-fallback"
    };
    return;
  }
  throw firstError || new Error("No streamed reply provider is available");
}

async function* providerTokens({ name, enabled, url, headers, model, messages, signal, maxTokens = 180 }) {
  if (!enabled) throw new Error(`${name} LLM is disabled or unavailable`);
  const configuredTimeout = Number(process.env.STREAMING_LLM_TIMEOUT_MS || 20_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(120_000, Math.max(1_000, Math.trunc(configuredTimeout))) : 20_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  yield* openAiTokenStream(url, headers, { model, messages, temperature: 0.72, max_tokens: maxTokens }, requestSignal);
}

function selectStreamPreflight(item, context = {}) {
  const options = {
    item,
    capabilityRequest: context.capabilityRequest,
    maxCharacters: context.direction?.responseBudget?.maxCharacters || 180,
    persona: context.personaMeta,
    memoryRetrieval: context.retrieval
  };
  const direct = applyReplyPolicy("", options);
  if (direct.interventions.length) return { text: direct.text, reason: direct.interventions[0] };

  // A direct lyric request needs a reply-level guard before any text reaches
  // speech; the synthetic sample triggers the policy's lyric classifier.
  const lyricProbe = applyReplyPolicy("一。二。三。四。五。六。", options);
  if (lyricProbe.interventions.includes("copyright-lyrics")) return { text: lyricProbe.text, reason: "copyright-lyrics" };

  // These paths already have a grounded local response prepared by the brain.
  // Returning it immediately avoids a streamed claim that later policy would
  // have to replace after the client has spoken it.
  if (context.fallbackText && context.capabilityRequest?.status && context.capabilityRequest.status !== "ready") {
    return { text: context.fallbackText, reason: "capability-preflight" };
  }
  if (context.fallbackText && context.memoryLookup) return { text: context.fallbackText, reason: "memory-preflight" };
  return null;
}

module.exports = { THINKING_PREFACES, selectThinkingPreface, openAiTokenStream, streamRoutedReply, providerTokens, selectStreamPreflight };
