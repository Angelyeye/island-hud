'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Restricted hosts pass extra Chromium switches through ISLAND_HUD_ELECTRON_FLAGS.
const electronFlags = require('./electron-flags.cjs').parseFlags();
const declared = require(path.join(root, 'package.json')).devDependencies.electron;
const bundled = path.join(root, 'node_modules/electron/dist/electron.exe');
const sibling = path.resolve(root, `../electron-${declared}/electron.exe`);
const electron = process.env.ISLAND_HUD_TEST_EXECUTABLE || process.env.ISLAND_HUD_ELECTRON ||
  (fs.existsSync(bundled) ? bundled : sibling);
if (!fs.existsSync(electron)) throw new Error('Electron runtime not found; set ISLAND_HUD_ELECTRON');
const packaged = path.basename(electron).toLowerCase() === 'islandhud.exe';
const testRoot = path.join(root, 'work', 'tray-menu-tests', randomUUID());
fs.mkdirSync(testRoot, { recursive: true });
const env = {
  ...process.env,
  ISLAND_HUD_TEST_ROOT: testRoot,
  ISLAND_TEST_TRAY_MENU: '1',
  ISLAND_TEST_NO_SHORTCUTS: '1',
  ISLAND_DIAG_FILE: path.join(testRoot, 'application.log'),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [...electronFlags, ...(packaged ? [] : [path.join(root, 'src/main.js')])], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', value => { stdout += value; });
child.stderr.on('data', value => { stderr += value; });
const timer = setTimeout(() => {
  try { child.kill(); } catch { /* no-op */ }
}, 20000);
child.on('exit', code => {
  clearTimeout(timer);
  fs.writeFileSync(path.join(testRoot, 'stdout.log'), stdout);
  fs.writeFileSync(path.join(testRoot, 'stderr.log'), stderr);
  const resultFile = path.join(testRoot, 'tray-menu-result.json');
  const report = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : { status: 'failed', error: `Missing tray report; exit=${code}; stderr=${stderr.slice(-500)}` };
  if (code === 0 && report.status === 'passed') {
    report.checks = [...(report.checks || []), 'quit command exited the packaged application with code 0'];
  }
  report.outputDirectory = testRoot;
  fs.writeFileSync(path.join(testRoot, 'tray-menu-summary.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (code !== 0 || report.status !== 'passed') process.exitCode = 1;
});
