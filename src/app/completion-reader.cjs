'use strict';
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { JsonlTail } = require('../logs/jsonl-tail.cjs');
const LIMIT = 1024 * 1024;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
class CompletionReader {
  constructor() { this.cache = new Map(); this.inflight = new Map(); this.bytes = 0; this.epoch = 0; }
  clear() { this.epoch++; this.cache.clear(); this.inflight.clear(); this.bytes = 0; }
  retain(sessionKeys) {
    for (const [key, record] of this.cache) if (!sessionKeys.has(JSON.parse(key)[0])) { this.bytes -= record.bytes; this.cache.delete(key); }
  }
  async read({ file, sessionKey, turn }) {
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return { status: 'unavailable', turn, text: '', truncated: false }; }
    const key = JSON.stringify([sessionKey, turn]);
    const identity = [stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs].join(':');
    const previous = this.cache.get(key);
    if (previous?.identity === identity) { this.cache.delete(key); this.cache.set(key, previous); return previous.value; }
    if (previous) { this.bytes -= previous.bytes; this.cache.delete(key); }
    if (this.inflight.get(key)?.identity === identity) return this.inflight.get(key).promise;
    const epoch = this.epoch;
    const promise = this.scan(file, turn).then(value => {
      if (epoch !== this.epoch) return { ...value, status: 'expired' };
      const bytes = Buffer.byteLength(value.text || '', 'utf8');
      if (this.inflight.get(key)?.promise === promise) {
        const cached = this.cache.get(key); if (cached) this.bytes -= cached.bytes;
        this.cache.set(key, { identity, bytes, value }); this.bytes += bytes;
        while (this.cache.size > 4 || this.bytes > 2 * LIMIT) { const first = this.cache.keys().next().value; this.bytes -= this.cache.get(first).bytes; this.cache.delete(first); }
      }
      return value;
    }).finally(() => { if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key); });
    this.inflight.set(key, { identity, promise });
    return promise;
  }
  async scan(file, turn) {
    const tail = new JsonlTail(file, { compressed: true, maxReadBytes: 256 * 1024, maxLineBytes: 8 * LIMIT });
    let current = 0, candidate = '', value = null;
    let readingTurn = false;
    for (;;) {
      const records = tail.poll();
      for (const record of records) {
        const d = record.data || {};
        if (record.type === 'turn/start') { current = d.turn || current + 1; readingTurn = current === turn; candidate = ''; }
        if (record.type === 'assistant/message' && current === turn) candidate = textOf(d.message?.content || d.content);
        if (record.type === 'turn/end' && readingTurn) {
          const buffer = Buffer.from(candidate);
          value = { status: 'ok', turn, text: buffer.length > LIMIT ? new StringDecoder('utf8').write(buffer.subarray(0, LIMIT)) : candidate, truncated: buffer.length > LIMIT };
        }
      }
      if (tail.caughtUp) break;
      if (!tail.identity || tail.decoder.invalid) return { status: 'unavailable', turn, text: '', truncated: false };
      await new Promise(resolve => setImmediate(resolve));
    }
    return value || { status: 'unavailable', turn, text: '', truncated: false };
  }
}
module.exports = { CompletionReader, LIMIT };
