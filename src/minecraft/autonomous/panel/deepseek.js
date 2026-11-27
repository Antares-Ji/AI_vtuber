'use strict';
// DeepSeek accounting for the panel.
// Two very different sources, deliberately kept apart in the UI:
//  1) runs/llm.jsonl  -> exact per-call tokens, written by src/llm/deepseek.js from the API response
//                        (reasoning/cached tokens exist nowhere else), so token counts are facts.
//  2) GET /user/balance -> the only usage-ish endpoint DeepSeek documents for an API key. Money
//                        figures derived from tokens are ESTIMATES from the published price range
//                        and are configurable; the precise per-day billing report needs a platform
//                        web session token, which this panel does not touch.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const LEDGER = path.join(cfg.paths.runs, 'llm.jsonl');

// CNY per 1M tokens. Defaults sit in the documented Flash band (input 0.02-1, output 4-8);
// override in .env: DEEPSEEK_PRICE_INPUT / _CACHED / _OUTPUT.
const PRICE = {
  in: Number(process.env.DEEPSEEK_PRICE_INPUT ?? 1),
  cached: Number(process.env.DEEPSEEK_PRICE_CACHED ?? 0.02),
  out: Number(process.env.DEEPSEEK_PRICE_OUTPUT ?? 4),
};

function readTail(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), size, partial: len < size };
  } catch (e) { return { text: '', size: 0, partial: false, error: e.code || e.message }; }
}

const costOf = (r) => ((r.in - (r.cached || 0)) * PRICE.in + (r.cached || 0) * PRICE.cached + r.out * PRICE.out) / 1e6;

function emptyAgg() { return { calls: 0, in: 0, out: 0, cached: 0, reasoning: 0, cost: 0 }; }
function add(agg, r) {
  agg.calls++; agg.in += r.in; agg.out += r.out; agg.cached += r.cached || 0;
  agg.reasoning += r.reasoning || 0; agg.cost += costOf(r);
  return agg;
}

function stats() {
  const { text, size, partial, error } = readTail(LEDGER, 4 << 20);
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue; // a partial tail cut mid-line
    try { const r = JSON.parse(line); if (r && r.ts) rows.push(r); } catch {}
  }
  // If we started mid-file, the first parsed row is fine but drop nothing else; partial only means
  // older history is outside the window, which the UI shows as "窗口内".
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const all = emptyAgg(), today = emptyAgg(), h1 = emptyAgg(), m10 = emptyAgg();
  const byModel = {}, failed = { count: 0 };
  for (const r of rows) {
    add(all, r);
    if (r.ts >= midnight.getTime()) add(today, r);
    if (r.ts >= now - 3600_000) add(h1, r);
    if (r.ts >= now - 600_000) add(m10, r);
    const m = r.model || '?';
    byModel[m] = byModel[m] || emptyAgg(); add(byModel[m], r);
    if (r.ok === false || r.think && !r.out) failed.count++;
  }
  // Hourly buckets for the last 12 hours, oldest first.
  const buckets = [];
  for (let i = 11; i >= 0; i--) {
    const start = Math.floor((now - i * 3600_000) / 3600_000) * 3600_000;
    const agg = emptyAgg();
    for (const r of rows) if (r.ts >= start && r.ts < start + 3600_000) add(agg, r);
    buckets.push({ start, label: new Date(start).getHours() + '时', calls: agg.calls, tokens: agg.in + agg.out, cost: agg.cost });
  }
  const last = rows[rows.length - 1] || null;
  return {
    ok: !error,
    ledger: { bytes: size, trimmed: partial, error: error || null, rows: rows.length },
    price: PRICE,
    budget: { callsLastHour: h1.calls, limit: cfg.deepseek.maxCallsPerHour, model: cfg.deepseek.model, thinking: cfg.deepseek.thinking, reasoningEffort: cfg.deepseek.reasoningEffort, maxTokens: cfg.deepseek.maxTokens },
    totals: { all, today, lastHour: h1, last10m: m10 },
    cacheHitRate: all.in ? Math.round((all.cached / all.in) * 100) : null,
    avgOut: all.calls ? Math.round(all.out / all.calls) : 0,
    byModel, buckets, failed: failed.count,
    lastCall: last ? { ts: last.ts, model: last.model, in: last.in, out: last.out, ms: last.ms, purpose: last.purpose || '' } : null,
    serverTime: now,
  };
}

let balCache = { at: 0, data: null };
async function balance(force) {
  if (!force && balCache.data && Date.now() - balCache.at < 60_000) return { ...balCache.data, cached: true };
  if (!cfg.deepseek.apiKey) return { ok: false, error: '没有 DEEPSEEK_API_KEY（.env）' };
  try {
    const res = await fetch(`${cfg.deepseek.baseUrl.replace(/\/+$/, '')}/user/balance`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${cfg.deepseek.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Never echo the request headers or the key; the body may still name the reason.
      const data = { ok: false, http: res.status, error: (text || '').slice(0, 200) };
      balCache = { at: Date.now(), data }; return data;
    }
    const j = JSON.parse(text);
    const infos = (j.balance_infos || []).map(b => ({
      currency: b.currency, total: Number(b.total_balance), granted: Number(b.granted_balance), toppedUp: Number(b.topped_up_balance),
    }));
    const data = { ok: true, isAvailable: j.is_available !== false, infos, fetchedAt: Date.now() };
    balCache = { at: Date.now(), data };
    return { ...data, cached: false };
  } catch (e) {
    const data = { ok: false, error: e.name === 'TimeoutError' ? '查询超时（8 秒）' : String(e.message || e).slice(0, 200) };
    balCache = { at: Date.now(), data }; return data;
  }
}

module.exports = { stats, balance, PRICE, LEDGER };
