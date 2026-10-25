'use strict';
// Runs the real claude / codex CLIs against sandboxed configuration dirs with
// Island HUD hooks, and answers the island approvals itself via DOM clicks.
// claude: sandboxed CLAUDE_CONFIG_DIR with hooks pointing at the repo script.
// codex:  sandboxed CODEX_HOME holding a minimal config.toml (provider and
//         model entries only, auth included but never logged) plus hooks.json.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const root = process.env.ISLAND_HUD_TEST_ROOT;
const descriptor = path.join(root, 'integration-v2.json');
const resultFile = path.join(root, 'cli-e2e-result.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const claudeHookScript = path.join(__dirname, '../integrations/claude/scripts/island-hook.cjs').split(path.sep).join('/');
const codexHookScript = path.join(__dirname, '../integrations/codex/scripts/island-hook.cjs').split(path.sep).join('/');
let win;

async function until(check, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error('E2E condition timed out');
}

// The npm shims (.cmd) would force a shell join that mangles non-ASCII
// prompts; spawn the real entry points directly instead.
function resolveCli(kind) {
  const npmDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'npm');
  if (kind === 'claude') {
    return process.env.ISLAND_HUD_E2E_CLAUDE_BIN ||
      path.join(npmDir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  }
  return process.env.ISLAND_HUD_E2E_CODEX_BIN ||
    path.join(npmDir, 'node_modules/@openai/codex/bin/codex.js');
}
function runCli(kind, args, options, onLine, onSpawn) {
  // Inside Electron, process.execPath is electron.exe; the codex JS entry
  // needs plain node, and claude ships a native exe. No shell involved.
  const command = kind === 'codex' ? 'node' : resolveCli('claude');
  const argv = kind === 'codex' ? [resolveCli('codex'), ...args] : args;
  return new Promise(resolve => {
    const child = spawn(command, argv, { ...options, shell: false });
    // Both CLIs read stdin when it is a pipe and would wait for EOF forever;
    // every prompt travels as argv here.
    child.stdin.end();
    onSpawn?.(child);
    let out = '', err = '';
    const pump = stream => stream.setEncoding('utf8').on('data', chunk => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim());
    });
    pump(child.stdout); pump(child.stderr);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out, err }));
    child.on('error', error => resolve({ code: -1, out, err: String(error) }));
  });
}

const snapshot = () => win.webContents.executeJavaScript('window.island.native.snapshot()');

/** Answers every pending island approval card via DOM clicks until settled. */
async function autoApprove(timeoutMs = 180000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > end) throw new Error('no approval card to answer within the budget');
    const has = await win.webContents.executeJavaScript('!!document.querySelector("[data-native-action=allow]")').catch(() => false);
    if (has) {
      await win.webContents.executeJavaScript('document.querySelector("[data-native-action=allow]").click()');
      await pause(800);
      const pending = (await snapshot().catch(() => [])).some(r => r.kind === 'approval' && r.state === 'pending');
      if (!pending) return;
    }
    await pause(500);
  }
}

