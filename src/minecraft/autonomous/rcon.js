'use strict';
// Minimal Source-RCON client (no dependencies), enough to run one console command per call.
// Paper/Minecraft frame:  int32 LE size | int32 requestId | int32 type | body\0 | \0
// size counts everything after itself. type 3 = auth (SERVERDATA_AUTH), 2 = EXECCOMMAND,
// server replies with type 2 (AUTH_RESPONSE; requestId -1 means bad password) or type 0 (command output).
const net = require('net');

function frame(id, type, body) {
  const b = Buffer.from(body + '\0\0', 'binary');
  const out = Buffer.alloc(4 + 4 + 4 + b.length);
  // size counts everything AFTER the 4 length bytes: 4 id + 4 type + body + the two NUL pads.
  // Declaring 12 + b.length (allocating 12) made every packet four bytes short on the wire, the server
  // waited for bytes that never came, and the whole channel looked like a timeout (verified against a
  // hand-written probe that used 8 + b.length and got `list` answered first try).
  out.writeInt32LE(8 + b.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  b.copy(out, 12);
  return out;
}

function exec(host, port, password, command, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 12000;
  const cmd = String(command || '').replace(/^\/+/, '');   // the console takes bare commands
  return new Promise((resolve) => {
    const soc = net.connect({ host, port, noDelay: true });
    let phase = 0, out = '', done = false;                  // 0 = awaiting auth reply, 1 = awaiting command output
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { soc.destroy(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, note: `rcon timeout after ${timeoutMs}ms${out ? ' (partial: ' + out.slice(0, 200) + ')' : ''}` }), timeoutMs);
    soc.on('error', e => finish({ ok: false, note: 'rcon connect failed: ' + e.message + ' (is enable-rcon=true and the server restarted?)' }));
    soc.on('close', () => finish(out ? { ok: true, response: out } : { ok: false, note: 'rcon connection closed by the server before replying' }));
    let buf = Buffer.alloc(0);
    soc.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < size + 4) break;
        const rid = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.slice(12, 12 + Math.max(0, size - 10)).toString('utf8');
        buf = buf.slice(size + 4);
        if (type === 2) {                                    // SERVERDATA_AUTH_RESPONSE
          if (rid === -1) return finish({ ok: false, note: 'rcon password rejected (server/rcon.password 与 server.properties 不一致?)' });
          phase = 1;
          soc.write(frame(2, 2, cmd));                       // a distinct request id, as the working probe used
          continue;
        }
        if (type === 0) {                                    // SERVERDATA_RESPONSE_VALUE
          out += (out ? String.fromCharCode(10) : '') + body.replace(new RegExp(String.fromCharCode(0) + '+$'), '');
          if (phase === 1) return finish({ ok: true, response: out });
          if (phase === 1) return finish({ ok: true, response: out });
        }
      }
    });
    soc.on('connect', () => soc.write(frame(1, 3, password)));
  });
}

module.exports = { exec, frame };
