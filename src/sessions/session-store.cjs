'use strict';
const path = require('node:path');
const { keyOf, sessionKey } = require('../integrations/contract');
const rank = phase => ({ waitingForApproval: 0, waitingForAnswer: 1, running: 2, completed: 3, idle: 4 }[phase] ?? 4);
class SessionStore {
  constructor({ now = Date.now, staleMs = 30 * 60000 } = {}) {
    this.now = now; this.staleMs = staleMs; this.sessions = new Map(); this.requests = new Map(); this.confirmations = new Map();
  }
  entry(provider, rawId) {
    if (!['dsh'].includes(provider) || typeof rawId !== 'string' || !rawId) throw new Error('Verified source and session ID required');
    const id = keyOf(provider, rawId);
    if (!this.sessions.has(id)) this.sessions.set(id, { id, rawId, provider, log: null, native: null, tools: new Map() });
    return this.sessions.get(id);
  }
  replaceProviderSnapshot(provider, list) {
    const seen = new Set();
    for (const session of list) {
      const entry = this.entry(provider, session.rawId || session.id);
      entry.log = { ...session }; seen.add(entry.id);
    }
    for (const entry of this.sessions.values()) {
      if (entry.provider !== provider || seen.has(entry.id)) continue;
      entry.log = null;
      if (!entry.native && !this.pendingFor(entry.id).length) this.sessions.delete(entry.id);
    }
  }
  applyEvent(envelope) {
    if (!envelope.sessionId) return false; // Never infer identity from cwd or recency.
    const payload = envelope.payload || {};
    const event = payload.event;
    if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionStart', 'Stop', 'Interrupt', 'SessionEnd', 'SessionTitle', 'ApprovalDecided', 'QuestionAnswered'].includes(event)) return false;
    const entry = this.entry(envelope.provider, envelope.sessionId);
    const updatedAt = envelope.at || this.now();
    if (entry.native && updatedAt < entry.native.updatedAt) return false;
    const next = { ...entry.native, updatedAt, evidence: 'native' };
    if (payload.cwd) { next.cwd = payload.cwd; next.project = path.basename(payload.cwd); }
    if (event === 'SessionTitle' && typeof payload.title === 'string') next.title = payload.title;
    if (['UserPromptSubmit', 'PreToolUse', 'SessionStart'].includes(event)) { next.phase = 'running'; next.completedAt = 0; }
    if (event === 'PreToolUse') { entry.tools.set(payload.tool?.id || 'current', { ...payload.tool, since: updatedAt }); next.currentTool = [...entry.tools.values()].at(-1); }
    if (event === 'PostToolUse') {
      if (payload.callId) entry.tools.delete(payload.callId); else entry.tools.clear();
      next.currentTool = [...entry.tools.values()].at(-1) || null; next.phase = 'running';
    }
    if (event === 'Stop') { next.phase = 'completed'; next.completedAt = updatedAt; next.currentTool = null; if (Number.isSafeInteger(payload.turn)) next.turn = payload.turn; entry.tools.clear(); }
    if (event === 'Interrupt' || event === 'SessionEnd') { next.phase = 'idle'; next.currentTool = null; entry.tools.clear(); }
    if (event === 'ApprovalDecided' && envelope.provider === 'dsh' && payload.requestId && ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(payload.outcome)) {
      this.confirmations.set(keyOf(envelope.provider, payload.requestId), { provider: envelope.provider, sessionId: envelope.sessionId, outcome: payload.outcome, at: updatedAt });
    }
    if (event === 'QuestionAnswered' && envelope.provider === 'dsh' && payload.requestId && payload.outcome === 'answered') {
      this.confirmations.set(keyOf(envelope.provider, payload.requestId), { provider: envelope.provider, sessionId: envelope.sessionId, outcome: 'answered', at: updatedAt });
    }
    entry.native = next; return true;
  }
  setRequests(requests) {
    const next = new Map();
    for (const request of requests) {
      if (!['pending', 'submitting'].includes(request.state)) continue;
      const key = request.requestId || request.id;
      const id = keyOf(request.provider, key);
      const associated = sessionKey(request.provider, request.sessionId);
      if (associated) this.entry(request.provider, request.sessionId);
      next.set(id, { ...request, sessionKey: associated });
    }
    this.requests = next;
  }
  pendingFor(id) { return [...this.requests.values()].filter(request => request.sessionKey === id); }
  unassociated() { return [...this.requests.values()].filter(request => !request.sessionKey); }
  snapshot() {
    const result = [];
    for (const entry of this.sessions.values()) {
      const pending = this.pendingFor(entry.id);
      const newerNative = entry.native && entry.native.updatedAt >= (entry.log?.updatedAt || 0);
      const view = { phase: 'idle', project: '—', ...(entry.log || {}), ...(newerNative ? entry.native : {}) };
      const approvals = pending.filter(request => request.kind === 'approval');
      const questions = pending.filter(request => request.kind === 'question' && request.blocking !== false);
      if (newerNative && !pending.some(request => request.blocking !== false) && !view.currentTool &&
        this.now() - view.updatedAt > (view.phase === 'completed' ? 5 : 3) * 60000) view.phase = 'idle';
      if (newerNative) view.needsAttention = !!view.currentTool && this.now() - view.currentTool.since > 30000 && !approvals.length && !questions.length;
      if (approvals.length) view.phase = 'waitingForApproval';
      else if (questions.length) view.phase = 'waitingForAnswer';
      view.updatedAt = Math.max(view.updatedAt || 0, ...pending.map(request => request.receivedAt || 0));
      if (!pending.length && this.now() - view.updatedAt > this.staleMs) { this.sessions.delete(entry.id); continue; }
      result.push({ ...view, id: entry.id, rawId: entry.rawId, provider: entry.provider,
        title: view.title || view.project || entry.rawId, pendingRequests: pending.map(request => request.id),
        actionable: pending.length > 0, jumpTarget: { provider: entry.provider, sessionId: entry.rawId } });
    }
    for (const [key, confirmation] of this.confirmations) if (this.now() - confirmation.at > this.staleMs) this.confirmations.delete(key);
    return result.sort((a, b) => rank(a.phase) - rank(b.phase) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
}
module.exports = { SessionStore };
