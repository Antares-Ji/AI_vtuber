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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS minecraft-autonomous: deadline helper, survive anti-spin, victory halt, chat/MC_TALK guards, gridcraft tableWin count, bridge + streamer factual narration');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
