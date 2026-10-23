'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyVisibility, capSessions, isActive, DEFAULT_LIMIT } = require('../src/sessions/session-visibility.cjs');

const session = (id, phase, updatedAt, extra = {}) => ({ id, rawId: id, provider: 'dsh', phase, updatedAt, ...extra });

test('the island keeps at most fifty sessions and prefers sessions that need the user', () => {
  const list = [];
  for (let i = 0; i < 60; i++) list.push(session('S' + i, 'idle', 1_000 + i));
  list.push(session('WAIT', 'waitingForApproval', 1));
  list.push(session('RUN', 'running', 500_000));
  const capped = capSessions(list, DEFAULT_LIMIT);
  assert.equal(capped.length, 50);
  assert.equal(capped[0].id, 'WAIT');
  assert.equal(capped[1].id, 'RUN');
  assert.equal(capped.some(item => item.id === 'S0'), false, 'older sessions are dropped first');
  assert.equal(capped.some(item => item.id === 'S59'), true, 'newest idle sessions stay');
  assert.equal(capSessions(list, 0).length, 0);
  const short = [session('A', 'idle', 1)];
  assert.equal(capSessions(short, 50).length, 1);
  assert.notEqual(capSessions(short, 50), short, 'returned copies do not alias caller state');
});

test('locally hidden sessions stay hidden, but active ones are revived', () => {
  const hidden = new Set(['KEEP-HIDDEN', 'REVIVE-RUNNING', 'REVIVE-PENDING']);
  const list = [
    session('KEEP-HIDDEN', 'idle', 1),
    session('REVIVE-RUNNING', 'running', 2),
    session('REVIVE-PENDING', 'idle', 3, { pendingRequests: ['req-1'] }),
    session('NORMAL', 'completed', 4),
  ];
  const result = applyVisibility(list, hidden, { limit: 50 });
  assert.deepEqual(result.sessions.map(item => item.id), ['REVIVE-RUNNING', 'REVIVE-PENDING', 'NORMAL']);
  assert.deepEqual(result.revived.map(item => item.id), ['REVIVE-RUNNING', 'REVIVE-PENDING']);
  assert.equal(result.dropped, 0);
  assert.equal(isActive(session('X', 'waitingForAnswer', 1)), true);
  assert.equal(isActive(session('X', 'idle', 1)), false);
  assert.equal(isActive(session('X', 'idle', 1, { pendingRequests: ['r'] })), true);
});

test('the cap is applied after hidden sessions are removed and reports dropped rows', () => {
  const list = [];
  for (let i = 0; i < 55; i++) list.push(session('S' + i, 'completed', 1_000 + i));
  list.push(session('HIDDEN', 'idle', 9_999));
  const result = applyVisibility(list, new Set(['HIDDEN']), { limit: 50 });
  assert.equal(result.sessions.length, 50);
  assert.equal(result.sessions.some(item => item.id === 'HIDDEN'), false);
  assert.equal(result.dropped, 5);
});
