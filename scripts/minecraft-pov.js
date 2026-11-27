'use strict';
// Local in-game POV HUD endpoint (http://127.0.0.1:8799/api/pov) for the Fabric aipov viewer mod.
process.env.MC_PORT = process.env.MC_PORT || '25568';
process.env.MC_USERNAME = process.env.MC_USERNAME || 'SuiGeBot';
process.env.POV_PORT = process.env.POV_PORT || '8799';
const { startServer } = require('../src/minecraft/autonomous/pov/server.js');
startServer();
