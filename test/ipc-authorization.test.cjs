'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aliveContents, senderMatches, trustedOverlay, trustedSettings, trustedClient } = require('../src/app/ipc-authorization.cjs');

const contents = () => ({ isDestroyed: () => false });

test('IPC authorization accepts only the matching live WebContents', () => {
  const overlay = contents(), settings = contents();
  assert.equal(aliveContents(overlay), true);
  assert.equal(senderMatches({ sender: overlay }, overlay), true);
  assert.equal(senderMatches({ sender: settings }, overlay), false);
  assert.equal(senderMatches({ sender: overlay }, { isDestroyed: () => true }), false);
  assert.equal(senderMatches(null, overlay), false);
});

test('overlay and settings sources are kept separate, while client reads may accept either', () => {
  const overlay = contents(), settings = contents();
  assert.equal(trustedOverlay({ sender: overlay }, { webContents: overlay }), true);
  assert.equal(trustedOverlay({ sender: settings }, { webContents: overlay }), false);
  assert.equal(trustedSettings({ sender: settings }, { webContents: settings }), true);
  assert.equal(trustedSettings({ sender: overlay }, { webContents: settings }), false);
  assert.equal(trustedClient({ sender: overlay }, { overlayWindow: { webContents: overlay }, settingsWindow: { webContents: settings } }), true);
  assert.equal(trustedClient({ sender: settings }, { overlayWindow: { webContents: overlay }, settingsWindow: { webContents: settings } }), true);
  assert.equal(trustedClient({ sender: {} }, { overlayWindow: { webContents: overlay }, settingsWindow: { webContents: settings } }), false);
});
