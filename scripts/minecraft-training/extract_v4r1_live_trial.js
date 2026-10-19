'use strict';

// Read-only extraction of one bounded v4r1 live window. This is an actual
// request/response/action-result trace, marked dev-only and never a train set.
const fs = require('fs');
const path = require('path');
const { compactObservation, SURVIVAL_SYSTEM } = require('../../src/minecraft/survival-planner');
const ROOT = path.resolve(__dirname, '../..');
const logPath = path.join(ROOT, 'logs/minecraft-autonomy.jsonl');
const sessionLogPath = path.join(ROOT, 'logs/minecraft-session-1791830191222.jsonl');
const startPath = path.join(ROOT, 'output/minecraft-training/v4r1-live-trial-start.json');
const endPath = path.join(ROOT, 'output/minecraft-training/v4r1-live-trial-end.json');
const outPath = path.join(ROOT, 'data/minecraft-training/v4r1-live-trial-20261012-dev-only-r1.jsonl');
const reportPath = path.join(ROOT, 'output/minecraft-training/v4r1-live-trial-r1-audit.json');
const settlementPath = path.join(ROOT, 'data/minecraft-training/v4r1-live-trial-20261012-window-settlement-r1.jsonl');
const start = JSON.parse(fs.readFileSync(startPath, 'utf8')).at;
const end = JSON.parse(fs.readFileSync(endPath, 'utf8')).at;
const rows = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .filter(r => r.at >= start && r.at <= end);
const of = event => rows.filter(r => r.event === event);
const requests = of('model_request'), completions = of('model_completion');
const decisions = of('model_decision'), results = of('model_action_result');
const byId = list => new Map(list.map(row => [row.requestId, row]));
const completionById = byId(completions), decisionById = byId(decisions), resultById = byId(results);
const expectedAdapter = 'E:\\Github\\AI_vtuber\\runtime\\minecraft-training\\adapters\\minecraft-survival-v4r1-replay-candidate\\checkpoint-epoch-01';
const normalize = x => JSON.stringify(x);
const summarizeHistoryEntry = entry => ({
  action: entry.action,
  status: entry.status,
  ...(typeof entry.error === 'string' ? { error: entry.error.slice(0, 240) } : {}),
  ...(entry.result ? { result: {
    gained: entry.result.gained,
    complete: entry.result.complete,
    enteredNether: entry.result.enteredNether,
    descended: entry.result.descended,
    waterRecovered: entry.result.waterRecovered,
    verified: entry.result.verified,
    verifiedPartial: entry.result.verifiedPartial
  } } : {})
});

