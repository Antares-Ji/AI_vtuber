const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { AutonomyLoop } = require('../src/minecraft/autonomy-loop');
const { VisualCommentary } = require('../src/minecraft/visual-commentary');
const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
// Isolate the actual server scheduler from listening sockets and live services.
const scheduler = server.slice(server.indexOf('let commentaryController ='), server.indexOf('let liveGameCache ='));
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const commentary = new VisualCommentary();
  const current = { connected: true, busy: false, health: 1, reactive: { mode: 'idle', lifecycleEpoch: 1 } };
  const calls = [];
  let finish;
  commentary.describe = args => {
    calls.push(args); commentary.busy = true;
    return new Promise(resolve => { finish = value => { commentary.busy = false; resolve(value); }; });
  };
  const ctx = { require: require('node:module').createRequire(require.resolve('../src/server')), minecraftEngine: { config: { provider: 'local-qwen' }, modelState() { return {}; }, plan() { throw Error('Unexpected planner call'); } }, AbortController, AbortSignal, Date, AutonomyLoop,
    minecraftCommentary: commentary, minecraftMcp: { request() { throw Error('Scheduler must not send game actions'); } },
    minecraftBridge: { async control() { return current; } }, nextInFlight: false, cloudReplyInFlight: null, deferredReply: null, queue: [],
    brain: { personaRuntime: { controller: new AbortController() }, persona: {}, prepareStreamReply(item) { return { item, context: {} }; }, commitStreamReply(_item, _context, text) { return { text }; } }
  };
  vm.createContext(ctx); vm.runInContext(scheduler, ctx);
  const loop = vm.runInContext('minecraftLoop', ctx);
  const result = { state: structuredClone(current) };
  return { ctx, loop, commentary, calls, result, start: () => ctx.requestMinecraftCommentary(result), finish: value => finish(value) };
}

