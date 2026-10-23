'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { MAX_FRAME_BYTES } = require('./contract');
function descriptorPath() {
  return process.env.ISLAND_HUD_BRIDGE_FILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'IslandHUD', 'integration-v2.json');
}

/** One original host invocation owns this socket for its full lifetime. */
function exchange(envelope, { signal, descriptor = descriptorPath(), connectMs = 1500, validate = x => x } = {}) {
  return new Promise(resolve => {
    let sock, connectionTimer, waitTimer, settled = false, connected = false, buf = '';
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer); clearTimeout(waitTimer);
      signal?.removeEventListener('abort', abort);
      if (sock) sock.end();
      resolve(result);
    };
    const abort = () => { sock?.destroy(); finish({ status: 'cancelled' }); };
    if (signal?.aborted) return abort();
    let d;
    try {
      d = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (d.v !== 2 || !/^island-hud-\d+-[a-f0-9]+$/.test(d.pipe) || !/^[a-f0-9]{48}$/.test(d.token)) throw new Error('Invalid descriptor');
    } catch { finish({ status: 'unavailable', reason: 'bridge-not-running' }); return; }
    connectionTimer = setTimeout(() => { sock?.destroy(); finish({ status: 'unavailable', reason: 'connect-timeout' }); }, Math.min(connectMs, 1800));
    signal?.addEventListener('abort', abort, { once: true });
    sock = net.createConnection('\\\\.\\pipe\\' + d.pipe);
    sock.setEncoding('utf8');
    sock.on('error', () => finish({ status: 'unavailable', reason: 'connection-lost' }));
    sock.on('close', () => finish({ status: 'unavailable', reason: connected ? 'disconnected' : 'connect-failed' }));
    sock.once('connect', () => {
      connected = true; clearTimeout(connectionTimer);
      const waitMs = envelope.kind === 'approval' ? 120000 : envelope.kind === 'question' ? 600000 : 1500;
      waitTimer = setTimeout(() => { sock.destroy(); finish({ status: 'expired' }); }, waitMs);
      const frame = JSON.stringify({ ...envelope, v: 2, token: d.token });
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { sock.destroy(); return finish({ status: 'failed', reason: 'frame-too-large' }); }
      sock.write(frame + '\n');
    });
    sock.on('data', chunk => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_FRAME_BYTES) { sock.destroy(); return finish({ status: 'failed', reason: 'invalid-frame' }); }
      const at = buf.indexOf('\n');
      if (at < 0) return;
      let reply;
      try { reply = JSON.parse(buf.slice(0, at)); } catch { sock.destroy(); return finish({ status: 'failed', reason: 'invalid-json' }); }
      if (reply.id !== envelope.id || reply.provider !== envelope.provider) { sock.destroy(); return finish({ status: 'failed', reason: 'wrong-request' }); }
      if (reply.type !== 'decision') return finish(reply);
      try {
        const validated = validate(reply);
        // Receipt confirms delivery to this adapter, never execution/verification by the native host.
        sock.write(JSON.stringify({ v: 2, type: 'receipt', id: envelope.id, provider: envelope.provider, status: 'delivered' }) + '\n', () => finish({ ...validated, status: 'delivered' }));
      } catch (e) {
        const status = ['already_handled', 'expired'].includes(e.status) ? e.status : 'failed';
        sock.write(JSON.stringify({ v: 2, type: 'receipt', id: envelope.id, provider: envelope.provider, status }) + '\n', () => finish({ status, reason: e.message }));
      }
    });
  });
}
module.exports = { exchange, descriptorPath };
