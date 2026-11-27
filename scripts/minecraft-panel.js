'use strict';
// Local 23-stage MC monitor & control panel for AI_vtuber's autonomous Minecraft instance.
process.env.MC_PORT = process.env.MC_PORT || '25568';
process.env.MC_USERNAME = process.env.MC_USERNAME || 'SuiGeBot';
process.env.MC_ASSIST = process.env.MC_ASSIST === undefined ? '0' : process.env.MC_ASSIST;
process.env.MC_PANEL_PORT = process.env.MC_PANEL_PORT || '8790';
process.env.MC_PANEL_ID = process.env.MC_PANEL_ID || 'autonomous';
process.env.MC_PANEL_LABEL = process.env.MC_PANEL_LABEL || 'AI_vtuber · 不作弊自主通关 SuiGeBot:25568';
process.env.MC_PANEL_PEERS = process.env.MC_PANEL_PEERS || '[]';
process.env.MC_BOT_MATCH = process.env.MC_BOT_MATCH || 'minecraft-autonomous.js';
process.env.MC_BOT_ENTRY = process.env.MC_BOT_ENTRY || 'scripts/minecraft-autonomous.js';
process.env.MC_LAUNCHER_MATCH = process.env.MC_LAUNCHER_MATCH || 'minecraft-server.js';
process.env.MC_SERVER_ENTRY = process.env.MC_SERVER_ENTRY || 'scripts/minecraft-server.js';
require('../src/minecraft/autonomous/panel/server.js');
