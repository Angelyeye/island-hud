'use strict';
// Exercises our actual installer against an owned directory and disposable DSH profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 60000) {
  const start = Date.now(); while (!await check()) { if (Date.now() - start > ms) throw new Error('Installer condition timed out'); await pause(100); }
}
function registry() {
  const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $items = @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Island HUD*' } | Select-Object PSChildName,DisplayName,InstallLocation,UninstallString); ConvertTo-Json -InputObject $items -Compress";
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).replace(/^\uFEFF/, '') || '[]');
}
async function main() {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass candidate and a new owned result directory');
  const build = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
  const resume = process.argv.includes('--resume'), installDir = path.join(out, '安装 目录');
  if (fs.existsSync(out) && !resume) throw new Error('Result directory must be new');
  if (resume && JSON.parse(fs.readFileSync(path.join(out, 'installer-result.json'), 'utf8')).installDir !== installDir) throw new Error('Resume requires the same owned failed test directory');
  const existing = registry();
  if (existing.length && !(resume && existing.length === 1 && existing[0].UninstallString?.toLowerCase().includes(installDir.toLowerCase()))) throw new Error('An existing Island HUD installation is registered; preserved it instead of replacing its installer registration');
  fs.mkdirSync(out, { recursive: true });
  const checks = [], root = path.join(out, '隔离 数据');
  fs.mkdirSync(root, { recursive: true });
  const env = { ...process.env, ISLAND_HUD_TEST_ROOT: root };
  for (const key of Object.keys(env)) if (key !== 'ISLAND_HUD_TEST_ROOT' && (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ISLAND_')) || key === 'ISLAND_HUD_DSH_SESSIONS' || key === 'ISLAND_HUD_BRIDGE_FILE') delete env[key];
  const installer = fs.readdirSync(path.join(build, 'installer')).filter(name => /^IslandHUD-.*Setup-x64\.exe$/.test(name));
  assert.equal(installer.length, 1);
  const setup = path.join(build, 'installer', installer[0]), exe = path.join(installDir, 'IslandHUD.exe');
  function start(file, args, overrides = {}) {
    const child = spawn(file, args, { env: { ...env, ...overrides }, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
    return { child, done: new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Owned installer process did not finish: ' + child.pid)), 120000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(code) : reject(new Error('Owned installer exited ' + code)); });
    }) };
  }
  let running;
  try {
    await start(setup, ['/S', '/D=' + installDir]).done;
    await until(() => fs.existsSync(exe));
    const keys = registry(); assert.equal(keys.length, 1); assert.ok(keys[0].UninstallString?.toLowerCase().includes(installDir.toLowerCase()));
    const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(sha(exe), sha(path.join(build, 'portable/IslandHUD.exe')));
    const expectedManifest = JSON.parse(fs.readFileSync(path.join(build, 'portable/FILE-MANIFEST.json')));
    assert.equal(sha(path.join(installDir, 'FILE-MANIFEST.json')), sha(path.join(build, 'portable/FILE-MANIFEST.json')));
    for (const file of expectedManifest.files) assert.equal(sha(path.join(installDir, file.path)), file.sha256, 'Installed resource differs: ' + file.path);
    checks.push('actual NSIS installs the same tested application per-user into a Chinese/space directory');
    const profileDir = path.join(root, 'dsh/profiles/desktop'); fs.mkdirSync(profileDir, { recursive: true });
    const initial = { name: 'installer-native-fixture', dependencies: { unrelated: 'kept' }, dsh: { profile: { bundles: ['unrelated'] } } };
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(initial));
    const { DshIntegrationManager } = require(path.join(installDir, 'resources/app/src/app/dsh-integration-manager.cjs'));
    const manager = new DshIntegrationManager({ profileDir, dataDir: root, sourceDir: path.join(installDir, 'resources/app/integrations/dsh'), descriptorPath: path.join(root, 'integration-v2.json') });
    manager.install(); const installed = fs.readFileSync(manager.manifest);
    running = start(exe, []); running.done.catch(() => {});
    await until(() => fs.existsSync(path.join(root, 'integration-v2.json')));
    await start(setup, ['/S', '/D=' + installDir]).done;
    await running.done; running = null;
    assert.deepEqual(fs.readFileSync(manager.manifest), installed); assert.equal(manager.status().installed, true);
    checks.push('reinstall/upgrade gracefully closes its own running application and keeps DSH integration and other plugins');
    const diagnostic = path.join(root, 'installed-diagnostics.json');
    await start(exe, [], { ISLAND_TEST_DIAGNOSTICS: diagnostic }).done;
    const report = JSON.parse(fs.readFileSync(diagnostic, 'utf8'));
    assert.equal(report.packaged, true); assert.equal(report.version, require('../package.json').version);
    checks.push('the installed application starts with the expected version and writes diagnostics');
    const uninstallers = fs.readdirSync(installDir).filter(name => /^Uninstall.*\.exe$/i.test(name)); assert.equal(uninstallers.length, 1);
    await start(path.join(installDir, uninstallers[0]), ['/S']).done;
    await until(() => !fs.existsSync(exe) && registry().length === 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(manager.manifest, 'utf8')), initial);
    assert.equal(manager.status().installed, false);
    checks.push('actual NSIS uninstall removes installed files, registration, and only its DSH integration; backups remain');
    fs.writeFileSync(path.join(out, 'installer-result.json'), JSON.stringify({ status: 'passed', checks,
      version: report.version, portableManifestSha256: sha(path.join(build, 'portable/FILE-MANIFEST.json')),
      installerSha256: sha(setup), scope: 'Actual installer and isolated profile; native DSH runtime verification is separate.' }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: checks.length }));
  } catch (error) {
    if (running) start(exe, ['--quit-for-maintenance']).done.catch(() => {});
    fs.writeFileSync(path.join(out, 'installer-result.json'), JSON.stringify({ status: 'failed', checks, installDir, error: error.stack }, null, 2));
    throw error;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
