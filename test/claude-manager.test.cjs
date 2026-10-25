'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ClaudeIntegrationManager } = require('../src/app/claude-integration-manager.cjs');

const SOURCE_DIR = path.join(__dirname, '../integrations/claude');

async function mfixture(t, initialConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-claude-mgr-'));
  const configPath = path.join(dir, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2) + '\n');
  const manager = new ClaudeIntegrationManager({ configPath, dataDir: dir, sourceDir: SOURCE_DIR });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath, manager, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

const deployedScript = (dir) => {
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'integrations/claude/state.json'), 'utf8'));
  return path.join(state.target, 'scripts', 'island-hook.cjs');
};
const ownedEntries = (fx, config, event) =>
  (config.hooks?.[event] || [])
    .filter(group => group.hooks?.some(entry => fx.manager.isOwnedEntry(entry)));

test('install writes every event hook with Claude schema and keeps unrelated keys', async (t) => {
  const fx = await mfixture(t, { env: { ANTHROPIC_MODEL: 'x' }, statusLine: { type: 'command', command: 'status.exe' } });
  const result = await fx.manager.install();
  assert.equal(result.changed, true);
  const config = fx.read();
  assert.equal(config.env.ANTHROPIC_MODEL, 'x');
  assert.equal(config.statusLine.command, 'status.exe');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PermissionRequest']) {
    assert.ok(ownedEntries(fx, config, event).length, event + ' entry missing');
  }
  const entry = ownedEntries(fx, config, 'PermissionRequest')[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.equal(entry.command, 'node');
  assert.equal(entry.timeout, 24 * 3600);
  assert.equal(entry.statusMessage, 'Island HUD');
  assert.ok(fs.existsSync(deployedScript(fx.dir)));
  assert.ok(fs.existsSync(path.join(fx.dir, 'integrations/claude/state.json')));
  const backupRoot = path.join(fx.dir, 'backups/claude');
  const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0], 'settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')),
    { env: { ANTHROPIC_MODEL: 'x' }, statusLine: { type: 'command', command: 'status.exe' } });
  const status = fx.manager.status();
  assert.equal(status.installed, true);
  assert.equal(status.managed, true);
  assert.match(status.reason, /等待 Claude Code 触发事件/);
});

test('user hook families (agent bridges) survive install and remove', async (t) => {
  const own = { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'C:\\tools\\agentbro.exe --source claude' }] }] },
    statusLine: { type: 'command', command: 'statusline.exe --source claude' } };
  const fx = await mfixture(t, own);
  await fx.manager.install();
  const installed = fx.read();
  assert.equal(installed.hooks.PermissionRequest.length, 2);
  assert.equal(installed.statusLine.command, 'statusline.exe --source claude');
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
  // Simulate a previous content-addressed bundle: rewrite the deployed script
  // path everywhere, as an older island-hud version would have left it.
  const current = deployedScript(fx.dir);
  const stalePath = current.replace(/packages[\\/]([^\\/-]+)-([0-9a-f]{20})/, 'packages/0.0.9-' + 'a'.repeat(20));
  let text = fs.readFileSync(fx.configPath, 'utf8').split(JSON.stringify(current).slice(1, -1)).join(JSON.stringify(stalePath).slice(1, -1));
  fs.writeFileSync(fx.configPath, text);
  const stateFile = path.join(fx.dir, 'integrations/claude/state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.target = path.dirname(path.dirname(stalePath));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

  const result = await fx.manager.install();
  assert.equal(result.changed, true);
  const reinstalled = fs.readFileSync(fx.configPath, 'utf8');
  assert.ok(!reinstalled.includes('0.0.9-'), 'stale bundle path should be replaced');
  const config = fx.read();
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PermissionRequest']) {
    const entries = ownedEntries(fx, config, event);
    assert.equal(entries.length, 1, event + ' should have exactly one owned group');
    assert.equal(entries[0].hooks[0].args[0], deployedScript(fx.dir));
  }
  assert.match(fx.manager.status().reason, /等待 Claude Code 触发事件/);
});

test('remove strips only the owned entries and restores scaffolded keys', async (t) => {
  const fx = await mfixture(t);
  await fx.manager.install();
  const result = await fx.manager.remove();
  assert.equal(result.changed, true);
  const config = fx.read();
  assert.equal(config.hooks, undefined);
  const backupRoot = path.join(fx.dir, 'backups/claude');
  assert.ok(fs.readdirSync(backupRoot).length >= 1);
  assert.equal(fx.manager.status().installed, false);
});

test('conflicting PermissionRequest hooks are detected, not blocked', async (t) => {
  const fx = await mfixture(t, { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'C:\\tools\\agentbro.exe --source claude' }] }] } });
  const result = await fx.manager.install();
  assert.match(result.conflict, /agentbro/);
  assert.equal(fx.manager.status().installed, true);
});

test('disableAllHooks surfaces a warning reason', async (t) => {
  const fx = await mfixture(t, { disableAllHooks: true });
  await fx.manager.install();
  const status = fx.manager.status();
  assert.equal(status.installed, true);
  assert.match(status.reason, /disableAllHooks/);
});

test('an unsupported config structure is rejected without changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-claude-bad-'));
  const configPath = path.join(dir, 'settings.json');
  fs.writeFileSync(configPath, '"just a string"');
  const manager = new ClaudeIntegrationManager({ configPath, dataDir: dir, sourceDir: SOURCE_DIR });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(Promise.resolve().then(() => manager.install()), /结构不受支持/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '"just a string"');
});

test('a non-array hooks event group is rejected without changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-claude-bad2-'));
  const configPath = path.join(dir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({ hooks: { Stop: { hooks: [] } } }));
  const manager = new ClaudeIntegrationManager({ configPath, dataDir: dir, sourceDir: SOURCE_DIR });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(Promise.resolve().then(() => manager.install()), /结构不受支持/);
});

test('status reports a missing Claude config as not installed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-claude-empty-'));
  const manager = new ClaudeIntegrationManager({
    configPath: path.join(dir, 'missing', 'settings.json'), dataDir: dir, sourceDir: SOURCE_DIR,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = manager.status();
  assert.equal(status.installed, false);
  assert.match(status.reason, /未找到 Claude Code 用户配置/);
});

test('observe feeds the connection status window', async (t) => {
  const fx = await mfixture(t);
  await fx.manager.install();
  const before = fx.manager.status();
  assert.equal(before.connected, false);
  fx.manager.observe({ provider: 'claude', payload: { pluginVersion: '0.1.0' } });
  const after = fx.manager.status();
  assert.equal(after.connected, true);
  assert.equal(after.hostVersion, '0.1.0');
  fx.manager.observe({ provider: 'dsh', payload: {} });
  assert.equal(fx.manager.status().connected, true);
});
