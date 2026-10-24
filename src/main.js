'use strict';
/**
 * Island HUD for Windows — Electron main process.
 *
 * Owns the always-on-top, click-through, transparent overlay window docked at
 * the top-centre of the display, plus the DSH session bridge that feeds it.
 *
 * Window size: 460×300 (the notch itself is at most 400×250; the rest is
 * transparent margin for shadows/edge glow and is click-through).
 */
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, nativeTheme, systemPreferences, globalShortcut, shell, dialog, clipboard, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DshBridge, zstdDecoderName } = require('./dsh/dshBridge');
const { IntegrationHub } = require('./integrations/hub');
const { descriptorPath: nativeDescriptorPath } = require('./integrations/client');
const updater = require('./update/updater');
const { SessionStore } = require('./sessions/session-store.cjs');
const { DshIntegrationManager } = require('./app/dsh-integration-manager.cjs');
const { ZcodeIntegrationManager } = require('./app/zcode-integration-manager.cjs');
const { DshNavigationServer } = require('./app/dsh-navigation.cjs');
const { ArchiveStore, canHide } = require('./app/archive-store.cjs');
const { applyVisibility, DEFAULT_LIMIT: SESSION_LIMIT } = require('./sessions/session-visibility.cjs');
const sessionStore = new SessionStore();
const presentation = require('./renderer/presentation.js');
const { CompletionReader } = require('./app/completion-reader.cjs');
const { createDiagnosticOutput } = require('./logs/diagnostic-output.cjs');
const completionReader = new CompletionReader();

let WIN_W = 568;
let WIN_H = 624;

const DEMO = process.argv.includes('--demo');
const SHOT_DIR = process.env.ISLAND_SHOT_DIR ? path.resolve(process.env.ISLAND_SHOT_DIR) : '';
const SHOT_LOG = SHOT_DIR ? path.join(SHOT_DIR, 'app-shot.log') : '';
const DIAG_FILE = process.env.ISLAND_DIAG_FILE ? path.resolve(process.env.ISLAND_DIAG_FILE) : '';

const TEST_ROOT = process.env.ISLAND_HUD_TEST_ROOT || '';
const IDLE_MONITOR = !!TEST_ROOT && process.env.ISLAND_TEST_IDLE_MODE === '1';
const hasTestFlags = Object.keys(process.env).some(key => /^ISLAND_(TEST_|SHOT_DIR|UPDATE_TEST)/.test(key) && process.env[key]);
if ((TEST_ROOT && !path.isAbsolute(TEST_ROOT)) || (hasTestFlags && !TEST_ROOT)) {
  throw new Error('Development checks require an absolute ISLAND_HUD_TEST_ROOT');
}
if (TEST_ROOT) {
  for (const name of ['ISLAND_SHOT_DIR', 'ISLAND_E2E_SHOT', 'ISLAND_SETTINGS_SHOT', 'ISLAND_TEST_DIAGNOSTICS', 'ISLAND_TEST_HOOK_TARGET']) {
    if (!process.env[name]) continue;
    const relative = path.relative(TEST_ROOT, path.resolve(process.env[name]));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(name + ' must stay in ISLAND_HUD_TEST_ROOT');
  }
  if (process.env.ISLAND_UPDATE_TEST_INSTALL) throw new Error('Isolated tests never launch an installer');
  fs.mkdirSync(TEST_ROOT, { recursive: true });  app.setPath('userData', path.join(TEST_ROOT, 'electron'));
  app.setPath('sessionData', path.join(TEST_ROOT, 'electron'));
  app.setName('Island HUD Development');
}

function reportDiagnosticStreamFailure(name, error) {
  const code = error && typeof error.code === 'string' ? error.code : 'stream-error';
  appendLog(`${new Date().toISOString()} ${name} unavailable (${code}); continuing with file logging\n`);
}

// Keep these listeners for the whole process lifetime. A closed terminal or test
// harness otherwise emits an asynchronous EPIPE that surfaces as an Electron
// "JavaScript error occurred in the main process" dialog.
const diagnosticStdout = createDiagnosticOutput(process.stdout, {
  onError: error => reportDiagnosticStreamFailure('stdout', error),
});
createDiagnosticOutput(process.stderr, {
  onError: error => reportDiagnosticStreamFailure('stderr', error),
});