(async () => {
  const run = fixture();
  run.loop.activeTaskId = 'already-executing';
  run.loop.state.currentSubgoal = '寻找安全的食物来源，再继续制作铁镐';
  run.start(); run.start();
  assert.equal(run.calls.length, 1, 'reentrant result/timer gets no second model slot');
  assert.equal(run.loop.chatHoldEpoch, 1, 'reentrant call must not replace hold owner');
  assert.equal(run.loop.activeTaskId, 'already-executing', 'vision must leave existing game task untouched');
  run.loop.onPlanning();
  assert.equal(run.calls[0].signal.aborted, false, 'ordinary planning no longer cancels vision');
  assert.equal(run.calls[0].result.state.health, 1, 'alive, idle low health does not mute the streamer');
  assert.equal(run.calls[0].currentSubgoal, run.loop.state.currentSubgoal, 'commentary receives the actual current plan');
  run.finish('我现在血量很低，得小心一点。'); await settle();
  assert.equal(run.loop.chatHoldUntil, 0, 'planning resumes as soon as inference finishes');
  assert.ok(run.ctx.deferredReply?.commentaryId);
  run.start(); assert.equal(run.calls.length, 1, 'wait for speech playback receipt');
  const receipt = run.ctx.deferredReply.commentaryId;
  run.ctx.deferredReply = null;
  const before = Date.now(); run.commentary.playbackEnded(receipt);
  assert.ok(run.commentary.nextAt >= before + 10000);
  run.start(); assert.equal(run.calls.length, 1, 'ten-second playback-end cooldown respected');

  const independent = fixture(); independent.loop.state.provider = 'astra'; independent.start();
  assert.equal(independent.loop.chatHoldEpoch, undefined, 'Astra planning is independent of local narration');
  assert.equal(independent.calls[0].stateOnly, true); independent.finish(null); await settle();
  const interrupted = fixture(); interrupted.start();
  interrupted.ctx.preemptMinecraftCommentary();
  const releaseAudience = interrupted.loop.prioritizeConversation();
  const audienceUntil = interrupted.loop.chatHoldUntil;
  assert.equal(interrupted.calls[0].signal.aborted, true, 'audience immediately aborts vision');
  interrupted.finish('过期旁白'); await settle();
  assert.equal(interrupted.loop.chatHoldUntil, audienceUntil, 'old vision completion must not release new audience hold');
  assert.equal(interrupted.ctx.deferredReply, null, 'preempted speech cannot be delivered');
  releaseAudience();

  const queued = fixture(); queued.ctx.queue.push({ type: 'chat', text: '先回我' }); queued.start();
  assert.equal(queued.calls.length, 0, 'queued human input wins before vision starts');
  const danger = fixture(); danger.result.state.reactive.mode = 'flee'; danger.start();
  assert.equal(danger.calls.length, 0); assert.equal(danger.loop.chatHoldEpoch, undefined);
  assert.equal(danger.commentary.status.reason, 'safety-active');
  const recovery = fixture();
  recovery.loop.state.lastError = 'Model service busy';
  recovery.loop.planningController = new AbortController();
  recovery.start();
  assert.equal(recovery.calls.length, 0, 'idle planner recovery leaves the GPU available to planning');
  assert.equal(recovery.loop.chatHoldEpoch, undefined, 'recovery must not acquire a conversation hold');
  assert.equal(recovery.loop.planningController.signal.aborted, false, 'commentary must not cancel the recovering planner');
  assert.equal(recovery.commentary.status.reason, 'planning-recovery');
  recovery.loop.state.lastError = null;
  recovery.start();
  assert.equal(recovery.calls.length, 1, 'commentary resumes after planner recovery clears');
  recovery.finish(null); await settle();
  const executing = fixture();
  executing.loop.state.lastError = 'Earlier planning failure';
  executing.result.state.busy = true;
  executing.start();
  assert.equal(executing.calls.length, 1, 'an earlier error does not mute commentary during an executing game task');
  executing.finish(null); await settle();
  const cancelling = fixture();
  cancelling.result.state.busy = true;
  cancelling.loop.state.modelHealth = { generation: { current: { cancel_requested: true } } };
  cancelling.start();
  assert.equal(cancelling.calls.length, 0, 'pending model cancellation blocks vision even during game execution');
  assert.equal(cancelling.loop.chatHoldEpoch, undefined, 'pending cancellation must not acquire a conversation hold');
  assert.equal(cancelling.commentary.status.reason, 'model-cancelling');
  cancelling.loop.state.modelHealth.generation.current = null;
  cancelling.start();
  assert.equal(cancelling.calls.length, 1, 'released generation slot permits commentary again');
  cancelling.finish(null); await settle();
  const blocked = new VisualCommentary();
  assert.equal(await blocked.describe({ result: { state: { connected: true, health: 0 } } }), null);
  assert.equal(blocked.status.reason, 'not-alive');
  assert.equal(await blocked.describe({ result: { state: { connected: true, health: 1, reactive: { mode: 'fight' } } } }), null);
  assert.equal(blocked.status.reason, 'safety-active');
  const hookStart = server.indexOf('brain.onLiveHumanTurn =');
  const hook = server.slice(hookStart, server.indexOf('setInterval(async () =>', hookStart));
  const cloud = fixture(); cloud.ctx.process = { env: { MINECRAFT_CHAT_PROVIDER: 'cloud' } }; vm.runInContext(hook, cloud.ctx);
  cloud.ctx.brain.onLiveHumanTurn()();
  assert.equal(cloud.loop.chatHoldEpoch, undefined, 'cloud chat does not hold local game planning');
  const local = fixture(); local.ctx.process = { env: { MINECRAFT_CHAT_PROVIDER: 'local' } }; vm.runInContext(hook, local.ctx);
  const localRelease = local.ctx.brain.onLiveHumanTurn();
  assert.ok(local.loop.chatHoldUntil > Date.now()); localRelease();
  assert.match(server, /queueStore\.push\(item\);\s*if \(item\.type !== 'proactive'\) preemptMinecraftCommentary\(\);/);
  console.log('PASS: commentary fairness, planner recovery, cancellation drain, owned planning hold, game-task preservation, low-health speech, audience preemption, playback cadence');
})().catch(error => { console.error(error); process.exitCode = 1; });
