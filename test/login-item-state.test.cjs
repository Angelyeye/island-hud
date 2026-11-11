'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loginItemEnabled } = require('../src/app/login-item-state.cjs');

const EXE = 'C:\\Program Files\\IslandHUD\\IslandHUD.exe';

test('Windows executable launch state wins when launchItems omit the registered Run entry', () => {
  assert.equal(loginItemEnabled({
    executableWillLaunchAtLogin: true,
    launchItems: [],
    openAtLogin: false,
  }, EXE), true);
});

test('launchItems remain a compatibility fallback and require an enabled matching executable', () => {
  assert.equal(loginItemEnabled({
    launchItems: [{ path: EXE.toUpperCase(), enabled: true }],
  }, EXE), true);
  assert.equal(loginItemEnabled({
    launchItems: [{ path: EXE, enabled: false }],
  }, EXE), false);
  assert.equal(loginItemEnabled({
    launchItems: [{ path: 'C:\\Other\\IslandHUD.exe', enabled: true }],
  }, EXE), false);
});

test('openAtLogin is used only when Windows returns neither of its richer states', () => {
  assert.equal(loginItemEnabled({ openAtLogin: true }, EXE), true);
  assert.equal(loginItemEnabled({ openAtLogin: false }, EXE), false);
  assert.equal(loginItemEnabled(null, EXE), false);
});
