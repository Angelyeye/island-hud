'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexThreadUri, openCodexThread } = require('../src/app/codex-client.cjs');

const SESSION_ID = '01a17767-dd97-7cb3-801e-2447ecc6b85f';

test('Codex sessions use the official exact-thread deep link', async () => {
  assert.equal(codexThreadUri(SESSION_ID), `codex://threads/${SESSION_ID}`);
  const opened = [];
  const result = await openCodexThread(SESSION_ID, {
    openExternal: async uri => opened.push(uri),
  });
  assert.deepEqual(opened, [`codex://threads/${SESSION_ID}`]);
  assert.deepEqual(result, { status: 'navigated', sessionId: SESSION_ID });
});

test('Codex thread identifiers are encoded and invalid or unavailable launches fail explicitly', async () => {
  assert.equal(codexThreadUri(' thread?mode=work '), 'codex://threads/thread%3Fmode%3Dwork');
  assert.equal(codexThreadUri(''), null);
  assert.equal(codexThreadUri(null), null);
  assert.equal(codexThreadUri('x'.repeat(129)), null);
  assert.match((await openCodexThread('', { openExternal: async () => {} })).reason, /标识无效/);
  assert.match((await openCodexThread(SESSION_ID, { openExternal: async () => { throw new Error('missing'); } })).reason,
    /codex:\/\/ 协议/);
});
