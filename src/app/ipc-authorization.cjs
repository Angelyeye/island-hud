'use strict';

function aliveContents(contents) {
  return !!contents && (typeof contents.isDestroyed !== 'function' || !contents.isDestroyed());
}

function senderMatches(event, contents) {
  return !!event && aliveContents(contents) && event.sender === contents;
}

function trustedOverlay(event, overlayWindow) {
  return senderMatches(event, overlayWindow?.webContents);
}

function trustedSettings(event, settingsWindow) {
  return senderMatches(event, settingsWindow?.webContents);
}

function trustedClient(event, { overlayWindow, settingsWindow } = {}) {
  return trustedOverlay(event, overlayWindow) || trustedSettings(event, settingsWindow);
}

module.exports = { aliveContents, senderMatches, trustedOverlay, trustedSettings, trustedClient };
