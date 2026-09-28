const { CircuitBreaker } = require("../runtime/circuit-breaker");
const { buildRealtimeMessages } = require("./realtime-context");

const localCircuit = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 20_000 });

function getLocalLlmConfig() {
  const enabled = /^(1|true|yes|on)$/i.test(process.env.LOCAL_LLM_ENABLED || "true");
  return {
    enabled,
    provider: "qwen-local",
    baseUrl: process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11435/v1",
    model: process.env.LOCAL_LLM_MODEL || "qwen3.5-4b"
  };
}

function classifyComplexity(item) {
  const text = String(item?.text || "").trim();
  // Lightweight patterns must match the entire utterance.  Otherwise a
  // greeting prefix can hide a complex request from the cloud router.
  const realtimePatterns = [
    /^(?:(?:hi|hello|hey)[,，!！。.\s]*)+$/i,
    /^(?:你好|您好|嗨|哈喽)(?:呀|啊|吗|嘛)?[,，!！。.\s]*$/,
    /^(?:早上好|中午好|下午好|晚上好|晚安)[呀啊吗嘛，,!！。.\s]*$/,
    /^(?:(?:hi|hello|hey)[,，!！。.\s]*)*(?:能听到|听得到|听得见|听见吗|在吗|你在不在|麦克风(?:有声音)?|声音(?:有吗|正常吗)?)[？?！!。,.，\s]*$/i,
    /^(?:谢谢你?|好的|好吧|行|可以|没事|再见|拜拜|嗯+|哦+|哈哈+)[呀啊吗嘛，,!！。.\s]*$/,
    /^(?:你是谁(?:呀)?|你叫什么(?:名字)?|请?介绍(?:一下)?自己|比较一下这(?:(?:两首)?(?:歌|歌曲)|两个角色)(?:谁更可爱)?)[？?！!。,.，\s]*$/
  ];
  if (text.length <= 60 && realtimePatterns.some(pattern => pattern.test(text))) {
    return { route: "local", reason: "realtime-greeting-or-audio-check", score: 0 };
  }
  const weightedPatterns = [
    [/代码|报错|调试|架构|部署|配置|训练|模型|算法|数据库|接口|API|SQL/i, 2],
    [/分析|比较|评估|证明|推理|计算|方案|原理|如何实现/i, 2],
    [/为什么|怎么回事|怎么做/i, 1],
    [/最新|新闻|价格|政策|法律|医学|药物|这种药|症状|诊断|投资|事实核实|天气|汇率|比赛结果/i, 3],
    [/计划|规划|路线图|里程碑|排期/i, 2],
    [/计算|算一下|求解|\d\s*[*×÷/+-]\s*\d/i, 2],
    [/请.{0,6}(详细|完整|系统)|分步骤|列出.{0,4}(优缺点|依据|建议)/i, 2]
  ];
  let score = weightedPatterns.reduce((sum, [pattern, weight]) => sum + (pattern.test(text) ? weight : 0), 0);
  if (text.length > 60) score += 1;
  if (text.length > 80) score += 1;
  if (text.length > 160) score += 1;
  const hard = score >= 2;
  return {
    route: hard ? "cloud" : "local",
    reason: hard ? "complex-or-factual" : "realtime-conversation",
    score: Math.min(1, score / 4)
  };
}

async function callLocalLlm(item, context) {
  const config = getLocalLlmConfig();
  if (!config.enabled || context.disableExternalLlm) {
    return { text: null, performanceCues: [], socialPerception: null, status: { ...config, lastMode: "local-disabled", lastError: "Local LLM disabled", lastLatencyMs: null, lastStructured: false } };
  }
  if (!localCircuit.canRequest()) {
    return { text: null, performanceCues: [], socialPerception: null, status: { ...config, lastMode: "local-unavailable", lastError: "Local LLM circuit is cooling down", lastLatencyMs: 0, lastStructured: false } };
  }

  const started = Date.now();
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: buildRealtimeMessages(item, context),
        temperature: 0.72,
        max_tokens: 120
      }),
      signal: AbortSignal.timeout(Number(process.env.LOCAL_LLM_TIMEOUT_MS || 12_000))
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
    const payload = await response.json();
    const text = String(payload.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!text) throw new Error("Empty local LLM response");
    localCircuit.success();
    return { text, performanceCues: [], socialPerception: null, status: { ...config, lastMode: "local", lastError: null, lastLatencyMs: Date.now() - started, lastStructured: false } };
  } catch (error) {
    localCircuit.failure(error.message);
    return { text: null, performanceCues: [], socialPerception: null, status: { ...config, lastMode: "local-unavailable", lastError: error.message, lastLatencyMs: Date.now() - started, lastStructured: false, circuit: localCircuit.status() } };
  }
}

module.exports = { getLocalLlmConfig, classifyComplexity, callLocalLlm };
