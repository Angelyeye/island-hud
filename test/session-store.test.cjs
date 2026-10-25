'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../src/sessions/session-store.cjs');
const { keyOf } = require('../src/integrations/contract');
test('unknown providers are rejected and provider snapshots keep their own sessions', () => {
  const store = new SessionStore({ now: () => 100 });
  store.replaceProviderSnapshot('dsh', [{ rawId: 'S', project: 'project', title: 'D', updatedAt: 100 }, { rawId: 'S2', project: 'project', updatedAt: 100 }]);
  assert.throws(() => store.replaceProviderSnapshot('other', [{ rawId: 'S', project: 'project', title: 'C', updatedAt: 100 }]), /Verified source and session ID required/);
  assert.equal(store.snapshot().length, 2);
  assert.equal(store.snapshot().find(s => s.id === keyOf('dsh', 'S')).title, 'D');
  assert.equal(store.snapshot().find(s => s.id === keyOf('dsh', 'S2')).project, 'project');
});

test('native tool completion preserves parallel tools and silent time still changes native phase', () => {
  let now = 100; const store = new SessionStore({ now: () => now });
  const event = (name, extra = {}) => store.applyEvent({ provider: 'dsh', sessionId: 'S', at: now, payload: { event: name, ...extra } });
  event('PreToolUse', { tool: { id: 'A', name: 'bash' } }); now++;
  event('PreToolUse', { tool: { id: 'B', name: 'read' } }); now++;
  event('PostToolUse', { callId: 'B' }); assert.equal(store.snapshot()[0].currentTool.id, 'A');
  now += 31000; assert.equal(store.snapshot()[0].needsAttention, true);
  event('PostToolUse', { callId: 'A' }); assert.equal(store.snapshot()[0].currentTool, null);
  now += 180001; assert.equal(store.snapshot()[0].phase, 'idle');
  event('Stop'); assert.equal(store.snapshot()[0].phase, 'completed');
  now += 300001; assert.equal(store.snapshot()[0].phase, 'idle');
});

test('an unrelated native event cannot manufacture activity or a question confirmation', () => {
  const store = new SessionStore({ now: () => 100 });
  assert.equal(store.applyEvent({ provider: 'dsh', sessionId: 'S', payload: { event: 'Unknown' } }), false);
  assert.equal(store.snapshot().length, 0);
  store.applyEvent({ provider: 'dsh', sessionId: 'S', payload: { event: 'QuestionAnswered', requestId: 'Q', outcome: 'answered' } });
  assert.equal(store.confirmations.get(keyOf('dsh', 'Q')).outcome, 'answered');
  store.applyEvent({ provider: 'zcode', sessionId: 'S', payload: { event: 'ApprovalDecided', requestId: 'A', outcome: 'allowed-always' } });
  assert.equal(store.confirmations.get(keyOf('zcode', 'A')).outcome, 'allowed-always');
});
test('a ZCode session opened in the client registers without reading as activity', () => {
  let now = 100; const store = new SessionStore({ now: () => now });
  store.applyEvent({ provider: 'zcode', sessionId: 'session_zectrix', at: now, payload: { event: 'SessionStart', cwd: 'C:\\work\\Zectrix Note 4C' } });
  const view = store.snapshot().find(s => s.rawId === 'session_zectrix');
  assert.equal(view.phase, 'idle', 'SessionStart alone is an open conversation, not a running task');
  assert.equal(view.project, 'Zectrix Note 4C');
  assert.equal(view.title, 'Zectrix Note 4C', 'the title falls back to the project until a prompt arrives');
  store.applyEvent({ provider: 'zcode', sessionId: 'session_zectrix', at: ++now, payload: { event: 'UserPromptSubmit', prompt: '继续任务' } });
  assert.equal(store.snapshot().find(s => s.rawId === 'session_zectrix').phase, 'running', 'a real prompt starts the running clock');
});
test('a DSH SessionStart still reads as activity; only ZCode cold-opens stay idle', () => {
  const store = new SessionStore({ now: () => 100 });
  store.applyEvent({ provider: 'dsh', sessionId: 'D', at: 100, payload: { event: 'SessionStart' } });
  assert.equal(store.snapshot()[0].phase, 'running',
    'other providers never cold-open finished conversations, so their SessionStart stays a running signal');
});
test('reopening a finished session keeps its state and an in-flight run survives a client open', () => {
  let now = 100; const store = new SessionStore({ now: () => now });
  store.applyEvent({ provider: 'zcode', sessionId: 'A', at: now, payload: { event: 'Stop' } });
  assert.equal(store.snapshot()[0].phase, 'completed');
  store.applyEvent({ provider: 'zcode', sessionId: 'A', at: ++now, payload: { event: 'SessionStart', cwd: 'C:\\w\\demo' } });
  assert.equal(store.snapshot()[0].phase, 'completed', 'SessionStart does not resurrect a finished session');
  store.applyEvent({ provider: 'zcode', sessionId: 'B', at: now, payload: { event: 'PreToolUse', tool: { id: 'T', name: 'Bash' } } });
  store.applyEvent({ provider: 'zcode', sessionId: 'B', at: ++now, payload: { event: 'SessionStart', cwd: 'C:\\w\\demo' } });
  assert.equal(store.snapshot().find(s => s.rawId === 'B').phase, 'running', 'a client open event must not downgrade an active run');
});
test('unassociated questions stay separate; non-blocking questions do not pause a session', () => {
  const store = new SessionStore({ now: () => 100 });
  store.applyEvent({ provider: 'dsh', sessionId: 'S', at: 100, payload: { event: 'UserPromptSubmit' } });
  store.setRequests([{ provider: 'dsh', id: 'U', sessionId: null, state: 'pending', kind: 'question', blocking: true },
    { provider: 'dsh', id: 'N', sessionId: 'S', state: 'pending', kind: 'question', blocking: false }]);
  assert.equal(store.snapshot().length, 1); assert.equal(store.snapshot()[0].phase, 'running');
  assert.equal(store.unassociated().length, 1);
});
test('pending native requests survive silence and stale fallback metadata; host audit is the only confirmation', () => {
  let now = 100; const store = new SessionStore({ now: () => now, staleMs: 1000 });
  store.applyEvent({ provider: 'dsh', sessionId: 'S', at: 100, payload: { event: 'PreToolUse', tool: { name: 'bash' } } });
  store.replaceProviderSnapshot('dsh', [{ rawId: 'S', updatedAt: 50, title: 'Recovered title', phase: 'completed' }]);
  store.setRequests([{ provider: 'dsh', id: 'A', sessionId: 'S', state: 'pending', kind: 'approval', receivedAt: 101 }]);
  now = 10000; assert.equal(store.snapshot()[0].phase, 'waitingForApproval');
  assert.equal(store.snapshot()[0].title, 'Recovered title'); assert.equal(store.confirmations.size, 0);
  store.applyEvent({ provider: 'dsh', sessionId: 'S', payload: { event: 'ApprovalDecided', requestId: 'A', outcome: 'allowed-once' } });
  assert.equal(store.confirmations.get(keyOf('dsh', 'A')).outcome, 'allowed-once');
  store.setRequests([]); assert.equal(store.snapshot()[0].phase, 'running');
});
