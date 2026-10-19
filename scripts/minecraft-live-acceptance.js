'use strict';
// Offline only: consumes logs, never contacts Minecraft or the model endpoint.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inventoryDelta, failureClass } = require('./minecraft-audit');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const finiteMax = values => { const finite = values.filter(Number.isFinite); return finite.length ? Math.max(...finite) : null; };
function read(file) {
  const events = [], malformed = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try { events.push(JSON.parse(line)); } catch { malformed.push(index + 1); }
  });
  return { events, malformed };
}
function intent(action = {}) {
  // Count changes do not make an unchanged missing-resource failure a recovery.
  return JSON.stringify([action.action, action.item || null, action.resource || null, action.direction || null]);
}
function cohort(event) {
  const metadata = event.modelMetadata;
  if (metadata?.used_adapter === false) return 'base';
  if (metadata?.used_adapter === true) return `adapter:${metadata.adapter_path || 'path-unknown'}`;
  return 'unknown';
}
function distance(a, b) { return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null; }
function corroborate(row) {
  const result = row.result || {}, action = row.action || {};
  const native = Array.isArray(result.inventoryBefore) && Array.isArray(result.inventoryAfter);
  const hasInventory = native || (Array.isArray(row.before?.inventory) && Array.isArray(row.after?.inventory));
  const delta = hasInventory ? inventoryDelta(native ? result.inventoryBefore : row.before.inventory, native ? result.inventoryAfter : row.after.inventory) : null;
  const evidence = { taskId: row.taskId, at: row.at, action, status: row.status, cohort: cohort(row), healthBefore: row.before?.health ?? null, healthAfter: row.after?.health ?? null, executorVerified: result.verified === true,
    inventorySource: native ? 'executor-local' : hasInventory ? 'outer-observation-may-include-inference-time' : 'missing', inventoryDelta: delta, corroborated: false, progress: false, reason: null };
  if (row.status !== 'completed' || result.verified !== true) { evidence.reason = 'not-completed-and-verified'; return evidence; }
  let confirmed = false;
  switch (action.action) {
    case 'craft': case 'smelt': case 'collect_water':
      confirmed = !!delta && (delta[result.item || (action.action === 'collect_water' ? 'water_bucket' : action.item)] || 0) > 0;
      break;
    case 'gather_wood': case 'mine': case 'hunt': {
      const names = result.items || (action.action === 'gather_wood' ? Object.keys(delta || {}).filter(n => /_log$/.test(n)) : []);
      const gain = names.reduce((n, name) => n + (delta?.[name] || 0), 0);
      confirmed = gain > 0 && (!Number.isFinite(result.gained) || gain >= result.gained);
      break;
    }
    case 'eat':
      if (result.alreadyFull) { evidence.corroborated = row.before?.food >= 20; evidence.reason = 'already-full-no-progress'; return evidence; }
      confirmed = !!delta && delta[result.item] < 0 && result.foodAfter > result.foodBefore;
      break;
    case 'explore': case 'flee': confirmed = distance(result.from, result.to) >= 4; break;
    case 'dig_staircase': confirmed = result.descended > 0 && result.from?.y - result.to?.y >= result.descended; break;
    case 'place_water': confirmed = result.obsidianWorldVerified === true && result.waterRecovered === true && !!result.cooledObsidian; break;
    case 'build_portal': confirmed = result.frameVerified === true && result.portalActive === true; break;
    case 'enter_portal': confirmed = result.enteredNether === true && /nether/.test(String(row.after?.dimension)) && !/nether/.test(String(row.before?.dimension)); break;
    case 'observe': evidence.corroborated = true; evidence.reason = 'observation-only'; return evidence;
  }
  evidence.corroborated = confirmed; evidence.progress = confirmed;
  evidence.reason = confirmed ? 'action-specific-evidence-present' : 'missing-or-contradictory-action-evidence';
  if (result.complete === false) evidence.partial = true;
  return evidence;
}
function report(autonomy, session, { from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Explicit valid --from and --to UTC timestamps are required');
  const within = event => Date.parse(event.at) >= start && Date.parse(event.at) < end;
  const actions = [...new Map(autonomy.filter(e => within(e) && e.event === 'model_action_result').map((e, i) => [e.taskId || `missing-${i}`, e])).values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const decisions = autonomy.filter(e => within(e) && e.event === 'model_decision');
  const safety = session.filter(within), cohorts = {};
  const evidence = actions.map(corroborate);
  for (const row of decisions) { const c = cohorts[cohort(row)] ||= { decisions: 0, results: 0, failed: 0, corroborated: 0, progress: 0 }; c.decisions++; }
  for (const row of evidence) {
    const c = cohorts[row.cohort] ||= { decisions: 0, results: 0, failed: 0, corroborated: 0, progress: 0 };
    c.results++; c.failed += row.status !== 'completed'; c.corroborated += row.corroborated; c.progress += row.progress;
  }
  const failures = actions.filter(row => row.status !== 'completed');
  const repeated = [];
  for (let i = 1; i < actions.length; i++) {
    const previous = actions[i - 1], current = actions[i];
    if (previous.status === 'completed' || current.status === 'completed' || intent(previous.action) !== intent(current.action) || failureClass(previous.error) !== failureClass(current.error)) continue;
    const a = previous.after || previous.before, b = current.before;
    const comparable = Array.isArray(a?.inventory) && Array.isArray(b?.inventory) && a?.position && b?.position;
    if (comparable && distance(a.position, b.position) <= 2 && Object.keys(inventoryDelta(a.inventory, b.inventory)).length === 0) repeated.push({ previousTaskId: previous.taskId, taskId: current.taskId, intent: current.action, error: current.error, cohort: cohort(current) });
  }
  const timings = safety.filter(e => e.event === 'reactive_timing');
  const deaths = safety.filter(e => e.event === 'death');
  const routes = safety.filter(e => e.event === 'escape_short_route');
  const healthTrace = safety.filter(e => Number.isFinite(e.health)).map(e => ({ at: e.at, event: e.event, health: e.health, position: e.position }));
  return { rubric: 'minecraft-live-v2-acceptance-1', from, to, cohorts, decisions: decisions.length, results: actions.length,
    failures: failures.length, failureRate: actions.length ? failures.length / actions.length : null,
    repeatedUnchangedFailures: repeated.length, repeatedFailureRateAmongAttempts: actions.length ? repeated.length / actions.length : null, repeatedFailureEvidence: repeated,
    rejectedDecisions: autonomy.filter(e => within(e) && ['decision_rejected', 'decision_stale'].includes(e.event)).map(e => ({ at: e.at, action: e.action, error: e.error, reason: e.reason })),
    actionEvidence: evidence,
    safety: { deaths: deaths.length, deathEvents: deaths, minimumLoggedHealth: healthTrace.length ? Math.min(...healthTrace.map(e => e.health)) : null, healthTrace, escapeRoutesIssued: routes.length, blockedEvents: safety.filter(e => e.event === 'escape_blocked').length,
      threatClearedEvents: safety.filter(e => e.event === 'threat_cleared').length,
      timingLogSamples: timings.length, sampledTickMaxMs: finiteMax(timings.map(e => e.tickMs)), sampledGapMaxMs: finiteMax(timings.map(e => e.sampleGapMs)),
      observedCumulativeTickMaxMs: finiteMax(timings.map(e => e.maxTickMs)), observedCumulativeGapMaxMs: finiteMax(timings.map(e => e.maxSampleGapMs)),
      observedCumulativeFallbackOverruns: finiteMax(timings.map(e => e.fallbackOverruns)),
      escapeAcceptance: !routes.length ? 'not-exercised' : deaths.length ? 'death-observed-review-needed' : 'routes-observed-review-endpoints-and-threat-clearance' },
    limits: ['Offline logs corroborate executor observations; they are not an independent game sensor.', 'Completed partial gains count as progress but not full requested quantity.', 'Death and timing counts cover only supplied logs and timestamps; sparse timing logs do not support per-tick percentiles.', 'Cumulative timing maxima may predate this window until reactive reload; report them separately from sampled window values.', 'Different prompts, compact observations, executors or world states confound model-weight comparisons. Only frozen identical-input base/adapter evaluation isolates a weight contrast.', 'No danger encountered means escape behavior remains untested. Issuing a route alone does not establish escape success.', 'Unknown completion metadata never proves adapter use.'] };
}
if (require.main === module) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const autonomyFile = option('--autonomy'), sessionFile = option('--session');
  if (!autonomyFile || !sessionFile || !option('--output')) throw new Error('--autonomy, --session, --from, --to and --output required');
  const autonomy = read(autonomyFile), session = read(sessionFile);
  const result = report(autonomy.events, session.events, { from: option('--from'), to: option('--to') });
  result.sources = { autonomy: { path: autonomyFile, sha256: hash(autonomyFile), malformedLines: autonomy.malformed }, session: { path: sessionFile, sha256: hash(sessionFile), malformedLines: session.malformed } };
  result.implementationHashes = Object.fromEntries(['src/minecraft/survival-planner.js', 'src/minecraft/survival-skills.js', 'src/minecraft/reactive-agent.js', 'src/minecraft/autonomy-loop.js'].map(file => [file, hash(path.resolve(__dirname, '..', file))]));
  result.implementationHashTiming = 'Report-time checkout; establish deployment-time hashes separately before attributing changes.';
  fs.mkdirSync(path.dirname(path.resolve(option('--output'))), { recursive: true });
  fs.writeFileSync(option('--output'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: option('--output'), decisions: result.decisions, results: result.results, cohorts: result.cohorts, safety: result.safety }, null, 2));
}
module.exports = { report, corroborate, intent, cohort };
