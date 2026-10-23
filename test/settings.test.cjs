'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SettingsStore } = require('../src/app/settings-store.cjs');
function fixture(t) {
  const parent = path.resolve(__dirname, '../work/test-data'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('settings migrate in place preserving user choices and unknown keys; a fresh install has no automatic updates', t => {
  const file = path.join(fixture(t), 'settings.json');
  const store = new SettingsStore(file); assert.equal(store.value.autoCheckUpdates, false);
  fs.writeFileSync(file, JSON.stringify({ displayId: 42, autoCheckUpdates: true, autoHideFullscreen: true, hintShown: true, customSetting: 'kept' }));
  const reference = store.value; store.load();
  assert.equal(store.value, reference); assert.equal(store.value.customSetting, 'kept');
  assert.equal(store.value.displayId, 42); assert.equal(store.value.autoHideFullscreen, true);
  assert.equal(store.value.autoCheckUpdates, true); assert.equal(store.value.settingsVersion, 3);
  assert.equal(store.value.panelDensity, 'comfortable'); assert.equal(store.value.dshTimedQuestions, false);
  assert.equal(store.value.completionReveal, 'glance');
  assert.equal(store.save(), true);
  assert.equal(JSON.parse(fs.readFileSync(file)).hintShown, true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});