// Maintenance commands make login-cycle verification reproducible without
// requiring UI automation. They act before the single-instance lock so they can
// be used while a running instance owns the normal application lock.
const autoStartCommand = process.argv.includes('--autostart-on') ? true : process.argv.includes('--autostart-off') ? false : null;
if (autoStartCommand !== null) {
  if (!app.isPackaged) app.exit(2);
  try {
    app.setLoginItemSettings(loginItemOptions({ openAtLogin: autoStartCommand }));
    const current = app.getLoginItemSettings(loginItemOptions());
    const enabled = Array.isArray(current.launchItems)
      ? current.launchItems.some(item => item?.enabled && item.path?.toLowerCase() === process.execPath.toLowerCase())
      : current.openAtLogin === autoStartCommand;
    app.exit(enabled === autoStartCommand ? 0 : 1);
  } catch {
    app.exit(1);
  }
}
const DATA_DIR = TEST_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'IslandHUD');
const BRIDGE_EVIDENCE_LOG = TEST_ROOT ? path.join(TEST_ROOT, 'bridge-evidence.jsonl') : '';
const navigationDescriptorPath = () => path.join(DATA_DIR, 'navigation.json');
function createDshIntegration({ timedQuestions = false } = {}) {
  return new DshIntegrationManager({
    profileDir: TEST_ROOT ? path.join(TEST_ROOT, 'dsh/profiles/desktop')
      : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles/desktop'),
    dataDir: DATA_DIR,
    sourceDir: path.join(__dirname, '../integrations/dsh'),
    descriptorPath: TEST_ROOT ? path.join(TEST_ROOT, 'integration-v2.json') : nativeDescriptorPath(),
    navigationPath: navigationDescriptorPath(),
    timedQuestions,
  });
}
function createZcodeIntegration() {
  return new ZcodeIntegrationManager({
    configPath: TEST_ROOT ? path.join(TEST_ROOT, 'zcode/cli/config.json')
      : path.join(process.env.ZCODE_HOME || os.homedir(), '.zcode/cli/config.json'),
    dataDir: DATA_DIR,
    sourceDir: path.join(__dirname, '../integrations/zcode'),
    descriptorPath: TEST_ROOT ? path.join(TEST_ROOT, 'integration-v2.json') : nativeDescriptorPath(),
    log: diag,
  });
}
if (process.argv.includes('--uninstall-cleanup')) {
  try {
    createDshIntegration().remove();
    createZcodeIntegration().remove();
    if (!TEST_ROOT) {
      const ownStartup = app.getLoginItemSettings({ path: process.execPath, name: 'Island HUD' });
      if (ownStartup.launchItems?.some(item => item.path?.toLowerCase() === process.execPath.toLowerCase())) {
        app.setLoginItemSettings({ path: process.execPath, name: 'Island HUD', openAtLogin: false });
      }
    }
    app.exit(0);
  } catch { app.exit(2); }
}
const { SettingsStore } = require('./app/settings-store.cjs');
const settingsStore = new SettingsStore(TEST_ROOT ? path.join(TEST_ROOT, 'settings.json') : path.join(app.getPath('appData'), 'IslandHUD/settings.json'), { log: diag });
const settings = settingsStore.value;
const settingsFile = () => settingsStore.file;
const loadSettings = () => settingsStore.load();
const saveSettings = () => settingsStore.save();
// The integration manager must see saved settings, not constructor defaults.
loadSettings();

const archiveStore = new ArchiveStore(TEST_ROOT ? path.join(TEST_ROOT, 'archived-sessions.json') : path.join(app.getPath('appData'), 'IslandHUD/archived-sessions.json'), { log: diag });
archiveStore.load();
let publishSessionsNow = null;
function notifySessionsChanged() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('island:session:changed');
}
let lastDropped = 0;
// One pass: drop locally hidden sessions, revive ones that became active and cap
// the island list at 50. Local view only, never touching DSH files or profiles.
function visibleSessions() {
  const result = applyVisibility(sessionStore.snapshot(), archiveStore.keys(), { limit: SESSION_LIMIT });
  let revived = false;
  for (const session of result.revived) {
    archiveStore.remove(session.id); revived = true;
    diag('session auto-revived ' + session.id);
  }
  if (revived) notifySessionsChanged();
  if (result.dropped !== lastDropped) {
    lastDropped = result.dropped;
    if (result.dropped) diag(`session cap ${SESSION_LIMIT}: ${result.dropped} older sessions hidden`);
  }
  return result.sessions;
}

function targetDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find((d) => d.id === settings.displayId) || screen.getPrimaryDisplay();
}

/* ----------------------------------------------------------------- updater */
function updateUrl() {
  return process.env.ISLAND_HUD_UPDATE_URL || settings.updateUrl || '';
}

async function checkForUpdates({ interactive = false } = {}) {
  const url = updateUrl();
  if (!url) {
    diag('update-check unconfigured');
    if (interactive) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Island HUD 更新',
        message: '未配置更新源',
        detail: '在设置文件 settings.json 里填写 "updateUrl" 指向 latest.json 清单。',
      });
    }
    return { status: 'unconfigured' };
  }
  try {
    diag(`update-check url=${url} current=${app.getVersion()}`);
    const info = await updater.fetchManifest(url, app.getVersion());
    diag(`update-check latest=${info.latestVersion} newer=${info.newer} sha=${info.sha256 ? 'yes' : 'no'}`);
    settings.lastUpdateCheck = Date.now();
    saveSettings();
    if (!info.newer) {
      diag('update-check up-to-date');
      if (interactive) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Island HUD 更新',
          message: '已是最新版本',
          detail: `当前 ${app.getVersion()}，最新 ${info.latestVersion}`,
        });
      }
      return { status: 'up-to-date', info };
    }
    if (interactive) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Island HUD 更新',
        message: `发现新版本 ${info.latestVersion}`,
        detail: (info.notes || '') + '\n\n是否打开发布页下载？',
        buttons: ['打开发布页', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) {
        diag('update-check postponed');
        return { status: 'postponed', info };
      }
      await shell.openExternal(updater.RELEASES_URL);
      diag('update-check opened releases page');
      return { status: 'opened', info };
    }
    return { status: 'available', info };
  } catch (e) {
    diag('update-check error ' + e.message);
    if (interactive) {
      dialog.showMessageBox({
        type: 'error',
        title: 'Island HUD 更新',
        message: '更新检查失败',
        detail: e.message,
      });
    }
    return { status: 'error', error: e.message };
  }
}

function logDir() {
  return TEST_ROOT ? path.join(TEST_ROOT, 'logs') : process.env.ISLAND_LOG_DIR || path.join(app.getPath('appData'), 'IslandHUD', 'logs');
}

function appendLog(line) {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    const max = 1024 * 1024;
    try {
      const st = fs.statSync(file);
      if (st.size > max) {
        const rot = file + '.1';
        try { fs.unlinkSync(rot); } catch { /* ignore */ }
        fs.renameSync(file, rot);
      }
    } catch { /* first write */ }
    fs.appendFileSync(file, line);
  } catch { /* ignore */ }
}

