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
      bot._stepDeadline = Date.now() + 22000; // stops after 1st ray due to deadline margin
      const rEye = await reg.get('locate_stronghold').run(bot, { throws: 2 });
      assert.match(rEye.observation, /followed 1 eye bearing \(1\.00,0\.00\)/i, 'must capture eye bearing from raw spawn_entity + rel_entity_move packets');
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS minecraft-autonomous: all 31 regression groups passed');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
