'use strict';
// Fresh random-seed Paper 1.21.1 server launcher for AI_vtuber's autonomous Minecraft run.
// Enforces non-OP bot (MC_NO_SELF_OP=1) + operator-applied keepInventory=true + difficulty=easy.
process.env.MC_PORT = process.env.MC_PORT || '25568';
process.env.MC_USERNAME = process.env.MC_USERNAME || 'SuiGeBot';
process.env.MC_ASSIST = process.env.MC_ASSIST === undefined ? '0' : process.env.MC_ASSIST;
process.env.MC_KEEP_INVENTORY = process.env.MC_KEEP_INVENTORY === undefined ? '1' : process.env.MC_KEEP_INVENTORY;
process.env.MC_NO_SELF_OP = process.env.MC_NO_SELF_OP === undefined ? '1' : process.env.MC_NO_SELF_OP;
process.env.MC_DIFFICULTY = process.env.MC_DIFFICULTY || 'easy';
process.env.MC_EXTRA_OPS = process.env.MC_EXTRA_OPS || 'musekc';
process.env.MC_JAVA_XMX = process.env.MC_JAVA_XMX || '2G';
require('../src/minecraft/autonomous/server/start.js');
