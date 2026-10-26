'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const NAME = '@island-hud/dsh-bridge';
const OWNER = 'island-hud-dsh-integration-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
// Removes a managed link without ever touching the directory it points at.
// Windows filesystems can report a junction as a directory and refuse the
// RemoveFile that unlink uses, so fall back to rmdir (which only removes the
// link itself, and fails on a real non-empty directory instead of deleting it).
function removeLink(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EISDIR') throw error;
    fs.rmdirSync(file);
  }
}
function atomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

/** Owns one profile dependency and bundle selection. Never reads provider credentials or edits client binaries. */
class DshIntegrationManager {
  constructor({ profileDir, dataDir, sourceDir, descriptorPath, navigationPath = '', now = Date.now, hooks = {}, timedQuestions = false }) {
    for (const value of [profileDir, dataDir, sourceDir, descriptorPath]) if (!path.isAbsolute(value)) throw new Error('Absolute integration paths required');
    if (navigationPath && !path.isAbsolute(navigationPath)) throw new Error('Absolute navigation descriptor path required');
    Object.assign(this, { profileDir, dataDir, sourceDir, descriptorPath, navigationPath, now, hooks, timedQuestions: !!timedQuestions });
    this.manifest = path.join(profileDir, 'package.json');
    this.link = path.join(profileDir, 'node_modules', ...NAME.split('/'));
    this.home = path.join(dataDir, 'integrations/dsh');
    this.stateFile = path.join(this.home, 'state.json');
    this.journalFile = path.join(this.home, 'transaction.json');
    this.lastSeen = 0; this.hostVersion = null;
  }
  setTimedQuestions(enabled) { this.timedQuestions = !!enabled; }
  observe(envelope) {
    if (envelope.provider !== 'dsh') return;
    this.lastSeen = this.now();
    if (envelope.payload?.pluginVersion) this.hostVersion = envelope.payload.pluginVersion;
  }
  readProfile() {
    const bytes = fs.readFileSync(this.manifest);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('DSH profile manifest is too large');
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!object(value) || (value.dependencies !== undefined && !object(value.dependencies)) ||
      (value.dsh !== undefined && !object(value.dsh)) ||
      (value.dsh?.profile !== undefined && !object(value.dsh.profile)) ||
      (value.dsh?.profile?.bundles !== undefined && (!Array.isArray(value.dsh.profile.bundles) || value.dsh.profile.bundles.some(x => typeof x !== 'string')))) {
      throw new Error('DSH profile manifest has an unsupported structure');
    }
    return { bytes, value };
  }
  readLink() {
    let stat;
    try { stat = fs.lstatSync(this.link); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) return path.resolve(path.dirname(this.link), fs.readlinkSync(this.link));
    // Sandboxed and filtered Windows filesystems can expose a junction to lstat as
    // a plain directory while the native resolver still follows the reparse point.
    try {
      const resolved = fs.realpathSync.native(this.link);
      if (!samePath(resolved, this.link)) return resolved;
    } catch { /* fall through to the explicit error */ }
    throw new Error('The DSH bridge package is not a managed local link; remove it in DSH before replacing it');
  }
  replaceLink(target) {
    const current = this.readLink();
    if ((!target && !current) || (target && current && samePath(target, current))) return;
    fs.mkdirSync(path.dirname(this.link), { recursive: true });
    const suffix = randomUUID(), temp = this.link + '.' + suffix + '.new', old = this.link + '.' + suffix + '.old';
    if (target) fs.symlinkSync(target, temp, process.platform === 'win32' ? 'junction' : 'dir');
    if (current) fs.renameSync(this.link, old);
    try { if (target) fs.renameSync(temp, this.link); }
    catch (error) { if (current) fs.renameSync(old, this.link); throw error; }
    finally { if (fs.existsSync(temp)) removeLink(temp); }
    if (current) removeLink(old); // Removes the link itself, never its target directory.
  }
  state() {
    if (!fs.existsSync(this.stateFile)) return null;
    const value = json(this.stateFile);
    if (value.owner !== OWNER || !samePath(value.profileDir, this.profileDir)) throw new Error('DSH integration state belongs to another profile');
    return value;
  }
  status() {
    const base = { profileDir: this.profileDir, installed: false, connected: false, managed: false, version: null, timedQuestions: this.timedQuestions, reason: '' };
    try {
      const { value } = this.readProfile(), spec = value.dependencies?.[NAME], selected = value.dsh?.profile?.bundles?.includes(NAME);
      const state = this.state(), target = this.readLink();
      base.installed = !!spec && !!selected && !!target && fs.existsSync(path.join(target, 'index.mjs'));
      base.managed = !!state && spec === state.spec && !!target && samePath(target, state.target);
      base.version = target && fs.existsSync(path.join(target, 'package.json')) ? json(path.join(target, 'package.json')).version : null;
      base.configuredTimedQuestions = !!state?.timedQuestions;
      base.connected = base.installed && this.now() - this.lastSeen < 45000 && this.lastSeen > 0;
      base.hostVersion = this.hostVersion;
      base.lastSeen = this.lastSeen || null;
      if (fs.existsSync(this.journalFile)) base.reason = '上次集成操作未完成，请点击修复以恢复事务';
      else if (base.installed && base.configuredTimedQuestions !== this.timedQuestions) base.reason = '问答模式尚未应用；请点击安装 / 修复，然后正常重启 DSH';
      else if (base.connected && base.hostVersion && base.hostVersion !== base.version) base.reason = '配置已更新；请正常重启 DSH 加载新版本';
      else if (base.connected) base.reason = 'DSH 插件已连接';
      else if (base.installed) base.reason = '插件已配置，等待 DSH 连接；首次安装或修复后请正常重启 DSH';
      else if (spec || selected || target) base.reason = '插件配置不完整，请点击修复';
      else base.reason = '尚未安装 DSH 集成';
    } catch (error) { base.reason = error.code === 'ENOENT' ? '未找到当前 DSH 配置，请先启动 DSH 完成首次设置' : error.message; }
    return base;
  }
  withLock(action) {
    fs.mkdirSync(this.home, { recursive: true });
    const lock = path.join(this.home, 'operation.lock');
    if (fs.existsSync(lock)) {
      const holder = json(lock);
      let alive = true;
      try { process.kill(holder.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Another DSH integration operation is in progress');
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, encoded({ owner: OWNER, pid: process.pid })); this.recover(); return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  recover() {
    if (!fs.existsSync(this.journalFile)) return;
    const txn = json(this.journalFile);
    if (txn.owner !== OWNER || !samePath(txn.profileDir, this.profileDir)) throw new Error('Invalid DSH integration recovery journal');
    const current = fs.readFileSync(this.manifest), hash = digest(current), link = this.readLink();
    if (hash === digest(Buffer.from(txn.after, 'base64')) &&
      ((!link && !txn.nextTarget) || (link && txn.nextTarget && samePath(link, txn.nextTarget)))) {
      if (txn.nextState) atomic(this.stateFile, encoded({ ...txn.nextState, backupDir: txn.backupDir }));
      else if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile);
    } else if (hash === digest(Buffer.from(txn.before, 'base64')) &&
      ((!link && (!txn.oldTarget || !txn.nextTarget)) || (link && [txn.oldTarget, txn.nextTarget].filter(Boolean).some(p => samePath(p, link))))) {
      this.replaceLink(txn.oldTarget);
    } else {
      throw new Error('DSH configuration changed during an unfinished operation; preserved the current configuration and recovery backup');
    }
    fs.unlinkSync(this.journalFile);
  }
  navigationEndpoint() {
    if (!this.navigationPath) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.navigationPath, 'utf8'));
      if (!value || value.v !== 1) return null;
      if (!Number.isInteger(value.port) || value.port <= 0) return null;
      if (typeof value.token !== 'string' || !/^[a-f0-9]{48}$/.test(value.token)) return null;
      const suffix = typeof value.path === 'string' && value.path.startsWith('/') ? value.path : '/island-hud/navigate';
      return `http://127.0.0.1:${value.port}${suffix}?token=${value.token}`;
    } catch { return null; }
  }
  prepareBundle() {
    const files = new Map();
    for (const name of ['index.mjs', 'lib/client.cjs', 'lib/contract.cjs', 'lib/navigation-client.js']) {
      files.set(name, fs.readFileSync(path.join(this.sourceDir, name)));
    }
    const endpoint = this.navigationEndpoint();
    if (endpoint) {
      const navigation = files.get('lib/navigation-client.js').toString('utf8').replace('__ISLAND_HUD_NAV_ENDPOINT__', endpoint);
      files.set('lib/navigation-client.js', Buffer.from(navigation));
    }
    const manifest = json(path.join(this.sourceDir, 'package.json'));
    if (manifest.name !== NAME || !/^[0-9]+\.[0-9]+\.[0-9]+[\w.-]*$/.test(manifest.version)) throw new Error('Invalid DSH bridge package');
    manifest.islandHud = { owner: OWNER };
    files.set('package.json', Buffer.from(encoded(manifest)));
    const bridgePatch = [
      '- insert:',
      '    - id: island-hud-native-bridge',
      "      name: '@island-hud/dsh-bridge'",
      '      config:',
      '        descriptorPath: ' + JSON.stringify(this.descriptorPath),
      '',
    ].join('\n');
    const patch = this.timedQuestions
      ? fs.readFileSync(path.join(this.sourceDir, 'preset-standard.patch.yml'), 'utf8').replace(/\n+$/, '') + '\n' + bridgePatch
      : bridgePatch;
    files.set('cordis.patch.yml', Buffer.from(patch));
    const hash = createHash('sha256');
    for (const [name, bytes] of files) hash.update(name).update(bytes);
    const target = path.join(this.home, 'packages', manifest.version + '-' + hash.digest('hex').slice(0, 20));
    // Immutable version directories let a running DSH finish on its already loaded plugin.
    for (const [name, bytes] of files) {
      const file = path.join(target, name);
      if (fs.existsSync(file)) {
        if (!fs.readFileSync(file).equals(bytes)) throw new Error('Managed DSH package was modified; keep the backup and repair from a new version');
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    return { target, version: manifest.version };
  }
  commit(profile, nextValue, nextTarget, nextState, operation) {
    const before = profile.bytes, after = Buffer.from(encoded(nextValue)), oldTarget = this.readLink();
    const backupDir = path.join(this.dataDir, 'backups/dsh', String(this.now()) + '-' + randomUUID());
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'package.json'), before, { flag: 'wx', mode: 0o600 });
    atomic(path.join(backupDir, 'metadata.json'), encoded({ owner: OWNER, operation, profileDir: this.profileDir, oldTarget, nextTarget, beforeHash: digest(before), afterHash: digest(after) }));
    const txn = { owner: OWNER, profileDir: this.profileDir, before: before.toString('base64'), after: after.toString('base64'), oldTarget, nextTarget, nextState, backupDir };
    this.hooks.beforeCommit?.();
    if (digest(fs.readFileSync(this.manifest)) !== digest(before)) throw new Error('DSH configuration changed; no profile changes were applied. Retry with the latest configuration');
    atomic(this.journalFile, encoded(txn));
    try {
      this.replaceLink(nextTarget);
      this.hooks.afterLink?.();
      if (digest(fs.readFileSync(this.manifest)) !== digest(before)) throw new Error('DSH configuration changed while installing');
      atomic(this.manifest, after);
      if (nextState) atomic(this.stateFile, encoded({ ...nextState, backupDir }));
      else if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile);
      fs.unlinkSync(this.journalFile);
    } catch (error) {
      // Recovery only changes fields when the captured before/after versions still match.
      try { this.recover(); } catch { /* Keep the journal and backup for a later repair. */ }
      throw error;
    }
    return { ...this.status(), backupDir, restartRequired: true, summary: operation === 'remove'
      ? '已移除本项目的 DSH 插件选择和本地链接。请正常重启 DSH；备份与版本目录已保留。'
      : '已安装本地 DSH 插件。请正常重启 DSH；运行中的会话可先完成当前工作。' };
  }
  install() {
    return this.withLock(() => {
      const profile = this.readProfile(), previous = this.state(), oldTarget = this.readLink();
      if (oldTarget) {
        let packageName;
        try { packageName = json(path.join(oldTarget, 'package.json')).name; } catch { /* Broken owned links are repairable. */ }
        if (packageName && packageName !== NAME) throw new Error('The DSH bridge link points to a different package');
      }
      const bundle = this.prepareBundle(), spec = 'link:' + bundle.target.replaceAll('\\', '/');
      const next = structuredClone(profile.value);
      const scaffold = previous?.scaffold || { dependencies: next.dependencies === undefined, dsh: next.dsh === undefined,
        profile: next.dsh?.profile === undefined, bundles: next.dsh?.profile?.bundles === undefined };
      next.dependencies ||= {}; next.dependencies[NAME] = spec;
      next.dsh ||= {}; next.dsh.profile ||= {}; next.dsh.profile.bundles ||= [];
      if (!next.dsh.profile.bundles.includes(NAME)) next.dsh.profile.bundles.push(NAME);
      const state = { owner: OWNER, profileDir: this.profileDir, target: bundle.target, version: bundle.version, spec, scaffold, timedQuestions: this.timedQuestions };
      if (previous?.spec === spec && oldTarget && samePath(oldTarget, bundle.target) &&
        JSON.stringify(next) === JSON.stringify(profile.value)) return { ...this.status(), changed: false, summary: 'DSH 集成配置完整，无需重复安装' };
      return this.commit(profile, next, bundle.target, state, 'install');
    });
  }
  remove() {
    return this.withLock(() => {
      const state = this.state();
      if (!state) return { ...this.status(), changed: false, summary: '没有由当前集成管理器安装的配置；已保留现有插件' };
      const profile = this.readProfile(), target = this.readLink();
      if ((profile.value.dependencies?.[NAME] && profile.value.dependencies[NAME] !== state.spec) || (target && !samePath(target, state.target))) {
        throw new Error('DSH bridge configuration was changed outside this manager; preserved that configuration');
      }
      const next = structuredClone(profile.value);
      if (next.dependencies) { delete next.dependencies[NAME]; if (state.scaffold.dependencies && !Object.keys(next.dependencies).length) delete next.dependencies; }
      if (Array.isArray(next.dsh?.profile?.bundles)) next.dsh.profile.bundles = next.dsh.profile.bundles.filter(name => name !== NAME);
      if (state.scaffold.bundles && !next.dsh?.profile?.bundles?.length) delete next.dsh.profile.bundles;
      if (state.scaffold.profile && next.dsh?.profile && !Object.keys(next.dsh.profile).length) delete next.dsh.profile;
      if (state.scaffold.dsh && next.dsh && !Object.keys(next.dsh).length) delete next.dsh;
      return this.commit(profile, next, null, null, 'remove');
    });
  }
}
module.exports = { DshIntegrationManager, NAME, OWNER, atomic };
