'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { IntegrationHub } = require('../src/integrations/hub');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Island HUD 中文接口-'));
  const descriptor = path.join(dir, 'bridge.json');
  const changes = [], events = [];
  const hub = new IntegrationHub({ descriptorPath: descriptor, onChange: x => changes.push(x), onEvent: x => events.push(x) });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  hub.start();
  await until(() => fs.existsSync(descriptor));
  return { dir, descriptor, hub, changes, events };
}
async function until(check, ms = 3000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > ms) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 10)); }
}
module.exports = { fixture, until };
