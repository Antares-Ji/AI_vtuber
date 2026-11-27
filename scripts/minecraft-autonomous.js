'use strict';
// Launcher for the strict, assist-free autonomous Minecraft speedrun bot integrated with AI_vtuber.
// Identity and anti-cheat switches are pinned BEFORE config.js loads .env/.env.local.
process.env.MC_PORT = process.env.MC_PORT || '25568';
process.env.MC_USERNAME = process.env.MC_USERNAME || 'SuiGeBot';
process.env.MC_ASSIST = process.env.MC_ASSIST === undefined ? '0' : process.env.MC_ASSIST;
process.env.MC_WORLD_RULES = process.env.MC_WORLD_RULES === undefined ? '0' : process.env.MC_WORLD_RULES;
process.env.MC_DAY_LOCK = process.env.MC_DAY_LOCK === undefined ? '0' : process.env.MC_DAY_LOCK;
process.env.MC_PERMA_FED = process.env.MC_PERMA_FED === undefined ? '0' : process.env.MC_PERMA_FED;
process.env.MC_OP_RESUPPLY = process.env.MC_OP_RESUPPLY === undefined ? '0' : process.env.MC_OP_RESUPPLY;
process.env.MC_RESCUE_TP = '';
process.env.MC_HOST_BRIDGE = process.env.MC_HOST_BRIDGE === undefined ? '1' : process.env.MC_HOST_BRIDGE;
process.env.MC_TALK = process.env.MC_TALK || 'host';
process.env.MC_MOVE_DEBUG = process.env.MC_MOVE_DEBUG || '1';
require('../src/minecraft/autonomous/index.js');
