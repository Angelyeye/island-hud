'use strict';
// Providers runner: exercises the Claude Code (and ZCode) hook scripts through
// the real IntegrationHub of the real application, deciding every card with a
// real Windows mouse click. This is the machine-level regression for the
// provider plumbing that Node-level adapter tests cannot cover.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync, execFile } = require('node:child_process');

const root = process.env.ISLAND_HUD_TEST_ROOT;
const descriptor = path.join(root, 'integration-v2.json');
const resultFile = path.join(root, 'providers-result.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error('GUI condition timed out');
}

async function clickAt(x, y) {
  const physical = require('electron').screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  x = physical.x; y = physical.y;
  await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandHUDMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[IslandHUDMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 120
[IslandHUDMouse]::SetCursorPos(${Math.round(x - 18)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 80
[IslandHUDMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 120
[IslandHUDMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[IslandHUDMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve()));
}

function cursorPosition() {
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  const [x, y] = value.split(',').map(Number);
  return { x, y };
}

/** Runs one real hook script (ELECTRON_RUN_AS_NODE) with the payload on stdin. */
function runHookScript(script, payload) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ISLAND_HUD_BRIDGE_FILE: descriptor },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const buttonRect = selector => win.webContents.executeJavaScript(`(() => {
  const el = document.querySelector('${selector}');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
})()`);

async function clickNativeAction(action) {
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector("[data-native-action=${action}]")`));
  await pause(600);
  const button = await buttonRect(`[data-native-action=${action}]`);
  if (!button) throw new Error('missing action button: ' + action);
  const bounds = win.getBounds();
  await clickAt(bounds.x + button.x + button.width / 2, bounds.y + button.y + button.height / 2);
}

async function clickFirstOption() {
  await until(() => win.webContents.executeJavaScript('!!document.querySelector("fieldset label")'));
  await pause(400);
  const label = await buttonRect('fieldset label');
  const bounds = win.getBounds();
  await clickAt(bounds.x + label.x + label.width / 2, bounds.y + label.y + label.height / 2);
}

const snapshot = () => win.webContents.executeJavaScript('window.island.native.snapshot()');
const pendingOf = (requests, provider, kind) => requests.find(r => r.provider === provider && r.kind === kind && r.state === 'pending');

app.on('browser-window-created', (_event, created) => { win = created; });
require('../src/probe/main.cjs');

app.whenReady().then(async () => {
  const previousCursor = cursorPosition();
  const claudeHook = path.join(__dirname, '../integrations/claude/scripts/island-hook.cjs');
  const zcodeHook = path.join(__dirname, '../integrations/zcode/scripts/island-hook.mjs');
  const checks = [];
  try {
    await until(() => win && !win.webContents.isLoading() && fs.existsSync(descriptor));
    await until(() => win.webContents.executeJavaScript('!!window.__islandApp'));

    // 1. Claude approval decided by a real click on allow.
    const claudeAllow = runHookScript(claudeHook, {
      hook_event_name: 'PermissionRequest', session_id: 'providers-claude-1', cwd: 'C:\\work\\providers-demo',
      permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm test' },
    });
    await until(async () => !!pendingOf(await snapshot(), 'claude', 'approval'));
    await until(() => win.webContents.executeJavaScript('[...document.querySelectorAll(".source-chip")].some(el => el.textContent === "Claude")'));
    await clickNativeAction('allow');
    const allowOut = await Promise.race([claudeAllow, pause(4000).then(() => ({ out: '', err: 'timeout' }))]);
    assert.equal(allowOut.code, 0);
    assert.equal(JSON.parse(allowOut.out).hookSpecificOutput.decision.behavior, 'allow');
    await until(async () => (await snapshot()).length === 0);
    checks.push('claude approval allow decided by a real Windows click returns behavior=allow to the hook');

    // 2. Claude deny with the island message.
    const claudeDeny = runHookScript(claudeHook, {
      hook_event_name: 'PermissionRequest', session_id: 'providers-claude-1', cwd: 'C:\\work\\providers-demo',
      permission_mode: 'default', tool_name: 'Write', tool_input: { file_path: 'C:\\x\\main.ts', content: 'export {}' },
    });
    await until(async () => !!pendingOf(await snapshot(), 'claude', 'approval'));
    await clickNativeAction('deny');
    const denyOut = await Promise.race([claudeDeny, pause(4000).then(() => ({ out: '', err: 'timeout' }))]);
    const denyDecision = JSON.parse(denyOut.out).hookSpecificOutput.decision;
    assert.equal(denyDecision.behavior, 'deny');
    assert.ok(denyDecision.message.includes('Island HUD'));
    await until(async () => (await snapshot()).length === 0);
    checks.push('claude approval deny decided by a real Windows click returns the island deny message');

    // 3. Claude AskUserQuestion (PreToolUse path): real click on an option, then next/submit.
    const claudeQuestion = runHookScript(claudeHook, {
      hook_event_name: 'PreToolUse', session_id: 'providers-claude-1', cwd: 'C:\\work\\providers-demo',
      permission_mode: 'default', tool_name: 'AskUserQuestion', tool_use_id: 'call-q1',
      tool_input: { questions: [{ question: '选择发布环境', header: '环境', options: [{ label: '生产环境', description: '' }, { label: '预发布', description: '' }] }] },
    });
    await until(async () => !!pendingOf(await snapshot(), 'claude', 'question'));
    await clickFirstOption();
    await clickNativeAction('next');
    await clickNativeAction('submit');
    const questionOut = await Promise.race([claudeQuestion, pause(4000).then(() => ({ out: '', err: 'timeout' }))]);
    const answers = JSON.parse(questionOut.out).hookSpecificOutput.updatedInput.answers;
    assert.equal(answers['选择发布环境'], '生产环境');
    assert.equal(answers['环境'], '生产环境');
    await until(async () => (await snapshot()).length === 0);
    checks.push('claude AskUserQuestion answered by real clicks maps the option onto question and header keys');

    // 4. ZCode approval decided on the shared island (provider isolation after the refactor).
    const zcodeDeny = runHookScript(zcodeHook, {
      hook_event_name: 'PermissionRequest', session_id: 'providers-zcode-1', cwd: 'C:\\work\\providers-demo',
      tool_name: 'Bash', tool_input: { command: 'git push --force' },
    });
    await until(async () => !!pendingOf(await snapshot(), 'zcode', 'approval'));
    await until(() => win.webContents.executeJavaScript('[...document.querySelectorAll(".source-chip")].some(el => el.textContent === "ZCode")'));
    await clickNativeAction('deny');
    const zcodeOut = await Promise.race([zcodeDeny, pause(4000).then(() => ({ out: '', err: 'timeout' }))]);
    assert.equal(JSON.parse(zcodeOut.out).hookSpecificOutput.decision.behavior, 'deny');
    await until(async () => (await snapshot()).length === 0);
    checks.push('zcode approval deny still routes to its own hook after the provider refactor');

    fs.writeFileSync(resultFile, JSON.stringify({ status: 'passed', checks,
      electron: process.versions.electron,
      note: 'Real hook scripts + real hub + real Windows clicks; not native Claude Code/Codex verification.',
    }, null, 2));
  } catch (error) {
    const dom = await win?.webContents?.executeJavaScript('({ chips: [...document.querySelectorAll(".source-chip")].map(e => e.textContent), native: !!document.querySelector("[data-native-action]"), scene: window.__islandApp?.getState?.().scene })').catch(e => ({ err: e.message }));
    fs.writeFileSync(resultFile, JSON.stringify({ status: 'failed', error: error.stack, dom,
      snapshot: await snapshot().catch(() => null) }, null, 2));
    process.exitCode = 1;
  } finally {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandHUDCursor {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
'@
[IslandHUDCursor]::SetCursorPos(${Math.round(previousCursor.x)}, ${Math.round(previousCursor.y)}) | Out-Null
`], { windowsHide: true, timeout: 5000 });
    } catch { /* cursor restoration is best effort */ }
    await pause(150);
    app.quit();
  }
});
