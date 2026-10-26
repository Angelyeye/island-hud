'use strict';
// The integration descriptor is how every client discovers the island. A host
// whose user-data directory is missing or read-only must not lose the whole
// application to an uncaught ENOENT from this best-effort bookkeeping file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IntegrationHub } = require('../src/integrations/hub');

test('the descriptor is written even when its directory does not exist yet', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-descriptor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const descriptor = path.join(dir, 'missing', 'nested', 'integration-v2.json');
  const hub = new IntegrationHub({ descriptorPath: descriptor });
  assert.equal(fs.existsSync(path.dirname(descriptor)), false);
  hub.writeDescriptor();
  const written = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  assert.equal(written.v, 2);
  assert.equal(written.pipe, hub.pipeName);
  assert.equal(written.token, hub.token);
  assert.equal(written.pid, process.pid);
});

test('a descriptor that cannot be written is logged instead of crashing the host', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-descriptor-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const logs = [];
  const hub = new IntegrationHub({ descriptorPath: path.join(blocker, 'integration-v2.json'), log: line => logs.push(line) });
  assert.doesNotThrow(() => hub.writeDescriptor());
  assert.ok(logs.some(line => /descriptor/i.test(line)), JSON.stringify(logs));
});
