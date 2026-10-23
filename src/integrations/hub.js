'use strict';
const fs = require('node:fs');
const { BridgeServer } = require('../bridge/bridgeServer');
const { MAX_FRAME_BYTES, validateRequest, validateDecision, keyOf } = require('./contract');

/** Stage-0 broker: inherits the SID-restricted pipe host, separate from the legacy bridge. */
class IntegrationHub extends BridgeServer {
  constructor({ onChange = () => {}, onEvent = () => {}, allowedProviders = ['dsh'], ...options } = {}) {
    super(options);
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.allowedProviders = new Set(allowedProviders);
    this.closed = new Map();
    this.sockets = new Set();
  }
  writeDescriptor() {
    const tmp = this.descriptorPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, pipe: this.pipeName, token: this.token, pid: process.pid, createdAt: this.startedAt }));
    fs.renameSync(tmp, this.descriptorPath);
    this.hardenDescriptor();
  }
  snapshot() { return [...this.pending.values()].map(r => ({ ...r.request })); }
  change() { this.onChange(this.snapshot()); }
  handleSocket(sock) {
    this.sockets.add(sock);
    let buffer = '', request = null;
    const handshake = setTimeout(() => sock.destroy(), 2000);
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(handshake); this.sockets.delete(sock);
      if (request && this.pending.get(request.id)?.sock === sock) this.finish(request.id, { status: 'expired', reason: 'host-disconnected' });
    });
    sock.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return sock.destroy();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { sock.destroy(); return; }
        if (!request) {
          if (msg.v !== 2 || msg.token !== this.token) { sock.destroy(); return; }
          clearTimeout(handshake);
          try { request = validateRequest(msg); } catch { sock.destroy(); return; }
          const reply = data => sock.end(JSON.stringify({ provider: request.provider, id: request.requestId, ...data }) + '\n');
          if (!this.allowedProviders.has(request.provider)) { reply({ status: 'unavailable', reason: 'provider-disabled' }); return; }
          if (request.kind === 'event') {
            try { this.onEvent(request); } catch { return reply({ status: 'failed' }); }
            reply({ status: 'received' }); return;
          }
          if (this.pending.has(request.id) || this.closed.has(request.id)) { reply({ status: 'already_handled' }); return; }
          const rec = { sock, request, resolve: null, timer: setTimeout(() => {
            reply({ status: 'expired' }); this.finish(request.id, { status: 'expired' });
          }, request.timeoutMs) };
          this.pending.set(request.id, rec);
          this.log(`integration request provider=${request.provider} kind=${request.kind} id=${request.requestId} session=${request.sessionId || 'unassociated'}`);
          this.change();
        } else {
          if (msg.v !== 2 || msg.type !== 'receipt' || msg.id !== request.requestId || msg.provider !== request.provider) { sock.destroy(); return; }
          const rec = this.pending.get(request.id);
          if (!rec || rec.sock !== sock || rec.request.state !== 'submitting') { sock.destroy(); return; }
          this.finish(request.id, { status: ['delivered', 'already_handled', 'expired'].includes(msg.status) ? msg.status : 'failed' });
          sock.end();
        }
      }
    });
  }
  finish(id, result) {
    const rec = this.pending.get(id);
    if (!rec) return;
    clearTimeout(rec.timer); clearTimeout(rec.receiptTimer);
    this.pending.delete(id);
    this.closed.set(id, result);
    while (this.closed.size > 1000) this.closed.delete(this.closed.keys().next().value);
    rec.resolve?.(result);
    this.log(`integration settled provider=${rec.request.provider} id=${rec.request.requestId} status=${result.status}`);
    this.change();
  }
  async respond(id, decision, extra = {}) {
    const rec = this.pending.get(id);
    if (!rec) return { status: this.closed.get(id)?.status === 'delivered' ? 'already_handled' : 'expired' };
    if (rec.request.state !== 'pending') return { status: 'already_handled' };
    let normalized;
    try { normalized = validateDecision(rec.request, decision, extra); } catch (e) { return { status: 'failed', reason: e.message }; }
    rec.request.state = 'submitting';
    const result = new Promise(resolve => { rec.resolve = resolve; });
    rec.receiptTimer = setTimeout(() => {
      this.finish(id, { status: 'failed', reason: 'adapter-receipt-timeout' }); rec.sock.destroy();
    }, 2000);
    rec.sock.write(JSON.stringify({ v: 2, type: 'decision', provider: rec.request.provider, id: rec.request.requestId, ...normalized }) + '\n');
    this.change();
    return result;
  }
  stop() {
    for (const id of [...this.pending.keys()]) this.finish(id, { status: 'unavailable' });
    for (const sock of this.sockets) sock.destroy();
    super.stop();
  }
}
module.exports = { IntegrationHub, keyOf };
