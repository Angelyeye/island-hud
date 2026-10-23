'use strict';
/**
 * Island HUD updater.
 *
 * Manifest format (served over HTTPS in production):
 *   {
 *     "version": "0.9.0",
 *     "url": "https://example.com/IslandHUD-Setup-0.9.0.exe",
 *     "sha256": "<hex sha256 of the installer>",
 *     "notes": "optional"
 *   }
 *
 * The updater intentionally requires a SHA-256 match before running anything.
 * Installers are unsigned personal builds, so checksum verification is the only
 * integrity check available.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => Number(n) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for manifest`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchManifest(manifestUrl, currentVersion) {
  const m = await fetchJson(manifestUrl);
  if (!m || typeof m !== 'object') throw new Error('invalid manifest');
  if (!m.version) throw new Error('manifest missing version');
  if (!m.url) throw new Error('manifest missing url');
  const latestVersion = normalizeVersion(m.version);
  return {
    latestVersion,
    currentVersion: normalizeVersion(currentVersion),
    newer: compareVersions(latestVersion, currentVersion) > 0,
    url: String(m.url),
    sha256: m.sha256 ? String(m.sha256).trim().toLowerCase() : '',
    notes: m.notes ? String(m.notes) : '',
  };
}

async function downloadInstaller(info, { dir, log = () => {} } = {}) {
  if (!info.sha256 || !/^[0-9a-f]{64}$/.test(info.sha256)) {
    throw new Error('manifest sha256 missing/invalid (refusing unsigned unverified download)');
  }
  const targetDir = dir || path.join(os.tmpdir(), 'island-hud-update');
  fs.mkdirSync(targetDir, { recursive: true });
  const fileName = 'IslandHUD-Setup-' + info.latestVersion + '.exe';
  const file = path.join(targetDir, fileName);
  log(`update-download start ${info.url} -> ${file}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(info.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for installer`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash !== info.sha256) {
      throw new Error(`sha256 mismatch (expected ${info.sha256}, got ${hash})`);
    }
    fs.writeFileSync(file, buf);
    log(`update-download ok ${file} bytes=${buf.length} sha256=${hash}`);
    return { file, bytes: buf.length, sha256: hash };
  } finally {
    clearTimeout(timer);
  }
}

function launchInstaller(file, { log = () => {}, args = ['/S'] } = {}) {
  log(`update-install launch ${file} ${args.join(' ')}`);
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

module.exports = {
  normalizeVersion,
  compareVersions,
  fetchManifest,
  downloadInstaller,
  launchInstaller,
};
