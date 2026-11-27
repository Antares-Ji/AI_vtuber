'use strict';
// DeepSeek client (OpenAI-compatible) with hard cost guardrails.
// Design law (borrowed from Numen + DeepMind): "every observation costs an LLM call".
// So: we call the model only for high-level decisions, we cap tokens, and we enforce a per-hour call budget.
const cfg = require('../config');
const log = require('../log');

const calls = []; // timestamps of calls in the current window

function budgetOk() {
  const now = Date.now();
  while (calls.length && now - calls[0] > 3600_000) calls.shift();
  return calls.length < cfg.deepseek.maxCallsPerHour;
}

class BudgetError extends Error {}

/**
 * Chat completion returning { content, usage }.
 * @param {Array} messages  [{role, content}]
 * @param {object} opts     {maxTokens, temperature, json}
 */
async function chat(messages, opts = {}) {
  if (!cfg.deepseek.apiKey) throw new Error('DEEPSEEK_API_KEY missing');
  if (!budgetOk()) {
    log.warn('LLM budget exhausted, refusing call. calls in last hour =', calls.length);
    throw new BudgetError('llm_budget_exhausted');
  }
  calls.push(Date.now());

  const body = {
    model: opts.model || cfg.deepseek.model,
    messages,
    max_tokens: opts.maxTokens ?? cfg.deepseek.maxTokens,
    temperature: opts.temperature ?? cfg.deepseek.temperature,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  // Thinking mode is worth the latency on the decisions that unstick the bot; it is not
  // worth it on chat replies, which must feel instant to the human.
  const think = opts.think === undefined ? cfg.deepseek.thinking : opts.think;
  if (think) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = cfg.deepseek.reasoningEffort;
  }
  // `max_tokens` is a ceiling on reasoning AND the answer together, so a call can spend all of it
  // reasoning and return an empty message. Measured from runs/llm.jsonl over 6 h to 03:1x: 140 calls
  // came back with no content and EVERY one of them read out=2500 / reasoning_tokens=2500 - the cap,
  // exactly. The thinking flag is NOT the discriminator (74 of the 140 were `think=false`), because
  // deepseek-flash emits reasoning tokens either way, so the room has to be bought unconditionally -
  // raising a ceiling costs nothing when the answer is short (the 813-token average of the calls that
  // did answer proves the answer itself was never the long part).
  body.max_tokens = Math.min(cfg.deepseek.maxTokensCap, body.max_tokens + (cfg.deepseek.reasoningRoom || 0));

  const t0 = Date.now();
  const res = await fetch(`${cfg.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.deepseek.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs || 120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.err('LLM HTTP', res.status, text.slice(0, 300));
    throw new Error(`deepseek http ${res.status}`);
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message ? choice.message.content : '';
  const usage = data.usage || {};
  const pd = usage.prompt_tokens_details || {};
  const cd = usage.completion_tokens_details || {};
  log.llm(`model=${body.model}${think ? ' think=on' : ''} in=${usage.prompt_tokens || '?'} out=${usage.completion_tokens || '?'} cached=${pd.cached_tokens || 0} reason=${cd.reasoning_tokens || 0} ms=${Date.now() - t0}`);
  // A durable per-call ledger. The panel reads this instead of grepping a 200MB+ text log, and
  // reasoning/cached tokens are only available here, in the response - never reconstructable later.
  try {
    require('fs').appendFileSync(require('../config').paths.runs + '/llm.jsonl', JSON.stringify({
      ts: Date.now(), model: body.model, think: !!think,
      in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0,
      cached: pd.cached_tokens || 0, reasoning: cd.reasoning_tokens || 0,
      total: usage.total_tokens || 0, ms: Date.now() - t0, purpose: opts.purpose || '', ok: !!content,
      cap: body.max_tokens,
    }) + '\n');
  } catch {}
  // Still no content after the room was bought up front: one retry at the hard ceiling. Dropping `think`
  // was never the fix on its own - flash emits reasoning tokens either way, and 74 of the 140 empty calls
  // in this ledger had think=false - the ceiling is what the answer needs.
  if (!content && body.max_tokens < cfg.deepseek.maxTokensCap) {
    log.warn(`LLM empty answer (reasoning used all ${body.max_tokens} tokens); retrying at the ${cfg.deepseek.maxTokensCap} ceiling`);
    return chat(messages, { ...opts, maxTokens: cfg.deepseek.maxTokensCap });
  }
  return { content, usage };
}

/** Ask for a JSON object decision; parse defensively. */
async function json(messages, opts = {}) {
  const { content } = await chat(messages, { ...opts, json: true });
  return safeJson(content);
}

function safeJson(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { raw: s };
}

module.exports = { chat, json, safeJson, BudgetError, calls };