async function claudeScenario(sandbox) {
  const configDir = path.join(sandbox, 'claude-config');
  const workDir = path.join(sandbox, 'claude-work dir');
  fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(workDir, { recursive: true });
  // The user's real settings.json carries their provider env; copy the env
  // block into the sandbox without ever logging it. ISLAND_HUD_BRIDGE_FILE
  // redirects the hook to this run's isolated pipe descriptor.
  const realConfigPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  const real = JSON.parse(fs.readFileSync(realConfigPath, 'utf8').replace(/^\uFEFF/, ''));
  const entry = { type: 'command', command: 'node', args: [claudeHookScript], timeout: 600 };
  const sandboxSettings = { env: { ...(real.env || {}), ISLAND_HUD_BRIDGE_FILE: descriptor }, hooks: {
    SessionStart: [{ hooks: [entry] }], PreToolUse: [{ hooks: [entry] }],
    PermissionRequest: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }],
  } };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(sandboxSettings, null, 2));
  const approver = autoApprove();
  const result = await runCli('claude',
    // The Bash tool is what surfaces a PermissionRequest; plain file writes
    // are auto-approved in -p mode and would bypass the island entirely.
    ['-p', '你必须使用 Bash 工具（不要用 Write 或其他工具）运行命令：echo island-e2e-ok > island-e2e.txt 然后读取 island-e2e.txt 告诉我内容'],
    { cwd: workDir, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
  await approver;
  // The file being created proves claude executed the command; require the
  // hub's own evidence log to confirm the approval actually flowed through
  // the island (request + decision), not around it.
  const evidence = path.join(root, 'bridge-evidence.jsonl');
  await until(() => {
    try {
      const log = fs.readFileSync(evidence, 'utf8');
      return log.includes('provider=claude') && log.includes('event=ApprovalDecided') && log.includes('status=delivered');
    } catch { return false; }
  }, 15000);
  return { exit: result.code, file: path.join(workDir, 'island-e2e.txt'), output: (result.out || '').slice(-400) };
}

function codexSandboxHome(sandbox) {
  const home = path.join(sandbox, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  // Minimal config: model + provider sections only (auth stays inside, never
  // logged). The full user config references plugins and MCP servers that
  // break outside the real home.
  const real = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8').split('\n');
  const lines = [];
  let inProviders = false;
  for (const line of real) {
    if (/^\[model_providers/.test(line)) { inProviders = true; lines.push(line); continue; }
    if (inProviders && /^\[/.test(line)) inProviders = false;
    if (inProviders) { lines.push(line); continue; }
    if (/^(model|model_provider)\s*=/.test(line)) lines.push(line);
  }
  fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n') + '\n');
  const entry = { type: 'command', command: 'node "' + codexHookScript + '"', commandWindows: 'node "' + codexHookScript + '"', timeout: 600 };
  const hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']) {
    hooks[event] = [{ hooks: [entry] }];
  }
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  return home;
}

async function codexScenario(sandbox) {
  const workDir = path.join(sandbox, 'codex-work dir');
  fs.mkdirSync(workDir, { recursive: true });
  const codeHome = codexSandboxHome(sandbox);
  const lines = [];
  console.error('[e2e] codex scenario starting');
  let child = null;
  const started = Date.now();
  // codex exec completes the turn but its process can linger on Windows
  // because hook children inherit the stdio pipes. "tokens used" is the
  // real end-of-turn banner (the prompt echo must never count as done —
  // it contains the prompt text itself), then the runner reaps the process.
  const output = await new Promise(resolve => {
    const check = setInterval(() => {
      const done = lines.some(l => /tokens used/.test(l));
      if (done || Date.now() - started > 180000) {
        clearInterval(check);
        resolve({ text: lines.join('\n'), ok: done, elapsed: Date.now() - started });
        try { child?.kill(); } catch { /* already gone */ }
      }
    }, 500);
    runCli('codex',
      ['exec', '--skip-git-repo-check', '-s', 'read-only', '--dangerously-bypass-hook-trust', '只回复两个字：成功'],
      { cwd: workDir, env: { ...process.env, CODEX_HOME: codeHome, ISLAND_HUD_BRIDGE_FILE: descriptor } },
      line => lines.push(line), c => { child = c; }).catch(() => {});
  });
  console.error('[e2e] codex scenario finished ok=' + output.ok + ' elapsed=' + Math.round(output.elapsed / 1000) + 's');
  assert.ok(output.ok, 'codex turn never completed: ' + output.text.slice(-400));
  // The turn completing is not enough: its lifecycle hooks must have reached
  // the island through the real pipe. The hub writes every host event to the
  // bridge evidence log; require at least one codex event there.
  const evidence = path.join(root, 'bridge-evidence.jsonl');
  await until(() => {
    try {
      return fs.readFileSync(evidence, 'utf8').includes('provider=codex ');
    } catch { return false; }
  }, 15000);
  return { exit: 0, output: output.text.slice(-400) };
}

app.on('browser-window-created', (_event, created) => { win = created; });
require('../src/probe/main.cjs');

app.whenReady().then(async () => {
  const checks = [], skipped = [];
  const writeReport = extra => fs.writeFileSync(resultFile, JSON.stringify({ checks, skipped, ...extra }, null, 2));
  process.on('uncaughtException', error => { writeReport({ status: 'failed', error: error.stack }); app.exit(1); });
  try {
    await until(() => win && !win.webContents.isLoading() && fs.existsSync(descriptor));
    await until(() => win.webContents.executeJavaScript('!!window.__islandApp'));
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-e2e-'));
    const transcript = { claude: '', codex: '' };
    try {
      if (process.env.ISLAND_HUD_E2E_CLAUDE === '1') {
        console.error('[e2e] claude scenario starting');
        const claude = await claudeScenario(sandbox);
        console.error('[e2e] claude scenario finished code=' + claude.exit);
        transcript.claude = claude.output;
        assert.equal(claude.exit, 0, 'claude exited non-zero: ' + claude.output);
        assert.ok(fs.existsSync(claude.file), 'claude did not create the file; approval never landed: ' + claude.output);
        assert.ok(claude.output.includes('island-e2e-ok'), 'claude output lacks the file content');
        checks.push('real claude -p session: PermissionRequest answered on the island, command executed, output verified');
      } else skipped.push('claude 未安装或未启用，跳过');
      if (process.env.ISLAND_HUD_E2E_CODEX === '1') {
        const codex = await codexScenario(sandbox);
        transcript.codex = codex.output;
        assert.equal(codex.exit, 0, 'codex exited non-zero: ' + codex.output);
        assert.ok(/成功/.test(codex.output), 'codex output lacks the expected reply: ' + codex.output);
        checks.push('real codex exec session: lifecycle hooks reached the island and the turn completed');
      } else skipped.push('codex 未安装或未启用，跳过');
    } finally {
      // The CLI children can hold the sandbox cwd for a moment after exit.
      try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); }
      catch (error) { console.error('[e2e] sandbox cleanup skipped: ' + error.message); }
    }
    writeReport({ status: 'passed', transcript, electron: process.versions.electron,
      note: 'Real CLIs against sandboxed configs; approvals decided by this runner, not by a human.' });
  } catch (error) {
    writeReport({ status: 'failed', error: error.stack,
      snapshot: await snapshot().catch(() => null) });
    process.exitCode = 1;
  } finally {
    await pause(150);
    app.quit();
  }
});
