'use strict';
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const runFile = promisify(execFile);
const MAX_PAYLOAD = 1024 * 1024;

// BetterGI 0.66.0, InstanceIpcProtocol v2. This client intentionally implements
// only ping: opening a registered connection can forward launch arguments.
function requestPing(pipe, { signal, timeoutMs = 2000, connect = net.createConnection } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || Error('Cancelled'));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return reject(Error('Invalid IPC timeout'));
    const requestId = randomUUID();
    const payload = Buffer.from(JSON.stringify({ version: 2, requestId, operation: 'ping' }));
    const header = Buffer.alloc(5); header.writeUInt32LE(payload.length); header[4] = 1;
    let socket, timer, buffer = Buffer.alloc(0), settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      socket?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(signal.reason || Error('Cancelled'));
    try { socket = connect(pipe); } catch (error) { finish(error); return; }
    timer = setTimeout(() => finish(Error('BetterGI IPC response timed out')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(Error('BetterGI IPC closed before a complete response')));
    socket.on('close', () => finish(Error('BetterGI IPC connection closed')));
    socket.on('connect', () => { if (!settled) socket.write(Buffer.concat([header, payload])); });
    socket.on('data', chunk => {
      if (settled) return;
      try {
        if (buffer.length + chunk.length > MAX_PAYLOAD + 5) throw Error('BetterGI IPC response exceeds limit');
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 5) return;
        const length = buffer.readUInt32LE(0);
        if (length < 2 || length > MAX_PAYLOAD || buffer[4] !== 1) throw Error('Invalid BetterGI IPC frame');
        if (buffer.length < length + 5) return;
        if (buffer.length !== length + 5) throw Error('Unexpected extra BetterGI IPC data');
        const response = JSON.parse(buffer.subarray(5).toString('utf8'));
        if (response.version !== 2 || response.operation !== 'response' || response.requestId !== requestId) throw Error('Mismatched BetterGI IPC response');
        if (response.success !== true) throw Error('BetterGI rejected IPC ping');
        const endpoint = response.data;
        if (!endpoint || endpoint.instanceType !== 0 || !Number.isInteger(endpoint.processId) || endpoint.processId < 1 ||
            !Number.isInteger(endpoint.windowsSessionId) || endpoint.windowsSessionId < 0 ||
            typeof endpoint.startedAt !== 'string' || !Number.isFinite(Date.parse(endpoint.startedAt))) throw Error('Invalid BetterGI root endpoint');
        finish(null, { protocol: 2, instanceType: 'primary', processId: endpoint.processId,
          windowsSessionId: endpoint.windowsSessionId, startedAt: endpoint.startedAt });
      } catch (error) { finish(error); }
    });
    if (signal?.aborted) aborted();
  });
}

async function pingBetterGi({ signal, platform = process.platform, sidReader, connect, timeoutMs } = {}) {
  if (signal?.aborted) throw signal.reason || Error('Cancelled');
  if (platform !== 'win32') return { online: false, reason: 'Windows IPC is unavailable on this platform' };
  try {
    const read = sidReader || (async () => {
      const { stdout } = await runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'),
        ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8', timeout: 2000, maxBuffer: 16384, signal });
      return stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
    });
    const sid = await read();
    if (typeof sid !== 'string' || !/^S-1-(?:\d+-)*\d+$/.test(sid)) throw Error('Current Windows user SID unavailable');
    const endpoint = await requestPing(`\\\\.\\pipe\\BetterGI.v2.user-${sid}.root`, { signal, connect, timeoutMs });
    return { online: true, ...endpoint };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    // Do not expose whoami output, account SID, or local pipe paths in reports.
    return { online: false, reason: error.code || (String(error.message).startsWith('BetterGI') || String(error.message).startsWith('Invalid') || String(error.message).startsWith('Mismatched') || String(error.message).startsWith('Unexpected') ? error.message : 'BetterGI IPC diagnostic failed') };
  }
}

module.exports = { requestPing, pingBetterGi };
