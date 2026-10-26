'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DshIntegrationManager, NAME, OWNER } = require('../src/app/dsh-integration-manager.cjs');
function setup(t, initial = { name: 'test-profile', private: true }, hooks = {}) {
  const parent = path.resolve(__dirname, '../work/test-data'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'DSH 集成-'));
  const profileDir = path.join(root, '正常配置 desktop'), dataDir = path.join(root, '岛 数据');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(initial, null, 2));
  // A credential-bearing profile patch must remain byte-for-byte intact.
  const patch = Buffer.from('- id: unrelated-plugin\n  config:\n    token: fixture-only\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch);
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'fixture lockfile unchanged\n');
  const manager = new DshIntegrationManager({ profileDir, dataDir, sourceDir: path.resolve(__dirname, '../integrations/dsh'),
    descriptorPath: path.join(dataDir, 'integration-v2.json'), hooks });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profileDir, dataDir, manager, read: () => JSON.parse(fs.readFileSync(manager.manifest, 'utf8')), patch };
}
test('DSH install twice, repair and remove preserve other bundles, dependencies, patches and lockfile', t => {
  const initial = { name: 'test-profile', dependencies: { '@other/plugin': 'link:../other' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@other/plugin'], custom: 7 }, custom: true }, metadata: { kept: true } };
  const { manager, read, profileDir, patch } = setup(t, initial);
  manager.setTimedQuestions(true);
  const installed = manager.install(); assert.equal(installed.installed, true); assert.equal(installed.managed, true);
  assert.deepEqual(read().dsh.profile.bundles, [...initial.dsh.profile.bundles, NAME]);
  const target = manager.readLink();
  const packageJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./client'], './lib/navigation-client.js');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.ok(fs.existsSync(path.join(target, 'lib/navigation-client.js')));
  const bundlePatch = fs.readFileSync(path.join(target, 'cordis.patch.yml'), 'utf8');
  assert.match(bundlePatch, /id: preset-standard/);
  assert.match(bundlePatch, /id: tool-ask-user/);
  assert.match(bundlePatch, /mode: timed/);
  assert.match(bundlePatch, /timeout: 120/);
  assert.match(bundlePatch, /name: '@island-hud\/dsh-bridge'/);
  assert.equal(fs.existsSync(path.join(installed.backupDir, 'package.json')), true);
  assert.equal(manager.install().changed, false);
  fs.unlinkSync(manager.link); assert.equal(manager.status().installed, false);
  assert.equal(manager.install().installed, true);
  const current = read(); current.dependencies['@concurrent/plugin'] = '^1.0.0'; current.dsh.profile.bundles.unshift('@concurrent/plugin');
  fs.writeFileSync(manager.manifest, JSON.stringify(current));
  const removed = manager.remove(); assert.equal(removed.installed, false);
  assert.equal(read().dependencies['@concurrent/plugin'], '^1.0.0');
  assert.deepEqual(read().dsh.profile.bundles, ['@concurrent/plugin', ...initial.dsh.profile.bundles]);
  assert.equal(read().metadata.kept, true);
  assert.deepEqual(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml')), patch);
  assert.equal(fs.readFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'utf8'), 'fixture lockfile unchanged\n');
  assert.equal(manager.remove().changed, false);
});
test('DSH integration defaults to legacy questions and opts into timed mode only when requested', t => {
  const { manager } = setup(t);
  manager.install();
  let patch = fs.readFileSync(path.join(manager.readLink(), 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /island-hud-native-bridge/);
  assert.doesNotMatch(patch, /mode: timed/);
  manager.setTimedQuestions(true);
  manager.install();
  patch = fs.readFileSync(path.join(manager.readLink(), 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: preset-standard/);
  assert.match(patch, /mode: timed/);
  assert.match(patch, /timeout: 120/);
});
test('DSH install/remove restores absent scaffolding without deleting immutable package files', t => {
  const initial = { name: 'minimal-profile', private: true }, { manager, read } = setup(t, initial);
  manager.install(); const target = manager.readLink(); manager.remove();
  assert.deepEqual(read(), initial); assert.ok(fs.existsSync(path.join(target, 'index.mjs')));
  assert.equal(fs.existsSync(manager.link), false);
});
test('DSH fault after changing link rolls back and leaves an existing installation working', t => {
  const { manager, read } = setup(t);
  const before = read(); manager.hooks.afterLink = () => { throw new Error('injected write failure'); };
  assert.throws(() => manager.install(), /injected/);
  assert.deepEqual(read(), before); assert.equal(manager.readLink(), null); assert.equal(fs.existsSync(manager.journalFile), false);
  delete manager.hooks.afterLink; manager.install(); const state = manager.state(), manifest = fs.readFileSync(manager.manifest);
  manager.hooks.afterLink = () => { throw new Error('injected removal failure'); };
  assert.throws(() => manager.remove(), /injected/);
  assert.equal(manager.status().installed, true); assert.equal(manager.readLink(), state.target);
  assert.deepEqual(fs.readFileSync(manager.manifest), manifest);
});
test('DSH concurrent profile edits and externally replaced dependency are preserved', t => {
  const { manager, read } = setup(t);
  manager.hooks.beforeCommit = () => {
    const current = read(); current.changedByDsh = true; fs.writeFileSync(manager.manifest, JSON.stringify(current));
  };
  assert.throws(() => manager.install(), /configuration changed/);
  assert.equal(read().changedByDsh, true); assert.equal(read().dependencies, undefined); assert.equal(manager.readLink(), null);
  delete manager.hooks.beforeCommit; manager.install();
  const changed = read(); changed.dependencies[NAME] = 'link:C:/external/plugin'; fs.writeFileSync(manager.manifest, JSON.stringify(changed));
  assert.throws(() => manager.remove(), /changed outside/);
  assert.equal(read().dependencies[NAME], 'link:C:/external/plugin');
});
test('DSH recovers an interrupted manifest commit from its journal without restoring unrelated settings', t => {
  const { manager, read } = setup(t); manager.install();
  const state = manager.state(), before = fs.readFileSync(manager.manifest), afterValue = read(); afterValue.extra = 'retained';
  const after = Buffer.from(JSON.stringify(afterValue));
  fs.writeFileSync(manager.manifest, after);
  fs.writeFileSync(manager.journalFile, JSON.stringify({ owner: OWNER, profileDir: manager.profileDir, before: before.toString('base64'),
    after: after.toString('base64'), oldTarget: state.target, nextTarget: state.target, nextState: state }));
  manager.recover(); assert.equal(read().extra, 'retained'); assert.equal(manager.status().installed, true);
  assert.equal(fs.existsSync(manager.journalFile), false);
});
test('DSH connection status requires a recent event and reports plugin version changes', t => {
  const { manager } = setup(t); let now = 100000; manager.now = () => now;
  manager.install(); assert.equal(manager.status().connected, false);
  manager.observe({ provider: 'other' }); assert.equal(manager.status().connected, false);
  manager.observe({ provider: 'dsh', payload: { pluginVersion: '0.0.0' } });
  assert.equal(manager.status().connected, true); assert.match(manager.status().reason, /重启 DSH/);
  now += 45001; assert.equal(manager.status().connected, false);
});
test('a junction that lstat reports as a plain directory still resolves to the managed package', t => {
  const { manager } = setup(t);
  assert.equal(manager.install().installed, true);
  const target = manager.readLink();
  assert.ok(target);
  // Sandboxed or filtered Windows filesystems can hide the reparse point from
  // lstat while the native resolver still follows it.
  const realLstat = fs.lstatSync;
  fs.lstatSync = (file, ...args) => {
    const stat = realLstat(file, ...args);
    if (file !== manager.link || !stat.isSymbolicLink()) return stat;
    return { isSymbolicLink: () => false, isDirectory: () => true };
  };
  try {
    assert.equal(manager.readLink(), target);
    assert.equal(manager.status().installed, true);
  } finally {
    fs.lstatSync = realLstat;
  }
});
test('a real directory where the managed link belongs is still rejected', t => {
  const { manager } = setup(t);
  manager.install();
  fs.rmSync(manager.link, { recursive: true, force: true });
  fs.mkdirSync(manager.link, { recursive: true });
  assert.throws(() => manager.readLink(), /not a managed local link/);
});
test('remove still cleans up when Windows refuses to unlink the junction as a file', t => {
  const { manager, read } = setup(t);
  assert.equal(manager.install().installed, true);
  const target = manager.state().target;
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    if (String(file).includes('@island-hud')) {
      const error = new Error('EPERM: operation not permitted, unlink \'' + file + '\'');
      error.code = 'EPERM';
      throw error;
    }
    return realUnlink(file);
  };
  try {
    assert.equal(manager.remove().installed, false);
  } finally {
    fs.unlinkSync = realUnlink;
  }
  assert.equal(read().dependencies?.[NAME], undefined);
  assert.equal(fs.existsSync(manager.link), false);
  // The version directory that the link pointed at must survive the unlink.
  assert.equal(fs.existsSync(target), true);
});