function diag(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (SHOT_DIR) fs.appendFileSync(SHOT_LOG, line);
    if (DIAG_FILE) fs.appendFileSync(DIAG_FILE, line);
  } catch { /* file diagnostics are best-effort */ }
  if (!SHOT_DIR) diagnosticStdout.write(line);
  appendLog(line);
}

let win = null;
let tray = null;
let bridge = null;
let dshNavigation = null;
let integrationHub = null;
let sessionPublishTimer = null;
let keyboardEnabled = false;
let interactive = false;
let requestedInteractive = false;
let forceInteractive = false;
let visible = true;
let notchBounds = null;
let fullscreenWatcher = null;
let autoHidden = false;
let quitting = false;
let settingsWin = null;
let hitTestTimer = null;
let lastPointerInside = false;
let idleHidden = false;
let manuallyHidden = false;
let rendererProtected = false;
let rendererExpanded = false;
let quietSince = Date.now();
let lastEnvironment = '';

function environmentPayload() {
  const display = targetDisplay();
  return { workArea: display.workArea, scaleFactor: display.scaleFactor, dark: nativeTheme.shouldUseDarkColors,
    reducedMotion: systemPreferences.getAnimationSettings().shouldRenderRichAnimation === false, visible: visible && !!win?.isVisible(), windowBounds: win?.getBounds() || null };
}
function publishEnvironment() {
  if (!win || win.isDestroyed()) return;
  const environment = environmentPayload(), serialized = JSON.stringify(environment);
  if (serialized === lastEnvironment) return;
  lastEnvironment = serialized;
  win.webContents.send('island:environment', environment);
  settingsWin?.webContents.send('island:environment', environment);
}
function publishSettings() {
  const payload = settingsPayload();
  win?.webContents.send('island:settings:changed', payload);
  settingsWin?.webContents.send('island:settings:changed', payload);
}

// Single instance: a second launch must not create a duplicate overlay.
const SINGLE_INSTANCE = app.requestSingleInstanceLock();
if (!SINGLE_INSTANCE) app.quit();
if (SINGLE_INSTANCE && process.argv.includes('--quit-for-maintenance')) app.exit(0);
app.on('second-instance', (_event, argv) => {
  if (argv.includes('--quit-for-maintenance')) { app.quit(); return; }
  if (!win || win.isDestroyed()) return;
  if (!visible) setVisible(true);
  reposition();
  win.showInactive();
  diag('second-instance: focused existing window');
});

/** Load the official Pixel Console artwork from assets copied into every package. */
function loadAppIcon(size = 256) {
  if (![16, 32, 256].includes(size)) throw new Error(`Unsupported app icon size: ${size}`);
  const file = path.join(__dirname, 'renderer', 'assets', `icon-${size}.png`);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`Unable to load app icon: ${file}`);
  return image;
}

function makeTrayIcon() {
  return loadAppIcon(32);
}

