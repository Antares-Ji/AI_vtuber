const { Movements, goals } = require('mineflayer-pathfinder');

// A bounded, deterministic first game task. Model decisions are not needed.
async function makeWorkbench(bot, { signal, log = () => {} } = {}) {
  const check = () => signal?.throwIfAborted();
  const count = name => bot.inventory.items().filter(item => item.name === name).reduce((n, item) => n + item.count, 0);
  const step = async (name, action, timeoutMs = 30000) => {
    check();
    log({ step: name, status: 'started' });
    let timer, abort;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => { check(); return action(); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name}: timeout`)), timeoutMs);
          abort = () => reject(signal.reason || new Error('cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        })
      ]);
      check();
      log({ step: name, status: 'completed' });
      return result;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  };
  await step('load_chunks', () => bot.waitForChunksToLoad());
  const movements = new Movements(bot);
  movements.canDig = false; // Pathfinding must not excavate unrelated terrain.
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  bot.pathfinder.setMovements(movements);
  const tableId = bot.registry.itemsByName.crafting_table?.id;
  if (tableId == null) throw new Error('This game version has no crafting_table recipe');
  const initialTables = count('crafting_table');
  // Require an actual log harvested during this run, even with starting items.
  const logIds = Object.values(bot.registry.blocksByName).filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped_')).map(b => b.id);
  const findTree = () => bot.findBlocks({ matching: logIds, maxDistance: 48, count: 80 }).map(p => bot.blockAt(p)).find(block => block && bot.findBlock({
    point: block.position, matching: b => /_leaves$/.test(b.name), maxDistance: 7
  }));
  // Logs with nearby leaves are a tree candidate, not a guarantee of provenance.
  let candidate = findTree();
  const origin = bot.entity.position.clone();
  for (const [dx, dz] of [[24, 0], [0, 24], [-24, 0], [0, -24], [48, 0], [0, 48]]) {
    if (candidate) break;
    try {
      await step('scout', () => bot.pathfinder.goto(new goals.GoalNearXZ(origin.x + dx, origin.z + dz, 3)), 15000);
      await step('load_scout_chunks', () => bot.waitForChunksToLoad(), 10000);
    } catch (error) {
      check();
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      log({ step: 'scout_unreachable', error: error.message });
    }
    candidate = findTree();
  }
  if (!candidate) throw new Error('No tree candidate within 48 blocks; move the bot spawn near a tree');
  log({ step: 'tree_selected', block: candidate.name, position: candidate.position });
  await step('approach_tree', () => bot.pathfinder.goto(new goals.GoalGetToBlock(candidate.position.x, candidate.position.y, candidate.position.z)));
  const block = bot.blockAt(candidate.position);
  if (!block || block.name !== candidate.name || !bot.canDigBlock(block)) throw new Error('Tree changed or cannot be reached for digging');
  const beforeLogs = count(block.name);
  await step('harvest_log', () => bot.dig(block));
  await step('approach_drop', () => bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1)));
  await step('collect_log', async () => {
    while (count(block.name) <= beforeLogs) { check(); await bot.waitForTicks(2); }
  }, 10000);
  const plankName = block.name.replace(/_log$/, '_planks');
  const plankId = bot.registry.itemsByName[plankName]?.id;
  const plankRecipe = plankId == null ? null : bot.recipesFor(plankId, null, 4, null)[0];
  if (!plankRecipe) throw new Error(`No usable inventory recipe for ${plankName}`);
  const beforePlanks = count(plankName);
  await step('craft_planks', () => bot.craft(plankRecipe, 1, null));
  if (count(plankName) < beforePlanks + 4) throw new Error('Server did not confirm four crafted planks');
  const recipe = bot.recipesFor(tableId, null, 1, null)[0];
  if (!recipe) throw new Error('No usable inventory recipe for crafting_table');
  await step('craft_workbench', () => bot.craft(recipe, 1, null));
  if (count('crafting_table') <= initialTables) throw new Error('Server inventory does not contain the new workbench');
  const result = { crafted: 1, item: 'crafting_table', inventory: bot.inventory.items().map(({ name, count }) => ({ name, count })) };
  log({ step: 'verified', ...result });
  return result;
}

module.exports = { makeWorkbench };
