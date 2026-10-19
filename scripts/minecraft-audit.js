'use strict';
// Read-only evidence audit. Never starts inference, training, or game actions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readEvents(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
}
function inventoryDelta(before = [], after = []) {
  const counts = items => items.reduce((out, i) => { out[i.name] = (out[i.name] || 0) + i.count; return out; }, {});
  const a = counts(before), b = counts(after);
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(name => [name, (b[name] || 0) - (a[name] || 0)]).filter(([, n]) => n !== 0));
}
function failureClass(error = '') {
  if (/death|died|死亡|health/i.test(error)) return 'death_or_health';
  if (/hostile|threat|Unsafe|危险|preempt|abort|cancel|停止/i.test(error)) return 'safety_or_cancellation';
  if (/tool|ingredient|Missing|enough|requires|Craft .* first|fuel|食物|No safe edible/i.test(error)) return 'missing_prerequisite';
  if (/path|reachable|No inventory gain|No flat|displacement|No nearby|No active|Placement blocked/i.test(error)) return 'navigation_or_resource';
  if (/timeout|deadline|timed out|超时/i.test(error)) return 'timeout';
  if (/JSON|Invalid|Unknown action|schema/i.test(error)) return 'model_output';
  if (/disconnect|连接|ECONN|HTTP|unavailable|not a function/i.test(error)) return 'runtime_or_transport';
  return 'other';
}
function summarize(autonomy, session = []) {
  const decisions = autonomy.filter(e => e.event === 'model_decision');
  const results = autonomy.filter(e => e.event === 'model_action_result');
  const unique = [...new Map(results.map((r, i) => [r.taskId || `row-${i}`, r])).values()];
  const byAction = {}, failures = {};
  const evidence = [];
  for (const r of unique) {
    const name = r.action?.action || 'unknown';
    const row = byAction[name] ||= { attempted: 0, completed: 0, verified: 0, failed: 0 };
    row.attempted++;
    if (r.status === 'completed') row.completed++; else { row.failed++; const category = failureClass(r.error); failures[category] = (failures[category] || 0) + 1; }
    if (r.status === 'completed' && r.result?.verified === true) {
      row.verified++;
      evidence.push({ taskId: r.taskId, action: r.action, adapterUsed: typeof r.modelMetadata?.used_adapter === 'boolean' ? r.modelMetadata.used_adapter : null, inventoryDelta: inventoryDelta(r.before?.inventory, r.after?.inventory), from: r.before?.position, to: r.after?.position, dimension: r.after?.dimension });
    }
  }
  const latencies = decisions.map(e => e.latencyMs);
  const verified = evidence.length;
  const netherEvents = autonomy.filter(e => (e.event === 'nether_dimension_observed' && e.verified === true && /nether/.test(String(e.dimension))) || (e.event === 'model_action_result' && e.result?.enteredNether === true && /nether/.test(String(e.after?.dimension))));
  const deaths = session.filter(e => e.event === 'death');
  return { generatedAt: new Date().toISOString(), decisionCount: decisions.length, baseDecisionCount: decisions.filter(e => e.modelMetadata?.used_adapter === false).length, adapterDecisionCount: decisions.filter(e => e.modelMetadata?.used_adapter === true).length,
    unknownAdapterDecisionCount: decisions.filter(e => typeof e.modelMetadata?.used_adapter !== 'boolean').length,
    adapterPathsReported: [...new Set(decisions.map(e => e.adapter).filter(Boolean))],
    modelLatencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), maximum: latencies.length ? Math.max(...latencies.filter(Number.isFinite)) : null },
    attemptedSkills: unique.length, verifiedSkills: verified, verifiedSkillRate: unique.length ? verified / unique.length : null, byAction, failureAttribution: failures,
    sessionDeaths: deaths.length, deathEvents: deaths.map(e => ({ at: e.at, position: e.position, health: e.health })), netherObserved: netherEvents.length > 0, netherEvidence: netherEvents,
    verifiedEvidence: evidence,
    limits: ['Skill completion is distinct from survival progression and model quality.', 'Adapter counts require per-completion used_adapter metadata; legacy health-only logs are unknown. Verify the artifact and health response separately.', 'Failures are classified by error text for triage; classification is not proof of cause.', 'Missing death events do not prove that no death occurred outside the provided session log.'] };
}
function adapterArtifact(directory) {
  if (!directory) return null;
  const weight = path.join(directory, 'adapter_model.safetensors'), config = path.join(directory, 'adapter_config.json');
  const result = { directory, weightsExist: fs.existsSync(weight), configExists: fs.existsSync(config) };
  if (result.weightsExist) { const bytes = fs.readFileSync(weight); result.weightBytes = bytes.length; result.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); }
  if (result.configExists) { const parsed = JSON.parse(fs.readFileSync(config, 'utf8')); result.config = { peft_type: parsed.peft_type, r: parsed.r, lora_alpha: parsed.lora_alpha, target_modules: parsed.target_modules, base_model_name_or_path: parsed.base_model_name_or_path }; }
  return result;
}
if (require.main === module) {
  const args = process.argv.slice(2), option = key => { const at = args.indexOf(key); return at >= 0 ? args[at + 1] : undefined; };
  const autonomyPath = option('--autonomy') || path.resolve(__dirname, '../logs/minecraft-autonomy.jsonl');
  const sessionPath = option('--session');
  const report = { ...summarize(readEvents(autonomyPath), readEvents(sessionPath)), sources: { autonomyPath, sessionPath: sessionPath || null }, adapterArtifact: adapterArtifact(option('--adapter')) };
  const output = option('--output');
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
module.exports = { summarize, inventoryDelta, failureClass, adapterArtifact };
