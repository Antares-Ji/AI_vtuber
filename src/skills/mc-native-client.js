'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { localClient } = require('./local-client');
const terminal = new Set(['VERIFIED', 'UNVERIFIED', 'INTERRUPTED', 'FAILED', 'CANCELLED']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function configuredClient(dataRoot, env = process.env) {
  const file = env.MCPLAYER_DIRECTOR_CONFIG || path.join(dataRoot, 'data/mcplayer.local.json');
  if (!fs.existsSync(file)) throw Error('Configure data/mcplayer.local.json and enable the Minecraft director API first');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const endpoint = new URL(config.endpoint || 'http://127.0.0.1:17650');
  if (endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/') throw Error('Minecraft director requires the IPv4 loopback root URL');
  if (typeof config.tokenFile !== 'string' || !config.tokenFile) throw Error('Minecraft director tokenFile is required');
  const token = fs.readFileSync(path.resolve(path.dirname(file), config.tokenFile), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw Error('Invalid Minecraft director token file');
  return localClient(endpoint.href, { headers: { authorization: `Bearer ${token}` } });
}

function receipt(value, id, instance, world) {
  if (!value || value.id !== id || value.instanceId !== instance ||
      (value.worldId !== world && !(value.state === 'CANCELLED' && value.worldId === '')) ||
      !['QUEUED', 'RUNNING', 'STOPPING', ...terminal].includes(value.state) ||
      value.releaseComplete !== terminal.has(value.state)) throw Error('Minecraft director receipt identity or state changed');
  if (value.state === 'VERIFIED' && !value.missionId) throw Error('Minecraft verification has no mission identity');
  return value;
}

async function nativeMission({ request, args, jobId, signal, pause = delay }) {
  const before = await request('/status', undefined, signal);
  if (before.protocol !== 1 || !uuid.test(before.instanceId) || before.hostFresh !== true ||
      !Number.isSafeInteger(before.controlRevision) || before.controlRevision < 0 ||
      before.ready !== true || before.active !== false || before.worldId !== args.worldId)
    throw Error('Minecraft client must be ready in the explicitly selected world, with no active mission');
  if (!uuid.test(jobId)) throw Error('Invalid director job id');
  const instanceId = before.instanceId;
  let attempted = false, released = false;
  const check = value => receipt(value, jobId, instanceId, args.worldId);
  try {
    signal.throwIfAborted(); attempted = true;
    let current;
    try {
      current = check(await request('/requests', { id: jobId, instanceId, worldId: args.worldId,
        controlRevision: before.controlRevision,
        goal: args.goal, durationMs: args.durationMinutes * 60000 }, signal));
    } catch (error) {
      if ([400, 401, 403, 404, 409, 415, 422].includes(error.status)) attempted = false;
      throw error;
    }
    while (true) {
      signal.throwIfAborted();
      if (current.releaseComplete) {
        released = true;
        if (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(current.state))
          throw Error(`Minecraft native mission ${current.state}: ${current.reason || 'no verified completion'}`);
        return { simulated: false, verified: false, backend: 'mcplayer-native', engine: current,
          note: 'Native harness result; this adapter does not independently certify gameplay success.' };
      }
      await pause(250, undefined, { signal });
      current = check(await request(`/requests/${jobId}`, undefined, signal));
    }
  } finally {
    if (attempted && !released) {
      // The stop installs a tombstone even if the ambiguous start has not arrived
      // yet. Never stop a different mission, replay a start, or release on timeout.
      while (true) {
        try {
          const stopped = check(await request(`/requests/${jobId}/stop`, { instanceId }));
          if (stopped.releaseComplete) break;
        } catch { /* retain the desktop lease while release is unconfirmed */ }
        await pause(500);
      }
    }
  }
}
module.exports = { configuredClient, nativeMission };