const records = [];
const issues = [];
let promptObsMatches = 0, systemMatches = 0, historyMatches = 0, adapterMetadataMatches = 0, actionMatches = 0;
let prevResults = [];
for (const requestEvent of requests) {
  const id = requestEvent.requestId;
  const completionEvent = completionById.get(id) || null;
  const decision = decisionById.get(id) || null;
  const actionResult = resultById.get(id) || null;
  const request = requestEvent.request;
  const messages = request?.messages || [];
  let user = null, state = null;
  try {
    user = JSON.parse(messages.at(-1)?.content || 'null');
    state = user?.state || null;
  } catch { issues.push(`${id}: request user content is not JSON`); }
  let promptObsMatch = false;
  if (state && decision?.observation) {
    promptObsMatch = normalize(compactObservation(decision.observation)) === normalize(state);
    if (promptObsMatch) promptObsMatches++; else issues.push(`${id}: prompt state differs from decision observation compacted by runtime`);
  } else issues.push(`${id}: missing state/decision observation`);
  const systemMatch = messages[0]?.role === 'system' && messages[0]?.content === SURVIVAL_SYSTEM;
  if (systemMatch) systemMatches++; else issues.push(`${id}: system prompt differs from runtime SURVIVAL_SYSTEM`);
  const expectedHistory = prevResults.slice(-6).map(summarizeHistoryEntry);
  const actualHistory = user?.recentResults || [];
  const historyMatch = normalize(expectedHistory) === normalize(actualHistory);
  if (historyMatch) historyMatches++; else issues.push(`${id}: recentResults history differs from previous logged action results`);
  const metadata = completionEvent?.completion?.metadata || null;
  const adapterMetadataMatch = metadata?.task === 'minecraft-survival' && metadata?.used_adapter === true && metadata?.adapter_path === expectedAdapter;
  if (adapterMetadataMatch) adapterMetadataMatches++; else issues.push(`${id}: response metadata does not prove expected v4r1 adapter use`);
  let parsedCompletion = null;
  try { parsedCompletion = completionEvent ? JSON.parse(completionEvent.completion?.content || 'null') : null; } catch {}
  const actionMatch = !!(parsedCompletion && decision && normalize(parsedCompletion) === normalize(decision.action));
  if (actionMatch) actionMatches++; else issues.push(`${id}: completion JSON differs from recorded decision action`);

  const record = {
    id: `v4r1-live-${decision?.step ?? records.length + 1}`,
    datasetType: 'dev-only actual live trajectory; immutable snapshot; do not train on exact states/prompts',
    provenance: 'real; exact request/completion/action/result copied from local logs; no synthetic labels',
    capturedAt: requestEvent.at,
    step: decision?.step ?? null,
    requestId: id,
    chainStatus: actionResult ? 'request+completion+decision+action-result' : 'request+completion+decision; action-result absent at stop cutoff; correlate later skill settlement',
    request,
    completion: completionEvent?.completion || null,
    decision,
    actionResult,
    promptStateMatchesDecisionObservation: promptObsMatch,
    promptHistoryMatchesPriorActionResults: historyMatch,
    systemPromptMatchesRuntime: systemMatch,
    adapterMetadataMatchesExpected: adapterMetadataMatch,
    completionActionMatchesDecision: actionMatch
  };
  records.push(record);
  if (actionResult) prevResults.push({ action: actionResult.action, status: actionResult.status, error: actionResult.error, result: actionResult.result });
}
fs.writeFileSync(outPath, records.map(x => JSON.stringify(x)).join('\n') + '\n');
const sessionRows = fs.readFileSync(sessionLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const lastDecision = decisions.slice().sort((a, b) => (a.step || 0) - (b.step || 0)).at(-1);
const lastAction = lastDecision?.action;
const started = sessionRows.find(r => r.event === 'skill_started' && r.at >= lastDecision.at && normalize(r.action) === normalize(lastAction));
const settlementEvents = started ? sessionRows.filter(r => r.taskId === started.taskId && r.at >= start && r.at <= end && ['skill_failed', 'skill_finished', 'skill_verified'].includes(r.event)) : [];
const settlement = started ? {
  datasetType: 'window task settlement from session log; append-only sidecar; not a new model decision',
  requestId: lastDecision.requestId,
  decisionStep: lastDecision.step,
  decisionAt: lastDecision.at,
  action: lastAction,
  taskId: started.taskId,
  skillStarted: started,
  postCutoffSkillEvents: settlementEvents,
  correlatedModelActionResult: results.find(r => r.requestId === lastDecision.requestId) || null,
  finalStatus: settlementEvents.find(r => r.event === 'skill_finished')?.status || 'unresolved',
  inventoryDeltaObservedDuringSettlement: settlementEvents.find(r => r.event === 'skill_failed') ? {
    before: settlementEvents.find(r => r.event === 'skill_failed').inventoryBefore,
    after: settlementEvents.find(r => r.event === 'skill_failed').inventoryAfter,
    caveat: 'Observed by the skill event; source and server-authoritative provenance of the item gain are not established by this event alone.'
  } : null
} : null;
if (settlement) fs.writeFileSync(settlementPath, JSON.stringify(settlement) + '\n');
const counts = {
  requests: requests.length,
  completions: completions.length,
  decisions: decisions.length,
  actionResults: results.length,
  completeChains: records.filter(r => r.actionResult).length,
  missingActionResult: records.filter(r => !r.actionResult).length,
  promptObservationMatches: promptObsMatches,
  historyMatches: historyMatches,
  systemPromptMatches: systemMatches,
  adapterMetadataMatches: adapterMetadataMatches,
  completionActionMatches: actionMatches
};
const report = {
  scope: { start, end, source: 'logs/minecraft-autonomy.jsonl', sessionLog: 'logs/minecraft-session-1791830191222.jsonl' },
  records: records.length,
  counts,
  rawTracePath: path.relative(ROOT, outPath),
  stopClassification: 'Step 24 has no model_action_result in the autonomy log. Session log links its skill_started and cancellation/finished events (all before the exact window-end timestamp); preserve this as a cancelled in-window action, not as unexecuted.',
  windowSettlement: settlement ? {
    path: path.relative(ROOT, settlementPath),
    taskId: settlement.taskId,
    finalStatus: settlement.finalStatus,
    skillEvents: settlementEvents.map(r => r.event),
    modelActionResultPresent: !!settlement.correlatedModelActionResult
  } : null,
  limitations: [
    'This is an actual trajectory candidate, not a curated gold-label dataset.',
    'Executor reachability/path-budget failures and the final cancelled skill are retained and must not be labeled as model failures without a separate policy review.',
    'No rows from the sealed final holdout were read.',
    'The trace remains development-only; exact prompts/states must not enter training.'
  ],
  issues
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
