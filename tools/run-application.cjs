'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const electron = process.env.ISLAND_HUD_ELECTRON || path.join(root, 'node_modules/electron/dist/electron.exe');
// The runtime must match the locked devDependency so development, tests and
// packaging all observe the same Chromium/Node behaviour.
const declared = require(path.join(root, 'package.json')).devDependencies.electron;
if (!fs.existsSync(electron)) throw new Error(`Electron ${declared} runtime required; install locked dependencies or set ISLAND_HUD_ELECTRON`);
if (execFileSync(electron, ['-p', 'process.versions.electron'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim() !== declared) throw new Error(`Preserved Electron ${declared} runtime required`);
const env = { ...process.env, ISLAND_HUD_TEST_ROOT: process.env.ISLAND_HUD_TEST_ROOT || path.join(root, 'work/development') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(root, 'src/main.js'), ...process.argv.slice(2)], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
