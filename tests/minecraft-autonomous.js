'use strict';
// End-to-end regression suite for AI_vtuber's integrated autonomous Minecraft speedrun engine:
//   1. runHelper() deadline re-arming (fixes inst3 food/climbOut 0ms spin loop)
//   2. survive() underground dry-cave skip & per-cause cooldown (paired positive/negative)
//   3. handleVictory() single-shot victory halt (fixes post-victory kill_dragon spin)
//   4. parsePlayerChat() & MC_TALK single-speaker discipline (no advancement self-replies or double-voicing)
//   5. host/bridge.js contract + liveGameContext() + factualSpeech() truthful narration
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-autonomous-test-'));
process.env.MC_RUNS_DIR = path.join(tmp, 'runs');
process.env.MC_LOG_DIR = path.join(tmp, 'logs');
process.env.MC_SERVER_DIR = path.join(tmp, 'server');
process.env.MC_HOST_BRIDGE = '1';
process.env.MC_BRIDGE_PORT = '0';
process.env.MC_HOST_CONTROL_FILE = path.join(tmp, 'minecraft-control.json');
process.env.MC_SYNC_HOST_GOAL = '0';
process.env.MC_TALK = 'host';
process.env.MC_ASSIST = '0';
process.env.MC_USERNAME = 'TestBot';

const Vec3 = require('vec3');
const reg = require('../src/minecraft/autonomous/skills/registry');
require('../src/minecraft/autonomous/skills/primitives');
require('../src/minecraft/autonomous/skills/progression');
require('../src/minecraft/autonomous/skills/base');
require('../src/minecraft/autonomous/skills/endgame');
const planner = require('../src/minecraft/autonomous/agent/planner');
const bridge = require('../src/minecraft/autonomous/host/bridge');
const gridcraft = require('../src/minecraft/autonomous/gridcraft');
const { liveGameContext } = require('../src/minecraft/live-context');
const { factualSpeech } = require('../src/minecraft/fact-speech');

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  bot.username = 'TestBot';
  bot.health = 20;
  bot.food = 20;
  bot.saturation = 5;
  bot.oxygenLevel = 20;
  bot.game = { dimension: 'overworld', gameMode: 'survival' };
  bot.time = { timeOfDay: 1000, day: 1000 };
  bot.entity = { position: new Vec3(-98, 60, 8) };
  bot.entities = {};
  bot.inventory = {
    slots: new Array(46).fill(null),
    items: () => [],
  };
  bot.pathfinder = { isMoving: () => false, stop: () => {} };
  bot.chatLog = [];
  bot.chat = (msg) => { bot.chatLog.push(msg); };
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
  bot.findBlock = () => null;
  bot.recipesFor = () => [];
  return Object.assign(bot, overrides);
}

