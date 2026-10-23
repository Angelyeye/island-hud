'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionDraftCache } = require('../src/renderer/question-drafts');
const request = overrides => ({ id: 'foreground', provider: 'dsh', sessionId: 'session', kind: 'question',
  payload: { callId: 'call', questions: [{ id: 'q', question: '中文问题', options: [{ label: 'X' }, { label: 'Z' }], multiSelect: true }] }, ...overrides });
function storage() { const values = new Map(); return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) }; }
test('question draft follows only the exact native call and question shape across reconnect and renderer restart', () => {
  const local = storage(), cache = createQuestionDraftCache({ storage: local });
  const original = request(), answer = cache.get(original)[0]; answer.selected = ['X', 'Z']; answer.custom = '中文草稿';
  cache.touch(original); cache.flush();
  const continued = request({ id: 'continued-revision-1', blocking: false });
  assert.deepEqual(cache.get(continued), [answer]);
  const restarted = createQuestionDraftCache({ storage: local });
  assert.deepEqual(restarted.get(continued), [answer]);
  for (const other of [request({ sessionId: 'other' }),
    request({ payload: { ...original.payload, callId: 'other' } }),
    request({ payload: { ...original.payload, questions: [{ id: 'q', question: 'Changed question' }] } })]) {
    assert.equal(restarted.get(other)[0].custom, '');
  }
  restarted.removeKey(restarted.keyOf(continued));
  assert.equal(createQuestionDraftCache({ storage: local }).get(continued)[0].custom, '');
});
test('unassociated questions never inherit a draft from a different request', () => {
  const cache = createQuestionDraftCache(), first = request({ sessionId: null });
  cache.get(first)[0].custom = 'private';
  assert.equal(cache.get({ ...first, id: 'different-request' })[0].custom, ''); cache.flush();
});
test('draft retention is bounded and expired/corrupt storage cannot create a stale answer', () => {
  let time = 100000000; const local = storage(), cache = createQuestionDraftCache({ storage: local, now: () => time });
  for (let i = 0; i < 40; i++) { const item = request({ sessionId: String(i) }); cache.get(item)[0].custom = 'draft'; cache.touch(item); }
  cache.flush(); assert.equal(JSON.parse(local.getItem('islandHud.questionDrafts.v1')).length, 32);
  time += 24 * 3600000 + 1;
  assert.equal(createQuestionDraftCache({ storage: local, now: () => time }).get(request({ sessionId: '39' }))[0].custom, '');
  local.setItem('islandHud.questionDrafts.v1', '{bad');
  assert.equal(createQuestionDraftCache({ storage: local }).get(request())[0].custom, '');
});
