'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '../../..');
// Load repo-level .env.local first (higher priority) then .env, never overriding already-pinned process.env.
for (const envFile of [path.join(root, '.env.local'), path.join(root, '.env')]) {
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false });
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

const runtimeRoot = path.join(root, 'runtime', 'minecraft-autonomous');
const bridgeEnabled = process.env.MC_HOST_BRIDGE !== '0';

module.exports = {
  root,
  runtimeRoot,
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    maxTokens: num(process.env.LLM_MAX_TOKENS, 2500),
    reasoningRoom: num(process.env.LLM_REASONING_ROOM, 1600),
    maxTokensCap: num(process.env.LLM_MAX_TOKENS_CAP, 8000),
    temperature: num(process.env.LLM_TEMPERATURE, 0.3),
    maxCallsPerHour: num(process.env.MAX_LLM_CALLS_PER_HOUR, 3000),
    thinking: process.env.LLM_THINKING !== '0',
    reasoningEffort: process.env.LLM_REASONING_EFFORT || 'high',
  },
  mc: {
    host: process.env.MC_HOST || '127.0.0.1',
    port: num(process.env.MC_PORT, 25568),
    version: process.env.MC_VERSION || '1.21.1',
    username: process.env.MC_USERNAME || 'SuiGeBot',
    auth: process.env.MC_AUTH || 'offline',
  },
  bot: {
    programTimeoutMs: num(process.env.PROGRAM_TIMEOUT_MS, 180000),
    reflectCooldownMs: num(process.env.REFLECT_COOLDOWN_MS, 4000),
    liveBeatMs: num(process.env.MC_LIVE_BEAT_MS, bridgeEnabled ? 5000 : 15000),
    // Single-speaker discipline: 'game' chats in MC, 'host' routes announcements to AI_vtuber only, 'off' logs only.
    talk: (process.env.MC_TALK || (bridgeEnabled ? 'host' : 'game')).toLowerCase(),
    humanPlayer: process.env.HUMAN_PLAYER || '',
  },
  hostBridge: {
    enabled: bridgeEnabled,
    port: num(process.env.MC_BRIDGE_PORT, 3001),
    snapshotMs: num(process.env.MC_BRIDGE_SNAPSHOT_MS, 1000),
    controlFile: process.env.MC_HOST_CONTROL_FILE
      ? path.resolve(process.env.MC_HOST_CONTROL_FILE)
      : path.join(root, 'logs', 'minecraft-control.json'),
    hostDir: root,
    hostUrl: (process.env.MC_HOST_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    syncGoal: process.env.MC_SYNC_HOST_GOAL !== '0',
    takeover: process.env.MC_HOST_TAKEOVER === '1',
  },
  paths: (() => {
    const runs = process.env.MC_RUNS_DIR ? path.resolve(root, process.env.MC_RUNS_DIR) : path.join(runtimeRoot, 'runs');
    const logs = process.env.MC_LOG_DIR ? path.resolve(root, process.env.MC_LOG_DIR) : path.join(runtimeRoot, 'logs');
    const server = process.env.MC_SERVER_DIR ? path.resolve(root, process.env.MC_SERVER_DIR) : path.join(runtimeRoot, 'server');
    return { logs, runs, server, notes: path.join(runs, 'notes.md'), state: path.join(runs, 'state.json') };
  })(),
};
