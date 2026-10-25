'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscriptions = new Set();
function listen(channel, callback) {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  const dispose = () => { ipcRenderer.removeListener(channel, handler); subscriptions.delete(dispose); };
  subscriptions.add(dispose); return dispose;
}
// Electron tears down the isolated IPC emitter with its WebContents context.
// Component subscriptions still return explicit disposers for earlier release.

contextBridge.exposeInMainWorld('island', {
  onUpdate: cb => listen('island:sessions', cb),
  snapshot: () => ipcRenderer.invoke('island:snapshot'),
  setInteractive: (next) => ipcRenderer.send('island:interactive', next),
  setBounds: (b) => ipcRenderer.send('island:bounds', b),
  focusSession: (sessionId) => ipcRenderer.invoke('island:focus', sessionId),
  hide: () => ipcRenderer.send('island:hide'),
  quit: () => ipcRenderer.send('island:quit'),
  keyboard: (enabled) => ipcRenderer.invoke('island:keyboard', !!enabled),
  activity: value => ipcRenderer.send('island:activity', value),
  onPointer: cb => listen('island:pointer', cb),
  environment: { get: () => ipcRenderer.invoke('island:environment:get'), onChange: cb => listen('island:environment', cb) },
  completion: data => ipcRenderer.invoke('island:completion:get', data),
  openExternal: url => ipcRenderer.invoke('island:external', url),
  native: {
    snapshot: () => ipcRenderer.invoke('island:native:snapshot'),
    reply: (data) => ipcRenderer.invoke('island:native:reply', data),
    onRequests: cb => listen('island:native:requests', cb),
    onConfirmation: cb => listen('island:native:confirmation', cb),
  },
  sessions: {
    hide: (id, mode) => ipcRenderer.invoke('island:session:hide', String(id), mode === 'delete' ? 'delete' : 'archive'),
    list: (mode) => ipcRenderer.invoke('island:session:list', mode === 'delete' ? 'delete' : 'archived'),
    restore: (mode, key) => ipcRenderer.invoke('island:session:restore', mode === 'delete' ? 'delete' : 'archived', String(key)),
    restoreAll: (mode) => ipcRenderer.invoke('island:session:restore-all', mode === 'delete' ? 'delete' : 'archived'),
    onChange: cb => listen('island:session:changed', cb),
  },
  settings: {
    open: () => ipcRenderer.invoke('island:settings:open'),
    dshStatus: () => ipcRenderer.invoke('island:dsh:status'),
    dshManage: (action) => ipcRenderer.invoke('island:dsh:manage', action),
    zcodeStatus: () => ipcRenderer.invoke('island:zcode:status'),
    zcodeManage: (action) => ipcRenderer.invoke('island:zcode:manage', action),
    claudeStatus: () => ipcRenderer.invoke('island:claude:status'),
    claudeManage: (action) => ipcRenderer.invoke('island:claude:manage', action),
    get: () => ipcRenderer.invoke('island:settings:get'),
    set: (patch) => ipcRenderer.invoke('island:settings:set', patch),
    onChange: cb => listen('island:settings:changed', cb),
    diagnostics: () => ipcRenderer.invoke('island:diagnostics'),
    copy: (text) => ipcRenderer.invoke('island:clipboard:write', String(text)),
    openLogs: () => ipcRenderer.invoke('island:logs:open'),
  },
});
