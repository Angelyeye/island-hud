'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomic } = require('./dsh-integration-manager.cjs');
const OWNER = 'island-hud-claude-integration-v1';
const MANAGED_MARK = 'Island HUD';
// Fire-and-forget events must never slow the agent down; PermissionRequest
// blocks the native tool call and may legitimately wait for the island card.
// Claude Code hook timeouts are in SECONDS (ZCode uses ms).
const EVENT_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const EVENT_TIMEOUT_S = 10;
const PERMISSION_TIMEOUT_S = 24 * 3600;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Owns the Island HUD hook entries inside the user's Claude Code settings
 * plus the deployed hook bundle. One JSON file is edited, so a crash can only
 * leave the old or the new configuration; the state file records what we
 * installed and the backup preserves the original bytes.
 */
class ClaudeIntegrationManager {
  constructor({ configPath, dataDir, sourceDir, descriptorPath, now = Date.now, hooks = {}, log = () => {} }) {
    for (const value of [configPath, dataDir, sourceDir]) if (!path.isAbsolute(value)) throw new Error('Absolute integration paths required');
    Object.assign(this, { configPath, dataDir, sourceDir, descriptorPath, now, hooks, log });
    this.home = path.join(dataDir, 'integrations/claude');
    this.stateFile = path.join(this.home, 'state.json');
    // Ownership marker is the version-independent packages directory: upgrades
    // change the content-addressed leaf, so exact-path matching would strand
    // old hook groups in settings.json after every upgrade.
    this.ownedMarker = JSON.stringify(path.join(dataDir, 'integrations', 'claude', 'packages')).toLowerCase().slice(1, -1).replace(/\\\\/g, '/');
    this.ownedScript = 'island-hook.cjs';
    this.lastSeen = 0; this.hostVersion = null;
  }
  observe(envelope) {
    if (envelope.provider !== 'claude') return;
    this.lastSeen = this.now();
    if (envelope.payload?.pluginVersion) this.hostVersion = envelope.payload.pluginVersion;
  }
  readConfig() {
    const bytes = fs.readFileSync(this.configPath);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Claude Code 配置文件过大，未做改动');
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!object(value) || (value.hooks !== undefined && !object(value.hooks))) {
      throw new Error('Claude Code 配置结构不受支持，未做改动');
    }
    if (object(value.hooks)) {
      for (const event of Object.keys(value.hooks)) {
        if (!Array.isArray(value.hooks[event])) throw new Error('Claude Code 配置结构不受支持，未做改动');
      }
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
    const groups = config?.hooks?.[event];
    return Array.isArray(groups) ? groups.filter(group => object(group) &&
      Array.isArray(group.hooks) && group.hooks.some(entry => this.isOwnedEntry(entry))) : [];
  }
  /** Blocking PermissionRequest hooks from other tools (e.g. agent bridges) coexist on the same event. */
  detectConflict(config) {
    const groups = config?.hooks?.PermissionRequest;
    if (!Array.isArray(groups)) return '';
    const others = groups.filter(group => object(group) && Array.isArray(group.hooks) &&
      group.hooks.length && !group.hooks.every(entry => this.isOwnedEntry(entry)));
    if (!others.length) return '';
    const first = others[0].hooks.find(entry => entry && (entry.command || entry.type));
    const name = first ? String(first.command || first.type) : '未知命令';
    return `检测到其他 PermissionRequest hook（${name.slice(0, 80)}）；双方都会等待审批响应，请按需停用其一。`;
  }
  hookEntries(scriptPath) {
    const entry = timeoutSeconds => ({ type: 'command', command: 'node', args: [scriptPath],
      timeout: timeoutSeconds, statusMessage: MANAGED_MARK });
    const groups = [];
    for (const event of EVENT_HOOKS) groups.push([event, { hooks: [entry(EVENT_TIMEOUT_S)] }]);
    groups.push(['PermissionRequest', { hooks: [entry(PERMISSION_TIMEOUT_S)] }]);
    return groups;
  }
  state() {
    if (!fs.existsSync(this.stateFile)) return null;
    const value = json(this.stateFile);
    if (value.owner !== OWNER || value.configPath !== this.configPath) throw new Error('Claude Code 集成状态属于其他配置文件');
    return value;
  }
  status() {
    const base = { configPath: this.configPath, installed: false, managed: false, connected: false,
      version: null, conflict: '', reason: '', lastSeen: this.lastSeen || null };
    try {
      const state = this.state();
      if (state) {
        base.version = state.version;
        if (!fs.existsSync(path.join(state.target, 'scripts', this.ownedScript))) base.reason = '受管脚本目录缺失，请点击修复';
      }
      const { value } = this.readConfig();
      base.installed = EVENT_HOOKS.every(event => this.ownedGroups(value, event).length) &&
        this.ownedGroups(value, 'PermissionRequest').length > 0;
      base.managed = base.installed && !!state;
      base.conflict = this.detectConflict(value);
      base.connected = base.installed && this.lastSeen > 0 && this.now() - this.lastSeen < 45000;
      base.hostVersion = this.hostVersion;
      if (value.disableAllHooks === true) {
        base.reason = 'Claude Code 已设置 disableAllHooks=true，所有 hook 均不生效；请在该设置中重新启用';
      } else if (!base.installed && state) {
        base.reason = 'hook 配置不完整或被外部修改，请点击修复';
      } else if (base.connected) base.reason = 'Claude Code hook 已连接';
      else if (base.installed) base.reason = 'hook 已配置，等待 Claude Code 触发事件；新会话或下一次审批时生效';
      else if (state) base.reason = '受管配置不完整，请点击修复';
      else base.reason = '尚未安装 Claude Code 集成';
    } catch (error) {
      base.reason = error.code === 'ENOENT' ? '未找到 Claude Code 用户配置（~/.claude/settings.json）；请先运行一次 Claude Code' : error.message;
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
      if (alive) throw new Error('另一个 Claude Code 集成操作正在进行');
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, encoded({ owner: OWNER, pid: process.pid })); return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  prepareBundle() {
    const files = new Map();
    for (const name of ['scripts/island-hook.cjs', 'lib/client.cjs', 'lib/contract.cjs', 'package.json']) {
      files.set(name, fs.readFileSync(path.join(this.sourceDir, name)));
    }
    const manifest = json(path.join(this.sourceDir, 'package.json'));
    if (manifest.name !== '@island-hud/claude-bridge' || !/^[0-9]+\.[0-9]+\.[0-9]+[\w.-]*$/.test(manifest.version)) {
      throw new Error('Invalid Claude bridge package');
    }
    const hash = createHash('sha256');
    for (const [name, bytes] of files) hash.update(name).update(bytes);
    const target = path.join(this.home, 'packages', manifest.version + '-' + hash.digest('hex').slice(0, 20));
    for (const [name, bytes] of files) {
      const file = path.join(target, name);
      if (fs.existsSync(file)) {
        if (!fs.readFileSync(file).equals(bytes)) throw new Error('受管 Claude 脚本目录被修改；请保留备份并从新版本修复');
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    return { target, version: manifest.version };
  }
  writeConfig(before, next) {
    const backupDir = path.join(this.dataDir, 'backups/claude', String(this.now()) + '-' + randomUUID());
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'settings.json'), before, { flag: 'wx', mode: 0o600 });
    this.hooks.beforeCommit?.();
    const current = fs.readFileSync(this.configPath);
    if (digest(current) !== digest(before)) throw new Error('Claude Code 配置在操作期间被修改；未应用任何改动，请重试');
    atomic(this.configPath, Buffer.from(encoded(next)));
    return backupDir;
  }
  install() {
    return this.withLock(() => {
      const bundle = this.prepareBundle();
      const scriptPath = path.join(bundle.target, 'scripts', this.ownedScript);
      const { bytes: before, value } = this.readConfig();
      const next = structuredClone(value);
      const scaffold = { hooks: next.hooks === undefined };
      next.hooks = object(next.hooks) ? next.hooks : {};
      const createdEvents = [];
      let added = 0;
      for (const [event, group] of this.hookEntries(scriptPath)) {
        if (!Array.isArray(next.hooks[event])) { next.hooks[event] = []; createdEvents.push(event); }
        // An upgrade leaves groups pointing at the previous content-addressed
        // bundle; replace every owned group that is not the current one.
        const owned = next.hooks[event].filter(existing => object(existing) && Array.isArray(existing.hooks) &&
          existing.hooks.some(entry => this.isOwnedEntry(entry)));
        const hasCurrent = owned.some(existing => JSON.stringify(existing) === JSON.stringify(group));
        const stale = owned.filter(existing => JSON.stringify(existing) !== JSON.stringify(group));
        if (stale.length) {
          const staleTexts = new Set(stale.map(existing => JSON.stringify(existing)));
          next.hooks[event] = next.hooks[event].filter(existing => !staleTexts.has(JSON.stringify(existing)));
          added++;
        }
        if (!hasCurrent) { next.hooks[event].push(group); added++; }
      }
      if (!added) {
        const state = this.state();
        if (state?.target === bundle.target) return { ...this.status(), changed: false, summary: 'Claude Code 集成配置完整，无需重复安装' };
      }
      const conflict = this.detectConflict(next);
      const backupDir = this.writeConfig(before, next);
      const state = { owner: OWNER, configPath: this.configPath, target: bundle.target, version: bundle.version, scaffold: { ...scaffold, createdEvents }, backupDir };
      atomic(this.stateFile, encoded(state));
      this.log(`claude integration installed version=${bundle.version} added=${added}`);
      return { ...this.status(), changed: true, backupDir, conflict,
        summary: '已写入 Claude Code hook 配置。正在运行的会话不受影响；新会话开始生效。' + (conflict ? ' ' + conflict : '') };
    });
  }
  remove() {
    return this.withLock(() => {
      const state = this.state();
      if (!state) return { ...this.status(), changed: false, summary: '没有由当前集成管理器安装的 Claude Code hook；已保留现有配置' };
      const { bytes: before, value } = this.readConfig();
      const next = structuredClone(value);
      for (const event of [...EVENT_HOOKS, 'PermissionRequest']) {
        const groups = next.hooks?.[event];
        if (!Array.isArray(groups)) continue;
        next.hooks[event] = groups.filter(group => !(object(group) && Array.isArray(group.hooks) &&
          group.hooks.some(entry => this.isOwnedEntry(entry))));
        if (state.scaffold?.createdEvents?.includes(event) && !next.hooks[event].length) delete next.hooks[event];
      }
      if (state.scaffold?.hooks && object(next.hooks) && !Object.keys(next.hooks).length) delete next.hooks;
      const backupDir = this.writeConfig(before, next);
      fs.unlinkSync(this.stateFile);
      this.log('claude integration removed');
      return { ...this.status(), changed: true, backupDir, summary: '已从 Claude Code 配置移除本项目的 hook 条目；备份已保留。' };
    });
  }
}
module.exports = { ClaudeIntegrationManager, OWNER };
