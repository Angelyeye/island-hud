'use strict';
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { decompress } = require('fzstd');
const MAGIC = 0xfd2fb528;
const LIMIT = 16 * 1024 * 1024;

// Frame boundaries follow the Zstandard frame/block headers, never a magic-byte
// search inside compressed data. See facebook/zstd doc/zstd_compression_format.md.
function frameLength(bytes) {
  if (bytes.length < 4) return null;
  const magic = bytes.readUInt32LE(0);
  if ((magic >>> 4) === 0x0184d2a5) {
    if (bytes.length < 8) return null;
    const length = bytes.readUInt32LE(4) + 8;
    if (length > LIMIT) throw new Error('Oversized skippable zstd frame');
    return bytes.length < length ? null : length;
  }
  if (magic !== MAGIC) throw new Error('Invalid zstd frame header');
  if (bytes.length < 5) return null;
  const flags = bytes[4], single = !!(flags & 32), sizeFlag = flags >>> 6;
  if (flags & 8) throw new Error('Reserved zstd frame flag');
  const dictBytes = [0, 1, 2, 4][flags & 3];
  const sizeBytes = sizeFlag ? 2 ** sizeFlag : single ? 1 : 0;
  const headerSize = 5 + (single ? 0 : 1) + dictBytes + sizeBytes;
  if (bytes.length < headerSize) return null;
  if (!single) {
    const base = 2 ** (10 + (bytes[5] >>> 3));
    if (base + base / 8 * (bytes[5] & 7) > LIMIT) throw new Error('Oversized zstd window');
  }
  if (sizeBytes) {
    const at = headerSize - sizeBytes;
    const size = sizeBytes === 8 ? bytes.readBigUInt64LE(at) : BigInt(bytes.readUIntLE(at, sizeBytes) + (sizeFlag === 1 ? 256 : 0));
    if (size > BigInt(LIMIT)) throw new Error('Oversized decoded zstd frame');
  }
  let at = headerSize;
  for (;;) {
    if (at + 3 > bytes.length) return null;
    const block = bytes.readUIntLE(at, 3), type = (block >>> 1) & 3;
    if (type === 3) throw new Error('Reserved zstd block type');
    const size = block >>> 3;
    if (size > 128 * 1024) throw new Error('Oversized zstd block');
    at += 3 + (type === 1 ? 1 : size);
    if (at > LIMIT) throw new Error('Oversized compressed zstd frame');
    if (at > bytes.length) return null;
    if (block & 1) {
      at += flags & 4 ? 4 : 0;
      return at > bytes.length ? null : at;
    }
  }
}

class JsonlDecoder {
  constructor({ compressed = false, maxLineBytes = 1024 * 1024 } = {}) {
    this.compressed = compressed;
    this.maxLineBytes = maxLineBytes;
    this.errors = 0;
    this.reset();
  }
  reset() {
    this.pending = Buffer.alloc(0);
    this.line = '';
    this.discardLine = false;
    this.decoder = new StringDecoder('utf8');
    this.invalid = false;
  }
  text(bytes, out) {
    const parts = this.decoder.write(bytes).split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (!this.discardLine) this.line += parts[i];
      if (Buffer.byteLength(this.line) > this.maxLineBytes) { this.line = ''; this.discardLine = true; this.errors++; }
      if (i === parts.length - 1) continue;
      if (!this.discardLine && this.line.trim()) {
        try {
          const value = JSON.parse(this.line);
          if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
          else this.errors++;
        } catch { this.errors++; }
      }
      this.line = ''; this.discardLine = false;
    }
  }
  push(bytes) {
    const out = [];
    if (!this.compressed) { this.text(bytes, out); return out; }
    if (this.invalid) return out;
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes);
    let at = 0;
    while (at < this.pending.length) {
      const rest = this.pending.subarray(at);
      let length;
      try { length = frameLength(rest); }
      catch { this.errors++; this.invalid = true; this.pending = Buffer.alloc(0); return out; }
      if (length === null) break;
      if (rest.readUInt32LE(0) === MAGIC) {
        try { this.text(Buffer.from(decompress(rest.subarray(0, length))), out); }
        catch { this.errors++; this.line = ''; this.decoder = new StringDecoder('utf8'); }
      }
      at += length;
    }
    this.pending = Buffer.from(this.pending.subarray(at));
    if (this.pending.length > LIMIT) { this.errors++; this.invalid = true; this.pending = Buffer.alloc(0); }
    return out;
  }
}

// Bounded reads, identity checks and two small anchors also detect truncation
// followed by regrowth between polls, including a rewrite with the same size.
class JsonlTail {
  constructor(file, { compressed = false, maxReadBytes = 1024 * 1024, ...options } = {}) {
    this.file = file;
    this.maxReadBytes = maxReadBytes;
    this.decoder = new JsonlDecoder({ compressed, ...options });
    this.generation = 0;
    this.offset = 0;
    this.identity = null;
    this.prefix = Buffer.alloc(0);
    this.anchor = Buffer.alloc(0);
    this.caughtUp = false;
  }
  reset(reason) {
    this.generation++;
    this.resetReason = reason;
    this.offset = 0; this.identity = null;
    this.prefix = Buffer.alloc(0); this.anchor = Buffer.alloc(0);
    this.decoder.reset();
  }
  read(fd, length, position) {
    const bytes = Buffer.alloc(length);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, position));
  }
  poll() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (this.identity !== null && identity !== this.identity) this.reset('replaced');
      else if (stat.size < this.offset) this.reset('truncated');
      else if (this.offset && (!this.read(fd, this.prefix.length, 0).equals(this.prefix) ||
          !this.read(fd, this.anchor.length, this.offset - this.anchor.length).equals(this.anchor))) this.reset('rewritten');
      this.identity = identity;
      const length = Math.min(stat.size - this.offset, this.maxReadBytes);
      const bytes = length ? this.read(fd, length, this.offset) : Buffer.alloc(0);
      this.offset += bytes.length;
      this.caughtUp = this.offset >= stat.size;
      this.prefix = this.read(fd, Math.min(64, this.offset), 0);
      this.anchor = this.read(fd, Math.min(64, this.offset), Math.max(0, this.offset - 64));
      return this.decoder.push(bytes);
    } catch (error) {
      this.caughtUp = false;
      if (error.code === 'ENOENT' && this.identity !== null) this.reset('missing');
      return [];
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
module.exports = { frameLength, JsonlDecoder, JsonlTail };
