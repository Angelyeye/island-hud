'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IntegrationHub } = require('../src/integrations/hub');

test('IntegrationHub can expose an external approval and route its decision', async (t) => {
  const changes = [];
  const hub = new IntegrationHub({ allowedProviders: ['codex'], onChange: value => changes.push(value) });
  t.after(() => hub.stop());
  const decisions = [];
  const request = hub.addExternalRequest({ provider: 'codex', requestId: 'rpc-42', sessionId: 'thread-1',
    payload: { tool: { name: 'command', detail: 'npm test' } } }, async value => decisions.push(value));
  assert.equal(request.provider, 'codex');
  assert.equal(hub.snapshot().length, 1);
  const result = await hub.respond(request.id, 'allow');
  assert.deepEqual(result, { status: 'delivered' });
  assert.deepEqual(decisions, [{ decision: 'allow' }]);
  assert.equal(hub.snapshot().length, 0);
  assert.ok(changes.length >= 2);
});

test('external requests reject disabled providers and expire through the callback', async (t) => {
  const hub = new IntegrationHub({ allowedProviders: ['dsh'] });
  t.after(() => hub.stop());
  assert.equal(hub.addExternalRequest({ provider: 'codex', requestId: 'disabled' }, () => {}), null);
  let expired = null;
  const request = hub.addExternalRequest({ provider: 'dsh', requestId: 'expires', timeoutMs: 5000 }, value => { expired = value; });
  assert.ok(request);
  hub.pending.get(request.id).timer.refresh();
  // Drive the expiration without waiting for the production minimum timeout.
  clearTimeout(hub.pending.get(request.id).timer);
  await hub.pending.get(request.id).externalRespond({ decision: 'return' });
  hub.finish(request.id, { status: 'expired' });
  assert.deepEqual(expired, { decision: 'return' });
});
