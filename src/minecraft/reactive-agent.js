const { expanded } = require('./capability-policy');
const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const Move = require('mineflayer-pathfinder/lib/move');
const { performance } = require('node:perf_hooks');
const LIFECYCLE_EPOCH = Symbol.for('ai-vtuber.minecraft.lifecycleEpoch');
const LEAF_NATIVE = Symbol.for('ai-vtuber.minecraft.reactiveLeafNative');
const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'vindicator', 'phantom']);
const TERRAIN_DANGERS = ['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow', 'cactus', 'sweet_berry_bush'];
const MELEE_THREATS = new Set(['zombie', 'husk', 'zombie_villager', 'spider']);
const RANGED_THREATS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch']);
function injuryState(bot) {
  const finite = value => Number.isFinite(value) ? value : null;
  const entity = bot.entity;
  // Mineflayer entity_effect stores only these three protocol-derived fields.
  // Copy scalars, never serialize Entity objects or infer poison from HP loss.
  const effects = Object.values(entity?.effects || {}).slice(0, 32).map(effect => ({
    id: finite(effect?.id), amplifier: finite(effect?.amplifier), duration: finite(effect?.duration)
  }));
  return { effects, onGround: typeof entity?.onGround === 'boolean' ? entity.onGround : 'unknown' };
}
function effectivePosition(bot, entity) {
  let current = entity;
  const seen = new Set([entity]);
  for (let depth = 0; depth < 8; depth++) {
    const vehicle = current?.vehicle;
    // Follow only a present, reciprocal passenger relation. Stale references,
    // removed mounts, cycles and unmapped IDs never create a remote threat.
    if (!vehicle || seen.has(vehicle) || bot.entities?.[vehicle.id] !== vehicle || !vehicle.position ||
        !(vehicle.passengers || []).some(p => p === current || p?.id === current.id)) break;
    seen.add(vehicle); current = vehicle;
  }
  return current?.position || entity?.position;
}
function entityView(bot, entity) {
  const view = Object.create(entity);
  Object.defineProperty(view, 'position', { get: () => effectivePosition(bot, entity) });
  return view;
}
function occludedThreat(bot, entity) {
  // Loaded mobs in separate caves must not permanently cancel surface work.
  // Nearby/mounted threats and unknown visibility keep the existing reflex.
  if (!HOSTILES.has(entity.name) || entity.distance <= 8 || entity.mounted || !bot.world?.raycast) return false;
  try {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
    const position = new Vec3(entity.position.x, entity.position.y, entity.position.z);
    const height = bot.entities[entity.id]?.height || 1.8;
    return [0.35, 0.85].every(fraction => {
      const ray = position.offset(0, height * fraction, 0).minus(eye);
      if (ray.norm() < 0.1) return false;
      const hit = bot.world.raycast(eye, ray.unit(), ray.norm() - 0.05);
      return hit?.shapes?.some(shape => shape.length === 6 && shape.every((value, index) => value === (index < 3 ? 0 : 1))) === true;
    });
  } catch { return false; }
}
function decide({ health, entities, enabled, armed = false, previousMode = 'idle' }) {
  if (!enabled || health <= 0) return { action: 'idle' };
  // Different enter/exit radii prevent alternating stop/start at twelve blocks.
  // Ranged foes already inside the loaded-entity observation radius can hurt
  // us outside the melee trigger. Their exit uses the existing calm timer;
  // no extra world/entity discovery is performed beyond the 24-block sample.
  const threats = entities.filter(e => HOSTILES.has(e.name) && e.distance <= (RANGED_THREATS.has(e.name) ? 24 : previousMode === 'flee' ? 20 : 12)).sort((a, b) => a.distance - b.distance);
  const threat = threats[0];
  // Expanded capabilities do not mean automatic pursuit. Qwen may explicitly
  // select combat; the unattended reflex should retreat when outmatched.
  if (!threat) return { action: 'idle' };
  if (previousMode === 'flee' || threat.mounted || !armed || health <= 12 || threats.length > 1 || !MELEE_THREATS.has(threat.name) || threat.distance > 3) return { action: 'flee', target: threats.find(e => e.name === 'creeper') || threat };
  return { action: 'fight', target: threat };
}
function safetyMovements(bot) {
  const movements = new Movements(bot);
  if (expanded) return movements;
  movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false;
  singleBlockDescents(movements, bot);
  movements.infiniteLiquidDropdownDistance = false;
  movements.scafoldingBlocks = []; // Never bridge into a hazard using inventory.
  movements.allowSprinting = bot.food > 6;
  for (const name of TERRAIN_DANGERS) { const id = bot.registry.blocksByName[name]?.id; if (id != null) movements.blocksToAvoid.add(id); }
  movements.exclusionAreasStep.push(block => {
    if (!block?.position) return 100;
    const floor = bot.blockAt?.(block.position.offset(0, -1, 0));
    if (floor && TERRAIN_DANGERS.includes(floor.name)) return 100;
    // Individual Mineflayer moves above cost 100 are discarded. A large
    // proximity penalty can accidentally forbid a diagonal/jump escape when
    // several cells are charged; this must remain a soft preference.
    return Object.values(bot.entities).map(e => entityView(bot, e)).some(e => e.position && HOSTILES.has(e.name) && Math.hypot(block.position.x - e.position.x, block.position.z - e.position.z) < (e.name === 'creeper' ? 8 : 5)) ? 12 : 0;
  });
  return movements;
}
function passable(block) { return !!block && block.boundingBox === 'empty' && !TERRAIN_DANGERS.includes(block.name); }
const FALLING_FLOORS = new Set(['sand', 'red_sand', 'gravel']);
function gravityBlock(name) { return FALLING_FLOORS.has(name) || /_concrete_powder$|anvil$/.test(name) || ['suspicious_sand', 'suspicious_gravel', 'dragon_egg', 'scaffolding'].includes(name); }
function safeFloor(block) { return !!block && block.boundingBox === 'block' && !TERRAIN_DANGERS.includes(block.name) && !gravityBlock(block.name); }
function supportedWalkingFloor(bot, p) {
  const floor = bot.blockAt(p.offset(0, -1, 0));
  if (safeFloor(floor)) return true;
  if (!floor || floor.boundingBox !== 'block' || !FALLING_FLOORS.has(floor.name)) return false;
  // Only walking uses this exception. Leaf removal keeps the stricter floor
  // guard. A single gravity block must rest on loaded non-gravity solid ground;
  // do not infer support through a sand column, empty space or an unloaded cell.
  if (!safeFloor(bot.blockAt(p.offset(0, -2, 0)))) return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [-1, 0]) {
    const neighbor = bot.blockAt(p.offset(dx, dy, dz));
    if (!neighbor || TERRAIN_DANGERS.includes(neighbor.name)) return false;
  }
  return true;
}
function safeStand(bot, p) { return supportedWalkingFloor(bot, p) && passable(bot.blockAt(p)) && passable(bot.blockAt(p.offset(0, 1, 0))); }
function singleBlockDescents(movements, bot) {
  if (expanded) return;
  // Installed getLandingBlock compares the start's FEET y with the landing
  // FLOOR block y. Its value 2 permits one real feet-to-feet step down.
  // Independently enforce that actual edge limit rather than trusting the name.
  movements.maxDropDown = 2;
  const nativeLanding = movements.getLandingBlock.bind(movements);
  movements.getLandingBlock = (...args) => {
    const landing = nativeLanding(...args);
    // Installed getLandingBlock can return its position-less unknown-cell
    // sentinel above a known floor; getMoveDropDown otherwise dereferences it.
    return landing?.position ? landing : null;
  };
  const nativeNeighbors = movements.getNeighbors.bind(movements);
  movements.getNeighbors = node => nativeNeighbors(node).filter(next => {
    const drop = node.y - next.y;
    if (drop <= 0) return true;
    if (movements.maxDropDown === 0 || drop > 1 || next.toBreak?.length || next.toPlace?.length) return false;
    const p = new Vec3(next.x, next.y, next.z);
    if (!safeFloor(bot.blockAt(p.offset(0, -1, 0))) || !passable(bot.blockAt(p)) || !passable(bot.blockAt(p.offset(0, 1, 0)))) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [-1, 0]) {
      const adjacent = bot.blockAt(p.offset(dx, dy, dz));
      if (!adjacent || TERRAIN_DANGERS.includes(adjacent.name)) return false;
    }
    return true;
  });
  return movements;
}
function threatDistance(p, enemies) { return enemies.length ? Math.min(...enemies.map(e => Math.hypot(p.x - e.position.x, p.y - e.position.y, p.z - e.position.z))) : Infinity; }
function safeThreatClearance(p, origin, enemies) {
  return enemies.every(enemy => {
    const current = Math.hypot(origin.x - enemy.position.x, origin.y - enemy.position.y, origin.z - enemy.position.z);
    const proposed = Math.hypot(p.x - enemy.position.x, p.y - enemy.position.y, p.z - enemy.position.z);
    // Keep away from blast range; if already inside, allow retreat out but
    // never a route that first approaches the creeper more closely.
    return proposed + 0.1 >= Math.min(current, enemy.name === 'creeper' ? 4 : 2.8);
  });
}
function routeEdge(origin, points) {
  const start = origin.floored(), next = points.find(p => !p.floored().equals(start));
  return next ? `${start.toString()}->${next.floored().toString()}` : null;
}
function trackRouteProgress(state, current, now) {
  const route = state.routeProgress;
  if (!route) return;
  while (route.index < route.points.length && current.distanceTo(route.points[route.index]) < 0.65) {
    route.index++; route.bestDistance = Infinity; state.lastProgressAt = now;
  }
  const point = route.points[route.index];
  if (point && current.distanceTo(point) < route.bestDistance - 0.2) { route.bestDistance = current.distanceTo(point); state.lastProgressAt = now; }
  state.routeEdge = routeEdge(current, route.points.slice(route.index));
}
function escapeCandidates(bot, enemies, failed = new Map(), now = Date.now(), recent = new Map()) {
  if (!bot.blockAt) return [];
  const feet = bot.entity.position.floored(), currentDistance = threatDistance(bot.entity.position, enemies), candidates = [];
  for (const radius of [1, 2, 4, 6]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, 1, -1]) {
    const p = feet.offset(dx * radius, dy, dz * radius), key = p.toString();
    if ((failed.get(key) || 0) > now || !safeStand(bot, p)) continue;
    const separation = threatDistance(p.offset(0.5, 0, 0.5), enemies);
    // Already touching a melee attacker: a one-block retreat cannot instantly
    // reach 2.8m. Permit strictly improving adjacent steps, under the same
    // per-enemy clearance and terrain guards. Do not extend this to explosives
    // or ranged threats, or to a longer route through unverified close cells.
    const meleeContact = radius === 1 && currentDistance < 2.8 && enemies.every(enemy =>
      bot.entity.position.distanceTo(enemy.position) >= 2.8 || MELEE_THREATS.has(enemy.name));
    const requiredSeparation = meleeContact ? currentDistance + 0.2 : Math.max(2.8, currentDistance - 0.25);
    if (separation < requiredSeparation || !safeThreatClearance(p.offset(0.5, 0, 0.5), bot.entity.position, enemies)) continue;
    const visit = recent.get(key), revisitPenalty = visit?.until > now ? Math.min(16, 8 + visit.visits * 2) : 0;
    // Soft preference: revisiting a safe site is still permitted if alternatives
    // cannot be reached. Never turn the only available retreat into a blacklist.
    candidates.push({ position: p, key, separation, revisitPenalty, contactRetreat: meleeContact && separation < 2.8, score: separation - bot.entity.position.distanceTo(p) * 0.12 - Math.abs(dy) * 0.4 - revisitPenalty });
  }
  // A distant melee threat can pin the bot against a wall when every exit
  // briefly reduces separation. Keep safety ownership and permit only one
  // supported, level cardinal step, never entering the normal 12m trigger.
  // This is considered only after all monotonic candidates were rejected.
  if (!candidates.length && currentDistance >= 14 && enemies.length && enemies.every(enemy => MELEE_THREATS.has(enemy.name) && !enemy.mounted && !enemy.vehicle)) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = feet.offset(dx, 0, dz), key = p.toString(), center = p.offset(0.5, 0, 0.5);
      if ((failed.get(key) || 0) > now || !safeStand(bot, p)) continue;
      const separation = threatDistance(center, enemies);
      if (separation < 12 || separation < currentDistance - 1 || !safeThreatClearance(center, bot.entity.position, enemies)) continue;
      const visit = recent.get(key), revisitPenalty = visit?.until > now ? Math.min(16, 8 + visit.visits * 2) : 0;
      candidates.push({ position: p, key, separation, revisitPenalty, distantDetour: true, score: separation - revisitPenalty });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}
