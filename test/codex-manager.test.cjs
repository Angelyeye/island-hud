'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CodexIntegrationManager } = require('../src/app/codex-integration-manager.cjs');

const SOURCE_DIR = path.join(__dirname, '../integrations/codex');

async function mfixture(t, initialConfig = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-codex-mgr-'));
  const configPath = path.join(dir, 'codex', 'hooks.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (initialConfig !== null) fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2) + '\n');
  const manager = new CodexIntegrationManager({ configPath, dataDir: dir, sourceDir: SOURCE_DIR });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath, manager, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

const deployedScript = (dir) => {
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'integrations/codex/state.json'), 'utf8'));
  return path.join(state.target, 'scripts', 'island-hook.cjs');
};
const ownedEntries = (fx, config, event) =>
  (config.hooks?.[event] || [])
    .filter(group => group.hooks?.some(entry => fx.manager.isOwnedEntry(entry)));

test('install writes every event hook with the native Codex schema', async (t) => {
  const fx = await mfixture(t, {});
  const result = await fx.manager.install();
  assert.equal(result.changed, true);
  const config = fx.read();
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest']) {
    assert.ok(ownedEntries(fx, config, event).length, event + ' entry missing');
  }
  const entry = ownedEntries(fx, config, 'PermissionRequest')[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.ok(entry.command.startsWith('node "'), 'command must be a quoted shell string');
  assert.ok(entry.command.endsWith('island-hook.cjs"'));
  assert.equal(entry.commandWindows, entry.command);
  assert.equal(entry.timeout, 6 * 3600);
  assert.equal(entry.statusMessage, 'Island HUD');
  assert.ok(fs.existsSync(deployedScript(fx.dir)));
  assert.ok(fs.existsSync(path.join(fx.dir, 'integrations/codex/state.json')));
  const backupRoot = path.join(fx.dir, 'backups/codex');
  const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0], 'hooks.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), {});
  const status = fx.manager.status();
  assert.equal(status.installed, true);
  assert.equal(status.managed, true);
  assert.match(status.reason, /\/hooks/);
});

test('install into an existing hooks.json preserves foreign top-level keys', async (t) => {
  const fx = await mfixture(t, { 'vibe-island': { command: 'python3 hook.py', events: ['session.start'] } });
  await fx.manager.install();
  const config = fx.read();
  assert.deepEqual(config['vibe-island'], { command: 'python3 hook.py', events: ['session.start'] });
  assert.ok(config.hooks.Stop.length);
  await fx.manager.remove();
  const restored = fx.read();
  assert.deepEqual(restored, { 'vibe-island': { command: 'python3 hook.py', events: ['session.start'] } });
});

test('user-owned hook groups survive install and remove', async (t) => {
  const own = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node C:\\tools\\mine.cjs' }] }] } };
  const fx = await mfixture(t, own);
  await fx.manager.install();
  const installed = fx.read();
  assert.equal(installed.hooks.Stop.length, 2);
  await fx.manager.remove();
  const restored = fx.read();
  assert.deepEqual(restored, own);
});

test('install is idempotent and reports no change on a second run', async (t) => {
  const fx = await mfixture(t);
  await fx.manager.install();
  const before = fs.readFileSync(fx.configPath, 'utf8');
  const result = await fx.manager.install();
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(fx.configPath, 'utf8'), before);
});

test('an upgraded bundle replaces stale owned groups instead of duplicating them', async (t) => {
  const fx = await mfixture(t);
  await fx.manager.install();
  const stateFile = path.join(fx.dir, 'integrations/codex/state.json');
  const current = deployedScript(fx.dir);
  const stalePath = current.replace(/packages[\\/]([^\\/-]+)-([0-9a-f]{20})/, 'packages/0.0.9-' + 'a'.repeat(20));
  const staleText = JSON.stringify(stalePath).slice(1, -1);
  let text = fs.readFileSync(fx.configPath, 'utf8').split(JSON.stringify(current).slice(1, -1)).join(staleText);
  fs.writeFileSync(fx.configPath, text);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.target = path.dirname(path.dirname(stalePath));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

  const result = await fx.manager.install();
  assert.equal(result.changed, true);
  const reinstalled = fs.readFileSync(fx.configPath, 'utf8');
  assert.ok(!reinstalled.includes('0.0.9-'), 'stale bundle path should be replaced');
  const config = fx.read();
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest']) {
    const entries = ownedEntries(fx, config, event);
    assert.equal(entries.length, 1, event + ' should have exactly one owned group');
  }
});

test('remove strips only the owned entries and restores the empty hooks key', async (t) => {
  const fx = await mfixture(t);
  await fx.manager.install();
  const result = await fx.manager.remove();
  assert.equal(result.changed, true);
  const config = fx.read();
  assert.equal(config.hooks, undefined);
  const backupRoot = path.join(fx.dir, 'backups/codex');
  assert.ok(fs.readdirSync(backupRoot).length >= 1);
  assert.equal(fx.manager.status().installed, false);
});

test('conflicting PermissionRequest hooks are detected, not blocked', async (t) => {
  const fx = await mfixture(t, { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'C:\\tools\\agentbro.exe --source codex' }] }] } });
  const result = await fx.manager.install();
  assert.match(result.conflict, /agentbro/);
  assert.equal(fx.manager.status().installed, true);
});

test('an unsupported config structure is rejected without changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-codex-bad-'));
  const configPath = path.join(dir, 'hooks.json');
  fs.writeFileSync(configPath, '"just a string"');
  const manager = new CodexIntegrationManager({ configPath, dataDir: dir, sourceDir: SOURCE_DIR });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(Promise.resolve().then(() => manager.install()), /结构不受支持/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '"just a string"');
});

test('status treats a missing hooks.json as not installed without an error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-codex-empty-'));
  const manager = new CodexIntegrationManager({
    configPath: path.join(dir, 'missing', 'hooks.json'), dataDir: dir, sourceDir: SOURCE_DIR,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = manager.status();
  assert.equal(status.installed, false);
  assert.equal(status.reason, '尚未安装 Codex 集成');
});

test('observe feeds the connection status window', async (t) => {
  const fx = await mfixture(t);
  await fx.manager.install();
  const before = fx.manager.status();
  assert.equal(before.connected, false);
  fx.manager.observe({ provider: 'codex', payload: { pluginVersion: '0.1.0' } });
  const after = fx.manager.status();
  assert.equal(after.connected, true);
  assert.equal(after.hostVersion, '0.1.0');
  fx.manager.observe({ provider: 'dsh', payload: {} });
  assert.equal(fx.manager.status().connected, true);
});
