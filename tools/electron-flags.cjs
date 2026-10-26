'use strict';
// Extra Electron/Chromium switches for the GUI suites. Some hosts cannot start
// the Chromium sandbox (locked-down desktops, restricted CI containers), so the
// runner scripts accept them from the environment instead of hard-coding flags.
// Set ISLAND_HUD_ELECTRON_FLAGS="--no-sandbox" to run the suites there.
const ENV_NAME = 'ISLAND_HUD_ELECTRON_FLAGS';
function parseFlags(value = process.env[ENV_NAME]) {
  return String(value || '').split(/\s+/).filter(Boolean);
}
module.exports = { parseFlags, ENV_NAME };
