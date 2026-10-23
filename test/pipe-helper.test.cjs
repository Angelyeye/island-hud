'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { IntegrationHub } = require('../src/integrations/hub');
const { exchange } = require('../src/integrations/client');
const { until } = require('./helpers.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('compiled secure pipe helper drains both directions through repeated concurrent connection churn', async t => {
  require('../tools/build-helpers.cjs').build();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-pipe-churn-')), descriptor = path.join(dir, 'descriptor.json');
  let received = 0;
  const hub = new IntegrationHub({ descriptorPath: descriptor, helperPath: path.resolve(__dirname, '../src/tools/pipe-host.exe'), onEvent: () => received++ });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  hub.start(); await until(() => hub.secured && fs.existsSync(descriptor), 6000);
  // The descriptor appears before the helper's pipe is accepting; warm up so the
  // first churn batch does not race the helper startup on slow CI machines.
  let warmed = false;
  const warmDeadline = Date.now() + 8000;
  while (!warmed && Date.now() < warmDeadline) {
    const probe = await exchange({ provider: 'dsh', id: 'churn-warmup', kind: 'event', payload: { event: 'PluginHeartbeat' } }, { descriptor });
    warmed = probe.status === 'received';
    if (!warmed) await pause(100);
  }
  assert.ok(warmed, 'the helper did not accept a warm-up frame');
  const baseline = received;
  for (let batch = 0; batch < 10; batch++) {
    const request = index => exchange({ provider: 'dsh', id: 'churn-' + batch + '-' + index, kind: 'event', payload: { event: 'PluginHeartbeat' } }, { descriptor });
    let results = await Promise.all(Array.from({ length: 8 }, (_, i) => request(i)));
    for (let attempt = 1; attempt < 3 && !results.every(result => result.status === 'received'); attempt++) {
      await pause(100);
      results = await Promise.all(Array.from({ length: 8 }, (_, i) => results[i].status === 'received' ? results[i] : request(i)));
    }
    assert.ok(results.every(result => result.status === 'received'), 'churn batch ' + batch + ': ' + JSON.stringify(results.map(result => result.status)));
  }
  await until(() => hub.sockets.size === 0);
  assert.equal(received, baseline + 80); assert.equal(hub.pending.size, 0); assert.ok(hub.helper?.pid);
});
