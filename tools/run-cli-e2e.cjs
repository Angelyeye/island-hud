'use strict';
// Real-CLI end-to-end check: drives the actual `claude` and `codex` binaries
// against sandboxed configuration directories so their hooks reach the real
// island and every approval is answered by the app itself.
//
// Opt-in by design — it spends a small amount of model quota and needs the
// CLIs installed:
//   ISLAND_HUD_E2E=1 npm run test:e2e
// Without the flag (or without a CLI on PATH) the run reports a skip.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const declared = require(path.join(root, 'package.json')).devDependencies.electron;
const bundled = path.join(root, 'node_modules/electron/dist/electron.exe');
const electron = process.env.ISLAND_HUD_ELECTRON || (fs.existsSync(bundled) ? bundled : path.resolve(root, `../electron-${declared}/electron.exe`));

function cliAvailable(command) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 30000, shell: true });
  return probe.status === 0 ? String(probe.stdout || '').trim() : null;
}

if (process.env.ISLAND_HUD_E2E !== '1') {
  console.log('test:e2e 跳过：需要 ISLAND_HUD_E2E=1（会运行真实 claude/codex 并消耗少量模型额度）');
  process.exit(0);
}
const claudeVersion = cliAvailable('claude');
const codexVersion = cliAvailable('codex');
if (!claudeVersion && !codexVersion) {
  console.log('test:e2e 跳过：本机未安装 claude / codex CLI');
  process.exit(0);
}
const version = execFileSync(electron, ['-p', 'process.versions.electron'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim();
if (version !== declared) throw new Error(`Preserved Electron ${declared} runtime required`);

const out = path.resolve(process.argv[2] || path.join(root, 'work/cli-e2e', randomUUID()));
fs.mkdirSync(out, { recursive: true });
const testRoot = path.join(out, 'e2e');
fs.mkdirSync(testRoot, { recursive: true });
const env = { ...process.env, ISLAND_HUD_TEST_ROOT: testRoot, ISLAND_HUD_E2E: '1',
  ISLAND_HUD_E2E_CLAUDE: claudeVersion ? '1' : '', ISLAND_HUD_E2E_CODEX: codexVersion ? '1' : '' };
for (const key of Object.keys(env)) {
  if (key === 'ISLAND_HUD_TEST_ROOT' || key === 'ISLAND_HUD_E2E' || key === 'ISLAND_HUD_E2E_CLAUDE' || key === 'ISLAND_HUD_E2E_CODEX') continue;
  if (key.startsWith('ISLAND_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
}
console.log(`claude ${claudeVersion || '（跳过）'} · codex ${codexVersion || '（跳过）'}`);
const run = spawnSync(electron, [path.join(root, 'test', 'cli-e2e-runner.cjs')], {
  cwd: root, windowsHide: true, timeout: 420000, env, encoding: 'utf8',
});
fs.writeFileSync(path.join(testRoot, 'stdout.log'), run.stdout || '');
fs.writeFileSync(path.join(testRoot, 'stderr.log'), run.stderr || '');
const report = path.join(testRoot, 'cli-e2e-result.json');
if (fs.existsSync(report)) {
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  for (const check of result.checks || []) console.log('✓ ' + check);
  for (const skip of result.skipped || []) console.log('- ' + skip);
  console.log('E2E 报告: ' + report);
  if (result.status !== 'passed') {
    console.error((result.error || 'unknown failure').split('\n').slice(0, 12).join('\n'));
    process.exitCode = 1;
  }
} else {
  console.error('E2E runner produced no report');
  console.error((run.stderr || run.stdout || '').split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
}
