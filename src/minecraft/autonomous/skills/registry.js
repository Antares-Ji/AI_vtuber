'use strict';
// Skill registry: named, deterministic multi-step abilities the planner can invoke.
// Each skill = { desc, params, run(bot, args, ctx) -> { ok, observation } }.
// The LLM picks a skill by name + args; it never micromanages individual game ticks.
const byName = new Map();
const pov = require('../pov');

// What to show on the POV HUD while this skill runs. Cheap, derived from the call arguments.
function describe(name, a) {
  a = a || {};
  if (name === 'mine' && a.names && a.names.length) return { label: '采集 ' + String(a.names[0]).replace(/_/g, ' '), total: a.count || 8 };
  if (name === 'chop_trees') return { label: '砍树', total: a.count || 12 };
  if (name === 'craft' && a.item) return { label: '合成 ' + String(a.item).replace(/_/g, ' '), total: a.count || 1 };
  if (name === 'smelt' && a.item) return { label: '熔炼 ' + String(a.item).replace(/_/g, ' '), total: a.count || 4 };
  if (name === 'goto' || name === 'roam' || name === 'walk_to') return { label: '赶路', total: 0 };
  return { label: '', total: 0 };
}

function define(name, def) {
  if (byName.has(name)) throw new Error('duplicate skill ' + name);
  const raw = def.run;
  if (typeof raw === 'function') {
    def.run = async function (bot, args, ctx) {
      const d = describe(name, args);
      pov.begin(name, d.label, d.total);
      try {
        return await raw.call(this, bot, args, ctx);
      } finally {
        pov.end();
      }
    };
  }
  byName.set(name, def);
}

function get(name) { return byName.get(name); }

function index() {
  const lines = [];
  for (const [name, def] of byName) {
    const p = def.params ? JSON.stringify(def.params) : '{}';
    lines.push(`- ${name}(${p}): ${def.desc}`);
  }
  return lines.join('\n');
}

function names() { return [...byName.keys()]; }

module.exports = { define, get, index, names, byName };