(async () => {
  // 1. Ladder + skill registry sanity
  assert.equal(planner.LADDER.length, 23, 'expected 23 ladder milestones');
  assert.ok(reg.names().length >= 50, 'expected >= 50 skills registered');

  // 2. runHelper re-arms an expired _stepDeadline (=1) and preserves tighter live outer deadlines
  {
    const bot = makeBot();
    planner.expireStepDeadline(bot);
    assert.equal(bot._stepDeadline, 1);
    let insideDeadline = 0;
    await planner.runHelper(bot, 30000, 'climb-test', async () => {
      insideDeadline = bot._stepDeadline;
      return { ok: true };
    });
    assert.ok(insideDeadline > Date.now() + 15000, 'runHelper must re-arm expired deadline so climbOut does not exit in 0ms');
    assert.equal(bot._stepDeadline, 1, 'runHelper must expire deadline on exit when no outer deadline existed');

    const outer = Date.now() + 8000;
    bot._stepDeadline = outer;
    let nestedDeadline = 0;
    await planner.runHelper(bot, 60000, 'nested-test', async () => {
      nestedDeadline = bot._stepDeadline;
      return { ok: true };
    });
    assert.equal(nestedDeadline, outer, 'runHelper must not lengthen a tighter live outer deadline');
    assert.equal(bot._stepDeadline, outer, 'runHelper must restore live outer deadline');
  }

  // 3. survive() dry-cave anti-spin & per-cause cooldown (paired negative + positive zombie case)
  {
    const origEat = reg.get('eat').run;
    const origHunt = reg.get('hunt').run;
    const huntCalls = [];
    reg.get('eat').run = async () => ({ ok: false, observation: 'nothing edible in inventory' });
    reg.get('hunt').run = async (b, a) => { huntCalls.push(a); return { ok: false, observation: 'none' }; };
    try {
      const bot = makeBot({ health: 4.8, food: 16, entity: { position: new Vec3(-98, 60, 8) } });
      const state = { done: { food: true } };
      // A tiny scratch (hp=18.7, food=16) must NOT trigger survive gate or re-open food mid-expedition
      const botHealthy = makeBot({ health: 18.7, food: 16, entity: { position: new Vec3(-26, -14, -268) } });
      const stateKeep = { done: { food: true } };
      assert.equal(await planner.survive(botHealthy, stateKeep), false);
      assert.equal(stateKeep.done.food, true, 'survive must NOT re-open food on a tiny 1-HP scratch at food=16');
      const r1 = await planner.survive(bot, state);
      assert.equal(r1, false, 'survive must yield to ladder when food cannot be raised');
      assert.equal(state.done.food, undefined, 'survive must re-open food milestone');
      assert.equal(huntCalls.length, 0, 'underground dry cave without zombies must NOT call futile passive hunt');
      assert.equal(bot._surviveFail.cause, 'no_food_underground');

      // Second call at same spot hits cooldown cleanly
      const r2 = await planner.survive(bot, state);
      assert.equal(r2, false);
      assert.equal(huntCalls.length, 0);

      // Paired positive: when a zombie IS loaded within 24 blocks underground (fresh spot), hunt kind=zombie IS called
      const botZ = makeBot({
        health: 4.8, food: 16,
        entity: { position: new Vec3(-98, 55, 8) },
        entities: { 1: { name: 'zombie', position: new Vec3(-90, 55, 8) } },
      });
      await planner.survive(botZ, { done: {} });
      assert.equal(huntCalls.length, 1);
      assert.equal(huntCalls[0].kind, 'zombie');
    } finally {
      reg.get('eat').run = origEat;
      reg.get('hunt').run = origHunt;
    }
  }

  // 4. Post-victory halt: fires once, writes victory.json, never repeats
  {
    const bot = makeBot({ _deaths: 4 });
    const state = { done: Object.fromEntries(planner.LADDER.map(m => [m.id, true])) };
    const first = await planner.handleVictory(bot, state);
    assert.equal(first, true);
    assert.equal(bot._loopPhase, 'victory-idle');
    assert.ok(fs.existsSync(path.join(process.env.MC_RUNS_DIR, 'victory.json')));
    const second = await planner.handleVictory(bot, state);
    assert.equal(second, false, 'second victory tick must be a silent no-op');
  }

  // 5. parsePlayerChat() ignores Paper server broadcasts; MC_TALK=host prevents bot.chat()
  {
    assert.equal(planner.parsePlayerChat('SuiGeBot has made the advancement [Stone Age]'), null);
    assert.equal(planner.parsePlayerChat('SuiGeBot joined the game'), null);
    assert.equal(planner.parsePlayerChat('Gamerule keepInventory is now set to: true'), null);
    assert.deepEqual(planner.parsePlayerChat('<musekc> 先去挖点铁'), { speaker: 'musekc', body: '先去挖点铁' });

    const bot = makeBot();
    process.env.MC_TALK = 'host';
    assert.equal(planner.humanChatTarget(bot, '测试播报'), false);
    assert.equal(bot.chatLog.length, 0, 'MC_TALK=host must NOT emit in-game bot.chat');
    process.env.MC_TALK = 'game';
    assert.equal(planner.humanChatTarget(bot, '测试播报'), true);
    assert.equal(bot.chatLog.length, 1, 'MC_TALK=game must emit in-game bot.chat');
    process.env.MC_TALK = 'host';
  }

  // 6. Bridge HTTP contract + AI_vtuber liveGameContext() + factualSpeech() truthful narration
  {
    const bot = makeBot({
      health: 20, food: 19,
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'oak_log', count: 5 }, { name: 'apple', count: 3 }],
      },
    });
    bot._liveBuild = () => ({
      ts: Date.now(), username: 'TestBot', pos: { x: -98, y: 60, z: 8 }, dim: 'overworld',
      hp: 20, food: 19, worn: [], deaths: 1, freeSlots: 30, victory: false,
      milestones: { done: ['wood', 'crafting_table', 'wooden_pickaxe'], current: 'stone', currentCn: '石头' },
    });
    const srv = bridge.attach(bot);
    await new Promise(res => { if (srv.listening) res(); else srv.once('listening', res); });
    try {
      bot.emit('spawn');
      const port = srv.address().port;
      const auth = { authorization: `Bearer ${bridge._state.token}` };
      const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: auth }); return { status: r.status, body: await r.json() }; };
      const post = async (p, b) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

      // Unauthorized rejected
      const unauth = await fetch(`http://127.0.0.1:${port}/observe`);
      assert.equal(unauth.status, 401);

      // Command refusal table + skill 409
      assert.equal((await post('/command', { command: 'tp' })).status, 400);
      assert.equal((await post('/command', { command: 'workbench' })).status, 400);
      assert.equal((await post('/command', { command: 'quit' })).status, 400);
      assert.equal((await post('/command', { command: 'defend' })).status, 202);
      assert.equal((await post('/skill', { taskId: 't1', action: { action: 'observe' } })).status, 409);

      // Sorted inventory guarantee
      const obs0 = await get('/observe');
      assert.equal(obs0.status, 200);
      assert.deepEqual(obs0.body.inventory.map(i => i.name), ['apple', 'iron_pickaxe', 'oak_log']);
      assert.equal(obs0.body.busy, true);

      // Active stage narration
      bridge.publishEvent({ kind: 'milestone_started', milestone: 'iron_gear', milestoneCn: '铁装备', skill: 'mine', skillCn: '挖矿' });
      const obs1 = await get('/observe');
      const loopSnap = { enabled: true, running: false, goal: '测试自主通关', provider: 'deepseek', model: 'deepseek-flash' };
      const ctx1 = liveGameContext(obs1.body, loopSnap, Date.now(), Date.now());
      assert.equal(ctx1.connected, true);
      assert.equal(ctx1.stale, false);
      assert.ok(factualSpeech(ctx1).includes('铁装备'), `expected active milestone narration, got: ${factualSpeech(ctx1)}`);
      assert.ok(factualSpeech(ctx1).includes('还没有完成确认'), 'in-progress narration must not claim completion');

      // Verified milestone completion narration
      bridge.publishEvent({ kind: 'milestone_done', milestone: 'iron_gear', milestoneCn: '铁装备', skill: 'iron_gear', skillCn: '铁装备', verified: true, summary: 'iron pick ready' });
      const obs2 = await get('/observe');
      const ctx2 = liveGameContext(obs2.body, loopSnap, Date.now(), Date.now());
      assert.equal(ctx2.result.verified, true);
      assert.ok(factualSpeech(ctx2).includes('已完成并核验里程碑「铁装备」'), `got: ${factualSpeech(ctx2)}`);

      // Victory narration
      bot._dragonKilled = true;
      bridge.publishEvent({ kind: 'victory', milestone: 'kill_dragon', milestoneCn: '打龙', verified: true, summary: 'dragon killed' });
      const obs3 = await get('/observe');
      const ctx3 = liveGameContext(obs3.body, loopSnap, Date.now(), Date.now());
      assert.equal(ctx3.phase, '已通关');
      assert.ok(factualSpeech(ctx3).includes('末影龙已被核验击败'), `got: ${factualSpeech(ctx3)}`);
    } finally {
      bridge.detach();
    }
  }

  // 7. gridcraft: stone_sword recipe exists AND 3x3 tableWin.slots[10..45] update is detected immediately
  //    even while bot.inventory.items() has not synced yet (prevents 4s false-zero & double-crafting iron/diamond).
  {
    assert.ok(gridcraft.knows('stone_sword'), 'stone_sword must be in gridcraft RECIPES');
    assert.ok(gridcraft.knows('leather_boots'), 'leather_boots must be in gridcraft RECIPES');
    const slots = new Array(46).fill(null);
    slots[10] = { name: 'iron_ingot', count: 5 };
    slots[11] = { name: 'stick', count: 4 };
    const tableWin = { id: 2, type: 'minecraft:crafting', slots, selectedItem: null };
    const bot = makeBot({
      currentWindow: tableWin,
      inventory: {
        slots: new Array(46).fill(null),
        // Intentionally NEVER adds iron_pickaxe here (mirrors Paper 1.21 window-scoped set_slot)
        items: () => [{ name: 'iron_ingot', count: 5 }, { name: 'stick', count: 4 }],
      },
      clickWindow: async (slot, button, mode) => {
        if (slot === 0 && mode === 1) {
          // Simulate Paper shifting crafted iron_pickaxe into tableWin slot 12 and clearing the grid
          for (let i = 1; i <= 9; i++) tableWin.slots[i] = null;
          tableWin.slots[12] = { name: 'iron_pickaxe', count: 1 };
        } else if (button === 0 && mode === 0) {
          const prev = tableWin.selectedItem;
          tableWin.selectedItem = tableWin.slots[slot];
          tableWin.slots[slot] = prev;
        } else if (button === 1 && mode === 0 && tableWin.selectedItem) {
          tableWin.slots[slot] = { name: tableWin.selectedItem.name, count: 1 };
          tableWin.selectedItem.count -= 1;
          if (tableWin.selectedItem.count <= 0) tableWin.selectedItem = null;
        }
      },
    });
    const t0 = Date.now();
    const res = await gridcraft.craftGrid(bot, 'iron_pickaxe', 1, tableWin);
    assert.equal(res.made, 1, `expected gridcraft to detect tableWin iron_pickaxe, got: ${JSON.stringify(res)}`);
    assert.ok(Date.now() - t0 < 2500, 'should detect tableWin craft without waiting full 4s timeout');

    // Also verify fact-speech dedupes identical milestone/skill names
    const dedup = factualSpeech({
      connected: true, stale: false, phase: '执行动作',
      execution: { status: 'running', action: { action: 'explore' } },
      autonomous: { currentMilestoneCn: '木头', activeSkillCn: '木头', milestonesDone: 1, milestonesTotal: 23 },
    });
    assert.ok(!dedup.includes('正在尝试木头'), `should not repeat milestone name: ${dedup}`);
    assert.ok(dedup.includes('1/23'), `should show milestone progress: ${dedup}`);
  }

  // 8. find_diamonds iron-pick shortage math: with iron_ingot=2 + raw_iron=2 (total 4 >= 3),
  //    must NOT waste 180s calling mine(iron_ore); must go straight to smelt -> iron_pickaxe.
  {
    const origMine = reg.get('mine').run;
    const origSmelt = reg.get('smelt').run;
    let mineIronCalled = 0;
    let smeltCalled = 0;
    reg.get('mine').run = async (b, a) => {
      if (a && Array.isArray(a.names) && a.names.includes('iron_ore')) mineIronCalled++;
      return { ok: false, observation: 'stub-mine' };
    };
    reg.get('smelt').run = async () => {
      smeltCalled++;
      return { ok: false, observation: 'stub-smelt-stop' };
    };
    try {
      const bot = makeBot({
        entity: { position: new Vec3(-45, 20, -260) },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 5 },
            { name: 'iron_ingot', count: 2 },
            { name: 'raw_iron', count: 2 },
            { name: 'diamond', count: 2 },
          ],
        },
        equip: async (it) => { bot.heldItem = it; },
        findBlock: () => ({ name: 'crafting_table', position: new Vec3(-45, 20, -261) }),
        activateBlock: async () => { throw new Error('stub-table-stop'); },
      });
      await reg.get('find_diamonds').run(bot, { count: 3 });
      assert.equal(mineIronCalled, 0, 'must NOT mine iron_ore when iron_ingot(2)+raw_iron(2) >= 3');
      assert.equal(smeltCalled, 1, 'must go straight to smelt when raw_iron covers the remaining ingot deficit');
    } finally {
      reg.get('mine').run = origMine;
      reg.get('smelt').run = origSmelt;
    }
  }

  // 9. bow milestone: self-heals missing pickaxes via ensure_tools, hunts spiders at night when string<3,
  //    roams specifically for chickens (not pigs), and hunts skeletons/strays for arrows in chicken-scarce biomes
  {
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const bowMs = LADDER.find(m => m.id === 'bow');
    assert.ok(bowMs, 'bow milestone defined');
    let ensureToolsCalls = 0, spiderCalls = 0, skeletonCalls = 0, surfaceCalls = 0;
    const roamLookFors = [];
    const origET = reg.get('ensure_tools').run;
    const origHS = reg.get('hunt_spider').run;
    const origRS = reg.get('recover_surface').run;
    const origRoam = reg.get('roam').run;
    const origHunt = reg.get('hunt').run;
    const origMine = reg.get('mine').run;
    try {
      reg.get('ensure_tools').run = async () => { ensureToolsCalls++; return { ok: true, observation: 'stub-tools' }; };
      reg.get('hunt_spider').run = async (b, a) => {
        if (a && (a.kind === 'skeleton' || a.kind === 'stray')) skeletonCalls++;
        else spiderCalls++;
        return { ok: false, observation: 'stub-no-mob' };
      };
      reg.get('recover_surface').run = async (b) => { surfaceCalls++; b.entity.position = new Vec3(0, 64, 0); return { ok: true, observation: 'surfaced' }; };
      reg.get('roam').run = async (b, a) => { if (a && a.look_for) roamLookFors.push(a.look_for); return { ok: false, observation: 'stub-roam' }; };
      reg.get('hunt').run = async () => ({ ok: false, observation: 'stub-hunt' });
      reg.get('mine').run = async () => ({ ok: false, observation: 'stub-mine' });
      // Daytime (tod=1000) with no spider/skeleton nearby: surfaces, roams specifically for chickens, then falls back to skeletons
      const botDay = makeBot({
        time: { timeOfDay: 1000, age: 1000 },
        entity: { position: new Vec3(0, 40, 0), yaw: 0, pitch: 0 },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [{ name: 'flint', count: 3 }, { name: 'stick', count: 6 }],
        },
        findBlocks: () => [],
      });
      await bowMs.run(botDay);
      assert.equal(ensureToolsCalls, 1, 'bow milestone must call ensure_tools when carrying zero pickaxes');
      assert.equal(spiderCalls, 0, 'bow milestone must NOT dive into caves chasing spiders during daytime while arrows<8');
      assert.equal(surfaceCalls, 1, 'bow milestone must surface when underground at y<55');
      assert.ok(roamLookFors.includes('chicken'), `bow milestone must roam specifically for chicken, got ${JSON.stringify(roamLookFors)}`);
      assert.ok(skeletonCalls >= 1, 'bow milestone must fall back to hunting skeletons/strays when chickens are absent');

      // Nighttime (tod=16000): actively runs hunt_spider for spiders AND skeletons on the surface
      const skBeforeNight = skeletonCalls;
      const botNight = makeBot({
        time: { timeOfDay: 16000, age: 16000 },
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [{ name: 'flint', count: 3 }, { name: 'stick', count: 6 }],
        },
        findBlocks: () => [],
      });
      await bowMs.run(botNight);
      assert.equal(spiderCalls, 1, 'bow milestone must actively run hunt_spider at night when bow=0 and string<3');
      assert.ok(skeletonCalls > skBeforeNight, 'bow milestone must hunt skeletons/strays at night for arrows');
    } finally {
      reg.get('ensure_tools').run = origET;
      reg.get('hunt_spider').run = origHS;
      reg.get('recover_surface').run = origRS;
      reg.get('roam').run = origRoam;
      reg.get('hunt').run = origHunt;
      reg.get('mine').run = origMine;
    }
  }

  // 10. locate_stronghold under MC_ASSIST=0: uses packet-level eye tracking and never digs far off-column
  {
    const prevAssist = process.env.MC_ASSIST;
    const origDeepShaft = reg.get('deep_shaft').run;
    let deepShaftCalled = 0;
    try {
      process.env.MC_ASSIST = '0';
      reg.get('deep_shaft').run = async () => { deepShaftCalled++; return { ok: false, observation: 'should-not-dig-far' }; };
      const client = new EventEmitter();
      const bot = makeBot({
        _client: client,
        _stepDeadline: Date.now() + 25000,
        game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        registry: { entitiesByName: { eye_of_ender: { id: 39 } }, blocksByName: {}, itemsByName: {} },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [{ name: 'ender_eye', count: 12 }],
        },
        equip: async () => {},
        look: async () => {},
        activateItem: async () => {
          // Simulate Paper 1.21.1 spawn_entity + rel_entity_move + entity_destroy packets flying +X (east)
          setTimeout(() => {
            client.emit('spawn_entity', { entityId: 9001, type: 39, x: 0, y: 65, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0 });
            client.emit('rel_entity_move', { entityId: 9001, dX: 4096 * 12, dY: 4096 * 4, dZ: 0 });
            client.emit('entity_destroy', { entityIds: [9001] });
          }, 50);
        },
        pathfinder: { goto: async () => {} },
        findBlock: () => null,
        blockAt: () => ({ name: 'air' }),
      });
      // Pre-set an estimated stronghold 500 blocks east to verify MC_ASSIST=0 refuses to dig off-column
      bot._strongholdEst = { x: 500, z: 0, at: Date.now() };
      const rFar = await reg.get('locate_stronghold').run(bot, {});
      assert.equal(rFar.ok, false);
      assert.equal(deepShaftCalled, 0, 'MC_ASSIST=0 must NEVER dig a shaft while 500 blocks away from estimated stronghold');
      assert.match(rFar.observation, /marching toward estimated stronghold/i);
      // Now clear _strongholdEst and verify packet-level eye tracking captures the east bearing
      delete bot._strongholdEst;
      bot._stepDeadline = Date.now() + 22000;
      const rEye = await reg.get('locate_stronghold').run(bot, { throws: 2 });
      assert.match(rEye.observation, /(followed 1 eye bearing|stronghold is still ahead along) \(1\.00,0\.00\)/i, 'must capture eye bearing from raw spawn_entity + rel_entity_move packets');
    } finally {
      if (prevAssist === undefined) delete process.env.MC_ASSIST; else process.env.MC_ASSIST = prevAssist;
      reg.get('deep_shaft').run = origDeepShaft;
    }
  }

  // 11. pov/server.js handles stage_lock entries without history array; roam filters out far-vertical cave mobs; chop_trees surfaces first when y<52
  {
    const povSrv = require('../src/minecraft/autonomous/pov/server');
    fs.mkdirSync(process.env.MC_RUNS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MC_RUNS_DIR, 'live.json'), JSON.stringify({ ts: Date.now(), username: 'TestBot', milestones: { current: 'bow' }, inv: '{}' }));
    fs.writeFileSync(path.join(process.env.MC_RUNS_DIR, 'stage_lock.json'), JSON.stringify({ stages: { bow: { lastObs: 'no history yet' } } }));
    const snap = povSrv.fromFiles();
    assert.equal(snap.ok, true, 'pov fromFiles must not throw when stage_lock stage has no history array');
    assert.equal(snap.elapsedSec, 0);

    // chop_trees at y=29 must call recover_surface BEFORE trying to path to an overhead surface tree at y=70
    const origRS = reg.get('recover_surface').run;
    let rsCalled = 0;
    try {
      reg.get('recover_surface').run = async (b) => { rsCalled++; b.entity.position = new Vec3(0, 64, 0); return { ok: true, observation: 'surfaced' }; };
      const bot = makeBot({
        entity: { position: new Vec3(0, 29, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'oak_log', count: 12 }] },
        findBlock: () => ({ name: 'spruce_log', position: new Vec3(0, 70, 0) }),
        blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
      });
      await reg.get('chop_trees').run(bot, { count: 12 });
      assert.equal(rsCalled, 1, 'chop_trees must surface before searching for trees when underground at y=29');
    } finally {
      reg.get('recover_surface').run = origRS;
    }

    // roam must ignore spiders 35 blocks vertically below the bot (runs actual roam skill with 1 leg)
    let approachCalled = 0;
    const botRoam = makeBot({
      _stepDeadline: Date.now() + 2000,
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      entities: { 99: { id: 99, name: 'spider', position: new Vec3(4, 25, 4) } },
      nearestEntity(pred) { return Object.values(this.entities).find(pred) || null; },
      pathfinder: {
        goto: async (goal) => {
          if (goal && goal.y === 25) approachCalled++;
          botRoam._stepDeadline = Date.now() - 1; // stop after 1 leg
        },
        stop: () => {},
      },
      blockAt: () => ({ name: 'grass_block', boundingBox: 'block' }),
    });
    await reg.get('roam').run(botRoam, { look_for: 'spider', distance: 60, maxDy: 10 });
    assert.equal(approachCalled, 0, 'roam must NEVER path toward a cave spider 39 blocks below surface');
  }

  // 12. Conservative pathfinder tool selection & liquid/canDig policy (reserve diamond_pickaxe for obsidian, no bare-hand digging, real liquidCost)
  {
    const { selectConservativeTool, syncPathfinderPolicy } = require('../src/minecraft/autonomous/bot');
    const pack = [
      { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 20 },
      { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 10 },
      { name: 'stone_shovel', count: 1, maxDurability: 131, durabilityUsed: 10 },
      { name: 'iron_sword', count: 1, maxDurability: 250, durabilityUsed: 5 },
    ];
    const botA = makeBot({ inventory: { slots: new Array(46).fill(null), items: () => pack } });
    assert.equal(selectConservativeTool(botA, { name: 'obsidian', hardness: 50 }).name, 'diamond_pickaxe', 'obsidian uses diamond_pickaxe');
    assert.equal(selectConservativeTool(botA, { name: 'stone', hardness: 1.5 }).name, 'iron_pickaxe', 'ordinary stone prefers iron_pickaxe over diamond_pickaxe');
    assert.equal(selectConservativeTool(botA, { name: 'dirt', hardness: 0.5 }).name, 'stone_shovel', 'dirt switches to shovel');
    assert.equal(selectConservativeTool(botA, { name: 'cobweb', hardness: 4 }).name, 'iron_sword', 'cobweb switches to sword');

    // Only diamond_pickaxe left: must NOT hand it over for cobblestone, and pathfinder canDig must turn OFF
    const botDiamondOnly = makeBot({ inventory: { slots: new Array(46).fill(null), items: () => [pack[0]] } });
    assert.equal(selectConservativeTool(botDiamondOnly, { name: 'cobblestone', hardness: 2 }), null, 'diamond_pickaxe stays reserved when digging cobblestone');
    const mov = { liquidCost: 1, canDig: true, digCost: 0.4 };
    syncPathfinderPolicy(botDiamondOnly, mov, { wet: false, dryNear: true });
    assert.equal(mov.liquidCost, 35, 'dry land sets high real mov.liquidCost to avoid water');
    assert.equal(mov.canDig, false, 'pathfinder must NOT dig rock without a non-diamond bulk pickaxe');

    // With iron_pickaxe: dry allows digging (digCost=4), wet disables digging and raises liquidCost=85 near shore
    syncPathfinderPolicy(botA, mov, { wet: false, dryNear: true });
    assert.equal(mov.canDig, true);
    assert.equal(mov.digCost, 4);
    syncPathfinderPolicy(botA, mov, { wet: true, dryNear: true });
    assert.equal(mov.canDig, false, 'submerged bot must NOT dig underwater');
    assert.equal(mov.liquidCost, 85, 'submerged near dry land raises mov.liquidCost=85 to exit water');
  }

  // 13. dry_escape under MC_ASSIST=0: walks/swims onto nearby dry standable ledge instead of looping placeBlock/climbOut
  {
    let placeBlockCalls = 0, gotoDryCalls = 0;
    const botWet = makeBot({
      entity: { position: new Vec3(0, 16, 0), yaw: 0, pitch: 0 },
      _wet: true,
      inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'cobblestone', count: 32 }] },
      placeBlock: async () => { placeBlockCalls++; throw new Error('the block is still water'); },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'empty' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (y <= 15) return { name: 'stone', boundingBox: 'block' };
        if (x === 0 && z === 0 && y === 16) return { name: 'water', boundingBox: 'empty' };
        if (x === 2 && z === 0 && (y === 16 || y === 17)) return { name: 'air', boundingBox: 'empty' };
        return { name: 'water', boundingBox: 'empty' };
      },
      pathfinder: {
        goto: async (goal) => {
          gotoDryCalls++;
          if (goal && goal.x === 2 && goal.z === 0) botWet.entity.position = new Vec3(2, 16, 0);
        },
      },
    });
    const r = await reg.get('dry_escape').run(botWet, { max: 4 });
    assert.equal(r.ok, true, 'dry_escape must escape onto adjacent dry cell without OP /tp');
    assert.equal(gotoDryCalls, 1, 'dry_escape must walk to nearby dry standable cell first');
    assert.equal(placeBlockCalls, 0, 'dry_escape must NOT spam refused placeBlock into own feet when a dry ledge is right next to it');
  }

  // 14. installSafeDig: 0ms overhead when block breaks immediately, waits for delayed blockUpdate, retries once on early-stop snapback
  {
    const { installSafeDig } = require('../src/minecraft/autonomous/bot');
    // Case A: delayed blockUpdate (70ms after origDig resolves) -> waits cleanly without retrying
    let digCallsA = 0;
    let blkA = { name: 'stone', type: 1, position: new Vec3(1, 64, 1) };
    const botA = makeBot({
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: () => blkA,
      dig: async () => {
        digCallsA++;
        setTimeout(() => {
          blkA = { name: 'air', type: 0, position: new Vec3(1, 64, 1) };
          botA.emit('blockUpdate:(1, 64, 1)');
        }, 70);
      },
    });
    installSafeDig(botA);
    const t0 = Date.now();
    await botA.dig(blkA);
    const dtA = Date.now() - t0;
    assert.equal(digCallsA, 1, 'must NOT retry when server confirms break via delayed blockUpdate');
    assert.ok(dtA >= 50 && dtA < 260, `must return immediately on blockUpdate instead of blind 500ms sleep (took ${dtA}ms)`);

    // Case B: Paper rejects early stop (block stays solid past 320ms) -> retries once and confirms break
    let digCallsB = 0;
    let blkB = { name: 'stone', type: 1, position: new Vec3(1, 64, 1) };
    const botB = makeBot({
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: () => blkB,
      dig: async () => {
        digCallsB++;
        if (digCallsB === 2) {
          blkB = { name: 'air', type: 0, position: new Vec3(1, 64, 1) };
        }
      },
    });
    installSafeDig(botB);
    await botB.dig(blkB);
    assert.equal(digCallsB, 2, 'must retry once when block snaps back solid after local dig timer');
  }

  // 15. Prevent in-place jumping loops: allow1by1towers disabled in pathfinder, and jump bounce does not fool path stall guard
  {
    const { syncPathfinderPolicy, hasPathMoved } = require('../src/minecraft/autonomous/bot');
    const mov = { liquidCost: 1, canDig: true, digCost: 0.4, allow1by1towers: true };
    const bot = makeBot({ inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 10 }] } });
    syncPathfinderPolicy(bot, mov, { wet: false, dryNear: true });
    assert.equal(mov.allow1by1towers, false, 'pathfinder 1x1 tower-jumping must stay disabled on Paper 1.21.1');
    const anchor = { x: -48, y: 69.0, z: -256 };
    assert.equal(hasPathMoved(anchor, { x: -48.1, y: 70.25, z: -255.9 }), false, 'in-place vertical jump bounce (+1.25y) must NOT reset path stall guard');
    assert.equal(hasPathMoved(anchor, { x: -47.0, y: 69.0, z: -256.0 }), true, 'real horizontal step (>=0.9m) counts as progress');
    assert.equal(hasPathMoved(anchor, { x: -48.0, y: 71.1, z: -256.0 }), true, 'sustained vertical climb (>=2m) counts as progress');
  }

  // 16. gridcraft fishing_rod & bread recipes + food milestone sweet_berry_bush harvesting in taiga
  {
    assert.ok(gridcraft.RECIPES.fishing_rod, 'gridcraft must define fishing_rod recipe');
    assert.ok(gridcraft.RECIPES.bread, 'gridcraft must define bread recipe');
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const foodMs = LADDER.find(m => m.id === 'food');
    let berryPicked = 0, huntCalled = 0;
    const origHunt = reg.get('hunt').run;
    const origEat = reg.get('eat').run;
    try {
      reg.get('hunt').run = async () => { huntCalled++; return { ok: false, observation: 'no animals' }; };
      reg.get('eat').run = async () => ({ ok: true, observation: 'ate' });
      const items = [];
      const botBerry = makeBot({
        food: 16,
        saturation: 4,
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        blockAt: (p) => {
          if (p && p.x === 2 && p.y === 64 && p.z === 0) return { name: 'sweet_berry_bush', position: new Vec3(2, 64, 0) };
          return { name: 'air', boundingBox: 'empty' };
        },
        findBlocks: () => [new Vec3(2, 64, 0)],
        pathfinder: { goto: async () => {} },
        activateBlock: async () => {
          berryPicked++;
          items.push({ name: 'sweet_berries', count: 6 });
        },
      });
      const r = await foodMs.run(botBerry);
      assert.equal(berryPicked, 1, 'food milestone must harvest nearby sweet_berry_bush');
      assert.equal(huntCalled, 0, 'once sweet berries satisfy rations, no need to wander empty tundra hunting');
      assert.equal(r.ok, true);
    } finally {
      reg.get('hunt').run = origHunt;
      reg.get('eat').run = origEat;
    }
  }

  // 17. hunt_spider(kind=skeleton) hunts strays/skeletons for arrows + stepLease revokes immediately on timeout
  {
    const lease = require('../src/minecraft/autonomous/stepLease');
    let orphanStaleAfterTimeout = false;
    let orphanPromise;
    await lease.run(() => new Promise(resolve => {
      orphanPromise = (async () => {
        await new Promise(r => setTimeout(r, 45));
        orphanStaleAfterTimeout = lease.stale();
      })();
      setTimeout(() => resolve({ ok: false, observation: 'timeout' }), 15);
    }));
    // Immediately after lease.run settles (BEFORE any next lease.run starts), orphan must already be stale
    await orphanPromise;
    assert.equal(orphanStaleAfterTimeout, true, 'timed-out worker must become lease.stale() immediately when lease.run settles');

    // Verify hunt_spider kind=skeleton targets stray (snowy taiga archer) and collects arrows
    const attacked = [];
    const items = [];
    const stray = { id: 91, name: 'stray', position: new Vec3(4, 64, 0), isValid: true };
    const spider = { id: 92, name: 'spider', position: new Vec3(2, 64, 0), isValid: true };
    const botArch = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      entities: { 91: stray, 92: spider },
      nearestEntity: (pred) => [spider, stray].find(e => e.isValid && pred(e)) || null,
      inventory: { slots: new Array(46).fill(null), items: () => items },
      pathfinder: { goto: async () => {} },
      pvp: {
        attack: async (e) => {
          attacked.push(e.name);
          e.isValid = false;
          items.push({ name: 'arrow', count: 8 });
        },
      },
    });
    const rArch = await reg.get('hunt_spider').run(botArch, { kind: 'skeleton', count: 8, maxDistance: 40 });
    assert.deepEqual(attacked, ['stray'], 'hunt_spider(kind=skeleton) must target strays/skeletons and ignore spiders');
    assert.equal(rArch.ok, true, 'hunt_spider(kind=skeleton) must succeed once arrows reach target');
  }

  // 18. MC_ASSIST=0 endgame survival: legit blaze sword melee when out of arrows, pearl enderman equip+pickup,
  //     and uncaged End crystal bow shooting without OP liftOntoPillar
  {
    const prevAssist = process.env.MC_ASSIST;
    try {
      process.env.MC_ASSIST = '0';
      // 18a: farm_blaze legit sword melee when arrows=0 and hp>=12 (no /effect command issued)
      const chats = [];
      let blazeSwings = 0;
      const blazeItems = [{ name: 'iron_sword', count: 1 }];
      const blaze = { id: 301, name: 'blaze', position: new Vec3(2, 64, 0) };
      const botBlaze = makeBot({
        health: 18,
        game: { dimension: 'the_nether' },
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        entities: { 301: blaze },
        nearestEntity: (pred) => (botBlaze.entities[301] && pred(blaze) ? blaze : null),
        inventory: { slots: new Array(46).fill(null), items: () => blazeItems },
        chat: (m) => chats.push(m),
        equip: async () => {},
        lookAt: async () => {},
        attack: async () => {
          blazeSwings++;
          delete botBlaze.entities[301];
          blazeItems.push({ name: 'blaze_rod', count: 1 });
        },
      });
      const rb = await reg.get('farm_blaze').run(botBlaze, { count: 1 });
      assert.equal(rb.ok, true, 'farm_blaze must allow legit sword melee when arrows=0 and hp>=12 under MC_ASSIST=0');
      assert.ok(blazeSwings >= 1, 'farm_blaze must actually swing sword at close blaze');
      assert.equal(chats.some(c => c.startsWith('/effect')), false, 'farm_blaze under MC_ASSIST=0 must NEVER send /effect');

      // 18b: farm_pearl equips sword and collects ender_pearl
      let equippedSword = false;
      const pearlItems = [{ name: 'iron_sword', count: 1 }];
      const em = { id: 302, name: 'enderman', position: new Vec3(4, 64, 0) };
      const botPearl = makeBot({
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        entities: { 302: em },
        nearestEntity: (pred) => (botPearl.entities[302] && pred(em) ? em : null),
        inventory: { slots: new Array(46).fill(null), items: () => pearlItems },
        equip: async (it) => { if (it && it.name === 'iron_sword') equippedSword = true; },
        pathfinder: { goto: async () => {} },
        pvp: {
          attack: async () => {
            delete botPearl.entities[302];
            pearlItems.push({ name: 'ender_pearl', count: 2 });
          },
        },
      });
      const rp = await reg.get('farm_pearl').run(botPearl, { count: 2 });
      assert.equal(equippedSword, true, 'farm_pearl must equip sword before fighting enderman');
      assert.equal(rp.ok, true, 'farm_pearl must succeed when target ender_pearl count is reached');

      // 18c: kill_dragon shoots uncaged End crystal with bow under MC_ASSIST=0 (no OP /tp lift)
      const endChats = [];
      let bowFired = 0;
      const crystal = { id: 401, name: 'end_crystal', position: new Vec3(20, 82, 0) };
      const botEnd = makeBot({
        health: 20,
        _stepDeadline: Date.now() + 15000,
        game: { dimension: 'the_end' },
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        entities: { 401: crystal },
        nearestEntity: (pred) => Object.values(botEnd.entities).find(e => e && pred(e)) || null,
        blockAt: (p) => {
          if (p && Math.floor(p.y) <= 63) return { name: 'end_stone', boundingBox: 'block' };
          return { name: 'air', boundingBox: 'none' };
        },
        findBlock: () => null,
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 16 }, { name: 'iron_sword', count: 1 }],
        },
        chat: (m) => endChats.push(m),
        equip: async () => {},
        lookAt: async () => {},
        activateItem: async () => {},
        deactivateItem: async () => {
          bowFired++;
          delete botEnd.entities[401];
          // End the loop cleanly on next check after crystal is verified destroyed
          botEnd._stepDeadline = 1;
        },
      });
      await reg.get('kill_dragon').run(botEnd, {});
      assert.equal(bowFired, 1, 'kill_dragon under MC_ASSIST=0 must shoot uncaged crystal with bow');
      assert.equal(botEnd._crystalsDown, 1, 'kill_dragon must record crystal destroyed by bow');
      assert.equal(endChats.some(c => c.startsWith('/tp') || c.startsWith('/setblock') || c.startsWith('/give')), false, 'kill_dragon under MC_ASSIST=0 must NEVER send OP commands');
    } finally {
      if (prevAssist === undefined) delete process.env.MC_ASSIST;
      else process.env.MC_ASSIST = prevAssist;
    }
  }

  // 19. food milestone in barren frozen_ocean/snowy biome: falls back to zombie/drowned rotten_flesh + reports spruce_log fuel accurately
  {
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const foodMs = LADDER.find(m => m.id === 'food');
    let zombieHuntCalls = 0;
    const origHunt = reg.get('hunt').run;
    const origKelp = reg.get('harvest_kelp').run;
    const origRoam = reg.get('roam').run;
    const origHS = reg.get('hunt_spider').run;
    const origEat = reg.get('eat').run;
    try {
      const items = [{ name: 'spruce_log', count: 6 }];
      reg.get('hunt').run = async () => ({ ok: false, observation: 'no livestock' });
      reg.get('harvest_kelp').run = async () => ({ ok: false, observation: 'no kelp' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'frozen ocean' });
      reg.get('hunt_spider').run = async (b, a) => {
        if (a && a.kind === 'zombie') {
          zombieHuntCalls++;
          items.push({ name: 'rotten_flesh', count: 4 });
          return { ok: true, observation: 'killed 2 drowned' };
        }
        return { ok: false, observation: 'unexpected kind' };
      };
      reg.get('eat').run = async () => ({ ok: true, observation: 'ate' });
      const botFrozen = makeBot({
        food: 8,
        saturation: 0,
        time: { timeOfDay: 15000, age: 15000 },
        entity: { position: new Vec3(0, 63, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        findBlocks: () => [],
      });
      const r = await foodMs.run(botFrozen);
      assert.equal(zombieHuntCalls, 1, 'food milestone must fall back to undead ration hunt in barren snowy/frozen biomes');
      assert.equal(r.ok, true, 'food milestone must pass once undead hunt supplies rotten_flesh rations');
      assert.ok(r.observation.includes('logs=6'), `food milestone must count spruce_log in fuel report, got: ${r.observation}`);
    } finally {
      reg.get('hunt').run = origHunt;
      reg.get('harvest_kelp').run = origKelp;
      reg.get('roam').run = origRoam;
      reg.get('hunt_spider').run = origHS;
      reg.get('eat').run = origEat;
    }

    // Also verify hunt preserves scarce arrows (<12) and does not waste them shooting distant rabbits
    let bowActivated = 0;
    const farRabbit = { id: 701, name: 'rabbit', position: new Vec3(24, 63, 0), health: 3 };
    const botArrowGuard = makeBot({
      entity: { position: new Vec3(0, 63, 0), yaw: 0, pitch: 0 },
      entities: { 701: farRabbit },
      nearestEntity: (pred) => (pred(farRabbit) ? farRabbit : null),
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 6 }, { name: 'iron_sword', count: 1 }],
      },
      blockAt: () => ({ name: 'air', boundingBox: 'none' }),
      setControlState: () => {},
      lookAt: async () => {},
      activateItem: async () => { bowActivated++; },
      pathfinder: { isMoving: () => false, stop: () => {}, goto: async () => { throw new Error('no path'); } },
    });
    let gotoCount = 0;
    botArrowGuard.pathfinder.goto = async () => {
      gotoCount++;
      if (gotoCount === 1) throw new Error('no path');
      botArrowGuard.entity.position = new Vec3(22, 63, 0);
    };
    botArrowGuard.pvp = { attack: async () => { delete botArrowGuard.entities[701]; } };
    botArrowGuard.nearestEntity = (pred) => (botArrowGuard.entities[701] && pred(farRabbit) ? farRabbit : null);
    await reg.get('hunt').run(botArrowGuard, { count: 1 });
    assert.equal(bowActivated, 0, 'hunt must NOT waste scarce arrows (<12) shooting at a rabbit 24m away');
  }

  // 20. tidy keeps rotten_flesh emergency rations (up to 8)
  {
    const P = require('../src/minecraft/autonomous/skills/primitives');
    const tossed = [];
    const botTidy = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [
          { name: 'rotten_flesh', count: 4, slot: 10 },
          { name: 'cobblestone', count: 10, slot: 11 },
        ],
      },
      toss: async (id, meta, cnt) => tossed.push({ id, cnt }),
      tossStack: async (it) => tossed.push({ name: it.name, cnt: it.count }),
    });
    await P.dropJunk(botTidy, 4);
    assert.equal(tossed.length, 0, 'tidy must NOT throw away emergency rotten_flesh rations (cap=8)');

    // Also verify smelt aborts immediately if bot respawned >36m away from old furnace instead of trekking back into a cave
    let smeltWalks = 0;
    const botSmeltFar = makeBot({
      entity: { position: new Vec3(-44, 69, -246), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'raw_iron', count: 3 }] },
      findBlock: () => ({ name: 'furnace', position: new Vec3(-45, 65, -245) }),
      pathfinder: {
        goto: async () => {
          smeltWalks++;
          // Simulate dying on try 1 and respawning 110 blocks above on the surface
          botSmeltFar.entity.position = new Vec3(-44, 180, -246);
          throw new Error('died');
        },
      },
    });
    const sr = await reg.get('smelt').run(botSmeltFar, { item: 'raw_iron', count: 3 });
    assert.equal(smeltWalks, 1, 'smelt must stop retrying walk to distant furnace after respawn/relocation >36m away');
    assert.equal(sr.ok, false);
  }

  // 21. mineBlockHere tunneling to a lava target NEVER calls bot.dig(lava) or equips diamond_pickaxe on rock
  {
    const { mineBlockHere } = require('../src/minecraft/autonomous/skills/endgame');
    const dug = [];
    const equipped = [];
    const lavaBlk = { name: 'lava', position: new Vec3(6, -26, 0) };
    const botLava = makeBot({
      entity: { position: new Vec3(0, -26, 0), yaw: 0, pitch: 0 },
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [
          { name: 'iron_pickaxe', count: 1, slot: 36, maxDurability: 250, durabilityUsed: 10 },
          { name: 'diamond_pickaxe', count: 1, slot: 37, maxDurability: 1561, durabilityUsed: 0 },
        ],
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        if (Math.floor(p.x) === 6 && Math.floor(p.y) === -26 && Math.floor(p.z) === 0) return lavaBlk;
        if (Math.floor(p.x) >= 1 && Math.floor(p.x) <= 2 && Math.floor(p.y) >= -26 && Math.floor(p.y) <= -25) {
          return { name: 'deepslate', position: new Vec3(Math.floor(p.x), Math.floor(p.y), 0), boundingBox: 'block' };
        }
        return { name: 'air', boundingBox: 'none' };
      },
      setQuickBarSlot: () => { botLava.heldItem = { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 10 }; },
      equip: async (it) => { equipped.push(it.name); botLava.heldItem = it; },
      dig: async (blk) => { dug.push(blk.name); },
      pathfinder: {
        goto: async (goal) => {
          if (goal && Math.round(goal.x) === 6) throw new Error('No path');
          if (goal) botLava.entity.position = new Vec3(goal.x, goal.y, goal.z);
        },
      },
    });
    const ok = await mineBlockHere(botLava, lavaBlk);
    assert.equal(ok, true, 'mineBlockHere must tunnel within reach of lava target and return true');
    assert.equal(dug.includes('lava'), false, 'mineBlockHere must NEVER call bot.dig() on lava');
    assert.equal(equipped.includes('diamond_pickaxe'), false, 'mineBlockHere must NOT equip diamond_pickaxe to tunnel rock toward lava');
    assert.ok(botLava.entity.position.distanceTo(lavaBlk.position) >= 2.5, 'mineBlockHere must stop at safe edge before stepping into lava');
  }

  // 22. make_obsidian skips flowing lava (level>0) instead of wasting water_bucket making cobblestone
  {
    const origDeepShaft = reg.get('deep_shaft').run;
    const origRoam = reg.get('roam').run;
    const origWalkTo = reg.get('walk_to').run;
    let activateCalls = 0;
    try {
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async () => ({ ok: false, observation: 'stub-walk' });
      const flowingLava = { name: 'lava', position: new Vec3(2, -30, 0), getProperties: () => ({ level: 4 }) };
      const botFlow = makeBot({
        entity: { position: new Vec3(0, -30, 0), yaw: 0, pitch: 0 },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 0 },
            { name: 'water_bucket', count: 1 },
          ],
        },
        equip: async (it) => { botFlow.heldItem = it; },
        findBlocks: ({ matching }) => (matching && matching.length ? [flowingLava.position] : []),
        blockAt: (p) => (p && Math.floor(p.x) === 2 && Math.floor(p.y) === -30 && Math.floor(p.z) === 0 ? flowingLava : { name: 'air', boundingBox: 'none' }),
        activateItem: async () => { activateCalls++; },
      });
      const r = await reg.get('make_obsidian').run(botFlow, { count: 10 });
      assert.equal(activateCalls, 0, 'make_obsidian must NOT waste water_bucket pouring on flowing lava (level=4)');
      assert.equal(r.ok, false);
    } finally {
      reg.get('deep_shaft').run = origDeepShaft;
      reg.get('roam').run = origRoam;
      reg.get('walk_to').run = origWalkTo;
    }
  }

  // 23. make_obsidian breaks covering ice over y=61 water so bucket fills reliably in frozen biomes
  {
    const origDeepShaft = reg.get('deep_shaft').run;
    const origRoam = reg.get('roam').run;
    const origWalkTo = reg.get('walk_to').run;
    let iceDug = 0;
    const items = [
      { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 0 },
      { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 0 },
      { name: 'bucket', count: 1 },
    ];
    let iceThawed = false;
    try {
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async () => ({ ok: false, observation: 'stub-walk' });
      const P2 = require('../src/minecraft/autonomous/skills/primitives');
      const botIce = makeBot({
        entity: { position: new Vec3(0, 63, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        equip: async (it) => { botIce.heldItem = it; },
        lookAt: async () => {},
        findBlock: ({ matching }) => {
          const waterId = P2.blockIds(botIce, ['water'])[0];
          if (matching === waterId || (Array.isArray(matching) && matching.includes(waterId))) {
            return { name: 'water', position: new Vec3(2, 61, 0), getProperties: () => ({ level: 0 }) };
          }
          return null;
        },
        findBlocks: ({ matching }) => {
          const waterId = P2.blockIds(botIce, ['water'])[0];
          if (matching === waterId || (Array.isArray(matching) && matching.includes(waterId))) {
            return [new Vec3(2, 61, 0)];
          }
          return [];
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x === 2 && z === 0 && y === 61) return { name: 'water', position: new Vec3(2, 61, 0), getProperties: () => ({ level: 0 }) };
          if (x === 2 && z === 0 && y === 62) {
            return iceThawed
              ? { name: 'water', position: new Vec3(2, 62, 0), getProperties: () => ({ level: 0 }) }
              : { name: 'ice', position: new Vec3(2, 62, 0), boundingBox: 'block' };
          }
          return { name: 'air', boundingBox: 'none' };
        },
        dig: async (blk) => {
          if (blk && blk.name === 'ice') { iceDug++; iceThawed = true; }
        },
        activateItem: async () => {
          if (iceThawed && botIce.heldItem && botIce.heldItem.name === 'bucket') {
            items.splice(items.findIndex(i => i.name === 'bucket'), 1, { name: 'water_bucket', count: 1 });
          }
        },
      });
      await reg.get('make_obsidian').run(botIce, { count: 10 });
      assert.equal(iceDug, 1, 'make_obsidian must dig covering ice block above water source in frozen biomes');
      assert.equal(items.some(i => i.name === 'water_bucket'), true, 'bucket must fill after breaking covering ice');
    } finally {
      reg.get('deep_shaft').run = origDeepShaft;
      reg.get('roam').run = origRoam;
      reg.get('walk_to').run = origWalkTo;
    }
  }

  // 24. make_obsidian aims at solid rim face beside source lava, detects nearby obsidian, and scoops water back
  {
    const P3 = require('../src/minecraft/autonomous/skills/primitives');
    const lavaId = P3.blockIds(makeBot(), ['lava'])[0];
    const waterId = P3.blockIds(makeBot(), ['water'])[0];
    const obsId = P3.blockIds(makeBot(), ['obsidian'])[0];
    const items = [
      { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 0 },
      { name: 'water_bucket', count: 1 },
    ];
    let waterPlaced = false, scoopedBack = false, aimedRim = false;
    const botRim = makeBot({
      entity: { position: new Vec3(0, -53, 0), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => items },
      equip: async (it) => { botRim.heldItem = it; },
      pathfinder: { goto: async () => {} },
      lookAt: async (pt) => { if (pt && Math.floor(pt.x) === 1 && pt.y > -53.5) aimedRim = true; },
      findBlocks: ({ matching }) => {
        const m = Array.isArray(matching) ? matching : [matching];
        if (m.includes(lavaId)) return [new Vec3(2, -54, 0)];
        if (m.includes(waterId)) return waterPlaced ? [new Vec3(1, -53, 0)] : [];
        if (m.includes(obsId)) return waterPlaced ? [new Vec3(3, -54, 0)] : [];
        return [];
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (x === 2 && y === -54 && z === 0) return { name: 'lava', position: new Vec3(2, -54, 0), getProperties: () => ({ level: 0 }) };
        if (x === 1 && y === -54 && z === 0) return { name: 'deepslate', position: new Vec3(1, -54, 0), boundingBox: 'block' };
        if (x === 1 && y === -53 && z === 0) return waterPlaced ? { name: 'water', position: new Vec3(1, -53, 0), getProperties: () => ({ level: 0 }) } : { name: 'air', boundingBox: 'none' };
        if (x === 3 && y === -54 && z === 0) return waterPlaced ? { name: 'obsidian', position: new Vec3(3, -54, 0), boundingBox: 'block' } : { name: 'air', boundingBox: 'none' };
        return { name: 'air', boundingBox: 'none' };
      },
      activateItem: async () => {
        if (botRim.heldItem && botRim.heldItem.name === 'water_bucket') {
          waterPlaced = true;
          items.splice(items.findIndex(i => i.name === 'water_bucket'), 1, { name: 'bucket', count: 1 });
        } else if (botRim.heldItem && botRim.heldItem.name === 'bucket' && waterPlaced) {
          scoopedBack = true;
          waterPlaced = false;
          items.splice(items.findIndex(i => i.name === 'bucket'), 1, { name: 'water_bucket', count: 1 });
          botRim._stepDeadline = 1; // exit pour loop cleanly after verifying 1 full cycle
        }
      },
      dig: async () => {},
    });
    await reg.get('make_obsidian').run(botRim, { count: 1 });
    assert.equal(aimedRim, true, 'make_obsidian must aim at solid rim block beside lava so water lands cleanly');
    assert.equal(scoopedBack, true, 'make_obsidian must scoop water back into bucket after pouring');
  }

  // 25. equipBestToolFor bootstraps sticks + stone_pickaxe from planks/cobble when only diamond_pickaxe is in pack
  {
    const P4 = require('../src/minecraft/autonomous/skills/primitives');
    const items = [
      { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
      { name: 'spruce_planks', count: 8, slot: 10 },
      { name: 'cobblestone', count: 12, slot: 11 },
      { name: 'crafting_table', count: 1, slot: 12 },
    ];
    const crafted = [];
    const botPick = makeBot({
      entity: { position: new Vec3(0, 30, 0), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => items },
      heldItem: { name: 'water_bucket', count: 1 },
      equip: async (it) => { botPick.heldItem = it; },
      findBlock: ({ matching }) => {
        const tblId = P4.blockIds(botPick, ['crafting_table'])[0];
        if (matching === tblId || (Array.isArray(matching) && matching.includes(tblId))) {
          return { name: 'crafting_table', position: new Vec3(1, 30, 0), boundingBox: 'block' };
        }
        return null;
      },
      recipesFor: (id) => [{ id, requiresTable: id === P4.itemId(botPick, 'stone_pickaxe') }],
      craft: async (rec) => {
        const nm = (P4.data(botPick).items[rec.id] || {}).name;
        crafted.push(nm);
        if (nm === 'stick') items.push({ name: 'stick', count: 4, slot: 13 });
        if (nm === 'stone_pickaxe') items.push({ name: 'stone_pickaxe', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 0 });
      },
    });
    const stoneId = P4.blockIds(botPick, ['stone'])[0];
    await P4.equipBestToolFor(botPick, { type: stoneId, name: 'stone', hardness: 1.5, position: new Vec3(1, 30, 0) });
    assert.ok(crafted.includes('stick'), 'equipBestToolFor must bootstrap sticks from planks when stick=0');
    assert.ok(crafted.includes('stone_pickaxe'), 'equipBestToolFor must craft stone_pickaxe instead of burning diamond_pickaxe or hand-digging stone');
    assert.equal(botPick.heldItem && botPick.heldItem.name, 'stone_pickaxe', 'must equip the newly minted stone_pickaxe');
  }

  // 26. make_obsidian tunnels past the 5.4-block wall gap into <=4.5 pour reach instead of stopping at <=6
  {
    const P5 = require('../src/minecraft/autonomous/skills/primitives');
    const lavaId = P5.blockIds(makeBot(), ['lava'])[0];
    const items = [
      { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
      { name: 'stone_pickaxe', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 0 },
      { name: 'water_bucket', count: 1, slot: 38 },
    ];
    let pouredAtReach = false;
    let stoneWallIntact = true;
    const botGap = makeBot({
      entity: { position: new Vec3(0, 30, 0), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => items },
      equip: async (it) => { botGap.heldItem = it; },
      lookAt: async () => {},
      pathfinder: {
        stop: () => {},
        goto: async (goal) => {
          if (stoneWallIntact && Math.abs((goal.x || 0) - 5) <= 2) throw new Error('No path to the goal!');
          if (!stoneWallIntact && goal) botGap.entity.position = new Vec3(Math.min(3, goal.x), 30, 0);
        },
      },
      findBlocks: ({ matching }) => {
        const m = Array.isArray(matching) ? matching : [matching];
        if (m.includes(lavaId)) return [new Vec3(5.4, 30, 0)];
        return [];
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (x === 5 && y === 30 && z === 0) return { name: 'lava', position: new Vec3(5.4, 30, 0), getProperties: () => ({ level: 0 }) };
        if (stoneWallIntact && x >= 1 && x <= 3 && (y === 30 || y === 31) && z === 0) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
        return { name: 'air', boundingBox: 'none' };
      },
      dig: async (blk) => {
        if (blk && blk.name === 'stone') {
          stoneWallIntact = false;
          botGap.entity.position = new Vec3(3, 30, 0);
        }
      },
      activateItem: async () => {
        if (botGap.heldItem && botGap.heldItem.name === 'water_bucket' && botGap.entity.position.distanceTo(new Vec3(5.4, 30, 0)) <= 4.5) {
          pouredAtReach = true;
          botGap._stepDeadline = 1;
        }
      },
    });
    await reg.get('make_obsidian').run(botGap, { count: 1 });
    assert.equal(pouredAtReach, true, 'make_obsidian must tunnel past the 5.4-block gap and pour once inside <=4.5 reach');
  }

  // 27. flint_steel milestone mines + smelts 1 iron ingot when iron_ingot=0 before crafting flint_and_steel
  {
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const fsMs = LADDER.find(m => m.id === 'flint_steel');
    const origMine = reg.get('mine').run;
    const origSmelt = reg.get('smelt').run;
    const P6 = require('../src/minecraft/autonomous/skills/primitives');
    let minedIron = 0, smeltedIron = 0, craftedFS = 0;
    try {
      const items = [
        { name: 'flint', count: 3, slot: 10 },
        { name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 0 },
      ];
      reg.get('mine').run = async (b, a) => {
        if (a && Array.isArray(a.block) && a.block.includes('iron_ore')) {
          minedIron++;
          items.push({ name: 'raw_iron', count: 2, slot: 11 });
          return { ok: true, observation: 'mined 2 raw_iron' };
        }
        return { ok: false, observation: 'unexpected mine' };
      };
      reg.get('smelt').run = async (b, a) => {
        if (a && a.item === 'raw_iron') {
          smeltedIron++;
          items.push({ name: 'iron_ingot', count: 1, slot: 12 });
          return { ok: true, observation: 'smelted 1 iron_ingot' };
        }
        return { ok: false, observation: 'unexpected smelt' };
      };
      const fsId = P6.itemId(makeBot(), 'flint_and_steel');
      const botFS = makeBot({
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        recipesFor: (id) => (id === fsId ? [{ id: fsId, requiresTable: false }] : []),
        craft: async (rec) => {
          if (rec && rec.id === fsId) {
            craftedFS++;
            items.push({ name: 'flint_and_steel', count: 1, slot: 13 });
          }
        },
      });
      const res = await fsMs.run(botFS);
      assert.equal(minedIron, 1, 'flint_steel must mine iron ore when iron_ingot=0 and raw_iron=0');
      assert.equal(smeltedIron, 1, 'flint_steel must smelt raw_iron when iron_ingot=0');
      assert.equal(craftedFS, 1, 'flint_steel must craft flint_and_steel after obtaining iron_ingot');
      assert.equal(res.ok, true);
    } finally {
      reg.get('mine').run = origMine;
      reg.get('smelt').run = origSmelt;
    }
  }

  // 28. make_obsidian digs solid roof above a lava pocket before pouring AND forgets unpourable 0-obsidian lava pockets
  {
    const P7 = require('../src/minecraft/autonomous/skills/primitives');
    const lavaId = P7.blockIds(makeBot(), ['lava'])[0];
    const items = [
      { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
      { name: 'stone_pickaxe', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 0 },
      { name: 'water_bucket', count: 1, slot: 38 },
    ];
    let roofDug = false;
    const botRoof = makeBot({
      entity: { position: new Vec3(0, 30, 0), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => items },
      equip: async (it) => { botRoof.heldItem = it; },
      lookAt: async () => {},
      pathfinder: { stop: () => {}, goto: async () => {} },
      findBlocks: ({ matching }) => {
        const m = Array.isArray(matching) ? matching : [matching];
        if (m.includes(lavaId)) return [new Vec3(2, 30, 0)];
        return [];
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (x === 2 && y === 30 && z === 0) return { name: 'lava', position: new Vec3(2, 30, 0), getProperties: () => ({ level: 0 }) };
        if (x === 2 && y === 31 && z === 0) {
          return roofDug
            ? { name: 'air', position: new Vec3(2, 31, 0), boundingBox: 'none' }
            : { name: 'stone', position: new Vec3(2, 31, 0), boundingBox: 'block' };
        }
        return { name: 'air', boundingBox: 'none' };
      },
      dig: async (blk) => {
        if (blk && blk.name === 'stone' && blk.position.x === 2 && blk.position.y === 31) roofDug = true;
      },
      activateItem: async () => {
        if (botRoof.heldItem && botRoof.heldItem.name === 'water_bucket') {
          // Simulate water emptied with 0 obsidian created -> must blacklist/forget lava cell
          items.splice(items.findIndex(i => i.name === 'water_bucket'), 1, { name: 'bucket', count: 1 });
        }
      },
    });
    await reg.get('make_obsidian').run(botRoof, { count: 1 });
    assert.equal(roofDug, true, 'make_obsidian must dig solid roof directly above lava source before pouring');
    assert.equal(botRoof._badLavaKeys && botRoof._badLavaKeys.has('2,30,0'), true, 'make_obsidian must blacklist lava cell that emptied water_bucket with 0 obsidian');
  }

  // 29. make_obsidian walks to water in the 12..40m band to fill bucket (no 12..40m dead zone) & tidy protects <=8 logs
  {
    const P8 = require('../src/minecraft/autonomous/skills/primitives');
    const waterId = P8.blockIds(makeBot(), ['water'])[0];
    const origDS = reg.get('deep_shaft').run;
    const origRoam = reg.get('roam').run;
    const origWalk = reg.get('walk_to').run;
    try {
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async () => ({ ok: false, observation: 'stub-stop' });
      const items = [
        { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
        { name: 'bucket', count: 1, slot: 37 },
      ];
      let walkedToWater = false;
      const waterPos = new Vec3(18, 61, 0); // 18 blocks away (inside 12..40m band!)
      const botBand = makeBot({
        entity: { position: new Vec3(0, 63, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        equip: async (it) => { botBand.heldItem = it; },
        lookAt: async () => {},
        pathfinder: {
          stop: () => {},
          goto: async (goal) => {
            if (goal && Math.abs(goal.x - 18) <= 2) {
              walkedToWater = true;
              botBand.entity.position = new Vec3(17, 62, 0);
            }
          },
        },
        findBlock: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          return m.includes(waterId) ? { name: 'water', position: waterPos, getProperties: () => ({ level: 0 }) } : null;
        },
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          return m.includes(waterId) ? [waterPos] : [];
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          if (Math.floor(p.x) === 18 && Math.floor(p.y) === 61 && Math.floor(p.z) === 0) {
            return { name: 'water', position: waterPos, getProperties: () => ({ level: 0 }) };
          }
          return { name: 'air', boundingBox: 'none' };
        },
        activateItem: async () => {
          if (botBand.heldItem && botBand.heldItem.name === 'bucket' && botBand.entity.position.distanceTo(waterPos) <= 4.5) {
            items.splice(items.findIndex(i => i.name === 'bucket'), 1, { name: 'water_bucket', count: 1, slot: 37 });
          }
        },
      });
      await reg.get('make_obsidian').run(botBand, { count: 1 });
      assert.equal(walkedToWater, true, 'make_obsidian must walk to water found 18 blocks away instead of dropping it with <=12 filter');
      assert.equal(items.some(i => i.name === 'water_bucket'), true, 'bucket must be filled after walking to 18m surface water');
    } finally {
      reg.get('deep_shaft').run = origDS;
      reg.get('roam').run = origRoam;
      reg.get('walk_to').run = origWalk;
    }

    // Also verify tidy (dropJunk) protects <=8 spruce_log and drops flower junk instead
    const tossed = [];
    const invLogs = [
      { name: 'crafting_table', count: 1, slot: 9 },
      { name: 'spruce_planks', count: 8, slot: 10 },
      { name: 'spruce_log', count: 5, slot: 11 },
      { name: 'dandelion', count: 1, slot: 12 },
    ];
    // Pad to 33 stacks so freeSlots = 3 < minFree=6
    for (let s = 13; s < 42; s++) invLogs.push({ name: 'diamond', count: 1, slot: s });
    const botWood = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => invLogs },
      tossStack: async (it) => {
        tossed.push(it.name);
        const idx = invLogs.indexOf(it);
        if (idx >= 0) invLogs.splice(idx, 1);
      },
      toss: async () => {},
    });
    await P8.dropJunk(botWood, false, 6);
    assert.ok(!tossed.includes('spruce_log'), 'tidy must NEVER toss <=8 backup logs in Pass 2');
    assert.ok(tossed.includes('dandelion'), 'tidy should drop flower junk instead of backup logs');
  }

  // 30. make_obsidian climbs to surface from y=30 when only flowing (level>0) cave water exists at depth
  {
    const P9 = require('../src/minecraft/autonomous/skills/primitives');
    const waterId = P9.blockIds(makeBot(), ['water'])[0];
    const origRec = reg.get('recover_surface').run;
    const origDS = reg.get('deep_shaft').run;
    const origRoam = reg.get('roam').run;
    const origWalk = reg.get('walk_to').run;
    let climbedToSurface = false;
    try {
      const items = [
        { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
        { name: 'bucket', count: 1, slot: 37 },
      ];
      reg.get('recover_surface').run = async (b) => {
        climbedToSurface = true;
        b.entity.position = new Vec3(0, 63, 0);
        return { ok: true, observation: 'surfaced' };
      };
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async () => ({ ok: false, observation: 'stub-stop' });
      const botFlow = makeBot({
        entity: { position: new Vec3(0, 30, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        equip: async (it) => { botFlow.heldItem = it; },
        lookAt: async () => {},
        pathfinder: { stop: () => {}, goto: async () => {} },
        findBlock: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          if (!m.includes(waterId)) return null;
          return botFlow.entity.position.y < 50
            ? { name: 'water', position: new Vec3(2, 30, 0), getProperties: () => ({ level: 1 }) }
            : { name: 'water', position: new Vec3(2, 62, 0), getProperties: () => ({ level: 0 }) };
        },
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          if (!m.includes(waterId)) return [];
          return botFlow.entity.position.y < 50
            ? [new Vec3(1, 30, 0), new Vec3(2, 30, 0), new Vec3(3, 30, 0), new Vec3(4, 30, 0)]
            : [new Vec3(2, 62, 0)];
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const y = Math.floor(p.y);
          if (y === 30) return { name: 'water', position: p.floored(), getProperties: () => ({ level: 1 }) };
          if (y === 62 && Math.floor(p.x) === 2) return { name: 'water', position: new Vec3(2, 62, 0), getProperties: () => ({ level: 0 }) };
          return { name: 'air', boundingBox: 'none' };
        },
        activateItem: async () => {
          if (botFlow.heldItem && botFlow.heldItem.name === 'bucket' && botFlow.entity.position.y >= 60) {
            items.splice(items.findIndex(i => i.name === 'bucket'), 1, { name: 'water_bucket', count: 1, slot: 37 });
          }
        },
      });
      await reg.get('make_obsidian').run(botFlow, { count: 1 });
      assert.equal(climbedToSurface, true, 'make_obsidian must climb to surface from y=30 when only flowing water exists nearby');
      assert.equal(items.some(i => i.name === 'water_bucket'), true, 'bucket must fill from surface level-0 source after climbing out');
    } finally {
      reg.get('recover_surface').run = origRec;
      reg.get('deep_shaft').run = origDS;
      reg.get('roam').run = origRoam;
      reg.get('walk_to').run = origWalk;
    }
  }

  // 31. oreCache.forget removes ALL co-located entries (lava+obsidian), and roam refuses underground livestock spin
  {
    const oc = require('../src/minecraft/autonomous/oreCache');
    oc.remember('lava', 123, 30, -456);
    oc.remember('obsidian', 123, 30, -456);
    oc.forget(123, 30, -456);
    const left = oc.list(['lava', 'obsidian'], new Vec3(123, 30, -456))
      .filter(e => Math.abs(e.x - 123) <= 1 && Math.abs(e.y - 30) <= 1 && Math.abs(e.z + 456) <= 1);
    assert.equal(left.length, 0, 'oreCache.forget must remove BOTH lava and obsidian entries at the forgotten coordinates');

    const origRec2 = reg.get('recover_surface').run;
    let recCalled = 0;
    try {
      reg.get('recover_surface').run = async () => { recCalled++; return { ok: false, observation: 'still-cave' }; };
      const botCave = makeBot({
        entity: { position: new Vec3(0, 18, 0), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
      });
      const r = await reg.get('roam').run(botCave, { look_for: 'cow,pig,sheep,chicken', distance: 140 });
      assert.equal(recCalled, 1, 'roam for surface livestock underground must attempt recover_surface first');
      assert.equal(r.ok, false, 'roam for surface livestock must fail fast when still underground instead of spinning 300s');
      assert.ok(/underground|caves/i.test(r.observation));
    } finally {
      reg.get('recover_surface').run = origRec2;
    }
  }

  // 32. bridge_to never passes (0,0,0) direction vector & aborts cleanly on refusal/respawn; make_obsidian skips ocean-capped lava
  {
    const baseFaces = [];
    const botBr = makeBot({
      entity: { position: new Vec3(-40, 70, -253), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'cobblestone', count: 32, slot: 36 }] },
      equip: async (it) => { botBr.heldItem = it; },
      setControlState: () => {},
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        // Only the diagonal block under feet (-40, 69, -253) is solid; target (-41, 70, -253) has air under/around it
        if (x === -40 && y === 69 && z === -253) return { name: 'dirt', position: new Vec3(-40, 69, -253), boundingBox: 'block' };
        return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
      },
      placeBlock: async (ref, face) => {
        baseFaces.push(face);
        throw new Error('should not be called with (0,0,0)');
      },
    });
    const brRes = await reg.get('bridge_to').run(botBr, { x: -75, z: -265, max: 10 });
    assert.equal(baseFaces.length, 0, 'bridge_to must NEVER call placeBlock with a diagonal (0,0,0) direction vector');
    assert.equal(brRes.ok, false, 'bridge_to must fail fast when no orthogonal solid reference exists');

    // Also verify make_obsidian forgets ocean-capped lava in oreCache instead of walking into the ocean
    const oc2 = require('../src/minecraft/autonomous/oreCache');
    oc2.remember('lava', 10, -26, 10);
    const origDS2 = reg.get('deep_shaft').run;
    const origRoam2 = reg.get('roam').run;
    const origWalk2 = reg.get('walk_to').run;
    let walkedToOceanLava = false;
    try {
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async (b, a) => {
        if (a && a.x === 10 && a.z === 10) walkedToOceanLava = true;
        return { ok: false, observation: 'stub-stop' };
      };
      const botOc = makeBot({
        entity: { position: new Vec3(0, 70, 0), yaw: 0, pitch: 0 },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
            { name: 'water_bucket', count: 1, slot: 37 },
          ],
        },
        findBlocks: () => [],
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          if (Math.floor(p.x) === 10 && Math.floor(p.z) === 10 && (Math.floor(p.y) === 62 || Math.floor(p.y) === 61)) {
            return { name: 'ice', position: p.floored(), boundingBox: 'block' };
          }
          return { name: 'air', boundingBox: 'none' };
        },
      });
      await reg.get('make_obsidian').run(botOc, { count: 1 });
      assert.equal(walkedToOceanLava, false, 'make_obsidian must forget ocean-capped lava (ice/water at y=61..62) instead of walking into the ocean');
    } finally {
      reg.get('deep_shaft').run = origDS2;
      reg.get('roam').run = origRoam2;
      reg.get('walk_to').run = origWalk2;
    }
  }

  // 33. recover_surface (climbOut) carves & steps onto SOLID adjacent stair block (not air pit) when jump-pillar fails
  {
    const prevAssist = process.env.MC_ASSIST;
    process.env.MC_ASSIST = '0';
    let climbedToY = -15;
    let steppedOntoSolid = false;
    try {
      const botClimb = makeBot({
        entity: { position: new Vec3(0, -15, 0), yaw: 0, pitch: 0, onGround: true },
        game: { dimension: 'overworld' },
        physicsEnabled: true,
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'cobblestone', count: 32, slot: 36 },
            { name: 'stone_pickaxe', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 0 },
          ],
        },
        equip: async (it) => { botClimb.heldItem = it; },
        setControlState: () => {},
        placeBlock: async () => { throw new Error('the block is still air'); },
        dig: async () => {},
        pathfinder: {
          isMoving: () => false,
          stop: () => {},
          goto: async (goal) => {
            if (goal && goal.x === 1 && goal.y === -14 && goal.z === 0) {
              steppedOntoSolid = true;
              climbedToY = 64;
              botClimb.entity.position = new Vec3(1, 64, 0);
            }
          },
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (y === -16) return { name: 'deepslate', position: new Vec3(x, y, z), boundingBox: 'block' };
          // x=1,y=-15,z=0 is SOLID rock (valid staircase step), whereas x=-1/z=+-1 are air pits
          if (x === 1 && y === -15 && z === 0) return { name: 'stone', position: new Vec3(1, -15, 0), boundingBox: 'block' };
          if (x === 1 && (y === -14 || y === -13) && z === 0) return { name: 'stone', position: new Vec3(1, y, 0), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('recover_surface').run(botClimb, {});
      assert.equal(steppedOntoSolid, true, 'climbOut stair fallback must step onto SOLID (1,-15,0) step, NOT air pits');
      assert.ok(climbedToY >= 63);
    } finally {
      if (prevAssist === undefined) delete process.env.MC_ASSIST;
      else process.env.MC_ASSIST = prevAssist;
    }
  }

  // 34. make_obsidian relocates to an inland dry hilltop (4+m clear of ocean water) before descending
  {
    const origDS3 = reg.get('deep_shaft').run;
    const origRoam3 = reg.get('roam').run;
    const origWalk3 = reg.get('walk_to').run;
    let movedInland = false;
    let blind90Probe = 0;
    try {
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async (b, a) => {
        if (a && Math.hypot(a.x - b.entity.position.x, a.z - b.entity.position.z) >= 80) blind90Probe++;
        return { ok: false, observation: 'stub-stop' };
      };
      const botHill = makeBot({
        entity: { position: new Vec3(500, 63, 500), yaw: 0, pitch: 0 },
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
            { name: 'water_bucket', count: 1, slot: 37 },
          ],
        },
        findBlocks: () => [],
        pathfinder: {
          stop: () => {},
          goto: async (goal) => {
            if (goal && Math.abs(goal.x - 516) <= 8 && goal.y >= 67) {
              movedInland = true;
              botHill.entity.position = new Vec3(516, 68, 500);
            }
          },
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          // Ocean for x < 508 at y=61..62; inland solid dry hill around x >= 510 with top at y=67
          if (x < 508 && (y === 61 || y === 62)) return { name: 'water', position: new Vec3(x, y, z), boundingBox: 'empty' };
          if (x >= 510 && x <= 524 && z >= 490 && z <= 510 && y <= 67) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('make_obsidian').run(botHill, { count: 1 });
      assert.equal(movedInland, true, 'relocateToHighGround must walk to loaded inland dry hilltop before descending');
      assert.equal(blind90Probe, 0, 'relocateToHighGround must NOT run blind 90-block probes when an inland hill is loaded');
    } finally {
      reg.get('deep_shaft').run = origDS3;
      reg.get('roam').run = origRoam3;
      reg.get('walk_to').run = origWalk3;
    }
  }

  // 35. make_obsidian skips 1-block cave springs during upper descent to reach y=-52 lava lakes,
  //     and clears blocking wall blocks in cursor LOS before pouring water_bucket
  {
    const P10 = require('../src/minecraft/autonomous/skills/primitives');
    const lavaId = P10.blockIds(makeBot(), ['lava'])[0];
    const origDS4 = reg.get('deep_shaft').run;
    const origRoam4 = reg.get('roam').run;
    const origWalk4 = reg.get('walk_to').run;
    const stagesVisited = [];
    let blockingWallDug = false;
    try {
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('deep_shaft').run = async (b, a) => {
        stagesVisited.push(a.toY);
        b.entity.position = new Vec3(600, a.toY, 600);
        return { ok: true, observation: `y=${a.toY}` };
      };
      const items = [
        { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
        { name: 'stone_pickaxe', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 0 },
        { name: 'water_bucket', count: 1, slot: 38 },
      ];
      const botLake = makeBot({
        entity: { position: new Vec3(600, 70, 600), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        equip: async (it) => { botLake.heldItem = it; },
        lookAt: async () => {},
        pathfinder: { stop: () => {}, goto: async () => {} },
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          if (!m.includes(lavaId)) return [];
          const y = botLake.entity.position.y;
          // At y=0..12 only a 1-block spring exists (must NOT stop early!)
          if (y <= 12 && y > -45) return [new Vec3(603, -20, 600)];
          // At y=-52 a real lava lake exists
          if (y <= -45) return [new Vec3(602, -52, 600), new Vec3(603, -52, 600), new Vec3(604, -52, 600)];
          return [];
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x === 603 && y === -20 && z === 600) return { name: 'lava', position: new Vec3(603, -20, 600), getProperties: () => ({ level: 0 }) };
          if (x >= 602 && x <= 604 && y === -52 && z === 600) return { name: 'lava', position: new Vec3(x, -52, 600), getProperties: () => ({ level: 0 }) };
          if (x === 601 && y === -52 && z === 600) return { name: 'deepslate', position: new Vec3(601, -52, 600), boundingBox: 'block' };
          return { name: 'air', boundingBox: 'none' };
        },
        blockAtCursor: () => (blockingWallDug
          ? { name: 'deepslate', position: new Vec3(601, -52, 600), boundingBox: 'block' }
          : { name: 'stone', position: new Vec3(598, -51, 600), boundingBox: 'block' }),
        dig: async (blk) => {
          if (blk && blk.name === 'stone' && blk.position.x === 598) blockingWallDug = true;
        },
        activateItem: async () => { botLake._stepDeadline = 1; },
      });
      await reg.get('make_obsidian').run(botLake, { count: 1 });
      assert.ok(stagesVisited.includes(-52), `make_obsidian must skip 1-block spring at y=-20 and continue to y=-52 lava lake (visited=${stagesVisited.join(',')})`);
      assert.equal(blockingWallDug, true, 'make_obsidian must clear blocking stone wall in cursor LOS before pouring water_bucket');
    } finally {
      reg.get('deep_shaft').run = origDS4;
      reg.get('roam').run = origRoam4;
      reg.get('walk_to').run = origWalk4;
    }
  }

  // 36. chop_trees skips unreachable cliff trees (badTrees), climbs out of y<=62 pit, and ensures stale lease exits fast
  {
    const P11 = require('../src/minecraft/autonomous/skills/primitives');
    const lease2 = require('../src/minecraft/autonomous/stepLease');
    const spruceId = P11.blockIds(makeBot(), ['spruce_log'])[0];
    const origRec3 = reg.get('recover_surface').run;
    let climbedPit = false;
    const gotoTargets = [];
    const items = [];
    try {
      reg.get('recover_surface').run = async (b) => {
        climbedPit = true;
        b.entity.position = new Vec3(0, 64, 0);
        return { ok: true, observation: 'climbed pit' };
      };
      const cliffPos = new Vec3(20, 72, 0);
      const nearPos = new Vec3(3, 64, 0);
      const botTree = makeBot({
        entity: { position: new Vec3(0, 61, 0), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: new Array(46).fill(null), items: () => items },
        pathfinder: {
          stop: () => {},
          goto: async (goal) => {
            gotoTargets.push(`${goal.x},${goal.y},${goal.z}`);
            if (goal.x === 20) throw new Error('No path to the goal!');
            botTree.entity.position = new Vec3(3, 64, 0);
          },
        },
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          if (m.includes(spruceId)) return [cliffPos, nearPos];
          return [];
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x === 20 && y === 72 && z === 0) return { name: 'spruce_log', position: cliffPos, boundingBox: 'block', type: spruceId };
          if (x === 3 && y === 64 && z === 0) return { name: 'spruce_log', position: nearPos, boundingBox: 'block', type: spruceId };
          return { name: 'air', boundingBox: 'none' };
        },
        dig: async (blk) => {
          if (blk && blk.position.x === 3) {
            items.push({ name: 'spruce_log', count: 4, slot: 10 });
          }
        },
      });
      // First make nearPos unreachable while cliffPos fails -> nearPos should be tried first (closer y),
      // wait: reverse so cliffPos is tried first when at y=61 by making nearPos higher, OR put cliffPos closer!
      botTree.findBlocks = ({ matching }) => {
        const m = Array.isArray(matching) ? matching : [matching];
        if (!m.includes(spruceId)) return [];
        return climbedPit ? [cliffPos, nearPos] : [cliffPos];
      };
      await reg.get('chop_trees').run(botTree, { count: 4 });
      assert.equal(climbedPit, true, 'chop_trees must climb out of y<=62 pit when tree goto fails');
      assert.ok(gotoTargets.includes('3,64,0'), `chop_trees must skip failed cliff tree and move to reachable tree (tried=${gotoTargets.join(' | ')})`);
      assert.equal(P11.countItem(botTree, 'spruce_log') >= 4, true, 'chop_trees must collect logs from the reachable tree');

      // Also verify ensure_tools exits immediately when stepLease is stale
      let staleToolsRes = null;
      await lease2.run(async () => {
        lease2.revoke();
        staleToolsRes = await reg.get('ensure_tools').run(makeBot({ game: { dimension: 'overworld' } }), {});
      });
      assert.equal(staleToolsRes && staleToolsRes.ok, false, 'ensure_tools must exit immediately when stepLease is stale');
      assert.ok(/lease revoked/i.test(staleToolsRes.observation));
    } finally {
      reg.get('recover_surface').run = origRec3;
    }
  }

  // 37. make_obsidian & relocateToHighGround skip FLOODED dryLand/hills, skip 220m ruined-portal roam when bucket+pick ready,
  //     and abort cleanly when food<10 instead of digging into sea level
  {
    const origDS5 = reg.get('deep_shaft').run;
    const origRoam5 = reg.get('roam').run;
    const origWalk5 = reg.get('walk_to').run;
    let ruinedPortalRoams = 0;
    let walkedToFlooded = false;
    let walkedToSafeHill = false;
    let hungryShaftCalls = 0;
    let hungryProbes = 0;
    try {
      reg.get('deep_shaft').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('roam').run = async (b, a) => {
        if (a && a.block === 'obsidian') ruinedPortalRoams++;
        return { ok: false, observation: 'stub-stop' };
      };
      reg.get('walk_to').run = async (b, a) => {
        if (a && Math.abs(a.x - 800) <= 6 && Math.abs(a.z - 800) <= 6) walkedToFlooded = true;
        if (b && typeof b.food === 'number' && b.food < 10) hungryProbes++;
        return { ok: false, observation: 'EMERGENCY (food 6)' };
      };
      // Part A: bot starts on a flooded column (800, 68, 800) with _dryLand also pinned to that flooded column,
      // another closer flooded hill at (808, 72, 800), and a genuinely unflooded dry hilltop at (824, 70, 800).
      const botFl = makeBot({
        entity: { position: new Vec3(800, 68, 800), yaw: 0, pitch: 0 },
        food: 20,
        _dryLand: new Vec3(800, 68, 800),
        _floods: [{ x: 800, z: 800, y: 40 }, { x: 808, z: 800, y: 40 }],
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
            { name: 'water_bucket', count: 1, slot: 37 },
          ],
        },
        findBlocks: () => [],
        pathfinder: {
          stop: () => {},
          goto: async (goal) => {
            if (goal && Math.abs(goal.x - 808) <= 4) walkedToFlooded = true;
            if (goal && goal.x >= 818 && goal.x <= 832 && goal.y >= 69) {
              walkedToSafeHill = true;
              botFl.entity.position = new Vec3(goal.x, goal.y, goal.z);
            }
          },
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x >= 804 && x <= 812 && z >= 796 && z <= 804 && y <= 71) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          if (x >= 818 && x <= 832 && z >= 792 && z <= 808 && y <= 69) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          if (y <= 67) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('make_obsidian').run(botFl, { count: 1 });
      assert.equal(ruinedPortalRoams, 0, 'make_obsidian must skip 220m ruined-portal roam when water_bucket + diamond_pickaxe are ready');
      assert.equal(walkedToFlooded, false, 'relocateToHighGround must discard flooded _dryLand and skip flooded hills');
      assert.equal(walkedToSafeHill, true, 'relocateToHighGround must walk to the unflooded dry hilltop instead');

      // Part B: hungry bot (food=6) at sea level y=63 must abort immediately without probes or digging into ocean
      reg.get('deep_shaft').run = async () => { hungryShaftCalls++; return { ok: false, observation: 'stub-stop' }; };
      const botHungry = makeBot({
        entity: { position: new Vec3(900, 63, 900), yaw: 0, pitch: 0 },
        food: 6,
        _floods: [],
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [
            { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
            { name: 'water_bucket', count: 1, slot: 37 },
          ],
        },
        findBlocks: () => [],
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const y = Math.floor(p.y);
          if (y === 61 || y === 62) return { name: 'water', position: p, boundingBox: 'empty' };
          return { name: 'air', position: p, boundingBox: 'none' };
        },
      });
      const rHungry = await reg.get('make_obsidian').run(botHungry, { count: 1 });
      assert.equal(rHungry.ok, false, 'hungry make_obsidian must return ok=false');
      assert.ok(/FOOD LOW/i.test(rHungry.observation), `hungry make_obsidian must report FOOD LOW (got ${rHungry.observation})`);
      assert.equal(hungryProbes, 0, 'hungry make_obsidian must not run overland walk_to probes');
      assert.equal(hungryShaftCalls, 0, 'hungry make_obsidian must not call deep_shaft at sea level');

      // Part C: fish walks to open water shoreline up to 36 blocks away instead of failing at maxDistance=3
      const P12 = require('../src/minecraft/autonomous/skills/primitives');
      const waterId2 = P12.blockIds(makeBot(), ['water'])[0];
      let walkedShore = false;
      let fishedCast = false;
      const fishItems = [{ name: 'fishing_rod', count: 1, slot: 36 }];
      const botFish = makeBot({
        entity: { position: new Vec3(0, 65, 0), yaw: 0, pitch: 0 },
        health: 18,
        inventory: { slots: new Array(46).fill(null), items: () => fishItems },
        equip: async (it) => { botFish.heldItem = it; },
        lookAt: async () => {},
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          return m.includes(waterId2) ? [new Vec3(10, 62, 0)] : [];
        },
        pathfinder: {
          stop: () => {},
          goto: async (goal) => {
            if (goal && Math.abs(goal.x - 9) <= 2 && Math.abs(goal.y - 63) <= 2) {
              walkedShore = true;
              botFish.entity.position = new Vec3(9, 63, 0);
            }
          },
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x === 10 && y === 62 && z === 0) return { name: 'water', position: new Vec3(10, 62, 0), boundingBox: 'empty' };
          if (x === 9 && y === 62 && z === 0) return { name: 'grass_block', position: new Vec3(9, 62, 0), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
        fish: async () => {
          fishedCast = true;
          fishItems.push({ name: 'cod', count: 2, slot: 37 });
        },
      });
      const rFish = await reg.get('fish').run(botFish, { count: 2, timeoutSec: 25 });
      assert.equal(walkedShore, true, 'fish must walk to nearby open shoreline water (within 36 blocks)');
      assert.equal(fishedCast, true, 'fish must cast after reaching shoreline');
      assert.equal(rFish.ok, true, 'fish must succeed once target fish caught');

      // Part D: fish breaks covering ice on frozen ocean AND counts catches auto-eaten mid-cast
      let iceHoleDug = false;
      const botIceFish = makeBot({
        entity: { position: new Vec3(0, 63, 0), yaw: 0, pitch: 0 },
        health: 16,
        food: 1,
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'fishing_rod', count: 1, slot: 36 }] },
        equip: async (it) => { botIceFish.heldItem = it; },
        lookAt: async () => {},
        findBlocks: () => [],
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x === 1 && y === 62 && z === 0) return iceHoleDug
            ? { name: 'water', position: new Vec3(1, 62, 0), boundingBox: 'empty' }
            : { name: 'ice', position: new Vec3(1, 62, 0), boundingBox: 'block' };
          if (x === 1 && y === 61 && z === 0) return { name: 'water', position: new Vec3(1, 61, 0), boundingBox: 'empty' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
        dig: async (blk) => { if (blk && blk.name === 'ice') iceHoleDug = true; },
        fish: async () => { botIceFish.food = Math.min(20, botIceFish.food + 2); },
      });
      const rIceFish = await reg.get('fish').run(botIceFish, { count: 1, timeoutSec: 25 });
      assert.equal(iceHoleDug, true, 'fish must break adjacent ice over water to open an ice-fishing hole');
      assert.equal(rIceFish.ok, true, 'fish must recognize catch even when auto-eat consumes it immediately');
      assert.ok(/caught 1 fish/i.test(rIceFish.observation), `fish observation must report caught fish (got ${rIceFish.observation})`);
    } finally {
      reg.get('deep_shaft').run = origDS5;
      reg.get('roam').run = origRoam5;
      reg.get('walk_to').run = origWalk5;
    }
  }

  // 38. deep_shaft / equipBulkPick crafts a fresh stone_pickaxe instead of digging deepslate with wooden_pickaxe (11.25s/block)
  {
    const P13 = require('../src/minecraft/autonomous/skills/primitives');
    const origCraft13 = P13.craft;
    let craftedStonePick = false;
    try {
      const items = [
        { name: 'wooden_pickaxe', count: 1, slot: 36, maxDurability: 59, durabilityUsed: 0 },
        { name: 'cobblestone', count: 12, slot: 37 },
        { name: 'stick', count: 6, slot: 38 },
      ];
      P13.craft = async (b, name) => {
        if (name === 'stone_pickaxe') {
          craftedStonePick = true;
          items.push({ name: 'stone_pickaxe', count: 1, slot: 39, maxDurability: 131, durabilityUsed: 0 });
          return { ok: true, observation: 'crafted stone_pickaxe' };
        }
        return { ok: false, observation: 'stub' };
      };
      const botPick = makeBot({
        entity: { position: new Vec3(0, -10, 0), yaw: 0, pitch: 0 },
        heldItem: items[0],
        _floods: [],
        inventory: { slots: new Array(46).fill(null), items: () => items },
        setQuickBarSlot: async (idx) => {
          const hit = items.find(i => i.slot === 36 + idx);
          if (hit) botPick.heldItem = hit;
        },
        equip: async (it) => { botPick.heldItem = it; },
        nearestEntity: () => null,
        blockAt: () => ({ name: 'bedrock', position: new Vec3(0, -11, 0), boundingBox: 'block' }),
      });
      await reg.get('deep_shaft').run(botPick, { toY: -53, max: 1 });
      assert.equal(craftedStonePick, true, 'equipBulkPick must craft stone_pickaxe when only wooden_pickaxe is in pack and cobble+sticks exist');
      assert.equal(botPick.heldItem && botPick.heldItem.name, 'stone_pickaxe', 'deep_shaft must equip the newly crafted stone_pickaxe instead of wooden_pickaxe');
    } finally {
      P13.craft = origCraft13;
    }
  }

  // 39. survive() does NOT re-open food milestone deep underground (y=-55) at hp=13, food=16 (avoids 120-block climb-out mid-obsidian)
  {
    const st39 = { done: { food: true } };
    const botDeep = makeBot({
      entity: { position: new Vec3(-71, -55, -263), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      health: 13,
      food: 16,
    });
    const blocked = await planner.survive(botDeep, st39);
    assert.equal(blocked, false, 'survive() must return false underground at hp=13, food=16');
    assert.equal(st39.done.food, true, 'survive() must NOT re-open food milestone underground at hp=13, food=16');
  }

  // 40. tidy aims steeply into a 4-deep pit & seals it with a cap block (never tosses onto own feet without disposal);
  //     food milestone stockpiles >=40 hunger points in one trip & cooks ALL raw meat before closing
  {
    const P14 = require('../src/minecraft/autonomous/skills/primitives');
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');

    // Part A: pit aim is steeply downward (< feet.y) and pit gets sealed at (1, 63, 0) after tossing
    const dugCells = new Set();
    let lookTarget = null;
    let sealedPos = null;
    const pitInv = [
      { name: 'snowball', count: 8, slot: 9 },
      { name: 'cobblestone', count: 16, slot: 10 },
      { name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 0 },
    ];
    const botPit = makeBot({
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 },
      inventory: { slots: new Array(46).fill(null), items: () => pitInv },
      lookAt: async (pt) => { lookTarget = pt; },
      equip: async (it) => { botPit.heldItem = it; },
      dig: async (blk) => { dugCells.add(`${blk.position.x},${blk.position.y},${blk.position.z}`); },
      tossStack: async (it) => {
        const idx = pitInv.indexOf(it);
        if (idx >= 0) pitInv.splice(idx, 1);
      },
      placeBlock: async (ref, face) => {
        sealedPos = ref.position.plus(face);
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (dugCells.has(`${x},${y},${z}`)) return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        if (y <= 63) return { name: 'dirt', position: new Vec3(x, y, z), boundingBox: 'block', hardness: 0.5 };
        return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
      },
    });
    await P14.dropJunk(botPit, true, 6);
    assert.ok(dugCells.has('1,60,0'), 'tidy must dig a 4-deep pit down to feet.y - 4');
    assert.ok(lookTarget && lookTarget.y < 64, `tidy must aim steeply DOWN into the pit (< feet.y=64), not above the lip (got y=${lookTarget && lookTarget.y})`);
    assert.ok(sealedPos && sealedPos.x === 1 && sealedPos.y === 63 && sealedPos.z === 0, `tidy must seal the pit with a cap block at 1,63,0 after tossing (got ${sealedPos})`);

    // Part B: no diggable pit (bedrock floor) & no close lava -> refuse to drop trash at own feet!
    let bedrockTossed = 0;
    const botBedrock = makeBot({
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 },
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [{ name: 'granite', count: 32, slot: 9 }, { name: 'snowball', count: 8, slot: 10 }],
      },
      toss: async () => { bedrockTossed++; },
      tossStack: async () => { bedrockTossed++; },
      blockAt: (p) => {
        const y = p ? Math.floor(p.y) : 64;
        if (y <= 63) return { name: 'bedrock', position: p, boundingBox: 'block' };
        return { name: 'air', position: p, boundingBox: 'none' };
      },
    });
    await P14.dropJunk(botBedrock, true, 6);
    assert.equal(bedrockTossed, 0, 'tidy must NOT dump trash onto its own feet when no pit or close lava is available');

    // Part C: food milestone requires stockpiled rations (not done at food=20 with 0 items), hunts count>=8, cooks ALL raw beef (>6)
    const foodMs40 = LADDER.find(m => m.id === 'food');
    assert.equal(foodMs40.done(makeBot({ food: 20, inventory: { slots: new Array(46).fill(null), items: () => [] } })), false, 'food milestone must NOT close with 0 rations in pack even when food bar is 20');
    const origHunt40 = reg.get('hunt').run;
    const origSmelt40 = reg.get('smelt').run;
    const origEat40 = reg.get('eat').run;
    let huntReqCount = 0;
    let smeltBeefTotal = 0;
    try {
      const fInv = [{ name: 'coal', count: 16, slot: 9 }];
      reg.get('hunt').run = async (b, a) => {
        huntReqCount = a && a.count ? a.count : 0;
        fInv.push({ name: 'beef', count: 10, slot: 10 });
        return { ok: true, observation: 'hunted 8' };
      };
      reg.get('smelt').run = async (b, a) => {
        if (a && a.item === 'beef') {
          smeltBeefTotal += a.count;
          const bi = fInv.find(i => i.name === 'beef');
          if (bi) bi.count = Math.max(0, bi.count - a.count);
          fInv.push({ name: 'cooked_beef', count: a.count, slot: 11 });
        }
        return { ok: true, observation: 'smelted' };
      };
      reg.get('eat').run = async (b) => { b.food = 20; return { ok: true, observation: 'ate' }; };
      const botFood40 = makeBot({
        food: 10,
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => fInv },
        findBlocks: () => [],
      });
      const rF40 = await foodMs40.run(botFood40);
      assert.ok(huntReqCount >= 8, `food milestone must bulk-hunt >=8 animals in one trip (asked ${huntReqCount})`);
      assert.equal(smeltBeefTotal, 10, `food milestone must cook ALL 10 raw beef, not stop at 6 (cooked ${smeltBeefTotal})`);
      assert.equal(rF40.ok, true, 'food milestone must succeed once bulk cooked rations are stocked');
      assert.equal(foodMs40.done(botFood40), true, 'food.done must pass once >=40 hunger points of cooked steak are stocked');
    } finally {
      reg.get('hunt').run = origHunt40;
      reg.get('smelt').run = origSmelt40;
      reg.get('eat').run = origEat40;
    }
  }

  // 41. make_obsidian shifts off a FLOODED column even when already underground (y=43) above a remembered y=-55 obsidian field
  {
    const oreCache41 = require('../src/minecraft/autonomous/oreCache');
    const origDS41 = reg.get('deep_shaft').run;
    const origWalk41 = reg.get('walk_to').run;
    const origRoam41 = reg.get('roam').run;
    let shiftedToUnflooded = false;
    let dugAtUnflooded = false;
    try {
      oreCache41.remember('obsidian', 1200, -55, 1200);
      reg.get('roam').run = async () => ({ ok: false, observation: 'stub-stop' });
      reg.get('walk_to').run = async (b, a) => {
        if (a && Math.hypot(a.x - 1200, a.z - 1200) >= 12) {
          shiftedToUnflooded = true;
          b.entity.position = new Vec3(a.x, a.y, a.z);
        }
        return { ok: true, observation: 'shifted' };
      };
      reg.get('deep_shaft').run = async (b, a) => {
        if (Math.hypot(b.entity.position.x - 1200, b.entity.position.z - 1200) >= 12) {
          dugAtUnflooded = true;
          b.entity.position = new Vec3(b.entity.position.x, a.toY, b.entity.position.z);
          b._stepDeadline = 1;
          return { ok: true, observation: `y=${a.toY}` };
        }
        return { ok: false, observation: 'column 1200,1200 is FLOODED' };
      };
      const items41 = [
        { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
        { name: 'water_bucket', count: 1, slot: 37 },
      ];
      const botField41 = makeBot({
        entity: { position: new Vec3(1200, 43, 1200), yaw: 0, pitch: 0 },
        heldItem: items41[0],
        _floods: [{ x: 1200, z: 1200, y: 40 }],
        inventory: { slots: new Array(46).fill(null), items: () => items41 },
        equip: async (it) => { botField41.heldItem = it; },
        setQuickBarSlot: async (idx) => { const hit = items41.find(i => i.slot === 36 + idx); if (hit) botField41.heldItem = hit; },
        findBlocks: () => [],
        pathfinder: { stop: () => {}, goto: async () => {} },
        blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
      });
      await reg.get('make_obsidian').run(botField41, { count: 10 });
      assert.equal(shiftedToUnflooded, true, 'make_obsidian must shift off a FLOODED column even at underground y=43');
      assert.equal(dugAtUnflooded, true, 'make_obsidian must descend deep_shaft on the unflooded column toward y=-55 field');
    } finally {
      oreCache41.forget(1200, -55, 1200);
      reg.get('deep_shaft').run = origDS41;
      reg.get('walk_to').run = origWalk41;
      reg.get('roam').run = origRoam41;
    }
  }

  // 42. obsidian_farm mines already-converted nearby obsidian BEFORE trekking to refill empty bucket,
  //     and reclaim() is in scope after pouring (no ReferenceError: reclaim is not defined)
  {
    const oreCache42 = require('../src/minecraft/autonomous/oreCache');
    const P42 = require('../src/minecraft/autonomous/skills/primitives');
    const obsId42 = P42.blockIds(makeBot(), ['obsidian'])[0];
    const origWalk42 = reg.get('walk_to').run;
    let walkedToWaterStation = false;
    try {
      oreCache42.remember('lava', 1500, -55, 1500);
      oreCache42.remember('water', 1520, 62, 1520);
      reg.get('walk_to').run = async (b, a) => {
        if (a && a.y >= 50) walkedToWaterStation = true;
        return { ok: false, observation: 'stub-stop' };
      };
      const remainingObs = new Set(['1501,-55,1500', '1502,-55,1500']);
      const inv42 = [
        { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
        { name: 'bucket', count: 1, slot: 37 }, // empty bucket!
        { name: 'obsidian', count: 8, slot: 38 },
      ];
      const botFarm42 = makeBot({
        entity: { position: new Vec3(1500, -55, 1500), yaw: 0, pitch: 0 },
        heldItem: inv42[0],
        inventory: { slots: new Array(46).fill(null), items: () => inv42 },
        equip: async (it) => { botFarm42.heldItem = it; },
        setQuickBarSlot: async (idx) => { const h = inv42.find(i => i.slot === 36 + idx); if (h) botFarm42.heldItem = h; },
        pathfinder: { stop: () => {}, goto: async () => {} },
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          if (!m.includes(obsId42)) return [];
          return [...remainingObs].map(k => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); });
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (remainingObs.has(`${x},${y},${z}`)) return { name: 'obsidian', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
        dig: async (blk) => {
          const k = `${blk.position.x},${blk.position.y},${blk.position.z}`;
          if (remainingObs.delete(k)) {
            const obs = inv42.find(i => i.name === 'obsidian');
            if (obs) obs.count += 1;
          }
        },
      });
      const rFarm42 = await reg.get('obsidian_farm').run(botFarm42, { count: 10 });
      assert.equal(rFarm42.ok, true, `obsidian_farm must finish 8->10 from nearby converted obsidian (got ${rFarm42.observation})`);
      assert.equal(walkedToWaterStation, false, 'obsidian_farm must NOT leave the site to refill bucket while converted obsidian is already in reach');
    } finally {
      oreCache42.forget(1500, -55, 1500);
      oreCache42.forget(1520, 62, 1520);
      reg.get('walk_to').run = origWalk42;
    }
  }

  // 43. oreCache.forget(x,y,z,blockMs) suppresses passive re-remembering of underwater pockets,
  //     and obsidian_farm breaks covering ice on frozen water stations to fill its bucket
  {
    const oreCache43 = require('../src/minecraft/autonomous/oreCache');
    const P43 = require('../src/minecraft/autonomous/skills/primitives');
    const waterId43 = P43.blockIds(makeBot(), ['water'])[0];
    oreCache43.remember('obsidian', 1700, 30, 1700);
    oreCache43.forget(1700, 30, 1700, 60000);
    oreCache43.remember('obsidian', 1700, 30, 1700);
    const reAdded = oreCache43.list(['obsidian'], { x: 1700, y: 30, z: 1700 }).find(e => e.x === 1700 && e.z === 1700);
    assert.equal(reAdded, undefined, 'oreCache.forget with blockMs must suppress immediate re-remembering of dead/underwater pockets');

    let iceBroke43 = false;
    let bucketFilled43 = false;
    const inv43 = [
      { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 0 },
      { name: 'stone_pickaxe', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 0 },
      { name: 'bucket', count: 1, slot: 38 },
    ];
    try {
      oreCache43.remember('lava', 1800, -55, 1800);
      oreCache43.remember('water', 1801, 61, 1800);
      const botIce43 = makeBot({
        entity: { position: new Vec3(1800, 63, 1800), yaw: 0, pitch: 0 },
        heldItem: inv43[2],
        inventory: { slots: new Array(46).fill(null), items: () => inv43 },
        equip: async (it) => { botIce43.heldItem = it; },
        setQuickBarSlot: async (idx) => { const h = inv43.find(i => i.slot === 36 + idx); if (h) botIce43.heldItem = h; },
        lookAt: async () => {},
        pathfinder: { stop: () => {}, goto: async () => {} },
        findBlocks: ({ matching }) => {
          const m = Array.isArray(matching) ? matching : [matching];
          return m.includes(waterId43) ? [new Vec3(1801, 61, 1800)] : [];
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (x === 1801 && y === 62 && z === 1800) {
            return iceBroke43
              ? { name: 'water', position: new Vec3(1801, 62, 1800), boundingBox: 'empty', getProperties: () => ({ level: 0 }) }
              : { name: 'ice', position: new Vec3(1801, 62, 1800), boundingBox: 'block' };
          }
          if (x === 1801 && y === 61 && z === 1800) return { name: 'water', position: new Vec3(1801, 61, 1800), boundingBox: 'empty', getProperties: () => ({ level: 0 }) };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
        dig: async (blk) => { if (blk && blk.name === 'ice') iceBroke43 = true; },
        activateItem: async () => {
          if (iceBroke43) {
            bucketFilled43 = true;
            inv43[2].name = 'water_bucket';
            botIce43._stepDeadline = 1;
          }
        },
      });
      await reg.get('obsidian_farm').run(botIce43, { count: 10 });
      assert.equal(iceBroke43, true, 'obsidian_farm must break covering ice above y=61 water on frozen stations');
      assert.equal(bucketFilled43, true, 'obsidian_farm must fill water_bucket after breaking covering ice');
    } finally {
      oreCache43.forget(1800, -55, 1800);
      oreCache43.forget(1801, 61, 1800);
    }
  }

  // 44. food milestone hunts shallow-water cod/salmon entities on barren frozen coasts (no cows, no kelp, no rod)
  //     and cooks all caught salmon into cooked_salmon
  {
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const foodMs44 = LADDER.find(m => m.id === 'food');
    const origHunt44 = reg.get('hunt').run;
    const origKelp44 = reg.get('harvest_kelp').run;
    const origRoam44 = reg.get('roam').run;
    const origSmelt44 = reg.get('smelt').run;
    const origEat44 = reg.get('eat').run;
    let fishAttacked = 0;
    let salmonCooked = 0;
    try {
      const fInv44 = [
        { name: 'iron_sword', count: 1, slot: 36 },
        { name: 'coal', count: 12, slot: 37 },
      ];
      reg.get('hunt').run = async () => ({ ok: false, observation: 'no livestock' });
      reg.get('harvest_kelp').run = async () => ({ ok: false, observation: 'no kelp' });
      reg.get('roam').run = async () => ({ ok: false, observation: 'frozen ocean' });
      reg.get('smelt').run = async (b, a) => {
        if (a && a.item === 'salmon') {
          salmonCooked += a.count;
          const si = fInv44.find(i => i.name === 'salmon');
          if (si) si.count = Math.max(0, si.count - a.count);
          fInv44.push({ name: 'cooked_salmon', count: a.count, slot: 39 });
        }
        return { ok: true, observation: 'cooked salmon' };
      };
      reg.get('eat').run = async (b) => { b.food = 20; return { ok: true, observation: 'ate' }; };
      let liveSalmon = 8;
      const botFishCoast = makeBot({
        food: 10,
        health: 18,
        oxygenLevel: 20,
        entity: { position: new Vec3(0, 63, 0), yaw: 0, pitch: 0 },
        heldItem: fInv44[0],
        inventory: { slots: new Array(46).fill(null), items: () => fInv44 },
        equip: async (it) => { botFishCoast.heldItem = it; },
        pathfinder: { stop: () => {}, goto: async () => {} },
        findBlocks: () => [],
        findBlock: () => null,
        nearestEntity: (fn) => {
          if (liveSalmon <= 0) return null;
          const e = { id: 900 + liveSalmon, name: 'salmon', position: new Vec3(2, 61, 0), isValid: true };
          return fn(e) ? e : null;
        },
        attack: async () => {
          fishAttacked++;
          liveSalmon--;
          const si = fInv44.find(i => i.name === 'salmon');
          if (si) si.count += 1;
          else fInv44.push({ name: 'salmon', count: 1, slot: 38 });
        },
      });
      const r44 = await foodMs44.run(botFishCoast);
      assert.ok(fishAttacked >= 8, `food milestone must hunt shallow-water salmon on barren coasts (hits=${fishAttacked})`);
      assert.equal(salmonCooked, 8, `food milestone must cook all 8 caught salmon (cooked=${salmonCooked})`);
      assert.equal(r44.ok, true, 'food milestone must pass after catching & cooking coastal salmon');
      assert.equal(foodMs44.done(botFishCoast), true, 'food.done must pass with 8 cooked_salmon (48 hunger points)');
    } finally {
      reg.get('hunt').run = origHunt44;
      reg.get('harvest_kelp').run = origKelp44;
      reg.get('roam').run = origRoam44;
      reg.get('smelt').run = origSmelt44;
      reg.get('eat').run = origEat44;
    }
  }

  // 45. roam walks across snow-covered ground instead of rejecting every column as non-air (`turned 48x, walked 0`),
  //     and food coastal fish-hunt works even when starving at Easy-difficulty hp=9.5
  {
    let snowGotoCalls = 0;
    const botSnow = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      nearestEntity: () => null,
      pathfinder: {
        stop: () => {},
        goto: async (goal) => {
          snowGotoCalls++;
          botSnow.entity.position = new Vec3(goal.x, goal.y, goal.z);
        },
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const y = Math.floor(p.y);
        if (y === 64) return { name: 'snow', position: p, boundingBox: 'empty' };
        if (y <= 63) return { name: 'grass_block', position: p, boundingBox: 'block' };
        return { name: 'air', position: p, boundingBox: 'none' };
      },
    });
    await reg.get('roam').run(botSnow, { look_for: 'cow', distance: 52, dir: 'E' });
    assert.ok(snowGotoCalls >= 1, `roam must walk across snow-covered dry ground instead of spinning 48x (gotoCalls=${snowGotoCalls})`);
  }

  // 46. roam leaving a tiny dry island/peninsula swims to distant land (>=14m) instead of its own (0 blocks) feet,
  //     and barren-coast food immediately hunts a nearby spider -> crafts/uses fishing_rod without 3-min wait
  {
    const swimTargets = [];
    const botIsland = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      nearestEntity: () => null,
      pathfinder: {
        stop: () => {},
        goto: async (goal) => {
          swimTargets.push({ x: goal.x, y: goal.y, z: goal.z, d: Math.round(Math.hypot(goal.x, goal.z)) });
          botIsland.entity.position = new Vec3(goal.x, goal.y, goal.z);
          botIsland._stepDeadline = 1;
        },
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        // Tiny 3x3 island at (0, 63, 0) + real mainland starting at x >= 24; ocean everywhere between
        const onTinyIsland = Math.abs(x) <= 1 && Math.abs(z) <= 1;
        const onMainland = x >= 24 && x <= 44 && Math.abs(z) <= 20;
        if (y === 63) {
          if (onTinyIsland || onMainland) return { name: 'grass_block', position: p, boundingBox: 'block', biome: { name: 'plains' } };
          return { name: 'water', position: p, boundingBox: 'empty' };
        }
        if (y < 63) return { name: 'stone', position: p, boundingBox: 'block' };
        return { name: 'air', position: p, boundingBox: 'none' };
      },
    });
    await reg.get('roam').run(botIsland, { look_for: 'cow', distance: 60, dir: 'N' });
    assert.ok(swimTargets.length >= 1, 'roam on a tiny island must swim to a distant landmass');
    assert.ok(swimTargets[0].d >= 14, `island escape must target distant land (>=14m), not own 0-block feet (got d=${swimTargets[0].d})`);

    // Second half: barren coast food immediately hunts nearby spider -> fishes without 3-min delay
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const foodMs46 = LADDER.find(m => m.id === 'food');
    const origHunt46 = reg.get('hunt').run;
    const origKelp46 = reg.get('harvest_kelp').run;
    const origSp46 = reg.get('hunt_spider').run;
    const origFish46 = reg.get('fish').run;
    const origSmelt46 = reg.get('smelt').run;
    const origEat46 = reg.get('eat').run;
    let spiderHunted46 = false;
    let fished46 = false;
    try {
      const inv46 = [
        { name: 'iron_sword', count: 1, slot: 36 },
        { name: 'stick', count: 4, slot: 37 },
        { name: 'coal', count: 10, slot: 38 },
      ];
      reg.get('hunt').run = async () => ({ ok: false, observation: 'no cows' });
      reg.get('harvest_kelp').run = async () => ({ ok: false, observation: 'no kelp' });
      reg.get('hunt_spider').run = async () => {
        spiderHunted46 = true;
        inv46.push({ name: 'string', count: 2, slot: 39 });
        return { ok: true, observation: 'got 2 string' };
      };
      reg.get('fish').run = async () => {
        fished46 = true;
        inv46.push({ name: 'cooked_salmon', count: 8, slot: 40 });
        return { ok: true, observation: 'caught 8' };
      };
      reg.get('smelt').run = async () => ({ ok: true, observation: 'smelted' });
      reg.get('eat').run = async (b) => { b.food = 20; return { ok: true, observation: 'ate' }; };
      const botRod46 = makeBot({
        food: 16,
        health: 18,
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => inv46 },
        findBlocks: () => [],
        findBlock: () => ({ name: 'water', position: new Vec3(3, 62, 0) }),
        nearestEntity: (fn) => {
          const sp = { id: 777, name: 'spider', position: new Vec3(10, 64, 0), isValid: true };
          return fn(sp) ? sp : null;
        },
      });
      await foodMs46.run(botRod46);
      assert.equal(spiderHunted46, true, 'barren-coast food must hunt nearby spider for fishing-rod string without 3-min wait');
      assert.equal(fished46, true, 'barren-coast food must fish immediately once 2 string + 3 sticks are held');
    } finally {
      reg.get('hunt').run = origHunt46;
      reg.get('harvest_kelp').run = origKelp46;
      reg.get('hunt_spider').run = origSp46;
      reg.get('fish').run = origFish46;
      reg.get('smelt').run = origSmelt46;
      reg.get('eat').run = origEat46;
    }
  }

  // 47. hunt walkDrops sweeps ALL drop entities from a multi-drop animal kill (both leather AND beef),
  //     instead of returning after grabbing leather and leaving beef behind
  {
    const inv47 = [{ name: 'iron_sword', count: 1, slot: 36 }];
    const worldEntities47 = {
      1001: { id: 1001, name: 'cow', position: new Vec3(2, 64, 0) },
    };
    const pickedIds47 = [];
    const botCow47 = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      entities: worldEntities47,
      inventory: { slots: new Array(46).fill(null), items: () => inv47 },
      nearestEntity: (fn) => Object.values(worldEntities47).find(e => fn(e)) || null,
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        return Math.floor(p.y) <= 63
          ? { name: 'grass_block', position: p, boundingBox: 'block' }
          : { name: 'air', position: p, boundingBox: 'none' };
      },
      pvp: {
        stop: () => {},
        attack: async (ent) => {
          delete worldEntities47[ent.id];
          // Cow drops TWO separate item entities: leather (closer) + beef (slightly further)
          worldEntities47[2001] = { id: 2001, name: 'item', position: new Vec3(1.5, 64, 0), item: { name: 'leather' } };
          worldEntities47[2002] = { id: 2002, name: 'item', position: new Vec3(3.0, 64, 0), item: { name: 'beef' } };
        },
      },
      pathfinder: {
        isMoving: () => false,
        stop: () => {},
        goto: async (goal) => {
          botCow47.entity.position = new Vec3(goal.x, goal.y, goal.z);
          for (const id of Object.keys(worldEntities47)) {
            const en = worldEntities47[id];
            if (en && en.name === 'item' && en.position.distanceTo(botCow47.entity.position) < 1.2) {
              pickedIds47.push(en.item.name);
              inv47.push({ name: en.item.name, count: 2, slot: 37 + pickedIds47.length });
              delete worldEntities47[id];
            }
          }
        },
      },
    });
    const r47 = await reg.get('hunt').run(botCow47, { count: 1, kind: 'cow' });
    assert.equal(r47.ok, true, 'hunt must succeed on cow kill');
    assert.ok(pickedIds47.includes('leather'), 'walkDrops must pick up leather');
    assert.ok(pickedIds47.includes('beef'), `walkDrops must sweep ALL drops including beef, not return after leather (got [${pickedIds47.join(',')}])`);

    // Also verify collectNear matches array itemName filters and sweeps multiple matching drops
    const P47 = require('../src/minecraft/autonomous/skills/primitives');
    const cEnts47 = {
      3001: { id: 3001, name: 'item', position: new Vec3(1, 64, 0), item: { name: 'wheat_seeds' } },
      3002: { id: 3002, name: 'item', position: new Vec3(2, 64, 0), item: { name: 'wheat' } },
    };
    const cPicked47 = [];
    const botCol47 = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      entities: cEnts47,
      pathfinder: {
        stop: () => {},
        goto: async (goal) => {
          botCol47.entity.position = new Vec3(goal.x, goal.y, goal.z);
          for (const id of Object.keys(cEnts47)) {
            const en = cEnts47[id];
            if (en && en.position.distanceTo(botCol47.entity.position) < 1.2) {
              cPicked47.push(en.item.name);
              delete cEnts47[id];
            }
          }
        },
      },
    });
    const colOk47 = await P47.collectNear(botCol47, new Vec3(1, 64, 0), ['wheat', 'wheat_seeds'], 5000);
    assert.equal(colOk47, true, 'collectNear must accept array itemName filter');
    assert.ok(cPicked47.includes('wheat') && cPicked47.includes('wheat_seeds'), `collectNear must sweep all matching drops in array filter (got [${cPicked47.join(',')}])`);
  }

  // 48. breathe() punches through overhead ice sheet when trapped underwater, nearestLandPatch avoids recent
  //     swim cells & prefers lush plains over snowy_taiga, and hunt records passive livestock into WS herd memory
  {
    const P48 = require('../src/minecraft/autonomous/skills/primitives');
    const WS48 = require('../src/minecraft/autonomous/workshopRecord');
    // 48a: breathe breaks overhead ice ceiling
    let iceBroken48 = false;
    const botUnderIce = makeBot({
      oxygenLevel: 4,
      entity: { position: new Vec3(0, 60, 0), yaw: 0, pitch: 0 },
      pathfinder: { isMoving: () => false, stop: () => {} },
      look: async () => {},
      setControlState: (st, val) => {
        if (st === 'jump' && val && iceBroken48) botUnderIce.entity.position = new Vec3(0, 63, 0);
      },
      dig: async (blk) => { if (blk && blk.name === 'ice') iceBroken48 = true; },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const y = Math.floor(p.y);
        if (y === 62) return iceBroken48 ? { name: 'air', position: p, boundingBox: 'none' } : { name: 'ice', position: p, boundingBox: 'block' };
        if (y === 60 || y === 61) return { name: 'water', position: p, boundingBox: 'empty' };
        return { name: 'air', position: p, boundingBox: 'none' };
      },
    });
    const br48 = await P48.breathe(botUnderIce, 'ice-trap-test');
    assert.equal(iceBroken48, true, 'breathe() must dig overhead ice ceiling when trapped underwater');
    assert.equal(br48.ok, true, 'breathe() must surface after breaking overhead ice');

    // 48b: nearestLandPatch skips avoid cells and prefers lush plains over nearby snowy_taiga
    const botBiome48 = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'empty' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (y === 63) {
          if (Math.hypot(x - 20, z) <= 8) return { name: 'snow_block', position: p, boundingBox: 'block', biome: { name: 'snowy_taiga' } };
          if (Math.hypot(x + 40, z) <= 12) return { name: 'grass_block', position: p, boundingBox: 'block', biome: { name: 'plains' } };
          return { name: 'water', position: p, boundingBox: 'empty' };
        }
        return { name: 'air', position: p, boundingBox: 'empty' };
      },
    });
    const lp48 = P48.nearestLandPatch(botBiome48, { reach: 100, minDist: 16, avoid: [{ x: 20, z: 0 }], preferLush: true });
    assert.ok(lp48 && lp48.biome === 'plains', `nearestLandPatch must avoid visited snowy_taiga and prefer lush plains (got ${JSON.stringify(lp48)})`);

    // 48c: hunt notes livestock meadow in workshopRecord('herd') (already verified via cow kill in #47)
    const herd48 = WS48.at('herd');
    assert.ok(herd48 && herd48.extra === 'cow', `hunt must record livestock meadow in WS('herd') (got ${JSON.stringify(herd48)})`);
    WS48.forget('herd');
  }

  // 49. tidy ballistic pit solver adjusts pitch to bot's exact offset (far edge vs near edge) and ignores pre-existing
  //     dug dirt entities when verifying tossed items; food sustained march rotates compass headings E->S->W->N
  {
    const prevVerify49 = process.env.MC_TIDY_VERIFY_MS;
    process.env.MC_TIDY_VERIFY_MS = '50';
    try {
      // Bot standing at far edge of its block (x=0.15, pit at x=1 -> center 1.5 -> horiz=1.35m)
      let lookTarget49 = null;
      const pitDug49 = new Set();
      const inv49 = [
        { name: 'snowball', count: 8, slot: 9 },
        { name: 'cobblestone', count: 16, slot: 10 },
      ];
      // Pre-existing dug dirt entity already sitting at the bottom of the pit BEFORE toss!
      const ents49 = {
        7001: { id: 7001, name: 'item', position: new Vec3(1.5, 60.1, 0.5) },
      };
      const botPit49 = makeBot({
        entity: { position: new Vec3(0.15, 64, 0.5), yaw: 0, pitch: 0 },
        entities: ents49,
        inventory: { slots: new Array(46).fill(null), items: () => inv49 },
        lookAt: async (pt) => { lookTarget49 = pt; },
        findBlocks: () => [],
        dig: async (b) => { pitDug49.add(`${b.position.x},${b.position.y},${b.position.z}`); },
        tossStack: async (it) => {
          const idx = inv49.indexOf(it);
          if (idx >= 0) inv49.splice(idx, 1);
          // Simulate an OUTSIDE mis-throw at bot's own feet — must NOT be fooled by pre-existing dug dirt #7001!
          ents49[7002] = { id: 7002, name: 'item', position: new Vec3(0.2, 64.0, 0.5) };
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'empty' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (y >= 64) return { name: 'air', position: p, boundingBox: 'none' };
          if (pitDug49.has(`${x},${y},${z}`)) return { name: 'air', position: p, boundingBox: 'none' };
          return { name: 'dirt', position: p, boundingBox: 'block', hardness: 0.5 };
        },
      });
      const r49 = await reg.get('tidy').run(botPit49, { min_free: 6 });
      assert.ok(lookTarget49, 'tidy must aim at the dug pit');
      // For horiz=1.35m, ballistic solver picks ~43-49 deg (aimY ~ 64.1..64.6), shallower than -65 deg so it reaches 1.35m!
      const effPitchDeg = Math.atan2((64 + 1.62) - lookTarget49.y, 1.35) * 180 / Math.PI;
      assert.ok(effPitchDeg >= 30 && effPitchDeg <= 56, `far-edge horiz=1.35m must use ballistic pitch ~38-52deg instead of undershooting -65deg (got -${effPitchDeg.toFixed(1)}deg)`);
      assert.match(r49.observation, /REJECTED/, 'tidy must NOT be fooled by pre-existing dug dirt entity inside pit when tossed item lands outside');
    } finally {
      if (prevVerify49 === undefined) delete process.env.MC_TIDY_VERIFY_MS; else process.env.MC_TIDY_VERIFY_MS = prevVerify49;
    }

    // Second half: food rotates sustained compass headings (E -> S) across calls
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const foodMs49 = LADDER.find(m => m.id === 'food');
    const origHunt49 = reg.get('hunt').run;
    const origKelp49 = reg.get('harvest_kelp').run;
    const origRoam49 = reg.get('roam').run;
    const origEat49 = reg.get('eat').run;
    const dirsSeen49 = [];
    try {
      reg.get('hunt').run = async () => ({ ok: false, observation: 'none' });
      reg.get('harvest_kelp').run = async () => ({ ok: false, observation: 'none' });
      reg.get('roam').run = async (b, a) => { dirsSeen49.push(a && a.dir); return { ok: false, observation: 'marched' }; };
      reg.get('eat').run = async () => ({ ok: true, observation: 'ate' });
      const botDir49 = makeBot({
        food: 12,
        health: 20,
        time: { timeOfDay: 6000 }, // bright noon: must not waste time on surface undead hunt
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        inventory: { slots: new Array(46).fill(null), items: () => [] },
        findBlocks: () => [],
        findBlock: () => null,
        nearestEntity: () => null,
      });
      await foodMs49.run(botDir49);
      await foodMs49.run(botDir49);
      assert.deepEqual(dirsSeen49, ['E', 'S'], `food sustained march must pass rotating compass dirs E->S (got ${JSON.stringify(dirsSeen49)})`);
    } finally {
      reg.get('hunt').run = origHunt49;
      reg.get('harvest_kelp').run = origKelp49;
      reg.get('roam').run = origRoam49;
      reg.get('eat').run = origEat49;
    }
  }

  // 50. meleeKill waits until a mob actually dies when mineflayer-pvp.attack() resolves immediately in 0 ms,
  //     swings bot.attack() until entityGone, and collects all drops at its real death spot
  {
    const inv50 = [{ name: 'iron_sword', count: 1, slot: 36 }];
    let cowHp50 = 10, swings50 = 0, pvpStopCalls50 = 0;
    const ents50 = {
      8001: { id: 8001, name: 'cow', height: 1.4, position: new Vec3(2, 64, 0) },
    };
    const picked50 = [];
    const botPvp50 = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      entities: ents50,
      inventory: { slots: new Array(46).fill(null), items: () => inv50 },
      nearestEntity: (fn) => Object.values(ents50).find(e => fn(e)) || null,
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'empty' };
        return Math.floor(p.y) <= 63
          ? { name: 'grass_block', position: p, boundingBox: 'block' }
          : { name: 'air', position: p, boundingBox: 'empty' };
      },
      // Simulate real mineflayer-pvp: attack() returns immediately without killing the mob!
      pvp: {
        target: null,
        attack: async (ent) => { botPvp50.pvp.target = ent; },
        stop: () => { pvpStopCalls50++; botPvp50.pvp.target = null; },
      },
      attack: (ent) => {
        swings50++;
        cowHp50 -= 6;
        // Cow flees slightly when hit, dies on 2nd hit and drops beef + leather at new spot (3, 64, 0)
        if (cowHp50 > 0) ent.position = new Vec3(3, 64, 0);
        else {
          delete ents50[ent.id];
          ents50[8002] = { id: 8002, name: 'item', position: new Vec3(3, 64, 0), item: { name: 'beef' } };
          ents50[8003] = { id: 8003, name: 'item', position: new Vec3(3.2, 64, 0), item: { name: 'leather' } };
        }
      },
      pathfinder: {
        isMoving: () => false,
        stop: () => {},
        goto: async (goal) => {
          botPvp50.entity.position = new Vec3(goal.x, goal.y, goal.z);
          for (const id of Object.keys(ents50)) {
            const en = ents50[id];
            if (en && en.name === 'item' && en.position.distanceTo(botPvp50.entity.position) < 1.3) {
              picked50.push(en.item.name);
              inv50.push({ name: en.item.name, count: 2, slot: 37 + picked50.length });
              delete ents50[id];
            }
          }
        },
      },
    });
    const r50 = await reg.get('hunt').run(botPvp50, { count: 1, kind: 'cow' });
    assert.equal(r50.ok, true, 'hunt must succeed after actually killing cow');
    assert.ok(swings50 >= 2, `meleeKill must wait & swing until cow dies instead of stopping pvp in 0ms (swings=${swings50})`);
    assert.ok(pvpStopCalls50 >= 1, 'meleeKill must cleanly stop pvp after mob dies');
    assert.ok(picked50.includes('beef') && picked50.includes('leather'), `hunt must collect beef & leather at real death pos (got [${picked50.join(',')}])`);
  }

  // 51. Inside a 2x1 vertical shaft (`bot._avoidPitCols`), tidy skips the staircase columns and carves a
  //     perpendicular side-wall alcove + 4-deep pit so descending deeper never unearths sealed trash
  {
    const prevVerify51 = process.env.MC_TIDY_VERIFY_MS;
    process.env.MC_TIDY_VERIFY_MS = '50';
    try {
      const dug51 = new Set();
      const inv51 = [
        { name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 10 },
        { name: 'snowball', count: 6, slot: 9 },
        { name: 'cobblestone', count: 16, slot: 10 },
      ];
      let pitColUsed51 = null;
      const botShaft51 = makeBot({
        entity: { position: new Vec3(0.5, 40, 0.5), yaw: 0, pitch: 0 },
        _avoidPitCols: new Set(['1,0', '-1,0']), // 2x1 shaft runs along +-X
        entities: {},
        inventory: { slots: new Array(46).fill(null), items: () => inv51 },
        heldItem: inv51[0],
        findBlocks: () => [],
        equip: async (it) => { botShaft51.heldItem = it; },
        lookAt: async (pt) => { pitColUsed51 = { x: Math.floor(pt.x), z: Math.floor(pt.z) }; },
        dig: async (b) => { dug51.add(`${b.position.x},${b.position.y},${b.position.z}`); },
        tossStack: async (it) => { const i = inv51.indexOf(it); if (i >= 0) inv51.splice(i, 1); },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'empty' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (dug51.has(`${x},${y},${z}`)) return { name: 'air', position: p, boundingBox: 'none' };
          // Open 2x1 shaft at (0,y,0) and (1,y,0) for y >= 40; solid stone walls on +-Z (0,y,+-1)
          if ((x === 0 || x === 1) && z === 0 && y >= 40) return { name: 'air', position: p, boundingBox: 'none' };
          return { name: 'stone', position: p, boundingBox: 'block', hardness: 1.5 };
        },
      });
      await reg.get('tidy').run(botShaft51, { min_free: 6 });
      assert.ok(pitColUsed51, 'tidy inside a narrow shaft must carve a perpendicular side-wall pit');
      assert.equal(pitColUsed51.x, 0, `pit must NOT use staircase column x=+-1 (got ${JSON.stringify(pitColUsed51)})`);
      assert.ok(Math.abs(pitColUsed51.z) === 1, `pit must be carved into perpendicular z=+-1 wall (got ${JSON.stringify(pitColUsed51)})`);
    } finally {
      if (prevVerify51 === undefined) delete process.env.MC_TIDY_VERIFY_MS; else process.env.MC_TIDY_VERIFY_MS = prevVerify51;
    }
  }

  // 52. build_nether_portal uses cheap cobblestone scaffolding for the 4 optional corners when carrying only
  //     10-12 obsidian, placing all 10 essential obsidian cells cleanly without running out before the top bar
  {
    const WS52 = require('../src/minecraft/autonomous/workshopRecord');
    WS52.forget('nether_portal_frame');
    const placed52 = new Map(); // "x,y,z" -> name
    const inv52 = [
      { name: 'obsidian', count: 10, slot: 36 },
      { name: 'cobblestone', count: 20, slot: 37 },
      { name: 'flint_and_steel', count: 1, slot: 38 },
    ];
    const botPortal52 = makeBot({
      entity: { position: new Vec3(10, 64, 10), yaw: 0, pitch: 0 },
      game: { dimension: 'overworld' },
      inventory: { slots: new Array(46).fill(null), items: () => inv52 },
      heldItem: inv52[0],
      waitForChunksToLoad: async () => {},
      lookAt: async () => {},
      findBlock: () => null,
      findBlocks: () => [],
      equip: async (it) => { botPortal52.heldItem = it; },
      activateBlock: async () => {
        // Simulate flint_and_steel lighting interior when all 10 essential cells are obsidian
        botPortal52.game.dimension = 'the_nether';
      },
      pathfinder: {
        stop: () => {},
        goto: async (goal) => { botPortal52.entity.position = new Vec3(goal.x, goal.y, goal.z); },
      },
      placeBlock: async (ref, face) => {
        const tx = ref.position.x + face.x, ty = ref.position.y + face.y, tz = ref.position.z + face.z;
        const held = botPortal52.heldItem;
        if (!held || held.count <= 0) return;
        placed52.set(`${tx},${ty},${tz}`, held.name);
        held.count--;
        if (held.count <= 0) {
          const idx = inv52.indexOf(held);
          if (idx >= 0) inv52.splice(idx, 1);
          botPortal52.heldItem = null;
        }
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'empty' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        const placed = placed52.get(`${x},${y},${z}`);
        if (placed) return { name: placed, position: new Vec3(x, y, z), boundingBox: 'block' };
        if (y <= 63) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
        return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
      },
    });
    // Stub use_portal so test doesn't wait 30s on portal transition
    const origUsePortal52 = reg.get('use_portal').run;
    try {
      reg.get('use_portal').run = async (b) => { b.game.dimension = 'the_nether'; return { ok: true, observation: 'entered' }; };
      await reg.get('build_nether_portal').run(botPortal52, {});
      const obsPlaced = [...placed52.values()].filter(n => n === 'obsidian').length;
      const cobPlaced = [...placed52.values()].filter(n => n === 'cobblestone').length;
      assert.equal(obsPlaced, 10, `build_nether_portal must place all 10 essential obsidian cells using only 10 obsidian (got obs=${obsPlaced}, cob=${cobPlaced})`);
      assert.ok(cobPlaced >= 4, `build_nether_portal must scaffold all 4 optional corners with cheap rock instead of burning obsidian (got cob=${cobPlaced})`);
    } finally {
      reg.get('use_portal').run = origUsePortal52;
      WS52.forget('nether_portal_frame');
    }
  }

  // 53. build_nether_portal reclaims unneeded obsidian from optional bottom corners of an 8/10 + 4-corner frame
  //     to finish the final 2 top-bar cells immediately without trekking back down to y=-55
  {
    const WS53 = require('../src/minecraft/autonomous/workshopRecord');
    WS53.note('nether_portal_frame', { x: 20, y: 64, z: 20 }, '8/10 + 4 corners');
    const world53 = new Map();
    // Place 8 essential cells (missing top bar (1,4) & (2,4)) PLUS all 4 optional obsidian corners!
    for (const [dx, dy] of [[0,0],[1,0],[2,0],[3,0],[0,1],[3,1],[0,2],[3,2],[0,3],[3,3],[0,4],[3,4]]) {
      world53.set(`${20 + dx},${64 + dy},20`, 'obsidian');
    }
    const inv53 = [
      { name: 'diamond_pickaxe', count: 1, slot: 20, maxDurability: 1561, durabilityUsed: 100 },
      { name: 'flint_and_steel', count: 1, slot: 37 },
      { name: 'cobblestone', count: 20, slot: 38 },
    ];
    let reclaimed53 = 0, lit53 = false, hotbarClicked53 = false;
    const origUse53 = reg.get('use_portal').run;
    const origMakeObs53 = reg.get('make_obsidian').run;
    let makeObsCalled53 = false;
    try {
      reg.get('use_portal').run = async (b) => { b.game.dimension = 'the_nether'; return { ok: true, observation: 'entered' }; };
      reg.get('make_obsidian').run = async () => { makeObsCalled53 = true; return { ok: false, observation: 'should not be called' }; };
      const slots53 = new Array(46).fill(null);
      for (const it of inv53) slots53[it.slot] = it;
      const botRec53 = makeBot({
        entity: { position: new Vec3(21, 64, 19), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: slots53, items: () => inv53 },
        heldItem: inv53[2], // holding cobblestone initially; first equip fails silently (mineflayer#3906)
        waitForChunksToLoad: async () => {},
        lookAt: async () => {},
        findBlocks: () => [],
        findBlock: (opts) => {
          if (lit53) return { name: 'nether_portal', position: new Vec3(21, 65, 20) };
          return null;
        },
        clickWindow: async (slot) => { if (slot === 20) hotbarClicked53 = true; },
        setQuickBarSlot: async () => { if (hotbarClicked53) botRec53.heldItem = inv53[0]; },
        equip: async (it) => {
          // Simulate mineflayer#3906: non-hotbar diamond_pickaxe equip ignored until moved to hotbar
          if (it && it.name === 'diamond_pickaxe' && !hotbarClicked53) return;
          botRec53.heldItem = it;
        },
        dig: async (blk) => {
          assert.equal(botRec53.heldItem && botRec53.heldItem.name, 'diamond_pickaxe', 'must hold diamond_pickaxe before digging corner obsidian');
          const k = `${blk.position.x},${blk.position.y},${blk.position.z}`;
          if (world53.get(k) === 'obsidian') {
            world53.delete(k);
            reclaimed53++;
            const o = inv53.find(i => i.name === 'obsidian');
            if (o) o.count++;
            else inv53.push({ name: 'obsidian', count: 1, slot: 39 });
          }
        },
        pathfinder: {
          stop: () => {},
          goto: async (goal) => { botRec53.entity.position = new Vec3(goal.x, goal.y, goal.z); },
        },
        placeBlock: async (ref, face) => {
          const tx = ref.position.x + face.x, ty = ref.position.y + face.y, tz = ref.position.z + face.z;
          const held = botRec53.heldItem;
          if (!held) return;
          if (held.name === 'flint_and_steel') { lit53 = true; return; }
          world53.set(`${tx},${ty},${tz}`, held.name);
          held.count--;
          if (held.count <= 0) { inv53.splice(inv53.indexOf(held), 1); botRec53.heldItem = null; }
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'empty' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          const nm = world53.get(`${x},${y},${z}`);
          if (nm) return { name: nm, position: new Vec3(x, y, z), boundingBox: 'block' };
          if (y <= 63) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('build_nether_portal').run(botRec53, {});
      assert.equal(reclaimed53, 2, `must reclaim 2 optional bottom corner obsidian blocks (got ${reclaimed53})`);
      assert.equal(makeObsCalled53, false, 'must NOT call make_obsidian when optional corners supply the missing 2 blocks');
      assert.equal(world53.get('21,68,20'), 'obsidian', 'top-left bar cell (1,4) must be placed with reclaimed obsidian');
      assert.equal(world53.get('22,68,20'), 'obsidian', 'top-right bar cell (2,4) must be placed with reclaimed obsidian');
    } finally {
      reg.get('use_portal').run = origUse53;
      reg.get('make_obsidian').run = origMakeObs53;
      WS53.forget('nether_portal_frame');
    }
  }

  // 54. equipBestToolFor selects sword for cobweb (0.4s instead of 100s with pickaxe) and
  //     build_nether_portal descends vertically when standing >5 blocks above an underground portal frame
  {
    const P54 = require('../src/minecraft/autonomous/skills/primitives');
    const WS54 = require('../src/minecraft/autonomous/workshopRecord');
    // 54a: cobweb selects sword
    const inv54 = [
      { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 10 },
      { name: 'stone_sword', count: 1, slot: 37, maxDurability: 131, durabilityUsed: 10 },
    ];
    let equipped54 = null;
    const botWeb54 = makeBot({
      inventory: { slots: new Array(46).fill(null), items: () => inv54 },
      heldItem: inv54[0],
      equip: async (it) => { equipped54 = it.name; botWeb54.heldItem = it; },
    });
    await P54.equipBestToolFor(botWeb54, { name: 'cobweb', type: 112, hardness: 4 });
    assert.equal(equipped54, 'stone_sword', `equipBestToolFor must select sword for cobweb, not pickaxe (got ${equipped54})`);

    // 54b: build_nether_portal descends when standing 23 blocks above remembered underground frame
    WS54.note('nether_portal_frame', { x: 30, y: 40, z: 30 }, 'underground 8/10');
    const origWalk54 = reg.get('walk_to').run;
    const origShaft54 = reg.get('deep_shaft').run;
    let descendedToY54 = null;
    try {
      reg.get('walk_to').run = async () => ({ ok: true, observation: 'horizontal only' });
      reg.get('deep_shaft').run = async (b, a) => {
        descendedToY54 = a && a.toY;
        b.entity.position = new Vec3(31, 40, 28);
        return { ok: true, observation: 'descended' };
      };
      const botHigh54 = makeBot({
        entity: { position: new Vec3(31, 63, 28), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'flint_and_steel', count: 1, slot: 36 }] },
        findBlock: () => null,
        findBlocks: () => [],
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'empty' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (z === 30 && y >= 40 && y <= 43 && (x === 30 || x === 33 || (y === 40 && (x === 31 || x === 32)))) {
            return { name: 'obsidian', position: new Vec3(x, y, z), boundingBox: 'block' };
          }
          if (y === 39) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      // Stop right after descent via stub make_obsidian so test finishes fast
      const origMake54 = reg.get('make_obsidian').run;
      const origPour54 = reg.get('pour_portal_cell').run;
      try {
        reg.get('pour_portal_cell').run = async () => ({ ok: false, observation: 'no lava' });
        reg.get('make_obsidian').run = async () => ({ ok: false, observation: 'stop' });
        await reg.get('build_nether_portal').run(botHigh54, {});
      } finally {
        reg.get('make_obsidian').run = origMake54;
        reg.get('pour_portal_cell').run = origPour54;
      }
      assert.equal(descendedToY54, 40, `build_nether_portal must descend vertically to frame y=40 when standing 23m above it (got ${descendedToY54})`);
    } finally {
      reg.get('walk_to').run = origWalk54;
      reg.get('deep_shaft').run = origShaft54;
      WS54.forget('nether_portal_frame');
    }
  }

  // 55. nether milestone does NOT call recover_surface (hauling the bot away into ocean) when an underground
  //     nether_portal_frame is already recorded at y<52
  {
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const WS55 = require('../src/minecraft/autonomous/workshopRecord');
    const netherMs55 = LADDER.find(m => m.id === 'nether');
    const origRec55 = reg.get('recover_surface').run;
    const origBuild55 = reg.get('build_nether_portal').run;
    let surfaced55 = false, built55 = false;
    try {
      WS55.note('nether_portal_frame', { x: -78, y: 40, z: -259 }, 'underground standing frame');
      reg.get('recover_surface').run = async () => { surfaced55 = true; return { ok: true, observation: 'surfaced' }; };
      reg.get('build_nether_portal').run = async () => { built55 = true; return { ok: true, observation: 'built' }; };
      const botN55 = makeBot({
        entity: { position: new Vec3(-75, 40, -261), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
      });
      await netherMs55.run(botN55);
      assert.equal(surfaced55, false, 'nether milestone must NOT haul bot to surface when underground frame already exists at y=40');
      assert.equal(built55, true, 'nether milestone must go straight to build_nether_portal at frame depth');
    } finally {
      reg.get('recover_surface').run = origRec55;
      reg.get('build_nether_portal').run = origBuild55;
      WS55.forget('nether_portal_frame');
    }
  }

  // 56. patchBrokenPickaxeMaterials fixes the 1.21.1 minecraft-data incorrect_for_wooden_tool bug
  //     (obsidian + diamond_pickaxe drops from 75,000ms -> 9,400ms; diamond_ore + iron_pickaxe 4,550ms -> 750ms)
  //     and installSafeDig adds +150ms Paper RTT margin on long (>=5s) digs
  {
    const { patchBrokenPickaxeMaterials, installSafeDig } = require('../src/minecraft/autonomous/bot');
    const mcData56 = require('minecraft-data')('1.21.1');
    const Block56 = require('prismarine-block')('1.21.1');
    const dpick56 = mcData56.itemsByName.diamond_pickaxe.id;
    const ipick56 = mcData56.itemsByName.iron_pickaxe.id;
    const spick56 = mcData56.itemsByName.stone_pickaxe.id;
    const obs56 = new Block56(mcData56.blocksByName.obsidian.id, 0, 0);
    const dia56 = new Block56(mcData56.blocksByName.diamond_ore.id, 0, 0);
    // Patch a fresh clone/registry (and the shared 1.21.1 registry)
    assert.equal(patchBrokenPickaxeMaterials(mcData56), true, 'patchBrokenPickaxeMaterials must patch incorrect_for_* tables');
    const obsTimeD = obs56.digTime(dpick56, false, false, false);
    const obsTimeS = obs56.digTime(spick56, false, false, false);
    const diaTimeI = dia56.digTime(ipick56, false, false, false);
    assert.ok(obsTimeD >= 9000 && obsTimeD <= 10000, `obsidian with diamond_pickaxe must be ~9,400ms, not 75,000ms (got ${obsTimeD})`);
    assert.ok(obsTimeS >= 60000, `obsidian with stone_pickaxe must remain unharvestably slow >=60s (got ${obsTimeS})`);
    assert.ok(diaTimeI >= 600 && diaTimeI <= 900, `diamond_ore with iron_pickaxe must be ~750ms, not 4,550ms (got ${diaTimeI})`);
    const bot56 = {
      registry: mcData56,
      dig: async () => {},
      digTime: () => 9400,
      blockAt: () => ({ name: 'air' }),
    };
    installSafeDig(bot56);
    assert.equal(bot56.digTime(obs56), 9550, 'installSafeDig must add +150ms Paper RTT margin on >=5s digs');
  }

  // 57. deep_shaft refuses to dig straight down through a 1-block cave crust over a 67-block chasm
  //     AND treats >40-block open air drops (dropToSolid===null, probedAir>=4) as lethal instead of jumping off
  {
    let dugCrust57 = false;
    let jumpedChasm57 = false;
    const inv57 = [{ name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 5 }];
    // 57a: 1-block solid crust at y=34 directly over air chasm y=33..-32
    const botCrust57 = makeBot({
      entity: { position: new Vec3(-90, 35, -259), yaw: 0, pitch: 0 },
      health: 20, food: 20,
      entities: {},
      nearestEntity: () => null,
      inventory: { slots: new Array(46).fill(null), items: () => inv57 },
      heldItem: inv57[0],
      equip: async (it) => { botCrust57.heldItem = it; },
      dig: async (b) => {
        if (b && b.position && b.position.x === -90 && b.position.y === 34 && b.position.z === -259) dugCrust57 = true;
      },
      setControlState: () => {},
      look: async () => {},
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (x === -90 && z === -259 && y === 34) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
        // Chasm everywhere below y=34 down to y=-32
        if (y <= 33 && y >= -32) return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
      },
    });
    const res57a = await reg.get('deep_shaft').run(botCrust57, { toY: -50, max: 10 });
    assert.equal(dugCrust57, false, 'deep_shaft must NOT break 1-block crust straight into a >=5-block air chasm');
    assert.equal(res57a.ok, false, 'deep_shaft must bail out cleanly when surrounded by chasm');

    // 57b: standing over an ALREADY open 67-block air chasm (>40 blocks so dropToSolid is null)
    const botOpen57 = makeBot({
      entity: { position: new Vec3(-90, 35, -259), yaw: 0, pitch: 0 },
      health: 20, food: 20,
      entities: {},
      nearestEntity: () => null,
      inventory: { slots: new Array(46).fill(null), items: () => inv57 },
      heldItem: inv57[0],
      equip: async (it) => { botOpen57.heldItem = it; },
      dig: async () => {},
      setControlState: (k, v) => { if (k === 'jump' && v) jumpedChasm57 = true; },
      look: async () => {},
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const y = Math.floor(p.y);
        if (y >= -32 && y <= 35) return { name: 'air', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: 'none' };
        return { name: 'deepslate', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: 'block' };
      },
    });
    await reg.get('deep_shaft').run(botOpen57, { toY: -50, max: 3 });
    assert.equal(jumpedChasm57, false, 'deep_shaft must NOT jump off a >40-block open chasm when dropToSolid is null');
  }

  // 58. make_obsidian stays on a dry hilltop (<=48m) instead of walking back onto a flooded ocean column above
  //     a deep obsidian field, AND build_nether_portal descends DRY from a hilltop <=48m away when sea ice/water
  //     sits above an underground y=40 portal frame
  {
    const WS58 = require('../src/minecraft/autonomous/workshopRecord');
    const origWalk58 = reg.get('walk_to').run;
    const origShaft58 = reg.get('deep_shaft').run;
    const origPour58 = reg.get('pour_portal_cell').run;
    const origMake58 = reg.get('make_obsidian').run;
    const walkedSurface58 = [];
    let shaftStartPos58 = null;
    try {
      WS58.note('nether_portal_frame', { x: 0, y: 40, z: 0 }, 'under-ice 8/10 frame');
      reg.get('walk_to').run = async (b, a) => {
        walkedSurface58.push({ y: Math.round(b.entity.position.y), tx: a.x, ty: a.y, tz: a.z });
        return { ok: true, observation: 'walked' };
      };
      reg.get('deep_shaft').run = async (b, a) => {
        shaftStartPos58 = { x: Math.round(b.entity.position.x), y: Math.round(b.entity.position.y), z: Math.round(b.entity.position.z), toY: a.toY };
        b.entity.position = new Vec3(b.entity.position.x, a.toY, b.entity.position.z);
        return { ok: true, observation: 'descended dry' };
      };
      reg.get('pour_portal_cell').run = async () => ({ ok: false, observation: 'no lava' });
      reg.get('make_obsidian').run = async () => ({ ok: false, observation: 'stop' });
      const botIce58 = makeBot({
        entity: { position: new Vec3(-20, 68, 28), yaw: 0, pitch: 0 }, // 34m away on dry hilltop!
        game: { dimension: 'overworld' },
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'flint_and_steel', count: 1, slot: 36 }] },
        findBlock: () => null,
        findBlocks: () => [],
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          // Sea ice at y=62 above the portal frame (0,40,0)
          if (x === 0 && z === 0 && (y === 61 || y === 62)) return { name: y === 62 ? 'ice' : 'water', position: new Vec3(x, y, z), boundingBox: 'block' };
          if (z === 0 && y >= 40 && y <= 43 && (x === 0 || x === 3 || (y === 40 && (x === 1 || x === 2)))) {
            return { name: 'obsidian', position: new Vec3(x, y, z), boundingBox: 'block' };
          }
          if (y === 39 || (x === -20 && z === 28 && y <= 67)) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('build_nether_portal').run(botIce58, {});
      assert.ok(shaftStartPos58 && shaftStartPos58.y === 68 && shaftStartPos58.toY === 40,
        `build_nether_portal must descend dry from hilltop y=68 to y=40 instead of walking across sea ice (shaft=${JSON.stringify(shaftStartPos58)})`);
      assert.ok(walkedSurface58.every(w => w.y <= 45),
        `build_nether_portal must NOT walk across y=68 sea ice before descending (walks=${JSON.stringify(walkedSurface58)})`);
    } finally {
      reg.get('walk_to').run = origWalk58;
      reg.get('deep_shaft').run = origShaft58;
      reg.get('pour_portal_cell').run = origPour58;
      reg.get('make_obsidian').run = origMake58;
      WS58.forget('nether_portal_frame');
    }
  }

  // 59. build_nether_portal does NOT climb 50 blocks UP empty-handed when already deep underground (y=-16)
  //     below a y=40 frame with 0/2 obsidian; it stays deep and calls make_obsidian first
  {
    const WS59 = require('../src/minecraft/autonomous/workshopRecord');
    const origWalk59 = reg.get('walk_to').run;
    const origPour59 = reg.get('pour_portal_cell').run;
    const origMake59 = reg.get('make_obsidian').run;
    let climbedBeforeMake59 = false;
    let makeObsY59 = null;
    try {
      WS59.note('nether_portal_frame', { x: -78, y: 40, z: -259 }, 'underground 8/10');
      reg.get('walk_to').run = async () => { climbedBeforeMake59 = true; return { ok: true, observation: 'walked' }; };
      reg.get('pour_portal_cell').run = async () => ({ ok: false, observation: 'no lava bucket' });
      reg.get('make_obsidian').run = async (b) => {
        makeObsY59 = Math.round(b.entity.position.y);
        return { ok: false, observation: 'harvesting deep' };
      };
      const botDeep59 = makeBot({
        entity: { position: new Vec3(-86, -16, -260), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'flint_and_steel', count: 1, slot: 36 }] },
        findBlock: () => null,
        findBlocks: () => [],
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          if (z === -259 && y >= 40 && y <= 43 && (x === -78 || x === -75 || (y === 40 && (x === -77 || x === -76)))) {
            return { name: 'obsidian', position: new Vec3(x, y, z), boundingBox: 'block' };
          }
          if (y === 39) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('build_nether_portal').run(botDeep59, {});
      assert.equal(climbedBeforeMake59, false, 'build_nether_portal must NOT climb back up to y=40 empty-handed with 0 obsidian');
      assert.equal(makeObsY59, -16, `build_nether_portal must call make_obsidian directly from deep y=-16 (got ${makeObsY59})`);
    } finally {
      reg.get('walk_to').run = origWalk59;
      reg.get('pour_portal_cell').run = origPour59;
      reg.get('make_obsidian').run = origMake59;
      WS59.forget('nether_portal_frame');
    }
  }

  // 60. build_nether_portal reclaims an optional TOP corner obsidian ((3,4) or (0,4)) when carrying 1/2 obsidian
  //     and cobblestone scaffolding (both bottom corners already gone), re-scaffolds it with cobblestone, and finishes
  //     the 10/10 frame without calling make_obsidian
  {
    const WS60 = require('../src/minecraft/autonomous/workshopRecord');
    WS60.note('nether_portal_frame', { x: 40, y: 40, z: 40 }, '8/10 + 2 top corners');
    const world60 = new Map();
    // 8 essential cells + ONLY the 2 top optional corners (0,4) and (3,4) — bottom corners already gone!
    for (const [dx, dy] of [[1,0],[2,0],[0,1],[3,1],[0,2],[3,2],[0,3],[3,3],[0,4],[3,4]]) {
      world60.set(`${40 + dx},${40 + dy},40`, 'obsidian');
    }
    const inv60 = [
      { name: 'diamond_pickaxe', count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 50 },
      { name: 'obsidian', count: 1, slot: 37 },
      { name: 'flint_and_steel', count: 1, slot: 38 },
      { name: 'cobblestone', count: 32, slot: 39 },
    ];
    let reclaimedTop60 = false, lit60 = false, makeObs60 = false;
    const origUse60 = reg.get('use_portal').run;
    const origMake60 = reg.get('make_obsidian').run;
    try {
      reg.get('use_portal').run = async (b) => { b.game.dimension = 'the_nether'; return { ok: true, observation: 'entered' }; };
      reg.get('make_obsidian').run = async () => { makeObs60 = true; return { ok: false, observation: 'should not be called' }; };
      const slots60 = new Array(46).fill(null);
      for (const it of inv60) slots60[it.slot] = it;
      const botTop60 = makeBot({
        entity: { position: new Vec3(42, 41, 39), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: slots60, items: () => inv60 },
        heldItem: inv60[0],
        waitForChunksToLoad: async () => {},
        lookAt: async () => {},
        findBlocks: () => [],
        findBlock: () => (lit60 ? { name: 'nether_portal', position: new Vec3(41, 41, 40) } : null),
        equip: async (it) => { botTop60.heldItem = it; },
        dig: async (blk) => {
          const k = `${blk.position.x},${blk.position.y},${blk.position.z}`;
          if (world60.get(k) === 'obsidian') {
            world60.delete(k);
            if (blk.position.y === 44) reclaimedTop60 = true;
            const o = inv60.find(i => i.name === 'obsidian');
            if (o) o.count++;
            else inv60.push({ name: 'obsidian', count: 1, slot: 37 });
          }
        },
        pathfinder: {
          stop: () => {},
          goto: async (goal) => { botTop60.entity.position = new Vec3(goal.x, goal.y, goal.z); },
        },
        placeBlock: async (ref, face) => {
          const tx = ref.position.x + face.x, ty = ref.position.y + face.y, tz = ref.position.z + face.z;
          const held = botTop60.heldItem;
          if (!held) return;
          if (held.name === 'flint_and_steel') { lit60 = true; return; }
          world60.set(`${tx},${ty},${tz}`, held.name);
          held.count--;
          if (held.count <= 0) { inv60.splice(inv60.indexOf(held), 1); botTop60.heldItem = null; }
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          const nm = world60.get(`${x},${y},${z}`);
          if (nm) return { name: nm, position: new Vec3(x, y, z), boundingBox: 'block' };
          if (y <= 39) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      await reg.get('build_nether_portal').run(botTop60, {});
      assert.equal(reclaimedTop60, true, 'must reclaim an optional top-corner obsidian when carrying 1/2 obsidian + cobblestone');
      assert.equal(makeObs60, false, 'must NOT call make_obsidian when top corner supplies the final needed obsidian');
      assert.equal(world60.get('41,44,40'), 'obsidian', 'top-bar (1,4) must be obsidian');
      assert.equal(world60.get('42,44,40'), 'obsidian', 'top-bar (2,4) must be obsidian');
      assert.equal(world60.get('43,44,40'), 'cobblestone', 'reclaimed top corner (3,4) must be re-scaffolded with cobblestone');
    } finally {
      reg.get('use_portal').run = origUse60;
      reg.get('make_obsidian').run = origMake60;
      WS60.forget('nether_portal_frame');
    }
  }

  // 61. fish prefers sky-lit surface water (y>=56) over underground cave pools AND catches fish on Minecraft
  //     1.21.1 fishing_bobber metadata[9]===true (biting flag) without relying on broken particle.amount===6
  {
    const EventEmitter = require('events');
    const em61 = new EventEmitter();
    const client61 = new EventEmitter();
    const inv61 = [{ name: 'fishing_rod', count: 1, slot: 36 }];
    let gotoTarget61 = null;
    let activateCalls61 = 0;
    const botFish61 = makeBot({
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      food: 16,
      inventory: { slots: new Array(46).fill(null), items: () => inv61 },
      heldItem: inv61[0],
      _client: client61,
      on: (...a) => em61.on(...a),
      removeListener: (...a) => em61.removeListener(...a),
      lookAt: async () => {},
      equip: async (it) => { botFish61.heldItem = it; },
      findBlocks: () => [
        new Vec3(4, 48, 0), // closer underground cave pool (must NOT beat surface water!)
        new Vec3(10, 62, 0), // surface ocean
      ],
      pathfinder: {
        stop: () => {},
        goto: async (goal) => {
          gotoTarget61 = { x: goal.x, y: goal.y, z: goal.z };
          botFish61.entity.position = new Vec3(goal.x, goal.y, goal.z);
        },
      },
      activateItem: () => {
        activateCalls61++;
        if (activateCalls61 === 1) {
          // Cast: spawn bobber then emit 1.21.1 metadata[9]=true (biting!)
          const bob = { id: 901, name: 'fishing_bobber', position: new Vec3(10, 62, 0), metadata: [] };
          setTimeout(() => em61.emit('entitySpawn', bob), 15);
          setTimeout(() => { bob.metadata[9] = true; em61.emit('entityUpdate', bob); }, 35);
        } else if (activateCalls61 === 2) {
          // Reel-in lands a cod in inventory!
          inv61.push({ name: 'cod', count: 1, slot: 37 });
        }
      },
      blockAt: (p) => {
        if (!p) return { name: 'air', boundingBox: 'none' };
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (x === 4 && y === 48 && z === 0) return { name: 'water', position: new Vec3(x, y, z), boundingBox: 'empty' };
        if (x === 10 && y === 62 && z === 0) return { name: 'water', position: new Vec3(x, y, z), boundingBox: 'empty' };
        if ((x === 9 || x === 11) && y === 62 && z === 0) return { name: 'grass_block', position: new Vec3(x, y, z), boundingBox: 'block' };
        if (y <= 61 && !(x === 4 && y === 48 && z === 0)) return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' };
        return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
      },
    });
    const r61 = await reg.get('fish').run(botFish61, { count: 1, timeoutSec: 10 });
    assert.ok(gotoTarget61 && gotoTarget61.y >= 62, `fish must walk to surface y>=62 shoreline, not underground y=48 pool (got ${JSON.stringify(gotoTarget61)})`);
    assert.equal(r61.ok, true, `fish must catch cod via 1.21.1 metadata[9]=true biting event (got ${r61.observation})`);
    assert.equal(activateCalls61, 2, `fish must cast once and reel in once on bite (got ${activateCalls61})`);
  }

  // 62. roam refuses to call pillar_up in Overworld open air (no space-elevator towers) AND safely digs
  //     straight down its own 1x1 pillar if already perched high above open air
  {
    const origPillar62 = reg.get('pillar_up').run;
    const origBridge62 = reg.get('bridge_to').run;
    let pillarCalls62 = 0;
    let dugPillar62 = 0;
    try {
      reg.get('pillar_up').run = async () => { pillarCalls62++; return { ok: true, observation: 'should not pillar in open air' }; };
      reg.get('bridge_to').run = async () => ({ ok: false, observation: 'no bridge' });
      // Perched atop a 1x1 cobblestone pillar from y=64..109 (feet at y=110), open air all around!
      const botSky62 = makeBot({
        entity: { position: new Vec3(129, 110, -518), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 5 }] },
        heldItem: { name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 5 },
        equip: async (it) => { botSky62.heldItem = it; },
        entities: {},
        nearestEntity: () => null,
        findBlocks: () => [],
        findBlock: () => null,
        pathfinder: {
          stop: () => {},
          goto: async () => { throw new Error('no path from sky pillar'); },
        },
        dig: async (blk) => {
          dugPillar62++;
          // Simulate dropping 1 block down our 1x1 pillar after breaking underfoot block
          botSky62.entity.position = new Vec3(129, blk.position.y, -518);
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          // Flat ground at y<=63 everywhere
          if (y <= 63) return { name: 'grass_block', position: new Vec3(x, y, z), boundingBox: 'block' };
          // Isolated 1x1 pillar at (129, 64..109, -518) PLUS a 1-block floating bridge_to nub at (130, 109, -518)!
          if (x === 130 && z === -518 && y === 109) return { name: 'cobblestone', position: new Vec3(x, y, z), boundingBox: 'block' };
          if (x === 129 && z === -518 && y >= 64 && y < Math.floor(botSky62.entity.position.y)) {
            return { name: 'cobblestone', position: new Vec3(x, y, z), boundingBox: 'block' };
          }
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      // Give roam a short step deadline so it exits promptly after descending to ground
      botSky62._stepDeadline = Date.now() + 15000;
      await reg.get('roam').run(botSky62, { target: 'cow', distance: 40 });
      assert.equal(pillarCalls62, 0, `roam must NEVER call pillar_up in Overworld open air (called ${pillarCalls62}x)`);
      assert.ok(dugPillar62 >= 40 && botSky62.entity.position.y <= 66,
        `roam must safely dig down isolated 1x1 pillar back to ground y<=66 (dug=${dugPillar62}, y=${botSky62.entity.position.y})`);
    } finally {
      reg.get('pillar_up').run = origPillar62;
      reg.get('bridge_to').run = origBridge62;
    }
  }

  // 63. roam stranded high up on a multi-block sky-bridge/ledge at y=118 (terrain 55m below at y=63 so
  //     gy===null and swimToShore throws No path!) finds the nearby solid vertical trunk within 4m and
  //     descends safely via deep_shaft instead of spinning forever on "surrounded by open ocean"
  {
    const origShaft63 = reg.get('deep_shaft').run;
    let shaftCalled63 = null;
    try {
      reg.get('deep_shaft').run = async (b, a) => {
        shaftCalled63 = { x: Math.round(b.entity.position.x), y: Math.round(b.entity.position.y), z: Math.round(b.entity.position.z), toY: a.toY };
        b.entity.position = new Vec3(b.entity.position.x, a.toY, b.entity.position.z);
        return { ok: true, observation: 'descended trunk' };
      };
      // Standing at (127, 118, -516) on a 4-block sky-bridge leading back to vertical pillar trunk at (129, 64..117, -518)
      const botHigh63 = makeBot({
        entity: { position: new Vec3(127, 118, -516), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 5 }] },
        heldItem: { name: 'stone_pickaxe', count: 1, slot: 36, maxDurability: 131, durabilityUsed: 5 },
        entities: {},
        nearestEntity: () => null,
        findBlocks: () => [],
        findBlock: () => null,
        pathfinder: {
          stop: () => {},
          goto: async (goal) => {
            // Allow walking across the sky-bridge (same Y=118, dist<=5); refuse drops to y=63!
            if (Math.abs(goal.y - botHigh63.entity.position.y) <= 2 && Math.hypot(goal.x - botHigh63.entity.position.x, goal.z - botHigh63.entity.position.z) <= 5) {
              botHigh63.entity.position = new Vec3(goal.x, goal.y, goal.z);
              return;
            }
            throw new Error('No path to the goal!');
          },
        },
        blockAt: (p) => {
          if (!p) return { name: 'air', boundingBox: 'none' };
          const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
          // Flat ground 55 blocks below at y<=63
          if (y <= 63) return { name: 'grass_block', position: new Vec3(x, y, z), boundingBox: 'block' };
          // 4-block horizontal sky-bridge deck at y=117 connecting (127,-516) to trunk (129,-518)
          if (y === 117 && x >= 127 && x <= 129 && z >= -518 && z <= -516) {
            return { name: 'cobblestone', position: new Vec3(x, y, z), boundingBox: 'block' };
          }
          // Solid vertical pillar trunk at (129, 64..117, -518)
          if (x === 129 && z === -518 && y >= 64 && y <= 117) {
            return { name: 'cobblestone', position: new Vec3(x, y, z), boundingBox: 'block' };
          }
          return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'none' };
        },
      });
      botHigh63._stepDeadline = Date.now() + 8000;
      await reg.get('roam').run(botHigh63, { target: 'cow', distance: 40 });
      assert.ok(shaftCalled63 && shaftCalled63.x === 129 && shaftCalled63.z === -518 && shaftCalled63.toY === 66,
        `roam stranded at y=118 must walk to solid trunk (129,-518) and run deep_shaft to y=66 (got ${JSON.stringify(shaftCalled63)})`);
    } finally {
      reg.get('deep_shaft').run = origShaft63;
    }
  }

  // 64. food milestone stays at a productive shore fishing spot (caught >=2 fish) and immediately cooks them
  //     instead of abandoning the shore for a 300m ocean roam
  {
    const { LADDER } = require('../src/minecraft/autonomous/skills/progression');
    const foodMs64 = LADDER.find(m => m.id === 'food');
    const origHunt64 = reg.get('hunt').run;
    const origFish64 = reg.get('fish').run;
    const origRoam64 = reg.get('roam').run;
    const origSmelt64 = reg.get('smelt').run;
    const origEat64 = reg.get('eat').run;
    const origKelp64 = reg.get('harvest_kelp').run;
    let roamed64 = false;
    let cookedCod64 = 0;
    try {
      const inv64 = [
        { name: 'fishing_rod', count: 1, slot: 36 },
        { name: 'coal', count: 8, slot: 37 },
      ];
      reg.get('hunt').run = async () => ({ ok: false, observation: 'no livestock' });
      reg.get('harvest_kelp').run = async () => ({ ok: false, observation: 'no kelp' });
      reg.get('fish').run = async (b) => {
        inv64.push({ name: 'cod', count: 4, slot: 38 });
        b._lastFish = { at: Date.now(), casts: 4, have: 4, totalCaught: 4, eatenDuring: 0 };
        return { ok: false, observation: 'caught 4 fish in 4 cast(s)' }; // partial batch (<14)
      };
      reg.get('roam').run = async () => { roamed64 = true; return { ok: false, observation: 'should not roam' }; };
      reg.get('smelt').run = async (b, a) => {
        if (a && a.item === 'cod') {
          cookedCod64 += a.count;
          const idx = inv64.findIndex(i => i.name === 'cod');
          if (idx >= 0) inv64.splice(idx, 1);
          inv64.push({ name: 'cooked_cod', count: a.count, slot: 39 });
          return { ok: true, observation: `smelted ${a.count} cooked_cod` };
        }
        return { ok: false, observation: 'none' };
      };
      reg.get('eat').run = async () => ({ ok: true, observation: 'fed' });
      const botFish64 = makeBot({
        entity: { position: new Vec3(-52, 63, -226), yaw: 0, pitch: 0 },
        game: { dimension: 'overworld' },
        food: 20, health: 20,
        time: { timeOfDay: 3000 },
        inventory: { slots: new Array(46).fill(null), items: () => inv64 },
        entities: {},
        nearestEntity: () => null,
        findBlock: (opts) => ({ name: 'water', position: new Vec3(-52, 62, -227) }),
        findBlocks: () => [],
      });
      await foodMs64.run(botFish64);
      assert.equal(roamed64, false, 'food milestone must NOT abandon a productive shore fishing spot to roam 300m');
      assert.equal(cookedCod64, 4, `food milestone must immediately cook all caught cod (got ${cookedCod64})`);
    } finally {
      reg.get('hunt').run = origHunt64;
      reg.get('fish').run = origFish64;
      reg.get('roam').run = origRoam64;
      reg.get('smelt').run = origSmelt64;
      reg.get('eat').run = origEat64;
      reg.get('harvest_kelp').run = origKelp64;
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS minecraft-autonomous: all 64 regression groups passed');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
