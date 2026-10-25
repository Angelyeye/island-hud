'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The ZCode desktop client exposes no per-session route, but it holds a
// single-instance lock: a second launch whose argv carries a project directory
// hands that workspace to the running window and focuses it (or starts the
// client on that workspace when none is running). The override is honoured
// only in isolated test runs so production focus cannot be redirected by env.
const overridePath = env => env.ISLAND_HUD_TEST_ROOT && typeof env.ISLAND_ZCODE_CLIENT === 'string'
  ? env.ISLAND_ZCODE_CLIENT.trim() : '';
const windowsCandidates = env => [
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'ZCode', 'ZCode.exe'),
  env.ProgramFiles && path.join(env.ProgramFiles, 'ZCode', 'ZCode.exe'),
  env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'ZCode', 'ZCode.exe'),
].filter(Boolean);

function clientPath({ platform = process.platform, env = process.env, exists = file => fs.existsSync(file) } = {}) {
  const override = overridePath(env);
  if (override) return exists(override) ? override : null;
  if (platform === 'win32') return windowsCandidates(env).find(exists) || null;
  // macOS builds register the workspace deep link themselves (zcode://workspace).
  if (platform === 'darwin') return '/usr/bin/open';
  return null;
}

/** Fire-and-forget launch: a slow or missing client must never block focus, and
 * async spawn errors are swallowed because the caller has nothing to show. */
function openWorkspace(exe, dir, { platform = process.platform, spawnFn = spawn } = {}) {
  try {
    const args = platform === 'darwin' ? ['zcode://workspace/open?path=' + encodeURIComponent(dir)] : [dir];
    const child = spawnFn(exe, args, { detached: true, stdio: 'ignore', windowsHide: platform === 'win32' });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

module.exports = { clientPath, openWorkspace };
