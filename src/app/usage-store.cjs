'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const PROVIDERS = ['dsh', 'zcode', 'codex', 'claude', 'chatgpt'];
const emptyProvider = () => ({ events: 0, approvals: 0, questions: 0, completed: 0 });
const empty = now => ({ version: VERSION, since: now, totals: { events: 0, approvals: 0, questions: 0, completed: 0 }, providers: Object.fromEntries(PROVIDERS.map(provider => [provider, emptyProvider()])), surfaces: {} });

class UsageStore {
  constructor(file, { now = Date.now, log = () => {} } = {}) {
    if (!path.isAbsolute(file)) throw new Error('Absolute usage path required');
    this.file = file; this.now = now; this.log = log; this.value = empty(this.now()); this.seenRequests = new Set();
  }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version !== VERSION || !parsed.totals || !parsed.providers) throw new Error('unsupported usage schema');
      this.value = empty(Number.isFinite(parsed.since) ? parsed.since : this.now());
      for (const key of Object.keys(this.value.totals)) this.value.totals[key] = Math.max(0, Number(parsed.totals[key]) || 0);
      for (const provider of PROVIDERS) for (const key of Object.keys(this.value.providers[provider])) {
        this.value.providers[provider][key] = Math.max(0, Number(parsed.providers[provider]?.[key]) || 0);
      }
      if (parsed.surfaces && typeof parsed.surfaces === 'object' && !Array.isArray(parsed.surfaces)) {
        for (const [surface, counters] of Object.entries(parsed.surfaces).slice(0, 50)) {
          if (!counters || typeof counters !== 'object') continue;
          this.value.surfaces[surface] = emptyProvider();
          for (const key of Object.keys(this.value.surfaces[surface])) this.value.surfaces[surface][key] = Math.max(0, Number(counters[key]) || 0);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log('usage load failed: ' + error.message); }
    return this.snapshot();
  }
  save() {
    const tmp = this.file + '.tmp';
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2) + '\n', { flag: 'w', mode: 0o600 }); fs.renameSync(tmp, this.file); return true; }
    catch (error) { this.log('usage save failed: ' + error.message); try { fs.unlinkSync(tmp); } catch {} return false; }
  }
  recordEvent(provider, event, surface = '') {
    if (!this.value.providers[provider]) return false;
    this.value.totals.events++; this.value.providers[provider].events++;
    const surfaceCounters = typeof surface === 'string' && surface ? (this.value.surfaces[surface] ||= emptyProvider()) : null;
    if (surfaceCounters) surfaceCounters.events++;
    if (event === 'ApprovalDecided') { this.value.totals.approvals++; this.value.providers[provider].approvals++; if (surfaceCounters) surfaceCounters.approvals++; }
    if (event === 'QuestionAnswered') { this.value.totals.questions++; this.value.providers[provider].questions++; if (surfaceCounters) surfaceCounters.questions++; }
    if (event === 'Stop' || event === 'SessionEnd') { this.value.totals.completed++; this.value.providers[provider].completed++; if (surfaceCounters) surfaceCounters.completed++; }
    this.save(); return true;
  }
  recordRequest(provider, requestId, kind, surface = '') {
    const key = typeof requestId === 'string' ? provider + ':' + requestId : '';
    if (!this.value.providers[provider] || !key || this.seenRequests.has(key)) return false;
    this.seenRequests.add(key); while (this.seenRequests.size > 2048) this.seenRequests.delete(this.seenRequests.values().next().value);
    const surfaceCounters = typeof surface === 'string' && surface ? (this.value.surfaces[surface] ||= emptyProvider()) : null;
    if (kind === 'approval') { this.value.totals.approvals++; this.value.providers[provider].approvals++; if (surfaceCounters) surfaceCounters.approvals++; }
    if (kind === 'question') { this.value.totals.questions++; this.value.providers[provider].questions++; if (surfaceCounters) surfaceCounters.questions++; }
    this.save(); return true;
  }
  reset() { this.value = empty(this.now()); this.seenRequests.clear(); this.save(); return this.snapshot(); }
  snapshot() { return JSON.parse(JSON.stringify(this.value)); }
}

module.exports = { UsageStore, PROVIDERS, VERSION };
