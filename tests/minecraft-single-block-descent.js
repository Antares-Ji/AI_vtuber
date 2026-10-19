const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Movements } = require('mineflayer-pathfinder');
const Move = require('mineflayer-pathfinder/lib/move');
const { safetyMovements, singleBlockDescents } = require('../src/minecraft/reactive-agent');
const { setSafeMovements } = require('../src/minecraft/survival-skills');
const registry = require('prismarine-registry')('1.21.11');
const Block = require('prismarine-block')(registry);
const fixture = require('./fixtures/minecraft-leaf-platform.json');
function makeBot() {
  const terrain = fixture.terrain, overrides = new Map(), grid = new Map(terrain.blocks.map(b => [`${b.x},${b.y},${b.z}`, b]));
  return { registry, food: 17, game: { minY: -64 }, entity: { position: new Vec3(59.5,114,86.5), effects: {} }, entities: {}, inventory: { items: () => [] }, overrides,
    pathfinder: { setMovements(m) { this.movements = m; } },
    blockAt(p) {
      if (Math.abs(p.x - 59) > 2 || Math.abs(p.z - 86) > 2 || p.y < 110 || p.y > 116) return null;
      const key = `${p.x},${p.y},${p.z}`, row = grid.get(key), name = overrides.has(key) ? overrides.get(key) : row?.name || 'air';
      if (name === 'unknown') return null;
      const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0); block.position = p;
      if (!overrides.has(key) && row) { block.boundingBox = row.boundingBox; block.shapes = row.shapes; }
      return block;
    }
  };
}
const start = new Move(59,114,86,0,0);
for (const builder of [setSafeMovements, safetyMovements]) {
  const bot = makeBot(), movement = builder(bot);
  movement.maxDropDown = 1;
  assert.equal(movement.getNeighbors(start).length, 0, 'installed floor-coordinate check reproduces real noPath at parameter1');
  movement.maxDropDown = 2;
  const moves = movement.getNeighbors(start);
  assert.equal(moves.length, 4, 'same real grid exposes four one-foot-level descents');
  assert(moves.every(p => p.y === 113 && !p.toBreak.length && !p.toPlace.length));
  const west = () => movement.getNeighbors(start).some(p => p.x === 58 && p.z === 86);
  for (const name of ['air', 'unknown', 'water', 'lava', 'sand', 'red_sand', 'gravel', 'white_concrete_powder', 'anvil']) {
    bot.overrides.set('58,112,86', name); assert(!west(), `${builder.name}: ${name} is not safe landing support`);
  }
  bot.overrides.clear();
  for (const cell of ['58,113,86', '58,114,86', '57,112,86']) {
    bot.overrides.set(cell, 'unknown'); assert(!west(), `${builder.name}: unloaded landing/body/adjacent cell fails closed`); bot.overrides.clear();
  }
  bot.overrides.set('57,112,86', 'water'); assert(!west(), 'no descent beside liquid'); bot.overrides.clear();
  bot.overrides.set('58,112,86', 'air'); bot.overrides.set('58,111,86', 'stone');
  movement.maxDropDown = 3;
  assert(!west(), 'explicit feet delta still rejects true2-block drop even if third-party option is enlarged');
  bot.overrides.clear(); movement.maxDropDown = 0;
  assert.equal(movement.getNeighbors(start).length, 0, 'emergency no-drop setting remains zero');
}
for (const field of ['toBreak', 'toPlace']) {
  const bot = makeBot(), movement = new Movements(bot), move = new Move(58,113,86,0,1);
  move[field] = [new Vec3(58,112,86)]; movement.getNeighbors = () => [move];
  singleBlockDescents(movement, bot);
  assert.deepEqual(movement.getNeighbors(start), [], `descent cannot ${field}`);
}
console.log('Installed-pathfinder real-grid regression: zero old neighbors, four dry one-block descents; true2drop, unknown, liquids, falling support and dig/place rejected. Emergency0 preserved. No game calls.');
