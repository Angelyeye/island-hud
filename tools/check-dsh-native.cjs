'use strict';
// Run with the installed DSH Electron executable in Node mode. This reads its
// shipped public configuration composer; it does not boot an agent or UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const installation = process.argv[2];
  if (!installation || !path.isAbsolute(installation)) throw new Error('Pass the installed DSH directory');
  const boot = path.join(installation, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  const { composeEntries, loadOverlayPatches } = await import(pathToFileURL(boot).href);
  const patch = path.resolve(process.argv[3] || path.join(__dirname, '../integrations/dsh/cordis.patch.yml'));
  const rows = composeEntries([loadOverlayPatches('dsh', patch)]);
  const bridge = rows.filter(row => row.id === 'island-hud-native-bridge');
  assert.equal(bridge.length, 1, 'Bundle must insert exactly one loader entry into an empty composition');
  assert.equal(bridge[0].name, '@island-hud/dsh-bridge');
  // An orphan override is silently skipped by the native composer. Guard the
  // actual loader boundary instead of merely checking YAML text.
  assert.equal(composeEntries([[{ id: 'missing-row', name: '@island-hud/dsh-bridge' }]], () => {}).length, 0);
  const result = { status: 'passed', check: 'native DSH bundle composition', entries: bridge.map(({ id, name }) => ({ id, name })) };
  if (process.env.ISLAND_HUD_NATIVE_CHECK_RESULT) fs.writeFileSync(process.env.ISLAND_HUD_NATIVE_CHECK_RESULT, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
