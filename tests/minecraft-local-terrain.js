const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { localTerrainDiagnostics } = require('../src/minecraft/survival-skills');
const { compactObservation } = require('../src/minecraft/survival-planner');
let reads = 0;
const bot = { entity: { position: new Vec3(59.5, 114, 86.5), onGround: true }, pathfinder: { movements: { canDig: false, maxDropDown: 1, allowParkour: false, allowSprinting: true } }, blockAt(p) {
  reads++; assert(Math.abs(p.x - 59) <= 2 && Math.abs(p.z - 86) <= 2 && p.y >= 110 && p.y <= 116);
  if (p.x === 57 && p.z === 84) return null;
  return { name: p.y < 112 ? 'stone' : 'air', boundingBox: p.y < 112 ? 'block' : 'empty', shapes: p.y < 112 ? [[0,0,0,1,1,1]] : [] };
} };
const diagnostic = localTerrainDiagnostics(bot);
assert.equal(reads, 175); assert.equal(diagnostic.reads, 175);
assert.equal(diagnostic.blocks.filter(x => x.name === 'unloaded').length, 7);
assert(diagnostic.blocks.every(x => x.name !== 'air'));
assert.equal(diagnostic.movements.maxDropDown, 1);
assert.equal(compactObservation({ terrainDiagnostics: diagnostic }).terrainDiagnostics, undefined, 'diagnostics never add model input noise');
assert.equal(localTerrainDiagnostics({}), null);
console.log('Local terrain diagnostics: fixed loaded-local reads, explicit unknown cells, no path/action mutation, excluded from model input.');
