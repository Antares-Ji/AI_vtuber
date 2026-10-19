'use strict';
const { SURVIVAL_ACTION_SCHEMA, CRAFT_ITEMS, SMELT_OUTPUT, RESOURCES, DIRECTIONS } = require('../../src/minecraft/survival-skills');
const { SURVIVAL_SYSTEM } = require('../../src/minecraft/survival-planner');
process.stdout.write(JSON.stringify({ schema: SURVIVAL_ACTION_SCHEMA, craftItems: CRAFT_ITEMS, smeltItems: Object.keys(SMELT_OUTPUT), resources: Object.keys(RESOURCES), directions: Object.keys(DIRECTIONS), system: SURVIVAL_SYSTEM }));
