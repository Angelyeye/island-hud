'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomic } = require('./dsh-integration-manager.cjs');
const OWNER = 'island-hud-zcode-integration-v1';
const MANAGED_MARK = 'Island HUD';
// Fire-and-forget events must never slow the agent down; PermissionRequest
// blocks the native tool call and may legitimately wait for the island card.
const EVENT_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const EVENT_TIMEOUT_MS = 10000;
const PERMISSION_TIMEOUT_MS = 24 * 3600000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Owns the Island HUD hook entries inside the user's ZCode config plus the
 * deployed hook bundle. One JSON file is edited, so a crash can only leave
 * the old or the new configuration; the state file records what we installed
 * and the backup preserves the original bytes.
 */
class ZcodeIntegrationManager {
  constructor({ configPath, dataDir, sourceDir, descriptorPath, now = Date.now, hooks = {}, log = () => {} }) {
    for (const value of [configPath, dataDir, sourceDir]) if (!path.isAbsolute(value)) throw new Error('Absolute integration paths required');
    Object.assign(this, { configPath, dataDir, sourceDir, descriptorPath, now, hooks, log });
    this.home = path.join(dataDir, 'integrations/zcode');
    this.stateFile = path.join(this.home, 'state.json');
    // Ownership marker is the version-independent packages directory: upgrades
    // change the content-addressed leaf, so exact-path matching would strand
    // old hook groups in config.json after every upgrade.
    this.ownedMarker = JSON.stringify(path.join(dataDir, 'integrations', 'zcode', 'packages')).toLowerCase().slice(1, -1).replace(/\\\\/g, '/');
    this.ownedScript = 'island-hook.mjs';
    this.lastSeen = 0; this.hostVersion = null;
  }
  observe(envelope) {
    if (envelope.provider !== 'zcode') return;
    this.lastSeen = this.now();
    if (envelope.payload?.pluginVersion) this.hostVersion = envelope.payload.pluginVersion;
  }
  readConfig() {
    const bytes = fs.readFileSync(this.configPath);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('ZCode 配置文件过大，未做改动');
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!object(value) || (value.hooks !== undefined && !object(value.hooks)) ||
      (value.hooks !== undefined && value.hooks.events !== undefined && !object(value.hooks.events))) {
      throw new Error('ZCode 配置结构不受支持，未做改动');
    }
    return { bytes, value };
  }
  isOwnedEntry(entry) {
    if (!object(entry)) return false;
    // JSON.stringify escapes backslashes, so the marker is compared in its escaped form.
    const text = JSON.stringify(entry).toLowerCase().replace(/\\\\/g, '/');
    return text.includes(this.ownedMarker) && text.includes(this.ownedScript);
  }
  ownedGroups(config, event) {
    const groups = config?.hooks?.events?.[event];
    return Array.isArray(groups) ? groups.filter(group => object(group) &&
      Array.isArray(group.hooks) && group.hooks.some(entry => this.isOwnedEntry(entry))) : [];
  }
  /** Blocking PermissionRequest hooks from other tools (e.g. agent bridges) coexist on the same event. */
  detectConflict(config) {
    const groups = config?.hooks?.events?.PermissionRequest;
    if (!Array.isArray(groups)) return '';
    const others = groups.filter(group => object(group) && Array.isArray(group.hooks) &&
      group.hooks.length && !group.hooks.every(entry => this.isOwnedEntry(entry)));
    if (!others.length) return '';
    const first = others[0].hooks.find(entry => entry && (entry.command || entry.type));
    const name = first ? String(first.command || first.type) : '未知命令';
    return `检测到其他 PermissionRequest hook（${name.slice(0, 80)}）；双方都会等待审批响应，请按需停用其一。`;
  }
  hookEntries(scriptPath) {
    const entry = timeoutMs => ({ type: 'process', command: 'node', args: [scriptPath], timeoutMs, statusMessage: MANAGED_MARK });
    const groups = [];
    for (const event of EVENT_HOOKS) groups.push([event, { hooks: [entry(EVENT_TIMEOUT_MS)] }]);
    groups.push(['PermissionRequest', { hooks: [entry(PERMISSION_TIMEOUT_MS)] }]);
    return groups;
  }
  state() {
    if (!fs.existsSync(this.stateFile)) return null;
    const value = json(this.stateFile);
    if (value.owner !== OWNER || value.configPath !== this.configPath) throw new Error('ZCode 集成状态属于其他配置文件');
    return value;
  }
  status() {
    const base = { configPath: this.configPath, installed: false, managed: false, connected: false,
      version: null, conflict: '', reason: '', lastSeen: this.lastSeen || null };
    let config = null, scriptPath = null;
    try {
      const state = this.state();
      if (state) {
        base.version = state.version;
        scriptPath = path.join(state.target, 'scripts', 'island-hook.mjs');
        if (!fs.existsSync(scriptPath)) base.reason = '受管脚本目录缺失，请点击修复';
      }
      const { value } = this.readConfig();
      config = value;
      base.installed = !!scriptPath && EVENT_HOOKS.every(event => this.ownedGroups(config, event).length) &&
        this.ownedGroups(config, 'PermissionRequest').length > 0;
      base.managed = base.installed && !!state;
      base.conflict = this.detectConflict(config);
      base.connected = base.installed && this.lastSeen > 0 && this.now() - this.lastSeen < 45000;
      base.hostVersion = this.hostVersion;
      if (!base.installed && (state || (scriptPath && JSON.stringify(config).toLowerCase().includes(scriptPath.toLowerCase())))) {
        base.reason = 'hook 配置不完整或被外部修改，请点击修复';
      } else if (base.connected) base.reason = 'ZCode hook 已连接';
      else if (base.installed) base.reason = 'hook 已配置，等待 ZCode 触发事件；新会话或下一次审批时生效';
      else if (state) base.reason = '受管配置不完整，请点击修复';
      else base.reason = '尚未安装 ZCode 集成';
    } catch (error) {
      base.reason = error.code === 'ENOENT' ? '未找到 ZCode 用户配置（~/.zcode/cli/config.json）；请先运行一次 ZCode CLI' : error.message;
    }
    return base;
  }
  withLock(action) {
    fs.mkdirSync(this.home, { recursive: true });
    const lock = path.join(this.home, 'operation.lock');
    if (fs.existsSync(lock)) {
      const holder = json(lock);
      let alive = true;
      try { process.kill(holder.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('另一个 ZCode 集成操作正在进行');
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, encoded({ owner: OWNER, pid: process.pid })); return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  prepareBundle() {
    const files = new Map();
    for (const name of ['scripts/island-hook.mjs', 'hooks/hooks.json', 'lib/client.cjs', 'lib/contract.cjs', 'package.json', '.zcode-plugin/plugin.json']) {
      files.set(name, fs.readFileSync(path.join(this.sourceDir, name)));
    }
    const manifest = json(path.join(this.sourceDir, 'package.json'));
    if (manifest.name !== '@island-hud/zcode-bridge' || !/^[0-9]+\.[0-9]+\.[0-9]+[\w.-]*$/.test(manifest.version)) {
      throw new Error('Invalid ZCode bridge package');
    }
    const hash = createHash('sha256');
    for (const [name, bytes] of files) hash.update(name).update(bytes);
    const target = path.join(this.home, 'packages', manifest.version + '-' + hash.digest('hex').slice(0, 20));
    for (const [name, bytes] of files) {
      const file = path.join(target, name);
      if (fs.existsSync(file)) {
        if (!fs.readFileSync(file).equals(bytes)) throw new Error('受管 ZCode 脚本目录被修改；请保留备份并从新版本修复');
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    return { target, version: manifest.version };
  }
  writeConfig(before, next, operation) {
    const backupDir = path.join(this.dataDir, 'backups/zcode', String(this.now()) + '-' + randomUUID());
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'config.json'), before, { flag: 'wx', mode: 0o600 });
    this.hooks.beforeCommit?.();
    const current = fs.readFileSync(this.configPath);
    if (digest(current) !== digest(before)) throw new Error('ZCode 配置在操作期间被修改；未应用任何改动，请重试');
    atomic(this.configPath, Buffer.from(encoded(next)));
    return backupDir;
  }
  install() {
    return this.withLock(() => {
      const bundle = this.prepareBundle();
      const scriptPath = path.join(bundle.target, 'scripts', 'island-hook.mjs');
      const { bytes: before, value } = this.readConfig();
      const next = structuredClone(value);
      const scaffold = {
        hooks: next.hooks === undefined,
        enabled: next.hooks?.enabled === undefined,
        events: next.hooks?.events === undefined,
      };
      next.hooks = object(next.hooks) ? next.hooks : {};
      next.hooks.enabled = true; // Config-file hooks stay dormant unless explicitly enabled.
      next.hooks.events = object(next.hooks.events) ? next.hooks.events : {};
      const createdEvents = [];
      let added = 0;
      for (const [event, group] of this.hookEntries(scriptPath)) {
        if (!Array.isArray(next.hooks.events[event])) { next.hooks.events[event] = []; createdEvents.push(event); }
        // An upgrade leaves groups pointing at the previous content-addressed
        // bundle; replace every owned group that is not the current one.
        const owned = next.hooks.events[event].filter(g => object(g) && Array.isArray(g.hooks) &&
          g.hooks.some(entry => this.isOwnedEntry(entry)));
        const hasCurrent = owned.some(existing => JSON.stringify(existing) === JSON.stringify(group));
        const stale = owned.filter(existing => JSON.stringify(existing) !== JSON.stringify(group));
        if (stale.length) {
          const staleTexts = new Set(stale.map(existing => JSON.stringify(existing)));
          next.hooks.events[event] = next.hooks.events[event].filter(existing => !staleTexts.has(JSON.stringify(existing)));
          added++;
        }
        if (!hasCurrent) { next.hooks.events[event].push(group); added++; }
      }
      if (!added) {
        const state = this.state();
        if (state?.target === bundle.target) return { ...this.status(), changed: false, summary: 'ZCode 集成配置完整，无需重复安装' };
      }
      const conflict = this.detectConflict(next);
      const backupDir = this.writeConfig(before, next, 'install');
      const state = { owner: OWNER, configPath: this.configPath, target: bundle.target, version: bundle.version, scaffold: { ...scaffold, createdEvents }, backupDir };
      atomic(this.stateFile, encoded(state));
      this.log(`zcode integration installed version=${bundle.version} added=${added}`);
      return { ...this.status(), changed: true, backupDir, conflict,
        summary: '已写入 ZCode hook 配置。正在运行的 ZCode 会话不受影响；新会话开始生效。' + (conflict ? ' ' + conflict : '') };
    });
  }
  remove() {
    return this.withLock(() => {
      const state = this.state();
      const { bytes: before, value } = this.readConfig();
      const scriptPath = state ? path.join(state.target, 'scripts', 'island-hook.mjs') : null;
      if (!state || !scriptPath) return { ...this.status(), changed: false, summary: '没有由当前集成管理器安装的 ZCode hook；已保留现有配置' };
      const next = structuredClone(value);
      for (const event of [...EVENT_HOOKS, 'PermissionRequest']) {
        const groups = next.hooks?.events?.[event];
        if (!Array.isArray(groups)) continue;
        next.hooks.events[event] = groups.filter(group => !(object(group) && Array.isArray(group.hooks) &&
          group.hooks.some(entry => this.isOwnedEntry(entry))));
        const deletable = state.scaffold?.events || (state.scaffold?.createdEvents || []).includes(event);
        if (deletable && !next.hooks.events[event].length) delete next.hooks.events[event];
      }
      if (state.scaffold?.events && object(next.hooks?.events) && !Object.keys(next.hooks.events).length) delete next.hooks.events;
      // Only drop `enabled: true` when we introduced the whole hooks object and nothing else uses it.
      if (state.scaffold?.enabled && object(next.hooks) &&
        Object.keys(next.hooks).every(key => key === 'enabled' || key === 'events') &&
        !Object.keys(next.hooks.events || {}).length) delete next.hooks.enabled;
      if (state.scaffold?.hooks && next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
      const backupDir = this.writeConfig(before, next, 'remove');
      fs.unlinkSync(this.stateFile);
      this.log('zcode integration removed');
      return { ...this.status(), changed: true, backupDir, summary: '已从 ZCode 配置移除本项目的 hook 条目；备份已保留。' };
    });
  }
}
module.exports = { ZcodeIntegrationManager, OWNER };