function terrainProbe(bot) {
  if (!bot.blockAt || !bot.entity?.position) return [];
  const p = bot.entity.position.floored();
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ x: p.x + x, y: p.y, z: p.z + z,
    floor: bot.blockAt(p.offset(x, -1, z))?.name || 'unloaded', feet: bot.blockAt(p.offset(x, 0, z))?.name || 'unloaded', head: bot.blockAt(p.offset(x, 1, z))?.name || 'unloaded' }));
}
function escapeLeaf(bot, enemies, excluded = new Set()) {
  if (!bot.blockAt || !bot.canDigBlock) return null;
  const feet = bot.entity.position.floored(), currentDistance = threatDistance(bot.entity.position, enemies);
  const options = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const p = feet.offset(dx, 0, dz), below = bot.blockAt(p.offset(0, -1, 0));
    const blocks = [bot.blockAt(p), bot.blockAt(p.offset(0, 1, 0))];
    if (!safeFloor(below) || blocks.some(b => !b || (!passable(b) && !/_leaves$/.test(b.name)))) continue;
    const separation = threatDistance(p.offset(0.5, 0, 0.5), enemies);
    if (separation < currentDistance + 0.2) continue;
    const leaf = blocks.find(b => /_leaves$/.test(b.name) && b.diggable && bot.canDigBlock(b) && !excluded.has(b.position.toString()));
    if (!leaf) continue;
    if ([new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].some(d => {
      const b = bot.blockAt(leaf.position.plus(d)); return !b || TERRAIN_DANGERS.includes(b.name) || (d.y === 1 && gravityBlock(b.name));
    })) continue;
    options.push({ block: leaf, separation });
  }
  return options.sort((a, b) => b.separation - a.separation)[0]?.block || null;
}
class ReactiveAgent {
  constructor(bot, { interruptTask, taskBusy, log, intervalMs = 200, now = Date.now, calmMs = 2000, monotonic = () => performance.now(), fallbackBudgetMs = 60 }) {
    this.bot = bot; this.interruptTask = interruptTask; this.taskBusy = taskBusy; this.log = log;
    this.enabled = false; this.mode = 'idle'; this.epoch = 0; this.lastHit = 0; this.targetId = null; this.running = false;
    if (!Number.isInteger(bot[LIFECYCLE_EPOCH])) bot[LIFECYCLE_EPOCH] = 0;
    this.snapshot = { enabled: false, mode: 'idle', entities: [], lifecycleEpoch: bot[LIFECYCLE_EPOCH] };
    this.now = now; this.calmMs = calmMs; this.safeSince = null; this.intervalMs = intervalMs;
    // Reserve twenty milliseconds below the 80 ms planning ceiling for JS and
    // pathfinder bookkeeping. Synchronous code is cooperative, so measure and
    // expose overruns instead of claiming a hard real-time latency guarantee.
    this.monotonic = monotonic; this.fallbackBudgetMs = Math.max(10, Math.min(60, fallbackBudgetMs));
    this.timing = { tickMs: 0, maxTickMs: 0, sampleGapMs: null, maxSampleGapMs: 0, skippedTicks: 0, fallbackMs: 0, maxFallbackMs: 0, fallbackBudgetMs: this.fallbackBudgetMs, fallbackOverruns: 0, leafAwaitMs: 0, maxLeafAwaitMs: 0,
      logCallbackMs: 0, maxLogCallbackMs: 0, tickLogCallbackMs: 0, fallbackLogCallbackMs: 0, fallbackCandidateMs: 0, fallbackSearchMs: 0, maxSearchSliceMs: 0, fallbackDispatchMs: 0 };
    this.logTimeTotal = 0;
    this.log = data => {
      const started = this.monotonic();
      try { return log(data); }
      finally {
        const elapsed = this.monotonic() - started;
        this.logTimeTotal += elapsed;
        this.timing.logCallbackMs = Math.round(elapsed * 10) / 10;
        this.timing.maxLogCallbackMs = Math.max(this.timing.maxLogCallbackMs, this.timing.logCallbackMs);
        if (this.running) this.timing.tickLogCallbackMs += elapsed;
        // Never emit from this wrapper. The existing ten-second timing sample
        // reports completed callbacks, including its previous sample's write.
      }
    };
    this.lastTickStart = null; this.lastTimingLog = -Infinity;
    this.escape = null; this.failedEscapeSites = new Map(); this.lastBlockedLog = -Infinity;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.onDeath = () => { bot[LIFECYCLE_EPOCH]++; this.snapshot.lifecycleEpoch = bot[LIFECYCLE_EPOCH]; const enabled = this.enabled; this.interruptTask('death'); this.halt(); this.enabled = enabled; this.log({ event: 'death', safetyWillResume: enabled, lifecycleEpoch: bot[LIFECYCLE_EPOCH] }); };
    this.onEnd = () => this.halt();
    this.lastObservedHealth = bot.health;
    this.lastHurtEvidence = null;
    this.onEntityHurt = (entity, source) => {
      if (entity !== bot.entity) return;
      this.lastHurtEvidence = { observedAtMs: this.now(), lifecycleEpoch: bot[LIFECYCLE_EPOCH],
        source: source ? { id: Number.isFinite(source.id) ? source.id : null, name: typeof source.name === 'string' ? source.name.slice(0, 80) : 'unknown' } : 'unknown' };
      // Protocol hurt and health packets can arrive in either order.
      this.log({ event: 'reactive_hurt_evidence', ...this.lastHurtEvidence, ...injuryState(bot) });
    };
    this.onHealth = () => {
      const previousHealth = this.lastObservedHealth;
      this.lastObservedHealth = bot.health;
      if (Number.isFinite(previousHealth) && Number.isFinite(bot.health) && bot.health < previousHealth) {
        // Health packets do not identify an attacker. Preserve nearby loaded
        // evidence even on a fatal packet instead of inferring a damage source.
        const nearby = bot.entity?.position ? Object.values(bot.entities).filter(e => e !== bot.entity).map(e => entityView(bot, e)).filter(e => e.position && (HOSTILES.has(e.name) || /arrow|trident|fireball|potion/.test(e.name || '')))
          .map(e => ({ id: e.id, name: e.name, position: { x: e.position.x, y: e.position.y, z: e.position.z }, distance: bot.entity.position.distanceTo(e.position) }))
          .filter(e => e.distance <= 24).sort((a, b) => a.distance - b.distance) : [];
        const hurt = this.lastHurtEvidence, ageMs = hurt ? this.now() - hurt.observedAtMs : Infinity;
        const recentHurtEvidence = hurt && hurt.lifecycleEpoch === bot[LIFECYCLE_EPOCH] && ageMs >= 0 && ageMs <= 2000 ? { ...hurt, ageMs, correlation: 'recent_event_not_proven_cause_of_health_packet' } : null;
        this.log({ event: 'reactive_damage_observed', previousHealth, health: bot.health, food: bot.food, position: bot.entity?.position, enabled: this.enabled, mode: this.mode, targetId: this.targetId, lifecycleEpoch: bot[LIFECYCLE_EPOCH], nearby: nearby.slice(0, 24), nearbyCount: nearby.length, observationRadius: 24, damageSource: 'unknown', ...injuryState(bot), recentHurtEvidence, terrain: terrainProbe(bot) });
      }
      void this.tick();
    };
    this.onPathUpdate = result => {
      if (!this.enabled || this.mode !== 'flee' || !this.escape) return;
      this.escape.lastPathEvidence = { at:this.now(), status:String(result.status || 'unknown').slice(0,32),
        pathLength:Array.isArray(result.path)?result.path.length:0,
        nodes:(result.path || []).slice(0,6).map(p=>({x:p.x,y:p.y,z:p.z,parkour:!!p.parkour,toBreakCount:p.toBreak?.length||0,toPlaceCount:p.toPlace?.length||0})) };
      if (this.escape.strategy === 'short_safe_site' && ['success', 'partial'].includes(result.status) && result.path?.length) {
        const points = result.path.map(p => new Vec3(p.x, p.y, p.z));
        this.escape.routeProgress = { points, index: 0, bestDistance: bot.entity.position.distanceTo(points[0]) };
        this.escape.routeEdge = routeEdge(bot.entity.position, points);
      }
      if (!['noPath', 'timeout'].includes(result.status)) return;
      if (this.escape.failed) return;
      this.escape.failed = true; this.escape.noPathCount++;
      if (this.escape.site) this.failedEscapeSites.set(this.escape.site.toString(), this.now() + 12000);
      this.log({ event: 'escape_route_failed', strategy: this.escape.strategy, status: result.status, position: bot.entity?.position, health: bot.health, terrain: terrainProbe(bot) });
    };
    bot.on('death', this.onDeath);
    bot.on('end', this.onEnd);
    bot.on('health', this.onHealth);
    bot.on('entityHurt', this.onEntityHurt);
    bot.on('path_update', this.onPathUpdate);
  }
  enable() { this.enabled = true; this.epoch++; this.log({ event: 'defense_enabled' }); }
  halt() {
    this.leafNative?.cancel('controller halted'); this.leafNative?.cleanup();
    this.enabled = false; this.epoch++; this.mode = 'idle'; this.targetId = null; this.safeSince = null; this.escape = null; this.failedEscapeSites.clear();
    this.bot.pathfinder.setGoal(null); this.bot.clearControlStates();
    try { this.bot.stopDigging(); } catch {}
    this.snapshot = { ...this.snapshot, enabled: false, mode: 'idle', targetId: null };
  }
  logStallDiagnostics(now) {
    const state=this.escape;
    if(!state || now-(this.lastStallDiagnosticAt ?? -Infinity)<5000)return;
    this.lastStallDiagnosticAt=now;
    const bot=this.bot, vec=p=>p?{x:p.x,y:p.y,z:p.z}:null;
    const feet=bot.entity.position.floored(), terrain=[];
    for(const [dx,dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]])for(const dy of [-1,0,1,2]) {
      const p=feet.offset(dx,dy,dz),b=bot.blockAt(p);
      terrain.push({...vec(p),name:b?.name||'unknown',boundingBox:b?.boundingBox||null});
    }
    const path=state.lastPathEvidence;
    this.log({event:'escape_stall_diagnostics',observedAtMs:now,position:vec(bot.entity.position),
      onGround:bot.entity.onGround ?? null,velocity:vec(bot.entity.velocity),
      controls:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,typeof bot.controlState?.[k]==='boolean'?bot.controlState[k]:null])),
      target:vec(state.site),routeEdge:state.routeEdge,elapsedMs:now-state.startedAt,stalledMs:now-state.lastProgressAt,
      lastPathUpdate:path?{...path,ageMs:now-path.at,evidence:'last_event_not_live_remaining_path'}:null,
      trackedRemainingNodes:(state.routeProgress?.points||[]).slice(state.routeProgress?.index||0,(state.routeProgress?.index||0)+6).map(vec),
      terrain,terrainReads:20});
  }
  dispose() { this.halt(); clearInterval(this.timer); this.bot.removeListener('death', this.onDeath); this.bot.removeListener('end', this.onEnd); this.bot.removeListener('health', this.onHealth); this.bot.removeListener('entityHurt', this.onEntityHurt); this.bot.removeListener('path_update', this.onPathUpdate); }
  async clearLeaf(leaf, epoch) {
    const bot = this.bot, startingHealth = bot.health, started = this.monotonic();
    let watch, timeout;
    const pending = {
      reason: null,
      cancel: reason => {
        if (!pending.reason) { pending.reason = reason; this.log({ event: 'escape_leaf_cancel_requested', reason, health: bot.health, position: bot.entity?.position }); }
        try { bot.stopDigging(); } catch {}
      },
      cleanup: () => { clearInterval(watch); clearTimeout(timeout); }
    };
    this.leafNative = pending; bot[LEAF_NATIVE] = pending;
    const guard = () => {
      if (!this.enabled || this.epoch !== epoch || this.taskBusy()) return pending.cancel('controller changed or task busy');
      if (bot.health < startingHealth) return pending.cancel('health decreased during leaf removal');
      if (Object.values(bot.entities).map(e => entityView(bot, e)).some(e => HOSTILES.has(e.name) && e.position && bot.entity?.position.distanceTo(e.position) <= 3.5)) return pending.cancel('hostile approached within 3.5 blocks during leaf removal');
      if (pending.reason) pending.cancel(pending.reason);
    };
    try {
      guard();
      if (pending.reason) throw new Error(pending.reason);
      watch = setInterval(guard, 50);
      timeout = setTimeout(() => { pending.cancel('Escape leaf timeout'); clearInterval(watch); }, 1200);
      // Installed dig first awaits lookAt, then establishes targetDigBlock.
      // A forced look avoids its smoothing wait. Cancellation is still only
      // a request: never release this per-bot barrier before native settlement.
      await bot.dig(leaf, true);
      if (pending.reason) throw new Error(pending.reason);
    } finally {
      pending.cleanup();
      this.timing.leafAwaitMs = Math.round((this.monotonic() - started) * 10) / 10;
      this.timing.maxLeafAwaitMs = Math.max(this.timing.maxLeafAwaitMs, this.timing.leafAwaitMs);
      this.log({ event: 'escape_leaf_native_settled', leafAwaitMs: this.timing.leafAwaitMs, cancellationRequested: !!pending.reason, reason: pending.reason });
      if (bot[LEAF_NATIVE] === pending) delete bot[LEAF_NATIVE];
      if (this.leafNative === pending) this.leafNative = null;
    }
  }
  async counterattack(target, epoch) {
    if (target?.vehicle) return false; // Mounted hit geometry is not established; retreat only.
    const bot = this.bot;
    if (!target || !HOSTILES.has(target.name) || bot.entity.position.distanceTo(target.position) > 2.8 || this.now() - this.lastHit < 750) return false;
    const weapon = ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'diamond_axe', 'iron_axe', 'stone_axe'].map(name => bot.inventory.items().find(i => i.name === name)).find(Boolean);
    if (!weapon || bot.health <= 6 || !MELEE_THREATS.has(target.name)) return false;
    if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand');
    if (!this.enabled || this.epoch !== epoch || this.taskBusy()) return false;
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0), point = target.position.offset(0, Math.min(target.height || 1, 1.2), 0), ray = point.minus(eye);
    if (!bot.world?.raycast || ray.norm() < 0.01 || bot.world.raycast(eye, ray.unit(), ray.norm())) return false;
    await bot.lookAt(point, true);
    if (!this.enabled || this.epoch !== epoch || this.taskBusy() || !bot.entities[target.id] || bot.health <= 0 || bot.entity.position.distanceTo(target.position) > 2.8) return false;
    bot.attack(target); this.lastHit = this.now();
    this.log({ event: 'trapped_counterattack', target: target.name, targetId: target.id, health: bot.health, killVerified: false });
    return true;
  }
  async flee(target, entities, epoch) {
    const bot = this.bot, now = this.now(), enemies = entities.filter(e => HOSTILES.has(e.name));
    if (!this.escape) {
      this.escape = { strategy: 'long_retreat', failed: false, noPathCount: 0, leavesCleared: 0, leafAttempts: 0, failedLeaves: new Set(), triedSites: 0, candidateCursor: 0, startedAt: now, lastProgressAt: now, lastPosition: bot.entity.position.clone(), site: null, nextPlanAt: 0,
        recentSites: new Map([[bot.entity.position.floored().toString(), { until: now + 8000, visits: 1 }]]), stalledEdges: new Map(), routeProgress: null, routeEdge: null, bestSeparation: threatDistance(bot.entity.position, enemies), lastSeparationProgressAt: now, lastSeparationLog: now };
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(target, 24)), true);
      return;
    }
    const state = this.escape;
    if (state.strategy === 'short_safe_site') trackRouteProgress(state, bot.entity.position, now);
    else if (Math.hypot(bot.entity.position.x - state.lastPosition.x, bot.entity.position.z - state.lastPosition.z) > 0.5) { state.lastPosition = bot.entity.position.clone(); state.lastProgressAt = now; }
    const separation = threatDistance(bot.entity.position, enemies);
    if (separation > state.bestSeparation + 0.75) { state.bestSeparation = separation; state.lastSeparationProgressAt = now; }
    if (now - state.lastSeparationProgressAt >= 5000 && now - state.lastSeparationLog >= 5000) {
      state.lastSeparationLog = now;
      this.logStallDiagnostics(now);
      this.log({ event: 'escape_no_separation_progress', position: bot.entity.position, health: bot.health, separation, bestSeparation: state.bestSeparation, durationMs: now - state.lastSeparationProgressAt, recentSites: state.recentSites.size, escapeVerified: false });
    }
    if (!state.failed && now - state.lastProgressAt > 1600) {
      this.logStallDiagnostics(now);
      state.failed = true;
      if (state.routeEdge) state.stalledEdges.set(state.routeEdge, now + 6000);
      this.log({ event: 'escape_no_progress', strategy: state.strategy, position: bot.entity.position, health: bot.health, routeEdge: state.routeEdge, waypointIndex: state.routeProgress?.index, waypointDistance: state.routeProgress?.points[state.routeProgress.index]?.distanceTo(bot.entity.position), stalledMs: now - state.lastProgressAt, terrain: terrainProbe(bot) });
    }
    if (state.site && bot.entity.onGround !== false && bot.entity.position.distanceTo(state.site.offset(0.5, 0, 0.5)) < 0.65) {
      const key = state.site.toString(), previous = state.recentSites.get(key);
      state.recentSites.set(key, { until: now + 8000, visits: (previous?.visits || 0) + 1 });
      state.failed = true; state.site = null;
      // A successful one-block step must not idle for the failed-plan backoff.
      state.nextPlanAt = now;
    }
    if (!state.failed && bot.pathfinder.isMoving()) {
      // A contact hit can create space without cancelling the retreat goal.
      // Never turn around and pursue a target outside melee reach.
      await this.counterattack(target, epoch);
      return;
    }
    // A computed/queued route gets a short chance to begin; do not reset it at
    // every 200 ms sample merely because isMoving() is temporarily false.
    if (!state.failed && now - state.startedAt < 1600) return;
    if (now < state.nextPlanAt) { await this.counterattack(target, epoch); return; }
    const fallbackStarted = this.monotonic(), fallbackDeadline = fallbackStarted + this.fallbackBudgetMs, fallbackLogStart = this.logTimeTotal;
    this.timing.fallbackCandidateMs = 0; this.timing.fallbackSearchMs = 0; this.timing.fallbackDispatchMs = 0;
    const finishPlanning = () => {
      const elapsed = this.monotonic() - fallbackStarted;
      this.timing.fallbackMs = Math.round(elapsed * 10) / 10;
      this.timing.maxFallbackMs = Math.max(this.timing.maxFallbackMs, this.timing.fallbackMs);
      this.timing.fallbackLogCallbackMs = Math.round((this.logTimeTotal - fallbackLogStart) * 10) / 10;
      if (elapsed > this.fallbackBudgetMs) this.timing.fallbackOverruns++;
    };
    bot.pathfinder.setGoal(null); bot.clearControlStates();
    state.nextPlanAt = now + 800;
    for (const [key, expiry] of this.failedEscapeSites) if (expiry <= now) this.failedEscapeSites.delete(key);
    for (const [key, visit] of state.recentSites) if (visit.until <= now) state.recentSites.delete(key);
    for (const [key, expiry] of state.stalledEdges) if (expiry <= now) state.stalledEdges.delete(key);
    const candidateStarted = this.monotonic();
    const candidates = escapeCandidates(bot, enemies, this.failedEscapeSites, now, state.recentSites);
    this.timing.fallbackCandidateMs = Math.round((this.monotonic() - candidateStarted) * 10) / 10;
    const movements = bot.pathfinder.movements || safetyMovements(bot);
    const startCursor = state.candidateCursor % Math.max(1, candidates.length);
    let examined = 0, deferredRoute = null, unfinishedSearches = 0;
    const issueRoute = ({ candidate, goal, result, edge, directNeighbor = false }, reusedStalledEdge = false) => {
      const points = result.path.map(p => new Vec3(p.x + 0.5, p.y, p.z + 0.5));
      state.lastPathEvidence = null;
      state.strategy = 'short_safe_site'; state.site = candidate.position; state.failed = false; state.startedAt = now; state.lastProgressAt = now; state.triedSites++;
      // Reusing a stalled prefix is a provisional fallback, not proof that all
      // candidates were exhausted. Keep the bounded search cursor so the next
      // stalled attempt examines later destinations instead of the same four.
      if (!reusedStalledEdge) state.candidateCursor = 0;
      state.routeProgress = { points, index: 0, bestDistance: bot.entity.position.distanceTo(points[0]) }; state.routeEdge = edge;
      const dispatchStarted = this.monotonic();
      bot.pathfinder.setMovements(movements); bot.pathfinder.setGoal(goal);
      this.timing.fallbackDispatchMs += Math.round((this.monotonic() - dispatchStarted) * 10) / 10;
      this.log({ event: 'escape_short_route', position: bot.entity.position, destination: candidate.position, health: bot.health, currentSeparation: threatDistance(bot.entity.position, enemies), separation: candidate.separation, revisitPenalty: candidate.revisitPenalty, separationStalledMs: now - state.lastSeparationProgressAt, minPathClearance: Math.min(...points.map(p => threatDistance(p, enemies))), pathLength: result.path.length, routeEdge: edge, firstWaypoint: points[0], reusedStalledEdge, candidatesExamined: examined, candidateCount: candidates.length, nextCandidateCursor: state.candidateCursor, directNeighbor });
    };
    // Rotation continues after the budget is exhausted, instead of repeatedly
    // spending every tick on the same expensive top-ranked candidates.
    for (let i = 0; i < Math.min(candidates.length, 4); i++) {
      const remaining = fallbackDeadline - this.monotonic();
      if (remaining < 20 || !bot.pathfinder.getPathFromTo) break;
      const candidate = candidates[(startCursor + i) % candidates.length];
      examined++; state.candidateCursor = startCursor + examined;
      const goal = new goals.GoalBlock(candidate.position.x, candidate.position.y, candidate.position.z);
      // Pathfinder's searchRadius limits accumulated *cost*, not geometric
      // distance. A small value plus hostile penalties rejects every first
      // step when cornered. Bound time and returned path length instead.
      const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: Math.min(12, remaining - 8), tickTimeout: Math.min(6, remaining - 8), searchRadius: -1, optimizePath: false });
      const nextSearch = () => {
        const started = this.monotonic();
        try { return generator.next().value?.result; }
        finally {
          const elapsed = Math.round((this.monotonic() - started) * 10) / 10;
          this.timing.fallbackSearchMs += elapsed;
          this.timing.maxSearchSliceMs = Math.max(this.timing.maxSearchSliceMs, elapsed);
        }
      };
      let result;
      try {
        result = nextSearch();
        if (result?.status === 'partial' && fallbackDeadline - this.monotonic() >= 12) result = nextSearch();
      } finally { generator.return?.(); }
      if (result?.status !== 'success') {
        // A bounded search that runs out of time says nothing about whether
        // the destination is reachable. Preserve rotation but do not exclude
        // that site for twelve seconds while a hostile closes the distance.
        if (result?.status === 'partial' || result?.status === 'timeout') unfinishedSearches++;
        if (result?.status === 'noPath') this.failedEscapeSites.set(candidate.key, now + 12000);
        continue;
      }
      if (!result.path?.length || result.path.length > 18 || result.path.some(p => p.toBreak?.length || p.toPlace?.length || !safeStand(bot, new Vec3(p.x, p.y, p.z)) || !safeThreatClearance(new Vec3(p.x + 0.5, p.y, p.z + 0.5), bot.entity.position, enemies))) { this.failedEscapeSites.set(candidate.key, now + 12000); continue; }
      if ((candidate.contactRetreat || candidate.distantDetour) && result.path.length !== 1) continue;
      if (!this.enabled || this.epoch !== epoch || this.taskBusy()) { finishPlanning(); return; }
      const edge = routeEdge(bot.entity.position, result.path.map(p => new Vec3(p.x, p.y, p.z)));
      const route = { candidate, goal, result, edge };
      if ((state.stalledEdges.get(edge) || 0) > now) { deferredRoute ||= route; continue; }
      issueRoute(route);
      finishPlanning();
      return;
    }
    // An unfinished search to distant safe sites is not proof that no safe
    // first step exists. Use the installed movement generator for ONE adjacent
    // edge, under identical terrain and hostile-clearance checks. This avoids
    // standing through the 800ms retry backoff on open ground while pursued.
    if (unfinishedSearches && fallbackDeadline - this.monotonic() >= 8 && movements.getNeighbors) {
      const origin = bot.entity.position.floored();
      const started = this.monotonic();
      const neighbors = movements.getNeighbors(new Move(origin.x, origin.y, origin.z, 0, 0));
      this.timing.fallbackSearchMs += this.monotonic() - started;
      const steps = neighbors.map(node => ({ node, candidate: candidates.find(c => c.position.x === node.x && c.position.y === node.y && c.position.z === node.z) }))
        .filter(({ node, candidate }) => candidate && !node.parkour && !node.toBreak?.length && !node.toPlace?.length && safeStand(bot, candidate.position) && safeThreatClearance(candidate.position.offset(0.5, 0, 0.5), bot.entity.position, enemies))
        .sort((a, b) => b.candidate.score - a.candidate.score);
      const step = steps.find(({ node }) => (state.stalledEdges.get(routeEdge(bot.entity.position, [new Vec3(node.x, node.y, node.z)])) || 0) <= now);
      if (step && this.enabled && this.epoch === epoch && !this.taskBusy() && this.monotonic() < fallbackDeadline) {
        const { node, candidate } = step;
        issueRoute({ candidate, goal: new goals.GoalBlock(node.x, node.y, node.z), result: { path: [node] }, edge: routeEdge(bot.entity.position, [new Vec3(node.x, node.y, node.z)]), directNeighbor: true });
        finishPlanning(); return;
      }
    }
    const canClearLeaf = state.leavesCleared < 2 && state.leafAttempts < 3 && (!enemies.length || enemies[0].distance > 3.5) && escapeLeaf(bot, enemies, state.failedLeaves);
    if (deferredRoute && !canClearLeaf) { issueRoute(deferredRoute, true); finishPlanning(); return; }
    finishPlanning();
    const close = enemies.find(e => e.distance <= 2.8);
    if (close) { state.strategy = 'trapped_counterattack'; await this.counterattack(bot.entities[close.id], epoch); }
    else if (state.leavesCleared < 2 && state.leafAttempts < 3 && (!enemies.length || enemies[0].distance > 3.5)) {
      const leaf = canClearLeaf;
      if (leaf) {
        state.strategy = 'clear_escape_leaf'; state.leafAttempts++;
        try {
          await this.clearLeaf(leaf, epoch);
          if (!this.enabled || this.epoch !== epoch || this.taskBusy()) return;
          if (bot.blockAt(leaf.position)?.name === leaf.name) throw new Error('Escape leaf removal not confirmed');
          state.leavesCleared++; state.failed = true; state.nextPlanAt = this.now(); this.failedEscapeSites.clear();
          this.log({ event: 'escape_leaf_removed', block: leaf.name, position: leaf.position, verified: true, leavesCleared: state.leavesCleared });
          return;
        } catch (error) { state.failedLeaves.add(leaf.position.toString()); this.log({ event: 'escape_leaf_failed', error: error.message }); }
      }
    }
    state.failed = true;
    if (this.now() - this.lastBlockedLog >= 5000) {
      this.lastBlockedLog = this.now();
      this.log({ event: 'escape_blocked', position: bot.entity.position, health: bot.health, noPathCount: state.noPathCount, triedSites: state.triedSites, leavesCleared: state.leavesCleared, terrain: terrainProbe(bot), threats: enemies.slice(0, 4) });
    }
  }
  async tick() {
    if (this.running) { this.timing.skippedTicks++; return; }
    if (this.bot[LEAF_NATIVE]) { this.timing.skippedTicks++; return; }
    if (!this.bot.entity || this.bot.health <= 0) return;
    const tickStarted = this.monotonic();
    if (this.lastTickStart !== null) { this.timing.sampleGapMs = Math.round((tickStarted - this.lastTickStart) * 10) / 10; this.timing.maxSampleGapMs = Math.max(this.timing.maxSampleGapMs, this.timing.sampleGapMs); }
    this.lastTickStart = tickStarted;
    this.running = true;
    this.timing.leafAwaitMs = 0; this.timing.tickLogCallbackMs = 0;
    const epoch = this.epoch, bot = this.bot;
    try {
      const entities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position).map(e => entityView(bot, e)).map(e => ({ id: e.id, name: e.name || e.type, mounted: !!e.vehicle, position: { x: e.position.x, y: e.position.y, z: e.position.z }, distance: bot.entity.position.distanceTo(e.position) })).filter(e => e.distance <= 24).sort((a, b) => a.distance - b.distance);
      const armed = bot.inventory.items().some(i => /_sword$/.test(i.name));
      for (const entity of entities) entity.occluded = occludedThreat(bot, entity);
      const reflexEntities = entities.filter(entity => !entity.occluded);
      let next = decide({ health: bot.health, entities: reflexEntities, enabled: this.enabled, armed, previousMode: this.mode });
      if (this.enabled && this.mode === 'flee' && next.action === 'idle') {
        if (this.safeSince === null) this.safeSince = this.now();
        if (this.now() - this.safeSince < this.calmMs) next = { action: 'flee', target: entities.find(e => e.id === this.targetId), calming: true };
      } else this.safeSince = null;
      this.snapshot = { updatedAt: new Date(this.now()).toISOString(), sampleIntervalMs: this.intervalMs, lifecycleEpoch: bot[LIFECYCLE_EPOCH], dimension: bot.game?.dimension, timeOfDay: bot.time?.timeOfDay, health: bot.health, food: bot.food, armed, enabled: this.enabled, mode: next.action, calming: !!next.calming, targetId: next.target?.id ?? null, entities: entities.slice(0, 30), escape: this.escape ? { strategy: this.escape.strategy, noPathCount: this.escape.noPathCount, triedSites: this.escape.triedSites, leavesCleared: this.escape.leavesCleared, blocked: this.escape.failed, site: this.escape.site } : null };
      if (next.action === 'idle') {
        if (this.mode !== 'idle') { bot.pathfinder.setGoal(null); bot.clearControlStates(); this.log({ event: 'threat_cleared', previousTarget: this.targetId, killVerified: false }); }
        this.mode = 'idle'; this.targetId = null; this.safeSince = null; this.escape = null; this.failedEscapeSites.clear(); return;
      }
      if (this.taskBusy()) { this.interruptTask('hostile nearby'); this.log({ event: 'task_preempted', priority: next.action, target: next.target }); return; }
      const target = bot.entities[next.target?.id];
      if (!target || !HOSTILES.has(target.name)) return;
      const changed = this.mode !== next.action || this.targetId !== target.id;
      if (changed) {
        // setMovements resets Mineflayer's active path and control states.
        // The nearest hostile may change every tick; its ID must not cancel
        // an already verified retreat. These movements inspect all live foes.
        if (this.mode !== next.action) bot.pathfinder.setMovements(safetyMovements(bot));
        this.mode = next.action; this.targetId = target.id;
        this.log({ event: 'priority_changed', mode: this.mode, target: { id: target.id, name: target.name }, health: bot.health });
      }
      if (next.action === 'flee') {
        await this.flee(entityView(bot, target), reflexEntities, epoch);
        return;
      }
      const weapons = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'];
      const weapon = weapons.map(name => bot.inventory.items().find(i => i.name === name)).find(Boolean);
      if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand');
      if (!this.enabled || epoch !== this.epoch || this.taskBusy() || bot.health <= 12) return;
      const current = bot.entities[target.id];
      if (!current || !HOSTILES.has(current.name)) return;
      if (bot.entity.position.distanceTo(current.position) > 2.8) {
        // Reflex defense may counterattack at arm's length; it never pursues.
        bot.pathfinder.setGoal(null); bot.clearControlStates();
        return;
      }
      bot.pathfinder.setGoal(null); bot.clearControlStates();
      const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
      const sight = current.position.offset(0, Math.min(current.height || 1, 1.4), 0).minus(eye);
      // Mineflayer exposes world.raycast, not canSeeEntity. Fail closed if unavailable.
      if (!bot.world?.raycast || bot.world.raycast(eye, sight.unit(), sight.norm())) return;
      await bot.lookAt(current.position.offset(0, Math.min(current.height || 1, 1.4), 0), true);
      if (!this.enabled || epoch !== this.epoch || !bot.entities[current.id] || bot.entity.position.distanceTo(current.position) > 3 || bot.health <= 12) return;
      if (Date.now() - this.lastHit >= 650) { bot.attack(current); this.lastHit = Date.now(); this.log({ event: 'attack_sent', targetId: current.id, target: current.name, health: bot.health }); }
    } catch (error) {
      this.log({ event: 'reactive_error', error: error.message });
      bot.pathfinder.setGoal(null); bot.clearControlStates();
    } finally {
      this.running = false;
      this.timing.tickMs = Math.round((this.monotonic() - tickStarted) * 10) / 10;
      this.timing.maxTickMs = Math.max(this.timing.maxTickMs, this.timing.tickMs);
      this.snapshot.timing = { ...this.timing, intervalIsSchedulingTarget: true };
      if (this.timing.tickMs > 80 || this.now() - this.lastTimingLog >= 10000) {
        this.lastTimingLog = this.now();
        this.log({ event: 'reactive_timing', configuredIntervalMs: this.intervalMs, ...this.timing, intervalIsSchedulingTarget: true });
        // A timing record cannot contain the duration of its own write. Retain
        // it in the live snapshot and cumulative maximum for the next sample.
        this.timing.tickLogCallbackMs += this.timing.logCallbackMs;
        this.timing.tickMs = Math.round((this.monotonic() - tickStarted) * 10) / 10;
        this.timing.maxTickMs = Math.max(this.timing.maxTickMs, this.timing.tickMs);
        this.snapshot.timing = { ...this.timing, intervalIsSchedulingTarget: true };
      }
    }
  }
}
module.exports = { ReactiveAgent, decide, HOSTILES, RANGED_THREATS, effectivePosition, entityView, occludedThreat, safetyMovements, singleBlockDescents, escapeCandidates, escapeLeaf, terrainProbe, safeThreatClearance, routeEdge, trackRouteProgress };
