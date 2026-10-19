'use strict';
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { HarvestGoal } = require('../src/minecraft/survival-skills');
function fixture({ floor = 64, occluded = false, unknown = false } = {}) {
  const target = new Vec3(10, 68, 0), seen = { rays: 0 };
  const bot = { entity: { eyeHeight: 1.62 }, blockAt(p) { if (unknown) return null; return { name: p.y < floor ? 'stone' : 'air', boundingBox: p.y < floor ? 'block' : 'empty', position: p }; }, world: { raycast() { seen.rays++; return occluded ? { position: new Vec3(9, 68, 0) } : { position: target }; } } };
  return { goal: new HarvestGoal({ position: target }, bot), seen };
}
const high = fixture({ floor: 60 }); assert.equal(high.goal.prepare().length, 0, 'exposed canopy without a stand in reach is rejected before search');
const occluded = fixture({ occluded: true }); assert.equal(occluded.goal.prepare().length, 0, 'support alone cannot overcome leaf obstruction');
const unknown = fixture({ unknown: true }); assert.equal(unknown.goal.prepare().length, 0, 'unknown terrain is not a standing endpoint'); assert.equal(unknown.seen.rays, 0);
const clear = fixture(); const ends = clear.goal.prepare(); assert(ends.length > 0); assert(ends.every(p => p.y === 64)); assert(ends.every(p => clear.goal.isEnd(p)));
assert.equal(clear.goal.isEnd(new Vec3(10, 68, 0)), false, 'airborne target cell is not a standing endpoint');
assert.equal(clear.goal.heuristic(ends[0]), 0);
const rays = clear.seen.rays; for (let i = 0; i < 1000; i++) clear.goal.isEnd(new Vec3(i, 80, 0)); assert.equal(clear.seen.rays, rays, 'non-endpoint A* nodes do not cast rays');
console.log('Harvest endpoint checks passed: canopy/no support, obstruction, unknown terrain rejected; finite grounded endpoints and no repeated raycasts for search nodes. Simulated only.');
