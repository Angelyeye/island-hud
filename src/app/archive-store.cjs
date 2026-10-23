'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROVIDERS = new Set(['dsh']);
const KINDS = new Set(['archived', 'deleted']);
const DEFAULT_KIND = 'archived';
const VERSION = 2;
const MAX_ENTRIES = 500;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

const keyOf = (provider, rawId) => JSON.stringify([provider, rawId]);
const encoded = value => JSON.stringify(value, null, 2) + '\n';

function parseKey(key) {
  if (typeof key !== 'string' || key.length > 2048) return null;
  let value;
  try { value = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [provider, rawId] = value;
  if (!PROVIDERS.has(provider) || typeof rawId !== 'string' || !rawId || rawId.length > 500) return null;
  return { provider, rawId };
}

// A session can only be hidden once it is no longer waiting on the user.
function canHide(session) {
  if (!session || !['idle', 'completed'].includes(session.phase)) return false;
  return !(Array.isArray(session.pendingRequests) && session.pendingRequests.length);
}
const canArchive = canHide;

// Hidden sessions stay hidden unless they become active again.
function shouldHide(session, hidden) {
  if (!session || !hidden || !hidden.has(session.id)) return false;
  if (['running', 'waitingForApproval', 'waitingForAnswer'].includes(session.phase)) return false;
  return !(Array.isArray(session.pendingRequests) && session.pendingRequests.length);
}

/**
 * Local-only session visibility list (archived and deleted are both local hides).
 * Never writes to DSH session files or profiles.
 */
class ArchiveStore {
  constructor(file, { now = Date.now, log = () => {} } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Absolute archive path required');
    Object.assign(this, { file, now: typeof now === 'function' ? now : () => now, log, entries: new Map() });
  }
  load() {
    this.entries.clear();
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') this.log('archive load failed: ' + error.message); return this.list(); }
    try {
      const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!value || typeof value !== 'object' || ![1, VERSION].includes(value.v) || !Array.isArray(value.entries)) throw new Error('Invalid archive structure');
      for (const item of value.entries) {
        const parsed = item && typeof item === 'object' ? parseKey(item.key) : null;
        if (!parsed || item.provider !== parsed.provider || item.rawId !== parsed.rawId) continue;
        const kind = value.v === 1 ? DEFAULT_KIND : (KINDS.has(item.kind) ? item.kind : DEFAULT_KIND);
        const hiddenAt = Number(item.hiddenAt ?? item.archivedAt);
        if (!Number.isFinite(hiddenAt) || hiddenAt <= 0) continue;
        this.entries.set(item.key, {
          key: item.key, provider: parsed.provider, rawId: parsed.rawId, kind,
          title: typeof item.title === 'string' ? item.title.slice(0, 500) : '',
          project: typeof item.project === 'string' ? item.project.slice(0, 500) : '',
          hiddenAt,
        });
      }
      this.prune(); this.trim();
    } catch (error) {
      const backup = this.file + '.bad-' + this.now();
      try { fs.renameSync(this.file, backup); } catch { /* keep running with an empty list */ }
      this.entries.clear();
      this.log('archive file is unreadable, kept backup at ' + backup + ': ' + error.message);
    }
    return this.list();
  }
  keys(kind) {
    const result = new Set();
    for (const [key, entry] of this.entries) if (!kind || entry.kind === kind) result.add(key);
    return result;
  }
  has(key) { return this.entries.has(key); }
  get(key) { return this.entries.get(key) || null; }
  count(kind) {
    if (!kind) return this.entries.size;
    let total = 0;
    for (const entry of this.entries.values()) if (entry.kind === kind) total++;
    return total;
  }
  list(kind = DEFAULT_KIND, limit = LIST_LIMIT) {
    if (typeof kind === 'number') return this.list(DEFAULT_KIND, kind);
    return [...this.entries.values()]
      .filter(entry => !kind || entry.kind === kind)
      .sort((a, b) => b.hiddenAt - a.hiddenAt || a.key.localeCompare(b.key))
      .slice(0, Math.max(0, limit));
  }
  prune() {
    const cutoff = this.now() - TTL_MS;
    let removed = 0;
    for (const [key, entry] of this.entries) if (entry.hiddenAt < cutoff) { this.entries.delete(key); removed++; }
    return removed;
  }
  trim() {
    while (this.entries.size > MAX_ENTRIES) {
      let oldest = null;
      for (const entry of this.entries.values()) if (!oldest || entry.hiddenAt < oldest.hiddenAt) oldest = entry;
      if (!oldest) break;
      this.entries.delete(oldest.key);
    }
  }
  add({ provider, rawId, title, project, kind = DEFAULT_KIND } = {}) {
    if (!PROVIDERS.has(provider) || typeof rawId !== 'string' || !rawId) return { ok: false, reason: 'invalid' };
    if (!KINDS.has(kind)) return { ok: false, reason: 'invalid' };
    const key = keyOf(provider, rawId);
    const previous = this.entries.get(key) || null;
    const entry = { key, provider, rawId, kind,
      title: typeof title === 'string' ? title.slice(0, 500) : '',
      project: typeof project === 'string' ? project.slice(0, 500) : '',
      hiddenAt: this.now() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(); this.trim();
    if (!this.persist()) {
      if (previous) this.entries.set(key, previous); else this.entries.delete(key);
      return { ok: false, reason: 'storage' };
    }
    return { ok: true, entry };
  }
  remove(key) {
    const previous = this.entries.get(key);
    if (!previous) return { ok: false, reason: 'missing' };
    this.entries.delete(key);
    if (!this.persist()) { this.entries.set(key, previous); return { ok: false, reason: 'storage' }; }
    return { ok: true, entry: previous };
  }
  clear(kind = DEFAULT_KIND) {
    const snapshot = JSON.stringify([...this.entries.values()]);
    const keys = [...this.entries.values()].filter(entry => !kind || entry.kind === kind).map(entry => entry.key);
    if (!keys.length) return { ok: true, removed: 0 };
    for (const key of keys) this.entries.delete(key);
    if (!this.persist()) { this.entries = new Map(JSON.parse(snapshot).map(entry => [entry.key, entry])); return { ok: false, reason: 'storage' }; }
    return { ok: true, removed: keys.length };
  }
  persist() {
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, encoded({ v: VERSION, entries: [...this.entries.values()] }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (error) { this.log('archive save failed: ' + error.message); return false; }
    finally { try { fs.unlinkSync(tmp); } catch { /* moved or never written */ } }
  }
}

module.exports = { ArchiveStore, canHide, canArchive, shouldHide, keyOf, KINDS, DEFAULT_KIND, MAX_ENTRIES, TTL_MS, VERSION };
