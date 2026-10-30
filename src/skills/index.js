'use strict';
const path = require('node:path');
const { SkillRegistry } = require('./registry');
const { SkillRuntime } = require('./runtime');
const { registerBuiltins } = require('./providers');

function createSkillHost({ providers = [], enabled = ['*'], directory = path.resolve(__dirname, '../../runtime/skills/runs'), ...options } = {}) {
  const registry = new SkillRegistry();
  registerBuiltins(registry, options);
  for (const provider of providers) provider.register(registry);
  registry.seal(enabled);
  return new SkillRuntime({ registry, directory, maxRuntimeMs: options.maxRuntimeMs });
}
module.exports = { createSkillHost, SkillRegistry, SkillRuntime };
