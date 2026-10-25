'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const declared = require(path.join(root, 'package.json')).devDependencies.electron;
const bundled = path.join(root, 'node_modules/electron/dist/electron.exe');
const electron = process.env.ISLAND_HUD_ELECTRON || (fs.existsSync(bundled) ? bundled : path.resolve(root, `../electron-${declared}/electron.exe`));
const version = execFileSync(electron, ['-p', 'process.versions.electron'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim();
if (version !== declared) throw new Error(`Preserved Electron ${declared} runtime required`);
const out = path.resolve(process.argv[2] || path.join(root, 'work/ui-tests', randomUUID()));
fs.mkdirSync(out, { recursive: true });
const cases = [['electron-runner.cjs', 'electron-test-result.json'], ['windows-input-runner.cjs', 'windows-input-result.json'],
  ['providers-runner.cjs', 'providers-result.json'], ['handoff-runner.cjs', 'handoff-result.json'],
  ['renderer-runner.cjs', 'renderer-result.json'], ['application-runner.cjs', 'application-result.json'],
  ['visual-runner.cjs', 'visual-result.json'], ['upgrade-runner.cjs', 'upgrade-result.json']];
const reports = [];
for (const [runner, reportName] of cases) {
  const testRoot = path.join(out, path.basename(runner, '.cjs'));
  fs.mkdirSync(testRoot, { recursive: true });
  // The approval handoff stays off everywhere except its dedicated runner.
  const env = { ...process.env, ISLAND_HUD_TEST_ROOT: testRoot, ISLAND_HUD_TEST_HANDOFF_SECONDS: '0' };
  for (const key of Object.keys(env)) {
    if (key === 'ISLAND_HUD_TEST_ROOT' || key === 'ISLAND_HUD_TEST_HANDOFF_SECONDS') continue;
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ISLAND_') || key === 'ISLAND_HUD_UPDATE_URL' || key === 'ISLAND_HUD_DSH_SESSIONS') delete env[key];
  }
  const scale = Number(process.env.ISLAND_HUD_TEST_SCALE || 1);
  const args = [path.join(root, 'test', runner)];
  if ([1, 1.25, 1.5].includes(scale) && scale !== 1) args.push('--force-device-scale-factor=' + scale);
  // The providers runner automates five real-click approvals plus a focus
  // relaunch; 25s left it one slow powershell call away from a hard kill.
  const run = spawnSync(electron, args, { cwd: root, windowsHide: true, timeout: 45000, env, encoding: 'utf8' });
  fs.writeFileSync(path.join(testRoot, 'stdout.log'), run.stdout || '');
  fs.writeFileSync(path.join(testRoot, 'stderr.log'), run.stderr || '');
  const report = fs.existsSync(path.join(testRoot, reportName)) ? JSON.parse(fs.readFileSync(path.join(testRoot, reportName))) : { status: 'failed', error: run.error?.message || 'Missing GUI report' };
  reports.push({ runner, ...report });
  console.log(runner + ': ' + report.status);
  if (run.status !== 0 || report.status !== 'passed') { process.exitCode = 1; break; }
}
fs.writeFileSync(path.join(out, 'ui-results.json'), JSON.stringify({ electron: version, reports }, null, 2));
console.log('GUI reports: ' + out);
