'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const presentation = require('../renderer/presentation.js');
const DEFAULTS = { settingsVersion: 3, displayId: null, updateUrl: '', autoCheckUpdates: false, lastUpdateCheck: 0, autoHideFullscreen: false, dshTimedQuestions: false, ...presentation.DEFAULTS };
class SettingsStore {
  constructor(file, { log = () => {} } = {}) { this.file = file; this.log = log; this.value = { ...DEFAULTS }; }
  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings object');
      Object.assign(this.value, saved, { settingsVersion: 3 });
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (value !== null && typeof this.value[key] !== typeof value) this.value[key] = value;
      }
      Object.assign(this.value, presentation.normalize(this.value));
    } catch (error) { if (error.code !== 'ENOENT') this.log('settings load failed: ' + error.message); }
    return this.value;
  }
  save() {
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, this.file); return true;
    } catch (error) { this.log('settings save failed: ' + error.message); return false; }
    finally { try { fs.unlinkSync(tmp); } catch { /* moved or never written */ } }
  }
}
module.exports = { SettingsStore, DEFAULTS };