function createWindow() {
  const display = targetDisplay();
  const layout = presentation.geometry(settings, { workArea: display.workArea });
  WIN_W = layout.windowWidth; WIN_H = layout.windowHeight;
  const { x, y, width } = display.workArea;
  let rendererLoads = 0;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.round(x + (width - WIN_W) / 2),
    y: Math.round(y),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Created focusable so an explicit user click can focus a text field, but
    // all automatic shows below still use showInactive() and never steal focus.
    focusable: true,
    show: false,
    acceptFirstMouse: true,
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* Windows no-op */ }
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setMenuBarVisibility(false);

  const query = {};
  if (DEMO) query.demo = '1';
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    Object.keys(query).length ? { query } : undefined);

  diag(`window created demo=${DEMO} shotDir=${SHOT_DIR || '-'}`);
  diag(`packaged=${app.isPackaged} version=${app.getVersion()} display=${targetDisplay().id} settings=${settingsFile()}`);
  win.webContents.on('did-fail-load', (_e, code, desc) => diag('did-fail-load ' + code + ' ' + desc));
  win.webContents.on('did-finish-load', () => {
    lastEnvironment = ''; publishEnvironment(); publishSettings();
    setKeyboard(false);
    if (++rendererLoads > 1 && visible && win.isFocused()) {
      // Reloading WebContents can activate this non-activating click surface.
      // Re-show without activation so a renderer recovery never steals focus.
      win.hide();
      win.showInactive();
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => diag('render-process-gone ' + JSON.stringify(d)));
  win.webContents.on('console-message', (_e, level, msg) => {
    const text = String(msg);
    if (level >= 2 || text.startsWith('HUD_')) diag('renderer[' + level + '] ' + text.slice(0, 300));
  });
  win.once('ready-to-show', () => { if (!IDLE_MONITOR) { win.showInactive(); diag('shown'); } else diag('isolated idle monitor: window stays hidden'); publishEnvironment(); });
  win.on('show', publishEnvironment);
  win.on('hide', publishEnvironment);
  win.on('focus', () => diag('window focused'));
  win.on('blur', () => { diag('window blurred'); setKeyboard(false); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('closed', () => { win = null; });

  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);

  if (SHOT_DIR) require('./app/development-harness.cjs').runShotHarness({ win, SHOT_DIR, DEMO, diag, app });
}

function onDisplaysChanged() {
  reposition();
  completionReader.clear();
  publishEnvironment();
  tray?.setContextMenu(buildTrayMenu());
  tray?.setToolTip(`Island HUD ${app.getVersion()}`);
}

function reposition() {
  if (!win) return;
  const display = targetDisplay();
  const { x, y, width } = display.workArea;
  const layout = presentation.geometry(settings, { workArea: display.workArea });
  WIN_W = layout.windowWidth; WIN_H = layout.windowHeight;
  win.setBounds({
    x: Math.round(x + (width - WIN_W) / 2),
    y: Math.round(y),
    width: WIN_W,
    height: WIN_H,
  });
  publishEnvironment();
}

function syncInteractive() {
  const next = visible && requestedInteractive;
  if (!win || interactive === next) return;
  interactive = next;
  // forward:true keeps mousemove flowing so the renderer can tell when to reclaim input.
  win.setIgnoreMouseEvents(!next, { forward: true });
  diag('interactive=' + next);
}
function setInteractive(next) {
  requestedInteractive = !!next;
  syncInteractive();
}

function setKeyboard(enabled) {
  if (!win || win.isDestroyed()) return;
  const changed = keyboardEnabled !== enabled;
  keyboardEnabled = enabled;
  if (enabled) {
    setInteractive(true);
    win.show();
    win.moveTop();
    win.focus();
    win.webContents.focus();
    diag('keyboard=true');
  } else {
    if (changed || win.isFocused()) win.blur();
    if (changed) diag('keyboard=false');
  }
}

function setVisible(next, reason = 'user') {
  if (!win) return;
  if (reason === 'user') { manuallyHidden = !next; idleHidden = false; quietSince = Date.now(); }
  visible = next;
  if (next) {
    if (autoHidden) autoHidden = false;
    win.showInactive();
    syncInteractive();
  } else {
    setKeyboard(false);
    setInteractive(false);
    win.hide();
  }
  tray?.setContextMenu(buildTrayMenu());
  publishEnvironment();
}

/* ------------------------------------------------------ fullscreen auto-hide */
function handleFullscreenState(isFullscreen) {
  diag('fullscreen=' + (isFullscreen ? '1' : '0'));
  if (isFullscreen) {
    if (settings.autoHideFullscreen && visible && !autoHidden) {
      autoHidden = true;
      setVisible(false);
      diag('auto-hidden for fullscreen');
    }
  } else if (autoHidden) {
    autoHidden = false;
    if (!visible) setVisible(true);
    diag('restored after fullscreen');
  }
}

function startFullscreenWatcher() {
  if (fullscreenWatcher) return;
  const helper = toolPath('foreground-watcher.exe');
  if (!fs.existsSync(helper)) {
    diag('fullscreen watcher missing: ' + helper);
    return;
  }
  try {
    fullscreenWatcher = spawn(helper, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    diag('fullscreen watcher spawn failed: ' + e.message);
    fullscreenWatcher = null;
    return;
  }
  diag('fullscreen watcher started');
  let buf = '';
  fullscreenWatcher.stdout.on('data', (data) => {
    buf += data.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === '1' || line === '0') handleFullscreenState(line === '1');
    }
  });
  fullscreenWatcher.stderr.on('data', (d) => diag('fullscreen watcher: ' + d.toString().trim().slice(0, 200)));
  fullscreenWatcher.on('exit', (code) => {
    diag('fullscreen watcher exited ' + code);
    fullscreenWatcher = null;
    if (settings.autoHideFullscreen && !quitting) {
      setTimeout(() => { startFullscreenWatcher(); }, 2000);
    }
  });
}

function stopFullscreenWatcher() {
  if (!fullscreenWatcher) return;
  try { fullscreenWatcher.kill(); } catch { /* ignore */ }
  fullscreenWatcher = null;
}

function setAutoHideFullscreen(on) {
  settings.autoHideFullscreen = !!on;
  saveSettings();
  if (on) {
    startFullscreenWatcher();
  } else {
    stopFullscreenWatcher();
    if (autoHidden) {
      autoHidden = false;
      setVisible(true);
    }
  }
  tray?.setContextMenu(buildTrayMenu());
  diag('auto-hide-fullscreen=' + !!on);
}

function loginItemOptions(extra = {}) {
  return { path: process.execPath, name: 'Island HUD', ...extra };
}
function loginItemState() {
  try {
    const s = app.getLoginItemSettings(loginItemOptions());
    // Electron's `openAtLogin` is not reliable when a custom launch-item name is
    // used; the launchItems list carries the authoritative path/enabled state.
    if (Array.isArray(s.launchItems)) {
      const exe = process.execPath.toLowerCase();
      return s.launchItems.some((i) => i && i.enabled && i.path && i.path.toLowerCase() === exe);
    }
    return !!s.openAtLogin;
  } catch { return false; }
}
function setAutoStart(on) {
  if (TEST_ROOT || !app.isPackaged) return;
  try {
    app.setLoginItemSettings(loginItemOptions({ openAtLogin: !!on }));
    diag('auto-start=' + !!on);
  } catch (e) {
    diag('auto-start failed: ' + e.message);
  }
  tray?.setContextMenu(buildTrayMenu());
}

function displayMenuItems() {
  const current = targetDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    label: `显示器 ${i + 1} · ${d.size.width}×${d.size.height}${d.id === current.id ? '（当前）' : ''}`,
    type: 'radio',
    checked: d.id === current.id,
    click: () => {
      settings.displayId = d.id;
      saveSettings();
      reposition();
      tray?.setContextMenu(buildTrayMenu());
      diag('display selected id=' + d.id);
    },
  }));
}

