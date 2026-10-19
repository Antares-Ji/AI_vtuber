'use strict';
const assert = require('node:assert/strict');
const registry = require('prismarine-registry')('1.21.1');
const { craftingOptions } = require('../src/minecraft/survival-skills');
const { compactObservation } = require('../src/minecraft/survival-planner');
const recipe = (output, ingredients) => ({ result: { id: registry.itemsByName[output].id, count: 1 }, delta: Object.entries(ingredients).map(([name,count]) => ({id:registry.itemsByName[name].id,count:-count})) });
function fixture(hasBed = false) {
  const stock = [{name:'oak_planks',count:38},{name:'stick',count:4},{name:'crafting_table',count:2}, ...(hasBed ? [{name:'black_bed',count:1}] : [])];
  const recipes = {
    stone_pickaxe: [recipe('stone_pickaxe',{cobbled_deepslate:3,stick:2}),recipe('stone_pickaxe',{cobbled_deepslate:3,stick:2}),recipe('stone_pickaxe',{blackstone:3,stick:2}),recipe('stone_pickaxe',{cobblestone:3,stick:2})],
    furnace: [recipe('furnace',{cobbled_deepslate:8}),recipe('furnace',{blackstone:8}),recipe('furnace',{cobblestone:8})],
    white_bed: [recipe('white_bed',{black_bed:1,white_dye:1}),recipe('white_bed',{white_wool:3,oak_planks:3})]
  };
  return {registry,inventory:{items:()=>stock},recipesFor(id){return id===registry.itemsByName.wooden_pickaxe.id ? [{result:{count:1},requiresTable:true}] : [];},recipesAll(id){return recipes[registry.items[id].name] || [];}};
}
const noBed=craftingOptions(fixture());
assert(noBed.craftable.some(i=>i.item==='wooden_pickaxe'));
for (const item of ['stone_pickaxe','furnace']) {
  const hints=noBed.recipeHints.filter(h=>h.item===item);
  assert.equal(hints.length,2,'duplicate missing requirements are collapsed');
  assert.deepEqual(new Set(hints.flatMap(h=>h.missing.map(m=>m.name))),new Set(['cobblestone','cobbled_deepslate']));
}
assert.deepEqual(noBed.recipeHints.filter(h=>h.item==='bed').map(h=>h.missing),[[{name:'white_wool',count:3}]],'no bed inventory: base construction, no circular bed ingredient');
const withBed=craftingOptions(fixture(true));
assert.deepEqual(withBed.recipeHints.find(h=>h.item==='bed').missing,[{name:'white_dye',count:1}],'owned bed makes recolor a genuine alternative');
assert(withBed.recipeHints.some(h=>h.item==='bed'&&h.missing.some(m=>m.name==='white_wool')));
assert(noBed.recipeHints.length<=16);
assert.deepEqual(compactObservation(noBed).recipeHints,noBed.recipeHints,'existing planner preserves repeated-item alternatives');
console.log('Recipe hints: bounded deduplicated real ingredient alternatives; base bed versus owned-bed recolor; craftable wooden pickaxe and planner preservation passed.');
