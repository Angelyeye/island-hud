'use strict';
// Keep the isolated stage-0 command compatible, using the application's real UI.
const path = require('node:path');
if (!process.env.ISLAND_HUD_TEST_ROOT || !path.isAbsolute(process.env.ISLAND_HUD_TEST_ROOT)) {
  throw new Error('ISLAND_HUD_TEST_ROOT must be an absolute isolated directory');
}
require('../main.js');