function buildTrayMenu() {
  const autoItem = app.isPackaged
    ? { id: 'tray.auto-start', label: '开机自启', type: 'checkbox', checked: loginItemState(), click: (item) => setAutoStart(item.checked) }
    : { id: 'tray.auto-start', label: '开机自启（打包版可用）', enabled: false };
  return Menu.buildFromTemplate([
    { id: 'tray.visibility', label: visible ? '隐藏 Island HUD' : '显示 Island HUD', click: () => setVisible(!visible) },
    { id: 'tray.recenter', label: '重新居中', click: reposition },
    { id: 'tray.displays', label: '显示器', submenu: displayMenuItems() },
    { type: 'separator' },
    autoItem,
    {
      id: 'tray.fullscreen-hide',
      label: '全屏时自动隐藏',
      type: 'checkbox',
      checked: settings.autoHideFullscreen === true,
      click: (item) => setAutoHideFullscreen(item.checked),
    },
    {
      id: 'tray.check-updates',
      label: updateUrl() ? '检查更新…' : '检查更新（未配置更新源）',
      enabled: !!updateUrl(),
      click: () => checkForUpdates({ interactive: true }),
    },
    {
      id: 'tray.settings',
      label: '设置…',
      click: () => openSettingsWindow(),
    },
    {
      id: 'tray.logs',
      label: '打开日志目录',
      click: () => {
        try {
          fs.mkdirSync(logDir(), { recursive: true });
          shell.openPath(logDir());
        } catch (e) { diag('open logs failed: ' + e.message); }
      },
    },
    {
      id: 'tray.copy-diagnostics',
      label: '复制诊断信息',
      click: () => {
        try {
          clipboard.writeText(buildDiagnostics());
          diag('diagnostics copied');
        } catch (e) { diag('copy diagnostics failed: ' + e.message); }
      },
    },
    {
      id: 'tray.settings-file',
      label: '打开设置文件',
      click: () => {
        try {
          if (!fs.existsSync(settingsFile())) saveSettings();
          shell.openPath(settingsFile());
        } catch (e) { diag('open settings failed: ' + e.message); }
      },
    },
    { type: 'separator' },
    { id: 'tray.dsh-sessions', label: '打开 DSH 会话目录', click: () => shell.openPath(path.join(os.homedir(), '.dsh', 'sessions')) },
    {
      id: 'tray.program-directory',
      label: '打开程序目录',
      click: () => shell.openPath(app.isPackaged
        ? path.dirname(process.execPath)
        : path.resolve(__dirname, '..', '..')),
    },
    { type: 'separator' },
    { id: 'tray.version', label: `Island HUD ${app.getVersion()}${app.isPackaged ? '' : '（开发模式）'}`, enabled: false },
    { id: 'tray.quit', label: '退出', click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    tray.setToolTip(`Island HUD ${app.getVersion()}`);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => setVisible(!visible));
  } catch (e) {
    diag('tray failed: ' + e.message);
  }
}

/* ------------------------------------------------ Claude Code hook installer UI */
function toolPath(name) {
  let p = path.join(__dirname, 'tools', name);
  if (p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function pipeHelperPath() {
  return toolPath('pipe-host.exe');
}

const dshIntegration = createDshIntegration({ timedQuestions: settings.dshTimedQuestions === true });
const zcodeIntegration = createZcodeIntegration();

/* ----------------------------------------------------------------- diagnostics */
function buildDiagnostics() {
  const display = screen.getPrimaryDisplay();
  const sessions = visibleSessions();
  return JSON.stringify({
    app: 'Island HUD',
    version: app.getVersion(),
    packaged: app.isPackaged,
    time: new Date().toISOString(),
    archivedSessions: archiveStore.list().length,
    display: {
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
    },
    settings: {
      updateUrl: updateUrl(),
      autoCheckUpdates: settings.autoCheckUpdates !== false,
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      project: s.project,
      phase: s.phase,
      turn: s.turn,
      updatedAt: s.updatedAt,
    })),
  }, null, 2);
}

function settingsPayload() {
  return {
    ...settings,
    version: app.getVersion(),
    packaged: app.isPackaged,
    updateUrl: updateUrl(),
    autoCheckUpdates: settings.autoCheckUpdates !== false,
    autoHideFullscreen: settings.autoHideFullscreen === true,
    dshTimedQuestions: settings.dshTimedQuestions === true,
    dsh: dshIntegration.status(),
    zcode: zcodeIntegration.status(),
    displays: screen.getAllDisplays().length,
    autoStart: !TEST_ROOT && app.isPackaged ? loginItemState() : false,
  };
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: Math.min(760, screen.getPrimaryDisplay().workArea.width - 32),
    height: Math.min(680, screen.getPrimaryDisplay().workArea.height - 40),
    minWidth: 360,
    minHeight: 420,
    resizable: true,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Island HUD 设置',
    backgroundColor: '#151518',
    icon: loadAppIcon(),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

// The installed DSH public protocol only focuses its application. Until a
// precise session route is verified, report that limit without opening another session.
// ZCode exposes no per-session deep link either; surface the project directory.
ipcMain.handle('island:focus', async (_event, id) => {
  const session = visibleSessions().find(s => s.id === id);
  if (!session) return { status: 'expired', reason: '该会话已不在当前列表中' };
  if (session.provider === 'zcode') {
    const dir = typeof session.cwd === 'string' ? session.cwd : '';
    if (!dir) return { status: 'unsupported', sessionId: session.rawId, reason: '该会话未提供项目目录' };
    const opened = await shell.openPath(dir);
    return opened ? { status: 'unsupported', sessionId: session.rawId, reason: opened }
      : { status: 'navigated', sessionId: session.rawId };
  }
  if (!dshNavigation) return { status: 'unsupported', sessionId: session.rawId,
    reason: 'DSH 精确导航服务不可用，请在客户端手动打开' };
  const navigation = dshNavigation.request(session.rawId, 2500);
  try { await shell.openExternal('dsh://open'); } catch { /* The navigation plugin can still handle an already-visible client. */ }
  const result = await navigation;
  return result.status === 'navigated'
    ? { status: 'navigated', sessionId: session.rawId }
    : { status: result.status === 'expired' ? 'expired' : 'unsupported', sessionId: session.rawId,
      reason: result.status === 'expired' ? '目标会话已失效' : 'DSH 精确导航插件未连接，请在客户端手动打开' };
});
ipcMain.on('island:interactive', (_e, next) => setInteractive(!!next));
ipcMain.on('island:bounds', (event, b) => {
  if (!trustedOverlay(event) || !b || !['x','y','w','h','r'].every(key => Number.isFinite(b[key]))) return;
  const bounds = win.getContentBounds();
  if (b.w <= 0 || b.h <= 0 || b.w > bounds.width + 8 || b.h > bounds.height + 8 || b.x < -8 || b.y < -8) return;
  notchBounds = b;
  setInteractive(isPointInNotch(screen.getCursorScreenPoint(), win.getBounds(), b));
});
ipcMain.on('island:quit', () => app.quit());
ipcMain.on('island:hide', () => setVisible(false));
ipcMain.handle('island:snapshot', () => visibleSessions());
const trustedOverlay = event => win && !win.isDestroyed() && event.sender === win.webContents;
ipcMain.handle('island:native:snapshot', event => trustedOverlay(event) ? integrationHub?.snapshot() || [] : []);
ipcMain.handle('island:native:reply', async (event, data) => {
  if (!trustedOverlay(event) || !data || !integrationHub) return { status: 'expired' };
  diag(`native reply requested id=${data.id} decision=${data.decision}`);
  const result = await integrationHub.respond(data.id, data.decision, { answers: data.answers });
  diag(`native reply result id=${data.id} status=${result.status}`);
  return result;
});
ipcMain.handle('island:keyboard', (event, enabled) => {
  if (!trustedOverlay(event)) return { accepted: false };
  setKeyboard(!!enabled);
  return { accepted: true, focused: !!enabled && win?.isFocused() };
});
ipcMain.handle('island:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('island:settings:get', () => settingsPayload());
ipcMain.handle('island:environment:get', () => environmentPayload());
ipcMain.on('island:activity', (event, value) => {
  if (!trustedOverlay(event)) return;
  rendererProtected = !!value?.protected; rendererExpanded = !!value?.expanded;
});
ipcMain.handle('island:completion:get', async (event, value) => {
  if (!trustedOverlay(event) || typeof value?.id !== 'string' || !Number.isSafeInteger(value?.turn)) return { status: 'expired', text: '' };
  const view = visibleSessions().find(item => item.id === value.id && item.provider === 'dsh' && item.turn === value.turn && item.completedAt);
  const session = view && bridge?.sessions.get(view.rawId);
  if (!session?.file) return { status: 'expired', text: '' };
  return completionReader.read({ file: session.file, sessionKey: view.id, turn: value.turn });
});
ipcMain.handle('island:external', (_event, value) => {
  const url = presentation.safeLink(value); if (!url) return false;
  shell.openExternal(url); return true;
});
ipcMain.handle('island:settings:open', event => { if (trustedOverlay(event)) openSettingsWindow(); });
ipcMain.handle('island:dsh:status', () => dshIntegration.status());
ipcMain.handle('island:dsh:manage', (event, action) => {
  if (!settingsWin || settingsWin.isDestroyed() || event.sender !== settingsWin.webContents) throw new Error('DSH 集成管理只能从设置窗口操作');
  if (action === 'install' || action === 'repair') return dshIntegration.install();
  if (action === 'remove') return dshIntegration.remove();
  throw new Error('未知的 DSH 集成操作');
});
ipcMain.handle('island:zcode:status', () => zcodeIntegration.status());
ipcMain.handle('island:zcode:manage', (event, action) => {
  if (!settingsWin || settingsWin.isDestroyed() || event.sender !== settingsWin.webContents) throw new Error('ZCode 集成管理只能从设置窗口操作');
  if (action === 'install' || action === 'repair') return zcodeIntegration.install();
  if (action === 'remove') return zcodeIntegration.remove();
  throw new Error('未知的 ZCode 集成操作');
});
ipcMain.handle('island:settings:set', (event, patch = {}) => {
  if (!settingsWin || settingsWin.isDestroyed() || event.sender !== settingsWin.webContents) throw new Error('设置只能从设置窗口保存');
  if (typeof patch.autoStart === 'boolean') setAutoStart(patch.autoStart);
  Object.assign(settings, presentation.normalize({ ...settings, ...patch }));
  if (typeof patch.updateUrl === 'string') settings.updateUrl = patch.updateUrl.trim();
  if (typeof patch.autoCheckUpdates === 'boolean') settings.autoCheckUpdates = patch.autoCheckUpdates;
  if (typeof patch.autoHideFullscreen === 'boolean'
    && patch.autoHideFullscreen !== (settings.autoHideFullscreen === true)) {
    setAutoHideFullscreen(patch.autoHideFullscreen);
  }
  if (typeof patch.dshTimedQuestions === 'boolean') {
    settings.dshTimedQuestions = patch.dshTimedQuestions;
    dshIntegration.setTimedQuestions(patch.dshTimedQuestions);
  }
  saveSettings();
  if (idleHidden && !settings.autoHideWhenIdle && !manuallyHidden) { idleHidden = false; setVisible(true, 'idle'); }
  reposition(); publishSettings();
  tray?.setContextMenu(buildTrayMenu());
  return settingsPayload();
});
ipcMain.handle('island:diagnostics', () => buildDiagnostics());
// Local visibility management: the overlay may hide one session (archive or
// delete), and only the settings window may list, restore or clear those lists.
const archiveCaller = event => trustedOverlay(event) ||
  (settingsWin && !settingsWin.isDestroyed() && event.sender === settingsWin.webContents);
const hideKind = mode => mode === 'delete' ? 'deleted' : 'archived';
ipcMain.handle('island:session:hide', (event, id, mode) => {
  if (!trustedOverlay(event)) return { ok: false, reason: 'denied' };
  if (mode !== 'archive' && mode !== 'delete') return { ok: false, reason: 'invalid' };
  const session = sessionStore.snapshot().find(item => item.id === id);
  if (!session) return { ok: false, reason: 'unknown' };
  if (!canHide(session)) return { ok: false, reason: (session.pendingRequests || []).length ? 'pending' : 'active' };
  const result = archiveStore.add({ provider: session.provider, rawId: session.rawId, title: session.title, project: session.project, kind: hideKind(mode) });
  if (!result.ok) return { ok: false, reason: 'storage' };
  diag(`session ${mode} ${session.provider}/${session.rawId}`);
  notifySessionsChanged(); publishSessionsNow?.();
  return { ok: true, session: { id: session.id, title: session.title } };
});
ipcMain.handle('island:session:list', (event, mode) => {
  if (!archiveCaller(event)) return { count: 0, entries: [], truncated: false, archived: 0, deleted: 0 };
  const kind = hideKind(mode);
  const entries = archiveStore.list(kind);
  const total = archiveStore.count(kind);
  return { count: total, entries, truncated: total > entries.length,
    archived: archiveStore.count('archived'), deleted: archiveStore.count('deleted') };
});
ipcMain.handle('island:session:restore', (event, key) => {
  if (!archiveCaller(event)) return { ok: false, reason: 'denied' };
  const result = archiveStore.remove(String(key));
  if (result.ok) { diag('session restored ' + key); notifySessionsChanged(); publishSessionsNow?.(); return { ok: true }; }
  return result;
});
ipcMain.handle('island:session:restore-all', (event, mode) => {
  if (!archiveCaller(event)) return { ok: false, reason: 'denied' };
  const result = archiveStore.clear(hideKind(mode));
  if (result.ok) { diag(`sessions restored ${mode} ${result.removed}`); notifySessionsChanged(); publishSessionsNow?.(); }
  return result;
});
ipcMain.handle('island:clipboard:write', (_e, text) => {
  try { clipboard.writeText(String(text)); return true; } catch { return false; }
});
ipcMain.handle('island:logs:open', () => {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    shell.openPath(logDir());
    return true;
  } catch { return false; }
});

/**
 * Hit-testing: poll the global cursor against the notch rounded rectangle
 * reported by the renderer. Electron's `ignoreMouseEvents(true, {forward:true})`
 * forwards moves on paper, but this is not reliable on every Windows/Electron
 * build; polling is deterministic and cheap (60ms) for a small overlay.
 * The notch is docked to the top edge, so only the bottom corners are rounded.
 */
function isPointInNotch(p, wb, b) {
  const pad = 1;
  const x0 = wb.x + b.x;
  const y0 = wb.y + b.y;
  if (p.x < x0 - pad || p.x > x0 + b.w + pad || p.y < y0 - pad || p.y > y0 + b.h + pad) return false;
  const r = Math.max(0, Math.min(b.h, Number(b.r) || 0));
  if (r > 0 && p.y > y0 + b.h - r) {
    const cy = y0 + b.h - r;
    if (p.x < x0 + r) {
      const dx = p.x - (x0 + r);
      const dy = p.y - cy;
      if (dx * dx + dy * dy > r * r) return false;
    } else if (p.x > x0 + b.w - r) {
      const dx = p.x - (x0 + b.w - r);
      const dy = p.y - cy;
      if (dx * dx + dy * dy > r * r) return false;
    }
  }
  return true;
}

function startHitTestPolling() {
  hitTestTimer = setInterval(() => {
    if (!win || !visible || !win.isVisible() || !notchBounds) {
      if (lastPointerInside) { lastPointerInside = false; win?.webContents.send('island:pointer', false); }
      return;
    }
    const pt = screen.getCursorScreenPoint();
    const wb = win.getBounds();
    const inside = isPointInNotch(pt, wb, notchBounds);
    setInteractive(inside);
    if (inside !== lastPointerInside) { lastPointerInside = inside; win.webContents.send('island:pointer', inside); }
  }, 30);
}

/* ---------------------------------------------------------------- screenshot harness */
/* ---------------------------------------------------------------- lifecycle */
app.whenReady().then(() => {
  if (!SINGLE_INSTANCE) return;
  diag('single-instance lock acquired');
  createWindow();
  createTray();
  nativeTheme.on('updated', publishEnvironment);
  startHitTestPolling();
  if (settings.autoHideFullscreen || process.env.ISLAND_FORCE_FULLSCREEN_WATCHER === '1') {
    startFullscreenWatcher();
  }

  const sessionsRoot = process.env.ISLAND_HUD_DSH_SESSIONS || (TEST_ROOT ? path.join(TEST_ROOT, 'dsh/sessions') : '');
  if (sessionsRoot && !path.isAbsolute(sessionsRoot)) throw new Error('Absolute DSH sessions path required');
  bridge = new DshBridge(sessionsRoot ? { sessionsRoot } : {});
  diag('zstd decoder=' + zstdDecoderName);
  bridge.on('update', (sessions) => {
    sessionStore.replaceProviderSnapshot('dsh', sessions);
    const summary = sessions.map((s) => `${s.project}:${s.phase}`).join(', ');
    diag('bridge ' + sessions.length + ' sessions [' + summary + ']');
    if (win && !win.isDestroyed()) win.webContents.send('island:sessions', visibleSessions());
  });
  bridge.start();

  if (!TEST_ROOT) {
    dshNavigation = new DshNavigationServer({ descriptorPath: navigationDescriptorPath(), log: diag });
    dshNavigation.start().catch(error => {
      dshNavigation = null;
      diag('dsh navigation unavailable: ' + error.message);
    });
  }

  // Both entrypoints use the same notch renderer and original invocation channels.
  const nativeLog = message => {
    diag(message);
    if (BRIDGE_EVIDENCE_LOG) fs.appendFileSync(BRIDGE_EVIDENCE_LOG, JSON.stringify({ at: new Date().toISOString(), message }) + '\n');
  };
  let publishedSessions = '';
  const publishSessions = () => {
    const snapshot = visibleSessions(), serialized = JSON.stringify(snapshot);
    completionReader.retain(new Set(snapshot.map(item => item.id)));
    const active = integrationHub?.pending.size || snapshot.some(item => ['running','waitingForApproval','waitingForAnswer'].includes(item.phase));
    if (active || rendererProtected || rendererExpanded) quietSince = Date.now();
    if (idleHidden && active && !manuallyHidden) { idleHidden = false; setVisible(true, 'idle'); }
    if (!idleHidden && !manuallyHidden && settings.autoHideWhenIdle && !active && !rendererExpanded && !rendererProtected && Date.now() - quietSince >= 30000) { idleHidden = true; setVisible(false, 'idle'); }
    if (serialized === publishedSessions) return;
    publishedSessions = serialized;
    if (win && !win.isDestroyed()) win.webContents.send('island:sessions', snapshot);
  };
  publishSessionsNow = publishSessions;
  integrationHub = new IntegrationHub({
    allowedProviders: ['dsh', 'zcode'],
    descriptorPath: TEST_ROOT ? path.join(TEST_ROOT, 'integration-v2.json') : nativeDescriptorPath(),
    helperPath: pipeHelperPath(), log: nativeLog,
    onChange: requests => {
      for (const request of requests) { dshIntegration.observe(request); zcodeIntegration.observe(request); }
      sessionStore.setRequests(requests);
      if (win && !win.isDestroyed()) win.webContents.send('island:native:requests', requests);
      publishSessions();
    },
    onEvent: request => {
      dshIntegration.observe(request);
      zcodeIntegration.observe(request);
      sessionStore.applyEvent(request);
      const { event, requestId, outcome } = request.payload;
      if (requestId && ['ApprovalDecided', 'QuestionAnswered'].includes(event) && win && !win.isDestroyed()) {
        win.webContents.send('island:native:confirmation', { id: JSON.stringify([request.provider, requestId]), outcome });
      }
      nativeLog(`host event provider=${request.provider} session=${request.sessionId} event=${request.payload.event}` +
        (request.payload.requestId ? ` request=${request.payload.requestId}` : '') +
        (request.payload.outcome ? ` outcome=${request.payload.outcome}` : ''));
      publishSessions();
    },
  });
  integrationHub.start();
  sessionPublishTimer = setInterval(publishSessions, 400);

  const toggleOverview = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript('window.__islandApp && window.__islandApp.toggleOverview()')
        .catch((e) => diag('hotkey toggle failed: ' + e.message));
    }
  };
  if (!(TEST_ROOT && process.env.ISLAND_TEST_NO_SHORTCUTS === '1')) {
    globalShortcut.register('Control+Alt+I', () => setVisible(!visible));
    const okO = globalShortcut.register('Control+Alt+O', toggleOverview);
    diag('hotkey Control+Alt+O registered=' + okO);
  } else diag('isolated monitor: global shortcuts disabled');

  // One-time first-run hint (tray balloon).
  if (!settings.hintShown) {
    settings.hintShown = true;
    saveSettings();
    setTimeout(() => {
      try {
        tray?.displayBalloon({
          title: 'Island HUD 已启动',
          content: 'Ctrl+Alt+I 显隐 · Ctrl+Alt+O 展开/收起 · 右键托盘打开设置',
        });
        diag('first-run hint shown');
      } catch (e) { diag('first-run hint failed: ' + e.message); }
    }, 1500);
  }

  if (TEST_ROOT) require('./app/development-harness.cjs').runDevelopmentChecks({
    app, win, diag, openSettingsWindow, desktopCapturer, settings, settingsPayload, setAutoHideFullscreen,
    buildDiagnostics, clipboard, checkForUpdates, setAutoStart, loginItemOptions,
    tray, buildTrayMenu, targetDisplay, visibleState: () => visible,
  });
  if (!TEST_ROOT && updateUrl() && settings.autoCheckUpdates !== false && Date.now() - (Number(settings.lastUpdateCheck) || 0) > 24 * 3600 * 1000) {
    setTimeout(() => { checkForUpdates({ interactive: false }); }, 12000);
  }

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  quitting = true;
  stopFullscreenWatcher();
  globalShortcut.unregisterAll();
  bridge?.stop();
  integrationHub?.stop();
  dshNavigation?.stop();
  clearInterval(sessionPublishTimer);
  clearInterval(hitTestTimer);
  nativeTheme.removeListener('updated', publishEnvironment);
  completionReader.clear();
});
